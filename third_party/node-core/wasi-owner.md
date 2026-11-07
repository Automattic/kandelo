# Public WASI source slice and remaining prerequisites

The exact pinned `lib/wasi.js` supplies public constructor validation,
args/env/preopens coercion, version selection, binding finalization,
start/initialize ordering, returnOnExit sentinel and import-object identity.
The lazy builtin registration evaluates that module and emits its warning
when first loaded. The production dependency is a native guest WASI owner,
not the embedding Node host's `node:wasi` or outer `WasiShim`.

`wasi-context.h` owns copied UTF8 arguments/environment, logical WASI descriptor
rows and actual guest POSIX resources. Configured stdio descriptors remain
borrowed, without duplication. Explicit fd_close closes their actual numeric
fd and removes its row. Preopens are admitted through realpath/open/fstat,
retain their original mapped name and normalized mapping, and close their
captured owned fd on failed admission or owner destruction. This cleanup
policy is explicit: the pinned uvwasi table destructor frees rows without
closing their fd; no native GC-equivalence or runtime-defect claim is made.

The exact uvwasi types/serialization source is unchanged under a third-party
boundary. The rights algorithm/constants and path-normalization body are
selected from the exact source, with explicit POSIX names replacing the
libuv admission boundary. Rights represent full actual admitted descriptor
capabilities, independently of which imports have been implemented. Missing
imports are absent and modules requiring them fail to link. No dummy callbacks
or synthetic successful syscalls are installed.

The native binding traces a real memory edge in the actual owner's realm,
checks unwrapping/security before access, and synchronously borrows a rooted
actual WasmMemoryObject backing under a no-GC scope. Each operation refreshes
volatileMemoryLength; an old shared buffer wrapper's byteLength is insufficient
after grow. Shared scalar serialization uses actual atomic byte accesses and
preserves native padding. I/O vectors address the original current memory;
only the native iovec descriptors are translated. The current owner has no
asynchronous retained raw-memory pointer.

The native allocation ledger counts actual vector capacities, allocated row
sizes and out-of-object string capacities, plus the heap-allocated Context.
It does not call logical result lengths allocation capacity, claim allocator
RSS/overhead, retain JS metadata as fake memory, or charge a shared Wasm memory
allocation a second time.

Implemented source imports (25): args_get, args_sizes_get, clock_res_get,
clock_time_get, environ_get, environ_sizes_get, fd_close, fd_datasync,
fd_fdstat_get, fd_fdstat_set_flags, fd_fdstat_set_rights, fd_filestat_get,
fd_filestat_set_size, fd_pread, fd_prestat_get, fd_prestat_dir_name, fd_pwrite,
fd_read, fd_seek, fd_sync, fd_tell, fd_write, proc_exit, random_get, sched_yield.

Remaining imports (21): fd_advise, fd_allocate, fd_filestat_set_times,
fd_readdir, fd_renumber, path_create_directory, path_filestat_get,
path_filestat_set_times, path_link, path_open, path_readlink,
path_remove_directory, path_rename, path_symlink, path_unlink_file,
poll_oneoff, proc_raise, sock_accept, sock_recv, sock_send, sock_shutdown.
Path operations need the exact preopen/path-resolution/rights and resource
transaction owners; poll/socket imports need genuine guest polling/socket
ownership. Those are implementation gaps, not inherent platform boundaries.

**Current guest engine prerequisite:** the recipe disables JIT on wasm32,
selecting JS_CODEGEN_NONE. HasJitBackend/wasm::HasPlatformSupport return false,
and the global suppresses the WebAssembly namespace. Enabling wasm32 codegen
alone is insufficient: both Wasm compiler support predicates exclude wasm32,
and its code-generator methods include explicit MOZ_CRASH bodies. The
portable baseline interpreter executes JavaScript ICs, not WebAssembly. A real
nested-Wasm execution/memory/instance owner is required; do not flip feature
gates or silently delegate guest execution to the outer embedding host.

**Numeric native-import prerequisite:** exact Node direct-JS uint32 arguments
require semantic unsigned Numbers, but an actual direct Wasm i32 import passes
its unsigned bit pattern through V8's native fast-call ABI. Direct JS -1 gives
EINVAL28; actual Wasm i32 -1 gives EOVERFLOW61. The native JS slow contract is
preserved here. Correct direct-Wasm dispatch needs a genuine engine scope tied
to the actual native callee/signature/context. Caller text, Error.stack,
spoofable JS flags and globally accepting negative JS Numbers are incorrect.
The strict component assertion still fails28 versus61 and remains a nonpass.

No four-host or guest runtime conformance follows from source implementation.
The native JSAPI fragment is uncompiled in this slice. Focused controls use
exact native Node26.13.0 on Darwin arm64 and a test-only N-API bridge to the
actual portable POSIX Context. The bridge's real V8 memory/instance execution
is host component evidence only. It does not test SpiderMonkey brands, realms,
GC barriers, guest syscalls, guest memory limits, permissions, guest exit
containment or a working guest WebAssembly backend. Worker context retirement,
permission-model integration, canceled blocking operations and platform-specific
error/durability behavior need later identified-artifact guest validation.

Run `tests/wasi-owner/run-controls.sh` inside the declared dev shell with exact
NODE26_REFERENCE and a fresh WASI_OWNER_CONTROL_DIR. It performs no product
setup and ends with a strict nonzero direct-Wasm conversion assertion while
that engine prerequisite remains unresolved. Imported upstream assertions are
not changed; these are focused differential controls, not overall suites.
