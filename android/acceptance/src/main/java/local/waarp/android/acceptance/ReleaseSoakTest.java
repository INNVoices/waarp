package local.waarp.android.acceptance;

import android.os.PowerManager;
import android.os.SystemClock;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.filters.LargeTest;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.io.IOException;
import java.util.Set;

@RunWith(AndroidJUnit4.class)
@LargeTest
public final class ReleaseSoakTest {
    @Test public void twoHoursEncryptedTrafficResourcesAndRecovery() throws Throwable {
        AcceptanceHarness h = new AcceptanceHarness("soak");
        boolean complete = false;
        try {
            long duration = Long.parseLong(h.arguments.getString("durationSeconds", "0"));
            long interval = Long.parseLong(h.arguments.getString("intervalSeconds", "15"));
            TrafficProbe.require(duration >= 7200 && duration <= 10800, "soak_duration_must_be_7200_to_10800_seconds");
            TrafficProbe.require(interval >= 10 && interval <= 30, "soak_interval_must_be_10_to_30_seconds");
            TrafficProbe.require(h.observer.requireProc, "soak_requires_proc_metrics");
            h.report.put("requestedDurationSeconds", duration).put("intervalSeconds", interval).put("warmupSeconds", 300);
            h.setup();
            h.observeForegroundNavigation();
            h.ui.launchProbe(); h.ui.device.pressHome();
            TrafficProbe.require(!ReleaseUi.TARGET.equals(h.ui.device.getCurrentPackageName()), "soak_target_must_be_background");

            long steadyStart = h.exchange(10000).getLong("elapsedRealtimeMs");
            long deadline = steadyStart + duration * 1000;
            long nextRound = steadyStart + interval * 1000;
            long nextSample = steadyStart;
            ResourceBudget budget = new ResourceBudget();
            boolean screen = false, doze = false, network = false;
            h.report.put("steadyStartedElapsedMs", steadyStart);
            while (SystemClock.elapsedRealtime() < deadline) {
                long now = SystemClock.elapsedRealtime();
                if (now >= nextSample) {
                    sample(h, budget, steadyStart);
                    nextSample = SystemClock.elapsedRealtime() + 60000;
                    h.writeReport(); // durable progress, including before an external timeout
                }
                long elapsed = now - steadyStart;
                if (!screen && elapsed >= duration * 1000 / 4) {
                    screenOff(h, interval); screen = true;
                    nextRound = SystemClock.elapsedRealtime() + interval * 1000;
                } else if (!doze && elapsed >= duration * 1000 / 2) {
                    doze(h, interval); doze = true;
                    nextRound = SystemClock.elapsedRealtime() + interval * 1000;
                } else if (!network && elapsed >= duration * 3000 / 4) {
                    networkLoss(h); network = true;
                    nextRound = SystemClock.elapsedRealtime() + interval * 1000;
                } else if (now >= nextRound) {
                    h.exchange(10000); // every normal round must succeed; no hidden retries
                    nextRound = Math.max(nextRound + interval * 1000, SystemClock.elapsedRealtime());
                }
                SystemClock.sleep(Math.min(500, Math.max(1, Math.min(nextRound, deadline) - SystemClock.elapsedRealtime())));
            }
            JSONObject finalExchange = h.exchange(10000);
            long measured = finalExchange.getLong("elapsedRealtimeMs") - steadyStart;
            TrafficProbe.require(measured >= duration * 1000, "real_traffic_span_too_short");
            TrafficProbe.require(screen && doze && network, "required_recovery_phase_missing");
            sample(h, budget, steadyStart);
            h.writeReport();
            int requiredRounds = (int) Math.floor((double) duration / interval * 0.9);
            TrafficProbe.require(h.report.getInt("successfulRounds") >= requiredRounds, "insufficient_unique_traffic_rounds");
            h.report.put("steadyElapsedMs", measured).put("requiredSuccessfulRounds", requiredRounds)
                    .put("resources", budget.finish()).put("screenOffRecovery", screen).put("dozeRecovery", doze)
                    .put("physicalNetworkRecovery", network).put("normalTrafficFailures", 0);
            h.ui.device.wakeUp(); h.observer.shell("wm dismiss-keyguard"); h.ui.launchTarget();
            h.ui.navigate("Главная"); h.ui.waitText("Выключить", 15000);
            h.screenshot("02-release-soak-finished-connected");
            h.ui.stopVpn(h.probe); h.probe.requireInnerTrafficBlocked(2500);
            h.event("cleanup", new JSONObject().put("vpnAbsent", true).put("innerReplyBlocked", true));
            h.complete(); complete = true;
        } catch (Throwable failure) {
            h.failure(failure); throw failure;
        } finally { if (!complete) h.emergencyCleanup(); }
    }

    private static void sample(AcceptanceHarness h, ResourceBudget budget, long steadyStart) throws Exception {
        JSONObject sample = h.observer.sample();
        boolean warm = sample.getLong("elapsedRealtimeMs") - steadyStart >= 300000;
        sample.put("afterWarmup", warm);
        h.append("release-soak-resources.jsonl", sample);
        budget.accept(sample, warm);
    }

