#!/usr/bin/env python3
"""Regression fixtures for bounded AndroidJUnitRunner failure evidence."""
import importlib.util
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
import json
from pathlib import Path
from subprocess import CompletedProcess
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

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

    def test_focused_route_gate_requires_every_named_case_once_and_no_skips(self):
        self.assertIn(("local.waarp.android.core.VpnLifecycleInstrumentedTest",
                       "nativeLifecycleCommandsCannotReplaceMasterOwnership"), runner.ROUTE_SMOKE_CASES)
        cases = sorted(runner.ROUTE_SMOKE_CASES)
        def transcript(selected, code=0):
            return "".join(status(method, code, count=len(selected)).replace(
                "local.waarp.ExampleTest", cls) for cls, method in selected) + "INSTRUMENTATION_CODE: -1\n"
        self.assertTrue(runner.parse_instrumentation(transcript(cases), 0, False,
            required_cases=runner.ROUTE_SMOKE_CASES)["passedGate"])
        for selected, code in ((cases[:-1], 0), (cases[:-1] + cases[:1], 0),
                               (cases + [("Unexpected", "passing")], 0), (cases, -3), (cases, -2)):
            with self.subTest(selected=selected, code=code):
                self.assertFalse(runner.parse_instrumentation(transcript(selected, code), 0, False,
                    required_cases=runner.ROUTE_SMOKE_CASES)["passedGate"])

    def test_ui_gallery_is_exclusive_and_preserves_default_and_smoke_modes(self):
        required = ["--expect-page-size", "4096"]
        for mode in ([], ["--route-smoke"], ["--ui-gallery"]):
            options = runner.parse_options(required + mode)
            self.assertEqual(options.route_smoke, mode == ["--route-smoke"])
            self.assertEqual(options.ui_gallery, mode == ["--ui-gallery"])
        with redirect_stderr(StringIO()), self.assertRaises(SystemExit) as rejected:
            runner.parse_options(required + ["--route-smoke", "--ui-gallery"])
        self.assertEqual(rejected.exception.code, 2)

    def test_ui_gallery_requires_exactly_its_three_existing_cases_and_no_skips(self):
        cases = sorted(runner.UI_GALLERY_CASES)
        self.assertEqual(len(cases), 3)
        source = (Path(__file__).parent.parent / "android/app/src/androidTest/java/local/waarp/android/ui/MobileUiInstrumentedTest.kt").read_text()
        for cls, method in cases:
            self.assertEqual(cls, "local.waarp.android.ui.MobileUiInstrumentedTest")
            self.assertIn("@Test fun " + method + "()", source)
        for selected, code, accepted in ((cases, 0, True), (cases[:-1], 0, False),
                                         (cases[:-1] + cases[:1], 0, False),
                                         (sorted(runner.ROUTE_SMOKE_CASES), 0, False),
                                         (cases, -3, False), (cases, -2, False)):
            transcript = "".join(status(method, code, count=len(selected)).replace(
                "local.waarp.ExampleTest", cls) for cls, method in selected) + "INSTRUMENTATION_CODE: -1\n"
            with self.subTest(selected=selected, code=code):
                self.assertEqual(runner.parse_instrumentation(transcript, 0, False,
                    required_cases=runner.UI_GALLERY_CASES)["passedGate"], accepted)

    def test_ui_gallery_executes_only_selected_cases_and_keeps_existing_evidence_gates(self):
        cases = sorted(runner.UI_GALLERY_CASES)
        transcript = "".join(status(method, 0, count=3).replace(
            "local.waarp.ExampleTest", cls) for cls, method in cases) + "INSTRUMENTATION_CODE: -1\n"
        names = ["01-home-empty.png", "02-settings.png", "03-saved-route.png", "04-groups.png"]
        for files, native_ok, expected in ((names, True, 0), (names[:-1], True, 1), (names, False, 1)):
            with self.subTest(files=files, native_ok=native_ok), TemporaryDirectory() as temporary:
                output = Path(temporary)
                options = runner.parse_options(["--expect-page-size", "4096", "--ui-gallery", "--output", temporary])
                instrument_calls = []

                def run(command, **_kwargs):
                    arguments = command[1:]
                    text = ""
                    if arguments[:3] == ["shell", "am", "instrument"]:
                        instrument_calls.append(arguments)
                        text = transcript
                    elif arguments[0] == "pull":
                        screenshots = output / "ui-screenshots"
                        screenshots.mkdir()
                        for name in files:
                            (screenshots / name).write_bytes(b"\x89PNG\r\n\x1a\n")
                    elif arguments == ["shell", "getconf", "PAGE_SIZE"]:
                        text = "4096"
                    elif arguments[:2] == ["shell", "getprop"]:
                        text = {"ro.build.version.sdk": "35", "ro.build.version.release": "15",
                                "ro.product.cpu.abi": "x86_64"}[arguments[2]]
                    elif arguments[:3] == ["shell", "am", "start"]:
                        text = "Status: ok\nTotalTime: 100\n"
                    return CompletedProcess(command, 0, stdout=text, stderr="")

                with patch.object(runner, "parse_options", return_value=options), \
                     patch.object(runner.shutil, "which", return_value="adb"), \
                     patch.object(runner.subprocess, "run", side_effect=run), \
                     patch.object(runner, "capture_preflight", return_value={}), \
                     patch.object(runner, "capture_logs", return_value={"passed": native_ok}), \
                     redirect_stdout(StringIO()), redirect_stderr(StringIO()):
                    self.assertEqual(runner.main(), expected)
                self.assertEqual(instrument_calls, [["shell", "am", "instrument", "-w", "-r", "-e", "class",
                    ",".join(f"{cls}#{method}" for cls, method in cases),
                    "local.waarp.android.debug.test/androidx.test.runner.AndroidJUnitRunner"]])
                report = json.loads((output / "result.json").read_text())
                self.assertEqual(report["passedGate"], expected == 0)
                self.assertEqual(report["tests"], 3)
                self.assertEqual(report["uiScreenshotCount"], len(files))
                self.assertIn("three offline scenarios", report["scope"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
