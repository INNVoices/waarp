# Waarp Android

Android is implemented in this repository under `android/`. Build products go to **`out/android/`**. Version **0.5.0-alpha.1** identifies the first mobile validation candidate, not an approved stable release.

## Platform

- Android 10 / API 29 minimum; compile/target API 36.
- Native Kotlin 2.2.21, Compose and Material 3. Four Russian-language destinations: **Главная**, **Маршруты**, **Туннели**, **Диагностика**; settings are separate. Bottom navigation on phones, navigation rail on wider displays.
- Real Android `VpnService`, system consent, foreground notification, revoke handling, underlying-network monitoring and protected native sockets.
- In-process **sing-box-lx 1.14.4-lx.35** Android AAR, Go 1.26.10. Source commit, download, size, AAR SHA-256 and native library hashes are pinned in `android/app/src/main/res/raw/engine_integrity.json`.
- Release package `local.waarp.android`; debug package `local.waarp.android.debug`. Separate APKs for `arm64-v8a`, `armeabi-v7a` and `x86_64`; most current phones need arm64. The install helper queries the actual device ABI.
- The Android AAR excludes Clash REST. Mobile uses the real native `CommandServer` / `CommandClient` APIs for status, selectors, URL tests, connections, DNS observations and logs.

## Functional mapping

| Function | Android implementation |
| --- | --- |
| ON/OFF | Consent, foreground service, generation-checked start/stop and cancellation during startup |
| Selected targets / whole device | Explicit app/service/domain/IP/CIDR rules plus a selected default path |
| Windows EXE/folder rules | Installed Android package names and socket-owner UID; conflicting rules for shared UIDs are reported |
| Service presets | YouTube, Discord, Telegram, ChatGPT/OpenAI/Codex, Claude, Gemini, Meta, X/Grok, Spotify and developer services |
| Tunnel library | Add, rename, replace, delete and explicitly reassign dependent routes; IDs survive replacement |
| Import | SAF documents/multiple files, explicit clipboard action, QR, text, Amnezia `vpn://` containers and HTTPS subscriptions |
| Protocols | WireGuard, AmneziaWG 1/2, VLESS TLS/REALITY/XHTTP/WS/gRPC, VMess, Trojan, Shadowsocks, Hysteria2, TUIC v5, embedded OpenVPN client files |
| Manual WireGuard | Real Curve25519 key generation and a public client key for server enrollment |
| Subscriptions | Manual refresh, stable unique identities across endpoint rotation/local rename, missing and ambiguous entries handled without stealing another route's ID |
| Groups and Auto | Ordered first-working and sticky-fastest policies; public/revoked/missing profiles excluded from Auto, at most 16 extra Auto-only live profiles |
| Backup paths | Explicit tunnel/group fallback; missing primary paths compile to rejection; no automatic Direct fallback |
| Shared Android DNS | An explicit common DNS path for OS resolver requests without app attribution; automatic selection uses the protected default or a single common protected app path |
| Public catalog | Six desktop sources, refreshed explicitly; up to eight nodes measured per operation, with failed primary probes trying the independent secondary target; a group contains up to five successful nodes from the measured sample |
| Diagnosis | Actual physical-network DNS, DoH, TCP, certificate-verified TLS and HTTP observations plus separate native outbound URL tests |
| Connections/history/log | Native records with package/outbound evidence, bounded real latency history and redacted bounded engine logs |
| Recovery | Cancel/stop, wait for cleanup, reread current encrypted state; stale cached configuration cannot resurrect deleted profiles |
| Autostart | Optional connection when opening Waarp; device Always-on and lockdown remain Android system settings |
| Other clients' files | Android sandbox boundaries are respected: use the document picker or explicitly share from the source app |
| Desktop companion IPC | Android share and `waarp://import?config=…` require explicit import confirmation; no unauthenticated local mutation server |

Import never automatically changes routes or starts the VPN. Unknown security-sensitive options, executable OpenVPN hooks, external credential files, invalid keys and incomplete verification constraints are rejected. JSON/YAML/text containers are supported by extracting share links, not by converting arbitrary foreign native schemas.

## Runtime policy

`WaarpApplication` owns the repository/controller. Service operation, health sampling and selector decisions continue without a visible Activity. The Always-on configuration provider reads the current encrypted repository after process recreation.

