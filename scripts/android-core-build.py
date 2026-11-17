#!/usr/bin/env python3
"""Build the locked, patched Android core without publishing an APK or a release.

Normal mode verifies the frozen AAR/native pins before atomically installing
libbox.aar. --bootstrap writes candidates only to a separate, empty directory;
it never changes production pins, notices, application assets, or APKs.
"""
from __future__ import annotations

import argparse
import configparser
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import signal
import struct
import subprocess
import sys
import tempfile
import time
import zipfile

ROOT = Path(__file__).resolve().parent.parent
LOCK_PATH = ROOT / "android/native-source.json"
PIN_PATH = ROOT / "android/app/src/main/res/raw/engine_integrity.json"
ASSETS = ROOT / "android/app/src/main/assets/licenses"
INSTALL_PATH = ROOT / "android/app/libs/libbox.aar"
ABIS = {"arm64-v8a": ("arm64", 64, 183), "armeabi-v7a": ("arm", 32, 40),
        "x86_64": ("amd64", 64, 62)}
MAX_LOG = 32 * 1024 * 1024
MAX_AAR = 512 * 1024 * 1024
MAX_JAR = 64 * 1024 * 1024


def require(condition, message):
    if not condition:
        raise ValueError(message)


def read_bytes(path, limit):
    require(path.is_file() and path.stat().st_size <= limit, f"Missing or oversized input: {path.name}")
    data = path.read_bytes()
    require(len(data) <= limit, f"Input exceeds its bound: {path.name}")
    return data


def read_json(path, limit=1024 * 1024):
    return json.loads(read_bytes(path, limit))


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def json_hash(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def locked_file(spec, limit):
    relative = PurePosixPath(spec["path"])
    require(not relative.is_absolute() and ".." not in relative.parts, "Unsafe locked input path")
    path = (ROOT / relative).resolve()
    require(path.is_relative_to(ROOT / "android/native-patches"), "Native inputs must stay in android/native-patches")
    require(re.fullmatch(r"[0-9a-f]{64}", spec["sha256"] or "") is not None, f"Unfrozen input hash: {spec['path']}")
    data = read_bytes(path, limit)
    require(len(data) == spec["bytes"], f"Input size mismatch: {spec['path']}")
    require(hashlib.sha256(data).hexdigest() == spec["sha256"], f"Input SHA-256 mismatch: {spec['path']}")
    return path, data


def helper(filename, name):
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def query(args, cwd, env, limit=1024 * 1024):
    result = subprocess.run(args, cwd=cwd, env=env, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, timeout=120, check=False)
    require(len(result.stdout) <= limit, f"Command output exceeds its bound: {Path(args[0]).name}")
    output = result.stdout.decode("utf-8", errors="replace")
    require(result.returncode == 0, f"{Path(args[0]).name} failed: {output[-4000:]}")
    return output.strip()


def run(args, cwd, env, log_path, label, timeout):
    print(f"Native core: {label}", flush=True)
    started = time.monotonic()
    next_progress = started + 60
    with log_path.open("ab") as log:
        process = subprocess.Popen(args, cwd=cwd, env=env, stdout=log,
                                   stderr=subprocess.STDOUT, start_new_session=True)
        try:
            while process.poll() is None:
                now = time.monotonic()
                require(log_path.stat().st_size <= MAX_LOG, f"{label} log exceeds 32 MiB")
                require(now - started <= timeout, f"{label} exceeded its {timeout}s infrastructure limit")
                if now >= next_progress:
                    print(f"Native core: {label} still running ({int(now - started)}s)", flush=True)
                    next_progress = now + 60
                time.sleep(0.25)
        except BaseException:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
            raise
    require(log_path.stat().st_size <= MAX_LOG, f"{label} log exceeds 32 MiB")
    if process.returncode:
        with log_path.open("rb") as stream:
            stream.seek(max(0, log_path.stat().st_size - 12_000))
            tail = stream.read().decode("utf-8", errors="replace")
        raise ValueError(f"{label} failed with exit {process.returncode}:\n{tail}")
    return round(time.monotonic() - started, 3)


def git_args(*args):
    return ["git", "-c", "credential.helper=", "-c", "protocol.file.allow=never", *map(str, args)]


def checkout(repository, commit, destination, env, log_path):
    require(re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository) is not None, "Invalid public source repository")
    require(re.fullmatch(r"[0-9a-f]{40}", commit) is not None, "Source commit is not frozen")
    run(git_args("clone", "--filter=blob:none", "--no-checkout", "--no-recurse-submodules",
                 f"https://github.com/{repository}.git", destination),
        destination.parent, env, log_path, f"fetch {repository}", 900)
    run(git_args("checkout", "--detach", commit), destination, env, log_path, f"checkout {repository}", 600)
    actual = query(git_args("rev-parse", "HEAD"), destination, env)
    require(actual == commit, f"Checkout commit differs: {repository}")
    require(not query(git_args("status", "--porcelain", "--untracked-files=all"), destination, env),
            f"Fresh checkout is dirty: {repository}")


