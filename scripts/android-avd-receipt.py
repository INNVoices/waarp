#!/usr/bin/env python3
"""Read a bounded, allowlisted host AVD receipt on an owned disposable Linux CI host.

No SDK tools, subprocesses or ADB commands are executed. The only output is a
new JSON receipt; source files, emulator state and options remain unchanged.
"""
from __future__ import annotations

import argparse
from contextlib import ExitStack, contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import stat
import sys
import time

FILE_LIMIT = 64 * 1024
TOTAL_SECONDS = 5
MAX_PROC_ENTRIES = 2048
MAX_OWNED_EMULATORS = 8
NAME = r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}"
IMAGE_DIRECTORY = r"system-images/android-[0-9]+(?:\.[0-9]+)?(?:-ext[0-9]+)?/[A-Za-z0-9_]+/(?:x86_64|x86|arm64-v8a|armeabi-v7a)"
FEATURES = {"GLDirectMem", "HasSharedSlotsHostMemoryAllocator", "GLDMA", "GLDMA2", "GLAsyncSwap"}
CONFIG_KEYS = {
    "target", "abi.type", "tag.id", "image.sysdir.1", "hw.cpu.arch", "hw.cpu.ncore",
    "hw.gpu.enabled", "hw.gpu.mode", "hw.gltransport", "hw.ramSize", "vm.heapSize", "hw.heapSize",
    "disk.dataPartition.size", "hw.gltransport.asg.writeBufferSize",
    "hw.gltransport.asg.writeStepSize", "hw.gltransport.asg.dataRingSize",
}
VERSION_KEYS = {
    "Pkg.Revision", "Pkg.BuildId", "AndroidVersion.ApiLevel", "AndroidVersion.ExtensionLevel",
    "AndroidVersion.IsBaseSdk", "SystemImage.Abi", "SystemImage.TagId", "SystemImage.GpuSupport",
}
BOOL_FLAGS = {"-no-window", "-noaudio", "-no-boot-anim", "-no-snapshot", "-no-snapshot-load",
              "-no-snapshot-save", "-read-only", "-no-accel", "-show-kernel"}
VALUE_FLAGS = {"-avd", "-port", "-ports", "-android-ports", "-gpu", "-accel",
               "-memory", "-cores", "-camera-back", "-camera-front", "-feature"}


class ReceiptError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise ReceiptError(message)


@contextmanager
def time_bound():
    """Interrupt a stalled local read as well as checking between reads."""
    def expired(_signum, _frame):
        raise ReceiptError("Host receipt reached its fixed total time limit")

    previous = signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, TOTAL_SECONDS)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


def read_regular(path, *, dir_fd=None):
    """Bound the bytes; reject links, FIFOs/devices and a file changed mid-read."""
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dir_fd)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode), "Input is not a regular file")
        require(before.st_size < FILE_LIMIT, "Input reached its fixed byte limit")
        chunks, size = [], 0
        while size < FILE_LIMIT:
            chunk = os.read(fd, FILE_LIMIT - size)
            if not chunk:
                break
            chunks.append(chunk)
            size += len(chunk)
        raw = b"".join(chunks)
        after = os.fstat(fd)
        require(len(raw) < FILE_LIMIT, "Input reached its fixed byte limit")
        require((before.st_size, before.st_mtime_ns) == (after.st_size, after.st_mtime_ns),
                "Input changed during collection")
        return raw
    finally:
        os.close(fd)


def read_rooted(root, relative):
    """Resolve an SDK directory alias once, then pin every directory while reading.

    A concurrent change of cmdline-tools/latest cannot redirect the read: no
    symlink is followed during the openat walk of the checked relative path.
    """
    path = root / relative
    parent = path.parent.resolve(strict=True)
    require(parent.is_relative_to(root), "Input parent escapes its declared root")
    relative_parent = parent.relative_to(root)
    with ExitStack() as opened:
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        directory_fd = os.open(root, flags)
        opened.callback(os.close, directory_fd)
        for part in relative_parent.parts:
            directory_fd = os.open(part, flags, dir_fd=directory_fd)
            opened.callback(os.close, directory_fd)
        raw = read_regular(path.name, dir_fd=directory_fd)
    return raw, (relative_parent / path.name).as_posix()


