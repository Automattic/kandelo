#!/usr/bin/env bash
# Canonical package-system recipe for the browser shell. Every program and
# archive comes from a declared resolver dependency; this wrapper performs no
# package lookup, binary fallback, or network access.
#
# `--selection <file>` composes a PARTIAL shell instead: the rootfs base plus
# only the packages the file lists (`./run.sh partial`, see
# docs/package-management.md "Partial images"). The recipe then requires
# exactly the dependencies its selection names; the canonical shell (no
# selection) requires every dependency in its contract, as before.
set -euo pipefail

SELECTION_FILE=""
if [ "$#" -gt 0 ]; then
    [ "$#" -eq 2 ] && [ "$1" = "--selection" ] ||
        { echo "build-shell: usage: build-shell.sh [--selection <selection.json>]" >&2; exit 2; }
    SELECTION_FILE="$2"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

OUT_DIR="${WASM_POSIX_DEP_OUT_DIR:-}"
WORK_DIR="${WASM_POSIX_DEP_WORK_DIR:-}"
ROOTFS_DIR="${WASM_POSIX_DEP_ROOTFS_DIR:-}"
BASH_DIR="${WASM_POSIX_DEP_BASH_DIR:-}"
WAYLAND_DEMO_DIR="${WASM_POSIX_DEP_WAYLAND_DEMO_DIR:-}"
ESPEAK_NG_DIR="${WASM_POSIX_DEP_ESPEAK_NG_DIR:-}"
TARGET_ARCH="${WASM_POSIX_DEP_TARGET_ARCH:-}"
DECLARED_TOOL_PATH="${KANDELO_DEV_SHELL_TOOL_PATH:-}"
DEPENDENCY_CONTRACT="$SCRIPT_DIR/source-rootfs-shell-dependencies.json"
DEPENDENCY_CONTRACT_READER="$SCRIPT_DIR/source-rootfs-shell-dependency-contract.mjs"
PACKAGE_MANIFEST="$SCRIPT_DIR/package.toml"

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
[ "$TARGET_ARCH" = "wasm32" ] ||
    fail "source-rootfs shell composition supports only wasm32"
[ -n "$DECLARED_TOOL_PATH" ] ||
    fail "KANDELO_DEV_SHELL_TOOL_PATH is required; run through scripts/dev-shell.sh"

# WHY: resolver inputs are the whole executable authority. Ambient credentials,
# proxies, and module/package-manager injection could otherwise add an
# undeclared source or network path before the composer starts.
unset GH_TOKEN GITHUB_TOKEN \
    NPM_TOKEN NODE_AUTH_TOKEN NODE_OPTIONS NODE_PATH \
    NPM_CONFIG_USERCONFIG NPM_CONFIG_GLOBALCONFIG NPM_CONFIG_REGISTRY \
    npm_config_userconfig npm_config_globalconfig npm_config_registry \
    ALL_PROXY HTTPS_PROXY HTTP_PROXY NO_PROXY \
    all_proxy https_proxy http_proxy no_proxy

require_regular_file "source-rootfs dependency contract" "$DEPENDENCY_CONTRACT"
require_regular_file \
    "source-rootfs dependency contract reader" "$DEPENDENCY_CONTRACT_READER"
require_regular_file "source-rootfs package manifest" "$PACKAGE_MANIFEST"
NODE_BIN="$(PATH="$DECLARED_TOOL_PATH" type -P node || true)"
[ -n "$NODE_BIN" ] || fail "node is not available from KANDELO_DEV_SHELL_TOOL_PATH"
dependency_lines="$(
    PATH="$DECLARED_TOOL_PATH" "$NODE_BIN" "$DEPENDENCY_CONTRACT_READER" \
        --print-resolver-owned "$DEPENDENCY_CONTRACT" "$PACKAGE_MANIFEST"
)" || fail "could not read the source-rootfs dependency contract"
EXTENDED_DEPENDENCIES=()
while IFS= read -r dependency; do
    [ -n "$dependency" ] || continue
    EXTENDED_DEPENDENCIES+=("$dependency")
done <<<"$dependency_lines"
[ "${#EXTENDED_DEPENDENCIES[@]}" -gt 0 ] ||
    fail "source-rootfs dependency contract has no resolver-owned dependencies"

# selected NAME: whether this shell carries package NAME.
SELECTED_PACKAGES=""
if [ -n "$SELECTION_FILE" ]; then
    require_regular_file "partial shell selection" "$SELECTION_FILE"
    SELECTED_PACKAGES="$(
        PATH="$DECLARED_TOOL_PATH" "$NODE_BIN" -e '
            const value = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
            if (value.schema !== 1 || !Array.isArray(value.packages)) process.exit(2);
            for (const name of value.packages) {
                if (typeof name !== "string" || !/^[a-z0-9][a-z0-9._-]*$/.test(name)) process.exit(2);
                console.log(name);
            }' "$SELECTION_FILE"
    )" || fail "invalid partial shell selection: $SELECTION_FILE"
fi
selected() {
    [ -z "$SELECTION_FILE" ] && return 0
    printf '%s\n' "$SELECTED_PACKAGES" | grep -qx -- "$1"
}

