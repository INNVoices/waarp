# Android 0.5.0-rc.2: remaining hardening and approval boundary

Status at preparation on **2026-11-17**: the changes below are implemented in
source. This document does **not** approve the new APK. The corrected source,
actual optimized APK payloads and final retained signatures still require their
own completed acceptance evidence. Results from rc.1 are a baseline only.

| Identity | Value |
| --- | --- |
| New candidate | `0.5.0-rc.2`, Android version code `3` |
| Package | `local.waarp.android` |
| Previous Android source | `58ec96ae99e5afe898e2d9f99e7130449b9fa02c` |
| Previous Android source tree | `4c4002daa72389b133942a46b2810ccc380f5616` |
| Previous CI merge checkout | `8df0da1db011c64c2c0fb2aaa807b65327111847` |
| Previous CI base | `6ffde69c19f10f175b5da85af688b53c02791151` |
| Main observed before the new acceptance | `f1c4d47c4b3f92e070c7e4afc530c8c0f7bcd8dd` (desktop PR #16) |
| Retained public signer SHA-256 | `e43f3e7e480b6073f6da0c061edde0f1ebd891d410fe48a57912fa35263a441e` |

The final rc.2 record must name the new PR head, actual tested merge commit and
tree, base commit, workflow runs and signed payload hashes. The main-branch
change above must be reconciled without discarding the desktop work. None of
the older identifiers in this table is a substitute for that record. The public
update identity remains pinned by [`android/release-signing.json`](../android/release-signing.json);
the private signing material stays outside Git and CI.

## Confirmed source problems and corrections

### Durable intent no longer writes on the UI thread

The rc.1 ON/OFF path called synchronous `SharedPreferences.commit()` while
holding the `RuntimeState` monitor. A slow write could block the UI directly or
delay another caller waiting for the same monitor. Recovery reads and alarm
operations also shared this critical section.

`VpnControlLane` now owns a process-lifetime serial worker for persistence and
recovery. User transitions invalidate the generation and enqueue their durable
operation under a short monitor; disk and Binder work happen outside that
monitor. The worker is independent of both Activity cancellation and the native
lifecycle lane, which can be waiting for the repository's configuration.

The ordering contract remains explicit:

- ON publishes `STARTING`, persists the desired ON state, then rechecks the
  generation before requesting the foreground service. OFF arriving during a
  slow ON write prevents that stale start from activating.
- Every accepted OFF write remains queued before a later ON write, even when
  that OFF generation is superseded. An Activity closing cannot cancel it.
- OFF remains `STOPPING` until durable persistence and native cleanup finish.
  A write or cleanup failure reports `ERROR`; it is not presented as a durable
  successful OFF. A failed preference commit may already have changed its
  in-memory value, so the return value still matters.
- A configuration edit retains its intentional pause, cancellation-safe
  stop/write/restart transaction and later-OFF generation guard. An accepted
  asynchronous resume is not described as a completed durable start; its
  eventual failure is exposed through runtime status.
- Heartbeat/history changes commit on the same worker. There is no deferred
  `apply()` write whose lifecycle flush can move the wait back onto Main.

Replacing `commit()` with `apply()` would change the crash-recovery durability
contract. The implementation keeps synchronous durable writes and moves their
execution instead. Android documents both the synchronous commit behavior and
the lifecycle waits associated with pending asynchronous writes in the
[SharedPreferences.Editor contract](https://developer.android.com/reference/android/content/SharedPreferences.Editor).

### Service and recovery ownership survive asynchronous completion

System restoration acknowledges the foreground-service deadline before waiting
for its worker result. Duplicate system deliveries share one pending recovery
claim instead of consuming the recovery fuse twice. Rejected restoration stops
against the latest received service start ID; using only the first delivery's
ID could leave a hidden, still-started service after a duplicate delivery.

A pending restoration prevents an earlier queued foreground-stop callback from
settling the service. Posted foreground and native-notification callbacks check
that their service instance is still current and not destroyed. Captured native
provider/backend cancellation happens outside the runtime monitor. Native
version and Always-on/lockdown Binder values are read before their guarded state
publication, including the startup log.

The notification observer now reacts only to phase or message changes. Per-second
traffic counters do not rebuild and send an identical foreground notification
through Binder; the initial foreground acknowledgement and error notifications
retain their existing behavior. The cost of the former duplicate updates has
not been measured.

The alarm receiver uses `goAsync()` and finishes its pending result after the
ordered recovery operation, including failure paths. It does not put connection
data into the Intent or bypass Android's consent/foreground rules. The existing
recovery attempt limits, non-wakeup alarm policy and generation checks remain.
`goAsync()` does not remove Android's broadcast execution deadline.
See the primary Android contracts for
[background broadcast work](https://developer.android.com/reference/android/content/BroadcastReceiver#goAsync()),
[start-ID-aware service shutdown](https://developer.android.com/reference/android/app/Service#stopSelfResult(int))
and [VPN service lifecycle](https://developer.android.com/develop/connectivity/vpn).

### Expensive library preparation and HTTP setup leave Main

`MobileRepository.edit` previously dispatched compilation to `Default` after
running the edit transform and validation on its caller. Import/subscription
transforms can canonicalize and hash an entire library of up to 2,000 profiles.
Transform, validation and compilation now run together on `Default`, under the
same edit mutex and before publication, native transition or encrypted write.
The preparation remains cancellable; the accepted transaction retains its
existing cancellation semantics.

All production transform captures were reviewed. Route editing now captures
the installed-app list on Main before handing the immutable snapshot to the
worker. Other transforms use the supplied data and immutable inputs; local
result counters are read only after the awaited edit completes.

`NetworkTools` no longer constructs its OkHttp client eagerly from
`Application.onCreate`. A synchronized lazy initializer creates the shared
client when the existing IO-dispatched fetch/diagnostic paths first need it.
Platform trust, hostname verification, compromised-CA guard, connection-pool
sharing, redirect/retry policy and deadlines remain the same.

These are source-established Main-thread work paths. Their durations were not
measured in the prior run, and they are not asserted to explain all observed
frame delays.

### Saved policy is distinguished from active traffic handling

The DNS policy compiler now supplies a neutral explanation of an unavailable
path. The mapper supplies phase-specific wording: OFF shows a saved rule,
STARTING a planned rule, STOPPING a rule for the next connection, and ERROR a
rule conditional on successful connection. Only ON describes current DNS
handling. The unavailable-default-route notice follows the same distinction.
The DNS routes, rejection decisions and fallback selection are unchanged.

Regressions added after the fix cover phase/cache transitions, conflicting app
DNS paths and available Direct/tunnel choices. The existing real 120-route UI
scenario also invokes repository editing from Main and checks that its transform
runs off Main before returning to Main for the existing persistence/navigation
assertions. Source changes alone are not evidence that these tests have passed.

Six JVM regressions exercise the production control queue with blocked durable
writes, cancellation, replacement intents and failed persistence. They replace
the obsolete fixture that required disk work to hold the runtime monitor. The
native device scope retains all 19 previous cases and adds two: warm ON/OFF with
Main-thread StrictMode disk detection, and two actual rejected system-service
deliveries followed by observed service/VPN absence. All 21 named cases must
pass on each required API; merely compiling them does not satisfy that gate.

## First rc.2 gate: observed failures and subsequent corrections

[Android run 44058621038](https://github.com/INNVoices/waarp/actions/runs/44058621038)
tested source `767e25dc57c103ba4c7dc8d19b11982e42bca80b` through merge
`41a1a76dee79991f006f808d6f258d9277925b5a`, tree
`edb5d07f18f1d75f83693b5fe8d0bb7b03cc89c2`. It is **not an accepted run**.
Its build passed 122 JVM cases and 34 host native race-enabled cases; both lint
variants had zero errors, 19 warnings and one hint. Both desktop jobs in
[run 44058621080](https://github.com/INNVoices/waarp/actions/runs/44058621080)
passed on that same merge tree.

All three native Android jobs rejected the lifecycle test class during JUnit
initialization. The new duplicate-start test used an expression-bodied
`runBlocking` whose final `JSONObject.put(...)` inferred a non-void return type.
The Kotlin compiler accepted it, but AndroidJUnit4 did not. Each raw protocol
contains ten successful cases and one class-initialization error; none of that
class's eleven lifecycle cases ran. These failures must not be represented as
21 executed cases or as evidence about the new ON/OFF behavior.

Both new tests now explicitly return `Unit`, preserving every assertion, case
identity and deadline. The actual original instrumentation APK was rejected by
the new `android-junit-signatures.py` packaging check; the corrected locally
assembled APK passed with all 21 test methods and five lifecycle hooks having
valid compiled signatures. The unchanged release acceptance APK passed its two
method checks. This is an APK packaging check, not another product JVM case or
a replacement for Android execution. It uses pinned Build Tools 35.0.0 DEX XML,
binds the APK/DEX/source hashes, and checks the source-declared method scope.
Actual runtime annotation membership and test execution remain device gates.
Its failed report survives staging cleanup in the existing build-reports
artifact; only successful reports are copied into the published output set.

Release API 29 stopped during framework preparation, before app installation.
Binder probes returned `Broken pipe`, followed by missing process names. The
underlying cause is not established. The [API 29 follow-up](ANDROID-API29-EMULATOR.md#follow-up-preserve-diagnostics-when-preparation-fails)
records the exact evidence and the failed-only bounded diagnostic collector;
readiness rules, mutations and phase budgets are unchanged.

The optimized release scenario and independent proof passed on API 35. On API
36 the scenario itself passed, but host verification rejected a system trace
without kernel scheduling events. The actual trace processor reported
`FTRACE_STATUS_PARTIAL_PAGE_READ`; it is a capture failure, not permission to
ignore the trace or claim a successful gate. Its correction and subsequent
runtime evidence must remain separate from the application scenario result.
The [16 KiB capture follow-up](ANDROID-PERFETTO-16K.md) records why the base
`android-36` revision 7 image cannot use the initially considered tracefs
correction: its exact kernel lacks that interface. That draft was rejected
before publication or device execution. Subsequent API 36 jobs explicitly use
the official `android-36.1` revision 4 image (Android 16 QPR2, runtime SDK 36 / full
SDK 36.1). Its exact kernel source supports the required sub-buffer control.
Image identity, inactive tracing, the original geometry and the readback must
be observed before capture. This is a maintenance-image change with a bounded
observer preparation, not a change to the APK's minimum/target SDK, test page
size, functional assertions or resource budgets. Source inspection establishes
the available interface; it does not establish that a new runtime gate passed.
The first rc.2 run's mandatory two-hour soak was skipped because short gates failed. A fresh
complete acceptance is required after these corrections; old APK results do
not approve newly built inputs.

## What rc.1 actually established

[Android run 44031796227](https://github.com/INNVoices/waarp/actions/runs/44031796227)
passed all eight jobs on the previous source/merge/tree identified above. All six
short gates passed before the real two-hour release soak. The build included
114 JVM cases and zero lint errors. Native instrumentation passed 19 cases per
API 29/35/36; the separate-UID optimized-release journeys passed on all three.
Both desktop jobs in
[run 44031796240](https://github.com/INNVoices/waarp/actions/runs/44031796240)
also passed on that tested tree.

The original soak artifact `14313955973` has SHA-256
`2deb3e8fcabee72d6e24b3b76651fcd453581463556451fe7c830c926b5e9a3c`.
Its independently reconciled observations were:

| Observation | Actual baseline |
| --- | --- |
| Steady encrypted-traffic interval | 7,200,001 ms |
| Successful DNS plus HTTP rounds | 484 |
| HTTP payload bytes | 31,735,361 |
| Ordinary traffic failures / device error events | 0 / 0 |
| Process sampling | One production PID across 120 samples |
| PSS median, first/last five post-warmup samples | 117,461 → 122,880 KiB |
| FD / thread median, first → last | 132 → 128 / 41 → 41 |
| Additional exercised phases | Observed screen-off, forced IDLE Doze and emulator-network loss/recovery |
| Actual page size / runtime ABI | 16 KiB / x86_64 |

The workload transferred approximately 64 KiB every 15 seconds. It was not a
peak-throughput test or two continuous hours of screen-off/Doze. Resource
samples bound the observed workload; they are not continuous allocation peaks.
The prior final audit also verified three retained-signed per-ABI APKs against
their exact accepted unsigned payloads. None of that transfers approval to
newly compiled rc.2 bytes.

### Frame smoothness was not approved

The rc.1 soak's cumulative process gfxinfo reported **187/204 janky frames
(91.67%)**, with frame p50/p95/p99 of **73/250/450 ms**. Most of the soak was in
the background. The dump was not a scoped foreground benchmark. Short release
journeys collected their old gfxinfo only after deliberate OFF, SIGKILL and the
90-second absence observation; those dumps correctly said no process existed.

The emulator used two virtual CPU cores and software graphics. This identifies
the environment, not the cause of the delay. It does not establish either good
or bad frame timing on a physical phone. No measured improvement is claimed
for rc.2 before its new observations exist.

The new acceptance code captures bounded foreground scopes before process
termination: OFF/ON/rename and tab navigation in smoke, plus navigation in soak.
It preserves the pre-reset and reset dumps, records PID/foreground/time
boundaries and actions, and requires actual completed raw frames after a real
counter reset. Host validation separates global process counters from repeated
window sections. The old post-scenario dump remains a diagnostic, not a
substitute for these observations.

A bounded external Perfetto trace is attempted for each scope on the disposable
emulator. The observer verifies the trace process identity before stopping it;
the host copies only the expected bounded file and checks its structure and
actual scheduling data. Unavailable tracing is explicitly recorded as
unavailable. Successful collection does not itself establish trace completeness,
a causal explanation, or a physical-device frame-rate pass.

This approach follows the official
[Android jank investigation guide](https://developer.android.com/studio/profile/jank-detection)
and [Perfetto system-tracing guide](https://perfetto.dev/docs/getting-started/system-tracing).
No speculative Compose stability annotations were added. The current Kotlin
compiler already enables
[strong skipping](https://developer.android.com/develop/ui/compose/performance/stability/strongskipping)
by default; changes to recomposition policy should follow evidence.

## Required rc.2 approval

The fixed [release acceptance contract](../android/acceptance/README.md) remains
the source of runtime deadlines and resource budgets. The order is:

1. Finish and review the source fixes, reconcile the current main branch, and
   record the resulting source/tree identity.
2. Run the relevant new and existing JVM regressions, lint, native provenance
   verification, release optimization and APK integrity checks. A production
   control-lane test must exercise queued ordering with delayed/failed
   persistence; a same-thread mock that never blocks is insufficient.
3. Pass all six short native/release Android gates on API 29/35/36, including
   actual 16 KiB pages, explicit OFF after process death, real encrypted traffic,
   foreground evidence and crash checks. Preserve every failure and original
   artifact; do not rerun a failed scenario blindly or increase its budgets.
4. Only after those gates pass, complete the actual two-hour optimized-release
   AWG2 soak on that same candidate. Reconcile device rounds/bytes, independent
   peer proof, process/resource samples and recovery events.
5. Reconcile the applicable desktop checks on the integrated tree. Sign the
   accepted per-ABI APK inputs using the retained certificate; verify v2/v3
   signatures, payload equality and 16 KiB packaging; publish a complete new
   `out/android/` set with its evidence.
6. Review foreground traces and frame measurements within their stated scope.
   Explicitly retain any physical-device qualification that has not been run.
   Merge only the exact reviewed/tested changes through the normal protected
   branch process.

The historical failures and follow-up runs in
[`ANDROID-ACCEPTANCE-READINESS.md`](ANDROID-ACCEPTANCE-READINESS.md) and
[`ANDROID-API29-EMULATOR.md`](ANDROID-API29-EMULATOR.md) remain historical evidence.
Their statements that a then-future run was required are not the current rc.2
status. Conversely, the later rc.1 pass does not prove the root cause of the
earlier API 35 DNS timeout; that causal qualification remains.

No physical ARM device was available during this preparation. ARM packaging and
signature verification do not establish ARM runtime behavior, OEM power
management, camera/QR behavior, cellular handover or hardware frame timing.
Android's own [benchmark guidance](https://developer.android.com/topic/performance/benchmarking/macrobenchmark-instrumentation-args)
warns that emulator performance is not representative of end-user hardware.
The previous private-server attempt stopped at outbound UDP
`network_unreachable` before packet exchange; it is not a successful connection
and does not diagnose that server or its credentials. No private connection
configuration or signing secret is included in these tests or this document.
