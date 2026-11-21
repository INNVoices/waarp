/* Reviewed exact-image layout and private metadata wire format.
 * Derived from kernel bb9513914902b52a9751ea1126ad40518a38c89f's reachable BTF:
 * bpf_iter_task_file FUNC97052 -> prototype97051; context17948;
 * task333 -> file215 -> inode118 -> super_block181; meta15219.
 * This is not a portable kernel ABI. Runtime BTF digest must match exactly.
 */
#ifndef WAARP_ANDROID_FTRACE_OBSERVER_BPF_H
#define WAARP_ANDROID_FTRACE_OBSERVER_BPF_H
#define WAARP_KERNEL_BTF_SHA256 "d9bad01cb909205a22d741adf6b9f5a907a6e805354a94d9012165f2002508fa"
#define WAARP_KERNEL_BTF_BYTES 7167898
#define ATTACH_BTF_ID 97052
#define CTX_META 0
#define CTX_TASK 8
#define CTX_FD 16
#define CTX_FILE 24
#define META_SEQ 0
#define META_SESSION_ID 8
#define META_SEQ_NUM 16
#define TASK_PID 1800
#define TASK_TGID 1804
#define FILE_F_INODE 40
#define FILE_F_FLAGS 48
#define INODE_I_MODE 0
#define INODE_I_SB 40
#define INODE_I_INO 64
#define SUPER_S_DEV 16
#define WAARP_BPF_RECORD_MAGIC 0x57525049u
#define WAARP_BPF_RECORD_VERSION 1u
#define WAARP_BPF_RECORD_DATA 1u
#define WAARP_BPF_RECORD_END 2u
#define WAARP_BPF_RECORD_ERROR 3u
#define WAARP_BPF_READ_BYTES 4096u

typedef unsigned char u8;
typedef unsigned short u16;
typedef unsigned int u32;
typedef unsigned long long u64;

/* No pointer, path, argv or contents. Device numbers are normalized parts.
 * END repeats the final data sequence, or0 for an empty table. A one-ahead
 * cursor is allowed only as the first complete record after an actual4096B
 * read without END or pending bytes (the reviewed kernel prefetch boundary).
 * Userspace must validate END and a subsequent actual zero-byte read.
 * file_status_flags comes from f_flags, not the descriptor's CLOEXEC bitmap.
 */
struct WaarpBpfRecord {
    u32 magic;
    u16 version, kind;
    u64 session, sequence, inode;
    u32 tgid, tid, fd, device_major, device_minor, file_status_flags, file_type, error;
};
_Static_assert(sizeof(struct WaarpBpfRecord) == 64, "fixed bounded wire record");
#endif
