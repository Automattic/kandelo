# Fork Instrumentation

`wasm-fork-instrument` is an in-tree Rust tool that rewrites wasm user-program
binaries with save/restore machinery so POSIX `fork()` works. The tool source
lives at [`crates/fork-instrument/`](../crates/fork-instrument/); `bash build.sh`
compiles a host binary and installs it to `tools/bin/wasm-fork-instrument`. Every
build script that targets a fork-using program invokes the tool after linking —
there is no longer a `wasm-opt --asyncify` pass in the pipeline, and the
`third_party/binaryen` submodule has been removed. This document is the
living reference for the tool's behavior, exported ABI, and save-buffer format.
For motivation, tradeoffs, and the rollout plan that led here, read
[`plans/2026-04-20-fork-instrumentation-design.md`](plans/2026-04-20-fork-instrumentation-design.md).

## State machine

Every instrumented module carries a single mutable i32 global, `_wpk_fork_state`,
and one mutable pointer global, `_wpk_fork_buf` (i32 for wasm32 programs, i64
for wasm64). The pointer is zero while the state is `NORMAL` and holds the
address of the active save buffer otherwise.

```
                   wpk_fork_unwind_begin(buf)
     ┌─────────────────────────────────────────────────────────┐
     │                                                          ▼
┌────┴──────┐  wpk_fork_unwind_end()   ┌─────────────┐
│  NORMAL   │ ◀──────────────────────  │  UNWINDING  │
│  state=0  │                          │  state=1    │
│  buf=0    │  wpk_fork_rewind_begin   └─────────────┘
│           │  ─────────────────────▶  ┌─────────────┐
│           │  wpk_fork_rewind_end()   │  REWINDING  │
└───────────┘ ◀──────────────────────  │  state=2    │
                                       └─────────────┘
```

- `NORMAL` — ordinary execution. Side-effect-gated ops run normally.
- `UNWINDING` — the stack is being torn down. Each instrumented function runs
  its postamble, writes a frame into the save buffer, and returns a default
  value; the runtime-exported `wpk_fork_unwind_end` is called once the top of
  the stack is reached.
- `REWINDING` — the stack is being rebuilt from saved frames. Each
  instrumented function loads its frame and jumps straight to the matching
  call site; non-call side effects are suppressed until state returns to
  `NORMAL`.

The host drives the state machine externally. User code never writes to
`_wpk_fork_state` directly.

## Exported ABI

The tool injects five exports into every instrumented module. Names are
exact — they are part of the kernel ABI and tracked by the snapshot check
(see [abi-versioning.md](abi-versioning.md)).

```
wpk_fork_unwind_begin(buf: ptr) -> ()
  Precondition:  state == NORMAL
  Postcondition: state := UNWINDING
                 _wpk_fork_buf := buf
                 *(buf + 0) := frames_start_offset   (self-initialized)
                 All mutable scalar globals snapshotted into buf.

wpk_fork_unwind_end() -> ()
  Precondition:  state == UNWINDING and all frames have been drained.
  Postcondition: state := NORMAL

wpk_fork_rewind_begin(buf: ptr) -> ()
  Precondition:  state == NORMAL (in a freshly-instantiated child)
  Postcondition: state := REWINDING
                 _wpk_fork_buf := buf
                 All saved mutable scalar globals restored from buf.

wpk_fork_rewind_end() -> ()
  Precondition:  state == REWINDING and all frames have been reloaded.
  Postcondition: state := NORMAL

wpk_fork_state() -> i32
  Returns current state. Exported for host-side assertions.
```

`ptr` is `i32` on wasm32 user programs and `i64` on wasm64 user programs. The
tool picks the pointer width from the module's primary memory — a memory64
memory yields `i64`, anything else yields `i32`.

Important Phase 7 behavior: `wpk_fork_unwind_begin` self-initializes
`*(buf + 0)` with the correct `frames_start_offset` value before touching any
user state. The host does **not** need to pre-seed the buffer header — it only
needs to allocate a buffer at least as large as the instrumented module's
`frames_start_offset` plus its worst-case frame-data footprint.

## Save buffer format

All offsets are byte-exact, all values little-endian. `P` is pointer width
(4 on wasm32, 8 on wasm64). `N` is the total byte size of the module's saved
scalar globals — fixed per module at instrument time.

