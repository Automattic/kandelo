import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).with_name("rust-sdk-manifest.py")
SCHEMA = SCRIPT.resolve().parents[3] / "sdk/guest-rust/src/sdk-components.json"
REQUIRED = json.loads(SCHEMA.read_text())["required"]


class RustSdkManifestTests(unittest.TestCase):
    def run_manifest(self, *arguments):
        return subprocess.run([sys.executable, str(SCRIPT), *arguments],
                              text=True, capture_output=True, check=False)

    def create_components(self, directory):
        paths = {}
        for name in REQUIRED:
            path = Path(directory) / name
            path.write_bytes(name.encode())
            paths[name] = path
        return paths

    def arguments(self, paths):
        return [item for name, path in paths.items() for item in ("--component", name, str(path))]

    def test_hashes_actual_bytes_and_is_independent_of_argument_order(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = self.create_components(directory)
            result = self.run_manifest(*self.arguments(paths))
            self.assertEqual(result.returncode, 0, result.stderr)
            manifest = json.loads(result.stdout)
            self.assertEqual(manifest["components"]["cargo"],
                             hashlib.sha256(b"cargo").hexdigest())
            reverse = self.run_manifest(*self.arguments(dict(reversed(list(paths.items())))))
            self.assertEqual(reverse.returncode, 0, reverse.stderr)
            self.assertEqual(result.stdout, reverse.stdout)
            digests = [item for name, digest in manifest["components"].items()
                       for item in ("--digest", name, digest)]
            self.assertEqual(self.run_manifest(*digests).stdout, result.stdout)

    def test_same_size_and_mtime_source_change_changes_the_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = self.create_components(directory)
            std = paths["rust-std"]
            std.write_bytes(b"old-std")
            os.utime(std, ns=(1_000_000_000, 1_000_000_000))
            before_stat = std.stat()
            before = json.loads(self.run_manifest(*self.arguments(paths)).stdout)
            std.write_bytes(b"new-std")
            os.utime(std, ns=(before_stat.st_atime_ns, before_stat.st_mtime_ns))
            after = json.loads(self.run_manifest(*self.arguments(paths)).stdout)
            self.assertEqual(std.stat().st_size, before_stat.st_size)
            self.assertEqual(std.stat().st_mtime_ns, before_stat.st_mtime_ns)
            self.assertNotEqual(before["identity"], after["identity"])
            self.assertEqual(before["components"]["cargo"], after["components"]["cargo"])

    def test_refuses_missing_unknown_duplicate_and_malformed_components(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = self.create_components(directory)
            arguments = self.arguments(paths)
            cases = [[], arguments + ["--digest", "unknown", "12" * 32],
                     arguments + ["--component", "cargo", str(paths["cargo"])]]
            for name, path in paths.items():
                if name != "cargo":
                    continue
                remainder = self.arguments({key: value for key, value in paths.items() if key != name})
                cases.extend([remainder + ["--digest", name, "XX" * 32],
                              remainder + ["--digest", name, "12" * 31],
                              remainder + ["--component", name, str(path.with_name("missing"))]])
            for case in cases:
                result = self.run_manifest(*case)
                self.assertNotEqual(result.returncode, 0, case)
                self.assertEqual(result.stdout, "")
                self.assertIn("rust-sdk-manifest:", result.stderr)


if __name__ == "__main__":
    unittest.main()