OFF invalidates in-flight work immediately. Native lifecycle operations and the headless checker share one serial lane. A checker cannot instantiate a second WireGuard instance while VPN is active; ON checks use existing outbounds. No measurement means unknown. A default health round tries the desktop's Google target and, only for failed paths, its independent Cloudflare target. Two failed rounds are needed to mark a path down. A requested diagnostic URL is measured exactly, even if it happens to equal a health URL. Session changes and cancellation discard stale results and prevent a secondary request. A healthy path is held during active traffic. A speed-driven change requires five substantial consecutive improvements from the same challenger.

Android additionally caps one active configuration at 64 loaded profiles and 16 WireGuard/AmneziaWG/OpenVPN endpoints. Auto fits within the remaining budget. These are conservative mobile resource limits, separate from the 2,000-profile library. Exceeding an explicit active-group budget is reported before saving/starting; profiles are not silently omitted from explicit routes.

Imports undergo native validation in batches of at most eight profiles before any data is committed. The native check constructs real endpoint objects, including a WireGuard netstack; it must not allocate all 2,000 possible library entries in one check-only instance.

Writes are serialized and natively validated. When a running configuration changes, the old core is stopped before the atomic encrypted write and restart. Concurrent user OFF cancels the restart. A changed endpoint invalidates its old measurements. Deleting without reassignment leaves blocked intent; reassignment is checked against the final state, including empty replacement groups.

App rules precede custom-host and preset rules. LAN and optional `.ru`/`.su`/`.рф` Direct exceptions are explicit. In selected mode with protected app routes, traffic without an identifiable app or an explicit matching destination rule is rejected instead of falling through to Direct. IPv4-only WireGuard/OpenVPN paths reject unsupported IPv6. ON confirms a local Android/native VPN, not reachability of every remote server. Without Android lockdown, loss/stopping of VPN can allow normal direct networking; this is not labelled a persistent kill switch.

