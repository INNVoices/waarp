#!/usr/bin/env python3
"""Host-only synthetic /proc fixtures. No ADB, tracefs or membarrier syscall."""
import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

SOURCE = Path(__file__).with_name("android-ftrace-observer.c").resolve()
DRIVER = r'''
#define _GNU_SOURCE
#include <dirent.h>
#include <sys/types.h>
static ssize_t fixture_read(int descriptor, void *buffer, size_t size);
#define read fixture_read
#define WAARP_OBSERVER_TEST
#define syscall fixture_syscall
#define getgroups fixture_getgroups
#define main observer_main
#include "SOURCE_PATH"
#undef main
#undef syscall
#undef getgroups
#undef read
extern ssize_t read(int descriptor, void *buffer, size_t size);
#include <stdarg.h>
static int fixture_mode;
static const char *fixture_case;
static unsigned fixture_bpf_streams;
static int fixture_iterator_read_fd = -1;
static bool fixture_partial_read;
static unsigned fixture_new_kcmp_calls;
static bool fixture_new_unshared;
static void move_pending_task(int tid) {
    char source[64], destination[64];
    snprintf(source, sizeof(source), "pending-task-%d", tid);
    snprintf(destination, sizeof(destination), "111/task/%d", tid);
    must(renameat(scan_proc_fd, source, scan_proc_fd, destination) == 0, "fixture_move_task");
}
static void replace_start(int tid) {
    char source[64], destination[64];
    snprintf(source, sizeof(source), "pending-stat-%d", tid);
    snprintf(destination, sizeof(destination), "111/task/%d/stat", tid);
    must(renameat(scan_proc_fd, source, scan_proc_fd, destination) == 0, "fixture_replace_start");
}
static void move_pending(int number, bool info) {
    char source[64], destination[64];
    snprintf(source, sizeof(source), "pending-fd-%d", number);
    snprintf(destination, sizeof(destination), "111/task/111/fd/%d", number);
    must(renameat(scan_proc_fd, source, scan_proc_fd, destination) == 0, "fixture_move_fd");
    if (info) {
        snprintf(source, sizeof(source), "pending-info-%d", number);
        snprintf(destination, sizeof(destination), "111/task/111/fdinfo/%d", number);
        must(renameat(scan_proc_fd, source, scan_proc_fd, destination) == 0, "fixture_move_info");
    }
}
static ssize_t fixture_read(int descriptor, void *buffer, size_t size) {
    if (descriptor == fixture_iterator_read_fd && !fixture_partial_read
        && !strcmp(fixture_case, "bpf-prefetch-fragment")) {
        fixture_partial_read = true; size = 4095;
    }
    return read(descriptor, buffer, size);
}
static int fixture_bpf_link(const union bpf_attr *attr) {
    const union bpf_iter_link_info *info = (const void *)(uintptr_t)attr->link_create.iter_info;
    must(attr->link_create.prog_fd == (unsigned)iterator_program_fd
         && attr->link_create.attach_type == BPF_TRACE_ITER && !attr->link_create.flags
         && attr->link_create.iter_info_len == sizeof(*info) && !info->task.pid && !info->task.pid_fd,
         "fixture_exact_tid_attach");
    int tid = (int)info->task.tid, pid = tid == 999 ? 999 : 111;
    char task_path[64]; snprintf(task_path, sizeof(task_path), "%d/task/%d", pid, tid);
    int task = openat(scan_proc_fd, task_path, O_RDONLY | O_DIRECTORY);
    int fds = openat(task, "fd", O_RDONLY | O_DIRECTORY);
    must(task >= 0 && fds >= 0, "fixture_bpf_task");
    if (!strcmp(fixture_case, "reconcile-disappear") && fixture_bpf_streams == 1)
        must(unlinkat(fds, "5", 0) == 0, "fixture_remove_B_before_S2");
    if (!strcmp(fixture_case, "reconcile-extra") && fixture_bpf_streams == 1) move_pending(6, true);
    Numbers numbers = numeric_entries(fds, ".", MAX_FDS);
    int output = openat(scan_proc_fd, "fixture-bpf-stream", O_CREAT | O_TRUNC | O_RDWR, 0600);
    must(output >= 0, "fixture_bpf_output");
    fixture_bpf_streams++;
    uint64_t session = fixture_bpf_streams;
    for (size_t i = 0; i < numbers.n; ++i) {
        char path[64], data[256]; struct stat st;
        snprintf(path, sizeof(path), "%d", numbers.v[i]);
        must(fstatat(fds, path, &st, 0) == 0, "fixture_bpf_stat");
        snprintf(path, sizeof(path), "fdinfo/%d", numbers.v[i]);
        read_text_at(task, path, data, sizeof(data));
        unsigned long long flags; long long pos;
        must(sscanf(data, "pos:\t%lld\nflags:\t%llo", &pos, &flags) == 2, "fixture_bpf_flags");
        struct WaarpBpfRecord row = { .magic = WAARP_BPF_RECORD_MAGIC, .version = 1, .kind = 1,
            .session = session, .sequence = i, .inode = st.st_ino, .tgid = (u32)pid, .tid = (u32)tid,
            .fd = (u32)numbers.v[i], .device_major = major(st.st_dev), .device_minor = minor(st.st_dev),
            .file_status_flags = (u32)(flags & ~O_CLOEXEC), .file_type = st.st_mode & S_IFMT };
        if (!strcmp(fixture_case, "bpf-error")
            || (!strcmp(fixture_case, "reconcile-unknown") && fixture_bpf_streams == 2)) {
            row.kind = 3; row.error = 2;
        }
        if (!strcmp(fixture_case, "bpf-foreign")) row.tid++;
        if (!strcmp(fixture_case, "bpf-session") && i == 1) row.session++;
        if (!strcmp(fixture_case, "bpf-sequence") && i == 1) row.sequence++;
        if (!strcmp(fixture_case, "bpf-duplicate") && i == 1) row.fd--;
        if (!strcmp(fixture_case, "bpf-trace-mismatch")) row.inode++;
        must(write(output, &row, sizeof(row)) == sizeof(row), "fixture_bpf_write");
    }
    struct WaarpBpfRecord end = { .magic = WAARP_BPF_RECORD_MAGIC, .version = 1, .kind = 2,
        .session = session, .sequence = numbers.n ? numbers.n - 1 : 0 };
    if (!strncmp(fixture_case, "bpf-prefetch", 12)) end.sequence = numbers.n;
    if (!strcmp(fixture_case, "bpf-prefetch-too-far")) end.sequence++;
    if (strcmp(fixture_case, "bpf-no-end")) {
        size_t bytes = sizeof(end) - (!strcmp(fixture_case, "bpf-truncated") ? 1 : 0);
        must(write(output, &end, bytes) == (ssize_t)bytes, "fixture_bpf_end");
        if (!strcmp(fixture_case, "bpf-after-end"))
            must(write(output, &end, sizeof(end)) == sizeof(end), "fixture_bpf_duplicate_end");
    }
    if ((!strcmp(fixture_case, "nontrace-disappear") || !strcmp(fixture_case, "tracefs-disappear"))
        && fixture_bpf_streams == 1)
        must(unlinkat(fds, "3", 0) == 0, "fixture_bpf_remove_after_reference");
    if (!strncmp(fixture_case, "reconcile-", 10)) {
        if (fixture_bpf_streams == 1) move_pending(5, true);
        if (!strcmp(fixture_case, "reconcile-second-change") && fixture_bpf_streams == 2) move_pending(6, true);
    }
    free(numbers.v);
    must(close(task) == 0 && close(fds) == 0 && lseek(output, 0, SEEK_SET) == 0, "fixture_bpf_rewind");
    return output;
}
long fixture_syscall(long number, ...) {
    if (number == SYS_bpf) {
        va_list args; va_start(args, number);
        int command = va_arg(args, int); const union bpf_attr *attr = va_arg(args, const union bpf_attr *);
        va_end(args);
        if (command == BPF_PROG_LOAD) {
            must(attr->prog_type == BPF_PROG_TYPE_TRACING && attr->expected_attach_type == BPF_TRACE_ITER
                 && attr->attach_btf_id == ATTACH_BTF_ID && !attr->prog_btf_fd && !attr->func_info_cnt
                 && !attr->line_info_cnt && !attr->prog_flags, "fixture_load_attributes");
            if (!strcmp(fixture_case, "load-denied")) { errno = EPERM; return -1; }
            return open("/dev/null", O_RDONLY);
        }
        if (command == BPF_LINK_CREATE) {
            if (!strcmp(fixture_case, "bpf-link-denied")) { errno = EPERM; return -1; }
            return fixture_bpf_link(attr);
        }
        if (command == BPF_ITER_CREATE) {
            if (!strcmp(fixture_case, "bpf-read-error"))
                return openat(scan_proc_fd, "fixture-bpf-stream", O_WRONLY);
            fixture_iterator_read_fd = dup((int)attr->iter_create.link_fd);
            return fixture_iterator_read_fd;
        }
        errno = ENOSYS; return -1;
    }
    if (number != SYS_kcmp) { errno = ENOSYS; return -1; }
    va_list arguments; va_start(arguments, number);
    int first = va_arg(arguments, int), second = va_arg(arguments, int);
    va_end(arguments);
    if (!strcmp(fixture_case, "initial-post-kcmp-missing") && first == 112 && second == 111)
        must(unlinkat(scan_proc_fd, "111/task/112/stat", 0) == 0, "fixture_remove_post_kcmp_stat");
    if (!strcmp(fixture_case, "initial-kcmp-missing") && first == 112 && second == 111) {
        errno = ESRCH; return -1;
    }
    if (first == 113 || second == 113) {
        fixture_new_kcmp_calls++;
        if (!strcmp(fixture_case, "new-denied")) { errno = EPERM; return -1; }
        if (!strcmp(fixture_case, "new-missing-kcmp")) { errno = ESRCH; return -1; }
        if (!strcmp(fixture_case, "new-unique") || fixture_new_unshared
            || (!strcmp(fixture_case, "new-final-unshare") && fixture_new_kcmp_calls == 3)) return 1;
        if (!strcmp(fixture_case, "new-start-change") && fixture_new_kcmp_calls == 1) replace_start(113);
        if (!strcmp(fixture_case, "new-during-verification") && fixture_new_kcmp_calls == 1) move_pending_task(114);
    }
    if (fixture_mode == 2) { errno = EPERM; return -1; }
    return fixture_mode == 1 ? 1 : 0;
}
int fixture_getgroups(int size, gid_t groups[]) { (void)size; (void)groups; return 0; }
int main(int argc, char **argv) {
    if (argc != 4) return 2;
    started_ns = monotonic_ns();
    observer_pid = INT_MAX;
    fixture_case = argv[1];
    scan_proc_fd = open(argv[2], O_RDONLY | O_DIRECTORY);
    must(scan_proc_fd >= 0, "fixture_open");
    if (!strcmp(argv[1], "group")) {
        printf("{\"member\":%s}\n", observer_group_member((unsigned)atoi(argv[3])) ? "true" : "false");
        return 0;
    }
    fixture_mode = atoi(argv[3]);
    if (!strncmp(argv[1], "load", 4)) {
        load_iterator_program();
        must(close(iterator_program_fd) == 0, "fixture_program_close");
        printf("{\"passed\":true,\"capabilities\":%llu}\n", (unsigned long long)observer_capabilities);
        return 0;
    }
    iterator_program_fd = open("/dev/null", O_RDONLY);
    if (!strcmp(argv[1], "compare")) {
        trace_dev = 100;
        Descriptor before = {3, 10, 1000, S_IFREG, O_RDONLY}, after = before;
        size_t before_count = 1, after_count = 1;
        if (fixture_mode == 0) { after.dev = 11; after.ino = 2000; }
        if (fixture_mode == 1) before.dev = trace_dev;
        if (fixture_mode == 2) after.dev = trace_dev;
        if (fixture_mode == 3) { before.dev = after.dev = trace_dev; after.flags = O_WRONLY; }
        if (fixture_mode == 4) { before.dev = trace_dev; after_count = 0; }
        if (fixture_mode == 5) { after.dev = trace_dev; before_count = 0; }
        if (fixture_mode == 6) before.dev = after.dev = trace_dev;
        if (fixture_mode == 7) after.number = 4;
        Differences differences = {0};
        compare_samples(&before, before_count, &after, after_count, &differences);
        printf("{\"passed\":true,\"added\":%zu,\"removed\":%zu,\"replaced\":%zu}\n",
               differences.added, differences.removed, differences.replaced);
        return 0;
    }
    if (!strcmp(argv[1], "metadata")) {
        int task = openat(scan_proc_fd, "111/task/111", O_RDONLY | O_DIRECTORY);
        int fds = openat(task, "fd", O_RDONLY | O_DIRECTORY);
        struct stat marker; must(fstatat(scan_proc_fd, "marker", &marker, 0) == 0, "fixture_marker");
        trace_dev = marker.st_dev; marker_ino = marker.st_ino;
        Descriptor result = descriptor_metadata(fds, task, 3);
        printf("{\"passed\":true,\"ino\":%" PRIu64 "}\n", result.ino);
        return 0;
    }
    trace_dev = UINT64_MAX; marker_ino = UINT64_MAX;
    struct stat watched;
    must(fstatat(scan_proc_fd, "111/task/111/fd", &watched, 0) == 0, "fixture_watch");
    if (!strcmp(argv[1], "bpf-add-marker") || !strcmp(argv[1], "bpf-add-reader")
        || !strcmp(argv[1], "bpf-add-control") || !strcmp(argv[1], "tracefs-disappear")
        || !strcmp(argv[1], "bpf-trace-mismatch") || !strcmp(argv[1], "bpf-trace-flags")) {
        must(fstatat(scan_proc_fd, "marker", &watched, 0) == 0, "fixture_marker");
        trace_dev = watched.st_dev; marker_ino = watched.st_ino;
    }
    Inventory *inventory = calloc(1, sizeof(*inventory));
    initial_inventory(inventory);
    for (size_t i = 0; i < inventory->table_count; ++i) scan_table(inventory, i, false);
    if (!strncmp(argv[1], "new-", 4) && strcmp(argv[1], "new-process")
        && strcmp(argv[1], "new-final") && strcmp(argv[1], "new-final-unshare")) move_pending_task(113);
    if (!strcmp(argv[1], "new-process"))
        must(renameat(scan_proc_fd, "pending-pid-888", scan_proc_fd, "888") == 0, "fixture_move_process");
    if (!strcmp(argv[1], "old-thread-missing"))
        must(renameat(scan_proc_fd, "111/task/112", scan_proc_fd, "removed-task-112") == 0, "fixture_remove_task");
    if (!strcmp(argv[1], "old-start-change")) replace_start(112);
    if (!strcmp(argv[1], "new-cap")) inventory->task_count = MAX_TASKS;
    if (!strcmp(argv[1], "unshare")) fixture_mode = 1;
    if (!strcmp(argv[1], "disappear")) {
        int d = inventory->processes[0].directory;
        must(unlinkat(d, "task/111/stat", 0) == 0, "fixture_remove");
    }
    if (!strcmp(argv[1], "fd-change")) {
        int d = inventory->processes[0].directory;
        must(unlinkat(d, "task/111/fd/3", 0) == 0, "fixture_remove");
    }
    if (!strcmp(argv[1], "fd-replace")) move_pending(3, true);
    if (!strncmp(argv[1], "bpf-add", 7)) move_pending(5, true);
    verify_inventory(inventory);
    for (size_t i = 0; i < inventory->table_count; ++i) scan_table(inventory, i, true);
    if (!strcmp(argv[1], "new-final") || !strcmp(argv[1], "new-final-unshare")) move_pending_task(113);
    if (!strcmp(argv[1], "new-disappear-final"))
        must(renameat(scan_proc_fd, "111/task/113", scan_proc_fd, "removed-task-113") == 0, "fixture_remove_task");
    if (!strcmp(argv[1], "new-reuse-final")) replace_start(113);
    if (!strcmp(argv[1], "new-unshare-final")) fixture_new_unshared = true;
    verify_inventory(inventory);
    printf("{\"passed\":true,\"processes\":%zu,\"threads\":%zu,\"tables\":%zu,"
           "\"shared\":%zu,\"denied\":%zu,\"fds\":[%zu,%zu],"
           "\"streams\":[%zu,%zu],\"prefetch\":[%zu,%zu],\"between\":[%zu,%zu,%zu],"
           "\"reconciliations\":%zu,\"within\":[%zu,%zu,%zu],\"reads\":[%zu,%zu],"
           "\"threadCounts\":[%zu,%zu,%zu],\"sharedAdded\":[%zu,%zu],\"newKcmpCalls\":%u,"
           "\"elapsedNs\":%" PRIu64 "}\n",
           inventory->process_count, inventory->task_count, inventory->table_count,
           inventory->shared, inventory->kcmp_denied, inventory->descriptors[0], inventory->descriptors[1],
           inventory->streams[0], inventory->streams[1], inventory->prefetch_ends[0], inventory->prefetch_ends[1],
           inventory->between_pass.added, inventory->between_pass.removed, inventory->between_pass.replaced,
           inventory->reconciliations, inventory->within_pass.added, inventory->within_pass.removed,
           inventory->within_pass.replaced, inventory->bpf_records[0], inventory->bpf_records[1],
           inventory->thread_counts[0], inventory->thread_counts[1], inventory->thread_counts[2],
           inventory->shared_added[0], inventory->shared_added[1], fixture_new_kcmp_calls,
           monotonic_ns() - started_ns);
    return 0;
}
'''


