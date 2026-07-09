# Fork Instrumentation

`wasm-fork-instrument` is an in-tree Rust tool that rewrites wasm user-program
binaries with save/restore machinery so POSIX `fork()` works. The tool source
lives at [`crates/fork-instrument/`](../crates/fork-instrument/).
Build scripts and tests should invoke
[`scripts/run-wasm-fork-instrument.sh`](../scripts/run-wasm-fork-instrument.sh),
which uses `tools/bin/wasm-fork-instrument` when present and otherwise builds
the tool from Cargo on demand. Every build script that targets a fork-using
program invokes the tool after linking. Asyncify is not an active implementation
path: do not use `wasm-opt --asyncify`, do not accept `asyncify_*` exports, and
do not add Asyncify compatibility fallbacks. This document is the
living reference for the tool's behavior, exported ABI, and save-buffer format.
For motivation, tradeoffs, and the rollout plan that led here, read
[`plans/2026-04-20-fork-instrumentation-design.md`](plans/2026-04-20-fork-instrumentation-design.md);
for the post-rollout switch-dispatch redesign and non-fork-path-call gating
that fix the kernel-side-effect re-fire bug, read
[`plans/2026-04-22-fork-instrument-switch-dispatch-redesign.md`](plans/2026-04-22-fork-instrument-switch-dispatch-redesign.md).
ABI version: `12` (see
[`crates/shared/src/lib.rs`](../crates/shared/src/lib.rs) — see
[abi-versioning.md](abi-versioning.md) for the policy).

## Policy

- `wasm-fork-instrument` is mandatory for any program that performs `fork()` or
  fork-like operations. That includes `fork()`, `vfork()`, `_Fork()`, shell
  pipelines, command substitution, `system()`, `popen()`, and fork-backed helper
  processes.
- Missing instrumentation is a build/runtime error, not an optional feature
  loss. A fork-using program without complete `wpk_fork_*` exports cannot
  resume the child at the fork call site.
- Binaries exporting legacy `asyncify_*` symbols are stale and must be rebuilt.
  Do not add host support for them.
- Do not keep compiler/linker flags solely for the retired legacy path. The
  fork instrumenter does not require preserved function names or onlylists; if
  a build keeps debug-info flags, it should be for a current diagnostic reason.

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

- `NORMAL` — ordinary execution. Gated ops and gated calls run normally.
- `UNWINDING` — the stack is being torn down. Each instrumented function runs
  its postamble, writes a frame into the save buffer, and returns a default
  value; the runtime-exported `wpk_fork_unwind_end` is called once the top of
  the stack is reached.
- `REWINDING` — the stack is being rebuilt from saved frames. Each
  instrumented function loads its frame and jumps straight to the matching
  call site via switch-dispatch. Body chunks before the chosen post-call
  landing are skipped, so non-fork-path calls and side-effecting operations
  in those chunks do not re-run.

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

## Host Threading Contract

The save buffer belongs to the channel that issued `SYS_FORK`. For a main-thread
fork this is the process worker's channel, and the child enters `_start` before
`wpk_fork_rewind_begin` replays to the saved call site.

For `fork()` from a pthread worker, the host must preserve the pthread entry
context as well as the buffer:

- `CentralizedKernelWorker.addChannel(pid, offset, tid, fnPtr, argPtr)` records
  the pthread entry table index and userdata for each thread channel.
- `centralizedThreadWorkerMain` overrides `kernel_fork` for instrumented modules
  and drives `wpk_fork_unwind_begin` / `wpk_fork_state` /
  `wpk_fork_rewind_begin` around the pthread function, using
  `channelOffset - FORK_BUF_SIZE` as that thread's save buffer.
- `handleFork` passes a `ForkFromThreadContext` through the host `onFork`
  callback. Node and browser hosts copy `forkBufAddr`, `fnPtr`, and `argPtr`
  into the child init message.
- The same context carries the caller's exact dynamic pthread slot range
  (`slotStart`, `slotLen`). After the kernel clones the child process state,
  the host calls `kernel_reserve_host_region_at(childPid, slotStart, slotLen)`
  so the child retains only the calling thread's copied TLS/fork-save/channel
  pages.
