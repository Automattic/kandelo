# Native task queue and callback ownership

Target: unchanged Node.js 26.13.0 at
`18b32a3b1552e199a01f1a8d9fd64aa756d3b75b`. This is a partial backend
inventory and startup implementation order, not a completed binding or the
full backend roadmap. The raw native binding is now partially implemented;
original public task-queue modules and complete async/fatal policy remain
unfinished. Exact reviewed source identities, literal consumers
and selected runtime observations are in
[task-queue-contracts.json](task-queue-contracts.json) and
[task-queue-gap-result.json](task-queue-gap-result.json).

## Upstream policy and native surface

The original `internal/process/task_queues` owns the nextTick FIFO, argument
dispatch, tick flags, async resource entry/exit and interleaving with promise
rejection processing. The original `internal/process/promises` owns pending
rejection tracking and the selected warning/throw policy. Keep both complete
bodies unchanged and load them through the existing original realm loader.
Native code supplies their actual shared state, engine operations and callback
scopes; it must not implement a second JavaScript tick/rejection algorithm.

| Export or state | Native source | Required behavior |
|---|---|---|
| `tickInfo` | `env.h` TickInfo; `node_task_queue.cc` Initialize | Environment-owned live Uint8Array of length 2: tick scheduled at index 0, rejection to warn at index 1. Native scope decisions read the same storage that upstream JS mutates. |
| `enqueueMicrotask(callback)` | `node_task_queue.cc` EnqueueMicrotask | Assert the original function invariant, enqueue into the current context's actual engine microtask queue and return undefined. No host Promise or second FIFO. |
| `runMicrotasks()` | `node_task_queue.cc` RunMicrotasks | Checkpoint the environment's engine queue. It neither runs libuv phases nor duplicates nextTick policy. Nested checkpoints must preserve current-job ordering and kept objects. |
| `setTickCallback(callback)` | `node_task_queue.cc` SetTickCallback | Assert function, retain the actual callback in environment state. Native scope close invokes it with the environment process receiver and no arguments when live flags require ticks/rejections. |
| `promiseRejectEvents` | `node_task_queue.cc` Initialize | The native binding contract exposes `kPromiseRejectWithNoHandler=0` and `kPromiseHandlerAddedAfterReject=1`. Translate actual engine events explicitly. |
| `setPromiseRejectCallback(callback)` | `node_task_queue.cc` SetPromiseRejectCallback | Assert function and retain the actual callback. Deliver `(type, promise, value)` with undefined receiver; reject uses the original reason, handler-added uses undefined. Ignore resolve/reject-after-resolution notifications. |

All four native method registration lengths are zero. Callback replacement
must affect the protected native owner, independently of mutable public binding
properties. Root callback functions, promise/error identities, frame state and
the process receiver across moving GC and cross-realm calls. The environment
owns shared flags; each realm's binding retains its own admission owner. Reject
retired owners and invalid/detached storage explicitly. Do not borrow backing
array pointers across fallible calls or publish partially initialized state.

The promise rejection tracker can run synchronously during reject/handler
attachment. Node enters the promise's assigned async context when both IDs are
valid, calls the original registered JS handler, then conditionally restores
the context. Its native try/catch reports errors from that handler without
leaking a pending exception back into the engine. Complete async ID, hook and
continuation-frame behavior requires the actual `async_wrap` and
`async_context_frame` contracts; invented zero IDs or disabled hooks/options
cannot stand in for them.

## Callback scope and exit requirements

`src/api/callback.cc` is the native ordering authority. Entry counts native
scope depth, checks stopping/admission state, exchanges the continuation frame,
pushes actual async IDs/resource and emits before hooks when required. Close is
idempotent: stopping clears the async stack; successful execution emits after
hooks; IDs and prior frame are restored; failure skips the successful checkpoint
path. Only the outermost eligible scope processes task queues. It performs an
engine checkpoint if no tick is scheduled, rechecks stopping state, and invokes
the retained tick callback if either live flag remains set. Nested native
callbacks must not recursively drain their caller's queue or retire its state.

