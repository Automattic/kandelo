# Internal backing allocation category snapshot

`backingAllocationSnapshot` is an internal current-JSContext/runtime provider
across all its realms, not a process.memoryUsage or V8 heap record. It observes
actual ArrayBuffer objects through the existing protected engine heap iterator.
This pin explicitly allocates ArrayBuffers in the tenured heap. Shared wrappers
and unmaterialized tenured typed views are classified; nursery-only unmaterialized
views are outside the census and the real nursery-empty state is reported.

Only malloc-backed ArrayBuffers are queried through the real allocator's
usable-size operation. Native allocation identities are deduplicated during
the protected walk; no object/data pointer escapes publication. On the declared
Wasm recipe jemalloc is disabled, so the callback is guest musl's actual
malloc_usable_size. Other configured allocator paths use their real Mozilla
usable-size provider or fail explicitly when unavailable. This is allocator
usable/nominal extent, not a borrowed span length, Wasm maximum, native capacity
projection or a V8-format memory statistic.

Inline payload bytes, allocated objects, detached/no-data objects and malloc
extents are distinct categories. Mapped, Wasm, external, user-owned and shared
objects have counts only; their unmeasured byte totals are absent, not zero.
Detached native-retained stores, allocations without an ArrayBuffer object and
other native containers remain outside this provider. Resizing/transfer/detach
are observed from actual current object/allocator state, not manufactured event
counters. A transfer to another Worker moves the observed object to that
Worker runtime; this is not creator-allocator or whole-process ownership credit.

Busy, incremental or suppressed heaps are refused before any data pointer is
taken. No collection or JS reentry is requested to obtain a result. Native
staging, allocator reads and deduplication occur under tracing/no-GC protection;
only copied scalar totals leave it. OOM/overflow never publish partial snapshots.
JS BigInt values/properties are created afterwards in the caller's realm.

The existing retained-memory ledger still measures different things: controller
metadata, capacities and native retention/GC-pressure projection. Its lazy
KandeloBacking ownership does not observe every ordinary allocation, and fallback
projection is not evidence of per-context backing ownership. Do not sum it into
this snapshot or rename capacity as live allocation bytes.

Public process.memoryUsage remains its existing unavailable measurement owner.
RSS, total/used JS heap, external memory, complete ArrayBuffer allocator ownership,
shared/raw/Wasm/mapped/external/native-only and unmaterialized backing providers
are still implementation gaps. This source does not activate fake fields or a
full compatibility claim. The new engine API/native bridge is uncompiled and
unexecuted; no runtime checks, probes, compilers, generation or overall suites
were run. Two needed unmodified Mozilla leaves were selectively reconstructed
from the verified source archive and current ordered patch inventory.
