#!/usr/bin/env python3
"""Strict evidence for one empty, stopped ring buffer; never disables an event."""
from __future__ import annotations

from decimal import Decimal, InvalidOperation
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import secrets
import shutil

ROOTS = ("/sys/kernel/tracing", "/sys/kernel/debug/tracing")
CONFIG_GZIP_SHA256 = "f4caa7dbe4722eb5b2d3f711f92a73e2115dc4071d72846e61fde52b3698d71a"
KERNEL_SHA256 = "8e673c5d9b9f5e44f056346eda93adf8b96d3c9f300ce7b4fcc209d6ada906a5"
KERNEL_BYTES = 22635520
BPF_EVENT = "bpf_trace:bpf_trace_printk"
REMOTE_PREFIX = "/data/local/tmp/waarp-ftrace-observer-"
COUNTERS = ("entries", "overrun", "commit overrun", "bytes", "oldest event ts",
            "now ts", "dropped events", "read events")
OUTPUT_LIMIT = 65536


def require(condition, message):
    if not condition:
        raise ValueError(message)


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "Duplicate observer JSON field")
        result[key] = value
    return result


def parse_stats(raw):
    """All exact-kernel counters, including lost/consumed data, must be zero."""
    require(isinstance(raw, str) and 0 < len(raw) < 4096, "Missing bounded CPU stats")
    values = {}
    for line in raw.strip().splitlines():
        require(":" in line, "Malformed CPU stats")
        name, value = (part.strip() for part in line.split(":", 1))
        require(name in COUNTERS and name not in values and re.fullmatch(r"[0-9]+(?:\.[0-9]+)?", value),
                "Unknown or ambiguous CPU counter")
        values[name] = value
    require(set(values) == set(COUNTERS), "Incomplete CPU counters")
    try:
        require(all(Decimal(value).is_finite() and Decimal(value) == 0
                    for name, value in values.items() if name != "now ts"),
                "Ring buffer contains existing, consumed or lost data")
        require(Decimal(values["now ts"]).is_finite(), "Invalid CPU timestamp")
    except InvalidOperation as error:
        raise ValueError("Invalid CPU counter") from error
    return values


def stats_command(root):
    require(root in ROOTS, "Unallowlisted empty-buffer root")
    return ("printf '%s\\n' CPU_POSSIBLE; cat /sys/devices/system/cpu/possible || exit; "
            "printf '%s\\n' CPU_PRESENT; cat /sys/devices/system/cpu/present || exit; "
            "printf '%s\\n' CPU_ONLINE; cat /sys/devices/system/cpu/online || exit; "
            f"for f in {root}/per_cpu/cpu[0-9]*/stats; do "
            "printf '%s\\n' \"$f\"; cat \"$f\" || exit; done")


def parse_cpu_observation(raw, root):
    lines = raw.strip().splitlines()
    require(lines[:6] == ["CPU_POSSIBLE", "0-1", "CPU_PRESENT", "0-1", "CPU_ONLINE", "0-1"],
            "The reviewed two-CPU topology is incomplete, offline or changed")
    result = []
    rest = lines[6:]
    for cpu in (0, 1):
        require(rest and rest[0] == f"{root}/per_cpu/cpu{cpu}/stats", "Missing or reordered CPU stats")
        require(len(rest) >= 9, "Incomplete CPU stats block")
        result.append(parse_stats("\n".join(rest[1:9])))
        rest = rest[9:]
    require(not rest, "Unexpected additional CPU stats")
    return result


def controls_command(root):
    require(root in ROOTS, "Unallowlisted empty-buffer root")
    names = ("tracing_on", "current_tracer", "events/enable", "set_event", "buffer_subbuf_size_kb")
    return "; ".join("printf '%s\\n' " + name + "; cat " + root + "/" + name + " || exit" for name in names)


