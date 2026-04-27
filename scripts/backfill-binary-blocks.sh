#!/usr/bin/env bash
#
# Backfill `[binary]` blocks into per-library deps.toml files using
# the published release manifest. Reads `<staging>/manifest.json` (or
# the path given via --manifest), iterates entries with archive_name +
# archive_sha256, and rewrites
# `examples/libs/<program>/deps.toml`'s `[binary]` block to point at
# the corresponding asset in the GitHub release.
#
# Usage:
#   scripts/backfill-binary-blocks.sh \
#       --manifest /tmp/wpk-release-2026-04-27/manifest.json \
#       --tag binaries-abi-v1
#
# Idempotent: any existing `[binary]` block in the deps.toml is
# replaced. Programs are wasm32-only in the first cut; multi-arch
# `[binary]` blocks are deferred (see
# docs/package-management-future-work.md).

set -euo pipefail

MANIFEST=""
TAG=""
while [ $# -gt 0 ]; do
    case "$1" in
        --manifest) MANIFEST="$2"; shift 2 ;;
        --tag)      TAG="$2"; shift 2 ;;
        *) echo "unknown arg $1" >&2; exit 2 ;;
    esac
done
[ -n "$MANIFEST" ] || { echo "--manifest is required" >&2; exit 2; }
[ -n "$TAG" ] || { echo "--tag is required" >&2; exit 2; }
[ -f "$MANIFEST" ] || { echo "manifest not found: $MANIFEST" >&2; exit 1; }

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="https://github.com/brandonpayton/wasm-posix-kernel/releases/download/$TAG"

# Filter to wasm32 archive entries only (first-release scope).
jq -r '.entries[]
       | select(.archive_name != null and .arch == "wasm32")
       | [.program, .archive_name, .archive_sha256] | @tsv' \
   "$MANIFEST" |
while IFS=$'\t' read -r program archive_name archive_sha; do
    deps_toml="$REPO_ROOT/examples/libs/$program/deps.toml"
    if [ ! -f "$deps_toml" ]; then
        echo "skip $program (no deps.toml at $deps_toml)"
        continue
    fi
    python3 - "$deps_toml" "$BASE/$archive_name" "$archive_sha" <<'PY'
import sys, re, pathlib
path = pathlib.Path(sys.argv[1])
url, sha = sys.argv[2], sys.argv[3]
text = path.read_text()
block = (
    f'\n[binary]\n'
    f'archive_url = "{url}"\n'
    f'archive_sha256 = "{sha}"\n'
)
# Replace any existing [binary] block (matches up to next top-level
# [section] or end-of-file).
stripped = re.sub(r'\n\[binary\][^\[]*', '\n', text, flags=re.S)
stripped = stripped.rstrip() + block
path.write_text(stripped)
PY
    echo "wrote [binary] for $program"
done
