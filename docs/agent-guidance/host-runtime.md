# Host Runtime Contract

The host runtime is part of the platform, not demo scaffolding. It owns worker
lifecycle, Wasm instantiation, process memory, syscall channel dispatch,
blocking retry, VFS/network/device adapters, process-worker launch, and the
Node/browser bridge to platform APIs. Changes here can change POSIX behavior
even when kernel Rust code is untouched.

The kernel must run in a dedicated worker on every host. `CentralizedKernelWorker`
must not be instantiated on the main thread. The main thread is a proxy for
setup, UI, and I/O routing; it is not the syscall engine.

Node.js and browser hosts are peers. A host-runtime behavior change is
incomplete until both hosts have the same platform-observable behavior or the
difference is explicitly justified by a real platform boundary. Do not land
Node-first or browser-later host changes.

Before and after host work, ask: "What does this look like on the other host?"

| Concern | Node.js | Browser |
|---|---|---|
| Host proxy | `host/src/node-kernel-host.ts` | `host/src/browser-kernel-host.ts` |
| Kernel-worker entry | `host/src/node-kernel-worker-entry.ts` | `host/src/browser-kernel-worker-entry.ts` |
| Worker adapter | `host/src/worker-adapter.ts` | `host/src/worker-adapter-browser.ts` |
| Process-worker runtime | shared `host/src/worker-main.ts` | shared `host/src/worker-main.ts` |
| Kernel worker | shared `host/src/kernel-worker.ts` | shared `host/src/kernel-worker.ts` |

Worker protocols are contracts. Spawn, fork, exec, clone, exit, terminate,
thread exit, crash, syscall trace, PTY, framebuffer, audio, network, VFS, and
service-worker messages must have symmetric request, response, error, and
cleanup behavior. A missing message handler is a platform bug.

Stdio descriptor type is chosen when the process is created. Hosts that launch
without a PTY must create fds 0, 1, and 2 as pipe-backed descriptors so
`isatty()` and terminal ioctls observe non-terminal semantics; hosts that
allocate a PTY must create terminal descriptors and then attach the PTY before
user code runs. Do not create terminal-like stdio and repair it later.

Failure must surface. Wasm traps, worker crashes, failed exec/spawn, missing
binaries, ABI mismatches, service-worker failures, blocked retries, and process
exits must become observable errors, exit statuses, or logs through the normal
host APIs. Silent hangs are contract failures.

Browser restrictions are real platform boundaries, not excuses for different
semantics where parity is possible. Browser-specific code may handle
cross-origin isolation, service workers, OPFS, fetch bridges, canvas, audio,
pointer lock, and unavailable raw sockets, but POSIX-visible behavior should
match Node unless documented otherwise.

Shared files are cross-host changes by default. Changes to
`host/src/kernel-worker.ts`, `host/src/worker-main.ts`, VFS behavior,
networking, framebuffer, generated ABI constants, or worker protocol types need
Node and browser consideration even when only one host-specific file changed.

`BrowserKernel` is host/runtime code. Browser demos consume it; they do not own
it. Fix runtime bugs in `host/src`, not inside demo pages, unless the bug is
truly presentation-specific.

## The host filesystem contract is handle-only

**A host resolves at most one path component, relative to a directory handle it
previously issued. It never receives a guest path, a mount prefix, a `..`, or a
symlink chain.**

The kernel owns the POSIX namespace. `resolve_namespace_path_from`
(`crates/runtime-core/src/syscalls.rs`) walks a guest path component by
component against the kernel's own metadata and produces a canonical path with
every symlink and `..` already resolved; `crates/runtime-core/src/hostdir.rs`
then steps a host directory handle along it with
`host_openat(dir, component, O_DIRECTORY|O_NOFOLLOW)` and presents the final
operation a single component.

What this means when you touch host code:

- **Do not add a path-taking host import.** If you find yourself wanting one —
  anything shaped like "resolve the remainder of this path for me" — stop and
  discuss it. That is the defect the contract removed, and the direction of
  travel is one way.
