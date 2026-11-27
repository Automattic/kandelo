#!/usr/bin/env bash
set -euo pipefail

if [[ $# != 2 ]]; then
    printf 'Usage: %s <output-directory> <host-ldmd2>\n' "$0" >&2
    exit 2
fi

sdk_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$sdk_dir/../.." && pwd)"
bootstrap="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"
if [[ ! -x "$bootstrap" ]]; then
    printf 'LDC bootstrap compiler is unavailable at %s\n' "$bootstrap" >&2
    exit 1
fi
: "${KANDELO_LLVM_DEV:?Run this script from scripts/dev-shell.sh}"
: "${KANDELO_D_LLVM_PREFIX:?Set this to the optional d-llvm flake package}"
llvm_prefix="$(cd "$KANDELO_D_LLVM_PREFIX" && pwd)"
if [[ "$("$llvm_prefix/bin/llvm-config" --version)" != 22.1.8 ]]; then
    printf 'The D SDK bootstrap requires LLVM 22.1.8.\n' >&2
    exit 2
fi

mkdir -p "$1"
work="$(mktemp -d "$(cd "$1" && pwd)/kandelo-d.XXXXXXXX")"
printf 'D SDK build directory: %s\n' "$work"

version=1.43.0
digest=d655aad0daf0ce9a17b2ffffb947bb79ec6968bc7fb88bc918316dbe78c616e7
archive="$work/ldc.tar.gz"
curl --fail --location --silent --show-error \
    "https://github.com/ldc-developers/ldc/releases/download/v$version/ldc-$version-src.tar.gz" \
    -o "$archive"
printf '%s  %s\n' "$digest" "$archive" | sha256sum --check

mkdir "$work/release-src"
tar -xzf "$archive" -C "$work/release-src" --strip-components=1
patch --batch --fuzz=0 -d "$work/release-src" -p1 < "$sdk_dir/ldc-$version-kandelo.patch"
patch --batch --fuzz=0 -d "$work/release-src" -p1 < "$sdk_dir/ldc-$version-wasm-eh.patch"

cd "$repo_root"
source "$repo_root/sdk/activate.sh"
bash scripts/build-musl.sh --ensure --core-only

jobs="${KANDELO_D_BUILD_JOBS:-8}"
cmake -S "$work/release-src" -B "$work/ldc-build" -G Ninja \
    -DCMAKE_BUILD_TYPE=Release -DD_COMPILER="$bootstrap" \
    -DLLVM_CONFIG="$llvm_prefix/bin/llvm-config" \
    -DLDC_BUILD_RUNTIME=OFF -DLDC_ENABLE_PLUGINS=OFF -DLDC_INSTALL_LTOPLUGIN=OFF
cmake --build "$work/ldc-build" --target ldc2 --parallel "$jobs"

target_flags=(
    -mtriple=wasm32-unknown-kandelo-musl
    -mattr=+atomics,+bulk-memory,+mutable-globals
    --wasm-enable-eh
    --wasm-use-legacy-eh=false
)
"$work/ldc-build/bin/ldc2" -conf= -o- "${target_flags[@]}" \
    -I="$work/release-src/runtime/druntime/src" -I="$work/ldc-build/import" \
    "$sdk_dir/test/quad_precision.d"

continuation="$repo_root/sdk/kandelo/continuation"
continuation_library="$work/runtime-build/lib/libkandelo-continuation.a"
mkdir -p "$(dirname "$continuation_library")"
wasm32posix-cc -O2 -pthread -fno-lto -c "$continuation/continuation.c" -o "$work/continuation.o"
wasm32posix-cc -O2 -pthread -fno-lto -c "$continuation/link.c" -o "$work/continuation-link.o"
wasm32posix-ar rcs "$continuation_library" "$work/continuation.o" "$work/continuation-link.o"

cmake -S "$work/release-src/runtime" -B "$work/runtime-build" -G Ninja \
    -DCMAKE_TOOLCHAIN_FILE="$repo_root/sdk/cmake/kandelo-toolchain.cmake" \
    -DLDC_EXE_FULL="$work/ldc-build/bin/ldc2" \
    -DDMDFE_MINOR_VERSION=113 -DDMDFE_PATCH_VERSION=0 \
    -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DRT_ARCHIVE_WITH_LDC=OFF \
    '-DTARGET_SYSTEM=Kandelo;UNIX;musl' \
    "-DKANDELO_CONTINUATION_LIBRARY:FILEPATH=$continuation_library" \
    "-DD_EXTRA_FLAGS=$(IFS=';'; printf '%s' "${target_flags[*]}")"
cmake --build "$work/runtime-build" --target druntime-ldc phobos2-ldc --parallel "$jobs"
printf 'D SDK is available at %s\n' "$work"