- A fork child created from a pthread enters the saved pthread function from the
  indirect-function table instead of `_start`, then starts REWIND from the
  thread's copied buffer. `_start` is not in that call chain and cannot reach
  the saved fork site.

The child does not inherit every parent pthread reservation. POSIX fork resumes
only the calling thread, so dead parent pthread slots become ordinary copied
memory bytes in the child and can be reused by later child `brk`, `mmap`, or
`pthread_create()` activity. Retaining the caller's one slot avoids having to
move the saved `__tls_base`, thread-local state, and fork-save buffer during
rewind.

This path is covered by `host/test/fork-instrument-coverage.test.ts` P-06
(`pthread_create` worker calls `fork`) and K-03 (`pthread_cleanup_push` handler
calls `fork`).

## Save buffer format

All offsets are byte-exact, all values little-endian. `P` is pointer width
(4 on wasm32, 8 on wasm64). `N` is the total byte size of the module's saved
scalar globals — fixed per module at instrument time. `B` is the total byte
size of the B1 plain-catch scratch region, fixed per module at instrument
time and 0 in modules that do not contain plain-catch capture sites.

| Offset            | Size | Field                 | Purpose                                |
|-------------------|------|-----------------------|----------------------------------------|
| `+0`              | `P`  | `current_pos`         | Next free byte for frame data          |
| `+P`              | `P`  | `end_pos`             | Reserved; not read or written today    |
| `+2P`             | `N`  | `saved_globals[]`     | Mutable scalar globals, decl. order    |
| `+2P + N`         | `B`  | `b1_scratch[]`        | Plain-catch operand stash (see B1)     |
| `+2P + N + B`     | var  | frame data            | Frames grow upward from here           |

`frames_start_offset = 2P + N + B`. It is exposed as metadata on the tool's
internal `Runtime` struct, and `wpk_fork_unwind_begin` writes it into
`*(buf + 0)` on every invocation.

`current_pos` is a **buffer-relative byte offset**, not an absolute linear-memory
address. A frame therefore lives at the absolute address `_wpk_fork_buf +
current_pos`; the postamble (frame write, `UNWINDING`) and preamble (frame read,
`REWINDING`) must both add `_wpk_fork_buf` when turning `current_pos` into a
pointer. Advancing the cursor stays in offset space: `*(buf + 0) := *(buf + 0) +
frame_size`.

> **Historical bug (fixed 2026-07-09).** The postamble/preamble helpers once used
> `current_pos` **directly as an absolute address** — dropping the `+
> _wpk_fork_buf` add — so every frame was written to absolute low memory (addr
> `16..`) instead of inside the save buffer. Small programs survived by luck
> (their low memory is unused scratch that the whole-memory fork copy preserves),
> but a larger program (`wlterm`) collided with live data, corrupting a
> `call_indirect` funcidx and trapping with `table index out of bounds` during
> the child rewind replay. The invariant above (`frame @ _wpk_fork_buf +
> current_pos`) is what makes the two access sites agree.

For wasm32 (`P = 4`) with a module that declares three additional scalar
mutable globals totaling 16 bytes (e.g. `__stack_pointer`, `__tls_base`, one
user i64) and one fork-path function with a single `(catch $tag (param i32))`
arm (16-byte scratch tuple after 8-byte alignment):

```
+0    4    current_pos
+4    4    end_pos                (reserved)
+8    4    saved __stack_pointer  (i32)
+12   4    saved __tls_base       (i32)
+16   8    saved user i64 global
+24   16   b1 scratch (1 slot)
+40        frames start here
```

The `b1_scratch` region is empty (`B == 0`) when no fork-path function in the
module has a plain (non-`_ref`) catch arm — this is the case for every
shipping port today other than future C++ EH ports.

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

## Dispatch schemes

Every fork-path function uses **one of two dispatch shapes**, chosen by the
tool per-function based on call-site topology:

| Scheme                       | When picked                                                                                                                                                                                                                                                                                                                       | How REWIND reaches the resumed call                                                                                                                                                                                            |
|------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| switch-dispatch (top-level)  | Every fork-path call lives at the function's top level. Top-level operand-stack carryovers (values pushed before the call's args and consumed after — common in LLVM `*(sp+K) = call(...)` patterns) are absorbed via per-call spill locals (sub-commit 2.4c).                                                                    | A top-level `br_table`, gated by `state == REWINDING`, jumps directly to the matching `$POST_K` label. The chunks between calls run only on the NORMAL fall-through path; carryover spill locals are reloaded in the post-call. |
| switch-dispatch (nested)     | Some fork-path calls live inside `Block` / `IfElse` / `Loop` / `TryTable` bodies. Sub-commits 2.5/2.6 made this scheme cover: direct-call carryovers at any nesting depth (2.5c), nested-Loop-with-carryover (2.5c side benefit), multi-value-params SubRegion bodies via body-input-param prespill (2.6c).                       | Cascading `POST_K` blocks plus a per-region `br_table` route REWIND through each enclosing instruction's own dispatch — see [Nested per-block switch-dispatch](#nested-per-block-switch-dispatch). For multi-value-params bodies, the body's input params are pre-spilled at body entry and reloaded inside POST_0 to bridge the `Simple(None)` POST_K typing. |

A third path — **guard-dispatch** — existed before commits 3-4 of the
fork-instrument mega-PR (2026-05-14). It wrapped each fork-path call site
in an in-place `state == NORMAL || (state == REWINDING && call_idx == N)`
if-else and gated every side-effect op in the body so it didn't re-fire
during REWIND's linear body replay. After:

- sub-commit 2.5c absorbed direct-call carryovers into nested switch-dispatch,
- sub-commit 2.6c absorbed multi-value-params SubRegion bodies,
- commit 9 (modern wasm-EH SDK flip) removed legacy `try`/`catch` from shipping wasm,
- the post-9 follow-up generalised `compute_carryover_types` to `Option<ValType>`,

all five conditions that previously forced guard-dispatch were closed.
Commit 3 replaced the two `instrument_one_function_guard_dispatch` call
sites in `instrument_one_function` with `panic!()` so any shipping binary
that still triggers the deleted path (e.g., hand-written legacy-EH wasm,
or LLVM output with unknown-type producers in a carryover) fails loudly
with a message naming the function. Commit 4 deleted the
`instrument_one_function_guard_dispatch` implementation and its ~838-line
helper graph.

Both shapes share:

- The state machine, exported ABI, and save-buffer header.
- The per-function frame layout (header + scalar locals).
- Aux-table spill for ref-typed user locals (Phase 4f).
- Catch-handler resume via `throw_ref` (Phase 6).

Switch-dispatch avoids the need for per-call gating: no chunk before the
chosen `POST_K` runs on REWIND, so non-fork-path calls and side-effect ops
in those chunks never re-execute by construction. The previous Phase 4g
side-effect gating and Phase 4c non-fork-path call gating are no longer
needed.

The tool's `instrument_one_function` (in `crates/fork-instrument/src/instrument.rs`)
inspects the original body, runs `classify_nested_pattern` to decide
whether the per-region transform applies, and routes to either
`instrument_one_function_nested_switch` or `instrument_one_function_switch`
accordingly.

Indirect calls (`call_indirect`) are treated as fork-path landings when they
may dispatch to a fork-path-reachable callee in the same table with the same
signature. Discovery is table-aware: active element segments populate their
own table, passive segments count only for tables that can receive them via
`table.init`, and declared segments do not count as table initializers.

To keep dynamic interpreter/function-pointer-heavy runtimes resource-safe,
indirect closure is bounded to two dispatch hops. Direct callers of functions
found through those hops are still included. This covers normal C callback
fork paths and QuickJS's C-function trampoline shape
(`JS_CallInternal -> js_call_c_function -> js_os_exec`) without turning one
generic dispatcher into whole-runtime instrumentation. A program whose only
fork path requires three or more nested function-pointer dispatches is outside
the current static-discovery guarantee and needs a more precise value-flow
analysis before it can be supported safely.

## Per-function transform — before/after WAT

The tool applies a per-function transform that depends on the dispatch
scheme described above. The following pairs show representative fixtures
from `crates/fork-instrument/tests/instrument.rs` and
`crates/fork-instrument/tests/switch_dispatch.rs`. The transformed WAT is
simplified for readability; the actual output includes `current_pos`
bumping, default values for result types, and preserved source locations.

