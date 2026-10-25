# Facts-aware wasm-opt extension prototype

This opt-in build of Binaryen 126 maintains or conservatively invalidates
resolved LLVM indirect-call target sets during a normal `wasm-opt` run before
fork instrumentation. The default SDK and package recipes still use their
existing optimizer. There is no LLVM plugin change and no runtime ABI change.

The shipping `--pre-optimize O2|Oz` modes use stock Binaryen and final-Wasm
analysis, discarding original LLVM facts before rewriting code. They do not
use this extension. Package recipes select them through the top-level
`fork_pre_optimize` field and the central installer. The annotation-aware
transport/inlining modes below remain experimental.

Build the optimizer explicitly:

```sh
nix build .#binaryen-fork-facts
scripts/dev-shell.sh env WASM_OPT="$PWD/result/bin/wasm-opt" \
  scripts/run-wasm-fork-instrument.sh --require-facts linked.wasm \
  --pre-optimize inlining-cleanup --post-optimize Os -o program.wasm
```

The input must be a wasm32 main module with the original compiler facts,
names, and matching linked-code hash. The instrumenter first resolves those
facts against the linked code. It attaches conservative target sets to actual
indirect calls, runs the patched optimizer once for this stage, and constructs
fresh facts for the optimized code. The normal sink analysis then consumes
those facts, followed by instrumentation and the ordinary final optimization.
Report mode performs the same pre-optimization step as actual instrumentation.
The LLVM-facts resolver remains in Rust; this does not introduce another
executable that duplicates Binaryen's optimization driver.

## Bounded optimizer contract

The capability flag `--kandelo-fork-facts` makes an unpatched optimizer fail
instead of preserving an unknown section at stale byte offsets. The patch
uses `Function::codeAnnotations`, `metadata::copyBetweenFunctions`, and
the existing annotation reader/writer to move facts with copied calls and
emit updated function indices and instruction offsets.

The compiled-in extension uses a generic pass-metadata observer and an explicit
`preservesCodeMetadata()` contract for call-origin and target-identity metadata.
Full inlining, dead-code elimination and vacuum are audited preserving passes.
Audited read-only analyses also declare preservation explicitly. A pass that
does not modify Binaryen IR can still modify emitted StackIR, so that property
alone does not establish preservation. Unrecognized passes default to
invalidation, including anonymous nested transformations. Their support is
not inferred from pass names. Function-parallel callbacks touch only
their own function's annotations; module callbacks run serially.

| `--pre-optimize` | Optimizer behavior |
|---|---|
| `none` | Default: use original LLVM facts before instrumentation. |
| `transport` | Diagnostic bridge control: no optimizing pass; cleanup and `jmp_buf` refinements still fall back. |
| `inlining` | Strict mode: full inlining; unsupported work fails before output. |
| `inlining-cleanup` | Full inlining, then DCE and vacuum; these preserve call annotations. |
| `O2` / `Oz` | Stock Binaryen pipeline; discard source facts first and analyze final Wasm without this extension. |

Direct optimizer experiments use `--kandelo-fork-facts-pipeline`. Unsupported rewrites
clear restrictions before execution, and the writer suppresses all remaining
call/function identities after any invalidation. An empty transport section
then means successful transport with unknown targets, never a known empty
target set. Global invalidation is deliberately coarse: full `-O2`/`-Oz` can
complete while retaining no useful LLVM target information. Completing an
optimization pipeline is not evidence that facts survived it.

The strict `--kandelo-fork-facts` capability remains available. Partial inlining
and StackIR reject in strict mode and invalidate in the broader mode. The CLI
always disables both. It selects level-2 heuristics for the explicit inlining
pipelines, without scheduling a default `-O2` pipeline. Temporary DWARF is
removed before moving code; names and runtime custom sections remain.

