# AWG import and generated configuration audit — 2026-11-16

## Scope and evidence

This change keeps Waarp's pinned engine, `Leadaxe/sing-box-lx v1.14.2-lx.11`, commit `3d3d3db3a2ccef3b1a8eb71b831ed2461c54b94d`. Its AWG implementation uses `Leadaxe/wireguard-go-awg2-lx`, commit `64065e6826ad82aa28429dd829c1c65f29b7f6c9`. The audit compares configuration contracts and startup code at these exact revisions. It does not substitute another core or infer compatibility from a similarly named project.

The supplied user file was inspected privately. Its AWG2 field families are supported by the pinned build: Jc/Jmin/Jmax, S1–S4, H1–H4 ranges and an I1 CPS packet, together with a single IPv4 full-route peer and an explicit keepalive. The file, keys, endpoint and interface addresses are not included in this report or the synthetic tests. Source compatibility is distinct from a successful authenticated connection to its server.

## Findings and fixes

| Finding in Waarp | Resulting behavior | Implemented correction |
| --- | --- | --- |
| The importer discarded `AllowedIPs`, and `endpoint()` always supplied both IP default routes. | A restricted imported peer acquired a broader route/receive policy. IPv4-only peers also acquired an invented IPv6 prefix. | Preserve all imported prefixes, including repeated lines; normalize bare hosts to host prefixes; serialize that exact list. IPv6 capability now also requires an IPv6 allowed prefix. |
| Numeric AWG fields were checked only with `Number.isFinite`. | Negative/fractional values and out-of-range integers could be saved, then fail in JSON decoding or device UAPI. | Decimal uint32 bounds for J fields, uint16 bounds for S fields, and `Jmin <= Jmax` before saving. |
| H values were arbitrary strings. | Reversed/out-of-range ranges and intersecting headers could fail only during device creation. | Validate uint32 single values and inclusive ranges, canonicalize whitespace, and reject overlap including collisions with unset/default headers. |
| I fields were passed through the generic string-to-number conversion. CPS syntax was not validated. | A numeric I string became the wrong JSON type; malformed CPS failed late. | Preserve I1–I5 as case-sensitive strings and validate the pinned supported tag grammar. The Windows implementation limits numeric tag sizes to 2016 bytes. |
| Repeated Address/DNS lines overwrote earlier values; conflicting scalars and extra interface sections could be silently ignored. | Valid exports lost addresses/resolvers, and ambiguous configurations were accepted with unintended meaning. | Accumulate list fields, reject conflicting scalar values and unsupported additional sections, and accept inline `#` export comments. |
| Unknown protocol fields were silently discarded. | An AWG3 or vendor-specific configuration could appear imported with protocol settings missing. | Name unsupported fields in an import error without displaying their values. AWG3 import is not claimed by this change. |
| Address parsing ignored a second `/` suffix; endpoint parsing accepted invalid bracket/domain forms. | Invalid profiles survived import and failed during connection. | Validate whole prefixes, IP families, endpoint host syntax and port; normalize internationalized DNS names. |
| Omitted keepalive became 25 seconds, and ListenPort was discarded. | The generated configuration differed from the supplied WireGuard semantics. | Keepalive defaults to 0; accept WireGuard's `off` value; preserve a valid optional ListenPort. |
| Shared `vpn://` keys had an unlimited inflate and recursive discovery path. | A compact malformed import could allocate excessive memory or recurse deeply. | Limit raw/expanded content to 1 MiB and nested configuration discovery to 32 levels. |
| The userspace checker lacked explicit DNS and `default_domain_resolver`, unlike the main configuration. | Its resolution policy depended on engine fallback and could differ from main, including target IPv6 selection for an IPv4-only tunnel. | Explicit local DNS bootstrap and the same IPv4 DNS strategy as main; retain no inbound and `system: false` for WireGuard. |

The persisted profile validator accepts an absent `allowedIPs` field only as the legacy format. An invalid present list or ListenPort fails loading rather than being removed or expanded. Existing saves cannot reveal the AllowedIPs that the old importer discarded, so they retain their previous generated route list until re-imported. New imports with a missing/empty AllowedIPs fail explicitly: the pinned endpoint requires a nonempty list, and guessing full-route access is not a faithful interpretation.

### DNS and MTU qualifications

The pinned engine has a default DNS transport fallback. Therefore the checker's missing explicit resolver was **not proved to be an unconditional startup failure**, and it is not presented as the cause of the screenshot's recovery error. The fix removes a policy mismatch. A checker using local DNS still measures a different resolver path from a main connection using a provider DNS server; it does not prove that every imported resolver is healthy.

Waarp continues to retain the imported DNS list and use the first IP resolver for a provider's generated DNS transport. Multiple imported resolvers are not an implemented failover group. Search suffix application is not implemented. This patch does not change those existing product limits.

The pinned transport applies S4 to data-packet overhead; S3 applies to cookie replies. Waarp's existing default endpoint MTU of 1280 is retained. No additional S3 subtraction or speculative MTU/core change is introduced.

## Exact upstream sources and licenses

The implementation in this repository was written for Waarp from the observed contracts; no GPL source body was copied into the Apache-2.0 application.

