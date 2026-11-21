#!/usr/bin/env python3
"""Prepare ftrace only on the reviewed official SDK 36 / full 36.1 r4 AVD.

No page-size change, trace retry, app execution or acceptance-budget adjustment.
Every command and failure is retained. Physical devices and active traces are
refused before any mutation. The only writable path is an allowlisted tracefs
buffer_subbuf_size_kb, with one 4 -> 16 KiB write and mandatory readback.
"""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import importlib.util
from pathlib import Path
import re
import subprocess

COMMAND_TIMEOUT_SECONDS = 10
TOTAL_TIMEOUT_SECONDS = 60
OUTPUT_LIMIT = 64 * 1024
TRACEFS_ROOTS = ("/sys/kernel/tracing", "/sys/kernel/debug/tracing")
REPORT_NAME = "ftrace-preparation.json"
# Only kernel-generated summary headers are emitted. Never expose trace payload
# or read a consuming trace_pipe / snapshot_raw file during diagnostics.
SNAPSHOT_HEADER_FILTER = (r"/^[^#]/q;/^# entries-in-buffer\/entries-written: [0-9][0-9]*\/[0-9][0-9]*   #P:[0-9][0-9]*$/p;"
                          r"/^# \* Snapshot is allocated \*$/p;/^# \* Snapshot is freed \*$/p;12q")


def failed_event_diagnostic_commands(root):
    """Observations only; /proc races and unreadable state cannot prove ownership."""
    require(root in TRACEFS_ROOTS, "Unallowlisted diagnostic tracefs root")
    stats = ("printf '%s\\n' CPU_POSSIBLE; cat /sys/devices/system/cpu/possible || exit; "
             "printf '%s\\n' CPU_PRESENT; cat /sys/devices/system/cpu/present || exit; "
             "printf '%s\\n' CPU_ONLINE; cat /sys/devices/system/cpu/online || exit; "
             f"for f in {root}/per_cpu/cpu[0-9]*/stats; do "
             "printf '%s\\n' \"$f\"; cat \"$f\" || exit; done")
    snapshot = "sed -n '" + SNAPSHOT_HEADER_FILTER + "' " + root + "/snapshot"
    # List matching FD paths, their tracefs target and access flags only. Do not
    # read argv/cmdline, trace data, BPF maps or another process's open file.
    readers = ("printf '%s\\n' TRACEFS_FD_SCAN_STARTED; "
               "find /proc/[0-9]*/fd -maxdepth 1 -type l "
               "\\( -lname '/sys/kernel/tracing/*' -o -lname '/sys/kernel/debug/tracing/*' \\) "
               "-exec sh -c 'printf \"%s\\n\" \"$1\"; "
               "readlink \"$1\" || printf \"%s\\n\" FD_TARGET_UNKNOWN; "
               "sed -n \"/^flags:/p\" \"${1%/fd/*}/fdinfo/${1##*/}\" "
               "|| printf \"%s\\n\" FD_FLAGS_UNKNOWN' sh {} \\; ; "
               "result=$?; printf 'TRACEFS_FD_SCAN_EXIT=%s\\n' \"$result\"; exit \"$result\"")
    return [("failed-event-cpu-stats", stats), ("failed-event-snapshot-header", snapshot),
            ("failed-event-tracefs-fds", readers)]


def require(value, message):
    if not value:
        raise ValueError(message)


def number(value, label):
    require(re.fullmatch(r"[0-9]+", value) is not None, f"Missing numeric {label}")
    return int(value)


def service_state(raw):
    """Read bounded TracingServiceState v24+ fields, not a text/grep heuristic."""
    require(isinstance(raw, bytes) and 0 < len(raw) < OUTPUT_LIMIT, "Missing bounded Perfetto service-state bytes")
    at = 0
    values = {}
    sessions = 0
    def varint():
        nonlocal at
        value = 0
        for shift in range(0, 70, 7):
            require(at < len(raw), "Truncated service-state varint")
            byte = raw[at]; at += 1
            require(shift < 63 or byte <= 1, "Overflowing service-state varint")
            value |= (byte & 127) << shift
            if byte < 128:
                return value
        raise ValueError("Invalid service-state varint")
    while at < len(raw):
        tag = varint()
        field, wire = tag >> 3, tag & 7
        require(field > 0, "Invalid service-state field")
        if wire == 0:
            value = varint()
        else:
            length = varint() if wire == 2 else 8 if wire == 1 else 4 if wire == 5 else -1
            require(0 <= length <= len(raw) - at, "Truncated or unsupported service-state field")
            value = raw[at:at + length]; at += length
        if field in (3, 4, 7):
            require(wire == 0 and field not in values, "Ambiguous service-state counter")
            values[field] = value
        elif field == 6:
            require(wire == 2, "Invalid tracing-session entry")
            sessions += 1
    require(values.get(7) == 1, "Perfetto does not prove support for listing active sessions")
    result = {"supportsTracingSessions": True, "numSessions": values.get(3, 0),
              "numSessionsStarted": values.get(4, 0), "listedSessions": sessions}
    require(result["numSessions"] == result["numSessionsStarted"] == result["listedSessions"] == 0,
            "A Perfetto session is active or armed; refusing geometry mutation")
    return result


