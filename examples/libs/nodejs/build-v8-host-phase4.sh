#!/usr/bin/env bash
# Phase 4 — build host-native V8 with CSS + jitless + the kCCBuiltins
# patch applied. Validates that the patch is build-neutral under an
# empty whitelist. Task 4.9 adds a fixture + re-runs this build with
# WHITELIST=TorqueCcTest_Return to link the smoke-test builtin.
#
# Output goes to ${NODE_SRC}/out/Release. The stock torque rebuilder
# at Release.baseline is NOT disturbed.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_SRC="${HERE}/build/node"
# Default whitelist: Task 4.9's smoke-test builtin. Callers may pass
# V8_CC_BUILTINS_WHITELIST='' explicitly to verify the patch is neutral
# under an empty whitelist (Task 4.8 invariant).
WHITELIST="${V8_CC_BUILTINS_WHITELIST-TorqueCcTest_Return}"

[ -d "${NODE_SRC}/deps/v8" ] || {
  echo "Missing ${NODE_SRC}/deps/v8 — run build-nodejs.sh first" >&2
  exit 1
}

cd "${NODE_SRC}"

# Apply consolidated patch if needed (idempotent via .wasm-posix-kernel-patches markers).
bash "${HERE}/build-nodejs.sh"

# Reconfigure out/Release with the Phase 4 flags. Phase 0 had Release
# as lite-mode; we keep lite-mode + add CSS + wire the whitelist.
# Always re-run configure so GYP_DEFINES is picked up fresh (gyp is
# not deeply incremental on variable changes).
echo ">>> ./configure --ninja --v8-lite-mode (GYP_DEFINES: CSS=1, whitelist='${WHITELIST}')"
GYP_DEFINES="v8_enable_conservative_stack_scanning=1 v8_torque_cc_builtins_whitelist=${WHITELIST}" \
  ./configure --ninja --v8-lite-mode

# Build v8_snapshot + mksnapshot (Phase 4's proof points).
echo ">>> ninja -C out/Release mksnapshot"
ninja -C out/Release mksnapshot
echo ">>> ninja -C out/Release v8_snapshot"
ninja -C out/Release v8_snapshot

# Task 4.9: cctest is Node's gtest-based unit test binary. When the
# whitelist is non-empty, this binary links the emitted kCCBuiltins
# functions and exposes them to the TorqueCcBuiltinTest suite at
# test/cctest/test_torque_cc_builtin.cc. Skipped when WHITELIST is empty
# (nothing to link, no test to run).
if [ -n "${WHITELIST}" ]; then
  echo ">>> ninja -C out/Release cctest (whitelist non-empty)"
  ninja -C out/Release cctest
fi

echo ">>> Phase 4 host build OK."
echo ">>>   mksnapshot:  $(ls -la out/Release/mksnapshot 2>/dev/null | awk '{print $5}') bytes"
echo ">>>   libv8_snapshot.a: $(ls -la out/Release/libv8_snapshot.a 2>/dev/null | awk '{print $5}') bytes"
echo ">>>   cctest: $(ls -la out/Release/cctest 2>/dev/null | awk '{print $5}') bytes"
echo ">>>   Torque-CC whitelist: '${WHITELIST}'"
