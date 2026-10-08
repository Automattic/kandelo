#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"
echo "==> Building Erlang VFS image..."
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/kandelo-erlang-vfs.XXXXXX")"
cleanup() { rm -rf "$WORK_DIR"; }
trap cleanup EXIT
OTP_ARCHIVE="$(scripts/resolve-binary.sh programs/erlang/erlang-otp.tar.zst)"
OTP_ROOT="$WORK_DIR/otp-runtime"
mkdir -p "$OTP_ROOT" apps/browser-demos/public
tar --zstd -xf "$OTP_ARCHIVE" -C "$OTP_ROOT"
KANDELO_ERLANG_OTP_ROOT="$OTP_ROOT" \
KANDELO_ERLANG_VFS_OUT="$REPO_ROOT/apps/browser-demos/public/erlang.vfs.zst" \
    npx tsx "$SCRIPT_DIR/build-erlang-vfs-image.ts"
echo "==> Done."
ls -lh apps/browser-demos/public/erlang.vfs.zst
