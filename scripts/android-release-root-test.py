#!/usr/bin/env python3
"""Synthetic host-only root/reconnect checks. Never invoke ADB or an emulator."""
import hashlib
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("release_root", Path(__file__).with_name("android-release-root.py"))
ROOT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(ROOT)
PREFIX = ["adb", "-s", "emulator-5554"]
IDENTITY = "1\nuserdebug\n36\nx86_64\ngoogle/fixture/userdebug/dev-keys\n"


class Clock:
    def __init__(self):
        self.now = 0

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


class Runner:
    def __init__(self, clock, *, root=(0, "restarting adbd as root\n", ""), before=IDENTITY,
                 ready=None, wait=None, delay=.01, timeout_action=None):
        self.clock, self.root, self.before = clock, root, before
        self.ready = ready or [(0, "0\n" + IDENTITY, "")]
        self.wait = wait or [(0, "", "")]
        self.delay, self.timeout_action, self.calls = delay, timeout_action, []

    def __call__(self, arguments, **options):
        self.calls.append({"arguments": arguments, "timeout": options["timeout"]})
        action = arguments[3]
        if self.timeout_action == action:
            self.clock.now += options["timeout"]
            raise subprocess.TimeoutExpired(arguments, options["timeout"])
        if action == "root":
            result = self.root
        elif action == "wait-for-device":
            result = self.wait.pop(0) if len(self.wait) > 1 else self.wait[0]
        elif arguments[4] == ROOT.IDENTITY_COMMAND:
            result = (0, self.before, "")
        elif arguments[4] == ROOT.READY_COMMAND:
            result = self.ready.pop(0) if len(self.ready) > 1 else self.ready[0]
        else:
            raise AssertionError("Unexpected command")
        self.clock.now += self.delay
        for key, value in (("stdout", result[1]), ("stderr", result[2])):
            options[key].write(value.encode())
        return subprocess.CompletedProcess(arguments, result[0])


