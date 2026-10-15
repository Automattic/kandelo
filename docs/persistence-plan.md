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
- [ ] Publish verified staged composed snapshots with a crash-safe handoff.
  Node and browser staging-file APIs stream output, flush it, and compare a
  bounded read-back against emitted per-chunk SHA-256 digests. They return an
  integrity descriptor accepted by browser positioned boot. Browser snapshots
  can now be verified and published as a new computer through the existing
  manifest-last stream installer, or staged as a replacement under a fresh
  journal namespace. Publication now refuses while either the source or
  staged journal is open by a `BrowserKernel`, even under a different computer
  identity. The page now offers an explicit Internals checkpoint action that
  shuts down the old machine, exports from a fresh quiescent kernel, stages and
  boots the candidate, publishes it, then reboots the computer. That page
  path has an end-to-end test gated on complete browser package artifacts,
  which this workspace lacks. Its shared export/stage/boot/publish path is
  exercised with a guest-written fixture on Chromium, Firefox, and WebKit.
  Version 4 manifests require a hashed journal namespace bound to the base
  generation and record whether its journal was initialized; older manifests
  continue using the computer name or the version 3 namespace. A
  production-validated, crash-safe base-and-journal handoff remains open. The
  writer coalesces deferred content references into extents and keeps
  unallocated bitmap and inode-table pages implicit in memory; the legacy
  byte-array API still materializes output. New journal-backed regular files
  now export only written blocks, including across a checkpoint; a logical
  4 GiB file with one tail byte exports and reopens as a sub-64 MiB KIFS body.
  Node and all three browser engines guest-create a 9 GiB sparse file,
  export a sub-64 MiB composed snapshot, reopen its hole and tail without
  the journal, then re-export and reopen it without materializing the hole.
  The same guest workflow truncates and re-extends a dense base file to
  512 MiB, and verifies its zero range after both snapshot boots.
  The kernel also retains sparse block maps from image-backed regular files
  at boot; their holes survive snapshots, including journal writes and
  truncate/re-extend. Journal-backed dense base files also export sparse
  after growth, truncate/re-extend, or a block tombstone; unmodified dense
  base files and in-memory regular files retain dense export mapping. A Rust
  round trip covers dense-base growth and truncate/re-extend after indexed
  compaction. Composing indexed dense-base files scans their checkpoint
  tombstones once per file rather than searching the index for every base
  block; end-to-end snapshot throughput remains unmeasured.
  Indirect-block memory scales with allocated blocks. KIFS v1 addresses at most
  10 + 1,024 + 1,024² blocks per file. KIFS v2 uses the previously unused
  inode bytes 124–127 for a triple-indirect pointer and supports up to
  10 + 1,024 + 1,024² + 1,024³ blocks per file (roughly 4 TiB). The writer
  emits v1 for files within its original limit and v2 only when a larger file
  requires the new pointer; the reader mounts both. Nonzero file and indirect
  pointers must remain within the declared KIFS data region, including when
  enumerating sparse blocks; otherwise reads fail with `EIO` rather than
  exposing metadata or a trailing section as file data. Malformed directory
  records likewise fail with `EIO` rather than hiding later names. VFSI v2 uses
  a 64-bit body length above the v1 32-bit limit; smaller bodies keep their v1
  header. The ABI 51 kernel also boots a synthetic >4 GiB sparse v2 container
  through Node positioned reads, including a trailer beyond the 32-bit offset boundary,
  while reading less than 16 MiB. Node now also boots a physical sparse
  >4 GiB v2 file through a worker-owned, bounded positioned reader. A guest
  write survives strict resizable-journal reboot against that file; Node
  exports a small snapshot, reboots the snapshot with per-chunk integrity,
  and refuses a damaged stage. A changed file-backed base is rejected without
  resetting its journal, and restoring the original base recovers its write.
  The default Node image and byte-array options
  still materialize decoded images. A Rust round trip now builds a virtual
  >4 GiB dense KIFS body, grows its file under an indexed journal after
  compaction, exports it through the v2 container cursor, mounts that output
  with positioned reads, and verifies the file tail without a 4 GiB resident
  buffer. Node boots a small v2 container; all three
  browser engines boot one, commit a guest write, and reopen its journal. A
  physical >4 GiB v2 body now accepts a guest write through Node's resizable
  journal, strictly reopens that journal, exports through Node's staging-file
  API, and reboots the composed snapshot with per-chunk integrity. An opt-in
  Rust fixture builds a dense KIFS body without holding its file bytes in
  memory; a guest verifies the 2 MiB tail at its 64-bit offset both before
  and after the snapshot. The opt-in test checks Node RSS growth stays under
  1 GiB and rejects a damaged snapshot byte beyond 4 GiB. Chromium, Firefox,
  and WebKit now stream that physical fixture into OPFS, boot it, commit a
  guest write through the resizable journal, and strictly reopen the base
  and journal.
  The opt-in browser case now uses the same bounded source stager as the
  persistent page instead of writing the fixture through a test-only stream.
  That stager has a 64 GiB decoded-image cap, separate from the legacy
  in-memory image limit and the browser's OPFS quota. An opt-in 1,025 MiB
  concatenated-zstd source stages and is removed on Chromium, Firefox, and
  WebKit, proving the old 1 GiB in-memory limit no longer governs that path.
  With sufficient free disk, the physical >4 GiB production-stager case now
  passes on all three engines: it exports the body to a second OPFS file with
  staged read-back verification and reboots that snapshot with per-chunk
  integrity. A guest verifies the large file's tail, and both the journal
  reboot and snapshot carry the changed state. The browser test does not
  allocate an image-sized
  JavaScript array, but it does not measure browser peak memory or prove OPFS
  storage sparsity or general snapshot throughput. A Rust round trip now exports
  and reopens a 9 GiB sparse file with a sub-64 MiB KIFS v2 body, including a
  tail in a second triple-indirect branch, without materializing its hole;
  another round trip covers the same size after indexed compaction.
  Files beyond the new KIFS per-file limit still return `EFBIG` before mutating
  an image writer, clear any earlier export plan, and leave the live journal
  usable. A 772 MiB
  snapshot boots under the 768 MiB kernel ceiling on all three browser engines,
  but this is a narrow acceptance case, not a general memory or performance
  bound.

