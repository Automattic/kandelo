#!/usr/bin/env bash
# Build original Node startup and every native component in its standard profile.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
: "${WASM_POSIX_DEP_WORK_DIR:?build through the normal package resolver}"
: "${WASM_POSIX_DEP_OUT_DIR:?build through the normal package resolver}"
: "${WASM_POSIX_DEP_SPIDERMONKEY_CORE_DIR:?declare the actual SpiderMonkey core}"
: "${WASM_POSIX_DEP_V8_TRACING_DIR:?declare portable platform and tracing support}"
: "${WASM_POSIX_DEP_LIBCXX_DIR:?declare the libcxx dependency}"
: "${WASM_POSIX_DEP_LIBUV_DIR:?declare the libuv dependency}"
: "${WASM_POSIX_DEP_NODE_LIBFFI_DIR:?declare the pinned Node libffi target}"
: "${WASM_POSIX_DEP_KANDELO_FFI_ADAPTER_DIR:?declare typed FFI adapter linkage}"
: "${WASM_POSIX_DEP_NODE_AMARO_DIR:?declare the actual native Amaro provider}"
: "${WASM_POSIX_DEP_NODE_UNDICI_LLHTTP_DIR:?declare the exact Undici native parser provider}"
PACKAGE_NAME="${WASM_POSIX_DEP_NAME:?resolver must identify the package}"
[ "$#" = 0 ] || { echo "ERROR: unexpected internal Node build argument" >&2; exit 2; }
OUTPUT_NAME=node.wasm
if [ "${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}" != wasm32 ]; then
    echo "ERROR: the approved initial Node target is wasm32." >&2
    exit 2
fi

# The package entrypoint builds the internal bridge and prepares this overlay once.
ENGINE_CONFIGURATION="${KANDELO_NODE_ENGINE_CONFIGURATION:?internal engine configuration}"
NODE_SOURCE="$WASM_POSIX_DEP_WORK_DIR/node-source"
if [ ! -d "$NODE_SOURCE" ]; then
    kandelo_package_stage_source_dependency node-core-source "$NODE_SOURCE" "$WASM_POSIX_DEP_WORK_DIR"
