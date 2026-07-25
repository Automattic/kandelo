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
Some conservative-GC package builds run an additional local-root visibility
pass before fork instrumentation. That pass is not part of the fork ABI; see
[`crates/wasm-local-root-spill/README.md`](../crates/wasm-local-root-spill/README.md)
for its Ruby-focused rationale, risk profile, and extension limits.
For motivation, tradeoffs, and the rollout plan that led here, read
[`plans/2026-04-20-fork-instrumentation-design.md`](plans/2026-04-20-fork-instrumentation-design.md);
for the post-rollout switch-dispatch redesign and non-fork-path-call gating
that fix the kernel-side-effect re-fire bug, read
[`plans/2026-04-22-fork-instrument-switch-dispatch-redesign.md`](plans/2026-04-22-fork-instrument-switch-dispatch-redesign.md).
ABI version: `43` (see
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
- Every value needed after replay must be either activation-owned bytes in the
  linked continuation or the output of a versioned deterministic
  reconstruction recipe in the fresh child. Module globals and tables are
  instance state, not evidence that a value survived `fork()`.
- ABI 43 fork artifacts must carry the activation-state-safe capability. An
  unsupported reference or table shape fails during instrumentation or
  pre-launch artifact validation; it must not become a child-only trap.
- Binaries exporting legacy `asyncify_*` symbols are stale and must be rebuilt.
  Do not add host support for them.
- Do not keep compiler/linker flags solely for the retired legacy path. The
  fork instrumenter does not require preserved function names or onlylists; if
  a build keeps debug-info flags, it should be for a current diagnostic reason.
- On Unix hosts, the CLI preserves the input Wasm file's permission mode on
  its output, including when `--output` names the input file. Package build
  scripts can therefore instrument installed executables in place without
  making them non-executable.

## State machine

Every instrumented module carries a single mutable i32 global, `_wpk_fork_state`,
and one mutable pointer global, `_wpk_fork_buf` (i32 for wasm32 programs, i64
for wasm64). The pointer is zero while the state is `NORMAL` and holds the
address of the active root chunk's module prefix otherwise.

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
  its unwind-only call-site bridge, reserves a complete linked node before the
  first frame write, then runs its postamble to finish the payload, commit the
  node, and return a default value; the runtime-exported
  `wpk_fork_unwind_end` is called once the top of the stack is reached.
- `REWINDING` — the stack is being rebuilt from saved frames. Each
  instrumented function loads its frame and jumps straight to the matching
  call site via switch-dispatch. Body chunks before the chosen post-call
  landing are skipped, so non-fork-path calls and side-effecting operations
  in those chunks do not re-run.

The host drives the state machine externally. User code never writes to
`_wpk_fork_state` directly.

## Exported ABI

The tool injects seven exports into every instrumented module. Names are
exact — they are part of the kernel ABI and tracked by the snapshot check
(see [abi-versioning.md](abi-versioning.md)).

```
wpk_fork_unwind_begin(buf: ptr) -> ()
  Precondition:  state == NORMAL
  Postcondition: state := UNWINDING
                 _wpk_fork_buf := buf
                 *(buf + 0) := buf + frames_start_offset
                 All mutable scalar globals snapshotted into buf.

wpk_fork_unwind_end() -> ()
  Precondition:  state == UNWINDING and all frames have been drained.
  Postcondition: _wpk_fork_buf := 0
                 state := NORMAL

wpk_fork_rewind_begin(buf: ptr) -> ()
  Precondition:  state == NORMAL (in a freshly-instantiated child)
  Postcondition: state := REWINDING
                 _wpk_fork_buf := buf
                 All saved mutable scalar globals restored from buf.

wpk_fork_rewind_end() -> ()
  Precondition:  state == REWINDING and all frames have been reloaded.
  Postcondition: _wpk_fork_buf := 0
                 state := NORMAL

wpk_fork_abort_begin(buf: ptr) -> ()
  Precondition:  state == UNWINDING after a typed frame-allocation failure.
  Postcondition: state := ABORT_UNWINDING
                 _wpk_fork_buf := buf
                 All saved mutable scalar globals restored from buf.

wpk_fork_abort_end() -> ()
  Precondition:  state == ABORT_UNWINDING and all committed inner frames
                 have been reloaded.
  Postcondition: _wpk_fork_buf := 0
                 state := NORMAL

wpk_fork_state() -> i32
  Returns current state. Exported for host-side assertions.
```

ABI 42 and later modules additionally import three exact `env` functions. A module that
imports any one of them must import all three and carry the linked-frame custom
section described below.

```
__wpk_fork_frame_reserve(frame_size: ptr) -> ptr
  Reserves a complete node and returns its payload address before any frame
  bytes are written.

__wpk_fork_frame_commit(payload: ptr) -> ()
  Publishes the pending node after the activation-owned payload is complete.

__wpk_fork_frame_next(expected_frame_size: ptr) -> ptr
  Returns the next committed payload during rewind and rejects size/order
  mismatches before generated code reads it.
```

The control exports identify the state-machine ABI, but they do not prove which
import seeded call-graph discovery. The tool therefore also emits the custom
section `kandelo.wpk_fork.capabilities`. Its two-byte payload is
`[version, flags]`; version 1 defines:

- bit 0 (`0x01`): the module was instrumented with `--entry env.fork`, so an
  `env.fork`-importing side module has complete side-entry coverage;
- bit 1 (`0x02`): a default-entry main module imported Kandelo's dynamic-linker
  functions and conservatively instrumented every `call_indirect` boundary
  plus its direct callers;
- bit 2 (`0x04`, `WPK_FORK_CAP_ACTIVATION_STATE_SAFE`): the instrumenter
  validated the complete fork closure and rejected state that cannot be
  reconstructed in a fresh module instance.

ABI 43 requires exactly one two-byte capability section, version 1, with bit 2
set. Unknown bits, missing/duplicate/malformed sections, or a missing safety bit
fail artifact validation before execution. Role bits retain their existing
meaning and are still required for side-entry and dynamic-linking replay where
applicable. The safety bit is not inferred from the seven control exports:
ABI 42 emitted those exports while still depending on module-instance
reference tables. A copied safety claim also cannot upgrade a normal ABI 42
program because the program ABI marker must match 43.

ABI 16/18 role-marker compatibility remains historical parser-test coverage;
it is not a launch fallback for an ABI 43 kernel. Changing the capability
encoding or meaning requires another ABI bump and regenerated snapshot.

### ABI 43 deployment and rebuild boundary

ABI 43 is an artifact epoch, not a host-only update. All fork-instrumented main
programs and side modules must be rebuilt with the ABI 43 instrumenter, then
the affected package archives, bottles, binary indexes, shell closure, and VFS
images must be regenerated against the new cache keys. Kernel, host, SDK/libc,
and generated ABI constants must ship as one coordinated set.

Do not republish ABI 42 artifacts with edited metadata or a copied capability.
The ABI 43 instrumenter refuses inputs that already contain fork control
exports, linked-frame imports, or fork metadata; builds must start from raw
linker output so the new validation sees the original activation and table
state.
The source package projection may be regenerated while developing this epoch,
but broad bottle/index/VFS publication requires explicit release coordination.
Modern C++ exception artifacts that contain fork-reachable `exnref` locals or
`CatchAllRef` are currently rebuild blockers: the ABI 43 instrumenter rejects
them truthfully until a sound liveness or reconstruction design exists.
The current source build of Dash is blocked for the same reason in
`expandstr`, where LLVM emits a fork-reachable `exnref` local. Consequently,
the ABI 43 shell closure and canonical rootfs/VFS images cannot be rebuilt or
published yet; ABI 42 images must not be relabeled for this epoch.

`ptr` is `i32` on wasm32 user programs and `i64` on wasm64 user programs. The
tool picks the pointer width from the module's primary memory — a memory64
memory yields `i64`, anything else yields `i32`.

`wpk_fork_unwind_begin` self-initializes `*(buf + 0)` with
`buf + frames_start_offset` before touching user state. In the linked format,
that initial address is the 16-byte abort selector inside the fixed prefix.
During linked unwind and rewind, generated code overwrites the word with the
payload address returned by the corresponding host hook. The host allocates
the root chunk and passes `root + chunk_header_size` as `buf`; no caller
computes or preallocates a worst-case frame-data footprint.

Every end export clears `_wpk_fork_buf` before publishing `NORMAL`. This
removes the module's stale alias when the host releases or reuses continuation
storage. Address zero is ordinary linear memory, so the clear is an ownership
invariant and defense, not a substitute for correct generated code: no
ordinary-execution path may dereference the buffer global.

## Host Threading Contract

The continuation belongs to the channel that issued `SYS_FORK`. For a
main-thread fork this is the process worker's channel, and the child enters `_start` before
`wpk_fork_rewind_begin` replays to the saved call site.

Each process worker or pthread worker owns a separate host-side continuation
object. This is load-bearing for pthreads: thread instances share linear
memory, but separately allocated mappings and per-worker replay cursors prevent
their unwinds from sharing frame storage.

For `fork()` from a pthread worker, the host must preserve the pthread entry
context as well as the buffer:

- `CentralizedKernelWorker` creates a host-side, one-shot
  `ThreadChannelAttachment` bound to the kernel's exact clone result.
  `attachThreadChannel(attachment, offset)` records that kernel-assigned
  identity, pthread entry table index, and userdata for the thread channel;
  host code cannot provide or substitute a PID/TID.
- `centralizedThreadWorkerMain` overrides `kernel_fork` for instrumented modules
  and drives `wpk_fork_unwind_begin` / `wpk_fork_state` /
  `wpk_fork_rewind_begin` around the pthread function, using
  a dynamically mapped root chunk. `channelOffset - FORK_BUF_SIZE` now stores
  only the active root address used by the kernel-worker fork handoff.
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
- That pthread entry function, argument, and buffer remain the child's
  continuation root until `exec` replaces the process image. If the child
  forks again first, the host propagates the same root and buffer to the
  grandchild; launching the grandchild at `_start` or rewinding the main-thread
  buffer would replay a call chain that was never saved.

The child does not inherit every parent pthread reservation. POSIX fork resumes
only the calling thread, so dead parent pthread slots become ordinary copied
memory bytes in the child and can be reused by later child `brk`, `mmap`, or
`pthread_create()` activity. Retaining the caller's one slot avoids having to
move the saved `__tls_base`, thread-local state, and fork-save buffer during
rewind.

This path is covered by `host/test/fork-from-thread.test.ts` (including a second
fork in the child before exec), `host/test/fork-instrument-coverage.test.ts`
P-06 (`pthread_create` worker calls `fork`), and K-03
(`pthread_cleanup_push` handler calls `fork`).

## Fork from a dlopened side module

The supported dynamic-linking shape is a direct main-module `call_indirect`
into one side-module instance whose call stack reaches `env.fork`:

1. Instrument the main program normally. If it imports Kandelo's dlopen host
   functions, the tool marks and preserves all possible dynamic indirect-call
   boundaries.
2. Instrument the fork-capable side module with `--entry env.fork`. It receives
   its own linked continuation and versioned side-entry capability.
3. The process worker unwinds the side module, then the main module. Fork replay
   restores dlopen instances at their exact memory and table bases, rewinds the
   main module, then rewinds the active side module.

The main fork trampoline is captured before side exports enter the symbol
table, so a later extension cannot interpose the coordinator's `fork` target.
Failed dlopen attempts may leave non-shrinkable null table gaps; each successful
archive entry records its exact parent table base, and child replay pads to and
validates that base.

The loader preserves ordinary independent multi-extension loading. When a
fork-capable extension participates, it rejects statically visible
side-to-side function/GOT linkage and side-originated `dlopen`/`dlsym`, because
an intervening side-module frame would need a third ordered unwind. Opaque
function pointers passed through main-module memory or the shared table cannot
currently be attributed to their originating module; using such a pointer to
create a side A -> side B -> fork path is unsupported and is not yet guaranteed
to fail before control-flow corruption. A future module-activation protocol is
required to close that residual.

Pthread workers do not own the process worker's side-module instances, table,
or exception-tag identities. `dlopen()` from a pthread consequently returns
NULL with a precise `dlerror()`. Once the process main worker has published a
dlopen archive entry, `fork()` from a pthread returns `ENOTSUP` without
creating a child. A host-private atomic lock prevents main-worker dlopen from
racing the pthread's archive check and is held through unwind, SYS_FORK/memory
copy, and parent rewind; the child clears its copied lock before replay. Fork
from a pthread remains supported while that process-wide archive is empty.

For TLS-bearing side modules, each archive entry also preserves the live
positive `__tls_base`. Replay restores only that mutable global using the
process pointer type. It does not call `__wasm_init_tls`: the child memory copy
already contains live TLS, and reinitialization would overwrite C++ landing-pad
and application `thread_local` state. TLS-relative exports relocate from that
base, while `__tls_size` and `__tls_align` remain scalar constants.

Every participating module owns an independent linked continuation. Side and
main nodes may occupy several mappings and may contain a frame larger than one
WebAssembly page. The coordinator completes and validates both continuations
before it sends `SYS_FORK`.

## Save buffer format

All values are little-endian and all records are eight-byte aligned. `P` is
pointer width (4 on wasm32, 8 on wasm64). Instrumented modules carry exactly
one 24-byte `kandelo.wpk_fork.linked_frames` custom section. Version 1 contains
the `KLCF` magic, descriptor size, pointer width, alignment, transactional-node
flag, chunk-header size, node-header size, and module-specific fixed-prefix
size. The host validates every field before instantiation.

Continuation storage consists of page-rounded anonymous process mappings. The
root starts with a chunk header, followed by the module's fixed prefix. Later
chunks contain only a chunk header and nodes. Version-1 chunk headers are:

| Offset | Size | Field | Purpose |
|---|---:|---|---|
| `+0` | 4 | magic | `KFCH` |
| `+4` | 2 | version | Linked format version |
| `+6` | 2 | flags | Zero in version 1 |
| `+8` | `P` | root | Root chunk address |
| `+8+P` | `P` | previous | Previous chunk, or zero |
| `+8+2P` | `P` | next | Next chunk, or zero |
| `+8+3P` | `P` | capacity | Mapped byte length |
| `+8+4P` | `P` | used | First unused byte |
| `+8+5P` | `P` | committed tail | Newest committed node; meaningful on root |

The module prefix retains the runtime's active-frame pointer word, a reserved
pointer word, saved scalar globals, and a 16-byte abort selector.
`frames_start_offset = 2P + N` identifies the selector, while the host-visible
fixed-prefix size is `frames_start_offset + 16`. Frame nodes and
tagged-catch activation state are not stored in that prefix.

This does not introduce a new linked-frame encoding. `fixed_prefix_size` has
always been a module-specific value in the version-1 descriptor, and each node
already declares its function-specific payload size. Existing artifacts retain
and report their larger historical prefix; newly instrumented artifacts report
the prefix they actually use. Import/export names, descriptor fields, and host
parsing semantics are unchanged.

At the first fork call, the host maps one page-rounded root large enough for
the chunk header and fixed prefix. Each postamble already knows its own exact
frame size and passes it to `reserve`; no extra frame-size-counting
instrumentation or whole-stack prepass is required. When the active chunk does
not fit the next complete node, the host maps another page-rounded chunk. A
single node larger than a WebAssembly page receives a multi-page chunk.

Allocation is transactional: a reserved node is not linked from the committed
tail until all activation-owned bytes are written. If a later chunk allocation
fails, the reserve import records the positive errno, enters
`ABORT_UNWINDING`, and returns a zero pointer. The still-live activation stores
only its call-site selector in the fixed-prefix scratch and restarts; already
committed inner nodes replay back to the original fork import. The import ends
abort replay, unmaps every owned chunk, restores `NORMAL`, and returns the
negative errno. Invalid metadata, impossible transitions, and cleanup failures
remain fatal integrity errors.

A root allocation failure occurs before `wpk_fork_unwind_begin` and therefore
returns its negative errno without replay. A negative `SYS_FORK` result after a
complete unwind uses the ordinary parent rewind and is likewise returned to
the guest; neither case terminates the parent or creates a child.

The child receives the mappings through the normal process-memory copy and the
kernel's inherited mmap metadata, at the same virtual addresses in version 1.
Parent and child independently walk and unmap their copies after rewind. The
linked format makes chunk boundaries explicit, but version 1 does not rebase
internal pointers or relocate the chain in the child.

Mutable reference globals (`funcref` / `externref` / `exnref`) are not stored
in the linear-memory header. A fork-capable module containing one is rejected
before runtime injection because its current value belongs to the parent module
instance. The inert runtime injected into a module with no fork seed may leave
unrelated reference globals alone because that module never replays.

## Frame format

Each instrumented function has a statically known payload size. The size
depends on its scalar user locals and instrumenter-owned frame locals, but the
payload header is uniform. Each payload is preceded by a linked-node header:
`KFCN` magic,
format version, transactional state, previous-node pointer, payload size, and
total aligned node size. That header costs 24 bytes on wasm32 and 32 bytes on
wasm64 before alignment.

| Offset | Size | Field             | Purpose                                  |
|--------|------|-------------------|------------------------------------------|
| `+0`   | 4    | `func_index`      | Ordinal assigned at instrument time      |
| `+4`   | 4    | `call_index`      | Which call site within the function      |
| `+8`   | 4    | `catch_region_id` | 0 in normal flow; non-zero for catches   |
| `+12`  | 4    | reserved          | Deterministic zero in ABI 43             |
| `+16`  | var  | `saved_locals[]`  | User and synthetic scalars, aligned      |

Every value in a frame is scalar. Fork-reachable reference locals, parameters,
signatures, global reads, call carryovers, and reference-typed catch payloads
are rejected before rewriting; the instrumenter never substitutes a
module-instance table slot for a transferable value.

Synthetic frame locals include call-argument and operand-stack carryover
spills. For each supported tagged-catch region they also include one
`active_arm` i32 and typed scalar operand locals for every static arm. Capture
therefore belongs to one function activation, and recursive activations
serialize distinct values in distinct linked frames.

`catch_region_id` is zero in the common case (the frame was captured outside
any catch handler). When non-zero, it identifies the `try_table` whose catch
handler the frame lives in. The restored `active_arm` and operand locals select
the exact static `Catch` or `CatchRef` clause. Rewind throws that arm's tag and
scalar payload; for `CatchRef`, normal Wasm exception dispatch creates a fresh
child-instance exnref. See [Catch-handler resume](#catch-handler-resume).

## Dispatch schemes

Every fork-path function uses **one of two dispatch shapes**, chosen by the
tool per-function based on call-site topology:

| Scheme                       | When picked                                                                                                                                                                                                                                                                                                                       | How replay reaches the resumed call                                                                                                                                                                                            |
|------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| switch-dispatch (top-level)  | Every fork-path call lives at the function's top level. Top-level operand-stack carryovers (values pushed before the call's args and consumed after — common in LLVM `*(sp+K) = call(...)` patterns) are absorbed via per-call spill locals (sub-commit 2.4c). Pure scalar call-argument tails can be replayed instead of spilled. | A top-level `br_table`, gated by `state >= REWINDING`, jumps directly to the matching `$POST_K` label for ordinary or abort replay. The chunks between calls run only on the NORMAL fall-through path; carryover spill locals are reloaded in the post-call, followed by spilled or replayed call args. |
| switch-dispatch (nested)     | Some fork-path calls live inside `Block` / `IfElse` / `Loop` / `TryTable` bodies. Sub-commits 2.5/2.6 made this scheme cover: direct-call carryovers at any nesting depth (2.5c), nested-Loop-with-carryover (2.5c side benefit), multi-value-params SubRegion bodies via body-input-param prespill (2.6c). Pure scalar direct-call args and condition-only `IfElse` carryovers can be replayed instead of spilled. | Cascading `POST_K` blocks plus a per-region `br_table` route ordinary or abort replay through each enclosing instruction's own dispatch — see [Nested per-block switch-dispatch](#nested-per-block-switch-dispatch). For multi-value-params bodies, the body's input params are pre-spilled at body entry and reloaded inside POST_0 to bridge the `Simple(None)` POST_K typing. |

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
- Activation-owned tagged-catch arm and scalar payload state.
- Catch-handler reconstruction by throwing the saved static tag.

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
simplified for readability; the actual output includes linked-node hook calls,
default values for result types, and preserved source locations.

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
      ;; Request the next committed payload, then restore frame fields and
      ;; locals. call_index remains in the frame payload header.
      ...))

  ;; [2] Body wrapper: runs on NORMAL; on REWINDING, dispatch jumps to
  ;;     the matching post-call site using frame.call_index.
  (block $unwind_save
    (block $POST_0
      (block $dispatch_normal
        (if (i32.eq (global.get $_wpk_fork_state) (i32.const 2 (; REWINDING ;)))
          (then
            ;; Load frame.call_index from *(buf + 0) + 4.
            ...
            (br_table $POST_0 $unwind_save))))
      ;; chunk 0 would run here on NORMAL only.
    )
    ;; [3] Wrapped call site.
    call $fork
    ;; [4] Post-call unwind check: if callee returned in UNWINDING,
    ;;     write frame.call_index and jump to postamble.
    (if (i32.eq (global.get $_wpk_fork_state) (i32.const 1 (; UNWINDING ;)))
      (then
        ;; *( *(buf + 0) + 4 ) = 0
        ...
        (br $unwind_save)))
    (return))

  ;; [5] Postamble: finish writing the already-reserved node's frame header
  ;;     and serialized locals, commit it, then return a default result.
  ...
  (return (i32.const 0)))
