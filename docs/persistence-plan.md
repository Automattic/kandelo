# Persistent VFS image plan

The current fixed-overwrite overlay is an opt-in prototype, not general
persistent rootfs support. Keep the immutable base image and its append-only
journal separate: a failed update must never rewrite the only bootable base.
The browser owns OPFS byte transport; the Rust kernel owns filesystem
semantics. Node and browser must expose the same guest-visible behavior.

## Milestones

- [x] Bind a checksummed journal to an exact base-image digest and recover
  complete transactions after a crash.
- [x] Boot an opt-in browser computer from its saved image and journal, with
  a guest write surviving reload.
- [x] Define and test the durability contract. A successful write is visible
  immediately; `fsync`/`fdatasync` must make preceding writes durable or
  report failure. Document what a crash may lose without a successful sync,
  and how writeback errors are surfaced. Keep the disk capacity, resident
  cache budget, and OPFS quota as distinct limits.
- [x] Install a decoded, composed image into OPFS incrementally. Verify its
  identity and digest before publishing a generation. An interrupted install
  must leave the previous bootable generation untouched. Do not allocate an
  image-sized JavaScript or Wasm buffer while installing.
- [x] Boot through positioned reads of that OPFS image, with a bounded clean
  block cache. The page, composer, browser host protocol, and kernel worker
  must not materialize the whole image. Demonstrate a read-only image larger
  than the configured runtime-memory budget on Chromium, Firefox, and WebKit.
- [ ] Add bounded dirty blocks with read-your-writes, eviction, `fsync`, and
  shutdown behavior. A failed journal write or flush must not silently discard
  dirty data or acknowledge durability. Test recovery at each failure point
  on Node and browser.
- [ ] Bound journal recovery and index memory with checkpoint/compaction and
  a crash-safe generation handoff. A corrupt or incomplete new generation
  must fall back to the prior valid one, never silently reset the computer.
- [ ] Replay regular-file size, inode, and namespace changes with POSIX
  semantics, including create, truncate, unlink, and rename. Preserve
  existing protections for deferred, digest-declared, and set-ID content.
- [ ] Validate complete guest workflows and performance. Exercise >RAM
  images, quota exhaustion, tab contention, browser termination, corruption,
  and recovery; run applicable POSIX/conformance and Node/browser benchmark
  suites before claiming general support or a speedup.

The first >RAM acceptance target is deliberately read-only. It proves that
boot and image reads no longer require an image-sized allocation before
writeback or namespace mutations complicate the result. A large declared
capacity alone does not satisfy this target: the actual decoded image must
exceed the chosen runtime-memory budget.

## Current boundaries

The browser prototype now streams composed output into OPFS with one
acknowledged chunk in flight, verifies the stored bytes, and publishes only
from the boot that still owns the session, under one exclusive lock. The next
installation reclaims abandoned generation files. Reopening uses positioned OPFS
reads and a bounded clean cache; fixed overwrites use a bounded dirty cache.
Writes spanning more than 64 cache blocks are split into bounded chunks;
later writeback failure returns a short count rather than claiming the entire
write succeeded. A 2 MiB guest `pwrite` followed by `fsync` survives a Node
worker restart and Chromium, Firefox, and WebKit page reloads.
For a first install from a direct VFS URL, the page now stages bounded
chunks into a temporary OPFS file and the image writer reads that file through
positioned calls. Zstd sources are decoded block-by-block with at most a
16 MiB decompression window and staged as decoded bytes. A 68 MiB raw image
can be composed with a 64 MiB VFS profile budget without returning source or
composed image bytes to the page. A separate read-only test boots a 772 MiB
decoded image under the constrained 768 MiB kernel memory ceiling on Chromium,
Firefox, and WebKit, with no image-sized page or kernel-worker allocation. The
temporary source is removed after composition. The next install reclaims
orphaned source files while preserving active sources held by another tab's
Web Lock. Pages products now authenticate compressed source bytes incrementally
against the grouped product digest before staging and composing them. Protected
candidate boots explicitly reject experimental persistence. Ordinary
nonpersistent boots still use resident image bytes. The browser writer's
positioned import is isolated in a separate Wasm artifact; the default writer
remains import-free. Journal block locations and recovery work still grow with
the number of distinct changed blocks. On Node and browser boots, a journal
with at least 32 MiB of unsealed tail is compacted into the alternate slot
before processes start. The old generation stays intact until the new journal
is flushed, sealed, and verified. This resets accumulated transaction history
for later boots, but the first recovery still scans that history; every boot
also scans the entire sealed prefix and holds an in-memory index for every
changed block. Live compaction and persistent
namespace mutations remain separate milestones, not implicit guarantees of
the current fixed-overwrite mode.

