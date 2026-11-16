#!/usr/bin/env python3
"""Install the verified APK matching one explicitly selected ADB device."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent


def run(args):
    result = subprocess.run(args, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=180)
    if result.returncode:
        raise RuntimeError(result.stdout.strip())
    return result.stdout.strip()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--serial", help="ADB serial; required when more than one device is connected")
    parser.add_argument("--variant", choices=("debug", "release"), default="debug")
    parser.add_argument("--launch", action="store_true")
    parser.add_argument("--with-tests", action="store_true")
    options = parser.parse_args()
    if options.with_tests and options.variant != "debug":
        parser.error("The instrumentation APK targets only the debug application.")
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
    print(run(prefix + ["install", "-r", str(apk)]))
    if options.with_tests:
        print(run(prefix + ["install", "-r", "-t", str(output / metadata["instrumentation"])]))
    if options.launch:
        print(run(prefix + ["shell", "am", "start", "-n", f"{selected['packageId']}/local.waarp.android.MainActivity"]))
    print(f"Installed {apk.name} on {serial}.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
        print(f"Android install failed: {error}", file=sys.stderr)
        raise SystemExit(1)
