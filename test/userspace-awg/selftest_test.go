// SPDX-License-Identifier: Apache-2.0
package main

import (
	"testing"
	"time"
)

// A slow or paused test consumer must not block the native receiver, otherwise
// Down/remove-peer waits forever for that receiver inside Peer.Stop.
func TestSelfTestDrainsRepliesBetweenProbes(t *testing.T) {
	pair, err := startLocalPair([2]uint16{})
	if err != nil {
		t.Fatal("start_loopback_pair")
	}
	t.Cleanup(func() {
		if !pair.close() {
			t.Error("pair_shutdown_timeout")
		}
	})
	if !pair.probe(8 * time.Second) {
		t.Fatal("initial_encrypted_dns")
	}
	packet, _, _, err := dnsPacket(&config{source: localClientIP, dns: localServerIP})
	if err != nil {
		t.Fatal("synthetic_packet")
	}
	before := pair.ba.received.Load()
	deadline := time.NewTimer(3 * time.Second)
	defer deadline.Stop()
	for n := 0; n < 64; n++ {
		select {
		case pair.ta.outbound <- packet:
		case <-deadline.C:
			t.Fatal("bounded_burst_send_timeout")
		}
	}
	for pair.ba.received.Load() < before+64 {
		select {
		case <-deadline.C:
			t.Fatal("encrypted_burst_not_received")
		case <-time.After(time.Millisecond):
		}
	}
	// Allow the already received burst to reach the sequential decrypt/TUN worker.
	time.Sleep(20 * time.Millisecond)
	down := make(chan error, 1)
	go func() { down <- pair.a.Down() }()
	select {
	case err := <-down:
		if err != nil {
			t.Fatal("down_rejected")
		}
	case <-time.After(time.Second):
		t.Fatal("down_blocked_by_unread_decrypted_replies")
	}
	if pair.a.Up() != nil || !pair.probe(8*time.Second) {
		t.Fatal("fresh_encrypted_dns_after_down_up")
	}
}

func TestProbeDeadlineIncludesInitialSend(t *testing.T) {
	pair := &localPair{ta: newMemoryTUN(1280)}
	defer pair.ta.Close()
	for n := 0; n < cap(pair.ta.outbound); n++ {
		pair.ta.outbound <- []byte{0}
	}
	result := make(chan bool, 1)
	go func() { result <- pair.probe(25 * time.Millisecond) }()
	select {
	case ok := <-result:
		if ok {
			t.Fatal("full_queue_claimed_success")
		}
	case <-time.After(300 * time.Millisecond):
		// Release the old unbounded send before failing, avoiding a leaked worker.
		<-pair.ta.outbound
		<-result
		t.Fatal("initial_send_ignored_probe_deadline")
	}
}