Boot now checks two optional sealed journal slots (`g0` and `g1`) on Node and
browser hosts, preferring the highest verified generation. A seal authenticates
the compacted prefix while the active journal may append later transactions;
the kernel still validates and replays those transactions. If a slot is torn or
its journal is rejected, boot tries the previous valid slot and then the
legacy journal. If generation files exist without any valid journal, boot
refuses to create an empty replacement. Boot-time handoff writes these slots;
live compaction does not.

Recovery truncates a torn append shorter than the minimum complete transaction,
including a partially written transaction header. The writeback test exercises
every byte offset of a torn 4 KiB block transaction; Node and browser tests
reopen journals torn before and after the header and near the commit marker.
This does not yet cover every host write and flush failure point, so the
dirty-cache milestone remains open.

## Next format boundary

The current in-memory map of every changed block cannot be the production
index. A checkpoint should instead be an immutable, sorted, checksummed table
stored next to each journal generation. Its fixed-size pages can be searched
with positioned reads and a bounded page cache; the in-memory map then holds
only mutations appended since that checkpoint. The seal must bind the exact
base image, table, journal prefix, and replay sequence. Boot may verify and
open a sealed table without rebuilding its entire map, then replay only the
bounded unsealed tail. A corrupt table or mismatched seal must reject that
generation and try the prior valid one. Existing v1 journals need an explicit
conversion path; no format change may silently reset a machine.

A Rust-only fixed-block checkpoint table now implements the first part of
this format. It writes sorted block locations without materializing an index
copy, binds their checksum to the base and exact journal prefix, verifies all
records on open, and uses one cached page for binary-search lookups. The
journal can build it only after flushing and verifying every indexed block.
No host generation uses this table yet; boot still rebuilds the old in-memory
map and the milestone remains open. A backward-compatible v2 generation seal
can additionally bind an index sidecar by length and bounded chunk digests;
Node and browser selection reject a byte-damaged indexed candidate and fall
back to an older valid slot. Current compaction still publishes v1 seals, and
the host does not yet pass a selected index to the kernel, so this v2 path is
not yet the normal boot format or a semantic index-validation guarantee. A
Rust-only indexed open now verifies the journal prefix, replays only later
transactions, reads older blocks through the table's bounded page cache, and
merges the table with later mutations during compaction. Focused tests reject
damaged prefix and committed-tail bytes while truncating an incomplete tail.
This still scans the entire prefix to verify its digest and does not bound an
active journal's tail without live compaction.

Live compaction needs a two-phase handoff, unlike the current boot-only
handoff. While guest operations are stopped at a kernel-worker boundary, copy
live records into the inactive slot, flush its journal and table, publish and
verify its seal, and only then switch the kernel's active storage handle. If
any stage fails before publication, keep serving the old generation. The old
slot must remain available after publication for fallback. The tail budget
must trigger this handoff before its in-memory map can grow without bound;
compaction cannot be deferred indefinitely to the next boot.

General POSIX replay then needs an overlay-backed regular-file inode kind,
not `Regular(Vec<u8>)`, so newly created and grown files also remain larger
than runtime memory. Journal transactions must publish directory entries,
inode metadata, file size, and blocks together; recovery must rebuild the
same link counts, open-unlinked lifetime, and zero-filled truncate/extend
behavior as the live kernel.