Staged snapshot output now omits write calls for all-zero chunks, extends the
file to the complete logical length, flushes it, and reads back every chunk,
including unwritten ranges, before returning per-chunk digests. This reduces
explicit zero writes but does not guarantee that an OPFS implementation stores
those ranges sparsely.

The opt-in large-export tests need substantial temporary disk space; allow at
least 20 GiB free before generating the fixture for the OPFS source, staged
snapshot, and browser profile. A local run starting with roughly 13 GiB free
failed at snapshot export with `QuotaExceededError`; a run with roughly 21 GiB
free passed. From the repository root, generate the fixture and run the exact
acceptance cases with the ABI-matched guest program. Set the Playwright port to
an unused value so another workspace's Vite server cannot serve stale files:

```sh
host_target=$(scripts/dev-shell.sh rustc -vV | awk '/^host:/ {print $2}')
scripts/dev-shell.sh cargo run -p runtime-core --example large_vfsi_fixture --target "$host_target" -- "$PWD/.context/large-dense-fixture.vfs" local-binaries/test-fixtures/wasm32/persistence-overwrite.wasm
scripts/dev-shell.sh sh -c "cd host && KANDELO_LARGE_VFSI_FIXTURE='$PWD/.context/large-dense-fixture.vfs' npx vitest run test/node-rootfs-export.test.ts -t 'exports and reboots a physical >4 GiB dense VFSI body'"
scripts/dev-shell.sh sh -c "cd apps/browser-demos && KANDELO_PLAYWRIGHT_PORT=57133 KANDELO_LARGE_VFSI_FIXTURE='$PWD/.context/large-dense-fixture.vfs' npx playwright test test/fixed-rootfs-persistence.spec.ts -g 'browser exports and reboots a physical >4 GiB OPFS image' --project=chromium --project=firefox --project=webkit --workers=1"
rm .context/large-dense-fixture.vfs
scripts/dev-shell.sh sh -c "cd apps/browser-demos && KANDELO_PLAYWRIGHT_PORT=57133 KANDELO_LARGE_SOURCE_STAGE=1 npx playwright test test/fixed-persistence-composer.spec.ts -g 'compressed source stages more than 1 GiB' --project=chromium --project=firefox --project=webkit --workers=1"
```

The first >RAM acceptance target is deliberately read-only. It proves that
boot and image reads no longer require an image-sized allocation before
writeback or namespace mutations complicate the result. A large declared
capacity alone does not satisfy this target: the actual decoded image must
exceed the chosen runtime-memory budget.

## Current boundaries

