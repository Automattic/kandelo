#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

# shellcheck source=/dev/null
source "$REPO_ROOT/sdk/activate.sh"

SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
GLUE_DIR="${WASM_POSIX_GLUE_DIR:-$REPO_ROOT/libc/glue}"
GLUE_OBJ_DIR="${KANDELO_SDK_GLUE_OBJ_DIR:-$SCRIPT_DIR/kandelo-sdk-glue-objs}"
if [[ ! -f "$SYSROOT/lib/libc.a" ]]; then
  echo "ERROR: sysroot not found at $SYSROOT. Run: bash scripts/build-musl.sh" >&2
  exit 1
fi

LIBCXX_DIR="${WASM_POSIX_DEP_LIBCXX_DIR:-}"
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

mkdir -p "$GLUE_OBJ_DIR"
for src in channel_syscall compiler_rt cxxrt dlopen; do
  wasm32posix-cc -O2 -c "$GLUE_DIR/${src}.c" -o "$GLUE_OBJ_DIR/${src}.o"
done

export KANDELO_SDK_GLUE_OBJ_DIR="$GLUE_OBJ_DIR"
export KANDELO_SDK_VFS_OUT="$SCRIPT_DIR/kandelo-sdk.vfs.zst"
bash "$REPO_ROOT/images/vfs/scripts/build-kandelo-sdk-vfs-image.sh"

VFS="$SCRIPT_DIR/kandelo-sdk.vfs.zst"
[[ -f "$VFS" ]] || { echo "ERROR: $VFS not produced by builder" >&2; exit 1; }

source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary kandelo-sdk "$VFS"
