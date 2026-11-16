// SPDX-License-Identifier: Apache-2.0
// Standalone audit harness, not part of Waarp or a replacement for sing-box.
// Uses the public Device/tun.Device/conn.Bind contracts of the pinned MIT library.
package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/netip"
	"os"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/sagernet/wireguard-go/conn"
	"github.com/sagernet/wireguard-go/device"
	"github.com/sagernet/wireguard-go/tun"
)

const revision = "64065e6826ad82aa28429dd829c1c65f29b7f6c9"

type report struct {
	Mode              string `json:"mode"`
	Revision          string `json:"wireguard_revision"`
	ConfigValid       bool   `json:"config_valid"`
	DeviceConfigured  bool   `json:"device_configured"`
	SocketOpened      bool   `json:"socket_opened"`
	Handshake         bool   `json:"authenticated_handshake"`
	DNSReply          bool   `json:"tunneled_dns_reply"`
	DNSRCode          *int   `json:"dns_rcode,omitempty"`
	DNSAnswers        int    `json:"dns_answers"`
	SentDatagrams     uint64 `json:"outer_datagrams_sent"`
	ReceivedDatagrams uint64 `json:"outer_datagrams_received"`
	DecryptedPackets  int    `json:"decrypted_packets"`
	DeviceErrorEvents uint64 `json:"device_error_events"`
	NetworkError      string `json:"network_error_category,omitempty"`
	Stopped           bool   `json:"stopped"`
	DurationMs        int64  `json:"duration_ms"`
	ErrorStage        string `json:"error_stage,omitempty"`
	ErrorCategory     string `json:"error_category,omitempty"`
}

type config struct {
	source, dns netip.Addr
	remote      netip.AddrPort
	mtu         int
	uapi        string
}

