#!/usr/bin/env python3
"""Apply the declared API 29 heap budget before starting fresh Android VMs.

This is one planned initialization of an explicitly disposable emulator, before
guest fixtures or app installation. It never retries framework mutations or
tests. The report proves startup ordering; it does not claim to measure an
existing VM's Runtime.maxMemory().
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


HEAP_PROPERTY = "dalvik.vm.heapsize"
HEAP_VALUE = "512m"
HEAP_BYTES = 512 * 1024 * 1024
PROCESS_NAMES = ("zygote", "zygote64", "system_server")
ZYGOTES = {
    "zygote32": ("zygote",),
    "zygote64": ("zygote64",),
    "zygote32_64": ("zygote", "zygote64"),
    "zygote64_32": ("zygote64", "zygote"),
}
PROPERTIES = (
    "ro.build.version.sdk", "ro.kernel.qemu", "ro.boot.qemu", "ro.debuggable",
    "ro.zygote", "ro.product.cpu.abi", "dalvik.vm.heapsize",
    "dalvik.vm.heapgrowthlimit", "dalvik.vm.heapstartsize",
    "ro.kernel.qemu.dalvik.vm.heapsize", "ro.boot.dalvik.vm.heapsize",
    "sys.boot_completed", "init.svc.zygote", "init.svc.zygote_secondary",
)
MAX_COMMAND_OUTPUT = 16 * 1024


class PreparationError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise PreparationError(message)


def run_command(arguments, timeout):
    return subprocess.run(arguments, capture_output=True, text=True,
                          errors="replace", timeout=timeout)


class Preparation:
    def __init__(self, serial, disposable, report_path, *, adb="adb",
                 command_runner=run_command, monotonic=time.monotonic, sleep=time.sleep):
        self.serial = serial
        self.disposable = disposable
        self.report_path = Path(report_path)
        self.prefix = [adb, "-s", serial or ""]
        self.command_runner = command_runner
        self.monotonic = monotonic
        self.sleep = sleep
        self.started = monotonic()
        self.deadline = self.started
        self.expected_zygotes = ()
        self.old_ids = set()
        self.report = {
            "schemaVersion": 1, "checkedAtUtc": datetime.now(timezone.utc).isoformat(),
            "passed": False, "serial": serial, "disposableEmulator": disposable,
            "requestedHeapBytes": HEAP_BYTES, "requestedHeapProperty": HEAP_VALUE,
            "actualRuntimeMaxHeapBytes": None, "appliedBeforeZygote": False,
            "originalShellUid": None, "finalShellUid": None,
            "oldPids": {}, "newPids": {}, "phases": [], "mutations": [],
            "recentCommands": [], "commandsOmitted": 0,
            "scope": "One API 29 framework initialization before guest fixtures and app installation; no test rerun or log clearing.",
        }

    def save(self):
        self.report_path.parent.mkdir(parents=True, exist_ok=True)
        self.report_path.write_text(json.dumps(self.report, indent=2) + "\n", encoding="utf-8")

    def elapsed(self):
        return round(self.monotonic() - self.started, 3)

    def command(self, *arguments, allowed=(0,), mutation=False):
        remaining = self.deadline - self.monotonic()
        require(remaining > 0, "Preparation phase exceeded its infrastructure deadline")
        entry = {"arguments": list(arguments), "startedSeconds": self.elapsed()}
        if mutation:
            self.report["mutations"].append(entry)
            self.save()
        started = self.monotonic()
        try:
            result = self.command_runner(self.prefix + list(arguments), min(10, remaining))
            output = (result.stdout or "") + (result.stderr or "")
            entry.update(exitCode=result.returncode, output=output[:2048])
            require(len(output.encode("utf-8")) <= MAX_COMMAND_OUTPUT,
                    "ADB command output exceeds the preparation bound")
            require(allowed is None or result.returncode in allowed,
                    "ADB command failed: " + " ".join(arguments) + ": " + output[:1024].strip())
            require(self.monotonic() <= self.deadline, "ADB command exceeded its preparation phase deadline")
            return result
        except (OSError, subprocess.SubprocessError) as error:
            entry["error"] = type(error).__name__
            raise PreparationError("ADB command did not complete: " + " ".join(arguments)
                                   + " (" + type(error).__name__ + ")") from error
        finally:
            entry["seconds"] = round(self.monotonic() - started, 3)
            recent = self.report["recentCommands"]
            recent.append(entry)
            if len(recent) > 128:
                del recent[0]
                self.report["commandsOmitted"] += 1

    def shell(self, *arguments, **options):
        return self.command("shell", *arguments, **options)

    def prop(self, name):
        value = self.shell("getprop", name).stdout.strip()
        require(len(value) <= 256 and "\n" not in value, "Unexpected property value: " + name)
        return value

    def properties(self):
        return {name: self.prop(name) for name in PROPERTIES}

    def pids(self):
        values = {}
        for name in PROCESS_NAMES:
            result = self.shell("pidof", name, allowed=(0, 1))
            output = result.stdout.strip()
            require(not result.stderr.strip(), "PID lookup returned an error: " + name)
            if result.returncode == 1:
                require(not output, "Failed PID lookup returned ambiguous output: " + name)
                values[name] = []
            else:
                require(re.fullmatch(r"[1-9][0-9]*(?:\s+[1-9][0-9]*)*", output) is not None,
                        "Malformed PID lookup: " + name)
                values[name] = [int(value) for value in output.split()]
                require(len(values[name]) <= 4 and all(pid <= 2**31 - 1 for pid in values[name]),
                        "Unexpected PID count or value: " + name)
        return values

    def complete_pids(self, pids):
        expected = set(self.expected_zygotes) | {"system_server"}
        require(all(not pids[name] for name in set(PROCESS_NAMES) - expected),
                "A zygote outside the ro.zygote configuration is running")
        require(all(len(pids[name]) <= 1 for name in expected), "Multiple framework processes have one name")
        ids = [pid for group in pids.values() for pid in group]
        require(len(ids) == len(set(ids)), "Framework PID identities overlap")
        return all(len(pids[name]) == 1 for name in expected)

    def old_processes_gone(self):
        remaining = []
        for pid in sorted(self.old_ids):
            result = self.shell("test", "-d", f"/proc/{pid}", allowed=(0, 1))
            require(not result.stdout.strip() and not result.stderr.strip(),
                    "Could not determine whether an old framework process exited")
            if result.returncode == 0:
                remaining.append(pid)
        self.report["remainingOldPids"] = remaining
        return not remaining

    def stopped(self):
        current = self.pids()
        self.report["lastStoppedPids"] = current
        old_gone = self.old_processes_gone()
        return not any(current.values()) and old_gone

    def poll(self, predicate, message):
        while True:
            if predicate():
                require(self.monotonic() <= self.deadline, message)
                return
            remaining = self.deadline - self.monotonic()
            require(remaining > 0, message)
            self.sleep(min(0.25, remaining))

    def phase(self, name, timeout, operation):
        started = self.monotonic()
        self.deadline = started + timeout
        entry = {"name": name, "startedSeconds": self.elapsed(),
                 "timeoutSeconds": timeout, "passed": False}
        self.report["phase"] = name
        self.report["phases"].append(entry)
        self.save()
        try:
            operation()
            entry["passed"] = True
        finally:
            entry["seconds"] = round(self.monotonic() - started, 3)
            self.save()

    def guard(self):
        require(self.disposable, "Pass --disposable-emulator to authorize framework preparation")
        require(isinstance(self.serial, str) and re.fullmatch(r"emulator-[0-9]{4,5}", self.serial),
                "An explicit emulator serial is required; physical devices are not accepted")
        props = self.properties()
        self.report["beforeProperties"] = props
        require(props["ro.build.version.sdk"] == "29", "Preparation is restricted to API 29")
        require("1" in (props["ro.kernel.qemu"], props["ro.boot.qemu"]), "The selected device is not QEMU")
        require(props["ro.debuggable"] == "1", "The selected emulator is not debuggable")
        require(props["ro.zygote"] in ZYGOTES, "Unsupported ro.zygote configuration")
        self.expected_zygotes = ZYGOTES[props["ro.zygote"]]
        self.report["expectedZygoteProcesses"] = list(self.expected_zygotes)
        pids = self.pids()
        self.report["beforePids"] = pids
        require(self.complete_pids(pids), "Initial zygote/system_server processes are missing")
        uid = self.shell("id", "-u").stdout.strip()
        require(uid in ("0", "2000"), "Unexpected initial ADB shell UID")
        self.report["originalShellUid"] = int(uid)

    def root(self):
        self.command("root", mutation=True)
        self.command("wait-for-device")
        uid = self.shell("id", "-u").stdout.strip()
        self.report["rootUid"] = uid
        require(uid == "0", "ADB did not obtain UID 0")
        pids = self.pids()
        self.report["oldPids"] = pids
        require(self.complete_pids(pids), "Framework processes disappeared before the planned stop")
        self.old_ids = {pid for group in pids.values() for pid in group}

    def stop(self):
        self.shell("stop", mutation=True)
        self.poll(self.stopped, "Old zygote/system_server processes did not stop")
        self.report["allFrameworkProcessesStoppedSeconds"] = self.elapsed()

    def set_heap(self):
        self.shell("setprop", HEAP_PROPERTY, HEAP_VALUE, mutation=True)
        value = self.prop(HEAP_PROPERTY)
        self.report["heapBeforeStart"] = value
        require(value == HEAP_VALUE, "Heap property readback failed before framework start")
        growth_limit = self.prop("dalvik.vm.heapgrowthlimit")
        require(growth_limit == self.report["beforeProperties"]["dalvik.vm.heapgrowthlimit"],
                "Heap growth limit changed during preparation")
        require(self.stopped(), "A framework process appeared before the planned start")
        self.report["appliedBeforeZygote"] = True
        self.report["heapAppliedSeconds"] = self.elapsed()

    def ready(self):
        current = self.pids()
        self.report["lastReadyPids"] = current
        if not self.complete_pids(current):
            require(not self.report["newPids"], "A newly started framework process disappeared")
            return False
        ids = {pid for group in current.values() for pid in group}
        require(not ids.intersection(self.old_ids), "An old framework PID reappeared after start")
        require(not self.report["newPids"] or current == self.report["newPids"],
                "New framework PIDs changed while waiting for Binder readiness")
        self.report["newPids"] = current
        require(self.prop(HEAP_PROPERTY) == HEAP_VALUE, "Heap property changed after framework start")
        boot_completed = self.prop("sys.boot_completed")
        self.report["bootCompleted"] = boot_completed
        if boot_completed != "1":
            return False
        # Perform real Binder transactions; a registered service alone is insufficient.
        activity = self.shell("cmd", "activity", "get-config", allowed=None)
        package = self.shell("cmd", "package", "path", "android", allowed=None)
        activity_ok = (activity.returncode == 0 and not activity.stderr.strip()
                       and re.search(r"(?m)^config:\s*\S", activity.stdout) is not None
                       and re.search(r"(?m)^abi:\s*\S", activity.stdout) is not None)
        package_ok = (package.returncode == 0 and not package.stderr.strip()
                      and re.search(r"(?m)^package:/\S+\.apk\s*$", package.stdout) is not None)
        self.report["binderReady"] = {"activity": activity_ok, "package": package_ok}
        require(self.pids() == current, "Framework PIDs changed during Binder readiness checks")
        return activity_ok and package_ok

    def start(self):
        self.shell("start", mutation=True)
        self.poll(self.ready, "New framework did not become ready")
        props = self.properties()
        self.report["afterProperties"] = props
        require(props[HEAP_PROPERTY] == HEAP_VALUE, "Final heap property differs from the requested budget")
        require(props["dalvik.vm.heapgrowthlimit"] == self.report["beforeProperties"]["dalvik.vm.heapgrowthlimit"],
                "Final heap growth limit differs from its original value")
        require(self.pids() == self.report["newPids"], "Framework PIDs changed before preparation completed")

    def restore_shell(self):
        if self.report["originalShellUid"] == 2000:
            self.command("unroot", mutation=True)
            self.command("wait-for-device")
        uid = self.shell("id", "-u").stdout.strip()
        self.report["finalShellUid"] = int(uid) if uid.isdigit() else uid
        require(uid == str(self.report["originalShellUid"]), "Original ADB shell UID was not restored")
        require(self.pids() == self.report["newPids"], "Framework PIDs changed while restoring ADB identity")
        require(self.prop(HEAP_PROPERTY) == HEAP_VALUE, "Heap property changed while restoring ADB identity")
        require(self.prop("dalvik.vm.heapgrowthlimit") == self.report["beforeProperties"]["dalvik.vm.heapgrowthlimit"],
                "Heap growth limit changed while restoring ADB identity")

    def run(self):
        self.save()
        try:
            self.phase("guards", 45, self.guard)
            self.phase("root", 30, self.root)
            self.phase("stop", 30, self.stop)
            self.phase("set-heap-before-zygote", 15, self.set_heap)
            self.phase("start-and-readiness", 120, self.start)
            self.phase("restore-shell-identity", 30, self.restore_shell)
            self.report["passed"] = True
        except (Exception, KeyboardInterrupt) as error:
            self.report["error"] = f"{type(error).__name__}: {error}"[:4096]
        finally:
            self.report["wallSeconds"] = self.elapsed()
            self.save()
        return self.report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--disposable-emulator", action="store_true")
    parser.add_argument("--serial", default=os.environ.get("ANDROID_SERIAL"))
    parser.add_argument("--report", type=Path, required=True)
    options = parser.parse_args()
    sdk = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
    adb = shutil.which("adb") or (str(Path(sdk) / "platform-tools/adb") if sdk else "adb")
    result = Preparation(options.serial, options.disposable_emulator, options.report, adb=adb).run()
    if not result["passed"]:
        print("API 29 emulator preparation failed: " + result["error"], file=sys.stderr)
        return 1
    print("API 29 emulator prepared: 512 MiB startup budget applied before fresh zygotes; Binder ready.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