_IMAGE_SPEC = importlib.util.spec_from_file_location("android_emulator_image", Path(__file__).with_name("android-emulator-image.py"))
IMAGE = importlib.util.module_from_spec(_IMAGE_SPEC)
_IMAGE_SPEC.loader.exec_module(IMAGE)
AdbRecorder = IMAGE.AdbRecorder


def prepare(prefix, report_path, expected_page_size, disposable_emulator, recorder=None):
    require(disposable_emulator is True, "Explicit disposable-emulator ownership is required")
    require(expected_page_size in (4096, 16384), "Unexpected expected page size")
    require(len(prefix) == 3 and Path(prefix[0]).name == "adb" and prefix[1] == "-s"
            and re.fullmatch(r"emulator-[0-9]+", prefix[2]), "Select an explicit owned emulator ADB serial")
    require(not report_path.exists(), "Keep prior ftrace preparation evidence; output already exists")
    report_path.parent.mkdir(parents=True, exist_ok=True)
    record = {"schemaVersion": 1, "checkedAtUtc": datetime.now(timezone.utc).isoformat(), "passed": False,
              "scope": "Reviewed SDK 36 / full 36.1 r4 disposable Linux CI image; no production-app or physical-device change.",
              "expectedPageSize": expected_page_size, "explicitDisposableOwnership": True,
              "commandTimeoutSeconds": COMMAND_TIMEOUT_SECONDS, "totalTimeoutSeconds": TOTAL_TIMEOUT_SECONDS,
              "perStreamOutputLimitBytes": OUTPUT_LIMIT, "mutationAttempted": False, "mutated": False,
              "traceRetried": False, "pageSizeChanged": False, "commands": []}
    execute = recorder
    try:
        record["imageProof"] = IMAGE.validate_report(report_path.parent / "emulator-image.json", expected_page_size)
        require(record["imageProof"]["serial"] == prefix[2], "Image and ftrace evidence target different emulator serials")
        if execute is None:
            execute = AdbRecorder(prefix, report_path.parent / "ftrace-preparation-commands")
        def read(name, command):
            code, text = execute(name, command)
            require(code == 0, "Preparation read failed: " + name)
            return text
        device = record["device"] = {}
        device["qemu"] = read("qemu", "getprop ro.kernel.qemu")
        device["buildType"] = read("build-type", "getprop ro.build.type")
        require(device["qemu"] == "1" and device["buildType"] in ("userdebug", "eng"),
                "Refusing ftrace preparation on a physical or non-userdebug device")
        device["observerUid"] = number(read("observer-uid", "id -u"), "observer UID")
        require(device["observerUid"] == 0, "Use the already established disposable root observer")
        device["pageSize"] = number(read("page-size-before", "getconf PAGE_SIZE"), "page size")
        require(device["pageSize"] == expected_page_size, "Observed page size differs from the unchanged test matrix")
        device["sdk"] = number(read("sdk", "getprop ro.build.version.sdk"), "Android SDK")
        device["abi"] = read("abi", "getprop ro.product.cpu.abi")
        device["kernel"] = read("kernel", "uname -r")
        require(all(device[key] == record["imageProof"]["device"][key] for key in device),
                "Device identity changed between image verification and ftrace preparation")
        if expected_page_size == 4096:
            record.update(applicable=False, passed=True, disposition="4 KiB guest: no tracefs mutation")
            return record
        require(device["sdk"] == 36 and device["abi"] == "x86_64",
                "The observed geometry correction is scoped to the API 36 x86_64 / 16 KiB CI gate")
        record["applicable"] = True
        root = None
        for index, candidate in enumerate(TRACEFS_ROOTS):
            code, _ = execute(f"tracefs-location-{index}", "test -f " + candidate + "/buffer_subbuf_size_kb", allow_failure=True)
            if code == 0:
                root = candidate
                break
            require(code == 1, "Unable to inspect the allowlisted tracefs geometry file")
        require(root is not None, "This image has no supported tracefs sub-buffer geometry control; capture remains unapproved")
        path = root + "/buffer_subbuf_size_kb"
        record["tracefsPath"] = path
        before = record["subBufferBeforeKb"] = number(read("subbuffer-before", "cat " + path), "ftrace sub-buffer size")
        require(before in (4, 16), "Unexpected ftrace geometry; do not guess or resize it")
        if before == 4:
            # tracing_on is only the ring-buffer write flag, not evidence of an
            # active tracer. Prove quiescence through independent current tracer,
            # events, root Perfetto sessions and legacy atrace state instead.
            state = record["beforeMutation"] = {
                "tracingOn": read("tracing-on", "cat " + root + "/tracing_on"),
                "currentTracer": read("current-tracer", "cat " + root + "/current_tracer"),
                "eventsEnabled": read("events-enabled", "cat " + root + "/events/enable"),
            }
            code, raw = execute("perfetto-service-state", "perfetto --query-raw", binary=True)
            require(code == 0, "Could not query root Perfetto service state")
            state["serviceState"] = service_state(raw)
            code, pids = execute("perfetto-clients", "pidof perfetto", allow_failure=True)
            state["perfettoClientPids"] = pids
            state["perfettoPidofExitCode"] = code
            state["atraceUserInitiated"] = read("atrace-user", "getprop debug.atrace.user_initiated")
            state["atraceTags"] = read("atrace-tags", "getprop debug.atrace.tags.enableflags")
            state["atraceApps"] = read("atrace-apps", "getprop debug.atrace.app_number")
            atrace_code, atrace_pids = execute("atrace-clients", "pidof atrace", allow_failure=True)
            state["atraceClientPids"], state["atracePidofExitCode"] = atrace_pids, atrace_code
            refusal = "Refusing to resize while tracing, events or a Perfetto client may be active"
            if state["eventsEnabled"] != "0":
                record["failedGuard"] = {"field": "eventsEnabled", "observed": state["eventsEnabled"], "expected": "0"}
                refusal += f"; eventsEnabled={state['eventsEnabled']!r} (expected '0')"
            require(state["tracingOn"] in ("0", "1") and state["currentTracer"] == "nop"
                    and state["eventsEnabled"] == "0" and code == 1 and not pids,
                    refusal)
            require(all(state[name] in ("", "0") for name in ("atraceUserInitiated", "atraceTags", "atraceApps"))
                    and atrace_code == 1 and not atrace_pids,
                    "Legacy atrace capture is active; refusing geometry mutation")
            record["mutationAttempted"] = True
            # Both destination and value are source literals, never caller text.
            require(read("subbuffer-write", "printf '%s\\n' 16 > " + path) == "", "Unexpected tracefs write output")
            record["mutated"] = True
        after = record["subBufferAfterKb"] = number(read("subbuffer-after", "cat " + path), "ftrace sub-buffer readback")
        require(after == 16, "Tracefs readback is not exactly 16 KiB; no trace proof can be approved")
        record["pageSizeAfter"] = number(read("page-size-after", "getconf PAGE_SIZE"), "page-size readback")
        require(record["pageSizeAfter"] == expected_page_size, "PAGE_SIZE changed unexpectedly")
        if record["mutated"]:
            record["tracingOnAfter"] = read("tracing-on-after", "cat " + root + "/tracing_on")
            require(record["tracingOnAfter"] == record["beforeMutation"]["tracingOn"],
                    "Tracefs recording state changed unexpectedly during geometry preparation")
        record.update(passed=True, disposition="Observed 4 KiB sub-buffer corrected once to 16 KiB" if before == 4
                      else "Observed 16 KiB sub-buffer already matches; no mutation")
        return record
    except (OSError, ValueError, subprocess.SubprocessError) as failure:
        record["error"] = str(failure)[:1000]
        if record.get("failedGuard", {}).get("field") == "eventsEnabled":
            # Preserve the rejection. Diagnostic reads on the same recorder
            # share its original deadline/output caps and never authorize resize.
            try:
                enabled_events = read("enabled-events", "cat " + root + "/set_event")
                state = record.get("beforeMutation", {})
                if (enabled_events.strip() == "bpf_trace:bpf_trace_printk"
                        and state.get("tracingOn") == "0" and state.get("currentTracer") == "nop"):
                    diagnostics = record["readOnlyDiagnostics"] = {
                        "purpose": "Assess whether an empty-buffer preparation experiment is possible; never authorizes mutation.",
                        "quiescenceEstablished": False, "ownerEstablished": False,
                        "allReadsCompleted": False, "errors": {},
                        "limitations": "Point-in-time /proc scan is not an atomic ownership proof; missing or unreadable data stays unknown.",
                    }
                    for name, command in failed_event_diagnostic_commands(root):
                        try:
                            require(read(name, command) != "", "Missing diagnostic output: " + name)
                        except (OSError, ValueError, subprocess.SubprocessError) as observation_failure:
                            diagnostics["errors"][name] = str(observation_failure)[:1000]
                    diagnostics["allReadsCompleted"] = not diagnostics["errors"]
            except (OSError, ValueError, subprocess.SubprocessError) as diagnostic_failure:
                record["eventDiagnosticsError"] = str(diagnostic_failure)[:1000]
        raise
    finally:
        record["commands"] = getattr(execute, "records", [])
        with report_path.open("x", encoding="utf-8") as output:
            json.dump(record, output, indent=2, allow_nan=False)
            output.write("\n")


