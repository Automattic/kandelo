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

## Tooling

### Migrate `host/src` imports to explicit `.ts` suffixes
`host/src` uses extensionless imports (`import './sharedfs-vendor'`). Node's `--experimental-strip-types` (stable in Node 22+) requires explicit `.ts` or `.js` suffixes, so `tools/mkrootfs` runs under `tsx` to avoid the resolver incompatibility. As native Node ESM TS support matures, the repo should migrate to the principled convention:

1. Add `.ts` suffix to every import across `host/src` (mechanical, ~100+ edits).
2. Set `allowImportingTsExtensions: true` in `host/tsconfig.json` — note this is gated on `noEmit` or `emitDeclarationOnly`, so the tsup pipeline needs verification that it still emits both the JS bundles (tsup v8 rewrites `.ts` suffixes on output) and the DTS bundle.
3. Drop the `tsx` shim from `tools/mkrootfs/bin/mkrootfs.mjs` in favor of `node --experimental-strip-types`.

Blast radius is unrelated to any feature work — should land as a standalone cleanup PR.

**Files:** all of `host/src/**/*.ts`, `host/tsconfig.json`, `tools/mkrootfs/bin/mkrootfs.mjs`

### `saveImage` serializes the entire SharedArrayBuffer
`MemoryFileSystem.saveImage()` copies the full SAB (default 16 MiB) into the output image regardless of how much of it is actually used. A populated rootfs with ~50 small files in `/etc` produces a ~16 MB `rootfs.vfs` where the actual content is under 10 KB. The waste doesn't matter today — the image is a build artifact, not shipped — but once browser demos start fetching it over the network, or we ship larger rootfs variants with lazy archives, the bloat becomes visible.

Optimization path: consult `SharedFS`'s block bitmap at save time and emit only occupied blocks + a block map, or run-length-encode the trailing zeros. Either would drop a fresh rootfs image from ~16 MB to under 100 KB. The loader (`fromImage`) would need the corresponding sparse-restore path.

**Files:** `host/src/vfs/memory-fs.ts` — `saveImage`, `fromImage`
