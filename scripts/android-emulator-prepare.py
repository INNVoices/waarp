#!/usr/bin/env python3
"""Apply the declared API 29 heap budget before starting fresh Android VMs.

This is one planned initialization of an explicitly disposable emulator, before
guest fixtures or app installation. It never retries framework mutations or
tests. The report proves startup ordering; it does not claim to measure an
existing VM's Runtime.maxMemory().
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import resource
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
FAILURE_DIAGNOSTIC_SECONDS = 12
FAILURE_DIAGNOSTIC_COMMAND_SECONDS = 2
FAILURE_DIAGNOSTIC_BYTES = 1024 * 1024


class PreparationError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise PreparationError(message)


def run_command(arguments, timeout):
    return subprocess.run(arguments, capture_output=True, text=True,
                          errors="replace", timeout=timeout)


def run_diagnostic_command(arguments, timeout, stdout_path, stderr_path, output_limit):
    """Bound each raw stream on disk; never buffer an unbounded guest dump."""
    def limit_files():
        resource.setrlimit(resource.RLIMIT_FSIZE, (output_limit, output_limit))

    outcome = {"exitCode": None, "timedOut": False}
    with stdout_path.open("xb") as stdout, stderr_path.open("xb") as stderr:
        try:
            result = subprocess.run(arguments, stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr,
                                    timeout=timeout, preexec_fn=limit_files)
            outcome["exitCode"] = result.returncode
        except subprocess.TimeoutExpired:
            outcome.update(timedOut=True, error="TimeoutExpired")
        except OSError as error:
            outcome["error"] = type(error).__name__ + ": " + str(error)
    return outcome


class Preparation:
    def __init__(self, serial, disposable, report_path, *, adb="adb",
                 command_runner=run_command, diagnostic_runner=run_diagnostic_command,
                 monotonic=time.monotonic, sleep=time.sleep):
        self.serial = serial
        self.disposable = disposable
        self.report_path = Path(report_path)
        self.prefix = [adb, "-s", serial or ""]
        self.command_runner = command_runner
        self.diagnostic_runner = diagnostic_runner
        self.monotonic = monotonic
        self.sleep = sleep
        self.started = monotonic()
        self.deadline = self.started
        self.expected_zygotes = ()
        self.old_ids = set()
        self.diagnostics_allowed = False
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
                require(len(values[name]) == len(set(values[name])), "Repeated PID in one lookup: " + name)
        return values

    def complete_pids(self, pids):
        expected = set(self.expected_zygotes) | {"system_server"}
        require(all(not pids[name] for name in set(PROCESS_NAMES) - expected),
                "A zygote outside the ro.zygote configuration is running")
        ids = [pid for group in pids.values() for pid in group]
        # A forked child inherits the zygote name until specialization renames it.
        # Separate pidof calls may observe that same child under both names.
        # Only a unique snapshot is ready; the caller's phase deadline still applies.
        complete = all(len(pids[name]) == 1 for name in expected) and len(ids) == len(set(ids))
        if not complete:
            self.report["incompletePidReads"] = self.report.get("incompletePidReads", 0) + 1
            self.report["lastIncompletePids"] = pids
        return complete

    def unique_pids(self, report_key, message):
        def ready():
            current = self.pids()
            self.report[report_key] = current
            return self.complete_pids(current)
        self.poll(ready, message)
        return self.report[report_key]

    def retained_pids(self, current, expected, message):
        # Extra short-lived children are not replacements for an accepted owner.
        # A missing/replaced accepted PID must fail, even in an ambiguous snapshot.
        ids = {pid for group in current.values() for pid in group}
        require(not ids.intersection(self.old_ids), "An old framework PID reappeared after start")
        require(all(set(expected[name]).issubset(current[name]) for name in PROCESS_NAMES), message)
        return self.complete_pids(current)

    def wait_for_retained_pids(self, message):
        def ready():
            current = self.pids()
            self.report["lastReadyPids"] = current
            return self.retained_pids(current, self.report["newPids"], message)
        self.poll(ready, message)

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
        # Only this positively identified disposable API29 guest may contribute
        # failure logs. A bad serial/API/QEMU/debuggable guard performs no dump.
        self.diagnostics_allowed = True
        self.report["expectedZygoteProcesses"] = list(self.expected_zygotes)
        self.unique_pids("beforePids", "Initial zygote/system_server processes did not become unique")
        uid = self.shell("id", "-u").stdout.strip()
        require(uid in ("0", "2000"), "Unexpected initial ADB shell UID")
        self.report["originalShellUid"] = int(uid)

    def root(self):
        self.command("root", mutation=True)
        self.command("wait-for-device")
        uid = self.shell("id", "-u").stdout.strip()
        self.report["rootUid"] = uid
        require(uid == "0", "ADB did not obtain UID 0")
        pids = self.unique_pids("oldPids", "Framework processes did not become unique before the planned stop")
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
        ids = {pid for group in current.values() for pid in group}
        require(not ids.intersection(self.old_ids), "An old framework PID reappeared after start")
        complete = (self.retained_pids(current, self.report["newPids"],
                                      "New framework PIDs changed while waiting for Binder readiness")
                    if self.report["newPids"] else self.complete_pids(current))
        if not complete:
            return False
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
        after = self.pids()
        self.report["lastReadyPids"] = after
        complete = self.retained_pids(after, current, "Framework PIDs changed during Binder readiness checks")
        return activity_ok and package_ok and complete

    def start(self):
        self.shell("start", mutation=True)
        self.poll(self.ready, "New framework did not become ready")
        props = self.properties()
        self.report["afterProperties"] = props
        require(props[HEAP_PROPERTY] == HEAP_VALUE, "Final heap property differs from the requested budget")
        require(props["dalvik.vm.heapgrowthlimit"] == self.report["beforeProperties"]["dalvik.vm.heapgrowthlimit"],
                "Final heap growth limit differs from its original value")
        self.wait_for_retained_pids("Framework PIDs changed before preparation completed")

    def restore_shell(self):
        evidence = {
            "unrootIssued": False, "unrootExitCode": None,
            "unrootTransportClosed": False, "waitTimeouts": 0,
            "transportDisconnectObservations": 0, "uidObservations": 0,
            "originalUidObserved": False, "finalUidConfirmed": False,
            "binderReady": {"activity": False, "package": False},
            "pidsRetained": False, "heapPreserved": False, "verified": False,
        }
        self.report["shellIdentityRestoration"] = evidence
        if self.report["originalShellUid"] == 2000:
            evidence["unrootIssued"] = True
            result = self.command("unroot", allowed=None, mutation=True)
            evidence["unrootExitCode"] = result.returncode
            # Android 10 restart_unroot_service sets service.adb.root=0 before
            # writing its reply. This exact EOF can leave the mutation outcome
            # unknown; it is never success without the read-only proof below.
            evidence["unrootTransportClosed"] = (
                result.returncode == 1 and not result.stdout.strip()
                and result.stderr.strip() == "adb: unable to connect for unroot: closed")
            require((result.returncode == 0 and not result.stderr.strip())
                    or evidence["unrootTransportClosed"],
                    "ADB unroot failed without a recognized transport closure")

        def observed_original_uid():
            if evidence["unrootIssued"]:
                try:
                    result = self.command("wait-for-device", allowed=None)
                except PreparationError as error:
                    # Only this read-only transport wait can use another slice
                    # of the existing 30-second phase. Never resend unroot.
                    if isinstance(error.__cause__, subprocess.TimeoutExpired):
                        evidence["waitTimeouts"] += 1
                        return False
                    raise
                if self.restore_transport_disconnected(result):
                    evidence["transportDisconnectObservations"] += 1
                    return False
                require(result.returncode == 0 and not result.stdout.strip() and not result.stderr.strip(),
                        "ADB reconnect observation failed")
            result = self.shell("id", "-u", allowed=None)
            if evidence["unrootIssued"] and self.restore_transport_disconnected(result):
                evidence["transportDisconnectObservations"] += 1
                return False
            require(result.returncode == 0 and not result.stderr.strip(), "ADB shell UID observation failed")
            uid = result.stdout.strip()
            self.report["finalShellUid"] = int(uid) if uid.isdigit() else uid
            require(uid in ("0", "2000"), "Unexpected ADB shell UID while restoring identity")
            evidence["uidObservations"] += 1
            evidence["originalUidObserved"] = uid == str(self.report["originalShellUid"])
            return evidence["originalUidObserved"]

        self.poll(observed_original_uid, "Original ADB shell UID was not restored")
        # Require fresh Binder transactions through the restored shell, retaining
        # every accepted framework owner. Earlier root-side readiness is not proof.
        self.poll(self.ready, "Framework did not retain Binder readiness after ADB identity restoration")
        evidence["binderReady"] = dict(self.report["binderReady"])
        result = self.shell("id", "-u")
        require(not result.stderr.strip(), "Final ADB shell UID observation returned an error")
        uid = result.stdout.strip()
        self.report["finalShellUid"] = int(uid) if uid.isdigit() else uid
        require(uid == str(self.report["originalShellUid"]), "Original ADB shell UID was not restored")
        evidence["finalUidConfirmed"] = True
        self.wait_for_retained_pids("Framework PIDs changed while restoring ADB identity")
        evidence["pidsRetained"] = True
        require(self.prop(HEAP_PROPERTY) == HEAP_VALUE, "Heap property changed while restoring ADB identity")
        require(self.prop("dalvik.vm.heapgrowthlimit") == self.report["beforeProperties"]["dalvik.vm.heapgrowthlimit"],
                "Heap growth limit changed while restoring ADB identity")
        evidence["heapPreserved"] = True
        evidence["verified"] = True

    def restore_transport_disconnected(self, result):
        # Exact ADB transport diagnostics only. Permission/auth/service/unknown
        # failures must not be turned into reconnect polling or a successful UID.
        messages = {
            "error: closed", "adb: error: closed",
            "error: device offline", "adb: error: device offline",
            f"error: device '{self.serial}' not found",
            f"adb: error: device '{self.serial}' not found",
        }
        return result.returncode == 1 and not result.stdout.strip() and result.stderr.strip() in messages

    def failure_diagnostic_plan(self):
        # These are observations after a permanent failure. In particular, cat
        # the accepted numeric PIDs even when pidof no longer finds their name:
        # a missing name alone does not independently prove process death.
        accepted = sorted({pid for group in self.report["newPids"].values() for pid in group})
        require(len(accepted) <= 3 and all(type(pid) is int and 1 < pid <= 2**31 - 1 for pid in accepted),
                "Invalid accepted PID set for failure diagnostics")
        plan = []
        if accepted:
            plan.append(("accepted-pids-stat", ("shell", "cat", *(f"/proc/{pid}/stat" for pid in accepted)), 16384))
        plan.extend([
            ("logcat-crash", ("shell", "logcat", "-b", "crash", "-v", "threadtime", "-t", "256"), FAILURE_DIAGNOSTIC_BYTES),
            ("logcat-recent", ("shell", "logcat", "-b", "all", "-v", "threadtime", "-t", "2000"), FAILURE_DIAGNOSTIC_BYTES),
            ("kernel", ("shell", "dmesg", "-S", "-s", "262144"), 512 * 1024),
            ("processes", ("shell", "ps", "-A", "-o", "PID,PPID,NAME,CMDLINE"), 128 * 1024),
            ("properties", ("shell", "getprop"), 128 * 1024),
            ("memory-and-uptime", ("shell", "cat", "/proc/meminfo", "/proc/uptime"), 16384),
        ])
        for pid in accepted:
            plan.append((f"accepted-pid-{pid}", ("shell", "cat", f"/proc/{pid}/stat", f"/proc/{pid}/status",
                                                f"/proc/{pid}/cmdline"), 16384))
        for tag in ("system_server_crash", "system_server_native_crash", "system_server_watchdog", "SYSTEM_TOMBSTONE"):
            plan.append(("dropbox-" + tag, ("shell", "dumpsys", "-t", "1", "dropbox", "--print", tag), 256 * 1024))
        return plan

    def collect_failure_diagnostics(self):
        require(self.report["passed"] is False and self.report.get("error"), "Diagnostics require a recorded failure")
        if not self.diagnostics_allowed:
            self.report["failureDiagnostics"] = {"attempted": False, "reason": "Disposable API29 guest guards were not confirmed"}
            return
        started = self.monotonic()
        deadline = started + FAILURE_DIAGNOSTIC_SECONDS
        directory = self.report_path.with_name(self.report_path.stem + "-diagnostics")
        evidence = {"attempted": True, "collectionFinished": False,
                    "triggerPhase": self.report.get("phase"), "triggerError": self.report["error"],
                    "startedSeconds": self.elapsed(), "timeoutSeconds": FAILURE_DIAGNOSTIC_SECONDS,
                    "perCommandTimeoutSeconds": FAILURE_DIAGNOSTIC_COMMAND_SECONDS,
                    "commands": [], "scope": "Read-only observations after permanent setup failure; not readiness, recovery or an application test."}
        self.report["failureDiagnostics"] = evidence
        self.save()
        try:
            # A second invocation cannot overwrite the first failure's raw logs.
            directory.mkdir(exist_ok=False)
            for name, arguments, limit in self.failure_diagnostic_plan():
                entry = {"name": name, "arguments": list(arguments), "attempted": False,
                         "outputLimitBytesPerStream": limit}
                evidence["commands"].append(entry)
                remaining = deadline - self.monotonic()
                if remaining <= 0:
                    entry["skipped"] = "Diagnostic deadline exhausted"
                    continue
                entry.update(attempted=True, startedSeconds=self.elapsed(),
                             timeoutSeconds=min(FAILURE_DIAGNOSTIC_COMMAND_SECONDS, remaining))
                self.save()
                command_started = self.monotonic()
                paths = {stream: directory / (name + "." + stream + ".txt") for stream in ("stdout", "stderr")}
                try:
                    outcome = self.diagnostic_runner(self.prefix + list(arguments), entry["timeoutSeconds"],
                                                     paths["stdout"], paths["stderr"], limit)
                    entry.update(outcome)
                except (Exception, KeyboardInterrupt) as error:
                    entry["collectorError"] = type(error).__name__ + ": " + str(error)
                finally:
                    entry["seconds"] = round(self.monotonic() - command_started, 3)
                    for stream, path in paths.items():
                        if not path.is_file():
                            entry[stream] = {"available": False}
                            continue
                        size = path.stat().st_size
                        require(size <= limit, "Diagnostic runner exceeded its raw output cap")
                        entry[stream] = {"available": True, "file": str(path.relative_to(self.report_path.parent)),
                                         "bytes": size, "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                                         "limitReached": size == limit}
                    self.save()
            evidence["collectionFinished"] = True
        finally:
            evidence["seconds"] = round(self.monotonic() - started, 3)
            evidence["deadlineExhausted"] = self.monotonic() >= deadline
            self.save()

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
            self.report["failedAfterSeconds"] = self.elapsed()
            # Persist the original failure before observing logs. Diagnostic
            # errors cannot replace it, extend a phase, or enter readiness again.
            self.save()
            try:
                self.collect_failure_diagnostics()
            except (Exception, KeyboardInterrupt) as diagnostic_error:
                self.report.setdefault("failureDiagnostics", {})["collectorError"] = (
                    type(diagnostic_error).__name__ + ": " + str(diagnostic_error))[:4096]
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
