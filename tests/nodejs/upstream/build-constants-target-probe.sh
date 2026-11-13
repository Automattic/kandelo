#!/usr/bin/env bash
set -euo pipefail
source sdk/activate.sh
out="$(mktemp -d "$PWD/.scratch/node-constants-target.XXXXXX")"
printf '%s\n' "$out" > .context/node-constants/target-work-dir.txt
host_target="$(rustc -vV | sed -n 's/^host: //p')"
flags=()
for name in openssl zlib libzstd libuv; do
  prefix="$(cargo run -q -p xtask --target "$host_target" -- build-deps resolve "$name" --arch wasm32 --binaries-dir "$PWD/binaries")"
  printf '%s\n' "$prefix" > "$out/$name-prefix.txt"
  flags+=("-I$prefix/include")
done
wasm32posix-cc -D_GNU_SOURCE -DUV_PLATFORM_KANDELO=1 "${flags[@]}" tests/nodejs/upstream/constants-target-probe.c -o "$out/constants-target-probe.raw.wasm"
scripts/run-wasm-fork-instrument.sh "$out/constants-target-probe.raw.wasm" --keep-names -o "$out/constants-target-probe.wasm"
printf '%s\n' "$out/constants-target-probe.wasm"
