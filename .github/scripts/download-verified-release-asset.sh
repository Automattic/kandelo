#!/usr/bin/env bash
set -euo pipefail

TAG=""
ASSET=""
EXPECTED_SHA256=""
EXPECTED_SIZE=""
OUTPUT=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --tag) TAG="$2"; shift 2 ;;
    --asset) ASSET="$2"; shift 2 ;;
    --sha256) EXPECTED_SHA256="$2"; shift 2 ;;
    --size) EXPECTED_SIZE="$2"; shift 2 ;;
    --output) OUTPUT="$2"; shift 2 ;;
    *) echo "download-verified-release-asset: unknown flag $1" >&2; exit 2 ;;
  esac
done

if ! [[ "$TAG" =~ ^[A-Za-z0-9._-]+$ ]] ||
   ! [[ "$ASSET" =~ ^[A-Za-z0-9][A-Za-z0-9._+,-]*$ ]] ||
   ! [[ "$EXPECTED_SHA256" =~ ^[0-9a-f]{64}$ ]] ||
   ! [[ "$EXPECTED_SIZE" =~ ^[0-9]+$ ]] || [ "$EXPECTED_SIZE" = 0 ] ||
   [ -z "$OUTPUT" ]; then
  echo "download-verified-release-asset: valid tag, asset, sha256, size, and output are required" >&2
  exit 2
fi

REPOSITORY="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY required}"
TMP_ROOT="$(mktemp -d)"
trap 'rm -rf "$TMP_ROOT"' EXIT

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

gh release download "$TAG" \
  --repo "$REPOSITORY" \
  --pattern "$ASSET" \
  --dir "$TMP_ROOT" \
  --clobber

downloaded="$TMP_ROOT/$ASSET"
if [ ! -f "$downloaded" ]; then
  echo "download-verified-release-asset: $TAG did not yield $ASSET" >&2
  exit 1
fi
actual_size=$(wc -c < "$downloaded" | tr -d '[:space:]')
actual_sha256=$(sha256_file "$downloaded")
if [ "$actual_size" != "$EXPECTED_SIZE" ]; then
  echo "download-verified-release-asset: $TAG/$ASSET size $actual_size does not match snapshot $EXPECTED_SIZE" >&2
  exit 1
fi
if [ "$actual_sha256" != "$EXPECTED_SHA256" ]; then
  echo "download-verified-release-asset: $TAG/$ASSET sha256 $actual_sha256 does not match snapshot $EXPECTED_SHA256" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUTPUT")"
mv "$downloaded" "$OUTPUT"
echo "download-verified-release-asset: verified $TAG/$ASSET"
