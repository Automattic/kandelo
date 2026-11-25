#!/usr/bin/env bash
# Build the reusable engine, without a shell, compatibility frontend or Node owners.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$SCRIPT_DIR"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
: "${WASM_POSIX_DEP_WORK_DIR:?build through the normal package resolver}"
: "${WASM_POSIX_DEP_OUT_DIR:?build through the normal package resolver}"
: "${WASM_POSIX_DEP_LIBCXX_DIR:?declare libcxx}"
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
SOURCE="$WORK_DIR/spidermonkey-source"
OBJECT="$WORK_DIR/obj"
OUT="$WASM_POSIX_DEP_OUT_DIR"
source "$REPO_ROOT/sdk/activate.sh"
export WASM_POSIX_SYSROOT="$(kandelo_package_prepare_private_sysroot spidermonkey-core "$REPO_ROOT/sysroot" libcxx)"
kandelo_package_stage_primary_source spidermonkey-core "$SOURCE" "$WORK_DIR"
python3 "$SCRIPT_DIR/apply-engine-patches.py" --source "$SOURCE" \
    --package "$SCRIPT_DIR" --receipt "$WORK_DIR/engine-patches-applied.json"
# Maintained platform implementations use the original upstream build owners.
install -m644 "$SCRIPT_DIR/platform/getrandom.rs" "$SOURCE/build/rust/getrandom/kandelo_getrandom.rs"
install -m644 "$SCRIPT_DIR/platform/wasm_binary_symbols.py" "$SOURCE/python/mozbuild/mozbuild/action/wasm_binary_symbols.py"
export CC='wasm32posix-cc -D__kandelo__=1'
export CXX='wasm32posix-c++ -D__kandelo__=1'
export AS='wasm32posix-cc -D__kandelo__=1'
export AR=wasm32posix-ar RANLIB=wasm32posix-ranlib NM=wasm32posix-nm STRIP=wasm32posix-strip
export HOST_CC="${HOST_CC:-cc}" HOST_CXX="${HOST_CXX:-c++}"
export CFLAGS="${CFLAGS:-} -D_GNU_SOURCE"
export CXXFLAGS="${CXXFLAGS:-} -D_GNU_SOURCE -fexceptions -ferror-limit=0"
export LDFLAGS="${LDFLAGS:-} -lc++ -lc++abi -lpthread -Wl,--error-limit=0"
export PKG_CONFIG_LIBDIR="$WASM_POSIX_DEP_LIBCXX_DIR/lib/pkgconfig"
export PKG_CONFIG_PATH="$PKG_CONFIG_LIBDIR"
export MOZCONFIG="$WORK_DIR/mozconfig"
export MOZBUILD_STATE_PATH="$WORK_DIR/mozbuild-state"
export MACH_BUILD_PYTHON_NATIVE_PACKAGE_SOURCE=system
MACH_CARGO_HOME="$WORK_DIR/mach-cargo-home"
mkdir -p "$MACH_CARGO_HOME"
if [ "$(uname -s)" = Darwin ]; then
    : "${KANDELO_MACOS_SDK_DIR:?the declared dev shell must supply the matching macOS SDK}"
    export SDKROOT="$KANDELO_MACOS_SDK_DIR"
    if [ -n "${KANDELO_MACOS_DEVELOPER_DIR:-}" ]; then
        export DEVELOPER_DIR="$KANDELO_MACOS_DEVELOPER_DIR"
    fi
fi
cat > "$MOZCONFIG" <<EOF
export RUSTFLAGS="\${RUSTFLAGS:+\$RUSTFLAGS }-Ctarget-feature=+atomics,+bulk-memory,+mutable-globals --cfg=getrandom_backend=\"custom\" --remap-path-prefix=$WORK_DIR=/usr/src/kandelo-build/spidermonkey-core"
ac_add_options --enable-project=js
ac_add_options --target=wasm32-unknown-kandelo
ac_add_options --prefix=$OUT
ac_add_options --disable-js-shell
ac_add_options --disable-shared-js
ac_add_options --disable-debug
ac_add_options --enable-optimize=-O2
ac_add_options --disable-jit
ac_add_options --disable-jemalloc
ac_add_options --without-system-zlib
ac_add_options --with-intl-api
ac_add_options --enable-icu4x
ac_add_options --enable-shared-memory
ac_add_options --disable-clang-plugin
ac_add_options --disable-tests
ac_add_options --disable-debug-symbols
mk_add_options MOZ_OBJDIR=$OBJECT
mk_add_options MOZ_MAKE_FLAGS="-k -j${WASM_POSIX_BUILD_JOBS:-8}"
EOF
if [ "$(uname -s)" = Darwin ]; then
    echo "ac_add_options --with-macos-sdk=$KANDELO_MACOS_SDK_DIR" >> "$MOZCONFIG"
fi
(
    cd "$SOURCE"
    CARGO_HOME="$MACH_CARGO_HOME" ./mach --no-interactive build
)
# The upstream install rules preserve the full public/generated header set.
# The standalone make install rule consumes this moz.build naming variable,
# which its generated backend does not otherwise emit for the static target.
# Supplying the original value avoids an unclaimed libjs_static.ajs duplicate.
make -C "$OBJECT/js/src/build" STATIC_LIBRARY_NAME=js_static install
python3 "$SCRIPT_DIR/install-core.py" --object "$OBJECT" --output "$OUT" \
    --source "$SOURCE" --patch-receipt "$WORK_DIR/engine-patches-applied.json"