def command_plan(proof):
    plan = [("qemu", "getprop ro.kernel.qemu", 0), ("build-type", "getprop ro.build.type", 0),
            ("observer-uid", "id -u", 0), ("page-size-before", "getconf PAGE_SIZE", 0),
            ("sdk", "getprop ro.build.version.sdk", 0), ("abi", "getprop ro.product.cpu.abi", 0),
            ("kernel", "uname -r", 0)]
    if not proof["applicable"]:
        return plan
    path = proof["tracefsPath"]
    root = next((root for root in TRACEFS_ROOTS if path == root + "/buffer_subbuf_size_kb"), None)
    require(root is not None, "Unallowlisted tracefs preparation path")
    for index, candidate in enumerate(TRACEFS_ROOTS):
        plan.append((f"tracefs-location-{index}", "test -f " + candidate + "/buffer_subbuf_size_kb", 0 if candidate == root else 1))
        if candidate == root:
            break
    plan.append(("subbuffer-before", "cat " + path, 0))
    if proof["subBufferBeforeKb"] == 4:
        plan.extend([("tracing-on", "cat " + root + "/tracing_on", 0),
                     ("current-tracer", "cat " + root + "/current_tracer", 0),
                     ("events-enabled", "cat " + root + "/events/enable", 0),
                     ("perfetto-service-state", "perfetto --query-raw", 0),
                     ("perfetto-clients", "pidof perfetto", 1),
                     ("atrace-user", "getprop debug.atrace.user_initiated", 0),
                     ("atrace-tags", "getprop debug.atrace.tags.enableflags", 0),
                     ("atrace-apps", "getprop debug.atrace.app_number", 0),
                     ("atrace-clients", "pidof atrace", 1),
                     ("subbuffer-write", "printf '%s\\n' 16 > " + path, 0)])
    plan.extend([("subbuffer-after", "cat " + path, 0), ("page-size-after", "getconf PAGE_SIZE", 0)])
    if proof["mutated"]:
        plan.append(("tracing-on-after", "cat " + root + "/tracing_on", 0))
    return plan


