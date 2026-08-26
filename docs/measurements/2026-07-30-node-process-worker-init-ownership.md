# Node process-worker initialization ownership — 2026-07-30

## Conclusion

Kandelo's built-in Node process workers receive their initialization object as
their first ordinary message. They do not receive it through Node's
`workerData` option.

This distinction matters because the initialization object contains a
`Shared WebAssembly.Memory`. Node's startup path structured-clones the object
and exposes the clone through the worker module's `workerData` value. Kandelo's
entry imported that module-level value and had no lifecycle step that could
shorten its lifetime.
Under the stock package-install lifecycle, process RSS stayed high after rapid
fork and exec churn even after Kandelo had:

- terminated and awaited the owning process Worker;
- removed the process from the live process map;
- released the exact process-memory lease; and
- observed finalization of the kernel Worker's JavaScript memory wrapper.

A one-shot message preserves the same structured-clone behavior needed to
start the Worker, but does not put process memory in the `workerData` startup
path. The listener is registered with `once` and is removed before guest
execution starts.

The default Worker receives a small, versioned transport marker through
`workerData`. The marker contains no process or guest references. It
distinguishes “wait for the first message” from a malformed direct launch
with no initialization, which must fail instead of waiting forever.

Explicit custom `NodeWorkerAdapter(entryUrl)` consumers continue to use
`workerData`. Their arbitrary entry modules own that existing contract. The
public `wasm-posix-host/worker-entry` entry point accepts both its existing
`workerData` contract and the new one-shot message contract. Only Kandelo's
default adapter selects the message transport.

## Workload

The real workload was a public, first-party package-install shipping proof.
It booted the exact mostly-lazy main shell, resolved the exact public core
package index, checked its revision and trust state, removed the directly
composed Bzip2 receipt, installed Bzip2 through the stock package manager,
executed it, and rechecked the index and trust contracts.

The matched local measurements used:

- a MacBook Pro with an Apple M5 Max and 48 GB of memory;
- macOS 26.6 (`Darwin 25.6.0`);
- Node.js `v24.15.0` from Kandelo's declared development shell;
- the product default process-worker configuration;
- core package-index revision
  `6ad0e3dbc60e5572c4288c86919238f71c1bc110`;
- canary revision
  `d8bdda662f6d80cf3dcdbe8451edb12bb33bbafc`; and
- the immutable public lifecycle inputs admitted by package-index run
  `30560172393`.

The baseline and candidates all completed the same first-party lifecycle
unless a row explicitly says that a diagnostic run was stopped early.
These are single matched local runs. They support the ownership decision but
do not prove that the hosted Linux job will remain below its memory limit. The
exact hosted-Linux lifecycle remains the final application-level check.

## Results

RSS means resident set size: the physical memory that the operating system
reported as resident for the Node process. It includes engine and shared
memory accounting and is not a direct count of live Kandelo process bytes.

| Candidate | Result | Elapsed | Maximum RSS |
|---|---|---:|---:|
| Existing 4 MiB pressure hook | passed | 270.60 s | 14,665,089,024 bytes |
| 32 MiB pressure hook | passed | 289.98 s | 14,833,664,000 bytes |
| One-shot init message, instrumented | passed | not timed | 13,260,095,488 bytes observed |
| One-shot init message, clean | passed | 277.03 s | 12,883,050,496 bytes |

The 32 MiB result rules out a larger ordinary allocation nudge as the
correction for this workload. It was slightly slower and its peak was not
lower than the existing 4 MiB policy.

The clean one-shot run reduced maximum RSS by 1,782,038,528 bytes, or 12.2%,
relative to the matched baseline. Its elapsed time was 6.43 seconds longer;
that single-run difference is not sufficient evidence of a performance
regression or improvement.

The instrumented runs also recorded matched retirement checkpoints:

| Retirement notices | Listener cleanup only | One-shot init message |
|---:|---:|---:|
| 192 | 12,829,720,576 bytes | 10,050,895,872 bytes |
| 220 | 13,220,528,128 bytes | 11,380,572,160 bytes |
| 500 | 12,209,881,088 bytes | 10,671,489,024 bytes |

At notice 500 in the listener-cleanup run, RSS remained
12,209,881,088 bytes while the exact allocator reported only about 120 MiB
of live plus pending-retirement process memory. It had observed finalization
for 499 of 500 retired kernel-side wrappers. Removing Worker event listeners
or clearing the JavaScript handle did not materially change that shape.

Those observations distinguish the problem from:

- a live process storm;
- duplicate process-event accounting;
- a retained kernel-side JavaScript wrapper; or
- an undersized ordinary allocation-pressure hint.

They are consistent with the process-worker `workerData` startup route
contributing to retention after Kandelo's own wrapper became collectible. The
experiment does not identify which internal Node or engine object retains the
shared backing.

## Rejected explicit-collection workaround

A persistent in-worker `node:inspector` session could request
`HeapProfiler.collectGarbage` without opening an inspector endpoint. It
worked in a same-isolate shared-memory micro-test. In the real lifecycle,
requests and callbacks also completed promptly, but each collection removed
only a small part of RSS. One stopped diagnostic run reached
15,333,228,544 bytes before the next engine-timed descent.

`node:v8.queryObjects` was also rejected. The pinned Node `v24.15.0` binary
emitted an `ExperimentalWarning` for that API, and collecting the kernel
isolate cannot force collection of data still reachable through a different
process Worker's startup state.

The production change therefore fixes initialization ownership instead of
adding a GC API, a larger allocation nudge, a preloaded package index, or a
package-manager-specific process limit.

## Validation boundary

The deterministic tests protect both sides of the contract:

- built-in process initialization keeps `Shared WebAssembly.Memory` out of
  the `workerData` startup path, while explicit custom entries retain their
  old contract; and
- the public built-in entry accepts both direct `workerData` startup and
  one-shot message startup, removing the message listener after delivery.

The real package-install lifecycle is the application-level resource proof.
Absolute RSS remains engine- and host-dependent, so these values are evidence
for the ownership decision, not a portable memory ceiling.
