# Host Runtime Contract

The host runtime is part of the platform, not demo scaffolding. It owns worker
lifecycle, Wasm instantiation, process memory, syscall channel dispatch,
blocking retry, VFS/network/device adapters, process-worker launch, and the
Node/browser bridge to platform APIs. Changes here can change POSIX behavior
even when kernel Rust code is untouched.

The kernel must run in a dedicated worker on every host. `CentralizedKernelWorker`
must not be instantiated on the main thread. The main thread is a proxy for
setup, UI, and I/O routing; it is not the syscall engine.

A declared memory ceiling is a spent resource, not a free upper bound. On
WebKit/JavaScriptCore — Safari on every device, and Bun — a shared
`WebAssembly.Memory`'s `maximum` and a growable `SharedArrayBuffer`'s
`maxByteLength` are charged against one process-wide reservation pool the
moment the object is constructed, whether or not a single page is ever
touched. When the pool is exhausted the constructor throws `Out of memory`
with resident memory still low, and there is no recovery except declaring
smaller ceilings. V8 and SpiderMonkey reserve address space lazily, so a
ceiling that is invisible on Chrome, Firefox, and Node can still make Safari
fail. Before adding or raising any ceiling, ask what it costs on the engine
that charges it, and check whether the ceiling can even be reached: a
SharedFS-backed filesystem cannot grow past the capacity recorded in its own
superblock, so reserving beyond that recorded capacity buys nothing anywhere
and costs real budget on WebKit. Host budgets live in
`host/src/runtime-memory-profile.ts`; when a budget forces a smaller address
space than a caller asked for, report the reduction rather than applying it
silently.

That budget is also visible to the guest, and must stay that way. A process
address space is a bounded Wasm linear memory, so `getrlimit(RLIMIT_AS)`
reports the real per-process ceiling rather than `RLIM_INFINITY` — it is the
only way a program can discover a bound that differs by device (1 GiB under
the desktop profile, 256 MiB under the constrained one). Software that sizes
one large allocation from a compile-time default is the case that breaks:
TyrQuake's 256 MiB default heap is the entire address space under the
constrained budget, so the Quake demo died at startup on iOS alone. Port such
programs to ask, rather than raising a global budget to fit one of them.

Node.js and browser hosts are peers. A host-runtime behavior change is
incomplete until both hosts have the same platform-observable behavior or the
difference is explicitly justified by a real platform boundary. Do not land
Node-first or browser-later host changes.

Before and after host work, ask: "What does this look like on the other host?"

| Concern | Node.js | Browser |
|---|---|---|
| Host proxy | `host/src/node-kernel-host.ts` | `host/src/browser-kernel-host.ts` |
| Kernel-worker entry | `host/src/node-kernel-worker-entry.ts` | `host/src/browser-kernel-worker-entry.ts` |
| Worker adapter | `host/src/worker-adapter.ts` | `host/src/worker-adapter-browser.ts` |
| Process-worker runtime | shared `host/src/worker-main.ts` | shared `host/src/worker-main.ts` |
| Kernel worker | shared `host/src/kernel-worker.ts` | shared `host/src/kernel-worker.ts` |

Worker protocols are contracts. Spawn, fork, exec, clone, exit, terminate,
thread exit, crash, syscall trace, PTY, framebuffer, audio, network, VFS, and
service-worker messages must have symmetric request, response, error, and
cleanup behavior. A missing message handler is a platform bug.

Stdio descriptor type is chosen when the process is created. Hosts that launch
without a PTY must create fds 0, 1, and 2 as pipe-backed descriptors so
`isatty()` and terminal ioctls observe non-terminal semantics; hosts that
allocate a PTY must create terminal descriptors and then attach the PTY before
user code runs. Do not create terminal-like stdio and repair it later.

Failure must surface. Wasm traps, worker crashes, failed exec/spawn, missing
binaries, ABI mismatches, service-worker failures, blocked retries, and process
exits must become observable errors, exit statuses, or logs through the normal
host APIs. Silent hangs are contract failures.

Browser restrictions are real platform boundaries, not excuses for different
semantics where parity is possible. Browser-specific code may handle
cross-origin isolation, service workers, OPFS, fetch bridges, canvas, audio,
pointer lock, and unavailable raw sockets, but POSIX-visible behavior should
match Node unless documented otherwise.

Shared files are cross-host changes by default. Changes to
`host/src/kernel-worker.ts`, `host/src/worker-main.ts`, VFS behavior,
networking, framebuffer, generated ABI constants, or worker protocol types need
Node and browser consideration even when only one host-specific file changed.

`BrowserKernel` is host/runtime code. Browser demos consume it; they do not own
it. Fix runtime bugs in `host/src`, not inside demo pages, unless the bug is
truly presentation-specific.