`src/node_errors.cc` TriggerUncaughtException invokes the actual
`process._fatalException(error, fromPromise)` with the process receiver. That
property is intentionally mutable upstream. Reentrancy, handler errors, invalid
handler installation, an exactly-false result, exit-code selection and at-exit
work have native behavior; synchronous rethrow or unconditional success is not
equivalent. The unchanged JS error/exit policy still needs its real process
and native errors backends. The existing libuv timer owner must eventually use
this common scope rather than a separate timer-specific recovery path.

## Measured prerequisites and gaps

The revision-27 engine/kernel pair from the libuv timer receipt was probed on
the Node outer host with empty guest filesystems. Five selected shell
observations across three isolated guest processes establish:

- Actual engine jobs and Promise reactions share FIFO order, including jobs
  added during a checkpoint; nested drain calls do not reenter the current job.
- Engine rejection and handler-added notifications contain the actual promise
  identity. These raw shell callbacks have a different signature from Node's
  binding and do not establish Node rejection policy or reason delivery.
- A thrown shell job is reported to stderr, the queue continues, and the guest
  exits 3. Surrounding JavaScript does not catch it. The pinned native Node
  reference instead reaches the installed `uncaughtException` listener with
  the original error and continues without a diagnostic/error exit.
- A forced-GC nested shell checkpoint collects a WeakRef target that survived
  immediately before that checkpoint. The selected pinned native Node control
  keeps the current job's target alive across its nested checkpoint.

The revision-27 source review explains the two gaps. `InternalJobQueue::runJobs` catches job
exceptions and reports them through the shell's script-environment preparer.
`js::RunJobs` calls `ClearKeptObjects` even when its underlying queue returns
early because a drain is already active. Wrapping the shell globals would
inherit these policies. Reuse the actual engine queue with native Node error
routing and an outer-checkpoint guard that prevents nested kept-object cleanup.
The revision-28 integration below uses the existing script-environment preparer
as the native job-exception seam.
No outside runtime defect or workaround is claimed by these shell API probes.

Six separately executed pinned native reference controls cover binding layout,
FIFO, nested suppression, current-job WeakRef liveness, handled microtask
exceptions and original rejection promise/reason identity. Native Node is
already bootstrapped; these are reference contracts, not guest equivalence.
No new browser queue probes, full native async/fatal policy differential,
security/OOM/fork/lifecycle checks or successful Node startup were run.

The literal inventory has four direct binding consumers (`internal/timers`,
`internal/async_hooks`, `internal/process/task_queues`,
`internal/process/promises`) and twelve consumers of the task-queues JS module,
including web bootstrap, streams, networking and test/benchmark runners. This
is an exact-spelling search over the pinned import, not complete dynamic,
conditional, worker or exceptional reachability accounting.

## Native integration and remaining startup order

Revision 28 implements the six raw export/shared-state entries with protected
environment state and per-realm binding admission. Native job adapters retain
actual callables in traced slots and enqueue into the real engine FIFO; they
do not wrap a Promise or supply a second queue. The actual engine draining flag
guards nested native and shell checkpoints before kept-object cleanup. Live
flags use Node's exact-one test. Outer native checkpoints dispatch the retained
tick callback with the principal process receiver; microtask-only entry stays
separate. Invalid functions and missing registrations preserve native assertions.

The script-environment preparer forwards actual job exceptions to the native
owner while its checkpoint is active. A callable, mutable principal process
`_fatalException` receives the original error and `fromPromise=false`; every
result except exactly false is treated as handled, matching that native seam.
Missing/throwing/exactly-false policy stops the checkpoint and preserves the
actual error instead of claiming a handled error or successful process exit.
Full fatal exit/at-exit and original global uncaught-exception JS policy remain
unfinished. The full native async-resource callback scope is not implemented.

