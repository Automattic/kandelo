# Timer public contracts and owning loop

Source review: **complete with gaps** for the public and returned-object
timer surface, including inherited async-iterator disposal. No runtime
test, probe, compilation or build was run. The current candidate is
unbuilt; source-backed paths and defects below are not conformance
results. The broader async family remains incomplete.

## Public surface and descriptors

`bootstrap.js`:3021–3220 supplies six timer functions, returned Timeout
and Immediate objects, the promises getter, util.promisify custom getters,
promise functions, the interval async generator and scheduler instance.
Registry entries at 5786–5787 and global assignments at 6673–6678 select
these exact functions/objects. Global/module function identities and the
timers.promises/direct promises-module identity are therefore real
source-backed aliases, pending runtime evidence.

Target owners are `lib/timers.js`, `lib/timers/promises.js` and
`lib/internal/timers.js`. Timeout and Immediate are returned internal
classes, not exported namespace constructors. Scheduler's constructor
throws ERR_ILLEGAL_CONSTRUCTOR; its singleton has a branded prototype.
Returned objects inherit ordinary Object behavior, while the interval
inherits async-generator/async-iterator behavior from the actual engine.

| Public contract | Source-backed behavior and remaining gaps |
|---|---|
| setTimeout / setInterval | Callback validation precedes delay coercion. Undefined defaults to 1; numeric coercion, overflow/negative/NaN warnings and one-per-module warning state precede clamping. Callback arguments and receiver are retained; intervals rearm from callback-entry time. Target and candidate preserve the untruncated duration field but truncate at insertion: `internal/timers.js`:423–446 and adapter.js:103–110. A fractional field is therefore not itself a candidate scheduling defect. |
| setImmediate | Real same-turn queue snapshot, FIFO registration and next-turn registration from a running callback. It must run after I/O callbacks, with tick/job checkpoints and correct exception continuation. Candidate has a real separate immediate map but combines its snapshot with due timers in one adapter batch; see A-013/A-014. |
| clearTimeout / clearInterval | Object, numeric and string primitive cancellation; interchangeability for timeout/interval; null/ordinary empty objects are no-ops. Callback/argument/context cleanup and async destroy belong to the owning resource, not only removal from a heap. A-010 and A-015 remain concrete gaps. |
| clearImmediate | Correctly ignores Timeout objects and empty/null input; cancels its actual immediate, clears callback/args/context/ref ownership and emits destroy once. Candidate releases _argv and actual adapter state; public lifetime still depends on the common loop/error path. |
| Timeout ref/unref/hasRef | Idempotent reference changes and receiver-return identity; keepalive is distinct from deadline eligibility. Inactive objects retain reference state without keeping the loop alive. Candidate implements this distinction through the adapter's live pending entry/ref count. |
| Timeout refresh | Same JS object, original duration, current start and preserved ref state; can reactivate an expired callback but not a cancelled callback. A destroyed resource gets a new async lifecycle owner. Candidate reuses the object and creates a new task; primitive-after-expiry cancellation differs. |
| Timeout close / disposal | close returns the same Timeout and is legacy without a new runtime deprecation warning. Symbol.dispose cancels and returns undefined. Callback/args/context ownership must be released. Target assignments and candidate class methods have different callable shapes (A-012). |
| Timeout Symbol.toPrimitive | Integer usable for clearTimeout/clearInterval in its own thread, string coercion uses the same token. Numeric tokens are local to their owning guest realm/thread and must not reference embedding-host timers. Candidate has a real map; late coercion after expiry differs (A-015). |
| Immediate ref/unref/hasRef/disposal | Returned object/ref identity, active-loop references, idempotent changes and cancellation. After execution/cancellation hasRef is false. Candidate clears immediate arguments and retires its task; target Symbol.dispose's callable descriptor still differs. |
| Promise setTimeout / setImmediate | Return a Promise, fulfill with supplied value; validate delay/options/signal/ref, reject invalid options and already-aborted signals, preserve AbortError/ABORT_ERR/reason cause, ref=false and protected abort delivery. Candidate implements actual timers and protected disposal, but option access and cleanup/reaction topology differ (A-011). |
| Promise setInterval | A real async generator: lazy start at next(), buffered elapsed ticks, supplied value, ref option, abort rejection and finally cleanup on return/throw. Candidate does not stringify values or simulate yields. Exact inherited next/return/throw/asyncIterator/asyncDispose behavior requires its engine owner. |
| Scheduler wait/yield | Branded singleton, illegal direct constructor; wait delegates to promise timeout with undefined value and options, yield to promise immediate. Experimental status does not remove the APIs. Candidate supplies corresponding methods; shared validation/scheduler gaps still apply. |
| Custom promisification and getter identity | Target/candidate both install enumerable util.promisify.custom getters on setTimeout/setImmediate, not setInterval. Timers.promises is an enumerable/configurable lazy getter returning the actual module object. Its result must remain consistent with direct imports. |

