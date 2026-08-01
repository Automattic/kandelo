#!/usr/bin/env python3
"""Render and validate immutable Kandelo candidate workflow callers."""

from __future__ import annotations

import argparse
import pathlib
import re
import shutil
import sys
import tempfile
from typing import NoReturn


COMMIT = re.compile(r"^[0-9a-f]{40}$")
BASE_TOKEN = "__KANDELO_CANDIDATE_BASE_SHA__"
MERGE_TOKEN = "__KANDELO_CANDIDATE_MERGE_SHA__"
WORKFLOW_ROOT = pathlib.Path(".github/workflows")
CALLERS = {
    "campaign": (
        "candidate-campaign.yml",
        ["reusable-homebrew-candidate-campaign.yml"],
    ),
    "bottle": (
        "candidate-bottles.yml",
        ["reusable-homebrew-bottle-publish.yml"],
    ),
    "promotion": (
        "promote-candidate-bottle.yml",
        [
            "reusable-homebrew-bottle-candidate-materialize.yml",
            "reusable-homebrew-bottle-publish.yml",
        ],
    ),
}
USES = re.compile(
    r"^[ ]+uses: Automattic/kandelo/\.github/workflows/"
    r"([A-Za-z0-9._-]+)@([^\s]+)[ ]*$",
    re.MULTILINE,
)


class CallerPinError(ValueError):
    """A candidate caller did not satisfy the immutable pin contract."""


def fail(message: str) -> NoReturn:
    raise CallerPinError(message)


def require_commit(value: str, label: str) -> str:
    if COMMIT.fullmatch(value) is None:
        fail(f"{label} must be an exact lowercase commit SHA")
    return value


def real_root(path: pathlib.Path, label: str) -> pathlib.Path:
    if path.is_symlink() or not path.is_dir():
        fail(f"{label} must be a real directory")
    return path.resolve()


def read_caller(root: pathlib.Path, mode: str) -> tuple[pathlib.Path, str]:
    filename, _expected = CALLERS[mode]
    path = root / WORKFLOW_ROOT / filename
    if path.is_symlink() or not path.is_file():
        fail(f"{mode} caller must be a regular file")
    if path.stat().st_size > 256 * 1024:
        fail(f"{mode} caller exceeds its byte bound")
    return path, path.read_text(encoding="utf-8")


def validate_text(text: str, mode: str, expected_sha: str) -> None:
    expected_sha = require_commit(expected_sha, "candidate caller authority")
    _filename, expected_workflows = CALLERS[mode]
    found = USES.findall(text)
    wanted = [(workflow, expected_sha) for workflow in expected_workflows]
    if found != wanted:
        fail(
            f"{mode} caller must pin exactly {expected_workflows} to "
            f"{expected_sha}"
        )
    if "@main" in text or BASE_TOKEN in text or MERGE_TOKEN in text:
        fail(f"{mode} caller still contains a mutable or unresolved authority")


def validate(arguments: argparse.Namespace) -> None:
    root = real_root(pathlib.Path(arguments.tap_root), "candidate caller root")
    _path, text = read_caller(root, arguments.mode)
    validate_text(text, arguments.mode, arguments.kandelo_sha)


def render(arguments: argparse.Namespace) -> None:
    template = real_root(
        pathlib.Path(arguments.template_root), "candidate caller template root"
    )
    output = pathlib.Path(arguments.out)
    if output.exists() or output.is_symlink():
        fail("rendered candidate caller output already exists")
    base = require_commit(arguments.base_sha, "candidate base")
    merge = require_commit(arguments.merge_sha, "candidate merge")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = pathlib.Path(
        tempfile.mkdtemp(prefix=f".{output.name}.", dir=output.parent)
    )
    try:
        destination = temporary / WORKFLOW_ROOT
        destination.mkdir(parents=True)
        for mode, (filename, _workflows) in CALLERS.items():
            source, text = read_caller(template, mode)
            expected_token = MERGE_TOKEN if mode == "promotion" else BASE_TOKEN
            unwanted_token = BASE_TOKEN if mode == "promotion" else MERGE_TOKEN
            expected_count = 2 if mode == "promotion" else 1
            if text.count(expected_token) != expected_count or unwanted_token in text:
                fail(f"{mode} caller template has an invalid placeholder contract")
            rendered = text.replace(BASE_TOKEN, base).replace(MERGE_TOKEN, merge)
            target = destination / filename
            target.write_text(rendered, encoding="utf-8")
            validate_text(rendered, mode, merge if mode == "promotion" else base)
            if source.stat().st_mode & 0o111:
                target.chmod(target.stat().st_mode | 0o111)
        shutil.move(str(temporary), str(output))
    except Exception:
        shutil.rmtree(temporary, ignore_errors=True)
        raise


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    validate_parser = commands.add_parser("validate")
    validate_parser.add_argument("--tap-root", required=True)
    validate_parser.add_argument(
        "--mode", choices=tuple(CALLERS), required=True
    )
    validate_parser.add_argument("--kandelo-sha", required=True)
    render_parser = commands.add_parser("render")
    render_parser.add_argument("--template-root", required=True)
    render_parser.add_argument("--base-sha", required=True)
    render_parser.add_argument("--merge-sha", required=True)
    render_parser.add_argument("--out", required=True)
    return parser.parse_args()


def main() -> int:
    arguments = parse_args()
    try:
        if arguments.command == "validate":
            validate(arguments)
        else:
            render(arguments)
    except (CallerPinError, OSError, UnicodeError) as error:
        print(f"homebrew-candidate-caller-pins: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
