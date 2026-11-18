// SPDX-License-Identifier: Apache-2.0
package main

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/sagernet/wireguard-go/device"
)

// Synthetic AWG2 parameters, unrelated to any user's private configuration.
const localAWG = "jc=2\njmin=32\njmax=64\ns1=80\ns2=20\ns3=35\ns4=12\nh1=1000-1100\nh2=2000-2100\nh3=3000-3100\nh4=4000-4100\ni1=<r 24>\n"

var (
	localClientIP = netip.MustParseAddr("10.77.0.2")
	localServerIP = netip.MustParseAddr("10.77.0.1")
	dnsWireMarker = []byte{7, 'e', 'x', 'a', 'm', 'p', 'l', 'e', 3, 'c', 'o', 'm', 0}
)

type selfTestReport struct {
	Mode                  string `json:"mode"`
	Revision              string `json:"wireguard_revision"`
	LoopbackUDP           bool   `json:"loopback_udp_verified"`
	InitialHandshake      bool   `json:"initial_authenticated_handshake"`
	InitialDNS            bool   `json:"initial_encrypted_dns_echo"`
	DownUpDNS             bool   `json:"down_up_restores_dns"`
	PeerRemoved           bool   `json:"peer_removed_from_device"`
	RemovedPeerBlocked    bool   `json:"removed_peer_blocks_dns"`
	PeerRestoredDNS       bool   `json:"peer_readd_restores_dns"`
	RecreatedDNS          bool   `json:"close_recreate_same_ports_restores_dns"`
	AWGHandshakeOnWire    bool   `json:"awg_handshake_header_padding_observed"`
	AWGTransportOnWire    bool   `json:"awg_transport_header_padding_observed"`
	PlaintextAbsentOnWire bool   `json:"plaintext_dns_absent_from_outer_udp"`
	SentDatagrams         uint64 `json:"outer_datagrams_sent"`
	ReceivedDatagrams     uint64 `json:"outer_datagrams_received"`
	DeviceErrorEvents     uint64 `json:"device_error_events"`
	ReplyMailboxDrops     uint64 `json:"synthetic_reply_mailbox_drops"`
	Stopped               bool   `json:"stopped"`
	Passed                bool   `json:"passed"`
	DurationMs            int64  `json:"duration_ms"`
	ErrorStage            string `json:"error_stage,omitempty"`
	ErrorCategory         string `json:"error_category,omitempty"`
}

// One ordinary loopback UDP exchange determines whether this host permits the
// local test. A failure ends the self-test immediately; there are no fallbacks,
// security policy changes, or attempts to contact an external address.
func verifyLoopbackUDP() error {
	server, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		return err
	}
	defer server.Close()
	client, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		return err
	}
	defer client.Close()
	const marker = "waarp-local-udp-check"
	if _, err = client.WriteToUDP([]byte(marker), server.LocalAddr().(*net.UDPAddr)); err != nil {
		return err
	}
	server.SetReadDeadline(time.Now().Add(2 * time.Second))
	var buffer [64]byte
	n, _, err := server.ReadFromUDP(buffer[:])
	if err != nil {
		return err
	}
	if string(buffer[:n]) != marker {
		return errors.New("loopback_payload_mismatch")
	}
	return nil
}

type localPair struct {
	a, b                                        *device.Device
	ta, tb                                      *memoryTUN
	ba, bb                                      *udpBind
	pubA, pubB                                  string
	ports                                       [2]uint16
	cancel                                      context.CancelFunc
	closeOnce                                   sync.Once
	closed                                      chan struct{}
	replies                                     chan []byte
	replyDrops                                  atomic.Uint64
	errors                                      atomic.Uint64
	wireHandshake, wireTransport, wirePlaintext atomic.Bool
}

func (p *localPair) observe(packet []byte) {
	if bytes.Contains(packet, dnsWireMarker) {
		p.wirePlaintext.Store(true)
	}
	if len(packet) >= 84 {
		header := binary.LittleEndian.Uint32(packet[80:84])
		if header >= 1000 && header <= 1100 {
			p.wireHandshake.Store(true)
		}
	}
	if len(packet) >= 24 {
		header := binary.LittleEndian.Uint32(packet[20:24])
		if header >= 2000 && header <= 2100 {
			p.wireHandshake.Store(true)
		}
	}
	if len(packet) >= 28 {
		header := binary.LittleEndian.Uint32(packet[12:16])
		if header >= 4000 && header <= 4100 {
			p.wireTransport.Store(true)
		}
	}
}

