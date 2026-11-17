package local.waarp.android.acceptance;

import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Predetermined acceptance budgets; a failed run must not raise its own limits. */
final class ResourceBudget {
    private static final String[] METRICS = {"fds", "threads", "pssKb", "rssKb", "javaHeapAllocatedKb", "nativeHeapAllocatedKb"};
    private static final long[] ABSOLUTE = {512, 160, 786432, 1572864, 131072, 262144};
    private static final long[] GROWTH = {64, 32, 131072, 196608, 32768, 98304};
    private static final long[] TERMINAL_GROWTH = {16, 16, 65536, 98304, 16384, 49152};
    private final List<JSONObject> steady = new ArrayList<>();
    private final Map<String, Long> peaks = new LinkedHashMap<>();
    private int samples;
    private Integer processId;

    void accept(JSONObject sample, boolean afterWarmup) throws Exception {
        samples++;
        TrafficProbe.require(sample.getBoolean("procAvailable"), "soak_requires_real_proc_metrics");
        int pid = sample.getInt("pid");
        if (processId == null) processId = pid;
        TrafficProbe.require(processId == pid, "unexpected_process_restart_during_soak");
        for (int i = 0; i < METRICS.length; i++) {
            long value = sample.getLong(METRICS[i]);
            peaks.put(METRICS[i], Math.max(peaks.getOrDefault(METRICS[i], 0L), value));
            TrafficProbe.require(value <= ABSOLUTE[i], "resource_absolute_budget:" + METRICS[i]);
        }
        if (!afterWarmup) return;
        TrafficProbe.require(steady.size() < 200, "resource_series_capacity");
        steady.add(sample);
        if (steady.size() < 5) return;
        for (int i = 0; i < METRICS.length; i++) {
            long baseline = median(METRICS[i], steady.subList(0, 5));
            TrafficProbe.require(sample.getLong(METRICS[i]) <= baseline + GROWTH[i], "resource_growth_budget:" + METRICS[i]);
        }
    }

    JSONObject finish() throws Exception {
        TrafficProbe.require(samples >= 60 && steady.size() >= 55, "insufficient_resource_samples");
        JSONObject baseline = new JSONObject(), terminal = new JSONObject(), peakJson = new JSONObject();
        JSONObject absolute = new JSONObject(), growth = new JSONObject(), terminalLimits = new JSONObject();
        for (int i = 0; i < METRICS.length; i++) {
            String metric = METRICS[i];
            long initial = median(metric, steady.subList(0, 5));
            long last = median(metric, steady.subList(steady.size() - 5, steady.size()));
            baseline.put(metric, initial); terminal.put(metric, last); peakJson.put(metric, peaks.get(metric));
            absolute.put(metric, ABSOLUTE[i]); growth.put(metric, GROWTH[i]); terminalLimits.put(metric, TERMINAL_GROWTH[i]);
            TrafficProbe.require(last <= initial + TERMINAL_GROWTH[i], "resource_terminal_growth_budget:" + metric);
        }
        return new JSONObject().put("sampleCount", samples).put("postWarmupSampleCount", steady.size())
                .put("processIds", new JSONArray().put(processId)).put("processCount", 1).put("procAvailable", true)
                .put("baselineMedian", baseline).put("terminalMedian", terminal).put("peaks", peakJson)
                .put("absoluteCaps", absolute).put("sampleGrowthCaps", growth).put("terminalGrowthCaps", terminalLimits)
                .put("passed", true);
    }

    private static long median(String field, List<JSONObject> samples) throws Exception {
        List<Long> values = new ArrayList<>();
        for (JSONObject sample : samples) values.add(sample.getLong(field));
        Collections.sort(values); return values.get(values.size() / 2);
    }
}
