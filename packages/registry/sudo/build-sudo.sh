#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32

SOURCE_URL="https://github.com/sudo-project/sudo/archive/refs/tags/v1.9.17p2.tar.gz"
SOURCE_SHA256="cabee23359afa698d147478c3a141437dbfecb510382e114eaf4b5087a1f8ca5"
SOURCE_DIR="$KANDELO_PACKAGE_WORK_DIR/sudo-source"
BUILD_DIR="$KANDELO_PACKAGE_WORK_DIR/sudo-build"
PATCH_FILE="$SCRIPT_DIR/patches/wasm-main-envp.patch"

for required in "$PATCH_FILE" "$REPO_ROOT/scripts/run-wasm-fork-instrument.sh"; do
    if [ ! -f "$required" ] || [ -L "$required" ]; then
        echo "ERROR: sudo build input must be a regular file: $required" >&2
        exit 2
    fi
done
for tool in make patch; do
    command -v "$tool" >/dev/null 2>&1 || {
        echo "ERROR: sudo requires host tool $tool" >&2
        exit 2
    }
done

kandelo_package_stage_verified_source sudo "$SOURCE_DIR" \
    "${WASM_POSIX_DEP_SOURCE_DIR:-}" "$SOURCE_URL" "$SOURCE_SHA256" \
    "$KANDELO_PACKAGE_WORK_DIR"
if [ -e "$BUILD_DIR" ] || [ -L "$BUILD_DIR" ]; then
    echo "ERROR: sudo build directory is already occupied: $BUILD_DIR" >&2
    exit 2
fi
mkdir -m 0700 "$BUILD_DIR"
patch -d "$SOURCE_DIR" -p1 < "$PATCH_FILE"

source "$REPO_ROOT/sdk/activate.sh"
export WASM_POSIX_SYSROOT="$REPO_ROOT/sysroot"
SDK_ROOT="$(cd "$(dirname "$(command -v wasm32posix-configure)")/.." && pwd)"
if [ ! -f "$SDK_ROOT/config.site" ] || [ -L "$SDK_ROOT/config.site" ]; then
    echo "ERROR: sudo requires the SDK config.site" >&2
    exit 2
fi

(
    cd "$BUILD_DIR"
    export ac_cv_func_devname=no ac_cv_func_freezero=no
    export ac_cv_func_getutsid=no ac_cv_func_getutxid=yes
    export ac_cv_func__innetgr=no ac_cv_func_innetgr=no
    export ac_cv_func_mkdtempat=no ac_cv_func_mkostempsat=no
    export ac_cv_func_pw_dup=no ac_cv_func_setgroupent=no
    export ac_cv_func_setpassent=no ac_cv_func_sysctl=no
    export CONFIG_SITE="$SDK_ROOT/config.site"
    PREFIX_MAPS="-ffile-prefix-map=$KANDELO_PACKAGE_WORK_DIR=/usr/src/sudo-1.9.17p2"
    PREFIX_MAPS+=" -fdebug-prefix-map=$KANDELO_PACKAGE_WORK_DIR=/usr/src/sudo-1.9.17p2"
    PREFIX_MAPS+=" -fmacro-prefix-map=$KANDELO_PACKAGE_WORK_DIR=/usr/src/sudo-1.9.17p2"
    PREFIX_MAPS+=" -fdebug-compilation-dir=/usr/src/sudo-1.9.17p2"
    export CFLAGS="-O2 -D_GNU_SOURCE $PREFIX_MAPS"

    "$SOURCE_DIR/configure" \
        --host=wasm32-unknown-none --prefix=/usr --sysconfdir=/etc \
        --localstatedir=/var --runstatedir=/var/run --disable-nls \
        --without-pam --without-sendmail --without-interfaces \
        --disable-log-server --disable-log-client --disable-shared-libutil \
        --enable-static-sudoers --disable-shared --enable-static \
        --disable-hardening --disable-pie --with-logging=file \
        --with-rundir=/var/run/sudo --with-vardir=/var/run/sudo \
        --with-iologdir=/var/log/sudo-io \
        --with-secure-path-value=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
        CC=wasm32posix-cc CXX=wasm32posix-c++ AR=wasm32posix-ar \
        RANLIB=wasm32posix-ranlib NM=wasm32posix-nm STRIP=wasm32posix-strip
    make -j2
)

while IFS=: read -r relative output; do
    linked="$BUILD_DIR/$relative"
    instrumented="$KANDELO_PACKAGE_WORK_DIR/$output"
    if [ ! -f "$linked" ] || [ -L "$linked" ]; then
        echo "ERROR: sudo expected output is unavailable: $relative" >&2
        exit 1
    fi
    "$REPO_ROOT/scripts/run-wasm-fork-instrument.sh" \
        "$linked" -o "$instrumented"
done <<'OUTPUTS'
src/sudo:sudo.wasm
plugins/sudoers/visudo:visudo.wasm
plugins/sudoers/cvtsudoers:cvtsudoers.wasm
plugins/sudoers/sudoreplay:sudoreplay.wasm
OUTPUTS

if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] &&
   [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
fi
source "$REPO_ROOT/scripts/install-local-binary.sh"
for output in sudo visudo cvtsudoers sudoreplay; do
    install_local_binary sudo "$KANDELO_PACKAGE_WORK_DIR/$output.wasm" \
        "$output.wasm"
done