```

Numbered callouts:

1. **Preamble (Phase 4d).** Every instrumented function opens with a state
   test. Under `REWINDING`, the preamble calls
   `__wpk_fork_frame_next(frame_size)`, stores the returned payload in
   `*(buf + 0)`, and deserializes every frame scalar: user locals,
   argument/carryover spills, and tagged-catch activation state. Dispatch reads
   `call_index` directly from that active frame payload.
2. **Body wrapper (Phase 4b/4c).** The original body is wrapped in a `$unwind_save`
   block. On `REWINDING`, a `br_table` keyed by `frame.call_index` jumps to
   the selected post-call landing. On `NORMAL`, dispatch falls through and
   executes the original chunks.
3. **Wrapped call site (Phase 4c).** The original call is kept intact. After
   the call returns in `UNWINDING`, the tool reserves the function's complete
   frame node before its first write, stores the returned payload pointer in
   `*(buf + 0)`, and writes the call site's `call_index` to `frame[+4]`.
4. **Unwind bridge (Phase 4c/4d).** The unwind-only branch writes
   `frame.call_index` and exits `$unwind_save`. If the callee did not begin
   unwinding, execution continues normally.
5. **Postamble (Phase 4d).** Emits the remaining frame header fields
   (`func_index`, `catch_region_id`, and a zero reserved word), writes every
   user and synthetic frame scalar, commits the reserved node, and returns a
   default value of the function's result type. Callers see the default on the
   unwind path but discard it because their own postamble runs next.

### (b) Fork from inside a catch handler

Fixture: `FIXTURE_FORK_FROM_CATCH_HANDLER` (see
`fork_from_inside_catch_handler_full_roundtrip`). Before instrumentation:

```wat
(func $caller (result i32)
  (local $caught i32)
  (block $handler (result i32 exnref)
    (try_table (result i32 exnref) (catch_ref $exn $handler)
      i32.const 7
      throw $exn))
  drop
  local.set $caught
  call $fork)