The browser prototype now streams composed output into OPFS with one
acknowledged chunk in flight, verifies the stored bytes, and checks that the
boot still owns the session immediately before closing the manifest under one
exclusive lock. Once close begins, publication cannot be revoked. The next
installation reclaims abandoned generation files. Reopening uses positioned OPFS
reads and a bounded clean cache; fixed overwrites use a bounded dirty cache.
Node and browser hosts now expose `readFileRangeFromVfs(path, offset, length)`
with a 1 MiB per-call ceiling through the existing positioned kernel inspection
export. A host can inspect a journaled 8 GiB sparse file's hole and tail after
strict reboots without asking for its entire contents; Node and Chromium,
Firefox, and WebKit exercise that workflow. The legacy whole-file read API
still materializes its result and is not suitable for >RAM files.
The first-install manifest close is the publication boundary. If its close
acknowledgement is lost, the installer reads back the exact committed manifest
and retains the verified image; it never deletes image bytes while a manifest
might still reference them. A failed pre-commit close removes the manifest,
leaves an orphan image, and the next installation reclaims it. Chromium,
Firefox, and WebKit exercise both outcomes and a successful retry.
Version 4 browser manifests publish as pending. After the kernel initializes
the journal, and before any guest starts, the page verifies its flushed header
against a streamed whole-image SHA-256 digest and marks the manifest ready.
Reopening a pending image may initialize an absent journal because no guest
has yet run; reopening a ready image refuses an absent or empty journal rather
than silently resetting it. Node exposes the same strict reopen option. An
empty strict journal now reports the typed no-valid-generation condition so
the page can try its verified prior image before launching guests.
Chromium, Firefox, and WebKit now exercise a page reload between manifest
publication and the first kernel boot, followed by a guest write, a ready-state
transition, and a strict reboot that recovers the write.
The ready transition also writes and verifies a separate fallback manifest
before replacing the pending primary manifest. If the primary manifest is
damaged later, loading the fallback and reopening its journal preserves the
guest write; if both manifests are damaged, boot fails closed. An explicit
replacement API can now stage a new base under a fresh journal namespace,
boot it before publication, verify both its image and journal header, and
publish it while retaining the prior ready base and journal. When the two
manifests identify different generations, selection verifies the new base in
bounded chunks and its journal header before choosing it; a damaged base or
header selects the verified prior generation. Chromium, Firefox, and WebKit
exercise that handoff and fallback after image, header, and manifest damage.
The browser replacement workflow now injects cancellation at every publish
checkpoint before the primary manifest closes, and checks that the prior
generation remains selected before a later successful publication.
It also injects write and pre-close failures at both the backup and primary
manifest files; Chromium, Firefox, and WebKit keep selecting the prior image
after each failure. If either manifest close commits but loses its
acknowledgement, the writer reads back the exact manifest and continues;
publication succeeds without a false error. Retrying publication verifies
both the committed image and preserved prior image and journals, then succeeds
without rewriting either manifest. A damaged backup refuses that retry. A
persistent-browser-context test stops the publisher immediately before or
after the primary manifest close, then reopens the same profile: Chromium
crashes and relaunches its browser process; Firefox and WebKit close the tab.
All three engines select the prior or staged generation, respectively, while
retaining the prior image after commit. Both generations boot through the real
browser kernel; before-commit recovery replays a guest write from the prior
journal, and after-commit recovery reads the staged base.
An end-to-end browser test also exports a guest-written kernel image to an
OPFS staging file, stages it under a fresh journal, boots it, publishes the
replacement, and reopens it after reload. Snapshot export requires a fresh
quiescent kernel after the guest-writing kernel has been destroyed; waiting
for a process exit alone does not make that kernel quiescent.
This does not prove page-driven replacement, browser-process crash during
publication on Firefox or WebKit, or power-loss durability at that cut.
The page checkpoint action uses the held per-computer lease until both the
source and staged kernels have closed their journals, then releases it before
the manifest-locked publish and boots the selected manifest. Superseded work
cannot start publication; a lost close acknowledgement is confirmed by exact
manifest read-back, while an unconfirmed commit remains an error. Errors stop
the page instead of silently restarting from
an unverified generation. The shared checkpoint handoff passes a browser
guest-write and reload test on Chromium, Firefox, and WebKit, but the full
page transition test is authored and currently skipped without the shell
package artifacts, so page-driven replacement is implemented but not yet
validated end to end here. The gate now requires the package resolver to
authenticate both bash and the shell image; stale files in a partial
source-only projection do not count as complete artifacts. The shared checkpoint
test also drops the primary manifest close acknowledgement after a real commit;
all three engines return
success from the checkpoint and reopen the published guest-written snapshot.
If staged-candidate validation or publication fails after acknowledged kernel
shutdown, the checkpoint releases its computer lease and discards its
unpublished image and journal files under the computer and journal locks.
Discard checks both manifests first, so a committed publication whose
acknowledgement was lost remains intact. Chromium, Firefox, and WebKit exercise
forced candidate rejection with no staged files left, as well as refusal to
discard the published generation after a lost close acknowledgement. Rejection
checks the exact candidate's image, journal namespace, and temporary snapshot;
other computers may change the shared OPFS directory concurrently. A missing
kernel shutdown acknowledgement still
retains the lease and stage rather than risking deletion of an active writer.
Before checkpoint publication or page guest launch, the browser compares the
kernel's live demo configuration and experimental terminal session with the
composition saved beside the image. It also rederives the selected dinit
target's bounded dependency closure from the kernel's live service files. If
a guest changed any of those machine declarations, it fails closed rather
than booting from stale host policy or publishing a snapshot with misleading
composition. Guest edits to all three declarations reject checkpoint
publication on Chromium, Firefox, and WebKit. Guest-edited service commands
with unchanged dependencies remain image-owned executable policy and are not
frozen by this metadata check.
The selected prior manifest carries the exact primary and fallback manifest
digests observed at selection. Only after the prior kernel initializes, and
before guest processes launch, the page checks those digests under the
manifest lock and promotes the prior manifest to primary. A changed manifest
refuses promotion; a successful promotion prevents later repair of the newer
image from silently switching away from writes made on the recovered branch.
The damaged newer base and journal remain on OPFS for forensic recovery.
The page now holds a separate per-computer Web Lock from before image selection
until kernel teardown. A second tab using that page path refuses to boot the
same computer, and same-page restarts wait for the preceding boot and kernel
teardown before acquiring the lease again. Chromium, Firefox, and WebKit cover
tab contention, explicit release, and tab-close release. A valid worker destroy
response follows closure of the OPFS journal handles and is the storage
quiescence acknowledgement. If that response is missing, malformed, or timed
out, page teardown retains the computer lease even after calling
`Worker.terminate()`: browser termination has no join acknowledgement, so a
same-page restart cannot prove the old writer stopped. The tab must close to
release this fail-closed lease; fallback boot cannot launch a second generation.
The page passes its lease to BrowserKernel as an in-process claim, so kernel
initialization cannot release it while a worker still owns the computer.
Low-level persistent callers must supply a computer name or a claimed page
lease; BrowserKernel refuses a journal without either. Supplying a name acquires
the per-computer Web Lock. BrowserKernel also holds a second exclusive Web Lock
on the exact journal namespace from before worker initialization through an acknowledged storage
close and worker termination, including low-level callers. A competing
same-journal browser kernel fails before opening storage. Pre-ready init
failure releases the lock after worker termination; a missing destroy response
or failed termination retains it. A valid response can acknowledge storage
closure even when process-generation detach or persistence sync reported an
error; those errors remain visible diagnostics, not claims of durability.
Node and browser kernel hosts retain an acknowledged persistence shutdown
sync failure for callers after teardown. The page latches that failure and
refuses same-page persistent restarts, including superseded boots, instead of
silently starting from potentially older journal contents; a reload is needed
to attempt recovery. Browser quota-failure tests exercise this shutdown result
in fixed and resizable modes on Chromium, Firefox, and WebKit.
Node now holds a non-waiting OS-backed exclusive lock on each persistent
journal's `.lock` SQLite file for the kernel lifetime. Unlike the previous
directory lock, it is released by the OS after a process `SIGKILL`. Fixed and
resizable Node mounts strictly reboot with a synced guest overwrite and lose
an unsynced dirty-cache overwrite without calling shutdown. A second Node
process cannot acquire the same journal while its owner remains live. The
lock file remains after clean shutdown and must not be removed while a writer
may be active. An old directory-form `.lock` fails closed and requires explicit
operator removal after verifying the old owner has stopped; there is no safe
automatic way to distinguish its stale and live forms. Browser Web Locks and
OPFS sync access handles remain the browser-side ownership mechanism.
Node refuses symlinked or hard-linked `.lock` files before SQLite opens them,
including a dangling symlink or a lock hard-linked to journal data.
Node also rejects journal, checkpoint, and seal files with more than one hard
link after opening them; otherwise two path aliases could take different lock
files while writing the same journal inode. A strict reboot test rejects both
aliases and reopens the original after the extra link is removed.
Chromium, Firefox, and WebKit each recover after termination without destroying
the kernel, with synced and unsynced guest writes in both fixed and resizable
modes. All 12 strict reboots recover exactly the durable state. The Chromium
cases crash the browser process and relaunch the same OPFS profile; Firefox and
WebKit reload the page. Browser-process crash recovery on those engines and
power-loss recovery remain unverified.
Chromium, Firefox, and WebKit exercise a worker that drops destroy requests:
the old tab refuses same-journal boots after the timeout, and a new tab can
reopen the journal after the old tab closes.
Concurrent initialization on one BrowserKernel is rejected before it can
overwrite the first worker handle. Replacement publication now takes
non-waiting exclusive locks on both journal namespaces as well as the
computer lease. A low-level kernel using a different computer identity but
either journal namespace blocks publication. Raw OPFS writers that bypass
these locks remain outside this protection. Callers must stop the old kernel
before taking a snapshot and complete the staged boot before publication;
the explicit page checkpoint action now orchestrates those transitions for
fixed-overwrite computers.
Later committed journal-record corruption is detected by the kernel and
rejected with `EIO`. Selection tries another valid slot on the same base,
then reports no valid generation if a nonempty legacy journal also fails.
The page can then retry the verified prior base, but the full page retry race
remains unverified. Stages abandoned outside the explicit checkpoint workflow
are not reclaimed. Selecting a replaced generation adds a full-image preflight
read before the kernel's own verification. This remains a prototype, not a
general atomic generation handoff.
If the selected journal generation disappears, every sealed slot is invalid,
or all existing candidates are rejected with `EIO`,
after manifest selection, Node and browser workers now report that specific
no-valid-generation condition through a typed initialization error. The page
can retry boot with the verified prior image and its own composition rather
than keeping machine settings from the failed image, then promote it before
running guests. Journal backend failures during kernel initialization now fail
closed even when a host import mapped them to `EIO`; the host preserves the
original exception rather than treating it as a corrupt sealed generation.
An unexpected end of file remains a corrupt-generation signal, not a backend
failure, so a truncated indexed checkpoint can still select the prior slot.
Host backend failures and non-`EIO` kernel refusals still fail closed.
Focused Node and three-engine browser tests cover
the typed error and prior-candidate boot. A full page retry race test is
authored but remains unverified here because this workspace has no complete
browser package artifact tier; it is gated on those artifacts.
The full-page guest-write/reload smoke test is gated on the same package tier.
Direct low-level `BrowserKernel` callers must mark pending journals ready and
promote selected fallback manifests after successful initialization and before
launching guests; the page boot path does both automatically.
Older image manifests remain strict on reopen, so a crash before their first
journal initialization can still leave them failing closed. Automatic,
quiescence-safe base-plus-journal replacement and complete generation fallback
remain open.
ABI 51, following main's networking ABI 50, adds the third host storage handle
needed to compact an indexed journal while its checkpoint remains open.
Writes spanning more than 64 cache blocks are split into bounded chunks;
later writeback failure returns a short count rather than claiming the entire
write succeeded. A 2 MiB guest `pwrite` followed by `fsync` survives a Node
worker restart and Chromium, Firefox, and WebKit page reloads.
`msync(MS_SYNC)` now flushes the rootfs journal after publishing `MAP_SHARED`
bytes, rather than waiting for a later `fsync` or clean shutdown; Node and
browser restart tests check the committed journal before shutdown.
`sync()` and rootfs `syncfs(fd)` now flush pending journal blocks and metadata;
`syncfs` reports storage failures and rejects host-mounted filesystems without
a mount-wide sync adapter. Guest tests reopen journal bytes captured before
clean shutdown on Node and all three browser engines.
`sync` and rootfs `syncfs` now force kernel-owned rootfs `MAP_SHARED` mappings
to publish their stores before flushing the journal, including sole-writer
mappings. The mapping pass selects rootfs backings, leaving tmpfs and memfd
backings outside the rootfs durability barrier. Node and three-engine browser
tests recover mapped writes from the journal captured before clean shutdown.

