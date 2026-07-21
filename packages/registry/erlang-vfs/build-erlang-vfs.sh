#!/usr/bin/env bash
# Package-system build wrapper. The erlang dependency provides the exact OTP
# runtime archive; all extraction and output stay inside caller-owned roots.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
WORK_DIR="${WASM_POSIX_DEP_WORK_DIR:-$SCRIPT_DIR/erlang-vfs-work}"
OUT_DIR="${WASM_POSIX_DEP_OUT_DIR:-$SCRIPT_DIR}"
ARTIFACT_DIR="$WORK_DIR/package-artifacts"
ERLANG_DIR="${WASM_POSIX_DEP_ERLANG_DIR:-}"

mkdir -p "$WORK_DIR" "$OUT_DIR" "$ARTIFACT_DIR"
if [ -n "$ERLANG_DIR" ]; then
    OTP_ARCHIVE="$ERLANG_DIR/erlang-otp.tar.zst"
else
    OTP_ARCHIVE="$("$REPO_ROOT/scripts/resolve-binary.sh" programs/erlang/erlang-otp.tar.zst)"
fi
if [ ! -f "$OTP_ARCHIVE" ]; then
    echo "ERROR: resolved Erlang dependency has no erlang-otp.tar.zst: $OTP_ARCHIVE" >&2
    exit 1
fi

OTP_ROOT="$WORK_DIR/otp-runtime"
rm -rf "$OTP_ROOT"
mkdir -p "$OTP_ROOT"
tar --zstd -xf "$OTP_ARCHIVE" -C "$OTP_ROOT"

STAGE="$ARTIFACT_DIR/erlang-vfs.vfs.zst"
KANDELO_ERLANG_OTP_ROOT="$OTP_ROOT" KANDELO_ERLANG_VFS_OUT="$STAGE" \
    npx tsx "$REPO_ROOT/images/vfs/scripts/build-erlang-vfs-image.ts"
[ -f "$STAGE" ] || { echo "ERROR: $STAGE not produced" >&2; exit 1; }

if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
fi
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary erlang-vfs "$STAGE"

if [ -z "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    cp "$STAGE" "$OUT_DIR/erlang-vfs.vfs.zst"
fi