```

After instrumentation the `CatchRef` clause targets an injected capture block
and the try_table body gets a rewind-throw stub. The exact emitted nesting is
omitted here; the important dataflow is:

```wat
;; Inside the original try_table body:
(if (i32.and
      (i32.ge_u (global.get $_wpk_fork_state) (i32.const 2))
      (i32.eq (local.get $catch_region_id) (i32.const 1)))
  (then
    (if (i32.eq (local.get $active_arm) (i32.const 0))
      (then
        ;; The frame restored 7 (or the actual scalar payload).
        local.get $saved_payload
        throw $exn)
      (else unreachable))))

;; On CatchRef dispatch, stack = (i32 payload, non-null exnref):
local.set $temporary_exnref
local.set $saved_payload
i32.const 0
local.set $active_arm
i32.const 1
local.set $in_catch
i32.const 1
local.set $catch_region_id

;; Forward the original handler values, but retain no synthetic GC root.
local.get $saved_payload
local.get $temporary_exnref
ref.as_non_null
ref.null exn
local.set $temporary_exnref
br $handler
```

Numbered callouts:

- **Rewind-throw stub.** On replay with a matching `catch_region_id`, dispatch
  validates the restored arm index, pushes that arm's restored scalar payload,
  and executes `throw $tag`. The original `CatchRef` clause catches this new
  exception and creates a fresh exnref in the child instance.
- **Capture block.** Every statically tagged `Catch` and `CatchRef` clause is
  retargeted through a per-arm capture. It stores only the arm index and scalar
  payload in frame-backed locals. A `CatchRef` exnref is temporarily forwarded
  to the original handler; the synthetic local is nulled before the branch so
  successful replay and abort paths do not retain a stale GC root.
- **Call-site region writes.** A call inside the handler observes the
  activation-local `$in_catch_K` flag and records the lexical region in the
  frame before unwinding. There is no reference slot or module-global
  reference state.

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
        (if (<unwinding check>)
          (then
            ;; frame.call_index = 0
            (br $unwind_save))))
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
the IfElse has to leave the original cond on the stack. The default fix:

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
push (state >= REWINDING)    ;; ordinary or abort replay
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

When the original condition is produced by a pure scalar suffix such as
`local.get $depth; i32.eqz`, the suffix is removed from the NORMAL chunk and
replayed in the post-landing sequence instead of allocating `cond_swap_local`
or a frame-backed carryover local. If the condition is not pure, or if an
`IfElse` landing also needs extra carryover values below the condition, the
spill-local path above remains the fallback.

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

### 4. Pure scalar materialization

Before allocating call-argument or sub-region carryover locals, the transform
checks whether the values at the landing are produced by a suffix that can be
replayed from an empty stack. The whitelist is deliberately small:

- scalar constants and scalar `local.get`;
- non-trapping i32/i64 unary ops such as `eqz`, `clz`, `ctz`, `popcnt`, and
  integer extends;
- non-trapping i32/i64 binary arithmetic, bit operations, shifts, rotates, and
  integer comparisons.

The whitelist excludes calls, memory/table operations, globals, reference
operations, integer div/rem, floating-point operators, `local.set`/`local.tee`,
and any instruction that needs stack input from before the suffix. Unsupported
or type-mismatched suffixes fall back to the existing spill-local path. This
keeps REWIND behavior tied to the same post-call/post-landing sequence while
avoiding frame locals for common compiler shapes like recursive
`walk(depth - 1)` arguments and `eqz(depth)` branch conditions.

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

## Reference and table-state validation

ABI 43 retires `_wpk_fork_funcref_stash`,
`_wpk_fork_externref_stash`, and `_wpk_fork_exnref_stash`. The tool never
emits them. Static slots were unsafe twice over: recursive/reentrant
activations could alias, and every fork child starts from a fresh module
instance whose tables are empty. JavaScript cannot generically transfer
`funcref`/`externref` across workers or Stores, and the Table API cannot copy
`exnref`.

Validation runs after fork-closure discovery and before runtime injection. In a
fork-reachable function it rejects:

- reference locals, parameters, function signatures, global reads, call
  signatures, and operand-stack carryovers;
- `CallRef`/`ReturnCallRef`, unsupported nonnullable/concrete/GC reference
  instructions, and reference-typed catch tag payloads;
- `CatchAll` and `CatchAllRef`, because there is no static tag identity to save.

Reference-bearing functions outside the fork closure remain legal and are not
rewritten. Mutable reference globals are rejected module-wide in a
fork-capable module because code outside the closure may mutate them before a
later call into `fork()`.

Wasm table mutation is likewise module-instance state. If a module can fork,
the presence of `table.set`, `table.fill`, `table.copy`, `table.init`, or
`table.grow` anywhere in its local functions rejects the artifact. Active
static element initialization remains legal because instantiation recreates
it. Dynamic linking is an explicit host-owned reconstruction boundary rather
than an exception to this rule: the dlopen archive preserves each side
module's exact table base, the child replays libraries in order, and normal
side-module instantiation recreates their static elements. A different table
mutation owner must define and test an equally deterministic recipe before
the instrumenter may accept it.

## Catch-handler resume

Catch-handler resume saves a reconstruction recipe, never an exception
reference. Normal handler entry records the lexical region, exact catch-list
arm, and that static tag's scalar payload in activation-owned locals. Those
locals serialize with the function frame. Rewind dispatches inside the same
`try_table` body, restores the selected scalar tuple, and executes the
selected arm's `throw $tag`. Normal Wasm exception dispatch reaches the
original clause; `CatchRef` receives a new exnref owned by the child instance.

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
                        │  unwind: save region K, arm A,
                        │          and scalar tag payload in this frame,
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
│       validate arm A; push saved scalar payload; throw $tag_A      │
│     ← caught by the original Catch/CatchRef clause; CatchRef       │
│       creates a fresh child-instance exnref.                       │
│                                                                    │
│   handler-level preamble (state still REWINDING):                  │
│     resume at the fork() call site with return value = child pid 0 │
│                                                                    │
│   state := NORMAL, execution continues                             │
└────────────────────────────────────────────────────────────────────┘
```

