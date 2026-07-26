#!/usr/bin/env bash
# Temporary exact-main activation recipe for today's browser shell.
#
# This recipe intentionally composes only resolver-owned source-package
# outputs. It does not inspect a tap, pull a bottle, or consult an ambient
# binary mirror. Once exact-default-main bottles exist, the reviewed bottle
# composer replaces this bridge.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
OUT_DIR="${WASM_POSIX_DEP_OUT_DIR:-}"
WORK_DIR="${WASM_POSIX_DEP_WORK_DIR:-}"
ROOTFS_DIR="${WASM_POSIX_DEP_ROOTFS_DIR:-}"
BASH_DIR="${WASM_POSIX_DEP_BASH_DIR:-}"
FBDOOM_DIR="${WASM_POSIX_DEP_FBDOOM_DIR:-}"
MODESET_DIR="${WASM_POSIX_DEP_MODESET_DIR:-}"
TARGET_ARCH="${WASM_POSIX_DEP_TARGET_ARCH:-}"
DECLARED_TOOL_PATH="${KANDELO_DEV_SHELL_TOOL_PATH:-}"
DEPENDENCY_CONTRACT="$REPO_ROOT/homebrew/source-rootfs-shell-dependencies.json"
DEPENDENCY_CONTRACT_READER="$REPO_ROOT/scripts/source-rootfs-shell-dependency-contract.mjs"

fail() {
    echo "build-shell: $*" >&2
    exit 2
}

