#!/usr/bin/env bash
#
# Build and stage the standalone WebAssembly-artifact reader module.
#
# Mirrors `crates/dylink-module/build-wasm.sh` -- the established recipe for a
# STANDALONE (non-PIC, zero-import) module in this repository -- and shares its
# one load-bearing difference from the co-resident modules:
#
#   THIS MODULE IS NOT A PIC SIDE MODULE, AND IMPORTS NOTHING.
#
# fork-module and wasi-module are co-resident: they are placed inside the
# GUEST's linear memory (`--pie` + `--import-memory --shared-memory`) because
# every act they perform touches guest state. Reading an artifact does not. It
# is a pure function from bytes to facts, so this module owns its own memory and
# the driver hands it bytes rather than pointers into the guest.
#
# That is not a detail -- it is the whole reason the reader can live in wasm at
# all. Its most important caller is `host/src/kernel.ts`, which needs an
# artifact's pointer width to build the import object BEFORE the kernel module
# is compiled. A module with imports would need something instantiated first,
# reintroducing the bootstrap paradox this crate exists to dissolve. So the
# zero-import property is VERIFIED below on every build rather than asserted in
# a comment: if a future change gives this module an import, the build fails.
#
# Usage:
#   scripts/dev-shell.sh bash crates/wasm-artifact-module/build-wasm.sh
#   scripts/dev-shell.sh bash crates/wasm-artifact-module/build-wasm.sh --verify-fresh
#
# Artifact: target/wasm32-unknown-unknown/release/wasm_artifact_module.wasm
# Staged as: local-binaries/wasm_artifact_module32.wasm
#            host/wasm/wasm_artifact_module32.wasm

set -euo pipefail

# Why RUSTFLAGS here rather than the repo `.cargo/config.toml`: a RUSTFLAGS env
# value REPLACES the entire `target.<triple>.rustflags` array from config. That
# is exactly what this module needs -- the repo-wide array sets
# `--import-memory --shared-memory`, which every other wasm crate here wants and
# this one must not have.
#
#  * --export-memory: the driver reads answer bytes out of this module's own
#        memory, so it has to be reachable from JavaScript.
#  * NO --import-memory / --shared-memory: the module owns its memory. This is
#        what keeps the import list empty and lets `dlmalloc` grow the heap.
#  * NO -C relocation-model=pic / --pie: nothing places this module inside
#        another module's address space.
#  * +bulk-memory: passive data segments. Deliberately WITHOUT `+atomics`:
#        atomics are for shared memory, which this module does not have.
#  * panic=immediate-abort: no unwinder, minimal panic surface.
MODULE_RUSTFLAGS=(
  -C target-feature=+bulk-memory
  -Zunstable-options
  -C panic=immediate-abort
  -C link-arg=--export-memory
)

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

HOST_TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
# The crates whose contents can change this artifact. `cargo_closure_paths`
# walks the compile-time path dependencies from `cargo metadata`, so naming
# `wasm-artifact-module` already pulls in `wasm-artifact`, `fork-codec` and
# `shared`. Both are named anyway so the closure stays correct if the reader
# ever stops being a direct dependency, and `cargo_closure.rs` carries a guard
# test asserting the union really does cover the full graph.
WASM_ARTIFACT_MODULE_CLOSURE_CRATES="wasm-artifact-module,wasm-artifact"

closure_sha() {
  cargo run -q -p xtask --target "$HOST_TRIPLE" -- workspace-closure-sha \
    --crates "$WASM_ARTIFACT_MODULE_CLOSURE_CRATES"
}

build_key_path() {
  echo "$REPO_ROOT/local-binaries/wasm_artifact_module${1}.wasm.build-key"
}

