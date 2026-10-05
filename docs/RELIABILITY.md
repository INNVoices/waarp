# Reliability: failure matrix

Rule: **if the system state is unclear, Waarp stays off. It never "repairs" Windows broadly.** It never deletes network adapters, resets Winsock or DNS, or changes another VPN.

Columns: what the user sees · what Waarp changes · what it never changes · whether a new tunnel may start · offline test.

| Case | User sees | Waarp changes | Never changes | New TUN | Test |
|---|---|---|---|---|---|
| Controller port taken | "Нет свободного локального порта…" | nothing (no process started) | ports of other apps | yes, next try picks another port | `tun.check` (port) |
| No engine binary | "Не найден движок…" | nothing | — | no, until reinstall | `matrix.check` |
| Engine checksum mismatch | block notice "Движок Waarp повреждён" | nothing | — | no, until reinstall | `matrix.check` (verifyEngine) |
| Config write / ACL failure | "Не удалось записать временный конфиг движка" | removes its own temp file | — | yes, next try | `matrix.check` |
| Core exits before ready | the core's own error, or "Движок не стартовал" | own process ends; read-only residue check | adapters, routes, DNS | yes, unless residue is found | `tun.check` (waitReady exited), `matrix.check` |
| Startup timeout (20 s) | the core's error / "Windows не успел открыть адаптер Waarp…" | stops its own process (graceful, then forced via its own handle) | other adapters | yes, if no residue; no automatic retry | `tun.check`, `stop.check` |
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

## Not provable offline

These are planned for a disposable Windows VM and never run on a developer workstation:
- graceful exit actually removes the Wintun adapter and routes;
- real shutdown / logoff timing;
- sleep / hibernate / Wi-Fi ↔ Ethernet;
- coexistence with another full-route VPN;
- antivirus file locks;
- upgrade / reinstall / uninstall;
- 50+ start/stop cycles.
