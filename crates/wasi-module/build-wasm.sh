#!/usr/bin/env bash
#
# Build and stage the co-resident WASI side module.
#
# Mirrors `crates/fork-module/build-wasm.sh`, which is the established recipe
# for a PIC wasm side module in this repository. The differences are that this
# module needs no post-build injector (Rust can emit every export it needs) and
# that it is wasm32-only for now -- WASI Preview 1 is a wasm32 ABI.
#
# Usage:
#   scripts/dev-shell.sh bash crates/wasi-module/build-wasm.sh
#   scripts/dev-shell.sh bash crates/wasi-module/build-wasm.sh --verify-fresh
#
# Artifact: target/wasm32-unknown-unknown/release/wasi_module.wasm
# Staged as: local-binaries/wasi_module32.wasm and host/wasm/wasi_module32.wasm

set -euo pipefail

# Why RUSTFLAGS here rather than the repo `.cargo/config.toml`: a RUSTFLAGS env
# value REPLACES the entire `target.<triple>.rustflags` array from config, so
# setting it here keeps this module's PIC flags from leaking into every other
# wasm32 build in the workspace.
#
#  * relocation-model=pic + --experimental-pic + --pie:
#        emit a relocatable side module (`dylink.0`) that imports
#        __memory_base / __stack_pointer / __table_base and places its data,
#        BSS, and shadow stack relative to them. Without this the module would
#        emit its statics at FIXED LOW offsets and overwrite live guest data.
#  * --import-memory + --shared-memory + --max-memory:
#        import the guest's single shared linear memory. Shared is required:
#        the channel handshake uses memory.atomic.wait32, which needs it.
#  * +atomics,+bulk-memory,+mutable-globals: shared memory, passive data
#        segments, and the mutable __stack_pointer global.
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

HOST_TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
# The crates whose contents can change this artifact. Derived from the real
# build closure rather than a hand-list, per the closure-derived cache-key rule.
WASI_MODULE_CLOSURE_CRATES="wasi-module,wasi-abi"

# The recipe below is part of the key, and `xtask` computes the fold so the
# build scripts and the Rust consumers (the projection finalizer and the
# `verify-fresh` gate) cannot disagree about what the key is. Folding it here
# instead is what once produced a key with two implementations: the script
# stamped one value, the finalizer compared another, and no rebuild could ever
# satisfy both. See `side_module_build_key` in tools/xtask/src/cargo_closure.rs.
closure_sha() {
  cargo run -q -p xtask --target "$HOST_TRIPLE" -- workspace-closure-sha \
    --crates "$WASI_MODULE_CLOSURE_CRATES" \
    --recipe crates/wasi-module/build-wasm.sh
}

build_key_path() {
  echo "$REPO_ROOT/local-binaries/wasi_module${1}.wasm.build-key"
}

if [[ "${1:-}" == "--verify-fresh" ]]; then
  current_sha="$(closure_sha)"
  artifact="local-binaries/wasi_module32.wasm"
  key_path="$(build_key_path 32)"
  if [[ ! -f "$artifact" ]]; then
    echo "wasi-module: $artifact is missing; build it with" \
      "'bash crates/wasi-module/build-wasm.sh'." >&2
    exit 1
  fi
  if [[ ! -f "$key_path" ]]; then
    echo "wasi-module: $artifact carries no build-key stamp ($key_path is" \
      "missing); rebuild so freshness can be verified." >&2
    exit 1
  fi
  staged_sha="$(cat "$key_path")"
  if [[ "$staged_sha" != "$current_sha" ]]; then
    echo "wasi-module: $artifact is stale: it was built for closure key" \
      "$staged_sha, but the current source tree ($WASI_MODULE_CLOSURE_CRATES)" \
      "resolves to $current_sha. Rebuild with" \
      "'bash crates/wasi-module/build-wasm.sh'." >&2
    exit 1
  fi
  echo "wasi-module: $artifact matches current source ($current_sha)" >&2
  exit 0
fi

echo "== building wasi-module (PIC side module, wasm32) ==" >&2
RUSTFLAGS="${PIC_RUSTFLAGS[*]}" \
  cargo build --release -p wasi-module --target wasm32-unknown-unknown \
    -Z build-std=core,alloc

WASM32="target/wasm32-unknown-unknown/release/wasi_module.wasm"
echo "wasm32 artifact: $WASM32" >&2

# Stage where BOTH hosts load it, mirroring `fork_module32.wasm`:
#   * Node resolves `resolveBinary("wasi_module32.wasm")`, which searches the
#     `local-binaries/` (source-generation) tier and the installed-package
#     `host/wasm/` tier.
#   * The browser's Vite `?url` alias resolves the same copies.
FRESH_CLOSURE_SHA="$(closure_sha)"
mkdir -p "$REPO_ROOT/local-binaries" "$REPO_ROOT/host/wasm"
cp "$WASM32" "$REPO_ROOT/local-binaries/wasi_module32.wasm"
cp "$WASM32" "$REPO_ROOT/host/wasm/wasi_module32.wasm"
printf '%s\n' "$FRESH_CLOSURE_SHA" > "$(build_key_path 32)"
echo "staged wasi_module32.wasm -> local-binaries/, host/wasm/" \
  "(build-key $FRESH_CLOSURE_SHA)" >&2
