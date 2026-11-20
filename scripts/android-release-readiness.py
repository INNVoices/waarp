#!/usr/bin/env python3
"""Check an exported Android release-evidence bundle; never build, sign or publish.

This is an offline consistency check, not an attestation of CI authorship. Use a
trusted export of one successful main-branch workflow run and its artifacts.
See docs/ANDROID_RELEASE_EVIDENCE.md for the bundle format and trust boundary.
"""
from __future__ import annotations

import argparse
from datetime import datetime
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parent.parent
REPOSITORY = "INNVoices/waarp"
APP = "local.waarp.android"
ABIS = {"arm64-v8a", "armeabi-v7a", "x86_64"}
MATRIX = {("journeys", 29, 4096), ("journeys", 35, 4096),
          ("journeys", 36, 16384), ("soak", 36, 16384)}
SCENARIOS = {
    "journeys": ("ReleaseAcceptanceTest", "realReleaseUiTunnelLifecycleAndProcessRestoration"),
    "soak": ("ReleaseSoakTest", "twoHoursEncryptedTrafficResourcesAndRecovery"),
}
JOBS = {"Build, unit, lint and APK integrity", "Optimized release 2h AWG2 soak / API 36 / 16KB"} | {
    f"{prefix} API {api} / {size}B" for prefix in ("Native VPN", "Optimized release")
    for api, size in ((29, 4096), (35, 4096), (36, 16384))}
ARCHIVE_JOBS = {"waarp-android-apks": "Build, unit, lint and APK integrity",
                "waarp-android-build-reports": "Build, unit, lint and APK integrity",
                "waarp-android-release-2h-soak": "Optimized release 2h AWG2 soak / API 36 / 16KB"} | {
    f"waarp-android-release-api-{api}-{size}-runtime": f"Optimized release API {api} / {size}B"
    for api, size in ((29, 4096), (35, 4096), (36, 16384))}
SIGN_FIELDS = {"unsignedSourceSha256", "payloadSha256", "payloadUnchangedBySigning", "signingIdentityRole"}
MAX_JSON = 4 * 1024 * 1024
SCOPE = ("Offline consistency of exported CI records, APK bytes and runtime evidence. "
         "CI record/artifact origin is trusted externally; this is not cryptographic provenance, "
         "a release authorization, a physical-device test or a historical upgrade test.")


def require(value, message):
    if not value:
        raise ValueError(message)


def module(filename):
    spec = importlib.util.spec_from_file_location(filename.replace("-", "_"), ROOT / "scripts" / filename)
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


def strict_pairs(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, f"Duplicate JSON key: {key}")
        result[key] = value
    return result


def reject_constant(value):
    raise ValueError(f"Non-finite JSON number: {value}")


def finite_float(value):
    parsed = float(value)
    require(math.isfinite(parsed), "Non-finite JSON number.")
    return parsed


def parse_json(text):
    return json.loads(text, object_pairs_hook=strict_pairs, parse_constant=reject_constant, parse_float=finite_float)


def read_json(path):
    require(path.is_file() and path.stat().st_size <= MAX_JSON, f"Missing/oversized JSON: {path.name}")
    return parse_json(path.read_text(encoding="utf-8"))


def same(left, right):
    # Python considers True == 1; identity reports must not do so.
    return json.dumps(left, sort_keys=True, allow_nan=False) == json.dumps(right, sort_keys=True, allow_nan=False)


def integer(value, name, minimum=0):
    require(type(value) is int and value >= minimum, f"Invalid integer: {name}")
    return value


