# Debugging And POSIX Contract

## Debugging

Fix the platform failure, not the presentation of the failure. A bug is not
understood until the failing path has been traced to its real layer: user
program, package artifact, VFS image, SDK/libc glue, syscall semantics, kernel
state, host runtime, Node/browser adapter, service worker, or UI.

Generic symptoms are not root causes. Treat messages like `Segmentation fault`,
`Maximum call stack size exceeded`, hung panes, missing binaries, silent worker
exits, blocked `waitpid`, or empty browser output as entry points for
investigation. Before editing behavior, identify what operation failed, which
process issued it, which syscall or host operation carried it, and where the
expected state diverged from actual state.

Prefer evidence from the normal runtime path: package resolver output, VFS
image contents, browser console/page errors, service-worker request failures,
worker exit/crash messages, syscall traces, kernel process/fd/VFS state, and
minimized C or package-level repros. A test that only asserts final UI text is
weak evidence unless the bug is actually in UI rendering.

Do not special-case outputs, preset buttons, wrapper scripts, terminal
transcripts, package launchers, or demo state to hide a platform defect. A demo
may adapt presentation to product requirements, but it must not become an
alternate implementation of runtime behavior.

Standard triage shape:

1. Reproduce through the normal path.
2. Identify the failing layer.
3. Reduce to the smallest platform behavior that is wrong.
4. Fix shared behavior at the lowest correct layer.
5. Validate both the original user-visible symptom and the lower-level
   contract.
6. Report what was run and what was not run.

## POSIX And Process

Kandelo presents an OS contract to user programs. Syscalls, libc glue, process
lifecycle, file descriptors, signals, memory, devices, and VFS behavior must be
implemented as platform behavior, not accommodations for a particular package.

Start from POSIX semantics. POSIX conformance is the north star. Linux
compatibility is valuable, but secondary: when multiple designs are equivalent
for POSIX correctness, internal integrity, maintainability, and performance,
prefer the design that best matches Linux-observable behavior. Preserve
documented errno values, blocking behavior, inheritance rules, atomicity
guarantees, ownership, permissions, and observable state. If Kandelo
intentionally diverges, document the divergence in `docs/posix-status.md` or
the relevant architecture doc.

A POSIX gap should stay visible as a platform gap until it is implemented. Do
not convert an unsupported or partially supported API into silent success just
because that lets a package continue. Stubs must be honest: return the correct
failure mode for unsupported behavior unless the API's correct compatibility
behavior is a no-op.

Process state is authoritative. `fork`, `exec`, `posix_spawn`, `clone`, `exit`,
`waitpid`, process groups, sessions, credentials, CWD, umask, rlimits, signal
dispositions, fd tables, OFDs, locks, sockets, PTYs, memory layout, and
zombie/reaping state must remain coherent across transitions.

`fork()` means continuation preservation. If a change touches fork, fork
instrumentation, pthread fork, fd/resource inheritance, signal state, or memory
copying, verify that the child resumes at the correct call site with correct
process state and that the parent observes correct wait/reap behavior.

`exec()` means replacement without identity loss. Preserve PID and inherited
open fds, close `FD_CLOEXEC`, reset exec-defined process state, install the new
binary's memory layout, and do not leak the previous program's heap, stack,
handlers, or host worker assumptions into the new image.

`posix_spawn()` may be non-forking, but it must preserve POSIX spawn semantics.
It must not silently fall back to fork unless the contract explicitly changes.
File actions, attrs, signal behavior, CWD, fd inheritance, and
rollback-on-failure must remain correct.

File descriptors and open file descriptions are real shared state. `dup`,
`fork`, `exec`, `close`, `fcntl`, locks, append mode, nonblocking mode,
pipe/socket readiness, and device ownership must operate on the correct fd/OFD
boundary. Do not paper over fd bugs in package code.

The VFS must report honest filesystem state. `/etc` files, package files, VFS
image contents, device nodes, symlinks, modes, uid/gid, and mount behavior
should be visible through ordinary filesystem operations. Do not add synthetic
answers that disagree with what a program can read from the filesystem.

Memory layout is part of the process contract. `brk`, `mmap`, `munmap`,
`mremap`, pthread control slots, fork-save areas, syscall channels, and
guest-visible exported globals must not overlap or rely on browser reloads,
garbage collection, or host cleanup timing for correctness.

Devices are kernel/platform behavior. PTYs, framebuffer, mouse, audio, random,
null/zero/full, procfs, shm, sockets, and service-worker bridges should behave
through normal file/syscall/device paths. Demo code may present devices, but
must not implement substitute device semantics.