Rootfs `fsync(fd)` and `fdatasync(fd)` now publish that file's pending
`MAP_SHARED` stores before flushing the journal, including a sole writer;
other files' mappings are not selected. Node and three-engine browser guest
tests reopen journal bytes captured before clean shutdown.
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
checkpointed, sealed, and verified. First recovery of an unindexed journal
below the 32 MiB conversion threshold still holds its changed-block map in
memory. Oversized unindexed journals convert before mount with bounded
scratch. An indexed boot scans
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
Activation checks whether a prepared checkpoint can release its resident
metadata before replacing the active mount; an activation error leaves the
source journal and its base-name tombstones available for further writes.

Boot now checks three optional sealed journal slots (`g0`, `g1`, and `g2`)
on Node and browser hosts, preferring the highest verified generation. A seal
authenticates the compacted prefix while the active journal may append later
transactions; the kernel still validates and replays those transactions. If a
slot is torn, or its journal or indexed checkpoint is rejected with `EIO`,
boot tries the previous valid slot and then the legacy journal. Other kernel
refusals and host backend failures, including errors mapped to kernel `EIO`
imports, propagate rather than triggering fallback.
Any two verified slots claiming the same generation are ambiguous; boot refuses
to select either or fall back to legacy until the conflict is resolved.
If the nonempty legacy journal is rejected with `EIO`, boot reports a typed
no-valid-generation condition rather than a generic kernel refusal; a fresh
empty journal does not use this recovery classification.
If generation files exist without any valid journal, boot refuses to create
or reuse an empty legacy journal as a replacement, even for a non-strict
low-level caller. Node and Chromium, Firefox, and WebKit exercise that torn
slot plus empty-legacy case. Compaction prepares a
compacted journal without switching the kernel's active handle, writes and
verifies the target seal, and only then activates it. Failure cancels the
prepared target and invalidates its seal. The kernel refuses activation if
the source changed during preparation. New v3 seals also record the
source slot and exact journal length: if seal invalidation fails after a
rejected activation, boot rejects the stale target while that source
generation remains available. Reusing the old slot after a successful
handoff does not invalidate the active generation. Earlier v1/v2 seals stay
readable; they do not carry this source-length guard. The `g2` source code
extends the existing v3 seal slot enumeration; older hosts that know only
`g0`/`g1` cannot read a generation sourced from `g2`. After activation,
a seal or old-handle close failure is reported without skipping attempts
to close the remaining old handles; the active target is retained because
activation cannot be rolled back. Synchronous storage and hash operations
run on the dedicated kernel worker during live handoff; guest syscalls wait
until that turn finishes. The pause has not yet been measured for large
changed-block sets.
Node and Chromium, Firefox, and WebKit now reboot a real compacted journal
after appending a later committed transaction to its former source. All four
recover the newer source data rather than selecting the still-valid but stale
sealed target, exercising generation selection and kernel replay together.
OPFS quota exhaustion while opening the journal directory, generation file,
or sync access handle retains `ENOSPC`; only a missing file at the file-lookup
step counts as an absent generation. A file that disappears while its access
handle is acquired is an operational failure, not a missing generation.