// All returned error messages are fixed field names/codes. Neither errors nor
// library logs may print input values, paths, UAPI text or packet bytes.
func loadConfig(path string) (*config, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, errors.New("config_read")
	}
	defer f.Close()
	raw, err := io.ReadAll(io.LimitReader(f, 1024*1024+1))
	if err != nil || len(raw) > 1024*1024 {
		return nil, errors.New("config_size")
	}
	sections := map[string]map[string]string{}
	section := ""
	for _, rawLine := range strings.Split(strings.TrimPrefix(string(raw), "\ufeff"), "\n") {
		line := strings.TrimSpace(strings.SplitN(rawLine, "#", 2)[0])
		if line == "" || strings.HasPrefix(line, ";") {
			continue
		}
		if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
			section = strings.ToLower(line[1 : len(line)-1])
			if (section != "interface" && section != "peer") || sections[section] != nil {
				return nil, errors.New("config_sections")
			}
			sections[section] = map[string]string{}
			continue
		}
		key, value, found := strings.Cut(line, "=")
		if !found || sections[section] == nil {
			return nil, errors.New("config_line")
		}
		key, value = strings.ToLower(strings.TrimSpace(key)), strings.TrimSpace(value)
		if key == "address" || key == "dns" || key == "allowedips" {
			if previous := sections[section][key]; previous != "" {
				value = previous + "," + value
			}
		} else if previous, exists := sections[section][key]; exists && previous != value {
			return nil, errors.New("config_duplicate")
		}
		sections[section][key] = value
	}
	i, p := sections["interface"], sections["peer"]
	if i == nil || p == nil {
		return nil, errors.New("config_sections")
	}
	interfaceKeys := " privatekey address dns mtu listenport jc jmin jmax s1 s2 s3 s4 h1 h2 h3 h4 i1 i2 i3 i4 i5 "
	peerKeys := " publickey presharedkey endpoint allowedips persistentkeepalive "
	for key := range i {
		if !strings.Contains(interfaceKeys, " "+key+" ") {
			return nil, errors.New("unsupported_interface_field")
		}
	}
	for key := range p {
		if !strings.Contains(peerKeys, " "+key+" ") {
			return nil, errors.New("unsupported_peer_field")
		}
	}
	c := &config{mtu: 1280}
	for _, value := range strings.Split(i["address"], ",") {
		prefix, e := parsePrefix(value)
		if e != nil {
			return nil, errors.New("address")
		}
		if !c.source.IsValid() && prefix.Addr().Is4() {
			c.source = prefix.Addr()
		}
	}
	for _, value := range strings.Split(i["dns"], ",") {
		addr, e := netip.ParseAddr(strings.TrimSpace(value))
		if e == nil && addr.Is4() && !c.dns.IsValid() {
			c.dns = addr
		}
	}
	if !c.source.IsValid() || !c.dns.IsValid() {
		return nil, errors.New("requires_ipv4_address_and_dns")
	}
	c.remote, err = netip.ParseAddrPort(p["endpoint"])
	if err != nil || c.remote.Port() == 0 {
		return nil, errors.New("requires_literal_ip_endpoint")
	}
	if value := i["mtu"]; value != "" {
		n, e := strconv.Atoi(value)
		if e != nil || n < 576 || n > 9000 {
			return nil, errors.New("mtu")
		}
		c.mtu = n
	}
	var lines []string
	keyHex := func(value string) (string, error) {
		decoded, e := base64.StdEncoding.DecodeString(value)
		if e != nil || len(decoded) != 32 {
			return "", errors.New("key_format")
		}
		return hex.EncodeToString(decoded), nil
	}
	private, err := keyHex(i["privatekey"])
	if err != nil {
		return nil, err
	}
	public, err := keyHex(p["publickey"])
	if err != nil {
		return nil, err
	}
	lines = append(lines, "private_key="+private)
	if value := i["listenport"]; value != "" {
		n, e := strconv.ParseUint(value, 10, 16)
		if e != nil {
			return nil, errors.New("listen_port")
		}
		lines = append(lines, "listen_port="+strconv.FormatUint(n, 10))
	}
	for _, key := range []string{"jc", "jmin", "jmax", "s1", "s2", "s3", "s4"} {
		value := i[key]
		if value == "" {
			continue
		}
		bits := 32
		if strings.HasPrefix(key, "s") {
			bits = 16
		}
		n, e := strconv.ParseUint(value, 10, bits)
		if e != nil {
			return nil, errors.New("awg_numeric_field")
		}
		if n != 0 {
			lines = append(lines, key+"="+strconv.FormatUint(n, 10))
		}
	}
	jmin, _ := strconv.ParseUint(i["jmin"], 10, 32)
	jmax, _ := strconv.ParseUint(i["jmax"], 10, 32)
	if jmin > jmax {
		return nil, errors.New("awg_junk_order")
	}
	for _, key := range []string{"h1", "h2", "h3", "h4"} {
		value := strings.ReplaceAll(i[key], " ", "")
		if value == "" || value == "0" || value == "0-0" {
			continue
		}
		parts := strings.Split(value, "-")
		if len(parts) > 2 {
			return nil, errors.New("awg_header")
		}
		low, e := strconv.ParseUint(parts[0], 10, 32)
		if e != nil {
			return nil, errors.New("awg_header")
		}
		high := low
		if len(parts) == 2 {
			high, err = strconv.ParseUint(parts[1], 10, 32)
			if err != nil || high < low {
				return nil, errors.New("awg_header")
			}
		}
		lines = append(lines, key+"="+value)
	}
	for _, key := range []string{"i1", "i2", "i3", "i4", "i5"} {
		if value := i[key]; value != "" {
			lines = append(lines, key+"="+value)
		}
	}
	lines = append(lines, "replace_peers=true", "public_key="+public, "endpoint="+c.remote.String())
	if value := p["presharedkey"]; value != "" {
		psk, e := keyHex(value)
		if e != nil {
			return nil, e
		}
		lines = append(lines, "preshared_key="+psk)
	}
	dnsAllowed := false
	for _, value := range strings.Split(p["allowedips"], ",") {
		prefix, e := parsePrefix(value)
		if e != nil {
			return nil, errors.New("allowed_ips")
		}
		lines = append(lines, "allowed_ip="+prefix.String())
		dnsAllowed = dnsAllowed || prefix.Contains(c.dns)
	}
	if !dnsAllowed {
		return nil, errors.New("dns_outside_allowed_ips")
	}
	keepalive := uint64(0)
	if value := p["persistentkeepalive"]; value != "" && !strings.EqualFold(value, "off") {
		keepalive, err = strconv.ParseUint(value, 10, 16)
		if err != nil {
			return nil, errors.New("keepalive")
		}
	}
	lines = append(lines, "persistent_keepalive_interval="+strconv.FormatUint(keepalive, 10))
	c.uapi = strings.Join(lines, "\n") + "\n"
	return c, nil
}