def validate_controls(raw, size):
    require(raw.strip().splitlines() == ["tracing_on", "0", "current_tracer", "nop", "events/enable", "X",
                                         "set_event", BPF_EVENT, "buffer_subbuf_size_kb", str(size)],
            "Stopped BPF controls/events/geometry changed")
    return {"tracingOn": "0", "currentTracer": "nop", "eventsEnabled": "X",
            "enabledEvent": BPF_EVENT, "subBufferKb": size}


def parse_observer(raw):
    require(isinstance(raw, str) and 0 < len(raw.encode()) < OUTPUT_LIMIT, "Missing bounded observer result")
    value = json.loads(raw, object_pairs_hook=unique_object)
    require(isinstance(value, dict) and type(value.get("schemaVersion")) is int
            and value["schemaVersion"] == 2 and value.get("passed") is True,
            "Native descriptor observation was incomplete or refused")
    exact = {"uid": 0, "selinuxEnforcing": True, "selinuxContext": "u:r:su:s0",
             "pidNamespacesCompiledOut": True, "procVisibilityVerified": True, "passes": 2,
             "stableTaskInventories": 3, "stableTracefsProjection": True,
             "unknownDescriptors": 0, "forbiddenTracefsDescriptors": 0,
             "cpuPossible": "0-1", "cpuPresent": "0-1", "cpuOnline": "0-1",
             "deadlineNs": 9000000000, "tracefsWritten": False,
             "foreignDescriptorsOpened": False, "tracePayloadRead": False}
    require(all(type(value.get(key)) is type(expected) and value[key] == expected for key, expected in exact.items()),
            "Native observer contract changed or lacks complete visibility")
    require(type(value.get("procHidepid")) is int and value["procHidepid"] in (0, 1, 2), "Unknown proc hidepid")
    integer_names = ("procGid", "processes", "threads", "uniqueTables", "sharedThreads", "kcmpDeniedFullScans",
                     "descriptorReconciliations", "markerWriters", "elapsedNs")
    require(all(type(value.get(name)) is int and value[name] >= 0 for name in integer_names),
            "Invalid observer counters")
    require(1 < value["processes"] <= 1024 and value["processes"] <= value["uniqueTables"] <= value["threads"] <= 8192
            and value["uniqueTables"] + value["sharedThreads"] == value["threads"]
            and value["kcmpDeniedFullScans"] <= value["uniqueTables"]
            and value["descriptorReconciliations"] <= 2 * value["uniqueTables"]
            and 0 < value["elapsedNs"] < value["deadlineNs"], "Incomplete or unbounded descriptor inventory")
    counts, reads = value.get("descriptorCounts"), value.get("descriptorMetadataReads")
    require(isinstance(counts, list) and isinstance(reads, list) and len(counts) == len(reads) == 2
            and all(type(count) is int and value["markerWriters"] <= count <= 262144 for count in counts)
            and all(type(read) is int and count <= read <= 524288 for count, read in zip(counts, reads)),
            "Missing or unbounded per-pass descriptor observations")
    differences = value.get("nonTraceComparisonDifferences")
    require(isinstance(differences, dict) and set(differences) == {"withinPass", "betweenPass"}
            and all(isinstance(item, dict) and set(item) == {"added", "removed", "replaced"}
                    and all(type(count) is int and 0 <= count <= sum(reads) for count in item.values())
                    for item in differences.values()), "Unverified non-tracefs comparison differences")
    within, between = differences["withinPass"], differences["betweenPass"]
    require(counts[1] - counts[0] == between["added"] - between["removed"]
            and between["removed"] + between["replaced"] <= counts[0] - value["markerWriters"]
            and between["added"] + between["replaced"] <= counts[1] - value["markerWriters"]
            and within["removed"] + within["replaced"] <= sum(reads) - sum(counts)
            and within["added"] + within["replaced"] <= sum(counts) - 2 * value["markerWriters"]
            and ((value["descriptorReconciliations"] == 0 and not any(within.values()) and counts == reads)
                 or (0 < value["descriptorReconciliations"] <= within["added"] + within["removed"])),
            "Descriptor comparison counts disagree with the bounded observation protocol")
    barrier = value.get("membarrier")
    require(isinstance(barrier, dict) and set(barrier) == {"query", "command", "flags", "result", "calls"}
            and all(type(item) is int for item in barrier.values()) and barrier["query"] >= 0
            and barrier["query"] & 1 and barrier["command"] == 1 and barrier["flags"] == 0
            and barrier["result"] == 0 and barrier["calls"] == 1,
            "A single successful GLOBAL RCU grace-period barrier is required")
    require(isinstance(value.get("cpuStatsAfterBarrier"), list) and len(value["cpuStatsAfterBarrier"]) == 2,
            "Missing post-barrier CPU stats")
    for raw_stats in value["cpuStatsAfterBarrier"]:
        parse_stats(raw_stats)
    require(set(value) == {"schemaVersion", "passed", *exact, *integer_names, "procHidepid", "membarrier",
                          "cpuStatsAfterBarrier", "descriptorCounts", "descriptorMetadataReads",
                          "nonTraceComparisonDifferences"},
            "Unexpected native observer fields")
    return value


