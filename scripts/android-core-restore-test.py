import hashlib
import importlib.util
import lzma
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("restore_core", Path(__file__).with_name("android-core-restore.py"))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class RestoreTest(unittest.TestCase):
    def test_replace_only_after_complete_verification(self):
        data = b"fixture engine"
        pin = {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive, installed = root / "core.xz", root / "installed/core.aar"
            archive.write_bytes(lzma.compress(data))
            module.restore(archive, installed, pin)
            for bad in (data[::-1], data * 2, data[:2]):
                archive.write_bytes(lzma.compress(bad))
                with self.assertRaises(ValueError):
                    module.restore(archive, installed, pin)
                self.assertEqual(installed.read_bytes(), data)
                self.assertEqual(list(installed.parent.iterdir()), [installed])


if __name__ == "__main__":
    unittest.main()
