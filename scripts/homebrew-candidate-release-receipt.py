#!/usr/bin/env python3
"""Validate durable sealer evidence for an immutable candidate release."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import pathlib
import re
import sys
from typing import Any, NoReturn


SHA256 = re.compile(r"^[0-9a-f]{64}$")
COMMIT = re.compile(r"^[0-9a-f]{40}$")
REPOSITORY = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
ASSET_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$")
MAX_JSON_BYTES = 16 * 1024 * 1024
MAX_ASSETS = 256
MAX_TOTAL_BYTES = 4 * 1024 * 1024 * 1024


class ReceiptError(ValueError):
    """The release receipt did not satisfy its closed evidence contract."""


def fail(message: str) -> NoReturn:
    raise ReceiptError(message)


def reject_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            fail(f"JSON repeats key {key!r}")
        result[key] = value
    return result


def load_json(path: pathlib.Path, label: str) -> Any:
    if path.is_symlink() or not path.is_file():
        fail(f"{label} must be a regular file")
    if path.stat().st_size > MAX_JSON_BYTES:
        fail(f"{label} exceeds its byte bound")
    with path.open("r", encoding="utf-8") as stream:
        return json.load(stream, object_pairs_hook=reject_duplicates)


def exact_keys(value: Any, expected: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != expected:
        fail(f"{label} must contain exactly {sorted(expected)}")
    return value


def require_string(
    value: Any,
    label: str,
    pattern: re.Pattern[str] | None = None,
    maximum: int = 1024,
) -> str:
    if not isinstance(value, str) or not value or len(value) > maximum:
        fail(f"{label} must be a bounded nonempty string")
    if pattern is not None and pattern.fullmatch(value) is None:
        fail(f"{label} has an invalid format")
    return value


def require_int(value: Any, label: str, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        fail(f"{label} must be an integer >= {minimum}")
    return value


def normalized_repository(value: Any, label: str) -> str:
    return require_string(value, label, REPOSITORY).lower()


def sha256_file(path: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while block := stream.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def validate_receipt(value: Any) -> dict[str, Any]:
    value = exact_keys(
        value,
        {
            "assets",
            "immutable",
            "release_id",
            "repository",
            "schema",
            "status",
            "tag",
            "target_commitish",
            "visibility",
        },
        "candidate sealer receipt",
    )
    if (
        value["schema"] != 1
        or value["status"] != "success"
        or value["visibility"] != "public-anonymous-readback"
        or value["immutable"] is not True
    ):
        fail("candidate sealer receipt does not record a successful public release")
    normalized_repository(value["repository"], "receipt repository")
    require_string(value["tag"], "receipt tag", maximum=512)
    require_string(value["target_commitish"], "receipt target", COMMIT)
    require_int(value["release_id"], "receipt release ID", 1)
    assets = value["assets"]
    if not isinstance(assets, list) or not assets or len(assets) > MAX_ASSETS:
        fail("candidate sealer receipt has an invalid asset count")
    names: list[str] = []
    ids: set[int] = set()
    total = 0
    for position, asset in enumerate(assets):
        asset = exact_keys(
            asset,
            {"asset_id", "bytes", "name", "sha256", "url"},
            f"candidate sealer receipt asset #{position}",
        )
        name = require_string(asset["name"], "receipt asset name", ASSET_NAME)
        asset_id = require_int(asset["asset_id"], "receipt asset ID", 1)
        byte_count = require_int(asset["bytes"], "receipt asset bytes", 1)
        require_string(asset["sha256"], "receipt asset SHA-256", SHA256)
        url = require_string(asset["url"], "receipt asset URL", maximum=4096)
        if not url.startswith("https://github.com/"):
            fail("receipt asset URL is not a public GitHub download")
        if asset_id in ids:
            fail("candidate sealer receipt repeats an asset ID")
        ids.add(asset_id)
        names.append(name)
        total += byte_count
        if total > MAX_TOTAL_BYTES:
            fail("candidate sealer receipt exceeds its aggregate byte bound")
    if names != sorted(set(names)):
        fail("candidate sealer receipt assets must be unique and sorted")
    return value


def validate_live_release(
    release: Any,
    live_assets: Any,
    receipt: dict[str, Any],
    expected_repository: str,
    expected_tag: str,
    expected_target: str,
) -> list[dict[str, Any]]:
    if not isinstance(release, dict):
        fail("live candidate release must be an object")
    repository = normalized_repository(
        expected_repository, "expected release repository"
    )
    require_string(expected_target, "expected release target", COMMIT)
    if (
        normalized_repository(receipt["repository"], "receipt repository")
        != repository
        or receipt["tag"] != expected_tag
        or receipt["target_commitish"] != expected_target
    ):
        fail("candidate sealer receipt names another release")
    if (
        release.get("id") != receipt["release_id"]
        or release.get("tag_name") != expected_tag
        or release.get("target_commitish") != expected_target
        or release.get("immutable") is not True
        or release.get("draft") is not False
        or release.get("prerelease") is not False
    ):
        fail("live candidate release differs from the protected receipt")
    if not isinstance(live_assets, list) or len(live_assets) > MAX_ASSETS:
        fail("live candidate release has an invalid asset inventory")
    by_name: dict[str, dict[str, Any]] = {}
    ids: set[int] = set()
    for position, asset in enumerate(live_assets):
        if not isinstance(asset, dict):
            fail(f"live release asset #{position} must be an object")
        name = require_string(asset.get("name"), "live asset name", ASSET_NAME)
        asset_id = require_int(asset.get("id"), "live asset ID", 1)
        require_int(asset.get("size"), "live asset bytes", 1)
        require_string(asset.get("digest"), "live asset digest", maximum=71)
        url = require_string(
            asset.get("browser_download_url"),
            "live asset download URL",
            maximum=4096,
        )
        if (
            asset.get("state") != "uploaded"
            or not url.startswith("https://github.com/")
            or name in by_name
            or asset_id in ids
        ):
            fail("live candidate release has ambiguous asset metadata")
        by_name[name] = asset
        ids.add(asset_id)
    receipt_by_name = {asset["name"]: asset for asset in receipt["assets"]}
    if set(by_name) != set(receipt_by_name):
        fail("live candidate release inventory differs from the protected receipt")
    plan_assets: list[dict[str, Any]] = []
    for name in sorted(receipt_by_name):
        recorded = receipt_by_name[name]
        live = by_name[name]
        if (
            live["id"] != recorded["asset_id"]
            or live["size"] != recorded["bytes"]
            or live["digest"] != f"sha256:{recorded['sha256']}"
            or live["browser_download_url"] != recorded["url"]
        ):
            fail(f"live candidate asset {name} differs from the protected receipt")
        plan_assets.append(dict(recorded))
    return plan_assets


def plan(arguments: argparse.Namespace) -> None:
    receipt = validate_receipt(
        load_json(pathlib.Path(arguments.receipt), "candidate sealer receipt")
    )
    release = load_json(pathlib.Path(arguments.release), "live candidate release")
    assets = load_json(
        pathlib.Path(arguments.release_assets), "live candidate release assets"
    )
    plan_assets = validate_live_release(
        release,
        assets,
        receipt,
        arguments.repository,
        arguments.tag,
        arguments.target_commit,
    )
    output = pathlib.Path(arguments.out)
    if output.exists() or output.is_symlink():
        fail("candidate release readback plan already exists")
    output.parent.mkdir(parents=True, exist_ok=True)
    value = {
        "schema": 1,
        "kind": "kandelo-homebrew-candidate-release-readback-plan",
        "repository": receipt["repository"].lower(),
        "tag": receipt["tag"],
        "target_commitish": receipt["target_commitish"],
        "release_id": receipt["release_id"],
        "assets": plan_assets,
    }
    output.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")


def validate_plan(value: Any) -> dict[str, Any]:
    value = exact_keys(
        value,
        {
            "assets",
            "kind",
            "release_id",
            "repository",
            "schema",
            "tag",
            "target_commitish",
        },
        "candidate release readback plan",
    )
    if (
        value["schema"] != 1
        or value["kind"]
        != "kandelo-homebrew-candidate-release-readback-plan"
    ):
        fail("candidate release readback plan has an unsupported contract")
    receipt_shape = {
        "schema": 1,
        "status": "success",
        "visibility": "public-anonymous-readback",
        "repository": value["repository"],
        "tag": value["tag"],
        "target_commitish": value["target_commitish"],
        "release_id": value["release_id"],
        "immutable": True,
        "assets": value["assets"],
    }
    validate_receipt(receipt_shape)
    return value


def verify_readback(arguments: argparse.Namespace) -> None:
    plan_value = validate_plan(
        load_json(pathlib.Path(arguments.plan), "candidate release readback plan")
    )
    root = pathlib.Path(arguments.asset_root)
    if root.is_symlink() or not root.is_dir():
        fail("candidate release readback root must be a real directory")
    expected = {asset["name"] for asset in plan_value["assets"]}
    actual = {path.name for path in root.iterdir()}
    if actual != expected:
        fail("anonymous candidate release readback has an unexpected inventory")
    for asset in plan_value["assets"]:
        path = root / asset["name"]
        if path.is_symlink() or not path.is_file():
            fail(f"anonymous candidate asset {asset['name']} is not regular")
        if (
            path.stat().st_size != asset["bytes"]
            or sha256_file(path) != asset["sha256"]
        ):
            fail(f"anonymous candidate asset {asset['name']} changed")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    plan_parser = commands.add_parser("plan")
    plan_parser.add_argument("--receipt", required=True)
    plan_parser.add_argument("--release", required=True)
    plan_parser.add_argument("--release-assets", required=True)
    plan_parser.add_argument("--repository", required=True)
    plan_parser.add_argument("--tag", required=True)
    plan_parser.add_argument("--target-commit", required=True)
    plan_parser.add_argument("--out", required=True)
    verify_parser = commands.add_parser("verify-readback")
    verify_parser.add_argument("--plan", required=True)
    verify_parser.add_argument("--asset-root", required=True)
    return parser.parse_args()


def main() -> int:
    arguments = parse_args()
    try:
        if arguments.command == "plan":
            plan(arguments)
        else:
            verify_readback(arguments)
    except (ReceiptError, OSError, json.JSONDecodeError) as error:
        print(f"homebrew-candidate-release-receipt: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