def build_module():
    path = Path(__file__).with_name("android-ftrace-observer-build.py")
    require(path.is_file(), "Missing pinned observer build verifier")
    spec = importlib.util.spec_from_file_location("ftrace_observer_build", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def staged_paths(proof):
    remote = proof["remoteDirectory"]
    require(isinstance(remote, str) and re.fullmatch(re.escape(REMOTE_PREFIX) + r"[0-9a-f]{24}", remote),
            "Unowned observer staging path")
    local = proof["hostBinaryPath"]
    require(isinstance(local, str) and Path(local).is_absolute()
            and Path(local).parts[-2:] == ("empty-buffer-observer", "tracefs-observer")
            and not any(character in local for character in "\n\r\x00"), "Unverified host observer path")
    return local, remote, remote + "/tracefs-observer"


def command_plan(proof, root):
    local, remote, binary = staged_paths(proof)
    return [("kernel-config-digest", "sha256sum /proc/config.gz", 0),
            ("snapshot-not-compiled", "test ! -e " + root + "/snapshot", 0),
            ("observer-create", "umask 077; mkdir " + remote, 0),
            ("observer-push", ["push", "-q", local, binary], 0),
            ("observer-digest", "sha256sum " + binary, 0),
            ("observer-mode", "chmod 500 " + binary, 0),
            ("observer-scan", "exec " + binary + " " + root, 0),
            ("observer-cleanup", "rm -f " + binary + " && rmdir " + remote, 0),
            ("empty-controls-before-write", controls_command(root), 0),
            ("empty-stats-before-write", stats_command(root), 0)]


def establish(execute, read, report_directory, record, root, observer_directory):
    image = record["imageProof"]
    require(image.get("installedKernelSha256") == KERNEL_SHA256
            and image.get("installedKernelBytes") == KERNEL_BYTES, "Missing exact installed-kernel binding")
    proof = record["emptyBufferProof"] = {"schemaVersion": 1, "enabledEventPreserved": BPF_EVENT,
                                         "bpfProducerOwnerEstablished": False}
    digest = read("kernel-config-digest", "sha256sum /proc/config.gz")
    require(digest == CONFIG_GZIP_SHA256 + "  /proc/config.gz", "Runtime kernel config differs from reviewed embedded IKCONFIG")
    proof["kernelConfigGzipSha256"] = CONFIG_GZIP_SHA256
    # Exact config: MAX_TRACE hidden bool is n; SNAPSHOT=n; PID_NS/USER_NS=n;
    # MEMBARRIER/PREEMPT_RCU/KCMP=y. Missing snapshot alone is never proof.
    require(read("snapshot-not-compiled", "test ! -e " + root + "/snapshot") == "", "Unexpected snapshot state")
    builder = build_module()
    source = Path(__file__).with_name("android-ftrace-observer.c")
    builder.validate_build(observer_directory, source_path=source)
    retained = report_directory / "empty-buffer-observer"
    retained.mkdir()
    for name in ("build.json", "tracefs-observer", "android-ftrace-observer.c"):
        shutil.copyfile(observer_directory / name, retained / name)
    proof["observerBuild"] = builder.validate_build(retained, source_path=source)
    proof["hostBinaryPath"] = str((retained / "tracefs-observer").resolve())
    proof["remoteDirectory"] = REMOTE_PREFIX + secrets.token_hex(12)
    local, remote, binary = staged_paths(proof)
    created = False
    primary_error = None
    try:
        require(read("observer-create", "umask 077; mkdir " + remote) == "", "Unexpected staging output")
        created = True
        code, _ = execute("observer-push", ["push", "-q", local, binary])
        require(code == 0, "Observer transfer failed")
        require(read("observer-digest", "sha256sum " + binary) == proof["observerBuild"]["binarySha256"] + "  " + binary,
                "Transferred observer bytes differ")
        require(read("observer-mode", "chmod 500 " + binary) == "", "Unexpected observer mode output")
        proof["observerResult"] = parse_observer(read("observer-scan", "exec " + binary + " " + root))
    except Exception as error:
        primary_error = error
        raise
    finally:
        if created:
            try:
                require(read("observer-cleanup", "rm -f " + binary + " && rmdir " + remote) == "",
                        "Owned observer staging cleanup failed")
            except Exception as cleanup_error:
                proof["cleanupError"] = str(cleanup_error)[:1000]
                if primary_error is None:
                    raise
    proof["controlsBeforeWrite"] = validate_controls(read("empty-controls-before-write", controls_command(root)), 4)
    proof["statsBeforeWrite"] = parse_cpu_observation(read("empty-stats-before-write", stats_command(root)), root)
    return proof


def after_write(read, proof, root):
    proof["controlsAfterWrite"] = validate_controls(read("empty-controls-after-write", controls_command(root)), 16)
    proof["statsAfterWrite"] = parse_cpu_observation(read("empty-stats-after-write", stats_command(root)), root)


def validate_proof(proof, observed, report_directory, root, image):
    require(type(proof["schemaVersion"]) is int and proof["schemaVersion"] == 1
            and "cleanupError" not in proof and proof["enabledEventPreserved"] == BPF_EVENT
            and proof["bpfProducerOwnerEstablished"] is False
            and image.get("installedKernelSha256") == KERNEL_SHA256
            and image.get("installedKernelBytes") == KERNEL_BYTES
            and proof["kernelConfigGzipSha256"] == CONFIG_GZIP_SHA256,
            "Missing exact kernel/config/BPF-preservation contract")
    builder = build_module()
    require(proof["observerBuild"] == builder.validate_build(report_directory / "empty-buffer-observer",
                                                            source_path=Path(__file__).with_name("android-ftrace-observer.c")),
            "Retained observer build differs from executed proof")
    _, _, binary = staged_paths(proof)
    require(observed["kernel-config-digest"] == CONFIG_GZIP_SHA256 + "  /proc/config.gz"
            and observed["observer-digest"] == proof["observerBuild"]["binarySha256"] + "  " + binary,
            "Raw kernel config or observer digest differs")
    for name in ("snapshot-not-compiled", "observer-create", "observer-mode", "observer-cleanup"):
        require(observed[name] == "", "Unexpected output from observer staging probe")
    require(parse_observer(observed["observer-scan"]) == proof["observerResult"], "Raw descriptor/barrier proof differs")
    for suffix, size, field in (("before-write", 4, "BeforeWrite"), ("after-write", 16, "AfterWrite")):
        require(validate_controls(observed["empty-controls-" + suffix], size) == proof["controls" + field]
                and parse_cpu_observation(observed["empty-stats-" + suffix], root) == proof["stats" + field],
                "Raw empty-buffer controls/counters differ")