    private static void screenOff(AcceptanceHarness h, long interval) throws Exception {
        PowerManager power = h.instrumentation.getContext().getSystemService(PowerManager.class);
        h.ui.device.pressHome(); h.ui.device.sleep();
        try {
            waitUntil(() -> !power.isInteractive(), 5000, "screen_off_not_observed");
            for (int round = 0; round < 3; round++) {
                TrafficProbe.require(!power.isInteractive(), "screen_woke_during_off_phase");
                h.exchange(10000);
                if (round != 2) SystemClock.sleep(interval * 1000);
            }
        } finally { h.ui.device.wakeUp(); h.observer.shell("wm dismiss-keyguard"); }
        h.recoverTraffic(30000);
        h.event("screenOff", new JSONObject().put("screenOffObserved", true).put("successfulRoundsWhileOff", 3)
                .put("recoveryTraffic", true).put("targetBackground", true));
    }

    private static void doze(AcceptanceHarness h, long interval) throws Exception {
        int succeeded = 0;
        JSONArray expectedFailures = new JSONArray();
        h.ui.device.pressHome(); h.ui.device.sleep();
        String during;
        try {
            h.observer.shell("dumpsys battery unplug");
            h.observer.shell("dumpsys deviceidle force-idle");
            waitUntil(() -> h.observer.shell("dumpsys deviceidle get deep").trim().equals("IDLE"), 15000, "deep_doze_not_observed");
            during = h.observer.shell("dumpsys deviceidle get deep").trim();
            for (int round = 0; round < 2; round++) {
                TrafficProbe.require(h.observer.shell("dumpsys deviceidle get deep").trim().equals("IDLE"), "doze_ended_before_probe");
                if (!h.probe.vpnActive()) {
                    // Android hides a caller's active Network when that UID is
                    // blocked by Doze. Still send a real new packet and require
                    // the observed block; do not count a precondition as traffic.
                    h.probe.requireInnerTrafficBlocked(3000);
                    expectedFailures.put("CallerNetworkBlockedInDoze");
                } else {
                    try { h.exchange(3000); succeeded++; }
                    catch (IOException expectedNetworkBlock) { expectedFailures.put(expectedNetworkBlock.getClass().getSimpleName()); }
                }
                if (round == 0) SystemClock.sleep(interval * 1000);
            }
        } finally {
            h.observer.shell("dumpsys deviceidle unforce");
            h.observer.shell("dumpsys battery reset");
            h.ui.device.wakeUp(); h.observer.shell("wm dismiss-keyguard");
        }
        waitUntil(() -> !h.observer.shell("dumpsys deviceidle get deep").trim().equals("IDLE"), 10000, "deep_doze_not_released");
        h.recoverTraffic(45000);
        h.event("doze", new JSONObject().put("dozeObserved", during.equals("IDLE")).put("stateDuring", during)
                .put("attemptedRounds", 2).put("successfulRoundsWhileIdle", succeeded).put("expectedNetworkFailures", expectedFailures)
                .put("unforcedObserved", true).put("recoveryTraffic", true));
    }

    private static void networkLoss(AcceptanceHarness h) throws Exception {
        Set<String> before = h.probe.physicalNetworks();
        TrafficProbe.require(!before.isEmpty(), "physical_network_missing_before_toggle");
        String wifi = h.observer.shell("settings get global wifi_on").trim();
        String mobile = h.observer.shell("settings get global mobile_data").trim();
        TrafficProbe.require((wifi.equals("0") || wifi.equals("1")) && (mobile.equals("0") || mobile.equals("1")), "network_restore_state_unknown");
        long disconnectedAt = SystemClock.elapsedRealtime();
        try {
            h.observer.shell("svc wifi disable"); h.observer.shell("svc data disable");
            waitUntil(() -> h.probe.physicalNetworks().isEmpty(), 25000, "physical_network_loss_not_observed");
            h.probe.requireInnerTrafficBlocked(3000);
        } finally {
            h.observer.shell("svc wifi " + (wifi.equals("1") ? "enable" : "disable"));
            h.observer.shell("svc data " + (mobile.equals("1") ? "enable" : "disable"));
        }
        waitUntil(() -> !h.probe.physicalNetworks().isEmpty(), 30000, "physical_network_did_not_return");
        JSONObject traffic = h.recoverTraffic(45000);
        Set<String> after = h.probe.physicalNetworks();
        h.event("physicalNetwork", new JSONObject().put("networkLossObserved", true).put("innerReplyBlocked", true)
                .put("beforeNetworks", new JSONArray(before)).put("afterNetworks", new JSONArray(after))
                .put("networkIdentityChanged", !before.equals(after)).put("restored", true).put("recoveryTraffic", true)
                .put("recoveryAttempts", traffic.getInt("recoveryAttempts")).put("elapsedMs", SystemClock.elapsedRealtime() - disconnectedAt));
    }

    private interface Condition { boolean ready() throws Exception; }
    private static void waitUntil(Condition condition, long timeout, String failure) throws Exception {
        long deadline = SystemClock.elapsedRealtime() + timeout;
        while (SystemClock.elapsedRealtime() < deadline) {
            if (condition.ready()) return;
            SystemClock.sleep(100);
        }
        throw new AssertionError(failure);
    }
}
