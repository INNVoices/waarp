# Android release evidence bundle

`scripts/android-release-readiness.py` checks one exported candidate before a signing review, and can check the resulting retained-key APKs afterward. It does not build, install, sign, create keys, change the public certificate pin, upload or publish anything. It does not replace the acceptance workflow or authorize a release.

The check is **offline consistency with externally trusted GitHub API receipts**. A bundle manifest alone is not provenance. Obtain the API records and original Actions artifact ZIPs through a trusted authenticated export, retain their origin, and protect them from replacement. The checker cannot authenticate a fabricated API JSON response. Its report explicitly contains `cryptographicCiProvenanceVerified: false`.

## Required candidate

Use a complete checkout of the exact candidate commit, with the checker and its helpers committed at that HEAD. Android source, verification scripts and the workflow must have no tracked changes or untracked source inputs; ignored build outputs are allowed. Use Python 3.11 or later, Git, Android SDK Build Tools 35.0.0 and JDK 17, as required by the existing [APK verification and signing tools](ANDROID.md#build-and-install). No private signing material is needed to run this checker.

The first supported input is a **completed successful `push` or `workflow_dispatch` of `main`** for `.github/workflows/android.yml`. Pull request runs are rejected: their API head SHA does not by itself establish the merge checkout used by `actions/checkout`. All eight expected jobs must have succeeded in the same run attempt, including the three native VPN jobs, three optimized release journeys and full two-hour optimized-release soak. A skipped, failed, cancelled, incomplete or partially exported job matrix is a blocker.

Source version `1.0.0` and this tool do not establish that a production APK has been published. A failed workflow or missing soak cannot become accepted by preparing a manifest.

## Export the original records and artifacts

Keep the raw workflow-run JSON and the complete jobs response for the chosen **attempt**. For the current eight-job workflow, `per_page=100` fits the full response; the checker requires `total_count == len(jobs) == 8`. Do not combine attempts or discard failed jobs.

| Record | GitHub REST endpoint relative to `https://api.github.com` |
| --- | --- |
| Workflow run | `/repos/INNVoices/waarp/actions/runs/RUN_ID` |
| Jobs in the chosen attempt | `/repos/INNVoices/waarp/actions/runs/RUN_ID/attempts/ATTEMPT/jobs?per_page=100` |
| Each original artifact receipt | `/repos/INNVoices/waarp/actions/artifacts/ARTIFACT_ID` |
| Original artifact ZIP | `/repos/INNVoices/waarp/actions/artifacts/ARTIFACT_ID/zip` |

The artifact records are individual responses by immutable ID, not a shortened list response. Retain the original downloaded ZIP bytes; **do not recompress** an extracted artifact. Extract each artifact into a separate fresh directory, preserving every file and relative path. Use a ZIP extractor that rejects escaping paths and links; the checker itself never extracts archives. The required artifacts and owning jobs are:

| Artifact | Owning job |
| --- | --- |
| `waarp-android-apks` | Build, unit, lint and APK integrity |
| `waarp-android-build-reports` | Build, unit, lint and APK integrity |
| `waarp-android-release-api-29-4096-runtime` | Optimized release API 29 / 4096B |
| `waarp-android-release-api-35-4096-runtime` | Optimized release API 35 / 4096B |
| `waarp-android-release-api-36-16384-runtime` | Optimized release API 36 / 16384B |
| `waarp-android-release-2h-soak` | Optimized release 2h AWG2 soak / API 36 / 16KB |

For each original ZIP, the checker requires its actual SHA-256 to equal the API receipt's `digest`, and the receipt's workflow run ID/head SHA to match the selected candidate. Artifact names and IDs must be distinct. The artifact API has no run-attempt field, so its creation time must fall inside the exact owning job's start/completion window in the selected attempt. A mixed rerun that reuses an earlier attempt's artifact is deliberately rejected; export a fully successful attempt of the required matrix.

Every extracted regular file must match its original ZIP entry byte for byte, with no missing or extra files. Escaping, duplicate, symbolic-link and encrypted archive entries are rejected. Selected APKs, reports and runtime directories must belong to their designated artifact. This also preserves the integrity of redacted native crash transcripts without pretending their original unredacted hashes can be recovered.

GitHub documents the [artifact receipt/digest and archive endpoints](https://docs.github.com/en/rest/actions/artifacts) and [jobs-for-an-attempt endpoint](https://docs.github.com/en/rest/actions/workflow-jobs#list-jobs-for-a-workflow-run-attempt). The existing workflow determines upload paths and retention; save the originals while they are available.

## Manifest

Paths are relative POSIX paths beneath the manifest directory. Keep original archives in `archives/`, API receipts in `ci/`, and extracted artifacts in separate directories. Do not move individual files out of an extracted artifact or edit its reports. The names below illustrate the current source version; use actual candidate filenames and SHA-256 values.

```json
{
  "schemaVersion": 1,
  "sourceCommit": "FULL_40_CHARACTER_CANDIDATE_COMMIT",
  "workflowRun": "ci/run.json",
  "workflowJobs": "ci/jobs.json",
  "nativeBuildReport": "build-reports/out/android-core/build-report.json",
  "artifacts": "apks/artifacts.json",
  "archives": [
    {"receipt": "ci/apks.json", "zip": "archives/apks.zip", "directory": "apks"},
    {"receipt": "ci/build-reports.json", "zip": "archives/build-reports.zip", "directory": "build-reports"},
    {"receipt": "ci/journeys-29.json", "zip": "archives/journeys-29.zip", "directory": "runtime/journeys-29"},
    {"receipt": "ci/journeys-35.json", "zip": "archives/journeys-35.zip", "directory": "runtime/journeys-35"},
    {"receipt": "ci/journeys-36.json", "zip": "archives/journeys-36.zip", "directory": "runtime/journeys-36"},
    {"receipt": "ci/soak-36.json", "zip": "archives/soak-36.zip", "directory": "runtime/soak-36"}
  ],
  "unsigned": [
    {"abi": "arm64-v8a", "apk": "apks/waarp-android-1.0.0-arm64-v8a-release-unsigned.apk", "validation": "apks/waarp-android-1.0.0-arm64-v8a-release-unsigned.apk.validation.json", "sha256": "ACTUAL_APK_SHA256"},
    {"abi": "armeabi-v7a", "apk": "apks/waarp-android-1.0.0-armeabi-v7a-release-unsigned.apk", "validation": "apks/waarp-android-1.0.0-armeabi-v7a-release-unsigned.apk.validation.json", "sha256": "ACTUAL_APK_SHA256"},
    {"abi": "x86_64", "apk": "apks/waarp-android-1.0.0-x86_64-release-unsigned.apk", "validation": "apks/waarp-android-1.0.0-x86_64-release-unsigned.apk.validation.json", "sha256": "ACTUAL_APK_SHA256"}
  ],
  "runtime": [
    {"mode": "journeys", "api": 29, "pageSize": 4096, "directory": "runtime/journeys-29"},
    {"mode": "journeys", "api": 35, "pageSize": 4096, "directory": "runtime/journeys-35"},
    {"mode": "journeys", "api": 36, "pageSize": 16384, "directory": "runtime/journeys-36"},
    {"mode": "soak", "api": 36, "pageSize": 16384, "directory": "runtime/soak-36"}
  ]
}
```

The placeholders are intentionally invalid hashes. The current build-reports artifact includes `out/android-core/build-report.json`; inspect the original archive before setting its relative path. Keep signed outputs in a new `signed/` directory outside the immutable extracted CI artifacts. To check production signing, add a `signed` array with exactly three entries using the same `abi`, `apk`, `validation` and `sha256` keys, referencing actual APKs and the `.apk.validation.json` reports written by the existing signing tool. Do not manufacture these reports or a production certificate.

## Run and interpret the result

Run from the exact candidate checkout, after exporting its successful workflow. Keep the output report outside the evidence bundle:

```bash
python3 scripts/android-release-readiness.py \
  --manifest /absolute/path/bundle/manifest.json \
  --source-commit FULL_40_CHARACTER_CANDIDATE_COMMIT \
  --report /absolute/path/review/readiness.json
```

After an independently authorized signing operation has produced all three retained-key APKs and the manifest has its `signed` entries:

```bash
python3 scripts/android-release-readiness.py \
  --manifest /absolute/path/bundle/manifest.json \
  --source-commit FULL_40_CHARACTER_CANDIDATE_COMMIT \
  --require-signed \
  --report /absolute/path/review/signed-readiness.json
```

`--require-signed` fails if signed artifacts are absent; it cannot silently downgrade to an unsigned review. If a `signed` array is present, it is always checked. Exit status is zero only after all selected checks pass. Before validation starts, an existing output success is replaced with an incomplete/failed report, so an interrupted or failed attempt cannot leave an old success as the latest result. The output never goes inside an extracted evidence tree.

The unsigned stage is `ready-for-signing-review`. The signed stage is `signed-evidence-consistent`. Neither means `publicationReady` or directory acceptance. The report records the source commit, run/attempt, immutable artifact IDs and archive hashes, three unsigned APK/payload hashes, runtime summary hashes and, when present, signed APK hashes.

## What is checked, and what remains external

The existing `android-verify.py` rechecks actual unsigned APKs, engine pins, package/version, native libraries, 16 KB packaging and static reports for ARM64, ARMv7 and x86_64. The native source build report must match this checkout's engine pins. The actual package/version also must match `android/app/build.gradle.kts`. The ZIP payload digest covers every entry, using the existing signing tool's algorithm.

For each runtime directory, `installed-apk.json` must exactly equal `result.json.installedApk`. Its `unsignedSourceSha256`, payload digest, engine identity and package/version must match the actual x86_64 candidate. The checker reparses the original instrumentation transcript for the exact scenario, rejects timeout/failure/skips, requires complete crash evidence and the three recorded bounded cold launches, and re-runs the existing raw device/peer reconciliation. That reconciliation validates traffic, resource observations, foreground/frame traces, emulator image and ftrace preparation. A cached `reconciled-proof.json` or `passed` flag cannot substitute for raw evidence.

For signed APKs, the existing SDK verifier checks the actual retained certificate against `android/release-signing.json`, and the signing report plus real ZIP entries must bind each ABI to the unchanged accepted unsigned payload. The disposable CI certificate and retained production certificate are intentionally different.

The CI-signed temporary APK is not retained by the current runner, and raw `am start -W` outputs are not retained. Their installed identity and cold-launch observations are trusted through the original workflow artifact, not independently remeasured by this offline tool. Redacted native crash text is checked for its expected log sections and crash markers; its original unredacted bytes are not reconstructed. Native VPN debug jobs are required to succeed, but their separate runtime archives are not reinterpreted here.

Runtime acceptance covers x86_64 emulators at API 29/35/36 and 4/16 KB pages. ARM APKs receive static checks; this does not prove ARM physical-device behavior. Production fresh install, update continuity from a real earlier production APK, key custody and distribution policy review remain separate work. The public debug preview uses a different package and is not a historical production-upgrade fixture. No historical upgrade is claimed without that original APK and a real installation test.

## Fast regression tests

```bash
python3 scripts/android-release-readiness-test.py
```

Tests use tiny real ZIP files, original parser/payload functions and explicit SDK/raw-device test boundaries. They require no Android SDK, device, network or private key. They exercise mixed run/attempt receipts, archive/file tampering, missing/repeated ABI/runtime gates, wrong source/payload identity, failed instrumentation and insufficient soak/crash/startup observations. An unmocked raw-proof case rejects missing original evidence. Existing foreground/ftrace test suites continue to test their lower-level validators.
