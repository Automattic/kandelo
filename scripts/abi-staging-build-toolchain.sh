#!/usr/bin/env bash
# Build exact wasm sysroots and compiler headers without mutating the source.
set -euo pipefail

SOURCE_ROOT=""
OUT=""

usage() {
  cat >&2 <<'EOF'
usage: scripts/abi-staging-build-toolchain.sh --source-root <dir> --out <dir>
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --source-root) SOURCE_ROOT="${2:-}"; shift 2 ;;
    --out) OUT="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "abi-staging-build-toolchain.sh: unknown flag: $1" >&2
      usage
      exit 2
      ;;
  esac
done

if [ -z "$SOURCE_ROOT" ] || [ -z "$OUT" ]; then
  usage
  exit 2
fi
if [[ "$SOURCE_ROOT" != /* ]] || [ ! -d "$SOURCE_ROOT" ] || [ -L "$SOURCE_ROOT" ]; then
  echo "abi-staging-build-toolchain.sh: source root must be an absolute real directory" >&2
  exit 2
fi
SOURCE_ROOT="$(cd "$SOURCE_ROOT" && pwd -P)"
if [ -n "$(git -C "$SOURCE_ROOT" status --porcelain=v1 --untracked-files=all)" ]; then
  echo "abi-staging-build-toolchain.sh: exact source has tracked or untracked changes" >&2
  exit 1
fi

MUSL_SOURCE="$SOURCE_ROOT/libc/musl"
if [ ! -d "$MUSL_SOURCE" ] || [ -L "$MUSL_SOURCE" ]; then
  echo "abi-staging-build-toolchain.sh: exact musl submodule is unavailable" >&2
  exit 1
fi
EXPECTED_MUSL_COMMIT="$(git -C "$SOURCE_ROOT" rev-parse HEAD:libc/musl)"
ACTUAL_MUSL_COMMIT="$(git -C "$MUSL_SOURCE" rev-parse HEAD)"
if [ "$EXPECTED_MUSL_COMMIT" != "$ACTUAL_MUSL_COMMIT" ] ||
   [ -n "$(git -C "$MUSL_SOURCE" status --porcelain=v1 --untracked-files=all)" ]; then
  echo "abi-staging-build-toolchain.sh: exact musl submodule differs from its gitlink" >&2
  exit 1
fi

OUT="$(python3 - "$OUT" <<'PY'
from pathlib import Path
import sys
print(Path(sys.argv[1]).resolve(strict=False))
PY
)"
case "$OUT" in
  "$SOURCE_ROOT"|"$SOURCE_ROOT"/*)
    echo "abi-staging-build-toolchain.sh: output must be outside the exact source" >&2
    exit 2
    ;;
esac
if [ -e "$OUT" ] || [ -L "$OUT" ]; then
  echo "abi-staging-build-toolchain.sh: output must be new" >&2
  exit 2
fi
OUT_PARENT="$(dirname "$OUT")"
if [ ! -d "$OUT_PARENT" ] || [ -L "$OUT_PARENT" ]; then
  echo "abi-staging-build-toolchain.sh: output parent must be a real directory" >&2
  exit 2
fi
OUT_PARENT="$(cd "$OUT_PARENT" && pwd -P)"

TESTING="${KANDELO_ABI_STAGING_TESTING:-0}"
TEST_BUILDER="${KANDELO_ABI_STAGING_MUSL_BUILDER:-}"
if [ "$TESTING" != 0 ] && [ "$TESTING" != 1 ]; then
  echo "abi-staging-build-toolchain.sh: invalid test mode" >&2
  exit 2
fi
if [ -n "$TEST_BUILDER" ]; then
  if [ "$TESTING" != 1 ] || [ "${GITHUB_ACTIONS:-}" = true ]; then
    echo "abi-staging-build-toolchain.sh: musl builder replacement is local-test-only" >&2
    exit 2
  fi
  if [[ "$TEST_BUILDER" != /* ]] || [ ! -f "$TEST_BUILDER" ] ||
     [ -L "$TEST_BUILDER" ] || [ ! -x "$TEST_BUILDER" ]; then
    echo "abi-staging-build-toolchain.sh: test musl builder is unavailable" >&2
    exit 2
  fi
fi

: "${LLVM_BIN:?run through the exact source dev shell}"
CLANG="$LLVM_BIN/clang"
if [[ "$CLANG" != /* ]] || [ ! -x "$CLANG" ]; then
  echo "abi-staging-build-toolchain.sh: exact Clang is unavailable" >&2
  exit 1
fi
RESOURCE_ROOT="$($CLANG -print-resource-dir)"
if [[ "$RESOURCE_ROOT" != /* ]] || [ ! -d "$RESOURCE_ROOT/include" ] ||
   [ -L "$RESOURCE_ROOT/include" ]; then
  echo "abi-staging-build-toolchain.sh: exact Clang resource headers are unavailable" >&2
  exit 1
fi
RESOURCE_INCLUDE="$(cd "$RESOURCE_ROOT/include" && pwd -P)"

BUILD_ROOT="$(mktemp -d "$OUT_PARENT/.kandelo-abi-toolchain.XXXXXX")"
cleanup() {
  case "${BUILD_ROOT:-}" in
    "$OUT_PARENT"/.kandelo-abi-toolchain.*)
      rm -rf -- "$BUILD_ROOT"
      ;;
  esac
}
trap cleanup EXIT

mkdir -p "$BUILD_ROOT/libc/musl"
git -C "$SOURCE_ROOT" archive --format=tar HEAD -- \
  libc/glue \
  libc/musl-overlay \
  scripts/build-musl.sh \
  scripts/install-overlay-headers.sh \
  scripts/build-dri-stubs.sh \
  scripts/build-gles-stubs.sh \
  scripts/write-graphics-pkgconfig.sh |
  tar -xf - -C "$BUILD_ROOT"
git -C "$MUSL_SOURCE" archive --format=tar HEAD |
  tar -xf - -C "$BUILD_ROOT/libc/musl"

build_musl() {
  local arch="$1"
  if [ -n "$TEST_BUILDER" ]; then
    "$TEST_BUILDER" "$BUILD_ROOT" "$arch"
    return
  fi
  if [ "$arch" = wasm32posix ]; then
    (cd "$BUILD_ROOT" && bash scripts/build-musl.sh)
  else
    (cd "$BUILD_ROOT" && bash scripts/build-musl.sh --arch "$arch")
  fi
}

build_musl wasm32posix
build_musl wasm64posix

STAGED="$BUILD_ROOT/staged-toolchain"
mkdir -p "$STAGED/clang-resource-headers"
cp -R "$BUILD_ROOT/sysroot" "$STAGED/wasm32-sysroot"
cp -R "$BUILD_ROOT/sysroot64" "$STAGED/wasm64-sysroot"
cp -R "$RESOURCE_INCLUDE" "$STAGED/clang-resource-headers/include"

for required in \
  "$STAGED/wasm32-sysroot/lib/libc.a" \
  "$STAGED/wasm64-sysroot/lib/libc.a" \
  "$STAGED/clang-resource-headers/include/stddef.h"; do
  if [ ! -s "$required" ] || [ -L "$required" ]; then
    echo "abi-staging-build-toolchain.sh: exact toolchain output is incomplete: $required" >&2
    exit 1
  fi
done
if symlink="$(find "$STAGED" -type l -print -quit)" && [ -n "$symlink" ]; then
  echo "abi-staging-build-toolchain.sh: exact toolchain contains a symbolic link: $symlink" >&2
  exit 1
fi
if empty_directory="$(find "$STAGED" -type d -empty -print -quit)" &&
   [ -n "$empty_directory" ]; then
  echo "abi-staging-build-toolchain.sh: exact toolchain contains an empty directory: $empty_directory" >&2
  exit 1
fi

if [ -n "$(git -C "$SOURCE_ROOT" status --porcelain=v1 --untracked-files=all)" ] ||
   [ "$EXPECTED_MUSL_COMMIT" != "$(git -C "$MUSL_SOURCE" rev-parse HEAD)" ] ||
   [ -n "$(git -C "$MUSL_SOURCE" status --porcelain=v1 --untracked-files=all)" ]; then
  echo "abi-staging-build-toolchain.sh: exact source changed during toolchain build" >&2
  exit 1
fi

mv "$STAGED" "$OUT"
echo "abi-staging-build-toolchain.sh: built exact isolated toolchain"