def digest(value, length=64):
    return isinstance(value, str) and re.fullmatch(f"[0-9a-f]{{{length}}}", value) is not None


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def resolve_path(base, name, *, directory=False):
    require(isinstance(name, str) and name and "\\" not in name, "Evidence path must be a relative POSIX path.")
    relative = PurePosixPath(name)
    require(not relative.is_absolute() and ".." not in relative.parts, "Evidence path escapes its bundle.")
    current = base
    for part in relative.parts:
        current = current / part
        require(not current.is_symlink(), "Symlink evidence is not accepted.")
    require(current.resolve().is_relative_to(base.resolve()), "Evidence path escapes its bundle.")
    require(current.is_dir() if directory else current.is_file(), f"Missing evidence: {name}")
    return current


def scan_runtime(directory):
    # Existing proof validators consume JSON/JSONL directly. Reject ambiguous JSON
    # and escaping links before they read the original, unmodified evidence.
    for path in directory.rglob("*"):
        require(not path.is_symlink(), "Symlink runtime evidence is not accepted.")
        if path.is_file() and path.suffix in (".json", ".jsonl"):
            require(path.stat().st_size <= MAX_JSON, f"Oversized runtime evidence: {path.name}")
            if path.suffix == ".json":
                read_json(path)
            else:
                for line in path.read_text(encoding="utf-8").splitlines():
                    if line.strip():
                        parse_json(line)


def verify_checkout(commit):
    require(digest(commit, 40), "A full lowercase source commit SHA is required.")
    head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    require(head == commit, "Run the checker from the exact candidate source checkout.")
    paths = ["android", "scripts/android-*", ".github/workflows/android.yml", "test/userspace-awg",
             "src/shared/atlas-countries.json", "src/shared/atlas-world.json", "licenses/NATURAL-EARTH.txt"]
    clean = subprocess.run(["git", "diff", "--quiet", "HEAD", "--", *paths], cwd=ROOT, check=False)
    require(clean.returncode == 0, "Candidate Android source, verification scripts or workflow are modified.")
    others = subprocess.check_output(["git", "ls-files", "--others", "--exclude-standard", "--", *paths], cwd=ROOT, text=True)
    require(not others, "Untracked Android source/verification inputs are present; commit the candidate first.")
    tracked = subprocess.check_output(["git", "ls-tree", "-r", "--name-only", "HEAD", "--", "scripts"], cwd=ROOT, text=True).splitlines()
    require(all("scripts/" + name in tracked for name in ("android-release-readiness.py", "android-release-proof.py",
                "android-verify.py", "android-sign.py")), "Release verification helpers must exist at candidate HEAD.")


def timestamp(value):
    require(isinstance(value, str), "Missing artifact/job timestamp.")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    require(parsed.utcoffset() is not None, "Artifact/job timestamp lacks a timezone.")
    return parsed


