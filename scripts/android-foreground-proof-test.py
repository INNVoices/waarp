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
            "trace": {"attempted": True, "startAttempted": False, "available": False, "started": False,
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

    def write_command(self, suffix, command, output, exit_code=0):
        stem = self.directory / f"foreground-navigation-{suffix}"
        stem.with_suffix(".sh").write_text(f"#!/system/bin/sh\n{command} 2>&1\n"
            "waarp_trace_command_status=$?\n"
            "printf '\\nWAARP_TRACE_COMMAND_EXIT=%s\\n' \"$waarp_trace_command_status\"\n"
            "exit \"$waarp_trace_command_status\"\n")
        stem.with_suffix(".txt").write_text(f"{output}\nWAARP_TRACE_COMMAND_EXIT={exit_code}\n")

    def trace_available(self, wait=True):
        mode = "--background-wait" if wait else "--background"
        remote = self.observation["trace"]["remotePath"]
        command = (f"perfetto {mode} --out {remote} --time 180s --buffer 16mb --app local.waarp.android"
                   " sched freq idle am wm gfx view binder_driver dalvik input")
        self.observation["trace"].update(available=True, startAttempted=True, started=True, completed=True, pid=5678,
                                         startedElapsedMs=1000, stopRequestedElapsedMs=2000, finishedElapsedMs=2100,
                                         startMode=mode, sourceReadinessAcknowledged=wait,
                                         startAcknowledgedElapsedMs=1050, command=command, helpExitCode=0, startExitCode=0)
        self.observation["trace"].pop("error", None)
        help_text = "Usage: perfetto --background --background-wait" if wait else "Usage: perfetto --background"
        self.write_command("trace-help", "perfetto --help", help_text)
        self.write_command("trace-start", command, "5678\n")
        path = self.directory / "foreground-navigation.perfetto-trace"
        path.write_bytes(valid_trace())
        return path

    def test_supported_wait_must_be_used_before_actions(self):
        self.trace_available()
        self.observation["trace"].update(startMode="--background", sourceReadinessAcknowledged=False)
        with self.assertRaisesRegex(ValueError, "readiness"):
            self.validate()

    def test_legacy_background_is_explicit_when_help_has_no_wait_flag(self):
        self.trace_available(wait=False)
        self.assertFalse(self.validate()["physicalDevicePerformanceApproved"])

    def test_pid_before_failed_readiness_ack_is_not_success(self):
        self.trace_available()
        self.observation["trace"]["startExitCode"] = 1
        self.write_command("trace-start", self.observation["trace"]["command"], "5678\n", 1)
        with self.assertRaisesRegex(ValueError, "ACK failed"):
            self.validate()

    def test_failed_ack_cannot_be_relabelled_as_unavailable(self):
        self.trace_available()
        self.observation["trace"].update(available=False, started=False, completed=False, startExitCode=1,
                                         sourceReadinessAcknowledged=False, error="trace_start_command_failed")
        self.write_command("trace-start", self.observation["trace"]["command"], "5678\n", 1)
        with self.assertRaisesRegex(ValueError, "ACK failed"):
            self.validate()

    def test_summary_zero_exit_cannot_override_raw_nonzero_exit(self):
        self.trace_available()
        self.write_command("trace-start", self.observation["trace"]["command"], "5678\n", 1)
        with self.assertRaisesRegex(ValueError, "ACK failed"):
            self.validate()

    def test_suppressing_attempt_flag_cannot_hide_start_evidence(self):
        self.trace_available()
        self.observation["trace"].update(startAttempted=False, available=False, error="unsupported")
        with self.assertRaisesRegex(ValueError, "relabelled"):
            self.validate()

    def test_missing_command_exit_marker_fails(self):
        self.trace_available()
        (self.directory / "foreground-navigation-trace-start.txt").write_text("5678\n")
        with self.assertRaisesRegex(ValueError, "exit status is missing"):
            self.validate()

    def test_multiple_command_exit_markers_fail(self):
        self.trace_available()
        (self.directory / "foreground-navigation-trace-start.txt").write_text(
            "5678\nWAARP_TRACE_COMMAND_EXIT=1\nWAARP_TRACE_COMMAND_EXIT=0\n")
        with self.assertRaisesRegex(ValueError, "exit status is missing or ambiguous"):
            self.validate()

    def test_status_marker_outside_exit_range_fails(self):
        self.trace_available()
        self.write_command("trace-start", self.observation["trace"]["command"], "5678\n", 256)
        with self.assertRaisesRegex(ValueError, "exit status is invalid"):
            self.validate()

    def test_help_failure_cannot_prove_capability(self):
        self.trace_available()
        self.write_command("trace-help", "perfetto --help", "Usage: perfetto --background-wait", 1)
        with self.assertRaisesRegex(ValueError, "help command"):
            self.validate()

    def test_modified_wrapper_cannot_claim_fixed_command(self):
        self.trace_available()
        wrapper = self.directory / "foreground-navigation-trace-start.sh"
        wrapper.write_text(wrapper.read_text().replace("waarp_trace_command_status=$?", "waarp_trace_command_status=0"))
        with self.assertRaisesRegex(ValueError, "wrapper differs"):
            self.validate()

    def test_changed_capture_limits_cannot_rebind_the_command(self):
        self.trace_available()
        self.observation["trace"]["command"] = self.observation["trace"]["command"].replace("--time 180s", "--time 300s")
        self.write_command("trace-start", self.observation["trace"]["command"], "5678\n")
        with self.assertRaisesRegex(ValueError, "fixed capture limits"):
            self.validate()

    def test_command_pid_must_match_recorded_child(self):
        self.trace_available()
        self.write_command("trace-start", self.observation["trace"]["command"], "9876\n")
        with self.assertRaisesRegex(ValueError, "PID differs"):
            self.validate()

    def test_command_pid_must_not_be_target_app(self):
        self.trace_available()
        self.observation["trace"]["pid"] = 1234
        self.write_command("trace-start", self.observation["trace"]["command"], "1234\n")
        with self.assertRaisesRegex(ValueError, "PID differs"):
            self.validate()

    def test_trace_start_path_must_belong_to_this_scope(self):
        self.trace_available()
        self.observation["trace"]["remotePath"] = "/data/misc/perfetto-traces/another.perfetto-trace"
        with self.assertRaisesRegex(ValueError, "does not belong"):
            self.validate()

    def test_late_readiness_ack_cannot_cover_an_earlier_action(self):
        self.trace_available()
        self.observation["trace"]["startAcknowledgedElapsedMs"] = 1200
        with self.assertRaisesRegex(ValueError, "readiness"):
            self.validate()

    def test_invalid_first_trace_does_not_prevent_later_raw_copy_but_gate_still_fails(self):
        summary = {"mode": "smoke", "foregroundFrames": []}
        for phase in ("control", "navigation"):
            observed = capture(phase)
            observed["trace"].update(available=True,
                remotePath=f"/data/misc/perfetto-traces/waarp-smoke-{phase}-1234-1000.perfetto-trace")
            summary["foregroundFrames"].append(observed)
        (self.directory / "release-smoke.json").write_text(json.dumps(summary))
        output = self.directory / "traces"
        raw = {"control": blob(1, b""), "navigation": valid_trace()}
        def adb(arguments, **kwargs):
            phase = "control" if "control" in " ".join(arguments) else "navigation"
            if "stat" in arguments:
                return type("Result", (), {"returncode": 0, "stdout": str(len(raw[phase]))})()
            Path(arguments[-1]).write_bytes(raw[phase])
            return type("Result", (), {"returncode": 0})()
        with patch.object(PROOF.subprocess, "run", side_effect=adb):
            with self.assertRaisesRegex(ValueError, "control.*scheduling"):
                PROOF.collect_traces(["adb", "-s", "emulator-fixture"], self.directory, output)
        self.assertEqual(raw["control"], (output / "foreground-control.perfetto-trace").read_bytes())
        self.assertEqual(raw["navigation"], (output / "foreground-navigation.perfetto-trace").read_bytes())
        error = json.loads((output / "trace-collection-errors.json").read_text())
        self.assertFalse(error["passed"])
        self.assertEqual("control", error["errors"][0]["phase"])
        self.assertEqual(len(raw["control"]), error["errors"][0]["bytes"])
        self.assertEqual("foreground-control.perfetto-trace", error["errors"][0]["rawFile"])
        self.assertEqual(PROOF.hashlib.sha256(raw["control"]).hexdigest(), error["errors"][0]["sha256"])
        self.assertEqual("foreground-navigation.perfetto-trace", error["validTraces"][0]["file"])

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
