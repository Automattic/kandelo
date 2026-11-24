#!/usr/bin/env bash
set -euo pipefail

if [ "$#" != 2 ]; then
    echo "usage: $0 ZIG_0_17_1_SOURCE_DIR OUT_DIR" >&2
    exit 2
fi

repo="$(cd "$(dirname "$0")/../.." && pwd)"
upstream="$(cd "$1" && pwd)"
mkdir -p "$2"
out="$(cd "$2" && pwd)"
cd "$repo"
source "$repo/sdk/activate.sh"

# Zig's installed lib replaces test-only sources with stubs. Apply the same
# patches to the release source to compile the complete test bodies.
source_dir="$(mktemp -d "$out/zig-source.XXXXXX")"
trap 'rm -rf "$source_dir"' EXIT
cp -R "$upstream/." "$source_dir/"
chmod -R u+w "$source_dir"
for patch_file in "$repo"/sdk/zig/*.patch "$repo"/sdk/zig/tests/*.patch; do
    patch -s -d "$source_dir" -p1 < "$patch_file"
done
export ZIG_LIB_DIR="$source_dir/lib"
std_dir="$ZIG_LIB_DIR/std"
spawn_source="$source_dir/test/standalone/child_process"
test -f "$spawn_source/main.zig"
test -f "$spawn_source/child.zig"

target=(-target wasm32-kandelo-musl -O ReleaseSafe)
build_test() {
    local group="$1"
    shift
    zig test "$std_dir/std.zig" "${target[@]}" --test-no-exec "$@" \
        -femit-bin="$out/$group.raw.wasm"
    "$repo/scripts/run-wasm-fork-instrument.sh" "$out/$group.raw.wasm" -o "$out/$group.wasm"
}

build_test fs --test-filter fs.
build_test thread --test-filter Thread.test. --test-filter Thread.decltest.
build_test process --test-filter process.
build_test threaded-io --test-filter Io.Threaded.
build_test posix --test-filter posix.

zig build-exe "$repo/sdk/zig/smoke.zig" "${target[@]}" -femit-bin="$out/smoke.raw.wasm"
"$repo/scripts/run-wasm-fork-instrument.sh" "$out/smoke.raw.wasm" -o "$out/smoke.wasm"
zig build-exe "$spawn_source/main.zig" "${target[@]}" -femit-bin="$out/spawn.raw.wasm"
"$repo/scripts/run-wasm-fork-instrument.sh" "$out/spawn.raw.wasm" -o "$out/spawn.wasm"
zig build-exe "$spawn_source/child.zig" "${target[@]}" -femit-bin="$out/child.raw.wasm"
"$repo/scripts/run-wasm-fork-instrument.sh" "$out/child.raw.wasm" -o "$out/child.wasm"
