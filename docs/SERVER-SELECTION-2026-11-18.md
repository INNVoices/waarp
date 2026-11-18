# Server selection — Windows 0.4.1-rc.3

This describes Windows `0.4.1-rc.3`, published in the [18 November 2026 preview](https://github.com/INNVoices/waarp/releases/tag/preview-2026-11-18-r3). Android remains at `0.5.0-rc.4`; its UI is separate. Downloads and verification scope are tracked in [RELEASES.md](RELEASES.md).

## From an application to a server

The existing application chooser stays unchanged. After selecting an app, service or address, its route opens one server-selection screen:

| Choice | Behavior |
| --- | --- |
| Automatic | Choose among eligible personal connections and keep a working path. Public servers do not join Auto. |
| Manual → Saved | Search the connection library and select a compact server row. Ten entries per numbered page. |
| Manual → Public servers | Search the entire stored pool, filter by region and availability, and select a server. Twelve entries per numbered page. |
| Direct | Send this target through the provider without changing the other routes. |

The public source is a visible tab, not a collapsed appendix. The route diagram, backup choice and advanced matching options live under **Parameters and connections**. Existing application-selection tiles are preserved.

## Availability is separate from pool size

A downloaded endpoint is a candidate, not evidence of a working connection. The catalogue presents a fresh-success count separately from the stored pool size. When fresh results exist at entry, **Available now** is the initial filter. Otherwise it shows actionable candidates and starts one bounded search. Filters and pages do not change underneath a user who has started browsing.

Entering an empty catalogue requests its sources. Entering a cached catalogue without fresh successes requests one verification round. There is no startup-wide or periodic scan. Refresh and verification remain available while the main VPN is running; a local checker uses a proxy listener, creates no TUN, and does not replace the current session.

Selecting an unchecked or stale candidate performs a targeted check through that exact node before importing it. A failed check reports the reason and leaves the app's route unchanged. The target check takes precedence over the bulk round. Displayed latency is an HTTP-check observation, not game-server ping or a promise of future availability.

Search and pagination operate against the full stored pool. The short snapshots used for progress updates no longer limit browsing to 200 candidates.

## Changing an active route

Normal card changes use live routing updates. Selecting a server that was not loaded at VPN startup can prepare a separate local forwarding worker while the existing main TUN stays owned by the master switch. Card edits do not request a whole-VPN restart. A failed live application restores the previous saved selection and reports the failure.

A successful path change may close connections belonging to the edited rule so they can reconnect through the new server. Unrelated routes retain their VPN session. The owner's global OFF command takes precedence over pending verification and route changes.

The interface locks the card's toggle/removal only while its specific selection is in progress. Browsing and pool verification do not acquire that lock. Leaving the picker while a check is pending prevents a late callback from activating the abandoned selection.

## Verification and images

Regression coverage includes full-pool search beyond the old sample, page replacement, stale observations, checks while ON, failed candidate selection and preservation of master intent. Backend checks cover targeted verification and live routing.

The [complete Windows validation and packaging job](https://github.com/INNVoices/waarp/actions/runs/44276974976/job/134708014209) also passed: typecheck and offline regressions, 31 browser scenarios including 100 renderer cycles, the native route gate, 50 native TUN lifecycle cycles, and portable-package integrity checks against the version and source commit.

The [Windows native preflight](https://github.com/INNVoices/waarp/actions/runs/44276974976/job/134707490104) passed for [source commit `f66e5def3d68`](https://github.com/INNVoices/waarp/commit/f66e5def3d689837db010c3453086a832c701fcc) on 18 November 2026. It ran the actual pinned native engine and a real TUN on a disposable GitHub-hosted Windows runner. The recorded evidence covers:

- **Readiness of a newly selected profile:** the unchanged `Checker.pings()` performed its production HTTPS check through the selected C relay. Native TLS verification remained enabled; the controller returned HTTP 200 with a measured delay of 90 ms. The relay allowed only the two production health hostnames on port 443, with their public IPv4 addresses resolved before TUN startup.
- **Selected traffic:** actual TCP payload and authenticated diagnostic traffic returned C's fixture response. A UDP datagram crossed the main TUN and the newly started local worker, returned C's response, and was not received by the A or B fixtures.
- **Worker DNS:** a separate pair of generated no-TUN configurations exercised the production UDP-over-TCP relay and DNS interception rule. The query reached the selected profile's controlled DNS fixture and returned its expected answer; both extra native processes stopped. This checks that worker DNS path, rather than a complete system-DNS or external-resolver scenario.
- **Session continuity:** the main process PID and session start stayed unchanged, and an already-open neighboring stream kept echoing data during server changes and the late profile selection. Active-route deletion, inactive-route addition/removal, and removing then re-adding the last route also passed without replacing the main process.

This native run exercised one newly selected profile. The [implementation](../src/main/live-outbound.ts) reserves 16 slots for simultaneous forwarding workers for profiles absent from the initial native graph; [offline regressions](../test/live-outbound.check.ts) cover capacity and reuse. That limit is independent of the number of saved servers. The native preflight establishes this focused routing behavior; it does not certify the public catalogue's reliability or complete stable-release or Android acceptance.

The current picker gallery is generated by [`test/ui.browser.mjs`](../test/ui.browser.mjs) from the built production renderer in Chromium, with synthetic profiles and in-memory status. It includes the [selected server](screenshots/server-picker.png), [twelve public rows with numbered pages](screenshots/public-server-pages.png) and [ten saved rows at a narrower width](screenshots/saved-server-pages.png). The taller captures retain the complete list and page controls by increasing the real viewport height; they do not change application styles.

Gallery images are published only after the captured files are reviewed. Their availability counters and latency values come from test fixtures, so they are evidence of the rendered interface, not of remote connectivity or a passing native gate. [Capture sources and the historical gallery](screenshots/README.md) document that distinction; download status remains in [RELEASES.md](RELEASES.md).
