# Releases, downloads and integrity

[English README](../README.md) · [Русский README](../README.ru.md) · [All GitHub releases](https://github.com/INNVoices/waarp/releases) · [Release preview workflow](../.github/workflows/release-preview.yml)

## Current releases — Windows r6 and Android r5

**Windows r6 is published as a prerelease**, released on 18 November 2026 at 16:54:52 UTC. It updates only the desktop application to `0.4.1-rc.5`. Its tag and binaries refer to source [`0e0bb6c7cad421dc0fff377d8c7f826d115e0292`](https://github.com/INNVoices/waarp/commit/0e0bb6c7cad421dc0fff377d8c7f826d115e0292). All required jobs in the [release workflow](https://github.com/INNVoices/waarp/actions/runs/44348809024) passed; Android was skipped as declared by the Windows-only release intent. [Published r6 release](https://github.com/INNVoices/waarp/releases/tag/preview-2026-11-18-r6).

Android remains the **published r5** `0.5.0-rc.5`, built from [`928c9a8e3cd0a83a41ebfa15c2628ddb610ea157`](https://github.com/INNVoices/waarp/commit/928c9a8e3cd0a83a41ebfa15c2628ddb610ea157). It is not rebuilt or repackaged for this desktop update. Windows r6 and Android r5 therefore have separate source provenance.

| Platform | Download | Release state |
| --- | --- | --- |
| Windows 10/11 x64 | [Waarp 0.4.1-rc.5 portable EXE](https://github.com/INNVoices/waarp/releases/download/preview-2026-11-18-r6/Waarp-0.4.1-rc.5-portable.exe) | Published r6; portable, unsigned |
| Android 10+ · ARM64 | [0.5.0-rc.5 arm64-v8a APK](https://github.com/INNVoices/waarp/releases/download/preview-2026-11-18-r5/waarp-android-0.5.0-rc.5-arm64-v8a-debug.apk) | Published r5; debug-signed |
| Android 10+ · ARM32 | [0.5.0-rc.5 armeabi-v7a APK](https://github.com/INNVoices/waarp/releases/download/preview-2026-11-18-r5/waarp-android-0.5.0-rc.5-armeabi-v7a-debug.apk) | Published r5; debug-signed |
| Android 10+ · x86_64 | [0.5.0-rc.5 x86_64 APK](https://github.com/INNVoices/waarp/releases/download/preview-2026-11-18-r5/waarp-android-0.5.0-rc.5-x86_64-debug.apk) | Published r5; debug-signed |

Windows r6 asset links: [SHA-256 manifest](https://github.com/INNVoices/waarp/releases/download/preview-2026-11-18-r6/SHA256SUMS-windows.txt), [package integrity](https://github.com/INNVoices/waarp/releases/download/preview-2026-11-18-r6/package-integrity-windows.json), [real public-network acceptance](https://github.com/INNVoices/waarp/releases/download/preview-2026-11-18-r6/public-catalog-windows.json), [corresponding engine source](https://github.com/INNVoices/waarp/releases/download/preview-2026-11-18-r6/sing-box-lx-1.14.2-lx.11-src.tar.gz). Android keeps its [r5 checksums](https://github.com/INNVoices/waarp/releases/download/preview-2026-11-18-r5/SHA256SUMS-android-debug.txt) and [r5 artifact metadata](https://github.com/INNVoices/waarp/releases/download/preview-2026-11-18-r5/android-artifacts.json).

| Windows r6 binary | Size | SHA-256 |
| --- | --- | --- |
| `Waarp-0.4.1-rc.5-portable.exe` | 130,532,255 bytes | `3cdd81a22ddb48d655714351a2ed581b608b680140f51c8b657fb994a6bf1317` |

### Scope of the Windows update

- Public candidates are checked automatically while their catalog screen is open. Visible rows receive priority and checks continue in bounded rounds; candidates need not be added to saved connections to be tested. The display separates progress, fresh responses, failed checks and candidates skipped before a network check.
- A larger map follows the window height and adds regional totals and measured state. Recognized country metadata survives saving a public connection; unknown geography stays explicit.
- The main Diagnostics screen starts a bounded target investigation, resolves an existing domain route or default path, distinguishes system-layer observations from native connection responses, and provides a next step. A responding current path is retained. Transfer and history tools remain in an expandable section.
- The application icon is included at its runtime path for the packaged window and Windows taskbar.

### Current evidence and unresolved limits

All results in this subsection refer to published r6 source `0e0bb6c7cad421dc0fff377d8c7f826d115e0292`. The [packaged-app report](screenshots/preview-r6/public-catalog-windows.json) and [package report](screenshots/preview-r6/package-integrity-windows.json) are retained alongside the screenshots. The preview passed its required gates; the separate general-CI failure below remains unresolved.

| Evidence | Observed result and scope |
| --- | --- |
| Public checks before import | [Packaged Windows acceptance, step 22](https://github.com/INNVoices/waarp/actions/runs/44348809024/job/134959333754): 4,930 candidates with **0 saved profiles**; 6 native checks yielded 1 fresh response and 5 failures, while 2 candidates were skipped before a network check. The first fresh response was observed **102.737 s** into the fresh-install catalog scenario |
| Continued checks with VPN on | 8 additional checks; totals reached 14 checked, **4 with fresh responses**, 10 failed and 2 skipped. The native session and selected route were preserved. The measured imported candidate was VLESS · REALITY, country CA, with a 171 ms HTTP response |
| Automatic diagnostics | Four observed stages; the existing “Example website” route was resolved. Its current native path answered **2 of 2** checks and the guidance kept that path |
| Map and window icon | At 1920 × 1080 the public map was 1502 × 605 px; at 1240 × 900 it was 1076 × 504 px, with no horizontal overflow. The runtime icon loaded at 256 × 256 px and a native window handle was present |
| Preview native lifecycle | **50/50 TUN cycles passed** in 381,571 ms within the unchanged 600,000 ms budget |
| Preview publication | All required jobs passed; declared Android skip; published prerelease at 16:54:52 UTC, exact source/tag and verified Windows package |
| Separate general CI renderer | [Job 134958446897](https://github.com/INNVoices/waarp/actions/runs/44348808981/job/134958446897) passed 31 browser regressions, 5 Atlas and 9 diagnostic scenarios, plus 100 renderer cycles within the unchanged 90 s budget; the exact cycle elapsed time was not retained in its log |
| Separate general CI native routing | Selector and route checks passed, including selected-path TCP/UDP checks and preservation of the neighboring stream/main session |
| Separate general CI lifecycle | **Failed after 19 of 50 cycles** with `owned_child_exit_timeout`; elapsed 143,224 ms within the 600,000 ms overall budget. That job skipped its subsequent build/package steps |
| Dependency audit | Runtime audit: 0 vulnerabilities. Full build-tool audit: 10 high findings involving the disclosed `picomatch` advisory |
| Actions artifact uploads | Storage quota prevented ordinary artifact uploads. This is separate from the native lifecycle failure and does not explain it |

The lifecycle failure occurred while the native test harness waited for its directly spawned, synthetic native child to exit after a hard kill. That harness does not exercise the new Catalog code or `Engine.stop`. **The cause of the unconfirmed exit and the final cleanup state remain unknown.** The successful preview lifecycle run does not resolve that failed result. It is not treated as runner flakiness, a quota-only failure or a fixed defect. The release approval policy and stable acceptance requirements below remain unchanged.

The packaged-app gate used real public feeds and the native checker on a disposable GitHub-hosted Windows runner, without fixture responses. Its report records the source, network and observations. The counts describe the measured portion of the catalog, not all 4,930 candidates. The 171 ms value is an HTTP response measurement, not a game ping. A successful run on GitHub's network cannot establish availability on every user's network or long-term reliability of third-party relays.

## Published r5 record — historical Windows, current Android


The [18 November 2026 preview](https://github.com/INNVoices/waarp/releases/tag/preview-2026-11-18-r5) is **published as a prerelease**. Windows `0.4.1-rc.4` and Android `0.5.0-rc.5` were built from [commit `928c9a8e3cd0a83a41ebfa15c2628ddb610ea157`](https://github.com/INNVoices/waarp/commit/928c9a8e3cd0a83a41ebfa15c2628ddb610ea157). The release tag points to that exact commit; later documentation-only commits on `main` do not change these binaries.

| Platform | Download | Installability |
| --- | --- | --- |
| Windows 10/11 x64 | [Waarp 0.4.1-rc.4 portable EXE](https://github.com/INNVoices/waarp/releases/download/preview-2026-11-18-r5/Waarp-0.4.1-rc.4-portable.exe) | Portable, unsigned preview |
| Android 10+ · ARM64 | [0.5.0-rc.5 arm64-v8a APK](https://github.com/INNVoices/waarp/releases/download/preview-2026-11-18-r5/waarp-android-0.5.0-rc.5-arm64-v8a-debug.apk) | Installable debug build; most current phones |
| Android 10+ · ARM32 | [0.5.0-rc.5 armeabi-v7a APK](https://github.com/INNVoices/waarp/releases/download/preview-2026-11-18-r5/waarp-android-0.5.0-rc.5-armeabi-v7a-debug.apk) | Installable debug build for compatible 32-bit devices |
| Android 10+ · x86_64 | [0.5.0-rc.5 x86_64 APK](https://github.com/INNVoices/waarp/releases/download/preview-2026-11-18-r5/waarp-android-0.5.0-rc.5-x86_64-debug.apk) | Installable debug build for compatible devices/emulators |

The release also contains [Windows SHA-256 sums](https://github.com/INNVoices/waarp/releases/download/preview-2026-11-18-r5/SHA256SUMS-windows.txt), [Android SHA-256 sums](https://github.com/INNVoices/waarp/releases/download/preview-2026-11-18-r5/SHA256SUMS-android-debug.txt), the [Windows package report](https://github.com/INNVoices/waarp/releases/download/preview-2026-11-18-r5/package-integrity-windows.json), [Android artifact metadata](https://github.com/INNVoices/waarp/releases/download/preview-2026-11-18-r5/android-artifacts.json) and [corresponding engine source](https://github.com/INNVoices/waarp/releases/download/preview-2026-11-18-r5/sing-box-lx-1.14.2-lx.11-src.tar.gz). All nine required assets were checked before publication.

| Binary | SHA-256 recorded for this release |
| --- | --- |
| Windows portable EXE | `bbf2f88208f45ae0cd4503588006e75ae0f40ce1c7b1c292bb74229e3fb7dd96` |
| Android ARM64 debug APK | `f8584c314e72c2510974abcd2b977a82532d8717203970d974255318877c0a93` |
| Android ARM32 debug APK | `ca5ef46b87c2e5f53b329018a0280763256ec07d57501cc05d556535ab97f981` |
| Android x86_64 debug APK | `1907d4242bf01543327a30926ac4c375a662ab871284d52e5381c1d8431dff31` |

> [!WARNING]
> No version is approved as **stable**. Never present an unsigned Android `release-unsigned.apk` as installable or a development/debug APK as a production-signed update. The current repository is private; downloads require repository access until the owner changes its visibility.

### Checks completed for r5

The [complete preview run](https://github.com/INNVoices/waarp/actions/runs/44316534164) passed all five jobs: Windows native preflight, draft preparation, Windows packaging, Android packaging and final publication.

| Evidence | Result and scope |
| --- | --- |
| Windows renderer | 31 browser regressions, 4 Atlas and 7 contextual-check scenarios; 100 stability cycles in 80.29 s within the unchanged 90 s budget; typecheck, offline regressions, source and performance checks passed |
| Windows native routing | Real TUN, TCP and UDP through a newly selected profile; separate worker-DNS check; unchanged main PID/session and uninterrupted neighboring stream |
| Windows lifecycle and package | 50/50 native TUN lifecycle cycles in 364.040 s within the unchanged 600 s budget; packaged version, engine hashes and runtime entries verified; test bundles/reports excluded |
| Android JVM | 204/204 tests, no failures or skips |
| Android route/feedback acceptance | 5/5 API 35 emulator tests; eight route mutations acknowledged in one native session; notifications leave form controls reachable |
| Android UI gallery | 4/4 API 35 scenarios passed, including local Atlas, 100%/150% text, accessible actions, non-overlapping navigation labels and preservation of the chosen region across List/Map |
| Android APKs | Three debug ABIs built; signatures, native engine identity and 16 KB alignment verified |
| Publication | Exact commit/tag, required files and uploaded digests matched; draft changed to published prerelease |

On the same final source, the separate general Windows run 44316534397/job 134844018930 exceeded the 100-cycle 90 s UI budget and skipped its subsequent route/TUN/package steps; the independent selector check still passed. The required preview run passed that same budget without changing the test. The cause of the discrepancy is unresolved; this is preserved as a failed result, not attributed to artifact quota or described as fixed. These focused checks do not establish physical-device behavior, reliability of third-party public servers, or the full stable acceptance matrix. The independent [build-tool security audit](BUILD-AUDIT-2026-11-18.md) still fails on the disclosed `picomatch` advisory. Ordinary Actions artifact uploads also encounter the account's storage quota; this preview uploaded verified assets directly to GitHub Releases. Neither condition is represented as a passing general CI status.

## Preview release path and declared platforms

The [preview workflow](../.github/workflows/release-preview.yml) builds the platforms declared in [preview-2026-11-18.json](../release/preview-2026-11-18.json) against one exact Git commit and publishes a **GitHub prerelease**, never a stable release. Updating the intent on `main` triggers an attempt; it can also be started manually. The workflow uses GitHub Releases storage directly, not the quota-limited Actions artifact store. r5 declared Windows and Android. r6 declares Windows only; the Android job is skipped, and Android download links continue to refer to its published r5 artifacts and source.

- **Windows:** install dependencies; run typecheck, unit, source, performance and browser checks; fetch the pinned engine; run native checks and disposable Windows TUN cycles; package portable EXE; verify packaged files, versions and engine hashes; run the packaged-app public-network acceptance; upload the EXE, SHA-256 manifest, package-integrity report, `public-catalog-windows.json` and corresponding engine source.
- An initial Windows native preflight verifies same-session routing before draft preparation and the declared platform builds start. Readiness uses the production HTTPS endpoints and normal TLS verification through an explicitly limited relay; controlled TCP, UDP and DNS fixtures verify the selected path and continuity without changing the OS trust store.
- **Android, when declared:** use the existing pinned native-source build/verification and the same JUnit/lint/APK-integrity and API 35 TUN continuity gate as the Android CI build job; upload only the three **installable debug APKs**, their hashes and APK metadata, without unsigned inputs.
- When Android is declared, four existing UI scenarios produce six required native-app gallery captures on the same API 35 emulator, including Atlas at normal and 150% text, after the route checks.
- The final gate checks the exact source commit, required files and uploaded SHA-256 digests against the manifests, plus the packaged Windows public-network report. A report from another source commit cannot satisfy the gate.
- The release is created as a **draft**; only after all declared platform jobs succeed does the workflow publish it as a **prerelease**. An Android job skipped by a Windows-only intent does not produce an Android artifact. If a required check fails, the draft remains unpublished and must not be advertised as a downloadable release.
- The full Android API 29/35/36, optimized-release and two-hour AWG2 soak matrix is **not** replaced by this preview workflow. That stronger [acceptance contract](ANDROID.md#optimized-release-approval) remains mandatory for stable/production claims.
- If a release attempt runs on an unexpected commit or an existing tag points elsewhere, it must reject instead of overwriting the tag or publishing mismatched binaries.

### What r5 completed

Windows `0.4.1-rc.4` and Android `0.5.0-rc.5` include the local map inside the existing connection selection, contextual HTTP(S) checks and conservative route holding. Map data now follows visible Windows selection without the previous general debounce. Android preserves the manual region across map/list and route forms and accommodates the navigation labels at 150% text. Windows checks an already-loaded current public route while ON and keeps short diagnostic response counts together.

[Usage and limits](CONNECTION-TOOLS.md) · [Actual source acceptance](planning/WAARP-NEXT-2026-11-18/09-ACCEPTANCE.md) · [Reviewed r5 screenshots](screenshots/preview-r5/README.md) · [Preview notes](../release/preview-2026-11-18.md).

### Android signing

The true Android production identity is pinned in [release-signing.json](../android/release-signing.json). The private key is intentionally outside Git and CI. After passing the full acceptance gates, use the separately retained key and [documented signing script](ANDROID.md#signing) to sign the exact verified release APK payloads. The debug app uses `local.waarp.android.debug` and cannot update a production installation. Users generally need `arm64-v8a` for their phone; `armeabi-v7a` and `x86_64` are separate deliverables.

### Verifying downloads

**PowerShell (Windows)**

```powershell
Get-FileHash .\Waarp-0.4.1-rc.5-portable.exe -Algorithm SHA256
```

**Linux/macOS/WSL (APK or EXE)**

```sh
sha256sum <downloaded-file>
```

Compare the resulting value with `SHA256SUMS-*.txt` from the same release as the binary: r6 for the new Windows EXE, r5 for the retained Android APKs. The inline r5 values above remain historical records for those exact artifacts. A matching hash verifies the byte sequence against that record; it does not make an unsigned binary trusted or a preview stable.

## Release approval policy

1. All functional/build checks for the exact source commit must pass. Do not reinterpret an artifact-upload quota failure as a product-test failure **or** as proof a package was successfully published.
2. Resolve or explicitly disclose any independent dependency-security audit failure. The [2026-11-18 build audit](BUILD-AUDIT-2026-11-18.md) describes an unresolved `picomatch` advisory in the build toolchain.
3. Windows stable approval requires the [desktop acceptance matrix](STABLE-AUDIT-2026-11-16.md), including real routing, another VPN, sleep/recovery and no hidden TUN restart on ordinary edits.
4. Android stable approval requires optimized release testing, pinned native provenance, multiple API levels, the 2-hour encrypted soak, actual-device follow-up and production signing.
5. Release notes must describe the exact OS, ABI, commit, version, supported features and limitations. Sanitized screenshots only; no keys or real server credentials.
6. Never call a source-only RC or a CI artifact a shipped installer. Never mark the latest prerelease as stable solely because a workflow uploaded files.

## Publishing and repository presentation

See [GitHub setup checklist](GITHUB-PUBLISHING.md) for About text, topics, social preview, repository visibility and branch rules that cannot be changed merely by editing Markdown.
