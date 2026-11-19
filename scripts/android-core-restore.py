"""Restore the pinned Android library from the release source tree."""
import hashlib
import json
import lzma
import os
from pathlib import Path
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def restore(archive, destination, pin):
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with lzma.open(archive, "rb") as source, tempfile.NamedTemporaryFile(
            dir=destination.parent, delete=False
        ) as output:
            temporary = Path(output.name)
            digest = hashlib.sha256()
            size = 0
            while block := source.read(1024 * 1024):
                size += len(block)
                if size > pin["bytes"]:
                    raise ValueError("Android engine exceeds pinned size")
                digest.update(block)
                output.write(block)
        if size != pin["bytes"] or digest.hexdigest() != pin["sha256"]:
            raise ValueError("Android engine differs from integrity manifest")
        os.replace(temporary, destination)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


if __name__ == "__main__":
    pin = json.loads((ROOT / "android/app/src/main/res/raw/engine_integrity.json").read_text())
    restore(ROOT / "android/engine/libbox.aar.xz", ROOT / "android/app/libs/libbox.aar", pin)
