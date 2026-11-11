#!/usr/bin/env bash
# Cross-compile two toybox applets for Kandelo with wasm32posix-cc, each as a
# standalone program: `dmesg`, which reads the kernel log through /dev/kmsg and
# klogctl(), and `logger`, which writes through musl's syslog(3) to /dev/log.
# Nothing else from toybox is built.
#
# toybox builds one command at a time with scripts/single.sh, which turns the
# multiplexer and every other command off, so each binary carries only that
# applet and the library code it actually reaches.
#
# A direct build writes packages/registry/toybox/bin/{dmesg,logger}.wasm.
# Resolver/Formula builds write only below their declared work and output roots.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$HERE"
# shellcheck source=/dev/null
kandelo_package_prepare_build_roots "$HERE" wasm32
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
SRC="$WORK_DIR/toybox-src"
BIN_DIR="$WORK_DIR/bin"
SYSROOT="$REPO_ROOT/sysroot"

TOYBOX_VERSION="$WASM_POSIX_DEP_VERSION"
SOURCE_URL="$WASM_POSIX_DEP_SOURCE_URL"
SOURCE_SHA256="$WASM_POSIX_DEP_SOURCE_SHA256"
VERIFIED_SOURCE_DIR="${WASM_POSIX_DEP_SOURCE_DIR:-}"
SOURCE_MARKER="$SRC/.kandelo-toybox-source"

# The applets this package produces, in output order.
APPLETS=(dmesg logger)

if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=disabled
fi

source "$REPO_ROOT/sdk/activate.sh"
export WASM_POSIX_SYSROOT="$SYSROOT"

if compgen -G "$HERE/patches/*.patch" > /dev/null; then
    patch_set_sha256="$(shasum -a 256 "$HERE"/patches/*.patch | shasum -a 256 | awk '{print $1}')"
else
    patch_set_sha256="none"
fi
expected_source_marker="$(printf '%s\n%s\n%s\n%s' \
    "$TOYBOX_VERSION" "$SOURCE_URL" "$SOURCE_SHA256" "$patch_set_sha256")"
if [ -d "$SRC" ] && \
   [ "$(cat "$SOURCE_MARKER" 2>/dev/null || true)" != "$expected_source_marker" ]; then
    rm -rf "$SRC" "$BIN_DIR"
fi
if [ ! -d "$SRC" ]; then
    echo "==> Staging pinned toybox source..."
    kandelo_package_stage_verified_source toybox "$SRC" \
        "$VERIFIED_SOURCE_DIR" "$SOURCE_URL" "$SOURCE_SHA256" "$WORK_DIR"
    printf '%s\n' "$expected_source_marker" >"$SOURCE_MARKER"
fi

apply_patches() {
    local patch_file name
    echo "==> Applying patches..."
    for patch_file in "$HERE/patches/"*.patch; do
        [ -f "$patch_file" ] || continue
        name="$(basename "$patch_file")"
        if kandelo_package_git_apply_patch "$SRC" "$patch_file" check \
            >/dev/null 2>&1; then
            echo "    $name"
            kandelo_package_git_apply_patch "$SRC" "$patch_file"
        elif GIT_CEILING_DIRECTORIES="$(dirname "$SRC")" git -C "$SRC" apply --reverse --check "$patch_file" >/dev/null 2>&1; then
            echo "    $name (already applied)"
        else
            echo "ERROR: patch $name does not apply cleanly" >&2
            exit 1
        fi
    done
}
apply_patches

cd "$SRC"

# toybox keeps the cross compiler and the build-machine compiler apart itself:
# CC compiles the applet, HOSTCC compiles the small generator programs under
# scripts/ that run here to produce flag and help tables.
export CC=wasm32posix-cc
export HOSTCC=cc
export CROSS_COMPILE=""

# scripts/portability.sh picks its linker flags from `uname` -- the *build*
# machine -- so on macOS it would hand wasm-ld the Mach-O flag -Wl,-dead_strip
# and strip(1) a .wasm file. Name the wasm equivalents instead. This is the
# build host leaking into a cross build, not a Kandelo limitation.
export LDOPTIMIZE="-Wl,--gc-sections"
# Do not run strip(1) on the output. toybox would invoke the build machine's
# strip on a .wasm file, and on failure silently fall back to copying the
# unstripped binary, so this only removes a pointless failed step. It does not
# preserve the wasm name section: the SDK's post-link wasm-opt drops that
# afterwards, and `llvm-objdump --section-headers` confirms the built modules
# carry none.
export NOSTRIP=1


mkdir -p "$BIN_DIR"

# single.sh reads .config for the TOYBOX_* globals it must keep enabled, but
# when no .config exists it writes the generated one to .singleconfig and then
# still reads .config, so those globals come out empty. Generate .config first
# so it reads a real one.
echo "==> Generating a base toybox config..."
make defconfig >/dev/null

echo "==> Building toybox applets: ${APPLETS[*]} ..."
# single.sh writes "$PREFIX<applet>" per command; the trailing slash matters.
PREFIX="$BIN_DIR/" bash scripts/single.sh "${APPLETS[@]}"

cd "$REPO_ROOT"
source "$REPO_ROOT/scripts/install-local-binary.sh"
for applet in "${APPLETS[@]}"; do
    built="$BIN_DIR/$applet"
    if [ ! -f "$built" ]; then
        echo "ERROR: $applet binary not found after build" >&2
        exit 1
    fi
    out="$WORK_DIR/$applet.wasm"
    cp "$built" "$out"
    ls -la "$out"
    # Neither applet forks; both must stay free of fork instrumentation.
    install_local_binary toybox "$out" "$applet.wasm"
done
echo "==> toybox dmesg.wasm and logger.wasm built."
