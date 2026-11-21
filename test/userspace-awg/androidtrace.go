// SPDX-License-Identifier: Apache-2.0
package main

import (
	"encoding/binary"
	"net/netip"
	"sync"
	"time"

	"github.com/sagernet/wireguard-go/conn"
)

const androidTraceLimit = 96

// Opt-in fixture diagnostics, not a packet capture. Only framing metadata and
// synthetic DNS transaction IDs leave this object; endpoint addresses, keys and
// payload bytes are never retained in events or exported. The first bounded
// window is retained so a later test cannot overwrite the OFF/ON failure.
type androidTrace struct {
	mu        sync.Mutex
	enabled   bool
	started   time.Time
	events    []androidTraceEvent
	dropped   uint64
	endpoints map[netip.AddrPort]uint32
}

type androidTraceEvent struct {
	Sequence       int     `json:"sequence"`
	ElapsedMicros  int64   `json:"elapsed_us"`
	UnixMillis     int64   `json:"unix_ms"`
	Stage          string  `json:"stage"`
	Kind           string  `json:"kind,omitempty"`
	Bytes          int     `json:"bytes"`
	EndpointID     uint32  `json:"endpoint_id,omitempty"`
	QueryID        *uint16 `json:"query_id,omitempty"`
	ReceiverIndex  *uint32 `json:"receiver_index,omitempty"`
	TransportCount *uint64 `json:"transport_counter,omitempty"`
}

type androidTraceSnapshot struct {
	SchemaVersion int                 `json:"schema_version"`
	Limit         int                 `json:"limit"`
	Dropped       uint64              `json:"dropped"`
	Events        []androidTraceEvent `json:"events"`
	Scope         string              `json:"scope"`
}

func (t *androidTrace) enable() {
	t.mu.Lock()
	defer t.mu.Unlock()
	if !t.enabled {
		t.enabled = true
		t.started = time.Now()
		t.endpoints = make(map[netip.AddrPort]uint32)
	}
}

func (t *androidTrace) record(event androidTraceEvent, endpoint conn.Endpoint) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if !t.enabled {
		return
	}
	if len(t.events) == androidTraceLimit {
		t.dropped++
		return
	}
	if remote, ok := endpoint.(*udpEndpoint); ok {
		id := t.endpoints[remote.remote]
		if id == 0 {
			id = uint32(len(t.endpoints) + 1)
			t.endpoints[remote.remote] = id
		}
		event.EndpointID = id
	}
	now := time.Now()
	event.Sequence = len(t.events) + 1
	event.ElapsedMicros = now.Sub(t.started).Microseconds()
	event.UnixMillis = now.UnixMilli()
	t.events = append(t.events, event)
}

func (t *androidTrace) dns(stage string, queryID uint16, size int) {
	t.record(androidTraceEvent{Stage: stage, Kind: "synthetic-dns", Bytes: size, QueryID: &queryID}, nil)
}

func (t *androidTrace) outer(stage string, packet []byte, endpoint conn.Endpoint) {
	t.mu.Lock()
	enabled := t.enabled
	t.mu.Unlock()
	if !enabled {
		return
	}
	event := androidTraceEvent{Stage: stage, Kind: "unclassified", Bytes: len(packet)}
	// These offsets/ranges are the fixture's fixed localAWG contract. Framing
	// recognition is not a claim that the packet was authenticated/decrypted.
	if len(packet) >= 44 && inRange(binary.LittleEndian.Uint32(packet[12:16]), 4000, 4100) {
		event.Kind = "transport"
		receiver := binary.LittleEndian.Uint32(packet[16:20])
		counter := binary.LittleEndian.Uint64(packet[20:28])
		event.ReceiverIndex, event.TransportCount = &receiver, &counter
	} else if len(packet) == 228 && inRange(binary.LittleEndian.Uint32(packet[80:84]), 1000, 1100) {
		event.Kind = "handshake-initiation"
	} else if len(packet) == 112 && inRange(binary.LittleEndian.Uint32(packet[20:24]), 2000, 2100) {
		event.Kind = "handshake-response"
	} else if len(packet) == 99 && inRange(binary.LittleEndian.Uint32(packet[35:39]), 3000, 3100) {
		event.Kind = "cookie"
	}
	t.record(event, endpoint)
}

func inRange(value, minimum, maximum uint32) bool { return value >= minimum && value <= maximum }

func (t *androidTrace) snapshot() *androidTraceSnapshot {
	t.mu.Lock()
	defer t.mu.Unlock()
	if !t.enabled {
		return nil
	}
	return &androidTraceSnapshot{SchemaVersion: 1, Limit: androidTraceLimit, Dropped: t.dropped,
		Events: append([]androidTraceEvent{}, t.events...),
		Scope:  "Opt-in synthetic fixture metadata. Inner write means gVisor UDP accepted bytes; outer send means host UDP accepted bytes. Neither proves Android receipt. Framing is not authentication. Endpoint IDs have no exported address mapping; no keys or payloads are retained."}
}

// Observe only completed calls and preserve the original Bind's return values.
// BatchSize is one for udpBind, so a failed Send is not counted as a sent packet.
type androidTraceBind struct {
	*udpBind
	trace *androidTrace
}

func (b *androidTraceBind) Open(port uint16) ([]conn.ReceiveFunc, uint16, error) {
	functions, actualPort, err := b.udpBind.Open(port)
	if err != nil {
		return functions, actualPort, err
	}
	for index, receive := range functions {
		functions[index] = func(packets [][]byte, sizes []int, endpoints []conn.Endpoint) (int, error) {
			n, receiveErr := receive(packets, sizes, endpoints)
			if receiveErr == nil {
				for i := 0; i < n; i++ {
					b.trace.outer("outer-receive", packets[i][:sizes[i]], endpoints[i])
				}
			}
			return n, receiveErr
		}
	}
	return functions, actualPort, nil
}

func (b *androidTraceBind) Send(packets [][]byte, remote conn.Endpoint, offset int) error {
	err := b.udpBind.Send(packets, remote, offset)
	stage := "outer-send"
	if err != nil {
		stage = "outer-send-error"
	}
	for _, packet := range packets {
		if offset < 0 || offset > len(packet) {
			// A failed underlying call may return before examining its input.
			// Diagnostics must not replace that result with a slicing panic.
			b.trace.record(androidTraceEvent{Stage: stage, Kind: "invalid-offset", Bytes: len(packet)}, remote)
			continue
		}
		b.trace.outer(stage, packet[offset:], remote)
	}
	return err
}
