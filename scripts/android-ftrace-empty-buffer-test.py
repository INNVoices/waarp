#!/usr/bin/env python3
"""Host-only strict-contract regressions; synthetic recorder, no Android run."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("ftrace_fixture", Path(__file__).with_name("android-ftrace-prepare-test.py"))
FIXTURE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(FIXTURE)
PREP, EMPTY, IMAGE = FIXTURE.PREP, FIXTURE.PREP.EMPTY, FIXTURE.IMAGE
ROOT = "/sys/kernel/tracing"
ZERO_STATS = "entries: 0\noverrun: 0\ncommit overrun: 0\nbytes: 0\noldest event ts: 0\nnow ts: 54.639182\ndropped events: 0\nread events: 0\n"


def observer_result():
    return {"schemaVersion": 2, "passed": True, "uid": 0, "selinuxEnforcing": True,
            "selinuxContext": "u:r:su:s0", "pidNamespacesCompiledOut": True,
            "procHidepid": 2, "procGid": 3009, "procVisibilityVerified": True,
            "processes": 100, "threads": 900, "uniqueTables": 110, "sharedThreads": 790,
            "kcmpDeniedFullScans": 2, "descriptorCounts": [3000, 3000],
            "descriptorMetadataReads": [3000, 3000], "descriptorReconciliations": 0, "markerWriters": 66,
            "stableTracefsProjection": True,
            "nonTraceComparisonDifferences": {"withinPass": {"added": 0, "removed": 0, "replaced": 0},
                                             "betweenPass": {"added": 0, "removed": 0, "replaced": 0}},
            "passes": 2, "stableTaskInventories": 3, "unknownDescriptors": 0, "forbiddenTracefsDescriptors": 0,
            "membarrier": {"query": 511, "command": 1, "flags": 0, "result": 0, "calls": 1},
            "cpuPossible": "0-1", "cpuPresent": "0-1", "cpuOnline": "0-1",
            "cpuStatsAfterBarrier": [ZERO_STATS, ZERO_STATS], "elapsedNs": 1000000, "deadlineNs": 9000000000,
            "tracefsWritten": False, "foreignDescriptorsOpened": False, "tracePayloadRead": False}


def raw_cpu(root=ROOT):
    return ("CPU_POSSIBLE\n0-1\nCPU_PRESENT\n0-1\nCPU_ONLINE\n0-1\n" +
            "".join(f"{root}/per_cpu/cpu{cpu}/stats\n" + ZERO_STATS for cpu in (0, 1)))


def raw_controls(size):
    return "tracing_on\n0\ncurrent_tracer\nnop\nevents/enable\nX\nset_event\n" + EMPTY.BPF_EVENT + "\nbuffer_subbuf_size_kb\n" + str(size)


class StrictRecorder(FIXTURE.FakeRecorder):
    def __init__(self, directory, build_hash, overrides=None):
        self.build_hash = build_hash
        values = {"tracing-on": (0, "0"), "tracing-on-after": (0, "0"), "events-enabled": (0, "X"),
                  "enabled-events": (0, EMPTY.BPF_EVENT),
                  "kernel-config-digest": (0, EMPTY.CONFIG_GZIP_SHA256 + "  /proc/config.gz"),
                  "snapshot-not-compiled": (0, ""), "observer-create": (0, ""), "observer-push": (0, ""),
                  "observer-mode": (0, ""), "observer-scan": (0, json.dumps(observer_result())),
                  "observer-cleanup": (0, ""), "empty-controls-before-write": (0, raw_controls(4)),
                  "empty-controls-after-write": (0, raw_controls(16)),
                  "empty-stats-before-write": (0, raw_cpu()), "empty-stats-after-write": (0, raw_cpu())}
        values.update(overrides or {})
        super().__init__(directory, overrides=values)

    def __call__(self, name, command, **arguments):
        if name == "observer-digest" and name not in self.overrides:
            self.overrides[name] = (0, self.build_hash + "  " + command.removeprefix("sha256sum "))
        return super().__call__(name, command, **arguments)


class FixtureBuild:
    """Composition seam only; actual compiler/ELF validation has its own suite."""
    def __init__(self, expected_source, expected_binary):
        self.expected_source, self.expected_binary = expected_source, expected_binary

    def validate_build(self, directory, source_path=None):
        raw = (directory / "build.json").read_bytes()
        source = (directory / "android-ftrace-observer.c").read_bytes()
        binary = (directory / "tracefs-observer").read_bytes()
        if source != self.expected_source or binary != self.expected_binary or raw != b'{"syntheticFixture":true}\n':
            raise ValueError("Retained observer fixture bytes differ")
        if source_path and source_path.read_bytes() != source:
            raise ValueError("Current observer source differs")
        return {"sourceSha256": hashlib.sha256(source).hexdigest(), "binarySha256": hashlib.sha256(binary).hexdigest(),
                "binaryBytes": len(binary), "ndkVersion": "28.2.13676358", "target": "x86_64-linux-android29",
                "receiptSha256": hashlib.sha256(raw).hexdigest()}


class EmptyBufferChecks(unittest.TestCase):
    image = FIXTURE.PreparationChecks.image
    rewrite = FIXTURE.PreparationChecks.rewrite
    replace_raw = FIXTURE.PreparationChecks.replace_raw

    def setUp(self):
        FIXTURE.PreparationChecks.setUp(self)
        self.observer = self.directory / "build-observer"
        self.observer.mkdir()
        self.binary_bytes = b"synthetic test-only observer; never executed"
        self.source_bytes = Path(__file__).with_name("android-ftrace-observer.c").read_bytes()
        (self.observer / "tracefs-observer").write_bytes(self.binary_bytes)
        (self.observer / "android-ftrace-observer.c").write_bytes(self.source_bytes)
        (self.observer / "build.json").write_bytes(b'{"syntheticFixture":true}\n')
        self.binary_hash = hashlib.sha256(self.binary_bytes).hexdigest()
        self.builder_patch = patch.object(EMPTY, "build_module", return_value=FixtureBuild(self.source_bytes, self.binary_bytes))
        self.builder_patch.start()

    def tearDown(self):
        self.builder_patch.stop()
        FIXTURE.PreparationChecks.tearDown(self)

    def prepare(self, overrides=None):
        if not self.image_report.exists():
            self.image()
        recorder = StrictRecorder(self.directory, self.binary_hash, overrides)
        PREP.prepare(FIXTURE.PREFIX, self.report, 16384, True, recorder, self.observer)
        return recorder, json.loads(self.report.read_text())

    def test_exact_empty_stopped_bpf_has_one_geometry_write_and_preserves_event(self):
        recorder, proof = self.prepare()
        self.assertTrue(PREP.validate_report(self.report, 16384)["passed"])
        self.assertEqual("X", proof["beforeMutation"]["eventsEnabled"])
        self.assertFalse(proof["emptyBufferProof"]["bpfProducerOwnerEstablished"])
        names = [row["name"] for row in recorder.records]
        self.assertEqual(1, names.count("subbuffer-write"))
        self.assertLess(names.index("observer-scan"), names.index("empty-stats-before-write"))
        self.assertLess(names.index("empty-stats-before-write"), names.index("subbuffer-write"))
        self.assertFalse(any(" > " in str(row["arguments"]) and row["name"] != "subbuffer-write" for row in recorder.records))
        push = next(row for row in recorder.records if row["name"] == "observer-push")
        self.assertEqual(["push", "-q"], push["arguments"][3:5])

    def test_wrong_runtime_config_refuses_before_staging_or_mutation(self):
        with self.assertRaisesRegex(ValueError, "Runtime kernel config"):
            self.prepare({"kernel-config-digest": (0, "0" * 64 + "  /proc/config.gz")})
        proof = json.loads(self.report.read_text())
        self.assertFalse(proof["mutationAttempted"])
        self.assertNotIn("observer-push", [row["name"] for row in proof["commands"]])

    def test_snapshot_feature_appearance_is_not_assumed_empty(self):
        with self.assertRaisesRegex(ValueError, "snapshot-not-compiled"):
            self.prepare({"snapshot-not-compiled": (1, "")})

    def test_additional_enabled_event_never_uses_exception(self):
        with self.assertRaisesRegex(ValueError, "eventsEnabled"):
            self.prepare({"enabled-events": (0, EMPTY.BPF_EVENT + "\nsched:sched_switch")})
        self.assertFalse(json.loads(self.report.read_text())["mutationAttempted"])

    def test_transfer_digest_mismatch_refuses_and_cleans_owned_directory(self):
        with self.assertRaisesRegex(ValueError, "Transferred observer"):
            self.prepare({"observer-digest": (0, "wrong")})
        proof = json.loads(self.report.read_text())
        self.assertEqual("observer-cleanup", proof["commands"][-1]["name"])
        self.assertFalse(proof["mutationAttempted"])

    def test_primary_scan_failure_survives_cleanup_failure(self):
        with self.assertRaisesRegex(ValueError, "observer-scan"):
            self.prepare({"observer-scan": (1, '{"passed":false}'), "observer-cleanup": (1, "")})
        proof = json.loads(self.report.read_text())
        self.assertIn("observer-scan", proof["error"])
        self.assertIn("observer-cleanup", proof["emptyBufferProof"]["cleanupError"])

    def test_nonzero_post_barrier_stats_refuse_before_write(self):
        result = observer_result()
        result["cpuStatsAfterBarrier"][1] = ZERO_STATS.replace("entries: 0", "entries: 1")
        with self.assertRaisesRegex(ValueError, "existing, consumed or lost"):
            self.prepare({"observer-scan": (0, json.dumps(result))})
        self.assertFalse(json.loads(self.report.read_text())["mutationAttempted"])

    def test_classified_nontrace_reconciliation_keeps_full_empty_buffer_gates(self):
        result = observer_result()
        result.update(descriptorCounts=[3000, 3002], descriptorMetadataReads=[3005, 3010],
                      descriptorReconciliations=2,
                      nonTraceComparisonDifferences={
                          "withinPass": {"added": 6, "removed": 3, "replaced": 1},
                          "betweenPass": {"added": 3, "removed": 1, "replaced": 2}})
        recorder, proof = self.prepare({"observer-scan": (0, json.dumps(result))})
        self.assertTrue(PREP.validate_report(self.report, 16384)["passed"])
        self.assertEqual(result, proof["emptyBufferProof"]["observerResult"])
        self.assertEqual(1, sum(row["name"] == "subbuffer-write" for row in recorder.records))

    def test_missing_offline_or_extra_cpu_refuses(self):
        for raw in (raw_cpu().replace("CPU_ONLINE\n0-1", "CPU_ONLINE\n0"),
                    raw_cpu().split(ROOT + "/per_cpu/cpu1/stats")[0], raw_cpu() + "/cpu2/stats\n" + ZERO_STATS):
            with self.subTest(raw=raw[:60]), self.assertRaises(ValueError):
                EMPTY.parse_cpu_observation(raw, ROOT)

    def test_consumed_or_dropped_bytes_are_not_empty_history(self):
        for name in EMPTY.COUNTERS:
            if name == "now ts":
                continue
            with self.subTest(name=name), self.assertRaises(ValueError):
                EMPTY.parse_stats(ZERO_STATS.replace(name + ": 0", name + ": 1"))

    def test_changed_controls_after_write_fail_without_second_write(self):
        with self.assertRaisesRegex(ValueError, "controls/events/geometry"):
            self.prepare({"empty-controls-after-write": (0, raw_controls(16).replace("events/enable\nX", "events/enable\n0"))})
        proof = json.loads(self.report.read_text())
        self.assertTrue(proof["mutated"])
        self.assertFalse(proof["passed"])
        self.assertEqual(1, sum(row["name"] == "subbuffer-write" for row in proof["commands"]))

    def test_forbidden_or_incomplete_observer_fields_refuse(self):
        for key, value in (("procHidepid", 4), ("procVisibilityVerified", False), ("unknownDescriptors", 1),
                           ("forbiddenTracefsDescriptors", 1), ("passes", 1), ("stableTaskInventories", 2),
                           ("sharedThreads", 999), ("schemaVersion", True), ("schemaVersion", 1),
                           ("stableTracefsProjection", False), ("elapsedNs", 9000000001)):
            result = observer_result(); result[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                EMPTY.parse_observer(json.dumps(result))

    def test_incomplete_or_contradictory_descriptor_comparisons_refuse(self):
        changes = [
            {"descriptorCounts": [3000]},
            {"descriptorCounts": [3000, 3001]},
            {"descriptorCounts": [True, 3000]},
            {"descriptorMetadataReads": [2999, 3000]},
            {"descriptorMetadataReads": [524289, 3000]},
            {"descriptorReconciliations": 221},
            {"descriptorReconciliations": 1},
            {"markerWriters": 3000,
             "nonTraceComparisonDifferences": {"withinPass": {"added": 0, "removed": 0, "replaced": 0},
                                              "betweenPass": {"added": 0, "removed": 0, "replaced": 1}}},
            {"descriptorReconciliations": 1,
             "nonTraceComparisonDifferences": {"withinPass": {"added": 1, "removed": 1, "replaced": 0},
                                              "betweenPass": {"added": 0, "removed": 0, "replaced": 0}}},
            {"nonTraceComparisonDifferences": {"withinPass": {"added": 1, "removed": 0, "replaced": 0},
                                             "betweenPass": {"added": 0, "removed": 0, "replaced": 0}}},
            {"nonTraceComparisonDifferences": {"withinPass": {"added": 0, "removed": 0, "replaced": 0},
                                             "betweenPass": {"added": 0, "removed": 0, "replaced": True}}},
        ]
        for change in changes:
            result = observer_result(); result.update(change)
            with self.subTest(change=change), self.assertRaises(ValueError):
                EMPTY.parse_observer(json.dumps(result))

    def test_forged_summary_cannot_hide_raw_tracefs_projection_change(self):
        _, proof = self.prepare()
        row = next(row for row in proof["commands"] if row["name"] == "observer-scan")
        raw = observer_result(); raw["stableTracefsProjection"] = False
        self.replace_raw(row, "stdout", json.dumps(raw).encode()); self.rewrite(proof)
        with self.assertRaisesRegex(ValueError, "contract changed"):
            PREP.validate_report(self.report, 16384)

    def test_barrier_query_error_expedited_or_private_cannot_substitute_global(self):
        for key, value in (("query", 0), ("query", -1), ("result", -1), ("command", 2), ("command", 8),
                           ("flags", 1), ("calls", 0), ("calls", 2)):
            result = observer_result(); result["membarrier"][key] = value
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                EMPTY.parse_observer(json.dumps(result))

    def test_duplicate_json_observer_fields_refuse(self):
        raw = json.dumps(observer_result()).replace('"passed": true', '"passed": false, "passed": true')
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            EMPTY.parse_observer(raw)

    def test_forged_summary_cannot_hide_tampered_raw_barrier(self):
        _, proof = self.prepare()
        row = next(row for row in proof["commands"] if row["name"] == "observer-scan")
        raw = observer_result(); raw["membarrier"]["command"] = 2
        self.replace_raw(row, "stdout", json.dumps(raw).encode()); self.rewrite(proof)
        with self.assertRaisesRegex(ValueError, "GLOBAL"):
            PREP.validate_report(self.report, 16384)

    def test_forged_pass_with_disabled_bpf_raw_after_write_refuses(self):
        _, proof = self.prepare()
        row = next(row for row in proof["commands"] if row["name"] == "empty-controls-after-write")
        self.replace_raw(row, "stdout", raw_controls(16).replace(EMPTY.BPF_EVENT, "").encode()); self.rewrite(proof)
        with self.assertRaisesRegex(ValueError, "controls/events/geometry"):
            PREP.validate_report(self.report, 16384)

    def test_transport_cannot_change_remote_owner_or_command(self):
        _, proof = self.prepare()
        row = next(row for row in proof["commands"] if row["name"] == "observer-push")
        row["arguments"][-1] = "/data/local/tmp/foreign"; self.rewrite(proof)
        with self.assertRaisesRegex(ValueError, "exact argv"):
            PREP.validate_report(self.report, 16384)

    def test_modified_retained_observer_is_rejected(self):
        self.prepare()
        (self.directory / "empty-buffer-observer/tracefs-observer").write_bytes(b"changed")
        with self.assertRaisesRegex(ValueError, "bytes differ"):
            PREP.validate_report(self.report, 16384)


if __name__ == "__main__":
    unittest.main()
