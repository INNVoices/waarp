#!/usr/bin/env python3
"""Host-only synthetic /proc fixtures. No ADB, tracefs or membarrier syscall."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

SOURCE = Path(__file__).with_name("android-ftrace-observer.c").resolve()
DRIVER = r'''
#define _GNU_SOURCE
#include <dirent.h>
static int fixture_closedir(DIR *stream);
#define closedir fixture_closedir
#define syscall fixture_syscall
#define getgroups fixture_getgroups
#define main observer_main
#include "SOURCE_PATH"
#undef main
#undef syscall
#undef getgroups
#undef closedir
#include <stdarg.h>
static int fixture_mode;
static const char *fixture_case;
static ino_t fixture_fd_inode;
static dev_t fixture_fd_dev;
static unsigned fixture_fd_lists;
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
static int fixture_closedir(DIR *stream) {
    struct stat info;
    bool target = fstat(dirfd(stream), &info) == 0
                  && info.st_dev == fixture_fd_dev && info.st_ino == fixture_fd_inode;
    int result = closedir(stream);
    if (result || !target) return result;
    fixture_fd_lists++;
    if (!strcmp(fixture_case, "unclassified-disappear") && fixture_fd_lists == 1)
        must(unlinkat(scan_proc_fd, "111/task/111/fd/3", 0) == 0, "fixture_remove");
    if (!strncmp(fixture_case, "reconcile", 9)) {
        if (fixture_fd_lists == 1) move_pending(5, strcmp(fixture_case, "reconcile-unclassified") != 0);
        if (fixture_fd_lists == 2 && !strcmp(fixture_case, "reconcile-second-change")) move_pending(6, true);
        if (fixture_fd_lists == 2 && !strcmp(fixture_case, "reconcile-disappear"))
            must(unlinkat(scan_proc_fd, "111/task/111/fd/5", 0) == 0, "fixture_remove");
    }
    return result;
}
long fixture_syscall(long number, ...) {
    if (number != SYS_kcmp) { errno = ENOSYS; return -1; }
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
    fixture_fd_dev = watched.st_dev; fixture_fd_inode = watched.st_ino;
    if (!strcmp(argv[1], "reconcile-marker") || !strcmp(argv[1], "reconcile-reader")
        || !strcmp(argv[1], "reconcile-control")) {
        must(fstatat(scan_proc_fd, "marker", &watched, 0) == 0, "fixture_marker");
        trace_dev = watched.st_dev; marker_ino = watched.st_ino;
    }
    Inventory *inventory = calloc(1, sizeof(*inventory));
    initial_inventory(inventory);
    for (size_t i = 0; i < inventory->table_count; ++i) scan_table(inventory, i, false);
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
    verify_inventory(inventory);
    for (size_t i = 0; i < inventory->table_count; ++i) scan_table(inventory, i, true);
    verify_inventory(inventory);
    printf("{\"passed\":true,\"processes\":%zu,\"threads\":%zu,\"tables\":%zu,"
           "\"shared\":%zu,\"denied\":%zu,\"fds\":[%zu,%zu],\"reads\":[%zu,%zu],"
           "\"reconciliations\":%zu,\"within\":[%zu,%zu,%zu],\"between\":[%zu,%zu,%zu],"
           "\"elapsedNs\":%" PRIu64 "}\n",
           inventory->process_count, inventory->task_count, inventory->table_count,
           inventory->shared, inventory->kcmp_denied, inventory->descriptors[0], inventory->descriptors[1],
           inventory->metadata_reads[0], inventory->metadata_reads[1], inventory->reconciliations,
           inventory->within_pass.added, inventory->within_pass.removed, inventory->within_pass.replaced,
           inventory->between_pass.added, inventory->between_pass.removed, inventory->between_pass.replaced,
           monotonic_ns() - started_ns);
    return 0;
}
'''


class NativeMetadataChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.build = tempfile.TemporaryDirectory()
        directory = Path(cls.build.name)
        driver = directory / "driver.c"
        driver.write_text(DRIVER.replace("SOURCE_PATH", str(SOURCE)))
        cls.binary = directory / "observer-fixture"
        subprocess.run(["cc", "-O2", "-std=c11", "-Wall", "-Wextra", "-Werror", str(driver), "-o", str(cls.binary)],
                       capture_output=True, timeout=20, check=True)

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

    def test_disappearing_task_is_not_assumed_exited(self):
        self.two_processes()
        self.assertEqual("metadata_open", self.run_case("disappear", success=False)["reason"])

    def test_unclassified_descriptor_disappearance_still_refuses(self):
        self.two_processes()
        self.assertEqual("descriptor_stat", self.run_case("unclassified-disappear", success=False)["reason"])

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

    def test_one_complete_reconciliation_classifies_new_nontrace_descriptor(self):
        self.two_processes(); self.pending(5)
        result = self.run_case("reconcile")
        self.assertEqual([5, 5], result["fds"])
        self.assertEqual([7, 5], result["reads"])
        self.assertEqual(1, result["reconciliations"])
        self.assertEqual([1, 0, 0], result["within"])

    def test_reconciliation_refuses_new_descriptor_without_metadata(self):
        self.two_processes(); self.pending(5, metadata=False)
        self.assertEqual("descriptor_info_open", self.run_case("reconcile-unclassified", success=False)["reason"])

    def test_reconciliation_refuses_descriptor_disappearing_before_metadata(self):
        self.two_processes(); self.pending(5)
        self.assertEqual("descriptor_stat", self.run_case("reconcile-disappear", success=False)["reason"])

    def test_second_inventory_change_is_not_retried(self):
        self.two_processes(); self.pending(5); self.pending(6)
        self.assertEqual("descriptor_reconciliation_changed",
                         self.run_case("reconcile-second-change", success=False)["reason"])

    def test_added_marker_changes_observed_tracefs_projection(self):
        self.two_processes(); self.pending(5)
        self.assertEqual("tracefs_projection_changed", self.run_case("reconcile-marker", success=False)["reason"])

    def test_added_trace_reader_cannot_use_nontrace_reconciliation(self):
        self.two_processes(); self.pending(5, flags="0100000")
        self.assertEqual("tracefs_consumer_or_control", self.run_case("reconcile-reader", success=False)["reason"])

    def test_added_trace_control_cannot_use_nontrace_reconciliation(self):
        self.two_processes()
        control = self.root / "control"
        control.write_text("PRIVATE")
        self.pending(5, target=control)
        self.assertEqual("tracefs_consumer_or_control", self.run_case("reconcile-control", success=False)["reason"])

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
