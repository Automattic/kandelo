#!/usr/bin/env bash
# Package-system build wrapper for the canonical base rootfs image.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    require_resolver_root() {
        local env_name="$1" value="$2"
        case "$value" in
            /*) ;;
            *)
                echo "ERROR: $env_name must be an absolute path" >&2
                exit 2
                ;;
        esac
        if [ ! -d "$value" ] || [ -L "$value" ]; then
            echo "ERROR: $env_name must name a real directory: $value" >&2
            exit 2
        fi
    }

    require_resolver_root WASM_POSIX_DEP_OUT_DIR "$WASM_POSIX_DEP_OUT_DIR"
    require_resolver_root \
        WASM_POSIX_DEP_WORK_DIR \
        "${WASM_POSIX_DEP_WORK_DIR:-}"

    repo_real="$(cd "$REPO_ROOT" && pwd -P)"
    out_real="$(cd "$WASM_POSIX_DEP_OUT_DIR" && pwd -P)"
    work_real="$(cd "$WASM_POSIX_DEP_WORK_DIR" && pwd -P)"
    case "$out_real/" in
        "$repo_real/"*)
            echo "ERROR: resolver output root must be outside the source checkout" >&2
            exit 2
            ;;
    esac
    case "$work_real/" in
        "$repo_real/"*)
            echo "ERROR: resolver work root must be outside the source checkout" >&2
            exit 2
            ;;
    esac
    case "$out_real/" in
        "$work_real/"*)
            echo "ERROR: resolver output root must not be nested under its work root" >&2
            exit 2
            ;;
    esac
    case "$work_real/" in
        "$out_real/"*)
            echo "ERROR: resolver work root must not be nested under its output root" >&2
            exit 2
            ;;
    esac

    VFS="$out_real/rootfs.vfs"
    ROOTFS_OUT="$VFS" \
        ROOTFS_PACKAGE_MANIFEST="$work_real/rootfs-packages.MANIFEST" \
        ROOTFS_BINARIES_DIR="$work_real/rootfs-binaries" \
        ROOTFS_SKIP_PACKAGE_RESOLVE=1 \
        ROOTFS_STAGE_RESOLVER_BINARIES=1 \
        ROOTFS_SEALED_BUILD=1 \
        bash "$REPO_ROOT/scripts/build-rootfs.sh"
else
    bash "$REPO_ROOT/scripts/build-rootfs.sh"
    VFS="$REPO_ROOT/host/wasm/rootfs.vfs"
    [ -f "$VFS" ] || { echo "ERROR: $VFS not produced by builder" >&2; exit 1; }

    source "$REPO_ROOT/scripts/install-local-binary.sh"
    install_local_binary rootfs "$VFS"

    mkdir -p "$REPO_ROOT/local-binaries"
    cp "$VFS" "$REPO_ROOT/local-binaries/rootfs.vfs"
    echo "  installed $REPO_ROOT/local-binaries/rootfs.vfs"
fi

[ -f "$VFS" ] && [ ! -L "$VFS" ] || {
    echo "ERROR: exact rootfs.vfs was not produced: $VFS" >&2
    exit 1
}
