#!/usr/bin/env python3
"""Structured index selection for stacked PR package baselines."""

from __future__ import annotations

import argparse
import json
from pathlib import Path, PurePath
import re
import sys
import tomllib
from typing import Any


HEX_64 = re.compile(r"^[0-9a-f]{64}$")
PACKAGE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]*$")
ARCHES = {"wasm32", "wasm64"}
KINDS = {"library", "program"}


class BaselineError(ValueError):
    pass


def require_string(value: Any, context: str) -> str:
    if not isinstance(value, str) or not value:
        raise BaselineError(f"{context} must be a non-empty string")
    return value


def require_u32(value: Any, context: str) -> int:
    if (
        isinstance(value, bool)
        or not isinstance(value, int)
        or not 0 <= value <= 0xFFFFFFFF
    ):
        raise BaselineError(f"{context} must be an unsigned 32-bit integer")
    return value


def validate_sha(value: Any, context: str) -> str:
    value = require_string(value, context)
    if not HEX_64.fullmatch(value):
        raise BaselineError(f"{context} must be 64 lowercase hexadecimal characters")
    return value


def parse_requirements(path: Path) -> list[dict[str, Any]]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise BaselineError(f"read requirements {path}: {error}") from error
    if not isinstance(value, list):
        raise BaselineError("requirements must be a JSON array")

    seen: set[tuple[str, str]] = set()
    requirements: list[dict[str, Any]] = []
    for index, raw in enumerate(value):
        context = f"requirements[{index}]"
        if not isinstance(raw, dict):
            raise BaselineError(f"{context} must be an object")
        expected_fields = {"package", "version", "revision", "arch", "sha", "kind"}
        if set(raw) != expected_fields:
            raise BaselineError(
                f"{context} fields must be exactly {sorted(expected_fields)}, got {sorted(raw)}"
            )
        package = require_string(raw["package"], f"{context}.package")
        if not PACKAGE_NAME.fullmatch(package):
            raise BaselineError(f"{context}.package has an unsafe name: {package!r}")
        version = require_string(raw["version"], f"{context}.version")
        revision = require_u32(raw["revision"], f"{context}.revision")
        arch = require_string(raw["arch"], f"{context}.arch")
        if arch not in ARCHES:
            raise BaselineError(f"{context}.arch must be wasm32 or wasm64")
        kind = require_string(raw["kind"], f"{context}.kind")
        if kind not in KINDS:
            raise BaselineError(f"{context}.kind must be library or program")
        sha = validate_sha(raw["sha"], f"{context}.sha")
        pair = (package, arch)
        if pair in seen:
            raise BaselineError(f"duplicate requirement for {package}/{arch}")
        seen.add(pair)
        requirements.append(
            {
                "package": package,
                "version": version,
                "revision": revision,
                "arch": arch,
                "sha": sha,
                "kind": kind,
            }
        )
    return requirements


def parse_index(path: Path) -> dict[str, Any]:
    try:
        value = tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, tomllib.TOMLDecodeError) as error:
        raise BaselineError(f"read index {path}: {error}") from error
    if not isinstance(value, dict):
        raise BaselineError("index.toml must be a TOML table")
    return value


def select_entries(
    index: dict[str, Any], requirements: list[dict[str, Any]], expected_abi: int
) -> list[dict[str, Any]]:
    abi = require_u32(index.get("abi_version"), "index.abi_version")
    if abi != expected_abi:
        return []
    packages = index.get("packages", [])
    if not isinstance(packages, list):
        raise BaselineError("index.packages must be an array of tables")

    selected: list[dict[str, Any]] = []
    for requirement in requirements:
        matches = [
            package
            for package in packages
            if isinstance(package, dict)
            and package.get("name") == requirement["package"]
            and package.get("version") == requirement["version"]
        ]
        if len(matches) > 1:
            raise BaselineError(
                f"index contains duplicate entries for {requirement['package']}@{requirement['version']}"
            )
        if not matches:
            continue
        package = matches[0]
        if require_u32(package.get("revision"), "package.revision") != requirement["revision"]:
            continue
        binaries = package.get("binary", {})
        if not isinstance(binaries, dict):
            raise BaselineError(f"{requirement['package']} binary field must be a table")
        entry = binaries.get(requirement["arch"])
        if entry is None:
            continue
        if not isinstance(entry, dict):
            raise BaselineError(
                f"{requirement['package']}/{requirement['arch']} entry must be a table"
            )
        if entry.get("status") != "success" or entry.get("cache_key_sha") != requirement["sha"]:
            continue

        context = f"{requirement['package']}/{requirement['arch']} success entry"
        archive_name = require_string(entry.get("archive_url"), f"{context}.archive_url")
        archive_sha = validate_sha(entry.get("archive_sha256"), f"{context}.archive_sha256")
        built_by = require_string(entry.get("built_by"), f"{context}.built_by")
        expected_name = (
            f"{requirement['package']}-{requirement['version']}"
            f"-rev{requirement['revision']}-abi{expected_abi}"
            f"-{requirement['arch']}-{requirement['sha'][:8]}.tar.zst"
        )
        if archive_name != expected_name or PurePath(archive_name).name != archive_name:
            raise BaselineError(
                f"{context}.archive_url is not canonical: {archive_name!r}; "
                f"expected {expected_name!r}"
            )
        selected.append(
            {
                **requirement,
                "archive_name": archive_name,
                "archive_sha256": archive_sha,
                "built_by": built_by,
            }
        )
    return selected


def command_select(args: argparse.Namespace) -> None:
    requirements = parse_requirements(args.requirements)
    index = parse_index(args.index)
    expected_abi = require_u32(args.expected_abi, "--expected-abi")
    selected = select_entries(index, requirements, expected_abi)
    args.output.write_text(json.dumps(selected, indent=2) + "\n", encoding="utf-8")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    select = subparsers.add_parser("select")
    select.add_argument("--index", type=Path, required=True)
    select.add_argument("--requirements", type=Path, required=True)
    select.add_argument("--output", type=Path, required=True)
    select.add_argument("--expected-abi", type=int, required=True)
    select.set_defaults(run=command_select)
    return parser.parse_args()


def main() -> int:
    try:
        args = parse_args()
        args.run(args)
        return 0
    except BaselineError as error:
        print(f"stacked_pr_baseline.py: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
