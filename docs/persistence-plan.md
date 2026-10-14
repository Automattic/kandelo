# Persistent VFS image plan

The current fixed-overwrite and resizable-file overlays are opt-in prototypes, not general
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
ABI 51, following main's networking ABI 50, adds the third host storage handle
needed to compact an indexed journal while its checkpoint remains open.
Writes spanning more than 64 cache blocks are split into bounded chunks;
later writeback failure returns a short count rather than claiming the entire
write succeeded. A 2 MiB guest `pwrite` followed by `fsync` survives a Node
worker restart and Chromium, Firefox, and WebKit page reloads.
The positioned-install browser test also runs a guest overwrite and a 2 MiB
write near the end of a large file, then reopens the saved image after a page
reload and verifies both writes through guest reads. Its 68 MiB and 772 MiB
decoded-image cases pass on Chromium, Firefox, and WebKit; the 772 MiB case
uses the constrained 768 MiB kernel memory ceiling. This establishes a narrow
writable >RAM workflow, not general persistent POSIX support.
For a first install from a direct VFS URL, the page now stages bounded
chunks into a temporary OPFS file and the image writer reads that file through
positioned calls. Zstd sources are decoded block-by-block with at most a
16 MiB decompression window and staged as decoded bytes. A 68 MiB raw image
can be composed with a 64 MiB VFS profile budget without returning source or
composed image bytes to the page. The 772 MiB constrained-memory test boots,
writes, and reopens the image on Chromium, Firefox, and WebKit, with no
image-sized page or kernel-worker allocation. The
temporary source is removed after composition. The next install reclaims
orphaned source files while preserving active sources held by another tab's
Web Lock. Pages products now authenticate compressed source bytes incrementally
against the grouped product digest before staging and composing them. Protected
candidate boots explicitly reject experimental persistence. Ordinary
nonpersistent boots still use resident image bytes. The browser writer's
positioned import is isolated in a separate Wasm artifact; the default writer
remains import-free. On Node and browser boots, a journal with at least 32 MiB
of unsealed tail is compacted into the alternate slot before processes start.
The old generation stays intact until the new journal is flushed,
checkpointed, sealed, and verified. The first recovery of an unindexed journal
still scans it and holds its changed-block map in memory. An indexed boot scans
the authenticated prefix and checkpoint with bounded I/O buffers, then holds
only the appended tail's map. After boot, a worker timer checks every two
seconds and can compact an indexed generation again while processes are
running. A third storage import keeps the source journal, source checkpoint,
and target journal open simultaneously. The copy, checkpoint, seal,
verification, and activation occur synchronously on one kernel-worker turn,
so guest syscalls cannot interleave with handoff. Compaction failures are
reported and retried after 30 seconds. Fixed-overwrite writes fail with
`ENOSPC` once the active journal tail reaches 63 MiB; a reserved margin lets
already accepted dirty blocks flush. This bounds the active tail even if
compaction repeatedly fails. Resizable namespace and metadata transactions
obey the same write-stop limit; previously accepted dirty blocks can still
flush. Fixed-overwrite compaction now copies records
without retaining the target block map, then scans the compacted journal with
bounded buffers to write its sorted checkpoint sidecar.
Resizable mounts now journal regular-file, symlink, and directory namespace
mutations. Explicit chmod, chown, and utimensat updates also use inode records;
fsync and compaction flush timestamps for writes and truncates. Persistent
regular files reject attempts to set set-ID bits on unauthenticated bytes.

Boot now checks two optional sealed journal slots (`g0` and `g1`) on Node and
browser hosts, preferring the highest verified generation. A seal authenticates
the compacted prefix while the active journal may append later transactions;
the kernel still validates and replays those transactions. If a slot is torn or
its journal or indexed checkpoint is rejected with `EIO`, boot tries the
previous valid slot and then the legacy journal. Other kernel refusals and
errors thrown directly by the host propagate rather than triggering fallback.
If generation files exist without any valid journal, boot
refuses to create an empty replacement. Compaction prepares a
compacted journal without switching the kernel's active handle, writes and
verifies the target seal, and only then activates it. Failure cancels the
prepared target and invalidates its seal. The kernel refuses activation if
the source changed during preparation. Synchronous storage and hash operations
run on the dedicated kernel worker during live handoff; guest syscalls wait
until that turn finishes. The pause has not yet been measured for large
changed-block sets.
OPFS quota exhaustion while opening the journal directory, generation file,
or sync access handle retains `ENOSPC`; only a missing file at the file-lookup
step counts as an absent generation. A file that disappears while its access
handle is acquired is an operational failure, not a missing generation.