def source_checkout(lock, work, env, output):
    source = work / "source"
    spec = lock["source"]
    checkout(spec["repository"], spec["commit"], source, env, output / "source-fetch.log")
    modules = spec["submodules"]
    expected_paths = {"submodules/wireguard-go", "submodules/sing-tun", "submodules/gvisor", "submodules/utls"}
    require(set(modules) == expected_paths, "Exactly four production local replacements must be pinned")
    config = configparser.ConfigParser()
    config.read(source / ".gitmodules", encoding="utf-8")
    gitlinks = {}
    for path, module in modules.items():
        require(re.fullmatch(r"[0-9a-f]{40}", module["commit"]) is not None, "Unfrozen submodule commit")
        entry = query(git_args("ls-tree", "HEAD", "--", path), source, env).split()
        require(len(entry) == 4 and entry[:2] == ["160000", "commit"] and
                entry[2] == module["commit"] and entry[3] == path, f"Source gitlink mismatch: {path}")
        configured = config[f'submodule "{path}"']["url"].removesuffix(".git")
        require(configured == f"https://github.com/{module['repository']}", f"Submodule URL mismatch: {path}")
        gitlinks[path] = module["commit"]
    # Only these modules are needed; never follow a branch or initialize clients/*.
    run(git_args("submodule", "update", "--init", "--depth", "1", "--", *sorted(modules)),
        source, env, output / "source-fetch.log", "fetch four pinned submodules", 1200)
    for path, module in modules.items():
        require(query(git_args("rev-parse", "HEAD"), source / path, env) == module["commit"],
                f"Submodule checkout differs: {path}")
        require(not query(git_args("status", "--porcelain", "--untracked-files=all"), source / path, env),
                f"Submodule is dirty: {path}")
    return source, gitlinks


def apply_inputs(lock, source, env, output, go):
    patch_path, patch_data = locked_file(lock["patch"], 256 * 1024)
    test_path, test_data = locked_file(lock["regressionTest"], 256 * 1024)
    required_tests = re.findall(r"(?m)^func\s+(TestWaarp[A-Za-z0-9_]+)\s*\(\s*t\s+\*testing\.T\s*\)", test_data.decode("utf-8"))
    require(len(required_tests) == len(set(required_tests)) == lock["nativeTests"]["expectedTopLevelTests"],
            "Regression source does not declare the locked number of unique TestWaarp tests")
    target_paths = lock["patch"]["targets"]
    require(set(target_paths) == {"dns/transport/conn_pool.go", "dns/transport/multiplexer.go", "dns/transport/udp.go"},
            "Unexpected production patch targets")
    stats = query(git_args("apply", "--numstat", patch_path), source, env)
    touched = [line.split("\t")[-1] for line in stats.splitlines()]
    require(len(touched) == len(target_paths) and set(touched) == set(target_paths), "Patch changes unexpected files")
    run(git_args("apply", "--check", patch_path), source, env, output / "source-patch.log", "check locked DNS patch", 120)
    run(git_args("apply", "--index", "--whitespace=error", patch_path),
        source, env, output / "source-patch.log", "apply locked DNS patch", 120)
    destination = source / lock["regressionTest"]["destination"]
    require(destination == source / "dns/transport/dns_recovery_waarp_test.go" and not destination.exists(),
            "Regression test destination already exists or differs")
    destination.write_bytes(test_data)
    gofmt = str(Path(go).resolve().parent / "gofmt")
    run([gofmt, "-w", *target_paths, lock["regressionTest"]["destination"]],
        source, env, output / "source-patch.log", "format only patched Go files and regression tests", 120)
    provenance = output / "source-patch"
    provenance.mkdir()
    (provenance / patch_path.name).write_bytes(patch_data)
    (provenance / test_path.name).write_bytes(test_data)
    formatted = {path: sha256(source / path) for path in [*target_paths, lock["regressionTest"]["destination"]]}
    return required_tests, formatted


