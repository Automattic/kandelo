# Lane V9 census — what `memory-fs.ts` still needs `SharedFS` for

**2026-09-13, written after lane Y closed and unblocked V9.**

The master plan carries V9 as *"the real work: `memory-fs.ts` stops using
`SharedFS`"* and *"the lane's only genuine unknown… genuinely large at 8,501
lines"*. This census measures what that sentence is actually asking for.

Every other lane in this campaign was censused before it was dispatched, and
**six of eight censuses overturned the lane they were meant to confirm**. This
one overturns V9's framing too, in the same direction: the population is much
smaller than the line count suggests, and the hard part is somewhere other than
where the estimate put it.

## The measure everyone quotes, and why it misleads

`memory-fs.ts` is 8,215 lines and uses **34 distinct `SharedFS` methods**. Read
as "34 filesystem operations to reimplement", V9 is enormous.

But `MemoryFileSystem` is not one thing. It is a TypeScript SFFS *client*
bolted to a set of **host-owned duties that are not filesystem operations at
all** — lazy-fetch transports, lazy URL rewriting, download event
subscriptions. Those stay in TypeScript under the courier contract regardless
of what happens to the block layer. Counting them into V9 is what makes the
estimate large.

## What the kernel already took

**The kernel parses the `/` image itself.** `kernel-worker.ts` says so
plainly:

> `#maybeLoadKernelRootfs` installs a positioned window onto these bytes and
> asks the kernel to parse the image itself (`kernel_rootfs_load_image`). **The
> host resolves no names**: the kernel mounts the image's own filesystem, walks
> it, and reads the image's own kernel-lazy (`KLZY`) section.

**Phase 5 took the scratch mounts.** `KERNEL_TMPFS_OWNED_PREFIXES` lists
`/tmp`, `/var/tmp`, `/var/log`, `/var/run`, `/home/maker`, `/root`, `/srv`, and
`filterMountSpecForKernelTmpfs` DROPS them from the spec before a backend is
built. **Every scratch mount in `DEFAULT_MOUNT_SPEC` is in that list**, so the
`MemoryFileSystem.create(sab)` branch in `resolveForBrowser` is **unreachable
under the shipped mount spec**. It survives only for a caller supplying a
scratch mount at some other path.

## What is left, measured at the call sites

| Runtime site | What it needs | Size |
|---|---|---|
| `browser-kernel-host.ts:346` | `create(sab)` and **discard the result** — it only formats the SAB | `mkfs` |
| `node-kernel-worker-entry.ts:786` | same, plus one `chmod("/", 0o1777)` | `mkfs` + `chmod` |
| `browser-kernel-worker-entry.ts` `/` backend | `rewriteLazyFileUrls`, `rewriteLazyArchiveUrls`, `setLazyFetcher`, `subscribeLazyDownloads`, `importLazyEntries` | **not block operations** |
| `browser-kernel-worker-entry.ts:1596` | `readFileFromFs` — `open`/`fstat`/`read`/`close`, **one caller**, reading a log path | 4 calls |
| **`/dev/shm` mount** | a real filesystem, served by the host, over a SAB | **the whole surface** |

`default-mounts.ts` scratch backends are omitted because the shipped spec never
reaches them.

## The finding: V9's hard core is `/dev/shm`, not `/`

Everything above except the last row is either formatting, four read calls, or
duties that were never the block layer's. **`/dev/shm` is the one live mount
whose backend is a `MemoryFileSystem` doing real filesystem work.**

And it is the one that cannot be served by the `sffs-module` bridge as it
stands, for a reason that is structural rather than a missing feature:

* POSIX shared memory is **shared memory**. `/dev/shm`'s backing has to be a
  `SharedArrayBuffer` that the host and the kernel both map, which is exactly
  what `SharedFS` is for.
* `SffsImageFs` holds its image in the **module's own linear memory**. It is a
  builder's filesystem: it produces an image and hands over bytes. Nothing in
  it addresses host-provided shared memory.

So "point `memory-fs.ts` at the Rust SFFS" is not a small change to V9's plan;
it is a different plan, because the two implementations do not have the same
relationship to memory.

## The recommendation, and the decision it needs

**`/dev/shm` should move IN-KERNEL, the way tmpfs did in Phase 5, rather than
having its filesystem reimplemented host-side.** The kernel already owns `/`
and every scratch prefix; `/dev/shm` is the last host-served filesystem mount
of this kind, and the kernel is the side that can address shared memory without
a second SFFS implementation existing to let the host do it.

If that lands, V9's remaining population is:

1. `mkfs` into a SAB, twice, one of which also chmods the root — **or zero
   times, if the kernel formats `/dev/shm` when it takes it**;
