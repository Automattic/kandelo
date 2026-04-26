# Fork-Instrumentation Tool (wasm-fork-instrument) — Design

## 1. Problem

Our platform needs to support POSIX `fork()`. A child process must resume
execution from the `fork()` call site with its parent's linear memory
and call stack intact. Wasm does not expose its call stack to the
embedder, so this requires *compile-time instrumentation* that adds
explicit save/restore machinery to every function on the call path to
`fork()`.

Today we use Binaryen's `--asyncify` pass for this. That pass is
general-purpose ("pause anywhere, resume anywhere"), carries invariants
(the Flatten pre-pass demands that control-flow structures have no
result type) that are incompatible with LLVM's new-EH output from
`-wasm-enable-sjlj`, and has an indirect-call limitation that forces us
to use *full-module* Asyncify for git. The try_table / Flatten
interaction is tracked upstream as
[binaryen#4470](https://github.com/WebAssembly/binaryen/issues/4470) and
has been open four years without resolution.

Our use case is strictly narrower than Asyncify's design space:

| Our requirement | Asyncify's design |
|---|---|
| Checkpoint state *only* at `fork()` call sites | Suspend anywhere, resume anywhere |
| Resume in a freshly-instantiated child instance | Resume in the same instance |
| Handle new-EH (`try_table`) cleanly | Crashes on `try_table`; Flatten pre-pass breaks catch-to-result-typed-block |
| Handle indirect calls on fork paths | `onlylist` + indirect calls is buggy; forces full-module instrumentation |

Given that narrowness, a purpose-built tool is justified: we own the
entire pipeline, can handle try_table and indirect calls correctly from
day one, and close gaps (like resume-from-catch-handler) that upstream
has not addressed.

## 2. Non-goals

- General pause/resume anywhere in execution (e.g., for async I/O). We
  do not have, and do not plan, a non-fork use of stack serialization.
  `ucontext` / `makecontext` / `swapcontext` / `setcontext` are
  explicitly **unsupported** — documented in `docs/posix-status.md`.
- Inter-instance resume outside fork. Our only cross-instance
  checkpoint is fork-style process duplication.
- Staying compatible with Binaryen's `asyncify_*` ABI. We emit our own
  explicitly-named exports; host-side code is updated in the same
  rollout.
- Replacing Binaryen for other purposes. We still may want `wasm-opt
  -O2` as a standalone binary-size optimizer — but it's optional, and
  any stock `wasm-opt` works since we don't need the fork passes.

## 3. Design overview

A single Rust crate, `crates/fork-instrument`, exposes a CLI
`wasm-fork-instrument`. It reads a wasm binary, instruments every
function on the transitive call path to a designated import (by default
`kernel.kernel_fork`), and writes a new wasm binary with five exported
control functions that the host uses to drive unwind/rewind.

Implementation uses [walrus](https://crates.io/crates/walrus) for
parsing, IR manipulation, and emission. walrus provides typed IR
(instructions are nodes in a control-flow graph, operand-stack types
are computable per program point) and a stable validator.

### 3.1 State machine

One mutable i32 global, `_wpk_fork_state`:

- `NORMAL = 0` — ordinary execution
- `UNWINDING = 1` — stack being torn down, frames being saved
- `REWINDING = 2` — stack being rebuilt from saved frames

One mutable global, `_wpk_fork_buf`, holds a pointer (i32 for wasm32,
i64 for wasm64) to the save buffer while non-Normal. Zero while Normal.

### 3.2 Exported ABI

```
wpk_fork_unwind_begin(buf: ptr) -> void
  Precondition:  state == NORMAL
  Postcondition: state := UNWINDING, _wpk_fork_buf := buf

wpk_fork_unwind_end() -> void
  Precondition:  state == UNWINDING (all frames drained — top-of-stack reached)
  Postcondition: state := NORMAL

wpk_fork_rewind_begin(buf: ptr) -> void
  Precondition:  state == NORMAL
  Postcondition: state := REWINDING, _wpk_fork_buf := buf

wpk_fork_rewind_end() -> void
  Precondition:  state == REWINDING (all frames reloaded — fork call site reached)
  Postcondition: state := NORMAL

wpk_fork_state() -> i32
  Returns current state (exposed for host debugging/assertions)
```

Save buffer layout (ptr-width for wasm32 = 4 bytes, wasm64 = 8 bytes;
shown for wasm32):

```
Offset   Size     Name                      Purpose
------   ----     ----                      -------
+0       4        current_pos               Next free byte for frame data
+4       4        end_pos                   One past end of buffer
+8       4        saved_stack_pointer       __stack_pointer global at unwind begin
+12      4        saved_tls_base            __tls_base global at unwind begin
+16      N        saved_globals[]           All other mutable globals, in declaration order
+16+N    -        frame data               Frames grow upward from here
```

All values little-endian. `N` is fixed per module at instrumentation
time and recorded in the tool's output metadata for the host.

Frame format (one per instrumented stack frame):

```
Offset   Size     Name                      Purpose
------   ----     ----                      -------
+0       4        func_index                Function identity
+4       4        call_index                Which call site within the function
+8       4        catch_region_id           0 if in normal flow; else a try_table id
+12      4        exnref_stash_slot         If catch_region_id != 0, table slot of the exnref
+16      var      saved_locals[]            All locals (type-prefix-encoded for ref types)
```

`catch_region_id` is zero in the common case; non-zero indicates the
frame was caught inside a catch handler. See §3.6.

### 3.3 Per-function instrumentation

The original body `B` of an instrumented function `F` is transformed as
follows (pseudocode; real emission operates on walrus IR):

```
(func $F ...original params, original locals, + injected spill locals...
  ;; --- Preamble ---
  (if (i32.eq (global.get $_wpk_fork_state) (i32.const REWINDING))
    (then
      ;; Load our frame from _wpk_fork_buf
      ;; - Bump current_pos down by our frame size
      ;; - Read func_index, call_index, catch_region_id, exnref_slot
      ;; - Read saved_locals into our locals
      ;; - If catch_region_id != 0, throw_ref (table.get $_wpk_fork_exnref_stash exnref_slot)
      ;;   (routes control into the relevant try_table's catch handler;
      ;;    catch handler's own state machine logic picks up from there)
    )
  )

  ;; --- State-machine wrap of the body ---
  ;; Every call to a fork-path function is wrapped as:
  ;;   (if (or (state == NORMAL)
  ;;           (and (state == REWINDING) (call_index_peek == N)))
  ;;     (then
  ;;       (... spill operand stack to synthetic locals ...)
  ;;       (call $callee)
  ;;       (if (state == UNWINDING) (goto unwind_save))
  ;;       (... restore operand stack ...)
  ;;     )
  ;;   )
  ;;
  ;; Non-call operations in the body are wrapped as:
  ;;   (if (state == NORMAL) (then (original operation)))
  ;; so that during rewind, side effects are not re-executed before
  ;; we reach the matching call site.

  (block $unwind_save
    <wrapped original body>
    (return)                 ;; normal-path return
  )

  ;; --- Unwind save ---
  ;; Save our frame to _wpk_fork_buf at current_pos:
  ;;   - Write func_index, call_index, catch_region_id, exnref_slot
  ;;   - Write all locals (spilling ref-typed ones to auxiliary tables)
  ;;   - Bump current_pos up by frame size
  (return <default-value-for-return-type>)
)
```

Per-call instrumentation uses `call_index` as a static integer
assigned left-to-right per function; the resume logic uses it to
determine which call to re-enter during rewind.

### 3.4 Mutable globals

At instrumentation time we scan the module's global section. Every
mutable global — `__stack_pointer`, `__tls_base`, and anything else the
source program declares — is recorded and saved in the buffer's
`saved_globals` area. On rewind, all are restored to their saved
values.

Tradeoff: we don't try to be selective. For programs that declare extra
mutable globals (LLVM's `-mmutable-globals`, C++ with some atomic
patterns), we pay a few bytes per global to save them. Negligible cost;
complete correctness.

Reference-typed globals (`(global (mut funcref))` etc.) cannot be
stored in linear memory. They are spilled to the appropriate auxiliary
table (see §3.5).

### 3.5 Reference-typed locals and globals

Three auxiliary tables are emitted into the instrumented module:

```
(table $_wpk_fork_funcref_stash   <initial-size> funcref)
(table $_wpk_fork_externref_stash <initial-size> externref)
(table $_wpk_fork_exnref_stash    <initial-size> (ref null exn))
```

Each instrumented function is pre-assigned a contiguous range of slots
in each table, corresponding to its reference-typed locals. The frame
header records the function's base slot index (to support
dynamically-grown tables in future; for v1 it's static per function).

On unwind, ref-typed locals are spilled via `table.set`. On rewind,
reloaded via `table.get`. Operand-stack values of ref types at call
sites are spilled to synthetic ref-typed *locals*, not tables — they're
scoped to the single call-site window.

Operand-stack values of scalar types (i32, i64, f32, f64, v128) are
spilled to synthetic scalar locals at each call-site window.

### 3.6 Catch-handler region support

The subtlest part of the design. `try_table` bodies are instrumented
like any other control-flow structure. Catch-handler code (the target
of a catch clause's branch) is *also* instrumented — closing the gap
that upstream Asyncify explicitly leaves open.

At instrumentation time, for each `try_table` on the fork path we:

1. Assign it a unique `catch_region_id` (a non-zero i32).
2. Wrap each catch clause's target block with a preamble that:
   - Captures the sent values (tag params + exnref for `catch_ref` /
     `catch_all_ref`) into scoped locals
   - Sets an injected i32 local `$_in_catch_N` to 1
   - (After handler body) sets it back to 0

At every instrumented call site, we read `$_in_catch_N` for any
enclosing try_table regions and record the innermost non-zero one in
the frame's `catch_region_id` field. If non-zero, the frame also
records an exnref stash slot (allocated per-call-site) and the unwind
path spills the active exnref to that slot.

On rewind, the function's preamble checks `catch_region_id`. If
non-zero:

1. Use the id to route control to the specific try_table's body
2. Immediately emit `throw_ref (table.get $_wpk_fork_exnref_stash slot)`
3. The enclosing try_table catches (matching the tag the exnref was
   thrown with); its catch clause branches into the handler
4. The handler body, instrumented with its own state-machine logic,
   sees `REWINDING` and continues to the original call site

#### Flow diagram (rewind of a fork caught-region case)

```
┌────────────────────────────────────────────────────────────────────┐
│ Parent execution (before fork)                                     │
│                                                                    │
│   main()                                                           │
│     ...                                                            │
│     try_table (catch $tag $dest):                                  │
│       callee_that_throws()         ← throws tag X                  │
│     (catch: $dest)                                                 │
│       handler_code                                                 │
│         fork()                     ← unwind begins here            │
│       more_handler_code                                            │
└────────────────────────────────────────────────────────────────────┘
                        │
                        │  unwind: save exnref X to stash,
                        │          record catch_region_id,
                        │          pop stack to top
                        ▼
┌────────────────────────────────────────────────────────────────────┐
│ Child instance created, memory copied, rewind begins               │
│                                                                    │
│   main() preamble:                                                 │
│     state == REWINDING, load our frame                             │
│     catch_region_id != 0:                                          │
│       route to try_table's body                                    │
│       throw_ref (saved exnref X)                                   │
│     ← caught by try_table's catch clause, control flows to $dest   │
│                                                                    │
│   handler preamble (instrumented):                                 │
│     state still REWINDING, load handler-level frame                │
│     resume at the fork() call site with return=0                   │
│                                                                    │
│   state := NORMAL, continue executing                              │
└────────────────────────────────────────────────────────────────────┘
```

### 3.7 Call-graph discovery

Before instrumenting any function, compute the set of functions that
can transitively reach the designated async import.

Algorithm:

1. Let `S` = { functions that directly call `kernel.kernel_fork` }.
2. **Direct-call closure**: for each function in the module, if it
   calls any function in `S`, add it to `S`. Repeat to fixpoint.
3. **Indirect-call closure**: for each `call_indirect` in any function
   currently in `S`:
   - Look up its type signature `T`
   - Find all functions `f` such that (a) `f`'s signature matches `T`,
     and (b) `f` appears in a function table (directly reachable via
     `call_indirect`)
   - Add each such `f` to `S`
4. Repeat steps 2–3 until fixpoint.

Output: the function-set `S`. All other functions are not instrumented
and retain their original shape.

Tradeoff: indirect-call closure is conservative (overestimates reach).
For programs using the indirect table extensively (setjmp lowering
uses it too), this may instrument more functions than strictly needed.
Still a strict subset of full-module instrumentation.

### 3.8 Operand-stack spilling at call sites

At each instrumented call site, walrus computes the operand-stack
types present at that program point. For each type on the stack below
the call's own arguments:

- Synthesize a local of that type (reused across sites where types
  match)
- Emit `local.set $spill_N` immediately before the call
- Emit `local.get $spill_N` immediately after the call

Effect: the operand stack is empty at the moment of the instrumented
call, so the unwind save / rewind load only need to track local
contents.

## 4. Implementation phases

See §3.1 of the originating design discussion. Each phase is a separate
PR to the `fierce-wire` branch. Phases gate on all tests passing and on
differential tests (see §5) agreeing with the Asyncify-built baseline.

| Phase | Scope |
|---|---|
| 1 | Skeleton crate + CLI, round-trip validation only |
| 2 | Direct-call graph discovery, output onlylist JSON |
| 3 | Indirect-call graph discovery |
| 4 | Core instrumentation (state machine, plain locals + globals, operand-stack spilling) |
| 5 | Reference-typed local spilling via tables |
| 6 | Catch-handler region tracking + exnref spill + rewind-throw |
| 7 | Production rollout: switch all build scripts, rename host exports, remove `asyncify-onlylist.txt` files, remove git's full-asyncify carve-out |

Rough schedule: 2–3 weeks of focused work total.

## 5. Test strategy

### 5.1 Unit tests (Rust, `crates/fork-instrument/tests/`)

Fixture-based: WAT input → instrumented WAT → compare against expected
output. One fixture per instrumentation case:

- Function with no calls (passes through)
- Function with one direct call to a seed function
- Function with nested expression requiring operand-stack spill
- Function with i64/f32/f64/v128 locals
- Function with funcref/externref/exnref locals
- Function with mutable globals
- Function containing try_table (body only, no catch reachable from fork)
- Function with catch handler reachable from fork (value-passing catch)
- Function with catch_ref clause
- Function with nested try_tables (inner catch reaches outer's exception)
- Function with call_indirect on fork path
- Function calling a non-fork-path function (should not be instrumented
  by callee, but call site is ordinary)

About 30–40 fixtures. Each fixture asserts the full instrumented
output, and an adjacent test runs the output through walrus's
validator to confirm it type-checks.

### 5.2 Integration tests (TypeScript, `host/test/fork-instrument.test.ts`)

Small C programs compiled with our SDK, instrumented with the new
tool, executed under the kernel. Each tests a specific fork-path
pattern:

- `fork_simple.c` — `main()` calls `fork()` directly
- `fork_deep.c` — fork at the bottom of a 5-deep call chain
- `fork_in_loop.c` — fork inside a loop
- `fork_with_locals.c` — every scalar type represented in locals
- `fork_with_setjmp.c` — setjmp/longjmp on the fork path (validates
  try_table handling from LLVM)
- `fork_after_throw.c` (C++) — fork inside a catch handler, validates
  catch-region rewind
- `fork_via_fnptr.c` — fork reached through a function pointer
  (call_indirect)
- `fork_nested_try.c` (C++) — nested try/catch with fork in inner
  handler

### 5.3 Differential testing

For the transition period, build each test program *both ways*
(Asyncify and fork-instrument). Run the same kernel-level fork test
against both. Outputs must agree exactly (stdout, stderr, exit codes,
final linear-memory state of a few documented addresses). Catches
regressions the above two layers miss.

### 5.4 Fuzzing for Phase 6

Catch-handler resume is the highest-risk correctness item. In addition
to fixtures, add a fuzz harness that:

- Generates small random WAT programs with try_table + catch_ref
  constructs on a fork path
- For each, runs: compile → instrument → validate
- For a subset, instantiates and runs both pre- and post-instrument in
  a test harness, asserting observable equivalence on non-fork paths

Use `cargo fuzz` or `arbitrary` + `proptest` (walrus's validator
catches ill-formed outputs; we're fuzzing for semantic divergence, not
crash resistance). Target ≥ 10,000 iterations with zero validator
failures before Phase 6 is considered shippable.

### 5.5 Full regression suite

Every phase ends gated on all existing test suites green:

1. `cargo test -p wasm-posix-kernel --target aarch64-apple-darwin --lib`
2. `cd host && npx vitest run`
3. `scripts/run-libc-tests.sh`
4. `scripts/run-posix-tests.sh`
5. `scripts/run-sortix-tests.sh --all`
6. `bash scripts/check-abi-version.sh`

In Phase 7 additionally:

7. Browser demos manually verified: shell, mariadb, nginx-php,
   wordpress (fork paths exercised by each)
8. `benchmarks/run.ts --rounds=3` on Node + browser, comparing before
   and after switchover. Fork-heavy suites (wordpress, erlang-ring,
   process-lifecycle) expected within ±3% baseline; any larger
   regression investigated before merge.

## 6. Documentation deliverables

Produced alongside code, not after:

- `docs/fork-instrumentation.md` — *the* reference. Byte-level save
  buffer format, state machine, exported ABI, instrumentation transform
  shown as WAT before/after pairs, guarantees and non-guarantees,
  performance envelope. Kept current across phases.
- `docs/architecture.md` — update fork section to reference the tool.
- `docs/porting-guide.md` — update compile flow: no more
  `asyncify-onlylist.txt`, no more `--asyncify-imports` flag.
- `docs/posix-status.md` — add entry: `makecontext`/`swapcontext`/
  `getcontext`/`setcontext` → **unsupported** (not on any roadmap), link
  to this design doc's non-goals section.
- `docs/abi-versioning.md` — add the save-buffer format to the list of
  ABI-versioned items (any layout change requires `ABI_VERSION` bump).
- `CLAUDE.md` — remove the asyncify-onlylist preference note, add a
  brief note about `wasm-fork-instrument`.
- `crates/fork-instrument/README.md` — tool-level docs: CLI usage,
  expected inputs, outputs, error modes.
- Code-level comments in `crates/fork-instrument/src/` — each
  instrumentation step annotated with the rationale, not just the what.

## 7. Tradeoffs and open questions

### 7.1 Performance

Asyncify measures ~5–10% overhead on fork-path hot paths. We should
match or beat that because we skip Flatten's extra local-shuffling
step. Worst realistic case: indirect-call closure over-instruments,
bringing more functions into the state machine than needed.

Mitigation: Phase 7 gate includes benchmark diff; any regression >3%
triggers investigation before the legacy path is removed.

### 7.2 Binary size

Fork-path instrumentation adds code: state-machine wrappers, frame
save/restore, preambles. Rough estimate: +5–15% for instrumented
functions; ~2–5% total module size if onlylist is well-scoped. For
git, this will be *smaller* than the current full-asyncify carve-out.

### 7.3 Upstream relationship

The Binaryen patch we've already written (accepts `try_table` /
`throw_ref` without crashing Asyncify) remains useful to the upstream
community — it's ~60 lines, fixes a real crash, solves a problem for
anyone else attempting Asyncify + new-EH. Proposal: still upstream it
as a separable contribution, independent of our tool's development.
Once merged, remove the `third_party/binaryen` submodule from our
repo; we don't need Binaryen at build time anymore (any stock
`wasm-opt` suffices for optional post-optimization).

### 7.4 Correctness risk: catch-handler resume

Phase 6 is the highest-risk piece. The throw_ref-during-rewind approach
has not been proven in any shipping implementation we know of. Fuzzing
(§5.4) is the mitigation; if fuzzing surfaces correctness issues we
cannot resolve, we fall back to a weaker guarantee (document
"fork-from-catch-handler unsupported" and reject it at instrumentation
time). Phase 6 is gated on fuzzing clean.

### 7.5 Schedule risk

Estimates assume walrus's IR supports everything we need (it does, per
docs; unverified in anger). Biggest unknown: walrus's validator against
the specific shapes we emit for catch-handler rewind. Phase 1 is
partly a validation of this assumption — if walrus proves inadequate,
we have a choice to make (contribute missing pieces to walrus, or
drop to wasmparser/wasm-encoder directly for IR manipulation).

## 8. Success criteria

1. All existing fork-using programs (bash, dash, vim, nginx, mariadb,
   git, tcl, sqlite, ruby, quickjs, erlang, php) build and run under
   the new tool, passing our full test matrix.
2. Git no longer requires full-module instrumentation.
3. The `third_party/binaryen` submodule is removed from our build.
4. `-wasm-use-legacy-eh=true` is removed from `sdk/src/lib/flags.ts`
   and all scripts. V8's try-instruction deprecation warning is gone
   from browser demos.
5. Binary size and benchmark performance are within ±3% of the
   Asyncify baseline (or better).
6. Documentation in `docs/fork-instrumentation.md` is complete,
   current, and reviewed.

## 9. Falsification / abort criteria

We abort the project (reverting cleanly to the existing Asyncify path,
keeping the small Binaryen PR as our sole improvement) if any of the
following happen:

- walrus's IR cannot express the instrumentation cleanly and the
  workaround (dropping to wasmparser) would be of similar scope to
  just patching Flatten in Binaryen
- Phase 6 fuzzing finds a class of correctness bugs we cannot solve
  in catch-handler resume (and we decide not to narrow scope by
  rejecting that case)
- Performance regression exceeds ±5% and we cannot reduce it

We commit to deciding at the end of Phase 4 whether to continue to
Phases 5–6. That's the "is the core working?" checkpoint.
