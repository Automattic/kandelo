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
`wasm32-unknown-unknown`. The control skips only LLVM's irreducibility analysis;
Node instantiates the resulting module and checks all 18,000 state/input
combinations against calculated results. The default compilation must either
exceed 30 seconds while the control takes under two seconds, or finish after
three seconds with a ratio exceeding 30, to reproduce. If it finishes, its module
is checked as well. No Kandelo code is involved.

The local control took 0.354 seconds and the default took 28.728 seconds;
both produced the expected results. This narrows the observed defect to
compile-time cost, without claiming a code-generation error.

The package patch disables this analysis only in `tree-sitter-gitcommit`,
whose generated lexer and scanner use reducible control flow. It keeps the
complete grammar and SDK compilation, metadata, and instrumentation. Do not
promote this flag to an SDK default: other C programs can have irreducible
control flow and require the pass. The package acceptance tests must exercise
Git commit text as well as ordinary Markdown and source comments.

LLVM introduced the opt-out for this cost in
[llvm-project#67715](https://github.com/llvm/llvm-project/pull/67715).
The pass's own source documents its reachability algorithm and complexity.
A general fix belongs in LLVM's analysis, rather than Kandelo's guest kernel.
No upstream report has been filed from this work. Retirement requires a
released pinned LLVM that handles the standalone example and the unmodified
Git commit grammar without the excessive cost, followed by package tests.
