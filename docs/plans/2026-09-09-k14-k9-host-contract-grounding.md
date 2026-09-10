# K14 + K9 grounding: making the host contract checkable, then handle-only

> Read-only grounding. No code was modified. Worktree
> `/Users/brandon/kandelo-abi44-reconcile`, branch
> `integration/k-tier1-20260909`, head `bd3364c95`.
>
> Companion to `2026-09-09-rust-first-value-plan.md` (§4 = the V4 concept
> table; §2g D1 = the K2 deferral that created K14),
> `2026-09-09-k2-cross-memory-grounding.md` (§10 #2),
> `2026-09-09-whole-kernel-rust-migration-census.md` §6/§7,
> `2026-09-09-runtime-ts-disposition-ledger.md` §2.

---

## 0. Executive summary

**K14 is smaller than estimated and worth more than estimated.** The
import section is *already parsed* by `dump_abi.rs` — it is walked purely
for index arithmetic and then discarded (`tools/xtask/src/dump_abi.rs:7226-7256`).
Recording it is ~40 lines in the generator plus ~50 in the compatibility
classifier and ~10 of registration. The extra value is that the classifier
for imports is the **inverse** of the one for exports: *adding* a host
import is backward-incompatible (an existing host cannot satisfy it) while
*removing* one is compatible. That means K14 does not merely make K9's 25
removals visible — it makes **any future host-import addition fail the ABI
gate by default**. That is a structural enforcement of the campaign's
standing STRONG DOUBT, not just a diff.

**Four load-bearing inherited claims did not survive re-checking.** Per the
ledger's warning that this campaign has now inherited a stale "floor" four
times, everything below was re-verified against the source and the built
artifact rather than carried forward.

| inherited claim | status | evidence |
|---|---|---|
| "85 `env.host_*` bindings" (census §6, value plan §2/§4) | **WRONG — 84 in the artifact.** 85 are *declared*; `host_debug_log` is dead-code-eliminated and is not imported by the built kernel | `wasm-objdump -x -j Import local-binaries/kernel.wasm` → `Import[85]` = 84 `env.host_*` + `env.memory`; `comm` against the 85 declared names in `crates/kernel/src/wasm_api.rs:55-265` leaves exactly `host_debug_log` |
| "diagnostics: 1 concept" (census §6; ledger §2.8 lists `host_debug_log` as a KEEP floor) | **Already 0.** `runtime_core::debug_log` (`crates/runtime-core/src/lib.rs:70-79`) has no live caller, so the import never reaches the module. `crates/host-native/src/guest.rs:1964-1978` registers a handler for an import that does not exist | as above |
| "OPFS … reached by path today" (task brief; ledger §2.3) | **Not wired.** `OpfsFileSystem` is constructed only in `host/test/**` and `apps/browser-demos/test/fixtures/**`. No production mount table builds one | `grep -rn OpfsFileSystem` over the repo excluding `node_modules`/`dist`; `web-libs/kandelo-session/src/kernel-host.ts:2742` is a `/proc/mounts` *display* string, not a backend |
| `host_access` is part of the live contract | **Dead.** Zero kernel call sites; the only non-test references are the trait declaration and stub impls | `crates/runtime-core/src/process.rs:115`; no `.host_access(` anywhere in `crates/runtime-core/src/syscalls.rs` outside test doubles |

**The single most important architectural fact for K9, and it is good news.**
The kernel already resolves the *whole* namespace itself, component by
component, including `..` and symlink traversal
(`resolve_namespace_path_from`, `crates/runtime-core/src/syscalls.rs:2250`).
After the Phase-5 cutover the host `/` mount is **unconditionally dropped**
from the guest-facing `VirtualPlatformIO`
(`host/src/node-kernel-worker-entry.ts:1244`,
`host/src/browser-kernel-worker-entry.ts:1148-1154`). Every path is claimed
by in-kernel `tmpfs` or in-kernel `rootfs` before the host is consulted
(`fs_lstat`, `syscalls.rs:3468-3477`; `do_open`, `syscalls.rs:3320-3358`).
The residual host-path surface is exactly the **foreign mount prefixes**
(`rootfs::owns_path`, `crates/runtime-core/src/rootfs.rs:614-618`), which in
production are `/dev/shm`, `/dev`, and — on Node only — user-specified
`--mount` host directories.

**Therefore the value plan's "25 → 0" is right in spirit and wrong in
mechanism, and I am correcting it.** A host that owns a real directory
*cannot* be handed a handle for a file that does not exist yet: `mkdir`,
`unlink`, `rename`, `symlink`, and `lstat`-of-a-symlink have no handle-only
form on any host API. The reachable and better target is:

> **0 imports a host must implement, plus ~9 imports in an *optional*
> host-directory capability** whose shape is `openat`: one operation, one
> already-held directory handle, one path *component*. The host stops
> resolving *paths*. It never sees a guest path, a mount prefix, a symlink
> chain, or a `..`.

The browser, after K8's in-kernel shmfs, implements **zero** of them —
exactly as `crates/host-native/src/guest.rs:2054-2058` already does today
when no mount is configured ("a truthful boundary, since the overlay claims
all of `/`").

**Ordering.** K14 → K8 → K9. The brief's K14-before-K9 is right and I am
adding one more: **K9 should follow K8, not merge with it.** Before K8, the
browser's only host FS consumer is `/dev/shm` backed by `MemoryFileSystem` —
a data structure, not a host capability. Designing an `openat` host contract
against a data structure that K8 deletes would let a non-host drive the shape
of the host contract. After K8 the only consumer is a genuine host directory
(Node `fs`, and a future OPFS workspace), and the design is forced by the
real constraint.

---

## 1. K14 — record the host import signatures in the ABI snapshot

### 1.1 The blind spot, stated precisely (VERIFIED)

`abi/snapshot.json` carries `kernel_exports` — name, kind, and, for
functions, a rendered signature — parsed from the built
`kandelo_kernel.wasm` (`dump_abi.rs:4294-4296`, `kernel_exports()` at
`:7191`). It carries **nothing** about imports. `grep -c host_open
abi/snapshot.json` → 0.

K2 widened `host_proc_read_bytes` / `host_proc_write_bytes` from `addr: u32`
to `addr: u64` — a change to how the host interprets a kernel-supplied
pointer, visible in the module as `i32 → i64` — and
`scripts/check-abi-version.sh` reported no diff (value plan §2g).

`docs/abi-versioning.md:1059-1070` already anticipates this class of gap:
*"Things not in the generator's coverage list … Treat the coverage list as
itself ABI-critical."* K14 adds the largest missing entry on that list.

### 1.2 Design: reuse the pass that is already there

`kernel_exports()` walks `Payload::ImportSection` today
(`dump_abi.rs:7226-7256`) solely to count imported funcs/globals so that
export indices resolve correctly. It handles all three wasmparser 0.247
import-group encodings (`Single`, `Compact1`, `Compact2`) and then throws the
module name, field name, and `TypeRef` away.

The change is to keep them.

**Step 1 — generator (~40 lines).** In the same `tick` closure, also push
`(module, name, ty)`. After the parse loop, render each:

- `TypeRef::Func(ti)` / `FuncExact(ti)` → `func_types[ti]` →
  `format_func_type()` (`dump_abi.rs:7349`, already written and already used
  for exports, so imports and exports render in one identical notation).
- `TypeRef::Memory(mt)` → `{shared, minimum, maximum}` — the same three
  facts `crates/host-native/src/lib.rs:100-113` already extracts, so the
  snapshot and the native ratchet stop being two independent readings of one
  fact.
- `TypeRef::Global`/`Table`/`Tag` → kind plus type.

Emit sorted by `(module, name)` for determinism, matching the export path
(`dump_abi.rs:7286-7288`). **No filter.** `export_is_tracked` exists because
LLVM emits toolchain exports nobody contracts on; the import list has no such
noise — the current artifact's entire import section is 84 `env.host_*` plus
`env.memory`. Completeness is the point.

**Step 2 — registration (~3 lines).** `root.insert("kernel_imports".into(),
kernel_imports(&wasm)?);` beside `dump_abi.rs:4296`. It reads the same
`wasm` buffer, so no extra I/O.

**Step 3 — compatibility classification (~50 lines). This is the part that
matters, and it is not a copy of the export rule.**

For *exports*, `classify_compat_change` uses
`classify_additive_array_by_name` (`dump_abi.rs:7425-7427`): adding an export
is additive, removing one is breaking.

For *imports* the polarity inverts, because an import is a **requirement the
host must satisfy**:

| change | classification | why |
|---|---|---|
| import **added** | **BREAKING** | a host built against the old contract has no such function; instantiation fails |
| import **removed** | additive / compatible | WebAssembly instantiation looks imports up by name; a host that still provides an unused one is unaffected |
| signature **changed** | **BREAKING** | this is exactly the K2 case |
| `env.memory` shape changed | **BREAKING** | shared-ness and limits are part of the channel handshake |

So K14 needs a `classify_removal_only_array_by_name`, a mirror of
`classify_additive_array` (`dump_abi.rs:7577`) with the added/removed arms
swapped, plus a `"kernel_imports"` arm in the `match` at `:7421`.

**Consequence, and the strongest argument for doing K14 first:** after K14,
**adding a host import fails `scripts/check-abi-version.sh` unless someone
deliberately bumps `ABI_VERSION` or explicitly accepts it.** The campaign's
standing STRONG DOUBT about growing the host surface stops being a review
convention and becomes a gate. That is worth more than the diff visibility
K2's D1 asked for.

**Step 4 — the one-time introduction must be declared additive (~1 line, and
it is a trap if missed).** `classify_compat_change` treats a top-level
section present in the new snapshot but absent in the old as **breaking**
unless it is listed in `additive_top_level_section`
(`dump_abi.rs:7391-7403`, `:7455-7460`). The introducing commit compares
against `origin/main`, whose snapshot has no `kernel_imports` key. Without
adding `"kernel_imports"` to that list the ABI gate fails on K14 itself, and
the tempting wrong fix is an `ABI_VERSION` bump. Add it.

**Step 5 — docs (~15 lines).** A bullet in the ABI 44 section
(`docs/abi-versioning.md:868-890`, alongside the 24 export removals) and an
entry in the coverage discussion at `:1059`.

### 1.3 Size

| part | lines |
|---|---|
| generator: keep module/name/type, render | ~40 |
| registration | ~3 |
| inverse classifier + `match` arm | ~50 |
| `additive_top_level_section` entry | 1 |
| unit tests in `dump_abi.rs`'s existing test module (`:8660-8930` has the pattern) | ~40 |
| docs | ~15 |
| **total** | **~150** |

K2 estimated 50-100 for the generator alone; that estimate is accurate for
what it scoped. The inverse classifier is the part K2 could not see from
outside.

### 1.4 The one-time additive diff

84 function imports plus `env.memory`. At the export section's rendering
density (`{name, kind, signature}` pretty-printed) that is **≈350-430 added
JSON lines**, sorted, deterministic, with no other section touched. Sample of
what the first line looks like, using the real current signature:

```
{"module":"env","name":"host_open","kind":"func","signature":"(i32,i32,i32,i32) -> (i64)"}
```

Classification: `added top-level section "kernel_imports"` → additive.
**No `ABI_VERSION` bump.** `docs/abi-versioning.md:1091-1099` (pure additions
do not bump) and the unreleased-44 amendment rule at `:861-866` both cover
it.

### 1.5 Two decisions K14 must make explicitly, not by default

**(a) Pointer width. The snapshot is wasm32-only.**
`scripts/check-abi-version.sh:34` builds and reads
`target/wasm32-unknown-unknown/release/kandelo_kernel.wasm`. Eleven imports
take `usize` parameters and therefore have *different wasm signatures on
wasm64*:

`host_futex_wait`, `host_futex_wake`, `host_bind_framebuffer`,
`host_fb_write`, `host_gbm_bo_bind`, `host_gbm_bo_unbind`, `host_gl_bind`,
`host_gl_create_context`, `host_gl_create_surface`, `host_gl_submit`,
`host_gl_query`
(`crates/kernel/src/wasm_api.rs`, extern block `:55-265`).

A wasm64-only signature drift would still be invisible. It is **not** the
blind spot K2 hit — K2's `u32 → u64` widening is explicit, not `usize`, so it
shows on wasm32 — but it is a residual one and must be stated rather than
discovered later. See NEEDS-DEFER-DECISION #1.

**(b) `EXPECTED_HOST_IMPORT_COUNT` keeps its meaning.**
`crates/host-native/src/lib.rs:89` and the surrounding changelog
(`:60-88`) stay as they are. K14 supersedes the *count* as a checker but the
changelog prose is the only place recording implemented-vs-trapped coverage,
which the snapshot cannot express. Do not delete it; do note in its comment
that signatures are now snapshot-checked.

### 1.6 What K14 finds on day one

Running it will surface, in the first snapshot, that `env.host_debug_log`
does not exist. That contradicts ledger §2.8 (which lists it as a KEEP floor)
and makes `crates/host-native/src/guest.rs:1964-1978` a handler registration
for a nonexistent import. Registering an unused import on a wasmtime `Linker`
is harmless, so this is dead code and a doc error, not a defect — but it is a
five-month-old fact that nobody noticed, which is the case for K14 in one
line. See NEEDS-DEFER-DECISION #3.

---

## 2. K9 — the 25 name-and-metadata imports, enumerated

### 2.1 How the 25 are constituted (VERIFIED, and the census never listed them)

Census §6's first row is "file **names** + metadata: 25". Reconstructing it
from the extern block (`crates/kernel/src/wasm_api.rs:55-265`) and checking
that the other eleven rows still sum correctly gives exactly one partition:
**18 path-taking + 2 completing the directory iterator + 5 handle-metadata =
25.** The remaining rows then sum to 60, and 25 + 60 = 85 declared / 84 in
the artifact (`host_debug_log` being the difference, §0).

### 2.2 The table

Every Rust call site is in `crates/runtime-core/src/syscalls.rs` unless
noted. Test-double impls are excluded. "Host does" describes the production
TS path: `host/src/kernel.ts` binding → `VirtualPlatformIO.resolve()`
longest-prefix mount routing (`host/src/vfs/vfs.ts:103-120`) → a
`FileSystemBackend` (`host/src/vfs/types.ts:27-90`).

#### Group A — path-taking (18)

| # | import | TS binding | Rust call sites | what the host actually does | handle-based replacement |
|---|---|---|---|---|---|
| 1 | `host_open` | `kernel.ts:1555` (`#hostOpen` `:2689`) | `:2651`, `:3359`, `:7910`, `:13193`, `:15018` | routes the full guest path to a backend, which re-walks it | `host_openat(dir, name, flags, mode)` |
| 2 | `host_stat` | `:1696` | `fs_stat` `:3464` (sole) | path walk **with** final symlink follow — a second, independent symlink resolution after the kernel already did one | `host_fstatat(dir, name, flags=0)` |
| 3 | `host_lstat` | `:1711` | `fs_lstat` `:3476` (sole); reached from `namespace_lstat_raw` `:2174` | path walk without final follow | `host_fstatat(dir, name, AT_SYMLINK_NOFOLLOW)` |
| 4 | `host_statfs` | `:1726` | `:18125` | mount lookup by path; the answer is a property of the *mount*, not the path | drop — kernel knows the mount; keep `host_fstatfs` on a handle |
| 5 | `host_pathconf` | `:1755` | `:17031`, `:17034`, `:17066` | per-mount limits by path | drop — same reason; `host_fpathconf` covers the handle case |
| 6 | `host_mkdir` | `:1786` | `:7801`, `:15221` | creates a directory entry | `host_mkdirat(dir, name, mode)` — **irreducibly name-taking** |
| 7 | `host_rmdir` | `:1789` | `:7816`, `:15160` | removes a directory entry | fold into `host_unlinkat(dir, name, AT_REMOVEDIR)` |
| 8 | `host_unlink` | `:1792` | `:7917`, `:7921`, `:7928`, `:7938`, `:7945`, `:8036`, `:8041`, `:8093`, `:13215`, `:15172` (10 sites) | removes an entry | `host_unlinkat(dir, name, 0)` — **irreducibly name-taking** |
| 9 | `host_rename` | `:1795` | `:8164`, `:15289` | **two** full paths, each re-walked | `host_renameat(olddir, oldname, newdir, newname)` — two handles, two components |
| 10 | `host_link` | `:1798` | `:8205`, `:17701` | two full paths | `host_linkat(olddir, oldname, newdir, newname, flags)` |
| 11 | `host_symlink` | `:1801` | `:8227`, `:17744` | target is opaque data; **linkpath** is a name to create | `host_symlinkat(target, dir, name)` |
| 12 | `host_readlink` | `:1804` | `:2197` (inside `namespace_readlink_raw`, i.e. inside the kernel's own walk), `:8263`, `:17781` | path walk, then read link body | `host_readlinkat(dir, name, buf)` |
| 13 | `host_chmod` | `:1819` | `:8288`, `:17309`, `:17606` | path walk, then mode | `host_openat` + existing `host_fchmod` (POSIX imposes no `lchmod`; Linux `fchmodat` ignores `AT_SYMLINK_NOFOLLOW`) |
| 14 | `host_chown` | `:1822` | `:3361`, `:7802`, `:7911`, `:8382`, `:13199`, `:15020`, `:15222`, `:17397`, `:17649` (9 sites) | path walk, then owner | `host_openat` + existing `host_fchown` |
| 15 | `host_lchown` | `:1825` | `:8408`, `:17647` | must **not** follow the final symlink, and a symlink cannot be opened | `host_fchownat(dir, name, uid, gid, AT_SYMLINK_NOFOLLOW)` — **irreducible; this is why `fchown` alone is not enough** |
| 16 | `host_access` | `:1828` | **none** | nothing — the kernel answers `access(2)` from its own metadata | **delete outright** (see NEEDS-DEFER-DECISION #2) |
| 17 | `host_opendir` | `:1831` | `:5578`, `:8507`, `:8664`, `:8983` | path walk, then open an iterator | `host_openat(dir, name, O_DIRECTORY)` — no separate import needed |
| 18 | `host_utimensat` | `:1972` | `:10002`, `:10117` | path walk, then timestamps | `host_openat` + a handle-form `futimens`; or `host_utimensat(dir, name, …, flags)` if `AT_SYMLINK_NOFOLLOW` is required |

#### Group B — the directory iterator, which is stateful (2 more)

`host_opendir` / `host_readdir` / `host_closedir` are **not three
independent calls**; they are one host-owned cursor with a documented
consume-exactly-once contract. `crates/runtime-core/src/process.rs:117-127`
states it: *"An error must leave the iterator at the same entry. The kernel
may return a short successful `getdents64` result after earlier records were
copied, then retry this host operation on the next syscall."* The kernel
enforces the other side at `syscalls.rs:8582-8598` — a reported `name_len`
larger than the buffer is treated as `EIO`, "a broken host contract, not a
safe partial result", and `.`/`..` are synthesized kernel-side and skipped
from the host stream.

| # | import | TS binding | Rust call sites | note |
|---|---|---|---|---|
| 19 | `host_readdir` | `kernel.ts:1834` | `:5584`, `:8583`, `:8724`, `:9047` | keep as-is — already handle-based. Its contract is the delicate part and must survive K9 unchanged |
| 20 | `host_closedir` | `kernel.ts:1853` | 14 sites: `process_table.rs:1282`; `syscalls.rs:933`, `:4183`, `:5570`, `:5587`, `:5601`, `:5616`, `:5630`, `:8643`, `:8666`, `:8669`, `:8775`, `:9129`, `:9704` | **delete** — a directory handle from `host_openat(…, O_DIRECTORY)` closes with `host_close`. 14 call sites collapse onto an existing one |

#### Group C — metadata on a handle (5). Already the right shape; they move concepts, not disappear

| # | import | Rust call sites | disposition |
|---|---|---|---|
| 21 | `host_fstat` | `exec_target.rs:544`; `syscalls.rs` `:2652`, `:3370`, `:3948`, `:6052`, `:6996`, `:7095`, `:7239`, `:7353`, `:15026`, `:17183`, `:17353`, `:17442`, `:19629` (14) | **keep.** Moves into the "file bytes/metadata on a handle" concept |
| 22 | `host_fstatfs` | `exec_target.rs:813`; `syscalls.rs:18136` | **keep**; absorbs `host_statfs` |
| 23 | `host_fpathconf` | `syscalls.rs:17095` | **keep**; absorbs `host_pathconf` |
| 24 | `host_fchmod` | `syscalls.rs:17355` | **keep**; absorbs `host_chmod` |
| 25 | `host_fchown` | `syscalls.rs:17444` | **keep**; absorbs `host_chown` |

### 2.3 Arithmetic

25 imports in → **9 out**: `host_openat`, `host_fstatat`, `host_mkdirat`,
`host_unlinkat`, `host_renameat`, `host_linkat`, `host_symlinkat`,
`host_readlinkat`, `host_fchownat` (+ `host_utimensat` reshaped in place,
not added). Plus 6 pre-existing handle ops (`host_fstat`, `host_fstatfs`,
`host_fpathconf`, `host_fchmod`, `host_fchown`, `host_readdir`) that stay
where they are but re-file under a different concept.

**Net import count: 84 → 68.** Monotone down, with no name arriving that
does not retire a named predecessor in the same commit.

---

## 3. The hard part: which host mounts still need name resolution?

### 3.1 What is actually reachable today (VERIFIED)

The brief's premise — "OPFS, Node fs, and `/dev/shm` are reached by path
today" — is one-third right.

**Kernel-side gating.** Every path operation runs the same cascade before it
can reach the host: `tmpfs::claims_path` → `rootfs::claims_path` → host
(`fs_stat`/`fs_lstat`, `syscalls.rs:3458-3477`; `do_open`, `:3320-3358`).
`rootfs::owns_path` (`crates/runtime-core/src/rootfs.rs:614-618`) is
`starts_with('/') && !tmpfs::owns_path && !path_under_foreign`. So the host
is reachable **only** under a registered foreign prefix.

**Host-side mount tables.** Both entries drop `/`:

```
const guestMounts = mounts.filter((m) => m.mountPoint !== "/");
rootfsForeignPrefixes = guestMounts.map((m) => m.mountPoint);
```

(`host/src/node-kernel-worker-entry.ts:1244-1245`,
`host/src/browser-kernel-worker-entry.ts:1148-1154`; published to the kernel
via `kernel_rootfs_set_foreign_prefixes`, `host/src/kernel-worker.ts:5111-5118`
→ `rootfs.rs:515`.)

What survives:

| foreign mount | backend | is it a host capability? |
|---|---|---|
| `/dev/shm` | `MemoryFileSystem` over a `SharedArrayBuffer` (`node-kernel-worker-entry.ts:1178-1180`, `browser-kernel-worker-entry.ts:1131`) | **No.** An in-memory data structure. Census §7 step 2 already schedules it for in-kernel shmfs |
| `/dev` | `DeviceFileSystem` (339 lines) | **No, and probably unreachable.** `namespace_lstat_raw` returns `ENOENT` for any `/dev/*` that is not `/dev/shm/*` and not a kernel-known device (`syscalls.rs:2158-2163`), and 12 further sites gate on `!is_host_backed_devfs_path` (`:2338`, `:2471`, `:3286`, `:7698`, `:7744`, `:8499`, `:14939`, `:15113`, `:17026`, `:17091`, `:18112`). `/dev/shm/*` routes to the longer-prefix shmfs mount, not here. INFERRED that this mount is fully shadowed; worth a runtime assertion |
| Node `--mount` extras | `HostFileSystem` over `node:fs` (`node-kernel-worker-entry.ts:1183`) | **Yes.** The one genuine host-directory capability in production |
| Node scratch (`/tmp`, `/var/*`, `/home/maker`, `/root`, `/srv`) | `HostFileSystem` under a per-boot temp dir (`host/src/vfs/default-mounts-node.ts:99-101`) | **Materialized but shadowed** — `tmpfs::claims_path` intercepts all of these first |
| OPFS | — | **Not mounted.** Only `host/test/**` and `apps/browser-demos/test/fixtures/**` construct `OpfsFileSystem` |

So: **in the browser, zero production host-directory capability exists
today.** On Node, exactly one does, and it is an explicit product feature
(expose a real host directory to the machine).

### 3.2 Why "handle-only" cannot literally mean zero names

The host must be able to *create* a directory entry. `mkdir`, `unlink`,
`rename`, `symlink`, and `link` name an entry that does not yet exist or is
about to stop existing; there is no handle for it. `lstat` and `lchown` name
an entry the host must **not** open, because opening a symlink follows it.

No host API escapes this. Node has `fs.mkdirSync(path)`, not
`mkdirat(fd, name)`. OPFS is closer — `dirHandle.getDirectoryHandle(name,
{create:true})` — but still takes a name. POSIX itself concedes the point:
the `*at` family exists precisely because the final component is
irreducible.

Claiming otherwise would require a "resolve the rest of this path for me"
escape hatch, which is the defect being removed.

### 3.3 The protocol

**Invariant: the host resolves at most one path component, relative to a
directory handle it previously issued. It never sees a guest path, a mount
prefix, a `..`, or a symlink chain.**

**Boot.** The host already publishes its foreign mount prefixes to the
kernel (`kernel-worker.ts:5111-5118` → `rootfs::set_foreign_prefixes`,
`rootfs.rs:515`, a NUL-separated list). Extend that payload to carry a
**root directory handle per prefix**, allocated by the host at mount time
exactly as it already allocates file and dir handles (`vfs.ts:62-64`
`fileHandles`/`dirHandles`; `host-fs.ts`). This rides an existing **kernel
export**, which is free under V4 — the measured surface is host imports.

**Steady state.** `resolve_namespace_path_from` (`syscalls.rs:2250`) already
walks components one at a time and already knows which foreign mount owns
the path. It changes from *"accumulate a canonical string, hand the whole
thing to the host at the end"* to *"carry a host directory handle alongside
the walk, and step it with `host_openat(dir, component, O_DIRECTORY|O_NOFOLLOW)`"*.
Symlinks encountered mid-walk are read with `host_readlinkat` and spliced
into the kernel's existing `pending` component queue (`:2225-2240`), which is
what the kernel does today for its own filesystems. The final operation takes
`(dir_handle, last_component)`.

**Precedent — this is not a new mechanism.** The kernel already issues and
consumes synthetic negative handles for its own filesystems, in disjoint
bands: tmpfs files `(-3e9, -2e9]`, tmpfs dirs `(-4e9, -3e9]`, rootfs files
`(-5e9, -4e9]`, rootfs dirs `(-6e9, -5e9]`
(`tmpfs.rs:494-511`, `rootfs.rs:627-635`). Positive handles are the host's.
K9 makes the host's positive-handle space carry directories too — a
generalization of a working scheme, not an invention.

**Does it need a NEW import? No — and here is the discipline that makes that
checkable.** Every `*at` import must retire a named predecessor in the same
commit, and `EXPECTED_HOST_IMPORT_COUNT` must strictly decrease. After K14
this is enforced mechanically: an import name that appears in the new
snapshot but not the old classifies as **breaking**, so the ABI gate fails on
an addition. If an implementer finds themselves wanting `host_fdopendir`,
`host_openat2`, `host_mount_root_handle`, or anything shaped like "resolve
the remainder for me" — **STOP.** The first three are additions; the fourth
is the defect.

**The `preparePath` hook is a real complication and must not be forgotten.**
`PlatformIO.preparePath?(path): Promise<boolean>` (`host/src/types.ts:66-71`)
materializes deferred/lazy backing *by path* before synchronous I/O. It is
not one of the 25 imports (it is an internal TS callback, not an
`env.host_*`), but it is path-shaped and K9 must either re-express it
per-component or confirm it is already dead in the guest path now that the
rootfs overlay owns lazy materialization
(`rootfs-lazy-archives.ts`, `host_fetch_archive`). Not resolved by this
grounding.

### 3.4 The honest V4 framing: mandatory versus optional

Because the whole family is reachable only under a foreign prefix, and
because `crates/host-native/src/guest.rs:2054-2058` already demonstrates the
pattern — the FS imports are wired *only* when a mount is configured, and are
otherwise left to `define_unknown_imports_as_traps` — K9's real output is:

- **0 imports a host must implement** to run Kandelo.
- **~9 imports in an optional "expose a host directory" capability**, with an
  `openat` shape a host author already knows.

The browser, after K8, implements zero. host-native with no `--mount`
implements zero (already true). Node with `--mount` implements nine.

---

## 4. Interaction with K8

**Overlap, quantified.**

| | K8 | K9 |
|---|---|---|
| deletes | `memory-fs.ts` (8,269) + `sharedfs-vendor.ts` (3,752) as guest-facing readers; folds `/dev/shm` into an in-kernel shmfs generalized from `tmpfs.rs` (census §7 step 2) | the *contract*: 25 imports, their `kernel.ts` bindings (`:1555-1990`, ~330 lines), `VirtualPlatformIO`'s path-routing (`vfs.ts`, 498 lines — its entire job is mount-prefix routing the kernel now does), and the path half of `FileSystemBackend` (`types.ts:67-90`) |
| leaves behind | the host-directory capability | the backends |
| production reach it removes | **all browser reach for all 25** (`/dev/shm` is the browser's only non-shadowed foreign mount) | Node `--mount` re-shaped, not removed |

**Verdict: K9 follows K8. Do not merge them.**

Three reasons:

1. **Design integrity.** Before K8, the browser's only consumer of the FS
   contract is `MemoryFileSystem` behind `/dev/shm` — a data structure, not a
   host. Designing an `openat` protocol against it would let a non-host set
   the shape of the host contract, and would produce an API tuned to
   something K8 then deletes. After K8, the only consumer is a real
   directory, and Node `fs` / OPFS force the design honestly. This is the
   platform-values rule ("a fix that only makes one program work is suspect")
   applied to a contract.

2. **Blast radius.** K8 is ~12,000 lines of backend migration; K9 is a
   contract reshape touching `wasm_api.rs`, the `HostIO` trait, ~90 Rust call
   sites, `kernel.ts`, `vfs.ts`, `host-fs.ts`, and `host-native/guest.rs`.
   Landing them together makes a bisect on any FS regression useless.

3. **Validation.** K9-after-K8 has a clean claim: "the browser now implements
   zero of the file-name family; here is the trap-count proving it." That
   claim is unavailable while `/dev/shm` still routes through `host_open`.

**Independence caveat.** Two items in the table are independent of both and
can land at any time: deleting `host_access` (dead, §2.2 #16) and resolving
`host_debug_log` (§0). Neither needs K8 or the `*at` design.

---

## 5. host-native cost

**What it implements today (VERIFIED).** 21 of 84, all in
`define_kernel_host_imports` (`crates/host-native/src/guest.rs:1844-2450`);
~60 are left to `define_unknown_imports_as_traps` (`:1656`). The 21:
`host_futex_wake`, `host_proc_read_bytes`, `host_proc_write_bytes`,
`host_write`, `host_debug_log`, `host_clock_gettime`, `host_close`,
`host_read`, `host_lstat`, `host_stat`, `host_open`, `host_pread`,
`host_seek`, `host_fstat`, `host_readlink`, `host_opendir`, `host_readdir`,
`host_closedir`, `host_blob_read`, `host_getrandom`, `host_waitpid`.

**Eight of those 21 are in K9's 25:** `host_open` (`:2098`), `host_stat` /
`host_lstat` (`:2064`, one shared closure), `host_fstat` (`:2193`),
`host_readlink` (`:2217`), `host_opendir` (`:2246`), `host_readdir`
(`:2289`), `host_closedir` (`:2330`). All eight are already gated on
`!fs.mounts.is_empty()` (`:2054-2058`) — host-native is the only host that
already treats the FS family as an optional capability, which is why it is
the right place to prove the new contract first.

**What changes.**

| work | size |
|---|---|
| `host_open` → `host_openat`; `host_stat`/`host_lstat` → one `host_fstatat`; `host_readlink` → `host_readlinkat` | 4 closures rewritten, ~120-150 lines (current ones are 25-40 lines each) |
| delete `host_opendir` + `host_closedir`; route dir handles through the existing `host_close` (`:1998`) and the existing handle table | ~-60 lines |
| `host_readdir`, `host_fstat` | unchanged in signature; must accept a dir handle from the unified table |
| **new**: a directory-handle table beside `fs.files` (`Mutex<HashMap<i64, File>>`) | ~80 lines |
| **replace** `HostMountFs::resolve` (guest-path → real path) with per-component `openat` | net negative, but requires a real `openat` |
| the nine new `*at` closures for the write side (`mkdirat`, `unlinkat`, `renameat`, `linkat`, `symlinkat`, `fchownat`, `utimensat`) — host-native traps all of these today, so these are **new native capability**, not relocations | ~250 lines |
| `kernel_import_surface` expectations + `EXPECTED_HOST_IMPORT_COUNT` changelog (`lib.rs:60-89`) | ~25 lines |
| tests (host-native has 52 today) | ~100 lines |
| **total** | **~500-700 lines** |

**Honest complication: Rust `std` has no `openat`.** `std::fs` is
path-based. A sound native implementation needs `rustix::fs::openat` (or
`cap-std`, which is the same crate family and gives the whole `*at` set with
sandbox semantics built in). host-native is a native crate, so a dependency
there is ordinary rather than exotic — but it is a decision, not an
implementation detail, and it is the difference between "reshape the eight"
and "reshape the eight plus adopt a new dependency". See
NEEDS-DEFER-DECISION #4.

**This is not the cheap part of K9.** It is where the contract stops being a
diagram. host-native is the only host with a real directory tree directly
behind the imports and no `VirtualPlatformIO` in between, so it is the honest
test of whether `openat`-shaped is actually implementable — and it is also
where K9 *gains* native capability (`mkdirat` and friends are traps today).

---

## 6. The V4 target, re-derived

### 6.1 The corrected table

Baseline is the **built artifact's 84**, not the source's 85.

| concept | value plan §4 said | verified now | corrected target | note |
|---|---|---|---|---|
| file **names** + metadata | 25 → 0 | 25 declared, **24 live** (`host_access` dead) | **0 mandatory + ~9 optional** | cannot be 0 imports; can be 0 *required* ones (§3.2-3.4) |
| graphics / audio devices | 23 → ~8 | 23 | ~8 | unchanged; not re-derived here |
| sockets | 12 → ~6 | 12 | ~6 | unchanged |
| file **bytes** on a handle | 10 → ~6 | 10 | ~6, **+5 absorbed** from the metadata row (`fstat`, `fstatfs`, `fpathconf`, `fchmod`, `fchown`) and +1 (`readdir`) → ~12 | the row grows in count while the *contract* shrinks; this is why count is the wrong unit |
| wait primitives | 4 → 2 | 4 | 2 | unchanged |
| image bytes | 2 → 2 | 2 | 2 | unchanged |
| cross-memory copy | 2 → 2 | 2 | 2 | K2 done |
| clock / entropy | 2 → 2 | 2 | 2 | unchanged |
| timers | 2 → 1 | 2 | 1 | unchanged |
| guest invocation | 1 → 1 | 1 | 1 | unchanged |
| host process wait | 1 → 0-1 | 1 | 0-1 | native only |
| diagnostics | 1 → 1 | **0 live** (1 declared, DCE'd) | 0 or 1 | must be *decided*, not left ambiguous |
| **total imports** | 85 → ≈31 | **84** | **≈30 mandatory + ~9 optional** | |

**The §4 headline "85 → ≈31" survives, barely, and for the wrong reasons.**
The baseline is 84, not 85. The file-name row does not reach 0 imports. Five
of its members do not disappear — they re-file into the handle row, which
therefore *grows*. The two errors happen to roughly cancel. Corrected:
**84 → ≈30 imports a host must implement, plus ~9 in one optional
capability.**

### 6.2 Judge by concepts, and the concepts are these

A host author reading the contract must understand:

1. give me bytes at an offset on a handle you issued
2. tell me about the object behind a handle (stat/statfs/pathconf/chmod/chown)
3. iterate a directory handle, consuming exactly one entry per call, never
   partially
4. deliver image bytes on request
5. copy bytes into and out of a process's linear memory
6. park and wake a thread on an address
7. tell me the time; give me entropy
8. wake me at a deadline
9. call a guest export on my behalf
10. drive a display / audio device: attach, submit, query
11. do byte I/O on a socket
12. *(optional)* expose a real host directory: one operation, one directory
    handle I already hold, one path component

Twelve, one of them optional. Today the equivalent of #12 reads *"reimplement
a POSIX filesystem namespace in your host language, including symlink
resolution, `..`, mount routing, and permission semantics, and keep it
consistent with the kernel's"* — and that is the single largest concept in
the contract, present in every host, mandatory. That is the movement, and it
is a bigger one than 25 → 9 makes it sound.

### 6.3 What would count as cheating

Each of these would *improve* the count while making the contract worse.
Reject all of them.

1. **Opcode collapse.** `host_fs_op(op, dir_handle, name_ptr, name_len, a, b,
   c) -> i64`. Scores 25 → 1 and destroys wasm-level type checking, the
   per-operation errno contract, and any hope of an exhaustive match — the
   exact opposite of V2. Rule: **an import's wasm signature must be
   meaningful without a dispatch table.**
2. **Struct-pointer collapse.** One import taking a `repr(C)` request struct.
   Same defect wearing a type: it moves the contract out of the module's type
   section into hand-maintained offset pairs, which is the wasm32/wasm64
   duplication V2 exists to delete.
3. **Moving it to an export.** Re-expressing a host capability as a kernel
   export the host must call. The measured number falls; the host still
   implements the behavior. Rule: **count the behaviors a host author writes,
   whichever direction the call goes.**
4. **Trapping instead of implementing, and calling it removed.** host-native
   traps ~60 imports; that is honest *because it is a truthful boundary
   backed by a real restriction* (no mount configured → the overlay owns
   `/` → the path is unreachable). Trapping something a guest still needs is
   a regression disguised as progress.
5. **Deleting a capability rather than relocating it.** Removing `host_statfs`
   is legitimate only because `host_fstatfs` answers the same question from
   the mount the kernel already identified. Removing something that leaves a
   POSIX gap is a platform-values violation regardless of what it does to the
   count.
6. **Counting declared imports instead of imported ones.** `host_debug_log`
   has been in the census's 85 for the whole campaign and is not in the
   module. After K14 the snapshot settles this permanently; until then, count
   the artifact.

---

## 7. NEEDS-DEFER-DECISION

### #1 — Should K14 also record the wasm64 kernel's imports? — **STRONG DOUBT on the cost, not the goal**

- **What:** `scripts/check-abi-version.sh:34` builds and reads only
  `target/wasm32-unknown-unknown/release/kandelo_kernel.wasm`. Eleven imports
  take `usize` and therefore differ on wasm64 (§1.5a).
- **Cost now:** a second `cargo build --release -p kandelo` for wasm64 in
  every ABI check, plus a second snapshot section. The kernel build is the
  slowest part of `check-abi-version.sh` and it runs in CI and locally.
- **Cost later:** a wasm64-only import-signature drift stays invisible. Note
  this is *narrower* than the gap K2 hit: K2's `u32 → u64` is explicit and
  shows on wasm32.
- **Recommendation:** record wasm32 only in K14; name the section so it
  cannot be mistaken for both widths, and add a comment listing the eleven
  `usize`-carrying imports as the known residual. Revisit if a wasm64 host
  ever ships. **I will not decide this.**

### #2 — `host_access` is dead. Delete it now, or with K9?

- **What:** zero kernel call sites; only the trait declaration
  (`process.rs:115`), the extern (`wasm_api.rs:128`), the TS binding
  (`kernel.ts:1828`), the `FileSystemBackend` method (`vfs/types.ts:82`), and
  test doubles.
- **Cost now:** ~20 lines across four files, plus a snapshot regeneration
  (once K14 lands, this shows as an import removal → compatible, no bump —
  the same treatment K13a's 24 export removals got,
  `docs/abi-versioning.md:877-890`).
- **Cost later:** it inflates the "25" for the whole campaign and a future
  reader may implement it.
- **Recommendation:** delete it in a standalone commit **after K14** so the
  snapshot diff shows the removal — the first live demonstration that the new
  check works. It needs neither K8 nor the `*at` design.

### #3 — `host_debug_log`: give it a caller, or delete it?

- **What:** declared twice (`wasm_api.rs:56`,
  `runtime-core/src/lib.rs:70-79`), no live caller, DCE'd out of the module.
  `host-native/guest.rs:1964-1978` registers a handler for it. Ledger §2.8
  lists it as a KEEP floor.
- **Why it is not self-deferrable:** the two options point opposite ways.
  Either kernel diagnostics are wanted (then it needs live callers and the
  ledger is right) or they are not (then the declaration, the host-native
  define, and the ledger entry all go). Silently leaving a declared-but-absent
  import is the "documentation creating a promise the implementation does not
  support" failure.
- **Cost now:** ~15 lines either way, plus a ledger correction.
- **Cost later:** the census/ledger keep claiming a concept that does not
  exist.
- **Recommendation:** delete the declaration and the host-native define; if
  kernel diagnostics are wanted later, they should be reintroduced
  deliberately with callers. **Maintainer's call.**

### #4 — host-native needs `openat`; `std` does not have it

- **What:** K9's native side needs `openat`/`mkdirat`/`unlinkat`/`renameat`/
  `linkat`/`symlinkat`/`readlinkat`/`fchownat`. `std::fs` is path-based.
  Options: `rustix` (thin, no_std-capable, direct syscalls), `cap-std` (built
  on rustix; gives capability-oriented directory handles that *are* this
  design), or raw `libc` + `unsafe`.
- **Cost now:** one new dependency in a native-only crate. `cap-std` would
  arguably *reduce* K9's native line count, since its `Dir` type is exactly
  the mount-root-handle abstraction.
- **Cost later:** hand-rolled `unsafe libc::openat` in host-native, which is
  the sort of thing the Rust-first campaign exists to avoid.
- **Recommendation:** `cap-std`. Its sandbox semantics (a `Dir` handle cannot
  escape via `..` or an absolute symlink) *encode the K9 invariant in the type
  system*, which is a V2 win rather than a dependency cost. **Not my call.**

### #5 — Sequencing: K9 after K8

- **What:** §4 argues K9 should follow K8 rather than merge with it or run
  independently. The task brief left this open.
- **Cost now:** K9 waits on the campaign's second-largest item.
- **Cost later:** designing the host-directory contract against
  `MemoryFileSystem` behind `/dev/shm`, then re-doing it when K8 deletes that
  backend.
- **Recommendation:** K14 → K8 → K9. The two independent pieces (#2, #3) can
  land immediately after K14.

### #6 — Where do mount-root handles ride?

- **What:** §3.3 proposes extending `kernel_rootfs_set_foreign_prefixes`
  (`rootfs.rs:515`, `kernel-worker.ts:5111`) from a NUL-separated prefix list
  to `(prefix, root_handle)` pairs, versus adding a dedicated kernel export.
- **Why it is not free either way:** both are kernel exports, so neither
  touches V4's measured surface — but the payload format is ABI-adjacent, and
  changing an existing export's payload interpretation is exactly the class of
  "semantic change with the same signature" that
  `docs/abi-versioning.md:1061-1063` says the snapshot cannot catch.
- **Recommendation:** extend the existing export (one seam, not two) and
  record the payload change in the ABI 44 section explicitly, since the
  snapshot will not.

---

## 8. STRONG DOUBT register

1. **Any new host import.** K9's nine `*at` names must each retire a named
   predecessor in the same commit, and `EXPECTED_HOST_IMPORT_COUNT` must
   strictly fall (84 → 68). After K14 this is enforced by the ABI gate, not
   by review discipline. Wanting `host_fdopendir`, `host_openat2`,
   `host_mount_root_handle`, or any "resolve the remainder" call is the signal
   to stop and argue, not to add.

2. **Any `ABI_VERSION` bump.** K14 is an additive top-level section →
   `docs/abi-versioning.md:1091-1099`, no bump. K9 removes and reshapes
   imports, which is incompatible, but ABI 44 is unreleased and is *amended in
   place* (`:861-866`) — the same reasoning that carried K13a's 24 export
   removals. **But it must be recorded in the ABI 44 section the way those
   removals were** (`:877-890`); an unrecorded reshape is the failure mode
   that section exists to prevent.

3. **The "25 → 0" target itself.** Doubted and corrected in §6.1. Anyone
   reporting "0 name-taking imports" without the mandatory/optional
   distinction is reporting a number, not a contract.

4. **"The host must resolve names because OPFS/Node do."** Doubted and
   disproved: the host must resolve at most one *component*, and OPFS is
   natively component-shaped (`getFileHandle(name)`), which makes it a
   *better* fit for the new contract than for the current one.

---

## 9. VERIFIED vs INFERRED

**VERIFIED** (read in this worktree, or dumped from
`local-binaries/kernel.wasm`): every `file:line` citation; the 85 declared
extern imports and the 84 in the built artifact; `host_debug_log`'s absence
from the artifact; `host_access`'s zero call sites; every Rust call site in
§2.2's table; the `HostIO` trait signatures; the `host_readdir`
consume-once contract and the kernel's `EIO` enforcement of it; the
`tmpfs → rootfs → host` cascade in `fs_stat`/`fs_lstat`/`do_open`;
`rootfs::owns_path`'s foreign-prefix exclusion; the synthetic negative handle
bands in `tmpfs.rs`/`rootfs.rs`; both worker entries dropping `/` and
publishing `rootfsForeignPrefixes`; the browser and Node mount tables;
`OpfsFileSystem` having no production constructor; host-native's 21
implemented imports and the `!fs.mounts.is_empty()` gate;
`dump_abi.rs`'s existing import-section walk and its export renderer;
`classify_compat_change`'s section dispatch and `additive_top_level_section`;
`check-abi-version.sh`'s wasm32-only kernel build.

**INFERRED** (reasoned, not observed): that the `/dev` `DeviceFileSystem`
mount is fully shadowed by kernel devfs (12 gate sites are consistent with
it, but no runtime assertion was run); that removing an import is
instantiation-compatible for an existing host (follows from WebAssembly's
by-name import lookup, not measured here); the JSON line-count estimate for
K14's additive diff; every line-count estimate for work not yet written,
including host-native's 500-700; that `cap-std`/`rustix` covers every `*at`
K9 needs; that `PlatformIO.preparePath` is already dead in the guest path.

**NOT VERIFIED and deliberately not claimed:** nothing was built, no test
suite was run, and `local-binaries/kernel.wasm` predates this branch's head
(symlink target dated 2026-09-06). The import *names* it yields are stable
across that gap — K2 changed a signature, not a name — but the eventual K14
snapshot must be generated from a freshly built kernel, which is what
`check-abi-version.sh` does by construction.
