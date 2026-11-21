#!/usr/bin/env python3
"""Check bounded failure-only installer observations without an SDK or emulator."""
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("android_install", Path(__file__).with_name("android-install.py"))
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)
PREFIX = ["fake-adb", "-s", "emulator-5554"]
COMMAND = ["install", "-r", "fixture.apk"]


class FakeDiagnostics:
    def __init__(self, *, qemu="1", debuggable="1", delay=0.01, fail=None):
        self.now = 0.0
        self.qemu = qemu
        self.debuggable = debuggable
        self.delay = delay
        self.fail = fail
        self.calls = []

    def monotonic(self):
        return self.now

    def run(self, arguments, timeout, stdout_path, stderr_path, limit):
        assert arguments[:3] == PREFIX
        args = arguments[3:]
        self.calls.append((args, timeout, limit))
        self.now += min(timeout, self.delay)
        if self.fail == tuple(args):
            raise OSError("fixture diagnostic read failed")
        value = ""
        if args[:2] == ["shell", "getprop"]:
            value = self.debuggable if args[2] == "ro.debuggable" else self.qemu
        elif args == ["shell", "service", "check", "package"]:
            value = "Service package: not found"
        elif args == ["shell", "service", "check", "settings"]:
            value = "Service settings: not found"
        elif args == ["shell", "pidof", "system_server", "zygote", "zygote64"]:
            value = "101 102"
        stdout_path.write_bytes(value.encode())
        stderr_path.write_bytes(b"")
        return {"exitCode": 0, "timedOut": self.delay >= timeout}


class InstallFailureTests(unittest.TestCase):
    def collect(self, root, fake):
        return installer.collect_install_failure(PREFIX, root / "install-failure.json", COMMAND,
                                                  RuntimeError("package: Broken pipe (32)"),
                                                  diagnostic_runner=fake.run, monotonic=fake.monotonic)

    def test_success_does_not_collect_or_change_install_command(self):
        with patch.object(installer, "run", return_value="Success") as run, patch.object(installer, "collect_install_failure") as collect:
            self.assertEqual(installer.install(PREFIX, COMMAND, Path("unused.json")), "Success")
            run.assert_called_once_with(PREFIX + COMMAND)
            collect.assert_not_called()

    def test_no_opt_in_keeps_original_failure_without_diagnostics(self):
        error = RuntimeError("package: Broken pipe (32)")
        with patch.object(installer, "run", side_effect=error) as run, patch.object(installer, "collect_install_failure") as collect:
            with self.assertRaises(RuntimeError) as caught:
                installer.install(PREFIX, COMMAND)
            self.assertIs(caught.exception, error)
            self.assertEqual(run.call_count, 1)
            collect.assert_not_called()

    def test_collector_failure_cannot_replace_original_install_error_or_retry(self):
        for error in (RuntimeError("Broken pipe"), subprocess.TimeoutExpired(COMMAND, 180)):
            with self.subTest(error=type(error).__name__), patch.object(installer, "run", side_effect=error) as run, patch.object(installer, "collect_install_failure", side_effect=OSError("disk full")):
                with self.assertRaises(type(error)) as caught:
                    installer.install(PREFIX, COMMAND, Path("unused.json"))
                self.assertIs(caught.exception, error)
                self.assertEqual(run.call_count, 1)

    def test_missing_services_are_retained_as_observation_not_success_or_recovery(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            fake = FakeDiagnostics()
            report = self.collect(root, fake)
            self.assertFalse(report["passed"])
            self.assertTrue(report["diagnosticsAllowed"])
            self.assertTrue(report["collectionFinished"])
            self.assertIn("Broken pipe", report["originalError"])
            self.assertEqual(report["failedCommand"], COMMAND)
            for entry in report["commands"]:
                for stream in ("stdout", "stderr"):
                    record = entry[stream]
                    data = (root / record["file"]).read_bytes()
                    self.assertEqual(record["sha256"], hashlib.sha256(data).hexdigest())
                    self.assertEqual(record["bytes"], len(data))
                args = entry["arguments"]
                self.assertEqual(args[0], "shell")
                self.assertIn(args[1], {"getprop", "logcat", "pidof", "service", "dmesg", "cat", "ps"})
                if args[1] == "service":
                    self.assertEqual(args[2], "check")
                if args[1] == "logcat":
                    self.assertIn("-d", args)
                    self.assertNotIn("-c", args)
            package = next(entry for entry in report["commands"] if entry["name"] == "package-service")
            self.assertEqual((root / package["stdout"]["file"]).read_text(), "Service package: not found")
            self.assertEqual(json.loads((root / "install-failure.json").read_text()), report)

    def test_non_qemu_or_non_debuggable_guest_does_not_dump_framework(self):
        for fake in (FakeDiagnostics(qemu="0"), FakeDiagnostics(debuggable="0")):
            with self.subTest(qemu=fake.qemu, debuggable=fake.debuggable), tempfile.TemporaryDirectory() as temp:
                report = self.collect(Path(temp), fake)
                self.assertFalse(report["diagnosticsAllowed"])
                self.assertEqual(len(fake.calls), 3)
                self.assertTrue(all(args[:2] == ["shell", "getprop"] for args, _, _ in fake.calls))

    def test_physical_serial_rejected_before_any_read(self):
        fake = FakeDiagnostics()
        with tempfile.TemporaryDirectory() as temp, self.assertRaises(ValueError):
            installer.collect_install_failure(["fake-adb", "-s", "physical123"], Path(temp) / "evidence.json", COMMAND,
                                               RuntimeError("failed"), diagnostic_runner=fake.run)
        self.assertFalse(fake.calls)

    def test_failed_additional_read_preserves_original_and_records_error(self):
        with tempfile.TemporaryDirectory() as temp:
            report = self.collect(Path(temp), FakeDiagnostics(fail=("shell", "service", "check", "package")))
            package = next(entry for entry in report["commands"] if entry["name"] == "package-service")
            self.assertIn("OSError", package["collectorError"])
            self.assertFalse(package["stdout"]["available"])
            self.assertIn("Broken pipe", report["originalError"])
            self.assertFalse(report["passed"])

    def test_shared_deadline_stops_new_reads_without_extending_timeout(self):
        with tempfile.TemporaryDirectory() as temp:
            fake = FakeDiagnostics(delay=1.9)
            report = self.collect(Path(temp), fake)
            self.assertLessEqual(fake.now, 12)
            self.assertTrue(report["deadlineExhausted"])
            self.assertTrue(any(not entry["attempted"] for entry in report["commands"]))
            self.assertTrue(all(0 < timeout <= 2 for _, timeout, _ in fake.calls))
            self.assertEqual(len({tuple(args) for args, _, _ in fake.calls}), len(fake.calls))

    def test_existing_report_never_overwritten(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            path = root / "install-failure.json"
            path.write_text("earlier failure")
            fake = FakeDiagnostics()
            with self.assertRaises(FileExistsError):
                self.collect(root, fake)
            self.assertEqual(path.read_text(), "earlier failure")
            self.assertFalse(fake.calls)

    def test_cli_requires_explicit_disposable_emulator_for_logs(self):
        for args in (("--failure-report", "unused.json"), ("--failure-report", "unused.json", "--serial", "physical123", "--disposable-emulator")):
            with self.subTest(args=args), patch("sys.argv", [str(installer.__file__), *args]), patch.object(installer, "run") as run:
                with self.assertRaises(SystemExit) as caught:
                    installer.main()
                self.assertEqual(caught.exception.code, 2)
                run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
