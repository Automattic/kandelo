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
| scheduleTimer(duration) | timers.cc; deps/uv/src/timer.c | Actual single native deadline; replacement, native signed-64 coercion, uint64 overflow saturation, initially unreferenced |
| toggleTimerRef(value) | timers.cc | True-only flag controls actual active timer liveness; inactive referenced flag alone does not keep the loop alive |
| toggleImmediateRef(value) | timers.cc | True-only immediate idle/liveness flag; callback consumes actual live counters |
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
There are no finalizer-owned JS roots or borrowed backing pointers.

A userspace timer deadline is the real resource, as with uv_timer_t; no fake
kernel descriptor or handle is allocated. Absolute deadlines retain all 64 bits,
including overflow saturation. Diagnostic snapshots expose exact BigInt deadlines.
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
not. Due callbacks run on their actual deadline, with engine microtask
checkpoints between native phases. Phase continuation is cleared when the loop
becomes idle, rather than leaking into a later drain.

Callback exceptions are preserved through native loop failure and explicit
drainJobQueue, and uncaught main-loop errors receive an error exit. Reentrant
native dispatch rejects. Native callback-scope/AsyncWrap/tick/fatal retry
integration and complete Node/libuv phase semantics remain unfinished. These
raw callback controls are not proof of full Node callback/error behavior.
Detached backing arrays fail explicitly rather than fabricating zero counters;
full buffer transfer/detach, security, OOM and finalization contracts remain open.

The original Node body now reaches task_queue through unchanged internal/timers.
This does not establish successful bootstrap, original public setTimeout,
CommonJS/ESM user entry, actual process exit dispatch or browser behavior.
Native-reference cases use the exact pinned executable already bootstrapped;
foreign functions there use a VM context, not a fresh native Node Realm.
Explicit --no-warnings prevents internal/test/binding warning I/O from changing
isolated unref-only liveness controls. Exit controls use synchronous output and
natural process termination. All source/artifact identities, failure histories
and validation limits belong in timers-engine-check.json.