def apply_wireguard_inputs(lock, source, env, output, go):
    """Patch the exact pinned submodule, independently of the retained DNS patch."""
    module = source / "submodules/wireguard-go"
    patch_path, patch_data = locked_file(lock["wireguardPatch"], 256 * 1024)
    test_path, test_data = locked_file(lock["wireguardRegressionTest"], 256 * 1024)
    required_tests = re.findall(r"(?m)^func\s+(TestWaarp[A-Za-z0-9_]+)\s*\(\s*t\s+\*testing\.T\s*\)", test_data.decode("utf-8"))
    require(len(required_tests) == len(set(required_tests)) == lock["wireguardTests"]["expectedTopLevelTests"],
            "WireGuard regression source does not declare the locked number of unique TestWaarp tests")
    targets = lock["wireguardPatch"]["targets"]
    require(set(targets) == {"conn/bind_std.go", "conn/errors_linux.go"}, "Unexpected WireGuard patch targets")
    stats = query(git_args("apply", "--numstat", patch_path), module, env)
    touched = [line.split("\t")[-1] for line in stats.splitlines()]
    require(len(touched) == len(targets) and set(touched) == set(targets), "WireGuard patch changes unexpected files")
    run(git_args("apply", "--check", patch_path), module, env, output / "source-patch.log", "check locked WireGuard patch", 120)
    run(git_args("apply", "--index", "--whitespace=error", patch_path),
        module, env, output / "source-patch.log", "apply locked WireGuard patch", 120)
    relative_test = lock["wireguardRegressionTest"]["destination"]
    destination = module / relative_test
    require(destination == module / "conn/waarp_gso_retry_test.go" and not destination.exists(),
            "WireGuard regression test destination already exists or differs")
    destination.write_bytes(test_data)
    gofmt = str(Path(go).resolve().parent / "gofmt")
    run([gofmt, "-w", *targets, relative_test], module, env, output / "source-patch.log",
        "format only patched WireGuard files and regression tests", 120)
    for path, data in ((patch_path, patch_data), (test_path, test_data)):
        (output / "source-patch" / path.name).write_bytes(data)
    formatted = {"submodules/wireguard-go/" + path: sha256(module / path) for path in [*targets, relative_test]}
    return required_tests, formatted


def native_tests(lock, source, env, output, go, required_tests, wireguard=False):
    spec = lock["wireguardTests" if wireguard else "nativeTests"]
    package = "github.com/sagernet/wireguard-go/conn" if wireguard else "github.com/sagernet/sing-box/dns/transport"
    label = "WireGuard GSO fallback" if wireguard else "DNS transport"
    name = "wireguard-tests" if wireguard else "native-tests"
    args = [go, "test", "-json", "-race", "-count=1", "-timeout=5m"]
    if wireguard:
        # Run through the engine module's replacement and dependency graph,
        # exactly as the AAR does, not the submodule's older standalone go.mod.
        args += ["-run", "^TestWaarp", package]
    else:
        args += ["-ldflags", spec["linkerFlags"], "-tags", ",".join(spec["tags"]), "./dns/transport"]
    log_path = output / (name + ".jsonl")
    report = {"schemaVersion": 1, "passed": False, "raceDetector": True, "count": 1,
              "package": package,
              "requiredTests": required_tests, "requiredSubtests": spec["requiredSubtests"],
              "tags": spec.get("tags", []), "linkerFlags": spec.get("linkerFlags", ""),
              "scope": f"Host Linux production {label} tests; Android device acceptance remains separate."}
    try:
        report["elapsedSeconds"] = run(args, source, env, log_path, f"native {label} regression suite with race detector", 1200)
        events = []
        for line in read_bytes(log_path, MAX_LOG).decode("utf-8").splitlines():
            if line.startswith("{"):
                events.append(json.loads(line))
        events = [event for event in events if event.get("Package") == report["package"]]
        runs = {event["Test"] for event in events if event.get("Action") == "run" and "Test" in event}
        passes = {event["Test"] for event in events if event.get("Action") == "pass" and "Test" in event}
        failures = [event.get("Test", "<package>") for event in events if event.get("Action") == "fail"]
        skips = [event.get("Test", "<package>") for event in events if event.get("Action") == "skip"]
        package_passes = [event for event in events if event.get("Action") == "pass" and "Test" not in event]
        expected = set(required_tests + spec["requiredSubtests"])
        report.update(testsRun=sorted(runs), testsPassed=sorted(passes), failures=failures, skipped=skips)
        require(not failures and not skips and len(package_passes) == 1, "Native package did not finish with one unskipped pass")
        require(expected.issubset(runs) and expected.issubset(passes),
                f"A named {label} regression or required subtest did not run and pass")
        report["passed"] = True
    except (ValueError, OSError, json.JSONDecodeError) as error:
        report["error"] = str(error)[-16_000:]
        raise
    finally:
        if log_path.exists():
            report["rawLogSha256"] = sha256(log_path)
        write_json(output / (name + ".json"), report)
    return report