2. one `readFileFromFs` helper, four calls, one caller;
3. the host-owned lazy duties, which stay.

**That is the decision this census exists to surface**, and it is not mine: it
moves work into the kernel and changes where POSIX shm lives. What I can say
from the measurement is that the alternative — keeping `/dev/shm` host-served —
requires an SFFS implementation in TypeScript **forever**, which is the thing
`sffsTypeScript`'s target of 0 says the campaign does not want.

## What this census did NOT check

Stated so the next person does not inherit my gaps as facts:

* **The Node host's mount routing.** I read the browser worker's use of its
  backends end to end; on Node I confirmed only that `shmfs` is created and
  chmodded, and that `HostFileSystem` serves the host-directory mounts.
* **Non-default mount specs.** Demos may supply scratch mounts outside
  `KERNEL_TMPFS_OWNED_PREFIXES`, which would revive the `resolveForBrowser`
  scratch branch. I did not enumerate every caller's spec.
* **Build-time users.** `rootfs-overlay-export.ts`, `rootfs-overlay.ts` and
  `apps/browser-demos/lib/kernel-owned-boot.ts` use `MemoryFileSystem` for image
  work at build or boot time. Those are real users and are not counted above,
  which measures the RUNTIME kernel path.
* **Tests.** A large number of host tests construct `SharedFS` or
  `MemoryFileSystem` directly. They are not a reason to keep an implementation,
  but they are work in any deletion and I have not sized it.

---

## ADDENDUM 2026-09-13 — the `/dev/shm` objection does not survive contact

The census above recommended moving `/dev/shm` in-kernel but flagged one
possible reason not to, and asked for it to be checked before anyone committed:

> POSIX shared memory is **shared memory**. `/dev/shm`'s backing has to be a
> `SharedArrayBuffer` that the host and the kernel both map.

**That concern is wrong, and the code says so plainly.** Checked rather than
guessed, at the maintainer's request.

**1. The kernel already implements `MAP_SHARED` for its own files.**
`memory.rs` carries a `fd_writeback` mapping kind, documented as *"a writable
`MAP_SHARED` of a kernel-owned (tmpfs/memfd) regular file"*. Files in the
in-kernel tmpfs are already mappable shared today.

**2. The coherence limit is architectural and applies to EVERY shared mapping,
whoever backs the file.** From the same file:

> POSIX `MAP_SHARED` semantics for a platform where every process owns a
> *distinct* linear memory. A store performed by one pid is not visible in a
> peer's memory, so shared mappings are kept coherent by an explicit
> publish/refresh protocol run at syscall boundaries… **coherence is
> boundary-synchronous, not immediate.** … That is an architectural limit of
> one-linear-memory-per-process.

**3. So the host-backed path is not stronger.** A `SharedArrayBuffer` is shared
between WORKERS; it is not a guest process's linear memory. A guest mapping a
file in a host-served `/dev/shm` goes through the same publish/refresh protocol
— the mapping kind beside `fd_writeback` is *"a tracked file `MAP_SHARED`
interval over a host-backed page cache"*. **Both paths are boundary-synchronous.
Moving `/dev/shm` in-kernel trades nothing away.**

**4. And the kernel's own code already calls this out as an anomaly.**
`devfs.rs`: *"`/dev/shm` is POSIX shared memory, served by a host mount on both
hosts rather than by this module. **It is the sole exception to kernel ownership
of the `/dev` namespace.**"*

**Conclusion: move it.** The kernel owns all of `/dev` but this one subtree,
owns `/` and every scratch prefix, and already maps its own files shared. The
host mount is the last holdout, and it is the only reason a second SFFS
implementation has to exist in TypeScript.

**What this leaves of V9**, once `/dev/shm` moves: two `SAB` formats (or zero,
if the kernel formats what it takes), one four-call read helper with one caller,
and the host-owned lazy duties that were never block operations. **V10 —
deleting `sharedfs-vendor.ts` and taking `sffsTypeScript` to its target of 0 —
becomes reachable.**

**What I did NOT check**, kept honest: whether any guest program depends on
`/dev/shm` mappings being coherent SOONER than a syscall boundary. Nothing in
the platform offers that today on any path, so such a program would already be
broken — but I have not audited the guests to say it never happens.

---

## SCOPING 2026-09-13 — what moving `/dev/shm` in-kernel actually touches

Mapped read-only, so the work is known before it is authorised.

**The routing today.** `tmpfs::claims_path` is a pure prefix match against
`SCRATCH_MOUNTS`, and `syscalls.rs` gates every path operation on it. `/dev` is
served by `devfs`, and `devfs::is_host_backed_path` carves out `/dev/shm` as
"the sole exception to kernel ownership of the `/dev` namespace". About **ten
call sites** in `syscalls.rs` test `is_host_backed_devfs_path`, each of the
shape `is_devfs_namespace_path(p) && !is_host_backed_devfs_path(p)`.

