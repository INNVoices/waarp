#!/usr/bin/env python3
"""Regression fixtures for bounded AndroidJUnitRunner failure evidence."""
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location(
    "waarp_android_instrument", Path(__file__).with_name("android-instrument.py"))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


def status(name, code, stack="", count=2):
    fields = [
        "INSTRUMENTATION_STATUS: class=local.waarp.ExampleTest",
        "INSTRUMENTATION_STATUS: test=" + name,
        "INSTRUMENTATION_STATUS: numtests=" + str(count),
    ]
    if stack:
        fields.append("INSTRUMENTATION_STATUS: stack=" + stack)
    fields.append("INSTRUMENTATION_STATUS_CODE: " + str(code))
    return "\n".join(fields) + "\n"


class InstrumentationEvidenceTests(unittest.TestCase):
    def test_long_native_tail_preserves_the_actual_failed_cycle(self):
        assertion = (
            "java.lang.AssertionError: cycle=1; "
            "udp-receive/SocketTimeoutException; "
            "DNS=[error=use of closed network connection]; native=" + "x" * 40000
            + "\n\tat local.waarp.ExampleTest.toggle(ExampleTest.kt:120)"
        )
        output = status("start", 0) + status("toggle", -2, assertion) + "INSTRUMENTATION_CODE: -1\n"
        diagnostics = []
        result = runner.parse_instrumentation(output, 0, False, failure_diagnostics=diagnostics)
        self.assertFalse(result["passedGate"])
        self.assertEqual((result["passed"], result["failed"]), (1, 1))
        self.assertEqual(diagnostics, [{
            "class": "local.waarp.ExampleTest", "name": "toggle", "statusCode": -2,
            "header": "java.lang.AssertionError: cycle=1; udp-receive/SocketTimeoutException",
        }])

    def test_console_header_excludes_credentials_and_network_destinations(self):
        secrets = ["short-token", "quoted private value", "pass-phrase", "private.example",
                   "198.51.100.7", "userinfo:secret", "bearer-value", "A" * 43 + "=", "c" * 64]
        raw = (
            "AssertionError: cycle=1; token=short-token; private_key=\"quoted private value\"; "
            "password=pass-phrase; endpoint=private.example:51820; socket=198.51.100.7:51820; "
            "https://userinfo:secret@private.example/path; Bearer bearer-value; "
            + "A" * 43 + "=; " + "c" * 64
        )
        header = runner.compact_failure_header(raw)
        self.assertIn("cycle=1", header)
        for secret in secrets:
            self.assertNotIn(secret, header)

    def test_structured_payload_and_later_stack_lines_are_never_console_headers(self):
        for suffix in ('{"privateKey":"hidden-value"}', '[Interface] PrivateKey=hidden-value',
                       "-----BEGIN PRIVATE KEY----- hidden-value"):
            with self.subTest(suffix=suffix[:20]):
                header = runner.compact_failure_header("AssertionError: import failed " + suffix
                                                       + "\nsecret=second-line")
                self.assertIn("import failed", header)
                self.assertNotIn("hidden-value", header)
                self.assertNotIn("second-line", header)

    def test_header_has_a_fixed_bound_and_explicit_truncation(self):
        header = runner.compact_failure_header("AssertionError: " + "x" * 3000)
        self.assertTrue(header.endswith(" [truncated]"))
        self.assertEqual(len(header), 768 + len(" [truncated]"))
        self.assertIn("see instrumentation.txt", runner.compact_failure_header(""))

    def test_optional_diagnostics_do_not_change_the_shared_release_result(self):
        for code, final in ((0, -1), (-2, -1), (-3, -1), (-4, -1), (0, 0)):
            with self.subTest(code=code, final=final):
                output = status("one", code, "AssertionError: failure", count=1)
                output += "INSTRUMENTATION_CODE: " + str(final) + "\n"
                plain = runner.parse_instrumentation(output, 0, False)
                details = []
                enriched = runner.parse_instrumentation(output, 0, False, failure_diagnostics=details)
                self.assertEqual(plain, enriched)
                self.assertEqual(set(plain), {
                    "tests", "expectedTests", "passed", "failed", "skipped",
                    "timedOut", "passedGate", "cases",
                })
                self.assertEqual(len(details), 1 if code == -2 else 0)
                self.assertEqual(plain["passedGate"], code == 0 and final == -1)

    def test_partial_crashed_timed_out_and_skipped_runs_cannot_pass(self):
        complete = status("one", 0, count=1) + "INSTRUMENTATION_CODE: -1\n"
        scenarios = [
            ("", 0, False),
            (status("one", 0, count=2) + "INSTRUMENTATION_CODE: -1\n", 0, False),
            (complete, 1, False),
            (complete, 0, True),
            (status("one", 0, count=1), 0, False),
            (status("one", -3, count=1) + "INSTRUMENTATION_CODE: -1\n", 0, False),
            (complete + "INSTRUMENTATION_CODE: -1\n", 0, False),
        ]
        for output, exit_code, timed_out in scenarios:
            with self.subTest(exit_code=exit_code, timed_out=timed_out, tail=output[-45:]):
                self.assertFalse(runner.parse_instrumentation(output, exit_code, timed_out)["passedGate"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
