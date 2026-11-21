#!/usr/bin/env python3
"""Build/validate the test-only Android tracefs observer; never invoke ADB or build an APK.

Uses android/native-source.json's fixed NDK on Linux x86_64. Native/BPF sources,
object, generated program header, binary and build.json are retained together. A build receipt
is consistency evidence, not independent authentication of the installed NDK.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import selectors
import signal
import stat
import struct
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent
NDK_VERSION = "28.2.13676358"
TARGET = "x86_64-linux-android29"
SOURCE = "android-ftrace-observer.c"
BINARY = "tracefs-observer"
BPF_SOURCE = "android-ftrace-observer.bpf.c"
BPF_HEADER = "android-ftrace-observer-bpf.h"
BPF_OBJECT = "tracefs-observer.bpf.o"
PROGRAM_HEADER = "android-ftrace-observer-program.h"
SOURCE_FILES = (SOURCE, BPF_SOURCE, BPF_HEADER)
RETAINED_FILES = ("build.json", BINARY, *SOURCE_FILES, BPF_OBJECT, PROGRAM_HEADER)
KERNEL_BTF_SHA256 = "d9bad01cb909205a22d741adf6b9f5a907a6e805354a94d9012165f2002508fa"
KERNEL_BTF_BYTES = 7167898
TOOL_BIN = "toolchains/llvm/prebuilt/linux-x86_64/bin"
COMPILER = TOOL_BIN + "/" + TARGET + "-clang"
DRIVER = TOOL_BIN + "/clang"
SOURCE_LIMIT, BINARY_LIMIT, TOOL_LIMIT = 256 * 1024, 2 * 1024**2, 512 * 1024**2
STREAM_LIMIT, VERSION_TIMEOUT, BUILD_TIMEOUT = 65536, 10, 120
BPF_BUILD_TIMEOUT, NATIVE_BUILD_TIMEOUT = 30, 90
BPF_FLAGS = ["--target=bpfel", "-O2", "-std=c11", "-Wall", "-Wextra", "-Werror", "-fno-ident", "-c"]
BPF_OBJECT_LIMIT, BPF_INSTRUCTION_LIMIT = 256 * 1024, 4096
FLAGS = ["-O2", "-std=c11", "-Wall", "-Wextra", "-Werror", "-fPIE", "-pie",
         "-Wl,-z,max-page-size=16384", "-Wl,-z,common-page-size=16384", "-Wl,--build-id=sha1"]
SANITIZE = ("CC", "CXX", "CFLAGS", "CXXFLAGS", "CPPFLAGS", "LDFLAGS", "CPATH", "C_INCLUDE_PATH",
            "CPLUS_INCLUDE_PATH", "OBJC_INCLUDE_PATH", "LIBRARY_PATH", "COMPILER_PATH", "GCC_EXEC_PREFIX",
            "LD_PRELOAD", "LD_LIBRARY_PATH", "CCC_OVERRIDE_OPTIONS", "CLANG_CONFIG_FILE",
            "CLANG_CONFIG_FILE_USER_DIR", "CLANG_CONFIG_FILE_SYSTEM_DIR")


def require(value, message):
    if not value:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def pairs(values):
    result = {}
    for key, value in values:
        require(key not in result, "Duplicate build JSON key")
        result[key] = value
    return result


def read_regular(path, limit):
    path = Path(path).absolute()
    require(path.resolve(strict=True) == path, "Use canonical paths without symlinks")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and 0 < info.st_size <= limit, "Missing/oversized regular build input")
        data = stream.read(limit + 1)
    require(len(data) == info.st_size and len(data) <= limit, "Build input changed size while reading")
    return data


def command(arguments, cwd, environment, timeout):
    """Bound both pipes; the new process group belongs only to this compilation."""
    process = subprocess.Popen(arguments, cwd=cwd, env=environment, stdin=subprocess.DEVNULL,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    selector = selectors.DefaultSelector()
    collected = {"stdout": bytearray(), "stderr": bytearray()}
    until = time.monotonic() + timeout
    for label, stream in (("stdout", process.stdout), ("stderr", process.stderr)):
        os.set_blocking(stream.fileno(), False)
        selector.register(stream, selectors.EVENT_READ, label)
    try:
        while selector.get_map():
            remaining = until - time.monotonic()
            require(remaining > 0, "Observer compiler command timed out")
            for key, _ in selector.select(min(remaining, 0.2)):
                chunk = os.read(key.fileobj.fileno(), 16384)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                collected[key.data].extend(chunk)
                require(len(collected[key.data]) <= STREAM_LIMIT, "Observer compiler output exceeded 64 KiB")
        code = process.wait(timeout=max(0.001, until - time.monotonic()))
        return {"returncode": code, **{key: bytes(value) for key, value in collected.items()}}
    except BaseException:
        # Do not poll/reap the group leader before cleanup: its reserved PID
        # cannot become a different process group's ID during this operation.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait(timeout=5)
        raise
    finally:
        selector.close()
        process.stdout.close()
        process.stderr.close()


def compiler_info(ndk, relative):
    original = ndk / relative
    resolved = original.resolve(strict=True)
    require(resolved.is_relative_to(ndk), "Compiler entry escapes the pinned NDK")
    raw = read_regular(resolved, TOOL_LIMIT)
    require(os.access(resolved, os.X_OK), "Pinned NDK compiler is not executable")
    return {"relativePath": relative, "resolvedRelativePath": resolved.relative_to(ndk).as_posix(),
            "bytes": len(raw), "sha256": sha(raw)}


def git_identity(root):
    commit, epoch = subprocess.check_output(["git", "show", "-s", "--format=%H %ct", "HEAD"], cwd=root, text=True).strip().split()
    inputs = [*("scripts/" + name for name in SOURCE_FILES),
              "scripts/android-ftrace-observer-build.py", "android/native-source.json"]
    subprocess.run(["git", "ls-files", "--error-unmatch", "--", *inputs], cwd=root, check=True, stdout=subprocess.DEVNULL)
    require(subprocess.run(["git", "diff", "--quiet", "HEAD", "--", *inputs], cwd=root).returncode == 0,
            "Commit the observer source, builder and native-source lock before building")
    return commit, int(epoch)


def expected_arguments(ndk, directory):
    return [str(Path(ndk) / COMPILER), *FLAGS, "-ffile-prefix-map=" + str(directory) + "=.",
            "-fdebug-prefix-map=" + str(directory) + "=.", SOURCE, "-o", BINARY]


def expected_bpf_arguments(ndk, directory):
    return [str(Path(ndk) / DRIVER), *BPF_FLAGS, "-ffile-prefix-map=" + str(directory) + "=.",
            "-fdebug-prefix-map=" + str(directory) + "=.", BPF_SOURCE, "-o", BPF_OBJECT]


def bpf_program(data):
    """Extract one bounded relocation-free BPF program; this is not a verifier run."""
    require(64 <= len(data) <= BPF_OBJECT_LIMIT and data[:7] == b"\x7fELF\x02\x01\x01",
            "BPF object must be bounded little-endian ELF64")
    header = struct.unpack_from("<HHIQQQIHHHHHH", data, 16)
    require(header[:5] == (1, 247, 1, 0, 0) and header[7] == 64 and header[9] == 0,
            "BPF object must be an EM_BPF relocatable object without program headers")
    offset, width, count, strings_index = header[5], header[10], header[11], header[12]
    require(width == 64 and 1 < count <= 64 and 0 < strings_index < count
            and offset >= 64 and offset + width * count <= len(data), "Malformed BPF section table")
    sections = [struct.unpack_from("<IIQQQQIIQQ", data, offset + index * width) for index in range(count)]
    require(sections[0] == (0,) * 10, "Extended BPF section numbering is unsupported")
    for section in sections[1:]:
        require(section[1] not in (4, 9), "BPF relocations are forbidden")
        require(section[1] != 8 or section[5] == 0, "BPF uninitialized storage is forbidden")
        require(section[4] <= len(data) and section[5] <= len(data) - section[4], "BPF section is outside the object")
        require(section[8] == 0 or section[8] & (section[8] - 1) == 0, "Invalid BPF section alignment")
    strings = sections[strings_index]
    require(strings[1] == 3 and strings[5] > 0, "Missing BPF section-name table")
    names = data[strings[4]:strings[4] + strings[5]]
    named = {}
    for section in sections[1:]:
        require(section[0] < len(names), "BPF section name is out of range")
        end = names.find(b"\0", section[0])
        require(end >= 0, "Unterminated BPF section name")
        name = names[section[0]:end].decode("ascii")
        require(name and name not in named, "Missing or duplicate BPF section name")
        require(name not in ("maps", ".maps") and not name.startswith((".rel", ".BTF")),
                "BPF maps, relocation and CO-RE/BTF sections are outside this fixed program")
        require(not section[5] or not section[2] & 6 or name in ("iter/task_file", "license"),
                "Unexpected allocated or executable BPF data")
        named[name] = section
    require("iter/task_file" in named and "license" in named, "Missing BPF iterator program/license")
    program, license_section = named["iter/task_file"], named["license"]
    require(program[1] == 1 and program[2] == 6 and 0 < program[5] <= BPF_INSTRUCTION_LIMIT * 8
            and program[5] % 8 == 0, "Invalid BPF iterator instruction section")
    require(license_section[1] == 1
            and data[license_section[4]:license_section[4] + license_section[5]] == b"GPL\0",
            "BPF iterator requires its exact GPL license")
    code = data[program[4]:program[4] + program[5]]
    helpers, exits = set(), 0
    for opcode, registers, branch, immediate in struct.iter_unpack("<BBhi", code):
        if opcode & 0xF0 == 0x80 and opcode & 7 in (5, 6):
            require(opcode == 0x85, "BPF indirect calls are forbidden")
            require(registers == 0 and branch == 0 and immediate in (113, 127),
                    "BPF program calls an unreviewed helper or subprogram")
            helpers.add(immediate)
        if opcode == 0x18:
            require(registers >> 4 == 0, "BPF pseudo/map pointers are forbidden")
        if opcode == 0x95:
            require(registers == branch == immediate == 0, "Malformed BPF exit instruction")
            exits += 1
    # Clang may lay out a later basic block after EXIT and jump back to it.
    # Control-flow/type safety remains the actual guest verifier's obligation.
    require(helpers == {113, 127} and exits > 0,
            "BPF iterator lacks its reviewed helpers or exit")
    return code, {"class": 64, "machine": 247, "section": "iter/task_file", "license": "GPL",
                  "instructions": len(code) // 8, "helperIds": sorted(helpers), "relocations": False,
                  "maps": False, "coreRelocations": False, "kernelVerifierRun": False}


def program_header(code):
    rows = ["    " + ", ".join(f"0x{byte:02x}" for byte in code[start:start + 16]) + ","
            for start in range(0, len(code), 16)]
    text = ("/* Generated from the retained BPF object; do not edit. */\n"
            "#ifndef WAARP_FTRACE_OBSERVER_PROGRAM_H\n#define WAARP_FTRACE_OBSERVER_PROGRAM_H\n"
            f"#define WAARP_BPF_PROGRAM_BYTES {len(code)}u\n"
            f'#define WAARP_BPF_PROGRAM_SHA256 "{sha(code)}"\n'
            "static const unsigned char WAARP_BPF_PROGRAM[] __attribute__((aligned(8))) = {\n"
            + "\n".join(rows) + "\n};\n#endif\n")
    return text.encode("ascii")


def file_identity(name, data):
    return {"file": name, "bytes": len(data), "sha256": sha(data)}


def check_btf_pin(header):
    text = header.decode("ascii")
    require(re.findall(r'^#define WAARP_KERNEL_BTF_SHA256 "([0-9a-f]{64})"$', text, re.M) == [KERNEL_BTF_SHA256]
            and re.findall(r'^#define WAARP_KERNEL_BTF_BYTES ([0-9]+)$', text, re.M) == [str(KERNEL_BTF_BYTES)],
            "Observer layout header differs from the reviewed kernel BTF pin")


def overrides(ndk, directory, epoch):
    return {"SOURCE_DATE_EPOCH": str(epoch), "LC_ALL": "C", "TZ": "UTC",
            "PATH": str(Path(ndk) / TOOL_BIN) + ":/usr/bin:/bin", "TMPDIR": str(directory)}


def elf_identity(data):
    require(len(data) >= 64 and data[:7] == b"\x7fELF\x02\x01\x01", "Observer must be a little-endian ELF64")
    header = struct.unpack_from("<HHIQQQIHHHHHH", data, 16)
    kind, machine, version, entry, offset = header[:5]
    require(kind == 3 and machine == 62 and version == 1 and header[7] == 64,
            "Observer must be an x86_64 PIE executable")
    require(header[8] == 56 and 1 <= header[9] <= 64 and offset + header[8] * header[9] <= len(data),
            "Malformed ELF program headers")
    segments = [struct.unpack_from("<IIQQQQQQ", data, offset + index * 56) for index in range(header[9])]
    loads = [item for item in segments if item[0] == 1]
    require(loads and any(item[1] & 1 and item[3] <= entry < item[3] + item[6] for item in loads),
            "ELF entry is not covered by an executable LOAD")
    for _, _, start, address, _, size, memory, alignment in loads:
        require(size <= memory and start + size <= len(data) and alignment >= 16384
                and alignment & (alignment - 1) == 0 and (start - address) % alignment == 0,
                "ELF LOAD is invalid or not aligned to 16 KiB")
    interpreters = [item for item in segments if item[0] == 3]
    require(len(interpreters) == 1, "Android executable must have one interpreter")
    item = interpreters[0]
    require(0 < item[5] <= 256 and item[2] + item[5] <= len(data)
            and data[item[2]:item[2] + item[5]] == b"/system/bin/linker64\0", "Observer uses a non-Android interpreter")
    # Reuse the project's actual RELRO/page-layout check; this invokes no SDK.
    spec = importlib.util.spec_from_file_location("observer_elf_verifier", ROOT / "scripts/android-verify.py")
    verifier = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(verifier)
    checked = verifier.elf_check(data, BINARY)
    return {"class": 64, "machine": 62, "pie": True, "interpreter": "/system/bin/linker64",
            "loadSegmentAlignments": checked["loadAlignments"], "relro16kSafe": checked["relro16kSafe"]}


def validate_build(directory, source_path=None):
    """Pure runtime/replay check. Does not run the compiler, SDK, ADB or observer."""
    directory = Path(directory).absolute()
    raw = read_regular(directory / "build.json", 256 * 1024)
    record = json.loads(raw, object_pairs_hook=pairs, parse_constant=lambda value: (_ for _ in ()).throw(ValueError("Non-finite build JSON")))
    require(type(record["schemaVersion"]) is int and record["schemaVersion"] == 2
            and record["testOnly"] is True and record["passed"] is True, "Observer build did not pass")
    require(record["ndkVersion"] == NDK_VERSION and record["target"] == TARGET, "Observer toolchain pin differs")
    require(re.fullmatch(r"[0-9a-f]{40}", record["sourceCommit"] or "") and type(record["sourceDateEpoch"]) is int
            and record["sourceDateEpoch"] >= 0, "Invalid reproducibility source identity")
    for key in ("ndkDirectory", "workingDirectory"):
        path = PurePosixPath(record[key])
        require(path.is_absolute() and ".." not in path.parts and str(path) == record[key]
                and not any(ord(c) < 32 for c in record[key]), "Invalid recorded build path")
    require(PurePosixPath(record["ndkDirectory"]).name == NDK_VERSION, "Wrong recorded NDK directory")
    require(record["arguments"] == expected_arguments(record["ndkDirectory"], record["workingDirectory"])
            and record["environment"] == overrides(record["ndkDirectory"], record["workingDirectory"], record["sourceDateEpoch"]),
            "Observer compile arguments/environment differ")
    require(record["commandTimeoutSeconds"] == BUILD_TIMEOUT and record["versionTimeoutSeconds"] == VERSION_TIMEOUT
            and record["bpfCommandTimeoutSeconds"] == BPF_BUILD_TIMEOUT
            and record["nativeCommandTimeoutSeconds"] == NATIVE_BUILD_TIMEOUT
            and record["perStreamOutputLimitBytes"] == STREAM_LIMIT, "Observer compiler bounds differ")
    require(re.fullmatch(r"[0-9a-f]{64}", record["nativeSourceManifestSha256"] or ""), "Missing native source lock identity")
    compiler = record["compiler"]
    require(compiler["relativePath"] == COMPILER and compiler["driver"]["relativePath"] == DRIVER
            and isinstance(compiler["version"], str) and "clang version" in compiler["version"]
            and len(compiler["version"].encode()) <= STREAM_LIMIT, "Invalid recorded compiler identity")
    for item in (compiler, compiler["driver"]):
        relative = PurePosixPath(item["resolvedRelativePath"])
        require(not relative.is_absolute() and ".." not in relative.parts and str(relative) == item["resolvedRelativePath"]
                and type(item["bytes"]) is int and 0 < item["bytes"] <= TOOL_LIMIT
                and re.fullmatch(r"[0-9a-f]{64}", item["sha256"] or ""), "Malformed compiler hash/path")
    bpf = record["bpf"]
    require(bpf["arguments"] == expected_bpf_arguments(record["ndkDirectory"], record["workingDirectory"]),
            "BPF compile arguments differ")
    require(json.dumps(bpf["kernelBtf"], sort_keys=True) == json.dumps(
        {"sha256": KERNEL_BTF_SHA256, "bytes": KERNEL_BTF_BYTES}, sort_keys=True), "BPF kernel layout pin differs")
    retained = {}
    for item, filename, limit in ((record["source"], SOURCE, SOURCE_LIMIT), (record["binary"], BINARY, BINARY_LIMIT),
                                 (bpf["source"], BPF_SOURCE, SOURCE_LIMIT), (bpf["header"], BPF_HEADER, SOURCE_LIMIT),
                                 (bpf["object"], BPF_OBJECT, BPF_OBJECT_LIMIT),
                                 (bpf["programHeader"], PROGRAM_HEADER, SOURCE_LIMIT)):
        require(item["file"] == filename and type(item["bytes"]) is int, "Wrong observer retained filename/size")
        data = read_regular(directory / filename, limit)
        require(len(data) == item["bytes"] and sha(data) == item["sha256"], "Retained observer bytes differ")
        retained[filename] = data
    check_btf_pin(retained[BPF_HEADER])
    code, metadata = bpf_program(retained[BPF_OBJECT])
    require(type(bpf["programBytes"]) is int and len(code) == bpf["programBytes"] and sha(code) == bpf["programSha256"]
            and json.dumps(bpf["elf"], sort_keys=True) == json.dumps(metadata, sort_keys=True),
            "Recorded BPF program differs from the retained object")
    require(retained[PROGRAM_HEADER] == program_header(code), "Generated BPF program header differs from the retained object")
    binary = retained[BINARY]
    require(binary.count(code) == 1, "Native observer must embed the exact retained BPF program once")
    require(json.dumps(record["elf"], sort_keys=True) == json.dumps(elf_identity(binary), sort_keys=True),
            "Recorded ELF identity differs from actual program headers")
    if source_path is not None:
        for filename in SOURCE_FILES:
            require(read_regular(Path(source_path).parent / filename, SOURCE_LIMIT) == retained[filename],
                    "Observer differs from the checked-out native/BPF sources")
    return {"sourceSha256": record["source"]["sha256"], "binarySha256": record["binary"]["sha256"],
            "binaryBytes": record["binary"]["bytes"], "ndkVersion": NDK_VERSION, "target": TARGET, "receiptSha256": sha(raw),
            "bpfSourceSha256": bpf["source"]["sha256"], "bpfHeaderSha256": bpf["header"]["sha256"],
            "bpfObjectSha256": bpf["object"]["sha256"], "bpfProgramSha256": sha(code), "bpfProgramBytes": len(code),
            "kernelBtfSha256": KERNEL_BTF_SHA256, "kernelBtfBytes": KERNEL_BTF_BYTES}


def write_json(path, value):
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as stream:
        temporary = Path(stream.name)
        json.dump(value, stream, indent=2, allow_nan=False)
        stream.write("\n")
    try:
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def build(sdk, *, root=ROOT, runner=command, identity_reader=git_identity):
    require(sys.platform == "linux" and platform.machine() in ("x86_64", "AMD64"), "Requires a Linux x86_64 NDK worker")
    root = Path(root).resolve(strict=True)
    output = root / "out/android/ci-observer"
    require(output.resolve() == output, "Observer output must not follow symlinks")
    output.mkdir(parents=True, exist_ok=True)
    record = {"schemaVersion": 2, "testOnly": True, "passed": False, "ndkVersion": NDK_VERSION, "target": TARGET,
              "commandTimeoutSeconds": BUILD_TIMEOUT, "versionTimeoutSeconds": VERSION_TIMEOUT,
              "bpfCommandTimeoutSeconds": BPF_BUILD_TIMEOUT, "nativeCommandTimeoutSeconds": NATIVE_BUILD_TIMEOUT,
              "perStreamOutputLimitBytes": STREAM_LIMIT}
    # Invalidate any old success before touching build inputs. Old binaries are
    # never usable with this failed/incomplete receipt.
    write_json(output / "build.json", {**record, "error": "Observer build has not completed"})
    try:
        source_path, lock_path = root / "scripts" / SOURCE, root / "android/native-source.json"
        sources = {name: read_regular(source_path.parent / name, SOURCE_LIMIT) for name in SOURCE_FILES}
        lock_raw = read_regular(lock_path, 256 * 1024)
        check_btf_pin(sources[BPF_HEADER])
        lock = json.loads(lock_raw, object_pairs_hook=pairs)
        require(lock["tools"]["ndkVersion"] == NDK_VERSION, "native-source.json NDK pin changed; review the observer builder")
        sdk = Path(sdk).resolve(strict=True)
        ndk = sdk / "ndk" / NDK_VERSION
        require(ndk.resolve(strict=True) == ndk, "Use the explicit versioned NDK directory")
        properties = read_regular(ndk / "source.properties", 65536)
        revisions = re.findall(r"(?m)^Pkg\.Revision\s*=\s*(\S+)\s*$", properties.decode())
        require(revisions == [NDK_VERSION], "Installed NDK revision differs from the source pin")
        compiler, driver = compiler_info(ndk, COMPILER), compiler_info(ndk, DRIVER)
        commit, epoch = identity_reader(root)
        record.update(sourceCommit=commit, sourceDateEpoch=epoch, nativeSourceManifestSha256=sha(lock_raw),
                      ndkDirectory=str(ndk), source=file_identity(SOURCE, sources[SOURCE]))
        with tempfile.TemporaryDirectory(prefix="observer-build-", dir=output) as temporary:
            work = Path(temporary)
            for name, data in sources.items():
                (work / name).write_bytes(data)
            environment = dict(os.environ)
            for name in SANITIZE:
                environment.pop(name, None)
            applied = overrides(ndk, work, epoch)
            environment.update(applied)
            version = runner([str(ndk / COMPILER), "--version"], work, environment, VERSION_TIMEOUT)
            require(version["returncode"] == 0 and len(version["stdout"]) <= STREAM_LIMIT
                    and len(version["stderr"]) <= STREAM_LIMIT, "Pinned compiler version query failed")
            text = version["stdout"].decode("utf-8").strip()
            require("clang version" in text, "Pinned compiler did not identify Clang")
            record.update(compiler={**compiler, "version": text, "driver": driver}, workingDirectory=str(work),
                          environment=applied, arguments=expected_arguments(ndk, work))
            bpf_arguments = expected_bpf_arguments(ndk, work)
            result = runner(bpf_arguments, work, environment, BPF_BUILD_TIMEOUT)
            require(result["returncode"] == 0 and len(result["stdout"]) <= STREAM_LIMIT and len(result["stderr"]) <= STREAM_LIMIT,
                    "Observer BPF compile failed: " + result["stderr"].decode("utf-8", errors="replace")[-4000:])
            object_data = read_regular(work / BPF_OBJECT, BPF_OBJECT_LIMIT)
            code, metadata = bpf_program(object_data)
            generated = program_header(code)
            (work / PROGRAM_HEADER).write_bytes(generated)
            record["bpf"] = {"arguments": bpf_arguments, "source": file_identity(BPF_SOURCE, sources[BPF_SOURCE]),
                             "header": file_identity(BPF_HEADER, sources[BPF_HEADER]),
                             "object": file_identity(BPF_OBJECT, object_data),
                             "programHeader": file_identity(PROGRAM_HEADER, generated),
                             "programSha256": sha(code), "programBytes": len(code), "elf": metadata,
                             "kernelBtf": {"sha256": KERNEL_BTF_SHA256, "bytes": KERNEL_BTF_BYTES}}
            result = runner(record["arguments"], work, environment, NATIVE_BUILD_TIMEOUT)
            require(result["returncode"] == 0 and len(result["stdout"]) <= STREAM_LIMIT and len(result["stderr"]) <= STREAM_LIMIT,
                    "Observer compile failed: " + result["stderr"].decode("utf-8", errors="replace")[-4000:])
            binary = read_regular(work / BINARY, BINARY_LIMIT)
            require(all(read_regular(source_path.parent / name, SOURCE_LIMIT) == data for name, data in sources.items())
                    and read_regular(lock_path, 256 * 1024) == lock_raw
                    and read_regular(ndk / "source.properties", 65536) == properties
                    and compiler_info(ndk, COMPILER) == compiler and compiler_info(ndk, DRIVER) == driver,
                    "Observer source/toolchain changed during compilation")
            record.update(binary=file_identity(BINARY, binary), elf=elf_identity(binary), passed=True)
            write_json(work / "build.json", record)
            validate_build(work, source_path)
            os.chmod(work / BINARY, 0o755)
            for name in RETAINED_FILES[1:]:
                os.replace(work / name, output / name)
            os.replace(work / "build.json", output / "build.json")
    except Exception as error:
        record.update(passed=False, error=f"{type(error).__name__}: {error}")
        write_json(output / "build.json", record)
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sdk-root", type=Path, default=os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT"))
    options = parser.parse_args()
    if options.sdk_root is None:
        parser.error("--sdk-root or ANDROID_HOME is required")
    try:
        result = build(options.sdk_root)
    except Exception as error:
        print(f"Observer build refused: {error}", file=sys.stderr)
        return 1
    if not result["passed"]:
        print(result["error"], file=sys.stderr)
        return 1
    print(f"PASS test-only observer: {result['binary']['sha256']}; Android {TARGET}, ELF 16 KiB; no APK/ADB operation")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
