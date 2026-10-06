#!/usr/bin/env bash
#
# Build librsvg (librsvg-2.a, headers, librsvg-2.0.pc) for
# wasm32-posix-kernel.
#
# librsvg is a C/GObject API over a Rust core. Upstream's meson build
# configures the C side and runs `cargo cbuild` (cargo-c) to compile the
# `librsvg-c` crate as a static library for the Rust target named by
# -Dtriplet. rust-build-env.sh (shared with the rsvg-convert package)
# prepares what that build expects from a Rust toolchain: a private
# sysroot with a prebuilt std for wasm32-unknown-kandelo-std, the crate
# graph with `libc` replaced by Kandelo's fork and patches/ applied, and
# pkg-config over the dependency closure for the gtk-rs -sys crates.
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). When invoked via
# `cargo xtask build-deps resolve librsvg`, the resolver sets:
#
#     WASM_POSIX_DEP_OUT_DIR          # install prefix
#     WASM_POSIX_DEP_VERSION          # upstream version
#     WASM_POSIX_DEP_SOURCE_URL       # tarball URL
#     WASM_POSIX_DEP_SOURCE_SHA256    # expected sha256 of the tarball
#     WASM_POSIX_DEP_PKG_CONFIG_PATH  # every transitive dep's lib/pkgconfig

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$SCRIPT_DIR"
# Source, build scratch and patched copies live in the resolver-owned work
# root (or a direct run's private one), never under the reviewed checkout.
# shellcheck source=/dev/null
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
SRC_DIR="$WORK_DIR/librsvg-src"
BUILD_DIR="$WORK_DIR/librsvg-build"
VERIFIED_SOURCE_DIR="${WASM_POSIX_DEP_SOURCE_DIR:-}"

LIBRSVG_VERSION="$WASM_POSIX_DEP_VERSION"
LIBRSVG_SERIES="${LIBRSVG_VERSION%.*}"
INSTALL_DIR="${WASM_POSIX_DEP_OUT_DIR:-$WORK_DIR/librsvg-install}"
SOURCE_URL="$WASM_POSIX_DEP_SOURCE_URL"
SOURCE_SHA256="$WASM_POSIX_DEP_SOURCE_SHA256"

CROSS_FILE="$REPO_ROOT/sdk/meson/wasm32posix.ini"

for tool in wasm32posix-cc meson ninja cargo cargo-cbuild rustc python3; do
    if ! command -v "$tool" &>/dev/null; then
        echo "ERROR: $tool not found. Enter scripts/dev-shell.sh." >&2
        exit 1
    fi
done

# Static meson lookups follow Requires.private, and the -sys crates'
# pkg-config probes need the same closure (pango -> harfbuzz, cairo ->
# pixman, ...), which the resolver composes.
DEP_PKG_CONFIG_PATH="${WASM_POSIX_DEP_PKG_CONFIG_PATH:?WASM_POSIX_DEP_PKG_CONFIG_PATH not set (must be invoked via cargo xtask build-deps resolve librsvg)}"

# --- Stage verified source ----------------------------------------------
# Always fresh: the crate-graph step below rewrites Cargo.lock.
rm -rf "$SRC_DIR"
echo "==> Staging verified librsvg $LIBRSVG_VERSION source..."
kandelo_package_stage_verified_source librsvg "$SRC_DIR" "$VERIFIED_SOURCE_DIR" \
    "$SOURCE_URL" "$SOURCE_SHA256" "$WORK_DIR"

# shellcheck source=rust-build-env.sh
source "$SCRIPT_DIR/rust-build-env.sh"
librsvg_rust_build_env "$REPO_ROOT" "$SRC_DIR" "$WORK_DIR" "$DEP_PKG_CONFIG_PATH"

# --- Meson ---------------------------------------------------------------
# meson.build looks up `rustc` to ask for the target's native static
# libraries; the system rustc does not know the Kandelo target, so the
# machine file points it at the sysroot wrapper.
RUST_MACHINE_FILE="$WORK_DIR/rust-machine.ini"
cat > "$RUST_MACHINE_FILE" <<EOF
[binaries]
rustc = '$LIBRSVG_RUSTC'
cargo = '$(command -v cargo)'
EOF

# Fresh build dir each run — meson bakes --prefix into the build tree.
rm -rf "$BUILD_DIR"
# The resolver-created output directory is itself publication authority, so
# a recipe must populate that inode rather than delete and recreate it.
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    if [ -n "$(find "$INSTALL_DIR" -mindepth 1 -print -quit)" ]; then
        echo "ERROR: librsvg resolver output directory must start empty" >&2
        exit 1
    fi
else
    rm -rf "$INSTALL_DIR"
fi

echo "==> Configuring librsvg $LIBRSVG_VERSION for wasm32..."
meson setup "$BUILD_DIR" "$SRC_DIR" \
    --cross-file "$CROSS_FILE" \
    --cross-file "$RUST_MACHINE_FILE" \
    --prefix "$INSTALL_DIR" \
    --libdir lib \
    -Dbuildtype=release \
    -Doptimization=2 \
    -Dtriplet="$LIBRSVG_RUST_TARGET" \
    -Dpixbuf=enabled \
    -Dpixbuf-loader=disabled \
    -Davif=disabled \
    -Drsvg-convert=disabled \
    -Dintrospection=disabled \
    -Dvala=disabled \
    -Ddocs=disabled \
    -Dtests=false

echo "==> Building librsvg..."
ninja -C "$BUILD_DIR"

echo "==> Installing to $INSTALL_DIR..."
meson install -C "$BUILD_DIR" --no-rebuild

for out in lib/librsvg-2.a lib/pkgconfig/librsvg-2.0.pc include/librsvg-2.0/librsvg/rsvg.h; do
    if [ ! -f "$INSTALL_DIR/$out" ]; then
        echo "ERROR: Build failed — $out not found under $INSTALL_DIR" >&2
        exit 1
    fi
done

echo "==> librsvg $LIBRSVG_VERSION build complete!"
ls -lh "$INSTALL_DIR/lib/librsvg-2.a"
