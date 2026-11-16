package local.waarp.android.acceptance;

import android.app.Instrumentation;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.os.Bundle;
import android.os.SystemClock;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;

final class AcceptanceHarness {
    final Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
    final Bundle arguments = InstrumentationRegistry.getArguments();
    final ReleaseUi ui = new ReleaseUi(instrumentation);
    final TrafficProbe probe = new TrafficProbe(instrumentation.getContext());
    final DeviceObserver observer;
    final JSONObject report = new JSONObject();
    final JSONArray events = new JSONArray();
    final File output;
    final String mode;
    final String profileName;
    private long firstTraffic = -1;
    private long lastTraffic = -1;
    private int rounds;
    private long bytes;
    private final long started = SystemClock.elapsedRealtime();

    AcceptanceHarness(String mode) throws Exception {
        this.mode = mode;
        profileName = "Acceptance AWG2 " + mode;
        output = new File(instrumentation.getContext().getExternalFilesDir(null), "release-acceptance");
        TrafficProbe.require(output.isDirectory() || output.mkdirs(), "evidence_directory");
        observer = new DeviceObserver(instrumentation, arguments);
        PackageInfo target = instrumentation.getContext().getPackageManager().getPackageInfo(ReleaseUi.TARGET, 0);
        ApplicationInfo application = target.applicationInfo;
        TrafficProbe.require(application != null && (application.flags & ApplicationInfo.FLAG_DEBUGGABLE) == 0, "target_must_be_nondebuggable_release");
        int ownUid = instrumentation.getContext().getApplicationInfo().uid;
        TrafficProbe.require(application.uid != ownUid, "probe_requires_independent_uid");
        TrafficProbe.require(ReleaseUi.TARGET.equals(target.packageName) && !target.versionName.contains("debug"), "release_package_identity");
        report.put("schemaVersion", 1).put("mode", mode).put("targetPackage", target.packageName)
                .put("targetVersion", target.versionName).put("targetVersionCode", target.getLongVersionCode())
                .put("targetDebuggable", false).put("targetUid", application.uid).put("probeUid", ownUid)
                .put("probePackage", instrumentation.getContext().getPackageName()).put("independentUid", true)
                .put("observer", observer.capabilities()).put("events", events).put("passed", false);
        writeReport();
    }

    void setup() throws Exception {
        observer.resetTarget();
        ui.launchTarget();
        String profile = probe.createProfile();
        try { ui.importProfile(profileName, profile); } finally { profile = null; }
        ui.configureFixtureRouting(profileName);
        ui.addSelectedAppRoute(profileName);
        ui.startVpn(probe);
        exchange(10000);
        screenshot("01-release-connected");
        event("setup", new JSONObject().put("uiImport", true).put("selectedAppRoute", true)
                .put("lanDirect", false).put("systemDnsExplicitAwg", true).put("vpnConsent", true));
    }

    JSONObject exchange(int timeoutMs) throws Exception {
        JSONObject exchange = probe.exchange(timeoutMs);
        long at = exchange.getLong("elapsedRealtimeMs");
        if (firstTraffic < 0) firstTraffic = at;
        lastTraffic = at; rounds++; bytes += exchange.getLong("httpBytes");
        append("release-" + mode + "-traffic.jsonl", exchange);
        return exchange;
    }

    JSONObject recoverTraffic(long timeoutMs) throws Exception {
        long deadline = SystemClock.elapsedRealtime() + timeoutMs;
        int attempts = 0;
        Exception last = null;
        while (SystemClock.elapsedRealtime() < deadline) {
            attempts++;
            if (probe.vpnActive()) {
                try { return exchange(5000).put("recoveryAttempts", attempts); }
                catch (java.io.IOException failure) { last = failure; }
            }
            SystemClock.sleep(500);
        }
        throw new AssertionError("bounded_traffic_recovery_timeout:" + (last == null ? "vpn_absent" : last.getClass().getSimpleName()));
    }

    void event(String name, JSONObject facts) throws Exception {
        events.put(new JSONObject().put("name", name).put("elapsedRealtimeMs", SystemClock.elapsedRealtime()).put("facts", facts));
        writeReport();
    }

    void complete() throws Exception {
        report.put("passed", true); writeReport();
    }

    void failure(Throwable failure) {
        try {
            report.put("passed", false).put("failureClass", failure.getClass().getSimpleName())
                    .put("failure", redact(String.valueOf(failure.getMessage())));
            screenshot("failure-release-" + mode);
            ByteArrayOutputStream hierarchy = new ByteArrayOutputStream();
            ui.device.dumpWindowHierarchy(hierarchy);
            write("failure-release-" + mode + ".xml", redact(hierarchy.toString(StandardCharsets.UTF_8.name())));
            writeReport();
        } catch (Exception ignored) { /* preserve the original failing gate */ }
    }

    void emergencyCleanup() {
        try { observer.shell("dumpsys deviceidle unforce"); } catch (Exception ignored) { }
        try { observer.shell("dumpsys battery reset"); } catch (Exception ignored) { }
        try { ui.device.wakeUp(); } catch (Exception ignored) { }
        try { observer.shell("am force-stop " + ReleaseUi.TARGET); } catch (Exception ignored) { }
    }

    void writeReport() throws Exception {
        report.put("elapsedMs", SystemClock.elapsedRealtime() - started).put("successfulRounds", rounds)
                .put("httpBytes", bytes).put("firstTrafficElapsedMs", firstTraffic).put("lastTrafficElapsedMs", lastTraffic)
                .put("trafficSpanMs", firstTraffic < 0 ? 0 : lastTraffic - firstTraffic);
        write("release-" + mode + ".json", report.toString(2) + "\n");
    }

    void screenshot(String name) { TrafficProbe.require(ui.device.takeScreenshot(new File(output, name + ".png")), "screenshot_failed"); }

    void append(String file, JSONObject value) throws Exception {
        try (FileOutputStream stream = new FileOutputStream(new File(output, file), true)) {
            stream.write((value.toString() + "\n").getBytes(StandardCharsets.UTF_8));
            stream.getFD().sync();
        }
    }

    private void write(String file, String value) throws Exception {
        File temporary = new File(output, file + ".tmp");
        try (FileOutputStream stream = new FileOutputStream(temporary)) {
            stream.write(value.getBytes(StandardCharsets.UTF_8)); stream.getFD().sync();
        }
        TrafficProbe.require(temporary.renameTo(new File(output, file)), "evidence_atomic_replace");
    }

    static String redact(String input) {
        return input.replaceAll("(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{43}=(?![A-Za-z0-9+/])", "[redacted-key]")
                .replaceAll("(?i)(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])", "[redacted-key]");
    }
}