def compile_fixture(arguments):
    try:
        subprocess.run(arguments, capture_output=True, timeout=20, check=True)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        # CalledProcessError's traceback omits captured output. Keep the original
        # refusal and expose a bounded diagnostic without changing compiler flags.
        for label, data in (("stdout", error.stdout), ("stderr", error.stderr)):
            if not data:
                continue
            raw = data.encode("utf-8") if isinstance(data, str) else data
            limit = 16384
            print(f"Host fixture compiler {label} ({len(raw)} bytes):", file=sys.stderr)
            if len(raw) > limit:
                part = limit // 2
                raw = raw[:part] + f"\n[omitted {len(raw) - limit} bytes]\n".encode() + raw[-part:]
            print(raw.decode("utf-8", errors="replace"), file=sys.stderr)
        raise


class CompilerDiagnostics(unittest.TestCase):
    def test_compile_failure_keeps_original_error_and_bounds_both_streams(self):
        error = subprocess.CalledProcessError(1, ["cc"], output=b"first" + b"x" * 40000 + b"last",
                                             stderr=b"actual warning" + b"y" * 40000 + b"final diagnostic")
        captured = io.StringIO()
        with mock.patch.object(subprocess, "run", side_effect=error) as runner, contextlib.redirect_stderr(captured):
            with self.assertRaises(subprocess.CalledProcessError) as raised:
                compile_fixture(["cc", "-Werror"])
        self.assertIs(raised.exception, error)
        runner.assert_called_once_with(["cc", "-Werror"], capture_output=True, timeout=20, check=True)
        text = captured.getvalue()
        self.assertIn("actual warning", text)
        self.assertIn("final diagnostic", text)
        self.assertEqual(text.count("[omitted "), 2)
        self.assertLess(len(text), 33000)

    def test_compile_timeout_keeps_original_error_and_partial_diagnostic(self):
        error = subprocess.TimeoutExpired(["cc"], 20, stderr=b"partial compiler diagnostic")
        captured = io.StringIO()
        with mock.patch.object(subprocess, "run", side_effect=error), contextlib.redirect_stderr(captured):
            with self.assertRaises(subprocess.TimeoutExpired) as raised:
                compile_fixture(["cc"])
        self.assertIs(raised.exception, error)
        self.assertIn("partial compiler diagnostic", captured.getvalue())


class NativeMetadataChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.build = tempfile.TemporaryDirectory()
        directory = Path(cls.build.name)
        driver = directory / "driver.c"
        driver.write_text(DRIVER.replace("SOURCE_PATH", str(SOURCE)))
        cls.binary = directory / "observer-fixture"
        compile_fixture(["cc", "-O2", "-std=c11", "-Wall", "-Wextra", "-Werror", str(driver), "-o", str(cls.binary)])

    @classmethod
    def tearDownClass(cls):
        cls.build.cleanup()

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.marker = self.root / "marker"
        self.marker.write_text("PRIVATE_TARGET_CONTENT_MUST_NOT_BE_READ")

    def tearDown(self):
        self.temporary.cleanup()

    def task(self, pid, tid, descriptors=1, target=None, flags="0100001"):
        path = self.root / str(pid) / "task" / str(tid)
        (path / "fd").mkdir(parents=True)
        (path / "fdinfo").mkdir()
        fields = [str(tid), "(PRIVATE comm (with spaces))", "S"] + ["0"] * 18 + ["12345"] + ["0"] * 4
        (path / "stat").write_text(" ".join(fields) + "\n")
        target = target or self.marker
        inode = target.stat().st_ino
        for fd in range(3, 3 + descriptors):
            (path / "fd" / str(fd)).symlink_to(target)
            (path / "fdinfo" / str(fd)).write_text(
                f"pos:\t0\nflags:\t{flags}\nmnt_id:\t999999\nino:\t{inode}\nPRIVATE_DEVICE_METADATA\n")
        return path

    def two_processes(self, threads=2, descriptors=2):
        for tid in range(111, 111 + threads):
            self.task(111, tid, descriptors)
        self.task(999, 999, descriptors)

    def pending(self, number, target=None, flags="0100001", metadata=True):
        target = target or self.marker
        (self.root / f"pending-fd-{number}").symlink_to(target)
        if metadata:
            (self.root / f"pending-info-{number}").write_text(
                f"pos:\t0\nflags:\t{flags}\nmnt_id:\t999999\nino:\t{target.stat().st_ino}\n")

    def pending_thread(self, tid=113):
        path = self.task(111, tid, descriptors=2)
        path.rename(self.root / f"pending-task-{tid}")

    def changed_start(self, tid):
        fields = [str(tid), "(PRIVATE)", "S"] + ["0"] * 18 + ["54321"] + ["0"] * 4
        (self.root / f"pending-stat-{tid}").write_text(" ".join(fields) + "\n")

    def run_case(self, mode, kcmp=0, success=True):
        result = subprocess.run([str(self.binary), mode, str(self.root), str(kcmp)], capture_output=True, text=True, timeout=10)
        self.assertEqual(0 if success else 1, result.returncode, result.stdout + result.stderr)
        self.assertEqual("", result.stderr)
        self.assertNotIn("PRIVATE", result.stdout)
        return json.loads(result.stdout)

    def test_kcmp_deduplicates_only_confirmed_shared_tables(self):
        self.two_processes(threads=4)
        result = self.run_case("scan")
        self.assertEqual((2, 5, 2, 3), tuple(result[k] for k in ("processes", "threads", "tables", "shared")))

    def test_new_process_open_failure_does_not_report_previous_thread(self):
        self.two_processes()
        shutil.rmtree(self.root / "999")
        (self.root / "999").write_text("")
        result = self.run_case("scan", success=False)
        self.assertEqual("process_directory", result["reason"])
        self.assertEqual("task_inventory_before", result["stage"])
        self.assertEqual("none", result["context"])
        self.assertEqual((999, 0, -1), tuple(result[k] for k in ("pid", "tid", "fd")))

    def test_initial_task_stat_open_failure_has_first_read_context(self):
        self.two_processes()
        (self.root / "111/task/111/stat").unlink()
        result = self.run_case("scan", success=False)
        self.assertEqual(("metadata_open", "task_inventory_before", "initial_task_start"),
                         tuple(result[k] for k in ("reason", "stage", "context")))
        self.assertEqual((111, 111, -1, 2), tuple(result[k] for k in ("pid", "tid", "fd", "errno")))

    def test_initial_task_stat_open_failure_after_kcmp_has_recheck_context(self):
        self.two_processes()
        result = self.run_case("initial-post-kcmp-missing", success=False)
        self.assertEqual(("metadata_open", "task_inventory_before", "post_kcmp_task_start"),
                         tuple(result[k] for k in ("reason", "stage", "context")))
        self.assertEqual((111, 112, -1, 2), tuple(result[k] for k in ("pid", "tid", "fd", "errno")))

    def test_initial_read_context_is_cleared_before_kcmp(self):
        self.two_processes()
        result = self.run_case("initial-kcmp-missing", success=False)
        self.assertEqual(("kcmp_unknown_task", "task_inventory_before", "none"),
                         tuple(result[k] for k in ("reason", "stage", "context")))

    def test_kcmp_denied_scans_every_thread_table(self):
        self.two_processes(threads=4)
        result = self.run_case("scan", 2)
        self.assertEqual((5, 0, 3), tuple(result[k] for k in ("tables", "shared", "denied")))

    def test_unshared_thread_table_cannot_be_omitted(self):
        self.two_processes(threads=4)
        result = self.run_case("scan", 1)
        self.assertEqual(5, result["tables"])

    def test_unshare_after_deduplication_is_rejected(self):
        self.two_processes()
        self.assertEqual("shared_files_changed", self.run_case("unshare", success=False)["reason"])

    def test_new_thread_requires_positive_existing_table_coverage(self):
        self.two_processes(); self.pending_thread()
        result = self.run_case("new-shared")
        self.assertEqual([3, 4, 4], result["threadCounts"])
        self.assertEqual([1, 0], result["sharedAdded"])
        self.assertEqual(2, result["tables"])
        self.assertEqual(5, result["newKcmpCalls"])

    def test_final_phase_newcomer_is_checked_after_final_list(self):
        self.two_processes(); self.pending_thread()
        result = self.run_case("new-final")
        self.assertEqual([3, 3, 4], result["threadCounts"])
        self.assertEqual([0, 1], result["sharedAdded"])
        self.assertEqual(3, result["newKcmpCalls"])

    def test_final_newcomer_cannot_unshare_after_initial_binding(self):
        self.two_processes(); self.pending_thread()
        self.assertEqual("shared_files_changed", self.run_case("new-final-unshare", success=False)["reason"])

    def test_denied_missing_or_unique_new_table_is_not_omitted(self):
        self.two_processes()
        for case, expected in (("new-denied", "new_thread_kcmp_refused"),
                               ("new-missing-kcmp", "new_thread_kcmp_refused"),
                               ("new-unique", "new_thread_unique_table")):
            with self.subTest(case=case):
                self.pending_thread()
                self.assertEqual(expected, self.run_case(case, success=False)["reason"])
                shutil.rmtree(self.root / "111/task/113")

    def test_new_thread_start_must_remain_exact_during_binding(self):
        self.two_processes(); self.pending_thread(); self.changed_start(113)
        self.assertEqual("new_thread_start_changed", self.run_case("new-start-change", success=False)["reason"])

    def test_known_missing_member_is_distinct_from_start_change(self):
        self.two_processes()
        self.assertEqual("known_thread_missing", self.run_case("old-thread-missing", success=False)["reason"])

    def test_known_start_change_is_not_new_member_permission(self):
        self.two_processes(); self.changed_start(112)
        self.assertEqual("thread_start_changed", self.run_case("old-start-change", success=False)["reason"])

    def test_middle_newcomer_remains_mandatory_in_final(self):
        self.two_processes(); self.pending_thread()
        self.assertEqual("known_thread_missing", self.run_case("new-disappear-final", success=False)["reason"])

    def test_middle_newcomer_identity_cannot_be_reused(self):
        self.two_processes(); self.pending_thread(); self.changed_start(113)
        self.assertEqual("thread_start_changed", self.run_case("new-reuse-final", success=False)["reason"])

    def test_middle_newcomer_cannot_later_unshare_its_table(self):
        self.two_processes(); self.pending_thread()
        self.assertEqual("shared_files_changed", self.run_case("new-unshare-final", success=False)["reason"])

    def test_thread_list_change_during_observation_is_not_retried(self):
        self.two_processes(); self.pending_thread(); self.pending_thread(114)
        self.assertEqual("thread_list_changed_during_observation",
                         self.run_case("new-during-verification", success=False)["reason"])

    def test_new_process_remains_out_of_scope_even_with_shared_files(self):
        self.two_processes()
        self.task(888, 888)
        (self.root / "888").rename(self.root / "pending-pid-888")
        self.assertEqual("process_inventory_changed", self.run_case("new-process", success=False)["reason"])

    def test_cumulative_accepted_tasks_cannot_exceed_cap(self):
        self.two_processes(); self.pending_thread()
        self.assertEqual("task_limit", self.run_case("new-cap", success=False)["reason"])

    def test_disappearing_task_is_not_assumed_exited(self):
        self.two_processes()
        self.assertEqual("metadata_open", self.run_case("disappear", success=False)["reason"])

    def test_tracefs_disappearance_still_refuses_after_bpf_reference(self):
        self.two_processes()
        self.assertEqual("descriptor_stat", self.run_case("tracefs-disappear", success=False)["reason"])

    def test_referenced_nontrace_file_closure_is_still_classified(self):
        self.two_processes()
        result = self.run_case("nontrace-disappear")
        self.assertEqual([3, 3], result["fds"])
        self.assertEqual([0, 1, 0], result["within"])
        self.assertEqual(1, result["reconciliations"])
        self.assertEqual([3, 2], result["streams"])

    def test_classified_nontrace_removal_is_explicitly_counted(self):
        self.two_processes()
        result = self.run_case("fd-change")
        self.assertEqual([4, 3], result["fds"])
        self.assertEqual([0, 1, 0], result["between"])

    def test_nontrace_number_reuse_requires_fresh_current_identity(self):
        self.two_processes()
        replacement = self.root / "replacement"
        replacement.write_text("PRIVATE")
        self.pending(3, target=replacement)
        result = self.run_case("fd-replace")
        self.assertEqual([0, 0, 1], result["between"])

    def test_one_bounded_reconciliation_keeps_end_number_coverage(self):
        self.two_processes(); self.pending(5)
        result = self.run_case("reconcile-add")
        self.assertEqual([5, 5], result["fds"])
        self.assertEqual([7, 5], result["reads"])
        self.assertEqual([3, 2], result["streams"])
        self.assertEqual([1, 0, 0], result["within"])
        self.assertEqual(1, result["reconciliations"])

    def test_reconciliation_must_cover_every_number_in_B(self):
        self.two_processes(); self.pending(5)
        self.assertEqual("descriptor_reconciliation_coverage", self.run_case("reconcile-disappear", success=False)["reason"])

    def test_reconciliation_cannot_add_unrequested_numbers_or_repeat_until_stable(self):
        self.two_processes(); self.pending(5); self.pending(6)
        self.assertEqual("descriptor_reconciliation_coverage", self.run_case("reconcile-extra", success=False)["reason"])

    def test_final_C_must_equal_B_after_the_one_reconciliation(self):
        self.two_processes(); self.pending(5); self.pending(6)
        self.assertEqual("descriptor_reconciliation_changed", self.run_case("reconcile-second-change", success=False)["reason"])

    def test_reconciliation_unknown_metadata_is_not_skipped(self):
        self.two_processes(); self.pending(5)
        self.assertEqual("bpf_metadata_error", self.run_case("reconcile-unknown", success=False)["reason"])

    def test_one_ahead_end_cannot_follow_a_pending_partial_record(self):
        self.two_processes(descriptors=64)
        self.assertEqual("bpf_end_prefetch_boundary", self.run_case("bpf-prefetch-fragment", success=False)["reason"])

    def test_second_iterator_classifies_added_nontrace_descriptor(self):
        self.two_processes(); self.pending(5)
        result = self.run_case("bpf-add")
        self.assertEqual([4, 5], result["fds"])
        self.assertEqual([2, 2], result["streams"])
        self.assertEqual([1, 0, 0], result["between"])

    def test_kernel_metadata_error_is_never_silently_skipped(self):
        self.two_processes()
        self.assertEqual("bpf_metadata_error", self.run_case("bpf-error", success=False)["reason"])

    def test_missing_or_truncated_end_is_not_a_complete_inventory(self):
        self.two_processes()
        for name in ("bpf-no-end", "bpf-truncated"):
            with self.subTest(name=name):
                self.assertEqual("bpf_iterator_incomplete", self.run_case(name, success=False)["reason"])

    def test_iterator_read_error_is_not_retried(self):
        self.two_processes()
        self.assertEqual("bpf_iterator_read", self.run_case("bpf-read-error", success=False)["reason"])

    def test_denied_link_is_not_a_complete_inventory(self):
        self.two_processes()
        self.assertEqual("bpf_iterator_link", self.run_case("bpf-link-denied", success=False)["reason"])

    def test_wrong_tid_session_or_sequence_cannot_claim_coverage(self):
        self.two_processes()
        for name, reason in (("bpf-foreign", "bpf_record_target_or_sequence"),
                             ("bpf-session", "bpf_session_changed"),
                             ("bpf-sequence", "bpf_record_target_or_sequence"),
                             ("bpf-duplicate", "bpf_descriptor_order"),
                             ("bpf-after-end", "bpf_record_header")):
            with self.subTest(name=name): self.assertEqual(reason, self.run_case(name, success=False)["reason"])

    def test_tracefs_bpf_identity_must_match_strict_proc_metadata(self):
        self.two_processes()
        self.assertEqual("bpf_tracefs_identity_mismatch", self.run_case("bpf-trace-mismatch", success=False)["reason"])

    def test_cloexec_is_preserved_in_strict_tracefs_projection(self):
        for tid in (111, 112): self.task(111, tid, flags=oct(os.O_CLOEXEC | os.O_WRONLY | 0o100000)[2:])
        self.task(999, 999, flags=oct(os.O_CLOEXEC | os.O_WRONLY | 0o100000)[2:])
        self.assertTrue(self.run_case("bpf-trace-flags")["passed"])

    def test_one_ahead_end_requires_exact_full_read_prefetch_boundary(self):
        self.two_processes(descriptors=64)
        result = self.run_case("bpf-prefetch")
        self.assertEqual([2, 2], result["prefetch"])

    def test_one_ahead_end_after_short_read_is_refused(self):
        self.two_processes(descriptors=63)
        self.assertEqual("bpf_end_prefetch_boundary", self.run_case("bpf-prefetch", success=False)["reason"])

    def test_one_ahead_end_after_new_data_in_current_read_is_refused(self):
        self.two_processes(descriptors=65)
        self.assertEqual("bpf_end_prefetch_boundary", self.run_case("bpf-prefetch", success=False)["reason"])

    def test_end_more_than_one_ahead_is_refused(self):
        self.two_processes(descriptors=64)
        self.assertEqual("bpf_end_sequence", self.run_case("bpf-prefetch-too-far", success=False)["reason"])

    def test_empty_table_ends_at_zero(self):
        self.two_processes(descriptors=0)
        self.assertEqual([0, 0], self.run_case("scan")["fds"])
        self.assertEqual("bpf_end_sequence", self.run_case("bpf-prefetch-too-far", success=False)["reason"])

    def capability_status(self, caps="0000000000200000", seccomp="0"):
        (self.root / "self").mkdir(exist_ok=True)
        (self.root / "self/status").write_text(f"Name:\tPRIVATE\nCapEff:\t{caps}\nSeccomp:\t{seccomp}\n")

    def test_actual_capability_and_seccomp_gates_before_single_program_load(self):
        self.capability_status()
        self.assertTrue(self.run_case("load")["passed"])
        self.capability_status(caps="000000c000000000")
        self.assertTrue(self.run_case("load")["passed"])
        for mask in ("0000000000000000", "0000008000000000", "0000004000000000"):
            self.capability_status(caps=mask)
            self.assertEqual("observer_bpf_capabilities", self.run_case("load", success=False)["reason"])
        self.capability_status(seccomp="2")
        self.assertEqual("observer_seccomp_unknown_filter", self.run_case("load", success=False)["reason"])

    def test_failed_program_load_does_not_proceed_to_enumeration(self):
        self.capability_status()
        self.assertEqual("bpf_program_load", self.run_case("load-denied", success=False)["reason"])

    def test_added_marker_changes_observed_tracefs_projection(self):
        self.two_processes(); self.pending(5)
        self.assertEqual("tracefs_projection_changed", self.run_case("bpf-add-marker", success=False)["reason"])

    def test_added_trace_reader_cannot_use_nontrace_classification(self):
        self.two_processes(); self.pending(5, flags="0100000")
        self.assertEqual("tracefs_consumer_or_control", self.run_case("bpf-add-reader", success=False)["reason"])

    def test_added_trace_control_cannot_use_nontrace_classification(self):
        self.two_processes()
        control = self.root / "control"
        control.write_text("PRIVATE")
        self.pending(5, target=control)
        self.assertEqual("tracefs_consumer_or_control", self.run_case("bpf-add-control", success=False)["reason"])

    def test_any_tracefs_side_of_a_comparison_is_protected(self):
        for case in (1, 2, 3, 4, 5):
            with self.subTest(case=case):
                self.assertEqual("tracefs_projection_changed", self.run_case("compare", case, success=False)["reason"])
        self.assertTrue(self.run_case("compare", 6)["passed"])

    def test_nontrace_comparison_counts_are_not_unique_os_mutations(self):
        self.assertEqual(1, self.run_case("compare", 0)["replaced"])
        result = self.run_case("compare", 7)
        self.assertEqual((1, 1, 0), (result["added"], result["removed"], result["replaced"]))

    def test_unknown_mount_id_still_classifies_tracefs_by_inode_device(self):
        self.task(111, 111)
        self.assertTrue(self.run_case("metadata")["passed"])

    def test_alias_of_trace_reader_is_rejected(self):
        other = self.root / "trace_pipe_alias"
        other.write_text("PRIVATE")
        self.task(111, 111, target=other, flags="0100000")
        self.assertEqual("tracefs_consumer_or_control", self.run_case("metadata", success=False)["reason"])

    def test_readwrite_marker_is_not_writeonly_permission(self):
        self.task(111, 111, flags="0100002")
        self.assertEqual("tracefs_consumer_or_control", self.run_case("metadata", success=False)["reason"])

    def test_mismatched_fdinfo_inode_is_rejected(self):
        task = self.task(111, 111)
        info = task / "fdinfo/3"
        info.write_text("pos:\t0\nflags:\t0100001\nmnt_id:\t1\nino:\t1\n")
        self.assertEqual("descriptor_identity_changed", self.run_case("metadata", success=False)["reason"])

    def test_real_gid_alone_is_not_proc_visibility_bypass(self):
        (self.root / "self").mkdir()
        (self.root / "self/status").write_text("Name:\tPRIVATE\nGid:\t3009\t3009\t3009\t0\n")
        self.assertFalse(self.run_case("group", 3009)["member"])

    def test_actual_fsgid_is_proc_visibility_bypass(self):
        (self.root / "self").mkdir()
        (self.root / "self/status").write_text("Name:\tPRIVATE\nGid:\t0\t0\t0\t3009\n")
        self.assertTrue(self.run_case("group", 3009)["member"])

    def test_missing_gid_line_refuses_before_group_value_is_used(self):
        (self.root / "self").mkdir()
        (self.root / "self/status").write_text("Name:\tPRIVATE\nUid:\t0\t0\t0\t0\n")
        self.assertEqual("observer_fsgid", self.run_case("group", 3009, success=False)["reason"])

    def test_incomplete_gid_line_refuses_before_group_value_is_used(self):
        (self.root / "self").mkdir()
        (self.root / "self/status").write_text("Name:\tPRIVATE\nGid:\t0\t0\t0\n")
        self.assertEqual("observer_fsgid", self.run_case("group", 3009, success=False)["reason"])


if __name__ == "__main__":
    unittest.main()
