#!/usr/bin/env bash
# Cross-compile sysklogd's syslogd for Kandelo with wasm32posix-cc.
#
# syslogd is the reader of /dev/log and the writer of /var/log, so the syslog
# facility is a real daemon rather than kernel-side special casing of a log
# path. It reads the kernel log from /dev/kmsg, which is the surface Kandelo
# provides, and receives AF_UNIX datagrams from any process using musl's
# syslog(3).
#
# Only syslogd is produced. --without-logger drops sysklogd's own logger,
# which links its libsyslog instead of the system's syslog(3); the `logger`
# command comes from toybox, whose applet calls the system one. Nothing is
# installed into the sysroot: this script copies src/syslogd out and never
# runs `make install`.
#
# A direct build writes packages/registry/sysklogd/bin/syslogd.wasm.
# Resolver/Formula builds write only below their declared work and output roots.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
kandelo_package_load_source_metadata "$HERE"
# shellcheck source=/dev/null
kandelo_package_prepare_build_roots "$HERE" wasm32
WORK_DIR="$KANDELO_PACKAGE_WORK_DIR"
SRC="$WORK_DIR/sysklogd-src"
OUT_BIN="$WORK_DIR/syslogd.wasm"
SYSROOT="$REPO_ROOT/sysroot"

SYSKLOGD_VERSION="$WASM_POSIX_DEP_VERSION"
SOURCE_URL="$WASM_POSIX_DEP_SOURCE_URL"
SOURCE_SHA256="$WASM_POSIX_DEP_SOURCE_SHA256"
VERIFIED_SOURCE_DIR="${WASM_POSIX_DEP_SOURCE_DIR:-}"
SOURCE_MARKER="$SRC/.kandelo-sysklogd-source"

# A resolver/Formula caller owns the declared work and output roots, so
# suppress the developer-only local mirror. The fork policy is deliberately
# not overridden here: syslogd daemonizes, so package.toml asks for "auto"
# and install_local_binary applies it. Forcing "disabled" the way a
# non-forking package does would contradict the manifest, and the installer
# refuses that disagreement rather than silently shipping an uninstrumented
# binary that cannot fork.
if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
fi

source "$REPO_ROOT/sdk/activate.sh"
export WASM_POSIX_SYSROOT="$SYSROOT"

if compgen -G "$HERE/patches/*.patch" > /dev/null; then
    patch_set_sha256="$(shasum -a 256 "$HERE"/patches/*.patch | shasum -a 256 | awk '{print $1}')"
else
    patch_set_sha256="none"
fi
expected_source_marker="$(printf '%s\n%s\n%s\n%s' \
    "$SYSKLOGD_VERSION" "$SOURCE_URL" "$SOURCE_SHA256" "$patch_set_sha256")"
if [ -d "$SRC" ] && \
   [ "$(cat "$SOURCE_MARKER" 2>/dev/null || true)" != "$expected_source_marker" ]; then
    rm -rf "$SRC" "$OUT_BIN"
fi
if [ ! -d "$SRC" ]; then
    echo "==> Staging pinned sysklogd source..."
    kandelo_package_stage_verified_source sysklogd "$SRC" \
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

# Wasm32 type sizes, so configure records them instead of guessing from a
# test program it cannot run here.
export ac_cv_sizeof_long=4
export ac_cv_sizeof_long_long=8
export ac_cv_sizeof_int=4
export ac_cv_sizeof_size_t=4

echo "==> Configuring sysklogd..."
# The SDK configures with --prefix=/usr, which would place the config at
# /usr/etc/syslog.conf and the pid/cache under /usr/var/run. Name the FHS
# locations the rest of the image uses: /etc for configuration, /run for
# runtime state (the kernel serves /run, not /var/run), /var for the logs
# themselves.
wasm32posix-configure \
    --without-logger \
    --without-systemd \
    --sysconfdir=/etc \
    --runstatedir=/run \
    --localstatedir=/var \
    --enable-static \
    --disable-shared \
    2>&1 | tail -25

echo "==> Building syslogd..."
make -C src syslogd 2>&1 | tail -25

if [ ! -f "$SRC/src/syslogd" ]; then
    echo "ERROR: syslogd binary not found after build" >&2
    exit 1
fi
cp "$SRC/src/syslogd" "$OUT_BIN"
ls -la "$OUT_BIN"
echo "==> syslogd.wasm built."

cd "$REPO_ROOT"
source "$REPO_ROOT/scripts/install-local-binary.sh"
# syslogd daemonizes, so the manifest asks for fork instrumentation; the
# installer applies the policy from package.toml.
install_local_binary sysklogd "$OUT_BIN" syslogd.wasm
