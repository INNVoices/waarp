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
    success = exit_code == 0 and not timed_out and final_codes == ["-1"] and len(cases) > 0 and len(cases) == expected_tests and not totals["failed"] and not totals["skipped"]
    report = {"schemaVersion": 1, "checkedAtUtc": datetime.now(timezone.utc).isoformat(), "device": device, "wallSeconds": elapsed, "tests": len(cases), "expectedTests": expected_tests, **totals, "timedOut": timed_out, "passedGate": success, "cases": cases}
    screenshots = options.output / "ui-screenshots"
    pulled = subprocess.run(prefix + ["pull", "/sdcard/Android/data/local.waarp.android.debug/files/ui-screenshots", str(screenshots)], capture_output=True, text=True, timeout=60)
    screenshot_count = len(list(screenshots.rglob("*.png"))) if pulled.returncode == 0 else 0
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
            shell("am", "force-stop", "local.waarp.android.debug")
            launch = shell("am", "start", "-W", "-n", "local.waarp.android.debug/local.waarp.android.MainActivity")
            match = re.search(r"^TotalTime: (\d+)", launch, re.M)
            if "Status: ok" not in launch or match is None:
                success = False
                report["passedGate"] = False
                report["startupError"] = launch
                break
            startup_samples.append(int(match.group(1)))
        report["coldActivityLaunchMs"] = startup_samples
        report["performanceScope"] = "Three measured am force-stop/start Activity launches on this emulator; this is a baseline, not a device-independent speed guarantee."
    (options.output / "result.json").write_text(json.dumps(report, indent=2) + "\n")
    # These reports contain only the disposable test application's process data.
    (options.output / "meminfo.txt").write_text(shell("dumpsys", "meminfo", "local.waarp.android.debug"))
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
