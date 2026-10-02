#!/usr/bin/env bash
#
# Build rustdemo (librustdemo.a + rustdemo.h + rustdemo.pc) — the reference
# "Rust library" package. Unlike the C/C++ packages, the build step drives
# the Rust toolchain for wasm32-unknown-kandelo (the private sysroot the SDK
# assembles) to compile a `staticlib` crate, then installs it like any other
# library so C/C++ packages can link it.
#
# The source is in-tree (no upstream archive); see package.toml's placeholder
# [source] and build.toml's `inputs` closure. Resolver contract:
#   WASM_POSIX_DEP_OUT_DIR  # where to install lib/ + include/
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$WORK_DIR/rustdemo-install}"

# --- Rust toolchain: assemble the private sysroot (idempotent) ---
# This builds the forked libc (submodule + patch) and the std overlay into a
# writable sysroot under $KANDELO_RUST_DIR, plus a rustc wrapper. Same tool
# wasm32posix-cargo uses; safe to call on every build.
echo "==> Ensuring Rust sysroot for wasm32-unknown-kandelo..."
bash "$REPO_ROOT/scripts/build-rust-sysroot.sh" >&2
RUST_DIR="${KANDELO_RUST_DIR:-$HOME/.kandelo/rust}"
RUSTC_WRAP="$RUST_DIR/rustc-kandelo"
[ -x "$RUSTC_WRAP" ] || { echo "ERROR: rustc wrapper missing at $RUSTC_WRAP" >&2; exit 1; }
SPEC="$REPO_ROOT/sdk/rust/wasm32-unknown-kandelo-std.json"

# --- Build the staticlib out-of-tree (keep the registry tree clean) ---
CRATE_DIR="$WORK_DIR/crate"
rm -rf "$CRATE_DIR"
cp -R "$SCRIPT_DIR/crate" "$CRATE_DIR"
cd "$CRATE_DIR"
echo "==> Building rustdemo staticlib for wasm32-unknown-kandelo..."
RUSTC="$RUSTC_WRAP" RUST_LIBC_UNSTABLE_MUSL_V1_2_3=1 \
  cargo build --release \
    -Z unstable-options -Z json-target-spec -Z build-std=std,panic_abort \
    --target "$SPEC"

ARCHIVE="$CRATE_DIR/target/wasm32-unknown-kandelo-std/release/librustdemo.a"
[ -f "$ARCHIVE" ] || { echo "ERROR: librustdemo.a not produced at $ARCHIVE" >&2; exit 1; }

# --- Install into the resolver's output dir ---
mkdir -p "$INSTALL_DIR"
find "$INSTALL_DIR" -mindepth 1 -delete
mkdir -p "$INSTALL_DIR/lib/pkgconfig" "$INSTALL_DIR/include"
cp "$ARCHIVE" "$INSTALL_DIR/lib/librustdemo.a"
cp "$SCRIPT_DIR/include/rustdemo.h" "$INSTALL_DIR/include/rustdemo.h"

# Relocatable pkg-config file (prefix resolves relative to the .pc location).
cat > "$INSTALL_DIR/lib/pkgconfig/rustdemo.pc" <<'PC'
prefix=${pcfiledir}/../..
libdir=${prefix}/lib
includedir=${prefix}/include

Name: rustdemo
Description: Reference Rust library with a C ABI (Kandelo)
Version: 0.1.0
Libs: -L${libdir} -lrustdemo
Cflags: -I${includedir}
PC

echo "==> rustdemo installed at $INSTALL_DIR"
echo "    lib/librustdemo.a ($(wc -c < "$INSTALL_DIR/lib/librustdemo.a") bytes)"
