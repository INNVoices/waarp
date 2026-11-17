package transport

import (
	"context"
	"errors"
	"io"
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/sagernet/sing-box/adapter"
	C "github.com/sagernet/sing-box/constant"
	boxDNS "github.com/sagernet/sing-box/dns"
	"github.com/sagernet/sing-box/log"
	M "github.com/sagernet/sing/common/metadata"

	mDNS "github.com/miekg/dns"
)

// A packet-preserving connection permits deterministic handovers between the
// actual UDP transport's writeQuery/readResponse and multiplexer. DNS encoding,
// query-ID replacement, connection pooling and completion are production code.
type waarpDNSRead struct {
	packet []byte
	err    error
}

type waarpDNSConn struct {
	writes    chan []byte
	reads     chan waarpDNSRead
	closed    chan struct{}
	closeOnce sync.Once
	readCount atomic.Int32
	readGate  <-chan struct{}
	readHeld  chan struct{}
	readAgain chan struct{}
}

func waarpNewDNSConn(gate <-chan struct{}) *waarpDNSConn {
	return &waarpDNSConn{
		writes: make(chan []byte, 64), reads: make(chan waarpDNSRead, 64),
		closed: make(chan struct{}), readGate: gate,
		readHeld: make(chan struct{}), readAgain: make(chan struct{}),
	}
}

func (c *waarpDNSConn) Read(buffer []byte) (int, error) {
	count := c.readCount.Add(1)
	if count == 2 {
		close(c.readAgain)
	}
	select {
	case result := <-c.reads:
		if result.err != nil {
			return 0, result.err
		}
		if count == 1 && c.readGate != nil {
			close(c.readHeld)
			<-c.readGate // A read completed just before retirement; release it explicitly.
		}
		return copy(buffer, result.packet), nil
	case <-c.closed:
		return 0, net.ErrClosed
	}
}

func (c *waarpDNSConn) Write(packet []byte) (int, error) {
	select {
	case <-c.closed:
		return 0, net.ErrClosed
	default:
	}
	copyOfPacket := append([]byte(nil), packet...)
	select {
	case c.writes <- copyOfPacket:
		return len(packet), nil
	case <-c.closed:
		return 0, net.ErrClosed
	}
}

func (c *waarpDNSConn) Close() error {
	c.closeOnce.Do(func() { close(c.closed) })
	return nil
}
func (*waarpDNSConn) LocalAddr() net.Addr                { return &net.UDPAddr{} }
func (*waarpDNSConn) RemoteAddr() net.Addr               { return &net.UDPAddr{Port: 53} }
func (*waarpDNSConn) SetDeadline(time.Time) error        { return nil }
func (*waarpDNSConn) SetReadDeadline(time.Time) error    { return nil }
func (*waarpDNSConn) SetWriteDeadline(time.Time) error   { return nil }

type waarpDNSDial struct {
	ctx  context.Context
	conn *waarpDNSConn
}

type waarpDNSDialer struct {
	calls  atomic.Int32
	dialed chan waarpDNSDial
	make   func(context.Context, int32) (*waarpDNSConn, error)
	tcp    func(context.Context) (net.Conn, error)
}

func (d *waarpDNSDialer) DialContext(ctx context.Context, network string, address M.Socksaddr) (net.Conn, error) {
	if address.String() != "192.0.2.1:53" {
		return nil, errors.New("DNS replay changed its destination")
	}
	if network == "tcp" && d.tcp != nil {
		return d.tcp(ctx)
	}
	if network != "udp" {
		return nil, errors.New("unexpected DNS network")
	}
	number := d.calls.Add(1)
	var conn *waarpDNSConn
	var err error
	if d.make != nil {
		conn, err = d.make(ctx, number)
	} else {
		conn = waarpNewDNSConn(nil)
	}
	if err != nil {
		return nil, err
	}
	d.dialed <- waarpDNSDial{ctx: ctx, conn: conn}
	return conn, nil
}
func (*waarpDNSDialer) ListenPacket(context.Context, M.Socksaddr) (net.PacketConn, error) {
	return nil, errors.New("unexpected packet listener")
}

