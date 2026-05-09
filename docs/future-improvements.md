# Future Improvements

Technical debt and improvement opportunities. None are bugs — all are deferred enhancements.

## Kernel

### `sys_openat` duplicates `sys_open` logic
`sys_openat` reimplements umask application, file type determination, creation flag stripping, and O_CLOEXEC handling rather than sharing code with `sys_open`. Consider extracting a shared internal helper or implementing `sys_open` as `sys_openat(proc, host, AT_FDCWD, path, oflags, mode)`.

**Files:** `crates/kernel/src/syscalls.rs` — `sys_open`, `sys_openat`

### Fork deserialization lacks bounds checks on variable-length fields
`deserialize_fork_state` and `deserialize_exec_state` read length-prefixed fields (env vars, cwd, OFD paths) without capping the length. A malformed buffer could request a multi-GB allocation via `to_vec()`, causing OOM abort in `no_std`. Consider adding `if len > MAX_LEN { return Err(Errno::EINVAL); }` guards.

**Files:** `crates/kernel/src/fork.rs` — `deserialize_fork_state`, `deserialize_exec_state`

### `deliver_pending_signals` silently discards handler call errors
When `host_call_signal_handler` fails (invalid function table index, handler throws), the error is discarded via `let _ =` and the signal is consumed (already dequeued). Consider falling back to the default action on handler failure, or re-raising the signal.

**Files:** `crates/kernel/src/wasm_api.rs` — `deliver_pending_signals`

### Git binary uses full asyncify (~6MB overhead)
`git.wasm` requires full `wasm-opt --asyncify` instrumentation (7MB → 13MB) because git's HTTP transport dispatches through `call_indirect` via a vtable (`transport->vtable->get_refs_list()`). Asyncify's `--asyncify-onlylist` mode, which instruments only listed functions, fails for `call_indirect` paths — the fork import is never reached even though all functions in the chain are listed and correctly instrumented. Direct call paths (e.g., `cmd_commit` → `start_command` → `fork`) work fine with onlylist. Possible approaches: upstream binaryen fix for onlylist + call_indirect, `--asyncify-removelist` to selectively exclude large safe functions, or restructuring the fork mechanism to avoid asyncify entirely.

**Files:** `examples/libs/git/build-git.sh`, `examples/libs/git/asyncify-onlylist.txt`

## Browser

