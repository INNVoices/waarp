# Install Waarp

After installation, follow the [first-route walkthrough in Russian](guides/first-routes.md): one personal profile, one application, a Direct comparison and then a separate domain rule. It explains the preview installation and route checks, with historical UI references identified separately.

Choose a published build for your device. You do not need Node.js, a compiler or a GitHub account to download it.

## Downloads

**Published preview builds, verified 2026-11-22 18:51:59 UTC:** Windows `1.0.0` and Android `1.0.0-debug`, version code `7`, from `preview-2026-11-22-r2`. These are prereleases from one exact source commit; the production Android package is not part of this download set.

| Device | Download | Build |
| --- | --- | --- |
| Windows 10/11, x64 | [Windows portable EXE](https://github.com/INNVoices/waarp/releases/download/preview-2026-11-22-r2/Waarp-1.0.0-portable.exe) | 1.0.0 preview; unsigned |
| Android 10+, ARM64 | [Android ARM64 APK](https://github.com/INNVoices/waarp/releases/download/preview-2026-11-22-r2/waarp-android-1.0.0-arm64-v8a-debug.apk) | 1.0.0 preview; debug-signed |
| Android 10+, 32-bit ARM | [Android ARM32 APK](https://github.com/INNVoices/waarp/releases/download/preview-2026-11-22-r2/waarp-android-1.0.0-armeabi-v7a-debug.apk) | 1.0.0 preview; debug-signed |
| Android 10+, x86_64 | [Android x86_64 APK](https://github.com/INNVoices/waarp/releases/download/preview-2026-11-22-r2/waarp-android-1.0.0-x86_64-debug.apk) | 1.0.0 preview; debug-signed |

Choose ARM64 for most current Android phones. Use ARM32 or x86_64 only if it matches your device. All three Android downloads contain the app; they are alternatives, not split APKs that must be installed together.

[Windows release notes](https://github.com/INNVoices/waarp/releases/tag/preview-2026-11-22-r2) · [Android release notes](https://github.com/INNVoices/waarp/releases/tag/preview-2026-11-22-r2) · [All releases](https://github.com/INNVoices/waarp/releases) · [Build from source](../README.md#build-the-100-source-on-a-windows-pc)

This release contains both Windows and Android downloads. If a future release contains only one platform, use the explicit download links above or Obtainium’s matching-APK fallback rather than choosing solely by list position.

## Windows: first run

1. Download the portable EXE and [check its SHA-256](#verify-a-download).
2. Save it in a folder you control and open it. The current preview has no publisher signature, so Windows may show an unknown-publisher or reputation notice. Review the official download source and hash before deciding to run it; no change to Windows security settings is required by this guide.
3. Import a connection profile you control or trust. Add an application or domain rule and choose its connection. Use **Direct** for traffic you want to keep on the ordinary connection.
4. Turn the tunnel on. Starting the Windows tunnel requires administrator permission. If Waarp reports that elevation is required, use **Run as administrator** for the verified EXE and review the Windows permission prompt.
5. Open the target app or website and inspect the route and diagnostics in Waarp. Turn the tunnel off when you finish.

The optional public-node catalog contains third-party endpoints. A successful check describes reachability from your network at that moment. It does not establish who operates the endpoint or its privacy practices.

If another VPN already owns the full system route, stop or reconfigure it before starting Waarp. Follow a startup error's specific guidance. See [connection tools](CONNECTION-TOOLS.md) and [network lifecycle behavior](RELIABILITY.md).

### Updating Windows

Windows preview updates are manual. Turn the tunnel off and close Waarp normally before replacing the EXE with a verified newer download. Keep the existing app data and saved profiles. The [release record](RELEASES.md#published-preview-2026-11-22-r2) states which install, restart and upgrade scenarios were actually checked; a same-candidate restart is not evidence of a cross-version upgrade.

## Android: first run

1. Download the APK matching your device and [check its SHA-256](#verify-a-download).
2. Open the downloaded file. If Android asks, allow your browser, file manager or Obtainium to install this app. This permission is specific to the app performing the installation.
3. Open Waarp, import a connection profile, and choose the apps or domains and their routes.
4. Turn the tunnel on and review Android's **VPN connection** permission. The system VPN permission is required for the selected traffic to pass through Waarp.
5. Check the connection in your target app and the status shown by Waarp. Android displays a foreground notification while the VPN service is running.

These APKs install as **`local.waarp.android.debug`**. They are a separate preview app from the production package `local.waarp.android`.

### Updating and signatures

Update an existing installation only with a build using the same package identity and signing certificate. The debug preview cannot update a production-signed installation. A locally built debug APK may also use a different debug certificate from the published one. The certificates of all three published 1.0.0 APKs differ from the corresponding r5 APKs, and neither set includes a signing-key rotation lineage. **This release cannot update r5 in place.** It supports a fresh installation on a device without r5; a data-preserving migration from r5 has not been tested. [Measured certificate comparison](RELEASES.md#android-r5-update-compatibility).

If Android reports a signature conflict, keep the existing installation and its data while checking the source of the old and new APKs. Do not replace a production signing key or uninstall an app solely to force the update. See the [Android signing instructions](ANDROID.md#build-and-install).

## Obtainium

[Obtainium](https://obtainium.imranr.dev/) can track and download the Android previews from the official GitHub releases. It is an optional Android app, not an account or service required by Waarp.

### Import the prepared configuration

1. Install Obtainium from its [official releases](https://github.com/ImranR98/Obtainium/releases).
2. Download [`obtainium.json`](https://raw.githubusercontent.com/INNVoices/waarp/main/docs/distribution/obtainium.json).
3. In Obtainium's **Import/Export** screen, import that JSON file and confirm the Waarp entry.
4. Refresh the entry, then review and install the APK selected for your device. Importing the configuration does not silently install Waarp or grant VPN permission.

The configuration tracks the **debug preview package**. It includes prereleases, skips releases without a matching Android APK, and enables Obtainium’s architecture filter. Release selection checked for this publication: **`preview-2026-11-22-r2`, with one debug APK for each of ARM64, ARM32 and x86_64**. It does not switch an installation to the production package or bypass Android’s certificate check: downloading the new APK through Obtainium does not make it compatible with an installed r5.

A direct import link is also available on the [project page](https://innvoices.github.io/waarp/#obtainium). If a browser does not open Obtainium, use the file import or manual setup below.

### Manual setup

Add this source URL in Obtainium:

```text
https://github.com/INNVoices/waarp
```

Use the following per-app settings; labels can differ with Obtainium's language.

| Setting | Value |
| --- | --- |
| Include prereleases | On |
| Include drafts | Off |
| Fall back to older releases | On |
| Sort releases | Release date |
| Verify latest tag | Off |
| APK filter / regular expression | Copy the expression below |
| Invert APK filter | Off |
| Automatically filter APKs by architecture | On |
| Include ZIP / tarball files | Off |
| Track only | Off |

The pipes in the APK expression are literal `|` characters separating the three architectures. Copy the complete expression from this code block:

```text
^waarp-android-.+-(arm64-v8a|armeabi-v7a|x86_64)-debug\.apk$
```

Keep the detected package ID as `local.waarp.android.debug`. Public downloads do not require a GitHub token. If no compatible APK appears, use the explicit device download above and check your device's ABI; do not select a different architecture just to clear the error.

The settings and file-import format were checked against Obtainium **v1.7.4** source and the published release asset list. An on-device Obtainium installation and update were not run for this documentation change. [Configuration and verification details](distribution/README.md).

## Verify a download

All four binaries below were downloaded anonymously in full. Their measured sizes and SHA-256 matched GitHub asset metadata and the release checksum manifests on **2026-11-22 18:51:59 UTC**. They identify these exact preview files; the [release record](RELEASES.md#published-preview-2026-11-22-r2) describes the scope of independent verification.

| File | SHA-256 |
| --- | --- |
| `Waarp-1.0.0-portable.exe` | `7bf6d41fec29da36ba8a23544a0653607d8b1a1a611bfe8eb43df0163f7b92c9` |
| `waarp-android-1.0.0-arm64-v8a-debug.apk` | `b935b8c65c78789c36bfd20e10ba91cb112f83be85b2507991713e7af0680196` |
| `waarp-android-1.0.0-armeabi-v7a-debug.apk` | `6e4f2119efd1a86dacd8e2b90a2eb3638efd434b359caf98410c84a99a0ae677` |
| `waarp-android-1.0.0-x86_64-debug.apk` | `6b88cd976e26547501d3d6da3217d7f8ef5a5b76a85a5ce5e7d5f3278a138178` |

Checksum files: [Windows](https://github.com/INNVoices/waarp/releases/download/preview-2026-11-22-r2/SHA256SUMS-windows.txt) · [Android](https://github.com/INNVoices/waarp/releases/download/preview-2026-11-22-r2/SHA256SUMS-android-debug.txt).

On Windows, open PowerShell in the download folder and run:

```powershell
Get-FileHash -Algorithm SHA256 .\Waarp-1.0.0-portable.exe
```

Replace the filename to check an APK. On Linux, use `sha256sum <filename>`; on macOS, use `shasum -a 256 <filename>`. Compare the complete result with the appropriate value above. A match checks file integrity; it is not an independent security audit.

## Need help?

Use [Support](../SUPPORT.md) for a reproducible issue report. Include the platform, the downloaded filename/version, and the relevant error with private connection credentials removed. See [Security](../SECURITY.md) for private vulnerability reports.

### Коротко по-русски

Скачай файл для своей системы из таблицы: **preview 1.0.0 для Windows и Android**. Windows EXE без цифровой подписи; Android APK имеют debug-подпись и устанавливаются отдельно от production-приложения. Перед запуском сравни SHA-256. Для включения туннеля Windows потребует права администратора, Android — системное разрешение VPN. Новые APK подписаны другим сертификатом и не обновляют Android r5 поверх существующей установки. Для первой установки нужно устройство без r5; прежнее приложение и данные сохрани. Для Obtainium готовый JSON и ручные настройки находятся [выше](#obtainium).
