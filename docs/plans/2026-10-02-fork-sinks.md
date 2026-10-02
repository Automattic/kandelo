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