require_real_directory() {
    local label="$1"
    local path="$2"
    case "$path" in
        /*) ;;
        *) fail "$label must be an absolute resolver-owned directory: $path" ;;
    esac
    if [[ "/${path#/}/" == *'/../'* || "/${path#/}/" == *'/./'* || \
          "/${path#/}/" == *'//'* ]]; then
        fail "$label must be normalized: $path"
    fi
    if [ ! -d "$path" ] || [ -L "$path" ]; then
        fail "$label must be a real directory: $path"
    fi
}

require_regular_file() {
    local label="$1"
    local path="$2"
    if [ ! -f "$path" ] || [ -L "$path" ]; then
        fail "$label must be a regular non-symlink file: $path"
    fi
}

[ -n "$OUT_DIR" ] || fail "WASM_POSIX_DEP_OUT_DIR is required"
[ -n "$WORK_DIR" ] || fail "WASM_POSIX_DEP_WORK_DIR is required"
[ -n "$ROOTFS_DIR" ] || fail "WASM_POSIX_DEP_ROOTFS_DIR is required"
[ -n "$BASH_DIR" ] || fail "WASM_POSIX_DEP_BASH_DIR is required"
[ -n "$FBDOOM_DIR" ] || fail "WASM_POSIX_DEP_FBDOOM_DIR is required"
[ -n "$MODESET_DIR" ] || fail "WASM_POSIX_DEP_MODESET_DIR is required"
[ "$TARGET_ARCH" = "wasm32" ] ||
    fail "source-rootfs shell composition supports only wasm32"
[ -n "$DECLARED_TOOL_PATH" ] ||
    fail "KANDELO_DEV_SHELL_TOOL_PATH is required; run through scripts/dev-shell.sh"

# WHY: the bridge has a closed local input graph. Scrub ambient module
# injection, credentials, and network configuration before the first Node
# process (including the dependency-contract reader), not only the composer.
unset GH_TOKEN GITHUB_TOKEN HOMEBREW_GITHUB_API_TOKEN \
    HOMEBREW_GITHUB_PACKAGES_TOKEN HOMEBREW_DOCKER_REGISTRY_TOKEN \
    NPM_TOKEN NODE_AUTH_TOKEN NODE_OPTIONS NODE_PATH \
    NPM_CONFIG_USERCONFIG NPM_CONFIG_GLOBALCONFIG NPM_CONFIG_REGISTRY \
    npm_config_userconfig npm_config_globalconfig npm_config_registry \
    ALL_PROXY HTTPS_PROXY HTTP_PROXY NO_PROXY \
    all_proxy https_proxy http_proxy no_proxy

require_regular_file "source-rootfs dependency contract" "$DEPENDENCY_CONTRACT"
require_regular_file \
    "source-rootfs dependency contract reader" "$DEPENDENCY_CONTRACT_READER"
NODE_BIN="$(PATH="$DECLARED_TOOL_PATH" type -P node || true)"
[ -n "$NODE_BIN" ] ||
    fail "node is not available from KANDELO_DEV_SHELL_TOOL_PATH"
dependency_lines="$(
    PATH="$DECLARED_TOOL_PATH" "$NODE_BIN" "$DEPENDENCY_CONTRACT_READER" \
        --print-resolver-owned "$DEPENDENCY_CONTRACT"
)" || fail "could not read the source-rootfs dependency contract"
EXTENDED_DEPENDENCIES=()
while IFS= read -r dependency; do
    [ -n "$dependency" ] || continue
    EXTENDED_DEPENDENCIES+=("$dependency")
done <<<"$dependency_lines"
[ "${#EXTENDED_DEPENDENCIES[@]}" -gt 0 ] ||
    fail "source-rootfs dependency contract has no resolver-owned dependencies"

require_real_directory WASM_POSIX_DEP_OUT_DIR "$OUT_DIR"
require_real_directory WASM_POSIX_DEP_WORK_DIR "$WORK_DIR"
require_real_directory WASM_POSIX_DEP_ROOTFS_DIR "$ROOTFS_DIR"
require_real_directory WASM_POSIX_DEP_BASH_DIR "$BASH_DIR"
require_real_directory WASM_POSIX_DEP_FBDOOM_DIR "$FBDOOM_DIR"
require_real_directory WASM_POSIX_DEP_MODESET_DIR "$MODESET_DIR"
for dependency in "${EXTENDED_DEPENDENCIES[@]}"; do
    dependency_key="$(printf '%s' "$dependency" | tr '[:lower:]-' '[:upper:]_')"
    env_key="WASM_POSIX_DEP_${dependency_key}_DIR"
    dependency_dir="${!env_key:-}"
    [ -n "$dependency_dir" ] || fail "$env_key is required"
    require_real_directory "$env_key" "$dependency_dir"
done

ROOTFS="$ROOTFS_DIR/rootfs.vfs"
BASH="$BASH_DIR/bash.wasm"
FBDOOM="$FBDOOM_DIR/fbdoom.wasm"
MODESET="$MODESET_DIR/modeset.wasm"
SHELL_CONFIG="$REPO_ROOT/homebrew/source-rootfs-shell-default.json"
DEMO_CONFIG="$REPO_ROOT/homebrew/main-shell-demo.json"
COMPOSER="$REPO_ROOT/images/vfs/scripts/build-source-rootfs-shell-image.ts"
TSX_CLI="$REPO_ROOT/node_modules/tsx/dist/cli.mjs"

require_regular_file "rootfs dependency output" "$ROOTFS"
require_regular_file "bash dependency output" "$BASH"
require_regular_file "fbdoom dependency output" "$FBDOOM"
require_regular_file "modeset dependency output" "$MODESET"
require_regular_file "source-rootfs shell config" "$SHELL_CONFIG"
require_regular_file "main-shell demo config" "$DEMO_CONFIG"
require_regular_file "source-rootfs shell composer" "$COMPOSER"
require_regular_file "locked tsx CLI" "$TSX_CLI"

export SOURCE_DATE_EPOCH=0
export TZ=UTC
export LC_ALL=C
export LANG=C

BUILD_DIR="$(mktemp -d "$WORK_DIR/source-rootfs-shell.XXXXXX")"
cleanup() {
    rm -rf -- "$BUILD_DIR"
}
trap cleanup EXIT

VFS="$BUILD_DIR/shell.vfs.zst"
PATH="$DECLARED_TOOL_PATH" "$NODE_BIN" "$TSX_CLI" "$COMPOSER" \
    --rootfs "$ROOTFS" \
    --bash "$BASH" \
    --fbdoom "$FBDOOM" \
    --modeset "$MODESET" \
    --shell-config "$SHELL_CONFIG" \
    --demo-config "$DEMO_CONFIG" \
    --out "$VFS"

require_regular_file "composed shell VFS" "$VFS"
if [ -e "$OUT_DIR/shell.vfs.zst" ] || [ -L "$OUT_DIR/shell.vfs.zst" ]; then
    fail "resolver output already exists: $OUT_DIR/shell.vfs.zst"
fi
cp "$VFS" "$OUT_DIR/shell.vfs.zst"
