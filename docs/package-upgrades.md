# Persistent package upgrades

## Implementation status

The isolated release-stability branch contains a Rust upgrade coordinator,
native inventory-authoring primitive and bounded kernel/host transport.
Producer-owned fixture sets upgrade and roll back through Node and all
three browser engines, including reload recovery and new lazy-file reads.
The app selects verified current bundles and owns maintenance/recovery through
More → Software updates. A real earlier-to-current WordPress-family recipe
upgrade passes in Chromium, Firefox and WebKit, including page interruption,
resumed staging, rollback, unchanged posts and exact uploaded PNG bytes.
Guest file hashes prove the actual software revision changed and rolled back.
Both deployments use the same current trusted runtime and program ABI 55.
This does not establish upgrades across program-contract changes. Keep the
first-release compatibility warning until that broader path is proven.

Native and Node tests now cover a base declaring an older contract: its data
mounts with guests closed, and native tests upgrade it on the unchanged base,
reopen, roll back and reapply. No running application has crossed a real
program-contract change yet, so this is not evidence for that path.

A native positioned-file probe now verifies, stages, atomically publishes,
reopens and rolls back a complete 14,487-path pristine WordPress software-set
comparison without increasing memory budgets. Reopen checks the complete
inventory and unmanaged user data. This is filesystem/package evidence, not
an executing WordPress upgrade demo. The later running app result above is
separate evidence. Deferred-source availability after old assets disappear,
a running cross-contract upgrade and final release gates remain open. Actual
results and limitations are in the [persistence plan](persistence-plan.md).

Rust owns package inventories, conflict checks, staging, activation,
recovery selection and rollback. Hosts supply bounded byte transport; the
application must stop/retire guest workers before requesting maintenance.
The native process-table gate does not by itself prove host-worker retirement.
Automatic browser re-instrumentation is outside this iteration; see
[program compatibility](persistent-program-compatibility.md).

## Inventory and compatible sets

`KPKG` inventory format version 1 records the expected program ABI and
program-contract digest, package names/versions, exact dependency pins and
sorted owned paths. Files retain permissions, ownership, type, size and
content identity. Symlink targets retain their POSIX meaning. Deferred
files additionally retain the complete bounded SDEF provider description.
The inventory is bounded to 8 MiB, 4,096 packages and 65,536 files.

Encoded inventories, decoded file/action tables, verification paths,
activation-path/parent tables and producer records use a separate 64 MiB
native admission-credit workset. File hashing/staging still uses
bounded I/O buffers and does not increase read/writeback cache allowances.
The package workset appears in the filesystem memory report and releases
its credits when those owners drop. It does not reserve another Wasm memory
or increase address-space ceilings; smaller actual heap availability can
refuse an otherwise valid update.

Upgrade actions retain checked byte ranges into their owned, immutable
before/after inventories instead of copying each path, provider description
and symlink target. These ranges contain offsets, not pointers into decoded
tables or caller buffers. Install, pending recovery and rollback select
the corresponding inventory explicitly. The decoded tables can be released
after planning without invalidating action content. Private discard first
collects and validates recognized entries, growing its admitted workset
only for entries actually present; it never reserves the largest permitted
cleanup list for a small update.

Each package digest commits to its program contract, name/version, complete
owned-file inventory and exact dependencies. Omitting or substituting a
file cannot retain the old package digest. Package ordinals are not content
identity. Raw and deferred references to the same bytes have the same
logical identity; transport descriptions are separately covered by the
complete inventory checksum. These are content commitments, not signatures
or executable producer/build-key ownership checks. Distribution integration
must obtain the intended inventory through the current trusted path.

The installed inventory lives at `/var/lib/kandelo/packages/installed`.
This state directory must be root-owned with mode 0700; inventory/control
files use mode 0600. The image producer must emit the initial managed
inventory, rather than adopting potentially edited user files on first
upgrade. Canonical Base Shell, Web Stack and WordPress family recipes now
emit a baseline during pristine image composition. Normal product builds
and byte-for-byte recapture after loading their published images pass.

