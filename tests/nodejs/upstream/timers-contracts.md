# Native timer scheduler boundary

Pinned Node.js 26.13.0 source commit:
`18b32a3b1552e199a01f1a8d9fd64aa756d3b75b`. Original complete
internal/timers remains responsible for JavaScript timer lists, timeout objects,
expiry calculations and public policy. This native backend implements its
binding/scheduler seam; it is not a replacement public timer implementation.

## Contracts and ownership

| Native export/state | Original source | Current owner and behavior |
|---|---|---|
| immediateInfo | timers.cc; env.h ImmediateInfo | One actual runtime-owned Uint32Array: count, ref count, has outstanding |
| timeoutInfo | timers.cc; env.cc constructor | One actual runtime-owned Int32Array of length one |
| setupTimers(immediate, timers) | timers.cc SetupTimers | Original function invariants; transactionally retain the actual two callbacks, environment process and principal realm |
| getLibuvNow() | timers.cc; env.cc GetNowUint64 | Guest CLOCK_MONOTONIC milliseconds relative to real environment creation, refreshing the loop's cached time |
| scheduleTimer(duration) | timers.cc; deps/uv/src/timer.c | One actual uv_timer_t; libuv owns replacement, cached-clock deadline and uint64 saturation, initially unreferenced |
| toggleTimerRef(value) | timers.cc | True-only flag controls actual active timer liveness; inactive referenced flag alone does not keep the loop alive |
| toggleImmediateRef(value) | timers.cc | True-only starts/stops a real uv_idle_t; an unreferenced uv_check_t consumes live counters |
| Timer callback result | env.cc RunTimers | Positive expiry rearms referenced, negative expiry rearms unreferenced, zero unrefs without discarding reentrant scheduling |
| Immediate callback | env.cc CheckImmediate | Environment process receiver, no arguments, live counters/outstanding continuation and auto unref when references reach zero |

All five native methods retain their original names and native registration
length of zero; the accepted argument contracts are listed above.

The first successfully initialized native realm is retained as the environment's
principal realm/process. Later realm binding instances retain their own admission
owner but share the actual arrays, timer state and principal process receiver.
Registration through another realm does not replace the principal process.
Callbacks can be foreign functions; the actual engine call handles their realm.
Native private slots and checked compartment wrapping trace every reference.
There are no finalizer-owned JS roots or borrowed backing pointers. Native
callbacks borrow a pointer to the dispatcher's stack RootedObject only during
uv_run; GC can update that root. The pointer/context/checkpoint are cleared on
all dispatch returns. Foreground finalization closes every successfully
initialized native handle, drains null close callbacks, closes the real loop
and frees native storage, including partially initialized construction paths.
Public handle/layout sizes are checked before the library writes allocated
state. The explicit Kandelo header selector takes precedence over ambient
legacy engine Linux macros; libuv itself is compiled as the true Kandelo target.

The owner allocates a genuine uv_loop_t, uv_timer_t, uv_check_t and uv_idle_t.
Libuv's internal signal/async pipes are real guest descriptors. The optional
uv_prepare_t services actual engine job checkpoints while existing non-libuv
native watches are polled by the shell. No descriptor identity is invented.
Absolute deadlines come directly from the real timer handle and retain all 64
bits, including overflow saturation; snapshots expose them as exact BigInts.
The clock cache currently requires exact Number millisecond representation;
a monotonic value beyond 2^53 milliseconds fails explicitly. The signed-minimum
callback expiry also fails explicitly. Duration conversion follows the original
V8 IntegerValue native contract, including NaN zero, saturation, coercion and
exception propagation; this is engine/binding adaptation, not rewritten JS.

## Loop and failure boundary

The real shell loop selects the native scheduler only when a protected native
timer state exists. That path never reads the public compatibility timer hooks.
Other shell contexts retain their prior adapter path. Active references or real
external native I/O keep a turn alive; unreferenced timers/immediates alone do
not. The native-only path uses UV_RUN_DEFAULT: actual libuv owns phase progression,
poll blocking, cached time and reference liveness. The shell's old sleep loop is
not used there. Timer/check callbacks run actual engine job and finalization-task
checkpoints; outstanding immediate batches are processed by the native check
callback. There is no parallel deadline heap or PreferImmediate phase flag.
Existing non-libuv native I/O uses a documented UV_RUN_NOWAIT bridge and the
prior shell poll/sleep path; full socket migration remains separate work.

Unref does not cancel an event already eligible in an active loop iteration.
A fresh UV_RUN_DEFAULT drain can service a reentrant zero-delay timer once more
before exit, even after the first callback returns zero and unrefs it. The
pinned native executable confirms this isolated case. Future reentrant
scheduling is tested separately from that same-drain phase behavior; the former
custom scheduler's immediate-stop expectation was incorrect.

Callback exceptions are preserved through native loop failure and explicit
drainJobQueue, and uncaught main-loop errors receive an error exit. Reentrant
native dispatch rejects. Native callback-scope/AsyncWrap/tick/fatal retry
integration and complete Node callback-scope semantics remain unfinished. The
phase machinery itself is now real libuv; that does not establish full Node
async context, rejection or exception recovery behavior. These
raw callback controls are not proof of full Node callback/error behavior.
Detached backing arrays fail explicitly rather than fabricating zero counters;
full buffer transfer/detach, security, OOM and finalization contracts remain open.

The original Node body now reaches task_queue through unchanged internal/timers.
This does not establish successful bootstrap, original public setTimeout,
CommonJS/ESM user entry or actual process exit dispatch. Four-host binding/loop
results must be recorded separately from successful Node startup.
Native-reference cases use the exact pinned executable already bootstrapped;
foreign functions there use a VM context, not a fresh native Node Realm.
Explicit --no-warnings prevents internal/test/binding warning I/O from changing
isolated unref-only liveness controls. Exit controls use synchronous output and
natural process termination. All source/artifact identities, failure histories
and validation limits belong in timers-engine-check.json.
