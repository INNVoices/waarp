package local.waarp.android.acceptance;

import android.os.SystemClock;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Scoped observations of the untouched release process, before any SIGKILL. */
final class ForegroundFrames implements AutoCloseable {
    private static final long TRACE_LIMIT_MS = 180000;
    private final AcceptanceHarness harness;
    private final String phase;
    private final int targetPid;
    private final JSONObject facts = new JSONObject();
    private final JSONObject trace = new JSONObject();
    private final JSONArray actions = new JSONArray();
    private int tracePid = -1;
    private String traceIdentity;
    private boolean finished;
    private boolean traceStopAttempted;

    ForegroundFrames(AcceptanceHarness harness, String phase) throws Exception {
        this.harness = harness;
        this.phase = phase;
        TrafficProbe.require(phase.matches("[a-z]+"), "foreground_phase_name");
        targetPid = harness.observer.pid();
        requireForeground();
        long started = SystemClock.elapsedRealtime();
        facts.put("phase", phase).put("pid", targetPid).put("startedElapsedMs", started)
                .put("foregroundAtStart", true).put("actions", actions).put("trace", trace)
                .put("completed", false).put("physicalDevicePerformanceApproved", false);
        harness.frames.put(facts);
        harness.writeReport();
        harness.write("foreground-" + phase + "-before.txt", gfx());
        startTrace(started);
        // System.nanoTime and HWUI Stats-since both use CLOCK_MONOTONIC.
        // Keep reset output as well as the later independent dump: a reset
        // command returning text alone is not evidence that new frames exist.
        facts.put("resetRequestedNs", System.nanoTime());
        harness.write("foreground-" + phase + "-reset.txt",
                harness.observer.shell("dumpsys gfxinfo " + ReleaseUi.TARGET + " reset"));
        facts.put("resetCompletedNs", System.nanoTime());
        harness.writeReport();
    }

    interface Action { void run() throws Exception; }

    void action(String name, Action action) throws Exception {
        requireForeground();
        JSONObject observed = new JSONObject().put("name", name).put("startedElapsedMs", SystemClock.elapsedRealtime());
        actions.put(observed);
        action.run(); // one ordinary interaction, with the existing readiness budgets
        requireForeground();
        observed.put("finishedElapsedMs", SystemClock.elapsedRealtime()).put("completed", true);
    }

    void finish() throws Exception {
        requireForeground();
        harness.write("foreground-" + phase + "-after.txt", gfx());
        requireForeground();
        facts.put("dumpCompletedNs", System.nanoTime()).put("finishedElapsedMs", SystemClock.elapsedRealtime())
                .put("foregroundAtFinish", true).put("pidAtFinish", targetPid).put("completed", true);
        stopTrace();
        finished = true;
        harness.writeReport();
    }

    private String gfx() throws Exception {
        return harness.observer.shell("dumpsys gfxinfo " + ReleaseUi.TARGET + " framestats");
    }

    private void requireForeground() throws Exception {
        TrafficProbe.require(targetPid > 1 && harness.observer.pid() == targetPid, "foreground_process_changed");
        TrafficProbe.require(ReleaseUi.TARGET.equals(harness.ui.device.getCurrentPackageName()), "foreground_target_not_visible");
    }

    private void startTrace(long started) throws Exception {
        // Only the pre-existing, explicitly disposable userdebug observer may
        // trace this synthetic fixture. No production profiling permission,
        // test hook, debuggable flag or user connection is involved.
        String path = "/data/misc/perfetto-traces/waarp-" + harness.mode + "-" + phase + "-" + targetPid + "-" + started + ".perfetto-trace";
        String command = "perfetto --background --out " + path
                + " --time 180s --buffer 16mb --app " + ReleaseUi.TARGET
                + " sched freq idle am wm gfx view binder_driver dalvik input";
        trace.put("attempted", true).put("available", false).put("remotePath", path)
                .put("maxDurationMs", TRACE_LIMIT_MS).put("bufferBytes", 16 * 1024 * 1024)
                .put("command", command).put("startedElapsedMs", SystemClock.elapsedRealtime());
        try {
            String output = harness.observer.root(command);
            harness.write("foreground-" + phase + "-trace-start.txt", output);
            TrafficProbe.require(output.trim().matches("[0-9]{1,8}"), "trace_start_pid_missing");
            tracePid = Integer.parseInt(output.trim());
            TrafficProbe.require(tracePid > 1 && tracePid != targetPid, "trace_start_pid_invalid");
            traceIdentity = processIdentity(tracePid);
            TrafficProbe.require(traceIdentity != null, "trace_start_process_missing");
            trace.put("pid", tracePid).put("started", true);
        } catch (Exception | AssertionError failure) {
            trace.put("started", false).put("error", AcceptanceHarness.redact(String.valueOf(failure)));
        }
    }

    private String processIdentity(int pid) throws Exception {
        String stat = harness.observer.root("cat /proc/" + pid + "/stat").trim();
        Matcher parsed = Pattern.compile("^([0-9]+) \\(perfetto\\) ([A-Za-z]) (.*)$").matcher(stat);
        if (!parsed.matches() || !parsed.group(1).equals(Integer.toString(pid)) || parsed.group(2).equals("Z")) return null;
        // Fields after state start at PPID (field4); starttime is field22.
        String[] fields = parsed.group(3).trim().split("\\s+");
        TrafficProbe.require(fields.length > 18 && fields[18].matches("[0-9]+"), "trace_identity_stat_invalid");
        return pid + ":" + fields[18];
    }

    private void stopTrace() throws Exception {
        if (traceStopAttempted || tracePid <= 1 || traceIdentity == null) return;
        traceStopAttempted = true;
        try {
            TrafficProbe.require(SystemClock.elapsedRealtime() - trace.getLong("startedElapsedMs") < TRACE_LIMIT_MS,
                    "trace_expired_before_ui_capture_finished");
            TrafficProbe.require(traceIdentity.equals(processIdentity(tracePid)), "trace_process_identity_changed_or_exited");
            trace.put("stopRequestedElapsedMs", SystemClock.elapsedRealtime());
            harness.write("foreground-" + phase + "-trace-stop.txt", harness.observer.root("kill -INT " + tracePid));
            long deadline = trace.getLong("stopRequestedElapsedMs") + 15000;
            while (traceIdentity.equals(processIdentity(tracePid)) && SystemClock.elapsedRealtime() < deadline) SystemClock.sleep(100);
            TrafficProbe.require(!traceIdentity.equals(processIdentity(tracePid)), "trace_flush_exit_timeout");
            TrafficProbe.require(SystemClock.elapsedRealtime() <= deadline, "trace_flush_exit_timeout");
            // Perfetto's output is copied by the host only after its writer has
            // exited. A nonempty protobuf is independently checked there.
            trace.put("completed", true).put("available", true).put("finishedElapsedMs", SystemClock.elapsedRealtime());
        } catch (Exception | AssertionError failure) {
            trace.put("completed", false).put("available", false).put("error", AcceptanceHarness.redact(String.valueOf(failure)));
        }
    }

    @Override public void close() throws Exception {
        if (!finished) {
            stopTrace();
            harness.writeReport();
        }
    }
}
