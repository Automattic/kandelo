#!/usr/bin/env bash
# Phase 5 — build host-native V8 with CSS + jitless + the kCCBuiltins
# patch applied, and add d8 to the build targets. Default whitelist layers
# on every builtin verified green by the harness so a from-scratch run
# exercises the full Phase-5 tested set.
#
# Diffs vs Phase 4:
#   - Default WHITELIST is the Phase-5 tested set (Phase 4 defaulted to
#     TorqueCcTest_Return only).
#   - ./configure passes --enable-d8, wiring tools/v8_gypfiles/d8.gyp:d8
#     into node.gypi's dependency list (node.gypi:87-89).
#   - `ninja -C out/Release d8` is invoked after v8_snapshot.
#   - Final summary line lists d8 size alongside Phase 4's listings.
#
# Output goes to ${NODE_SRC}/out/Release. The stock torque rebuilder at
# Release.baseline is NOT disturbed.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_SRC="${HERE}/build/node"
# Default whitelist: every builtin green in
# test/torque-fixtures/*-tq-ccbuiltins.cc that takes a real V8-compatible
# ABI (stub-linkage TorqueCcTest_Return, JS-linkage TorqueCcTest_JsReturn,
# Task 5.7's ArrayIsArray, Task 6.2's NumberIsFinite). `-` (no colon) lets
# callers override with an explicit empty string to validate d8-entrypoint
# neutrality.
WHITELIST="${V8_CC_BUILTINS_WHITELIST-TorqueCcTest_Return,TorqueCcTest_JsReturn,ArrayIsArray,NumberIsFinite,NumberIsNaN,NumberIsInteger,NumberIsSafeInteger,TorqueCcTest_TailCall,TorqueCcTest_TailCall_Helper,Increment,Decrement,TorqueCcTest_CatchBlock,TorqueCcTest_JsVarargs}"

[ -d "${NODE_SRC}/deps/v8" ] || {
  echo "Missing ${NODE_SRC}/deps/v8 — run build-nodejs.sh first" >&2
  exit 1
}

cd "${NODE_SRC}"

# Apply consolidated patch if needed (idempotent via .wasm-posix-kernel-patches markers).
bash "${HERE}/build-nodejs.sh"

# Reconfigure out/Release with Phase 5 flags: lite-mode + CSS + whitelist
# + --enable-d8. Always re-run configure so GYP_DEFINES is picked up
# fresh (gyp is not deeply incremental on variable changes).
echo ">>> ./configure --ninja --v8-lite-mode --enable-d8 (GYP_DEFINES: CSS=1, whitelist='${WHITELIST}')"
GYP_DEFINES="v8_enable_conservative_stack_scanning=1 v8_torque_cc_builtins_whitelist=${WHITELIST}" \
  ./configure --ninja --v8-lite-mode --enable-d8

# Build v8_snapshot + mksnapshot (Phase 4's proof points).
echo ">>> ninja -C out/Release mksnapshot"
ninja -C out/Release mksnapshot
echo ">>> ninja -C out/Release v8_snapshot"
ninja -C out/Release v8_snapshot

# Phase 5: add d8 as a build target. Proves the kCCBuiltins patch is
# d8-entrypoint-neutral under an empty whitelist (Task 5.2 invariant)
# and gives subsequent tasks a d8 binary to smoke-test translated
# builtins through V8's full interpreter pipeline.
echo ">>> ninja -C out/Release d8"
ninja -C out/Release d8

# Task 4.9 / 5.7+: cctest links the emitted kCCBuiltins functions when
# the whitelist is non-empty. Skipped under empty whitelist (nothing to
# link, nothing new to test).
if [ -n "${WHITELIST}" ]; then
  echo ">>> ninja -C out/Release cctest (whitelist non-empty)"
  ninja -C out/Release cctest
fi

echo ">>> Phase 5 host build OK."
echo ">>>   mksnapshot:       $(ls -la out/Release/mksnapshot 2>/dev/null | awk '{print $5}') bytes"
echo ">>>   libv8_snapshot.a: $(ls -la out/Release/libv8_snapshot.a 2>/dev/null | awk '{print $5}') bytes"
echo ">>>   d8:               $(ls -la out/Release/d8 2>/dev/null | awk '{print $5}') bytes"
echo ">>>   cctest:           $(ls -la out/Release/cctest 2>/dev/null | awk '{print $5}') bytes"
echo ">>>   Torque-CC whitelist: '${WHITELIST}'"
