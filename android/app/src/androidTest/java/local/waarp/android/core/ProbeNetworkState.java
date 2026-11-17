// SPDX-License-Identifier: GPL-3.0-or-later
package local.waarp.android.core;

import java.io.IOException;
import java.net.InetAddress;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.LongSupplier;

/** One default-network callback stream; pure Java so transition checks run on the host. */
final class ProbeNetworkState {
    static final long TIMEOUT_MS = 10_000;

    private final LongSupplier clock;
    private final long startedElapsedMs;
    private final long deadlineElapsedMs;
    private long networkHandle;
    private boolean capabilitiesSeen, vpn, linkPropertiesSeen, blockedSeen, blocked = true;
    private String interfaceName = "";
    private InetAddress[] addresses = new InetAddress[0];
    private long availableElapsedMs = -1, capabilitiesElapsedMs = -1;
    private long linkPropertiesElapsedMs = -1, blockedElapsedMs = -1;
    private long lastLostHandle;
    private int availableCallbacks, lostCallbacks, ignoredCallbacks;

    ProbeNetworkState(LongSupplier clock) {
        this.clock = clock;
        startedElapsedMs = clock.getAsLong();
        deadlineElapsedMs = startedElapsedMs + TIMEOUT_MS;
    }

    synchronized void onAvailable(long handle) {
        if (handle == 0) throw new IllegalArgumentException("A network handle must be present");
        reset();
        networkHandle = handle;
        availableElapsedMs = clock.getAsLong();
        availableCallbacks++;
        notifyAll();
    }

    synchronized void onCapabilitiesChanged(long handle, boolean isVpn) {
        if (!isCurrent(handle)) return;
        capabilitiesSeen = true;
        vpn = isVpn;
        capabilitiesElapsedMs = clock.getAsLong();
        notifyAll();
    }

    synchronized void onLinkPropertiesChanged(long handle, String name, InetAddress[] values) {
        if (!isCurrent(handle)) return;
        linkPropertiesSeen = true;
        interfaceName = name == null ? "" : name;
        // Addresses are retained only in memory for an equality observation, never serialized.
        addresses = Arrays.stream(values).filter(value -> value != null).toArray(InetAddress[]::new);
        linkPropertiesElapsedMs = clock.getAsLong();
        notifyAll();
    }

    synchronized void onBlockedStatusChanged(long handle, boolean isBlocked) {
        if (!isCurrent(handle)) return;
        blockedSeen = true;
        blocked = isBlocked;
        blockedElapsedMs = clock.getAsLong();
        notifyAll();
    }

    synchronized void onLost(long handle) {
        lostCallbacks++;
        lastLostHandle = handle;
        if (!isCurrent(handle)) return;
        reset();
        notifyAll();
    }

    private boolean isCurrent(long handle) {
        if (networkHandle != 0 && handle == networkHandle) return true;
        ignoredCallbacks++;
        return false;
    }

    private void reset() {
        networkHandle = 0;
        capabilitiesSeen = vpn = linkPropertiesSeen = blockedSeen = false;
        blocked = true;
        interfaceName = "";
        addresses = new InetAddress[0];
        availableElapsedMs = capabilitiesElapsedMs = linkPropertiesElapsedMs = blockedElapsedMs = -1;
    }

    synchronized Snapshot awaitReady() throws IOException, InterruptedException {
        while (true) {
            long now = clock.getAsLong();
            long remaining = deadlineElapsedMs - now;
            if (remaining <= 0) throw new IOException("Complete VPN callback state was not ready within ten seconds");
            Snapshot value = snapshotAt(now);
            if (value.ready) return value;
            // Loss/replacement can invalidate a complete snapshot before this thread resumes.
            // Never turn a past ready event into an irreversible CountDownLatch success.
            wait(remaining);
        }
    }

    synchronized Snapshot snapshot() { return snapshotAt(clock.getAsLong()); }

    private Snapshot snapshotAt(long now) {
        return new Snapshot(networkHandle, capabilitiesSeen, vpn, linkPropertiesSeen, blockedSeen, blocked,
                interfaceName, addresses, startedElapsedMs, deadlineElapsedMs, now, availableElapsedMs,
                capabilitiesElapsedMs, linkPropertiesElapsedMs, blockedElapsedMs,
                lastLostHandle, availableCallbacks, lostCallbacks, ignoredCallbacks);
    }

    static final class Snapshot {
        final long networkHandle;
        final String interfaceName;
        final boolean ready;
        private final InetAddress[] addresses;
        private final Map<String, Object> scalars;

        Snapshot(long handle, boolean capabilitiesSeen, boolean vpn, boolean linkPropertiesSeen,
                 boolean blockedSeen, boolean blocked, String name, InetAddress[] values,
                 long started, long deadline, long now, long availableAt, long capabilitiesAt,
                 long linkAt, long blockedAt, long lostHandle, int availableCount, int lostCount, int ignoredCount) {
            networkHandle = handle;
            interfaceName = name;
            addresses = values.clone();
            ready = handle != 0 && capabilitiesSeen && vpn && linkPropertiesSeen
                    && !name.isEmpty() && addresses.length > 0 && blockedSeen && !blocked;
            scalars = new LinkedHashMap<>();
            scalars.put("networkHandle", handle);
            scalars.put("capabilitiesSeen", capabilitiesSeen);
            scalars.put("vpn", vpn);
            scalars.put("linkPropertiesSeen", linkPropertiesSeen);
            scalars.put("interfacePresent", !name.isEmpty());
            scalars.put("linkAddressCount", addresses.length);
            scalars.put("blockedSeen", blockedSeen);
            scalars.put("blocked", blocked);
            scalars.put("ready", ready);
            scalars.put("startedElapsedMs", started);
            scalars.put("deadlineElapsedMs", deadline);
            scalars.put("snapshotElapsedMs", now);
            scalars.put("availableElapsedMs", availableAt);
            scalars.put("capabilitiesElapsedMs", capabilitiesAt);
            scalars.put("linkPropertiesElapsedMs", linkAt);
            scalars.put("blockedElapsedMs", blockedAt);
            scalars.put("lastLostHandle", lostHandle);
            scalars.put("availableCallbacks", availableCount);
            scalars.put("lostCallbacks", lostCount);
            scalars.put("ignoredCallbacks", ignoredCount);
        }

        String localAddressMatches(InetAddress local) {
            if (local == null || local.isAnyLocalAddress() || addresses.length == 0) return "unknown";
            for (InetAddress address : addresses) if (address.equals(local)) return "true";
            return "false";
        }

        Map<String, Object> safeScalars() { return new LinkedHashMap<>(scalars); }
    }
}