func (b *udpBind) localPort() uint16 {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.conn == nil {
		return 0
	}
	return uint16(b.conn.LocalAddr().(*net.UDPAddr).Port)
}

func (p *localPair) clientPeer() string {
	return fmt.Sprintf("replace_peers=true\npublic_key=%s\nendpoint=127.0.0.1:%d\nallowed_ip=%s/32\npersistent_keepalive_interval=0\n", p.pubB, p.ports[1], localServerIP)
}

func startLocalPair(ports [2]uint16) (*localPair, error) {
	p := &localPair{closed: make(chan struct{}), replies: make(chan []byte, 16)}
	ctx, cancel := context.WithCancel(context.Background())
	p.cancel = cancel
	keyA, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		cancel()
		return nil, errors.New("synthetic_key_generation")
	}
	keyB, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		cancel()
		return nil, errors.New("synthetic_key_generation")
	}
	p.pubA, p.pubB = hex.EncodeToString(keyA.PublicKey().Bytes()), hex.EncodeToString(keyB.PublicKey().Bytes())
	logger := &device.Logger{Verbosef: device.DiscardLogf, Errorf: func(string, ...any) { p.errors.Add(1) }}
	p.ta, p.tb = newMemoryTUN(1280), newMemoryTUN(1280)
	// Keep consuming decrypted packets between probes. Otherwise delayed duplicate
	// DNS replies fill memoryTUN.inbound and block the native receiver in Write;
	// Down/remove-peer then waits for that same receiver inside Peer.Stop. A bounded
	// mailbox can drop unused UDP replies, but can never hold a native worker.
	// Its lifetime follows TUN.Close, not cancel(), so shutdown can still drain a
	// receiver if a control operation already holds the Device state lock.
	go func() {
		for {
			select {
			case <-p.ta.closed:
				return
			case packet := <-p.ta.inbound:
				select {
				case p.replies <- packet:
				default:
					p.replyDrops.Add(1)
				}
			}
		}
	}()
	p.ba = &udpBind{family: "udp4", listenIP: net.IPv4(127, 0, 0, 1), observe: p.observe}
	p.bb = &udpBind{family: "udp4", listenIP: net.IPv4(127, 0, 0, 1), observe: p.observe}
	p.a = device.NewDevice(ctx, p.ta, p.ba, logger, 1)
	p.b = device.NewDevice(ctx, p.tb, p.bb, logger, 1)
	fail := func(err error) (*localPair, error) { p.close(); return nil, err }
	if err = p.a.IpcSet(fmt.Sprintf("private_key=%s\nlisten_port=%d\n%s", hex.EncodeToString(keyA.Bytes()), ports[0], localAWG)); err != nil {
		return fail(errors.New("configure_client"))
	}
	if err = p.b.IpcSet(fmt.Sprintf("private_key=%s\nlisten_port=%d\n%s", hex.EncodeToString(keyB.Bytes()), ports[1], localAWG)); err != nil {
		return fail(errors.New("configure_server"))
	}
	if err = p.a.Up(); err != nil {
		return fail(err)
	}
	if err = p.b.Up(); err != nil {
		return fail(err)
	}
	p.ports = [2]uint16{p.ba.localPort(), p.bb.localPort()}
	if err = p.a.IpcSet(p.clientPeer()); err != nil {
		return fail(errors.New("configure_client_peer"))
	}
	if err = p.b.IpcSet(fmt.Sprintf("replace_peers=true\npublic_key=%s\nendpoint=127.0.0.1:%d\nallowed_ip=%s/32\npersistent_keepalive_interval=0\n", p.pubA, p.ports[0], localClientIP)); err != nil {
		return fail(errors.New("configure_server_peer"))
	}
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case packet := <-p.tb.inbound:
				if response := syntheticDNSResponse(packet); response != nil {
					select {
					case <-ctx.Done():
						return
					case p.tb.outbound <- response:
					}
				}
			}
		}
	}()
	return p, nil
}

func (p *localPair) close() bool {
	p.closeOnce.Do(func() {
		p.cancel()
		go func() {
			var wg sync.WaitGroup
			wg.Add(2)
			go func() { defer wg.Done(); p.a.Close() }()
			go func() { defer wg.Done(); p.b.Close() }()
			wg.Wait()
			close(p.closed)
		}()
	})
	select {
	case <-p.closed:
		return true
	case <-time.After(5 * time.Second):
		return false
	}
}

