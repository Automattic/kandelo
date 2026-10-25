# JSC-BLOCKED-WAIT-GC-STARVATION

Status: suspected. A standalone page shows the pinned GC helper threads,
but only in a manual stack sample; no page has yet judged the defect by
itself. Not filed.

## Defect

Suspected JavaScriptCore (JSC) behavior. Reading
`WaiterListManager::waitSyncImpl` suggests a thread blocked in
`memory.atomic.wait32` (or `Atomics.wait`) waits inside a
`VMBlockingScope`, which does not release the thread's heap access. If a
concurrent collection has begun in that worker's VM, `Heap::stopTheMutator()`
then hands the collection to the blocked thread ("handed off the conn") and
returns. The collection can advance only when that thread polls, from an
allocation slow path or its run-loop timer, and a thread that stays blocked
never does. Every shared `Heap Helper Thread` that joined the collection
stays in `SlotVisitor::drainFromShared(HelperDrain)` until the collection's
End phase, which never comes. Helpers pick a heap at random
(`ParallelHelperPool::getClientWithTask`), so a few blocked workers soon pin
all of them (six on the tested Mac).

The downstream effect seen in Kandelo is that other VMs' collections then
stall: a collector in `drainInParallelPassively` waits for termination with
no deadline, an exiting worker's `~VM` waits in
`Heap::lastChanceToFinalize`, its `WebAssembly.Memory` reservation is never
released, and the thread that next creates a memory waits in
`Heap::waitForCollection` forever.

## Why Kandelo is affected

A Kandelo process makes each syscall by writing its channel and waiting in
`memory.atomic.wait32` until the kernel answers, without returning to
JavaScript. Idle processes (a shell at its prompt, a database waiting for a
client, PHP-FPM waiting for requests) therefore stay blocked indefinitely.
On the WordPress + MariaDB machine in Playwright WebKit this hung the
machine within the first few terminal commands. The user-facing account is
in `docs/browser-support.md`, "JavaScriptCore garbage collection and
blocked workers".

## Workaround and its cost

On JSC each syscall wait is bounded at 100 ms. After a timeout the glue
(`libc/glue/channel_syscall.c`) calls the host import
`kernel.kernel_heap_safepoint` (ABI 52, `host/src/heap-safepoint.ts`), which
allocates a small `ArrayBuffer`, giving the VM an allocation slow path, and
keeps waiting on the same request. The syscall's result, blocking and errno
semantics do not change. V8 and SpiderMonkey get a negative bound on the
first timeout and wait without a timeout from then on.

Cost: one wakeup per blocked thread per 100 ms on JSC; a new required
process import, so an ABI bump (51) and a rebuild of every program; the
glue's wait loop is more complex. The import's declaration in
`crates/shared/src/lib.rs` (`HEAP_SAFEPOINT_PROCESS_IMPORT`) is a further
site; it is described by the ABI version comment there but carries no tag.

## Evidence

All on Playwright WebKit webkit-2359 (reported as `26.6`), macOS 27.0.1.

In Kandelo (WordPress + MariaDB, 20 terminal commands):

| condition | result |
|---|---|
| default | 0 of 4 runs finished; each stopped after the first command |
| `JSC_numberOfGCMarkers=1` (no helper threads) | 2 of 2 finished |
| with the safepoint workaround | 5 of 5 booted runs finished (a sixth crashed during boot from `WEBKIT-TEXTDECODER-WRAPPER-CRASH`); `php-web-image-cli.spec.ts` WebKit cases 9 of 9 |

A stack sample of a hung run showed all six helpers in `drainFromShared` of
`runBeginPhase` tasks, six collector threads in `drainInParallelPassively`,
four terminated workers in `~VM` → `Heap::lastChanceToFinalize`, the thread
creating a new `WebAssembly.Memory` in `tryCreate` → `collectSync` →
`waitForCollection`, and about 26 workers in `waitSyncImpl`.

The standalone page `repro/repro.html` (24 workers that start a collection
and then block; see its header for the modes), sampled 3 s after the
workers blocked (`sample <WebContent pid> 2`; collections counted with
`JSC_logGC=1`):

| mode | blocked worker | helpers in `drainFromShared` | started, unfinished collections |
|---|---|---|---|
| A | blocks at once, no collection in flight | not measured | 0 |
| B | collection in flight, infinite wait | 6 of 6 | 7 to 11 |
| D | 50 ms timeout, back to JavaScript, no allocation | 6 of 6 | 9 |
| C | 50 ms timeout, then `new ArrayBuffer(8)` | 0 of 6 | 0 |

So a blocked worker with a collection in flight pins the helpers, and an
allocation slow path in that worker releases them (mode C), which is what
the workaround does. Returning to JavaScript without allocating (mode D)
does not help.

### Self-judging attempts (2026-10-22, both negative)

The page does not freeze on its own: the kernel worker's synchronous
collections still finish (300 of 300 constructions in mode B). Two signals
the page could observe were tried, comparing mode B with mode C:

1. **FinalizationRegistry probe** (`probe=1`). Three seconds after the
   workers block, a new worker registers an object with a
   `FinalizationRegistry`, drops it, allocates, and idles, each round. A
   callback can run only after a collection in that VM finishes. Callbacks
   ran in every mode: A 100/100, B 100/100, C 98/100; with a 2,000,000-object
   live graph, 500,000 garbage objects per round and 300 ms idle, B 40/40
   and C 40/40 (twice each).
2. **Transient-worker reservations** (`transients=40`). After the workers
   block, 40 busy workers each create a shared memory with a 4 GiB maximum
   (about 15 such reservations fit at once on this host) and are terminated
   while a collection is in flight in their VM. If their VMs could not
   finish dying, a later worker's memory would fail with `RangeError`. All
   40 succeeded in A, B and C. A stack sample of that mode-B run showed six
   of six helpers in `drainFromShared`, so the helpers were pinned while
   other VMs' collections and VM teardown still completed.

Driver results on the committed page (webkit 26.6, macOS):

```
mode B: inconclusive; no worker stalled (300 constructions, 0 transients)
mode B, transients=40, probe=1: inconclusive; 40 transients; probe ran 40/40 finalization callbacks
mode C, transients=40, probe=1: inconclusive; 40 transients; probe ran 40/40 finalization callbacks
```

## What is still unknown

- The standalone page shows helper pinning but not the stall that pinning
  is supposed to cause: in the page, other VMs' collections, terminated
  workers' teardown and the kernel's synchronous collections all finish
  with the helpers pinned. The extra ingredient in Kandelo that turns
  pinning into a hang (perhaps the kernel idling between messages while its
  collector conducts passively, the disposable memory-allocation workers,
  or the number and size of heaps) is not identified.
- Until a page reports the hang or the pinned helpers on its own, without a
  person reading a sample, and passes with the safepoint's allocation, the
  cause stays a hypothesis that fits every measurement. A result that the
  hang happens without blocked workers holding collections (for example
  with every wait bounded but no allocation) would point back at Kandelo.
- Bun was not tested; it embeds JSC, so it is listed as possibly affected.

## Draft upstream report

Not ready to file (the entry is suspected). Draft for bugs.webkit.org,
component JavaScriptCore, kept current with the evidence above:

> **Title:** A worker blocked in `memory.atomic.wait32`/`Atomics.wait` keeps
> heap access, so a collection started in its VM never finishes and pins
> the process-wide GC helper threads
>
> **Summary:** `WaiterListManager::waitSyncImpl` blocks inside a
> `VMBlockingScope`, which does not release heap access. If a concurrent
> collection has begun in that worker's VM, `Heap::stopTheMutator()` hands
> the conn to the blocked mutator and returns. The collection advances only
> when that mutator polls (`stopIfNecessary` from an allocation slow path,
> or the `StopIfNecessaryTimer`), which a worker blocked in a synchronous
> wait never does. Every `Heap Helper Thread` that joined the collection
> stays in `SlotVisitor::drainFromShared(HelperDrain)` until
> `m_parallelMarkersShouldExit`, set only in the End phase. Helpers choose
> tasks at random (`ParallelHelperPool::getClientWithTask`), so a few
> blocked workers pin all helpers.
>
> **Steps:** serve the attached `repro/` cross-origin isolated
> (`Cross-Origin-Opener-Policy: same-origin`,
> `Cross-Origin-Embedder-Policy: require-corp`) and open
> `repro.html?mode=B&children=24`. After the 24 workers block, sample the
> WebContent process (`sample <pid> 2`). Compare `mode=C`.
>
> **Results (Playwright WebKit webkit-2359, 26.6, macOS 27.0.1):** mode B
> 6 of 6 helpers in `drainFromShared`, 7 to 11 unfinished collections; mode
> D 6 of 6 and 9; mode C 0 of 6 and 0. In a real application the same
> state led to a permanent hang (stacks as listed under Evidence);
> `JSC_numberOfGCMarkers=1` avoided it.
>
> **Expected:** a thread blocked in `Atomics.wait`/`memory.atomic.wait32`
> should not be able to prevent collections in its own VM, or in other
> VMs, from completing. Possible fixes: release heap access while blocked
> in `waitSyncImpl`; do not hand the conn to a mutator inside a blocking
> scope; or let `drainFromShared(HelperDrain)` return when its heap has
> handed the conn away.
>
> **Workaround used by the application:** bounded waits, and after each
> timeout a call into JavaScript that allocates a small `ArrayBuffer`.

## Removal criteria

Remove the bounded wait and the safepoint import when JSC releases heap
access while a thread is blocked in a synchronous atomic wait, or stops
handing a collection to such a thread, in the latest released Safari and in
the Bun the dev shell pins. Check with the WordPress + MariaDB 20-command
run on WebKit with `kernel_heap_safepoint` answering a negative bound (the
V8 behavior): it must finish every run. Removing the import is an
incompatible ABI change (bump `ABI_VERSION`, regenerate
`abi/snapshot.json`, rebuild musl, programs and images). If the entry turns
out to be a Kandelo defect instead, retire it with that finding.
