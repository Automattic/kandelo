#!/usr/bin/env bash
# Print the SHA-256 fingerprint for the musl sysroot selected by a Homebrew
# bottle architecture.
set -euo pipefail

KANDELO_ROOT=""
ARCH=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --kandelo-root) KANDELO_ROOT="${2:-}"; shift 2 ;;
    --arch) ARCH="${2:-}"; shift 2 ;;
    *)
      echo "homebrew-sysroot-fingerprint.sh: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [ -z "$KANDELO_ROOT" ]; then
  echo "homebrew-sysroot-fingerprint.sh: --kandelo-root is required" >&2
  exit 2
fi

case "$ARCH" in
  wasm32) SYSROOT_LIBC="$KANDELO_ROOT/sysroot/lib/libc.a" ;;
  wasm64) SYSROOT_LIBC="$KANDELO_ROOT/sysroot64/lib/libc.a" ;;
  *)
    echo "homebrew-sysroot-fingerprint.sh: invalid arch: $ARCH" >&2
    exit 2
    ;;
esac

if [ ! -f "$SYSROOT_LIBC" ] || [ -L "$SYSROOT_LIBC" ]; then
  echo "homebrew-sysroot-fingerprint.sh: selected $ARCH sysroot libc must be a regular non-symlink file: $SYSROOT_LIBC" >&2
  exit 2
fi

if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$SYSROOT_LIBC" | awk '{print $1}'
else
  shasum -a 256 "$SYSROOT_LIBC" | awk '{print $1}'
fi