Android 10/11 can report the system resolver's UID (`1051`, `netd`) instead of the requesting app. Socket ownership can also disappear transiently on newer Android versions, as observed in the API 36 OFF/ON test. The compiler preserves real ownership. Its shared-DNS rules cover netd and missing package metadata, follow explicit package/domain rules, and use `settings.systemDnsVia` when selected. In automatic mode they use the protected whole-device path, or the single common protected app path including its configured fallback. Conflicting app paths or a missing selected DNS path reject these unattributed requests; the UI explains how to select a common tunnel/group. Direct is used only when explicitly selected or when no protected app/default path exists. Deletion without reassignment preserves the blocked DNS intent. This limitation and the distinction from per-app traffic routing are also documented by [Rethink's Android implementation](https://github.com/celzero/rethink-app#network-monitor).

The app UID remains inside the Android TUN so the pinned mixed/system TCP forwarder's listener replies can traverse its reverse NAT. Excluding this UID caused TCP SYNs to stall while UDP still worked. Native external sockets bypass the VPN individually through `protect(fd)`. Subscription/catalog HTTPS and physical diagnostics bind explicitly to the physical Android network; the app's own routing and DNS bootstrap rules remain Direct/local.

## Storage

Application state is an atomic AES-256-GCM file protected by an Android Keystore key. Backup and device transfer are disabled. Unreadable state is preserved and reported, not silently replaced with defaults.

The native AAR internally writes a temporary configuration snapshot during startup. The wrapper purges old snapshots before native setup, removes new snapshots after successful/failed startup and cleanup, and refuses ON when required cleanup fails. The file resides in the private no-backup directory. This native-startup exception is stated explicitly: secrets exist in native memory and can briefly exist in that temporary native file.

Config/key material is not passed to service-start Intents, screen DTOs, Bundle or rememberSaveable. A shared report contains versions, API/ABI, state, counts and coarse outcomes; it excludes profiles, endpoints, subscription URLs and raw connection logs. Android's chooser leaves the recipient to the user.

## Build and install

Requirements: JDK 17, Android SDK command-line tools, `platforms;android-36`, `build-tools;35.0.0`, `platform-tools`, Node.js and Python 3. Set `JAVA_HOME`/`ANDROID_HOME` and accept the SDK license. The committed Gradle 8.13 wrapper verifies its distribution checksum.

```sh
npm run android:build
python3 scripts/android-install.py --variant debug --launch
```

The build fetches/verifies the AAR, runs JVM tests and lint, builds debug/release/instrumentation APKs, verifies actual APK contents and writes `out/android/`.

```sh
npm run android:core:fetch
npm run android:core:verify
cd android
./gradlew --no-daemon testDebugUnitTest lintDebug
./gradlew --no-daemon assembleDebug assembleDebugAndroidTest
./gradlew --no-daemon assembleRelease
cd ..
npm run android:collect
```

APK verification records the actual version from the APK and checks package/ABI/SDK, signature mode, manifest properties, license assets, exact native bytes, ELF and actual ZIP 16 KB alignment. Build phases run in separate Gradle processes so lint/compiler state does not increase R8's peak memory use.

### Signing

Without signing configuration, output contains installable **debug** APKs and explicitly named **release-unsigned** APKs. Unsigned files are signing inputs and cannot be installed normally. Production signing requires all four environment variables:

```text
WAARP_ANDROID_KEYSTORE
WAARP_ANDROID_STORE_PASSWORD
WAARP_ANDROID_KEY_ALIAS
WAARP_ANDROID_KEY_PASSWORD
```

Keep the production keystore/credentials outside Git and retain the key for subsequent updates. Debug keys are development identities. Debug and release have different package IDs and can be installed separately.

## Executable acceptance

GitHub Actions builds once and runs the same actual instrumentation APK on API 29, API 35 and API 36 `google_apis_ps16k`. The runner verifies actual `PAGE_SIZE`, and rejects empty suites, failures, crashes, timeouts and skips.

The API 29 emulator has 2,048 MiB RAM; API 35 and API 36 with 16 KB pages have 4,096 MiB. All retain a 512 MiB ART heap setting. This corrects observed test-device resource failures: [run 43921779954](https://github.com/INNVoices/waarp/actions/runs/43921779954), API 36 at 2,048 MiB, recorded `ApplicationExitInfo reason=3 (LOW_MEMORY)`, app RSS `313MB`, and LMKD `min watermark is breached even after kill` while also killing Google/system processes and the launcher. Android and redirected Go crash buffers were empty. API 35 screenshots from the same run were obscured by the system **Pixel Launcher isn't responding** dialog. The memory change does not relax the native/configuration, traffic, UI or actual 16,384-byte page-size gates, and is not evidence of success until those gates run again.

Before instrumentation, the runner waits up to 30 seconds for Android's framework broadcast queues to become idle and records guest `/proc/meminfo`, a guest process-memory summary, and host `/proc/meminfo`. This global-queue observation is diagnostic: in [run 43925958101](https://github.com/INNVoices/waarp/actions/runs/43925958101), API 29's background Google/system queue grew from 84 to 112 ordered broadcasts during the bounded wait while all three app UI scenarios and foreground checks passed. A timeout remains explicitly recorded as `broadcastQueuesIdle=false`; it cannot establish that the tested app is unready. The mandatory test results, actual page size, traffic proofs and screenshots still determine acceptance. System dialogs and crash history are preserved, and app failures remain failures.

1. JVM parsers, security constraints, subscription reconciliation, route priority/rejection, IPv6 and bounded Auto.
2. Actual native build information and native config acceptance for every supported family.
3. Real native headless HTTP, Android VPN consent, TUN creation, shutdown and cancellation.
4. Actual traffic from another test APK UID through the TUN to a disposable local fixture, checked against native package/outbound records.
5. Actual encrypted AWG2 DNS traffic to a temporary Linux peer, OFF/ON and a fresh second round trip. The two sides generate private keys in memory and exchange only public keys. The host checks authenticated handshakes, AWG headers/padding, the absence of the test DNS payload in outer UDP, and final cleanup.
6. Installed Compose UI navigation/edit/recreate/delete behavior and screenshots.
7. APK integrity/lint, measured instrumentation duration, process memory and launch timings. Failed runs retain bounded Android/Go crash diagnostics and Android process-exit reasons from the disposable test device.

The fixture is not a user's private VPN server. Parser acceptance is not called a handshake. Emulator gates do not establish physical operator reachability, vendor power management, cellular/Wi-Fi handover, physical camera behavior or every protocol/server combination. These are additional device approval checks. The final audit records actual completed gates, not merely planned ones.

## Sources and licenses

Primary references: [Android VPN](https://developer.android.com/develop/connectivity/vpn), [16 KB guidance](https://developer.android.com/guide/practices/page-sizes), [pinned sing-box-lx source](https://github.com/Leadaxe/sing-box-lx/tree/f1bac271853eaf13398ce1030c948aebc3aed2e1), [sing-box Android client](https://github.com/SagerNet/sing-box-for-android), existing desktop parsers, and the official WireGuard Android Curve25519 implementation whose pinned provenance/Apache-2.0 attribution is retained.

The **Android app is GPL-3.0-or-later** because it links GPL libbox in-process. See `android/LICENSE`, the native/WireGuard provenance files and bundled `assets/licenses/` inventory. The existing desktop Apache-2.0 license remains separate. Waarp does not imply upstream endorsement.