def tool_environment(lock, work, output, bootstrap):
    require(platform.system() == "Linux" and platform.machine() in ("x86_64", "AMD64"),
            "The pinned source build requires a Linux x86_64 worker")
    env = dict(os.environ)
    for name in ("GOOS", "GOARCH", "GOARM", "GOARM64", "GOAMD64", "GOEXPERIMENT", "GOFLAGS",
                 "CGO_CFLAGS", "CGO_CPPFLAGS", "CGO_CXXFLAGS", "CGO_LDFLAGS", "CC", "CXX",
                 "GOTOOLCHAIN", "GOWORK", "GOPATH", "GOBIN", "GOCACHE", "GOMODCACHE",
                 "GOROOT", "GONOSUMDB", "GONOPROXY", "GOPRIVATE", "GOFIPS140",
                 "CGO_CFLAGS_ALLOW", "CGO_CFLAGS_DISALLOW", "CGO_CPPFLAGS_ALLOW",
                 "CGO_CPPFLAGS_DISALLOW", "CGO_CXXFLAGS_ALLOW", "CGO_CXXFLAGS_DISALLOW",
                 "CGO_LDFLAGS_ALLOW", "CGO_LDFLAGS_DISALLOW", "GO_EXTLINK_ENABLED",
                 "_JAVA_OPTIONS", "JAVA_TOOL_OPTIONS", "JDK_JAVA_OPTIONS"):
        env.pop(name, None)
    env.update(GOENV="off", GOTOOLCHAIN="local", GO111MODULE="on", GOWORK="off",
               GODEBUG="", GOPATH=str(work / "gopath"),
               GOBIN=str(work / "bin"), GOCACHE=str(work / "go-cache"),
               GOMODCACHE=str(work / "go-mod-cache"), GOAMD64="v1", GOMAXPROCS="2",
               GOFLAGS="-mod=readonly -p=2", CGO_ENABLED="1", GOPROXY="https://proxy.golang.org,direct",
               GOSUMDB="sum.golang.org", GIT_TERMINAL_PROMPT="0", GIT_CONFIG_GLOBAL="/dev/null",
               GIT_CONFIG_NOSYSTEM="1", LC_ALL="C.UTF-8", TZ="UTC")
    go = shutil.which("go", path=env.get("PATH"))
    require(go is not None, "Pinned Go toolchain is missing")
    go = str(Path(go).resolve())
    tools = lock["tools"]
    require(query([go, "env", "GOVERSION"], ROOT, env) == tools["goVersion"], "Go toolchain version differs")
    java_home = Path(os.environ.get("JAVA_HOME", "/missing-java-home")).resolve()
    java = java_home / "bin/java"
    javac = java_home / "bin/javac"
    require(java.is_file() and javac.is_file(), "JAVA_HOME must identify the pinned JDK")
    java_version = query([str(java), "-version"], ROOT, env, 16 * 1024)
    javac_version = query([str(javac), "-version"], ROOT, env, 16 * 1024)
    require(tools["javaVersion"] in java_version and tools["javaVendor"] in java_version,
            "JDK build/vendor differs from the lock")
    require(javac_version == "javac " + tools["javaVersion"].split("+")[0], "javac version differs")
    sdk = Path(os.environ.get("ANDROID_HOME", "/missing-android-sdk")).resolve()
    ndk = sdk / "ndk" / tools["ndkVersion"]
    properties = read_bytes(ndk / "source.properties", 64 * 1024).decode()
    revision = re.search(r"(?m)^Pkg\.Revision\s*=\s*(\S+)", properties)
    require(revision and revision.group(1) == tools["ndkVersion"], "NDK revision differs")
    sdk_jar = sdk / "platforms" / f"android-{tools['sdkPlatform']}" / "android.jar"
    read_bytes(sdk_jar, 128 * 1024 * 1024)
    sdk_hash = sha256(sdk_jar)
    frozen_hash = tools["androidJarSha256"]
    require(bootstrap or re.fullmatch(r"[0-9a-f]{64}", frozen_hash or "") is not None, "Android SDK jar hash is not frozen")
    if frozen_hash is not None:
        require(frozen_hash == sdk_hash, "Android SDK jar differs from the source lock")
    env.update(ANDROID_HOME=str(sdk), ANDROID_SDK_ROOT=str(sdk), ANDROID_NDK_HOME=str(ndk),
               JAVA_HOME=str(java_home))
    env["PATH"] = os.pathsep.join([str(work / "bin"), str(java_home / "bin"), str(Path(go).parent), env["PATH"]])
    (work / "gopath/pkg/gomobile").mkdir(parents=True)
    finalized = copy.deepcopy(lock)
    finalized["tools"]["androidJarSha256"] = sdk_hash
    report = {"goVersion": tools["goVersion"], "java": java_version, "javac": javac_version,
              "ndkVersion": revision.group(1), "androidJarSha256": sdk_hash,
              "gomobileVersion": tools["gomobileVersion"], "gomobileCommit": tools["gomobileCommit"]}
    write_json(output / "toolchain.json", report)
    return go, env, sdk_jar, finalized, report


