#!/usr/bin/env bash
# Cross-compile GNU gettext's tools for Kandelo. Outputs one .wasm per
# program and gettext-data.zip (scripts, macros and data, mounted at /usr).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$HERE"
kandelo_package_prepare_build_roots "$HERE" wasm32
WORK="$KANDELO_PACKAGE_WORK_DIR"
SRC="$WORK/gettext-src"
STAGE="$WORK/gettext-stage"
source "$REPO_ROOT/sdk/activate.sh"
export WASM_POSIX_SYSROOT="$REPO_ROOT/sysroot"

PROGRAMS=(envsubst gettext ngettext printf_gettext printf_ngettext msgattrib msgcat msgcmp msgcomm msgconv msgen msgexec msgfilter msgfmt msggrep msginit msgmerge msgpre msgunfmt msguniq recode-sr-latin xgettext)

rm -rf "$SRC" "$STAGE"
kandelo_package_stage_primary_source gettext "$SRC" "$WORK"
for patch in "$HERE"/patches/*.patch; do
    patch -p1 -d "$SRC" < "$patch"
done

cd "$SRC"
echo "==> Configuring gettext..."
# The infrastructure archive autopoint unpacks stays xz-compressed (the
# default); Kandelo's shell and build image carry tar and xz.
wasm32posix-configure \
    --prefix=/usr \
    --disable-shared \
    --enable-static \
    --disable-nls \
    --disable-java \
    --disable-csharp \
    --disable-openmp \
    --disable-libasprintf \
    --disable-curses \
    --disable-acl \
    --without-emacs \
    --without-git \
    --without-cvs \
    2>&1 | tail -15
echo "==> Building gettext..."
make -j"$(sysctl -n hw.ncpu 2>/dev/null || nproc)" 2>&1 | tail -10
make install DESTDIR="$STAGE" 2>&1 | tail -5

TREE="$STAGE/usr"
for program in "${PROGRAMS[@]}"; do
    [ -f "$TREE/bin/$program" ] || { echo "ERROR: $program was not built" >&2; exit 1; }
    mv "$TREE/bin/$program" "$WORK/$program.wasm"
done
# spit is a Python helper for submitting translations; it is not shipped.
rm -f "$TREE/bin/spit"
# Development files for libgettextpo and libtextstyle: the guest compiler
# links against the SDK sysroot, which does not include package libraries.
rm -rf "$TREE/include" "$TREE/lib" "$TREE/share/man" "$TREE/share/info" \
    "$TREE/share/doc" "$TREE/share/locale"
python3 "$REPO_ROOT/scripts/rewrite-guest-tool-paths.py" "$TREE" \
    --map "$WASM_POSIX_SYSROOT=/usr/lib/kandelo/wasm32posix/sysroot" \
    "$WORK" "$REPO_ROOT" "$SRC"
bash "$REPO_ROOT/images/vfs/scripts/create-deterministic-zip.sh" "$TREE" "$WORK/gettext-data.zip"

cd "$REPO_ROOT"
if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
fi
source "$REPO_ROOT/scripts/install-local-binary.sh"
WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled \
    install_local_binary gettext "$WORK/gettext-data.zip" gettext-data.zip
for program in "${PROGRAMS[@]}"; do
    WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto \
        install_local_binary gettext "$WORK/$program.wasm" "$program.wasm"
done