> **Note (post-commit-4):** Examples (a) and (c) below describe the
> pre-2.5/2.6 guard-dispatch shape, which was deleted in commit 4 of
> the fork-instrument mega-PR (2026-05-14). Real LLVM-emitted C now
> goes through switch-dispatch (top-level or nested). The historical
> shape is preserved here because (a) some test fixtures still
> describe the wrapping semantics for documentation purposes, (b) the
> state-machine / preamble / postamble structure is shared across all
> dispatch schemes, and (c) the catch-handler resume in §(b) is still
> the live mechanism. For current switch-dispatch examples, see the
> fixtures under `crates/fork-instrument/tests/fixtures/switch_dispatch/`
> and the assertions in
> `crates/fork-instrument/tests/switch_dispatch.rs`.

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

## Nested per-block switch-dispatch

Top-level switch-dispatch only fires when every fork-path call is at the
function's entry-block depth. Real LLVM-emitted C — popen's `__fork`,
`posix_spawn`, FPM's child-spawn, and many libc paths — keeps fork-path
calls inside a `block` / `if` / `loop` / `try_table`, which would force
those functions into guard-dispatch. The popen-class hangs investigated
in `memory/fork-instrument-O2-bug-investigation.md` (external memory)
showed that guard-dispatch's body-replay diverges from NORMAL flow on
LLVM-O2-shaped inputs, even with non-fork-path call gating: the kernel_fork
wrap can be skipped entirely if a control-flow gate reads a different value
on REWIND than on NORMAL.

`instrument_one_function_nested_switch` extends switch-dispatch to nested
fork-bearing regions so those functions never enter guard-dispatch. Two
ideas combine:

### 1. Cascading POST blocks per region

`partition_region_instrs` (in `crates/fork-instrument/src/instrument.rs`)
splits each fork-bearing seq into chunks separated by **landings**. A
landing is one of:

- **DirectCall** — a direct fork-path `Call` or any `CallIndirect` at this
  seq's level. Same shape as classic switch-dispatch.
- **SubRegion** — a `Block` / `Loop` / `TryTable` whose body is
  fork-bearing. The enclosing instruction is preserved verbatim and the
  per-region `br_table` lands the function-level `call_idx` *just before*
  it; the sub-region's own internal dispatch (built bottom-up by recursive
  invocation of the same transform) routes the rest of the way.
- **SubRegionIfElse** — an `IfElse` whose `then` and/or `else` branches are
  fork-bearing. Both branch ranges are recorded so the cond rewrite (below)
  can pick the active branch on REWIND.

The function-level `br_table` maps each `call_idx` to either a direct
`POST_K` (top-level call) or a `POST_J_ENTER` label positioned right before
a sub-region landing. Sub-regions then dispatch internally via their own
`br_table` over the call_idxs that fall in their range.

### 2. IfElse cond rewrite via `select`

The standard top-level `POST_K` block has type `Simple(None)` (0 → 0).
That's incompatible with an `IfElse` landing because the chunk preceding
the IfElse has to leave the original cond on the stack. The fix:

- At the end of the chunk inside `POST_K`, spill the original cond into a
  freshly-allocated i32 local, `cond_swap_local`.
- After `POST_K` closes, synthesize a replacement cond using a wasm
  `select`:

```wat
;; chunk leaves orig_cond on the stack, then:
local.set $cond_swap         ;; spill — handled by emit_chunk_tail_for_landing.
end                          ;; close POST_K (Simple(None) is satisfied).

;; post-landing sequence — re-create cond for the IfElse:
push force_flag              ;; 1 if active call_idx in THEN's range, else 0.
local.get $cond_swap         ;; re-push orig_cond.
push (state == REWINDING)
select                       ;; (is_rewind ? force_flag : orig_cond)
if (then ...) (else ...)     ;; original IfElse, untouched.
```

`force_flag` discrimination:

- only THEN has fork-path calls → `i32.const 1`
- only ELSE → `i32.const 0`
- both branches → range-membership test on THEN's call_idx range
  (`call_idx >= then_lo && call_idx <= then_hi`)

On NORMAL the rewritten cond evaluates to `orig_cond`, preserving the
program's semantics. On REWIND it forces entry into whichever branch
contains the active call_idx, regardless of `orig_cond`. This avoids
re-evaluating the original cond expression during REWIND — important when
that expression has side effects or reads state that may diverge between
parent NORMAL and child/parent REWIND.

