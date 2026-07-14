#!/usr/bin/env bash
# Finalize a verified target snapshot, optionally overlaying a separately
# verified canonical supplement. Inputs are produced by
# validate-staging-release.sh; this helper performs no network access.
set -euo pipefail

TARGET_DIR=""
CANONICAL_DIR=""
OVERLAY_EXPECTED=""
OUTPUT_DIR=""
XTASK=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --target-dir) TARGET_DIR="$2"; shift 2 ;;
    --canonical-dir) CANONICAL_DIR="$2"; shift 2 ;;
    --overlay-expected-ledger) OVERLAY_EXPECTED="$2"; shift 2 ;;
    --output-dir) OUTPUT_DIR="$2"; shift 2 ;;
    --xtask) XTASK="$2"; shift 2 ;;
    *) echo "compose-staging-release-snapshots: unknown flag $1" >&2; exit 2 ;;
  esac
done

if [ ! -f "$TARGET_DIR/archives/index.toml" ] ||
   [ -z "$OUTPUT_DIR" ] || [ "$OUTPUT_DIR" = / ] || [ -e "$OUTPUT_DIR" ]; then
  echo "compose-staging-release-snapshots: valid target and new output directory are required" >&2
  exit 2
fi

if [ -z "$CANONICAL_DIR" ]; then
  mv "$TARGET_DIR" "$OUTPUT_DIR"
  printf 'file://%s/index.toml\n' "$OUTPUT_DIR/archives" > "$OUTPUT_DIR/index-url.txt"
  test -f "$OUTPUT_DIR/archives/index.toml"
  echo "compose-staging-release-snapshots: finalized target-only snapshot"
  exit 0
fi

if [ ! -f "$CANONICAL_DIR/archives/index.toml" ] ||
   [ ! -f "$OVERLAY_EXPECTED" ] || [ ! -x "$XTASK" ]; then
  echo "compose-staging-release-snapshots: canonical snapshot, overlay ledger, and xtask are required for a union" >&2
  exit 2
fi

mkdir -p "$OUTPUT_DIR/archives"
for source in "$TARGET_DIR/archives" "$CANONICAL_DIR/archives"; do
  for archive in "$source"/*.tar.zst; do
    dest="$OUTPUT_DIR/archives/$(basename "$archive")"
    if [ -e "$dest" ]; then
      if ! cmp -s "$archive" "$dest"; then
        echo "compose-staging-release-snapshots: archive basename collision with different bytes: $(basename "$archive")" >&2
        exit 1
      fi
    else
      cp "$archive" "$dest"
    fi
  done
done

"$XTASK" staging-reuse compose \
  --base-index "$TARGET_DIR/index.toml" \
  --overlay-index "$CANONICAL_DIR/index.toml" \
  --overlay-expected-ledger "$OVERLAY_EXPECTED" \
  --output "$OUTPUT_DIR/archives/index.toml"
printf 'file://%s/index.toml\n' "$OUTPUT_DIR/archives" > "$OUTPUT_DIR/index-url.txt"
echo "compose-staging-release-snapshots: finalized target + canonical snapshot"
