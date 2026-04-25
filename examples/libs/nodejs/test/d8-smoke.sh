#!/usr/bin/env bash
# examples/libs/nodejs/test/d8-smoke.sh — Phase 5 (revised) d8 smoke.
set -euo pipefail
D8="${D8:-$(pwd)/examples/libs/nodejs/build/node/out/Release/d8}"
if [ ! -x "$D8" ]; then
  echo "error: d8 not found or not executable at $D8"
  echo "Run 'bash examples/libs/nodejs/build-v8-host-phase5.sh' first."
  exit 1
fi

pass=0; fail=0
check() {
  local source="$1" expected="$2"
  local actual
  # d8 writes the "experimental features" banner to stderr; drop it so
  # the probe only compares real program output.
  actual="$("$D8" -e "$source" 2>/dev/null | tr -d '\r')"
  if [ "$actual" = "$expected" ]; then
    echo "[pass] $source -> $actual"
    pass=$((pass+1))
  else
    echo "[FAIL] $source"
    echo "       expected: $expected"
    echo "       actual:   $actual"
    fail=$((fail+1))
  fi
}

# Basic interpreter (sanity).
check 'print(1+2)'                       '3'
check 'print("hi")'                      'hi'
check 'print([1,2,3].length)'            '3'

# ArrayIsArray — the Phase 5 success gate.
check 'print(Array.isArray([1,2,3]))'    'true'
check 'print(Array.isArray([]))'         'true'
check 'print(Array.isArray(42))'         'false'
check 'print(Array.isArray("str"))'      'false'
check 'print(Array.isArray({}))'         'false'
check 'print(Array.isArray(null))'       'false'
check 'print(Array.isArray(undefined))'  'false'

# NumberIsFinite — Phase 6 Task 6.2 whitelist. Covers the Smi
# fast-path (0 -> true) and the HeapNumber NaN-probe arm
# (Infinity -> false).
check 'print(Number.isFinite(0))'        'true'
check 'print(Number.isFinite(Infinity))' 'false'

# NumberIsNaN — Phase 6 Task 6.4 whitelist. Smi fast-path (0 -> false)
# and HeapNumber NaN case (NaN -> true).
check 'print(Number.isNaN(0))'           'false'
check 'print(Number.isNaN(NaN))'         'true'

# NumberIsInteger — Phase 6 Task 6.5 whitelist. Smi fast-path
# (1 -> true) and HeapNumber non-integer case (1.5 -> false).
check 'print(Number.isInteger(1))'       'true'
check 'print(Number.isInteger(1.5))'     'false'

# NumberIsSafeInteger — Phase 6 Task 6.6 whitelist. The 2^53 boundary
# is the cheapest discriminator vs. NumberIsInteger.
check 'print(Number.isSafeInteger(Number.MAX_SAFE_INTEGER))' 'true'
check 'print(Number.isSafeInteger(2**53))'                   'false'

# Increment — Phase 8 whitelist. First real-world target hitting
# CCGenerator's tail-call branch; lowers `++x` through UnaryOp1's
# Number arm into Builtin_Add (tail-call) or BigIntUnaryOp (non-tail).
# The Smi fast-path probe (++0) tail-calls Builtin_Add(Smi+Smi). The
# HeapNumber-overflow probe (++MAX_SAFE_INTEGER) exercises Add's
# Smi-overflow → HeapNumber path inside the Builtin_Add C bridge.
check 'var a=0; print(++a)'                             '1'
check 'var b=41; print(++b)'                            '42'
check 'var c=Number.MAX_SAFE_INTEGER; print(++c)'       '9007199254740992'
check 'var d=1n; print(++d)'                            '2'

echo
echo "d8 smoke: $pass passed, $fail failed"
[ "$fail" = 0 ]