# The placement argument in `src/lib.rs` rests on this module importing nothing.
# An import would mean the reader had acquired a host dependency -- exactly the
# host-surface growth this campaign exists to reverse, and in this case also a
# bootstrap cycle, since the reader runs before the kernel is compiled. So it
# fails the build rather than being discovered later by a boot failure.
verify_no_imports() {
  local wasm="$1"
  local imports
  if ! command -v wasm-objdump >/dev/null 2>&1; then
    echo "wasm-artifact-module: wasm-objdump is unavailable, so the zero-import" \
      "contract could not be verified for $wasm. Run this under" \
      "scripts/dev-shell.sh, which provides wabt." >&2
    return 1
  fi
  imports="$(wasm-objdump -x "$wasm" | sed -n '/^Import\[/,/^$/p' | grep -c '^ - ' || true)"
  if [[ "$imports" != "0" ]]; then
    echo "wasm-artifact-module: $wasm declares $imports import(s), but the" \
      "module contract is that it imports NOTHING -- not even env.memory." \
      "That contract is what lets host/src/kernel.ts read an artifact's" \
      "pointer width BEFORE the kernel module is compiled. Imports found:" >&2
    wasm-objdump -x "$wasm" | sed -n '/^Import\[/,/^$/p' >&2
    return 1
  fi
  echo "wasm-artifact-module: $wasm imports nothing (contract holds)" >&2
}

if [[ "${1:-}" == "--verify-fresh" ]]; then
  current_sha="$(closure_sha)"
  artifact="local-binaries/wasm_artifact_module32.wasm"
  key_path="$(build_key_path 32)"
  # A freshness check that passes on a MISSING artifact is the purest form of
  # this repository's recurring silent-success defect: the gate reports success
  # because it never looked. fork-module shipped exactly that bug.
  if [[ ! -f "$artifact" ]]; then
    echo "wasm-artifact-module: $artifact is missing; build it with" \
      "'bash crates/wasm-artifact-module/build-wasm.sh'." >&2
    exit 1
  fi
  if [[ ! -f "$key_path" ]]; then
    echo "wasm-artifact-module: $artifact carries no build-key stamp" \
      "($key_path is missing); rebuild so freshness can be verified." >&2
    exit 1
  fi
  staged_sha="$(cat "$key_path")"
  if [[ "$staged_sha" != "$current_sha" ]]; then
    echo "wasm-artifact-module: $artifact is stale: it was built for closure" \
      "key $staged_sha, but the current source tree" \
      "($WASM_ARTIFACT_MODULE_CLOSURE_CRATES) resolves to $current_sha." \
      "Rebuild with 'bash crates/wasm-artifact-module/build-wasm.sh'." >&2
    exit 1
  fi
  echo "wasm-artifact-module: $artifact matches current source ($current_sha)" >&2
  exit 0
fi

echo "== building wasm-artifact-module (standalone module, wasm32) ==" >&2
RUSTFLAGS="${MODULE_RUSTFLAGS[*]}" \
  cargo build --release -p wasm-artifact-module --target wasm32-unknown-unknown \
    -Z build-std=core,alloc

WASM32="target/wasm32-unknown-unknown/release/wasm_artifact_module.wasm"
echo "wasm32 artifact: $WASM32" >&2
verify_no_imports "$WASM32"

# Stage where BOTH hosts load it, mirroring `dylink_module32.wasm`:
#   * Node resolves `resolveBinary("wasm_artifact_module32.wasm")`, which
#     searches the `local-binaries/` (source-generation) tier and the
#     installed-package `host/wasm/` tier.
#   * The browser's Vite `@wasm-artifact-module32-wasm?url` alias resolves the
#     same copies.
FRESH_CLOSURE_SHA="$(closure_sha)"
mkdir -p "$REPO_ROOT/local-binaries" "$REPO_ROOT/host/wasm"
cp "$WASM32" "$REPO_ROOT/local-binaries/wasm_artifact_module32.wasm"
cp "$WASM32" "$REPO_ROOT/host/wasm/wasm_artifact_module32.wasm"
printf '%s\n' "$FRESH_CLOSURE_SHA" > "$(build_key_path 32)"
echo "staged wasm_artifact_module32.wasm -> local-binaries/, host/wasm/" \
  "(build-key $FRESH_CLOSURE_SHA)" >&2
