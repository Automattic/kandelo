# Persistent package upgrades

## Implementation status

The isolated release-stability branch contains a Rust upgrade coordinator,
native inventory-authoring primitive and bounded kernel/host transport.
Producer-owned fixture sets upgrade and roll back through Node and all
three browser engines, including reload recovery and new lazy-file reads.
Production image bundles, the application workflow and a supported
cross-release WordPress upgrade path remain pending. Keep the first-release
compatibility warning until integrated acceptance proves that path.

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

Encoded inventories, decoded file tables and producer records use a separate
64 MiB native admission-credit workset. File hashing/staging still uses
bounded I/O buffers and does not increase read/writeback cache allowances.
The package workset appears in the filesystem memory report and releases
its credits when those owners drop. It does not reserve another Wasm memory
or increase address-space ceilings; smaller actual heap availability can
refuse an otherwise valid update.

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
Dropping the owner does not implicitly resume guest execution. Image load
and journal reopen inspect only the small transaction-authority record to
keep incomplete, pending or unreadable upgrade authority in maintenance.
Ordinary process admission stays blocked after reload until an explicit,
compatible maintenance release. User files remain readable for inspection
or export. Full inventory verification occurs during maintenance recovery,
not on every ordinary boot or progress request.

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
without trusting a second host-owned filesystem inventory. This is tested
transport, not yet a validated application upgrade UI.

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
It is not yet connected to the application's worker-retirement/recovery UI.

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
Staged names remain available for verification. Rollback verifies active
package files and retained old files, then atomically restores the old
names/inventory and rolled-back authority. It does not roll back user data
or database schemas.

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
  nodes and set-ID leaves remain refused. Removed package directories stay
  in place for user children; rollback requires their original metadata.
  Rollback of an added directory leaves it for any newly created user data
  while removing its added package-owned files.
- There are at most 4,096 changed leaves per upgrade. The atomic journal
  transaction limit also applies; oversized activation is refused, not
  split into partially visible sets. Memory admission can refuse a valid
  inventory under a smaller available budget.
- Pending recovery re-verifies old paths. Raw staging can continue at its
  durable size or explicitly restart that file. Completed activation must
  be reopened as a new operation before rollback. One transaction is
  retained per computer; discard it before starting another upgrade.
- Incoming sets must match the current supported program contract.
  Rollback refuses an old set unsupported by the current runtime. No
  privileged old runtime is retained or loaded.
- Worker-retirement integration, bundle consumption, complete host
  upgrade acceptance, UI, and real WordPress + MariaDB
  upgrade demonstrations remain open. Database migrations stay explicit.

Native tests are development evidence, not proof that browser computers
can upgrade. The [persistence plan](persistence-plan.md) records actual
cohorts and remaining delivery gates.