def check_archives(base, entries, run, jobs):
    """Bind selected files to immutable Actions artifact bytes and the owning job.

    Raw API receipts are externally trusted inputs, not locally authenticated.
    The artifact API has no attempt field: the owning job's attempt and upload
    time window prevent accepting a prior attempt's artifact receipt.
    """
    require(type(entries) is list and len(entries) == len(ARCHIVE_JOBS), "Six original Actions artifact ZIPs and receipts are required.")
    owners, checked, identifiers = {}, [], set()
    job_by_name = {job["name"]: job for job in jobs["jobs"]}
    for entry in entries:
        receipt = read_json(resolve_path(base, entry["receipt"]))
        name = receipt["name"]
        require(name in ARCHIVE_JOBS and name not in owners, "Wrong/repeated Actions artifact name.")
        identifier = integer(receipt["id"], "artifact ID", 1)
        require(identifier not in identifiers, "Repeated immutable artifact ID.")
        identifiers.add(identifier)
        origin = receipt["workflow_run"]
        require(type(origin["id"]) is int and origin["id"] == run["id"] and origin["head_sha"] == run["head_sha"]
                and origin["head_branch"] == "main", "Artifact receipt belongs to a different source/run.")
        job = job_by_name[ARCHIVE_JOBS[name]]
        require(timestamp(job["started_at"]) <= timestamp(receipt["created_at"]) <= timestamp(job["completed_at"]),
                "Artifact was not uploaded during its required job in the selected run attempt.")
        archive_path = resolve_path(base, entry["zip"])
        archive_hash = sha256(archive_path)
        require(receipt["digest"] == "sha256:" + archive_hash, "Original artifact ZIP does not match the API receipt digest.")
        directory = resolve_path(base, entry["directory"], directory=True)
        require(not any(directory.is_relative_to(other) or other.is_relative_to(directory) for other in owners.values()),
                "Extracted artifact directories overlap.")
        members, total = set(), 0
        with zipfile.ZipFile(archive_path) as archive:
            require(len(archive.infolist()) <= 20000, "Too many artifact ZIP members.")
            seen = set()
            for item in archive.infolist():
                relative = PurePosixPath(item.filename)
                name_in_zip = item.filename.rstrip("/")
                require(name_in_zip and "\\" not in name_in_zip and not relative.is_absolute() and ".." not in relative.parts
                        and str(relative) == name_in_zip and name_in_zip not in seen,
                        "Unsafe or duplicate artifact ZIP member.")
                seen.add(name_in_zip)
                require(not stat.S_ISLNK(item.external_attr >> 16) and not (item.flag_bits & 1), "Symlink/encrypted ZIP members are not accepted.")
                if item.is_dir():
                    continue
                total += item.file_size
                require(item.file_size <= 1024 ** 3 and total <= 4 * 1024 ** 3, "Artifact ZIP exceeds the evidence size limit.")
                path = resolve_path(directory, name_in_zip)
                require(path.stat().st_size == item.file_size, "Extracted artifact file size differs from the original ZIP.")
                with archive.open(item) as stream:
                    archived_hash = hashlib.file_digest(stream, "sha256").hexdigest()
                require(archived_hash == sha256(path), "Extracted artifact bytes differ from the original ZIP.")
                members.add(name_in_zip)
        paths = list(directory.rglob("*"))
        require(not any(path.is_symlink() for path in paths), "Symlink extracted artifact is not accepted.")
        require(members == {path.relative_to(directory).as_posix() for path in paths if path.is_file()},
                "Extracted artifact inventory differs from the original ZIP.")
        owners[name] = directory
        checked.append({"name": name, "id": identifier, "sha256": archive_hash, "createdAt": receipt["created_at"]})
    return owners, checked


def owned_path(base, name, owner, *, directory=False):
    path = resolve_path(base, name, directory=directory)
    require(path.is_relative_to(owner), "Selected evidence is outside its required Actions artifact.")
    return path


def check_ci(run, jobs, commit):
    require(run["repository"]["full_name"] == run["head_repository"]["full_name"] == REPOSITORY,
            "CI repository does not match Waarp.")
    require(run["path"] == ".github/workflows/android.yml" and run["head_sha"] == commit,
            "CI workflow/source commit mismatch.")
    require(run["event"] in ("push", "workflow_dispatch") and run["head_branch"] == "main",
            "A successful main push/dispatch is required; PR checkout merge identity is not supported.")
    require(run["status"] == "completed" and run["conclusion"] == "success", "CI run did not succeed.")
    run_id = integer(run["id"], "CI run ID", 1)
    attempt = integer(run["run_attempt"], "CI attempt", 1)
    rows = jobs["jobs"]
    require(type(rows) is list and integer(jobs["total_count"], "job count") == len(rows) == len(JOBS),
            "Export all jobs from the selected run attempt; incomplete/extra jobs are not accepted.")
    require({row["name"] for row in rows} == JOBS and len({integer(row["id"], "job ID", 1) for row in rows}) == len(JOBS),
            "Required Android CI job matrix is missing or repeated.")
    for row in rows:
        require(type(row["run_id"]) is int and row["run_id"] == run_id
                and type(row["run_attempt"]) is int and row["run_attempt"] == attempt
                and row["head_sha"] == commit, "CI jobs mix runs, attempts or source commits.")
        require(row["status"] == "completed" and row["conclusion"] == "success", f"CI job did not succeed: {row['name']}")
    return {"runId": run_id, "runAttempt": attempt, "headSha": commit, "requiredJobs": sorted(JOBS)}