The image module now has a native inventory-authoring primitive. Recipes
select owned paths; Rust captures metadata, hashes resident content in at
most 64 KiB chunks, retains bounded provider descriptions, sorts paths and
encodes the inventory. A trusted producer can supply a missing archive
member digest derived from its verified prebuilt archive. This does not
fetch deferred content or adopt an existing computer during an upgrade.
Derived build images can instead inherit those member hashes from a trusted
pristine parent inventory. Rust requires the same member path, length,
archive length and digest, complete transport addresses and payloads; only
local numeric archive identifiers may differ. A changed binding requires
new hashes from the declared archive. Inheritance copies bounded lookup
metadata, never retains a pointer into the caller's inventory, and releases
the lookup before final encoding. It is not a runtime baseline-adoption API.
Capture revalidates filesystem lifetime, file state and complete provider
descriptions before finishing. Source changes invalidate dependent caches
and previously captured proofs.

Authoring an inventory does not authenticate an image's origin. The absence
of a mounted journal is not evidence that imported bytes are pristine:
an exported user-edited image is still an image. Production recipes and
bundle selection must establish trusted inputs separately. The runtime
maintenance API cannot create a missing installed baseline; that refusal
must remain in place. Existing first-release computers are not automatically
upgradeable: adding this producer hook does not retroactively establish
their original software baseline.

The first producer policy treats each complete image-family selection as
one software package, assembled by the normal prebuilt dependency graph.
Its content commitment changes when software changes; it is not a catalog
of individually selectable package updates. The build driver supplies the
current program digest through its native snapshot reader. The shell
derives missing member hashes from its declared, digest-verified archives;
derived families inherit only bindings that still match exactly.

Managed paths cover shipped `/bin`, `/sbin`, `/lib`, `/usr`, `/etc` and
`/var/www` software, plus the Web Stack's `/var/lib/todo/server.rb`.
Explicit exclusions preserve credentials, host/network configuration,
service/backend choices, generated trust certificates, WordPress secrets,
`wp-config.php`, uploads, database data and the per-site database drop-in.
Both independent WordPress sites remain outside the managed software set
under `/var/lib/wordpress-sites`. New user-created files are not silently
added to an installed baseline. Changed managed files still require the
coordinator's conflict checks; database migrations remain explicit.

## Image-owned source binding

`KandeloImageFs.pinPackageInventorySources` delegates incoming inventory
binding to Rust. It replaces image-owned `kandelo-lazy:programs/...` and
`binaries/programs/...` references with absolute HTTP(S) addresses beneath
the chosen source directory. New asset-group publication names that directory
with the manifest's SHA-256, instead of the reusable `release-1` label.
The caller must obtain and verify the intended manifest through the trusted
bundle path before choosing its directory; a hash-looking path alone does not
authenticate a server or its contents.

Rust requires the final directory component to be 64 lowercase hexadecimal
characters, bounds URIs, refuses traversal/ambiguous encodings, and rejects
unknown relative addresses instead of silently retaining a mutable deployment
base. Existing absolute HTTP(S) addresses stay unchanged. Other source schemes,
including realm-local blob URLs, are refused by this web-bundle binding API.
Files retain their hashes,
permissions, owners, archive-member paths and opaque activation/seal payloads.
Package content/dependency commitments stay identical; the complete inventory
checksum changes to cover the newly bound transport descriptions. This does
not adopt a saved filesystem as a missing original package baseline.

The incoming bound inventory is separate from the pristine target image's
original inventory. Staging and publication persist its provider descriptions
through the existing journal and indexed compaction. Keep the saved base
image's original lazy-asset directory fixed: target providers have their own
absolute addresses, while original virtual references and rollback retain the
original source. A global directory swap would make two releases disagree
about the same virtual name. No second host-owned source registry or filesystem
inventory is introduced. The image-module export is additive; filesystem,
journal, package-format, userspace and kernel-host versions are unchanged.

Source identity is not source availability. A never-fetched lazy resource
still needs its retained server, or separately retained local bytes. These
bindings do not promise complete offline operation after a deployment deletes
old assets. Missing sources remain explicit read failures; they must not fall
through to another release. These resources are package bytes, not archives
of privileged host/kernel runtimes. Application bundle selection is verified
against the current deployment's content-addressed manifest; each computer's
bounded software-product identifier selects a product, not execution authority.

## Positioned target-image reader

