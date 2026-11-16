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
	"net/netip"
	"os"
	"os/signal"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/sagernet/wireguard-go/device"
	"golang.org/x/net/dns/dnsmessage"
	"golang.zx2c4.com/wireguard/tun/netstack"
)

// Both private keys remain on the side which generated them. The loopback control
// API exchanges public keys only; no profile, private key or packet is persisted.
type androidPeer struct {
	dev          *device.Device
	tun          *androidNetTUN
	bind         *udpBind
	publicKey    string
	port         int
	registerMu   sync.Mutex
	clientKey    string
	registered   atomic.Bool
	handshake    atomic.Bool
	transport    atomic.Bool
	padding      atomic.Bool
	plaintext    atomic.Bool
	stopped      atomic.Bool
	replies      atomic.Uint64
	errorCount   atomic.Uint64
	httpStarted  atomic.Bool
	httpRequests atomic.Uint64
	httpBytes    atomic.Uint64
	firstRequest atomic.Int64
	lastRequest  atomic.Int64
	uniqueMu     sync.Mutex
	dnsNames     map[string]struct{}
	httpNonces   map[string]struct{}
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
	HTTPStarted           bool   `json:"http_server_started"`
	UniqueDNS             uint64 `json:"encrypted_dns_unique_queries"`
	HTTPRequests          uint64 `json:"encrypted_http_requests"`
	UniqueHTTP            uint64 `json:"encrypted_http_unique_requests"`
	HTTPBytes             uint64 `json:"encrypted_http_bytes"`
	FirstRequest          int64  `json:"first_encrypted_request_unix_ms"`
	LastRequest           int64  `json:"last_encrypted_request_unix_ms"`
}