Recovery truncates a torn append shorter than the minimum complete transaction,
including a partially written transaction header. The writeback test exercises
every byte offset of a torn 4 KiB block transaction; Node and browser tests
reopen journals torn before and after the header and near the commit marker.
Injected OPFS `QuotaExceededError` failures before the first transaction write,
after its first 128 bytes, and at its flush now exercise both fixed and
resizable guest paths on all three browser engines: `pwrite` remains readable
from the dirty cache and `fsync` reports `ENOSPC`. Reload after a failed write
recovers the previous durable bytes; after a failed flush, either the complete
old or complete new transaction may survive, and boot must accept both.
Quota failure during dirty-cache eviction returns a short guest write, leaves
accepted dirty blocks readable, and keeps `ENOSPC` available to a later
`fdatasync` rather than replacing it with `EIO`. Rust unit coverage and guest
runs on Chromium, Firefox, and WebKit exercise that boundary in both
fixed and resizable modes, including recovery of the previous durable bytes.
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

A fixed-block checkpoint table now writes sorted block locations without
materializing an index copy, binds their checksum to the base and exact
journal prefix, verifies all records on open, and uses one cached page for
binary-search lookups. The kernel builds it after boot-time compaction by
flushing and verifying each indexed block. A v2 generation seal binds the
sidecar by length and bounded chunk digests; Node and browser selection reject
a byte-damaged candidate, while the kernel rejects a syntactically sealed but
semantically invalid checkpoint. Indexed open verifies the journal prefix,
replays only later transactions, reads older blocks through the table's
bounded page cache, and merges the table with later mutations during
compaction. Focused tests reject damaged prefix and committed-tail bytes while
truncating an incomplete tail. This still scans the entire prefix to verify
its digest. Live compaction and a write-stop limit bound the active tail;
fixed-overwrite compaction's target map is no longer resident. The old
unindexed journal still needs its initial full-map recovery before conversion.
Small legacy and v1 journals continue to use the full-memory map until they
cross the boot-time compaction threshold; no conversion silently resets them.

The live handoff now uses that third handle and a dedicated kernel-worker turn.
The fixed-overwrite checkpoint is streamed, but its worst-case memory and
handoff pause duration have not been validated for an actually large writable
image. General POSIX mutation replay also needs a checkpoint design for
metadata, not just file blocks.
Indexed boot validates block references against a temporary sorted table of
eligible image-file sizes, rather than walking every rootfs inode for each
checkpoint block. The table uses memory proportional to eligible files, not
changed blocks; large-index boot time and peak memory remain unmeasured.
Node and all three browser engines now write 32 MiB across 8,192 distinct
file blocks, wait for a live indexed compaction, and verify every block
through guest reads after reopening. This exercises a larger checkpoint than
the repeated-overwrite tests, but does not establish a worst-case memory or
handoff-pause bound for a near-capacity writable image.
An opt-in journal open path can now replay inode, size, and dirent records
from an authenticated indexed prefix using a transaction-sized buffer while
leaving its file-block map in the checkpoint. It checks the prefix sequence
against the checkpoint before applying the tail. Streamed compaction can
carry these metadata records through two indexed generations without retaining
the target's block map. A version 2 checkpoint represents deleted blocks with
a zero-offset, zero-digest tombstone. Version 1 checkpoints remain readable;
new checkpoints without tombstones still use version 1. Metadata compaction
can carry tombstones through two indexed generations, while fixed-overwrite
mounts continue to reject them. Fixed-overwrite mounts still use block-only
replay; resizable mounts now use the metadata path for persistent namespace
mutations.
Fixed-overwrite indexed open parses the authenticated prefix with a
transaction-sized buffer and rejects metadata hidden behind a block-only
checkpoint. This adds a second sequential prefix pass after digest
verification, so indexed boot latency needs measurement.
The generic journal also has a file zero-fence record (key kind 5, an
inclusive starting block). A shrink atomically records the new size and
fence, preserving the boundary block's prefix and zeroing its suffix. Later
growth never exposes base bytes or older overlay blocks beyond that fence;
later writes can replace individual zeroed blocks. Indexed replay invalidates
only pre-fence checkpoint blocks, and compaction omits them while retaining
newer replacements. The retained base fence is the minimum cutoff across
shrinks, so repeated shrink/grow cycles cannot resurrect old base data.
Tests exercise an 8 GiB logical base without allocating it and two indexed
metadata compactions. An opt-in resizable mount now connects this
to rootfs `write`, `ftruncate`, `read`, and file-size reporting for existing,
eligible image-backed regular files. Fixed-overwrite mounts reject the
metadata record.
The generic journal can also buffer growing and sparse writes with the same
64-block dirty limit. It tracks at most 64 pending file sizes; eviction
commits a file's size with any of its evicted blocks, so a crash cannot leave
a committed block hidden past EOF to reappear on later growth. `sync` flushes
remaining blocks and sizes together. Node and browser hosts can now select
the growing-file mount.