**The shape of the change.** Flipping `is_host_backed_path` is NOT enough, and
would be actively wrong: the devfs branch runs BEFORE the tmpfs branch, so
`/dev/shm/foo` would be claimed by devfs, which knows only the fixed entry names
and would answer `ENOENT`. What is needed is that

* `/dev/shm` **itself** stays a devfs directory entry — a mount point;
* `/dev/shm/*` routes to **tmpfs**, which means adding it to `SCRATCH_MOUNTS`
  with its own `st_dev` and mode `0o1777`;
* the ten gates learn the difference between "the mount point" and "inside the
  mount", which today they do not have to.

**The host side then deletes:** `MemoryFileSystem.create(shmSab)` in
`browser-kernel-host.ts` and `node-kernel-worker-entry.ts`, the `/dev/shm`
`MountConfig`, and the shm `SharedArrayBuffer` itself.

**Estimate: this is a kernel syscall-routing change, not a builder change.** It
is larger than any single increment in this lane so far and it lands in
`syscalls.rs`. It wants its own increment with its own trials, and the mount
point/inside-the-mount distinction is where a mutation should be aimed first.

**The sticky bit: checked, and it is a non-issue.** `/dev/shm` is mode `0o1777`,
and the sticky bit is what stops one process deleting another's shm segment.
`tmpfs.rs` mentions `S_ISVTX` nowhere and its `unlink` performs no ownership
check at all — which looks alarming and is not.

**Enforcement lives in `syscalls.rs`, above filesystem dispatch.**
`check_sticky_child` reads the parent's mode and refuses with `EPERM` unless the
caller owns the parent or the child, and it is called from eight sites covering
unlink, rmdir and both halves of rename. It applies to whichever filesystem
serves the path, which is why tmpfs not implementing it internally is correct
rather than missing — it is not tmpfs's job.

`/tmp` is already `0o1777` and already served by the in-kernel tmpfs, so this
arrangement is in production today. **Moving `/dev/shm` there loses nothing.**

---

## AFTER THE MOVE, 2026-09-13 — what is actually left of V9

Measured once `/dev/shm` was kernel-owned, so this is the remainder rather than
an estimate. Every `MemoryFileSystem` reference left in `host/src`:

**1. `process-lifecycle.ts` — TYPE-ONLY, three references.**
`rootfsBaseImage(): MemoryFileSystem | null | undefined`, a `baseImage` field,
and `Parameters<MemoryFileSystem["setLazyFetcher"]>[0]` for a fetcher type.
Nothing here calls a filesystem method. **This is the file that may collide with
lane F** — it sits near the fork glue, and whoever lands second rebases.

**2. `browser-kernel-worker-entry.ts` — the `/` backend, and it is NOT block
operations.** What the worker actually asks of it:

| call | what it is |
|---|---|
| `rewriteLazyFileUrls`, `rewriteLazyArchiveUrls` | rewriting fetch descriptions |
| `setLazyFetcher`, `subscribeLazyDownloads` | installing the host transport |
| `importLazyEntries`, `importVerifiedLazyArchiveEntries` | taking descriptions from the host |
| `readFileFromFs` | `open`/`fstat`/`read`/`close`, **one caller**, reading a log path |
| the `blob_read` byte store | serving deferred bytes the kernel asks for |

Six of the seven are **host-owned duties under the courier contract** — the host
decides whether a URL may be fetched and supplies the bytes — and stay in
TypeScript whatever happens to the block layer. The seventh is four calls.

**So V9's remainder is: one four-call read helper, a byte store, and a type.**
The census's original framing — 8,501 lines, the lane's only genuine unknown —
does not survive the measurement, and the reason is the one the first section
gave: the line count was counting duties that were never the filesystem's.

**The open question for V10** is whether the `/` backend can hold image bytes
and serve `blob_read` WITHOUT `SharedFS` underneath it. That is the last thing
between `sffsTypeScript` and its target of 0, and it is a smaller question than
"replace a filesystem": the kernel parses the image itself and resolves no
names, so what the host needs is a byte window plus the lazy JSON, not a
filesystem.

**One consequence already paid**, recorded because it will recur: `/dev/shm` was
the LAST host mount on Node, so removing it left `VirtualPlatformIO` with none
and its constructor guard turned "the kernel owns everything" into a boot
failure. Zero mounts is the destination, and the guard is gone; `resolve` still
refuses an unroutable path by name. **Expect more guards that encode "there is
always at least one host X".**
