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
kernel_wait_next_timeout_ns() → relative_ns | -1
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

Normal host_getrandom calls use an independent ordinary host buffer and
invoke the host Web Crypto provider in chunks of at most 65,536 bytes.
Only a fully successful fill is copied back into the Rust-lent kernel
destination; no provider receives a kernel-memory view. A missing secure
provider returns ENOSYS and provider failures remain errors. There is no
Math.random entropy fallback. This shared Node/browser host owner is
separate from the explicitly seeded image-build mode described below.

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

Header/table/control snapshots, decoded iovecs and control records, gathered
bytes and blocked vector-I/O requests own ordinary I/O admission credit.
Gather reads each guest range directly into its admitted final destination,
without another iovec-sized temporary allocation. Admission refusal precedes
backing I/O and leaves an existing queued message available for retry.

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

SCM_RIGHTS output uses a fixed 4 KiB stack window rather than allocating a
control-sized buffer after installing descriptors. It preserves caller-native
headers, little-endian fd values, alignment and zero padding across windows.
Control copyout failure cancels newly received descriptors; later result-header
copyout failure cancels the same installed prefix before returning an error.
A preceding payload/address copyout failure drops queued rights without
installing them. Cancellation releases OFD/backing ownership but is not a guest
`close`: it must not remove the receiver's existing process locks on that file.
An ordinary later close still performs normal POSIX process-lock removal.

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
2. Worker traps, protocol failures, and failed process or thread transitions
produce typed `host_diagnostic` messages; `NodeKernelHost` and `BrowserKernel`
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

For pipe-readable and pipe-writable records, the host first retries ordinary
`poll()` and `ppoll()` channels whose captured kernel pipe index matches the
event. A signal-mask-swapping `ppoll()` remains parked for the existing
signal-safe grace period, and the broad fallback still covers wait classes
without an exact pipe identity, including `select()` and `pselect6()`.
Host-originated pipe bridge notifications use the same target-before-fallback
order in the shared Node.js/browser runtime.

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
Once Rust has made that Process Exited, the host retires pending sibling
mailboxes with the private cooperative-exit signal and a raw interruption,
never by dispatching their old syscall into Rust. Host timers, engine futex
waiters and request capabilities are retired before that publication. A later
`exit_group`/`exit` completes only its transport handshake; it cannot replace
the original Rust exit status or repeat parent notification. Late clone
continuations must still own their original request and a live process, and
cannot publish after terminal admission. Computing workers without a pending
boundary still require bounded forced retirement; cooperative wake is not
proof that every worker stopped. Final teardown removes all PID-prefixed
thread channel, fork-context, and clear-TID metadata.

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

Descriptor-backing arenas retain ordinary I/O credit for their actual slot
capacity, including free slots. A new value is published only after fallible
arena preparation; eventfd, timerfd, signalfd, memfd, epoll, procfs, synthetic
regular-file and PCM creation propagate refusal through their prepared
descriptor. PCM backing admission precedes the exclusive transport claim.
An arena slot remains occupied while a shared mapping pins its value after the
final descriptor closes, and cannot alias a newly created object until final
unpin. Payload credit follows that same lifetime, independently of retained
arena capacity.

Memfd payloads use admitted buffers. Growth through write, positioned write,
truncate and mapped-file writeback prepares capacity before changing bytes or
content generation. Append commits its cursor only after successful mutation;
refusal preserves bytes, size, cursor and generation. In-place overwrite needs
no new payload allocation. Empty writes do not extend a seek-created hole or
advance the append cursor, and truncate-to-zero releases payload storage while
preserving the file cursor. These are volatile RAM backings, not OPFS capacity.

PTY readiness is kernel-owned. Master input becoming readable (including
canonical EOF), slave output becoming available, canonical/raw mode changes,
and final endpoint closes set a coalesced notification.
`kernel_take_pty_readiness_changed()` consumes that notification under the
kernel entry gate when retry queues contain parked waiters. Otherwise the
kernel retains it, avoiding an extra export call on syscalls with no waiter.
The shared host drains it alongside the packed wake stream
and reschedules blocked read, poll, select, and epoll retries. PTY queues have
no pipe slot identity, so this notification uses the existing broad readiness
retry path without impersonating a pipe event. Ordinary waiters retry as soon
as the entry scope is revoked, even if an unrelated signal-masked wait is
parked. Signal-mask wait deferral and finite deadlines remain owned by the
normal retry implementation. Host PTY
input schedules its reader wake independently of output callback attachment.

### exec()

Every result-bearing target operation runs immediately or refuses a busy
kernel gate without queueing work. After an asynchronous fetch, compilation,
or memory allocation, the shared Node/browser launcher retries this temporary
contention on a later worker turn. A refusal does not allocate or consume a
token and does not retain a read destination. Successful commit and replacement
start still run on the same stack; a consumed token is never retried.

Executing `/proc/self/fd/N` retains the actual open file description through
the same path as `execveat(AT_EMPTY_PATH)`, rather than resolving the text
reported by `readlink`. Unlinking or replacing the old pathname does not select
another program. Positioned observations preserve the shared file offset;
live execute permissions, nofollow and final source revalidation still apply.
Foreign-process descriptor execution is refused. This does not add general
procfd open or directory traversal, nor change the documented `/dev/fd` gap.

Kernel-host adapter 4 adds `kernel_spawn_exec_target_prepare_handle` for a
trusted runtime tool whose bytes have no guest pathname. The shared host
wrapper snapshots nonshared bytes only after an immediate entry is admitted.
Rust consumes the anonymous readonly, non-set-ID handle exactly once, binds
it to a pending child's initial generation and retains it as an ordinary
prepared target. It is not `attachProgram`: full observations, artifact/fork
admission, compilation and normal spawn commit must precede worker launch.
Once a child has committed an image, it cannot use this initial-tool entry
again, even if its pending publication has not finished. Program ABI 55 and
its supported digest are unchanged.

The host's handoff marker runs only after scratch pointers, arguments and
entry ownership have been checked. It runs under serialized host exclusion
before any scoped export permission is granted. Pre-handoff failure discards
the unclaimed host image; an exception after handoff must not close a handle
that Rust may already have consumed. A refused busy entry registers no image.

Anonymous host program bytes report their own readonly/nosuid storage view
(`f_type = 0x4b505247`), not the guest root filesystem or an unimplemented
host `fstatfs`. That stable view lets source authority be rechecked at commit.
This launch primitive is implemented; the automatic preparation controller,
private workspace, helper-family completion and cache publication are not yet
connected to ordinary execution.

Top-level `programPath` launches also retain their exact executable through
this pipeline, on Node and browser. The host creates the process and installs
its requested credentials and working directory before lookup. Rust's normal
target preparation, bounded reads and admission select the program or its
single shebang interpreter. The host compiles only those observed bytes.
`kernel_initial_exec_commit` consumes a process-owned target only for an
unregistered first generation: no previous executable, syscall channel or
pending guest spawn may exist. It rechecks execute permission in the current
credentials and uses ordinary final content revalidation and exec cleanup.
Commit captures secure-exec state and invokes the actual launch action before
yielding; a failed launch retires its new process and owned-job registration.

This does not replace the by-reference `programBytes` launch path. Anonymous
host-supplied programs still do not copy their whole contents into kernel
memory. The compiler service and automatic source/image binding remain
separate, unfinished work.

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

The Node compatibility runtime's asynchronous `child_process.spawn` and
`execFile` search bare command names using the child's `PATH`, falling back to
`/usr/bin:/bin` when that environment omits `PATH`. A name containing `/` skips
that search. Relative candidates are anchored to the requested child working
directory without collapsing symlinks or `..`. Each candidate goes through ordinary `posix_spawn` with the
same child environment and file actions, so relative or empty path entries
resolve against the child's working directory. Missing paths and non-directory
components allow the search to continue; a permission denial is retained if no
candidate succeeds. This shared runtime behavior applies on Node and browser
hosts and lets npm lifecycle scripts find `sh` and package-local commands.

The synchronous `spawnSync`, `execFileSync` and `execSync` APIs use the
same POSIX spawn path. A native controller writes stdin while draining
stdout and stderr, then reports the actual PID, wait status, signal and
binary output. It does not run parent JavaScript jobs during a synchronous
call. Pipe endpoints owned by the parent are nonblocking; the child's
endpoints remain blocking. Temporary endpoints are close-on-exec and kept
away from stdio targets. Failed setup and controller exceptions close owned
descriptors, and the controller reaps its child. Closed numeric stdio
sources are checked before temporary pipes can occupy those descriptors.

Synchronous timeout and output limits send the requested signal, close the
pipes and wait for the child's actual exit. A child that catches that
signal can delay return, as in Node; this is not a hard wall-clock deadline.
Detached children use the existing POSIX spawn session attribute. Process
credential getters read real libc identities, and signal-zero probes use
the native kill path with structured errors. Changing child uid/gid still
returns `ENOSYS`: arbitrary credential attributes are an implementation gap.
The executable's Node mode still depends on argv[0], so overriding argv0
for the Node executable needs proper entry-point separation. These limits
must not be hidden by changing the supplied arguments or identities.

The shared Node bootstrap also owns application exit-code absence, stdin
read readiness, and the URL/Web Streams classes used by HTTP clients.
SpiderMonkey embeds the integrity-locked JavaScript bundle under
`third_party/node-web-platform/`; this code runs in the guest and does not
substitute host networking or host process state.
The engine's native module loader owns ESM parsing, linking and evaluation;
entry files are not rewritten into async functions. CommonJS retains its
wrapper and process-wide cache, including the main module's identity before
its children execute. Wrapped scripts register a reference path for relative
dynamic imports. File and eval entry points return to the same native
job/timer/I/O loop, which owns natural exit after pending work finishes.
An unresolved ESM entry graph without remaining work uses exit status 13
unless a nonzero status was assigned. Module URL identities, package
conditions and CommonJS named-export discovery remain partial.
Its filesystem adapter translates negative operating-system results into Node
errors, including `ENOSPC` from the bounded in-kernel filesystem. Whole-file
writes consume partial writes until completion or an error; npm must not
mistake a failed write for a successful byte count.

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
`kernel_get_process_state` and both process-exit queries do. Otherwise a
host could mistake a reaped leader for a live process and miss its exit
notification while another group member remains alive.
Only the first acknowledgement of an exit
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

A failed fork or spawn launch remains in its owned family until Rust has
removed the child and the host has detached its Worker resources. Launch
rejection alone is not proof of exit. Pending-child completion runs even if
the parent's syscall channel has retired, so cleanup cannot be dropped when
the parent exits during asynchronous Worker creation. Both host adapters
update the job ledger from the completed rollback notification.

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
Pending file-mapping writeback tracks dirty bytes within each cached page,
not just a dirty-page flag. Successful short-write prefixes retire immediately;
retry writes only the remaining dirty runs, preserving later descriptor writes
to other bytes. Generation reconciliation refreshes clean bytes without losing
pending stores and discards stores invalidated by truncation. A mapping's
comparison snapshot advances as its changed bytes enter the shared backing,
even when subsequent writeback fails, so retry cannot replay an already
accepted prefix over a newer descriptor write. Dirty-byte tracking nodes use
fallible shared I/O admission before cache mutation.

Unreleased storage-memory work also admits file-cache page payloads and
cache nodes through that shared budget, reclaims only clean pages on
admission pressure, and prepares replacement pages before publishing a
refresh. Failure invalidation walks resident cache entries without
allocating a logical-page cohort. File publication reads process memory
through fixed page scratch and streams changed runs, retaining accepted
progress if a later page read fails. These changes are not in checkpoint
1.13. The subsequent chunk admits retained mapping snapshots,
anonymous backing bytes, fork rollback/replacement payloads and mapping
registry nodes. File mapping preparation runs before VM allocation in the
Rust dispatcher; host registration consumes the prepared snapshot/nodes.
Middle-unmap splits reserve their right-hand snapshot/node before VM
mutation and commit without allocation, using the current comparison bytes.
Remap prepares authoritative bytes before VM mutation and retains the old
tracker until the new process write succeeds. No new host import or kernel
export is needed. The snapshot/preflight prefix passes an actual guest's
8 GiB sparse-window/oversized-map refusal and strict recovery case under a
64 MiB kernel ceiling on Node and all three browser engines.
Subsequent source moves host-driven `munmap` publication before
VM mutation, preserving the old mapping on publication error. Teardown scans
unpublished bytes with fixed scratch after failed publication and records
their loss before dropping the mapping; a failed import alone is not called
a lost store. This detects failure, not guaranteed durability for an unsynced
store under exhausted resources. Checkpoint 1.14 also admits backing-registry
nodes and identity strings before retaining handles. Process mapping tables
include their teardown guard at registration; adapter memory extents are
queried as scalars instead of copied into a map. SysV version nodes have
explicit admission and last-attachment release. Prepared file mappings bind
to the exact process, address and source handle before host registration.
Failed nonfixed process-memory growth rolls back the VM reservation and
preparation before returning `ENOMEM`; an unproven rollback fails the kernel
generation. The rebuilt ABI 51 checkpoint passes the sparse-window/refusal
and strict-recovery regression on Node and all three browser engines.
Broader application acceptance and aggregate storage-memory measurements
remain open; no whole-memory bound is claimed.
A normal guest regression also holds a 512 KiB shared mapping into an 8 GiB
sparse file while streaming 8 MiB of distinct writeback data and filling a
long-name namespace to `ENOMEM`. Reclaim, mutation retry and strict fresh-worker
recovery pass on Node and Chromium, Firefox and WebKit, within a 64 MiB kernel
ceiling. This demonstrates that combined workload, not every simultaneous
resource limit or an aggregate host/engine memory bound.
Successful rootfs/tmpfs truncation and truncating opens, and memfd truncation,
also notify the mapping table before subsequent growth can hide a smaller EOF.
These notifications run after filesystem/backing borrows end and invalidate
pending bytes without allocating teardown or page-selection cohorts.

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

This is syscall-boundary coherence, not shared physical memory. A process that
only performs direct loads/stores does not publish or import peer changes until
it crosses into the kernel. Futex waits and wakes also target the caller's own
process `SharedArrayBuffer`, so process-shared pthread mutexes/futexes remain
unsupported across PIDs. Shared mappings of in-kernel memfds return `ENOTSUP`,
as do file mappings on any backend that cannot provide stable identity;
`MAP_PRIVATE` is unaffected. File bytes past
the current EOF are zero-filled or discarded on refresh/writeback rather than
raising Linux's `SIGBUS`, and writes made outside Kandelo's file syscall paths
are not detected. The boundary scans are on the syscall hot path; no performance
claim is made without before/after Node and browser benchmarks.

Every spawn or exec computes a fresh layout from the target binary's memory
import and `__heap_base`; the brk, mmap, control-channel, allocator, and kernel
metadata state is per-process and is reset when ownership changes. Each
generation receives a newly constructed, exactly sized
`WebAssembly.Memory`. Retired process memories are never zeroed and handed to a
later process: shared Wasm memory cannot shrink, engines retain native backing
stores differently, and `Worker.terminate()` is not a portable ownership
fence.

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
first asynchronous host operation. The current source candidate acquires and
populates a fresh shared backing directly on Node and every browser engine.
It no longer selects WebKit's disposable construction factory, whose separate
collection realm reproduces native reservation refusal in controlled tests.
The optional asynchronous allocator boundary still charges its temporary
snapshot and pending child backing, including concurrent pending allocations,
and rechecks guest growth before publishing a constructed memory. Native
constructor exhaustion maps to `ENOMEM` without changing unrelated errors.
Machine shutdown closes creator admission before draining admitted work.
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

Kandelo-provided images use the [FHS layout](filesystem-layout.md).
Image builders own installed guest paths, aliases, configuration and state
placement; the kernel does not repair an image's hierarchy after boot.

### Who owns what

