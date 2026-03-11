# Future Improvements

Technical debt and improvement opportunities identified during code review. None are bugs — all are deferred enhancements.

## Kernel

### `sys_openat` duplicates `sys_open` logic
`sys_openat` reimplements umask application, file type determination, creation flag stripping, and O_CLOEXEC handling rather than sharing code with `sys_open`. If `sys_open` changes, `sys_openat` must be updated independently. Consider extracting a shared internal helper or implementing `sys_open` as `sys_openat(proc, host, AT_FDCWD, path, oflags, mode)`.

**Files:** `crates/kernel/src/syscalls.rs` — `sys_open`, `sys_openat`

### Fork deserialization lacks bounds checks on variable-length fields
`deserialize_fork_state` and `deserialize_exec_state` read length-prefixed fields (env vars, cwd, OFD paths) without capping the length. A malformed buffer could request a multi-GB allocation via `to_vec()`, causing OOM abort in `no_std`. Consider adding `if len > MAX_LEN { return Err(Errno::EINVAL); }` guards. This is a pre-existing pattern across all variable-length fields, not specific to the `path` field added in the *at() work.

**Files:** `crates/kernel/src/fork.rs` — `deserialize_fork_state`, `deserialize_exec_state`

### `deliver_pending_signals` silently discards handler call errors
When `host_call_signal_handler` fails (invalid function table index, handler throws), the error is discarded via `let _ =` and the signal is consumed (already dequeued). The signal is effectively lost. Consider falling back to the default action on handler failure, or re-raising the signal.

**Files:** `crates/kernel/src/wasm_api.rs` — `deliver_pending_signals`

## Browser Host Gaps

### OPFS filesystem backend
Browser persistence across page loads requires an Origin Private File System (OPFS) backend implementing `FileSystemBackend`. WordPress needs this for wp-content, uploads, and database files. The `FileSystemBackend` interface is already well-defined — needs an async-to-sync bridge via SharedArrayBuffer + Atomics.

### Guest-initiated fork/exec
Currently fork/exec can only be triggered from the host (JavaScript) side via `ProcessManager`. Wasm user-space code calling `fork()` or `exec()` gets ENOSYS. Supporting this requires the kernel to signal the host via a new host import, then block waiting for the host to create the child worker.

**Files:** `crates/kernel/src/wasm_api.rs`, `host/src/process-manager.ts`