| Offset     | Size | Field                 | Purpose                                |
|------------|------|-----------------------|----------------------------------------|
| `+0`       | `P`  | `current_pos`         | Next free byte for frame data          |
| `+P`       | `P`  | `end_pos`             | Reserved; not read or written today    |
| `+2P`      | `N`  | `saved_globals[]`     | Mutable scalar globals, decl. order    |
| `+2P + N`  | var  | frame data            | Frames grow upward from here           |

`frames_start_offset = 2P + N`. It is exposed as metadata on the tool's
internal `Runtime` struct, and `wpk_fork_unwind_begin` writes it into
`*(buf + 0)` on every invocation.

For wasm32 (`P = 4`) with a module that declares three additional scalar
mutable globals totaling 16 bytes (e.g. `__stack_pointer`, `__tls_base`, one
user i64):

```
+0    4    current_pos
+4    4    end_pos                (reserved)
+8    4    saved __stack_pointer  (i32)
+12   4    saved __tls_base       (i32)
+16   8    saved user i64 global
+24        frames start here
```

Ref-typed mutable globals (`funcref` / `externref` / `exnref`) are not stored
in the linear-memory header — they would need aux-table spill slots, which is
a future extension. The tool currently ignores them when snapshotting globals.

## Frame format

Each instrumented function reserves a fixed-size frame. The size depends on
how many scalar user locals the function has, but the header is uniform.

| Offset | Size | Field             | Purpose                                  |
|--------|------|-------------------|------------------------------------------|
| `+0`   | 4    | `func_index`      | Ordinal assigned at instrument time      |
| `+4`   | 4    | `call_index`      | Which call site within the function      |
| `+8`   | 4    | `catch_region_id` | 0 in normal flow; non-zero for catches   |
| `+12`  | 4    | `exnref_slot`     | Valid when `catch_region_id != 0`        |
| `+16`  | var  | `saved_locals[]`  | Scalar user locals, natural-aligned      |

