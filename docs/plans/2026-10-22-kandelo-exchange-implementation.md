# Kandelo exchange implementation plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task.

**Goal:** Implement Kandelo exchange as specified in
`docs/superpowers/specs/2026-10-21-kandelo-exchange-design.md`, one
standalone commit per delivery-order phase.

**Architecture:** Kernel-owned exchange filesystem and activation in
`crates/runtime-core` and `crates/kernel`. The host interface lives in
the shared host runtime (`host/src`) and `web-libs/kandelo-session`.
Guest userland (`kxchgd`, helpers) ships as a base-rootfs package. The
browser app is a consumer only.

**Tech stack:** Rust (kernel, `no_std` + `alloc`), TypeScript (host
runtime, Vitest, Playwright), C (guest programs, via the Kandelo SDK),
Nix dev shell (`scripts/dev-shell.sh`).

---

## Ground rules for every phase

- Run builds and tests under `scripts/dev-shell.sh`. Runs longer than 10
  minutes go through `scripts/agent-job start` and `scripts/agent-job
  wait`.
- After editing kernel Rust, rebuild the kernel wasm before Vitest or
  conformance: `scripts/dev-shell.sh ./run.sh setup`, or the faster
  kernel-only rebuild from `docs/agent-guidance/validation.md`.
- A fresh worktree needs, in order: `git submodule update --init
  --recursive`, `scripts/dev-shell.sh ./run.sh setup`, `(cd host && npm
  ci)`, and `scripts/dev-shell.sh bash scripts/build-programs.sh`.
- Each phase ends in one commit with an `Area: Purpose` subject. The
  branch is rebase-merged, so every commit must build and pass on its
  own.
- ABI: run `bash scripts/check-abi-version.sh update`, review
  `git diff abi/snapshot.json`, decide (no change, additive, or
  incompatible) per `docs/agent-guidance/abi.md`, then run
  `bash scripts/check-abi-version.sh`.

## Phase 1: xattr honesty

**Why:** syscalls 350–361 are stubs that report false success. The set
calls return 0 and store nothing; the get and remove calls return
ENODATA, which claims the filesystem supports xattrs. No pointer
argument is marshalled, so a missing path or bad descriptor is never
reported. `docs/posix-status.md` wrongly says ENOSYS.

**Target behavior.** This follows Linux for a filesystem without xattr
support. POSIX does not define xattrs.

| Call family | Order of checks | Result on success of checks |
|---|---|---|
| `setxattr`, `lsetxattr`, `fsetxattr` | flags other than 0, `XATTR_CREATE` (1), `XATTR_REPLACE` (2) → EINVAL; name empty or longer than 255 bytes → ERANGE; `size` > 65536 → E2BIG; then path resolution or descriptor check | ENOTSUP |
| `getxattr`, `lgetxattr`, `fgetxattr` | path resolution or descriptor check; then name empty or longer than 255 → ERANGE | ENOTSUP |
| `removexattr`, `lremovexattr`, `fremovexattr` | path resolution or descriptor check; then name → ERANGE | ENOTSUP |
| `listxattr`, `llistxattr`, `flistxattr` | path resolution or descriptor check | 0: an empty list, which is true. This is what Linux returns for a filesystem without xattr handlers (`vfs_listxattr` falls back to security labels, of which there are none). |

- Path resolution errors come from the same path as `stat` (`l*`
  variants: `lstat`): ENOENT, ENOTDIR, ELOOP, ENAMETOOLONG, and EACCES
  on search.
- Descriptor errors: EBADF for a closed descriptor or an `O_PATH`
  descriptor, as Linux's `fdget` gives.

**ABI decision (made in Task 6).** The snapshot change is additive,
but the compatibility classifier treats any change to the channel
scalar-contract section as breaking: on wasm64 the glue and the host must
agree on how these calls' `size` slots are encoded. Phase 1 therefore
bumps `ABI_VERSION` to 53 (main took 51 and 52 meanwhile), recorded in `docs/abi-versioning.md`.
The ABI-contract digest is a hash of the snapshot, so stale stamped
binaries also fail loudly until they are rebuilt.

### Task 1: Syscall constants

**Files:**
- Modify: `crates/shared/src/lib.rs`: the `extended_syscalls` module
  (constants near `SYS_SHMCTL: u32 = 347`) and its `SYSCALLS` list.

