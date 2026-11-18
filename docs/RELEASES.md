# Releases, downloads and integrity

[English README](../README.md) · [Русский README](../README.ru.md) · [All GitHub releases](../../releases) · [Release preview workflow](../.github/workflows/release-preview.yml)

## What you can download now

| Platform | Version in `main` (2026-11-18) | Publicly published binary confirmed before this documentation update | Installability |
| --- | --- | --- | --- |
| Windows 10/11 x64 | `0.4.1-rc.2` | [v0.4.0 portable EXE](../../releases/tag/v0.4.0) | Existing Windows beta, unsigned |
| Android 10+ | `0.5.0-rc.4` | None | CI can produce installable **debug** APKs and **unsigned release inputs**; no public production-signed APK was confirmed |

The [v0.4.0 Windows asset](../../releases/download/v0.4.0/Waarp-0.4.0-portable.exe) has a published SHA-256 of `56aca6d8e977b5f1e099266fb416f8a0349e1735d9f46423c34dc7cd63c1af71`. This hash is from the release record, not a fresh local binary comparison. The matching engine source is attached to the same release.

> [!WARNING]
> No version is approved as **stable**. Never present an unsigned Android `release-unsigned.apk` as installable or a development/debug APK as a production-signed update. The current repository is private; downloads require repository access until the owner changes its visibility.

## Preview release path (Windows + Android)

The [preview workflow](../.github/workflows/release-preview.yml) builds against one exact Git commit and publishes a **GitHub prerelease**, never a stable release. The initial intent is [preview-2026-11-18.json](../release/preview-2026-11-18.json); its introduction on `main` triggers one preview attempt. Future attempts can be started manually through Actions. The workflow uses GitHub Releases storage directly, not the quota-limited Actions artifact store.

- **Windows:** install dependencies; run typecheck, unit, source, performance and browser checks; fetch the pinned engine; run native checks and disposable Windows TUN cycles; package portable EXE; verify packaged files, versions and engine hashes; upload the EXE and SHA-256 manifest.
- **Android:** use the existing pinned native-source build/verification and the same JUnit/lint/APK-integrity and API 35 TUN continuity gate as the Android CI build job; upload only the three **installable debug APKs**, their hashes and no unsigned inputs.
- The release is created as a **draft**; only after both platforms' jobs succeed does the workflow publish it as a **prerelease**. If any check fails, the draft remains unpublished and must not be advertised as a downloadable release.
- The full Android API 29/35/36, optimized-release and two-hour AWG2 soak matrix is **not** replaced by this preview workflow. That stronger [acceptance contract](ANDROID.md#optimized-release-approval) remains mandatory for stable/production claims.
- If a release attempt runs on an unexpected commit or an existing tag points elsewhere, it must reject instead of overwriting the tag or publishing mismatched binaries.

### Android signing is deliberately separate

The true Android production identity is pinned in [release-signing.json](../android/release-signing.json). The private key is intentionally outside Git and CI. After passing the full acceptance gates, use the separately retained key and [documented signing script](ANDROID.md#signing) to sign the exact verified release APK payloads. The debug app uses `local.waarp.android.debug` and cannot update a production installation. Users generally need `arm64-v8a` for their phone; `armeabi-v7a` and `x86_64` are separate deliverables.

### Verifying downloads

**PowerShell (Windows)**

```powershell
Get-FileHash .\Waarp-0.4.0-portable.exe -Algorithm SHA256
```

**Linux/macOS/WSL (APK or EXE)**

```sh
sha256sum <downloaded-file>
```

Compare the resulting value with the corresponding release asset `SHA256SUMS-*.txt` or the recorded v0.4.0 hash above. A matching hash verifies the byte sequence against that record; it does not make an unsigned binary trusted or a preview stable.

## Release approval policy

1. All functional/build checks for the exact source commit must pass. Do not reinterpret an artifact-upload quota failure as a product-test failure **or** as proof a package was successfully published.
2. Resolve or explicitly disclose any independent dependency-security audit failure. The [2026-11-18 build audit](BUILD-AUDIT-2026-11-18.md) describes an unresolved `picomatch` advisory in the build toolchain.
3. Windows stable approval requires the [desktop acceptance matrix](STABLE-AUDIT-2026-11-16.md), including real routing, another VPN, sleep/recovery and no hidden TUN restart on ordinary edits.
4. Android stable approval requires optimized release testing, pinned native provenance, multiple API levels, the 2-hour encrypted soak, actual-device follow-up and production signing.
5. Release notes must describe the exact OS, ABI, commit, version, supported features and limitations. Sanitized screenshots only; no keys or real server credentials.
6. Never call a source-only RC or a CI artifact a shipped installer. Never mark the latest prerelease as stable solely because a workflow uploaded files.

## Publishing and repository presentation

See [GitHub setup checklist](GITHUB-PUBLISHING.md) for About text, topics, social preview, repository visibility and branch rules that cannot be changed merely by editing Markdown.