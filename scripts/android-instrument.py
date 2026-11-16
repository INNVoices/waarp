#!/usr/bin/env python3
"""Run the shipped debug instrumentation APK on a real ADB device/emulator.

The runner fails on process crashes, timeouts, an empty suite or skipped tests.
It consumes AndroidJUnitRunner's status protocol, never infers success from an
ADB shell exit code alone. The app and test APK must already be installed.
"""
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
import time


def compact_failure_header(stack):
    """Console diagnostics only; never emit a configuration or a native dump."""
    header = (stack or "").partition("\n")[0].strip()
    header = re.split(r";\s*(?:DNS|flows|host|native)\s*=", header,
                      maxsplit=1, flags=re.I)[0]
    parts = re.split(r"[\[{]|-----BEGIN\b", header, maxsplit=1)
    header = parts[0] + (" [structured details omitted]" if len(parts) > 1 else "")
    header = re.sub(r"(?i)\b[a-z][a-z0-9+.-]*://\S+", "[URI omitted]", header)
    header = re.sub(
        r"""(?ix)\b(?:private[-_ ]?key|preshared[-_ ]?key|password|passwd|
        token|secret|authorization)\s*[:=]\s*
        (?:"[^"]*"|'[^']*'|[^;\s]+)""",
        "[credential omitted]", header)
    header = re.sub(r"(?i)\bBearer\s+\S+", "[credential omitted]", header)
    header = re.sub(
        r"""(?ix)\b(?:endpoint|server)\s*[:=]\s*
        (?:"[^"]*"|'[^']*'|[^;\s]+)""", "[endpoint omitted]", header)
    header = re.sub(r"(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b",
                    "[network address omitted]", header)
    header = re.sub(r"(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/_-]{43}=(?![A-Za-z0-9+/=_-])",
                    "[key omitted]", header)
    header = re.sub(r"(?i)\b[0-9a-f]{64}\b", "[key omitted]", header)
    header = header or "No compact assertion header; see instrumentation.txt."
    return header[:768] + (" [truncated]" if len(header) > 768 else "")


def parse_instrumentation(output, exit_code, timed_out, *, failure_diagnostics=None):
    """Read AndroidJUnitRunner's protocol, shared by debug and external release gates."""
    bundle, cases = {}, []
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
                if status == "failed" and failure_diagnostics is not None:
                    failure_diagnostics.append({
                        "class": bundle["class"][:200], "name": bundle["test"][:200],
                        "statusCode": code, "header": compact_failure_header(bundle.get("stack", "")),
                    })
            bundle, active_field = {}, None
        elif active_field == "stack":
            bundle[active_field] += "\n" + line
    final_codes = re.findall(r"^INSTRUMENTATION_CODE: (-?\d+)\s*$", output, re.M)
    totals = {status: sum(case["status"] == status for case in cases) for status in ("passed", "failed", "skipped")}
    success = exit_code == 0 and not timed_out and final_codes == ["-1"] and len(cases) > 0 and len(cases) == expected_tests and not totals["failed"] and not totals["skipped"]
    return {"tests": len(cases), "expectedTests": expected_tests, **totals, "timedOut": timed_out,
            "passedGate": success, "cases": cases}


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
              "scope": "Observational framework broadcast-queue idle and memory snapshots; global background work is not app readiness. No dialogs dismissed, crash records cleared, or tests skipped."}
    (output / "preflight.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


def capture_test_failure_logs(prefix, output):
    """Preserve early matching failures still retained by logd, once per suite."""
    arguments = [
        "logcat", "-d", "-v", "threadtime",
        "-b", "main", "-b", "system", "-b", "crash", "-m", "1024",
        "TestRunner:E", "AndroidRuntime:E", "ActivityManager:W", "libc:F", "DEBUG:F", "*:S",
    ]
    try:
        result = subprocess.run(prefix + arguments, capture_output=True, timeout=20)
        content = result.stdout + result.stderr
    except (OSError, subprocess.TimeoutExpired) as error:
        content = f"Failure-log collection failed: {type(error).__name__}\n".encode()
    limit = 512 * 1024
    if len(content) > 2 * limit:
        content = (content[:limit] +
                   b"\n[Middle omitted: first and last 512 KiB retained.]\n" +
                   content[-limit:])
    (output / "logcat-test-failures.txt").write_bytes(content)


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
    # Setup rotates a previous Go panic away from the current file on restart.
    # Read only current/.old/go.log crash paths, with the app's run-as identity.
    spec = importlib.util.spec_from_file_location("android_native_crash_evidence", Path(__file__).with_name("android-crash-evidence.py"))
    crash_reader = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(crash_reader)
    native = crash_reader.collect_native_crashes(prefix, output, "local.waarp.android.debug", run_as=True)
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
    return native


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
    failure_headers = []
    parsed = parse_instrumentation(output, exit_code, timed_out,
                                   failure_diagnostics=failure_headers)
    (options.output / "failure-headers.json").write_text(json.dumps(failure_headers, indent=2) + "\n")
    success = parsed["passedGate"]
    if not success:
        capture_test_failure_logs(prefix, options.output)
    report = {"schemaVersion": 1, "checkedAtUtc": datetime.now(timezone.utc).isoformat(), "device": device, "preflight": preflight, "wallSeconds": elapsed, **parsed}
    native = capture_logs(prefix, options.output, failed=not success)
    report["nativeCrashEvidence"] = native
    if not native["passed"]:
        success = False
        report["passedGate"] = False
        report["nativeCrashError"] = "Current or archived native crash evidence is incomplete or contains a runtime failure."
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
        report["uiScreenshotError"] = "The UI instrumentation scenarios did not provide their required screenshots."
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
    print(f"Android API {device['sdk']}, pages={page_size}: {parsed['tests']} tests, {parsed['passed']} passed, {parsed['failed']} failed, {parsed['skipped']} skipped; {elapsed:.1f}s.")
    if not success:
        for failure in failure_headers:
            print(json.dumps({"instrumentationFailure": failure}), file=sys.stderr, flush=True)
        print(output[-12000:], file=sys.stderr)
    return 0 if success else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, subprocess.TimeoutExpired) as error:
        print(f"Android instrumentation failed: {error}", file=sys.stderr)
        raise SystemExit(1)