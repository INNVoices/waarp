#!/usr/bin/env python3
"""Exercise API 29 preparation ordering and failures without a real ADB device."""
import importlib.util
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


spec = importlib.util.spec_from_file_location(
    "waarp_emulator_prepare", Path(__file__).with_name("android-emulator-prepare.py"))
prepare = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare)


class Clock:
    def __init__(self):
        self.now = 0.0

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


class FakeAdb:
    def __init__(self, scenario="ok", uid=2000):
        self.clock = Clock()
        self.scenario = scenario
        self.uid = uid
        self.stage = "original"
        self.stop_polls = 0
        self.pid_polls = {"original": 0, "started": 0}
        self.pid_sequences = {"original": [], "started": []}
        self.events = []
        self.restoring = False
        self.restore_waits = 0
        self.restore_uid_reads = 0
        self.names_lost = False
        self.diagnostic_mode = "ok"
        self.diagnostic_events = []
        self.report_path = None
        self.old = {"zygote": [101], "zygote64": [102], "system_server": [103]}
        self.new = {"zygote": [201], "zygote64": [202], "system_server": [203]}
        self.props = {
            "ro.build.version.sdk": "29", "ro.kernel.qemu": "1", "ro.boot.qemu": "",
            "ro.debuggable": "1", "ro.zygote": "zygote64_32", "ro.product.cpu.abi": "x86_64",
            # Even a correct late property must be applied before fresh zygotes.
            "dalvik.vm.heapsize": "512m", "dalvik.vm.heapgrowthlimit": "192m",
            "dalvik.vm.heapstartsize": "8m", "ro.kernel.qemu.dalvik.vm.heapsize": "512m",
            "ro.boot.dalvik.vm.heapsize": "", "sys.boot_completed": "1",
            "init.svc.zygote": "running", "init.svc.zygote_secondary": "running",
        }

    def processes(self):
        sequence = self.pid_sequences.get(self.stage, [])
        if sequence:
            snapshot = sequence[min(self.pid_polls[self.stage] - 1, len(sequence) - 1)]
            if snapshot is not None:
                return snapshot
        if self.stage == "original":
            return self.old
        if self.stage in ("stopping", "configured"):
            # The 32-bit secondary outlives the primary and system_server.
            if self.scenario == "secondary_stuck" or (self.stage == "stopping" and self.stop_polls < 3):
                return {"zygote": [101], "zygote64": [], "system_server": []}
            return {name: [] for name in self.old}
        if self.scenario == "old_pid_after_start":
            return self.old
        if self.scenario == "new_server_missing":
            return {"zygote": [201], "zygote64": [202], "system_server": []}
        if self.names_lost:
            return {"zygote": self.new["zygote"], "zygote64": [], "system_server": []}
        if self.restoring and self.scenario == "restore_pid_changed":
            return {**self.new, "system_server": [204]}
        return self.new

    def old_pid_exists(self, pid):
        if self.scenario == "old_pid_renamed" and self.stage == "stopping" and pid == 103:
            return True
        return pid in {value for values in self.processes().values() for value in values}

    def result(self, arguments, code=0, stdout="", stderr=""):
        return subprocess.CompletedProcess(arguments, code, stdout, stderr)

    def run(self, arguments, timeout):
        assert arguments[:3] == ["fake-adb", "-s", "emulator-5554"], arguments
        self.clock.sleep(min(0.01, timeout))
        if timeout < 0.01:
            raise subprocess.TimeoutExpired(arguments, timeout)
        args = tuple(arguments[3:])
        self.events.append((args, self.clock.monotonic(), self.stage))
        if args == ("root",):
            if self.scenario != "root_denied":
                self.uid = 0
            return self.result(arguments, stdout="restarting adbd as root\n")
        if args == ("unroot",):
            self.restoring = True
            if self.scenario not in ("restore_denied", "unroot_closed_stays_root"):
                self.uid = 2000
            if self.scenario in ("unroot_closed", "unroot_closed_stays_root", "restore_transient_transport"):
                # Actual run9 command outcome. Any later UID/transport state is
                # an explicit synthetic fixture, never an inferred run9 result.
                return self.result(arguments, 1, stderr="adb: unable to connect for unroot: closed\n")
            if self.scenario == "unroot_generic_error":
                return self.result(arguments, 1, stderr="adb: unable to connect for unroot: permission denied\n")
            if self.scenario == "unroot_other_closed":
                return self.result(arguments, 1, stderr="adb: unable to connect for unroot: closed: permission denied\n")
            if self.scenario == "unroot_stdout_closed":
                return self.result(arguments, 1, stdout="adb: unable to connect for unroot: closed\n")
            if self.scenario == "unroot_timeout":
                self.clock.sleep(timeout - 0.01)
                raise subprocess.TimeoutExpired(arguments, timeout)
            return self.result(arguments, stdout="restarting adbd as non root\n")
        if args == ("wait-for-device",):
            if self.restoring:
                self.restore_waits += 1
                if self.scenario == "restore_wait_timeout" or (
                        self.scenario == "restore_transient_transport" and self.restore_waits == 1):
                    self.clock.sleep(timeout - 0.01)
                    raise subprocess.TimeoutExpired(arguments, timeout)
                if self.scenario == "restore_transient_transport" and self.restore_waits == 2:
                    return self.result(arguments, 1, stderr="error: device offline\n")
                if self.scenario == "restore_wait_error":
                    return self.result(arguments, 1, stderr="error: device unauthorized\n")
            return self.result(arguments)
        if args == ("shell", "id", "-u"):
            if self.restoring:
                self.restore_uid_reads += 1
                if self.scenario == "restore_transient_transport":
                    if self.restore_uid_reads == 1:
                        return self.result(arguments, 1, stderr="error: closed\n")
                    if self.restore_uid_reads == 2:
                        return self.result(arguments, stdout="0\n")
                if self.scenario == "restore_uid_unexpected":
                    return self.result(arguments, stdout="1000\n")
                if self.scenario == "restore_uid_malformed":
                    return self.result(arguments, stdout="2000 0\n")
                if self.scenario == "restore_uid_error":
                    return self.result(arguments, 1, stderr="id: permission denied\n")
                if self.scenario == "restore_final_uid_changed" and self.restore_uid_reads > 1:
                    return self.result(arguments, stdout="0\n")
                if self.scenario == "restore_final_uid_stderr" and self.restore_uid_reads > 1:
                    return self.result(arguments, stdout="2000\n", stderr="id: permission denied\n")
            return self.result(arguments, stdout=str(self.uid) + "\n")
        if args[:2] == ("shell", "getprop"):
            value = self.props.get(args[2], "")
            if self.scenario == "oversized_property" and args[2] == "ro.build.version.sdk":
                value = "x" * (prepare.MAX_COMMAND_OUTPUT + 1)
            if self.restoring and self.scenario == "restore_heap_changed" and args[2] == prepare.HEAP_PROPERTY:
                value = "256m"
            if self.restoring and self.scenario == "restore_growth_changed" and args[2] == "dalvik.vm.heapgrowthlimit":
                value = "256m"
            return self.result(arguments, stdout=value + "\n")
        if args[:2] == ("shell", "pidof"):
            name = args[2]
            if name == "zygote" and self.stage in self.pid_polls:
                self.pid_polls[self.stage] += 1
            if self.stage == "stopping" and name == "zygote":
                self.stop_polls += 1
            if self.scenario == "pidof_error" and self.stage == "stopping":
                return self.result(arguments, 1, stderr="pidof: permission denied\n")
            pids = self.processes()[name]
            return self.result(arguments, 0 if pids else 1,
                               stdout=" ".join(map(str, pids)) + ("\n" if pids else ""))
        if args[:3] == ("shell", "test", "-d"):
            pid = int(args[3].rsplit("/", 1)[1])
            return self.result(arguments, 0 if self.old_pid_exists(pid) else 1)
        if args == ("shell", "stop"):
            assert self.uid == 0
            assert self.stage == "original", "Framework stop was repeated"
            self.stage = "stopping"
            if self.scenario == "stop_timeout":
                raise subprocess.TimeoutExpired(arguments, timeout)
            return self.result(arguments)
        if args == ("shell", "setprop", "dalvik.vm.heapsize", "512m"):
            assert self.stage == "stopping" and not any(self.processes().values())
            assert not any(self.old_pid_exists(pid) for group in self.old.values() for pid in group)
            self.stage = "configured"
            self.props["dalvik.vm.heapsize"] = "256m" if self.scenario == "bad_readback" else "512m"
            return self.result(arguments)
        if args == ("shell", "start"):
            assert self.stage == "configured", "Framework start was repeated or premature"
            self.stage = "started"
            if self.scenario == "boot_incomplete":
                self.props["sys.boot_completed"] = "0"
            return self.result(arguments)
        if args == ("shell", "cmd", "activity", "get-config"):
            if self.scenario == "run11_binder_name_loss":
                return self.result(arguments, 224, stderr="cmd: Failure calling service activity: Broken pipe (32)\n")
            if self.scenario == "activity_error" or (self.restoring and self.scenario == "restore_binder_error"):
                return self.result(arguments, stdout="Error dumping service info: (Unknown error -32) activity\n")
            return self.result(arguments, stdout="config: en-rUS-port-night-xhdpi\nabi: x86_64,x86\n")
        if args == ("shell", "cmd", "package", "path", "android"):
            if self.scenario == "run11_binder_name_loss":
                self.names_lost = True
                return self.result(arguments, 224, stderr="cmd: Failure calling service package: Broken pipe (32)\n")
            if self.scenario == "package_error":
                return self.result(arguments, stdout="Error: package service is not ready\n")
            if self.scenario == "pid_changes_during_binder":
                self.new = {**self.new, "system_server": [204]}
            return self.result(arguments, stdout="package:/system/framework/framework-res.apk\n")
        raise AssertionError("Unexpected ADB command: " + repr(args))

    def diagnose(self, arguments, timeout, stdout_path, stderr_path, output_limit):
        assert arguments[:3] == ["fake-adb", "-s", "emulator-5554"], arguments
        # Collector must start only after the original failure was durable.
        persisted = json.loads(self.report_path.read_text())
        assert persisted["passed"] is False and persisted.get("error")
        args = tuple(arguments[3:])
        self.diagnostic_events.append((args, timeout, persisted["error"]))
        if self.diagnostic_mode == "collector_error":
            raise OSError("synthetic diagnostic transport failure")
        if self.diagnostic_mode == "timeout":
            self.clock.sleep(timeout)
            stdout_path.write_bytes(b"synthetic partial observation before timeout\n")
            stderr_path.write_bytes(b"")
            return {"exitCode": None, "timedOut": True, "error": "TimeoutExpired"}
        self.clock.sleep(min(0.01, timeout))
        raw = b"synthetic diagnostic fixture\x00raw bytes\xff\n"
        stdout_path.write_bytes(raw[:output_limit])
        stderr_path.write_bytes(b"synthetic stderr\n")
        return {"exitCode": 0, "timedOut": False}

    def commands(self):
        return [args for args, _, _ in self.events]

    def mutations(self):
        return [args for args in self.commands() if args in (
            ("root",), ("unroot",), ("shell", "stop"), ("shell", "start"))
            or args[:2] == ("shell", "setprop")]