func parsePrefix(value string) (netip.Prefix, error) {
	value = strings.TrimSpace(value)
	if !strings.Contains(value, "/") {
		addr, err := netip.ParseAddr(value)
		if err != nil || addr.Zone() != "" {
			return netip.Prefix{}, errors.New("prefix")
		}
		return netip.PrefixFrom(addr, addr.BitLen()), nil
	}
	return netip.ParsePrefix(value)
}

// The library explicitly supports caller-provided Bind implementations. This
// adapter uses ordinary UDP only; it neither requests sticky sockets nor reads
// or modifies kernel interfaces/routes. It is not a wrapper hiding StdNetBind.
type udpBind struct {
	mu             sync.Mutex
	conn           *net.UDPConn
	family         string
	listenIP       net.IP
	observe        func([]byte)
	sent, received atomic.Uint64
	lastError      atomic.Value
}
type udpEndpoint struct{ remote netip.AddrPort }

func (e *udpEndpoint) ClearSrc()           {}
func (e *udpEndpoint) SrcToString() string { return "" }
func (e *udpEndpoint) DstToString() string { return e.remote.String() }
func (e *udpEndpoint) DstToBytes() []byte  { value, _ := e.remote.MarshalBinary(); return value }
func (e *udpEndpoint) DstIP() netip.Addr   { return e.remote.Addr() }
func (e *udpEndpoint) SrcIP() netip.Addr   { return netip.Addr{} }
func (b *udpBind) ParseEndpoint(value string) (conn.Endpoint, error) {
	addr, err := netip.ParseAddrPort(value)
	if err != nil {
		return nil, errors.New("endpoint")
	}
	return &udpEndpoint{remote: addr}, nil
}
func (b *udpBind) Open(port uint16) ([]conn.ReceiveFunc, uint16, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.conn != nil {
		return nil, 0, conn.ErrBindAlreadyOpen
	}
	socket, err := net.ListenUDP(b.family, &net.UDPAddr{IP: b.listenIP, Port: int(port)})
	if err != nil {
		return nil, 0, err
	}
	b.conn = socket
	receive := func(packets [][]byte, sizes []int, endpoints []conn.Endpoint) (int, error) {
		n, remote, err := socket.ReadFromUDPAddrPort(packets[0])
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return 0, net.ErrClosed
			}
			b.lastError.Store(category(err))
			return 0, err
		}
		sizes[0] = n
		endpoints[0] = &udpEndpoint{remote: remote}
		b.received.Add(1)
		if b.observe != nil {
			b.observe(packets[0][:n])
		}
		return 1, nil
	}
	return []conn.ReceiveFunc{receive}, uint16(socket.LocalAddr().(*net.UDPAddr).Port), nil
}
func (b *udpBind) Close() error {
	b.mu.Lock()
	socket := b.conn
	b.conn = nil
	b.mu.Unlock()
	if socket != nil {
		return socket.Close()
	}
	return nil
}
func (b *udpBind) Send(packets [][]byte, remote conn.Endpoint, offset int) error {
	b.mu.Lock()
	socket := b.conn
	b.mu.Unlock()
	if socket == nil {
		return net.ErrClosed
	}
	endpoint, ok := remote.(*udpEndpoint)
	if !ok {
		return conn.ErrWrongEndpointType
	}
	for _, packet := range packets {
		if b.observe != nil {
			b.observe(packet[offset:])
		}
		if _, err := socket.WriteToUDPAddrPort(packet[offset:], endpoint.remote); err != nil {
			if !errors.Is(err, net.ErrClosed) {
				b.lastError.Store(category(err))
			}
			return err
		}
		b.sent.Add(1)
	}
	return nil
}
func (b *udpBind) SetMark(mark uint32) error {
	if mark != 0 {
		return errors.ErrUnsupported
	}
	return nil
}
func (b *udpBind) BatchSize() int                                     { return 1 }
func (b *udpBind) SetReservedForEndpoint(_ netip.AddrPort, _ [3]byte) {}

