// SPDX-License-Identifier: Apache-2.0
package main

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/sagernet/wireguard-go/device"
	"golang.org/x/net/dns/dnsmessage"
)

// Both private keys remain on the side which generated them. The loopback control
// API exchanges public keys only; no profile, private key or packet is persisted.
type androidPeer struct {
	dev        *device.Device
	tun        *memoryTUN
	bind       *udpBind
	publicKey  string
	port       int
	registerMu sync.Mutex
	clientKey  string
	registered atomic.Bool
	handshake  atomic.Bool
	transport  atomic.Bool
	padding    atomic.Bool
	plaintext  atomic.Bool
	stopped    atomic.Bool
	replies    atomic.Uint64
	errorCount atomic.Uint64
}

type androidProof struct {
	Mode                  string `json:"mode"`
	Revision              string `json:"wireguard_revision"`
	Registered            bool   `json:"client_registered"`
	Handshake             bool   `json:"authenticated_handshake"`
	DNSReplies            uint64 `json:"encrypted_dns_replies"`
	AWGHandshakeOnWire    bool   `json:"awg_handshake_header_padding_observed"`
	AWGTransportOnWire    bool   `json:"awg_transport_header_padding_observed"`
	PlaintextAbsentOnWire bool   `json:"plaintext_dns_absent_from_outer_udp"`
	SentDatagrams         uint64 `json:"outer_datagrams_sent"`
	ReceivedDatagrams     uint64 `json:"outer_datagrams_received"`
	DeviceErrorEvents     uint64 `json:"device_error_events"`
	Stopped               bool   `json:"stopped"`
	Passed                bool   `json:"passed"`
}

func (p *androidPeer) observe(packet []byte) {
	if bytes.Contains(packet, dnsWireMarker) {
		p.plaintext.Store(true)
	}
	if len(packet) >= 84 {
		h := binary.LittleEndian.Uint32(packet[80:84])
		if h >= 1000 && h <= 1100 {
			p.padding.Store(true)
		}
	}
	if len(packet) >= 24 {
		h := binary.LittleEndian.Uint32(packet[20:24])
		if h >= 2000 && h <= 2100 {
			p.padding.Store(true)
		}
	}
	if len(packet) >= 28 {
		h := binary.LittleEndian.Uint32(packet[12:16])
		if h >= 4000 && h <= 4100 {
			p.transport.Store(true)
		}
	}
}

func (p *androidPeer) proof() androidProof {
	if !p.stopped.Load() && handshakeComplete(p.dev) {
		p.handshake.Store(true)
	}
	result := androidProof{
		Mode: "android_awg2_peer", Revision: revision,
		Registered: p.registered.Load(), Handshake: p.handshake.Load(), DNSReplies: p.replies.Load(),
		AWGHandshakeOnWire: p.padding.Load(), AWGTransportOnWire: p.transport.Load(),
		PlaintextAbsentOnWire: !p.plaintext.Load(), SentDatagrams: p.bind.sent.Load(),
		ReceivedDatagrams: p.bind.received.Load(), DeviceErrorEvents: p.errorCount.Load(), Stopped: p.stopped.Load(),
	}
	result.Passed = result.Registered && result.Handshake && result.DNSReplies >= 2 &&
		result.AWGHandshakeOnWire && result.AWGTransportOnWire && result.PlaintextAbsentOnWire &&
		result.SentDatagrams > 0 && result.ReceivedDatagrams > 0 && result.DeviceErrorEvents == 0 && result.Stopped
	return result
}