The kernel owns the machine's filesystem namespace. Every path a guest names
is resolved by the kernel (`resolve_namespace_path_from` in
`crates/runtime-core/src/syscalls.rs`, which follows symlinks and `..` against
the kernel's own metadata) and then dispatched to the authority that serves
it:

| Prefix | Authority | Module |
|--------|-----------|--------|
| `/` (everything not listed below) | in-kernel root filesystem built from the VFS image | `crates/runtime-core/src/rootfs.rs` |
| `/tmp`, `/run`, `/dev/shm` | in-kernel tmpfs | `crates/runtime-core/src/tmpfs.rs` |
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
the ephemeral in-kernel filesystems `fsync` succeeds without host work: they
have no separate durable backing. An opt-in persistent root instead flushes
its Rust-owned journal through the host storage adapter and reports failures.

Persistent-root `statfs` computes the canonical composed-checkpoint footprint
from live inodes, retaining allocations held by open descriptions or
shared mappings after unlink. It uses the mounted block and inode ceilings,
counts sparse data and indirect pointers through a bounded journal iterator,
and includes directory packing and the in-body deferred-file section. It does
not build an export image or collect a file-sized block list to answer a
free-space query. The directory counter needs only the at-most-16 padding
regions created before the writer switches to its directory index; later
padding is not reusable under that writer policy. These are logical filesystem
statistics, not the immutable base and journal's physical storage usage or the
host's quota. The allocated-block total is cached: successful writes charge
their accepted prefixes, and namespace commits install their preflighted total
after updating the live tree. Truncate, final inode release, and verified-file
materialization invalidate it. Cold queries still scan the live filesystem
with bounded scratch; this is not yet a fully incremental truncate/lifetime
allocation ledger.

Ordinary persistent writes plan at most 64 blocks before each cache-sized
chunk, probing visible block ranges in the base image, checkpoint, journal
tail, and dirty cache. They reserve new data and missing single-, double-,
and triple-indirect groups without a file-sized allocation list. Overwriting
allocated blocks remains possible at zero free space; a write requiring new
blocks returns its accepted prefix or `ENOSPC`. Fixed-overwrite writes also
charge holes inside an existing sparse file. Namespace preflight merges changed
names into each affected directory's sorted keys, counts its exact packed
footprint, charges new inode content, and credits victims only when no links,
descriptors, or mapping pins retain them. Deferred records and archive
descriptors follow that same lifetime. A cross-directory rename can reuse a
block released in its source directory without temporarily overcommitting the
disk. Journal or logical-capacity failures leave the live namespace unchanged.
Partial truncation rewrites a boundary block only if it is allocated; shrinking
a sparse hole does not allocate data or pointer blocks. Mapped writeback keeps
the originating storage errno through Rust's page writer and flush operations;
`msync`, `fsync`, and `fdatasync` report logical `ENOSPC` and retain dirty data
for retry after another descriptor reclaims space. The host forwards the
kernel's negative errno for range publication and failed `MAP_FIXED`
publication, rather than converting every failure to `EIO`. Native tests also
exercise partial writes and retry. Persistent verified reads preserve deferred
descriptions and do not charge cached content as new disk allocations.
Whole-system bounds on namespace, recovery, archive, transport, and export
metadata remain unfinished; see
`docs/persistence-durability.md`.

Image loading preserves non-directory hard links as shared inodes rather than
independent copies. This includes deferred files, symbolic links, and named
FIFOs, and keeps both link counts and the shared inode identity when a
persistent checkpoint becomes the next boot image.

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

Normally, the kernel keeps the tree's metadata, every guest change, and
every file the guest creates in its own memory. Unmodified file content stays
in the image:
the kernel reads it on demand through `host_image_read`, a positioned window
onto the bytes the worker entry holds (`imageReadFromContainer` in
`host/src/vfs/rootfs-lazy-archives.ts`). Writing to an image-backed file
copies it into kernel memory first unless experimental fixed-overwrite or
resizable persistence is enabled.

`crates/runtime-core/src/persistent_overlay.rs` prototypes a separate,
append-only durable overlay bound to a specific base-image SHA-256 digest. It
records inode metadata, fixed-size file blocks, and directory-entry changes
in checksummed transactions, publishes them after a storage flush, and drops
an incomplete trailing transaction during recovery. Its experimental file
helpers read unchanged blocks from the base image, journal only blocks touched
by writes, and record logical length separately, so sparse offsets need not
allocate the gap. Recovery keeps file-block locations and digests, not file-block
contents, in memory. Reads verify changed blocks against their digests and keep
at most 64 recently used 4 KiB blocks (256 KiB) in a cache. The metadata and
block-location maps share the admission budget described below, while indexed
checkpoints remain on storage with bounded page caches. This does not bound
all namespace, cache and recovery memory. `host/src/vfs/overlay-storage.ts`
supplies an exact, positioned I/O adapter over the existing Node and OPFS
filesystem backends. `crates/overlay-prototype` is a separate Wasm harness that
connects the Rust journal to this OPFS adapter. Its browser test creates a
named file, writes across base-image blocks and at an 8 GiB sparse offset,
restarts both workers, and checks namespace recovery and wrong-base rejection
in Chromium, Firefox, and WebKit.
Fixed-overwrite mode is selected with
`NodeKernelHost.experimentalFixedPersistencePath` or
`BrowserKernel.experimentalFixedPersistenceName` (on boot or init). It hashes
the loaded VFS image, opens the corresponding journal, and replays changes to
existing image-backed regular files. Writes within their original length enter
a 64-block (256 KiB) dirty cache and are immediately visible to reads. Dirty
eviction, `fsync`, `fdatasync`, and graceful destroy commit and flush these
blocks. A crash may lose writes without a successful flush; a failed flush
reports an error and poisons further writes rather than claiming durability.
One guest write spanning more than 64 blocks is processed in cache-sized
chunks; failure after earlier chunks returns their short byte count.
OPFS quota exhaustion reports `ENOSPC` at the flush or eviction that reaches
storage, not necessarily at the earlier buffered write.
The read cache is separately bounded to 64 blocks. Creation, deletion, rename,
truncation, explicit metadata changes,
growth past EOF,
writes to deferred/digest-declared/set-ID files, and writes to files created
in memory during boot fail with `EROFS` or `EFBIG`. This is an intentionally
incomplete opt-in filesystem contract, not general persistent POSIX storage.
Write-induced mtime/ctime updates are visible during a session but not replayed.
The journal may describe inode and namespace changes, but this mode rejects
them during recovery until rootfs can replay them accurately.

Browser sessions can restore a saved OPFS image through positioned reads with
a separate 4 MiB clean-page cache. First installation streams the composed
image from the Rust writer to a generation file in OPFS in 1 MiB chunks,
with one acknowledged chunk in flight between composer and page. The page
checks each chunk from storage, then publishes a manifest only while that boot
still owns the session, under the same exclusive Web Lock as the write. A
superseded boot cannot publish its staged image; an interrupted generation
without a manifest is reclaimed before the next installation of that name.
Persistent direct and scoped Pages source fetches stage decoded bytes in OPFS
with bounded chunks, and composition reads the source through positioned calls.
Aggregate recovery and whole-process memory acceptance remain unfinished, so
this is not yet general production persistent POSIX storage. Browser sessions use
an OPFS `FileSystemSyncAccessHandle` in the kernel worker;
its exclusive handle provides the single-writer lease and is closed on destroy.
Node sessions use an absolute journal path and a sibling `.lock` directory;
concurrent Node sessions fail closed, and a crash may require manual removal
of a stale lock after confirming no writer remains. Journal paths must be
private; neither adapter protects against an external writer. Offsets must
fit JavaScript's safe-integer range. Nonpersistent boots still materialize
source bytes. Journal-tail maps are admitted separately from namespace state;
indexed checkpoints do not retain a location for every changed block in RAM.

Resizable persistence is selected with
`NodeKernelHost.experimentalResizablePersistencePath` or
`BrowserKernel.experimentalResizablePersistenceName`. It supports sparse file
growth and truncation, journal-created files, directory and link mutations,
inode metadata, and filesystem nodes for FIFOs and sockets. Pipe contents and
socket endpoints are session-local. Resizable timestamp writeback persists
bounded batches of inode records; this does not change fixed-overwrite mode's
restrictions. Logical capacity and resource admission failures remain distinct
from host storage quota failures. The full POSIX and release acceptance gates
remain in `docs/persistence-durability.md`.

Both hosts stage compacted journals and indexed checkpoints in separate slots.
The Rust kernel verifies live content and prepares the replacement; the host
flushes, seals and verifies that target before activating it in the same worker
turn. Boot prefers the highest verified generation, while kernel replay still
validates its filesystem semantics. A source-bound seal prevents a rejected
target from superseding later source writes. Failed or ambiguous recovery must
not silently create a fresh computer. If a source still has a nonempty invalid
seal and nonempty journal with a length different from its descendant's source
binding, recovery refuses that descendant unless a verified different-generation
identity establishes slot reuse. It must not reinterpret failed verification as
proof of retirement, or fall through from that unresolved candidate to legacy.
A newer independently eligible candidate may still boot. Empty/missing source
seals retain retirement compatibility; this is not a guarantee against arbitrary
same-length corruption. Live compaction flush-invalidates the reused slot's seal
before touching its journal or index, so an interrupted reuse does not retain a
misleading old seal. Rust owns activation-control encoding, checksums, numeric
and slot validation, generation transitions and selection between the two
control replicas. Node and browser workers use the same bounded, immediate
kernel scratch entry; no JavaScript policy fallback is used. The host retains
control-file publication, repair and close ordering. The source Rust seal
codec also encodes and checks versioned seal headers, validates their numeric
and source-slot fields, and computes streaming SHA-256. Hash contexts are
bounded explicit packets, not retained native handles. The host reuses one
60 KiB read window and one hash courier for the seal's chunk walk; the native
entry fits the existing channel-sized scratch region without raising its
memory ceiling. A capability probe refuses a stale kernel/module as missing
policy, not as corrupt stored data. Hash-context and resource failures never
authorize corrupt-generation fallback. Journal header length and base identity
come from the same Rust parser used by native journal recovery and unindexed
conversion. It
checks the complete header's magic, version and SHA-256 before returning the
identity. A nonempty unsealed journal with a damaged or incomplete header is
refused before activation controls are created or changed. Header resource,
transport and unsupported-operation failures remain distinct from corruption.
The host does not interpret journal field offsets. Checkpoint-index header
inspection shares Rust's native mount parser, including magic, supported
version, checksum, journal boundary, sequence and count-overflow checks.
Rust supplies the conversion threshold and decides whether a checked index
requires conversion; malformed large-index headers are refused before
activation publication. Source-binding eligibility is also native policy.
The host submits bounded evidence about verified predecessors, slot reuse,
source lengths and retirement; Rust returns eligible, stale, superseded or
unresolved, or requests a source-digest check before making that decision.
An ambiguous unverified source cannot become proof of retirement. The codec
retains no candidate table or opaque native handle. Rust also supplies seal
chunk geometry and total length, and verifies observed journal/index/seal
lengths, expected base identity and appended-tail admission. The host submits
only bounded metadata and performs checksum-slot reads and I/O/publication
choreography;
broader candidate selection, fallback retention and cleanup still use shared
host policy; moving remaining portable policy to Rust
and completing the crash/handoff failure matrix remain required. There is no
measured workload-performance claim.

The browser worker registers raw OPFS image, journal, index, seal and
snapshot close obligations before validation or generation publication.
Its storage-close ledger retains provisional owners and sticky close
failures, even when higher-level cleanup logs or loses the wrapper.
Admitted initialization/export operations drain before final storage
closure. A handle acquired late during retirement must be closed or
recorded unproven before that drain finishes. The ledger attempts every
remaining close and cannot acknowledge while a failure remains.
Deferred-spool close rejection is also retained rather than cleared.

A settled persistent `init_error` from the exact current Worker allows
the main-thread proxy to request the existing bounded destroy handshake
before readiness. Only an acknowledged storage close plus successful
realm termination releases its computer/journal leases. Fatal or
transport failure, missing/malformed/rejected acknowledgement, or failed
termination preserves ownership. Old Worker events cannot authorize
cleanup for a replacement. All three browser engines exercise early and
provisional initialization failure, native close refusal and pending
snapshot acquisition during shutdown; these cuts are not a complete
crash-safety or whole-memory acceptance claim.

The host policy has a durable-snapshot crash-cut test that interrupts every
observed storage/activation boundary before and after its effect, including
successful operations whose acknowledgement is lost. It reopens the surviving
bytes through production seal verification and generation selection. The model
tests flush-only and write-through persistence for legacy, sealed and extended
slot layouts, including obsolete-generation cleanup. It does not run Rust
journal replay or simulate arbitrary torn sectors, OS power loss, device flush
guarantees or browser ownership races; real Node/OPFS acceptance remains separate.

Regular-file allocation traversal uses a positioned Rust cursor with three
4 KiB pointer-page slots and no heap-owned block list. It skips absent
indirect branches, clamps ranges to EOF, validates encountered pointers, and
preserves underlying I/O errors. Image loading records a density flag and
scalar allocation total per embedded file, including sparse pointer overhead,
rather than retaining a logical block number for every allocated block.
Journal recovery computes composed totals from positioned base/index streams
before publishing namespace or metadata updates. Accepted write prefixes add
their reserved allocation cost; truncation counts its retained prefix before
committing and changes the scalar only after success. Cold statistics and
namespace capacity preflight use these totals without walking file blocks or
reading image storage. The Rust replay/export APIs receive a borrowed image
reader; it is not retained on an inode or mount. No host storage ABI changed.
Regular image reads, buffered read-modify-write batches and streamed export
reuse one inode and at most three authenticated 4 KiB pointer pages for the
current source file within each synchronous operation. The cursor is
stack-owned, smaller than 16 KiB, and discarded on a file switch or at the
end of the operation. It is not retained per inode or descriptor. Journal-backed
reads share it across their 4 KiB base callbacks. This avoids cycling inode, indirect-pointer and
data pages through a two-page checked-data cache for every emitted block;
it does not increase the configured cache or memory ceiling. Failed pointer
refills do not publish their partial bytes. Container export reads the same
prepared structural plan for both its header and body.
Snapshot sizing uses those scalar totals, with positioned recounts for sparse
immutable protected content. Sparse output allocations are passed directly
into the writer by a repeatable visitor, not retained in a file-sized list.
The visitor validates ordering and EOF before allocating the output inode,
then traverses again to construct it; storage errors discard the unpublished
plan without changing the mounted tree or journal. Dense composed files are
recognized arithmetically from their size and allocation total.
The journal's composed-allocation walk can consume a positioned base cursor
while merging checkpoint entries, metadata-tail overrides, dirty blocks, and
truncate fences. It retains only the next base block, not a copied base list,
and does not request another source block after an early successful lookup.
Sparse write admission and partial-tail truncation use positioned image
metadata rather than searching retained block numbers. Source errors propagate
before the mutation, and fully fenced base ranges do not read the source.
Dense allocation checks retain their arithmetic path. There is no retained
base sparse map to clone during export, and no temporary output block list.
Namespace, recovery, content extents, and aggregate export metadata still need
admission budgets before general bounded export is complete.

The image writer is append-only: it never frees an inode or physical block.
Its first-fit allocation order therefore forms a contiguous prefix, whose end
is the existing total-minus-free count. The writer and finished image no
longer retain allocation bitmap buffers. Positioned export synthesizes each
bitmap slice directly from those scalar prefix counts, including a partial
last byte and zero-filled unused capacity. The on-disk bitmap regions, inode
numbers, allocation order, and format are unchanged. Serialized bitmap regions
still grow with declared capacity, but their bytes need not reside in runtime
memory. Indirect-pointer pages use runs of consecutive slots and arithmetic
pointer values, materializing their little-endian bytes only when read. A page
with more than 64 runs, or an out-of-order insertion, falls back to a single
4 KiB buffer; it does not grow an unbounded run list. This representation
preserves the existing physical allocation order and on-disk pointer trees.
The number of pointer pages and content extents still scales with the output
layout. Their aggregate admission budgets, inode-table pages, and directory
metadata remain unfinished whole-system memory bounds.

Stopping the live journal compactor closes its timer admission and joins any
operation already in flight. Node and browser destruction await that join
before syncing or closing storage, including post-activation legacy-source
cleanup and publication of the active handle set. Disabling a timer alone is
not a storage-release fence. Browser shutdown without storage acknowledgement
continues to retain its writer leases; the join does not weaken that guard.

In-body deferred metadata (`SDEF`) is decoded through positioned reads of at
most 4 KiB instead of first allocating its declared file length. Framing and
field limits are validated before copying field bytes; positive short reads
are completed and underlying storage errors remain typed. The default
admission budget charges at most 8 MiB across record/archive models and their
path, URI, and opaque payload bytes, using portable conservative model charges
of 128 and 96 bytes respectively. Decoding reserves model vectors fallibly;
the writer charges its vector capacities before accepting a description and
uses fallible field copies before creating an output inode. Encoding reserves
its exact bounded serialized size. Malformed framing returns `EINVAL`;
admission or allocation exhaustion returns `ENOMEM`, not logical `ENOSPC`.
This is a metadata admission policy, not an image-capacity or format limit.
It does not include allocator overhead, rootfs namespace/description clones,
container JSON/KLZY, long symlinks, or aggregate recovery/snapshot scratch;
those still need their own admission and peak-memory acceptance.

Image directory loading also streams. One Rust `DirectoryCursor` borrows
names from a 4 KiB buffer; the rootfs walk descends in on-disk record order
with the current path and ancestor positions instead of copying/sorting whole
directories and retaining sibling paths. Each saved position is 144 bytes plus
its path-length field; stack growth and path construction use fallible reserves.
Guest inode numbers and hardlinks are preserved, and the mounted namespace and
export remain name-ordered. Image lookup uses the same cursor while retaining
full-directory corruption validation before returning a match. Source failures
preserve the cursor position; a failed rootfs load resets the partial tree.
This bounds directory-width staging, not the live namespace, traversal depth,
or aggregate memory. The collecting compatibility directory API, including
image-publication policy inspection, still requires separate budget review.

Post-load FIFO registration uses a separate borrowed namespace cursor with
one active path and depth-only iterator frames, not a queue of sibling paths
or a complete list of FIFO names. Trees without FIFO inodes skip that walk.
Reset filters existing registrations by the backing pipe's rootfs device
identity, so unreachable rootfs aliases are removed without traversing a
possibly partial tree, while FIFOs on other mounts survive obscured rootfs
names. Name-reference release preserves open endpoints and their data; closed
unreferenced pipes can be reclaimed. Restoring aliases refreshes cached pipe
metadata from the inode's actual link count. Registry names and prepared AVL
nodes own ordinary I/O credits. Creation, hard links and directory/file renames
prepare copied paths and replacement nodes before the namespace operation;
registry publication performs no allocation. Same-inode rename preserves both
aliases. Rootfs syscall dispatch applies the same live alias updates as tmpfs
and host mounts. Registry restoration stages every missing name, alias mapping,
backing buffer and arena slot before changing registry entries or name counts;
refusal leaves the existing registry intact. During recovery, a bounded
projected walk merges base directory entries with sorted replay changes and
created-inode slot assignments. It stages the future registry, including
pending metadata updates and final link counts, before namespace-credit
exchange or publication. Traversal retains one path and depth bookmarks, not a
copy of the rootfs. Failed preparation releases the staged owners and leaves
the old namespace/registry usable for retry. Publication then retires old
rootfs names and installs prepared names/slots without fallible FIFO work,
preserving foreign registrations and open old backing. This is not an
allocation-free reset or a whole-process memory bound.
Restoration excludes shadowed tmpfs paths and requires matching device/inode
identity before reusing a registration, so a foreign FIFO cannot become an
alias of an underlying rootfs inode. FD metadata operations on named kernel
FIFOs route to their namespace owner, and the cached metadata is refreshed
before final unlink for subsequent open-unlinked `fstat`. Registry path
copies retain I/O credit across nested filesystem/host calls rather than
holding borrowed names into mutable registry storage.

Named FIFO markers have no resident ring buffer until an I/O open. `O_PATH`
and a nonblocking writer refused with `ENXIO` do not allocate one. Before
publishing an endpoint or rendezvous reservation, Rust fallibly reserves the
buffer and charges twice its actual `Vec` capacity against ordinary shared I/O
memory, using the same conservative backing allowance as other I/O owners.
There is no additional named-FIFO payload pool. Admission or allocation failure returns `ENOMEM`
without a phantom peer, waiter or reserved-fd leak. Blocking opens reserve an
fd before preparing data storage. Existing endpoints share one allocation,
including inherited and queued `SCM_RIGHTS` references. Last I/O-endpoint
release discards the volatile data and frees the buffer/credit even if names
or path-only references retain the inode. Logical pipe capacity remains
64 KiB, and neither open buffers nor this memory quota count as filesystem
blocks or OPFS storage. Anonymous and socket stream rings use that same
fallible I/O admission before allocation. Pipe arena capacity also retains
I/O credits while slots are free; growth admits old and new backing together.
Contiguous pair allocation prepares both payloads and arena capacity before
publishing either pipe, and descriptor reservations roll back on refusal.
Host-stdin payload/slot preparation precedes closing the original fd 0.
Impossible descriptor limits fail before that close, and failed later
installation releases the unclaimed pipe and its payload. Unclaimed buffers
have no exposed waiters, so disposal does not allocate readiness events.
Nested DRI/KMS payloads, other guest-pointer/socket/backing storage, wake delivery,
allocator/RSS accounting and the remaining aggregate-memory gates are separate
work; these bounded owners alone do not establish a whole-process ceiling.

Inode arenas have an explicit reservation/publication boundary. Persistent
creation reserves both inode slots and enough free-index capacity before
committing its namespace transaction, then publishes into prepared slots.
Replay reserves all newly described inodes before clearing FIFO registrations
or applying metadata/namespace changes. Ordinary creation and initial-root
allocation are fallible too. Final inode release and creation rollback can
return admitted slots without growing the reclamation vector. Memory
reservation failures report `ENOMEM`, separately from logical inode `ENOSPC`;
reserved capacity is not counted as allocated disk space. A failed preparation
can retain spare capacity, which the shared Rust metadata ledger charges.
The ledger also admits owned directory names before journal publication,
symlink targets, deferred descriptions, archive descriptors, and image JSON.
`rootfsMetadataBytes` defaults to and cannot exceed the smaller of 64 MiB and
one eighth of the configured kernel address-space ceiling on either host.
Temporary metadata reservations have separate headroom of twice that limit.
Image loading uses a fallibly prepared visited-inode/hardlink map in this
temporary class. Its ancestor stack, current and pending paths, and hardlink
component arrays admit capacity before allocating; vector growth admits the
old/new overlap. These owners are released after loading or a reset-on-error,
separately from the retained inode and namespace charges.
The image module exposes the same Rust budget for composition and validation.
Its resident and positioned image loaders preserve the image's own namespace.
Only computer boot adds kernel runtime mount directories; loading an image
for inspection, editing or composition must not create `/run` or reject an
ordinary image file with that name. Both roles share Rust image validation,
namespace loading and deferred-file verification, not boot-only namespace
initialization.
Decoded SDEF fields are admitted before allocation; a resource failure remains
`ENOMEM`, not image corruption or permission to select stale recovery data.
These are modeled charges, not allocator/RSS accounting or a global filesystem
quota: aggregate journal/index admission, FIFO resources and
the remaining recovery/snapshot/writer owners still need admission review.

`/proc/kandelo/fs_memory` exposes versioned, kernel-lifetime admission
telemetry through ordinary guest file reads. It reports current live and
temporary credits, the current live limit, and live/temporary/combined
high-water credits for namespace, ordinary journal, reserved journal
writeback, ordinary I/O and reserved I/O writeback. A shared tracker records
their simultaneous aggregate high water as ownership changes; it is not the
sum of independent component peaks. Refused admission does not increase the
counter; admitted credit can precede an allocation that later fails, so these
remain credits rather than allocated bytes. Credit transfer preserves the
aggregate while promotion/demotion can change class peaks. The shared I/O
pool also serves some non-filesystem owners, such as pipe payloads.

Each budget is sampled separately while the serialized kernel entry owns
execution. A concurrent native caller must not assume a cross-budget atomic
snapshot. Counters are captured before the report allocates its admitted
output buffer; that allocation can fail with `ENOMEM` and affects later
lifetime high water. Peaks survive reclaim, filesystem reset and lowered
limits; they can therefore exceed a newly reduced limit without proving a
new admission violation. A fresh kernel is required for an independent
fixed-profile measurement. Neither the counters nor kernel page counts
measure browser heap, guest memories or composer/codec-worker memory.

Disposable image workers report their own grown native memory in 64 KiB
pages without exposing their `WebAssembly.Memory` to the main thread.
Positioned composition additionally reports retained source/frozen-source
and returned-image byte counts; the normal persistent path returns no whole
image bytes. Its client attaches the page-level manifest admission snapshot
before settling. These counts identify owners, not allocator/RSS bytes, and
separate worker peaks must not be added as simultaneous physical memory.

The browser codec admits at most 16 MiB of module input per private copy.
Inspection can overlap two such copies; this is not a 16 MiB total limit or
an image-capacity bound. Control input is copied through an exact 64-byte
span. Stream input is copied into at most one owned 1 MiB chunk, with an
additional transferred window of at most 64 KiB. Exhausted chunks are
released before awaiting another input. Captured, validated lengths and
fixed-length views keep growable shared backings from enlarging a copy
after admission. Copying does not provide an atomic snapshot against
concurrent producer writes. The producer's original buffers and iterator
retention remain caller-owned and outside these private-copy bounds.

Optional codec memory observations arrive after storage-close processing;
the client invokes its observer after requesting worker termination.
Neither that request nor this diagnostic proves physical reclamation.
Diagnostic failure must not hide a storage error or turn an uncertain close
into permission to delete the staged target.

Both host APIs expose `getStorageMetadataMemoryUsage()`, returning
`used`, `peak` and `limit` for the kernel worker's shared host-storage
metadata pool. These are modeled JavaScript-retention credits, separate
from Rust admission and actual process memory. The saved-image manifest
operation pool and caller-owned results are outside this worker pool.

Snapshot export admits its traversal stacks, visited/emitted inode maps,
declared-archive identities, copied pending names, symlink/deferred metadata
and retained content-source records in the common I/O allowance. Move-only
buffers admit old/new growth overlap before moving owners; refusal destroys
only the unpublished export plan, leaving the live tree available for retry.
Traversal credit releases when planning ends. Content-source credit remains
with the streaming plan until EOF, cancellation, replacement or reset. Writer
inode-table and superblock payloads use the same admitted storage and retain
their credit in the finished image. Inode-table growth is prepared before its
allocator counters change. Materialized writer blocks, compressed pointer-run
vectors, fallback pointer pages and directory-index vectors use the same
move-only buffers. Their map nodes and content-extent records use fallible
prepared AVL entries admitted against that I/O pool, rather than infallible
standard B-tree insertion. Pointer expansion admits both its old runs and new
page before replacement. Materialized blocks retain only their occupied byte
prefix, expanding under old/new admission; emission synthesizes the unchanged
zero tail rather than retaining a full 4 KiB for every small directory.
Directory append, record splitting and indexed-slot reuse prepare destination
growth before modifying existing records or consuming a valid free slot.
Directory-index credit ends before deferred-section sealing;
the finished image retains block, pointer and extent credit until it drops.
The current deferred-section writer candidate prepares each record/archive's
node and actual owned field capacity against the same I/O pool before copying
or namespace publication. The fixed 8 MiB SDEF metadata cap separately charges
actual record/archive counts and field lengths, not phantom vector capacity.
Buffered and streaming serialization share validation and field emission.
Production encoding drains prepared nodes through one admitted 4 KiB packing
buffer; it does not retain a complete encoded section beside its input fields
and output blocks. Removed values retain their credit until their bytes drop.

Pending metadata also reserves 256 KiB of finalization headroom plus the
projected output blocks' concrete map-node charges within the existing I/O
allowance. Preparation reserves only each increment; publication merges it
allocation-free. Encoding releases that reservation before actual output
allocation, while retiring input owners supplies later capacity. The reserve
covers packing, the superblock and a maximum-sized record's output burst;
output-node charges account for overhead accumulated across the whole section.
It is reserved admission capacity, not another resident payload or an increased
profile limit. Declaring even an empty section is fallible and prepares its
hidden inode before publishing the declaration. Subsequent inode creation
prepares backing for the eventual hidden inode without assigning its number or
extending visible table length. Geometric table growth can fall back to exact
required capacity under pressure, still admitting old/new backing together.

Snapshot traversal and identity maps retire before writer finalization. A
failed plan retries once after `ENOMEM` only if reclaiming disposable verified
read/proof and journal-read caches actually releases I/O credit; ordinary
dirty data and authoritative journal state are not evicted. The retry returns
its actual result, including provider failures. These writer changes have
focused native evidence; current Node/browser/product acceptance is separate.
They do not establish whole-system memory bounds or RSS accounting.

Rootfs directory names own preallocated AVL nodes rather than inserting into
a standard B-tree after commit. Preparation first admits the existing
768-byte node model plus twice the owned name capacity, copies the name with
a fallible reserve, and allocates the node with its concrete layout. A null
allocation returns `ENOMEM` and releases both the name and its credit. A
compile-time assertion keeps twice the concrete node size within that model.
Publication only links/rotates prepared nodes; replacement retains the prior
key and releases unused preparation. Removal frees nodes without allocating.
Existing namespace/recovery credit exchanges include that prepared ownership.

Directory lookup, insertion, removal and exclusive successor queries are
ordered tree operations. Forward/reverse iteration uses fixed reference
stacks, no heap allocation, and an exact remaining-entry count so mixed-end
iteration does not repeat entries. Each stack has twice the target pointer's
bit width: an AVL tree of that height would need more addressable nodes than
the target can contain. Iterator lifetime borrows the tree, preventing safe
mutation while its references are live. The only new unsafe operation is the
fallible concrete allocation/initialization transferred into `Box` ownership.
Depth-first namespace traversal saves compact immutable key-range bookmarks,
not full iterator stacks at every ancestor. Resume reconstructs the bounded
iterator paths from those keys. The existing 16 KiB traversal-scratch test
keeps its original bound. Journal maps and other scratch still need admission;
these mechanisms do not establish allocator/RSS bounds or measured speed.

Retained base-directory keys used by journal compaction are admitted too.
They distinguish required base-name tombstones from disposable history.
Rust stores them in an AVL tree with logarithmic lookup/insertion and
logarithmic call depth, independent of filesystem path depth. Each prepared
entry reserves twice its concrete node size and owned name capacity from the
resident metadata ledger. Both the name reserve and the aligned node allocation
are fallible; a null allocation returns `ENOMEM` and releases ownership.
The node is allocated with its exact layout and transferred to `Box` only
after initialization, so normal drop reclaims both children and its credit.
Namespace mutation prepares nodes before journal commit, then links them
without allocating. New directory names and retained nodes are staged against
temporary headroom, then atomically exchange credits with names the transaction
removes. Rejected admission leaves the namespace unchanged; a failed commit
reverses the exchange before returning. Publication consumes the admitted
removals. This lets unlink reclaim metadata at the resident limit instead of
requiring extra resident space for its base-name tombstone. Recovery admits
the retained set before publishing its namespace.
Compaction filters/rebalances existing nodes without allocating and releases
removed entries' credits. These charges do not prove a whole-process RSS bound
or admit the aggregate journal/index state listed above.

Journal transaction publication also prepares its metadata, block-location
and checkpoint-invalidation nodes before writing. These three ordered maps
use fallibly allocated AVL nodes. All record decoding, owned name/value copies
and node preparation precede the storage write and flush. Successful flush
publishes only prepared ownership, cache invalidations and revision scalars;
zero-fence minima reuse their prepared eight-byte values. A preparation
failure returns `ENOMEM` without poisoning the writer or publishing the
transaction, so it may be retried. Storage write/flush errors retain the
existing sticky-failure behavior. Replay propagates node-allocation failures
before changing the mounted namespace or truncating a valid journal.

The transaction encoder validates and computes its entire size before
allocation, rejects frames above 1 MiB, and reserves the encoded output
fallibly. Decoding validates the whole payload before exposing borrowed
records, without allocating a decoded record vector or copying its names and
values. Replay prepares owned metadata only when retaining it, and hashes
file blocks directly from the frame before preparing their location nodes.
Indexed verification and legacy-conversion callbacks borrow record payloads.
Compacted block and metadata index cursors share one fallibly grown frame
buffer capped by the 1 MiB transaction limit. They emit one record at a time
rather than retaining a second pending-record vector; only an emitted
metadata directory key needs a bounded fallible name copy. A malformed record,
count, checksum or fixed-mode metadata record fails before the cursor emits
any entry from that transaction. A failed buffer/name allocation terminates
that cursor with `ENOMEM` without rewriting its source; a fresh cursor can
retry. No throughput or whole-process peak-memory improvement is implied.
Checkpoint metadata-key decoding likewise fallibly copies its bounded name;
the index's two page buffers remain fixed-sized. Journal map iteration and
bounded block ranges use fixed reference stacks rather than heap traversal
buffers. These changes remove post-flush allocation from journal state
publication. Journal map ownership is now charged to a shared profile-aware
state budget, including preparation and retired replacement ownership;
remaining cache/scratch and recovery/snapshot peaks still require aggregate
admission and measured process-memory acceptance.

Journal read-block, dirty-block and metadata-cache slot vectors are now
fallibly reserved at their 64-entry limits before opening can write even a
new journal header. The dirty-file-size table is a pre-reserved sorted
64-entry vector rather than an allocating B-tree. Publication and LRU moves
assert a reserved slot and cannot grow those tables. Resident block payloads
are 4 KiB each; metadata values are at most 4 KiB and cached directory keys at
most 255 bytes. Indexed value lengths are checked before copying. These are
per-journal entry/payload bounds, not measured allocator/RSS guarantees.

Read misses, returned/cached metadata copies, write-block preparation, sync
batches and eviction batches use fallible reserves and copies. Metadata
cache hits clone their result before changing LRU order; a failed miss does
not evict a valid entry. Eviction stages only victim keys and one copied
payload per victim, not two copies. All fallible staging precedes victim
commit, removal and acceptance of the new chunk. Allocation failure preserves
accepted dirty bytes and sizes for read/retry without poisoning the journal;
a large write returns only a prefix already accepted by earlier chunks.
Storage write/flush failures keep their separate sticky-error policy.
Aggregate profile-aware journal/map/cache budgeting and whole-process peak
acceptance remain separate work.

Boot can retry a memory-limited journal through the bounded Rust legacy
converter even below the byte-based conversion threshold. This is permitted
only when Rust reports that the failed recovery did not publish namespace,
allocation-statistic or FIFO changes. The host reads that scalar immediately
after `ENOMEM` in the same kernel entry and attaches it to the rejection;
an unqualified resource error is not retry authority. Rust clears this state
before publication, on reset, and when refusing an already active mount.
The scalar export is included in the branch's ABI 55 snapshot.
FIFO-registry allocation now completes before this publication boundary.
A refusal there can therefore qualify as pristine; once namespace changes
publish, recovery still cannot reuse the kernel after a later failure.

The host attempts at most one conversion for that rejection, into a separate
slot that preserves verified fallbacks. Rust validates and converts the
source, then the host seals/verifies the target and mounts it before selecting
the new generation. Failed conversion, quota exhaustion or rejected target
leaves the source in place and fails closed; a target rejection alone does not
prove source corruption. It must not select an older generation merely
because the newest exhausted memory. A failure after namespace publication
does not qualify and still requires a fresh machine boot. This retry is not
an aggregate memory bound or proof that any live namespace fits its profile.

The current candidate records generation activation independently of seals.
Two fixed 128-byte activation controls bind publication sequence, base digest,
generation, slot and immutable seal digest. Recovery selects only that
identity; a damaged activated seal, index or committed journal does not permit
mounting an older retained journal. Native Rust validation remains authoritative
for journal and index contents. Without controls, unexplained damaged generation
data refuses recovery rather than proving that an older source is fresh.

Before target mutation, selection anchors the current source and repairs both
control replicas. A degraded pair repairs its missing or stale replica first,
never overwriting the sole newest record first. Activation and both control
write/truncate/flush operations run synchronously before guest dispatch. An
unconfirmed activation synchronously poisons the kernel-entry gate before any
queued continuation can run, even though worker termination is asynchronous.
The host retains possibly aliased target handles instead of truncating them.

Activation owners are terminal after publication failure or close. Failed
descriptor cleanup retains one bounded, charged quarantine obligation; further
acquisition refuses rather than losing descriptor ownership or retrying a
potentially reused numeric descriptor. Realm teardown is the final release
boundary when close cannot be proven. Generation metadata charges include
the two controls and their owner.

These host publication changes apply to both Node and OPFS within the
ABI 55 candidate. Earlier prototype hosts that ignore the controls are
not supported writers or downgrade targets. Checksums detect damage; they do
not reconstruct lost data or detect coordinated replay of every control and
data file. Browser flush still does not establish OS/device power-loss safety.
The [durability contract](persistence-durability.md#release-acceptance-map) describes
recovery coverage and the limits of application-level checks.

Journal state has a separate admission budget from live namespace metadata:
both hosts configure the smaller of 32 MiB and one eighth of the kernel
address-space ceiling. Each prepared map node reserves twice its concrete
node size plus twice its owned key/value capacities before allocation; a
metadata record reserves before copying its borrowed name/value. Published,
staged and retired replacement nodes all retain credit until their ownership
drops. Replacement exchanges whole nodes, preserving the credit for the old
key/value until that retired entry is destroyed. Truncation pruning, checkpoint
release, failed preparation and mount reset release the corresponding credits.

The journal budget includes a fixed 256 KiB writeback reserve, unavailable to
ordinary state preparation. Bounded dirty-block/size flushes and at most 64
small inode timestamp records may use it if ordinary admission is full. These
already accepted changes can drain without admitting further writes or new
timestamp owners while the reserve is in use. Timestamp writeback also bypasses
the active-tail limit, like dirty-block flushing, rather than stranding a
pending sync behind admission intended for new mutations. Allocation or I/O
can still fail and must be reported; this reserves admission, not physical RAM.

Rust reports pressure at half the ordinary state allowance or whenever the
writeback reserve is used. Node and browser boot/live compaction consult that
decision even below the serialized-byte threshold. Production resizable
compaction streams its metadata into the target rather than building another
resident metadata map. At activation, retained base-directory keys validate
their checkpoint lookup decisions into existing tree nodes first; only after
all lookups succeed does a no-allocation prune remove keys and release credit.
A lookup failure leaves all keys/credits intact. The convenience Rust
`compact_metadata_into` mode still retains its intermediate metadata within
the same admission limit; production uses the streamed reachable-metadata mode.
Journal cache slots and clean/dirty payloads, retained metadata-cache ownership,
encoded/replayed transaction frames and prepared-publication vectors now share
an I/O admission pool with ordinary and archive verified-read tables, chunks
and streaming verification buffers. Both hosts configure the smaller of 32 MiB
and one eighth of the kernel ceiling. A fixed 2 MiB slice is reserved for dirty
writeback cloning, framing and publication scratch; ordinary cache fills cannot
spend it. Accepted dirty data can drain when ordinary admission is exhausted.
This is distinct from the journal-state node reserve described above.

Typed I/O buffers reserve twice their actual vector capacity, retain credit
through consuming iterators, and forbid growth without admission. Frame-buffer
growth admits both old and replacement allocations before copying, preserving
the original on refusal. Cached metadata reserves names and values before
copying them; payload credit lives with the retained cache entry. Failed ordinary
transaction admission happens before journal publication and does not poison
the writer. Physical allocation and storage operations can still fail.

Descriptor heap slots, blocked-FIFO waiter nodes/paths and depth-sized
namespace-walk buffers also use ordinary I/O admission, never the writeback
reserve. Descriptor tables keep three slots inline; this avoids allocating
descriptor storage for stdio, not the separate OFD/process allocations.
Reservations are invisible and noninherited, installation cannot allocate,
and freeing the last occupied heap slot drops its allocation and credit.
Spawn copies and fork restoration admit descriptor storage before child
publication. Pipe/socketpair creation reserves both descriptors before backing
publication; exclusive character-device opens reserve before acquiring their
owner. Namespace traversal prepares ancestry/path growth before consuming an
entry and can retry that entry after refusal.

Open-file-description (OFD) arenas retain ordinary I/O credit for their actual
slot capacity, including free slots. Growth admits old and replacement backing
together; fork restoration grows geometrically with an exact-size fallback.
Preparation reserves an invisible slot, an immutable shared pathname and the
shared mutable offset/status/owner state. Shared owners include conservative
control-block credit and release it only with their final reference, including
queued descriptor transfers. Initial device-sidecar boxes and nested DRI/KMS
metadata, pending flips and completion bytes are admitted too. Prepared
slots do not appear in iteration or child copies, and cancellation drops their
owned credit without publishing a descriptor.

File creation/truncation, host opens, exclusive device claims, socket accept
queue removal and transferred graphics-backing reference acquisition follow
descriptor/OFD preparation. A blocked FIFO open retains its prepared descriptor
through rendezvous; cancellation and process/thread cleanup release both
reservations. Stdio creation and child inheritance propagate admission failure
rather than allocating OFDs infallibly. A failed accept leaves its pending
connection, bytes and queued rights available for a later retry.

Host-backed directory iteration admits a reusable name buffer before advancing
the iterator. A record that does not fit moves that same buffer into its OFD's
pending entry without another allocation; retry preserves the observed inode,
name and type. Admission refusal returns earlier completed records, or
`ENOMEM` if none were produced, without consuming a new host entry. FIFO type
lookup compares the parent/name components without allocating a joined path.
An inherited directory reopens at its shared guest-visible cookie instead of
copying the parent's pending bytes or sharing its process-local host iterator.

Procfs snapshots own admitted output bytes, including foreign-process content
and writeback-loss reports. Numeric, group-list and map formatting writes
directly into that output rather than allocating intermediate formatted strings
or a joined group list. Cmdline/environment output computes its required byte
length before copying. Snapshot refusal occurs before backing/descriptor
publication and propagates `ENOMEM`, not a missing-process answer. Process
inspection borrows process names, walks process records directly and sizes
cmdlines without materializing them in its first pass.

Epoll interest storage, resolved snapshots, poll scratch and event output also
carry I/O credit. Wait scratch is admitted before a new temporary mask is
installed. A terminal preparation error on an existing retry restores only its
matching Active top frame and replacement mask; unrelated enclosing waits are
not popped. Deliverable signals retain the existing dequeue/restore handoff.
Host watched-fd enumeration and nested epoll polling use allocation-free scans;
they do not treat a refused snapshot allocation as an empty interest list.
Nested polling releases the backing-table lock before recursion.

Graphics registry, GEM-handle and KMS-framebuffer maps use fallible prepared
nodes charged to the same ordinary I/O pool. Handle/framebuffer preparation
precedes backing references and host operations; admission refusal does not
publish a partial object. Fork-sidecar cloning and decoding admit their own
maps and queued flips, including space for every future completion. Page-flip
acceptance reserves both the pending record and its eventual 32-byte event
before latching host scanout or advancing commit statistics. Vblank retirement
then appends without allocating, including when ordinary I/O credit is full.
DRI mmap-binding capacity is admitted before VM allocation or host binding;
unmap and lifecycle unbinds do not allocate an intermediate binding list.
Nested GL-query staging is admitted too. These charges cover Rust metadata
and staging, not host pixel buffers, shared-memory reservations or WebGL
resources; they do not by themselves establish a whole-system memory bound.

Each evdev input-ring owner admits and allocates its complete 24 KiB capacity
before an open or fork-state decode can publish it. Its conservative backing
credit follows the final shared ring reference, not an individual descriptor.
Input delivery cannot grow the ring: overflow discards one oldest complete
record, preserves the newest event and latches `SYN_DROPPED`. A checked monotonic
delivery epoch in each shared ring suppresses duplicate fork aliases without
allocating a temporary identity list during event fanout.

Fork/exec descriptor-selection plans admit their sorted alias counts against
ordinary I/O memory; descriptor and OFD entries are iterated directly rather
than collected into extra vectors. Fork output buffers, socket-root and
ownership-rollback plans, and the child's retained anonymous-pipe replay pairs
also carry admission. Output-buffer exhaustion is distinguished internally
from allocation refusal: only the former retries with a larger output buffer.
Graphics sidecar decoding acquires no backing references; successful fork and
spawn acquire them after all fallible inheritance preparation, avoiding leaks
when decoding or later admission fails.

Shared host-handle reference records also own ordinary I/O credit through
prepared AVL nodes. First sharing is fallible, and reference increments check
overflow. Fork/spawn first group their host handles and prepare all new records
and final counts before changing any inherited resource reference. Once other
fallible resource preparation succeeds, publishing the host counts allocates
nothing. Failed preparation leaves existing counts intact; final close drops
the record and its credit.

Retained SCM_RIGHTS batches own admitted vector capacity through blocked-send
templates, stream/datagram queues, peeks and consuming receives. Template and
peek cloning share one implementation that prepares the complete array before
retaining references or copying guest-visible carrier bytes. Stream ancillary
queue growth admits old and replacement capacity before publishing either
carrier bytes or descriptor ownership. Receiver descriptor-index arrays admit
their capacity before the first fd installation. A control-capacity cutoff
drops excess queued entries in place, without allocating a detached suffix.

Datagram queues and their payloads also retain ordinary I/O credits. Slot
growth admits old and replacement arrays before constructing a new packet;
geometric growth may fall back to the exact required capacity. AF_UNIX reliable
datagrams return `ENOMEM` on admission refusal and `EAGAIN` at the queue limit,
without changing accepted packets. UDP keeps its unreliable tail-drop policy
for a full queue or failed queue/payload admission. Failed payload construction
may leave prepared queue capacity retained and charged; socket destruction
releases it. Existing packet data/order and readiness are not fabricated by a
failed enqueue. Inheritance does not copy consume-once packet queues.

Socket arenas retain ordinary I/O credit for their actual slot capacity,
including free slots. Socket options, historical bound names, device and TCP
policy names, multicast membership/source arrays and legacy accept indices
also own admitted capacity. Default construction, child copies and decoding
are fallible; nested clone failure releases the incomplete copy without
changing the source. The reserved netlink queue field uses admitted owners
too; this is not additional netlink protocol support.

INET binding tables and per-binding owner arrays prepare growth before
replacing a prior binding. Inheritance prepares all owner capacity and grouped
host-network-handle map nodes before acquiring common backing references.
Publishing those prepared binding/reference records does not allocate;
network-reference metadata is released on final close. Production IPv4 UDP
delivery walks copied endpoint records without
allocating an endpoint snapshot or retaining a global-registry borrow across
packet delivery. These serialized routing loops do not mutate the binding
roster while iterating it.

AF_UNIX registry names, map nodes and owner arrays spend the same ordinary
allowance. Bind prepares registration before creating its filesystem marker.
Rename prepares both FIFO and socket registry changes before the namespace
operation, including socket names beneath a moved directory; successful
publication transfers existing socket owners without allocating. A failed
preparation or namespace operation does not publish the prepared rename.
Canonical namespace-resolution scratch remains a separate memory obligation.

Shared accept-queue arenas and pending connection records are admitted too.
Same-process and cross-process connect, and host connection injection, prepare
queue capacity before pipes or client-state publication. Accepted-socket
metadata and arena capacity are prepared before removing the pending record.
Refusal preserves its bytes and queued descriptors for retry. Socketpair
prepares both socket defaults/slots and descriptors before allocating pipes.
String-valued getsockopt outputs and their terminating byte propagate admission
failure before copying the result into guest memory.

Queued SCM_RIGHTS identity counts and promised deferred-cleanup records admit
old and replacement capacities before growth. Destruction enqueues into already
reserved storage without allocating. Empty identity tables release their
capacity; cleanup storage releases only after both pending records and promised
destructors are gone. These bounds do not cover remaining process/address-space
ownership, fixed-ABI wrappers, canonical namespace scratch, wakeup queues
or all other kernel/host owners, including host graphics payloads and engine
reservations.

Legacy guest-byte staging and IPC structure copies use the ordinary admitted
buffer owner as well. SysV message input removes its native type prefix in
place rather than allocating a second text copy. Message copy-out validates
the caller's native type and address arithmetic, then writes a fixed header
and the owned message body without allocating after queue consumption.
Blocked-retry slot arrays retain credit, as do captured SysV send messages;
an existing host-preflight binding accepts its first captured input and never
replaces it on a later retry. Failure to retain the required binding is a
terminal resource error, not a request to reread the caller's buffer later.

Opaque channel records own admitted input snapshots, decoded span/range and
nested-vector arrays, and prepared output-copy plans. Validation errors map
to `EINVAL`; admission errors map to `ENOMEM`, before dispatch. Preparation
admits all eventual copy-back bytes while the immutable record and decoded
metadata are still live. After dispatch, the plan snapshots every output
source before writing any destination, preserving overlapping layouts without
a post-operation allocation. Scratch addresses must remain valid through that
copy-back. No channel, record or caller-native byte layout changes.

Legacy directory-stream arenas and shared immutable path owners are admitted
before host open. Iteration and rewind can retain a path alias without another
pathname allocation. Procfs/devfs listing arrays, copied/numeric names and PID
cohorts carry ordinary credit; failed generation does not publish a partial or
fabricated-empty listing. PID-existence checks query authoritative membership
without collecting a list. Epoll wake-index output validates its capacity and
writes fixed records from its admitted interest snapshot without extra index
or encoded-byte vectors.

POSIX message-queue names, objects, descriptors and operation pins use admitted
prepared map nodes. Creation prepares the descriptor, object and copied name
before publishing any of them; an additional open or pin prepares its node
before increasing ownership counts. Message data and queue slots prepare
before changing order, accounting or notification state. Receiving transfers
the existing payload owner, so the bytes remain charged until their consumer
releases them, including after unlink and final descriptor close.

SysV message/semaphore/shared-memory objects and operation pins also own
ordinary I/O credit. Public IDs, generations and pin IDs are selected without
mutation, then advanced only after preparation succeeds. Semaphore storage,
GETALL/SETALL arrays, message payloads/slots, shared-memory backing bytes and
Wasm semaphore-operation staging use admitted buffers. Logical queue limits
and permission checks remain distinct from memory refusal (`ENOMEM`). These
charges do not change IPC persistence, process-sharing or removal semantics.

Removing a pinned SysV message queue or semaphore set moves its existing map
node from public-ID lookup to generation-keyed retirement. The key has the
same fixed-width representation, so no new node or payload allocation is
needed at removal. Old pins still refer only to their original generation
when the public ID is reused; final release frees the retired node and its
owned payload. Extracted prepared-map nodes normalize their detached-leaf
height before reinsertion, preserving AVL balance across these transfers,
replacement extraction and first-node extraction.

Process mmap and host-reserved-region arrays also spend ordinary I/O credit.
Fixed replacement prepares the projected mapping count before unmapping;
whole removal, trimming and replacement that fit retained capacity require no
new admission. A middle unmap admits its extra record before device unbinds,
and moving mremap admits both the new interval and any old-interval split
before publication. Fork mapping decode owns admitted capacity and restores
address order without allocating sorting scratch. Process SysV attachment
record arrays retain credit through draining and cleanup.

Thread-record arenas prepare after caller validation but before task-ID
allocation or deterministic thread-creation publication. Timer-record arenas
prepare before publishing a new timer; reuse of a free slot allocates nothing.
Host timer-cleanup cohorts carry credit and prepare completely before changing
alarm, notification or timer state. These internal Rust owners do not change
guest/host byte layouts, increase profile ceilings or establish a whole-system
memory bound. Nested signal queues, other process metadata, shared mapping
coherence stores and host bookkeeping remain separate audit obligations.

Process argv/environment and replacement transactions use admitted nested byte
and slot owners. Staging failure poisons the transaction without changing the
live pair; committing a prepared pair allocates nothing. Spawn prepares both
vectors before allocating its identity or applying file actions. Reaping a
retained process-group leader moves its existing metadata into limbo rather
than copying it after teardown. Fork/exec decode and saved fork actions own
admitted buffers, including action paths; applying actions transfers the whole
arena instead of collecting another vector.

CWD shares the same admitted immutable path representation as OFDs. The root
and empty path representations require no heap allocation. Chdir prepares a
new pathname before assignment; fchdir can retain its existing OFD path without
allocating. Supplementary credentials store their existing maximum of 32 group
IDs inline, preserving order and duplicates without heap allocation during
credential transitions or fork decode. Procfs self readlink output uses
admitted copied/formatted bytes.

The ABI 55 candidate makes `kernel_push_argv` result-bearing: zero on success,
negative errno on refusal. The libc import and saved-fork startup check match;
startup exits rather than proceeding with an incomplete vector. Channel-worker
CRT imports do not support that legacy mutation path and return `ENOSYS`
instead of silently ignoring it. Current startup still uses the atomic kernel
metadata-replacement path. Reserved init creation now propagates metadata
admission refusal before publishing PID 1 or consuming a user task ID. These
source/ABI changes require rebuilt SDK/program/image acceptance; a regenerated
snapshot alone does not validate the previously frozen browser checkpoint.

The process registry's inline records and listener round-robin nodes now
spend ordinary I/O credit. A prepared map slot owns both credit and the physical
uninitialized node before task-ID allocation; constructing its final value
does not allocate another node. Fork/spawn complete node preparation before
acquiring inherited machine-wide references or publishing the child. Reaping
a retained group leader reuses its original node for limbo publication.

Removal transfers existing OFD, directory and socket arenas into a private
cleanup owner rather than collecting new close vectors. After authoritative
removal/limbo publication and pruning, Rust streams directory closes before
file closes, drains the already-reserved ancillary-release queue, releases
framebuffer ownership, then closes last-reference network handles and releases
mouse/clipboard ownership. Deferred PRIME releases also destroy their host
backing at the last reference. HostIO supplies the small I/O capabilities;
Node and browser use the same Rust ordering and ownership policy. Test-only
effect collectors do not enter production paths. This does not claim that
unconverted wake/signal or host bookkeeping allocations are already bounded.

Group-signal and terminal delivery walk PID membership using a cursor rather
than allocating a cohort that could fail after accepting input. Listener
selection counts and revisits live targets without temporary vectors; new
round-robin nodes admit before cursor publication, and failure propagates as
`ENOMEM` without returning a fabricated absent listener. Device fanout uses
allocation-free mutable visitors, and wait selection reads the first matching
status before mutating that exact child. Existing priority, ownership and
`WNOWAIT` rules remain unchanged. Actual workload cost is still unmeasured.

Clean journal reads evict old payloads before retrying admission. Verified reads
reclaim local chunks and inactive verification tables, then can reclaim other
read-cache owners while keeping the current verification identity. Journal
cache reclamation uses a nonblocking lock attempt so nested I/O cannot deadlock
on a journal already borrowed by its caller. Persistent writes reclaim clean
read caches at half ordinary I/O allowance before staging another chunk. These
operations never discard dirty data, pending file sizes or journal state.
No workload-performance or process-RSS claim follows from this policy.

Compaction and legacy-conversion mutation batches also admit their slot arrays
and owned name/value capacities before copying. Successful flush releases the
batch payload credit; failed flush retains it with the still-owned records.
Direct journal writes and truncation use the same ownership discipline. Indexed
metadata walks admit their value buffer before visiting a record. Inode-record
encoding uses fallible allocation; bounded timestamp batches and generation
vectors use writeback-scratch admission, so ordinary exhaustion cannot strand
already accepted data and timestamps.

Legacy external sorting admits its prescan, run, cursor, serialization, merge
and copyback buffers. Prescan buffers drop before sorting; run-generation
buffers drop before merge passes; emission batches/cursors drop before index
construction. This avoids retaining all phase workspaces simultaneously.
The 4,096-record sort run and storage formats are unchanged. Native conversion
tests exercise odd/even merge-pass counts under a 6 MiB ordinary allowance,
including source preservation and indexed reopen. These are admission-credit
observations, not process RSS. Rootfs compaction's live-inode planning vector
uses namespace temporary admission before initializing the target journal.

This pool does not yet cover every filesystem allocation. Remaining work
includes caller-owned metadata results and checkpoint-structure ownership,
snapshot/recovery union peaks, FIFO resources and transport bookkeeping. Some
internal allocations remain infallible. Actual whole-process peak and workload
acceptance remain open. ABI stays 51; image, journal and checkpoint formats
are unchanged.

Namespace recovery prepares its final changes and link counts before clearing
FIFO registrations or publishing created inodes. Replay vectors, owned key
copies and iterative directory-graph validation use fallible temporary
admission; graph validation does not clone the namespace into nested maps.
Unchanged names need no new ownership, and value-only updates retain their
existing owned keys. New keys are staged under temporary headroom. Before
publication, Rust atomically exchanges their credits with credits for base
keys being removed, checking both resident and temporary limits. A rejected
exchange restores the old credits without changing the tree. This avoids
charging both old and replacement names against the resident limit during
recovery. It does not yet bound every recovery structure or guarantee that
every live filesystem can reboot at its exact resident budget: the union of
base and live journal-created inodes and their fields remains a separate peak.

Recovery reconstructs created inodes referenced by the final namespace, not
every inode ever described in the journal. A bounded metadata cursor merges
checkpoint and tail records while allowing individual inode lookups between
steps. Cursor buffers have fallible temporary admission and reject oversized
values before copying them. Base indices, scalar updates, referenced IDs,
created descriptors, eligible sizes and allocation totals are also admitted
temporary vectors. Detached directory tombstones may be skipped only after
their parent descriptor has been validated as a directory. Unused inode
descriptors and orphan file-size/block owners still undergo semantic
validation; malformed, unknown or nonregular data owners remain errors.
The highest described inode number advances allocation even when its object
is not reconstructed, preventing reuse against retained journal records.
This removes the deleted-inode reconstruction peak, not the remaining
base-plus-live arena/field peak or unadmitted journal structures. Retained
base-directory keys now use the separately described fallible AVL admission.

A deferred file is one the image names but does not carry: a URL-backed lazy
file, or a member of a lazy ZIP archive. The image records its real size, the
URI its bytes live at, and the SHA-256 digest they must hash to. `stat` and
directory listing never fetch. The first read or exec asks the host for the
bytes with `host_fetch_deferred(uri, ...)`; the host fetches the URI through
its lazy transport (`buildRootfsLazyWiring`), answers `EAGAIN` while the fetch
is in flight, and the guest's ordinary retry finishes the read once the bytes
land. Ephemeral roots check an archive's digest before caching its whole body
and extracted members in kernel memory, without eviction. Persistent roots use
the bounded positioned path below. Archives may be sealed into atomic
activation cohorts (`seal.rs`); the kernel verifies the cohort digests when it
loads the image.

Persistent digest-declared reads do not turn deferred descriptors into embedded
checkpoint content. The Rust verified-read cache authenticates the complete
file in 1 MiB windows, retaining at most 8 MiB of per-chunk SHA-256 tables
across 64 files and four 1 MiB data chunks. A cache miss authenticates fetched
bytes against the previously authenticated chunk hash before exposing them;
transport bytes are not assumed immutable. Evicting a file's table requires
whole-file verification again. A file too large for one table uses a bounded
verified-window fallback, rehashing the file for each window; that path has
not met a throughput acceptance gate. Rejecting a shared URI clears every
dependent verification proof so prefetch must wait for replacement transport
bytes.

Persistent archive reads do not retain a whole ZIP or decoded member. Rust
authenticates raw archive bytes before interpreting their directory, using a
separate verified-read cache with the same 8 MiB hash-table / 64-object and
four 1 MiB chunk limits. File and archive caches have independent local
caps, not a combined 12 MiB cache cap. Both compete for the shared admitted
Rust I/O allowance; neither local cap reserves extra capacity outside it.
Legacy resources without an expected
digest remain unverified against an authoritative source identity.
ZIP32 directory entries are indexed by filename hash and positioned-header
offset; a lookup still compares the exact filename. The index avoids a complete
directory scan for each new member, without retaining every name or header.
At most 4 MiB of indexes across 64 archives are retained. A new transient index
can contain the format's 65,535 entries; directory parsing uses a 65,557-byte
end-record tail and a reusable 65,535-byte name buffer, not an archive-sized
allocation. ZIP64, encrypted entries, and data descriptors remain unsupported.

Stored members read directly through the authenticated archive source. DEFLATE
members use incremental miniz state, 64 KiB input/output buffers, and at most
eight decoder checkpoints per reader, spaced by at least 1 MiB of output.
Rootfs retains at most two readers; a native unit test limits each reader's
heap retention to less than 1 MiB, excluding allocator overhead. Sequential
reads advance the decoder rather than restarting for every small request.
On a cache miss, those two cached readers can overlap a new active reader
before eviction. ZIP directory indexes, parsing scratch and decoder vectors
have these separate structural limits but are not charged to the shared I/O
allowance or included in its admission high-water report. Count their actual
capacities and overlap separately when measuring filesystem retention.
Backward seeks resume a retained checkpoint or decode the uncovered prefix
again; compressed random access is not constant-cost. URI rejection clears
raw/file proofs, directory indexes, and decoder state together. Activating a
persistent mount also drops whole-archive caches warmed while ephemeral.
This cannot shrink a Wasm memory that already grew before activation.

The 96 MiB stored/DEFLATE integration fixtures stream from private server files
instead of allocating complete bodies, then read through guest `dd`, strict
journal recovery, and a positioned checkpoint under a 64 MiB kernel ceiling
on Node and all three browser engines. These are bounded-path functional
checks, not aggregate peak-memory or sustained-workload benchmarks.
Caller-owned closed-asset bundles and aggregate recovery/export scratch still
need complete ownership accounting. Host URI admission is described below;
it does not establish a whole-process memory bound.
The verified-read limits alone are not a whole-system memory bound. Ordinary
reads preserve deferred archive identity and URI/digest metadata in snapshots;
external resources remain an offline dependency unless separately mirrored.
Ephemeral write-copy-on-write behavior is unchanged.

Persistent roots stage deferred transport in one private temporary byte file
per kernel worker instead of retaining completed resources as JavaScript
arrays. `DeferredByteSpool` serializes downloads, applies the native declared
transfer bound, and streams each response into positioned storage. Native URIs
remain the staging identities; deployment aliases are
resolved only at the fetch boundary and cannot share writable staging extents.
Storage reads and writes use at most 64 KiB per storage call; OPFS uses one
64 KiB nonshared
bounce buffer because kernel destinations can be shared Wasm memory. Retrying
or rejecting a URI reuses its extent rather than appending another complete
copy. Extents grow from received bytes, not the declared maximum, so a short
response cannot reserve a resource-sized hole before the next download. A
growing retry can relocate its prefix with at most 64 KiB of copy scratch;
other URI extents remain unchanged. Retired extents are reclaimed with the
temporary store, not by journal compaction. Only completed transfers become
readable. Rust still verifies lengths,
whole-file digests, and authenticated chunk reads; staging is not a second
filesystem or content authority. Node's local asset responses also stream from
their files rather than first reading a complete asset into a buffer.

Node unlinks the private temporary file immediately after opening it, so its
descriptor owns the bytes until close or process death. This requires no-follow
opens and an unlinkable open temporary file; unsupported platforms fail
initialization. Browser stores live
under `kandelo-deferred-bytes`: a worker holds a per-store Web Lock, and a
separate cleanup lock serializes creation and abandoned-store reclamation.
Cleanup preserves live owners and unrelated entries. A terminated worker's
lock is eventually released; a later open retries reclamation if OPFS has not
yet released its handle. Shutdown aborts active and queued transport work,
closes the backing file, and attempts removal. These are disposable caches,
not recovery generations: they are not synced as guest data, cannot replace
an unavailable deferred source after reboot, and consume separate physical
storage quota. Transport storage preserves `ENOSPC`, `ENOMEM`, and `EROFS`
rather than reporting every failure as `EIO`.

Every deferred `/` fetch, with or without a spool, follows one timing policy
on both hosts (`withLazyResponse` in `host/src/vfs/lazy-fetch-bytes.ts`). A
fetch has two phases with separate deadlines:

- **Preparation** is local work a transport must finish before it can request
  an address. Node uses it for repository-served images: the first lazy read
  resolves every lazy asset in the image in one batch, which can regenerate
  the program index. Preparation moves no bytes, so it has no inactivity
  deadline. It has a 10-minute ceiling so that a wedged resolver fails rather
  than hangs. It runs once and is not retried.
- **Transfer** (the request, its retries, and the body) has a 30-second
  inactivity deadline that starts when preparation ends. Only positive
  received bytes renew it, after the spool, if any, has staged them. Empty
  chunks, response headers, observer notifications, and retry attempts do not.

Either deadline reports `ETIMEDOUT`; with a spool, expiry also releases the
serialized queue. Preparation, fetch, read, retry-delay, and cleanup waits are
abortable, even if a custom fetcher or preparation ignores its signal or
cancellation never settles. Late responses are discarded and cannot publish or
modify staged bytes after cancellation. This cannot force a custom fetcher to
release its own resources, nor interrupt synchronous work that blocks the
worker's event loop.

Because the transport bounds every fetch in flight, host-side readers that
retry `EAGAIN` keep no clock of their own while one is in flight. That covers
inspection, prepared exec, and spawn. They wait for the next settlement and
read again. Their 30-second budgets count only `EAGAIN` with no deferred fetch
in flight, which the deferred pipe does not produce. A reader clock that also
ran during a fetch could only misjudge a slow but healthy fetch as stuck, such
as a long preparation or a large download.
Deferred readers share one settlement signal per active cohort. An untimed
wait holds one promise reaction until that settlement. Timed waits
(`waitForDeferredFetch`) register admitted, removable listeners rather than
adding another reaction to every pending fetch. Timeout or settlement removes
the listener and clears its timer; settlement releases the signal's retained
metadata.
Shutdown closes creator admission and cancels deferred work before waiting for
admitted creators to drain; otherwise a blocked lazy exec could prevent the
normal dirty-file sync from running before forced worker termination. Transfer
cancellation leaves completed spool sources readable through final mapping
publication and dirty-file sync. Only final storage retirement closes those
sources and releases their metadata; late transfers cannot republish entries.

Each kernel worker has one shared host storage-metadata admission ledger,
limited to the smaller of 16 MiB and one eighth of its configured kernel
address-space ceiling. This is a separate, conservative JavaScript ownership
model, not a deduction from Wasm memory and not an allocator/RSS measurement.
URI limits, pending/ready/failed transport slots, queued spool requests, spool
span identities and generation-discovery bookkeeping share this ledger.
Admission precedes retention or storage acquisition and returns `ENOMEM`
without treating the computer as corrupt or silently selecting an older
generation. Serialized inspection snapshots and their decoded URI table
overlap while both owners are charged. Discard, failed admission and final
retirement return the corresponding credit. A canceled custom fetch retains
its pending ownership until its actual completion; cancellation is not proof
that a caller-owned asynchronous operation has released its resources.

Generation discovery streams OPFS directory entries or Node directory reads
instead of collecting an unbounded directory first. A serialized generation
operation admits identifiers before retaining candidate dictionaries or
opening generation files. Failure rolls back its new identifiers; successful
identifiers remain conservatively charged until machine retirement, including
historical identifiers whose files have been removed. Ordinary compaction
reuses its ring slots. There is no fixed generation-count cap independent of
the shared budget. Seal writing, verification and prefix hashing each reuse
one bounded data scratch buffer rather than allocating a new one per chunk.

New positioned-image exports and decoded source staging use a streaming
whole-image SHA-256 descriptor, independent of image length, rather than a
retained array of per-MiB digests. Node and OPFS readers accept either the new
descriptor or legacy chunk descriptors, but reject mixed metadata. Export
flushes and reads the staged bytes back through bounded scratch before
returning integrity metadata; positioned boot verifies the complete stored
image before publication. These checks do not promise continual detection of
storage changes after a verified immutable image has been opened.

Container export streams length prefixes and borrowed metadata-section bytes
directly into the caller's output window. It does not clone the retained
metadata or build a contiguous trailer for each chunk. The original metadata
owner stays charged; EOF and explicit cancellation release the export plan.
This preserves ordinary container loading and the existing byte format.

An experimental `runtime-core::persistent_image` envelope supplies Rust-owned
streaming construction and demand-verified positioned reads for the fast-boot
work. The new `rootfs::load_persistent_image` path mounts its logical VFSI
payload and keeps the bounded verified cache for later file reads and image
export. The source browser composer produces this envelope; the frozen
WordPress checkpoint has not yet been rebuilt with it.
Creation explicitly selects CRC32C accidental-corruption checking or SHA-256
content binding; that choice is recorded in the canonical header identity,
not selected again at open. Both readers retain one source and use bounded,
I/O-admitted data/index caches whose budgets are independent of image size
and checking policy. The core writer owns one target, which may itself be an
exclusive borrow, and returns an identity after flush. The positioned image
module adds bounded stored-byte readback before releasing that identity to
its host caller; crash-safe generation publication remains a separate step.
CRC does not become cryptographic payload
protection because the small header identity uses SHA-256.

The positioned module's streaming writer is under integration. Its host
imports are only positioned source reads and token-bound target size, read,
write, truncate and flush operations. Rust constructs headers and checking
trees, checks stored payload blocks in bounded steps, and refuses a nested
writer operation before retaining any new target. The host retains the
exclusive physical handle through completion or cancellation. Ordinary VFSI
composition remains available and the default image module still has zero
imports. `KandeloImageFs.createPositioned` and its explicit-policy
`writePersistentImageTo`/`exportPersistentImageTo` methods expose this writer
to both Node file and browser OPFS adapters, with separate write/readback
progress. `createFromPositionedImage` can mount its output with an expected
identity and bounded Rust caches. The source browser composer and checkpoint
flow now publish these images through version 6 manifests. New computers
default to CRC32C, with SHA-256 available as an explicit creation option;
reopen and checkpoint retain the recorded choice. Header inspection in the
Rust module admits a saved base using a bounded ordinary prefix supplied by
the host, without another OPFS sync handle or a payload scan. The frozen
WordPress demo has not yet been rebuilt with this integration.

Clean base data/proof pages participate in Rust's shared I/O-pressure and
export/compaction reclamation. Reclamation retains source/identity and cache
records while dropping page storage and its admission credits; rereads must
verify again. Cache growth refusal can reuse an already admitted same-kind
page. It does not evict accepted dirty journal data or turn an actual
resource refusal into successful I/O.

Verified base state uses a separate lock from the rootfs namespace. Each
positioned read holds that owner only through verification and copying, not
through a filesystem walk or deferred-resource lookup. Rust retains one raw
reader adapter; the host must keep its physical file handle/provider alive
until that kernel generation is destroyed. Failed loads and plain-image
replacement clear both the namespace and verified cache. Journal attachment
requires the mounted envelope identity before opening journal/index storage.
The kernel checks the physical envelope length and uses that bound identity
without hashing the complete payload again. Ordinary VFSI mounting and its
existing full-digest attachment path remain available.

Node's `rootfsPersistentImageBinding` and browser
`initFromOpfsImage({ persistentImageBinding })` carry the expected identity
and explicit read-cache budgets to the shared worker. They are mutually
exclusive with whole-image host integrity descriptors. In this mode the
transport does no filesystem caching or hashing: Node reads positioned bytes
directly and OPFS reuses one 64 KiB bounce buffer because browser storage
APIs need an ordinary buffer rather than kernel shared memory. Rust checks
the canonical algorithm, geometry, proofs and contents. Focused Node and
Chromium/Firefox/WebKit tests cover native streaming creation, stored-byte
verification, cancellation and real kernel-worker journal restart. Complete
large-image, pressure and crash acceptance remain separate. The running
WordPress checkpoint uses the existing publication format and whole-image
checks.

The source browser computer manifest's version 6 stores the checked-base
identity, physical and logical lengths, checking policy, journal,
initialization flag and safe-integer generation. Version 6 is the canonical
source saved-computer envelope; the frozen checkpoint still uses version 5's
whole-image digest. The current source rejects
earlier prototype envelopes and recognized future versions without conversion,
archive fallback or source-image recomposition; compatibility with those
prototypes is not a supported contract. Ordinary product VFS image loading
remains supported and is distinct from saved-computer envelope admission.
Unsupported versions propagate as format errors rather than entering metadata
corruption recovery. These are browser publication-envelope changes,
not changes to KIFS, the Rust journal/index formats or guest syscall layout.

Whole-file host inspection uses a bounded ordinary result buffer rather than
retaining every read chunk and allocating another whole-file merge. Node and
browser expose `maxVfsFileReadBytes`; its default is the smaller of 64 MiB
and one quarter of the kernel memory ceiling. Exceeding the allowance fails
with `ENOMEM` without truncation or kernel teardown. Explicit ranges remain
independently bounded to 1 MiB. Refusal diagnostics retain the path, errno
and underlying allowance or allocation failure across the worker boundary.
Executable preflight keeps the existing
program-transfer bound, independent of this inspection setting. Rust owns
followed stat and namespace reads, including host mounts; the host only
admits and copies the returned bytes. A size hint does not establish EOF,
and short reads do not discard later bytes. Published whole-file results
belong to the caller; the allowance is per operation, not a global budget
for arbitrary numbers of retained results. Guest POSIX file reads remain
separate and are not restricted by this host convenience-result allowance.

The archived previous pair is not a recovery replica: it can lack later
acknowledged writes. The new, still-unreleased coordinator separates that
archive from an active binding in `<computer>.active.base.json`. Publication
writes a checksummed prepared record containing the exact source and target
manifests, commits the target primary, then commits the matching active
record before returning success. Both controls identify the same latest
base/journal; neither copies file data. The normal page repairs and activates
a selected pair after native kernel admission but before starting services.
Low-level callers must honor that writable-use fence as well.

Rust owns the prepared/active binding transition rules and selection between
primary, target and source. The browser submits a fixed 64-byte evidence packet
containing versions, generations, initialization state and observed manifest/
content equality; it does not decide which image is newest. Selection retains
no native state and reads no image data. The disposable image-codec worker
runs this policy through the existing native control export and terminates
before returning the bounded result. The host still owns JSON serialization,
manifest hashing, OPFS handles, locks, publication ordering and lifecycle.
Resource and unsupported-operation errors propagate, rather than becoming
damaged-control evidence that could authorize fallback.

Automatic compaction and generation replacement retain their storage ownership
and freshness checks. The browser does not expose a manual checkpoint
controller. User-managed checkpoint and restore are possible future work;
normal persistence uses journal flush and recovery.

One damaged or stale control can be repaired using the other valid current
control. A prepared target has not been exposed for writable use and can
still have a proven fresh source; an active target cannot fall back to an
older archive merely because that archive is intact. Missing or damaged
latest payloads without a fresh copy cause explicit refusal, not reset or
rollback. Journal-header inspection accepts canonical sealed-generation
files after compaction retires the legacy journal; native admission still
decides generation/index validity. Resource and unsupported-format errors
are not treated as corruption. Two lost controls, or coordinated replay of
both controls to an older internally consistent pair, cannot be repaired or
detected solely by these local checksums. This is not a guarantee against
arbitrary storage rollback, browser eviction or OS power loss. Publication
fault coverage and release acceptance remain open in the persistence plan.

Private browser composition bounds patch-text inputs to 1 MiB and transfers
them through at most 64 KiB of image-module scratch per read. Configured assets
use incremental hashes and native chunk writes, with a 32 MiB aggregate payload
limit per composition because their modified builder content remains resident.
These are staging-input bounds, not persistent file-size or logical-capacity
limits. Hash/refusal/cancellation errors discard the private composition before
publication, even when native staging has already consumed earlier chunks.
The host owns response intake; Rust remains authoritative for file operations.

Container export has an explicit native cancellation operation. A failed host
sink releases its admitted plan inside the owning kernel entry; a fatal Wasm
failure does not attempt reentry. Builder iterator cleanup also cancels, using
an exact owner so an abandoned older iterator cannot cancel a newer export.
The additive cancellation export is batched into ABI 55; a host requiring it refuses
an older kernel's export operation before starting a plan. Component limits and
plan cleanup are not aggregate process-memory acceptance.

The separate RXPT metadata stream traverses the mounted tree with an iterative
stack and one reusable path, both admitted against the ordinary I/O allowance.
It retains only an entry-count/length summary between reads, not an encoded
namespace. Each requested range is preflighted before output is touched;
EOF, reset and cancellation release stream authority. This requires the
existing quiescent-export gate: the summary is not a concurrent snapshot of
arbitrary mutations. Lazy-entry enumeration uses the same borrowed traversal
and writes its existing wire format directly into caller memory after
preflight, including size probes and short-output checks. Returned journal
metadata and archive payload copies carry I/O admission with their owners.
These native bounds do not admit the host's decoded JavaScript object cohort.

Resizable journal recovery validates its complete proposed namespace using
virtual inode indices before planning physical arena slots. Only base inodes
with no remaining names, open handles or mapping pins can supply reclaimed
slots. Live base inode indices remain stable. The admitted slot plan reserves
only genuinely additional capacity and supplies the same mapping to staged
FIFO records and namespace publication. After every fallible preparation and
name-credit admission succeeds, publication removes old names before reusing
their directory-parent slots, installs created inodes, and applies the mapped
namespace/link counts. A resource refusal before publication leaves the base
tree intact; it cannot authorize journal fallback or silently reset a computer.

Archive cohort verification borrows the binary payload's descriptor, group
and member fields. Group/member tables spend the ordinary I/O allowance;
canonical cohort identities feed SHA-256 incrementally instead of building a
second identity buffer. Sealing admits each encoded replacement and its
returned table before allocation, with reservations retained through return
and iteration. Archive registration also uses the borrowed codec and admitted
encoded output. Resource exhaustion reports `ENOMEM`, not an authentication
failure or an excuse to ignore a cohort. The wire format, canonical digest
ordering and distinction between malformed and unauthenticated payloads are
unchanged.

Manifest reads check the serialized file size before `text()` or `JSON.parse`.
A shared per-realm 64 MiB conservative metadata ledger admits parse/stringify
overlap across locked operations, with an 8 MiB per-input serialized bound.
The modeled charge is twelve times serialized UTF-8 bytes plus owner overhead;
actual allocator/RSS acceptance remains separate. A manifest can refuse
with `ENOMEM` below the per-file bound when its retained cohort or concurrent
overlap cannot fit. This refusal is not corruption and cannot select an older
generation. JSON serialization estimates escaped output before allocation,
rejects cycles, deep nesting, accessors and conversion hooks, and retains the
output's charge until its operation ends. The depth limit is 64. Canonical
saved-computer manifests reject obsolete per-chunk digest tables rather than
retaining or converting them. Returned positioned handles expose a
constant-sized integrity descriptor; bounded composition/URL metadata belongs
to their caller, not a retained image-sized chunk table. Saved computers use
positioned loading; the former resident saved-image compatibility API is removed.

Nonpersistent boots retain the in-memory transport path. Caller-owned closed
assets and custom fetch implementations can still allocate complete bodies;
the storage-call limit does not bound a fetcher's chunk allocation. Image
integrity descriptors, archive decoding, namespace metadata, recovery, and
export scratch still need complete aggregate accounting. Inactivity handling
is tested separately from storage-pressure
and sustained-workload acceptance; serialization is not a claim of improved
throughput. This transport change does not establish a whole-system memory bound.

Persistent hosts share a 30-second graceful shutdown deadline so queued
synchronous storage work, compaction retirement, process teardown and final
sync can finish before worker-realm fallback. Expiry is not an acknowledgement:
unconfirmed browser writer leases remain held, late acknowledgements cannot
authorize handoff, and reported sync failures remain visible. Nonpersistent
browser and Node machines retain their two- and five-second deadlines.

`NodeKernelHost` and `BrowserKernel` accept an optional `kernelMaxPages` to
lower the kernel's memory ceiling, in 64 KiB pages. It cannot raise the selected
runtime profile's ceiling; the Wasm loader still enforces the module's minimum.
This is separate from guest process memory and filesystem capacity. The shared
Node/OPFS capacity workflow reads a 96 MiB verified deferred file with a 64 MiB
kernel ceiling and an 8 MiB logical disk, preserving both free space and
deferred descriptions through reboot and checkpoint. Host transport and
closed-asset buffers are not covered by that kernel ceiling.

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

For resizable persistent browsers, host-managed TLS provisioning runs after
journal selection, recovery and any boot-time compaction, but before the worker
reports readiness. Missing certificate directories and replacement certificate
bytes therefore use the ordinary Rust journaled namespace and data paths,
rather than leaving an ephemeral regular inode in a persistent tree. The
managed certificate name is unlinked before replacement; this also handles
read-only or digest-bound deferred base certificates without fetching their
obsolete contents or weakening immutable-source checks. Sibling files remain
guest-owned and survive certificate rotation.

Optional TLS provisioning must not strand an otherwise usable full filesystem.
Only a native `ENOMEM` or `ENOSPC` followed by a successful persistence sync may
continue boot with a public host diagnostic that guest HTTPS may fail. A failed
sync, including a poisoned writer after an OPFS quota/flush failure, rejects
initialization. An errno alone cannot distinguish those cases. Other errors
remain fatal. The checked ancestor-creation helper preserves actual errors and
partial prefixes, allows resizable journals and still rejects fixed-overwrite
namespace mutation. These changes retain the ABI 55 export signatures.

Host directory and lazy-resource inspection copy native snapshots under the
shared host transport budget. Expected admission `ENOMEM` is captured inside
the serialized entry, before copying the refused chunk. The same inline
scratch lease then reads the same native producer at its terminal offset,
releasing the Rust snapshot and its I/O credit without rebuilding it. Only
after successful zero-length cleanup does the original resource error escape
outside the fatal-on-throw ingress. Prior copied-chunk credits release in the
operation's `finally`. Native traps, unexpected exceptions and failed cleanup
still fail the kernel generation. This preserves ordinary read, stat, retry
and durable-write behavior after resource refusal on both hosts; it does not
turn a poisoned persistence writer into a clean admission error.

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

### Dormant inode notification ownership

A separate kernel-private fsnotify owner retains bounded inode watches and
record queues. It is independent of the coalesced refresh hints above.
An internal FsNotify fd/OFD shares its real queue through dup, SCM_RIGHTS
and modern exec; whole-record reads and core poll/epoll consume that queue.
Actual tmpfs producers enqueue records without allocating after their
mutation. The already-integrated shared epoll candidate marker also avoids
allocation while propagating producer readiness. Host parked-waiter wake
publication is still missing; a candidate bit is not a channel wake.

Regular tmpfs descriptions retain their opened dentry through shared OFD
state while preserving inode-based data/mapping handles. Hardlinks keep
separate entry identity, rename moves the retained entry, and unlink or
replacement does not rebind old opens to a reused pathname. Real
open/read/write/positioned-I/O/ftruncate/final-close producers consume that
identity. These are partial source owners, not public watcher support.

All public inotify slots still return ENOSYS. Metadata/SIGIO, complete
watch policy, directory/rootfs/provider/mount and other operation producers,
precise ordering/deletion retirement, actual host wake and new-kind fork
inheritance remain implementation gaps. Version 20 tags 0–12/reader stay
unchanged; serialization preflights surviving internal FsNotify descriptions
and refuses them before Writer/fd/ref/child commit. Regular-file inheritance
uses the existing shared-state relink owner. No new tag or ABI 55/snapshot/
channel/libc change is made by this dormant composition.

See the [descriptor prerequisite](fsnotify-descriptor-prerequisite.md) and
[opened-dentry prerequisite](fsnotify-opened-dentry-prerequisite.md) for
source scope, the frozen 55 admission/fork activation decision and remaining
owners. The identified native component artifact passed 125 focused cases;
it is not an identified guest kernel or four-host acceptance. A fresh
identified kernel and guest validation remain necessary before claiming
public support, within the existing product-rebuild deferral.

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
Returned entry/name/target owners and encoded directory/URI snapshot caches
spend the ordinary I/O allowance. Encoders prepare capacity before appending
fields; only a complete snapshot is published, and EOF releases its backing
credit. Ordinary allowance exhaustion is reported, not shown as an empty
directory. Lazy-resource cohorts sort admitted borrowed URI references and
merge maximum declared sizes before copying the unique owned names. This
does not fetch bodies or change identities. Canonical namespace-resolution
scratch and JavaScript-side bookkeeping remain separate memory obligations;
these snapshots do not establish a whole-system peak bound.
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
`DEFAULT_MOUNT_SPEC: MountSpec[]`: `/` is the writable image, and `/tmp`
and `/run` are scratch mounts. `/var/run` links to `/run`.
`resolveForBrowser` and `resolveForNode` validate a spec and
return only the host-backed mounts that remain after the kernel's share is
removed. The only image mount a spec may name is `/`. The tmpfs's prefixes,
their root modes and owners (`/tmp` and `/dev/shm` `1777`, `/run` `0755`)
and their `nosuid`
come from `SCRATCH_MOUNTS` in `crates/runtime-core/src/tmpfs.rs`, not from the
spec; the spec keeps them for the host side
(`KERNEL_TMPFS_OWNED_PREFIXES` identifies the host-visible scratch entries).

Homes (`/home/maker` and `/root`), `/srv`, `/var/log` and `/var/tmp` belong to the root filesystem,
not to scratch mounts. Their initial directories, owners and permissions come
from the image (`MANIFEST` for the canonical rootfs). Their contents use the
same bounded caches and journal as other rootfs files on a resizable persistent
computer; a memory-only computer still loses its rootfs changes at shutdown.
These directories inherit rootfs mount flags, not the scratch mounts' `nosuid`.
This is default mount policy on both hosts, not a new syscall or storage ABI.
Existing guest binaries use ordinary file operations unchanged. An explicitly
configured foreign mount can still shadow a rootfs path on Node.

Boot copies image-owned directory metadata beneath `/run` into its fresh
tmpfs, preserving service and user directory permissions without restoring
files, sockets or symlinks. Nested kernel mounts keep their own layouts.
See [the filesystem layout](filesystem-layout.md).

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
`"default"` (the path used by the vitest suite), the host first resolves
`programs/rootfs.vfs.zst` through the binary resolver's selected architecture
and provenance policy. Only a missing registered artifact permits fallback
to the standalone `rootfs.vfs.zst` alias, which can resolve to
`host/wasm/rootfs.vfs.zst`. A present artifact rejected by policy, or an I/O
failure, is not permission to boot a stale alias. Whatever the caller supplies,
the host zstd-decodes
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

The bridge's whole-file `readFile` rejects lengths that do not fit its wasm32
buffer arguments with `EOVERFLOW`, rather than silently reading a low-word
prefix. Large files remain accessible through bounded `open`/`read`/`close`
operations with full-width positions. Image capacity is not a request to
allocate a file-sized buffer.

Builder handle writes now transfer at most 64 KiB into the Rust positioned
write entry point and return the actual count; they do not read, merge or
replace the old file in JavaScript. Builder helpers loop over partial progress.
Explicit image-builder set-ID modes are restored after a successful patch,
preserving the producer's existing metadata contract; guest writes still use
the kernel's ordinary set-ID-clearing rules.

The nonpersistent copy-on-write backend remains resident: materializing a
borrowed file must fit the native address space and available heap, or return
`ENOMEM` before replacing the borrowed inode. Writes at unrepresentable
resident-buffer offsets return `EFBIG`; reads beyond resident EOF return zero
instead of wrapping onto the low word. This is distinct from the persistent
overlay, whose positioned file offsets and logical sizes can exceed runtime
memory.

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

The file-export methods use a separately named synchronous borrowed-chunk
path on both hosts. One ordinary host destination is allocated after entry
admission and reused for the stream. Only `kernel-scratch.ts` can create its
opaque capability; callers cannot adopt a kernel, process or shared backing.
The lease validates its readable range and destination attachment before a
direct copy, then expires before the file/hash sink sees the ordinary prefix.
The sink must return synchronously without a value. Attachment is checked
again after the sink; detachment or sink failure aborts the export without
poisoning the kernel or publishing a replacement. Byte counts are captured
before callbacks, including callbacks that transfer owned chunks. The
original owned visitor and buffered export keep independent chunk ownership;
they must not be switched to reused backing. File export bounds payload
staging, not snapshot-plan or digest-list metadata.

The shared kernel adapter also reuses one cleared 64 KiB transport backing
across ordinary image, journal, index and compaction reads. Exact views use
captured intrinsic slots rather than caller-controlled species constructors;
no provider receives live Rust memory. Nested borrowing refuses before
changing the active window, and detached backing is replaced for retry.
Larger requests retain their existing fresh temporary allocation behavior;
this is not a bound on every possible host request. OPFS's clean-page reader
recycles at most 64 fixed 64 KiB backings, retaining a failed refill's backing
for retry without caching partial bytes. Its integrity verifier reuses one
1 MiB window across awaited digests. These ownership bounds avoid payload-sized
garbage accumulation during a synchronous export; they do not establish
whole-process RSS, metadata admission or performance improvements.

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
container (`crates/runtime-core/src/vfsi_container.rs`). Raw `.vfs` files
carry the same container without compression. Decompressed:

```
Offset   Size   Field
0        4      Magic: 0x56465349 ("VFSI")
4        4      Version: 1 or 2
8        4      Flags: bit 0 = lazy files, bit 1 = lazy archives, bit 2 = metadata,
                bit 3 = typed lazy archives, bit 4 = retired kernel lazy linkage (KLZY)
12       4      V1: filesystem body length (N); V2: header size (24)
16       8      V2 only: 64-bit filesystem body length (N)
H        N      KIFS filesystem body (superblock magic "KIFS"); deferred-file
                records live inside it in the SDEF section
H+N      ...    Optional trailing sections, each a 4-byte length and bytes:
                lazy-file JSON (bit 0), lazy-archive JSON (bit 1), image-metadata
                JSON (bit 2), and the retired KLZY section (bit 4, refused at load)
```

`H` is 16 for v1 and 24 for v2. The writer preserves v1 for bodies that fit
its 32-bit length and uses v2 only above that boundary. KIFS has a separate
superblock version: v1 addresses 10 + 1,024 + 1,024² blocks per file, while
v2 adds a triple-indirect pointer at inode bytes 124–127 and addresses another
1,024³ blocks. The writer keeps KIFS v1 unless a file exceeds its limit; a
VFSI v2 container may contain either KIFS version.
On dereference, the kernel rejects nonzero data and indirect pointers outside
the superblock's declared data-block range, so a damaged pointer cannot alias
filesystem metadata or a trailing section. This is a bounds check, not a
replacement for the staged image's whole-file integrity verification.
Malformed directory records and incomplete terminal records now return `EIO`
instead of silently omitting later names from a listing or lookup.
Snapshot export leaves unwritten blocks of new journal-backed regular files
unallocated in KIFS, so their logical size need not determine body size. The
kernel records sparse block maps for image-backed regular files during boot
and preserves their holes when exporting, including through journal changes.
Growing or truncating and re-extending an originally dense image-backed file
also leaves its new zero range unallocated in a composed snapshot.
Node can boot a decoded `.vfs` file through `NodeKernelHost.rootfsImageFile`:
the kernel worker owns a read-only, no-follow file descriptor and a bounded
64-page positioned-read cache instead of copying the image into an
`ArrayBuffer`. An optional staged-image integrity descriptor verifies every
chunk before boot. The byte-array and default compressed-image Node paths
still materialize their decoded images; external native writers can race a
file-backed boot unless the caller keeps the source quiescent.

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

The shared Node compatibility layer applies TCP client family selection above
these same sockets. It obtains real resolver records, alternates address
families, cancels intermediate attempts at their deadline, and closes failed
or late descriptors. TLS shares the dialing policy. It reads socket endpoints
from the kernel rather than deriving them from requested options. An IPv6
wildcard-bound client selects its concrete loopback source when connected,
including when it already reserved a nonzero local port, in both same-process
and cross-process routes. That correction changes socket state, not the
syscall layouts or ABI 55.

`dns.lookup` uses libc getaddrinfo; current hostname resolution still supplies
one IPv4 answer and lacks full hosts-file/IPv6 hostname support. These are
implementation gaps, separate from the transport's IPv6 loopback-only limit.
Node listening-server and several socket controls remain incomplete. See
[the core compatibility audit](../packages/registry/node-compat/README.md).

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

The conformance runners select `OfflineEgressBackend`: it exposes the same
guest internet interface as the browser while refusing external traffic.
It also owns all guest TCP listener addresses, preventing the Node host's
automatic TCP bridge from publishing them as physical host ports. Guest
loopback stays in the kernel. Separate offline machines may therefore listen
on the same guest port, including the allocator's initial ephemeral port
49152, without opening `0.0.0.0:49152` on the developer's computer. Ordinary
Node embedders that publish real host services retain their existing bridge.

### Browser

Browsers cannot create external raw TCP or UDP sockets. Local loopback and `LocalVirtualNetwork` sockets work because they are virtual sockets behind the POSIX layer. External browser networking currently uses HTTP-oriented backends:

1. **FetchNetworkBackend**: Buffers an entire HTTP request from the Wasm process, sends it via `fetch()`, and returns the raw HTTP response bytes. Works for simple HTTP clients.

2. **TlsNetworkBackend**: Terminates the guest's TLS connection with a generated, in-VFS CA and sends the decoded HTTP request through browser `fetch()`. Service-worker-controlled apps may proxy cross-origin fetches transparently. Other embedders set `BrowserKernelOptions.corsProxyUrl`; the option crosses the main-thread/worker protocol and routes backend fetches through the application's CORS proxy.

   The browser bridge deliberately declines TLS 1.2 session resumption.
   TLS 1.3-capable clients can send a nonempty legacy session ID even without
   an existing Kandelo session. Echoing it after selecting TLS 1.2 would
   falsely claim that the bridge found and resumed a cached session. The
   bridge retains no such master secrets or bounded session cache, so every
   guest connection completes a fresh local handshake. That handshake adds
   no network round trip. Browser `fetch()` owns the separate upstream TLS
   connection and may reuse it independently. Node's direct TCP backend is
   unaffected.

   The shared TLS engine awaits plaintext and encrypted stream writes.
   This preserves stream backpressure and delivers write failures to the
   owning reader or encryption pump, including when teardown closes an
   output stream during encryption.

3. **Service Worker HTTP Bridge**: For server demos (nginx, WordPress), a service worker intercepts browser `fetch()` requests to a configurable URL prefix (e.g., `/app/`) and forwards them to the kernel via a MessagePort connection pump. The kernel injects the request as a TCP connection to nginx's listening socket, and nginx's response flows back through the pipe to the service worker.

The injected HTTP pump is shared with Node's `fetchInKernel`. It retains a
request offset across short or zero pipe writes, wakes readers after accepted
bytes, and yields between attempts so the guest can consume the bounded TCP
pipe. Response draining proceeds alongside request delivery, including when a
server rejects a request before reading its entire body. One timeout covers
both directions; completion, timeout and ordinary errors close the host's
pipe ends. The caller's raw response byte ceiling is enforced before retaining
each response chunk. Request and response bodies are still buffered in full;
this is backpressure handling, not a streaming or whole-system memory bound.

One per-kernel admission gate now bounds injected HTTP work on both hosts.
It admits at most 16 active pumps, scaled down to one per MiB of the
profile-derived ordinary I/O allowance on smaller kernels, with a minimum
of one. At most 128 requests wait; queue time counts against the original
request deadline and an expired waiter never injects a connection. A full
queue fails explicitly. Raw request construction happens after admission;
the caller's original request/body can remain retained while waiting, so
the queue count is not a byte bound on caller-owned inputs. Injection
`ENOMEM` remains a real error and is not retried. Empty-response retries
release their previous permit first and share the remaining deadline.

Each injected connection currently charges two 64 KiB pipe buffers at twice
capacity against the same ordinary I/O pool as filesystem work. Unbounded
asset fan-out can therefore refuse connections even when overall system
memory remains available. The admission gate bounds active HTTP pumps, not
all TCP ingress or abandoned server-side backlog ownership after timeout.
Native cancellation of unaccepted connections and admission needed to drain
a pressured backlog remain separate acceptance work; increasing the pool is
not a substitute for either.
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
retired guest address space. Memory growth requires no UI rebind: the worker
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
  a download. The browser app opens an output of type
  `application/x-kandelo-terminal-command` as a terminal running the
  command it carries instead of offering it in its tray (see "Terminal
  requests" in `docs/browser-support.md`); that is the app's use of an
  output, not a platform behavior.
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
republishes unchanged producer/discard cursors: leaving their sequence locks
readable avoids silent quanta during idle relay ticks. If a new producer
publication overlaps rendering, the worklet can consume PCM up to its last
confirmed producer position within the current generation. Discard reads and
configuration/generation fences remain mandatory; reset invalidates that cached
bound. The relay never
advances playback; the worklet remains its clock. Audio demand reaches the UI
as a plain notification sampled in the kernel worker. Main is not the audio
clock and does not drain through a timer. At 48 kHz one render quantum is about 2.7 ms; browser
device `baseLatency`/`outputLatency` is additional and platform-dependent.
The browser host's demand-driven preparation leaves the worklet
unattached at kernel ready until native generation/state records guest audio
activity. A user gesture can prime and resume the shared context first, with
no kernel backing passed to a processor; later demand binds the normal sink
to that same context. Explicit preparation remains immediate. This preserves
browser activation separately from transport ownership and does not change
Node's clocked sink or native PCM semantics. Unused primed contexts can shut
down without a nonexistent processor acknowledgement; attached processors
still require exact detach. Module preparation has a bounded close wait,
terminal late continuations and context quarantine. Neither the module-load
activation nor public Promise-returning wrappers retain a descriptor across an
unresolved await.
After machine teardown drains the shared ring, driver close first refuses new
audio control operations and bounds settlement of admitted context transitions.
Resume and suspend each retain at most one in-flight operation; stale
continuations cannot reopen a closed driver. A still-pending transition blocks
reuse of the page-shared audio context. A missing processor detach acknowledgement
blocks subsequent shared audio attachment until reload. Both failures are
reported, but neither retains kernel memory through the independent PCM mirror,
so neither blocks replacement kernels or independent persistent-storage shutdown.
The connected processor is asked to detach before context suspension, so the
acknowledgement does not depend on post-suspension scheduling. A running
browser context is then suspended to hand already-rendered blocks to the
output device and retained for a bounded base/output-latency-plus-quantum
settlement interval. A page-shared
context survives machine switches for the suspected runtime defect recorded in
[`WEBKIT-AUDIOWORKLET-CLOSE-LEAK`](../tests/runtime-workarounds/WEBKIT-AUDIOWORKLET-CLOSE-LEAK/entry.md);
an explicitly supplied private context is closed. Before disconnecting its node
and closing the message port, the driver waits for the processor to clear both
mirror views, close its kernel connection and acknowledge detach. Later render
callbacks return false. Disconnecting alone does not end a source processor
that keeps returning true. The independent mirror bounds retained wrappers
even before collection in the persistent worklet realm.
Detach is bounded; a missing acknowledgement is reported, not proof of release.
Storage acknowledgement remains a separate ownership fact.
Preparation retains the node immediately after construction. A later connection
failure must retire that owner too; a missing detach acknowledgement cannot be
hidden by forgetting the node. State observers cannot interrupt ownership
transitions. Closing during module loading prevents subsequent node construction.
Teardown never resumes a suspended or interrupted context, preserving the
browser's user-activation boundary. Host memory admission and actual process
memory validation must still include this cross-realm transport ownership.
Native resume is requested on the trusted-gesture stack even while worklet
module preparation is pending. The render thread makes at most eight attempts
per split 64-bit cursor read; an unstable or abandoned odd sequence yields
silence for that quantum without advancing consumption. It must not spin
forever and prevent terminal detach messages from being serviced. Settled
cursors permit playback on the next quantum. This prevents an independently
reproducible worklet hang class, not proof of the cause of an application
checkpoint's missing acknowledgement.
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

Kernel BO references, not the host mapping inventory, own DRI pixel
backing. Unmapped PRIME imports and selected cursors retain storage after
the allocator exits. Normal OFD close and process removal share the same
DRI release collector: kernel references retire synchronously, then the
owning adapter drains final BO, framebuffer, GL, and master notifications.
Failed spawn rollback drains those effects too. Spawn counts inherited
cursor references alongside GEM handles and framebuffers.

The worker's DRI registry merges changed byte runs relative to a private
snapshot of each mapping. It uses the same merge primitive as anonymous
`MAP_SHARED` publication. Allocator and importer writes both publish at
mapping, readiness, texture submission, and cursor/scanout presentation
boundaries; unchanged readers do not overwrite newer bytes. Refreshing a
reader also refreshes its snapshot. A pending reader remains eligible for
refresh after the last writer unmaps, exits, or replaces its address space.
This remains boundary synchronization,
not live aliasing between Wasm memories. A snapshot is bounded by the
mapping length and BO size and retired with its mapping; backing is retired
only by the kernel's final-reference destroy notification. GPU textures
follow that same destruction event. All guest mappings and snapshots stay
inside disposable workers. No guest ABI layout or import is changed.

The host's independent display statistics buffer publishes the current
DRM master PID in slot 8 (zero when unowned), alongside presentation and
scanout counters. The dedicated kernel worker snapshots this state on
vblank even when no framebuffer is bound. Node stats-only consumers and
browser canvas consumers observe the same owner; no guest memory is
exposed. This is host display metadata, with no kernel/guest ABI change.
Browser presentation uses ownership to hand an exited graphical
application back to its terminal while retaining the display capability
and canvas sizing for subsequent applications.

This section is the implementation walk-through; [Linux-compatible graphics devices](#linux-compatible-graphics-devices) states the device-level contract.

`crates/runtime-core/src/syscalls.rs` (with the buffer registry in `crates/runtime-core/src/dri/`) handles DRM_IOCTL_VERSION, GET_CAP (`DUMB_BUFFER`, `PRIME`, and 64×64 cursor dimensions report support after host negotiation; every other capability reads 0), SET_MASTER / DROP_MASTER, MODE_GETRESOURCES, MODE_GETCONNECTOR, MODE_GETENCODER, MODE_GETCRTC, MODE_SETCRTC, MODE_ADDFB2 / RMFB, MODE_PAGE_FLIP, WAIT_VBLANK, GEM_CLOSE, PRIME_HANDLE_TO_FD / FD_TO_HANDLE, and the dumb-buffer create / map / destroy path. `MODE_CURSOR` / `MODE_CURSOR2` provide one virtual cursor plane. There is no general plane, property or atomic interface (no MODE_GETPLANERESOURCES, OBJ_GETPROPERTIES or ATOMIC), no legacy ADDFB or DIRTYFB, and any other DRM request fails with `ENOSYS`; `docs/plans/2026-09-30-real-hyprland-port-inventory.md` lists what a Hyprland- or wlroots-class compositor would need beyond this. Programs compiled against the upstream `libdrm` (vendored under `packages/registry/libdrm/`) link cleanly; SDL2's KMSDRM backend uses the same DRM interfaces. `host_kms_mode_info` returns a mode flagged PREFERRED so KMSDRM's mode-selection loop picks it up. When the embedder has reported the display pane's device-pixel size (`setKmsDisplaySize`, fed by the Modeset pane's ResizeObserver), the mode follows the reported pixel dimensions, even-aligned and clamped to [640, 3840] × [480, 2160], so a mode-picking client (wlcompositor, SDL2 KMSDRM) fills the pane with no letterbox; without a reported size (Node hosts, headless) it stays the historical 1920×1080@60. The preferred mode is sampled per GETCONNECTOR call and clients generally cache it at startup; resizing the pane afterwards changes presentation rather than switching the guest mode. The kernel also advertises 17 standard 60 Hz modes from 640×480 through 3840×2160, deduplicating the preferred size. Only the host-provided first mode is preferred. Both hosts expose this same catalog through the existing DRM ioctl, without a new host import or ABI layout. A count query reports the full list length; an undersized modes buffer is left untouched so libdrm can retry. The guest can switch modes using ordinary SDL or libdrm APIs, and the browser fits the selected scanout with letterboxing. The connector-id parameter is plumbed through but v1 advertises a single connector. `libc/glue/libgbm_stub.c` implements a 2-BO scanout ring (lock_front_buffer / release_buffer / has_free_buffers / destroy) on top of the dumb-buffer surface so KMSDRM's swap chain has somewhere to hand off frames. The `libEGL.a` / `libGLESv2.a` stubs (in `libc/glue/`) route GLES commands through the `/dev/dri/renderD128` cmdbuf to the host's WebGL2 bridge.

`DRM_IOCTL_WPK_BIND_FOREIGN_TEXTURE` (a WPK extension, `'d'` nr `0xE1`) bridges the two tiers: it (re)uploads a CPU-tier bo's current pixels into a `WebGLTexture` in the calling fd's GL context — the host reads the bo's canonical SAB storage directly, so window-sized textures never squeeze through the 64 KB-capped cmdbuf TLV records. The bo handle and the GL session must live on the same fd; `libEGL` exposes the flow as `wpkEglImportDmabufHandle(prime_fd)` (PRIME import on the EGL fd) + `wpkEglBindBoTexture(handle, GL_TEXTURE_2D)` (idempotent per bo; re-call to refresh after the producer commits). Texture lifetime is tied to the bo: the last GEM_CLOSE deletes it.

`DRM_IOCTL_WPK_CREATE_GPU_BO` (`'d'` nr `0xE0`) is the fully GPU-backed tier: the bo is a host `WebGLTexture` plus a color-attachment FBO — no SAB, unmappable on the CPU. WebGL textures are not shareable across contexts, so all GPU-tier bos and every GL client that touches them live on **one** shared multiplexer context: the DRM-master compositor's scanout WebGL2 context. A non-master GL client (which has no display canvas of its own) is routed onto that shared context at `host_gl_create_context`; the existing `GlMuxer` (keyed by the WebGL2 context) multiplexes the compositor and its clients by replaying each binding's shadow state on `switchTo`. A client renders into the bo by targeting its FBO: the bo handle reaches the next `eglCreateWindowSurface`'s `GLIO_CREATE_SURFACE` either explicitly (`libEGL`'s `wpkEglSetWindowSurfaceTarget(handle)`) or, for a libwayland-egl `wl_egl_window`, from the bo that window allocated; the kernel translates the per-fd handle to a global bo id and the host redirects the client's "bind default framebuffer 0" to the bo's FBO (sizing the viewport to the bo). Because a toolkit may create the window surface *before* the GL context, the redirect target is captured at surface creation and (re)applied at whichever of context-creation or surface-creation runs last, since it needs both `b.gl` and the resolved bo. A `wl_egl_window_resize` (a tiling compositor resizes every window it maps) gives the window a new bo at the new size and has `libEGL` destroy and re-create the window surface against it, flushing first so commands already queued land in the old bo; the old buffer is destroyed only after the next `eglSwapBuffers` has attached and committed its successor. As in Mesa, the resize takes effect from the next frame. `eglSwapBuffers` flushes the shared context as the buffer-ready fence before `wl_surface.commit`; command order through the one submit queue gives render-before-sample ordering for free (no explicit sync object in v1). `BIND_FOREIGN_TEXTURE` on a GPU-tier bo then degenerates to returning the texture id — true zero-copy, no upload. Allocation degrades to a CPU-tier dumb bo whenever no shared context exists — headless Node has no WebGL2, and in the browser the compositor must have created its context first — so `libgbm` only requests the GPU tier for render-only bos (RENDERING set, none of SCANOUT/CURSOR/WRITE/LINEAR) and falls back to CREATE_DUMB on any error. This producer path is browser-only. Each GPU-tier bo's FBO has color, 24-bit depth, and 8-bit stencil storage, so default-framebuffer depth testing and stencil clipping work for Wayland clients as well as canvas-backed sessions.

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
matching [Linux's legacy cursor layout](https://github.com/torvalds/linux/blob/v6.6/drivers/gpu/drm/drm_plane.c#L959). Showing a cursor retains its buffer independently
of the application's GEM handle. Hiding it, dropping master, or closing
the owning card descriptor releases that reference. Exec retains it;
fork children do not inherit the parent's cursor ownership. The internal
fork-state encoding is version 19, produced and consumed by one kernel
build. The new ioctl descriptions are additive under ABI 50.

DRM cursor positions locate the image origin. Signed hotspot values are
virtualization hints and do not offset the image, following the
[Linux cursor contract](https://www.kernel.org/doc/html/v6.6/gpu/drm-kms.html).
SDL's KMS backend converts pointer coordinates to image coordinates on
motion, warp, and shape changes. This keeps nonzero-hotspot cursors aligned
without changing DRM semantics for other clients.

Cursor transport adds no required Wasm import. The optional
`kernel_kms_cursor_configure(version)` export accepts protocol 1 and returns
1, or negative `ENOTSUP` for unknown versions. Until negotiation, cursor
capabilities report zero and valid master cursor requests that reach the
kernel fail `ENOTSUP` before retaining a buffer. An older host adapter can
reject the unknown ioctl earlier with `EINVAL`; the zero capability is the
supported way to detect the unavailable plane. Both Node and browser hosts
negotiate support;
a visible display is not required. The two cursor exports are optional in
ABI 50 and become required in ABI 51 through the export lifecycle table.

`kernel_kms_cursor_read(out, capacity)` returns 0 when unchanged, 32 after
copying one complete state, or negative `EINVAL` for invalid output. Its
32-byte protocol-1 record contains eight little-endian words: owner PID,
buffer ID, width, height, signed x/y, and signed hotspot x/y. Image and
motion requests coalesce without losing the image; dropping master clears
pending state before its buffer can be reused. The host drains this state
inside the existing vblank kernel entry before reading pixels, using a
scratch lease and owned copies. Records from retired owners are discarded.
Older kernels without the exports remain loadable by new hosts.

`KmsRegistry` refreshes the packed cursor image from its producer mapping
at vblank, using the shared GBM coherence boundary. It retains an owned
RGBA snapshot until pixels change; position-only updates reuse it. The
copy is bounded to the cursor image rather than the allocation size.
The worker composites this state
on a separate transparent canvas at vblank, independently of CPU, GPU,
or application-owned scanout. It never reads live guest memory during
that detached presentation phase and never exposes a partially drawn
application frame. Node retains the same state without a canvas.

Host address-space retirement distinguishes exec from process exit. Exec
flushes and removes old buffer mappings but retains buffer ownership and
DRM master state for open descriptions the kernel kept. The replacement
can map a retained handle into its new memory and recover its pixels.
Kernel close-on-exec and final-reference callbacks still destroy buffers
and release master state; trap/exit cleanup retains its process teardown
backstop. Both Node and browser use this same path.

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

`MODE_PAGE_FLIP` latches the new framebuffer as the host-side scanout immediately (`host_kms_set_fb`, same call `MODE_SETCRTC` makes) and queues a flip-complete event that `kernel_vblank` — driven by the host's 60 Hz vblank pump — retires into the fd's event ring at the next tick. Two consequences: libdrm's `drmModePageFlip → poll → drmHandleEvent` loop runs at refresh rate rather than ioctl rate, and any host-side consumer of the current scanout (the vblank pump's WebGL2 scanout presenter or the legacy 2D canvas blit used by CPU-rendered demos) always reads the most recently flipped buffer, never a double-buffered client's back buffer. The immediate latch is race-free because a well-behaved client fully paints a bo before flipping to it and only reuses the old bo after the flip-complete event.

## Wayland compositor (`wlcompositor`, `wlterm`)

On top of the DRM/KMS + evdev surfaces above sits a real Wayland stack that runs entirely in-kernel — no host-side Wayland. `programs/wlcompositor/` is a Wayland server (a desktop machine's launcher script, `wldesktop` or `omarchydesktop`, starts it in the background and waits for its socket) built against a wasm32 port of `libwayland-server`: it owns the `card0` scanout (via the same KMSDRM/`libgbm` path SDL2 uses), reads input from `/dev/input/event0` (keyboard) and `event1` (pointer) through a real `libinput` 1.25.0 port, and exports the core protocol plus `wl_shm`, `xdg_shell`, `wl_seat`, `wl_output`, `zwp_linux_dmabuf_v1`, and `wp_presentation` (clock_id `CLOCK_MONOTONIC`; `presented` feedback carries the PAGE_FLIP timestamp, refresh interval, and flip sequence — the frame-pacing signal `foot` and other upstream clients consume), plus the logical-output/scale surface GTK3, Waybar and mako query: `wl_output` at v4 (`name`/`description` — mako binds v4 unconditionally), `zxdg_output_manager_v1` (v3; the single virtual output at (0,0), logical size = the mode), `wp_fractional_scale_manager_v1` (fixed `preferred_scale` 120 = scale 1), and `wp_viewporter` (per-surface crop + scale, honored by both compositing paths — nearest-sampled in the CPU blit, a uv sub-rect on the GPU quad; gated by `host/test/wlcompositor-protocols-smoke.test.ts`). Clients connect over a Unix socket at `/tmp/wayland-0` (`/` is a read-only rootfs and `/var/run` is `EACCES` for non-root, so the well-known runtime dir is `/tmp`). Buffer sharing is zero-copy: clients allocate `wl_shm` pools backed by `gbm` dumb BOs and pass the prime-fd to the compositor via `SCM_RIGHTS`. The same prime-fd can also arrive over `zwp_linux_dmabuf_v1` (advertised at version 3, `XRGB8888`/`ARGB8888`/`XBGR8888`/`ABGR8888` + `LINEAR` only, no feedback; a GL client's buffer from `libwayland-egl` is `XBGR8888`, because a WebGL RGBA texture stores `[R,G,B,A]` bytes, and the compositor samples it without the red/blue swizzle it applies to `XRGB8888` `[B,G,R,X]` buffers): `zwp_linux_buffer_params_v1.add`/`create[_immed]` wrap the plane fd in a synthetic single-ref `shm_pool` so the resulting `wl_buffer` reuses the exact `shm_buffer` import/composite/destroy path — for a GPU-tier bo the downstream `BIND_FOREIGN_TEXTURE` is zero-copy. Compositing is GPU-first: at boot the compositor probes the renderD128 GLES bridge (shader compile via sync queries — they fail cleanly on hosts without WebGL2) and, when available, imports each client bo as a texture (`wpkEglImportDmabufHandle` + `wpkEglBindBoTexture`, re-bound only for buffers dirtied by a commit) and renders wallpaper + z-ordered window quads + focus border in a single cmdbuf flush per frame; its GL context claims the CRTC canvas and the vblank pump's presenter stands down. Without GL (Node smokes, `WLC_NO_GPU=1`, or a runtime failure — which also terminates EGL so the pump presenter resumes), it falls back to importing with `gbm_bo_import` and CPU-blitting into the scanout buffer. A lost WebGL2 context (a browser GPU-process crash) enters the same degrade chain through the present path: `host_gl_present` returns `-EIO` when the canvas context reports `isContextLost()`, `GLIO_PRESENT` propagates the errno, the guest's `eglSwapBuffers` fails, and the compositor's repaint falls through to the CPU path and terminates EGL — no guest-side context-loss API is needed. Either way it keeps committing PAGE_FLIPs as the frame clock. Keymaps are compiled with a wasm32 `libxkbcommon` port and handed to clients as an mmap'd fd over `wl_keyboard.keymap`.

Kandelo-authored clients build on `libkwl` (`examples/libs/libkwl/`), a small toolkit over `libwayland-client` that wraps registry bind, an `xdg` CSD toplevel, double-buffered `wl_shm` back buffers, xkb keysym/UTF-8 translation, and a `kwl_dispatch` event loop; it exposes `kwl_display_fd()` so an app can `poll` the Wayland connection alongside its own fds. Drawing goes through `libwpkdraw` (`examples/libs/wpkdraw/`), a CPU rasterizer (alpha-blended clear/pixel/rect + an `stb_truetype` font engine over a bundled Inconsolata) that renders into a caller-owned ARGB buffer. `programs/wlterm/` is the first real client: a terminal that `forkpty()`s `sh` (bash, which every Kandelo image binds to `/bin/sh`), runs an in-tree VT100 core (`vt100.c`), and multiplexes the Wayland display fd and the PTY master fd in one `poll` loop — Wayland key events become PTY writes, PTY output feeds the VT100 grid and is rendered back into the libkwl window. Because `wlterm` forks, its wasm is mandatorily processed by `wasm-fork-instrument` (see [fork-instrumentation.md](fork-instrumentation.md)).

The terminal core honors VT100 scrolling margins (`CSI top;bottom r`),
including line feeds, delayed wraps, index, next line, and reverse index.
Only the selected region moves; fixed rows such as an editor's status line
remain intact. Valid margin changes home the cursor, invalid bounds are
ignored, and resizing restores full-screen margins. This is terminal behavior,
independent of the child program or package. The existing limited terminal
subset (including no alternate screen or VT100 line-drawing set) is unchanged.

The stack is dual-host: the Node smoke gates (`host/test/{wpkdraw,libkwl,wlcompositor,wlterm,wldesktop,wldesktop-liveness}-smoke.test.ts`) drive compositor+client harnesses (two-process for the single-client gates, compositor + wlclock + wlpaint for the desktop gates), and the browser demo (the `wayland` machine in the shell image, declared in `packages/registry/shell/source-rootfs-shell-demo.json`, listed in `apps/browser-demos/pages/kandelo/gallery-roster.json`, and gated by `apps/browser-demos/test/kandelo-wayland.spec.ts`) boots the compositor plus three clients — `wlclock` (animated clock), `wlpaint` (pointer painting), and `wlterm` — against `card0` mirrored to an `OffscreenCanvas`, with DOM keyboard input injected as evdev events and the pane's pointer bridge feeding `event1`. This is the same KMS-to-canvas + `BrowserInputSource` path the `modeset` and `sdl2` demos use. The pane opts into the vblank pump's WebGL2 scanout presenter (`mode: "webgl2-scanout"`: scanout-to-texture upload with shader-side XRGB→RGB swizzle, change-driven presents gated on the kernel commit count plus a ~15 Hz content-probe backstop, and GPU scaling at the pane's device-pixel resolution); in the browser the compositor's own GLES context then claims the canvas for GPU compositing (`markKmsCanvasGlOwned` — the presenter stands down, stats slot 7 flips to 3/`webgl2-gl`), while headless/Node runs stay on the CPU-composite + presenter pipeline. A legacy `mode: "2d"` putImageData blit remains available. See [browser-support.md](browser-support.md#wayland-desktop-demo).

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

These are entirely in-kernel (client↔compositor over the wayland + `/tmp/kwlctl-0` sockets) — no host-runtime change — and gated by `host/test/wlcompositor-{tiling,resize,kwlctl,keybind,decoration,clipboard}-smoke.test.ts`. The browser's Hyprland machine (the shell image's `hyprland` profile, whose `/usr/bin/hyprdesktop` launcher sets `WLC_LAYOUT=dwindle` and `WLC_CONFIG=/usr/share/kandelo/hyprland/wlcompositor.conf`; gated by `apps/browser-demos/test/kandelo-hyprland.spec.ts`) boots the same compositor plus a `wlclock` and two `wlterm` terminals, which tile into gapped borderless frames and resize into their tiles — the first end-to-end Hyprland-class desktop. `wlpaint` is in the image but not started, so the `Ctrl+P` launch bind summons it on demand. See [browser-support.md](browser-support.md#hyprland-tiling-demo).

### Desktop shell (`zwlr_layer_shell_v1`, `kbar`, `klauncher`, themes)

A tiling WM is not yet a desktop: a desktop also has a bar, a launcher, and a
theme. Those are ordinary Wayland clients, but they need a protocol that lets a
surface anchor to an output edge and reserve space from the windows — which is
what `zwlr_layer_shell_v1` is, and what Quickshell, Waybar, mako and every
other shell component speak. The compositor implements it (protocol XML
vendored at
`packages/registry/wayland-protocols/xml/wlr-layer-shell-unstable-v1.xml`),
and the in-tree clients below consume it. This is the **O1** milestone of
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
(`packages/registry/foot/`) is the first **unmodified upstream** Wayland
client: stock `wl_display_connect()` (via `XDG_RUNTIME_DIR`), stock
xdg-shell/SSD negotiation, and a real font pipeline. Two declared patches are
the entire delta, both kernel-model boundaries rather than feature edits:
`0001` allocates its `wl_shm` pools as `gbm` prime-fd dumb-bos instead of
memfds (written when a memfd `MAP_SHARED` mapping never converged across
processes, so the compositor would have composited stale bytes; the kernel
now keeps memfd mappings coherent at syscall boundaries, so this patch is a
candidate for removal), and `0002` serializes
its font loading (concurrent `FcFontMatch` garbles pattern doubles under the
kernel's thread model — any future threaded font consumer hits the same wall).
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

Gated end-to-end by `host/test/foot-smoke.test.ts` (foot on wlcompositor:
connect, fontconfig+fcft startup, first composited frame through the gbm pool
path, keys typed into its forked `dash`, clean exit). In the browser, foot is
a launcher entry of the Omarchy machine — a lazy binary at
`/usr/bin/foot`, with the desktop's `fonts.conf` and Inconsolata under
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

The GLES bridge exposes a GLES2 API over WebGL2. Operation-table version 2
adds commands while preserving version 1 tags and payloads. `GLIO_INIT`
accepts versions 1 and 2, and rejects zero or newer versions with `ENOSYS`.
Its version and extension strings describe that API. Extension queries carry
an optional operation-table version: legacy requests retain their empty list,
while version 2 advertises bridged capabilities. Optional float rendering and
filtering extensions appear only when the host enables them. Uniform
reflection, vector/matrix uploads, indexed draws, texture updates and
depth/stencil operations use the same command/query path as other programs.
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
The multiplexer restores masks, stencil operations, clear values, constant
vertex attributes and texture bindings when switching guest contexts. Node
hosts without WebGL2 cannot render these sessions; no software simulation
stands in for the native LÖVE renderer.

The user-space libraries are sysroot libraries, not kernel build outputs:
`scripts/build-musl.sh` installs the headers, resolves the `libdrm` package
into `sysroot/lib/libdrm.a`, and builds `libgbm.a`, `libEGL.a`, and
`libGLESv2.a` from `libc/glue/`, plus matching pkg-config files. `libdrm` is
upstream 2.4.120, KMS subset only — the kernel implements enough of the
`DRM_IOCTL_MODE_*` surface for unmodified upstream sources to drive it.
Packages that depend on these APIs link through `wasm32posix-pkg-config` and
declare their resulting program artifacts as packages. The `modeset` demo is
one such package: its VFS image installs `/usr/bin/modeset`, and
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

### Original Node buffer allocation ownership source

The source146 candidate routes queued filesystem and codec operations through
allocation owners that retain each original offset and length across changes
to the JavaScript view. Scalar/vector I/O captures before request initialization;
WriteFileJob captures after initialization and copies only resizable stores.
The actual USER_OWNED shell producer transfers deallocation authority only
after the private engine link commits. GC retires its cell charge before the
last native owner may free the allocation on a worker. No rooted JS view is
substituted for native deallocation ownership.

The shared-buffer header retains the engine's actual array-buffer alignment
even when native ownership metadata changes its member layout. Its class
alignment keeps the immediately following data aligned without guessed target
padding. The original allocation assertion, size arithmetic and ownership
fields remain intact. The source157 targeted engine compile exposed this
layout defect; the source158 correction still needs production compilation.

Focused native-component and frontend controls pass with explicit dependencies.
The combined engine, actual GC/realm behavior and four-host conformance remain
unvalidated; UDP/socket consumers and shared-codec races remain separate gaps.
See [original backing allocation scope](../tests/nodejs/outline/original-backing-consumers-integration.md).

Synchronous crypto byte consumption separately roots checked actual storage,
enters its owner realm and borrows through nonallocating public data readers.
Async random work captures the original allocation capability before init
hooks and retains it through work; completion does not redirect into the
current JS view. Production JSAPI, GC/realm/work/cancellation and four-host
behavior remain unvalidated. See [crypto byte-source scope](../tests/nodejs/outline/crypto-byte-source-integration.md).

### Recursive Node copy source ownership

The source147 candidate installs pinned public recursive-copy algorithms
over real POSIX directory traversal, descriptor copies and a native CpDirJob
worker owner. Scheduled jobs retain their actual resource and path state;
inactive jobs remain collectible. Cancellation retires real work without
claiming filesystem rollback. The normal adapter, bootstrap and package
staging own these routes.

Native/component evidence retains a recovered-callback mismatch: the component
misses the target after hook. Shared uncaught recovery remains an implementation
gap. Current SpiderMonkey/GC/realm/guest and four-host conformance are unvalidated.
See [recursive copy scope](../tests/nodejs/outline/copy-directory-integration.md).

### Runtime-owned Node default locale source

The source148 candidate exposes a private locale provider over the engine's
actual original default identifier and ICU canonicalization. Bootstrap captures
initialization state before user code; later reads observe explicit native
set/reset. The original and normalized runtime strings have transactional
allocation, ownership and retirement, with independently owned caller copies.
Public mutable Intl and later process.env changes do not supply this state.

The existing Mozilla ICU77 sources supply the required headers and static link
dependencies. Actual-header compilation and scoped native/frontend controls
pass; the combined guest engine, ICU77 runtime behavior and four-host evidence
remain unvalidated. CPU topology/capacity and measurements remain implementation
gaps. See [default locale scope](../tests/nodejs/outline/default-locale-integration.md).

### Native Node execution and exception ownership source

The source149 candidate shares one native execution-stack owner across native
callbacks and JavaScript task scopes. Actual resource/context roots, IDs and
allocation claims remain alive through uncaught handling. Clear epochs prevent
late callback/job restoration from resurrecting cleared state. Outermost
callback errors use the owning process handler; nested synchronous failures
remain catchable. Recovered errors use the pinned after-hook draining algorithm
instead of taking the normal successful-callback checkpoint path.

Portable native and scoped frontend controls pass with explicit dependencies.
Production SpiderMonkey/GC/realm/loop and guest recovery remain unvalidated;
fatal getter/reentry, startup IDs and Promise-policy gaps stay open. See
[execution and recovery scope](../tests/nodejs/outline/callback-recovery-integration.md).

### Native Node process signal source ownership

The source162 main environment owns real signal dispositions and a
nonblocking self-pipe. First/last public listener transitions start and close
native SignalWrap watches; callbacks enter through actual native async scopes.
Workers do not acquire this main-only authority. Generated conditional signal
names use the real target header values when compiled.

Legacy Promise completions checkpoint before signal JavaScript, and stopping
prevents further timer callbacks. Roots, pending records and close retirement
remain actual native ownership. Existing custom/coverage dispositions still
conflict with EBUSY; this is an implementation gap. The production JSAPI and
four-host behavior remain unvalidated. See [signal integration scope](../tests/nodejs/outline/process-signals-integration.md).

### Node stdio stream source candidate

The Node compatibility source now routes process stdio through
third_party/node-core/fd-stream-platform-adapter.js and the pinned stream
state machines. Native fd writes own bytes through partial-write/readiness
completion; Writable owns queue/HWM/drain/callback state above that seam.
Native read requests remain exact Promise-identified owners, and Readable
owns buffered input/encoding/EOF. Pause retires the pending read without
closing a reused numeric descriptor; ref state applies to actual requests.
The target's unchanged stdout/stderr dummyDestroy keeps process-owned fds
open while preserving stream close observation and subsequent use.

This is an unbuilt guest source candidate shared by all four hosts. Native
pipe/file controls cover the JS owner route, using real native engine and
I/O dependencies rather than the guest fd watches. Exact public Socket/
TTY/file subclasses, type-specific descriptor adoption/close policy,
terminal modes/window/signal routing, native error/async lineage/EINTR and
inherited-descriptor nonblocking/readiness behavior remain implementation
and validation work. It does not alter the host/kernel wire ABI or prove
four-host runtime conformance.

The source161 stdio candidate also owns verified reopened slave-terminal
output descriptions. Real descriptor duplication preserves public stdio
numbers; only the independent extra descriptor is closed. Blocking status and
synchronous write completion are actual OS operations, leaving Writable to
report backpressure. Terminal leases and original views are checked/rooted
before bounded source-realm/no-GC access. Master/unreopenable paths retain a
known async/backpressure gap; public TTY classes and production JSAPI/four-host
conformance remain open. See [terminal output scope](../tests/nodejs/outline/tty-output-integration.md).

The source163 terminal followup binds size/resize queries to the same opaque
output owner as writes. Closing/reusing the public fd cannot redirect that
owned terminal's geometry. Same-number reopen results are promoted to a
separate descriptor before duplication and teardown. Native descriptor/header
controls cover these transitions; production JSAPI, guest dup3, master fallback
and broader TTY behavior remain unvalidated or incomplete.

### Node HTTP/2 settings source ownership

The HTTP/2 settings source now has a standalone protocol owner for
getDefaultSettings/getPackedSettings/getUnpackedSettings, source-derived
protocol constants and the genuine sensitiveHeaders symbol. It reuses the
pinned Node validation/default/unpacking algorithms, private Buffer numeric
and unpooled allocation owners, and Node/nghttp2 settings layout, ordering
and validation. It supplies actual six-byte settings payloads without
creating pretend sessions or transport capabilities. See
[the source boundary](../third_party/node-core/http2-settings.md).

This remains a partial module. Connect/server/handshake/compatibility
constructors and returned sessions/streams, HPACK, ALPN/TLS, frame I/O,
flow control and asynchronous lifecycle remain implementation gaps. Focused
native-dependent controls do not establish production guest/four-host
conformance or a complete http2 namespace shape.

### Native Node TCP and plain Agent source ownership

The source160 TCP owner retains actual descriptors and original write
allocations through callback and close transitions. Accepted descriptors are
leased before fallible publication and transfer into the actual socket owner;
rollback closes that owner rather than releasing a stale numeric descriptor.
Private read slots, shared realm prototypes and the native execution stack
own callback/resource identity. Accepted AsyncWrap init timing remains a gap.

Pinned plain HTTP Agent algorithms share these socket owners. Request timeout
reset occurs on reusable sockets, after close-policy decisions. Source and
native-component evidence do not validate production JSAPI/guest networking
or four-host behavior. See [TCP and Agent scope](../tests/nodejs/outline/tcp-agent-integration.md).

### Node message-port source candidate

The proposed Node message transport owns synchronized entangled endpoints in
third_party/node-core/port-queue.h. Its queue orders actual serialized packets
and peer-close markers; ref/start/stop/close and acknowledgement are distinct
states. native-ports.cpp roots serialized engine buffers within their owning
JS context and clears them before context teardown. Those rooted JS values
are not a cross-thread serialization format and cannot be moved to another
worker. Native peer/ref/close state, not an artificial timer, determines loop
liveness. The engine loop gains a messaging dispatch phase; its existing
polling/idle-wait implementation still needs later validation/work.

Pinned worker IO owns public NodeEventTarget/listener/close behavior over
these endpoints. Full pinned Undici message/close/error event classes share
WebIDL and the same constructors used by global, module and stream routes.
This is an unbuilt guest source candidate. The C++ queue is exercised by a
native-host threaded fixture, and the shared frontend by actual native Node
queues/serialization. Neither establishes the guest bridge/GC/provider/realm/
loop path or any four-host conformance. Actual cross-worker bootstrap,
transfer/adoption, broadcast groups and exact Worker stop/join/environment/
identity remain separate owners to implement.

### Node testing and process-clock source candidates

The partial testing namespace uses unchanged pinned Node mock/virtual-clock,
assert/snapshot configuration, structured result stream and reporter source.
Its mocks own actual calls/accesses/descriptors/restoration and selected
virtual timer/Date state. The guest runner still has no implemented test-tree/
execution/context/hook/CLI/isolation owner. Those routes reject explicitly,
without running callbacks or emitting invented passing records. Reporter
formatting and manual producer-record controls are not real test outcomes or
measured coverage. Module mocks remain dependent on activation, normal loader
hooks/cache identity and actual caller stacks.

Process hrtime now has a source route to monotonic-clock.h, the existing guest
clock_gettime(CLOCK_MONOTONIC) syscall, kernel clock translation and host time
providers. Normal Node hosts use outer process.hrtime.bigint; browser hosts
use performance.now through VirtualPlatformIO. Deterministic image-build mode
retains its existing guest logical-clock policy. These sources are independent
of the guest Date object. Nanosecond units do not promise nanosecond physical
resolution. Existing CPU-clock approximations and clock_getres limitations are
unchanged. process.uptime/performance and actual process-start metadata remain
separate gaps; this change does not make every timing API correct.

The POSIX nanosecond helper is compiled/executed only on the native host.
Shared algorithm controls use a real native reference clock boundary. The
engine hook, guest kernel route, virtual-clock interaction and four-host
conformance are not established. No full product rebuild or overall suite
was run for these source changes.


### Pathname metadata source owners

The recipe91 candidate reuses pinned public access/chmod/chown/lchown/
utimes/lutimes algorithms over actual POSIX sync/queued work. One private
system-error owner uses real guest errno data and preserves raw/empty paths.
The kernel selects the final symlink inode for nofollow timestamps, checks
that inode's permissions and forwards existing flags through the handle-only
host operation. Both Node-backed adapters use native lstat/lutimes in that
case. OPFS metadata mutations fail ENOTSUP until persistent guest metadata
exists; this is an implementation gap. Native/source checks do not compile
the new guest bridge or kernel Wasm, nor establish four-host conformance.
See [path metadata ownership](../tests/nodejs/outline/path-metadata-implementation-dependencies.md).

### Callback whole-file write owners

Recipe95 selects unchanged public callback write/append algorithms over a
native FSREQCALLBACK job and shared work/callback scope. Actual guest POSIX
open/write-all/close owns one descriptor, exact error pathname policy and
byte lifetime through completion. Resizable views copy after init; regular
views use the existing dispatch pin, with full detach/shared/transfer lease
semantics still incomplete. Flush/user-fd paths retain their real asynchronous
descriptor operations. Sync and path-promise file jobs remain separate gaps.
Native/source controls pass, but the new guest bridge is uncompiled and
four-host conformance remains open. See
[write-file source and evidence](../tests/nodejs/outline/write-file-implementation-dependencies.md).

### Public source-map query owners

Recipe94 embeds the full unchanged pinned SourceMap class over shared
primordials and validators. The actual Module namespace supplies its public
constructor with real VLQ/indexed-map/query and payload state. Exact pinned
input array/nested-section aliases are retained; no deep clone is invented.
Native/source controls verify this helper and its bootstrap binding. Actual
loader capture, source URL/map cache lifetime and enabled stack remapping
remain missing. No guest compile or four-host conformance is established.
See [SourceMap source and dependencies](../tests/nodejs/outline/source-map-implementation-dependencies.md).

### Performance timeline source owners

Recipe93 reuses complete pinned Performance, mark/measure, resource entry,
NodeTiming and timerify modules over the actual monotonic process clock,
structured clone and EventTarget owners. Timeline storage and observer queues
are shared with installed DNS/function/user/resource producers. Global and
builtin Performance objects share one owner and the pinned replaceable
attribute helper. Missing native milestones, idle/loop metrics, histogram
storage/sampling and other producers remain explicit implementation gaps.
The zero-statistics monitor facade is removed. Focused native/source checks
pass, while one unchanged upstream file still fails at the missing milestone
provider. Guest source93 and four-host conformance are unvalidated. See
[Performance timeline source and evidence](../tests/nodejs/outline/performance-timeline-implementation-dependencies.md).

### Argon2 source owners

Recipe92 adds unchanged public Argon2 validation/callback/result algorithms
over the actual OpenSSL provider derivation and shared KDF/native resource
owners. Four byte inputs have async-before-init versus sync-after-init
snapshot ownership. The native compile capability is independent of actual
provider/FIPS availability; the real default context gates private thread
contexts. Actual Argon2 lanes remain independent of available worker threads.
Source/native and affected controls pass, including provider error records.
The new guest request class/bridge and OpenSSL dependency remain unbuilt,
and four-host conformance is unestablished. Key/WebCrypto and remaining
crypto dependencies stay open. See
[Argon2 source and evidence](../tests/nodejs/outline/argon2-implementation-dependencies.md).

### Password-KDF source owners

Source99 installs full pinned promise writeFile/appendFile over existing
actual queued jobs and FileHandle owners, replacing synchronous pathname
fallbacks. Promise readFile already used its queued owner. Six focused and
eleven affected controls plus four unchanged files per mode pass at native
boundaries. Current97–99 and four-host guest integration remain unverified:
[promise write/append scope](../tests/nodejs/outline/file-promises-implementation-dependencies.md).

Source98 replaces legacy sync whole-file wrappers with unchanged pinned
read/write/append algorithms over existing actual native I/O and private
bytes. Six new and fourteen affected controls plus four selected unchanged
upstream files per mode pass at explicit native boundaries. Source97/98
remain guest-uncompiled; promise pathname jobs and full four-host behavior
remain open. See [sync ownership](../tests/nodejs/outline/file-sync-implementation-dependencies.md).

Current build checkpoint: engine96 compiles the source through95 with
actual guest OpenSSL3.5.9. Four focused Node-host differentials pass; they
do not validate the full public API surface or four hosts. Source97 adds
actual linked OpenSSL metadata and target process-version descriptors;
that correction is not guest-compiled. Changed kernel/host source remains
unbuilt. Older recipe-stage build statements below are historical; see
[the exact current receipt](../tests/nodejs/outline/engine96-integration.md).

The recipe90 candidate selects complete pinned PBKDF2/scrypt public modules
over actual OpenSSL derivation and shared native work/resource source owners.
Async inputs are copied before resource init; sync inputs are read after init
and before native execution. Guest pthread work owns native bytes, and the
owning realm enters the shared callback scope for completion. The shared
OpenSSL source pin is3.5.9, matching the audited Node reference. Native
derivation/frontend/affected-consumer controls pass. Neither the new guest
dependency nor engine90 is compiled; four-host conformance remains open.
See [KDF source and evidence](../tests/nodejs/outline/kdf-implementation-dependencies.md).

### Process finalization and Refable source owners

The recipe89 source candidate reuses the full pinned Node weak finalization
registry, public lazy accessor and symbol-first process.ref/unref algorithms.
It uses captured engine weak-reference primitives and the guest process
EventEmitter, with actual idle/exit hooks and the existing shell GC cleanup
queue. Resource methods own their real reference state; adding the dispatcher
does not repair incomplete resource methods. Native-dependency controls pass,
but this source slice is not in the accepted engine88. Guest GC/exit/worker
integration and four-host conformance remain unvalidated. The exact evidence
and remaining process gaps are in
[process lifetime ownership](../tests/nodejs/outline/process-lifetime-implementation-dependencies.md).

### Process-state source owners

The Node compatibility candidate now routes environment reads, mutation,
deletion and enumeration through a private native owner backed by the guest
libc store. It copies borrowed values/names while its mutations are excluded,
then creates JS strings after releasing the lock. The adapter no longer
discards setters, seeds a whitelist or caches stale environment values.
Existing child snapshots consume the resulting live enumeration.

Pinned creation-mask wrappers validate arguments before calling the real
libc umask operation; a serialized query restores the original mask. A live
parent getter uses getppid. Both reuse existing guest kernel process state
and syscalls without adding a host import or changing the wire ABI. The
standalone C++ helper and frontend/native controls pass; the engine bridge
is uncompiled. Complete worker environment/state ownership, timezone cache
refresh, exotic-object metadata, warning/trace/CLI policy and four-host
conformance remain open in the process-state dependency record.


### DNS source owner prerequisites

The Node compatibility hostname lookup now has a native-work source route:
actual guest libc getaddrinfo runs as slow I/O, and its owning JS context
dispatches rooted address/name request completions in the owning realm.
Pinned callback/promise lookup and lookupService now share those owners. The OS name
service's one-address routing interface remains distinct from DNS records;
fetch/TLS routing addresses must not become fabricated RR/TTL answers.

A separate resolver uses the exact Node-vendored c-ares library, actual
poll-driven channel threads/configuration and independently copied records.
Full pinned callback/promise Resolver modules now consume native channel/query
owners. Native event completions enter the owning JS loop through the shared
external-work queue without blocking a pool worker; teardown interrupts producers and waits for terminal publication before
rooted request retirement. Channel destruction joins its native event thread;
complete idle-channel/context shutdown behavior still needs guest validation. JSAPI conversion preserves
sparse arrays, Latin-1 strings, binary storage and ordinary CAA assignments.
The engine recipe declares and provenance-checks node-cares. Its linked version
is read with ares_version(), not inferred from an installed public namespace.

This remains partial source implementation. Native-boundary controls do not
establish guest behavior, host UDP egress, default configuration refresh,
permission policy or four-host conformance. The OS routing-address interface
is not a DNS-record service. See tests/nodejs/outline/dns-channel-implementation-dependencies.md
for source owners, evidence and remaining requirements.

### Shared Node system-error data

The compatibility source now has a dedicated native-data owner for the
pinned libuv error table. It expands the actual target errno definitions
and portable libuv codes at compile time, then marshals rooted rows to
private JS constants/maps. Internal error constructors and pinned util
name/map/message helpers share this owner. Public map mutation cannot
alter the private cache. This does not add a libuv runtime, event-loop ABI,
or process.versions entry, and no existing wire ABI changes. Native-host
map/field controls do not validate the guest marshalling or full delivery/
stack/integer-edge behavior; all four guest hosts remain pending.

The private DNS request candidate (patch 61) adds actual native address/name
request resources, captured async identity, rooted slow-I/O jobs, completion
in the request realm and deterministic retirement. getnameinfo uses real libc
with NI_NAMEREQD. Shared EAI translation and compiler netdb constants replace
hardcoded data assumptions in this boundary. No host import or wire ABI is
added. The request engine bridge is uncompiled; pinned public lookup/lookupService
frontends now use it in source; native-helper evidence does not validate guest
request lifecycle or any of the four hosts. Public Resolver/record/transport
and complete name-service behavior remain open.


### DNS performance and shared process origin candidate

Pinned observer/entry/list algorithms now track real DNS registrations,
queue actual completed entries and publish lookup/lookupService timing.
The capability list includes only installed DNS producers; other target
entry types remain implementation gaps. mark/measure throw rather than
silently succeeding. A POSIX origin captured at engine main entry supplies
monotonic elapsed performance time and process uptime across contexts;
global and builtin performance share this owner. The clock helper has
native controls, but the engine bridge is uncompiled. Full Performance/
EventTarget/producer and callback-scope tick/microtask-before-retirement
semantics remain open; native boundary controls are not four-host evidence.

### Shared native callback-scope source owner

The Node engine candidate now shares actual callback depth/context ownership
across DNS, filesystem and codec completions. Successful outermost callbacks
run after hooks, restore context, then process owning ticks/jobs before
native retirement. Nested/failed/stopping paths preserve their proper
scope. Actual bootstrap/timer/tick/job entries supply depth guards without
inventing resource IDs or hooks, and explicit quit status survives native
dispatch. No kernel/host/syscall wire interface changes occur.

The shared C++ policy has native Node-API/libuv differential controls, while
the JSAPI adapter remains uncompiled. Full rejection/fatal recovery, GC/
weak-reference, VM/worker and complete phase ownership remain unfinished or
unvalidated. Source/static/native policy evidence does not establish Node/
Chromium/Firefox/WebKit behavior for the new candidate. See the callback
scope dependency record for the subsequent engine and lifecycle gates.

### Shared guest Buffer codec source owner

The Buffer codec adapter owns actual branded-byte UTF-8/ASCII/Latin-1/
UTF-16LE/hex/base64/base64url conversion. Pinned public wrappers preserve
overloads, aliases, lengths, fill/write ranges and exclusive-end searches.
The existing byte adapter delegates string conversion to it. Unsafe backing
allocation remains with the real native unpooled allocator; public alloc and
fill capture private owners instead of consulting mutable public allocators.
Shared slices copy bytes before creating strings. No host/kernel wire change
is introduced, and all four hosts use the same guest bootstrap source.

Native-reference JS controls and unchanged public upstream tests cover this
slice, with fixed ArrayBuffers as the test allocation boundary. Guest native
allocation and the combined engine remain uncompiled. Pooling, untransferable
ownership, callable legacy construction, allocation options and backing-store
edge behavior remain implementation gaps. Source progress does not establish
Node/Chromium/Firefox/WebKit conformance; see the Buffer codec dependency record.

### Distinct guest filesystem pathname operations

The directory source candidate uses actual guest mkdir/unlink/rmdir instead
of C remove(). Its portable recursive mkdir continuation retains original
path bytes, leaf-first/first-created semantics, existing-file errors, mode
zero and the target's different sync/async failed-parent policies. Copied
pathnames and request roots remain owned by native filesystem work until
completion, using shared callback scopes and real cancellation/stopping state.
No host path adapter or syscall/kernel wire interface is added.

Pinned public sync/callback/promise wrappers share the actual path validators,
private native operations and VFS dispatch state. Portable-helper/native Node
controls and unchanged public upstream tests cover scoped source behavior;
the JSAPI bridge and combined engine remain uncompiled on all four hosts.
Removal traversal/retries, directory handles, raw-byte filesystem behavior,
metadata/watch and complete lifecycle/error/permission semantics remain open.
See the directory dependency record under tests/nodejs/outline.

### CommonJS record and safe lookup source owners

The CommonJS source now creates actual Module instances and shares the public
cache, first-parent/children graph, dynamic require/load and extension tables.
Compilation/execution failures remove both cache and failed-parent ownership.
Pinned createRequire/require/lookup/load/JSON algorithms supply ordinary CJS
behavior; hidden native fields have WeakMap owners rather than observable
stand-in Symbols. Safe HOME/NODE_PATH queries use actual guest credentials
and libc secure startup state. The existing environment mutex protects copied
values. Patch 65 adds this private operation without changing a wire ABI.

Scoped native-reference/source controls and selected unchanged upstream tests
are distinct from guest artifact evidence. Guest native compilation, secure startup,
CJS/ESM realm/status/async-graph/cycle ownership and four-host behavior remain
unverified or incomplete. Package maps/config/exports, hooks, TS/CLI/preloads,
source maps/cache and addons remain open. Pending ESM status fails explicitly;
a CJS record's empty initial exports never substitutes for a native namespace.
The separate Bun asset dispatch source is retained; see the module-record
dependency record under tests/nodejs/outline for scope and remaining gates.

### Child wait outcome and lifecycle source owners

The Node compatibility source now owns exact-pid asynchronous wait results
until their JavaScript sink succeeds. Actual waitpid WNOHANG exit, signal and
error outcomes are retained after reap; interrupted waits retry and stopped
notifications never become exit zero. Promise initialization claims ownership
before hooks may reenter. Existing prepared same-context requests share their
owner; context shutdown releases its child roots without callbacks or reaping
again. Failed conversion stops the current loop pass rather than losing status.

Bootstrap publishes actual child status fields, gates close and exec callbacks
once, retires failed stream owners and selects live ref/unref by wait token.
The source is shared across all four guest hosts and reuses existing guest
spawn/wait/signal syscalls without host imports or a wire ABI change. Compiled
native policy and focused JS/native-reference controls are separate from the
uncompiled engine/JSAPI and unvalidated guest lifecycle.

Exceptional wait loss currently emits an error and closes with unknown status.
Pinned libuv ignores ECHILD without an exit callback and aborts on other
unexpected wait errors. This remains a semantic gap, not a justified platform
boundary. The private POSIX errno name does not alter public libuv error maps.
Full process normalization/IPC/stdio/subclass/fatal/GC/realm and four-host
validation remain open; see the child-wait dependency record under
tests/nodejs/outline.

### Dotenv parser and file/environment source owners

The Node compatibility candidate selects the pinned native dotenv parser
through a hash-checked portable C++17 header and unchanged public parseEnv/
loadEnvFile wrappers. Native conversion retains embedded NUL lengths and
creates null-prototype property records; file loading owns actual guest
open/read/close and consults the real process environment before setting
missing values. JS string conversion happens outside the environment lock.
Provided empty paths retain their native error metadata. The loader does
not execute NODE_OPTIONS after startup.

Compiled parser/file and focused frontend controls are separate from the
uncompiled JSAPI bridge and guest four-host behavior. CLI env-file handling,
Node permission policy, worker environments and complete byte/realm/GC/
concurrency ownership remain unfinished. Unexpected close failure currently
throws instead of the target's native abort; this remains an implementation
deviation. No host import or wire ABI changes. See the dotenv dependency
record under tests/nodejs/outline for exact evidence and remaining gates.

### Digest and byte-comparison source owners

The Node compatibility candidate selects pinned one-shot hashing/validation
and actual OpenSSL provider digest, output-length and comparison owners.
Names are derived from fetchable provider/legacy aliases, not a four-name
preset. Owned temporary input/output bytes are cleansed; native strings
preserve embedded NUL lengths and actual buffer views retain their spans.
Shared bytes are captured with relaxed atomic reads. Comparison uses
CRYPTO_memcmp after real brand/length checks rather than a JS XOR/coercion
loop. No measured timing guarantee follows from value controls.

Incremental Hash/Hmac now select full pinned public classes, lazy Transform
hooks, copy/finalization/encoding validation and constructor deprecation
wrappers. Actual EVP_MD_CTX/HMAC_CTX owners preserve branching state, cached
hash digests, zero-length XOF policy and Hmac retirement. Encoding functions
come from the exact pinned native parser; actual private byte codecs own
conversion. Temporary secrets are cleansed and native wrappers/cache bytes
are accounted, with provider-internal accounting still incomplete.

The normal targeted wasm32 engine revision 65 compiled these bindings and
passed unchanged upstream build checks. Seven bounded frontend controls and
five portable OpenSSL/native-reference comparisons are separate evidence;
none establishes guest execution or four-host conformance. Real key-object
owners, target backend algorithm/options/FIPS parity, backing-store and
GC/realm/error/lifecycle integration remain implementation gaps. No host
import/wire ABI or full product image was changed. See the digest and
incremental-crypto dependency records under tests/nodejs/outline.

### Readline interface input and lifecycle source owners

The Node compatibility candidate selects full pinned callback/promise/shared
readline interfaces, key decoding and history source. Actual input/data/end/
error listeners and decoder/question/prompt/abort/iterator/close state replace
the no-input EventEmitter facade and immediate empty answers. A private
module cache preserves circular class/symbol identity; event helpers and
private iterator symbols use the same event owner. Streams, StringDecoder,
timers, filesystem and inspection remain their existing shared guest owners.

The source is common to all four hosts. Focused native dependency controls
and selected unchanged upstream tests do not validate guest TTY/raw/resize,
Unicode width, persistent history, REPL or engine/stream/event integration.
Persistent history's absent Node permission-policy owner fails explicitly;
public process mutation never enables it. No syscall/import/wire ABI change
or guest engine/package/product rebuild. See the readline-interface
dependency record under tests/nodejs/outline for scope and remaining gates.


### Console namespace, output and state source candidate

The compatibility candidate selects pinned full Console/public/global/table/
debug-timer source over actual shared guest streams, inspection, diagnostics,
readline controls and native iterator/monotonic owners. Builtin/global identity,
format/options/error policy and counter/group/timer state replace separate
facades. Direct diagnostic publication replaces wrapping, avoiding duplicates.
A private trace collector owns active subscriptions and retirement; public
trace files/CLI/native producer/inspector integration remain incomplete.

Missing V8 stack recapture uses a real engine Error stack; exact filtering
and inspector methods remain implementation gaps. Nine focused Console and
ten diagnostics controls plus four unchanged upstream files in candidate/
native modes use explicit native dependencies, not built guest evidence.
Recipe revision 52 adds no engine patch/import/wire ABI. Four-host stream/
TTY/width/error/GC/realm integration, ESM identity and full observability remain
unvalidated. See tests/nodejs/outline/console-implementation-dependencies.md.


### Shared Headers and Fetch header source candidate

The shared FormData/WebIDL owner now loads pinned full Undici Headers and
checked header/iterator primitives. Private lists/guards and actual brands,
validation, normalization, sorted iteration and cookie ownership replace the
public map facade. Fetch uses that same global class, preserves immutable
transport/clone guards, reduces owned lists without prototype-name loss,
keeps set-cookie arrays and replaces Request headers when init supplies them.
Full Request/Response/Body/Fetch and guest transport remain incomplete.

Six new/26 affected native-boundary controls and one unchanged upstream file
in candidate/native modes pass. The in-memory HTTP fixture performs no
network access; body regressions retain their explicit polyfill stream
boundary. Recipe revision 53 adds no engine patch/import/wire ABI or rebuilt
guest artifact. Four-host brand/clone/stream/HTTP/GC/realm conformance remains
open. See tests/nodejs/outline/headers-implementation-dependencies.md for
retained failed evidence, native constructor-record behavior and remaining
implementation/integration gates.


### Query-string and Unicode codec source candidate

Full pinned public/private querystring and punycode algorithms replace split/
URI shortcuts and identity-only functions. Actual query options, tolerant
Buffer-byte decoding, null dictionaries, public hooks and exact surrogate
encoding share the guest byte/error owners. Punycode loads lazily with real
Bootstring/UCS-2/domain functions and its actual warning call. The prefix's
existing saved-frame capability supplies a bounded first-external-source
origin decision; no caller/platform metadata is fabricated.

Eight new/16 affected controls and five unchanged upstream files in candidate/
native modes pass. Candidate-Buffer controls use a fixed allocator; upstream
files use native Buffer/origin/warnings. The initial unexpected fixture
warning failure is retained; awaited standard preload setup keeps warnings
visible and assertions unchanged. Recipe revision 54 adds no engine patch,
import/wire ABI or guest build. Full byte/realm/loader/CLI/worker/warning and
saved-frame depth/ESM/native-entry behavior remain open across all four hosts.
See tests/nodejs/outline/query-codecs-implementation-dependencies.md.


### OS frontend and actual POSIX state source candidate

Pinned full OS source now uses actual guest uname/hostname, environment/passwd
home/user bytes, safe temp policy, endianness and priority operations through
os-operations.h/native-os.cpp and patch 0069. Owned byte copies and actual
libc errors replace presets; the existing module identity is retained.
Kernel getrusage/sysinfo still have fixed accounting, so CPU/memory/load/
interface/uptime/parallelism APIs explicitly throw rather than presenting
those values as real measurements. These are implementation gaps. Guest OS
constants, priority cross-process/credential/scheduler effects and five other
process/heap/report false claims remain open.

Seven new/eighteen affected native-boundary controls and three unchanged upstream
files in candidate/native modes pass. The helper compiles real portable
POSIX owners; native Node supplies Buffer/UV/constants and the transport
maps self priority to its owned Node control process. Candidate preload
propagates to the homedir child. None proves guest libc/kernel/JSAPI or
four-host conformance. Recipe revision 55 adds no host import/syscall/wire
ABI; guest compilation/full rebuild remain deferred. See
tests/nodejs/outline/os-implementation-dependencies.md for exact limits.

### Persistent directory cursor and Dir lifecycle source owners

The Node candidate selects the full unchanged pinned Dir module over actual
persistent libc DIR cursors and shared native FSReqCallback open/read/close
jobs. Native resource ownership and pending-parent roots keep each cursor
alive through work, release reservations before completion/reentry and close
actual descriptors on disposal or GC. Worker data consists of owned native
names/types, never JS pointers. Byte-conversion exceptions reject the actual
request within its callback scope. Interrupted batches follow pinned libuv's
partial-batch discard and cursor retry policy.

Abandoned native cursors close synchronously, then defer diagnostics outside
GC. Successful Dir warning records do not own an event-loop reference; failed
closes and FileHandle fatal records do. Full pinned queues, recursive reads,
async iteration and sync/async disposal consume these owners. The normal
targeted wasm32 engine67 compiled the bridge and passed unchanged upstream
build checks; bounded native/source controls are not guest/four-host evidence.
Actual GC/ref/scopes, cancellation/realm/OOM, opaque libc accounting, public
VFS/permissions and backend directory behavior remain implementation and
validation requirements. No full product image rebuild or host/syscall/wire
ABI change occurred. See the Dir dependency record under tests/nodejs/outline.

### Live Node TLS metadata source candidate

The shared Node candidate now reads protocol, cipher, session reuse, peer
verification and local/peer Finished data from the actual SSL object owned
by its existing native TLS handle. Returned bytes are independent copies.
Authorization no longer mirrors the caller's rejectUnauthorized policy.
The current source candidate finishes certificate verification with the pinned
continuing callback and captures rejectUnauthorized before TCP startup. A
rejecting connection checks the real verification result before publishing a
TLS handle or plaintext; allowed-error mode retains that result.
The guest TLS metadata describes that connection, including a browser's
local TLS bridge, rather than the separate upstream Fetch TLS session.

Portable OpenSSL/native Node and actual frontend controls cover TLS1.2/1.3
and trusted/untrusted peers. The normal targeted wasm32 engine69 build compiles the guest binding;
four-host runtime validation remains pending. This does not complete SecureContext, certificate
objects/identity callbacks, socket inheritance, sessions, cancellation,
servers or public metadata/function descriptors. See
[tls-state dependencies](../tests/nodejs/outline/tls-state-implementation-dependencies.md).

The later trust-context source captures custom CA arrays and sized string/view
bytes in an actual SSL_CTX before TCP startup. Handshakes claim independent
native references. Explicit empty stores and partial-chain flags retain their
pinned selections. Production completion enters the rooted Promise realm and
admits TLS watches only on their owning context. Synchronous native context
exceptions retire the actual socket and queued writes without replacing the
exception with a generic Promise failure. This source remains uncompiled for
the current candidate. Default trust uses configured guest OpenSSL paths;
bundled/system/extra CA APIs, public SecureContext, hostname policy, fatal
allocation behavior, cancellation and context shutdown remain open. See the
[trust-context scope](../tests/nodejs/outline/tls-context-trust-implementation-dependencies.md).

### Native filesystem metadata polling source candidate

The Node source candidate routes watchFile/unwatchFile and StatWatcher to actual
asynchronous POSIX stat,one-shot native timers and explicit close/ref ownership.
Pinned fs-poll and stat-conversion algorithms consume that native port. New
watcher contexts join the existing cached loop clock;watcher start does not
advance it,and normal clock updates sample once for both watcher and event-loop
delay owners. Native class/provider/GC/realm/loop code remains uncompiled.
Notification watchers,promise iteration,global phase ordering,shared uncaught
recovery and complete backend metadata remain open. Component/reference checks
do not prove current guest or four-host behavior. See
[watcher source scope](../tests/nodejs/outline/stat-watcher-integration.md).

### Native lazy data-property source prerequisite

The current engine source introduces a distinct pending native DATA property
state for Node-compatible lazy exports. A real native shape/slot owns a traced
loader/data/value cell. Native lookup, descriptor, definition, assignment,
integrity and cache owners recognize that state; it does not expose an ES
accessor or visible placeholder. Publication uses real shape invalidation.
This initial API admits absent ordinary PlainObject keys only. The Worker locks
consumer now routes the pinned lazy installation through this native owner and
retains private module/singleton/thread identity. Source controls use the actual
production adapter with explicit native reference dependencies. Wider holder/key
admission,other public consumers and callback mutation/reentry remain open.
The prerequisite and new JSAPI controls are uncompiled; source/staging checks
and native target reference observations do not establish candidate GC, realm,
JIT, interruption or four-host behavior. See
[native lazy scope](../tests/nodejs/outline/native-lazy-data-integration.md).

### Public Buffer constructor and pooled storage source candidate

Public Buffer now uses the pinned callable constructor over a separate
FastBuffer typed-array constructor. A shared native aligned pool serves
allocUnsafe, strings, array-like copies and their actual consumers. The
engine records a permanent non-detachable ArrayBuffer storage property;
direct transfer/JSAPI detach and both structured-clone transfer phases obey
that state. The real option parser and private native process setting own
--zero-fill-buffers allocation policy. No JS metadata property substitutes
for alignment, storage ownership, detachment prevention or zero filling.

Scoped controls use exact native dependencies, and unchanged upstream files
retain their original assertions. The normal targeted engine70 build compiles this guest engine/storage/CLI
source; four-host runtime validation remains pending. General
worker marks, shared/resizable byte leases, GC/realm/accounting/activation
and remaining public Buffer contracts remain open; see
[Buffer pool dependencies](../tests/nodejs/outline/buffer-pool-implementation-dependencies.md).

### Shared Node package-resolution source candidate

The actual package reader/cache now feeds shared exports/imports, conditions,
self-reference and package-map owners. Pinned CJS filename/path algorithms
and the full ESM URL resolver consume those owners. Maps use their real
files and exclusive dependency rules. Public findPackageJSON uses its actual
reader/resolver dependencies. The CLI supplies conditions/map/symlink modes
through actual parsing and an immutable private snapshot; CJS load/cache
identity no longer canonicalizes a preserved filename a second time.

The existing native resolver callback now propagates package errors rather
than swallowing them and bypassing policy. Its resolution-only consumer
returns actual URL resolution. Complete ESM execution/cache/namespace/URL
identity, source syntax/TypeScript/addon execution, hooks and lifecycle remain
open; classification does not establish execution. Scoped source/native and
CLI controls are separate from guest build/runtime/four-host conformance.
See [package policy dependencies](../tests/nodejs/outline/package-policy-implementation-dependencies.md).

### Owned Node message packet source

Message queues now retain actual engine SameProcess structured-clone data,
with no context-rooted shell buffer payloads. Publication and consumption are
single-use; failed writes/publication and reads retire native storage. The
pinned engine defines this buffer as thread-movable, but full Node worker
bootstrap, endpoint transfer/adoption, broadcast and lifecycle remain gaps.
Native close acknowledgement retires the actual endpoint notification.
The production JS adapter forwards these packet operations and the new DNS
channel/configuration/version bindings; earlier engine compilation alone did
not verify that adapter connection. See tests/nodejs/outline/port-packets-implementation-dependencies.md.
No kernel/host wire ABI or host memory ceiling changes here. Four-host guest
conformance and complete native byte accounting remain unestablished.

### Node resource accounting gaps and engine GC budget

Pinned process usage validation/delta/field algorithms now have shared source
owners. Current guest getrusage zeros and elapsed-time CPU approximations are
not suitable providers; process CPU/thread/memory/RSS/resource calls explicitly
fail until actual accounting exists. Report generation no longer invents a
loaded musl object, and heap-space queries no longer claim an empty measured
list. These remain implementation gaps, not accepted platform exclusions.
The partial heap statistic reads its nominal configured GC-things soft budget
from actual SpiderMonkey JS_GetGCParameter/JSGC_MAX_BYTES. This changes no
limit, reservation, physical memory or kernel/host ABI, and does not establish
full heap-use/space/statistics equivalence or reachable process capacity.
See tests/nodejs/outline/resource-usage-implementation-dependencies.md.

The subsequent HTTP source slice uses the complete pinned IncomingMessage
module for actual response parsing, lazy/distinct headers/trailers and abort
state. Socket release now waits for consumed response EOF and completed request
writes. Recipe77 remains uncompiled; the last accepted engine76 predates it.
Focused native-boundary controls are separate from guest/four-host conformance.
Complete parser/Agent/server/HTTP2 and remaining lifecycle gaps stay open; see
`tests/nodejs/outline/http-incoming-implementation-dependencies.md`.

The VM ordinary-global source now owns a real isolated DONT_CONTEXTIFY
global and per-ShellContext chained/restored security callbacks (patch85,
recipe78). Ordinary sandbox live forwarding, imports/deadlines/microtasks and
full realm/worker behavior remain gaps. Native-boundary controls and the
retained complete-file dynamic-import failure do not establish guest or
four-host conformance. See
`tests/nodejs/outline/vm-plain-context-implementation-dependencies.md`.

The later normal targeted engine78 build compiles actual VM ordinary globals/
runtime security callback ownership and the preceding HTTP77 source. Narrow
Node-host guest VM outcomes are separately identified in the VM plain-context
dependency report; HTTP/worker/full API/four-host conformance remains open.
The complete unchanged VM plain-context upstream candidate file still fails
its missing dynamic-import requirement. No overall suite/full product rebuild.

The subsequent Worker source replaces minimal-prelude/JSON/shared-mailbox
launch with per-worker native context/thread/packet/endpoint ownership and
normal Node bootstrap/loader, ready/error/exit and independent stop/join/ref
state. Patches86–88 reached targeted engine83 acceptance; six identical
native/Node-host guest cases pass. Options/stdio/fd/transfer/resource/lifecycle,
ordinary stamped-consumer and four-host obligations remain open. Subsequent
recipe84 Test/Suite/harness source is uncompiled; native-boundary controls
are separate from guest execution. See worker-owner and testing dependency
records under `tests/nodejs/outline/` for exact evidence and retained failures.

The later targeted engine88 compiles actual SQLite iterator/column/limit/
session/change-set and native callback owners, with real SQLite activation and
process beforeExit idle/revival state. Exact focused native/Node-host guest
outcomes and retained nonpasses are in the SQLite dependency/finding records.
SQLite/testing/process and four-host conformance remain partial; no overall
suite or full product rebuild ran.

### Native reusable roots and backing transfer source corrections

Source166 clears reusable UDP, Signal and failed-start StatWatcher root values
without unregistering their persistent GC roots. Terminal teardown still
unregisters them. This repairs an embedding ownership error, not a browser
engine defect. It also aligns backing metadata declarations with the actual
public visibility macro and uses the public resizable/fixed capacity paths for
retained cloning after two real165compiler errors. These are source fixes;
no166production compilation or guest/four-host GC acceptance is established.
See [scope and preserved build evidence](../tests/nodejs/outline/native-root-and-backing-integration.md).

### Node datagram source foundation

The source candidate selects unchanged Node 26.13.0 `lib/dgram.js` and
`lib/internal/dgram.js` over an actual guest POSIX UDP owner. The portable
`datagram-operations.h` owns nonblocking, close-on-exec datagram descriptors;
`native-datagram.cpp` owns readiness, retained receives/sends, references,
native async resources, callback checkpoints and shutdown. It uses
`socket`/`bind`/`connect`/`sendmsg`/`recvfrom` and real socket options, rather
than relabeling TCP stream watches or substituting an embedding host module.
Zero-byte datagrams remain messages with sender metadata. Pending sends own
their request and leased original byte spans until completion or cancellation.

This is a source foundation, not a four-host conformance claim. The native
endpoint controls and the pinned native Node reference fixture pass on
Darwin arm64. The new SpiderMonkey native fragment, linked guest package,
Node host and Chromium/Firefox/WebKit controls still require validation.
Kernel receive queues retain their fixed packet limit; buffer size requests
remain advisory and read back the fixed default (audit N-021). IPv6
multicast transport, IPv6 source-specific membership, cluster sharing,
worker/child transfer and full audit N-014 remain open. The default
`EgressLink.sendDatagram()` still returns `EHOSTUNREACH` for external raw
UDP on both hosts. That transport/configuration boundary is separate from
guest-local IPv4/IPv6 and virtual/session networking.

Exact source scope and remaining controls are recorded in
`tests/nodejs/outline/datagram-source-status.json` and
`tests/nodejs/outline/datagram-verification-obligations.json`. Frozen audit
requirements and existing nonpasses are unchanged. No syscall, kernel-host
protocol or program ABI changed for this binding foundation.

### DNS scoped byte-address source ownership

Source167 routes local source addresses, resolver server tuples and reverse-address decoding through the same pinned uv_inet_pton-style IPv6 zone rule before actual c-ares operations. The public local-address gate accepts that same prefix policy. Native configuration controls do not prove production JSAPI/query/provider/source-binding or four-host conformance. See [source scope](../tests/nodejs/outline/dns-scoped-address-integration.md).

### Child process public kill error source ownership

Source168 normalizes actual native kill errno through unchanged pinned ErrnoException and the real compiler-selected UV map. ESRCH returns false, EINVAL/ENOSYS throw and other failures emit synchronously; killed changes only after actual success. Existing zero/default/unknown conversion remains intact. Host-boundary controls are separate from guest process/permission/four-host proof. See [scope](../tests/nodejs/outline/child-kill-error-integration.md).

### Test snapshot update CLI source ownership

Source169 admits --test-update-snapshots in the actual command-line owner, preserves execArgv and projects its real boolean to the test option reader. It rejects the option and negation in NODE_OPTIONS before applying values, following the pinned policy. Existing SnapshotManager/filesystem/VM/serializer algorithms own the writes and real errors. Current component controls do not establish guest startup, JSAPI projection or four-host behavior. See [scope](../tests/nodejs/outline/snapshot-activation-integration.md).

### Accepted TCP resource publication source ownership

Source170 constructs the real accepted TCP owner before publication and retains it behind the existing null-prototype capability. Adoption returns that same owner once; unclaimed cleanup queues close of the actual owner. Accept completions detach their watch before JS init/rejection and return without a stale raw next pointer. Listener ownership, native callback/fatal phases and other dispatcher branches remain gaps. See [scope](../tests/nodejs/outline/accepted-tcp-owner-integration.md).

### Request and multipart BodyInit source ownership

Source171 selects unchanged pinned Undici Request and complete Body extraction over actual shared Headers/WebIDL/Blob/File/FormData/abort/stream owners. The existing HTTP consumer now publishes that real Request body with Readable.fromWeb/pipeline instead of stringification; Response gains genuine FormData extraction. Complete Fetch redirect/filter/dispatcher/decompression/cache/scheme and lifecycle policy remain gaps, as do guest/four-host execution. See [scope](../tests/nodejs/outline/request-bodyinit-integration.md).

### Focused DNS component dependency evidence

The focused DNS fixture supplies genuine native histogram and event-loop-delay owners to its existing candidate Performance dependency. This changes test setup only, with no runtime module, engine recipe or target mutation.26unchanged resolver cases pass over current source with real loopback/native request boundaries; the original pre-DNS setup error is preserved. See [evidence scope](../tests/nodejs/outline/dns-fixture-dependency-integration.md).

### Public PKCS12 material source ownership

Source172 wires unchanged public PKCS12 validation/wrappers to actual OpenSSL parsing and native KeyMaterial/X509Material ownership, with cleansing-owned byte/password snapshots. Production transfers references directly, while component controls explicitly transport PEM/DER into real native Node owners. TLS PFX credential installation remains a separate unimplemented SSL_CTX consumer. Source171compiled/linked but its normal package check failed;172new native source is uncompiled. See [scope](../tests/nodejs/outline/pkcs12-parser-integration.md).

### Native owner include and vendor staging

Source173 canonicalizes owning native includes using the exact pinned Mozilla include sorter, gives directory-copy excerpts truthful header names and places unchanged imported HDR/libuv bytes under the real third-party boundary. Owned stat-poll glue stays in the checked shell tree. The unchanged Mozilla style checker passes current source staging. No algorithm, assertion, checker expectation or ignore list changes. Normal selected engine acceptance and guest/four-host behavior remain unestablished. See [scope](../tests/nodejs/outline/native-include-staging-integration.md).

### Scoped synchronous VM deadline ownership

Source174 routes pinned positive VM script timeouts into a joined steady-clock native watchdog and per-context invocation chain. Real engine interruption remains uncatchable inside the running script; only the owning boundary translates after unwinding in the target realm. Existing foreign shell/worker/OOM/forced states retain their owners. The current portable owner and frontend/native-dependency checks do not execute the new SpiderMonkey bridge. The rare wait-failure reentry edge and module/microtask/SIGINT scopes remain open. See [scope](../tests/nodejs/outline/vm-execution-deadline-integration.md).

### Asynchronous SQLite backup ownership

Source175 implements the public backup frontend over real SQLite backup state and fresh per-batch shared work-queue jobs. Only page stepping executes on workers; native finish/close, public callback graph ownership, progress and Promise settlement stay on the creating context thread. Real serialized connection mutexes are required and checked. Current portable-owner and frontend/native dependency controls do not execute new production JSAPI/queue/GC/VFS behavior. Exact backing/version policy and unresolved reference nonpasses remain explicit. See [scope](../tests/nodejs/outline/sqlite-backup-integration.md).

### HTTP request framing and shared response ownership

Source176 extends the single actual llhttp owner to request framing and preserves response behavior. Pinned ServerResponse reuses existing OutgoingMessage/IncomingMessage/socket/trace/performance/diagnostic owners. The real compiled HTTP_METHOD_MAP and larger HTTP_ALL_METHOD_MAP remain distinct; public HTTP METHODS sorts the former exactly as the target. Full Server/connection/admission/ConnectionsList and synchronous parser reentry remain missing. A malformed-URL live comparison stays a nonpass rather than fabricating a400. See [scope](../tests/nodejs/outline/http-request-server-response-integration.md).

### Generic Server receiver and captured listener ownership

Source177 initializes the actual supplied inheriting net.Server receiver, using unchanged pinned public option/field segments. Actual active listeners retain distinct private captured fd/generation/ref owners across receiver reinitialization. Existing real TCP/accepted-socket/native option owners remain authoritative. Full opaque listener/worker/fork/fatal/HTTP and four-host behavior remain open. See [source scope](../tests/nodejs/outline/net-server-receiver-integration.md).

### Domain ownership and real callback invocation

Source178 loads the complete pinned Domain algorithms on actual public module demand. The owning async state roots its callback and activation predicate; the shared native MakeCallback invocation seam consults actual execution ID and distinguishes internal direct resolvers. Existing FS/stat callbacks consume this seam. Native JSAPI/legacy zero-ID/Promise/GC/fatal/realm and guest behavior remain unvalidated. See [source scope](../tests/nodejs/outline/domain-owner-integration.md).

### Guest-local WASI ownership and explicit execution prerequisites

Source179 reuses the complete pinned public WASI lifecycle and implements25real imports over actual current guest memory and POSIX descriptor/rights/clock/random/exit owners. The curated production adapter explicitly forwards its actual constructor; unchanged uvwasi wire C source is normally staged/compiled. Twenty-one imports remain absent, direct-Wasm unsigned conversion retains a strict28versus61nonpass, and the configured guest engine has no execution backend. Host-native components do not supply it or justify an exclusion. See [source scope](../tests/nodejs/outline/wasi-owner-integration.md).

### Actual ESM source, identity and mock ownership

Source180 shares synchronous resolve/load hooks and CLI-gated MockTracker with actual native fullURL/type registry/source/synthetic evaluation owners. Exact Node-vendored Merve supplies CJS names without executing during preparse; evaluation consumes prepared source through the real CJS owner. Static native request memoization retains the actual resolved record. A saved native exception explicitly survives failed cleanup; unsuccessful source retirement remains open. Imported lexer inputs remain at the real vendor boundary and normal checker rules are unchanged. Native bindings/GC/realm/worker/guest behavior remain uncompiled/unvalidated. See [scope](../tests/nodejs/outline/module-mocks-esm-source-integration.md).

### Synchronous request-header decisions over original storage

Source181 lets the actual request headers callback determine llhttp body/upgrade consumption inside its current C frame. The native path retains the original unshared allocation through a real backing Span and preserves pending JS/coercion failures. The existing request consumer and actual curated variadic forwarder use it. Target int64 saturation precedes narrowing; actual shared atomic parsing, remaining synchronous callbacks/parser reuse/ConnectionsList/fullServer and production JSAPI/guest semantics remain open. See [scope](../tests/nodejs/outline/http-synchronous-headers-integration.md).

### Shared TLS context owns real certificate and key material

Source182 extends the same private SSL_CTX trust owner consumed by tls.connect with actual certificate chains, private keys and PFX credentials before TCP starts. The native handshake retains an independent SSL_CTX reference; certificate and issuer state comes from real X509 objects and the actual context store. Exact pinned validation/configuration segments preserve selected cert/key/PFX ordering and failure semantics. Full public SecureContext, other configuration, ordinary OpenSSL error-property setters and guest lifecycle remain implementation gaps. Native OpenSSL3.5.9 component evidence is a distinct artifact/configuration from the selected guest dependency. See [scope](../tests/nodejs/outline/tls-credential-owner-integration.md).

### Response shares the pinned private body and header owners

Source183 replaces the separate custom Response with the complete unchanged pinned Undici implementation. Response, Request and Body share one WebIDL and HeadersList graph, real byte extraction and stream clone/cancel owners. The existing HTTP consumer publishes an immutable inner response with actual headers, stream and URL state. This does not supply the full Fetch controller, transport backpressure, redirect/filter/cache or abort policy. Component controls use explicitly native streams, URL, codec, clone and HTTP dependencies; guest finalization, realm/worker behavior and four-host conformance remain unestablished. See [scope](../tests/nodejs/outline/response-owner-integration.md).

### FFI library ownership uses the existing guest dynamic loader

Source184 admits real DynamicLibrary library/symbol ownership through libc dlopen/dlsym/dlclose and the existing outer guest Wasm dynamic loader. A context registry owns actual handles; GC only marks a holder for later owner-thread drain. Explicit shutdown follows exit listeners and precedes status capture, with idempotent destructor fallback. The pinned constructor/disposal/alias algorithms and actual CLI gate consume those owners. A mounted-VFS reader is invoked only for string paths, leaving main-library/null and native type admission operational. Permission/private-image loading, function calls/callbacks/memory/libffi/full FFI and new JSAPI/GC/realm/four-host execution remain incomplete. This existing outer loader does not supply the deferred nested guest WebAssembly backend. See [scope](../tests/nodejs/outline/ffi-library-owner-integration.md).

### Crypto failures retain their native queue and Error owner

Source185 captures real OpenSSL queue numbers and owned strings on the operation thread, then creates a genuine intrinsic Error on its owning JS thread. The shared renderer retains secondary/primary decoration order, ordinary property setters and original setter exceptions; Node native coded-error checked-fatal policy remains distinct from ordinary ErrorStore policy. Seven adapters and the exact sync-random bootstrap forward that original Error rather than rebuilding it from public fields. Actual guest JSAPI/GC/realm and async setter-context evidence, per-API message/validation choices and opaque allocation accounting remain open. Native controls use a distinct identified OpenSSL3.5.9 artifact/configuration. See [scope](../tests/nodejs/outline/shared-crypto-error-owner-integration.md).

### Util styling and lazy exports use their real owners

Source186 routes existing parseArgs/diff through the native traced lazy DATA capability rather than visible JS accessors. It loads complete pinned styleText/cache/hex algorithms after actual stream/Buffer/TTY/color owners exist; no color/platform capability is fabricated. The existing parseArgs/diff/debounce/throttle algorithms were already genuinely consumed, correcting an earlier incomplete source search. The actual fs.constants generator now allocates a null-prototype object while retaining every SDK-selected definition and numeric descriptor. Native component controls do not execute current guest lazy/constant/GC/realm dependencies or establish four-host conformance. See [scope](../tests/nodejs/outline/util-style-lazy-integration.md).

### RSA transforms retain real key and input ownership

Source187 connects the four pinned public RSA cipher wrappers to actual KeyMaterial and ncrypto::Cipher encrypt/decrypt/sign/recover operations. A rooted immutable material edge and captured original allocation/range survive reentrant padding conversion; bytes are read afterward, preserving callback mutation without a stale view reborrow. Actual provider implicit-rejection admission runs before digest/label/MGF1 checks, with no unsafe fallback. Shared native Error ownership is reused. Native controls explicitly transport genuine native keys through DER because NAPI cannot borrow private guest handles. STORE, guest JSAPI/GC/security/transfer/resize/accounting and complete crypto/four-host evidence remain open. See [scope](../tests/nodejs/outline/rsa-transform-owner-integration.md).

### FFI aliases and environment retirement retain actual ownership

Source188 supplies raw FFI memory operations through the actual guest address space and existing backing-store capabilities. Foreign zero-copy views own alias metadata, never the caller payload or its free authority. Native Buffer creation traces the private prototype rather than calling a replaceable public factory. Main, Worker and destructor fallback share one terminal retirement owner: actual worker joins and native job cancellation/waits finish before FFI unload. Completion is recorded only after those operations return, with final exit status durable on reentry. A blocked join leaves library bytes mapped; interruptible blocking I/O remains an implementation gap. Caller explicit free/close remains unsafe under the target lifetime contract. New JSAPI is uncompiled, and native structural/component controls do not establish guest or four-host conformance.

### Legacy sys loads through the actual builtin record

Source189 loads the complete pinned sys body through the real builtin registry and existing native script compiler with node:sys origin. It returns the actual util object, including shared descriptors and later mutations. The pinned initialization transaction preserves in-progress exports on reentry, clears loading after a throwing warning and retries later; successful initialization records one real moduleLoadList entry. Public CommonJS cache overrides and node: cache bypass continue through the existing loader. The original process.emitWarning call consumes the existing warning owner without new filtering. Focused controls explicitly use native VM/util/filesystem/EventEmitter/tick boundaries and omit the separate broken ESM fixture installation. Guest script/realm/warning and ESM behavior remain unvalidated.

### Async spawn retains real descriptor ownership through preparation

Source190 normalizes supported caller/getter/stdio input before physical pipe acquisition. Fixed own slots adopt both actual ends without a user Array iterator, and rollback closes each owned end while leaving borrowed descriptors alone. Native pair publication defines own elements under its existing cleanup guard. Real ordered child actions perform every stdio placement before closing created pipe sources: a previously closed numeric descriptor may legitimately become valid through earlier allocation, so no liveness precheck or reservation is added. Real acquisition/launch errors retain target sync/async policy and queued errors observe current child metadata. Complete normalization, low-fd remapping, raw error-hook/coercion chronology and post-success stream-adoption/OOM remain gaps. Focused native POSIX controls do not validate new guest JSAPI, kernel or four-host behavior.

### Captured terminal input retains its descriptor and request owner

Source191 routes supported terminal stdin reads through a real captured descriptor and independently nonblocking open-file description. Mode operations share that captured terminal. The native pending read roots its opaque lease and exact Promise; cancellation/ref operations match both, close stops admission before unlink/cancel/release, and completion unlinks before Promise hooks. Promise creation rechecks lease state, and direct read-Promise publication avoids a later packet allocation stranding a request. The curated OS adapter forwards the complete argument tuple; notification forwarding remains pending its real owner. Matched prior native diagnostics establish equal-resource actor agreement, while nine literal restoration nonpasses and the original strict abort remain recorded. Public TTY/StreamBase classes, master/unreopenable behavior and production reactor/GC/realm/guest conformance remain open.

### Public constant modules share actual conditional native definitions

Source192 generates complete pinned conditional OS/crypto definitions over actual SDK/OpenSSL headers and shares existing filesystem/signal objects. The shared binding feeds OS, keys, cipher and lazy public crypto/legacy modules. Pinned initialization preserves object identity, cache/reentry/retry, descriptors and load-order-sensitive defaultCipherList aggregation. Real CLI state supplies its configured value. No saved native-host numbers or capability metadata manufacture support. Actual TLS context cipher policy remains a separate owner. Native dependent controls preserve genuine Errors at key/cipher boundaries, matching the existing production renderer; original plain-record fixture failures are retained. Current raw header generation and unchanged canonical staging are checked independently. New OS JSAPI/CLI publication, TLS policy and four-host conformance remain unvalidated.

### Streaming signatures consume real digest and key owners

Source193 connects complete pinned Sign/Verify and creator algorithms to a GC-finalized native digest state and existing immutable key material. The handle/material edge remains rooted across parsing/getters, byte copying uses checked storage authority, and no JS payload pointer persists in digest state. Actual ncrypto/OpenSSL signs/verifies RSA/PSS and DSA/ECDSA, converts DER/P1363, preserves validation/consumption order and rejects one-shot-only keys for streaming operations. Genuine shared native Errors and source192 constants are consumed. Native key/codec/Writable/TLS boundaries remain explicit controls; one-shot jobs, STORE, provider accounting, production JSAPI and four-host behavior remain unvalidated.

### MessagePort transfer moves real endpoint authority

Source194 connects the public MessagePort prototype to a genuine native reserved-slot wrapper and consume-once endpoint sidecars carried by SameProcess clone data. Serialization removes source authority while a separate context-local close root retains its asynchronous notification. Receiver construction initializes a real unentangled endpoint before committing the incoming queue; failed admission abandons actual owners. Transfer-list order remains stable while ArrayBuffers detach before native host transfers. MessageEvent.ports and Worker startup use the same read transaction. Queue payload retirement occurs outside channel locks. Automatic collection of unreachable transitive packet/endpoint cycles, generic stream transfer and production JSAPI/four-host conformance remain gaps.

### MessagePort transfer moves real endpoint authority

Source194 connects the public MessagePort prototype to a genuine native reserved-slot wrapper and consume-once endpoint sidecars carried by SameProcess clone data. Serialization removes source authority while a separate context-local close root retains its asynchronous notification. Receiver construction initializes a real unentangled endpoint before committing the incoming queue; failed admission abandons actual owners. Transfer-list order remains stable while ArrayBuffers detach before native host transfers. MessageEvent.ports and Worker startup use the same read transaction. Queue payload retirement occurs outside channel locks. Automatic collection of unreachable transitive packet/endpoint cycles, generic stream transfer and production JSAPI/four-host conformance remain gaps.

### One-shot signatures use actual job and input owners

Source195 connects unchanged public one-shot sign/verify algorithms to real retained key material, ncrypto/OpenSSL one-shot or prehashed operations and the existing native CPU queue/captured-frame callback owner. Async constructors snapshot original inputs before SIGNREQUEST init; sync jobs retain actual allocation spans and capture bytes at execution. Real DER/P1363 conversion, context and provider-specific operations preserve pinned admission order. Catchable result-conversion exceptions reach the actual job callback. Native resource routing includes genuine HKDF and signature request classes. A native component ALS/frame group still fails; production guest callback/GC/realm/queue-OOM/fatal behavior is unvalidated, not an accepted boundary.

### TLS defaults configure the actual native context

Source196 adds a genuine lazy TLS public module record over the preconstructed public object. DEFAULT_CIPHERS initializes from actual admitted CLI state independently of mutable crypto.defaultCipherList, and context creation rereads current TLS cipher/protocol defaults. Complete pinned cipher partition/option algorithms feed actual SSL_CTX cipherlist, TLS1.3 suites and minimum/maximum setters before credential operations. Native zero maximum is not substituted for a real TLS1.3 bound. Internal direct connect and HTTPS loading initialize the actual TLS dependency. Full SecureContext, secure Agent activation, underlying TLS lifetime/read/ref/timeout/session/verification and four-host conformance remain gaps.

### Native transit cycles retire from actual ownership edges

Source197 records real external owner slots as roots and endpoint inbox, packet content and transferred endpoint ownership as graph edges. A process-shared barrier marks reachable nodes and fences unreachable nodes as Retiring before native-only payload cleanup outside graph/channel locks; new admission cannot revive retired nodes. Actual wrapper, Worker bootstrap, queue-pop and clone-read scopes retain authority until handoff. Context shutdown fences existing collector batches and every Node loop turn visits the collector even while unrelated timers/I/O keep the loop alive. The process-lifetime metadata sentinel outlives static registry slots without rooting payloads. This source does not implement generic host/stream transfer or prove guest GC/realm/async/teardown behavior.

### Native watch roots belong to the calling runtime thread

Source198 makes the real generic native watch list thread_local. Its JSContext, PersistentRooted Promise/terminal fields, callbacks and poll/unlink operations all belong to the calling runtime thread; Worker contexts run and finalize on their own threads. The correction preserves each existing consumer and prevents cross-thread list publication/poll/unlink. It does not implement a complete callback-free generic numeric descriptor-watch drain, async provider identity or the separately pending TLS/TTY owners. Normal source checks establish source composition only; production JSAPI/concurrency and four-host behavior remain unvalidated.

### Zstd pledged size uses its actual numeric and native error contract

Source199 replaces generic integer admission for both Zstd modes with the exact primitive-number, safe-integer then nonnegative policy. Undefined keeps the actual unknown-size sentinel; negative zero remains valid and fractional values cannot truncate. Actual CodecInit consumes the shared portable policy and creates genuine intrinsic TypeError/RangeError values with native messages/codes. Ordinary code assignment invokes inherited setters and ignores a nonthrowing false result; checked throwing-setter failure remains fatal as in the pinned native API. Real codec, byte, stream and async owners remain in place. Component native InitStream is an explicit dependency and does not prove guest initialization chronology, setter counts or JSAPI/realm/GC behavior.

### Native bridge declarations follow their actual owning namespaces and APIs

The normal selected199engine build reached native compilation and failed. Source200 supplies the transit Root dereference required by its real bridge caller, removes an unintended nested anonymous namespace in native ports so forward declarations and later global js::shell registry types share their intended scope, and uses the actual SpiderMonkey140 JS_InitClass and PropertyKey::Symbol signatures for DynamicLibrary. No access checks, native owner state or target assertions are removed. Current portable ownership controls pass; complete engine200compiler/link/cache acceptance and runtime conformance remain pending.

### Captured terminal reads retain their native callback resource

Source201 gives captured terminal I/O leases actual async IDs, trigger/frame ownership and once-only retirement. Read readiness retains its real lease and callback, unlinks before JavaScript reentry and enters the shared native callback/recovery scope. The fd-readable adapter consumes native start/stop/ref operations without manufacturing an extra read Promise. Mode-only leases remain separate. Public tty constructors, shared Socket/StreamBase adoption, WriteWrap and precise failed-init/close ordering remain incomplete. Focused PTY controls use genuine native dependencies; new guest JSAPI is uncompiled and all-four-host behavior is unvalidated.

### SEA identity belongs to its actual compiled executable image

Source202 consumes the pinned Node/Postject compiled-image fuse detector and unchanged public sea.js algorithms. The detector reads actual image data rather than argv0, process.execPath, outer host state or a JavaScript capability flag. Ordinary asset calls use real candidate validators/errors and retain their prescribed admission order. Marked-image module activation fails explicitly while resource/startup ownership is unimplemented; the unsupported resource finder is not used as a Wasm asset provider. Positive SEA packaging/format/injection/assets/VFS/startup and guest execution remain gaps. The guest binding and normal paired registration are source-only and uncompiled.

### TLS transport authority follows a real captured native owner

Source203 replaces recyclable numeric TLS handles with a context-checked foreground owner holding an immutable generation, real SSL_CTX/SSL and captured descriptor lease. TCP transfer refuses active reads/requests, performs allocation/getter/Promise work before descriptor commit and retires only the now-empty source. Paired bootstrap keeps native authority in a private WeakMap and can close an in-progress handshake. Separate thread-local rooted watches detach before publication and retain actual consumed byte/count/error material if publication fails. This D01 lifetime differs from full Node TLSWrap: early construction/retained TCP parent/onread/ref/timers/sessions/HTTPS remain real gaps. Native portable controls do not prove new guest JSAPI behavior.

### TLS reads retain their consumed material until the real consumer acknowledges it

Source204 gives each actual TLS read a stable native allocation and generation/sequence. SSL_read produces distinct plaintext, close-notify EOF and actual errors; errno/SSL_get_error/OpenSSL material is captured immediately. Failed publication retains the same result rather than replaying I/O. The paired bootstrap consumes bytes before acknowledging the actual settled Promise; stale acknowledgements cannot retire a newer read. Closing SSL/descriptor state preserves material retained by in-flight tickets. This is not a full Node TLSWrap/onread/AsyncWrap or idle guard: real early TCP/TLS construction, retained parent readiness/ref/controls and HTTPS remain incomplete. Portable native controls and actual forwarding references do not establish new guest JSAPI/four-host behavior.

### Structured clone receivers follow the actual declared host order

Source205 introduces a private SameProcess version2order table with real native transfer-map indices and local JavaScript constructor indices. Reader preflight validates complete descriptors, exact native custom slots and unique JavaScript coverage before invoking constructors. A noncopyable phase owner creates receivers around successful native reads and finalizes payloads under the same frozen schedule. Packets contain no JS roots/pointers or public registration token; receiver roots stay context-local and existing native transactions retain rollback. Version1 remains readable; sender/reader artifacts must be coherent. This prerequisite does not admit generic registered JavaScript senders or establish Web Stream/Worker transfer conformance.

### Native signature references use the target callback-frame owner

The one-shot signature reference fixture must use the actual target CryptoJob callback path. Pinned AsyncWrap supplies its captured frame to InternalMakeCallback; the public C++ AsyncResource callback path used by the old fixture resets that frame in this exact reference. A standalone no-Kandelo experiment records the observed difference without attributing a formal runtime defect. The corrected control captures the real continuation frame immediately before init and calls the exact pinned private overload with genuine IDs/resource/destroy ownership. No Environment layout, fabricated metadata, bound callback, production fallback or runtime source edit is introduced. Exact native binary/header/declaration pins confine the private dependency to control tooling. Guest captured-frame/GC/realm/fatal/worker conformance remains separate.

### Registered clone senders retain actual graph and commit ownership

Source206 admits privately registered transferable JavaScript hosts after whole-list validation, discovers nested real native/private hosts without repeating mutating admission, preassigns context-rooted graph identities and serializes payloads through the original graph memory. All ArrayBuffers detach before host commits; frozen combined order interleaves real JS transfer hooks with actual native endpoint moves. A checked callback/closure observer records logical registered moves in the owned packet sidecar so Broadcast cannot repeat-read such transfers. There are no cross-thread JavaScript roots or public brand tokens. Real drop/no-result/deferred-error/Worker publication outcomes are still separate missing owners in this slice; seven callback observations match native and two remain explicit nonpasses. This source is not compiled guest or full stream/Worker conformance.

### Clone publication and Worker startup retain actual outcomes

Source207 keeps success, absent serialization result and prepared data with a deferred sender exception distinct. Same-context roots retain the original exception/stack until the consuming caller owns publication or receiver precedence; cross-thread packets contain no sender JavaScript roots. Worker user argv, entry, workerData and environmentData share one real LOAD graph, separately from early native environment/CLI metadata. An interruptible native gate owns the two packet slots and waits honestly when LOAD is absent. Decoded startup applies actual array-like argv and the captured loader entry before ready/user execution. Reentrant ArrayBuffer detachment creates a real empty backing store for the outer transfer slot, retaining the original allocation with its inner owner. New guest C++ remains uncompiled; public Worker channel/init/loader/stdio/ref/error and generic transfer gaps remain.

### Committed descriptor readiness retains its propagation scratch

The actual shared EpollInstance owns its notification marker. The existing backing-table lock serializes epoch assignment and the complete direct/nested cascade, without temporary vectors or provider callbacks. Wrap clears only private scratch before safely reusing the nonzero marker; existing pending events, interest masks, exclusive selection and delivery rechecks remain owned by their original instances. This corrects producer commit safety in existing descriptor readiness, not a performance claim or public file-notification activation. The current source matches698 frozen native inputs and26 affected native cases pass; no new Wasm kernel or four-host execution is established.

### Test discovery and execution consume the actual shared test tree

Source208 consumes pinned runner discovery and run algorithms over the real shared Glob, resolver, test tree and TestsStream owners. Explicit isolation:none drives actual setup, module import, test registration, hooks, cancellation and failure reporting. The original file URL enters the native module graph once. Public option validation precedes explicit missing-owner admission before root/resource creation for process isolation, watch, measured coverage and CLI launch; these remain implementation gaps, not accepted platform limits. Native dependency controls execute the actual generated JavaScript test tree, not a manufactured result stream or production host passthrough. Guest parser, async/realm/GC/lifecycle and four-host conformance remain unvalidated.

### Module import completion retains the resolved request and actual module

Source209 forwards the original converted specifier, parent and raw attributes into the native module graph, retaining the actual rooted ModuleObject and import promise through evaluation and top-level await. Completion obtains its genuine namespace without a second resolution or a reconstructed type-only request. The same actual ModuleRequest keys a weak resolve-to-record transaction so replacement attributes and supplied source survive without reading original type getters or aliasing same-URL requests. Empty primitive specifiers reach the real Node resolver/error owner. Existing ordinary syntax delay and separate VM handling remain; realm-wrapped request marshalling, GC/fatal/job/cache and guest conformance are unvalidated. Native-dependent controls establish JavaScript forwarding/graph behavior only; no production host fallback or fabricated namespace is introduced.

### Transfer discovery retains admission ownership across user hooks

Source210 retains actual admitted JavaScript/native/ArrayBuffer kind beside the existing rooted transfer registry. Later nested hooks cannot revoke or repartition an admitted host by changing its private mode. New nested items still undergo their own current admission and later main-graph classification/actual commits remain unchanged. Non-Node append uses the original path without allocating enum metadata; Node-configured UnknownDestination may later become SameProcess, so scope is not used to decide vector membership. The metadata contains no GC values or cross-thread roots, reports its allocation failure and rolls back a paired append. Source/style/replay evidence and native reference observations do not establish guest C++/GC/realm/fault conformance.

### Early SSL preparation retains real TCP transport authority

Source211 prepares actual SSL state over an actual empty TCP owner before DNS/connection attempts. TCP retains its descriptor while SSL binds that captured parent; a checked native parent edge roots the TCP object through real request retirement. Parent close invalidates SSL before descriptor reuse, and native requests hold its queued-close barrier. TLS ref/unref reaches real parent/watch ownership; raw TCP reads/writes cannot compete. Cancellation releases prepared authority and fallback creates a fresh parent/SSL pair. This is a partial prerequisite using fd BIOs and context-owned Promise/read tickets: public Socket/TLSWrap construction, TLSWRAP AsyncWrap/StreamBase/memory BIO/onread/timer/session/verification/HTTPS owners remain incomplete. Portable header controls and extracted recording-boundary JS do not prove guest JSAPI/four-host behavior.

### Socket construction initializes the actual inheriting receiver

Source212 initializes the real Socket receiver through pinned callable/new validation, option normalization and Duplex ownership. Receiver state resets before option spreading; supplied existing TCP handles preserve their actual native reference state and failed binding leaves the real partial receiver authority, while new internal acquisitions roll back. Reinitialization does not close an independently retained old handle. A checked read-only native validator admits actual TCP state before mutable JS binding. Manual start, read/stop and original encoding flow through real stream/native owners; no method-name or TTY-shaped object satisfies admission. Existing retained TCP/TLS owners remain byte unchanged. Full kind-generic StreamBase/TTY/TLSWrap/lifecycle/guest conformance remains incomplete.

### Captured TTY reads retain consumed material until callback admission

Source213 retains each actual captured-terminal read allocation, generation, sequence and result until prepared callback admission. Stopping readiness retains consumed bytes; pre-admission failure retries the same material. Native watches retain their actual TTY owner and request count through callback, after-hooks and job unwind. Close stops input and releases only captured descriptors, then queues owner retirement and its callback behind in-flight requests. Stdio input consumes this configure/onread/start/stop/ref seam through shared stream state without a private read Promise. A realm-keyed prototype map belongs to the live async environment. Public tty constructors, kind-generic admission, writes/shutdown, early-init order and complete StreamBase behavior remain gaps. Portable components/native-backed JS controls do not validate the new guest JSAPI or four-host runtime.

### Tracing categories and output belong to the actual guest process

Source214 adds a process-shared native category multiset and actual descriptor-backed trace sink, consumed by unchanged pinned trace_events and existing Console producers. Categories, file ownership, PID/TID and monotonic timestamps come from real native state. The sink handles actual short writes/EINTR, sticky errors, lazy file creation and once-only close. Public Worker contexts share process trace state while public createTracing follows pinned main-owner admission. Main teardown finishes the sink after public Node Workers join and native producers retire; this does not establish joining every shell extension thread. Failed-open native timeout remains a differential nonpass. Guest JSAPI/teardown, complete producers/metadata, CLI/file rotation/permissions/Perfetto/inspector and process.report schema remain incomplete.

### Notification source composition preserves dormant activation

Current source214 composes dormant queue, descriptor and retained opened-dentry owners over the existing shared epoll prerequisite. The detailed ownership and activation limits are in the descriptor and opened-dentry prerequisite notes above; all public inotify slots remain ENOSYS. Same engine214 recipe, unchanged program ABI/snapshot/channel source and existing version20 tags do not establish dynamic guest baseline acceptance. Host wake, full producers/metadata/watch policy and coherent public/fork activation remain implementation gaps.

### Empty tmpfs writes preserve the actual file state

An empty tmpfs positioned write validates its real handle, offset, inode type and mutable state before returning zero. It does not reserve quota, grow a sparse file, change timestamps/mode or advance content generation. Nonempty write and failure paths retain their existing owners. Four direct native POSIX/control cases and45 affected native cases validate this source fix; current Wasm kernel and four-host behavior remain unvalidated.

### VM dynamic imports retain their actual compiled source owner

Source215 associates real compiled Script/function code with its actual source-private owner and rooted import registry. Instantiations and nested functions retain original public referrer identity and callback through the real ScriptSource private slot. Dynamic imports preserve the original ModuleRequest/attributes and settle the actual import promise through a native transaction/reaction owner. One lazy pinned VM-module frontend shares brands and callback wrapping; actual explicitly supplied internal option IDs retain their eligibility without spoofing the public module flag. Complete pinned makeContextifyScript is consumed and privately published for future REPL use. Default-loader/context-wide eval callbacks and REPL activation remain incomplete. Native dependency controls do not execute the new guest Stencil/GC/realm/reaction bridge.

### Process capture suppression is real native environment state

Source216 consumes unchanged pinned primary/additive/has capture functions and fatal handler. Their suppression writes target an actual rooted per-environment Uint32Array read by native fatal admission; CLI policy is parsed before environment creation and native Worker kind disables it. Native reads enter the owning realm and consume data entirely inside a no-GC scope. Environment teardown retires the root. Primary precedence, reverse auxiliary strict-true handling and reportFlag mutation order remain pinned. The native candidate fixture supplies real Node fatal/ALS/Worker/report owners, so it does not establish guest report-provider behavior or native JSAPI lifetime. Guest libc SIGABRT versus pinned default V8 hard_abort SIGTRAP, fatal diagnostics/timing, existing getter-throw exit mismatch and full guest/REPL behavior remain open.

### Reactive backing reads reuse the real retry and completion owners

Managed blocking FsNotify/eventfd reads retain actual typed backing identity and the existing exact OFD/task/channel generation through RetryOp. Actual queue insertion and successful eventfd mutation publish only matching live retries into pre-admitted dirty storage without allocation at publication. Existing settlement re-executes the real syscall and completes through the existing wait protocol. Exact requests beyond bounded kernel storage remain with the prior host retry; inconsistent snapshots remain errors. Native runtime compilation and two real producer/park/pinned-read controls pass; the kernel passes a Wasm typecheck without linking. Host-owned poll/select/epoll, timerfd deadline refresh, metadata, public watcher activation, fork/ABI admission and four-host behavior remain unresolved. No wire field, export, ABI pin or platform identity changed.

### Blob construction preserves conversion and byte-snapshot order

The existing shared WeakMap Blob byte owner consumes the complete genuine WebIDL source sequence before dictionary validation/options getters and BufferSource copying. Endings/type getters run once; endings validation precedes byte assembly and type coercion follows it. A later source string coercion can therefore mutate an earlier real byte source before its snapshot, as pinned Node does. Blob.slice consumes the same long-long WebIDL conversion and real private byte span without calling mutable public subarray/species. Nineteen native-dependent groups match; their native validators/brands/encoding/streams/clone helpers are explicit fixture boundaries, not guest proof. The unchanged upstream Blob test still fails on missing custom inspection; full Blob/File/clone/stream/realm/GC/worker behavior remains open.

### Public abort consumes the real signal-death owner

The main public process.abort is the actual named native function rather than a JavaScript numeric exit wrapper. Its real engine entry prints executing frames and calls the shared libc abort owner without normal exit listeners or shutdown. Workers consume the pinned unavailable factory after real values/error initialization, with a separate native context guard. Actual shared-header tests exercise native libc SIGABRT, while frontend controls depend on actual native Node abort/errors; neither proves the new guest JSAPI or guest musl/kernel/parent wait path. Exact abort diagnostics/native stacks/core dump, separate uncaught hard_abort signal behavior and four-host acceptance remain open.

### Circular CommonJS exports retain pinned warning and cleanup ownership

Actual unfinished CJS cache hits consume the complete pinned warning/prototype admission and real isProxy owner. Successful loading alone removes that warning prototype when it is still the original; failed loads retain it on escaped partial exports while cache/children rollback remains real. The existing unsupported pending-ESM admission is retained without inventing native module status. Independent review caught a redundant public loaded getter in that private adaptation; the integrated correction reads it only at the actual caller, preserving observable accessor/error/exports order. Thirteen native-dependent groups and an unchanged upstream file per subject pass through current generated owners over explicit native VM/filesystem/URL/proxy/warning dependencies. They do not prove guest loading, warning lifecycle, ESM or four-host conformance.

### Decoder rollback preserves successful work and retires completed state

The shared decoder owns pending bytes/code points and successful BOM state. A streaming failure clears partial decoder state and preserves the BOM decision committed before conversion. That snapshot follows the stream getter because it can reenter the same receiver. Completed nonstream decoding uses its established BOM decision for current output, then retires state before return; fatal nonstream decoding also retires state. This corrects two review-discovered reentry regressions in the original proposal.29native-dependent groups across two component modes and four unchanged upstream files per three subjects pass. Native conversion/VM/byte dependencies are explicit; full repertoire/options/input/prototype/guest/four-host behavior remains open.

### Failed stdio publication retires its captured TTY output

The real borrowed-stdio writable factory acquires a captured TTY output before evaluating options and constructing Writable. Failed construction or inner publication now invokes the existing captured-owner close and preserves the original thrown value even when cleanup fails. It does not close a public descriptor number or its replacement. Successful write and stdio dummyDestroy retain the existing owner. Six native PTY component groups pass using actual current generated factories and real OutputHandle; native direct close/Node Writable/errors/NAPI are explicit fixture boundaries. Guest queued-close/async lifecycle, outer bootstrap bind failure, native close-root OOM/init rollback and full public TTY remain open.

### Buffer view and JSON behavior consumes the pinned byte owner

The existing Buffer byte installer now consumes the complete pinned toJSON/adjustOffset/subarray/slice section. JSON reads genuine typed storage without a mutable public iterator. subarray uses the lexical real FastBuffer constructor over the actual public buffer/byteOffset in target order, avoiding species lookup; slice deliberately dispatches the public subarray as Node does. Existing prototype/class and backing owners remain. Fourteen native-dependent groups and two unchanged upstream files pass; native byte/brand/value/codec/VM dependencies do not prove guest constructor/realm/GC/shared-storage or four-host behavior.

### Test filters use actual CLI state and shared UTF-8 string ownership

Repeatable test-name and test-skip options now flow through the actual native argument parser, persistent CLI arrays and existing pinned Test/Suite regular-expression filtering. Node CLI string/list and eval publication uses the existing owned UTF-8 replacement decoder independently of locale; generic shell narrow conversion and raw parser/filesystem byte authority remain separate. Fourteen parser comparisons, ten successful test-tree scenarios and one exact regular-expression error match the pinned native reference using explicit native component dependencies. Separately retained decoder material controls cover34groups under C/POSIX. New guest JSAPI glue is uncompiled; full CLI/launcher, process isolation/IPC/watch/coverage, raw file loading, GC/Worker and four-host behavior remain open.

### Socket finalization distinguishes an absent owner before shutdown

The shared Socket bootstrap now completes the existing Writable final callback when its private native-owner association is absent, after preserving the connecting defer. Acquired or closed resources still follow their existing shutdown path independently of mutable public descriptor fields. The real Socket prototype consumes the complete pinned destroySoon method through the normal source selector, preserving end/finish/destroy dispatch. Seven native-dependent groups compare descriptor/error/return behavior and actual buffered TCP EOF bytes, including repeated and already-finished destruction. Native WriteWrap/ShutdownWrap/VM/stream owners are explicit fixture dependencies; production asynchronous shutdown, connection/reuse generation, mixed writes, TLS and guest/four-host semantics remain open.

### SQLite statement statistics read and reset actual VM counters

Statement.stat and resetStats now consume the real sqlite3_stmt_status owner with nine pinned names/macros, preserving memory usage while resetting the other counters without rewinding execution or an iterator. The existing generated limits header also carries the exact pinned status mapping; statement column names continue to come from the live SQLite VM after reprepare. Public stat admission checks receiver and finalized state before inspecting a present argument and avoids inherited index getters for absent arguments. The actual native error factory now selects TypeError for ERR_INVALID_ARG_VALUE. Eleven identical-header native-owner cases and eight current generated frontend groups pass with explicit native SQLite/VM/error dependencies. The new guest error bridge and full SQLite/four-host behavior remain uncompiled or unvalidated.

### Child exec collection owns output, limits and callback completion

Public exec/execFile now consume complete pinned normalization, output collection, byte limits, timeout, errors and custom promises over the existing real spawn owner. Separate output streams retain their actual decoder or Buffer bytes; callback/error/close handling and Promise.child preserve original identities. Caller stdin remains under caller/child lifecycle ownership, and exec reads the actual public execFile at call time. Twenty-three current bootstrap component groups and four unchanged upstream files on native/candidate pass with explicit native spawn/stdio/Buffer/timer/error/VM dependencies. The original fixture timeout came from native spawn, not the old guest collector; its corrected evidence interpretation is retained. Lower guest spawn/options/signal/abort/pipe/wait/fatal/realm and four-host obligations remain open.

### Promise timers share real construction and insertion ownership

The normal core generator now consumes the complete unchanged pinned timers/promises module over genuine shared Timeout, Immediate, insertion and cancellation owners. Timeout construction creates its async owner without scheduling; classic and Promise callers insert once, keeping delay separate from actual monotonic origin and truncating duration before the native provider. A lazy real EventTarget dependency preserves bootstrap initialization order. Getter/error order, protected abort-listener cleanup in Promise reactions, interval cancellation and Scheduler behavior come from pinned algorithms. Eighteen current component groups, four unchanged upstream files on both subjects and two actual unreferenced-exit controls pass with explicit native scheduler/ref/clock/Promise/EventTarget/VM/context dependencies. Guest scheduling/GC/fatal/Worker and complete async/four-host conformance remain unvalidated.

### Import metadata retains lazy data cells on its actual owner

The native module loader passes its actual metadata object to the shared initializer and skips eager property copying when that same owner returns. Filename and dirname use genuine native lazy DATA cells, captured real URL/conversion authority and the pinned final-separator algorithm. Existing eager require extension and legacy record/default-shell behavior remain separate. Seventeen current native-dependent groups verify bounded path-property semantics against actual native ModuleWrap metadata using the existing V8 lazy-reference dependency. The changed SpiderMonkey bridge and guest cell/URL/CJS/GC behavior remain uncompiled or unvalidated; main, resolve, full metadata and source-map stack/cache prerequisites remain open.

### Connected socket shutdown retains its real request and descriptor owner

Connected Socket finalization now consumes pinned net shutdown algorithms through a real foreground-GC native request and retained owner. Actual POSIX shutdown waits for prior writes and their callbacks; later writes are refused, and closed-owner cancellation cannot substitute a reused numeric descriptor. Request initialization, callback frames, completion, close barriers, resource reporting and teardown use existing native ownership paths. A corrected close-completion marker distinguishes an actually completed close from a queued close before init hooks. No-owner completion and connecting deferral remain. Nine frontend comparisons, seven portable owner groups and seven destroySoon regression groups pass over explicit native dependencies; unchanged owner controls execute1424assertions. New guest JSAPI/fullSocket/TLSWrap/fourhost behavior remains uncompiled or unvalidated. Explicit ::socket also fixes the real combined-unity namespace collision.

### Eval builtin bindings share the actual Module and require owner

Main-thread eval bootstrap now consumes the complete unchanged pinned addBuiltinLibsToObject helper through the existing Module/require/cache owner. The native CLI parser separately records actual eval-option presence while retaining raw evalSource text; explicit separate empty eval differs from absent eval, and Worker startup cannot borrow main eval admission. Lazy descriptors, successful retention, failed-load retry and original assignment/errors follow the pinned helper. Fourteen current native-dependent comparisons, four production source-guard cases and one unchanged upstream file with native/helper-selected subjects pass over explicit native VM/fs/URL/package/builtin/REPL dependencies. New C++presence, guest evaluator/Module/GC/realm behavior and four-host conformance remain unvalidated. Inline-empty --eval= admission, --print and public REPL/Inspector remain implementation gaps.

### Main stdio resize consumes real signal and captured output owners

Lazy main TTY stdout/stderr now subscribe by the compiled SIGWINCH name through the existing process first/last SignalWrap owner. The real stream is cached before listener registration for same-stream init/newListener reentry; failed publication removes only its observer and closes only the acquired captured output owner, preserving original errors and borrowed/replacement public descriptors. Actual captured size queries and pinned change-only refresh methods drive resize. One native public resize group and seven current source components pass over explicit native libuv SignalWrap, streams, VM and OutputHandle dependencies. Cross-stream initialization, early fd/bind reentry, actual guest self-pipe/queued close/ref/GC/fatal/Worker and full public TTY classes remain open. This directly addresses terminal T-008; T-010 is only a shared prerequisite. New consumer/bootstrap source is not embedded in accepted230.

### Symmetric key generation owns real entropy and native work

Public generateKey/generateKeySync now consume complete pinned HMAC/AES generation algorithms over actual SecretKeyGenJob/KEYGENREQUEST ownership. Existing CPU work queues capture frame/prototype/callback and create actual ncrypto entropy storage; production moves its original DataPointer into the existing KeyMaterial/KeyObjectHandle owner. Validation/getter/callback/bit-length/error order is pinned. Sixteen fresh native-dependent comparisons, one unchanged upstream file with native/candidate subjects and14package checks pass. Native V8/uv/InternalMakeCallback, copied native KeyObject adoption and native OpenSSL3.5.9 exports are explicit control dependencies, distinct from uncompiled guest JSAPI and guest library configuration. Shared outer publication/MarkPop, full AsyncWrap inheritance, keypair/WebCrypto and all four-host behavior remain open.

### TLS writes retain ownership through consumer callbacks

Actual TLS writes now retain their original capability/generation/request/material until the JavaScript consumer acknowledges its callback. A non-owning per-state write index remains visible while dispatch tickets are temporarily unlinked for Promise publication or close batches; acknowledgments mark active native frames and retire only safely linked tickets. Both production write consumers acknowledge in failure/throw paths. Admission failure retires SSL before releasing retry material. Five source-backed components over genuine native TLS and an explicit record-only acknowledgment seam pass; new native C++ index/root/provider/GC/lifecycle behavior remains uncompiled and unexecuted. Public TLS _final/close_notify/native callback providers remain separate implementation gaps. The merged agent-integrate tool applied five source files, imported two real check receipts and journaled the source checkpoint before domain state updates.

### Native key jobs remain owned through packet publication

A real request-publication transaction now roots the freshly allocated native job and its exact state before init hooks. Creator wrapping and outer value/error packet allocation/property publication remain inside that transaction. Only successful actual return-packet publication commits; failure retires only the same still-preparing request. Already dispatched/work-owned/retired state is preserved, so reentrant queue admission retains callback/frame/result ownership. Cleanup enters the actual owner realm and changes no pending exception. Existing key factories that register no request remain unaffected. Six normal source/staging checks and14package tests pass; no new runtime, fault-injection or C++ execution is established. The generic integration tool journals exact reviewed source and both check receipts before Node-specific state changes.

### TLS resources retain their actual async owner until finalization

Native TLS allocation now assigns its real TLSWRAP identity and default trigger, captures the actual async frame and environment, and emits init before SSL creation and parent attachment. Reentrant init rollback cannot resurrect a closed owner. Read, write and close consume that same resource; SSL close preserves its identity until foreground wrapper finalization queues destroy. Nine portable-header assertions and three separate native Node lifecycle references pass, alongside source staging and fourteen package-input checks. These controls do not execute the new guest JSAPI or establish TLS shutdown or four-host conformance.

### HTTP connection lists track the actual native request parsers

HTTP request parsers now join a real shared native ConnectionsList with intrusive all/active membership and monotonic header/request deadlines. Queries temporarily root the actual moving parser identities before JS result allocation; list membership does not retain otherwise dead parsers. Foreground finalization detaches membership, and checked cross-realm denial reports an actual access error. Ten portable-list comparisons, seventeen request/header groups and twenty-five unchanged response cases pass using explicit native Node dependencies; these do not execute the new guest JSAPI. Deferred Body/Complete ordering, parser reuse and public HTTP Server remain incomplete.

### TLS certificate getters retain independent native X509 snapshots

TLS certificate access now snapshots actual peer/local SSL certificate material with the pinned clone/get1 ownership rules and preserves supplied issuer order in an acyclic owned graph. Native handles feed the existing branded X509 wrapper and per-instance cache; no SSL or context pointer survives in certificate material. Current public methods use real TLS capabilities, including configured local access before handshake. Eight native-dependent owner groups pass, with five source/staging checks and fourteen package-input tests. Positive server client-certificate get1, new guest JSAPI/GC/realm behavior, full handle interception and shutdown remain unvalidated or incomplete.

### Performance milestones record their actual lifecycle events

Node timing now reads the actual per-owner monotonic clock and marks native entry, environment creation, pre-user bootstrap completion and final natural loop exit at their owning seams. Existing loopStart and idle accounting are preserved; explicit or fatal exits do not invent a natural loop-exit mark. v8Start stays unset because the guest runs SpiderMonkey. A real Worker bootstrap/loop ordering mismatch remains documented. One portable clock program and four pinned-native lifecycle references pass, alongside source staging and package-input checks; new guest hooks remain unexecuted and Observer queue/GC behavior is unchanged.

### Clone configuration preserves every native hook

The curated SpiderMonkey adapter forwards every clone configuration argument to the existing native receiver. The previous five-argument wrapper dropped nested transfer discovery, so the six-argument native callable validation rejected guest bootstrap before user code. Native validation remains intact. A permanent forwarding component control checks hook identities, receiver, invocation and error propagation; it does not execute SpiderMonkey. Actual guest startup, clone/stream/Worker lifecycle and all four hosts still require identified-artifact validation.

### FileHandle close owns a descriptor lease

FileHandle adoption, synchronous close, foreground GC and queued close use one move-only native descriptor lease. Queue admission transfers authority before publication; unperformed cancellation restores the lease before clearing its rooted parent, while performed close consumes it exactly once. Numeric fd observations do not create a second owner. The normal engine recipe stages the real header. Public transfer remains disabled in this prerequisite; native clone sidecars, receiver init/rollback and Worker retirement are a later slice. Portable native fd/OFD/thread controls and pinned Node references are not guest workqueue or four-host proof.

### FileHandle clone packets move the descriptor owner

The registered FileHandle transfer path now consumes actual native class/environment admission and a single-use move-only descriptor sidecar in the existing same-process clone transaction. Receiver-local allocation/root capacity precedes the lease move and actual FILEHANDLE init; rollback closes only a still-state-owned lease, leaving a reentrant queued close authoritative. Packet discard and Worker/context retirement release material without crossing JS roots between threads. Pinned public hooks consume the real owner and preserve whole-list/AB-first semantics. Guest process sharing is traced through musl/kernel CLONE_FILES and actual shared fd/OFD tables, not embedding host PID. New native JSAPI and guest lifecycle remain uncompiled/unvalidated.

### Owned SQLite database images

Source242 connects the existing SQLite connection/statement owners to real sqlite3_serialize and sqlite3_deserialize. A temporary image owns allocator memory through export/copy; deserialize captures actual byte length before options, copies current storage afterward, finalizes existing statements before replacement and relinquishes the FREEONCLOSE allocation at actual SQLite entry. Fresh generated-root JavaScript/native-dependent controls, unchanged upstream cases and portable allocator controls are scoped evidence; new guest JSAPI and all-host behavior remain uncompiled/unexecuted.

### Captured TTY writes retain original material through real request ownership

Captured output leases consume real writev progress over original backing capabilities. Actual queued WRITEWRAP identity, frame/default trigger, completion/cancel and close barriers remain source work until compiled and validated. Closed/retired input gates and indexed all-buffer preparation preserve pinned native phase and species contracts. This does not activate public tty constructors or full StreamBase.

### VM script encoding uses actual compiled owners and resolver build identity

The compiled Script owner retains the real Stencil, source and debug metadata for trusted encoding. Its generated engine identity consumes the exact resolver content key; real child-recipe tests cover both resolver policies and invalidation. Publication uses genuine private FastBuffer storage and preserves native metadata-setter failure ordering. Arbitrary public cache decoding remains unimplemented pending a safe validator; native Rust proof is separate from the uncompiled guest JSAPI.

### Guest Node WASI descriptor ownership prerequisite

Partial actual guest WASI four-descriptor import ownership only:29source owners/17missing, distinct from existing outer host WASI shim. No nested backend activation, API/family closure or guest/four-host conformance. Source245actualWASI four-fd owner and current generated JS over explicit native V8/NAPI/memory/POSIX dependencies:16native/16candidate fixturegroups plus6portable fd groups/80allocation trials. New guest JSAPI/realm/GC/fatal/Worker/backend/fourhost behavior remains uncompiled/unexecuted; all other native-integration gaps stay open. Allocation follows actual pinned selected fallback, timestamps use exact flag/omission/whole-second policy, renumber moves one real fd/rights/preopen row after actual destination close, and readdir uses real stored-path enumeration/cookies/truncation/cleanup/current memory. Advice remains absent; ABI28vs61 and8setupfailures remain explicit. Selected source/precompiled checks do not establish a complete global resolver cache key.

### Captured TTY I/O ownership and close phases

Source 246 has actual shared captured TTY IO and source-reviewed close/retirement phase corrections. Current root generated JS passed two real native Node TTY/WRITEWRAP component subjects, each matching 1026 PTY bytes; corrected portable IOHandle passed two groups. configureWrite remains validation-only. New guest native code, public constructors and four-host conformance remain uncompiled/unvalidated. The same captured descriptor backs existing reads/writes/window/mode/blocking operations. Real successful normalized mode persists until wrapper retirement, while retired raw/window/blocking methods preserve pinned conversion/error order. Only seven descriptor-use sites change; WASI, VM build-ID, private FastBuffer and prior TTY material ownership remain intact.

### TLS encrypted-output and publication ownership

Source 247 adds a real retained memory-output BIO and captured TCP write/receipt owner, with source-reviewed per-watch output completion independent of Promise publication. Current checks re-executed one portable primitive with seven annotations and two TLS protocol subjects; both decoded-byte comparisons matched. Extracted original/intermediate/refined policy statuses are 15/27, 19/27 and 27/27. Supplied Result/Promise state is not actual guest Promise/OOM/pump execution. New guest C++ and four-host conformance remain uncompiled/unvalidated. Actual normal staging preserves VM, all seven shared TTY descriptor routes and shared write material. The executable build script required an explicit guarded manual boundary; no V1 operation is claimed.

### EventEmitter unhandled-error ownership

Source 248 changes only the EventEmitter unhandled non-Error helper and recipe revision. Ten native groups compare against actual current Values/EventEmitter source: before matches three and differs on seven with one real exit-one assertion; after matches all ten. One unchanged upstream file has three assertions per subject, and early owner-independent construction/ordinary/same-Error controls are separate. Native Error/inspection/VM/process dependencies do not execute candidate inspection/engine/stack/fatal/GC or establish four-host conformance. Core, canonical engine and executable build script are unchanged. No new compiler or engine patch is introduced.

### Retained native codec capacity ownership

Source 249 adds actual retained native codec state/context/vector/string capacity and idle reporting boundaries. Normal source checks verify two generated headers and five concrete accessors. The reused real generated-context component passes seven groups over actual native codec APIs, worker threads/std mutex and libc++19. Declared guest libc++21, production JSAPI Report/GC, finalizers/error paths and four-host behavior remain uncompiled/unvalidated. Requested retained capacity is not RSS or Node heap graph parity. Shared recipe/build-script edits preserve newer TLS input/staging and mode 0755. Core and canonical engine are unchanged; the executable script required an explicit manual boundary, not a V1 operation.

### HTTP request callback and private byte publication ownership

Source 250 integrates real request Body/Complete synchronous llhttp callbacks and noncoercing private FastBuffer publication over already independent native bytes. It contributes partially to H-003 and shared H-001/H-013 dependencies. Production core is regenerated normally; no component-expanded core is installed. Actual source checks guard904inputs/16checks/eightcommands; portable9, factory5, headers17/18,14incoming and two poison modes/four subjects use explicit native dependencies. Separate unchanged-file headers Vitest has six failures due to a missing _createNodeHttpAgent fixture dependency; these are harness errors, not passes or unsupported cases. Guest JSAPI/GC/realm/provider/full Server/reuse/stack/shared-input/four-host behavior remains unvalidated.

### Asymmetric key generation and native private-role admission

Source251 adds actual public asymmetric generation over complete pinned wrappers, five real ncrypto/OpenSSL traits, KEYPAIRGENREQUEST/native CPU work and GC-owned immutable key roles. Fresh current-root source checks guard908inputs/8checks/8commands;16paired native/candidate differential groups and4unchanged upstream files per subject use identified native dependencies. Newly integrated guest JSAPI/work/publication/GC/realm/fatal/private-role guard and all4hosts remain uncompiled/unexecuted; valid-private ecPkcs8 remains missing. No crypto/API/finding closure.

### Private FD input byte publication ownership

Source252adds private FastBuffer publication of actual native input Uint8Array spans on generic Promise, terminal Promise and terminal callback paths, with captured intrinsic buffer/offset/length getters. Bootstrap supplies the real private constructor; fixtures correct their actual native producer shape. Actual normal source check908inputs/6checks/8commands and manually reviewed real pipe/PTY controls pass: native9/candidate9, short offsets2/prior4. Baseline3valueOf fatal exits and6correct-byte extra-copy observations remain distinct. Original V1 source check failed only from harness variable shadowing after publication commands succeeded; it remains a terminal harness-error operation, never completed. No package/Vitest cases, compilers or guest runs occurred.

### Fetch response pull and terminal ownership

Source 253 adds the real response-body pull owner over actual IncomingMessage iteration, private independent byte-copy publication and real cancellation/terminal ownership. Namespace, retirement-before-controller-error and EOF-publication fixes address all three reviewed source findings. Actual normal source checks guard 908 inputs with ten source checks/eight commands; scoped native/candidate predicate groups are nine each, with separate namespace/error-hook/EOF-hook subjects. Full public Fetch cause/name/code/socket metadata equality remains FAILED. Fourteen package input cases pass separately. No guest, complete Fetch or four-host acceptance.

### Captured TTY StreamBase prerequisite

Source254 consumes actual captured TTY handles through native kind admission and Socket/stdio read/write/ref/close owners. Normal staging guards908inputs with17source checks and8commands. Scoped portable6/nativeaccess3/Socketnative6+candidate6/stdiooutput5+input5+rollback3 observations are dependency/component evidence, not public API or guest passes. Original V1 source check remains a harness error; separately reviewed exact-formatter manual follow-up passed. Package14 passed independently. Public TTY constructors, shutdown, string/mixed writes and guest/four-host conformance remain open.

### Dedicated EC private PKCS8 owner

Source255 consumes real dedicated EC private PKCS8 KeyMaterial/ncrypto/BIO/private byte owners, preserving source251 private-role admission. Normal source908inputs/5checks/8commands and fifteen native-dependent owner groups pass; package14 passes independently. Two historical helper compiles count once359 to361, zero new root compilers/core/engine changes. Full public WebCrypto and guest/four-host validation remain incomplete.

### Async spawn abort and kill-signal ownership

Source256 implements actual async spawn AbortSignal/killSignal validation and cancellation over existing genuine launch/kill/reap/pipe-close owners. Normal908inputs/14sourcechecks/8commands and paired native18/candidate18 reported observations match18; two unchanged upstream parent-controller subjects pass with native process/stream/EventTarget/signal dependencies, not complete file or guest coverage. Package14 passes independently. One historical helper counts once361 to362; zero root compilers. Full normalization/timeout/argv0/executable authority/shell/IPC and guest/four-host gaps remain open.

### getCallSites validation and raw fallback

Source257 implements pinned getCallSites overload/validator/getter/error order and real raw no-entry fallback through unchanged SavedFrame capture. Normal908inputs/13sourcechecks/8commands pass; native27/candidate27 selected reported projections match27, without numeric position/script-ID or guest SavedFrame equality. Two unchanged files run four top-level subjects; candidate children still execute native util, not candidate mapped/eval/child coverage or complete-file acceptance. Package14 passes independently; zero historical/new compilers. Actual mapping/cache/defaultCLI/native formatter owners remain missing.

### Opaque ordinary Server listener ownership

Source258 routes ordinary net.Server through a genuine opaque foreground-finalized captured-descriptor listener owner and existing accepted TCP lifecycle. Actual normal910inputs/6sourcechecks/8commands pass, with portable8/nativeServer10/currentJS11/nativefd3reference observations; package14 independent. Candidate listen({fd}) remains inactive, nativeClass/AsyncWrap/GC/realm/fatal/Worker/fullServer/four-host behavior uncompiled. Contextual0180 source patch has exact Git and production patch forward/reverse/forward proof; mode0755 manual coupling, no V1 operation. One historical helper counts once362 to363, no root compiler.

### SQLite authorizer callback ownership

Source259 connects actual sqlite3_set_authorizer to existing Connection/Statement/Session ownership, traced database callback registry and post-SQL exception_ptr/abrupt handoff. Separate limits correction permits real readonly cached limit access and guards actual mutations before value validation. Normal910inputs/19sourcechecks/8commands pass, correctedportable8/nativeLimit3/frontend12native+12candidate selected observations and package14 independent. Native backend/error/Values/parameter-free SQL dependencies do not execute new guest JSAPI bridge. Two historical helpers count once363 to365; zero root compiler, no engine patch/full SQLite or guest closure.

### Normal-open TLS transport shutdown ownership

Source260 adds normal-open TLS transport shutdown ownership over actual retained TCP/TLS/ShutdownWrap/BIO flight owners. Alert output waits real captured-parent completion/ack before SHUT_WR; public_final stays inactive and early-handshake/in-SSL deferral/full inputBIO/fatal/destruction/provider parity remain gaps. Actual successor normal910inputs/23sourcechecks/8commands pass, clean6protocol/native2actualShutdownWrap references and package14 independent. Two retained TLS1.3 injected-queue preservation nonpasses remain unresolved. Four historical tiny helper compiles counted once365 to369; zero new root compiler, no guest/four-host or full TLS shutdown claim.

### Batched timer, builtin and key-rights foundations

Source261 combines returned timer/selected primitive-ID ownership, builtin ESM synchronization and CryptoKey usage-mask foundations in one source batch. Shared source/package reports and per-feature focused evidence retain explicit native dependencies. Historical component evidence, original timeouts and preparation failures stay separate; current guest/four-host conformance remains unestablished.

### Batched listener, crypto WebIDL and statfs ownership

Source262 combines real listener async lifetime, complete pinned crypto WebIDL prerequisite and native statfs binding-cache correction. One actual shared source/package checkpoint preserves three feature scopes, reused native references, original failures and unresolved guest/backend obligations. Source implementation is not conformance.

### Batched SQLTagStore, internal FIPS and TTY birth

Source263 combines real SQLTagStore cache/prepared-statement ownership, linked ncrypto internal FIPS state/generation and shared native TTY birth/prototype/init ownership. One manual source application preserves executable0755, followed by one actual source/package checkpoint. Historical component evidence and current native-dependent frontend observations remain separate from uncompiled guest behavior.

### Batched Promise, DNS, Server callback and MAC owners

Source264 adds four scoped owner contributions in one ordinary-file source/generation/checkpoint batch. CurrentMAC6component observations use native backend dependencies and historicalnative reference; othernewnative/VMpaths remain sourceonly. Accepted263compilation/cache evidence stays historical, notcurrent264runtime proof.

### Batched timeout, data Fetch, Worker CLI and internal benchmark owners

Source265 combines four scoped owners in one normal generation/check batch. Only source/input/package checks are fresh; native-component histories retain their original source/dependency/nonpass scopes. No fresh API/host conformance or public benchmark activation is established.

### Batched retained terminal IO, TLS certificate and private Fetch owners

Source266 combines real terminal shutdown/completion and encoded-string owners with owned abbreviated TLS certificate material and private currentURL data dispatch. One normal source/package batch has no currentruntime/component evidence; historical TTY3compileattempts/2fixturefailures are credited once, not newrootcompilers.