### 3. Carryover-spilling at SubRegion + DirectCall landings

LLVM at -O2 inlines `posix_spawn` into `main` (and similar patterns
elsewhere) and emits a single i32 pushed *before* a fork-bearing block
that's consumed *after* it. The
`os-test/basic/spawn/posix_spawnattr_setpgroup` -O2 fixture is the
canonical instance:

```wat
local.get 0           ;; push __errno_location() — the carryover.
block (result i32)    ;; the block contains kernel_fork.
  ... kernel_fork wrap ...
end
local.tee 1
i32.store             ;; consumes both: *errno_location = posix_spawn_rc.
```

`POST_K` is `Simple(None)` (0 → 0), so the chunk before the SubRegion can't
leave anything on the stack. The fix is to spill the carryover into a
fresh **frame-resident** local at the chunk tail, then reload it BEFORE
the enclosing instruction runs (sub-commit 2.6a — push-before order
replaces the earlier push-after + tmp-result-juggle):

- `CarryoverPlan` holds `spill_locals: Vec<(LocalId, ValType)>`, ordered
  deepest-stack-first. All locals are appended to the function's frame so
  they get serialized on UNWIND and restored on REWIND, matching every
  other scalar user local.
- `emit_chunk_tail_for_landing` pops each value off the operand stack via
  `local.set`, top-of-stack-first, into the spill locals. Net stack effect
  of the chunk inside `POST_K`: 0 → 0, satisfying `POST_K`'s type.
- The post-landing sequence pushes spill_locals[0..] back onto the stack
  in order BEFORE emitting the enclosing instruction. The SubRegion's
  type-params (at the top of the post-push stack) are consumed by the
  instruction; any extra carryover beneath stays intact and ends up below
  the SubRegion's result on exit — matching the original semantics WITHOUT
  needing a tmp_result_local juggle.

The same machinery applies to **DirectCall landings inside nested seqs**
(sub-commit 2.5b/c). At each fork-path call site inside a non-entry seq,
per-call carryover spill locals (allocated from
`compute_nested_carryover_types`, keyed by call_idx) round-trip the
carryover values across UNWIND/REWIND.

The SubRegion spill list is computed by `analyze_subregion_spill_types`
(sub-commit 2.6a; replaces the older `analyze_carryover_depths`), which
tracks the typed operand stack as `Vec<Option<ValType>>` and reports the
full list of values to spill per landing — covering both the SubRegion's
declared type-params AND any extra carryover above them on the parent
stack. `seq_has_unsupported_carryover` runs first as a gate; post-2.6c
it rejects only IfElse-with-carryover and SubRegions with unsupported
result types (multi-value RESULTs are still gated, though body PARAMS
are now supported).

**Multi-value-params bodies (sub-commit 2.6c).** When a SubRegion is a
multi-value `Block`/`Loop`/`TryTable` whose body uses its declared input
params, the cascading POST_K blocks can't expose those params to inner
chunks (POST_K is `Simple(None)`, so the wasm validator forbids reading
from outside its scope). The fix: at body entry, pre-spill the params to
fresh function-local locals; in POST_0's body (just before chunks[0]
runs), reload them via prepended `local.get`s. On NORMAL flow the body
params are saved and reloaded; on REWIND the dispatch br_tables past
chunks[0], so the LocalGets are skipped — exactly the cases where the
params would otherwise be needed.

**Function-level analyser gate.** When `walk_seq_for_carryovers` or
`compute_nested_carryover_types` encounters a producer whose pushed type
the analyser can't statically track (Unop, Cmpxchg, ref-typed
CallIndirect/CallRef, multi-value structured control), the unknown slot
is tracked as `None` and tolerated as long as it's consumed before any
fork-path call. Only if a `None` slot ends up IN a carryover does the
analyser fail the switch-dispatch classification for that shape.
The same `Option<ValType>` policy applies to the top-level
`compute_carryover_types` for switch-dispatch (top-level) routing. If a
function still reaches an unsupported carryover shape, the tool rejects that
shape loudly; there is no guard-dispatch fallback after the mega-PR cleanup.

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

