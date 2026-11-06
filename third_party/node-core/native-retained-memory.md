# Native retained material and GC credit

The ledger belongs to one native Node embedding process/module instance and its
worker JSContexts. It is not a browser/Node host-process RSS meter. The N-API
control owns a separate host-addon instance and does not prove guest GC policy.

An Allocation belongs to actual native material. Its Record remains registered
while that material/container lives, independent of a source JS wrapper or
context. Claims retain native accounting metadata and identify actual local
holders; they cannot keep payloads, JSContext pointers or JS roots alive. Multiple
claims/clone aliases/fan-out packets do not multiply a material record's bytes.

Tracked sizes are requested native object/backing-storage sizes: HDR material,
recorded snapshot bucket capacities, captured HDR sources, QRDE probability and
result vectors, sliding-window ring vectors, clone sidecar capacities, packet
objects/claim nodes, and clone-buffer sizeOfExcludingThis(moz_malloc_size_of).
These are not a complete allocator/RSS measurement. Shared_ptr control blocks,
ledger/registry infrastructure, allocator overhead, and unrelated engine-owned
transferred backing stores are outside this byte total. A zero-byte record is
still a live container record; Inspect.allocations is not a malloc-call count.

Histogram/snapshot/source ownership tracks cache publication, cache hit,
invalidation, concurrent work and last native release. Fixed JS binding state
and its own claim node retain their ordinary object-associated charge. Full HDR
material is no longer charged independently for every wrapper. Native worker
threads update only the ledger; they never call GC APIs.

Every primary main/shell-worker/Node-worker environment explicitly registers a
native Account. Its GC anchor is the already-rooted primary environment global;
no account is lazily rooted in a VM realm. SpiderMonkey AddAssociatedMemory
requires a non-nursery object (jsapi.cpp:1254-1265); JS_NewGlobalObject provides
that tenured environment anchor, unlike an unproven plain job object. The local environment scope detaches
its account and removes all actual credit before releasing the anchor. Only
inert native account metadata may outlive it. The existing histogram prototype
realm registry is a separate, still-open realm-lifetime validation concern.

The ledger prefers one active actual claimant for each record. With no live
claimant, actual native material remains in a pending-ownership pool, including
queues without a registered destination. One live account projects that pool
into advisory GC credit; this is a pressure projection, not guessed receiver
metadata. With no live accounts, the cost stays in the native ledger until later
attachment or last release. Context retirement reassigns native desired credit
under the ledger mutex, without touching another thread's JS roots or GC APIs.

Owner-thread CreditBalance reconciles desired credit using matched
AddAssociatedMemory/RemoveAssociatedMemory calls at real entries/checkpoints.
No native memory account keeps an event loop running. Advisory GC credit may lag
native resize/release and can transiently overlap across independent context
flushes. The mutex-protected native payload total and desired projections remain
conserved. This is not proof of real GC scheduling, zone pressure or bounded
host/guest memory under load; those require actual JSAPI execution.

Packet serialization measures retained clone storage; sidecar writes account
real vector growth. Claim replacement allocates a complete transaction before
commit. Source claims retire before enqueue, so no sender mutates receiver-owned
claim storage. A queue retains native records, not source JS roots. Receive/read
adopts native claims in the destination; buffer/sidecar material retires on read
failure, consume, queue close, broadcast last recipient or worker teardown.
Packet claim/adoption/clear metadata uses a native mutex, never held over JS or
GC calls. Broadcast shares its one content allocation while each real delivery
owns its own packet record. Worker bootstrap/input/error paths use the same
ownership operations. Existing clone callbacks, transfer/abort behavior and
worker prototype activation still require the combined-engine controls.

QRDE completes in the actual primary environment realm. It creates its fresh
plain zero-ID execution resource there, then enters the shared internal callback
scope. The callback persistent root retires before the callback checkpoint;
work/snapshot lifetime continues through that checkpoint as in pinned QrdeJob.
No synthetic QRDE AsyncWrap provider or filesystem request is introduced.

Source boundaries: pinned Node26.13 src/histogram.cc MemoryInfo (183-187),
QrdeJob (963-1045), and src/api/callback.cc InternalCallbackScope (61-217);
production SpiderMonkey js/public/MemoryFunctions.h (73-90),
js/public/StructuredClone.h (494-500,626-628,737-743), and
js/public/AllocPolicy.h SystemAllocPolicy and js/src/jsapi.cpp:1254-1275. The embedding's ledger and pressure
projection are new owning infrastructure, not an unchanged upstream algorithm.

Focused controls cover portable conservation, partial-claim/allocation OOM,
concurrent mutation/context detach, actual portable Histogram/cache/work,
Endpoint and BroadcastRegistry lifetime, and truthful N-API transport. They do
not validate SpiderMonkey compilation, actual clone hooks/GC/OOM/cancellation,
ELD phase/pressure behavior, wasm32/64 products or four-host guest execution.