**Step 1:** Add the constants after `SYS_SHMCTL`:

```rust
pub const SYS_FGETXATTR: u32 = 350;
pub const SYS_FLISTXATTR: u32 = 351;
pub const SYS_FREMOVEXATTR: u32 = 352;
pub const SYS_FSETXATTR: u32 = 353;
pub const SYS_GETXATTR: u32 = 354;
pub const SYS_LISTXATTR: u32 = 355;
pub const SYS_LGETXATTR: u32 = 356;
pub const SYS_LLISTXATTR: u32 = 357;
pub const SYS_LREMOVEXATTR: u32 = 358;
pub const SYS_LSETXATTR: u32 = 359;
pub const SYS_REMOVEXATTR: u32 = 360;
pub const SYS_SETXATTR: u32 = 361;
```

**Step 2:** Add matching `AbiSyscallNumber { name: "Fgetxattr", number:
SYS_FGETXATTR }` entries (and so on) to `SYSCALLS`, keeping its order.

**Step 3:** `scripts/dev-shell.sh cargo test -p wasm-posix-shared`
(check the crate name in `crates/shared/Cargo.toml`). Expected: PASS.

### Task 2: Marshalling descriptors and scalar contracts

**Files:**
- Modify: `crates/shared/src/host_abi.rs` (`SYSCALL_ARG_DESCRIPTORS`,
  sorted by number)
- Modify: `crates/shared/src/channel_scalar.rs` (`size` arguments are
  `ProcessSize`)

**Step 1: Write failing tests** in the `host_abi.rs` test module:

```rust
#[test]
fn xattr_syscalls_marshal_names_values_and_lists() {
    use extra_syscalls::*;
    for nr in [SYS_GETXATTR, SYS_LGETXATTR, SYS_SETXATTR, SYS_LSETXATTR,
               SYS_REMOVEXATTR, SYS_LREMOVEXATTR, SYS_LISTXATTR,
               SYS_LLISTXATTR] {
        assert_eq!(find(nr).args[0].size, cstring!(), "path for {nr}");
    }
    for nr in [SYS_GETXATTR, SYS_LGETXATTR, SYS_FGETXATTR, SYS_SETXATTR,
               SYS_LSETXATTR, SYS_FSETXATTR, SYS_REMOVEXATTR,
               SYS_LREMOVEXATTR, SYS_FREMOVEXATTR] {
        assert_eq!(find(nr).args[1].size,
                   cstring!(platform_limits::XATTR_NAME_MAX_BYTES, ERANGE));
    }
    for nr in [SYS_GETXATTR, SYS_LGETXATTR, SYS_FGETXATTR] {
        let value = find(nr).args[2];
        assert_eq!(value.direction, SyscallArgDirection::Out);
        assert_eq!(value.size, arg!(3));
        assert!(value.nullable);
    }
}
```

Run: `scripts/dev-shell.sh cargo test -p <shared crate> xattr`.
Expected: FAIL (no descriptors).

**Step 2: Implement.**

- Add `XATTR_NAME_MAX_BYTES` (`256`: 255 bytes plus the NUL) and
  `XATTR_SIZE_MAX` (`65536`) to `platform_limits`.
- Add the descriptors:
  - get: `[desc!(0, In, cstring!(), required), desc!(1, In,
    cstring!(XATTR_NAME_MAX_BYTES, ERANGE), required), desc!(2, Out,
    arg!(3), nullable)]`. `fgetxattr` has no path, so its name and value
    are args 1 and 2 with size arg 3.
  - set: name; then `desc!(2, In, arg!(3), nullable)` for the value.
  - list: path; then `desc!(1, Out, arg!(2), nullable)`. `flistxattr`
    has the same shape without the path.
  - remove: path and name only.
- Add `ChannelScalarSyscall` contracts with `ProcessSize` for every
  `size` argument (`musl_name` as in `libc/musl/src/linux/xattr.c`).
- Update `pointer_nullability_is_explicit_and_exhaustive`, and any
  other exhaustive list the tests enforce, with the new nullable value
  and list buffers.

**Step 3:** Run the shared crate tests. Expected: PASS, including the
existing exhaustiveness tests.

### Task 3: Runtime-core xattr module

**Files:**
- Create: `crates/runtime-core/src/xattr.rs`
- Modify: `crates/runtime-core/src/lib.rs` (`pub mod xattr;`)
- Modify: `crates/runtime-core/src/syscalls.rs`: make `require_io_fd`
  `pub(crate)`.

