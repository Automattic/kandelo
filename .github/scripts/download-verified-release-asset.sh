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

ATTEMPTS="${RELEASE_DOWNLOAD_ATTEMPTS:-4}"
RETRY_SECONDS="${RELEASE_DOWNLOAD_RETRY_SECONDS:-2}"
if ! [[ "$ATTEMPTS" =~ ^[1-9][0-9]*$ ]]; then
  echo "download-verified-release-asset: attempts must be positive: $ATTEMPTS" >&2
  exit 2
fi
if ! [[ "$RETRY_SECONDS" =~ ^[0-9]+$ ]]; then
  echo "download-verified-release-asset: retry seconds must be non-negative: $RETRY_SECONDS" >&2
  exit 2
fi

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

attempt=1
delay="$RETRY_SECONDS"
downloaded=""
while [ "$attempt" -le "$ATTEMPTS" ]; do
  attempt_dir="$TMP_ROOT/attempt-$attempt"
  stdout_file="$TMP_ROOT/stdout-$attempt"
  stderr_file="$TMP_ROOT/stderr-$attempt"
  mkdir "$attempt_dir"

  if gh release download "$TAG" \
      --repo "$REPOSITORY" \
      --pattern "$ASSET" \
      --dir "$attempt_dir" \
      --clobber >"$stdout_file" 2>"$stderr_file"; then
    candidate="$attempt_dir/$ASSET"
    if [ -f "$candidate" ] && [ ! -L "$candidate" ]; then
      cat "$stdout_file"
      downloaded="$candidate"
      break
    fi
    echo "download-verified-release-asset: GitHub reported success without a regular $ASSET" >&2
    rc=1
  else
    rc=$?
  fi

  cat "$stderr_file" >&2
  if [ -s "$stdout_file" ]; then
    cat "$stdout_file" >&2
  fi
  rm -rf "$attempt_dir"

  if [ "$attempt" -ge "$ATTEMPTS" ]; then
    echo "download-verified-release-asset: failed after $ATTEMPTS attempts: $TAG/$ASSET" >&2
    exit "$rc"
  fi

  echo "::warning::release asset download failed (attempt $attempt/$ATTEMPTS); retrying in ${delay}s: $TAG/$ASSET" >&2
  sleep "$delay"
  attempt=$((attempt + 1))
  delay=$((delay * 2))
done

if [ -z "$downloaded" ]; then
  echo "download-verified-release-asset: no verified download candidate for $TAG/$ASSET" >&2
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
