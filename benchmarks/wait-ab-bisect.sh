#!/bin/bash
# Stage one git worktree per commit and A/B the blocking-wait benchmark
# across them.
#
# WHY this exists. A regression that spans several commits can only be
# localised by measuring at each of them, and doing that correctly is
# fiddly in ways that quietly invalidate the result:
#
#   * The guest binary must be IDENTICAL in every arm. The benchmark
#     source often does not exist at the base commit, and rebuilding it
#     per arm would vary the thing under test rather than the runtime.
#     This stages one pre-built wasm into all arms.
#   * The kernel must be built from each arm's OWN Rust, because a
#     cutover moves cost between the host and the kernel and pinning one
#     kernel across arms would hide exactly that.
#   * Everything else -- node_modules, the fork module, the
#     wasm-artifact module -- must be shared, so the arms differ only in
#     the runtime's own source.
#   * Arms must be interleaved, not run as blocks, or a contention burst
#     lands entirely inside one arm.
#
# Getting any of these wrong produces a number that looks like a finding.
# This campaign has withdrawn two such numbers.
#
# Usage:
#   benchmarks/wait-ab-bisect.sh <stage-dir> <base-sha> <sha>...
#
# Run it under scripts/dev-shell.sh. The repo must already have
# benchmarks/wasm/blocking-wait.wasm, local-binaries/kernel.wasm's
# siblings (fork_module*.wasm, wasm_artifact_module32.wasm) and
# node_modules; see docs/agent-guidance/validation.md for provisioning.
#
# Aggregate the per-arm JSON it writes with the minima, not the medians --
# benchmarks/blocking-wait-ab.ts explains why.
set -euo pipefail

STAGE="${1:?stage dir}"; shift
BASE="${1:?base sha}"; shift
REPO="$(cd "$(dirname "$0")/.." && pwd)"
RUNS="${RUNS:-24}"

stage_arm() {
  local sha="$1" dir="$2"
  [ -d "$dir" ] || git -C "$REPO" worktree add --detach "$dir" "$sha" >/dev/null
  ln -sfn "$REPO/node_modules" "$dir/node_modules"
  ln -sfn "$REPO/sysroot"      "$dir/sysroot"
  mkdir -p "$dir/local-binaries" "$dir/host/wasm" "$dir/benchmarks/wasm"
  local f
  for f in fork_module32.wasm fork_module64.wasm wasm_artifact_module32.wasm; do
    cp -f "$REPO/local-binaries/$f" "$dir/local-binaries/$f"
    cp -f "$REPO/host/wasm/$f"      "$dir/host/wasm/$f"
  done
  cp -f "$REPO/benchmarks/wasm/blocking-wait.wasm" "$dir/benchmarks/wasm/"
  cp -f "$REPO/benchmarks/blocking-wait-ab.ts"     "$dir/benchmarks/"
  if [ ! -s "$dir/local-binaries/kernel.wasm" ]; then
    ( cd "$dir" && cargo build --release -p kandelo -Z build-std=core,alloc >/dev/null 2>&1 )
    cp -f "$dir/target/wasm32-unknown-unknown/release/kandelo_kernel.wasm" \
          "$dir/local-binaries/kernel.wasm"
  fi
}

mkdir -p "$STAGE"
echo "staging base $BASE"
stage_arm "$BASE" "$STAGE/base"

for sha in "$@"; do
  echo "staging $sha"
  stage_arm "$sha" "$STAGE/$sha"
done

# A B B A, so a monotone drift over the session contributes equally to
# both arms instead of landing on one.
pattern=(A B B A)
for sha in "$@"; do
  out="$STAGE/results-$sha"
  mkdir -p "$out"
  echo "=== $BASE vs $sha (load: $(uptime | sed 's/.*averages*: //')) ==="
  for ((i = 0; i < RUNS; i++)); do
    arm="${pattern[$((i % 4))]}"
    if [ "$arm" = "A" ]; then dir="$STAGE/base"; else dir="$STAGE/$sha"; fi
    ( cd "$dir" && npx tsx benchmarks/blocking-wait-ab.ts --runs=1 \
        --json="$out/run-$(printf '%02d' "$i")-$arm.json" \
        --label="$sha-$i$arm" ) >"$out/run-$(printf '%02d' "$i")-$arm.log" 2>&1 \
      || echo "  run $i ($arm) FAILED — see $out/run-$(printf '%02d' "$i")-$arm.log"
  done
  echo "  wrote $out"
done
