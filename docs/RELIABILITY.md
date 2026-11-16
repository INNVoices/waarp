# Reliability: failure matrix

Rule: **if the system state is unclear, Waarp stays off. It never "repairs" Windows broadly.** It never deletes network adapters, resets Winsock or DNS, or changes another VPN.

Columns: what the user sees · what Waarp changes · what it never changes · whether a new tunnel may start · offline test.

| Case | User sees | Waarp changes | Never changes | New TUN | Test |
|---|---|---|---|---|---|
| OFF during startup / ON-OFF-ON | the latest owner's choice | aborts obsolete readiness/requests; serializes starts | a newer ON is never consumed by an old completion | only for the current revision | `control.check`, `tun.check` |
| No route needs TUN while an old core remains | idle only after a verified stop, otherwise an error | stops its own unnecessary core | never reports an unverified idle state | no until cleanup succeeds | `control.check` |
| Catalog refresh races with ON | canceled catalog check, preserved previous list | aborts downloads and verifies checker exit | no background public scan at app launch | only after checker exit | `catalog.check` |
| A stale renderer saves a whole routes/groups list | refresh-and-retry message | rejects the stale write | newer companion / renderer edits | unchanged | `settings.check` |
| Removed companion path and another settings edit | the missing route stays blocked; other edits work | allows unchanged unavailable paths to remain or be disabled | no new public/unsafe path | according to the remaining plan | `settings.check` |
| Selected group member fails while a spare is healthy | the actual selected path's state | changes selector after confirmed failure and frees old sessions | never reports the spare as proof the current path works | unchanged | `effective.check`, `groups.check` |
| Healthy active sessions and a faster HTTP probe | current sessions keep their path | postpones performance-driven selection until idle | no promise of measured game ping | unchanged | `groups.check` |
| Controller port taken | "Нет свободного локального порта…" | nothing (no process started) | ports of other apps | yes, next try picks another port | `tun.check` (port) |
| No engine binary | "Не найден движок…" | nothing | — | no, until reinstall | `matrix.check` |
| Engine checksum mismatch | block notice "Движок Waarp повреждён" | nothing | — | no, until reinstall | `matrix.check` (verifyEngine) |
| Config directory / write / ACL failure | "Не удалось записать временный конфиг движка"; shell still opens | removes its own temp file when possible | a file obstructing the runtime directory | yes, after access is restored | `matrix.check`, `engine-recovery.check` |
| Core exits before ready | the core's own error, or "Движок не стартовал" | own process ends; read-only residue check | adapters, routes, DNS | yes, unless residue is found | `tun.check` (waitReady exited), `matrix.check` |
| Startup timeout (20 s) | the core's error / "Windows не успел открыть адаптер Waarp…" | attempts an ownership-verified console signal when available; otherwise stops via its own child handle | other adapters and shared consoles | yes, if no residue; no automatic retry | `tun.check`, `stop.check` |
| Core has no isolated console | stop continues without an unused five-second grace wait | uses only the existing child handle; checks exit and residue | other consoles/processes | only after confirmed stop | `stop.check`, `runtime-windows.check` |
| Stop timeout | "Движок не подтвердил остановку…" | keeps the ownership lease | — | no | `stop.check` (stuck) |
| Stale lease, PID reused | nothing | clears its own lease | the unrelated process (never signalled) | yes | `stop.check` (recovery) |
| Stale lease, same process alive | — | terminates that exact identity, clears the lease only after it is gone | anything not matching path + start time | only after confirmed gone | `stop.check` (recovery) |
| Leftover Waarp adapter | "В Windows остался адаптер Waarp… Перезагрузи компьютер…" | nothing | the adapter itself (no auto delete in v1) | no, until it is gone | `tun.check`, `stop.check` (residue) |
| Waarp subnet taken by another interface/route | "Служебная подсеть Waarp уже занята (…)" | nothing | the other interface/route | no, while taken | `tun.check` (collision) |
| Network state unreadable | "Не удалось проверить сетевые адаптеры Windows…" | nothing | — | no | `tun.check` (tun_unknown) |
| Store unreadable | warning notice; settings not saved | copies the file aside | the original file | yes | `matrix.check` |
| DPAPI unavailable | warning "Ключи не сохраняются" | keeps keys in memory only | — (no plaintext fallback) | yes | `matrix.check` |
| Another full-route VPN | block notice "Включён другой VPN: …" | nothing | the other VPN | no, while it holds the full route | `core.check` (guard) |
| Selected profile removed / revoked while running | the route shows blocked | rejects that route's traffic | never falls back to Direct | yes | `core.check`, `effective.check` |
| Fallback removed | fallback ignored, route keeps its primary | — | never Direct | yes | `fallback.check` |
| Companion route made unsafe | `blocked` to the companion; picker hides unsafe paths | nothing | never a public/revoked path | yes | `bridge.check` |
| Sleep / resume storm | one restart once a usable network with a default gateway is back, or one message | one restart, at most | other adapters / VPNs | one attempt, no loop | `resume.check` |
| Crash while the UI stays open | error + residue check | own process ends | adapters, routes, DNS | yes, unless residue is found | `matrix.check` |
| Large library on Auto | "Авто: 16 из N кандидатов активны" | runs a bounded pool (16 Auto-only endpoints) | settings, profiles | yes | `autopool.check` |
| App quit / Windows logoff with the tunnel on | — | waits up to 15 s for a verified stop | — | — | `stop.check` (bounded) |