fi
for patch_file in "$SCRIPT_DIR"/patches/*.patch; do
    patch --batch -p1 -F0 -d "$NODE_SOURCE" < "$patch_file"
done
for patch_file in "$REPO_ROOT/packages/registry/spidermonkey-node/bridge/native-source-patches"/*.patch; do
    patch --batch -p1 -F0 -d "$NODE_SOURCE" < "$patch_file"
done
python3 "$SCRIPT_DIR/prepare-native-providers.py" --repository "$REPO_ROOT" \
    --source "$NODE_SOURCE" --work "$WASM_POSIX_DEP_WORK_DIR/native-provider-configuration"

AMARO_CONFIGURATION="$WASM_POSIX_DEP_WORK_DIR/native-amaro-configuration"
python3 "$SCRIPT_DIR/prepare-native-amaro.py" --source "$NODE_SOURCE" \
    --provider "$WASM_POSIX_DEP_NODE_AMARO_DIR" --adapter "$SCRIPT_DIR/node_amaro.cc" \
    --output "$AMARO_CONFIGURATION"
UNDICI_CONFIGURATION="$WASM_POSIX_DEP_WORK_DIR/native-undici-configuration"
python3 "$SCRIPT_DIR/prepare-native-undici.py" --source "$NODE_SOURCE" \
    --provider "$WASM_POSIX_DEP_NODE_UNDICI_LLHTTP_DIR" --adapter "$SCRIPT_DIR/node_undici_llhttp.cc" \
    --output "$UNDICI_CONFIGURATION"
UNDICI_LINK_FLAGS=""
while IFS= read -r flag; do UNDICI_LINK_FLAGS+=" $flag"; done < "$UNDICI_CONFIGURATION/link-flags.txt"
AMARO_LINK_FLAGS=""
while IFS= read -r flag; do AMARO_LINK_FLAGS+=" $flag"; done < "$AMARO_CONFIGURATION/link-flags.txt"

export CC="wasm32posix-cc -D__kandelo__=1" CXX="wasm32posix-c++ -D__kandelo__=1"
export AR=wasm32posix-ar RANLIB=wasm32posix-ranlib
export CC_host="${HOST_CC:-cc}" CXX_host="${HOST_CXX:-c++}"
# The target lacks guard pages. Match standalone OpenSSL's no-secure-memory build.
export CFLAGS="${CFLAGS:-} -DUV_PLATFORM_KANDELO=1 -DOPENSSL_NO_SECURE_MEMORY"
export CXXFLAGS="${CXXFLAGS:-} -DUV_PLATFORM_KANDELO=1 -DOPENSSL_NO_SECURE_MEMORY -DV8_PLATFORM_KANDELO=1 -DKANDELO_SPIDERMONKEY_ENGINE=1 -DXP_UNIX=1 -ferror-limit=0 -nostdinc++ -isystem $WASM_POSIX_DEP_LIBCXX_DIR/include/c++/v1 -isystem $WASM_POSIX_SYSROOT/include/kandelo-node-engine -isystem $WASM_POSIX_SYSROOT/include/mozjs-153 -isystem $WASM_POSIX_SYSROOT/include"
export LDFLAGS="${LDFLAGS:-} -Wl,--error-limit=0$AMARO_LINK_FLAGS$UNDICI_LINK_FLAGS"
# Search declared target inputs, never ambient host libraries. Other providers
# retain their original isolated targets inside Node's private build tree.
export PKG_CONFIG="pkg-config --static"
export PKG_CONFIG_LIBDIR="$ENGINE_CONFIGURATION:$WASM_POSIX_DEP_LIBUV_DIR/lib/pkgconfig:$WASM_POSIX_DEP_NODE_LIBFFI_DIR/lib/pkgconfig:$WASM_POSIX_DEP_KANDELO_FFI_ADAPTER_DIR/lib/pkgconfig"
export PKG_CONFIG_PATH="$PKG_CONFIG_LIBDIR"
(
    cd "$NODE_SOURCE"
    python3 configure.py --dest-cpu=wasm32 --dest-os=kandelo --cross-compiling \
        --without-bundled-v8 --without-inspector --without-node-snapshot \
        --shared-libuv --shared-libuv-includes="$WASM_POSIX_DEP_LIBUV_DIR/include" \
        --shared-libuv-libpath="$WASM_POSIX_DEP_LIBUV_DIR/lib" --with-intl=full-icu \
        --shared-ffi --shared-ffi-includes="$WASM_POSIX_DEP_NODE_LIBFFI_DIR/include" \
        --shared-ffi-libname=ffi,kandelo-ffi-adapter \
        --openssl-no-asm
    python3 "$SCRIPT_DIR/check-native-profile.py" "$NODE_SOURCE/config.gypi"
    # -k collects independent compiler/link failures across the entire graph.
    # Original registration, node_main.cc and node.cc remain authoritative.
    # The root Makefile's node recipe invokes the generated default 'all'
    # target, including unconsumed bundled libuv and test-tool targets. Select
    # the original GYP node target and its complete dependency closure instead.
    make -C out -k --output-sync=target -j"${WASM_POSIX_BUILD_JOBS:-8}" V=1 BUILDTYPE=Release node
)
NODE_PROGRAM="$NODE_SOURCE/out/Release/node"
if [ ! -f "$NODE_PROGRAM" ] || [ -L "$NODE_PROGRAM" ]; then
    echo "ERROR: original Node build did not produce out/Release/node." >&2
    exit 1
fi
source "$REPO_ROOT/scripts/install-local-binary.sh"
export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto install_local_binary "$PACKAGE_NAME" "$NODE_PROGRAM" "$OUTPUT_NAME"
