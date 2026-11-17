// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.core;

import java.io.IOException;
import java.net.InetAddress;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;

/** Host-only transitions for the exact callback state used by the independent probe UID. */
public final class ProbeNetworkStateChecks {
    private static int checks;

    public static void main(String[] arguments) throws Exception {
        incompleteThenReady();
        blockedState();
        lostReplacedAndStaleCallbacks();
        sameHandleUpdates();
        originalDeadline();
        waiterWakeupAndInterrupt();
        System.out.println("ProbeNetworkState: " + checks + " host check groups passed");
    }

    private static void incompleteThenReady() throws Exception {
        Fixture fixture = new Fixture();
        ProbeNetworkState state = fixture.state;
        state.onCapabilitiesChanged(1, true); // A callback without onAvailable cannot seed state.
        require(!state.snapshot().ready, "Unowned capabilities made the network ready");
        state.onAvailable(1);
        state.onCapabilitiesChanged(1, true);
        require(!state.snapshot().ready, "Capabilities alone made the network ready");
        state.onLinkPropertiesChanged(1, "tun0", addresses(10));
        require(!state.snapshot().ready, "Missing blocked-state callback was treated as false");
        state.onBlockedStatusChanged(1, false);
        ProbeNetworkState.Snapshot ready = state.awaitReady();
        require(ready.ready && ready.networkHandle == 1, "Complete ordered VPN snapshot was rejected");
        require("true".equals(ready.localAddressMatches(address(10))), "Ready address equality observation failed");
        require("false".equals(ready.localAddressMatches(address(11))), "A different local address matched");
        require("unknown".equals(ready.localAddressMatches(null)), "Missing local address was represented as a measurement");
        for (Map.Entry<String, Object> entry : ready.safeScalars().entrySet()) {
            require(entry.getValue() instanceof Number || entry.getValue() instanceof Boolean,
                    "Non-scalar/private value entered safe diagnostics");
        }
        checks++;
    }

    private static void blockedState() throws Exception {
        Fixture fixture = new Fixture();
        ProbeNetworkState state = fixture.state;
        available(state, 1, false);
        require(state.snapshot().ready, "Initial unblocked snapshot failed");
        state.onBlockedStatusChanged(1, true);
        require(!state.snapshot().ready, "Blocking did not invalidate prior readiness");
        state.onBlockedStatusChanged(1, false);
        require(state.awaitReady().ready, "Unblocking the current VPN did not restore readiness");
        state.onCapabilitiesChanged(1, false);
        require(!state.snapshot().ready, "A non-VPN default network satisfied the VPN gate");
        checks++;
    }

    private static void lostReplacedAndStaleCallbacks() throws Exception {
        Fixture fixture = new Fixture();
        ProbeNetworkState state = fixture.state;
        available(state, 1, false);
        state.onLost(1);
        require(!state.snapshot().ready && state.snapshot().networkHandle == 0, "Loss retained the old ready snapshot");
        state.onCapabilitiesChanged(1, true);
        state.onLinkPropertiesChanged(1, "tun0", addresses(10));
        state.onBlockedStatusChanged(1, false);
        require(!state.snapshot().ready, "Retired callbacks revived a lost network");
        state.onAvailable(2);
        state.onCapabilitiesChanged(2, true);
        state.onLinkPropertiesChanged(1, "tun0", addresses(10));
        state.onBlockedStatusChanged(1, false);
        require(!state.snapshot().ready, "Replacement consumed the previous network's properties");
        state.onLinkPropertiesChanged(2, "tun1", addresses(11));
        state.onBlockedStatusChanged(2, false);
        state.onLost(1);
        ProbeNetworkState.Snapshot ready = state.awaitReady();
        require(ready.networkHandle == 2 && ready.ready, "Late old onLost invalidated its replacement");
        checks++;
    }

