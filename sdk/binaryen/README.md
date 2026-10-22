# Facts-preserving pre-inlining prototype

This opt-in build of Binaryen 126 carries resolved indirect-call target sets
through full-function inlining before fork instrumentation. The default SDK
and package recipes still use their existing optimizer. There is no LLVM
plugin change and no runtime ABI change.

Build the optimizer explicitly:

```sh
nix build .#binaryen-fork-facts
scripts/dev-shell.sh env WASM_OPT="$PWD/result/bin/wasm-opt" \
  scripts/run-wasm-fork-instrument.sh --require-facts linked.wasm \
  --pre-optimize inlining --post-optimize Os -o program.wasm
```

The input must be a wasm32 main module with the original compiler facts,
names, and matching linked-code hash. The instrumenter first resolves those
facts against the linked code. It attaches conservative target sets to actual
indirect calls, runs the patched optimizer, and constructs fresh facts for the
optimized code. The normal sink analysis then consumes those facts, followed
by instrumentation and the ordinary final optimization. Report mode performs
the same pre-inlining step so the package guard checks the actual pipeline.

## Bounded optimizer contract

The capability flag `--kandelo-fork-facts` makes an unpatched optimizer fail
instead of preserving an unknown section at stale byte offsets. The patch
uses `Function::codeAnnotations`, `metadata::copyBetweenFunctions`, and
the existing annotation reader/writer to move facts with copied calls and
emit updated function indices and instruction offsets.

Only plain `--inlining` is accepted on annotated inputs. Partial inlining,
StackIR generation/optimization, and all other passes are rejected. In
particular, `-O2` and `-Oz` are rejected before output: ordinary folding can
combine two calls with different annotations and retain only one annotation.
Future support must union possible target sets (unknown combined with known
is unknown), clear restrictions, or prove a transformation preserves them.
The experimental inliner may therefore recover less optimization than a full
pre-instrumentation `-O2` pass. Performance must be measured on real artifacts.
The instrumenter selects optimization level 2 for the inliner's heuristics
without scheduling the default `-O2` pipeline. It explicitly disables StackIR
and drops temporary DWARF sections before moving code, keeping Wasm names and
runtime custom sections.

Missing instruction annotations or missing target identities produce
conservative signature matching, never an empty target set. Malformed,
duplicated, or misplaced annotations fail the bridge. The transformed facts
do not reuse the original lexical cleanup scopes or `jmp_buf` identities.
Cleanup dispatch includes its full registered handler set before inlining;
buffer identity and caller-specific cleanup refinements fall back.

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

After optimization, the bridge creates format-5 compiler facts with the
prefix `#kandelo-preinline-targets-v1` after the normal format header. Synthetic
type IDs encode target-set membership. This prefix disables lexical cleanup
overrides: an absent caller-specific pair must not become an empty-handler
restriction. The new facts receive the hash of the code they actually
describe. All source facts and transport annotations are removed before
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
planning, rejection of unaudited passes, and removal of build metadata from
the final optimized artifact. They supplement package and Node/browser fork
tests; they do not establish a performance improvement.

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
