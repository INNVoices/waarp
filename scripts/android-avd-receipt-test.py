#!/usr/bin/env python3
"""Host-only negative fixtures; no emulator, SDK tools or ADB are launched."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("avd_receipt", Path(__file__).with_name("android-avd-receipt.py"))
receipt = importlib.util.module_from_spec(spec)
spec.loader.exec_module(receipt)


class HostReceiptTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.sdk, self.avd, self.proc = (self.root / name for name in ("sdk", "avd", "proc"))
        self.image = "system-images/android-36.1/google_apis_ps16k/x86_64"
        self.write(self.avd / "test.ini", f"target=android-36\npath={self.avd}/test.avd\n")
        self.write(self.avd / "test.avd/config.ini", f"image.sysdir.1={self.image}/\nhw.gpu.mode=auto\n")
        self.write(self.avd / "test.avd/hardware-qemu.ini", "hw.gpu.enabled=true\nhw.gpu.mode=software\nhw.ramSize=2048\n")
        self.write(self.sdk / "emulator/source.properties", "Pkg.Revision=37.3.10\nPkg.BuildId=16970787\n")
        self.write(self.sdk / "cmdline-tools/19.0/source.properties", "Pkg.Revision=19.0\n")
        (self.sdk / "cmdline-tools/latest").symlink_to("19.0", target_is_directory=True)
        self.write(self.sdk / self.image / "source.properties", "Pkg.Revision=4\nAndroidVersion.ApiLevel=36.1\n")
        self.write(self.sdk / "emulator/lib/advancedFeatures.ini", "GLDirectMem=on\nHasSharedSlotsHostMemoryAllocator=on\n")
        self.executable = self.sdk / "emulator/qemu/linux-x86_64/qemu-system-x86_64"
        self.write(self.executable, "fixture, not executable")
        self.args = [str(self.executable), "-avd", "test", "-port", "5554", "-gpu", "software", "-no-snapshot"]
        self.process(321, self.args)
        self.output = self.root / "output/host-avd.json"

    def write(self, path, content):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")

    def process(self, pid, args, executable=None):
        directory = self.proc / str(pid)
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "exe").symlink_to(executable or self.executable)
        (directory / "cmdline").write_bytes(b"\0".join(value.encode() for value in args) + b"\0")

    def collect(self, **overrides):
        args = {"sdk_root": self.sdk, "avd_home": self.avd, "avd_name": "test", "port": 5554,
                "report_path": self.output, "disposable_ci_host": True, "proc_root": self.proc}
        args.update(overrides)
        return receipt.capture(**args)

    def test_complete_receipt_binds_versions_gpu_and_owned_argv_without_acceptance_claim(self):
        before = {p: hashlib.sha256(p.read_bytes()).hexdigest() for base in (self.sdk, self.avd, self.proc)
                  for p in base.rglob("*") if p.is_file() and not p.is_symlink()}
        report = self.collect()
        self.assertTrue(report["collectionComplete"])
        self.assertTrue(report["targetMajorMatchesImage"])
        self.assertEqual(report["runtimeAcceptance"], "not-assessed")
        self.assertFalse(report["hostOrGuestModified"])
        self.assertIsNone(report["effectiveEmulatorApiLevel"])
        self.assertFalse(report["hostFeatureNegotiationVerified"])
        self.assertEqual(report["files"]["commandLineToolsVersion"]["resolvedRelativePath"],
                         "cmdline-tools/19.0/source.properties")
        self.assertIn(["-gpu", "software"], report["emulatorProcesses"][0]["argvAllowlist"])
        self.assertEqual(before, {p: hashlib.sha256(p.read_bytes()).hexdigest() for p in before})

    def test_wrong_target_is_observed_without_fabricating_effective_host_api_or_fix(self):
        self.write(self.avd / "test.ini", f"target=android-0\npath={self.avd}/test.avd\n")
        report = self.collect()
        self.assertTrue(report["collectionComplete"])
        self.assertFalse(report["targetMajorMatchesImage"])
        self.assertEqual(report["files"]["avdRoot"]["properties"], {"target": "android-0"})
        self.assertIsNone(report["effectiveEmulatorApiLevel"])

    def test_action_appended_config_values_are_preserved_without_claiming_effective_settings(self):
        self.write(self.avd / "test.avd/config.ini",
                   f"image.sysdir.1={self.image}/\nhw.cpu.ncore=4\nhw.cpu.ncore=2\n"
                   "disk.dataPartition.size=6G\ndisk.dataPartition.size=4096M\nhw.keyboard=no\nhw.keyboard=yes\n")
        report = self.collect()
        self.assertTrue(report["collectionComplete"])
        values = report["files"]["avdConfig"]["repeatedPropertyValuesInFileOrder"]
        self.assertEqual(values["hw.cpu.ncore"], ["4", "2"])
        self.assertEqual(values["disk.dataPartition.size"], ["6G", "4096M"])
        self.assertNotIn("hw.keyboard", values)

    def test_repeated_image_identity_is_ambiguous_even_if_values_match(self):
        self.write(self.avd / "test.avd/config.ini", f"image.sysdir.1={self.image}/\nimage.sysdir.1={self.image}/\n")
        report = self.collect()
        self.assertFalse(report["collectionComplete"])
        self.assertNotIn("imageVersion", report["files"])

    def test_secrets_unknown_properties_argv_and_absolute_paths_are_not_exported(self):
        self.write(self.avd / "test.avd/config.ini",
                   f"image.sysdir.1={self.image}/\nhttp.proxy.password=SUPER_SECRET_PASSWORD\n")
        args = self.args + ["-http-proxy", "http://user:SUPER_SECRET_PASSWORD@host", "-grpc-token", "SUPER_SECRET_TOKEN",
                            "-feature", "GLDirectMem,-HasSharedSlotsHostMemoryAllocator,UnrelatedFeature"]
        (self.proc / "321/cmdline").write_bytes(b"\0".join(value.encode() for value in args) + b"\0")
        report = self.collect()
        self.assertTrue(report["collectionComplete"])
        text = self.output.read_text()
        self.assertNotIn("SUPER_SECRET", text)
        self.assertNotIn(str(self.root), text)
        self.assertNotIn("http.proxy.password", text)
        self.assertNotIn("UnrelatedFeature", text)

    def test_no_host_ownership_or_unsafe_avd_name_refuses_before_any_output(self):
        for overrides in ({"disposable_ci_host": False}, {"avd_name": "../test"}, {"avd_name": "/etc"}):
            with self.subTest(overrides=overrides), self.assertRaises(receipt.ReceiptError):
                self.collect(**overrides)
            self.assertFalse(self.output.exists())

    def test_existing_receipt_is_never_overwritten(self):
        self.write(self.output, "earlier evidence")
        with self.assertRaises(receipt.ReceiptError):
            self.collect()
        self.assertEqual(self.output.read_text(), "earlier evidence")

    def test_root_ini_arbitrary_content_path_is_not_followed(self):
        secret_dir = self.root / "private"
        self.write(secret_dir / "config.ini", "password=UNRELATED_SECRET\n")
        self.write(self.avd / "test.ini", f"target=android-36\npath={secret_dir}\n")
        report = self.collect()
        self.assertFalse(report["collectionComplete"])
        self.assertFalse(report["avdContentPathMatchesExpected"])
        self.assertNotIn("UNRELATED_SECRET", self.output.read_text())

    def test_traversal_in_image_path_never_selects_another_source_properties(self):
        self.write(self.avd / "test.avd/config.ini", "image.sysdir.1=../../private/\n")
        report = self.collect()
        self.assertFalse(report["collectionComplete"])
        self.assertNotIn("imageVersion", report["files"])

    def test_symlinked_file_and_symlinked_directory_escape_fail_closed(self):
        for kind in ("file", "directory"):
            with self.subTest(kind=kind):
                outside = self.root / "private/source.properties"
                self.write(outside, "Pkg.Revision=SECRET_VERSION\n")
                if kind == "file":
                    path = self.sdk / "emulator/source.properties"
                    path.unlink()
                    path.symlink_to(outside)
                else:
                    latest = self.sdk / "cmdline-tools/latest"
                    latest.unlink()
                    latest.symlink_to(outside.parent)
                output = self.root / (kind + ".json")
                report = self.collect(report_path=output)
                self.assertFalse(report["collectionComplete"])
                self.assertNotIn("SECRET_VERSION", output.read_text())

    def test_switching_latest_after_containment_check_cannot_redirect_the_open(self):
        import os
        outside = self.root / "outside/source.properties"
        self.write(outside, "Pkg.Revision=OUTSIDE_CANARY\n")
        latest = self.sdk / "cmdline-tools/latest"
        original_read = receipt.read_regular
        switched = []

        def switch_before_read(path, *, dir_fd=None):
            if dir_fd is not None and os.readlink(f"/proc/self/fd/{dir_fd}") == str(self.sdk / "cmdline-tools/19.0"):
                latest.unlink()
                latest.symlink_to(outside.parent)
                switched.append(True)
            return original_read(path, dir_fd=dir_fd)

        with patch.object(receipt, "read_regular", side_effect=switch_before_read):
            report = self.collect()
        self.assertEqual(switched, [True])
        self.assertTrue(report["collectionComplete"])
        self.assertEqual(report["files"]["commandLineToolsVersion"]["properties"], {"Pkg.Revision": "19.0"})
        self.assertNotIn("OUTSIDE_CANARY", self.output.read_text())

    def test_oversized_or_duplicate_properties_do_not_look_complete(self):
        path = self.sdk / "emulator/source.properties"
        for content in ("x" * receipt.FILE_LIMIT, "Pkg.Revision=37.3.10\nPkg.Revision=1\n", "# no version\n"):
            with self.subTest(length=len(content)):
                self.write(path, content)
                output = self.root / (str(len(content)) + ".json")
                report = self.collect(report_path=output)
                self.assertFalse(report["collectionComplete"])
                self.assertFalse(report["files"]["emulatorVersion"]["available"])

    def test_fifo_is_rejected_without_a_blocking_read(self):
        import os
        path = self.sdk / "emulator/source.properties"
        path.unlink()
        os.mkfifo(path)
        report = self.collect()
        self.assertFalse(report["collectionComplete"])
        self.assertLess(report["elapsedSeconds"], receipt.TOTAL_SECONDS)

    def test_foreign_executable_or_wrong_avd_or_wrong_port_cannot_supply_process_evidence(self):
        for change in ("executable", "avd", "port"):
            with self.subTest(change=change):
                args = list(self.args)
                executable = self.executable
                if change == "executable":
                    executable = self.root / "private/qemu-system-x86_64"
                elif change == "avd":
                    args[2] = "other"
                else:
                    args[4] = "5556"
                path = self.proc / "321/exe"
                path.unlink()
                path.symlink_to(executable)
                (self.proc / "321/cmdline").write_bytes(b"\0".join(value.encode() for value in args) + b"\0")
                report = self.collect(report_path=self.root / (change + ".json"))
                self.assertFalse(report["collectionComplete"])
                self.assertFalse(report["emulatorProcesses"])

    def test_proc_scan_and_argv_bytes_have_fixed_limits(self):
        with patch.object(receipt, "MAX_PROC_ENTRIES", 0):
            report = self.collect()
        self.assertFalse(report["collectionComplete"])
        (self.proc / "321/cmdline").write_bytes(b"x" * receipt.FILE_LIMIT)
        report = self.collect(report_path=self.root / "oversized-command.json")
        self.assertFalse(report["collectionComplete"])

    def test_deadline_failure_retains_an_incomplete_receipt(self):
        with patch.object(receipt.Collector, "within_deadline", side_effect=receipt.ReceiptError("deadline")):
            report = self.collect()
        self.assertFalse(report["collectionComplete"])
        self.assertTrue(report["errors"])
        self.assertTrue(self.output.is_file())

    def test_post_teardown_metadata_mode_never_looks_for_or_claims_live_argv(self):
        with patch.object(receipt.Collector, "processes", side_effect=AssertionError("must not inspect processes")):
            report = self.collect(metadata_only=True)
        self.assertTrue(report["collectionComplete"])
        self.assertFalse(report["processCollectionRequested"])
        self.assertEqual(report["emulatorProcesses"], [])
        self.assertEqual(report["runtimeAcceptance"], "not-assessed")

    def test_invalid_known_option_value_is_not_leaked_in_error(self):
        args = self.args + ["-gpu", "SUPER_SECRET_PASSWORD"]
        (self.proc / "321/cmdline").write_bytes(b"\0".join(value.encode() for value in args) + b"\0")
        report = self.collect()
        self.assertFalse(report["collectionComplete"])
        self.assertNotIn("SUPER_SECRET", self.output.read_text())


if __name__ == "__main__":
    unittest.main()
