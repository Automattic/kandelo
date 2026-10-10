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
that charges it, and check whether the ceiling can even be reached. The
machine's filesystem lives in the kernel's linear memory (the in-kernel rootfs
and tmpfs; see `docs/architecture.md`, "Filesystem"), so the kernel's ceiling
is also the ceiling on everything guests write and every lazy file they pull
in (1 GiB under the desktop profile, 768 MiB under the constrained one). A
write past it fails with `ENOSPC` rather than aborting the kernel. Host
budgets live in
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
| Kernel-worker lifecycle helpers | shared `host/src/process-lifecycle.ts` | shared `host/src/process-lifecycle.ts` |
| Protocol types both entries declare | shared `host/src/kernel-protocol-shared.ts` | shared `host/src/kernel-protocol-shared.ts` |

Logic and message types that are the same on both hosts live once, in
`process-lifecycle.ts` and `kernel-protocol-shared.ts`. The lifecycle module is
parameterised by an explicit `ProcessLifecycleHost` record, so each genuine
platform difference is named there — most importantly
`terminationProvesQuiescence`, which is `true` on Node (an awaited
`worker.terminate()` joins the thread) and `false` in the browser (where
`Worker.terminate()` reports nothing). Nothing reads that field yet: the code
that should branch on it (thread-slot reclaim, exec-rollback lease release,
the browser's memory-retirement bookkeeping) is still duplicated in the two
entries. Move a function into the shared module
only when it is equivalent on both hosts; declare a real difference in the
host record rather than forking the function again.

## The host filesystem contract is handle-only

**A host resolves at most one path component, relative to a directory handle
it previously issued. It never receives a guest path, a mount prefix, a `..`,
or a symlink chain.**

The kernel owns the POSIX namespace. It serves `/` and the scratch mounts
itself (`crates/runtime-core/src/rootfs.rs`, `tmpfs.rs`), and the host is only
consulted for a host-backed mount beneath `/` (a Node `extraMounts` directory,
a session-seed tree). For those, `resolve_namespace_path_from`
(`crates/runtime-core/src/syscalls.rs`) resolves the guest path against the
kernel's own metadata, and `crates/runtime-core/src/hostdir.rs` steps a host
directory handle along the canonical result with
`host_openat(dir, component, O_DIRECTORY|O_NOFOLLOW)`, presenting the final
operation a single component.

What this means when you touch host code:

- **Do not add a path-taking host import.** Anything shaped like "resolve the
  rest of this path for me" is the defect this contract removed.
- **A directory is an ordinary handle.** `host_openat(..., O_DIRECTORY)` issues
  it, `host_readdir` iterates it, `host_close` releases it; there is no
  `closedir`. A host must issue distinct handles for distinct directories (the
  kernel's walk holds several at once), keep directory ids disjoint from file
  ids (one `close` serves both), and answer `fstat`, `fstatfs`, `fpathconf`,
  `fchmod`, `fchown`, and `fsync` on a directory handle as well as a file one.
- **The whole family is optional.** It is reachable only under a mount whose
  root handle the host published through
  `kernel_rootfs_set_foreign_mount_roots`. A host with no host-backed mount
  implements none of it, which is the browser today.
- **The final component is still a name.** `mkdir`, `unlink`, `rename`, `link`
  and `symlink` name an entry that does not exist yet or is about to stop
  existing; `lstat`, `lchown` and an `AT_SYMLINK_NOFOLLOW` `utimensat` name an
  entry the host must not open, because opening a symlink follows it.
- **`PlatformIO`'s remaining path methods are host-internal.** They implement
  the `*at` methods; the kernel calls none of them.

The host's other filesystem duty is to be a byte pipe for the kernel-owned
`/`: `host_image_read` serves positioned reads of the boot image the worker
holds, and `host_fetch_deferred(uri, ...)` fetches bytes the image only names
(lazy files and lazy archives), answering `EAGAIN` while a fetch is in flight.
The host never decodes the image into a filesystem of its own.
`docs/abi-versioning.md` ("ABI 49") lists the import set.

The kernel decides what an exec or `posix_spawn` runs; the host instantiates
it. `kernel_spawn_process` reads the spawn request from the caller's memory
and refuses a target a launch could not run before any file action;
`kernel_exec_target_admit` says whether a retained target is a `#!` script or
a program runnable under this ABI; `kernel_exec_commit` sets the new image's
pointer width. Do not add host code that parses a spawn request or an exec
target to make one of those decisions. The one remaining host check is the
fork-instrumentation contract in `describeWasmArtifactPolicyFailures`, which
stays in TypeScript until the fork work brings its decoders into
`crates/wasm-artifact`. `docs/abi-versioning.md` ("ABI 50") lists the exports.

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
