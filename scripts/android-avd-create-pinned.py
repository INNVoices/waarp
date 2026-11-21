#!/usr/bin/env python3
"""REL-009 candidate: create one fresh AVD with explicit SDK tools 20.0.

Use only after a verified CI receipt shows a low target for the 36.1 image and
pre-20 command-line tools. It never edits target, replaces an AVD or boots it.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import resource
import subprocess
import sys

spec = importlib.util.spec_from_file_location("host_receipt", Path(__file__).with_name("android-avd-receipt.py"))
host = importlib.util.module_from_spec(spec)
spec.loader.exec_module(host)

TOOLS_VERSION = "20.0"
IMAGE = "system-images/android-36.1/google_apis_ps16k/x86_64"
PACKAGE = IMAGE.replace("/", ";")
EXPECTED_IMAGE = {"Pkg.Revision": "4", "AndroidVersion.ApiLevel": "36.1", "SystemImage.Abi": "x86_64"}
TIMEOUT_SECONDS = 120


def require(condition, message):
    if not condition:
        raise ValueError(message)


def file_properties(root, relative):
    raw, resolved = host.read_rooted(root, relative)
    _, selected, _, _ = host.properties(raw, host.VERSION_KEYS | {"target", "image.sysdir.1"})
    return {"relativePath": relative, "resolvedRelativePath": resolved,
            "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest(), "properties": selected}


def reviewed_observation(path):
    raw = host.read_regular(path)
    observed = json.loads(raw)
    require(type(observed) is dict and type(observed.get("schemaVersion")) is int and observed["schemaVersion"] == 1,
            "Unrecognized original host receipt")
    files = observed.get("files", {})
    require(type(files) is dict, "Original host receipt has no file observations")
    for key in ("avdRoot", "imageVersion", "commandLineToolsVersion"):
        item = files.get(key)
        require(type(item) is dict and item.get("available") is True and type(item.get("properties")) is dict,
                "Original host identity observation is incomplete")
    for key in ("imageVersion", "commandLineToolsVersion"):
        require(type(files[key].get("sha256")) is str and re.fullmatch(r"[0-9a-f]{64}", files[key]["sha256"]),
                "Original source.properties hash is absent")
    target = files["avdRoot"]["properties"].get("target", "")
    match = re.fullmatch(r"android-([0-9]+)", target)
    require(match and int(match[1]) < 30, "The observed target does not establish the low-API hypothesis")
    image = files["imageVersion"]["properties"]
    require(all(image.get(key) == value for key, value in EXPECTED_IMAGE.items()), "Original image differs from reviewed 36.1 r4")
    revision = files["commandLineToolsVersion"]["properties"].get("Pkg.Revision", "")
    require(re.fullmatch(r"[0-9]+(?:\.[0-9]+){1,2}", revision)
            and int(revision.split(".")[0]) < 20, "Observed tools do not support this bounded upgrade hypothesis")
    return files, hashlib.sha256(raw).hexdigest()


def run_create(arguments, environment, output):
    def limit_output():
        resource.setrlimit(resource.RLIMIT_FSIZE, (host.FILE_LIMIT, host.FILE_LIMIT))

    with (output / "avd-create.stdout").open("xb") as stdout, (output / "avd-create.stderr").open("xb") as stderr:
        result = subprocess.run(arguments, input=b"no\n", env=environment, stdout=stdout, stderr=stderr,
                                timeout=TIMEOUT_SECONDS, preexec_fn=limit_output)
    require(result.returncode == 0, "Pinned avdmanager did not create the selected AVD")
    for name in ("avd-create.stdout", "avd-create.stderr"):
        require((output / name).stat().st_size < host.FILE_LIMIT, "AVD creation output reached its fixed bound")


def create(sdk_root, avd_home, observation, report_path, disposable, *, runner=run_create):
    require(disposable is True and sys.platform == "linux", "Explicit disposable Linux CI host ownership is required")
    sdk, avd_home, report_path = Path(sdk_root).resolve(strict=True), Path(avd_home).absolute(), Path(report_path)
    require(not report_path.exists(), "Keep the previous creation report")
    require(sdk.is_dir() and sdk != Path("/") and avd_home != Path("/"), "Invalid owned SDK/AVD roots")
    require(not any(os.path.lexists(avd_home / name) for name in ("test.ini", "test.avd")),
            "Refusing to replace an existing test AVD")
    previous, original_hash = reviewed_observation(observation)
    report = {"schemaVersion": 1, "checkedAtUtc": datetime.now(timezone.utc).isoformat(), "passed": False,
              "scope": "One conditional fresh AVD creation with explicit SDK tools; not emulator or application acceptance.",
              "originalHostReceiptSha256": original_hash, "sdkToolsPackage": "cmdline-tools;" + TOOLS_VERSION,
              "systemImagePackage": PACKAGE, "avdName": "test", "profile": "pixel_6", "booted": False,
              "targetEdited": False, "existingAvdReplaced": False, "creationAttempted": False,
              "timeoutSeconds": TIMEOUT_SECONDS}
    report_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        current = file_properties(sdk, "cmdline-tools/latest/source.properties")
        require(current["sha256"] == previous["commandLineToolsVersion"]["sha256"],
                "The runner's original tools differ from the reviewed failure; re-evaluate the hypothesis")
        report["originalTools"] = current
        pinned = file_properties(sdk, "cmdline-tools/" + TOOLS_VERSION + "/source.properties")
        require(pinned["properties"].get("Pkg.Revision") == TOOLS_VERSION, "Install exactly cmdline-tools;20.0 before creation")
        report["selectedTools"] = pinned
        image = file_properties(sdk, IMAGE + "/source.properties")
        require(image["sha256"] == previous["imageVersion"]["sha256"]
                and all(image["properties"].get(key) == value for key, value in EXPECTED_IMAGE.items()),
                "System image changed between the failure and candidate")
        report["image"] = image
        relative_tool = "cmdline-tools/" + TOOLS_VERSION + "/bin/avdmanager"
        raw_tool, resolved_tool = host.read_rooted(sdk, relative_tool)
        require(resolved_tool == relative_tool, "Pinned avdmanager is not at its explicit versioned SDK path")
        report["avdmanager"] = {"relativePath": relative_tool, "sha256": hashlib.sha256(raw_tool).hexdigest()}
        avd_home.mkdir(parents=True, exist_ok=True)
        require(avd_home.resolve() == avd_home, "Use the canonical owned AVD directory")
        arguments = [str(sdk / relative_tool), "create", "avd", "--name", "test", "--package", PACKAGE, "--device", "pixel_6"]
        environment = dict(os.environ, ANDROID_HOME=str(sdk), ANDROID_SDK_ROOT=str(sdk), ANDROID_AVD_HOME=str(avd_home))
        report["creationArguments"] = [relative_tool, *arguments[1:]]
        report["creationAttempted"] = True
        runner(arguments, environment, report_path.parent)
        created = file_properties(avd_home, "test.ini")
        report["createdRootIni"] = created
        raw_root, _ = host.read_rooted(avd_home, "test.ini")
        root_fields, _, _, _ = host.properties(raw_root, {"target"})
        require(root_fields.get("path") == str(avd_home / "test.avd"), "Created root INI points outside the selected AVD")
        # Minor image identity remains fixed by source.properties and config below.
        require(created["properties"].get("target") in ("android-36", "android-36.1"),
                "Pinned tools still produced an unexpected target; do not boot or edit it")
        raw_config, config_path = host.read_rooted(avd_home, "test.avd/config.ini")
        fields, _, _, _ = host.properties(raw_config, host.CONFIG_KEYS, allow_config_overrides=True)
        selected_image = fields.get("image.sysdir.1", "").rstrip("/")
        report["createdConfig"] = {"relativePath": config_path, "sha256": hashlib.sha256(raw_config).hexdigest(),
                                   "imageDirectory": selected_image}
        require(selected_image == IMAGE, "Created AVD points to a different system image")
        report["passed"] = True
    except (OSError, ValueError, subprocess.SubprocessError):
        report["error"] = "Conditional creation did not satisfy its reviewed source/identity contract"
    finally:
        with report_path.open("x", encoding="utf-8") as output:
            output.write(json.dumps(report, indent=2) + "\n")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sdk-root", type=Path, required=True)
    parser.add_argument("--avd-home", type=Path, required=True)
    parser.add_argument("--observed-host-receipt", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--disposable-ci-host", action="store_true")
    args = parser.parse_args()
    try:
        report = create(args.sdk_root, args.avd_home, args.observed_host_receipt,
                        args.report, args.disposable_ci_host)
    except (OSError, ValueError, KeyError, TypeError):
        print("Conditional AVD creation refused before a validated attempt", file=sys.stderr)
        return 1
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
