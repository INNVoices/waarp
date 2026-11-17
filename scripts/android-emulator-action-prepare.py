#!/usr/bin/env python3
"""Materialize the pinned emulator action with the reviewed keyguard patch.

This prepares source only. It neither starts an emulator nor sends guest commands.
The complete upstream checkout retains its Apache license and bundled node_modules.
"""

import argparse
import ctypes
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time


ROOT = Path(__file__).resolve().parent.parent
UPSTREAM = "https://github.com/ReactiveCircus/android-emulator-runner.git"
COMMIT = "a421e43855164a8197daf9d8d40fe71c6996bb0d"
PATCH = ROOT / "scripts/android-emulator-runner-keyguard.patch"
PATCH_SHA256 = "f34589af7316259b73623d97b4b24554b8e6d6148005901b681147fe484d2d87"
DESTINATION = ROOT / "out/android-emulator-action"
MODIFIED_FILES = ("src/emulator-manager.ts", "lib/emulator-manager.js")
OLD_COMMAND = b"await adb(port, `shell input keyevent 82`);"
NEW_COMMAND = b"await adb(port, `shell wm dismiss-keyguard`);"
CHANGE_NOTICE = b"// Waarp: dismiss the keyguard without injecting input into a booting Activity."


class PreparationError(RuntimeError):
    pass


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def git_blob(data):
    return hashlib.sha1(b"blob " + str(len(data)).encode("ascii") + b"\0" + data).hexdigest()


def git(directory, *args, allowed=(0,), timeout=180):
    env = dict(os.environ, GIT_TERMINAL_PROMPT="0")
    command = [
        "git", "-c", "core.hooksPath=/dev/null", "-c", "core.autocrlf=false",
        "-c", "credential.helper=", "-C", str(directory), *args,
    ]
    try:
        result = subprocess.run(command, env=env, capture_output=True, timeout=timeout, check=False)
    except subprocess.TimeoutExpired as error:
        raise PreparationError(f"git {args[0]} exceeded its source-preparation deadline") from error
    if result.returncode not in allowed:
        raise PreparationError(f"git {args[0]} failed with exit code {result.returncode}")
    return result


def expected_change(original):
    lines = original.splitlines(keepends=True)
    matches = [index for index, line in enumerate(lines) if line.strip() == OLD_COMMAND]
    if len(matches) != 1:
        raise PreparationError("Pinned source does not contain exactly one expected boot command")
    index = matches[0]
    old_line = lines[index]
    indentation = old_line[: len(old_line) - len(old_line.lstrip())]
    if old_line != indentation + OLD_COMMAND + b"\n":
        raise PreparationError("Pinned boot-command source formatting changed")
    lines[index] = indentation + CHANGE_NOTICE + b"\n" + indentation + NEW_COMMAND + b"\n"
    return b"".join(lines)


def publish_without_replacement(source, destination):
    # Unlike os.rename, RENAME_NOREPLACE also rejects an existing empty directory.
    # The action runs on Linux; do not weaken this guarantee with a fallback.
    libc = ctypes.CDLL(None, use_errno=True)
    rename = getattr(libc, "renameat2", None)
    if rename is None:
        raise PreparationError("Atomic publication without replacement requires Linux renameat2")
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(-100, os.fsencode(source), -100, os.fsencode(destination), 1) != 0:
        error_number = ctypes.get_errno()
        raise OSError(error_number, os.strerror(error_number), str(destination))


