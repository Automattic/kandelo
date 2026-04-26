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

cd "$(dirname "$0")/../crates/fork-instrument"

exec cargo fuzz run --sanitizer=none fuzz_try_table -- \
    -runs="$RUNS" \
    -max_len="$MAX_LEN"
