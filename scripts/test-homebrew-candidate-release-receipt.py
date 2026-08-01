#!/usr/bin/env python3
"""Regression tests for durable candidate release receipts."""

from __future__ import annotations

import hashlib
import json
import pathlib
import subprocess
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
TOOL = ROOT / "scripts/homebrew-candidate-release-receipt.py"


def sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def write_json(path: pathlib.Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


class ReceiptFixture:
    def __init__(self, root: pathlib.Path) -> None:
        self.root = root
        self.assets = root / "assets"
        self.assets.mkdir(parents=True)
        payloads = {
            "candidate.json": b'{"candidate":true}\n',
            "bottle.tar.gz": b"exact bottle bytes",
        }
        self.tag = "homebrew-bottle-candidate-pr-1-run-2-attempt-3-sha256-" + (
            "a" * 64
        )
        self.target = "b" * 40
        self.repository = "Kandelo-dev/homebrew-tap-core"
        receipts = []
        live = []
        for asset_id, name in enumerate(sorted(payloads), start=10):
            payload = payloads[name]
            (self.assets / name).write_bytes(payload)
            url = (
                "https://github.com/Kandelo-dev/homebrew-tap-core/"
                f"releases/download/{self.tag}/{name}"
            )
            receipts.append(
                {
                    "asset_id": asset_id,
                    "bytes": len(payload),
                    "name": name,
                    "sha256": sha256(payload),
                    "url": url,
                }
            )
            live.append(
                {
                    "id": asset_id,
                    "name": name,
                    "state": "uploaded",
                    "size": len(payload),
                    "digest": f"sha256:{sha256(payload)}",
                    "browser_download_url": url,
                }
            )
        self.receipt = {
            "schema": 1,
            "status": "success",
            "visibility": "public-anonymous-readback",
            "repository": self.repository,
            "tag": self.tag,
            "target_commitish": self.target,
            "release_id": 9,
            "immutable": True,
            "assets": receipts,
        }
        self.release = {
            "id": 9,
            "tag_name": self.tag,
            "target_commitish": self.target,
            "immutable": True,
            "draft": False,
            "prerelease": False,
        }
        self.receipt_path = root / "receipt.json"
        self.release_path = root / "release.json"
        self.live_path = root / "live-assets.json"
        self.plan_path = root / "plan.json"
        write_json(self.receipt_path, self.receipt)
        write_json(self.release_path, self.release)
        write_json(self.live_path, live)

    def plan(self, expect_success: bool = True) -> subprocess.CompletedProcess[str]:
        result = subprocess.run(
            [
                "python3",
                str(TOOL),
                "plan",
                "--receipt",
                str(self.receipt_path),
                "--release",
                str(self.release_path),
                "--release-assets",
                str(self.live_path),
                "--repository",
                self.repository,
                "--tag",
                self.tag,
                "--target-commit",
                self.target,
                "--out",
                str(self.plan_path),
            ],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        if expect_success and result.returncode != 0:
            raise AssertionError(result.stderr)
        return result

    def verify(self) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [
                "python3",
                str(TOOL),
                "verify-readback",
                "--plan",
                str(self.plan_path),
                "--asset-root",
                str(self.assets),
            ],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )


class ReceiptTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temporary.name)

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def fixture(self) -> ReceiptFixture:
        return ReceiptFixture(self.root)

    def test_exact_receipt_and_anonymous_readback_are_accepted(self) -> None:
        fixture = self.fixture()
        fixture.plan()
        self.assertEqual(fixture.verify().returncode, 0)

    def test_receipt_rejects_extra_keys(self) -> None:
        fixture = self.fixture()
        fixture.receipt["untrusted"] = True
        write_json(fixture.receipt_path, fixture.receipt)
        result = fixture.plan(expect_success=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must contain exactly", result.stderr)

    def test_receipt_rejects_duplicate_json_keys(self) -> None:
        fixture = self.fixture()
        fixture.receipt_path.write_text('{"schema":1,"schema":1}\n')
        result = fixture.plan(expect_success=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("repeats key", result.stderr)

    def test_live_release_identity_must_match_receipt(self) -> None:
        changes = {
            "id": 10,
            "tag_name": "another-tag",
            "target_commitish": "c" * 40,
            "immutable": False,
            "draft": True,
            "prerelease": True,
        }
        for field, changed in changes.items():
            with self.subTest(field=field):
                fixture = ReceiptFixture(self.root / field)
                fixture.release[field] = changed
                write_json(fixture.release_path, fixture.release)
                result = fixture.plan(expect_success=False)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(
                    "release differs from the protected receipt",
                    result.stderr,
                )

    def test_live_asset_digest_must_match_receipt(self) -> None:
        fixture = self.fixture()
        live = json.loads(fixture.live_path.read_text())
        live[0]["digest"] = "sha256:" + "f" * 64
        write_json(fixture.live_path, live)
        result = fixture.plan(expect_success=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("differs from the protected receipt", result.stderr)

    def test_live_asset_identity_must_match_receipt(self) -> None:
        changes = {
            "id": 99,
            "size": 99,
            "browser_download_url": "https://github.com/wrong/release",
        }
        for field, changed in changes.items():
            with self.subTest(field=field):
                fixture = ReceiptFixture(self.root / field)
                live = json.loads(fixture.live_path.read_text())
                live[0][field] = changed
                write_json(fixture.live_path, live)
                result = fixture.plan(expect_success=False)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(
                    "differs from the protected receipt",
                    result.stderr,
                )

    def test_full_live_inventory_is_required(self) -> None:
        fixture = self.fixture()
        live = json.loads(fixture.live_path.read_text())
        live.pop()
        write_json(fixture.live_path, live)
        result = fixture.plan(expect_success=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("inventory differs", result.stderr)

    def test_extra_live_asset_is_rejected(self) -> None:
        fixture = self.fixture()
        live = json.loads(fixture.live_path.read_text())
        extra = dict(live[-1])
        extra["id"] = 99
        extra["name"] = "unexpected.bin"
        extra["browser_download_url"] += ".unexpected"
        live.append(extra)
        write_json(fixture.live_path, live)
        result = fixture.plan(expect_success=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("inventory differs", result.stderr)

    def test_anonymous_bytes_must_still_match(self) -> None:
        fixture = self.fixture()
        fixture.plan()
        (fixture.assets / "bottle.tar.gz").write_bytes(b"changed")
        result = fixture.verify()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("changed", result.stderr)

    def test_anonymous_readback_rejects_symlinks(self) -> None:
        fixture = self.fixture()
        fixture.plan()
        bottle = fixture.assets / "bottle.tar.gz"
        payload = fixture.root / "outside.bin"
        payload.write_bytes(bottle.read_bytes())
        bottle.unlink()
        bottle.symlink_to(payload)
        result = fixture.verify()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("is not regular", result.stderr)

    def test_plan_output_is_not_overwritten(self) -> None:
        fixture = self.fixture()
        fixture.plan()
        result = fixture.plan(expect_success=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("already exists", result.stderr)

    def test_readback_plan_rejects_extra_keys(self) -> None:
        fixture = self.fixture()
        fixture.plan()
        plan = json.loads(fixture.plan_path.read_text())
        plan["untrusted"] = True
        write_json(fixture.plan_path, plan)
        result = fixture.verify()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must contain exactly", result.stderr)


if __name__ == "__main__":
    unittest.main()