### PTY terminal integration with xterm.js
The kernel has full PTY support (PR #181) but browser demos still use plain `<div>` with `appendStdinData`. Connecting PTY pairs to xterm.js would give proper terminal rendering (ANSI escapes, cursor, scrollback) and real terminal behavior (isatty=true, proper termios).

### Browser bundle missing key exports
`host/src/browser.ts` doesn't export `CentralizedKernelWorker`, `CentralizedKernelCallbacks`, `patchWasmForThread`, or `centralizedThreadWorkerMain`. External consumers can't build their own `BrowserKernel`-like wrapper from the published package.

**Files:** `host/src/browser.ts`

## Performance

### Revisit an optional wasm32 kernel build for IPC-heavy workloads
A May 6, 2026 prototype found that the Rust kernel can likely be built as
`wasm32-unknown-unknown` while keeping user-process pointer width independent
through the host's existing `ptrWidth` handling. The ABI 7 syscall channel
layout remained unchanged (72-byte header, 6 x i64 args, i64 return, i32
errno, 64KiB data buffer), and focused local tests covered wasm32 users,
wasm64 users, pipe IPC, and fork/exec on a wasm32 kernel.

The performance result was not stable enough to justify changing the default.
The first Node benchmark pass showed modest wins in some syscall and process
lifecycle paths, but the rerun was noisy: wasm32 process-lifecycle results
stayed close to the first run, while wasm32 syscall latency and wasm64 process
lifecycle numbers varied widely. Treat `kernel32.wasm` as a possible optional
artifact to investigate, not a replacement for the current wasm64 kernel path.

Any follow-up should:

- keep ABI 7 and wasm64 user-program support intact;
- keep the wasm64 kernel as the default until broader benchmark evidence exists;
- run all benchmark suites on both Node and browser hosts with repeated,
  alternating wasm32/wasm64 runs;
- check whether IPC time is dominated by host-side copying, wakeup scheduling,
  or retry logic rather than kernel pointer width;
- if the approach still looks useful, expose it as a separate `kernel32.wasm`
  build option.

## Kernel — regressions

### Multi-process nginx: injected connections don't reach fork workers
The standalone nginx demo previously worked with `master_process on;
worker_processes 2;` (kernel's listener-sharing-via-fork path delivered
the injected TCP connection to a worker). That path appears to have
regressed: with the same config, nginx accepts the connection
(`sawWriteOpen=true` from the bridge) but never produces a response
and the bridge times out after 60s. The standalone demo has been
switched to single-process for now; LAMP/WordPress/nginx-php were
already single-process and aren't affected.

The bug is likely in either: (a) connection-injection target selection
when the listener fd is shared across pids via `dup`-on-fork, or (b)
nginx's worker not seeing the accepted connection in its event loop
because the wakeup is delivered to the master.

**Files:** `crates/kernel/src/socket.rs` (TCP listener accept queue),
`examples/browser/lib/kernel-worker-entry.ts` (`handleHttpRequest` —
how it picks a target listening pid).

### wasm64 musl: missing `__NR_pselect6_time64` alias forces select() through SYS_select
`musl-overlay/arch/wasm32posix/bits/syscall.h.in:109` defines `__NR_pselect6_time64 = __NR_pselect6`, so musl's `select.c` routes wasm32 through SYS_pselect6 (252). The wasm64 overlay omits that alias; musl falls through to `#ifdef SYS_select` and uses **SYS_select (103)** instead. The host gained a SYS_SELECT timeout-aware handler (kernel-worker.ts `handleSelect`) so this works correctly today, but as defense-in-depth the wasm64 overlay should mirror wasm32 — fewer code paths, single canonical entry point. Doing this requires rebuilding the cached wasm64 binaries (the libc.a baked into them changes), so it's a coordinated rebuild task.

**Files:** `musl-overlay/arch/wasm64posix/bits/syscall.h.in`

### Audit other PR #383 callers that may have missed the `GLOBAL_PIPE_PID` migration
PR #383 (`fix(kernel): share AF_INET accept queue across fork — nginx multi-worker`, May 2026) moved injected-connection pipes to the kernel's GLOBAL pipe table. `kernel_pipe_{read,write,close_*,is_*_open}` now treat `pid == 0` as a sentinel meaning "use the global pipe table". The HTTP bridge in `kernel-worker-entry.ts` and `NodeKernelHost` were updated; `examples/browser/lib/mysql-client.ts` and `examples/browser/lib/redis-client.ts` were missed and have since been fixed. **Audit any other call site that does `kernel.injectConnection(...)` and then `kernel.pipeRead/pipeWrite` with a non-zero pid** — they're broken in the same way (silent EBADF; greeting bytes never reach the browser-side reader). Currently visible: only the two demo clients that have already been fixed, but a future demo that reuses the inject-and-read pattern needs to know about the convention.

**Files:** `examples/browser/lib/*-client.ts`, anything calling `BrowserKernel.injectConnection`. Convention: store `this.pid = 0` (or import `GLOBAL_PIPE_PID = 0`) for all pipe ops on injected pipes.

## Host runtime

### Use a tracked dlopen memory arena instead of one mmap per side module
`host/src/worker-main.ts` currently allocates each dlopen side module's
linear-memory data with a synchronous anonymous `mmap` through the syscall
channel. That is intentionally correct for address-space accounting: the
kernel's mmap allocator records the range, so later guest mmaps cannot overlap
and zero side-module data/GOT by accident.

The cleaner version is a small per-process dlopen arena: reserve one tracked
anonymous mmap region on first `dlopen`, then suballocate side-module data from
that arena with the dylink alignment requirements. This would reduce syscall
traffic, avoid page-sized waste for many tiny side modules, and give `dlclose`
a clearer place to reclaim or recycle side-module data later.

**Files:** `host/src/worker-main.ts` (`buildDlopenImports`),
`host/src/dylink.ts` (`LoadSharedLibraryOptions.allocateMemory`).
### Clarify and encapsulate dlopen side-module memory allocation
`host/src/dylink.ts` exposes the lower-level `DynamicLinker` machinery used
to parse `dylink.0`, lay out side-module data, apply relocations, and resolve
symbols. The real process path is broader: guest C `dlopen()` enters
`glue/dlopen.c`, calls the worker import in `host/src/worker-main.ts`, and
then reaches `DynamicLinker` with a runtime-provided allocator.

That split is useful, but it should be harder for tests and production to
accidentally exercise different contracts. The practical regression test for
runtime dlopen behavior should be an integration test such as
`examples/dlopen/test.test.ts`, because it covers the same path used by real
guest programs. Lower-level `DynamicLinker` tests are still useful for linker
internals, but they should be described and structured as core-linker coverage,
not as evidence that guest `dlopen()` works end to end.

Future cleanup:

- extract the process-worker side-module allocator into a named helper or
  small object, for example `createDlopenDataAllocator(...)`;
- make that helper's contract explicit: allocated side-module data must be
  visible to the guest address-space manager, so later guest `mmap()` calls
  cannot overlap and zero it;
- keep syscall/channel details out of `DynamicLinker`; it should require an
  allocator, while the process worker supplies the runtime-specific tracked
  mmap allocator;
- consider replacing one mmap per side module with a tracked per-process
  dlopen arena that reserves one anonymous mmap and suballocates with dylink
  alignment;
- keep `examples/dlopen/test.test.ts` or an equivalent guest-level test as the
  primary regression test whenever changing dlopen allocation behavior.

**Files:** `host/src/worker-main.ts` (`buildDlopenImports`),
`host/src/dylink.ts` (`DynamicLinker`, `LoadSharedLibraryOptions`),
`examples/dlopen/test.test.ts`, `host/test/dylink.test.ts`.

### Pre-instantiation worker errors bypass the kernel exit path
When a process worker fails before any syscall (e.g. ABI mismatch, link
error, malformed wasm), it posts `{type:"error"}` via `port.postMessage`.
The kernel-worker-entry catches that and synthesizes `{type:"stderr"}` +
`{type:"exit"}` messages directly to the host, which works for the
common case but bypasses the kernel's normal exit path
(`callbacks.onExit` → `kernelWorker.unregisterProcess(pid)` →
hostReaped tracking → child-pid bookkeeping). For these pre-instantiation
failures the kernel only holds `kernel_create_process(pid)` state, so the
leak is minimal — but it's inconsistent with how successful exits flow.

The SAB syscall channel can't carry this signal because the channel
glue isn't linked yet at the failure point (the wasm instance doesn't
exist), so the postMessage path is the right transport. The fix is to
route the message through the kernel's normal exit machinery — call
`kernelWorker.unregisterProcess(pid)` and trigger the `onExit` callback
with a non-zero status — instead of fabricating an exit message at
the protocol layer.

**Files:** `host/src/node-kernel-worker-entry.ts` (handleSpawn's
`worker.on("message")` handler).