func waarpNewUDPTransport(t *testing.T, factory func(context.Context, int32) (*waarpDNSConn, error)) (*UDPTransport, *waarpDNSDialer, func()) {
	t.Helper()
	logger := log.NewNOPFactory().Logger()
	dialer := &waarpDNSDialer{dialed: make(chan waarpDNSDial, 64), make: factory}
	transport := NewUDPRaw(logger, boxDNS.NewTransportAdapter(C.DNSTypeUDP, "waarp-reset", nil),
		dialer, M.ParseSocksaddr("192.0.2.1:53"))
	scope := adapter.NewScope(context.Background(), logger)
	if err := transport.Start(adapter.StartStateStart, scope); err != nil {
		t.Fatal(err)
	}
	closeTransport := func() { scope.Close() }
	t.Cleanup(closeTransport)
	return transport, dialer, closeTransport
}

func waarpWait[T any](t *testing.T, channel <-chan T) T {
	t.Helper()
	select {
	case value := <-channel:
		return value
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for a deterministic DNS test event")
		var zero T
		return zero
	}
}

func waarpWrite(t *testing.T, conn *waarpDNSConn) *mDNS.Msg {
	t.Helper()
	var request mDNS.Msg
	if err := request.Unpack(waarpWait(t, conn.writes)); err != nil {
		t.Fatal(err)
	}
	return &request
}

func waarpAnswer(t *testing.T, conn *waarpDNSConn, request *mDNS.Msg, octet byte) {
	t.Helper()
	response := new(mDNS.Msg)
	response.SetReply(request)
	response.Answer = []mDNS.RR{&mDNS.A{
		Hdr: mDNS.RR_Header{Name: request.Question[0].Name, Rrtype: mDNS.TypeA, Class: mDNS.ClassINET},
		A: net.IPv4(192, 0, 2, octet),
	}}
	packet, err := response.Pack()
	if err != nil {
		t.Fatal(err)
	}
	conn.reads <- waarpDNSRead{packet: packet}
}

func waarpQuestion(name string, id uint16) *mDNS.Msg {
	message := new(mDNS.Msg)
	message.SetQuestion(name, mDNS.TypeA)
	message.Id = id
	return message
}

type waarpDNSResult struct {
	response *mDNS.Msg
	err      error
}

func waarpBegin(transport *UDPTransport, ctx context.Context, message *mDNS.Msg, async bool) (<-chan waarpDNSResult, *atomic.Int32) {
	results := make(chan waarpDNSResult, 4)
	calls := new(atomic.Int32)
	finish := func(response *mDNS.Msg, err error) {
		calls.Add(1)
		results <- waarpDNSResult{response, err}
	}
	if async {
		transport.ExchangeAsync(ctx, message, finish)
	} else {
		go func() { finish(transport.Exchange(ctx, message)) }()
	}
	return results, calls
}

func waarpCheckAnswer(t *testing.T, result waarpDNSResult, request *mDNS.Msg, octet byte) {
	t.Helper()
	if result.err != nil {
		t.Fatal(result.err)
	}
	if result.response == nil || result.response.Id != request.Id || len(result.response.Question) != 1 ||
		result.response.Question[0] != request.Question[0] || len(result.response.Answer) != 1 {
		t.Fatalf("response identity changed: %#v", result.response)
	}
	answer, ok := result.response.Answer[0].(*mDNS.A)
	if !ok || !answer.A.Equal(net.IPv4(192, 0, 2, octet)) {
		t.Fatalf("wrong DNS answer: %#v", result.response.Answer)
	}
}

func waarpCheckDrained(t *testing.T, transport *UDPTransport) {
	t.Helper()
	multiplexer := transport.multiplexer
	multiplexer.queryAccess.Lock()
	pending := len(multiplexer.queries)
	multiplexer.queryAccess.Unlock()
	pool := multiplexer.connection
	pool.access.Lock()
	var users, waiters int
	if pool.state != nil {
		users, waiters = pool.state.sharedUsers, pool.state.sharedWaiters
	}
	pool.access.Unlock()
	if pending != 0 || users != 0 || waiters != 0 {
		t.Fatalf("leaked query ownership: pending=%d sharedUsers=%d waiters=%d", pending, users, waiters)
	}
}

