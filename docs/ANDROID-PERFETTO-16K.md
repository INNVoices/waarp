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

The normal guard requires `current_tracer=nop`, no enabled events, a successful raw
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

When `set_event` contains exactly `bpf_trace:bpf_trace_printk`, the already
observed `tracing_on` is `0` and `current_tracer` is `nop`, the failed path also
attempts three read-only observations: CPU topology and all per-CPU statistics;
strict numeric/allocated/freed snapshot headers; and tracefs file-descriptor
paths, targets and access flags. Snapshot event payload and process argv are
excluded. These reads share the unchanged 10-second command, 60-second sequence
and 64 KiB stream limits. The `/proc` scan is not atomic; missing files, access
errors or `UNKNOWN` markers cannot establish ownership. `allReadsCompleted`
reports command completion only. `quiescenceEstablished` and `ownerEstablished`
remain false, and those diagnostic observations alone never permit mutation.

## Exact stopped-BPF empty-buffer path

The earlier failures remain failures. PR 42 run `44862192000`, release API 36
job `136719836586`, artifact `14690652483` (ZIP SHA-256
`df8bd658a38d0ba15cdff6d498658b94b6af9a705d5048d68bf1a7f09ac8c009`)
observed `tracing_on=0`, `nop`, exactly `bpf_trace:bpf_trace_printk` and zero
statistics on CPUs 0 and 1. Its shell FD observation was incomplete and its
snapshot interface was absent. It did **not** establish a safe resize. PR 44's
same guard refusal on the corrected Android 36.1 AVD also remains failed.

The narrow candidate below requires new evidence. It does not disable BPF,
attribute the BPF producer, allow arbitrary `events/enable=X`, or relax the
event/marker/scheduling assertions in the actual acceptance trace.

### Bind the kernel and its compiled features

The official 36.1 r4 image's complete `kernel-ranchu` member is 22,635,520 bytes,
SHA-256 `8e673c5d9b9f5e44f056346eda93adf8b96d3c9f300ce7b4fcc209d6ada906a5`.
An independently replayed range extraction verified the entire member CRC and
its embedded IKCONFIG; it did not download or claim a hash of the whole image
archive. The installed kernel is now hashed through bounded regular-file reads,
and that inventory is part of the existing image proof and its 60-second
deadline. The kernel hash has its own maximum of 10 seconds.

