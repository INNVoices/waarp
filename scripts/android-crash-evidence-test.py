#!/usr/bin/env python3
"""Collector regressions; fake ADB output is not Android runtime evidence."""
import importlib.util
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("android_crash_evidence", Path(__file__).with_name("android-crash-evidence.py"))
crashes = importlib.util.module_from_spec(spec)
spec.loader.exec_module(crashes)


class FixtureAdb:
    def __init__(self, package="local.waarp.android", *, archive=None, old=None):
        self.base = f"/data/user/0/{package}/no_backup/libbox/work"
        self.current = self.base + "/CrashReport-waarp-android.log"
        self.files = {self.current: b""}
        self.archives = []
        self.denied = set()
        self.reads = []
        self.reported_size = {}
        if old is not None:
            self.files[self.current + ".old"] = old
        if archive is not None:
            path = self.base + "/crash_reports/2026-11-16T20-00-00/go.log"
            self.files[path] = archive
            self.archives.append(path)

    def __call__(self, args, **kwargs):
        offset = args.index("exec-out") + 1
        if args[offset] == "run-as":
            offset += 2
        command = args[offset:]
        if "configuration.json" in str(command) or "metadata.json" in str(command):
            raise AssertionError("The crash collector must never read configuration/metadata.")
        if command[0] == "find":
            path = command[1]
        else:
            path = command[-1]
        if path in self.denied:
            return subprocess.CompletedProcess(args, 1, b"Permission denied\n")
        if command[0] == "find":
            if self.archives:
                return subprocess.CompletedProcess(args, 0, ("\n".join(self.archives) + "\n").encode())
            return subprocess.CompletedProcess(args, 1, b"No such file or directory\n")
        if path not in self.files:
            return subprocess.CompletedProcess(args, 1, b"No such file or directory\n")
        if command[0] == "stat":
            return subprocess.CompletedProcess(args, 0, str(self.reported_size.get(path, len(self.files[path]))).encode())
        if command[0] == "head":
            self.reads.append(path)
            return subprocess.CompletedProcess(args, 0, self.files[path][:int(command[2])])
        raise AssertionError("Unexpected remote operation: " + str(command))


class NativeCrashCollectorTest(unittest.TestCase):
    def collect(self, adb, *, package="local.waarp.android", run_as=False):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            result = crashes.collect_native_crashes(["adb", "-s", "owned-emulator"], output, package,
                                                    run_as=run_as, runner=adb)
            return result, (output / "native-crash-report.txt").read_text()

    def test_fresh_empty_current_log_and_no_archives_pass(self):
        result, _ = self.collect(FixtureAdb())
        self.assertTrue(result["passed"])
        self.assertEqual(result["archiveCount"], 0)
        self.assertEqual(result["bytes"], 0)

    def test_restart_cannot_hide_panic_behind_empty_current_file(self):
        adb = FixtureAdb(archive=b"panic: native fault\ngoroutine 7 [running]:\n")
        result, text = self.collect(adb)
        self.assertTrue(result["available"])
        self.assertFalse(result["passed"])
        self.assertTrue(result["panicObserved"])
        self.assertEqual(result["archiveCount"], 1)
        self.assertIn("panic: native fault", text)
        self.assertEqual(adb.reads, [adb.current, adb.archives[0]])

    def test_old_crash_file_is_checked_with_debug_run_as(self):
        adb = FixtureAdb("local.waarp.android.debug", old=b"fatal error: native failure\n")
        result, _ = self.collect(adb, package="local.waarp.android.debug", run_as=True)
        self.assertFalse(result["passed"])
        self.assertTrue(result["panicObserved"])

    def test_archive_permission_failure_is_not_empty_history(self):
        adb = FixtureAdb()
        adb.denied.add(adb.base + "/crash_reports")
        result, _ = self.collect(adb)
        self.assertFalse(result["passed"])
        self.assertFalse(result["available"])
        self.assertIn("native_evidence_command_failed", result["errors"])

    def test_missing_current_file_fails_evidence_gate(self):
        adb = FixtureAdb()
        adb.files.clear()
        result, _ = self.collect(adb)
        self.assertFalse(result["passed"])
        self.assertFalse(result["currentFileAvailable"])

    def test_oversized_archive_is_rejected_before_read(self):
        adb = FixtureAdb(archive=b"too large")
        adb.reported_size[adb.archives[0]] = crashes.MAX_BYTES + 1
        result, _ = self.collect(adb)
        self.assertFalse(result["passed"])
        self.assertIn("native_evidence_size_limit", result["errors"])
        self.assertNotIn(adb.archives[0], adb.reads)

    def test_append_between_stat_and_read_cannot_exceed_budget(self):
        adb = FixtureAdb(archive=b"x" * (crashes.MAX_BYTES + 2))
        adb.reported_size[adb.archives[0]] = 0
        result, _ = self.collect(adb)
        self.assertFalse(result["passed"])
        self.assertIn("native_evidence_size_limit", result["errors"])

    def test_archive_path_escape_is_rejected_before_read(self):
        adb = FixtureAdb()
        adb.archives = [adb.base + "/crash_reports/../../configuration.json/go.log"]
        result, _ = self.collect(adb)
        self.assertFalse(result["passed"])
        self.assertIn("native_archive_path_not_allowed", result["errors"])
        self.assertEqual(adb.reads, [adb.current])

    def test_archive_count_limit_fails_without_truncating_history(self):
        adb = FixtureAdb()
        adb.archives = [adb.base + f"/crash_reports/2026-11-16T20-00-00-{i}/go.log" for i in range(34)]
        result, _ = self.collect(adb)
        self.assertFalse(result["passed"])
        self.assertIn("native_archive_count_limit", result["errors"])
        self.assertEqual(adb.reads, [adb.current])

    def test_archived_keys_are_redacted_but_panic_remains_failure(self):
        secret_hex = "ab" * 32
        secret_base64 = "Z" * 43 + "="
        adb = FixtureAdb(archive=f"panic: bad key {secret_hex} {secret_base64}\n".encode())
        result, text = self.collect(adb)
        self.assertFalse(result["passed"])
        self.assertNotIn(secret_hex, text)
        self.assertNotIn(secret_base64, text)
        self.assertIn("panic:", text)


if __name__ == "__main__":
    unittest.main()
