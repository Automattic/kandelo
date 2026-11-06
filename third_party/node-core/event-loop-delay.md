# Native event-loop-delay producer source candidate

This followup consumes the sealed histogram backend/public binding without
modifying either delivered patch. It adds real native sampling owners and
separate proposed loop/provider/clone/public integration deltas. It has not
been compiled into SpiderMonkey or any Kandelo guest product. Existing frozen
audit and support declarations are unchanged.

## Exact pinned trace

`event-loop-delay-source-identities.json` records unchanged Node 26.13.0
references under `upstream/event-loop-delay-reference/`. The source commit
remains `18b32a3b1552e199a01f1a8d9fd64aa756d3b75b`; tests verify its identities
and the unchanged target pin. The already-sealed histogram references retain
the complete native IntervalHistogram/IterationHistogram code.

| Boundary | Pinned source and actual behavior |
| --- | --- |
| Public validation | `lib/internal/perf/event_loop_delay.js`: validates object, samplePerIteration boolean and resolution integer >=1 in that order. Resolution is validated even when iteration mode ignores it. Histogram defaults are lowest 1000 for interval or 1 for iteration, highest INT64_MAX, figures 3. |
| Public type/lifecycle | The full unchanged ELDHistogram subclass inherits Histogram. Illegal construction and invalid-this errors come from that class. enable/disable are boolean/idempotent; Symbol.dispose invokes disable. Public enable state changes before the native start/stop call. |
| Creation/provider | `src/node_perf.cc:320–366`: allocate actual Histogram first, then an IntervalHistogram or IterationHistogram with native ELDHISTOGRAM provider. An invalid HDR layout fails before creating the handle/provider. |
| Interval sample | `src/histogram.cc:2616–2687`: native uv_timer with resolution as repeat; unref on start; callback invokes Histogram::RecordDelta. The first callback warms prev_ and records nothing. Restart retains prev_ unless reset. No JS callback produces the sample. |
| Iteration sample | `src/histogram.cc:2712–2812`: unreferenced prepare/check handles. Start initializes check/prepare clocks and timeout 0. Prepare captures uv_hrtime and uv_backend_timeout. Check computes pre-poll latency plus positive poll-time excess over the requested timeout; timeout -1 excludes the whole poll. A zero result records 1 ns. |
| Reset | Histogram.reset clears buckets, exceeds, EWMA and prev_, and increments resetCount. It does not stop/rearm the timer or move the iteration sampler's separate check_time_. |
| Native timer schedule | `deps/uv/src/timer.c`: cached loop milliseconds, saturating timeout addition, start-id tie ordering, collect one complete due batch then repeat-arm before callbacks. Missed repetitions are not replayed. `uv__next_timeout` clamps at INT_MAX. |
| Loop phases/liveness | `deps/uv/src/unix/core.c`: prepare before actual poll, check after poll/pending callbacks, then closing handles, clock update and timers. Unreferenced samplers do not establish liveness; pending closes do. |
| GC/close | `src/handle_wrap.cc:87–157`: weak wrapper GC initiates native close; OnClose later detaches/destroys the owner. Iteration close stops/closes both native handles but has one ELD provider identity. Disable/dispose do not destroy the provider. |
| Clone | Public Histogram clone descriptor is inherited and names ClonedHistogram. Native HistogramTransferData retains the actual shared Histogram. The recipient has plain Histogram behavior; the sampler/control/environment is not cloned. Transfer is disallowed. |

## Portable producer owner

`event-loop-delay.h` implements native interval and iteration producers over
the actual pinned Histogram owner. A registry belongs to one real native
loop and is confined to its loop thread. It holds weak producer registrations
and no JS roots. Enabled samplers never count as loop references.

The interval registry consumes the loop's actual cached millisecond clock,
orders due timers and rearms once per phase. Native firing invokes actual
RecordDelta with monotonic nanoseconds. The iteration methods capture real
prepare/check timestamps and requested provider timeout. They retain the
exact Node formula, minimum sample, reset and restart distinctions. Shutdown
closes all live controls; independent material can remain shared by plain
histogram clones after sampler release. No fake zero stats, JS timer facade,
public setInterval or Timeout sample producer exists.

`event-loop-delay-native.cpp` adds an actual reserved-slot ELD class with a
foreground finalizer. It holds a native producer, the actual histogram native
object, and its async frame. Provider info reports that class's own id,
trigger, frame and ELDHISTOGRAM name; it does not reuse FS slots. Creation
uses allocateKandeloAsyncId, native:init, and the existing native async
Retain/Finalized/Release lifetime. Samples call no JS and introduce no
artificial before/after provider callbacks.

GC first stops sampling and queues native close work without running JS.
The later closing phase retires the provider exactly once. Only this transient
closing work participates in loop liveness and forces a zero-timeout close
turn; an enabled sampler alone does neither. Shutdown retires all state
before detaching the native async lifetime. Close enqueue uses allocation-free
head insertion and a detached-list drain, matching the pinned libuv native
closing-list ownership. It does not claim equivalent GC scheduling across
engines. A detached queue retires an arriving owner immediately and cannot
reopen. Native destroy-record OOM still uses the existing async failure flag.

The source134 native ledger now owns actual ELD state, handle, producer,
loop, context and close-queue allocation records. Embedded claims retain
contextless accounting metadata, never a JS root. Context and loop weak-vector
capacities, context-registry vector capacity and transient ready-batch capacity
are charged until their actual storage retires. The closing vector is replaced
by the intrusive list: its links are already in the charged state object.
Finalizing the JS handle retires only that physical handle; state, producer and
HDR material remain charged through native close retirement. Shared histogram
material retains its existing single record across aliases. Registry lookup/
shutdown does not allocate or lazily create native state in a VM realm.