func TestWaarpUDPResetPendingQuery(t *testing.T) {
	for _, async := range []bool{false, true} {
		name := "sync"
		if async {
			name = "async"
		}
		t.Run(name, func(t *testing.T) {
			transport, dialer, closeTransport := waarpNewUDPTransport(t, nil)
			ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
			defer cancel()
			deadline, _ := ctx.Deadline()
			message := waarpQuestion("reset.example.", 0x8123)
			result, callbacks := waarpBegin(transport, ctx, message, async)
			seen := make(map[uint16]bool)
			for attempt := 0; attempt <= udpConnectionResetRetries; attempt++ {
				dial := waarpWait(t, dialer.dialed)
				actualDeadline, ok := dial.ctx.Deadline()
				if !ok || !actualDeadline.Equal(deadline) {
					t.Fatal("a replay changed the original deadline")
				}
				request := waarpWrite(t, dial.conn)
				if seen[request.Id] {
					t.Fatal("replay reused a wire query ID")
				}
				seen[request.Id] = true
				if attempt < udpConnectionResetRetries {
					transport.Reset()
					waarpWait(t, dial.conn.closed)
				} else {
					waarpAnswer(t, dial.conn, request, 42)
				}
			}
			waarpCheckAnswer(t, waarpWait(t, result), message, 42)
			waarpCheckDrained(t, transport)
			closeTransport()
			if callbacks.Load() != 1 || dialer.calls.Load() != int32(udpConnectionResetRetries+1) {
				t.Fatalf("callbacks=%d dials=%d", callbacks.Load(), dialer.calls.Load())
			}
		})
	}
}

