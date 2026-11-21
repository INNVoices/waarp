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


PROGRAM = struct.pack("<BBhiBBhiBBhi", 0x85, 0, 0, 113, 0x85, 0, 0, 127, 0x95, 0, 0, 0)


def elf_fixture(*, machine=62, alignment=16384, interpreter=b"/system/bin/linker64\0", program=PROGRAM):
    data = bytearray(768)
    data[:7] = b"\x7fELF\x02\x01\x01"
    struct.pack_into("<HHIQQQIHHHHHH", data, 16, 3, machine, 1, 512, 64, 0, 0, 64, 56, 2, 0, 0, 0)
    struct.pack_into("<IIQQQQQQ", data, 64, 1, 5, 0, 0, 0, len(data), len(data), alignment)
    struct.pack_into("<IIQQQQQQ", data, 120, 3, 4, 256, 256, 256, len(interpreter), len(interpreter), 1)
    data[256:256 + len(interpreter)] = interpreter
    data[512:512 + len(program)] = program
    return bytes(data)


def bpf_fixture(*, machine=247, program=PROGRAM, license_data=b"GPL\0", extra=None):
    """Explicit synthetic ELF, never a kernel-verified program."""
    payloads = [("iter/task_file", 1, 6, program), ("license", 1, 3, license_data)]
    if extra:
        payloads.append(extra)
    names = b"\0.shstrtab\0" + b"".join(name.encode() + b"\0" for name, _, _, _ in payloads)
    payloads.insert(0, (".shstrtab", 3, 0, names))
    data, sections = bytearray(64), [(0,) * 10]
    for name, kind, flags, payload in payloads:
        offset = len(data)
        data.extend(payload)
        sections.append((names.index(name.encode() + b"\0"), kind, flags, 0, offset, len(payload), 0, 0, 1, 0))
    section_offset = len(data)
    for section in sections:
        data.extend(struct.pack("<IIQQQQIIQQ", *section))
    data[:7] = b"\x7fELF\x02\x01\x01"
    struct.pack_into("<HHIQQQIHHHHHH", data, 16, 1, machine, 1, 0, 0, section_offset, 0, 64, 0, 0, 64, len(sections), 1)
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
        self.write(self.source.parent / BUILD.BPF_SOURCE, b"/* explicit BPF build fixture, not executed */\n")
        self.write(self.source.parent / BUILD.BPF_HEADER,
                   (f'#define WAARP_KERNEL_BTF_SHA256 "{BUILD.KERNEL_BTF_SHA256}"\n'
                    f'#define WAARP_KERNEL_BTF_BYTES {BUILD.KERNEL_BTF_BYTES}\n').encode())
        self.write(self.root / "android/native-source.json", json.dumps({"tools": {"ndkVersion": BUILD.NDK_VERSION}}).encode())
        self.write(self.ndk / "source.properties", ("Pkg.Revision = " + BUILD.NDK_VERSION + "\n").encode())
        for relative in (BUILD.COMPILER, BUILD.DRIVER):
            path = self.ndk / relative
            self.write(path, b"fixture compiler: never executed")
            path.chmod(0o755)
        self.calls = []
        self.binary = elf_fixture()
        self.bpf_object = bpf_fixture()
        self.mutate_source = False
        self.mutate_bpf_header = False
        self.bpf_failure = False

    @staticmethod
    def write(path, data):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def runner(self, arguments, cwd, environment, timeout):
        self.calls.append((arguments, environment, timeout))
        if arguments[-1] == "--version":
            return {"returncode": 0, "stdout": b"Android fixture clang version 19.0.0\n", "stderr": b""}
        if arguments[-1] == BUILD.BPF_OBJECT:
            self.assertEqual(arguments, BUILD.expected_bpf_arguments(self.ndk, cwd))
            self.assertEqual(timeout, 30)
            (cwd / BUILD.BPF_OBJECT).write_bytes(self.bpf_object)
            if self.bpf_failure:
                return {"returncode": 1, "stdout": b"", "stderr": b"explicit fixture compile failure"}
            return {"returncode": 0, "stdout": b"", "stderr": b""}
        self.assertEqual(arguments, BUILD.expected_arguments(self.ndk, cwd))
        self.assertEqual(environment["SOURCE_DATE_EPOCH"], "1700000000")
        self.assertEqual(environment["LC_ALL"], "C")
        self.assertEqual((cwd / BUILD.SOURCE).read_bytes(), self.source.read_bytes())
        self.assertEqual((cwd / BUILD.PROGRAM_HEADER).read_bytes(), BUILD.program_header(PROGRAM))
        (cwd / BUILD.BINARY).write_bytes(self.binary)
        if self.mutate_source:
            self.source.write_bytes(b"changed during compilation")
        if self.mutate_bpf_header:
            (self.source.parent / BUILD.BPF_HEADER).write_bytes(b"changed layout during native compilation")
        return {"returncode": 0, "stdout": b"", "stderr": b""}

    def build(self):
        return BUILD.build(self.sdk, root=self.root, runner=self.runner, identity_reader=lambda _: ("a" * 40, 1700000000))

    def test_exact_plan_retained_bytes_and_pure_replay(self):
        report = self.build()
        self.assertTrue(report["passed"])
        self.assertTrue(report["testOnly"])
        self.assertEqual(len(self.calls), 3)
        self.assertEqual([call[2] for call in self.calls], [10, 30, 90])
        self.assertEqual(set(path.name for path in self.output.iterdir()), set(BUILD.RETAINED_FILES))
        self.assertEqual((self.output / BUILD.SOURCE).read_bytes(), self.source.read_bytes())
        self.assertEqual((self.output / BUILD.BINARY).read_bytes(), self.binary)
        live = BUILD.validate_build(self.output, self.source)
        self.assertEqual(live, BUILD.validate_build(self.output))
        self.assertEqual(live["binarySha256"], BUILD.sha(self.binary))
        self.assertEqual(report["elf"]["loadSegmentAlignments"], [16384])
        self.assertEqual(live["bpfProgramSha256"], BUILD.sha(PROGRAM))
        self.assertFalse(report["bpf"]["elf"]["kernelVerifierRun"])

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

    def test_bpf_layout_change_during_compile_leaves_failed_receipt(self):
        self.mutate_bpf_header = True
        self.assertFalse(self.build()["passed"])
        self.assertFalse((self.output / BUILD.BINARY).exists())

    def test_bpf_compile_failure_never_invokes_native_compiler(self):
        self.bpf_failure = True
        self.assertFalse(self.build()["passed"])
        self.assertEqual(len(self.calls), 2)
        self.assertFalse((self.output / BUILD.BINARY).exists())

    def test_bpf_layout_pin_cannot_be_changed(self):
        path = self.source.parent / BUILD.BPF_HEADER
        path.write_bytes(path.read_bytes().replace(BUILD.KERNEL_BTF_SHA256.encode(), b"a" * 64))
        self.assertFalse(self.build()["passed"])
        self.assertEqual(self.calls, [])

    def test_bpf_object_wrong_machine_bounds_section_or_license_refuses(self):
        for value in (bpf_fixture(machine=62), bpf_fixture()[:100], bpf_fixture(program=PROGRAM[:-1]),
                      bpf_fixture(license_data=b"GPL"), bpf_fixture(license_data=b"BSD\0")):
            with self.subTest(value=value[:24]):
                with self.assertRaises(ValueError):
                    BUILD.bpf_program(value)

    def test_bpf_relocations_maps_or_extra_executable_data_refuses(self):
        for extra in ((".reliter/task_file", 9, 0, b"x" * 16), ("maps", 1, 3, b"x" * 8),
                      (".text", 1, 6, PROGRAM), (".BTF.ext", 1, 0, b"x" * 8)):
            with self.subTest(section=extra[0]):
                with self.assertRaises(ValueError):
                    BUILD.bpf_program(bpf_fixture(extra=extra))

    def test_bpf_unreviewed_helper_subprogram_indirect_call_or_pseudo_map_refuses(self):
        for instruction in (struct.pack("<BBhi", 0x85, 0, 0, 6), struct.pack("<BBhi", 0x85, 0x10, 0, 113),
                            struct.pack("<BBhi", 0x8d, 0, 0, 113), struct.pack("<BBhi", 0x18, 0x10, 0, 0)):
            with self.subTest(instruction=instruction):
                with self.assertRaises(ValueError):
                    BUILD.bpf_program(bpf_fixture(program=instruction + PROGRAM))

    def test_compiler_can_place_a_basic_block_after_the_exit(self):
        code = PROGRAM[:16] + struct.pack("<BBhi", 0x05, 0, 1, 0) + PROGRAM[16:] + struct.pack("<BBhi", 0x05, 0, -2, 0)
        extracted, metadata = BUILD.bpf_program(bpf_fixture(program=code))
        self.assertEqual(extracted, code)
        self.assertFalse(metadata["kernelVerifierRun"])

    def test_native_binary_must_contain_the_extracted_program(self):
        self.binary = elf_fixture(program=b"not the BPF program")
        self.assertFalse(self.build()["passed"])
        self.assertFalse((self.output / BUILD.BINARY).exists())

    def test_retained_bpf_files_and_generated_header_are_revalidated(self):
        self.assertTrue(self.build()["passed"])
        for name in (BUILD.BPF_SOURCE, BUILD.BPF_HEADER, BUILD.BPF_OBJECT, BUILD.PROGRAM_HEADER):
            with self.subTest(file=name):
                path = self.output / name
                original = path.read_bytes()
                path.write_bytes(original + b"tampered")
                with self.assertRaises(ValueError):
                    BUILD.validate_build(self.output)
                path.write_bytes(original)
        path = self.output / BUILD.PROGRAM_HEADER
        path.write_bytes(path.read_bytes().replace(b"0x85", b"0x95", 1))
        record_path = self.output / "build.json"
        record = json.loads(record_path.read_bytes())
        record["bpf"]["programHeader"] = BUILD.file_identity(BUILD.PROGRAM_HEADER, path.read_bytes())
        record_path.write_text(json.dumps(record))
        with self.assertRaisesRegex(ValueError, "Generated BPF"):
            BUILD.validate_build(self.output)

    def test_checked_out_bpf_source_must_match_retained_source(self):
        self.assertTrue(self.build()["passed"])
        (self.source.parent / BUILD.BPF_SOURCE).write_bytes(b"different BPF source")
        with self.assertRaises(ValueError):
            BUILD.validate_build(self.output, self.source)

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
