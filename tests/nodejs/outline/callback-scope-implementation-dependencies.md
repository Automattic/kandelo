# Shared native callback-scope implementation dependencies

N-013, filesystem/compression callback ownership and the async family gain
partial shared source owners. The exact Node 26.13.0 pin, frozen audit and
historical nonpasses remain unchanged. This is not family closure or current
four-host conformance. Full rebuilds and overall suites remain deferred.

## Actual source and lifetime

callback-scope.h supplies one compiled C++ policy; native-callback.cpp adapts
it to actual SpiderMonkey resource roots, realms, async context, hooks and
stopping/error state. native-async.cpp owns per-context callback depth and
refcounted lifetime. Shutdown asserts depth zero; worker threads never touch
these JS-owned fields. Entry/close failures restore prior context without
calling user JS. A failed or stopped body has no after hook or checkpoint;
a successful outermost body emits after, restores context, then checkpoints.
Nested native calls keep their caller live and defer their own checkpoint.

native-fs.cpp, native-dns-lookup.cpp and codec-handle.cpp select this owner.
Actual request/handle/frame roots stay live through the checkpoint, before
the producer's existing retirement/close cleanup. Existing fd handoff and
native pin release still happen at their owning I/O boundaries. No generic
AsyncResource/Promise, fabricated provider identity, syscall, host import
or wire ABI is introduced by this scope.

Patch 63 supplies the real owning-context checkpoint: pending nextTicks
first, then engine jobs, repeating when jobs queue more ticks. It does not
poll sockets, dispatch another native work item, run timers or flush native
destroy records before the current request's retirement fence. The current
embedding rejection owner is reused and still has the limitations below.

Actual bootstrap, timer, tick-dispatch and microtask entry points also own
callback depth. Their resource hooks already belong to their JS/engine
owners, so these entry guards add no synthetic resource or duplicate hooks.
This prevents synchronous native callbacks from recursively draining the
surrounding JS entry's queues. An explicit quit after native dispatch is
observed before generic error handling can replace its requested exit code.

## Exact target references and native observations

Pinned src/api/callback.cc, src/async_wrap.cc and
lib/internal/process/task_queues.js remain unchanged full reference files.
The target closes after hooks/context pop but before ReqWrap destruction;
only successful outermost scopes run task queues. Actual Node-API
MakeCallback plus a real libuv timer supplies an independent native control.
Its own provider is a native test fixture, not a guest DNS/FS provider.

The actual shared policy compiles separately with explicit deterministic
hook/context/queue boundary adapters. Its traces match native Node in eight
scenarios: outermost completion; nested native calls; a throwing nested
callback; fatal before hook; module, Promise-job and timer JS entries; and
explicit process exit. The normal/nested cases preserve async-local stores
and keep the outer resource live through ticks and jobs. Native callbacks
inside an existing JS entry retire before that entry's later checkpoint;
Promise-job entry also retains job-before-nextTick ordering. These entry
observations determined where source guards were needed.

The fatal native control deliberately exits 1 with its diagnostic and no
body; explicit exit deliberately returns 17 with no after/tick/job delivery.
Both raw outcomes and expected statuses are retained, not converted into
unrecorded failures or passing guest tests. C++ policy checks also cover
idempotent close/entry cleanup, pending error/unready entry and stopping
during a checkpoint. This tests the actual policy, not the JSAPI adapter.
The project-quoted native header closure is archive-verified (including
inactive platform branches); system headers come from the declared compiler.

Initial four-scenario and intermediate entry/exit controls remain historical
artifacts with their own exact input copies. The final eight-scenario run
has current policy/fixture hashes. No new overall or guest suite ran.

## Remaining implementation and validation

The SpiderMonkey adapter, source patch and changed native producers remain
uncompiled. Static checks and a compiled policy with controlled queue/context
boundaries do not prove JS rooting, GC, actual RunJobs reentrancy or shutdown.
Identified engine artifacts need unchanged upstream native-callback, async
hooks/context, nextTick/microtask, filesystem, DNS, compression and exit tests
on Node/Chromium/Firefox/WebKit. Include relevant browser-memory/lifecycle
checks; no stale product artifact can count as this candidate.

Full Node promise rejection events/modes and uncaught-exception recovery are
still missing or partial in the embedding's current rejection/error owner.
The shared scope preserves existing pending errors and stopping status; it
does not implement those missing public policies. Zero-ID/native-immediate,
weak-reference cleanup, worker/VM realm activation and resource-specific
reset/metadata/cancellation need their complete owning review/validation.
Timers/sockets/JS producer queues and the full loop phase model are separate
remaining work; this scope is not a replacement event loop or libuv runtime.

After this initial shared foundation, continue independent audited Buffer/
encoding/filesystem/loader/stream/process gaps rather than expanding a deep
callback/DNS test campaign. All original family/API obligations remain open
until actually implemented or justified by concrete platform boundaries and
validated. No new platform exclusion is accepted by this source slice.
