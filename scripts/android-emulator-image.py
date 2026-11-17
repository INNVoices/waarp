#!/usr/bin/env python3
"""Bind disposable CI device evidence to the installed official system image.

This verifier reads only; it does not root, reboot, change properties, resize
tracefs or alter the APK. The 16 KiB gate deliberately uses SDK 36 / full 36.1
maintenance image r4; API 29 and 35 retain their original 4 KiB images.
"""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import re
import subprocess
import time

COMMAND_TIMEOUT_SECONDS = 10
TOTAL_TIMEOUT_SECONDS = 60
OUTPUT_LIMIT = 64 * 1024
IMAGE_PACKAGE = "system-images;android-36.1;google_apis_ps16k;x86_64"
IMAGE_RELATIVE = Path("system-images/android-36.1/google_apis_ps16k/x86_64/source.properties")
IMAGE_PROPERTIES = {
    "Pkg.Revision": "4", "AndroidVersion.ApiLevel": "36.1", "AndroidVersion.ExtensionLevel": "20",
    "AndroidVersion.IsBaseSdk": "true", "SystemImage.Abi": "x86_64",
    "SystemImage.TagId": "google_apis,page_size_16kb",
}
EXPECTED_DEVICE = {
    "sdk": 36, "sdkFull": "36.1", "abi": "x86_64", "buildType": "userdebug",
    "kernel": "6.12.38-android16-5-gbb9513914902-ab13996879",
    "fingerprint": "google/sdk_gphone16k_x86_64/emu64xa16k:16/BE4B.251210.005/14574095:userdebug/dev-keys",
    "buildId": "BE4B.251210.005", "incremental": "14574095",
}
EXPECTED_IMAGE = {
    "package": IMAGE_PACKAGE, "revision": 4, "apiLevel": "36.1", "extensionLevel": 20,
    "archiveUrl": "https://dl.google.com/android/repository/sys-img/google_apis/x86_64-ps16k-36.1_r04.zip",
    "archiveBytes": 1913923004, "publishedArchiveSha1": "d812164d3704c2d5846d34e0a4d2c61cb1224a02",
    "originalSourcePropertiesSha256": "c54d726e02b6862fbf727529ce040aad70a878aa015f6e23a7a293ca4e20705f",
    "kernelSourceCommit": "bb9513914902b52a9751ea1126ad40518a38c89f",
    "archiveHashMeasuredByThisVerifier": False,
}
DEVICE_READS = (
    ("qemu", "getprop ro.kernel.qemu"), ("buildType", "getprop ro.build.type"),
    ("observerUid", "id -u"),
    ("pageSize", "getconf PAGE_SIZE"), ("sdk", "getprop ro.build.version.sdk"),
    ("sdkFull", "getprop ro.build.version.sdk_full"), ("abi", "getprop ro.product.cpu.abi"),
    ("kernel", "uname -r"), ("fingerprint", "getprop ro.system.build.fingerprint"),
    ("buildId", "getprop ro.build.id"), ("incremental", "getprop ro.build.version.incremental"),
)


def require(condition, message):
    if not condition:
        raise ValueError(message)


def emulator_prefix(prefix):
    require(isinstance(prefix, list) and len(prefix) == 3 and isinstance(prefix[0], str)
            and Path(prefix[0]).name == "adb" and prefix[1] == "-s"
            and isinstance(prefix[2], str) and re.fullmatch(r"emulator-[0-9]+", prefix[2]),
            "Select one explicit owned emulator ADB serial")


def numeric(value, label):
    require(isinstance(value, str) and re.fullmatch(r"[0-9]+", value), "Missing numeric " + label)
    return int(value)


