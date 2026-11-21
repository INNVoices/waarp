#!/usr/bin/env python3
"""Build/validate the test-only Android tracefs observer; never invoke ADB or build an APK.

Uses android/native-source.json's fixed NDK on Linux x86_64. Source and binary
copies plus build.json are retained in out/android/ci-observer. A build receipt
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
TOOL_BIN = "toolchains/llvm/prebuilt/linux-x86_64/bin"
COMPILER = TOOL_BIN + "/" + TARGET + "-clang"
DRIVER = TOOL_BIN + "/clang"
SOURCE_LIMIT, BINARY_LIMIT, TOOL_LIMIT = 256 * 1024, 2 * 1024**2, 512 * 1024**2
STREAM_LIMIT, VERSION_TIMEOUT, BUILD_TIMEOUT = 65536, 10, 120
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
    inputs = ["scripts/" + SOURCE, "scripts/android-ftrace-observer-build.py", "android/native-source.json"]
    subprocess.run(["git", "ls-files", "--error-unmatch", "--", *inputs], cwd=root, check=True, stdout=subprocess.DEVNULL)
    require(subprocess.run(["git", "diff", "--quiet", "HEAD", "--", *inputs], cwd=root).returncode == 0,
            "Commit the observer source, builder and native-source lock before building")
    return commit, int(epoch)


def expected_arguments(ndk, directory):
    return [str(Path(ndk) / COMPILER), *FLAGS, "-ffile-prefix-map=" + str(directory) + "=.",
            "-fdebug-prefix-map=" + str(directory) + "=.", SOURCE, "-o", BINARY]


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
    require(type(record["schemaVersion"]) is int and record["schemaVersion"] == 1
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
    for key, filename, limit in (("source", SOURCE, SOURCE_LIMIT), ("binary", BINARY, BINARY_LIMIT)):
        item = record[key]
        require(item["file"] == filename and type(item["bytes"]) is int, "Wrong observer retained filename/size")
        data = read_regular(directory / filename, limit)
        require(len(data) == item["bytes"] and sha(data) == item["sha256"], "Retained observer bytes differ")
    binary = read_regular(directory / BINARY, BINARY_LIMIT)
    require(json.dumps(record["elf"], sort_keys=True) == json.dumps(elf_identity(binary), sort_keys=True),
            "Recorded ELF identity differs from actual program headers")
    if source_path is not None:
        require(sha(read_regular(source_path, SOURCE_LIMIT)) == record["source"]["sha256"], "Observer differs from the checked-out C source")
    return {"sourceSha256": record["source"]["sha256"], "binarySha256": record["binary"]["sha256"],
            "binaryBytes": record["binary"]["bytes"], "ndkVersion": NDK_VERSION, "target": TARGET, "receiptSha256": sha(raw)}


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
    record = {"schemaVersion": 1, "testOnly": True, "passed": False, "ndkVersion": NDK_VERSION, "target": TARGET,
              "commandTimeoutSeconds": BUILD_TIMEOUT, "versionTimeoutSeconds": VERSION_TIMEOUT,
              "perStreamOutputLimitBytes": STREAM_LIMIT}
    # Invalidate any old success before touching build inputs. Old binaries are
    # never usable with this failed/incomplete receipt.
    write_json(output / "build.json", {**record, "error": "Observer build has not completed"})
    try:
        source_path, lock_path = root / "scripts" / SOURCE, root / "android/native-source.json"
        source, lock_raw = read_regular(source_path, SOURCE_LIMIT), read_regular(lock_path, 256 * 1024)
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
                      ndkDirectory=str(ndk), source={"file": SOURCE, "bytes": len(source), "sha256": sha(source)})
        with tempfile.TemporaryDirectory(prefix="observer-build-", dir=output) as temporary:
            work = Path(temporary)
            (work / SOURCE).write_bytes(source)
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
            result = runner(record["arguments"], work, environment, BUILD_TIMEOUT)
            require(result["returncode"] == 0 and len(result["stdout"]) <= STREAM_LIMIT and len(result["stderr"]) <= STREAM_LIMIT,
                    "Observer compile failed: " + result["stderr"].decode("utf-8", errors="replace")[-4000:])
            binary = read_regular(work / BINARY, BINARY_LIMIT)
            require(read_regular(source_path, SOURCE_LIMIT) == source and read_regular(lock_path, 256 * 1024) == lock_raw
                    and read_regular(ndk / "source.properties", 65536) == properties
                    and compiler_info(ndk, COMPILER) == compiler and compiler_info(ndk, DRIVER) == driver,
                    "Observer source/toolchain changed during compilation")
            record.update(binary={"file": BINARY, "bytes": len(binary), "sha256": sha(binary)}, elf=elf_identity(binary), passed=True)
            write_json(work / "build.json", record)
            validate_build(work, source_path)
            os.chmod(work / BINARY, 0o755)
            os.replace(work / SOURCE, output / SOURCE)
            os.replace(work / BINARY, output / BINARY)
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
