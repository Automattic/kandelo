#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd)"
source_dir="$repo_root/tests/go/cgo/c-exports"
output_dir="$repo_root/.context/go-c-exports"
fixture_dir="$output_dir/fixture"
mkdir -p "$fixture_dir/lib"
cp "$source_dir/main.go" "$fixture_dir/main.go"

wasm32posix-cc -O2 -fPIC -c "$source_dir/testdata/used.c" -o "$output_dir/used.o"
wasm32posix-cc -O2 -fPIC -c "$source_dir/testdata/exports.c" -o "$output_dir/exports.o"
wasm32posix-ar rcs "$fixture_dir/lib/libprobe.a" "$output_dir/used.o" "$output_dir/exports.o"
wasm32posix-cc -shared -fPIC -I "$repo_root/libc/glue" \
    -o "$output_dir/libprobe.so" "$source_dir/testdata/side.c"
wasm-validate --enable-threads "$output_dir/libprobe.so"
"$repo_root/scripts/run-wasm-fork-instrument.sh" "$output_dir/libprobe.so" \
    -o "$output_dir/libprobe-instrumented.so" --entry env.fork
mv "$output_dir/libprobe-instrumented.so" "$output_dir/libprobe.so"

requested_export_list="$(node "$repo_root/scripts/wasm-side-module-c-exports.mjs" \
    "$output_dir/libprobe.so")"
mapfile -t requested_exports <<< "$requested_export_list"
if [ "${requested_exports[*]}" != "export_only_data export_only_function" ]; then
    printf 'unexpected side-module C imports: %s\n' "${requested_exports[*]}" >&2
    exit 1
fi
export_flags=()
for symbol in "${requested_exports[@]}"; do
    export_flags+=("-Wl,--export-dynamic-symbol=$symbol")
done
link_flags="-extldflags '${export_flags[*]}'"
GO111MODULE=off CGO_ENABLED=1 GOOS=kandelo GOARCH=wasm CC=wasm32posix-cc \
    "$repo_root/../go-kandelo/bin/go" build -a -ldflags="$link_flags" \
    -o "$output_dir/probe.wasm" "$fixture_dir/main.go"
wasm-validate --enable-threads "$output_dir/probe.wasm"
node -e '
const { readFileSync } = require("node:fs");
const exports = WebAssembly.Module.exports(new WebAssembly.Module(readFileSync(process.argv[1])));
for (const [name, kind] of [["export_only_function", "function"], ["export_only_data", "global"]]) {
  if (!exports.some((entry) => entry.name === name && entry.kind === kind)) {
    throw new Error(`missing ${kind} export ${name}`);
  }
}
' "$output_dir/probe.wasm"
if GO111MODULE=off CGO_ENABLED=1 GOOS=kandelo GOARCH=wasm CC=wasm32posix-cc \
    "$repo_root/../go-kandelo/bin/go" build -a \
    -ldflags="-extldflags=-Wl,--export-dynamic-symbol=missing_symbol" \
    -o "$output_dir/missing.wasm" "$fixture_dir/main.go" \
    > "$output_dir/missing.log" 2>&1; then
    echo "missing C export unexpectedly linked" >&2
    exit 1
fi
rg -q 'requested C export missing_symbol is not linked' "$output_dir/missing.log"
"$repo_root/scripts/run-wasm-fork-instrument.sh" "$output_dir/probe.wasm" \
    -o "$output_dir/probe-instrumented.wasm"
REPO_ROOT="$repo_root" bash -c '
    source "$REPO_ROOT/scripts/build-programs-abi-stamp.sh"
    record_built_program_output "$REPO_ROOT/.context/go-c-exports/probe-instrumented.wasm"
    stamp_built_program_outputs
'
