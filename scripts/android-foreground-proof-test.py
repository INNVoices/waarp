#!/usr/bin/env python3
"""Negative evidence fixtures for foreground collection, without ADB or an APK."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("foreground", Path(__file__).with_name("android-foreground-proof.py"))
PROOF = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROOF)


def dump(pid=1234, since=1001500000, total=8, janky=2, frame_start=1100000000, frame_end=1117000000):
    return f"""** Graphics info for pid {pid} [local.waarp.android] **
Stats since: {since}ns
Total frames rendered: {total}
Janky frames: {janky} (25.00%)
50th percentile: 16ms
90th percentile: 20ms
95th percentile: 24ms
99th percentile: 32ms
Window: local.waarp.android/local.waarp.android.MainActivity
Stats since: {since}ns
Total frames rendered: 1
Janky frames: 1 (100.00%)
50th percentile: 80ms
90th percentile: 90ms
95th percentile: 100ms
99th percentile: 110ms
---PROFILEDATA---
Flags,IntendedVsync,FrameCompleted,
0,{frame_start},{frame_end},
---PROFILEDATA---
"""


def capture(phase):
    return {"phase": phase, "pid": 1234, "pidAtFinish": 1234, "startedElapsedMs": 1000,
            "finishedElapsedMs": 2000, "resetRequestedNs": 1001000000, "resetCompletedNs": 1002000000,
            "dumpCompletedNs": 2000000000, "completed": True, "foregroundAtStart": True,
            "foregroundAtFinish": True, "physicalDevicePerformanceApproved": False,
            "actions": [{"name": name, "startedElapsedMs": 1100 + index * 100,
                         "finishedElapsedMs": 1150 + index * 100, "completed": True}
                        for index, name in enumerate(PROOF.ACTIONS[phase])],
            "trace": {"attempted": True, "available": False, "started": False,
                      "maxDurationMs": 180000, "bufferBytes": 16 * 1024 * 1024,
                      "remotePath": f"/data/misc/perfetto-traces/waarp-soak-{phase}-1234-1000.perfetto-trace",
                      "error": "Observed unsupported trace category on the fixture image"}}


def integer(value):
    result = bytearray()
    while value > 127:
        result.append((value & 127) | 128); value >>= 7
    return bytes(result + bytes([value]))


def blob(field, value):
    return integer(field * 8 + 2) + integer(len(value)) + value


def valid_trace():
    event = integer(8) + integer(1000000000) + blob(4, b"\x08\x01")
    bundle = blob(2, event)
    return blob(1, blob(1, bundle))


class ForegroundEvidenceChecks(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name)
        self.observation = capture("navigation")
        self.summary = {"mode": "soak", "foregroundFrames": [self.observation]}
        for suffix in ("before", "reset", "after"):
            (self.directory / f"foreground-navigation-{suffix}.txt").write_text(dump())

    def tearDown(self):
        self.temporary.cleanup()

    def validate(self):
        return PROOF.validate(self.directory, self.summary, self.directory)

    def trace_available(self):
        self.observation["trace"].update(available=True, started=True, completed=True,
                                         startedElapsedMs=1000, stopRequestedElapsedMs=2000, finishedElapsedMs=2100)
        self.observation["trace"].pop("error", None)
        path = self.directory / "foreground-navigation.perfetto-trace"
        path.write_bytes(valid_trace())
        return path

    def test_global_section_is_not_replaced_by_window_or_summed(self):
        parsed = PROOF.gfx(dump(), 1234, require_frames=True)
        self.assertEqual((parsed["totalFrames"], parsed["jankyFrames"], parsed["p95Ms"]), (8, 2, 24))

    def test_missing_process_fails(self):
        with self.assertRaisesRegex(ValueError, "owner"):
            PROOF.gfx("No process found for: local.waarp.android", 1234, require_frames=True)

    def test_foreign_pid_fails(self):
        with self.assertRaisesRegex(ValueError, "owner"):
            PROOF.gfx(dump(pid=99), 1234, require_frames=True)

    def test_foreign_package_fails(self):
        with self.assertRaisesRegex(ValueError, "owner"):
            PROOF.gfx(dump().replace("[local.waarp.android]", "[other.app]"), 1234, require_frames=True)

    def test_empty_frame_counter_fails(self):
        with self.assertRaisesRegex(ValueError, "No actual"):
            PROOF.gfx(dump(total=0, janky=0), 1234, require_frames=True)

    def test_impossible_jank_counter_fails(self):
        with self.assertRaisesRegex(ValueError, "jank count"):
            PROOF.gfx(dump(janky=9), 1234, require_frames=True)

    def test_malformed_raw_row_fails(self):
        with self.assertRaisesRegex(ValueError, "Malformed raw"):
            PROOF.gfx(dump().replace("0,1100000000,", "0,bad,"), 1234, require_frames=True)

    def test_unfinished_frame_sentinel_is_not_completed(self):
        with self.assertRaisesRegex(ValueError, "No actual"):
            PROOF.gfx(dump(frame_end=2 ** 63 - 1), 1234, require_frames=True)

    def test_complete_capture_preserves_unapproved_hardware_scope(self):
        result = self.validate()
        self.assertFalse(result["physicalDevicePerformanceApproved"])
        self.assertEqual(result["scopes"][0]["rawFramesWithinScope"], 1)
        self.assertFalse(result["scopes"][0]["systemTrace"]["available"])

    def test_stale_unreset_global_counters_fail(self):
        (self.directory / "foreground-navigation-after.txt").write_text(dump(since=1234))
        with self.assertRaisesRegex(ValueError, "not actually reset"):
            self.validate()

    def test_no_raw_frames_within_scope_fails(self):
        (self.directory / "foreground-navigation-after.txt").write_text(dump(frame_start=200, frame_end=300))
        with self.assertRaisesRegex(ValueError, "belong"):
            self.validate()

    def test_process_replacement_fails(self):
        self.observation["pidAtFinish"] = 1235
        with self.assertRaisesRegex(ValueError, "process changed"):
            self.validate()

    def test_missing_foreground_finish_fails(self):
        self.observation["foregroundAtFinish"] = False
        with self.assertRaisesRegex(ValueError, "while visible"):
            self.validate()

    def test_reordered_interactions_fail(self):
        self.observation["actions"].reverse()
        with self.assertRaisesRegex(ValueError, "reordered"):
            self.validate()

    def test_reversed_action_clock_fails(self):
        self.observation["actions"][0]["finishedElapsedMs"] = 1099
        with self.assertRaisesRegex(ValueError, "interaction evidence"):
            self.validate()

    def test_duplicate_scope_fails(self):
        self.summary["foregroundFrames"].append(copy.deepcopy(self.observation))
        with self.assertRaisesRegex(ValueError, "repeated"):
            self.validate()

    def test_false_hardware_approval_fails(self):
        self.observation["physicalDevicePerformanceApproved"] = True
        with self.assertRaisesRegex(ValueError, "cannot approve"):
            self.validate()

    def test_unavailable_trace_needs_observed_reason(self):
        del self.observation["trace"]["error"]
        with self.assertRaisesRegex(ValueError, "explicit observed error"):
            self.validate()

    def test_empty_trace_claim_is_rejected(self):
        path = self.trace_available(); path.write_bytes(b"")
        with self.assertRaisesRegex(ValueError, "Missing or oversized"):
            self.validate()

    def test_trace_contains_actual_timestamped_sched_data(self):
        self.trace_available()
        trace = self.validate()["scopes"][0]["systemTrace"]
        self.assertEqual(trace["schedulingEvents"], 1)
        self.assertEqual(trace["firstFtraceTimestampNs"], 1000000000)

    def test_trace_clock_exceeding_bound_fails(self):
        self.trace_available()
        self.observation["trace"].update(stopRequestedElapsedMs=200000, finishedElapsedMs=200100)
        with self.assertRaisesRegex(ValueError, "fixed capture"):
            self.validate()

    def test_truncated_protobuf_fails(self):
        path = self.trace_available(); path.write_bytes(valid_trace()[:-1])
        with self.assertRaisesRegex(ValueError, "Truncated"):
            PROOF.trace_structure(path)

    def test_plaintext_trace_error_fails(self):
        path = self.trace_available(); path.write_text("Could not connect to the tracing service")
        with self.assertRaises(ValueError):
            PROOF.trace_structure(path)

    def test_metadata_only_trace_fails(self):
        path = self.trace_available(); path.write_bytes(blob(1, blob(2, b"\x08\x01")))
        with self.assertRaisesRegex(ValueError, "no actual kernel scheduling"):
            PROOF.trace_structure(path)

    def test_empty_scheduler_message_is_not_actual_data(self):
        path = self.trace_available(); path.write_bytes(blob(1, blob(1, blob(2, blob(4, b"")))))
        with self.assertRaisesRegex(ValueError, "no actual kernel scheduling"):
            PROOF.trace_structure(path)

    def test_foreign_device_path_is_never_pulled(self):
        self.observation["trace"]["remotePath"] = "/data/data/another.app/private"
        (self.directory / "release-soak.json").write_text(json.dumps(self.summary))
        with patch.object(PROOF.subprocess, "run") as run:
            with self.assertRaisesRegex(ValueError, "refusing to pull"):
                PROOF.collect_traces(["adb"], self.directory, self.directory / "traces")
            run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