def validate_report(path, expected_page_size):
    require(path.is_file() and 0 < path.stat().st_size <= 256 * 1024, "Missing or oversized ftrace preparation proof")
    raw = path.read_bytes()
    proof = json.loads(raw)
    device = proof["device"]
    image_proof = IMAGE.validate_report(path.parent / "emulator-image.json", expected_page_size)
    require(proof["imageProof"] == image_proof
            and all(device[key] == image_proof["device"][key] for key in device),
            "Ftrace preparation differs from independently verified image provenance")
    require(proof["schemaVersion"] == 1 and proof["passed"] is True and proof["explicitDisposableOwnership"] is True
            and proof["expectedPageSize"] == device["pageSize"] == expected_page_size
            and device["qemu"] == "1" and device["buildType"] in ("userdebug", "eng")
            and device["observerUid"] == 0 and proof["traceRetried"] is False and proof["pageSizeChanged"] is False,
            "Unverified or out-of-scope ftrace preparation")
    require(proof["commandTimeoutSeconds"] == COMMAND_TIMEOUT_SECONDS
            and proof["totalTimeoutSeconds"] == TOTAL_TIMEOUT_SECONDS
            and proof["perStreamOutputLimitBytes"] == OUTPUT_LIMIT, "Preparation bounds changed")
    if expected_page_size == 4096:
        require(proof["applicable"] is False and proof["mutationAttempted"] is False and proof["mutated"] is False,
                "A 4 KiB guest must not be modified")
    else:
        require(proof["applicable"] is True and device["sdk"] == 36 and device["abi"] == "x86_64"
                and proof["tracefsPath"] in {root + "/buffer_subbuf_size_kb" for root in TRACEFS_ROOTS}
                and proof["subBufferAfterKb"] == 16 and proof["pageSizeAfter"] == 16384,
                "Missing exact 16 KiB tracefs / unchanged guest page readback")
        if proof["subBufferBeforeKb"] == 4:
            state = proof["beforeMutation"]
            require(proof["mutationAttempted"] is True and proof["mutated"] is True
                    and state["tracingOn"] in ("0", "1") and state["currentTracer"] == "nop"
                    and state["eventsEnabled"] == "0" and state["perfettoClientPids"] == ""
                    and state["perfettoPidofExitCode"] == 1 and state["atraceClientPids"] == ""
                    and state["atracePidofExitCode"] == 1
                    and all(state[name] in ("", "0") for name in ("atraceUserInitiated", "atraceTags", "atraceApps"))
                    and state["serviceState"] == {"supportsTracingSessions": True, "numSessions": 0,
                                                  "numSessionsStarted": 0, "listedSessions": 0}
                    and proof["tracingOnAfter"] == state["tracingOn"],
                    "The geometry mutation lacks inactive-tracing proof")
        else:
            require(proof["subBufferBeforeKb"] == 16 and proof["mutationAttempted"] is False and proof["mutated"] is False,
                    "Unsupported ftrace geometry transition")
    commands = proof["commands"]
    plan = command_plan(proof)
    observed, prefix = IMAGE.validate_commands(commands, path.parent / "ftrace-preparation-commands", plan,
                                               binary_names={"perfetto-service-state"})
    require(prefix[2] == image_proof["serial"], "Image and ftrace raw commands target different emulator serials")
    for name in observed:
        if name.startswith("tracefs-location-") or name in ("perfetto-clients", "atrace-clients", "subbuffer-write"):
            require(observed[name] == "", "Unexpected text from a preparation probe/write")
    require(observed["qemu"] == "1" and observed["build-type"] == device["buildType"]
            and observed["observer-uid"] == "0" and number(observed["page-size-before"], "raw page size") == expected_page_size
            and number(observed["sdk"], "raw SDK") == device["sdk"] and observed["abi"] == device["abi"]
            and observed["kernel"] == device["kernel"] and device["kernel"],
            "Raw device observations disagree with the preparation summary")
    if expected_page_size == 16384:
        require(number(observed["subbuffer-before"], "raw sub-buffer") == proof["subBufferBeforeKb"]
                and observed["subbuffer-after"] == "16" and observed["page-size-after"] == "16384",
                "Raw geometry readback disagrees with the preparation summary")
        if proof["mutated"]:
            state = proof["beforeMutation"]
            require(observed["tracing-on"] == state["tracingOn"] and observed["current-tracer"] == "nop"
                    and observed["events-enabled"] == "0" and observed["perfetto-clients"] == ""
                    and service_state(observed["perfetto-service-state"]) == state["serviceState"]
                    and observed["atrace-user"] == state["atraceUserInitiated"]
                    and observed["atrace-tags"] == state["atraceTags"] and observed["atrace-apps"] == state["atraceApps"]
                    and observed["atrace-clients"] == "" and observed["subbuffer-write"] == ""
                    and observed["tracing-on-after"] == proof["tracingOnAfter"],
                    "Raw inactive-tracing / write evidence differs")
    return {"passed": True, "reportSha256": hashlib.sha256(raw).hexdigest(), "applicable": proof["applicable"],
            "mutated": proof["mutated"], "subBufferBeforeKb": proof.get("subBufferBeforeKb"),
            "subBufferAfterKb": proof.get("subBufferAfterKb"), "pageSize": expected_page_size,
            "imageProof": image_proof, "scope": proof["scope"]}
