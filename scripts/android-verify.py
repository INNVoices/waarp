#!/usr/bin/env python3
"""Verify a real Waarp APK: identity, signature, engine bytes and 16 KB packaging.

This is a static packaging gate. Device/emulator tests remain a separate gate;
passing this script does not claim that VPN connectivity has been exercised.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import struct
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parent.parent
PAGE_SIZE = 16_384


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def tool(name: str) -> str:
    suffix = ".bat" if os.name == "nt" and name == "apksigner" else ".exe" if os.name == "nt" else ""
    sdk = os.environ.get("ANDROID_HOME") or os.environ.get("ANDROID_SDK_ROOT")
    if sdk:
        pinned = Path(sdk) / "build-tools" / "35.0.0" / f"{name}{suffix}"
        if pinned.is_file():
            return str(pinned)
    found = shutil.which(f"{name}{suffix}")
    require(bool(found), f"Missing {name}: install Android SDK Build Tools 35.0.0 and set ANDROID_HOME.")
    return str(found)


def command(args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(args, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=120, check=False)


def verify_permissions(badging: str) -> list[str]:
    # Inspect the merged APK, including version-qualified declarations from AARs.
    permissions = set(re.findall(r"^uses-permission(?:-sdk-\d+)?: name='([^']+)'", badging, re.M))
    for permission in ("INTERNET", "ACCESS_NETWORK_STATE", "FOREGROUND_SERVICE", "FOREGROUND_SERVICE_SYSTEM_EXEMPTED"):
        require(f"android.permission.{permission}" in permissions, f"APK lacks required permission: {permission}")
    for permission in ("ACCESS_COARSE_LOCATION", "ACCESS_FINE_LOCATION", "ACCESS_BACKGROUND_LOCATION", "ACCESS_WIFI_STATE"):
        require(f"android.permission.{permission}" not in permissions,
                f"APK unexpectedly requests {permission}; Atlas uses a manually chosen region.")
    return sorted(permissions)


def elf_check(data: bytes, name: str) -> dict:
    require(data[:4] == b"\x7fELF", f"Not an ELF library: {name}")
    bits = {1: 32, 2: 64}.get(data[4])
    require(bits is not None and data[5] in (1, 2), f"Unsupported ELF header: {name}")
    endian = "<" if data[5] == 1 else ">"
    header = struct.unpack_from(endian + ("HHIQQQIHHHHHH" if bits == 64 else "HHIIIIIHHHHHH"), data, 16)
    offset, entry_size, count = header[4], header[8], header[9]
    segments = []
    for index in range(count):
        values = struct.unpack_from(endian + ("IIQQQQQQ" if bits == 64 else "IIIIIIII"), data, offset + index * entry_size)
        if bits == 64:
            kind, flags, start, address, _, file_size, memory_size, alignment = values
        else:
            kind, start, address, _, file_size, memory_size, flags, alignment = values
        segments.append(dict(kind=kind, flags=flags, offset=start, address=address, file_size=file_size, memory_size=memory_size, alignment=alignment))
    loads = [segment for segment in segments if segment["kind"] == 1]
    require(bool(loads), f"ELF has no LOAD segments: {name}")
    for segment in loads:
        require(segment["offset"] + segment["file_size"] <= len(data), f"ELF LOAD exceeds file: {name}")
        if bits == 64:
            require(segment["alignment"] >= PAGE_SIZE, f"ELF LOAD alignment is below 16 KB: {name}")
            require((segment["offset"] - segment["address"]) % PAGE_SIZE == 0, f"ELF file and virtual address alignment differs: {name}")
    if bits == 64:
        for relro in (segment for segment in segments if segment["kind"] == 0x6474E552):
            end = relro["address"] + relro["memory_size"]
            protected_end = (end + PAGE_SIZE - 1) // PAGE_SIZE * PAGE_SIZE
            if protected_end == end:
                continue
            for segment in loads:
                if segment["flags"] & 2 and segment["address"] < protected_end:
                    # A separate, fully RELRO LOAD is valid even when its end
                    # uses 4 KB padding, provided no writable data shares the
                    # final 16 KB page (the upstream Go linker uses this form).
                    require(segment["address"] + segment["memory_size"] <= end,
                            f"GNU_RELRO would protect following writable data on a 16 KB device: {name}")
    return {"elfBits": bits, "loadAlignments": [segment["alignment"] for segment in loads], "relro16kSafe": bits == 64}


def zip_data_offset(stream, entry: zipfile.ZipInfo) -> int:
    stream.seek(entry.header_offset)
    header = stream.read(30)
    require(header[:4] == b"PK\x03\x04", f"Invalid ZIP local header: {entry.filename}")
    filename_size, extra_size = struct.unpack_from("<HH", header, 26)
    return entry.header_offset + 30 + filename_size + extra_size


def has_signing_block(path: Path, archive: zipfile.ZipFile) -> bool:
    if archive.start_dir < 24:
        return False
    with path.open("rb") as stream:
        stream.seek(archive.start_dir - 16)
        return stream.read(16) == b"APK Sig Block 42"


def verify(path: Path, expected: str) -> dict:
    pin = json.loads((ROOT / "android/app/src/main/res/raw/engine_integrity.json").read_text())
    source_build = pin.get("sourceBuild")
    if source_build:
        require(source_build.get("manifest") == "android/native-source.json", "Unexpected native source manifest.")
        source_lock = json.loads((ROOT / source_build["manifest"]).read_text())
        source_hash = hashlib.sha256(json.dumps(source_lock, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        require(source_hash == source_build.get("inputsSha256"), "Native source lock differs from the audited engine pin.")
        require(source_lock["version"] == pin["version"] and source_lock["source"]["commit"] == pin["sourceCommit"],
                "Native source identity differs from the engine pin.")
    require(path.is_file(), f"APK does not exist: {path}")
    require(path.stat().st_size > 0, "APK is empty.")
    native = []
    with zipfile.ZipFile(path) as archive, path.open("rb") as raw:
        entries = archive.infolist()
        names = [entry.filename for entry in entries]
        require(len(names) == len(set(names)), "APK contains duplicate ZIP entries.")
        require("AndroidManifest.xml" in names and "classes.dex" in names, "Not a complete Android application APK.")
        for notice in ("GPL-3.0.txt", "NOTICE.txt", "Libbox-LICENSE.txt", "WireGuard-Apache-2.0.txt", "Apache-2.0.txt", "Go-BSD.txt", "Libbox-buildinfo.txt", "Maven-runtime-components.json",
                       "MapLibre-Native.txt", "MapLibre-Android-Dependencies.txt", "MapLibre-Core-Dependencies.txt",
                       "MapLibre-Gestures.txt", "MapLibre-Java.txt"):
            require(f"assets/licenses/{notice}" in names, f"APK lacks its license notice: {notice}")
        notice_index_path = "assets/licenses/native-notices/index.json"
        require(notice_index_path in names, "APK lacks its complete native dependency license inventory.")
        notice_index = json.loads(archive.read(notice_index_path))
        require(notice_index.get("engineAarSha256") == pin["sha256"] and notice_index.get("goVersion") == pin["goVersion"], "Native license inventory does not match the engine pin.")
        require(not notice_index.get("errors") and len(notice_index.get("modules", [])) == pin["nativeDependencyCount"], "Native license inventory is incomplete.")
        for module in notice_index["modules"]:
            require(f"assets/licenses/native-notices/{module['noticeFile']}" in names, f"APK lacks dependency notices for {module['module']}.")
        bad = archive.testzip()
        require(bad is None, f"APK ZIP CRC mismatch: {bad}")
        libraries = [entry for entry in entries if entry.filename.startswith("lib/") and entry.filename.endswith(".so")]
        abis = {entry.filename.split("/")[1] for entry in libraries}
        require(len(abis) == 1 and abis.issubset(set(pin["packagedAbis"])), "APK must contain exactly one supported ABI.")
        abi = next(iter(abis))
        core_name = f"lib/{abi}/libbox.so"
        require(core_name in names, "APK does not contain its native VPN engine.")
        for entry in libraries:
            data = archive.read(entry)
            sha = hashlib.sha256(data).hexdigest()
            elf = elf_check(data, entry.filename)
            require(entry.compress_type == zipfile.ZIP_STORED, f"Native library is compressed: {entry.filename}")
            offset = zip_data_offset(raw, entry)
            if elf["elfBits"] == 64:
                require(offset % PAGE_SIZE == 0, f"Native ZIP entry is not 16 KB aligned: {entry.filename}")
            if entry.filename == core_name:
                expected_core = pin["nativeLibraries"][abi]
                require(sha == expected_core["sha256"] and len(data) == expected_core["bytes"], "Packaged native engine differs from the audited AAR.")
            native.append({"file": entry.filename, "bytes": len(data), "sha256": sha, "zipDataOffset": offset, **elf})
        signature_present = has_signing_block(path, archive) or any(re.match(r"META-INF/[^/]+\.(RSA|DSA|EC)$", name, re.I) for name in names)

    badging = command([tool("aapt"), "dump", "badging", str(path)])
    require(badging.returncode == 0, f"aapt rejected the APK: {badging.stdout[-2000:]}")
    package = re.search(r"^package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'", badging.stdout, re.M)
    require(package is not None, "APK package metadata is missing.")
    package_id, version_code, version_name = package.groups()
    require(package_id == ("local.waarp.android.debug" if expected == "debug" else "local.waarp.android"), "APK applicationId does not match the expected variant.")
    require("sdkVersion:'29'" in badging.stdout and "targetSdkVersion:'36'" in badging.stdout, "APK SDK contract differs from min29/target36.")
    require(("application-debuggable" in badging.stdout) == (expected == "debug"), "APK debuggable flag does not match its variant.")
    require("application-testOnly" not in badging.stdout, "The distributable application must not be marked testOnly.")
    permissions = verify_permissions(badging.stdout)

    alignment = command([tool("zipalign"), "-c", "-P", "16", "-v", "4", str(path)])
    require(alignment.returncode == 0, f"zipalign 16 KB verification failed: {alignment.stdout[-3000:]}")
    # API29+ selects v3 and may report v2=false without even checking v2.
    # Explicitly include API24 in signature verification to require both the
    # fallback v2 block and modern v3 block; the manifest still must declare min29.
    signature = command([tool("apksigner"), "verify", "--min-sdk-version", "24", "--verbose", "--print-certs", str(path)])
    signature_schemes = {version: f"Verified using {version} scheme (APK Signature Scheme {version}): true" in signature.stdout
                         for version in ("v2", "v3")}
    if expected == "release-unsigned":
        require(not signature_present and signature.returncode != 0, "Expected an unsigned release APK, but signing data is present.")
        certificate = None
        signed = False
    else:
        require(signature.returncode == 0, f"APK signature verification failed: {signature.stdout[-3000:]}")
        require("Verified using v2 scheme (APK Signature Scheme v2): true" in signature.stdout, "APK must have a valid v2 signature.")
        certificate_match = re.search(r"Signer #1 certificate SHA-256 digest: ([a-fA-F0-9]+)", signature.stdout)
        require(certificate_match is not None, "Signing certificate digest is missing.")
        certificate = certificate_match.group(1).lower()
        signed = True
        if expected in ("release", "release-ci"):
            require("CN=Android Debug" not in signature.stdout, "A debug certificate cannot be used for a release APK.")
            require(signature_schemes["v3"], "Release APK must also have a valid v3 signature.")
        if expected == "release":
            signing_pin = json.loads((ROOT / "android/release-signing.json").read_text())
            require(signing_pin["applicationId"] == package_id and signing_pin["signerCertificateSha256"] == certificate,
                    "Release APK is not signed by the retained update identity.")

    sha = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            sha.update(chunk)
    return {
        "schemaVersion": 1, "checkedAtUtc": datetime.now(timezone.utc).isoformat(),
        "artifact": path.name, "sha256": sha.hexdigest(), "bytes": path.stat().st_size,
        "variant": expected, "applicationId": package_id, "versionCode": int(version_code), "versionName": version_name,
        "minSdk": 29, "targetSdk": 36, "abi": abi, "signed": signed, "signerCertificateSha256": certificate,
        "permissions": permissions,
        "signatureSchemes": signature_schemes,
        "engineVersion": pin["version"], "engineSourceCommit": pin["sourceCommit"],
        "engineAarSha256": pin["sha256"], "engineSourceBuild": source_build,
        "zipalign16k": True, "nativeLibraries": native,
        "scope": "Static APK packaging and signature checks; runtime VPN tests are reported separately.",
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("apk", type=Path)
    parser.add_argument("--expect", choices=("debug", "release", "release-unsigned", "release-ci"), required=True)
    parser.add_argument("--report", type=Path)
    options = parser.parse_args()
    try:
        report = verify(options.apk.resolve(), options.expect)
        if options.report:
            options.report.parent.mkdir(parents=True, exist_ok=True)
            options.report.write_text(json.dumps(report, indent=2) + "\n")
        print(f"PASS {report['artifact']}: {report['abi']}, {report['variant']}, native integrity + ZIP/ELF 16 KB; signed={report['signed']}.")
        return 0
    except (ValueError, OSError, zipfile.BadZipFile, struct.error, subprocess.TimeoutExpired) as error:
        print(f"FAIL {options.apk.name}: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