Recovery truncates a torn append shorter than the minimum complete transaction,
including a partially written transaction header. The writeback test exercises
every byte offset of a torn 4 KiB block transaction; Node and browser tests
reopen journals torn before and after the header and near the commit marker.
Injected OPFS `QuotaExceededError` failures before the first transaction write,
at cuts 1, 23, 24, 128, and 4096 bytes into it, one byte before the transaction
ends, and at its flush now exercise both fixed and resizable guest paths on all
three browser engines: `pwrite` remains readable
from the dirty cache and `fsync` reports `ENOSPC`. Reload after a failed write
recovers the previous durable bytes; after a failed flush, either the complete
old or complete new transaction may survive, and boot must accept both.
The browser also exercises a short OPFS write followed by quota failure on
the retry, both after 128 bytes and one byte before transaction end.
Quota failure during dirty-cache eviction returns a short guest write, leaves
accepted dirty blocks readable, and keeps `ENOSPC` available to a later
`fdatasync` rather than replacing it with `EIO`. Rust unit coverage and guest
runs on Chromium, Firefox, and WebKit exercise that boundary in both
fixed and resizable modes, including recovery of the previous durable bytes.
Guest `MAP_SHARED` stores followed by `fsync` or `fdatasync` also report
`ENOSPC` when the OPFS journal write or flush fails. The live file remains
readable from the dirty cache, and restart accepts only an intact old or new
transaction. Fixed and resizable mounts pass these fault injections on
Chromium, Firefox, and WebKit. Node's real kernel channel with injected
in-memory host storage also checks both sync calls and both failures against
a fresh worker boot. The same Node channel now exercises the positioned
filesystem adapter with a host-backed file: failure before a write, after a
128-byte short write, and at flush each reports `ENOSPC`; a fresh worker
recovers only the prior intact data or a complete flushed transaction.
Resizable namespace fault coverage now injects failed journal writes into
rename, rename-over-existing, unlink, and hard-link transactions in Rust:
each leaves the live and reopened names and link counts unchanged. The Node
kernel channel checks rename write and flush failures, while Chromium,
Firefox, and WebKit check
OPFS write, torn-write, and flush failures. A failed rename reports `ENOSPC`
without publishing the new name in memory. Reboot recovers the old name after
a failed write; after a failed flush, it may recover either the old or the
complete new name, never a partial rename.

