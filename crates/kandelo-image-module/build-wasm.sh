#!/usr/bin/env bash
#
# Build and stage the standalone and positioned VFS image-builder modules.
#
# The local build runs this before any package build (see
# `CORESIDENT_SIDE_MODULES` in `tools/xtask/src/local_build.rs`): it calls
# `--verify-fresh` first and rebuilds only when that fails, then projects the
# staged artifacts into `local-binaries/source-only-v1/`. Image-building package
# recipes load the staged copy through `images/vfs/lib/kandelo-image-fs.ts`.
#
#   THE DEFAULT MODULE IS NOT A PIC SIDE MODULE, AND IMPORTS NOTHING.
#
# Building a VFS image does not touch any guest's state. It is a pure function
# from a recipe to bytes, so this module owns its memory and the builder hands
# it bytes rather than pointers into somebody else's address space.
#
# The positioned variant imports a synchronous image-byte reader and five
# token-bound target byte operations for checked streaming image construction.
# Its separate artifact keeps the default writer's zero-import contract.
#
# Usage:
#   scripts/dev-shell.sh bash crates/kandelo-image-module/build-wasm.sh
#   scripts/dev-shell.sh bash crates/kandelo-image-module/build-wasm.sh --verify-fresh
#
# Artifact: target/wasm32-unknown-unknown/release/kandelo_image_module.wasm
# Staged as: local-binaries/kandelo_image_module32.wasm
# Positioned artifact: local-binaries/kandelo_image_module_positioned32.wasm

set -euo pipefail

# WHY RUSTFLAGS HERE, AND WHY THIS SCRIPT MUST RUN INSIDE THE DEV SHELL:
# a RUSTFLAGS env value REPLACES the entire `target.<triple>.rustflags` array
# from `.cargo/config.toml`, which is exactly what this module needs -- the
# repo-wide array sets `--import-memory --shared-memory`, which every other
# wasm crate here wants and this one must not have.
#
# But `scripts/dev-shell.sh` runs with `--ignore-environment`, so setting
# RUSTFLAGS *outside* it is stripped before cargo starts and the repo config
# applies instead. The failure mode is a wrong number rather than an error: the
# module builds, and reports an imported shared memory it did not ask for. That
# happened while measuring this module. Setting RUSTFLAGS inside the script,
# and running the script under the dev shell, is what makes the override real.
MODULE_RUSTFLAGS=(
  -C target-feature=+bulk-memory
  -Zunstable-options
  -C panic=immediate-abort
  -C opt-level=z
  -C link-arg=--export-memory
)

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

HOST_TRIPLE="$(rustc -vV | sed -n 's/^host: //p')"
# Naming runtime-core explicitly as well as kandelo-image-module: `cargo_closure_paths`
# already walks path dependencies, so this is redundant today, and stays
# correct if the substrate ever stops being a direct dependency.
IMAGE_MODULE_CLOSURE_CRATES="kandelo-image-module,runtime-core"

# The recipe is part of the key, not just the crate graph. The flags below --
# opt-level, the target features, the wasm-opt pass -- decide the artifact's
# bytes as surely as the Rust does, and none of them appear in the closure.
# Without the recipe, editing this file leaves every staged copy stale while
# --verify-fresh reports it current: a freshness gate that passes because it
# looked in only one of the two places the output comes from.
closure_sha() {
  cargo run -q -p xtask --target "$HOST_TRIPLE" -- workspace-closure-sha \
    --crates "$IMAGE_MODULE_CLOSURE_CRATES" \
    --recipe crates/kandelo-image-module/build-wasm.sh
}

build_key_path() {
  echo "$REPO_ROOT/local-binaries/${1}.wasm.build-key"
}

shrink_module() {
  local wasm="$1"
  if ! command -v wasm-opt >/dev/null 2>&1; then
    echo "kandelo-image-module: wasm-opt is unavailable, so $wasm cannot be" \
      "size-optimized. Run this under scripts/dev-shell.sh, which provides" \
      "binaryen." >&2
    return 1
  fi
  local before after
  before="$(wc -c < "$wasm" | tr -d ' ')"
  wasm-opt -Oz --enable-bulk-memory -o "$wasm.opt" "$wasm"
  mv "$wasm.opt" "$wasm"
  after="$(wc -c < "$wasm" | tr -d ' ')"
  echo "kandelo-image-module: wasm-opt -Oz ${before} -> ${after} bytes" >&2
}