`PackageImageSource` opens a raw image through the positioned native image
module. Before exposing its inventory, it verifies the complete source image
against the caller's trusted SHA-256 in 64 KiB windows. It reads the bounded
resident producer inventory, binds its providers in Rust and retains only the
bound inventory plus native filesystem state. It neither adopts an installed
baseline nor executes a guest program. The underlying bytes must remain
immutable for the reader's lifetime.

`BrowserPackageImageSource` implements the application's source interface with
a disposable worker. That worker holds an exclusive OPFS access handle for
the staged target. Inventory and requested resident regular-file reads cross
the worker boundary in independent buffers of at most 64 KiB. Deferred
providers remain kernel-staged descriptions, not eagerly downloaded file
bodies. Only one source request may be in flight. The main thread receives no
image-sized buffer or Wasm memory; process workers receive no OPFS handles.
Full source verification occurs during explicit maintenance, not normal boot.

Closing joins the current read and requires an explicit storage-close
acknowledgement before terminating the worker. An unacknowledged close,
timeout, worker failure or invalid response requires retaining the staged
target; termination alone is not treated as proof of OPFS handle retirement.
The application must keep its source-staging lease until this close completes.
This source worker does not establish that guest/device/bridge retirement
has occurred; that remains the maintenance owner's responsibility.

Node uses the same native positioned reader through a host file/byte adapter.
Small package activation/recovery/rollback fixtures now use real target-image
reads on Node and Chromium, Firefox and WebKit, rather than a separate
path-to-body table. A positioned probe also reads the 258,904,403-byte pristine
WordPress image, its 7,478,268-byte bound inventory and 36,997,760-byte PHP-FPM
binary, with a maximum observed source read of 65,536 bytes. This is bounded
source-reader evidence, not a complete WordPress upgrade or RSS measurement.

## Maintenance and conflict policy

The process table admits maintenance only after ordinary process records,
including retained exited records, have been removed. Synthetic init can
remain. Guest process allocation returns `EBUSY` without creating init or
consuming a task identity. Tokens identify one session and cannot authorize
another session or process table.

The native maintenance-session owner keeps this token private while
receiving bounded inventory chunks, preparing/resuming an upgrade and
handling explicit cancellation or discard. Cancelling releases temporary
verification state, not a durable pending transaction. Leaving maintenance
refuses incomplete or pending transactions, incompatible installed program
contracts and failed persistence synchronization. Even a successful package
commit leaves guest admission closed until explicit validated release.
Dropping the owner does not implicitly resume guest execution. Full
inventory verification occurs during maintenance recovery, not on every
ordinary boot or progress request.

Reading a saved filesystem and running its programs are separate decisions.
A checked persistent image mounts for data whatever program contract its
header declares: that header describes the programs the image was built
with, not the software a later upgrade installed, and it is never rewritten.
Guest admission closes before the image is read and stays closed through
image load, journal replay and every failure, including a failed attach and
filesystem reset. Refusals consume no task ID. After replay the kernel worker
asks Rust to assess the composed filesystem against the contract of the kernel
it actually loaded, never against an uploaded inventory or saved metadata.
Guests are admitted when there is no transaction record and either an
installed inventory matches the runtime or, without an inventory, the base
declares a compatible contract. An Active or RolledBack record must also agree
with the installed inventory. A missing, malformed, mismatched or incompatible
inventory, a pending or incomplete transaction, and an unknown record version
all leave guests closed without writing to storage. Unsupported old images are
still refused by ordinary loading, composition and publication; only the
explicit persistent mount tolerates them. Replacing a filesystem while tasks
exist or during maintenance returns `EBUSY` before the old one is touched.

Only the set being activated must be runnable. Rollback restores files without
running them, so it succeeds when the old set uses an older contract; leaving
maintenance then refuses with `ENOEXEC` and guests stay closed until a current
set is applied. This keeps the rollback promise from depending on a retained
old runtime, of which there is exactly one: the current trusted runtime.

Changed or removed owned leaves are verified against the installed
inventory. New paths require absence; unowned collisions are never
overwritten. Verification uses at most a 64 KiB content buffer per active
file. An immutable deferred binding can establish the old identity without
fetching an unavailable old provider. Mutable files are hashed. Transient
read errors do not advance the digest or verified offset.

