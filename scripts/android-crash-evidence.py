#!/usr/bin/env python3
"""Read only current/rotated native crash logs from an owned Android fixture.

The pinned libbox Setup archives a previous nonempty CrashReport file as
crash_reports/<timestamp>/go.log before creating the new current file. Checking
only that new file would miss a Go panic followed by a successful restart.
Configuration snapshots and crash metadata are deliberately never read.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
import subprocess
import time

PACKAGES = {"local.waarp.android", "local.waarp.android.debug"}
MAX_BYTES = 2 * 1024 * 1024
# Upstream prunes to 32 *before* creating the next archive.
MAX_ARCHIVES = 33
CRASH_PATTERN = re.compile(r"panic:|fatal error:|SIGSEGV|goroutine \d+ \[")
ARCHIVE_NAME = r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}(?:-[0-9]{1,4})?"


def redact(value):
    value = re.sub(r"(?<![0-9a-fA-F])[0-9a-fA-F]{64}(?![0-9a-fA-F])", "[REDACTED_32_BYTE_KEY]", value)
    return re.sub(r"(?<![A-Za-z0-9+/_-])(?:[A-Za-z0-9+/_-]{43}=|[A-Za-z0-9+/_-]{44})(?![A-Za-z0-9+/_=-])",
                  "[REDACTED_32_BYTE_KEY]", value)


def collect_native_crashes(prefix, output: Path, package, *, run_as=False, runner=subprocess.run):
    if package not in PACKAGES:
        raise ValueError("Native evidence is restricted to the two owned fixture packages.")
    base = f"/data/user/0/{package}/no_backup/libbox/work"
    # exec-out uses the legacy exec: stream and returns 0 after copying it,
    # even when stat/find failed remotely. Shell v2 carries the real exit code;
    # -T keeps bytes unmodified by a PTY and -n closes unused stdin. Do not use
    # -x, which disables remote status propagation again.
    transport = list(prefix) + ["shell", "-T", "-n"] + (["run-as", package] if run_as else [])
    deadline = time.monotonic() + 90
    report = {"schemaVersion": 1, "package": package, "currentFileAvailable": False,
              "archiveEnumerationAvailable": False, "archiveCount": 0, "files": [], "errors": [],
              "bytes": 0, "panicObserved": False, "available": False, "passed": False}
    sections = []

    def remote(arguments, *, optional=False):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ValueError("native_evidence_deadline")
        result = runner(transport + arguments, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                        timeout=min(20, remaining))
        data = result.stdout
        if result.returncode:
            # A missing optional archive is valid; permission/transport failures
            # must never be interpreted as an empty crash history.
            if optional and b"No such file or directory" in data:
                return None
            raise ValueError("native_evidence_command_failed")
        return data

    def read_log(path, *, optional=False, current=False):
        size = remote(["stat", "-c", "%s", path], optional=optional)
        if size is None:
            return
        if not re.fullmatch(rb"[0-9]+\s*", size):
            raise ValueError("native_evidence_invalid_size")
        remaining = MAX_BYTES - report["bytes"]
        if int(size) > remaining:
            raise ValueError("native_evidence_size_limit")
        # Bound the remote read too, including a crash appended after stat.
        data = remote(["head", "-c", str(remaining + 1), path])
        if len(data) > remaining:
            raise ValueError("native_evidence_size_limit")
        relative = path[len(base) + 1:]
        decoded = data.decode("utf-8", errors="replace")
        observed = bool(CRASH_PATTERN.search(decoded))
        report["files"].append({"path": relative, "bytes": len(data),
                                "sha256": hashlib.sha256(data).hexdigest(), "panicObserved": observed})
        report["bytes"] += len(data)
        report["panicObserved"] = report["panicObserved"] or observed
        if current:
            report["currentFileAvailable"] = True
        sections.append(f"--- {relative} ---\n" + redact(decoded) + "\n")

    try:
        read_log(base + "/CrashReport-waarp-android.log", current=True)
        read_log(base + "/CrashReport-waarp-android.log.old", optional=True)
        listing = remote(["find", base + "/crash_reports", "-mindepth", "2", "-maxdepth", "2",
                          "-type", "f", "-name", "go.log"], optional=True)
        if listing is None:
            paths = []
        else:
            if len(listing) > 16384:
                raise ValueError("native_archive_listing_size_limit")
            paths = listing.decode("utf-8", errors="strict").splitlines()
        if len(paths) > MAX_ARCHIVES or len(paths) != len(set(paths)):
            raise ValueError("native_archive_count_limit")
        pattern = re.compile(re.escape(base) + "/crash_reports/" + ARCHIVE_NAME + "/go\\.log")
        if any(pattern.fullmatch(path) is None for path in paths):
            raise ValueError("native_archive_path_not_allowed")
        report["archiveEnumerationAvailable"] = True
        report["archiveCount"] = len(paths)
        for path in sorted(paths):
            read_log(path)
    except (OSError, ValueError, UnicodeError, subprocess.TimeoutExpired) as error:
        # Never expose arbitrary command stderr or configuration values in a
        # collector failure. The public category is sufficient to reject it.
        report["errors"].append(str(error) if type(error) is ValueError else type(error).__name__)
    report["available"] = report["currentFileAvailable"] and report["archiveEnumerationAvailable"] and not report["errors"]
    report["passed"] = report["available"] and not report["panicObserved"]
    if report["errors"]:
        sections.append("Native crash evidence incomplete: " + ", ".join(report["errors"]) + "\n")
    (output / "native-crash-report.txt").write_text("".join(sections))
    (output / "native-crash-evidence.json").write_text(json.dumps(report, indent=2) + "\n")
    return report
