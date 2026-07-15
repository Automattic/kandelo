#!/usr/bin/env bash
#
# Build the resolver-owned vim-browser-bundle output.
#
# Packages vim.wasm plus the minimal runtime tree (syntax/ftplugin/etc.) into
# a single archive. The demo registers this as a lazy archive with mount
# prefix /usr/, so entries become /usr/bin/vim and /usr/share/vim/vim91/...
# On first exec of vim, the whole archive is fetched and unpacked in one go.
#
# A package build consumes WASM_POSIX_DEP_VIM_DIR, which is guaranteed by the
# vim-browser-bundle manifest and included in its transitive cache identity.
# A direct script invocation explicitly resolves Vim through the same graph.
# Resolver failures and incomplete package outputs are never hidden.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    OUTPUT_DIR="$WASM_POSIX_DEP_OUT_DIR"
else
    OUTPUT_DIR="$REPO_ROOT/apps/browser-demos/public"
fi
OUTPUT_FILE="$OUTPUT_DIR/vim.zip"

# Package builds must consume the direct dependency chosen by the resolver.
# Standalone invocations enter the same graph explicitly.
VIM_DIR="${WASM_POSIX_DEP_VIM_DIR:-}"
if [ -z "$VIM_DIR" ]; then
    if [ -n "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
        echo "ERROR: vim-browser-bundle declares vim as a direct dependency, but the resolver did not set WASM_POSIX_DEP_VIM_DIR" >&2
        exit 1
    fi
    HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
    VIM_DIR="$(cd "$REPO_ROOT" && cargo run -p xtask --target "$HOST_TARGET" --quiet -- \
        build-deps resolve vim --arch wasm32)"
fi

VIM_WASM=""
RUNTIME_DIR=""
if [ -n "$VIM_DIR" ] && [ -f "$VIM_DIR/vim.wasm" ] && [ -d "$VIM_DIR/runtime" ]; then
    VIM_WASM="$VIM_DIR/vim.wasm"
    RUNTIME_DIR="$VIM_DIR/runtime"
else
    echo "ERROR: resolved Vim package is incomplete: ${VIM_DIR:-<empty>}" >&2
    echo "  expected: vim.wasm + runtime/" >&2
    echo "  for an explicit development build, set WASM_POSIX_DEP_VIM_DIR to a complete package output" >&2
    exit 1
fi

mkdir -p "$OUTPUT_DIR"
rm -f "$OUTPUT_FILE"

STAGING=$(mktemp -d)
trap 'rm -rf "$STAGING"' EXIT

echo "==> Staging vim.zip..."
echo "    binary:  $VIM_WASM"
echo "    runtime: $RUNTIME_DIR"

# Binary — stored at bin/vim (no .wasm extension, matching the VFS layout)
mkdir -p "$STAGING/bin"
cp "$VIM_WASM" "$STAGING/bin/vim"
chmod 755 "$STAGING/bin/vim"

# Runtime files — staged under share/vim/vim91/
mkdir -p "$STAGING/share/vim/vim91"
cp -R "$RUNTIME_DIR/." "$STAGING/share/vim/vim91/"

# The bundle bytes are part of the package cache/provenance contract. Normalize
# filesystem metadata and traversal order so identical Vim inputs produce the
# same zip on every host and at every build time.
find "$STAGING" -type d -exec chmod 755 {} +
while IFS= read -r -d '' staged_file; do
    if [ -x "$staged_file" ]; then
        chmod 755 "$staged_file"
    else
        chmod 644 "$staged_file"
    fi
done < <(find "$STAGING" -type f -print0)
find "$STAGING" -exec touch -h -t 198001010000 {} +

(
    cd "$STAGING"
    LC_ALL=C find . -mindepth 1 -print \
        | LC_ALL=C sort \
        | zip -X -q "$OUTPUT_FILE" -@
)

echo "    $(find "$STAGING" -type f | wc -l | tr -d ' ') files"
ls -lh "$OUTPUT_FILE"

# Resolver builds already wrote the declared output directly into their
# scratch directory. A standalone invocation also exposes the same package
# artifact through the local binary resolver.
if [ -z "${WASM_POSIX_DEP_OUT_DIR:-}" ]; then
    source "$REPO_ROOT/scripts/install-local-binary.sh"
    install_local_binary vim-browser-bundle "$OUTPUT_FILE"
fi
