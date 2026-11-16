# Network guard and resume audit — 2026-11-16

This audit covers the Windows inspection boundary in `src/main/guard.ts` and `src/main/tun.ts`, wake handling in `src/main/resume.ts`, and their callers in `src/main/index.ts`. It accompanies [the startup recovery report](STARTUP-RECOVERY-2026-11-16.md). The review compared source and primary project documentation before changing the application; the focused regressions were executed after the source fixes.

The concrete problem was broader than an unhelpful startup message: failed inspection could look like a clean machine, and an address warning could suppress an independent full-route VPN block. These decisions are now independent and retain an explicit unknown state. No adapter, route, DNS setting, or other VPN is deleted by these helpers.

## Primary sources and version boundaries

| Project | Source reviewed | License evidence and use here |
|---|---|---|
| Tailscale | Commit [`9ad2a9623c9c762c98ef0c0752cdf8fba730066f`](https://github.com/tailscale/tailscale/tree/9ad2a9623c9c762c98ef0c0752cdf8fba730066f), particularly [`net/netmon/netmon_windows.go`](https://github.com/tailscale/tailscale/blob/9ad2a9623c9c762c98ef0c0752cdf8fba730066f/net/netmon/netmon_windows.go) and [`netmon.go`](https://github.com/tailscale/tailscale/blob/9ad2a9623c9c762c98ef0c0752cdf8fba730066f/net/netmon/netmon.go) | The reviewed files declare BSD-3-Clause. Used to compare interface monitoring, invalidation, and treatment of unknown state; no source copied. |
| Mullvad | Commit [`d84a4d947b2715d44c9b8f49a18491e332ff55c0`](https://github.com/mullvad/mullvadvpn-app/tree/d84a4d947b2715d44c9b8f49a18491e332ff55c0), [offline detection architecture](https://github.com/mullvad/mullvadvpn-app/blob/d84a4d947b2715d44c9b8f49a18491e332ff55c0/docs/architecture.md#detecting-device-offline) | [Repository license](https://github.com/mullvad/mullvadvpn-app/blob/d84a4d947b2715d44c9b8f49a18491e332ff55c0/LICENSE.md) is GPLv3 text. Architecture comparison only; no GPL implementation incorporated. |
| NetworkManager | Commit [`62c8e8b2caebbb86182c79223c0109048eac154e`](https://github.com/NetworkManager/NetworkManager/tree/62c8e8b2caebbb86182c79223c0109048eac154e), [`nm-device-wireguard.c`](https://github.com/NetworkManager/NetworkManager/blob/62c8e8b2caebbb86182c79223c0109048eac154e/src/core/devices/nm-device-wireguard.c), and [settings reference](https://networkmanager.pages.freedesktop.org/NetworkManager/NetworkManager/nm-settings-nmcli.html) | The inspected C file declares LGPL-2.1-or-later. The [repository README](https://github.com/NetworkManager/NetworkManager/blob/62c8e8b2caebbb86182c79223c0109048eac154e/README.md#license) describes GPL-2.0-or-later and LGPL-2.1-or-later components. Ideas independently implemented in TypeScript; no code copied. |
| sing-box upstream | Commit [`3cc357d1bd40a104cf4b2207e85ea8f3fd64c207`](https://github.com/SagerNet/sing-box/tree/3cc357d1bd40a104cf4b2207e85ea8f3fd64c207), [route documentation](https://sing-box.sagernet.org/configuration/route/) and [TUN documentation](https://sing-box.sagernet.org/configuration/inbound/tun/) | [License](https://github.com/SagerNet/sing-box/blob/3cc357d1bd40a104cf4b2207e85ea8f3fd64c207/LICENSE): GPL-3.0-or-later wording plus the upstream naming/association condition. Current documentation is a comparison source, not authority to add options to the pinned engine. |
| **Bundled sing-box-lx** | Version `1.14.2-lx.11`, commit [`3d3d3db3a2ccef3b1a8eb71b831ed2461c54b94d`](https://github.com/Leadaxe/sing-box-lx/tree/3d3d3db3a2ccef3b1a8eb71b831ed2461c54b94d); [`route/network.go`](https://github.com/Leadaxe/sing-box-lx/blob/3d3d3db3a2ccef3b1a8eb71b831ed2461c54b94d/route/network.go) and [the same commit's TUN documentation](https://github.com/Leadaxe/sing-box-lx/blob/3d3d3db3a2ccef3b1a8eb71b831ed2461c54b94d/docs/configuration/inbound/tun.md) | Existing separate executable boundary and distribution notices remain documented in [`engine/SOURCE.md`](../engine/SOURCE.md). No engine source was copied into the Apache-2.0 application in this audit. |

NetworkManager's canonical project is on [GitLab](https://gitlab.freedesktop.org/NetworkManager/NetworkManager). The [pinned GitLab file URL](https://gitlab.freedesktop.org/NetworkManager/NetworkManager/-/blob/62c8e8b2caebbb86182c79223c0109048eac154e/src/core/devices/nm-device-wireguard.c) could not be retrieved by the available web reader. The source comparison therefore used the project's GitHub mirror at the identical git commit, plus the project's published reference manual. This is not a claim that a different or unverified GitLab revision was inspected.

## What the comparison changed

### 1. Unknown inspection is a distinct outcome

Tailscale's Windows monitor treats failed required subscriptions as failures, and disables its default-interface cache if interface notifications cannot maintain it. It keeps IPv4 and IPv6 default-interface state separately; unsuccessful lookups are not reliable cached connectivity evidence. The useful principle here is to preserve uncertainty at an OS boundary, not to transplant a Go network monitor into Electron. See the [pinned Windows implementation](https://github.com/tailscale/tailscale/blob/9ad2a9623c9c762c98ef0c0752cdf8fba730066f/net/netmon/netmon_windows.go).

Previously `adapters()` caught every PowerShell failure and returned `[]`. Its scan also inherited permissive PowerShell error handling. A missing command result or partial query could therefore remove all conflict notices and feed an empty address list to the checker.

The scan now stops on native errors, reads adapter/address/route data into an explicit `{ ok: 1, adapters: [...] }` envelope, and validates the entire envelope. A complete empty array is valid; failed or incomplete evidence rejects. `refreshNotices(beforeStart)` converts rejection into a blocking notice before a new connection and a warning during an existing connection. `prepareConnection` explicitly requires a fresh successful scan even when it is restarting an already running tunnel. Probe/diagnostic callers skip the tunnel measurement on scan failure; they do not claim that a measurement happened.

`tunSnapshot()` and `defaultRoutes()` follow the same distinction. Missing arrays are no longer filled with `[]`. Malformed entries invalidate the response instead of being silently discarded. Their caller receives `undefined`, which already means unknown/refuse or not ready.

### 2. Address collision and route ownership are separate decisions

An address match is only evidence about an address. It is not evidence of key reuse, and it must not suppress route policy. The previous `continue` after an address warning skipped the check for a full-route external VPN on the same adapter.

The guard now emits both applicable notices. Whole-machine mode retains its block for a recognized external VPN with a full route. App-only mode retains its external-VPN warning. The address warning no longer contains wording implying that all other checks are bypassed. Interface ownership comparisons use Windows-style case-insensitive names.

Full-route evidence now includes IPv6 `::/0`, or both complementary IPv6 `/1` routes. IPv4 split routing likewise requires both halves on the same adapter; a single `/1` no longer counts as an entire family. Vendor words such as `Intel` no longer erase actual route evidence. Identification of *which adapter is a VPN* still uses the existing name/description heuristic; these changes do not turn that heuristic into a guarantee of interoperability.

### 3. Wake readiness must exclude the application's own tunnel

Mullvad's [offline architecture](https://github.com/mullvad/mullvadvpn-app/blob/d84a4d947b2715d44c9b8f49a18491e332ff55c0/docs/architecture.md#detecting-device-offline) separates local readiness from an actual traffic probe. Its Windows decision considers default routing and suspend state, with a wake grace period. Its Linux route query uses the exclusion firewall mark so the active tunnel cannot itself establish that an external route exists.

Waarp already had a settle window and excluded its own adapter, but the Windows query and predicate accepted only IPv4 gateways. An IPv6-only underlay could therefore consume the complete wake budget and close the session even though an external route was present. The reader now captures IPv4 and IPv6 default routes; the predicate validates addresses, allows scoped link-local IPv6 gateways, and rejects the own interface regardless of casing. Unspecified/on-link, loopback, multicast, malformed, and down-interface next hops do not establish readiness.

This remains a local readiness predicate. It does not prove DNS, captive portal, endpoint reachability, or packet delivery. It also conservatively excludes on-link-only PPP/VPN defaults; support for those requires a separate, evidence-backed policy. A valid next hop on a non-Waarp interface is not proof that the interface is physical.

### 4. A 30-second wake budget must bound a pending read

The previous loop checked its deadline only between awaited inspections. A late or hung native read could outlive the advertised budget, while an earlier wake's pending read could delay a later wake.

The read waiter now races the remaining budget and cancellation. The elapsed-time clock is monotonic. A late success cannot restart a cancelled or superseded wake; a second sleep/wake can proceed without waiting for the obsolete read to resolve. This cancels the application waiter, not the read-only PowerShell process: the underlying `defaultRoutes()` call retains its own native timeout. Restarts remain serialized and the existing owner revision check still wins over stale wake intent.

The follow-up review found the same boundary defect in `waitReady()`: a controller call begun before the deadline could return success after it, or remain pending past the budget. Its total deadline now races both the probe and retry pause. Success is accepted only before the monotonic deadline and while the same process is alive. Cancellation remains immediate; expired waits issue no further probes. The outstanding HTTP request keeps its own I/O timeout. Injectable timers preserve deterministic tests alongside the existing fake `now`/`sleep` dependencies.

### 5. Keep interface rebinding in the pinned core

The bundled engine's [network manager](https://github.com/Leadaxe/sing-box-lx/blob/3d3d3db3a2ccef3b1a8eb71b831ed2461c54b94d/route/network.go) already constructs network and default-interface monitors, registers interface callbacks, pauses when no default interface exists, and dispatches interface updates to endpoints/inbounds/outbounds. It also has Windows power handling. Consequently this audit does **not** add an Electron restart on every NIC or metric change; that would compete with the core's existing responsibilities. The wrapper keeps its bounded resume recovery path.

The existing `auto_detect_interface` prevents outbound recursion, while the pinned [TUN documentation](https://github.com/Leadaxe/sing-box-lx/blob/3d3d3db3a2ccef3b1a8eb71b831ed2461c54b94d/docs/configuration/inbound/tun.md#strict_route) explains the Windows DNS role and interoperability tradeoff of `strict_route`. This audit retains those options and the service-subnet reject rule. It does not weaken DNS routing to make a competing VPN appear compatible.

### 6. DNS and route policy have to be checked together on Linux

NetworkManager's [WireGuard implementation](https://github.com/NetworkManager/NetworkManager/blob/62c8e8b2caebbb86182c79223c0109048eac154e/src/core/devices/nm-device-wireguard.c) determines automatic default-route behavior separately for IPv4 and IPv6, including `never-default`. Its [settings reference](https://networkmanager.pages.freedesktop.org/NetworkManager/NetworkManager/nm-settings-nmcli.html) documents separate policy tables/rules and firewall marks for WireGuard defaults. It also explains why a normal configured gateway can conflict with that behavior. DNS priorities and routing domains control which connection's resolver receives a query; looking only at the main routing table or at `/etc/resolv.conf` is insufficient when split DNS is active.

Those mechanisms inform the validation cases below. They are not copied into this Windows client's startup path, and Linux NetworkManager success is not evidence that Windows Wintun/UAC/suspend handling works.

## Focused regression results

Executed after the source fixes on the Linux workspace using the repository's esbuild/Node test pattern:

| Suite | Observed result | What it covers |
|---|---:|---|
| `test/network-inspection.check.ts` | **39 passed** | Native failure vs empty evidence; partial adapter/TUN/default-route envelopes; malformed addresses; IPv6 full-route VPN; complementary `/1` handling; case-insensitive owned adapter; warning while running vs block before start. |
| `test/resume.check.ts` | **44 passed** | Existing coalescing/revision cases; exact deadline with a never-resolving inspection; cancel without native completion; later wake despite obsolete hung read; IPv6 and invalid gateway cases. |
| `test/tun.check.ts` | **53 passed** | Service-subnet routing order, readiness cancellation/deadline, late controller success/failure, retry-pause cancellation, read-only preflight decisions, ports, and refused-start behavior. |
| `test/core.check.ts` | **130 non-IPC checks passed; IPC explicitly skipped** | Existing config/guard checks plus same-address/full-route independence and interface name casing. Local IPC transport returned Linux `EPERM`; this is partial coverage, not a Windows IPC pass. |
| `test/stop.check.ts` | **46 passed** | Existing stop and cancellation regressions rechecked after the shared readiness waiter changed. |
| `test/engine-recovery.check.ts` | **28 passed** | Existing engine recovery regressions rechecked after the shared readiness waiter changed. |

The focused network suites do not instantiate a Windows adapter or invoke live PowerShell. Native Windows execution and user-interface evidence belong to the Windows/CI validation tracked in the startup report. No full test-runner result is inferred from these focused runs.

## Reproducible Linux observations for the integrated validation

These are read-only observations for an isolated Linux reproduction. They are provided as a concrete comparison procedure, **not as a claim that this sub-audit executed a live Linux TUN**. The integrated task records its actual engine runs separately.

```sh
ip -j -4 route show table all
ip -j -6 route show table all
ip -j -4 rule show
ip -j -6 rule show
nmcli -t -f NAME,UUID,TYPE,DEVICE connection show --active
nmcli -f GENERAL,IP4,IP6 device show
resolvectl status
```

Use `nmcli`/`resolvectl` only where the corresponding service is installed. Capture the baseline, active tunnel, an induced interface change, and clean shutdown. Compare routing tables **and** rules in both families. For an endpoint route lookup, use the actual exclusion mark from the controlled engine fixture; a lookup without the mark can return the tunnel and create false evidence of an external path. A route lookup itself does not transmit packets. Do not publish private keys, generated secrets, or full credential-bearing configs with these observations.

| Controlled case | Required observation |
|---|---|
| IPv4 only; IPv6 only | External route readiness is evaluated in the available family; lack of the other family is not treated as loss of all connectivity. Actual endpoint success is recorded separately. |
| One split `/1`; complementary `/1` pair | The first is partial routing, the second covers an address family on that interface. Preserve the distinction when reporting conflicts. |
| Tunnel active, underlay removed | A route through the own tunnel does not count as an external route. A marked lookup and the table/rule snapshot must agree. |
| Default NIC or metric changes | Check that the pinned core updates its binding; distinguish new-flow success from survival of an existing TCP session. Do not infer this from a controller `/version` reply. |
| Two VPN profiles and split DNS | Compare DNS routing domains/priorities with packet routing; a default-route listing alone does not establish DNS compatibility. |
| Sleep/reconnect while owner selects OFF | No delayed callback reopens the tunnel; a late successful native query is ignored. The deterministic version of this case is covered above. |
| Clean shutdown | Owned routes/interface are gone or explicitly reported as unresolved; unrelated adapters and DNS settings remain as in the baseline. |

## Remaining boundaries

The guard intentionally reports evidence and refuses ambiguous startup; it does not repair arbitrary host networking. Name-based VPN identification, on-link-only underlay support, broader overlapping LAN routes, DNS interoperability with another VPN, and native driver timing require platform evidence before changing policy. An IPv6 route-readiness fix is also not a claim that every imported profile, resolver, or endpoint supports an IPv6-only access network.

The application still relies on the engine for ordinary interface changes and actual data-plane routing. A successful local API request or valid route snapshot alone must not be displayed as proof that a remote tunnel or website works. The separate health/probe path supplies that evidence.
