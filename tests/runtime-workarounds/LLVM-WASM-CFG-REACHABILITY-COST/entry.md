# LLVM-WASM-CFG-REACHABILITY-COST

LLVM 21.1.7's WebAssembly irreducibility analysis builds a reachability graph
for large generated lexers even when their control flow is reducible. Harper's
Git commit grammar reached a 50.6 GiB peak native compiler footprint and did
not finish after 23 minutes. Sampling located the compiler in
`WebAssemblyFixIrreducibleControlFlow::processRegion` and `SmallPtrSet` insertion.
The same source stalls with raw Clang, without Kandelo headers, compiler
plugins, exception handling, libc, or runtime code.

The standalone reproduction generates a C state machine with 3,000 cases and
single-entry loops. It compiles directly with Clang for
`wasm32-unknown-unknown`. The control runs the identical compile with
`-mllvm -stop-before=wasm-fix-irreducible-control-flow`, so it measures
everything that precedes the irreducibility pass. The default compilation must
either exceed 30 seconds while the control takes under two seconds, or finish
after three seconds with a ratio exceeding 30, to reproduce. If it finishes,
Node instantiates its module and checks all 18,000 state/input combinations
against calculated results. No Kandelo code is involved.

The original control instead passed
`-mllvm -wasm-disable-fix-irreducible-control-flow-pass`, which skipped only the
pass. With it, the local control took 0.354 seconds and the default took
28.728 seconds on clang 21.1.7, and both modules produced the expected results.
This narrows the observed defect to compile-time cost, without claiming a
code-generation error. LLVM 23 removed that switch, so the control now stops
before the pass instead. Stopping the same clang 21.1.7 compile before the pass
took 0.40 seconds and stopping it after the pass took 22.8 seconds, which ties
the cost to that pass; an unknown `-stop-before` pass name is a fatal compiler
error, so a renamed pass cannot silently turn the control into a full build.
Through `driver.mjs`, the restructured repro still reports `reproduced` on
clang 21.1.7 (control 0.383 s, default 26.7 s, module checked).

Until LLVM 23, the package patch disabled this analysis only in
`tree-sitter-gitcommit`, whose generated lexer and scanner use reducible
control flow. It kept the complete grammar and SDK compilation, metadata, and
instrumentation. The flag was never suitable as an SDK default: other C
programs can have irreducible control flow and require the pass. The package
acceptance tests exercise Git commit text as well as ordinary Markdown and
source comments.

LLVM introduced the opt-out for this cost in
[llvm-project#67715](https://github.com/llvm/llvm-project/pull/67715).
The pass's own source documents its reachability algorithm and complexity.
A general fix belongs in LLVM's analysis, rather than Kandelo's guest kernel.
No upstream report has been filed from this work. Retirement requires a
released pinned LLVM that handles the standalone example and the unmodified
Git commit grammar without the excessive cost, followed by package tests.

## Retirement

LLVM rewrote the pass's region analysis to use strongly connected components
([llvm-project#181755](https://github.com/llvm/llvm-project/pull/181755),
reapplied as
[#184441](https://github.com/llvm/llvm-project/pull/184441)) and then removed
the opt-out switch
([#185072](https://github.com/llvm/llvm-project/pull/185072)). Both are in
LLVM 23. On the released clang 23.1.3 (dev shell, macOS, 2026-11-15) the
driver reported `not-reproduced`: control 0.398 s, default 0.620 s, all 18,000
combinations checked. Stopping before and after the pass took 0.42 and 0.62
seconds. Kandelo's toolchain is clang 23.1.3, which no longer accepts the
switch, so Harper's `tree-sitter-gitcommit-0.5.0.patch` was removed and
Harper was rebuilt with the grammar going through the pass. No older
supported toolchain still needs the workaround.

The rebuilt Harper passed `host/test/harper-smoke.test.ts` in the full
Node Vitest run on 2026-11-16 (9.7 s), which is the package test the
retirement condition above requires.
