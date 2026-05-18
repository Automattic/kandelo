#!/usr/bin/env bash
# Regenerates fuzz/corpus/fuzz_try_table/ from a curated list of WAT
# fixtures compiled to raw wasm bytes. Safe to re-run.
#
# Superseded once the fuzz target switches to a typed Arbitrary input
# schema; kept for pre-typed smoke testing of the oracle.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/corpus/fuzz_try_table"

if ! command -v wat2wasm >/dev/null 2>&1; then
    echo "error: wat2wasm not found. Install wabt (e.g. 'brew install wabt')." >&2
    exit 1
fi

rm -rf "$OUT"
mkdir -p "$OUT"

# wat2wasm defaults reject try_table + catch_ref + exnref. Enable exceptions
# for all invocations so the seeds compile. wabt 1.0.39 uses the legacy
# `exnref` keyword rather than `(ref null exn)`.
WAT_FLAGS=(--enable-exceptions)

# Seed 1: minimal fork import (Phase 1 fixture).
wat2wasm "${WAT_FLAGS[@]}" /dev/stdin -o "$OUT/seed_trivial.wasm" <<'EOF'
(module
  (import "kernel" "kernel_fork" (func $fork (result i32)))
  (func $main (export "_start") (result i32) call $fork)
  (memory 1))
EOF

# Seed 2: fork inside try_table body with catch_ref (Phase 6 fixture).
wat2wasm "${WAT_FLAGS[@]}" /dev/stdin -o "$OUT/seed_try_catch_ref.wasm" <<'EOF'
(module
  (import "kernel" "kernel_fork" (func $fork (result i32)))
  (tag $exn)
  (func $caller (export "caller") (result i32)
    (block $handler (result exnref)
      (try_table (result exnref) (catch_ref $exn $handler)
        call $fork drop ref.null exn))
    drop i32.const 0)
  (memory 1))
EOF

echo "Seeded $(ls "$OUT" | wc -l | tr -d ' ') corpus entries in $OUT"
