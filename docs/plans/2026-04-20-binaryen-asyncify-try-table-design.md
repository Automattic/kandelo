# Binaryen Asyncify: try_table support

## Problem

V8 emits a runtime deprecation warning whenever it decodes a legacy Wasm
exception-handling instruction (`try` / `catch` / `catch_all` / `rethrow` /
`delegate`):

> The WebAssembly exception handling 'try' instruction is deprecated and
> should no longer be used. Please recompile to use the 'try_table'
> instruction instead.

All our wasm binaries emit legacy EH today because we pass
`-mllvm -wasm-use-legacy-eh=true` to clang. LLVM's default is the new
standardized form (`try_table` / `throw_ref` / `catch` / `catch_ref` /
`catch_all` / `catch_all_ref`). We pass the flag because Binaryen's
Asyncify pass **crashes with `WASM_UNREACHABLE("unexpected expression
type")`** on any `TryTable` it encounters — its flow walker only knows
about legacy `Try`.

We use Asyncify exclusively for fork: the child worker needs to resume
execution from the `fork()` call site with the parent's linear memory
and call stack. Asyncify is invoked only via `--asyncify-onlylist` on
the transitive call path from `main` to each `fork` site. Signal
handlers swap `__stack_pointer` directly; blocking syscalls use
`Atomics.wait` on the process-worker thread. Nothing else consumes
Asyncify.

## Non-goal: pause/resume from inside a catch handler

Upstream issue
[WebAssembly/binaryen#4470](https://github.com/WebAssembly/binaryen/issues/4470)
tracks general correctness of Asyncify + EH. Solving it requires
replaying the caught `exnref` across a suspend — non-trivial and open
for four years.

Fork is never called from inside a C++ catch handler. The only reason
try/catch appears in our onlylist functions is that `-wasm-enable-sjlj`
lowers `setjmp`/`longjmp` via EH, and the try_table structure is
lexically present in the function even when no exception is active at
the `fork()` call site. We therefore do not need Asyncify to correctly
rewind through catch-handler code — we only need it to stop crashing on
the presence of `try_table` in the function body.

## Scope (tier 1)

Make Asyncify accept `try_table` with the same assumption it already
makes for legacy `Try`: **catch-target code is not instrumented for
pause/resume.** This matches upstream's existing documented limitation
(comment in `src/passes/Asyncify.cpp` line 1172: "catchBodies are
ignored because we assume that pause/resume will not happen inside
them") and the existing `asyncify-ignore-unwind-from-catch` flag.

Tier 3 (full replay of caught exnref during rewind) is out of scope.
Tier 2 (fine-grained assertion on calls reachable only through a
try_table catch branch) is out of scope — the upstream coarse-grained
assertion is sufficient.

## Implementation

### Binaryen patch

Fork: `github.com/brandonpayton/binaryen`, branch `asyncify-try-table`.

Changes to `src/passes/Asyncify.cpp`:

1. **`AsyncifyBuilder::process` — add a `TryTable` arm** mirroring the
   existing `Try` arm at ~line 1168. Scan phase schedules Scan of
   `body`; Finish phase pops one result and installs it as the new
   body. Catch-target labels are not walked (same assumption as legacy
   Try).

2. **`Throw`, `ThrowRef`, `Rethrow`**: all `unreachable`-typed
   transfer-of-control primitives. Verify they do not hit
   `WASM_UNREACHABLE` in the flow walker; add minimal pass-through arms
   if they do.

3. **`AsyncifyAssertInNonInstrumented::visitCallLike` (~line 1391)**:
   the existing stack-walk detects calls lexically inside a legacy
   `Catch` body. With try_table the catch target is a branch to a
   labeled block living anywhere in the function, so lexical-stack
   detection does not apply. Match the coarse behavior users already
   opt into with `asyncify-ignore-unwind-from-catch`. Document the
   limitation in the pass header comment.

4. **Lit tests**: extend
   `test/lit/passes/asyncify_pass-arg=asyncify-eh.wast` and
   `...eh-asserts.wast` with `try_table` / `throw_ref` / `catch_ref`
   cases. Run `ninja check-lit`.

Estimated diff: ~60 lines of pass code + ~200 lines of test fixtures.

### Build integration in this repo

- `third_party/binaryen/` — new submodule pinned to our fork branch.
- `scripts/build-binaryen.sh` — CMake configure + build wasm-opt target.
  Output: `third_party/binaryen/build/bin/wasm-opt`.
- `scripts/lib/wasm-opt.sh` — resolver that returns the submodule path,
  or fails with "run `scripts/build-binaryen.sh` or `build.sh`." No
  PATH fallback: we must not silently use a wasm-opt that does not
  understand `try_table`.
- `build.sh` — invoke `build-binaryen.sh` as an early step.
- ~15 caller scripts — replace `command -v wasm-opt` with the helper.

### Rollout

- Drop `-mllvm -wasm-use-legacy-eh=true` from 12 locations (see
  Section 3 of the plan).
- Rebuild musl sysroot → libc++ → all asyncify-using ported programs.
- Run the full CLAUDE.md test suite on both architectures.
- Browser verification: `./run.sh browser` — confirm V8 deprecation
  warning is gone.
- Benchmarks: `benchmarks/run.ts --rounds=3` on Node + browser. Expect
  neutral.

### Upstream path

Single focused PR to `WebAssembly/binaryen` titled "Asyncify: support
try_table / throw_ref / catch_ref," linking issue #4470 and explicitly
documenting scope (catch-target code is not instrumented, matching
legacy behavior). Expect 2–3 review rounds. Once merged, the submodule
repoints to upstream at the merge SHA.

If upstream rejects, we keep the fork indefinitely and rebase monthly.

## Success criteria

- All test suites green with `-wasm-use-legacy-eh=true` removed.
- V8 try-instruction deprecation warning no longer fires in browser
  demos.
- Benchmarks within ±3% of baseline on both Node and browser.
- Upstream PR opened.

## Falsification

If any of bash, dash, vim, MariaDB, or nginx regresses after the flag
is dropped, the tier-1 assumption ("no pause/resume inside a catch
handler") has been violated in practice. In that case: revert the flag
removal, keep legacy EH, and write up what was learned. The Binaryen
patch itself remains useful — it just does not unblock us alone.