Mixed `Catch`/`CatchRef` lists, multiple arms, and distinct target labels use
the same exact catch-list index. An unknown restored index executes
`unreachable`; it cannot fall back to old instance state. `CatchAllRef` is
rejected, as are reference-typed tag payloads and a caught exnref that remains
live in a local or operand-stack carryover at the fork call. See
[Fork from a tagged catch](#fork-from-a-tagged-catch) under "Maintainer notes"
for the implementation.

## Call-graph discovery

Instrumentation only rewrites functions that can transitively reach the
designated async import (default: `kernel.kernel_fork`). The discovery
algorithm in `crates/fork-instrument/src/call_graph.rs`:

1. Seed set `S` = { the imported `kernel.kernel_fork` function }.
2. **Direct reverse closure.** For every newly discovered callee `g`, add
   every local function that directly calls `g`.
3. **Indirect reverse closure.** If `g` can be dispatched from a function
   table, add every local function that performs `call_indirect` or
   `return_call_indirect` against the same table with a structurally matching
   function type.
4. Repeat steps 2–3 until the worklist is empty.

The output is a function-set `S` that gets instrumented. All other functions
pass through unmodified.

The host-parsed marker exports `__abi_version`,
`__wasm_posix_thread_slots`, and `__get_channel_base_addr` also remain
unmodified even if call-graph discovery includes them in `S`. The host reads
their wasm-ld wrapper bodies directly and does not use them as fork
continuation roots.

The indirect-call step is a may-analysis, but it is slot-sensitive when the
Wasm proves enough facts. Active element segments with constant offsets
populate known table slots. A `call_indirect` whose table index is a literal
`i32.const` or a folded constant `i32.add`/`i32.sub` expression can dispatch
only to that slot, so a same-signature fork-path target in a different slot
does not pull in the caller. Dynamic indexes remain conservative: if the table
contains a matching fork-path target anywhere, the caller stays in `S`.

Unknown table state also remains conservative. Passive segments count only for
tables that can receive them via `table.init`; because the destination range is
not modeled, their functions are table-wide. Declared segments do not populate
a table. Dynamic table writes (`table.set`, `table.fill`, `table.grow`) make
the table unknown, so any matching-signature fork-path target may be reachable.
`table.copy` propagates known and unknown source-table state to the
destination.

This is enough for registered callback paths such as signal handlers, pthread
cleanup handlers, `atexit` handlers, and qsort-style comparators in the current
libc output. The broader "instrument every address-taken function" rule from
the original C3 plan was not needed for this PR and was not added; K-01, K-02,
K-04, and K-07 cover the current behavior.

## Guarantees and non-guarantees

### Guaranteed

- **Call stack.** Every fork-path function's call stack position is
  serialized as a frame (func_index + call_index) and reconstructed during
  rewind. The child resumes at the exact call site from which the parent
  invoked `fork()`.
- **Scalar user locals.** All i32, i64, f32, f64, and v128 locals on the
  fork-path are saved to linear memory at unwind and restored at rewind.
- **Fresh-instance ownership.** Every accepted replay value is either scalar
  activation state in the linked continuation or state rebuilt by an explicit,
  versioned reconstruction owner. Instrumented modules carry
  `FORK_CAP_ACTIVATION_STATE_SAFE`; ABI 43 hosts and artifact guards reject a
  fork-shaped artifact without that capability before execution.
- **Byte-reproducible instrumentation.** Given the same input bytes, CLI
  options, and built tool, separate processes emit byte-identical Wasm.
  Synthetic locals and nested regions are assigned in canonical sequence-ID
  order rather than randomized hash-map iteration order.
- **Mutable scalar globals.** Snapshotted in
  `wpk_fork_unwind_begin` and restored in `wpk_fork_rewind_begin`.
  Includes `__stack_pointer`, `__tls_base`, and any program-declared
  mutable globals.
- **try_table context.** Frames captured inside a supported fork-path catch
  handler carry the active `catch_region_id`, exact catch-list arm, and scalar
  tag operands. Rewind rethrows the restored tag and operands through the
  original `Catch` or `CatchRef` clause. A `CatchRef` clause therefore creates
  a fresh exnref in the child instance; no parent-instance reference is
  serialized or consulted.
- **No retained replay references.** The instrumenter emits none of the
  historical `_wpk_fork_*ref_stash` tables. The temporary exnref used while a
  `CatchRef` handler enters is cleared immediately after the original handler
  value has been re-pushed, so normal completion, rewind, and abort do not
  retain it as an instrumentation-owned GC root.
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
- **Reference activation state.** Reference-typed locals or parameters,
  reference function signatures and call carryovers, reference global reads,
  reference operand-stack carryovers, and reference-typed catch payloads are
  rejected when they are in the conservative fork closure. `CatchAll` and
  `CatchAllRef` are also rejected there because they provide no statically
  tagged scalar reconstruction recipe. References in functions outside the
  fork closure remain legal.
- **Module-owned mutable reference state.** A mutable reference global is
  rejected whenever a module has a fork closure. The child receives a fresh
  module instance, so copying linear memory cannot reproduce that global.
- **Mutable table state.** Guest `table.set`, `table.fill`, `table.copy`,
  `table.init`, and `table.grow` are rejected in a fork-using module. Static
  element initialization is recreated by instantiation and remains supported.
  Host-owned dlopen replay is a separate explicit reconstruction boundary: it
  preserves the exact table base and re-instantiates the side module's static
  elements in the child.
- **IfElse with operand-stack carryover.** A fork-bearing `if/else`
  enclosing a stack value that survives across the branch is rejected by
  `seq_has_unsupported_carryover` — the cond rewrite via `select` (see
  §IfElse cond rewrite) doesn't currently compose with carryover spilling.
  Rare in LLVM output; not tracked as a current blocker.
- **Non-nullable, concrete, and Wasm-GC refs.** Unsupported reference
  construction and GC operations in the fork closure are rejected before
  rewriting. Support requires an activation-owned byte representation or a
  deterministic fresh-instance reconstruction recipe, not a new module-static
  table.
- **Current C++ cleanup-EH shapes.** LLVM output that keeps exnref locals live
  across fork or lowers cleanup regions to `CatchAllRef` is intentionally
  rejected. Those programs must remain unavailable in ABI 43 until the
  compiler output or replay design satisfies the ownership invariant; a
  capability stamp or package patch must not hide this boundary.

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

Linked continuations add three imported host calls per saved activation over a
complete fork cycle: reserve and commit while unwinding, then next while
replaying. Each saved activation also carries a 24-byte node header on wasm32
or a 32-byte node header on wasm64, rounded together with the payload to an
8-byte boundary. Each active module continuation uses at least one 64 KiB
page-rounded anonymous mapping; another mapping is added only when the current
chunk cannot hold the next complete node. An individual frame larger than a
Wasm page is allocated in a correspondingly larger page-rounded chunk.

ABORT_UNWINDING adds one i32 local and a result-typed restart-loop guard to each
transformed function, a zero-reservation branch at each fork-path call site,
two control exports, and a 16-byte root-prefix selector. This code executes
only on replay checks or allocation failure; ordinary execution adds the local
and loop structure but does not allocate continuation memory.

The module-format fixed cost is three imports, two abort exports, plus the
24-byte `kandelo.wpk_fork.linked_frames` descriptor and normal Wasm section/name
encoding. The fixed 60 KiB host-reserved control-region geometry remains in
place from ABI 42, but it is no longer continuation capacity: only its anchor
word is used to find the dynamically allocated root chunk.

A function with supported tagged catches adds one i32 `active_arm` local per
region plus typed scalar operand locals for every supported `Catch` or
`CatchRef` arm to each activation's frame payload. This can use more aggregate
continuation bytes than one module-global tuple, but distinct activation
storage is required for recursion and reentrancy correctness and avoids any
module-global replay tuple.

As a narrow size check, instrumenting the P-10 deep-recursion fixture from the
same 27,886-byte raw Wasm produced 50,873 bytes with the ABI 41 instrumenter
and 52,330 bytes with the ABI 42 linked-frame instrumenter: 1,457 additional
bytes (2.86%). This is one small fixture, not a general application-size
claim; the fixed import/metadata cost and the number of transformed call sites
change the percentage substantially between programs.

Using the same dev-shell compiler invocation on 2026-07-21, the current P-10
source produced a 27,608-byte raw module. Commit `a4789e2c6` (linked frames
before abort recovery) instrumented it to 52,052 bytes; ABORT_UNWINDING
instrumented the identical raw input to 58,370 bytes. The recovery state
machine therefore added 6,318 bytes (12.14%) to this instrumented fixture.
P-10 deliberately creates a very large conservative fork-path closure, so this
is a stress-fixture result rather than a general package-size estimate.

Performance comparisons must use the fork-heavy benchmark suites with
`npx tsx benchmarks/run.ts --rounds=3` on both the Node.js and browser hosts.
The suites that exercise fork meaningfully are `wordpress`, `erlang-ring`,
and `process-lifecycle`. Do not infer a regression percentage from the
structural costs above.

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

A leading `loop ... block ... block ... if (state >= REWINDING) ... br_table ...`
shape at the function's entry means switch-dispatch is active. A historical
`block $unwind_save` followed by per-call `(state == NORMAL || (REWINDING &&
call_idx == K))` if-elses means an old guard-dispatch binary is being
inspected, not current PR output.

To distinguish top-level switch-dispatch from nested switch-dispatch,
look inside the enclosing instructions: nested switch-dispatch emits the
same `if (state >= REWINDING) ... br_table ...` shape inside any
fork-bearing `block` / `loop` / `if` / `try_table`, plus a `select`
rewriting any fork-bearing IfElse's condition afterwards. Impure IfElse
conditions also show a `local.set $cond_swap_local` at the end of the
preceding chunk; pure condition suffixes are replayed at the post-landing
instead. Top-level switch-dispatch has only the function-level dispatch and
never touches a sub-region's body.

Carryover-spilling at a SubRegion landing shows up as a pair of fresh
i32 locals (recorded in the function's frame): the chunk inside `POST_K`
ends with `local.set $spill_local`, and after the enclosing instruction
the post-landing sequence emits `local.get $spill_local` (and, when the
enclosing instr returns an i32, a brief juggle through `tmp_result_local`).

Nested switch-dispatch coverage lives in
`tests/switch_dispatch.rs::nested_fork_call_uses_per_block_switch_dispatch`
and the carryover-spilling / pure-materialization fixtures alongside it. Add
new regressions there or in `host/test/fork-instrument-coverage.test.ts`
depending on whether the bug is a tool-level transform issue or an end-to-end
host/runtime issue.

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

### Supporting additional reference state

Do not add a module-static reference stash. A fresh fork child has a new Wasm
instance, table, Store, and exception-tag identity, so a slot number is not a
transferable value even if it happens to fix same-instance recursion.

Support for a new reference shape requires one of two complete designs:

1. Encode every value needed by replay as versioned activation-owned bytes in
   the linked continuation, then reconstruct the reference deterministically
   in the child.
2. Name an explicit host reconstruction owner, version its recipe, and prove
   Node, browser, pthread, and side-module parity.

Add rejection tests first, then fresh-instance replay tests that would fail if
the parent module's globals or tables were consulted. Update the capability
contract and bump the ABI if the accepted artifact surface or reconstruction
format changes.

### Extending side-effect coverage

There is no live side-effect gating path after guard-dispatch removal. If a
new wasm opcode can appear before a fork-path call, add coverage that proves
the containing switch-dispatch shape skips that opcode on REWIND. Existing
examples are the S-01..S-08 host fixtures plus the WAT-level table-operation
tests in `crates/fork-instrument/tests/coverage_wat.rs`.

### Fork from a tagged catch

`Catch` arms unwrap the thrown exception's operand tuple at handler entry.
`CatchRef` arms additionally push an instance-local exnref. Neither reference
identity nor module scratch is available in a fresh child, so both forms replay
from the same statically tagged scalar recipe.

The implementation adds that path without accessing continuation memory during
ordinary catch execution:

1. **Static discovery (`plan_plain_catches`).** Walk each fork-path
   function and collect each supported `Catch` or `CatchRef` arm's tag, target
   label, exact catch-list index, kind, and scalar operand types. This plan has
   no runtime addresses or activation state.
2. **Activation allocation.** Allocate one region-local i32 arm selector plus
   typed scalar operand locals for every supported arm. A `CatchRef` arm also
   gets one temporary nullable exnref local used only while entering the
   capture block.
3. **Frame ownership.** Append the selector and scalar operands before frame
   offsets are assigned. Each recursive or reentrant activation therefore
   owns a distinct serialized catch recipe.
4. **Capture.** A generated block stores the incoming scalar tuple and exact
   arm index, then restores the original handler stack. For `CatchRef`, it
   temporarily stores the exnref, pushes it back as non-null for the original
   target, and clears the synthetic local immediately so instrumentation does
   not retain a stale GC root.
5. **Replay.** `inject_rewind_throw_stubs` dispatches on the restored exact arm
   index, pushes its scalar tuple, and executes `throw` with the original tag.
   The original clause then reconstructs either the plain payload or a fresh
   child-local exnref. An unknown arm traps instead of consulting old instance
   state.

The lifetime boundary is load-bearing: a catch can run before any fork or
after a prior continuation has been released. Its normal capture path must
therefore never dereference `_wpk_fork_buf`.

C-08/C-09 in
`crates/fork-instrument/tests/coverage_wat.rs` verify that funcref and
externref catch operands are rejected precisely rather than serialized as
scalars or placed in a module-static table.

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
