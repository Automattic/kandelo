#!/usr/bin/env bash
#
# Build and stage the standalone dynamic-linking planner module.
#
# Mirrors `crates/fork-module/build-wasm.sh` and `crates/wasi-module/build-wasm.sh`
# -- the established recipe for a wasm module in this repository -- with one
# deliberate and load-bearing difference:
#
#   THIS MODULE IS NOT A PIC SIDE MODULE, AND IMPORTS NOTHING.
#
# fork-module and wasi-module are co-resident: they are placed inside the
# GUEST's linear memory (`--pie` + `--import-memory --shared-memory`) because
# every act they perform touches guest state. The linker planner does not. It
# is a pure function from bytes to a plan, so it owns its own memory, and the
# driver hands it bytes rather than pointers into the guest.
#
# That is not a detail -- it is the reason the module is placed here at all
# instead of being folded into `crates/fork-module` (which would have removed
# `dlopen` from every UNINSTRUMENTED process; see `src/lib.rs`). So the zero-
# import property is VERIFIED below on every build rather than asserted in a
# comment: if a future change gives this module an import, the build fails.
#
# Usage:
#   scripts/dev-shell.sh bash crates/dylink-module/build-wasm.sh
#   scripts/dev-shell.sh bash crates/dylink-module/build-wasm.sh --verify-fresh
#
# Artifact: target/wasm32-unknown-unknown/release/dylink_module.wasm
# Staged as: local-binaries/dylink_module32.wasm and host/wasm/dylink_module32.wasm

set -euo pipefail

# Why RUSTFLAGS here rather than the repo `.cargo/config.toml`: a RUSTFLAGS env
# value REPLACES the entire `target.<triple>.rustflags` array from config. That
# is exactly what this module needs -- the repo-wide array sets
# `--import-memory --shared-memory`, which every other wasm crate here wants and
# this one must not have.
#
#  * --export-memory: the driver reads the plan records out of this module's
#        own memory, so it has to be reachable from JavaScript.
#  * NO --import-memory / --shared-memory: the module owns its memory. This is
#        what keeps the import list empty and lets `dlmalloc` grow the heap.
#  * NO -C relocation-model=pic / --pie: nothing places this module inside
#        another module's address space, so its statics may sit at their
#        natural offsets.
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
# `dylink-module` already pulls in `dylink`, `fork-codec` and `shared`. Both are
# named anyway so the closure stays correct if the planner ever stops being a
# direct dependency, and `cargo_closure.rs` carries a guard test asserting the
# union really does cover the full graph.
DYLINK_MODULE_CLOSURE_CRATES="dylink-module,dylink"

closure_sha() {
  cargo run -q -p xtask --target "$HOST_TRIPLE" -- workspace-closure-sha \
    --crates "$DYLINK_MODULE_CLOSURE_CRATES"
}

build_key_path() {
  echo "$REPO_ROOT/local-binaries/dylink_module${1}.wasm.build-key"
}

# The placement argument in `src/lib.rs` rests on this module importing nothing.
# An import would mean the planner had acquired a host dependency -- exactly the
# host-surface growth this campaign exists to reverse -- so it fails the build
# rather than being discovered later by a boot failure in one host.
verify_no_imports() {
  local wasm="$1"
  local imports
  if ! command -v wasm-objdump >/dev/null 2>&1; then
    echo "dylink-module: wasm-objdump is unavailable, so the zero-import" \
      "contract could not be verified for $wasm. Run this under" \
      "scripts/dev-shell.sh, which provides wabt." >&2
    return 1
  fi
  imports="$(wasm-objdump -x "$wasm" | sed -n '/^Import\[/,/^$/p' | grep -c '^ - ' || true)"
  if [[ "$imports" != "0" ]]; then
    echo "dylink-module: $wasm declares $imports import(s), but the module" \
      "contract is that it imports NOTHING -- not even env.memory. That" \
      "contract is why the planner is a standalone module instead of part of" \
      "crates/fork-module. Imports found:" >&2
    wasm-objdump -x "$wasm" | sed -n '/^Import\[/,/^$/p' >&2
    return 1
  fi
  echo "dylink-module: $wasm imports nothing (contract holds)" >&2
}

if [[ "${1:-}" == "--verify-fresh" ]]; then
  current_sha="$(closure_sha)"
  artifact="local-binaries/dylink_module32.wasm"
  key_path="$(build_key_path 32)"
  if [[ ! -f "$artifact" ]]; then
    echo "dylink-module: $artifact is missing; build it with" \
      "'bash crates/dylink-module/build-wasm.sh'." >&2
    exit 1
  fi
  if [[ ! -f "$key_path" ]]; then
    echo "dylink-module: $artifact carries no build-key stamp ($key_path is" \
      "missing); rebuild so freshness can be verified." >&2
    exit 1
  fi
  staged_sha="$(cat "$key_path")"
  if [[ "$staged_sha" != "$current_sha" ]]; then
    echo "dylink-module: $artifact is stale: it was built for closure key" \
      "$staged_sha, but the current source tree" \
      "($DYLINK_MODULE_CLOSURE_CRATES) resolves to $current_sha. Rebuild" \
      "with 'bash crates/dylink-module/build-wasm.sh'." >&2
    exit 1
  fi
  echo "dylink-module: $artifact matches current source ($current_sha)" >&2
  exit 0
fi

echo "== building dylink-module (standalone module, wasm32) ==" >&2
RUSTFLAGS="${MODULE_RUSTFLAGS[*]}" \
  cargo build --release -p dylink-module --target wasm32-unknown-unknown \
    -Z build-std=core,alloc

WASM32="target/wasm32-unknown-unknown/release/dylink_module.wasm"
echo "wasm32 artifact: $WASM32" >&2
verify_no_imports "$WASM32"

# Stage where BOTH hosts load it, mirroring `fork_module32.wasm`:
#   * Node resolves `resolveBinary("dylink_module32.wasm")`, which searches the
#     `local-binaries/` (source-generation) tier and the installed-package
#     `host/wasm/` tier.
#   * The browser's Vite `@dylink-module32-wasm?url` alias resolves the same
#     copies.
FRESH_CLOSURE_SHA="$(closure_sha)"
mkdir -p "$REPO_ROOT/local-binaries" "$REPO_ROOT/host/wasm"
cp "$WASM32" "$REPO_ROOT/local-binaries/dylink_module32.wasm"
cp "$WASM32" "$REPO_ROOT/host/wasm/dylink_module32.wasm"
printf '%s\n' "$FRESH_CLOSURE_SHA" > "$(build_key_path 32)"
echo "staged dylink_module32.wasm -> local-binaries/, host/wasm/" \
  "(build-key $FRESH_CLOSURE_SHA)" >&2