type memoryTUN struct {
	outbound, inbound chan []byte
	events            chan tun.Event
	closed            chan struct{}
	once              sync.Once
	mtu               int
}

func newMemoryTUN(mtu int) *memoryTUN {
	return &memoryTUN{outbound: make(chan []byte, 16), inbound: make(chan []byte, 16), events: make(chan tun.Event), closed: make(chan struct{}), mtu: mtu}
}
func (t *memoryTUN) File() *os.File           { return nil }
func (t *memoryTUN) MTU() (int, error)        { return t.mtu, nil }
func (t *memoryTUN) Name() (string, error)    { return "in-memory-audit", nil }
func (t *memoryTUN) Events() <-chan tun.Event { return t.events }
func (t *memoryTUN) BatchSize() int           { return 1 }
func (t *memoryTUN) Read(packets [][]byte, sizes []int, offset int) (int, error) {
	select {
	case <-t.closed:
		return 0, os.ErrClosed
	case packet := <-t.outbound:
		if len(packet) > len(packets[0])-offset {
			return 0, io.ErrShortBuffer
		}
		sizes[0] = copy(packets[0][offset:], packet)
		return 1, nil
	}
}
func (t *memoryTUN) Write(packets [][]byte, offset int) (int, error) {
	for _, packet := range packets {
		copyOfPacket := append([]byte(nil), packet[offset:]...)
		select {
		case <-t.closed:
			return 0, os.ErrClosed
		case t.inbound <- copyOfPacket:
		}
	}
	return len(packets), nil
}
func (t *memoryTUN) Close() error { t.once.Do(func() { close(t.closed); close(t.events) }); return nil }

// Construct a normal IPv4/UDP DNS packet in memory. No raw socket is used:
// wireguard-go encrypts it and sends its outer datagram through the UDP Bind.
func dnsPacket(c *config) ([]byte, uint16, uint16, error) {
	var nonce [4]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return nil, 0, 0, err
	}
	id := binary.BigEndian.Uint16(nonce[:2])
	port := uint16(32768) + binary.BigEndian.Uint16(nonce[2:])%20000
	dns := make([]byte, 12)
	binary.BigEndian.PutUint16(dns[0:2], id)
	binary.BigEndian.PutUint16(dns[2:4], 0x0100) // recursion desired
	binary.BigEndian.PutUint16(dns[4:6], 1)
	dns = append(dns, 7, 'e', 'x', 'a', 'm', 'p', 'l', 'e', 3, 'c', 'o', 'm', 0, 0, 1, 0, 1)
	packet := make([]byte, 20+8+len(dns))
	packet[0], packet[8], packet[9] = 0x45, 64, 17
	binary.BigEndian.PutUint16(packet[2:4], uint16(len(packet)))
	binary.BigEndian.PutUint16(packet[4:6], id)
	copy(packet[12:16], c.source.AsSlice())
	copy(packet[16:20], c.dns.AsSlice())
	var checksum uint32
	for index := 0; index < 20; index += 2 {
		checksum += uint32(binary.BigEndian.Uint16(packet[index : index+2]))
	}
	for checksum > 0xffff {
		checksum = (checksum & 0xffff) + (checksum >> 16)
	}
	binary.BigEndian.PutUint16(packet[10:12], ^uint16(checksum))
	binary.BigEndian.PutUint16(packet[20:22], port)
	binary.BigEndian.PutUint16(packet[22:24], 53)
	binary.BigEndian.PutUint16(packet[24:26], uint16(8+len(dns)))
	// An all-zero UDP checksum is explicitly valid for IPv4.
	copy(packet[28:], dns)
	return packet, id, port, nil
}