This does not yet cover every host write and flush failure point, so the
dirty-cache milestone remains open. A full 64-block dirty cache can accept a
64-block overwrite that replaces 63 cached blocks and adds one new block: it
evicts the one eligible old block rather than failing because the preferred
16-block writeback batch is unavailable. A Rust regression checks that the
write survives sync and recovery.

## Next format boundary

The current in-memory map of every changed block cannot be the production
index. A checkpoint should instead be an immutable, sorted, checksummed table
stored next to each journal generation. Its fixed-size pages can be searched
with positioned reads and a bounded page cache; the in-memory map then holds
only mutations appended since that checkpoint. The seal must bind the exact
base image, table, journal prefix, and replay sequence. Boot may verify and
open a sealed table without rebuilding its entire map, then replay only the
bounded unsealed tail. A corrupt table or mismatched seal must reject that
generation and try the prior valid one. Older journals need an explicit,
non-destructive conversion path; no format change may silently reset a machine.

A fixed-block checkpoint table now writes sorted block locations without
materializing an index copy, binds their checksum to the base and exact
journal prefix, verifies all records on open, and uses one cached page for
binary-search lookups. The kernel builds it after boot-time compaction by
flushing and verifying each indexed block. An indexed generation seal binds the
sidecar by length and bounded chunk digests; Node and browser selection reject
a byte-damaged candidate, while the kernel rejects a syntactically sealed but
semantically invalid checkpoint. Indexed open verifies the journal prefix,
replays only later transactions, reads older blocks through the table's
bounded page cache, and merges the table with later mutations during
compaction. Focused tests reject damaged prefix and committed-tail bytes while
truncating an incomplete tail. Indexed open now hashes each validated prefix
transaction during replay instead of reading the full prefix once for hashing
and again for replay; an I/O-count test covers the journal read volume. It
still scans the entire prefix. Live
compaction and a write-stop limit bound the active tail;
fixed-overwrite compaction's target map is no longer resident. An oversized
unindexed fixed-overwrite journal now converts before mount: the kernel
validates complete source transactions into checksummed 96-byte block
references, sorts them through the target and index files in bounded 384 KiB
runs, selects the last update per block, and emits a canonical v5 journal and
checkpoint. The
source is left untouched and the host seals the target only after conversion
and readback; an incomplete target is ignored on the next boot. Subthreshold
legacy journals retain their existing recovery path. Oversized unindexed
resizable journals now use a separate bounded conversion: checksummed 384-byte
descriptors carry ordered metadata and block mutations through on-disk merge
sort; duplicate truncate markers in the block stream remove superseded writes
without a resident block map. The canonical target has a version 4 metadata
and block checkpoint. The source remains untouched until the target is sealed
and mounted. An oversized sealed version 1/2 generation converts from its
journal into a free sealed slot before mount, without trusting the old index
or changing the source. A third slot allows conversion while two valid
generations remain; interrupted conversion keeps both sources available. A
semantically rejected slot may be reused after its rejection. When all three
slots are occupied, boot retains the older full-map path rather than overwriting
an unproven fallback. Node and Chromium, Firefox, and WebKit reboot fixed v1
and resizable v2 sources through this upgrade; two-valid-slot fixed v1 and
resizable v2 cases reach `g2` on all four hosts.
Conversion needs quota for the temporary sorted references and target journal;
an `ENOSPC` failure does not publish the target or discard the source. Peak
resident memory and conversion latency on a near-capacity image remain unmeasured.

Compacted resizable generations now write a version 4 checkpoint with a
sorted, checksummed metadata table in the same sidecar as the block table.
Its fixed-size records locate current inode, size, zero-fence, and dirent
values in the authenticated journal; deleted records are tombstones. The
table is streamed from compacted transactions with bounded buffers and
searched through one cached page. Indexed boot verifies its order, checksum,
and exact mutation locations while hashing the journal prefix, but does not
materialize that prefix's metadata in the overlay map. Rootfs streams the
table to rebuild its POSIX inode and directory state; subsequent lookups and
compactions merge the indexed prefix with the bounded unsealed tail. Small
version 1/2 generations and fully occupied three-slot cases still use the
older full-map path; version 3 metadata tables remain readable without value
digests. The resident rootfs tree and temporary namespace-graph validation
still scale with file count,
so this is not yet a full namespace-memory bound. The 312-byte fixed metadata
record adds sidecar space; its boot and compaction costs need measurement.
Hot indexed metadata values use a 64-entry bounded cache, so repeated
file-size and zero-fence reads do not reissue positioned journal reads.
The version 4 table binds exact value locations and SHA-256 value digests at
boot, then checks each indexed value on its next storage read. A value already
in the 64-entry cache is not reread until eviction or reboot. Legacy version 3
tables have no on-demand metadata value authentication, but their compacted
block stream is now checked against the journal prefix at boot. A forged block
location or digest is rejected even when the old table is internally
rechecksummed and resealed. A valid v3 source and recovery from a forged v3
block digest are exercised on Node and Chromium, Firefox, and WebKit. Indexed
version 4 boot also checks every compacted block record against
the corresponding sorted checkpoint entry while replaying the journal prefix.
It rejects a self-consistent but false block location or digest with `EIO`
instead of exposing another block's bytes. The check uses the checkpoint's
bounded page cache; versions 1/2 retain their previous validation.
The extra per-block hash work at boot has not yet been benchmarked.
New compacted fixed-overwrite generations use version 5 of the checkpoint
sidecar to mark their block stream as canonical. Boot checks every indexed
block against the corresponding journal mutation with the same bounded page
cache and rejects a false location or digest with `EIO`. Oversized version
1/2 fixed indexes convert before mount when a sealed slot is free; smaller
or fully occupied three-slot cases retain their older recovery path. Node and
all three browser engines now exercise a re-sealed, internally checksummed v5
index with a false block digest and recover through the prior valid generation.

