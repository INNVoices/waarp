#!/usr/bin/env python3
"""Independently reconcile release UI evidence, raw observations and the AWG peer."""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent.parent
APP = "local.waarp.android"
PROBE = "local.waarp.android.acceptance"
METRICS = ("fds", "threads", "pssKb", "rssKb", "javaHeapAllocatedKb", "nativeHeapAllocatedKb")
ABSOLUTE = dict(zip(METRICS, (512, 160, 786432, 1572864, 131072, 262144)))
GROWTH = dict(zip(METRICS, (64, 32, 131072, 196608, 32768, 98304)))
TERMINAL = dict(zip(METRICS, (16, 16, 65536, 98304, 16384, 49152)))


def require(value, message):
    if not value:
        raise ValueError(message)


def one(directory, name):
    found = list(directory.rglob(name))
    require(len(found) == 1 and found[0].is_file(), f"Expected one fresh evidence file: {name}")
    require(found[0].stat().st_size <= 4 * 1024 * 1024, f"Oversized evidence: {name}")
    return found[0]


def integer(value, name, minimum=0):
    require(type(value) is int and value >= minimum, f"Invalid observation: {name}")
    return value


def true_fields(value, fields):
    for field in fields:
        require(value.get(field) is True, f"Required observed fact is absent: {field}")


def read_rows(directory, name):
    rows = [json.loads(line) for line in one(directory, name).read_text().splitlines() if line.strip()]
    require(0 < len(rows) <= 2000, f"Missing or oversized observation series: {name}")
    return rows