def check_native(report):
    pin = read_json(ROOT / "android/app/src/main/res/raw/engine_integrity.json")
    require(type(report["schemaVersion"]) is int and report["schemaVersion"] == 1
            and report["passed"] is True and report["bootstrap"] is False and report["installed"] is True,
            "A completed non-bootstrap native source build report is required.")
    require(report["sourceInputsSha256"] == pin["sourceBuild"]["inputsSha256"]
            and report["aarSha256"] == pin["sha256"]
            and report["classesJarSha256"] == pin["sourceBuild"]["classesJarSha256"],
            "Native source build report differs from the candidate's engine pin.")


def check_apks(base, entries, variant, verifier, payload_digest):
    require(type(entries) is list and len(entries) == 3 and {entry["abi"] for entry in entries} == ABIS,
            f"Exactly three distinct {variant} ABIs are required.")
    found, paths = {}, set()
    for entry in entries:
        apk = resolve_path(base, entry["apk"])
        require(apk not in paths, "One APK is listed more than once.")
        paths.add(apk)
        require(digest(entry["sha256"]) and sha256(apk) == entry["sha256"], f"APK file hash differs: {entry['abi']}")
        saved = read_json(resolve_path(base, entry["validation"]))
        fresh = verifier(apk, variant)  # Always invokes existing SDK/static/signature gates in the real CLI.
        stripped = {key: value for key, value in saved.items() if key != "checkedAtUtc" and key not in SIGN_FIELDS}
        require(same(stripped, {key: value for key, value in fresh.items() if key != "checkedAtUtc"}),
                f"Saved static report differs from actual APK validation: {entry['abi']}")
        require(fresh["abi"] == entry["abi"] and fresh["sha256"] == entry["sha256"]
                and fresh["variant"] == variant and fresh["applicationId"] == APP, "APK identity differs from its bundle entry.")
        if variant == "release-unsigned":
            require(not SIGN_FIELDS.intersection(saved), "Unsigned static report contains signing claims.")
        found[entry["abi"]] = {"report": fresh, "saved": saved, "payloadSha256": payload_digest(apk)}
    identities = {(item["report"]["applicationId"], item["report"]["versionName"], item["report"]["versionCode"])
                  for item in found.values()}
    require(len(identities) == 1, "The three APKs have different package/version identities.")
    gradle = (ROOT / "android/app/build.gradle.kts").read_text()
    version_names = re.findall(r'^\s*versionName\s*=\s*"([^"]+)"\s*$', gradle, re.M)
    version_codes = re.findall(r"^\s*versionCode\s*=\s*(\d+)\s*$", gradle, re.M)
    require(len(version_names) == len(version_codes) == 1
            and identities == {(APP, version_names[0], int(version_codes[0]))},
            "APK version does not match this candidate's Android source.")
    return found


def check_signing_report(report, unsigned, payload, role):
    require(report["unsignedSourceSha256"] == unsigned["sha256"] and report["payloadSha256"] == payload
            and report["payloadUnchangedBySigning"] is True and report["signingIdentityRole"] == role,
            "Signing report does not bind this exact unsigned APK and unchanged ZIP payload.")
    require(report["signed"] is True and report["signatureSchemes"]["v2"] is True
            and report["signatureSchemes"]["v3"] is True and digest(report["signerCertificateSha256"]),
            "Missing valid v2/v3 signing identity.")
    for field in ("schemaVersion", "applicationId", "versionName", "versionCode", "minSdk", "targetSdk", "abi",
                  "permissions", "engineVersion", "engineSourceCommit", "engineAarSha256", "engineSourceBuild",
                  "zipalign16k", "nativeLibraries"):
        require(same(report[field], unsigned[field]), f"Signed/unsigned identity differs: {field}")


