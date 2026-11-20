#!/usr/bin/env bash
#
# Build busybox for wasm32-posix-kernel.
#
# BusyBox configures through its own Kconfig: allnoconfig, then the options
# in fragment.config, so the binary holds only the applets the fragment
# names. It links through the SDK compiler for both the per-directory
# relocatable links and the final executable link.
#
# Honors the dep-resolver build-script contract (see
# docs/package-management.md). When invoked via
# `cargo xtask build-deps resolve busybox`, env vars are set by the
# resolver:
#
#     WASM_POSIX_DEP_OUT_DIR          # install prefix
#     WASM_POSIX_DEP_VERSION          # upstream version
#     WASM_POSIX_DEP_SOURCE_URL       # tarball URL
#     WASM_POSIX_DEP_SOURCE_SHA256    # expected sha256 of the tarball

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
source "$REPO_ROOT/scripts/package-build-roots.sh"
source "$REPO_ROOT/sdk/activate.sh"
kandelo_package_load_source_metadata "$SCRIPT_DIR"
# shellcheck source=/dev/null
kandelo_package_prepare_build_roots "$SCRIPT_DIR" wasm32
SRC_DIR="$KANDELO_PACKAGE_WORK_DIR/busybox-src"

BUSYBOX_VERSION="$WASM_POSIX_DEP_VERSION"
SOURCE_URL="$WASM_POSIX_DEP_SOURCE_URL"
SOURCE_SHA256="$WASM_POSIX_DEP_SOURCE_SHA256"

if ! command -v wasm32posix-cc &>/dev/null; then
    echo "ERROR: wasm32posix-cc not found. Enter scripts/dev-shell.sh." >&2
    exit 1
fi

# --- Stage verified source ---
if [ ! -d "$SRC_DIR" ]; then
    echo "==> Staging verified busybox $BUSYBOX_VERSION source..."
    kandelo_package_stage_verified_source busybox "$SRC_DIR" \
        "${WASM_POSIX_DEP_SOURCE_DIR:-}" "$SOURCE_URL" "$SOURCE_SHA256" \
        "$KANDELO_PACKAGE_WORK_DIR"

    for patch_file in "$SCRIPT_DIR"/patches/*.patch; do
        echo "==> Applying $(basename "$patch_file")..."
        kandelo_package_git_apply_patch "$SRC_DIR" "$patch_file"
    done
fi

cd "$SRC_DIR"
echo "==> Configuring busybox $BUSYBOX_VERSION..."
# Kconfig's helper programs run on the build machine.
make HOSTCC=cc allnoconfig
while IFS= read -r line; do
    case "$line" in
        CONFIG_*=y)
            option="${line%%=*}"
            sed -i "s/^# $option is not set\$/$line/" .config
            ;;
        "# CONFIG_"*" is not set")
            option="${line#\# }"
            option="${option%% *}"
            sed -i "s/^$option=y\$/$line/" .config
            ;;
    esac
done < "$SCRIPT_DIR/fragment.config"
make HOSTCC=cc oldconfig < /dev/null

echo "==> Building busybox..."
make HOSTCC=cc CC=wasm32posix-cc AR=llvm-ar SKIP_STRIP=y -j"$(nproc)" busybox

# A resolver caller owns the declared work and output roots. Keep the
# reviewed checkout read-only and suppress the developer-only local mirror.
if [ -n "${WASM_POSIX_DEP_WORK_DIR:-}" ] && [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    export WASM_POSIX_INSTALL_LOCAL_MIRROR=0
    # setsid forks when its caller leads a process group.
    export WASM_POSIX_INSTALL_FORK_INSTRUMENTATION=auto
fi
cd "$REPO_ROOT"
source "$REPO_ROOT/scripts/install-local-binary.sh"
cp "$SRC_DIR/busybox" "$SRC_DIR/busybox.wasm"
install_local_binary busybox "$SRC_DIR/busybox.wasm" busybox.wasm

echo "==> busybox $BUSYBOX_VERSION build complete!"
