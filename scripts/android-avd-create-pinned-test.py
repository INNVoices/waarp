#!/usr/bin/env python3
"""Conditional creator regression fixtures only; never execute SDK tools."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("pinned_create", Path(__file__).with_name("android-avd-create-pinned.py"))
creator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(creator)


class ConditionalCreationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.sdk, self.avd = self.root / "sdk", self.root / "avd"
        self.output = self.root / "evidence/create.json"
        self.observation = self.root / "previous.json"
        self.write(self.sdk / "cmdline-tools/latest/source.properties", "Pkg.Revision=12.0\n")
        self.write(self.sdk / "cmdline-tools/20.0/source.properties", "Pkg.Revision=20.0\n")
        self.write(self.sdk / "cmdline-tools/20.0/bin/avdmanager", "fixture, not executable")
        self.write(self.sdk / creator.IMAGE / "source.properties",
                   "Pkg.Revision=4\nAndroidVersion.ApiLevel=36.1\nSystemImage.Abi=x86_64\n")
        files = {
            "avdRoot": {"available": True, "properties": {"target": "android-0"}},
            "commandLineToolsVersion": {"available": True, **creator.file_properties(self.sdk, "cmdline-tools/latest/source.properties")},
            "imageVersion": {"available": True, **creator.file_properties(self.sdk, creator.IMAGE + "/source.properties")},
        }
        self.observation.write_text(json.dumps({"schemaVersion": 1, "files": files}))
        self.calls = []
        self.target = "android-36.1"

    def write(self, path, content):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)

    def fake_create(self, arguments, environment, output):
        self.calls.append(arguments)
        self.assertEqual(environment["ANDROID_AVD_HOME"], str(self.avd))
        self.write(self.avd / "test.ini", f"target={self.target}\npath={self.avd}/test.avd\n")
        self.write(self.avd / "test.avd/config.ini", f"image.sysdir.1={creator.IMAGE}/\n")

    def create(self, disposable=True):
        return creator.create(self.sdk, self.avd, self.observation, self.output, disposable, runner=self.fake_create)

    def test_uses_exact_tools_and_image_once_without_force_boot_or_latest_mutation(self):
        latest = self.sdk / "cmdline-tools/latest/source.properties"
        before = latest.read_bytes()
        report = self.create()
        self.assertTrue(report["passed"])
        self.assertEqual(self.calls, [[str(self.sdk / "cmdline-tools/20.0/bin/avdmanager"), "create", "avd",
                                      "--name", "test", "--package", creator.PACKAGE, "--device", "pixel_6"]])
        self.assertNotIn("--force", self.calls[0])
        self.assertFalse(report["booted"])
        self.assertFalse(report["targetEdited"])
        self.assertEqual(latest.read_bytes(), before)
        self.assertEqual(report["originalHostReceiptSha256"], hashlib.sha256(self.observation.read_bytes()).hexdigest())

    def test_correct_original_target_refuses_before_creation(self):
        d = json.loads(self.observation.read_text())
        d["files"]["avdRoot"]["properties"]["target"] = "android-36.1"
        self.observation.write_text(json.dumps(d))
        with self.assertRaises(ValueError):
            self.create()
        self.assertFalse(self.calls)
        self.assertFalse(self.avd.exists())

    def test_current_tools_or_malformed_observation_are_outside_the_conditional_fix(self):
        original = json.loads(self.observation.read_text())
        current = json.loads(json.dumps(original))
        current["files"]["commandLineToolsVersion"]["properties"]["Pkg.Revision"] = "20.0"
        for value in (True, {"schemaVersion": 1, "files": []}, current):
            with self.subTest(value=value):
                self.observation.write_text(json.dumps(value))
                with self.assertRaises(ValueError):
                    self.create()
                self.assertFalse(self.calls)
                self.assertFalse(self.avd.exists())

    def test_ownership_and_existing_avd_refuse_without_replacement(self):
        with self.assertRaises(ValueError):
            self.create(disposable=False)
        self.write(self.avd / "test.ini", "earlier AVD")
        with self.assertRaises(ValueError):
            self.create()
        self.assertEqual((self.avd / "test.ini").read_text(), "earlier AVD")
        self.assertFalse(self.calls)

    def test_wrong_selected_tools_version_does_not_call_avdmanager(self):
        self.write(self.sdk / "cmdline-tools/20.0/source.properties", "Pkg.Revision=19.0\n")
        report = self.create()
        self.assertFalse(report["passed"])
        self.assertFalse(report["creationAttempted"])
        self.assertFalse(self.calls)

    def test_new_runner_or_image_invalidates_the_original_causal_comparison(self):
        for kind in ("tools", "image"):
            with self.subTest(kind=kind):
                path = (self.sdk / "cmdline-tools/latest/source.properties" if kind == "tools"
                        else self.sdk / creator.IMAGE / "source.properties")
                original = path.read_text()
                self.write(path, original + "# changed\n")
                self.output = self.root / (kind + "/create.json")
                report = self.create()
                self.assertFalse(report["passed"])
                self.assertFalse(report["creationAttempted"])
                self.assertFalse(self.calls)
                self.write(path, original)

    def test_still_wrong_generated_target_is_retained_without_repair_or_retry(self):
        self.target = "android-0"
        report = self.create()
        self.assertFalse(report["passed"])
        self.assertTrue(report["creationAttempted"])
        self.assertEqual(len(self.calls), 1)
        self.assertIn("target=android-0", (self.avd / "test.ini").read_text())
        self.assertEqual(report["createdRootIni"]["properties"]["target"], "android-0")

    def test_wrong_major_minor_and_unknown_generated_targets_refuse(self):
        for target in ("android-35", "android-37", "android-999", "android-36.2", "android-36.1-ext999", "unknown"):
            with self.subTest(target=target):
                self.avd = self.root / target / "avd"
                self.output = self.root / target / "evidence/create.json"
                self.target = target
                before = len(self.calls)
                report = self.create()
                self.assertFalse(report["passed"])
                self.assertTrue(report["creationAttempted"])
                self.assertEqual(len(self.calls), before + 1)
                self.assertEqual(report["createdRootIni"]["properties"]["target"], target)
                self.assertIn("target=" + target, (self.avd / "test.ini").read_text())


if __name__ == "__main__":
    unittest.main()
