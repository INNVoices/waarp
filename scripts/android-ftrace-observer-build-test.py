#!/usr/bin/env python3
"""Host-only build/receipt boundary fixtures. No NDK, ADB, observer or APK is run."""
import importlib.util
import json
import os
from pathlib import Path
import struct
import sys
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("observer_build", Path(__file__).with_name("android-ftrace-observer-build.py"))
BUILD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BUILD)


def elf_fixture(*, machine=62, alignment=16384, interpreter=b"/system/bin/linker64\0"):
    data = bytearray(768)
    data[:7] = b"\x7fELF\x02\x01\x01"
    struct.pack_into("<HHIQQQIHHHHHH", data, 16, 3, machine, 1, 512, 64, 0, 0, 64, 56, 2, 0, 0, 0)
    struct.pack_into("<IIQQQQQQ", data, 64, 1, 5, 0, 0, 0, len(data), len(data), alignment)
    struct.pack_into("<IIQQQQQQ", data, 120, 3, 4, 256, 256, 256, len(interpreter), len(interpreter), 1)
    data[256:256 + len(interpreter)] = interpreter
    return bytes(data)


class BuildTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.sdk = self.root / "sdk"
        self.ndk = self.sdk / "ndk" / BUILD.NDK_VERSION
        self.output = self.root / "out/android/ci-observer"
        self.source = self.root / "scripts" / BUILD.SOURCE
        self.write(self.source, b"/* explicit build fixture, not the observer */\nint main(void) { return 0; }\n")
        self.write(self.root / "android/native-source.json", json.dumps({"tools": {"ndkVersion": BUILD.NDK_VERSION}}).encode())
        self.write(self.ndk / "source.properties", ("Pkg.Revision = " + BUILD.NDK_VERSION + "\n").encode())
        for relative in (BUILD.COMPILER, BUILD.DRIVER):
            path = self.ndk / relative
            self.write(path, b"fixture compiler: never executed")
            path.chmod(0o755)
        self.calls = []
        self.binary = elf_fixture()
        self.mutate_source = False

    @staticmethod
    def write(path, data):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def runner(self, arguments, cwd, environment, timeout):
        self.calls.append((arguments, environment, timeout))
        if arguments[-1] == "--version":
            return {"returncode": 0, "stdout": b"Android fixture clang version 19.0.0\n", "stderr": b""}
        self.assertEqual(arguments, BUILD.expected_arguments(self.ndk, cwd))
        self.assertEqual(environment["SOURCE_DATE_EPOCH"], "1700000000")
        self.assertEqual(environment["LC_ALL"], "C")
        self.assertEqual((cwd / BUILD.SOURCE).read_bytes(), self.source.read_bytes())
        (cwd / BUILD.BINARY).write_bytes(self.binary)
        if self.mutate_source:
            self.source.write_bytes(b"changed during compilation")
        return {"returncode": 0, "stdout": b"", "stderr": b""}

    def build(self):
        return BUILD.build(self.sdk, root=self.root, runner=self.runner, identity_reader=lambda _: ("a" * 40, 1700000000))

    def test_exact_plan_retained_bytes_and_pure_replay(self):
        report = self.build()
        self.assertTrue(report["passed"])
        self.assertTrue(report["testOnly"])
        self.assertEqual(len(self.calls), 2)
        self.assertEqual([call[2] for call in self.calls], [10, 120])
        self.assertEqual((self.output / BUILD.SOURCE).read_bytes(), self.source.read_bytes())
        self.assertEqual((self.output / BUILD.BINARY).read_bytes(), self.binary)
        live = BUILD.validate_build(self.output, self.source)
        self.assertEqual(live, BUILD.validate_build(self.output))
        self.assertEqual(live["binarySha256"], BUILD.sha(self.binary))
        self.assertEqual(report["elf"]["loadSegmentAlignments"], [16384])

    def test_wrong_or_duplicate_ndk_revision_refuses_without_compile(self):
        for raw in (b"Pkg.Revision=27.0\n", ("Pkg.Revision=" + BUILD.NDK_VERSION + "\n") .encode() * 2):
            self.write(self.ndk / "source.properties", raw)
            self.assertFalse(self.build()["passed"])
            self.assertEqual(self.calls, [])

    def test_native_source_pin_cannot_be_overridden(self):
        self.write(self.root / "android/native-source.json", b'{"tools":{"ndkVersion":"29.0"}}')
        self.assertFalse(self.build()["passed"])
        self.assertEqual(self.calls, [])

    def test_compiler_link_cannot_escape_pinned_ndk(self):
        compiler = self.ndk / BUILD.COMPILER
        compiler.unlink()
        outside = self.root / "outside-compiler"
        outside.write_bytes(b"outside fixture")
        outside.chmod(0o755)
        compiler.symlink_to(outside)
        self.assertFalse(self.build()["passed"])
        self.assertEqual(self.calls, [])

    def test_actual_program_headers_reject_wrong_arch_alignment_interpreter_or_bounds(self):
        for data in (elf_fixture(machine=183), elf_fixture(alignment=4096),
                     elf_fixture(interpreter=b"/lib64/ld-linux-x86-64.so.2\0"), elf_fixture()[:100]):
            with self.subTest(size=len(data)):
                with self.assertRaises(ValueError):
                    BUILD.elf_identity(data)

    def test_input_change_during_compile_leaves_failed_receipt(self):
        self.mutate_source = True
        self.assertFalse(self.build()["passed"])
        self.assertFalse(json.loads((self.output / "build.json").read_text())["passed"])
        self.assertFalse((self.output / BUILD.BINARY).exists())

    def test_changed_binary_source_args_or_bool_identity_is_not_accepted(self):
        self.assertTrue(self.build()["passed"])
        path = self.output / "build.json"
        original = path.read_bytes()
        for edit in (lambda r: r["arguments"].remove("-Werror"), lambda r: r["elf"].update(pie=1),
                     lambda r: r.update(testOnly=False), lambda r: r.update(sourceDateEpoch=True)):
            record = json.loads(original)
            edit(record)
            path.write_text(json.dumps(record))
            with self.assertRaises(ValueError):
                BUILD.validate_build(self.output)
        path.write_bytes(original)
        (self.output / BUILD.BINARY).write_bytes(self.binary + b"tampered")
        with self.assertRaises(ValueError):
            BUILD.validate_build(self.output)
        (self.output / BUILD.BINARY).write_bytes(self.binary)
        self.source.write_bytes(b"different checked-out C")
        with self.assertRaises(ValueError):
            BUILD.validate_build(self.output, self.source)

    def test_old_success_is_invalidated_by_a_later_failed_build(self):
        self.assertTrue(self.build()["passed"])
        old_binary = (self.output / BUILD.BINARY).read_bytes()
        self.binary = elf_fixture(alignment=4096)
        self.assertFalse(self.build()["passed"])
        self.assertEqual((self.output / BUILD.BINARY).read_bytes(), old_binary)
        with self.assertRaises(ValueError):
            BUILD.validate_build(self.output)

    def test_host_command_output_and_time_budgets_are_enforced(self):
        with self.assertRaisesRegex(ValueError, "64 KiB"):
            BUILD.command([sys.executable, "-c", "import os; os.write(1,b'x'*70000)"], self.root, dict(os.environ), 5)
        with self.assertRaisesRegex(ValueError, "timed out"):
            BUILD.command([sys.executable, "-c", "import time; time.sleep(5)"], self.root, dict(os.environ), 0.1)


if __name__ == "__main__":
    unittest.main()