func dnsResponse(packet []byte, c *config, id, port uint16) (bool, int, int) {
	if len(packet) < 40 || packet[0]>>4 != 4 || packet[9] != 17 {
		return false, 0, 0
	}
	header := int(packet[0]&15) * 4
	total := int(binary.BigEndian.Uint16(packet[2:4]))
	if header < 20 || total < header+20 || total > len(packet) || binary.BigEndian.Uint16(packet[6:8])&0x3fff != 0 {
		return false, 0, 0
	}
	if !bytes.Equal(packet[12:16], c.dns.AsSlice()) || !bytes.Equal(packet[16:20], c.source.AsSlice()) {
		return false, 0, 0
	}
	udp := packet[header:total]
	if binary.BigEndian.Uint16(udp[:2]) != 53 || binary.BigEndian.Uint16(udp[2:4]) != port {
		return false, 0, 0
	}
	length := int(binary.BigEndian.Uint16(udp[4:6]))
	if length < 20 || length > len(udp) {
		return false, 0, 0
	}
	dns := udp[8:length]
	if binary.BigEndian.Uint16(dns[:2]) != id || dns[2]&0x80 == 0 {
		return false, 0, 0
	}
	return true, int(dns[3] & 15), int(binary.BigEndian.Uint16(dns[6:8]))
}

func handshakeComplete(dev *device.Device) bool {
	state, err := dev.IpcGet()
	if err != nil {
		return false
	}
	for _, line := range strings.Split(state, "\n") {
		if value, found := strings.CutPrefix(line, "last_handshake_time_sec="); found {
			n, _ := strconv.ParseInt(value, 10, 64)
			return n > 0
		}
	}
	return false
}

func category(err error) string {
	if errors.Is(err, syscall.EPERM) || errors.Is(err, syscall.EACCES) {
		return "permission_denied"
	}
	if errors.Is(err, syscall.EADDRINUSE) {
		return "address_in_use"
	}
	if errors.Is(err, syscall.ENETUNREACH) || errors.Is(err, syscall.EHOSTUNREACH) {
		return "network_unreachable"
	}
	return "operation_failed"
}