**Step 1: Write failing tests** in `xattr.rs`, using `Process::new(1)`
and `MockHostIO::new()` as the `syscalls.rs` tests do:

- `getxattr` on a missing path → ENOENT; on an existing file → ENOTSUP;
  with an empty name → ERANGE (after a successful path check); with a
  256-byte name → ERANGE.
- `lgetxattr` on a dangling symlink → ENOTSUP; `getxattr` on the same
  link → ENOENT.
- `setxattr` with flags 4 → EINVAL, even on a missing path (flags are
  checked first); `size` 65537 → E2BIG; valid arguments → ENOTSUP.
- `fgetxattr` on fd 99 → EBADF; on an `O_PATH` descriptor → EBADF; on
  an open file → ENOTSUP.
- `listxattr` on an existing file → `Ok(0)`; on a missing path →
  ENOENT; `flistxattr` on a bad fd → EBADF.
- `removexattr` on an existing file → ENOTSUP.

Run: `scripts/dev-shell.sh cargo test -p <runtime-core crate> xattr`.
Expected: FAIL (module missing).

**Step 2: Implement** `xattr.rs`:

```rust
pub enum XattrTarget<'a> { Path { path: &'a [u8], follow: bool }, Fd(i32) }

pub fn sys_getxattr(proc, host, target, name: &[u8]) -> Result<usize, Errno>
pub fn sys_setxattr(proc, host, target, name: &[u8], size: usize, flags: u32) -> Result<(), Errno>
pub fn sys_listxattr(proc, host, target) -> Result<usize, Errno>
pub fn sys_removexattr(proc, host, target, name: &[u8]) -> Result<(), Errno>
```

- Resolving a target calls `syscalls::sys_stat` (follow) or
  `syscalls::sys_lstat` (no follow) and discards the result, or calls
  `syscalls::require_io_fd` for a descriptor.
- Name validation: empty, or longer than 255 bytes → ERANGE.
- Every filesystem lacks xattr support today, so the get, set, and
  remove calls return `Errno::ENOTSUP` and list returns `Ok(0)`. A
  module comment says the exchange filesystem will be the first to
  implement `user.*`.

**Step 3:** Run the tests. Expected: PASS.

### Task 4: Kernel dispatch

**Files:**
- Modify: `crates/kernel/src/wasm_api.rs`: replace the
  `// --- xattr stubs` arms (350–361) with calls into
  `runtime_core::xattr`, through `kernel_*` wrappers in the style of
  `kernel_lstat`. Each takes the GKL lock and delivers pending signals
  afterwards. Read pointers with `channel_const_ptr!` /
  `channel_cstr_len!`. Sizes come from `a3`/`a4` as
  `ProcessSize`-declared scalars.

**Step 1:** `scripts/dev-shell.sh cargo build --release -p kandelo -Z
build-std=core,alloc` (or `./run.sh setup`). Expected: builds.

**Step 2:** Run the kernel crate's unit tests, if any, for dispatch
coverage.

### Task 5: Guest program and Vitest (Node), plus browser parity

**Files:**
- Create: `programs/xattr-unsupported.c`
- Create: `host/test/xattr-unsupported.test.ts`
- Create: `apps/browser-demos/test/xattr-unsupported.spec.ts`
- Modify: `scripts/ci-vitest-evidence-classes.tsv` (add the test as
  `prepared-product`, sorted)

**Step 1:** The C program exercises every call through musl:

- `setxattr("/tmp/x", "user.a", "v", 1, 0)` returns -1 with ENOTSUP.
- `getxattr("/nonexistent", ...)` gives ENOENT.
- `listxattr("/tmp/x", buf, sizeof buf)` returns 0.
- `fgetxattr(-1, ...)` gives EBADF.
- `setxattr` with flags 4 gives EINVAL.
- `lgetxattr` on a dangling symlink gives ENOTSUP.

It prints `PASS` and exits 0 only if every check holds. Model it on
`programs/dev-fd-stat.c`.

**Step 2:** The Vitest file mirrors `host/test/dev-fd-stat.test.ts`. The
Playwright spec mirrors `apps/browser-demos/test/dev-fd-stat.spec.ts`.

