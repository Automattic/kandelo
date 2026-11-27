# Persistent image durability contract

This describes the current source candidate, not a production release claim.
The [acceptance map](#release-acceptance-map) identifies the relevant test coverage
and its limits.
Existing frozen demos can contain earlier implementations. Do not keep
irreplaceable data only in these experimental computers.

## Ownership and formats

Rust owns the filesystem namespace, POSIX mutations, logical capacity,
journal transactions, checkpoint indexes, checked-image construction and
read-time block verification. Host adapters supply positioned byte I/O,
flush, exclusive handles, worker lifecycle and publication of related files.
Rust also encodes, checks and selects replicated activation-control records
and validates their generation transitions. Both hosts invoke that policy
through a bounded kernel scratch lease; the host publishes and repairs the
resulting bytes. The source seal codec now owns generation-seal header
encoding/validation and streaming SHA-256 in Rust too. The host walks the
seal's checksum slots, supplies bounded byte windows and coordinates storage
publication. Journal/index headers, seal geometry and length/tail admission
share Rust parsers and policy. Prepared/active immutable-image binding
validation and selection are native too, using bounded observed evidence
without reading the immutable payload. The source candidate also moves
generation ordering and ambiguity, activated-candidate matching, predecessor
relationships, target eligibility, reuse and retirement decisions into Rust.
Control requests use fixed 88–328-byte packets with scalar responses; they
do not introduce an inventory-sized native allocation. A known generation
zero is not interpreted as an old verified generation. Reclaiming such an
unpublished slot requires matching current activation authority and exclusion
of the active and verified predecessor slots. An uncertain control close
retains its owner and blocks later generation operations before storage opens.

The host still enumerates files, acquires and closes exclusive handles,
supplies bounded observed evidence, schedules byte-window reads and writes,
and sequences publication under its native locks. Mechanical placement among
the reusable/ring/unused filenames remains host storage-layout policy, but
Rust must admit the proposed target before it is opened for mutation. The
host cannot replace the active or named predecessor slot merely because it
is next in the ring. Maintenance scheduling and explicit tail-size/cache
overrides remain host requests, not recovery authority; Rust still enforces
memory admission and handoff invariants. These changes require native control capability 2;
stale capability-1 adapters are refused rather than used as recovery evidence.
These control-policy changes do not migrate the saved image format: its
envelope remains version 6. The combined branch uses unreleased ABI 55 after
integrating ABI 54 main; required storage imports and bounded argument
admission are described in [the ABI contract](abi-versioning.md#abi-55-persistent-image-storage-and-bounded-admission).
Final ABI-matched release acceptance remains open.

Host proxies close ordinary request admission when shutdown starts. Their
own shutdown request remains admissible so the native worker can drain
storage. After worker-realm termination is attempted, remaining filesystem
and HTTP requests reject rather than being silently removed from the pending
map. A retired HTTP bridge refuses new requests before forwarding them to
its former kernel. These are host lifecycle rules, not portable filesystem
policy or a new guest ABI.

Request cancellation does not prove rollback: an operation can have executed
before its transport reply is lost. Callers must not automatically replay
writes merely because shutdown rejected their response promise. Native sync
acknowledgements, shutdown diagnostics and retained ownership still determine
the persistence outcome. Focused Node/browser-proxy regressions and a real
Node journal shutdown/reopen case pass. The real-OPFS shutdown/reopen regression
and native exec-refusal/retry case pass in Chromium, Firefox and WebKit (six
cases, no retries or skips). These scoped results do not establish acceptance
of the constrained WordPress application workloads.

The source candidate stages initial raw imports in a disposable I/O worker.
The host supplies bounded byte windows and OPFS writes; SHA-256 executes in
the existing Rust streaming digest implementation. Composition checks that
expected digest with the same native image module before parsing the staged
image. This removes JavaScript decoded-image hashing from this import path,
not the two passes themselves. Some compressed streams have no decoded length
upfront, while the checked-image writer requires that length; staging therefore
keeps the raw import format rather than inventing another saved-image format.
The final checked base still uses the selected CRC32C or SHA-256 policy.

Authenticated asset-download hashes are a separate contract and remain checked
before source EOF can complete. The importer snapshots at most 64 KiB of a
captured producer span before hashing or callbacks; hashing and staging consume
the same owned bytes. A later mutation of an unconsumed producer span must
either leave the original imported bytes intact or fail the pinned identity.
Caller-owned response backings and the bounded decompressor window remain
separate from the transferred 64 KiB windows and fixed native digest state.
No image-sized decoded page buffer or checksum array is introduced.

Source staging success requires consumed input EOF and confirmed handle close.
The composer also retires its source-handle ledger before reporting completion
or a verified cleanup failure. Missing or uncertain close proof retains the
temporary source and its ownership lock; further source staging in that page
is quarantined until page close. A confirmed-closed source can still be removed
while a different source is quarantined. Source corruption/resource errors do
not authorize publication or deletion of an uncertain owner. These are initial
import ownership rules, not changes to live guest sync acknowledgements or a
measured performance claim; frozen checkpoint 1.30 still has the earlier path.
Checkpoint 1.31 contains this importer. Its setup rechecks quarantine after
parent lookup, file creation and module loading, before creating another
directory or dispatching a writer. A refusal before dispatch removes that
healthy file without retiring another source's uncertain ownership.

The source saved-computer envelope is version 6. Its immutable base is a
Rust checked image containing an ordinary VFS image. The manifest records
the checking policy, expected header identity, physical and logical lengths,
journal identity and generation. Ordinary product VFS imports remain valid
installation inputs. Earlier saved-computer envelopes are not migration
inputs and must not be silently converted, reset or recomposed from a URL.
Native journal/index formats have their own admission rules; an envelope
version is not a guest ABI version. The current guest ABI is 55.

New computers default to CRC32C. SHA-256 content binding is opt-in at
creation. Reopen preserves the recorded policy. CRC32C checks
accidental damage, not malicious substitutions. SHA-256 binds blocks to an
expected identity; storing that identity in the same origin does not create
an external trust anchor or prevent coordinated rollback of all local files.

## Acknowledgements and sync

| Operation | Meaning and boundary |
|---|---|
| Successful guest write | The returned prefix is visible through the live filesystem. Dirty data can remain in the bounded Rust cache; write success alone is not a sync acknowledgement. |
| Short guest write | Only the returned prefix was accepted. The caller must handle partial progress; memory, logical capacity and host quota are distinct failure sources. |
| Rootfs `fsync` | Rust synchronizes the persistent rootfs mount, including pending inode/timestamp state and dirty journal data, and invokes the underlying flush operation. This can synchronize more than the selected file. |
| Rootfs `fdatasync` | Currently uses the same implementation as `fsync`, including its error propagation. |
| Rootfs directory `fsync` | Uses the mount sync path, not an independent OPFS directory-flush primitive. |
| Cache eviction | Accepted dirty state is not discarded to make room. Required journal commit/flush or resource failure must be resolved before replacement. |
| Graceful destruction | Attempts persistent sync and closes storage after closing creator admission and draining owners. A resolved destruction request alone is not proof that every shutdown obligation succeeded. |
| Browser flush | Uses `FileSystemSyncAccessHandle.flush()`. This is the browser's acknowledgement, not a proven OS/device power-loss guarantee. |
| Node flush | Uses the file backend's `fsyncSync`. Kandelo's tests do not establish the guarantees of every host filesystem, storage device or power-loss scenario. |

Applications still need their own transaction protocol and write ordering.
A filesystem sync does not make an arbitrary multi-file application update
atomic. An unsynced write might survive an interruption, but survival is not
promised. Closing a browser tab is not a substitute for successful sync.

Callers must inspect `getPersistenceShutdownFailure()` before treating a
shutdown as successful. Browser coordinators must also require
`hasUnconfirmedKernelQuiescence()` to be false before reusing or retiring
storage. An uncertain close retains ownership; a timeout is not permission
to retry a possibly consumed handle or delete its files. Realm termination
can release handles but cannot retroactively acknowledge unsynced data.

HTTP transport shares the kernel's ordinary I/O allowance with filesystem
owners. Admission bounds active host pumps, but a request's deadline alone
does not release its native socket ownership. The source candidate captures
the injected connection identity before yielding. Error retirement resets
only that identity, removes an unaccepted backlog entry and releases its
server references, then closes the host endpoints in one serialized native
entry. If guest `accept` already won, the guest retains its endpoints until
ordinary close. Deferred retirement retains the request until native cleanup
actually executes; kernel-fatal revocation rejects outstanding requests rather
than reporting successful cleanup. This is not a reserved acceptance budget
for arbitrary guest sockets or a promise that I/O admission never returns
`ENOMEM`.

Browser replacement boots serialize behind their predecessor's cleanup. An
uncertain persistent HTTP route barrier quarantines the computer and retains
its actual runtime lease, even if that boot has already been superseded. A
later reboot must not bypass that sticky failure. Closing or
reloading the owning page releases native realm ownership; it does not turn
the failed operation into an acknowledged durable write.

## Compaction and recovery

Normal operation uses the mounted OPFS base and writable journal. Guest
writes, cache eviction and explicit sync use the live filesystem without
exporting or replacing the base. There is no manual checkpoint action.
The browser acceptance workflow saves a WordPress/MariaDB post and upload,
then restarts and verifies them through ordinary journal recovery. This
does not change the distinction between a successful write and a successful
sync above. Named filesystem checkpoints and restore remain
[future work](future-improvements.md#filesystem-checkpoints-and-restore).

Image exports are separate artifacts, not automatically active saved
computers. Installing a replacement must retain ownership, verify its
bytes and preserve the last bootable generation through publication.

Automatic journal compaction creates a separate journal/index/seal target.
New writes and metadata mutations wait for immediate host compaction when the
active tail reaches its admission bound. This maintenance pressure is not
reported as `ENOSPC`; logical filesystem capacity and actual host quota still
produce `ENOSPC`. When the underlying storage refuses a write, flush or truncate for lack of space, the host emits a `storage-capacity` diagnostic once per boot. Logical capacity refusals occur in the kernel. Waiting does not acknowledge data or alter the existing
checkpoint/activation publication order. Already accepted dirty data can
still flush while new mutations wait.
Activation controls identify the acknowledged writable generation. A valid
older archive is not necessarily a fresh recovery copy. Damage to the latest
activated generation must not silently select stale acknowledged state;
missing proof produces an explicit recovery failure. Abandoned files are
reclaimed only under their ownership locks, after uncertain closes have been
resolved. A failure acknowledgement does not prove no bytes reached storage;
recovery must handle operations whose completion reply was lost.

Recomputing a damaged index's checksums and seal does not establish fresh
recovery authority. The separate activation controls still identify the
acknowledged generation. A mismatch must fail closed without rewriting that
authority or treating an older generation as the latest durable state.

Normal saved-computer reopen admits the bounded checked header and verifies
metadata/data pages when used. It does not require decompressing, rewriting
or hashing the entire immutable payload. Corruption of an untouched block
can therefore remain undiscovered until that block is read. Demand checking
is not a complete-image scrub, repair replica or backup.

The browser requests native cache selection with a paired zero data/index
limit. Rust chooses at most 16 data pages and four index pages from one
sixteenth of the configured ordinary I/O pool's payload capacity. At the
default 30-MiB ordinary pool this selects 16/4; a 6-MiB pool selects 5/4.
Payload admission still charges twice capacity, slots are charged separately,
and the pool ceiling is unchanged. Extremely small pools select a minimum of
one page of each kind but can still fail allocation with `ENOMEM`. Explicit
nonzero page limits remain available for callers and pressure tests. This
policy does not eagerly read the selected capacity or the whole image.

## Capacity and availability

Image metadata remains opaque bytes in Rust. The image-module length probe
and copy borrow the retained bytes without cloning them. Replacing image
capacity, export timestamp and metadata reserves the replacement metadata
before publishing any option, so an admission failure leaves all three intact.
The JavaScript bridge admits metadata decode/encode before allocating its
native transfer buffer, decoded text or JSON result. It shares a per-realm
64 MiB modeled-credit pool with saved-image manifest operations: each value
has an 8 MiB raw ceiling and a factor-of-12 charge plus traversal/entry credits.
Consequently not every value below the raw ceiling fits. This is a supported
bridge limit, not a native container-format limit or a measured heap ceiling.
Encoding accepts bounded acyclic plain JSON, not accessors, custom prototypes
or conversion hooks. Parsed results and the bridge's retained metadata belong
to their caller or filesystem instance after transient credits are released.
The composer reports this shared pool through its manifest memory observation.
Once a native image load succeeds, the native module owns the input allocation
even if subsequent host metadata decoding refuses admission; the host must
not free the adopted image on that later error. Retrying option changes must
use that image's capacity and metadata, not the previous image's host cache.
Archive-ID bookkeeping refreshes independently of JSON decoding and retries
an unfinished refresh before allocating another archive identity.

Logical filesystem capacity, per-file representability, runtime memory and
origin quota are separate limits. Logical exhaustion is `ENOSPC`;
unrepresentable file growth is `EFBIG`; memory admission can fail with
`ENOMEM`; malformed or damaged storage is not a quota or memory error.
Host quota errors must remain distinguishable from integrity failure and
must not trigger automatic rollback, format conversion or reset.

Legacy KIFS images store separate block and inode ceilings. Shell images declare 512 MiB
and 65,536 inode slots, with a build gate of 32,768 free slots. A byte-only
rebase of an imported image preserves its inode capacity when the tree fits.
The serialized image reserves 128 bytes per inode slot as part of its block
geometry. The image writer materializes inode table pages as it needs them,
and the mounted namespace allocates resident entries as objects are loaded
or created. The logical ceilings do not change the runtime memory budgets.

Legacy saved computers store their checked base image, KOVL version 1
journal and any checkpoint on disk. The kernel reconstructs the live
namespace in memory during boot. The
[KIFS v3 design](plans/2026-11-25-disk-backed-rootfs-metadata.md)
uses one authenticated on-disk tree for the namespace and file-block
references. An explicit embedder option selects the standalone volume
for a disposable computer through the shared Node and browser boot path.
This path covers guest lookup, directory listing, file and symlink reads,
regular-file creation, writes, truncation, sync, hard links, regular-file
rename and unlink, directory and symlink creation, permissions, ownership,
and timestamps. Descriptor-based file metadata changes address the pinned
inode after rename or unlink. Shrinking a sparse file releases the removed
blocks and clears any discarded bytes in its last retained block. Growing it
again exposes zeroes in that range. Open directory descriptions pin their
v3 inodes. Renaming an ancestor updates the paths used for descriptor-relative
lookup. Replacing or removing an open directory detaches its last name.
The descriptor can still stat the original inode until close. Removing the last name, including replacement by rename, keeps
the old inode readable through its open descriptor. Its data remains
charged until the last descriptor or mapping releases it. KIFS records
that inode in an indexed orphan set in the same commit that removes its
last name. Final release removes the marker and reclaims the inode in one
commit. A fresh exclusive writable mount checks this set and finishes
interrupted releases. A read-only open leaves the volume untouched.
A failed reclaim preserves the storage error for sync and stops writes
until the next mount. Logical reclamation makes space reusable inside the
filesystem. Compaction recovers physical space in the backing file.
On the standalone mount, opening a deferred file reads its declaration from the
authenticated tree. The shared Rust reader verifies declared file or archive
digests, streams ZIP members, and serves ordinary reads and private file
mappings. A mismatch returns `EIO`. Host adapter version 9 carries the
resource length with the positioned read, so the first fetch can use bounded
disk staging without enumerating the volume's deferred files at boot.

A quiescent standalone v3 computer can export a compact KIFS snapshot
to an empty positioned file on Node or in OPFS. The Rust writer copies
reachable records, verifies both new superblocks and reads back the
authenticated tree and file blocks. The host returns the physical length
and SHA-256 digest. A failed export leaves the mounted computer authoritative.
A writer with an uncertain published root must reopen before exporting.
The byte-returning API stages the same snapshot on temporary storage,
allocates its result at the compact file length and checks the returned
bytes against the digest. On Node the temporary file is unlinked after
opening. OPFS uses the existing scratch-file owner lock and orphan cleanup.
Both export APIs leave the original generation active.

### Upgrading a saved computer

The shared Node and browser boot protocol accepts an upgrade profile for
checked resizable computers. The Kandelo app requests an upgrade only
with `experimentalKifsV3=1`. Its development profile selects at least
1 GiB. The custom profile keeps a computer's declared capacity. Ordinary
app boots use the saved format. An activated KIFS volume takes
precedence over every profile. Raw images without a checked binding retain
their existing default. Fixed computers keep their declared geometry. On v3,
live metadata and allocated data draw from the same capacity. The volume
grows as records are written, and `statvfs` reports zero for the separate
inode-limit fields.

### Live writes, synchronization and power failure

A mounted KIFS v3 transaction combines adjacent appends in an optional
16 KiB buffer charged to the kernel I/O budget. The first buffered
append attempts admission and falls back to direct writes when memory
is unavailable. The transaction still writes every file block to
positioned storage before returning success.

Within a publication group, the kernel can retain up to 2,048 changed
index keys in an admitted edit map. Ordinary reads see those edits.
Publication builds the corresponding index pages before publishing
either root replica. An operation that outgrows the edit map can
materialize the group during its own transaction. Until publication,
recovery uses the previous durable root. A failed write or partial append
can leave storage beyond that root available for reuse.

KIFS v3 groups publication to amortize the three host flushes required
for a durable root. A successful ordinary `write` makes its returned bytes
visible through the live root. Namespace operations and allocation counters
advance with that root. A worker crash or power failure can lose several
successful, unsynced operations together. Eager v3 published each mutation
before returning success and exposed a smaller window of unsynced work.

A successful guest `fsync` on this volume covers the root containing
that change. To publish pending work, the kernel waits for the host to
acknowledge the appended pages, then each root replica in turn. A clean
sync can return without further I/O. After writing A, syncing successfully, and then
writing B, a crash can recover A or a subsequently published B. This
guarantee depends on the host and device preserving acknowledged flushes.
Tests cover interrupted publication and abrupt worker termination. Physical
power cuts and hosts that reorder or lose acknowledged writes belong to
the [durability follow-up](plans/2026-11-25-disk-backed-rootfs-metadata.md#durability-follow-up).

The next mutation publishes the current group once it has accumulated
64 operations or 1 MiB of appended pages. A metadata operation may
succeed in the live edit map and a later `fsync` can report host
`ENOSPC` during index construction. The previous durable root and
live edits remain available if index construction fails before either
root replica is written. Kernel workers also request
publication every two seconds while runnable. Suspension can delay that
timer indefinitely. Explicit synchronization, clean shutdown and
compaction publish pending changes. If flushing appended data fails, the
live root remains available for retry. A failure writing or flushing a
root replica leaves publication uncertain and stops the writer until reopen.

### Upgrade activation and retirement

Boot replays the source under its exclusive lease. Rust copies the effective
namespace into a separate positioned file and opens the result for a
read-only comparison with the source. It checks inode numbers, contents,
metadata, sparse blocks, deferred descriptors and allocator state. Upgrade
diagnostics cover the copy and the handoff. Ordinary v3 boots open the
selected generation directly.

The two existing KOGA activation controls authenticate a 136-byte KIFG v1
seal. The seal binds the predecessor's sequence, generation, slot, base
digest and seal digest, the new slot and a fresh nonce. Its SHA-256 is also
the expected identity of the v3 volume. Legacy conversion also stages
a 72- or 104-byte KIFR v1 retirement receipt. Its SHA-256 supplies the
KIFG nonce. It binds fresh randomness and SHA-256 digests of the complete
source journal and optional index. The predecessor activation already
binds its checkpoint seal. The `.volume`, `.volume-seal` and `.retirement`
files in slots g0 and g1 belong to this protocol. The checked base,
source journal and checkpoint remain available through publication.

Before activation the current controls continue to name the source. A retry
reuses the inactive staging files after confirming that
authority. A host space refusal, native logical-space refusal or memory
admission failure during candidate staging releases the partial target and
reports why the upgrade was deferred. The verified source can continue
serving the current session. A storage error during activation requires
recovery before another write. Once either control durably names the successor, restart checks
the successor and repairs the other replica. A KOVL-only reader refuses
the published successor. Conflicting controls or an absent active volume
fail recovery. Boot with no controls and leftover v3 staging also requires
recovery.

During use, the runtime requests compaction when the committed file exceeds
both 32 MiB and three times the live allocation. Node and browser workers
check periodically. Compaction copies reachable records and verifies them
under a new seal. Mutations are held through publication. The running kernel
keeps open descriptions and mapping pins while switching backing files. Once
both controls and the mount select the new volume, the worker closes the
previous v3 handle and removes its two owned files. Compaction requires space
for the candidate alongside the source.

After the first upgrade the worker compares each remaining predecessor
file against the authenticated retirement evidence under the same lease.
It removes the exact journal, index and seal, then removes the receipt.
A crash between unlinks leaves the receipt for the next owner. Boot skips
files already removed and verifies the rest before continuing cleanup.
A changed source is preserved and reported. An invalid receipt cannot
authorize deletion. The immutable checked base stays bound to the computer.
After cleanup ordinary boots probe for the small receipt and open the
active generation without scanning the original journal or its directory.

Resizable development shells use the development profile described above to
stage their first v3 generation. The plan records the functional cutover
and the remaining work.
[Power-loss qualification and recovery](plans/2026-11-25-disk-backed-rootfs-metadata.md#durability-follow-up).

OPFS is local to a browser origin/profile. Browser eviction, explicit site
data removal, private-browsing lifecycle or profile/device loss can remove
it. The source candidate does not promise eviction immunity or a successful
`navigator.storage.persist()` grant. Complete deletion of every record of a
computer cannot be distinguished from a new computer by that same storage
alone. A checkpoint retained only in the same origin is not protection
against complete origin eviction. External export/backups remain necessary.

## Evidence boundaries

### Release acceptance map

The following maps durability obligations to their automated coverage. A test
file is an inventory of coverage, not a claim that its current source has
passed the final release run. Final release validation must identify the exact source revision and
report open workload failures separately from historical evidence.

| Obligation | Coverage and boundary |
| --- | --- |
| Dirty-cache visibility and failed writeback | `host/test/fixed-rootfs-persistence.test.ts` and `apps/browser-demos/test/fixed-rootfs-persistence.spec.ts` cover write, partial-write, eviction and flush failures, retained dirty reads, sync errors and reopening. Guest write success and sync success remain distinct. |
| Compaction publication crash cuts | `host/test/overlay-compaction-crash.test.ts` interrupts operations before and after their effects under both flush-only and write-through storage models. It reopens through real seal/selection policy, but its simulated mount callback does not prove native journal replay. Native replay and real OPFS guest cases are separate coverage. |
| OPFS fallback and staging reuse | `apps/browser-demos/test/persistent-inode-capacity.spec.ts` terminates the owner after the journal, index and seal pass storage verification and before activation. It checks native v1 replay, guest inode identities, writes to the source after fallback, and reuse of the abandoned slot when compaction is retried. |
| Activation and lost acknowledgements | `host/test/overlay-generation-activation.test.ts` covers conflicting/damaged replicas, repaired authority, publication cuts, lost close proof and rollback refusal. `host/test/overlay-generation-seal.test.ts` covers target preparation, source protection and retirement. |
| Cancellation and uncertain owners | `host/test/storage-close-ledger.test.ts`, the composer/codec client tests and `apps/browser-demos/test/persistent-boot-quarantine.spec.ts` cover draining admitted work, failed close, superseded boots and retained ownership. A timeout never grants reuse authority. |
| Immutable-image checking and large images | The persistent-image binding/base/boot-I/O tests and checked-pressure fixtures cover both policies, demand reads, corrupted input, bounded caches and larger-than-kernel images. A demand-verified mount is not a complete scrub of untouched blocks. |
| Host quota | Storage/codec fault tests cover injected `ENOSPC` on Node and OPFS. `apps/browser-demos/test/persistent-browser-quota.spec.ts` additionally exercises Chromium's native quota manager. Neither fills the device's physical disk. |
| Application recovery | `apps/browser-demos/test/resizable-persistence-wordpress.spec.ts` exercises posts, uploaded bytes and stable media URLs with the source route unavailable. Chromium browser-process crashes and Firefox/WebKit page reloads are reported separately. The mixed workload adds namespace changes and a 32 MiB distinct-block working set. Historical workload cohorts do not replace a run of the current source; the manual checkpoint workflow is no longer part of these checks. |
| Persistent POSIX parity | The fixed-rootfs kernel/guest fixtures and persistent conformance runners cover namespace, inode, size, mapping and sync behavior. Full current-source release acceptance must identify the exact conformance selection, expected failures and skips rather than treating a demo as POSIX proof. |

### Interpretation

Automated coverage includes Rust transaction/resource fault injection,
Node storage and kernel integration, real OPFS on desktop Chromium,
Firefox and WebKit, journal restart, streamed snapshot recovery, and
publication/ownership cuts. Real-page shell and WordPress SQLite/MariaDB
acceptance must be refreshed against the final ABI-matched products.
Chromium browser-process crashes and Firefox/WebKit page/worker interruption
are different evidence; neither establishes OS power-loss correctness.
Desktop WebKit is not physical iPhone validation.

The Chromium quota-manager cases lower the origin's browser-managed quota
without filling the host disk. An observer records the native OPFS
`QuotaExceededError` on the active KIFS volume. The host reports the
storage-capacity diagnostic and its VFS write call returns `ENOSPC`.
Both checking policies preserve previously durable data through the failed
write and reopening the stored computer after quota is lifted. Shutdown
while quota is still limited can report `ENOSPC`. With the imported source
route blocked, the fixture retries the same write, shuts down cleanly,
and reopens to verify both files. Other engines use injected-quota cases.
The browser-managed override is a Chromium protocol feature.
[Packaged results](measurements/2026-11-27-kifs-stat-cache-associativity.md#compatibility-and-release-scope)

Per-cache limits and kernel page counts are not an aggregate host-memory
bound. A large-image fixture may use more memory while being constructed
than its mounted kernel is allowed. Final workload measurements must state
which producer, kernel, process, codec and browser owners they include.
Likewise, one boot timing under a concurrent build is an observation, not a
matched performance improvement or a mobile-device acceptance result.

Login-cookie continuity remains deferred by user decision; this document
does not promise browser login persistence. Persistent computers use a stable
HTTP bridge route independent of the fresh boot session, so saved media URLs
can remain usable after reboot without preserving that session's cookies.
