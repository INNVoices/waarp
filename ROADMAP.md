# Roadmap

Waarp routes applications and domains through personal connections or Direct on Windows and Android. This roadmap is directional, not a promise of dates or version numbers. Reliability and regressions can reorder it.

## Current baseline

| Area | Current state |
| --- | --- |
| Public downloads | Windows r6 `0.4.1-rc.5` portable EXE and Android r5 `0.5.0-rc.5` debug APKs, with checksums and source provenance. Both are previews. |
| Source on `main` | Version `1.0.0` for both clients, Android version code 7. This source version has not been published as a public binary release. |
| Routing and interface | Windows and native Android clients, saved profiles and groups, app/domain rules, local connection maps and contextual diagnostics. |
| Languages and local builds | The 1.0.0 source includes English and 17 other translations alongside Russian, plus Windows build entry points for both clients. These later source changes are separate from the published preview binaries. |

[Downloads and release evidence](docs/RELEASES.md) · [Installation](docs/INSTALL.md) · [1.0.0 code acceptance](docs/V1.md)

## Next release priorities

- Resolve the outstanding Windows lifecycle evidence and complete start / stop / crash / sleep / resume / shutdown coverage on disposable Windows machines. A successful preview run does not erase an independently failed run.
- Complete the Windows stable acceptance matrix, including coexistence with another VPN and continuity during ordinary route edits.
- Complete Android optimized-release acceptance across the required API levels, the encrypted two-hour soak and physical-device follow-up before production claims.
- Verify installation and updates for each delivered package, preserving Android's existing production signing identity. Keep debug and production packages distinct.
- Publish verified packages for the accepted source revision with matching versions, checksums, dependency notices and clear limitations.
- Address or explicitly disclose dependency-security findings according to the existing release approval policy.

The detailed gates are in [release approval policy](docs/RELEASES.md#release-approval-policy), [Windows acceptance](docs/STABLE-AUDIT-2026-11-16.md) and [Android acceptance and signing](docs/ANDROID.md).

Known design limit: Waarp does not provide an independent WFP / firewall kill switch. If the routing engine is not running, Windows may use its normal route. That is distinct from blocking an unavailable path while the engine is active.

## Connections and routing

Keep the everyday model simple:

`target -> Direct / Auto / chosen connection`

Further work follows real compatibility reports and daily use:

- improve route and Auto explanations and keep large-library sampling and health checks bounded;
- refine import, replace and subscription workflows, groups and fallback policy;
- improve AmneziaWG / WireGuard and VLESS / REALITY / XHTTP compatibility, and evaluate OpenVPN compatibility where it solves a concrete need;
- improve network-scoped behavior and coexistence with other VPN / TUN software;
- keep diagnostics precise about DNS / TCP / TLS / HTTP failures and the limits of their measurements;
- keep public connection sources optional and clearly identified as third-party infrastructure, without a silent public fallback for personal routes;
- keep the companion routing API small, versioned and local-only.

Missing or revoked protected paths must remain unavailable instead of silently becoming Direct. If network state is ambiguous, Waarp must stay unavailable rather than attempt broad system repairs.

## Distribution and long-running use

- Signed Windows releases.
- Production-signed Android APKs after the acceptance gates, using the retained update identity.
- Stronger upgrade, rollback and settings-preservation checks.
- Reproducible regression coverage for Windows networking edge cases and Android service recovery.
- Performance measurements for large profile libraries and long-running sessions.
- Better evidence for crashes and leftover resources, with sanitized support bundles.

Waarp will not delete arbitrary adapters, reset Winsock, reset global DNS or repair other VPN software. Cleanup must be limited to resources it can prove it owns.

## Product polish and contributions

English and the other translations are already in the 1.0.0 source. Further polish focuses on translation review, accessibility, reduced motion, clearer first-run guidance, sanitized diagnostics export and examples that match the downloadable builds.

Bug reports and focused pull requests are welcome. Useful contributions include reproducible installation or routing reports, translation corrections with UI context, and small fixes with a regression test where practical. Network-state, routing, privacy and startup / shutdown regressions take priority.

[Contributing](CONTRIBUTING.md) · [Support](SUPPORT.md) · [Known limitations](docs/RELIABILITY.md)
