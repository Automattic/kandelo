#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

missing=0

require_file() {
    local path="$1"
    if [ -f "$path" ]; then
        echo "ci-browser-workspace: ok $path"
        return
    fi
    echo "ci-browser-workspace: missing $path" >&2
    missing=1
}

require_resolvable() {
    local rel="$1"
    local resolved
    if resolved="$("$REPO_ROOT/scripts/resolve-binary.sh" "$rel" 2>/dev/null)" && [ -f "$resolved" ]; then
        echo "ci-browser-workspace: ok $rel -> $resolved"
        return
    fi
    echo "ci-browser-workspace: missing resolvable $rel" >&2
    missing=1
}

require_file host/wasm/rootfs.vfs
require_resolvable kernel.wasm

for rel in \
    programs/wasm32/bash.wasm \
    programs/wasm32/bc.wasm \
    programs/wasm32/bzip2.wasm \
    programs/wasm32/coreutils.wasm \
    programs/wasm32/curl.wasm \
    programs/wasm32/dash.wasm \
    programs/wasm32/dinit/dinit.wasm \
    programs/wasm32/file/file.wasm \
    programs/wasm32/git/git-remote-http.wasm \
    programs/wasm32/git/git.wasm \
    programs/wasm32/grep.wasm \
    programs/wasm32/gzip.wasm \
    programs/wasm32/lamp.vfs.zst \
    programs/wasm32/less.wasm \
    programs/wasm32/lsof.wasm \
    programs/wasm32/m4.wasm \
    programs/wasm32/make.wasm \
    programs/wasm32/mariadb-test.vfs.zst \
    programs/wasm32/mariadb-vfs.vfs.zst \
    programs/wasm32/nano.wasm \
    programs/wasm32/nc.wasm \
    programs/wasm32/nginx-php-vfs.vfs.zst \
    programs/wasm32/nginx-vfs.vfs.zst \
    programs/wasm32/node-vfs.vfs.zst \
    programs/wasm32/node.wasm \
    programs/wasm32/sed.wasm \
    programs/wasm32/shell.vfs.zst \
    programs/wasm32/spidermonkey-node.wasm \
    programs/wasm32/tar.wasm \
    programs/wasm32/unzip.wasm \
    programs/wasm32/wget.wasm \
    programs/wasm32/wordpress.vfs.zst \
    programs/wasm32/xz.wasm \
    programs/wasm32/zip.wasm \
    programs/wasm32/zstd.wasm \
    programs/wasm64/mariadb-vfs.vfs.zst
do
    require_resolvable "$rel"
done

if [ "$missing" -ne 0 ]; then
    echo "ci-browser-workspace: prepared browser workspace is incomplete" >&2
    exit 1
fi

echo "ci-browser-workspace: prepared browser workspace looks complete"