class AdbRecorder:
    """Bounded argv/exit/raw-output evidence, shared by the image and trace guard."""
    def __init__(self, prefix, directory):
        require(os.name == "posix", "This bounded preparation requires the disposable Linux CI host")
        emulator_prefix(prefix)
        self.prefix, self.directory = prefix, directory
        directory.mkdir()
        self.started_ns = time.monotonic_ns()
        self.deadline_ns = self.started_ns + TOTAL_TIMEOUT_SECONDS * 1_000_000_000
        self.records = []

    def __call__(self, name, command, allow_failure=False, binary=False):
        require(re.fullmatch(r"[a-z0-9-]+", name), "Invalid evidence command label")
        started_ns = time.monotonic_ns()
        remaining_ns = self.deadline_ns - started_ns
        require(remaining_ns > 0, "Evidence collection exceeded its fixed total timeout")
        timeout_ns = min(COMMAND_TIMEOUT_SECONDS * 1_000_000_000, remaining_ns)
        timeout = timeout_ns / 1_000_000_000
        stem = self.directory / f"{len(self.records):02d}-{name}"
        paths = {key: stem.with_suffix("." + key) for key in ("stdout", "stderr")}
        arguments = self.prefix + ["shell", command]
        record = {"name": name, "arguments": arguments, "timeoutSeconds": timeout,
                  "perStreamLimitBytes": OUTPUT_LIMIT, "exitCode": None, "timedOut": False,
                  "startedOffsetNs": started_ns - self.started_ns}
        self.records.append(record)

        def limit_output():
            import resource
            resource.setrlimit(resource.RLIMIT_FSIZE, (OUTPUT_LIMIT, OUTPUT_LIMIT))

        with paths["stdout"].open("xb") as stdout, paths["stderr"].open("xb") as stderr:
            try:
                result = subprocess.run(arguments, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr,
                                        timeout=timeout, preexec_fn=limit_output)
                record["exitCode"] = result.returncode
            except subprocess.TimeoutExpired:
                record["timedOut"] = True
            finally:
                finished_ns = time.monotonic_ns()
                record["finishedOffsetNs"] = finished_ns - self.started_ns
                record["elapsedSeconds"] = (finished_ns - started_ns) / 1_000_000_000
        for key, path in paths.items():
            raw = path.read_bytes()
            record[key] = {"file": path.name, "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}
            require(len(raw) < OUTPUT_LIMIT, "Evidence output reached its fixed cap")
        require(not record["timedOut"], "Evidence command timed out: " + name)
        require(finished_ns <= self.deadline_ns and finished_ns - started_ns <= timeout_ns,
                "Evidence command exceeded its fixed measured time bound: " + name)
        require(allow_failure or record["exitCode"] == 0, "Evidence command failed: " + name)
        require(paths["stderr"].stat().st_size == 0, "Unexpected stderr in evidence command: " + name)
        raw = paths["stdout"].read_bytes()
        return record["exitCode"], raw if binary else raw.decode("utf-8").strip()


def validate_commands(commands, directory, plan, binary_names=()):
    require(isinstance(commands, list) and len(commands) == len(plan) and plan,
            "The exact evidence command plan is incomplete or has extras")
    prefix = commands[0]["arguments"][:3]
    emulator_prefix(prefix)
    observed = {}
    previous_finish = 0
    for index, (command, (name, shell_command, exit_code)) in enumerate(zip(commands, plan)):
        require(command["name"] == name and command["arguments"] == prefix + ["shell", shell_command]
                and type(command["exitCode"]) is int and command["exitCode"] == exit_code,
                "Evidence command order, exact argv, serial or exit status differs from the allowed plan")
        started, finished = command["startedOffsetNs"], command["finishedOffsetNs"]
        elapsed, timeout = command["elapsedSeconds"], command["timeoutSeconds"]
        require(type(started) is int and type(finished) is int
                and previous_finish <= started <= finished <= TOTAL_TIMEOUT_SECONDS * 1_000_000_000,
                "Command timing is nonsequential or exceeds the fixed total bound")
        require(type(elapsed) in (int, float) and math.isfinite(elapsed)
                and type(timeout) in (int, float) and math.isfinite(timeout)
                and timeout == min(COMMAND_TIMEOUT_SECONDS, (TOTAL_TIMEOUT_SECONDS * 1_000_000_000 - started) / 1_000_000_000)
                and elapsed == (finished - started) / 1_000_000_000 and 0 <= elapsed <= timeout,
                "Command measured duration or timeout exceeds the fixed bound")
        require(name not in observed and command["timedOut"] is False and timeout > 0
                and command["perStreamLimitBytes"] == OUTPUT_LIMIT, "Invalid bounded command provenance")
        previous_finish = finished
        for key in ("stdout", "stderr"):
            item = command[key]
            require(item["file"] == f"{index:02d}-{name}.{key}", "Invalid raw evidence path or command ownership")
            path = directory / item["file"]
            require(path.is_file() and path.stat().st_size < OUTPUT_LIMIT, "Missing or oversized raw command output")
            data = path.read_bytes()
            require(len(data) == item["bytes"] and hashlib.sha256(data).hexdigest() == item["sha256"],
                    "Raw command output does not match its proof")
            if key == "stdout":
                observed[name] = data if name in binary_names else data.decode("utf-8").strip()
            else:
                require(not data, "Unexpected stderr in a claimed successful evidence command")
    return observed, prefix


def parse_properties(raw):
    require(0 < len(raw) < OUTPUT_LIMIT, "Missing or oversized installed source.properties")
    fields = {}
    for line in raw.decode("utf-8").splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        require("=" in line, "Malformed installed image property")
        key, value = (part.strip() for part in line.split("=", 1))
        require(key and key not in fields, "Duplicate installed image property")
        fields[key] = value
    require(all(fields.get(key) == value for key, value in IMAGE_PROPERTIES.items()),
            "Installed system-image package/revision differs from the reviewed SDK 36.1 r4 image")
    return fields


def device_values(observed):
    return {name: numeric(observed[name.lower()], name) if name in ("pageSize", "sdk", "observerUid")
            else observed[name.lower()] for name, _ in DEVICE_READS}


def check_device(device, expected_page_size):
    require(expected_page_size in (4096, 16384) and device["qemu"] == "1"
            and device["buildType"] in ("userdebug", "eng") and device["pageSize"] == expected_page_size
            and device["observerUid"] in (0, 2000),
            "Unverified disposable emulator or changed guest page size")
    if expected_page_size == 16384:
        require(all(device.get(key) == value for key, value in EXPECTED_DEVICE.items()),
                "Runtime device/kernel differs from the reviewed SDK 36 / full 36.1 r4 image")
    else:
        require(device["sdk"] in (29, 35) and device["abi"] == "x86_64" and device["kernel"],
                "The unchanged 4 KiB gate requires its API 29 or 35 x86_64 image")


def capture(prefix, report_path, expected_page_size, disposable_emulator, sdk_root=None, recorder=None):
    require(disposable_emulator is True, "Explicit disposable-emulator ownership is required")
    emulator_prefix(prefix)
    require(not report_path.exists(), "Keep prior image evidence; output already exists")
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report = {"schemaVersion": 1, "checkedAtUtc": datetime.now(timezone.utc).isoformat(), "passed": False,
              "scope": "Read-only identity of the owned disposable CI emulator and its installed official image.",
              "explicitDisposableOwnership": True, "expectedPageSize": expected_page_size,
              "deviceModified": False, "commandTimeoutSeconds": COMMAND_TIMEOUT_SECONDS,
              "totalTimeoutSeconds": TOTAL_TIMEOUT_SECONDS, "perStreamOutputLimitBytes": OUTPUT_LIMIT,
              "maintenanceImageRequired": expected_page_size == 16384, "commands": []}
    execute = recorder
    try:
        if execute is None:
            execute = AdbRecorder(prefix, report_path.parent / "emulator-image-commands")
        observed = {}
        for name, command in DEVICE_READS:
            code, value = execute(name.lower(), command)
            require(code == 0, "Image identity read failed: " + name)
            observed[name.lower()] = value
        report["device"] = device_values(observed)
        check_device(report["device"], expected_page_size)
        if expected_page_size == 16384:
            require(sdk_root is not None, "Installed SDK location is required for 36.1 image provenance")
            source = Path(sdk_root) / IMAGE_RELATIVE
            require(source.is_file() and source.stat().st_size < OUTPUT_LIMIT, "Installed 36.1 source.properties is missing")
            raw = source.read_bytes()
            saved = report_path.parent / "emulator-image-source.properties"
            with saved.open("xb") as output:
                output.write(raw)
            report["installedSourceProperties"] = {"file": saved.name, "installedRelativePath": IMAGE_RELATIVE.as_posix(),
                                                    "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()}
            report["installedSourceProperties"]["properties"] = parse_properties(raw)
            report["expectedImage"] = EXPECTED_IMAGE
        report["passed"] = True
        return report
    except (OSError, ValueError, subprocess.SubprocessError) as failure:
        report["error"] = str(failure)[:1000]
        raise
    finally:
        report["commands"] = getattr(execute, "records", [])
        with report_path.open("x", encoding="utf-8") as output:
            json.dump(report, output, indent=2, allow_nan=False)
            output.write("\n")


def validate_report(path, expected_page_size):
    require(path.is_file() and 0 < path.stat().st_size <= 256 * 1024, "Missing or oversized image identity proof")
    raw = path.read_bytes()
    proof = json.loads(raw)
    require(proof["schemaVersion"] == 1 and proof["passed"] is True and proof["explicitDisposableOwnership"] is True
            and proof["deviceModified"] is False and proof["expectedPageSize"] == expected_page_size
            and proof["maintenanceImageRequired"] is (expected_page_size == 16384)
            and proof["commandTimeoutSeconds"] == COMMAND_TIMEOUT_SECONDS
            and proof["totalTimeoutSeconds"] == TOTAL_TIMEOUT_SECONDS and proof["perStreamOutputLimitBytes"] == OUTPUT_LIMIT,
            "Unverified image identity or changed observation bounds")
    observed, prefix = validate_commands(proof["commands"], path.parent / "emulator-image-commands",
                                        [(name.lower(), command, 0) for name, command in DEVICE_READS])
    device = device_values(observed)
    require(device == proof["device"], "Raw image identity differs from the summary")
    check_device(device, expected_page_size)
    source_sha = None
    if expected_page_size == 16384:
        require(proof["expectedImage"] == EXPECTED_IMAGE, "Reviewed system image provenance changed")
        source = proof["installedSourceProperties"]
        require(source["file"] == "emulator-image-source.properties"
                and source["installedRelativePath"] == IMAGE_RELATIVE.as_posix(), "Unexpected installed-image metadata path")
        metadata = path.parent / source["file"]
        require(metadata.is_file() and 0 < metadata.stat().st_size < OUTPUT_LIMIT, "Missing bounded installed-image metadata")
        data = metadata.read_bytes()
        source_sha = hashlib.sha256(data).hexdigest()
        require(len(data) == source["bytes"] and source_sha == source["sha256"]
                and parse_properties(data) == source["properties"], "Installed-image raw metadata differs from its proof")
    else:
        require("expectedImage" not in proof and "installedSourceProperties" not in proof,
                "Unchanged 4 KiB image must not claim the 36.1 maintenance update")
    return {"passed": True, "reportSha256": hashlib.sha256(raw).hexdigest(), "device": device, "serial": prefix[2],
            "maintenanceImageRequired": expected_page_size == 16384,
            "package": IMAGE_PACKAGE if expected_page_size == 16384 else None,
            "revision": 4 if expected_page_size == 16384 else None,
            "installedSourcePropertiesSha256": source_sha, "deviceModified": False}
