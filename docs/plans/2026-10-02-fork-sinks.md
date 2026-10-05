# Fork sinks: measurement and design (research, decision gate)

Status: research complete through the design; nothing in `crates/`, `sdk/`,
`libc/`, `host/`, `flake.nix` or package recipes has changed. This document
stops at a decision gate for the maintainer.

## Why

`wasm-fork-instrument` rewrites every function that can be on the call stack
when `kernel.kernel_fork` runs, so that a fork can save and rebuild that
stack. In C++ programs that set is most of the program: Quickshell's
instrumenter input has 65,901 functions and the shipped instrumenter
rewrites 51,942 of them. After PR #1462 the file without names grows from
29.4 MB to 51.4 MB, and the code section from 16.6 MB to 38.0 MB. Browsers
compile all of it.

Another developer's agent proposed "fork sinks". After `fork()`, the child
often ends in a function that never returns to its caller: it calls `_exit`
or `exec*`, or it stops at `std::terminate`, `abort` or `unreachable`. Call
that function the sink. Frames above the sink never run again in the child,
so, the proposal argues, they need no rewrite. It reported that a prototype
brings Quickshell down to 6 rewritten functions and git-remote-http down to
at most 4.

This research checks that claim, measures what sinks really buy under sound
rules, and designs the mechanism that would make them usable.

## Summary for the decision

1. **The proposal needs a different fork mechanism.** Today the *parent*
   also unwinds its whole stack at fork and replays it afterwards
   (`parent-replay` in `host/src/fork-process-continuation.ts`). A sink only
   proves the *child* never returns above it. The parent does return:
   `QProcess::startDetached` returns into the event loop. Leaving frames
   above the sink uninstrumented corrupts the parent under today's
   mechanism. So no analysis alone can reach the proposal's numbers.
2. **A mechanism that fits exists and reuses what ships.** The parent unwinds
   only from `kernel_fork` up to the sink frame. The sink records itself,
   forks through a host import, and replays its own callees in place. The
   generated code's existing abort-restart loop already does that kind of
   restart. The child starts at the sink. There is no cost on the ordinary
   path. This is a **bounded unwind** (design below). The prompt's "capture
   without unwinding" (spilling locals at every call) is the alternative. It
   gives the same instrumented set but needs a new transform and puts work
   on every call. The bounded unwind is recommended.
