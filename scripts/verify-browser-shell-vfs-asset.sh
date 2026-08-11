#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  echo "usage: $0 <browser-dist-root> <expected-vfs> [asset-stem]" >&2
  exit 2
fi

dist_root="${1%/}"
expected_image="$2"
asset_stem="${3:-shell.vfs}"

[[ "$asset_stem" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || {
  echo "browser VFS asset stem is invalid: $asset_stem" >&2
  exit 2
}

[ -d "$dist_root/assets" ] || {
  echo "browser shell asset directory is missing: $dist_root/assets" >&2
  exit 1
}
[ -f "$expected_image" ] && [ ! -L "$expected_image" ] || {
  echo "expected VFS is not a regular file: $expected_image" >&2
  exit 1
}

shopt -s nullglob
shell_assets=("$dist_root/assets/$asset_stem"-*.zst)
shopt -u nullglob

if [ "${#shell_assets[@]}" -ne 1 ]; then
  echo "expected exactly one hashed browser $asset_stem VFS; found " \
    "${#shell_assets[@]}" >&2
  exit 1
fi

browser_image="${shell_assets[0]}"
[ -f "$browser_image" ] && [ ! -L "$browser_image" ] || {
  echo "hashed browser $asset_stem VFS is not a regular file: $browser_image" >&2
  exit 1
}

# WHY: Vite content-addresses imported package images under dist/assets. An
# un-hashed public copy can be stale even though Chromium loads the hashed
# asset above.
cmp "$browser_image" "$expected_image" || {
  echo "hashed browser $asset_stem VFS differs from the expected image" >&2
  exit 1
}

printf '%s\n' "$browser_image"
