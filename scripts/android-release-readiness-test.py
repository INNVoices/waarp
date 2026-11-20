#!/usr/bin/env python3
"""Offline binding regression tests; no SDK, emulator, key or network is used.

Tiny real ZIPs exercise byte/payload hashes. Only the SDK APK-validation seam and
the large raw-device fixture are substituted in integration fixtures. The actual
instrumentation parser and payload digest run, and a negative case invokes the
real raw-proof validator. Existing foreground/ftrace tests cover those validators.
"""
from __future__ import annotations

import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import subprocess
import stat
import warnings
import unittest
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("readiness", ROOT / "scripts/android-release-readiness.py")
CHECK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECK)
REAL_CHECKOUT = CHECK.verify_checkout
VERIFY, SIGN, PROOF, INSTRUMENT = (CHECK.module(name) for name in
    ("android-verify.py", "android-sign.py", "android-release-proof.py", "android-instrument.py"))
COMMIT = "a" * 40
CERT = json.loads((ROOT / "android/release-signing.json").read_text())["signerCertificateSha256"]


class BundleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.bundle = self.root / "bundle"
        self.bundle.mkdir()
        self.manifest_path = self.bundle / "manifest.json"
        self.report_path = self.root / "readiness.json"
        self.fresh = {}
        self.manifest = {"schemaVersion": 1, "sourceCommit": COMMIT, "workflowRun": "ci/run.json",
                         "workflowJobs": "ci/jobs.json", "nativeBuildReport": "native/build-report.json",
                         "artifacts": "apks/artifacts.json", "unsigned": [], "runtime": []}
        run = {"id": 123, "run_attempt": 2, "repository": {"full_name": CHECK.REPOSITORY},
               "head_repository": {"full_name": CHECK.REPOSITORY}, "path": ".github/workflows/android.yml",
               "event": "workflow_dispatch", "head_branch": "main", "head_sha": COMMIT,
               "status": "completed", "conclusion": "success"}
        jobs = {"total_count": len(CHECK.JOBS), "jobs": [
            {"id": index + 1, "name": name, "run_id": 123, "run_attempt": 2, "head_sha": COMMIT,
             "status": "completed", "conclusion": "success", "started_at": "2026-11-20T10:00:00Z",
             "completed_at": "2026-11-20T14:00:00Z"} for index, name in enumerate(sorted(CHECK.JOBS))]}
        self.write("ci/run.json", run); self.write("ci/jobs.json", jobs)
        pin = json.loads((ROOT / "android/app/src/main/res/raw/engine_integrity.json").read_text())
        self.write("native/build-report.json", {"schemaVersion": 1, "passed": True, "bootstrap": False,
                   "installed": True, "aarSha256": pin["sha256"], "sourceInputsSha256": pin["sourceBuild"]["inputsSha256"],
                   "classesJarSha256": pin["sourceBuild"]["classesJarSha256"]})
        metadata = {"schemaVersion": 2, "artifacts": []}
        for abi in sorted(CHECK.ABIS):
            path = self.bundle / f"apks/{abi}-release-unsigned.apk"
            path.parent.mkdir(exist_ok=True)
            with zipfile.ZipFile(path, "w") as archive:
                archive.writestr("classes.dex", f"fixture {abi}")
                archive.writestr("assets/example", "same version is not same payload")
            static = {"schemaVersion": 1, "checkedAtUtc": "fixture", "artifact": path.name,
                      "sha256": CHECK.sha256(path), "bytes": path.stat().st_size, "variant": "release-unsigned",
                      "applicationId": CHECK.APP, "versionCode": 7, "versionName": "1.0.0", "minSdk": 29, "targetSdk": 36,
                      "abi": abi, "signed": False, "signerCertificateSha256": None, "permissions": [],
                      "signatureSchemes": {"v2": False, "v3": False}, "engineVersion": "fixture",
                      "engineSourceCommit": "b" * 40, "engineAarSha256": pin["sha256"], "engineSourceBuild": pin["sourceBuild"],
                      "zipalign16k": True, "nativeLibraries": [], "scope": "Static SDK fixture boundary"}
            self.fresh[path] = static
            entry = {"abi": abi, "apk": str(path.relative_to(self.bundle)),
                     "validation": str(path.relative_to(self.bundle)) + ".validation.json", "sha256": static["sha256"]}
            self.manifest["unsigned"].append(entry)
            self.write(entry["validation"], static)
            metadata["artifacts"].append({"file": path.name, "abi": abi, "variant": "release-unsigned",
                                           "packageId": CHECK.APP, "versionName": "1.0.0", "versionCode": 7})
        self.write("apks/artifacts.json", metadata)
        unsigned_entry = next(item for item in self.manifest["unsigned"] if item["abi"] == "x86_64")
        unsigned = self.fresh[self.bundle / unsigned_entry["apk"]]
        payload = SIGN.payload_digest(self.bundle / unsigned_entry["apk"])
        for mode, api, size in sorted(CHECK.MATRIX):
            name = f"runtime/{mode}-{api}"
            entry = {"mode": mode, "api": api, "pageSize": size, "directory": name}
            self.manifest["runtime"].append(entry)
            installed = {**unsigned, "artifact": "waarp-ci-release.apk", "variant": "release-ci", "signed": True,
                         "sha256": "d" * 64, "signerCertificateSha256": "c" * 64,
                         "signatureSchemes": {"v2": True, "v3": True}, "unsignedSourceSha256": unsigned["sha256"],
                         "payloadSha256": payload, "payloadUnchangedBySigning": True, "signingIdentityRole": "disposable-ci-test-only"}
            self.write(f"{name}/installed-apk.json", installed)
            scenario, method = CHECK.SCENARIOS[mode]
            transcript = (f"INSTRUMENTATION_STATUS: class=local.waarp.android.acceptance.{scenario}\n"
                          f"INSTRUMENTATION_STATUS: test={method}\nINSTRUMENTATION_STATUS: numtests=1\n"
                          "INSTRUMENTATION_STATUS_CODE: 0\nINSTRUMENTATION_CODE: -1\n")
            (self.bundle / name / "instrumentation.txt").write_text(transcript)
            summary = {"mode": mode, "api": api, "fixtureOnly": True}
            self.write(f"{name}/app-evidence/summary.json", summary)
            summary_hash = CHECK.sha256(self.bundle / name / "app-evidence/summary.json")
            native = {"schemaVersion": 1, "package": CHECK.APP, "currentFileAvailable": True,
                      "archiveEnumerationAvailable": True, "archiveCount": 0, "errors": [], "bytes": 0,
                      "panicObserved": False, "available": True, "passed": True,
                      "files": [{"path": "CrashReport-waarp-android.log", "bytes": 0, "sha256": "e" * 64, "panicObserved": False}]}
            self.write(f"{name}/native-crash-evidence.json", native)
            (self.bundle / name / "native-crash-report.txt").write_text("--- CrashReport-waarp-android.log ---\n\n")
            (self.bundle / name / "crash-buffer.txt").write_text("")
            result = {"schemaVersion": 1, "mode": mode, "device": {"sdk": str(api), "abi": "x86_64", "pageSize": size},
                      "installedApk": installed, "wallSeconds": 7300 if mode == "soak" else 120,
                      "requestedDurationSeconds": 7200 if mode == "soak" else None, "requestedIntervalSeconds": 15,
                      "coldActivityLaunchMs": [80, 100, 90], "coldLaunchUpperBoundMs": 10000,
                      "nativeCrashEvidence": native, "nativeCrashEvidenceAvailable": True, "appCrashObserved": False,
                      "deviceEvidence": {"summarySha256": summary_hash}, **INSTRUMENT.parse_instrumentation(transcript, 0, False)}
            self.write(f"{name}/result.json", result)
        self.seal_archives()
        self.save_manifest()
        self.addCleanup(patch.stopall)
        patch.object(CHECK, "verify_checkout").start()
        modules = {"android-verify.py": VERIFY, "android-sign.py": SIGN,
                   "android-release-proof.py": PROOF, "android-instrument.py": INSTRUMENT}
        patch.object(CHECK, "module", side_effect=lambda name: modules[name]).start()
        self.sdk = patch.object(VERIFY, "verify", side_effect=self.sdk_fixture).start()
        self.raw = patch.object(PROOF, "validate", side_effect=self.raw_fixture).start()

    def write(self, name, value):
        path = self.bundle / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value, indent=2) + "\n")

    def edit(self, name, change):
        value = json.loads((self.bundle / name).read_text())
        change(value)
        self.write(name, value)

    def save_manifest(self):
        self.write("manifest.json", self.manifest)

    def seal_archives(self):
        """Fixture-only trusted API/archive boundary; mutations usually test inner gates.

        Archive tamper tests disable this step to preserve the original receipt.
        """
        roots = {"waarp-android-apks": "apks", "waarp-android-build-reports": "native"}
        for mode, api, size in CHECK.MATRIX:
            name = "waarp-android-release-2h-soak" if mode == "soak" else f"waarp-android-release-api-{api}-{size}-runtime"
            roots[name] = f"runtime/{mode}-{api}"
        self.manifest["archives"] = []
        for index, (name, directory) in enumerate(sorted(roots.items())):
            archive_path = self.bundle / f"archives/{name}.zip"
            archive_path.parent.mkdir(exist_ok=True)
            with zipfile.ZipFile(archive_path, "w") as archive:
                for path in sorted((self.bundle / directory).rglob("*")):
                    if path.is_file() and not path.is_symlink():
                        archive.write(path, path.relative_to(self.bundle / directory).as_posix())
            receipt_path = f"ci/{name}.json"
            self.write(receipt_path, {"id": index + 1000, "name": name, "digest": "sha256:" + CHECK.sha256(archive_path),
                       "created_at": "2026-11-20T13:00:00Z",
                       "workflow_run": {"id": 123, "head_sha": COMMIT, "head_branch": "main"}})
            self.manifest["archives"].append({"receipt": receipt_path, "zip": str(archive_path.relative_to(self.bundle)), "directory": directory})

    def sdk_fixture(self, path, variant):
        report = copy.deepcopy(self.fresh[path])
        self.assertEqual(report["variant"], variant)
        report.update(sha256=CHECK.sha256(path), bytes=path.stat().st_size, checkedAtUtc="rechecked")
        if variant == "release" and report["signerCertificateSha256"] != CERT:
            raise ValueError("Release APK is not signed by the retained update identity.")
        return report

    def raw_fixture(self, directory):
        run = json.loads((directory / "result.json").read_text())
        return {"passed": True, "mode": run["mode"],
                "summarySha256": CHECK.sha256(directory / "app-evidence/summary.json")}

    def check(self, *, seal=True, **kwargs):
        if seal:
            self.seal_archives()
        self.save_manifest()
        return CHECK.check_bundle(self.manifest_path, COMMIT, **kwargs)

    def rejected(self, pattern, **kwargs):
        with self.assertRaisesRegex((ValueError, KeyError, OSError), pattern):
            self.check(**kwargs)

    def runtime(self, mode="journeys", api=29):
        return next(row["directory"] for row in self.manifest["runtime"] if row["mode"] == mode and row["api"] == api)

    def add_signed(self):
        self.manifest["signed"] = []
        for entry in self.manifest["unsigned"]:
            source = self.bundle / entry["apk"]
            dest = self.bundle / "signed" / source.name.replace("release-unsigned", "release")
            dest.parent.mkdir(exist_ok=True)
            dest.write_bytes(source.read_bytes())
            # ZIP comment stands in for excluded signing-block bytes, without changing any entry payload.
            with zipfile.ZipFile(dest, "a") as archive:
                archive.comment = b"test-only signature seam"
            static = {**self.fresh[source], "artifact": dest.name, "sha256": CHECK.sha256(dest), "bytes": dest.stat().st_size,
                      "variant": "release", "signed": True, "signerCertificateSha256": CERT,
                      "signatureSchemes": {"v2": True, "v3": True}}
            self.fresh[dest] = static
            report = {**static, "unsignedSourceSha256": CHECK.sha256(source), "payloadSha256": SIGN.payload_digest(source),
                      "payloadUnchangedBySigning": True, "signingIdentityRole": "retained-release"}
            signed = {"abi": entry["abi"], "apk": str(dest.relative_to(self.bundle)),
                      "validation": str(dest.relative_to(self.bundle)) + ".validation.json", "sha256": static["sha256"]}
            self.manifest["signed"].append(signed)
            self.write(signed["validation"], report)

    def test_unsigned_bundle_rechecks_three_apks_and_four_raw_proofs(self):
        result = self.check()
        self.assertEqual(result["stage"], "ready-for-signing-review")
        self.assertFalse(result["cryptographicCiProvenanceVerified"])
        self.assertEqual(self.sdk.call_count, 3)
        self.assertEqual(self.raw.call_count, 4)

    def test_signed_bundle_checks_retained_identity_and_real_payload(self):
        self.add_signed()
        result = self.check(require_signed=True)
        self.assertEqual(result["stage"], "signed-evidence-consistent")
        self.assertEqual(self.sdk.call_count, 6)
        self.assertTrue(all(self.manifest["unsigned"][i]["sha256"] != self.manifest["signed"][i]["sha256"] for i in range(3)))

    def test_signed_requirement_cannot_downgrade_to_unsigned(self):
        self.rejected("Production-signed APKs", require_signed=True)

    def test_missing_or_duplicated_abi(self):
        self.manifest["unsigned"][2] = self.manifest["unsigned"][0]
        self.rejected("three distinct")

    def test_apk_bytes_are_hashed(self):
        with (self.bundle / self.manifest["unsigned"][0]["apk"]).open("ab") as stream:
            stream.write(b"tamper")
        self.rejected("APK file hash differs")

    def test_static_report_not_a_pass_flag(self):
        self.edit(self.manifest["unsigned"][0]["validation"], lambda value: value.update(zipalign16k=False))
        self.rejected("Saved static report differs")

    def test_runtime_same_version_wrong_unsigned_source(self):
        directory = self.runtime()
        self.edit(f"{directory}/installed-apk.json", lambda value: value.update(unsignedSourceSha256="f" * 64))
        installed = CHECK.read_json(self.bundle / directory / "installed-apk.json")
        self.edit(f"{directory}/result.json", lambda value: value.update(installedApk=installed))
        self.rejected("exact unsigned APK")

    def test_runtime_wrong_payload_and_disagreement(self):
        directory = self.runtime()
        self.edit(f"{directory}/installed-apk.json", lambda value: value.update(payloadSha256="f" * 64))
        self.rejected("installed-apk.json and result.json disagree")
        installed = CHECK.read_json(self.bundle / directory / "installed-apk.json")
        self.edit(f"{directory}/result.json", lambda value: value.update(installedApk=installed))
        self.rejected("exact unsigned APK")

    def test_runtime_wrong_variant_role_scheme_or_abi(self):
        directory = self.runtime()
        original = CHECK.read_json(self.bundle / directory / "installed-apk.json")
        for mutation in ({"variant": "debug"}, {"signingIdentityRole": "retained-release"}, {"abi": "arm64-v8a"},
                         {"signatureSchemes": {"v2": True, "v3": False}}, {"signed": False}):
            with self.subTest(mutation=mutation):
                installed = {**original, **mutation}
                self.write(f"{directory}/installed-apk.json", installed)
                self.edit(f"{directory}/result.json", lambda value: value.update(installedApk=installed))
                self.rejected("Runtime must|Signing report|signing identity|identity differs")

    def test_ci_failure_skipped_job_pr_or_wrong_commit(self):
        original = CHECK.read_json(self.bundle / "ci/run.json")
        for mutation in ({"conclusion": "failure"}, {"event": "pull_request"}, {"head_sha": "f" * 40},
                         {"head_branch": "release/candidate"}, {"repository": {"full_name": "someone/fork"}}):
            with self.subTest(mutation=mutation):
                self.write("ci/run.json", {**original, **mutation})
                self.rejected("CI|main push")
        self.write("ci/run.json", original)
        self.edit("ci/jobs.json", lambda value: value["jobs"][0].update(conclusion="skipped"))
        self.rejected("CI job did not succeed")

    def test_jobs_must_be_complete_unique_same_attempt(self):
        original = CHECK.read_json(self.bundle / "ci/jobs.json")
        for mutation in (lambda value: value.update(total_count=9), lambda value: value["jobs"].pop(),
                         lambda value: value["jobs"][0].update(run_attempt=1),
                         lambda value: value["jobs"][0].update(head_sha="f" * 40),
                         lambda value: value["jobs"][0].update(id=value["jobs"][1]["id"]),
                         lambda value: value["jobs"][0].update(name=value["jobs"][1]["name"])):
            value = copy.deepcopy(original); mutation(value); self.write("ci/jobs.json", value)
            self.rejected("jobs|job matrix")

    def test_runtime_matrix_missing_duplicate_or_reused_directory(self):
        original = copy.deepcopy(self.manifest["runtime"])
        self.manifest["runtime"].pop(); self.rejected("two-hour soak")
        self.manifest["runtime"] = copy.deepcopy(original)
        self.manifest["runtime"][0] = self.manifest["runtime"][1]; self.rejected("runtime matrix")
        self.manifest["runtime"] = copy.deepcopy(original)
        self.manifest["runtime"][0]["directory"] = self.manifest["runtime"][1]["directory"]
        self.rejected("outside its required Actions artifact|directories cannot be reused")

    def test_forged_pass_does_not_replace_raw_validator(self):
        self.raw.side_effect = ValueError("Raw peer/traffic evidence rejected")
        self.rejected("Raw peer/traffic evidence rejected")

    def test_real_raw_validator_rejects_missing_original_evidence(self):
        real = importlib.util.spec_from_file_location("unmocked_release_proof", ROOT / "scripts/android-release-proof.py")
        loaded = importlib.util.module_from_spec(real); real.loader.exec_module(loaded)
        self.raw.side_effect = loaded.validate
        self.rejected("ftrace preparation proof")

    def test_raw_instrumentation_failure_skip_wrong_method_or_truncation(self):
        directory = self.runtime()
        path = self.bundle / directory / "instrumentation.txt"
        original = path.read_text()
        for text in (original.replace("STATUS_CODE: 0", "STATUS_CODE: -2"),
                     original.replace("STATUS_CODE: 0", "STATUS_CODE: -3"),
                     original.replace("INSTRUMENTATION_CODE: -1", ""), original.replace(CHECK.SCENARIOS["journeys"][1], "differentTest")):
            path.write_text(text)
            self.rejected("Raw instrumentation|Wrong release instrumentation")

    def test_runtime_duration_crash_launch_and_wrong_image_fields(self):
        directory = self.runtime("soak", 36)
        name = f"{directory}/result.json"
        original = CHECK.read_json(self.bundle / name)
        for mutation in ({"wallSeconds": 7199}, {"requestedDurationSeconds": 7199}, {"requestedIntervalSeconds": 31},
                         {"coldActivityLaunchMs": [1, 0, 1]}, {"coldActivityLaunchMs": [1, 10001, 1]},
                         {"nativeCrashEvidenceAvailable": False}, {"appCrashObserved": True}, {"timedOut": True},
                         {"device": {"sdk": "36", "abi": "x86_64", "pageSize": 4096}}, {"startupError": "failed"}):
            with self.subTest(mutation=mutation):
                self.write(name, {**original, **mutation})
                self.rejected("soak|cold launches|crash evidence|timed out|page size|acceptance error")

    def test_raw_native_crash_cannot_hide_behind_pass(self):
        (self.bundle / self.runtime() / "native-crash-report.txt").write_text("--- CrashReport-waarp-android.log ---\npanic: hidden by a stale summary")
        self.rejected("Native crash text")

    def test_boolean_integer_nonfinite_and_duplicate_json_rejected(self):
        self.manifest["schemaVersion"] = True; self.rejected("schema")
        self.manifest["schemaVersion"] = 1
        self.edit("ci/jobs.json", lambda value: value["jobs"][0].update(run_attempt=True))
        self.rejected("mix runs")
        for text in ('{"x":1,"x":2}', '{"x":NaN}', '{"x":Infinity}', '{"x":1e999}'):
            with self.assertRaises(ValueError):
                CHECK.parse_json(text)

    def test_path_escape_and_symlink_rejected(self):
        original = self.manifest["workflowRun"]
        for path in ("../run.json", "/tmp/run.json", "ci\\run.json"):
            self.manifest["workflowRun"] = path; self.rejected("path")
        self.manifest["workflowRun"] = original
        (self.bundle / "runtime-link").symlink_to(self.bundle / self.runtime(), target_is_directory=True)
        self.manifest["runtime"][0]["directory"] = "runtime-link"; self.rejected("Symlink")

    def test_runtime_nested_symlink_duplicate_json_or_oversized_json_rejected(self):
        directory = self.bundle / self.runtime()
        bad = directory / "nested.json"
        bad.write_text('{"x":1,"x":2}'); self.rejected("Duplicate JSON key")
        bad.write_text(" " * (CHECK.MAX_JSON + 1)); self.rejected("Oversized")
        bad.unlink(); bad.symlink_to(self.bundle / "ci/run.json"); self.rejected("Symlink")

    def test_runtime_summary_hash_must_match_actual_reconciliation(self):
        self.edit(f"{self.runtime()}/app-evidence/summary.json", lambda value: value.update(corrupted=True))
        self.rejected("Raw runtime summary binding")

    def test_production_payload_mismatch_rejected_after_valid_static_report(self):
        self.add_signed()
        entry = self.manifest["signed"][0]; path = self.bundle / entry["apk"]
        with zipfile.ZipFile(path, "a") as archive:
            archive.writestr("assets/changed-after-test", "new bytes")
        self.fresh[path].update(sha256=CHECK.sha256(path), bytes=path.stat().st_size)
        entry["sha256"] = CHECK.sha256(path)
        self.edit(entry["validation"], lambda value: value.update(sha256=entry["sha256"], bytes=path.stat().st_size))
        self.rejected("Production signing changed")

    def test_production_retained_certificate_verifier_failure_propagates(self):
        self.add_signed()
        self.fresh[self.bundle / self.manifest["signed"][0]["apk"]]["signerCertificateSha256"] = "f" * 64
        self.rejected("retained update identity")

    def test_failure_replaces_a_stale_success_report(self):
        self.report_path.write_text('{"passed":true}')
        self.edit("ci/run.json", lambda value: value.update(conclusion="failure"))
        code = CHECK.main(["--manifest", str(self.manifest_path), "--source-commit", COMMIT, "--report", str(self.report_path)])
        self.assertEqual(code, 1)
        self.assertFalse(json.loads(self.report_path.read_text())["passed"])

    def test_source_checkout_guard_runs_before_artifact_validation(self):
        with patch.object(CHECK, "verify_checkout", side_effect=ValueError("wrong checkout")):
            self.rejected("wrong checkout")
        self.sdk.assert_not_called()

    def test_old_source_run_or_attempt_artifact_receipt_rejected(self):
        entry = self.manifest["archives"][0]
        original = CHECK.read_json(self.bundle / entry["receipt"])
        for mutation in ({"workflow_run": {"id": 122, "head_sha": COMMIT, "head_branch": "main"}},
                         {"workflow_run": {"id": 123, "head_sha": "f" * 40, "head_branch": "main"}},
                         {"created_at": "2026-11-19T13:00:00Z"}):
            self.write(entry["receipt"], {**original, **mutation})
            self.rejected("different source/run|selected run attempt", seal=False)

    def test_downloaded_archive_and_extracted_file_tampering(self):
        path = self.bundle / self.runtime() / "native-crash-report.txt"
        path.write_text("")
        self.rejected("file size differs", seal=False)
        self.seal_archives()
        archive = self.bundle / self.manifest["archives"][0]["zip"]
        with archive.open("ab") as stream:
            stream.write(b"changed original archive")
        self.rejected("API receipt digest", seal=False)

    def test_missing_extra_duplicate_artifact_receipts(self):
        original = copy.deepcopy(self.manifest["archives"])
        self.manifest["archives"].pop(); self.rejected("Six original", seal=False)
        self.manifest["archives"] = original
        self.manifest["archives"][1] = self.manifest["archives"][0]
        self.rejected("Wrong/repeated Actions artifact", seal=False)

    def test_extra_extracted_file_rejected_even_when_other_bytes_unchanged(self):
        (self.bundle / self.runtime() / "added.txt").write_text("extra")
        self.rejected("inventory differs", seal=False)

    def test_zip_traversal_member_rejected_with_matching_receipt_digest(self):
        entry = self.manifest["archives"][0]
        archive = self.bundle / entry["zip"]
        with zipfile.ZipFile(archive, "a") as stream:
            stream.writestr("../escaped", "bad")
        self.edit(entry["receipt"], lambda value: value.update(digest="sha256:" + CHECK.sha256(archive)))
        self.rejected("Unsafe or duplicate", seal=False)

    def test_artifact_ids_must_be_unique(self):
        entries = self.manifest["archives"]
        first = CHECK.read_json(self.bundle / entries[0]["receipt"])
        self.edit(entries[1]["receipt"], lambda value: value.update(id=first["id"]))
        self.rejected("Repeated immutable artifact ID", seal=False)

    def test_upload_window_uses_exact_owning_job(self):
        self.edit("ci/jobs.json", lambda value: next(row for row in value["jobs"] if row["name"] == "Build, unit, lint and APK integrity").update(completed_at="2026-11-20T12:00:00Z"))
        self.rejected("required job in the selected run attempt", seal=False)

    def test_same_size_extracted_corruption_is_rejected(self):
        path = self.bundle / self.runtime() / "native-crash-report.txt"
        path.write_bytes(b"x" * path.stat().st_size)
        self.rejected("bytes differ", seal=False)

    def test_malformed_zip_members_rejected_even_with_matching_digest(self):
        entry = self.manifest["archives"][0]
        archive = self.bundle / entry["zip"]
        original = archive.read_bytes()
        with zipfile.ZipFile(archive) as stream:
            existing = stream.infolist()[0].filename
        for filename, symlink in (("/absolute", False), ("./alias", False), ("link", True), (existing, False)):
            with self.subTest(filename=filename):
                archive.write_bytes(original)
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore", UserWarning)
                    with zipfile.ZipFile(archive, "a") as stream:
                        item = zipfile.ZipInfo(filename)
                        if symlink:
                            item.create_system = 3
                            item.external_attr = (stat.S_IFLNK | 0o777) << 16
                        stream.writestr(item, "target")
                self.edit(entry["receipt"], lambda value: value.update(digest="sha256:" + CHECK.sha256(archive)))
                self.rejected("Unsafe or duplicate|Symlink/encrypted", seal=False)


class CheckoutTests(unittest.TestCase):
    def test_untracked_relevant_source_rejected_but_ignored_build_output_allowed(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            subprocess.run(["git", "init", "-q", str(root)], check=True)
            (root / "scripts").mkdir()
            for name in ("android-release-readiness.py", "android-release-proof.py", "android-verify.py", "android-sign.py"):
                (root / "scripts" / name).write_text("# fixture\n")
            (root / ".gitignore").write_text("android/build/\n")
            subprocess.run(["git", "add", "."], cwd=root, check=True)
            subprocess.run(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"], cwd=root, check=True)
            head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=root, text=True).strip()
            (root / "android/build").mkdir(parents=True)
            (root / "android/build/ignored.txt").write_text("build output")
            with patch.object(CHECK, "ROOT", root):
                REAL_CHECKOUT(head)
                (root / "scripts/android-untracked.py").write_text("unexpected source")
                with self.assertRaisesRegex(ValueError, "Untracked Android"):
                    REAL_CHECKOUT(head)


if __name__ == "__main__":
    unittest.main()
