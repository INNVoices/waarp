/* Test-only metadata observer for the exact reviewed disposable API 36 image.
 * It never opens a foreign descriptor's target, reads trace payload, writes
 * tracefs, signals another process, changes credentials or stops BPF. A single
 * GLOBAL membarrier supplies the reviewed kernel's RCU grace period. Every
 * incomplete/unknown/denied observation is a refusal, not an omitted owner.
 * One bounded reconciliation may classify non-tracefs descriptor changes;
 * these samples are not an atomic snapshot of another process's file table.
 */
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <signal.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/syscall.h>
#include <sys/sysmacros.h>
#include <time.h>
#include <unistd.h>

#define MAX_PROCESSES 1024
#define MAX_TASKS 8192
#define MAX_FDS 65536
#define MAX_TOTAL_FDS 262144
#define PROC_MAGIC 0x9fa0
#define TRACEFS_MAGIC 0x74726163
#define KCMP_FILES_VALUE 2
#define MEMBARRIER_QUERY_VALUE 0
#define MEMBARRIER_GLOBAL_VALUE 1
#define DEADLINE_NS UINT64_C(9000000000)

typedef struct { int *v; size_t n; } Numbers;
typedef struct { int number; uint64_t dev, ino; unsigned mode; uint64_t flags; } Descriptor;
typedef struct { int pid, directory; } Process;
typedef struct { int pid, tid; uint64_t start; size_t process, table; } Task;
typedef struct { size_t representative; Descriptor *fds; size_t count; } Table;
typedef struct { size_t added, removed, replaced; } Differences;
typedef struct {
    Process processes[MAX_PROCESSES]; size_t process_count;
    Task tasks[MAX_TASKS]; size_t task_count;
    Table tables[MAX_TASKS]; size_t table_count;
    size_t descriptors[2], metadata_reads[2], markers, shared, kcmp_denied, reconciliations;
    Differences within_pass, between_pass;
} Inventory;

static uint64_t started_ns;
static const char *failure_stage = "startup";
static int failure_pid, failure_tid, failure_fd = -1;
static int scan_proc_fd = -1;
static uint64_t trace_dev, marker_ino;
static int observer_pid;

static uint64_t monotonic_ns(void) {
    struct timespec value;
    if (clock_gettime(CLOCK_MONOTONIC, &value)) _exit(125);
    return (uint64_t)value.tv_sec * UINT64_C(1000000000) + (uint64_t)value.tv_nsec;
}

static _Noreturn void refuse(const char *reason) {
    /* Only source literals and numeric metadata; no path/argv/event payload. */
    int error = errno;
    printf("{\"schemaVersion\":2,\"passed\":false,\"reason\":\"%s\","
           "\"stage\":\"%s\",\"errno\":%d,\"pid\":%d,\"tid\":%d,\"fd\":%d}\n",
           reason, failure_stage, error, failure_pid, failure_tid, failure_fd);
    exit(1);
}

static void must(bool condition, const char *reason) { if (!condition) refuse(reason); }
static void bounded(void) { errno = 0; must(monotonic_ns() - started_ns < DEADLINE_NS, "observer_deadline"); }
static void alarm_exit(int sig) { (void)sig; _exit(124); }

