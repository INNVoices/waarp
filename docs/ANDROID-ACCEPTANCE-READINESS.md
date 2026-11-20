# Acceptance readiness: observed failures and bounded corrections

## Current follow-up: explicit emulator storage

[Android run 44429864105](https://github.com/INNVoices/waarp/actions/runs/44429864105),
source `a05365f551800df78473eb4f17dda5ce092489bf`, passed the build/static gate,
native API 29/35 and optimized-release API 35. It did not pass full Android
acceptance, and the two-hour soak was skipped.

The [native API 36 job](https://github.com/INNVoices/waarp/actions/runs/44429864105/job/135247787037)
stopped while creating the installation session, before app tests:
`Requested internal only, but not enough space`. The emulator inputs did not
declare a data-partition size. All four emulator steps now request `4096M`
explicitly and print `df -Pk /data` before preparation or installation so that
the actual guest capacity remains visible in the job log. The pinned
[emulator action](https://github.com/ReactiveCircus/android-emulator-runner/blob/a421e43855164a8197daf9d8d40fe71c6996bb0d/src/emulator-manager.ts)
maps `disk-size` to `disk.dataPartition.size` when creating the disposable AVD.
This changes test-environment storage; it does not establish a smaller APK or
successful installation until a new runtime job demonstrates it.

Two other failures remain separate from storage:

- [Release API 29](https://github.com/INNVoices/waarp/actions/runs/44429864105/job/135247786948)
  lost the new `system_server` during framework preparation. The retained
  crash log reports `DeadSystemException` before app installation. The
  preparation check correctly rejected the changed process identity.
- [Release API 36](https://github.com/INNVoices/waarp/actions/runs/44429864105/job/135247787060)
  refused trace-buffer preparation: `events/enable` was `X`, although
  `tracing_on` was `0` and the observed Perfetto session counts were zero.
  That is not the required proof that every event is disabled. The existing
  refusal remains in place; no active tracing is stopped or cleared.

The failure archives were verified against their GitHub SHA-256 digests and
all ZIP entry CRCs before inspection: API 29 artifact `14486787174`
(`9f3f2d3211a77fdfefd91091bca739196ffa5e0dbbef7f402a143414efa44956`),
and release API 36 artifact `14486517407`
(`0243a92674f3d10a96eba45feab786ba414ac6e4c7c23c8d6a2e21bee2e1c3e0`).
App assertions, RAM/heap, page sizes, time limits, encrypted traffic proof
and the mandatory two-hour soak are unchanged. These failures must not be
converted into a production-release approval.

## Earlier run: 44024845939

This records the evidence from [Android run 44024845939](https://github.com/INNVoices/waarp/actions/runs/44024845939), source `717b8b810702e84254c449c02a3401bb9e6c4336`. It is a failed acceptance run, not a stability certificate. Downloaded failure archives were checked against the GitHub artifact size and SHA-256, then every ZIP entry CRC, before analysis.

| Gate | Observed outcome |
| --- | --- |
| Source-built native core, build, JVM, lint and APK integrity | Passed; 104 JVM tests, zero failed/skipped |
| Native API 29 | Preparation failed on a process-name snapshot before instrumentation |
| Release API 29 | One smoke test failed while waiting for an already hidden keyboard |
| Native API 35 | 13 of 19 tests passed; one second-cycle DNS timeout and five consent/UI failures |
| Release API 35 | Passed |
| Native API 36, actual 16 KiB pages | Passed |
| Release API 36, actual 16 KiB pages | Passed |
| Two-hour AWG2 soak | Skipped because prerequisite jobs failed |

Both desktop jobs in [run 44024845915](https://github.com/INNVoices/waarp/actions/runs/44024845915) passed. The unchanged native core reproduced the frozen AAR and source-input pins. These results do not substitute for the missing Android gates.

## Android 10 framework preparation

The native job rejected a PID that appeared under two names in successive shell observations during zygote specialization. The correction accepts only a unique current snapshot, retains accepted owners, and keeps the existing deadlines and single preparation restart. The actual values, source analysis and invariants are in [ANDROID-API29-EMULATOR.md](ANDROID-API29-EMULATOR.md).

## An IME window is not proof of a visible keyboard

[Release API 29 job 133845679909](https://github.com/INNVoices/waarp/actions/runs/44024845939/job/133845679909) failed with `ime_did_not_close` after entering the import configuration and before submitting it. The retained screenshot shows the form and import button with no keyboard. The log records Back at 05:43:22.052 UTC, IME deactivation at 05:43:22.348, and a retained `TYPE_INPUT_METHOD` window with a null accessibility root at 05:43:28.397. There was no authenticated traffic in this journey.

The old helper equated the existence of an IME window with visibility. The replacement has three states: visible, hidden and unknown. A null root alone remains unknown, as required by the [accessibility window contract](https://developer.android.com/reference/android/view/accessibility/AccessibilityWindowInfo#getRoot()). If accessibility retains an IME window without a visible root, a bounded WindowManager dump corroborates visibility, surface ownership and whether that surface is shown. Both input-method windows and input-method dialogs are considered. A truncated, contradictory or unsupported dump cannot establish absence.

The parser follows the primary [Android 10 WindowState](https://github.com/aosp-mirror/platform_frameworks_base/blob/android-10.0.0_r47/services/core/java/com/android/server/wm/WindowState.java), [Android 15 WindowSurfaceController](https://github.com/aosp-mirror/platform_frameworks_base/blob/android-15.0.0_r1/services/core/java/com/android/server/wm/WindowSurfaceController.java) and [Android 16 WindowStateAnimator](https://github.com/aosp-mirror/platform_frameworks_base/blob/android-16.0.0_r1/services/core/java/com/android/server/wm/WindowStateAnimator.java) output formats. A retained API 35 diagnostic confirms the window/type/visibility fields but intentionally omits the complete dump header/footer and surface-shown lines; that filtered file correctly remains unknown. Missing runtime evidence is not reconstructed.

Completion requires the same focused app window and 250 ms of stable hidden state within one absolute five-second budget. At most one Back is allowed. A fresh accessibility observation after the WindowManager query overrides stale information, so an IME that has just disappeared cannot cause Back to dismiss the form. The code releases every accessibility window/root and retains only scalar failure diagnostics, not editor contents or raw dumps. Pure-Java fixtures cover these predicates; the new Android run must still prove the actual integration.

## A boot key event triggered a foreign launcher failure before installation

The [native API 35 job](https://github.com/INNVoices/waarp/actions/runs/44024845939/job/133845679862) retained an actual Pixel Launcher ANR dialog. Its window owned focus over the VPN consent dialog and over otherwise rendered Waarp UI. Four UI scenarios failed in their focused-window preparation; their test bodies did not start. The consent scenario could not obtain the required focused positive button.

The guest/action timestamps establish the ordering on 2026-11-17 UTC:

| Time | Event |
| --- | --- |
| 05:42:43.239 | `sys.boot_completed=1` was observed |
| 05:42:43.253–05:42:52.711 | The pinned emulator action executed `shell input keyevent 82` |
| 05:42:50.411 | Pixel Launcher input-dispatch ANR: no focused window |
| 05:42:53.297 | The owned AWG peer started |
| 05:42:53.419 | APK installation started |
| 05:43:01.840 | The instrumentation script started |

The ANR predates the app installation and network fixture. Guest available memory was approximately 1.92 GiB; no Waarp OOM or crash was retained. Boot CPU/I/O pressure was high, but the archive does not include a complete launcher thread trace, so the exact internal launcher stall is not established.

The upstream action is still pinned to `a421e43855164a8197daf9d8d40fe71c6996bb0d`. `scripts/android-emulator-action-prepare.py` materializes that exact public source and applies the versioned two-file patch to its TypeScript source and bundled JavaScript. Only the boot command changes: `shell input keyevent 82` becomes `shell wm dismiss-keyguard`. The latter calls the window-manager service directly in [Android 10](https://github.com/aosp-mirror/platform_frameworks_base/blob/android-10.0.0_r47/services/core/java/com/android/server/wm/WindowManagerShellCommand.java) and [Android 15](https://github.com/aosp-mirror/platform_frameworks_base/blob/android-15.0.0_r1/services/core/java/com/android/server/wm/WindowManagerShellCommand.java), without injecting a key into a booting Activity. The upstream license, bundled dependencies and action metadata remain unchanged.

Preparation verifies the detached commit, patch digest, exact before/after contents and the two-file scope, then atomically publishes a previously absent local action directory. Every emulator job retains its provenance. Existing directories are not overwritten; no package installation, dependency update, ANR-dialog dismissal, log clearing or app-test retry is introduced. RAM, heap, emulator options and application deadlines are unchanged. Host checks prove source preparation; only the next real emulator run can demonstrate its effect on boot behavior.

## Default-network readiness and the unresolved second DNS timeout

The first API 35 encrypted DNS cycle received a reply at 05:43:39.394 UTC. In the second cycle, the separate-UID probe sent one UDP query and timed out waiting for the response. The independent peer still had only one decrypted reply at the assertion. The saved core log is a bounded slice, and the complete retained logcat begins after the failure; neither provides a full packet or connectivity timeline at the send. A production-core cause is therefore **not established** by this evidence.

Review found a separate, concrete defect in the probe's readiness check: it combined synchronous default-network reads with callback snapshots and used an irreversible latch. That could retain readiness after a network was replaced or lost. Android's [NetworkCallback documentation](https://developer.android.com/reference/android/net/ConnectivityManager.NetworkCallback) explicitly requires the ordered callback arguments instead of synchronous queries inside callbacks.

The corrected probe tracks one current callback network, its VPN capability, link properties and unblocked status under one lock. Loss/replacement invalidates readiness; callbacks for an old network cannot satisfy it. The initial ten-second monotonic deadline is not reset. A legitimate same-handle link update is accepted: the [Android 15 VPN implementation](https://android.googlesource.com/platform/frameworks/base/+/cc8bb19595c661f5cf42f330457000e643c67d1b/services/core/java/com/android/server/connectivity/Vpn.java) can retain a NetworkAgent during a compatible handover.

Readiness is not a packet-delivery assertion. The probe still uses an ordinary unbound socket, one UDP send and the original ten-second receive timeout, and requires the synthetic peer response. Safe additional diagnostics record callback timing, a network handle, interface indices and whether the socket's local address matches a VPN link address; they never print that address, a configuration or credentials. This known readiness correction is not presented as a proven explanation of the earlier DNS timeout. The next run must establish the encrypted exchange itself.

## Remaining approval boundary

All six short Android jobs must pass on the corrected source before the real two-hour optimized-release AWG2 soak can start. Native regressions, release optimization, crash/OFF behavior, UI assertions, traffic correlation, cold-start and resource budgets remain mandatory. Final acceptance identifies the exact source tree, original CI APK payloads, retained signing certificate and completed evidence. Physical ARM devices, vendor power management and the user's private server remain separate, unclaimed coverage.

## Follow-up on source `f5fa9490c0ca80719760ead0748f89516e6bcf83`

[Android run 44028345222](https://github.com/INNVoices/waarp/actions/runs/44028345222) completed with the build gate and five of six short Android jobs passing. Native API 35/36 and release API 29/35/36 passed. The native API 29 job stopped during final ADB identity restoration, before installation or app tests; the two-hour soak was skipped. Both desktop jobs in [run 44028345221](https://github.com/INNVoices/waarp/actions/runs/44028345221) passed.

The downloaded native API 35 archive (`14304796251`, SHA-256 `3320d99c6fb0bfae56695da8971cb93369873808a91adb5651a9749aa2b6b8d7`) reports all 19 tests passing, zero failures/skips, two encrypted DNS replies separated by OFF/ON, no device error events and a stopped peer. The release API 29 archive (`14304637053`, SHA-256 `bc232671ae832a913a3f4d9af6c4e9d1bb2cc92c53b925e554d070fca495cf93`) reports its optimized-release journey passing, with five independently reconciled DNS/HTTP rounds and 327,845 HTTP bytes. Archive sizes, SHA-256 and every entry CRC were verified. These are actual passing journeys on this source; they do not retrospectively establish the cause of the earlier API 35 DNS timeout.

The remaining preparation failure is documented in [the ADB restoration follow-up](ANDROID-API29-EMULATOR.md#follow-up-adb-identity-restoration). It is not converted into a pass. A separate HTTPS review also identified a pre-body HTTP/2 header allocation risk and compromised certificate authorities; [the fixes and primary sources](ANDROID-HTTP-SECURITY.md) describe why the next candidate must use new APKs. The five passing jobs and the build artifacts above therefore remain historical evidence, not approval of those new bytes.
