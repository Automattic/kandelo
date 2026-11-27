# KIFS v3

Kandelo uses KIFS v3 by default for checked, resizable development
shells. The checked source image supplies first boot. Subsequent boots
open the activated volume directly. Existing v2 systems can request the
legacy profile. Other resizable computers can request an explicit upgrade
that preserves their logical capacity.

## Mounted filesystem interface

The compiled-in legacy and standalone backends share a Rust mount
interface for lookup, descriptor I/O, namespace mutations, metadata,
capacity and synchronization. The VFS owns path resolution, credentials
and descriptor lifetime. Each backend owns allocation and persistence.
The worker negotiates stat certification and uses the ordinary syscall
when the backend has no certificate support.

Node and browser use the same generation selector. A saved computer opens
with the backend specified by its active generation. Changing formats
takes an exclusive computer lease and proceeds through staging, read-only
verification and activation. Dynamic module loading is a separate follow-up.

## Runtime design

The positioned writer and the saved-computer mount use the same v3
format. One authenticated tree holds the live inode records, directory entries and
file-block references. The tree addresses stable inode numbers. The VFS
pins just the inodes held by open descriptions and mappings and caches
other metadata within its existing memory admission budget. Normal boot
authenticates the root and verifies further pages as they are read.

A standard computer has a sparse 1 GiB logical volume. Live leaf records
and allocated data blocks share the budget. File identity comes from a
monotonic watermark rather than a fixed inode table. Deleting a file
releases its blocks and metadata after its last link, open description and
mapping are gone. Logical allocation, host quota, memory admission and
storage integrity are reported separately.

The filesystem uses the same positioned byte-storage contract on Node and
in OPFS. Inode identities, directory traversal, file reads and mutations
remain Rust responsibilities. Package images can be sealed read-only.
A writable copy must have exclusive publication ownership. Sharing immutable
image blocks between computers is a separate storage optimization.

## On-disk engine

The KIFS v3 volume starts with two 4 KiB-aligned superblock slots. Each slot
has a checksummed 168-byte record containing its sequence, committed end,
logical capacity, live allocation totals, inode watermark, root reference
and volume identity. The committed end is measured in 1 KiB units after
the 8 KiB superblock area. The remainder of the file holds authenticated
1 KiB slotted tree pages and 4 KiB file blocks. Tree references carry their
unit number and SHA-256 digest. Child references precede their parent
physically. Leaf keys sort in inode, directory-entry, file-block,
attribute, archive and orphan-marker order. The page size is fixed for the current
candidate.

Transactions copy the affected paths and append the new pages and file
blocks. A commit flushes the new content, then writes and flushes each
superblock replica in order. It writes an invalid or stale replica first
when recovering with only one current copy. A sync caller receives success
after both copies are flushed. The mounted filesystem can acknowledge a
visible mutation before the group is synced. Failure during root publication poisons
the writer until recovery. Recovery rejects an unsupported version,
conflicting root authorities and a damaged root at the latest valid
sequence. A torn replica can use its intact peer. Normal open does not
scan dead records or repair uncommitted bytes.

Logical allocation currently charges the two superblock slots, live
encoded leaf records rounded to 4 KiB, and live data blocks. Internal
pages and prior versions require physical host storage. Compaction
streams reachable records into another volume, where the owner can
verify it before publication. The bulk builder and writable engine
share the page codec and committed-root representation.

An insertion that displaces existing keys splits the overflowing index or
leaf page by occupied bytes. Appends can seal a full page. This keeps a
run of descending filenames from repeatedly splitting the same full page.
If an older v3 tree already needs a root split at the format's maximum
level, the mutation packs the top two index levels and retries fitting
the root at its current level. It copies existing child references, so
the lower subtrees and inode numbers keep their identities. The new pages
use the ordinary transaction publication protocol. A storage error before
root publication leaves the preceding tree authoritative. A root that
still cannot fit returns `EFBIG`. The repair adds work only to a mutation
that would otherwise exceed the depth limit.

## Legacy upgrade

The KIFS 1/2 image and KOVL v1 journal readers remain available to the
importer. Under the exclusive computer lease, the shared boot protocol
stages a KIFS v3 volume from the effective legacy filesystem. The
importer carries the original inode numbers and watermark, link
identities, ownership, permissions, timestamps, sparse extents, and
deferred-content and retained-program metadata. The staged result is
opened through the production reader with writes disabled and compared
with the source before activation. The application reports progress on
upgrade boots.

Before publication, a failed trial leaves the old generation authoritative.
Later attempts can reclaim unpublished staging under the lease. Uncertain
publication fails closed. An older runtime must refuse the new activated
volume. Standard computers upgrade to at least 1 GiB. An explicit policy
is required for custom and fixed images.

## Qualification

Two independent saved-shell runs exercised both filesystem orders on
Node, Chromium, Firefox and WebKit. KIFS v3 took less elapsed time in
all 80 comparisons. The packaged app installed, upgraded and reopened
the development shell on all three browsers. The qualification report
includes artifact hashes, memory use and the exact stretch-target misses.
[Mounted filesystem qualification](../measurements/2026-11-27-kifs-mounted-interface-qualification.md)

## Durability follow-up

After the functional v3 cutover, qualify the guarantees each supported
host can make under power loss. Document the ordering and flush contract
for Node, OPFS and future storage backends. Identify backends that can
offer only best-effort persistence.

Expand fault injection to include torn and reordered writes, a host losing
writes it reported as flushed, lost acknowledgments, quota exhaustion and
abrupt process or OS termination. Exercise ordinary writes, compaction and
upgrades through normal Kandelo boot. Keep normal boot reads bounded.
Define a read-only recovery path for damaged or ambiguous volumes, an
explicit way to restore an older verified state, and a verified backup
export and restore outside the origin.

Earlier planning put the expanded durability qualification at roughly
two to four engineer-weeks. Verified backup export and restore adds
roughly one to two engineer-weeks if included. These are planning
estimates. Automatic off-device backups are a separate project.
