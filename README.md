<p align="center">
  <img src="docs/brand/waarp-cover.svg" alt="Waarp — route traffic, keep control" width="100%">
</p>

<p align="center">
  <a href="README.md"><b>English</b></a> · <a href="README.ru.md">Русский</a>
</p>

<p align="center">
  <img alt="Windows 10/11" src="https://img.shields.io/badge/Windows-10%20%2F%2011-2374CF?style=flat-square&logo=windows11&logoColor=white">
  <img alt="Android 10+" src="https://img.shields.io/badge/Android-10%2B-267F61?style=flat-square&logo=android&logoColor=white">
  <a href="LICENSE"><img alt="Desktop code: Apache 2.0" src="https://img.shields.io/badge/Desktop-Apache%202.0-7148C6?style=flat-square"></a>
  <a href="android/LICENSE"><img alt="Android code: GPL 3.0 or later" src="https://img.shields.io/badge/Android-GPL%203.0%2B-267F61?style=flat-square"></a>
  <img alt="Release channel: preview" src="https://img.shields.io/badge/Channel-preview-F59E0B?style=flat-square">
</p>

<p align="center">
  <strong>One place to route apps, sites and services through the connection you choose.</strong><br>
  Personal VPNs, proxies, groups, failover and an opt-in public catalog — without a paid Waarp subscription.
</p>

<p align="center">
  <a href="#download"><b>Download</b></a> ·
  <a href="#screenshots">Screenshots</a> ·
  <a href="#why-waarp">Features</a> ·
  <a href="docs/README.md">Documentation</a> ·
  <a href="README.ru.md">Русский</a> ·
  <a href="ROADMAP.md">Roadmap</a>
</p>