The resizable mount replays file sizes on boot and uses metadata
compaction/checkpointing without copying image-sized file contents. A Rust
rootfs test writes above 8 GiB, reopens it, shrinks, regrows, compacts, and
reopens the indexed generation. It rejects namespace records and references
to unknown inodes. Node's `experimentalResizablePersistencePath` and the
browser's `experimentalResizablePersistenceName` expose this mode for
image-backed regular files. A guest grows `/state` sparsely past 8 GiB,
reopens it, shrinks and regrows it, then reopens it again and checks that old
bytes are zero; this passes in Node and Chromium, Firefox, and WebKit without
allocating the 8 GiB file. Fixed-mode mounts reject the resizable journal.
`O_TRUNC` uses the same journaled zero-fence path as `ftruncate(0)` for
eligible files; fixed-overwrite mounts continue to reject it. Resizable
mounts commit a rename's source removal and destination replacement in one
journal transaction, and commit a link or unlink before changing the live
tree. Boot validates and replays the final directory entries and recomputes
link counts; an open-unlinked file remains readable until its last handle
closes. These mutations currently apply only to non-directory image entries.
New regular files now use a journal-backed inode kind, not a `Vec<u8>` body.
Creation commits a versioned inode record and directory entry atomically;
boot validates both before replay. A Rust test creates a sparse file beyond
8 GiB, reopens it, truncates it, compacts it, and reopens the indexed
generation without allocating the file's logical length. Created files cannot
retain set-ID mode bits on their unverified bytes. A failed journal write
does not publish the new inode or name; every byte offset of a torn
inode-plus-dirent transaction replays both records or neither. Created
directories and symlinks also use versioned inode records. Recovery validates
the final directory graph, rejecting cycles, multiple parents, and non-empty
orphan directories before publishing it. Graph validation now borrows base
directory entries and overlay names instead of cloning every base directory
entry into a second tree; a wide-directory Rust regression covers replacements,
deletions, and new links. This reduces temporary boot allocations but does not
bound the resident inode and journal metadata maps. Data-only or
base-metadata-only restarts skip namespace graph validation and link-count
reconstruction entirely; inode creation or any dirent record still takes the
validated replay path. Guest restart tests create, move, and remove a nested
directory tree and symlink. Explicit chmod/chown/utimensat changes to base and
created inodes survive restart and indexed compaction;
the first such update to a base inode uses a versioned metadata-only record.
Write and truncate timestamps are staged in memory and committed in batches
on fsync, graceful shutdown, or compaction. Sync now visits only inodes with
unsynced persistent content, rather than scanning every resident rootfs inode.
The dirty-inode set is cleared by a successful timestamp or namespace metadata
commit and retained after failed writeback; its cost still needs measurement
on a large file-count image. Session-injected files such as the browser CA
bundle are not journal-backed and are deliberately excluded from timestamp writeback;
they are recreated at boot. Namespace transactions now include parent
directory mtime/ctime and affected inode ctime records. Restart tests cover
create, link, rename, unlink, symlink, mkdir, and rmdir; a guest checks
directory mtimes after reopening on Node and all three browser engines. Image
snapshot export rejects mounted persistence rather than silently exporting
stale base bytes; exporting a consistent composed snapshot remains open.

Resizable compaction now omits inode, size, block, and child-dirent records
for closed, unlinked inodes. An open-unlinked file retains its records through
compaction until the handle closes; deletion tombstones on live parents remain
so base-image names cannot reappear. Recovery also releases replayed inodes
that have no names or open handles before a later compaction chooses what to
retain. Node and all three browser engines run a 32 MiB distinct-block guest
write with an additional closed orphan block, then verify that the checkpoint
contains only the 8,192 live blocks and the orphan stays absent after restart.
The live-inode filter uses a temporary
sorted vector proportional to resident inodes, so large-file-count memory and
handoff pause still need measurement. General POSIX replay still needs broader
conformance of metadata, open-unlinked lifetime, and namespace edge cases.
Compaction also drops deleted names that never existed in the immutable base,
while retaining base-name tombstones so deleted image files cannot reappear.
The mount tracks only touched base names and reconstructs that set from the
unchanged base tree on restart; repeated create/delete cycles no longer grow
the compacted journal with transient-name tombstones. This does not yet bound
the in-memory metadata map between compactions or replace it with an on-disk
metadata checkpoint.
Journal transactions must continue publishing related directory
entries, inode metadata, file size, and blocks together; recovery must rebuild
the same link counts and zero-filled truncate/extend behavior as the live
kernel.
