<p align="center"><img src="docs/brand/waarp-cover.svg" width="100%" alt="Waarp · per-app routing for Windows and Android"></p>

<p align="center"><strong>Windows 10/11 x64 · Android 10+ · Public preview builds</strong><br>
English · <a href="README.ru.md">Русский</a> · <a href="https://innvoices.github.io/waarp/en/">Project page</a> · <a href="docs/INSTALL.md">Install</a> · <a href="docs/README.md">Documentation</a></p>

# Choose a connection for each app

Waarp is an open-source VPN and proxy routing client for Windows and Android. Route a browser through a personal connection, send a domain through another and keep other traffic direct.

## Download and install

| Platform | Download | Verify |
| --- | --- | --- |
| Windows 10/11 x64 | **[Download portable EXE](https://github.com/INNVoices/waarp/releases/download/preview-2026-11-22-r2/Waarp-1.0.0-portable.exe)** · 1.0.0, unsigned | [SHA-256 list](https://github.com/INNVoices/waarp/releases/download/preview-2026-11-22-r2/SHA256SUMS-windows.txt) · [Release notes](https://github.com/INNVoices/waarp/releases/tag/preview-2026-11-22-r2) |
| Android 10+ · ARM64 | **[Download APK](https://github.com/INNVoices/waarp/releases/download/preview-2026-11-22-r2/waarp-android-1.0.0-arm64-v8a-debug.apk)** · 1.0.0, debug-signed | [SHA-256 list](https://github.com/INNVoices/waarp/releases/download/preview-2026-11-22-r2/SHA256SUMS-android-debug.txt) · [Release notes](https://github.com/INNVoices/waarp/releases/tag/preview-2026-11-22-r2) |

Other Android architectures: **[ARM32](https://github.com/INNVoices/waarp/releases/download/preview-2026-11-22-r2/waarp-android-1.0.0-armeabi-v7a-debug.apk)** · **[x86_64](https://github.com/INNVoices/waarp/releases/download/preview-2026-11-22-r2/waarp-android-1.0.0-x86_64-debug.apk)**. ARM64 is the usual choice for current phones.

For Android downloads through Obtainium, see the [import and update instructions](docs/INSTALL.md#obtainium).

These **1.0.0 preview** builds come from one exact source commit in [preview-2026-11-22-r2](https://github.com/INNVoices/waarp/releases/tag/preview-2026-11-22-r2). Windows is unsigned; Android APKs are debug-signed. They are prereleases with the checks and limitations recorded in [release status and evidence](docs/RELEASES.md#published-preview-2026-11-22-r2). Later changes on `main` do not change these files.

Follow the **[installation and first-route guide](docs/INSTALL.md)** and compare your download with the checksum list from the same release. Windows needs elevation to start the tunnel. Android asks for the system VPN permission; its debug APKs install separately as `local.waarp.android.debug` and cannot update a production installation. Production updates require the original signing identity. The three Android APKs use a different certificate from the older r5 debug preview and cannot update it in place. They are for a fresh installation on a device without r5; existing r5 users should keep their installation and data. [Certificate comparison](docs/RELEASES.md#android-r5-update-compatibility).

## What you can route

Both clients support saved profiles, groups and an optional catalog of third-party public nodes. Automatic selection uses eligible profiles from your library.

| Windows | Android |
| --- | --- |
| Assign routes to processes, services and domains. Inspect the active path, traffic counters and connection diagnostics. | Set per-app and domain rules, import profiles and change routes from the native Kotlin client. |
| [Desktop routing](docs/SERVER-SELECTION-2026-11-18.md) · [Diagnostics and maps](docs/CONNECTION-TOOLS.md) | [Android guide](docs/ANDROID.md) · [Build and signing](docs/ANDROID.md#build-and-install) |

[![Windows server catalog in the historical r6 preview](docs/screenshots/preview-r6/desktop-public-real-1240.png)](docs/screenshots/preview-r6/README.md)

Public nodes belong to third parties; availability depends on the node and your network. The Windows client checks its engine at startup and protects stored secrets with DPAPI; Android uses Android Keystore. Waarp has no independent Windows firewall kill switch: if its engine exits, Windows may resume its normal network route. [Reliability](docs/RELIABILITY.md) · [Public node sources](docs/SOURCES.md) · [Security reports](SECURITY.md).

## Build the 1.0.0 source on a Windows PC

| Command | Output |
| --- | --- |
| `build.bat 1` | Unpacked desktop client in `dist/win-unpacked/` |
| `build.bat 2` | Versioned portable EXE in `dist/` |
| `build.bat apk` | Verified debug APKs for ARM64, ARM32 and x86_64 in `out/android/` |

Use Node.js 22. Android also needs JDK 17 and Python 3. Its native engine is in the checkout. The first Android build downloads the SDK platform and build tools (about 125 MB), Gradle and Maven dependencies. Later builds reuse the local cache. The [component map and code acceptance record](docs/V1.md) describes the 1.0.0 source and its verification limits; it does not replace the published preview records.

## Interface languages in the 1.0.0 source

Both clients follow the system language preferences and fall back to Russian. Android 13 and later also support per-app language selection in system settings. The current source includes Russian, English, German, French, Spanish, Brazilian Portuguese, Simplified and Traditional Chinese, Japanese, Korean, Ukrainian, Italian, Polish, Turkish, Arabic, Hindi, Indonesian, Vietnamese and Persian. These locale resources are included in the 1.0.0 preview; structural checks do not establish complete linguistic or visual review of every language.

## Project

[Contributing](CONTRIBUTING.md) · [Support](SUPPORT.md) · [Roadmap](ROADMAP.md) · [Screenshots](docs/screenshots/README.md) · [All releases](https://github.com/INNVoices/waarp/releases) · [Third-party credits](THIRD_PARTY_NOTICES.md)

Desktop application code uses [Apache-2.0](LICENSE). Android application code uses [GPL-3.0-or-later](android/LICENSE). Engine and dependency notices ship with each client.