func execute(path string, network bool, timeout time.Duration) (result report) {
	started := time.Now()
	result = report{Mode: "dry_run", Revision: revision, Stopped: true}
	defer func() { result.DurationMs = time.Since(started).Milliseconds() }()
	c, err := loadConfig(path)
	if err != nil {
		result.ErrorStage, result.ErrorCategory = "config", err.Error()
		return
	}
	result.ConfigValid = true
	if !network {
		return
	}
	result.Mode = "userspace_library_probe"
	packet, id, port, err := dnsPacket(c)
	if err != nil {
		result.ErrorStage, result.ErrorCategory = "probe_setup", "random_failed"
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	t := newMemoryTUN(c.mtu)
	b := &udpBind{family: "udp4"}
	if c.remote.Addr().Is6() {
		b.family = "udp6"
	}
	var errorEvents atomic.Uint64
	logger := &device.Logger{Verbosef: device.DiscardLogf, Errorf: func(string, ...any) { errorEvents.Add(1) }}
	dev := device.NewDevice(ctx, t, b, logger, 1)
	result.Stopped = false
	defer func() {
		done := make(chan struct{})
		go func() { dev.Close(); close(done) }()
		select {
		case <-done:
			result.Stopped = true
		case <-time.After(5 * time.Second):
			result.ErrorStage, result.ErrorCategory = "close", "timeout"
		}
		result.SentDatagrams, result.ReceivedDatagrams = b.sent.Load(), b.received.Load()
		result.DeviceErrorEvents = errorEvents.Load()
		if last := b.lastError.Load(); last != nil {
			result.NetworkError = last.(string)
		}
	}()
	if err = dev.IpcSet(c.uapi); err != nil {
		result.ErrorStage, result.ErrorCategory = "configure_device", "uapi_rejected"
		return
	}
	result.DeviceConfigured = true
	if err = dev.Up(); err != nil {
		result.ErrorStage, result.ErrorCategory = "open_udp", category(err)
		return
	}
	result.SocketOpened = true
	t.outbound <- packet
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	retry := time.NewTicker(2 * time.Second)
	defer retry.Stop()
	poll := time.NewTicker(250 * time.Millisecond)
	defer poll.Stop()
	for {
		select {
		case incoming := <-t.inbound:
			result.DecryptedPackets++
			if match, rcode, answers := dnsResponse(incoming, c, id, port); match {
				result.Handshake = handshakeComplete(dev)
				result.DNSReply, result.DNSRCode, result.DNSAnswers = true, &rcode, answers
				if rcode != 0 || answers == 0 {
					result.ErrorStage, result.ErrorCategory = "dns_reply", "no_successful_answer"
				}
				return
			}
		case <-poll.C:
			result.Handshake = result.Handshake || handshakeComplete(dev)
		case <-retry.C:
			select {
			case t.outbound <- packet:
			default:
			}
		case <-deadline.C:
			result.Handshake = result.Handshake || handshakeComplete(dev)
			result.ErrorStage, result.ErrorCategory = "probe", "timeout"
			return
		}
	}
}

func main() {
	path := flag.String("config", "", "Path to private .conf; content and path are never logged")
	network := flag.Bool("run", false, "Explicitly open UDP and run the authenticated tunnel DNS probe")
	timeout := flag.Duration("timeout", 20*time.Second, "Network phase timeout (1s to 30s)")
	selfTest := flag.Bool("self-test", false, "Run synthetic AWG2 lifecycle checks using loopback UDP only")
	hold := flag.Duration("hold", 0, "Hold successful self-test devices open for a bounded SIGKILL/restart experiment (0 to 60s)")
	androidServer := flag.Bool("android-server", false, "Serve one ephemeral Android AWG2 test peer on loopback only")
	androidPort := flag.Int("android-port", 18081, "Loopback TCP control and UDP AWG port for the Android acceptance fixture")
	androidReport := flag.String("android-report", "", "Write only boolean/counter evidence after the Android fixture stops")
	flag.Parse()
	if *androidServer {
		if *path != "" || *network || *selfTest || *hold != 0 || *androidPort < 1024 || *androidPort > 65535 || *androidReport == "" {
			fmt.Println(`{"error_stage":"arguments","error_category":"invalid_android_fixture_arguments"}`)
			os.Exit(2)
		}
		if err := executeAndroidServer(*androidPort, *androidReport); err != nil {
			fmt.Println(`{"error_stage":"android_fixture","error_category":"operation_failed"}`)
			os.Exit(1)
		}
		return
	}
	if *selfTest {
		if *path != "" || *network || *hold < 0 || *hold > 60*time.Second {
			fmt.Println(`{"error_stage":"arguments","error_category":"self_test_requires_no_config_or_run_and_bounded_hold"}`)
			os.Exit(2)
		}
		result := executeSelfTest(*hold)
		json.NewEncoder(os.Stdout).Encode(result)
		if !result.Passed {
			os.Exit(1)
		}
		return
	}
	if *hold != 0 {
		fmt.Println(`{"error_stage":"arguments","error_category":"hold_is_self_test_only"}`)
		os.Exit(2)
	}
	if *path == "" || *timeout < time.Second || *timeout > 30*time.Second {
		fmt.Println(`{"error_stage":"arguments","error_category":"config_path_and_bounded_timeout_required"}`)
		os.Exit(2)
	}
	result := execute(*path, *network, *timeout)
	json.NewEncoder(os.Stdout).Encode(result)
	if result.ErrorStage != "" || (*network && (!result.Handshake || !result.DNSReply || !result.Stopped)) {
		os.Exit(1)
	}
}
