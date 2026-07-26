#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

source_image="${1:-}"
if [ -z "$source_image" ] || [ "$#" -ne 1 ]; then
    echo "usage: $0 <shell.vfs.zst>" >&2
    exit 2
fi
if [ ! -f "$source_image" ] || [ -L "$source_image" ]; then
    echo "activate-local-shell-build-override: source image must be a regular non-symlink file: $source_image" >&2
    exit 1
fi

resolved="$(bash scripts/resolve-binary.sh programs/shell.vfs.zst)" || {
    echo "activate-local-shell-build-override: installed shell does not resolve" >&2
    exit 1
}
if [ ! -f "$resolved" ] || [ -L "$resolved" ] ||
    ! cmp -s "$source_image" "$resolved"; then
    echo "activate-local-shell-build-override: installed shell is not the selected source image" >&2
    exit 1
fi

local_libs="$REPO_ROOT/local-libs"
shell_dir="$local_libs/shell"
override_path="$shell_dir/build"
override_target="$(dirname "$resolved")"

exact_override_is_active() {
    [ -d "$local_libs" ] && [ ! -L "$local_libs" ] &&
        [ -d "$shell_dir" ] && [ ! -L "$shell_dir" ] &&
        [ -L "$override_path" ] &&
        [ "$(readlink "$override_path")" = "$override_target" ] &&
        [ -f "$override_path/shell.vfs.zst" ] &&
        ! [ -L "$override_path/shell.vfs.zst" ] &&
        cmp -s "$source_image" "$override_path/shell.vfs.zst" || return 1
    actual_entries="$(find "$local_libs" -mindepth 1 -print | sort)"
    expected_entries="$(printf '%s\n%s\n' "$shell_dir" "$override_path" | sort)"
    [ "$actual_entries" = "$expected_entries" ]
}

if [ -e "$local_libs" ] || [ -L "$local_libs" ]; then
    if exact_override_is_active; then
        echo "activate-local-shell-build-override: exact override is already active"
        exit 0
    fi
    echo "activate-local-shell-build-override: refusing to replace existing local-libs" >&2
    exit 1
fi

mkdir "$local_libs"
mkdir "$shell_dir"
# WHY: build-deps resolves transitive dependencies from local-libs before its
# cache or remote index; local-binaries is only an output mirror. Point the
# supported shell override at the exact installed generation so derived VFS
# packages cannot rediscover or build the publication-pending canonical shell.
ln -s "$override_target" "$override_path"
if ! exact_override_is_active; then
    echo "activate-local-shell-build-override: override verification failed" >&2
    exit 1
fi