def check_crashes(directory, run):
    native = read_json(directory / "native-crash-evidence.json")
    require(same(native, run["nativeCrashEvidence"]) and run["nativeCrashEvidenceAvailable"] is True
            and run["appCrashObserved"] is False, "Missing or conflicting crash evidence.")
    require(type(native["schemaVersion"]) is int and native["schemaVersion"] == 1 and native["package"] == APP
            and native["errors"] == [] and native["panicObserved"] is False,
            "Native crash evidence is incomplete or reports a panic.")
    require(all(native[field] is True for field in ("currentFileAvailable", "archiveEnumerationAvailable", "available", "passed")),
            "Native crash history was not available.")
    files = native["files"]
    require(type(files) is list and files and len({row["path"] for row in files}) == len(files)
            and any(row["path"] == "CrashReport-waarp-android.log" for row in files), "Missing/repeated current crash log.")
    require(integer(native["archiveCount"], "native archive count") <= 33
            and native["archiveCount"] == sum(row["path"].startswith("crash_reports/") for row in files),
            "Native archive counts disagree.")
    require(integer(native["bytes"], "native crash bytes") == sum(integer(row["bytes"], "native log bytes") for row in files)
            and native["bytes"] <= 2 * 1024 * 1024
            and all(row["panicObserved"] is False and digest(row["sha256"]) for row in files), "Invalid native crash records.")
    for name in ("native-crash-report.txt", "crash-buffer.txt"):
        path = directory / name
        require(path.is_file() and path.stat().st_size <= MAX_JSON, f"Missing/oversized crash evidence: {name}")
    text = (directory / "native-crash-report.txt").read_text()
    sections = re.findall(r"^--- (.+) ---$", text, re.M)
    require(sections == [row["path"] for row in files], "Native crash transcript sections do not match the collected log inventory.")
    require(not re.search(r"panic:|fatal error:|SIGSEGV|goroutine \d+ \[", text), "Native crash text contains a runtime failure.")
    text = (directory / "crash-buffer.txt").read_text()
    require(not re.search(r'(?:Process:|Cmdline:)\s*local\.waarp\.android(?:,|\s|$)|>>>\s*local\.waarp\.android\s*<<<', text),
            "Android crash buffer contains a target crash.")