- **A directory is an ordinary handle.** `host_openat(..., O_DIRECTORY)` issues
  it, `host_readdir` iterates it, `host_close` releases it. There is no second
  handle namespace and no `closedir`. A host must therefore issue **distinct
  handles for distinct directories** (the kernel's walk holds several at once),
  keep its directory ids **disjoint from its file ids** (one `close` serves
  both), and answer `fstat`, `fstatfs`, `fpathconf`, `fchmod`, `fchown`, and
  `fsync` on a directory handle as well as a file one.
- **The whole family is optional.** It is reachable only under a mount whose
  root handle the host published through
  `kernel_rootfs_set_foreign_mount_roots`. A host with no host-backed directory
  implements none of it; a browser host implements none of it today. Leaving
  these unimplemented is a truthful boundary, not a gap to paper over.
- **The final component is still a name, and that is irreducible.** `mkdir`,
  `unlink`, `rename`, `link`, and `symlink` name an entry that does not exist
  yet or is about to stop existing; `lstat`, `lchown`, and a
  `AT_SYMLINK_NOFOLLOW` `utimensat` name an entry the host must not open,
  because opening a symlink follows it. The goal is no name *resolution*, not
  no names.
- **`PlatformIO`'s remaining path methods are host-internal.** They implement
  the `*at` methods and serve host-side machinery such as image export. The
  kernel calls none of them. Adding a kernel-side caller is a regression.

`docs/abi-versioning.md` records the full import list and the reasoning; the
concept-level accounting is in
`docs/plans/2026-09-09-rust-first-value-plan.md` §2t and §4.

## Rust-first for kernel and fork control flow

Kernel and fork control flow are Rust-first. Do NOT add kernel or fork
control-flow TypeScript unless it is the irreducible host floor.

**This list is a starting point, not a settled boundary.** A floor claim always
takes the form "Wasm cannot do X, therefore Y must be host". In this campaign
the premise has usually held while the inference failed: a 2026-09-03 probe
found externref, exnref, anyref-transit and GC `ref.eq` all migratable to Wasm,
leaving a much smaller floor than an earlier list of this kind implied. Probe
the entry against the code before concluding something must stay in TypeScript,
and shrink this list when a probe says you can. `CLAUDE.md` carries the rule;
item B in `CLAUDE-too-specific-guidance.md` records why the version of this
list that used to live there was pulled out of the contract router.

This file is the ONE place the floor is enumerated. `debugging-and-posix.md`
points here rather than keeping a second copy, because two hand-maintained
lists disagree silently — these two already had: that file named the `fork()`
syscall where this one names `fork()`/`vfork()`, and `vfork` has its own
host-intercepted syscall (`SYS_VFORK`), its own `handleVfork` in
`host/src/process-lifecycle.ts` and its own `host/src/vfork-lifetime.ts`.
Add an entry here or nowhere.

- worker spawn and lifecycle,
- the `fork()`/`vfork()` syscall + the syscall-channel transport,
- `resolve_externref(handle) -> externref` identity materialization (the one
  true engine-floor seam),
- anyref-transit `Table.grow` sizing (host must grow STORE #2 before drive),
- PIC placement globals (`__memory_base`/`__stack_pointer`/`__table_base`/
  `__indirect_function_table`) chosen at instantiation,
- the per-thunk `Table.set` into the resume table — and ONLY that. This entry
  used to read "the resume `WebAssembly.Table` (host-built import of guest
  funcref thunks)", and that is no longer true at HEAD: the table is created
  and exported by the fork module
  (`crates/fork-module-inject/src/main.rs:1042-1044`), the guest IMPORTS it
  (`crates/fork-instrument/src/runtime.rs:469-475`), and the host reads it
  back off the module's exports
  (`host/src/worker-main.ts:3788`, `:6496`). Slot allocation moved into the
  module too; the host asks via `fm_resume_slots`. Spec decision 12 and its
  2026-09-20 amendment
  (`docs/superpowers/specs/2026-09-18-fork-dynamic-storage-design.md`) propose
  moving the remaining `Table.set`. Treat even this residue as contested:
  `host/src/fork-resume-table.ts:4-8` still argues the table object "cannot
  move into the fork module", which its own callers above have already
  overtaken. This entry is exactly the "X cannot do Y, therefore Z must be
  host" shape, and probing it is what shrank it,
- the guest run-loop + the fork-unwind exception catch (a JS-level throw a Wasm
  module cannot `try/catch`), and
- the Node/browser worker-message bridges.

New capture/replay/orchestration logic belongs in the Rust fork-module
(`crates/fork-module`) and `crates/fork-codec`, driven through the `fm_*`
host↔module contract — not in new TypeScript sequencing in
`host/src/fork-module-backend.ts`, `host/src/fork-process-continuation.ts`, or
the fork paths of `host/src/worker-main.ts`. The `fm_*` surface is the internal
host↔module contract (rebuilt in lockstep with the module), NOT the guest ABI;
the frozen guest contract is the `__wpk_fork_*` exports and `kandelo.wpk_fork.*`
custom sections. Prefer a coarse module entry that sequences guest-export drive
steps over a new host-side call sequence.

The direction of travel is one way: this TS glue shrinks toward the floor over
time (see `docs/plans/2026-09-08-fork-controlflow-into-module-scope.md`); it does
not grow. When you face a dilemma about whether something must be TypeScript,
STOP and discuss with the maintainer rather than growing the host surface.
