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
            TrafficProbe.require(restoredPid > 1 && restoredPid != previousPid, "sticky_restart_new_pid_timeout");
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
            h.report.put("resourceSamples", resources).put("minifiedReleaseBlackBox", true);
            h.complete(); complete = true;
        } catch (Throwable failure) {
            h.failure(failure); throw failure;
        } finally {
            if (!complete) h.emergencyCleanup();
        }
    }
}
