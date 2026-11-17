//go:build linux

// SPDX-License-Identifier: MIT

package conn

import (
	"bytes"
	"errors"
	"net"
	"net/netip"
	"os"
	"syscall"
	"testing"
	"time"

	"golang.org/x/net/ipv4"
)

// Fail the first sendmmsg without depending on the host driver's GSO support.
// All fallback sends use the real loopback socket and real scatter/gather writes.
type waarpFailOnceRawConn struct {
	syscall.RawConn
	err   error
	calls int
}

func (c *waarpFailOnceRawConn) Write(fn func(uintptr) bool) error {
	c.calls++
	if c.calls == 1 {
		return c.err
	}
	return c.RawConn.Write(fn)
}

type waarpFaultUDPConn struct {
	*net.UDPConn
	raw syscall.RawConn
}

func (c *waarpFaultUDPConn) SyscallConn() (syscall.RawConn, error) {
	return c.raw, nil
}

func waarpGSORetryFixture(t *testing.T, errno syscall.Errno) (*net.UDPConn, *StdNetBind, *waarpFailOnceRawConn) {
	t.Helper()
	address := &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)}
	sender, err := net.ListenUDP("udp4", address)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { sender.Close() })
	receiver, err := net.ListenUDP("udp4", address)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { receiver.Close() })
	raw, err := sender.SyscallConn()
	if err != nil {
		t.Fatal(err)
	}
	injected := &waarpFailOnceRawConn{RawConn: raw, err: os.NewSyscallError("sendmmsg", errno)}
	bind := NewStdNetBind(nil).(*StdNetBind)
	bind.ipv4 = sender
	bind.ipv4PC = ipv4.NewPacketConn(&waarpFaultUDPConn{UDPConn: sender, raw: injected})
	bind.ipv4TxOffload = true
	return receiver, bind, injected
}

func waarpReadDatagrams(t *testing.T, receiver *net.UDPConn, payloads [][]byte) {
	t.Helper()
	if err := receiver.SetReadDeadline(time.Now().Add(2 * time.Second)); err != nil {
		t.Fatal(err)
	}
	packet := make([]byte, 512)
	for i, want := range payloads {
		n, _, err := receiver.ReadFromUDP(packet)
		if err != nil {
			t.Fatalf("read datagram %d: %v", i, err)
		}
		if !bytes.Equal(packet[:n], want) {
			t.Errorf("datagram %d changed: received %d bytes, expected %d bytes with unchanged payload", i, n, len(want))
		}
	}
}

func TestWaarpGSORetryPreservesDatagrams(t *testing.T) {
	for _, test := range []struct {
		name  string
		errno syscall.Errno
	}{
		{"EIO", syscall.EIO},
		{"EINVAL", syscall.EINVAL},
	} {
		t.Run(test.name, func(t *testing.T) {
			receiver, bind, raw := waarpGSORetryFixture(t, test.errno)
			endpoint := &StdNetEndpoint{AddrPort: netip.MustParseAddrPort(receiver.LocalAddr().String())}
			payloads := [][]byte{
				bytes.Repeat([]byte{0xa1}, 64),
				bytes.Repeat([]byte{0xb2}, 64),
				bytes.Repeat([]byte{0xc3}, 32),
			}
			const offset = 8
			packets := make([][]byte, len(payloads))
			for i, payload := range payloads {
				packets[i] = append(bytes.Repeat([]byte{0xff}, offset), payload...)
			}

			err := bind.Send(packets, endpoint, offset)
			var disabled ErrUDPGSODisabled
			if !errors.As(err, &disabled) {
				t.Fatalf("expected successful ordinary-UDP retry, got %v", err)
			}
			if disabled.RetryErr != nil {
				t.Fatalf("ordinary-UDP retry failed: %v", disabled.RetryErr)
			}
			if bind.ipv4TxOffload || raw.calls != 2 {
				t.Fatalf("GSO disable/retry state: offload=%v, writes=%d", bind.ipv4TxOffload, raw.calls)
			}
			waarpReadDatagrams(t, receiver, payloads)

			// A subsequent Send must use ordinary UDP and preserve all packet
			// boundaries too, after the pooled message buffers were returned.
			if err := bind.Send(packets, endpoint, offset); err != nil {
				t.Fatalf("subsequent send: %v", err)
			}
			if bind.ipv4TxOffload || raw.calls != 3 {
				t.Fatalf("subsequent send retried GSO: offload=%v, writes=%d", bind.ipv4TxOffload, raw.calls)
			}
			waarpReadDatagrams(t, receiver, payloads)
		})
	}
}

func TestWaarpGSOUnrelatedErrorIsNotRetried(t *testing.T) {
	receiver, bind, raw := waarpGSORetryFixture(t, syscall.EPERM)
	endpoint := &StdNetEndpoint{AddrPort: netip.MustParseAddrPort(receiver.LocalAddr().String())}
	packets := [][]byte{bytes.Repeat([]byte{0xa1}, 64), bytes.Repeat([]byte{0xb2}, 64)}
	err := bind.Send(packets, endpoint, 0)
	if !errors.Is(err, syscall.EPERM) {
		t.Fatalf("expected original EPERM, got %v", err)
	}
	var disabled ErrUDPGSODisabled
	if errors.As(err, &disabled) || !bind.ipv4TxOffload || raw.calls != 1 {
		t.Fatalf("unrelated error retried/downgraded GSO: offload=%v, writes=%d, err=%v", bind.ipv4TxOffload, raw.calls, err)
	}
}