# The zero-import contract is VERIFIED on every build rather than asserted in a
# comment. An import here would mean the image builder had acquired a host
# dependency, and it would be discovered much later, by a host that could not
# instantiate the module.
verify_no_imports() {
  local wasm="$1"
  if ! command -v wasm-objdump >/dev/null 2>&1; then
    echo "kandelo-image-module: wasm-objdump is unavailable, so the zero-import" \
      "contract could not be verified for $wasm. Run this under" \
      "scripts/dev-shell.sh, which provides wabt." >&2
    return 1
  fi
  local imports
  imports="$(wasm-objdump -x "$wasm" | sed -n '/^Import\[/,/^$/p' | grep -c '^ - ' || true)"
  if [[ "$imports" != "0" ]]; then
    echo "kandelo-image-module: $wasm declares $imports import(s), but the module" \
      "contract is that it imports NOTHING -- not even env.memory. That" \
      "contract is what lets a VFS image builder run without every new host" \
      "supplying functions for it. Imports found:" >&2
    wasm-objdump -x "$wasm" | sed -n '/^Import\[/,/^$/p' >&2
    return 1
  fi
  echo "kandelo-image-module: $wasm imports nothing (contract holds)" >&2
}

verify_positioned_import() {
  node - "$1" <<'NODE'
const fs = require("node:fs");
const module = new WebAssembly.Module(fs.readFileSync(process.argv[2]));
const imports = WebAssembly.Module.imports(module);
const expected = ["host_image_read", "host_image_target_size", "host_image_target_read",
  "host_image_target_write", "host_image_target_truncate", "host_image_target_flush"].sort();
if (imports.length !== expected.length || imports.some((item) => item.module !== "env" || item.kind !== "function") ||
    imports.map((item) => item.name).sort().some((name, index) => name !== expected[index])) {
  throw new Error(`positioned image module has unexpected imports: ${JSON.stringify(imports)}`);
}
if (!WebAssembly.Module.exports(module).some((item) => item.name === "sm_load_image_positioned")) {
  throw new Error("positioned image module lacks sm_load_image_positioned");
}
for (const name of ["sm_load_persistent_image", "sm_persistent_image_begin", "sm_persistent_image_push",
  "sm_persistent_image_finish", "sm_persistent_image_check_step", "sm_persistent_image_identity_word",
  "sm_persistent_image_cancel", "sm_persistent_image_inspect", "sm_export_image_length"]) {
  if (!WebAssembly.Module.exports(module).some((item) => item.name === name)) throw new Error(`positioned image module lacks ${name}`);
}
NODE
}

if [[ "${1:-}" == "--verify-fresh" ]]; then
  current_sha="$(closure_sha)"
  for name in kandelo_image_module32 kandelo_image_module_positioned32; do
    artifact="local-binaries/${name}.wasm"
    key_path="$(build_key_path "$name")"
    if [[ ! -f "$artifact" || ! -f "$key_path" ]]; then
      echo "kandelo-image-module: $artifact or its build-key is missing; rebuild with" \
        "'bash crates/kandelo-image-module/build-wasm.sh'." >&2
      exit 1
    fi
    staged_sha="$(cat "$key_path")"
    if [[ "$staged_sha" != "$current_sha" ]]; then
      echo "kandelo-image-module: $artifact is stale: it was built for closure key" \
        "$staged_sha, but the current source tree resolves to $current_sha." >&2
      exit 1
    fi
    echo "kandelo-image-module: $artifact matches current source ($current_sha)" >&2
  done
  exit 0
fi

echo "== building kandelo-image-module (standalone module, wasm32) ==" >&2
RUSTFLAGS="${MODULE_RUSTFLAGS[*]}" \
  cargo build --release -p kandelo-image-module --target wasm32-unknown-unknown \
    -Z build-std=core,alloc

WASM32="target/wasm32-unknown-unknown/release/kandelo_image_module.wasm"
echo "wasm32 artifact: $WASM32" >&2
# Shrink FIRST, then verify: the contract must hold for the bytes that ship,
# not for an intermediate binaryen never saw.
shrink_module "$WASM32"
verify_no_imports "$WASM32"

echo "== building kandelo-image-module (positioned image, wasm32) ==" >&2
CARGO_TARGET_DIR="target/positioned-image" \
  RUSTFLAGS="${MODULE_RUSTFLAGS[*]} -C link-arg=--import-undefined" \
  cargo build --release -p kandelo-image-module --features positioned-image \
    --target wasm32-unknown-unknown -Z build-std=core,alloc
POSITIONED_WASM32="target/positioned-image/wasm32-unknown-unknown/release/kandelo_image_module.wasm"
shrink_module "$POSITIONED_WASM32"
verify_positioned_import "$POSITIONED_WASM32"

FRESH_CLOSURE_SHA="$(closure_sha)"
mkdir -p "$REPO_ROOT/local-binaries"
cp "$WASM32" "$REPO_ROOT/local-binaries/kandelo_image_module32.wasm"
printf '%s\n' "$FRESH_CLOSURE_SHA" > "$(build_key_path kandelo_image_module32)"
echo "staged kandelo_image_module32.wasm -> local-binaries/ (build-key $FRESH_CLOSURE_SHA)" >&2
cp "$POSITIONED_WASM32" "$REPO_ROOT/local-binaries/kandelo_image_module_positioned32.wasm"
printf '%s\n' "$FRESH_CLOSURE_SHA" > "$(build_key_path kandelo_image_module_positioned32)"
echo "staged kandelo_image_module_positioned32.wasm -> local-binaries/ (build-key $FRESH_CLOSURE_SHA)" >&2