As in native-retained-memory.md, this tracks requested object/backing capacity,
not RSS or allocator totals. Shared_ptr control blocks, ledger infrastructure,
fixed TLS registry metadata and allocator overhead remain excluded. Actual
owner-thread GC pressure, native finalizers, realm/context teardown and engine
clone/pressure behavior still require SpiderMonkey execution.

The full unchanged public ELD wrapper is loaded by
`event-loop-delay-platform-adapter.js`. Its native handle delegates statistics
to the actual branded histogram native object and owns native start/stop
controls. A separately prepared clone-writer delta obtains actual ELD shared
material and reconstructs a plain histogram through the existing packet
sidecar. It does not transfer the producer. Private HandleWrap ref/unref/close
methods are not exposed by this adapter; only the pinned public lifecycle is
wired. Engine-internal handle inspection remains a separate compatibility
scope.

## Concrete Kandelo loop integration and its limit

The corrected engine patch is against exact source135 canonical shell0108,
including source133 default triggers and source134 retained-memory scopes.
It preserves successful-provider rotation, lock liveness and actual lock wait
inside the existing BeginIdle/EndIdle brackets. It adds a native turn guard only after the referenced-work
liveness gate, runs native timer material at the timer phase, reduces the
existing provider wait by native unreferenced deadlines while the loop is
otherwise alive, and records the actual chosen wait with prepare/check. Nested
drains cannot replace an outer turn baseline; native context state stays owned
until its turn guard retires. Early
continues close one real nonblocking turn. Check is followed by native close
draining. BeforeExit-only/microtask-only idle paths create no sampler turn.
The async resource-info branch and explicit context shutdown are included.

Kandelo's loop currently dispatches sockets with nonblocking poll(0),
dispatches JS/native work, then waits using at most a 1 ms usleep provider
interval. Its phase topology differs from libuv's single I/O-poll phase. The
proposed hook treats dispatched work as pre-wait activity and the actual
provider wait as the subtractable poll phase. This measures real Kandelo
activity and actual timeout overrun; it is not proof of Node loop-phase
conformance. Root must review this phase contract and test actual callback,
I/O, timer, microtask, beforeExit and reentrant-drain ordering before enabling
the public factory. A future provider/poll refactor must preserve the actual
requested timeout and clock boundary, not infer one from elapsed time.

The engine delta initializes the cached native timer clock before bootstrap
and updates it at actual native timer-clock reads as well as the timer phase.
This follows the source `src/env.cc::GetNowUint64` update boundary rather than
refreshing time only when an ELD handle starts. The existing JS timer scheduler
still uses its private Mozilla monotonic epoch, while the ELD native cache
uses absolute POSIX monotonic milliseconds. Shared clock/bucket alignment and
long initial synchronous-work behavior require root integration testing;
these clocks are not replaced with Date or a JS timestamp estimate.

## Executed focused evidence and remaining scope

`tests/event-loop-delay/generate-reference.py` checks the exact pinned native
histogram source hash and extracts its actual CheckCB, adapting only its
containing class/handle unwrap. Timestamp-driven C++ controls compare the
portable owner's serialized data/exceeds with that exact callback for eight
poll/timeout cases, including minimum 1 ns, early return, exact timeout,
overrun, indefinite timeout, large timeout and over-high samples. They also
exercise reset, first-fire warmup, repeat-without-catchup, disabled restart
gap, weak registration/material lifetime, shutdown, deadline and overflow.

A host-only N-API control then attaches the same producer to the exact native
Node 26.13 loop with actual uv_timer/uv_prepare/uv_check handles. It runs both
complete pinned public wrappers and compares public option errors/lifecycle
with native perf_hooks while an actual 30 ms blocking-JS segment runs. Both
modes produce real positive samples and report the stall; disable freezes
counts; reset/dispose work; interval restart retains the disabled gap.
Native uv_has_ref checks return zero. Four bounded subprocesses verify that
reference and candidate, in both modes, exit with zero samples when only the
unreferenced monitor remains. Different native callback timestamps naturally
yield different numerical statistics; these are bounded live invariants,
not identical timing-distribution assertions or a benchmark.

The host addon uses the sealed real histogram dispatch/owner and labels its
shared-material alias control. It does not test SpiderMonkey clone transport,
provider/async hooks, native finalizers, workers, realms, GC close phases,
Kandelo loop hooks, or product behavior. No sanitizer result is claimed;
the sealed backend's sanitizer evidence remains nonpassing/incomplete.

Additional exact native-state controls use the real ledger and the production
state/handle/context struct bodies, with only the primitive async lifetime
interface supplied as a native test dependency. They cover GC-handle transfer
through deferred close, allocation denial at enqueue/drain, context detach and
re-adoption, clone-only final retention, explicit LIFO close ordering, 40
construction/publication fault positions (17 throws/23 successes), and 1536
state lifetimes across real vector growth/shutdown. Three adapter packet error
classes retain own coded-error properties under inherited setter poisoning.
Neither test dependency establishes JSAPI/GC/provider event correctness.

No root source, prior sealed source, frozen audit, kernel ABI, resolver, package
artifact or VFS image was modified. Package/engine/bootstrap/clone deltas are
private review artifacts. No guest/product/package/kernel build or overall
suite was run. Actual wasm32/wasm64 products and Node/Chromium/Firefox/WebKit
guest lifecycle, clocks, ordering, GC/provider teardown and clone validation
remain unrun. No broad ELD completion or performance claim is made.
