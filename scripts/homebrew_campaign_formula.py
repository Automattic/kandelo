#!/usr/bin/env python3
"""Bind a campaign build Formula to its reserved bottle destination."""

from __future__ import annotations

import json
import os
import pathlib
import re
import shutil
import stat
import subprocess


SHA256 = re.compile(r"^[0-9a-f]{64}$")
VERSION = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+,-]{0,255}$")
MAX_FORMULA_BYTES = 4 * 1024 * 1024


class CampaignFormulaError(RuntimeError):
    """A campaign Formula could not be bound without changing its source."""


def formula_identity(
    path: pathlib.Path,
    *,
    repository_root: pathlib.Path,
) -> str:
    ruby = shutil.which("ruby")
    if ruby is None:
        raise CampaignFormulaError("trusted Ruby parser is unavailable")
    try:
        result = subprocess.run(
            [
                ruby,
                "--disable=gems,rubyopt",
                str(
                    repository_root
                    / "scripts/homebrew-formula-source-digest.rb"
                ),
                "--identity-excluding-bottle",
                str(path),
            ],
            check=False,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            env={
                "HOME": "/nonexistent",
                "LANG": "C.UTF-8",
                "LC_ALL": "C.UTF-8",
                "PATH": "/usr/bin:/bin",
            },
            timeout=60,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise CampaignFormulaError(
            f"cannot inspect campaign Formula identity: {error}"
        ) from error
    if result.returncode != 0:
        detail = result.stderr.decode(
            "utf-8", errors="replace"
        )[:8_192]
        raise CampaignFormulaError(
            f"cannot inspect campaign Formula identity: {detail}"
        )
    try:
        identity = result.stdout.decode("ascii").strip()
    except UnicodeDecodeError as error:
        raise CampaignFormulaError(
            f"campaign Formula identity is not ASCII: {error}"
        ) from error
    if SHA256.fullmatch(identity) is None:
        raise CampaignFormulaError(
            "campaign Formula identity is not a SHA-256 digest"
        )
    return identity


def guest_cellars(
    *, repository_root: pathlib.Path
) -> tuple[str, frozenset[str]]:
    path = repository_root / "homebrew/kandelo-guest-layout.json"
    try:
        payload = path.read_bytes()
        layout = json.loads(payload)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise CampaignFormulaError(
            f"cannot read Kandelo guest layout: {error}"
        ) from error
    if not isinstance(layout, dict):
        raise CampaignFormulaError(
            "Kandelo guest layout is not an object"
        )
    active_cellar = layout.get("cellar")
    retired_prefixes = layout.get("retired_prefixes")
    if not isinstance(active_cellar, str) or not active_cellar.startswith("/"):
        raise CampaignFormulaError("Kandelo guest Cellar is invalid")
    if (
        not isinstance(retired_prefixes, list)
        or any(
            not isinstance(value, str) or not value.startswith("/")
            for value in retired_prefixes
        )
    ):
        raise CampaignFormulaError(
            "Kandelo guest layout retired prefixes are invalid"
        )
    return active_cellar, frozenset(
        f"{prefix}/Cellar" for prefix in retired_prefixes
    )


def bind_formula_destination(
    path: pathlib.Path,
    destination_rebuild: int,
    expected_identity: str,
    source_version: str,
    previous_version: str | None,
    *,
    repository_root: pathlib.Path,
) -> bool:
    """Normalize build-only bottle metadata to a campaign destination."""
    if (
        not isinstance(destination_rebuild, int)
        or isinstance(destination_rebuild, bool)
        or destination_rebuild < 0
    ):
        raise CampaignFormulaError(
            "campaign destination bottle rebuild is invalid"
        )
    if SHA256.fullmatch(expected_identity) is None:
        raise CampaignFormulaError(
            "campaign Formula source identity is invalid"
        )
    if VERSION.fullmatch(source_version) is None or (
        previous_version is not None
        and VERSION.fullmatch(previous_version) is None
    ):
        raise CampaignFormulaError(
            "campaign Formula version transition is invalid"
        )
    try:
        metadata = path.lstat()
    except OSError as error:
        raise CampaignFormulaError(
            f"cannot inspect campaign target Formula: {error}"
        ) from error
    if (
        not stat.S_ISREG(metadata.st_mode)
        or path.is_symlink()
        or metadata.st_size > MAX_FORMULA_BYTES
    ):
        raise CampaignFormulaError(
            "campaign target Formula is not one bounded regular file"
        )
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as error:
        raise CampaignFormulaError(
            f"cannot read campaign target Formula: {error}"
        ) from error
    if not text.endswith("\n") or "\r" in text:
        raise CampaignFormulaError(
            "campaign target Formula has noncanonical line endings"
        )
    lines = text.splitlines(keepends=True)
    if (
        formula_identity(path, repository_root=repository_root)
        != expected_identity
    ):
        raise CampaignFormulaError(
            "campaign target Formula identity differs from the campaign"
        )
    starts = [
        index
        for index, line in enumerate(lines)
        if line == "  bottle do\n"
    ]
    if not starts:
        if destination_rebuild != 0:
            raise CampaignFormulaError(
                "campaign destination rebuild requires a bottle block"
            )
        return False
    if len(starts) != 1:
        raise CampaignFormulaError(
            "campaign target Formula has multiple bottle blocks"
        )
    start = starts[0]
    end = next(
        (
            index
            for index in range(start + 1, len(lines))
            if lines[index] == "  end\n"
        ),
        None,
    )
    if end is None:
        raise CampaignFormulaError(
            "campaign target Formula bottle block is unterminated"
        )
    rebuild_lines = [
        index
        for index in range(start + 1, end)
        if re.fullmatch(
            r"    rebuild (0|[1-9][0-9]*)\n", lines[index]
        )
    ]
    if len(rebuild_lines) > 1:
        raise CampaignFormulaError(
            "campaign target Formula repeats its bottle rebuild"
        )
    current_rebuild = (
        int(lines[rebuild_lines[0]].split()[1], 10)
        if rebuild_lines
        else 0
    )
    version_reset = (
        previous_version is not None
        and previous_version != source_version
        and destination_rebuild == 0
    )
    if current_rebuild > destination_rebuild and not version_reset:
        raise CampaignFormulaError(
            "campaign destination regresses the Formula bottle rebuild"
        )
    changed = current_rebuild != destination_rebuild
    if changed and rebuild_lines:
        if destination_rebuild == 0:
            # Homebrew represents rebuild zero by omitting the DSL line.
            # Writing `rebuild 0` would make the Formula noncanonical.
            del lines[rebuild_lines[0]]
            end -= 1
        else:
            lines[rebuild_lines[0]] = (
                f"    rebuild {destination_rebuild}\n"
            )
    elif changed:
        root_lines = [
            index
            for index in range(start + 1, end)
            if re.fullmatch(r'    root_url "[^"]+"\n', lines[index])
        ]
        if len(root_lines) != 1:
            raise CampaignFormulaError(
                "campaign target Formula bottle block lacks one root URL"
            )
        lines.insert(
            root_lines[0] + 1,
            f"    rebuild {destination_rebuild}\n",
        )
        end += 1

    active_cellar, retired_cellars = guest_cellars(
        repository_root=repository_root
    )
    bottle_line = re.compile(
        r'^(    sha256 cellar: )"([^"]+)'
        r'(", (?:wasm32|wasm64)_kandelo: "[0-9a-f]{64}"\n)$'
    )
    for index in range(start + 1, end):
        match = bottle_line.fullmatch(lines[index])
        if match is None:
            continue
        cellar = match.group(2)
        if cellar in retired_cellars:
            # WHY: this checkout is a synthetic, build-only commit and the
            # target is always source-built. Old SHA lines cannot be poured.
            # Normalizing their relocation Cellar keeps the Formula archived
            # inside the new bottle from reintroducing the retired prefix.
            lines[index] = (
                f'{match.group(1)}"{active_cellar}{match.group(3)}'
            )
            changed = True
        elif cellar != active_cellar:
            raise CampaignFormulaError(
                "campaign target Formula uses an unknown bottle Cellar"
            )
    if not changed:
        return False

    output = "".join(lines).encode("utf-8")
    temporary = path.with_name(
        f".{path.name}.destination-{os.getpid()}"
    )
    try:
        with temporary.open("xb") as handle:
            handle.write(output)
        temporary.chmod(stat.S_IMODE(metadata.st_mode))
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()
    if (
        formula_identity(path, repository_root=repository_root)
        != expected_identity
    ):
        raise CampaignFormulaError(
            "campaign destination changed Formula identity outside "
            "bottle metadata"
        )
    return True