def check_runtime(directory, entry, unsigned, payload, proof_validator, parser):
    scan_runtime(directory)
    run, installed = read_json(directory / "result.json"), read_json(directory / "installed-apk.json")
    require(type(run["schemaVersion"]) is int and run["schemaVersion"] == 1 and run["mode"] == entry["mode"],
            "Wrong runtime report schema/mode.")
    require(same(installed, run["installedApk"]), "installed-apk.json and result.json disagree.")
    require(installed["variant"] == "release-ci", "Runtime must exercise the disposable CI-signed optimized release.")
    check_signing_report(installed, unsigned, payload, "disposable-ci-test-only")
    device = run["device"]
    require(device["sdk"] == str(entry["api"]) and device["abi"] == "x86_64"
            and type(device["pageSize"]) is int and device["pageSize"] == entry["pageSize"], "Wrong runtime API/ABI/page size.")
    require(run["passedGate"] is True and run["timedOut"] is False, "Runtime gate failed or timed out.")
    transcript = directory / "instrumentation.txt"
    require(transcript.is_file() and transcript.stat().st_size <= MAX_JSON, "Missing/oversized instrumentation transcript.")
    parsed = parser(transcript.read_text(), 0, False)
    require(parsed["passedGate"] is True and parsed["tests"] == parsed["expectedTests"] == parsed["passed"] == 1,
            "Raw instrumentation does not prove exactly one completed scenario.")
    expected_class, expected_method = SCENARIOS[entry["mode"]]
    require(parsed["cases"][0]["class"] == "local.waarp.android.acceptance." + expected_class
            and parsed["cases"][0]["name"] == expected_method, "Wrong release instrumentation scenario.")
    require(all(same(run[key], value) for key, value in parsed.items()), "Recorded instrumentation disagrees with its raw transcript.")
    wall = run["wallSeconds"]
    require(type(wall) in (int, float) and math.isfinite(wall) and wall > 0, "Invalid runtime wall-clock duration.")
    integer(run["requestedIntervalSeconds"], "runtime interval", 1)
    if entry["mode"] == "soak":
        duration = integer(run["requestedDurationSeconds"], "soak duration")
        require(7200 <= duration <= 10800 and wall >= duration and 10 <= run["requestedIntervalSeconds"] <= 30,
                "The full two-hour soak was not completed.")
    else:
        require(run["requestedDurationSeconds"] is None, "Journeys report unexpectedly declares a soak duration.")
    launches = run["coldActivityLaunchMs"]
    require(type(launches) is list and len(launches) == 3 and type(run["coldLaunchUpperBoundMs"]) is int
            and run["coldLaunchUpperBoundMs"] == 10000
            and all(type(value) is int and 0 < value <= 10000 for value in launches), "Three bounded cold launches were not recorded.")
    require(not any(key.endswith("Error") for key in run), "Runtime report retains a collection/acceptance error.")
    check_crashes(directory, run)
    # Re-run real raw traffic, resources, image, ftrace, frames and peer reconciliation.
    # An existing reconciled-proof.json or passed flag cannot replace this call.
    proof = proof_validator(directory)
    require(proof["passed"] is True and proof["mode"] == entry["mode"]
            and run["deviceEvidence"]["summarySha256"] == proof["summarySha256"], "Raw runtime summary binding differs.")
    return {"mode": entry["mode"], "api": entry["api"], "pageSize": entry["pageSize"],
            "resultSha256": sha256(directory / "result.json"), "summarySha256": proof["summarySha256"],
            "unsignedSourceSha256": unsigned["sha256"], "payloadSha256": payload}


