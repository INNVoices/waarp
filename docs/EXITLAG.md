# ExitLag companion (Windows)

## Purpose
This integrates the already-installed official ExitLag client as an **external manager** for selected app cards. It does **not** implement the ExitLag protocol, import credentials, read private local IPC, or turn ExitLag into a sing-box outbound. Android is unaffected.

## Data boundaries
- Read-only snapshot of app selections from %LOCALAPPDATA%\ExitLag\storage.db using Node SQLite with mode=ro and immutable=1. Only id, enabled, automatic_fs, fs_name, fs_alias and fs_country are queried. The data may be stale. No account/device tables are read.
- One explicit "Read visible servers" button invokes **read-only** Windows UI Automation to list currently visible server display names in the already-open ExitLag route screen; no click, scroll, focus, selection, or ping button is triggered.
- Duplicate names are not unique server IDs. A full catalog and independent per-card relay selection have **not** been established. The panel never pretends they have.
- User-initiated "Open ExitLag" launches its official executable; this is not called on startup.

## Routing contract
- Only a real **application** card may select "ExitLag (external)" as its path. No global rest/default, domain/preset/list cards, groups, companion routes or fallback may use it.
- ExitLag is expected to capture supported application's packets *before* they enter Waarp TUN. The application must first be configured/enabled in ExitLag itself; Waarp cannot enroll arbitrary EXEs.
- A process-attributed match for an external application is **rejected** inside Waarp TUN before LAN/RU Direct bypasses; its ordinary card slot also rejects. Unattributed OS DNS/traffic or traffic that never enters TUN may escape this rule. This is NOT a standalone OS firewall kill switch or a guarantee of universal leak prevention.
- ExitLag's own process egress uses existing VPN-client Direct exception rules, so its connections do not recurse into an ExitLag card.
- No external path is included in Auto, normal group selectors, health-ping or game latency tests. UI says "controlled externally, not verified", never green/working.
- ExitLag and Waarp are independent processes. Disabling Waarp does not stop ExitLag. If strict containment is required even when Waarp is OFF/crashes, a separate Windows firewall policy and native acceptance are necessary; none is installed by this feature.

## Acceptance still required on a real Windows machine
Two concurrently active apps with distinct ExitLag servers, TCP/UDP/IPv6 and DNS, sleep/restart, ExitLag disabled/subscription lapse, and packet-leak checks. No such native tests are claimed. The v3 observation archive records per-app saved selections and partial UI display names, not remote route validation.

## Why not a complete universal provider?
ExitLag 5.23.3 presents no documented local SOCKS/HTTP proxy or consumer control API. The UI presents duplicated names without reliable IDs; the B2B SDK is a separate licensing avenue. Calling its private localhost socket or changing its SQLite DB would not be a safe supported integration.