Actual rejected promises/reasons and handler-added events reach the registered
native callback with explicit event translation. Callback errors are reported
without a false shell error exit. Promises carrying assigned async IDs encounter
an explicit missing-context diagnostic instead of invented ID/resource state.
Checkpoints during active module evaluation also fail explicitly. No complete
AsyncWrap/frame/hook, rejection-policy or public queue compatibility follows.

The unchanged principal body first reached absent `errors.exitCodes`; this
intermediate TypeError and the first 24-of-25 control result remain retained.
Importing the complete pinned native enum header and expanding its macro
supplies all fourteen constants with native attributes. Their values match
the pinned executable. This is constant identity, not process-exit support.
Original bootstrap now reaches missing `async_wrap` at internal/async_hooks:14
through internal/timers:106. Original stack-limit policy still lacks constants.

Twenty-six selected controls pass on Node, Chromium, Firefox and WebKit using
identical engine/kernel bytes, including actual FIFO, nested WeakRef liveness,
moving GC, cross-realm promises/callbacks, original failure identity and libuv
checkpoint integration. Separate drivers retain natural job draining, quit
status, unsupported/error boundaries and fatal assertions. The same artifact
passes the prior 162 cases on Node. Six native references and fourteen enum
values are checked separately. Exact artifacts, source identities, failures,
diagnostics and limits are in
[task-queue-engine-check.json](task-queue-engine-check.json).

The original shell-primitives gap receipt above is historical revision-27
evidence; the ordinary shell path without native task state retains its policy.
These new controls remain raw binding/checkpoint evidence, not successful Node
startup, original public queue equivalence or full callback-scope conformance.

1. Implement the native async ID/resource/frame and common callback-scope
   prerequisites needed by the unchanged modules. Preserve current exception,
   scope depth, clearing epochs and restoration through reentrant callbacks.
   Hook/option policy comes from unchanged upstream JS and actual configuration.
2. Complete outer shell/libuv callback scopes around the original
   retained tick callback and promise policy. Keep microtask-only checkpoints
   distinct from complete nextTick/rejection checkpoints. Validate original
   exceptions, handled/unhandled rejection timing, natural liveness and exit.
3. Reexecute the original principal body, record its next actual missing
   backend, and extend the dependency inventory from that result. The binding
   becoming loadable alone does not establish usable public timers or startup.
4. Repeat the resulting identified-artifact startup checks on Node, Chromium,
   Firefox and WebKit; keep CJS and ESM entry acceptance separate. Full products,
   successor-ABI campaigns and overall suites remain deferred.

Archived native mechanisms remain candidates at frozen commit
`5f19f5f1c61cc80adb8e39e1f8470b497f34e9c8`:
`third_party/node-core/callback-execution-stack.h` supplies owning scope tokens,
clear epochs and restoration; `callback-scope.h` supplies nested scope/recovery
ordering. Their source identities are retained in the inventory. Adapt only
mechanisms that match the pinned native contract; do not import their former
handwritten public JS adapters or assume previous controls prove this runtime.

Reproduce these bounded gap observations with the exact engine and verified
native executable recorded in the receipt:

```bash
scripts/dev-shell.sh node_modules/.bin/tsx scripts/run-nodejs-job-queue-gap.ts \
  <revision-27-js.wasm> <pinned-native-node> <report.json>
```


## Subsequent async-state integration

Revision 29 implements the assigned Promise rejection context seam described
above using actual shared IDs and the actual Promise resource. Conditional pop
also runs after callback errors and respects stack reset. Complete native
callback scopes, engine Promise lifecycle hooks, continuation frames and fatal
exit remain incomplete. The original principal body now passes internal/async_hooks
and stops on constants. See [async-wrap-contracts.md](async-wrap-contracts.md) and
[async-wrap-engine-check.json](async-wrap-engine-check.json) for current identified
artifacts, shared native controls and four-host evidence. Earlier revision-28
observations above remain historical evidence.