3. **The proposal's numbers are reproduced, but only under named
   assumptions.** The analysis gives exactly **6** functions for Quickshell
   (shipped-shape input) and **4** for git-remote-http (link). That result
   needs all of the following:
   - (a) a run-time gate that makes a fork inside a signal handler fail when
     its child would return into the interrupted code;
   - (b) a run-time check that fails loudly when an exception or longjmp
     leaves a sink frame in the child;
   - (c) for Quickshell, a libc/crt change so that `main` is called directly
     instead of through the function table.

   Without (b), the same runs give 43,097 and 8,199. Without (c), Quickshell
   gives 43,015. (a) was on in every run that produced 6 and 4; no run
   without it was made. Each is a platform change with a behavior boundary,
   and none is free (see [Rule sets](#rule-sets-and-soundness-labels)).
4. **Without the run-time exception check, sinks help C programs that fork
   and exec, given type facts. Quickshell gains little.**
   - git, typed, with no run-time boundary at all: **25** instead of 5,293.
     Its oracle passes, but the typed label carries the caveat in item 5.
   - foot, typed plus the signal gate: **4** instead of 2,994.
   - Quickshell, gate plus `main-direct` but no run-time exception check:
     **43,097** on the shipped shape, against 51,942 today.
   - Interpreters keep most of their instrumentation, because their fork
     children really return through their callers (rule 4). Under the gate:
     bash 1,940 → 1,220, python 9,166 → 8,569, ruby 9,755 → 8,979, and php
     20,369 → 19,796.
5. **Precision is the real constraint, not the sink idea.** The sink is
   blocked by indirect calls resolved by Wasm signature:
   - `void(int)` and `void(void*)` are the same Wasm type;
   - `main` is a table entry, so every `(i32,i32)->i32` call can "reach" a
     daemonizing fork;
   - any longjmp or C++ throw reachable through such a call makes every
     child path "may throw".

   The oracle also caught a soundness hole in CFI-typed resolution: foot's
   `main(int, char *const *)` is called through musl's `int(*)(int, char**)`
   pointer. Type facts therefore need generalized pointer types before they
   can be trusted.

Recommendation: approve the bounded-unwind design and the musl registry,
cancellation and parameter rules (all sound). Decide separately on each
behavior boundary: the signal gate, the run-time exception check, and the
crt `main` change. The vfork-without-instrumentation lane should fold into
this design instead of running separately (see [vfork](#vfork)).

## The prototype and its numbers

The prototype could not be obtained. The proposal reached this repository
only as a forwarded paragraph pasted into the fork-path-precision
session (ljubljana). No branch, file, PR, issue or agent transcript on this
machine or on `Automattic/kandelo` contains the prototype or its data.
Its numbers are therefore reconstructed here by measurement:

- "Quickshell: 6" equals this analysis on the shipped-shape module under
  rule set `runtime` plus the `main-direct` what-if:
  - open: `fork`, `main` (its daemonizing child returns);
  - sinks: `QProcess::startDetached`, `QChildProcess::startChild`,
    `_dbus_connection_open_internal`, `libc_start_main_stage2`.
- "git-remote-http: at most 4" equals rule set `runtime`:
  `start_command` and `start_async` (sinks), plus `fork` and `_Fork`.

Both counts assume the parent does not unwind above the sink. So they
describe a new mechanism, not today's. Both also assume that exceptions in
the child are not an obstacle. The analysis shows statically that they
are, in both programs:

- git-remote-http links curl, whose SIGALRM handler `alarmfunc` calls
  `siglongjmp`. Curl's SSL-backend initializer makes an indirect call the
  plugin cannot type, which falls back to signature matching and can reach
  that handler.
- Quickshell's child path can reach `_exit` → … → `__pthread_exit` → `exit`
  → `__funcs_on_exit` → `__cxx_global_array_dtor` → … → `__wasm_longjmp`.
  The route needs cancellation (Quickshell links `pthread_cancel`) and an
  untyped destructor dispatch.

So "at most 4" is not sound unless rule 2 is enforced at run time.

## What a sink is (the analysis)

Tool: `tools/fork-sink-research/fsa` (Rust, walrus). For every function on
the fork path it runs a constant-propagating abstract interpreter over the
Wasm body. The interpreter starts right after each call that can reach
`kernel_fork`, with the child-side result of that call:

- `kernel_fork` returns 0 in the child;
- every caller's child-side return value is computed from its own body, to
  a fixpoint. `_Fork` gives 0, Qt's `forkfd` gives `FFD_CHILD_PROCESS` (-2),
  and so on.

The starting state is the normal-mode state at that call site. That is
sound: the child's frame holds exactly the parent's locals at that call.

A function is **closed** (a sink) when, in the child, no `return` is
reachable and no exception escapes. Otherwise it is **open**. The
instrumented set under sinks is every function with a fork-reaching call
whose callee is open (or is `kernel_fork`). Closed functions stop the
upward walk.

The interpreter models:

- constants, unmodified parameters, and exception tags carried by exnrefs;
- `-O0` frame slots relative to `__stack_pointer`, trusted only while the
  frame address never escapes. foot and python ship their fork glue at
  `-O0`;
- call specialization: a small callee with constant arguments is evaluated
  for exactly those arguments. This is how `-O0`'s
  `__wasm_posix_finish_fork(0)` yields 0;
- whole-program "may return" and "may throw (which tags)" summaries;
- `try_table` catch clauses, `throw_ref`, and legacy `try`.

Fixtures in `fsa/tests/` check the soundness-critical cases:

- sink vs. a child that returns;
- an escape caught above vs. not caught;
- an `-O0` slot round-trip vs. an escaped frame address;
- an indirect call in the child;
- parameter refinement.

Rules 1-5 of the brief map onto this as follows:

| Rule | How the analysis enforces it |
|---|---|
| 1. Proven on the child branch | The interpreter starts after the fork-reaching call with the child-side value (0, -2, ...), so only the `pid == 0` side is explored. |
| 2. No exception or longjmp crosses the sink | Static tag summaries (C++ `__cpp_exception` and `__c_longjmp` are both Wasm tags in Kandelo). Any escaping tag keeps the function open, unless the rule set moves rule 2 to a run-time check. |
| 3. atexit, static destructors, atfork child handlers and signal handlers stay below the sink | They are ordinary calls in the child path (`exit` → `__funcs_on_exit`, `fork` → `__fork_handler`, every syscall → libc's signal dispatch), so their returns and throws are analyzed like any other call. |
| 4. Daemonizing forks are not sinks | Falls out: `daemonize`, `qs -d` (`qs::launch::runCommand`), bash `make_child`: their child returns, so they are open and keep full instrumentation for their chain. |
| 5. Unfollowable function pointers stay conservative | Indirect calls resolve to every table function of the same structural signature unless a refinement below proves fewer. Every refinement names its assumption. |

### Rule sets and soundness labels

| Rule set | Adds | Label |
|---|---|---|
| `strict` | signature-only indirect targets; signal handlers like any `call_indirect`; rule 2 static | **sound** (same assumptions as today's instrumenter) |
| `gate` | musl registries, `param`, `cancel`, and the **signal gate** | **sound given the gate**. The gate is a behavior boundary: a fork from inside a signal handler whose child would return into the interrupted code fails (see [Signals](#pending-signals-and-handlers)). |
| `equiv` | `gate`, plus rule 2 by run-time check only where no frame that can be above the sink has any catch clause for the escaping tag | **sound given the gate**, no further behavior change: such an escape reaches the stack root today too |
| `runtime` | `gate`, plus rule 2 by run-time check at every sink | **sound given the gate and the check**. Boundary: an exception or longjmp that leaves a sink in a fork child, and that Linux would catch in a frame above, fails loudly instead. |
| `+typed` | indirect targets from ljubljana's plugin v3 (CFI icall and vcall type ids, registries) | **unsound as measured**: the oracle found `main` called through a differently-typed pointer (foot). Needs generalized pointer types. |
| `+main-direct` | `main` is reached only from the start routine | **what-if**: needs a libc/crt change (call `main` directly). The instrumenter can check mechanically that `main` is not in the table. |

Assumptions common to every rule set, including `strict`:

- Host imports do not throw guest-catchable exceptions, except on fatal
  integrity errors. The fork unwind tag is thrown by generated code, not by
  an import.
- A write through a pointer into a stack frame whose address never escaped
  is undefined behavior. This is what makes `-O0` frame-slot tracking sound.
- A call that may enter a dlopen'd side module is opaque: its child returns
  anything and may throw any tag.
- Unsupported instructions (GC, wide arithmetic; none appear in the corpus)
  make the whole function conservative.

Refinements used by `gate` and above, all mechanically checked:

- **musl registries.** `__fork_handler` dispatches only functions passed to
  `pthread_atfork`; the same holds for `__funcs_on_exit` and `__cxa_atexit`,
  `__pthread_once_full` and `pthread_once`, TSD destructors and
  `pthread_key_create`, and cleanup handlers and `_pthread_cleanup_push`.
  This was checked against `libc/musl`; Kandelo has no overlay for these
  files. A registry applies only when every call of the API is a direct
  call with a constant callback. Where the API was inlined into its own
  source file (`__cxa_atexit` into `atexit`), the stored constants are read
  from that file.
- **cancel.** musl writes `pthread_t->cancel` only in `pthread_cancel` and
  in `timer_create`'s SIGEV_THREAD worker. With neither linked, the
  cancellation checks never reach `pthread_exit`. Quickshell links
  `pthread_cancel`, so the rule does not apply there.
- **param.** A `call_indirect` through an unmodified parameter of a
  function that is only ever called directly resolves to the constants its
  callers pass. Example: forkfd's `childFn`.
- **const-slot.** A constant table index names one slot when the table is
  never mutated.

## Measurements

### Inputs

Inputs are the read-only ljubljana corpus:

- pre-`wasm-opt` links with names and plugin v3 side files (`.context/fpr/shims`);
- shipped-shape named instrumenter inputs (`.context/fpr/shape3`);
- the named Quickshell shipped input
  (`st-georges/.context/qsmap/quickshell.named.wasm`), the 29.4 MB → 82.2 MB
  build the proposal quoted;
- oracle stacks recorded at `kernel_fork` (`.context/fpr/oracle`).

"today" is `fork_instrument::call_graph::analyze_reaching_closure`, the
shipped analysis.

### Instrumented functions (signature-level, links unless noted)

| Program | today | strict | gate | equiv | runtime |
|---|---:|---:|---:|---:|---:|
| git-remote-http | 8,659 | 8,624 | 8,199 | 8,199 | **4** |
| foot | 2,994 | 2,883 | 2,368 | 2,368 | **4** |
| waybar | 32,946 | 32,764 | 30,207 | 30,207 | **6** |
| qtgallery | 26,586 | 26,254 | 17,030 | 17,030 | **7** |
| git | 5,293 | 5,106 | 4,553 | 4,553 | 4,553 |
| bash | 1,940 | 1,937 | 1,220 | 1,220 | 1,203 |
| python | 9,166 | 9,163 | 8,569 | 8,569 | 8,552 |
| ruby | 9,755 | 9,691 | 8,979 | 8,979 | 8,490 |
| php | 20,369 | 20,354 | 19,796 | 19,796 | 19,743 |
| php-fpm | 20,530 | 20,514 | 19,907 | 19,907 | 19,853 |
| quickshell (shipped shape) | 51,942 | 51,680 | 43,097 | 43,097 | 43,015 |
| quickshell (shipped shape), `+main-direct` | | | 43,097 | 43,097 | **6** |

"today → gate" without sinks (the refinements alone) is reported per run as
`closure_same_rules_no_sinks`. For example, git-remote-http goes 8,659 →
8,260 and Quickshell 51,942 → 45,735. The rest of each drop is the sinks.

Read the `runtime` column with its boundary in mind. For waybar, qtgallery,
foot and git-remote-http, every sink found has a possible catch frame
above it under the conservative classifier, which counts C++ cleanup pads.
Their `runtime` numbers therefore rely on the loud check being an
acceptable boundary.

### With type facts (`+typed`, links)

| Program | today | strict | gate | equiv | runtime |
|---|---:|---:|---:|---:|---:|
| git | 5,293 | **25** | 25 | 25 | 25 |
| foot | 2,994 | 1,024 ✗ | **4** | 4 | 4 |
| git-remote-http | 8,659 | 8,285 | 7,136 | 7,136 | 4 |
| qtgallery | 26,586 | 25,934 | 14,845 | 14,845 | 7 |
| waybar | 32,946 | 32,505 | 28,828 | 28,828 | 6 |
| bash | 1,940 | 1,937 | 1,220 | 1,218 | 1,203 |
| python | 9,166 | 9,097 | 8,200 | 8,200 | 8,157 |
| ruby | 9,755 | 9,537 | 8,432 | 8,431 | 7,978 |
| php | 20,369 | 20,354 | 19,796 | 19,796 | 19,743 |
| quickshell (link) | 108,860 | 107,787 | 72,335 | 72,335 | 72,295 |
| quickshell (link), `+main-direct` | | | | 72,335 | **11** |

✗ = **oracle-unsound**. foot's observed stack `_Fork → fork → slave_spawn →
term_init → main → libc_start_main_stage2 → __libc_start_main → _start`
needs the last three, and the typed set drops them. The CFI type of
`int main(int, char *const *)` differs from the `int(*)(int, char **)`
pointer musl calls it through. Every `+typed` number inherits that
assumption. Under `gate` and above, foot is not affected, because
`slave_spawn` closes below `main`.

git is the clean case. Its sinks are `start_command`, `start_async`,
`bidirectional_transfer_loop` and `handle_builtin`; `handle_builtin` calls
`exit(run_builtin(...))`. What stays open is the genuinely detaching
paths: `daemonize`, reached from `cmd_gc` and maintenance through the
builtin table. The git link has no exception tag and no `throw` at all, so
rule 2 holds trivially, and the result needs neither the gate nor the
run-time check.

### Oracle (stacks really observed at `kernel_fork`)

The check walks each observed stack from `kernel_fork` upward and requires
every frame up to the first closed one to be in the set.

- **Signature-level:** every rule set passes on every stack: bash 28, git 8,
  python 9, ruby 17, foot 1.
- **Typed:** foot `strict` fails (above).
- **Frames really needed** (rule set `runtime`):
  - bash: 32 distinct of 34 observed;
  - git (typed): 3, namely `start_command`, `fork`, `_Fork`, on all 8
    stacks;
  - foot: 3 of 8.

The oracle checks the parent's stack only. **Not checked:** that a child
really never returns above the sink. No fork child was traced.

### Shipped-shape sizes

Measured with an experiment build of today's instrumenter (this worktree,
including #1462) and an exact-name allowlist. Sizes are code section / file
without name, DWARF and producers sections, in bytes. "floor" instruments
nothing: runtime scaffolding plus walrus's dead-function removal. It is the
right baseline, because walrus drops unused functions from the raw link, so
foot's raw input is larger than its floor.

| Program | input | floor | today | gate | runtime | other |
|---|---:|---:|---:|---:|---:|---|
| foot | 2.22 M / 3.07 M | 2.07 M / 2.93 M | 3.57 M / 4.46 M | 3.33 M / 4.21 M | 2.07 M / 2.93 M (4 fns) | |
| git | 2.69 M / 3.22 M | 2.68 M / 3.23 M | 5.46 M / 6.04 M | 5.00 M / 5.56 M | 5.00 M / 5.56 M | typed strict (25): 2.69 M / 3.23 M |
| bash | 0.96 M / 1.28 M | 0.96 M / 1.29 M | 1.66 M / 2.00 M | 1.38 M / 1.72 M | 1.34 M / 1.68 M | |
| python | 4.65 M / 7.77 M | 4.64 M / 7.78 M | 8.66 M / 11.87 M | 8.51 M / 11.72 M | 8.49 M / 11.70 M | |
| quickshell | 16.62 M / 29.41 M | 16.90 M / 29.89 M | 37.96 M / 51.37 M | 32.60 M / 45.98 M | 32.47 M / 45.84 M | `runtime` + `main-direct` (6): 16.98 M / 29.97 M |

These sizes use today's per-function transform for the sink set, which
approximates the bounded-unwind transform: a sink needs one extra boundary
branch per sink site. Quickshell typed sets measured on the PR #1449 link
map onto only 38,084 of 68,493 names in the shipped build, so they are not
reported as sizes.

Speed: **not measured.** The bounded unwind should make fork itself cheaper
(it unwinds and replays the sink chain instead of the whole stack). That is
a claim to measure with the fork-heavy suites (`process-lifecycle`,
`erlang-ring`, `wordpress`) on Node and browser, not a result.

## Mechanism: bounded unwind (recommended)

Today (`host/src/worker-main.ts`, the `_start` loop):

1. `kernel_fork` (capture phase) returns, and the generated code throws the
   private unwind tag.
2. Every instrumented function catches it in its one function-wide
   `try_table`, commits its linked frame node, and rethrows.
3. The exception escapes `_start`. The host seals the capture, sends
   `SYS_FORK`, and re-enters through `wpk_fork_resume_start` for
   parent-replay.
4. The child's Worker enters the same export for child-replay.

With sinks, each fork-reaching call site is either a **boundary site** (a
sink: the child cannot return to the caller through it) or an **open site**
(today's behavior).

Parent:

1. Capture and unwind proceed as today until the unwind tag reaches the
   deepest boundary site on the stack. The frames below it are all
   instrumented, because they are in the set.
2. That function's handler runs today's frame selection and commits its
   node; the child needs it. Instead of rethrowing, it calls a new import
   `kernel.__wpk_fork_boundary()`. The host seals the capture, sends
   `SYS_FORK` (or `SYS_VFORK`) synchronously from inside the import, which
   is how `sendForkSyscall` already blocks, and begins parent-replay at the
   next node, skipping the live boundary activation. On failure it begins
   abort-replay.
3. The function then branches to its existing restart loop (`$restart`,
   which ABORT_UNWINDING already uses to restart a live activation at its
   selected call) in REWINDING state. Its callees consume their nodes, and
   `kernel_fork` returns the child pid as today.
4. Frames above the sink never see the unwind tag. They need no
   instrumentation, and a C++ `catch_all` in them is never entered by
   fork's private exception.

Child:

1. The child enters `wpk_fork_resume_start` as today. That export is
   generated by `emit_resume_selected_call`, which consults
   `__wpk_fork_resume_peek` and calls the resume thunk named by the next
   replay event, falling back to the lexical `_start` call. With a sink
   root, the next event is the sink, so the instrumenter adds every
   boundary function to the resume catalog. Today only exported, table and
   tail-call targets get thunks. That the event order puts the sink first
   follows from replay consuming the last-committed node first; this is
   read from the code, not tested.
2. A `kandelo.wpk_fork` root-kind flag in the continuation marks a sink
   root. If the sink returns, the resume entry executes `unreachable`, which
   is a loud failure.
3. An exception that escapes the sink reaches the host as an uncaught
   exception, and the child dies with a diagnostic. This is the run-time
   form of rule 2. Linux would call `std::terminate` (SIGABRT) when no
   handler exists above, so the host should report SIGABRT-equivalent
   status for parity.

The mechanism is the same on Node and browser: the change is in shared
`host/src/worker-main.ts`, the process continuation coordinator, and the
pthread worker loop.

A stack with no boundary site falls back to today's full unwind to `_start`
or to the pthread entry. So the bounded unwind strictly generalizes today:
it is today's protocol with the root moved down to the deepest sink.

### Alternative: capture without unwinding

The prompt's alternative needs these changes:

- Every function on the sink chain saves its live locals into a per-thread
  record chain *before* each fork-reaching call.
- `kernel_fork` returns normally in the parent.
- The child starts from the records.

Compared with the bounded unwind:

- **Instrumented set:** the same.
- **Ordinary-path cost:** stores on every execution of a chain call site.
  The bounded unwind adds nothing.
- **Transform:** a new transform (spill-before-call, record push/pop, a
  record chain in TLS), plus new invariants for scratch-spill frames and
  reference recipes. The bounded unwind reuses today's frame codecs,
  reference recipes, catch reconstruction and restart loop, all of which
  are tested.
- **Fork time:** no replay at all in the parent. The bounded unwind does a
  short unwind and replay of the chain, a few frames.

Recommendation: the bounded unwind.

Decision (maintainer, 2026-10-02): bounded unwind, for now. Both designs
instrument the same functions. Bounded unwind was chosen because it
disrupts development less: it reuses the frame codecs, the restart loop and
the replay paths that the fork tests already exercise, and it leaves the
ordinary (non-fork) path unchanged. Capture without unwinding stays the
documented alternative. Its advantages are no parent replay and simpler
fork-time behavior, and it can be revisited once the sink analysis has been
proven in production.

## Interactions

### vfork

A vfork child may only call `_exit` or `exec`, and POSIX leaves returning
from the function that called vfork undefined. So the **caller of vfork is
a sink by contract**: it can be marked a boundary even when the analysis
cannot prove no-return, with the `unreachable` trap above as the run-time
check. Borrowed vfork replay is otherwise unchanged:

- The parent parks inside `__wpk_fork_boundary` instead of in the `_start`
  loop.
- The borrowed child replays the parent's committed nodes from the sink
  down, without consuming them, exactly as today.

**Coordination with the vfork-without-instrumentation lane.** That lane's
prompt (`st-georges/.context/prompts/vfork-without-instrumentation.md`) has
not been started by any session on this machine. It aims at zero
instrumentation for vfork-only programs: the child runs on the parent's own
stack in the parent's instance. That needs a kernel "this instance is acting
as child PID N" mode, an fd-table swap, and an exec handoff.

With sinks, a vfork site costs its chain: the caller plus libc's `vfork`,
which calls `kernel_fork` directly. That is two functions by construction.
This is not separately measured: the shipped Quickshell build measured here
predates the separate `vfork` glue (its `_Fork` is inlined into `fork`, and
no `vfork` exists), while the PR #1449 link shows `vfork` with child-side
value 0, as expected. Two functions leave little for the other lane to
save, at much higher kernel cost. **Recommendation: one design.**
Treat vfork as a contractual sink in this mechanism, and drop or narrow the
separate lane, unless zero instrumentation for vfork-only programs is
itself a goal.

### Threads

Only the calling thread exists in the child, as today. A pthread fork whose
stack has a boundary site no longer needs the pthread entry and argument in
the child-launch context, because the child root is the sink. Without a
boundary site, today's `wpk_fork_resume_thread` path is unchanged. Retained
TLS and stack slot reservations are unchanged.

### Pending signals and handlers

POSIX clears pending signals in the child. A signal delivered to the child
before exec runs its handler inside the child path (below the sink): libc's
dispatch is an ordinary call in `__do_syscall_impl`. If the handler returns,
nothing changes. If it longjmps or throws past the sink, the run-time check
fails loudly (rule set `runtime`), or the function stays open
(`strict`/`gate`/`equiv`).

The **signal gate** is the second boundary. Signal-handler dispatch can
interrupt any syscall in any function. A handler that forks, and whose child
returns from the handler, resumes the interrupted code in the child. Every
function that makes a syscall is then a potential caller. That is why
`strict` saves nothing.

The gate makes the libc handler-dispatch call site a boundary of a
different kind: an unwind that reaches it, meaning no sink below it inside
the handler, aborts the fork. It uses the existing ABORT_UNWINDING path,
and `fork()` returns -1 with an errno and a host diagnostic. A handler that
forks and then execs or `_exit`s still works, because its sink lies below
the gate.

**This is a POSIX gap and must be documented as one:** fork from a signal
handler with a returning child. The site must be found robustly, for
example through a libc-exported dispatch entry, not a function name. The
measurements recognize `__do_syscall_impl` and `__deliver_pending_signal`
by name.

The alternative to the gate is a sound registry of installed handlers. The
plugin's `signal` registry is unknown in most of the corpus, because of
non-constant callbacks such as git's `sigchain_push`.

### dlopen side modules and pthread_atfork

**Side modules.** A `call_indirect` that may enter a dlopen'd side module is
an opaque fork-reaching callee whose child returns anything and may throw:
the `EXT` node in fsa. Frames above it stay open. bash links the dynamic
loader, and its numbers include that.

A boundary must be in the module that holds the sink frame. The
process-wide event journal already orders main and side activations. The
boundary import must seal every module's continuation, as the coordinator
does today before `SYS_FORK`. First version: no boundary site whose callee
chain crosses into another module. That is conservative, because those
frames stay open.

**pthread_atfork.** Prepare handlers run before `kernel_fork` in the parent
(ordinary execution). Child handlers run inside `fork()` after `_Fork`
returns, which is below the sink. The `__fork_handler` registry rule
resolves them.

### C++ exceptions and setjmp/longjmp

Both are Wasm exceptions in Kandelo: `__cpp_exception` and `__c_longjmp`.
In the parent, the bounded unwind only passes instrumented frames, so
catch-handler reconstruction is unchanged.

In the child, rule 2 is either proven (`strict`, `gate`; `equiv` when no
catcher is above) or checked at run time (`runtime`). The sink classifier
reports, per sink, whether any function that can be above it has a catch
clause for the escaping tag. It conservatively counts C++ cleanup pads
(`catch_all_ref` + `throw_ref`) as catchers. In the C++ programs measured
(Quickshell, qtgallery, waybar), every `runtime` sink is flagged.

A precise "handler, not cleanup" test, meaning a catch that does not always
rethrow, would let `equiv` close more C++ sinks. It is not implemented.

## ABI and snapshot impact

This is an incompatible artifact change and needs an `ABI_VERSION` bump
plus a regenerated `abi/snapshot.json`:

- New import `kernel.__wpk_fork_boundary` (or a new mode of an existing
  transport import), and a new capability bit in
  `kandelo.wpk_fork.capabilities`, for example `0x08` "boundary sites".
  ABI 43 hosts must reject artifacts that carry it.
- The continuation gains a root kind: `_start`, pthread entry, or sink
  ordinal. The resume catalog gains sink entries. These are new semantics
  for existing fields.
- The child-launch context (`ForkLaunchRequest`) and the parent-replay
  start position change meaning.
- The signal gate, if adopted, changes `fork()`'s errno behavior inside
  handlers. That is semantic ABI. libc must export the dispatch entry that
  the instrumenter recognizes.
- `main-direct`, if adopted, changes crt/libc. No ABI change on its own,
  but every program must be relinked to benefit.

The kernel's fork path (`kernel_fork_process`) needs no change: the kernel
never sees stacks. Every fork-instrumented package, bottle, index and VFS
image must be rebuilt, as for ABI 43.

## Size and speed costs

- **Size:** see the tables. The new per-site boundary branch, the resume
  thunks for sinks, and the import are small next to the removed
  functions. They are not measured separately.
- **Build time:** the analysis is a whole-program fixpoint. fsa needs 1-6
  minutes on Quickshell (single-threaded, unoptimized research code). The
  production version belongs in `call_graph.rs` and must be measured.
- **Run time:** not measured (see above). The ordinary-path cost of the
  bounded unwind is zero for functions that leave the set, and unchanged
  for those that stay.

## What was run, and what was not

Run:

- fsa over 11 programs × 4 rule sets, signature-level and typed (fpa v3
  exports), with oracle checks on 5 programs;
- shipped-shape instrumentation of foot, git, bash, python and Quickshell
  with an experiment build of today's instrumenter;
- 11 fixture cases over 8 WAT modules for fsa
  (`tools/fork-sink-research/fsa/tests/run.sh`), all passing.

Research tools were built with the host toolchain pinned by
`rust-toolchain.toml`, not under `scripts/dev-shell.sh`. They are not
repository build artifacts.

Not run:

- any implementation, and therefore any Vitest, conformance suite or
  browser test of the mechanism;
- any trace of real fork children (child-side soundness is analysis-only);
- benchmarks;
- the plugin with generalized CFI pointer types;
- a precise handler-vs-cleanup classifier;
- the mechanically checked form of `main-direct` (a crt prototype).

## Certain and uncertain

Certain:

- The parent-replay constraint holds. The proposal's numbers describe a
  different mechanism.
- The numbers 6 and 4 are reproducible with the gate, the run-time
  exception check, and, for Quickshell, `main-direct`. Removing the check
  (both) or `main-direct` (Quickshell) loses them.
- Without the run-time exception check, git (typed, no boundary at all)
  and foot (typed, plus the gate) collapse to a handful of functions.
  Quickshell does not.
- CFI-typed resolution is unsound for `main` as linked today.
- Interpreters keep most of their instrumentation regardless.

Uncertain:

- Whether the maintainer accepts the two run-time boundaries.
- How much a precise cleanup-vs-handler test or generalized types would
  recover under `equiv` for C++.
- Real fork-time speed.
- Engineering cost of the production analysis and transform. Estimate:
  analysis about 1.5k lines in `crates/fork-instrument`; host boundary
  import and root kind in the coordinator; libc gate export. Not validated.

## Decisions requested

1. Approve the bounded-unwind mechanism (instead of capture without unwind)?
2. Accept the signal gate as a documented POSIX gap?
3. Accept rule 2 by run-time check (`runtime`), or only where no catcher is
   above (`equiv`)?
4. Pursue `main-direct` in Kandelo's crt/libc?
5. Fold the vfork-without-instrumentation lane into this design?

## Decisions and follow-up findings (2026-10-02)

Maintainer answers:

1. Mechanism: bounded unwind. See the note under "Alternative: capture
   without unwinding".
2. Signal gate: not accepted unless needed. Asked: "Can we feasibly build
   an exact list of installed handlers and avoid the gap?" Findings below.
3. Exceptions: `equiv`, which does not change exception-handler semantics.
   Asked whether anything else could help Quickshell. Findings below.
4. `main-direct`: pursue it in the crt. Prototyped.
5. vfork: fold it in as a contractual sink if that is not burdensome.
   Prototyped. A separate vfork lane is in progress on another machine.
6. Prototype the full approved set. Done, on a local branch only.

### An exact list of installed signal handlers (decision 2)

The question is whether the analysis can know exactly which functions are
ever installed as signal handlers. If it can, a fork inside a handler is
judged only against those handlers' real child behavior, and no gate is
needed.

- **Wasm-only: not sound.** Handler pointers reach `sigaction` through a
  `struct sigaction` in memory, often built in a caller or through a
  wrapper. Without type facts the analysis cannot follow them. The sound
  Wasm-only rule is the current `strict` rule: every address-taken
  function whose Wasm type matches a handler is a possible handler.
- **A run-time registry does not avoid the gap.** The kernel does know the
  installed handlers at run time, but the instrumented set is fixed at
  build time. The instrumenter must decide before the program runs which
  functions may be on the stack when fork is called from a handler.
- **With type facts: exact enough.** The CFI type facts from the
  build-time plugin narrow handler candidates to functions of the C type
  `void(int)` or `void(int, siginfo_t *, void *)` that are address-taken.
  Measured with `--exc equiv --main-direct --registries --param --cancel`,
  where `nothrow` is the gate and `sig` is the exact-by-type list:

  | Program | Today | Typed, exact list (`sig`) | Typed, gate (`nothrow`) |
  |---|---:|---:|---:|
  | git | 5,293 | 25 | 25 |
  | foot | 2,994 | 4 | 4 |
  | git-remote-http | 8,659 | 8,273 | 7,135 |
  | Quickshell | 108,860 (link) | 107,784 | 72,333 |

  Signature-level (no type facts), for comparison:

  | Program | Today | `sig` | `nothrow` |
  |---|---:|---:|---:|
  | Quickshell (shipped shape) | 51,942 | 51,676 | 43,097 |
  | qtgallery | 26,586 | 26,240 | 17,030 |
  | waybar | 32,946 | 32,742 | 30,177 |
  | git-remote-http | 8,659 | 8,616 | 8,199 |

  Without type facts, the exact-by-signature list saves about 0.5–4%.

So git and foot need no gate once type facts are present. The Qt and
Wayland programs still gain much more from the gate than from the exact
list, because their handlers' children return.

Type facts are not yet sound as linked: foot's `main(int, char *const*)`
is called through `int(*)(int, char **)`. With `main-direct`, `main` no
longer goes through the table, which removes that instance. The general
fix is generalized pointer types in the plugin (every pointer is treated
as `void *` when matching), as CFI's `-fsanitize-cfi-icall-generalize-pointers`
does. Using type facts in production needs the plugin in the SDK build.
That integration has not been done.

### Helping Quickshell without changing exception semantics (decision 3)

These were added and kept, all behavior-preserving:

- **Precise catcher classifier.** A landing pad counts as a catcher only
  if it can resume normal control flow: a C++ `catch`, or a longjmp target.
  Cleanup pads (destructors, then rethrow) and terminate pads
  (`std::terminate`) are not catchers. Only setjmp frames catch longjmp.
- **Standard facts.** `exit`, `_Exit`, `_exit`, `quick_exit`,
  `pthread_exit` and `std::terminate` never return. Their
  child-observable behavior is defined by POSIX or C++, so stating it is
  not a guess about the program.

Result: Quickshell under `equiv` stays at 43,097 (shipped shape, gate,
main-direct). Witness paths show why. The open escapes come from
signature-conflated indirect calls: `std::function`, virtual calls, and
`__cxa_atexit` destructors, each of which "may reach" a Qt slot that
catches. In the shipped shape, wasm-opt function merging also gives one
body many names, which makes the witnesses noisy. Without type facts there
is no remaining behavior-preserving lever of this kind. The next lever is
the same as for decision 2: generalized type facts.

### Prototype status

ABI 46. Landing as the mechanism plus the instrumenter's built-in
(fact-free) analysis; see "Path to production" at the end of this file for
what the precise sets still need.

- `crates/fork-instrument/src/sink.rs`: the analysis. It uses the `strict`
  signal rule, `equiv`, the precise catchers, the standard facts, `-O0`
  frame slots, musl registries, the cancel rule, the vfork contract and
  tail-call transparency. It does not use type facts. It is off for
  dlopen-capable modules, and it falls back to today's closure on
  unsupported instructions or non-convergence. `--no-sinks` disables it.
- Instrumenter: boundary functions call `env.__wpk_fork_boundary` instead
  of rethrowing, consume their own node, and restart in place. The new
  export `wpk_fork_resume_sink(i32)` is the child's entry. The custom
  section `kandelo.wpk_fork.boundaries` lists (function ordinal,
  thunk-signature index).
- Host (shared `worker-main.ts`, so Node and browser alike): the boundary
  import on process and pthread workers, a shared `completeCapturedFork`,
  and child entry through the sink when the outermost replay frame is a
  boundary. A sink that returns in the child is reported as "fork child
  returned through its sink frame".
- libc: `crt1.c` passes no `main` pointer. `libc_start_main_stage2` calls
  `__main_argc_argv` directly.
- vfork: a caller of the libc vfork wrapper is a boundary by contract.

Validated: `cargo test -p fork-instrument`, then the full rebuild with
sinks on by default, host Vitest, the conformance suites and the browser
suites (see "Validation run on this branch" below).

Expected size under the prototype's rules, with no type facts and no gate
(fsa, links): foot 2,994 → 2,876, git 5,293 → 5,101, bash 1,940 → 1,933.
The mechanism works, but large reductions need type facts (git 25, foot 4)
or the gate (foot 2,368, git 4,553, bash 1,220).

## C++ indirect-call resolution (2026-10-02, follow-up)

The maintainer asked what better C++ indirect-call resolution could gain,
without changing exception semantics. All numbers below are counts of
instrumented functions, measured on the pre-`wasm-opt` research links with
the research tools, not the shipped instrumenter. The rules throughout are:
`--exc equiv` (exception semantics unchanged), signals by exact handler list
(no gate), `main-direct`, sinks with the vfork contract.

### Type facts today

The other worktree (ljubljana, local branch
`brandonpayton/fork-path-precision`) has research-grade type facts. They
come from compiler plugin v3 (`KandeloCallTypes.cpp`), captured through
research compiler shims for the 11 corpus programs. They are not in the SDK
build. Three gaps showed up:

- **Some libc++ objects had no facts.** These were `locale.cpp`,
  `ios.instantiations.cpp`, `new.cpp`, `filesystem/operations.cpp` and
  `thread.cpp`: 446 Quickshell functions, 261 of them in the function
  table. The plugin is not at fault. clang crashes in
  `WebAssemblyLowerEmscriptenEHSjLj` (code generation) when the CFI flags
  are on, after the plugin has already run. Compiling those files with
  `-emit-llvm -o /dev/null` produces their facts.
- **No pointer generalization.** It is approximated here by demangling the
  type ids and treating every pointer or reference parameter or return as
  one type (`FPA_GENERALIZE`). This is clang's
  `-fsanitize-cfi-icall-generalize-pointers` equivalence.
- **The signal registry was "unknown" for every program.** For Qt the
  causes are a vfork-safe helper that forwards `SIG_IGN`/`SIG_DFL`
  (`QtVforkSafe::change_sigpipe`), musl's `__synccall` building its
  `struct sigaction` from a constant, and a weak alias of musl's `signal`
  counted as an address escape. All three are plugin conservatism, not
  real unknown handlers. A source audit gives Quickshell's handlers as
  forkfd's `sigchld_handler` and musl's synccall `handler`.

### What keeps Qt programs large

Each fpa rule was switched off in turn, and fsa was re-run on the result.
The rules, with Quickshell's result when that rule is removed:

| Rule | What it encodes | Quickshell without it |
|---|---|---:|
| Complete type facts (libc++) | real facts for the five objects above | 72,331 (exact types) |
| Exact signal handler list | `known:signal`, audited | 107,019 (exact types, coverage assumed), 107,381 (generalized) |
| Chained old handler | forkfd's `sigchld_handler` calls the previous handler; that pointer came from `sigaction(..., &old)`, so it is a registered handler (`cutsite:sigchld_handler`) | 10 (exact types), 107,381 (generalized) |
| `main-direct` | the crt change already prototyped | 70,430 (exact types, coverage assumed) |

"Coverage assumed" rows were measured before the libc++ facts existed,
with untyped targets dropped as an optimistic stand-in. With all four rules
and the real facts, Quickshell is **10** (today 108,860 on the link), exact or
generalized types alike. qtgallery is **7** either way (today 26,586).

What did not matter for Qt once those four were in place, even though each
is a large source of imprecision in the fork-path closure:

- class-hierarchy precision for virtual calls (dropping every vcall edge
  changes nothing);
- untyped sites (`std::function` invokers, which libc++ compiles without
  CFI);
- Qt's dynamic dispatch (`QMetaObject::activate` and every
  `qt_static_metacall`);
- the pthread-cleanup and cancellation edges.

The reason is that the fork-path closure is still about 107,000 functions,
but every path through that dispatch ends in a sink. QProcess forks
through `vfork`, and its child never returns past `doFork`/`vforkfd`. Only
fork sites whose child returns need precise callers. In Quickshell that is
the `qs -d` daemonizing fork, and imprecise edges into it were what kept
the set large.

### Other programs (exact handler list asserted, generalized vs exact types)

| Program | Today | Generalized | Exact | Note |
|---|---:|---:|---:|---|
| foot | 2,994 | 1,542 | 4 | C: `void *` callbacks merge under generalization |
| git | 5,293 | 3,599 | 25 | same |
| git-remote-http | 8,659 | 8,035 | 7,136 | curl |
| waybar | 32,946 | 29,043 | 28,433 | child paths may throw (spdlog), so `equiv` keeps them open |
| qtgallery | 26,586 | 7 | 7 | |
| Quickshell (link) | 108,860 | 10 | 10 | |
| bash / python / ruby / php | 1,940 / 9,166 / 9,755 / 20,369 | ≈ today | ≈ today | children genuinely return into the interpreter |

The signal list was asserted complete for every program, but it was
audited only for Quickshell. Assuming qtgallery has the same Qt handlers
is a guess.

Oracle (fork stacks observed at run time): no unsound stack in foot, git,
bash, python or ruby under either type mode. Quickshell and qtgallery have
no observed stacks.

An earlier run reported foot as unsound. That was a modeling error in the
`main-direct` what-if, fixed: the crt's own call to `main` must stay.

### Uncertain

- Exact types assume no call through an incompatible function-pointer
  type. That is undefined behavior in C, but common in practice.
  Generalized types are robust to the pointer case and cost C programs
  heavily. A run-time guard at the uninstrumented `call_indirect` sites
  (about 435 sites in Quickshell, per fpa's estimate) would turn a wrong
  assumption into a loud failure. It changes behavior only for such
  programs; that is the maintainer's decision.
- Numbers on the shipped (`wasm-opt`ed) shape were not measured. Type facts
  are keyed by function name, so they fit the order "instrument, then
  `wasm-opt`". With about 10 instrumented functions that order no longer
  has the +18.7% cost measured when 108,860 were instrumented.

### Productizing (not started)

- Ship the plugin with the SDK. Carry facts in a Wasm custom section of
  each object, which `wasm-ld` concatenates, instead of SHA-keyed side
  files.
- Rebuild every package and sysroot archive with the plugin.
- Fix the clang SjLj+CFI crash, or extract facts before code generation.
- Plugin fixes for the signal registry: constant arguments into static
  forwarders, constant-initialized `struct sigaction`, aliases not counted
  as escapes. Add an `oldact` flow rule for chained handlers.
- Port the typed targets into `crates/fork-instrument`. Fall back to
  signature matching per object whenever facts are missing.

## Type-unsafe function pointers: the middle ground (2026-10-02)

The maintainer asked for a middle ground between exact C/C++ types and
treating all pointer types as equal. The idea: match exactly, except for
functions the source shows may be called through a different function
type.

### What the plugin records

The plugin gains a Clang half (`KandeloFnCasts.cpp`, now in
`sdk/src/plugin/`). It runs before code generation, while casts are still
visible; LLVM's opaque pointers erase them later. It records:

- a function converted to another function type, or to `void *` or an
  integer;
- a function-pointer value converted between types (for example libffi's
  dispatch casting `void (*)(void)` to each concrete signature);
- struct-pointer punning, where a struct holding function pointers is cast
  to another type. Example: libwayland's `(void (**)(void)) listener`. The
  record includes the function types the destination designates;
- which struct fields hold which functions.

fpa's `casts` rule matches every function exactly, except that a function
with a recorded conversion chain also matches the call-site types that
chain reaches.

### Exact types alone are unsound

In foot, exact types give libffi's generated dispatch call (`d_0_5`) no
targets. Yet at run time libwayland calls foot's `handle_global` exactly
there: the listener struct is punned to `void (**)(void)` and dispatched
through libffi. With `casts`, `d_0_5` has 11 targets including
`handle_global`. Matching by Wasm signature instead (`casts-sig`) would
make foot 2,356.

### Results

These are fresh source builds of this worktree's packages through the
research shims (`scripts/cxx/rebuild2.sh`): musl, libc++ (facts-only
compile), qtbase, and the programs. The analysis uses only plugin facts and
sound rules:

- `casts`;
- `cleanup-lexical` (POSIX pairs pthread_cleanup push and pop in one
  scope);
- `sigaction-old` (below);
- the musl registries;
- `--exc equiv`;
- the exact signal-handler list from the plugin;
- sinks with the vfork contract.

No list is asserted and no what-if is used.

| Program | Today | Instrumented | Oracle |
|---|---:|---:|---|
| Quickshell | 102,878 | 10 | no stacks recorded |
| foot | 3,000 | 4 | 1 stack, all frames covered |
| git | 5,293 | 25 | 8 stacks, all frames covered |

Quickshell's 10: `_Fork`, `fork`, `vfork`, `forkfd_fork_fallback`,
`vforkfd`, QProcess's `doFork`, `qs::launch::runCommand`,
`qs::launch::main`, `main` and `libc_start_main_stage2`. Per-program
summaries are in `tools/fork-sink-research/results/`.

### What it took, beyond `casts`

- **libc: `libc_start_main_stage2` called directly.** Upstream musl calls
  it through a pointer laundered by an `asm` statement, as a barrier
  against hoisting. That put stage 2 in the function table, so untyped call
  sites could "reach" `main` and Quickshell's daemonizing `fork`. Without
  this change Quickshell stays at 66,603. The overlay now calls it directly
  as `noinline` with a memory clobber, the same barrier. This is in
  `libc/musl-overlay/src/env/__libc_start_main.c`, next to the crt change.
- **Plugin: three registry false alarms fixed.**
  - musl's `weak_alias` was counted as the registration API's address
    escaping. That made the once, thread, TSD and signal registries all
    unknown.
  - `__synccall` installs a `struct sigaction` copied from a constant
    initializer.
  - Qt's `change_sigpipe(SIG_IGN/SIG_DFL)` is a file-local forwarder.
- **`sigaction-old`.** The plugin marks a file-local `struct sigaction`
  global that is only ever written as `sigaction()`'s `old` argument
  (forkfd's `old_sigaction`). A call through it can only run an
  already-registered handler, so it is analysed as a dispatch of the
  signal registry. Without this rule Quickshell is 101,206.
- **Complete libc++ facts.** clang 21 crashes in
  `WebAssemblyLowerEmscriptenEHSjLj` with the CFI flags on. The research
  shim now builds the object normally and takes the facts from a run that
  stops at LLVM IR. `Unwind-wasm.c` still has no facts; it falls back to
  signature matching, which is conservative.

### Remaining assumptions

- Union punning of function pointers, `memcpy` of function pointers, and a
  `void *` that returns to a *different* struct type than it left as are
  not tracked. This is the same blind spot clang's CFI has.
- Every object must carry facts. Functions without facts fall back to
  signature matching. A conversion inside an object without facts is
  invisible, so production must fall back to signature matching for the
  whole module whenever coverage is incomplete.
- These are research tools (fpa, fsa) on the pre-`wasm-opt` link. The
  instrumented binaries have not been built or run.
- qtgallery was not measured. Its recipe compiles against sysroot C++
  headers instead of its declared libcxx dependency, and fails in a fresh
  scratch cache. That is a package-recipe defect, outside this work.
- waybar stays at about 32,700 in every type mode. Its fork children may
  throw C++ exceptions that something above catches, and `equiv` keeps
  them open.

## Fork sinks in programs that can dlopen (design, 2026-10-03)

### Why this needs a contract

A program that can `dlopen` may run code the instrumenter never saw. Any
indirect call might enter a side module, and that side module may fork. If
its fork child returns, the child resumes through every frame between the
fork and the program root, including main-module frames above the side
module.

Today's answer (capability bit 1) instruments every `call_indirect` and its
callers in such a main module. That is sound, but it undoes everything sinks
and type facts gain. After the merge, Quickshell links the dlopen runtime
(Qt's `QLibrary` calls `dlopen`) and goes back to about 102,400 instrumented
functions.

The maintainer confirmed that Quickshell must keep `dlopen`.

### Default and escape hatch (maintainer, 2026-10-03)

Side modules may fork by default. The default instruments the main module
for every entry path a side module can actually take, traced rather than
guessed:
- call sites that `dlsym` results flow to (slot analysis follows them);
- call sites of the function-pointer types in the main module's exported
  API, through which a side module can hand over callbacks.

The default is `--side-modules=traced-entries`. The load-time check below
refuses only what falls outside those traced paths. The opt-in mode
`--side-modules=assume-all-entries-fork-returning` keeps today's
conservative instrumentation: it treats every side-module entry as
fork-returning, so any side module may fork along any path. It is for
programs that must load arbitrary forking libraries. Its cost for
Quickshell, including virtual calls on main-module classes that plugins can
subclass, is still to be measured.

Vocabulary. An *entry* is a side-module function the main module can call:
an export reached through `dlsym`, or any function whose address the side
module hands over (a table element). An entry is *fork-returning* when a
fork child can return through it into main-module frames: it forks with a
returning child, or it calls a fork-returning main export. Forking alone is
not enough. An entry that forks only to `exec` or `_exit` (QProcess's vfork
path, `system()`, `posix_spawn`) never returns into the main module in the
child, so the main module needs nothing for it.

### The contract

The main module is instrumented for the traced entry paths only. The host
checks that assumption when a side module loads, and refuses the load when
the assumption would be false.

- **Main module metadata**, a new section:
  - **Prepared call-site types**: the (Wasm signature, CFI type id) pairs
    for which *every* main `call_indirect` site lies in an instrumented
    function on an instrumented chain to the root. A side function entered
    through such a site may fork freely.
  - **Fork-returning exports**: exported main functions through which a
    fork child can return, for example `fork` itself or a function that
    daemonizes. Sinks are not fork-returning. QProcess's vfork paths,
    `system()` and `posix_spawn` are not fork-returning.
- **Side module metadata**, from the same instrumenter run with
  `--entry env.fork`. For every function whose address can reach the main
  module, meaning an export or a table element, it records:
  - its CFI type id;
  - whether it forks directly with a returning child;
  - which main imports it can reach.
- **At `dlopen`**, inside the host-owned `__wasm_dlopen_prepare` step
  shared by Node and browser: a side entry is fork-returning if it forks
  with a returning child or reaches a fork-returning export. Every
  fork-returning entry's type must be prepared. If not, `dlopen` returns
  NULL and `dlerror()` says which
  entry and type. That is a truthful failure; POSIX allows `dlopen` to
  fail.
- **Side modules loading other side modules** apply the same check against
  the loader's prepared types. Side modules keep today's conservative
  instrumentation of their own code.

### What it changes

A side module whose code can fork with a returning child, reached from a
main call site the analysis did not prepare, now fails to load. Today it
loads and works. Ordinary plugins are unaffected: Qt image formats, platform
themes and QML plugins that start processes through QProcess hit vfork
sinks, which are not fork-returning. No such side module exists in
Kandelo's packages
today; that is a claim to verify before landing.

The alternative, preparing every call-site type, is today's conservative
instrumentation: `--side-modules=assume-all-entries-fork-returning`.

### Not decided

- Whether the refusal should be the default, or opt-in per program until
  side modules carry type facts.
- Where the type facts of a side module come from: the same SDK plugin, so
  every side module needs to be built with it.
- ABI: two new custom sections and a new load-time check. Since ABI 46 is
  not released, they can join it.

## Per-slot untyped-pointer tracking (2026-10-03)

The opaque pool is replaced by per-slot tracking. Slots are derived
automatically from each program's source; no list is maintained by hand.
The only fixed list describes standard libc semantics: the functions that
return an argument. Fresh source builds, all rules sound, with
`--rule casts --rule slots`:

| Program | Today | Pool | Slots | Oracle |
|---|---:|---:|---:|---|
| foot | 2,994 | 2,344 | 4 | covered |
| git | 5,293 | 5,091 | 5,091 | covered |
| Quickshell, dlopen contract | 103,038 | n/a | 10 | no stacks |

git still merges at generic containers (`option.value`,
`string_list_item.util`, strmap values), at pass-through helpers
(`xrealloc`, `container_of_or_null_offset`) and at callback parameters
shared by many registrations. The next step is context sensitivity:
- per-call-site results for functions that return a parameter, detected
  automatically;
- object sensitivity for static initializers of option-style tables.

### Where git's precision went (2026-10-03)

The cause was found by bisecting slot read-backs by kind and by slot. Fixes,
all automatic:
- **Call sites.** Each direct call has its own result slot. The analysis
  computes, per function, which parameters and which other sources reach
  its return value, and a call takes exactly those (iterated to a fixpoint
  for recursion). This replaced the hand list of libc functions that return
  an argument.
- **Constants.** A compile-time constant (`offsetof`, `sizeof` arithmetic)
  carries no object. In pointer ± integer, only the pointer carries one.
- **ISO C allocation semantics.** `malloc`, `calloc` and `aligned_alloc`
  return a new object, and `realloc` returns the old one's contents.
  Allocators compute results from internal metadata the model would
  otherwise read as unknown memory.

What remained is C's effective-type rule. git reads structs back from
generic containers (`option.value`, `string_list_item.util`, strmap
values) and shared callback data. Pairing every struct ever stored with
every type read back keeps git at 5,091. C forbids reading an object
through an unrelated struct type, and clang's alias analysis already
assumes that in every unit compiled with strict aliasing (the C default).
With the rule applied per unit, git is 25.

Units compiled with `-fno-strict-aliasing` (the Linux kernel, for example;
modern CPython's configure finds it does not need the flag) keep the sound
pairing: the plugin records each unit's mode
(`AL`), and fpa applies the rule as `--rule effective-types` only where
the compiler applies it. Union punning, which C defines, is modelled
either way.

### Corpus results (2026-10-03, fresh source builds)

All rules: `casts slots effective-types cleanup-lexical sigaction-old
cancel`, `--exc equiv`, exact signal-handler lists from the plugin, sinks,
the vfork contract, and `jmp_buf` identity (below). Every program is
measured under the dlopen contract. Oracle: fork stacks recorded at run
time; "covered" means every frame that must be instrumented is in the set.

| Program | Today | Instrumented | Oracle |
|---|---:|---:|---|
| foot | 2,990 | 4 | 1 stack, covered |
| git | 5,285 | 25 | 8 stacks, covered |
| Quickshell | 103,039 | 10 | none recorded |
| bash | 1,929 | 1,915 | 28 stacks, covered |
| CPython | 9,162 | 9,125 | 9 stacks, covered |
| Ruby | 9,735 | 9,522 | 17 stacks, covered |
| git-remote-http (curl) | 8,660 | 8,433 | none recorded |
| waybar | 32,941 | 32,705 | none recorded |

Without the effective-type rule, git is 5,085 and the others barely move.

These numbers replace an earlier table. That table applied the
effective-type rule to every unit, not only strict-aliasing ones: a
compile error in the plugin's Clang half dropped the per-unit `AL` fact,
and the plugin build script hid the error. The build now fails loudly,
and the corpus was rebuilt from scratch. 58 units record relaxed
aliasing (all of pixman and fontconfig, both in foot's closure); git's
closure has none. foot, git and Quickshell are unchanged.

The bash oracle at first reported 28 unsound stacks. That was a tooling
bug: bash has two functions named `main` (libc's two-argument wrapper and
bash's three-argument `main`), and the oracle matched stack frames by name
only. It now picks the same-named function that calls the next frame
inward.

The interpreters stay large because their fork children genuinely return
into the interpreter.

waybar stays large for a different reason: GTK and its C++ code raise
exceptions across the fork path, and a catcher may be above almost every
frame (see "What keeps Qt programs large").

### `jmp_buf` identity and curl (2026-10-03)

The plugin records which buffer each `setjmp` and `longjmp` uses (`JS`,
`JL`: a global, a field, or unknown). Each named buffer gets its own
pseudo-tag, so a `longjmp` can land only in a frame that called `setjmp`
on the same buffer, as Wasm's setjmp lowering guarantees.

Two details of the lowering matter. LLVM rewrites every source `longjmp`
into a call to `__wasm_longjmp`. It also adds one more `__wasm_longjmp`
call to each `setjmp` function, which rethrows longjmps aimed at other
buffers. A call in a function with a `JL` fact throws that buffer's bit.
A rethrow carries every named buffer, plus the unknown-buffer bit when
some `longjmp` in the module has no buffer fact. Anything else throws the
unknown-buffer bit. `__wasm_longjmp` is itself on the fork path:
restoring the signal mask makes a syscall, which can run a handler. So
the child-side model needs the same attribution as the normal one.

In git-remote-http, curl's only buffer (`curl_jmpenv`) is now the only
longjmp bit that flows. That does not shrink the set (8,433). Its catcher,
`Curl_resolv_timeout`, sits above almost every fork path, through:
- curl's allocator hooks (`Curl_cfree` and friends, global function
  pointers resolved by type: 374 targets);
- curl's hash-table destructors and connection-filter callbacks (struct
  fields, 531 targets for `data_pending`);
- a DNS-over-HTTPS sub-transfer that runs curl's whole transfer engine;
- OpenSSL's provider tables (`OSSL_DISPATCH`), which store every function
  as a generic `void (*)(void)`.

An upper bound shows field-sensitive resolution would not change this.
Resolving the allocator hooks to libc and filtering every indirect call
by where function addresses are stored (both unsound shortcuts) still
leaves 8,319.

The analysis has to keep those frames. POSIX clears pending alarms in a
fork child, but another process can still send it SIGALRM. curl's
`alarmfunc` stays installed and would `siglongjmp` into the inherited
`Curl_resolv_timeout` frame whenever a fork inside the resolve window
can't be ruled out. Ruling that out means proving that nothing curl or
OpenSSL dispatches during resolution can fork. That is the boundary for
curl-based programs.

### Real instrumented binaries (2026-10-03)

Plans from the table above were applied with `wasm-fork-instrument
--sink-plan` (research hook) to the research link of each program, then
stamped. "Full closure" is the same link instrumented the way it is today
(`--no-sinks`), so the sizes compare like for like. The installed
binaries went through wasm-opt and are not comparable in size.

| Program | Full closure | Plan | Run-time check |
|---|---:|---:|---|
| git | 5.84 MB | 3.32 MB | 13-command sequence (init, add, commit, log, gc, alias, ...): identical output to the installed git |
| foot | 4.39 MB | 2.92 MB | `foot-smoke.test.ts` passes (foot forks dash, typed `exit`); a junk binary fails, so the substitution is real |
| Quickshell | 70.8 MB | 40.6 MB | under wlcompositor, a config's `Process` forks and execs dash: same output and exit code as installed |

Two of git's 13 commands exit 128 in every variant, the installed one
included. The harness runs on host-FS passthrough, where git's
compiled-in `/bin/sh` is the host's own shell, which is not a Wasm module
(`ENOEXEC`). The fork itself still happens.

Quickshell's `Quickshell.execDetached` and `Process.startDetached` do
nothing on Kandelo, installed binary included, and report nothing. Qt's
`startDetached` calls `vfork()` and then, in the child, calls `vfork()`
again. Kandelo refuses a nested vfork with `EAGAIN`, a documented
boundary (`docs/posix-status.md`, `vfork()`), so Qt's call fails silently.
The `startDetached` path of the sink set could not be checked at run time.

### Validation run on this branch (2026-10-03 and 2026-10-04)

Sinks are the instrumenter default, so every fork-using test program the
suites build goes through them. "Main" below means a detached worktree
at main (3ca75abca), provisioned with its own sysroots, kernel and test
programs.
- Full Vitest (`ci-run-test-suite.sh vitest`): 4,970 passed, 4 failed.
  - The resolver bundle was stale: a merged commit changed
    `host/src/constants.ts` after the bundle was regenerated. Regenerated;
    the test passes.
  - `abi-version.test.ts`: its import-section parser advanced with
    `at += uleb()`, which reads `at` before `uleb()` moves past the length
    byte. On main the misaligned walk happens to stop on a byte that looks
    like a memory import (1,024 pages for a 129-page import), so the test
    passes with a wrong value. This branch's build shifts the bytes and the
    walk finds nothing. Fixed; it passes.
  - `qt-gui-smoke` and `qt-qml-smoke` failed while two qtbase builds ran
    at once (a cache miss, because this branch changes libc and the
    instrumenter). The log shows two configure-and-build runs starting
    before the first failure. The recipe deletes and reconfigures a fixed
    build tree inside the checkout (`packages/registry/qtbase/qtbase-build`),
    so concurrent resolves of the same package share it, contrary to the
    resolver's private work root. Run one after the other, both pass.
    About 40 recipes use the same pattern; the fix is pending a decision.
- Open POSIX Test Suite: 174 passed, 0 failed (179 total).
- libc-test: 306 passed, 0 failed, 17 expected failures.
- Sortix os-test `--all`: 5,039 passed, 3 failed, 3 timed out. The
  timeouts (poll, select) pass when re-run alone. The three `nl_types`
  failures also fail on main. The rootfs `gencat` is a posix-utils-lite
  fake that copies its source text into the "catalog", so musl's
  `catopen` rejects it. Open PR #1427 replaces it with a real `gencat`.
- Browser (Chromium, CI's grep-invert set): 202 passed, 3 failed.
  - Omarchy desktop: passes alone (load).
  - Node.js demo: expected zero lazy Coreutils fetches from an
    environment switch whose only setter #1316 removed. It now expects
    the one fetch every image makes, and passes.
  - ppoll/pselect signal matrix: times out on main too. The hang moves
    between cases from run to run (an accepted SIGALRM that never wakes a
    `pause()`, or a timed `ppoll` that never returns): a lost wakeup in
    the browser host. Under investigation.
- Browser cross-browser contract specs on Chromium and WebKit: 56
  passed. Firefox cannot launch under Playwright on macOS 26/27.
- Browser vfork lifecycle spec, Chromium and WebKit: 18 passed. WebKit
  had failed every fork-instrumented program at load, a regression from
  f6b1dc2c3 (engine `Module.imports()` on modules WebKit cannot
  reflect), now fixed.

Later fixes on this branch: the browser ppoll/pselect hang was a libc
glue bug (a restarted ppoll's remaining time sent with an unwritten
padding word), hidden on Node because Node fires over-long timers after
1 ms. Guest timeouts longer than an engine timer now re-arm in chunks on
both hosts, an invalid ppoll timespec returns EINVAL, and test fixtures
rebuild when the glue changes.

Final run on the fixed tree (2026-10-04), after a full package rebuild:
- Vitest: 4,979 passed, 1 failed (`qt-gui-smoke`, the concurrent qtbase
  build race above).
  Fixed afterwards: the three Qt recipes now build in the resolver's work
  root, and the Default-policy publish keeps a concurrent winner when its
  rename hits a non-empty canonical directory. Both Qt smoke tests pass
  run together on a cold qtbase cache. The other ~37 recipes with in-tree
  build trees are separate work.
- Open POSIX: 174 passed, 0 failed. libc-test: 306 passed, 0 failed.
- Sortix `--all`: 5,042 passed, 3 failed (`nl_types`, the fake
  `gencat`; same on main).
- Browser assets check passes. Chromium (CI set): 211 passed, 6
  skipped. Cross-browser contract specs on Chromium and WebKit: 56
  passed. vfork lifecycle and select-signal specs on Chromium and
  WebKit: 20 passed.
- ABI snapshot check passes.

Not run: benchmarks, and Firefox (cannot launch under Playwright on
macOS 26/27).

## Path to production (2026-10-04)

This branch lands the bounded-unwind mechanism (ABI 46), the instrumenter's
built-in analysis, which needs no compiler facts and saves little (about 4%
of instrumented functions on foot and git), and the research tooling that
measured what precise facts can reach (foot 4, git 25, Quickshell 10 under
the dlopen contract). Turning those research results into the default needs:

1. **Compiler facts in the normal build.** Done (2026-10-04): the plugin
   lives in `sdk/src/plugin/`, the SDK builds and caches it per toolchain
   (`sdk/src/lib/calltypes-plugin.ts`) and loads it in every C/C++ compile,
   including musl (`scripts/build-musl.sh`) and libc++
   (`packages/registry/libcxx/build-libcxx.sh`). Facts travel in each
   object's `kandelo.calltypes` section. A fork-capable link (one that
   imports `kernel.kernel_fork`) skips clang's post-link wasm-opt so the
   facts still describe the code, and records the code's SHA-256 in
   `kandelo.calltypes.code-sha256`; other links drop the facts and run
   wasm-opt as before. The plugin's sources are under `sdk/src`, which is
   already a global package cache-key input. Object code is identical with
   and without the plugin. Packages that run wasm-opt between the link and
   instrumentation (cpython, php, vim, nginx, tcl, spidermonkey, the sqlite
   testfixture) fail the hash check and use the analysis without facts:
   sound, not precise. git no longer does that for `git.wasm`.
2. **The analysis in `wasm-fork-instrument`.** Done (2026-10-04): the fpa
   rules (casts, slots, effective types per unit, registries, cleanup and
   jmp_buf maps) are in `crates/fork-instrument/src/facts/`, the fsa
   additions (cleanup pairs, per-buffer longjmp bits, side-module entries
   without a contract) in `src/sink.rs`. The instrumenter reads the facts
   from the module's `kandelo.calltypes` section, binds them to functions by
   object order and name (no map), checks `kandelo.calltypes.code-sha256`
   against the code, and falls back to the analysis without facts when the
   facts are missing, unreadable or stale. Functions without facts keep
   signature matching. Flags: `--no-facts`, `--no-effective-types`;
   `--sink-plan` stays hidden for research. On the research links of foot,
   git and bash (facts concatenated in link order by
   `examples/facts_equivalence.rs`) the binding equals fpa's for every
   function and the sets and boundaries equal the table above when the
   dlopen contract is assumed (research only; bash is the one that can
   dlopen, and without the contract keeps 1,927 of 1,929). See
   `docs/fork-instrumentation.md`, "Fork sinks and compiler facts".
3. **The dlopen contract on both hosts.** Done (2026-10-04): the
   instrumenter writes `kandelo.wpk_fork.dlopen_contract` for a
   dlopen-capable module analysed with facts, and both hosts check it when
   the dynamic linker loads a side module
   (`host/src/fork-side-module-contract.ts`, called from
   `host/src/dylink.ts`). `--side-modules=traced-entries` (default)
   assumes side modules enter only through imports and refuses those that
   import a fork-returning export; `assume-all-entries-fork-returning`
   plans for any entry and loads anything. A module with an address-taken
   fork-returning function is planned for every entry automatically,
   because refusing every side module would remove `dlopen`.
4. **Effective types.** Applied by default, per strict-aliasing unit;
   `--no-effective-types` turns it off for diagnosis. It only removes
   targets, so it never adds instrumented functions (Quickshell is 10 with
   or without it).
5. **Speed and size claims:** benchmark suites on Node and browser before
   and after. Nothing here claims a speed change.
