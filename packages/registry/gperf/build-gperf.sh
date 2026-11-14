#!/usr/bin/env bash
# Cross-compile GNU gperf (C++) for Kandelo against the declared libcxx.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$HERE"
kandelo_package_prepare_build_roots "$HERE" wasm32
WORK="$KANDELO_PACKAGE_WORK_DIR"
SRC="$WORK/gperf-src"
source "$REPO_ROOT/sdk/activate.sh"

SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
LIBCXX_DIR="${WASM_POSIX_DEP_LIBCXX_DIR:-}"
if [ -z "$LIBCXX_DIR" ] && [ -z "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
    LIBCXX_DIR="$(cd "$REPO_ROOT" && cargo run -q -p xtask --target "$HOST_TARGET" -- build-deps resolve libcxx --arch wasm32)"
fi
[ -f "$LIBCXX_DIR/lib/libc++.a" ] || { echo "ERROR: libcxx dependency missing" >&2; exit 1; }
export WASM_POSIX_DEP_WORK_DIR="$WORK"
export WASM_POSIX_DEP_LIBCXX_DIR="$LIBCXX_DIR"
SYSROOT="$(kandelo_package_prepare_private_sysroot gperf "$SYSROOT" libcxx)"
export WASM_POSIX_SYSROOT="$SYSROOT"

rm -rf "$SRC"
kandelo_package_stage_primary_source gperf "$SRC" "$WORK"
cd "$SRC"
echo "==> Configuring gperf..."
wasm32posix-configure --prefix=/usr 2>&1 | tail -15
echo "==> Building gperf..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" -C lib 2>&1 | tail -10
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" -C src 2>&1 | tail -15
[ -f "$SRC/src/gperf" ] || { echo "ERROR: gperf was not built" >&2; exit 1; }
cp "$SRC/src/gperf" "$WORK/gperf.wasm"

cd "$REPO_ROOT"
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
fi
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary gperf "$WORK/gperf.wasm" gperf.wasm