func TestWaarpUDPReadCloseBeforePoolReset(t *testing.T) {
	transport, dialer, _ := waarpNewUDPTransport(t, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	message := waarpQuestion("read-close.example.", 0x9134)
	result, callbacks := waarpBegin(transport, ctx, message, true)
	first := waarpWait(t, dialer.dialed)
	waarpWrite(t, first.conn)
	first.conn.Close() // Model CloseAll before DNSTransport.Reset.
	second := waarpWait(t, dialer.dialed)
	waarpWrite(t, second.conn)
	transport.Reset()
	third := waarpWait(t, dialer.dialed)
	request := waarpWrite(t, third.conn)
	waarpAnswer(t, third.conn, request, 43)
	waarpCheckAnswer(t, waarpWait(t, result), message, 43)
	waarpCheckDrained(t, transport)
	if callbacks.Load() != 1 || dialer.calls.Load() != 3 {
		t.Fatalf("callbacks=%d dials=%d", callbacks.Load(), dialer.calls.Load())
	}
}

func TestWaarpUDPResetBudgetIsBounded(t *testing.T) {
	t.Run("pending-resets", func(t *testing.T) {
		transport, dialer, closeTransport := waarpNewUDPTransport(t, nil)
		ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
		defer cancel()
		result, callbacks := waarpBegin(transport, ctx, waarpQuestion("budget.example.", 0x1234), true)
		for attempt := 0; attempt <= udpConnectionResetRetries; attempt++ {
			dial := waarpWait(t, dialer.dialed)
			waarpWrite(t, dial.conn)
			transport.Reset()
		}
		failed := waarpWait(t, result)
		if !errors.Is(failed.err, errConnPoolReset) || !errors.Is(failed.err, net.ErrClosed) {
			t.Fatalf("expected an exhausted transient reset, got %v", failed.err)
		}
		waarpCheckDrained(t, transport)
		closeTransport()
		if callbacks.Load() != 1 || dialer.calls.Load() != int32(udpConnectionResetRetries+1) {
			t.Fatalf("unbounded recovery: callbacks=%d dials=%d", callbacks.Load(), dialer.calls.Load())
		}
	})
	t.Run("cached-write-errors", func(t *testing.T) {
		transport, dialer, closeTransport := waarpNewUDPTransport(t, nil)
		ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
		defer cancel()
		var failWrites atomic.Bool
		var failedWrites atomic.Int32
		originalWrite := transport.multiplexer.options.write
		transport.multiplexer.options.write = func(conn net.Conn, message *mDNS.Msg, queryID uint16) error {
			if failWrites.Load() {
				failedWrites.Add(1)
				return net.ErrClosed
			}
			return originalWrite(conn, message, queryID)
		}
		warmMessage := waarpQuestion("warm-budget.example.", 19)
		warmResult, _ := waarpBegin(transport, ctx, warmMessage, true)
		dial := waarpWait(t, dialer.dialed)
		warmRequest := waarpWrite(t, dial.conn)
		waarpAnswer(t, dial.conn, warmRequest, 40)
		waarpCheckAnswer(t, waarpWait(t, warmResult), warmMessage, 40)
		waarpCheckDrained(t, transport)

		// The first attempt reuses the healthy cached socket. Every write then
		// fails: the multiplexer must not hide a fourth attempt from UDP's budget.
		failWrites.Store(true)
		result, callbacks := waarpBegin(transport, ctx, waarpQuestion("write-budget.example.", 20), true)
		if failed := waarpWait(t, result); !errors.Is(failed.err, net.ErrClosed) {
			t.Fatalf("expected exhausted closed-socket recovery, got %v", failed.err)
		}
		waarpCheckDrained(t, transport)
		closeTransport()
		if failedWrites.Load() != 3 || dialer.calls.Load() != 3 || callbacks.Load() != 1 {
			t.Fatalf("cached write bypassed budget: writes=%d dials=%d callbacks=%d",
				failedWrites.Load(), dialer.calls.Load(), callbacks.Load())
		}
	})
}

func TestWaarpUDPResetHonorsCancellation(t *testing.T) {
	transport, dialer, closeTransport := waarpNewUDPTransport(t, nil)
	ctx, cancel := context.WithCancel(context.Background())
	result, callbacks := waarpBegin(transport, ctx, waarpQuestion("cancel.example.", 10), true)
	dial := waarpWait(t, dialer.dialed)
	waarpWrite(t, dial.conn)
	cancel()
	transport.Reset()
	failed := waarpWait(t, result)
	if !errors.Is(failed.err, context.Canceled) {
		t.Fatalf("expected original cancellation, got %v", failed.err)
	}
	closeTransport()
	waarpCheckDrained(t, transport)
	if callbacks.Load() != 1 || dialer.calls.Load() != 1 {
		t.Fatalf("canceled query replayed: callbacks=%d dials=%d", callbacks.Load(), dialer.calls.Load())
	}
}

func TestWaarpUDPResetKeepsOriginalDeadline(t *testing.T) {
	transport, dialer, closeTransport := waarpNewUDPTransport(t, nil)
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	deadline, _ := ctx.Deadline()
	result, callbacks := waarpBegin(transport, ctx, waarpQuestion("deadline.example.", 11), true)
	first := waarpWait(t, dialer.dialed)
	waarpWrite(t, first.conn)
	transport.Reset()
	second := waarpWait(t, dialer.dialed)
	waarpWrite(t, second.conn) // No reply on the new connection.
	if actual, ok := second.ctx.Deadline(); !ok || !actual.Equal(deadline) {
		t.Fatal("reset extended the query deadline")
	}
	if failed := waarpWait(t, result); !errors.Is(failed.err, context.DeadlineExceeded) {
		t.Fatalf("expected the original deadline, got %v", failed.err)
	}
	closeTransport()
	waarpCheckDrained(t, transport)
	if callbacks.Load() != 1 || dialer.calls.Load() != 2 {
		t.Fatalf("deadline replayed: callbacks=%d dials=%d", callbacks.Load(), dialer.calls.Load())
	}
}

func TestWaarpUDPCloseCancelsAndJoinsReplayDial(t *testing.T) {
	entered, exited := make(chan struct{}), make(chan struct{})
	transport, dialer, closeTransport := waarpNewUDPTransport(t, func(ctx context.Context, number int32) (*waarpDNSConn, error) {
		if number == 2 {
			close(entered)
			<-ctx.Done()
			close(exited)
			return nil, ctx.Err()
		}
		return waarpNewDNSConn(nil), nil
	})
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	result, callbacks := waarpBegin(transport, ctx, waarpQuestion("off.example.", 12), true)
	first := waarpWait(t, dialer.dialed)
	waarpWrite(t, first.conn)
	transport.Reset()
	waarpWait(t, entered)
	closed := make(chan struct{})
	go func() { closeTransport(); close(closed) }()
	waarpWait(t, closed)
	select {
	case <-exited:
	default:
		t.Fatal("transport close returned before its replay dial stopped")
	}
	if failed := waarpWait(t, result); !errors.Is(failed.err, net.ErrClosed) {
		t.Fatalf("expected terminal close, got %v", failed.err)
	}
	transport.Reset() // Terminal close cannot be turned back into a reset.
	afterClose, afterCallbacks := waarpBegin(transport, context.Background(), waarpQuestion("after-off.example.", 13), true)
	if failed := waarpWait(t, afterClose); !errors.Is(failed.err, net.ErrClosed) || errors.Is(failed.err, errConnPoolReset) {
		t.Fatalf("closed transport was reopened: %v", failed.err)
	}
	waarpCheckDrained(t, transport)
	if callbacks.Load() != 1 || afterCallbacks.Load() != 1 || dialer.calls.Load() != 2 {
		t.Fatalf("OFF resurrected work: callbacks=%d after=%d dials=%d", callbacks.Load(), afterCallbacks.Load(), dialer.calls.Load())
	}
}

func TestWaarpUDPResetRejectsRetiredConnectionReply(t *testing.T) {
	releaseOldRead, allowSecondDial := make(chan struct{}), make(chan struct{})
	secondEntered := make(chan struct{})
	var releaseOnce sync.Once
	defer releaseOnce.Do(func() { close(releaseOldRead) })
	transport, dialer, _ := waarpNewUDPTransport(t, func(ctx context.Context, number int32) (*waarpDNSConn, error) {
		if number == 1 {
			return waarpNewDNSConn(releaseOldRead), nil
		}
		if number == 2 {
			close(secondEntered)
			select {
			case <-allowSecondDial:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		return waarpNewDNSConn(nil), nil
	})
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	message := waarpQuestion("identity.example.", 0xbeef)
	result, _ := waarpBegin(transport, ctx, message, true)
	first := waarpWait(t, dialer.dialed)
	oldRequest := waarpWrite(t, first.conn)
	waarpAnswer(t, first.conn, oldRequest, 41)
	waarpWait(t, first.conn.readHeld)
	transport.Reset()
	waarpWait(t, secondEntered)
	// Force a 16-bit ID wrap/reuse; the connection generation must also match.
	transport.multiplexer.queryAccess.Lock()
	transport.multiplexer.queryId = oldRequest.Id - 1
	transport.multiplexer.queryAccess.Unlock()
	close(allowSecondDial)
	second := waarpWait(t, dialer.dialed)
	newRequest := waarpWrite(t, second.conn)
	if newRequest.Id != oldRequest.Id {
		t.Fatal("test did not exercise a reused wire ID")
	}
	releaseOnce.Do(func() { close(releaseOldRead) })
	waarpWait(t, first.conn.readAgain) // Old response passed through recvLoop.
	select {
	case early := <-result:
		t.Fatalf("retired response consumed the new query: %#v", early)
	default:
	}
	waarpAnswer(t, second.conn, newRequest, 42)
	waarpCheckAnswer(t, waarpWait(t, result), message, 42)
	waarpCheckDrained(t, transport)
}

func TestWaarpUDPResetPreservesConcurrentQueries(t *testing.T) {
	const count = 12
	transport, dialer, _ := waarpNewUDPTransport(t, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	results := make([]<-chan waarpDNSResult, count)
	callbacks := make([]*atomic.Int32, count)
	messages := make([]*mDNS.Msg, count)
	for i := range messages {
		messages[i] = waarpQuestion(string(rune('a'+i))+".concurrent.example.", uint16(0x4000+i))
		results[i], callbacks[i] = waarpBegin(transport, ctx, messages[i], true)
	}
	first := waarpWait(t, dialer.dialed)
	for range count {
		waarpWrite(t, first.conn)
	}
	transport.Reset()
	second := waarpWait(t, dialer.dialed)
	requests := make([]*mDNS.Msg, count)
	for i := range requests {
		requests[i] = waarpWrite(t, second.conn)
	}
	for i := count - 1; i >= 0; i-- {
		waarpAnswer(t, second.conn, requests[i], 42)
	}
	for i := range results {
		waarpCheckAnswer(t, waarpWait(t, results[i]), messages[i], 42)
		if callbacks[i].Load() != 1 {
			t.Fatalf("query %d completed %d times", i, callbacks[i].Load())
		}
	}
	waarpCheckDrained(t, transport)
	if dialer.calls.Load() != 2 {
		t.Fatalf("reset did not reuse the replacement connection: %d dials", dialer.calls.Load())
	}
}

func TestWaarpUDPDoesNotRetryOtherReadErrors(t *testing.T) {
	transport, dialer, closeTransport := waarpNewUDPTransport(t, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	result, _ := waarpBegin(transport, ctx, waarpQuestion("non-reset.example.", 14), true)
	dial := waarpWait(t, dialer.dialed)
	waarpWrite(t, dial.conn)
	dial.conn.reads <- waarpDNSRead{err: io.ErrUnexpectedEOF}
	if failed := waarpWait(t, result); !errors.Is(failed.err, io.ErrUnexpectedEOF) {
		t.Fatalf("unexpected failure: %v", failed.err)
	}
	closeTransport()
	waarpCheckDrained(t, transport)
	if dialer.calls.Load() != 1 {
		t.Fatalf("non-reset error replayed: %d dials", dialer.calls.Load())
	}
}

func TestWaarpUDPResetDuringDialUsesSameBudget(t *testing.T) {
	entered := make(chan context.Context, 8)
	transport, dialer, closeTransport := waarpNewUDPTransport(t, func(ctx context.Context, _ int32) (*waarpDNSConn, error) {
		entered <- ctx
		<-ctx.Done()
		return nil, ctx.Err()
	})
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	deadline, _ := ctx.Deadline()
	result, callbacks := waarpBegin(transport, ctx, waarpQuestion("dial-budget.example.", 15), true)
	for attempt := 0; attempt <= udpConnectionResetRetries; attempt++ {
		dialCtx := waarpWait(t, entered)
		if actual, ok := dialCtx.Deadline(); !ok || !actual.Equal(deadline) {
			t.Fatal("reset while dialing changed the original deadline")
		}
		transport.Reset()
	}
	if failed := waarpWait(t, result); !errors.Is(failed.err, errConnPoolReset) {
		t.Fatalf("expected reset budget exhaustion while dialing, got %v", failed.err)
	}
	closeTransport()
	waarpCheckDrained(t, transport)
	if callbacks.Load() != 1 || dialer.calls.Load() != int32(udpConnectionResetRetries+1) {
		t.Fatalf("pool reacquisition bypassed retry budget: callbacks=%d dials=%d", callbacks.Load(), dialer.calls.Load())
	}
}

func TestWaarpUDPClosePendingQueryDoesNotReplay(t *testing.T) {
	transport, dialer, closeTransport := waarpNewUDPTransport(t, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	result, callbacks := waarpBegin(transport, ctx, waarpQuestion("pending-off.example.", 16), true)
	dial := waarpWait(t, dialer.dialed)
	waarpWrite(t, dial.conn)
	closeTransport()
	waarpWait(t, dial.conn.closed)
	failed := waarpWait(t, result)
	if !errors.Is(failed.err, net.ErrClosed) || errors.Is(failed.err, errConnPoolReset) {
		t.Fatalf("terminal close was mistaken for a reset: %v", failed.err)
	}
	waarpCheckDrained(t, transport)
	if callbacks.Load() != 1 || dialer.calls.Load() != 1 {
		t.Fatalf("pending query resurrected after OFF: callbacks=%d dials=%d", callbacks.Load(), dialer.calls.Load())
	}
}

func TestWaarpUDPRetiredCancellationCannotConsumeReusedID(t *testing.T) {
	transport, dialer, _ := waarpNewUDPTransport(t, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	oldCtx, cancelOld := context.WithCancel(ctx)
	defer cancelOld()
	firstMessage := waarpQuestion("first-identity.example.", 17)
	firstResult, _ := waarpBegin(transport, oldCtx, firstMessage, true)
	dial := waarpWait(t, dialer.dialed)
	firstRequest := waarpWrite(t, dial.conn)
	transport.multiplexer.queryAccess.Lock()
	retired := transport.multiplexer.queries[firstRequest.Id]
	transport.multiplexer.queryAccess.Unlock()
	if retired == nil {
		t.Fatal("missing first pending query")
	}
	waarpAnswer(t, dial.conn, firstRequest, 41)
	waarpCheckAnswer(t, waarpWait(t, firstResult), firstMessage, 41)
	transport.multiplexer.queryAccess.Lock()
	transport.multiplexer.queryId = firstRequest.Id - 1
	transport.multiplexer.queryAccess.Unlock()
	secondMessage := waarpQuestion("second-identity.example.", 18)
	secondResult, _ := waarpBegin(transport, ctx, secondMessage, true)
	secondRequest := waarpWrite(t, dial.conn)
	if secondRequest.Id != firstRequest.Id {
		t.Fatal("test did not reuse the wire ID on the same connection")
	}
	cancelOld()
	// Model an AfterFunc already running when take stopped it: it can execute
	// after a later query reuses both the wire ID and the same connection.
	transport.multiplexer.completeContextDone(firstRequest.Id, oldCtx, retired)
	select {
	case early := <-secondResult:
		t.Fatalf("retired cancellation consumed the new query: %#v", early)
	default:
	}
	waarpAnswer(t, dial.conn, secondRequest, 42)
	waarpCheckAnswer(t, waarpWait(t, secondResult), secondMessage, 42)
	waarpCheckDrained(t, transport)
	if dialer.calls.Load() != 1 {
		t.Fatal("test did not exercise the same connection")
	}
}

func TestWaarpUDPRetiredWriteCannotConsumeReusedID(t *testing.T) {
	transport, dialer, _ := waarpNewUDPTransport(t, nil)
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	oldCtx, cancelOld := context.WithCancel(ctx)
	defer cancelOld()
	multiplexer := transport.multiplexer
	originalWrite := multiplexer.options.write
	releaseOldWrite := make(chan struct{})
	attemptReturned := make(chan struct{})
	var releaseOnce sync.Once
	defer releaseOnce.Do(func() { close(releaseOldWrite) })
	var writes atomic.Int32
	multiplexer.options.write = func(conn net.Conn, message *mDNS.Msg, queryID uint16) error {
		if writes.Add(1) != 1 {
			return originalWrite(conn, message, queryID)
		}
		if err := originalWrite(conn, message, queryID); err != nil {
			return err
		}
		<-releaseOldWrite
		return io.ErrUnexpectedEOF
	}
	firstMessage := waarpQuestion("retired-writer.example.", 21)
	firstResult := make(chan waarpDNSResult, 4)
	var firstCallbacks atomic.Int32
	go func() {
		// Call the production attempt directly so its return is a barrier after
		// the late write-error branch, not merely after the wrapped Write call.
		multiplexer.exchangeAsync(oldCtx, firstMessage, func(response *mDNS.Msg, err error) {
			firstCallbacks.Add(1)
			firstResult <- waarpDNSResult{response, err}
		}, true)
		close(attemptReturned)
	}()
	dial := waarpWait(t, dialer.dialed)
	firstRequest := waarpWrite(t, dial.conn)
	cancelOld()
	if failed := waarpWait(t, firstResult); !errors.Is(failed.err, context.Canceled) {
		t.Fatalf("expected first query cancellation, got %v", failed.err)
	}
	multiplexer.queryAccess.Lock()
	multiplexer.queryId = firstRequest.Id - 1
	multiplexer.queryAccess.Unlock()
	secondMessage := waarpQuestion("current-writer.example.", 22)
	secondResult, secondCallbacks := waarpBegin(transport, ctx, secondMessage, true)
	secondRequest := waarpWrite(t, dial.conn)
	if secondRequest.Id != firstRequest.Id {
		t.Fatal("test did not reuse the wire ID on the same connection")
	}
	releaseOnce.Do(func() { close(releaseOldWrite) })
	waarpWait(t, attemptReturned)
	if firstCallbacks.Load() != 1 {
		t.Fatalf("retired writer completed the old query %d times", firstCallbacks.Load())
	}
	select {
	case <-dial.conn.closed:
		t.Fatal("retired writer invalidated the current query's connection")
	default:
	}
	select {
	case early := <-secondResult:
		t.Fatalf("retired writer consumed the current query: %#v", early)
	default:
	}
	waarpAnswer(t, dial.conn, secondRequest, 42)
	waarpCheckAnswer(t, waarpWait(t, secondResult), secondMessage, 42)
	waarpCheckDrained(t, transport)
	if firstCallbacks.Load() != 1 || secondCallbacks.Load() != 1 || dialer.calls.Load() != 1 {
		t.Fatalf("retired writer changed ownership: old=%d new=%d dials=%d",
			firstCallbacks.Load(), secondCallbacks.Load(), dialer.calls.Load())
	}
}

func TestWaarpUDPCloseCancelsTCPFallback(t *testing.T) {
	transport, dialer, closeTransport := waarpNewUDPTransport(t, nil)
	client, server := net.Pipe()
	t.Cleanup(func() { client.Close(); server.Close() })
	var tcpCalls atomic.Int32
	dialer.tcp = func(context.Context) (net.Conn, error) {
		tcpCalls.Add(1)
		// A plain net.Pipe supports deadlines but exposes no optional
		// NeedAdditionalReadDeadline hook: cancellation must close it anyway.
		return client, nil
	}
	peerRequest := make(chan waarpDNSResult, 1)
	peerClosed := make(chan error, 1)
	go func() {
		request, err := ReadMessage(server)
		peerRequest <- waarpDNSResult{request, err}
		if err != nil {
			peerClosed <- err
			return
		}
		var buffer [1]byte
		_, err = server.Read(buffer[:]) // Consume the request, then stay silent.
		peerClosed <- err
	}()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	message := waarpQuestion("tcp-off.example.", 23)
	result, callbacks := waarpBegin(transport, ctx, message, true)
	dial := waarpWait(t, dialer.dialed)
	request := waarpWrite(t, dial.conn)
	truncated := new(mDNS.Msg)
	truncated.SetReply(request)
	truncated.Truncated = true
	packet, err := truncated.Pack()
	if err != nil {
		t.Fatal(err)
	}
	dial.conn.reads <- waarpDNSRead{packet: packet}
	actual := waarpWait(t, peerRequest)
	if actual.err != nil || actual.response == nil || actual.response.Id != message.Id ||
		len(actual.response.Question) != 1 || actual.response.Question[0] != message.Question[0] {
		t.Fatalf("invalid TCP fallback request: %#v, %v", actual.response, actual.err)
	}
	closeTransport()
	if failed := waarpWait(t, result); !errors.Is(failed.err, net.ErrClosed) {
		t.Fatalf("TCP fallback did not end with terminal close: %v", failed.err)
	}
	if err := waarpWait(t, peerClosed); !errors.Is(err, io.EOF) {
		t.Fatalf("silent TCP peer did not observe connection close: %v", err)
	}
	waarpCheckDrained(t, transport)
	if callbacks.Load() != 1 || dialer.calls.Load() != 1 || tcpCalls.Load() != 1 {
		t.Fatalf("OFF replayed fallback: callbacks=%d UDP dials=%d TCP dials=%d",
			callbacks.Load(), dialer.calls.Load(), tcpCalls.Load())
	}
}