The live handoff now uses that third handle and a dedicated kernel-worker turn.
The fixed-overwrite checkpoint is streamed, but its worst-case memory and
handoff pause duration have not been validated for an actually large writable
image. General POSIX mutation replay uses the metadata checkpoint, but
the rootfs namespace tree and graph-validation scratch remain resident.
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
checkpoint. The same pass hashes the prefix; indexed boot latency still
needs measurement.
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
directories, symlinks, FIFOs, and pathname socket nodes also use versioned
inode records. Recovery restores FIFO pipes from the replayed namespace,
including hard-link aliases. Pipe contents and socket endpoints remain
session-local; only their filesystem nodes persist. Snapshot export retains
these special nodes rather than dropping them. Recovery validates
the final directory graph, rejecting cycles, multiple parents, and non-empty
orphan directories before publishing it. Graph validation now borrows base
directory entries and overlay names instead of cloning every base directory
entry into a second tree; a wide-directory Rust regression covers replacements,
deletions, and new links. Validation and replay now use sorted inode-number
vectors rather than per-inode `BTreeMap` nodes for their temporary lookups.
These scratch structures and the resident rootfs tree still scale with file
count; peak boot memory is not yet measured. Data-only or
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
directory mtimes after reopening on Node and all three browser engines.
The rootfs rename path rejects directory self-moves by normalized components
before journaling, including redundant slashes or a trailing source slash;
a Rust restart regression checks that rejection leaves the tree intact. The
live ctime after a persistent hard link now stays at the timestamp committed
with the directory entry, even if the clock advances during journal flush;
a Rust regression checks that live and reopened metadata agree. The
kernel's image exporter now reads mounted journal blocks, zero fences, and
created files when building a composed snapshot. Small Node and browser
snapshots reboot without the source journal. The public host export still
collects the whole output in memory; separate Node and browser staging-file
APIs now write one kernel chunk at a time without retaining the output in JS.
Node refuses to overwrite an existing path; browser requires an empty OPFS
target and truncates partial output on failure. Both hosts flush the staged
image, verify its bytes in bounded 1 MiB reads against the SHA-256 hashes of
emitted chunks, and return the chunk integrity descriptor. Browser boot with
that descriptor accepts the snapshot and rejects a later byte-damaged file on
Chromium, Firefox, and WebKit. The browser can publish such a snapshot as a
new computer or stage it for explicit in-place replacement: it checks each
source chunk against the descriptor while copying
through the bounded stream installer, then read-back verifies the copied
generation before writing its manifest. A bad source leaves the new computer
unpublished. Version 4 manifests require a hashed journal namespace and
streamed whole-image digest;
the browser boot uses that name when opening the overlay, and rejects a changed
namespace rather than silently starting an empty journal. Existing manifests
without that field retain their original name. A composer guest write survives
a reboot through a non-default journal namespace on Chromium, Firefox, and
WebKit. Explicit page-initiated replacement now uses a quiescent kernel
handoff; full page validation with shell artifacts, browser-process crash,
and power-loss recovery remain open. The image writer coalesces
adjacent deferred content blocks into extents: a 32 MiB file occupies fewer
than 20 extent records while reads across direct and indirect boundaries
return the expected bytes. Unallocated bitmap and inode-table pages now emit
as zeros without residing in kernel memory; an 8 GiB possible-capacity image
with 40 created files keeps one page per bitmap, two inode-table pages, and
less than 128 KiB of counted image metadata in the writer. The block bitmap's
mandatory metadata prefix still grows with maximum capacity, and indirect
blocks grow with file size. Writer operations reject unallocated inode IDs
instead of indexing absent pages. The writer and kernel reader reject a body
whose blocks exceed its serialized bitmap's addressable range, rather than
emitting or mounting allocations the image cannot record. >RAM snapshot export
remains open rather than a production guarantee. Kernel mount now also validates
the contiguous bitmap and inode-table regions and refuses a body truncated
before its declared last block.
The constrained-memory positioned-install browser case now exports its
written 772 MiB-plus image to a separate OPFS snapshot after a clean reboot,
then reloads the page and boots the snapshot with its chunk integrity
descriptor but without the source journal. Guest reads verify both the
ordinary overwrite and the large file's tail write on Chromium, Firefox,
and WebKit while the kernel ceiling is 768 MiB. The export path does not
allocate the image-sized output in JavaScript or kernel linear memory;
the writer's resident block-bitmap prefix still depends on maximum capacity;
indirect blocks, rootfs tree, and journal metadata scale with file size or
count. Peak memory, handoff latency,
larger-file format limits, and crash-safe snapshot publication remain open.
Node and browser guest workflows also replace an open created file by rename:
the displaced descriptor retains its data with link count zero, while the
replacement file's content and metadata survive a reboot.

