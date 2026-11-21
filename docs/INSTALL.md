# Install Waarp

After installation, follow the [first-route walkthrough in Russian](guides/first-routes.md): one personal profile, one application, a Direct comparison and then a separate domain rule. It matches the public Windows r6 / Android r5 previews and explains what each check does and does not prove.

Choose a published build for your device. You do not need Node.js, a compiler or a GitHub account to download it.

## Downloads

**Published preview builds, checked 20 November 2026:** Windows `0.4.1-rc.5` (r6) and Android `0.5.0-rc.5` (r5). These are prereleases. The `1.0.0` source version in the checkout does not change the version of an already published binary.

| Device | Download | Build |
| --- | --- | --- |
| Windows 10/11, x64 | [Windows portable EXE](https://github.com/INNVoices/waarp/releases/download/preview-2026-11-18-r6/Waarp-0.4.1-rc.5-portable.exe) | r6; unsigned |
| Android 10+, ARM64 | [Android ARM64 APK](https://github.com/INNVoices/waarp/releases/download/preview-2026-11-18-r5/waarp-android-0.5.0-rc.5-arm64-v8a-debug.apk) | r5; debug-signed |
| Android 10+, 32-bit ARM | [Android ARM32 APK](https://github.com/INNVoices/waarp/releases/download/preview-2026-11-18-r5/waarp-android-0.5.0-rc.5-armeabi-v7a-debug.apk) | r5; debug-signed |
| Android 10+, x86_64 | [Android x86_64 APK](https://github.com/INNVoices/waarp/releases/download/preview-2026-11-18-r5/waarp-android-0.5.0-rc.5-x86_64-debug.apk) | r5; debug-signed |

Choose ARM64 for most current Android phones. Use ARM32 or x86_64 only if it matches your device. All three Android downloads contain the app; they are alternatives, not split APKs that must be installed together.

[Windows release notes](https://github.com/INNVoices/waarp/releases/tag/preview-2026-11-18-r6) · [Android release notes](https://github.com/INNVoices/waarp/releases/tag/preview-2026-11-18-r5) · [All releases](https://github.com/INNVoices/waarp/releases) · [Build from source](../README.md#build-the-100-source-on-a-windows-pc)

The Windows-only r6 release contains no Android APK. Use the Android links above or the Obtainium configuration below instead of choosing the newest release solely by its position in the list.

## Windows: first run

1. Download the portable EXE and [check its SHA-256](#verify-a-download).
2. Save it in a folder you control and open it. The current preview has no publisher signature, so Windows may show an unknown-publisher or reputation notice. Review the official download source and hash before deciding to run it; no change to Windows security settings is required by this guide.
3. Import a connection profile you control or trust. Add an application or domain rule and choose its connection. Use **Direct** for traffic you want to keep on the ordinary connection.
4. Turn the tunnel on. Starting the Windows tunnel requires administrator permission. If Waarp reports that elevation is required, use **Run as administrator** for the verified EXE and review the Windows permission prompt.
5. Open the target app or website and inspect the route and diagnostics in Waarp. Turn the tunnel off when you finish.

The optional public-node catalog contains third-party endpoints. A successful check describes reachability from your network at that moment. It does not establish who operates the endpoint or its privacy practices.

If another VPN already owns the full system route, stop or reconfigure it before starting Waarp. Follow a startup error's specific guidance. See [connection tools](CONNECTION-TOOLS.md) and [network lifecycle behavior](RELIABILITY.md).

## Android: first run

1. Download the APK matching your device and [check its SHA-256](#verify-a-download).
2. Open the downloaded file. If Android asks, allow your browser, file manager or Obtainium to install this app. This permission is specific to the app performing the installation.
3. Open Waarp, import a connection profile, and choose the apps or domains and their routes.
4. Turn the tunnel on and review Android's **VPN connection** permission. The system VPN permission is required for the selected traffic to pass through Waarp.
5. Check the connection in your target app and the status shown by Waarp. Android displays a foreground notification while the VPN service is running.

These APKs install as **`local.waarp.android.debug`**. They are a separate preview app from the production package `local.waarp.android`.

### Updating and signatures

Update an existing installation only with a build using the same package identity and signing certificate. The debug preview cannot update a production-signed installation. A locally built debug APK may also use a different debug certificate from the published one.

If Android reports a signature conflict, keep the existing installation and its data while checking the source of the old and new APKs. Do not replace a production signing key or uninstall an app solely to force the update. See the [Android signing instructions](ANDROID.md#build-and-install).

## Obtainium

[Obtainium](https://obtainium.imranr.dev/) can track and download the Android previews from the official GitHub releases. It is an optional Android app, not an account or service required by Waarp.

### Import the prepared configuration

1. Install Obtainium from its [official releases](https://github.com/ImranR98/Obtainium/releases).
2. Download [`obtainium.json`](https://raw.githubusercontent.com/INNVoices/waarp/main/docs/distribution/obtainium.json).
3. In Obtainium's **Import/Export** screen, import that JSON file and confirm the Waarp entry.
4. Refresh the entry, then review and install the APK selected for your device. Importing the configuration does not silently install Waarp or grant VPN permission.

The configuration tracks the **debug preview package**. It includes prereleases, skips releases without a matching Android APK, and enables Obtainium's architecture filter. With the public releases checked above, it skips Windows r6 and selects Android r5. It does not switch an installation to the production package.

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

The following values are the SHA-256 asset digests reported by GitHub for the linked releases, checked on 20 November 2026. They identify these exact preview files.

| File | SHA-256 |
| --- | --- |
| `Waarp-0.4.1-rc.5-portable.exe` | `3cdd81a22ddb48d655714351a2ed581b608b680140f51c8b657fb994a6bf1317` |
| `waarp-android-0.5.0-rc.5-arm64-v8a-debug.apk` | `f8584c314e72c2510974abcd2b977a82532d8717203970d974255318877c0a93` |
| `waarp-android-0.5.0-rc.5-armeabi-v7a-debug.apk` | `ca5ef46b87c2e5f53b329018a0280763256ec07d57501cc05d556535ab97f981` |
| `waarp-android-0.5.0-rc.5-x86_64-debug.apk` | `1907d4242bf01543327a30926ac4c375a662ab871284d52e5381c1d8431dff31` |

Checksum files: [Windows r6](https://github.com/INNVoices/waarp/releases/download/preview-2026-11-18-r6/SHA256SUMS-windows.txt) · [Android r5](https://github.com/INNVoices/waarp/releases/download/preview-2026-11-18-r5/SHA256SUMS-android-debug.txt).

On Windows, open PowerShell in the download folder and run:

```powershell
Get-FileHash -Algorithm SHA256 .\Waarp-0.4.1-rc.5-portable.exe
```

Replace the filename to check an APK. On Linux, use `sha256sum <filename>`; on macOS, use `shasum -a 256 <filename>`. Compare the complete result with the appropriate value above. A match checks file integrity; it is not an independent security audit.

## Need help?

Use [Support](../SUPPORT.md) for a reproducible issue report. Include the platform, the downloaded filename/version, and the relevant error with private connection credentials removed. See [Security](../SECURITY.md) for private vulnerability reports.

### Коротко по-русски

Скачай файл для своей системы из таблицы: **Windows r6 / Android r5**. Это предварительные сборки: Windows EXE пока без цифровой подписи, Android APK подписаны debug-ключом и устанавливаются отдельно от production-приложения. Перед запуском сравни SHA-256. Для включения туннеля Windows потребует права администратора, Android — системное разрешение VPN. В Obtainium включи prereleases и поиск подходящего APK в более ранних релизах: последний Windows-релиз не содержит Android. Готовый JSON и ручные настройки находятся [выше](#obtainium).