    private static void sameHandleUpdates() throws Exception {
        Fixture fixture = new Fixture();
        ProbeNetworkState state = fixture.state;
        available(state, 7, false);
        ProbeNetworkState.Snapshot before = state.awaitReady();
        state.onLinkPropertiesChanged(7, null, addresses(11));
        require(!state.snapshot().ready, "Missing interface retained readiness");
        state.onLinkPropertiesChanged(7, "tun1", new InetAddress[0]);
        require(!state.snapshot().ready, "Missing link addresses retained readiness");
        InetAddress[] changedAddresses = addresses(11);
        state.onLinkPropertiesChanged(7, "tun1", changedAddresses);
        changedAddresses[0] = address(12);
        ProbeNetworkState.Snapshot after = state.awaitReady();
        require(after.ready && after.networkHandle == 7 && "tun1".equals(after.interfaceName),
                "Same-handle LinkProperties handover was rejected");
        require("true".equals(after.localAddressMatches(address(11)))
                        && "true".equals(before.localAddressMatches(address(10))),
                "Callback/address mutation changed an immutable snapshot");
        state.onAvailable(7);
        require(!state.snapshot().ready, "Repeated onAvailable retained incomplete older fields");
        state.onCapabilitiesChanged(7, true);
        state.onLinkPropertiesChanged(7, "tun1", addresses(11));
        state.onBlockedStatusChanged(7, false);
        require(state.awaitReady().ready, "Repeated same-handle initial snapshot failed");
        state.onLost(7);
        available(state, 7, false);
        require(state.awaitReady().ready, "A previously lost handle was permanently excluded");
        checks++;
    }

    private static void originalDeadline() throws Exception {
        Fixture fixture = new Fixture();
        require(ProbeNetworkState.TIMEOUT_MS == 10_000, "The original ten-second gate changed");
        fixture.now.set(10_999);
        available(fixture.state, 1, false);
        require(fixture.state.awaitReady().ready, "Ready within the original deadline was rejected");
        fixture.now.set(11_000);
        fixture.state.onLost(1);
        available(fixture.state, 2, false);
        require(fixture.state.snapshot().safeScalars().get("deadlineElapsedMs").equals(11_000L),
                "Replacement reset the deadline");
        try {
            fixture.state.awaitReady();
            throw new AssertionError("Late complete callbacks escaped the original deadline");
        } catch (IOException expected) { /* Readiness did not extend the one fixed deadline. */ }
        checks++;
    }

    private static void waiterWakeupAndInterrupt() throws Exception {
        runWaiter(false);
        runWaiter(true);
        checks++;
    }

    private static void runWaiter(boolean interrupt) throws Exception {
        CountDownLatch entered = new CountDownLatch(1), finished = new CountDownLatch(1);
        AtomicReference<Thread> waiter = new AtomicReference<>();
        AtomicReference<Object> outcome = new AtomicReference<>();
        ProbeNetworkState state = new ProbeNetworkState(() -> {
            if (Thread.currentThread() == waiter.get()) entered.countDown();
            return System.nanoTime() / 1_000_000;
        });
        available(state, 1, true);
        Thread thread = new Thread(() -> {
            try { outcome.set(state.awaitReady()); }
            catch (Throwable failure) { outcome.set(failure); }
            finally { finished.countDown(); }
        }, "probe-network-state-host-waiter");
        thread.setDaemon(true);
        waiter.set(thread);
        thread.start();
        try {
            require(entered.await(2, TimeUnit.SECONDS), "Waiter never entered the gate");
            require(outcome.get() == null, "Blocked waiter completed before a state change");
            if (interrupt) thread.interrupt();
            else state.onBlockedStatusChanged(1, false);
            require(finished.await(2, TimeUnit.SECONDS), "Waiter ignored its state change or interruption");
            if (interrupt) require(outcome.get() instanceof InterruptedException, "Interruption was swallowed or treated as success");
            else require(outcome.get() instanceof ProbeNetworkState.Snapshot
                            && ((ProbeNetworkState.Snapshot) outcome.get()).ready,
                    "Unblocked waiter did not return the current ready snapshot");
        } finally {
            thread.interrupt();
            thread.join(2_000);
            require(!thread.isAlive(), "Host waiter did not terminate");
        }
    }

    private static void available(ProbeNetworkState state, long handle, boolean blocked) throws Exception {
        state.onAvailable(handle);
        state.onCapabilitiesChanged(handle, true);
        state.onLinkPropertiesChanged(handle, "tun0", addresses(10));
        state.onBlockedStatusChanged(handle, blocked);
    }

    private static InetAddress address(int last) throws Exception {
        return InetAddress.getByAddress(new byte[] {(byte) 192, 0, 2, (byte) last});
    }

    private static InetAddress[] addresses(int last) throws Exception { return new InetAddress[] {address(last)}; }

    private static void require(boolean value, String message) {
        if (!value) throw new AssertionError(message);
    }

    private static final class Fixture {
        final AtomicLong now = new AtomicLong(1_000);
        final ProbeNetworkState state = new ProbeNetworkState(now::get);
    }
}
