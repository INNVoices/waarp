#!/usr/bin/env python3
"""Refresh native dependency notices from the pinned AAR's actual Go build info.

Immutable Go module archives must match the h1 checksums embedded in libbox.
Local replacements use the exact gitlink commits of the pinned source tree.
This maintenance command does not run during normal APK builds.
"""
from concurrent.futures import ThreadPoolExecutor, as_completed
import base64
import configparser
import hashlib
import io
import json
from pathlib import Path
import re
import sys
from urllib.parse import quote
from urllib.request import Request, urlopen
import zipfile

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "android/app/src/main/assets/licenses"


def fetch(url):
    with urlopen(Request(url, headers={"User-Agent": "Waarp-native-license-inventory"}), timeout=90) as response:
        data = response.read(160 * 1024 * 1024 + 1)
    if len(data) > 160 * 1024 * 1024:
        raise ValueError("Source response exceeds the maintenance download limit.")
    return data


def go_buildinfo(data):
    start = data.find(b"\xff Go buildinf:")
    if start < 0 or start % 16 or not data[start + 15] & 2:
        raise ValueError("Expected a Go 1.18+ inline build-info header.")
    position = start + 32

    def string():
        nonlocal position
        length = shift = 0
        while shift < 70:
            value = data[position]
            position += 1
            length |= (value & 127) << shift
            if not value & 128:
                break
            shift += 7
        if length > 1_000_000 or position + length > len(data):
            raise ValueError("Invalid Go build-info length.")
        value = data[position:position + length]
        position += length
        return value

    version, modules = string().decode(), string()
    if len(modules) < 33 or modules[-17] != 10:
        raise ValueError("Missing Go module framing.")
    return version, modules[16:-16].decode()


def notice_name(name):
    return re.match(r"^(LICENSE|LICENCE|COPYING|COPYRIGHT|NOTICE|AUTHORS)([._-].*)?$", Path(name).name, re.I) is not None


def escaped(value):
    return "".join("!" + character.lower() if character.isupper() else character for character in value)


