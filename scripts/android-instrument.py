#!/usr/bin/env python3
"""Run the shipped debug instrumentation APK on a real ADB device/emulator.

The runner fails on process crashes, timeouts, an empty suite or skipped tests.
It consumes AndroidJUnitRunner's status protocol, never infers success from an
ADB shell exit code alone. The app and test APK must already be installed.
"""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import time


def capture_preflight(prefix, output):
    """Drain boot broadcasts and record actual guest/host memory before tests."""
    commands = [
        ("broadcast-idle.txt", ["shell", "am", "wait-for-broadcast-idle"], 30),
        ("device-meminfo-before.txt", ["shell", "cat", "/proc/meminfo"], 10),
        ("device-process-memory-before.txt", ["shell", "dumpsys", "meminfo"], 15),
    ]
    statuses = {}
    for filename, arguments, timeout in commands:
        started = time.monotonic()
        try:
            result = subprocess.run(prefix + arguments, capture_output=True, text=True, errors="replace", timeout=timeout)
            content = result.stdout + result.stderr
            status = {"exitCode": result.returncode, "timedOut": False}
        except subprocess.TimeoutExpired as error:
            chunks = (error.stdout or "", error.stderr or "")
            content = "".join(chunk.decode("utf8", errors="replace") if isinstance(chunk, bytes) else chunk for chunk in chunks)
            content += f"\nDiagnostic command exceeded {timeout} seconds.\n"
            status = {"exitCode": None, "timedOut": True}
        except OSError as error:
            content = f"Preflight collection failed: {type(error).__name__}\n"
            status = {"exitCode": None, "timedOut": False}
        status["seconds"] = round(time.monotonic() - started, 3)
        statuses[filename] = status
        (output / filename).write_text(content[-2 * 1024 * 1024:])
    try:
        host_memory = Path("/proc/meminfo").read_text()
    except OSError:
        host_memory = "Host /proc/meminfo is unavailable on this platform.\n"
    (output / "host-meminfo-before.txt").write_text(host_memory[:64 * 1024])
    report = {"hostCpuCount": os.cpu_count(), "commands": statuses,
              "broadcastQueuesIdle": statuses["broadcast-idle.txt"]["exitCode"] == 0,
              "scope": "Framework broadcast-queue idle and memory snapshots; no dialogs dismissed, crash records cleared, or tests skipped."}
    (output / "preflight.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


def capture_logs(prefix, output, failed):
    """Preserve JNI/Java crash evidence before the disposable emulator exits."""
    requests = [("crash-buffer.txt", ["-b", "crash", "-d", "-v", "threadtime"])]
    if failed:
        requests.append(("logcat-failure.txt", ["-d", "-v", "threadtime", "-t", "2000"]))
    for filename, arguments in requests:
        try:
            result = subprocess.run(prefix + ["logcat", *arguments], capture_output=True, text=True, timeout=20)
            content = result.stdout + result.stderr
        except (OSError, subprocess.TimeoutExpired) as error:
            content = f"Log collection failed: {type(error).__name__}\n"
        # Keep bounded diagnostics even if one native log line is unusually large.
        (output / filename).write_text(content[-2 * 1024 * 1024:])
    # The pinned libbox Setup redirects Go stderr here, outside Android logcat.
    # Read this exact crash file only; never enumerate app storage/configurations.
    try:
        result = subprocess.run(prefix + ["exec-out", "run-as", "local.waarp.android.debug", "cat",
                                "no_backup/libbox/work/CrashReport-waarp-android.log"],
                                capture_output=True, text=True, timeout=20)
        native = result.stdout + result.stderr
    except (OSError, subprocess.TimeoutExpired) as error:
        native = f"Native crash collection failed: {type(error).__name__}\n"
    native = re.sub(r"(?<![0-9a-fA-F])[0-9a-fA-F]{64}(?![0-9a-fA-F])", "[REDACTED_32_BYTE_KEY]", native)
    native = re.sub(r"(?<![A-Za-z0-9+/_-])(?:[A-Za-z0-9+/_-]{43}=|[A-Za-z0-9+/_-]{44})(?![A-Za-z0-9+/_=-])",
                    "[REDACTED_32_BYTE_KEY]", native)
    (output / "native-crash-report.txt").write_text(native[-2 * 1024 * 1024:])
    if failed:
        # API 30+ exposes OS termination reasons, including low-memory kills.
        # API 29 may report an unsupported command; preserve that as diagnostics.
        try:
            result = subprocess.run(prefix + ["shell", "dumpsys", "activity", "exit-info", "local.waarp.android.debug"],
                                    capture_output=True, text=True, timeout=20)
            exits = result.stdout + result.stderr
        except (OSError, subprocess.TimeoutExpired) as error:
            exits = f"Process exit collection failed: {type(error).__name__}\n"
        (output / "process-exit-info.txt").write_text(exits[-2 * 1024 * 1024:])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--serial")
    parser.add_argument("--expect-page-size", type=int, choices=(4096, 16384), required=True)
    parser.add_argument("--output", type=Path, default=Path("out/android/device-tests"))
    parser.add_argument("--timeout", type=int, default=900)
    options = parser.parse_args()
    sdk = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
    adb = shutil.which("adb") or (str(Path(sdk) / "platform-tools" / ("adb.exe" if os.name == "nt" else "adb")) if sdk else None)
    if not adb:
        raise ValueError("Android platform-tools/adb is required.")
    prefix = [adb] + (["-s", options.serial] if options.serial else [])

    def shell(*arguments):
        result = subprocess.run(prefix + ["shell", *arguments], capture_output=True, text=True, timeout=30)
        if result.returncode:
            raise ValueError(result.stderr.strip() or result.stdout.strip())
        return result.stdout.strip()

    page_size = int(shell("getconf", "PAGE_SIZE"))
    if page_size != options.expect_page_size:
        raise ValueError(f"Expected {options.expect_page_size}-byte pages, device reports {page_size}.")
    device = {"sdk": shell("getprop", "ro.build.version.sdk"), "release": shell("getprop", "ro.build.version.release"), "abi": shell("getprop", "ro.product.cpu.abi"), "pageSize": page_size}
    options.output.mkdir(parents=True, exist_ok=True)
    preflight = capture_preflight(prefix, options.output)
    started = time.monotonic()
    timed_out = False
    try:
        result = subprocess.run(prefix + ["shell", "am", "instrument", "-w", "-r", "local.waarp.android.debug.test/androidx.test.runner.AndroidJUnitRunner"], capture_output=True, text=True, timeout=options.timeout)
        output = result.stdout + result.stderr
        exit_code = result.returncode
    except subprocess.TimeoutExpired as error:
        chunks = (error.stdout or "", error.stderr or "")
        output = "".join(chunk.decode("utf8", errors="replace") if isinstance(chunk, bytes) else chunk for chunk in chunks)
        exit_code = -1
        timed_out = True
    elapsed = time.monotonic() - started
    (options.output / "instrumentation.txt").write_text(output)
    bundle = {}
    cases = []
    expected_tests = 0
    active_field = None
    for line in output.splitlines():
        if line.startswith("INSTRUMENTATION_STATUS: "):
            key, _, value = line[len("INSTRUMENTATION_STATUS: "):].partition("=")
            bundle[key] = value
            active_field = key
            if key == "numtests":
                expected_tests = max(expected_tests, int(value))
        elif line.startswith("INSTRUMENTATION_STATUS_CODE: "):
            code = int(line.rsplit(" ", 1)[-1])
            if code <= 0 and bundle.get("class") and bundle.get("test"):
                status = "passed" if code == 0 else "skipped" if code in (-3, -4) else "failed"
                cases.append({"class": bundle["class"], "name": bundle["test"], "status": status, "statusCode": code})
            bundle = {}
            active_field = None
        elif active_field == "stack":
            bundle[active_field] += "\n" + line
    final_codes = re.findall(r"^INSTRUMENTATION_CODE: (-?\d+)\s*$", output, re.M)
    totals = {status: sum(case["status"] == status for case in cases) for status in ("passed", "failed", "skipped")}
    success = preflight["broadcastQueuesIdle"] and exit_code == 0 and not timed_out and final_codes == ["-1"] and len(cases) > 0 and len(cases) == expected_tests and not totals["failed"] and not totals["skipped"]
    report = {"schemaVersion": 1, "checkedAtUtc": datetime.now(timezone.utc).isoformat(), "device": device, "preflight": preflight, "wallSeconds": elapsed, "tests": len(cases), "expectedTests": expected_tests, **totals, "timedOut": timed_out, "passedGate": success, "cases": cases}
    capture_logs(prefix, options.output, failed=not success)
    screenshots = options.output / "ui-screenshots"
    try:
        pulled = subprocess.run(prefix + ["pull", "/sdcard/Android/data/local.waarp.android.debug/files/ui-screenshots", str(screenshots)], capture_output=True, text=True, timeout=60)
        screenshot_count = len(list(screenshots.rglob("*.png"))) if pulled.returncode == 0 else 0
    except (OSError, subprocess.TimeoutExpired):
        screenshot_count = 0
    report["uiScreenshotCount"] = screenshot_count
    required_screenshots = {"01-home-empty.png", "02-settings.png", "03-saved-route.png", "04-groups.png"}
    actual_screenshots = {path.name for path in screenshots.rglob("*.png")} if screenshots.exists() else set()
    if not required_screenshots.issubset(actual_screenshots):
        success = False
        report["passedGate"] = False
        report["uiScreenshotError"] = "The three UI instrumentation scenarios did not provide their screenshots."
    if success:
        startup_samples = []
        for sample in range(3):
            try:
                shell("am", "force-stop", "local.waarp.android.debug")
                launch = shell("am", "start", "-W", "-n", "local.waarp.android.debug/local.waarp.android.MainActivity")
            except (OSError, ValueError, subprocess.TimeoutExpired) as error:
                success = False
                report["passedGate"] = False
                report["startupError"] = type(error).__name__
                break
            match = re.search(r"^TotalTime: (\d+)", launch, re.M)
            if "Status: ok" not in launch or match is None:
                success = False
                report["passedGate"] = False
                report["startupError"] = launch
                break
            startup_samples.append(int(match.group(1)))
        report["coldActivityLaunchMs"] = startup_samples
        report["performanceScope"] = "Three measured am force-stop/start Activity launches on this emulator; this is a baseline, not a device-independent speed guarantee."
    # These reports contain only the disposable test application's process data.
    try:
        (options.output / "meminfo.txt").write_text(shell("dumpsys", "meminfo", "local.waarp.android.debug"))
    except (OSError, ValueError, subprocess.TimeoutExpired) as error:
        success = False
        report["passedGate"] = False
        report["memorySnapshotError"] = type(error).__name__
    if not success:
        capture_logs(prefix, options.output, failed=True)
    (options.output / "result.json").write_text(json.dumps(report, indent=2) + "\n")
    print(f"Android API {device['sdk']}, pages={page_size}: {len(cases)} tests, {totals['passed']} passed, {totals['failed']} failed, {totals['skipped']} skipped; {elapsed:.1f}s.")
    if not success:
        print(output[-12000:], file=sys.stderr)
    return 0 if success else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, subprocess.TimeoutExpired) as error:
        print(f"Android instrumentation failed: {error}", file=sys.stderr)
        raise SystemExit(1)
