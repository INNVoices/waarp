# Waarp Android

Android 1.0.0 (version code 7) lives in `android/`. The local APK builder writes verified files to `out/android/`. See the [1.0.0 component and acceptance record](V1.md), [earlier routing audit](ROUTE-AND-CONNECTION-AUDIT-2026-11-18.md) and [native engine history](ANDROID-RC3-AWG.md).

## Platform

- Android 10 / API 29 minimum; compile/target API 36.
- Native Kotlin 2.2.21, Compose and Material 3. Four destinations (shown here in Russian): **Главная**, **Маршруты**, **Туннели**, **Диагностика**; settings are separate. Bottom navigation on phones, navigation rail on wider displays.
- Real Android `VpnService`, system consent, foreground notification, revoke handling, underlying-network monitoring and protected native sockets.
- In-process **sing-box-lx 1.14.4-lx.35-waarp.2** Android AAR, Go 1.26.10. This downstream build retains bounded DNS recovery and terminal-close ownership fixes and corrects WireGuard UDP GSO fallback. `android/native-source.json` locks the upstream source, patches, regression tests and toolchain; `android/app/src/main/res/raw/engine_integrity.json` locks the actual AAR, Java archive and each ABI's native bytes. See [DNS recovery evidence and contract](ANDROID-NATIVE-DNS-RECOVERY.md) and [the WireGuard correction](ANDROID-RC3-AWG.md).
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
| Protocols | WireGuard, AmneziaWG 1/2, VLESS TLS/REALITY/XHTTP/WS/gRPC, VMess, Trojan, Shadowsocks, Hysteria2 including declared port ranges/lists, TUIC v5, embedded OpenVPN client files, prepared MASQUE CONNECT-IP/WARP outbounds |
| Manual WireGuard | Real Curve25519 key generation and a public client key for server enrollment |
| Subscriptions | Manual refresh, stable unique identities across endpoint rotation/local rename, missing and ambiguous entries handled without stealing another route's ID |
| Groups and Auto | Ordered first-working and sticky-fastest policies; public/revoked/missing profiles excluded from Auto, at most 16 extra Auto-only live profiles |
| Backup paths | Explicit tunnel/group fallback; missing primary paths compile to rejection; no automatic Direct fallback |
| Shared Android DNS | An explicit common DNS path for OS resolver requests without app attribution; automatic selection uses the protected default or a single common protected app path |
| Public catalog | Six desktop sources, refreshed explicitly; up to eight nodes measured per operation, with failed primary probes trying the independent secondary target; a group contains up to five successful nodes from the measured sample |
| Diagnosis | Actual physical-network DNS, DoH, TCP, certificate-verified TLS and HTTP observations plus separate native outbound URL tests |
| Content check | Explicit 162,067-byte ASCII download with SHA-256; upload only with an owned HTTPS acknowledgement endpoint and the same active service path; unmeasured directions stay unknown |
| Offline evidence | Bounded allowlisted session/transfer history, preview/share/delete after OFF and process recreation; no credentials, subscription URLs or raw native logs |
| Compatible variants | Current tunnel details show a small set of applicable options, explicit OFF-only testing, current-network proof, manual apply and exact original rollback |
| Service downloads | Direct or an explicitly selected personal path, VPN Network binding, no hidden Direct fallback, encrypted last-known catalog cache |
| Connections/history/log | Native records with package/outbound evidence, bounded real latency history and redacted bounded engine logs |
| Recovery | Cancel/stop, wait for cleanup, reread current encrypted state; stale cached configuration cannot resurrect deleted profiles |
| Autostart | Optional connection when opening Waarp; device Always-on and lockdown remain Android system settings |
| Other clients' files | Android sandbox boundaries are respected: use the document picker or explicitly share from the source app |
| Desktop companion IPC | Android share and `waarp://import?config=…` require explicit import confirmation; no unauthenticated local mutation server |

Import never automatically changes routes or starts the VPN. Unknown security-sensitive options, executable OpenVPN hooks, external credential files, invalid keys and incomplete verification constraints are rejected. JSON/YAML/text containers support share-link extraction and a strict allowlisted MASQUE outbound format; arbitrary foreign runtime schemas, listeners and filesystem references are rejected. WARP registration is not performed by this importer.