The raw embedded `config.gz` is 46,801 bytes, SHA-256
`f4caa7dbe4722eb5b2d3f711f92a73e2115dc4071d72846e61fde52b3698d71a`.
The live `/proc/config.gz` must match it. In this exact configuration,
`TRACER_MAX_TRACE` and `TRACER_SNAPSHOT` are disabled; `PID_NS` and `USER_NS` are
disabled; `MEMBARRIER`, `PREEMPT_RCU` and `KCMP` are enabled. These are reviewed
compile-time facts, not deductions from an absent snapshot file. The exact
[Kconfig](https://github.com/aosp-mirror/kernel_common/blob/bb9513914902b52a9751ea1126ad40518a38c89f/kernel/trace/Kconfig),
[max-buffer allocation and snapshot creation](https://github.com/aosp-mirror/kernel_common/blob/bb9513914902b52a9751ea1126ad40518a38c89f/kernel/trace/trace.c),
and [raw config export](https://github.com/aosp-mirror/kernel_common/blob/bb9513914902b52a9751ea1126ad40518a38c89f/kernel/configs.c)
define this relationship. Missing/wrong installed kernel, changed runtime
config or an unexpected snapshot interface rejects the candidate.

### Observe every task's file table without spawning scan children

`scripts/android-ftrace-observer.c` is a test-only native observer, built with
the already pinned NDK `28.2.13676358` for `x86_64-linux-android29` with 16 KiB ELF
alignment. It is outside the APK. Builder schema 2 additionally compiles the
small `android-ftrace-observer.bpf.c` with that NDK's `clang -target bpfel`.
It needs no libbpf, CO-RE, bpftool, kernel rebuild or additional toolchain.
It extracts the single relocatable ELF's exact `iter/task_file` instructions,
rejects relocations/maps/unexpected helpers, and embeds the verified bytes in
the native observer. The seven retained files are `build.json`, the native
binary and C source, BPF C source, shared wire/layout header, BPF object, and
the generated instruction header. The receipt records both source identities,
compiler identity/version, exact arguments, program/native hashes and checked
ELF metadata in `out/android/ci-observer/build.json`. The verifier
compares the retained source with the checked-out source before execution and
during replay. Build receipts are consistency evidence, not independent
authentication of CI or the installed compiler.

Only after the disposable/root/image/config/BTF guards pass, the bounded ADB
recorder creates a fresh private `/data/local/tmp/waarp-ftrace-observer-...`
directory, transfers the exact binary, checks its guest hash, runs it once and
removes only that owned binary/directory. Exact transfer argv, timings, raw
output and hashes use the same 10-second command, 60-second total and 64 KiB
stream limits. The observer itself has a 9-second deadline. A cleanup failure
is retained separately and cannot replace the primary observation failure.

The observer requires the existing root `su` SELinux context with the global
SELinux enforcing switch unchanged, a real procfs root, and visibility through `hidepid=0` or the actual
filesystem GID/supplementary-group bypass for `hidepid=1/2`. Real/effective GID
alone is insufficient. `hidepid=4`, unknown modes, a restricted proc subset or
any unreadable data refuse observation. The exact kernel's disabled PID
namespace feature is confirmed by the expected absence of the two literal
`self/ns/pid` and `1/ns/pid` entries after verifying their namespace directories;
this is never used to ignore a missing task or descriptor. See the exact
[proc permission logic](https://github.com/aosp-mirror/kernel_common/blob/bb9513914902b52a9751ea1126ad40518a38c89f/fs/proc/base.c),
[filesystem group check](https://github.com/aosp-mirror/kernel_common/blob/bb9513914902b52a9751ea1126ad40518a38c89f/kernel/groups.c),
and [compiled namespace entries](https://github.com/aosp-mirror/kernel_common/blob/bb9513914902b52a9751ea1126ad40518a38c89f/fs/proc/namespaces.c).

All `/proc/TGID/task/TID/fd` tables are covered, including threads that unshared
their file table. `KCMP_FILES` deduplicates only proven-equal tables, and equality
is checked again during both later task observations. In the initial inventory,
a denied/unavailable comparison causes a full scan of that TID; it does not
omit it. The resulting table representatives remain fixed.

Schema 4 retains schema 3's permission only for positively covered **additional threads** within the
unchanged original process set. All original TID/start-time identities remain
mandatory; a thread accepted during the middle observation also remains
mandatory in the final one. A new TID requires fresh start time before and
after a successful KCMP comparison to an original representative of the same
TGID whose table was already completely observed. The representative's start
time is checked around the binding. A newcomer cannot represent another
newcomer or add an unobserved table. Denied, missing, unique or unknown new
tables refuse; missing known threads, changed start times and changed sharing
are separate refusal reasons. There is no departure allowance or signal call.
The exact [KCMP implementation](https://github.com/aosp-mirror/kernel_common/blob/bb9513914902b52a9751ea1126ad40518a38c89f/kernel/kcmp.c#L137-L227)
compares the tasks' file-table pointers after task lookup and access checks.

In each of the two later phases, the TID list must match an exact repeat
after its members have been checked. Fresh identity and sharing checks follow
that repeat for every member, including final-phase newcomers. The process
list must also remain identical at the end of each phase. There is no retry
or quieting delay. Evidence records three monotone thread counts, the added
shared members in each phase and five matching process-list observations;
`threads` and `sharedThreads` describe the final observation. The cumulative
accepted task set remains limited to 8,192. This attests observed table
coverage and retained identities, not a stable whole thread population.

Descriptor observation retains two global passes and the fixed table
representatives. The exact image's embedded `.BTF` is 7,167,898 bytes, SHA-256
`d9bad01cb909205a22d741adf6b9f5a907a6e805354a94d9012165f2002508fa`.
The live `/sys/kernel/btf/vmlinux` must match before the program is transferred.
Offline type review follows the reachable function/context/pointer graph,
including `__bpf_md_ptr` anonymous unions; duplicate named structures are not
selected by name alone. The exact attach function is BTF ID 97052, context ID 17948.
The retained shared header binds the reviewed type widths and offsets to this
digest. Another kernel, BTF graph, missing export or changed hash refuses.

The native observer first checks its actual effective capabilities and requires
`CAP_SYS_ADMIN` or both `CAP_BPF` and `CAP_PERFMON`, and `Seccomp:0`. UID 0 alone
is insufficient. The [exact program-load checks](https://github.com/aosp-mirror/kernel_common/blob/bb9513914902b52a9751ea1126ad40518a38c89f/kernel/bpf/syscall.c#L2624-L2710)
and [capability fallback](https://github.com/aosp-mirror/kernel_common/blob/bb9513914902b52a9751ea1126ad40518a38c89f/kernel/bpf/token.c#L11-L27)
define these requirements. AOSP's userdebug [su policy](https://android.googlesource.com/platform/system/sepolicy/+/refs/heads/android16-release/private/su.te)
marks that domain permissive; the observed global enforcing flag is not proof
that `su` itself enforces every SELinux rule. The observer changes no SELinux
policy, capability, seccomp filter or credential. A denied load/link/read fails;
bounded verifier diagnostics are retained for the fixed program before any
foreign file is supplied to it. Static policy/source review is not a successful
guest load or a substitute for actual acceptance.

One anonymous `BPF_PROG_TYPE_TRACING`/`BPF_TRACE_ITER` program is loaded. Each
observation creates a link selecting the **explicit representative TID** and
its iterator; it does not use ALL/TGID iteration's implicit shared-table skip.
The exact [iterator](https://github.com/aosp-mirror/kernel_common/blob/bb9513914902b52a9751ea1126ad40518a38c89f/kernel/bpf/task_iter.c#L259-L382)
retains a task/file reference through its callback. The
[lookup/refcount implementation](https://github.com/aosp-mirror/kernel_common/blob/bb9513914902b52a9751ea1126ad40518a38c89f/fs/file.c#L933-L1090)
revalidates the slot/table after obtaining a reference. The callback reads only
TID/TGID, FD number, inode, normalized device major/minor, file type and
`file->f_flags`, using checked metadata reads. It exports no kernel pointer,
path, argv, device-specific fdinfo tail or file contents. This temporary kernel
reference is not a userspace open/dup of a foreign target. The only BPF helpers
are metadata `probe_read_kernel` and output `seq_write`; no trace-print helper,
trace hook, persistent pin, map or modification of an existing BPF program is
used. All program/link/iterator descriptors close before the GLOBAL barrier.

Every emitted tracefs candidate still goes through the prior strict
`fstatat`/`fdinfo`/`fstatat` checks and must match the BPF device/inode/type.
Only the exact write-only top-level `trace_marker` descriptor is allowed;
readers, controls, O_PATH, changed or disappeared tracefs entries refuse.
The proc flags, including descriptor-slot `O_CLOEXEC`, remain in the compared
tracefs projection, with `(procFlags & ~O_CLOEXEC) == fileStatusFlags` required.
Non-tracefs records describe file status flags, not the live CLOEXEC bitmap;
non-tracefs flag differences were already permitted. A newly read FD number
never inherits an earlier classification. See the
[fdinfo flag construction](https://github.com/aosp-mirror/kernel_common/blob/bb9513914902b52a9751ea1126ad40518a38c89f/fs/proc/fd.c#L23-L59).

For each table in each pass, a complete referenced metadata stream S1 supplies
both FD numbers and their classifications, then the observer reads the numeric
proc FD list B. If S1's numbers equal B, that pass is covered. Otherwise exactly
one complete stream S2 is allowed, followed by numeric list C. Both
**S2.numbers == B and C == B** are required. S1/S2 comparisons permit only
positively non-tracefs additions, removals or replacements; any tracefs
projection change refuses. A missing B member, unknown/error record, changed
C or incomplete stream refuses without a third sample or quieting delay.
Thus the new iterator replaces the old split enumeration-to-fstat metadata
race while preserving the separate end-number coverage gate. The same strict
tracefs projection comparison remains between the two global passes.

The private wire protocol uses fixed 64-byte records, explicit ERROR/END kinds,
strict session/sequence/TID checks, increasing FD numbers and a subsequent
actual EOF. Each userspace read requests at most 4096 bytes. The exact kernel's
`CONFIG_PAGE_SHIFT=12` makes [its iterator buffer](https://github.com/aosp-mirror/kernel_common/blob/bb9513914902b52a9751ea1126ad40518a38c89f/kernel/bpf/bpf_iter.c#L88-L235)
32768 bytes; one 64-byte record per callback plus an END fits that bound. This
kernel page fact is separate from the observed 16384-byte userspace page value.
Callback return 1 means retrying an object, not a durable error, so failed
metadata reads emit ERROR records. No host EAGAIN/read-error retry is used.
The reviewed kernel can prefetch a final un-emitted object after a full 4096-byte
read. A one-ahead END cursor is accepted only as the first complete record of
the next read, with no pending fragment and a prior full read without END;
all other END sequence mismatches refuse. This describes the kernel cursor,
not a skipped emitted metadata record or evidence of stable file slots.

Schema 4 retains final counts and within/between-pass comparison differences;
it separately records all BPF metadata records, complete streams and bytes,
strict tracefs cross-checks, reconciliations, source-bound END cursor advances,
actual capability bits, and successful closing of all anonymous BPF objects.
These are observed comparison counts, not unique operating-system mutations.
At most two samples per table per pass retain the limits of 65536 descriptors
per table, 262144 final descriptors and 524288 metadata records per pass. BPF
loading, reads, cross-checks, closes and all old task/barrier checks remain in
the same 9-second observer, 10-second command and 60-second total deadlines;
stdout/stderr remain bounded to 64 KiB.

Classification still uses the actual tracefs superblock device and exact
marker inode, never an unknown `mnt_id`. In this exact kernel,
[tracefs uses one superblock](https://github.com/aosp-mirror/kernel_common/blob/bb9513914902b52a9751ea1126ad40518a38c89f/fs/tracefs/inode.c),
so aliases, detached mounts and cross-namespace descriptors keep that device
identity. [Mountinfo can omit entries outside a task's root](https://github.com/aosp-mirror/kernel_common/blob/bb9513914902b52a9751ea1126ad40518a38c89f/fs/proc_namespace.c);
its absence is not a non-tracefs classification.

This is a bounded observation of forbidden tracefs **descriptors**, not an
atomic ownership proof or an assertion that no mmap can outlive `close(fd)`.
Equal B/C lists cover numeric entries at those observations; a same-number
replacement after the last metadata sample can occur before another sample,
as with the earlier two-pass observer. The protocol does not attest all
intervening or future table states. No old non-tracefs identity is used to
classify a newly read entry.
The exact resize implementation rejects mapped CPU buffers with `EBUSY` before
deleting pages. That kernel refusal is preserved; no second write is attempted.
The BPF producer's identity remains explicitly unknown.

The first actual observer execution on
[PR45 head daf9b741, release API36](https://github.com/INNVoices/waarp/actions/runs/44869936437/job/136743968972)
refused because a table's end numeric list differed during the first pass. Its last checked
FD was not evidence identifying which entry changed or whether it was
non-tracefs. That failure remains a failure: no GLOBAL barrier, buffer resize
or accepted release trace was reached. Schema 2 requires fresh classified
evidence before allowing its narrower non-tracefs reconciliation.

The following
[head b6544eb1 run](https://github.com/INNVoices/waarp/actions/runs/44872198520/job/136750879686)
completed the first FD pass, then refused at the middle task observation.
Its combined condition could fail on membership before reading start time;
the recorded PID/TID therefore establishes neither a changed start time nor
a harmless new thread. That failure is retained. Schema 3 requires new
positive shared-table evidence and does not reinterpret that old result.

The later [abce5c37 optimized API36 job](https://github.com/INNVoices/waarp/actions/runs/44875422019/job/136761225141)
and its diagnostic preflight both failed on `descriptor_stat`/ENOENT before
GLOBAL or any resize. That was the first fstatat of the current sample; it did
not prove that the FD was non-tracefs or harmlessly closed. Those failures are
not reinterpreted as accepted observations. Schema 4 needs fresh runtime
records from its guarded iterator path; host compilation and fixtures do not
establish verifier/permission success, runtime acceptance or a production APK.

### Complete prior writers, then check empty counters and preserve controls

After rechecking `tracing_on=0`, `nop`, the sole BPF event and 4 KiB geometry,
the observer verifies both possible/present/online CPUs are exactly `0-1`.
It issues one `MEMBARRIER_CMD_QUERY`, requires GLOBAL support, then one
`MEMBARRIER_CMD_GLOBAL` with flags 0. The exact
[membarrier implementation](https://github.com/aosp-mirror/kernel_common/blob/bb9513914902b52a9751ea1126ad40518a38c89f/kernel/sched/membarrier.c#L638-L655)
performs `synchronize_rcu()` with more than one online CPU. This completes an
already-started writer before the **new** zero-statistics observation; expedited
or private barriers do not substitute for this reviewed path. Unsupported,
denied, failed or timed-out barriers refuse preparation. No persistent
registration is made.

Controls/topology are checked again, and every CPU's entries, bytes, overruns,
commit overruns, dropped/read events and oldest-event timestamp must be zero.
The host rechecks controls and all CPU statistics before its single literal
4→16 KiB write. Afterwards it requires 16 KiB, unchanged `PAGE_SIZE=16384`,
unchanged stopped/nop/sole-BPF state and zero counters. The exact
[ring-buffer order-change code](https://github.com/aosp-mirror/kernel_common/blob/bb9513914902b52a9751ea1126ad40518a38c89f/kernel/trace/ring_buffer.c#L6840-L7011)
explains both the destructive page replacement that makes empty-state proof
necessary and the preserved mapped-buffer refusal. Unknown/active paths still
fail; no trace data, snapshot, event enable or BPF program is cleared.

Host fixtures cover the new contract, partial/raw tampering, false barrier
types/results, unavailable descriptor comparison, unshared tables, disappearing
tasks, alias readers, FSGID, changed controls and exact kernel/config identity.
A synthetic host scaling run with 201 threads and 256 descriptors per thread
took approximately 0.006 seconds with proven shared-table deduplication and
0.357 seconds with denied KCMP and all 51,456 descriptors scanned twice. These
are host fixture timings with mocked KCMP results; guest performance and
successful API 36 recording remain **NOT_RUN** until the next ordinary CI run.

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
