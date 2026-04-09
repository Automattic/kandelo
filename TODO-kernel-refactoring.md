# Kernel Refactoring: Move Host-Side Logic to Rust Kernel

## SysV IPC and POSIX mqueues
Currently intercepted host-side (`SharedIpcTable`, `PosixMqueueTable`) but they're pure kernel data structures with no platform I/O dependency. They sit alongside pipes, sockets, and FDs conceptually, and the kernel already manages all of those. Having them host-side means the kernel's `remove_process()` can't automatically clean up IPC resources, and cross-process semantics have to be coordinated across two layers.

## Poll/select wakeup policy
The host maintains `POLL_AFFECTING_SYSCALLS`, `pendingPipeWriters`, and the `wakeAllBlockedRetries` logic to decide when blocked poll/select calls should re-check. This is essentially scheduler logic. The kernel already knows when pipe buffers drain or sockets connect — it could signal readiness directly rather than having the host infer it from syscall types.

## Thread channel page allocation
Duplicated across 10+ `onClone` implementations. Manages WebAssembly.Memory layout which the kernel can't directly control from inside wasm. Centralizing into a shared TypeScript utility (rather than moving to Rust) is likely the more practical fix.

## What should stay host-side
Worker creation, `WebAssembly.Memory` allocation, platform I/O, the epoll V8 workaround, and the blocking retry loop mechanics (since they depend on `Atomics.waitAsync` and timers). The kernel can't orchestrate async host primitives from inside synchronous wasm execution.