## Runtime policy

`WaarpApplication` owns the repository/controller. Service operation, health sampling and selector decisions continue without a visible Activity. The Always-on configuration provider reads the current encrypted repository after process recreation.

Ordinary edits within a compatible live plan use selectors and individually acknowledged local rule files, keeping the same core/TUN. Deleting the last route does not express OFF. Failed updates roll back under a targeted reject guard; an unconfirmed rollback remains visible and requires explicit recovery rather than silently restarting or using Direct. New native definitions and resource-budget changes remain structural. The compiler bounds file watchers to at most 112 and leaves room under the observed Android inotify limit; oversized policies use the existing static compiler with a visible explanation. Startup verifies actual watcher reloads before reporting ON.

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

### Build on Windows

Run `build.bat apk` from the checkout with Node.js 22, JDK 17 and Python 3 on PATH. The source tree includes the compressed native engine. The builder restores it locally and checks its size and SHA-256 before Gradle can use it. No GitHub account or Actions artifact is required.

On first use the builder asks for the SDK license and installs Android platform 36 and Build Tools 35.0.0 (about 125 MB of SDK downloads). Gradle 8.13 and Maven dependencies are cached separately under `.android-local/`. The first build needs network access for those dependencies. Subsequent builds can reuse them. The quick build checks one debug APK per supported ABI in `out/android/`.

### Build and verify all variants

Set `ANDROID_HOME` and `JAVA_HOME` and run `npm run android:build` for JVM tests, lint, debug and release variants, acceptance APKs and artifact verification. Release signing uses the existing external identity described below. A debug installation has a separate package ID.

To reproduce the native library itself on Linux, use `scripts/android-core-build.py` and the exact inputs in [the source lock](../android/native-source.json). Native source reproduction requires the pinned Go toolchain and NDK. The packaged library is distributed under the terms in [the bundled engine license and notices](../android/app/src/main/assets/licenses/).

