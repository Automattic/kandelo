#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$SCRIPT_DIR"
source "$REPO_ROOT/sdk/activate.sh"
ARCH="${WASM_POSIX_DEP_TARGET_ARCH:-wasm32}"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" "$ARCH"
WORK_DIR="$(kandelo_package_make_work_dir libevent-tests)"
trap 'rm -rf "$WORK_DIR"' EXIT
SRC_DIR="$WORK_DIR/source"
: "${WASM_POSIX_DEP_LIBEVENT_DIR:?declare the libevent dependency}"
: "${WASM_POSIX_DEP_ZLIB_DIR:?declare the zlib dependency}"
kandelo_package_stage_primary_source libevent-tests "$SRC_DIR" "$WORK_DIR"
export CPPFLAGS="${CPPFLAGS:-} -I$WASM_POSIX_DEP_ZLIB_DIR/include"
export LDFLAGS="${LDFLAGS:-} -L$WASM_POSIX_DEP_ZLIB_DIR/lib"
source "$REPO_ROOT/packages/registry/libevent/configure-libevent.sh"
kandelo_libevent_configure "$SRC_DIR" "$ARCH"
# Use upstream's unchanged test sources/build rules, but link the declared
# resolver library rather than building a second private libevent copy.
# TESTPROGRAMS supplies an additional blanket dependency on a private
# libevent.la; the explicit regress prerequisites below replace that too.
make -j4 test/regress TESTPROGRAMS= \
    "test_regress_DEPENDENCIES=$WASM_POSIX_DEP_LIBEVENT_DIR/lib/libevent_pthreads.a $WASM_POSIX_DEP_LIBEVENT_DIR/lib/libevent.a" \
    "test_regress_LDADD=$WASM_POSIX_DEP_LIBEVENT_DIR/lib/libevent_pthreads.a $WASM_POSIX_DEP_LIBEVENT_DIR/lib/libevent.a -pthread -L$WASM_POSIX_DEP_ZLIB_DIR/lib -lz"
"${ARCH}posix-cc" -O2 "$SCRIPT_DIR/backend.c" \
    -I"$WASM_POSIX_DEP_LIBEVENT_DIR/include" \
    "$WASM_POSIX_DEP_LIBEVENT_DIR/lib/libevent_core.a" -o "$WORK_DIR/backend.wasm"
export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary libevent-tests "$SRC_DIR/test/regress" libevent-regress.wasm
install_local_binary libevent-tests "$WORK_DIR/backend.wasm" libevent-backend.wasm
