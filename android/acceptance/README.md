# External acceptance of the minified Android release

This module is a **separate, self-instrumenting APK**. It drives the installed
`local.waarp.android` release using public accessibility text/descriptions and
Android system APIs. It does not reference `MainActivity`, `Application`, the
repository, the VPN controller, Compose test tags, or libbox. The sole shared
source is the attributed Apache-2.0 `Curve25519.java` key generation utility.

The production APK remains minified and nondebuggable. The acceptance APK uses
ordinary debug signing and has its own UID. Signature equality with the target
is neither required nor used. The host runner verifies the actual release APK,
its signer, and unsigned-versus-signed ZIP payload equality separately. Tests
verify the target package, version and nondebuggable flag again on the device.

## Build and invocation

```sh
cd android
./gradlew :acceptance:assembleRelease
```

AGP's `targetProjectPath = ":app"` selects the real release variant; only the
acceptance module's release build type is enabled. The self-instrumenting pattern
follows [the official AndroidX external test module](https://android.googlesource.com/platform/frameworks/support/+/befe6b935d4d3fabcb7a6ae0de220999e7561bf3/benchmark/integration-tests/test-module-sample/build.gradle)
and the [AGP TestExtension DSL](https://developer.android.com/reference/tools/gradle-api/8.13/com/android/build/api/dsl/TestExtension).
AGP8.13's test-only plugin does not expose `lintRelease`; the production app's
`lintDebug` and `lintRelease` remain required build gates.

Runner component:

```text
local.waarp.android.acceptance/androidx.test.runner.AndroidJUnitRunner
```

Run **one class per fresh fixture and disposable app installation**:

| Class | Single test method | Required arguments |
|---|---|---|
| `local.waarp.android.acceptance.ReleaseAcceptanceTest` | `realReleaseUiTunnelLifecycleAndProcessRestoration` | `allowTargetReset=true`, `requireProcMetrics=true` |
| `local.waarp.android.acceptance.ReleaseSoakTest` | `twoHoursEncryptedTrafficResourcesAndRecovery` | Same, plus `durationSeconds=7200`, `intervalSeconds=15` |

Duration is restricted to 7,200–10,800 seconds; interval to 10–30 seconds. Omitting
the duration fails the soak. Neither test has a shortened acceptance mode.
CI runs smoke on API29/35/36 and the two-hour soak on API36 with 16KB pages.

Both classes require an explicitly disposable `ro.kernel.qemu=1`, userdebug/eng
emulator, because they clear the target package and alter synthetic device state.
The host enables `adb root`. The observer checks its actual UID; if UIAutomation
still uses shell UID, it may use the emulator's `su 0` only after confirming UID0.
Missing `/proc` capability fails a required gate, rather than reporting zeros.
No production manifest permissions/debuggable settings are weakened for this.

## Authenticated traffic fixture

Build `test/userspace-awg` using its pinned Go1.26.11 toolchain. Example lifetime:

```sh
awg-android-fixture --android-server --android-port 18081 \
  --android-duration 3h --android-report /tmp/awg-proof.json
```

`--android-duration` accepts 1m–4h and defaults to30m for existing short tests.
The loopback TCP control API and outer AWG UDP socket share port18081. The Android
emulator reaches them as `10.0.2.2:18081`. `/register` exchanges **public keys only**;
each side generates and retains its own private key in memory. Only one client
key is accepted for a fixture lifetime, so smoke and soak require separate peers.

The pinned AWG implementation remains the existing Leadaxe fork at
`64065e6826ad`. Inner IP/TCP/UDP handling uses the official WireGuard netstack
at `golang.zx2c4.com/wireguard v0.0.0-20261024220952-b3bc704ef0ee`, with its
transitively pinned gVisor revision. `androidNetTUN` only converts the named
TUN event type between these compatible interfaces; it implements no TCP stack.

Inside that authenticated tunnel:

- UDP53 at `10.77.0.1` answers unique `*.soak.waarp.test` names with A10.77.0.1 and
  TTL0. The previous `example.com → 192.0.2.42` EDNS fixture remains supported.
  Unknown names receive NXDOMAIN promptly.
- TCP HTTP at `10.77.0.1:18080/probe?nonce=<unique>` returns the exact nonce and a
  validated 64KiB payload. It is bound inside the userspace stack, not to a host
  interface; the outer control API cannot answer this request.
- Each ordinary interval creates and closes new DNS/TCP sockets. Both DNS
  transaction/question/address and HTTP nonce/full payload are verified. There
  is no cached-URL success or traffic counter fabricated from elapsed time.

The app profile is imported through the real masked configuration form. The
launcher-visible **Waarp Acceptance Probe** package is selected through the app
picker and explicitly assigned to the AWG profile. The test disables the actual
“Локальная сеть напрямую” setting because it otherwise intentionally precedes
app routes for the private inner address. It assigns “Путь общего DNS” to the
synthetic AWG profile so Android's unattributed DNS has a deliberate route.

All later traffic originates in the independent acceptance UID. Bringing its
launcher activity up is not required every interval, so the target really remains
in the background during the soak. No target app method is invoked directly.

## Smoke contract

The single smoke case requires all these public behaviors:

1. Import, select-app route, real Android VPN consent, encrypted DNS and HTTP.
2. OFF with VPN absence and a newly attempted inner DNS request blocked; ON again
   with another successful DNS and HTTP exchange.
3. Rename through the UI and verify traffic survives the resulting configuration.
4. Put the target in the background and exchange real traffic from the other UID.
5. Send SIGKILL to the verified production PID, without starting its activity.
   Observe a different PID and actual traffic from Android's sticky service
   restart within90s. Only then open the UI and confirm the renamed profile and
   selected route were restored from encrypted storage.
6. Delete the assigned profile with explicit **no reassignment**, observe
   “Соединения заблокированы”, and send a new DNS request which must be blocked.
7. Delete the route through the UI and finish with VPN OFF.

Force-stop is used only for failed disposable-run cleanup, never as proof of
sticky restart. Smoke has at least five complete encrypted DNS+HTTP rounds and
two real process-memory snapshots. UI actions have bounded readiness checks and
one normal click each; a failed mutation is not silently retried.

## Two-hour soak contract

The steady period starts at a successful encrypted request after setup and ends
with another successful request **at least the requested real monotonic duration
later**. Normal rounds must all succeed. At least
`floor(durationSeconds / intervalSeconds * 0.9)` complete rounds are required
(432 for7,200/15); actual counters, payload bytes and per-round latencies are
recorded. First/last encrypted host timestamps independently confirm the span.

Three bounded phases occur at25%,50%,75% of the duration:

- **Screen off:** observe noninteractive state, complete three DNS+HTTP rounds
  with the screen off, wake and verify fresh traffic.
- **Deep Doze:** unplug the synthetic battery, force idle, observe actual `IDLE`,
  attempt two real rounds, unforce and verify recovery. Android may block the
  probe application's traffic while idle and hide its active Network. In that
  documented case the test still sends a fresh DNS request and requires its
  actual block. Otherwise only IO failures in this explicit window are expected.
  Malformed replies, missing VPN outside confirmed IDLE, app death and
  normal-phase failures remain failures. No battery whitelist is added.
- **Physical network loss:** record actual non-VPN Network identities, disable
  Wi-Fi and mobile data, require the physical networks to disappear and an inner
  request to fail, restore the prior radio states, then require actual new
  encrypted traffic. Unchanged network state cannot pass as a toggle.

Memory/process samples are taken about once per minute. Five minutes of warmup
are excluded from relative checks; the first five subsequent samples establish
the median baseline. Every later sample and the final five-sample median have
fixed limits. At least60 total and55 post-warmup samples are required, all with
actual FD/threads/RSS availability; the production PID must remain unchanged.

| Metric | Absolute cap | Every sample above baseline | Final median above baseline |
|---|---:|---:|---:|
| File descriptors |512|64|16|
| Threads |160|32|16|
| PSS |768MiB|128MiB|64MiB|
| RSS |1,536MiB|192MiB|96MiB|
| Allocated Java heap |128MiB|32MiB|16MiB|
| Allocated native heap |256MiB|96MiB|48MiB|

These predetermined resource budgets bound this controlled workload. They are
not a mathematical guarantee against every possible leak or a performance
claim for physical ARM devices. A failed gate must be investigated, not converted
to a pass by raising its thresholds. Raw `/proc` and `dumpsys meminfo` observations
are parsed; unsupported or missing fields cause a failure.

## Evidence schema and host validation

Files live under the acceptance APK's external files directory:

```text
/sdcard/Android/data/local.waarp.android.acceptance/files/release-acceptance/
```

- `release-smoke.json` or `release-soak.json`: atomically updated summary.
- `release-smoke-traffic.jsonl` / `release-soak-traffic.jsonl`: one record per
  **successful** full DNS+HTTP exchange, flushed to disk immediately.
- `release-soak-resources.jsonl`: every resource observation, also flushed before
  its acceptance check, including an observation that failed a budget.
- PNG screenshots; on failure, `failure-release-<mode>.xml` with keys redacted.
  Private configuration input remains masked, and is never copied into reports.

Common summary keys (`schemaVersion=1`):

```text
mode, passed, targetPackage, targetVersion, targetVersionCode,
targetDebuggable=false, targetUid, probeUid, probePackage, independentUid=true,
observer {disposableEmulator, rootAvailable, observerUid, rootTransport,
          requiredProcMetrics},
elapsedMs, successfulRounds, httpBytes,
firstTrafficElapsedMs, lastTrafficElapsedMs, trafficSpanMs,
events [{name, elapsedRealtimeMs, facts}]
```

The failure branch additionally records sanitized `failureClass` and `failure`.
`passed` starts false and becomes true only after all gates and normal OFF finish.

Smoke events must be `setup`, `off`, `onAgain`, `edit`, `background`,
`processRestoration`, `persistedState`, `deleteAssignedProfile`, `cleanup`.
The summary contains `resourceSamples` (two objects) and
`minifiedReleaseBlackBox=true`. In `processRestoration.facts`, the old/new PID
must differ, `newPidObserved=true`, `targetRelaunchedByTestBeforeRecovery=false`,
`encryptedDnsAndHttp=true`, and `recoveryMs<=90000`.

Soak additionally requires:

```text
requestedDurationSeconds, intervalSeconds, warmupSeconds=300,
steadyStartedElapsedMs, steadyElapsedMs,
requiredSuccessfulRounds, normalTrafficFailures=0,
screenOffRecovery=true, dozeRecovery=true, physicalNetworkRecovery=true,
resources {sampleCount, postWarmupSampleCount, processIds, processCount=1,
           procAvailable=true, baselineMedian, terminalMedian, peaks,
           absoluteCaps, sampleGrowthCaps, terminalGrowthCaps, passed=true}
```

Soak events must include `setup`, `screenOff`, `doze`, `physicalNetwork`, `cleanup`.
Doze records both attempted rounds and the exact count/classes of expected IO
failures. Successful rounds during all recovery phases are included in the traffic
series. Ordinary-round failures are never omitted in order to continue a run.

Traffic row keys: `sequence`, `elapsedRealtimeMs`, `unixMs`, `dnsMs`, `httpMs`,
`totalMs`, `dnsBytes`, `httpBytes`, `vpn=true`, `passed=true`. Sequence numbers
may have gaps for explicitly blocked requests/recovery attempts. Names, nonces,
keys and response payloads are not persisted. Every HTTP byte count is at least64KiB.

Resource row keys: `elapsedRealtimeMs`, `unixMs`, `pid`, `pssKb`, `rssKb`,
`javaHeapAllocatedKb`, `nativeHeapAllocatedKb`, `javaHeapPssKb`, `nativeHeapPssKb`,
`fds`, `threads`, `procAvailable`, `afterWarmup`. Heap summary PSS is additional
context; heap **allocated** values come from the real Native/Dalvik Heap tables.

The host must stop the fixture cleanly and verify all existing AWG proof booleans
plus `stopped=true`, `passed=true`, `device_error_events=0`, and positive outer
encrypted packet counts. New backward-compatible proof fields are:

```text
http_server_started: boolean
encrypted_dns_unique_queries: integer
encrypted_http_requests: integer
encrypted_http_unique_requests: integer
encrypted_http_bytes: integer
first_encrypted_request_unix_ms: integer
last_encrypted_request_unix_ms: integer
```

The old `passed` retains the existing DNS-only contract so debug regressions remain
compatible; release acceptance must additionally require HTTP started, each unique
DNS/HTTP count >= device `successfulRounds`, HTTP bytes >= device `httpBytes`,
and for soak the first-to-last host request span >= requested duration. The host
compares traffic JSONL counts/sums and resource JSONL/summary/limits independently,
instead of accepting only a device-side `passed` flag. No private profile is used.
