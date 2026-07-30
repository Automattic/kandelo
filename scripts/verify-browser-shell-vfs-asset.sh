#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <browser-dist-root> <expected-shell-vfs>" >&2
  exit 2
fi

dist_root="${1%/}"
expected_image="$2"

[ -d "$dist_root/assets" ] || {
  echo "browser shell asset directory is missing: $dist_root/assets" >&2
  exit 1
}
[ -f "$expected_image" ] || {
  echo "expected shell VFS is missing: $expected_image" >&2
  exit 1
}

shopt -s nullglob
shell_assets=("$dist_root"/assets/shell.vfs-*.zst)
shopt -u nullglob

if [ "${#shell_assets[@]}" -ne 1 ]; then
  echo "expected exactly one hashed browser shell VFS; found " \
    "${#shell_assets[@]}" >&2
  exit 1
fi

browser_image="${shell_assets[0]}"
[ -f "$browser_image" ] && [ ! -L "$browser_image" ] || {
  echo "hashed browser shell VFS is not a regular file: $browser_image" >&2
  exit 1
}

# WHY: Vite content-addresses imported assets under dist/assets. The un-hashed
# dist/shell.vfs.zst is copied from public input and can be stale even though
# Chromium loads the hashed asset above.
cmp "$browser_image" "$expected_image" || {
  echo "hashed browser shell VFS differs from the expected image" >&2
  exit 1
}

printf '%s\n' "$browser_image"
