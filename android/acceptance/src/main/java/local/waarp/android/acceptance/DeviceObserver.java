package local.waarp.android.acceptance;

import android.app.Instrumentation;
import android.os.Bundle;
import android.os.ParcelFileDescriptor;
import android.os.SystemClock;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Read-only proc/meminfo observations, except explicit disposable-device events. */
final class DeviceObserver {
    private final Instrumentation instrumentation;
    final boolean requireProc;
    private String rootPrefix;

    DeviceObserver(Instrumentation instrumentation, Bundle arguments) throws Exception {
        this.instrumentation = instrumentation;
        requireProc = Boolean.parseBoolean(arguments.getString("requireProcMetrics", "true"));
        TrafficProbe.require("true".equals(arguments.getString("allowTargetReset")), "explicit_disposable_reset_argument_required");
        TrafficProbe.require("1".equals(shell("getprop ro.kernel.qemu").trim()), "acceptance_requires_disposable_emulator");
        String build = shell("getprop ro.build.type").trim();
        TrafficProbe.require("userdebug".equals(build) || "eng".equals(build), "disposable_userdebug_required");
        if ("0".equals(shell("id -u").trim())) rootPrefix = "";
        else if ("0".equals(shell("su 0 id -u").trim())) rootPrefix = "su 0 ";
        if (requireProc) TrafficProbe.require(rootPrefix != null, "root_observer_unavailable");
    }

    JSONObject capabilities() throws Exception {
        return new JSONObject().put("disposableEmulator", true).put("rootAvailable", rootPrefix != null)
                .put("observerUid", rootPrefix == null ? shell("id -u").trim() : root("id -u").trim())
                .put("rootTransport", rootPrefix == null ? "unavailable" : rootPrefix.isEmpty() ? "uiautomation" : "userdebug-su")
                .put("requiredProcMetrics", requireProc);
    }

    void resetTarget() throws Exception {
        TrafficProbe.require(shell("pm clear " + ReleaseUi.TARGET).trim().equals("Success"), "target_reset_failed");
        if (android.os.Build.VERSION.SDK_INT >= 33) {
            shell("cmd locale set-app-locales " + ReleaseUi.TARGET + " --user 0 --locales ru-RU");
            TrafficProbe.require(shell("cmd locale get-app-locales " + ReleaseUi.TARGET + " --user 0")
                    .contains("ru-RU"), "fixture_locale_unavailable");
        }
    }

    int pid() throws Exception {
        String value = shell("pidof " + ReleaseUi.TARGET).trim();
        if (value.isEmpty()) return -1;
        TrafficProbe.require(value.matches("[0-9]{1,8}"), "target_pid_ambiguous");
        return Integer.parseInt(value);
    }

    void killForRestoration(int expectedPid) throws Exception {
        TrafficProbe.require(rootPrefix != null && expectedPid > 1 && pid() == expectedPid, "process_kill_identity");
        TrafficProbe.require("0".equals(root("id -u").trim()), "process_kill_requires_root_observer");
        root("kill -9 " + expectedPid);
    }

    JSONObject sample() throws Exception {
        int targetPid = pid();
        TrafficProbe.require(targetPid > 1, "resource_target_not_running");
        String memory = shell("dumpsys meminfo " + targetPid);
        long pss = number(memory, "(?m)^\\s*TOTAL PSS:\\s*(\\d+)", -1);
        if (pss < 0) pss = number(memory, "(?m)^\\s*TOTAL\\s+(\\d+)", -1);
        long javaHeap = heapAllocated(memory, "Dalvik Heap");
        long nativeHeap = heapAllocated(memory, "Native Heap");
        TrafficProbe.require(pss > 0 && javaHeap >= 0 && nativeHeap >= 0, "meminfo_required_fields_unavailable");
        JSONObject sample = new JSONObject().put("elapsedRealtimeMs", SystemClock.elapsedRealtime())
                .put("unixMs", System.currentTimeMillis()).put("pid", targetPid).put("pssKb", pss)
                .put("javaHeapAllocatedKb", javaHeap).put("nativeHeapAllocatedKb", nativeHeap)
                .put("javaHeapPssKb", number(memory, "(?m)^\\s*Java Heap:\\s*(\\d+)", -1))
                .put("nativeHeapPssKb", number(memory, "(?m)^\\s*Native Heap:\\s*(\\d+)", -1));
        boolean procAvailable = rootPrefix != null;
        if (procAvailable) {
            String status = root("cat /proc/" + targetPid + "/status");
            long threads = number(status, "(?m)^Threads:\\s*(\\d+)", -1);
            long rss = number(status, "(?m)^VmRSS:\\s*(\\d+)\\s+kB", -1);
            String descriptors = root("ls -1 /proc/" + targetPid + "/fd").trim();
            procAvailable = threads > 0 && rss > 0 && descriptors.matches("[0-9]+(?:\\s+[0-9]+)*");
            if (procAvailable) sample.put("threads", threads).put("rssKb", rss).put("fds", descriptors.split("\\s+").length);
        }
        sample.put("procAvailable", procAvailable);
        if (requireProc) TrafficProbe.require(procAvailable, "proc_metrics_unavailable");
        TrafficProbe.require(pid() == targetPid, "process_changed_during_resource_sample");
        return sample;
    }

    String root(String command) throws Exception {
        TrafficProbe.require(rootPrefix != null, "root_observer_required");
        // UiAutomation uses Runtime.exec(String), not shell quote parsing.
        // These fixed argv tokens contain only source literals/validated PIDs.
        TrafficProbe.require(command.matches("[A-Za-z0-9_ /.-]+"), "root_observer_command_tokens");
        return shell(rootPrefix + command);
    }

    String shell(String command) throws Exception {
        ParcelFileDescriptor descriptor = instrumentation.getUiAutomation().executeShellCommand(command);
        try (InputStream input = new ParcelFileDescriptor.AutoCloseInputStream(descriptor);
             ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[8192];
            for (int count; (count = input.read(buffer)) >= 0;) {
                TrafficProbe.require(output.size() + count <= 2 * 1024 * 1024, "shell_evidence_size_limit");
                output.write(buffer, 0, count);
            }
            return output.toString(StandardCharsets.UTF_8.name());
        }
    }

    private static long number(String input, String regex, long missing) {
        Matcher match = Pattern.compile(regex).matcher(input);
        return match.find() ? Long.parseLong(match.group(1)) : missing;
    }

    private static long heapAllocated(String input, String name) {
        Matcher line = Pattern.compile("(?m)^\\s*" + Pattern.quote(name) + "\\s+([0-9 ]+)\\s*$").matcher(input);
        if (!line.find()) return -1;
        String[] values = line.group(1).trim().split("\\s+");
        return values.length >= 3 ? Long.parseLong(values[values.length - 2]) : -1;
    }
}
