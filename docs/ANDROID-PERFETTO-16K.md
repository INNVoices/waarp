# Android 16 KiB foreground trace follow-up

## Run 11 failure and scope

This is a capture-infrastructure investigation, not an approval of a new APK.
Android CI run `44058621038` tested merge
`41a1a76dee79991f006f808d6f258d9277925b5a` for source head
`767e25dc57c103ba4c7dc8d19b11982e42bca80b`, tree
`edb5d07f18f1d75f83693b5fe8d0bb7b03cc89c2`. Its API 36 release scenario completed
one instrumentation test, but the independent host gate failed because its
foreground trace had no kernel scheduling data. The whole candidate remained
unapproved; other run 11 failures are recorded in
[the RC2 hardening note](ANDROID-RC2-HARDENING.md).

Verified artifact `14317219887` retained a 62,457-byte control trace with SHA-256
`3a702f238a37ba8c3f5f9b492a6676a5b44bb5092fcc304ea3e7d25da0734357`.
Its protobuf contains 1,144 TracePackets and no ftrace event bundles. The official
Perfetto v59.1 processor exits with status 1 and
`FTRACE_STATUS_PARTIAL_PAGE_READ`; the original stderr is retained with SHA-256
`dfd0baece0324235651143805b50fd7f3a10c17a16460207e7783d072d361f45`.
No parse-error-ignore option was used. Text conversion of the original protobuf
also shows the same parse error in the recorder's own ftrace statistics.

The trace reports SDK 36, x86_64, userspace page size 16,384, device Perfetto
v49.0, and kernel `6.6.66-android15-8-gd0c43a640eab-ab13812146`. Run 11 did not
read the live ftrace sub-buffer size. Therefore the retained evidence establishes
the actual partial-page error, but does not independently establish that the
live ring buffer used a 4 KiB sub-buffer.

## What upstream explains, and what was rejected

