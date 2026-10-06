#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$HERE" wasm32
kandelo_package_load_source_metadata "$HERE"
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
SRC="$WORK_DIR/jq-src"

if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled
fi

source "$REPO_ROOT/sdk/activate.sh"
export WASM_POSIX_SYSROOT="$REPO_ROOT/sysroot"
kandelo_package_stage_primary_source jq "$SRC" "$WORK_DIR"
cd "$SRC"

# WHY: jq's custom AC_FIND_FUNC probes need ac_cv_funclib_* answers even
# when config.site already sets ac_cv_func_*. Seed these and its libm probes
# from the target libc so jq's feature macros describe the actual sysroot.
wasm32posix-nm "$WASM_POSIX_SYSROOT/lib/libc.a" > "$WORK_DIR/libc-symbols.txt"
while read -r func; do
    if grep -Eq " [TW] ${func}$" "$WORK_DIR/libc-symbols.txt"; then
        export "ac_cv_funclib_${func}=yes"
    else
        export "ac_cv_funclib_${func}=no"
    fi
done < <(sed -n 's/^AC_FIND_FUNC\(_NO_LIBS\)\?(\[\([^]]*\)\].*/\2/p' configure.ac)
while read -r func; do
    if grep -Eq " [TW] ${func}$" "$WORK_DIR/libc-symbols.txt"; then
        export "ac_cv_lib_m_${func}=yes"
    else
        export "ac_cv_lib_m_${func}=no"
    fi
done < <(sed -n 's/^AC_CHECK_MATH_FUNC(\([^)]*\)).*/\1/p' configure.ac)

# Use the release's pinned bundled Oniguruma and retain decimal support.
wasm32posix-configure \
    --prefix=/usr \
    --disable-shared \
    --enable-static \
    --enable-all-static \
    --with-oniguruma=builtin \
    --disable-docs \
    --disable-maintainer-mode \
    LIBS=-lm
make -j"${WASM_POSIX_JOBS:-4}"

source "$REPO_ROOT/scripts/install-local-binary.sh"
install_local_binary jq "$SRC/jq" jq.wasm
