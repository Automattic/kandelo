# POSIX Spawn Post-Commit Liveness Design

## Problem

The ABI 43 kernel-entry gate correctly forbids a second kernel WebAssembly
export while a serialized ingress or detached protocol transaction is still
draining. Node's `handlePosixSpawn` violates that boundary immediately after a
successful prepared-target commit: it calls `shouldLaunchPendingChild`, which
enters `kernel_get_process_exit_signal`. The msmtpd standalone service test
reaches this path and fails with `KernelReentrantEntryError` before its child
Worker can be attached.

This is shared host-runtime behavior, not an msmtpd Formula defect. A Formula
workaround would hide a general `posix_spawn` sequencing error.

## Design

Remove the pre-allocation `shouldLaunchPendingChild` call from both Node and
browser `handlePosixSpawn` implementations. The callback is reached only after
Rust has committed the exact pending child's prepared target. Node has not
yielded since that commit, so another ingress cannot have killed the child.
Browser may have yielded while draining unrelated process teardowns, but it
still performs the authoritative liveness check after memory allocation and
before registration, so removing the earlier optimization cannot resurrect a
dead child.

Retain the post-allocation check in both hosts. It runs after an asynchronous
allocation boundary, releases the unused memory lease when the child is no
longer live, and prevents Worker registration for an exited child.

Do not weaken `KernelEntryGate`, expose an entry capability to detached host
callbacks, special-case msmtpd, or delay Node launch merely to make the
forbidden query legal.

## Validation

Extend the existing spawn host-parity contract to require that neither entry
calls `shouldLaunchPendingChild` before `createFreshProcessMemory` completes,
and that both retain exactly one check after allocation and before process
registration. Run that test red before implementation and green afterward.

Then run the focused spawn/lifecycle host tests, the complete host Vitest
suite, and the ABI snapshot check. The hosted msmtpd Formula retry remains the
end-to-end proof because it exercises the exact Node worker, kernel, shell,
network, and `posix_spawn` path that exposed the defect.
