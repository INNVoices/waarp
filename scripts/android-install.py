#!/usr/bin/env python3
"""Install the verified APK matching one explicitly selected ADB device."""
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent.parent


def run(args):
    result = subprocess.run(args, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=180)
    if result.returncode:
        raise RuntimeError(result.stdout.strip())
    return result.stdout.strip()


def collect_install_failure(prefix, report_path, failed_command, error, *, diagnostic_runner=None, monotonic=time.monotonic):
    """Observe one failed install on an explicitly disposable emulator; never recover it."""
    if len(prefix) != 3 or prefix[1] != "-s" or not re.fullmatch(r"emulator-[0-9]+", prefix[2]):
        raise ValueError("Install diagnostics require an explicitly selected emulator")
    spec = importlib.util.spec_from_file_location("android_emulator_prepare", ROOT / "scripts/android-emulator-prepare.py")
    preparation = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(preparation)
    diagnostic_runner = diagnostic_runner or preparation.run_diagnostic_command
    started = monotonic()
    deadline = started + preparation.FAILURE_DIAGNOSTIC_SECONDS
    report_path = Path(report_path)
    raw = report_path.with_name(report_path.stem + "-raw")
    report = {
        "schemaVersion": 1, "checkedAtUtc": datetime.now(timezone.utc).isoformat(), "serial": prefix[2],
        "passed": False, "failedCommand": failed_command, "originalError": f"{type(error).__name__}: {error}"[:4096],
        "diagnosticsAllowed": False, "collectionFinished": False, "commands": [],
        "timeoutSeconds": preparation.FAILURE_DIAGNOSTIC_SECONDS,
        "perCommandTimeoutSeconds": preparation.FAILURE_DIAGNOSTIC_COMMAND_SECONDS,
        "scope": "Read-only observations after failed APK installation, before emulator teardown; not recovery, application acceptance or proof of the failure's cause.",
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    # Keep the first failure intact if this destination is accidentally reused.
    with report_path.open("x", encoding="utf-8") as stream:
        stream.write(json.dumps(report, indent=2) + "\n")

    def save():
        report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")

    def observe(name, arguments, limit=16384):
        entry = {"name": name, "arguments": list(arguments), "attempted": False, "outputLimitBytesPerStream": limit}
        report["commands"].append(entry)
        remaining = deadline - monotonic()
        if remaining <= 0:
            entry["skipped"] = "Diagnostic deadline exhausted"
            return None
        entry.update(attempted=True, timeoutSeconds=min(preparation.FAILURE_DIAGNOSTIC_COMMAND_SECONDS, remaining))
        paths = {stream: raw / (name + "." + stream + ".txt") for stream in ("stdout", "stderr")}
        save()
        try:
            entry.update(diagnostic_runner(prefix + list(arguments), entry["timeoutSeconds"], paths["stdout"], paths["stderr"], limit))
        except (Exception, KeyboardInterrupt) as diagnostic_error:
            entry["collectorError"] = f"{type(diagnostic_error).__name__}: {diagnostic_error}"[:4096]
        finally:
            for stream, path in paths.items():
                if not path.is_file():
                    entry[stream] = {"available": False}
                    continue
                size = path.stat().st_size
                if size > limit:
                    raise RuntimeError("Diagnostic runner exceeded its raw output cap")
                entry[stream] = {"available": True, "file": str(path.relative_to(report_path.parent)),
                                 "bytes": size, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(), "limitReached": size == limit}
            save()
        if (entry.get("exitCode") != 0 or entry.get("timedOut") or entry.get("collectorError")
                or not all(entry.get(stream, {}).get("available") for stream in paths)
                or entry["stderr"]["bytes"] or entry["stdout"]["limitReached"]):
            return None
        return paths["stdout"].read_text(encoding="utf-8", errors="replace").strip()

    try:
        raw.mkdir(exist_ok=False)
        properties = {name: observe(name, ("shell", "getprop", name))
                      for name in ("ro.kernel.qemu", "ro.boot.qemu", "ro.debuggable")}
        if "1" not in (properties["ro.kernel.qemu"], properties["ro.boot.qemu"]) or properties["ro.debuggable"] != "1":
            report["guardError"] = "Disposable debuggable QEMU guest not confirmed; no framework logs collected"
            return report
        report["diagnosticsAllowed"] = True
        for name, arguments, limit in (
            ("logcat-crash", ("shell", "logcat", "-d", "-b", "crash", "-v", "threadtime", "-t", "256"), preparation.FAILURE_DIAGNOSTIC_BYTES),
            ("framework-pids", ("shell", "pidof", "system_server", "zygote", "zygote64"), 16384),
            ("package-service", ("shell", "service", "check", "package"), 16384),
            ("settings-service", ("shell", "service", "check", "settings"), 16384),
            ("logcat-recent", ("shell", "logcat", "-d", "-b", "all", "-v", "threadtime", "-t", "1200"), preparation.FAILURE_DIAGNOSTIC_BYTES),
            ("kernel", ("shell", "dmesg", "-S", "-s", "262144"), 512 * 1024),
            ("memory-and-uptime", ("shell", "cat", "/proc/meminfo", "/proc/uptime"), 16384),
            ("processes", ("shell", "ps", "-A", "-o", "PID,PPID,NAME"), 128 * 1024),
        ):
            observe(name, arguments, limit)
        report["collectionFinished"] = True
    except (Exception, KeyboardInterrupt) as diagnostic_error:
        report["collectorError"] = f"{type(diagnostic_error).__name__}: {diagnostic_error}"[:4096]
    finally:
        report["seconds"] = round(monotonic() - started, 3)
        report["deadlineExhausted"] = monotonic() >= deadline
        save()
    return report


def install(prefix, arguments, failure_report=None):
    try:
        return run(prefix + arguments)
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
        if failure_report is not None:
            try:
                collect_install_failure(prefix, failure_report, arguments, error)
            except (Exception, KeyboardInterrupt) as diagnostic_error:
                print(f"Install failure diagnostics unavailable: {type(diagnostic_error).__name__}", file=sys.stderr)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--serial", help="ADB serial; required when more than one device is connected")
    parser.add_argument("--variant", choices=("debug", "release"), default="debug")
    parser.add_argument("--launch", action="store_true")
    parser.add_argument("--with-tests", action="store_true")
    parser.add_argument("--disposable-emulator", action="store_true", help="Confirm that the selected emulator contains only disposable CI fixtures")
    parser.add_argument("--failure-report", type=Path, help="Opt-in bounded read-only install failure evidence before emulator teardown")
    options = parser.parse_args()
    if options.with_tests and options.variant != "debug":
        parser.error("The instrumentation APK targets only the debug application.")
    if options.failure_report is not None and (not options.disposable_emulator or not re.fullmatch(r"emulator-[0-9]+", options.serial or "")):
        parser.error("--failure-report requires --disposable-emulator and an explicit emulator serial")
    sdk = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
    adb = shutil.which("adb") or (str(Path(sdk) / "platform-tools" / ("adb.exe" if os.name == "nt" else "adb")) if sdk else None)
    if not adb:
        raise RuntimeError("Set ANDROID_HOME or put Android platform-tools/adb on PATH.")
    devices = [line.split()[0] for line in run([adb, "devices"]).splitlines()[1:] if line.split()[1:] == ["device"]]
    serial = options.serial
    if not serial:
        if len(devices) != 1:
            raise RuntimeError("Exactly one authorized ADB device is required; use --serial to select a device.")
        serial = devices[0]
    if serial not in devices:
        raise RuntimeError("The selected ADB device is disconnected or has not authorized this computer.")
    prefix = [adb, "-s", serial]
    abis = run(prefix + ["shell", "getprop", "ro.product.cpu.abilist"]).split(",")
    output = ROOT / "out/android"
    metadata = json.loads((output / "artifacts.json").read_text())
    selected = next((entry for abi in abis for entry in metadata["artifacts"] if entry["abi"] == abi and entry["variant"] == options.variant), None)
    if not selected:
        raise RuntimeError("No signed APK of the requested variant matches this device. Unsigned release APKs cannot be installed.")
    spec = importlib.util.spec_from_file_location("android_verify", ROOT / "scripts/android-verify.py")
    verifier = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(verifier)
    apk = output / selected["file"]
    verifier.verify(apk, options.variant)
    print(install(prefix, ["install", "-r", str(apk)], options.failure_report))
    if options.with_tests:
        print(install(prefix, ["install", "-r", "-t", str(output / metadata["instrumentation"])], options.failure_report))
    if options.launch:
        print(run(prefix + ["shell", "am", "start", "-n", f"{selected['packageId']}/local.waarp.android.MainActivity"]))
    print(f"Installed {apk.name} on {serial}.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
        print(f"Android install failed: {error}", file=sys.stderr)
        raise SystemExit(1)
