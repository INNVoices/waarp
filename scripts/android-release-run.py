#!/usr/bin/env python3
"""Install and exercise the exact optimized release payload on a disposable emulator.

UI Automator is self-instrumenting in another APK/UID. No production test hooks,
debuggable flag or keep rules are introduced to make the app testable.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parent.parent
APP = "local.waarp.android"
TEST = "local.waarp.android.acceptance"


def require(value, message):
    if not value:
        raise ValueError(message)


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / filename)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def run(arguments, timeout=30):
    result = subprocess.run(arguments, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=timeout)
    require(result.returncode == 0, result.stdout[-4000:] or f"Command failed: {Path(arguments[0]).name}")
    return result.stdout.strip()


def exercise(arguments, prefix, output, mode, timeout):
    """Preserve output as it arrives; emit only public progress counters every minute."""
    transcript = output / "instrumentation.txt"
    deadline = time.monotonic() + timeout
    next_progress = time.monotonic() + 60
    timed_out = False
    kind = "smoke" if mode == "journeys" else "soak"
    with transcript.open("w") as log:
        process = subprocess.Popen(arguments, stdout=log, stderr=subprocess.STDOUT, text=True)
        while process.poll() is None:
            now = time.monotonic()
            if now >= deadline:
                timed_out = True
                process.terminate()
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    process.kill(); process.wait(timeout=10)
                break
            if now >= next_progress:
                try:
                    status = run(prefix + ["exec-out", "cat", f"/sdcard/Android/data/{TEST}/files/release-acceptance/release-{kind}.json"], timeout=15)
                    require(len(status) <= 65536, "Oversized progress report.")
                    observed = json.loads(status)
                    print(json.dumps({"progress": mode, "elapsedMs": observed.get("elapsedMs"),
                                      "successfulRounds": observed.get("successfulRounds"), "httpBytes": observed.get("httpBytes"),
                                      "lastEvent": next((event["name"] for event in reversed(observed.get("events", []))), None)}), flush=True)
                except (OSError, ValueError, KeyError, subprocess.TimeoutExpired):
                    print(json.dumps({"progress": mode, "observation": "No completed progress snapshot yet"}), flush=True)
                next_progress = time.monotonic() + 60
            time.sleep(.5)
    return transcript.read_text(errors="replace"), process.returncode, timed_out


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("journeys", "soak"), required=True)
    parser.add_argument("--expect-page-size", type=int, choices=(4096, 16384), required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--serial")
    parser.add_argument("--duration-seconds", type=int, default=7200)
    parser.add_argument("--interval-seconds", type=int, default=15)
    parser.add_argument("--disposable-emulator", action="store_true",
                        help="Explicitly allow reset/kill only for the two fixture packages on an Android emulator")
    options = parser.parse_args()
    require(options.disposable_emulator, "This acceptance resets fixture app state; explicitly select a disposable emulator.")
    require(7200 <= options.duration_seconds <= 10800, "Soak duration must be two to three hours.")
    require(10 <= options.interval_seconds <= 30, "Expected a bounded 10–30 second traffic interval.")
    sdk = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
    adb = shutil.which("adb") or (str(Path(sdk) / "platform-tools" / ("adb.exe" if os.name == "nt" else "adb")) if sdk else None)
    require(adb, "Android platform-tools/adb is required.")
    devices = [line.split()[0] for line in run([adb, "devices"]).splitlines()[1:] if line.split()[1:] == ["device"]]
    serial = options.serial or (devices[0] if len(devices) == 1 else None)
    require(serial in devices, "Select exactly one connected disposable emulator with --serial.")
    prefix = [adb, "-s", serial]
    shell = lambda *arguments: run(prefix + ["shell", *arguments])
    require(shell("getprop", "ro.kernel.qemu") == "1", "Refusing fixture reset/root on a physical Android device.")
    require(shell("getprop", "ro.build.type") in ("userdebug", "eng"), "Expected a disposable userdebug emulator image.")
    run(prefix + ["root"])
    run(prefix + ["wait-for-device"], timeout=60)
    require(shell("id", "-u") == "0", "Root observation is required for real process/FD metrics in this isolated fixture.")
    page_size = int(shell("getconf", "PAGE_SIZE"))
    require(page_size == options.expect_page_size, "Actual emulator page size does not match the gate.")
    device = {"sdk": shell("getprop", "ro.build.version.sdk"), "release": shell("getprop", "ro.build.version.release"),
              "abi": shell("getprop", "ro.product.cpu.abi"), "pageSize": page_size,
              "observerUid": 0, "scope": "Disposable userdebug emulator; the target release APK remains non-debuggable."}
    output = options.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    verify = module("android_release_verify", "android-verify.py")
    instrumentation = module("android_instrument_result", "android-instrument.py")
    evidence_validator = module("android_release_proof", "android-release-proof.py")
    frame_validator = module("android_foreground_proof", "android-foreground-proof.py")
    image_verifier = module("android_emulator_image", "android-emulator-image.py")
    image_verifier.capture(prefix, output / "emulator-image.json", page_size, options.disposable_emulator, sdk_root=sdk)
    image_proof = image_verifier.validate_report(output / "emulator-image.json", page_size)
    ftrace_preparer = module("android_ftrace_prepare", "android-ftrace-prepare.py")
    ftrace_preparer.prepare(prefix, output / "ftrace-preparation.json", page_size, options.disposable_emulator)
    ftrace_preparation = ftrace_preparer.validate_report(output / "ftrace-preparation.json", page_size)
    metadata = json.loads((ROOT / "out/android/artifacts.json").read_text())
    selected = next((entry for entry in metadata["artifacts"] if entry["abi"] == device["abi"] and entry["variant"] == "release-unsigned"), None)
    require(selected is not None, "A verified unsigned release APK for this emulator is required.")
    source = ROOT / "out/android" / selected["file"]
    acceptance = ROOT / "out/android" / metadata["releaseAcceptance"]
    badging = run([verify.tool("aapt"), "dump", "badging", str(acceptance)], timeout=120)
    require(f"package: name='{TEST}'" in badging, "Unexpected acceptance APK package.")
    manifest = run([verify.tool("aapt"), "dump", "xmltree", str(acceptance), "AndroidManifest.xml"], timeout=120)
    blocks = []
    lines = manifest.splitlines()
    for index, line in enumerate(lines):
        if line.lstrip().startswith("E: instrumentation "):
            indent = len(line) - len(line.lstrip())
            attributes = []
            for following in lines[index + 1:]:
                if following.strip() and len(following) - len(following.lstrip()) <= indent:
                    break
                attributes.append(following)
            blocks.append("\n".join(attributes))
    require(len(blocks) == 1 and re.search(r'android:targetPackage\([^)]*\)="' + re.escape(TEST) + '"', blocks[0])
            and re.search(r'android:name\([^)]*\)="androidx\.test\.runner\.AndroidJUnitRunner"', blocks[0]),
            "The acceptance APK must instrument only its own UID/package.")
    run([verify.tool("apksigner"), "verify", str(acceptance)], timeout=120)
    with tempfile.TemporaryDirectory(prefix="waarp-release-install-") as temporary:
        signed_apk = Path(temporary) / "waarp-ci-release.apk"
        run([sys.executable, str(ROOT / "scripts/android-sign.py"), "ci-copy", "--apk", str(source), "--output", str(signed_apk)], timeout=300)
        installed = json.loads(signed_apk.with_suffix(".apk.validation.json").read_text())
        require(installed["variant"] == "release-ci" and installed["payloadUnchangedBySigning"], "Release payload was changed for testing.")
        (output / "installed-apk.json").write_text(json.dumps(installed, indent=2) + "\n")
        run(prefix + ["install", "-r", str(signed_apk)], timeout=180)
        run(prefix + ["install", "-r", "-t", str(acceptance)], timeout=180)
    preflight = instrumentation.capture_preflight(prefix, output)
    test_class = "ReleaseAcceptanceTest" if options.mode == "journeys" else "ReleaseSoakTest"
    arguments = prefix + ["shell", "am", "instrument", "-w", "-r", "-e", "class", f"{TEST}.{test_class}",
                          "-e", "allowTargetReset", "true", "-e", "requireProcMetrics", "true",
                          "-e", "durationSeconds", str(options.duration_seconds),
                          "-e", "intervalSeconds", str(options.interval_seconds),
                          f"{TEST}/androidx.test.runner.AndroidJUnitRunner"]
    started = time.monotonic()
    transcript, exit_code, timed_out = exercise(arguments, prefix, output, options.mode,
                                               options.duration_seconds + 900 if options.mode == "soak" else 1200)
    elapsed = time.monotonic() - started
    (output / "instrumentation.txt").write_text(transcript)
    parsed = instrumentation.parse_instrumentation(transcript, exit_code, timed_out)
    report = {"schemaVersion": 1, "checkedAtUtc": datetime.now(timezone.utc).isoformat(), "mode": options.mode,
              "device": device, "preflight": preflight, "emulatorImage": image_proof,
              "ftracePreparation": ftrace_preparation, "wallSeconds": elapsed,
              "requestedDurationSeconds": options.duration_seconds if options.mode == "soak" else None,
              "requestedIntervalSeconds": options.interval_seconds, "installedApk": installed, **parsed}
    # A global Google/system broadcast backlog is observed, not used as a proxy
    # for target readiness. The actual UI, traffic and completion gates are mandatory.
    if parsed["tests"] != 1:
        report["passedGate"] = False
    try:
        run(prefix + ["pull", f"/sdcard/Android/data/{TEST}/files/release-acceptance", str(output / "app-evidence")], timeout=120)
    except ValueError as error:
        report["passedGate"] = False
        report["evidenceError"] = str(error)
    try:
        report["foregroundTraces"] = frame_validator.collect_traces(prefix, output / "app-evidence", output / "foreground-traces")
    except (OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired) as error:
        report["passedGate"] = False
        report["foregroundTraceCollectionError"] = str(error)
    try:
        checked = evidence_validator.validate_device(output, options.mode, installed, options.duration_seconds, options.interval_seconds,
                                                     expected_page_size=page_size)
        report["deviceEvidence"] = {key: value for key, value in checked.items() if key != "summary"}
    except (OSError, ValueError, KeyError, TypeError) as error:
        report["passedGate"] = False
        report["evidenceValidationError"] = str(error)
    for name, arguments in (
        ("crash-buffer.txt", ["logcat", "-b", "crash", "-d", "-v", "threadtime"]),
        ("meminfo.txt", ["shell", "dumpsys", "meminfo", APP]),
        ("process-exit-info.txt", ["shell", "dumpsys", "activity", "exit-info", APP]),
        ("gfxinfo.txt", ["shell", "dumpsys", "gfxinfo", APP, "framestats"]),
    ):
        result = subprocess.run(prefix + arguments, capture_output=True, text=True, timeout=30)
        observed = (result.stdout + result.stderr)[-2 * 1024 * 1024:]
        (output / name).write_text(observed)
        if name == "gfxinfo.txt":
            report["postScenarioGfxinfoScope"] = "Post-scenario diagnostic only. Smoke intentionally has no live process; use foregroundFrames for scoped UI observations."
        if name == "crash-buffer.txt":
            app_crash = bool(re.search(r'(?:Process:|Cmdline:)\s*local\.waarp\.android(?:,|\s|$)|>>>\s*local\.waarp\.android\s*<<<', observed))
            report["appCrashObserved"] = app_crash
            if result.returncode != 0 or app_crash:
                report["passedGate"] = False
                report["crashBufferError"] = "Target crash observed or Android crash evidence could not be read."
    # A service restart rotates native panic output into crash_reports/*/go.log.
    # Include that exact allowlisted history, never the associated config files.
    crash_reader = module("android_native_crash_evidence", "android-crash-evidence.py")
    native = crash_reader.collect_native_crashes(prefix, output, APP)
    report["nativeCrashEvidence"] = native
    report["nativeCrashEvidenceAvailable"] = native["available"]
    if not native["passed"]:
        report["passedGate"] = False
        report["nativeCrashError"] = "Current or archived native crash evidence is missing, oversized, or contains a runtime failure."
    if options.mode == "soak" and elapsed < options.duration_seconds:
        report["passedGate"] = False
        report["durationError"] = "The requested real wall-clock soak duration was not completed."
    if report["passedGate"]:
        try:
            launches = []
            for _ in range(3):
                shell("am", "force-stop", APP)
                launch = shell("am", "start", "-W", "-n", f"{APP}/local.waarp.android.MainActivity")
                match = re.search(r"^TotalTime: (\d+)", launch, re.M)
                require("Status: ok" in launch and match is not None, "Release Activity launch did not complete.")
                launches.append(int(match.group(1)))
            report["coldActivityLaunchMs"] = launches
            report["coldLaunchUpperBoundMs"] = 10000
            report["performanceScope"] = "Three real optimized-release cold Activity launches on this emulator; physical-device frame performance is not inferred."
            require(all(0 < value <= 10000 for value in launches), "Release cold launch exceeded its 10-second completion budget.")
        except (OSError, ValueError, subprocess.TimeoutExpired) as error:
            report["passedGate"] = False
            report["startupError"] = str(error)
    if not report["passedGate"]:
        result = subprocess.run(prefix + ["logcat", "-d", "-v", "threadtime", "-t", "2000"], capture_output=True, text=True, timeout=30)
        (output / "logcat-failure.txt").write_text((result.stdout + result.stderr)[-2 * 1024 * 1024:])
        # Explicit fixture ownership was checked before installation; never stop other packages.
        run(prefix + ["shell", "am", "force-stop", TEST])
        run(prefix + ["shell", "am", "force-stop", APP])
    (output / "result.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"mode": options.mode, "device": device, "tests": parsed["tests"], "passed": parsed["passed"],
                      "failed": parsed["failed"], "skipped": parsed["skipped"], "wallSeconds": elapsed, "passedGate": report["passedGate"]}))
    if not report["passedGate"]:
        print(transcript[-12000:], file=sys.stderr)
    return 0 if report["passedGate"] else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, KeyError, subprocess.TimeoutExpired) as error:
        print(f"Release acceptance failed: {error}", file=sys.stderr)
        raise SystemExit(1)