class RootReadinessChecks(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.directory = Path(self.temporary.name)
        self.report = self.directory / "root-readiness.json"
        self.clock = Clock()

    def tearDown(self):
        self.temporary.cleanup()

    def establish(self, runner, **options):
        return ROOT.establish_root(PREFIX, self.report, True, runner=runner,
                                   clock=self.clock, sleep=self.clock.sleep, **options)

    def recorded(self):
        return json.loads(self.report.read_text())

    def test_normal_single_root_requires_uid_zero_and_matching_identity(self):
        runner = Runner(self.clock)
        result = self.establish(runner)
        self.assertTrue(result["passed"])
        self.assertFalse(result["rootTransportClosed"] or result["rootReissued"] or result["continuousBootVerified"])
        self.assertEqual(result["identityBefore"], result["identityAfter"])
        self.assertEqual(["shell", "root", "wait-for-device", "shell"], [c["arguments"][3] for c in runner.calls])
        self.assertTrue(all(c["arguments"][:3] == PREFIX for c in runner.calls))

    def test_already_root_acknowledgement_is_still_observed(self):
        runner = Runner(self.clock, root=(0, "adbd is already running as root\n", ""))
        self.assertTrue(self.establish(runner)["passed"])
        self.assertEqual(1, self.recorded()["readinessQueries"])

    def test_empty_success_reply_still_requires_fresh_root_identity(self):
        runner = Runner(self.clock, root=(0, "", ""))
        self.assertTrue(self.establish(runner)["passed"])
        self.assertEqual(1, self.recorded()["readinessQueries"])

    def test_exact_closed_is_unknown_until_new_uid_zero_observation(self):
        runner = Runner(self.clock, root=(1, "", ROOT.ROOT_CLOSED),
                        ready=[(0, "2000\n" + IDENTITY, ""), (0, "0\n" + IDENTITY, "")])
        result = self.establish(runner)
        self.assertTrue(result["passed"] and result["rootTransportClosed"])
        self.assertEqual(2, result["readinessQueries"])
        self.assertEqual(1, sum(c["arguments"][3] == "root" for c in runner.calls))
        self.assertLessEqual(result["elapsedSeconds"], 60)

    def test_unknown_root_error_is_not_retried_or_treated_as_restart(self):
        runner = Runner(self.clock, root=(1, "", "error: device unauthorized"))
        with self.assertRaisesRegex(ValueError, "recognized acknowledgement"):
            self.establish(runner)
        self.assertEqual(["shell", "root"], [c["arguments"][3] for c in runner.calls])
        self.assertFalse(self.recorded()["passed"])

    def test_closed_message_on_wrong_stream_or_with_extra_text_refuses(self):
        for code, stdout, stderr in ((1, ROOT.ROOT_CLOSED, ""), (1, "unexpected", ROOT.ROOT_CLOSED),
                                     (1, "", ROOT.ROOT_CLOSED + "\nunauthorized"), (2, "", ROOT.ROOT_CLOSED)):
            with self.subTest(code=code, stdout=stdout, stderr=stderr), tempfile.TemporaryDirectory() as temporary:
                runner = Runner(self.clock, root=(code, stdout, stderr))
                with self.assertRaises(ValueError):
                    ROOT.establish_root(PREFIX, Path(temporary) / "root-readiness.json", True, runner=runner,
                                        clock=self.clock, sleep=self.clock.sleep)
                self.assertEqual(2, len(runner.calls))

    def test_unrecognized_success_text_does_not_bypass_uid_gate(self):
        runner = Runner(self.clock, root=(0, "adbd cannot run as root in production builds\n", ""))
        with self.assertRaisesRegex(ValueError, "recognized acknowledgement"):
            self.establish(runner)

    def test_never_root_refuses_within_single_sixty_second_deadline(self):
        runner = Runner(self.clock, root=(1, "", ROOT.ROOT_CLOSED), ready=[(0, "2000\n" + IDENTITY, "")])
        with self.assertRaisesRegex(ValueError, "60-second budget"):
            self.establish(runner)
        proof = self.recorded()
        self.assertFalse(proof["passed"])
        self.assertEqual(1, proof["rootRequests"])
        self.assertLessEqual(proof["elapsedSeconds"], 60)
        self.assertEqual(1, sum(c["arguments"][3] == "root" for c in runner.calls))

    def test_wait_timeout_is_retained_without_second_root(self):
        runner = Runner(self.clock, timeout_action="wait-for-device")
        with self.assertRaises(subprocess.TimeoutExpired):
            self.establish(runner)
        proof = self.recorded()
        self.assertFalse(proof["passed"])
        self.assertTrue(proof["commands"][-1]["timedOut"])
        self.assertEqual(1, proof["rootRequests"])
        self.assertLessEqual(self.clock.now, 60)

    def test_measured_late_command_is_not_accepted(self):
        runner = Runner(self.clock, delay=31)
        with self.assertRaisesRegex(ValueError, "measured timeout"):
            self.establish(runner)
        self.assertEqual(0, self.recorded()["rootRequests"])

    def test_deadline_consumed_before_root_records_zero_requests(self):
        class ExpiringClock(Clock):
            after_identity = 0

            def __call__(self):
                if self.now >= .01:
                    self.after_identity += 1
                    if self.after_identity >= 2:
                        return 60
                return self.now
        self.clock = ExpiringClock()
        runner = Runner(self.clock)
        with self.assertRaisesRegex(ValueError, "60-second budget"):
            self.establish(runner)
        self.assertEqual(0, self.recorded()["rootRequests"])
        self.assertFalse(any(call["arguments"][3] == "root" for call in runner.calls))

    def test_uncreated_root_stream_does_not_claim_a_root_request(self):
        original = Path.open

        def opened(path, *args, **kwargs):
            if path.name == "01-root.stdout":
                raise PermissionError("synthetic root evidence open refusal")
            return original(path, *args, **kwargs)
        runner = Runner(self.clock)
        with patch.object(Path, "open", opened), self.assertRaisesRegex(PermissionError, "synthetic root evidence"):
            self.establish(runner)
        proof = self.recorded()
        self.assertEqual(0, proof["rootRequests"])
        self.assertTrue(proof["commands"][-1]["stdout"]["missing"])
        self.assertFalse(any(call["arguments"][3] == "root" for call in runner.calls))

    def test_known_readonly_disconnect_can_wait_without_another_root(self):
        runner = Runner(self.clock, ready=[(1, "", "adb: device offline"), (0, "0\n" + IDENTITY, "")])
        self.assertTrue(self.establish(runner)["passed"])
        self.assertEqual(1, sum(c["arguments"][3] == "root" for c in runner.calls))

    def test_unknown_readiness_error_refuses(self):
        runner = Runner(self.clock, ready=[(1, "", "error: permission denied")])
        with self.assertRaisesRegex(ValueError, "observe root readiness"):
            self.establish(runner)
        self.assertEqual(4, len(runner.calls))

    def test_changed_fingerprint_sdk_or_abi_refuses_even_with_uid_zero(self):
        for before, after in (("google/fixture", "google/other"), ("36\n", "35\n"), ("x86_64", "arm64-v8a")):
            with self.subTest(before=before), tempfile.TemporaryDirectory() as temporary:
                runner = Runner(self.clock, ready=[(0, "0\n" + IDENTITY.replace(before, after), "")])
                with self.assertRaisesRegex(ValueError, "identity changed"):
                    ROOT.establish_root(PREFIX, Path(temporary) / "root-readiness.json", True, runner=runner,
                                        clock=self.clock, sleep=self.clock.sleep)

    def test_unexpected_uid_is_not_assumed_pending_root(self):
        runner = Runner(self.clock, ready=[(0, "1000\n" + IDENTITY, "")])
        with self.assertRaisesRegex(ValueError, "Unexpected release observer UID"):
            self.establish(runner)

    def test_non_emulator_refuses_before_root(self):
        runner = Runner(self.clock, before=IDENTITY.replace("1\n", "0\n", 1))
        with self.assertRaisesRegex(ValueError, "physical"):
            self.establish(runner)
        self.assertEqual(0, self.recorded()["rootRequests"])

    def test_raw_stdout_stderr_and_hashes_survive_failure(self):
        runner = Runner(self.clock, root=(1, "", "error: device unauthorized"))
        with self.assertRaises(ValueError):
            self.establish(runner)
        proof = self.recorded()
        for row in proof["commands"]:
            for key in ("stdout", "stderr"):
                data = (self.directory / "root-readiness-commands" / row[key]["file"]).read_bytes()
                self.assertEqual(len(data), row[key]["bytes"])
                self.assertEqual(hashlib.sha256(data).hexdigest(), row[key]["sha256"])
        self.assertEqual("error: device unauthorized", (self.directory / "root-readiness-commands/01-root.stderr").read_text())

    def test_output_cap_refuses_and_preserves_bytes(self):
        runner = Runner(self.clock, before="x" * ROOT.OUTPUT_LIMIT)
        with self.assertRaisesRegex(ValueError, "output cap"):
            self.establish(runner)
        self.assertFalse(self.recorded()["passed"])
        self.assertEqual(ROOT.OUTPUT_LIMIT, self.recorded()["commands"][0]["stdout"]["bytes"])


if __name__ == "__main__":
    unittest.main()
