#!/usr/bin/env python3
"""Synthetic host regressions; no ADB, Android, trace or APK is executed."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("ftrace_prepare", Path(__file__).with_name("android-ftrace-prepare.py"))
PREP = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PREP)
IMAGE = PREP.IMAGE
PREFIX = ["adb", "-s", "emulator-5554"]
IDLE_SERVICE = b"\x18\x00\x20\x00\x38\x01"
SOURCE_PROPERTIES = """Pkg.Desc=System Image Page Size 16k x86_64 with Google APIs.
Pkg.Revision=4
Pkg.Dependencies=emulator#35.4.9
AndroidVersion.ApiLevel=36.1
AndroidVersion.ExtensionLevel=20
AndroidVersion.IsBaseSdk=true
SystemImage.Abi=x86_64
SystemImage.TagId=google_apis,page_size_16kb
SystemImage.TagDisplay=Google APIs,16 KB Page Size
SystemImage.GpuSupport=true
Addon.VendorId=google
Addon.VendorDisplay=Google Inc.
"""


class FakeRecorder:
    def __init__(self, directory, *, image=False, page=16384, subbuffer=4, overrides=None,
                 write_changes=True, uid=0, prefix=None):
        self.directory = directory / ("emulator-image-commands" if image else "ftrace-preparation-commands")
        self.directory.mkdir()
        self.page, self.subbuffer, self.uid = page, subbuffer, uid
        self.overrides, self.write_changes = overrides or {}, write_changes
        self.prefix = prefix or PREFIX
        self.records = []

    def __call__(self, name, command, allow_failure=False, binary=False):
        device = dict(IMAGE.EXPECTED_DEVICE, qemu="1", observerUid=self.uid, pageSize=self.page)
        if self.page == 4096:
            device.update(sdk=35, sdkFull="35", kernel="synthetic-fixture-api35")
        defaults = {key.lower(): (0, str(value)) for key, value in device.items()}
        defaults.update({
            "build-type": (0, "userdebug"), "observer-uid": (0, str(self.uid)),
            "page-size-before": (0, str(self.page)), "page-size-after": (0, str(self.page)),
            "tracefs-location-0": (0, ""), "tracefs-location-1": (1, ""),
            "tracing-on": (0, "1"), "tracing-on-after": (0, "1"), "current-tracer": (0, "nop"),
            "events-enabled": (0, "0"), "perfetto-service-state": (0, IDLE_SERVICE),
            "enabled-events": (0, "sched:sched_switch\nsched:sched_wakeup\n"),
            "failed-event-cpu-stats": (0, "CPU_POSSIBLE\n0-1\nCPU_PRESENT\n0-1\nCPU_ONLINE\n0-1\n"),
            "failed-event-snapshot-header": (0, "# * Snapshot is freed *\n"),
            "failed-event-tracefs-fds": (0, "TRACEFS_FD_SCAN_STARTED\nTRACEFS_FD_SCAN_EXIT=0\n"),
            "perfetto-clients": (1, ""), "atrace-user": (0, ""), "atrace-tags": (0, "0"),
            "atrace-apps": (0, ""), "atrace-clients": (1, ""), "subbuffer-write": (0, ""),
            "subbuffer-before": (0, str(self.subbuffer)), "subbuffer-after": (0, str(self.subbuffer)),
        })
        code, output = self.overrides[name] if name in self.overrides else defaults[name]
        if name == "subbuffer-write" and code == 0 and self.write_changes:
            self.subbuffer = 16
        row = {"name": name, "arguments": self.prefix + IMAGE.adb_arguments(command),
               "timeoutSeconds": PREP.COMMAND_TIMEOUT_SECONDS, "perStreamLimitBytes": PREP.OUTPUT_LIMIT,
               "exitCode": code, "timedOut": False, "elapsedSeconds": 0.001,
               "startedOffsetNs": len(self.records) * 2_000_000,
               "finishedOffsetNs": len(self.records) * 2_000_000 + 1_000_000}
        for key, text in (("stdout", output), ("stderr", b"")):
            path = self.directory / f"{len(self.records):02d}-{name}.{key}"
            data = text if isinstance(text, bytes) else text.encode()
            path.write_bytes(data)
            row[key] = {"file": path.name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
        self.records.append(row)
        return code, output if binary or not isinstance(output, bytes) else output.decode()


class PreparationChecks(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name)
        self.report = self.directory / "ftrace-preparation.json"
        self.image_report = self.directory / "emulator-image.json"
        self.sdk = self.directory / "sdk"
        self.properties = self.sdk / IMAGE.IMAGE_RELATIVE
        self.properties.parent.mkdir(parents=True)
        self.properties.write_text(SOURCE_PROPERTIES)
        # Only the synthetic composition fixture stubs the host inventory.
        # The separate kernel suite hashes actual files and rejects tampering.
        self.kernel_patch = patch.object(IMAGE, "inspect_installed_kernel", return_value={
            "installedRelativePath": IMAGE.KERNEL_RELATIVE.as_posix(), "bytes": IMAGE.KERNEL_BYTES,
            "sha256": IMAGE.KERNEL_SHA256, "startedOffsetNs": 23000000, "finishedOffsetNs": 24000000,
            "elapsedSeconds": 0.001, "timeoutSeconds": 10})
        self.kernel_patch.start()

    def tearDown(self):
        self.kernel_patch.stop()
        self.temporary.cleanup()

    def image(self, page=16384, **arguments):
        recorder = FakeRecorder(self.directory, image=True, page=page, **arguments)
        IMAGE.capture(PREFIX, self.image_report, page, True, sdk_root=self.sdk, recorder=recorder)
        return recorder

    def prepare(self, recorder, expected=16384, disposable=True):
        if not self.image_report.exists():
            self.image(page=expected)
        return PREP.prepare(PREFIX, self.report, expected, disposable, recorder,
                            observer_directory=self.directory / "observer-not-built")

    def successful(self, page=16384):
        recorder = FakeRecorder(self.directory, page=page)
        self.prepare(recorder, expected=page)
        return recorder, json.loads(self.report.read_text())

    def rewrite(self, proof):
        self.report.write_text(json.dumps(proof))

    def replace_raw(self, row, key, data, directory=None):
        directory = directory or self.directory / "ftrace-preparation-commands"
        (directory / row[key]["file"]).write_bytes(data)
        row[key].update(bytes=len(data), sha256=hashlib.sha256(data).hexdigest())

    def test_observed_four_to_sixteen_has_one_allowlisted_write_and_readback(self):
        recorder, _ = self.successful()
        proof = PREP.validate_report(self.report, 16384)
        self.assertTrue(proof["passed"])
        self.assertEqual((4, 16, True), (proof["subBufferBeforeKb"], proof["subBufferAfterKb"], proof["mutated"]))
        writes = [row for row in recorder.records if ">" in row["arguments"][-1]]
        self.assertEqual(1, len(writes))
        self.assertEqual("printf '%s\\n' 16 > /sys/kernel/tracing/buffer_subbuf_size_kb", writes[0]["arguments"][-1])
        self.assertEqual("36.1", proof["imageProof"]["device"]["sdkFull"])

    def test_four_kib_guest_never_touches_tracefs(self):
        recorder, _ = self.successful(page=4096)
        proof = PREP.validate_report(self.report, 4096)
        self.assertFalse(proof["applicable"])
        self.assertFalse(proof["mutated"])
        self.assertFalse(any("tracing" in row["arguments"][-1] for row in recorder.records))

    def test_already_correct_geometry_is_not_written(self):
        recorder = FakeRecorder(self.directory, subbuffer=16)
        self.prepare(recorder)
        self.assertFalse(PREP.validate_report(self.report, 16384)["mutated"])
        self.assertNotIn("subbuffer-write", [row["name"] for row in recorder.records])

    def test_default_writing_flag_one_requires_all_quiescence_guards(self):
        _, proof = self.successful()
        self.assertEqual("1", proof["beforeMutation"]["tracingOn"])
        self.assertEqual("nop", proof["beforeMutation"]["currentTracer"])
        self.assertEqual(0, proof["beforeMutation"]["serviceState"]["numSessions"])
        self.assertTrue(PREP.validate_report(self.report, 16384)["passed"])

    def test_physical_device_is_refused_before_mutation(self):
        recorder = FakeRecorder(self.directory, overrides={"qemu": (0, "0")})
        with self.assertRaisesRegex(ValueError, "physical"):
            self.prepare(recorder)
        self.assertFalse(json.loads(self.report.read_text())["mutationAttempted"])

    def test_explicit_ownership_is_required(self):
        recorder = FakeRecorder(self.directory)
        with self.assertRaisesRegex(ValueError, "ownership"):
            self.prepare(recorder, disposable=False)
        self.assertEqual([], recorder.records)

    def test_mismatched_guest_page_is_not_repaired(self):
        recorder = FakeRecorder(self.directory, page=4096)
        with self.assertRaisesRegex(ValueError, "unchanged test matrix"):
            self.prepare(recorder)
        self.assertFalse(json.loads(self.report.read_text())["mutationAttempted"])

    def test_missing_control_has_no_fallback_mutation(self):
        recorder = FakeRecorder(self.directory, overrides={"tracefs-location-0": (1, ""), "tracefs-location-1": (1, "")})
        with self.assertRaisesRegex(ValueError, "no supported"):
            self.prepare(recorder)
        self.assertFalse(json.loads(self.report.read_text())["mutationAttempted"])

    def test_second_allowlisted_tracefs_path_is_bound_exactly(self):
        recorder = FakeRecorder(self.directory, overrides={"tracefs-location-0": (1, ""), "tracefs-location-1": (0, "")})
        self.prepare(recorder)
        self.assertTrue(PREP.validate_report(self.report, 16384)["passed"])

    def test_unsupported_subbuffer_size_is_not_guessed(self):
        recorder = FakeRecorder(self.directory, subbuffer=8)
        with self.assertRaisesRegex(ValueError, "Unexpected ftrace geometry"):
            self.prepare(recorder)
        self.assertFalse(json.loads(self.report.read_text())["mutationAttempted"])

    def test_active_tracer_or_events_or_perfetto_client_is_never_stopped(self):
        for name, value in (("current-tracer", (0, "function")), ("events-enabled", (0, "X")),
                            ("perfetto-clients", (0, "555")), ("tracing-on", (0, "unknown"))):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                directory = Path(temporary)
                self.image()
                recorder = FakeRecorder(directory, overrides={name: value})
                # Each branch uses its own trace report but the same immutable image proof.
                for item in ("emulator-image.json", "emulator-image-source.properties"):
                    (directory / item).write_bytes((self.directory / item).read_bytes())
                import shutil
                shutil.copytree(self.directory / "emulator-image-commands", directory / "emulator-image-commands")
                with self.assertRaisesRegex(ValueError, "may be active"):
                    PREP.prepare(PREFIX, directory / "ftrace-preparation.json", 16384, True, recorder)
                self.assertFalse(any(">" in row["arguments"][-1] or "kill" in row["arguments"][-1] for row in recorder.records))
                self.image_report.unlink()
                (self.directory / "emulator-image-source.properties").unlink()
                shutil.rmtree(self.directory / "emulator-image-commands")

    def test_active_or_armed_perfetto_session_is_rejected(self):
        recorder = FakeRecorder(self.directory, overrides={"perfetto-service-state": (0, b"\x18\x01\x20\x00\x38\x01")})
        with self.assertRaisesRegex(ValueError, "session is active or armed"):
            self.prepare(recorder)
        self.assertFalse(json.loads(self.report.read_text())["mutationAttempted"])

    def test_event_rejection_preserves_names_from_the_selected_tracefs_root(self):
        recorder = FakeRecorder(self.directory, overrides={"events-enabled": (0, "X"),
                                "tracefs-location-0": (1, ""), "tracefs-location-1": (0, "")})
        with self.assertRaisesRegex(ValueError, "eventsEnabled='X'"):
            self.prepare(recorder)
        proof = json.loads(self.report.read_text())
        self.assertEqual({"field": "eventsEnabled", "observed": "X", "expected": "0"}, proof["failedGuard"])
        reads = [row for row in recorder.records if row["name"] == "enabled-events"]
        self.assertEqual(1, len(reads))
        self.assertEqual("cat /sys/kernel/debug/tracing/set_event", reads[0]["arguments"][-1])
        self.assertEqual(b"sched:sched_switch\nsched:sched_wakeup\n",
                         (recorder.directory / reads[0]["stdout"]["file"]).read_bytes())
        self.assertFalse(proof["passed"] or proof["mutationAttempted"] or proof["mutated"])
        self.assertFalse(any(">" in row["arguments"][-1] or "kill" in row["arguments"][-1] for row in recorder.records))

    def test_failed_event_diagnostic_read_preserves_the_original_rejection(self):
        recorder = FakeRecorder(self.directory, overrides={"events-enabled": (0, "X"), "enabled-events": (1, "")})
        with self.assertRaisesRegex(ValueError, "may be active; eventsEnabled='X'") as raised:
            self.prepare(recorder)
        proof = json.loads(self.report.read_text())
        self.assertEqual(str(raised.exception), proof["error"])
        self.assertEqual("Preparation read failed: enabled-events", proof["eventDiagnosticsError"])
        self.assertEqual(1, sum(row["name"] == "enabled-events" for row in recorder.records))
        self.assertFalse(proof["passed"] or proof["mutationAttempted"] or proof["mutated"])
        self.assertFalse(any(">" in row["arguments"][-1] or "kill" in row["arguments"][-1] for row in recorder.records))

    def test_known_stopped_bpf_event_observations_never_approve_resize(self):
        recorder = FakeRecorder(self.directory, overrides={"events-enabled": (0, "X"),
                                "tracing-on": (0, "0"),
                                "enabled-events": (0, "bpf_trace:bpf_trace_printk\n")})
        with self.assertRaisesRegex(ValueError, "eventsEnabled='X'"):
            self.prepare(recorder)
        proof = json.loads(self.report.read_text())
        self.assertTrue(proof["readOnlyDiagnostics"]["allReadsCompleted"])
        self.assertFalse(proof["readOnlyDiagnostics"]["quiescenceEstablished"])
        self.assertFalse(proof["readOnlyDiagnostics"]["ownerEstablished"])
        self.assertEqual(["failed-event-cpu-stats", "failed-event-snapshot-header", "failed-event-tracefs-fds"],
                         [row["name"] for row in recorder.records[-3:]])
        self.assertFalse(proof["passed"] or proof["mutationAttempted"] or proof["mutated"])
        self.assertFalse(any(">" in row["arguments"][-1] or "kill" in row["arguments"][-1] for row in recorder.records))

    def test_partial_quiescence_observation_preserves_original_failure(self):
        recorder = FakeRecorder(self.directory, overrides={"events-enabled": (0, "X"),
                                "tracing-on": (0, "0"), "enabled-events": (0, "bpf_trace:bpf_trace_printk\n"),
                                "failed-event-snapshot-header": (1, "")})
        with self.assertRaisesRegex(ValueError, "eventsEnabled='X'") as raised:
            self.prepare(recorder)
        proof = json.loads(self.report.read_text())
        self.assertEqual(str(raised.exception), proof["error"])
        self.assertFalse(proof["readOnlyDiagnostics"]["allReadsCompleted"])
        self.assertIn("failed-event-snapshot-header", proof["readOnlyDiagnostics"]["errors"])
        self.assertEqual("failed-event-tracefs-fds", recorder.records[-1]["name"])
        self.assertFalse(proof["passed"] or proof["mutationAttempted"] or proof["mutated"])

    def test_snapshot_filter_emits_only_summary_before_any_payload(self):
        payload = ("# tracer: nop\n#\n# entries-in-buffer/entries-written: 1/1   #P:2\n"
                   "worker-123 [000] sample: PRIVATE_TRACE_PAYLOAD\n"
                   "# entries-in-buffer/entries-written: 999/999   #P:9\n")
        result = subprocess.run(["sed", "-n", PREP.SNAPSHOT_HEADER_FILTER], input=payload,
                                text=True, capture_output=True, timeout=2, check=True)
        self.assertEqual("# entries-in-buffer/entries-written: 1/1   #P:2\n", result.stdout)

    def test_failure_observations_accept_only_literal_tracefs_roots(self):
        with self.assertRaisesRegex(ValueError, "Unallowlisted"):
            PREP.failed_event_diagnostic_commands("/tmp/foreign")

    def test_fd_observation_uses_metadata_without_reading_foreign_content(self):
        proc = self.directory / "proc"
        (proc / "123/fd").mkdir(parents=True)
        (proc / "123/fdinfo").mkdir()
        (proc / "123/fd/3").symlink_to("/sys/kernel/tracing/trace_pipe")
        (proc / "123/fdinfo/3").write_text("flags:\t0100000\nPRIVATE_FD_CONTENT\n")
        (proc / "123/fd/4").symlink_to("/tmp/PRIVATE_FOREIGN_PATH")
        for _, command in PREP.failed_event_diagnostic_commands(PREP.TRACEFS_ROOTS[0]):
            subprocess.run(["sh", "-n", "-c", command], timeout=2, check=True)
        command = PREP.failed_event_diagnostic_commands(PREP.TRACEFS_ROOTS[0])[-1][1]
        command = command.replace("/proc/[0-9]*/fd", str(proc) + "/[0-9]*/fd")
        result = subprocess.run(["sh", "-c", command], capture_output=True, text=True, timeout=2, check=True)
        self.assertIn("/sys/kernel/tracing/trace_pipe", result.stdout)
        self.assertIn("flags:\t0100000", result.stdout)
        self.assertIn("TRACEFS_FD_SCAN_EXIT=0", result.stdout)
        self.assertNotIn("PRIVATE", result.stdout + result.stderr)

    def test_legacy_atrace_capture_is_rejected(self):
        recorder = FakeRecorder(self.directory, overrides={"atrace-user": (0, "1")})
        with self.assertRaisesRegex(ValueError, "Legacy atrace"):
            self.prepare(recorder)
        self.assertFalse(json.loads(self.report.read_text())["mutationAttempted"])

    def test_detached_atrace_tags_are_rejected_even_without_client(self):
        recorder = FakeRecorder(self.directory, overrides={"atrace-tags": (0, "4096")})
        with self.assertRaisesRegex(ValueError, "Legacy atrace"):
            self.prepare(recorder)
        self.assertFalse(json.loads(self.report.read_text())["mutationAttempted"])

    def test_legacy_atrace_app_filter_is_rejected(self):
        recorder = FakeRecorder(self.directory, overrides={"atrace-apps": (0, "1")})
        with self.assertRaisesRegex(ValueError, "Legacy atrace"):
            self.prepare(recorder)

    def test_legacy_atrace_client_is_rejected(self):
        recorder = FakeRecorder(self.directory, overrides={"atrace-clients": (0, "444")})
        with self.assertRaisesRegex(ValueError, "Legacy atrace"):
            self.prepare(recorder)

    def test_unverifiable_service_query_is_not_assumed_idle(self):
        for raw in (b"", b"\x18\x00\x20\x00", b"\x38\x01\x38\x01", b"\x38\x01\x32\x00",
                    b"\x38\x01\x18\x01", b"\x38\x01\x20\x01", b"\x38\x80"):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                PREP.service_state(raw)

    def test_failed_write_is_retained_and_never_retried(self):
        recorder = FakeRecorder(self.directory, overrides={"subbuffer-write": (1, "")})
        with self.assertRaises(ValueError):
            self.prepare(recorder)
        proof = json.loads(self.report.read_text())
        self.assertFalse(proof["passed"])
        self.assertTrue(proof["mutationAttempted"])
        self.assertFalse(proof["mutated"])
        self.assertEqual(1, sum(row["name"] == "subbuffer-write" for row in recorder.records))

    def test_successful_write_without_readback_change_is_rejected(self):
        recorder = FakeRecorder(self.directory, write_changes=False)
        with self.assertRaisesRegex(ValueError, "readback"):
            self.prepare(recorder)
        self.assertFalse(json.loads(self.report.read_text())["passed"])

    def test_changed_page_size_after_preparation_fails(self):
        recorder = FakeRecorder(self.directory, overrides={"page-size-after": (0, "4096")})
        with self.assertRaisesRegex(ValueError, "PAGE_SIZE changed"):
            self.prepare(recorder)

    def test_recording_flag_cannot_change_during_quiescent_resize(self):
        recorder = FakeRecorder(self.directory, overrides={"tracing-on-after": (0, "0")})
        with self.assertRaisesRegex(ValueError, "recording state changed"):
            self.prepare(recorder)

    def test_proof_rejects_changed_recording_flag_even_with_consistent_raw_hash(self):
        _, proof = self.successful()
        proof["tracingOnAfter"] = "0"
        row = next(row for row in proof["commands"] if row["name"] == "tracing-on-after")
        self.replace_raw(row, "stdout", b"0"); self.rewrite(proof)
        with self.assertRaisesRegex(ValueError, "inactive-tracing proof"):
            PREP.validate_report(self.report, 16384)

    def test_proof_rejects_unmeasured_or_nonfinite_elapsed_duration(self):
        _, original = self.successful()
        for duration in (-1, 999, float("nan"), float("inf")):
            with self.subTest(duration=duration):
                proof = copy.deepcopy(original); proof["commands"][0]["elapsedSeconds"] = duration
                self.rewrite(proof)
                with self.assertRaisesRegex(ValueError, "measured duration"):
                    PREP.validate_report(self.report, 16384)

    def test_proof_rejects_overlapping_command_timing(self):
        _, proof = self.successful()
        proof["commands"][1]["startedOffsetNs"] = 0; self.rewrite(proof)
        with self.assertRaisesRegex(ValueError, "nonsequential"):
            PREP.validate_report(self.report, 16384)

    def test_proof_rejects_total_elapsed_above_sixty_seconds(self):
        _, proof = self.successful()
        proof["commands"][-1]["finishedOffsetNs"] = 60_000_000_001; self.rewrite(proof)
        with self.assertRaisesRegex(ValueError, "fixed total bound"):
            PREP.validate_report(self.report, 16384)

    def test_proof_rejects_individual_command_above_ten_seconds(self):
        _, proof = self.successful()
        proof["commands"][0].update(finishedOffsetNs=10_000_000_001, elapsedSeconds=10.000000001)
        self.rewrite(proof)
        with self.assertRaisesRegex(ValueError, "measured duration"):
            PREP.validate_report(self.report, 16384)

    def test_raw_readback_tampering_cannot_be_hidden_in_summary(self):
        recorder, proof = self.successful()
        row = next(row for row in proof["commands"] if row["name"] == "subbuffer-after")
        (recorder.directory / row["stdout"]["file"]).write_text("4")
        with self.assertRaisesRegex(ValueError, "Raw command output"):
            PREP.validate_report(self.report, 16384)

    def test_updated_hash_still_cannot_hide_wrong_readback(self):
        _, proof = self.successful()
        row = next(row for row in proof["commands"] if row["name"] == "subbuffer-after")
        self.replace_raw(row, "stdout", b"4")
        self.rewrite(proof)
        with self.assertRaisesRegex(ValueError, "Raw geometry readback"):
            PREP.validate_report(self.report, 16384)

    def test_four_kib_extra_write_is_rejected(self):
        _, proof = self.successful(page=4096)
        extra = copy.deepcopy(proof["commands"][-1]); extra["name"] = "extra-write"
        extra["arguments"][-1] = "printf '%s\\n' 16 > /sys/kernel/tracing/buffer_subbuf_size_kb"
        proof["commands"].append(extra); self.rewrite(proof)
        with self.assertRaisesRegex(ValueError, "has extras"):
            PREP.validate_report(self.report, 4096)

    def test_write_before_quiescence_proof_is_rejected(self):
        _, proof = self.successful()
        rows = proof["commands"]
        write = next(index for index, row in enumerate(rows) if row["name"] == "subbuffer-write")
        rows[write], rows[8] = rows[8], rows[write]
        self.rewrite(proof)
        with self.assertRaisesRegex(ValueError, "order, exact argv"):
            PREP.validate_report(self.report, 16384)

    def test_a_read_label_cannot_hide_a_write_command(self):
        _, proof = self.successful()
        next(row for row in proof["commands"] if row["name"] == "current-tracer")["arguments"][-1] = "printf nop"
        self.rewrite(proof)
        with self.assertRaisesRegex(ValueError, "order, exact argv"):
            PREP.validate_report(self.report, 16384)

    def test_command_cannot_switch_emulator_serial(self):
        _, proof = self.successful()
        proof["commands"][-1]["arguments"][2] = "emulator-5556"; self.rewrite(proof)
        with self.assertRaisesRegex(ValueError, "serial"):
            PREP.validate_report(self.report, 16384)

    def test_successful_status_cannot_hide_stderr(self):
        _, proof = self.successful()
        self.replace_raw(proof["commands"][0], "stderr", b"unexpected warning\n")
        self.rewrite(proof)
        with self.assertRaisesRegex(ValueError, "Unexpected stderr"):
            PREP.validate_report(self.report, 16384)

    def test_pidof_success_with_empty_stdout_is_not_proof_of_absence(self):
        _, proof = self.successful()
        next(row for row in proof["commands"] if row["name"] == "perfetto-clients")["exitCode"] = 0
        self.rewrite(proof)
        with self.assertRaisesRegex(ValueError, "exit status"):
            PREP.validate_report(self.report, 16384)

    def test_native_image_observer_uid_2000_needs_no_root_or_tracefs(self):
        recorder = self.image(uid=2000)
        proof = IMAGE.validate_report(self.image_report, 16384)
        self.assertEqual(2000, proof["device"]["observerUid"])
        self.assertFalse(proof["deviceModified"])
        self.assertFalse(any("root" in row["arguments"] or "tracing" in row["arguments"][-1] or ">" in row["arguments"][-1]
                             for row in recorder.records))

    def test_original_base36_kernel_is_refused(self):
        with self.assertRaisesRegex(ValueError, "Runtime device/kernel"):
            self.image(overrides={"kernel": (0, "6.6.66-android15-8-gd0c43a640eab-ab13812146")})
        self.assertFalse(json.loads(self.image_report.read_text())["passed"])

    def test_runtime_full_sdk_must_match_reviewed_maintenance_image(self):
        with self.assertRaisesRegex(ValueError, "Runtime device/kernel"):
            self.image(overrides={"sdkfull": (0, "36.0")})

    def test_runtime_fingerprint_is_bound(self):
        with self.assertRaisesRegex(ValueError, "Runtime device/kernel"):
            self.image(overrides={"fingerprint": (0, "different image")})

    def test_installed_revision_must_match_reviewed_image(self):
        self.properties.write_text(SOURCE_PROPERTIES.replace("Pkg.Revision=4", "Pkg.Revision=5"))
        with self.assertRaisesRegex(ValueError, "package/revision"):
            self.image()
        self.assertTrue((self.directory / "emulator-image-source.properties").is_file())

    def test_installed_tag_must_still_be_16_kib(self):
        self.properties.write_text(SOURCE_PROPERTIES.replace("google_apis,page_size_16kb", "google_apis"))
        with self.assertRaisesRegex(ValueError, "package/revision"):
            self.image()

    def test_installed_image_raw_metadata_cannot_be_replaced(self):
        self.image()
        (self.directory / "emulator-image-source.properties").write_text(SOURCE_PROPERTIES + "Unknown=1\n")
        with self.assertRaisesRegex(ValueError, "raw metadata"):
            IMAGE.validate_report(self.image_report, 16384)

    def test_image_raw_command_cannot_be_relabelled(self):
        self.image()
        proof = json.loads(self.image_report.read_text())
        proof["commands"][0]["arguments"][-1] = "printf 1"
        self.image_report.write_text(json.dumps(proof))
        with self.assertRaisesRegex(ValueError, "exact argv"):
            IMAGE.validate_report(self.image_report, 16384)

    def test_image_and_geometry_must_share_the_same_serial(self):
        self.image(prefix=["adb", "-s", "emulator-5556"])
        recorder = FakeRecorder(self.directory)
        with self.assertRaisesRegex(ValueError, "different emulator serials"):
            self.prepare(recorder)
        self.assertFalse(recorder.records)

    def test_actual_recorder_keeps_binary_query_bytes_and_return_code(self):
        recorder = IMAGE.AdbRecorder(PREFIX, self.directory / "actual-recorder")
        def run(arguments, **options):
            options["stdout"].write(IDLE_SERVICE)
            return type("Result", (), {"returncode": 0})()
        with patch.object(IMAGE.subprocess, "run", side_effect=run):
            code, raw = recorder("service", "perfetto --query-raw", binary=True)
        self.assertEqual((0, IDLE_SERVICE), (code, raw))

    def test_actual_recorder_rejects_stderr_even_for_allowed_absent_client_exit(self):
        recorder = IMAGE.AdbRecorder(PREFIX, self.directory / "actual-recorder")
        def run(arguments, **options):
            options["stderr"].write(b"failed to connect")
            return type("Result", (), {"returncode": 1})()
        with patch.object(IMAGE.subprocess, "run", side_effect=run), self.assertRaisesRegex(ValueError, "Unexpected stderr"):
            recorder("client", "pidof perfetto", allow_failure=True)
        self.assertEqual(1, recorder.records[0]["exitCode"])

    def test_actual_recorder_retains_timeout_without_retry(self):
        recorder = IMAGE.AdbRecorder(PREFIX, self.directory / "actual-recorder")
        with patch.object(IMAGE.subprocess, "run", side_effect=subprocess.TimeoutExpired(["adb"], 10)) as run:
            with self.assertRaisesRegex(ValueError, "timed out"):
                recorder("service", "perfetto --query-raw", binary=True)
        self.assertEqual(1, run.call_count)
        self.assertTrue(recorder.records[0]["timedOut"])

    def test_actual_recorder_rejects_success_returned_after_time_bound(self):
        result = type("Result", (), {"returncode": 0})()
        with patch.object(IMAGE.time, "monotonic_ns", side_effect=[0, 0, 10_000_000_001]):
            recorder = IMAGE.AdbRecorder(PREFIX, self.directory / "actual-recorder")
            with patch.object(IMAGE.subprocess, "run", return_value=result), self.assertRaisesRegex(ValueError, "measured time bound"):
                recorder("client", "pidof perfetto", allow_failure=True)
        self.assertFalse(recorder.records[0]["timedOut"])
        self.assertEqual(10.000000001, recorder.records[0]["elapsedSeconds"])


if __name__ == "__main__":
    unittest.main()
