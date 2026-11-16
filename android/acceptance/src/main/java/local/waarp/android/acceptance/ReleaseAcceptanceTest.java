package local.waarp.android.acceptance;

import android.os.SystemClock;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.filters.LargeTest;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
@LargeTest
public final class ReleaseAcceptanceTest {
    @Test public void realReleaseUiTunnelLifecycleAndProcessRestoration() throws Throwable {
        AcceptanceHarness h = new AcceptanceHarness("smoke");
        boolean complete = false;
        try {
            h.setup();
            JSONArray resources = new JSONArray().put(h.observer.sample());
            h.ui.stopVpn(h.probe);
            h.probe.requireInnerTrafficBlocked(2500);
            h.event("off", new JSONObject().put("vpnAbsent", true).put("innerReplyBlocked", true));

            h.ui.startVpn(h.probe);
            h.exchange(10000);
            h.event("onAgain", new JSONObject().put("encryptedDnsAndHttp", true));

            String renamed = "Acceptance AWG2 renamed";
            h.ui.rename(h.profileName, renamed);
            h.recoverTraffic(30000);
            h.event("edit", new JSONObject().put("renamedThroughUi", true).put("trafficAfterEdit", true));

            h.ui.launchProbe();
            h.ui.device.pressHome();
            TrafficProbe.require(!ReleaseUi.TARGET.equals(h.ui.device.getCurrentPackageName()), "target_not_background");
            h.exchange(10000);
            h.event("background", new JSONObject().put("targetNotForeground", true).put("encryptedDnsAndHttp", true));

            int previousPid = h.observer.pid();
            long killedAt = SystemClock.elapsedRealtime();
            h.observer.killForRestoration(previousPid);
            int restoredPid = -1;
            long deadline = killedAt + 90000;
            while (SystemClock.elapsedRealtime() < deadline) {
                int current = h.observer.pid();
                if (current > 1 && current != previousPid) { restoredPid = current; break; }
                SystemClock.sleep(250);
            }
            TrafficProbe.require(restoredPid > 1 && restoredPid != previousPid, "process_restart_new_pid_timeout");
            h.recoverTraffic(Math.max(1000, deadline - SystemClock.elapsedRealtime()));
            h.event("processRestoration", new JSONObject().put("oldPid", previousPid).put("newPid", restoredPid)
                    .put("targetRelaunchedByTestBeforeRecovery", false).put("newPidObserved", true)
                    .put("recoveryMs", SystemClock.elapsedRealtime() - killedAt).put("encryptedDnsAndHttp", true));

            h.ui.launchTarget();
            h.ui.navigate("Туннели"); h.ui.waitText(renamed, 15000);
            h.ui.navigate("Маршруты"); h.ui.waitText(ReleaseUi.PROBE_LABEL, 15000);
            resources.put(h.observer.sample());
            h.screenshot("02-release-restored");
            h.event("persistedState", new JSONObject().put("renamedProfileRestored", true).put("selectedRouteRestored", true));

            h.ui.deleteAssignedProfile(renamed);
            h.probe.requireInnerTrafficBlocked(2500);
            h.screenshot("03-release-blocked-after-delete");
            h.event("deleteAssignedProfile", new JSONObject().put("blockedUi", true).put("explicitNoReassignment", true).put("innerReplyBlocked", true));
            h.ui.deleteRoute();
            h.ui.stopVpn(h.probe);
            h.probe.requireInnerTrafficBlocked(2500);
            h.screenshot("04-release-finished-off");
            h.event("cleanup", new JSONObject().put("routeDeletedThroughUi", true).put("vpnAbsent", true));
            requireExplicitOffSurvivesProcessDeath(h);
            h.report.put("resourceSamples", resources).put("minifiedReleaseBlackBox", true);
            h.complete(); complete = true;
        } catch (Throwable failure) {
            h.failure(failure); throw failure;
        } finally {
            if (!complete) h.emergencyCleanup();
        }
    }

    private void requireExplicitOffSurvivesProcessDeath(AcceptanceHarness h) throws Exception {
        h.ui.launchProbe();
        h.ui.device.pressHome();
        TrafficProbe.require(!ReleaseUi.TARGET.equals(h.ui.device.getCurrentPackageName()), "off_target_not_background");
        int oldPid = h.observer.pid();
        long killedAt = SystemClock.elapsedRealtime();
        h.observer.killForRestoration(oldPid);
        // Observe the actual SIGKILL before beginning the full absence window.
        // A different PID during this interval is already an unintended restart.
        while (true) {
            int pid = h.observer.pid();
            if (pid == -1) break;
            TrafficProbe.require(pid == oldPid, "explicit_off_process_restarted");
            TrafficProbe.require(SystemClock.elapsedRealtime() - killedAt < 5000, "explicit_off_process_death_timeout");
            SystemClock.sleep(100);
        }
        long first = -1, last = -1;
        int samples = 0;
        while (true) {
            int pid = h.observer.pid();
            boolean vpn = h.probe.vpnActive();
            long observedAt = SystemClock.elapsedRealtime();
            h.append("release-smoke-off-observations.jsonl", new JSONObject()
                    .put("elapsedRealtimeMs", observedAt).put("pid", pid).put("vpnActive", vpn));
            TrafficProbe.require(pid == -1, "explicit_off_process_restarted");
            TrafficProbe.require(!vpn, "explicit_off_vpn_restarted");
            if (first < 0) first = observedAt;
            last = observedAt; samples++;
            if (last - first >= 90000) break;
            SystemClock.sleep(1000);
        }
        h.probe.requireInnerTrafficBlocked(2500);
        h.event("explicitOffRemainsStopped", new JSONObject().put("oldPid", oldPid)
                .put("killedAtElapsedMs", killedAt).put("firstAbsentElapsedMs", first).put("lastAbsentElapsedMs", last)
                .put("observationSpanMs", last - first).put("sampleCount", samples)
                .put("targetRelaunchedByTestBeforeObservationEnds", false)
                .put("noProcessRestart", true).put("vpnAbsent", true).put("innerReplyBlocked", true));
    }
}