class EmulatorPreparationTests(unittest.TestCase):
    def execute(self, fake, *, serial="emulator-5554", disposable=True):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "nested/preparation.json"
            fake.report_path = path
            task = prepare.Preparation(serial, disposable, path, adb="fake-adb",
                                       command_runner=fake.run, diagnostic_runner=fake.diagnose,
                                       monotonic=fake.clock.monotonic,
                                       sleep=fake.clock.sleep)
            report = task.run()
            self.assertEqual(json.loads(path.read_text()), report)
            self.assertIsNone(report["actualRuntimeMaxHeapBytes"])
            self.assertLessEqual(len(report["recentCommands"]), 128)
            self.assertTrue(all(len(item.get("output", "")) <= 2048 for item in report["recentCommands"]))
            for entry in report.get("failureDiagnostics", {}).get("commands", []):
                for stream in ("stdout", "stderr"):
                    raw = entry.get(stream, {})
                    if raw.get("available"):
                        captured = path.parent / raw["file"]
                        self.assertEqual(raw["bytes"], captured.stat().st_size)
                        self.assertEqual(raw["sha256"], hashlib.sha256(captured.read_bytes()).hexdigest())
                        self.assertLessEqual(raw["bytes"], entry["outputLimitBytesPerStream"])
            return report

    def assert_no_start(self, fake):
        self.assertNotIn(("shell", "start"), fake.commands())

    def test_budget_is_set_only_after_both_zygotes_and_old_pids_are_gone(self):
        fake = FakeAdb()
        report = self.execute(fake)
        self.assertTrue(report["passed"], report.get("error"))
        self.assertEqual(fake.mutations(), [
            ("root",), ("shell", "stop"),
            ("shell", "setprop", "dalvik.vm.heapsize", "512m"),
            ("shell", "start"), ("unroot",),
        ])
        commands = fake.commands()
        stop = commands.index(("shell", "stop"))
        setting = commands.index(("shell", "setprop", "dalvik.vm.heapsize", "512m"))
        start = commands.index(("shell", "start"))
        self.assertGreaterEqual(commands[stop:setting].count(("shell", "pidof", "zygote")), 3)
        self.assertGreaterEqual(commands[stop:setting].count(("shell", "pidof", "zygote64")), 3)
        for pid in (101, 102, 103):
            self.assertIn(("shell", "test", "-d", f"/proc/{pid}"), commands[stop:setting])
        self.assertIn(("shell", "getprop", "dalvik.vm.heapsize"), commands[setting:start])
        self.assertEqual(report["heapBeforeStart"], "512m")
        self.assertTrue(report["appliedBeforeZygote"])
        self.assertEqual(report["requestedHeapBytes"], 536870912)
        self.assertEqual(report["oldPids"], fake.old)
        self.assertEqual(report["newPids"], fake.new)
        self.assertEqual(report["binderReady"], {"activity": True, "package": True})
        self.assertEqual(report["originalShellUid"], 2000)
        self.assertEqual(report["finalShellUid"], 2000)
        self.assertEqual(report["beforeProperties"]["dalvik.vm.heapgrowthlimit"],
                         report["afterProperties"]["dalvik.vm.heapgrowthlimit"])
        self.assertTrue(all(phase["passed"] for phase in report["phases"]))
        self.assertLessEqual(report["allFrameworkProcessesStoppedSeconds"], report["heapAppliedSeconds"])

    def test_missing_explicit_guard_or_emulator_serial_runs_no_adb_commands(self):
        for serial, disposable in (("emulator-5554", False), ("physical-device", True), (None, True)):
            with self.subTest(serial=serial, disposable=disposable):
                fake = FakeAdb()
                report = self.execute(fake, serial=serial, disposable=disposable)
                self.assertFalse(report["passed"])
                self.assertEqual(fake.events, [])

    def test_api_qemu_debuggable_and_zygote_guards_precede_all_mutations(self):
        for name, value in (("ro.build.version.sdk", "35"), ("ro.kernel.qemu", "0"),
                            ("ro.debuggable", "0"), ("ro.zygote", "unknown")):
            with self.subTest(property=name):
                fake = FakeAdb()
                fake.props[name] = value
                report = self.execute(fake)
                self.assertFalse(report["passed"])
                self.assertEqual(fake.mutations(), [])

    def test_successful_adb_root_exit_cannot_substitute_for_uid_zero(self):
        fake = FakeAdb("root_denied")
        report = self.execute(fake)
        self.assertFalse(report["passed"])
        self.assertEqual(fake.mutations(), [("root",)])
        self.assertIn("UID 0", report["error"])

    def test_stuck_secondary_and_renamed_old_process_prevent_heap_mutation(self):
        for scenario in ("secondary_stuck", "old_pid_renamed", "pidof_error", "stop_timeout"):
            with self.subTest(scenario=scenario):
                fake = FakeAdb(scenario)
                report = self.execute(fake)
                self.assertFalse(report["passed"])
                self.assertEqual(fake.mutations(), [("root",), ("shell", "stop")])
                self.assertFalse(report["appliedBeforeZygote"])
                self.assert_no_start(fake)

    def test_wrong_heap_readback_never_starts_framework(self):
        fake = FakeAdb("bad_readback")
        report = self.execute(fake)
        self.assertFalse(report["passed"])
        self.assertEqual(report["heapBeforeStart"], "256m")
        self.assertFalse(report["appliedBeforeZygote"])
        self.assert_no_start(fake)

    def test_binder_errors_zero_exit_and_new_pid_failures_never_retry_start(self):
        for scenario in ("activity_error", "package_error", "old_pid_after_start",
                         "new_server_missing", "pid_changes_during_binder", "boot_incomplete"):
            with self.subTest(scenario=scenario):
                fake = FakeAdb(scenario)
                report = self.execute(fake)
                self.assertFalse(report["passed"])
                self.assertEqual(fake.commands().count(("shell", "stop")), 1)
                self.assertEqual(fake.commands().count(("shell", "start")), 1)
                self.assertNotIn(("unroot",), fake.commands())
                self.assertTrue(report["appliedBeforeZygote"])

    def test_restore_uid_failure_fails_the_preparation(self):
        fake = FakeAdb("restore_denied")
        report = self.execute(fake)
        self.assertFalse(report["passed"])
        self.assertEqual(report["originalShellUid"], 2000)
        self.assertEqual(report["finalShellUid"], 0)
        self.assertEqual(fake.commands().count(("unroot",)), 1)
        self.assertEqual(fake.commands().count(("shell", "start")), 1)

    def test_observed_unroot_closed_requires_fresh_identity_and_framework_proof(self):
        fake = FakeAdb("unroot_closed")
        report = self.execute(fake)
        self.assertTrue(report["passed"], report.get("error"))
        mutation = next(row for row in report["mutations"] if row["arguments"] == ["unroot"])
        self.assertEqual(mutation["exitCode"], 1)
        self.assertEqual(mutation["output"], "adb: unable to connect for unroot: closed\n")
        evidence = report["shellIdentityRestoration"]
        self.assertTrue(evidence["unrootTransportClosed"])
        self.assertEqual(evidence["unrootExitCode"], 1)
        self.assertTrue(evidence["originalUidObserved"])
        self.assertTrue(evidence["finalUidConfirmed"])
        self.assertEqual(evidence["binderReady"], {"activity": True, "package": True})
        self.assertTrue(evidence["pidsRetained"] and evidence["heapPreserved"] and evidence["verified"])
        self.assertEqual(report["newPids"], fake.new)
        commands = fake.commands()
        restored = commands[commands.index(("unroot",)) + 1:]
        first_uid = restored.index(("shell", "id", "-u"))
        binder = restored.index(("shell", "cmd", "activity", "get-config"))
        self.assertLess(first_uid, binder)
        self.assertIn(("shell", "id", "-u"), restored[binder + 1:])
        self.assertEqual(commands.count(("unroot",)), 1)
        self.assertEqual(commands.count(("root",)), 1)
        self.assertEqual(commands.count(("shell", "stop")), 1)
        self.assertEqual(commands.count(("shell", "start")), 1)

    def test_closed_without_observed_uid_restoration_reaches_original_deadline(self):
        fake = FakeAdb("unroot_closed_stays_root")
        report = self.execute(fake)
        self.assertFalse(report["passed"])
        self.assertEqual(report["finalShellUid"], 0)
        self.assertFalse(report["shellIdentityRestoration"]["verified"])
        phase = report["phases"][-1]
        self.assertEqual((phase["name"], phase["timeoutSeconds"]), ("restore-shell-identity", 30))
        self.assertAlmostEqual(phase["seconds"], 30, places=2)
        commands = fake.commands()
        restored = commands[commands.index(("unroot",)) + 1:]
        self.assertNotIn(("shell", "cmd", "activity", "get-config"), restored)
        self.assertEqual(commands.count(("unroot",)), 1)
        self.assertEqual(commands.count(("shell", "start")), 1)

    def test_generic_unroot_failures_are_not_reclassified_as_disconnects(self):
        for scenario in ("unroot_generic_error", "unroot_other_closed", "unroot_stdout_closed"):
            with self.subTest(scenario=scenario):
                fake = FakeAdb(scenario)
                report = self.execute(fake)
                self.assertFalse(report["passed"])
                self.assertIsNone(report["finalShellUid"])
                self.assertFalse(report["shellIdentityRestoration"]["unrootTransportClosed"])
                self.assertEqual(fake.restore_waits, 0)
                self.assertEqual(fake.restore_uid_reads, 0)
                self.assertEqual(fake.commands().count(("unroot",)), 1)

    def test_unroot_mutation_timeout_is_not_retried_or_turned_into_readiness(self):
        fake = FakeAdb("unroot_timeout")
        report = self.execute(fake)
        self.assertFalse(report["passed"])
        self.assertFalse(report["shellIdentityRestoration"]["verified"])
        self.assertEqual(fake.restore_waits, 0)
        self.assertEqual(fake.restore_uid_reads, 0)
        self.assertEqual(fake.commands().count(("unroot",)), 1)

    def test_read_only_reconnection_can_observe_timeout_closed_and_old_uid(self):
        fake = FakeAdb("restore_transient_transport")
        report = self.execute(fake)
        self.assertTrue(report["passed"], report.get("error"))
        evidence = report["shellIdentityRestoration"]
        self.assertEqual(evidence["waitTimeouts"], 1)
        self.assertEqual(evidence["transportDisconnectObservations"], 2)
        self.assertEqual(evidence["uidObservations"], 2)
        self.assertTrue(evidence["verified"])
        self.assertEqual(fake.commands().count(("unroot",)), 1)
        self.assertEqual(fake.commands().count(("root",)), 1)
        self.assertEqual(fake.commands().count(("shell", "stop")), 1)
        self.assertEqual(fake.commands().count(("shell", "start")), 1)
        self.assertLess(report["phases"][-1]["seconds"], 30)

    def test_reconnection_waits_cannot_extend_original_phase_budget(self):
        fake = FakeAdb("restore_wait_timeout")
        report = self.execute(fake)
        self.assertFalse(report["passed"])
        self.assertIsNone(report["finalShellUid"])
        self.assertEqual(report["phases"][-1]["timeoutSeconds"], 30)
        self.assertAlmostEqual(report["phases"][-1]["seconds"], 30, places=2)
        self.assertFalse(report["shellIdentityRestoration"]["verified"])
        self.assertEqual(fake.commands().count(("unroot",)), 1)

    def test_unknown_reconnect_errors_and_malformed_uids_fail_without_waiting_into_success(self):
        for scenario in ("restore_wait_error", "restore_uid_error", "restore_uid_unexpected", "restore_uid_malformed"):
            with self.subTest(scenario=scenario):
                fake = FakeAdb(scenario)
                report = self.execute(fake)
                self.assertFalse(report["passed"])
                self.assertFalse(report["shellIdentityRestoration"]["verified"])
                self.assertLessEqual(fake.restore_uid_reads, 1)
                self.assertEqual(fake.restore_waits, 1)
                self.assertEqual(fake.commands().count(("unroot",)), 1)

    def test_observed_uid_does_not_hide_changed_framework_heap_binder_or_final_identity(self):
        for scenario in ("restore_pid_changed", "restore_binder_error", "restore_heap_changed", "restore_growth_changed",
                         "restore_final_uid_changed", "restore_final_uid_stderr"):
            with self.subTest(scenario=scenario):
                fake = FakeAdb(scenario)
                report = self.execute(fake)
                self.assertFalse(report["passed"])
                self.assertTrue(report["shellIdentityRestoration"]["originalUidObserved"])
                self.assertFalse(report["shellIdentityRestoration"]["verified"])
                self.assertEqual(report["phase"], "restore-shell-identity")
                self.assertLessEqual(report["phases"][-1]["seconds"], 30)
                self.assertEqual(fake.commands().count(("unroot",)), 1)
                self.assertEqual(fake.commands().count(("shell", "stop")), 1)
                self.assertEqual(fake.commands().count(("shell", "start")), 1)

    def test_initial_root_is_preserved_and_not_unrooted(self):
        fake = FakeAdb(uid=0)
        report = self.execute(fake)
        self.assertTrue(report["passed"], report.get("error"))
        self.assertEqual((report["originalShellUid"], report["finalShellUid"]), (0, 0))
        self.assertNotIn(("unroot",), fake.commands())

    def test_observed_api29_fork_rename_waits_for_unique_framework_owners(self):
        fake = FakeAdb()
        fake.new = {"zygote": [3787], "zygote64": [3784], "system_server": [3821]}
        # Actual run 44024845939 snapshots: the three pidof calls are not atomic.
        partial = {"zygote": [], "zygote64": [3784], "system_server": []}
        mixed = {"zygote": [3787], "zygote64": [3784, 3821], "system_server": [3821]}
        fake.pid_sequences["started"] = [partial, mixed, None]
        report = self.execute(fake)
        self.assertTrue(report["passed"], report.get("error"))
        self.assertEqual(report["newPids"], fake.new)
        self.assertEqual(report["incompletePidReads"], 2)
        self.assertEqual(report["lastIncompletePids"], mixed)
        commands = fake.commands()
        start = commands.index(("shell", "start"))
        binder = commands.index(("shell", "cmd", "activity", "get-config"))
        self.assertEqual(commands[start:binder].count(("shell", "pidof", "zygote")), 3)
        self.assertEqual(commands.count(("shell", "stop")), 1)
        self.assertEqual(commands.count(("shell", "start")), 1)
        phase = next(row for row in report["phases"] if row["name"] == "start-and-readiness")
        self.assertEqual(phase["timeoutSeconds"], 120)

    def test_persistent_ambiguity_reaches_original_deadline_without_start_retry(self):
        ambiguous = (
            {"zygote": [201], "zygote64": [202, 203], "system_server": [203]},
            {"zygote": [203], "zygote64": [202], "system_server": [203]},
        )
        for snapshot in ambiguous:
            with self.subTest(snapshot=snapshot):
                fake = FakeAdb()
                fake.pid_sequences["started"] = [snapshot]
                report = self.execute(fake)
                self.assertFalse(report["passed"])
                self.assertEqual(report["newPids"], {})
                self.assertEqual(report["phase"], "start-and-readiness")
                phase = report["phases"][-1]
                self.assertEqual(phase["timeoutSeconds"], 120)
                self.assertAlmostEqual(phase["seconds"], 120, places=2)
                self.assertGreater(report["incompletePidReads"], 1)
                self.assertEqual(fake.commands().count(("shell", "stop")), 1)
                self.assertEqual(fake.commands().count(("shell", "start")), 1)
                self.assertNotIn(("shell", "cmd", "activity", "get-config"), fake.commands())
                self.assertNotIn(("unroot",), fake.commands())

    def test_transient_children_in_guard_and_root_are_observed_without_repeating_root(self):
        for position in (0, 1):
            with self.subTest(position=position):
                fake = FakeAdb()
                extra = {**fake.old, "zygote64": [102, 104]}
                fake.pid_sequences["original"] = [None] * position + [extra, None]
                report = self.execute(fake)
                self.assertTrue(report["passed"], report.get("error"))
                self.assertEqual(report["oldPids"], fake.old)
                self.assertEqual(report["lastIncompletePids"], extra)
                self.assertEqual(fake.commands().count(("root",)), 1)
                self.assertEqual(fake.commands().count(("shell", "stop")), 1)
                self.assertEqual(fake.commands().count(("shell", "start")), 1)

    def test_late_fork_keeps_accepted_owners_through_binder_final_and_unroot_checks(self):
        for position, location in ((1, "after Binder"), (2, "final check"), (3, "after unroot")):
            with self.subTest(location=location):
                fake = FakeAdb()
                extra = {**fake.new, "zygote64": [202, 204]}
                fake.pid_sequences["started"] = [None] * position + [extra, None]
                report = self.execute(fake)
                self.assertTrue(report["passed"], report.get("error"))
                self.assertEqual(report["newPids"], fake.new)
                self.assertEqual(report["lastIncompletePids"], extra)
                self.assertEqual(report["finalShellUid"], 2000)
                self.assertEqual(fake.commands().count(("shell", "stop")), 1)
                self.assertEqual(fake.commands().count(("shell", "start")), 1)
                self.assertEqual(fake.commands().count(("unroot",)), 1)

    def test_extra_children_cannot_hide_the_loss_of_an_accepted_owner(self):
        for name in ("zygote", "zygote64", "system_server"):
            with self.subTest(name=name):
                fake = FakeAdb()
                replaced = {**fake.new, name: [204, 205]}
                fake.pid_sequences["started"] = [None, replaced, None]
                report = self.execute(fake)
                self.assertFalse(report["passed"])
                self.assertIn("PIDs changed", report["error"])
                self.assertEqual(report["newPids"], fake.new)
                self.assertEqual(fake.pid_polls["started"], 2)
                self.assertEqual(fake.commands().count(("shell", "start")), 1)

    def test_old_pid_in_initial_or_late_ambiguous_snapshot_cannot_wait_into_success(self):
        for position in (0, 1, 2, 3):
            with self.subTest(position=position):
                fake = FakeAdb()
                extra_old = {**fake.new, "zygote64": [202, 102]}
                fake.pid_sequences["started"] = [None] * position + [extra_old, None]
                report = self.execute(fake)
                self.assertFalse(report["passed"])
                self.assertIn("old framework PID reappeared", report["error"])
                self.assertEqual(fake.pid_polls["started"], position + 1)
                self.assertEqual(fake.commands().count(("shell", "start")), 1)

    def test_duplicate_pid_inside_one_command_is_malformed_not_a_rename(self):
        fake = FakeAdb()
        fake.pid_sequences["started"] = [{**fake.new, "zygote64": [202, 202]}]
        report = self.execute(fake)
        self.assertFalse(report["passed"])
        self.assertIn("Repeated PID in one lookup", report["error"])
        self.assertEqual(fake.commands().count(("shell", "start")), 1)

    def test_single_arch_mapping_rejects_an_unexpected_other_zygote(self):
        fake = FakeAdb()
        fake.props["ro.zygote"] = "zygote64"
        report = self.execute(fake)
        self.assertFalse(report["passed"])
        self.assertEqual(fake.mutations(), [])

    def test_oversized_adb_output_is_bounded_and_rejected_before_mutation(self):
        fake = FakeAdb("oversized_property")
        report = self.execute(fake)
        self.assertFalse(report["passed"])
        self.assertEqual(fake.mutations(), [])
        self.assertIn("bound", report["error"])

    def test_run11_binder_and_name_loss_stay_failed_before_read_only_diagnostics(self):
        fake = FakeAdb("run11_binder_name_loss")
        # Actual run11 codes, messages and PID/name observations. Subsequent
        # diagnostic bytes are explicit synthetic fixtures, not recovered logs.
        fake.old = {"zygote": [1665], "zygote64": [1664], "system_server": [1919]}
        fake.new = {"zygote": [3394], "zygote64": [3393], "system_server": [3443]}
        report = self.execute(fake)
        self.assertFalse(report["passed"])
        self.assertEqual(report["error"], "PreparationError: Framework PIDs changed during Binder readiness checks")
        self.assertEqual(report["newPids"], fake.new)
        self.assertEqual(report["lastReadyPids"], {"zygote": [3394], "zygote64": [], "system_server": []})
        binder = [row for row in report["recentCommands"] if row["arguments"][:2] == ["shell", "cmd"]]
        self.assertEqual([row["exitCode"] for row in binder], [224, 224])
        evidence = report["failureDiagnostics"]
        self.assertEqual(evidence["triggerError"], report["error"])
        self.assertTrue(evidence["collectionFinished"])
        self.assertGreaterEqual(evidence["startedSeconds"], report["failedAfterSeconds"])
        commands = [row["arguments"] for row in evidence["commands"]]
        self.assertEqual(commands[0], ["shell", "cat", "/proc/3393/stat", "/proc/3394/stat", "/proc/3443/stat"])
        self.assertIn(["shell", "cat", "/proc/3393/stat", "/proc/3393/status", "/proc/3393/cmdline"], commands)
        self.assertTrue(all(args[0] == "shell" and args[1] in ("cat", "logcat", "dmesg", "ps", "getprop", "dumpsys") for args in commands))
        self.assertTrue(all("-c" not in args and "--clear" not in args for args in commands))
        self.assertEqual(fake.mutations(), [("root",), ("shell", "stop"),
                                           ("shell", "setprop", "dalvik.vm.heapsize", "512m"), ("shell", "start")])
        self.assertEqual(fake.commands().count(("shell", "cmd", "activity", "get-config")), 1)
        self.assertEqual(fake.commands().count(("shell", "cmd", "package", "path", "android")), 1)
        self.assertEqual(fake.pid_polls["started"], 2)
        raw = b"synthetic diagnostic fixture\x00raw bytes\xff\n"
        self.assertEqual(evidence["commands"][0]["stdout"]["sha256"], hashlib.sha256(raw).hexdigest())

    def test_failed_diagnostic_timeout_has_separate_fixed_budget_and_never_retries_setup(self):
        fake = FakeAdb("run11_binder_name_loss")
        fake.diagnostic_mode = "timeout"
        report = self.execute(fake)
        evidence = report["failureDiagnostics"]
        self.assertFalse(report["passed"])
        self.assertIn("PIDs changed", report["error"])
        self.assertEqual(evidence["timeoutSeconds"], 12)
        self.assertAlmostEqual(evidence["seconds"], 12, places=3)
        self.assertTrue(evidence["deadlineExhausted"])
        attempted = [row for row in evidence["commands"] if row["attempted"]]
        skipped = [row for row in evidence["commands"] if not row["attempted"]]
        self.assertEqual(len(attempted), 6)
        self.assertTrue(all(row["timedOut"] for row in attempted))
        self.assertTrue(skipped and all(row["skipped"] == "Diagnostic deadline exhausted" for row in skipped))
        self.assertTrue(all(timeout <= 2 for _, timeout, _ in fake.diagnostic_events))
        self.assertEqual(report["phase"], "start-and-readiness")
        self.assertEqual(report["phases"][-1]["timeoutSeconds"], 120)
        self.assertLess(report["phases"][-1]["seconds"], 1)
        self.assertEqual(fake.commands().count(("shell", "start")), 1)
        self.assertNotIn(("unroot",), fake.commands())

    def test_diagnostic_errors_do_not_mask_original_failure_or_claim_empty_logs(self):
        fake = FakeAdb("run11_binder_name_loss")
        fake.diagnostic_mode = "collector_error"
        report = self.execute(fake)
        self.assertFalse(report["passed"])
        self.assertEqual(report["error"], "PreparationError: Framework PIDs changed during Binder readiness checks")
        entries = report["failureDiagnostics"]["commands"]
        self.assertTrue(entries)
        for entry in entries:
            self.assertIn("synthetic diagnostic transport failure", entry["collectorError"])
            self.assertEqual(entry["stdout"], {"available": False})
            self.assertEqual(entry["stderr"], {"available": False})
        self.assertEqual(fake.commands().count(("shell", "start")), 1)

    def test_success_and_unconfirmed_guest_guards_never_collect_failure_logs(self):
        fake = FakeAdb()
        report = self.execute(fake)
        self.assertTrue(report["passed"])
        self.assertNotIn("failureDiagnostics", report)
        self.assertEqual(fake.diagnostic_events, [])
        for serial, disposable in (("physical-device", True), ("emulator-5554", False)):
            fake = FakeAdb()
            report = self.execute(fake, serial=serial, disposable=disposable)
            self.assertFalse(report["passed"])
            self.assertFalse(report["failureDiagnostics"]["attempted"])
            self.assertEqual(fake.diagnostic_events, [])
        fake = FakeAdb()
        fake.props["ro.build.version.sdk"] = "35"
        report = self.execute(fake)
        self.assertFalse(report["failureDiagnostics"]["attempted"])
        self.assertEqual(fake.diagnostic_events, [])

    def test_existing_failure_bundle_is_preserved_without_masking_failure(self):
        fake = FakeAdb("run11_binder_name_loss")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "preparation.json"
            raw = Path(directory) / "preparation-diagnostics"
            raw.mkdir()
            previous = raw / "previous.txt"
            previous.write_bytes(b"earlier immutable failure evidence")
            fake.report_path = path
            task = prepare.Preparation("emulator-5554", True, path, adb="fake-adb", command_runner=fake.run,
                                       diagnostic_runner=fake.diagnose, monotonic=fake.clock.monotonic, sleep=fake.clock.sleep)
            report = task.run()
            self.assertFalse(report["passed"])
            self.assertIn("PIDs changed", report["error"])
            self.assertIn("FileExistsError", report["failureDiagnostics"]["collectorError"])
            self.assertEqual(previous.read_bytes(), b"earlier immutable failure evidence")
            self.assertEqual(fake.diagnostic_events, [])

    def test_raw_diagnostic_subprocess_cannot_exceed_file_limit(self):
        # A local Python writer exercises the actual file cap; no ADB or app runs.
        with tempfile.TemporaryDirectory() as directory:
            out, err = Path(directory) / "out.bin", Path(directory) / "err.bin"
            outcome = prepare.run_diagnostic_command(
                [sys.executable, "-c", "import os; os.write(1, b'x'*65536); os.write(2, b'y'*65536)"],
                2, out, err, 1024)
            self.assertFalse(outcome["timedOut"])
            self.assertLessEqual(out.stat().st_size, 1024)
            self.assertLessEqual(err.stat().st_size, 1024)
            self.assertEqual(out.read_bytes(), b"x" * 1024)


if __name__ == "__main__":
    unittest.main(verbosity=2)