Ref-typed user locals (funcref, externref, exnref) do **not** appear in this
frame. They are spilled to auxiliary tables — see [Auxiliary
tables](#auxiliary-tables) below. The frame only records the ordinal identity
of the function and its call-site, which together with the ref-table slot
assignment is sufficient to restore the ref-typed locals during rewind.

`catch_region_id` is zero in the common case (the frame was captured outside
any catch handler). When non-zero, it identifies the `try_table` whose catch
handler the frame lives in, and `exnref_slot` points at the `_wpk_fork_exnref_stash`
table slot that holds the caught exnref. The rewind preamble uses both fields
to route control back through the original catch clause — see [Catch-handler
resume](#catch-handler-resume).

## Per-function transform — before/after WAT

The tool applies a uniform transform to every function on the fork-path. The
following pairs show representative fixtures from
`crates/fork-instrument/tests/instrument.rs`. The transformed WAT is simplified
for readability; the actual output includes `current_pos` bumping, default
values for result types, and preserved source locations.

### (a) Direct call to `fork` with no locals

Fixture: `FIXTURE_DIRECT_CALLER` in `tests/instrument.rs` (see
`wrapper_replaces_call_with_state_gated_if`). Before instrumentation:

```wat
(func $caller (result i32)
  call $fork)
```

After instrumentation (abridged):

```wat
(func $caller (result i32)
  ;; [1] Preamble: if REWINDING, load our frame and jump to matching call.
  (if (i32.eq (global.get $_wpk_fork_state) (i32.const 2 (; REWINDING ;)))
    (then
      ;; Load frame header + locals from buf; set $call_idx_local.
      ...))

  ;; [2] Body wrapper: runs on NORMAL, and on REWINDING only when
  ;;     call_idx matches the target call site.
  (block $unwind_save
    (if (i32.or
          (i32.eq (global.get $_wpk_fork_state) (i32.const 0 (; NORMAL ;)))
          (i32.and
            (i32.eq (global.get $_wpk_fork_state) (i32.const 2 (; REWINDING ;)))
            (i32.eq (local.get $call_idx_local) (i32.const 0))))
      (then
        ;; [3] Wrapped call site.
        call $fork
        (local.set $call_idx_local (i32.const 0))
        ;; [4] Post-call unwind check: if callee returned in UNWINDING
        ;;     state, skip the rest of the body and jump to postamble.
        (br_if $unwind_save
          (i32.eq (global.get $_wpk_fork_state) (i32.const 1 (; UNWINDING ;))))
      )
      (else
        ;; Supply default values for the call's result types so the
        ;; wrapper typechecks; never reached on NORMAL.
        (i32.const 0)))
    (return))

  ;; [5] Postamble: write frame header, serialize locals, bump current_pos,
  ;;     then return a default value for the function's result type.
  ...
  (return (i32.const 0)))
```

Numbered callouts:

1. **Preamble (Phase 4d).** Every instrumented function opens with a state
   test. Under `REWINDING`, the preamble reads `current_pos`, locates the
   frame at `current_pos - frame_size`, loads the header into synthetic
   locals, and deserializes each scalar user local.
2. **Body wrapper (Phase 4b/4c).** The original body is wrapped in a `$unwind_save`
   block. The if-gate condition lets the body run under `NORMAL`, and also
   under `REWINDING` when the per-function `$call_idx_local` matches the
   index baked into this call site.
3. **Wrapped call site (Phase 4c).** The original call is kept intact. After
   the call returns, the tool writes `call_index` into `$call_idx_local`.
4. **Unwind bridge (Phase 4c/4d).** A `br_if $unwind_save` checks the state
   global. If the callee began unwinding, control jumps past the rest of the
   body directly to the postamble.
5. **Postamble (Phase 4d).** Emits the frame header (func_index, call_index,
   catch_region_id, exnref_slot), writes each scalar user local, bumps
   `*(buf + 0)` by the frame size, and returns a default value of the
   function's result type. Callers see the default on the unwind path but
   discard it because their own postamble runs next.

### (b) Fork from inside a catch handler

Fixture: `FIXTURE_FORK_FROM_CATCH_HANDLER` (see
`fork_from_inside_catch_handler_full_roundtrip`). Before instrumentation:

```wat
(func $caller (result i32)
  (block $handler (result (ref null exn))
    (try_table (result (ref null exn)) (catch_ref $exn $handler)
      ref.null exn))
  drop
  call $fork)
```

After instrumentation the try_table clause gets wrapped in two injected
blocks, `$outer` and `$capture`, and the try_table body gets a rewind-throw
stub prepended:

```wat
(block $outer (result (ref null exn))
  (block $capture (result (ref null exn) exnref)
    (try_table (result (ref null exn)) (catch_ref $exn $capture)
      ;; [6c] Rewind-throw stub: executed lexically first on every entry.
      (if (i32.and
            (i32.eq (global.get $_wpk_fork_state) (i32.const 2))
            (i32.eq (local.get $catch_region_id_local) (i32.const 1)))
        (then
          ;; Resume into this try_table's catch handler by re-throwing
          ;; the saved exnref.
          (throw_ref
            (ref.as_non_null
              (table.get $_wpk_fork_exnref_stash
                (local.get $exnref_slot_local))))))

      ;; Original try_table body.
      (ref.null exn)))

  ;; [6d] On catch_ref dispatch, stack = (ref null exn, exnref).
  (local.tee $captured_exnref_1)
  (local.set $in_catch_1 (i32.const 1))
  (table.set $_wpk_fork_exnref_stash
    (i32.const 0 (; slot ;))
    (local.get $captured_exnref_1))
  (br $outer))   ;; fall through to the original handler continuation
```

Numbered callouts:

- **6c — Rewind-throw stub.** Prepended to every fork-path try_table body.
  On `REWINDING` with a matching `catch_region_id`, it re-throws the saved
  exnref using `throw_ref`. The try_table's own catch clause catches it,
  which dispatches into `$capture` exactly as if the original exception had
  been thrown by the body.
- **6d — Capture block.** The tool rewrites every `catch_ref` / `catch_all_ref`
  clause to target an injected `$capture` block rather than the user's
  original handler. `$capture` stashes the exnref into
  `_wpk_fork_exnref_stash`, sets the `$in_catch_K` flag, then unconditionally
  branches to `$outer`, which is the block the user's original handler falls
  through from. The net effect: the user's handler code runs with the exnref
  already stashed and `in_catch_K == 1`, ready for a later fork call to
  record it.
- **6e — Call-site region writes.** Any call site inside the handler
  observes `$in_catch_K == 1` and writes the active region's id and exnref
  slot into `$catch_region_id_local` / `$exnref_slot_local` before the
  `br_if $unwind_save`, so the frame carries the handler identity into the
  save buffer.

### (c) Indirect fork through `call_indirect`

Fixture: `FIXTURE_INDIRECT` (see `call_indirect_is_wrapped_with_index_as_top_arg`).
Before instrumentation:

```wat
(func $caller (result i32)
  i32.const 0
  call_indirect (type $sig))
```

After instrumentation the wrapper shape is identical to the direct-call case,
with one addition: the table index is spilled to a synthetic local before the
state-check condition runs, and restored inside the then-branch immediately
before the `call_indirect`.

```wat
(func $caller (result i32)
  ;; ... preamble ...
  (block $unwind_save
    (i32.const 0)                 ;; original table index expression
    (local.set $arg_idx_0)        ;; [3a] spill arg before gate
    (if (<state-gate condition>)
      (then
        (local.get $arg_idx_0)    ;; [3b] restore arg before call
        (call_indirect (type $sig))
        (local.set $call_idx_local (i32.const 0))
        (br_if $unwind_save (<unwinding check>)))
      (else
        (i32.const 0)))           ;; default i32 for the call's result
    (return))
  ;; ... postamble ...)
```

Callouts:

- **Phase 3 closure.** Before instrumentation runs at all, call-graph
  discovery walks every `call_indirect` reachable from the fork seed, looks
  up the call's type signature, and adds every table-reachable function with
  a matching signature to the fork-path set. The wrapper sees indirect calls
  with the same shape as direct calls: one additional top-of-stack i32 arg
  (the table index) on the wasm32 side.
- **3a / 3b — Arg spill.** All call-site arguments (including the indirect
  table index) are spilled to synthetic scalar locals before the gate
  condition runs, so the operand stack is empty at the gate boundary and the
  else-branch can supply typed defaults.

## Auxiliary tables

When the module has at least one fork-path ref-typed user local of a given
class, the tool emits a per-class stash table:

```
(table $_wpk_fork_funcref_stash   <n_funcref>   funcref)
(table $_wpk_fork_externref_stash <n_externref> externref)
(table $_wpk_fork_exnref_stash    <n_exnref>    (ref null exn))
```

Modules with no ref-typed fork-path locals of a given class emit no table for
that class. A module with no fork-path try_tables and no fork-path ref-typed
locals emits zero aux tables.

Slot assignment is per-class and contiguous:

- The tool walks the fork-path functions in deterministic order.
- For each function, each ref-typed user local gets the next slot in its
  class's table.
- For each fork-path `try_table`, the exnref class additionally reserves one
  slot to hold the currently-caught exnref while a handler runs.

Each table's `initial` size is set to exactly the assigned slot count so the
cost is bounded. Slot indices are baked into the postamble (as `table.set`)
and preamble (as `table.get`) of the owning function, and into the `$capture`
blocks emitted for fork-path `catch_ref` / `catch_all_ref` clauses.

Scalar operand-stack values at call sites are spilled to synthetic scalar
locals, not tables — they are scoped to a single call-site window and do not
cross the unwind/rewind boundary.

## Catch-handler resume

Catch-handler resume is the subtlest piece of the tool. The overall idea:
at unwind time, save the caught exnref into the stash table and record the
try_table's `catch_region_id` in the frame. At rewind time, re-throw the
saved exnref *from inside the same try_table body*, so the normal wasm
exception-dispatch rules deliver it back to the original catch clause, which
sends control into the handler — whose own state-machine preamble then
continues to the fork call site.

```
┌────────────────────────────────────────────────────────────────────┐
│ Parent execution (before fork)                                     │
│                                                                    │
│   try_table (catch_ref $tag $handler):                             │
│     callee_that_throws()                   ← throws tag X          │
│   → $handler                                                       │
│     handler_code                                                   │
│       fork()                               ← unwind begins here    │
│       more_handler_code                                            │
└────────────────────────────────────────────────────────────────────┘
                        │
                        │  unwind: save exnref X to stash,
                        │          frame.catch_region_id = K,
                        │          frame.exnref_slot = S,
                        │          drain frames to top.
                        ▼
┌────────────────────────────────────────────────────────────────────┐
│ Child instance created, memory copied, rewind begins               │
│                                                                    │
│   main() preamble:                                                 │
│     state == REWINDING, load our frame                             │
│                                                                    │
│   try_table body rewind-throw stub:                                │
│     state == REWINDING && catch_region_id == K →                   │
│       throw_ref (table.get $_wpk_fork_exnref_stash S)              │
│     ← caught by try_table's own catch clause, dispatches to        │
│       the $capture block; $capture branches to $outer, placing     │
│       control at the top of the user's handler code.               │
│                                                                    │
│   handler-level preamble (state still REWINDING):                  │
│     resume at the fork() call site with return value = child pid 0 │
│                                                                    │
│   state := NORMAL, execution continues                             │
└────────────────────────────────────────────────────────────────────┘
```

Only `catch_ref` and `catch_all_ref` clauses can drive this mechanism — a
plain `catch` clause has no exnref to stash. Fork paths through plain-catch
handlers are tracked as a future extension (see [Non-guarantees](#guarantees-and-non-guarantees)).

## Call-graph discovery

Instrumentation only rewrites functions that can transitively reach the
designated async import (default: `kernel.kernel_fork`). The discovery
algorithm in `crates/fork-instrument/src/call_graph.rs`:

1. Seed set `S` = { functions that directly call `kernel.kernel_fork` }.
2. **Direct-call closure.** For every function `f` in the module: if `f`
   calls any function in `S`, add `f` to `S`. Iterate to a fixpoint.
3. **Indirect-call closure.** For every `call_indirect` in a function
   already in `S`, look up its type signature `T`. Add every function
   reachable through a function table whose signature matches `T` to `S`.
4. Repeat steps 2–3 until nothing changes.

The output is a function-set `S` that gets instrumented. All other functions
pass through unmodified.

The indirect-call step is conservative — a `call_indirect` gets closed over
every signature-matching function in a reachable table. For programs that
use the indirect table extensively (LLVM's setjmp lowering does, for
instance) this can instrument more than strictly needed, but never less. The
closure is still a strict subset of full-module instrumentation.

## Guarantees and non-guarantees

### Guaranteed

- **Call stack.** Every fork-path function's call stack position is
  serialized as a frame (func_index + call_index) and reconstructed during
  rewind. The child resumes at the exact call site from which the parent
  invoked `fork()`.
- **Scalar user locals.** All i32, i64, f32, f64, and v128 locals on the
  fork-path are saved to linear memory at unwind and restored at rewind.
- **Ref-typed user locals.** funcref, externref, and exnref locals are
  spilled to aux tables at unwind and restored at rewind. Slot assignments
  are deterministic per module.
- **Mutable scalar globals.** Snapshotted in
  `wpk_fork_unwind_begin` and restored in `wpk_fork_rewind_begin`.
  Includes `__stack_pointer`, `__tls_base`, and any program-declared
  mutable globals.
- **try_table context.** Frames captured inside a fork-path catch handler
  carry the active `catch_region_id` and exnref stash slot, and rewind
  re-enters the handler via `throw_ref` (Phase 6).

### Not guaranteed (unsupported patterns)

- **`makecontext` / `swapcontext` / `getcontext` / `setcontext`.** Userspace
  stack-switching primitives are unsupported and not on any roadmap. See
  [posix-status.md](posix-status.md) for rationale.
- **Fork-from-catch through a plain `catch` clause.** The rewind-throw
  mechanism relies on an exnref being available; plain (non-`_ref`) catch
  clauses do not carry one. Fork from inside such a handler will trap on
  rewind with an empty stash. Tracked outside the repo as follow-up B1 —
  see `memory/fork-instrument-b1-followup.md` (external memory file).
- **Multi-target `*_ref` try_tables.** A try_table with multiple `catch_ref`
  or `catch_all_ref` clauses dispatching to different handlers is currently
  skipped at the 6d rewrite stage. No shipping program has forced the issue;
  support can be added when needed.
- **Wasm-GC refs.** Abstract `any` / `eq` / `struct` / `array` / `i31` refs
  and concrete GC refs are rejected at the `classify_ref` step — the tool
  panics rather than produce a silently-broken module. Add classes in
  `crates/fork-instrument/src/instrument.rs` when a real program needs them.

### Not-yet-gated side effects

Phase 4g gates the common side-effect instructions on the fork path so they
are skipped during rewind. Instructions currently gated:
`local.set`, `local.tee`, `global.set`, `store` (all widths),
`memory.grow`, `memory.fill`, `memory.copy`, `memory.init`, `data.drop`,
`elem.drop`, `table.set`.

Not currently gated (open work; a program that relies on them during rewind
may misbehave): atomic RMW, `atomic.notify`, `throw` / `throw_ref` outside
instrumented regions, `table.grow`, `table.fill`, `table.init`, `table.copy`.

## Performance envelope

The Phase 7 acceptance gate is ±3% of the Asyncify baseline on fork-heavy
benchmark suites, measured with `npx tsx benchmarks/run.ts --rounds=3` on
both the Node.js host and the browser host. The suites that exercise fork
meaningfully are `wordpress`, `erlang-ring`, and `process-lifecycle`.

For the concrete numbers landed by the Phase 7 rollout PR, see Task 15 of
`docs/plans/2026-04-21-fork-instrument-phase-7-rollout-plan.md`. Binary size
for fork-heavy programs is expected to be equal or smaller than under the
prior full-asyncify carve-out (most notably git), since the tool instruments
a tighter reachable set.

## Maintainer notes

### Running tests

Unit tests live in `crates/fork-instrument/tests/`. The default cargo target
in this workspace is `wasm64-unknown-unknown` (from `.cargo/config.toml`),
which cannot build host tests — always pass the explicit host target:

```bash
cargo test -p fork-instrument --target aarch64-apple-darwin
```

### Running the fuzz gate

Phase 6 catch-handler resume was validated with a random-WAT fuzzer that
generates try_table programs on a fork path and asserts both walrus and
wasmparser accept the instrumented output.

```bash
scripts/run-fork-instrument-fuzz.sh                 # default 10 000 iters
FUZZ_RUNS=50000 scripts/run-fork-instrument-fuzz.sh # longer run
```

The script passes `--sanitizer=none` to `cargo fuzz`. On macOS arm64,
cargo-fuzz's default AddressSanitizer deadlocks during init (the malloc
interceptor recurses into ASAN init which holds a spin mutex). The fuzzer
targets validator/semantic divergence rather than memory-safety, so ASAN is
not load-bearing.

### Adding a new ref type

Ref types accepted for local / global spilling are gated by `classify_ref`
in `crates/fork-instrument/src/instrument.rs`. To add support for a new
class:

1. Extend the `RefClass` enum with the new class.
2. Map the corresponding `HeapType` variant in `classify_ref` to the new
   class.
3. If the new class cannot share an existing stash table (e.g. it is a
   wasm-GC ref that requires `ref.cast` at reload time), add a new table to
   `AuxTables`, size it the same way the existing classes do, and extend
   the spill / reload emitters to target it.
4. Add a fixture test under `tests/instrument.rs` that exercises the new
   type both as a local and as a function parameter, and confirms the
   module validates after round-tripping through the tool.

### Extending side-effect gating

Phase 4g's list of gated instructions lives in `side_effect_shape` in
`crates/fork-instrument/src/instrument.rs`. To gate a new opcode:

1. Add a match arm in `side_effect_shape` that returns the instruction's
   stack-effect shape (parameter types and result types).
2. The existing `emit_gated_side_effect` helper handles the rest — it wraps
   the instruction in an if-else on the state global, runs the instruction
   in the then branch, and drops the inputs / supplies default outputs in
   the else branch.
3. Add a fixture test under `tests/instrument.rs` that confirms the
   instruction appears inside a NORMAL gate in the instrumented output.

### Extending for fork-from-plain-catch

Follow-up B1 (tracked outside the repo at
`memory/fork-instrument-b1-followup.md`) covers the case of `fork()` from
inside a plain-catch handler. The staged plan there introduces tag-by-tag
stashes and synthesizes an exnref from the tag payload at unwind time so the
rewind-throw mechanism applies uniformly. It is deferred post-Phase 7 and
will be picked up when a hosted program forces the issue.

## See also

- [architecture.md](architecture.md) — overall kernel / host / user-program
  separation.
- [abi-versioning.md](abi-versioning.md) — why the `wpk_fork_*` export names
  and save-buffer layout are covered by `ABI_VERSION`.
- [posix-status.md](posix-status.md) — per-syscall support, including the
  `ucontext` family's unsupported status.
- [porting-guide.md](porting-guide.md) — how to compile programs against the
  SDK; `wasm-fork-instrument` is invoked automatically by build scripts.
- [`plans/2026-04-20-fork-instrumentation-design.md`](plans/2026-04-20-fork-instrumentation-design.md)
  — the originating design discussion, including alternatives considered.
