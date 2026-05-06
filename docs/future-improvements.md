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

## Host runtime

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
