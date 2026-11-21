#!/usr/bin/env python3
"""One planned root transition for the owned release emulator, never a root retry.

An exact root transport closure is an unknown acknowledgement. Only a later
UID 0 and unchanged observed image properties can complete this phase. This
does not prove continuous boot or a particular adbd PID transition.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
import subprocess
import time

TOTAL_TIMEOUT_SECONDS = 60
COMMAND_TIMEOUT_SECONDS = 30
OUTPUT_LIMIT = 65536
IDENTITY_KEYS = ("qemu", "buildType", "sdk", "abi", "fingerprint")
IDENTITY_COMMAND = "; ".join("getprop " + item for item in (
    "ro.kernel.qemu", "ro.build.type", "ro.build.version.sdk", "ro.product.cpu.abi", "ro.system.build.fingerprint"))
READY_COMMAND = "id -u; " + IDENTITY_COMMAND
ROOT_CLOSED = "adb: unable to connect for root: closed"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def identity(raw):
    values = raw.strip().splitlines()
    require(len(values) == len(IDENTITY_KEYS) and all(values), "Incomplete release emulator identity")
    value = dict(zip(IDENTITY_KEYS, values))
    require(value["qemu"] == "1" and value["buildType"] in ("userdebug", "eng"),
            "Refusing release root on a physical or non-userdebug device")
    require(re.fullmatch(r"[0-9]+", value["sdk"]) and re.fullmatch(r"[a-zA-Z0-9_-]+", value["abi"]),
            "Malformed release emulator identity")
    return value


def disconnected(code, stdout, stderr, serial):
    return code == 1 and not stdout and stderr in {
        "error: closed", "error: device offline", "adb: device offline",
        f"error: device '{serial}' not found", f"adb: device '{serial}' not found",
        "error: no devices/emulators found", "adb: no devices/emulators found",
    }


def establish_root(prefix, report_path, disposable_emulator, *, runner=subprocess.run,
                   clock=time.monotonic, sleep=time.sleep):
    require(disposable_emulator is True, "Explicit disposable release-emulator ownership is required")
    require(isinstance(prefix, list) and len(prefix) == 3 and Path(prefix[0]).name == "adb"
            and prefix[1] == "-s" and re.fullmatch(r"emulator-[0-9]+", prefix[2]),
            "Select one explicit owned release emulator serial")
    require(not report_path.exists(), "Preserve the existing root-readiness evidence")
    report_path.parent.mkdir(parents=True, exist_ok=True)
    directory = report_path.parent / "root-readiness-commands"
    directory.mkdir()
    started = clock()
    deadline = started + TOTAL_TIMEOUT_SECONDS
    report = {"schemaVersion": 1, "passed": False, "serial": prefix[2], "explicitDisposableOwnership": True,
              "scope": "One root request plus bounded readonly readiness on the owned release emulator.",
              "continuousBootVerified": False, "rootRequests": 0, "rootReissued": False,
              "rootTransportClosed": False, "readinessQueries": 0,
              "totalTimeoutSeconds": TOTAL_TIMEOUT_SECONDS, "rootCommandTimeoutSeconds": COMMAND_TIMEOUT_SECONDS,
              "perStreamOutputLimitBytes": OUTPUT_LIMIT, "commands": []}

    def capture(name, arguments, maximum=COMMAND_TIMEOUT_SECONDS):
        began = clock()
        remaining = deadline - began
        require(remaining > 0, "Release root readiness exceeded its original 60-second budget")
        timeout = min(maximum, remaining)
        paths = {key: directory / f"{len(report['commands']):02d}-{name}.{key}" for key in ("stdout", "stderr")}
        row = {"name": name, "arguments": prefix + arguments, "timeoutSeconds": timeout,
               "startedOffsetSeconds": began - started, "exitCode": None, "timedOut": False}
        report["commands"].append(row)

        def cap_output():
            import resource
            resource.setrlimit(resource.RLIMIT_FSIZE, (OUTPUT_LIMIT, OUTPUT_LIMIT))

        result = None
        try:
            with paths["stdout"].open("xb") as stdout, paths["stderr"].open("xb") as stderr:
                try:
                    launched = clock()
                    require(launched < deadline, "Release root readiness exceeded its original 60-second budget")
                    timeout = min(maximum, deadline - launched)
                    row.update(timeoutSeconds=timeout, startedOffsetSeconds=launched - started)
                    if name == "root":
                        require(report["rootRequests"] == 0, "Release root must never be reissued")
                        report["rootRequests"] = 1
                    result = runner(prefix + arguments, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr,
                                    timeout=timeout, preexec_fn=cap_output)
                    row["exitCode"] = result.returncode
                except subprocess.TimeoutExpired:
                    row["timedOut"] = True
                    raise
        finally:
            finished = clock()
            row["finishedOffsetSeconds"] = finished - started
            row["elapsedSeconds"] = row["finishedOffsetSeconds"] - row["startedOffsetSeconds"]
            for key, path in paths.items():
                if not path.is_file():
                    row[key] = {"file": path.name, "missing": True}
                    continue
                data = path.read_bytes()
                row[key] = {"file": path.name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
        require(finished <= deadline and row["elapsedSeconds"] <= timeout, "Release root command exceeded its measured timeout")
        require(all(row[key]["bytes"] < OUTPUT_LIMIT for key in paths), "Release root evidence reached its output cap")
        return result.returncode, paths["stdout"].read_text().strip(), paths["stderr"].read_text().strip()

    def pause():
        remaining = deadline - clock()
        require(remaining > 0, "Release root readiness exceeded its original 60-second budget")
        sleep(min(1, remaining))

    try:
        code, stdout, stderr = capture("identity-before", ["shell", IDENTITY_COMMAND])
        require(code == 0 and not stderr, "Could not observe the release emulator before root")
        report["identityBefore"] = identity(stdout)
        code, stdout, stderr = capture("root", ["root"])
        # AOSP Android 16 restart_root_service sets service.adb.root before its
        # reply. The client can return before its internal waits on connect
        # failure. The exact EOF is not success: re-observe below, never resend.
        closed = code == 1 and not stdout and stderr == ROOT_CLOSED
        # The AOSP client also accepts an empty reply after its internal waits;
        # preserve that successful exit case, still requiring fresh UID 0.
        acknowledged = code == 0 and not stderr and stdout in {
            "", "restarting adbd as root", "adbd is already running as root"}
        require(closed or acknowledged, "ADB root failed without the recognized acknowledgement or transport closure")
        report["rootTransportClosed"] = closed
        while True:
            code, stdout, stderr = capture("wait-for-device", ["wait-for-device"], TOTAL_TIMEOUT_SECONDS)
            if disconnected(code, stdout, stderr, prefix[2]):
                pause()
                continue
            require(code == 0 and not stdout and not stderr, "ADB wait failed with an unrecognized result")
            code, stdout, stderr = capture("root-identity", ["shell", READY_COMMAND])
            report["readinessQueries"] += 1
            if disconnected(code, stdout, stderr, prefix[2]):
                pause()
                continue
            require(code == 0 and not stderr, "Could not observe root readiness")
            values = stdout.splitlines()
            require(values and values[0] in ("0", "2000"), "Unexpected release observer UID")
            after = identity("\n".join(values[1:]))
            require(after == report["identityBefore"], "Release emulator identity changed during root transition")
            report["lastObservedUid"] = int(values[0])
            if values[0] == "0":
                report.update(passed=True, observerUid=0, identityAfter=after)
                return report
            # wait-for-device can still expose the old shell transport before
            # adbd's planned restart. This only observes; it never repeats root.
            pause()
    except (OSError, ValueError, subprocess.SubprocessError) as error:
        report["error"] = str(error)[:1000]
        raise
    finally:
        report["elapsedSeconds"] = clock() - started
        with report_path.open("x", encoding="utf-8") as stream:
            json.dump(report, stream, indent=2, allow_nan=False)
            stream.write("\n")
