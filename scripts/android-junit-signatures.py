#!/usr/bin/env python3
"""Check compiled JUnit entry-point signatures in the actual test APK.

Kotlin can infer a non-void JVM return type from an expression-bodied test even
when compilation succeeds. AndroidJUnit4 then rejects the entire class before
running any of its cases. This packaging gate uses the pinned SDK's dexdump;
it does not load Android classes or substitute for device execution.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parent.parent
SUITES = {
    "debug": ROOT / "android/app/src/androidTest/java",
    "release": ROOT / "android/acceptance/src/main/java",
}
ANNOTATION = r"(?:org\.junit\.)?(Test|BeforeClass|AfterClass|Before|After)\b"
DECLARATION = re.compile(
    r"^[ \t]*@" + ANNOTATION + r"(?:\s*\([^\n]*?\))?\s*"
    r"(?:(?:public|protected|private|internal|final|open|override|suspend|static)\s+)*"
    r"(?:fun\s+|[\w.<>,?\[\]]+\s+)([A-Za-z_]\w*)\s*\(", re.M)
ANNOTATION_LINE = re.compile(r"^[ \t]*@" + ANNOTATION, re.M)


def require(value, message):
    if not value:
        raise ValueError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def source_scope(suite):
    classes, sources = {}, []
    for path in sorted(SUITES[suite].rglob("*")):
        if path.suffix not in (".kt", ".java"):
            continue
        data = path.read_bytes()
        text = data.decode("utf-8")
        annotations = list(ANNOTATION_LINE.finditer(text))
        if not annotations:
            continue
        methods = list(DECLARATION.finditer(text))
        require(len(methods) == len(annotations), f"Unsupported JUnit declaration in {path.relative_to(ROOT)}")
        package = re.search(r"(?m)^package\s+([\w.]+)", text)
        require(package is not None and re.search(r"\bclass\s+" + re.escape(path.stem) + r"\b", text),
                f"Cannot establish the test class for {path.relative_to(ROOT)}")
        name = package.group(1) + "." + path.stem
        require(name not in classes, f"Duplicate source test class: {name}")
        declared = [{"annotation": item.group(1), "name": item.group(2)} for item in methods]
        require(len({item["name"] for item in declared}) == len(declared), f"Ambiguous JUnit method names in {name}")
        classes[name] = declared
        sources.append({"path": str(path.relative_to(ROOT)), "sha256": sha(data), "class": name})
    require(classes and any(item["annotation"] == "Test" for methods in classes.values() for item in methods),
            "No source-declared JUnit tests found")
    return classes, sources


def dexdump_tool():
    sdk = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
    require(sdk, "Set ANDROID_HOME to the pinned Android SDK")
    path = Path(sdk) / "build-tools/35.0.0" / ("dexdump.exe" if os.name == "nt" else "dexdump")
    require(path.is_file(), "Missing pinned Build Tools 35.0.0 dexdump")
    return path


def verify(apk, suite):
    declared, sources = source_scope(suite)
    tool = dexdump_tool()
    report = {"schemaVersion": 1, "suite": suite, "artifact": apk.name,
              "apkSha256": sha(apk.read_bytes()), "sourceFiles": sources,
              "dexdumpSha256": sha(tool.read_bytes()), "sdkBuildTools": "35.0.0",
              "scope": "Compiled signatures of source-declared JUnit methods; DEX annotation membership and device execution are separate checks.",
              "dex": [], "classes": [], "errors": [], "passed": False}
    found = {}
    with zipfile.ZipFile(apk) as archive, tempfile.TemporaryDirectory(prefix="waarp-junit-signatures-") as temporary:
        names = archive.namelist()
        require(len(names) == len(set(names)), "Test APK contains duplicate ZIP entries")
        dex_names = sorted(name for name in names if re.fullmatch(r"classes(?:\d+)?\.dex", name))
        require(dex_names and "classes.dex" in dex_names, "Test APK has no primary DEX")
        ordinals = sorted(1 if name == "classes.dex" else int(name[7:-4]) for name in dex_names)
        require(ordinals == list(range(1, len(dex_names) + 1)), "Unexpected test APK multidex sequence")
        for name in dex_names:
            require(0 < archive.getinfo(name).file_size <= 256 * 1024 * 1024, "Oversized or empty test DEX")
            data = archive.read(name)
            path = Path(temporary) / name
            path.write_bytes(data)
            result = subprocess.run([str(tool), "-l", "xml", str(path)], capture_output=True,
                                    text=True, encoding="utf-8", errors="strict", timeout=120)
            require(result.returncode == 0, f"dexdump rejected {name}: {result.stderr[-1000:]}")
            require(len(result.stdout) <= 128 * 1024 * 1024, "Oversized DEX XML")
            root = ET.fromstring(result.stdout)
            report["dex"].append({"name": name, "bytes": len(data), "sha256": sha(data)})
            for package in root.findall(".//package"):
                for element in package.findall("class"):
                    owner = package.get("name", "") + "." + element.get("name", "")
                    if owner not in declared:
                        continue
                    require(owner not in found, f"Duplicate compiled test class: {owner}")
                    found[owner] = (name, element)
    for owner, methods in declared.items():
        if owner not in found:
            report["errors"].append(f"Missing compiled test class: {owner}")
            continue
        dex, element = found[owner]
        row = {"class": owner, "dex": dex, "methods": []}
        report["classes"].append(row)
        if element.get("visibility") != "public" or element.get("abstract") != "false":
            report["errors"].append(f"Test class is not public and concrete: {owner}")
        for expected in methods:
            candidates = [method for method in element.findall("method") if method.get("name") == expected["name"]]
            if len(candidates) != 1:
                report["errors"].append(f"Missing or ambiguous compiled JUnit method: {owner}#{expected['name']}")
                continue
            actual = candidates[0]
            parameters = [parameter.get("type") for parameter in actual.findall("parameter")]
            entry = {**expected, "returnType": actual.get("return"), "parameterTypes": parameters,
                     "visibility": actual.get("visibility"), "static": actual.get("static")}
            row["methods"].append(entry)
            required_static = "true" if expected["annotation"] in ("BeforeClass", "AfterClass") else "false"
            if not (entry["returnType"] == "void" and not parameters and entry["visibility"] == "public"
                    and entry["static"] == required_static):
                report["errors"].append(f"Invalid @{expected['annotation']} signature: {owner}#{expected['name']} "
                                        f"return={entry['returnType']} params={parameters} "
                                        f"visibility={entry['visibility']} static={entry['static']}")
    report["testCount"] = sum(method["annotation"] == "Test" for methods in declared.values() for method in methods)
    report["lifecycleMethodCount"] = sum(method["annotation"] != "Test" for methods in declared.values() for method in methods)
    report["passed"] = not report["errors"]
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("apk", type=Path)
    parser.add_argument("--suite", choices=tuple(SUITES), required=True)
    parser.add_argument("--report", type=Path, required=True)
    options = parser.parse_args()
    try:
        report = verify(options.apk.resolve(), options.suite)
        options.report.parent.mkdir(parents=True, exist_ok=True)
        options.report.write_text(json.dumps(report, indent=2) + "\n")
        if not report["passed"]:
            for error in report["errors"]:
                print(error, file=sys.stderr)
            return 1
        print(f"PASS {options.apk.name}: {report['testCount']} JUnit tests and "
              f"{report['lifecycleMethodCount']} lifecycle methods have valid compiled signatures.")
        return 0
    except (ValueError, OSError, zipfile.BadZipFile, ET.ParseError, subprocess.TimeoutExpired) as error:
        # Do not leave an earlier successful report behind after a parser/tool
        # failure. CI retains this directory even when no APK set is published.
        failure = {"schemaVersion": 1, "suite": options.suite, "artifact": options.apk.name,
                   "passed": False, "errors": [str(error)], "scope": "JUnit signature preflight could not complete."}
        options.report.parent.mkdir(parents=True, exist_ok=True)
        options.report.write_text(json.dumps(failure, indent=2) + "\n")
        print(f"FAIL {options.apk.name}: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
