#!/usr/bin/env python3
"""Host kernel inventory and exact transport boundaries, without an emulator."""
import hashlib
import importlib.util
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("image_kernel", Path(__file__).with_name("android-emulator-image.py"))
IMAGE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(IMAGE)


class KernelInventoryTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.sdk = self.root / "sdk"
        self.kernel = self.sdk / IMAGE.KERNEL_RELATIVE
        self.kernel.parent.mkdir(parents=True)
        self.content = b"regular test kernel bytes\x00\xff" * 100
        self.kernel.write_bytes(self.content)

    def record(self):
        return {"installedRelativePath": IMAGE.KERNEL_RELATIVE.as_posix(), "bytes": IMAGE.KERNEL_BYTES,
                "sha256": IMAGE.KERNEL_SHA256, "startedOffsetNs": 2_000_000_000,
                "finishedOffsetNs": 2_250_000_000, "elapsedSeconds": 0.25, "timeoutSeconds": 10}

    def test_worker_reads_exact_regular_bytes_without_accepting_them_as_reviewed(self):
        self.assertEqual(IMAGE.kernel_digest_worker(self.sdk),
                         {"bytes": len(self.content), "sha256": hashlib.sha256(self.content).hexdigest()})
        with self.assertRaisesRegex(ValueError, "differs"):
            IMAGE.inspect_installed_kernel(self.sdk, time.monotonic_ns())

    def test_leaf_symlink_is_never_followed(self):
        elsewhere = self.root / "elsewhere"
        elsewhere.write_bytes(self.content)
        self.kernel.unlink()
        self.kernel.symlink_to(elsewhere)
        with self.assertRaises(OSError):
            IMAGE.kernel_digest_worker(self.sdk)

    def test_directory_alias_is_never_followed(self):
        alias = self.root / "alias"
        alias.symlink_to(self.sdk, target_is_directory=True)
        with self.assertRaises(OSError):
            IMAGE.kernel_digest_worker(alias)

    def test_fifo_is_refused_without_waiting_for_a_writer(self):
        self.kernel.unlink()
        os.mkfifo(self.kernel)
        started = time.monotonic()
        with self.assertRaisesRegex(ValueError, "regular"):
            IMAGE.kernel_digest_worker(self.sdk)
        self.assertLess(time.monotonic() - started, 1)

    def test_oversized_kernel_refused_before_any_bytes_read(self):
        with self.kernel.open("wb") as stream:
            stream.truncate(IMAGE.KERNEL_READ_LIMIT + 1)
        with patch.object(IMAGE.os, "read", side_effect=AssertionError("oversized input must not be read")):
            with self.assertRaisesRegex(ValueError, "bounded"):
                IMAGE.kernel_digest_worker(self.sdk)

    def test_exact_inventory_and_previous_command_order(self):
        IMAGE.validate_kernel_record(self.record(), 1_000_000_000)
        with self.assertRaisesRegex(ValueError, "timing"):
            IMAGE.validate_kernel_record(self.record(), 3_000_000_000)

    def test_changed_identity_or_missing_measurements_never_validate(self):
        for key, value in [("bytes", True), ("bytes", IMAGE.KERNEL_BYTES - 1), ("sha256", "0" * 64),
                           ("installedRelativePath", "another/kernel"), ("elapsedSeconds", 0),
                           ("timeoutSeconds", 11), ("timeoutSeconds", float("nan")),
                           ("finishedOffsetNs", 60_000_000_001)]:
            with self.subTest(key=key, value=value):
                record = self.record()
                record[key] = value
                with self.assertRaises(ValueError):
                    IMAGE.validate_kernel_record(record, 0)
        record = self.record()
        del record["sha256"]
        with self.assertRaises(ValueError):
            IMAGE.validate_kernel_record(record, 0)

    def test_hash_timeout_is_limited_by_remaining_original_deadline(self):
        with patch.object(IMAGE.time, "monotonic_ns", return_value=59_000_000_000), \
             patch.object(IMAGE.subprocess, "run", side_effect=subprocess.TimeoutExpired("kernel", 1)) as run:
            with self.assertRaises(subprocess.TimeoutExpired):
                IMAGE.inspect_installed_kernel(self.sdk, 0)
        self.assertEqual(run.call_args.kwargs["timeout"], 1)
        self.assertEqual(run.call_args.args[0][-2:], ["--hash-installed-kernel", str(self.sdk)])
        self.assertEqual(run.call_args.kwargs["stdin"], subprocess.DEVNULL)

    def test_expired_original_deadline_does_not_start_hash_child(self):
        with patch.object(IMAGE.time, "monotonic_ns", return_value=60_000_000_001), \
             patch.object(IMAGE.subprocess, "run") as run:
            with self.assertRaisesRegex(ValueError, "deadline"):
                IMAGE.inspect_installed_kernel(self.sdk, 0)
        run.assert_not_called()

    def test_existing_shell_and_only_scoped_push_keep_exact_arguments(self):
        self.assertEqual(IMAGE.adb_arguments("getconf PAGE_SIZE"), ["shell", "getconf PAGE_SIZE"])
        for command in [["push", "/owned/observer", "/data/local/tmp/waarp-ci/observer"],
                        ["push", "-q", "/owned/observer", "/data/local/tmp/waarp-ci/observer"]]:
            self.assertEqual(IMAGE.adb_arguments(command), command)
        for command in [["reboot"], ["root"], ["push", "relative", "/data/local/tmp/x"],
                        ["push", "/owned/observer", "/system/bin/observer"],
                        ["push", "/owned/observer", "/data/local/tmp/../outside"],
                        ["push", "--sync", "/owned/observer", "/data/local/tmp/x"],
                        ["push", "/owned/observer\x00", "/data/local/tmp/x"]]:
            with self.subTest(command=command), self.assertRaises(ValueError):
                IMAGE.adb_arguments(command)


if __name__ == "__main__":
    unittest.main()