static size_t read_text_at(int directory, const char *name, char *buffer, size_t capacity) {
    bounded();
    int fd = openat(directory, name, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    must(fd >= 0, "metadata_open");
    size_t total = 0;
    for (;;) {
        ssize_t n = read(fd, buffer + total, capacity - 1 - total);
        must(n >= 0, "metadata_read");
        if (!n) break;
        total += (size_t)n;
        must(total < capacity - 1, "metadata_size");
    }
    must(close(fd) == 0, "metadata_close");
    buffer[total] = 0;
    return total;
}

static int number_compare(const void *a, const void *b) {
    int x = *(const int *)a, y = *(const int *)b;
    return (x > y) - (x < y);
}

static Numbers numeric_entries(int directory, const char *path, size_t maximum) {
    bounded();
    int fd = openat(directory, path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    must(fd >= 0, "directory_open");
    DIR *stream = fdopendir(fd);
    must(stream != NULL, "directory_stream");
    Numbers result = {calloc(maximum, sizeof(int)), 0};
    must(result.v != NULL, "allocation");
    for (;;) {
        errno = 0;
        struct dirent *entry = readdir(stream);
        if (!entry) { must(errno == 0, "directory_read"); break; }
        const char *p = entry->d_name;
        if (*p < '0' || *p > '9') continue;
        char *end = NULL;
        errno = 0;
        long value = strtol(p, &end, 10);
        must(!errno && *end == 0 && value >= 0 && value <= INT_MAX, "numeric_entry");
        must(result.n < maximum, "inventory_limit");
        result.v[result.n++] = (int)value;
    }
    must(closedir(stream) == 0, "directory_close");
    qsort(result.v, result.n, sizeof(int), number_compare);
    for (size_t i = 1; i < result.n; ++i) must(result.v[i - 1] != result.v[i], "duplicate_entry");
    return result;
}

static uint64_t task_start(int process_directory, int tid) {
    char path[64], data[4096];
    snprintf(path, sizeof(path), "task/%d/stat", tid);
    read_text_at(process_directory, path, data, sizeof(data));
    /* comm can contain spaces and parentheses; never emit it. */
    char *tail = strrchr(data, ')');
    must(tail && tail[1] == ' ', "task_stat");
    char *save = NULL, *part = strtok_r(tail + 2, " \n", &save);
    for (int field = 3; field < 22; ++field) {
        must(part != NULL, "task_stat_fields");
        part = strtok_r(NULL, " \n", &save);
    }
    must(part && *part >= '0' && *part <= '9', "task_start_time");
    char *end;
    errno = 0;
    uint64_t value = strtoull(part, &end, 10);
    must(!errno && !*end, "task_start_time");
    return value;
}

static long same_files(int first, int second) {
    bounded();
    errno = 0;
    return syscall(SYS_kcmp, first, second, KCMP_FILES_VALUE, 0UL, 0UL);
}

static void initial_inventory(Inventory *inventory) {
    failure_stage = "task_inventory_before";
    Numbers pids = numeric_entries(scan_proc_fd, ".", MAX_PROCESSES + 1);
    for (size_t p = 0; p < pids.n; ++p) {
        int pid = pids.v[p];
        if (pid == observer_pid) continue;  /* This single-thread observer only. */
        failure_pid = pid;
        must(inventory->process_count < MAX_PROCESSES, "process_limit");
        char path[32]; snprintf(path, sizeof(path), "%d", pid);
        int directory = openat(scan_proc_fd, path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
        must(directory >= 0, "process_directory");
        size_t process = inventory->process_count++;
        inventory->processes[process] = (Process){pid, directory};
        Numbers tids = numeric_entries(directory, "task", MAX_TASKS);
        must(tids.n > 0, "empty_task_inventory");
        size_t first_table = inventory->table_count;
        for (size_t t = 0; t < tids.n; ++t) {
            failure_tid = tids.v[t];
            must(inventory->task_count < MAX_TASKS, "task_limit");
            size_t index = inventory->task_count++;
            Task *task = &inventory->tasks[index];
            *task = (Task){pid, tids.v[t], task_start(directory, tids.v[t]), process, SIZE_MAX};
            for (size_t g = first_table; g < inventory->table_count; ++g) {
                Task *representative = &inventory->tasks[inventory->tables[g].representative];
                long equal = same_files(task->tid, representative->tid);
                if (equal == 0) { task->table = g; inventory->shared++; break; }
                if (equal < 0) {
                    must(errno == ENOSYS || errno == EPERM || errno == EACCES, "kcmp_unknown_task");
                    inventory->kcmp_denied++;
                    break; /* Full scan for this TID; never assume a shared table. */
                }
                must(equal <= 3, "kcmp_result");
            }
            must(task_start(directory, task->tid) == task->start, "task_identity_changed");
            if (task->table == SIZE_MAX) {
                task->table = inventory->table_count;
                inventory->tables[inventory->table_count++] = (Table){index, NULL, 0};
            }
        }
        free(tids.v);
    }
    free(pids.v);
    must(inventory->process_count > 1 && inventory->task_count >= inventory->process_count,
         "incomplete_process_inventory");
}

static void verify_inventory(const Inventory *inventory) {
    Numbers pids = numeric_entries(scan_proc_fd, ".", MAX_PROCESSES + 1);
    size_t process = 0, task_index = 0;
    for (size_t p = 0; p < pids.n; ++p) {
        if (pids.v[p] == observer_pid) continue;
        must(process < inventory->process_count && pids.v[p] == inventory->processes[process].pid,
             "process_inventory_changed");
        Process item = inventory->processes[process];
        failure_pid = item.pid;
        Numbers tids = numeric_entries(item.directory, "task", MAX_TASKS);
        for (size_t t = 0; t < tids.n; ++t) {
            must(task_index < inventory->task_count, "task_inventory_changed");
            const Task *task = &inventory->tasks[task_index++];
            failure_tid = tids.v[t];
            must(task->pid == item.pid && task->tid == tids.v[t]
                 && task->start == task_start(item.directory, tids.v[t]), "task_identity_changed");
            size_t representative = inventory->tables[task->table].representative;
            if (representative != task_index - 1) {
                must(same_files(task->tid, inventory->tasks[representative].tid) == 0,
                     "shared_files_changed");
            }
        }
        free(tids.v);
        must(task_index == inventory->task_count || inventory->tasks[task_index].pid != item.pid,
             "task_inventory_changed");
        process++;
    }
    free(pids.v);
    must(process == inventory->process_count && task_index == inventory->task_count,
         "process_inventory_changed");
}

static Descriptor descriptor_metadata(int fd_directory, int task_directory, int number) {
    bounded();
    failure_fd = number;
    char name[32], info[64], data[512];
    snprintf(name, sizeof(name), "%d", number);
    snprintf(info, sizeof(info), "fdinfo/%d", number);
    struct stat before, after;
    must(fstatat(fd_directory, name, &before, 0) == 0, "descriptor_stat");
    /* Read one bounded metadata prefix, retain only its first four lines.
     * Large device-specific fdinfo tails and the target are never consumed. */
    int fd = openat(task_directory, info, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
    must(fd >= 0, "descriptor_info_open");
    ssize_t got = read(fd, data, sizeof(data) - 1);
    must(got > 0, "descriptor_info_header");
    size_t used = 0; unsigned lines = 0;
    while (used < (size_t)got && lines < 4) if (data[used++] == '\n') lines++;
    must(lines == 4, "descriptor_info_header");
    must(close(fd) == 0, "descriptor_info_close");
    data[used] = 0;
    uint64_t flags, inode;
    long long position; unsigned mount;
    int consumed = 0;
    must(sscanf(data, "pos:\t%lld\nflags:\t%" SCNo64 "\nmnt_id:\t%u\nino:\t%" SCNu64 "\n%n",
                &position, &flags, &mount, &inode, &consumed) == 4 && consumed == (int)used,
         "descriptor_info_format");
    must(fstatat(fd_directory, name, &after, 0) == 0, "descriptor_restat");
    must(before.st_dev == after.st_dev && before.st_ino == after.st_ino
         && before.st_mode == after.st_mode && inode == (uint64_t)after.st_ino,
         "descriptor_identity_changed");
    (void)position; (void)mount; /* mnt_id is not a safe filesystem classifier. */
    Descriptor result = {number, (uint64_t)after.st_dev, (uint64_t)after.st_ino,
                         (unsigned)(after.st_mode & S_IFMT), flags};
    if (result.dev == trace_dev) {
        must(result.ino == marker_ino && S_ISREG(after.st_mode)
             && (flags & O_ACCMODE) == O_WRONLY && !(flags & O_PATH),
             "tracefs_consumer_or_control");
    }
    return result;
}

static bool descriptor_equal(Descriptor a, Descriptor b) {
    return a.number == b.number && a.dev == b.dev && a.ino == b.ino
           && a.mode == b.mode && a.flags == b.flags;
}

/* Each side contains fresh, successfully classified descriptor identities.
 * A numeric FD never carries its former classification into a new sample. */
static void compare_samples(const Descriptor *before, size_t before_count,
                            const Descriptor *after, size_t after_count, Differences *differences) {
    size_t old = 0, current = 0;
    while (old < before_count || current < after_count) {
        bounded();
        if (current == after_count || (old < before_count && before[old].number < after[current].number)) {
            failure_fd = before[old].number;
            must(before[old].dev != trace_dev, "tracefs_projection_changed");
            differences->removed++; old++;
        } else if (old == before_count || after[current].number < before[old].number) {
            failure_fd = after[current].number;
            must(after[current].dev != trace_dev, "tracefs_projection_changed");
            differences->added++; current++;
        } else {
            failure_fd = after[current].number;
            if (!descriptor_equal(before[old], after[current])) {
                must(before[old].dev != trace_dev && after[current].dev != trace_dev,
                     "tracefs_projection_changed");
                differences->replaced++;
            }
            old++; current++;
        }
    }
}

static bool same_numbers(Numbers a, Numbers b) {
    return a.n == b.n && !memcmp(a.v, b.v, a.n * sizeof(int));
}

static Descriptor *sample_metadata(Inventory *inventory, int fds, int directory,
                                   Numbers numbers, size_t pass) {
    must(inventory->metadata_reads[pass] + numbers.n <= 2 * MAX_TOTAL_FDS,
         "descriptor_metadata_limit");
    Descriptor *sample = calloc(numbers.n ? numbers.n : 1, sizeof(Descriptor));
    must(sample != NULL, "allocation");
    for (size_t n = 0; n < numbers.n; ++n) {
        sample[n] = descriptor_metadata(fds, directory, numbers.v[n]);
        inventory->metadata_reads[pass]++;
    }
    return sample;
}

static void scan_table(Inventory *inventory, size_t index, bool second) {
    Table *table = &inventory->tables[index];
    Task *task = &inventory->tasks[table->representative];
    failure_pid = task->pid; failure_tid = task->tid; failure_fd = -1;
    int process_directory = inventory->processes[task->process].directory;
    must(task_start(process_directory, task->tid) == task->start, "task_identity_changed");
    char path[64]; snprintf(path, sizeof(path), "task/%d", task->tid);
    int directory = openat(process_directory, path, O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    must(directory >= 0, "task_directory");
    int fds = openat(directory, "fd", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    must(fds >= 0, "descriptor_directory");
    size_t pass = second ? 1 : 0;
    Numbers first = numeric_entries(fds, ".", MAX_FDS);
    Descriptor *sample = sample_metadata(inventory, fds, directory, first, pass);
    size_t count = first.n;
    Numbers next = numeric_entries(fds, ".", MAX_FDS);
    if (!same_numbers(first, next)) {
        /* Exactly one fresh complete sample of B after A -> metadata(A) -> B.
         * Every missing/denied metadata read still refuses. The final numeric
         * inventory C must equal B; no third sample, retry or quieting delay. */
        inventory->reconciliations++;
        Descriptor *reconciled = sample_metadata(inventory, fds, directory, next, pass);
        Numbers final = numeric_entries(fds, ".", MAX_FDS);
        must(same_numbers(next, final), "descriptor_reconciliation_changed");
        compare_samples(sample, count, reconciled, next.n, &inventory->within_pass);
        free(final.v); free(sample);
        sample = reconciled; count = next.n;
    }
    free(next.v); free(first.v);
    must(inventory->descriptors[pass] + count <= MAX_TOTAL_FDS, "descriptor_total_limit");
    inventory->descriptors[pass] += count;
    if (second) {
        compare_samples(table->fds, table->count, sample, count, &inventory->between_pass);
        free(sample);
    } else {
        table->fds = sample; table->count = count;
        for (size_t n = 0; n < count; ++n) if (sample[n].dev == trace_dev) inventory->markers++;
    }
    must(close(fds) == 0 && close(directory) == 0, "task_directory_close");
    must(task_start(process_directory, task->tid) == task->start, "task_identity_changed");
}

static bool observer_group_member(unsigned group) {
    char status[16384];
    read_text_at(scan_proc_fd, "self/status", status, sizeof(status));
    char *line = strstr(status, "\nGid:\t");
    unsigned real_gid, effective_gid, saved_gid, fs_gid;
    if (!line) refuse("observer_fsgid");
    if (sscanf(line + 1, "Gid:\t%u\t%u\t%u\t%u", &real_gid,
               &effective_gid, &saved_gid, &fs_gid) != 4) refuse("observer_fsgid");
    (void)real_gid; (void)effective_gid; (void)saved_gid;
    if (fs_gid == group) return true;
    gid_t groups[256];
    int count = getgroups((int)(sizeof(groups) / sizeof(groups[0])), groups);
    must(count >= 0, "supplementary_groups");
    for (int i = 0; i < count; ++i) if ((unsigned)groups[i] == group) return true;
    return false;
}

/* Android's /proc can hide tasks even from uid 0. The gid bypass is explicit
 * for hidepid 1/2; hidepid=4/ptraceable and unknown options are refused. */
static void proc_visibility(unsigned *hidepid, unsigned *proc_gid) {
    char mounts[65536];
    read_text_at(scan_proc_fd, "self/mountinfo", mounts, sizeof(mounts));
    struct stat info; struct statfs fs;
    must(fstat(scan_proc_fd, &info) == 0 && fstatfs(scan_proc_fd, &fs) == 0
         && fs.f_type == PROC_MAGIC, "proc_filesystem");
    bool found = false;
    char *line_save = NULL;
    for (char *line = strtok_r(mounts, "\n", &line_save); line;
         line = strtok_r(NULL, "\n", &line_save)) {
        char *fields[32], *save = NULL; size_t n = 0;
        for (char *word = strtok_r(line, " ", &save); word; word = strtok_r(NULL, " ", &save)) {
            must(n < 32, "mountinfo_fields"); fields[n++] = word;
        }
        must(n >= 10, "mountinfo_format");
        if (strcmp(fields[4], "/proc")) continue;
        must(!found && !strcmp(fields[3], "/"), "proc_mount_ambiguous");
        size_t separator = 6;
        while (separator < n && strcmp(fields[separator], "-")) separator++;
        must(separator + 4 == n && !strcmp(fields[separator + 1], "proc"), "proc_mount_type");
        unsigned major_number, minor_number; char tail;
        must(sscanf(fields[2], "%u:%u%c", &major_number, &minor_number, &tail) == 2
             && major_number == major(info.st_dev) && minor_number == minor(info.st_dev), "proc_mount_device");
        *hidepid = 0; *proc_gid = 0;
        char *option_save = NULL;
        for (char *option = strtok_r(fields[separator + 3], ",", &option_save); option;
             option = strtok_r(NULL, ",", &option_save)) {
            if (!strncmp(option, "hidepid=", 8)) {
                const char *value = option + 8;
                if (!strcmp(value, "0") || !strcmp(value, "off")) *hidepid = 0;
                else if (!strcmp(value, "1") || !strcmp(value, "noaccess")) *hidepid = 1;
                else if (!strcmp(value, "2") || !strcmp(value, "invisible")) *hidepid = 2;
                else { errno = 0; refuse("proc_hidepid_unknown"); }
            } else if (!strncmp(option, "gid=", 4)) {
                char *end; errno = 0; unsigned long value = strtoul(option + 4, &end, 10);
                must(!errno && *end == 0 && value <= UINT_MAX, "proc_gid"); *proc_gid = (unsigned)value;
            } else if (!strncmp(option, "subset=", 7)) refuse("proc_subset");
        }
        must(*hidepid == 0 || observer_group_member(*proc_gid), "proc_hidden_tasks");
        found = true;
    }
    must(found, "proc_mount_missing");
}

static void exact_text(int directory, const char *path, const char *expected) {
    char data[4096];
    read_text_at(directory, path, data, sizeof(data));
    must(!strcmp(data, expected), "trace_state_changed");
}

static void stopped_bpf_controls(int trace_directory) {
    exact_text(trace_directory, "tracing_on", "0\n");
    exact_text(trace_directory, "current_tracer", "nop\n");
    exact_text(trace_directory, "events/enable", "X\n");
    exact_text(trace_directory, "set_event", "bpf_trace:bpf_trace_printk\n");
    exact_text(trace_directory, "buffer_subbuf_size_kb", "4\n");
}

static void json_string(const char *text) {
    putchar('"');
    for (const unsigned char *p = (const unsigned char *)text; *p; ++p) {
        if (*p == '"' || *p == '\\') { putchar('\\'); putchar(*p); }
        else if (*p == '\n') fputs("\\n", stdout);
        else if (*p == '\t') fputs("\\t", stdout);
        else if (*p >= 32 && *p <= 126) putchar(*p);
        else printf("\\u%04x", *p);
    }
    putchar('"');
}

int main(int argc, char **argv) {
    started_ns = monotonic_ns();
    signal(SIGALRM, alarm_exit); alarm(9);
    must(argc == 2 && (!strcmp(argv[1], "/sys/kernel/tracing")
                      || !strcmp(argv[1], "/sys/kernel/debug/tracing")), "literal_tracefs_root");
    observer_pid = getpid();
    must(getuid() == 0 && geteuid() == 0, "root_observer_required");
    failure_stage = "observer_identity";
    scan_proc_fd = open("/proc", O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    must(scan_proc_fd >= 0, "proc_open");
    exact_text(AT_FDCWD, "/sys/fs/selinux/enforce", "1");
    char context[128]; read_text_at(scan_proc_fd, "self/attr/current", context, sizeof(context));
    must(!strcmp(context, "u:r:su:s0") || !strcmp(context, "u:r:su:s0\n"), "observer_selinux_context");
    struct stat namespace_directory;
    must(fstatat(scan_proc_fd, "self/ns", &namespace_directory, 0) == 0 && S_ISDIR(namespace_directory.st_mode)
         && fstatat(scan_proc_fd, "1/ns", &namespace_directory, 0) == 0 && S_ISDIR(namespace_directory.st_mode),
         "observer_namespace_directory");
    /* Exact IKCONFIG (checked before execution) has PID_NS=n. These two literal
     * entries are consequently not compiled into procfs. This expected absence
     * is unrelated to the fail-closed task/FD scan: it never skips an ENOENT. */
    errno = 0;
    must(fstatat(scan_proc_fd, "self/ns/pid", &namespace_directory, 0) == -1 && errno == ENOENT,
         "unexpected_pid_namespace_support");
    errno = 0;
    must(fstatat(scan_proc_fd, "1/ns/pid", &namespace_directory, 0) == -1 && errno == ENOENT,
         "unexpected_pid_namespace_support");
    unsigned hidepid = UINT_MAX, proc_gid = UINT_MAX;
    proc_visibility(&hidepid, &proc_gid);
    int trace_directory = open(argv[1], O_RDONLY | O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW);
    must(trace_directory >= 0, "tracefs_directory");
    struct stat trace_stat, marker_stat; struct statfs trace_fs;
    must(fstat(trace_directory, &trace_stat) == 0 && fstatfs(trace_directory, &trace_fs) == 0
         && trace_fs.f_type == TRACEFS_MAGIC
         && fstatat(trace_directory, "trace_marker", &marker_stat, 0) == 0
         && marker_stat.st_dev == trace_stat.st_dev && S_ISREG(marker_stat.st_mode), "tracefs_identity");
    trace_dev = (uint64_t)trace_stat.st_dev; marker_ino = (uint64_t)marker_stat.st_ino;
    /* Exact kernel tracefs uses get_tree_single: aliases and detached mounts
     * share this superblock dev. We classify metadata, never mountinfo paths. */
    stopped_bpf_controls(trace_directory);
    Inventory *inventory = calloc(1, sizeof(*inventory));
    must(inventory != NULL, "allocation");
    initial_inventory(inventory);
    failure_stage = "descriptor_pass_one";
    for (size_t i = 0; i < inventory->table_count; ++i) scan_table(inventory, i, false);
    failure_stage = "task_inventory_middle"; verify_inventory(inventory);
    failure_stage = "descriptor_pass_two";
    for (size_t i = 0; i < inventory->table_count; ++i) scan_table(inventory, i, true);
    failure_stage = "task_inventory_after"; verify_inventory(inventory);
    failure_pid = failure_tid = 0; failure_fd = -1;
    failure_stage = "rcu_barrier";
    stopped_bpf_controls(trace_directory);
    exact_text(AT_FDCWD, "/sys/devices/system/cpu/possible", "0-1\n");
    exact_text(AT_FDCWD, "/sys/devices/system/cpu/present", "0-1\n");
    exact_text(AT_FDCWD, "/sys/devices/system/cpu/online", "0-1\n");
    long query = syscall(SYS_membarrier, MEMBARRIER_QUERY_VALUE, 0, 0);
    must(query >= 0 && (query & MEMBARRIER_GLOBAL_VALUE), "membarrier_global_unsupported");
    must(syscall(SYS_membarrier, MEMBARRIER_GLOBAL_VALUE, 0, 0) == 0, "membarrier_global_failed");
    bounded();
    stopped_bpf_controls(trace_directory);
    exact_text(AT_FDCWD, "/sys/devices/system/cpu/possible", "0-1\n");
    exact_text(AT_FDCWD, "/sys/devices/system/cpu/present", "0-1\n");
    exact_text(AT_FDCWD, "/sys/devices/system/cpu/online", "0-1\n");
    char stats[2][4096];
    for (int cpu = 0; cpu < 2; ++cpu) {
        char name[64]; snprintf(name, sizeof(name), "per_cpu/cpu%d/stats", cpu);
        read_text_at(trace_directory, name, stats[cpu], sizeof(stats[cpu]));
    }
    stopped_bpf_controls(trace_directory);
    bounded();
    printf("{\"schemaVersion\":2,\"passed\":true,\"uid\":0,\"selinuxEnforcing\":true,"
           "\"selinuxContext\":\"u:r:su:s0\",\"pidNamespacesCompiledOut\":true,"
           "\"procHidepid\":%u,\"procGid\":%u,\"procVisibilityVerified\":true,"
           "\"processes\":%zu,\"threads\":%zu,\"uniqueTables\":%zu,"
           "\"sharedThreads\":%zu,\"kcmpDeniedFullScans\":%zu,"
           "\"descriptorCounts\":[%zu,%zu],\"descriptorMetadataReads\":[%zu,%zu],"
           "\"descriptorReconciliations\":%zu,\"markerWriters\":%zu,\"passes\":2,"
           "\"stableTracefsProjection\":true,"
           "\"nonTraceComparisonDifferences\":{"
           "\"withinPass\":{\"added\":%zu,\"removed\":%zu,\"replaced\":%zu},"
           "\"betweenPass\":{\"added\":%zu,\"removed\":%zu,\"replaced\":%zu}},"
           "\"stableTaskInventories\":3,\"unknownDescriptors\":0,\"forbiddenTracefsDescriptors\":0,"
           "\"membarrier\":{\"query\":%ld,\"command\":1,\"flags\":0,\"result\":0,\"calls\":1},"
           "\"cpuPossible\":\"0-1\",\"cpuPresent\":\"0-1\",\"cpuOnline\":\"0-1\","
           "\"cpuStatsAfterBarrier\":[",
           hidepid, proc_gid, inventory->process_count, inventory->task_count, inventory->table_count,
           inventory->shared, inventory->kcmp_denied,
           inventory->descriptors[0], inventory->descriptors[1],
           inventory->metadata_reads[0], inventory->metadata_reads[1],
           inventory->reconciliations, inventory->markers,
           inventory->within_pass.added, inventory->within_pass.removed, inventory->within_pass.replaced,
           inventory->between_pass.added, inventory->between_pass.removed, inventory->between_pass.replaced, query);
    json_string(stats[0]); putchar(','); json_string(stats[1]);
    printf("],\"elapsedNs\":%" PRIu64 ",\"deadlineNs\":%" PRIu64 ","
           "\"tracefsWritten\":false,\"foreignDescriptorsOpened\":false,\"tracePayloadRead\":false}\n",
           monotonic_ns() - started_ns, DEADLINE_NS);
    return 0;
}