func syntheticDNSResponse(request []byte) []byte {
	if len(request) < 40 || request[0] != 0x45 || request[9] != 17 {
		return nil
	}
	total := int(binary.BigEndian.Uint16(request[2:4]))
	if total > len(request) || total < 40 {
		return nil
	}
	if !bytes.Equal(request[12:16], localClientIP.AsSlice()) || !bytes.Equal(request[16:20], localServerIP.AsSlice()) {
		return nil
	}
	udp := request[20:total]
	length := int(binary.BigEndian.Uint16(udp[4:6]))
	if binary.BigEndian.Uint16(udp[2:4]) != 53 || length < 20 || length > len(udp) {
		return nil
	}
	dns := append([]byte(nil), udp[8:length]...)
	if dns[2]&0x80 != 0 || binary.BigEndian.Uint16(dns[4:6]) != 1 || !bytes.Equal(dns[12:], append(append([]byte(nil), dnsWireMarker...), 0, 1, 0, 1)) {
		return nil
	}
	binary.BigEndian.PutUint16(dns[2:4], 0x8180)
	binary.BigEndian.PutUint16(dns[6:8], 1)
	// A synthetic A record. This address is never sent to the host network.
	dns = append(dns, 0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 30, 0, 4, 192, 0, 2, 42)
	response := make([]byte, 28+len(dns))
	copy(response[:20], request[:20])
	binary.BigEndian.PutUint16(response[2:4], uint16(len(response)))
	copy(response[12:16], localServerIP.AsSlice())
	copy(response[16:20], localClientIP.AsSlice())
	response[10], response[11] = 0, 0
	var checksum uint32
	for index := 0; index < 20; index += 2 {
		checksum += uint32(binary.BigEndian.Uint16(response[index : index+2]))
	}
	for checksum > 0xffff {
		checksum = (checksum & 0xffff) + (checksum >> 16)
	}
	binary.BigEndian.PutUint16(response[10:12], ^uint16(checksum))
	binary.BigEndian.PutUint16(response[20:22], 53)
	copy(response[22:24], udp[:2])
	binary.BigEndian.PutUint16(response[24:26], uint16(8+len(dns)))
	copy(response[28:], dns)
	return response
}

// Each call chooses a new DNS transaction ID and UDP source port. Delayed
// responses from a preceding test cannot satisfy a later lifecycle assertion.
func (p *localPair) probe(timeout time.Duration) bool {
	c := &config{source: localClientIP, dns: localServerIP}
	packet, id, port, err := dnsPacket(c)
	if err != nil {
		return false
	}
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	select {
	case p.ta.outbound <- packet:
	case <-p.ta.closed:
		return false
	case <-deadline.C:
		return false
	}
	retry := time.NewTicker(300 * time.Millisecond)
	defer retry.Stop()
	for {
		select {
		case <-p.ta.closed:
			return false
		case incoming := <-p.replies:
			if match, rcode, answers := dnsResponse(incoming, c, id, port); match && rcode == 0 && answers == 1 {
				return true
			}
		case <-retry.C:
			select {
			case p.ta.outbound <- packet:
			default:
			}
		case <-deadline.C:
			return false
		}
	}
}

func peerCount(dev *device.Device) int {
	state, err := dev.IpcGet()
	if err != nil {
		return -1
	}
	count := 0
	for _, line := range strings.Split(state, "\n") {
		if strings.HasPrefix(line, "public_key=") {
			count++
		}
	}
	return count
}

