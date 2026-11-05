# JSC-SHARED-MEMORY-GROW-INSTANCE-TEARDOWN

Status: confirmed on Playwright WebKit build webkit-2359 (reported as
26.6) on macOS. Released Safari has not been checked. Not filed.

## Defect

When one thread grows a shared `WebAssembly.Memory` by at least one page
while another thread destroys a `WebAssembly.Instance` that imports the
same memory, the web content process crashes: `EXC_BAD_ACCESS` (SIGSEGV)
at address `0x10`. The faulting thread is in

```
JSC::JSWebAssemblyInstance::updateMatchingCachedMemoriesConcurrently(SharedArrayBufferContents const&) +72
JSC::SharedArrayBufferContents::tryGrow(...) +812
JSC::Wasm::Memory::growShared(VM&, PageCount) +688
```

entered from JavaScript `WebAssembly.Memory.prototype.grow`
(`webAssemblyMemoryProtoFuncGrow`) or from the Wasm `memory.grow`
instruction (`operationGrowMemory`). At the same moment another Worker
thread is inside `JSC::JSWebAssemblyInstance::~JSWebAssemblyInstance()`,
reached either through VM teardown (`~VM` → `Heap::lastChanceToFinalize`,
after `terminate()` or the worker's own `close()`) or through an ordinary
garbage-collection sweep in a live worker. A grow visits every instance
importing the memory to update its cached base and size, and it reaches
one that is being destroyed.

Neither the WebAssembly JS API nor the threads proposal allows a script to
crash the engine: growing a shared memory must succeed or throw
`RangeError`, whatever other agents do with their instances.

## Why Kandelo is affected

Each guest pthread runs in its own nested Worker that binds one instance
to the process memory. When the thread exits, the worker posts
`memory_quiescent` and closes itself, and the kernel worker terminates it.
Meanwhile the rest of the process keeps growing that memory: the kernel
worker grows it for thread slots and brk/mmap, and guest code grows it from
Wasm. On WebKit the tab then crashes. `select-signal-browser.spec.ts`,
whose guest creates and exits threads quickly, failed this way on WebKit
with "Target page, context or browser has been closed"; three crash reports
from those runs (2026-10-26) carry the signature above. Any threaded
program in Safari can hit it.

## Workaround and its cost

On JavaScriptCore (detected from the user agent with
`isJavaScriptCoreUserAgent` in `host/src/runtime-memory-profile.ts`, the
same check that selects JSC's process-memory budget):

- Browser process and thread workers keep every instance bound to process
  memory reachable until the worker ends (`host/src/wasm-instance-retention.ts`,
  recorded in `host/src/worker-main.ts` and `host/src/dylink.ts`), so the
  garbage collector never destroys one while the process can still grow.
- An exited thread's worker no longer closes itself
  (`host/src/worker-entry-browser.ts`). The kernel worker reclaims the
  thread's slot and channel at `memory_quiescent` as before, but keeps the
  idle worker and terminates it with its process: at exit, exec, forced
  termination, destroy, or a fatal kernel failure
  (`host/src/browser-kernel-worker-entry.ts`).

Workers are never reused. Chromium, Firefox and the Node.js host keep
terminating thread workers at once.

Cost on WebKit: a process holds one idle worker (its VM and instance) for
every thread it has created, until the process exits or execs. A program
that keeps creating threads uses more memory over its life. dlclose'd side
modules also stay instantiated until their worker ends.

A narrow window remains at process exit: a thread still running can grow
memory while its siblings are being terminated. The faithful reproduction
below did not crash through 30 process exits per run with the workaround's
behavior.

## Evidence

All runs on macOS through `tests/runtime-workarounds/driver.mjs`, one
browser at a time.

`repro.html` (one grower worker; victim workers instantiate instances of
the memory and are terminated while it grows):

| Engine | Result |
|---|---|
| WebKit webkit-2359 (26.6) | crashed 27 / 27 (10 / 10 at 64 pages maximum, 10 / 10 at 1024, 5 / 5 each for Wasm-grow, `close()`, and one victim with one instance), each within about 1-2 s |
| WebKit, `maximum=1` (no grow possible) | 0 / 3 × 30 s, 7,468 teardowns |
| WebKit, `delta=0` (zero-page grows only) | no crash over about 2.1 billion `grow(0)` calls and 52,000 teardowns |
| Chromium 153.0.8010.12 | 0 / 3 × 60 s, 22,280 teardowns, 350,910 grows |
| Firefox 155.0 | 0 / 3 × 60 s, 10,736 teardowns, 169,092 grows |

`repro-faithful.html` mirrors Kandelo's browser topology: the page starts
one kernel worker; the kernel creates each process and pthread as a nested
module worker (never reused), with 16 MiB initial and 1 GiB maximum
memories and 4-page thread slots; threads bind one instance, report
quiescence and are terminated at once; the process grows from Wasm and asks
the kernel to grow from JavaScript; full processes exit and are replaced
with fresh memories.

| Engine and variant | Result |
|---|---|
| WebKit, as Kandelo behaved before this workaround | crashed 15 / 15 (10 with classic workers, 5 with module workers), both JavaScript and Wasm grow entries |
| WebKit, exited threads idle until process exit, instance dropped (`idle=1`) | crashed 5 / 5, the concurrent thread in a GC sweep in `~JSWebAssemblyInstance` |
| WebKit, exited threads idle and keeping their instance (`idle=1&retain=1`), the workaround | 0 / 10 × 60 s (5 classic, 5 module), 33,000-34,000 thread teardowns at process exit and about 38,000 grows per run |
| WebKit, everything grown before threads start (`pregrow=1`) | 0 / 5 × 60 s, 75,587 thread teardowns |
| Chromium 153.0.8010.12 | 0 / 3 × 60 s, 52,866 thread teardowns, about 41,000 grows |
| Firefox 155.0 | 0 / 3 × 60 s, 31,883 thread teardowns, about 41,000 grows |

An earlier version of the faithful page used classic workers, unlike
Kandelo, and crashed Firefox even with no grows. That is a separate Firefox
defect that only classic nested workers reach; see
[`docs/measurements/2026-10-28-firefox-nested-classic-worker-termination.md`](../../../docs/measurements/2026-10-28-firefox-nested-classic-worker-termination.md).

## Why this is not a Kandelo defect

`repro.html` and `repro-faithful.html` contain no Kandelo code: plain
JavaScript and a hand-written Wasm module importing the memory. They crash
WebKit with the signature seen under Kandelo, and Chromium and Firefox run
`repro.html` clean.

## Draft upstream report

Not filed.

Title: Crash in `JSWebAssemblyInstance::updateMatchingCachedMemoriesConcurrently`
when growing a shared WebAssembly.Memory while another worker destroys an
instance of it.

Product: WebKit, component JavaScriptCore.

Steps: serve `repro/` with `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`, open `repro.html`.

Expected: the page runs 60 s and reports `not-reproduced`.

Actual: the web content process crashes within seconds (SIGSEGV at `0x10`,
stack above). Reproduces on Playwright webkit-2359 (26.6), macOS.

## Removal criteria

A released Safari (and the WebKit builds Kandelo supports) that runs
`repro.html` and `repro-faithful.html` without crashing. Then remove
`host/src/wasm-instance-retention.ts` and its two call sites, the
`instancesOutliveThreads` branch in `host/src/worker-entry-browser.ts`, and
`exitedThreadWorkers` in `host/src/browser-kernel-worker-entry.ts`, and
retire this entry.
