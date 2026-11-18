#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""Bounded parser tests; real encrypted/SIGKILL acceptance remains crash-check.py."""
from contextlib import contextmanager
import importlib.util
import json
import os
from pathlib import Path
from types import SimpleNamespace
import unittest

spec = importlib.util.spec_from_file_location("awg_crash_check", Path(__file__).with_name("crash-check.py"))
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


@contextmanager
def pipe_child(stdout=b"", stderr=b""):
    readers, writers = [], []
    try:
        for payload in (stdout, stderr):
            read, write = os.pipe()
            readers.append(os.fdopen(read, "rb", buffering=0))
            writers.append(write)
            if payload:
                os.write(write, payload)
        yield SimpleNamespace(stdout=readers[0], stderr=readers[1], poll=lambda: None)
    finally:
        for write in writers:
            os.close(write)
        for reader in readers:
            reader.close()


def line(value):
    return json.dumps(value).encode() + b"\n"


class ProgressEvidenceTest(unittest.TestCase):
    def test_accepts_only_fixed_stage_and_bounded_integer_time(self):
        result = {}
        checker.observe_progress(line({"mode": "local_awg_self_test_progress", "stage": "remove_peer", "elapsed_ms": 5100}), result)
        self.assertEqual(result, {"child_stage": "remove_peer", "child_stage_ms": 5100})

    def test_rejects_unknown_fields_raw_logs_and_invalid_values(self):
        original = {"mode": "local_awg_self_test_progress", "stage": "down", "elapsed_ms": 5}
        invalid = [b"private_key=do-not-copy\n", b"[]\n", b"not-json\n"]
        invalid += [line({**original, "stage": value}) for value in ("private_key=do-not-copy", [], {}, None)]
        invalid += [line({**original, "elapsed_ms": value}) for value in (-1, 45001, True, 1.5, "6")]
        invalid += [line({**original, "secret": "do-not-copy"}), line({**original, "mode": "other"})]
        for payload in invalid:
            with self.subTest(payload=payload):
                result = {}
                checker.observe_progress(payload, result)
                self.assertEqual(result, {})

    def test_timeout_retains_stage_without_forwarding_child_logs(self):
        stderr = b"private_key=do-not-copy\n" + line({"mode": "local_awg_self_test_progress", "stage": "remove_peer", "elapsed_ms": 5100})
        result = {}
        with pipe_child(stderr=stderr) as child:
            with self.assertRaises(checker.CheckFailed) as caught:
                checker.wait_for_hold(child, result, timeout_seconds=0.05)
        self.assertEqual((caught.exception.stage, caught.exception.code), ("holding_marker", "timeout"))
        self.assertEqual(result, {"child_stage": "remove_peer", "child_stage_ms": 5100})
        self.assertNotIn("do-not-copy", json.dumps(result))

    def test_holding_marker_still_requires_two_distinct_valid_ports(self):
        for ports in ((0, 2), (1, 1), (True, 2), (1, 65536)):
            marker = {"mode": "local_awg_self_test", "stage": "holding_after_success", "client_loopback_port": ports[0], "server_loopback_port": ports[1]}
            with pipe_child(stdout=line(marker)) as child:
                with self.assertRaises(checker.CheckFailed) as caught:
                    checker.wait_for_hold(child, {})
            self.assertEqual(caught.exception.code, "invalid_ports")

    def test_holding_marker_accepts_only_the_live_child_marker(self):
        marker = {"mode": "local_awg_self_test", "stage": "holding_after_success", "client_loopback_port": 12001, "server_loopback_port": 12002}
        with pipe_child(stdout=line(marker)) as child:
            self.assertEqual(checker.wait_for_hold(child, {}), (12001, 12002))


if __name__ == "__main__":
    unittest.main()
