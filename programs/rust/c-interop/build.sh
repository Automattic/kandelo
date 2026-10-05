#!/usr/bin/env bash
#
# Build the C <-> Rust interop fixtures for wasm32-unknown-kandelo-std:
#
#   c-calls-rust.wasm    C program linked against rustlib/, a std-using Rust
#                        static library installed with cargo-c
#   cpp-calls-rust.wasm  C++ program linked against the same library
#   rust-calls-c.wasm    Rust program linked against clib/, a C static
#                        library its build.rs builds with the SDK
#   rust-calls-cpp.wasm  Rust program linked against cpplib/, a C++ static
#                        library (and libc++) its build.rs builds the same way
#
# Also copies cargo-c's generated kandelo_interop.pc into the output
# directory. Run inside scripts/dev-shell.sh. host/test/rust-c-interop.test.ts
# builds and runs these.
#
# Usage: build.sh <output-dir>

set -euo pipefail

OUT="${1:?usage: build.sh <output-dir>}"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
TARGET="wasm32-unknown-kandelo-std"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"

# The private sysroot (prebuilt std, libc fork). The builder skips the
# rebuild when its inputs are unchanged.
RUST_DIR="${KANDELO_RUST_DIR:-$HOME/.kandelo/rust}"
KANDELO_RUST_DIR="$RUST_DIR" bash "$REPO_ROOT/scripts/build-rust-sysroot.sh" >&2
export RUSTC="$RUST_DIR/rustc-kandelo"
export RUST_LIBC_UNSTABLE_MUSL_V1_2_3=1
# The fixtures have no crates.io dependencies.
export CARGO_NET_OFFLINE=true

# libc++ comes from the resolved libcxx package; the shared worktree sysroot
# does not carry it. rustcpp/build.rs reads the same variable the resolver
# gives package builds.
HOST_TARGET="$(rustc -vV | sed -n 's/^host: //p')"
if [ -z "${WASM_POSIX_DEP_LIBCXX_DIR:-}" ]; then
    (cd "$REPO_ROOT" && cargo run -q -p xtask --target "$HOST_TARGET" -- \
        build-deps resolve libcxx >/dev/null)
    WASM_POSIX_DEP_LIBCXX_DIR="$(cd "$REPO_ROOT" && cargo run -q -p xtask \
        --target "$HOST_TARGET" -- build-deps path libcxx)"
fi
export WASM_POSIX_DEP_LIBCXX_DIR
LIBCXX="$WASM_POSIX_DEP_LIBCXX_DIR"

# cargo does not track the sysroot's std, so a target directory from an
# earlier sysroot would keep linking the old one; always start clean.
rm -rf "$OUT/target"

# --- C and C++ calling Rust ----------------------------------------------
PREFIX="$OUT/prefix"
rm -rf "$PREFIX"
cargo cinstall --release \
    --manifest-path "$HERE/rustlib/Cargo.toml" \
    --target "$TARGET" --target-dir "$OUT/target" \
    --library-type staticlib \
    --prefix "$PREFIX" --libdir "$PREFIX/lib"
cp "$PREFIX/lib/pkgconfig/kandelo_interop.pc" "$OUT/"

wasm32posix-cc -O2 -I"$HERE" "$HERE/main.c" \
    -L"$PREFIX/lib" -lkandelo_interop \
    -o "$OUT/c-calls-rust.wasm"
# -fwasm-exceptions: main.cpp throws and catches a C++ exception.
wasm32posix-c++ -O2 -fwasm-exceptions -I"$HERE" "$HERE/main.cpp" \
    -nostdinc++ -isystem "$LIBCXX/include/c++/v1" -L"$LIBCXX/lib" \
    -L"$PREFIX/lib" -lkandelo_interop -lc++ -lc++abi \
    -o "$OUT/cpp-calls-rust.wasm"

# --- Rust calling C ------------------------------------------------------
cargo build --release --quiet \
    --manifest-path "$HERE/rustbin/Cargo.toml" \
    --target "$TARGET" --target-dir "$OUT/target"
cp "$OUT/target/$TARGET/release/rust-calls-c.wasm" "$OUT/"

# --- Rust calling C++ ----------------------------------------------------
cargo build --release --quiet \
    --manifest-path "$HERE/rustcpp/Cargo.toml" \
    --target "$TARGET" --target-dir "$OUT/target"
cp "$OUT/target/$TARGET/release/rust-calls-cpp.wasm" "$OUT/"

# --- Finish as any program artifact --------------------------------------
# Fork instrumentation leaves a module that does not use fork unchanged;
# the ABI contract stamp is what the package build engine adds to every
# program it installs.
for wasm in c-calls-rust cpp-calls-rust rust-calls-c rust-calls-cpp; do
    bash "$REPO_ROOT/scripts/run-wasm-fork-instrument.sh" \
        "$OUT/$wasm.wasm" -o "$OUT/$wasm.next.wasm"
    mv "$OUT/$wasm.next.wasm" "$OUT/$wasm.wasm"
    (cd "$REPO_ROOT" && cargo run -q -p xtask --target "$HOST_TARGET" -- \
        stamp-abi-contract "$OUT/$wasm.wasm" >/dev/null)
done

echo "C_RUST_INTEROP_BUILT"
