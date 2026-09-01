#!/usr/bin/env bash
# Build the fork-module as a POSITION-INDEPENDENT (PIC / `--pie`) wasm SIDE
# MODULE, so the HOST can place its data / BSS heap / shadow stack into a
# host-chosen region of the shared linear memory via the imported
# `__memory_base` / `__stack_pointer` / `__table_base` globals — instead of the
# fixed low offsets a plain cdylib would use, which would corrupt live guest
# memory (the Phase 6 D5 gating fix; see `src/lib.rs` and the README).
#
# Why RUSTFLAGS here (not the repo `.cargo/config.toml`): a `RUSTFLAGS` env value
# REPLACES the entire `target.<triple>.rustflags` array from config (documented
# in the repo `.cargo/config.toml`), giving this crate its own PIC flag set
# without editing the repo-wide, non-PIC kernel/guest build config. This keeps
# the change additive and scoped to `crates/fork-module`.
#
# Usage:
#   scripts/dev-shell.sh bash crates/fork-module/build-wasm.sh          # wasm32
#   scripts/dev-shell.sh bash crates/fork-module/build-wasm.sh --run    # + harness
#
# Artifact: target/wasm32-unknown-unknown/release/fork_module.wasm
set -euo pipefail

# The PIC side-module flags. Release is required (the whole-memory byte view is
# based at wasm address 0, valid in wasm's flat memory but tripping the
# debug-only non-null slice precondition).
#
#  * relocation-model=pic + --experimental-pic + --pie:
#        emit a relocatable side module (`dylink.0`) that imports
#        __memory_base / __stack_pointer / __table_base and places its data /
#        BSS / stack relative to them.
#  * --import-memory + --shared-memory + --max-memory:
#        import the guest's single shared linear memory (the frame data plane).
#  * +atomics,+bulk-memory,+mutable-globals: shared-memory + passive-segment
#        data init (memory.init) + the mutable __stack_pointer global.
#  * panic=immediate-abort: no unwinder, minimal panic surface.
PIC_RUSTFLAGS=(
  -C relocation-model=pic
  -C target-feature=+atomics,+bulk-memory,+mutable-globals
  -Zunstable-options
  -C panic=immediate-abort
  -C link-arg=--experimental-pic
  -C link-arg=--pie
  -C link-arg=--import-memory
  -C link-arg=--shared-memory
  -C link-arg=--max-memory=1073741824
)

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

echo "== building fork-module (PIC side module, wasm32) =="
RUSTFLAGS="${PIC_RUSTFLAGS[*]}" \
  cargo build --release -p fork-module --target wasm32-unknown-unknown -Z build-std=core,alloc

WASM32="target/wasm32-unknown-unknown/release/fork_module.wasm"
echo "wasm32 artifact: $WASM32"

# The wasm64 (`pointer_width = 8` guest) variant. wasm64-unknown-unknown is a
# tier-3 target built entirely from source via build-std. Best-effort: a wasm64
# guest is not yet exercised by the harness, so a failure here is non-fatal.
echo "== building fork-module (PIC side module, wasm64, best-effort) =="
if RUSTFLAGS="${PIC_RUSTFLAGS[*]}" \
    cargo build --release -p fork-module --target wasm64-unknown-unknown -Z build-std=core,alloc; then
  echo "wasm64 artifact: target/wasm64-unknown-unknown/release/fork_module.wasm"
else
  echo "wasm64 build unavailable on this toolchain (wasm32 is sufficient for this slice)"
fi

if [[ "${1:-}" == "--run" ]]; then
  echo "== running co-residency harness (wasm32) =="
  node crates/fork-module/tests/harness.mjs "$WASM32"
fi