func executeSelfTest(hold time.Duration) (result selfTestReport) {
	started := time.Now()
	progress := func(stage string) {
		if hold > 0 {
			// Only fixed lifecycle codes, never device logs, keys or packet bytes.
			json.NewEncoder(os.Stderr).Encode(map[string]any{"mode": "local_awg_self_test_progress", "stage": stage, "elapsed_ms": time.Since(started).Milliseconds()})
		}
	}
	result = selfTestReport{Mode: "local_awg_self_test", Revision: revision, Stopped: true}
	defer func() { result.DurationMs = time.Since(started).Milliseconds() }()
	progress("loopback_udp")
	if err := verifyLoopbackUDP(); err != nil {
		result.ErrorStage, result.ErrorCategory = "loopback_udp", category(err)
		return
	}
	result.LoopbackUDP = true
	progress("start_devices")
	pair, err := startLocalPair([2]uint16{})
	if err != nil {
		result.ErrorStage, result.ErrorCategory = "start_devices", category(err)
		return
	}
	result.Stopped = false
	collect := func(p *localPair) {
		result.SentDatagrams += p.ba.sent.Load() + p.bb.sent.Load()
		result.ReceivedDatagrams += p.ba.received.Load() + p.bb.received.Load()
		result.DeviceErrorEvents += p.errors.Load()
		result.ReplyMailboxDrops += p.replyDrops.Load()
		result.AWGHandshakeOnWire = result.AWGHandshakeOnWire || p.wireHandshake.Load()
		result.AWGTransportOnWire = result.AWGTransportOnWire || p.wireTransport.Load()
		if p.wirePlaintext.Load() {
			result.PlaintextAbsentOnWire = false
		}
	}
	result.PlaintextAbsentOnWire = true
	defer func() {
		if pair != nil {
			progress("close_devices")
			result.Stopped = pair.close()
			collect(pair)
			if !result.Stopped {
				result.ErrorStage, result.ErrorCategory = "close_devices", "timeout"
			}
		}
		result.Passed = result.ErrorStage == "" && result.LoopbackUDP && result.InitialHandshake && result.InitialDNS && result.DownUpDNS && result.PeerRemoved && result.RemovedPeerBlocked && result.PeerRestoredDNS && result.RecreatedDNS && result.AWGHandshakeOnWire && result.AWGTransportOnWire && result.PlaintextAbsentOnWire && result.Stopped
	}()
	progress("initial_encrypted_dns")
	result.InitialDNS = pair.probe(8 * time.Second)
	result.InitialHandshake = handshakeComplete(pair.a) && handshakeComplete(pair.b)
	if !result.InitialDNS || !result.InitialHandshake {
		result.ErrorStage, result.ErrorCategory = "initial_encrypted_dns", "failed"
		return
	}
	progress("down")
	if err = pair.a.Down(); err != nil {
		result.ErrorStage, result.ErrorCategory = "down", category(err)
		return
	}
	progress("up")
	if err = pair.a.Up(); err != nil {
		result.ErrorStage, result.ErrorCategory = "up", category(err)
		return
	}
	progress("down_up_dns")
	result.DownUpDNS = pair.probe(8 * time.Second)
	if !result.DownUpDNS {
		result.ErrorStage, result.ErrorCategory = "down_up_dns", "failed"
		return
	}
	progress("remove_peer")
	if err = pair.a.IpcSet("replace_peers=true\n"); err != nil {
		result.ErrorStage, result.ErrorCategory = "remove_peer", "uapi_rejected"
		return
	}
	result.PeerRemoved = peerCount(pair.a) == 0
	progress("removed_peer_dns")
	result.RemovedPeerBlocked = !pair.probe(1500 * time.Millisecond)
	if !result.PeerRemoved || !result.RemovedPeerBlocked {
		result.ErrorStage, result.ErrorCategory = "removed_peer_dns", "unexpected_response"
		return
	}
	progress("restore_peer")
	if err = pair.a.IpcSet(pair.clientPeer()); err != nil {
		result.ErrorStage, result.ErrorCategory = "restore_peer", "uapi_rejected"
		return
	}
	progress("restored_peer_dns")
	result.PeerRestoredDNS = pair.probe(8 * time.Second)
	if !result.PeerRestoredDNS {
		result.ErrorStage, result.ErrorCategory = "restored_peer_dns", "failed"
		return
	}
	ports := pair.ports
	progress("close_before_recreate")
	if !pair.close() {
		result.ErrorStage, result.ErrorCategory = "close_before_recreate", "timeout"
		return
	}
	collect(pair)
	pair = nil
	result.Stopped = true
	progress("recreate_same_ports")
	pair, err = startLocalPair(ports)
	if err != nil {
		result.ErrorStage, result.ErrorCategory = "recreate_same_ports", category(err)
		return
	}
	result.Stopped = false
	progress("recreated_dns")
	result.RecreatedDNS = pair.probe(8*time.Second) && handshakeComplete(pair.a) && handshakeComplete(pair.b)
	if !result.RecreatedDNS {
		result.ErrorStage, result.ErrorCategory = "recreated_dns", "failed"
		return
	}
	if hold > 0 {
		progress("holding_after_success")
		json.NewEncoder(os.Stdout).Encode(map[string]any{"mode": "local_awg_self_test", "stage": "holding_after_success", "hold_ms": hold.Milliseconds(), "client_loopback_port": pair.ports[0], "server_loopback_port": pair.ports[1]})
		time.Sleep(hold)
	}
	return
}
