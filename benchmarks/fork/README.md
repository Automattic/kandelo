# Fork-instrument crash reproducer

A standalone C reproducer for the V8 `RangeError: Maximum call stack
size exceeded` exposed by [Automattic/kandelo#669](https://github.com/Automattic/kandelo/pull/669).
`chain.c` is a recursive walker shaped after
`zend_compile_short_circuiting`, built two ways (baseline /
`wasm-fork-instrument`) and probed in a child Node process per depth.
Lets us iterate on kandelo-side fix candidates in seconds instead of
the ~45 min PHP build+run cycle.

## What the crash actually is

V8 budgets a fixed C stack per isolate (~1 MB on Liftoff). Wasm
frames take frame slots for every declared local, used or not. The
deeper the per-frame footprint, the shallower V8's tolerance for
recursion. `wasm-fork-instrument` adds ~8 locals per instrumented
frame for its switch-dispatch state machine. PHP's
`zend_compile_short_circuiting` recurses *unboundedly* on left-leaning
`||` chains. The two effects compose: every extra local pushes the
crash boundary one rung closer.

PR #669 fixes the PHP-side cause by rewriting `zend_compile_*` to
iterate over the chain instead of recursing. The kandelo-side cost —
~8 extra wasm locals per instrumented frame — still composes with
any future recursion-prone workload. This benchmark exists so any
candidate reduction of that per-frame cost can be evaluated against a
stable, PHP-shaped baseline in seconds.

## Build

```bash
bash scripts/dev-shell.sh bash benchmarks/fork/build.sh
```

## Sweep

```bash
node --experimental-wasm-exnref benchmarks/fork/run.mjs
```

Default behavior: binary-searches the max survivable depth for each
of `chain.baseline.wasm` and `chain.forkinstr.wasm`, then exits
non-zero if forkinstr's max depth is not strictly less than
baseline's — that's the invariant the benchmark exists to verify.
Empirical numbers on macOS arm64 / Node v24.13.0 (deterministic,
identical across multiple runs):

| variant   | `walk` locals | max depth | % of baseline |
| --------- | ------------: | --------: | ------------: |
| baseline  |             4 |     9 972 |          100% |
| forkinstr |            12 |     6 648 |        66.7% |

## Caveats

- V8 stack budget is platform-and-tier-dependent. Numbers are
  comparable between variants in the same run, not across machines.
- The standalone reproducer's per-frame footprint is ~15.5× lighter
  than real PHP's (real PHP crashes at depth ~428 on the same host).
  The standalone is for iteration speed, not absolute calibration.