| Primary source | Revision / license | Audit use |
| --- | --- | --- |
| [sing-box-lx options](https://github.com/Leadaxe/sing-box-lx/blob/3d3d3db3a2ccef3b1a8eb71b831ed2461c54b94d/option/wireguard_awg.go), [WireGuard peer options](https://github.com/Leadaxe/sing-box-lx/blob/3d3d3db3a2ccef3b1a8eb71b831ed2461c54b94d/option/wireguard.go) | `3d3d3db3a2ccef3b1a8eb71b831ed2461c54b94d`; [GPL-3.0-or-later and stated project naming conditions](https://github.com/Leadaxe/sing-box-lx/blob/3d3d3db3a2ccef3b1a8eb71b831ed2461c54b94d/LICENSE) | JSON types, uint32 headers/ranges, I strings, optional listen port, peer options. |
| [AWG adapter](https://github.com/Leadaxe/sing-box-lx/blob/3d3d3db3a2ccef3b1a8eb71b831ed2461c54b94d/transport/wireguard/device_awg.go), [transport endpoint](https://github.com/Leadaxe/sing-box-lx/blob/3d3d3db3a2ccef3b1a8eb71b831ed2461c54b94d/transport/wireguard/endpoint.go), [configuration documentation](https://github.com/Leadaxe/sing-box-lx/blob/3d3d3db3a2ccef3b1a8eb71b831ed2461c54b94d/docs-lx/lx-config.md) | Same pinned sing-box-lx revision/license. | Jmin/Jmax invariant, UAPI formatting, nonempty allowed prefixes, S4 overhead and default MTU. |
| [Protocol endpoint](https://github.com/Leadaxe/sing-box-lx/blob/3d3d3db3a2ccef3b1a8eb71b831ed2461c54b94d/protocol/wireguard/endpoint.go), [dialer resolver selection](https://github.com/Leadaxe/sing-box-lx/blob/3d3d3db3a2ccef3b1a8eb71b831ed2461c54b94d/common/dialer/dialer.go), [DNS transport manager](https://github.com/Leadaxe/sing-box-lx/blob/3d3d3db3a2ccef3b1a8eb71b831ed2461c54b94d/dns/transport_manager.go) | Same pinned sing-box-lx revision/license. | Separate peer hostname/bootstrap and dial target resolution; actual default DNS fallback. |
| [Pinned Go module declaration](https://github.com/Leadaxe/sing-box-lx/blob/3d3d3db3a2ccef3b1a8eb71b831ed2461c54b94d/go.mod), [AWG device UAPI](https://github.com/Leadaxe/wireguard-go-awg2-lx/blob/64065e6826ad82aa28429dd829c1c65f29b7f6c9/device/uapi.go) | Dependency `64065e6826ad82aa28429dd829c1c65f29b7f6c9`; [MIT](https://github.com/Leadaxe/wireguard-go-awg2-lx/blob/64065e6826ad82aa28429dd829c1c65f29b7f6c9/LICENSE). | Actual uint16 S parsing, header overlap validation and supported I fields. |
| [CPS parser](https://github.com/Leadaxe/wireguard-go-awg2-lx/blob/64065e6826ad82aa28429dd829c1c65f29b7f6c9/device/obf.go), [static bytes](https://github.com/Leadaxe/wireguard-go-awg2-lx/blob/64065e6826ad82aa28429dd829c1c65f29b7f6c9/device/obf_bytes.go), [Windows segment sizes](https://github.com/Leadaxe/wireguard-go-awg2-lx/blob/64065e6826ad82aa28429dd829c1c65f29b7f6c9/device/queueconstants_windows.go), [protocol constants](https://github.com/Leadaxe/wireguard-go-awg2-lx/blob/64065e6826ad82aa28429dd829c1c65f29b7f6c9/device/constants.go) | Same pinned wireguard-go fork revision, MIT. | Supported `b/t/r/rc/rd/d/ds/dz` tags, case sensitivity, length bounds. |
| [Official WireGuard tools parser](https://git.zx2c4.com/wireguard-tools/tree/src/config.c) | Read 2026-11-16, displayed source blob `0e145d4cd76c71487b51043bf5898523d390739c`; `GPL-2.0 OR MIT` per source SPDX. | Compatibility reference for bare AllowedIPs, inline comments and `PersistentKeepalive = off`. No source copied. |
| [Official Amnezia protocol documentation](https://docs.amnezia.org/documentation/amnezia-wg/) | Read 2026-11-16; documentation reference, no code imported. | AWG2 field families and later protocol versions. Numeric acceptance is taken from the pinned source, not an evolving web description. |

## Verification

Focused synthetic checks are in `test/awg-import.check.ts`; the existing core and live synthetic fixtures now carry explicit AllowedIPs. They cover field preservation, restricted routing, malformed parameters, checker construction, legacy/persisted data and bounded shared-key decoding. They do not require server credentials or privileged networking.

Executed only after the source-fix stage, as requested:

- AWG import suite: **74/74 passed**.
- Core suite: **130/130 non-IPC checks passed**. The existing local IPC subtest reported an explicit `EPERM` skip on this Linux environment; it is not counted as native Windows coverage.
- Private supplied-file parse and main/checker generation: all boolean assertions passed for key/endpoint preservation, every obfuscation field, original AllowedIPs, matching main/checker peer settings, userspace checker and explicit local resolver. No keys, endpoint, addresses or generated private configuration were logged or written to the repository.

A real network handshake, userspace URL delay, Windows TUN routing and the original recovery scenario are separate integration checks and must be reported with their actual environment constraints.
