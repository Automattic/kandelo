#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
    echo "usage: $0 ZIG_0_17_1_SOURCE_DIR OUT_DIR" >&2
    exit 2
fi

repo="$(cd "$(dirname "$0")/../.." && pwd)"
upstream="$(cd "$1" && pwd)"
mkdir -p "$2"
out="$(cd "$2" && pwd)"
source "$repo/sdk/activate.sh"

source_dir="$(mktemp -d "$out/zig-source.XXXXXX")"
trap 'rm -rf "$source_dir"' EXIT
cp -R "$upstream/." "$source_dir/"
chmod -R u+w "$source_dir"
for patch_file in "$repo"/sdk/zig/*.patch "$repo"/sdk/zig/guest/*.patch; do
    patch -s -d "$source_dir" -p1 < "$patch_file"
done

cd "$source_dir"
zig build -Dtarget=wasm32-kandelo-musl -Doptimize=ReleaseSmall \
    -Denable-llvm=false -Dstrip=true -Dversion-string=0.17.1 \
    --prefix "$out"
mv "$out/bin/zig.wasm" "$out/bin/zig.raw.wasm"
"$repo/scripts/run-wasm-fork-instrument.sh" "$out/bin/zig.raw.wasm" -o "$out/bin/zig"
rm "$out/bin/zig.raw.wasm"