def prepare(report):
    report["phase"] = "validate"
    if sys.platform != "linux":
        raise PreparationError("This action preparation is supported only on Linux runners")
    if os.path.lexists(DESTINATION):
        raise PreparationError("The local action directory already exists; refusing to replace it")
    patch_bytes = PATCH.read_bytes()
    report["patchSha256"] = sha256(patch_bytes)
    if report["patchSha256"] != PATCH_SHA256:
        raise PreparationError("The versioned action patch does not match its frozen SHA-256")
    DESTINATION.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".emulator-action-", dir=DESTINATION.parent) as staging:
        checkout = Path(staging) / "action"
        checkout.mkdir()
        report["phase"] = "fetch-pinned-source"
        git(checkout, "init", "--quiet")
        git(checkout, "remote", "add", "origin", UPSTREAM)
        git(checkout, "fetch", "--no-tags", "--no-recurse-submodules", "--depth=1", "origin", COMMIT)
        git(checkout, "checkout", "--quiet", "--detach", "FETCH_HEAD")
        actual_commit = git(checkout, "rev-parse", "HEAD").stdout.decode("ascii").strip()
        detached = git(checkout, "symbolic-ref", "--quiet", "HEAD", allowed=(0, 1)).returncode == 1
        if actual_commit != COMMIT or not detached:
            raise PreparationError("The fetched action is not detached at the exact pinned commit")
        if git(checkout, "status", "--porcelain", "--untracked-files=all").stdout:
            raise PreparationError("The upstream action checkout is not clean")
        report["verifiedCommit"] = actual_commit
        report["upstreamTree"] = git(checkout, "rev-parse", "HEAD^{tree}").stdout.decode("ascii").strip()
        report["bundledNodeModulesTree"] = git(checkout, "rev-parse", "HEAD:node_modules").stdout.decode("ascii").strip()
        license_bytes = (checkout / "LICENSE").read_bytes()
        report["licenseSha256"] = sha256(license_bytes)
        originals = {path: (checkout / path).read_bytes() for path in MODIFIED_FILES}

        report["phase"] = "apply-reviewed-patch"
        git(checkout, "apply", "--check", "--whitespace=error-all", str(PATCH))
        git(checkout, "apply", "--whitespace=error-all", str(PATCH))
        changed = git(checkout, "diff", "--name-only", "HEAD").stdout.decode("utf-8").splitlines()
        if sorted(changed) != sorted(MODIFIED_FILES):
            raise PreparationError("The action patch changed files outside its two-file scope")
        expected_status = sorted(" M " + path for path in MODIFIED_FILES)
        actual_status = git(checkout, "status", "--porcelain", "--untracked-files=all").stdout.decode("utf-8").splitlines()
        if sorted(actual_status) != expected_status:
            raise PreparationError("The patched action has unexpected working-tree changes")
        git(checkout, "diff", "--check")
        git(checkout, "diff", "--exit-code", "HEAD", "--", "LICENSE", "node_modules", "action.yml")
        report["modifiedFiles"] = []
        for path, original in originals.items():
            modified = (checkout / path).read_bytes()
            if modified != expected_change(original):
                raise PreparationError(f"The patch is not the exact reviewed command replacement: {path}")
            report["modifiedFiles"].append({
                "path": path,
                "originalSha256": sha256(original),
                "modifiedSha256": sha256(modified),
                "originalGitBlob": git_blob(original),
                "modifiedGitBlob": git_blob(modified),
            })
        report["modifiedDiffSha256"] = sha256(git(checkout, "diff", "--binary", "HEAD").stdout)
        report["phase"] = "publish"
        publish_without_replacement(checkout, DESTINATION)
        report["published"] = True
        report["phase"] = "complete"
        report["passed"] = True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    started = time.monotonic()
    report = {
        "schemaVersion": 1,
        "passed": False,
        "published": False,
        "upstreamRepository": UPSTREAM,
        "upstreamCommit": COMMIT,
        "patch": str(PATCH.relative_to(ROOT)),
        "expectedPatchSha256": PATCH_SHA256,
        "actionDirectory": str(DESTINATION.relative_to(ROOT)),
        "bootCommand": "adb shell wm dismiss-keyguard",
    }
    try:
        prepare(report)
    except Exception as error:
        report["error"] = f"{type(error).__name__}: {error}"[:1000]
    report["elapsedSeconds"] = round(time.monotonic() - started, 3)
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    if not report["passed"]:
        print(report["error"], file=sys.stderr)
        return 1
    print(f"Prepared emulator action {COMMIT} with patch {PATCH_SHA256}; provenance: {args.report}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