If upstream leaves a file unchanged, the updater preserves its current
inode, including local edits. If upstream changes or removes an edited
owned file, it refuses the conflict rather than adopting those edits as a
package baseline. Unowned files, databases, media and home directories are
not package-update targets.

Proofs bind the original maintenance session, filesystem epoch and observed
inode generation/metadata. Reload invalidates them even if inode numbers
and sizes repeat. Cancelling an old verifier cannot close a new
filesystem's reused handle. Every prepared operation rechecks control-file
proofs; activation also rechecks all live and staged file proofs.

Native progress reports the actual current path, installed/staged phase,
verified-file counts and incremental bytes for the active verifier. Staging
discovery identifies only the raw files that need uploaded bytes and their
expected lengths; hosts need not interpret deferred-provider policy to
request staging. Kernel-host adapter 5 exposes this through one bounded
`kernel_package_maintenance` export. Its versioned packet layout, opcodes
and typed failure reasons are shared/generated; program ABI 55 is unchanged.
The shared worker supplies the current kernel's own program-contract digest;
main-thread callers cannot select an arbitrary runtime contract. Both main
proxies exchange bounded copied data with that worker. No process worker
opens OPFS or implements package policy. After journal recovery and before
maintenance release, both hosts refresh transfer limits from Rust's live
provider descriptions. A newly installed URI therefore becomes readable
without trusting a second host-owned filesystem inventory. The app also
exercises that transport through actual upgrade and recovery controls.

The application-side `PackageUpgradeClient` drives this interface using
independent chunks of at most 64 KiB, native staging requests and native
verification progress. Its caller must already own maintenance mode and
retain kernel/storage ownership until the operation and cleanup settle.
Cancellation joins outstanding work, then drops only volatile coordinator
state; it never implicitly discards durable recovery or admits guests.
Once commit is dispatched, late cancellation cannot hide its successful
acknowledgement. Finalization errors retain whether commit was acknowledged;
uncertain cleanup refuses another operation until the computer is reopened.
The same driver passes real Node and three-engine browser fixture tests.
`PackageMaintenanceSession` owns the app's asynchronous operation, source and
cancellation lifetime. Unconfirmed source closure retains the computer lease,
including when kernel retirement also fails; it cannot reopen another
computer on the same uncertain owner. Browser tests inject both retirement
states into the actual owner and verify the competing-tab lock. The app
checks native pending/unknown authority before guest startup or profile writes.
Per-computer OPFS source receipts enable source-bound resumed staging; receipt
publication precedes transfer of the source's staging lease. They do not
replace native inventory or executable admission checks.
The changed-file progress bound is generated from Rust's shared transport
definition, including unions larger than one inventory. This adds a
kernel-host constant without changing packet layout or the program ABI.

Maintenance mutations coordinate with the existing live generation compactor
on both hosts. An additive, token-authorized native advice operation requests
compaction before staging when the active tail reaches 32 MiB or journal-state
admission is under pressure. Publication additionally requests an indexed
compaction when there are outstanding timestamps, writeback, any active tail
or a version-1 journal. This releases prefix-state ownership before preparing
the atomic package publication without raising any memory or tail limits.

The shared host coordinator copies bounded inputs before awaiting compaction,
joins any running generation handoff, and rechecks both lifecycle admission and
native advice before dispatching the mutation once. Required compaction failures
remain failures for the maintenance caller; shutdown still joins their cleanup
before retiring storage. Recovery inspection and cancellation do not depend on
successful compaction. No mutation is retried based on a guessed cause of
`ENOSPC` or `ENOMEM`, or after an uncertain publication.

## Boot configuration of an updated computer

An update may legitimately change `/etc/kandelo/demo.json`, the terminal
session or the `dinit` service closure. The saved composition describes the
immutable base, so comparing an updated computer against it would refuse a
correct boot. Comparing against the live files instead would accept anything,
because a guest is root in its own computer and could edit both the
configuration and the installed inventory.

The configuration of an update therefore comes from the verified target image.
Before the native commit, the app records it in
`software/boot-configurations.json` in the computer's directory, which guests
cannot reach, keyed by the SHA-256 of the inventory bytes that activate it. It
also keeps the record of the set being replaced, so rollback has its own
authority. At most two records are retained, and the file is size-bounded,
versioned and refused rather than ignored when malformed.

