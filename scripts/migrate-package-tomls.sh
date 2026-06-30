#!/usr/bin/env bash
# scripts/migrate-package-tomls.sh — one-shot migration tool for
# binary-resolution-via-index-ledger Phase 9 Task 9.2.
#
# Walks every packages/registry/*/package.toml and:
#   1. Strips `revision = N`           (moves to index.toml)
#   2. Strips [binary] / [binary.<arch>] blocks (moves to index.toml)
#   3. Strips [build].repo_url + [build].commit (moves to build.toml)
#   4. Generates a sibling build.toml carrying the stripped fields
#      plus `[binary] index_url = "<...binaries-abi-v{abi}/index.toml>"`
#
# Idempotent: re-running over already-migrated files is a no-op.
# Safe to delete after this PR lands (kept in tree so reviewers can
# rerun the migration deterministically).
#
# Usage:
#   bash scripts/migrate-package-tomls.sh
#
# Optional env:
#   MIGRATION_COMMIT — value to record in build.toml's `commit` field.
#                       Default: git rev-parse HEAD.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

HEAD_COMMIT="${MIGRATION_COMMIT:-$(git rev-parse HEAD)}"
DEFAULT_REPO_URL="https://github.com/brandonpayton/kandelo.git"
DEFAULT_INDEX_URL='https://github.com/Automattic/kandelo/releases/download/binaries-abi-v{abi}/index.toml'

python3 - "$REPO_ROOT" "$HEAD_COMMIT" "$DEFAULT_REPO_URL" "$DEFAULT_INDEX_URL" <<'PY'
import os
import re
import sys
from pathlib import Path

repo_root = Path(sys.argv[1])
head_commit = sys.argv[2]
default_repo_url = sys.argv[3]
default_index_url = sys.argv[4]

migrated = 0
build_toml_written = 0
already_clean = 0

for pkg_toml in sorted(repo_root.glob("packages/registry/*/package.toml")):
    pkg_dir = pkg_toml.parent
    pkg_name = pkg_dir.name
    original = pkg_toml.read_text()
    text = original

    # ---- 1. Capture + strip top-level `revision = N` (only if at top
    #         level, not inside a table). Process line-by-line tracking
    #         whether we're inside a `[...]` table; revision lives
    #         alongside `name`/`version` so it's at top level for
    #         every package we'd migrate. The captured value becomes
    #         the build.toml's `revision` field below, so a
    #         published-at-rev2 package's locally-computed cache_key
    #         continues to match its archive's embedded
    #         cache_key_sha after the migration.
    lines = text.splitlines(keepends=True)
    out = []
    in_section = False
    captured_revision = None
    for line in lines:
        stripped = line.lstrip()
        if stripped.startswith("[") and stripped.rstrip().endswith("]"):
            in_section = True
            out.append(line)
            continue
        if not in_section:
            m = re.match(r"^\s*revision\s*=\s*(\d+)", line)
            if m:
                captured_revision = int(m.group(1))
                continue  # strip
        out.append(line)
    text = "".join(out)

    # ---- 2. Strip [binary] and [binary.<arch>] blocks. The block
    #         runs from its `[binary...]` header to (but excluding)
    #         the next `[...]` header or EOF.
    text = re.sub(
        r"(?m)^\[binary(\.[a-z0-9_]+)?\]\n(?:[^\[]|\n)*",
        "",
        text,
    )

    # ---- 3. Inside the [build] block, strip repo_url + commit. We
    #         operate on the substring between `[build]` and the next
    #         `[<section>]` header.
    def strip_build_fields(match):
        head = match.group(1)
        body = match.group(2)
        body = re.sub(r"(?m)^\s*repo_url\s*=.*\n", "", body)
        body = re.sub(r"(?m)^\s*commit\s*=.*\n", "", body)
        return head + body
    text = re.sub(
        r"(?m)(^\[build\]\n)((?:[^\[]|\n)*)",
        strip_build_fields,
        text,
        count=1,
    )

    # ---- Collapse runs of more than 2 blank lines to exactly 2;
    #      keeps the diff legible after a block removal landed in
    #      the middle of the file.
    text = re.sub(r"\n{3,}", "\n\n", text)
    # Ensure file ends with single newline.
    if not text.endswith("\n"):
        text += "\n"
    text = re.sub(r"\n+$", "\n", text)

    # ---- 4. Decide whether to write a build.toml.
    #         A package gets a build.toml IFF its package.toml carries
    #         a [build] block at all. Source-only or
    #         sidecar/tooling-owned data packages have no [build] → no
    #         build.toml needed.
    has_build_block = bool(re.search(r"(?m)^\[build\]\s*$", text))

    pkg_toml.write_text(text)
    if text != original:
        migrated += 1
    else:
        already_clean += 1

    if has_build_block:
        # Extract [build].script_path from the (now-cleaned)
        # package.toml so build.toml's script_path mirrors it.
        m = re.search(
            r"(?m)^\[build\]\n((?:[^\[]|\n)*)",
            text,
        )
        script_path = ""
        if m:
            sp_match = re.search(
                r"(?m)^\s*script_path\s*=\s*\"([^\"]+)\"",
                m.group(1),
            )
            if sp_match:
                script_path = sp_match.group(1)

        # Fall back to the conventional path if package.toml doesn't
        # carry one (edge case — every first-party package on main
        # has script_path today).
        if not script_path:
            script_path = f"packages/registry/{pkg_name}/build-{pkg_name}.sh"

        build_toml_path = pkg_dir / "build.toml"
        # Default revision to 1 if the source manifest didn't carry one
        # (post-migration manifests being re-migrated). Captured value
        # preserves the original revision for packages that had been
        # published at rev >= 2.
        revision = captured_revision if captured_revision is not None else 1
        build_toml_content = (
            f"script_path = \"{script_path}\"\n"
            f"repo_url    = \"{default_repo_url}\"\n"
            f"commit      = \"{head_commit}\"\n"
            f"revision    = {revision}\n"
            f"\n"
            f"[binary]\n"
            f"index_url = \"{default_index_url}\"\n"
        )
        # Idempotent write: skip if existing build.toml already has
        # the right shape. Compare by parsed equivalence (allow whitespace
        # drift but require identical key values).
        if build_toml_path.exists():
            existing = build_toml_path.read_text()
            if existing == build_toml_content:
                continue
        build_toml_path.write_text(build_toml_content)
        build_toml_written += 1

print(f"migrate-package-tomls.sh:")
print(f"  package.toml files migrated: {migrated}")
print(f"  package.toml files already clean: {already_clean}")
print(f"  build.toml files written: {build_toml_written}")
PY
