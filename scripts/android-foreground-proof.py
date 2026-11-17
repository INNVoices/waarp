#!/usr/bin/env python3
"""Validate scoped release frame observations; never approve physical-device FPS."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
import subprocess

APP = "local.waarp.android"
TRACE_DIRECTORY = "/data/misc/perfetto-traces"
TRACE_LIMIT = 32 * 1024 * 1024
TEXT_LIMIT = 2 * 1024 * 1024
ACTIONS = {"control": ("off", "on", "rename"), "navigation": ("routes", "tunnels", "diagnostics", "home")}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def number(value, name, minimum=0):
    require(type(value) is int and value >= minimum, f"Invalid foreground observation: {name}")
    return value


def one(directory, name):
    paths = list(Path(directory).rglob(name))
    require(len(paths) == 1 and paths[0].is_file() and paths[0].stat().st_size <= TEXT_LIMIT,
            f"Missing, ambiguous or oversized foreground evidence: {name}")
    return paths[0]


def gfx(text, expected_pid, *, require_frames):
    owners = re.findall(r"^\*\* Graphics info for pid (\d+) \[([^\]]+)\] \*\*$", text, re.M)
    require(owners == [(str(expected_pid), APP)], "Frame dump owner does not match the observed release PID.")

    def first(pattern, label):
        match = re.search(pattern, text, re.M)
        require(match is not None, f"Missing global HWUI field: {label}")
        return int(match.group(1))

    # HWUI repeats these fields per Window. The first section is the process
    # aggregate; do not sum windows or silently choose the current window.
    since = first(r"^Stats since: (\d+)ns$", "stats since")
    total = first(r"^Total frames rendered: (\d+)$", "total frames")
    janky = first(r"^Janky frames: (\d+) \([0-9.]+%\)$", "janky frames")
    require(0 <= janky <= total, "Invalid global jank count.")
    percentiles = {f"p{percentile}Ms": first(rf"^{percentile}th percentile: (\d+)ms$", f"p{percentile}")
                   for percentile in (50, 90, 95, 99)}
    require(list(percentiles.values()) == sorted(percentiles.values()), "HWUI percentiles are not ordered.")
    frame_rows = []
    for block in re.findall(r"---PROFILEDATA---\s*\n(.*?)---PROFILEDATA---", text, re.S):
        lines = [line.strip().rstrip(",") for line in block.splitlines() if line.strip()]
        if not lines:
            continue
        fields = lines[0].split(",")
        require(all(name in fields for name in ("Flags", "IntendedVsync", "FrameCompleted")), "Missing HWUI raw frame columns.")
        require(len(fields) == len(set(fields)), "Repeated HWUI raw frame column.")
        for line in lines[1:]:
            parts = line.split(",")
            require(len(parts) == len(fields) and all(re.fullmatch(r"-?\d+", value) for value in parts),
                    "Malformed raw HWUI frame row.")
            row = dict(zip(fields, map(int, parts)))
            if row["Flags"] == 0 and 0 < row["IntendedVsync"] <= row["FrameCompleted"] < 2 ** 63 - 1:
                frame_rows.append(row)
    if require_frames:
        require(total > 0 and frame_rows, "No actual rendered frames in the foreground window.")
    return {"statsSinceNs": since, "totalFrames": total, "jankyFrames": janky,
            "jankyPercent": round(janky / total * 100, 4) if total else None, **percentiles,
            "rawCompletedFrames": len(frame_rows), "rawFrames": frame_rows}


def varint(data, offset):
    value = 0
    for shift in range(0, 70, 7):
        require(offset < len(data), "Truncated Perfetto varint.")
        byte = data[offset]; offset += 1
        require(shift < 63 or byte <= 1, "Overflowing Perfetto varint.")
        value |= (byte & 127) << shift
        if byte < 128:
            return value, offset
    raise ValueError("Invalid Perfetto varint.")


def fields(data):
    offset = 0
    while offset < len(data):
        tag, offset = varint(data, offset)
        field, wire = tag >> 3, tag & 7
        require(field > 0, "Invalid Perfetto protobuf field.")
        if wire == 0:
            value, offset = varint(data, offset)
        else:
            if wire == 2:
                length, offset = varint(data, offset)
            elif wire == 1:
                length = 8
            elif wire == 5:
                length = 4
            else:
                raise ValueError("Unsupported Perfetto protobuf wire type.")
            require(length <= len(data) - offset, "Truncated Perfetto protobuf field.")
            value = data[offset:offset + length]; offset += length
        yield field, wire, value


def trace_structure(path):
    # Independently implemented bounded wire reader, using the stable field
    # numbers in official Perfetto TracePacket/FtraceEvent/FtraceEventBundle at
    # 2e3c98a53d2132a767f61a6e16109d5817193d7a. See acceptance/README.md.
    require(path.is_file() and 0 < path.stat().st_size <= TRACE_LIMIT, "Missing or oversized foreground system trace.")
    raw = path.read_bytes()
    packets = bundles = sched = prints = compact = losses = 0
    first_event = last_event = None
    for field, wire, packet in fields(raw):
        require(field == 1 and wire == 2, "File is not a Perfetto Trace packet stream.")
        packets += 1
        for packet_field, packet_wire, bundle in fields(packet):
            if packet_field != 1 or packet_wire != 2:
                continue
            bundles += 1
            for bundle_field, bundle_wire, event in fields(bundle):
                if bundle_field == 3 and bundle_wire == 0 and event:
                    losses += 1
                if bundle_field == 4 and bundle_wire == 2:
                    # CompactSched carries packed timestamp deltas in fields
                    # 1 and 7. An empty nested message is not scheduling data.
                    if any(key in (1, 7) and kind == 2 and value for key, kind, value in fields(event)):
                        compact += 1
                if bundle_field != 2 or bundle_wire != 2:
                    continue
                details = list(fields(event))
                timestamp = next((value for key, kind, value in details if key == 1 and kind == 0), None)
                if not isinstance(timestamp, int) or timestamp <= 0:
                    continue
                first_event = timestamp if first_event is None else min(first_event, timestamp)
                last_event = timestamp if last_event is None else max(last_event, timestamp)
                for event_field, event_wire, payload in details:
                    if event_wire == 2 and payload and event_field in (4, 17, 114):
                        sched += 1
                    if event_wire == 2 and payload and event_field == 3:
                        prints += 1
    require(packets > 0 and bundles > 0 and (sched > 0 or compact > 0),
            "The trace has no actual kernel scheduling events.")
    return {"file": path.name, "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest(),
            "packets": packets, "ftraceBundles": bundles, "schedulingEvents": sched,
            "compactSchedulingBundles": compact, "atracePrintEvents": prints, "bundlesReportingLostEvents": losses,
            "firstFtraceTimestampNs": first_event, "lastFtraceTimestampNs": last_event,
            "scope": "Structural and scheduling-data proof only; trace completeness and causal frame analysis require review."}


def collect_traces(prefix, evidence, output):
    """Copy only the exact bounded trace files named by this fresh fixture."""
    summaries = list(Path(evidence).rglob("release-smoke.json")) + list(Path(evidence).rglob("release-soak.json"))
    require(len(summaries) == 1, "Expected one device summary before copying foreground traces.")
    summary = json.loads(summaries[0].read_text())
    mode = summary["mode"]
    require(mode in ("smoke", "soak"), "Invalid foreground trace mode.")
    output.mkdir(parents=True, exist_ok=True)
    copied = []
    for observation in summary.get("foregroundFrames", []):
        phase = observation["phase"]
        require(phase in ACTIONS, "Invalid foreground trace phase.")
        pid = number(observation["pid"], "trace owner PID", 2)
        started = number(observation["startedElapsedMs"], "trace window start")
        trace = observation["trace"]
        expected = f"{TRACE_DIRECTORY}/waarp-{mode}-{phase}-{pid}-{started}.perfetto-trace"
        require(trace["remotePath"] == expected, "Unexpected trace path; refusing to pull arbitrary device files.")
        if trace.get("available") is not True:
            continue
        path = output / f"foreground-{phase}.perfetto-trace"
        observed = subprocess.run(prefix + ["shell", "stat", "-c", "%s", expected], text=True,
                                  capture_output=True, timeout=10)
        require(observed.returncode == 0 and re.fullmatch(r"\d+\s*", observed.stdout)
                and 0 < int(observed.stdout) <= TRACE_LIMIT, "Remote trace size is missing or exceeds its cap.")
        result = subprocess.run(prefix + ["pull", expected, str(path)], capture_output=True, text=True, timeout=60)
        require(result.returncode == 0 and path.is_file() and path.stat().st_size == int(observed.stdout),
                "Foreground trace copy did not preserve the recorded size.")
        copied.append(trace_structure(path))
    return copied


def validate(evidence, summary, traces):
    expected = ("control", "navigation") if summary["mode"] == "smoke" else ("navigation",)
    observations = summary.get("foregroundFrames", [])
    require(tuple(value.get("phase") for value in observations) == expected, "Missing or repeated foreground observation scope.")
    result = []
    for observed in observations:
        phase = observed["phase"]
        require(all(observed.get(name) is True for name in ("completed", "foregroundAtStart", "foregroundAtFinish")),
                "Foreground frame collection did not complete while visible.")
        require(observed.get("physicalDevicePerformanceApproved") is False, "Emulator capture cannot approve physical-device performance.")
        pid = number(observed["pid"], "foreground PID", 2)
        require(observed["pidAtFinish"] == pid, "Release process changed during frame collection.")
        start = number(observed["startedElapsedMs"], "capture start")
        end = number(observed["finishedElapsedMs"], "capture end")
        require(start < end, "Foreground capture duration is empty.")
        requested = number(observed["resetRequestedNs"], "reset request")
        reset = number(observed["resetCompletedNs"], "reset completion")
        dumped = number(observed["dumpCompletedNs"], "dump completion")
        require(requested <= reset < dumped, "Foreground capture clock order is invalid.")
        actions = observed["actions"]
        require(tuple(action.get("name") for action in actions) == ACTIONS[phase], "Missing or reordered foreground interactions.")
        previous = start
        for action in actions:
            begin = number(action["startedElapsedMs"], "action start")
            finish = number(action["finishedElapsedMs"], "action finish")
            require(action.get("completed") is True and previous <= begin <= finish <= end, "Foreground interaction evidence is incomplete.")
            previous = finish
        before = one(evidence, f"foreground-{phase}-before.txt")
        resetting = one(evidence, f"foreground-{phase}-reset.txt")
        after = one(evidence, f"foreground-{phase}-after.txt")
        gfx(before.read_text(), pid, require_frames=False)
        gfx(resetting.read_text(), pid, require_frames=False)
        measured = gfx(after.read_text(), pid, require_frames=True)
        require(requested <= measured["statsSinceNs"] <= reset, "Frame counters were not actually reset for this foreground window.")
        raw_frames = measured.pop("rawFrames")
        scoped = [row for row in raw_frames if measured["statsSinceNs"] <= row["IntendedVsync"] <= row["FrameCompleted"] <= dumped]
        require(scoped, "No completed raw frames belong to the measured foreground window.")
        trace = observed["trace"]
        require(trace.get("attempted") is True and trace.get("maxDurationMs") == 180000
                and trace.get("bufferBytes") == 16 * 1024 * 1024, "Trace capture limits or attempt are missing.")
        if trace.get("available") is True:
            require(trace.get("started") is True and trace.get("completed") is True, "Trace completion is unproven.")
            trace_start = number(trace["startedElapsedMs"], "trace start")
            trace_stop = number(trace["stopRequestedElapsedMs"], "trace stop")
            trace_finish = number(trace["finishedElapsedMs"], "trace finish")
            require(start <= trace_start <= actions[0]["startedElapsedMs"] and end <= trace_stop <= trace_finish
                    and trace_stop - trace_start < 180000 and trace_finish - trace_stop <= 15000,
                    "Trace clock order or fixed capture/flush bounds are invalid.")
            trace_proof = trace_structure(Path(traces) / f"foreground-{phase}.perfetto-trace")
        else:
            require(trace.get("available") is False and isinstance(trace.get("error"), str) and trace["error"],
                    "Unavailable tracing requires an explicit observed error.")
            trace_proof = {"available": False, "error": trace["error"]}
        result.append({"phase": phase, "pid": pid, "elapsedMs": end - start, "actions": actions,
                       "gfxinfo": measured, "rawFramesWithinScope": len(scoped),
                       "afterSha256": hashlib.sha256(after.read_bytes()).hexdigest(), "systemTrace": trace_proof})
    return {"scope": "Actual foreground interactions in a software-rendered disposable emulator; no hardware FPS approval.",
            "scopes": result, "physicalDevicePerformanceApproved": False}
