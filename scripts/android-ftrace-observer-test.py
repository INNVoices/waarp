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
#define syscall fixture_syscall
#define getgroups fixture_getgroups
#define main observer_main
#include "SOURCE_PATH"
#undef main
#undef syscall
#undef getgroups
#include <stdarg.h>
static int fixture_mode;
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
    scan_proc_fd = open(argv[2], O_RDONLY | O_DIRECTORY);
    must(scan_proc_fd >= 0, "fixture_open");
    if (!strcmp(argv[1], "group")) {
        printf("{\"member\":%s}\n", observer_group_member((unsigned)atoi(argv[3])) ? "true" : "false");
        return 0;
    }
    fixture_mode = atoi(argv[3]);
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
    verify_inventory(inventory);
    for (size_t i = 0; i < inventory->table_count; ++i) scan_table(inventory, i, true);
    verify_inventory(inventory);
    printf("{\"passed\":true,\"processes\":%zu,\"threads\":%zu,\"tables\":%zu,"
           "\"shared\":%zu,\"denied\":%zu,\"fds\":%zu,\"elapsedNs\":%" PRIu64 "}\n",
           inventory->process_count, inventory->task_count, inventory->table_count,
           inventory->shared, inventory->kcmp_denied, inventory->descriptors, monotonic_ns() - started_ns);
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

    def test_descriptor_disappearance_is_not_ignored(self):
        self.two_processes()
        self.assertEqual("descriptor_inventory_changed", self.run_case("fd-change", success=False)["reason"])

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


if __name__ == "__main__":
    unittest.main()
