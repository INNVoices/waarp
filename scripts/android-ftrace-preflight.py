#!/usr/bin/env python3
"""Run the existing API 36 trace preparation guards before building/installing APKs.

This diagnostic entry point is not release acceptance. It uses the same root,
image, observer, empty-buffer and readback validators as android-release-run.py.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import importlib.util
import json
from pathlib import Path
import shutil
import time

ROOT = Path(__file__).resolve().parent.parent
PAGE_SIZE = 16384


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / filename)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sdk-root", type=Path, required=True)
    parser.add_argument("--serial", required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--disposable-emulator", action="store_true")
    options = parser.parse_args()
    if not options.disposable_emulator:
        parser.error("Explicit disposable-emulator ownership is required")
    sdk = options.sdk_root.resolve(strict=True)
    adb = shutil.which("adb") or str(sdk / "platform-tools/adb")
    output = options.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    # Exclusive creation preserves an earlier result, including failed evidence.
    summary_path = output / "preflight.json"
    with summary_path.open("x", encoding="utf-8") as summary:
        record = {
            "schemaVersion": 1,
            "checkedAtUtc": datetime.now(timezone.utc).isoformat(),
            "scope": "API 36.1 trace preparation only; no APK installation or app runtime acceptance",
            "releaseAcceptance": False,
            "passed": False,
            "expectedPageSize": PAGE_SIZE,
            "stage": "root-readiness",
        }
        started = time.monotonic()
        try:
            prefix = [adb, "-s", options.serial]
            root = module("android_release_root_preflight", "android-release-root.py")
            root.establish_root(prefix, output / "root-readiness.json", True)
            record["stage"] = "image-identity"
            image = module("android_emulator_image_preflight", "android-emulator-image.py")
            image.capture(prefix, output / "emulator-image.json", PAGE_SIZE, True, sdk_root=sdk)
            record["emulatorImage"] = image.validate_report(output / "emulator-image.json", PAGE_SIZE)
            record["stage"] = "ftrace-preparation"
            ftrace = module("android_ftrace_prepare_preflight", "android-ftrace-prepare.py")
            ftrace.prepare(prefix, output / "ftrace-preparation.json", PAGE_SIZE, True)
            record["ftracePreparation"] = ftrace.validate_report(output / "ftrace-preparation.json", PAGE_SIZE)
            record.update(passed=True, stage="complete")
        except Exception as error:
            record["error"] = f"{type(error).__name__}: {error}"[:2000]
            raise
        finally:
            record["wallSeconds"] = time.monotonic() - started
            json.dump(record, summary, indent=2, allow_nan=False)
            summary.write("\n")
    print("PASS API 36.1 trace preparation only; full APK/runtime/soak acceptance remains required")


if __name__ == "__main__":
    main()
