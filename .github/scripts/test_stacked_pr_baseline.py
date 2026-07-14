#!/usr/bin/env python3
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True

MODULE_PATH = Path(__file__).with_name("stacked_pr_baseline.py")
SPEC = importlib.util.spec_from_file_location("stacked_pr_baseline", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
baseline = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(baseline)


KEY = "0123456789abcdef" * 4
ARCHIVE_SHA = "abcdef0123456789" * 4


def requirement(**updates):
    value = {
        "package": "zlib",
        "version": "1.3.1",
        "revision": 2,
        "arch": "wasm32",
        "sha": KEY,
        "kind": "library",
    }
    value.update(updates)
    return value


def index(**entry_updates):
    entry = {
        "status": "success",
        "archive_url": "zlib-1.3.1-rev2-abi18-wasm32-01234567.tar.zst",
        "archive_sha256": ARCHIVE_SHA,
        "cache_key_sha": KEY,
        "built_by": "https://github.com/Automattic/kandelo/actions/runs/123",
    }
    entry.update(entry_updates)
    return {
        "abi_version": 18,
        "packages": [
            {
                "name": "zlib",
                "version": "1.3.1",
                "revision": 2,
                "binary": {"wasm32": entry},
            }
        ],
    }


class SelectEntriesTests(unittest.TestCase):
    def test_selects_only_exact_current_entry(self):
        selected = baseline.select_entries(index(), [requirement()], 18)
        self.assertEqual(1, len(selected))
        self.assertEqual(ARCHIVE_SHA, selected[0]["archive_sha256"])
        self.assertEqual([], baseline.select_entries(index(), [requirement(sha="1" * 64)], 18))
        self.assertEqual([], baseline.select_entries(index(), [requirement()], 19))

    def test_revision_version_status_and_arch_mismatches_are_unresolved(self):
        self.assertEqual([], baseline.select_entries(index(), [requirement(revision=3)], 18))
        self.assertEqual([], baseline.select_entries(index(), [requirement(version="2")], 18))
        self.assertEqual(
            [], baseline.select_entries(index(status="failed"), [requirement()], 18)
        )
        self.assertEqual([], baseline.select_entries(index(), [requirement(arch="wasm64")], 18))

    def test_rejects_noncanonical_name_and_invalid_digest(self):
        with self.assertRaisesRegex(baseline.BaselineError, "not canonical"):
            baseline.select_entries(
                index(archive_url="../zlib-1.3.1-rev2-abi18-wasm32-01234567.tar.zst"),
                [requirement()],
                18,
            )
        with self.assertRaisesRegex(baseline.BaselineError, "64 lowercase"):
            baseline.select_entries(index(archive_sha256="BAD"), [requirement()], 18)

    def test_rejects_duplicate_requirements_and_index_entries(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "requirements.json"
            path.write_text(json.dumps([requirement(), requirement()]), encoding="utf-8")
            with self.assertRaisesRegex(baseline.BaselineError, "duplicate requirement"):
                baseline.parse_requirements(path)
        duplicate_index = index()
        duplicate_index["packages"].append(duplicate_index["packages"][0].copy())
        with self.assertRaisesRegex(baseline.BaselineError, "duplicate entries"):
            baseline.select_entries(duplicate_index, [requirement()], 18)


if __name__ == "__main__":
    unittest.main()
