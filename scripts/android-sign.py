#!/usr/bin/env python3
"""Create a retained private Android signing identity or sign verified release APKs.

Private key material stays outside the repository. CI uses a disposable identity
only for installing the exact optimized payload; it never receives the release key.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parent.parent
PUBLIC_PIN = ROOT / "android/release-signing.json"
APPLICATION_ID = "local.waarp.android"


def require(value, message):
    if not value:
        raise ValueError(message)


def executable(name):
    java = os.environ.get("JAVA_HOME")
    if java:
        path = Path(java) / "bin" / (name + (".exe" if os.name == "nt" else ""))
        if path.is_file():
            return str(path)
    found = shutil.which(name)
    require(found, f"Missing {name}; configure JDK 17.")
    return found


def command(arguments, env=None):
    result = subprocess.run(arguments, env=env, capture_output=True, timeout=180)
    require(result.returncode == 0, f"{Path(arguments[0]).name} failed; verify the protected credentials and tool installation.")
    return result.stdout


def private_json(path, value):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        json.dump(value, stream, indent=2)
        stream.write("\n")


def create_identity(directory, label):
    directory.mkdir(parents=True, mode=0o700)
    os.chmod(directory, 0o700)
    password = secrets.token_urlsafe(48)
    alias = "waarp-release"
    env = os.environ.copy()
    env["WAARP_SIGNING_RUNTIME_PASSWORD"] = password
    key = directory / "waarp-android-signing.p12"
    command([executable("keytool"), "-genkeypair", "-noprompt", "-storetype", "PKCS12",
             "-keystore", str(key), "-storepass:env", "WAARP_SIGNING_RUNTIME_PASSWORD",
             "-keypass:env", "WAARP_SIGNING_RUNTIME_PASSWORD", "-alias", alias,
             "-keyalg", "RSA", "-keysize", "4096", "-sigalg", "SHA256withRSA",
             "-validity", "10950", "-dname", f"CN={label}, O=Waarp"], env)
    os.chmod(key, 0o600)
    der = command([executable("keytool"), "-exportcert", "-keystore", str(key),
                   "-storepass:env", "WAARP_SIGNING_RUNTIME_PASSWORD", "-alias", alias], env)
    fingerprint = hashlib.sha256(der).hexdigest()
    credentials = {"schemaVersion": 1, "keyStoreFile": key.name, "keyAlias": alias,
                   "storePassword": password, "keyPassword": password,
                   "signerCertificateSha256": fingerprint}
    private_json(directory / "waarp-android-signing-credentials.json", credentials)
    certificate = directory / "waarp-android-signing-certificate.der"
    certificate.write_bytes(der)
    os.chmod(certificate, 0o600)
    return credentials


def payload_digest(path):
    """Signature-block bytes are outside ZIP entries; compare every payload entry."""
    with zipfile.ZipFile(path) as archive:
        require(len(archive.namelist()) == len(set(archive.namelist())), "Duplicate APK entries.")
        entries = []
        for item in sorted(archive.infolist(), key=lambda value: value.filename):
            digest = hashlib.sha256()
            with archive.open(item) as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(chunk)
            entries.append([item.filename, item.file_size, digest.hexdigest()])
    return hashlib.sha256(json.dumps(entries, separators=(",", ":")).encode()).hexdigest()


def verifier():
    spec = importlib.util.spec_from_file_location("android_verify", ROOT / "scripts/android-verify.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def sign_one(source, destination, credentials_path, kind):
    require(source.resolve() != destination.resolve(), "Keep the unsigned source APK separate.")
    verification = verifier()
    original = verification.verify(source, "release-unsigned")
    identity = json.loads(credentials_path.read_text())
    key = credentials_path.parent / identity["keyStoreFile"]
    require(key.resolve().parent == credentials_path.parent.resolve() and key.is_file(), "Invalid private keystore path.")
    env = os.environ.copy()
    env["WAARP_SIGNING_RUNTIME_STORE_PASSWORD"] = identity["storePassword"]
    env["WAARP_SIGNING_RUNTIME_KEY_PASSWORD"] = identity["keyPassword"]
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="waarp-sign-", dir=destination.parent) as scratch:
        candidate = Path(scratch) / destination.name
        command([verification.tool("apksigner"), "sign", "--ks", str(key), "--ks-key-alias", identity["keyAlias"],
                 "--ks-pass", "env:WAARP_SIGNING_RUNTIME_STORE_PASSWORD",
                 "--key-pass", "env:WAARP_SIGNING_RUNTIME_KEY_PASSWORD",
                 "--v1-signing-enabled", "false", "--v2-signing-enabled", "true", "--v3-signing-enabled", "true",
                 "--v4-signing-enabled", "false", "--out", str(candidate), str(source)], env)
        signed = verification.verify(candidate, kind)
        require(signed["signerCertificateSha256"] == identity["signerCertificateSha256"], "Unexpected signing identity.")
        before = payload_digest(source)
        require(payload_digest(candidate) == before, "Signing changed APK code, resources or other payload entries.")
        signed["unsignedSourceSha256"] = original["sha256"]
        signed["payloadSha256"] = before
        signed["payloadUnchangedBySigning"] = True
        signed["signingIdentityRole"] = "disposable-ci-test-only" if kind == "release-ci" else "retained-release"
        os.replace(candidate, destination)
    destination.with_suffix(destination.suffix + ".validation.json").write_text(json.dumps(signed, indent=2) + "\n")
    return signed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="action", required=True)
    init = commands.add_parser("init-key")
    init.add_argument("--directory", type=Path, required=True)
    sign = commands.add_parser("sign-apks")
    sign.add_argument("--credentials", type=Path, required=True)
    sign.add_argument("--directory", type=Path, default=ROOT / "out/android")
    ci = commands.add_parser("ci-copy")
    ci.add_argument("--apk", type=Path, required=True)
    ci.add_argument("--output", type=Path, required=True)
    options = parser.parse_args()
    if options.action == "init-key":
        destination = options.directory.resolve()
        require(not destination.is_relative_to(ROOT), "Private signing files must stay outside the repository, including out/.")
        require(not destination.exists() and not PUBLIC_PIN.exists(), "A signing identity already exists; do not replace an update identity.")
        destination.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="waarp-key-", dir=destination.parent) as temporary:
            generated = Path(temporary) / "identity"
            identity = create_identity(generated, "Waarp Android")
            os.replace(generated, destination)
        pin = {"schemaVersion": 1, "applicationId": APPLICATION_ID, "keyAlgorithm": "RSA-4096",
               "signerCertificateSha256": identity["signerCertificateSha256"],
               "createdAtUtc": datetime.now(timezone.utc).isoformat(), "validityDays": 10950,
               "scope": "Public APK update identity only. The private key and passwords are retained outside Git and CI."}
        PUBLIC_PIN.write_text(json.dumps(pin, indent=2) + "\n")
        print(json.dumps({"privateDirectory": str(destination), "publicPin": str(PUBLIC_PIN),
                          "signerCertificateSha256": identity["signerCertificateSha256"]}))
    elif options.action == "ci-copy":
        with tempfile.TemporaryDirectory(prefix="waarp-ci-signing-") as temporary:
            identity = Path(temporary) / "identity"
            create_identity(identity, "Waarp CI disposable acceptance")
            result = sign_one(options.apk.resolve(), options.output.resolve(),
                              identity / "waarp-android-signing-credentials.json", "release-ci")
        print(json.dumps({k: result[k] for k in ("artifact", "sha256", "signerCertificateSha256", "payloadUnchangedBySigning", "signingIdentityRole")}))
    else:
        directory = options.directory.resolve()
        metadata_path = directory / "artifacts.json"
        metadata = json.loads(metadata_path.read_text())
        unsigned = [entry for entry in metadata["artifacts"] if entry["variant"] == "release-unsigned"]
        require(len(unsigned) == 3, "Expected three verified unsigned release APKs.")
        signed_entries = []
        for entry in unsigned:
            destination = directory / entry["file"].replace("-release-unsigned.apk", "-release.apk")
            report = sign_one(directory / entry["file"], destination, options.credentials.resolve(), "release")
            signed_entries.append({**entry, "file": destination.name, "variant": "release"})
            print(json.dumps({k: report[k] for k in ("artifact", "sha256", "signerCertificateSha256", "payloadUnchangedBySigning")}))
        metadata["artifacts"] = [entry for entry in metadata["artifacts"] if entry["variant"] != "release"] + signed_entries
        metadata_path.write_text(json.dumps(metadata, indent=2) + "\n")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, subprocess.TimeoutExpired, zipfile.BadZipFile) as error:
        print(f"Android signing failed: {error}", file=sys.stderr)
        raise SystemExit(1)
