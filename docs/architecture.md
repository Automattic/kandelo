# Architecture

This document describes the internal architecture of Kandelo. It is written for both human developers and AI agents working on the codebase.

[Architecture reflections](architecture-reflections.md) explain the design
lessons behind ownership boundaries, host bookkeeping, filesystem migrations
and validation. This document remains the reference for implemented behavior.

## Overview

Kandelo is a shared, multi-process POSIX kernel that runs as WebAssembly. A single kernel Wasm instance manages all processes. The kernel **must** run in a dedicated worker thread (Web Worker in browsers, `worker_thread` in Node.js) — never on the main thread. Each process also runs in its own worker and communicates with the kernel via a SharedArrayBuffer-based channel.

> **Architecture requirement**: All platform hosts MUST run the kernel in a dedicated worker thread. The main thread should only act as a thin proxy for setup, I/O routing, and UI. Running the kernel on the main thread degrades syscall throughput by 3-4x due to event loop overhead from libuv (Node.js) or rendering (browsers).

```
                    ┌──────────────────┐
                    │   Kernel Worker   │
                    │  (single Wasm)    │
                    │                   │
                    │  ProcessTable     │
                    │  ├─ pid 1         │
                    │  │  synthetic init│
                    │  ├─ pid 100       │
                    │  └─ pid N         │
                    │  Task-ID allocator│
                    │                   │
                    │  Fd tables        │
                    │  Advisory locks   │
                    │  Pipe buffers     │
                    │  Signal queues    │
                    │  Socket state     │
                    │  PTY pairs        │
                    └──────┬───────────┘
                           │ Atomics.waitAsync / notify
              ┌────────────┼────────────┐
              │            │            │
     ┌────────┴──┐  ┌─────┴─────┐  ┌──┴────────┐
     │ Worker 100 │  │ Worker 101 │  │ Worker N   │
     │ pid=100    │  │ pid=101    │  │ pid=N      │
     │ User Wasm  │  │ User Wasm  │  │ User Wasm  │
     │ + musl     │  │ + musl     │  │ + musl     │
     │ + glue     │  │ + glue     │  │ + glue     │
     └────────────┘  └───────────┘  └───────────┘
```

## Three Layers

### 1. Kernel (Rust → Wasm)

**Location**: `crates/kernel/`

The kernel is written in Rust, compiled to `wasm32-unknown-unknown` with `no_std` (on wasm32). It exports C-compatible functions that the host calls to handle syscalls.

Key source files:

| File | Purpose |
|------|---------|
| `syscalls.rs` | Syscall dispatch — maps syscall numbers to handler functions |
| `fd.rs` | Per-process file descriptor table (fd → OFD index mapping) |
| `ofd.rs` | Open file descriptions (shared state for dup'd/forked fds) |
| `pipe.rs` | Kernel-space pipe ring buffers with cross-process wakeup |
| `pty.rs` | Pseudoterminal pairs with line discipline (canonical/raw mode) |
| `process.rs` | Process struct, HostIO trait, per-process state |
| `process_table.rs` | ProcessTable — maps PIDs to Process structs and owns the machine-wide PID/TID allocator |
| `signal.rs` | Signal subsystem: masks, handlers, RT queuing, delivery |
| `socket.rs` | AF_INET and AF_UNIX socket implementation |
| `fork.rs` | Fork/exec state serialization and deserialization |
| `memory.rs` | Memory management (mmap regions, brk tracking) |
| `terminal.rs` | Termios state and ioctl handling |
| `lock.rs` | Machine-wide advisory file-lock manager and POSIX range semantics |
| `wasm_api.rs` | Wasm export/import boundary (`#[no_mangle] extern "C"`) |

Key kernel exports (called by the host):

```
kernel_create_process() → assigned_pid | -errno
kernel_create_process_with_stdio(stdin_kind, stdout_kind, stderr_kind) → assigned_pid | -errno
kernel_validate_task(pid, tid) → 0 | -errno
kernel_set_current_tid(pid, tid) → 0 | -errno
kernel_fork_process(parent_pid, caller_tid, mode) → assigned_child_pid | -errno
kernel_spawn_process(parent_pid, caller_tid, path_addr, path_len, blob_addr, blob_len) → assigned_child_pid | -errno
kernel_remove_process(pid) → 0
kernel_handle_channel(channel_offset, channel_capacity, pid, retry_token) → result
kernel_blocking_retry_token(pid, tid, syscall_nr) → opaque_token | -errno
kernel_blocking_retry_release(pid, tid, opaque_token) → 0 | -errno
kernel_exec_target_prepare(pid, caller_tid, dirfd, path_ptr, path_len, flags) → opaque_target | -errno
kernel_spawn_exec_target_prepare(parent_pid, child_pid, path_ptr, path_len) → opaque_target | -errno
kernel_exec_target_size(owner_pid, opaque_target) → byte_length | -errno
kernel_exec_target_read(owner_pid, opaque_target, offset_lo, offset_hi, dst_ptr, dst_capacity) → bytes_read | -errno
kernel_exec_target_admit(owner_pid, opaque_target, expected_abi, out_ptr, out_capacity) → record_bytes | -errno
kernel_exec_target_cancel(owner_pid, opaque_target) → 0 | -errno
kernel_exec_commit(pid, caller_tid, opaque_target) → 0 | -errno
kernel_spawn_exec_commit(parent_pid, child_pid, opaque_target) → 0 | -errno
kernel_publish_spawn_child(parent_pid, child_pid) → disposition | -errno
kernel_thread_exit(pid, tid, ran) → 0 | -errno
kernel_commit_process_exit(status) → committed_low_8_bits
kernel_dequeue_signal(pid, tid, out_ptr, out_capacity) → 0 | signum | -errno
kernel_drain_wait_completions(out_ptr, out_len, max_records) → record_count | -errno
kernel_wait_next_timeout_ns() → relative_ns | -1   (earliest park deadline or armed timerfd expiry)
kernel_pick_tcp_listener_target(port, exclude_pid, out_ptr, out_capacity) → 1 | 0 | -errno
kernel_take_process_timer_cleanup(pid, out_ptr, out_capacity) → posix_count | -errno
kernel_ipc_shmat_for_task(pid, tid, shmid, addr, flags) → segment_size | -errno
kernel_ipc_shm_record_mapping_for_task(pid, tid, addr, shmid, size) → 0 | -errno
kernel_ipc_shm_lookup_mapping_for_task(pid, tid, addr) → packed_size_and_shmid | -errno
kernel_ipc_shmdt_addr_for_task(pid, tid, addr) → 0 | -errno
kernel_ipc_shmat_for_process(pid, shmid, addr, flags) → segment_size | -errno
kernel_ipc_shm_record_mapping_for_process(pid, addr, shmid, size) → 0 | -errno
kernel_ipc_shmdt_addr_for_process(pid, addr) → 0 | -errno
kernel_alloc_scratch(size) → kernel_owned_pointer | 0
kernel_transfer_scratch_begin(minimum_capacity) → reservation_token | -errno
kernel_transfer_scratch_pointer(reservation_token) → kernel_owned_pointer | 0
kernel_transfer_scratch_capacity(reservation_token) → reservation_capacity | 0
kernel_transfer_scratch_cancel(reservation_token) → 0 | -errno
kernel_transfer_io_execute(pid, tid, reservation_token, len, syscall, fd, offset, retry_token) → bytes | -errno
kernel_transfer_channel_execute(pid, tid, reservation_token, retry_token) → 0 | -errno
kernel_get_cwd(pid, buf, capacity) → required_or_written_bytes | -errno
kernel_get_fd_path(pid, fd, buf, capacity) → required_or_written_bytes | -errno
kernel_get_dirfd_path(pid, fd, buf, capacity) → required_or_written_bytes | -errno
kernel_enum_procs(buf, capacity) → complete_snapshot_bytes | -errno
kernel_process_metadata_begin(pid) → transaction_token | -errno
kernel_process_metadata_stage(pid, transaction_token, kind, buf, len) → 0 | -errno
kernel_process_metadata_commit(pid, transaction_token) → 0 | -errno
kernel_process_metadata_cancel(pid, transaction_token) → 0 | -errno
kernel_process_metadata_read(pid, kind, index, buf, capacity) → entry_bytes | -errno
kernel_set_max_addr(pid, addr) → 0
kernel_set_brk_base(pid, addr) → 0
kernel_set_mmap_base(pid, addr) → 0
kernel_set_process_pointer_width(pid, width) → 0 | -errno
kernel_is_fd_nonblock(pid, fd) → 1 | 0 | -1
kernel_epoll_wake_indices(pid, epfd, kind, out_ptr, out_capacity) → count | -errno
kernel_epoll_wait_retry_state(pid, tid, token, deadline_handle) → 1 still blocked | 0 replay | -errno (optional)
kernel_set_wait_queue_enabled(enabled) → previous | -errno
kernel_wait_deadline_open(pid, tid, kind, timeout_ms) → wait_handle | -errno
kernel_wait_deadline_remaining_ns(wait_handle) → nanoseconds | NO_DEADLINE | -errno
kernel_wait_deadline_close(wait_handle) → 1 | 0 | -errno
kernel_wait_retire_process(pid) → dropped_waits
```

The host-facing export list is deliberately small. Ordinary syscalls are not
exported one by one: the guest reaches them through `kernel_handle_channel`,
which dispatches to the Rust handlers as plain function calls. A
`#[unsafe(no_mangle)] pub extern "C"` on a dispatch-only handler would publish
a symbol with no consumer, so those handlers carry no export attribute, and
`abi/snapshot.json` records only the exports something outside the kernel
actually calls. `docs/abi-versioning.md` ("ABI 48") lists what that cut
removed.

Normal guest exit closes descriptors before the process becomes reapable.
When the host instead removes a live process after explicit termination or a
worker failure, `kernel_remove_process` drops its inherited resource references
and closes its last-owned host file, directory-iteration, and network handles.
Failed spawn setup drains the same close lists during rollback. Node.js and
browser hosts use the common removal path, so forced termination does not
retain those backend descriptors after the worker is gone.

Host imports (provided by TypeScript):

```
host_read(fd, buf, len) → bytes_read
host_write(fd, buf, len) → bytes_written
host_openat(dir_handle, name, flags, mode) → handle
host_close(handle) → 0
host_fstatat(dir_handle, name, flags, buf) → 0
host_fstat(handle, buf) → 0
host_image_read(buf, len, offset) → bytes      (the boot image the host holds)
host_fetch_deferred(uri, buf, len, offset, …) → bytes | -errno (a file the image only names)
host_getrandom(buf, len) → bytes
host_connect(addr, port) → handle
host_send(handle, buf, len) → bytes_sent
host_recv(handle, buf, len) → bytes_received
host_net_readiness(handle) → net_readiness fact word
host_proc_read_bytes(pid, guest_addr_u64, dst, len) → 0 | -errno
host_proc_write_bytes(pid, guest_addr_u64, src, len) → 0 | -errno
host_getaddrinfo(host, port, buf, len) → count
```

The filesystem imports are handle-only: each `*at` call resolves one path
component relative to a directory handle the host issued, and the kernel uses
them only for host directories mounted beneath its own `/`
(`crates/runtime-core/src/hostdir.rs`). The listing above is abridged;
`crates/shared/src/lib.rs` and `abi/snapshot.json` hold the full import set.

`host_proc_read_bytes` / `host_proc_write_bytes` take a 64-bit guest address,
so a wasm64 process's pointer above 4 GiB reaches the kernel intact. They are
how the kernel reads the arguments it dereferences itself (see "Opaque syscall
records" below). The kernel imports no host primitive that blocks its own
thread: there is no host sleep, signal-wait, or futex-wait import, because the
single kernel thread multiplexes every process in the machine and a blocking
import would stall all of them.

### 2. Host Runtime (TypeScript)

**Location**: `host/src/`

The host runtime loads and manages the kernel and process workers. It has two main classes:

**`CentralizedKernelWorker`** (`kernel-worker.ts`): The primary runtime. Creates the kernel Wasm instance, manages process registration, listens for syscall channel activity via `Atomics.waitAsync`, and dispatches to the kernel's `kernel_handle_channel` export. **Must be instantiated in a dedicated worker thread**, not on the main thread.

**`WasmPosixKernel`** (`kernel.ts`): Lower-level kernel wrapper that instantiates the Wasm module and provides the host import functions.

Key host components:

| Component | File | Purpose |
|-----------|------|---------|
| CentralizedKernelWorker | `kernel-worker.ts` | Manages kernel instance, process channels, blocking retry |
| SyscallChannel | `channel.ts` | Typed view into SharedArrayBuffer channel region |
| NodePlatformIO | `platform/node.ts` | Node.js handle-only `*at` filesystem calls, networking, clocks, random |
| VirtualPlatformIO | `vfs/vfs.ts` | Host-mount router for directories mounted beneath the kernel's `/` — used by both Node and browser hosts |
| HostFileSystem | `vfs/host-fs.ts` | Backend that proxies to a Node host directory |
| OpfsFileSystem | `vfs/opfs.ts` | Origin Private File System (browser persistence) |
| Image transport | `vfs/vfs-image-transport.ts`, `vfs/rootfs-lazy-archives.ts` | zstd decode of the boot image; host fetch of deferred files the image names |
| NetworkIO backends | `networking/*.ts` | Host-side external TCP/HTTP bridges and local virtual UDP/TCP networking |
| Default mount spec | `vfs/default-mounts.ts` (+ `default-mounts-node.ts`) | Canonical mount layout + per-host resolvers |
| SharedPipeBuffer | `shared-pipe-buffer.ts` | Cross-worker pipe ring buffers via SharedArrayBuffer |
| SharedIpcTable | `shared-ipc-table.ts` | SysV IPC (msg queues, semaphores, shm) |
| NodeWorkerAdapter | `worker-adapter.ts` | Creates Node.js worker_threads |
| BrowserWorkerAdapter | `worker-adapter-browser.ts` | Creates Web Workers |

`NodeWorkerAdapter` prefers the compiled worker entry distributed with the
host package. In a source checkout without `host/dist`, it bundles the
TypeScript entry once per adapter and reuses that temporary module for later
process workers; if bundling is unavailable, it falls back to the `tsx`
loader. Browser worker entries are bundled by the browser build and do not use
this Node-only source fallback.

Kernel module instantiation snapshots the caller's exact intrinsic
`ArrayBuffer`, typed-array, or `DataView` byte window before inspecting it.
Pointer-width detection and `WebAssembly.compile` consume that same detached
snapshot. This prevents an overridden view getter or a later caller mutation
from making the host configure wasm32 imports for a different wasm64 module,
or vice versa.

A `WasmPosixKernel` wrapper owns exactly one instantiated kernel generation.
`init` and `initWithMemory` are mutually exclusive one-shot entry points:
concurrent or post-success calls reject before changing pointer width, memory,
instance, or cached scratch authority. A failed first attempt clears its
partially published state and may be retried. This matters because a
`KernelScratchRegion` is bound to the exact allocator, instance, memory,
pointer, and capacity that created it; replacing the wrapper generation while
retaining an audio or public-API region would make the old allocation appear
valid under unrelated new state.

### Kernel-owned scratch transfers

The host moves syscall payloads through allocations owned by the Rust kernel.
`host/src/kernel-scratch.ts::KernelScratchRegion` carries each allocation's
pointer and declared capacity together. The exported region, lease, and
guarded-data-view names are structural interfaces; their concrete classes are
module-private. A compiler-backed contract inventories every direct or aliased
factory call, so repository runtime code cannot add a callback that merely
claims an arbitrary pointer/capacity pair without a new exact review entry.
Callers can read or write a region only inside a synchronous
`KernelScratchLease`, which checks:

1. safe-integer and non-negative offsets and lengths;
2. lossless wasm32/wasm64 pointer conversion;
3. the requested range against the allocation capacity; and
4. the resulting address against the current kernel `Memory.buffer`.

This contract is ABI 43 on top of PR #1097's merged ABI-42 result,
`c7d039794a43788acfa0b0aea30a700c257f57cb`. The bump is required by actual
incompatible exports and wires: among them, `kernel_handle_channel`,
`kernel_dequeue_signal`, and `kernel_wait_child_poll` gain capacity arguments,
and the signal-delivery record changes size. Centralizing unchanged constants
alone would not require a bump. Exact final-head validation remains a PR
readiness gate and must be recorded with the commit SHA it actually tested.

The capacity check and memory-buffer check answer different questions. The
second proves that an address exists in linear memory. It does not prove that
the allocator assigned all of those bytes to this scratch region. For example,
a 70 KiB write may fit comfortably in a multi-megabyte `Memory` while crossing
the end of a 65 KiB scratch allocation and corrupting the next Rust heap
object.

The central worker owns separate main-syscall and TCP regions for the kernel
lifetime. Sequential operations reuse them cheaply. A lease rejects nested or
promise-returning work, and a guarded data view is revoked when the lease ends,
so a callback or retry cannot observe bytes replaced by another operation.
The lease is revoked before the callback's return value is inspected for a
promise/thenable, so even an adversarial `then` getter cannot perform one last
scratch access. Bulk copies read intrinsic typed-array slots and detach output;
constructors, slot getters, `set`, `fill`, DataView methods, and
`Reflect.apply` are captured at module initialization. Each bulk write receiver
spans exactly the checked allocation range, so a replaced live prototype or
subclass override cannot widen or intercept the write, reenter the lease, or
retain a live kernel view.
Scalar access checks the lease on every operation. The native `DataView` stays
private and may be reused only while `Memory.buffer` has the same identity; a
`memory.grow()` replaces that buffer and forces the complete capacity and
current-memory proof to run again before the view is refreshed.
Each genuine buffer identity is brand-checked once against captured native
`ArrayBuffer`/`SharedArrayBuffer` getters. The successful getter—not its
result—is cached, so repeated shared-memory proofs avoid an exception while
every proof still observes the live post-growth byte length.
Captured native memory and byte-length getters are bound once, so each live
proof avoids constructing an argument array. Export arguments and borrowed
ranges use private records with null prototypes; inherited numeric setters
cannot intercept them. Validation messages are assembled only on failure.

Opaque export-pointer tokens remain registered only for their synchronous
lease. The lease links its existing private pointer records and deletes their
weak-table registrations when it ends, along with its one-shot invalidator.
An expired token is rejected before any export call. Prompt deletion matters
because weak tables otherwise leave dead lease graphs for a later garbage
collection pass; fewer allocations alone do not guarantee a shorter pause.
The lifecycle cleanup changes no syscall wire or kernel ABI.
Async syscall preparation detaches caller data into host-owned arrays; the
final stage, Rust call, and output snapshot happen in one lease without an
`await`. Retry, timeout, stopped-process, and signal completion state carries
only those detached writes; `completeChannel` never rereads reusable scratch
after the lease has ended.

An `EAGAIN` retry must preserve more than the copied bytes. The host freezes an
immutable request snapshot, while Rust pins any exact resource selected by the
first attempt and exposes an opaque positive retry token. That token is bound
to the process, task, and normalized operation; it is not an fd, queue id,
pointer, or allocation address. Reentry reconstructs scratch only from the
snapshot and activates the pinned target instead of rereading the live mailbox
or resolving a numeric descriptor that may have been closed and reused.

Normal completion, cancellation, and exact channel retirement consume a
positive token before deleting the matching host snapshot. Exec, thread exit,
process exit, and forced removal consume their Rust-owned bindings before the
corresponding task or image state disappears. A zero token is an explicit
host-only disposition, not a missing binding. This ordering prevents both
leaked kernel references and a later operation observing scratch bytes or a
descriptor identity from the wrong request.

The generated channel `request_flags` word records whether the call entered
through libc's cancellation-point path and whether that point may currently be
woken. The host captures and clears those bits with the initial mailbox
snapshot and carries them through the asynchronous wait. Cancellation or exact
channel retirement settles that frozen request before the mailbox and its
scratch allocation can be reused; neither path infers authority later from a
replacement channel.

The Rust channel dispatcher carries the same ownership boundary numerically as
`ChannelScratchRegion { start, capacity }`. The host passes the complete
channel capacity to `kernel_handle_channel`; Rust rejects any value other than
the canonical allocation size before decoding the header. Generated pointer
descriptors classify every argument as exactly one of required or nullable.
A null pointer with positive extent is accepted only when that shared
descriptor explicitly permits null. An argument-sized null pointer with zero
extent is instead canonicalized to a non-null, allocator-owned empty range, so
an arbitrary process-space address never crosses into the kernel merely
because its byte count is zero.

Before laying out any descriptor, the host captures every `Deref`-derived
`u32` length, such as a `socklen_t`, from the validated caller range. The same
captured value sizes the destination and stages the length record, independent
of generated descriptor order. A non-null outer buffer with no length pointer
fails before dispatch. Rust then validates descriptor order, eight-byte
alignment, non-overlap, and every complete subrange against the same channel
allocation. Bespoke vector, message, polling, System V IPC, message-queue, and
other manual wire layouts have corresponding Rust validators rather than a
raw channel-pointer escape.

The generic aligned wire does not carry a second unpadded suballocation
capacity for each descriptor. Rust therefore recomputes a dynamic range from
the staged length and cannot independently distinguish a hypothetical
post-staging length change that remains within the same eight-byte alignment
bucket. The host's pre-captured value is the exact-capacity authority, and the
stage, Rust call, and output snapshot occur in one non-reentrant synchronous
lease, so repository runtime code has no interval in which to make that
change. A stronger independent cross-check would require an additional ABI
capacity field or a wire layout without alignment slack; the existing Rust
proof should not be described as reconstructing information the wire does not
encode.

`prctl` is kept out of generic pointer metadata because its second argument is
option-sensitive. `PR_SET_NAME` and `PR_GET_NAME` stage one required, exact
16-byte buffer; every other supported option preserves the low 32-bit scalar
value and stages no scratch pointer. The two option numbers, name-buffer size,
fixed Fcntl lock-record size, and fixed signal-mask size live in shared Rust
ABI modules and are generated into the TypeScript host, so the bespoke
validators cannot drift by repeating protocol literals.

A C-string argument is accepted only when its pointer is inside the exact
channel data allocation and a NUL terminator occurs before the allocation
ends. This allocation bound is not a substitute for a syscall's semantic
limit: pathname consumers still apply the generated `PATH_MAX`, while generic
C-string consumers may validly use more than `PATH_MAX` when the complete
string fits channel scratch.

Vector-message syscalls cross a width boundary. Musl's native `iovec`,
`msghdr`, and `cmsghdr` layouts differ between wasm32 and wasm64, so their
sizes, offsets, and alignments are generated from the shared Rust ABI source.
`msg_iovlen` and `msg_controllen` are the traps worth naming: musl keeps both
32-bit on wasm64 and pads after each, so reading either as a `size_t` folds
unrelated padding into the high half of a count.

**The kernel reads those structures in the caller's memory itself.**
`sendmsg`/`recvmsg` declare their `msghdr` argument
`SyscallArgSize::KernelDereferenced`, so the host copies nothing and passes
the raw guest address; the kernel takes the caller's pointer width from the
process's registration, and `crates/runtime-core/`
`src/msghdr.rs` walks the header, the `msg_iov` table and the CMSG chain
through `host_proc_read_bytes` / `host_proc_write_bytes`. The fixed
kernel-scratch `KernelIovecWire` / `KernelMsghdrWire` / `KernelCmsghdrWire`
records that the host used to stage are retired and no longer appear in
`abi/snapshot.json`; the scatter/gather syscalls walk the caller's own iovec
table the same way.
Socket-address sizing is likewise generated as two distinct contracts.
The 128-byte `sockaddr_storage` bounds every generic input and output staging
region; the 110-byte `sockaddr_un` bounds family-specific AF_UNIX parsing.
Musl layout assertions bind those totals, the two-byte `sun_path` offset, and
the 108-byte path field to both native data models. The Unix socket registry
owns the canonical namespace key, while `SocketInfo` retains the bounded
original name supplied to `bind()`. This distinction matters for a relative
name in a deep current directory: canonicalization may produce a much longer
lookup key, but it must not enlarge the value returned by `getsockname()`.
An exact 108-byte non-NUL pathname can make Linux-compatible `getsockname()`
report 111 bytes after accounting for its appended terminator, which still
fits the generic 128-byte output region.

For `sendmsg`, the kernel decodes the caller's header, enforces `IOV_MAX`
before reading the table, and gathers every iovec in order into one
contiguous kernel-owned buffer bounded by `SSIZE_MAX` — a datagram must go
out in one piece, and the bound is the operation's own limit rather than a
transport's capacity. It then validates the aligned ancillary stream and the
receiver-reconstructibility of every requested `SCM_RIGHTS` description
before retaining any reference or publishing carrier bytes. Socket
descriptions are not reconstructible from a process-local socket snapshot, so
an ancillary batch containing one fails atomically with `EOPNOTSUPP`; Kandelo
does not pretend that a copied socket record is the original endpoint.

Nested `sendmsg.msg_name` accepts exactly the same 128-byte input maximum as
`sendto`; it cannot bypass that check by living inside `msghdr`.

For `recvmsg`, the kernel reserves at most 128 name bytes even when the
caller advertises a larger buffer, derives `SCM_RIGHTS` capacity from the
CALLER's `cmsghdr` size — 32 control bytes hold five descriptors for a wasm32
receiver and four for a wasm64 one — receives into one contiguous buffer, and
scatters the result across the caller's iovecs. It publishes `msg_namelen`,
`msg_controllen` and `msg_flags` only for a delivered message, including a
zero-length one: on EAGAIN the host parks a retry and calls again with the
same header, so zeroing `msg_controllen` would leave that retry with no
control capacity.

Both retain what a retry must not re-read. A blocked `sendmsg` keeps its
in-flight descriptors in `BlockingRetryTarget::Sendmsg` and a retry uses
those, never a control buffer a peer thread may have changed meanwhile.

Guest process memory is a separate owner, not another spelling for kernel
scratch. `CentralizedKernelWorker.registerProcess` rejects the active kernel
`WebAssembly.Memory` object as a process memory before entering any export or
publishing a channel. This identity check keeps later process-memory ranges,
framebuffers, mappings, and worker transport outside the kernel-allocation
model even if an internal caller accidentally passes the wrong memory object.

Scalar and vectored reads or writes at most `CH_DATA_SIZE` use the main
channel region. The host validates the complete caller range or native iovec
table, flattens a vector directly into the data area, and dispatches one scalar
kernel operation. A vector is never split merely to fit scratch; preserving
one logical operation is required for pipe atomicity, datagram boundaries,
short reads, EOF, and operation-wide file-size limits.

Larger operations reserve
`crates/kernel/src/transfer.rs::TransferScratch`. Begin creates a fresh,
initialized Rust-owned allocation and returns a positive token. The host reads
the token's pointer and explicit capacity together, proves the current-memory
range, and copies under one synchronous lease. For widened syscall and channel
execution, execute changes the reservation from `Reserved` to `Executing`
before releasing the mutex and entering exactly one kernel operation. A
normal return, including an errno, changes it to `Ready`; cancellation then
drops the allocation. No pointer-only execute path exists.

Canonical CWD and open-file-description path snapshots use the same allocation
owner with a deliberately different `Reserved`-state lifetime. The host first
tries its ordinary main region. `ERANGE` triggers a zero-capacity required-size
query, followed by an exact `TransferScratch` reservation when necessary.
`kernel_get_cwd`, `kernel_get_fd_path`, or `kernel_get_dirfd_path` then writes
the complete result while that token remains `Reserved`; the host detaches the
bytes, revokes the region, and cancels the token before leaving the same
synchronous kernel entry. No promise, callback, or second reservation can
overlap that snapshot. A positive short capacity writes nothing and returns
`ERANGE`; zero capacity never dereferences its pointer. The directory-only
export additionally returns `ENOTDIR` for a non-directory descriptor, so
relative `execveat` and shared-mapping lookup cannot join a path against an
ordinary file.

These returned canonical paths are not capped by `PATH_MAX`. That limit
constrains one caller-supplied pathname, not the absolute spelling produced by
resolving a short relative name from an already-deep CWD. Treating the
canonical output as a 4,096-byte object would either produce a false failure
or, worse, publish a prefix that names a different executable or mapping
backing. Host admission therefore requires all three complete-copy exports in
ABI 43 and retains only detached bytes across the later spawn, exec, or
mapping callback.

A host-import trap can prevent Rust from leaving `Executing`. Cancellation
must not free or reuse a region whose callback may have observed only a prefix,
so this state poisons the complete kernel generation. `KernelEntryGate`
serializes every export entry, revokes its lexical scope before running
detached callbacks, and discards queued ingress after a fatal latch. This is a
lifetime guarantee: later work cannot overwrite the reservation or publish a
channel completion against an uncertain Rust transition.

Shared-mapping publication preserves that same fatal signal before its
ordinary host rollback. A branded export failure must reach generation
containment without restoring guest bytes or adjusting published mapping
references; an ordinary host publication error still unwinds those changes.

Process-launch continuations are different from one synchronous kernel entry.
Compiling a child module, allocating process memory, or constructing a Worker
can yield to the host event loop. When a fork, `vfork`, `posix_spawn`, `exec`,
or pthread `clone` continuation resumes, an unrelated HTTP bridge or process
query may temporarily own the entry gate. Result-bearing lifecycle calls retry
only `KernelReentrantEntryError` on a later host turn. They do not translate
temporary serialization contention into a guest-visible launch failure, and
they do not retry ordinary lifecycle or Worker errors. Browser and Node hosts
share this rule. Generation-sensitive `exec` and pthread `clone` retries also
revalidate the exact host process generation before each PID-only kernel
operation, so an `exec` that reuses the PID cannot receive a stale
continuation's address-space or thread mutation. Child-launch paths use
monotonic task IDs or the expected process memory as their equivalent guard.

A prepared exec rechecks the old worker's exact memory registration and
still-pending exec syscall channel inside the commit entry. A cooperative
teardown can complete the channel while the registration still exists.
If that image was removed, replaced, or interrupted during asynchronous
preparation, the host cancels its target and returns `ESRCH` before Rust
commits. It preserves any transition already belonging to a successor.
Once replacement is registered, the discarded image's lease retires through
the same exact-generation ledger used by exit, termination, and destroy.
Overlapping cleanup paths therefore consume the lease once without removing
or reaping the replacement's persistent process ID.

NodeKernelHost and BrowserKernel expose an optional
`onProcessGenerationEvent` observer selected before initialization. Without an
observer, initialization leaves generation observation disabled and emits no
extra lifecycle messages. Subscribed observations contain copied, frozen scalar
data only. `realmId` distinguishes actual kernel-worker creations within one
host instance; `executionId` is the authenticated externref broker's process-
image ID within that realm. Neither is Rust's exec counter or memory allocator
identity, and neither authorizes cleanup. Old worker messages cannot acquire a
replacement realm's identity.

Admission, semantic exit and committed retirement are separate events. A
retirement event records the real lease disposition, registration disposition,
actual main/thread acknowledgments and any failure after the lease commit.
Cooperative guest-memory retirement requires `leaseDisposition: "quiescent"`,
acknowledged main/thread fences, `postCommitFailed: false`, and the exact admitted
identity. Forced or unobserved disposition and missing acknowledgments remain
distinct. The shared detach ledger publishes its completed tombstone before the
one-shot observation; callback failures cannot replay release. Observer throws
or rejected promises do not participate in lifecycle decisions.

These observations prove neither native worker closure nor garbage collection.
They cannot reconstruct an unpublished failed start or an observation lost on a
closed channel. Consumers must subscribe before launch, retain missing evidence
as missing, and independently check normal diagnostics and cleanup.

Each host process registration also captures Rust's full unsigned 64-bit exec
generation through `kernel_get_process_exec_generation`, using exactly eight
bytes of leased kernel scratch under the canonical entry. The host publishes
the complete registration only after that entry ends. Its generation field is
immutable; exec replaces the record, while fork and vfork read the child's own
generation. Thread-channel attachment compares the current Rust generation
against that record before changing channel or thread maps. A mismatch during
the exec commit window refuses attachment and retains the existing allocated-
task rollback. A missing getter or invalid result refuses registration without
publishing partial state. This identity check does not itself grant authority
to retire an old image or acknowledge physical graphics cleanup.

The login program disables password echo and flushes earlier input before
showing its password prompt. Input sent in response to that prompt therefore
is not discarded by a later terminal-mode change.

Positioned host-backed I/O uses required `host_pread` and `host_pwrite`
imports. Signed 64-bit offsets remain exact across TypeScript routing and are
split and reconstructed losslessly at the Wasm boundary; one positioned
operation leaves the shared open-file-description cursor unchanged. A backend
that cannot represent an offset exactly returns `EOVERFLOW` instead of
rounding it or emulating it with seek/read-or-write/seek.

Host-backed `O_APPEND` uses a separate exact-outcome contract. Rust passes the
complete payload and optional `RLIMIT_FSIZE` ceiling to `host_append`; the
backend owns EOF selection, clipping, mutation, and ending-position
observation as one serialized operation. `host_append_position` consumes the
matching one-shot ending offset, and Rust validates the written prefix and
derived start before publishing the cursor. Backends that cannot prove that
pair return `EOPNOTSUPP` before mutation. They do not infer ownership from a
later `stat`.

For `sendfile`, `copy_file_range`, and `splice` into such an append
destination, the source is staged without publishing its cursor or consuming
pipe bytes. Only the prefix reported by the append is committed. An append
rejection, file-size clip, or short write therefore cannot consume source data
that the destination did not publish.

A `posix_spawn` request is not staged through the host at all: the kernel
copies the caller's blob straight out of the caller's memory inside
`kernel_spawn_process`, bounded by the 8,417,320-byte whole-request ceiling.

Rust-lent host-import destinations are deliberately separate. Rust supplies a
pointer and capacity valid for that synchronous import, so
`checkedWasmImportMemoryRange` normalizes the raw wasm32/wasm64 import value
and `WasmPosixKernel.writeKernelBytes` checks that range and the producer's
intrinsic byte span without claiming it came from the scratch allocator.
A process-to-kernel read copies directly into this authenticated allocation
within the synchronous import. It retains neither an intermediate full-range
JavaScript snapshot nor a process-memory view after that call. The destination
still rechecks allocation capacity, memory identity and generation before its
one-use publication, including after memory growth during process lookup.
Full process snapshots for shared-mapping reconciliation use a Rust-owned
allocation whose length remains zero until that import reports exact full-copy
success. Only then does Rust expose its initialized bytes. Errors discard the
unpublished allocation, including any partially written prefix; unexpected
positive import results are errors. This avoids initializing a buffer before
the trusted host fills it, while retaining the same boundary synchronization,
alias ordering and snapshot comparisons. Other mapping backends retain the
safe initialized-slice implementation.

For file mappings, the Wasm backend first compares the live process range
against the existing initialized Rust snapshot through the synchronous
`host_proc_compare_bytes` import. The host validates both complete ranges,
rechecks the exact kernel Memory and generation after process lookup, and
keeps all read-only native authority inside that call. Equal bytes retain the old
snapshot without allocating or copying a new full range. Different bytes
use the ordinary separately validated owned-copy path. Exactly zero means
equal, one means different, and two requests that same owned-copy path when
the optional native comparator is unavailable. Errors never publish partial
bytes. The fixed read-only Wasm helper imports the two existing memories,
allocates no linear memory, writes nothing, and never retains an Instance
or exported function beyond the synchronous borrow. Only compiled modules
and frozen scalar constructor descriptors are cached. Trusted constructor
sites record actual address width, sharing and maximum; unknown externally
supplied memory descriptors retain the owned-copy path. SIMD is preferred
when supported, with a scalar Wasm variant and finally owned-copy fallback.
Native instance churn, browser-memory and application performance validation
are required before accepting this experimental implementation. The normal
host build checks all32 fixed generated variants against their WAT template
and generator using the declared WABT tools. Regenerate with
`scripts/dev-shell.sh npm --prefix host run generate:snapshot-comparator`;
`check:snapshot-comparator` verifies without updating the checked-in bytes.
Each comparison is one observation: every mapping still participates
in the authoritative backing-refresh phase, including stale readers,
descriptor writes and earlier aliases of a later publisher, and a later
guest store remains detectable against the retained baseline. Changed
mappings pay an additional comparison. The one place an observation is
carried forward is the completion boundary of a syscall, described under
[Shared mapping coherence](#shared-mapping-coherence): there a comparison
the entry boundary already made is skipped when the kernel can prove it
would find the same answer.
Process memory,
framebuffers, and explicit shared-memory mappings keep their own ownership
models. A TypeScript-compiler-backed JavaScript/TypeScript repository audit
follows kernel-memory ownership through aliases, parameters, and returns and
reports raw views, writes, escapes, and allocator/reservation calls. Its exact
multiset allowlist names every necessary exception with a reason and fails if
an occurrence is added, duplicated, or removed. This keeps framebuffer,
process-memory, and shared-memory paths explicit without conflating their
ownership with kernel scratch. Because untyped JavaScript can erase a receiver
type, the audit also treats a zero-argument `.getMemory()` call in JavaScript
source as a potential reintroduction of the former raw kernel-memory accessor
and follows its result into aliases, helper parameters, views, and writes.
Same-named non-kernel APIs need an exact reviewed allowance. This narrow
backstop is not a claim of sound general JavaScript taint analysis.

The audit summarizes recursive device graphs only when every descendant
carries concrete non-kernel memory, buffer, view, or instance ownership. The
summary retains those owner tags without repeatedly cloning the whole graph.
Kernel evidence, allocator or reservation callables, constructors, and scratch
authority keep their detailed paths: any of those could produce a kernel
capability later. New kernel taint still merges through its exact field path
and prevents this summary. Allocator invocation and allocator return authority
are separate states. Calling a raw allocator returns a pointer, while a
callback that returns an allocator keeps that callable visible even through
higher-order wrappers and casts. Numeric pointer formatting therefore requires
no scratch-call exception. The audit retains its complete source inventory,
fixed-depth conservative fallback, and exact exception multiset.

The Rust dispatcher has a separate source-contract test for raw process
addresses. It rejects the former raw-channel-pointer macro, matches every
remaining `process_address!` use against its exact reviewed syscall context,
and also checks the total use count. Those sites represent guest virtual
addresses for memory-management, clone, futex, and related operations; they
are not authority to dereference kernel scratch. A new site, a removed site
paired with an unrelated replacement, or a reintroduced bare channel pointer
therefore requires an explicit review instead of passing a count-only
allowlist.

The former low-level `WasmPosixKernel.getMemory/getInstance` and
`CentralizedKernelWorker.getKernel/getKernelInstance` accessors are no longer
part of the supported host API. The public wrappers expose bounded queries
such as kernel-memory page count, not mutable `WebAssembly.Memory`, a raw
`WebAssembly.Instance`, or its export namespace. A module-private capability
gives only the dedicated kernel worker the exact gate and memory it owns; it is
not re-exported to embedders. This is an intentional host-API incompatibility:
downstream consumers of the former raw accessors must migrate to an
ownership-specific bounded operation. The compiler-backed audit retains the
old method spellings as fail-closed regression seeds so reintroducing an
unreviewed raw accessor becomes a contract failure.

Current host-adapter admission requires `kernel_set_cwd`,
`kernel_get_cwd`, `kernel_get_fd_path`, `kernel_get_dirfd_path`,
`kernel_process_metadata_begin`, `kernel_process_metadata_stage`,
`kernel_process_metadata_commit`, and `kernel_process_metadata_cancel`.
Initial cwd and process argv/environment therefore cannot silently fall back
to an older pointer-only aggregate setter, clear-then-push sequence, or no-op
after the runtime has negotiated the capacity-owned scratch contract. One
positive metadata token stages a complete argv/environment pair in Rust-owned
vectors while the live pair remains unchanged. The host supplies both vectors
or neither; it rejects a partial replacement before entering the kernel so the
aggregate `ARG_MAX` proof can never omit preserved live bytes. A failed stage
makes the token uncommittable, and the host cancels every uncommitted token in
a `finally` path. Commit performs no fallible allocation or host import while
it swaps both vectors, so observers see either the old pair or the complete
replacement, never a staged prefix. Relative spawn/exec and mapping resolution
likewise cannot fall back to a fixed or truncating canonical-path query.

System V control operations use the same capacity-bearing main region, but
their wire sizes also depend on the caller. The required structure-size exports
select musl's target structure from the process pointer width:

| Structure | wasm32 time64 | wasm64 LP64 |
|---|---:|---:|
| `msqid_ds` | 96 bytes | 120 bytes |
| `semid_ds` | 72 bytes | 88 bytes |
| `shmid_ds` | 88 bytes | 112 bytes |

The kernel reads and writes these structures in the caller's memory itself,
through `host_proc_read_bytes` / `host_proc_write_bytes`, and takes the caller's
pointer width from the process's registered width (see "Opaque syscall
records"). The kernel Wasm's own width is not a valid substitute because one
kernel may serve both guest widths.

The arguments are declared `SyscallArgSize::KernelDereferenced`, which is what
makes that possible: the host copies nothing and passes the raw guest address
through. No static size rule could describe them, because `msgctl`'s buffer is
an input for `IPC_SET` and an output for `IPC_STAT`, and `semctl`'s fourth
argument is a `union semun` whose GETALL/SETALL form is an `unsigned short`
array sized by the set's own `nsems` — a fact that appears nowhere in the
syscall arguments.

There is still no `IPC_STAT` sizing fallback for semaphore arrays, and the
reason is unchanged: a process may have permission to write a semaphore set
without permission to read its metadata, so sizing the array through IPC_STAT
would impose a read permission POSIX does not require. The kernel
sizes the array from the set's own `nsems` under the requested command's own
permission check instead. The four ABI 43 sizing exports
(`kernel_msqid_ds_bytes`, `kernel_semid_ds_bytes`, `kernel_shmid_ds_bytes`,
`kernel_semctl_array_bytes`) answered a question the host no longer asks and
are gone, as is `kernel_mq_descriptor_msgsize`.

Other caller-native records use the generated
`SyscallArgSize::ProcessLayout` descriptor. The guest's record encoder copies
exactly the size its own data model selects from that descriptor, and the
kernel parses it using the process's registered pointer width:

| Record | wasm32 | wasm64 |
|---|---:|---:|
| `stack_t` | 12 bytes | 24 bytes |
| kernel-facing `itimerval` | 16 bytes | 32 bytes |
| `mq_attr` | 32 bytes | 64 bytes |
| `sigevent` | 64 bytes | 64 bytes |
| `statfs` | 88 bytes | 120 bytes |
| `sysinfo` | 312 bytes | 368 bytes |
| `siginfo_t` for `rt_sigqueueinfo` | 128 bytes | 128 bytes |

The timer distinction is intentional: wasm32 musl translates its public
time64 `itimerval` to four native `long` values before entering the kernel.
Rust parses or serializes each complete caller-native record into a
capacity-bounded scratch slice and initializes padding and reserved bytes.
The kernel Wasm's own pointer width is never used to infer the process layout.
The generated fixed-size descriptors separately carry `stat` (112 bytes) and
`sched_param` (48 bytes); those two records do not use width selection.

`setsockopt` carries the same independent caller-width fact for native IPv4
multicast group records. `group_req` is 132 bytes with its group at offset 4
on wasm32 and 136 bytes with the group at offset 8 on wasm64.
`group_source_req` is 260/264 bytes with its source address at offset 132/136.
The kernel selects these generated layouts from the calling process's
registered pointer width, which is only ever 4 or 8; the sixth channel slot
is the caller's (always-zero) argument and is not read as a width. `optlen` is merely a
caller byte extent, and padding is caller data; neither may be used to guess
the process data model. The public five-argument `kernel_setsockopt` export
keeps its signature and uses the kernel's native width for direct calls, while
the channel path uses the calling process's width.

Process enumeration uses a separate complete-output rule on the fixed main
region. `kernel_enum_procs` first computes the entire snapshot with checked
arithmetic: one four-byte count, one exact packed 36-byte header per live
process, and the variable `comm` and command-line bytes. The packed header is
not a native `repr(C)` structure (which would be 40 bytes after alignment);
`wasm_posix_shared::process_snapshot_wire` owns every offset and generates the
TypeScript consumer plus ABI snapshot evidence. If the complete total exceeds
the supplied capacity Rust returns `ENOSPC` before touching the destination.
On success Rust preflights each complete header-plus-payload record and creates
only the exact required output slice. The host rejects an over-reported byte
count or any malformed count, truncated record, unsafe numeric field, or
trailing byte before returning a process list. Total Wasm memory beyond the
supplied allocation is irrelevant, and neither a short buffer nor a malformed
later record exposes a partial list.

### Kernel heap lifetime

The Rust kernel uses a reclaiming `dlmalloc` heap inside its own Wasm linear
memory. Closing a pipe, reaping a process, replacing an image, or dropping
temporary fork serialization state therefore returns that allocation to the
kernel heap for reuse. This is required for ordinary long-running workloads:
a monotonic allocator would make total historical syscall activity determine
whether a later allocation succeeds.

WebAssembly linear memory cannot shrink. Freeing a kernel allocation makes its
chunk reusable, but the kernel's visible page count remains at its high-water
mark. `NodeKernelHost.getKernelMemoryPages()` and
`BrowserKernel.getKernelMemoryPages()` expose that page count for diagnostics
and lifetime tests; it is not guest process memory. The allocator is protected
by an internal lock even though the architecture serializes kernel dispatch in
one dedicated worker, preserving allocator integrity if dispatch concurrency
changes later.

### Advisory file locks

Advisory lock state and semantics live entirely in the Rust kernel. The
machine-wide `ProcessTable` owns one `AdvisoryLockManager`; neither a process
nor the TypeScript host owns a second lock table. The manager starts empty and
retains one high-water `Vec<LockRecord>` sorted by file identity and range.
Binary search selects the contiguous records for a file before range scanning,
so lookup is `O(log n + k)` for `k` records on that file rather than a scan of
unrelated files. The vector grows geometrically, never shrinks, and is bounded
at 4096 normalized records so adversarial lock churn cannot retain unbounded
kernel heap capacity.

Each host-backed regular file is identified by the exact `(st_dev, st_ino)`
returned by `host_fstat` on its live open handle. The open file description
caches that identity; remembered pathnames and pathname hashes are never lock
identity. `VirtualPlatformIO` qualifies device IDs by backend object and
backend-local device, so mounting the same backend object twice preserves
aliases while different backend objects cannot collide. Node obtains device
and inode values from bigint-native stat calls. In-kernel memfds, procfs
regular objects, and read-only synthetic regular files use explicit tagged
kernel-object identities; none derive identity from a pathname hash.

Process locks use the PID owner required by POSIX. OFD locks and `flock()` use
a kernel-global, monotonically allocated open-file-description ID: independent
opens differ, while `dup`, `fork`, and `exec` preserve the ID. `flock()` keeps
Linux-observable OFD-style lifetime in its own namespace, independent of POSIX
and OFD byte-range records. Process locks are not inherited by `fork`; they
survive `exec` under the same PID, except that closing a `FD_CLOEXEC`
descriptor applies the normal close rule. A close removes all process locks
held by that PID on the file; an OFD lock remains until the last machine-wide
reference to its open file description closes. Range
normalization, replacement, splitting, coalescing, conflict selection, and
capacity checks all happen in Rust. Conflicts are reported as `EAGAIN` before
capacity is considered; a mutation that would exceed the record limit or
cannot reserve its final capacity returns `ENOLCK` without partial state.

For a supported `SCM_RIGHTS` description, the queue entry retains the source
description's `OfdId`, `FileId`, and a live reconstructible backing reference.
Transfer validation is repeated before retain and before receiver
installation; stale, non-owning, structurally incomplete, socket, epoll, and
other process-owned descriptions fail with `EOPNOTSUPP` instead of becoming a
lossy snapshot. In particular, a batch containing a socket fails before its
carrier data or rights become visible. Supporting socket transfer requires one
authoritative machine-wide socket backing and is not approximated here with a
copied process-local record.

A valid queued reference participates in final-reference checks even after the
sender closes its descriptor. Successful receipt transfers that retained
reference into the receiver without changing lock ownership; a discarded
message or failed receiver fd allocation releases it and removes
OFD/`flock()` records only if it was the true final reference. Destructors
enqueue fixed cleanup metadata into pre-reserved, high-water storage, and
cleanup runs after pipe-table borrows end. The host schedules the syscall but
never stores or examines lock state. Each process keeps its descriptor and OFD
table shell, but mutable offset, status flags, and async owner live in an
exactly owned `Rc<Cell>` state shared across fork, vfork, spawn, and supported
`SCM_RIGHTS`. A queued descriptor keeps that same state live, so receipt sees
mutations made after send rather than a frozen scalar snapshot.

On an AF_UNIX stream, retained rights are associated with absolute byte ranges
in the stream rather than a separate first-in/first-out side queue. A receive
cannot observe a descriptor before it reaches that record's carrier bytes, and
`MSG_WAITALL` stops at an ancillary boundary instead of consuming bytes beyond
the rights it can return. Ordinary `read()` discards rights only when it
consumes their carrier range. `MSG_PEEK` fallibly duplicates the retained
references without consuming either bytes or rights, so a short control buffer
can report `MSG_CTRUNC` repeatedly and a later full receive still obtains the
descriptors.

An AF_UNIX datagram stores payload, source address, and retained rights in one
queue entry. Publication is atomic: a full queue or failed descriptor retain
publishes neither bytes nor rights. Zero-length datagrams remain real messages,
so `recvmsg()` with no iovecs can consume one and receive its control records;
ordinary `read(fd, ..., 0)` remains a no-op and cannot consume it. Addressed
and connected same-process AF_UNIX datagram sends use this same ownership
path. Cross-process AF_UNIX datagram routing remains unsupported as documented
in the networking section.

ABI 40 removes the required `host_fcntl_lock` import and the public
`SharedLockTable` host-package export. This is an intentional host API break:
embedders must not register or manipulate lock storage. The unchanged guest
`fcntl`, OFD-lock, and `flock` syscall surfaces now reach the Rust manager
directly, which also lets a native Wasm host use the same implementation
without a lock-specific JavaScript binding.

Host advisory-lock marshalling retains an owned 32-byte request snapshot:
blocking retries must not observe later guest writes or memory growth. Only
successful `F_GETLK`, `F_GETLK64` and `F_OFD_GETLK` calls copy a result back;
setters consume input only. Signal termination and caught-signal dequeue
precede result publication and retry scheduling.

One lease-bound scratch view writes the request and reads its result. The
wrapper checks lease ownership on every access and refreshes its private
native view after kernel memory growth. It is created within each request's
lease and revoked with that lease; it is never cached on a channel or shared
between requests. A second result wrapper would duplicate allocation without
adding a memory-growth or lifetime check.

### Cooperative process-runtime interrupts

A process module may import
`env.__wasm_posix_vm_interrupt_after(timed_out_ptr, vm_interrupt_ptr, seconds)`
to request a cooperative runtime deadline. This import is intended for
language runtimes that already poll an interrupt flag at VM safepoints; it is
not a substitute for POSIX signal delivery or a general program-specific
kernel hook.

The process worker forwards each arm or cancellation request to its host's
dedicated kernel worker. The kernel worker owns the JavaScript timer because a
process worker executing a CPU-bound Wasm loop cannot service its own event
loop. At the monotonic deadline the host sets each flag byte with an atomic
store in the process's shared memory. Timer entries retain the exact
process-generation object as well as the PID, so exec or exit cannot redirect
a stale callback into a replacement process image. Deadlines beyond
JavaScript's signed 32-bit timer range are scheduled in bounded chunks.

The imported function and its pointer-width-specific signature are part of
the guest/host ABI. A package that starts importing it must raise its kernel
ABI floor in the same ABI reconciliation that versions and snapshots the new
surface.

Host-runtime failure diagnostics are kept separate from guest file descriptor
2. Worker traps, protocol failures, failed process or thread transitions, and
GL emulation the host could not apply to a guest draw (the draw still runs
with WebGL's behavior; `host/src/webgl/diagnostics.ts`) produce typed
`host_diagnostic` messages; `NodeKernelHost` and `BrowserKernel`
expose them through `onHostDiagnostic`. An ordinary process exit, including a
nonzero exit used as POSIX control flow, is reported only through its exit
status and is not a host warning. Node records actual host diagnostics on the
embedding process's console, while the browser live-demo consumer records them
in dmesg. Neither path appends host diagnostics to the program's stderr byte
stream, so test harnesses and applications observe only bytes the guest
actually wrote.

### 3. Glue Layer (C)

**Location**: `libc/glue/`

Compiled into every user program. Three main files:

| File | Purpose |
|------|---------|
| `channel_syscall.c` | Channel-based syscall dispatcher. Writes syscall number + args to SharedArrayBuffer, notifies kernel via `Atomics.store` + `Atomics.notify`, waits for response via `Atomics.wait`. Also handles fork (`wasm-fork-instrument` save/restore), clone (thread setup), exec, and signal delivery. |
| `compiler_rt.c` | Compiler runtime: soft-float (`__floatditf`, `__fixunstfdi`, etc.) and 64-bit builtins needed by musl on wasm32. |
| `dlopen.c` | Dynamic loading glue for `dlopen`/`dlsym` via host. |

## Syscall Channel Protocol

Each process has a dedicated channel region in its SharedArrayBuffer memory. The channel is placed in a host-reserved control slab immediately before the guest-managed brk/mmap region, not at the maximum memory address. This lets a process start with a small shared `WebAssembly.Memory` while keeping the channel address stable as guest brk/mmap activity grows memory on demand.

JavaScript-generated channel requests share `waitForChannelCompletion` in
`host/src/channel-completion-wait.ts`. It borrows the caller's status view,
re-enters the native wait after notifications while the status remains pending,
and preserves native failures. Each caller still owns request publication,
result interpretation, signal handling and exit behavior. These waits retain
their unbounded policy; libc's separate bounded wait and heap safepoint remain
unchanged. This shared routine supplies no execution hold or proof of unchanged
process memory and does not omit shared-mapping synchronization.

### Channel Layout

```
Offset  Size   Field
0       4      status (Atomics.wait/notify target)
4       4      syscall_number
8       48     arguments (6 × i64)
56      8      return_value (i64)
64      4      errno_value (i32)
68      4      request_flags (u32; cancellation and signal-delivery authority)
72      65536  data_buffer (for path strings, read/write buffers, etc.)
```

Total: 65,608 bytes (header 72 bytes + data buffer 65,536 bytes).

Both wasm32 and wasm64 write six 64-bit argument slots. On wasm32, musl's
public variadic `syscall()` entry point still reads 32-bit `long` arguments,
because that is the C calling convention its callers use. The non-variadic
`__syscallN` and cancellation-point `__syscall_cp` paths widen values to 64
bits before calling the glue layer so offsets and lengths are not truncated.
Both paths overwrite `request_flags` before publishing the atomic status.
Plain calls write zero; cancellation-point calls use generated flag constants.
The host captures and clears the field with the request snapshot.

Bits 0 and 1 of `request_flags` identify cancellation points and authorize a
cancellation wake, respectively. A wake is valid only when both bits are set.
Bit 2, `REQUEST_FLAG_DEFER_SIGNAL_DELIVERY`, identifies a completion consumed
by process-worker JavaScript instead of libc's post-syscall signal trampoline.
The kernel leaves caught signals pending on those completions. Fork, clone,
continuation allocation/cleanup, and staged-loader VFS/memory requests set the
bit and clear it before returning control to guest code. Libc then uses an
ordinary side-effect-free `getpid` syscall as the signal-delivery checkpoint
after the owning import returns. Ordinary guest syscalls clear the flags word.
Bit 3, `REQUEST_FLAG_OPAQUE_RECORD`, says the data buffer begins with a
self-describing syscall record (next section) rather than raw scratch.

The flags word is guest-written, so the host validates it as untrusted input.
An unknown bit, the cancellation-wake bit without the cancellation-point bit,
or bit 3 on a syscall that must keep raw arguments
(`crates/shared/src/host_raw_syscalls.rs`) is a malformed request: the host
completes that one request with `EINVAL` and dispatches nothing. It is never a
reason to stop the kernel worker, because every process shares it.

### Status Values

| Value | Name | Meaning |
|-------|------|---------|
| 0 | IDLE | Channel is idle |
| 1 | PENDING | Process has written a syscall, kernel should handle it |
| 2 | COMPLETE | Kernel has written the result, process can read it |
| 3 | ERROR | Kernel has written an error result |
| 4 | TEARDOWN | The thread's image is being abandoned; the glue traps instead of returning |

`TEARDOWN` is not a syscall outcome. The host publishes it, with an
`Atomics.notify`, to unwind a guest thread parked in the channel wait without
letting it resume an image that is being replaced or rolled back (an
abandoned `execve`, a fork-replay teardown, a `posix_spawn` rollback). The glue
traps as soon as it observes the value and never reads `return_value` or
`errno_value`.

A blocked syscall is not a status value either: the kernel answers it with
`EAGAIN` and the host parks the channel (see "Blocking Syscalls and Retry").

### Syscall Flow

```
Process Worker                          Kernel Worker (host)
─────────────                          ────────────────────
1. Write syscall_number + args + request_flags
   to channel
2. Atomics.store(status, SYSCALL_READY)
3. Atomics.notify(status)
4. Atomics.wait(status, SYSCALL_READY)
   ─── blocks ───                      5. Atomics.waitAsync detects change
                                        6. Read channel: syscall + args;
                                           capture and clear request_flags
                                        7. Call kernel_handle_channel(offset,
                                                                      capacity, pid,
                                                                      retry_token=0)
                                           (kernel_handle_channel_record(offset,
                                           capacity, pid) for a request with
                                           REQUEST_FLAG_OPAQUE_RECORD)
                                        8. Kernel reads args from process memory
                                        9. Kernel executes syscall logic
                                       10. Kernel writes return_value + errno
                                       11. Atomics.store(status, RESULT_READY)
                                       12. Atomics.notify(status)
13. Atomics.wait returns
14. Read return_value + errno
15. Return to caller
```

Step 4 is a bounded wait on JavaScriptCore, a workaround for a suspected
engine behavior (not a confirmed WebKit defect). When it times out with the
request still pending, the glue calls the host import
`kernel.kernel_heap_safepoint`, which allocates from JavaScript so the
worker's VM can finish a garbage collection that is suspected to have been
handed to the blocked thread, and waits again on the same request. The host
answers V8 and SpiderMonkey with an unbounded wait, so there the step is a
single wait. The program observes the same result either way. See
[the browser boundary](browser-support.md#javascriptcore-garbage-collection-and-blocked-workers).

Steps 10–15 normally include caught-signal publication and libc handler
dispatch. A request marked `REQUEST_FLAG_DEFER_SIGNAL_DELIVERY` deliberately
omits that publication because JavaScript owns its completion and has no
signal-handler trampoline. The next explicit guest checkpoint performs the
same delivery only after the host import has returned; this avoids both signal
loss and a reentrant host-to-Wasm callback.

### Opaque syscall records

The host does not interpret a syscall's pointer arguments. For every
non-blocking syscall, the guest's own libc glue (`libc/glue/channel_syscall.c`)
marshals the call into one bounded, self-describing record at the start of the
data buffer and sets `REQUEST_FLAG_OPAQUE_RECORD`. The record format is defined
once, in `crates/shared/src/channel_record.rs` (record ABI v1): a fixed header
(magic, record ABI, syscall number, span count, the record's total length, the
six scalar argument words) followed by span descriptors, each naming an
argument index, a direction (in, out, in/out) and a byte range inside the
record. The length is the one field the host reads: it copies exactly that
many bytes into kernel scratch and back, because moving the whole 64 KiB data
buffer each way made every record syscall several times its own cost. The
kernel decodes only those bytes and validates every rewritten argument against
the record (plus zeroed fixed `select` slots), never the whole scratch
allocation, since the bytes past the record belong to earlier requests. The glue learns each
syscall's pointer layout from `bits/kandelo_syscall_marshal.h`, which
`cargo xtask dump-abi` generates from
`wasm_posix_shared::host_abi::SYSCALL_ARG_DESCRIPTORS` and the ioctl contract,
so C and Rust read one table. Bespoke families whose layout depends on another
argument (`ioctl` by request, `fcntl` locks, `prctl` names, `epoll_wait`'s
event array, `select`/`pselect6`) are marshalled by small hand-written cases
in the same file.

The host hands a flagged request to `kernel_handle_channel_record` instead of
`kernel_handle_channel`. Both run `handle_owned_channel_allocation`; the entry
point tells it which transport the guest chose, and only the record transport
decodes a record, with the bounds-checked decoder in
`crates/runtime-core/src/channel_record_decode.rs`. It lays each span back
into the scratch layout the existing validators accept, dispatches, and copies
out/in-out spans back to the caller's addresses. Nothing falls back to
guessing: a missing record, a record that does not decode, a record whose
syscall number differs from the header's, and a record for a host-raw syscall
each complete the request with `EINVAL` without dispatching anything. The raw
transport never looks for a record. Its data buffer holds whatever the host
staged (a `write` payload, a path) or whatever an earlier request left in the
reused kernel scratch, and either can begin with the record magic; deciding
from those bytes would let ordinary user data choose which syscall runs.

Two classes of call stay on the raw-argument path, and
`crates/shared/src/host_raw_syscalls.rs` is the authoritative list:
syscalls the host itself intercepts (fork, exec, thread creation, and similar
lifecycle calls) and syscalls that can block and are retried by the host
(`read`, `poll`, `sigsuspend`, `pause`, `getaddrinfo` while a backend's
asynchronous DNS lookup is pending, ...), whose retry snapshot is built from
the raw arguments.

Some arguments cannot be described by a static size rule at all: a
`struct msghdr` that leads to an iovec table and a CMSG chain, the
scatter/gather iovec table of `writev`/`readv`/`preadv`/`pwritev`, and the
SysV IPC and POSIX message-queue buffers whose direction and size depend on
the command. Those arguments are declared
`SyscallArgSize::KernelDereferenced`. The record carries only the caller's raw
guest address in its scalar slot, and the kernel reads and writes the caller's
memory itself through `host_proc_read_bytes` / `host_proc_write_bytes`
(`crates/runtime-core/src/guest_ptr.rs`, `msghdr.rs`, `ipc_wire.rs`), in the
caller's data model.

**The caller's data model is per-process kernel state.** One kernel instance
serves wasm32 and wasm64 processes at once, so the kernel cannot use its own
compilation target to size a caller-native structure. `Process` carries
`pointer_width`. The host sets it with `kernel_set_process_pointer_width`
whenever it registers an address space it instantiated (process creation and
the image an `exec` installs), a `fork` child inherits it through the fork
state record, and the dispatcher reads it once per syscall. No channel
argument slot carries it: slot 5 belongs to the caller, which is what gives
`preadv2`/`pwritev2` their `flags` argument (`RWF_NOWAIT` is implemented;
every other `RWF_*` bit is refused with `EOPNOTSUPP`).

### Blocking Syscalls and Retry

Some syscalls (read from an empty pipe, accept on a socket, or poll with a
timeout) cannot complete immediately. The process worker remains blocked in
`Atomics.wait` while the host parks and wakes its pending channel through
`Atomics.waitAsync`.

The retry boundary also owns caught-signal delivery. Once Rust dequeues a
caught signal into `CH_SIG`, that channel is the signal record's sole owner
until libc runs the handler and clears it. If the syscall would otherwise
remain blocked, the host captures and releases its exact retry authority, then
completes the channel with `EINTR` before it can park again. Public nonblocking
`EAGAIN` outcomes remain `EAGAIN`. After the handler, libc resubmits only its
reviewed zero-progress `SA_RESTART` allowlist, including `accept`, `accept4`,
and `ppoll`. POSIX does not give `ppoll` the `pselect`
restart-versus-`EINTR` exception, so it remains on that list; Kandelo
deliberately selects `EINTR` for `pselect`, whose `SA_RESTART` outcome POSIX
makes implementation-defined. Other timeout-bearing operations remain out
when a new submission would reset their deadline. The shared
`CentralizedKernelWorker` state machine provides the same behavior in Node.js
and browser hosts.

A syscall can also end its own process. When a write raises `SIGPIPE` or
`SIGXFSZ`, Rust applies the signal's default action before the syscall
returns. That includes a blocked pipe write retried after the last reader
closed. The process is then already an `Exited` zombie when the host reads
the result. Every host path that runs such a syscall checks for that signal
death first and finishes the termination before it enters the kernel again:
the generic channel path and its retry replay, vectored and large transfers,
and `sendmsg`. `kernel_dequeue_signal` is defined only for live tasks and
rejects an exited one with `ESRCH`, and the host treats that rejection as a
fatal protocol failure. A path that skips the check therefore turns one
process's `SIGPIPE` into the death of the whole kernel instance. A pending
signal that a wait's mask unblocks (`ppoll`, `pselect`, `epoll_pwait`) takes
a different route: the host's dequeue applies the default action itself and
returns 0, and the check that follows every dequeue finishes the
termination.

For a signal-mask-swapping `ppoll` or `pselect`, each TID owns a LIFO stack of
wait contexts. Each context records both the caller's saved mask and the
replacement mask. An active frame accepts repeated kernel attempts. Once a
signal interrupts it, reuse additionally requires the current caught-handler
depth to have fallen below the handler depth recorded by that frame. A wait
entered by a catcher is therefore distinct from the interrupted outer wait
even if the catcher explicitly restores the replacement mask and reuses
identical syscall arguments. The signal record restores the mask current at
delivery, so a restarted `ppoll` keeps its replacement mask continuously
installed between attempts. Terminal success restores the top context in the
normal syscall path; final `EINTR` uses the existing exact-task host-wait
cancellation after the catcher returns. That cancellation also finalizes
`sigsuspend` and `pause` after their catcher.

The Wasm setjmp runtime records caught-handler depth in every jump environment.
Both `longjmp` and `siglongjmp` first retire every abandoned handler and its
paired wait context through the existing `rt_sigreturn` and exact-task
cancellation operations. `siglongjmp` then applies the jump environment's
saved mask when requested; an application using `longjmp` from a catcher must
restore its signal mask as POSIX requires. An ordinary jump outside a catcher
has no handler context to retire. A finite restarted `ppoll`
keeps its absolute deadline in the libc call frame rather than host channel
state. Nested calls and later same-argument calls therefore have independent
deadlines, while catcher time is still charged to the interrupted call. The
internal timestamp request defers caught-signal publication so a signal
already pending at ppoll entry still interrupts ppoll itself.

For a represented retry, the initial call uses token zero. Before returning
`EAGAIN`, Rust pins any exact target required by that operation. The host
detaches the complete request, queries the authoritative token, and either
completes a nonblocking call or parks the immutable snapshot. A later wake
rebuilds scratch from that snapshot and calls the kernel with the same token;
it does not reread caller memory or follow a reused fd. Terminal completion or
cancellation consumes the token before the host drops its snapshot.

This mechanism is critical: asynchronous scheduling never owns a live scratch
view, while Rust retains the resource identity and lifetime needed by the next
synchronous entry.

Rust serializes readiness and lifecycle changes through one packed wake-event
stream. `crates/shared::wakeup_event_wire` owns its five-byte record layout and
every reason bit; generated bindings give the shared Node/browser host the
same offsets and values. The host owns a complete copied batch before acting
on any event, because process stop/continue handling can synchronously reenter
kernel operations that reuse scratch. The same generated ABI surface owns the
`poll` and `epoll` event bits and `fd_set` sizing used by host-side readiness
marshalling, so the host does not restate those values.

For pipe-readable and pipe-writable records, the host first retries `poll()`
and `ppoll()` channels whose captured kernel pipe index matches the event,
with or without a temporary signal mask. The broad fallback, which runs on
the next worker turn, covers wait classes without an exact pipe identity,
including `select()` and `pselect6()`. Host-originated pipe bridge
notifications use the same target-before-fallback order in the shared
Node.js/browser runtime.

No readiness wake is delayed because the waiter swapped its signal mask.
POSIX requires `pselect()` and `ppoll()` to install the mask and wait as one
atomic step, so a signal the mask unblocks that is pending or generated while
the call is blocked interrupts it with `EINTR`. It does not require a signal
generated after a descriptor became ready to win over that descriptor: the
call may return the ready descriptor and restore the caller's mask, and the
signal then stays pending until the caller unblocks it. The kernel keeps the
temporary mask installed for as long as the wait is parked, and generating a
signal retries parked waits immediately, so no signal can be lost between the
swap and the wait. The host used to hold masked waits back for 50 ms after
each readiness event so that a peer's "write, then kill" would be observed as
`EINTR`; that ordering is unspecified, and the delay cost an interactive shell
waiting in a masked `pselect6()` up to 50 ms per keystroke.

Finite `poll()`/`ppoll()` and `select()`/`pselect6()` waits retain one absolute
deadline from their first attempt. Targeted readiness events, broad wakeups,
and safety retries use the remaining duration instead of restarting the
caller's timeout. Except for descriptor-free `select()` used only as a sleep,
expiry performs one zero-time kernel pass. That pass makes the final readiness
decision, clears readiness outputs, and restores any temporary `ppoll()` or
`pselect6()` signal mask. The host rebuilds the pass from its immutable request
snapshot; it does not overwrite the caller's original timeout or arguments.

`F_SETLKW` uses the same parking mechanism with a narrower wake contract. A
conflict returns the internal retry result, and the host parks only that lock
request. Unlock, conversion, close, exit, and other Rust-side changes that may
unblock a waiter publish an advisory-lock event through the kernel wake stream;
the host only reschedules parked `F_SETLKW` channels and never reads lock state.
A short retry timer remains a scheduling safety net. `ENOLCK` is a completed
guest-visible failure, not a retry result. Native runtimes can consume the same
generic wake event without implementing advisory-lock storage.

**Finite-timeout waits keep one kernel-owned deadline across retries.** Each retry re-enters the handler (`handleBlockingRetry`, `handleSelect`, `handlePselect6`, `handleEpollPwait`) from scratch, so a handler that recomputed `deadline = now + timeout` on every wake would never time out on a busy system — broad wakes arrive every ~10 ms and each one used to push the deadline out again. The deadline is kernel state on `CLOCK_MONOTONIC` (`crates/runtime-core/src/wait_queue.rs`): the first time a call is known to block, the host opens a wait with `kernel_wait_deadline_open(pid, tid, kind, timeout_ms)` and keeps only the returned handle on the channel (`ChannelInfo.waitHandle`); every re-entry asks `kernel_wait_deadline_remaining_ns`, and `clearReadinessWait` closes the handle when the call completes or is abandoned. A handle is an execution generation and is never reused, so a timer armed before an `exec` cannot complete a request issued after it. Because the clock is monotonic, a wall-clock step (an NTP correction, a DST change, a user setting the date) no longer moves pending timeouts. A call that finds its descriptor ready, fails, or is non-blocking never opens a deadline. The host still owns the park itself — the timer and the wake routing — and refuses to boot a kernel that lacks the deadline exports rather than falling back to wall-clock arithmetic.

**epoll interests and delivery state belong to open file descriptions.**
Instances live in the kernel-global backing table. Interests use Linux's
`(registered fd, OFD identity)` key and carry notification candidates and
one-shot disablement. Backing mutations publish candidates independently of
the host wake buffer; delivery rechecks actual readiness, consumes edges and
one-shot state, and rotates bounded batches. Nested epoll peeks do not consume
child events; ctl rejects cycles and excessive nesting. A final target OFD
release removes its interests. A caller that closed its target alias can
still observe that description while a sibling process holds it.

A parked wait owns the exact epoll description and a unique kernel token,
so fd reuse and late retirement after exec cannot redirect or cancel another
wait. The shared Node/browser host retains only this token, the signal scope
and the deadline; it keeps no interest-list mirror. Targeted pipe/accept
wake tokens are latency hints, with bounded yielding retries for other
sources and concurrent registration. Host network notification counters,
signal queue generations, and the independent PCM consumer clock retain
activity that happens between attempts. See the [epoll matrix](epoll.md) for
interfaces, event bits, ownership details and explicit compatibility limits.

The epoll safety timer can ask `kernel_epoll_wait_retry_state(pid, tid, token,
deadline_handle)` whether that exact retained invocation is still blocked.
Only the value `1` permits rearming the unchanged timer without replaying the
syscall. The query checks the live task, pending signals, exact lease and finite
deadline, and evaluates supported local readiness without consuming events,
edge candidates, one-shot state, the batch cursor or the temporary signal mask.
Unknown sources, readiness errors, expired deadlines and stale identities force
the normal retry. The host also requires the original process registration,
request and mailbox scalars, and refuses this shortcut for pending cancellation
or stopped/resuming tasks. A missing optional probe export uses normal replay.
Targeted and broad notifications retain their existing full retry path.

This is an internal observation of an already-blocked call, not another guest
syscall boundary or a result publication. The initial call and every actual
completion retain full shared-mapping and imported-buffer synchronization.
Sibling tasks and other processes still publish at their own real boundaries;
the probe assumes neither writer quiescence nor a dirty-store epoch. The host
still owns the park and its 10 ms safety timer. Moving epoll into the kernel-owned
wait queue requires complete source, lifecycle and copyout integration; this
probe does not claim that migration or an application performance gain.

**Timer and eventfd readiness reach host-owned waits through the kernel
timer and the broad retry.** A timerfd expiry and an eventfd write change
readiness with no pipe or listener token for a targeted wake, and the epoll,
`poll`/`select` and blocking `read` retries the host owns would otherwise
see them only at their 10 ms (epoll, read) or up to 50 ms (`poll`,
`select`) safety retry. Linux wakes those waiters from the timer callback
and from `eventfd_write`, so Kandelo does the same at the real deadline:

- `kernel_wait_next_timeout_ns` answers the earliest of the kernel-owned
  park deadlines and every armed timerfd's next expiry, each measured on the
  timer's own clock (`CLOCK_MONOTONIC`, `CLOCK_REALTIME`, absolute or
  relative), so the host's single kernel timer fires at the deadline.
  Arming a timerfd queues `TYPE_WAIT_COMPLETE`, which makes the host collect
  completions and re-read that answer, so a waiter that blocked before
  another thread armed the timer is still woken on time.
- `kernel_drain_wait_completions` accounts every due timerfd (expiration
  count, epoll candidates) exactly as a read or poll of it would, and
  queues one untargeted `IDX_FENCE_READY` readable record. The host's timer
  callback collects completions, then drains wake records, so the broad
  retry re-runs the blocked waits at the deadline. When completions were
  collected after a wake batch was already drained, the record would wait
  for some later syscall; `kernel_wait_next_timeout_ns` therefore answers
  `0` once for an undrained expiry record, and the host re-enters at once.
  It answers once, not until the record drains, so a host that does not
  drain wake records on that timer degrades to the old safety retry rather
  than spinning.
- An eventfd write queues the same untargeted record from inside the
  syscall, whose own completion drains it. A read queues it only when a
  writer can be waiting: one was refused `EAGAIN` since the last read, or
  the counter was saturated and therefore not writable for a poller.

No clock is read per syscall: armed timers are examined only when the host
collects completions or asks for the next deadline. A clock the host cannot
read leaves that one timer unscheduled (its read or poll reports the error)
without stopping the other deadlines. The remaining latency is the host
timer's granularity, about a millisecond on Node and in browsers, not
Linux's timer slack. Browsers also clamp a timer that is re-armed from its
own callback to 4 ms once five such callbacks are nested (the HTML timer
nesting rule), so successive expiries of a periodic timerfd shorter than
4 ms are delivered about 4 ms apart in a browser; the expiration count read
from the descriptor stays exact.

## Multi-Process Model

### Task identity allocation

The Rust `ProcessTable` is the sole authority for every process ID (PID) and
pthread thread ID (TID) in a kernel instance. One monotonically increasing,
positive signed task-ID sequence serves top-level process creation, `fork()`,
non-forking `posix_spawn()`, and thread-style `clone()`. It starts at 100 and
never reuses an identity, even after a process is reaped or a thread exits. If
the sequence assigns `i32::MAX`, that allocation succeeds; the next allocation
fails with `EAGAIN` instead of wrapping.

This ownership is enforced inside the Rust type boundary, not only by call-site
convention. Each allocation produces an opaque, non-cloneable `AllocatedTaskId`
that production process or thread construction must consume. Process IDs,
thread IDs, and thread membership are read-only outside that path. Raw numeric
constructors exist only for isolated `cfg(test)` fixtures, and fork
deserialization fills a child record whose identity `ProcessTable` has already
allocated rather than accepting a second PID source.

PID 1 is outside that sequence. The kernel creates it as a synthetic root-owned
init reservation with no user Wasm worker, so PID-addressed existence and
permission checks have a real kernel target. The first user process is therefore
PID 100, not PID 1. This synthetic record is not a user-space init program and
runs no wait loop. It is, however, the parent that orphaned processes are
reparented to, and the kernel reaps those children on its behalf (see
"Orphan adoption" below).

Callers never choose an ID or advance a watermark. The host helper
`CentralizedKernelWorker.createProcess(...)` asks the Rust kernel to create a
top-level process and returns the assigned PID. `registerProcess(pid, ...)`
only attaches host memory, syscall channels, and worker metadata to an existing
running or stopped kernel process; it rejects unknown, exited, and synthetic
PID 1 records and cannot create or reserve one. Adding a syscall channel calls
the read-only `kernel_validate_task(pid, tid)`, which accepts only that
process's main task or one of its kernel-allocated threads before the host
records the channel. For a cloned pthread, the callback receives a one-shot
transport proof bound to the exact clone result; `attachThreadChannel` derives
the PID and TID from that proof, rejects replay and duplicate mailbox ownership,
and never accepts a caller-selected numeric identity. Validation does not
install dispatch authority. Immediately before each mailbox call, the host
calls `kernel_set_current_tid(pid, tid)`;
`kernel_handle_channel` consumes and clears that exact pair on every returning
path, including the kernel-side exit transaction. Returning is required here
because a trapped WebAssembly export skips the compiler's shadow-stack
epilogue; repeatedly trapping the reusable kernel would permanently consume
stack. The process worker's separate `kernel_exit` import traps after the
mailbox completes, so guest `_exit` remains non-returning without leaking the
kernel's stack. Transport misrouting or earlier validation therefore cannot
authorize a later dispatch.
The same holds when `SYS_EXIT` or `SYS_EXIT_GROUP` itself arrives through
`kernel_handle_channel`: the dispatcher commits the exit through the same
transition `kernel_commit_process_exit` uses and answers 0, and whether the
exited thread may run again is the host's decision. Node and the browser
intercept both syscalls before the channel. Those two dispatcher arms used to
call `kernel_exit`, which ends in a trap, so an exit forwarded to the channel
trapped the kernel after committing and skipped the dispatcher's retry-state
cleanup. A source guard in `crates/kernel/src/lib.rs`
(`channel_dispatch_never_calls_a_diverging_function`) keeps the dispatcher
from calling a `-> !` function again.
During the ABI 42 transition, the host also accepts the deliberate post-commit
exit trap from an older ABI 42 kernel, then applies the same authoritative
`Exited` state check. The compatibility path does not treat a trap alone as
successful exit.
Signal dequeue, child-wait polling, write-limit preparation, and guest SysV
shared-memory attachment also carry the exact live caller TID explicitly.
Rust owns each attachment's address, segment id, size, and lifetime; the shared
host retains versioned snapshots only to reconcile bytes between distinct
process memories. Fork-child materialization and lifecycle cleanup use
separately named process-level SysV exports.
Fork and spawn carry the channel's caller TID to the kernel, which validates it
as a live task belonging to the parent. That value selects caller-specific
state; it is never a candidate child identity. Clone validates the bound caller
against the same live task records before allocating its new thread ID. Fork,
spawn, and clone callbacks likewise receive identities that the Rust kernel has
already allocated.
`exec()` preserves the calling process identity.

A task-binding rejection while the Process is live is a fatal host/kernel
protocol failure: the host marks the process crashed and terminates its Workers
without returning a synthetic guest error. Rust must accept that signal-death
transition before the host records the process as reaped or wakes its parent;
a missing or rejected transition remains a loud protocol failure. Neither a
normal return nor a legacy compatibility trap from the kernel exit transaction
is sufficient by itself: the host verifies the Process is actually `Exited`
before publishing a clean exit.
During process exit, Node and browser may briefly retain exact channel objects
until Worker termination completes.
Once Rust has made that Process Exited, those channels can finish only musl's
`exit_group`/`exit` transport handshake; every other late syscall stays parked
and never re-enters kernel state. Final teardown removes all PID-prefixed thread
channel, fork-context, and clear-TID metadata.

### fork()

Fork uses the in-tree `wasm-fork-instrument` tool to snapshot the Wasm call stack (details in [fork-instrumentation.md](fork-instrumentation.md)):
Before compilation or worker launch, Node and browser hosts validate the
embedded ABI version, linked-frame contract, control exports, and ABI 43
`FORK_CAP_ACTIVATION_STATE_SAFE` claim. Pthread and side-module entry points
apply the same policy.

1. User calls `fork()` → musl → `kernel_fork(FORK)`; the process adapter
   validates the ABI-owned mode.
2. The host's `kernel_fork(mode)` override begins one process continuation
   transaction. It captures activation catalogs and module state, maps each
   participating activation's root continuation chunk, and calls
   `wpk_fork_unwind_begin(root + chunk_header_size)`. The tool-injected export
   sets state to UNWINDING and snapshots every mutable scalar global (including
   `__tls_base` and `__stack_pointer`) into that activation's fixed prefix.
3. The return-to-caller chain unwinds. After each fork-path call returns in the
   unwinding state, the caller asks the host to reserve a complete node before
   its first frame write; its postamble commits the node only after all
   activation-owned scalar state has been saved. Live references are interned
   into one process recipe graph and the frame stores only its reference-vector
   ordinal. The host maps additional page-rounded chunks when necessary. No
   accepted frame names a module-instance reference-table slot.
4. Once `_start` returns (top-of-stack), the host sends `SYS_FORK` through the
   channel for the captured ordinary-fork mode.
5. Kernel's `kernel_fork_process(parent_pid, caller_tid, mode)` validates the caller,
   allocates the child PID from the global task-ID sequence, and copies process
   metadata and the fd/OFD tables. The child receives the calling task's blocked
   signal mask, while inherited stateful descriptors retain references to their
   existing kernel-global backings.
6. Host copies the parent's linear memory, including continuation mappings, to
   a new `WebAssembly.Memory` and spawns a child worker. Kernel mmap metadata is
   inherited with the process state. The worker creates a fresh Wasm instance:
   mutable globals, tables, exception references, and Store-owned references
   are not copied and are not evidence that replay state survived.
7. The child validates the copied KFRV/KFMS arena, instantiates every required
   main/side activation, materializes static roots, typed GC objects, opaque
   owner tokens, and complete exceptions, then restores reference globals,
   table contents/length, and segment lifetime. Only after those owners are
   ready does it call `wpk_fork_rewind_begin(buf)` to restore scalar globals.
   Typed object allocation also installs the child's own weak constructor
   provenance, so a later nested fork encodes child-local objects rather than
   depending on identities retained from the original parent.
   The host then calls `setupChannelBase(...)` (which reads the now-correct
   `__tls_base`) and invokes the selected main or pthread resume root.
8. Each instrumented function's preamble requests and validates the next committed frame, then re-enters the call site where the parent was interrupted. Eventually it reaches the `kernel_fork` call site in the leaf function, which returns 0. Libc then refreshes the copied pthread TID from the kernel through `set_tid_address` before returning to user code.
9. `wpk_fork_rewind_end` resets state; parent and child independently unmap their continuation chunks; fork returns 0 in child and the child PID in the parent.

ABI 43 also lets libc call `kernel_fork(VFORK)`, which remains the same exact
mode through unwind/replay and reaches `SYS_VFORK`, the kernel export, and the
child Worker initialization record. After admission and kernel child creation,
that mode branches away from ordinary step 6: the host retains an exact alias
to the parent's existing `Shared WebAssembly.Memory` and launches a separate
child Worker without constructing or copying a child process Memory. The child
receives its own syscall channel, host-reserved replay workspace, Wasm
instance, loader, and continuation controller. Only the calling parent thread
stays parked in the asynchronous fork import; sibling pthreads continue to
run.

The kernel marks the vfork child's independent Process record. A nested
vfork and pthread clone fail with `EAGAIN`: a second borrower of the parked
parent's memory would need stacked lifetimes the host does not provide.
Ordinary fork and spawn are allowed. A vfork child's fork copies the borrowed
memory like any fork. The child captures its continuation with its own
mappings and publishes the root in its borrowed control slot, below its own
channel, because the process anchor still belongs to the parked parent. It
takes no archive lock, since the parent's reader already pins the snapshot.
The grandchild adopts that root as a thread fork does. Failed exec preserves
the marker and returns to the child. Successful exec commit, `_exit()`, and exact
signal/trap teardown quiesce the borrowing Worker, release its alias and
workspace, and resume the exact parked caller once. An ambiguous forced Worker
termination cannot prove that shared-memory access stopped, so the host
contains the complete address-space owner group rather than resuming the
parent unsafely. Ordinary fork continues to use only the ordinary mode and the
independent-memory path above.

After vfork capture seals, its process Worker reports two exact workspace
requirements in host-intercepted syscall arguments: all active activation
prefixes after alignment and the reference/exception codec scratch high-water.
The centralized host accepts one four-page control slot and returns `EAGAIN`
before allocating the kernel child when the 61,440-byte prefix region or
65,536-byte scratch page would be exceeded. This preflight is connected, but
the workspace belongs to host-reserved control storage rather than a second
process address space.

Step 6 is materially different from native virtual-memory fork. Native
kernels normally map the parent's pages into the child with copy-on-write
ownership, so unchanged pages are not copied. Browser WebAssembly exposes no
equivalent operation for cloning a `WebAssembly.Memory`. Kandelo must allocate
a fresh memory and copy the parent's complete current address space before an
ordinary fork child runs. An ordinary fork child that immediately calls
`exec()` therefore pays for both the discarded fork copy and the replacement
program memory. Kandelo's
non-forking `posix_spawn()` path avoids that copy when the caller can describe
the requested child entirely with spawn actions and attributes.

Kandelo releases its references to an exited or replaced process generation
only after the exact Worker, channel, thread, and framebuffer ownership fences
complete. JavaScript engines still decide when the unreachable shared backing
returns physical memory to the host. A burst of large fork/exec children can
therefore allocate faster than a browser reclaims retired generations even
when ownership teardown is correct. Temporary package compatibility
exceptions and their removal criteria belong in the active migration plan;
they do not redefine ordinary `fork()` semantics.

If the root continuation mapping cannot be allocated, `kernel_fork` returns the
negative mmap errno before unwind starts. If a later node allocation fails,
the owning module enters `ABORT_UNWINDING`: the live failing activation
restarts at its call site, committed inner nodes replay to the original fork
import, and the host releases the partial chain before returning the negative
errno. A negative `SYS_FORK` result after step 4 instead uses the complete
parent rewind. These resource failures create no child and leave the parent in
`NORMAL`, able to continue or retry `fork()`.

ABI 43 reconstructs reference locals/parameters/carryovers, concrete and
abstract GC objects, mutable reference globals, and complete exception state.
Statically tagged scalar `Catch`/`CatchRef` arms keep their exact selector and
maximum live operand tuple in activation-owned bytes; rewind rethrows the tag
so the original clause creates a fresh instance-local exnref.
Reference/vector payloads, `CatchAll`/`CatchAllRef`, JSTag ingress, and modern
C++ cleanup exnrefs use the complete-exception recipe and likewise re-enter the
original Wasm handler without parent-instance scratch. See
[fork-instrumentation.md](fork-instrumentation.md) for the ownership formats
and cleanup ordering.

A fork reached inside instrumented dlopened side modules uses one process-wide
event journal plus one linked continuation per active module. Unwind records
the exact leaf-to-root activation/function order; fresh-child replay consumes
the reverse order. This supports nested main-to-side-to-side stacks without
assuming that the main activation is present at the leaf. Versioned
fork-instrument capability metadata lets
marker-present artifacts prove their role, and ABI 43 additionally requires
`FORK_CAP_ACTIVATION_STATE_SAFE` before launch. ABI 16 defines the historical
five-export fallback, while ABI 18 and later require role claims and reject
stale call-graph artifacts. The ABI 36 epoch combines that contract with
side-module replay state and concurrent pthread-fork arbitration. Dlopen replay
records both the parent's memory base and exact table base, including null gaps
left by failed loads, then re-instantiates each side module's static element
initialization at that exact base in the child. The process table journal then
applies later loader and guest `table.set`/`fill`/`copy`/`init`/`grow` effects
through typed recipes after every referenced activation catalog is present.
TLS-bearing side modules additionally record their live,
positive `__tls_base`. A child restores the pointer-width-correct mutable
global without calling `__wasm_init_tls`, because copied memory already holds
the parent's live TLS bytes and reinitialization would reset C++ unwinder state
and application `thread_local` values. C++ exceptions and longjmp use one
canonical pointer-width tag identity across the main image and all side
modules; a main-exported tag wins over the host-created fallback.

ABI 43 libc drives dynamic initialization as a non-reentrant transaction.
`__wasm_dlopen_prepare` validates and owns a private transaction without
entering guest code. Each `__wasm_dlopen_next` advances host-only compilation
and instantiation of the `DT_NEEDED` closure as needed. Instrumentation has
removed the native start section and converted active segments plus the
original start function into an explicit bootstrap, so
`new WebAssembly.Instance(...)` cannot run that guest path inside `next`.
The call publishes one canonical initializer table entry and returns; libc
then calls that entry as ordinary Wasm before requesting the next stage. A
constructor that calls `fork()` thus has a normal instrumentable Wasm call
chain rather than a suspended host import beneath it. Before reachability
analysis, the instrumenter turns the
historical two-, four-, and five-argument private `__wasm_dlopen` function
imports into in-place local adapters that prepare the transaction and
tail-call an ordinary Wasm driver for their initializers. This retains all
aliases of the old function without retaining the reentrant host boundary.
The two-argument form retains its original
`dlopen:<buffer-address>:<byte-length>` identity. ABI 43 artifact and launch
validation require both the legacy import and the completed artifact's native
start section to be absent. Valid source modules may contain a start section;
instrumentation transfers it to `wpk_fork_module_bootstrap` before admission.
The lower-level `DynamicLinker.dlopenSync()` driver remains available to
standalone embedders, but it is not a process import.

The kernel cannot replace the process-local half of this protocol. It can own
path authorization, loader scheduling, and replay policy, but the kernel
Worker cannot inject Store-local functions, exception tags, or GC identities
into the process Worker's tables. Core Wasm cannot instantiate arbitrary
runtime module bytes itself, and those JavaScript references are not
structured-clonable between Workers. A kernel syscall would therefore need a
request/yield/resume protocol that still delegates instantiation and catalog
registration to the process Worker; it would relocate, rather than remove, the
boundary. In particular, using the generic syscall import instead of a named
loader import would not itself change reentrancy. The contract is that every
process-local host operation returns before guest initialization begins.

The process worker can issue VFS and mapping requests while a staged loader
import is active, but those JavaScript-owned channel completions cannot invoke
libc's signal trampoline. They set
`REQUEST_FLAG_DEFER_SIGNAL_DELIVERY`, leaving any caught signal in the kernel,
and libc performs an ordinary checkpoint after every `prepare`/`next` return
and after `dlclose`. Constructors still begin only after both the import and
checkpoint return, so signal delivery and dynamic initialization add no
host-to-Wasm reentrancy.

The dlopen replay list and its atomic pthread-fork lock live in a transient,
host-private control record. The same host build writes and reads that record
during one process lifetime; guest code and persisted artifacts never
interpret it. Changing that record's size is therefore not a guest ABI change,
while the public ABI snapshot/classifier remains authoritative.

Pthread workers have separate Wasm instances, tables, and exception tags, so
no JavaScript reference is structured-cloned from the process worker. Each
pthread owns a local dynamic-linker replica. Under the process archive lock it
compares a shared generation, instantiates missing side modules at their exact
bases, registers fresh function/exception catalogs, and applies the typed table
journal. The same mechanism supports `dlopen`/`dlsym` from a pthread and fork
from a pthread after dynamic loading; the fork child reconstructs only the
calling thread but receives the process module/table recipe state. The
generation fast path avoids reparsing or reinstantiating unchanged state.

Fork and non-forking spawn copy each process's descriptor-table shell while
retaining one exact mutable OFD state object. Offset, status flags, and async
owner therefore remain shared across the copies. Directory host iterators are
process-local because their handles and pending records cannot be owned by two
processes safely; a shared position generation makes a stale iterator close,
reopen, and replay at the authoritative cookie before its next read. Stateful
objects additionally retain their kernel-global backings: eventfd counters,
timerfd timers, signalfd masks, memfd contents and cursors, procfs snapshots,
pipes, sockets, PTYs, terminal devices, and listener queues.

PTY readiness is kernel-owned. Master input becoming readable (including
canonical EOF), slave output becoming available, canonical/raw mode changes,
and final endpoint closes set a coalesced notification.
`kernel_take_pty_readiness_changed()` consumes that notification under the
kernel entry gate when retry queues contain parked waiters. Otherwise the
kernel retains it, avoiding an extra export call on syscalls with no waiter.
The shared host drains it alongside the packed wake stream
and reschedules blocked read, poll, select, and epoll retries. PTY queues have
no pipe slot identity, so this notification uses the existing broad readiness
retry path without impersonating a pipe event. Every parked waiter, including
a `ppoll()` or `pselect()` with a temporary signal mask, retries as soon as the
entry scope is revoked. Finite deadlines remain owned by the normal retry
implementation. Host PTY
input schedules its reader wake independently of output callback attachment.

Terminal resize storage and signal routing belong to the shared process table.
`TIOCSWINSZ` compares all four window-size fields and signals live members of
that terminal's foreground process group in its controlling session only when
the value changes. The master setter need not belong to that group. An
unclaimed terminal stores the size without inventing a controlling session.
Host rows/columns resize uses the same routing, retaining its cell-change-only
notification policy. Delivery selects each recipient's actual task and wakes
parked terminal/readiness retries to observe pending signals without adding
input bytes. Source regressions cover routing, masks, no-ops and kernel parks;
normal compiled guest and real Foot/Bash validation remain pending.

### exec()

Every result-bearing target operation runs immediately or refuses a busy
kernel gate without queueing work. After an asynchronous fetch, compilation,
or memory allocation, the shared Node/browser launcher retries this temporary
contention on a later worker turn. A refusal does not allocate or consume a
token and does not retain a read destination. Successful commit and replacement
start still run on the same stack; a consumed token is never retried.

1. A process calls `execve()` or `execveat()`. The centralized kernel worker
   reads the pathname arguments and derives a `diagnosticPath`. For
   `AT_EMPTY_PATH` and relative `execveat()`, path getters may help produce that
   display string. The host may pass it to `preparePath()` as a lazy VFS
   materialization hint. Both uses are diagnostic-only: neither the string, a
   path getter, nor a host program map authorizes the executable.
2. While the old image is live, the same kernel-worker entry calls
   `kernel_exec_target_prepare(pid, caller_tid, dirfd, path, flags)`. Rust
   validates the exact caller and `execveat()` lookup rules, resolves the
   executable from authoritative process/VFS state, checks execute capability,
   and returns an owner-bound one-shot token retaining the exact open file
   description (OFD), bytes, and security metadata.
3. The host queries `kernel_exec_target_size` and copies the retained target
   through bounded `kernel_exec_target_read` calls into only the explicitly
   lent destination. A precommit failure calls `kernel_exec_target_cancel`
   exactly once. Whether the target is a `#!` script, and which interpreter
   and single optional argument it names, is decided by the kernel
   (`kernel_exec_target_admit`) from the bytes the retained target
   committed to; the host parses no program bytes for it. For a shebang, the script token is
   canceled, `argv` is rewritten once from the kernel's answer, and a
   separately prepared interpreter becomes the sole final target; script
   set-ID state is never applied. An interpreter the kernel decodes as itself
   a script fails `ENOEXEC` (one level of `#!`, where Linux allows several).
4. For a program, the same answer judges the exact bytes the kernel retained
   against the ABI-epoch artifact policy (a WebAssembly module, no legacy
   Asyncify, the expected ABI marker); a refusal is `ENOEXEC`. The host then
   runs the one check the kernel does not yet own, the fork-instrumentation
   contract (`describeWasmArtifactPolicyFailures`), obtains the module for
   those same bytes from the kernel worker's
   content-addressed cache (see
   [Compiled module sharing](#compiled-module-sharing)), validates the 4 MiB
   combined argv/environment
   representation and generated vector caps, and completes replacement
   `WebAssembly.Memory` allocation/layout preflight before the irreversible
   transition. Each metadata string must also fit the current 64 KiB transfer.
   Any failure here cancels the token and returns to the old image.
5. Still before commit, the host publishes and flushes writable tracked
   mappings. A failed flush leaves the old mapping trackers and SysV
   attachments in place. Tracked shared mappings retain a lifetime-stable host
   handle independent of the guest fd, so closing that fd does not prevent
   writeback.
6. The asynchronous host callback receives target-derived data but no token or
   commit closure, and returns a bounded replacement-memory launch plan. The
   shared launcher then invokes
   `kernel_exec_commit(pid, caller_tid, opaque_target)` synchronously through
   the same centralized entry and starts the returned postcommit action before
   yielding. Rust consumes the token,
   revalidates the final retained target's exact handle, byte length, bytes,
   metadata, and execute capability, then atomically commits the in-place
   process transition. The process's pointer width is replaced there, from the
   committed bytes, so an exec may switch between wasm32 and wasm64 and the
   host never re-registers it. Commit closes CLOEXEC fds and directory
   streams, resets image-specific state including the program break, and
   preserves the exact
   kernel objects behind surviving descriptors without pathname re-resolution.
   The diagnostic-only path and caller-provided bytes are never commit
   authority.
7. After commit, the host retires the old process and sibling-thread workers,
   detaches old SysV mappings, installs the preflighted replacement memory, and
   starts the replacement Worker. Failure to construct or initialize that
   Worker is fatal because the committed old image cannot return. The host
   parses the replacement's `__heap_base` and registers it so `brk(0)` starts
   above the new data and stack layout. `alarm()`/`ITIMER_REAL` survives, while
   `timer_create()` timers are deleted. The remaining descriptor, signal, and
   mapping gaps are tracked in [posix-status.md](posix-status.md).
8. The new program starts from `_start` with the given argv/envp. The process
   worker holds one immutable UTF-8 snapshot for the complete launch. The CRT
   first queries every entry length with zero destination capacity, verifies
   the generated count, per-entry, and caller-width aggregate limits, and then
   obtains an exact-lifetime anonymous mapping through the ordinary syscall
   channel. Each second call carries that entry's exact capacity and must
   either copy the complete unchanged bytes or return `ERANGE`; allocation
   failure, an invalid guest pointer/range, or a query/copy mismatch traps
   before `_start_c` publishes any argv or environment pointer. The mapping
   remains live because libc's `argv` and `environ` retain those pointers.
   This is guest-process memory, not kernel scratch, and it avoids reserving a
   4 MiB worst-case static buffer in every program.

The `__heap_base` registration in step 7 is required: without it,
`MemoryManager` falls back to a hardcoded 16MB `INITIAL_BRK`, which can land
*inside* the stack region of programs whose data section pushes `__heap_base`
above 16MB (mariadbd's `__heap_base ≈ 16.32MB`). Heap allocations there collide
with shadow-stack frames during C++ static initialization, corrupting memory
and hanging in `__wasm_call_ctors`.

### posix_spawn() (non-forking)

POSIX `posix_spawn` is normally fork+exec done atomically. Our kernel
ships a custom syscall (`SYS_SPAWN = 500`, host-intercepted in
`host/src/kernel-worker.ts`) that builds the child directly — no fork,
no `wpk_fork_*` rewind, no exec replay. This is the fast path popen,
`system`, shell pipelines, nginx-FastCGI, and any direct posix_spawn
caller now take.

1. Glue (`libc/musl-overlay/src/process/wasm32posix/posix_spawn.c`) marshals
   argv + envp + file actions + spawn attrs into a contiguous blob and
   issues `__syscall6(SYS_SPAWN, path, path_len, blob, blob_len,
   &pid_out, 0)`. Wire format documented in
   `docs/plans/2026-05-04-non-forking-posix-spawn-design.md` Section 1.
2. Host (`handleSpawn` in `kernel-worker.ts`) passes the caller's path and
   blob addresses and lengths, unread, to
   `kernel_spawn_process(parent_pid, caller_tid, path_addr, path_len,
   blob_addr, blob_len)`. The kernel copies both out of the caller's memory
   once (`spawn::read_request`), so the host never copies or interprets the
   spawn wire format, and validates argv + envp against the same 4 MiB
   `ARG_MAX` contract as `execve`, counted at the caller's pointer width, plus
   the separate 64 KiB per-entry process-metadata transport limit (an
   implementation ceiling, not `ARG_MAX`). Before anything changes it refuses
   a target a launch could not run (`exec_target::probe_spawn_target`): the
   path from the caller's CWD with execute permission, a WebAssembly or `#!`
   header, and one `#!` level whose interpreter must itself be a program.
   That keeps a failed `posix_spawnp` PATH probe from creating a child or
   running its file actions; it retains nothing and is never launch
   authority. A target whose bytes are still being fetched returns `EAGAIN`
   with nothing changed, and the host retries once the fetch settles. The
   explicit 8,417,320-byte whole-blob ceiling also bounds file-action data
   that `ARG_MAX` does not count. The advertised 4 MiB `ARG_MAX`,
   4,096-byte `PATH_MAX`, and 1,024-entry `IOV_MAX` live in
   `crates/shared/src/lib.rs::platform_limits` and generate the Rust,
   TypeScript, and musl consumers. The same platform module owns the defensive
   4,096-entry process-startup caps; the spawn parser aliases them rather than
   repeating the values. The separate authoritative spawn wire
   contract generates the four-byte string-offset width; every offset in the
   40-byte header and 28-byte action record; the `OPEN`, `CLOSE`, `DUP2`,
   `CHDIR`, and `FCHDIR` opcodes; musl's complete transported spawn-attribute
   byte; the shared argv and environment entry caps; 1,024 actions; and the
   complete ceiling. Transporting an attribute bit does not claim its
   behavior is implemented: the kernel currently interprets `RESETIDS`,
   `SETPGROUP`, `SETSIGDEF`, `SETSIGMASK`, and `SETSID`; `SETSCHEDPARAM`,
   `SETSCHEDULER`, and `USEVFORK` remain unimplemented. The
   argv/environment count caps defend the admitted process representation and
   are not additional POSIX `ARG_MAX` promises. The action count remains a
   spawn-parser limit.
3. The kernel parses the blob (`crates/runtime-core/src/spawn.rs::parse_blob`
   — the trust boundary; bails with EINVAL on any malformed offset),
   validates `caller_tid` as a live task belonging to the parent, and calls
   `ProcessTable::spawn_child_for_caller`. The host reads the child's argv
   and environment back with `kernel_process_metadata_read`.
4. `spawn_child_for_caller` allocates the child PID from the same global task-ID sequence
   used by top-level creation, fork, and clone, then consumes that opaque
   allocation token to build the child Process plus selective inheritance from the
   parent (the complete real/effective/saved uid/gid and supplementary-group
   record, pgid/sid/cwd/umask/rlimits, the calling task's blocked
   signal mask, fd_table + ofd_table +
   sockets via the `bump_inherited_resource_refcounts` helper that
   fork also uses), applies attrs in POSIX order (RESETIDS → SETSID →
   SETPGROUP → SETSIGMASK → SETSIGDEF), so `POSIX_SPAWN_RESETIDS` changes only
   effective IDs to the inherited real IDs and `POSIX_SPAWN_SETSIGMASK`
   replaces the inherited caller mask, then applies file actions once in
   forward order. Failure on any action rolls back via `remove_process`.
5. In the resulting child CWD, descriptor, and credential state, the host asks
   Rust to prepare an exact executable target. The host reads those retained
   bytes, the kernel admits them exactly as for `execve`
   (`kernel_exec_target_admit`), and the host compiles them through the
   content-addressed module cache. The opaque child-bound token is
   committed with `kernel_spawn_exec_commit`, which evaluates set-ID and
   trusted-mount/nosuid policy and closes remaining `FD_CLOEXEC` descriptors.
   Any prepare, read, policy, compile, or commit failure cancels the exact
   target and removes the pending child and its host mirrors without replaying
   file actions or mutating the parent.
6. Only after exact commit does the host's `onSpawn` callback (Node:
   `host/src/node-kernel-worker-entry.ts::handlePosixSpawn`; Browser:
   `host/src/browser-kernel-worker-entry.ts::handlePosixSpawn`)
   receive the target-derived bytes and module and instantiate a fresh Worker
   for the child. Until that callback succeeds, the kernel marks the child as
   an unpublished spawn transaction: it remains signalable and retains real
   exit status, but sibling `waitpid()` calls cannot select or reap it.
   Completion calls the parent-bound `kernel_publish_spawn_child` exactly once
   in the same serialized kernel entry that publishes the spawn result, then
   wakes queued waiters. A child that died during asynchronous target work is
   therefore returned successfully to `posix_spawn()` and becomes a waitable
   zombie only after its PID is published. Ordinary failure removes the hidden
   child and wakes parked waiters to observe `ECHILD`. Existing target commit
   cannot provide this seam because it runs before Worker launch, while
   `kernel_remove_process` is failure-only; neither can atomically change wait
   visibility and return the final disposition after host launch.
   If the parent exits before publication, Rust returns `ECHILD` while retaining
   exact ownership of the hidden child so the same rollback seam removes it
   once; an absent child instead returns `ESRCH` and is never removed again.
   The detached completion enters the serialized kernel directly rather than
   through the parent's mailbox registration, so parent Worker teardown cannot
   drop that final removal. Parent memory is written only after the completion
   separately proves that the exact channel registration is still active.
   The host registers the Worker's memory and channels against the Process the
   kernel already inserted; registration does not create or select the child
   identity. The kernel returns the allocated pid via `pid_out_ptr` only after
   this launch and publication succeed. A parented `proc_event` spawn
   notification remains a separate observer effect.

PATH search lives in libc (`posix_spawnp.c`); the kernel never sees
PATH-relative names.

The implementation is regression-guarded by a per-process counter:
`kernel_get_fork_count(pid)` returns the number of times that pid has
called `kernel_fork_process`. The vitest harness snapshots this monotonic
counter after each guest child-creation event, while the parent still exists,
and asserts every sample is 0. Any non-zero value means the path silently fell
back to fork. Sampling before parent exit is required because the host reaps a
completed top-level process after consuming its exit status.

**Browser parity:**

* `BrowserKernel.getForkCount(pid)` mirrors `NodeKernelHost.getForkCount`
  — round-trips a `get_fork_count` message to the kernel-worker entry,
  which calls `kernel_get_fork_count`. Exposed via the public
  `BrowserKernel` API.
* `BrowserKernel.spawn(...)` accepts an `onStarted(pid)` option for
  capturing the spawned pid before awaiting exit (same shape as
  `NodeKernelHost.spawn`).
* End-to-end Playwright coverage lives in
  `apps/browser-demos/test/demos.spec.ts` ("simple: spawn-smoke uses
  non-forking SYS_SPAWN on browser host"). The simple browser page
  registers `/usr/bin/hello` as a lazy file pointing at `hello.wasm`
  via `BrowserKernel.registerLazyFiles`, then spawns spawn-smoke. The
  test asserts stdout contains `OK` + `Hello from`, exit code 0, and
  `data-fork-count=0` on the page (guardrail mirroring the Node
  vitest assertion).
* The structural source-text test (`host/test/spawn-host-parity.test.ts`)
  remains as a fast-CI tripwire for someone removing one of the
  parallel wires.

### Host-owned top-level process lifecycle

Top-level launches yield during program compilation and memory setup. Each
operation that needs an immediate kernel result retries temporary entry
contention, including process creation, initial working-directory setup,
and terminal setup. A refused operation queues no work. Real errors, such
as a missing working directory, still fail the launch before its guest runs.

Processes launched directly by the Node or browser host, rather than by a guest
parent, are registered as children of the host-parent `ppid=0` sentinel. Their
exit status is consumed by the host's spawn result or exit promise, so there is
no guest process that can call `waitpid()` for them. After the process and
thread workers have terminated and their syscall channels are deactivated, the
host asks Rust to reap the exited `(parent=0, child=pid)` entry. Rust verifies
both the parent relationship and exited state before releasing the executable
process record and wait status. If the process is a group leader with live
members, Rust retains only its resource-free `Limbo` group identity until the
group empties.

This cleanup is intentionally narrower than hiding zombies or reaping every
process during host teardown. A process with a guest parent does not satisfy the
`ppid=0` check and remains an exited zombie until that parent consumes its
status through `wait()`/`waitpid()`.

Children of the virtual init (pid 1) are the one other case: init ignores
SIGCHLD, so the kernel reaps them as they exit, as a Linux init does. They
are the kernel-started Kandelo exchange agent and every orphan adopted as
described next.

The lifecycle exports (`kernel_exec_commit`, `kernel_spawn_exec_commit`,
the exit, signal-exit, thread-exit, removal, reap and blocking-retry release
exports) validate their request and commit it in one synchronous call
(`crates/kernel/src/lifecycle.rs`). Production GL and DRI run synchronously
in the kernel worker, and device cleanup reports its real outcome from
inside the commit (see "DRM/KMS" below), so no lifecycle transition waits on
host work. A process whose prepared exec target has an uncertain native
close is contained instead: every lifecycle request and terminating signal
returns `EBUSY` or stays queued until that target's custody resolves.

Prepared-target cancel proves final regular-file OFD and cross-process
handle ownership before attempting a final host close once. Success creates
exact preclosed custody for normal OFD retirement without a second native
close. An ambiguous error retains the sealed target and OFD; it cannot be
read, retained, committed, retried by raw fd, discarded through process
teardown or mistaken for an absent target. Other executable-release sites
still have ordinary error-retention gaps; this is not a general close
transaction implementation.

### Orphan adoption

POSIX requires that when a process terminates, each of its children,
including children that are already zombies, gets an
implementation-defined system process as its new parent. Kandelo uses
synthetic init, PID 1. Without this, a program that daemonizes with the
usual double fork would leave its grandchild with a parent that no longer
exists. Nothing could ever wait for that grandchild, so once it exited it
would stay a zombie for the life of the machine.

Reparenting is kernel behavior that happens at the Exited transition, not
when the host notices the exit. A process becomes Exited wherever a syscall
or a default signal action ends it, and those code paths hold only that one
`Process`. Recording the exit therefore also queues its PID. The kernel
applies the queue through the whole process table at the boundary of the
outermost kernel scope (the `GklGuard`), both on entry and before the kernel
call returns, once no reference into a single process is still in use. For
each queued exit, in one table transaction, Rust:

1. Gives every child to init (`ppid = 1`). A `posix_spawn` child whose
   result is still unpublished stays with its exact parent, because the
   host's spawn rollback must still find it there.
2. Sends SIGHUP and then SIGCONT to every member of a process group that
   the exit left orphaned while one of its members is stopped. An orphaned
   group is one in which no member's parent is in a different group of the
   same session. Init and the `ppid=0` host-parent sentinel never count as
   such a parent. As in Linux's `exit_notify()`, the groups of the
   reparented children are checked first, then the exiting process's own
   group. A member that the default SIGHUP action terminates queues its own
   exit, which the same pass applies.
3. Reaps, for init, each adopted zombie whose exit the host has already
   published (see below).

An exit that an unguarded export produces is applied when the next guarded
scope begins. Every guest observation of a parent (`getppid()`, `wait()`,
`/proc`) is a guarded syscall, so no guest can see the dead parent.

Only reaping waits for the host. The host discovers a death by finding the
zombie record, then retires the process's Workers, so init must not reap a
zombie before the host has seen it. Every host exit path (normal `exit`,
signal death, Worker crash, exec-handoff death, and a spawn child that exits
before its spawn result is published) goes through one host function, and
that function first calls `kernel_publish_process_exit(pid)`. The call
acknowledges the exit. If init is already `pid`'s parent, init reaps `pid`
now; the host's parent lookup then finds no process, so no SIGCHLD is sent
and no wait is woken. The former parent of an adopted child is never
signalled. The call also returns how many processes applied exits have hung
up since the previous acknowledgement. When that is positive, the host
applies the same follow-up as a guest group `kill()`: it resumes the
continued members, retries their blocked syscalls, and retires any member
that the default SIGHUP action terminated.

Reaping on init's behalf uses the same Rust removal and host-cleanup path as a
`waitpid()` reap, including the resource-free `Limbo` record kept for a
group leader that still has group members. That `Limbo` record is not a
process, so `kernel_get_parent_pid` reports `ESRCH` for it, as
`kernel_get_process_state` does. Only the first acknowledgement of an exit
has effects; a repeat, such as the second arrival for a spawn child that
exited before its spawn result was published, changes nothing. Removing a
process record for any other reason (for example forced teardown) also
reparents that process's remaining children to init.

Host launches follow the same rule. A process launched directly by the host
has the `ppid=0` sentinel as its parent, but its own children are ordinary
orphans when it exits. They are reparented to init rather than to the host,
and the host's `ppid=0` reap still covers only the launched process itself.

`kernel_publish_process_exit` is declared
`optional_until(..., 53, 54)`. An ABI-53 kernel built before this change
lacks both the export and the reparenting; a new host loads it and keeps
the previous behavior rather than failing to boot.

Linux's `PR_SET_CHILD_SUBREAPER` is not implemented. Orphans always go to
init, never to the nearest subreaper ancestor, and `prctl()` fails that
option and `PR_GET_CHILD_SUBREAPER` with `EINVAL`, as Linux did before 3.4.
A supervisor therefore learns that it will not adopt its descendants,
rather than believing it will. The dinit supervisor calls
`PR_SET_CHILD_SUBREAPER` only when built for `__linux__`, which Kandelo
never defines, so its build does not depend on the missing feature.

POSIX has two more orphaned-group rules that Kandelo does not apply yet. A
member of an orphaned group is not stopped by a default-action SIGTSTP,
SIGTTIN, or SIGTTOU, and its background terminal reads and writes fail
with `EIO`. `docs/posix-status.md` lists this gap under `exit()`.

### Owned command families (jobs)

A host can launch a top-level process as an *owned job*: one identifier that
names that process and every descendant it creates. `host/src/owned-jobs.ts`
holds the record, and both kernel workers wire it the same way. `fork`,
`vfork` and `posix_spawn` add the child to the family before the child's
worker launches, so ownership cannot be lost in the gap. `exec`, reparenting
and `setsid` do not remove it.

The record carries a bounded tail of the family's combined stdout and stderr
(256 KiB), the root's exit status, and 64 jobs per kernel at most. Cancelling a
job sends `SIGKILL` to every live member and retries across launch and exec
gaps. `terminationObserved` turns true only after every member has exited, its
process worker has detached, and the remaining family records have been reaped
through the host-owned reap path above. A guest parent inside the family keeps
normal `wait()`/`waitpid()` semantics while the job runs.

A record outlives its family so the host can still read the tail and the exit
status after the command ends. A spawn that fails before its root launches
keeps no record: the start is refused, and the identifier stays free.
Releasing a job forgets the record and frees both the slot and the identifier.
A release is refused while any member is still live, because forgetting a
running family would discard the guarantee that every member really
terminated. The 64-job limit therefore bounds the families a host holds at
once, not the families it may run over a session: a host that runs thousands
of commands releases each one when it is done reading it.

Owned jobs are a host primitive, not a browser feature. `BrowserKernel` and
`NodeKernelHost` both accept `spawnFromVfs(..., { ownedJob })` and both expose
`readOwnedJob(id, offset, limit, cancel)` and `releaseOwnedJob(id)`. The WebMCP
`kandelo_run_command` tool is one consumer; see `docs/webmcp.md`.

### Activity terminal ownership

Browser activity launches allocate a fresh logical PTY and attach the normal
configured login/shell with an owned-job identifier before it can fork.
The shared Node/browser `OwnedJobs` ledger already follows fork, exec and
reparenting; a zero timeout now expresses an interactive family with no
scheduled deadline. Cancellation still drains the entire family, observes
all exits and exact worker detachments, reaps the family and requires explicit
record release. If the original owned login/shell exits, the logical PTY
remains ended instead of restarting an unowned login outside that family.
Replacing an activity closes that dedicated terminal only
after those fences; other terminals remain separate. Raw terminal input is
not a process-control API, so graphical games are cancelled through ownership
rather than simulated Ctrl+C input. No guest ABI or syscall changed.

### clone() (threads)

1. User calls `clone(CLONE_VM | CLONE_THREAD, ...)` → kernel returns clone request
2. Host asks the kernel to reserve one dynamic pthread control slot in the same process address space
3. Host grows the process `WebAssembly.Memory` only far enough to cover that slot
4. Host spawns a new worker that shares the parent's `WebAssembly.Memory`
5. Thread worker runs `centralizedThreadWorkerMain`, calls `__wasm_thread_init` to set up TLS
6. Thread starts executing the given function pointer with the given argument

Threads share memory with the parent (CLONE_VM) but have their own channel, fork-save scratch page, and TLS/control page.

### Compiled module sharing

Every program a process runs is a `WebAssembly.Module` compiled by the
dedicated kernel worker and posted to the process worker (and, for threads,
to each thread worker). V8 and JavaScriptCore keep one copy of a module's
machine code however many workers it is posted to, while each separate
compilation of the same bytes makes another copy (measurements below;
SpiderMonkey was not measured). Compiled code is the dominant browser
cost for large guests — SpiderMonkey caps all JIT and Wasm code at 2 GiB per
content process — so the kernel worker compiles a given program once while a
compiled copy is still alive.

`WasmModuleCache` (`host/src/wasm-module-cache.ts`) is that compiler. One
instance belongs to each `CentralizedKernelWorker` (`kernelWorker.wasmModules`)
on both hosts:

| Launch | Module source |
|---|---|
| Host `spawn`/`spawnFromVfs` (top-level) | `programModule(bytes)`; a `CompileError` answers the request with `ENOEXEC` |
| `posix_spawn` final target | `programModule(bytes)` |
| `execve`/`execveat` | `programModule(bytes)` |
| `fork`/`vfork` | the parent's module; a fork never compiles |
| `clone` | `threadModule(programBytes, patchWasmForThread)` |

**Identity is the exact bytes.** The key is the SHA-256 digest and byte
length of the bytes being launched, plus the variant (`program` or `thread`),
never a path. Exec and spawn read the target's current bytes from the kernel
for every launch, so a file rewritten in place hashes differently at its next
exec and can never run a module compiled from older contents. The thread
variant is keyed on the *program's* digest; `patchWasmForThread` is a pure
function of those bytes. When the patch leaves the bytes unchanged (a module
without a start section), the thread module is the program module itself.

**Admission is never skipped.** The cache replaces only the compile step.
The ABI marker and artifact-policy checks still run on every launch's bytes
before the lookup, exec permission and set-ID policy are still decided by the
kernel's prepared target, and the process worker still re-runs the artifact
policy and fork-instrumentation validation on the module it is given. A
compile failure is reported to every caller waiting on it and is never
cached.

**Lifetime.** The cache's own index holds each module through a `WeakRef`.
Strong references belong to the users: each process record's
`programModule`, the per-process thread module, and launch continuations in
flight. A module is therefore shareable exactly while some live process
or pending launch holds it and becomes collectable with its last user. Two
launches of the same bytes that overlap share one in-flight compilation.

On top of that a bounded retention window keeps recently launched modules
strongly referenced: at most 16 MiB of Wasm bytes in total, each for 30
seconds after its most recent launch, least recently launched evicted first.
Modules larger than the bound (Quickshell at 75 MB, Waybar at 51 MB,
qtgallery at 23 MB) are never retained past their last user. The window exists
because weak references alone lose short-lived programs to the garbage
collector between runs: a shell running coreutils `ls` 20 times compiled
coreutils 10–13 times with weak references only, and once with the window
(Node 24, measured). The bound keeps the retained code small next to the
2 GiB SpiderMonkey arena; the timer never keeps a Node kernel worker alive.

**Cost.** Each spawn or exec hashes its target bytes with WebCrypto SHA-256
in the kernel worker. A thread lookup reuses the digest recorded for the
process's own bytes buffer. Hashing 78 MB took 33–42 ms on Node 24, and
34 ms in Chromium and 53 ms in WebKit inside a dedicated worker. That is less
than the JavaScript byte-by-byte comparison it replaced on the spawn path
(67–294 ms, 68 ms and 59 ms for the same bytes).

An 11 MB synthetic module posted to 8 workers that each instantiated it
and ran every function grew the process by about 140 MB on Node 24, 365 MB
in Chromium and 820–906 MB in WebKit; when each worker compiled the same
bytes itself, the growth was about 335 MB, 540 MB and 1,070 MB.

`NodeKernelHost.getWasmModuleCacheStats()` and
`BrowserKernel.getWasmModuleCacheStats()` return the cache's counters
(compilations, reuse, digest time, retained bytes, and the thread-module
compilations and reuse counted separately) for diagnostics.
`apps/browser-demos/test/wasm-module-cache-threads.spec.ts` uses them to check
in a real browser that three processes running the same threaded program
compile one thread module between them.

## Memory Layout

Each process has a WebAssembly linear memory (shared, up to 1GB by default). The host does not instantiate that memory at the maximum size. It creates the memory large enough for the wasm import minimum plus the main-thread control pages, then grows it after successful guest allocation syscalls or after dynamically reserving a pthread control slot.

```
Address           Region
0x00000000        Wasm data segment (globals, static data)
0x00110000        Global base (--global-base=1114112)
__heap_base       First linker-free byte exported by the program
control_base      Host-owned low control slab
                  - main page 0: fork-save/scratch
                  - main page 1: syscall channel primary page
                  - main page 2: syscall channel spill page
control_end       End of host-owned control slab
brk_base          Initial brk; brk(0) returns this address
mmap_base         First automatic mmap address; normally equals brk_base
...               Guest-managed brk/mmap address space, with dynamic
                  host-reserved pthread slots interleaved as needed
                  - slot page 0: TLS/control
                  - slot page 1: fork-save/scratch
                  - slot page 2: syscall channel primary page
                  - slot page 3: syscall channel spill page
...
MAX_PAGES         End of memory (1GB default)
```

For current binaries, `control_base` is page-aligned from the larger of the imported-memory minimum and the program's `__heap_base`. The host installs only the main control pages before `_start` can run, then calls `kernel_set_brk_base(pid, control_end)` and `kernel_set_mmap_base(pid, control_end)`. `__heap_base` is therefore treated as "first byte available to the host layout" rather than the value returned by guest `brk(0)`.

The Rust ABI declaration in `crates/shared/src/lib.rs` is the source of truth for this layout and is mirrored into `abi/snapshot.json` plus generated TypeScript constants. The main control area uses three Wasm pages: fork-save/scratch, syscall channel primary, and syscall channel spill. Each pthread slot is four Wasm pages addressed from the slot start: TLS/control, per-thread fork-save/scratch, syscall channel primary, and syscall channel spill. Pthread workers share the process `WebAssembly.Memory`; the host gives each worker a distinct dynamically reserved slot and returns the slot to that process's allocator after thread exit.

Processes may export `__wasm_posix_thread_slots` to declare their maximum concurrent pthread count. A value of `-1` uses the host default, `0` allows no pthreads, and a positive value sets the exact per-process limit. The kernel worker creation options expose `defaultThreadSlots` for the `-1`/missing-export case. The built-in default is 1024: an intentionally arbitrary high limit meant to avoid pthread availability problems for most programs now that slots are reserved on demand. Hosts can lower or raise it with `defaultThreadSlots` when they need a different resource policy. This limit is a resource-control guard, not a static memory reservation.

`mmap` remains coherent because the kernel has one per-process address-space model for brk, mmap, and host-reserved dynamic control ranges. Automatic `mmap` starts at the process's `mmap_base`, not at the legacy fixed 64MB floor. A usable non-fixed address hint is preferred after rounding it down to the 64KB Wasm page boundary; an occupied or invalid hint falls back to the ordinary first-fit search. `brk` growth succeeds only when the adjacent range is free; if an mmap region or host-reserved pthread slot occupies the next pages, `brk` fails by returning the old break. `MAP_FIXED`, `munmap`, and `mremap` growth are rejected when they would overlap the reserved prefix, legacy host-control range, or a host-reserved pthread slot. `munmap` rounds its length up to a Wasm page before updating both kernel mappings and host-owned bindings. The host grows the process `WebAssembly.Memory` after successful brk/mmap/mremap syscalls and after dynamic pthread-slot reservations so returned guest addresses are backed before user code touches them.

### Shared mapping coherence

Different processes have different WebAssembly memories, so a pointer store in
one process cannot immediately mutate another process's linear memory. Kandelo
coordinates anonymous `MAP_SHARED`, SysV SHM attachments, and regular-file
`MAP_SHARED` mappings at guest-to-kernel syscall boundaries. For each mapping,
the owner of the bytes compares process memory with the snapshot that process
last observed, merges only changed byte runs into one authoritative backing,
and then imports peer updates into every stale alias in the calling process.
For files the kernel owns, the comparison happens when the mapping can be
observed rather than at every boundary of its own process; see below.
Fork force-publishes the parent before the child inherits the same backing;
`exec`, exit, crash, `munmap`, `mremap`, and `MAP_FIXED` update backing
ownership explicitly.

Who keeps a mapping coherent follows who owns its bytes. The host keeps
anonymous regions and files on host-mounted directories
(`host/src/kernel-worker.ts`). The kernel keeps SysV segments and every file
it owns — the rootfs, the tmpfs scratch mounts including `/dev/shm`, and
memfds — in `SharedMappingTable` (`crates/runtime-core/src/memory.rs`),
which the host drives through `kernel_shared_mapping_*` entry points at the
same points it publishes its own mappings: after `mmap`, at `msync`,
`munmap`, `mremap` and `mprotect`, at the syscall boundaries of a process
that holds such a mapping, across `fork`, and at `exec` and teardown. A
kernel-owned file needs neither a retained host handle nor a per-syscall
cache policy: the kernel pins the inode for its mappings, observes
descriptor writes through a content generation its filesystem advances on
every write and truncation, and writes each publication through to the file.

The other direction, mapped stores reaching descriptor I/O, needs a fence.
A process's stores sit in its own linear memory until something publishes
them, so before any syscall reads or writes a kernel-owned file's content
the kernel *pulls* every writable mapping of that file: it compares each
process's bytes with its snapshot and merges the changed runs into the
file, without writing any process's memory. The pull is publish-only on
purpose. The pulled process may be running on another thread, and writing
its memory back could overwrite a store it made between the read and the
write. One classifier, `descriptor_fence_for` in
`crates/runtime-core/src/memory.rs`, lists the syscalls that touch file
content (`read`/`pread`/`readv`/`preadv`, `write`/`pwrite`/`writev`/`pwritev`,
`sendfile`, `splice` and `copy_file_range` on both descriptors, `ftruncate`,
`fallocate`). `kernel_handle_channel` runs the fence before dispatch and
before any `&mut Process` borrow, for the raw and record transports alike,
and so also before the `pread` that fills a `MAP_PRIVATE` copy. `fsync`,
`fdatasync` and `truncate` fence inside their exports because the host calls
those exports directly too. Operations that name the file by path rather
than descriptor (`truncate`, an `O_TRUNC` open, an exec or spawn target, and
the host's `kernel_rootfs_read_file`, `kernel_rootfs_inspect_read_file`,
`kernel_rootfs_write_file` and filesystem exports) fence every mapped file
instead of resolving the path before dispatch; nothing is done when no
kernel-owned file is mapped. `host/test/descriptor-fence-contract.test.ts`
keeps the classifier's list in step with the host's own list for
host-mounted files. A publication the file refuses fails the descriptor
operation with `EIO`, as the host's `flushSharedBackingForFd` does. Without
the fence a sole writer's store was invisible to `read()` until `msync`,
`munmap`, `exec` or exit, and a later `pwrite` or `ftruncate` could be
overwritten by that store when it was finally published.

Only the process whose syscall is being handled has its memory written,
and then only where the file changed under it. A new mapping joining a
file pulls the existing mappings (it used to publish *and* refresh each of
them, writing the whole range back into processes that might be running),
and a refresh at a process's own boundary writes only the byte runs where
the file differs from the bytes that process last published or imported
(runs closer than 32 bytes are joined into one write). A whole-range write
could otherwise overwrite a store a sibling thread made, after the
comparison read it, to bytes no peer had changed.

Each pull also records *when* it saw a mapping's bytes, so a later pull
can prove a comparison redundant (`CleanStamp` in
`crates/runtime-core/src/memory.rs`). The host keeps a mutation epoch per
process memory and changes it whenever guest code may run on that memory
or the host writes it: a published or materialized syscall completion, a
registered process, an attached thread channel, a kernel-published wait
completion, and every `host_proc_write_bytes`. The required kernel-host
import `host_proc_quiescent_epoch(pid) -> i64` answers that epoch only
while every thread channel of the process sits at `CH_PENDING` and no
vfork child borrows its memory, and -1 otherwise. A thread at `CH_PENDING`
runs only the syscall glue's wait loop, which stores nothing inside a
mapping, and a new thread's channel is zeroed (idle) and attached before
its Worker is created, so a process that reports an epoch has no guest
code running. A pull that read a mapping at epoch `e`, and finds the
process quiescent at the same `e` with no kernel write into the range
since (`KernelProcessWriteLog`), would read the same bytes again, so the
comparison is skipped. Host writes into guest memory are covered: a
completion's output bytes, and anything a host-handled syscall stores
directly into guest buffers, land before the completion is materialized,
which changes the epoch even while a stopped process's completion stays
parked; refreshes of host-owned shared mappings and DRI buffer bindings
write only those mappings' own address ranges, and an address range
belongs to one mapping at a time (`MAP_FIXED` replaces by unmapping first).
A kernel built with the `shared-mapping-proof-verify` cargo feature
compares anyway, traps on a contradicted proof, and counts confirmed
proofs in the diagnostic export `kernel_shared_mapping_proofs_verified`.

When a kernel-owned file refuses a mapping's bytes (for example a full
tmpfs), the loss is real data the program believed it stored, so it is
never quiet. The dirty pages stay on the backing for a later attempt, the
loss is recorded in `/proc/kandelo/writeback_losses`, and it is reported to
the program the way Linux reports a writeback error (errseq): once to every
open file description of the file that existed when it happened, from its
next `fsync`, `fdatasync` or `close`, and once to every mapping of the file,
from its next `msync` (`writeback_loss::note_file_writeback_error`,
`SharedMappingTable::take_writeback_error`). A description opened later does
not see it. The mapping layer's other two inconsistencies, releasing a file
pin that no backing held and a publication pass reaching a live process
without its memory length, can only come from Kandelo's own bookkeeping,
never from a file or a program, so they are fatal kernel faults
(`writeback_loss::shared_mapping_fault`): continuing would free a file under
a live mapping, leak it, or silently skip a process's `MAP_SHARED`
coherence. Mappings of host-mounted files are kept by the host
(`host/src/kernel-worker.ts`) and report a failed writeback the same way, on
Node and in the browser: the host marks every mapping of the file (its next
`msync` answers `EIO` once) and calls `kernel_report_host_mapping_writeback_error`,
which records the loss and marks the file's open descriptions, identified by
`host_fstat` device and inode as for locks
(`writeback_loss::note_host_file_writeback_error`). A descriptor whose own
syscall already fails with `EIO` because of that writeback is not told twice.

A failed kernel-owned synchronization is not successful boundary completion.
Entry failure prevents syscall dispatch and follows the existing recoverable
`EIO` completion path. If synchronization fails after completion output bytes
were applied, those effects remain visible and the channel reports `EIO`;
there is no rollback or syscall replay. Raw error completion makes one contained
synchronization retry, whose ordinary failure is caught before publication.

Host-file mappings add a backend-qualified stable identity and retain the
original fd's host handle for the mapping lifetime. Identity is derived and
revalidated through that live handle, never by reopening its remembered path.
Node uses native device/inode identity; VFS backends scope device/inode identity
to the handle's backend object, so hard links and the same backend mounted at
more than one path alias correctly without colliding with a different backend.
OPFS assigns session-scoped inode tokens in its worker and uses
`FileSystemHandle.isSameEntry()` to unify simultaneous opens. The token remains
attached to a live file object across rename and unlink, while unlink followed
by recreation receives a different token. OPFS stat transport carries device
and inode as integer `u64` values rather than JavaScript `number`/float64.
Dirty mapped data is published before
direct file reads or writes and before a private mapping takes its snapshot;
successful direct writes, truncation, allocation, splice, and copy operations
invalidate or refresh mapped cache pages. `msync`, replacement, unmap, exec,
and process teardown persist dirty pages through the stable handle, including
after the original guest fd is closed or its pathname is unlinked or renamed.

Kernel-owned file mappings are *pulled lazily*. A compositor maps each
client's `wl_shm` pool `PROT_READ|PROT_WRITE`, and comparing every
writable mapping at both boundaries of every syscall cost labwc and sway
with one 4 MiB SFWBar pool about 3,000 whole-pool comparisons a second
during pointer motion, every one equal (6.5 ms of kernel-worker time per
frame after an earlier completion-only skip). A process's own copy is
therefore not compared at its own boundaries any more; it is compared
when something can observe it (`sync_file_at_completion` in
`crates/runtime-core/src/memory.rs`):

- at the *completion* of a syscall of another process that maps the same
  file, which then imports what it published before it resumes. This is
  where every cross-process happens-before edge ends: a process learns of
  a peer's store only through the kernel (a pipe or socket byte, a signal,
  an exit status, a lock, a file write), every such chain begins with a
  syscall the writer made after storing (its `CH_PENDING` store is
  sequentially consistent, so a read of its memory that sees it parked
  sees the store), and ends at the syscall of the reader that consumes
  it. A writer that never makes another syscall is still observed, at the
  reader's next completion. Nothing is needed at an entry: the reader has
  learned nothing new there;
- before the kernel reads or writes the file's content through a
  descriptor (the fence above), when a new mapping joins the file, and at
  `msync`, `munmap`, `mremap`, `MAP_FIXED`, fork, the exec preflight, exit
  (the exit syscall publishes the process's file mappings before its
  memory goes away) and teardown;
- at its own completion only when it holds a second mapping of the same
  file, or when the mapping is about to be refreshed, so that its pending
  stores (including a syscall's output into the mapping) win their bytes.

A pull of a process the host proves has not run since its previous pull
is skipped (the `CleanStamp` proof above), so an idle client costs a busy
compositor nothing, and a client's pool is compared at most once for each
time the client ran guest code. A kernel built with the
`shared-mapping-proof-verify` feature keeps comparing and traps if any
proof is contradicted; it is the evidence that every epoch event is
accounted for, run over the mapping tests and a desktop session. The host
passes `force = 3` (`ENTRY`) to `kernel_shared_mapping_sync_process` at an
entry, which does SysV work only, and `0` (`COMPLETION`) at a completion;
the retired `2` is read as a completion. Host-owned mappings (anonymous
`MAP_SHARED`, host-mounted files) and SysV attachments keep comparing at
both boundaries.

This is syscall-boundary coherence, not shared physical memory. A process that
only performs direct loads/stores does not import peer changes until one of its
syscalls completes; for kernel-owned files its own stores reach a peer at the
peer's next completion without a syscall of its own, and for host-owned
mappings and SysV attachments only at its next syscall. Futex waits and wakes also target the caller's own
process `SharedArrayBuffer`, so process-shared pthread mutexes/futexes remain
unsupported across PIDs. In-kernel memfd shared mappings converge the same
way, backed by the memfd's kernel pages. File mappings on any backend that
cannot provide stable identity return `ENOTSUP`; `MAP_PRIVATE` is unaffected.
File bytes past the current EOF are zero-filled or discarded on refresh/writeback rather than
raising Linux's `SIGBUS`, and writes made outside Kandelo's file syscall paths
are not detected. Large wasm32 snapshot comparisons use safe eight-byte chunks and an exact
byte tail; native and smaller comparisons retain slice equality. Host changed-run
merging can skip equal aligned words, but still publishes only individually
changed bytes. These comparisons do not add dirty-store tracking or omit any
publication boundary, alias or final writer. The boundary scans are on the
syscall hot path; no application performance claim is made without before/after
Node and browser benchmarks.

Every spawn or exec computes a fresh layout from the target binary's memory
import and `__heap_base`; the brk, mmap, control-channel, allocator, and kernel
metadata state is per-process and is reset when ownership changes. Each
generation receives a newly constructed, exactly sized
`WebAssembly.Memory`. Retired process memories are never zeroed and handed to a
later process: shared Wasm memory cannot shrink, engines retain native backing
stores differently, and `Worker.terminate()` is not a portable ownership
fence.

Each allocator record also owns one opaque execution-admission metadata handle,
shared by its explicit alias leases. An exact lease can reserve at most one
writer admission at a time; reservation and exposure advance its admission
epoch before Memory escapes. Cancellation is allowed only before exposure, and
consuming a lease invalidates its outstanding reservation. Tokens retain only
a weak reference to that exact lease, while retained owner handles contain no
Memory, view, lease or allocator-record reference. Fresh allocations have
distinct owners even when a PID survives exec. Bare `lease.memory` access and
injected construction callbacks conservatively mark the owner unknown; forced
termination poisons all aliases. These flags are sticky. Exposure counts are
cumulative diagnostic admissions, not live-writer counts. This metadata does
not prove writer coverage, quiescence or a clean mapping, and does not enable
scan elision. Production worker/host-writer admission and trusted completion
waits still need a source-bound ownership protocol before any such activation.

Normal exit and exec wait for an exact `memory_quiescent` message from every
process Worker and pthread Worker before dropping host aliases. Forced
termination drops the kernel realm's aliases but never makes the backing
eligible for reuse. Whole-host destroy synchronously closes process/pthread
Worker creation admission, waits for every already-admitted async creator to
finish or roll back, then terminates every nested process and pthread Worker.
It finally terminates the containing kernel Worker even if that bounded
graceful detach attempt fails or times out. That realm boundary is the final
release fallback; a false graceful result never asks the main thread to keep a
partially detached kernel Worker alive.

A pthread Worker is terminated when its `memory_quiescent` arrives, except on
JavaScriptCore browsers: there the exited thread's Worker stays idle, holding
its instances, and is terminated with its process (exit, exec, forced
termination or destroy). JavaScriptCore crashes when process memory grows
while another thread destroys an instance of it
([`JSC-SHARED-MEMORY-GROW-INSTANCE-TEARDOWN`](../tests/runtime-workarounds/JSC-SHARED-MEMORY-GROW-INSTANCE-TEARDOWN/entry.md)).
The thread's slot and channel are reclaimed at `memory_quiescent` on every
host.

The allocator applies a hard live-address-space count and samples a live-byte
admission budget before each new allocation. Uninstrumented
`WebAssembly.Memory.grow()` does not call JavaScript, so simultaneous live
memories can grow past the aggregate byte budget until the next allocation
observes their current lengths; each memory's configured maximum remains its
hard growth cap. A truly hard aggregate cap would require reserving every
memory's theoretical maximum or mediating/instrumenting growth.

Recently retired generations contribute to a separate short admission
threshold. Crossing that count or byte threshold pauses later allocations, but
does not reject retirement: one already-grown backing or several already-live
generations exiting together may overshoot it. JavaScript cannot hard-bound
engine-native backing that an engine has not reclaimed. `FinalizationRegistry`
and a coalesced 4 MiB ordinary-allocation pressure hook provide telemetry and
an engine-reclamation nudge only; neither is correctness or capacity
authority. The pressure hook stays enabled because the controlled Node churn
negative control has intermittently retained history-proportional resident
memory when disabled, while enabled runs have reclaimed consistently. Other
disabled runs collected in a later large step. These observations are
engine-specific evidence for the default, not a collection guarantee. The
dated Node, Chromium, Firefox, and WebKit measurements and their limitations
are recorded in
[`docs/measurements/2026-07-28-process-memory-retirement-rss.md`](measurements/2026-07-28-process-memory-retirement-rss.md).

Fork first checks live-memory capacity and the retired-generation count and
byte thresholds synchronously. If retired debt is already saturated, fork
returns `EAGAIN` before constructing or copying another address space. It
cannot wait asynchronously at that point: a sibling thread could mutate the
parent memory while the caller yielded, changing the purported syscall-time
snapshot.

Once admitted, the host captures the parent's current memory length before the
first asynchronous host operation. Node, Chromium and Firefox acquire and
populate a fresh shared backing directly. WebKit captures plain snapshot bytes
first, then constructs the child's shared memory in a disposable worker realm
to avoid synchronous garbage collection stalling the kernel realm. The
allocator charges both the temporary snapshot and the pending child backing
against its sampled byte budget, including concurrent pending allocations.
It rechecks guest growth before publishing a constructed memory. Machine
shutdown cancels pending construction workers before draining process creators.
This preserves the syscall-time snapshot even if a sibling thread execs while
the child Worker is prepared. The child copies the current length, not the
configured maximum, because `memory.size()` and the accessible address-space
boundary are part of the state fork duplicates. Pthread workers
share the owning process memory plus that process's thread allocator. A fork
child does not inherit dead parent pthread slot reservations. Correctness must
not depend on page reloads, context resets, periodic kernel resets, or garbage
collection reclaiming retired shared memories.

### Pthread slots and fork

POSIX `fork()` from a multithreaded process creates a child with exactly one live thread: the caller. The child copies the parent's memory bytes, but the host must not restart or retain every parent pthread worker.

The dynamic slot rules follow that POSIX shape:

- fork from the main thread copies memory and kernel process state but inherits no dynamic pthread slot reservations;
- every fork resolves the caller's linked-frame anchor before allocating the
  child and carries it in a `ForkLaunchRequest`; pthread requests additionally
  carry `fnPtr`, `argPtr`, and the caller's exact slot range;
- after `kernel_fork_process` creates the child kernel process, the host calls `kernel_reserve_host_region_at(childPid, slotStart, slotLen)` to retain only the caller's copied pthread slot;
- the child worker uses the copied pthread fork-save buffer and enters the saved pthread function before `wpk_fork_rewind_begin` replays to the fork call site;
- all other parent pthread slots become ordinary copied memory bytes in the child and may be reused later by child `brk`, `mmap`, or new pthread slots.

Retaining the caller slot instead of migrating its TLS into the main control prefix keeps fork replay simple: `wpk_fork_rewind_begin` restores the saved `__tls_base`, `__stack_pointer`, and other mutable globals exactly as the calling thread wrote them. The cost is one retained 256 KiB address-space reservation for fork-from-pthread children.

### Heap initialization (brk)

The kernel's `MemoryManager` tracks `program_break` per process. On every `spawn` and `exec`, the host parses `__heap_base` from the new program's exports (`extractHeapBase` in `host/src/constants.ts`), computes the low control slab, and calls `kernel_set_brk_base(pid, control_end)` *before* the new worker can issue its first syscall. The new program's first `brk(0)` returns the first guest-managed byte after host control memory, so musl's malloc places the heap above the data, shadow-stack, and host control regions.

The kernel's hardcoded `INITIAL_BRK` (16MB) is a fallback for binaries that don't export `__heap_base`. Programs built with our SDK always export it, so the fallback is rarely used in normal operation. `fork` correctly inherits the parent's brk, mmap base, max address, reserved prefix, and mappings via the kernel's process-state serialization; `exec` resets them (POSIX-correct) and the host installs the new program's computed layout.

## Filesystem

### Who owns what

The kernel owns the machine's filesystem namespace. Every path a guest names
is resolved by the kernel (`resolve_namespace_path_from` in
`crates/runtime-core/src/syscalls.rs`, which follows symlinks and `..` against
the kernel's own metadata) and then dispatched to the authority that serves
it:

| Prefix | Authority | Module |
|--------|-----------|--------|
| `/` (everything not listed below) | in-kernel root filesystem built from the VFS image | `crates/runtime-core/src/rootfs.rs` |
| `/tmp`, `/var/tmp`, `/var/log`, `/var/run`, `/home/maker`, `/root`, `/srv`, `/dev/shm` | in-kernel tmpfs | `crates/runtime-core/src/tmpfs.rs` |
| `/dev` (except `/dev/shm`) | kernel devfs and virtual devices | `crates/runtime-core/src/devfs.rs` |
| `/proc` | kernel procfs | `crates/runtime-core/src/procfs.rs` |
| a host directory mounted beneath `/` | the host, one path component at a time | `crates/runtime-core/src/hostdir.rs` |

Node.js and the browser behave the same: both hosts hand the kernel the boot
image and neither keeps a filesystem of its own for `/` or the scratch
prefixes. The only host-backed mounts left are on Node: `extraMounts` (host
directories), session seed trees, and a scratch mount at a path the tmpfs does
not own; each becomes a `HostFileSystem` routed by `VirtualPlatformIO`
(`host/src/vfs/vfs.ts`). The browser has none. Cross-mount operations
(`rename`, `link`) fail with `EXDEV`.

Because every authority is in the kernel or reached through it, permission
checks, `nosuid`, sticky directories, `O_EXCL`, FIFOs and AF_UNIX socket nodes
behave the same on all of them. Creating, removing, linking or renaming an
entry requires write and search permission on its parent, and a sticky
directory limits removal and rename to the entry's or directory's owner. On
the in-kernel filesystems `fsync` succeeds without host work: they have no
separate durable backing.

Set-ID follows the ordinary POSIX mount model. `/` honours set-user-ID and
set-group-ID bits unless the boot spec declares it `nosuid`; the scratch
mounts are `nosuid`. Image origin, mutability, and first-party status do not
grant or remove authority: root ownership, inode mode, and the mount flag are
authoritative. A custom image's guest root can therefore install, replace, or
create set-ID programs without acquiring any host privilege. One rule is
about the bytes rather than the mount: a deferred file whose bytes nothing
can check loses its set-ID bits when the image is loaded, so a fetched binary
can never become root on the strength of its length alone. A file is
checkable when the image declares its digest or, for a lazy-archive member,
its archive's digest: the kernel refuses an archive whose fetched bytes fail
that digest before extracting any member. The shell image's set-group-ID
`/usr/bin/nethack` is a member of a verified archive.

Guest-visible VFS numbers come from `crates/shared` and are recorded under
`vfs_metadata` in `abi/snapshot.json`. The generated
`host/src/generated/abi.ts` bindings supply open and `*at` flags, descriptor
and `fcntl` values, access modes, statfs flags, file modes, directory-entry
types, seek constants and errno values to the host.

### The in-kernel root filesystem

At boot the worker entry hands the kernel worker the decoded image bytes
(`configureRootfsOverlay`), and `init` calls `kernel_rootfs_load_image`. The
kernel parses the image itself: it mounts the image's KIFS filesystem
(`crates/runtime-core/src/kandelo_image_fs.rs`), walks it, and reads the
image's own description of its deferred files (the in-body `SDEF` section,
`sdef.rs`). An image without that description, one that still carries the
retired `KLZY` section, or one whose metadata declares a different
`kernelAbi`, is refused (`EINVAL` / `EPROTO`), and the boot fails at that
cause; there is no host-side fallback.

The kernel keeps the tree's metadata, every guest change, and every file the
guest creates in its own memory. Unmodified file content stays in the image:
the kernel reads it on demand through `host_image_read`, a positioned window
onto the bytes the worker entry holds (`imageReadFromContainer` in
`host/src/vfs/rootfs-lazy-archives.ts`). Writing to an image-backed file
copies it into kernel memory first.

A deferred file is one the image names but does not carry: a URL-backed lazy
file, or a member of a lazy ZIP archive. The image records its real size, the
URI its bytes live at, and the SHA-256 digest they must hash to. `stat` and
directory listing never fetch. The first read or exec asks the host for the
bytes with `host_fetch_deferred(uri, ...)`; the host fetches the URI through
its lazy transport (`buildRootfsLazyWiring`), answers `EAGAIN` while the fetch
is in flight, and the guest's ordinary retry finishes the read once the bytes
land. The kernel checks an archive's digest before caching any of it, keeps
the archive and each extracted member in kernel memory, and never evicts
them. Archives may be sealed into atomic activation cohorts (`seal.rs`); the
kernel verifies the cohort digests when it loads the image.

If native length or digest validation rejects a deferred body, the read fails
with `EIO` without materializing it. `host_discard_deferred` evicts that
transport body, changes its download progress from complete to error, and
emits a `vfs-integrity` host diagnostic (also visible on the console). This
remains visible even if the guest library handles `EIO` by omitting a font
or other data. No automatic retry follows an integrity failure. A later
explicit read requests `cache: "reload"`; the browser service worker evicts
that exact entry from its own scoped lazy cache and replaces it from the
origin. Node carries the same request through its transport. Content
admission still belongs to Rust's size/digest checks, not the service worker.

Transfer failures preserve their underlying transport cause in the shared
Node/browser progress event rather than flattening HTTP, native size-bound
and network failures into missing bytes. Terminal transport slots keep their
existing bounded EIO policy. The UI retains unresolved errors ahead of active
transfers, including after remount, while successful transfers may fade. A
dismissal acknowledges one observed event sequence; a later failure must be
acknowledged again even if its URL and wall-clock timestamp are unchanged.
A new machine boot clears its predecessor's summaries and visible failures;
old acknowledgements cannot suppress the replacement's errors. This
presentation consumes authoritative download state and never changes VFS
admission or invents a successful desktop state.

Relative URIs are resolved against the deployment at fetch time: the browser
uses `BrowserKernel`'s `lazyUrlBase`, Node the peer
`NodeKernelHost.rootfsLazyUrlBase`. The image itself is never rewritten.
Closed/offline acceptance can bind resolved URLs to exact caller-owned bytes
through the closed-lazy-asset transport
(`host/src/vfs/closed-lazy-assets.ts`), which verifies each declared byte
count and SHA-256 before boot.

The host stages and reads kernel-owned files only through kernel exports
(`kernel_rootfs_read_file`, `kernel_rootfs_write_file`,
`kernel_rootfs_stat_mode`, `kernel_rootfs_unlink_file`,
`kernel_rootfs_mkdir_parents`). Writes, unlink and the browser's TLS root
certificate use these methods. Worker inspection uses
the namespace methods below, including foreign mounts and cross-mount links.

Lazy archive materialization currently supports ZIP. The former TypeScript
filesystem also supported gzip-compressed TAR (`tar-gzip-v1`) deferred
trees, including OCI image layers. That decoder is not implemented by the
native archive reader; unsupported formats fail. Standalone gzip and
zstd were not separate lazy archive decoders. Zstd boot-image decoding
remains supported and is separate from lazy archive activation.

### Filesystem change notifications

`subscribeVfsChanges(prefix, callback)` observes native rootfs and scratch
storage on both hosts. Rust queues a changed canonical path when a writable
file description closes, a name is renamed or unlinked, or the host stages
file bytes. Read-only closes produce no event. With no watchers, this path
allocates no notification records and takes no notification lock.

The kernel retains at most 16 canonical directory prefixes and 256 distinct
pending paths. Repeated changes to one path coalesce into its latest hint.
Overflow invalidates every watched directory so consumers can read its
current state again. The host schedules a fresh gated kernel call on the
next worker turn, copies the records through a scratch lease, and invokes
observers only after that call ends. A pending drain coalesces requests. Observers cannot borrow kernel memory or interrupt a native mutation.
Image tool registration handles both file hints and directory refreshes.

A file description retains the path used to open it. Renaming that file or
replacing its old name can make the stored path stale while the descriptor
still refers to the original inode (the file's identity). On its final
writable close, native storage compares the descriptor's inode with the
inode now named by that path. If a linked file no longer has that name,
the kernel refreshes all watched directories instead of reporting a stale
file path. Closing an inode with no remaining names needs no further hint;
its unlink already reported the directory change. These metadata checks
run only while subscriptions are active.

These hints are not a durable change log. Mapped writes and external changes
to Node foreign mounts are not reported, and an inode modified through a
hard-link name is not reported under every alias. See [WebMCP](webmcp.md)
for the consumer-facing contract.

### Inspection of the live filesystem

Both host workers answer `read_vfs_file`, `read_vfs_dir` and
`stat_vfs_path` through Rust. The native inspection methods use the same
namespace walker as guest syscalls, including symlink resolution across
rootfs, tmpfs and foreign mounts. They use the reserved init record's
root credentials for privileged host inspection; init stays immutable
and acquires no descriptors. A directory snapshot includes each entry's
current mode, size, uid/gid and symlink target. Copied snapshots stream
through allocator-owned scratch within one kernel entry and are freed
at EOF. The main thread receives plain metadata and transferable bytes.
Root listings include the kernel's virtual mounts even when the image omits
them. Procfs/devfs listings share the guest directory enumerators. Numeric
`/proc/<pid>/fd` and `fdinfo` use that process's live descriptors; a fresh
listing reflects descriptor close and process reaping. Exited children remain
visible until their parent reaps them. `/dev/pts` uses live
PTY state, and device aliases report their guest-visible symlink targets.
Guest-owned PTY masters disappear on their final close. Host-created
terminal masters currently stay retained until machine destruction;
process exit closes the guest slave descriptors but not that host master.
`/proc/self`, `/proc/thread-self` and `/dev/fd` refer to the reserved init
inspection record, whose descriptor table stays empty. `/dev/shm` remains
served by tmpfs. This connects directory metadata; it does not add a host
API for reading generated procfs file contents.
The existing `/dev/mqueue` directory provider returns an empty listing.

Node resolves the shell's `kandelo-lazy:programs/...` references and named ZIP
archives through the same image-owned reference grammar used by browser
deployments, then authenticates their package artifacts through the resolver.
Under `source-only-v1`, the emitted projection is the artifact authority;
lazy reads do not regenerate the default policy's mutable registry index.
Node takes the validated rootfs's deduplicated lazy URI cohort after
kernel initialization and gives it to `NodeLazyAssetResolver`. The first
use starts one off-thread freshness checkpoint; successful paths and
per-resource failures stay pinned, and destruction cancels pending work.
Unused resources never start a resolver worker or abort boot. Both
hosts retain bounded retries (three attempts, delays capped at five
seconds) for transient network and HTTP failures; exhausted, permanent
and aborted transfers stay failed. Rust verifies content sizes and
digests after transport and never retries invalid content as a network
failure. The native resource inventory supplies transfer byte bounds: both
hosts reject oversized response headers and stop a stream before retaining
excess chunks. The isolated example runner reads standalone transport sizes
through the zero-import Rust image module without allocating a shared
filesystem buffer.

Lazy progress events identify the resolved transport URL on both hosts,
including deployment mappings and relative URL bases. Their stable transfer
ID retains the image URI; neither progress nor URL mapping mutates the image.

When native length or digest validation rejects a completed download,
`host_discard_deferred` evicts only those transport bytes. The failed read
returns `EIO` without changing the inode or automatically fetching again;
a later explicit read can fetch a fresh response. Stream progress remains
a host transfer observation, independent of native materialization.

### Default mount layout

The canonical layout lives in `host/src/vfs/default-mounts.ts` as
`DEFAULT_MOUNT_SPEC: MountSpec[]`: `/` is the writable image, and `/tmp`,
`/var/tmp`, `/var/log`, `/var/run`, `/home/maker`, `/root` and `/srv` are
scratch mounts. `resolveForBrowser` and `resolveForNode` validate a spec and
return only the host-backed mounts that remain after the kernel's share is
removed. The only image mount a spec may name is `/`. The tmpfs's prefixes,
their root modes and owners (`/tmp` and `/var/tmp` `1777`, `/home/maker`
owned by uid/gid 1000, `/root` `0700`, `/dev/shm` `1777`) and their `nosuid`
come from `SCRATCH_MOUNTS` in `crates/runtime-core/src/tmpfs.rs`, not from the
spec; the spec keeps them for the host side
(`KERNEL_TMPFS_OWNED_PREFIXES` must match that table).

Node may also seed a strict descendant of a host-backed scratch mount through
`NodeKernelHost.sessionSeedTrees`. The worker copies every quiescent source
tree into opaque staging paths using new regular-file inodes and renames the
completed trees into the private session before constructing any
session-owned `HostFileSystem` backend or publishing `ready`. Symlinks,
special files, overlapping destinations, image destinations, and destinations
shadowed by another mount are rejected, and guest changes are never written
back to the source. The kernel learns each host mount's prefix
(`kernel_rootfs_set_foreign_prefixes`) so the rootfs does not claim it, and a
directory handle for its root (`kernel_rootfs_set_foreign_mount_roots`) to
walk from.

### rootfs image as the source of truth

`/etc/passwd`, `/etc/group`, `/etc/hosts`, `/etc/nsswitch.conf`,
`/etc/resolv.conf`, and static OpenSSL policy/trust files under `/etc/ssl` are
real files inside `host/wasm/rootfs.vfs.zst`, served through `/`. Any program
that calls `getpwnam`, `gethostbyname`, `getservbyname`, or OpenSSL's default
configuration/trust lookup reads the same image bytes that `cat` would. The
kernel synthesizes `/etc/mtab` because it reports live mount state; it does
not synthesize static `/etc` policy or trust data.

The rootfs data defines the canonical interactive image account as
`maker` at uid/gid 1000 with home `/home/maker`. Its password hash, wheel
membership, sudoers policy, and login messages are ordinary rootfs files.
The package-built `login`, `sudo-lite`, and `sudo` executables are ordinary
root-owned files in that same image. `login` is embedded because terminal boot
requires it immediately; the two sudo implementations remain lazy and are
materialized on first execution, and the image records their digests so the
set-user-ID transition survives materialization. Their mode is `04755`, so
execution on the root image applies the normal set-user-ID transition. Guest
root may replace those files, just as it may replace any other system
executable.

The reusable browser session layer owns one lifecycle record per logical PTY.
Its program selection comes from the image's strict experimental
`/etc/kandelo/experimental-terminal-session.json` declaration. First-party and
custom images use the same parser and supervisor; the browser does not infer a
login policy from image origin, account contents, or a compiled product
profile.

For an eligible image/product pair, the first process is root-authorized
`login -p -f maker`; every later process is ordinary `login -p`. UI handles
only attach listeners to that record, while the terminal tab's explicit close
action, kernel detach, reboot, and destruction invalidate its process
generation, terminate the active process, and cancel pending restart. Short
processes back off from 250 milliseconds to a five-second cap, a process that
survives two seconds resets the delay, and a replacement launch failure remains
visible in the terminal without automatic retry. Password authentication stays
in the guest program and final VFS credentials rather than React.

VFS images also carry image-level metadata outside the guest file tree. The
first declaration is `kernelAbi`, an exact `ABI_VERSION` requirement for
images that carry ABI-bound Wasm programs; the kernel refuses a mismatched
image when it loads it (`image_policy::check_declared_abi`). Legacy/data-only
images may omit the field.

### Node host

`NodeKernelHost` accepts
`rootfsImage: "default" | ArrayBuffer | Uint8Array | undefined`. With
`"default"` (the path used by the vitest suite), the host reads
`host/wasm/rootfs.vfs.zst`. Whatever the caller supplies, the host zstd-decodes
it (`maybeDecompressImage`, `host/src/vfs/vfs-image-transport.ts`, which bounds
the decompressed size before decoding) and the worker hands the decoded bytes
to the kernel. The image supplies both `/etc/ssl/cert.pem` and
`/etc/ssl/certs/ca-certificates.crt`; Node does not silently add them to
caller-supplied images. Optional `sessionSeedTrees` require a rootfs image and
absolute host source paths; each source must remain quiescent until `init()`
resolves. Graceful destroy, initialization failure, and fatal worker paths
attempt to remove the complete session tree; abrupt process termination
cannot run that best-effort hook, so cleanup is not the ownership proof. New
private inodes and publication-before-`ready` establish ownership.

`imageBuildDeterminism: { seed, epochSeconds }` boots a kernel for an image
builder: `CLOCK_REALTIME` counts up from `epochSeconds`, the guest-visible
monotonic clocks are per-task logical clocks, and `getrandom` and
`/dev/urandom` draw from a stream seeded by `seed`
(`crates/runtime-core/src/image_build_determinism.rs`). Software an image
builder runs then writes the same bytes every time. Seeded entropy is public,
so an image built this way must replace every secret on each machine's first
boot (the WordPress images do, `images/vfs/scripts/wordpress-first-boot.ts`).
The browser host has no way to set it.

`execve`, `execveat` and `posix_spawn` take their executable bytes and
metadata only from the exact target the kernel resolves through the caller's
VFS state; the host has no program map to consult. Tests that name an exec
fixture stage it into an explicit test rootfs before boot. Without a rootfs
image, the worker falls back to raw
`NodePlatformIO` (the host's `/` published as one host mount) — kept for
legacy callers that have not migrated.

The CLI runner's `KANDELO_RUNNER_VFS=isolated` mode snapshots the canonical
rootfs and binds every standalone lazy-file URL to its locally resolved
package artifact. It reads transport hints without constructing a VFS
`SharedArrayBuffer` on the main thread. The worker still restores the image
and validates its inode identities normally; byte bindings supply transport,
not executable authority. The closed transport verifies size and SHA-256 and
rejects unbound URLs instead of fetching from the network. Missing artifacts
or an image/artifact size mismatch fail before boot with a provisioning
diagnostic. This keeps libc, POSIX, and Sortix runs on the same VFS-backed
shell and utility paths as the canonical image, including lazy `/bin/sh`.
The libc harness sets `KANDELO_RUNNER_BUILTINS=explicit`: its helper files
are staged in owned scratch, and its system tools come from the rootfs.
Unrelated optional convenience packages are not probed before each case.
Unexpected test timeouts fail the libc harness command, just as unexpected
exits and build failures do. Expected and classified flaky timeouts retain
their separate result categories.

### Browser host

`BrowserKernel.boot({ vfsImage, ... })` and `initFromImage` take a VFS image
(per-demo `.vfs.zst`, typically built on top of the canonical rootfs as a base
layer). The main thread zstd-decodes it and transfers the bytes to the kernel
worker, which hands them to the kernel; the main thread holds no filesystem.
Once the kernel exists and before any guest process launches, browser
networking writes its generated per-session MITM root to
`/etc/ssl/certs/ca-certificates.crt` through the kernel
(`kernel_rootfs_mkdir_parents` + `kernel_rootfs_write_file`); the image-owned
OpenSSL configuration and compiled-in `/etc/ssl/cert.pem` trust path remain
unchanged. POSIX shared memory (`/dev/shm`) is tmpfs, so the browser host
allocates no shared-memory buffer for it.

### Building images

Images are written by the Rust image writer
(`crates/runtime-core/src/kandelo_image_write.rs`), the same code that defines
the format the kernel reads. TypeScript builders reach it through
`KandeloImageFs` (`images/vfs/lib/kandelo-image-fs.ts`), a wrapper over
`crates/kandelo-image-module`: a zero-import wasm module (it has no import
section at all, which its build script verifies) staged as
`local-binaries/kandelo_image_module32.wasm` by the local build. Node reads it
from there; the browser fetches it once and installs it with
`KandeloImageFs.installModuleBytes`. `VfsImageFilesystem`
(`host/src/vfs/vfs-image-filesystem.ts`) is the interface builders and the
image helpers in `host/src/vfs/image-helpers.ts` are written against.

A builder creates a tree (`KandeloImageFs.create()`), writes files,
directories, symlinks and ownership into it, registers lazy files and lazy
archives with their URIs and digests, and calls `saveImage()`, which returns
a VFSI container the image builder wraps in one zstd frame for `.vfs.zst`
artifacts. `KandeloImageFs.load(image)` reads an image back for derivation.
Publication checks run beside the writer (`crates/runtime-core/src/image_policy.rs`):
an image must keep the runtime headroom its product profile declares, record
the growth ceiling the profile declares, and every Wasm program it carries
must declare the kernel ABI. (The fork-artifact contract for fork-instrumented
programs is still checked by the TypeScript artifact reader in
`host/src/constants.ts`.)

Image builds are reproducible. Files a builder stages without a time are
stamped with Kandelo's reference instant, and builds that run software inside
the image boot their kernel with `imageBuildDeterminism`.

**Kandelo's reference instant.** Whenever a build needs a fixed time, it uses
`KANDELO_REFERENCE_EPOCH_SECONDS` (`crates/shared/src/lib.rs`, mirrored into
`host/src/generated/abi.ts`): 1772944691, the commit time of the first
Kandelo commit (`b44d42a0d7ff`, 2026-03-07T23:38:11-05:00). The image writer
stamps files a builder stages with it unless the caller supplies a time, and
`mkrootfs build` uses `SOURCE_DATE_EPOCH` when set and this value otherwise.
It is not 0 because software reads a timestamp of 0 as "no timestamp": PHP's
opcache refuses to cache a file whose mtime is 0, which silently emptied the
build-time opcache warm-up of the PHP images. Images stay byte-deterministic
because the value never moves. It is a build convention, not part of the
kernel ABI.

Kernel-owned machines expose a durable export through
`NodeKernelHost.exportRootfsImage()` and `BrowserKernel.exportRootfsImage()`.
Export is available only after a VFS-backed kernel has initialized and every
guest process and worker teardown has completed. The owning worker closes a
snapshot gate before its first asynchronous wait, drains host-side mutations
that started earlier, and rejects later spawns, materializing reads, writes,
unlinks, and concurrent exports until serialization settles. The kernel
streams the finished image of its live `/` (`kernel_rootfs_export_container_read`):
the base tree with every guest change reconciled into it, sized to its
contents with the growth ceiling recorded as a number. Scratch mounts are
recreated on the next boot. Deferred files that were never read stay deferred
after export, with their URIs and digests. Callers must await the export
before destroying the host.

The browser demos consume images through `BrowserKernel.boot`; service
demos run dinit (`/sbin/dinit --container`), which reads `/etc/dinit.d/*`
from the image and brings up the service tree, and single-program demos exec
the language interpreter directly. Small test images (the browser test runner,
the Git test) are assembled in a disposable worker with `createBuildFsWithEtc`
in `apps/browser-demos/lib/kernel-owned-boot.ts`, which also merges `/etc/**`
from the canonical rootfs (`images/vfs/lib/rootfs-etc-overlay.ts`).

| Demo | VFS Image | Build Script | Boot pattern |
|------|-----------|-------------|--------------|
| Perl | `perl.vfs.zst` | `build-perl-vfs-image.sh` | `kernel.boot` → `perl` |
| PHP | `php.vfs.zst` | `build-php-vfs-image.sh` | `kernel.boot` → `php` |
| Ruby | `ruby.vfs.zst` | `build-ruby-vfs-image.sh` | `kernel.boot` → `ruby` |
| nginx | `nginx-vfs.vfs.zst` | `build-nginx-vfs-image.sh` | `kernel.boot` → dinit → nginx |
| nginx-php | `nginx-php-vfs.vfs.zst` | `build-nginx-php-vfs-image.sh` | `kernel.boot` → dinit → php-fpm + nginx |
| Redis | `redis.vfs.zst` | `build-redis-vfs-image.sh` | `kernel.boot` → dinit → redis-server |
| MariaDB | `mariadb.vfs.zst` | `build-mariadb-vfs-image.sh` | `kernel.boot` → dinit → mariadb-bootstrap → mariadbd |
| WordPress | `wordpress.vfs.zst` | `build-wp-vfs-image.sh` | `kernel.boot` → dinit → php-fpm + nginx (SQLite WP) |
| LAMP | `lamp.vfs.zst` | `build-lamp-vfs-image.sh` | `kernel.boot` → dinit → mariadb + php-fpm + nginx |
| MariaDB test | `mariadb-test.vfs.zst` | `build-mariadb-test-vfs-image.sh` | `kernel.boot` → dinit → mariadb; mysqltest via `kernel.spawn` |
| Shell | `shell.vfs.zst` | resolver-owned `packages/registry/shell/build-shell.sh` from the reviewed package closure | `kernel.spawnFromVfs` → image-owned Bash |

Build scripts are in `images/vfs/scripts/` and share common helpers
(`vfs-image-helpers.ts` for write primitives and publication checks,
`dinit-image-helpers.ts` for the dinit binary, standard rootfs files and
service files). The Node counterparts of the service demos consume these same
images: they write transient runtime configuration into a private copy of the
image, give it to `NodeKernelHost`, and start `/sbin/dinit` with
`spawnFromVfs()`.

**Binary format.** A `.vfs.zst` file is one zstd frame around a VFSI
container (`crates/runtime-core/src/vfsi_container.rs`). Decompressed:

```
Offset   Size   Field
0        4      Magic: 0x56465349 ("VFSI")
4        4      Version: 1
8        4      Flags: bit 0 = lazy files, bit 1 = lazy archives, bit 2 = metadata,
                bit 3 = typed lazy archives, bit 4 = retired kernel lazy linkage (KLZY)
12       4      Filesystem body length (N)
16       N      KIFS filesystem body (superblock magic "KIFS"); deferred-file
                records live inside it in the SDEF section
16+N     ...    Optional trailing sections, each a 4-byte length and bytes:
                lazy-file JSON (bit 0), lazy-archive JSON (bit 1), image-metadata
                JSON (bit 2), and the retired KLZY section (bit 4, refused at load)
```

### The retired kernel lazy-linkage section ("KLZY")

`KLZY` was a binary copy, in the container, of the two facts in the JSON
sections the kernel needs: a lazy file's real size, and an archive member's
`(archive_id, source_path, size)`. It was written by the TypeScript image
writer, which was deleted on 2026-09-17. Image builders now describe deferred
files with an `SDEF` section in the image body (`crates/runtime-core/src/sdef.rs`),
which carries the same linkage plus each file's address and digest.

The kernel no longer reads `KLZY`. Its decoder was removed on 2026-10-02, and
`rootfs::load_image` refuses an image whose container still carries the
section (header bit 4) with `EINVAL`: such an image can only have been built
before that change, so it is a stale artifact to
rebuild rather than a format to keep reading. The bit and the section's
structural constants (`VFS_IMAGE_KERNEL_LAZY_*` in `crates/program-abi/src/lib.rs`)
remain defined so the refusal can name what it found.

## Networking

IPv4 multicast can also cross local virtual links and remote Kandelo network
sessions. The kernel selects the outgoing interface and owns multicast group
membership, connected-peer/source filters, and local loopback delivery.
Disabling `IP_MULTICAST_LOOP` suppresses the local copy without suppressing
remote transmission. Virtual fabrics exclude the source machine and deliver
one copy per kernel receive domain; a kernel fans out to its matching sockets.
The session's existing bounded datagram transport forwards multicast through
its host, with the same source-ownership checks and group-traffic budget used
for broadcasts. Physical LAN UDP remains a host-backend boundary.

This remains partial IPv4 multicast support. The default interface follows
the active backend, including `10.89.*` sessions; explicit interface-address
validation still recognizes only loopback and the `10.88.*` virtual range.
Bind receivers to the wildcard address: binding a multicast group address
is not implemented. `IP_MULTICAST_TTL` is stored but is not propagated or
enforced by virtual transports. IPv6 multicast remains unsupported.

A network backend may declare `ownsTcpListener(addr)` for a virtual binding.
The host runtime then registers only the virtual listener: separate Kandelo
machines may listen on identical ports without opening or contending for
physical host sockets. Other Node listeners retain the native bridge.

User-visible networking is POSIX-first. Guest programs call normal AF_UNIX, AF_INET, and partial AF_INET6 socket syscalls (`socket`, `bind`, `connect`, `listen`, `accept`, `send`, `recv`, `sendto`, `recvfrom`, `poll`, and `select`). The Rust kernel owns the socket file descriptors, datagram queues, stream listener state, loopback routing, and errno behavior. Host transports plug in below that layer through `NetworkIO`; they are backends, not the userspace-visible abstraction.

### Readiness is a kernel decision; backends report facts

A `NetworkIO` backend never decides whether a socket is readable or
writable. It answers `readiness(handle)` with a
`wasm_posix_shared::net_readiness` fact word — bytes buffered, end of
stream observed, the engine will accept a write, the write half is gone,
the connection is torn down, a sticky error and the errno the engine
observed. `runtime_core::net_readiness::stream_revents` turns those facts
plus the caller's `events` into `poll` `revents`, in one place, for every
backend on both hosts.

The split is deliberate: what an engine alone can see (a socket's
OS-level state, a `fetch` promise's settlement) is a fact; which POLL
bits follow from it is POSIX policy. The rule previously lived in eight
places — the kernel, the `HostIO` default method, four backends, and two
"no `poll` implementation" fallbacks — and the copies disagreed with
POSIX and each other about whether `POLLHUP` is gated by `events`,
whether it may accompany `POLLOUT`, and whether end-of-file is
`POLLIN`.

A backend that cannot observe readiness reports
`NET_READINESS.UNOBSERVABLE` rather than a readiness claim. The kernel's
response is wake-every-round: report the requested `POLLIN`/`POLLOUT` and
let `recv`/`send` answer `EAGAIN`.

The fact vocabulary is generated into `host/src/generated/abi.ts` by
`cargo xtask dump-abi`, so the two sides share one definition.

Backend failures on `send` and `recv` reach the guest as the errno the
backend determined — a Node socket error's `code`, or an explicit POSIX
`errno` — via `negErrno`, with `EIO` for a failure nothing classified.
The transport does not choose an errno on a backend's behalf.

Pipe-backed AF_UNIX and loopback streams use the same half-close contract:
receive EOF is readable and is EPOLLRDHUP when requested. A peer FIN alone
preserves the local write half. EPOLLHUP denotes a full shutdown/hangup,
and EPOLLERR denotes a transport error rather than orderly shutdown.
Forked stream copies consult shared connection-half shutdown state.

Epoll applies Linux-specific socket masks to the common object readiness
facts. It reports requested writable events for immediate shutdown failures,
allows OUT alongside HUP, and reports HUP for an unconnected stream. Unix
sockets and datagrams expose WRBAND; TCP streams do not. Local datagram read
shutdown is IN/RDNORM/RDHUP, and datagram write shutdown alone is not HUP.
Queue-capacity subscriptions are keyed to the receiver's open description;
dequeue, receive shutdown and final receiver closure notify blocked epoll
writers, including write-band-only interests. These rules are distinct from
the POSIX poll policy described above.

AF_INET and AF_INET6 receive queues are currently bounded at 128 datagrams per
socket. Once that fixed internal queue is full, a newly arriving UDP datagram
is dropped and the already-queued datagrams retain their order. `SO_RCVBUF`
requests are stored but do not size this queue; `getsockopt` continues to report
the fixed default capacity. AF_UNIX datagrams use the same bounded storage but
are reliable: a full receive queue makes the send enter the host's blocking
retry path, or returns `EAGAIN` immediately for an `O_NONBLOCK` or
`MSG_DONTWAIT` send, without discarding queued messages. Queue-capacity,
association, shutdown, close, and pathname changes wake blocked writers and
writable readiness waiters so they can observe either capacity or the new
immediate error.

IPv4 limited broadcast (`255.255.255.255`) is permission-gated: a datagram
send without `SO_BROADCAST` fails with `EACCES`. Kandelo does not provide raw
broadcast delivery, so enabling the option only passes that gate; the send then
reaches the active routing/backend boundary. Directed broadcast addresses are
not modeled.

For AF_INET, AF_INET6, and AF_UNIX datagrams, Linux's input `MSG_TRUNC`
extension reports the original datagram length while copying no more than the
supplied buffer. Without `MSG_PEEK`, the datagram is consumed and any uncopied
suffix is discarded; with `MSG_PEEK`, it remains queued. This receive-side
truncation does not weaken AF_UNIX send reliability or its full-queue
backpressure contract above. `recvmsg()` independently reports output
`MSG_TRUNC` whenever the datagram was longer than the supplied payload
capacity; the input flag controls only whether its return value is the copied
prefix length or the full datagram length. `MSG_CMSG_CLOEXEC` installs every
received descriptor with `FD_CLOEXEC`, and that reflected flag is published
atomically with the returned control data.

Loopback addresses are scoped to one Kandelo machine, but not every socket path is machine-wide yet. IPv4 and IPv6 loopback TCP and AF_UNIX streams have explicit cross-process paths. IPv4 loopback unicast and IPv4 multicast have machine-wide cross-process delivery paths. IPv6 loopback datagrams and AF_UNIX datagrams remain process-local. Forked sockets retain their kernel-local bind reservations and local lookup targets, but host-backed UDP endpoint registrations are not yet shared or transferred between processes. AF_INET6 represents `sockaddr_in6`, supports `::`/`::1`, and models dual-stack wildcard stream-port reservation, but it has no external or virtual-network IPv6 transport and no IPv6 multicast delivery. AF_INET6 datagrams therefore report `IPV6_V6ONLY=1`; disabling it fails until dual-stack datagram routing exists.

Routed virtual IPv4 addresses are explicit backend addresses. For example, the browser network lab attaches separate machines to addresses such as `10.88.0.2`, `10.88.0.3`, and `10.88.0.4`; traffic to `127.0.0.1` stays inside one machine, while traffic to those virtual addresses can cross machines through the backend.

### Local Virtual Network

Package-owned [session procedures](package-sessions.md) describe optional
offer setup and participant join forms above the network layer. The browser
discovers their bounded manifests in the machine's VFS, connects an ordinary
network room, and dispatches the declared program as the configured guest
account. Invitations select a locally installed, digest-matched procedure;
they do not carry program code or replace guest socket behavior. Room
ownership remains with the hosting machine. The unified invitation form can
create a room with or without an activity, preserve or replace an existing
room, and leave it. Package-declared dependencies carry bounded content
identities and can be acquired from declared sources, selected locally or
transferred over the separate `activity-data-v1` WebRTC channel. Content is
verified before it is written to the package-declared temporary destination
and the application starts. This channel serves only explicitly published
bytes and is retired with its network connection.

`LocalVirtualNetwork` (`host/src/networking/virtual-network.ts`) is an in-memory `NetworkIO` backend for multiple Kandelo machines in the same JS session. Each machine receives a `VirtualNetworkBackend` with a stable virtual IPv4 address and optional hostnames. The backend delivers UDP datagrams as bounded message queues and creates paired TCP streams for accepted connections. When a machine detaches, its listeners and endpoints are removed. Direct virtual endpoints observe an explicit connection reset; an accepted pipe-bridged endpoint currently maps that reset to EOF/EPIPE because the pipe ABI has no pending-socket-error channel.

Normal TCP close is distinct from that abort path. Bytes queued by the closing endpoint drain before its FIN, and the peer drains those bytes before `recv` reports EOF. The in-kernel loopback and local virtual transports retain an orphaned receive sink that discards later peer sends until the peer closes its own write half; they do not invent a fixed number of successful writes after FIN. The Node backend uses `net.Socket` half-open state and `destroySoon()` so the operating system determines later reset timing after queued bytes and FIN. Explicit receive shutdown remains a refusal path. Enabled `SO_LINGER` is rejected until reset and timed-close modes can be carried coherently through every transport.

This backend is used by `apps/browser-demos/pages/network/`, which boots multiple local machines and verifies UDP datagram delivery with `nc -u`, TCP stream delivery with `nc`, and HTTP over virtual TCP with `curl`.

### Node.js

`TcpNetworkBackend` uses Node.js `net.Socket` for external raw TCP. DNS uses `dns.lookup`. Node can therefore provide real socket-level TCP behavior for destinations outside the Kandelo process.

### Browser

Browsers cannot create external raw TCP or UDP sockets. Local loopback and `LocalVirtualNetwork` sockets work because they are virtual sockets behind the POSIX layer. External browser networking currently uses HTTP-oriented backends:

1. **FetchNetworkBackend**: Buffers an entire HTTP request from the Wasm process, sends it via `fetch()`, and returns the raw HTTP response bytes. Works for simple HTTP clients.

2. **TlsNetworkBackend**: Terminates the guest's TLS connection with a generated, in-VFS CA and sends the decoded HTTP request through browser `fetch()`. Service-worker-controlled apps may proxy cross-origin fetches transparently. Other embedders set `BrowserKernelOptions.corsProxyUrl`; the option crosses the main-thread/worker protocol and routes backend fetches through the application's CORS proxy.

   The shared TLS 1.2 implementation and its upstream NOTICE live in
   `host/src/networking/tls/`, inside the host runtime's source/declaration
   boundary; the host build preserves its NOTICE in
   `dist/networking/tls/NOTICE`. The legacy OpenSSL example worker imports this same source;
   it is not part of the guest OpenSSL C recipe. Fetch and WebCrypto receive
   exact byte ranges with non-shared backing. Private views retain their
   byte offsets; shared views are copied rather than admitted by globally
   widening the platform's WebCrypto types.

   The browser bridge deliberately declines TLS 1.2 session resumption.
   TLS 1.3-capable clients can send a nonempty legacy session ID even without
   an existing Kandelo session. Echoing it after selecting TLS 1.2 would
   falsely claim that the bridge found and resumed a cached session. The
   bridge retains no such master secrets or bounded session cache, so every
   guest connection completes a fresh local handshake. That handshake adds
   no network round trip. Browser `fetch()` owns the separate upstream TLS
   connection and may reuse it independently. Node's direct TCP backend is
   unaffected.

3. **Service Worker HTTP Bridge**: For server demos (nginx, WordPress), a service worker intercepts browser `fetch()` requests to a configurable URL prefix (e.g., `/app/`) and forwards them to the kernel via a MessagePort connection pump. The kernel injects the request as a TCP connection to nginx's listening socket, and nginx's response flows back through the pipe to the service worker.

The preview also supports HTTP servers on the computer's connected Kandelo
network. Both Node and browser `fetchInKernel(port, request, { hostname })`
route an explicit destination through `RemoteSegmentRuntime` and its actual
`SessionNetwork` TCP backend. This path accepts only destinations within the
Kandelo subnet, uses a separate host handle range above the guest i32 ABI,
and closes pending requests on session leave or machine teardown. The shared
client handles short writes, EAGAIN, response limits and a bounded deadline.
Omitting `hostname` preserves the existing local injected-listener path.
The preview service-worker bridge is retired when its destination or machine
is replaced; its ports and event listeners do not retain a retired kernel.

`TcpNetworkBackend`, `FetchNetworkBackend`, `TlsNetworkBackend`, and `LocalVirtualNetwork` share one numeric-address and hostname validator. It accepts decimal one-, two-, three-, and four-component IPv4 forms within their component widths, rejects malformed or overflowing numeric forms, enforces ASCII host-label syntax and DNS length limits, and preserves one trailing root dot. The Node TCP backend resolves validated names through the host resolver. The browser HTTP fetch/TLS bridges synthesize IPv4 mappings for syntactically acceptable DNS names; `LocalVirtualNetwork` resolves only aliases registered by attached machines. None of the browser paths adds browser DNS resolution or AF_INET6 transport.

Each of these internet backends presents itself to the guest as a NAT link of its own, the shape QEMU's user-mode networking gives a guest (`host/src/networking/egress-link.ts`). The guest owns `10.0.2.15/24` on it; every off-link destination is behind the host, and `getsockname` on an internet stream reports `10.0.2.15` with the stream's port, never the host's real address. The browser bridges hand out made-up addresses from `198.18.0.0/15`, the range reserved for benchmarking networks: it is never routed on the internet and cannot overlap a session's `10.89.0.0/24` or a virtual link's subnet, and addresses are assigned in order, so two names never share one. The gateway carries TCP only. A UDP datagram for anywhere beyond the machine fails with `EHOSTUNREACH`, POSIX's "the destination host cannot be reached (... a remote router cannot reach it)": the route exists, and the router on it cannot deliver UDP. It is neither dropped silently nor reported as `ENETUNREACH`, which would deny the route TCP uses. A program that sends UDP beyond the machine sees that error; a Doom LAN server, for example, must run with `-privateserver`, because its internet master-server registration fails and fbdoom stops with a fatal error on a failed send.

WebRTC or proxy-based external transports should attach as additional `NetworkIO` backends behind the same POSIX socket layer rather than adding host-specific socket APIs visible to guest programs.

`RemoteVirtualNetwork` extends the local backend with a worker-owned IPv4
star segment: one `10.89.0.0/24` link whose hosting computer is `10.89.0.1` and
forwards every packet between the computers that join it. A session starts and
ends while machines run. Each kernel worker installs a `SessionNetwork` for the
machine's whole life; without a session it behaves exactly like the backend it
wraps (or like an absent network), and `RemoteSegmentRuntime` attaches and
detaches segments through worker messages. Hosting assigns `10.89.0.1`; joining
waits for the host's directory to assign the next free address. Wildcard UDP
sockets and TCP listeners opened before a session are replayed into it, so a
program that was already listening hears the session. Leaving removes the
address, resets streams that used it, and keeps wildcard sockets for the next
session; when a host leaves, its joiners observe the session ending and why.
Both `NodeKernelHost` and `BrowserKernel` expose `hostRemoteNetwork`,
`joinRemoteNetwork`, `attachRemotePeer`, `leaveRemoteNetwork` and
`remoteNetworkSnapshot`, and transfer native MessagePorts to their dedicated
kernel workers. Address ownership, forwarding, bindings and error decisions stay
in the worker. Paired Node MessagePorts exercise the same segment. Node has no
built-in WebRTC implementation; the RTC adapter is a browser transport boundary.

The browser adapter carries raw unreliable UDP frames and reliable directory
messages through bounded port bridges. Each direction admits at most 128 frames
and one MiB of pending bytes. UDP payloads are bounded by 65,507 bytes and the
negotiated SCTP ceiling minus a 16-byte header. Excess payloads return EMSGSIZE;
full worker-side admission returns EAGAIN. RTC send-buffer pressure may drop
admitted UDP frames. Control congestion closes the connection rather than
silently losing address or binding state. Host forwarding checks ingress source
ownership and the destination link's payload ceiling. Membership is capped at
32 computers, the host included, and 16 UDP bindings and TCP listeners per
computer, which keeps the directory within one 64 KiB control message.

A broadcast to `255.255.255.255` or to the session's `10.89.0.255` reaches
every computer with a wildcard UDP socket on its port, the sender included; a
socket bound to a unicast address does not hear it. A joiner delivers its own
copy and sends one to the host, which delivers to every other member and never
back to the sender. Because the host copies each broadcast up to 31 times, it
meters what each member may originate (a burst of 64, refilled at 64 per
second); excess broadcasts are dropped and counted in the snapshot. The kernel
requires `SO_BROADCAST` for both addresses. IPv4 multicast uses the same
bounded forwarding and shared traffic budget, excluding the source computer;
the kernel owns its optional local loopback and membership filtering.
Multicast does not require `SO_BROADCAST`. External raw UDP delivery remains
outside this segment's contract.

The interface the kernel reports follows the host's assignment. A `NetworkIO`
that reports `localAddress` also reports `localNetmask`, and every
`LocalVirtualNetwork` declares the subnet its link carries. The kernel serves
`SIOCGIFFLAGS`, `SIOCGIFNETMASK` and `SIOCGIFBRDADDR` from that pair, and libc's
`getifaddrs` is built on those ioctls, so a program that enumerates interfaces
sees `eth0` as, for example, `10.89.0.2/24` with broadcast `10.89.0.255` while
joined. Outside a session `eth0` is the internet egress link, `10.0.2.15/24`,
when the host provides one (always in the browser; on Node with
`enableTcpNetwork`), and down with no address when it does not.

ABI 50 adds host-selected UDP source addresses and correct next-datagram
FIONREAD observations, and preserves host EHOSTUNREACH/ENOBUFS errors.
The kernel no longer assumes one demo's IPv4 subnet:
non-loopback binds delegate address ownership to HostIO, and wildcard UDP connect
records the host's real source address for getsockname. AF_UNSPEC disconnect
restores the wildcard observation. Hosts without a routed interface return
ENETUNREACH. Programs and images from earlier ABI epochs must be rebuilt; there
is no stale-artifact compatibility shim.

## Framebuffer (`/dev/fb0`)

The kernel exposes a Linux fbdev surface so unmodified fbdev software (fbDOOM, mplayer-fbdev, etc.) runs without source-level changes.

```
   user process                       kernel                            host
   ─────────────────                  ───────────────                   ────────────
   open("/dev/fb0")     ─────────►   match_virtual_device              (no host call)
                                     CAS FB0_OWNER (single-open)
   ioctl(FBIOGET_*)     ─────────►   fill fb_var_screeninfo /          (no host call)
                                     fb_fix_screeninfo, 640×400 BGRA32
   mmap(fd, len)        ─────────►   memory.mmap_anonymous(len)
                                     record FbBinding(addr,len,w,h)
                                     host.bind_framebuffer(...)  ───►  registry.bind(pid,...)
   *(uint32_t*)px = ... (writes pixels into process Memory SAB —
                         host sees them through the same SAB)
   ioctl(FBIOPAN_DISPLAY) ───────►   no-op success                     (no-op)
```

The guest's mmap pixel buffer lives inside its process's Wasm memory. The
`bind_framebuffer` callback reports `(pid, addr, len, w, h, stride, fmt)` to
the host. Node consumers can read that range directly. In the browser the
kernel worker copies it, on a 16 ms presentation timer, into a fixed-size,
non-growable shared pixel buffer. The UI receives only this display buffer;
it never receives the guest's `WebAssembly.Memory`. The browser canvas reads
the display buffer on `requestAnimationFrame`. Write-based bindings already
send pixel deltas and need no process-memory reference or presentation timer.
There is no additional guest syscall in either path.

This browser ownership boundary matters on WebKit: a shared Wasm memory's
maximum spends reservation capacity even when most pages are unused. A clone
in the persistent UI realm can keep the entire process address space charged
after its Worker terminates, until that realm's collector runs. Independent
pixel storage costs only the framebuffer's actual length and cannot retain a
retired guest address space. `attachCanvas(canvas, registry, pid)` consumes
only this independent storage. It checks existing and newly published
bindings and refuses a missing mirror with a diagnostic, retiring its own
animation callback and registry subscription. It never recovers a guest
memory from the browser proxy. An explicit memory accessor remains available
to a renderer inside the owning realm; browser consumers use the independent
pixel path. Stopping either attachment retires its animation and ownership
subscription. Memory growth requires no UI rebind: the worker
reads the current guest buffer for each copy. Node has no separate browser UI
realm and retains its direct-mapping presentation path.

Cleanup paths (`munmap`, last `close` once unmapped, process exit, `exec`) clear
the binding and call `unbind_framebuffer(pid)`. Every browser framebuffer
message carries the process execution generation. Exit and exec stop the
exact generation's pixel copier and await acknowledgement that the UI removed
its display binding. Delayed messages from an old generation cannot remove or
replace a successor's surface. BrowserKernel no longer exposes a framebuffer
process through `getProcessMemory()`; consumers use `KernelHost`'s framebuffer
handle. `fork` does not auto-bind the child (one mapping per process;
documented limitation).

ABI version bumped 5 → 6 to capture the new `repr(C)` structs `FbBitfield`, `FbVarScreenInfo`, `FbFixScreenInfo`. See `crates/shared/src/lib.rs::fbdev` and `abi/snapshot.json`.

## Mouse input (`/dev/input/mice`)

The kernel exposes a Linux `mousedev` PS/2 surface so unmodified fbdev software (fbDOOM, etc.) gets mouse input from the browser canvas. Direction is reversed vs. fbdev: events flow **host → kernel → process**.

```
   browser main thread                kernel-worker / kernel              user process
   ─────────────────────              ──────────────────────             ─────────────────
   canvas mousemove   ────►  postMessage("mouse_inject")
                             kernel_inject_mouse_event(dx,dy,btn)
                                                   ─────►  mouse::inject_event
                                                           encode 3-byte PS/2 frame
                                                           push to global VecDeque (4096 cap)
                                                                                   ◄────  open("/dev/input/mice", O_RDONLY|O_NONBLOCK)
                                                                                          single-owner via MICE_OWNER (second open from another pid → EBUSY)
                                                                                   ◄────  read(fd, pkt, 3)
                                                           drain bytes from queue
                                                                                   ─────►  decode + apply (e.g. ev_mouse for fbDOOM)
```

The kernel buffers raw 3-byte packets — there is no userspace queue until the process allocates one and tells us about it, and a kernel-side queue lets `read()` complete synchronously without a host round-trip. The buffer is bounded at 4096 packets with whole-packet drop on overflow (≈10s at 400Hz). `poll()` returns `POLLIN` only when bytes are queued; `O_NONBLOCK` reads return `EAGAIN` when empty.

Single-open semantics match real Linux mousedev exclusive-grab. The host inverts browser `deltaY` (browser positive-down → PS/2 positive-up) before injecting, so the kernel queue holds canonical PS/2 sign convention. ABI version bumped 6 → 7 to register the new `kernel_inject_mouse_event(i32, i32, u32) -> ()` export.

Browser input ownership ends on window blur or source shutdown. The evdev
source tracks delivered presses independently of keys queued behind clipboard
negotiation, releases actual held keys before their modifiers, and discards
undelivered queued keys when ownership ends. A keyup for a guest-owned key is
forwarded using its original keycode even outside the capture gate, without
preventing browser behavior. Pointer-down modifier flags are reconciled in the
capture phase before the Modeset pane injects its absolute pointer/button frame.
The pane owns its own button state and releases both its legacy PS/2 and evdev
feeds on cancelled gestures, lost capture, blur, or teardown.

Browser pointer adapters reconcile the complete `buttons` snapshot on motion,
press, release, and KMS re-entry. Overlapping button changes may arrive as
`pointermove` rather than additional down/up events (see the
[Pointer Events button rules](https://www.w3.org/TR/pointerevents3/#chorded-button-interactions)).
A gesture must start on the owned surface before motion can introduce new
presses; hover entry with a button held does not fabricate a click. A zero
snapshot repairs missed releases. The Modeset pane tracks the gesture's pointer
ID so another finger or a hovering mouse cannot clear its button state.
Full snapshots release old buttons before
introducing new presses, and both KMS pointer feeds place motion before the
button edge. Node's translated-event input API and the kernel ABI are unchanged.
The session KMS pointer adapter sends each complete evdev frame through the
existing Node/browser batch transport: position records and their `SYN_REPORT`
first, then changed buttons and their own `SYN_REPORT`. The worker preserves
record order and schedules blocked-reader wake work after each complete frame.
Repeated updates are retained; there is no motion coalescing or frame dropping.
Adapters without the optional batch method send the same records individually.

SDL2's direct evdev backend merges pending keyboard and pointer records by
kernel timestamp, retaining a 32-record read batch per device. Reading all
keyboard records before the pointer could deliver Tab or a modifier before an
earlier click. The event order fix is inside SDL2 and is shared by its Node
and browser consumers; it changes neither device records nor the kernel ABI.

Evdev device state is independent of each reader's bounded event ring. The
kernel retains absolute pointer axes before delivering records, so
`EVIOCGABS(ABS_X/ABS_Y)` returns the current value as well as its range,
including after overflow or when the device was not open. `EVIOCGKEY` likewise
retains held buttons. SDL2's ordinary mouse backend drains stale records after
`SYN_DROPPED`, waits for a report boundary, and restores position and buttons
from these queries. It releases old buttons before introducing new presses.
Relative motion and wheel deltas lost to overflow cannot be reconstructed.
Keyboard and touchscreen recovery are outside this mouse correction. This
uses the existing Linux evdev recovery protocol on both hosts; the syscall
numbers, structures, and ABI version are unchanged.

## Host clipboard (`/dev/kandelo/clipboard`)

Text the user pastes over a machine reaches the guest the way a VM guest agent
(SPICE's `spice-vdagent`) gets it: the host feeds a device, and an agent in the
guest turns it into the desktop's own clipboard. Three layers, each usable
without the next. Copy-out, the reverse direction, runs through the same
device and agent (below).

```text
 browser `paste` event          BrowserInputSource (clipboard feature)
        │  text                   holds the chord + later keys
        ▼
 offerClipboardText(text)      BrowserKernel / NodeKernelHost (same API)
        │                       CRLF → LF, ≤ 1 MiB, never truncated
        ▼
 kernel_clipboard_stage ×N     kernel worker: scratch-sized chunks,
 kernel_clipboard_offer()        one kernel entry, then wake parked readers
        │
        ▼
 /dev/kandelo/clipboard  ──►  kclipd (read one record, block when empty)
        ▲                          │ ext_data_control_v1 set_selection
        │ {seq, status}            ▼
 kernel_clipboard_ack(seq) ◄── write(ack)   wlcompositor selection → foot
   (host timer, only while pending)
```

- **The device** (`crates/runtime-core/src/clipboard.rs`) holds at most one
  unread offer; a newer one replaces it, and a record already being read is
  finished first. Each offer reads as one record — a 16-byte header and the
  UTF-8 text — and a `read()` never crosses into the next record. An empty
  device returns `EAGAIN`, which parks a blocking reader until the next
  offer's wake, as `/dev/dri/card0` does. One process may hold it open, and
  last close or exit drops whatever it had not read. The state is machine-wide
  rather than per open file description, so `fork` carries nothing new. See
  `docs/posix-status.md` for the exact semantics.
- **The host API** (`offerClipboardText`, `host/src/clipboard.ts`) is the same
  on Node and in the browser. It resolves once the agent has acknowledged
  the offer, or with the reason it could not: no agent, over the cap, invalid
  text, the agent's own errno, superseded, or a 2 s timeout. The worker polls
  `kernel_clipboard_ack` every 16 ms while an offer is pending and not
  otherwise, which keeps the syscall completion path untouched. Only the
  paste gesture is browser-only: Node has no DOM `paste` event, the same
  boundary `NodeInputSource` documents.
- **kclipd** (`programs/kclipd.c`, started by `omarchydesktop`) speaks
  `ext_data_control_v1` rather than reading the device inside the compositor,
  so it keeps working when a real Hyprland replaces `wlcompositor`. It serves
  pastes by writing into the pasting client's pipe without blocking, and logs
  sequence numbers and lengths, never the text.
- **The gesture** (`BrowserInputSource`, images that declare the `clipboard`
  runtime feature): a Cmd/Ctrl+V keydown is not cancelled, so the browser's
  own paste binding decides whether it was a paste. If `paste` fires within
  500 ms, its `text/plain` is offered (unless it is empty or the text the guest
  already accepted) and the chord, with every key typed meanwhile, is
  delivered only after the agent's acknowledgement — so "paste, Enter" cannot
  run the line before the text lands. If no `paste` follows, the chord is
  ordinary keys (and Internals logs that). The window is not "until the
  next task": on macOS the page sees the Cmd+V keydown first, and the
  browser fires `paste` from its Edit menu only after the page leaves the
  key unhandled, a task or more later. Playwright's synthetic chord fires
  `paste` in the same task, so automated tests cannot catch a window that
  is too short. Internals also logs each paste's length and outcome. On failure the chord and held keys are dropped (modifier
  transitions still go through) and the KMS pane shows the cause.

The text exists in kernel memory only between the offer and the agent's read;
it is never a file, so it cannot reach a persisted mount or a shared snapshot.

### Copy-out (guest → host)

```text
 copy chord keydown              BrowserInputSource (clipboard feature)
        │  before the chord's keys are emitted
        ▼
 startHostClipboardCopyOut      navigator.clipboard.write(ClipboardItem
        │                         whose text is a pending promise)
        ▼
 waitForGuestClipboardText()    BrowserKernel / NodeKernelHost (same API)
        │                         sample kernel_clipboard_guest_generation,
        │                         poll it every 16 ms for up to 2 s
        ▼
 foot copies → wlcompositor selection → kclipd (ext_data_control_v1)
        │  reads the offer through a pipe, whole, ≤ 1 MiB
        ▼
 write(KIND_GUEST_TEXT record) ─► /dev/kandelo/clipboard: guest text,
                                   generation + 1
        ▼
 kernel_clipboard_guest_read ×N  → UTF-8 text → resolves the promise
```

- **kclipd reports every selection it did not set.** Its own selections
  (host text it installed) are recognised by the source it still holds: the
  compositor cancels that source before announcing any replacement, so a
  selection that arrives while kclipd holds one is its own echo. The rest
  are read as text (`text/plain;charset=utf-8`, then `text/plain`, then
  `UTF8_STRING`) and written as one `KIND_GUEST_TEXT` record in one
  `write()`. A selection over 1 MiB, or with no text type, is not reported:
  never a truncated copy.
- **The device keeps only the latest report** and a generation counter
  that changes with each one. Neither is readable by the guest; the host
  reads them through `kernel_clipboard_guest_generation` and
  `kernel_clipboard_guest_read`, which copies the text out in scratch-sized
  chunks within one kernel entry. Release drops the text, so a copy
  gesture that sees the counter move after the agent has exited reports
  `no-agent` rather than putting an empty string on the host clipboard.
- **The host copies out only after a copy gesture**, never on every
  selection change: a selection made in the desktop is not the user asking
  for their own clipboard to change. The wait samples the generation before
  the chord reaches the guest, so the guest's copy cannot land before the
  host starts watching; a chord that copies nothing (`Ctrl+C` in a
  terminal is SIGINT) times out after 2 s, and the host clipboard is left
  as it was.
- **Why the clipboard write starts at keydown.** Safari and Firefox let a
  page write the clipboard only inside a user gesture, and the guest's text
  arrives well after the keydown handler returns. A `ClipboardItem` whose
  data is a promise is created in the gesture and filled when the text
  arrives; a rejected promise writes nothing. Without `ClipboardItem` the
  text is written with `writeText` once it arrives.
- **Latest copy wins for keyboard copies.** A successful copy-out records
  the text as the one the guest already holds, so the next host paste of
  anything else is offered and the same text is not re-offered.

## Kandelo exchange (`/run/kandelo/exchange`)

Kandelo exchange moves files into and out of a running machine: a dropped or
picked file arrives as an ordinary file a guest program reads, and a file a
guest publishes reaches the host as an output the embedding app decides what
to do with. It is independent of drag and drop; the design is
`docs/superpowers/specs/2026-10-21-kandelo-exchange-design.md`.

```text
 host.exchange.offer(items)       NodeKernelHost / BrowserKernel (same API)
        │  Blobs stay on the main thread; the kernel holds source numbers
        ▼
 kernel_exchange_begin / _add_entry / _commit   one kernel entry, scratch lease
        │
        ▼
 inbox/<batch-id>/…  ◄── consumer holding `events` reads `batch <id>`
        │                 reads files (bytes fetched from the Blob on demand)
        │                 rmdir inbox/<batch-id>  → settled
 work/clone → work/<n>/ ──rename──► outbox/<name>  (frozen, gets an ID)
                                        │ output-published
                                        ▼
 host.exchange.onOutput(listener)  lease until the listener settles and its
                                   streams close, then the kernel removes it
```

- **The filesystem** is a kernel tmpfs mount at `/run/kandelo/exchange`
  (`crates/runtime-core/src/exchange/`), present on every machine that boots
  from a kernel rootfs image: the kernel creates the mount point when it loads
  the image. `statfs` reports `f_type` `0x4B584348` ("KXCH") and the real
  quota. The fixed layout is `events` and `work/clone` (character devices,
  `root:exchange`, 0440), `inbox/` and `outbox/` (0770) and `work/` (0750),
  with the `exchange` group GID 120. The legacy raw host-root Node mode (no
  rootfs image, the host's `/` as the root) has no exchange mount, so its
  paths fail with `ENOENT`.
- **Inputs.** `events` has a single consumer (a second open is `EBUSY`). Its
  first line says whether a host output listener exists (`outputs accepting`
  or `outputs none`), and each committed batch adds `batch <id>`. An empty
  device returns `EAGAIN`, which parks a blocking reader until the next line.
  A batch offered with no consumer waits, and becomes visible when a consumer
  opens `events`. Input files are owned by the consumer with group 120, mode
  0440, and are read-only to everyone (`EPERM` on a write open). Their bytes
  stay in the host's Blob until a read asks for them: the kernel returns
  `EAGAIN`, the worker fetches the range from the main thread, and the read
  is retried. Metadata is extended attributes (`user.kandelo.id`,
  `user.kandelo.source`, `user.mime_type`, `user.xdg.origin.url`,
  `user.kandelo.original_name`, `user.kandelo.index`). Removing the batch
  directory settles the batch with its last `user.kandelo.status`. A source
  is released when no name or open description holds its file any longer;
  the host learns of it after the settlement that caused it.
- **Stream inputs.** A host `ReadableStream` becomes a FIFO in the batch
  (`crates/runtime-core/src/exchange/streams.rs`): `st_size` 0, `lseek`
  ESPIPE, read once. The host holds its writer from the moment the batch
  appears, so opening it never blocks, and no guest may open it for
  writing (EPERM, root included). The host writes only what the 64 KiB
  FIFO has room for and is told of more room as readers drain it, which is
  the backpressure. The end of the host stream is end-of-file; a host
  stream error makes reads fail with EIO once the buffered bytes are read,
  so a truncated input never looks complete. When no name and no reader
  remain, the host cancels its stream.
- **Outputs.** Opening `work/clone` creates a session directory `work/<n>/`
  owned by the opener, removed with everything unpublished in it when the
  description's last reference goes. Renaming a regular file from a session
  to a direct child of `outbox/` publishes it. Publishing fails with `ENXIO`
  without a host output listener, `EBUSY` while anything has the file open or
  mapped, `EEXIST` for a name already in `outbox/`, `ENOSPC` beyond 64
  outputs (or beyond 8 unfinished streams), and `EPERM` for directories and
  symlinks. A published output is frozen (`EPERM` on any change) and gets its
  own `user.kandelo.id`; its `user.kandelo.derived_from` lists the input IDs
  it came from. Unlinking it withdraws it.
- **Streamed outputs.** A FIFO published from a session is read by the host
  once, as it is written. Its writer opens it only after publishing; the
  open blocks until the host starts reading (`O_NONBLOCK`: ENXIO), as for
  any FIFO without a reader. Before closing, the writer declares how it
  ended by setting `user.kandelo.end` once, to `complete` or
  `aborted <reason>`; later writes fail with EPERM. The host's stream closes
  only for `complete`; `aborted` and no declaration at all are errors, so a
  crashed writer never looks finished. If the host's lease ends first,
  writers get EPIPE and SIGPIPE.
- **The host interface** (`host/src/exchange-controller.ts`) is the same on
  Node and in the browser. `offer()` resolves once the batch is visible to
  the guest, or rejects with a reason (`consumer-timeout` after 30 s by
  default, `quota`, `invalid-name`, `aborted`, `failed`); its batch exposes
  `settled`, `released`, status changes and `cancel()`. `onOutput()`
  registers the single output listener for as long as its `AbortSignal` is
  live. An output's lease lasts until the listener's promise settles and
  every stream from `read()` has closed, so an ignored output is released at
  once. A stored output may be read any number of times, by range; a
  streamed one once. Nothing in the platform turns an output into a file or
  a download.
- **Quotas.** `work/` and `outbox/` together hold at most min(256 MiB, a
  quarter of the kernel's maximum memory), because those bytes live in
  kernel memory; past it writes fail with `ENOSPC`. The kernel stages at
  most 16 batches of at most 1,024 entries, 16 directories deep, and 32
  work sessions.
- **Activation.** The kernel starts the image's agent,
  `/usr/libexec/kandelo/exchange-agent`, when a batch waits for a consumer
  and nothing holds `events` (`crates/runtime-core/src/exchange/activation.rs`).
  It checks the path by ordinary resolution and exec permission at every
  offer. It creates the agent's process record itself: a child of init, root
  with no supplementary groups, cwd `/`, its own session, stdio on
  `/dev/null`, environment `PATH` and `KANDELO_EXCHANGE`. The host launches
  it through the same exec-target and Worker path as a `posix_spawn` child.
  The kernel asks for that by queueing an activation-check notification; the
  host answers by calling `kernel_exchange_activate` with the time, which
  returns the pid to launch. The agent is `starting` until it opens `events`
  and `ready` after. Exiting first, or an exec failure, is a failure: the
  kernel backs off 250 ms, doubling to 5 s, and resets once a consumer has
  been ready for 2 s. Init reaps the agent and reports how it ended. With no
  executable at the path and no consumer, an offer fails at once as
  `unavailable`. The embedder option `exchange: { activation: "off" }`
  (default `"on-demand"`) stops the kernel from ever starting it; batches
  then wait for whatever consumer comes. `host.exchange.consumer`,
  `consumerState()` and `onConsumer()` report the state, the activation
  setting and the last failure.
- **Guest userland** (`kandelo-exchange` package, sources in
  `programs/kandelo-exchange/`, part of the base rootfs). `kxchgd` is the
  agent at the agent path. It switches to the account named in
  `/etc/kandelo/exchange.conf` (`user maker`; it must be in the `exchange`
  group, GID 120) before it opens `events`, because batches belong to the
  consumer's credentials as of that open. For each batch it re-reads the
  rules in `/etc/kandelo/exchange-handlers.d/` (owned by the handler
  account) over `/usr/share/kandelo/exchange-handlers.d/` (vendor), merged
  by file name, an empty file masking. A rule owned by anyone else, or that
  others may write, is ignored. The first rule, in file-name order, that
  matches every top-level entry runs in a fresh work session with the batch
  directory as `argv[1]`. Its outcome becomes the batch status (`done`,
  `failed: exit N`, `no handler: NAME`, or the handler's own), and the
  batch is removed. `kxchgd` exits after 60 s idle. The vendor catch-all
  `99-save` (`exchange-save`) copies entries into `~/Downloads`, reads
  streams to end-of-file, and names collisions `name (2).ext`.
  `kandelo-exchange` runs a command in a session, acknowledges batches and
  manages rules; `kandelo-publish` publishes stored and streamed outputs.
  `<kandelo/exchange.h>` spells the paths, attribute names and session and
  publish helpers, and the `attr` package's `getfattr` and `setfattr` let
  shell handlers read and set attributes.

Gated by `host/test/exchange-node.test.ts` with
`programs/exchange-consumer.c`, `host/test/exchange-agent.test.ts` (the
userland), `host/test/exchange-controller.test.ts`,
`host/test/exchange-host.test.ts` and the `exchange` tests in
`crates/runtime-core`.

## Audio output (`/dev/dsp`)

Kandelo separates the Unix compatibility API from its physical audio
transport. OSS is the first frontend; the state below it is an
implementation-neutral, playback-only PCM stream rather than an ALSA or Web
Audio model.

```text
 SDL2 / SDL3 / Unix application
       open, ioctl, write, poll
                 |
          OSS /dev/dsp frontend
                 |
        Kandelo PCM stream core
   format + geometry + monotonic cursors
                 |
       shared bounded PCM transport
          /                    \
 Browser AudioWorklet      Node clocked sink
```

The PCM core owns requested and actual format, sample rate and channel count;
fragment geometry; 64-bit monotonic producer, consumer, and discard positions;
started, stopped, and draining state; reset generation; underrun count; and
write/drain waiters. The OSS frontend translates fixed-width `soundcard.h`
arguments into that model. No Web Audio concept appears in the guest ABI.
Configuration fields are published under a configuring flag and become visible
as one generation. Finishing a drain also advances the generation, so host
resamplers reset their phase before the next logical playback stream.

There is one physical/default playback device and, initially, one exclusive
stream. Ownership belongs to the open file description (OFD): `dup()` and
descriptors inherited through `fork()` share the stream, while a distinct
`open()` returns `EBUSY`. A surviving non-`CLOEXEC` descriptor keeps the same
stream across `exec`. There is no kernel mixer, routing policy, capture stream,
or concatenation of data from unrelated writers.

The transport reserves one 64 KiB PCM ring plus a 128-byte fixed-width control
header in the kernel's shared Wasm memory: 65,664 bytes total. The active queue is latency-sized:
four 1024-byte fragments (4096 bytes) by default, and `SETFRAGMENT` may select
another geometry up to the 64 KiB physical bound. At the default 48 kHz,
stereo S16 configuration, 4096 bytes are about 21.3 ms of queued audio. The
Node's sink receives a descriptor for this same memory. Browser presentation
uses an independent bounded mirror with the same absolute cursors and queue
capacity, as described below. Browser-engine Float32 render buffers are
transient.

Writes form one continuous byte stream and never discard previously queued
audio. Bytes from an incomplete PCM frame remain queued across later writes.
`SYNC` or final OFD close pads only a terminal incomplete frame with format
silence (`0x80` for U8 and zero for S16_LE/S16_BE) before draining; `POST` does
not fabricate padding. A frame-aligned blocking request no larger than the
active capacity waits until the entire request can be accepted, which covers
normal SDL periods. If an earlier unaligned write has left the ring ending in
an incomplete frame, a later blocking write may return the prefix that
completes that frame rather than deadlocking behind bytes the audio clock
cannot yet consume. Larger requests and nonblocking requests may likewise
report partial progress; a nonblocking write with no capacity returns
`EAGAIN`.
`poll(POLLOUT)` becomes ready only when at least one fragment is free. When the
host audio clock advances the consumer position, the kernel reconciles the
monotonic cursors and wakes writers, poll waiters, and drain waiters. Running
out of queued frames is an underrun and produces silence; it does not move the
producer or overwrite old frames.

An explicit final `close()` drains to the audio clock before releasing the
exclusive device. `SNDCTL_DSP_RESET` is the explicit discard operation for an
application that does not want to drain. Exit, `CLOEXEC`, and forced teardown
cannot keep a syscall alive, so a queued tail becomes an orphan drain: the
device remains exclusive until the host consumes that tail, then releases
automatically. This prevents a final buffer from being truncated or joined to
the next opener's stream. Caught signals interrupt a blocked write, `SYNC`, or
explicit final close through the ordinary `EINTR` path. `SA_RESTART` restarts
write and `SYNC`; an interrupted close leaves the descriptor valid for an
explicit caller retry.

In browsers an `AudioWorkletProcessor` consumes and converts PCM in render
quanta (normally 128 output frames), advances the shared consumer cursor, and
emits silence on underrun. The main thread creates/resumes the `AudioContext` and forwards a
MessagePort to its node. The kernel worker sends an independent 65,664-byte
PCM mirror over that connection. Neither browser main nor the persistent
AudioWorklet receives the kernel's shared memory (including the filesystem).
A kernel-worker relay copies newly produced ring bytes and producer metadata
into the mirror, and returns worklet-owned cursor/error publications to the
canonical transport. Seqlocks, generation fences and monotonic discard floors
preserve the single queue's capacity and reset semantics. The relay never
advances playback; the worklet remains its clock. Audio demand reaches the UI
as a plain notification sampled in the kernel worker. Main is not the audio
clock and does not drain through a timer. At 48 kHz one render quantum is about 2.7 ms; browser
device `baseLatency`/`outputLatency` is additional and platform-dependent.
After machine teardown drains the shared ring, a running browser context is
suspended to hand already-rendered blocks to the output device, then retained
for a bounded base/output-latency-plus-quantum settlement interval. Teardown
then tells the processor to release its transport: it drops both memory views,
closes its kernel connection, acknowledges release, and returns false from
rendering. Disconnecting a source processor that keeps returning true leaves
it alive in Web Audio. The independent mirror bounds retained wrappers even
before collection in the persistent worklet realm. The default
page-wide context stays open to avoid WebKit's context-close thread leak;
private contexts supplied by embedders are closed. Teardown never resumes a
suspended or interrupted context, preserving browser user activation.
Node uses the same cursor and wakeup contract with a wall-clock-paced null sink
for headless execution, so callbacks cannot run at CPU speed. Its running tick
follows the negotiated fragment duration, preserves fractional-frame drift,
and falls back to 10 ms polling while idle.

A permanent sink failure is distinct from recoverable browser suspension. The
host latches a shared fatal flag and wakes the kernel: writes and drains fail
with `EIO`, polling reports `POLLERR`, and final close discards the unplayable
tail, releases ownership, and returns `EIO`. If the failure arrives after an
implicit close has orphaned a tail, reconciliation discards that unplayable
tail and releases ownership; no descriptor remains to receive `EIO`. A
suspended or interrupted `AudioContext` does not set that flag; it stops the
consumer clock and applies normal queue backpressure until resume.

The AudioWorklet/shared-ring transport builds on the exploration in PR #698,
while deliberately omitting that experiment's ALSA state machine and
`/dev/snd` ABI. OSS command details are documented in
[POSIX status](posix-status.md#oss-playback-compatibility).

### Measured PCM footprint

The following historical measurements were recorded for the original PR #947
implementation. They compare its clean starting commit
`92d5940f7e0107514ea12ab813d395257678377e` with that branch's ABI 40 result.
They establish the footprint of the audio architecture in that source branch;
they are not a current ABI 43 artifact-size claim. The ABI 43 integration must
be remeasured after its package artifacts are finalized. Compressed sizes use
`zstd -19`; JavaScript totals cover the same ten existing ESM entry files on
both sides, with the new worklet shown separately.

| Artifact | Before raw / compressed | After raw / compressed | Delta |
|---|---:|---:|---:|
| Kernel Wasm | 532,311 / 143,233 B | 612,569 / 147,554 B | +80,258 / +4,321 B |
| Host ESM entries | 3,711,675 / 634,586 B | 3,771,682 / 644,709 B | +60,007 / +10,123 B |
| PCM AudioWorklet | absent | 8,863 / 2,462 B | new |
| `audiotest.wasm` | 30,180 / 13,092 B | 30,365 / 13,183 B | +185 / +91 B |
| `dsp_signal_test.wasm` | absent | 32,355 / 13,890 B | new |

The upstream integration artifacts measure as follows:

| Artifact | Raw / compressed (`zstd -19`) |
|---|---:|
| SDL2 2.32.10 `libSDL2.a` | 1,192,694 / 322,705 B |
| SDL3 3.4.10 `libSDL3.a` | 1,970,446 / 513,937 B |
| SDL2 DSP fixture Wasm | 1,573,606 / 391,329 B |
| SDL3 DSP fixture Wasm | 2,470,559 / 521,937 B |
| SDL_mixer 2.8.2 `playwave` Wasm | 1,800,045 / 434,029 B |

The installed regular-file totals are 3,864,113 bytes for the SDL2 package,
5,545,678 bytes for SDL3, and approximately 4.04 MB for the combined fixture
package. Deterministically staged package archives measured approximately
0.66 MB, 0.95 MB, and 0.70 MB respectively after `zstd -19`; exact published
archives vary slightly with provenance strings. The test-only `playwave`
package contains one 1,800,045-byte regular file; its compressed size is the
434,029-byte value above.

Steady-state transport memory is the fixed 65,664-byte allocation described
above, versus a growable old queue whose maximum occupancy was 262,144 PCM
bytes. The default active queue is 21.333 ms. A normal 128-frame browser
quantum adds 2.667 ms at 48 kHz, for 24 ms of configured software buffering
before platform-specific `baseLatency` and `outputLatency`. Node advances in
the default 256-frame (5.333 ms) fragment cadence against the same 21.333 ms
bounded queue. These are footprint and configured-buffer measurements, not a
throughput or performance claim.

## DRM/KMS (`/dev/dri/card0`, `/dev/dri/renderD128`)

Graphics execution currently remains synchronous on the kernel worker.
The maintainer's revised D-54 requires guest-local GL authority (Stage B),
Rust asynchronous scheduling and fences (C1), executor separation (C2), and
a dedicated GPU worker (C3) in the current baseline. These are planned
changes, not the architecture implemented here. Each stage must preserve
kernel ownership, ordering, mapped-buffer publication and Node/browser
parity. See the [current shipping targets](graphics/compatibility-v1.md#current-shipping-priority-2026-11-03)
and [migration plan](future-improvements.md#move-gl-authority-into-the-guest-library-and-the-rust-kernel-current-iteration).

Kernel BO references, not the host mapping inventory, own DRI pixel
backing. Unmapped PRIME imports and selected cursors retain storage after
the allocator exits. Normal OFD close and process removal share the same
DRI release collector: kernel references retire synchronously, then the
owning adapter drains final BO, framebuffer, GL, and master notifications.
Failed spawn rollback drains those effects too. GEM names and their allocator belong to the DRM open description: dup,
fork, vfork and spawn aliases share one namespace. Each entry owns one BO
reference; final namespace close releases its remaining entries. Fork
settles the deserialized snapshot's duplicate references before publishing
the shared namespace. Spawn adds references only for copied PRIME and
cursor sidecars; GEM and framebuffer tables retain their existing holds.
PRIME reimport returns an existing live handle on the same DRM file.
KMS master, cursor and event inheritance still have separate gaps; see
[graphics compatibility v1](graphics/compatibility-v1.md).

The worker's DRI registry merges changed byte runs relative to a private
snapshot of each mapping. It uses the same merge primitive as anonymous
`MAP_SHARED` publication. Allocator and importer writes both publish at
mapping, readiness, successful receive completion, texture submission,
and cursor/scanout presentation boundaries; unchanged readers do not
overwrite newer bytes. A readiness wake is insufficient when a producer
stores pixels and sends another commit while the consumer is draining its
socket. Successful `read`, `readv`, `recvfrom` and `recvmsg` completions
therefore refresh live imported BO mappings after their output writes land
and before the guest resumes. EOF, failed receives and unrelated calls do
not perform this scan; a process without mapped imports does not copy BOs. Refreshing a
reader also refreshes its snapshot. A pending reader remains eligible for
refresh after the last writer unmaps, exits, or replaces its address space.
Publication scans retain the independent baseline without copying it when
no changed runs are found. A changed publication advances only its copied
runs, using the exact bytes that reached canonical storage, and marks
readers pending. It never rereads the live producer to advance that
baseline: stores made during the scan must remain detectable at the next
publication, including stores to an earlier byte the scan already passed.
Readiness refresh remains unconditional for the
selected BO's mapped readers: mutable canonical pixel views do not provide
an authoritative version that would permit skipping those refreshes.
This remains boundary synchronization,
not live aliasing between Wasm memories. A snapshot is bounded by the
mapping length and BO size and retired with its mapping; backing is retired
only by the kernel's final-reference destroy notification. Partial DRI
`munmap` trims or splits that ownership instead of revoking the whole
mapping. Each surviving fragment retains its canonical BO byte offset and
one kernel reference; fork registers those offsets before priming the
child's memory. A replaced hole no longer participates in device coherence.
Split metadata and additional references are acquired before destructive
cleanup, so reference overflow leaves the mappings unchanged. Pending
reader refresh survives alias retirement, including publications made by
that retirement itself. GPU textures follow the same final destruction
event. All guest mappings and snapshots stay inside disposable workers.
The host bind import includes the canonical offset; it ships with the
matching kernel within the single unpublished ABI 56 / kernel-host 3 epoch.
Fixed anonymous, private-file and new device mappings retire the affected
device interval before the host populates replacement bytes. DRI admission
stages new metadata, flushes the old aliases, then commits clipped views
with their canonical offsets. This preserves dirty storage when the same
BO is remapped through a PRIME descriptor. Allocation or bind rejection
returns temporary references and restores the old allocator and device
bindings; accepted retirement cannot revoke the newly installed view.
Framebuffer and GL command replacements install their new owner after
retiring old device bindings. Device `mremap` shrink retires only its tail through
that same plan, and an unchanged-size remap retains the existing binding.
GEM mappings cannot expand: growth, including `MREMAP_MAYMOVE`, fails with
`EFAULT` without changing the mapping or storage references, following
Linux GEM's fixed-size VMA model. The fixed framebuffer/GL command mappings
also reject expansion. Ordinary moved mappings preserve their protection
and shared-publication metadata. Broader remap flag/partial-file coverage
remains separate work; see the
compatibility ledger.

The host's independent display statistics buffer publishes the current
DRM master PID in slot 8 (zero when unowned), alongside presentation and
scanout counters, and the scanout state in slot 9 (1 while the CRTC scans
out a framebuffer, 0 while it shows nothing). The dedicated kernel worker snapshots this state on
vblank even when no framebuffer is bound. Node stats-only consumers and
browser canvas consumers observe the same owner; no guest memory is
exposed. This is host display metadata, with no kernel/guest ABI change.
Browser presentation uses ownership to hand an exited graphical
application back to its terminal while retaining the display capability
and canvas sizing for subsequent applications.

This section is the implementation walk-through; [Linux-compatible graphics devices](#linux-compatible-graphics-devices) states the device-level contract.

`crates/runtime-core/src/dri/ioctl_kms.rs` (with the device state in `dri/kms.rs`, the commit engine in `dri/atomic.rs` and the buffer registry in `dri/bo.rs`; the shared render-node ioctls stay in `syscalls.rs`) handles DRM_IOCTL_VERSION, GET_CAP, SET_CLIENT_CAP, GET_MAGIC / AUTH_MAGIC, SET_MASTER / DROP_MASTER, MODE_GETRESOURCES, MODE_GETCONNECTOR, MODE_GETENCODER, MODE_GETCRTC, MODE_SETCRTC, MODE_GETPLANERESOURCES, MODE_GETPLANE, MODE_OBJ_GETPROPERTIES, MODE_GETPROPERTY, MODE_GETPROPBLOB, MODE_OBJ_SETPROPERTY / MODE_SETPROPERTY, MODE_CURSOR / CURSOR2, MODE_ADDFB / ADDFB2 / GETFB / GETFB2 / RMFB / CLOSEFB, MODE_DIRTYFB, MODE_GETGAMMA / SETGAMMA, MODE_CREATEPROPBLOB / DESTROYPROPBLOB, GET_UNIQUE, MODE_PAGE_FLIP, MODE_ATOMIC, WAIT_VBLANK, GEM_CLOSE, PRIME_HANDLE_TO_FD / FD_TO_HANDLE, and the dumb-buffer create / map / destroy path. These are the legacy and atomic KMS interfaces a wlroots compositor such as cage or sway drives:

- **Mode objects.** One CRTC (id 1), one virtual encoder (2), one virtual connector (3) and one primary plane (4). Linux allocates every mode object and property from one id space, and libdrm clients read properties with `DRM_MODE_OBJECT_ANY`, so no two objects share an id (`crates/runtime-core/src/dri/kms.rs`). The primary plane is listed by MODE_GETPLANERESOURCES only after `DRM_CLIENT_CAP_UNIVERSAL_PLANES`, and reports the formats ADDFB2 accepts (XRGB8888, ARGB8888, RGB565, ABGR8888, XBGR8888, R8, GR88, the four 2101010 orders, ABGR16161616F and XBGR16161616F). R8 and GR88 show their channels with the channels they lack zero; 10-bit and half-float planes are reduced to 8 bits per channel (see the scanout formats below). The legacy cursor ioctl is available separately; the general plane list contains the primary plane.
- **Capabilities.** GET_CAP answers every capability Linux defines and fails with `EINVAL` for an unknown one, as `drm_getcap` does. `CRTC_IN_VBLANK_EVENT` and `TIMESTAMP_MONOTONIC` are 1 (flip events carry the CRTC id and a `CLOCK_MONOTONIC` timestamp); `ADDFB2_MODIFIERS` and `ASYNC_PAGE_FLIP` are 0; `SYNCOBJ` and `SYNCOBJ_TIMELINE` are 1 on both nodes (see [explicit synchronization](#explicit-synchronization-fences-sync_file-and-drm-sync-objects)). SET_CLIENT_CAP accepts `STEREO_3D`, `UNIVERSAL_PLANES`, `ASPECT_RATIO` and `ATOMIC` (0, 1 or 2, as `drm_setclientcap` takes it; it sets universal planes alike), and `WRITEBACK_CONNECTORS` only after `ATOMIC` (there are no writeback connectors to list). The atomic cap is advertised as soon as atomic commits are implemented (decision D-13), so a compositor that probes it takes the atomic path by itself.
- **Properties.** The planes carry the immutable `type` enum (Primary, Cursor). The connector carries `EDID` (an immutable blob, below), `DPMS`, `link-status` (Good) and `non-desktop` (0). The CRTC carries `GAMMA_LUT` and the immutable `GAMMA_LUT_SIZE` (256). The atomic properties are attached as Linux attaches them and, as Linux does, listed by OBJ_GETPROPERTIES and GETCONNECTOR only to a file that enabled `DRM_CLIENT_CAP_ATOMIC`: each plane's `FB_ID`, `CRTC_ID`, `SRC_X`/`Y`/`W`/`H` (16.16), `CRTC_X`/`Y` (signed), `CRTC_W`/`H`, `IN_FENCE_FD` and `FB_DAMAGE_CLIPS`; the CRTC's `ACTIVE`, `MODE_ID` and `OUT_FENCE_PTR`; the connector's `CRTC_ID` (one property shared with the planes). They carry `DRM_MODE_PROP_ATOMIC` and Linux's types (object, signed range, range, blob). There is no `IN_FORMATS`: no format modifiers are advertised (decision D-15, below). Any file can still read a property by id, and the master can set any mutable one through OBJ_SETPROPERTY, which becomes a one-property commit (below).
- **Legacy gamma.** The CRTC has a 256-entry gamma ramp per channel, as common 8-bit legacy drivers report through MODE_GETCRTC's `gamma_size`, following `drivers/gpu/drm/drm_color_mgmt.c`. The ramp (`gamma_store`) starts as the identity `i << 8`. MODE_GETGAMMA copies it to anyone; MODE_SETGAMMA needs the master. Both fail with `ENOENT` for another CRTC and `EINVAL` for another size, and copy red, green and blue in turn, so a fault is `EFAULT` after the channels before it moved. A complete SETGAMMA then does what `drm_atomic_helper_legacy_gamma_set` does: it makes `GAMMA_LUT` a new kernel-owned blob of 256 `drm_color_lut` entries (no file may destroy it), which `kms_color`'s legacy-gamma-reset reads back. `OBJ_SETPROPERTY` sets `GAMMA_LUT` to 0 (no LUT) or to any blob of exactly 256 entries (`EINVAL` otherwise) without touching the ramp. The CRTC holds a reference on the blob it uses, so it outlives its creator's DESTROYPROPBLOB or close and is freed when replaced. Each change of the LUT reaches the host through `host_kms_set_gamma(crtc, lut, entries)` (0 entries: none).
- **Scanout state.** SETCRTC validates its connector list as Linux does and records the mode and framebuffer, which MODE_GETCRTC and MODE_GETPLANE report. The mode lives in a kernel-owned `MODE_ID` blob (a new one only when the mode changes), as `drm_atomic_set_mode_for_crtc` keeps it.
- **One commit path.** Every change to the CRTC, its planes and its connector is a commit (`dri/atomic.rs`): a copy of the device state is staged, the whole result is checked once, and only then is the device state replaced and the host told. WHY: on a Linux atomic driver the legacy ioctls are helpers that build an atomic state, so one check gives SETCRTC, PAGE_FLIP, SETPLANE, CURSOR/CURSOR2, DPMS, SETGAMMA, OBJ_SETPROPERTY and MODE_ATOMIC the same rules and errnos, and a rejected request can never leave half of its change behind. Nothing after a successful check may fail: an internal failure there (a blob or BO that vanished) is a kernel fault that stops the kernel, never a partial commit. Legacy commits take effect when the ioctl returns, as before; PAGE_FLIP and atomic commits on a lit CRTC are pending until the vblank that completes them.
- **Atomic commits.** MODE_ATOMIC needs the current master and the atomic cap (`EINVAL` without it, `EACCES` on the render node). It copies each element of the request arrays into the kernel once and parses that copy, in the order Linux's `get_user` loop reaches the elements (in bounded chunks, falling back to the one element a chunk past the caller's memory would hide), so a fault or an invalid object or property id reports Linux's errno at the same element (`EFAULT`, `ENOENT`). Values are checked as `drm_property_change_valid_get` checks them (`EINVAL` for an immutable property, a value out of range, or an id that is not a live object of the property's type), then staged as `drm_atomic_set_property` stages them, and the result is checked as `drm_atomic_check_only` checks it: plane `CRTC_ID` and `FB_ID` together or not at all, formats, coordinates (`ERANGE`), sources inside the framebuffer (`ENOSPC`), damage rectangles, `ACTIVE` only with a mode, an enabled CRTC driving its connector and showing a mode the connector advertises, the primary plane present while the CRTC has a mode, and `DRM_MODE_ATOMIC_ALLOW_MODESET` for any mode, active or routing change. `TEST_ONLY` runs the check and nothing else: no host effects, events or fences (and `TEST_ONLY` with `PAGE_FLIP_EVENT` is `EINVAL`). `NONBLOCK` is `EBUSY` while the previous commit is pending. A blocking commit waits for the previous commit, applies, then waits for its own flip, and neither wait is interrupted by a signal. WHY: Linux's `drm_atomic_helper_commit` swaps in the new state at its point of no return and waits for the previous commit (`drm_atomic_helper_wait_for_dependencies`) and its own flip (`drm_atomic_helper_wait_for_vblanks`) with uninterruptible waits, so a blocking commit never fails with `EINTR` and never runs twice. Kandelo applies after the previous commit completes rather than before, so that commit's frame still gets its vblank, as Linux programs the hardware only then. Both waits park the caller on the host's ordinary EAGAIN retry path under a per-thread wait record; while the record exists the kernel leaves the thread's caught signals pending (`kernel_dequeue_signal` delivers none), as in `TASK_UNINTERRUPTIBLE`, and delivers them when the ioctl returns; default actions such as termination still apply. The parked thread cannot issue another system call, so the host's retry of its ioctl is the only call that finds the record: the retry of an applied commit only waits. `PAGE_FLIP_EVENT` reserves event space (`ENOMEM` when full; `EINVAL` when no CRTC is in the commit) and queues `DRM_EVENT_FLIP_COMPLETE` with the request's `user_data`, the CRTC id and the real vblank sequence and time when the host's vblank pump completes the commit, or at once when the commit turns the CRTC off. `PAGE_FLIP_ASYNC` is `EINVAL` (`DRM_CAP_ATOMIC_ASYNC_PAGE_FLIP` is 0). WHY the hot path stays allocation-free: a compositor issues one atomic commit per frame plus TEST_ONLY probes for direct scanout, so staging copies fixed-size state, the arrays are copied through stack buffers, and the mode list and blobs are read only when a commit changes them.
- **Planes (decision D-12).** The CRTC has a primary plane and a cursor plane and no overlay planes, and neither plane scales. WHY: the DRM uAPI leaves the plane set and each plane's limits to the driver, the host presenters show exactly an unscaled primary that covers the CRTC plus a positioned cursor, and no program Kandelo runs needs overlays or scaling. The check refuses the rest the way Linux drivers with the same planes do through `drm_atomic_helper_check_plane_state` with no scaling: scaling is `ERANGE`; positioning, partial coverage or a sub-pixel source origin of the primary, a primary on a disabled CRTC, and no primary on an enabled CRTC are `EINVAL`. The cursor plane is positioned freely (negative and off-screen positions included) but takes only a packed, zero-offset ARGB8888 image of up to 64×64, uncropped (`EINVAL`). A larger primary framebuffer still pans by whole pixels through `SRC_X`/`SRC_Y`, which GETCRTC reports as `x`/`y`.
- **Modifiers (decision D-15).** Framebuffers are linear, and no plane carries `IN_FORMATS`. WHY: CPU buffers are linear by definition and GPU-tier buffers are opaque native textures, so advertising a tiled layout or modifier list would describe a layout that does not exist (the same reason `DRM_CAP_ADDFB2_MODIFIERS` is 0).
- **Fences.** `IN_FENCE_FD` takes -1 (no fence) or a `sync_file` fd, whose fence the plane waits for; any other fd is `EINVAL`, as `sync_file_get_fence` fails on Linux, and so is a second `IN_FENCE_FD` on one plane in one commit. A nonblocking commit with an unsignaled in-fence swaps its state in at once (GET reports it) but latches its host effects (scanout, cursor, color stage, and the releases that follow them) at the first vblank after the fence signals; its flip events and out-fence complete at that vblank, and the CRTC stays busy (`EBUSY` for another nonblocking commit) until then. A blocking commit waits for its in-fences before its state is swapped in, interruptibly, as `drm_atomic_helper_commit` does, so it parks with no commit record and a signal can end it; legacy `OBJ_SETPROPERTY` commits do the same. A nonzero `OUT_FENCE_PTR` receives -1 when staged (`EFAULT` for a bad pointer). A TEST_ONLY commit makes no fence. A real commit creates the CRTC's next fence (one fence context per CRTC, `drm_crtc_create_fence`), installs a close-on-exec `sync_file` for it and writes the fd once the commit is certain to apply (after its check and busy test; a fault fails the commit untouched); the vblank that completes the commit signals it with that vblank's time, a commit that leaves the CRTC dark signals it at once, and a CRTC turned off by removing its framebuffer signals it with the last vblank's time. See [explicit synchronization](#explicit-synchronization-fences-sync_file-and-drm-sync-objects).
- **ACTIVE and DPMS.** `ACTIVE` off keeps the mode and planes but scans out nothing: the host is told to show no framebuffer, the cursor transport reports no image, and the vblank counter stops. A dark CRTC's output is black on every presenter (the 2D blit, the WebGL2 scanout presenter, direct GPU scanout and a GL session that owns the canvas, whose window frames do not reach a dark CRTC), cleared once per dark period, and the stats buffer's slot 9 reads 0 on Node and in the browser alike; a CRTC whose scanned framebuffer was removed is dark too. WHY: a display that is off shows nothing, so keeping the last frame on screen would present a state the system is not in. Legacy DPMS is an `ACTIVE` commit, as `drm_atomic_connector_commit_dpms` makes it: On lights the CRTC, Standby, Suspend and Off darken it and read back as Off, and after every modeset DPMS follows `ACTIVE`. Atomic writes to `DPMS` are `EINVAL`, as on Linux.
- **EDID (decision D-14).** The connector's `EDID` is a Kandelo-identified E-EDID 1.4 base block (`dri/edid.rs`) with a stable identity: manufacturer `KDL` (a code chosen for Kandelo, not an assigned PNP ID), product code 1, product name `Kandelo`, serial 1 and serial string `0001`. WHY: compositors name outputs by EDID make, model and serial, and their configuration matches on that name, so a stable identity lets a user's output configuration keep applying. Its preferred detailed timing is the connector's first mode exactly as GETCONNECTOR lists it, a display range limits descriptor (no timing formula) bounds every advertised mode, and its sizes are the connector's `mm_width`/`mm_height` (undefined when the host reports none). It claims no established or standard timings, because those name VESA timings that differ from the virtual modes. `KDL` is an unregistered virtual-device identity: EDID parsers accept any three-letter code and show an unknown one as it is, so a registered ID is not needed for correct parsing; registration guarantees uniqueness among physical products, and `KDL` is unassigned in the UEFI PNP ID registry today. Probing the connector (GETCONNECTOR, or OBJ_GETPROPERTIES on it) rebuilds the blob when the host's preferred mode or size changed, as `drm_connector_update_edid_property` replaces it, and keeps the same blob otherwise. A preferred mode that cannot be a detailed timing is a host fault (the host bounds it at 3840×2160) and stops the kernel.
- **Damage.** `FB_DAMAGE_CLIPS` is a hint: its rectangles are validated (`EINVAL` for a blob that is not whole `drm_mode_rect`s, or an empty or negative rectangle) and the blob is held by the plane state, but the host presents the whole plane each vblank.
- **Framebuffers.** RMFB of the framebuffer on the CRTC disables the CRTC, as on Linux. CLOSEFB drops the fd's framebuffer id but leaves a scanned-out framebuffer on the CRTC until the next SETCRTC or PAGE_FLIP replaces it; wlroots closes its framebuffers this way. Framebuffer ids are device-wide. Framebuffers belong to the open file: a child that inherits it through `fork()` or `posix_spawn()` shares the parent's framebuffers, and they are removed only when the last process closes the open file, as Linux does with a `drm_file`. A compositor's child that closes its inherited `O_CLOEXEC` `card0` fd at `exec` leaves the compositor's scanout framebuffer on the CRTC.
- **Cursor.** MODE_CURSOR and MODE_CURSOR2 retain main's negotiated 64×64 ARGB cursor implementation and BO references. Hosts without that transport report zero cursor capacity and reject cursor operations with ENOTSUP.
- **Master.** The first open of `card0` while no file is master becomes master, as Linux's `drm_master_open` does, so a compositor that never calls SET_MASTER (wlroots over libseat's noop backend) can modeset. DROP_MASTER and the master's last close release it; a later SET_MASTER from another file then succeeds.
- **Authentication and leases.** GET_MAGIC issues a per-open-file token and AUTH_MAGIC lets the master accept it (`EACCES` from a non-master, `EINVAL` for an unknown token such as the 0 that libdrm's `drmIsMaster` probes with). Kandelo does not gate primary-node ioctls on authentication. MODE_CREATE_LEASE fails with `EOPNOTSUPP`: DRM leases are not implemented.

Nested KMS query outputs are preprobed together before any write. DRM
leases are not implemented. The DRM
nodes report char devices 226:0 and 226:128 and are described by sysfs.
CPU-tier PRIME fds map their BO at offset zero; GPU-tier mappings fail
with EINVAL. PRIME fstat reports the BO size and anonymous-inode mode.

`host_kms_mode_info` returns a mode flagged PREFERRED so KMSDRM's mode-selection loop picks it up. When the embedder has reported the display pane's device-pixel size (`setKmsDisplaySize`, fed by the Modeset pane's ResizeObserver), the mode follows the reported pixel dimensions, even-aligned and clamped to [640, 3840] × [480, 2160], so a mode-picking client (wlcompositor, SDL2 KMSDRM) fills the pane with no letterbox; without a reported size (Node hosts, headless) it stays the historical 1920×1080@60. The preferred mode is sampled per GETCONNECTOR call and clients generally cache it at startup; resizing the pane afterwards changes presentation rather than switching the guest mode. The kernel also advertises 17 standard 60 Hz modes from 640×480 through 3840×2160, deduplicating the preferred size. Only the host-provided first mode is preferred. Both hosts expose this same catalog through the existing DRM ioctl, without a new host import or ABI layout. A count query reports the full list length; an undersized modes buffer is left untouched so libdrm can retry. The guest can switch modes using ordinary SDL or libdrm APIs, and the browser fits the selected scanout with letterboxing. The connector-id parameter is plumbed through but v1 advertises a single connector. `libc/glue/libgbm_stub.c` implements a 2-BO scanout ring (lock_front_buffer / release_buffer / has_free_buffers / destroy) on top of the dumb-buffer surface so KMSDRM's swap chain has somewhere to hand off frames. The `libEGL.a` / `libGLESv2.a` stubs (in `libc/glue/`) route GLES commands through the `/dev/dri/renderD128` cmdbuf to the host's WebGL2 bridge.


The EGL library imports single-plane linear dma-buf images and the GLES
library binds them to textures or renderbuffers. The image handle and its
GL siblings have independent lifetimes. The implementation and evidence
ledger is [graphics compatibility v1](graphics/compatibility-v1.md);
these interfaces do not establish complete EGL1.5 or GLES2 conformance.

GLES vertex-array buffer identity and format are tracked independently of
native WebGL state. Clearing an attribute uses a native null ARRAY binding
and `vertexAttribPointer` with offset zero, as WebGL permits. The logical
size, type, stride and original offset remain available to GLES queries;
no temporary native buffer is allocated merely to represent null. Native
changes and their inverses are checked before logical publication. A
restoration a live renderer refuses is a fatal host fault (see native
retirement below).
Deleted buffer names and backing-storage retirement remain separate, so
another context or an unbound vertex array can retain the old storage.


Compressed texture uploads use checked opaque staging rather than texture
row bands. A context admits the original signed metadata and a monotonic
upload token, copies consecutive chunks into independently owned host bytes,
then consumes that token for one full native compressed image/subimage call.
The staging acknowledgement does not promise native storage acceptance;
format-specific sizing, level and block rules remain native COMMIT checks.
The selected context, logical texture, view, storage revision and unit must
still match. Cancellation drops bytes, and an uncertain COMMIT is never
replayed. Context retirement releases staged bytes before native retirement.
The resource policy bounds one staged upload to 16 MiB per context; larger
uploads or allocation failure report `GL_OUT_OF_MEMORY`, not success or
truncation. Empty uploads still validate through the full native operation.
Positive-size NULL compressed sources are refused without synthesizing data;
ES2 defines no compressed NULL-allocation counterpart to `TexImage2D`.
Actual native compressed-format enumeration is unchanged, and no compression
extension is enabled merely by this transport. Normal rebuilt guests and
native browser compressed-format validation remain separate evidence gates.

`DRM_IOCTL_WPK_BIND_FOREIGN_TEXTURE` (a WPK extension, `'d'` nr `0xE1`) bridges the two tiers: it (re)uploads a CPU-tier bo's current pixels into a `WebGLTexture` in the calling fd's GL context — the host reads the bo's canonical SAB storage directly, so window-sized textures never squeeze through the 64 KB-capped cmdbuf TLV records. The bo handle and the GL session must live on the same fd; `libEGL` exposes the flow as `wpkEglImportDmabufHandle(prime_fd, fourcc)` (PRIME import on the EGL fd, refused with `EINVAL` when a GPU-tier bo was made in storage `fourcc` does not name, by the same `DRM_IOCTL_WPK_CHECK_BO_FORMAT` check an `EGL_LINUX_DMA_BUF_EXT` import applies) + `wpkEglBindBoTexture(handle, GL_TEXTURE_2D)` (idempotent per bo; re-call to refresh after the producer commits). Texture lifetime is tied to the bo: the last GEM_CLOSE deletes it.

`DRM_IOCTL_WPK_CREATE_GPU_BO` (`'d'` nr `0xE0`) allocates host-native
texture/FBO storage without CPU-mappable bytes. The virtual GPU has one
native renderer, independent of DRM master and of whichever process first
creates an EGL context. It prefers an already registered WebGL2 display
context and otherwise creates an offscreen resource context. A render-node
file may therefore create GPU resources before any primary-file context.
Logical GL object groups, context state and file authority remain separate;
the shared native context does not grant another context's public names or
KMS controls. Node without a configured WebGL backend returns ENOSYS from
GPU allocation and retains the existing CPU-buffer fallback.

A client can target a retained GPU BO through its window surface or import
its dma-buf as an EGLImage and attach a logical renderbuffer/texture view.
The kernel resolves per-file GEM handles to backing storage. Surface targets
and image siblings retain their own references; public image/handle deletion
does not authorize deletion of a surviving sibling's storage. GPU BOs include
color, 24-bit depth and 8-bit stencil attachments.

`GL_OES_EGL_image_external` gives every texture unit a third binding,
`TEXTURE_EXTERNAL_OES`, whose textures take only EGLImages and are sampled
through `samplerExternalOES` (wlroots samples external-only dma-bufs this
way). WebGL 2 has no such target, so the host
(`host/src/webgl/external-texture.ts`) keeps each unit's external binding in
its shadow state, separate from the unit's TEXTURE_2D binding, and an
external texture's storage is an ordinary native 2D texture (the image
sibling view) that only the draws of a program sampling it bind, to that
unit's native TEXTURE_2D, restoring the unit's 2D binding after the draw.
Why: one native binding point cannot hold both of a unit's bindings, and
binding per draw only for programs that sample external textures costs
every other draw one lookup. When `glShaderSource` gives the host a
shader that names the extension, the host compiles a rewrite once: the
shader's own `#extension GL_OES_EGL_image_external` directive defines a
private type macro as `sampler2D` (`disable` undefines it), so the type
exists exactly where the extension is enabled, even under conditional
compilation, `GL_OES_EGL_image_external` is defined as 1, and `#line`
keeps the guest's line numbers; `glGetShaderSource` still returns the
guest's text. Reflection reports `SAMPLER_EXTERNAL_OES` for those samplers.
Because WebGL then sees sampler2Ds, the rewrite also checks sampler flow
the way a conforming compiler types it, through global uniforms, array
elements, struct members and function parameters: a lookup the extension
does not define for an external sampler (any Lod, Grad, projective-Lod,
cube, 3D or shadow lookup, or `texture2D`/`texture2DProj` with a bias) and
an external sampler given to a parameter of another sampler type (or the
reverse) become calls to an undeclared function named for the misuse
(`samplerExternalOES_cannot_use_texture2DLodEXT`), so the compile fails
with that name in the info log; overloads that differ only between
sampler2D and samplerExternalOES are renamed per sampler signature and
each call to the overload its arguments select, so they stay distinct.
A sampler2D and a samplerExternalOES reading one unit are two sampler
types on one unit, which ES 2.0 section 2.10.4 makes `INVALID_OPERATION`
at draw and a `glValidateProgram` failure; WebGL compiles both as
sampler2D, so the host checks that itself, from sampler units cached per
link and per `glUniform1i`. An external texture starts with LINEAR
filters and CLAMP_TO_EDGE wraps, accepts only NEAREST or LINEAR filters
and CLAMP_TO_EDGE wraps (`INVALID_ENUM` otherwise), takes no image or
mipmap command, and its object keeps the external target
(`INVALID_OPERATION` for a 2D or cube bind, and the reverse). It samples
one RGBA image, so `REQUIRED_TEXTURE_IMAGE_UNITS_OES` is 1 for every
target and no texture unit or uniform is taken from the advertised
limits. Its sibling view copies the image only when the image's storage
write count moved (`host/src/webgl/image-writes.ts`), as 2D siblings do.

Targeting a texture at the image it is already a sibling of keeps its
sibling view: `glEGLImageTargetTexture2DOES` then refreshes the view's
copy if the image was written since, and advances the object's image
revision, as any accepted respecification does. It allocates a new view
only when the texture is not exactly that image's sibling (another image,
other levels, or a respecified texture). WHY: wlroots makes a new
`wlr_texture` over its cached EGLImage and GL texture name on every commit
of a client dmabuf, and so targets the same image at the same texture once
per client frame. Natively the texture keeps the image's storage; a new
view each time cost a texture, a framebuffer, a full copy, a retarget of
every container and two deletions per client frame.

GLSL ES 1.00's built-in limit constants (`gl_MaxVertexAttribs` through
`gl_MaxDrawBuffers`) must equal the values the guest queries, but WebGL's
compiler gives them native WebGL 2 values. Those differ where the host
reserves private uniform rows from the advertised limits (one fragment
row for the blend-fold variant; one vertex row on Firefox for the
depth-range workaround; `host/src/webgl/limits.ts`), and for
`gl_MaxDrawBuffers`, which is 1 because ES 2.0 has one color output and
Kandelo does not advertise `EXT_draw_buffers`, while WebGL 2 compilers
report the native draw-buffer count. GLSL ES reserves `gl_` names, so
the constants cannot be redefined; when `glShaderSource` gives the host
an ESSL 1.00 shader that names one, the host compiles a rewrite, made
once, in which each use in code or in a `#define` body becomes
`int(N)`, N the queried value. `int(N)` is, like the built-in, a
constant expression, not an l-value and not a macro, so other
preprocessor directives still treat the name as the engine does.
`glGetShaderSource` returns the guest's text.

OpenGL ES 2.0 has one shading language, GLSL ES 1.00, and the context
reports `OpenGL ES GLSL ES 1.00` as `GL_SHADING_LANGUAGE_VERSION`. WebGL 2
also compiles ESSL 3.00, so `glCompileShader` refuses a shader whose
leading `#version` directive names any other number (`#version 300 es`,
`#version 110`, ...) before any rewrite or translation
(`unsupportedShaderVersion` in `host/src/webgl/essl3-translation.ts`). The
shader object then fails natively, as on an ES 2.0 driver:
`COMPILE_STATUS` is `GL_FALSE`, the info log reads `unsupported shading
language version 300 es; this OpenGL ES 2.0 context supports GLSL ES 1.00
(#version 100) only` at the directive's line, a program linking it fails,
and `glGetShaderSource` still returns the guest's text. Why: compiling the
guest's ESSL 3.00 as written gave an ES 2.0 context ES 3.0 shaders
(integer types, `texture()`, `in`/`out`, ES 3.0 sampling of cube maps and
depth textures) that no ES 2.0 driver offers, and let them link with the
host's translations of ES 1.00 partners. A version that is not a decimal
number (`#version AAA`, `#version 100.0`) and a `#version` that is not
first stay with the ES 1.00 compile, which rejects them with its own log.
The ESSL 3.00 that WebGL compiles is therefore always the host's own
translation of an ES 1.00 shader.

OpenGL ES 2.0 compiles all of GLSL ES 1.00, but WebGL holds ESSL 1.00
shaders to the "minimum functionality" of GLSL ES 1.00 Appendix A: no
`while` or `do`-`while` loops, `for` loops only with a constant-bounded,
constant-stepped index, and temporary arrays indexed only by constants and
loop indices. GLES 2 drivers accept more, and guest software (and
dEQP-GLES2, e.g. `functional.shaders.indexing.tmp_array.*` and about 830
performance and stress shaders) relies on it. WebGL does not apply
Appendix A to ESSL 3.00, whose language is a superset of ESSL 1.00, so the
host compiles such a shader as an ESSL 3.00 translation with the same
meaning (`host/src/webgl/essl3-translation.ts`). The engine's own ESSL
1.00 front end stays the judge of ES 1.00 validity: `glCompileShader`
first compiles the guest's 1.00 source, and translates only when the
compile fails with nothing but Appendix A errors. ANGLE (the front end of
Chromium, Firefox and WebKit) runs its Appendix A pass only after a shader
has parsed and type-checked without error, and each of its messages is
unique to that pass, so such a shader is otherwise valid ES 1.00, while
every other failure, its info log included, reaches the guest unchanged.
Why: a translator that also had to reject everything ES 1.00 rejects but
ESSL 3.00 accepts (bitwise and modulo operators, `switch`, `uint`, array
constructors, `.length()`, `in`/`out` globals, ...) would need a complete
ES 1.00 front end of its own; asking the engine needs none, and leaves
every shader WebGL already compiled exactly as it was, at no extra cost.
The one ES 1.00 rule ANGLE checks after Appendix A, that a fragment shader
cannot use both `gl_FragColor` and `gl_FragData`, the translation reports
itself. A translated shader costs the rejected 1.00 compile, the
translation (about 0.1 to 0.8 ms for a 4 KB source in Chromium, Firefox
and WebKit) and the 3.00 compile, once per `glCompileShader`; no draw pays
anything. ES forbids linking shaders of different language versions, so
`glLinkProgram` compiles a 1.00 partner of a translated shader as its own
translation (its meaning, and `COMPILE_STATUS`, are unchanged; its info
log is now the 3.00 compile's).

A failed native ES100 compile now also retries two source normalizations,
still through the same ES100 syntax/type validator. Macro-produced `defined`
in conditional expressions is evaluated against the current macro table;
WebGL deliberately rejects that otherwise undefined GLES preprocessing
choice. Only affected conditionals change, while other directives and
malformed operators remain visible to native validation. ES100 function
bodies receive a child compound statement so their locals can shadow
parameters as §4.2.2 requires. The ES300 translation preserves that child
scope too. Same-scope duplicates remain invalid. Original guest source
bytes still serve GetShaderSource; retained private executables rebuild
the exact normalized ES100 source that passed validation. This is
compile-only work and introduces no draw/frame cost for unused features.
See the standalone WebGL scope control in
`tests/runtime-workarounds/WEBGL-ESSL100-PARAMETER-SCOPE/`.

Firefox also rejects a local that hides a global structure type when the
initializer uses a dynamic constructor. A failed-native-compile retry
alpha-renames only the proven local binding and its lexical references.
Each initializer sees the preceding binding; publishing an alias sooner
would turn its constructor into a variable reference. Same-scope duplicates
reuse the alias so they remain invalid. Member selectors and public types
retain their own namespaces. Conditional/macro bindings, local structures,
arrays and colliding parameter names remain unchanged when this lexical
proof cannot establish ownership. The standalone reproduction and removal
criteria are in `tests/runtime-workarounds/FIREFOX-ESSL100-STRUCT-HIDING/`.
This adds compilation work, with no per-frame feature bookkeeping.

A native expression-complexity rejection can also decompose a long flat
float/vector product into bounded local prefixes. The proof requires
unambiguous identifier operands with the same explicit type and precision.
Only standalone local declarations in proven function compound blocks are
split: for headers, unbraced controlled statements and initializer ranges
containing directives remain intact. In addition,
macro-expanded operands, calls, const results and self-shadowing
initializers remain with native validation. Every prefix is the original
left fold, placed first in the next expression. Multiplying independently
computed chunks would reassociate operations and change rounding. Private
names cannot capture guest identifiers, and subsequent source lines retain
their numbering. The same ES100 compiler validates the transformed full
shader; its accepted source also supplies private executable rebuilds.
The native ES100 retry runs only after an expression-complexity rejection;
ES300 output also applies the decomposition because an Appendix A rejection
can precede the native expression-budget check. Private variants therefore
receive the same bounded expressions. This adds compile-time work, with no
new per-draw/frame lookup. No application or compile-time performance
improvement is claimed.

The translation works on the shader after preprocessing
(`host/src/webgl/essl-preprocessor.ts`, ES 1.00 rules for input ANGLE has
already accepted), so each decision is about code the compiler parsed, not
text in an inactive `#if` group or an unused macro, and it emits one
output line per guest line with `#line`, so info logs and `__LINE__` keep
the guest's numbering. `#version 300 es` comes first; `attribute` becomes
`in`, `varying` becomes `out` or `in`; `gl_FragColor` and `gl_FragData`
become declared mediump outputs (`gl_FragData` an array of one, ES 2.0
having one draw buffer, so `gl_FragData[1]` stays an error); the ES 1.00
lookups take their 3.00 names where that stage has them (`texture2D` to
`texture`, `texture2DLod` to `textureLod`, ...). Identifiers that ESSL
3.00 reserves or names but ES 1.00 does not (`sample`, `layout`, `uint`,
`texture`, `round`, ...) are renamed `kandelo_essl1_<name>`, and guest
identifiers beginning `kandelo_essl` are escaped the same way, so the
renaming is injective. Uniform and attribute names are API-visible:
reflection, location queries and `glBindAttribLocation` of a translated
program translate them both ways, so the guest only ever sees its own
names. ES 1.00 lets a shader overload a built-in function; ESSL 3.00 does
not, so the name is renamed and private forwarders with the ES 1.00
signatures call the built-in, except inside constant expressions, where
the built-in is the only possible meaning. ANGLE accepts non-constant
global initializers only for ES 1.00, so the translation runs them, in
order, at the start of a new `main`. ESSL 3.00 fragment inputs cannot be
invariant and `#pragma STDGL invariant(all)` is vertex-only, so the
fragment qualifiers go and an invariant varying is renamed in both
stages: an invariance mismatch, a link error in ES 1.00, then still fails
to link. Draw-time variants (reversed depth, depth sampling, blend
folding, attribute aliasing) rewrite the ES 1.00 source as before and are
then translated the same way, so each of those rewrites stays ES
1.00-only.

`GL_OES_standard_derivatives` is advertised because WebGL 2 has the
derivatives, but WebGL 2 enables no ESSL 1.00 extension, so `#extension
GL_OES_standard_derivatives : require` failed and `dFdx` was undeclared.
Every ES 1.00 source now gets the extension the way
`GL_OES_EGL_image_external` is provided: uses of the macro name read a
private macro defined as 1, each `dFdx`, `dFdy` and `fwidth` token is a
macro that names the guest's own identifier until the shader's own
`#extension` directive (rewritten on its line) makes it the built-in, so
the functions exist exactly where the extension is enabled. The validity
compile declares them with the extension's genType signatures, so calls
type-check as against the real built-ins, and a fragment shader that
enables them is compiled as ESSL 3.00, where they are the core functions.
They do not exist in vertex shaders.

Known gaps in translated programs: a fragment shader's `invariant
gl_FragCoord` no longer requires an invariant `gl_Position` in the vertex
shader (ES 1.00 makes that a link error); a dynamically indexed
`gl_FragData` is still rejected, as ESSL 3.00 requires constant output
indices; and a sampler array indexed by a loop index (ES 1.00 Appendix A
allows it; ESSL 3.00 requires a constant expression) fails to compile.
Headless Chromium also loses the WebGL context when it
links an ESSL 3.00 program that overloads a function by array size (a
suspected engine defect, reproduced without Kandelo code; the ES 1.00
form links), so such a shader that also needs the translation loses the
context. ANGLE's own failures stay what they are in either language:
"Expression too complex" for very long expressions, a `defined` produced
by macro expansion in `#if`, and a local variable that hides a function
parameter (valid ES 1.00, where the function body is a new scope).

OpenGL ES 2.0 samples a cube map one face at a time (sections 3.7.5 and
3.7.7): the major axis of the direction selects a face, and that face's
(s, t) are wrapped and filtered within the face alone. WebGL 2 follows ES
3.0, where cube-map sampling is always seamless: linear filtering near an
edge mixes texels of the adjacent face, and no WebGL state turns that off
(reproduced in Chromium, Firefox and WebKit without Kandelo code). So a
guest cube map is stored as a native six-layer `TEXTURE_2D_ARRAY` (layer i
is face `TEXTURE_CUBE_MAP_POSITIVE_X + i`, `host/src/webgl/cube-storage.ts`),
each layer wrapped and filtered by itself exactly as ES 2.0 samples a
face, and every shader that uses `samplerCube` is compiled as its ESSL
3.00 translation, even when ES 1.00 accepts it, because ESSL 1.00 has no
`sampler2DArray`. There `samplerCube` becomes `sampler2DArray` (with
`samplerCube`'s default `lowp` precision) and `textureCube` and
`textureCubeLod` become private functions that select the face by ES 2.0
table 3.21 and sample its layer. A fragment lookup passes explicit
gradients: the derivatives of the selected face's (s, t), computed from
the derivatives of the direction in that face's frame by the quotient
rule. Why: ES 2.0 derives the level of detail from the selected face's
u(x, y) and v(x, y); `texture()` on the array would differentiate the face
coordinates themselves, which jump where neighbouring fragments select
different faces, and pick a far too small level along every edge. A bias
scales the gradients by 2^bias; a vertex lookup uses level 0 or the given
level. Reflection reports `SAMPLER_CUBE` for those uniforms. Every cube
image command (`TexImage2D`, `TexSubImage2D`, `CopyTexImage2D`,
`CopyTexSubImage2D` and the compressed commands on a face,
`GenerateMipmap`, `TexParameter`, `GetTexParameter`) works on that
storage; `FramebufferTexture2D` of a face attaches its layer; an EGLImage
exported from a face (`KHR_gl_texture_cubemap_image`) is its layer and is
orphaned on respecification as a 2D source is. `MAX_CUBE_MAP_TEXTURE_SIZE`
reports what that storage can hold: the smaller of the native cube and 2D
limits (array layers are 2D-limited; WebGL 2 guarantees at least 256
layers).

A 2D array level has one size and format for all six layers, while ES 2.0
lets each face of a level have its own while the cube is incomplete, and
every face image stays an image that can be attached, copied from or
updated. So a cube owns one or more arrays, each face image lives in
exactly one at its own layer, and images of one size and format gather in
one array: a cube specified in the usual ways (six faces per level in any
order, `GenerateMipmap`, every face respecified at a new size) has all its
images in its own array, while a face respecified apart from its siblings
moves to a second array instead of destroying their images, taking its
framebuffer attachments along. When the images a complete cube samples
are spread over arrays they are copied into the array holding the base
level; that copy goes through a framebuffer, so a format that cannot be
attached (luminance, for one) reports `GL_OUT_OF_MEMORY` there, as
orphaning a linked EGLImage source already does. A draw samples the array
holding all six base images only while the cube is complete under ES 2.0
rules; otherwise no texture, which samples (0, 0, 0, 1), because the
array allocates all six layers of a level and would otherwise accept
faces never specified (likewise, an attached face never specified is
`FRAMEBUFFER_INCOMPLETE_ATTACHMENT`). That array is bound to the unit's
`TEXTURE_2D_ARRAY` for the draw only when it differs from the unit's
guest binding; a complete cube in its own array costs a cached comparison,
and a program without cube samplers keeps the one per-draw lookup it
already made for external textures.

ES 2.0 section 3.7.9 makes the minification/magnification switch-over
point c = 0.5 when the magnification filter is `LINEAR` and the
minification filter is `NEAREST_MIPMAP_NEAREST` or `NEAREST_MIPMAP_LINEAR`
(ES 2.0's initial pair is `NEAREST_MIPMAP_LINEAR` with `LINEAR`), so a
level of detail lambda in (0, 0.5] magnifies: `LINEAR` on level 0. ES 3.0
dropped that case, and Chromium, Firefox and WebKit minify there (c = 0,
reproduced without Kandelo code), returning `NEAREST` from level 0 or a
`NEAREST` blend of levels 0 and 1. The host emulates c = 0.5
(`host/src/webgl/lod-switchover.ts`). It records each 2D and cube
texture's filters at `TexParameter`, and each context keeps the traits of
its unit bindings (and texture zero) in the summary depth-texture sampling
already kept (`samplingUnits` in `host/src/webgl/depth-sampling.ts`), so a
bind looks up only the texture it binds and a draw while no unit holds a
depth texture or a texture with the pair makes the one comparison it made
before. Otherwise the program's sampler units (cached per link and
`Uniform1i`) name the samplers that read such a texture, and the draw runs
a private variant,
built once per program and sampler set like the reversed-depth and
depth-sampling variants. In it the lookups through those samplers compute
lambda as ES 2.0 section 3.7.7 does (log2 of the larger derivative length
of (s, t) times the level-0 size, plus the bias; for a cube map from the
selected face's (s, t), as the per-face lookups do; in a vertex shader the
`texture2DLod`, `texture2DProjLod` or `textureCubeLod` argument) and call
`textureLod` at lambda when lambda > 0.5 and at 0 otherwise. Why that is
exact: `textureLod(..., 0.0)` has lambda 0 <= c = 0 in WebGL 2, so it is
the magnification ES 2.0 makes for lambda <= 0.5 (same `MAG` filter, level
0, since ES 2.0 has no base level or LOD clamps); above 0.5 both rules
minify, and `textureLod` at lambda makes ES 2.0's level choice and blend at
that lambda. A vertex shader's implicit lookups have level of detail 0 and
magnify under either rule, and ES 2.0 fragment shaders have no explicit
level of detail, so neither changes. The rewrite works on the
translation's preprocessed tokens (`textureSize` and fragment `textureLod`
exist only in ESSL 3.00, so the variant of an ES 1.00 program is its
translation): a uniform sampler, a member or constant-indexed element of
one, an element indexed by an expression (a per-index function) and a
sampler parameter of a user function (an added `bool` parameter every call
passes) are resolved; other lookups (a sampler inside a struct parameter,
an array parameter, overloads of one arity with different sampler
positions, an index containing a call) keep c = 0, as does a draw whose
variant does not compile (a sampler array indexed by a loop index, which
ESSL 3.00 rejects): those are the remaining gap, never a refused draw.
They are not silent (decision D-55): the translation returns each
unattributed lookup that may read an affected sampler, and the variant
builder reports it, or a variant that did not build, as a host diagnostic
(`host/src/webgl/diagnostics.ts`, source `GLES texture switch-over
point`) naming the process, the guest program id, the samplers and the
reason, once per linked executable, reason and sampler, at build time
rather than per draw. Compositors such as wlroots set
`LINEAR` or `NEAREST` filters, and imported foreign textures start
`LINEAR`, so their draws never select the variant; costs are measured in
`docs/measurements/2026-11-02-gles2-lod-switchover.md`.

GBM, `DRM_IOCTL_WPK_CREATE_GPU_BO` and dma-buf import share one set of
single-plane formats, each stored exactly: R8, GR88, RGB565, the four
8888 orders, the four 2101010 orders, and ABGR/XBGR16161616F. A GPU-tier
BO is a WebGL 2 texture of the format's own internal format (R8, RG8,
RGB565, RGBA8, RGB10_A2 or RGBA16F; RGBA16F renders only with
`EXT_color_buffer_float`, which the device context enables, and
allocation fails without it), with a LINEAR-equivalent stride of the
format's bytes per pixel rounded to 4 bytes. A GPU BO has no CPU bytes,
so ARGB and ABGR orders share storage; a format without alpha keeps a
stored alpha of 1.0 that rendering never writes. A CPU-tier BO imported
as an EGLImage is mirrored in a texture of the same internal format, with
an exact byte conversion each way (`host/src/webgl/cpu-image-codec.ts`:
10-bit fields swap for the ARGB order, half floats read back as float32
and convert to the same half, padding bits are preserved). An exported
GLES image's BO is described in its format's bytes per pixel. The kernel
records each GPU-tier BO's format (the allocation's fourcc, or the DRM
format naming an exported image's internal format), and libgbm and libEGL
check a dma-buf import's claimed fourcc against it with
`DRM_IOCTL_WPK_CHECK_BO_FORMAT`: a GPU BO is a texture of that format, so
a claim naming other storage (GR88 over RGB565, ABGR8888 over
ABGR2101010) or a format without alpha over storage with alpha fails
(`EINVAL`; `EGL_BAD_MATCH`), while channel order alone (ARGB over ABGR) is
not observable on a GPU BO and is accepted. CPU-tier BOs are bytes that
any format may describe, as on Linux. EGL window
surfaces, and therefore `gbm_surface`s, remain 8888 only, because
Kandelo's EGL configs are 8888 configs. General CPU/GPU coherence,
format reinterpretation and native GBM ring posting remain incomplete;
see the graphics compatibility ledger for the exact implemented scope.

Every layer sizes a pixel format from one table: the planes, bytes per
sample and chroma subsampling of each format, Linux's `drm_format_info`
for R8, GR88, RGB565, the 8888, 2101010 and 16161616F orders, and the YUV
formats NV12, NV21, YUV420, YVU420, YUYV, UYVY and P010, with each RGB
format's GPU-tier storage (its WebGL 2 internal format, which the GPU
buffer allocator, the dma-buf format check, the CPU mirror codecs and the
scanout presenters all read) and whether its alpha is padding. The kernel
(`wasm_posix_shared::dri::DRM_FORMATS`), libgbm and libEGL
(`libc/glue/drm_format_info.h`) and the host
(`host/src/webgl/drm-format-info.ts`) carry the same rows, and
`host/test/webgl-drm-format-info.test.ts` fails if they differ. Why: a
plane that the allocator, the importer, the kernel and the host size
differently is read out of bounds or misread, so the layout has exactly one
definition. MODE_ADDFB2 runs Linux's `framebuffer_check` over every plane
of the format first (a missing handle or short pitch of any plane is
EINVAL, a plane extent past 32 bits is ERANGE) and only then refuses a
format no plane of this device scans out (EINVAL, as i915 and amdgpu do at
framebuffer creation): the primary plane scans out RGB only, so a
well-formed YUV framebuffer is refused there. `DRM_IOCTL_WPK_IMPORT_IMAGE`
takes a plane of any single-plane RGB format at that format's own bytes
per pixel; the dumb buffer's allocation bpp plays no part, because a
dma-buf is bytes whose meaning the importer names.

GBM allocates a YUV buffer (NV12, NV21, YUV420, YVU420, YUYV, UYVY, P010)
as one linear CPU-tier dumb object holding every plane, as Mesa's drivers
lay planar images out: each plane's rows hold its subsampled samples
(rounded up; a packed YUYV/UYVY row ends with a whole pixel pair) rounded
to 4 bytes, one plane after another, reported through the per-plane
accessors. A YUV buffer is sampled, never rendered to or scanned out: no
WebGL 2 texture format stores YUV planes as a render target and no KMS
plane scans YUV out, so `GBM_BO_USE_RENDERING`, `_SCANOUT` and `_CURSOR`
fail with EINVAL and `gbm_device_is_format_supported` reports 0 for them
(`gbm_bo_create_with_modifiers`, whose implied usage is scanout and
rendering, therefore fails too). `gbm_bo_get_bpp` is 0 for YUV, as Mesa
reports. `GBM_BO_IMPORT_FD_MODIFIER` takes one fd, stride and offset per
plane of the format (one object or several), checks each plane against
its own object's size, and `GBM_BO_IMPORT_FD` names one plane, so it
takes packed YUYV/UYVY but not a planar format. A plane may also be a
GPU-tier object whose storage is the plane's own format (NV12's luma R8
and chroma GR88; each YUV420/YVU420 plane R8), at offset 0, since a
texture has no byte addressing; `DRM_IOCTL_WPK_CHECK_BO_FORMAT` checks it
against that plane format (EINVAL otherwise), and an import with any
GPU-tier plane refuses `GBM_BO_USE_WRITE`, whose bytes it does not have.
P010 and the packed formats have no GPU-tier plane: no GPU buffer has
R16, GR1616 or YUYV storage.

`EGL_EXT_image_dma_buf_import` imports those YUV formats with one fd,
offset and pitch per plane (planes 0 to 2; a plane the format lacks is
`EGL_BAD_ATTRIBUTE`, a missing attribute of a plane it has
`EGL_BAD_PARAMETER`, a pitch shorter than a row or a plane past its
dma-buf `EGL_BAD_ACCESS`, and every plane that names a modifier must name
plane 0's, as Mesa requires). The color-space, sample-range and siting
hints select the conversion; absent hints are BT.601, narrow range and
siting 0, Mesa's defaults. `eglQueryDmaBufModifiersEXT` reports the YUV
formats `external_only`: a YUV image is the sibling of an external texture
only (`GL_OES_EGL_image_external`), and a TEXTURE_2D or renderbuffer
target is `GL_INVALID_OPERATION`. A plane is CPU-tier bytes or GPU-tier
storage of the plane's format at offset 0 (as for GBM above; another
format is `EGL_BAD_MATCH`, an offset `EGL_BAD_ACCESS`), and
`GBM_BO_IMPORT_EGL_IMAGE` of a YUV image yields a bo with all of its
planes. Binding the image through `DRM_IOCTL_WPK_IMPORT_PLANAR_IMAGE`
gives the host the planes' bo ids and the conversion; the kernel checks
each plane against its object first (CPU bytes against the object's size,
GPU storage against the plane format it recorded and the plane's size).
The host (`host/src/webgl/yuv-convert.ts`, `yuv-gpu-convert.ts`,
`cpu-image-storage.ts`) converts the planes to an RGBA texture (RGBA8 for 8-bit formats, RGB10_A2 for P010, so
no sample loses precision) with the BT.601, BT.709 or BT.2020 matrix and
narrow or full range, reconstructing chroma by linear interpolation
between the samples where the siting hints place them, and no transfer
function (the extension keeps the source's color space). Why convert, and
when: sampling RGBA keeps an external texture to one texture unit and no
private uniforms, so `REQUIRED_TEXTURE_IMAGE_UNITS_OES` is 1 and no
advertised limit shrinks; converting only when a plane's canonical bytes
were written (each BO's write count, advanced when a CPU writer's mapping
is merged or a device writes it) means no draw and no unchanged frame
pays for it. An image with a GPU-tier plane is converted on the GPU, so
those pixels never leave it: each plane is copied (GPU planes) or
uploaded (CPU planes) into a private texture of its plane format only
when its write count changed (a GPU plane's storage write count, advanced
by every draw, clear, texture command or copy into it), and a fragment
shader computing exactly the CPU converter's arithmetic writes the RGBA8
image in a private native pass after which the guest's context is
replayed; a native error in that pass is a fatal host fault. The
converted texture's own write count then lets sibling views copy it only
after a conversion. With the image write-count audit
on (the graphics test gate), an unchanged count with changed plane bytes
is a fatal fault.

`EGL_MESA_image_dma_buf_export` describes any image with a DRM format as
dma-bufs: `eglExportDMABUFImageQueryMESA` reports the format, its plane
count and each plane's modifier, and `eglExportDMABUFImageMESA` returns a
caller-owned PRIME descriptor, pitch and byte offset per plane (one per
plane even when planes share a dma-buf, as current Mesa exports them).
A plane of CPU bytes reports LINEAR; GPU-tier storage (an exported GLES
image or a GPU BO) reports `DRM_FORMAT_MOD_INVALID`, an implicit layout,
because a native texture has no byte layout to name; importing either
works. An image no DRM format describes (for example an RGBA32F texture
image) cannot be exported: `EGL_BAD_MATCH`, where Mesa returns
`EGL_FALSE` with no error, so a caller can tell why.

In the image-backed producer path, rendering resources and presenting them
are separate operations. Authorized KMS operations select a framebuffer;
the vblank pump presents its retained GPU BO even when the producer uses
an independent render file. On the same native display context it blits
the selected FBO, with KMS row zero at the top. Primary scanout forces only
its displayed alpha to one, matching both CPU presenters; source BO alpha
remains available to image siblings. Native color masks and clear values
are restored through the same checked inverse journal. A 2D display or
a different native canvas receives an independent RGBA readback. GPU access
is synchronous inside the kernel entry while the latched framebuffer owns
its BO; only owned pixel bytes survive into detached presentation.

Native device blits/readback restore their selector, scissor and packing
inverses through the shared checked journal. They retain native handles and
scalars rather than guest memories or bindings. CPU WebGL scanout also resets
its complete draw/upload dependencies on each accepted frame. Every utility
captures the outgoing logical owner's errors before native work. Generic
presenter callbacks invalidate the muxer so later GLES work restores that
context's state. A reviewed already-current drawable release/rebind may instead
retain the exact selected owner with only its read/draw framebuffer selectors
marked unknown only if the pure synchronous logical commit changes those
references. Comparing its two local pre-commit references can add dirtiness,
never clear an earlier dirty bit. Before that owner executes again, a private checked sequence
rebinds both selectors from desired logical state; a failed prefix invalidates
and refuses dependent work. This does not treat a mutated shadow as proof of
physical selector values. First-current viewport/scissor initialization,
new surfaceless allocation, owner-dead surface collection, pending repair or
execution cleanup and client-array restoration retain full invalidation.
A forwarded drawable mark follows only its acknowledged successful pure logical
commit. Peer selection and full invalidation discard the partial witness;
a thrown full-replay prefix also revokes the previous owner's identity. The fixed GPU cursor readback, scanout and GBM front-copy/readback
helpers may preserve its selected owner after their complete checked selector
inverse succeeds. Front export retains its own errno and private errors; CPU
front bytes are published only after the final error, context-loss and pending
repair checks succeed. Failed native export or publication revokes selection
reuse. Shared query, submit, import and front-copy preparation invalidates
before pending native cleanup can change selectors. Resize invalidates before the first drawing-buffer
dimension write. Failure
or context loss also invalidates, and private device errors remain separate
from the guest's pending flags. This is selector validity, not content
immutability. Package-private immutable
graphics access exposes these native operations separately from raw kernel
memory authority. Context loss stands GPU scanout down; complete restoration
of lost resources remains an ordinary implementation gap.

The vblank pump observes every GPU-tier CRTC and the cursor plane at every
vblank (about 60 times a second), idle or not. An observation that would return what the previous
one returned is not repeated; anything that could change the result makes
the next observation do the full native work. A GPU cursor readback is
reused while the BO, its native storage, the renderer's loss count and that
storage's image write count (`host/src/webgl/image-writes.ts`) are all
unchanged and no native repair is pending. Every image write path advances
that count: draws and clears into the BO or an EGLImage sibling of it, image
commands through a sibling, a sibling view's refresh of its private copy
(the storage of a GLES image exported from that sibling), GBM front copies,
multisample resolves, mirror uploads and foreign-texture uploads. GPU-tier BOs have no CPU mapping, and
CPU-tier cursors are still read from their mapping on every observation.
Same-BO writes without another cursor request are therefore still observed.
The graphics test gate turns on the write-count audit, under which every
reuse reads back anyway and a change behind an unchanged count is fatal.
A direct GPU scanout is not blitted again while the canvas provably still
shows it: same storage, framebuffer, kernel commit count and viewport,
the canvas at the framebuffer's size, the same color-stage LUT and cursor
when a stage is in use, an unchanged loss count, no pending repair, a
context created with `preserveDrawingBuffer`, and an unchanged write epoch
of the native context (`host/src/webgl/context-writes.ts`). That epoch
counts every call on the context except a fixed list of calls that cannot
change any pixel (state, binds, queries, buffer data, object creation,
program work, `readPixels`), so writes to the source storage and every
other writer of the canvas (a GL session presenting to it, a dark CRTC's
clear, any host utility) invalidate it without being enumerated. WHY: on
an idle labwc or sway desktop in Chromium the pump otherwise issued about
3,300 WebGL calls a second, half of them `getError`, to redraw and re-read
unchanged pixels. A
reused observation issues no native call, so it neither borrows device
state nor reads the selected owner's error flags; the stats slots still
report each presented vblank.

`gbm_bo_create` treats SCANOUT as CPU-facing. Modifier-aware rendering
allocators, including wlroots' SCANOUT|RENDERING allocations, request GPU
storage. GBM native-window ring storage/posting still needs repair: its
current lock/release bookkeeping does not establish a faithful rendered
front/back-buffer contract. This limitation is not a browser boundary.

The absolute pointer defaults to a fixed 0–65535 device range on both hosts.
Display pixels are converted to these device units by the KMS session
bridge, and SDL/libinput map them into the selected output. Mode changes
and pane resizing never alter the device range cached by those clients.
The low-level `setInputCanvasDims` API remains available for embedders
that explicitly configure a different input producer's coordinate range.
Display setup, pane resizing, and guest modesets preserve that range too;
`setInputCanvasDims` is not a scanout-size notification.

Canvas-backed GL sessions draw into a host-owned offscreen framebuffer and
blit it to the canvas at presentation.
The SDK's GBM/EGL handoff reads dimensions from a registered live native
GBM window, without interpreting another backend's opaque window pointer.
EGL surface dimensions are stored independently of the current CRTC:
when SDL replaces its context before latching the new scanout, that old
scanout cannot override the new drawable and clear its completed frame.
Destroying a guest context retires its owned GL objects and shadow state,
including its current program, while preserving an independent EGL
surface and BO-owned GPU textures. The shared native WebGL context can
then serve a replacement context without replaying deleted objects. Recreating an EGL window surface
rebuilds that target before the guest's next draw, including when the GL
context survives. The shared-context multiplexer invalidates its cached
binding so the next submission binds the replacement target. GPU-backed
buffer producers retain their own targets. Node has no WebGL context and
continues to use the CPU scanout path.

The cursor plane accepts Linux's 28-byte `drm_mode_cursor` and 36-byte
`drm_mode_cursor2` layouts. Requests require DRM master and CRTC 1;
unknown flags, oversized images, and undersized buffers
fail before changing state. Images are tightly packed CPU-shared premultiplied ARGB8888
buffers, up to 64×64, independent of the allocation's original pitch,
matching [Linux's legacy cursor layout](https://github.com/torvalds/linux/blob/v6.6/drivers/gpu/drm/drm_plane.c#L959). The cursor plane is device state,
as Linux plane state is: its framebuffer, position, hotspot and one
reference on the image's buffer belong to the plane, not to the master
grant or the installing file. Dropping master neither hides nor clears it,
a new master sees it through `GETPLANE` and inherits it until it changes
it, and closing the installing descriptor leaves a legacy cursor image
alive and visible (an image that is one of the file's own framebuffers is
removed with that framebuffer, as Linux's `drm_fb_release` does).
Replacing or hiding the image releases the plane's reference. No DRM file
carries a cursor reference across fork or exec; the fork-state cursor slot
is always zero.

DRM cursor positions locate the image origin. Signed hotspot values are
virtualization hints and do not offset the image, following the
[Linux cursor contract](https://www.kernel.org/doc/html/v6.6/gpu/drm-kms.html).
SDL's KMS backend converts pointer coordinates to image coordinates on
motion, warp, and shape changes. This keeps nonzero-hotspot cursors aligned
without changing DRM semantics for other clients.

Cursor transport adds no required Wasm import. The
`kernel_kms_cursor_configure(version)` export accepts protocol 4 and returns
4, or negative `ENOTSUP` for other versions. Until negotiation, cursor
capabilities report zero and valid master cursor requests that reach the
kernel fail `ENOTSUP` before retaining a buffer. Both Node and browser hosts
negotiate support; a visible display is not required. The two cursor exports
were optional in ABI 50 and became required in ABI 51 through the export
lifecycle table. Current hosts refuse a mismatched protocol acknowledgment.

`kernel_kms_cursor_read(out, capacity)` returns 0 when unchanged, 40 after
copying one complete state, or negative `EINVAL` for a null/short output.
The 40-byte protocol-4 record contains eight reserved zero bytes (protocol 3
carried the master grant there), then eight 32-bit words: buffer ID, width, height, signed x/y, signed hotspot
x/y and actual framebuffer ID. Offset 36 is framebuffer identity, not a
reserved word. A displayed image has nonzero buffer and framebuffer IDs;
a disabled image has zero buffer, framebuffer, dimensions and hotspot.
Shared Rust constants generate the host values and the kernel-host snapshot.

Image and motion requests coalesce without losing framebuffer identity.
Before draining, the kernel reads the actual cursor plane under its global
lock; a master change does not alter the record. An authoritative disabled plane replaces a stale pending
or cached image once. A nonzero framebuffer mismatch returns `EIO` without
writing output or consuming pending state; no missing image is fabricated.
The host drains inside the vblank kernel entry before reading pixels, using
a scratch lease and owned copies, and rejects a record with nonzero reserved
bytes. Same-buffer, same-geometry images with different framebuffer IDs
are distinct replacements. The plane's reference keeps the presented image
alive; when the kernel destroys a buffer the host is still presenting (the
replacement record is already pending), the host stops presenting it rather
than read retired storage.

`KmsRegistry` refreshes the packed cursor image from its producer mapping
at vblank, using the shared GBM coherence boundary. It retains an owned
RGBA snapshot until pixels change; position-only updates reuse it. The
copy is bounded to the cursor image rather than the allocation size.
The worker composites this state
on a separate transparent canvas at vblank, independently of CPU, GPU,
or application-owned scanout, while the CRTC has no color stage.

The CRTC color stage is the legacy gamma LUT, which Linux applies to the
CRTC output after the planes are blended. The host reduces each 16-bit
entry to 8 bits as `drm_color_lut_extract` does; a table that maps every
value to itself is no stage at all, and the presenters then do exactly
what they do without a LUT. With a stage, every presenter shows the
blended, corrected frame. The 2D blit already converts each pixel on the
CPU, so it blends the cursor and looks each channel up in the 8-bit
table there (`host/src/dri/kms-gamma.ts`). Every WebGL presenter applies
the stage on the GPU instead (`host/src/webgl/kms-color-stage.ts`): the
table is a 256x1 texture uploaded once per LUT change, the cursor image
a texture uploaded once per image, and a fragment shader blends the
cursor and indexes the table per pixel with the same integer arithmetic
as the CPU stage, so both produce identical bytes and no frame is read
back to the CPU. The WebGL2 scanout presenter draws its raw scanout
texture through the stage at framebuffer size and then scales that
output as usual. A CRTC whose canvas a GL session owns (a direct GPU
scanout, a SETCRTC flip onto the session's canvas, an EGL window
present, or a frame drawn straight to the canvas) copies the frame into
a texture with a GPU blit and draws it to the canvas through the stage.
That texture keeps the frame before correction, so a new LUT or a moved
cursor is shown at the next vblank even when the guest presents nothing
more, and the frame is restored as presented when the LUT is cleared.
The cursor overlay shows nothing while the stage is active. Node and
browser run the same code. It never reads live guest memory during
that detached presentation phase and never exposes a partially drawn
application frame. Node retains the same state without a canvas.

Host address-space retirement distinguishes exec from process exit. Exec
flushes and removes old buffer mappings but retains buffer ownership and
DRM master state for open descriptions the kernel kept. The replacement
can map a retained handle into its new memory and recover its pixels.
Kernel close-on-exec and final-reference callbacks still destroy buffers
and release master state; trap/exit cleanup retains its process teardown
backstop. Both Node and browser use this same path.

Those kernel callbacks must finish, or the kernel stops. The kernel
retires a DRM buffer, framebuffer, master grant or GL session immediately:
`close`, `munmap`, `_exit` and `RMFB` have no POSIX failure for a host that
cannot release its copy, and the kernel goes on to reuse the address range
or file the object named. It then calls `host_gbm_bo_unbind`,
`host_gbm_bo_destroy`, `host_kms_rmfb`, `host_kms_drop_master` or
`host_gl_unbind`, which run synchronously in the kernel worker. Each either
completes (`dri_cleanup_status::COMPLETE`) or reports a fatal host fault:
the unmapped range must detach and its final writeback must reach the
buffer, the buffer's backing and every native GL view of it must be
deleted, and no GL execution may still hold a retired context. Whatever the
host failed to release could never be released again (a detached mapping's
lost bytes, a binding that would copy a reused range into the buffer, a GPU
object nothing will delete), so it is treated as the system breaking down,
not as a loss to record. The host reports the fault through the kernel
callback `onHostFault` with a message naming the operation, object, pid and
reason (`DriCleanupFault`, or `GbmMappingFault` from the buffer registry),
then throws out of the import. `CentralizedKernelWorker` turns
`onHostFault` into the same fatal shutdown as a trapped kernel export
(`onKernelFatal`, a `kernel fatal` diagnostic and worker termination), on
Node and in the browser alike. A host that returned anything but `COMPLETE`
would make the kernel trap (`syscalls::apply_dri_release_effect`). The exec
and exit backstop (`WasmPosixKernel.releaseProcessViews`) and the buffer
registry's own publication paths follow the same rule: a primed mapping
that has lost its address space or baseline cannot publish, and is fatal.
Native GL deletions are not deferred past these calls: the host keeps no
journal that would retry a refused deletion before later GL work, which
nothing guarantees will ever come.

The browser's optional image-owned `presentation.displayScale` advertises
a readable virtual monitor for bitmap interfaces. The guest mode, 96-DPI
reference dimensions, scanout, input range, and cursor use one grid. Without
that setting, the existing native-device-pixel and physical-size path is
preserved for compositors. See [display presentation](browser-support.md)
for its bounds and resampling limitations.

KMS display stats distinguish scene presentations from page flips. Cursor-plane updates do not increment scene presentation counters. Slot 0 counts
canvas presentations from the CPU/scanout presenters and successful direct
GL presents; slot 5 remains the kernel's `MODE_PAGE_FLIP` queue count. A
first frame drawn during `MODE_SETCRTC` need not issue a page flip. The
browser's restart indicator therefore samples the live presentation count
after stopping the old program and completes on a new presentation, including
for static menus. Cancelled progress subscriptions cannot revive the indicator
with late terminal output. These are host/UI changes; guest imports, the
stats buffer layout, and ABI 50 are unchanged.

`MODE_PAGE_FLIP` latches the new framebuffer as the host-side scanout immediately (`host_kms_set_fb`, same call `MODE_SETCRTC` makes, carrying the CRTC's viewport: the mode's active area at its panning offset; `host_kms_addfb` carries the plane offset, and every presenter shows exactly that region of the BO); the flip completes at the next vblank of the host's vblank pump (described below), which retires a `DRM_EVENT_FLIP_COMPLETE` into the fd's event ring only when the caller passed `DRM_MODE_PAGE_FLIP_EVENT`. Until that tick the CRTC is busy (`EBUSY`) whichever file queued the flip. Two consequences: libdrm's `drmModePageFlip → poll → drmHandleEvent` loop runs at refresh rate rather than ioctl rate, and any host-side consumer of the current scanout (the vblank pump's WebGL2 scanout presenter or the legacy 2D canvas blit used by CPU-rendered demos) always reads the most recently flipped buffer, never a double-buffered client's back buffer. The immediate latch is race-free because a well-behaved client fully paints a bo before flipping to it and only reuses the old bo after the flip-complete event.

The same tick drives `DRM_IOCTL_WAIT_VBLANK`. The kernel keeps a 64-bit vblank counter for the one CRTC, stamped with each vblank's `CLOCK_MONOTONIC` time, and follows `drm_wait_vblank_ioctl`: `RELATIVE`, `ABSOLUTE` and `NEXTONMISS` resolve a target once; a blocking wait returns `EAGAIN` onto the host's ordinary blocking-retry path, and the kernel keeps the resolved target per waiting task so the host's retries of the unchanged request continue the same wait; `_DRM_VBLANK_EVENT` queues a `DRM_EVENT_VBLANK` for the target vblank within the file's 4 KiB event space. When a tick queues an event or reaches a parked waiter's target, the kernel raises a coalesced flag that the host takes with `kernel_kms_take_vblank_wake` and wakes its parked retries at that vblank (Node and browser run the same pump). The counter runs only while the CRTC is lit (a mode set and connector DPMS On); turning it off sends queued vblank events and ends parked waits successfully, as `drm_crtc_vblank_off` does. Like Linux, the parked attempt leaves the request rewritten to its absolute target (`RELATIVE` cleared). When a handler signal ends the wait, the host's `EINTR` completion publishes that in/out argument (as it publishes every failed ioctl's argument), so libdrm's `drmWaitVBlank` retry, or an `SA_RESTART` resubmission, waits for the same vblank; the kernel forgets the task's record, so a later identical request is a new wait.

**When a vblank happens** (`host/src/dri/vblank-clock.ts`). Every mode the connector advertises refreshes at 60 Hz, and the pump in the kernel worker gives the kernel about 60 vblanks a second while it runs (from the first canvas or stats attach, or the first scanout; a kernel that never touches KMS has no pump). In Chromium and Firefox the kernel worker's `requestAnimationFrame` is the display: each vblank lands on a display frame and the host calls `kernel_vblank_elapsed` with the frame's age, so the kernel stamps flip events, `WAIT_VBLANK` replies, vblank events and out-fences with the frame's time (its `CLOCK_MONOTONIC` minus that age, never before the previous vblank). Frames are decimated to the mode's cumulative 60 Hz schedule: a 60 Hz display gives a vblank on every frame, a 120 Hz display on every other frame, and other faster rates a mix of frame spacings averaging 60 Hz (100–120 Hz panels give every other frame, 110 Hz 55 Hz, since no two vblanks come closer than 0.6 periods); a display a little faster than 60 Hz skips a frame now and then (60.05 Hz about one in 1200) so the counter keeps the mode's rate; a display or browser delivering fewer frames (a low-power 30 Hz throttle, a 50 Hz panel) gives one vblank per frame it shows, because a frame the browser cannot show is not a vblank. When no frame arrives for 2.5 periods (a hidden page: browsers stop or throttle animation frames there) and on Node, which has no display, a timer gives vblanks at the mode's rate, stamped when it fires, until frames resume. WHY frames: a free-running `setInterval(1000 / 60)` ran every 16 ms in Chromium at a phase unrelated to the display's, so about one display frame in 24 got two vblanks and under load composed frames were replaced before they were shown; Firefox ran the same timer at 58–59 Hz on the labwc desktop (about 52 Hz in an idle worker). WHY a hidden page keeps 60 Hz: the guest turned the CRTC on and only the guest turns it off (`ACTIVE`/DPMS, which stops the counter); a page nobody looks at is a monitor nobody watches, which on Linux keeps scanning out at its mode's refresh, and slowing or stopping vblanks there would make vblank counts disagree with the advertised mode or stall clients waiting for flips. The advertised mode stays 60 Hz on a 120 Hz display: the mode list does not follow the measured display rate, because the rate can change while a compositor holds a mode and Kandelo reports no connector hotplug to make it re-probe. Per engine (checked with Playwright's Chromium 153, Firefox 155 and WebKit 26.6, headless): Chromium and Firefox call a dedicated worker's animation frames on the display's frames, without any `OffscreenCanvas`, with the page's frame timestamps; WebKit's worker animation frames come from a 15 ms timer (`WorkerAnimationController`) stamped with the callback time, not from the display (the HTML standard leaves a worker's frame cadence to the browser), so a WebKit kernel worker (`isJavaScriptCoreUserAgent`) keeps the timer: following those frames ran the counter at 63 Hz undecimated and, decimated to 60 Hz, gave more doubled display frames than the timer on the labwc desktop in Playwright WebKit (39 and 60 per window against 21 and 42). Display-aligned vblanks on WebKit would need the page's own animation frames relayed to the kernel worker, which this does not do. A worker that cannot animate (the HTML standard has `requestAnimationFrame` throw `NotSupportedError` there) keeps the pump on the timer. While frames flow the pump's watchdog timer is re-armed at each frame and never fires, so the kernel worker wakes once per display frame (twice per vblank on a 120 Hz display) rather than once per 16 ms timer tick.

### Explicit synchronization (fences, `sync_file` and DRM sync objects)

Explicit synchronization lets independent programs order their GPU work
without implicit kernel bookkeeping: a Wayland client hands the compositor a
point on a timeline that becomes complete when its rendering is done
(`linux-drm-syncobj-v1`), and the compositor hands back a release point.
Every interface involved (`sync_file`, DRM sync objects, the dma-buf
implicit-fence ioctls, `EGL_ANDROID_native_fence_sync`, KMS in/out fences)
is defined over one Linux kernel object, the `dma_fence`, and two shapes
built from it: the fence array a `SYNC_IOC_MERGE` produces and the fence
chain a timeline sync object grows. `crates/runtime-core/src/dri/fence.rs`
reproduces those three shapes rather than modelling each interface, so the
cross-interface behavior programs rely on (merge a timeline point with
another fence, import that into a dma-buf, wait on it through a syncobj
eventfd) follows from one model.

Final-reference release walks owned fence containers iteratively. A long
sync-object timeline or nested array therefore uses bounded call-stack
space when retired. Shared children keep their other owners, weak poll
references do not retain the payload, and each pending host GL leaf queues
its native release exactly once when its last strong reference disappears.
Leaf-only release keeps the direct path and allocates no traversal storage.

**Fences and their sources.** A leaf fence is pending on one source until
it signals once, with an error (a negative errno) or without. A second
signal is a kernel invariant violation and stops the kernel. Sources:

- *Software*: signaled by a kernel operation. `DRM_IOCTL_SYNCOBJ_SIGNAL`
  and `TIMELINE_SIGNAL` attach already-signaled stubs, as Linux does; the
  kernel's software timeline (`SwTimeline`, Linux's `sw_sync`) is the shape
  a CRTC's out-fences use.
- *KMS*: a commit's completion at the vblank that retires it
  (`OUT_FENCE_PTR`), on the CRTC's own fence context; see the atomic
  **Fences** notes above for in-fences and latching.
- *Host GL*: a GL fence. Decision D-17 makes a fence on the virtual GPU's
  shared native context complete in submission order: every Kandelo
  consumer of its results (another session on that context, the KMS
  presenter) runs later in that same command stream, exactly as
  `eglWaitSync` already treats it, so it is created signaled and costs
  nothing. A fence on a *separate* native context has no shared command
  stream; the host retains it under a kernel-issued export id and the fence
  stays pending until the host observes its native status. The host polls
  only fences a waiter has enabled (poll/epoll, a parked wait, an armed
  eventfd), once per worker turn, because WebGL updates a sync's status
  only between tasks. Enabling is sticky, as Linux's
  `dma_fence_enable_sw_signaling` is, so a fence that a timed-out waiter
  enabled is still polled until it completes. That is deliberate: Linux
  never disarms a fence's completion path once a waiter armed it, the next
  waiter would have to arm it again at once, and the cost is bounded
  because a GL fence completes as soon as its already submitted work does
  (decision recorded with the maintainer, 2026-11-01). A context loss completes the
  fence with `-EIO`, as a device loss completes Linux fences with an error.
  The host learns of new work, and of fences the kernel released, only from
  the coalesced `IDX_FENCE_HOST_WORK` wake event, so a machine with no
  waited separate-context fence does no fence work at all.

**Waking waiters.** A signal (or a sync object gaining a fence) queues one
coalesced `TYPE_READABLE` wake record with the reserved index
`IDX_FENCE_READY`, which names no pipe; the host's existing broad retry then
re-runs parked sync-object waits and poll/select/epoll calls. It also
notifies epoll interests on `sync_file` and dma-buf descriptions and fires
armed sync-object eventfds. Nothing here runs while no fence changes.

**`sync_file`.** A read-only anonymous descriptor holding one fence:
`poll` reports `POLLIN` once it has signaled (a poller enables it);
`SYNC_IOC_MERGE` makes a new close-on-exec file whose fence completes when
both inputs have (signaled leaves drop out, one fence per context
survives, an all-signaled merge is a stub carrying the latest timestamp);
`SYNC_IOC_FILE_INFO` reports the file's name and status and, on request,
each unwrapped fence's timeline, driver, status and timestamp;
`SYNC_IOC_SET_DEADLINE` records a hint that no Kandelo source can act on.
`read` is `EINVAL`, `lseek` `ESPIPE`, other ioctls `ENOTTY`, and `fstat`
reports mode `0600` with no type bits, as for Linux's anonymous inode. The
descriptor shares its object across `dup`, `fork`, `posix_spawn` and
`SCM_RIGHTS`; the fork wire carries only the object's identity.

**DRM sync objects.** Every sync-object ioctl is render-allowed and works
on both nodes: `CREATE` (optionally signaled), `DESTROY`, `HANDLE_TO_FD`
and `FD_TO_HANDLE` (a close-on-exec syncobj fd, or `sync_file`
export/import at a point), `WAIT` and `TIMELINE_WAIT` (`WAIT_ALL`,
`WAIT_FOR_SUBMIT`, `WAIT_AVAILABLE`, `WAIT_DEADLINE` as a hint),
`RESET`, `SIGNAL`, `TIMELINE_SIGNAL`, `QUERY` (`LAST_SUBMITTED`),
`TRANSFER` and `EVENTFD`. Handles belong to the DRM open file description
(lowest free handle first, like Linux's idr) and are shared by its
aliases. A timeline point completes once it and every earlier point have
signaled; an unordered point starts a new chain context, as
`dma_fence_chain_init` does. Every pointer member is a `__u64`, so one
layout serves wasm32 and wasm64; the shorter encodings that older headers
produce (before `drm_syncobj_handle.point` and the waits' `deadline_nsec`
were added) are accepted too, zero-extended as `drm_ioctl` does. A blocking wait parks on the host's EAGAIN retry path
with Linux's snapshot rule: the fences a wait observes are those its
objects held when it began, or, with `WAIT_FOR_SUBMIT`, the first fence
attached afterwards. The kernel keeps that snapshot per waiting task across
retries and drops it when the call completes, its absolute deadline passes
(`ETIME`), a handler signal interrupts it, or the task or process goes
away. `TRANSFER` with `WAIT_FOR_SUBMIT` parks the same way for at most
five seconds. `EVENTFD` holds a reference on its eventfd and adds one to
its counter when the point's fence signals (or, with `WAIT_AVAILABLE`,
when it is attached).

**dma-buf implicit fences.** A PRIME descriptor's buffer carries its
reservation (`dma_resv`) for its lifetime. `DMA_BUF_IOCTL_IMPORT_SYNC_FILE`
adds a `sync_file`'s fences as writers or readers;
`DMA_BUF_IOCTL_EXPORT_SYNC_FILE` returns, as a new close-on-exec
`sync_file`, what an access must wait for (a read waits for writers, a
write for every fence; a stub when nothing is pending); and dma-buf `poll`
reports `POLLIN` once writers have signaled and `POLLOUT` once every fence
has. A KMS plane update without an explicit `IN_FENCE_FD` waits for its
framebuffer buffer's unsignaled writers, as `drm_gem_plane_helper_prepare_fb`
does (an explicit in-fence overrides them); while no buffer holds a fence
that costs one integer test per commit. GL rendering adds no implicit
fences: under D-17 it is complete in submission order.

GL work waits for implicit fences too, as a Linux driver makes a job that
reads a buffer wait for its writers and a job that writes it wait for every
fence (`crates/runtime-core/src/dri/implicit_sync.rs`). Kandelo's GL runs
synchronously, so there is no job queue to wait in, and deferring the work is
not truthful (the host reads the commands from the guest's own buffer, and
every later command, query and presentation depends on them). The GL entry
points that can read or write buffer contents (command and query submission,
presentation, image import and export, foreign-texture upload) therefore
wait before reaching the host until every fence of every buffer the process
names through its DRM files has signaled; fence queries, server waits and
surface limits do not wait. Draw sampling, EGLImage sibling copies, CPU-tier
mirror uploads and publication, and readback all happen inside those entry
points, so none of them can observe a buffer whose writers are unfinished or
overtake its readers. KMS scanout waits through the plane rule above. The
grain is coarser than Linux's (the kernel cannot see which buffers a
command buffer touches, so a process waits for any buffer it names, as a
writer would), which can only delay work, never reorder it. The wait cannot
deadlock: the only fences that can be pending are a GL fence on a separate
native context (the host observes its completion) and a KMS out-fence (the
vblank pump completes it); neither depends on a guest thread. It is
uninterruptible, because on Linux the call never waits and so never fails
with `EINTR`: caught signals stay pending until it proceeds, default
actions still apply. While no buffer holds a fence it is one integer test.

**EGL_ANDROID_native_fence_sync.** `eglCreateSync(KHR)` with
`EGL_SYNC_NATIVE_FENCE_ANDROID` creates a GL fence (condition
`PRIOR_COMMANDS_COMPLETE`), or, given `EGL_SYNC_NATIVE_FENCE_FD_ANDROID`,
takes ownership of that `sync_file` (condition
`NATIVE_FENCE_SIGNALED_ANDROID`; a descriptor that is not a `sync_file` is
`EGL_BAD_ATTRIBUTE` and stays the caller's). `eglDupNativeFenceFDANDROID`
exports a GL fence once through the private render-node ioctl
`DRM_IOCTL_WPK_EXPORT_FENCE` (the kernel asks the host with the
kernel-only query `QOP_EXPORT_FENCE` whether the fence is on the shared
context or must be retained) and returns close-on-exec duplicates.
Client waits and status on an imported sync poll its descriptor.
`eglWaitSync` on an imported sync sends `QOP_SERVER_WAIT` with the
descriptor and token 0: the kernel answers itself when nothing is pending
(`ORDERED`) or when a pending fence has no native command stream to wait in
(`CLIENT_SIGNAL`, after which the caller waits on the descriptor), and
forwards exactly one pending host fence to the host, which issues the
native `waitSync` when the destination shares that fence's context.

## Wayland kiosk compositor (`cage`)

`packages/registry/cage/` builds upstream cage 0.3.1 on upstream wlroots
0.20.2. cage runs one application as its whole session: it forks and execs
the client, shows its toplevel fullscreen on the one output, and exits with
the client's status. It reaches the platform the way a Linux compositor does:

- **Seat.** libseat's `noop` backend (`LIBSEAT_BACKEND=noop`) opens
  `/dev/dri/card0` and the evdev nodes directly. The first open of `card0`
  takes DRM master, so wlroots can modeset without SET_MASTER.
- **Device discovery.** libudev-zero walks `/sys` (see "Sysfs" in
  `docs/posix-status.md`) to find the card and the input devices, and
  watches an `AF_NETLINK` `NETLINK_KOBJECT_UEVENT` socket that never
  reports a hotplug.
- **Display.** The card advertises `DRM_CLIENT_CAP_ATOMIC`, so the wlroots
  DRM backend drives the atomic interface described above: one MODE_ATOMIC
  commit per frame (TEST_ONLY probes included) and CLOSEFB.
  `WLR_DRM_NO_ATOMIC=1` selects its legacy path (SETCRTC, PAGE_FLIP).
- **Rendering.** The card has a render node, so wlroots chooses its GLES2
  renderer. It opens `/dev/dri/renderD128`, creates a gbm device on it, and
  reaches EGL through the GBM platform (`EGL_KHR_platform_gbm`). The gbm
  allocator gives it GPU-tier scanout buffers
  (`gbm_bo_create_with_modifiers`); wlroots binds each one as an EGLImage
  renderbuffer and renders into it, and the page flip that scans it out
  blits it onto the display canvas, which cage's GL context claimed. A
  client's `wl_shm` buffer is uploaded as a texture with
  `GL_EXT_texture_format_BGRA8888` and `GL_EXT_unpack_subimage`. A
  readback into an XRGB8888 or ARGB8888 buffer (screencopy, for example)
  uses `glReadPixels` with `GL_BGRA_EXT`, which wlroots refuses without
  `GL_EXT_read_format_bgra`. WebGL 2 reads no BGRA layout, so the guest
  encoder asks the host for the native RGBA/UNSIGNED_BYTE read and
  converts the rows itself (byte swizzle, or ARGB4444/ARGB1555 packing)
  under the caller's pack alignment. A
  `linux-dmabuf` buffer is imported with `EGL_EXT_image_dma_buf_import`,
  zero-copy for a GPU-tier buffer (a GL client's) and copied from the
  dma-buf mapping for a CPU-tier one. The Node host has no WebGL2, so the
  GLES2 renderer cannot start there and a session must ask for the pixman
  renderer with `WLR_RENDERER=pixman`; pixman composites into DRM dumb
  buffers and reads a client's `wl_shm` pool by mapping the pool fd, a
  PRIME fd or a memfd.
- **Input.** libinput's udev backend reads the evdev devices, and cage
  routes keys and buttons to the focused toplevel.

cage offers no layer shell, data-control, tiling or multi-window layout, so
the desktops (`wldesktop`, `omarchydesktop`, `hyprdesktop`) and their shell
clients (Waybar, mako, quickshell, kclipd, qtgallery) stay on `wlcompositor`.

The browser shell image carries cage as a lazy file, and its `cage` machine
runs `cage -- wlterm`. The machine declares `kms-gl-scanout`, so the vblank
pump's WebGL2 scanout presenter shows the CRTC whenever no GL context owns
the canvas: before cage's GLES2 context claims it, after that context ends,
and for a session on the pixman renderer. The connector's preferred mode
follows the containing layout viewport's device pixels (or its explicit
bitmap render scale). The fitted guest canvas is not display authority:
changing a guest framebuffer's backing size or aspect must not withdraw
the monitor mode that the guest selected before its first page flip.
`LiveKernelHost.attachKmsDisplay` accepts a host-local `displayViewport`
element for this purpose, observes genuine viewport resizing, and never
sends that DOM element to a worker. Standalone canvas embedders may retain
the canvas itself as their physical surface. Closing or remounting a pane
retires or replaces the observation target. Terminal and demo dock
controls reserve the same row height, so switching views does not invent
a monitor resize while a hidden KMS pane is being measured.

Gates: `host/test/cage-smoke.test.ts` (a raw libwayland client gets a
configure, a presentation feedback after a real page flip, the keymap, a key
and a button), and foot, GTK3, libkwl and wlterm as session clients
(`host/test/{foot,gtk3,libkwl,wlterm}-smoke.test.ts`), all on the pixman
renderer. The tests share the session root in `host/test/wlroots-session.ts`.
`apps/browser-demos/test/kandelo-cage.spec.ts` gates the GLES2 renderer in
the browser.

## Wayland tiling compositor (`sway`)

`packages/registry/sway/` builds upstream sway 1.12 on the same wlroots
0.20.2 and seat, discovery, display and input path as cage, plus json-c for
its IPC. The package also ships `swaymsg`, `swaybar`, `swaynag` and the
upstream default config at `/etc/sway/config`; it is built without the tray
(no sd-bus provider), gdk-pixbuf or man pages.

On top of cage's path, sway forks and runs each config `exec` through
`/bin/sh`, tiles toplevels, and serves i3 IPC on a Unix socket
(`$SWAYSOCK`). It sets `SIGCHLD` to `SIG_IGN` and relies on the kernel
reaping its children.

Static linking puts sway's own `expand_path` and `list_insert` in the same
module as libxkbcommon's and libinput's internal functions of those names.
`wasm-ld` links such a signature mismatch with only a warning and replaces
the library's calls with traps, so the build renames sway's two symbols.

sway starts `swaybar` and `swaynag` itself: it forks, keeps one end of a
`socketpair` open across `exec`, and passes its number in
`WAYLAND_SOCKET`. Each client maps a layer-shell surface that reserves an
edge of the output. swaybar forks the bar's `status_command` through
`/bin/sh` and reads its stdout; a swaynag button runs its action through
`/bin/sh`. Upstream swaynag fills its unused Wayland listener slots with one
unprototyped function, and a WebAssembly indirect call traps on the type
mismatch, so `patches/0001-*` gives each slot a function of its event's
prototype.

Gate: `host/test/sway-smoke.test.ts`, on the pixman renderer in Node: two
clients from the config tile side by side in `swaymsg -t get_tree`, a click
focuses each and it receives a button and a key, and `swaymsg exit` ends the
session with status 0. A config `bar` block starts swaybar, which reserves
the bottom of the workspace and runs its `status_command`. A config error
starts swaynag, which reserves the top of the workspace, and a click on its
"Exit sway" button ends the session with status 0.

The browser shell image carries sway, swaybar, swaynag, swaymsg and swaybg as
lazy files, and its `sway` machine runs sway on the GLES2 renderer. Like the
`cage` machine it declares `kms-gl-scanout`, so a sway started again from
the machine's shell on the pixman renderer still reaches the canvas.
`apps/browser-demos/test/kandelo-sway.spec.ts` gates the GLES2 renderer,
swaybar, workspaces, tiling, swaynag's exit button and that restart.

## Wayland compositor (`wlcompositor`, `wlterm`)

The upstream Foot, mako, GTK and Qt clients use ordinary shared-memory
pool allocation. Their former Kandelo DRM-pool rewrites have been removed.
The compositor owns fd mapping, buffer offsets and texture upload; clients
need no renderer-specific pool allocator. Node exercises the same pool
protocol through CPU compositing, while browser specs exercise GPU drawing.

On top of the DRM/KMS + evdev surfaces above sits a real Wayland stack that runs entirely in-kernel — no host-side Wayland. `programs/wlcompositor/` is a Wayland server (a desktop machine's launcher script, `wldesktop` or `omarchydesktop`, starts it in the background and waits for its socket) built against a wasm32 port of `libwayland-server`: it owns the `card0` scanout (via the same KMSDRM/`libgbm` path SDL2 uses), reads input from `/dev/input/event0` (keyboard) and `event1` (pointer) through a real `libinput` 1.28.1 port, and exports the core protocol plus `wl_shm`, `xdg_shell`, `wl_seat`, `wl_output`, `zwp_linux_dmabuf_v1`, and `wp_presentation` (clock_id `CLOCK_MONOTONIC`; `presented` feedback carries the PAGE_FLIP timestamp, refresh interval, and flip sequence — the frame-pacing signal `foot` and other upstream clients consume), plus the logical-output/scale surface GTK3, Waybar and mako query: `wl_output` at v4 (`name`/`description` — mako binds v4 unconditionally), `zxdg_output_manager_v1` (v3; the single virtual output at (0,0), logical size = the mode), `wp_fractional_scale_manager_v1` (fixed `preferred_scale` 120 = scale 1), and `wp_viewporter` (per-surface crop + scale, honored by both compositing paths — nearest-sampled in the CPU blit, a uv sub-rect on the GPU quad; gated by `host/test/wlcompositor-protocols-smoke.test.ts`). Clients connect over a Unix socket at `/tmp/wayland-0` (`/` is a read-only rootfs and `/var/run` is `EACCES` for non-root, so the well-known runtime dir is `/tmp`). A `wl_shm` pool is any mappable fd the client passes over `SCM_RIGHTS` — a memfd, a `/dev/shm` file, or a `gbm` dumb BO's prime-fd — and the compositor maps it `PROT_READ`/`MAP_SHARED` at `create_pool` (remapping on `resize`, refusing a shrink, as libwayland's `wl_shm` does), so each buffer is read at its offset in that mapping and the kernel's shared-mapping coherence (see `mmap()` in `docs/posix-status.md`) carries the client's later stores into it at the compositor's syscall boundaries (`host/test/wlcompositor-shm-memfd-smoke.test.ts`). A dumb BO's prime-fd can also arrive over `zwp_linux_dmabuf_v1` (advertised at version 3, `XRGB8888`/`ARGB8888`/`XBGR8888`/`ABGR8888` + `LINEAR` only, no feedback; a GL client's buffer from `libwayland-egl` is `XBGR8888`, because a WebGL RGBA texture stores `[R,G,B,A]` bytes, and the compositor samples it without the red/blue swizzle it applies to `XRGB8888` `[B,G,R,X]` buffers): `zwp_linux_buffer_params_v1.create[_immed]` first imports the plane with `gbm_bo_import` as the claimed fourcc and refuses a buffer no import can sample (`failed`, or `invalid_wl_buffer` for `create_immed`): a plane outside its dma-buf, or a GPU-tier buffer made in storage that fourcc does not name. `add`/`create[_immed]` wrap the plane fd in a synthetic single-ref `shm_pool` so the resulting `wl_buffer` reuses the exact `shm_buffer` import/composite/destroy path — for a GPU-tier bo the downstream `BIND_FOREIGN_TEXTURE` is zero-copy. Compositing is GPU-first: at boot the compositor probes the renderD128 GLES bridge (shader compile via sync queries — they fail cleanly on hosts without WebGL2) and, when available, imports each client bo as a texture (`wpkEglImportDmabufHandle` with the buffer's real fourcc + `wpkEglBindBoTexture`, re-bound only for buffers dirtied by a commit) — a `wl_shm` buffer whose pool is no dma-buf, or that starts partway into its pool, is uploaded from the pool mapping instead (`glTexImage2D`, then `glTexSubImage2D` per dirtying commit, its bytes as `GL_RGBA` so the shader's swizzle matches an imported bo) — and renders wallpaper + z-ordered window quads + focus border in a single cmdbuf flush per frame; its GL context claims the CRTC canvas and the vblank pump's presenter stands down. Without GL (Node smokes, `WLC_NO_GPU=1`, or a runtime failure — which also terminates EGL so the pump presenter resumes), it falls back to CPU-blitting into the scanout buffer, reading `wl_shm` buffers from the pool mapping and `linux-dmabuf` buffers through `gbm_bo_import`. A lost WebGL2 context (a browser GPU-process crash) enters the same degrade chain through the present path: `host_gl_present` returns `-ENODEV` once the binding's renderer was lost (`host/src/webgl/renderer-loss.ts`; sticky across a later restoration of the same context object), `GLIO_PRESENT` propagates the errno, the guest's `eglSwapBuffers` fails with `EGL_CONTEXT_LOST`, and the compositor's repaint falls through to the CPU path and terminates EGL. An `ENODEV` reply on submit, query or make-current lets libEGL record the context reset; its failure-only checked scope receipt propagates known physical renderer loss to the share group while keeping logical A3 resets local. `glGetGraphicsResetStatus` (`GL_EXT_robustness`/`GL_KHR_robustness`) answers from the recorded state without another host request. Either way it keeps committing PAGE_FLIPs as the frame clock. Keymaps are compiled with a wasm32 `libxkbcommon` port and handed to clients as an mmap'd fd over `wl_keyboard.keymap`.

Kandelo-authored clients build on `libkwl` (`examples/libs/libkwl/`), a small toolkit over `libwayland-client` that wraps registry bind, an `xdg` CSD toplevel, double-buffered `wl_shm` back buffers, xkb keysym/UTF-8 translation, and a `kwl_dispatch` event loop; it exposes `kwl_display_fd()` so an app can `poll` the Wayland connection alongside its own fds. Drawing goes through `libwpkdraw` (`examples/libs/wpkdraw/`), a CPU rasterizer (alpha-blended clear/pixel/rect + an `stb_truetype` font engine over a bundled Inconsolata) that renders into a caller-owned ARGB buffer. `programs/wlterm/` is the first real client: a terminal that `forkpty()`s `sh` (bash, which every Kandelo image binds to `/bin/sh`), runs an in-tree VT100 core (`vt100.c`), and multiplexes the Wayland display fd and the PTY master fd in one `poll` loop — Wayland key events become PTY writes, PTY output feeds the VT100 grid and is rendered back into the libkwl window. Because `wlterm` forks, its wasm is mandatorily processed by `wasm-fork-instrument` (see [fork-instrumentation.md](fork-instrumentation.md)).

Libkwl uses libwayland's connection selection whenever `WAYLAND_DISPLAY`,
`WAYLAND_SOCKET` or `XDG_RUNTIME_DIR` is present. This lets a compositor
select a relative or absolute socket name or pass an inherited descriptor.
An explicit endpoint failure is returned to the caller; it does not connect
to another compositor. With all three variables absent, the original
in-tree desktop connection at `/tmp/wayland-0` retains its startup retry.


The terminal core honors VT100 scrolling margins (`CSI top;bottom r`),
including line feeds, delayed wraps, index, next line, and reverse index.
Only the selected region moves; fixed rows such as an editor's status line
remain intact. Valid margin changes home the cursor, invalid bounds are
ignored, and resizing restores full-screen margins. This is terminal behavior,
independent of the child program or package. The existing limited terminal
subset (including no alternate screen or VT100 line-drawing set) is unchanged.

The stack is dual-host: the Node smoke gates (`host/test/{wpkdraw,wlcompositor,wldesktop,wldesktop-liveness}-smoke.test.ts`) drive compositor+client harnesses (two-process for the single-client gates, compositor + wlclock + wlpaint for the desktop gates; `libkwl` and `wlterm` are gated under cage), and the browser demo (the `wayland` machine in the shell image, declared in `packages/registry/shell/source-rootfs-shell-demo.json`, listed in `apps/browser-demos/pages/kandelo/gallery-roster.json`, and gated by `apps/browser-demos/test/kandelo-wayland.spec.ts`) boots the compositor plus three clients — `wlclock` (animated clock), `wlpaint` (pointer painting), and `wlterm` — against `card0` mirrored to an `OffscreenCanvas`, with DOM keyboard input injected as evdev events and the pane's pointer bridge feeding `event1`. This is the same KMS-to-canvas + `BrowserInputSource` path the `modeset` and `sdl2` demos use. The pane opts into the vblank pump's WebGL2 scanout presenter (`mode: "webgl2-scanout"`: scanout-to-texture upload with shader-side XRGB→RGB swizzle, change-driven presents gated on the kernel commit count plus a ~15 Hz content-probe backstop, and GPU scaling at the pane's device-pixel resolution); in the browser the compositor's own GLES context then claims the canvas for GPU compositing (`markKmsCanvasGlOwned` — the presenter stands down, stats slot 7 flips to 3/`webgl2-gl`), while headless/Node runs stay on the CPU-composite + presenter pipeline. A legacy `mode: "2d"` putImageData blit remains available. See [browser-support.md](browser-support.md#wayland-desktop-demo).

### Tiling window manager (`WLC_LAYOUT`, workspaces, `kwlctl`, keybinds)

The same `wlcompositor` binary is also a Hyprland-class tiling WM (PR14); the floating desktop above is simply its default layout, so `/?demo=wayland` is unchanged. `WLC_LAYOUT=dwindle` selects the tiler.

- **Layout engine.** `compute_tiling(area, n)` is a pure function: it partitions the output among `n` windows by recursively splitting the remaining region along its longer side (Hyprland's dwindle default — near half to window *i*, remainder carried forward), insetting an outer gap from the screen edge and an inner gap between windows. `retile()` runs it over the mapped windows on the active workspace (in map order = z-order) and pushes each dictated size through the `xdg_toplevel.configure` path; `FLOATING` mode keeps the app_id placement rules and makes `retile()` a no-op. Because the tiler is pure, the Node gate predicts the exact partition and compares it against the emitted `TILE` markers. A surface enters that list only once it carries the `xdg_toplevel` role: a client's cursor surface (`wl_pointer.set_cursor` is accepted and ignored, since the host pointer already draws the sprite) commits a buffer under no role, and would otherwise map, take the keyboard, and claim a tile of its own. Waybar's cursor theme is the case that reaches it.
- **Workspaces.** Nine 1-based workspaces on the single output. Each surface carries a workspace id (assigned at first map); `surface_visible()` (mapped AND on the active workspace) gates compositing, input hit-testing, and tiling. `switch_workspace()` restores focus to the target's top window (z-order doubles as per-workspace focus memory); `move_focus_to_workspace()` sends the focused window away and re-tiles the remainder.
- **`kwlctl` IPC.** A control + event socket at `/tmp/kwlctl-0` (the hyprctl analog), polled in the compositor's `wl_event_loop` alongside the wayland + libinput fds. Verbs: `clients` / `workspaces` / `activeworkspace` / `activewindow` / `monitors` / `workspacerules` / `theme` (JSON queries, each also accepted behind hyprctl's `j/` prefix), `dispatch <workspace N|focusworkspaceoncurrentmonitor N|movetoworkspace N|close|exec <path…>|theme <name|next|prev>|sendshortcut MODS, KEY|kandelo:sendshortcutiftag TAG, MODS, KEY, MODS, KEY>`, and `--listen` (a newline-delimited `event>>data` stream in Hyprland's socket2 format). `dispatch exec` uses the non-forking `posix_spawnp` (`SYS_SPAWN`) — a `fork()` from inside an event-loop callback would wedge the server — and accepted control fds are `CLOEXEC` so they don't leak into spawned children. The CLI client is `programs/wlcompositor/kwlctl.c` (`KWLCTL_SOCKET` overrides the path).
- **Hyprland IPC compatibility.** The same command table and event bus are also served on Hyprland's own socket pair, where an unmodified Waybar looks for them: `/tmp/hypr/wlcompositor/.socket.sock` (request/reply) and `.socket2.sock` (the event stream, which needs no handshake — a client that connects is a listener). `main()` exports `HYPRLAND_INSTANCE_SIGNATURE=wlcompositor` and defaults `XDG_RUNTIME_DIR=/tmp`, so anything the compositor execs finds the directory. The query replies carry the `hyprctl -j` field set Waybar's `hyprland/*` modules read — window `class`/`title`/`workspace`/`floating`/`mapped`, workspace `id`/`name`/`monitor`/`windows`, and a single `virtual-0` monitor — and the events it subscribes to: `workspace`/`workspacev2`, `createworkspace`/`destroyworkspace` (+`v2`), `focusedmon`(`v2`), `activewindow`/`activewindowv2`, `openwindow`/`closewindow`, `movewindow`(`v2`), `windowtitle`(`v2`), in Hyprland's order: a new window's workspace is created, the window opens, then it takes focus. Window titles exist only for this: `xdg_toplevel.set_title` is stored on the surface and relayed, never drawn (clients keep their own CSD titlebars).
- **Keybinds.** A config-driven bind table parsed from `WLC_CONFIG` / `/etc/kandelo/wlcompositor.conf` (a hyprland.conf-shaped subset: `bind = MODS, KEY, DISPATCHER[, ARGS]`); absent config installs generic SUPER-based defaults, not demo-specific ones. Keys are intercepted in the compositor's keyboard path before the focused client: a bind matches on the pressed key's shift-independent base keysym plus an exact modifier mask. Modifiers: `SUPER` (Mod4), `SHIFT`, `CTRL`, `ALT` (Mod1) — the self-contained xkb keymap carries `Super_L`, both Shifts, `Control_L`, `Alt_L`, the four arrow keys, `F1`–`F12`, and the nav cluster (Home/End/PgUp/PgDn/Insert/Delete). `CTRL` exists because a browser reserves the Cmd/Win (`SUPER`) key, so the in-browser demo mirrors every `SUPER` bind onto `CTRL`. Dispatchers: `exec`, `workspace`, `movetoworkspace`, `killactive`, `cyclenext`/`cycleprev` (focus cycling without z-order reordering, so a tiled layout keeps its geometry). The `exec` dispatcher is how new panes are opened Hyprland-style — a per-app launch bind rather than a launcher UI: the `/?demo=hyprland` config binds `Return`→`wlterm`, `K`→`wlclock`, `P`→`wlpaint` (each on both `SUPER` and `CTRL`), and on the keypress the compositor runs `kwlctl_exec` → `posix_spawnp` of the `/usr/local/bin` binary, which connects as a new tiled client. Because bound combos are grabbed before the focused client, a `CTRL`-letter launch bind shadows the terminal's like-named control key in-browser; the clock is deliberately on `K` (not `C`) so `Ctrl+C` SIGINT still reaches `wlterm`. A real Hyprland session drives these on `SUPER` and avoids the clash entirely. `killactive` sends `xdg_toplevel.close` to the focused window; the client is responsible for tearing its surface down (the compositor retiles once the surface is destroyed). `wlterm` closes its window immediately and sends `SIGHUP` to hang its shell up. The platform also wakes blocked PTY reads and readiness waits when the final endpoint closes, so peer hangup is observable without waiting for a retry timer. The `ARGS` field is the rest of the line, commas included, as in Hyprland.
- **`sendshortcut` and window tags.** `sendshortcut, MODS, KEY` (Hyprland's dispatcher) delivers a chord to the focused surface as `wl_keyboard` events: a `modifiers` event carrying exactly the chord's modifiers, the key's press and release, then a `modifiers` event restoring the real state. The chord's modifiers replace the held ones rather than merging with them, so `SUPER+V` bound to `sendshortcut, CTRL SHIFT, V` reaches the client as Ctrl+Shift+V while SUPER is still physically down (the problem Omarchy's `clipboard.lua` works around). Hyprland's optional third argument, a target window, is not supported and must be empty. `windowrule = tag +NAME, class:REGEX` tags every window whose `app_id` the POSIX extended regex matches in full; `kwlctl clients`/`activewindow` report the tags. `kandelo:sendshortcutiftag, TAG, MODS, KEY, MODS, KEY` sends the first chord when the focused window carries `TAG` and the second otherwise. It has no Hyprland equivalent: Omarchy chooses the chord in a Lua function (`universal_clipboard_shortcut`), and `wlcompositor` has no Lua, so this dispatcher is a Kandelo stand-in for that one function, and its `kandelo:` prefix (the namespace style of Hyprland plugin dispatchers) says so in the config. Rules support only `tag +NAME` and only the `class:` matcher; anything else is refused with a message on stderr.
- **Clipboard (the selection).** `wl_data_device_manager` v3 and `zwlr_data_control_manager_v1` v2 share one selection per seat. A client sets it with `wl_data_device.set_selection` (a serial older than the current selection's is dropped, as wlroots does) or, with no window and no serial, through data-control (a clipboard tool or agent). Setting it sends `cancelled` to the source it replaces. The compositor offers the selection — a fresh `wl_data_offer`, one `offer` event per MIME type, then `selection` — to a client just before that client receives keyboard focus, again when the selection changes while it is focused, and when it creates its data device while focused; data-control devices receive every change regardless of focus. A paste is `wl_data_offer.receive(mime, fd)`: the compositor forwards the fd to the source client as `send(mime, fd)` and closes its own copy, so the two clients exchange the bytes over the pipe directly (the pipe's write end crosses the Wayland socket twice by `SCM_RIGHTS`) and the compositor never reads them. An offer whose source is no longer the selection gets its fd closed at once, so the reader sees EOF. Drag-and-drop (`start_drag` is a no-op; an offer's `accept`/`finish`/`set_actions` are accepted for v3 clients) and the primary selection (neither `zwp_primary_selection` nor data-control's `set_primary_selection`) are not implemented. Gated by `host/test/wlcompositor-clipboard-smoke.test.ts` with the `programs/wlcompositor/wlclip-test.c` client.
- **Server-side decoration.** The compositor advertises `zxdg_decoration_manager_v1` and negotiates the mode by layout: `dwindle` → `SERVER_SIDE` (a tiled window has no titlebar), `floating` → `CLIENT_SIDE` (the client keeps its CSD titlebar). A libkwl client honors the negotiated mode (`decoration_configure`): under SSD it sets its titlebar height to 0 and treats all pointer events as content, so the tiled desktop looks like Hyprland.
- **Client-side resize.** The compositor composites each surface at its **native** buffer size (`blit_surface` does not scale to the tile; the one exception is an explicit `wp_viewport` destination, which scales that surface's committed source rect), so tiling requires the *client* to resize into the size the compositor dictates. `retile()` sends `xdg_toplevel.configure(w,h)`; libkwl records it and, on the `xdg_surface.configure` ack barrier, rebuilds both `wl_shm` buffers at the new size and pushes a `KWL_RESIZE` event (new content w/h). Clients react: `wlclock` recomputes its dial geometry, `wlterm` reflows its VT100 grid (`vt100_resize` + `TIOCSWINSZ` + `SIGWINCH`), `wlpaint` reallocates its canvas (preserving the painting) so the toolbar + drawing area fill the whole tile rather than a fixed 640×420 corner. The initial `get_toplevel` `configure(0,0)` ("you decide") is ignored, so a floating client (`/?demo=wayland`) never resizes and is byte-identical to before.

These are entirely in-kernel (client↔compositor over the wayland + `/tmp/kwlctl-0` sockets) — no host-runtime change — and gated by `host/test/wlcompositor-{tiling,resize,kwlctl,keybind,decoration,clipboard}-smoke.test.ts`. The browser's Hyprland machine (the shell image's `hyprland` profile, whose `/usr/local/bin/hyprdesktop` launcher sets `WLC_LAYOUT=dwindle` and `WLC_CONFIG=/usr/share/kandelo/hyprland/wlcompositor.conf`; gated by `apps/browser-demos/test/kandelo-hyprland.spec.ts`) boots the same compositor plus a `wlclock` and two `wlterm` terminals, which tile into gapped borderless frames and resize into their tiles — the first end-to-end Hyprland-class desktop. `wlpaint` is in the image but not started, so the `Ctrl+P` launch bind summons it on demand. See [browser-support.md](browser-support.md#hyprland-tiling-demo).

### Desktop shell (`zwlr_layer_shell_v1`, `kbar`, `klauncher`, themes)

A tiling WM is not yet a desktop: a desktop also has a bar, a launcher, and a
theme. Those are ordinary Wayland clients, but they need a protocol that lets a
surface anchor to an output edge and reserve space from the windows — which is
what `zwlr_layer_shell_v1` is, and what Quickshell, Waybar, mako and every
other shell component speak. The compositor implements it (protocol XML
from the `wlr-protocols` package,
`share/wlr-protocols/unstable/wlr-layer-shell-unstable-v1.xml`), and the
in-tree clients below consume it. This is the **O1** milestone of
[docs/plans/2026-07-14-build-hyprland-class-compositor-plan.md](plans/2026-07-14-build-hyprland-class-compositor-plan.md).
The Omarchy machine runs Quickshell in every one of these slots instead
(see [browser-support.md](browser-support.md#omarchy-desktop-demo)); the
in-tree clients stay as the dependency-free shell the layer-shell and theme
smokes gate on.

Three more protocols carry what a Quickshell shell needs from its
compositor beyond layer-shell, each served the way Hyprland serves it:

- **`hyprland_global_shortcuts_v1`** — a client registers a shortcut by
  `app_id` and `id`, and a `bind = MODS, KEY, global, app_id:id` config
  line makes the compositor send `pressed` on the key's press and
  `released` on its release (to the shortcut the press went to, whatever
  the modifiers are by then). The key never reaches the focused client. A
  bind naming a shortcut nobody registered prints `SHORTCUT_UNBOUND`.
- **`ext_idle_notifier_v1`** (v2) — one timer per notification, restarted
  by every keyboard or pointer event; `idled` after the timeout, `resumed`
  on the next input. No idle inhibitor exists here, so both request kinds
  behave the same.
- **`ext_session_lock_v1`** — `lock` blanks the output: every frame is
  opaque black under the lock surface alone, the keyboard and pointer reach
  nothing else, and keybinds stay off. `locked` is sent from the flip
  handler, once a blanked frame is on screen. The lock surface is
  configured to the whole logical output and must commit exactly that size
  after acking (protocol errors otherwise). `unlock_and_destroy` restores
  focus; a lock client that dies leaves the session locked
  (`SESSION_LOCK_CLIENT_GONE`) until another client takes it over, and a
  second lock request while one is held gets `finished`.

- **Layer shell.** A `wl_surface` given the layer role carries a layer
  (background/bottom/top/overlay), an anchor mask, margins, an exclusive zone
  and a keyboard-interactivity mode; the surface joins `g.layers` at role
  creation, because the protocol's initial commit carries no buffer and exists
  only to fetch the configure that tells the client its size.
  `layers_arrange()` walks the layers background→overlay, anchors each surface
  inside the area left by the ones before it, and sends
  `zwlr_layer_surface_v1.configure` when the box changes. What remains after
  every **mapped** surface's exclusive zone is `g.usable`, the work area
  `retile()` partitions — so a bar shrinks the tiling area rather than covering
  a window. A surface with a role but no buffer reserves nothing, so a client
  that dies mid-handshake cannot strand a strip of the desktop. Compositing and
  hit-testing put background/bottom under the windows and top/overlay over
  them, on both the GPU and CPU paths; a layer surface shows on every workspace.
  `EXCLUSIVE` keyboard interactivity takes the keyboard for as long as the
  surface lives, and focus falls back to the topmost window when it goes away.
- **`kbar`** (`programs/kbar.c`) — the Tier-1 status bar: a
  30 px top-anchored layer surface with a matching exclusive zone, rendering
  workspace pills, the focused window's app id, the kernel's monotonic uptime,
  and a clock. Its state comes
  from `kwlctl`. It subscribes to `--listen` and waits for the server's
  acknowledgment before querying `workspaces`, `activewindow`, and `theme`.
  Changes during those queries or the first frame commit remain queued on
  the event stream, so startup cannot lose a theme switch. The stream is
  polled alongside the Wayland fd, which is
  the same feed Quickshell's Hyprland module takes from the Hyprland IPC pair
  (see the Hyprland IPC compatibility bullet above).
- **`knotify`** (`programs/knotify.c`) — the notification toast, the
  notify-send slot: one toast per process, a corner-anchored overlay surface
  (margins via `zwlr_layer_surface_v1.set_margin`) that shows
  `knotify <title> <body…>` for a moment and exits — the surface teardown is
  the dismissal. The compositor's `notify = <path>` config key spawns it on
  every theme switch. The omarchy browser demo points that key at
  `notify-send` (`programs/notify-send.c`) — a gdbus client that
  calls `org.freedesktop.Notifications.Notify` over the `dbus-daemon`
  session bus, where the Quickshell shell's notification server owns the
  name and renders the card as its own layer-shell surface.
- **`klauncher`** (`programs/klauncher.c`) — the Tier-1 launcher: a
  centred overlay-layer surface with exclusive keyboard interactivity, filtering
  a registry of `KLAUNCHER_APPS_DIR/*.conf` entries (`name` + `exec`) as
  you type. Enter hands the command to the compositor over `kwlctl dispatch
  exec` and dismisses; the launcher itself never forks. `klauncher --menu`
  opens a menu instead: a root level (Apps, Theme) that descends
  into the app list or the installed-theme list (read from `kwlctl theme`,
  switched with `dispatch theme`); ESC in a submenu returns to the root.
  The Omarchy machine's launcher is the Quickshell shell's, reading
  `.desktop` entries.
- **Themes.** A theme is a directory holding one `theme.conf` under
  `/usr/share/kandelo/themes` (`WLC_THEME_DIR` / `KANDELO_THEME_DIR` override
  the root) — the same file-based design Omarchy uses. The compositor reads the
  border colour, gaps and wallpaper; the shell clients read the bar,
  foreground, muted and accent colours; unknown keys are skipped, so one file
  serves both sides. A theme's wallpaper is either the two gradient colours or
  a `wallpaper = <file>` image in the KWLP raw-pixel format (`"KWLP"`, u32le
  width/height, XRGB pixels) that the compositor bilinear-scales to the
  output — raw pixels because nothing in the compositor decodes PNG/JPEG;
  whoever builds the theme renders the image. The themes in the shell image
  ship gradients only for now (see
  [browser-support.md](browser-support.md#omarchy-desktop-demo)). `theme = <name>` in the
  compositor config selects the
  startup theme, and `kwlctl dispatch theme <name|next|prev>` (or a `theme`
  bind) switches live: gaps re-tile, the wallpaper is re-rendered and
  re-uploaded to its GL texture, and `theme>>name` on the event stream tells
  every shell client to reload its own palette. `kwlctl theme` reports the live
  name plus the installed set, so a client that starts later still matches.

Gated by `host/test/wlcompositor-{layer-shell,theme}-smoke.test.ts` and, in the
browser, by `apps/browser-demos/test/kandelo-omarchy.spec.ts` (the Omarchy
machine).
See [browser-support.md](browser-support.md#omarchy-desktop-demo).

### Stock upstream clients (`foot` + the font stack)

Every client above is Kandelo-authored on `libkwl`. `foot` 1.17.2
(`packages/registry/foot/`) is the first upstream Wayland
client: stock `wl_display_connect()` (via `XDG_RUNTIME_DIR`), stock
xdg-shell/SSD negotiation, and a real font pipeline. Its ordinary memfd
`wl_shm` pools are mapped by wlcompositor; the earlier DRM-pool patch and
its GBM link are removed. The remaining declared patch,
`0002-serial-font-loading.patch`, serializes font loading (the recorded
concurrent `FcFontMatch` pattern-double corruption remains separate
platform work).
foot forks its shell (`slave.c`), so its wasm is mandatorily
fork-instrumented; it runs with `--term=vt100` because no foot terminfo is
staged in any VFS image.

What it took, on each side of the protocol:

- **Compositor surface for stock clients.** `wl_subcompositor` (subsurfaces
  composited glued to their parent — foot's URL/search overlays),
  `wl_data_device_manager` v3 (foot binds it unconditionally; it carries
  the clipboard between windows, see the tiling section's clipboard
  paragraph), `wl_seat` at v5 (`repeat_info` + pointer `frame` events),
  `wl_surface.enter` at map, and `wl_output` `scale`+`done` with a physical
  size of 0×0 — sending pixels as millimetres made foot derive a 25.4 DPI and
  garble its font reload. `wp_presentation` (above) is its frame clock.
- **The font stack.** Four library packages feed it: `freetype` 2.13.3
  (rasterizer), `fontconfig` 2.15.0 (font discovery — reads the config
  `FONTCONFIG_FILE` names and scans the font dirs it lists), `fcft` 3.1.9 (the
  glyph-cache layer foot draws with) and `tllist` 1.1.0, over `pixman` 0.42.2
  and `utf8proc` 2.9.0. Gates: `host/test/fontstack-smoke.test.ts` and the
  per-package `host/test/{pixman,utf8proc}-smoke.test.ts`.
- **Kernel: signals interrupt host-converted epoll waits.** foot's SIGCHLD
  reaper parks in `epoll_pwait` with the signal unblocked only inside the
  wait. The host runs epoll_pwait itself as poll retries
  (`handleEpollPwait` in `host/src/kernel-worker.ts`), so it swaps the
  thread's signal mask through the kernel exports
  `kernel_swap_poll_sigmask` / `kernel_restore_poll_sigmask` for the whole
  wait, and the wait ends with EINTR once a signal the mask allows is
  deliverable. A kernel without those exports is refused, not run with the
  mask silently ignored.

Gated end-to-end by `host/test/foot-smoke.test.ts` (foot as the session
client of cage: connect, fontconfig+fcft startup, a mapped toplevel through
the gbm pool path, keys typed into its forked `dash`, clean exit). In the
browser, foot is a launcher entry of the Omarchy machine — a lazy binary at
`/usr/local/bin/foot`, with the desktop's `fonts.conf` and Inconsolata under
`/usr/share/kandelo/fonts` — gated by
`apps/browser-demos/test/kandelo-omarchy.spec.ts`.

### Full libffi (generated dispatch + static closure trampolines)

The glib/gobject tier needs real `ffi_call` (doubles, i64, by-value structs)
and `ffi_closure` — which on native targets JIT-writes trampolines. wasm32
cannot generate code at runtime, so `packages/registry/libffi/` is a
from-scratch port built on two facts of clang's wasm32 C ABI lowering: a
struct whose only member (recursively) is one scalar travels as that scalar,
and every other by-value struct is a pointer at the wasm level (`byval`
argument copies, hidden leading `sret` return pointer) — so every signature
collapses to word classes {i32, i64, f32, f64}. `gen-dispatch.sh` enumerates
signature families into two generated TUs: a `switch` of `call_indirect`
shapes for `ffi_call` (every arity ≤ 8 with at most two non-i32 args, plus
all-i32 up to the Wayland ceiling of 22, times five return classes) and a
static trampoline pool for closures (N real C functions per signature class,
baked into the function table; `ffi_prep_closure_loc` binds a free slot and
pool exhaustion aborts naming the class). A signature outside the generated
families aborts printing its key — coverage is a one-line bound change in the
generator. `ffi_cif` deliberately gained no fields across the rewrite:
libwayland embeds it by value, so its cached archive stays ABI-compatible.
Gated by `host/test/libffi-full-unit.test.ts` (native + wasm-under-kernel
matrix over arities × types × call/closure via `programs/libffi_full_test.c`)
and `host/test/libffi-shim-unit.test.ts` (the PR1 Wayland arity gate, kept
green through the rewrite).

## Signal Subsystem

Signals are delivered at syscall boundaries. When a process has a pending signal:

1. `kernel_handle_channel` checks for pending signals after each syscall
2. If a signal handler is registered (SA_SIGINFO), the kernel writes signal info to the channel's data buffer
3. The glue reads the signal info and calls the handler on the process's stack
   (or alternate signal stack if SA_ONSTACK). For a ppoll/pselect replacement
   mask, handler setup starts from that current replacement mask, then adds
   sa_mask and the delivered signal.
4. After the handler returns, the glue calls `SYS_RT_SIGRETURN` for
   handler-frame state and applies the signal record's exact old mask with
   `SYS_SIGPROCMASK`. For ppoll/pselect, the record contains the mask current
   at delivery while Rust retains a per-TID LIFO wait context. A restarted
   ppoll therefore preserves its replacement mask through resubmission;
   terminal completion or exact post-handler cancellation restores the
   pre-wait mask once. Nested ppoll, pselect, sigsuspend, and pause calls own
   separate contexts. `sigsuspend` and `pause` use that same exact
   post-handler cancellation to restore their pre-wait mask before returning
   `EINTR`. `longjmp` and `siglongjmp` retire abandoned handler/wait contexts;
   `siglongjmp` then applies the jump buffer's saved mask when requested.
5. If the signal interrupted a blocking syscall, EINTR is returned

A terminating default signal is checked before it consumes its queued
instance or changes mask-wait and handler bookkeeping: while a prepared exec
target has an uncertain native close, the Rust `try_*` signal helpers return
`SignalProgress::ProtocolFaultOwned`, which retains the queued signal,
process resources and existing signal state. Legacy delivery calls and the
host-free default signal consumer fail closed if they bypass that ordering.

PTY input follows the same completion path as other signal ingress on both
Node and browser hosts. After the line discipline queues an ISIG signal to
the foreground process group, the host drains kernel wakeup events and
retires signal-killed workers before notifying terminal observers. This also
collects interrupted kernel-owned sleeps immediately; a nanosleep has no
host retry callback that keyboard input could otherwise wake.

The host distinguishes the kernel's internal `EAGAIN` retry sentinel from a
completed nonblocking `EAGAIN`. When a caught signal is prepared while an
internal retry is still blocked, the host publishes `EINTR` without discarding
the prepared `CH_SIG` record. Libc runs the handler before deciding whether
`SA_RESTART` permits resubmitting that syscall.

Features: RT signal queuing with `si_value`, cross-process `kill`/`killpg`, `sigaltstack` with shadow stack swap, `sigsuspend`, `sigtimedwait`, `setitimer`/`alarm` via host timers.

The exception is a channel request whose completion is owned by
process-worker JavaScript. Its ABI 43 request flag tells the kernel not to
dequeue a caught signal into a record that JavaScript cannot consume. The
signal remains pending until libc makes the explicit ordinary-channel
checkpoint after `fork`, `clone`, or a staged-loader import. Handler invocation
and `rt_sigreturn` therefore still occur on the guest side after the host
import has returned.

Exact-thread delivery never degrades into process-wide delivery. `tkill` and
`tgkill` resolve their target against retained live task records in the calling
process; TID 0 and unknown or exited TIDs return `ESRCH`. Cross-process
exact-thread delivery is not yet supported.

POSIX timer scheduling is split at an explicit ownership boundary. The shared
Node/browser host owns wall-clock `setTimeout`/`setInterval` scheduling, while
the kernel owns the timer object, notification-pending state, exact
`SIGEV_THREAD_ID` target, `SI_TIMER` metadata, overrun accounting, and queued
signal lifetime. At each expiration the host calls the ABI-required
`kernel_posix_timer_fire` export and wakes only the thread selected by the
kernel (or the eligible process-wide waiters for `SIGEV_SIGNAL`). The host does
not synthesize timer signals or fall back to a process-wide notification.

Musl implements POSIX `SIGEV_THREAD` with a detached helper pthread and an
exact-thread kernel notification. The helper retains the callback and native
`union sigval` locally. Other timer notifications stage the complete generated
caller-native 64-byte `sigevent`; the process pointer width selects the union
width, and Rust retains its raw bits in a `u64`. The fixed channel delivery
record also carries eight raw value bytes. A wasm64 recipient therefore
receives the complete `sival_ptr`; a wasm32 recipient receives the
target-native low 32 bits. The glue reconstructs the recipient's native union
with `memcpy` so it does not select the wrong union member.

POSIX message-queue notification uses the same Rust-owned signal metadata.
Registration accepts a `SIGEV_SIGNAL` notification only when
`1 <= signo < NSIG`; the first message sent to an empty queue queues one
`SI_MESGQ` record with the registering process's complete `union sigval` and
authoritative sender credentials. The small host drain record is only a wake
instruction—the host does not synthesize a second signal or replace the queued
metadata.

Normal exit status and signal termination are stored separately. `_exit()` and
`exit_group()` retain the low eight status bits, including values 128 through
255; a default terminating signal records its signal number independently.
`waitpid()` therefore emits the POSIX wait encoding without guessing that a
high normal exit code was a signal, while host lifecycle callbacks may still
present the conventional shell-style `128 + signal` value.

Child status is a Rust-owned, per-process record covering stop, continue, and
termination. POSIX replacement semantics apply: a new transition replaces
older unconsumed status, ordinary waits consume it, and `waitid(WNOWAIT)` only
peeks. Stopped and continued reports never reap; consuming termination status
does. The host validates every guest output range before asking the kernel to
consume a record, so an `EFAULT` cannot lose child status or reap a zombie.

Default stop actions park execution cooperatively at the syscall boundary. The
kernel emits a process-transition event, and the shared Node/browser host holds
prepared completions by exact channel identity, including every pthread
channel, until SIGCONT. SIGCONT changes state immediately even when blocked,
ignored, or caught; SIGKILL can terminate a stopped process. Current Wasm
workers do not provide arbitrary-instruction preemption, so CPU-bound code that
never reaches a syscall cannot be suspended immediately; that boundary is
documented in `posix-status.md` rather than hidden behind host-specific behavior.

## Browser-Specific Architecture

In the browser, an additional layer wraps the kernel:

```
Main Thread                              Kernel Worker
├── BrowserKernel (thin proxy)           ├── CentralizedKernelWorker
├── UI code (HTML/JS)                    ├── Kernel-owned `/` (rootfs + tmpfs)
├── App clients (MySQL, Redis)           ├── Kernel Wasm instance
├── HTTP bridge / TCP injection          ├── Process sub-workers
├── Local virtual network                ├── POSIX socket routing
└── PTY terminal (xterm.js)              └── Connection pump, blocking retries
```

**`BrowserKernel`** (`host/src/browser-kernel-host.ts`): Main-thread proxy that communicates with the browser kernel worker via `postMessage`. This is host/runtime code, maintained beside the Node.js host (`host/src/node-kernel-host.ts`). Browser apps and demos consume it; they do not own it. The current API has two boot paths:

- `kernel.boot({ kernelWasm, vfsImage, argv, env, ... })` — preferred. The main thread zstd-decodes the image and transfers the bytes; the kernel parses it and serves `/` itself, and the worker exec()s `argv[0]` as the first user process. The main thread keeps no filesystem state, and all FS operations stay inside the kernel.
- `kernel.spawn(programBytes, argv, opts)` — legacy. Posts the wasm bytes to the kernel worker; the Rust `ProcessTable` allocates the PID, then the worker attaches host state, starts the process worker, and returns the assigned PID. Kept for transient binary launches (REPLs, test runners, benchmarks) that the kernel can't currently load via fork+exec from a baked binary.

The remaining methods (`pipeRead`/`pipeWrite`, `injectConnection`, stdin/PTY routing, framebuffer registry mirroring, HTTP bridge handoff) are pid-addressed and work the same in both boot paths.

**Browser kernel worker** (`host/src/browser-kernel-worker-entry.ts`): Dedicated web worker that hosts `CentralizedKernelWorker`, following the standard architecture requirement. Process workers are sub-workers created by the kernel worker. Syscall notification remains event-driven through `Atomics.waitAsync`, not channel polling. The browser config uses batch size 1 so every relisten and already-`PENDING` dispatch is deferred through the MessageChannel-backed `setImmediate` queue; this keeps syscall handling and worker messages progressing together under multi-process bridge load. Node.js retains its native/default batching unchanged.

**dinit service supervisor** (`packages/registry/dinit/`): Service-supervised demos boot dinit v0.19.4 (cross-compiled to wasm32) as the first user process via `kernel.boot({ argv: ["/sbin/dinit", "--container", ...] })`. It receives the first kernel-allocated user PID (100); PID 1 remains the kernel's synthetic init reservation. The service tree is baked into `/etc/dinit.d/*` at image-build time via `addDinitInit()` in `dinit-image-helpers.ts`. Service types in use: `process` (long-running daemons), `scripted` (one-shot bootstraps that exit cleanly), and `internal` (dependency-only nodes used to express "boot the whole tree" or "pick this engine"). dinit reaps its directly supervised children. A service that daemonizes by double fork leaves its grandchild to synthetic init, which the kernel reaps (see "Orphan adoption"); dinit is not a subreaper here because it requests `PR_SET_CHILD_SUBREAPER` only under `__linux__`. dinit disables restarts by default and enforces inter-service `depends-on` ordering.

**Service Worker** (`apps/browser-demos/public/service-worker.js`): Dual-mode file that acts as both a page bootstrap script (registers itself, enables cross-origin isolation) and a service worker (adds COOP/COEP headers, handles HTTP bridge routing).

### Linux-compatible graphics devices

Kandelo exposes a small Linux-shaped graphics stack through virtual character
devices:

- `/dev/dri/renderD128` accepts the render-node subset used by `libdrm`,
  `libgbm`, EGL, and GLES userspace shims.
- `/dev/dri/card0` adds the KMS subset used for one virtual connector, encoder,
  CRTC, dumb buffers, framebuffer objects, `SET_MASTER`, `SET_CRTC`, and
  `PAGE_FLIP` events.
- `/dev/fb0` remains the simpler framebuffer path for software that writes a
  linear BGRA buffer directly.

KMS now uses device-wide object IDs and framebuffer IDs. Inherited open
file descriptions share their framebuffer table; the last reference removes
its entries. Connector and property queries preprobe every nested output
before writing any of them. The full dynamic mode catalog and cursor path
remain available. See [the compatibility inventory](graphics/compatibility-v1.md)
for implementation and validation status.

The kernel owns the device ABI, fd-local GEM handles, DRM-master ownership,
KMS framebuffer refcounts, BO mmap authorization, and process lifecycle
cleanup. User programs cannot mmap an arbitrary BO id: the mmap offset must
come from `DRM_IOCTL_MODE_MAP_DUMB` on the same open file description. On
`munmap`, `exec`, `exit`, or final fd close, the kernel unbinds BO and GL
memory from the host before those Wasm memory ranges can be reused.

Pixel and GL execution are host responsibilities. The TypeScript host keeps
GBM BO metadata/SAB snapshots, KMS scanout state, and WebGL contexts. GLIO
command buffers live in the user process's Wasm memory; `libGLESv2.a` appends
TLV commands, the kernel validates the submitted range, and the host decodes
the commands against a browser `WebGL2RenderingContext` or a test double in
Node.js. The kernel does not contain GL rendering code.

GL always executes in the kernel worker, on both hosts. Command submission,
queries, and context and surface lifecycle run against
the WebGL 2 context the kernel worker owns (an `OffscreenCanvas`, a transferred
KMS canvas, or an embedder-supplied canvas). There is no main-thread GL
forwarding path: an earlier exported fallback that replayed commands and
queries on the page's main thread had no production caller and was removed.

For `GLIO_QUERY`, the kernel rejects nonzero reserved fields, bounds both
buffer lengths and validates every nonempty guest range before renderer
dispatch. It probes the full output capacity even if the renderer might
return no bytes: queries can consume error flags or mutate object state.
Nonempty null ranges fail with `EFAULT`; zero-length pointers are ignored.
Input is copied before dispatch, so overlapping input/output buffers work.
Failed or oversized host replies return `EIO` without publishing output;
a successful short reply leaves the unused destination tail untouched.
The host-memory bridge still permits address zero as an ordinary byte;
the query ioctl owns its null-pointer semantics.

`GLIO_SUBMIT_QUERY` adds one synchronous ordered request for a nonempty
command prefix followed by a checked query. Its native-width `InOut` header
is 48 bytes for wasm32 or 64 for wasm64. The kernel captures the descriptor,
open file description, session and caller TID once, executes the existing
submit path, then reads input and validates output for the existing query
path. Submit failure prevents query execution; query failure leaves the
already-consumed prefix intact. Both phases retain their native checks,
CPU-image publication and error ownership. Ordinary submit/query requests
keep their existing contract.

The outer ioctl returns success to acknowledge a complete phase result,
including negative per-phase errno values. It does not accept a GL mutation:
only the nested checked reply can commit C binding or reference state. The
client consumes the prefix on every compound return and never retries or
falls back after uncertain execution. Reply and phase data remain heap-owned;
allocation failure takes the original ordinary-flush path before reporting
OOM. Empty command queues keep the ordinary query. This is not rollback,
persistent replay authority or deferred server ordering. The program-surface
digest includes the new transport; normal SDK and product artifacts need a
coherent rebuild. Validation status remains in the compatibility inventory.

Framebuffer selection is authoritative in the host. Ordinary
`glBindFramebuffer` queues the existing command rather than maintaining a C
selector mirror. Image attachment queries optionally return a 16-byte checked
receipt containing the accepted logical container name. Image deletion queries
optionally return a 20-byte receipt containing the invoking context's selected
draw/read container names. Identity is captured after the queued prefix and
before query effects; zero identifies logical default storage, while accepted
attachments require a named container. Legacy 12-byte replies retain their
layout and behavior.

C reserves attachment publication storage and uncertain-completion holds before
query entry. Only a validated successful receipt publishes ownership changes;
definite non-entry releases candidates, while uncertain entry retains them
through the existing group lifetime without replay. Deletion releases matching
object references only in the acknowledged selected containers. Unbound and
peer containers retain their references. The Program digest binds these opt-in
layouts so matching numeric epochs cannot admit older incompatible products.

The combined graphics branch uses ABI 56, one version above current main's
ABI 55, with kernel-host version 3. It joins main's kernel-owned waits,
executable admission and lifecycle contracts with the graphics interfaces
from earlier development versions.
Operation table 17 remains independently versioned. Generated source metadata
and normal SDK/program/package/image artifacts must be regenerated and
validated together after integration with main.

EGL exposes two RGBA8/depth24/stencil8 ES2 configs for ABGR8888 and
ARGB8888 native windows, using one attribute table for enumeration,
selection and queries. Selection honors size minima, masks, exact values,
defaults and explicit config IDs. Config operations require an initialized
display and publish outputs only after validation. Both configs' renderable
masks remain ES2-only; EGL's default ES1 selection filter consequently matches
none. Tools enumerating all configurations use eglGetConfigs. The source
facade supports independent window and pbuffer surfaces. Other EGL core
gaps and normal rebuilt-guest validation remain tracked in the graphics
compatibility inventory.

Operation-table version 16 adds an immutable surface-capability query to
initialized, mapped object sessions in a live display generation. It requires
no context or current binding and grants no authority to inspect ordinary
context-local state. The exact zero-byte input and 16-byte output carry
width, height, maximum pixel count and the completion marker. The renderer
uses the smaller texture/renderbuffer dimension and caps the pixel count
only at the representable EGLint maximum. C caches the accepted limits per
display generation; a malformed reply leaves caller output unchanged.
The kernel worker preserves outgoing GLES errors before querying, without selecting a logical context, changing drawable bindings,
resizing a canvas or claiming KMS presentation. A host without an available
renderer reports failure.

Both configs advertise PBUFFER_BIT. Pbuffer creation validates attributes,
uses generation-owned offscreen storage and preserves the pending native
window target. It stores accepted dimensions and query attributes. Largest
requests obey native dimensions/pixel limits and search smaller pixel budgets
only after definite allocation rejection; unknown completion stops the search.
A context created after its pbuffer reuses its existing offscreen renderer
without resizing or claiming KMS scanout. Context-first KMS ordering and
pump coexistence remain in the lifecycle audit. Texture binding
capabilities remain false, so texture-bound requests fail
with BAD_MATCH. Logical zero dimensions use minimal private native storage;
viewport/scissor initialization honors those logical dimensions. Pbuffer swaps
still validate the current draw surface and flush, without posting. Raw
presentation also recognizes the surface kind and avoid blitting
its private target to the visible canvas.

Core and EXT platform-window constructors validate live GBM dimensions,
format and rendering usage before allocating a backend surface. GBM lookup
uses its locked live registry without dereferencing foreign pointers. The
window format must match its config's native visual; mismatches fail with
BAD_MATCH. Public config IDs remain distinct in context/surface queries.
Both byte orders use canonical RGBA8 native storage. Exported CPU fronts
pack ABGR or ARGB bytes after successful native readback/restoration,
including top-row-first orientation and independent alpha. GPU fronts
preserve logical native color channels. The core attribute parser checks
pointer-width EGLAttrib keys/values before narrowing;
EXT attributes retain their EGLint layout. Requested render buffer and GL
colorspace are stored separately from actual rendering: QueryContext reports
BACK_BUFFER even for a SINGLE_BUFFER request. Public ES2 contexts do not
support sRGB rendering, so both windows and pbuffers retain the requested
colorspace but render linearly as permitted by EGL 1.5 section 3.5.1.

Surface setters support default resolve/destroyed behavior and the no-effect
NO_TEXTURE mipmap level. Unsupported config capabilities return BAD_MATCH.
Texture bind/release, pixmap creation/copy and OpenVG client-buffer creation
now expose entry points and the specific errors required by the current
configuration and GBM platform. They preserve queued GL work and thread
ownership. Implemented EGL functions resolve through GetProcAddress; core
server waits, GL-source images and broader error/lifecycle semantics
remain inventory gaps.

Core EGL image creation reads pointer-width EGLAttrib lists, while the KHR
entry point reads EGLint lists. Both use one retained-image registry and
support the existing dma-buf import target; either destruction spelling
invalidates the same public handle without releasing surviving siblings.
Attribute keys and values are checked before narrowing or importing.
Required plane offset presence is distinct from zero. Validated YUV hints
have no effect on supported RGB images. GL-source image creation and full
CPU/storage metadata conformance remain open compatibility work.

Surface allocation reserves native deletion receipts and every selector update
before creating texture/renderbuffer/framebuffer objects. Checked storage and
read/draw/texture/renderbuffer inverses are checked; a refused restoration or
cleanup is a fatal host fault. Accepted replacement storage stays committed if retiring an old
target fails. Surface destruction retires the
same receipts, preserving the distinction between owned native targets and
borrowed BO framebuffers. Broader resource factories, context loss and unknown
transport completion remain in the compatibility inventory.

EGL client/GL waits flush pending commands and require successful native
finish through the existing empty QOP_FINISH query. The host preserves earlier
GL errors and rejects failed completion or renderer loss, and acknowledges only
after acceptance. Chromium's and WebKit's WebGL `finish()` return before
earlier draws complete, so on those engines the host also waits on a private
buffer copy read back with `getBufferSubData` before acknowledging
(`host/src/webgl/finish.ts`; see "Chromium and WebKit WebGL finish() returns
early" in `docs/browser-support.md`). The C wait keeps current ownership
and reports failure without holding the EGL metadata mutex during completion.
GLES glFinish also exposes failed completion instead of discarding it. Swap
interval validates display/context/draw ownership; every request clamps to the
configs' zero bounds. Retained EGL fence client waits are described
below; server-side wait ordering remains separate compatibility work.

EGL error status and bound client API are thread-local; an unsupported API
bind reports BAD_PARAMETER while preserving the calling thread's prior API.
Current bindings use heap-backed pthread-key records with exclusive context
ownership. Release and thread exit flush before dropping current references;
destroy-current and terminate-current defer backend retirement until release.
Each created EGL context also owns an opaque heap encoder record. The
current thread binding selects that record; it contains the cursor, client
arrays, upload layout, errors, image siblings and returned strings. Each
encoder also owns the mipmap-generation and advertised OES derivative hint
values. Both start at DONT_CARE and remain independent in contexts that
share objects. Hint quality is advisory, but valid values remain queryable
through integer, float and boolean getters; invalid targets or modes raise
INVALID_ENUM without changing either value.
An unbound thread cannot mutate another context's client state. Release preserves the record for transfer
to another thread; final destruction retires its image references and
frees it without selecting it or emitting into another command stream.
Allocation failure precedes backend creation and leaves no published
context. C encoders retain a separate reference-counted name owner. Metadata-only
locks serialize whole-batch buffer/texture/renderbuffer reservations and
shader/program name allocation, including implicit binds. Array bindings
and every VAO's element/attribute capture retain actual buffer records;
namespace deletion does not erase an inactive container's old identity.
Texture 2D/cube units, the renderbuffer binding and framebuffer attachments
also retain explicit C records. First bind fixes texture dimensionality;
wrong-target binds and unrealized/wrong-type attachments preserve old
client references. Inactive FBOs keep an unnamed old record through name
reuse. Binding queries retain logical names; the host canonicalizes native
image views to their logical objects. Ordinary/raw WPK queries retain native
authority. Public
WPK BO texture names are registered after acknowledged creation, and checked
liveness reconciles owner-revoked names before C bind/attachment validation.
Private EGLImage source tokens use a separate registry and never enter the
public GLuint namespace. The inline 32-unit
capacity grows to the queried renderer limit,
with failed growth preserving selection and final teardown releasing it.
Public C texture/renderbuffer binds now wait for a checked renderer reply
before replacing binding references or fixing a texture's dimensionality.
The query and queued paths share native candidate creation and validation;
namespace bookkeeping is reserved before native binding and a rejected
candidate is removed. Accepted query binds also collect retired images.
This establishes definite bind acceptance, while an indeterminate transport
failure still needs lifecycle reconciliation or context-loss handling.
GPU image targets now retain distinct logical texture/RBO identities while
sharing canonical source pixels. Texture views preserve independent sampling
parameters; FBO attachments target canonical storage and retain their logical
query identity. Sampling views copy current source pixels before drawing.
Respecification stages an owned view and retargets all referencing group
FBOs before replacement. Shared container retargeting retains exact host
bookkeeping checks even inside a predicted guest batch: publishing a new
image while a healthy peer still attaches the previous storage would make
attachment reads disagree with sampling. An unpredicted native refusal
resets the submitting context and unwinds the container changes before
the replacement is published. Guest acceptance remains host-predicted;
the private publication checks do not turn native flags into late API errors.
C image holds release old backing only after checked
orphaning. Confirmed holds belong to retained shared object records;
ambiguous imports retain candidate object/image references until final group
retirement. Association revisions prevent older completions from replacing
newer holds. Final reference and replacement cleanup release images outside
the metadata mutex. CPU coherence, concurrent C/native namespace ordering
and indeterminate multi-failure recovery remain open. Public C contexts
now join these object groups; this is not complete image conformance.

Client staging retains a separate buffer-record reference, restores its
pointer/name/serial directly and keeps any pending capture encoder-owned.
The host saves the actual native ARRAY view in a context-local slot across
submit boundaries; buffer collection includes that pin across group
members, including separate index/vertex views. Empty BEGIN/END commands
restore identity independently of public names. The private ARRAY savepoint
uses exact host-bookkeeping restoration before publishing END completion.
A logical reset unwinds its native inverse; refusal by a live renderer is
fatal rather than a later END retry. Context destruction releases its pin.
Full indeterminate-submit recovery and interrupted temporary-name cleanup
remain open.
Name reservation is separate from GPU realization for buffers, textures
and renderbuffers. Their Gen records do not allocate or mutate host object
maps; the first accepted Bind publishes the native object. Delayed shared
reservations cannot replace a peer's realized storage or revive a deleted
name. The C owner still reserves complete batches before returning names.
Local reference cleanup precedes releasing the common owner. The private
shared-owner constructor supplies public C shared-context creation. A
separate group dispatch mutex spans standard buffer/texture/RBO name lookup,
native binding/deletion/attachment and C publication. Metadata locks stay
outside device IO; general indeterminate failure recovery remains open.
User-visible context/surface handles are monotonic. Each backend
session admits one context and surface. The public EGL facade allocates
additional sessions for independent context/surface records within a
generation. Each context has its own encoder and command mapping; current
bindings can select separate draw/read surfaces from other sessions in the
same generation. A surface can survive its session's context destruction.
A retained current old generation can overlap a newly initialized one.
Public C shared contexts join the retained C owner and native/kernel group;
the full API/error and lifecycle audit remains open.

Surface creation uses a 36-byte input/output GlSurfaceCreateInfo:
32 attribute bytes followed by a zero-on-input surface identity. The
kernel returns a fresh identity and accepted dimensions only after the
renderer acknowledges creation. A private copy translates the caller's
GEM handle for the host; the successful guest reply preserves that handle.
Failure leaves caller bytes, context/current state and previous backing
unchanged, with ordered candidate cleanup. The C library stores the
returned ID and uses it for make-current; it no longer assumes ID 1.

The host stages private surface storage before publishing it. Explicit
storage retains its accepted size independently of a shared canvas. A retired
request frees its unpublished candidate. Identity-checked destruction
cannot remove a later surface. Ordinary canvas swap blits private storage
to the visible default target. Source tests exercise
accepted dimensions, retained pixels and stale cleanup across all three browser engines; full
guest marshalling and the public C cross-context facade remain unvalidated.

The GLES bridge exposes a GLES2 API over WebGL2. Operation-table version 2
adds commands while preserving version 1 tags and payloads. `GLIO_INIT`
accepts versions 1 through 17, and rejects zero or newer versions with `ENOSYS`.
Its version and extension strings describe that API. Extension queries carry
an optional operation-table version: legacy requests retain their empty list,
while version 2 advertises bridged capabilities. Optional float rendering and
filtering extensions appear only when the host enables them. Uniform
reflection, vector/matrix uploads, indexed draws, texture updates and
depth/stencil operations use the same command/query path as other programs.
A submitted command batch is structurally validated in full before dispatch;
an invalid trailing TLV record cannot execute earlier records in that batch.
This does not roll back valid commands that report ordinary GL errors.
The source-only host gate is `cd host && npx vitest run --config
vitest.graphics.config.ts`; rendered and guest integration checks are separate.
Uniform getters use one checked, fixed-size renderer reply carrying count
and values. They do not depend on an earlier reflection call or a C width
cache. Shared program/location associations validate ownership and link
state before reading without changing the current program. C publishes
only a completed successful reply; failed or malformed results preserve
caller output. Table 7 adds this query, preserving all older
tags/layouts. Table 8 adds checked active-uniform chunks and context-owned
name lookup transfers in the existing 64 KiB query messages. Uniform
locations are numbered per program, as Mesa and native ANGLE number them
(decision D-41, `host/src/webgl/uniform-layout.ts`): active uniforms in
GetActiveUniform order from 0, one location per array element, no
location for `gl_` built-ins or host-private variant uniforms. Ported
software (and dEQP-GLES2 `performance.shader.operator`) uses one
program's location with another program of the same declarations
current, which works on Linux drivers. Uniform* resolves a location
against the context's installed executable, GetUniformLocation and
GetUniform* against the named program's latest successful link; a
location the current executable lacks, or a mismatched signature, is
`INVALID_OPERATION`. A relink with an identical active set keeps the
previous numbering. Lookup transfers are token-checked, replaced
or cancelled independently per context and released on retirement. C
publishes reflected metadata/names only after accumulating every requested
chunk. Fixed C name/reflection buffers are removed. Shader-name translation
beyond WebGL limits and the full setter/link audit remain open.
See [the graphics compatibility inventory](graphics/compatibility-v1.md).
Texture uploads copy shared and
possibly unaligned guest bytes into the typed views WebGL requires. GLES2's
unsized float, red/green and depth formats map to equivalent sized WebGL2
formats. New opcodes occupy unused slots; existing opcode numbers and record layouts are
preserved. Buffer allocation also accepts a data-free record carrying its size.

Canvas-backed default framebuffers render into an offscreen color buffer with
24-bit depth and 8-bit stencil, then blit the color buffer at presentation.
GPU-backed Wayland window buffers also own 24-bit depth and 8-bit stencil
attachments. Allocation checks framebuffer completeness and restores the
shared context's texture, renderbuffer, and separate read/draw framebuffer
bindings. Destroying the buffer releases all three GL objects.
Host surface records own presentation allocations independently of context
state. An explicit live surface keeps its target when its context is
destroyed and recreated. Draw/read selectors retain their surface records;
retiring the owner description defers target deletion until both kinds of
reference end. Framebuffer zero resolves the selected draw and read targets
separately, including a combined `GL_FRAMEBUFFER` bind. A candidate resize
allocates a complete replacement before changing the surface or any of its
selectors. Failed allocation preserves the previous target and pixels;
successful replacement preserves user FBOs and updates selecting contexts.
Kernel and host selectors now resolve independent draw/read surfaces across
object sessions within a live display generation. The kernel checks PID,
generation and validated current TID before backend entry. Retired owners
cannot grant new selection. Explicit destruction is busy while selected;
owner close, unmap or termination retires its ownership while existing
current selectors retain storage. One canonical surface record owns its BO
hold, independent of the number of owner/draw/read references. The public C
facade now owns separate context/surface records and exposes independent
draw/read selection and shared object-group creation. C image holds belong
to retained group records and program metadata belongs to the host group.
Kernel surfaces hold their target BO independently of GEM handles. An acknowledged update transfers that hold only after acceptance;
rejection releases its candidate and preserves the previous hold. Native
surface destruction/unbind precedes the final host BO destruction effect.

Graphics cleanup identity and surface BO holds are shared across inherited
open descriptions; command mappings and current-thread authority remain
local to the creating image. Closing or execing a child cannot retire the
parent's renderer. Final description close releases it once. The creating
image also keeps weak cleanup references, so exec, exit, forced removal or
command-memory unmap revokes its native binding even after its last local
fd closes while a child retains the description. Weak references do not
extend description or storage lifetime. They carry mapping bounds for
revocation, never submission authority in the child. General forked GEM
handle-map sharing remains an open part of the full OFD model. Current
cleanup reachability also survives closing a context's last local fd while
a child retains that description: replacement or thread retirement releases
its former selectors before their final BO destruction. Backend rejection
preserves the prior current references.

Host surface lookup grants new selection only through a live owner on the
same process and renderer. The kernel worker selects the actual records; framebuffer zero and swap use the selected draw/read
resources. GPU retargeting prepares all affected default references and
drawable metadata before publication, then changes the canonical record
without native calls or allocation during commit. User FBOs, independent
read targets and viewport/scissor state are preserved. The BO registry now
keeps original width/height separately from padded stride, so accepted
kernel retargets retain actual geometry.
The multiplexer restores masks, stencil operations, clear values, dither,
constant vertex attributes, independent 2D/cube texture bindings and pixel
storage state when switching guest contexts. A scalar constant-attribute
clearing range survives full invalidation and retirement; incoming indices
enter that range before the first fallible native replay prefix. Replay
bounds it by a checked native attribute limit, restoring incoming constants
or the default `(0,0,0,1)` even after former owner metadata is discarded.
Only accepted vertex-attribute limit queries populate that immutable native
limit cache; unavailable or rejected queries refuse entry and can retry. Generic native
callbacks mark all attribute constants unknown before callback effects, so
restoration covers the entire accepted native range, including indices absent
all guest shadows. No guest bindings, attribute values or sparse key sets are
retained by that clearing range. Full replay still has its existing unchecked
native-error behavior; this change closes lost reset coverage, not acceptance
checking for every state replay. Queued constant-attribute setters validate the
index against the accepted native limit before any write or shadow growth.
Their old scalar value enters the native repair journal before effects, and
new shadow values publish only after checked acceptance. A refused inverse
is a fatal host fault. Existing private tuples
update without a Map clone; new indices reserve only valid native slots before
publication, rather than copying historical invalid entries. Synchronous native-state queries
select the caller through that same multiplexer after destination preflight.

Fixed GPU KMS presentation helpers capture the actual native read/draw FBO,
pack-buffer/layout, scissor, color mask and clear-color selectors through a
checked native query before each synchronous operation. They compare that
snapshot with the selectors needed by that operation and reserve inverse
records only for writes that will actually be attempted. A write whose value
already matches is omitted along with its redundant inverse. Every attempted
native operation still receives its checked post-call error capture, and a
refused inverse is a fatal host fault.

Owned RGBA/UNSIGNED_BYTE readback uses zero pack row length and skips. It
retains captured PACK_ALIGNMENT 1/2/4/8 when that alignment divides width*4;
otherwise it selects alignment4. Thus alignment8 is retained for even widths
and temporarily changed for odd widths. Primary scanout still blits then
clears alpha to1 with RGB masked off. Its alpha-only clear retains the captured
clear RGB; when captured clear alpha is already1, no clear-color write or
inverse is needed. This is per-operation native-state admission, without a
persistent selector cache, pixel cache or presentation/frame elision. Storage
ownership, context-loss gates, operation order, alpha semantics and final
restoration/repair requirements are unchanged.


The host now has a retained native-fence owner as a prerequisite for EGL
sync support. Creation reserves a private candidate and deletion receipt
before inserting the native fence; publication is separate from acceptance.
Public-token destruction prevents new lookups while existing waiter leases
retain the actual native context and sync object. Context destruction does
not retire these references. Final session removal revokes public authority;
the final waiter release permits checked deletion. Failed deletion remains
in the existing native-retirement queue and blocks dependent admission.
Records retain native handles and private error flags, with no guest memory
or binding callback. Kernel teardown captures errors from all
retained native contexts, including fences whose creator is already gone.
Operation table 17 connects this owner to create/status/release queries.
Each request carries one nonzero, monotonically allocated client token;
its 16-byte reply contains status, echoed token, a signaled bit and magic.
The client knows the token before creation, so cancellation can retire a
lost reply and tombstone a request delivered late. Duplicate creation
returns the retained identity without inserting another native fence.
Creation requires current-thread and live-display authority. Status and
release require a mapped, native-live object session owned by the caller,
including after its creator/display root retires; this grants no ordinary
GL query authority. Replies publish creation only
after output acceptance. Empty-payload flush has a separate acknowledgement
and does not imply completion. Public C glFlush submits the encoder before
requesting this native flush, and preserves GL error reporting on failure.
Internal encoder-only submission retains its separate helper contract.

Core eglCreateSync, eglDestroySync, eglGetSyncAttrib and eglClientWaitSync
now use generation-owned records and never-reused public handles. Each
record reserves heap request/reply storage and a reply mutex before native
creation, and independently retains its creator's initialized session.
Destroying the creator does not invalidate its syncs. Public destruction
invalidates future lookups while existing waiters keep their references;
display termination invalidates public handles while in-flight waits retain
the old mapping and descriptor. Unknown creation and deletion replies keep
the known token for idempotent cleanup; unresolved cleanup gates further
allocation on that session instead of discarding ownership.

Client waits poll outside the EGL metadata lock, serialize only each wire
reply, and use monotonic elapsed time for finite waits. They yield between
polls, implement zero/FOREVER timeouts, and flush the waiting thread's
current context only when requested and initially unsignaled. Cancellation
releases the waiter reference. Metadata retirement disables cancellation
until unlocking, so a cleanup ioctl cannot strand peers. The four
KHR_fence_sync spellings share these records, retain 64-bit timeout values,
validate their narrow input lists independently and copy only EGLint-sized
attribute outputs. Unsupported types produce KHR's BAD_ATTRIBUTE rather
than core's BAD_PARAMETER. EGL advertises EGL_KHR_fence_sync and the C GLES
extension layer adds GL_OES_EGL_sync, indicating that this client API can
place fences.

eglWaitSync and EGL_KHR_wait_sync (`QOP_SERVER_WAIT`) rely on the host
executing every accepted submission before `host_gl_submit` returns, and on
fences being created only while their session has no queued work. The guest
names the fence's session by its own fd; the kernel replaces that fd with
the session identity of an object session the same process owns, so the host
never interprets a guest fd number. When the fence and the waiting context
share one physical WebGL context, the host issues the native `waitSync`
barrier. Separate physical contexts share no native command stream, so the
host answers `CLIENT_SIGNAL` and the C facade observes the fence's signal
before eglWaitSync returns; later destination commands therefore follow the
source work. That is stronger than the minimum server-wait contract and
never passes one context's sync handle to another. The definitions still
require the normal combined graphics build and conformance phase.

Owned drawable allocation leases now retain the native framebuffer,
dimensions and private retirement receipt independently of the mutable
surface or its selecting bindings. Resize may publish fresh storage while
a retained allocation remains usable; surface destruction revokes lookup
without deleting that held allocation. Existing leases may clone their
hold after retirement, while a new lookup cannot acquire a retiring receipt.

Native retirement distinguishes a deliberate reference hold from failed
cleanup. Held allocations and their retirement dependants do not block
admission, so retained work can execute and release them; the last release
captures selected-owner errors and deletes the storage in the same call
(at the end of the native change in flight, if any). A deletion or a state
restoration that a live renderer refuses is not retried "before later GL
work": nothing guarantees that work will come, the host created and still
tracks every object involved, so a live WebGL renderer has no valid reason to
refuse, and the refusal means host state no longer matches the renderer. It
is a fatal host fault (`NativeGlFault`, `host/src/webgl/native-recovery.ts`),
reported through the kernel's `onHostFault` before it is thrown, so the
kernel worker stops exactly as for a trapped kernel export on Node and in
the browser. The reporter latches the original fatal cause before invoking
shutdown callbacks. Reentrant reporting or a second failure during final
cleanup rethrows that same cause without reporting another transition.
A kernel-export failure raised by the reporter retains its exact branded
identity through cleanup. Installing a new kernel's reporter clears this
latch; ordinary per-context resets do not enter this fatal path.
A lost renderer is the exception and a normal event: its
objects and state are gone with it (including after a restoration of the
same context object, detected through the renderer's loss count), so cleanup
completes without native calls, pending restorations are dropped, and the
bindings that used it report the loss as a graphics reset through
`host/src/webgl/renderer-loss.ts` (`ENODEV` replies).
Native cleanup keeps the object's original renderer generation, even when
its deletion receipt is first created after restoration. Independent native
owners and exported images copy that generation without retaining a guest
binding. A synchronous loss result advances it before the queued canvas
loss event, which does not count the same loss twice. Ending a context
clears its session's observation baseline, so a new independent context can
use the restored renderer. Hosts without canvas events observe restoration
when a new owner begins, so its next physical loss is detected too.
Refused cleanup of that new generation remains
fatal; a logical guest reset alone does not discard live native resources.
Prepared program-query custody also separates public names from native
executables. Deleting a program with no logical current context removes its
name even while private query pins retain the native program. A sharing peer
therefore cannot select or query that deleted name. A program still current
in a peer remains delete-pending until that context unbinds it. The last pin
releases an unnamed executable through the existing exact native cleanup,
including fatal refused deletion. This custody foundation does not enable
local guest program-selection validation or its deferred command path.
The same leases cover borrowed GPU BO allocations through a native-only
allocation receipt copied into the surface record. Public BO retirement
revokes lookup while existing leases keep the old allocation usable. A
replacement BO with the same numeric ID receives a distinct texture ID,
receipt and storage. New holds cannot revive a retiring allocation; existing
holds may clone. Surface destruction drops its allocation description
without taking over the kernel BO's ownership.

GPU BO allocation now reserves native cleanup before creating its texture,
framebuffer and depth/stencil buffer. Checked creation, storage setup,
completeness and selected texture/renderbuffer/read/draw restoration all
precede publication. A refused inverse restoration is a fatal host fault. The kernel host import captures
selected-owner errors before this private utility runs. Cleanup receipts
can enforce member order, preserving canonical texture backing after a
rejected container deletion and skipping members already accepted.
Retained execution groups remain part of raw BO-view retirement even after
public context replacement.

Context execution leases separately retain a native execution owner after
public context destruction or session removal. Acquisition reserves a fresh
public slot before work can be accepted. Destruction revokes lookup and
clears the old guest command view; the session may
create a replacement context with fresh local state while existing leases
continue to use the old native identities. Public fence ownership remains
session-scoped. Existing execution references may clone after revocation;
fresh lookups cannot revive the retired context.

Final execution release captures selected-peer errors before forgetting
the muxer's current state. Failed capture or native cleanup retains a
renderer-scoped retirement record. Admission retries failed unreferenced
records before new native work, while intentionally retained executions
remain usable. Native cleanup receipts retain local containers, shaders,
programs and default textures; checked image/buffer retirement preserves
rejected ownership without replaying accepted members. Live share-group
peers continue owning their shared objects. These are source ownership
models; normal submits still drain synchronously.

GL submission now captures only the requested command span into an owned
SubmitFrame before validation. Kernel-worker dispatch validates and decodes
that same snapshot, so guest rewrites or renderer
callbacks cannot change later accepted records. Captured typed-array
accessors avoid overridable source properties. A frame is admitted once,
consumed before dispatch, and cleared on session/process purge. A failed
or partially executed packet is not replayed.

Empty queue entries release their actual lane membership without rechecking
DRM master authority. The file grant may change after admission, and failed
dispatch can stop the drain immediately. Cleanup must release the consumed
binding's references in that same turn rather than wait for another drain.

During synchronous dispatch the binding temporarily exposes the owned bytes
to the existing decoder. Finally restores its cached guest view only if a
memory rebind or teardown has not replaced it. Drain
remains synchronous: deferred server waits still need per-work drawable
selection, dependency ownership, query/presentation barriers and asynchronous
retirement. Command snapshots
and execution leases do not yet implement server ordering.

`GLIO_QUERY` and `GLIO_SUBMIT_QUERY` execute their query and publish its
result within the ioctl (`gl_query_request::GlQueryRequest`); there is no
retained or parked query path between the kernel and host.

The retained server-wait source model separates command custody from result
custody. A queue owns the exact source `GlFenceLease`, destination execution and
operation ticket; an accepted wait survives result cancellation or Forget.
Same-native ordering uses the captured sync handle, while foreign-native
ordering polls that source on later host turns without blocking peer streams.
A fence lease also pins its actual native-retirement journal, so the sync is
not deleted while a query or wait still owns it. Public kernel
source-fd capture, scheduling and lifecycle activation remain required before
this source model supports end-to-end EGL server waits.

Variable shader/program queries use a context-owned copied-result transaction.
The C facade requests one original log, source, active-variable record or
attached-shader list through `QOP_OBJECT_CAPTURE` (0x34). BEGIN captures both
metadata and the requested prefix; CHUNK copies those independent bytes and
never re-reads an object that another shared context may have changed. RELEASE
acknowledges disposal before C publishes any caller output. Unknown completion
never replays the original query. Each context admits monotonic caller tokens;
stale cancellation cannot dispose of a later capture. Public context retirement
and canvas detachment revoke copied storage separately from native execution
custody. The 64 MiB copied-storage budget is independent of the 64 KiB transport
limit and fails with OUT_OF_MEMORY rather than silently truncating a query.
This source implementation still requires rebuilt runtime validation.

The host import returns success only after a live renderer accepts creation;
the kernel publishes its context identity afterwards. Missing, lost or
throwing renderers leave creation retryable and do not claim the KMS canvas.
EGL exposes backend allocation failure as
`EGL_NO_CONTEXT` and `EGL_BAD_ALLOC`. A Node host without a rendering
backend follows the same failure path as a browser without a usable context.
Each GL open description has a distinct kernel-issued session identity.
Initialization distinguishes display roots from object sessions. A root
returns a fresh generation identity; an object session must join a live
same-process root using its descriptor and generation. Duplicated root
descriptors retain authority until the last alias closes. Revocation or
final close prevents new contexts, surfaces and positive binds, while
already-current children retain submit/query/release/destruction paths.
Descriptor reuse cannot revive an old generation. Roots have no command
mapping or renderer and therefore send no renderer unbind on cleanup.
An EGL native GBM device selects its exact DRM open file. Display roots
still keep their GL state on separate render-node files, so independent
EGL displays may reference aliases of the same native file without
colliding. `GlInitInfo.display_fd` on a DISPLAY initialization selects a
held DRM file, or -1 keeps that render file's own identity; OBJECTS still
joins its display root. The kernel validates the selected file before
publishing state and passes its stable identity to the host. It does not
infer native display or master authority from the process ID.
The GBM library resolves native handles through a live-device registry
with monotonic identities. EGL display handles are cached by device
identity, independent of recycled heap pointers. Immutable display
records are atomically published for safe handle validation; each record
selects its active generation under the context lock. The default display
chooses a primary DRM file. Each initialized generation owns a CLOEXEC
duplicate of its native file until final context/surface/sync retirement,
including after public termination. Display metadata has process lifetime.
KMS scanout advertises the same thirteen formats accepted by ADDFB2:
XRGB8888, ARGB8888, XBGR8888, ABGR8888, RGB565, R8, GR88, the four
2101010 orders, and ABGR/XBGR16161616F. Every presenter (a 2D canvas or a
WebGL canvas) outputs 8 bits per channel, so the CRTC behaves like one
connected to a monitor at 8 bpc: a 10-bit channel is shown as
round(v * 255 / 1023) and a half float clamped to [0, 1] (NaN as 0) as
round(f * 255). The reduction is defined once and applied identically on
every presentation path, on the CPU for the 2D blit
(`host/src/dri/scanout-format.ts`) and in the CRTC output stage's shader
for every WebGL path (`host/src/webgl/kms-color-stage.ts`), because a
blit or a readback would leave the rounding to the driver (and refuses
float-to-fixed blits outright): the same framebuffer must look the same
whichever presenter shows it. The gamma LUT is indexed by the reduced
8-bit value, as an 8-bpc legacy LUT is. Framebuffer admission
checks complete visible row extents against BO backing before retaining or
publishing an FB. GPU views also remain within the native texture extent;
valid padded RGB565 CPU views remain admitted. Nonzero-offset presentation
and the complete layout/modifier model remain incomplete. CPU presenters validate
visible row lengths and pitch before copying. The 2D presenter converts
little-endian pixels to opaque RGBA; the WebGL presenter uploads each
format to its own texture (RGBA8 with a shader channel swap, RGB565, R8,
RG8). Pixel snapshots are copied
under the kernel entry before detached presentation. The low-rate
unflipped-write check compares the entire owned snapshot against the last
upload instead of relying on a sparse hash that could miss one pixel.
This does not complete flip admission/vblank ordering or all buffer views.

The EGL library retains one heap record per display generation. Public
lookups use that display's active generation; thread bindings retain their actual
generation's descriptor, mapping and encoder after termination. A new
initialization can therefore overlap old current resources. Successful
replacement releases the old generation after backend acceptance; a failed
bind preserves it. Images retain their importing generation so cleanup
cannot close a reused numeric GEM handle on a newer description. Image
lookup acquires a temporary reference before a GL sibling is installed,
and termination revokes public image handles under the same reference lock.
Public image tokens are monotonic, independent of heap addresses, so a
recycled allocation cannot revive a deleted or prior-generation handle.
Command buffers, native object maps, shadow state, queries and
retirement are selected by process plus session. Process-only registry
lookups refuse ambiguity. Closing or unmapping one session leaves sibling
sessions intact, while process memory growth invalidates every cached view.
KMS canvas ownership is retained until its last claiming session releases.
GL context identities are also kernel-issued and returned by creation;
foreign texture imports select the exact context. Cross-process inherited
descriptions cannot operate another process's renderer or invalidate its
command mapping; final cleanup retains the renderer's original process.
Context creation can name a live source context in the same process
and display generation. The kernel validates authority before backend
entry; the host joins the new context to its source's object maps before
acknowledgement. Source-session lookup preserves local bindings, errors, default textures and FBO/VAO containers.
Cancelled creation removes only its unpublished member. Source destruction
leaves surviving members and their shared storage usable. The C facade
still rejects sharing until its own client object/reference layer can join
that group safely; see the graphics compatibility ledger.
The kernel owns each session's current thread identity. Bind requests name
the context and both draw/read surfaces; zero surfaces bind surfaceless,
while an all-zero request releases the caller's bindings. Submit, query and
foreign-texture operations require that authoritative thread identity.
Another thread cannot acquire a live binding. A replacement is acknowledged
before displacing the caller's prior binding, and thread exit revokes it.
The first accepted bind initializes viewport/scissor from the drawable,
including zero dimensions for surfaceless; later binds preserve client state.
Native Wayland window resizing updates an existing GPU target atomically
without destroying its current EGL surface. Failed updates preserve the old
target and attached size. This path currently requires an existing GPU
window target on the same native renderer. Native Wayland buffers own
independent render descriptors rather than borrowing a current context's
fd. EGL transfers BO names into context/surface sessions through PRIME,
closes export capabilities and temporary imported names after the operation,
and preserves names already owned by images on the generation descriptor.
Resize queries update only after accepted retargeting. Public surface
queries report stored accepted dimensions and attributes; deleted handles
remain invalid while current bindings retain storage. Native/source-browser
checks cover multiple public contexts, independent surfaces and generation
overlap. Share groups, the full lifecycle/error audit, normal guest-artifact
and conformance validation remain pending.

Surfaceless bindings use a context-owned native framebuffer with no
attachments to represent the absent default framebuffer. It has no guest
name, cannot accept guest attachments, and is retired with its context.
Native completeness checks therefore reject clear/draw/copy/read commands;
the status query exposes `GL_FRAMEBUFFER_UNDEFINED_OES`. The GLES extension
list includes `GL_OES_surfaceless_context` for this host behavior. First-bind
allocation failure preserves the prior drawable and reports failure to EGL.
User framebuffer objects remain usable. Read/draw framebuffer state is
retained independently through native context switches; deleting a bound
user FBO restores the appropriate default target. Native readback errors
are retained for glGetError and return no output bytes, so libc does not
overwrite the caller's buffer with an unsuccessful reply. These source
semantics still require guest CTS and combined-artifact validation.
Native GL errors are drained into the outgoing session's error flags before
renderer switching or invalidation. Error queries merge native and retained flags before
consumption, so another session cannot consume them or repeat a duplicate.
A failed drain preserves the outgoing flags for a later retry and does not
prevent cleanup. Queue dispatch reports renderer exceptions as EIO and
releases the consumed frame. Complete GL negative-API coverage remains open.

Because native flags are sticky and owned by the selected session until a
capture moves them, the host reads them (`getError`, a synchronous renderer
round trip, a GPU-process IPC in Chromium) only where something depends on
the answer. Flags are captured when ownership changes (a muxer switch or
invalidation), when the session queries them, before native work that
would otherwise absorb them into another owner (a pending repair or
retirement, a fence poll, a storage lease's release), and before and after
device operations. A submission or query entry with no pending repair or
retirement captures nothing. A guest call keeps its own exact check only
where host bookkeeping commits on native acceptance that the host cannot
know in advance: object creation and deletion (names, fences, VAOs,
framebuffers), shader compilation, attachment and program link/use,
framebuffer binding with its selector rollback, blend factors and depth
range (whose WebGL-specific refusals the host does not pre-validate), image
and storage commands, and attribute arrays at or past the renderer's limit.
A capability toggle on one of ES 2.0's nine capabilities, and an attribute
array below the limit already read from the renderer, cannot be refused, so
they commit their shadow with no check. Host device operations built from
state they just read (KMS blit and readback) check once per dependency
group: the selectors before the blit or readback that reads and writes
through them, the blit and alpha mask before the clear that relies on the
mask; their inverse is one batched group whose single check still turns a
refusal by a live renderer into a `NativeGlFault`. A flag therefore reaches
the guest exactly once, possibly in a different order relative to other
pending flags than a per-call drain gave; ES 2.0 section 2.5 leaves that
order to the implementation. A renderer whose flags never clear still fails
loudly at the next capture, and context loss is still detected at every
entry (`renderer-loss.ts`).

Framebuffer name deletion separates reversible selector changes from
irreversible native retirement. It reserves an empty native cleanup ticket
before unbinding, commits the logical name/attachment removal after the
selectors accept, then retires the native framebuffer through that ticket.
A live renderer's refusal is fatal and leaves explicit pending ownership;
it cannot be predicted as a successful deletion followed by a context reset
that loses the native handle. Failed selectors retain their native inverses
and keep the public name. This uses the existing retirement protocol on
Node and browser, with no new wire field or version.

Guest execution now uses host GLES validation as the acceptance authority
(`webgl/native-batch.ts`). Each submitted frame, result-bearing query and
present runs in one synchronous native batch, including muxer replay and
CPU-image preparation/publication. Checked calls on that guest's error owner
execute without native `getError`; guest-owned inverses use the same policy.
Native flags are sampled at batch completion before another logical context
can acquire the shared renderer. A clean submitted batch takes one error
sample. A `glGetError` query that only reads host-owned flags issues no
native sample; muxer replay or utility work on that path still marks native
execution and receives its boundary sample.
Fence creation, status queries and same-renderer server waits share this
batch policy too; retained fence leases borrow the requesting error owner
only for that synchronous execution, without storing a guest binding. Fence
creation/status errors reset that binding before a reply or new fence is
published. Export/release paths with no native work need no sample, and
retained sync cleanup remains available after the guest context resets.
Off-batch or foreign-context polling keeps exact private checks and preserves
the previously selected guest's flags separately.
Private allocation and retirement owners still use exact checks where native
success is required to publish or delete a handle. If such a check discovers
an error within a guest batch, it routes the error to that batch's reset
policy instead of swallowing it in a private error queue. Private buffer
transfers also retain exact checks while a guest batch is active: allocation,
selector changes, chunk reads/writes and restoration must succeed before a
shared or derived view becomes valid. An early logical reset unwinds nested
native changes and retires unpublished buffers before another context can
acquire the renderer. Refused restoration on a live renderer remains fatal;
physical renderer loss drops the obsolete native state. These checks do not
change guest-command acceptance or consume previously recorded guest flags.
Private ARRAY savepoints and widened/padded index draws also check their
selector finalizers before discarding the inverse. Guest draw acceptance
remains predicted. A private restoration cannot claim completion merely
because the active guest owns the same error queue; if its final sample
were deferred, the batch could reset after losing the inverse needed to
restore shared native state. These checks run on those private paths;
direct index draws do not acquire a new restoration check.
Private image allocation and preservation copies also require native success
before a sibling view is published. Refreshing an image view leaves its sync
count stale until the private copy succeeds, so a healthy peer cannot skip a
needed refresh after the submitter resets. Possible writes remain counted
through reset unwinding for exported siblings. Framebuffer attachment and
sampling must resolve coherent contents for the accepted shared generation.

An unpredicted native error resets the guilty logical binding, emits a
`gl-context-reset` host diagnostic naming its process, session, batch and
entry, and returns `ENODEV`. Later work on that binding executes nothing;
unrelated logical contexts keep their renderer and objects. The guest's
robustness handling records that context's reset. A failure-only checked
`QOP_CONTEXT_RESET_SCOPE` receipt distinguishes a logical reset from physical
renderer loss before libc invalidates any shared peer. Only a known physical
loss propagates to the EGL share group; a logical reset leaves its healthy
peers and shared objects usable. An unavailable or malformed scope receipt
prints a diagnostic and retains the reset locally; peers learn a physical
loss from their own device replies. Reset/error getters remain local after
that observation. Native `OUT_OF_MEMORY` uses the logical reset path:
WebGL's asynchronous allocation failure is an approved platform boundary,
rather than a late API error attributed to a later command. Native flags
never enter the guest's API-error queue on these paths. Host validation and
the guest's client-error trailer own those flags.

The native-divergence audit (`webgl/native-audit.ts`) remains opt-in through
`KernelConfig.glAudit`. It instruments every native method and compares the
observed error with the host prediction, naming the native call, kernel
import, process, session, batch and guest operation. The gap inventory in
`webgl/native-predictions.ts` identifies rules needing additional coverage.
`"record"` collects per-call findings; `"fatal"` latches a `NativeGlFault`
at the first divergence. A validation divergence under either audit mode is fatal, so the production
reset cannot hide it during audit validation. Native OOM and actual context
loss remain reset boundaries in the audit too. The audit
adds a native round trip per call and is disabled by default. Node has no
WebGL renderer and keeps its documented loud initialization failure.

The first audit of dEQP-GLES2, dEQP-EGL and the compositor sessions on
Chromium found every native refusal at a site the gap table already named,
all in dEQP's negative API cases, plus one host defect: a texture view of a
renderbuffer EGLImage was allocated with RGBA/UNSIGNED_BYTE whatever the
renderbuffer's format, which WebGL 2 refuses for RGB565. The host now
evaluates those rules itself (`webgl/es2-validation.ts`) and records the
GLES 2.0 error before any native call: TexParameter values (table 3.10),
TexImage2D and CopyTexImage2D sizes and border, sub-image bounds of a level
the host recorded, RenderbufferStorage's target, size and binding rules,
AttachShader's one shader per type, BindAttribLocation's index and `gl_`
prefix, and attribute array indices. Framebuffer completeness for draws,
clears, reads and copies combines the ES 2.0 clauses WebGL 2 does not apply
with the renderer's own `checkFramebufferStatus`, asked once per framebuffer
whenever its inputs change (`image-sizes.ts`), so an incomplete framebuffer
is refused before the call rather than by `getError` after it. Sibling
views take the transfer pair WebGL 2 requires for their sized format.
The host also predicts rules real applications reach on hot paths, so the
renderer is not asked about them either: CreateShader types, UseProgram of
a program whose link the host saw fail, a texture bound to a target other
than the one recorded at its first bind, sampler uniform values outside the
texture units (WebGL's INVALID_VALUE, which the guest has always seen
here), BufferData usages, and WebGL's rule that client pixel data must
cover what a TexImage2D or TexSubImage2D reads at the current unpack
alignment. What remains left to the renderer is listed with its rule in
`webgl/native-predictions.ts`. Node has
no WebGL renderer, so there it has nothing to instrument. Running suites
with it is described in
[graphics conformance testing](graphics/conformance-testing.md#native-divergence-audit).

Translated sampler-array lookups use private dispatch functions with
constant native indices (`webgl/sampler-arrays.ts`), because ESSL 1.00
accepts loop-indexed sampler arrays while ESSL 3.00 requires constant integral
indices. Dispatch preserves one evaluation of the coordinates and index,
selects one lookup, carries the c = 0.5 flag, and preserves guest `out`/`inout`
parameters. Guest sampler-array parameters are flattened into scalar sampler
parameters too. A standalone WebGL page reproduces a Firefox 153/155 link
crash when array-parameter elements are forwarded to another function;
scalar parameters avoid it (registry
`FIREFOX-SAMPLER-ARRAY-DISPATCH-LINK-CRASH`). Shaders without an indexed sampler
lookup get no dispatch helper. This is shader work at compile time and adds
no host draw-time branch.

The guest side of the same contract keeps `glGetError` off the transport
when the answer is already known. Applications that check every call (a
debug GL wrapper is `glGetError(); call; glGetError()`) otherwise pay a
synchronous kernel-worker request for each check, most of them with
nothing queued since the previous answer. `glGetError` sends the
`QOP_GET_ERROR` retained-drain form (`shared::gl::error_drain_receipt`): queued commands
ride as the compound submit prefix, the encoder's unacknowledged client
flags ride in the request mask, and the renderer captures native flags and
moves every recorded flag, oldest first, into a checked reply that also
says whether any flag was retained. libGLESv2 holds the moved flags in the
context encoder beside its own client flags and returns one per call. When
nothing was retained, only proven infallible scalar setters have been queued
and no graphics-device request has been made since (libEGL counts every request
from both libraries, process-wide; a fork child's count is advanced by a
`pthread_atfork` handler), no command can have recorded a new flag, so
`glGetError` answers from the guest with no request. The first B1 increment
tracks the end of that exact command prefix for `glClearColor`,
`glBlendColor`, `glClearDepthf`, `glClearStencil`, `glColorMask`,
`glDepthMask`, `glStencilMask`, `glPolygonOffset`, `glDepthRangef` and
`glSampleCoverage`. These scalar setters cannot raise GLES API errors;
their original records still reach the host for independent validation and
execution. An unknown command leaves the proven prefix behind and forces
the next error drain. Automatic buffer submission also invalidates the
request epoch, even when the command cursor wraps to the same address.
Draws and object-dependent commands do not extend this exact prefix.
Ordinary requests, including a state query, make-current, swap, fence
operation or another thread's work, void that knowledge, and the next
`glGetError` drains again. This relies on the host recording a flag only into the context
whose request produced it, as described above. Reset reporting is
consulted before any local answer and is still learned from the next
request's `ENODEV`. A malformed or failed drain reply is reported as one
`GL_INVALID_OPERATION` and never establishes local knowledge. Each context
reserves one fixed receipt before native execution. The new 12-byte request
adds a wrapping transaction identity; the 52-byte reply seals its status and
identity before copying out the original count/retained/error-list payload.
The old empty/4-byte pop and 8-byte drain forms keep their contracts.

On a lost or malformed reply, C retains that transaction and its client-mask
custody. The next `glGetError` first uses read-only `QOP_ERROR_DRAIN_RECEIPT`
to recover the exact completed transfer or prove nonentry. It never retries
an entered drain. Recovery neither selects a native context, captures/drains
errors, interrupts an upload nor synchronizes buffers; ordinary current-thread
and context ownership still apply. After recovery a fresh drain observes new
queued work before local knowledge can resume. The original failed call has
already returned `INVALID_OPERATION`, so recovery consumes that earlier
coalesced flag once while preserving other flags and a later repetition.
Only the successor transaction may enter. Serial context ownership and one
outstanding call make unsigned 32-bit wrap unambiguous; no exhaustion boundary
is added. Unexpected drain bookkeeping faults retain indeterminate custody
and report a fatal attributed host fault. Acknowledged backend retirement clears its numeric receipt. Normal successful checks retain one device request;
additional read-only recovery occurs only on failure.

The scalar validator also covers viewport/scissor dimensions, capabilities,
depth/face/line arguments, blend factors/equations, stencil arguments,
attribute enable/disable, active texture and pixel-store alignment. Their
original records, including rejected arguments, still reach the independent
host validator. Locally predicted flags live beside held flags in the guest;
`OP_ERROR_OBSERVED` records their pending mask and the one flag already
returned by `glGetError`. The host consumes that flag at this exact stream
position, preserving unrelated flags and allowing a later command to record
the same value again. It performs no native GL operation. The fatal audit
compares the pending mask before consumption and rejects a divergence with
process, context, batch and operation identity. Client-only guards remain a
separate error source and cannot mask an incorrect command prediction.
Reserving an observation can submit a full buffer; the guest rechecks the
epoch before consuming any flag and uses the ordinary drain if it changed.
A fully checked synchronous mutation receipt can retain an existing exact
proof. The guest snapshots its current encoder, command-buffer base and
request count before the query. It restores knowledge only for an accepted
mutation in the same context, with exactly one device request, an emptied
command buffer, no reset and no pending client-only trailer. Ordinary query
success, an unknown prefix, extra I/O and rejected or malformed receipts
provide no such proof. Binds still execute synchronously. An unreturned
predicted flag may remain on the host after acceptance; even with an empty
buffer, a local `glGetError` must queue its ordered observation before
consuming that flag. Later I/O revokes the proof through the normal epoch
check.

Validated array-buffer storage definitions can also extend an existing exact
error proof. Their binding must have a separate acceptance proof: a lost
mutation reply can change the host binding without publishing its C mirror,
and draining error flags cannot recover that binding. Failed transport,
failed submission and indeterminate mutation replies revoke binding
knowledge. Until an acknowledged array bind restores it, `glBufferData`
checks actual binding presence through the existing buffer-parameter query
and leaves error observation on the ordinary drain path. It does not infer
an object identity from that query. Healthy acknowledged bindings need no
extra query. Element-buffer definitions retain the ordinary path because
queued vertex-array selection is not yet mirrored exactly.

Large `glBufferData` calls define storage and fill it with the existing
bounded subdata records. The driver preserves its exact error proof
across that fill only for a known array binding and an uninterrupted
prefix: each chunk is in range of the immediately preceding definition.
The normal request epoch and cursor checks revoke that proof if reserve
submits mid-call or foreign device I/O intervenes. Standalone
`glBufferSubData`, unknown bindings and element-buffer definitions
retain their normal error observation. No storage-size cache or extra
per-draw/per-frame owner scan is introduced.

The large path emits its definition directly and stops if reservation
fails. A recursive void definition used to return after a refused
prefix, allowing the outer call to fill unrelated old storage. After a
lost accepted bind reply, the normal checked binding-presence query
remains sufficient for the complete large definition and fill; a stale C
name cannot reject a buffer that the host actually bound. Such unknown
bindings still do not establish local error knowledge. Native controls
verify complete bytes, held errors, standalone fallback, rollover
revocation, refused-prefix stop and actual binding recovery.

Admitted program journals also support exact scalar, vector and matrix
uniform error prediction. Each cold journal owns32 numeric signature cells keyed by
its current generation token and dense uniform location. Token zero
identifies the executable installed at admission; successful same-name
selections still update the token, rejected selections keep their
predecessor, and closure clears the cache. Public names cannot prove a
signature because a peer relink leaves this context's older executable
installed.

Small inline client-array draws can also retain the error proof when all
enabled attributes have known client definitions and packed source spans,
the default VAO/framebuffer have never been displaced and EGL has a live draw
surface. A cold bounded scan of the owned executable's uniform signatures
proves that every active sampler has the same guest type (or that there are
none); numeric per-token cells, with a last-cell hint, retain that immutable
fact until journal closure. It does not infer a signature from a mutable public
program name. Original draw records still
reach the independent host validator and error audit. Mixed client/VBO rows,
mixed sampler types, unresolved metadata and framebuffer/VAO uncertainty retain
the existing error observation. Buffer-backed draw/storage authority remains
separate required B1 work; this selected proof does not complete the stage.
No additional scan runs when the draw has no inline client arrays.

Vertex-pointer setters reserve their complete command record before changing
C layout or buffer-reference ownership. A refused rollover prefix leaves the
old size, type, normalization and pointer observable through getters; it
cannot publish a new client layout whose command was never recorded.

Optional journal action8 reads the owned immutable pin's uniform type,
remaining array elements and already-known native-location state. It
requires own-current-thread/context/journal authority, cannot run
through the lifecycle barrier, leaves sealed mutation receipts intact
and neither selects the queried program nor drains errors, interrupts
uploads, resolves deferred long names or synchronizes buffers. A cold C
miss publishes metadata and submits only the caller's prefix. Small
scalar, vector and matrix updates retain the exact error proof for type,
boolean conversion, count and native-location presence checks while their
original records reach the independent host oracle. Sampler integer setters
check only the accepted array prefix, ignoring excessive tails. They use an
already learned immutable texture-unit limit, or accept only units0–7 under
the ES2 guaranteed minimum; other values keep host observation until the
existing explicit active-texture path learns the actual limit. Ordinary
setters add no limit query.

Optional action9 uses the same request and reply lengths to add the guest type
in reply word9. Action8 retains its exact layout, including zero in word9.
The guest type comes from the owned executable's existing translation metadata:
ordinary and external2D samplers have the same native setter type but different
guest types, while translated cubes have a different native type. Draw proof
requests action9, upgrades an existing numeric signature cell in place and
refuses unknown or mixed guest kinds. Same-kind sampler arrays are permitted;
same-kind samplers cannot conflict solely because they share a texture unit.
Ordinary uniform
setters keep action8 and add no guest-type query. Both queries preserve the
same current-thread/context/journal authority and immutable-generation lifetime.
This cache is not B4's public program interface.

Inactive location-1 updates use known logical executable presence without
reading data. Unresolved positive-count
locations, ordinary/uncertain state and large uniform uploads keep
ordinary observation. Journals now admit ordinary applications at their
first eligible program selection. A failed standalone numeric getter revokes
binding/error observation without discarding the independently owned program
namespace: it cannot create, delete, relink or select a program. In particular,
GLES3 version probes rejected by the GLES2 surface do not permanently disable
local program selection. Compound submissions with uncertain mutating prefixes
and ENODEV resets still revoke program knowledge. The failed getter preserves
its GL error and leaves caller output untouched. This remains partial B1 and
does not finish B4's once-per-link interface cache.

Ordinary vertex-layout updates can reuse an existing host attribute slot
inside an authoritative guest batch. Aligned BYTE/UNSIGNED_BYTE/SHORT/
UNSIGNED_SHORT/FLOAT layouts with stride at most 255 need neither a shadow
map clone nor a native-retirement reservation. First installations, converted
layouts and private exact owners keep the transactional path. The guest
extends its error proof only for a known array binding, a known existing
slot and a context that has never selected a nondefault VAO. Attribute
creation remains ordered before use. Indeterminate submissions or mutations
revoke slot knowledge separately from error flags; acknowledging an array
bind does not restore those slots. Wider encoded offsets remain outside this
proof. Client arrays retain their usual draw-time staging.

Program selection retains its ordinary submission/error path. A successful
link-status observation alone cannot prove future program namespace or
executable ownership. A new sharing context on another pthread can delete or
relink a program while its selection is still queued. Guest validation must
retain logical current and pending-version references before making that
selection local; disabling a cache after sharing begins cannot repair work
already accepted. The normal program-sharing fixture keeps the original
context current, deletes its program through a newly created peer, then
checks errors and rendered pixels in the original context.

This is still partial B1; the remaining draw/object validation, later driver
stages and desktop acceptance measurements are not established by these
scalar checks.
Host object groups own shareable name maps, shader/program metadata and
imported textures. Normal EGL shared-context creation joins the requested
source group on its renderer. Context state, errors, VAOs and FBO containers
stay local. Group resources survive member retirement until the last owner
ends; pending program deletion and retained link executables consider
every member.
Deleted texture/renderbuffer names now retain their native objects while
another context binding or FBO attachment still refers to them. Deletion
unbinds only the caller and detaches only its bound FBO attachments;
unbound FBOs retain storage. Reusing a name creates a distinct object, while
surviving bindings still query their original name. Packed depth/stencil
attachments retain each point independently. Native retirement follows the
last reference; BO-owned textures retain their separate canonical owner.
Deleted buffer names likewise retain native objects referenced by other
contexts or unbound VAOs. Array bindings stay context-local; element bindings
and attribute definitions belong to each VAO. Caller deletion clears only its
active VAO references, using the legal native null-buffer attribute definition
to clear references without allocating scratch storage or deleting shared
storage. Logical offsets and strides remain intact. Retirement scans every group
member and container. The C encoder mirrors VAO ownership, reserves buffer
names and distinguishes reused-name generations; failed client staging drops
temporary names and suppresses the draw. Logical buffer stores track size,
usage and one authoritative native view; separate stable vertex/index views
synchronize before binding, partial updates and draws. Transfers use bounded
independent 64 KiB readback chunks, preserve native copy bindings and avoid a
full CPU mirror. Queries and retirement resolve each view to the logical
identity, including old references after name reuse. Failed synchronization
keeps the view invalid and suppresses drawing until a successful retry.
Fixed-point and wide-stride attributes use stable packed derived views.
Raw source updates invalidate them; conversion uses bounded independent
source/output chunks and preserves native copy bindings. Logical VAOs retain
GLES formats, strides and offsets while native pointers use packed data.
Disabled/unbound attributes retain views; replacement and container teardown
release unused views. Small positive nonindexed client-array draws on the
default VAO use one owned `OP_DRAW_CLIENT_ARRAYS` record (0x0506). Its
16-byte header and sorted 20-byte attribute descriptors carry only packed
referenced elements, with a total payload at most 65535 bytes and at most
16 attributes. The encoder validates every source layout and overflow before
reservation or source reads. No public buffer names or logical ARRAY bindings
change. The host validates the whole record before effects, copies bounded
independent upload bytes, converts FIXED values and reserves retirement
receipts before acquiring private native buffers. Checked pointer inverses
restore the exact prior null definitions and ARRAY selector. Failed inverses
fence subsequent work and retain backing until repair; cleanup retries never
replay a submitted draw. Mixed public VBO attributes retain their normal
storage preparation. Indexed, larger, zero-count and named-VAO draws retain
the existing path. Normal guest/desktop acceptance of this new record is
pending; isolated C and native-browser evidence is in the compatibility ledger.
Client staging likewise packs only referenced elements,
avoiding unreadable prefixes, stride gaps and sparse-index holes, with bounded
scratch/masks and signed size checks. Indexed draws widen byte/short values into private native index buffers,
using bounded chunks and one draw to preserve complete primitive topology.
This keeps GLES2 maximum indices from becoming WebGL restart markers.
Native element/copy bindings are restored and private handles deleted on
all exits. Core draw enums are checked before client reads. Bound index
buffers can also drive client attributes: a checked synchronous query reads
the authoritative index storage and returns its maximum and an 8192-byte
presence bitset. The encoder stages only referenced client vertices. New
operation-table v3 queries use a status/payload/completion envelope; GL
failures remain owned by the host error flags, and malformed/incomplete
replies preserve caller outputs. Existing operation layouts remain valid;
the global ABI stays 55. Buffer queries read logical size/usage rather than
stale native views. Vertex queries preserve original client pointers,
formats and strides despite private draw staging. Object and enable
predicates use the appropriate logical namespace and context state.
Operation-table v4 adds core attribute/source/attached-shader and image
parameter queries plus program validation. Original source bytes belong to
the shared shader object; attachment queries retain old names through
namespace reuse. String/list replies use bounded chunks, with private C
accumulation before caller outputs change. EGLImage attachment queries
translate matching native storage back to its public sibling type/name.
Each GLES context also owns separate unnamed 2D and cube textures. Private
native stand-ins materialize on storage/parameter use and bind to every
unit whose logical name is zero, including unselected units. Muxer replay,
named-object deletion and explicit zero binding restore those stand-ins;
queries still return name zero. They do not enter shared name maps and
retire with their individual context. Failed allocation/binding rolls back
partial installation and suppresses the dependent texture operation.
Operation-table v5 removes the single-record shader source upload limit.
Large source calls concatenate into bounded acknowledged chunks and commit
only a complete upload. Pending bytes belong to one context; replacement,
abort, shader deletion and context teardown retire that ownership. Source
bytes belong to the shared shader only after native installation succeeds.
Failed submissions are observable and stop dependent queries/uploads.
All 142 GLES2 core symbols are defined and resolved. Full conformance,
complete query/negative/limit coverage, device-failure propagation, image sibling
sampler identity, kernel display-generation authority and C group routing
remain open.
Shader/program attachment records retain deleted shaders and current
programs until their last logical reference releases. Native program deletion
is deferred while the program is current in its owner, allowing muxer replay
after another owner temporarily uses the shared WebGL context. Rejected
program switches and attachments preserve the prior ownership state and keep
the driver's error observable. Destroying a context unbinds its physically
current program before deleting objects, without unbinding another owner.
The logical current program name is distinct from its installed native
executable. Relinking a current program uses a separate native link target:
failure updates link status/logs while keeping the installed executable;
success installs the replacement, which keeps the previous uniform
numbering when its active uniforms are identical. Shader
attachments and explicit attribute bindings seed replacement targets. Native
shader deletion is deferred while these logical attachments retain it.
Context teardown releases both the latest link target and any older installed
executable.
Foreign BO uploads save the physical context's alignment and unpack skips,
neutralize them for the upload, and restore them even on failure. A failed
new upload does not publish a texture name. Node
hosts without WebGL2 cannot render these sessions; no software simulation
stands in for the native LÖVE renderer.

Operation-table v11 adds checked implicit-bound image target/state queries.
They address the retained logical object rather than resolving its public
number again after peer deletion/reuse. A shared per-object image-association
revision advances on accepted import/orphaning, remains unchanged after
definite replacement failure and is removed at final native collection.
Unsigned revision exhaustion fails before publication. The v10 explicit-name
queries keep their original request/reply layouts. C imports and orphan-state
reads use the implicit-bound queries. Shared retained C records own confirmed
image/source/revision state; bindings and containers retain those records
instead of separate image/query mirrors. Publication accepts newer revisions
and discards stale candidates. Older owned-state replies cannot clear a
newer import or authorize dependent texture rows. Standard C name-based
transactions now serialize lookup through publication across peers. Raw WPK
publication uses the same group scope. Its retained group also reserves one
pending unpublished texture name before native allocation can occur. Rejected
or unknown candidate deletion keeps that slot; subsequent name transactions
and object-existence queries must reconcile it before proceeding. No new raw
allocation or ordinary realization can reuse the name while cleanup is pending.
Deletion is safely repeatable here because the candidate was never published
and group dispatch prevents reuse; general opaque mutations are not retried.
The slot survives submitting-encoder retirement, and final acknowledged native
group teardown owns remaining candidate destruction. General failure
reconciliation and full error validation remain open.
Indeterminate import candidates already belong to the group: submitting
encoder retirement cannot release backing a peer might retain. Final group
retirement releases these candidates outside the metadata mutex.

Operation-table v12 adds checked image attachment/deletion and allocation.
C container and namespace references publish only after accepted native
mutation. Uncertain attachments pin the candidate object in the shared
group's quarantine, preserving the old C attachment until reconciliation or
retirement. Confirmed backing follows the retained object itself. Texture
allocation is acknowledged before C emits pixel rows, so a failed allocation
cannot overwrite existing storage through later rows.
Queued/checked paths share host ownership transactions and storage dispatch.
Metadata allocation precedes native effects; definite deletion failure restores
attempted active attachments and bindings. FBO deletion preserves separate
read/draw defaults. General transport and context-loss recovery remain incomplete.

Operation-table v13 adds an exact checked framebuffer-bind query. C updates
its attachment-container selection only after native acceptance. Host queued
and checked binds share candidate realization, namespace staging and rollback,
including independent EGL read/draw defaults. Indeterminate completion still
needs general native/client reconciliation before full sharing is supported.

Operation-table v14 adds a checked buffer-bind query (target/name, eight-byte
input, 12-byte acceptance reply). C changes its ARRAY/ELEMENT object record,
name and serial only after acceptance, preserving pointer interpretation on
definite rejection. Queued and checked host binds share native realization,
view synchronization and rollback. Namespace/store/view metadata is reserved
before binding; failed candidates and their metadata are removed and prior
native selection restored. Standard name transactions use group dispatch
serialization. Indeterminate completion still requires general reconciliation.

Operation-table v15 adds checked single-name buffer deletion (four-byte
input, 12-byte acceptance reply). C pins the selected record through native
acceptance before releasing namespace, active ARRAY/ELEMENT and active-VAO
attribute references. Host queued/batched and checked deletion share staged
namespace/retired/attribute metadata. Native clearing uses a temporary buffer,
then checks individual attribute, ARRAY and ELEMENT changes. A definite
failure restores attempted steps in reverse, including original converted
vertex views and the separate native index view. Metadata publishes after
all native changes accept; final storage collection follows logical retirement.
Inactive containers, other contexts and saved client-array identities keep
retired storage. Failed native restoration now retains typed inverse calls for
buffer deletion, image deletion and framebuffer selection/deletion. The repair
record is reserved before mutation and belongs to the physical native context,
so neither the same logical context nor another group can run over dirty state.
Recovery replays all attempted inverses, including the rejected step. Selector
failure suppresses dependent calls; independent restorations are still attempted.
Only native handles, scalars, error flags and context-local shadow lifetime enter
the journal. Callbacks and guest bindings are excluded. Queries preserve output
when restoration remains blocked, command batches stop before dependent records,
and muxer switching repairs before its cached-owner shortcut. Surface/current/
GPU allocation and raw BO revocation also respect pending repairs. Image
import/orphan/retarget utility work and buffer binding/copy-view synchronization
use the same journal. Nested plans restore copy selectors before the outer
binding can complete. Image retargeting stages each affected peer container and
the selected native bindings, restoring utility selectors on success or failure.
Its shared inverse survives submitter retirement; retiring a native container
prunes that target instead of reviving it. Context-local plans retire with their
owner. Neither path destroys shared peer objects.

Once a change is known to be rejected, its pending native inverse is exact
host recovery even if it shares the active guest batch's error owner.
Prediction cannot establish that restoration completed. A live renderer
refusing that recovery remains fatal; real renderer loss drops obsolete
native state. This scope runs on pending recovery, while ordinary successful
guest acceptance keeps its batch prediction and native sampling policy.

Native candidate and retired-view ownership is reserved before allocation or
publication. Cleanup receipts retain handles across failed deletion, clear each
accepted delete independently and retry the remainder without repeating accepted
calls. Image destruction retains its receipt until collection completes. Pending
cleanup gates native work and delays canonical GPU BO retirement. Native cleanup
keeps the retired error owner; a reused session receives a fresh error array.
These native inverse and cleanup records retain no full guest binding or
address space. Vertex pointer installation stages its attribute map, converted
view maps and view field before native effects. Both normal and converted formats
retain the prior native pointer and ARRAY selection through rejection. Restoring
an initially unbound attribute allocates an owned private buffer only if inverse
repair needs one, then retires it after restoration. Native GLES2 format/size/
index/stride preflight uses the actual attribute limit.

Private client-array END records retain a native completion ticket. Native repair
sets the ticket; query, decoder and muxer admission publish the saved ARRAY
identity and release the capture pin before using or replaying state. Reservation
failure preserves the end request, and failed decoded batches request restoration
for an active capture. Neither path requires another private END record. Local
retirement cancels the ticket without publishing into a reused context. Tickets
contain only native identity/scalar completion, with no guest-binding callback.

Promoted-index and deletion temporaries use reserved ownership and retained
selectors. Recovery never repeats the already accepted draw. Converted cache
retirement and final buffer collection share cleanup dependencies, preventing
duplicate accepted deletes. Reusing a layout after completed retirement creates
a new native view rather than reviving the old handle.

Raw CPU uploads and GPU carrier initialization also reserve native ownership
before creating their texture. Namespace or native failure leaves cleanup owned
until deletion accepts. CPU uploads journal selection of unit zero before
querying its binding, then reserve a nested texture/unpack finalizer before
upload effects. GPU initialization retains its actual active-unit binding.
Failed utility restoration fences queries and subsequent uploads; repair and
candidate cleanup survive retirement of the submitting context. Pixel-store
inverses contain only scalar state, with no upload bytes or guest address space.
Accepted uploads are not replayed by native repair. CPU image coherence, other
resources and the full staging/error audit remain open. Indeterminate transport,
context loss/recreation and general failed resource deletion remain open.

Raw BO revocation stages retired-name and peer-container metadata before native
detachment. It captures actual unit bindings in a separate retained utility
transaction, completing active-unit restoration before attachment/binding
mutations. A shared mutation plan snapshots native image attachment identities,
sampling views and separate draw/read selectors. Failed detach or utility
finalization retains every attempted inverse and fences dependent work before
logical retirement commits. Repair survives submitting-context and final-member
retirement; native container retirement prunes dead targets. BO canonical
storage remains owned until shared repairs and native view cleanup complete.
These records contain native handles/scalars rather than callbacks, logical
bindings or guest memory.

Public `eglCreateContext` sharing validates a live source handle in the active
display generation, joins its retained C object owner, and sends the source
backend identity through the existing ABI-58 creation request. Native failure
unwinds the unpublished encoder/session without disturbing the source. Source
retirement does not retire objects retained by peers. Standard name-based C
operations hold a separate group dispatch mutex across lookup, checked native
mutation and client publication. Scoped cleanup releases it on every return;
cancellation is disabled during the transaction and the caller's state restored
after unlocking. Metadata reservation remains independent, allowing final image
cleanup to reenter the allocator without holding its mutex. This establishes
ordinary shared creation and tested name ordering, not complete sharing
conformance: indeterminate transport, multiple native restoration failures and
worker/process crash recovery still need their full audit and normal guest
lifecycle validation.

Raw WPK BO texture publication holds the C group dispatch scope across the
checked command flush, native candidate allocation and C namespace adoption.
Native allocation skips realized names; C rejects candidates that collide with
reserved or ordinary names, deletes only the unpublished candidate through the
existing checked image-delete query and retries. A rejected flush cannot publish
a raw name. The private cross-archive guard changes no device/wire layout.

GPU raw imports own distinct logical texture views of private canonical BO
pixels. Parameters and respecification belong to the logical object. Explicit
refresh can reimport canonical pixels into the same live object; delete and
reimport creates a new identity, preserving peers' retained deleted views.
CPU raw imports still upload snapshots; full CPU canonical coherence is open.

BO ownership tracks every raw view by object identity, including deleted names
retained by peer bindings or containers. BO retirement clears those references
without deleting an unrelated replacement using the same public number. Native
detachment and utility state restoration precede logical publication. Definite
failure keeps a cleanup journal and canonical GPU storage for retry, including
after the last member retires. Journal owners hold only shared object metadata,
native context and error state, never guest memory authority. Dependent submit,
query, present and raw-bind operations retry pending retirement and reject an
affected group while its raw views remain. Invalid query destinations and
malformed command spans are rejected before cleanup is attempted. Native view
and canonical deletion failures remain reachable for retry. This does not
establish general recovery after repeated rollback failure or context loss.

The user-space libraries are sysroot libraries, not kernel build outputs:
`scripts/build-musl.sh` installs the headers, resolves the `libdrm` package
into `sysroot/lib/libdrm.a`, and builds `libgbm.a`, `libEGL.a`, and
`libGLESv2.a` from `libc/glue/`, plus matching pkg-config files. `libdrm` is
upstream 2.4.120, KMS subset only — the kernel implements enough of the
`DRM_IOCTL_MODE_*` surface for unmodified upstream sources to drive it.
Packages that depend on these APIs link through `wasm32posix-pkg-config` and
declare their resulting program artifacts as packages. The `modeset` demo is
one such package: its VFS image installs `/usr/local/bin/modeset`, and
`/etc/kandelo/demo.json` selects the KMS surface and the `init.shellCommand`
that starts it. The browser loader stays generic; it does not special-case
`modeset.wasm`.

## Performance Architecture

### The dedicated worker thread is the optimization

The single most impactful performance decision is running the kernel in a dedicated worker thread (`NodeKernelHost` on Node.js, `BrowserKernel` on browsers). Benchmarked gains from the worker thread architecture vs. running the kernel on the main thread:

| Metric | Main thread | Worker thread | Change |
|--------|------------|---------------|--------|
| pipe_mbps | 10.9 | 24.1 | **+121%** |
| clone_ms | 94.1 | 36.7 | **-61%** |
| fork_ms | 243.8 | 176.9 | **-27%** |
| exec_ms | 186.9 | 171.5 | -8% |
| hello_start_ms | 88.2 | 139.6 | +58% (kernel thread startup cost) |
| file_read_mbps | 236.0 | 188.4 | -20% |

The `hello_start` regression is a fixed one-time cost: spinning up the kernel worker thread (~50ms). For any workload that runs more than a trivial number of syscalls, the dedicated thread wins.

### Do not micro-optimize the syscall hot path

The following "optimizations" in `kernel-worker.ts` were benchmarked and **all made performance worse**:

1. **Syscall argument count tables** (`SYSCALL_ARG_COUNTS`): Reading fewer BigInt args per syscall based on a lookup table. Saved ~nanoseconds per syscall but added branch overhead and a critical correctness risk — if the table uses wrong syscall numbers, args are silently zeroed, breaking networking and other subsystems.

2. **I/O syscall classification** (`IO_SYSCALLS`): Skipping `drainAndProcessWakeupEvents()` for non-I/O syscalls. The drain is cheap when there are no events, and skipping it risks missing wakeups in edge cases.

3. **Cached TypedArray views**: Caching `DataView` and `Int32Array` on channel structs to avoid re-creation. V8 already optimizes `new DataView()` to near-zero cost; the cache adds memory overhead and invalidation complexity for no measurable gain.

4. **Conditional debug ring logging**: Skipping syscall ring buffer entries for 0-arg syscalls. The ring buffer is a fixed-size array push — negligible cost, but valuable for crash diagnostics.

**Why they fail**: The Wasm kernel execution (calling `kernel_handle_channel` which dispatches into Rust-compiled syscall logic) dominates each syscall's wall time. The TypeScript overhead around it — reading 6 args, creating views, draining events, logging — is noise. Micro-optimizing noise adds complexity and risk for no throughput gain.

**What to optimize instead**: If syscall throughput needs improvement, focus on the kernel Wasm code (`crates/kernel/`), the channel protocol, or the worker thread scheduling. The TypeScript host path is not the bottleneck.

## Build System

### Repository Setup

`./run.sh setup` is the single entry point for a working repo, not just
a kernel build. It delegates to xtask's bootstrap step plan
(`tools/xtask/src/local_build.rs::bootstrap_step_plan`), which runs, in
order:

1. `fork-instrument-tool` — builds the Wasm fork continuation instrumentation tool
2. `sysroot` — provisions the wasm32 musl sysroot: builds it from source the first time, or just re-syncs overlay headers if it already exists
3. `sysroot64` — provisions the wasm64 musl sysroot the same way
4. `sdk` — verifies the `wasm32posix-cc` toolchain wrappers resolve against `sysroot`
5. `engine` — builds every package in the local-build graph, including the kernel: `cargo build` with `-Z build-std=core,alloc` targeting `wasm32-unknown-unknown`, then copies `kandelo-kernel.wasm` to `host/wasm/`
6. `rootfs` — builds the canonical rootfs image via `scripts/build-rootfs.sh`, which invokes the `mkrootfs` CLI (`tools/mkrootfs/`) against the top-level `MANIFEST` + `images/rootfs/` source tree, stamps the current `ABI_VERSION` into image metadata, and writes `host/wasm/rootfs.vfs.zst`
7. `host-dist` — builds the TypeScript host via `npm run build` (tsup → ESM + CJS)

```bash
./run.sh setup
```

(`bash build.sh` still works as a deprecated delegator to the same command.)

Building the example/test C programs under `programs/*.c` is a separate
step that `./run.sh setup` does not run: use `./run.sh build programs`
(`scripts/build-programs.sh`) when you need them, e.g. for the wasm64
Vitest cases or benchmark suites.

`host/wasm/` is gitignored — `rootfs.vfs.zst`, `kernel.wasm`, and the rest are built artifacts. `tools/mkrootfs/` is the source of the image-builder CLI; the canonical owners/modes/sticky-bits live in `MANIFEST`, the file content under `images/rootfs/`.

Manifest node paths and archive mount points use canonical absolute POSIX
paths. ZIP archives ingested by `mkrootfs` require byte-exact UTF-8 canonical
relative member paths; unsafe aliases or type-conflicting path graphs fail
before VFS mutation. Unix ZIP symlinks retain their validated target payload
and archive-declared ownership, including relative targets with parent
components.

### User Program Compilation

The SDK (`sdk/`) provides `wasm32posix-cc` which wraps clang with:
- `--target=wasm32-unknown-unknown`
- `-matomics -mbulk-memory -mexception-handling` (Wasm features)
- `--sysroot=<path to musl sysroot>`
- Links: `channel_syscall.c` + `compiler_rt.c` + `crt1.o` + `libc.a`
- Linker flags: `--import-memory --shared-memory --max-memory=1073741824`

For programs that use `fork()` or fork-like helpers, the in-tree
`wasm-fork-instrument` tool (see
[fork-instrumentation.md](fork-instrumentation.md)) runs after linking and
after any `wasm-opt` pass, and then runs `wasm-opt -O2` over its own output.
Build scripts call
`scripts/run-wasm-fork-instrument.sh`, which builds the tool on demand if the
prebuilt `tools/bin/wasm-fork-instrument` is absent. The tool auto-discovers
fork-path functions via call-graph analysis from the `kernel.kernel_fork`
import; no onlylist is needed. Legacy Asyncify artifacts are not supported.

### Package system

Every artifact under `packages/registry/<name>/` is a **package**. Each ships two TOML files:

- **`package.toml`** — the **recipe**: name, version, upstream source pin, license, dependencies, `[build].script_path`. Identity-and-constraints. Project-agnostic; same content across any project that depends on this package.
- **`build.toml`** — the **project view**: `script_path` (this project's actual build), `repo_url` + `commit` (where the recipe lives in this project), `revision` (a cache-key input), declared build `inputs`, and any `[[git_inputs]]`. Differs per project.

Package resolution is **local-first**: every package is source-built through the SDK/libc/resolver and cached locally by content hash. There is no remote prebuilt-binary channel. See `docs/package-management.md` for the reference manual.

**Resolver flow** (`xtask build-deps resolve`, called from build scripts):

1. Read `packages/registry/<name>/package.toml` for the recipe and `packages/registry/<name>/build.toml` for the project view (`revision`, build inputs).
2. Return a hand-patched override under `local-libs/<name>/build/` (libraries) or `local-binaries/programs/<arch>/...` (programs) if present.
3. Otherwise return the canonical content-addressed cache entry `<cache_root>/libs/<name>-<ver>-rev<N>-<arch>-abi<ABI>-<cache-key-sha>/` if it exists.
4. On a cache miss, **build from source**: fetch the upstream source archive from `[source].url`, verify it against `[source].sha256`, run `build-<name>.sh` via the SDK, validate the declared outputs, and atomically install the result into the canonical cache.

The cache key is computed over the recipe identity, `revision`, source pin, target arch, `ABI_VERSION`, declared outputs, declared build inputs, `[[git_inputs]]`, the global toolchain/sysroot fingerprint, and the transitive dependency cache keys. Any change to those inputs invalidates the entry and triggers a source rebuild of that package and its dependents.

The `[binary]` block that once declared a remote publish/fetch location was removed with the remote binary channel; `validate_source` rejects it in `package.toml` or `build.toml`.

For schema, cache-key hashing, resolver ordering, and the build-script contract see [docs/package-management.md](package-management.md).

## Test Suites

Validation always runs through `scripts/dev-shell.sh`. Kernel, host, ABI,
libc, Open POSIX, Sortix, fork-instrument, and real-browser suites prove
different contracts; there is no fixed short list whose success establishes
every change. Use the CI-shaped commands and change-to-suite matrix in
[`docs/agent-guidance/validation.md`](agent-guidance/validation.md), including
generated-file/snapshot checks for ABI-adjacent work and real Chromium
evidence for shared browser runtime changes. Report exact commands, counts,
unexpected failures, skipped suites, and environmental blocks rather than
using a narrow passing suite as a broad readiness claim.

### Filesystem notification readiness

The host checks `kernel_fs_changes_pending` after each operation with active
watches, in the same entry. It schedules a separate drain only when records
are pending. Actual record copies and observer callbacks retain their
existing ownership and worker-turn boundaries on Node and browser.

An operation helper receives the live entry explicitly for this scalar
read. The entry-construction function creates the context and orders its
effects; it does not call kernel exports. Gateways forward only the
original operation and the gate callback's exact scope and effect
registrar. Notification callbacks and their captured state are created
only on the active-watch path.


### Native desktop measurement endpoint

`benchmarks/desktop-latency/` contains an external macOS owned-window
observer, separate from Kandelo's production rendering path. Its native
pixel matcher compares sparse calibrated foreground samples at bounded
candidate positions. Ambiguous and missing matches are observations, not
successful responses. Calibration alone may request window rasters; timed
matching emits scalar identities and scores. The Node/browser graphics
contract is unchanged by this diagnostic.

ScreenCaptureKit display metadata is an upper endpoint for the first visible
response if capture coalesces frames. The preceding captured non-response
provides the lower endpoint, with asymmetric clock uncertainty on both.
Clock-only bounds around the first captured response are insufficient.
Coordinates, actual guest cursor/content correlation and instrumentation
overhead must be validated before this observer establishes desktop latency.
Headless DOM/worker pixel controls establish classification only.


The moving-pixel controller fits CSS viewport coordinates from temporary
markers rather than assuming browser toolbar offsets. It learns templates
from foreground/background captures separately for each pose, then validates
each identity in fresh frames. The shared matcher bounds the sum of all
candidate-template comparisons. This accounts for position-dependent edge
coverage at fractional capture scales without widening match tolerances. Capture output is explicitly sRGB so marker bytes
have a declared color space. Browser PNG and native compositor edge coverage
are not treated as interchangeable. A shared headless replay exercises the
controller with synthetic geometry/timestamps; it cannot establish native
desktop latency. The native path remains driven by WindowServer samples,
with no worker-acknowledgement substitute for a visible response.


The cursor template rectangle is bounded at128×128 raster pixels, with at
most256 sparse points. This accommodates calibrated CSS patches at display
scale, including a near-unit fit that rounds63 CSS pixels to65 raster
pixels. Native calibration uses its retained WindowServer rasters directly;
extra DevTools screenshots belong only to the headless path. R214 correlates
actual Foot and ScummVM cursor changes on a frozen partial-B1 Chromium
desktop, including concurrent ScummVM load and no-op controls. These eight
samples per cohort establish the method, not the final workload matrix,
tail distributions or total instrumentation overhead. See the
[native cursor measurement record](measurements/2026-11-04-native-desktop-cursor-method.md).


The opt-in desktop cursor method uses the same controller for real Foot and
ScummVM cursors through ordinary browser input, with original event timestamps
and separate KMS cursor pixels. ScummVM template qualification requires its
red software cursor; the browser OS cursor must be hidden. Headless replay
proves captured-pixel correlation with synthetic clocks only. Its screenshot
acquisition budgets and durations are separate from the native observer's
deadline and display timestamps. Native capture additionally requires the
owned window to fit fully on one display. Positive physical validation, total
instrumentation overhead and the full desktop workload matrix remain open.


Surfaceless EGL contexts retain normal GL error semantics: their absent
default framebuffer rejects clear, read and copy operations with
`GL_INVALID_FRAMEBUFFER_OPERATION` before native work. This guest API error
does not reset the context or its sharing peers. A later real drawable can
render normally. Real window-system default targets are complete by
construction; guest framebuffer attachment caches apply to user targets.


The guest driver has a narrow exact-error proof for logical-zero framebuffer
binds and clears on a real EGL drawable before any user framebuffer has been
selected. Indeterminate submissions revoke the clear proof permanently for
that context. Host execution still validates the original commands. Default
targets are preallocated: authoritative zero binds need no rollback metadata,
and GPU allocation reserves the color-storage write counter before publishing
its target. Private exact and user framebuffer operations keep transactional
allocation/error behavior; surfaceless clears retain ordinary host validation.


Program captures retain an exact native executable independently of its public
program name. Internal share-group captures remain private. Optional GL17
`QOP_PROGRAM_CAPTURE` (0x3a) exposes context-owned captures with ordinary query
replay, buffer dependencies and current-thread authority. Acquire is `[1,name]`,
checked selection is `[2,name,handle]`, and release is `[3,handle]`. The16-byte
reply is `[status,linked_or_accepted,handle_or_zero,QUERY_REPLY_MAGIC]`.
Successful acquisition of an unlinked program returns `[0,0,0,magic]` without
replacing an older current executable. Selection requires this context's exact
capture of the latest named executable; a stale, deleted or peer-owned capture
cannot select a different generation. Release may end a shared peer's context
cache owner, but cannot release a private internal group capture.

Acquisition reserves result storage and execution/cache ownership before
publication. Ordinary resource failure supplies no handle; refused private
native retirement is a fatal host fault, preserving custody for containment.
The registry closes each context's acquired cache before retiring its execution
and closes internal group caches before the last public context retires.
Accepted work retains independent clones. Retained private execution keeps its
installed native program but ceases to own a public program-name reference at
context destruction. Delete-pending names therefore disappear while accepted
work can still render using the retained native executable.

The C API does not yet consume these capture receipts. Its typed shared names,
current references and shader attachments remain on checked mutation receipts.
Complete C executable generations, pending-batch custody and ordered logical
current publication before enabling local program-selection error proofs.
These are intermediate B1 mechanisms, not application performance acceptance.


The optional GL17 `QOP_CREATE_SHADER_PROGRAM` receipt creates a reserved
shader/program name only on its owning current context. Its12-byte request
is `[object_kind, shader_type_or_zero, reserved_name]`, where4 denotes a
shader and5 a program; the12-byte reply is `[status, accepted_name_or_zero,
QUERY_REPLY_MAGIC]`. Status0 acknowledges the echoed name, while status1
has a zero payload and preserves the operation's API error in the original
binding. Malformed lengths, object kinds or a nonzero program type fail with
EINVAL before renderer execution and leave output untouched. Shader enums
remain API validation, including their priority over a colliding name.

This allocation path reserves both reply bytes and the reply view before
native ownership, then uses exact private allocation checks. Older guest
flags remain with the original context; a reply cannot acknowledge a
preexisting colliding object. Failed map publication rolls back the native
handle, and native OOM follows the existing local-reset boundary. The query
retains ordinary replay, CPU-image publication and buffer dependencies;
it does not bypass them or grant pre-MakeCurrent query authority. The C driver
now uses this receipt for glCreateShader/glCreateProgram and returns a name
only after canonical acceptance. It holds the existing dispatch/name scope
across admission, keeps name reservation monotonic, and never retries an
uncertain creation. A malformed or lost reply returns zero and invalidates
binding knowledge; older guest flags remain independently observable. The
legacy creation commands remain available to existing clients. No guest
program-selection cache is enabled: C executable-generation/pending references
and ordered logical-current publication remain necessary.

Immediate GL queries preserve a recognized renderer-reset ENODEV through
both plain and compound GLIO replies, allowing libc to record the already
specified reset scope. Other negative or oversized host results remain EIO.
Failure never publishes output bytes or authorizes a query replay. In
particular, native OOM resets only the guilty logical context while a healthy
shared peer keeps running; this is the existing native-OOM boundary, not a
new boundary for C metadata allocation failure.

The optional query is an additive program-surface snapshot entry. Existing
receipt fields are exact compatibility contracts, and their modification or
removal is rejected. Versions stay program56/host3/GL17/fork21; the changed
program digest requires normally rebuilt coherent programs and images.


The optional GL17 `QOP_PROGRAM_MUTATION` query admits one shared shader/program
operation through the ordinary dispatcher: attach/detach (12 input bytes),
delete shader/program, link or use (8 input bytes). Each input prefixes the
unchanged command payload with its u32 opcode. Kernel and host validate the
entire shape and require the caller's own current context before execution;
ordinary query replay and buffer dependencies remain in force. The12-byte
reply is `[status, accepted_boolean, QUERY_REPLY_MAGIC]`. An accepted command
returns `[0,1,magic]`; a recorded operation error returns `[1,0,magic]`.

The receipt reserves its staging bytes and view before dispatch. Its private
error scope uses the real binding, so current-program changes and peer
finalization publish to the actual context while older flags stay observable.
Even a repeated error already set before admission produces rejection. Reset
retains its existing authority and does not resurrect the old flags. A
completed link can have false LINK_STATUS and still be acknowledged: the
installed old executable remains separate from the latest failed link. An
unaccepted or uncertain reply supplies no new mirror-state proof and never
authorizes replay of a possibly executed mutation.

The ordinary C mutation entrypoints now wait for these receipts; no local
selector is enabled by this query. The remaining driver work is immutable
executable-generation/pending custody and ordered logical-current publication.
The additive program-surface mutation and capture entries change the digest,
with versions56/3/17/21 unchanged; final normal desktop products must be rebuilt
coherently.


The C driver now reserves a typed shader/program record before native creation
and publishes it only after the creation receipt. Attach, detach, use, delete
and link use the checked mutation query under the shared dispatch scope.
Current-context references and program attachment references retain separate C
records through delete-pending state. A context keeps its current-program
reference while unbound or transferred to another thread; retirement drops it
after host context destruction using C-only cleanup, with no query to the
dead session. The metadata mutex is not held across device IO, and cancellation
stays disabled until receipt handling and C publication finish.

Shared dispatch guards support same-thread nesting so a query, submission or
lifecycle barrier can compose with its surrounding object operation. The
recursive dispatch mutex keeps other threads excluded until the outer guard
ends. Only the outer name scope reconciles an unpublished external candidate;
an inner scope must not recursively reconcile that same candidate. Retirement
scopes keep their separate rule of performing no current-context reconciliation.
Each guard restores its incoming cancellation state after releasing its lock,
so pending asynchronous cancellation cannot interrupt outer C publication.
Ending a guard clears it; a later cleanup of that same guard has no effect.
The separate metadata mutex remains free across device IO. This composition
does not itself enable C journal publication or local program selection.

Every reference increment has reserved capacity before native admission.
Rejected or uncertain mutation receipts do not publish a new C reference;
uncertainty revokes group knowledge and never authorizes replay. Link-status
observations are serialized with mutations. The context-owned cold capture
layer below now retains native generations separately from these names;
pending-batch custody and ordered logical-current publication remain required.
Selection stays synchronous. This is intermediate B1 ownership implementation,
not native-feel acceptance.


The checked diagnostic C link/use path does not acquire private executable captures.
Its checked mutation receipt establishes public-name/current-reference state;
the host retains the installed executable independently. An explicitly admitted
journal acquires a native-generation pin only on a cold cache miss, registers
that pin with its journal token, then releases the temporary capture after the
exact receipt. The bounded token cache owns queued selection generations.
Removing the older selected/prepared capture descriptors avoids private device
queries for applications that never enable journals. A successful checked use
establishes a linked program; otherwise cold acquisition observes link status
before local acceptance. A failed link supplies no fresh capture and cannot
replace an older installed executable. Peer contexts acquire their own handles
and never read or flush another encoder. Captures do not keep public names alive.

Capture request, reply and compound-packet storage are embedded in the encoder
before its context is published. Cold capture publication and release therefore
need no later C heap allocation. Successful release clears its descriptor only
after the exact receipt. A rejected, malformed or uncertain capture operation
stops further acquisition in that context; known handles and any host owner
whose receipt was lost remain covered by acknowledged native-context retirement.
Transport failure also atomically revokes shared program-mirror knowledge.
None of this metadata authorizes guest-local program acceptance or a retry of
an uncertain mutation. The ordinary checked selection remains authoritative.

EGL holds its lifetime guard and the share group's dispatch guard across
GLIO_DESTROY_CONTEXT and C program/capture retirement. EBUSY/refusal preserves
all C owners. On acknowledgement the host has already closed its context-owned
capture index; C then drops descriptors and current-name references without
querying the destroyed session. Creation-failure encoders have no host captures.
Other object/image cleanup follows after releasing dispatch serialization.
This is cold program/context work, with no added draw/frame maintenance; its
application performance and the full final memory/conformance gates remain
unmeasured. The next layer must reserve independent pending-work/result custody
and publish ordered logical-current history before enabling local selection.

The prepared host `GlProgramJournal` separates a public logical program name
from the installed native executable. Only the public getter and name retirement
consult the optional logical owner; draw/uniform paths continue using installed
state. Journal activation and capture registration are cold operations. They
reserve bounded intent/result cells, an exact installed-executable root pin
(including an old executable after failed relink), and immutable captured
native generations before publication can begin.

Publication uses a shared group sequence and a per-context execution ticket.
It validates names/generations independently, changes logical name ownership,
and stores its result in the reserved cell. It does not install a native program
or insert an early error into the runtime queue. Execution later selects the
captured executable or records that stored error at its original command
position. Repeated errors separated by observations therefore remain distinct.
Each successor retains its predecessor until the native switch completes, even
if the predecessor has already lost its public name and cache owner.

Publication accepts metadata only within one process/object group. The optional
journal query validates the caller's live current-thread session authority;
peer entries name host-issued group-scoped journal handles, never context
pointers. Namespace cleanup uses the metadata caller's error owner, not the
target peer's. No peer native-selection authority is granted. Busy
cells, stale tickets and out-of-order execution are refused. Native selection
failure is consumed and cannot be replayed. A driver must drain and disable
journal mode before an ordinary synchronous link/use operation.

Public context retirement closes journal caches and logical name ownership
while accepted cells retain independent generation/context custody. Exact
cleanup refusals retain their receivers for containment; neither a partially
published cold index nor a failed public-name finalization loses ownership.
Session reuse clears the retired logical-name override. These mechanisms are
shared by Node and browser and add no journal lookup to draw/uniform handlers.

The optional GL17 query0x3b now exposes cold journal reservation, own-context
capture registration, batched logical publication, cache release/disable and
read-only recovery/status. The kernel freezes and validates the full nested
shape and destination before effects. A48-byte receipt retains transaction,
action, result and group/context progress; it is staged as indeterminate before
entry. A possibly entered mutation is never replayed: READ_LAST retrieves the
retained receipt, while indeterminate status blocks further mutators. Read-only
recovery remains available after reset, without native replay, error draining,
buffer synchronization or interruption of pending uploads. A recovered receipt
does not clear a context reset; existing reset-scope handling still governs
execution. The host import preflights its destination and reserves reply storage
before ordinary upload interruption or foreign retirement work. Its metadata
path preserves staged uniform/compressed transfers as well as older error flags;
the lower-level query exception alone is insufficient. Transactions and
handles are bounded nonzero u32 values; sequence/ticket counters are exact u53
values. Handles never wrap into older authority within their owning scope.

Receipt completion is published only after every progress field is sealed.
Unexpected exceptions before that seal follow the existing fatal host-invariant
path, attributed to process, session, transaction and action before propagation.
A partly published group cannot continue behind an ordinary EIO. Legitimate
context-reset unwinds and kernel-export faults retain their existing handling.
A lost copyout after a completed seal still recovers the retained receipt
without replay. Tests check both direct host queries and kernel imports, plus
actual browser machines refusing subsequent work after the fatal latch.

Publication preflights every row before committing any intent. Native command
0x030c selects only the submitting context's exact journal/slot/ticket. Original
error-observation records consume independently predicted slot results at their
execution positions. Neither peer metadata publication nor a retained pointer
grants new public submission authority. Metadata-only queries do not touch
buffer contents; actual submit prefixes and selectors retain ordinary buffer
ordering. Legacy queries and commands keep their existing contracts.

Lifecycle query0x3c provides only publication and recovery (actions3/6/7) through
a live public object context owned by the calling process. EGL retirement can
run without a current binding, yet pending peer selections must become visible
before retirement finalizes a delete-pending name. Rust checks creator PID,
context liveness, object-session role and mapped native-resource ownership.
An unbound context or one current on another thread grants only this metadata
capability. Ordinary0x3b operations keep their own-current-TID checks; creation,
capture registration, cache release/disable and native command prefixes gain no
authority from0x3c. A retained private execution cannot replace a live public
context. Both query paths share the outer context's transaction receipt ledger.
Publication fails after reset; read-only recovery remains available without
reviving the context. The explicitly admitted C prototype publishes through
this barrier before shared-name queries, caller-prefix submission and EGL
retirement, including retirement without a current GL binding.

A wire receipt owns logical metadata, not an admitted native job. Stage B submits
synchronously, so public context/session retirement discards abandoned wire
cells that can no longer be submitted. Retained host executions keep their
separate accepted-work lifetime. When adding asynchronous submission in C1,
transfer exact slot custody to the accepted job before admission and preserve
it through completion or explicit cancellation. Native program counts are
checked before whole-machine teardown, including pending-context destruction
and process exit, so terminating a worker cannot hide leaked owners.

The checked diagnostic path uses synchronous program selection. An
internal diagnostic admission entry point now enables a C selection prototype.
Each context owns a cold-allocated stream with a32-entry generation-token cache,
256 bounded intent/result slots and persistent request/recovery storage. Cache
keys include the public name and link epoch; private native captures and C
logical-current references retain separate executable and name lifetimes.
Warm selection reserves its command record and immutable shared intent before
local acceptance. Publication never reads or flushes a peer's mutable encoder.
Cold capture acquisition submits only the caller's older prefix. Successful
synchronous prefix acknowledgement permits slot reuse; asynchronous C1 jobs
must acquire explicit slot custody before their admission acknowledgement.

A group-level receiver is reserved before publication enters the device. If
its response is lost, another publisher must reconcile that receiver with
READ_LAST before issuing a new mutation. Read-only recovery validates the exact
transaction/action/count and clears only receipt uncertainty, preserving
execution-loss and capture ownership. A proven unchanged predecessor permits
retry; an unknown entered result cannot authorize replay. Group ownership is
stamped before any fork: inherited dispatch is refused before taking a possibly
orphaned mutex, and sharing such an encoder reports EGL_BAD_CONTEXT. A refused
cold registration releases known capture ownership after an acknowledged
journal disable, rather than dropping its descriptor.

A failed guest error observation now appends an empty transport-observation
record before any later command. It consumes only the coalesced earlier
INVALID_OPERATION that this call already returned. Other flags and later
repetitions remain independent; ordinary exact-mask observations retain their
fatal audit. Reserved tail space and coalescing adjacent failure records make
this path allocation-free without retrying publication or command execution.
Only the failure path scans records; unused encoders gain no failure-state
lookup per command. The optional Program snapshot section changes the contract
digest while keeping versions56/3/17/21, requiring normal matching products.

Connected C-journal controls now inject native OOM during selector execution
while a healthy thread retains an unsubmitted prefix and an older error flag.
They check context-only reset, subsequent peer pixels and selections, public
name retirement, and native program ownership before process exit can reap
forgotten descriptors. This covers those explicit scenarios, rather than the
complete publication-loss and final-context audit.

A native reset can interrupt publication after a logical prefix. The C
receiver now uses read-only snapshots to require one consistent group sequence
and each affected journal's exact published/executed tickets. Only that proven
prefix becomes published locally; a healthy metadata caller publishes the
remaining suffix under fresh transaction authority. The reset caller stays
blocked and its consumed transaction is never retried. Inconsistent snapshots
retain every receiver for a later read-only retry. This failure path allocates
no C storage and adds no normal draw/frame work.

Shader public names also retire independently of their native objects. Public
shader creation reserves one cleanup node before native allocation. When a
program's last logical reference ends, all dependent shader names retire before
any fallible native cleanup. Intrusive group custody retains interrupted
cleanup without allocating after logical publication. Shader finalization and
explicit context retirement drain it; ordinary draws do not inspect it. Its
physical renderer epoch survives a logical context reset, while pre-existing
errors still belong to the current cleanup caller. Refused native cleanup
remains fatal; read-only recovery performs neither cleanup nor error drains.

Focused controls recover interrupted metadata publication, including a lost
caller's pending intent and an inconsistent snapshot retry, on three engines
and both widths. Healthy rendering, vanished public names, no selector replay
and native shader/program ownership before process exit are checked. They do
not establish full native-loss/final-context coverage or desktop performance.
C retirement no longer requires a successful publication through a lost
final publisher before attempting backend retirement. After a
publication failure, read-only reset-scope checks distinguish a lost
physical renderer, individually reset contexts and healthy shared
contexts. A healthy owner can carry metadata through the existing
lifecycle barrier even if it never enabled a journal. The share group's
cold carrier is reserved before the first local selection; it owns only
a transport receiver, no selector slots or native pins. It cannot change
owners while an entered publication still needs reconciliation, and its
authority ends before that context enables its own journal.

When every owner is proven reset, retirement keeps each exact C receiver
until that owner's backend destroy acknowledges success, then releases
only its records. Unknown scope retains ownership with a loud diagnostic
and permits a later proof/retry. It never guesses that healthy shared
objects vanished. Foreign metadata ENODEV marks the actual encoder owner
through a cookie whose lifetime is protected by the dispatch guard.
Sticky loss and pending CONTEXT_LOST occupy one atomic state, so
notification never writes another thread's TLS or consumes an unrelated
current context's errors. Checked flush reports ENODEV for already known
loss, without a new device request. Recovery scans and reset-scope
probes occur only after publication failure; ordinary draws and frames
perform no additional member scan. Native and three-engine regressions
sample zero public contexts, executions, bindings and native
programs/shaders before guest exit after explicit cleanup, including
both shared retirement orders, unavailable-proof retry, native OOM and
healthy unadmitted peers.

Automatic journal admission now runs at the first eligible nonzero
program selection under dispatch serialization. A known program can
enter the existing cold journal without an application-specific call;
unknown records and invalid/known-failed names keep checked host
validation. Uncertain admission stops selection and preserves its exact
custody. Context creation samples the presence of
KANDELO_GL_CHECKED_PROGRAM_SELECTION to retain checked selection for
diagnostics/raw-wire controls. This adds no per-draw/frame scan or new
wire/version. The default path has focused Node and three-engine browser
controls, including sharing, creation, target errors and matrix-
generation semantics. Full B1 conformance, loss/final-context audit
closure, application measurements and a coherent normal preview remain
acceptance work. Warm device counts do not establish application latency
or native desktop feel.


The program journal also owns an optional, cold-prepared buffer-copy bank.
Cold preparation reserves bounded receivers and native deletion custody before
creating buffers, and retains partial failure until exact retirement. Accepted
small definitions copy their bytes separately from mutable ordinary storage;
resolution checks the canonical object, generation, byte range and retained
context/renderer authority. Later shared reallocation or public-name reuse
cannot change an accepted copy. Reusing a cell is synchronous command order,
not asynchronous job eviction; borrowed native handles must not outlive that
command stack. Warm uploads use the existing predicted batch and one final
native sample. Optional journal action10 now prepares it through a sealed mutation receipt;
OP_BUFFER_DATA_SNAPSHOT0x0107 independently validates and copies original
ARRAY definitions. Lost preparation replies recover without native replay.
Restoration metadata is reserved before the original storage mutation, so
CPU reservation refusal cannot leave an accepted definition without its copy.
The ordinary C driver now activates the bank for eligible small-buffer draws
on a known default framebuffer. Cold action11 captures the actual retained
attribute store, including definitions older than journal admission. Its sealed
receipt recovers the same generation after copyout loss. Opcode0x0507 validates
every enabled row against canonical identity, token, layout and byte span before
borrowing native sources and restoring the public VAO. A cold derived binding
shares the original logical reset identity and excludes ordinary robust padding
only for these independently range-proven sources.

The C cache uses object serials and nonwrapping tokens, revokes standalone
updates and unknown raw I/O, and does not evict a row while gathering one draw.
First sharing is ordered with local admission; new local proofs remain revoked
after the last peer leaves. Known own bind0 can restore default-target knowledge
only while its independent rearmable proof survives. Ordinary inactive paths
allocate no bank or duplicate uploads. The duplicate-upload/application cost is
unmeasured. See the compatibility ledger's R432–R444 evidence and limits.

The journal also cold-captures eligible offscreen targets and input native
generations. Private framebuffer metadata describes the retained attachment,
separately from a public texture that can acquire replacement storage. Target
pins force storage orphaning; input pins preserve native identity while following
in-place metadata updates until replacement. Their deletion custody converges
with EGLImage ownership rather than manufacturing a new BO/export lifetime.
Private framebuffer deletion precedes release of its target pin. Raw graphics
I/O revokes program, layout and target knowledge together; a later successful
error drain cannot recreate that authority.

Upload scratch, native call arguments, inverse receivers and uniform write
counters are reserved before granting their corresponding local prediction.
Uniform uploads borrow bounded nonshared arrays synchronously. Optional CPU
preparation refusal is distinct from guest GL flags: a preallocated scope binds
the exact private error receiver, preserving earlier flags and nested owners.
Definite refusal executes the original API through its observed path; uncertain
entry is reconciled without replay. Native OOM retains the approved context-reset
policy, including under the audit; other unpredicted native errors remain fatal
under the audit. No numeric error filtering substitutes for provenance.

Optional action13 now reserves exact executable/sampling authority before the
guest accepts eligible retained-buffer or inline draws. Separate families avoid
allocating inline upload storage for VBO users. The bounded C readiness cache
keys canonical input serials and shared image revisions: a peer's replacement
storage renews new-call authority, while ordinary content updates keep the warm
proof. Old accepted records retain their original native generations. Private
uniform mirrors exist only while opted-in proofs reference their executable;
exceptional native-reset recovery reconciles them before a healthy peer resumes.

Prepared inline records preserve the full first-vertex operand and use bounded
CPU upload scratch. A compact header handles the existing maximum-size payload
without narrowing the GL API. Successful native context admission reserves the
bounded payload receiver, immutable scalar capabilities and checked native-call
rows before acknowledging creation. Journals share that binding-owned receiver;
Node's null-renderer refusal allocates none. Decoding borrows bytes only for the
synchronous command stack and clears them in finally,
including after Wasm memory growth. Full shape and authority checks precede any
upload or private pointer mutation. Stale authority gets the ordinary GL error;
an invariant lost after preflight fails loudly.

Cold CPU receivers own native pins before any later map insertion. Shader
variants likewise reserve program/shader deletion receipts and their result
receiver before native creation, retaining the original context owner through
publication failure, deferred cleanup and normal retirement. Nested retirement
cannot collect the same in-flight receipt twice.

Predicted scalar setters mutate their context's live rows without replacing
tuples or querying capabilities late. Shared blend variants compare both context
row identity and value revision; saturation stays permanently dirty rather than
reusing stale values. Checked native DepthRange/BlendFunc failures still use the
current logical context's original reset authority.

These controls do not establish B1 completion. Final application/conformance
checks, measurements and the complete normal preview remain required. Ordinary
GL now shares reusable decoding, whose CPU cost remains unmeasured. Retaining
storage alone does not prove every later CPU emulation receiver exists.

### Fatal native-error audit and submitted batches

The native error audit has two evidence modes. Record mode retains the
per-method native oracle for inventory and localization. Fatal mode follows
the production submission boundary for host-accepted work: validated native
calls do not independently read `getError`, and the submitted batch samples
the real native error queue. Explicit error predictions, remaining
native-decides paths, and private bookkeeping retain exact checks. Before
crossing into an exact check, the audit fences earlier deferred work so its
error cannot be attributed to the next operation or authorize publication.
Unexpected flags reset the original logical owner before the fatal boundary;
native out-of-memory retains its documented context-reset policy.

Oracle-held flags distinguish older observations from observations in the
current submission. A current exact boundary cannot disappear merely because
a utility omitted its own drain; an older held flag cannot become a new
batch failure. The submission identity is an empty token, without a logical
binding, guest memory or a cleanup callback. An allocation result reaches its
reserved native receiver before an exact out-of-memory post-check resets the
context. Batch diagnostics describe actual observed flags at their real
boundary and do not claim a fabricated per-method `NO_ERROR` result.

The internal `withNativeBatch` dispatcher is a live ESM binding. Audit
configuration installs its fatal adapter, and reset/record configuration
restores the original production body. Production callers use ESM imports;
dynamic test consumers retain the module namespace. Copying/destructuring
this internal callable is forbidden by the source lifetime guard, including
common literal element and string-key captures. This is an internal caller
constraint, not a guest API or wire ABI change. The guard checks supported
callers and common capture forms; it is not a general JavaScript alias
interpreter. Configure-before-import and configure/reset/reconfigure controls
protect module initialization and import cycles.


### Exact graphics file and buffer ownership

The B1 ownership endpoint (`0xc14064e7`, a 320-byte private ioctl packet)
separates retained graphics resources from public descriptor numbers. A
capability binds the process and exec generation to an explicit open file
description reference. Buffer capabilities additionally retain the exact
internal buffer object and its namespace custody. Closing or replacing a
public descriptor, or closing and reusing a GEM handle, cannot redirect
cleanup to the replacement resource. Ordinary descriptor operations retain
their existing semantics.

Mutations have monotonic transaction identities and immutable receipts. A
lost reply permits reading that exact receipt, never replaying the native
operation. Receipt acknowledgement is distinct from resource consumption;
an error after consumption cannot authorize a second release. Fork copies
independent child pins and receipt custody, while exec/exit drain the
process's resources through ordinary complete file-description cleanup.
Storage inheritance does not grant execution in the parent's GL renderer.

Owned mappings use a staged constructor. The kernel reserves a mapping
plan without retiring a fixed-address predecessor. While holding the same
serialized kernel entry, the host grows memory, asks the optional
`kernel_owned_mapping_finish` export to commit or roll back, and constructs
new host mapping state before publishing success. Re-reading a completed
receipt cannot zero or re-prime a mapping that guest code has since used.
Read-only polls retain their original timeout budget and exact task
identity; cancellation retires that wait rather than an unrelated request.

The endpoint is additive within program 56, unpublished host 3, GL 17 and
fork 21. This source checkpoint and its focused controls do not establish
complete B1 application, browser-memory, conformance or native-feel
acceptance. The new guest-library connection and coherent normal-built
preview must complete those gates in this iteration.


The guest graphics libraries now carry these capabilities through private C
receivers instead of retaining public descriptor numbers for later cleanup.
A single libc archive member owns receiver and nonce state; software that
never references the graphics helpers acquires no graphics initialization or
universal descriptor hook. Acquisition and capture publish recoverable
custody even when the caller's reply fails. A completed mutation commits its
transaction, acknowledgement and consumption metadata before clearing its
pending marker, so a forked child recovers the original immutable receipt
rather than repeating an operation.

Public image identity, explicit storage holds, renderer holds and lexical
per-thread borrows are separate lifetime categories. A child preserves the
fork caller's active borrows and process storage while dropping vanished
peer-thread borrows and inherited renderer access. Graphics metadata mutexes
use process epochs rather than inherited pthread owners. Cold publication
uses one fork guard for pointer/reference changes and transfers retiring
capabilities into a globally rooted, epoch-claimed queue before native work.
No native operation, receiver lock or driver futex wake runs under that guard.

This is a source checkpoint, not complete B1 admission. The detached EGL deferred-lease queues still require their own repairs and
regressions. New Node/browser fixtures are registered, but
must be linked and executed with the coherent normally rebuilt SDK, kernel
and programs before this ownership connection can be called validated on the
platform. Full stage, memory, conformance and latency gates remain required.


An image now retains an independent exact source-file edge as well as its BO
storage. Final generation retirement revokes every matching image's borrowed
generation pointer before freeing the generation; allocator address reuse
cannot admit an old image to a replacement renderer. A cold retain/publish
transaction couples the FILE reference increment with the global image root,
and releases the publication guard before receiver unlock. Private transfers
use the retained source file, while renderer/public admission requires a live
matching generation. Only creation and final retirement perform this work.
