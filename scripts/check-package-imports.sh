#!/usr/bin/env bash
# One import contract for executable smoke links and package outputs.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
cd "$REPO_ROOT"
HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
# A native Cargo tool is not part of the target C/C++ compilation. Keep its
# caller-owned Cargo directories and resolver identity, but do not send the
# recipe's Wasm compiler or flags into ring/zstd-sys and the native linker.
exec env -u CC -u CXX -u AR -u RANLIB -u AS -u LD -u NM -u ARFLAGS \
    -u CFLAGS -u CXXFLAGS -u CPPFLAGS -u LDFLAGS \
    -u TARGET_CC -u TARGET_CXX -u TARGET_AR -u TARGET_CFLAGS -u TARGET_CXXFLAGS \
    -u RUSTFLAGS -u CARGO_ENCODED_RUSTFLAGS \
    cargo run -p xtask --target "$HOST_TARGET" --quiet -- check-package-imports "$@"
