// SPDX-License-Identifier: Apache-2.0
package main

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"

	"github.com/sagernet/wireguard-go/conn"
)

func TestAndroidProofHTTPHasExactLengthForLargeTrace(t *testing.T) {
	peer := &androidPeer{bind: &udpBind{}}
	peer.stopped.Store(true) // This test does not construct or claim a live device.
	peer.trace.enable()
	for i := 0; i < androidTraceLimit; i++ {
		peer.trace.dns("inner-dns-write-ok", uint16(i), 56)
	}
	server := httptest.NewServer(http.HandlerFunc(peer.serveProof))
	defer server.Close()
	client, err := net.DialTimeout("tcp", strings.TrimPrefix(server.URL, "http://"), 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	client.SetDeadline(time.Now().Add(2 * time.Second))
	if _, err = io.WriteString(client, "GET /proof HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	raw, err := io.ReadAll(io.LimitReader(client, 64*1024+1))
	if err != nil || len(raw) > 64*1024 {
		t.Fatal("raw HTTP response did not complete inside its byte/time bound")
	}
	parts := bytes.SplitN(raw, []byte("\r\n\r\n"), 2)
	if len(parts) != 2 || len(parts[1]) <= 2048 || bytes.Contains(bytes.ToLower(parts[0]), []byte("transfer-encoding:")) {
		t.Fatal("large proof did not retain an unchunked JSON body")
	}
	response, err := http.ReadResponse(bufio.NewReader(bytes.NewReader(raw)), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK || response.ContentLength != int64(len(parts[1])) {
		t.Fatal("declared content length does not match exact UTF-8 body bytes")
	}
	var proof androidProof
	// Intentionally decode the original wire body, without an HTTP dechunker:
	// this is the boundary used by Android's existing fixtureJson helper.
	if json.Unmarshal(parts[1], &proof) != nil || proof.Diagnostics == nil || len(proof.Diagnostics.Events) != androidTraceLimit || proof.Passed {
		t.Fatal("raw Android-style JSON decode lost the trace or invented a pass")
	}
}

func tracePacket() []byte {
	packet := make([]byte, 96)
	binary.LittleEndian.PutUint32(packet[12:16], 4050)
	binary.LittleEndian.PutUint32(packet[16:20], 123456)
	binary.LittleEndian.PutUint64(packet[20:28], 7)
	copy(packet[28:], []byte("SECRET_PAYLOAD_MUST_NOT_BE_EXPORTED"))
	return packet
}

func TestAndroidTraceIsOptInBoundedAndDoesNotExportPacketsOrAddresses(t *testing.T) {
	var trace androidTrace
	endpoint := &udpEndpoint{remote: netip.MustParseAddrPort("192.0.2.123:43210")}
	trace.outer("outer-receive", tracePacket(), endpoint)
	trace.dns("inner-dns-received", 81, 29)
	if trace.snapshot() != nil {
		t.Fatal("disabled diagnostics retained events")
	}
	trace.enable()
	trace.outer("outer-receive", tracePacket(), endpoint)
	trace.dns("inner-dns-received", 81, 29)
	trace.dns("inner-dns-write-ok", 81, 56)
	trace.outer("outer-send", tracePacket(), endpoint)
	snapshot := trace.snapshot()
	if len(snapshot.Events) != 4 || snapshot.Events[0].Stage != "outer-receive" || snapshot.Events[3].Stage != "outer-send" ||
		snapshot.Events[0].Kind != "transport" || snapshot.Events[0].EndpointID != snapshot.Events[3].EndpointID ||
		*snapshot.Events[0].ReceiverIndex != 123456 || *snapshot.Events[0].TransportCount != 7 || *snapshot.Events[1].QueryID != 81 {
		t.Fatal("stage, framing or synthetic query correlation was lost")
	}
	for i := 4; i < androidTraceLimit+5; i++ {
		trace.outer("outer-send", tracePacket(), endpoint)
	}
	full := trace.snapshot()
	if len(full.Events) != androidTraceLimit || full.Dropped != 5 || len(snapshot.Events) != 4 {
		t.Fatal("trace cap or immutable snapshot was lost")
	}
	for i, event := range full.Events {
		if event.Sequence != i+1 || event.UnixMillis <= 0 || event.ElapsedMicros < 0 || i > 0 && event.ElapsedMicros < full.Events[i-1].ElapsedMicros {
			t.Fatal("event chronology was lost")
		}
	}
	encoded, err := json.Marshal(full)
	if err != nil || len(encoded) >= 32*1024 {
		t.Fatal("diagnostics exceeded the bounded JSON budget")
	}
	for _, forbidden := range [][]byte{[]byte("SECRET_PAYLOAD"), []byte("192.0.2.123"), []byte("192.0.2.123:43210")} {
		if bytes.Contains(encoded, forbidden) {
			t.Fatal("packet or endpoint address escaped into diagnostics")
		}
	}
}

func TestAndroidTraceBindPreservesUDPHandoffAndFailure(t *testing.T) {
	var trace androidTrace
	trace.enable()
	bind := &androidTraceBind{udpBind: &udpBind{family: "udp4", listenIP: net.IPv4(127, 0, 0, 1)}, trace: &trace}
	receive, port, err := bind.Open(0)
	if err != nil {
		t.Fatal(err)
	}
	defer bind.Close()
	remote, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer remote.Close()
	remote.SetDeadline(time.Now().Add(2 * time.Second))
	bind.conn.SetDeadline(time.Now().Add(2 * time.Second))
	endpoint := &udpEndpoint{remote: remote.LocalAddr().(*net.UDPAddr).AddrPort()}
	packet := tracePacket()
	if err = bind.Send([][]byte{packet}, endpoint, 0); err != nil {
		t.Fatal(err)
	}
	buffer := make([]byte, 1024)
	n, _, err := remote.ReadFromUDPAddrPort(buffer)
	if err != nil || !bytes.Equal(buffer[:n], packet) {
		t.Fatal("observer changed the sent UDP bytes")
	}
	if _, err = remote.WriteToUDPAddrPort(packet, netip.AddrPortFrom(netip.MustParseAddr("127.0.0.1"), port)); err != nil {
		t.Fatal(err)
	}
	sizes := make([]int, 1)
	endpoints := make([]conn.Endpoint, 1)
	n, err = receive[0]([][]byte{buffer}, sizes, endpoints)
	if err != nil || n != 1 || !bytes.Equal(buffer[:sizes[0]], packet) {
		t.Fatal("observer changed the received UDP bytes or return values")
	}
	if err = bind.Close(); err != nil {
		t.Fatal(err)
	}
	if err = bind.Send([][]byte{packet}, endpoint, 0); !errors.Is(err, net.ErrClosed) {
		t.Fatal("observer hid the original closed socket error")
	}
	if err = bind.Send([][]byte{nil}, endpoint, 1); !errors.Is(err, net.ErrClosed) {
		t.Fatal("diagnostics replaced an early transport error on invalid input")
	}
	events := trace.snapshot().Events
	if len(events) != 4 || events[0].Stage != "outer-send" || events[1].Stage != "outer-receive" || events[2].Stage != "outer-send-error" || events[3].Stage != "outer-send-error" || bind.sent.Load() != 1 || bind.received.Load() != 1 {
		t.Fatal("observer accepted a failed send or changed transport counters")
	}
}

func TestAndroidTraceShortDatagramsDoNotReadPayloadAsHeaders(t *testing.T) {
	var trace androidTrace
	trace.enable()
	for size := 0; size < 44; size++ {
		trace.outer("outer-receive", make([]byte, size), nil)
	}
	for _, event := range trace.snapshot().Events {
		if event.Kind != "unclassified" || event.QueryID != nil || event.ReceiverIndex != nil || event.TransportCount != nil {
			t.Fatal("a short datagram became a classified transport")
		}
	}
}
