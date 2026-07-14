#!/usr/bin/env bash
# scripts/compose-initial-index.sh — one-shot script to seed a release's
# index.toml from its existing archives.
#
# Used once per release tag during the
# binary-resolution-via-index-ledger migration (Phase 9 Task 9.3). For
# a release that already has N archives published from the legacy
# pipeline, this script:
#
#   1. Downloads every *.tar.zst archive from the release.
#   2. Runs `xtask build-index` against the downloaded set, which
#      decompresses each archive, parses its internal manifest.toml's
#      [compatibility] block, and emits a Success entry per
#      (package, arch).
#   3. Publishes the composed index through the crash-recoverable canonical
#      release-index transaction.
#
# Day-to-day publishes during CI matrix builds go through
# scripts/index-update.sh, not this script.
#
# Usage:
#   bash scripts/compose-initial-index.sh <target-tag> <abi-version>
#
# Example:
#   bash scripts/compose-initial-index.sh binaries-abi-v8 8
#
# Acquires the state-lock for the target tag so a concurrent
# scripts/index-update.sh from a still-active matrix-build won't race
# the upload.
set -euo pipefail

TARGET_TAG="${1:?usage: $0 <target-tag> <abi-version>}"
ABI="${2:?usage: $0 <target-tag> <abi-version>}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY required (e.g. owner/repo)}"

bash .github/scripts/state-lock.sh acquire "$TARGET_TAG"
trap 'bash .github/scripts/state-lock.sh release || true' EXIT

TMP="$(mktemp -d)"
ARCHIVES_DIR="$TMP/archives"
INDEX_PATH="$TMP/index.toml"
CURRENT_INDEX="$TMP/current-index.toml"
INDEX_HEAD="$TMP/index-head"
mkdir -p "$ARCHIVES_DIR"

# Recover any interrupted writer before composing a replacement. The current
# bytes are not an input to build-index, but its committed head fences publish.
bash scripts/release-index-state.sh read \
  --target-tag "$TARGET_TAG" \
  --expected-abi "$ABI" \
  --output "$CURRENT_INDEX" \
  --head-file "$INDEX_HEAD"

echo "compose-initial-index: downloading *.tar.zst from $TARGET_TAG..."
gh release download "$TARGET_TAG" \
  --repo "$GITHUB_REPOSITORY" \
  --pattern '*.tar.zst' \
  --dir "$ARCHIVES_DIR" \
  --clobber

archive_count="$(find "$ARCHIVES_DIR" -name '*.tar.zst' -type f | wc -l | tr -d ' ')"
echo "compose-initial-index: downloaded $archive_count archive(s)"

GENERATOR="compose-initial-index.sh @ $(git rev-parse HEAD)"
HOST_TRIPLE="$(rustc -vV | awk '/^host/ {print $2}')"
echo "compose-initial-index: running xtask build-index..."
cargo run --release -p xtask --target "$HOST_TRIPLE" --quiet -- \
  build-index \
    --abi "$ABI" \
    --generator "$GENERATOR" \
    --archives-dir "$ARCHIVES_DIR" \
    --out "$INDEX_PATH" \
    --generated-at "$(date -u +%FT%TZ)"

package_count="$(grep -c '^\[\[packages\]\]' "$INDEX_PATH" || true)"
echo "compose-initial-index: composed index lists $package_count package(s)"

echo "compose-initial-index: publishing index.toml to $TARGET_TAG..."
bash scripts/release-index-state.sh publish \
  --target-tag "$TARGET_TAG" \
  --expected-abi "$ABI" \
  --index-path "$INDEX_PATH" \
  --expected-head "$(cat "$INDEX_HEAD")"

echo "compose-initial-index: done. Verify with:"
echo "  curl -L https://github.com/$GITHUB_REPOSITORY/releases/download/$TARGET_TAG/index.toml | head -20"