Publishing first is safe because a record is inert until replay shows its
exact inventory installed, so a crash on either side of the commit selects
correctly. A rewritten inventory matches no record and falls back to the base
composition. Selected configuration is still compared with the live files
before guests start, so guest edits stay refused. The machine is configured
before replay can run, so a boot assumes the newest record, confirms it after
replay, and on a mismatch retires that kernel and boots once more with the
correct configuration. Checkpoints use the same selection, so a replacement
base stores the configuration of the software it actually contains. A target
that no longer declares the computer's profile is refused before native work.

## Staging, activation and recovery

One private `transaction` directory contains before/after inventories,
`new` staged files, `old` rollback references and versioned control records.
Raw content is accepted in chunks of at most 64 KiB. Completed raw files
are synchronized before verified activation. Deferred files stage durable
bindings without downloading content. Archive-ID collisions are remapped
locally, retaining both old and new declarations. An identical archive
binding can reuse its existing ID.

Same-content relocation to a deferred provider retains already durable
local bytes when metadata is unchanged, so an unavailable new provider
does not make readable content disappear. Unresolved files receive the new
verified binding. A relocation combined with metadata changes to a local
file is currently refused rather than losing its bytes.

`KUPG` control format version 1 is a 108-byte record containing phase,
before/after inventory identities and SHA-256 checksum. These package
formats are independent of filesystem, journal, userspace,
fork-instrumentation and kernel-host versions.

Pending authority is linked only after inventories and control bodies have
synchronized. Activation commits package names, installed inventory, old
rollback references and active authority in one journal transaction.
New directory trees move from empty private staging directories into the
final parent graph in that same transaction. Directory mode/owner/group
updates commit alongside file replacements without replacing their children.
Staged names remain available until their verified publication. That same
atomic transaction removes consumed staging aliases while creating rollback
references; it does not retain two unnecessary private names for each file.
Activation preparation borrows immutable inventory and verification paths
instead of copying them into another namespace owner. Rollback verifies active
package files and retained old files, then atomically restores the old
names/inventory and rolled-back authority. It does not roll back user data
or database schemas.

Journal publication prepares all fallible state before storage writes and
serializes through at most 64 KiB of scratch. This removes the whole-frame
encoding copy. New journals use `KOVL` version 2, with a 16 MiB format
limit for one atomic transaction. Recognized version-1 journals retain
their 1 MiB bound on both replay and append. Compaction creates a new
version-2 target without rewriting the source; the existing generation
publication protocol decides whether that target becomes authoritative.
Unknown versions remain refused. These are disk-format decisions, not
userspace or kernel-host ABI changes.

Recovery still validates the complete transaction before
applying records. A failed write or uncertain flush poisons the writer; it
does not publish an in-memory partial activation or retry against uncertain
storage.

Recovery and compaction now retain a complete frame only when it fits in
64 KiB. Larger frames use a 64 KiB page buffer, one record buffer bounded
by the 192 KiB inode-value limit plus its 278-byte envelope, and 32 bytes
per page for authentication. These buffers use existing I/O admission;
read/writeback cache allowances and Wasm memory ceilings are unchanged.
The reader checks the frame checksum, footer, complete record syntax and
record count before exposing records to external visitors. It checks every
reread page against the digest retained from that validated frame, including
reads for indexed-prefix hashing. A later self-consistent replacement frame
cannot substitute its pages for the frame being replayed. Small frames still
borrow their original values without another value buffer.

Ordinary raw write planning and automatic compaction batches retain
their earlier 1 MiB ceiling. Large atomic publication must fit the active
tail's existing total bound before it can write; it cannot consume extra
space beyond the headroom reserved for already accepted writeback.
Larger format limits do not increase I/O, journal-state or namespace
memory admission. A valid transaction can still be refused for memory.
Namespace publication validates the complete edit set and deduplicates inode
timestamp changes before reserving its mutation table. Its reservation covers
the actual directory edits plus unique metadata changes, rather than three
speculative metadata slots per edit. All payloads, replay preparation and the
complete frame still require admission before the first publication write.
Multipage frames require extra reads and
hashing; application startup/recovery performance has not been measured
for this reader. Rebuilt Node/browser acceptance is also still required.

### Privileged package files

