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

SOURCE_SYSROOT="${WASM_POSIX_SYSROOT:-$REPO_ROOT/sysroot}"
if [[ ! -f "$SOURCE_SYSROOT/lib/libc.a" ]]; then
  echo "ERROR: sysroot not found at $SOURCE_SYSROOT. Run: bash scripts/build-musl.sh" >&2
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
  [ -n "$LIBCXX_DIR" ] || LIBCXX_DIR="$(resolve_dep libcxx)"
  [ -n "$KANDELO_CC_DIR" ] || KANDELO_CC_DIR="$(resolve_dep kandelo-cc)"
  [ -n "$BINARYEN_DIR" ] || BINARYEN_DIR="$(resolve_dep binaryen)"
fi
[[ -f "$LIBCXX_DIR/lib/libc++.a" ]] || { echo "ERROR: libcxx dependency missing" >&2; exit 1; }
[[ -f "$KANDELO_CC_DIR/kandelo-cc.wasm" ]] || { echo "ERROR: kandelo-cc dependency missing" >&2; exit 1; }
[[ -f "$BINARYEN_DIR/wasm-opt.wasm" ]] || { echo "ERROR: binaryen dependency missing" >&2; exit 1; }
if [ "$RESOLVER_BUILD" -eq 1 ]; then
  export WASM_POSIX_DEP_WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
  if [ -z "$KANDELO_PACKAGE_OUT_DIR" ]; then
    echo "ERROR: kandelo-sdk resolver build requires WASM_POSIX_DEP_OUT_DIR" >&2
    exit 1
  fi
  # The shared sysroot is read-only input: it must be a canonical real
  # directory outside every resolver-owned root, so staging can neither read
  # this build's own work or output nor write into the source it reads.
  SOURCE_SYSROOT_REAL="$(
    kandelo_package_require_existing_real_dir "SDK sysroot" "$SOURCE_SYSROOT"
  )" || exit 2
  if [ "$SOURCE_SYSROOT_REAL" != "$SOURCE_SYSROOT" ]; then
    echo "ERROR: SDK sysroot must use its canonical path: $SOURCE_SYSROOT" >&2
    exit 2
  fi
  kandelo_package_require_disjoint_paths "SDK sysroot" "$SOURCE_SYSROOT" \
    WASM_POSIX_DEP_WORK_DIR "$KANDELO_PACKAGE_WORK_DIR" || exit 2
  kandelo_package_require_disjoint_paths "SDK sysroot" "$SOURCE_SYSROOT" \
    WASM_POSIX_DEP_OUT_DIR "$KANDELO_PACKAGE_OUT_DIR" || exit 2
  if [ -n "${WASM_POSIX_DEP_SOURCE_DIR:-}" ]; then
    SOURCE_ROOT="$(
      kandelo_package_require_existing_real_dir \
        WASM_POSIX_DEP_SOURCE_DIR "$WASM_POSIX_DEP_SOURCE_DIR"
    )" || exit 2
    if [ "$SOURCE_ROOT" != "$WASM_POSIX_DEP_SOURCE_DIR" ]; then
      echo "ERROR: WASM_POSIX_DEP_SOURCE_DIR must use its canonical path: $WASM_POSIX_DEP_SOURCE_DIR" >&2
      exit 2
    fi
    kandelo_package_require_disjoint_paths "SDK sysroot" "$SOURCE_SYSROOT" \
      WASM_POSIX_DEP_SOURCE_DIR "$SOURCE_ROOT" || exit 2
  fi
  SYSROOT="$(mktemp -d "$KANDELO_PACKAGE_WORK_DIR/.kandelo-kandelo-sdk-sysroot.XXXXXX")"
  VFS="$KANDELO_PACKAGE_OUT_DIR/kandelo-sdk.vfs.zst"
else
  SYSROOT="$(mktemp -d "${TMPDIR:-/tmp}/kandelo-sdk-sysroot.XXXXXX")"
  trap 'rm -rf -- "$SYSROOT"' EXIT
  VFS="$SCRIPT_DIR/kandelo-sdk.vfs.zst"
fi
# Copy only the SDK's declared sysroot content into a private tree. The
# shared sysroot also holds what other tools staged there
# (scripts/build-programs.sh copies GTK, glib, SDL2 and other fixture
# libraries into it), which is not an input of this image. The image
# builder refuses an unstaged sysroot and takes libc++ from the declared
# libcxx dependency itself.
bash "$REPO_ROOT/images/vfs/scripts/stage-sdk-sysroot.sh" "$SOURCE_SYSROOT" "$SYSROOT"
export WASM_POSIX_SYSROOT="$SYSROOT"
export KANDELO_SDK_LIBCXX_DIR="$LIBCXX_DIR"
export KANDELO_SDK_DRIVER="$KANDELO_CC_DIR/kandelo-cc.wasm"
export KANDELO_SDK_WASM_OPT="$BINARYEN_DIR/wasm-opt.wasm"
export KANDELO_SDK_VFS_OUT="$VFS"
bash "$REPO_ROOT/images/vfs/scripts/build-kandelo-sdk-vfs-image.sh"

[[ -f "$VFS" ]] || { echo "ERROR: $VFS not produced by builder" >&2; exit 1; }

if [ "$RESOLVER_BUILD" -eq 0 ]; then
  source "$REPO_ROOT/scripts/install-local-binary.sh"
  install_local_binary kandelo-sdk "$VFS"
fi
