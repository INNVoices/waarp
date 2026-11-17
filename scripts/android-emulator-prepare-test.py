#!/usr/bin/env python3
"""Exercise API 29 preparation ordering and failures without a real ADB device."""
import importlib.util
import json
from pathlib import Path
import subprocess
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
            if self.scenario != "restore_denied":
                self.uid = 2000
            return self.result(arguments, stdout="restarting adbd as non root\n")
        if args == ("wait-for-device",):
            return self.result(arguments)
        if args == ("shell", "id", "-u"):
            return self.result(arguments, stdout=str(self.uid) + "\n")
        if args[:2] == ("shell", "getprop"):
            value = self.props.get(args[2], "")
            if self.scenario == "oversized_property" and args[2] == "ro.build.version.sdk":
                value = "x" * (prepare.MAX_COMMAND_OUTPUT + 1)
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
            if self.scenario == "activity_error":
                return self.result(arguments, stdout="Error dumping service info: (Unknown error -32) activity\n")
            return self.result(arguments, stdout="config: en-rUS-port-night-xhdpi\nabi: x86_64,x86\n")
        if args == ("shell", "cmd", "package", "path", "android"):
            if self.scenario == "package_error":
                return self.result(arguments, stdout="Error: package service is not ready\n")
            if self.scenario == "pid_changes_during_binder":
                self.new = {**self.new, "system_server": [204]}
            return self.result(arguments, stdout="package:/system/framework/framework-res.apk\n")
        raise AssertionError("Unexpected ADB command: " + repr(args))

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
            task = prepare.Preparation(serial, disposable, path, adb="fake-adb",
                                       command_runner=fake.run, monotonic=fake.clock.monotonic,
                                       sleep=fake.clock.sleep)
            report = task.run()
            self.assertEqual(json.loads(path.read_text()), report)
            self.assertIsNone(report["actualRuntimeMaxHeapBytes"])
            self.assertLessEqual(len(report["recentCommands"]), 128)
            self.assertTrue(all(len(item.get("output", "")) <= 2048 for item in report["recentCommands"]))
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
