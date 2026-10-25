#!/usr/bin/env bash
# Runs the fork-instrument Phase 6 fuzzer for a fixed iteration budget.
# Defaults to the §5.4 gate value (10 000). Override with FUZZ_RUNS=<N>
# and FUZZ_MAX_LEN=<N>.
#
# On macOS arm64, cargo-fuzz's default AddressSanitizer deadlocks during
# init (its malloc interceptor recurses into ASAN init, which holds a
# spin mutex). We pass --sanitizer=none to avoid the hang; libFuzzer's
# coverage instrumentation is orthogonal and still works. The fork-
# instrument fuzzer targets semantic/validator divergence, not
# memory-safety, so ASAN is not load-bearing here.
set -euo pipefail

RUNS="${FUZZ_RUNS:-10000}"
MAX_LEN="${FUZZ_MAX_LEN:-128}"
HOST_TARGET="${HOST_TARGET:-$(rustc -vV | awk '/^host/ {print $2}')}"

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUT_DIR="${FUZZ_OUTPUT_DIR:-$REPO_ROOT/.context/fork-instrument-fuzz}"
mkdir -p "$OUTPUT_DIR/corpus" "$OUTPUT_DIR/artifacts"
OUTPUT_DIR="$(cd "$OUTPUT_DIR" && pwd)"

cd "$REPO_ROOT/crates/fork-instrument"

# Generated corpora and build files must not change the instrumenter's source
# identity while normal package/tool builders hash their inputs.
exec cargo fuzz run --target "$HOST_TARGET" \
    --target-dir "$REPO_ROOT/target/fork-instrument-fuzz" \
    --sanitizer=none fuzz_try_table "$OUTPUT_DIR/corpus" -- \
    -artifact_prefix="$OUTPUT_DIR/artifacts/" \
    -runs="$RUNS" \
    -max_len="$MAX_LEN"