require_real_directory WASM_POSIX_DEP_OUT_DIR "$OUT_DIR"
require_real_directory WASM_POSIX_DEP_WORK_DIR "$WORK_DIR"
require_real_directory WASM_POSIX_DEP_ROOTFS_DIR "$ROOTFS_DIR"
require_real_directory WASM_POSIX_DEP_BASH_DIR "$BASH_DIR"
for dependency in "${EXTENDED_DEPENDENCIES[@]}"; do
    selected "$dependency" || continue
    dependency_key="$(printf '%s' "$dependency" | tr '[:lower:]-' '[:upper:]_')"
    env_key="WASM_POSIX_DEP_${dependency_key}_DIR"
    dependency_dir="${!env_key:-}"
    [ -n "$dependency_dir" ] || fail "$env_key is required"
    require_real_directory "$env_key" "$dependency_dir"
done

ROOTFS="$ROOTFS_DIR/rootfs.vfs.zst"
CA_BUNDLE="$WASM_POSIX_DEP_CA_CERTIFICATES_DIR/ca-certificates.zip"
require_regular_file "CA bundle dependency output" "$CA_BUNDLE"
BASH="$BASH_DIR/bash.wasm"
# Thread eager programs/scripts and package data archives to the composer.
# Other programs (fbdoom, modeset, sdl2, espeak-ng, the desktops' programs)
# are lazy files it resolves from the dependency's declared directory.
#
# Inputs only the packages that own them bring: the Wayland desktops'
# launchers (a package runtime_file is NOT installed into the shell image by
# the composer, so it has to be threaded explicitly), their data, libinput's
# device quirks (unpacked at /usr/share/libinput), xkeyboard-config rules
# (unpacked at /usr/share/X11/xkb), and the speech data.
SELECTED_INPUTS=()
if selected wayland-demo; then
    [ -n "$WAYLAND_DEMO_DIR" ] || fail "WASM_POSIX_DEP_WAYLAND_DEMO_DIR is required"
    require_real_directory WASM_POSIX_DEP_WAYLAND_DEMO_DIR "$WAYLAND_DEMO_DIR"
    for input in wldesktop:wldesktop omarchydesktop:omarchydesktop \
        desktop-data:kandelo-desktop-data.zip libinput-quirks:libinput-quirks.zip \
        xkeyboard-config:xkeyboard-config.zip; do
        require_regular_file "${input%%:*} dependency output" "$WAYLAND_DEMO_DIR/${input#*:}"
        SELECTED_INPUTS+=("--${input%%:*}" "$WAYLAND_DEMO_DIR/${input#*:}")
    done
fi
if selected espeak-ng; then
    [ -n "$ESPEAK_NG_DIR" ] || fail "WASM_POSIX_DEP_ESPEAK_NG_DIR is required"
    require_real_directory WASM_POSIX_DEP_ESPEAK_NG_DIR "$ESPEAK_NG_DIR"
    require_regular_file "espeak-ng data dependency output" "$ESPEAK_NG_DIR/espeak-ng-data.zip"
    SELECTED_INPUTS+=(--espeak-ng-data "$ESPEAK_NG_DIR/espeak-ng-data.zip")
fi
if [ -n "$SELECTION_FILE" ]; then
    SELECTED_INPUTS+=(--selection "$SELECTION_FILE")
fi
DEMO_CONFIG="$SCRIPT_DIR/source-rootfs-shell-demo.json"
DEMO_PROFILE_OVERLAY="$SCRIPT_DIR/source-rootfs-shell-demo-profiles.json"
COMPOSER="$REPO_ROOT/images/vfs/scripts/build-source-rootfs-shell-image.ts"
TSX_CLI="$REPO_ROOT/node_modules/tsx/dist/cli.mjs"

require_regular_file "rootfs dependency output" "$ROOTFS"
require_regular_file "bash dependency output" "$BASH"
require_regular_file "main-shell demo config" "$DEMO_CONFIG"
require_regular_file "source-rootfs demo profile overlay" "$DEMO_PROFILE_OVERLAY"
require_regular_file "source-rootfs shell composer" "$COMPOSER"
require_regular_file "locked tsx CLI" "$TSX_CLI"

export SOURCE_DATE_EPOCH=0
export TZ=UTC
export LC_ALL=C
export LANG=C

BUILD_DIR="$(mktemp -d "$WORK_DIR/shell.XXXXXX")"
TSX_TMP="$(mktemp -d /tmp/kandelo-shell.XXXXXX)"
cleanup() {
    rm -rf -- "$BUILD_DIR" "$TSX_TMP"
}
trap cleanup EXIT

VFS="$BUILD_DIR/shell.vfs.zst"
TMPDIR="$TSX_TMP" PATH="$DECLARED_TOOL_PATH" \
    "$NODE_BIN" "$TSX_CLI" "$COMPOSER" \
    --rootfs "$ROOTFS" \
    --ca-bundle "$CA_BUNDLE" \
    --bash "$BASH" \
    ${SELECTED_INPUTS[@]+"${SELECTED_INPUTS[@]}"} \
    --demo-config "$DEMO_CONFIG" \
    --demo-profile-overlay "$DEMO_PROFILE_OVERLAY" \
    --dependency-contract "$DEPENDENCY_CONTRACT" \
    --out "$VFS"

require_regular_file "composed shell VFS" "$VFS"
if [ -e "$OUT_DIR/shell.vfs.zst" ] || [ -L "$OUT_DIR/shell.vfs.zst" ]; then
    fail "resolver output already exists: $OUT_DIR/shell.vfs.zst"
fi
cp "$VFS" "$OUT_DIR/shell.vfs.zst"
