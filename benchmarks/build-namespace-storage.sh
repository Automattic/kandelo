#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo_root"
if [[ -z "${KANDELO_DEV_SHELL_TOOL_PATH:-}" ]]; then
  exec bash scripts/dev-shell.sh bash "$repo_root/benchmarks/build-namespace-storage.sh" "$@"
fi
if [[ $# -ne 1 || "$1" != /* ]]; then
  echo "Usage: $0 <absolute benchmark-only Cargo target directory>" >&2
  exit 2
fi

# Like the positioned image module, this owns its linear memory and imports
# synchronous byte I/O. Its separate target prevents replacing product Wasm.
RUSTFLAGS="-C target-feature=+bulk-memory -Zunstable-options -C panic=immediate-abort -C opt-level=z -C link-arg=--export-memory -C link-arg=--import-undefined" \
  cargo build --locked --release -p kandelo-image-module --features namespace-benchmark \
    --target wasm32-unknown-unknown -Z build-std=core,alloc --target-dir "$1"
printf '%s\n' "$1/wasm32-unknown-unknown/release/kandelo_image_module.wasm"
