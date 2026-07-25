#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
ARCH=""
OUTPUT=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --arch)
      ARCH="${2:-}"
      shift 2
      ;;
    --output)
      OUTPUT="${2:-}"
      shift 2
      ;;
    *)
      echo "build-fork-instrumented-test-fixture.sh: unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

case "$ARCH" in
  wasm32|wasm64) ;;
  *)
    echo "build-fork-instrumented-test-fixture.sh: --arch must be wasm32 or wasm64" >&2
    exit 2
    ;;
esac

if [ -z "$OUTPUT" ] || [ ! -d "$(dirname "$OUTPUT")" ]; then
  echo "build-fork-instrumented-test-fixture.sh: --output must have an existing parent directory" >&2
  exit 2
fi

ABI_VERSION="$(sed -nE 's/^pub const ABI_VERSION: u32 = ([0-9]+);$/\1/p' \
  "$REPO_ROOT/crates/shared/src/lib.rs" | head -n1)"
if [ -z "$ABI_VERSION" ]; then
  echo "build-fork-instrumented-test-fixture.sh: cannot read the current ABI version" >&2
  exit 2
fi

WORK_ROOT="$(mktemp -d)"
trap 'rm -rf "$WORK_ROOT"' EXIT
INPUT_WAT="$WORK_ROOT/input.wat"
INPUT_WASM="$WORK_ROOT/input.wasm"

# WHY: generate valid fixtures through the production transform so an ABI
# change cannot leave tests hand-carrying an obsolete fork metadata shape.
if [ "$ARCH" = "wasm64" ]; then
  cat >"$INPUT_WAT" <<WAT
(module
  (import "kernel" "kernel_fork" (func \$kernel_fork (result i32)))
  (memory i64 1)
  (func (export "__abi_version") (result i32) (i32.const $ABI_VERSION))
  (func (export "_start")
    (drop (call \$kernel_fork))))
WAT
  wat2wasm --enable-memory64 "$INPUT_WAT" -o "$INPUT_WASM"
else
  cat >"$INPUT_WAT" <<WAT
(module
  (import "kernel" "kernel_fork" (func \$kernel_fork (result i32)))
  (memory 1)
  (func (export "__abi_version") (result i32) (i32.const $ABI_VERSION))
  (func (export "_start")
    (drop (call \$kernel_fork))))
WAT
  wat2wasm "$INPUT_WAT" -o "$INPUT_WASM"
fi

bash "$REPO_ROOT/scripts/run-wasm-fork-instrument.sh" \
  --output "$OUTPUT" \
  "$INPUT_WASM"