Correctly preserving ordinary call merging needs a union of possible targets;
known combined with unknown must become unknown. This extension currently
invalidates rather than attempting that union. Signature changes, function
deduplication and table rewrites also remain unsupported. Preserving facts
through these transformations requires further work and validation.

Missing instruction annotations or missing target identities produce
conservative signature matching, never an empty target set. Malformed,
duplicated, or misplaced annotations fail the bridge. The transformed facts
do not reuse the original lexical cleanup scopes or `jmp_buf` identities.
Cleanup dispatch includes its full registered handler set before inlining;
buffer identity, caller-specific cleanup, and linked-libc refinements fall back.

The observer does not make the original LLVM facts more trustworthy. It only
maintains their restrictions through the supported transformations.

## Preservation diagnostics

`wasm-opt` emits the build-only `kandelo.fork-facts.report` section. It records
the current indirect-call count, retained annotation count, validity, and
sorted preserving/invalidating pass dispositions. Sorting keeps the report
deterministic under function parallelism. This is a preservation summary,
not a complete instruction-by-instruction transformation log.

The instrumenter prints the summary and separately reports usable target sets
after resolving surviving function identities. These counts can differ: an
annotated call whose original target disappeared falls back conservatively.
`source=facts` and `--require-facts` mean that the facts schema was accepted;
they do not establish that useful target restrictions survived pre-optimization.
Inspect the retained count. The summary and all transport metadata are removed
from the final artifact.

## Temporary metadata format

`metadata.code.kandelo.fork-targets` uses the code-metadata layout already
handled by Binaryen: a function count followed by function-index entries,
each containing an instruction count, then relative instruction offsets,
payload byte lengths, and payloads. Integers are unsigned LEB128.

- Offset zero: payload `[0, original_function_index]`, including imports.
- Indirect-call offset: payload `[1, original_target_index, ...]`.
- `[1]` is a known empty target set. No entry means unknown.

Offsets are relative to the beginning of the function's local declarations.
The section precedes code. The patch updates offsets and function indices;
original target IDs remain stable through the restricted inlining pass.

After optimization, the bridge creates `resolved-1` facts with the header
`#kandelo-calltypes\tresolved-1`. They reuse the source format's function,
type and call records; synthetic type IDs encode target-set membership.
The distinct format disables lexical cleanup overrides: an absent
caller-specific pair must not become an empty-handler restriction. Older
instrumenters reject this header and fall back conservatively. Resolved facts
cannot be concatenated with source-object facts. The new facts receive the
hash of the code they actually describe. All source facts and transport annotations are removed before
shipping the instrumented output.

## Validation

Unit tests cover transport, fresh code binding, missing annotations/targets,
malformed input, stale hashes, and cleanup fallback. Run the external optimizer
integration tests explicitly with the built optimizer:

```sh
scripts/dev-shell.sh env WASM_OPT="$PWD/result/bin/wasm-opt" \
  cargo test -p fork-instrument --target aarch64-apple-darwin \
  --features preopt-integration-tests
```

Replace the target with `rustc -vV`'s host triple on another machine. These
tests require real inlining and function renumbering, preserved precise fork
planning, strict rejection, and conservative fallback through a real call
merge. They check known/unknown merging, broader pipelines, output stability
across worker counts, and removal of build metadata. They supplement package
and Node/browser fork tests; they do not establish a performance improvement.

The real SDK fixture `crates/fork-instrument/tests/fixtures/preopt/fork-jump.c`
checks a fork child returning through an indirect callback and using its
inherited `jmp_buf`. Compile it with the SDK, instrument copies with and
without `--pre-optimize inlining`, then run both with the normal kernel on
Node and Chromium:

```sh
scripts/dev-shell.sh node --experimental-wasm-exnref --import tsx \
  scripts/test-fork-preopt-runtime.ts normal.wasm inlined.wasm
```

The runner requires the normal built kernel and host dependencies. It checks
the completion marker, child status, and actual kernel fork counter on both
hosts. It measures no performance.
