# Releases, downloads and integrity

[English README](../README.md) · [Русский README](../README.ru.md) · [All GitHub releases](https://github.com/INNVoices/waarp/releases) · [Release preview workflow](../.github/workflows/release-preview.yml)

## What you can download now

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

### Checks completed for this preview

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

## Preview release path (Windows + Android)

The [preview workflow](../.github/workflows/release-preview.yml) builds against one exact Git commit and publishes a **GitHub prerelease**, never a stable release. The versioned intent is [preview-2026-11-18.json](../release/preview-2026-11-18.json); updating it on `main` triggers a preview attempt. Future attempts can be started manually through Actions. The workflow uses GitHub Releases storage directly, not the quota-limited Actions artifact store.

- **Windows:** install dependencies; run typecheck, unit, source, performance and browser checks; fetch the pinned engine; run native checks and disposable Windows TUN cycles; package portable EXE; verify packaged files, versions and engine hashes; upload the EXE, SHA-256 manifest, package-integrity report and corresponding engine source.
- An initial Windows native preflight verifies same-session routing before the draft and both platform builds start. Readiness uses the production HTTPS endpoints and normal TLS verification through an explicitly limited relay; controlled TCP, UDP and DNS fixtures verify the selected path and continuity without changing the OS trust store.
- **Android:** use the existing pinned native-source build/verification and the same JUnit/lint/APK-integrity and API 35 TUN continuity gate as the Android CI build job; upload only the three **installable debug APKs**, their hashes and APK metadata, without unsigned inputs.
- Four existing Android UI scenarios produce six required native-app gallery captures on the same API 35 emulator, including Atlas at normal and 150% text, after the route checks.
- The final gate checks the exact source commit, required files and uploaded SHA-256 digests against the manifests.
- The release is created as a **draft**; only after both platforms' jobs succeed does the workflow publish it as a **prerelease**. If any check fails, the draft remains unpublished and must not be advertised as a downloadable release.
- The full Android API 29/35/36, optimized-release and two-hour AWG2 soak matrix is **not** replaced by this preview workflow. That stronger [acceptance contract](ANDROID.md#optimized-release-approval) remains mandatory for stable/production claims.
- If a release attempt runs on an unexpected commit or an existing tag points elsewhere, it must reject instead of overwriting the tag or publishing mismatched binaries.

### What this preview completes

Windows `0.4.1-rc.4` and Android `0.5.0-rc.5` include the local map inside the existing connection selection, contextual HTTP(S) checks and conservative route holding. Map data now follows visible Windows selection without the previous general debounce. Android preserves the manual region across map/list and route forms and accommodates the navigation labels at 150% text. Windows checks an already-loaded current public route while ON and keeps short diagnostic response counts together.

[Usage and limits](CONNECTION-TOOLS.md) · [Actual source acceptance](planning/WAARP-NEXT-2026-11-18/09-ACCEPTANCE.md) · [Reviewed r5 screenshots](screenshots/preview-r5/README.md) · [Preview notes](../release/preview-2026-11-18.md).

### Android signing

The true Android production identity is pinned in [release-signing.json](../android/release-signing.json). The private key is intentionally outside Git and CI. After passing the full acceptance gates, use the separately retained key and [documented signing script](ANDROID.md#signing) to sign the exact verified release APK payloads. The debug app uses `local.waarp.android.debug` and cannot update a production installation. Users generally need `arm64-v8a` for their phone; `armeabi-v7a` and `x86_64` are separate deliverables.

### Verifying downloads

**PowerShell (Windows)**

```powershell
Get-FileHash .\Waarp-0.4.1-rc.4-portable.exe -Algorithm SHA256
```

**Linux/macOS/WSL (APK or EXE)**

```sh
sha256sum <downloaded-file>
```

Compare the resulting value with the corresponding release asset `SHA256SUMS-*.txt` and the values recorded above. A matching hash verifies the byte sequence against that record; it does not make an unsigned binary trusted or a preview stable.

## Release approval policy

1. All functional/build checks for the exact source commit must pass. Do not reinterpret an artifact-upload quota failure as a product-test failure **or** as proof a package was successfully published.
2. Resolve or explicitly disclose any independent dependency-security audit failure. The [2026-11-18 build audit](BUILD-AUDIT-2026-11-18.md) describes an unresolved `picomatch` advisory in the build toolchain.
3. Windows stable approval requires the [desktop acceptance matrix](STABLE-AUDIT-2026-11-16.md), including real routing, another VPN, sleep/recovery and no hidden TUN restart on ordinary edits.
4. Android stable approval requires optimized release testing, pinned native provenance, multiple API levels, the 2-hour encrypted soak, actual-device follow-up and production signing.
5. Release notes must describe the exact OS, ABI, commit, version, supported features and limitations. Sanitized screenshots only; no keys or real server credentials.
6. Never call a source-only RC or a CI artifact a shipped installer. Never mark the latest prerelease as stable solely because a workflow uploaded files.

## Publishing and repository presentation

See [GitHub setup checklist](GITHUB-PUBLISHING.md) for About text, topics, social preview, repository visibility and branch rules that cannot be changed merely by editing Markdown.