The API does not promise exact millisecond firing times or general timeout
ordering. Host suspension/throttling is not automatically a public API
failure, nor a reason to suppress timeout outcomes in a conformance run.

## Actual clock, native scheduler and host path

The adapter deadline heap/map at `adapter.js`:54–150 owns scheduled
closures, captured async context, reference count and cancellation. It
truncates delay at scheduling, snapshots immediate and currently due timer
entries and runs one callback per call to runOne. clear removes pending
ownership and nulls callback/context. A partially entered batch remains
eligible through its normal checkpoint, without conflating every future
unreferenced deadline with a reference.

The frozen candidate shell source in
`.context/node45-fs-readfile-engine-reference/js/src/shell/js.cpp`:
5067–5264 calls this scheduler from RunShellJobs. It drains nextTicks and
engine jobs, async destroys and rejection reporting; checks actual timer,
socket/native-work/GC-close liveness; dispatches native socket work and
one timer; checkpoints jobs; dispatches one native work completion and
loops. The idle path calls real usleep with a bounded next-deadline wait.
It is not a browser setTimeout facade and not native Node's event loop.
Its exact source identity is retained in state.json; no running artifact
has been newly inferred from this source snapshot.

Native monotonicTime:1939–1947 reads Mozilla TimeStamp::Now relative to a
process-local origin. The engine's POSIX implementation calls
clock_gettime(CLOCK_MONOTONIC); mozglue/misc/moz.build selects it for the
non-Darwin/non-Windows target with CLOCK_MONOTONIC. Exact archived source
hashes and branches are preserved in engine-source-evidence.json.

Guest musl clock_gettime forwards through the libc syscall channel to
`runtime-core/syscalls.rs`:11192–11218, then HostIO via
`kernel/wasm_api.rs`:790–803 and `host/src/kernel.ts`:4194–4234.
Node's provider uses actual host hrtime.bigint; browser providers use
performance.now (`host/src/vfs/time.ts`:1–53 and platform/node.ts:619).
These are different embedding clocks with a common guest monotonic
contract, not guest CPU accounting. Image-build logical-clock branches
are separate from ordinary product execution and must remain explicit in
future artifact manifests. Chromium/Firefox/WebKit clock resolution and
worker scheduling need individual evidence; no exact timing parity is
claimed by source sharing.

## Concrete findings

**A-010 remains:** clearTimeout retires native task/frame and removes the
deadline, but leaves _timerArgs reachable on a retained Timeout. Target
unenroll/cleanTimer clears arguments and captured stores. Expiry's
intentional callback retention for refresh is a distinct lifecycle case.

**A-011 — promise option access and abort cleanup.** Target
`timers/promises.js`:53–143 checks signal before ref and can reread those
public getters during validation/destructuring. Candidate's validate
destructures both before validating signal, changing getter/error order.
Target signal-bearing timeout/immediate returns a SafePromiseFinally
chain that removes the listener in its reaction; candidate finish removes
its disposable listener synchronously before resolving the returned
Promise. Listener ownership timing and public async-resource/reaction
evidence therefore need a differential control. Matching fulfillment and
error code alone would not establish the same behavior. Both implement
protected abort delivery; this is not an allegation that stopImmediate-
Propagation necessarily defeats candidate cancellation.

**A-012 — returned method/symbol metadata.** Target assigns regular
functions to Timeout.close, Timeout.Symbol.toPrimitive, both dispose
methods and has a custom inspect symbol on Timeout. Candidate implements
those as class methods, sets enumerability, and omits the inspect hook.
Enumerability alone does not reproduce regular-function own prototype,
constructibility/name metadata or the inspection protocol. Ref/unref/
refresh class methods should not be falsely described as regular target
functions. Private linked-list fields are not additional documented
module exports.

