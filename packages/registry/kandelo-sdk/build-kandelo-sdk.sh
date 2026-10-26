#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"

RESOLVER_BUILD=0
if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] || \
   [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
  RESOLVER_BUILD=1
  # shellcheck source=/dev/null
  source "$REPO_ROOT/scripts/package-build-roots.sh"
  kandelo_package_prepare_build_roots "$SCRIPT_DIR/kandelo-sdk-work" wasm32
fi

SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
if [[ ! -f "$SYSROOT/lib/libc.a" ]]; then
  echo "ERROR: sysroot not found at $SYSROOT. Run: bash scripts/build-musl.sh" >&2
  exit 1
fi

LIBCXX_DIR="${WASM_POSIX_DEP_LIBCXX_DIR:-}"
# The SDK driver and wasm-opt, built for Kandelo: the image runs the build
# machine's compiler jobs (crates/kandelo-cc) with the build machine's
# Binaryen release.
KANDELO_CC_DIR="${WASM_POSIX_DEP_KANDELO_CC_DIR:-}"
BINARYEN_DIR="${WASM_POSIX_DEP_BINARYEN_DIR:-}"
if [ "$RESOLVER_BUILD" -eq 0 ]; then
  HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
  resolve_dep() {
    (cd "$REPO_ROOT" && cargo run -q -p xtask --target "$HOST_TARGET" -- build-deps resolve "$1" --arch wasm32)
  }
  [ -n "$KANDELO_CC_DIR" ] || KANDELO_CC_DIR="$(resolve_dep kandelo-cc)"
  [ -n "$BINARYEN_DIR" ] || BINARYEN_DIR="$(resolve_dep binaryen)"
fi
[[ -f "$KANDELO_CC_DIR/kandelo-cc.wasm" ]] || { echo "ERROR: kandelo-cc dependency missing" >&2; exit 1; }
[[ -f "$BINARYEN_DIR/wasm-opt.wasm" ]] || { echo "ERROR: binaryen dependency missing" >&2; exit 1; }
if [ "$RESOLVER_BUILD" -eq 1 ]; then
  export WASM_POSIX_DEP_WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
  if [ -z "$KANDELO_PACKAGE_OUT_DIR" ]; then
    echo "ERROR: kandelo-sdk resolver build requires WASM_POSIX_DEP_OUT_DIR" >&2
    exit 1
  fi
  SYSROOT="$(
    kandelo_package_prepare_private_sysroot kandelo-sdk "$SYSROOT"
  )"
  export WASM_POSIX_SYSROOT="$SYSROOT"
  VFS="$KANDELO_PACKAGE_OUT_DIR/kandelo-sdk.vfs.zst"
else
  VFS="$SCRIPT_DIR/kandelo-sdk.vfs.zst"
fi
if [[ -n "$LIBCXX_DIR" ]]; then
  copy_if_changed() {
    local src="$1"
    local dst="$2"

    if [[ -e "$dst" && ! -L "$dst" ]] && cmp -s "$src" "$dst"; then
      return
    fi

    rm -f "$dst"
    cp "$src" "$dst"
  }

  mkdir -p "$SYSROOT/lib" "$SYSROOT/include/c++"
  copy_if_changed "$LIBCXX_DIR/lib/libc++.a" "$SYSROOT/lib/libc++.a"
  copy_if_changed "$LIBCXX_DIR/lib/libc++abi.a" "$SYSROOT/lib/libc++abi.a"

  LIBCXX_INCLUDE_SRC="$LIBCXX_DIR/include/c++/v1"
  LIBCXX_INCLUDE_DST="$SYSROOT/include/c++/v1"
  if [[ ! -d "$LIBCXX_INCLUDE_DST" ]] \
    || [[ "$(cd "$LIBCXX_INCLUDE_SRC" && pwd -P)" != "$(cd "$LIBCXX_INCLUDE_DST" && pwd -P)" ]]; then
    rm -rf "$LIBCXX_INCLUDE_DST"
    cp -RL "$LIBCXX_INCLUDE_SRC" "$LIBCXX_INCLUDE_DST"
  fi
fi

export KANDELO_SDK_DRIVER="$KANDELO_CC_DIR/kandelo-cc.wasm"
export KANDELO_SDK_WASM_OPT="$BINARYEN_DIR/wasm-opt.wasm"
export KANDELO_SDK_VFS_OUT="$VFS"
bash "$REPO_ROOT/images/vfs/scripts/build-kandelo-sdk-vfs-image.sh"

[[ -f "$VFS" ]] || { echo "ERROR: $VFS not produced by builder" >&2; exit 1; }

if [ "$RESOLVER_BUILD" -eq 0 ]; then
  source "$REPO_ROOT/scripts/install-local-binary.sh"
  install_local_binary kandelo-sdk "$VFS"
fi