def main():
    pin = json.loads((ROOT / "android/app/src/main/res/raw/engine_integrity.json").read_text())
    aar = ROOT / "android/app/libs/libbox.aar"
    if hashlib.sha256(aar.read_bytes()).hexdigest() != pin["sha256"]:
        raise ValueError("AAR does not match the audited SHA-256 pin.")
    with zipfile.ZipFile(aar) as archive:
        version, info = go_buildinfo(archive.read("jni/x86_64/libbox.so"))
    modules = []
    for line in info.splitlines():
        fields = line.split("\t")
        if fields[0] == "dep":
            modules.append({"module": fields[1], "version": fields[2], "h1": fields[3] if len(fields) > 3 else ""})
        elif fields[0] == "=>":
            modules[-1]["replacement"] = {"path": fields[1], "version": fields[2], "h1": fields[3] if len(fields) > 3 else ""}
    commit, project = pin["sourceCommit"], pin["project"]
    tree = json.loads(fetch(f"https://api.github.com/repos/{project}/git/trees/{commit}?recursive=1"))
    gitlinks = {entry["path"]: entry["sha"] for entry in tree["tree"] if entry["mode"] == "160000"}
    config = configparser.ConfigParser()
    config.read_string(fetch(f"https://raw.githubusercontent.com/{project}/{commit}/.gitmodules").decode())
    submodules = {config[section]["path"]: config[section]["url"] for section in config.sections()}
    output = ASSETS / "native-notices"
    output.mkdir(parents=True, exist_ok=True)

    def collect(module):
        module = dict(module)
        files = []
        replacement = module.get("replacement")
        if replacement and replacement["path"].startswith("./"):
            path = replacement["path"][2:]
            sha, url = gitlinks[path], submodules[path]
            match = re.fullmatch(r"https://github\.com/([^/]+/[^/]+?)(?:\.git)?", url)
            if not match:
                raise ValueError(f"Unsupported public submodule source: {url}")
            repo = match.group(1)
            subtree = json.loads(fetch(f"https://api.github.com/repos/{repo}/git/trees/{sha}?recursive=1"))
            if subtree.get("truncated"):
                raise ValueError("Submodule tree response was truncated.")
            for entry in subtree["tree"]:
                if entry["type"] == "blob" and notice_name(entry["path"]) and entry.get("size", 0) < 1_000_000:
                    data = fetch(f"https://raw.githubusercontent.com/{repo}/{sha}/{quote(entry['path'])}")
                    files.append((entry["path"], data))
            module["source"] = f"https://github.com/{repo}/tree/{sha}"
            module["sourceCommit"] = sha
            module["integrity"] = "Pinned parent source gitlink; the AAR records this dependency as a local replacement."
        else:
            effective = replacement or {"path": module["module"], "version": module["version"], "h1": module["h1"]}
            url = f"https://proxy.golang.org/{escaped(effective['path'])}/@v/{escaped(effective['version'])}.zip"
            archive_bytes = fetch(url)
            with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
                entries = sorted((entry for entry in archive.infolist() if not entry.is_dir()), key=lambda entry: entry.filename)
                if sum(entry.file_size for entry in entries) > 512 * 1024 * 1024:
                    raise ValueError("Go source archive exceeds the source-size limit.")
                digest = hashlib.sha256()
                for entry in entries:
                    if "\n" in entry.filename:
                        raise ValueError("Invalid newline in a Go module source path.")
                    data = archive.read(entry)
                    digest.update(f"{hashlib.sha256(data).hexdigest()}  {entry.filename}\n".encode())
                    if notice_name(entry.filename) and len(data) < 1_000_000:
                        files.append((entry.filename, data))
                h1 = "h1:" + base64.b64encode(digest.digest()).decode()
                if h1 != effective["h1"]:
                    raise ValueError(f"Go module source checksum mismatch: {module['module']}")
            module["source"] = url
            module["verifiedGoH1"] = h1
        if not files:
            raise ValueError(f"No license/notice files found for {module['module']}")
        identifier = hashlib.sha256(f"{module['module']}@{module['version']}".encode()).hexdigest()[:20]
        destination = f"{identifier}.txt"
        parts = [f"{module['module']} {module['version']}\nSource: {module['source']}\n"]
        notices = []
        for name, data in sorted(files):
            parts.append(f"\n----- {name} -----\n\n" + data.decode("utf8", errors="replace"))
            notices.append({"sourcePath": name, "sha256": hashlib.sha256(data).hexdigest()})
        (output / destination).write_text("\n".join(parts) + "\n")
        module["noticeFile"] = destination
        module["notices"] = notices
        return module

    results, errors = [], []
    with ThreadPoolExecutor(max_workers=4) as executor:
        futures = {executor.submit(collect, module): module for module in modules}
        for future in as_completed(futures):
            module = futures[future]
            try:
                results.append(future.result())
            except Exception as error:
                errors.append({"module": module["module"], "error": str(error)})
            if (len(results) + len(errors)) % 10 == 0:
                print(f"Native notices: {len(results)} collected, {len(errors)} errors / {len(modules)} modules", flush=True)
    inventory = {"schemaVersion": 1, "engineAarSha256": pin["sha256"], "goVersion": version, "expectedModules": len(modules), "modules": sorted(results, key=lambda module: module["module"]), "errors": errors}
    (output / "index.json").write_text(json.dumps(inventory, indent=2) + "\n")
    if errors:
        print(json.dumps(errors, indent=2), file=sys.stderr)
        return 1
    print(f"Collected native notices for all {len(results)} modules; immutable Go module checksums verified.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, KeyError, zipfile.BadZipFile) as error:
        print(f"Native notice refresh failed: {error}", file=sys.stderr)
        raise SystemExit(1)
