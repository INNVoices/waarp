/* Test-only metadata emitter for the reviewed disposable API36 image.
 * Metadata only: no target open/dup, path, argv, content, kernel pointer output,
 * tracefs write, bpf_trace_printk helper, hook attachment or persistent pin.
 * Offsets must come from the exact reviewed vmlinux BTF graph and digest.
 */
#include "android-ftrace-observer-bpf.h"

struct iterator_meta { void *seq; u64 session_id; u64 seq_num; };
struct iterator_context { struct iterator_meta *meta; void *task; u32 fd; u32 pad; void *file; };
_Static_assert(sizeof(struct iterator_context) == 32, "exact BTF context layout");
_Static_assert(__builtin_offsetof(struct iterator_context, file) == CTX_FILE, "BTF file offset");
_Static_assert(__builtin_offsetof(struct iterator_context, task) == CTX_TASK, "BTF task offset");
_Static_assert(__builtin_offsetof(struct iterator_context, meta) == CTX_META, "BTF meta offset");
_Static_assert(__builtin_offsetof(struct iterator_context, fd) == CTX_FD, "BTF fd offset");
_Static_assert(__builtin_offsetof(struct iterator_meta, seq) == META_SEQ, "BTF seq offset");
_Static_assert(__builtin_offsetof(struct iterator_meta, session_id) == META_SESSION_ID, "BTF session offset");
_Static_assert(__builtin_offsetof(struct iterator_meta, seq_num) == META_SEQ_NUM, "BTF sequence offset");

/* IDs independently match the pinned kernel's include/uapi/linux/bpf.h. */
static long (*const read_kernel)(void *, u32, const void *) = (void *)113;
static long (*const write_record)(void *, const void *, u32) = (void *)127;
#define READ_FIELD(dst, base, offset) read_kernel(&(dst), sizeof(dst), (const u8 *)(base) + (offset))

__attribute__((section("iter/task_file"), used))
int observe_metadata(struct iterator_context *ctx) {
    struct WaarpBpfRecord out = {.magic = WAARP_BPF_RECORD_MAGIC, .version = WAARP_BPF_RECORD_VERSION, .kind = WAARP_BPF_RECORD_DATA};
    struct iterator_meta *meta = ctx->meta;
    void *task = ctx->task, *file = ctx->file;
    void *inode = (void *)0, *superblock = (void *)0;
    u32 device = 0;
    u16 mode = 0;
    out.session = meta->session_id;
    out.sequence = meta->seq_num;
    if (!file) {
        out.kind = WAARP_BPF_RECORD_END; /* END; EOF without this marker is never success. */
        /* Keep the two nullable-pointer tests separate for BPF's verifier. */
        __asm__ __volatile__("" : "+r"(task));
        if (task) { out.kind = WAARP_BPF_RECORD_ERROR; out.error = 1; }
    } else if (!task) {
        out.kind = WAARP_BPF_RECORD_ERROR; out.error = 1;
    } else {
        out.fd = ctx->fd;
        if (READ_FIELD(out.tid, task, TASK_PID) || READ_FIELD(out.tgid, task, TASK_TGID)
            || READ_FIELD(inode, file, FILE_F_INODE) || !inode
            || READ_FIELD(superblock, inode, INODE_I_SB) || !superblock
            || READ_FIELD(device, superblock, SUPER_S_DEV)
            || READ_FIELD(out.inode, inode, INODE_I_INO)
            || READ_FIELD(mode, inode, INODE_I_MODE)
            || READ_FIELD(out.file_status_flags, file, FILE_F_FLAGS)) {
            out.kind = WAARP_BPF_RECORD_ERROR; out.error = 2;
        } else {
            /* Kernel dev_t layout differs from userspace st_dev encoding. */
            out.device_major = device >> 20;
            out.device_minor = device & ((1u << 20) - 1u);
            out.file_type = mode & 0170000u;
        }
    }
    /* Metadata failure is an explicit record, never ret=1 (retry object).
     * Host read requests <=4096. One64B record/callback, plus64B END, stays
     * below exact kernel bpf_seq_read's32768B buffer (CONFIG_PAGE_SHIFT=12).
     * ret1 may defer an error behind a prefix and retry: it is NOT a sticky
     * error result. Checked metadata failures use explicit ERROR records;
     * any read error, missing END, ERROR or malformed stream must refuse.
     */
    return write_record(meta->seq, &out, sizeof(out)) == 0 ? 0 : 1;
}

char iterator_license[] __attribute__((section("license"), used)) = "GPL";