def properties(raw, keys, allow_config_overrides=False):
    fields, selected, occurrences, omitted = {}, {}, {}, 0
    for line in raw.decode("utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith(("#", ";")):
            continue
        require("=" in line, "Malformed property line")
        key, value = (part.strip() for part in line.split("=", 1))
        require(key and (key not in fields or (allow_config_overrides and key not in ("path", "target", "image.sysdir.1"))),
                "Duplicate or empty identity property key")
        fields[key] = value
        if key not in keys:
            omitted += 1
            continue
        # No paths, URLs, whitespace, escape sequences or free-form command text.
        pattern = IMAGE_DIRECTORY + "/?" if key == "image.sysdir.1" else r"[A-Za-z0-9_,.:+-]{1,128}"
        require(re.fullmatch(pattern, value) is not None, "Invalid allowlisted property: " + key)
        if key in FEATURES:
            require(value in ("on", "off", "default"), "Invalid feature setting: " + key)
        selected[key] = value
        occurrences.setdefault(key, []).append(value)
    return fields, selected, omitted, {key: values for key, values in occurrences.items() if len(values) > 1}


def safe_argv(raw):
    """Keep only diagnostic options; never store the full command or unknown values."""
    require(raw.endswith(b"\0"), "Incomplete emulator command line")
    arguments = raw[:-1].decode("utf-8").split("\0")
    require(1 < len(arguments) <= 512, "Unexpected emulator argument count")
    selected, omitted, index = [], 0, 1
    while index < len(arguments):
        option = arguments[index]
        if option.startswith("@") and re.fullmatch(NAME, option[1:]):
            selected.append(["-avd", option[1:]])
        elif option in BOOL_FLAGS:
            selected.append([option])
        elif option in VALUE_FLAGS:
            require(index + 1 < len(arguments), "Missing allowlisted option value")
            value = arguments[index + 1]
            index += 1
            if option == "-feature":
                values = value.split(",")
                kept = [part for part in values if re.fullmatch(r"[+-]?[A-Za-z][A-Za-z0-9_]*", part)
                        and part.lstrip("+-") in FEATURES]
                if kept:
                    selected.append([option, ",".join(kept)])
                omitted += len(values) - len(kept)
            else:
                pattern = {
                    "-avd": NAME, "-port": r"[0-9]{1,5}", "-ports": r"[0-9]{1,5},[0-9]{1,5}",
                    "-android-ports": r"[0-9]{1,5},[0-9]{1,5}",
                    "-memory": r"[0-9]{1,8}", "-cores": r"[0-9]{1,3}",
                    "-gpu": r"(?:auto|host|software|swiftshader|swiftshader_indirect|swangle|swangle_indirect|angle|angle_indirect|lavapipe|mesa|guest|off)",
                    "-accel": r"(?:auto|on|off)", "-camera-back": r"(?:none|emulated)",
                    "-camera-front": r"(?:none|emulated)",
                }[option]
                require(re.fullmatch(pattern, value) is not None,
                        "Invalid allowlisted option: " + option)
                selected.append([option, value])
        else:
            omitted += 1
        index += 1
        require(len(selected) <= 32, "Too many allowlisted emulator options")
    return selected, omitted


class Collector:
    def __init__(self, sdk_root, avd_home, avd_name, port, *, metadata_only=False, proc_root=Path("/proc")):
        require(re.fullmatch(NAME, avd_name) is not None, "Invalid AVD name")
        require(type(port) is int and 1024 <= port <= 65534 and port % 2 == 0, "Invalid emulator port")
        self.sdk, self.avd_home = Path(sdk_root).resolve(strict=True), Path(avd_home).resolve(strict=True)
        require(self.sdk.is_dir() and self.avd_home.is_dir()
                and self.sdk != Path("/") and self.avd_home != Path("/"), "Explicit SDK and AVD directories are required")
        self.name, self.port, self.proc_root = avd_name, port, proc_root
        require(type(metadata_only) is bool, "Explicit metadata-only mode must be boolean")
        self.started = time.monotonic()
        self.report = {
            "schemaVersion": 1, "checkedAtUtc": datetime.now(timezone.utc).isoformat(),
            "scope": "Allowlisted host AVD metadata on an explicitly owned disposable Linux CI host; not guest or runtime acceptance.",
            "collectionComplete": False, "explicitDisposableHost": True, "hostOrGuestModified": False,
            "runtimeAcceptance": "not-assessed", "effectiveEmulatorApiLevel": None,
            "hostFeatureNegotiationVerified": False, "avdName": avd_name, "emulatorPort": port,
            "processCollectionRequested": not metadata_only,
            "limits": {"fileBytesExclusive": FILE_LIMIT, "totalSeconds": TOTAL_SECONDS,
                       "procEntries": MAX_PROC_ENTRIES, "ownedEmulatorProcesses": MAX_OWNED_EMULATORS},
            "files": {}, "emulatorProcesses": [], "errors": [],
        }

    def within_deadline(self):
        require(time.monotonic() - self.started < TOTAL_SECONDS, "Host receipt reached its fixed total time limit")

    def file(self, name, root, relative, keys, *, optional=False, required=(), allow_config_overrides=False):
        self.within_deadline()
        entry = {"relativePath": relative, "available": False, "optional": optional}
        self.report["files"][name] = entry
        try:
            raw, resolved_relative = read_rooted(root, relative)
            fields, selected, omitted, overrides = properties(raw, keys, allow_config_overrides)
            require(all(key in selected for key in required), "Required property is absent")
            self.within_deadline()
            entry.update(available=True, properties=selected, omittedProperties=omitted,
                         bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest(),
                         resolvedRelativePath=resolved_relative)
            if overrides:
                entry["repeatedPropertyValuesInFileOrder"] = overrides
            return fields
        except FileNotFoundError:
            entry["error"] = "missing"
            if not optional:
                self.report["errors"].append(name + ": missing required metadata")
        except (OSError, ValueError) as error:
            entry["error"] = type(error).__name__
            # Do not leak exception text containing arbitrary filesystem paths or input values.
            self.report["errors"].append(name + ": metadata could not be collected safely")
        return {}

    def processes(self):
        allowed = {self.sdk / "emulator/emulator",
                   self.sdk / "emulator/qemu/linux-x86_64/qemu-system-x86_64"}
        count, owned = 0, 0
        with os.scandir(self.proc_root) as entries:
            for item in entries:
                count += 1
                require(count <= MAX_PROC_ENTRIES, "Host process scan reached its fixed count limit")
                self.within_deadline()
                if not item.name.isdigit():
                    continue
                path = self.proc_root / item.name
                try:
                    if path.stat().st_uid != os.getuid():
                        continue
                    executable = Path(os.readlink(path / "exe"))
                    if executable not in allowed:
                        continue
                    owned += 1
                    require(owned <= MAX_OWNED_EMULATORS, "Too many owned SDK emulator processes")
                    raw = read_regular(path / "cmdline")
                    argv, omitted = safe_argv(raw)
                    names = [entry[1] for entry in argv if entry[0] == "-avd"]
                    ports = [entry[1].split(",")[0] for entry in argv
                             if entry[0] in ("-port", "-ports", "-android-ports")]
                    if names != [self.name] or not ports or any(value != str(self.port) for value in ports):
                        continue
                    require(Path(os.readlink(path / "exe")) == executable, "Emulator process identity changed during collection")
                    self.report["emulatorProcesses"].append({
                        "pid": int(item.name), "sdkRelativeExecutable": executable.relative_to(self.sdk).as_posix(),
                        "argvAllowlist": argv, "omittedArguments": omitted,
                        "originalCmdlineBytes": len(raw), "originalCmdlineSha256": hashlib.sha256(raw).hexdigest(),
                    })
                except (FileNotFoundError, ProcessLookupError, PermissionError):
                    continue  # Exited/inaccessible unrelated processes are not candidates.
        self.report["procEntriesExamined"] = count
        require(self.report["emulatorProcesses"], "No owned SDK emulator matched the explicit AVD and port")

    def collect(self):
        root = self.file("avdRoot", self.avd_home, self.name + ".ini", {"target"}, required=("target",))
        expected_content = self.avd_home / (self.name + ".avd")
        content_matches = bool(root.get("path")) and Path(root["path"]) == expected_content
        self.report["avdContentPathMatchesExpected"] = content_matches
        if not content_matches:
            self.report["errors"].append("avdRoot: content path does not match the selected AVD directory")
        config = self.file("avdConfig", self.avd_home, self.name + ".avd/config.ini", CONFIG_KEYS,
                           required=("image.sysdir.1",), allow_config_overrides=True)
        self.file("avdHardware", self.avd_home, self.name + ".avd/hardware-qemu.ini", CONFIG_KEYS,
                  required=("hw.gpu.mode",), allow_config_overrides=True)
        self.file("emulatorVersion", self.sdk, "emulator/source.properties", VERSION_KEYS, required=("Pkg.Revision",))
        self.file("commandLineToolsVersion", self.sdk, "cmdline-tools/latest/source.properties", VERSION_KEYS,
                  required=("Pkg.Revision",))
        # These are configuration inputs, not a dump of effective feature negotiation.
        self.file("emulatorFeatures", self.sdk, "emulator/lib/advancedFeatures.ini", FEATURES, optional=True)
        self.file("emulatorCanaryFeatures", self.sdk, "emulator/lib/advancedFeaturesCanary.ini", FEATURES, optional=True)
        image = config.get("image.sysdir.1", "").rstrip("/")
        if re.fullmatch(IMAGE_DIRECTORY, image):
            image_fields = self.file("imageVersion", self.sdk, image + "/source.properties", VERSION_KEYS,
                                     required=("Pkg.Revision", "AndroidVersion.ApiLevel"))
            self.file("imageFeatures", self.sdk, image + "/advancedFeatures.ini", FEATURES, optional=True)
            target, api = root.get("target", ""), image_fields.get("AndroidVersion.ApiLevel", "")
            major_target = re.fullmatch(r"android-([0-9]+)(?:\.[0-9]+)?(?:-ext[0-9]+)?", target)
            major_image = re.fullmatch(r"([0-9]+)(?:\.[0-9]+)?", api)
            self.report["targetMajorMatchesImage"] = (int(major_target[1]) == int(major_image[1])
                                                       if major_target and major_image else None)
        else:
            self.report["errors"].append("avdConfig: missing or unsafe system-image directory")
        if self.report["processCollectionRequested"]:
            try:
                self.processes()
            except (OSError, ValueError):
                self.report["errors"].append("emulatorProcesses: bounded identity/argv collection incomplete")
        self.within_deadline()
        self.report["collectionComplete"] = not self.report["errors"]
        return self.report


def capture(sdk_root, avd_home, avd_name, port, report_path, disposable_ci_host, *,
            metadata_only=False, proc_root=Path("/proc")):
    require(disposable_ci_host is True and sys.platform == "linux", "Explicit disposable Linux CI host ownership is required")
    report_path = Path(report_path)
    require(not report_path.exists(), "Keep the previous host receipt; output already exists")
    collector = Collector(sdk_root, avd_home, avd_name, port, metadata_only=metadata_only, proc_root=proc_root)
    try:
        with time_bound():
            collector.collect()
    except (OSError, ValueError):
        collector.report["errors"].append("Host receipt did not complete within its safe collection contract")
    collector.report["elapsedSeconds"] = round(time.monotonic() - collector.started, 6)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    with report_path.open("x", encoding="utf-8") as output:
        output.write(json.dumps(collector.report, indent=2) + "\n")
    return collector.report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sdk-root", type=Path, required=True)
    parser.add_argument("--avd-home", type=Path, required=True)
    parser.add_argument("--avd-name", required=True)
    parser.add_argument("--port", type=int, default=5554)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--disposable-ci-host", action="store_true")
    parser.add_argument("--metadata-only", action="store_true",
                        help="Read surviving files after teardown; explicitly omit live process/argv observation")
    args = parser.parse_args()
    try:
        report = capture(args.sdk_root, args.avd_home, args.avd_name, args.port,
                         args.report, args.disposable_ci_host, metadata_only=args.metadata_only)
    except (OSError, ValueError) as error:
        print("Host AVD receipt refused: " + type(error).__name__, file=sys.stderr)
        return 1
    print("Host AVD receipt collected" if report["collectionComplete"] else "Host AVD receipt incomplete", file=sys.stderr)
    return 0 if report["collectionComplete"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