def install_mobile_tools(lock, work, env, output, go):
    spec = lock["tools"]
    source = work / "gomobile-source"
    checkout("SagerNet/gomobile", spec["gomobileCommit"], source, env, output / "gomobile-tools.log")
    tag_commit = query(git_args("rev-parse", f"{spec['gomobileVersion']}^{{commit}}"), source, env)
    require(tag_commit == spec["gomobileCommit"], "gomobile version tag does not identify the locked commit")
    run([go, "install", "-trimpath", "-buildvcs=false", "./cmd/gomobile", "./cmd/gobind"],
        source, env, output / "gomobile-tools.log", "build both pinned mobile tools without gomobile init", 900)
    for name in ("gomobile", "gobind"):
        require((work / "bin" / name).is_file(), f"Missing built tool: {name}")


def zip_entries(archive, limit, count_limit):
    entries = archive.infolist()
    names = [entry.filename for entry in entries]
    require(len(entries) <= count_limit and len(names) == len(set(names)), "ZIP has too many or duplicate members")
    require(sum(entry.file_size for entry in entries) <= limit, "ZIP expanded size exceeds its bound")
    for entry in entries:
        path = PurePosixPath(entry.filename)
        require(entry.filename and not path.is_absolute() and ".." not in path.parts and
                "\\" not in entry.filename and "\x00" not in entry.filename, "Unsafe ZIP member path")
        require((entry.external_attr >> 16) & 0o170000 != 0o120000, "ZIP symlinks are not accepted")
    return sorted(entries, key=lambda entry: entry.filename)


def stored_header(entry):
    header = zipfile.ZipInfo(entry.filename, date_time=(1980, 1, 1, 0, 0, 0))
    header.compress_type = zipfile.ZIP_STORED
    header.create_system = 3
    header.create_version = 20
    header.extract_version = 20
    header.external_attr = ((0o40755 if entry.is_dir() else 0o100644) << 16) | (0x10 if entry.is_dir() else 0)
    header.internal_attr = 0
    header.extra = b""
    header.comment = b""
    header.file_size = entry.file_size
    return header


def canonical_jar(data):
    result = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(data)) as source, zipfile.ZipFile(result, "w", compression=zipfile.ZIP_STORED) as target:
        for entry in zip_entries(source, MAX_JAR, 20_000):
            content = source.read(entry)
            target.writestr(stored_header(entry), content)
    require(result.tell() <= MAX_JAR, "Canonical classes.jar exceeds its bound")
    return result.getvalue()


def canonical_aar(raw, destination):
    require(raw.stat().st_size <= MAX_AAR, "Raw AAR exceeds its bound")
    with zipfile.ZipFile(raw) as source, zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_STORED) as target:
        entries = zip_entries(source, MAX_AAR, 20_000)
        require("classes.jar" in {entry.filename for entry in entries}, "AAR lacks classes.jar")
        for entry in entries:
            header = stored_header(entry)
            if entry.filename == "classes.jar":
                require(entry.file_size <= MAX_JAR, "Nested classes.jar exceeds its bound")
                target.writestr(header, canonical_jar(source.read(entry)))
            else:
                with source.open(entry) as incoming, target.open(header, "w") as outgoing:
                    shutil.copyfileobj(incoming, outgoing, length=1024 * 1024)
    require(destination.stat().st_size <= MAX_AAR, "Canonical AAR exceeds its bound")


def module_identities(info):
    result = []
    for line in info.splitlines():
        fields = line.split("\t")
        if fields[0] == "dep":
            require(len(fields) >= 3, "Malformed Go dependency build info")
            result.append({"module": fields[1], "version": fields[2], "h1": fields[3] if len(fields) > 3 else ""})
        elif fields[0] == "=>":
            require(result and len(fields) >= 3, "Malformed Go replacement build info")
            result[-1]["replacement"] = {"path": fields[1], "version": fields[2],
                                         "h1": fields[3] if len(fields) > 3 else ""}
    require(len({item["module"] for item in result}) == len(result), "Duplicate Go dependency identity")
    return sorted(result, key=lambda item: item["module"])