## Test coverage boundaries

`npm test` discovers `test/*.check.ts` suites. On Windows this includes native process ownership, no-console signaling and parent-wait checks using disposable Node children; these checks do not create a TUN or contact a private server. They explicitly skip on other platforms. Restricted non-Windows workers can also reject Unix sockets with `EPERM`/`EACCES`; that IPC section is explicitly skipped, and the runner prints `Partial coverage`. A Windows named-pipe failure is never skipped. External-network live scenarios remain separate opt-ins.

The renderer DOM harness is `npm run test:ui`. Run `npm run build` first and install Playwright's Chromium; the wrapper starts its own temporary loopback HTTP server for the production renderer. It uses injected IPC, never a real tunnel. Actual results and platform limits belong in [the validation record](VALIDATION-2026-11-16.md), with the release decision in [the stable acceptance matrix](STABLE-AUDIT-2026-11-16.md). A successful DOM check is not evidence of system routing.

## Windows stop behavior

The normal Node spawn with `windowsHide: true` and piped stdio generally creates no console (`CREATE_NO_WINDOW` in [libuv's Windows launcher](https://github.com/libuv/libuv/blob/v1.51.0/src/win/process.c)). This does not provide an invisible console for `CTRL_BREAK`. The stop helper reports whether a signal was actually sent. Only then does Engine wait the graceful budget; a missing console takes the verified own-handle termination path immediately.

Before any console signal, the helper holds a native process handle and repeats the journal path/creation-time check. It rejects a console containing processes other than the recorded child and the helper, and targets the child's process group instead of broadcasting group zero. Neither a successful helper invocation nor sending a signal proves exit: the child handle and subsequent read-only residue inspection remain the completion criteria. Full Wintun cleanup and shutdown behavior require the native acceptance scenarios below.

## Not provable offline

These are planned for a disposable Windows VM and never run on a developer workstation:
- graceful exit actually removes the Wintun adapter and routes;
- real shutdown / logoff timing;
- sleep / hibernate / Wi-Fi ↔ Ethernet;
- coexistence with another full-route VPN;
- antivirus file locks;
- upgrade / reinstall / uninstall;
- 50+ start/stop cycles.
- existing game TCP/UDP sessions recovering after selector failover;
- strict-route DNS filtering, IPv6/application DoH, and private DNS across different providers.