> [!IMPORTANT]
> **Windows r6 is published as a prerelease.** The desktop update is `0.4.1-rc.5`; Android remains the published `0.5.0-rc.5` from [r5](https://github.com/INNVoices/waarp/releases/tag/preview-2026-11-18-r5). The platforms have separate source commits for these downloads. The EXE is unsigned and the APKs are debug-signed. [Release state, checksums and criteria](docs/RELEASES.md).

The [Windows release checks](https://github.com/INNVoices/waarp/actions/runs/44348809024) passed: real public checks before import and while VPN is on, preserved route/session, map geometry, diagnostics, runtime icon and 50 native TUN lifecycle cycles. On the GitHub runner, 4 of the 14 checked public candidates had fresh responses; the first ready result appeared 102.737 s into the fresh-install catalog scenario. A separate general-CI lifecycle check failed on the same source; see the [measured results and unresolved limits](docs/RELEASES.md#current-evidence-and-unresolved-limits).

<p align="center">
  <a href="docs/screenshots/preview-r6/desktop-public-real-1920.png"><img src="docs/screenshots/preview-r6/desktop-public-real-1920.png" alt="Waarp desktop — public connections checked automatically on a taller region map" width="860"></a>
</p>
<p align="center"><sub>Windows r6, captured from the published packaged application on a GitHub-hosted Windows runner. Public-server availability is specific to that network and capture time.</sub></p>

## Why Waarp

| **Precise routing** | **Stable path selection** | **Useful diagnostics** |
| :--- | :--- | :--- |
| Assign a direct or protected path to apps, services, domains and custom targets. | Auto holds a working personal route; explicit failover avoids reflexive ping-based switching. | Check a target through your connections and explain observed DNS, TCP, TLS and HTTP failures. |
| **Bring your own connections** | **Public pool, by choice** | **Desktop + mobile** |
| WireGuard / AmneziaWG, VLESS, VMess, Trojan, Shadowsocks, Hysteria2, TUIC, OpenVPN and supported imports. | On Windows, opening the public catalog starts automatic checks, including while the VPN is on. Visible candidates get priority without being added to saved connections. Public relays never join Auto silently. | Electron-based Windows client and native Kotlin / Compose Android client in one repository. |

No multi-path aggregation, no guaranteed latency improvement, and no anonymity promise. [How routing works](#how-it-works) · [Public node trust and sources](docs/SOURCES.md).

## Download

| <img src="https://img.shields.io/badge/Windows-x64-2374CF?style=flat-square&logo=windows11&logoColor=white" alt="Windows"> | <img src="https://img.shields.io/badge/Android-APK-267F61?style=flat-square&logo=android&logoColor=white" alt="Android"> |
| :--- | :--- |
| **[Download 0.4.1-rc.5 EXE](https://github.com/INNVoices/waarp/releases/download/preview-2026-11-18-r6/Waarp-0.4.1-rc.5-portable.exe)** | **[Download 0.5.0-rc.5 APK · ARM64](https://github.com/INNVoices/waarp/releases/download/preview-2026-11-18-r5/waarp-android-0.5.0-rc.5-arm64-v8a-debug.apk)** |
| Windows 10/11 x64. Portable, unsigned desktop update: automatic public checks, clearer diagnosis, a taller map and the packaged taskbar icon. [SHA-256](https://github.com/INNVoices/waarp/releases/download/preview-2026-11-18-r6/SHA256SUMS-windows.txt). | Android 10+. Installable **debug-signed** preview; ARM64 suits most current phones. Separate from the production app and cannot update it. [SHA-256](https://github.com/INNVoices/waarp/releases/download/preview-2026-11-18-r5/SHA256SUMS-android-debug.txt). |

Other Android builds: **[ARM32](https://github.com/INNVoices/waarp/releases/download/preview-2026-11-18-r5/waarp-android-0.5.0-rc.5-armeabi-v7a-debug.apk)** · **[x86_64](https://github.com/INNVoices/waarp/releases/download/preview-2026-11-18-r5/waarp-android-0.5.0-rc.5-x86_64-debug.apk)**. [Android r5 release and checks](https://github.com/INNVoices/waarp/releases/tag/preview-2026-11-18-r5). Windows r6: [release](https://github.com/INNVoices/waarp/releases/tag/preview-2026-11-18-r6) · [release checks](https://github.com/INNVoices/waarp/actions/runs/44348809024) · [package report](https://github.com/INNVoices/waarp/releases/download/preview-2026-11-18-r6/package-integrity-windows.json) · [real public-network acceptance](https://github.com/INNVoices/waarp/releases/download/preview-2026-11-18-r6/public-catalog-windows.json).

**[All releases](https://github.com/INNVoices/waarp/releases)** · **[Preview publishing workflow](.github/workflows/release-preview.yml)** · **[Release and integrity guide](docs/RELEASES.md)**

The repo is currently private; GitHub download and Actions links may require repository access. Third-party infrastructure can cost money, even though Waarp itself has no subscription.

## Choosing a server on Windows

Choose an application, then choose its server in one screen: **Automatic · Manual · Direct**. Saved connections and public servers use compact rows, search and numbered pages. The public catalog adds region and availability filters. It checks visible candidates first and continues through the pool in bounded rounds while the public screen is open. Verification does not add a profile: once a fresh response is available, the row offers Add or Use. Progress separates unchecked, responding, failed and skipped candidates.

Public checks can run while Waarp is on. Changing a card's server updates the route without asking to restart the VPN; a failed live change keeps the previous selection. The initial app chooser stays familiar, with route diagrams and advanced settings tucked under one details section.

[What changed and how it behaves](docs/SERVER-SELECTION-2026-11-18.md) · [Preview notes](release/preview-2026-11-18.md)

## Map and contextual connection checks

Windows `0.4.1-rc.5` gives the map more vertical space, shows region totals and measured status, and keeps recognized country metadata when a public connection is saved. Unknown regions remain available in the list. The map uses bundled geography; its region markers and route lines describe logical connections, not precise server locations or traceroute hops.

The main Diagnostics screen starts a bounded investigation automatically, explains the observed stage and offers a next step. It resolves an existing domain route or the default path and keeps a current path that answered. A successful native connection check is shown separately from a failing Windows system request. Transfer checks and response history remain available in an expandable section.

Android remains on r5, including its existing local map, manual-region preference and contextual connection check. Its result stays in the route draft until Save route. [Usage](docs/CONNECTION-TOOLS.md) · [Release evidence and limits](docs/RELEASES.md) · [Historical r5 gallery and provenance](docs/screenshots/preview-r5/README.md) · [Contribute a profile](docs/CONNECTION-PROFILES.md).

## How it works

Waarp does not put the whole computer behind one VPN. Each target gets its own intent:

- **Direct** — the normal network;
- **a specific connection** — one of your own VPN / proxy profiles, or a group of them;
- **Auto** — picks from your own eligible connections and stays on a working one.

Targets can be applications, services or custom hosts. A whole-computer mode routes everything else through a chosen path while explicit rules still apply.

### Auto

Auto is built to be predictable, not to re-optimise every few seconds:

- only your own non-public connections take part;
- a healthy path stays in use while it has active connections; one missed probe does not switch it;
- switching for better performance happens only when the current path has no active connections and repeated checks show a clear improvement; confirmed failure can trigger failover;
- probing is bounded, and the engine keeps at most **16** Auto connections live at once, so a library of hundreds of profiles does not hold hundreds of tunnels in memory (the others stay in your library and remain usable manually and in diagnostics);
- Auto never falls back to Direct or to a public node. With no eligible path, the route stays unavailable instead of leaking.

Failover closes the affected sessions so traffic can use the replacement path. Games and other apps may need to reconnect.

### Diagnostics

On Windows, opening Diagnostics or editing its target starts a bounded check automatically. Waarp reports the observed failure stage — DNS, TCP, TLS or HTTP — with a concrete next step and comparison of eligible paths. The comparison uses an existing matching domain route when present; an application name is never guessed to be a domain. Detailed system checks follow operating-system routes and can traverse the active VPN. Checks of specific connections address their native outbound. One failed request does not establish a cause such as provider blocking. With the tunnel closed, a separate local checker probes a bounded set of your connections without creating a TUN or touching system routes.

Displayed latency measures an HTTP check, not game-server ping. Waarp selects a path for each route; it does not send a session through several paths at once (multipath).

### Supported connections

Engine: [sing-box-lx](https://github.com/Leadaxe/sing-box-lx) (bundled, with its license, under `engine/`).

- AmneziaWG / WireGuard
- VLESS, VMess, Trojan, Shadowsocks
- Hysteria2, TUIC v5
- OpenVPN (scripts, plugins and external credential files are rejected)
- subscriptions with supported share links, including JSON / YAML containers containing those links

Import from file, clipboard, QR code, subscription link, local discovery or manual entry. Subscription refresh is manual. JSON / YAML import extracts supported share links; it does not convert arbitrary native client configurations.

On Windows `0.4.1-rc.5`, public checks run automatically while a public-catalog screen is open. Visible rows have priority, and further candidates are checked in bounded rounds with pauses and retry cooldowns. Leaving the public screen releases its automatic checking request. A count of zero ready servers describes the measurements so far; it does not mean every stored candidate failed. Checks do not save profiles or change an application's selected route. Android `0.5.0-rc.5` retains its separate catalog flow: new public-node probes still require VPN OFF. On both platforms, public nodes remain separate from Auto. They are operated by third parties, not Waarp, and can expose traffic that is not end-to-end encrypted. Sources: [docs/SOURCES.md](docs/SOURCES.md).

## Screenshots

Windows r6 screenshots below come from the packaged EXE built from `0e0bb6c7cad421dc0fff377d8c7f826d115e0292`, using real public feeds and native checks on a GitHub-hosted Windows runner. [Acceptance report](docs/screenshots/preview-r6/public-catalog-windows.json). The [r5 gallery](docs/screenshots/preview-r5/README.md) preserves the historical Windows fixture captures and current Android map captures at normal and 150% text.

### Windows · automatic public checks and diagnosis

<table>
<tr>
<td align="center" valign="top" width="50%"><a href="docs/screenshots/preview-r6/desktop-public-real-1920.png"><img src="docs/screenshots/preview-r6/desktop-public-real-1920.png" width="420" alt="Public connections and measured regional availability on the taller Windows map"></a><br><sub><strong>Public connections</strong> · checks run before Add</sub></td>
<td align="center" valign="top" width="50%"><a href="docs/screenshots/preview-r6/desktop-diagnostics-real-1240.png"><img src="docs/screenshots/preview-r6/desktop-diagnostics-real-1240.png" width="420" alt="Automatic Windows diagnosis with selected route, observed stages and next step"></a><br><sub><strong>Diagnostics</strong> · current path, evidence and next step</sub></td>
</tr>
</table>

These r6 images come from the packaged Windows application, with the matching [public-network acceptance report](https://github.com/INNVoices/waarp/releases/download/preview-2026-11-18-r6/public-catalog-windows.json). Measurements from a GitHub-hosted runner do not establish availability on another user's network. Older [public-picker](docs/screenshots/public-server-pages.png) and [saved-picker](docs/screenshots/saved-server-pages.png) images remain fixture-based layout records.

### Android · native app

<p align="center">
  <a href="docs/screenshots/android-home.png"><img src="docs/screenshots/android-home.png" width="220" alt="Waarp Android home screen with VPN off"></a>
  <a href="docs/screenshots/android-settings.png"><img src="docs/screenshots/android-settings.png" width="220" alt="Waarp Android routing settings"></a>
  <a href="docs/screenshots/android-groups.png"><img src="docs/screenshots/android-groups.png" width="220" alt="Waarp Android connection groups after saving"></a>
</p>
<p align="center"><sub>Home · Settings · Groups</sub></p>

Android 0.5.0-rc.4 captured from the native app on an API 35 Pixel 6 emulator with synthetic test profiles. [Capture methods and sources](docs/screenshots/README.md).

<details>
<summary>Earlier Windows captures</summary>

The original [overview](docs/screenshots/hero-home.png), [route settings](docs/screenshots/routing.png), [connection import](docs/screenshots/add-connection.png) and [diagnostics](docs/screenshots/diagnostics.png) remain available as historical UI references. They predate the current server picker.

</details>

## Conservative Windows failure handling

Waarp is designed to avoid leaving network state behind and to refuse a start when the state is ambiguous:

- before every start it checks, read-only, for a leftover Waarp adapter or a taken service subnet, and refuses to start rather than change anything;
- stopping tries a verified CTRL_BREAK only when an isolated console is available; otherwise it terminates only its own child through the retained handle, then verifies exit;
- it never deletes network adapters, resets Winsock or DNS, or touches another VPN;
- after sleep it restarts at most once, and only when a usable network is back.

Coverage includes offline regressions, native Windows process checks and production-renderer checks. Native TUN lifecycle and protocol tests have separate evidence and boundaries. Physical sleep, shutdown, full routing, other-VPN coexistence and the private remote endpoint require the [stable acceptance matrix](docs/STABLE-AUDIT-2026-11-16.md). Actual results are in [the validation record](docs/VALIDATION-2026-11-16.md); the failure contract is in [docs/RELIABILITY.md](docs/RELIABILITY.md).

## Security model

- Electron sandbox, context isolation, no Node integration in the UI.
- VPN secrets are stored with Windows DPAPI; there is no plain-text fallback.
- The bundled engine and its DLL are checked against expected hashes before every start.
- Imported configs are validated before they reach the engine.
- Missing or revoked routes stay blocked instead of becoming Direct.
- A small local bridge lets companion desktop apps request routing for their own target with a per-run token; it never exposes configs or keys. See [docs/BRIDGE.md](docs/BRIDGE.md).

Waarp is a routing tool, not an anonymity guarantee: a connection provider can still see traffic that passes through it.

**DNS protection while running; no independent kill switch.** The tunnel uses temporary Windows DNS filtering (`strict_route`) to limit DNS requests outside the tunnel. This filter depends on the running engine. Waarp does not enforce a separate persistent firewall kill switch; if the engine crashes, Windows may send traffic over its normal route. Do not treat Waarp as leak-proof.

Security issues: please follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

## Build from source

For Android, see the [SDK, build, installation and signing guide](docs/ANDROID.md#build-and-install). The commands below build the Windows desktop app.

Windows 10/11, Node.js. Administrator rights are needed only when the tunnel starts.

```bash
npm ci
npm run dev
```

Checks (all offline):

```bash
npm run typecheck
npm test
npm run check
npm run build
npm run test:performance
```

`npm run test:ui` serves the built production renderer for Playwright automatically (install Chromium first with `npx playwright install chromium`).

`npm run test:live -- --disposable-windows` creates a real temporary TUN on an administrator Windows test machine and verifies cleanup across 50 cycles. It intentionally disables automatic routes and DNS capture. Run it only on a disposable test machine; it does not establish remote connectivity or full-system routing. The opt-in real-connection runner and AWG library harness are documented in [the validation record](docs/VALIDATION-2026-11-16.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

Bug reports, routing edge cases and Windows or Android failures are useful even when you do not have a fix. Include the platform and OS version. Please remove keys, subscription URLs, tokens, private server addresses and other secrets before posting logs or screenshots.

## Credits

- [sing-box-lx](https://github.com/Leadaxe/sing-box-lx), based on [sing-box](https://github.com/SagerNet/sing-box) — networking engine, shipped as a separate executable; license: see [`engine/LICENSE`](engine/LICENSE), provenance: [`engine/SOURCE.md`](engine/SOURCE.md)
- [Electron](https://www.electronjs.org/), [React](https://react.dev/), [Vite](https://vitejs.dev/)
- [Instrument Sans](https://github.com/Instrument/instrument-sans), [Inter](https://rsms.me/inter/), [JetBrains Mono](https://www.jetbrains.com/lp/mono/) — SIL Open Font License
- [Simple Icons](https://simpleicons.org/) — CC0

Full list: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

ExitLag is a trademark of its respective owner. Waarp is an independent project and is not affiliated with ExitLag.

## License

| Component | License |
| --- | --- |
| Waarp desktop application | [Apache License 2.0](LICENSE), with [NOTICE](NOTICE) |
| Waarp Android application | [GNU GPL 3.0 or later](android/LICENSE), with [Android notices](android/app/src/main/assets/licenses/NOTICE.txt) |

The desktop license does not apply to the Android application.
Bundled third-party components keep their own licenses: the sing-box-lx engine ships as a separate program under its own license (GPL-3.0-or-later text plus an upstream naming/association condition, see [`engine/LICENSE`](engine/LICENSE)), see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Engine binaries are not stored in Git: `npm run engine:fetch` downloads and verifies the pinned release, `npm run dist` refuses to package without them.
