#!/usr/bin/env bash
set -euo pipefail

LOCK=""
EXPECTED_SOURCE_DATE_EPOCH=""
ARTIFACT=""

usage() {
  cat <<'EOF'
Usage: scripts/verify-homebrew-main-shell-artifact-lock.sh \
  --lock <artifact-lock.json> \
  --expected-source-date-epoch <seconds> \
  [--artifact <shell.vfs.zst>]

Validate the exact lazy-shell artifact contract. When --artifact is present,
also require its compressed SHA-256 and byte count to match the lock.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --lock)
      LOCK="${2:-}"
      shift 2
      ;;
    --expected-source-date-epoch)
      EXPECTED_SOURCE_DATE_EPOCH="${2:-}"
      shift 2
      ;;
    --artifact)
      ARTIFACT="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "verify-homebrew-main-shell-artifact-lock: unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ -z "$LOCK" ] || [ ! -f "$LOCK" ] || [ -L "$LOCK" ]; then
  echo "verify-homebrew-main-shell-artifact-lock: --lock must be a regular non-symlink file" >&2
  exit 2
fi
if ! [[ "$EXPECTED_SOURCE_DATE_EPOCH" =~ ^(0|[1-9][0-9]*)$ ]]; then
  echo "verify-homebrew-main-shell-artifact-lock: --expected-source-date-epoch must be a non-negative integer" >&2
  exit 2
fi

for tool in jq sha256sum wc; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "verify-homebrew-main-shell-artifact-lock: missing $tool; run through scripts/dev-shell.sh" >&2
    exit 2
  }
done

jq -e --argjson source_date_epoch "$EXPECTED_SOURCE_DATE_EPOCH" '
  type == "object" and
  (keys | sort) == ["image", "kind", "schema", "source_date_epoch"] and
  .schema == 1 and
  .kind == "kandelo-homebrew-lazy-shell-artifact-lock" and
  .source_date_epoch == $source_date_epoch and
  (.image | type == "object") and
  (.image | keys | sort) == ["bytes", "sha256"] and
  (.image.sha256 | type == "string" and test("^[0-9a-f]{64}$")) and
  (.image.bytes | type == "number" and . > 0 and floor == .)
' "$LOCK" >/dev/null || {
  echo "verify-homebrew-main-shell-artifact-lock: lock is invalid or uses a different timestamp epoch" >&2
  exit 2
}

if [ -z "$ARTIFACT" ]; then
  exit 0
fi
if [ ! -f "$ARTIFACT" ] || [ -L "$ARTIFACT" ]; then
  echo "verify-homebrew-main-shell-artifact-lock: --artifact must be a regular non-symlink file" >&2
  exit 2
fi

EXPECTED_SHA="$(jq -er '.image.sha256' "$LOCK")"
EXPECTED_BYTES="$(jq -er '.image.bytes' "$LOCK")"
ACTUAL_SHA="$(sha256sum "$ARTIFACT")"
ACTUAL_SHA="${ACTUAL_SHA%% *}"
ACTUAL_BYTES="$(wc -c <"$ARTIFACT" | tr -d '[:space:]')"

if [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]; then
  echo "verify-homebrew-main-shell-artifact-lock: artifact SHA-256 does not match the reviewed lock" >&2
  echo "  expected: $EXPECTED_SHA" >&2
  echo "  actual:   $ACTUAL_SHA" >&2
  exit 1
fi
if [ "$ACTUAL_BYTES" != "$EXPECTED_BYTES" ]; then
  echo "verify-homebrew-main-shell-artifact-lock: artifact byte count does not match the reviewed lock" >&2
  echo "  expected: $EXPECTED_BYTES" >&2
  echo "  actual:   $ACTUAL_BYTES" >&2
  exit 1
fi