**Step 3:** `scripts/dev-shell.sh bash scripts/build-programs.sh`, then
`cd host && npx vitest run test/xattr-unsupported.test.ts`. Expected:
PASS. Then run the Playwright spec in Chromium and WebKit.

### Task 6: ABI snapshot, docs, and commit

**Step 1:** `bash scripts/check-abi-version.sh update`, review the diff,
and apply the ABI decision above.

**Step 2:** Update `docs/posix-status.md`: the three xattr rows and the
"Extended attributes" summary line. Update the spec's ABI sentence for
phase 1 if the decision differs from its text.

**Step 3:** Conformance: grep `tests/libc`, `tests/posix`, and
`tests/sortix` for xattr cases and run any that exist before and after
the change. Report results. Check that shipped tools tolerate ENOTSUP:
coreutils `cp --preserve=xattr` and `cp -a`, and Python
`shutil.copy2`, if present in the rootfs.

**Step 4:** Commit `POSIX: Report missing xattr support truthfully`,
with a body that leads with the false-success problem.

## Phases 2–7 (outline; each gets a detailed plan when it starts)

2. **Exchange filesystem and IDs in the kernel.** A new
   `crates/runtime-core/src/exchange/` with the mount at
   `/run/kandelo/exchange`, `events`, `inbox` batches (staged, pending,
   committed), `work/clone` sessions, `outbox` publishing and freezing,
   `user.*` xattrs on the exchange filesystem, UUIDv8 IDs, quotas, and
   `statfs`. Study `crates/runtime-core/src/tmpfs.rs` (in-kernel
   filesystem) and `clipboard.rs` (single-owner device) first. Includes
   the reserved `exchange` group in the base rootfs. ABI decision at the
   end of the phase.
3. **Host interface** on both hosts: `offer()`, batch handles, range
   reads of sources, stream pumping, `onOutput()` leases, `stats()`, and
   the consumer state.
4. **Kernel activation:** the agent path, backoff, idle-exit
   interaction, reaping of init's children (coordinate with the orphan
   reparenting change), the host launch import, and
   `exchange.activation`.
5. **Guest userland:** `kxchgd`, `kandelo-exchange`, `kandelo-publish`,
   `<kandelo/exchange.h>`, the `attr` port, vendor rules including
   `99-save`, and `exchange.conf`.
6. **Browser app:** gestures, consumer states, toasts, and the output
   tray.
7. **Replacing `ingest`:** launch wrappers, handler rules, migrated
   tests, and removal of the old code and docs.

## Phase 5 detail: guest userland

Ships as one Kandelo-authored package, `kandelo-exchange`, built through
the normal SDK path (template: `packages/registry/sudo-lite/`). Sources
live in `programs/kandelo-exchange/`, a subdirectory, so
`scripts/build-programs.sh` (which globs `programs/*.c`) does not also
build them as test programs.

| Output | Installed at |
|---|---|
| `kxchgd` | `/usr/libexec/kandelo/exchange-agent` (the agent path) |
| `kandelo-exchange` | `/usr/bin/kandelo-exchange` |
| `kandelo-publish` | `/usr/bin/kandelo-publish` |
| `exchange-save` (the `99-save` handler) | `/usr/libexec/kandelo/exchange-save` |

Base rootfs (`MANIFEST`, `images/rootfs/`): the `exchange` group (GID
120, member `maker`), `/etc/kandelo/exchange.conf` (`user maker`),
`/etc/kandelo/exchange-handlers.d/` owned `1000:120` 0755, and the vendor
rule `/usr/share/kandelo/exchange-handlers.d/99-save.handler`.
`<kandelo/exchange.h>` is header-only (static inline helpers) in
`libc/musl-overlay/include/kandelo/`, so libc gains no symbols.

Rule syntax as in the spec, plus one clarification: `run PROGRAM
[ARGS...]` runs PROGRAM with the batch directory as `argv[1]`, followed
by ARGS. A handler's own `user.kandelo.status` is kept, except that a
nonzero exit replaces a status not beginning with `failed` with
`failed: exit N` (or `failed: signal N`).

Validation: a Node Vitest that boots an image containing the package
outputs, offers files, and checks the catch-all saves them to
`~maker/Downloads` with the right status; rule precedence, masking, and
unsafe-permission refusal; `kandelo-publish` stored and streamed outputs;
privilege drop (the handler runs as `maker`). The `attr` port follows as
its own commit.
