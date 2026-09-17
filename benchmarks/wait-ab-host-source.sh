#!/bin/bash
# Counterbalanced A/B for a change that lives entirely in HOST TYPESCRIPT.
#
# WHY this exists beside wait-ab-bisect.sh. That script stages one git
# worktree per commit and builds a KERNEL from each arm's own Rust, which
# is right when a cutover moves cost between the host and the kernel. It
# is the wrong instrument for a change confined to host TypeScript: it
# varies the kernel, the checkout and the build between arms in order to
# vary one `.ts` file, and every one of those is a way for the result to
# be about something other than the change.
#
# Here the arms share ONE working tree, ONE kernel wasm, ONE guest binary
# and ONE node_modules, and differ in exactly one file, swapped between
# single-run invocations. That is a tighter comparison than two worktrees
# can offer: nothing else CAN differ.
#
# Everything else matches the proven apparatus:
#
#   * `A B B A` counterbalancing, so a monotone drift over the session
#     contributes equally to both arms rather than landing on one.
#   * One process per run, so a contention burst is attributable to the
#     runs it overlapped instead of smearing across an arm.
#   * Aggregation on minima and p10. Contention only ADDS time, so the
#     per-run distribution is one-sided and a median reports how loaded
#     the session was rather than what the code costs. See the header of
#     benchmarks/blocking-wait-ab.ts for the full argument.
#
# It logs the one-minute load average beside every run. Report it. A round
# whose load rises during the session has not measured what it claims, and
# the per-run column is what lets a reader see that rather than trust it.
#
# Usage:
#   benchmarks/wait-ab-host-source.sh <out-dir> <baseline-ref> [runs] [file]
#
#     baseline-ref   arm A: the file as of this ref (the "before")
#     working tree   arm B: the file as it stands now (the "after")
#     file           defaults to host/src/kernel-worker.ts
#
# Run it under scripts/dev-shell.sh. The repo must already have
# benchmarks/wasm/blocking-wait.wasm, local-binaries/{kernel,fork_module32,
# fork_module64,wasm_artifact_module32,dylink_module32}.wasm and
# node_modules; see docs/agent-guidance/validation.md for provisioning.
#
# NOTE it restores the working-tree file when it finishes, and verifies the
# restore. If it is interrupted, the file is left on whichever arm ran last
# -- check `git diff` before committing anything.
set -uo pipefail

OUT="${1:?out dir}"
BASE_REF="${2:?baseline ref for arm A}"
RUNS="${3:-24}"
TARGET="${4:-host/src/kernel-worker.ts}"

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/wait-ab-host-source.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$OUT"
cp "$TARGET" "$STAGE/after"
git show "$BASE_REF:$TARGET" > "$STAGE/before"

if cmp -s "$STAGE/before" "$STAGE/after"; then
  echo "FATAL: $TARGET is identical at $BASE_REF and in the working tree;" >&2
  echo "       there is nothing to compare and any output would be noise." >&2
  exit 1
fi

echo "# file:  $TARGET"
echo "# arm A: $BASE_REF   arm B: working tree"
echo "# arms differ by $(diff "$STAGE/before" "$STAGE/after" | grep -c '^[<>]') changed lines"
echo "# load at start: $(uptime | sed 's/.*averages*: //')"

restore() {
  cp "$STAGE/after" "$TARGET"
  if cmp -s "$TARGET" "$STAGE/after"; then
    echo "# working-tree $TARGET restored"
  else
    echo "# WARNING: could not restore $TARGET -- check git diff" >&2
  fi
}
trap 'restore; rm -rf "$STAGE"' EXIT

pattern=(A B B A)
for ((i = 0; i < RUNS; i++)); do
  arm="${pattern[$((i % 4))]}"
  if [ "$arm" = "A" ]; then cp "$STAGE/before" "$TARGET"; else cp "$STAGE/after" "$TARGET"; fi
  tag=$(printf '%02d' "$i")
  npx tsx benchmarks/blocking-wait-ab.ts --runs=1 \
      --json="$OUT/run-$tag-$arm.json" --label="$arm-$i" \
      >"$OUT/run-$tag-$arm.log" 2>&1 \
    || echo "  run $i ($arm) FAILED -- see $OUT/run-$tag-$arm.log"
  printf '  run %2d %s load1=%s %s\n' "$i" "$arm" \
    "$(uptime | sed 's/.*averages*: //' | awk '{print $1}')" \
    "$(grep -Eo '(epoll|select|poll)_ready=[0-9.]+' "$OUT/run-$tag-$arm.log" | tr '\n' ' ')"
done

echo "# load at end: $(uptime | sed 's/.*averages*: //')"
echo "# aggregate with: node benchmarks/wait-ab-aggregate.mjs $OUT"