def inventory_identity(module):
    result = {key: module.get(key, "") for key in ("module", "version", "h1")}
    if "replacement" in module:
        result["replacement"] = {key: module["replacement"].get(key, "") for key in ("path", "version", "h1")}
    return result


def inspect_aar(aar, lock, source, output, gitlinks):
    verify = helper("android-verify.py", "waarp_android_verify")
    notices = helper("android-native-notices.py", "waarp_android_native_notices")
    baseline = module_identities(read_bytes(ASSETS / "Libbox-buildinfo.txt", 128 * 1024).decode())
    inventory = read_json(ASSETS / "native-notices/index.json")
    count = lock["nativeDependencyCount"]
    require(len(baseline) == count == 112, "Retained native dependency count differs")
    require(inventory["goVersion"] == lock["tools"]["goVersion"] and not inventory.get("errors") and
            inventory["expectedModules"] == count, "Retained notice inventory is incomplete")
    indexed = sorted([inventory_identity(item) for item in inventory["modules"]], key=lambda item: item["module"])
    require(indexed == baseline, "Retained build info and notice module/replacement identities differ")
    for module in inventory["modules"]:
        require((ASSETS / "native-notices" / module["noticeFile"]).is_file(), "A retained dependency notice is missing")
        replacement = module.get("replacement")
        if replacement and replacement["path"].startswith("./"):
            path = replacement["path"][2:]
            require(path in gitlinks and module["sourceCommit"] == gitlinks[path], "Retained replacement gitlink differs")
        else:
            require(module.get("verifiedGoH1") == module["h1"], "Retained immutable module checksum differs")
    sums = {}
    for line in (source / "go.sum").read_text().splitlines():
        fields = line.split()
        if len(fields) == 3:
            sums[(fields[0], fields[1])] = fields[2]
    natives, reports, infos = {}, {}, {}
    with zipfile.ZipFile(aar) as archive:
        expected_libraries = {f"jni/{abi}/libbox.so" for abi in ABIS}
        actual_libraries = {entry.filename for entry in archive.infolist() if entry.filename.endswith(".so")}
        require(actual_libraries == expected_libraries, "AAR native ABI/library set differs")
        classes_hash = hashlib.sha256(archive.read("classes.jar")).hexdigest()
        for abi, (arch, bits, machine) in ABIS.items():
            name = f"jni/{abi}/libbox.so"
            data = archive.read(name)
            elf = verify.elf_check(data, name)
            require(data[5] == 1 and struct.unpack_from("<H", data, 18)[0] == machine and elf["elfBits"] == bits,
                    f"ELF architecture differs: {abi}")
            go_version, info = notices.go_buildinfo(data)
            require(go_version == lock["tools"]["goVersion"], f"Go version differs in {abi}")
            require(lock["version"].encode() in data, f"Stamped native version is absent: {abi}")
            settings = {}
            for line in info.splitlines():
                if line.startswith("build\t") and "=" in line:
                    key, value = line[6:].split("=", 1)
                    settings[key] = value
            require(settings.get("GOOS") == "android" and settings.get("GOARCH") == arch and
                    settings.get("CGO_ENABLED") == "1" and settings.get("-trimpath") == "true",
                    f"Native build settings differ: {abi}")
            require(settings.get("-tags", "").split(",") == lock["buildTags"], f"Native feature tags differ: {abi}")
            expected = copy.deepcopy(baseline)
            if arch != "amd64":
                # Cronet selects one module per native ABI; all other identities stay exact.
                for module in expected:
                    if module["module"] == "github.com/sagernet/cronet-go/lib/android_amd64":
                        module["module"] = f"github.com/sagernet/cronet-go/lib/android_{arch}"
                        key = (module["module"], module["version"])
                        require(key in sums, f"Architecture-specific Cronet checksum is not locked: {abi}")
                        module["h1"] = sums[key]
            expected.sort(key=lambda item: item["module"])
            require(module_identities(info) == expected, f"Actual native module/replacement identities changed: {abi}")
            natives[abi] = {"sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data), "elfBits": bits}
            reports[abi] = {**elf, "moduleCount": len(expected), "moduleIdentitiesMatchRetained": True}
            infos[abi] = {"goVersion": go_version, "text": info}
    write_json(output / "native-static.json", reports)
    write_json(output / "native-buildinfo.json", infos)
    text = ("Extracted from the SHA-256-pinned libbox AAR, jni/x86_64/libbox.so.\n"
            "Go debug/buildinfo inline format: https://github.com/golang/go/blob/"
            + lock["tools"]["goVersion"] + "/src/debug/buildinfo/buildinfo.go\n\n"
            + infos["x86_64"]["goVersion"] + "\n" + infos["x86_64"]["text"])
    require(len(text.encode()) <= 20 * 1024, "Native build-info text exceeds the console evidence bound")
    (output / "Libbox-buildinfo.candidate.txt").write_text(text, encoding="utf-8")
    write_json(output / "notice-inventory-check.json",
               {"schemaVersion": 1, "moduleCount": count, "identitiesUnchanged": True,
                "retainedEngineAarSha256": inventory["engineAarSha256"],
                "candidateEngineAarSha256": sha256(aar), "replacementGitlinks": gitlinks})
    return natives, classes_hash, text, inventory


def atomic_install(source, expected):
    INSTALL_PATH.parent.mkdir(parents=True, exist_ok=True)
    if INSTALL_PATH.exists():
        require(INSTALL_PATH.is_file() and sha256(INSTALL_PATH) == expected["sha256"] and
                INSTALL_PATH.stat().st_size == expected["bytes"], "Refusing to replace an unexpected existing AAR")
    handle, temporary = tempfile.mkstemp(prefix=".libbox-", suffix=".aar", dir=INSTALL_PATH.parent)
    temporary = Path(temporary)
    try:
        with os.fdopen(handle, "wb") as outgoing, source.open("rb") as incoming:
            shutil.copyfileobj(incoming, outgoing, length=1024 * 1024)
            outgoing.flush()
            os.fsync(outgoing.fileno())
        require(sha256(temporary) == expected["sha256"] and temporary.stat().st_size == expected["bytes"],
                "Atomic installation copy differs from the verified AAR")
        os.chmod(temporary, 0o644)
        os.replace(temporary, INSTALL_PATH)
    finally:
        temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bootstrap", type=Path, metavar="OUTPUT_DIRECTORY")
    parser.add_argument("--output", type=Path, default=ROOT / "out/android-core")
    options = parser.parse_args()
    output = (options.bootstrap or options.output).resolve()
    require(not ROOT.is_relative_to(output), "Output cannot contain the repository")
    require(not output.is_relative_to(ROOT) or output.is_relative_to(ROOT / "out"),
            "Outputs inside the repository must stay under out/")
    require(not output.exists() or output.is_dir() and not any(output.iterdir()), "Use an empty native evidence output directory")
    output.mkdir(parents=True, exist_ok=True)
    report = {"schemaVersion": 1, "passed": False, "bootstrap": options.bootstrap is not None,
              "scope": "Reproducible native source build, DNS and WireGuard regressions; no APK build or deployment."}
    try:
        lock = read_json(LOCK_PATH)
        require(lock["schemaVersion"] == 1 and lock["androidAPI"] == 24, "Unsupported native source recipe")
        require(re.fullmatch(r"[A-Za-z0-9_.+-]{1,80}", lock["version"]) is not None, "Invalid native version")
        require(lock["packagedAbis"] == list(ABIS), "Native ABI order/set differs")
        require(len(lock["buildTags"]) == len(set(lock["buildTags"])) == 27, "All 27 mobile feature tags must remain")
        expected_linker = [f"-X github.com/sagernet/sing-box/constant.Version={lock['version']}",
                           "-X runtime.godebugDefault=multipathtcp=0,tlssha1=1", "-checklinkname=0", "-s", "-w", "-buildid="]
        require(lock["linkerFlags"] == expected_linker, "Native linker contract differs")
        require(lock["canonicalArchive"] == "zip-stored-sorted-1980-v1", "Unknown canonical archive policy")
        require(lock["nativeTests"]["linkerFlags"] == "-checklinkname=0" and
                "with_lx_command" in lock["nativeTests"]["tags"], "Native test linker/LX contract differs")
        pin = None
        if not options.bootstrap:
            pin = read_json(PIN_PATH)
            require(pin["version"] == lock["version"] and pin["sourceCommit"] == lock["source"]["commit"],
                    "Production engine pin has not been frozen for this source recipe")
            require(re.fullmatch(r"[0-9a-f]{64}", lock["tools"]["androidJarSha256"] or "") is not None,
                    "Freeze the bootstrap SDK jar hash before a production build")
        with tempfile.TemporaryDirectory(prefix="waarp-native-") as directory:
            work = Path(directory)
            go, env, sdk_jar, finalized, tools = tool_environment(lock, work, output, bool(options.bootstrap))
            source, gitlinks = source_checkout(lock, work, env, output)
            unchanged = {name: sha256(source / name) for name in ("go.mod", "go.sum")}
            required_tests, formatted = apply_inputs(lock, source, env, output, go)
            wireguard_tests, wireguard_formatted = apply_wireguard_inputs(lock, source, env, output, go)
            formatted.update(wireguard_formatted)
            write_json(output / "source-provenance.json",
                       {"schemaVersion": 1, "source": finalized["source"], "patch": finalized["patch"],
                        "regressionTest": finalized["regressionTest"], "sourceInputsSha256": json_hash(finalized),
                        "wireguardPatch": finalized["wireguardPatch"],
                        "wireguardRegressionTest": finalized["wireguardRegressionTest"],
                        "builderSha256": sha256(Path(__file__)), "formattedFileSha256": formatted,
                        "moduleFilesSha256": unchanged, "tools": tools,
                        "canonicalArchive": finalized["canonicalArchive"]})
            native_tests(lock, source, env, output, go, wireguard_tests, wireguard=True)
            native_tests(lock, source, env, output, go, required_tests)
            install_mobile_tools(lock, work, env, output, go)
            raw = work / "libbox-raw.aar"
            args = [str(work / "bin/gomobile"), "bind", "-v", "-o", str(raw),
                    "-target=" + ",".join("android/" + ABIS[abi][0] for abi in lock["packagedAbis"]),
                    "-androidapi=24", "-bootclasspath", str(sdk_jar),
                    "-javapkg=io.nekohasekai", "-libname=box", "-trimpath", "-buildvcs=false",
                    "-ldflags", " ".join(lock["linkerFlags"]), "-tags", ",".join(lock["buildTags"]),
                    "./experimental/libbox"]
            run(args, source, env, output / "native-build.log", "build three Android ABIs from patched source", 4200)
            require({name: sha256(source / name) for name in unchanged} == unchanged,
                    "The source build changed go.mod or go.sum")
            run([go, "mod", "verify"], source, env, output / "modules-verify.log", "verify immutable module cache", 300)
            aar = output / "libbox.aar"
            canonical_aar(raw, aar)
            natives, classes_hash, buildinfo, inventory = inspect_aar(aar, finalized, source, output, gitlinks)
            candidate = {"schemaVersion": 1, "project": finalized["source"]["repository"],
                         "version": finalized["version"], "sourceCommit": finalized["source"]["commit"],
                         "sha256": sha256(aar), "bytes": aar.stat().st_size, "license": "GPL-3.0-or-later",
                         "goVersion": finalized["tools"]["goVersion"], "nativeDependencyCount": finalized["nativeDependencyCount"],
                         "packagedAbis": finalized["packagedAbis"], "nativeLibraries": natives,
                         "sourceBuild": {"manifest": "android/native-source.json", "inputsSha256": json_hash(finalized),
                                         "canonicalArchive": finalized["canonicalArchive"],
                                         "classesJarSha256": classes_hash}}
            write_json(output / "engine-integrity.candidate.json", candidate)
            write_json(output / "native-source.candidate.json", finalized)
            if pin is not None:
                require(all(pin.get(key) == value for key, value in candidate.items()),
                        "Fresh source build differs from the frozen AAR/native/source input pins")
                require(inventory["engineAarSha256"] == pin["sha256"], "Retained native notice index is not bound to the new AAR")
                atomic_install(aar, pin)
            report.update(passed=True, sourceInputsSha256=json_hash(finalized), aarSha256=candidate["sha256"],
                          classesJarSha256=classes_hash, installed=pin is not None)
            print("NATIVE_ENGINE_CANDIDATE " + json.dumps(candidate, sort_keys=True), flush=True)
            print("NATIVE_SOURCE_FINALIZED " + json.dumps(finalized, sort_keys=True), flush=True)
            print("NATIVE_CLASSES_JAR_SHA256 " + classes_hash, flush=True)
            print("BEGIN_NATIVE_BUILDINFO", flush=True)
            print(buildinfo, end="" if buildinfo.endswith("\n") else "\n", flush=True)
            print("END_NATIVE_BUILDINFO", flush=True)
        return 0
    except (ValueError, OSError, KeyError, TypeError, IndexError, zipfile.BadZipFile,
            struct.error, subprocess.SubprocessError) as error:
        report["error"] = str(error)[-16_000:]
        print("Native source build failed: " + report["error"], file=sys.stderr, flush=True)
        return 1
    finally:
        write_json(output / "build-report.json", report)


if __name__ == "__main__":
    raise SystemExit(main())
