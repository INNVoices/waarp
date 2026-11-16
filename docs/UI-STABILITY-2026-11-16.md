# Renderer visual and stability audit — 2026-11-16

## Scope and evidence

The visual review inspected seven PNG artifacts from successful Windows Chromium CI run `43891541976`: `connections.png`, `connection-error.png`, `import-error.png`, `group-save-error.png`, `public-min-width.png`, `startup-recovering.png`, and `startup-recovery-failed.png`. These are real Chromium renders of the production bundle. Their backend is the explicitly injected fixture in [`test/ui.browser.mjs`](../test/ui.browser.mjs), not an Electron process or a live VPN.

The new responsive/history fixes and the 100-cycle stability gate described below were implemented **after** those screenshots. Their fresh Windows CI result must be recorded from the subsequent run; the earlier screenshots do not prove that the new checks passed.

## Visual findings

| Screen | Observation from the artifact |
|---|---|
| Connections | Profile cards, public catalog actions, explanatory text, and the error toast fit the window. The connection error carries a warning icon rather than a success checkmark. |
| Connection failure | The master remains closed and the hero offers opening again. The failed action is visible in the toast. Parts of the image were captured during the page's fade/translation animation, so it was not a clean typography reference. |
| Import failure | The modal stays open, the subscription input remains populated, the inline error is visible, and Add/Back/Close remain laid out within the modal. The earlier connection-error toast is still present because this fixture sequence advances before its five-second dismissal. |
| Group save failure | Both selections remain selected and the editor stays open. The raw fixture message has a neutral information icon, not a success mark. This is the intentional treatment of untyped backend messages; it is not evidence that all such failures have red error styling. |
| Recovery in progress | The top bar and hero state that startup is being restored. The master is visually closed, and the spinner does not claim a working tunnel. This image also catches a transition frame. |
| Recovery failure at 900 × 600 | The concrete reason, Retry, and Recover controls are visible together. No success checkmark appears. The controls and route cards fit; the transient bottom toast overlaps part of the lower explanatory line, without covering either recovery action. |
| Public catalog at 900 × 600 | The page itself fits, but the wide internal table places the ping value and row action beyond its initially visible right edge. Source and the existing test confirmed intentional internal scrolling, not whole-page overflow. It was still a usability problem because the action was hidden at the supported minimum window width. |

### Narrow visual correction

At widths up to 1040px, only the public table's column widths/gaps are compacted. All seven columns remain: country, name, address, protocol, source, ping, and action. The action keeps 88px and the ping 54px. Existing name/address ellipsis remains; longer protocol text can also ellipsize. An embedded table narrower than the supported main view can still scroll internally.

The updated browser assertion checks that the table fits at 900px, that both the ping and action rectangles lie fully within its viewport, and that the action can be clicked while `scrollLeft` remains zero. This is stronger than the previous assertion, which merely proved that overflow stayed inside the table.

Screenshots now wait for fonts and use Playwright's documented [`animations: 'disabled'`](https://playwright.dev/docs/api/class-page#page-screenshot) option. That removes transition-frame blur from visual evidence without changing production animations.

## Confirmed source cleanup and memory correction

`App.autoFind` was initialized to false, only reset to false, and never enabled. App passed that false value to AddTunnel; its other caller, Servers, used the false default. The AddTunnel mount effect for automatic discovery was therefore unreachable. The unused state, prop, resets, and effect were removed. Explicit discovery still works.

The discovery completion callback is **not** dead code. App reads `waarp-first-scan` when deciding whether to show the empty-library first-run prompt, and successful explicit discovery writes that key. The callback was renamed `onDiscoveryDone`; its reader/writer behavior was retained. Removing it would change the next-launch experience after a successful scan that finds no profiles.

Ping history already capped each profile at 120 samples, but removed profile IDs could remain in the history map until a later starting/stopping event. The Analyzer displays only currently present profiles, so those retained histories were invisible while still consuming memory. Accepted settled snapshots now remove histories for absent profile IDs, retaining `direct`. A recovering snapshot does not retire history, and queued measurements for a deleted profile cannot recreate its entry. No production debug endpoint or history-inspection hook was added.

## Stability gate and fixed budgets

The test runs the production renderer in Chromium with in-memory IPC. Ten warmup cycles precede 100 measured cycles. The limits were declared before execution and are held in `STABILITY_LIMITS` in the browser suite.

| Gate | Predeclared limit |
|---|---:|
| Completed measured cycles | 100 |
| Total duration of those cycles | ≤ 90,000ms |
| Active fixture IPC subscription counts | Exactly the warmed baseline after every cycle and at the end |
| Retained JS heap growth after forced GC | ≤ the larger of 8MiB or 25% of warmed baseline |
| DOM node growth after GC | ≤ 200 |
| DOM event-listener growth after GC | ≤ 8 |
| Document count growth | ≤ 1 |
| Renderer console errors | 0 |
| Page errors / unhandled rejections | 0 |

Cycle p50, p95, and maximum durations are reported rather than treated as machine-independent per-frame budgets. The elapsed-time gate includes test-driving overhead and is a regression bound, not a native networking latency benchmark.

Each cycle opens and closes through the real controls; alternate cycles cancel a deferred opening. It then presents failed startup and uses Recover, periodically exercises failed repair followed by a successful retry, updates the route snapshot, switches the route off/on, and visits Analyzer and Connections. Opening/closing a group modal exercises focus-handler cleanup; mounting/unmounting the public catalog exercises subscription cleanup.

The history check creates a temporary profile and records visible measurements. A recovering empty snapshot must preserve that history. A subsequent authoritative removal, late queued measurement, and re-addition without a new measurement must leave no old history visible. The direct and retained personal-profile histories must remain. This verifies the memory correction through the visible Analyzer without exposing private application state.

The retained-memory observations use Chromium's primary [HeapProfiler](https://chromedevtools.github.io/devtools-protocol/tot/HeapProfiler/), [Runtime heap-usage](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/#method-getHeapUsage), and [DOM counters](https://chromedevtools.github.io/devtools-protocol/tot/Memory/#method-getDOMCounters) protocol methods. IPC listener counts come from the test fixture's subscription registry.

## Artifacts and validation status

The existing Windows workflow collects `out/ui`. The stability gate writes `stability-metrics.json` there with the source SHA, Chromium version, scope, fixed limits, baseline/final counters, growth, cycle durations, completion count, and pass/fail status. It also writes `stability-after-100-cycles.png`, or `stability-failed.png` for a failure after the page is available. The report is written before numerical assertions so a failed bound remains reviewable.

Local validation after these edits: JavaScript syntax check passed; strict TypeScript typecheck passed; `apply.check.ts` passed 52 checks; `flow.check.ts` passed 45 checks; `git diff --check` passed. Chromium was not launched locally for this final review. Fresh native Windows/Chromium CI evidence remains the authority for the new DOM, responsive-layout, and stability checks.

## What this does not establish

Passing this gate establishes bounded behavior for these repeated renderer flows and the declared test data. It is not proof of unlimited uptime, performance with arbitrarily large subscriptions, or absence of every leak. Forced-GC growth limits are deliberately tolerant of caches and framework allocation, while the exact subscription and visible-history assertions catch the specific lifecycle regressions directly.

The fixture does not validate native IPC authorization, UAC, Wintun, suspend/resume drivers, system DNS/routes, packet delivery, or tunnel recovery on the user's Windows installation. Those require the separate engine/native checks and actual controlled connection runs in the overall stability matrix.