**A-013 — native I/O versus immediate checkpoint.** Shell dispatch
resolves socket watch Promises (`js.cpp`:1072–1195) and then calls the
timer batch before RunJobs. Socket connect/read public delivery occurs in
Promise reactions (`bootstrap.js`:4531–4563); therefore a queued immediate
can run before the I/O callbacks whose readiness was just dispatched.
Target ConnectionWrap::AfterConnect calls the JS completion via
MakeCallback (`src/connection_wrap.cc`:78–116), and net.js:2025–2085 emits
connect from it before the check/immediate phase. The documented
setImmediate-after-I/O contract requires an actual phase/checkpoint model,
not merely the native poll call happening first. This is a source-derived
case to validate later with controlled readiness, not a claim of a new
observed host failure or universal timeout ordering.

**A-014 — thrown timer callback bypasses recoverable fatal handling.**
KandeloRunDueTimers reports the exception and sets exitCode to failure;
RunShellJobs returns and main finalizes. No uncaughtExceptionMonitor,
capture callback or uncaughtException routing was found in this path.
Target `internal/process/execution.js`:164–228 routes the real error,
distinguishes handled from unhandled, restores async state and schedules
continuation when handled. This affects process/domain/event callbacks
as well as timers. Missing routing is an implementation gap on every
host, not an engine inability to catch/clear a JS exception.

**A-015 — first primitive coercion after expiry.** Target
Timeout.Symbol.toPrimitive registers its ID when first coerced, including
after expiry (`lib/timers.js`:207–216). Candidate registers only while
not destroyed (`bootstrap.js`:3089–3092). For a timer never coerced before
expiry, a later clearTimeout(+timer) can therefore find and clear the
target's retained callback/args; candidate misses that lookup. A following
refresh can reactivate the candidate callback that the target cleared.
The distinction is specifically late **first** coercion; it must not be
generalized to every expired/coerced timer. Native confirmation remains
unexecuted and is proposed below.

## Inherited iterator/disposal reconciliation

The promise interval is an async generator in both implementations.
Pinned V8 `deps/v8/src/init/bootstrapper.cc`:5865–5870 installs
AsyncIteratorPrototype.Symbol.asyncDispose; builtins/iterator.tq:362–415
gets return, invokes it with undefined, awaits it and fulfills undefined,
rejecting abrupt operations. SpiderMonkey `vm/AsyncIteration.cpp`:
989–1051,1320–1366 implements the same generic disposal path and installs
it under ENABLE_EXPLICIT_RESOURCE_MANAGEMENT. The recipe enables that
build feature at build-spidermonkey.sh:295; patch 0017/default shell pref
enables its syntax. Async generator next/throw/return are installed at
1054–1058. These inherit from the actual engine, rather than being
manually inserted onto the one interval iterator.

The reviewed source snapshots and hashes are preserved in
engine-iterator-source.json. No missing inherited asyncDispose boundary
is claimed. Descriptor/receiver, abrupt return getter/call, await and
finally cleanup controls remain necessary later; reading both engines'
implementations does not constitute runtime conformance.

## Later unchanged tests and controls

Retain timer tests for arguments/errors/warnings, clear object/null/other
timer types, numeric/string primitives, refresh/rearm, ref/unref/exit,
immediate queue/throw behavior, promise abort/scheduler/interval lifecycle
and async-hooks timer contexts. The catalog is a selection aid with exact
file hashes and flags, not a claim of assertion coverage or new execution.
Private --expose-internals and GC cases retain their real activation and
skip/unsupported status. Existing baseline/common-helper failures do not
prove their bodies executed; no current-candidate conformance exists.

Later native controls must cover cancellation retention/GC, late first
coercion then clear/refresh, option getter order, AbortError descriptors,
protected-listener cleanup checkpoints, returned method descriptors,
async-generator return/throw/dispose, controlled native-ready I/O versus
immediate delivery, and thrown callbacks with/without monitor/capture/
uncaughtException handlers. Run native and each host separately with
identified artifacts. Existing Firefox exit-fixture timeout remains a
historical unresolved runtime case; these source findings do not claim
to diagnose that particular timeout. No execution is authorized now.
