# Android 10 emulator preparation

## Observed failure

The native API 29 job in [Android run 43972704556](https://github.com/INNVoices/waarp/actions/runs/43972704556/job/133675629186), for source `db47709f5dcc7c88d0156b80d4938ec311d119a8`, failed before the Android test runner started. The other five short Android jobs passed; the two-hour soak was skipped. This run therefore did **not** approve the candidate.

The retained [runtime archive](https://github.com/INNVoices/waarp/actions/runs/43972704556/artifacts/14280687144) is 31,680 bytes with SHA-256 `4bc2a0eefcb1c6c9c4c3d42a5c5dac8f68e1ce5ecaf4242b497a2c4360fc175d`. Its downloaded size, digest and all ZIP entry CRCs were checked before inspecting the evidence.

The guest log establishes this sequence on 2026-11-16 (UTC):

| Time | Evidence |
| --- | --- |
| 22:58:19.729 | `system_server` PID 1897 already reports a Java heap of `11MB/16MB`. |
| 22:58:24.269–24.500 | `ConfigUpdater` installs downloaded system configuration updates. |
| 22:58:24.631–24.665 | Allocations of approximately 3.9 MB fail at a growth limit of **16,777,216 bytes**. The stack ends in `ConfigUpdateInstallReceiver.getAltContent`, reading an update into a byte array. |
| 22:58:24.666–24.670 | A fatal exception in the system process is followed by its SIGKILL. |
| 22:58:24.868 | The shell Java process used for `am instrument` starts. |
| 22:58:24.980–24.989 | That process encounters `DeadObjectException` in `startInstrumentation`, after ActivityManager has died. |

The instrumentation result contains **zero tests**, not an empty successful suite. The AWG peer has no registered client or encrypted exchanges, and the HTTP fixture has no payload request. These are consequences of not reaching instrumentation, not evidence of a failed application DNS exchange.

Guest `MemAvailable` was 777,952 KiB; host `MemAvailable` was 12,287,072 KiB. The fatal stack identifies a process heap limit, not global RAM exhaustion. The process-memory diagnostic contains a Binder error despite adb exit code zero and cannot be treated as a valid memory measurement. The broadcast queue was busy, but the saved evidence does not establish that observing it caused the OOM.

## Source analysis and uncertainty

The workflow already requests `heap-size: 512M`. The pinned emulator action writes `hw.heapSize=512M`, and this failed job prints `qemu.dalvik.vm.heapsize=512m` in its userspace boot properties. There is no evidence of a malformed `512Mm` value. Merely changing the unit suffix would not address the observed failure on that evidence.

The relevant Android 10 sources show why a later property value alone does not prove the heap used by an existing VM:

- [`AndroidRuntime.cpp`, Android 10 r47](https://github.com/aosp-mirror/platform_frameworks_base/blob/android-10.0.0_r47/core/jni/AndroidRuntime.cpp) reads `dalvik.vm.heapsize` into `-Xmx` when starting the VM and defaults to **16m** if the property is absent.
- [`init.rc`, Android 10 r47](https://github.com/aosp-mirror/platform_system_core/blob/android-10.0.0_r47/rootdir/init.rc) triggers `zygote-start` before the later `boot` action.
- [Goldfish `init.ranchu.rc`, Android 10 GSI](https://android.googlesource.com/device/generic/goldfish/+/refs/heads/android10-gsi/init.ranchu.rc), blob `81bcc22705b94fd877d5bfd1683b249c72aacd39`, sets `dalvik.vm.heapsize` in `on boot`, first to a default and then from the kernel QEMU property.
- [`SystemServer.java`, Android 10 r47](https://github.com/aosp-mirror/platform_frameworks_base/blob/android-10.0.0_r47/services/java/com/android/server/SystemServer.java) calls `VMRuntime.clearGrowthLimit()`. Changing `dalvik.vm.heapgrowthlimit` is not justified by this failure.

This source analysis supports an ordering explanation for a VM retaining the 16 MiB startup default. The failed CI run did **not** retain the actual guest property timeline or ART startup arguments, so the exact race in that system image is not established as an observed fact.

## Deterministic preparation

`scripts/android-emulator-prepare.py` makes the existing 512 MiB configuration explicit before starting a fresh framework on API 29. It runs once during disposable-device setup, before app installation and test traffic. The host-only HTTP fixture can already exist; it has no guest VM state.

The helper requires explicit disposable-emulator authorization and verifies an emulator serial, QEMU/debuggable properties and API 29 before requesting root. It records the old framework identities and heap properties, stops the framework once, requires both applicable zygotes and `system_server` to be absent, sets and reads back `dalvik.vm.heapsize=512m` while those processes are absent, then starts the framework once. Acceptance requires new process identities and working ActivityManager/PackageManager Binder services within a bounded setup deadline. A leftover `sys.boot_completed=1` cannot establish readiness.

The helper restores the original adb shell UID after preparation and checks that restoration. The preparation report preserves phase observations, shell identities and the property ordering. It does **not** label a property readback as a direct measurement of ART maximum heap: `actualRuntimeMaxHeapBytes` remains null. Failure of a guard, process transition, property check, Binder readiness or shell-identity restoration fails setup; it does not invoke a second framework restart or rerun an application test. Crash history is retained.

The helper does not change the 2,048 MiB API 29 RAM setting, the existing 512 MiB heap budget, `dalvik.vm.heapgrowthlimit`, production app code, native core bytes, test assertions or test timeouts. API 35, API 36 and the soak do not use this restart. Fake-adb regression tests cover the guard and transition failures as well as the successful sequence; actual device evidence still requires the next full CI run.

## Follow-up: process-name snapshots

In [run 44024845939, native API 29](https://github.com/INNVoices/waarp/actions/runs/44024845939/job/133845679896), the planned stop/property/start sequence completed, but preparation rejected the first incomplete process-name snapshot after start. Three successive `pidof` calls observed `zygote=3787`, `zygote64=3784 3821`, and `system_server=3821`. The old framework processes were gone. This happened approximately 0.54 seconds into the existing 120-second readiness phase, before app installation or instrumentation.

Separate process-name queries are not an atomic process snapshot. A forked zygote child initially inherits its parent's name; [Android 10 zygote specialization](https://github.com/aosp-mirror/platform_frameworks_base/blob/android-10.0.0_r47/core/jni/com_android_internal_os_Zygote.cpp) changes the system-server thread name later. The observed overlap is therefore insufficient evidence of two persistent framework owners. The helper now treats multiple names or extra fork children as an incomplete snapshot and observes again within the same phase deadline. Persistent ambiguity still fails.

Once a unique owner has been accepted, its PID must remain present under the same process name throughout Binder readiness, final checks and restoration of adb identity. A replacement or missing accepted owner fails immediately, even if extra children are also present. Reappearance of any old framework PID remains a failure. A duplicate PID within one `pidof` response is malformed evidence, not a retryable snapshot. No second root/stop/start sequence or new application-test attempt is added.

The separate release API 29 job in the same run completed preparation in 8.966 seconds and restored the original shell UID; its later IME assertion failed for a different reason. See [the follow-up acceptance observations](ANDROID-ACCEPTANCE-READINESS.md). Neither result approves the candidate.

## Approval remains separate

Correct preparation is a prerequisite, not a stability result. The candidate must still pass the source-built native regressions and exact binary pins, APK/JVM/lint verification, all six short Android jobs, the complete two-hour optimized-release AWG2 soak, and desktop regression gates. The acceptance criteria and physical-device limitations remain in [ANDROID.md](ANDROID.md).
