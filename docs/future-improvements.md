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
