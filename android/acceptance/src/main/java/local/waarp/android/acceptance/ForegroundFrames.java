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
        trace.put("attempted", true).put("startAttempted", false).put("available", false).put("remotePath", path)
                .put("maxDurationMs", TRACE_LIMIT_MS).put("bufferBytes", 16 * 1024 * 1024)
                .put("startedElapsedMs", SystemClock.elapsedRealtime());
        try {
            CommandResult helpResult = commandWithExit("trace-help", "perfetto --help");
            trace.put("helpExitCode", helpResult.exitCode);
            TrafficProbe.require(helpResult.exitCode == 0 && !helpResult.output.trim().isEmpty(), "trace_help_failed");
            String help = helpResult.output;
            // The flag is selected from this actual image's advertised CLI;
            // there is no failed-start retry on older Perfetto versions.
            boolean waitForSources = help.contains("--background-wait");
            String startMode = waitForSources ? "--background-wait" : "--background";
            String command = "perfetto " + startMode + " --out " + path
                    + " --time 180s --buffer 16mb --app " + ReleaseUi.TARGET
                    + " sched freq idle am wm gfx view binder_driver dalvik input";
            trace.put("command", command).put("startMode", startMode)
                    .put("sourceReadinessAcknowledged", false).put("startAttempted", true);
            CommandResult startedCommand = commandWithExit("trace-start", command);
            String output = startedCommand.output;
            trace.put("startExitCode", startedCommand.exitCode);
            // --background-wait can print the child PID before reporting a
            // failed readiness ACK. Keep a verified child identity for cleanup,
            // but never infer readiness from the numeric PID alone.
            Matcher reported = Pattern.compile("(?m)^([0-9]{1,8})$").matcher(output.trim());
            if (reported.find()) {
                int candidate = Integer.parseInt(reported.group(1));
                if (!reported.find() && candidate > 1 && candidate != targetPid) {
                    tracePid = candidate;
                    traceIdentity = processIdentity(tracePid);
                }
            }
            TrafficProbe.require(startedCommand.exitCode == 0, "trace_start_command_failed");
            TrafficProbe.require(output.trim().matches("[0-9]{1,8}"), "trace_start_pid_missing");
            tracePid = Integer.parseInt(output.trim());
            TrafficProbe.require(tracePid > 1 && tracePid != targetPid, "trace_start_pid_invalid");
            traceIdentity = processIdentity(tracePid);
            TrafficProbe.require(traceIdentity != null, "trace_start_process_missing");
            trace.put("pid", tracePid).put("started", true)
                    .put("startAcknowledgedElapsedMs", SystemClock.elapsedRealtime())
                    .put("sourceReadinessAcknowledged", waitForSources);
        } catch (Exception | AssertionError failure) {
            String error = AcceptanceHarness.redact(String.valueOf(failure));
            trace.put("started", false).put("error", error).put("startError", error);
            stopTrace(); // stop only our captured PID/starttime; no retry
        }
    }

    private static final class CommandResult {
        final String output;
        final int exitCode;
        CommandResult(String output, int exitCode) { this.output = output; this.exitCode = exitCode; }
    }

    private CommandResult commandWithExit(String suffix, String command) throws Exception {
        TrafficProbe.require(command.matches("[A-Za-z0-9_ /.-]+"), "trace_command_tokens");
        String stem = "foreground-" + phase + "-" + suffix;
        // UiAutomation's Runtime.exec tokenization is not shell quoting. Use
        // this acceptance-owned fixed script, retaining its bytes and output.
        harness.write(stem + ".sh", "#!/system/bin/sh\n" + command + " 2>&1\n"
                + "waarp_trace_command_status=$?\n"
                + "printf '\\nWAARP_TRACE_COMMAND_EXIT=%s\\n' \"$waarp_trace_command_status\"\n"
                + "exit \"$waarp_trace_command_status\"\n");
        String script = new java.io.File(harness.output, stem + ".sh").getAbsolutePath();
        String raw = harness.observer.root("sh " + script);
        harness.write(stem + ".txt", raw);
        Matcher result = Pattern.compile("(?s)^(.*)\\nWAARP_TRACE_COMMAND_EXIT=([0-9]{1,3})\\n?$").matcher(raw);
        TrafficProbe.require(raw.indexOf("WAARP_TRACE_COMMAND_EXIT=") == raw.lastIndexOf("WAARP_TRACE_COMMAND_EXIT=")
                && result.matches(), "trace_command_exit_status_missing_or_ambiguous");
        int exit = Integer.parseInt(result.group(2));
        TrafficProbe.require(exit <= 255, "trace_command_exit_status_invalid");
        return new CommandResult(result.group(1), exit);
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
            boolean started = trace.optBoolean("started", false);
            trace.put("cleanupCompleted", true).put("completed", started).put("available", started)
                    .put("finishedElapsedMs", SystemClock.elapsedRealtime());
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