func (p *androidPeer) register(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method", http.StatusMethodNotAllowed)
		return
	}
	var input struct {
		PublicKey string `json:"public_key"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&input) != nil {
		http.Error(w, "request", http.StatusBadRequest)
		return
	}
	key, err := base64.StdEncoding.DecodeString(input.PublicKey)
	if err != nil || len(key) != 32 || bytes.Equal(key, make([]byte, 32)) {
		http.Error(w, "public_key", http.StatusBadRequest)
		return
	}
	p.registerMu.Lock()
	defer p.registerMu.Unlock()
	if p.registered.Load() && p.clientKey != input.PublicKey {
		http.Error(w, "already_registered", http.StatusConflict)
		return
	}
	if !p.registered.Load() {
		// The server learns the emulator's actual UDP source from an authenticated handshake.
		err = p.dev.IpcSet(fmt.Sprintf("replace_peers=true\npublic_key=%s\nallowed_ip=%s/32\npersistent_keepalive_interval=0\n",
			hex.EncodeToString(key), localClientIP))
		if err != nil {
			http.Error(w, "configure_peer", http.StatusInternalServerError)
			return
		}
		p.clientKey = input.PublicKey
		p.registered.Store(true)
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{"server_public_key": p.publicKey, "endpoint_port": p.port})
}

// The production router legitimately hijacks DNS and may add EDNS. Parse valid
// DNS including OPT rather than requiring the byte-exact self-test query.
func androidDNSResponse(request []byte) []byte {
	if len(request) < 40 || request[0] != 0x45 || request[9] != 17 ||
		!bytes.Equal(request[12:16], localClientIP.AsSlice()) || !bytes.Equal(request[16:20], localServerIP.AsSlice()) {
		return nil
	}
	total := int(binary.BigEndian.Uint16(request[2:4]))
	if total > len(request) || total < 40 || binary.BigEndian.Uint16(request[6:8])&0x3fff != 0 {
		return nil
	}
	udp := request[20:total]
	length := int(binary.BigEndian.Uint16(udp[4:6]))
	if binary.BigEndian.Uint16(udp[2:4]) != 53 || length < 20 || length > len(udp) {
		return nil
	}
	var query dnsmessage.Message
	if query.Unpack(udp[8:length]) != nil || query.Header.Response || len(query.Questions) != 1 {
		return nil
	}
	question := query.Questions[0]
	if question.Name.String() != "example.com." || question.Type != dnsmessage.TypeA || question.Class != dnsmessage.ClassINET {
		return nil
	}
	answer := dnsmessage.Message{
		Header:    dnsmessage.Header{ID: query.Header.ID, Response: true, RecursionDesired: query.Header.RecursionDesired, RecursionAvailable: true},
		Questions: query.Questions,
		Answers: []dnsmessage.Resource{{Header: dnsmessage.ResourceHeader{Name: question.Name, Type: dnsmessage.TypeA, Class: dnsmessage.ClassINET, TTL: 0},
			Body: &dnsmessage.AResource{A: [4]byte{192, 0, 2, 42}}}},
	}
	dns, err := answer.Pack()
	if err != nil {
		return nil
	}
	response := make([]byte, 28+len(dns))
	copy(response[:20], request[:20])
	binary.BigEndian.PutUint16(response[2:4], uint16(len(response)))
	copy(response[12:16], localServerIP.AsSlice())
	copy(response[16:20], localClientIP.AsSlice())
	response[10], response[11] = 0, 0
	var checksum uint32
	for offset := 0; offset < 20; offset += 2 {
		checksum += uint32(binary.BigEndian.Uint16(response[offset : offset+2]))
	}
	for checksum > 0xffff {
		checksum = checksum&0xffff + checksum>>16
	}
	binary.BigEndian.PutUint16(response[10:12], ^uint16(checksum))
	binary.BigEndian.PutUint16(response[20:22], 53)
	copy(response[22:24], udp[:2])
	binary.BigEndian.PutUint16(response[24:26], uint16(8+len(dns)))
	copy(response[28:], dns)
	return response
}

func executeAndroidServer(port int, reportPath string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	key, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return errors.New("synthetic_key_generation")
	}
	p := &androidPeer{port: port, publicKey: base64.StdEncoding.EncodeToString(key.PublicKey().Bytes())}
	p.tun = newMemoryTUN(1280)
	p.bind = &udpBind{family: "udp4", listenIP: net.IPv4(127, 0, 0, 1), observe: p.observe}
	p.dev = device.NewDevice(ctx, p.tun, p.bind,
		&device.Logger{Verbosef: device.DiscardLogf, Errorf: func(string, ...any) { p.errorCount.Add(1) }}, 1)
	defer func() {
		p.proof() // Remember successful authentication before closing the device.
		closed := make(chan struct{})
		go func() { p.dev.Close(); close(closed) }()
		select {
		case <-closed:
			p.stopped.Store(true)
		case <-time.After(5 * time.Second):
		}
		if report, openErr := os.OpenFile(reportPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600); openErr == nil {
			json.NewEncoder(report).Encode(p.proof())
			report.Close()
		}
	}()
	if err = p.dev.IpcSet(fmt.Sprintf("private_key=%s\nlisten_port=%d\n%s", hex.EncodeToString(key.Bytes()), port, localAWG)); err != nil {
		return errors.New("configure_device")
	}
	if err = p.dev.Up(); err != nil {
		return errors.New("start_device")
	}
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
			case packet := <-p.tun.inbound:
				if response := androidDNSResponse(packet); response != nil {
					select {
					case <-ctx.Done():
						return
					case p.tun.outbound <- response:
						p.replies.Add(1)
					}
				}
			}
		}
	}()
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })
	mux.HandleFunc("/register", p.register)
	mux.HandleFunc("/proof", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(p.proof())
	})
	listener, err := net.Listen("tcp4", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		return errors.New("control_listen")
	}
	server := &http.Server{Handler: mux, ReadHeaderTimeout: 2 * time.Second, ReadTimeout: 5 * time.Second,
		WriteTimeout: 5 * time.Second, IdleTimeout: 5 * time.Second, MaxHeaderBytes: 4096, ErrorLog: log.New(io.Discard, "", 0)}
	stopped := make(chan os.Signal, 1)
	signal.Notify(stopped, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(stopped)
	serveErrors := make(chan error, 1)
	go func() { serveErrors <- server.Serve(listener) }()
	select {
	case <-stopped:
	case <-ctx.Done():
	case <-serveErrors:
	}
	shutdown, stopShutdown := context.WithTimeout(context.Background(), 5*time.Second)
	defer stopShutdown()
	server.Shutdown(shutdown)
	return nil
}