def check_bundle(manifest_path, commit, *, require_signed=False):
    verify_checkout(commit)
    require(not manifest_path.is_symlink(), "Symlink manifest is not accepted.")
    base = manifest_path.resolve().parent
    manifest = read_json(manifest_path)
    require(type(manifest["schemaVersion"]) is int and manifest["schemaVersion"] == 1
            and manifest["sourceCommit"] == commit, "Bundle schema/source commit mismatch.")
    run, jobs = read_json(resolve_path(base, manifest["workflowRun"])), read_json(resolve_path(base, manifest["workflowJobs"]))
    ci = check_ci(run, jobs, commit)
    owners, archives = check_archives(base, manifest["archives"], run, jobs)
    check_native(read_json(owned_path(base, manifest["nativeBuildReport"], owners["waarp-android-build-reports"])))
    metadata = read_json(owned_path(base, manifest["artifacts"], owners["waarp-android-apks"]))
    require(type(metadata["schemaVersion"]) is int and metadata["schemaVersion"] == 2, "Unsupported APK artifact index.")
    verifier, signer = module("android-verify.py"), module("android-sign.py")
    for entry in manifest["unsigned"]:
        owned_path(base, entry["apk"], owners["waarp-android-apks"])
        owned_path(base, entry["validation"], owners["waarp-android-apks"])
    unsigned = check_apks(base, manifest["unsigned"], "release-unsigned", verifier.verify, signer.payload_digest)
    indexed = [row for row in metadata["artifacts"] if row["variant"] == "release-unsigned"]
    require(len(indexed) == 3 and {row["abi"] for row in indexed} == ABIS, "Artifact index must list exactly three unsigned release ABIs.")
    for row in indexed:
        actual = unsigned[row["abi"]]["report"]
        require(row["file"] == actual["artifact"] and row["packageId"] == APP
                and same(row["versionCode"], actual["versionCode"]) and row["versionName"] == actual["versionName"],
                "Artifact index and actual unsigned APK differ.")
    entries = manifest["runtime"]
    require(type(entries) is list and len(entries) == len(MATRIX), "All three release journeys and the two-hour soak are required.")
    for entry in entries:
        integer(entry["api"], "runtime API", 1); integer(entry["pageSize"], "runtime page size", 1)
    require({(entry["mode"], entry["api"], entry["pageSize"]) for entry in entries} == MATRIX, "Incomplete/repeated runtime matrix.")
    directories = [owned_path(base, entry["directory"], owners["waarp-android-release-2h-soak" if entry["mode"] == "soak"
                              else f"waarp-android-release-api-{entry['api']}-{entry['pageSize']}-runtime"], directory=True) for entry in entries]
    require(len(set(directories)) == len(MATRIX), "Runtime directories cannot be reused for different gates.")
    proof, instrumentation = module("android-release-proof.py"), module("android-instrument.py")
    x86 = unsigned["x86_64"]
    runtime = [check_runtime(directory, entry, x86["report"], x86["payloadSha256"], proof.validate, instrumentation.parse_instrumentation)
               for directory, entry in zip(directories, entries)]
    require(len({row["resultSha256"] for row in runtime}) == len(MATRIX), "Runtime result files are duplicated.")
    signed_entries = manifest.get("signed")
    require(not require_signed or signed_entries is not None, "Production-signed APKs are required for this check.")
    signed = None
    if signed_entries is not None:
        signed = check_apks(base, signed_entries, "release", verifier.verify, signer.payload_digest)
        for abi, item in signed.items():
            require(item["payloadSha256"] == unsigned[abi]["payloadSha256"], "Production signing changed the tested payload.")
            check_signing_report(item["saved"], unsigned[abi]["report"], unsigned[abi]["payloadSha256"], "retained-release")
    return {"schemaVersion": 1, "passed": True, "stage": "signed-evidence-consistent" if signed else "ready-for-signing-review",
            "sourceCommit": commit, "workflow": ci, "archives": archives, "runtime": runtime,
            "unsigned": {abi: {"sha256": item["report"]["sha256"], "payloadSha256": item["payloadSha256"]} for abi, item in unsigned.items()},
            "signed": {abi: item["report"]["sha256"] for abi, item in signed.items()} if signed else None,
            "cryptographicCiProvenanceVerified": False, "scope": SCOPE}


def write_report(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as stream:
        temporary = Path(stream.name)
        json.dump(value, stream, indent=2, allow_nan=False)
        stream.write("\n")
    try:
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def main(arguments=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--source-commit", required=True, help="Exact candidate HEAD (full SHA); never the engine source commit")
    parser.add_argument("--report", type=Path, required=True, help="Output JSON outside the evidence bundle")
    parser.add_argument("--require-signed", action="store_true", help="Also require all three retained-key production APKs and signing reports")
    options = parser.parse_args(arguments)
    report = options.report.absolute()
    require(not report.is_symlink() and report.suffix == ".json"
            and not report.resolve().is_relative_to(options.manifest.resolve().parent), "Report must be a JSON file outside the evidence bundle.")
    failed = {"schemaVersion": 1, "passed": False, "sourceCommit": options.source_commit,
              "cryptographicCiProvenanceVerified": False, "scope": SCOPE}
    # Replace an old success before validation: interruption/error cannot leave it as the latest result.
    write_report(report, {**failed, "blocker": "Validation has not completed."})
    try:
        result = check_bundle(options.manifest, options.source_commit, require_signed=options.require_signed)
    except Exception as error:
        write_report(report, {**failed, "blocker": f"{type(error).__name__}: {error}"})
        print(f"Release evidence rejected: {error}", file=sys.stderr)
        return 1
    write_report(report, result)
    print(f"PASS {result['stage']}: {options.source_commit}; {SCOPE}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
