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

## Persistent browser realms must not own guest address spaces

Browser main and the page-wide AudioContext outlive individual machines.
Never send them a kernel/process `WebAssembly.Memory`, its shared backing,
or a view into it. A tiny subarray retains the entire backing reservation;
nulling a field, disconnecting a node, and low RSS do not prove reclamation.
Use independent bounded device buffers and copied diagnostic values. Device
relays must preserve the real audio clock, queue capacity, and backpressure.
Only disposable workers may retain guest memory. Normal teardown awaits each
exact retirement fence before terminating its realm. If a fence never
arrives, keep forced termination/containment visible; do not report proven
reclamation or reuse the address space on that basis.

The guest web preview bridge is the same kind of boundary, one origin
further out. Its bytes cross into the preview origin's service worker, which
guest pages share: hand it exact, unshared copies of response bodies, never
a view of kernel or guest memory, and keep the machine's cookie jar and
response shaping in the owning tab (`apps/browser-demos/lib/preview/`). The
host's `fetchInKernel` is unchanged and remains the only path into the
machine's server on both hosts.

Every asynchronous resource needs an explicit end: retire engine futex waits
before dropping their bookkeeping, release AudioWorklet views/ports and stop
its processor, and cancel device timers. Exit must escape guest exception
handlers; a JavaScript-thrown RuntimeError is catchable by Wasm handlers.
Preserve Rust's exit status and avoid guest deallocators on retired channels.