The native implementation can replace and roll back set-user-ID and
set-group-ID regular files without stripping their permissions. New
privileged regular/base/provider inode metadata uses record version 3;
ordinary records keep their existing versions. This is a filesystem-record
feature, not a program or kernel-host ABI change.

Writable raw files remain writable. The first write prefix that must clear
privileges commits its data blocks, optional new length and complete
post-write inode metadata together, before publishing the live change.
That prefix is bounded to the ordinary 64-block planning window. Later
prefixes can use the normal writeback cache because privilege clearing is
already durable. Truncation couples the same metadata with its size, zero
fence and optional boundary block. Failed preparation leaves permissions
and content unchanged; failed writes/flushes retain the poisoned-writer and
old-or-complete-new recovery rules.

Zero-byte writes and unchanged-size truncates do not clear privileges.
Set-group-ID without group execute permission is retained, matching the
existing content-write rule. Ownership changes keep their mode/owner/group
update atomic, and chmod regrant flushes preceding buffered content first.
Export uses current journal-backed bytes and lengths even after permissions
are restored.

Deferred files retain their existing write restrictions and read-time hash
checks. New provider records still require file and applicable archive
digests; unchecked deferred base content cannot gain persisted privileges.
Recovery refuses content overlays on providers and on privileged resident
base files without the required explicit inode metadata. Fixed-overwrite
mode does not acquire privileged-write support from this change.

These paths pass the complete native runtime suite and image-module suite,
including every-byte interrupted privileged activation/rollback and raw
content mutation. Rebuilt Node/browser acceptance for privileged upgrades
remains required; the existing small three-engine upgrade fixture is not
evidence for this new permission path.

Reopen requires the installed inventory to match the phase's complete set.
Unknown versions, malformed receipts and mismatching inventories are
refused, not treated as permission to select another set. Missing status
on an otherwise private transaction directory identifies incomplete
staging or interrupted cleanup. Explicit discard removes only recognized
private files/directories, never installed package paths. Discarding an
active transaction deliberately gives up rollback. A torn final flush is
outcome-uncertain: the writer refuses further mutations and reopen decides
old versus new state.

## Current limits

- Regular/deferred files, symlinks, nested new directories and directory
  metadata updates are implemented. Directory/file type changes, special
  nodes and unchecked privileged sources remain refused. Removed package
  directories stay in place for user children; rollback requires their
  original metadata.
  Rollback of an added directory leaves it for any newly created user data
  while removing its added package-owned files.
- The planner accepts the union of two inventories, each bounded to
  65,536 files: at most 131,072 changed paths. A native pristine-product
  comparison plans all 13,376 WordPress changes without provider fetches.
  This is planning evidence, not a completed application upgrade.
  Journal version 1 limits activation to 1 MiB; version 2 permits 16 MiB.
  Oversized activation is refused, not split into partially visible sets.
  Memory admission can still refuse a valid inventory/publication. A later
  complete WordPress probe activates 14,487 paths through four indexed
  compactions and checks full inventories after reopen/rollback. The app's
  actual recipe revision also passes in all three engines. Keep the active
  tail and memory bounds; maintenance compaction handles them rather than
  disabling their admission checks.
- Pending recovery re-verifies old paths. Raw staging can continue at its
  durable size or explicitly restart that file. Completed activation must
  be reopened as a new operation before rollback. One transaction is
  retained per computer; discard it before starting another upgrade.
- Incoming sets must match the current supported program contract.
  Rollback refuses an old set unsupported by the current runtime. No
  privileged old runtime is retained or loaded.
- Incompatible immutable-base program declarations still need explicit
  non-executing recovery admission. Legitimately upgraded boot metadata,
  supported userspace compatibility, missing old lazy sources and final
  complete conformance/memory gates remain release work. Guest network and
  retirement-time memory/thread diagnostics remain under investigation.
  Database migrations stay explicit.

Native tests are development evidence, not proof that browser computers
can upgrade. The [persistence plan](persistence-plan.md) records actual
cohorts and remaining delivery gates.

The WordPress + MariaDB acceptance scenario updates Kandelo's compatible
packaged software set in a saved computer and checks its posts/media after
upgrade, interruption recovery and rollback. It does not require a
WordPress-specific updater or automatic WordPress core/plugin/database
schema migrations. Database migrations remain explicit.