CI preserves Gradle's downloaded dependencies on the default branch and on pull requests from this same repository. Fork pull requests and non-default-branch dispatches retain read-only caching. The pinned [setup-gradle action](https://github.com/gradle/actions/blob/48b5f213c81028ace310571dc5ec0fbbca0b2947/docs/setup-gradle.md) scopes a PR's saved cache to that PR; a first cold build still needs repository access. This avoids repeating full dependency downloads on every update, following [Maven Central's HTTP 429 guidance](https://central.sonatype.org/faq/429-error/). Dependency versions, repositories and all build/runtime gates remain unchanged; rate-limit failures are retained as failures and are not retried automatically.

```sh
npm run android:core:fetch
npm run android:core:verify
# Inspect out/android-core/ for source-build and native regression proofs.
cd android
./gradlew --no-daemon :app:testDebugUnitTest :app:lintDebug :app:lintRelease
./gradlew --no-daemon :app:assembleDebug :app:assembleDebugAndroidTest
./gradlew --no-daemon :app:assembleRelease :acceptance:assembleRelease
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

Keep the production keystore/credentials outside Git and retain the key for subsequent updates. `android/release-signing.json` pins the public update certificate. The verifier rejects a release signed by another identity. Debug keys are development identities. Debug and release have different package IDs and can be installed separately.

For an unsigned CI build, sign the exact accepted inputs locally with the retained private identity:

```sh
python3 scripts/android-sign.py sign-apks --credentials /absolute/private/path/waarp-android-signing-credentials.json
```

`android-sign.py` compares every APK ZIP payload entry before and after signing; the code, resources and native libraries must be unchanged. Passwords are supplied to signing tools through their supported environment inputs, never command-line values. The private key is not placed in `out/`, Git, CI variables or public artifacts. CI installs the same optimized release payload with a disposable test certificate that cannot update the production installation. The final production signature is applied only after accepting those exact payload hashes.

Use the offline [release evidence bundle checker](ANDROID_RELEASE_EVIDENCE.md) to bind exported Actions archives, three unsigned APKs, raw release acceptance evidence and optional retained-key signing reports before a release review. It does not sign, publish or establish historical production-upgrade compatibility.

## Production hardening in rc.1

The service cancels a suspended current-configuration provider before queued shutdown, preventing a repository/native-lane lock inversion. A validated configuration edit commits stop/write/restart as one cancellation-safe transaction while preserving a later explicit OFF/revoke. Telemetry reconnects remember a stream failure that arrives during connection establishment; a failed subscription cannot publish ON. Native URL-test cancellation closes its own command client without waiting on the UI thread.

Process recovery combines Android's `START_STICKY` path with an independent `VpnRecoveryWatchdog` fallback. Android can unbind a dead TUN owner before handling process death, losing the expected sticky restart. Waarp's implementation was written independently after reviewing [AOSP ActiveServices](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/android16-release/services/core/java/com/android/server/am/ActiveServices.java), [AOSP Vpn](https://android.googlesource.com/platform/frameworks/base/+/refs/heads/android10-release/services/core/java/com/android/server/connectivity/Vpn.java), and the GPLv3 [LxBox analysis at commit `71d3379c8bb7a7d276d440be5ac3ada3a8cd9eef`](https://github.com/Leadaxe/LxBox/blob/71d3379c8bb7a7d276d440be5ac3ada3a8cd9eef/docs/spec/tasks/428-vpn-service-start-sticky.md). It does not rely exclusively on a platform sticky restart.

An explicit, immutable alarm to a non-exported receiver is scheduled with `AlarmManager.ELAPSED_REALTIME` for 30 seconds later. While the runtime is ON, a heartbeat every 10 seconds postpones that alarm. This is a non-wakeup, inexact alarm: no exact-alarm permission or wake lock is requested. Android may batch or defer delivery during Doze or device sleep, so 30 seconds is a scheduling target and the emulator's 90-second recovery gate is not a physical-device timing promise. Alarm extras contain only recovery epoch and process identity; configuration is loaded from the current encrypted store.

Both platform and alarm recovery share `RecoveryPolicy`: at most two attempts in a rolling five-minute window, separated by at least five seconds. Exhaustion or lost VPN consent stops automatic recovery and surfaces an error; an explicit new ON resets the recovery session. OFF/revoke clears the persisted ON intent and recovery epoch and cancels the alarm. Epoch and runtime-generation checks reject stale deliveries. An alarm delivered to its still-living originating process only rearms itself, and recovery respects the intentional pause during a configuration edit rather than starting a competing session.

Auto's active-flow guard now uses all real active outbound/chain tags, independent of the 500-row UI display limit. Unknown telemetry is not treated as an idle connection set. Android network callbacks consume their ordered arguments and invalidate same-interface address changes instead of rereading racing ConnectivityManager snapshots inside callbacks.

UI projection runs on a background dispatcher with unchanged-section caches. The installed-app icon cache is bounded, large lists are lazy, and log keys survive bounded-ring rollover. Tab filters/scroll positions survive navigation. Modal drafts and import work survive Activity rotation without placing private configurations in saved Bundles. Only nonsensitive file-picker metadata survives process recreation. Accepted mutations are owned by the ViewModel, so scrolling a card away or switching tabs does not discard the action; cancellable diagnostic work stays cancellable.

Subscription/catalog downloads and HTTP diagnostics use pinned [OkHttp 5.4.0](https://github.com/lysine-dev/okhttp), Android's cancellable DNS resolver and explicit physical-network sockets. This official Android variant retains the API36/AGP8 toolchain and bounds HTTP/2 response-header decoding; OkHttp5.5.x requires compileSdk37. A narrowly adapted upstream certificate blocklist checks the validated connection chain before HTTP request headers are sent, while retaining platform trust and hostname checks. See [the security review, exact upstream sources and regression coverage](ANDROID-HTTP-SECURITY.md). Cancellation remains effective before connection creation, and a total deadline bounds redirect chains and slow response trickles. Bounded reads apply to decompressed response bytes. Actual localhost socket regression tests exercise stalled headers, trickle cancellation and independence of simultaneous calls.

## Optimized release approval

Before APK compilation, a fresh source build applies the hashed native patch to the exact upstream and gitlink revisions. The native transport package must pass its race-enabled regressions, including every required downstream test. The resulting canonical AAR and all three native libraries must match the independently frozen candidate bytes. Native test, source and binary provenance are retained with build reports. An unexpected existing AAR, missing test, changed source input or binary mismatch fails this gate; bootstrap output is not release approval.

The debug instrumentation suite remains a regression gate. A separate `com.android.test` module under [`android/acceptance`](../android/acceptance/README.md) exercises the actual R8-minified, nondebuggable release via UI Automator from a different UID. It does not load production classes, change keep rules or add runtime test hooks. This follows Android's [guidance to test release optimizations](https://developer.android.com/topic/performance/app-optimization/test-the-optimization).

Release journeys run on API 29/35/36: real UI import and selected-app routing, encrypted AWG2 DNS plus 64 KiB HTTP payloads, OFF/ON, rename, background operation, SIGKILL followed by production recovery through Android's sticky path or Waarp's watchdog, persisted configuration, deletion with blocked intent and cleanup. The first recovery must produce a different PID and successful encrypted DNS/HTTP within the unchanged 90-second deadline, without the test relaunching the target. After UI OFF and cleanup, a second real SIGKILL must leave the process and VPN absent for at least 90 seconds, followed by a fresh blocked inner DNS request. Raw `release-smoke-off-observations.jsonl` records and host validation must confirm that OFF remains stopped throughout that observed window. The independent Linux peer records authenticated traffic and unique request counts; the host reconciles these against device observations.

After all three native/UI and all three release journey jobs pass, API 36 with actual 16,384-byte pages runs **7,200 real seconds** of encrypted traffic, including screen-off, observed deep Doze and observed physical-network loss/recovery. Memory, allocated heaps, thread and descriptor counts must remain within the predetermined budgets in the acceptance README. Raw samples, screenshots, failure diagnostics and traffic series are retained. A shortened run, missing sample, skip or uncorroborated device claim fails approval. Three measured release cold starts additionally must each complete within 10 seconds on the CI emulator; these timings do not establish physical-device frame performance.

`scripts/android-release-proof.py` independently recomputes counts, duration, resource medians/peaks and fixed budgets from raw records, then requires the stopped AWG peer to corroborate the encrypted traffic and its duration. The latest acceptance report must identify the exact source commit and APK payload hashes; historical results below do not approve the current candidate.

## Executable acceptance

Native CI enables `android-install.py --serial emulator-5554 --disposable-emulator --failure-report out/android/device-tests/install-failure.json`. If either APK installation fails, the installer retains that original failure and takes one bounded, read-only snapshot before the emulator action tears down the guest. The report and raw streams are uploaded with the existing runtime artifact. No snapshot is taken on successful installation or ordinary local installs.

The collector first confirms a debuggable QEMU guest, then observes package/settings service presence, framework PIDs, bounded crash/recent logs, kernel messages, processes and memory/uptime. It reuses the preparation diagnostic limits: 12 seconds total, at most 2 seconds per command, capped raw files with hashes. A missing service, denied read, timeout or exhausted budget is evidence, never permission to retry installation, restart Android, change tracing or mark acceptance successful. These post-failure observations may miss an earlier crash or show a recovered process; they do not alone establish the cause of a Binder failure. Full framework logs are intended only for the explicitly disposable CI fixture.

GitHub Actions builds once and runs the same actual instrumentation APK on API 29, API 35 and API 36 `google_apis_ps16k`. The API 36 jobs explicitly use the official Android 16 QPR2 system-image package `android-36.1`, revision 4, with runtime SDK 36 / full SDK 36.1. The [16 KiB trace follow-up](ANDROID-PERFETTO-16K.md) explains this maintenance-image choice and its observed image/geometry checks; it is not the earlier base `android-36` image. The runner verifies actual `PAGE_SIZE`, and rejects empty suites, failures, crashes, timeouts and skips.

Headless CI uses `-gpu software`, a currently supported GLES/Vulkan software-renderer selector. Android's [graphics documentation](https://developer.android.com/studio/run/emulator-acceleration) marks the former `swiftshader_indirect` mode deprecated since Emulator 36.4.9. This removes a known obsolete configuration; it does not establish that this mode caused the observed API 35 blank frames or that a later run passed. Compose UI tests require their actual window to be attached, shown, focused and laid out. Before entering a scenario, the cleared Home screen must commit a real frame and produce nonuniform captured app content with system bars excluded; no expected theme colors are hard-coded. Semantics alone cannot approve an unrendered window.

The API 29 emulator has 2,048 MiB RAM; API 35 and API 36 with 16 KB pages have 4,096 MiB. All retain a 512 MiB ART heap setting. This corrects observed test-device resource failures: [run 43921779954](https://github.com/INNVoices/waarp/actions/runs/43921779954), API 36 at 2,048 MiB, recorded `ApplicationExitInfo reason=3 (LOW_MEMORY)`, app RSS `313MB`, and LMKD `min watermark is breached even after kill` while also killing Google/system processes and the launcher. Android and redirected Go crash buffers were empty. API 35 screenshots from the same run were obscured by the system **Pixel Launcher isn't responding** dialog. The memory change does not relax the native/configuration, traffic, UI or actual 16,384-byte page-size gates, and is not evidence of success until those gates run again.

API 29 also performs one explicit framework restart during disposable-device preparation, before installing the tested app. The helper proves that the existing `dalvik.vm.heapsize=512m` value is set while the old zygotes are absent, then requires new framework PIDs and live Binder services. This addresses a retained pre-instrumentation `system_server` OOM with a 16 MiB VM limit; it does not retry failed tests or increase budgets. See [the failure timeline, primary-source analysis and preparation contract](ANDROID-API29-EMULATOR.md). The report distinguishes property-order evidence from a direct runtime heap measurement.

[Follow-up readiness observations](ANDROID-ACCEPTANCE-READINESS.md) document the subsequent process-name, hidden-keyboard and pre-installation launcher failures, the narrow pinned-action correction, and callback-based readiness in the separate-UID traffic probe. They also record the next run's five passing short Android jobs and the remaining ADB restoration failure. The earlier second-cycle DNS timeout remains causally unresolved; a later successful exchange demonstrates current behavior, not the cause of the old timeout. Neither incomplete run approves the candidate.

Before instrumentation, the runner waits up to 30 seconds for Android's framework broadcast queues to become idle and records guest `/proc/meminfo`, a guest process-memory summary, and host `/proc/meminfo`. This global-queue observation is diagnostic: in [run 43925958101](https://github.com/INNVoices/waarp/actions/runs/43925958101), API 29's background Google/system queue grew from 84 to 112 ordered broadcasts during the bounded wait while all three app UI scenarios and foreground checks passed. A timeout remains explicitly recorded as `broadcastQueuesIdle=false`; it cannot establish that the tested app is unready. The mandatory test results, actual page size, traffic proofs and screenshots still determine acceptance. System dialogs and crash history are preserved, and app failures remain failures.

The transport fixes passed all 13 native/lifecycle cases on each API in [run 43930555203](https://github.com/INNVoices/waarp/actions/runs/43930555203): a separate app UID made a real HTTP GET through TUN, and each Linux AWG2 peer recorded two encrypted DNS replies separated by OFF/ON, authenticated handshakes, padding, no plaintext payload and successful shutdown. That run still failed one UI case on API 35 and 36: an unobserved corrected-route save and an import button outside the viewport, with keyboard/insets transitions in the device logs. It is not counted as complete acceptance.

After text entry, form tests close the keyboard using standard Espresso input handling scoped to the exact window owning the Compose node, and wait for that window's actual IME insets. All modal buttons must be visible, enabled and have stable bounds before one click. Confirmations after a path picker do not invoke an unrelated keyboard action: in [run 43933928383](https://github.com/INNVoices/waarp/actions/runs/43933928383), doing so selected an unfocused background window on API 35/36, although the corrected import/route scenario passed on every API. The bounded readiness wait does not retry submissions or extend the 15-second state assertion. Corrected input text, validation errors, encrypted persistence, recreation and deletion remain asserted. Failed readiness/modal actions retain their screenshot, full-depth semantics and actual app/framework window metadata before cleanup. This follows Android's guidance for [Compose synchronization with external layout work](https://developer.android.com/develop/ui/compose/testing/synchronization) and [Espresso keyboard handling](https://developer.android.com/reference/androidx/test/espresso/Espresso).

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