For ownership, memory-ceiling, audio, framebuffer, graphics-lifecycle, or
machine-teardown changes, run `./run.sh test browser-memory`. See the
[validation contract](validation.md#browser-memory-regression-gate) for its
scope and native Safari follow-up. A clean merge with another graphics branch
does not replace rerunning this gate on the combined tree and its artifacts.

Keep a command's job ID until its owner confirms release or absence. A caller
timeout or failed read does not prove that the process family has exited or
that its workers have detached. If release is refused, retain the ID for
later cleanup rather than losing a bounded job slot. Test a failed call while
the job is live, then its eventual release after completion. See
[the command ownership reflection](../architecture-reflections.md#run-agent-commands-with-ordinary-guest-authority).

`exec` keeps a process ID while replacing its worker and memory. Recheck the
exact old memory registration before committing an asynchronously prepared
replacement, and check that its exec syscall channel is still pending. A
teardown wake can complete the channel before removing the registration.
Cancel stale work before changing Rust state. After replacement,
retire the old image through the same generation ledger as exit, termination,
and destroy, including failure cleanup. Direct lease release is for allocations
that were never published, not an old image another teardown may also own.

Result-bearing kernel operations must refuse a busy gate before retaining
their callback, token, or output buffer. Queueing and then reporting refusal
lets a retry repeat work that the caller believes never ran. An asynchronous
exec continuation retries only this pre-entry contention on a later worker
turn. Keep successful commit and replacement start on the same stack, and
never retry after the consumed-token marker. Test both refused operations
after the queue drains and the order of commit, start, and queued microtasks.

Apply that retry rule to every immediate-result step of a root launch too:
process creation, working-directory setup, and terminal setup. A preceding
`await` lets another launch queue work even if the previous step succeeded.
Keep ordinary errors, such as a missing working directory, visible. Test
concurrent launches with a requested working directory on both hosts.

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

## Temporary memory and authority

A scratch lease permits one synchronous operation to use temporary kernel
memory. Every access must still prove its owner, allocation capacity, live
memory range and lease validity, including after memory growth. Do not retain
a lease or its memory views across an `await`; copy data that must survive a
blocking retry into host-owned storage.

When a lease ends, revoke its authority and remove its private pointer-token
and invalidator registrations. A weak map allows eventual collection; it
does not guarantee prompt cleanup of an expired registration. Reduce
temporary bookkeeping without removing the checks that prevent stale or
out-of-range access. Measure both hosts before claiming a benefit.
See [the ownership reflection](../architecture-reflections.md#end-temporary-authority-explicitly).

When moving a filesystem operation between the host and kernel, inventory
the observable behavior before changing its owner: path and symlink
resolution, permissions, lazy archive formats, integrity checks, retries,
cancellation and inspection. Verify each supported behavior on Node and
browser, and document any missing capability. Directory listing, metadata
and file-content reads are separate operations; testing one proves only
that operation. See [the migration reflection](../architecture-reflections.md#move-ownership-with-its-observable-contract).

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
`crates/wasm-artifact`. `docs/abi-versioning.md` ("ABI 51") lists the exports.

Worker protocols are contracts. Spawn, fork, exec, clone, exit, terminate,
thread exit, crash, syscall trace, PTY, framebuffer, audio, network, VFS, and
service-worker messages must have symmetric request, response, error, and
cleanup behavior. A missing message handler is a platform bug.

Credential prompts are part of process launch. Every path that commits an
image (root spawn, guest `posix_spawn`, exec) calls
`CredentialLaunchPolicy.imageCommitted` after the commit and before the
process worker starts, in both entries; a new launch path must too. Call
it after the process is registered in `processes` and outside the rootfs
snapshot gate, so a held process can be signalled (owned-job cancellation
included) and no export, VFS mutation or other launch waits on the user. A
`launch = "wait"` program's first instruction waits on the main thread's
`credential_answer`, so exit and teardown must withdraw or deny the open
question rather than leave the launch waiting. The kernel's
`Process::credential_grant` is the authority; the host's token cache counts
only while the kernel reports the same grant id. See
[credential grants](../architecture.md#credential-grants).

A guest request's credentials belong to the process whose system call
wrote its bytes and the grant it held then, never the one that opened
the connection or a grant the pid gets later. A network backend that can
carry a credentialed request must capture the serving pid (`currentPid`)
and the host-side grant id (`peekCredentialGrantId`, no kernel entry)
when `send` hands it bytes, treat bytes from more than one writer as
ungranted, and ask `credentialGrantFor(pid, grantId, origin)` only when
it dispatches, outside any kernel entry
(`host/src/networking/request-attribution.ts`). Refuse ungranted,
cleartext, and proxyless credentials visibly; never strip them and send
the request.

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

## Schedule notifications outside lifecycle transaction starts

Use a fresh, explicit kernel entry to drain native notifications. Copy bytes
while its scratch lease is live, then deliver observers after revocation.
Register the scheduling effect before the initiating operation: a process
lifecycle transaction must remain the final detached effect of that call.
Register that effect before the operation, but use the kernel's non-consuming
readiness check after the operation to decide whether to schedule it. Checking
only before the operation can miss its final write when no later syscall runs.
An idle watch must not open a second kernel entry and scratch lease for every
unrelated operation. The readiness read stays in the current entry and does
not copy records or invoke observers.

Read readiness in an operation helper that receives the live entry
explicitly. Keep the function that constructs the entry free of kernel
export calls. Its job is to create authority, not to use it. The source
audit must check the operation callback and accept forwarding only from
the canonical gate's exact scope, effect registrar, and operation argument.
Keep notification callbacks and their captured state on the active-watch
path; unrelated operations need neither.

Schedule the drain on the next worker turn. Queuing it immediately can make
the filesystem read needed for exec fail because the gate is busy. Clear the
pending-drain flag before observers run so an observer can schedule a new
write. Test both guest exec and writes made from an observer callback.

Treat an open file description's stored path as its opening name, not proof
of its current name. The inode can survive rename, replacement, and unlink.
Validate the native inode before publishing a precise close hint; refresh
watched directories if a still-linked inode's current name is unknown.
An already-unlinked inode has no directory contents to refresh. Keep this
metadata work behind the subscription gate. Test a rename while the file
stays open, a move from outside a watched directory, replacement of the
opening name, and final close after unlink using real completion barriers.
