#!/usr/bin/env python3
"""Small real ZIPs test package accounting without SDK, emulator or app changes."""
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import struct
import subprocess
import tempfile
import unittest
import zipfile
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("android_verify", Path(__file__).with_name("android-verify.py"))
VERIFY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(VERIFY)


class InventoryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.apk = self.root / "fixture.apk"

    def test_exact_compressed_uncompressed_and_container_accounting(self):
        entries = {
            "classes.dex": b"dex" * 100,
            "classes2.dex": b"second" * 60,
            "AndroidManifest.xml": b"manifest",
            "resources.arsc": b"resources" * 20,
            "res/drawable/icon.png": b"icon",
            "assets/locales/en.json": b"{}",
            "assets/licenses/NOTICE.txt": b"notice",
            "lib/arm64-v8a/libbox.so": b"native" * 400,
            "META-INF/CERT.RSA": b"signature",
            "unknown.bin": b"remainder",
        }
        with zipfile.ZipFile(self.apk, "w") as archive:
            archive.comment = b"container metadata is not entry payload"
            for name, data in entries.items():
                archive.writestr(name, data, compress_type=zipfile.ZIP_STORED if name.startswith("lib/") else zipfile.ZIP_DEFLATED)
        result = VERIFY.apk_inventory(self.apk)
        self.assertEqual("measured", result["status"])
        self.assertEqual(sum(len(value) for value in entries.values()), result["uncompressedBytes"])
        self.assertEqual(self.apk.stat().st_size, result["compressedPayloadBytes"] + result["containerOverheadBytes"])
        self.assertEqual(result["compressedPayloadBytes"], sum(group["compressedBytes"] for group in result["groups"]))
        self.assertEqual(result["uncompressedBytes"], sum(group["uncompressedBytes"] for group in result["groups"]))
        groups = {group["name"]: group for group in result["groups"]}
        self.assertEqual(2, groups["dex"]["entries"])
        self.assertEqual(len(entries["unknown.bin"]), groups["remainder"]["uncompressedBytes"])
        self.assertEqual(1, groups["notices"]["entries"])
        self.assertEqual(1, groups["assets"]["entries"])
        self.assertEqual(2400, groups["native_libraries"]["compressedBytes"])
        self.assertGreater(result["containerOverheadBytes"], 0)
        self.assertIn("container overhead=", VERIFY.format_apk_inventory(result))

    def test_top_twenty_is_sorted_and_keeps_full_entry_inventory(self):
        with zipfile.ZipFile(self.apk, "w") as archive:
            for index in range(25):
                archive.writestr(f"assets/{index:02d}", b"x" * index)
        result = VERIFY.apk_inventory(self.apk)
        self.assertEqual(25, len(result["entries"]))
        self.assertEqual(list(range(24, 4, -1)), [item["uncompressedBytes"] for item in result["top20ByUncompressedBytes"]])
        self.assertEqual(0, next(group["compressedBytes"] for group in result["groups"] if group["name"] == "remainder"))

    def test_unavailable_input_is_not_measured_not_zero(self):
        result = VERIFY.apk_inventory(self.apk)
        self.assertEqual("not_measured", result["status"])
        self.assertIsNone(result["archiveBytes"])
        self.assertIsNone(result["uncompressedBytes"])

    def test_invalid_zip_is_not_an_empty_success(self):
        self.apk.write_bytes(b"not a ZIP")
        with self.assertRaises(zipfile.BadZipFile):
            VERIFY.apk_inventory(self.apk)

    def test_tool_version_comes_from_actual_resolved_sdk_directory(self):
        executable = self.root / "aapt"
        executable.write_bytes(b"fixture")
        with patch.object(VERIFY, "tool", return_value=str(executable)):
            self.assertEqual("not_recorded", VERIFY.build_tool_metadata("aapt")["versionStatus"])
            (self.root / "source.properties").write_text("Pkg.Revision=35.0.0\n")
            self.assertEqual("35.0.0", VERIFY.build_tool_metadata("aapt")["sdkBuildToolsVersion"])

    def test_environment_metadata_does_not_change_replayable_apk_report(self):
        # An actual tiny ZIP/ELF passes the real Python integrity paths. Only SDK
        # command output is substituted; no Android runtime/signing is claimed.
        elf = bytearray(84)
        elf[:6] = b"\x7fELF\x01\x01"
        struct.pack_into("<HHIIIIIHHHHHH", elf, 16, 3, 40, 1, 0, 52, 0, 0, 52, 32, 1, 0, 0, 0)
        struct.pack_into("<IIIIIIII", elf, 52, 1, 0, 0, 0, len(elf), len(elf), 5, 4096)
        pin = {"version": "fixture", "sourceCommit": "c" * 40, "sha256": "d" * 64, "goVersion": "fixture",
               "nativeDependencyCount": 0, "packagedAbis": ["armeabi-v7a"],
               "nativeLibraries": {"armeabi-v7a": {"sha256": hashlib.sha256(elf).hexdigest(), "bytes": len(elf)}}}
        pin_path = self.root / "android/app/src/main/res/raw/engine_integrity.json"
        pin_path.parent.mkdir(parents=True)
        pin_path.write_text(json.dumps(pin))
        with zipfile.ZipFile(self.apk, "w") as archive:
            archive.writestr("AndroidManifest.xml", "fixture SDK seam")
            archive.writestr("classes.dex", "fixture")
            archive.writestr("lib/armeabi-v7a/libbox.so", elf)
            for notice in ("GPL-3.0.txt", "NOTICE.txt", "Libbox-LICENSE.txt", "WireGuard-Apache-2.0.txt", "Apache-2.0.txt", "Go-BSD.txt", "Libbox-buildinfo.txt", "Maven-runtime-components.json", "MapLibre-Native.txt", "MapLibre-Android-Dependencies.txt", "MapLibre-Core-Dependencies.txt", "MapLibre-Gestures.txt", "MapLibre-Java.txt"):
                archive.writestr(f"assets/licenses/{notice}", "fixture")
            archive.writestr("assets/licenses/native-notices/index.json", json.dumps({"engineAarSha256": pin["sha256"], "goVersion": pin["goVersion"], "modules": []}))
        badging = "package: name='local.waarp.android' versionCode='7' versionName='1.0.0'\nsdkVersion:'29'\ntargetSdkVersion:'36'\n"
        badging += "".join(f"uses-permission: name='android.permission.{name}'\n" for name in ("INTERNET", "ACCESS_NETWORK_STATE", "FOREGROUND_SERVICE", "FOREGROUND_SERVICE_SYSTEM_EXEMPTED"))
        def sdk_command(args):
            name = Path(args[0]).name
            return subprocess.CompletedProcess(args, 1 if name == "apksigner" else 0, badging if name == "aapt" else "")
        properties = self.root / "source.properties"
        with patch.object(VERIFY, "ROOT", self.root), patch.object(VERIFY, "tool", side_effect=lambda name: str(self.root / name)), patch.object(VERIFY, "command", side_effect=sdk_command):
            properties.write_text("Pkg.Revision=35.0.0\n")
            with patch.dict(os.environ, {"GITHUB_SHA": "a" * 40}):
                first = VERIFY.verify(self.apk, "release-unsigned")
                first_context = VERIFY.inventory_report(first)
            properties.write_text("Pkg.Revision=35.0.1\n")
            with patch.dict(os.environ, {"GITHUB_SHA": "b" * 40}):
                second = VERIFY.verify(self.apk, "release-unsigned")
                second_context = VERIFY.inventory_report(second)
        self.assertEqual({key: value for key, value in first.items() if key != "checkedAtUtc"},
                         {key: value for key, value in second.items() if key != "checkedAtUtc"})
        self.assertNotEqual(first_context["sourceCommit"], second_context["sourceCommit"])
        self.assertNotEqual(first_context["tools"], second_context["tools"])
        self.assertEqual(first["sha256"], first_context["sha256"])
        self.assertEqual(first["inventory"], first_context["inventory"])


if __name__ == "__main__":
    unittest.main()
