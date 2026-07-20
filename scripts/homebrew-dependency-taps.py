#!/usr/bin/env python3
"""Validate and materialize immutable external Homebrew tap dependencies."""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import re
import stat
import subprocess
import sys
from typing import Any


MAX_LOCK_BYTES = 65_536
MAX_TAPS = 8
COMMIT = re.compile(r"^[0-9a-f]{40}$")
TAP_NAME = re.compile(r"^[a-z0-9_.-]+/[a-z0-9_.-]+$")
REPOSITORY = re.compile(r"^[a-z0-9_.-]+/homebrew-[a-z0-9_.-]+$")

# The first cross-tap publication proof intentionally has a narrow reviewed
# trust policy.  The resolved document and all downstream graph handling are
# generic, but adding another source repository remains a Kandelo code review.
ALLOWED_DEPENDENCY_TAPS = {
    "kandelo-dev/tap-core": "kandelo-dev/homebrew-tap-core",
}


class TapLockError(RuntimeError):
    pass


def fail(message: str) -> None:
    raise TapLockError(message)


def exact_object(value: Any, keys: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        fail(f"{label} must contain exactly {sorted(keys)}")
    return value


def conventional_tap_name(repository: str) -> str:
    normalized = repository.lower()
    if REPOSITORY.fullmatch(normalized) is None:
        fail(f"invalid conventional tap repository: {repository!r}")
    owner, repo = normalized.split("/", 1)
    return f"{owner}/{repo.removeprefix('homebrew-')}"


def validate_identity(name: Any, repository: Any, label: str) -> tuple[str, str]:
    if not isinstance(name, str) or name != name.lower() or TAP_NAME.fullmatch(name) is None:
        fail(f"{label}.tap_name must be a normalized owner/name")
    if (
        not isinstance(repository, str)
        or repository != repository.lower()
        or REPOSITORY.fullmatch(repository) is None
    ):
        fail(f"{label}.tap_repository must be a normalized owner/homebrew-name")
    if conventional_tap_name(repository) != name:
        fail(f"{label} tap name does not match its conventional repository")
    return name, repository


def regular_lock(path: pathlib.Path) -> pathlib.Path:
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        fail(f"dependency tap lock does not exist: {path}")
    if path.is_symlink() or not stat.S_ISREG(metadata.st_mode):
        fail(f"dependency tap lock must be a regular non-symlink file: {path}")
    if metadata.st_size > MAX_LOCK_BYTES:
        fail(f"dependency tap lock exceeds {MAX_LOCK_BYTES} bytes")
    return path


def load_lock(tap_root: pathlib.Path) -> dict[str, Any]:
    requested_root = tap_root
    if requested_root.is_symlink() or not requested_root.is_dir():
        fail(f"tap root must be a real directory: {requested_root}")
    root = requested_root.resolve()
    policy_dir = root / "Kandelo"
    if policy_dir.is_symlink():
        fail("tap Kandelo policy directory must not be a symlink")
    lock_path = policy_dir / "dependency-taps.json"
    if not lock_path.exists() and not lock_path.is_symlink():
        return {"schema": 1, "taps": []}
    if not policy_dir.is_dir():
        fail("tap Kandelo policy path must be a real directory")
    regular_lock(lock_path)
    if lock_path.resolve().parent != policy_dir.resolve():
        fail("dependency tap lock resolves outside the exact tap checkout")
    try:
        value = json.loads(lock_path.read_text(encoding="utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        fail(f"dependency tap lock is not valid UTF-8 JSON: {error}")
    root_value = exact_object(value, {"schema", "taps"}, "dependency tap lock")
    if root_value["schema"] != 1:
        fail("dependency tap lock schema must be 1")
    taps = root_value["taps"]
    if not isinstance(taps, list) or len(taps) > MAX_TAPS:
        fail(f"dependency tap lock must contain at most {MAX_TAPS} taps")

    normalized: list[dict[str, str]] = []
    seen_names: set[str] = set()
    seen_repositories: set[str] = set()
    prior_name = ""
    for index, raw in enumerate(taps):
        item = exact_object(
            raw,
            {"tap_name", "tap_repository", "tap_commit"},
            f"dependency tap lock taps[{index}]",
        )
        name, repository = validate_identity(
            item["tap_name"], item["tap_repository"], f"dependency tap lock taps[{index}]"
        )
        commit = item["tap_commit"]
        if not isinstance(commit, str) or COMMIT.fullmatch(commit) is None:
            fail(f"dependency tap lock taps[{index}].tap_commit must be an exact lowercase SHA")
        if name <= prior_name:
            fail("dependency tap lock taps must be uniquely sorted by tap_name")
        prior_name = name
        if name in seen_names or repository in seen_repositories:
            fail("dependency tap lock repeats a tap name or repository")
        seen_names.add(name)
        seen_repositories.add(repository)
        if ALLOWED_DEPENDENCY_TAPS.get(name) != repository:
            fail(f"dependency tap {name!r} is not in the reviewed public-tap policy")
        normalized.append(
            {"tap_name": name, "tap_repository": repository, "tap_commit": commit}
        )
    return {"schema": 1, "taps": normalized}


def git_output(root: pathlib.Path, *arguments: str) -> str:
    try:
        result = subprocess.run(
            ["git", "-C", str(root), *arguments],
            check=False,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=30,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as error:
        fail(f"could not inspect dependency tap checkout {root}: {error}")
    if result.returncode != 0:
        stderr = result.stderr.decode("utf-8", errors="replace")[:2_048]
        fail(f"could not inspect dependency tap checkout {root}: {stderr}")
    try:
        return result.stdout.decode("utf-8").strip()
    except UnicodeDecodeError as error:
        fail(f"dependency tap git output is not UTF-8: {error}")


def checkout_root(value: str, label: str) -> pathlib.Path:
    candidate = pathlib.Path(value)
    if candidate.is_symlink() or not candidate.is_dir():
        fail(f"{label} must be a real directory: {candidate}")
    root = candidate.resolve()
    formula_dir = root / "Formula"
    if formula_dir.is_symlink() or not formula_dir.is_dir():
        fail(f"{label} Formula directory must be a real directory")
    return root


def verify_checkout(root: pathlib.Path, expected_commit: str, label: str) -> None:
    if git_output(root, "rev-parse", "HEAD") != expected_commit:
        fail(f"{label} HEAD differs from the exact locked commit")
    if git_output(root, "status", "--short", "--untracked-files=all"):
        fail(f"{label} has local modifications")


def write_json(path: pathlib.Path, value: Any, mode: int = 0o444) -> None:
    if path.is_symlink():
        fail(f"refusing to replace symlink output: {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(value, indent=2, sort_keys=True) + "\n"
    if len(payload.encode("utf-8")) > MAX_LOCK_BYTES:
        fail(f"resolved dependency tap document exceeds {MAX_LOCK_BYTES} bytes")
    temporary = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    temporary.write_text(payload, encoding="utf-8")
    temporary.chmod(mode)
    os.replace(temporary, path)


def validate_command(args: argparse.Namespace) -> None:
    primary_name, primary_repository = validate_identity(
        args.tap_name, args.tap_repository, "primary tap"
    )
    document = load_lock(pathlib.Path(args.tap_root))
    for item in document["taps"]:
        if item["tap_name"] == primary_name or item["tap_repository"] == primary_repository:
            fail("dependency tap lock must not repeat the primary tap")
    if args.out:
        write_json(pathlib.Path(args.out), document, mode=0o644)
    else:
        json.dump(document, sys.stdout, sort_keys=True, separators=(",", ":"))
        sys.stdout.write("\n")


def parse_roots(values: list[str]) -> dict[str, pathlib.Path]:
    roots: dict[str, pathlib.Path] = {}
    for raw in values:
        name, separator, path = raw.partition("=")
        if not separator or TAP_NAME.fullmatch(name) is None or name != name.lower() or not path:
            fail("--dependency-root must use normalized-owner/name=/absolute/checkout")
        if name in roots:
            fail(f"duplicate --dependency-root for {name}")
        roots[name] = checkout_root(path, f"dependency tap {name}")
    return roots


def resolve_command(args: argparse.Namespace) -> None:
    primary_name, primary_repository = validate_identity(
        args.tap_name, args.tap_repository, "primary tap"
    )
    if COMMIT.fullmatch(args.tap_commit or "") is None:
        fail("primary tap commit must be an exact lowercase SHA")
    primary_root = checkout_root(args.tap_root, "primary tap root")
    verify_checkout(primary_root, args.tap_commit, "primary tap checkout")
    lock = load_lock(primary_root)
    dependency_roots = parse_roots(args.dependency_root)
    expected_names = {item["tap_name"] for item in lock["taps"]}
    if set(dependency_roots) != expected_names:
        fail(
            "dependency tap checkout set differs from the committed lock "
            f"(missing={sorted(expected_names - set(dependency_roots))}, "
            f"unexpected={sorted(set(dependency_roots) - expected_names)})"
        )
    resolved_dependencies = []
    for item in lock["taps"]:
        root = dependency_roots[item["tap_name"]]
        verify_checkout(root, item["tap_commit"], f"dependency tap {item['tap_name']}")
        resolved_dependencies.append({**item, "root": str(root)})
    resolved = {
        "schema": 1,
        "primary": {
            "tap_name": primary_name,
            "tap_repository": primary_repository,
            "tap_commit": args.tap_commit,
            "root": str(primary_root),
        },
        "dependencies": resolved_dependencies,
    }
    write_json(pathlib.Path(args.out), resolved)


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    commands = root.add_subparsers(dest="command", required=True)
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--tap-root", required=True)
    common.add_argument("--tap-name", required=True)
    common.add_argument("--tap-repository", required=True)

    validate_parser = commands.add_parser("validate", parents=[common])
    validate_parser.add_argument("--out")
    validate_parser.set_defaults(handler=validate_command)

    resolve_parser = commands.add_parser("resolve", parents=[common])
    resolve_parser.add_argument("--tap-commit", required=True)
    resolve_parser.add_argument("--dependency-root", action="append", default=[])
    resolve_parser.add_argument("--out", required=True)
    resolve_parser.set_defaults(handler=resolve_command)
    return root


def main() -> int:
    args = parser().parse_args()
    try:
        args.handler(args)
    except TapLockError as error:
        print(f"homebrew-dependency-taps.py: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
