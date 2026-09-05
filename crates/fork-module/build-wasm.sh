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

# Build the host-only post-build injector (Phase 6 D6.1). Rust cannot emit the
# `__wpk_fork_ref_decode_funcref` export (a function that RETURNS a funcref by
# reading an imported funcref table), so this tool injects that one static wasm
# function — wired to the module's Rust `fm_funcref_ordinal` helper and a new
# `env.__wpk_fork_function_catalog` funcref-table import — into the compiled
# module before staging. See crates/fork-module-inject.
echo "== building fork-module injector (host) =="
# The repo `.cargo/config.toml` defaults `build.target` to wasm32; the injector
# is a HOST tool (it needs std + walrus), so build it for the host triple.
HOST_TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
cargo build --release -p fork-module-inject --target "$HOST_TRIPLE"
INJECTOR="target/$HOST_TRIPLE/release/fork-module-inject"

# Inject the funcref decode export into a wasm artifact IN PLACE (produces a
# temp, then replaces the artifact so the existing staging path is unchanged).
inject_funcref_decode() {
  local wasm="$1"
  local injected="${wasm%.wasm}.injected.wasm"
  "$INJECTOR" "$wasm" "$injected"
  mv "$injected" "$wasm"
}
inject_funcref_decode "$WASM32"

# Stage the artifacts where BOTH hosts load them, mirroring how the kernel
# stages `kernel.wasm`:
#
#   * Node resolves `resolveBinary("fork_module32.wasm")`, which searches the
#     `local-binaries/` (source-generation) tier and the installed-package
#     `host/wasm/` tier. Stage into both so a source checkout AND the published
#     npm package resolve the module.
#   * The browser's Vite `@fork-module32-wasm?url` alias resolves the same
#     `local-binaries/`/`host/wasm/` copies.
#
# The per-width filename (`fork_module32.wasm` / `fork_module64.wasm`) lets the
# kernel host ship the width matching the guest's pointer width.
stage_fork_module() {
  local src="$1" width="$2"
  local name="fork_module${width}.wasm"
  mkdir -p "$REPO_ROOT/local-binaries" "$REPO_ROOT/host/wasm"
  cp "$src" "$REPO_ROOT/local-binaries/$name"
  cp "$src" "$REPO_ROOT/host/wasm/$name"
  echo "staged $name -> local-binaries/$name, host/wasm/$name"
}
stage_fork_module "$WASM32" 32

# The wasm64 (`pointer_width = 8` guest) variant. wasm64-unknown-unknown is a
# tier-3 target built entirely from source via build-std. Best-effort: a wasm64
# guest is not yet exercised by the harness, so a failure here is non-fatal.
echo "== building fork-module (PIC side module, wasm64, best-effort) =="
if RUSTFLAGS="${PIC_RUSTFLAGS[*]}" \
    cargo build --release -p fork-module --target wasm64-unknown-unknown -Z build-std=core,alloc; then
  WASM64="target/wasm64-unknown-unknown/release/fork_module.wasm"
  echo "wasm64 artifact: $WASM64"
  inject_funcref_decode "$WASM64"
  stage_fork_module "$WASM64" 64
else
  echo "wasm64 build unavailable on this toolchain (wasm32 is sufficient for this slice)"
fi

if [[ "${1:-}" == "--run" ]]; then
  echo "== running co-residency harness (wasm32) =="
  node crates/fork-module/tests/harness.mjs "$WASM32"
  echo "== running multi-activation frame-routing harness (wasm32) =="
  node crates/fork-module/tests/harness-multi-activation.mjs "$WASM32"
fi