Resizable compaction now omits inode, size, block, and child-dirent records
for closed, unlinked inodes. An open-unlinked file retains its records through
compaction until the handle closes; deletion tombstones on live parents remain
so base-image names cannot reappear. Recovery also releases replayed inodes
that have no names or open handles before a later compaction chooses what to
retain. Node and all three browser engines run a 32 MiB distinct-block guest
write with an additional closed orphan block, then verify that the checkpoint
contains only the 8,192 live blocks and the orphan stays absent after restart.
Node and all three browser engines also hold an unlinked file descriptor open
through the first live compaction: its 4 KiB block remains in the checkpoint
and readable through the descriptor. After the descriptor closes, a second
live compaction drops that block; reboot keeps the orphan absent and all
8,192 named-file blocks readable. The live-inode filter uses a temporary
sorted vector proportional to resident inodes, so large-file-count memory and
handoff pause still need measurement. General POSIX replay still needs broader
conformance of metadata, open-unlinked lifetime, and namespace edge cases.
Compaction also drops deleted names that never existed in the immutable base,
while retaining base-name tombstones so deleted image files cannot reappear.
The mount tracks only touched base names and reconstructs that set from the
unchanged base tree on restart; repeated create/delete cycles no longer grow
the compacted journal with transient-name tombstones. A version 3/4 generation
keeps only its unsealed metadata tail in the overlay map, subject to the
63 MiB write-stop limit; legacy and version 1/2 generations still retain
their full metadata map until conversion. The rootfs tree remains resident.
Journal transactions must continue publishing related directory
entries, inode metadata, file size, and blocks together; recovery must rebuild
the same link counts and zero-filled truncate/extend behavior as the live
kernel.
With the ABI 51 canonical rootfs rebuilt, the Open POSIX Test Suite's full
available interface set reports 174 passes, three expected failures, and two
unsupported cases; the focused Sortix directory-`fsync` case passes. These
default conformance runners do not mount the experimental persistent overlay,
so their results do not establish persistent namespace or restart semantics.
The Open POSIX runner now has an opt-in `--persistent` mode that derives the
canonical image with each test fixture under the rootfs-owned `/run`, mounts
a fresh resizable journal, and points `TMPDIR` at that image-backed work
directory. The full available interface set on that mount reports 174 passes,
three expected failures, and two unsupported cases, matching the default
isolated run. Its `fsync` interface passes all three available cases in both
modes. The interface's success case unlinks an open file before syncing it;
the two other cases reject invalid file descriptors. The available Open POSIX
inventory is mostly non-filesystem interfaces, and this run does not reboot
any test's journal. It therefore does not establish persistent namespace or
restart conformance.
The Sortix runner now also accepts `--persistent`: each runtime test stages
its private fixture inside the canonical rootfs, uses an isolated resizable
journal, and points `TMPDIR` at the image-owned test directory. Eleven selected
filesystem cases (rename, renameat, truncate, link, unlink, mkdir, open, and
fsync) pass in both isolated and persistent modes. Its full 55-case I/O suite
passes in both modes with three parallel workers. These runs use
fresh journals per test and do not reboot them; they do not establish restart
conformance or cover the full Sortix inventory on persistence.
The 949-case Sortix basic suite also runs on the persistent mount with four
parallel workers: 941 pass, eight are expected failures, and none fail
unexpectedly. This broadens live POSIX coverage, but still does not inspect
each journal after reboot or measure peak memory and compaction latency.
The persistent stdio, process, and paths suites add 79 passes with no failures
or skips. Together with basic and I/O, 1,083 Sortix runtime cases first ran on
fresh resizable journals without restart checks.
Sortix now has an opt-in `--persistent-reboot` mode. After the guest exits, the
runner inspects the image-owned fixture tree, checks for shutdown sync failure,
destroys the first kernel, and boots the exact same composed image and journal
with strict existing-journal recovery. It compares the fixture's paths, types,
sizes, ownership, permissions, symlink targets, and SHA-256 of regular files
within a 32 MiB total content-read budget, streamed in at most 1 MiB per call.
Files beyond that budget receive bounded 4 KiB head, middle, and tail samples,
up to a separate 8 MiB total sample budget, then metadata-only comparison.
The inspection refuses more than 10,000 entries. Eleven
selected filesystem cases and all 55 I/O cases pass strict post-test reboot
with this state comparison. A comparison or reboot failure forces runner exit
125 and a host diagnostic marker, which the persistent-reboot runner records
as an unexpected failure even when the guest's output matched an expectation.
The 79-case stdio, process, and paths suites also pass with the comparison.
The 949-case basic suite at four parallel workers produces 941 passes, eight
expected failures, and no unexpected outcomes or timeouts. At 14 parallel
workers it produced three timeouts; those cases each pass when rerun
sequentially. The runner now exits nonzero for any unexpected timeout. This
checks journal replay and fixture namespace reconstruction. The remaining
limits, malloc, signal, and UDP suites add 282 passes, 13 expected failures,
and two skips across 297 cases, with no unexpected failures or timeouts. In
total, 1,380 Sortix runtime cases ran under strict post-test reboot before the
larger content budget. The 55-case I/O suite also passes with 1 MiB streaming
hashes and bounded large-file samples under the new budgets. At two parallel
workers, the 949-case basic suite also passes under those budgets: 941 passes,
eight expected failures, and no unexpected failures or timeouts. The
comparison still omits changes outside the fixture, unsampled regions of large
files, and test-specific expected state;
those remain separate conformance work.