Android's later kernel fix
[`66e97080dfaa246d68d21ee8f48c05c693463d6e`](https://android.googlesource.com/kernel/common/+/66e97080dfaa246d68d21ee8f48c05c693463d6e)
describes this exact failure mechanism: emulated 16 KiB userspace expects a full
16 KiB ftrace read while the kernel supplies a 4 KiB sub-buffer. Its companion
[`c450b9f2ff1cb9e10115081b8453675a5d055f59`](https://android.googlesource.com/kernel/common/+/c450b9f2ff1cb9e10115081b8453675a5d055f59)
aligns the configurable sub-buffer size with the emulated page granularity.
This is a mechanism consistent with the run 11 error, not a substitute for
observing the current device's controls and geometry.

An initial proposal to adjust `buffer_subbuf_size_kb` was rejected before
publication or device execution. Independent review of
[the exact recorded kernel's trace code](https://android.googlesource.com/kernel/common/+/d0c43a640eab/kernel/trace/trace.c)
and
[ring buffer code](https://android.googlesource.com/kernel/common/+/d0c43a640eab/kernel/trace/ring_buffer.c)
found that this revision has no such setter. A helper targeting that interface
would therefore fail on the run 11 image. The rejected draft and integration
diff remain immutable diagnostic history outside the product source tree.

## Selected official maintenance image

The three API 36 CI jobs now select the official SDK image
`system-images;android-36.1;google_apis_ps16k;x86_64`, revision 4. The emulator
action receives `api-level: 36` and `system-image-api-level: '36.1'`; runtime
`ro.build.version.sdk` must remain 36 and `getconf PAGE_SIZE` must remain 16,384.
The native case identities, traffic scenarios, foreground actions and two-hour
soak budgets are unchanged. API 29 and 35 keep their previous image selections.
SDK 36.1 is Android 16 QPR2; see the
[official SDK setup documentation](https://developer.android.com/about/versions/16/qpr2/setup-sdk).

| Image identity | Run 11 base image | Selected maintenance image |
|---|---|---|
| SDK package API / revision | `36` / `7` | `36.1` / `4` |
| Runtime SDK | 36 | Required 36, full SDK `36.1` |
| Kernel version | `6.6.66-android15-8-gd0c43a640eab-ab13812146` | Required `6.12.38-android16-5-gbb9513914902-ab13996879` |
| Configurable ftrace sub-buffer | Absent in exact source | Present in exact source |
| Guest page size | Measured 16,384 | Required and measured again before/after preparation |

Read-only research of the official Google repository metadata and bounded ZIP
members established the selected image's package revision, build properties and
kernel header. The original `source.properties` is 402 bytes with SHA-256
`c54d726e02b6862fbf727529ce040aad70a878aa015f6e23a7a293ca4e20705f`.
The repository advertises the
[official r4 archive](https://dl.google.com/android/repository/sys-img/google_apis/x86_64-ps16k-36.1_r04.zip)
as 1,913,923,004 bytes with SHA-1
`d812164d3704c2d5846d34e0a4d2c61cb1224a02`. That whole archive was not downloaded
or independently hashed during this research. The complete small `build.prop`,
`source.properties` and `kernel_cmdline` members were checked against their ZIP
CRC and retained with their own SHA-256 values. Only a bounded prefix of
`kernel-ranchu` was read to inspect its version header; its retained response and
decoded prefix have SHA-256 values, but the full kernel member's CRC and whole
kernel hash were not verified.

The exact selected kernel source
[`bb9513914902b52a9751ea1126ad40518a38c89f`](https://android.googlesource.com/kernel/common/+/bb9513914902b52a9751ea1126ad40518a38c89f/kernel/trace/trace.c)
has `buffer_subbuf_size_kb`, and its
[ring buffer implementation](https://android.googlesource.com/kernel/common/+/bb9513914902b52a9751ea1126ad40518a38c89f/kernel/trace/ring_buffer.c)
uses the configured sub-buffer size when supplying raw pages. Writing 16 KiB on
its native 4 KiB kernel selects allocation order 2. This is support for the
configuration interface; it is not inclusion of the later January 2026 default
geometry fix. Actual initial size and successful recording still require a new
device run.

The common image verifier independently saves the installed `source.properties`
and its hash, checks its API/revision/tag/ABI fields, and records bounded raw
device reads. The runtime must match full SDK `36.1`, build ID
`BE4B.251210.005`, incremental `14574095`, the exact kernel above, and system
fingerprint
`google/sdk_gphone16k_x86_64/emu64xa16k:16/BE4B.251210.005/14574095:userdebug/dev-keys`.
Native instrumentation uses this read-only verifier with its ordinary shell UID
2000; it does not gain root or modify tracefs. Release/soak preparation uses the
already established root observer. Each proof is bound to one explicit owned
emulator serial.

## One bounded geometry preparation

Only the reviewed disposable userdebug emulator may enter this path. An actual
16 KiB guest is required, and only the allowlisted tracefs
`buffer_subbuf_size_kb` is writable. The helper reads the current value. A value
of 16 requires no write; a value of 4 permits one write of 16 only after the
quiescence checks below. Missing interfaces, other values, changed image
identity and unexpected stderr fail before any accepted capture.

The guard requires `current_tracer=nop`, no enabled events, a successful raw
Perfetto service query explicitly supporting session enumeration with no
configured/started/listed sessions, no `perfetto` client, and no legacy `atrace`
client or active user/tag/app properties. The service query preserves binary
stdout and the actual exit status. A detached legacy atrace capture cannot be
treated as idle merely because its client exited. The relevant primary sources
are the
[service-state schema](https://github.com/google/perfetto/blob/v49.0/protos/perfetto/common/tracing_service_state.proto)
and [Android atrace implementation](https://android.googlesource.com/platform/frameworks/native/+/refs/heads/android15-release/cmds/atrace/atrace.cpp).

`tracing_on` is the ring-buffer writing flag, not an independent active-tracer
test. Its default value may be 1 with an otherwise idle configuration. The
helper records it and requires the same value after preparation; it never writes
this flag or stops a foreign capture. The kernel internally pauses recording
while changing buffer geometry, making the prior quiescence proof necessary.
See the [kernel ftrace documentation](https://docs.kernel.org/trace/ftrace.html).

After the single write, exact readback of 16 KiB and unchanged `PAGE_SIZE=16384`
are mandatory. Every command retains its exact argv, serial, exit status,
stdout/stderr, SHA-256 and monotonic start/finish offsets. Commands have a fixed
10-second maximum, the whole command sequence has a 60-second maximum, and each
output stream is capped at 64 KiB. Post-command elapsed time is checked as well
as the subprocess timeout. Independent validation rejects extra/reordered
commands, hidden writes, changed serials, false raw summaries, nonfinite or
overlapping timings, changed recording flags and output tampering.

There is no failed-trace retry, page-size change or acceptance-budget increase.
The old run 11 failure remains failed. A fresh raw trace containing actual
scheduling data is required before this correction is considered verified.

If the enabled-events guard rejects preparation, the failed report identifies
`failedGuard.field=eventsEnabled`, its observed value (for example `X`) and the
required value `0`. After preserving that refusal, the same bounded recorder
attempts one read of the selected tracefs root's `set_event`, retaining the raw
enabled event names with the usual command/stream hashes. It shares the original
10-second command, 60-second total and 64 KiB stream limits. A failed read is
recorded separately as `eventDiagnosticsError`; it cannot replace the original
refusal, permit a write or trigger a retry. These names describe a sampled event
configuration, not its owner or boot-time origin. This adds failure diagnostics
and does not fix or approve the rejected preparation.

## Recorder startup acknowledgement

The historical API 35 traces contain useful scheduling data, but scheduling
begins approximately 183 ms and 112 ms after the first recorded control and
navigation actions. They are partial observations. The old command used
`--background`, which does not acknowledge that the data sources have started.
[Perfetto's CLI documentation](https://perfetto.dev/docs/reference/perfetto-cli)
and [background tracing guide](https://perfetto.dev/docs/learning-more/tracing-in-background)
document `--background-wait` for this acknowledgement.

The acceptance recorder now reads the actual device's `perfetto --help` and
selects `--background-wait` only when advertised. It makes one start attempt;
there is no failed-start retry. A version without that capability remains
explicitly recorded as ordinary background startup, without a readiness claim.

The CLI can print a child PID before a readiness failure or timeout. See the
[official command implementation](https://github.com/google/perfetto/blob/v59.1/src/perfetto_cmd/perfetto_cmd.cc).
Consequently, the recorder retains a fixed, acceptance-owned shell wrapper and
its raw output, including the actual CLI exit status. Successful startup
requires exit 0, one numeric PID and the expected `perfetto` process identity.
Cleanup targets only the captured PID and start time. The root observer's
restricted token handling is unchanged.

Independent host verification checks the exact wrapper bytes, command,
scope-owned output path, limits, categories, raw PID and exit marker. A failed
attempted startup cannot be relabelled as unsupported tracing and accepted.
The acknowledgement precedes the first foreground action. The 180-second trace
cap, 16 MiB buffer, 15-second flush bound and functional action budgets remain
unchanged.

## Preserve all failed evidence

Run 11's collector stopped after the invalid control trace, so the later
navigation trace was not copied. The collector now attempts every owned,
bounded trace file, retains each copied raw file, and records file size and hash
for invalid data. It fails after collecting the remaining scopes. This improves
diagnostics without accepting a metadata-only, malformed or empty trace.

The focused host fixtures cover failed readiness after a printed PID, raw
nonzero status despite a claimed zero status, missing or repeated status markers,
modified wrappers, altered capture limits, foreign PID/path, and preservation
of the next trace after an invalid first trace. These fixtures do not execute
Android or establish new device stability. Separate image/geometry fixtures
cover original-kernel rejection, metadata/runtime mismatches, active or detached
capture guards, one-write/readback behavior, raw provenance and fixed timing
bounds. Their local success is not a new emulator result.

## Interpretation limits

The foreground capture is a light external trace. It does not request
FrameTimeline, sampled CPU call stacks or Compose runtime tracing. Scheduling
time and observed `waarp.vpn.intent.commit` slices may establish where recorded
work ran, but do not identify every source of a delayed frame. A missing marker
is unavailable evidence, not zero commits. Physical-device performance remains
unapproved; no hardware, thermal or battery claim follows from a software
emulator trace.