`catch_ref` and `catch_all_ref` clauses use the exnref stash + `throw_ref`
flow above. Plain (non-`_ref`) `catch` clauses have no exnref to re-throw,
so B1 stages 1+2 add a parallel scratch-replay path: each fork-path plain-catch
arm stashes its operand tuple to the module-level B1 scratch region on
NORMAL entry and replays the operand tuple on REWIND. The unified rewind-throw
stub uses `ref.is_null` on the exnref slot to discriminate between the two
modes, and an arm-id if-chain to dispatch among multiple arms in the same
try_table. See [Fork-from-plain-catch (B1 stages 1+2)](#fork-from-plain-catch-b1-stages-12)
under "Maintainer notes" for the implementation.

## Call-graph discovery

Instrumentation only rewrites functions that can transitively reach the
designated async import (default: `kernel.kernel_fork`). The discovery
algorithm in `crates/fork-instrument/src/call_graph.rs`:

1. Seed set `S` = { the imported `kernel.kernel_fork` function }.
2. **Direct reverse closure.** For every newly discovered callee `g`, add
   every local function that directly calls `g`.
3. **Indirect reverse closure.** If `g` appears in a function table, add
   every local function that performs `call_indirect` with a structurally
   matching function type.
4. Repeat steps 2–3 until the worklist is empty.

The output is a function-set `S` that gets instrumented. All other functions
pass through unmodified.

The indirect-call step is conservative — a table-addressable fork-path target
pulls in every same-signature indirect caller. This is enough for registered
callback paths such as signal handlers, pthread cleanup handlers, `atexit`
handlers, and qsort-style comparators in the current libc output. The broader
"instrument every address-taken function" rule from the original C3 plan was
not needed for this PR and was not added; K-01, K-02, K-04, and K-07 cover the
current behavior.

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
- **Kernel-side-effect calls don't re-fire during REWIND.** Switch-dispatch
  (the only live scheme post-commit-4) skips the body chunks before the
  matching `POST_K` entirely on REWIND, so non-fork-path direct calls
  (`setpgid`, `dup3`, `kill`, `open`, `pipe`, …) and all observable
  side-effect ops in those chunks run exactly once, on the parent's NORMAL
  pass. No per-call or per-op gating is needed.

### Not guaranteed (unsupported patterns)

- **`makecontext` / `swapcontext` / `getcontext` / `setcontext`.** Userspace
  stack-switching primitives are unsupported and not on any roadmap. See
  [posix-status.md](posix-status.md) for rationale.
- **Functions whose plain-catch arms carry ref-typed operands.** Catch arms
  whose operand tuple includes an `(ref ...)` value (typically a function or
  GC ref) are carved out of the fork-path set at instrument time. Spilling
  ref-typed catch operands would require per-arm aux-table slots. The current
  PR deliberately keeps the safe `B1ScratchPlan::b2_carveout` behavior and
  covers it with WAT-level tests. This is an unanticipated Wasm-level case,
  not expected output from ordinary C++ EH lowering: C++ exception payloads
  live in linear memory / libc++abi state rather than as `funcref` or
  `externref` plain-catch tag operands. If a future language frontend or
  hand-written Wasm module needs it, implement per-arm funcref/externref
  aux-table stashing and promote C-08/C-09 from carve-out validation to full
  replay tests.
- **IfElse with operand-stack carryover.** A fork-bearing `if/else`
  enclosing a stack value that survives across the branch is rejected by
  `seq_has_unsupported_carryover` — the cond rewrite via `select` (see
  §IfElse cond rewrite) doesn't currently compose with carryover spilling.
  Rare in LLVM output; not tracked as a current blocker.
- **Wasm-GC refs.** Abstract `any` / `eq` / `struct` / `array` / `i31` refs
  and concrete GC refs are rejected at the `classify_ref` step — the tool
  panics rather than produce a silently-broken module. Add classes in
  `crates/fork-instrument/src/instrument.rs` when a real program needs them.

#### Closed since the mega-PR's 2.5/2.6 sub-commits

These were "Not guaranteed" pre-2.5/2.6 but are now absorbed by switch-
dispatch (top-level or nested):

- ~~**Operand-stack carryovers at DirectCall landings**~~ — sub-commit 2.5c
  added per-call carryover spilling at direct fork-path call landings.
- ~~**Multi-value-params Block/Loop/TryTable bodies containing fork-path
  calls**~~ — sub-commit 2.6c added body-input-param prespill so the
  cascading POST_K blocks can re-expose params to inner chunks.
- ~~**Wider carryover shapes at sub-region landings (multi-typed, multi-
  value)**~~ — sub-commit 2.6a's `CarryoverPlan::spill_locals` Vec
  generalised the single-i32 MVP to any number of typed slots.
- ~~**Top-level carryovers with unknown-type producers consumed before the
  fork call**~~ — sub-commit 9-followup generalised the top-level
  analyser to `Vec<Option<ValType>>`, mirroring 2.5c's nested policy.

### Side effects during REWIND — no gating needed

Post-commit-4 (2026-05-14), switch-dispatch is the only live dispatch
scheme. By construction, the body chunks before the chosen `POST_K`
**never re-execute on REWIND** — the function-level `br_table` jumps
directly to the matching post-call block, bypassing every preceding
instruction. This means:

- **Non-fork-path direct calls** in those chunks (libc wrappers for
  `setpgid` / `dup3` / `open` / `kill` / `pipe`, etc.) never re-fire.
  Their kernel side effects happen exactly once, on the parent's
  NORMAL pass. The pre-2.5/2.6 guard-dispatch's `state == NORMAL`
  gate + frame-saved result locals are no longer needed.
- **Observable side-effect ops** (`local.set`, `local.tee`,
  `global.set`, `store` of all widths, `memory.grow` / `memory.fill`
  / `memory.copy` / `memory.init`, `data.drop` / `elem.drop`,
  `table.set` / `table.grow` / `table.fill` / `table.init` /
  `table.copy`, atomic RMW, `atomic.notify`, `throw` / `throw_ref`)
  in those chunks similarly run only on NORMAL.

The pre-2.5/2.6 Phase 4g side-effect-gating machinery
(`emit_gated_side_effect`, `side_effect_shape`,
`emit_gated_non_fork_call`) was deleted alongside guard-dispatch in
commit 4. The historical context — including the
`local.tee` identity-passthrough bug from the popen-class divergence
investigation — is preserved in
`memory/fork-instrument-O2-bug-investigation.md` (external memory).

## Performance envelope

The Phase 7 acceptance gate is ±3% of the previous fork-continuation baseline on fork-heavy
benchmark suites, measured with `npx tsx benchmarks/run.ts --rounds=3` on
both the Node.js host and the browser host. The suites that exercise fork
meaningfully are `wordpress`, `erlang-ring`, and `process-lifecycle`.

For the concrete numbers landed by the Phase 7 rollout PR, see Task 15 of
`docs/plans/2026-04-21-fork-instrument-phase-7-rollout-plan.md`. Binary size
for fork-heavy programs is expected to be equal or smaller than under the
prior full-module fork-continuation carve-out (most notably git), since the tool instruments
a tighter reachable set.

## Maintainer notes

### Reasoning about which scheme a function uses

When a real-world program misbehaves during fork, the first triage step is
to identify which switch-dispatch shape the offending function uses:

```bash
wasm-tools print "$BIN" | awk '/^\s+\(func [^;]*main/{found=1} found{print}' | head -200
```

A leading `block ... block ... if (state == REWINDING) ... br_table ...`
shape at the function's entry means switch-dispatch is active. A historical
`block $unwind_save` followed by per-call `(state == NORMAL || (REWINDING &&
call_idx == K))` if-elses means an old guard-dispatch binary is being
inspected, not current PR output.

To distinguish top-level switch-dispatch from nested switch-dispatch,
look inside the enclosing instructions: nested switch-dispatch emits the
same `if (state == REWINDING) ... br_table ...` shape inside any
fork-bearing `block` / `loop` / `if` / `try_table`, plus a
`local.set $cond_swap_local` at the end of the chunk preceding any IfElse
landing and a `select` rewriting that IfElse's cond afterwards. Top-level
switch-dispatch has only the function-level dispatch and never touches a
sub-region's body.

Carryover-spilling at a SubRegion landing shows up as a pair of fresh
i32 locals (recorded in the function's frame): the chunk inside `POST_K`
ends with `local.set $spill_local`, and after the enclosing instruction
the post-landing sequence emits `local.get $spill_local` (and, when the
enclosing instr returns an i32, a brief juggle through `tmp_result_local`).

Nested switch-dispatch coverage lives in
`tests/switch_dispatch.rs::nested_fork_call_uses_per_block_switch_dispatch`
and the carryover-spilling fixtures alongside it. Add new regressions there
or in `host/test/fork-instrument-coverage.test.ts` depending on whether the
bug is a tool-level transform issue or an end-to-end host/runtime issue.

### Running tests

Unit tests live in `crates/fork-instrument/tests/`. The default cargo target
in this workspace is `wasm64-unknown-unknown` (from `.cargo/config.toml`),
which cannot build host tests — always pass the explicit host target:

```bash
HOST_TARGET="$(rustc -vV | awk '/^host/ {print $2}')"
cargo test -p fork-instrument --target "$HOST_TARGET"
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

### Extending side-effect coverage

There is no live side-effect gating path after guard-dispatch removal. If a
new wasm opcode can appear before a fork-path call, add coverage that proves
the containing switch-dispatch shape skips that opcode on REWIND. Existing
examples are the S-01..S-08 host fixtures plus the WAT-level table-operation
tests in `crates/fork-instrument/tests/coverage_wat.rs`.

### Fork-from-plain-catch (B1 stages 1+2)

Plain (non-`_ref`) `catch` arms unwrap the thrown exception's operand tuple
onto the operand stack at handler entry, but unlike `catch_ref` /
`catch_all_ref` they do not push an exnref. The Phase 6 rewind-throw stub
reaches the handler by `throw_ref`-ing a saved exnref into the original
try_table's catch clause; with a plain catch there is no exnref to save, so
some other resume path is needed.

B1 stages 1+2 add that path:

1. **Discovery (Stage 1, `instrument::discover_plain_catch_arms`).** Walks
   each function and collects every plain-catch arm's tag, target label, and
   operand-tuple types. Stage 1 also assigns each arm a `B1ScratchPlanSlot`
   with a per-arm offset into the module-level scratch region (computed by
   `plan_b1_scratch`). Each arm's slot is sized to the natural-aligned
   total of its operand tuple's scalar widths.
2. **Capture-block emission (Stage 2 Task 2.2,
   `apply_plain_catch_handlers`).** Every plain-catch arm gets a wrapping
   `$capture` block injected around its handler body. On entry the block
   pops the arm's operand tuple off the stack, stores each value into the
   arm's `b1_scratch` slot, sets `$catch_region_id_local` and a
   per-handler arm-id, then re-pushes the operands and falls through to the
   user handler. On REWIND the rewind-throw stub uses the arm-id to dispatch
   into a synthesized re-throw that lands the operands back on the stack
   from `b1_scratch` and re-enters the user handler with the same operand
   shape it would have seen on the NORMAL pass.
3. **Multi-arm dispatch (Stage 2 Task 2.3, in `inject_rewind_throw_stubs`).**
   The pre-existing rewind-throw stub used a single `(if (state == REWINDING
   && catch_region_id == K))` check, fine for catch_ref's exnref-stash path.
   For plain catches the stub now also discriminates on `arm_id` via an
   if-chain so a try_table with multiple plain-catch arms reaches the
   correct one. The stub still uses `ref.is_null` on the exnref slot to
   select between catch_ref-style throw_ref and plain-catch-style operand
   replay.
4. **Carve-out (Stage 2 Task 2.1, in `plan_b1_scratch`).** Functions whose
   plain-catch arms carry ref-typed operands (`(ref T)` other than `exnref`)
   are removed from the fork-path set rather than instrumented, since the
   scratch region only stores scalar tuples. This is the safe path for an
   unanticipated Wasm-level case: ordinary C++ EH is not expected to emit
   funcref/externref plain-catch payloads, and no current shipping port
   needs them. Stage 2 Task 2.4 also detects multi-target plain-catch
   try_tables and applies the same carve-out.

The carve-out is reported via `B1ScratchPlan::b2_carveout`; the scratch
region is sized only for the surviving fork-path arms. C-08/C-09 in
`crates/fork-instrument/tests/coverage_wat.rs` verify that funcref and
externref catch operands take this safe carve-out path rather than panicking
or producing invalid wasm. For shipping ports the carve-out is empty in the
current matrix, so it is not a merge blocker for PR #307.

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
