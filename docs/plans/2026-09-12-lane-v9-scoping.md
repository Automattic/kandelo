# Lane V9 — scoping read: how `memory-fs.ts` uses `SharedFS`

**Date: 2026-09-12. Status: complete. Read-only; no code changed.**

The V6 census closed with this listed as what it did **not** establish:
"How `memory-fs.ts` uses `SharedFS`, only that it is the sole importer.
V9 needs that reading and it is the lane's real unknown." This is that
reading.

## The shape: a wrapper, not a subclass

`MemoryFileSystem` holds `private fs: SharedFS` and delegates to it. So
V9 is a **backend swap**, not a rewrite of `memory-fs.ts`.

That matters for a expectation the plan has carried loosely:
**V9 does not delete `memory-fs.ts`.** 8,501 lines contain only ~39
`SharedFS` references; the rest is lazy-file bookkeeping, image
metadata, rootfs overlay handling and serialization — logic of its own.
Deleting `memory-fs.ts` is a separate, larger question that lane Y
unblocks. V9 deletes **`sharedfs-vendor.ts`** (3,716 lines).

## The contract: 35 methods, in two very different halves

**~30 standard filesystem operations** — `open`, `close`, `read`,
`write`, `readAt`, `writeAt`, `lseek`, `append`, `ftruncate`, `stat`,
`lstat`, `fstat`, `statfs`, `mkdir`, `rmdir`, `unlink`, `rename`,
`link`, `symlink`, `readlink`, `opendir`, `closedir`, `readdirEntry`,
`chmod`, `fchmod`, `chown`, `fchown`, `lchown`, `utimens`, `buffer`.

The Y1 census already mapped most of these onto `sffs.rs` /
`sffs_write.rs`. This half is ordinary.

**5 identity operations, carrying 21 of the calls** — and this is the
lane's real content:

| Method | Calls |
|---|---|
| `identityState` | 13 |
| `createLazyStub` | 3 |
| `snapshotState` | 2 |
| `replaceManyIfIdentities` | 2 |
| `replaceIfIdentity` | 1 |

## What the identity protocol is, and why it cannot be dropped

`SharedFsIdentityState` is `{ ino, generation, dataSequence, mode,
linkCount, size, uid, gid, symlinkTarget?, paths[] }`, captured under a
namespace lock. `replaceIfIdentity` is a **compare-and-swap**: install
these bytes only if the file still has that exact identity.

The race it guards is explicit in the code:

```js
const data = await this.fetchLazyBytes({ ... });   // async network fetch
for (let attempt = 0; attempt < 3; attempt++) {
  const materialized = this.fs.replaceIfIdentity(
    candidate, entry.ino, entry.generation, entry.dataSequence, data);
  ...
}
// "A peer may have renamed the inode while the fetch was in flight."
```

**Fetching a lazy file's bytes takes network time, and a guest process
can rename, modify or delete that file during the window.** The CAS
ensures fetched bytes are only committed to the file they were fetched
for.

**Moving the filesystem to Rust does not remove this race.** Lane V's own
floor statement keeps byte-fetching in the host, because the network
lives there — CORS, a service worker, or no network at all are host
facts. So the in-flight window survives the migration, and the protocol
must survive with it.

## What Rust has and does not

| | Rust |
|---|---|
| `generation` | **yes** — 3 in `sffs.rs`, 19 in `sffs_write.rs` |
| `data_sequence` | **yes** — 7 in `sffs_write.rs` |
| identity capture (`identityState`) | no |
| compare-and-swap (`replace_if_identity`) | no |
| lazy stub creation | partial — `create_deferred_file` exists |

**The identity *fields* already exist in the Rust format; the
*operations* over them do not.** That is a good position: the data model
does not have to change, only the API.

## Estimate

**V9: 5–9 agent-days**, medium confidence.

- ~30 standard operations, mostly already present: 1–2 d of wiring.
- 5 identity operations in Rust, with CAS semantics against the existing
  `generation`/`data_sequence` fields: **3–5 d, and this is the lane's
  risk**, because it is a concurrency protocol rather than data movement.
- 6 call sites in `memory-fs.ts` to repoint: under a day.
- V10, deleting `sharedfs-vendor.ts`: hours once nothing imports it.

Lane V's remaining total lands around **6–10 d** with V7/V8 already done,
against the 8–16 d the V6 census estimated for the whole lane.

## What this read did NOT establish

- **Whether the CAS needs to be kernel-side or can stay host-side.** If
  the kernel owns the filesystem and the host owns the fetch, the compare
  step has to cross that boundary. Which side holds the lock, and what
  the call looks like, is a design question this read did not answer.
- **Whether the 3-attempt retry loop is load-bearing** or belt-and-braces.
  It retries across `entry.paths` on rename; nobody has established
  whether attempt 2 or 3 ever fires in practice.
- **What `snapshotState` needs from a Rust backend.** It is used for
  export and image serialization, which overlaps lane Y's territory, and
  the two lanes should agree before either builds it.
- **Anything about the other ~8,460 lines of `memory-fs.ts`.** This read
  followed `SharedFS` only.