func (p *androidPeer) observe(packet []byte) {
	if bytes.Contains(packet, dnsWireMarker) || bytes.Contains(packet, []byte{4, 's', 'o', 'a', 'k', 5, 'w', 'a', 'a', 'r', 'p', 4, 't', 'e', 's', 't', 0}) {
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
	p.uniqueMu.Lock()
	uniqueDNS, uniqueHTTP := len(p.dnsNames), len(p.httpNonces)
	p.uniqueMu.Unlock()
	result := androidProof{
		Mode: "android_awg2_peer", Revision: revision,
		Registered: p.registered.Load(), Handshake: p.handshake.Load(), DNSReplies: p.replies.Load(),
		AWGHandshakeOnWire: p.padding.Load(), AWGTransportOnWire: p.transport.Load(),
		PlaintextAbsentOnWire: !p.plaintext.Load(), SentDatagrams: p.bind.sent.Load(),
		ReceivedDatagrams: p.bind.received.Load(), DeviceErrorEvents: p.errorCount.Load(), Stopped: p.stopped.Load(),
		HTTPStarted: p.httpStarted.Load(), UniqueDNS: uint64(uniqueDNS), HTTPRequests: p.httpRequests.Load(),
		UniqueHTTP: uint64(uniqueHTTP), HTTPBytes: p.httpBytes.Load(),
		FirstRequest: p.firstRequest.Load(), LastRequest: p.lastRequest.Load(),
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

// Only authenticated inner UDP reaches this listener. Unique names and TTL zero
// prevent a resolver/cache-only loop from passing a multi-hour traffic check.
func androidDNSPayload(request []byte) ([]byte, string, bool) {
	var query dnsmessage.Message
	if query.Unpack(request) != nil || query.Header.Response || len(query.Questions) != 1 {
		return nil, "", false
	}
	question := query.Questions[0]
	name := strings.ToLower(question.Name.String())
	answer := dnsmessage.Message{
		Header:    dnsmessage.Header{ID: query.Header.ID, Response: true, RecursionDesired: query.Header.RecursionDesired, RecursionAvailable: true},
		Questions: query.Questions,
	}
	var address [4]byte
	valid := question.Type == dnsmessage.TypeA && question.Class == dnsmessage.ClassINET
	switch {
	case valid && name == "example.com.":
		address = [4]byte{192, 0, 2, 42}
	case valid && strings.HasSuffix(name, ".soak.waarp.test.") && len(name) <= 160:
		address = [4]byte{10, 77, 0, 1}
	default:
		valid = false
		answer.Header.RCode = dnsmessage.RCodeNameError
	}
	if valid {
		answer.Answers = []dnsmessage.Resource{{Header: dnsmessage.ResourceHeader{Name: question.Name, Type: dnsmessage.TypeA, Class: dnsmessage.ClassINET, TTL: 0}, Body: &dnsmessage.AResource{A: address}}}
	}
	packed, err := answer.Pack()
	if err != nil {
		return nil, "", false
	}
	return packed, name, valid
}

func (p *androidPeer) markRequest(key string, httpRequest bool) bool {
	p.uniqueMu.Lock()
	items := p.dnsNames
	if httpRequest {
		items = p.httpNonces
	}
	if _, known := items[key]; !known && len(items) >= 20000 {
		p.uniqueMu.Unlock()
		p.errorCount.Add(1)
		return false
	}
	items[key] = struct{}{}
	p.uniqueMu.Unlock()
	now := time.Now().UnixMilli()
	p.firstRequest.CompareAndSwap(0, now)
	p.lastRequest.Store(now)
	return true
}

var androidNoncePattern = regexp.MustCompile(`^[a-z0-9-]{8,96}$`)

const androidHTTPPayloadSize = 64 * 1024

func (p *androidPeer) innerHTTP(w http.ResponseWriter, r *http.Request) {
	nonce := r.URL.Query().Get("nonce")
	if r.Method != http.MethodGet || r.URL.Path != "/probe" || len(r.URL.Query()) != 1 || !androidNoncePattern.MatchString(nonce) {
		http.Error(w, "request", http.StatusBadRequest)
		return
	}
	// A nonce echoes the actual request, and a bounded body exercises TCP beyond
	// the SYN/headers. Private keys, profile text and packet contents are not logs.
	body := []byte("waarp-acceptance:" + nonce + "\n" + strings.Repeat("w", androidHTTPPayloadSize))
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Length", strconv.Itoa(len(body)))
	w.Header().Set("Connection", "close")
	w.WriteHeader(http.StatusOK)
	written, err := w.Write(body)
	if err == nil && written == len(body) && p.markRequest(nonce, true) {
		p.httpRequests.Add(1)
		p.httpBytes.Add(uint64(written))
	}
}

func executeAndroidServer(port int, reportPath string) error {
	return executeAndroidServerFor(port, reportPath, 30*time.Minute)
}

func executeAndroidServerFor(port int, reportPath string, duration time.Duration) error {
	if duration < time.Minute || duration > 4*time.Hour {
		return errors.New("invalid_fixture_duration")
	}
	ctx, cancel := context.WithTimeout(context.Background(), duration)
	defer cancel()
	key, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return errors.New("synthetic_key_generation")
	}
	p := &androidPeer{port: port, publicKey: base64.StdEncoding.EncodeToString(key.PublicKey().Bytes()), dnsNames: make(map[string]struct{}), httpNonces: make(map[string]struct{})}
	stackTUN, stackNet, err := netstack.CreateNetTUN([]netip.Addr{localServerIP}, nil, 1280)
	if err != nil {
		return errors.New("inner_stack")
	}
	p.tun = adaptAndroidNetTUN(stackTUN)
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
	dnsListener, err := stackNet.ListenUDPAddrPort(netip.AddrPortFrom(localServerIP, 53))
	if err != nil {
		return errors.New("inner_dns_listen")
	}
	defer dnsListener.Close()
	go func() {
		buffer := make([]byte, 4096)
		for {
			n, address, readErr := dnsListener.ReadFrom(buffer)
			if readErr != nil {
				return
			}
			response, name, valid := androidDNSPayload(buffer[:n])
			if response == nil {
				continue
			}
			if written, writeErr := dnsListener.WriteTo(response, address); writeErr == nil && written == len(response) && valid && p.markRequest(name, false) {
				p.replies.Add(1)
			}
		}
	}()
	innerListener, err := stackNet.ListenTCPAddrPort(netip.AddrPortFrom(localServerIP, 18080))
	if err != nil {
		return errors.New("inner_http_listen")
	}
	innerServer := &http.Server{Handler: http.HandlerFunc(p.innerHTTP), ReadHeaderTimeout: 3 * time.Second,
		ReadTimeout: 5 * time.Second, WriteTimeout: 10 * time.Second, IdleTimeout: time.Second,
		MaxHeaderBytes: 4096, ErrorLog: log.New(io.Discard, "", 0)}
	defer innerServer.Close()
	p.httpStarted.Store(true)
	go func() {
		if serveErr := innerServer.Serve(innerListener); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			p.errorCount.Add(1)
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
