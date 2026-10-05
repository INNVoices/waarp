# Roadmap

Waarp is being built as a practical Windows traffic router first, and as a broad networking toolbox second.

This roadmap is directional, not a promise of dates or version numbers. Reliability and regressions can reorder it.

## First public release

The first release is intentionally conservative.

- finish the Windows TUN lifecycle and recovery gate;
- prove start / stop / crash / sleep / resume / shutdown behavior on a disposable Windows machine;
- keep ambiguous network states fail-unavailable rather than trying broad Windows “repair”;
- keep Auto bounded so large profile libraries do not explode memory or handles;
- keep missing / revoked protected routes fail-closed instead of silently becoming Direct;
- finish release packaging, checksums, dependency notices and source provenance;
- publish the Windows portable build with CI and a reproducible release checklist.

Known design limit: Waarp does not provide an independent WFP / firewall kill switch. If the routing engine is not running, Windows may use its normal route.

## After the first release

Real daily use decides priority. Network-state, routing, privacy and startup / shutdown regressions jump the queue.

Planned work:

- improve route and Auto explanations without turning the UI into a protocol cockpit;
- make diagnostics better at explaining DNS / TCP / TLS / HTTP failures without pretending to know more than the evidence shows;
- refine large-library sampling and health checks while keeping resource use bounded;
- improve import / replace / subscription workflows and error reporting;
- harden coexistence with other VPN / TUN software;
- improve crash / residue evidence and support bundles without collecting secrets;
- keep the companion routing API small, versioned and local-only.

## Connections and routing

Waarp should continue to support a broad set of user-provided connections while keeping the everyday model simple:

`target -> Direct / Auto / chosen connection`

Areas we expect to improve over time:

- AmneziaWG / WireGuard;
- VLESS / REALITY / XHTTP and other supported sing-box transports;
- OpenVPN compatibility;
- groups and fallback policy;
- per-app, per-site and whole-computer routing;
- network-scoped memory for hostile or unstable networks;
- public connection sources as an optional, clearly untrusted feature — never a silent fallback for personal or sensitive routes.

New transports are added when they solve a real compatibility or hostile-network problem, not just to make the protocol list longer.

## Windows quality

Longer-term Windows work:

- signed releases;
- safer update / reinstall behavior;
- stronger upgrade and rollback checks;
- better handling of adapter / route residue that can be proven to belong to Waarp;
- reproducible VM regression coverage for Windows networking edge cases;
- performance measurements for very large libraries and long-running sessions.

Waarp will not delete arbitrary adapters, reset Winsock, reset global DNS, or “fix” other VPN software.

## Product polish

Planned, when it does not compete with reliability:

- English UI in addition to Russian;
- accessibility and reduced-motion pass;
- clearer first-run guidance;
- better sanitized diagnostics export;
- more complete documentation and examples;
- small UX improvements driven by real issue reports.

## Contributions

Bug reports and focused pull requests are welcome. Small fixes with a regression test are especially useful.

For current release limitations, see [docs/RELIABILITY.md](docs/RELIABILITY.md). For contribution rules, see [CONTRIBUTING.md](CONTRIBUTING.md).
