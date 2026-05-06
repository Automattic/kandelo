#!/usr/bin/env bash
#
# Backfill `[binary]` blocks into per-library package.toml files using
# the published release manifest. Reads `<staging>/manifest.json` (or
# the path given via --manifest), iterates entries with archive_name +
# archive_sha256, and rewrites
# `examples/libs/<program>/package.toml`'s `[binary]` block to point at
# the corresponding asset in the GitHub release.
#
# Usage:
#   scripts/backfill-binary-blocks.sh \
#       --manifest /tmp/wpk-release-2026-04-27/manifest.json \
#       --tag binaries-abi-v1 \
#       [--commit <sha>]
#
# When --commit is supplied, the script also stamps `[build].commit =
# <sha>` into each package.toml that has a `[build]` block. This is
# the Phase A-bis Task 5 publish-time writeback: the SHA of the
# building commit (typically `${{ github.sha }}` in a CI workflow,
# or `git rev-parse HEAD` for local maintainer runs) is recorded
# alongside the freshly-published archive. Packages without a
# `[build]` block (third-party archives, or first-party packages with
# no build script — kernel, userspace, examples, node, sqlite-cli,
# pcre2-source) are skipped silently.
#
# Idempotent: any existing `[binary]` block in the package.toml is
# replaced. Programs are wasm32-only in the first cut; multi-arch
# `[binary]` blocks are deferred (see
# docs/package-management-future-work.md).

set -euo pipefail

MANIFEST=""
TAG=""
COMMIT=""
while [ $# -gt 0 ]; do
    case "$1" in
        --manifest) MANIFEST="$2"; shift 2 ;;
        --tag)      TAG="$2"; shift 2 ;;
        --commit)   COMMIT="$2"; shift 2 ;;
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
    deps_toml="$REPO_ROOT/examples/libs/$program/package.toml"
    if [ ! -f "$deps_toml" ]; then
        echo "skip $program (no package.toml at $deps_toml)"
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

    # Phase A-bis Task 5: when --commit is supplied, also stamp the
    # building-commit SHA into [build].commit. Delegated to the
    # xtask subcommand so the in-place edit (which must preserve
    # existing comments + layout) lives in unit-tested Rust rather
    # than ad-hoc Python regex. The xtask helper is a silent no-op
    # for packages without a [build] block; we don't pre-filter here.
    if [ -n "$COMMIT" ]; then
        ( cd "$REPO_ROOT" && \
          cargo run --quiet --release -p xtask -- set-build-commit \
              --package-toml "$deps_toml" \
              --commit "$COMMIT" )
    fi
done