def median(rows, metric):
    return sorted(row[metric] for row in rows)[len(rows) // 2]


def validate_explicit_off(rows, observed):
    true_fields(observed, ("noProcessRestart", "vpnAbsent", "innerReplyBlocked"))
    integer(observed["oldPid"], "PID killed after OFF", 2)
    killed = integer(observed["killedAtElapsedMs"], "OFF process kill timestamp")
    require(observed["targetRelaunchedByTestBeforeObservationEnds"] is False,
            "The test relaunched the target while observing explicit OFF.")
    require(len(rows) >= 2, "Missing real observations after explicit OFF and SIGKILL.")
    previous = None
    for row in rows:
        at = integer(row["elapsedRealtimeMs"], "OFF observation timestamp")
        require(type(row["pid"]) is int and row["pid"] == -1 and row["vpnActive"] is False,
                "A target process or VPN reappeared after explicit OFF.")
        if previous is not None:
            require(0 < at - previous <= 5000, "Repeated OFF observation or an unobserved gap longer than five seconds.")
        previous = at
    first, last = rows[0]["elapsedRealtimeMs"], rows[-1]["elapsedRealtimeMs"]
    require(0 <= first - killed <= 5000 and last - first >= 90000,
            "Explicit OFF was not observed for ninety real seconds after actual process death.")
    require(observed["firstAbsentElapsedMs"] == first and observed["lastAbsentElapsedMs"] == last
            and observed["observationSpanMs"] == last - first and observed["sampleCount"] == len(rows),
            "Explicit OFF summary and raw observations disagree.")


def validate_device(directory, mode, installed, duration=7200, interval=15):
    evidence = directory / "app-evidence"
    kind = "smoke" if mode == "journeys" else "soak"
    source = one(evidence, f"release-{kind}.json")
    summary = json.loads(source.read_text())
    require(summary["schemaVersion"] == 1 and summary["mode"] == kind, "Wrong release evidence schema/mode.")
    true_fields(summary, ("passed", "independentUid"))
    require(summary["targetPackage"] == APP and summary["probePackage"] == PROBE and summary["targetDebuggable"] is False,
            "The device did not exercise the real non-debuggable release package.")
    require(summary["targetVersion"] == installed["versionName"] and summary["targetVersionCode"] == installed["versionCode"],
            "Device and installed release versions differ.")
    require(integer(summary["targetUid"], "target UID", 10000) != integer(summary["probeUid"], "probe UID", 10000),
            "Traffic must originate from an independent UID.")
    observer = summary["observer"]
    true_fields(observer, ("disposableEmulator", "rootAvailable", "requiredProcMetrics"))
    require(str(observer["observerUid"]) == "0" and observer["rootTransport"] in ("uiautomation", "userdebug-su"),
            "Real process resource observation was not available.")
    traffic = read_rows(evidence, f"release-{kind}-traffic.jsonl")
    require(summary["successfulRounds"] == len(traffic), "Summary and raw traffic counts disagree.")
    previous_sequence, previous_elapsed = -1, -1
    for row in traffic:
        true_fields(row, ("passed", "vpn"))
        require(integer(row["sequence"], "traffic sequence") > previous_sequence, "Repeated traffic sequence.")
        require(integer(row["elapsedRealtimeMs"], "traffic timestamp") > previous_elapsed, "Traffic timestamps do not advance.")
        previous_sequence, previous_elapsed = row["sequence"], row["elapsedRealtimeMs"]
        integer(row["httpBytes"], "validated HTTP bytes", 65536)
        integer(row["dnsBytes"], "validated DNS bytes", 1)
        for name in ("dnsMs", "httpMs", "totalMs", "unixMs"):
            integer(row[name], name)
    require(summary["httpBytes"] == sum(row["httpBytes"] for row in traffic), "HTTP byte totals disagree.")
    require(summary["firstTrafficElapsedMs"] == traffic[0]["elapsedRealtimeMs"] and
            summary["lastTrafficElapsedMs"] == traffic[-1]["elapsedRealtimeMs"] and
            summary["trafficSpanMs"] == traffic[-1]["elapsedRealtimeMs"] - traffic[0]["elapsedRealtimeMs"],
            "The traffic span is not supported by actual requests.")
    events = {event["name"]: event["facts"] for event in summary["events"]}
    require(len(events) == len(summary["events"]), "Repeated lifecycle events.")
    true_fields(events["setup"], ("uiImport", "selectedAppRoute", "systemDnsExplicitAwg", "vpnConsent"))
    require(events["setup"]["lanDirect"] is False, "The fixture's private inner route was not enabled.")
    true_fields(events["cleanup"], ("vpnAbsent",))
    if kind == "smoke":
        require(len(traffic) >= 5 and summary["minifiedReleaseBlackBox"] is True, "Incomplete real release journeys.")
        true_fields(events["off"], ("vpnAbsent", "innerReplyBlocked"))
        true_fields(events["onAgain"], ("encryptedDnsAndHttp",))
        true_fields(events["edit"], ("renamedThroughUi", "trafficAfterEdit"))
        true_fields(events["background"], ("targetNotForeground", "encryptedDnsAndHttp"))
        restored = events["processRestoration"]
        true_fields(restored, ("newPidObserved", "encryptedDnsAndHttp"))
        require(integer(restored["oldPid"], "original PID", 2) != integer(restored["newPid"], "restored PID", 2)
                and restored["targetRelaunchedByTestBeforeRecovery"] is False and 0 < restored["recoveryMs"] <= 90000,
                "SIGKILL was not followed by bounded independent service restoration.")
        true_fields(events["persistedState"], ("renamedProfileRestored", "selectedRouteRestored"))
        true_fields(events["deleteAssignedProfile"], ("blockedUi", "explicitNoReassignment", "innerReplyBlocked"))
        true_fields(events["cleanup"], ("routeDeletedThroughUi",))
        validate_explicit_off(read_rows(evidence, "release-smoke-off-observations.jsonl"), events["explicitOffRemainsStopped"])
        require(len(summary["resourceSamples"]) == 2, "Missing before/after real process snapshots.")
        for sample in summary["resourceSamples"]:
            true_fields(sample, ("procAvailable",))
            for metric in METRICS:
                integer(sample[metric], metric)
        screenshots = ("01-release-connected.png", "02-release-restored.png", "03-release-blocked-after-delete.png", "04-release-finished-off.png")
    else:
        require(7200 <= duration <= 10800 and 10 <= interval <= 30 and summary["requestedDurationSeconds"] == duration
                and summary["intervalSeconds"] == interval and summary["warmupSeconds"] == 300, "The full soak parameters differ.")
        required = int(duration / interval * .9)
        require(summary["requiredSuccessfulRounds"] == required and len(traffic) >= required, "Insufficient real encrypted exchanges.")
        require(summary["normalTrafficFailures"] == 0, "A normal traffic interval failed.")
        start = summary["steadyStartedElapsedMs"]
        require(start in {row["elapsedRealtimeMs"] for row in traffic} and
                summary["steadyElapsedMs"] == traffic[-1]["elapsedRealtimeMs"] - start >= duration * 1000,
                "The requested two-hour period was not bounded by successful encrypted requests.")
        true_fields(summary, ("screenOffRecovery", "dozeRecovery", "physicalNetworkRecovery"))
        true_fields(events["screenOff"], ("screenOffObserved", "recoveryTraffic", "targetBackground"))
        require(events["screenOff"]["successfulRoundsWhileOff"] >= 3, "Missing screen-off exchanges.")
        true_fields(events["doze"], ("dozeObserved", "unforcedObserved", "recoveryTraffic"))
        require(events["doze"]["stateDuring"] == "IDLE" and events["doze"]["attemptedRounds"] == 2, "Deep Doze was not observed.")
        true_fields(events["physicalNetwork"], ("networkLossObserved", "innerReplyBlocked", "restored", "recoveryTraffic"))
        true_fields(events["cleanup"], ("innerReplyBlocked",))
        resources = read_rows(evidence, "release-soak-resources.jsonl")
        steady = [row for row in resources if row["afterWarmup"] is True]
        require(len(resources) >= 60 and len(steady) >= 55, "Insufficient real resource samples.")
        require(len({row["pid"] for row in resources}) == 1, "Unexpected production process restart during the soak.")
        previous_elapsed = -1
        for row in resources:
            true_fields(row, ("procAvailable",))
            require(integer(row["elapsedRealtimeMs"], "resource timestamp") > previous_elapsed, "Resource timestamps do not advance.")
            previous_elapsed = row["elapsedRealtimeMs"]
            require(row["afterWarmup"] == (row["elapsedRealtimeMs"] - start >= 300000), "Invalid warmup exclusion.")
            for metric in METRICS:
                require(integer(row[metric], metric) <= ABSOLUTE[metric], f"Absolute resource budget exceeded: {metric}")
        baseline = {metric: median(steady[:5], metric) for metric in METRICS}
        terminal = {metric: median(steady[-5:], metric) for metric in METRICS}
        peaks = {metric: max(row[metric] for row in resources) for metric in METRICS}
        for metric in METRICS:
            require(all(row[metric] <= baseline[metric] + GROWTH[metric] for row in steady[4:]), f"Resource growth: {metric}")
            require(terminal[metric] <= baseline[metric] + TERMINAL[metric], f"Terminal resource growth: {metric}")
        claimed = summary["resources"]
        true_fields(claimed, ("passed", "procAvailable"))
        require(claimed["sampleCount"] == len(resources) and claimed["postWarmupSampleCount"] == len(steady)
                and claimed["processCount"] == 1 and claimed["processIds"] == [resources[0]["pid"]], "Resource counts disagree.")
        for field, expected in (("baselineMedian", baseline), ("terminalMedian", terminal), ("peaks", peaks),
                                ("absoluteCaps", ABSOLUTE), ("sampleGrowthCaps", GROWTH), ("terminalGrowthCaps", TERMINAL)):
            require(claimed[field] == expected, f"Raw observations or predetermined budgets disagree: {field}")
        screenshots = ("01-release-connected.png", "02-release-soak-finished-connected.png")
    for filename in screenshots:
        require(one(evidence, filename).read_bytes()[:8] == b"\x89PNG\r\n\x1a\n", "Missing actual UI screenshot.")
    return {"summary": summary, "summarySha256": hashlib.sha256(source.read_bytes()).hexdigest(),
            "rawTrafficRows": len(traffic), "screenshots": list(screenshots), "passed": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, required=True)
    options = parser.parse_args()
    directory = options.directory.resolve()
    run = json.loads((directory / "result.json").read_text())
    require(run["passedGate"] is True and run["tests"] == run["passed"] == 1 and run["failed"] == run["skipped"] == 0,
            "The release instrumentation did not pass exactly one complete scenario.")
    checked = validate_device(directory, run["mode"], run["installedApk"], run.get("requestedDurationSeconds") or 7200,
                              run["requestedIntervalSeconds"])
    spec = importlib.util.spec_from_file_location("awg_proof_reader", ROOT / "scripts/android-awg-control.py")
    peer = importlib.util.module_from_spec(spec); spec.loader.exec_module(peer)
    proof = peer.read_proof(directory / "awg-proof.json")
    true_fields(proof, ("passed", "stopped", "http_server_started"))
    summary = checked["summary"]
    require(proof["encrypted_dns_unique_queries"] >= summary["successfulRounds"] and
            proof["encrypted_http_unique_requests"] >= summary["successfulRounds"] and
            proof["encrypted_http_bytes"] >= summary["httpBytes"], "Independent encrypted peer counters do not corroborate device traffic.")
    host_span = proof["last_encrypted_request_unix_ms"] - proof["first_encrypted_request_unix_ms"]
    if run["mode"] == "soak":
        require(host_span >= run["requestedDurationSeconds"] * 1000, "The peer did not observe two actual hours of encrypted traffic.")
    result = {"schemaVersion": 1, "passed": True, "mode": run["mode"], "summarySha256": checked["summarySha256"],
              "deviceRounds": summary["successfulRounds"], "deviceHttpBytes": summary["httpBytes"],
              "hostTrafficSpanMs": host_span, "hostProof": proof}
    (directory / "reconciled-proof.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({key: value for key, value in result.items() if key != "hostProof"}))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, TypeError) as error:
        print(f"Release evidence rejected: {error}", file=sys.stderr)
        raise SystemExit(1)
