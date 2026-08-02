#!/usr/bin/env bash
# Compose the canonical lazy shell from one authenticated public input set.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PREPARED_INPUTS=""
WORK_DIR=""
OUT=""
REPORT=""
BOTTLE_CACHE=""
REVIEW_PENDING=false

usage() {
  cat <<'EOF'
Usage: scripts/build-homebrew-main-shell-product.sh \
  --prepared-inputs <directory> --work-dir <new-directory> [options]

Options:
  --out <image.vfs.zst>
  --report <report.json>
  --bottle-cache <directory>
  --review-pending-artifact
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --prepared-inputs) PREPARED_INPUTS="${2:-}"; shift 2 ;;
    --work-dir) WORK_DIR="${2:-}"; shift 2 ;;
    --out) OUT="${2:-}"; shift 2 ;;
    --report) REPORT="${2:-}"; shift 2 ;;
    --bottle-cache) BOTTLE_CACHE="${2:-}"; shift 2 ;;
    --review-pending-artifact) REVIEW_PENDING=true; shift ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "build-homebrew-main-shell-product: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ -z "$PREPARED_INPUTS" ] || [ ! -d "$PREPARED_INPUTS" ] ||
   [ -L "$PREPARED_INPUTS" ]; then
  echo "build-homebrew-main-shell-product: prepared inputs must be a real directory" >&2
  exit 2
fi
if [ -z "$WORK_DIR" ]; then
  echo "build-homebrew-main-shell-product: --work-dir is required" >&2
  exit 2
fi

SELECTION="$PREPARED_INPUTS/selection"
RECEIPT="$PREPARED_INPUTS/selection-receipt.json"
BOOTSTRAP="$PREPARED_INPUTS/bootstrap"
for required in \
  "$SELECTION/selection.json" \
  "$SELECTION/tap/Kandelo/metadata.json" \
  "$RECEIPT" \
  "$BOOTSTRAP/homebrew-bootstrap.zip" \
  "$BOOTSTRAP/homebrew-brew.env" \
  "$BOOTSTRAP/report.json"; do
  [ -e "$required" ] && [ ! -L "$required" ] || {
    echo "build-homebrew-main-shell-product: prepared inputs omit $required" >&2
    exit 2
  }
done

EXPECTED_TAP_SHA="$(jq -er '.catalog.tap_commit' \
  "$REPO_ROOT/homebrew/main-shell-migration-lock.json")"
arguments=(
  --lazy-shell
  --closed-selection-root "$SELECTION"
  --closed-selection-receipt "$RECEIPT"
  --expected-tap-sha "$EXPECTED_TAP_SHA"
  --work-dir "$WORK_DIR"
  --package-tree-spec \
    "$REPO_ROOT/homebrew/main-shell-brew-package-tree.json"
  --package-tree-archive "$BOOTSTRAP/homebrew-bootstrap.zip"
  --homebrew-bootstrap-env "$BOOTSTRAP/homebrew-brew.env"
  --homebrew-bootstrap-bottle-report "$BOOTSTRAP/report.json"
)
[ -z "$OUT" ] || arguments+=(--out "$OUT")
[ -z "$REPORT" ] || arguments+=(--report "$REPORT")
[ -z "$BOTTLE_CACHE" ] || arguments+=(--bottle-cache "$BOTTLE_CACHE")
if [ "$REVIEW_PENDING" = true ]; then
  arguments+=(--review-pending-artifact)
fi

exec bash "$REPO_ROOT/scripts/build-homebrew-main-shell-closure.sh" \
  "${arguments[@]}"
