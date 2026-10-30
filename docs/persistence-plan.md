# Persistent VFS image plan

The fixed-overwrite and resizable-file overlays provide opt-in persistent
rootfs support. Keep the immutable base image and its append-only
journal separate: a failed update must never rewrite the only bootable base.
The browser owns OPFS byte transport; the Rust kernel owns filesystem
semantics. Node and browser must expose the same guest-visible behavior.

The [durability contract](persistence-durability.md) defines source-candidate
sync acknowledgements, shutdown ownership, checkpoint/recovery boundaries,
checking policies, format scope and browser quota/eviction limits. Its
existence alone does not establish acceptance. The completed ABI-55 gate audit
is recorded below, including the known limits and measured costs.

**Infrastructure completion (2026-10-26):** the declared implementation and
Node/three-engine acceptance gates are complete. Checkpoint 1.39 is a frozen
current-runtime build with six passing shell/MariaDB recovery cases. All nine
enabled Node/Chromium benchmark suites complete in two counterbalanced passes
per side/host against independently built ABI-54 main `7dfe4b501`. The record
retains an automatic source-checkout rootfs lookup regression and short-clock
microbenchmark flags; it does not claim broad performance neutrality. Actual
installed-computer demand reopen avoids that development-only lookup. The
draft PR remains unmerged and opt-in interfaces retain their experimental
names. Native-phone testing, device power-loss guarantees and unrelated system
hardening are not implied. See the [final requirement reconciliation](measurements/2026-10-26-abi55-persistence-acceptance.md#requirement-reconciliation).

## Current release acceptance work

**Approved delivery split (2026-10-31):** ship live persistence and the agreed
computer/activity UX first. Transactional software upgrades and long-lived
cross-release executable compatibility are follow-up work, not requirements
for this first merge. Do not represent those features as implemented. The
historical expanded-goal gates below this section remain evidence of earlier
scope, not the current release checklist.

Persisted computers are explicitly release-bound. Creation, retention and
reopen must prominently warn: **Saved computers from this release will not work
in the next release. Export important files before updating Kandelo.** This is
not permission to silently delete incompatible storage. Do not remove format
or executable admission checks, load archived privileged runtimes, or swap a
new base beneath an old journal to conceal incompatibility.

### First-iteration merge checklist

- [ ] Show the release-bound warning when creating or keeping a computer,
  in Library, and after automatic reopen, including small screens and the
  default dark theme. Validate it in the running app.
- [ ] Complete final integrated validation of the current Rust/kernel/host
  changes, persistence recovery, computer UX, conformance and memory ownership.
  Preserve failing runs and disclose unsupported boundaries; historical
  checkpoints do not establish current readiness.
- [ ] Build and publish a current WordPress + MariaDB checkpoint and verify
  posts/media persist through refresh without a manual checkpoint. Preserve
  older computers and test origins.
- [ ] Update the draft PR and release documentation for this scope, publish
  the complete batch, and reconcile every first-iteration acceptance item.

### Implemented foundations and agreed UX

The following work remains part of the first iteration. A checked design or a
narrow test is not evidence that an unimplemented updater exists.

- [x] Show admitted storage metadata and Rust memory counters in Config;
  remove the automatic feedback invitation while retaining community links.
- [x] Complete the remaining Activities, Temporary-tag retention, independent
  boot-log, Services, and service-declared Shortcuts changes.
- [x] Validate those controls with real persistent WordPress/MariaDB and
  publish a tested web checkpoint while preserving older saved computers.
- [x] Establish a supported userspace ABI baseline and test already-built
  programs against later runtime changes, including user-compiled programs.
- [x] Deliver the current fork-compatibility policy: the instrumentation
  contract is versioned but not promised stable. Warn that user-built forking
  programs cannot be automatically upgraded and may require rebuilding.
  Refuse incompatible executables before execution without changing their
  files, with an actionable rebuild error. Automatic browser preparation and
  mandatory original retention are explicitly outside this iteration.
- [x] Reconcile ordinary namespace/metadata writers with recovery's accepted
  permission records before package activation is exposed. Investigate
  authenticated base set-ID names and special-file set-ID chmod; no successful
  write may create a journal that the same runtime refuses to reopen.
- [x] Complete the latest UI feedback: restore Temporary-tag contrast, use
  Library deletion guidance, require a typed computer name for deletion, hide
  Library during boot, and add the Services menu icon. Distinguish supervisor
  startup from failure and keep captured inspection output out of boot logs.
- [x] Let the WordPress family switch between independent SQLite/MariaDB
  sites while storing one shared copy of WordPress software. Keep databases,
  uploads and settings separate; do not migrate or overwrite either site's
  data implicitly. Annotate stopped services without discarding the preview.
  Validate the complete browser workflow and publish a fresh checkpoint.

### Deferred upgrade work

The first package upgrade implementation will require maintenance mode with
guest programs stopped, authoritative package file ownership, user-modified
file conflict detection, interruption recovery and rollback. It must preserve
user-created files and leave database migrations explicit. The existing atomic
leaf-activation primitive is internal, not an implemented package updater.

Packaged upgrades will use current prebuilt binaries, including current fork
instrumentation. Installed files and unresolved lazy references must be
activated as one compatible package/dependency set, bound to verified content.
Persist versioned provider descriptors and inode bindings through journal
recovery, indexed checkpoints and rollback; handle removed providers and
interrupted updates on Node and browser. Resolution is not a version boundary:
keeping old binaries while pointing unresolved members at new builds is not
an upgrade. Never overwrite user edits or fetch arbitrary latest bytes.

Existing opt-in original/preparer prototypes are development facilities, not
requirements for persistent computers. Automatic browser preparation and
mandatory original retention remain outside this iteration.

The later stage is documented in
[the compatibility contract](persistent-program-compatibility.md#staged-fork-compatibility).
It accepts uninstrumented user programs, retains protected originals when
preparing them, and replaces incompatible derived instrumentation with the
original for preparation on next use. That stage is not implemented here.
The user explicitly approved deferring transactional upgrades. First-iteration
completion must not be reported as completion of those deferred features.

**Current staged-contract validation (2026-10-31):** the shared pre-launch
fork validator now explains that its versioned contract is not yet stable and
directs incompatible user-built programs to rebuild with the current SDK, or
packaged programs to a compatible package update. The runtime does not rewrite
the refused file or invoke an automatic preparer. A derived negative fixture
changes the linked-frame descriptor version without modifying the frozen
supported fixtures or restamping their program digest. Tests compare the
refused bytes before and after launch, and again after OPFS reopen.

`fork-compatibility-warning-1031-130505-0811` passes 32 cases in five Node
files and all six offline memory/OPFS cases across Chromium, Firefox and
WebKit. Host build/declarations pass; exact compiler comparison retains the
same 38 existing diagnostics with none added. The preceding
`current-delivery-1031-125833-39b6` passes 521 cases in 17 Node files and all
six browser cases after removing the deferred compiler-service identity
experiment. Its failed experimental run remains a separate receipt. The
earlier provisioned native run passes all 3,154 runtime-core cases and the
839 xtask unit/eight integration cases; it is not a passing combined release
run because its experimental service case and browser-libc initialization
failed. Browser-libc prerequisites are being provisioned through the normal
resolver rather than bypassing artifact checks.

These checks are not transactional upgrade acceptance, a new WordPress
checkpoint, the complete conformance suite or the mixed browser-memory gate.
The existing UI checkpoint at port 57433 remains unchanged. Production
maintenance admission, installed ownership inventory, durable lazy-provider
activation and a real persisted WordPress upgrade remain unimplemented.

**Inspection isolation foundation (2026-10-31):** the implementation adds
a one-shot Rust/Wasm metadata inspector with bounded private memory and a
fixed 160-byte ephemeral result. It does not run another kernel or open OPFS.
Node and browser own worker creation/termination; Rust retains parsing and
preparation policy. Parser-free Rust verification checks exact source and
budget binding without allocating. This contains infallible malformed-input
parser diagnostics only when the isolated path is used. It does not complete
automatic execution, trusted helper/cache custody, compiler memory admission
or any of the four unchecked release items. See
[the inspection contract](persistent-program-compatibility.md#failure-contained-rust-inspection).

The reviewed batch `program-policy-reviewed-1031-092925-5d9a` passes six codec
cases, all 3,146 runtime-core cases plus the allocation-denial integration,
the artifact-reader cases, and all 839 xtask unit/eight integration cases.
ABI/baseline, standalone module, resolver reproducibility and full host
build/declarations pass. The eight-file Node/package cohort passes 191 cases
with two existing explicit exact-shell proof skips; the three-engine offline
worker cohort passes allocation failure/recovery, cancellation and bootstrap
URL disposal. Earlier authored fixture, registry-snapshot, audit and worker
loader failures remain separate receipts, not erased by this passing run.
Read-only review found and checked fixes for error-listener retirement,
young-heap accounting and short original references. The final shared Node
adapter rerun passes 59 cases. Compiler comparison reports 40 HEAD versus
38 current diagnostics, none added; Vite URL declarations remove two existing
missing-module diagnostics. This is not a passing whole-host typecheck.
These are inspection/ownership checks, not a rebuilt WordPress upgrade or a
fresh combined conformance/browser-memory acceptance. Checkpoint 57433 remains
unchanged and automatic install/exec remains unchecked.

**Trusted tool launch foundation (2026-10-31):** kernel-host adapter 4 can
retain an anonymous readonly current-runtime tool for a pending child's
initial launch. This does not change program ABI 55 or its supported digest.
Normal observation, admission, compilation and spawn commit still apply.
The host retains ownership through scratch and entry validation; a serialized
host-only handoff distinguishes unclaimed registrations from handles Rust may
have consumed. Busy-entry refusal allocates no program registration.
Own-process procfd execution now retains the actual open file description
after unlink or pathname replacement, preserves its offset, honors nofollow
and rechecks execute permission. General procfd open remains unsupported.

The full native workspace passes, including all 3,151 runtime-core cases;
all 839 xtask unit/eight integration cases, ABI/baseline checks, resolver and
artifact guards pass. Normal kernel, guest preparer and canonical rootfs
builds complete. The final twelve-file Node cohort passes 468 cases with no
skips. Six offline memory/OPFS cases pass across Chromium, Firefox and WebKit,
including pinned preparer/optimizer descriptors after both tool names move,
native-identical output and execution of the prepared result. Full host build
and declarations pass. Exact compiler comparison reports 38 HEAD and current
diagnostics with none added; this is not a passing whole-host typecheck.

Receipt: `trusted-preparation-launch-1031-101812-9b86`, with final Node report
`vitest.FaeioV`. The original combined run has one failed static source-shape
expectation after adding the handoff argument; the corrected expectation
retains exact gated dispatch and the full cohort passes. Earlier authored
fixture failures remain separate receipts. A private comparison script also
mistook a failed large `git show` read for an absent file; its 117-diagnostic
baseline is invalid, superseded by the exact tracked-file comparison above.
These checks do not implement trusted tool selection, private compiler
workspace, helper-family completion, automatic exec or sealed cache
publication. All four release items remain unchecked. Combined conformance,
mixed browser-memory and a rebuilt WordPress upgrade checkpoint remain open;
the existing UI checkpoint is unchanged.

**Latest delivery acceptance (2026-10-31):** original retention now reaches the
rootfs generator, in addition to shell composition and both native cache
policies. A versioned, bounded dependency binding file carries Rust-selected
package generations into sealed image recipes without nested Cargo/index
lookup. Architecture fallback, selected cache identity, actual raw/prepared
content, stripped references and lazy-URI round trips are checked. The real
native `less` consumer recipe generates and reopens a rootfs with its readonly
465,635-byte original still lazy. Base-image producers have not all opted in;
this does not complete ordinary install/exec preparation.

The final native sources pass 839 xtask unit and six integration cases, with
unchanged ABI/baseline admission and reproducible standalone resolver output.
All 241 cases in six complete image/rootfs/bridge/resolver files pass in
`base-original-data-final-1031-020142-ab6a`. The preceding combined run passes
237/238; its first source-rootfs profile case times out while a release native
compiler is observed running. Explicitly provisioning that tool precedes the
passing final runs; the five-second test deadline is unchanged. Earlier
fixture and module-loader failures remain separate receipts. Host compiler
comparison remains 40 baseline/40 current diagnostics, none added or removed;
this is not a passing typecheck. No new full shell/WordPress/browser build or
automatic execution acceptance is claimed. Checkpoint 57433 remains frozen.
The final sealed-input rerun also passes all 241 cases with an explicitly
missing ambient registry in rootfs binding fixtures
(`base-original-sealed-final-1031-020411-faea`).

**Preparation binding foundation (2026-10-31):** a portable Rust plan now binds
fully observed exec-source bytes to their original, exact preparer/optimizer,
options, dependencies and supported program contract. A fixed version-1 cache
receipt verifies actual derived bytes and refuses stale/corrupt bindings.
Original loading and output validation have separate byte limits; cached output
can remain usable under a tighter raw-work limit. This does not authenticate
the transform or complete the service's aggregate memory bound. It has no new
runtime FFI, automatic helper execution, cache publisher or Node/browser path.
Source/image ownership, original-access checks and bounded metadata admission
remain necessary before enabling that service.

The same work found and removed whole-body copying in the Rust ABI/thread-slot
marker reader. Native probes observe largest allocation requests of
4,194,306 to 0 bytes for one unrelated 4 MiB function, and 1,048,576 to 0 for
20,000 unrelated functions. Tests fail before and pass after the change while
preserving constructor/wrapper behavior and bounded recursion. These are
reader-level native allocation results, not WordPress startup measurements.
The final `preparation-marker-final-workspace-1031-025639-6023` run passes the
workspace excluding xtask, all 3,115 runtime-core and 839 xtask unit cases,
eight xtask integration cases, 21 artifact unit plus five marker allocation
cases, Wasm `no_std`, unchanged ABI/baseline and resolver reproducibility.
The initial authored lease test compile errors and expected pre-fix allocation
failures remain separate receipts. No new full product, browser/conformance or
cross-host benchmark acceptance is implied; the four unchecked release chunks
remain open and checkpoint 57433 is unchanged.

**Private preparer I/O (2026-10-31):** the normal guest package now accepts
readonly input descriptors and empty, unlinked output descriptors, using
positioned I/O without changing shared offsets or copying source permissions.
Supplied and owned descriptors are close-on-exec; the optimizer cannot inherit
them. Storeless original binding avoids making another named raw copy. Output
is validated before writes, but write/sync failures still require the controller
to discard partial private staging; successful CLI completion is not atomic
execution-cache publication.

Actual guest testing found that the SDK's Rust standard library selected its
architecture-only wasm32 Unsupported branch for descriptor cloning, despite
the kernel's working `F_DUPFD_CLOEXEC`. Kandelo now selects the ordinary POSIX
implementation in the SDK; other wasm32 targets keep their existing behavior.
The patch participates in sysroot and package identity. Native 30-case CLI
validation and the normal wasm32 package build pass. The final combined
`preparer-descriptor-integrated-1031-035316-136f` run passes 18 Node cases
(guest preparer, frozen supported programs and SDK Rust fixtures) and all six
memory/OPFS offline browser cases in Chromium, Firefox and WebKit. Descriptor
output matches native optimized bytes and executes after journal reopen with
networking disabled. The initial Node Unsupported failure and two authored
patch-application/build failures remain separate receipts, not passing runs.
No automatic install/exec controller, package transaction or lazy-reference
upgrade acceptance is implied; the four release chunks remain unchecked.
The existing demo 57433 remains frozen and predates this preparer build.

The final `preparer-descriptor-final-native-1031-035737-26b4` run passes the
complete Rust workspace excluding xtask, all 839 xtask unit and eight
integration cases, ABI/supported-baseline checks, standalone resolver
reproducibility and the 652-file Vitest evidence inventory. ABI 55 and host
adapter 3 remain unchanged. This slice does not include the full product
rebuild, conformance, memory-switching, benchmark or WordPress package-upgrade
acceptance required by the combined release gate.

Before publication, the SDK patch's blank context line is removed using a
balanced two-line context hunk. A zero-fuzz application produces byte-identical
patched Rust source. The resulting current package identity is rebuilt and
all 18 Node plus six browser cases and ABI/baseline checks pass again in
`preparer-descriptor-sealed-integration-1031-040948-e962`.

**Preparation metadata (2026-10-31):** retained-source/original/output binding
now uses a bounded Rust scalar/index reader rather than the full signature,
name and descriptor catalog. Explicit metadata-byte and record-work quotas
cover retained indexes and replacement growth; recursive groups, compact
imports and nested type counts are charged before expansion. Type and table
initialization decoding does not build opaque type/control-stack collections.
The SDK ABI accessor uses metered constant/call wrappers rather than scanning
arbitrary nested control flow. Malformed bodies still require normal Wasm and
fork validation before any execution; this reader is not that complete gate.

Native allocation tests compare old full-catalog and new reader calls after
constructing their fixtures. Compact shared names observe peak requested
2,151,906 to 776 bytes; a repeated shared signature observes 6,683,113 to 3,080;
a 4 MiB custom section observes 4,194,399 to zero. These thread-local requested
allocation observations include conservative old/new overlap on realloc, not
RSS, kernel-wide memory, compiler bounds or app-startup timings. Failure
injection covers every valid-input catalog allocation. Fourteen reader cases,
13 preparation-plan cases and two real native-transform integrations pass in
the focused cohort, including the frozen programs, modern types, nested-table
and selected-marker cases. The preceding authored unavailable-reader-method
compile error and intermediate source runs are retained separately.

Read-only review identified a remaining diagnostic boundary: the dependency
parser constructs a small String/Box infallibly on malformed input. The private
native denial probe returns `InvalidModule` normally but aborts when diagnostic
allocation is denied (22-byte request, then 64-byte diagnostic, status 134).
Its intentional negative observation is not successful malformed-input ENOMEM
acceptance. The 4 KiB accounting allowance is not physical allocator capacity.
Diagnostic failure containment and aggregate compiler workspace remain open,
along with executable source/image ownership and trusted publication. The four
expanded release chunks remain unchecked; existing demos are unchanged.

The final `preparation-policy-metadata-final-1031-044547-86b6` run passes the
complete Rust workspace excluding xtask, including 3,117 runtime-core cases,
21 artifact unit, five marker and 14 bounded-reader cases; all 839 xtask unit
and eight integration cases pass. Portable Wasm checks pass for the artifact
reader and runtime core, alongside unchanged ABI 55/adapter 3, supported
baseline and resolver reproducibility. This slice adds no host FFI and runs
no new Node/browser, full products, conformance, memory-switching or benchmark
cohort; it is not acceptance of automatic execution or package upgrades.

**Executable ownership foundation (2026-10-31):** Rust now pairs retained raw
source and prepared-image handles in a kernel-global backing, rather than
giving each process a source edge that queued descriptor transfers could lose.
Procfs opens, duplicate/fork/transfer lifetimes and mapping-only pins retain
both constituents. Final release transfers at most two host-close effects to
the existing synchronous cleanup boundaries; neither a destructor nor a new
fallible close queue owns host I/O. Source permissions and deletion links stay
separate from image bytes, length and identity. Generation/metadata drift checks
do not authenticate the transform or replace sealed cache publication.

Fifteen focused native cases pass before the combined workspace run, including
admission rollback, source/image aliasing, failed-first-close ordering, source
read permissions, queued rights after sender removal, mapping-only final unpin,
and fork rollback. Independent read-only review found two lock-cleanup ordering
gaps: discarded queued identities and source identities released during forced
removal. Both are fixed and covered by regression tests. This is not enabled
automatic execution: source-authority normalization, paired `fexecve`, commit
revalidation and trusted helper/cache admission remain open. There is no new
pair-creation FFI or updated demo in this slice. The four release chunks remain
unchecked.

The final `executable-pair-native-portable-1031-052610-6660` cohort passes the
full Rust workspace excluding xtask, including all 3,134 runtime-core cases.
The Wasm kernel check includes the adapter's I/O-aware mapping release path;
ABI/supported-baseline admission and resolver reproducibility pass. The new
ownership model is still unexposed. These native and portable checks are not
acceptance of automatic preparation, conformance or a WordPress upgrade.

The normal SourceOnly kernel rebuild succeeds. The initial Node cohort has
31 passing cases but fails the guest-preparer setup because its selected
package projection is absent or has inconsistent canonical provenance; five
cases are skipped after that setup failure, and browsers do not run. The
failure remains recorded. Resolving the preparer through the normal package
path repairs the projection without source changes. The complete rerun
`executable-pair-node-browser-provisioned-1031-053612-af89` passes all 36 cases
in seven Node files and all six offline memory/OPFS preparation/reopen cases
in Chromium, Firefox and WebKit. This validates the existing execution paths
against the rebuilt kernel, not automatic paired execution or package upgrades.
No new full product/conformance/memory-switching/benchmark cohort or demo is
claimed; the four expanded release chunks remain open.

**Source/image exec binding (2026-10-31):** internal Rust conversion now keeps
the source-authority snapshot separate from image observations and length.
Saved-descriptor and procfs exec use live source permissions, ownership and
the retained source's mount, not synthetic image metadata or a reopened name.
The pair binds the exact retained source digest; it does not substitute the
raw-original reference's digest. Commit streams source hashes around image
comparison, then checks source metadata/generation, mount and image stamps.
Conversion replaces only the target-owned reference, leaving guest OFDs and
cursors intact; refusal preserves the original token and descriptions.

Eleven focused native cases pass, including unequal source/image lengths in
both directions, pointer width, opposite nosuid mounts, credential refresh and
drift, same-length corruption, allocation/receipt rollback, CLOEXEC, execute-only
`O_PATH`, saved A to exec B to unlink/replacement to saved-descriptor exec A,
and transferred/fork-inherited execution after sender exit. A mutable-host
fixture catches source changes during image reads despite unchanged timestamps.
Read-only review also found an image change during the trailing source hash;
its regression genuinely fails before the final-image-check fix and passes
afterward. These checks are not an immutable image seal or transform proof.

No pair-conversion FFI or automatic helper/cache controller is enabled yet.
Original access authorization, trusted bounded helper completion, cancellation,
immutable image custody and sealed publication remain required. Direct-source
preparation plans refuse paired targets rather than treating image bytes as
source bytes. This native state-machine evidence is not browser paired-exec,
conformance or real package-upgrade acceptance. Existing demos and all four
expanded release chunks remain unchanged/open.

The combined native cohort passes the Rust workspace excluding xtask,
including all 3,145 runtime-core cases, plus the Wasm kernel/adapter,
ABI/supported-baseline and standalone resolver checks. Program ABI 55 and
kernel-host adapter 3 are unchanged. The first full native run exposed a
data-only planning regression; explicit Source/Derived state fixes it without
weakening the existing test or requiring live descriptors for pure planning.

Normal fixture and canonical rootfs provisioning then exposed two build
integration gaps: twelve recipes selected a disabled fork policy in their
scripts without declaring it in output metadata, and browser dependency
inspection rejected the new optional `originalWasm` field. Declarations now
match the existing scripts, with revision bumps; resolver checks remain strict.
The browser consumer validates original paths, Unicode and artifact conflicts
without treating companions as executable imports. The new consistency case
and three existing consumer cases fail before the fixes. Read-only review
also caught missing lone-surrogate rejection; refusal cases now cover it.

The final product cohort rebuilds the canonical rootfs package and passes
80 cases in eleven Node/package files, followed by six offline memory/OPFS
cases in Chromium, Firefox and WebKit. Two pre-existing explicitly skipped
exact-shell proof cases remain unrun; they are not acceptance evidence.
Sealed-installer and resolver reproducibility checks pass. Initial stale-ABI,
missing-rootfs and policy/schema failures remain recorded separately from
the passing rerun. This does not rebuild every affected graphics/WordPress
product or replace full conformance, memory and real upgrade acceptance.
Evidence: `source-image-binding-final-native-1031-062229-ade1` and
`source-image-binding-package-integration-1031-073140-09aa`, with reports under
`.context/source-image-binding-package-reports/`. The frozen UI checkpoint
at port 57433 is unchanged.

**Original-aware preflight memo (2026-10-31):** the advisory artifact-closure
checker now asks the native resolver for the complete logical closure,
including retained-original companions, before memoizing successful reads.
Its version-2 memo records paths separately from metadata stamps, includes
permission/owner/ctime changes and refuses non-regular final paths. Old
advisory memos are discarded; saved computer formats and ABI are unchanged.
An executable stamp alone no longer permits reuse when a companion changes,
disappears, becomes writable or is replaced by a symlink. Eight regression
cases cover the memo boundary with a mocked resolver; seven fail against
the old checker and pass after the fix. Existing resolver and image-original
cases provide separate native-policy coverage. The four-file Node cohort
passes 160 cases with the same two pre-existing exact-shell proof skips.
This advisory optimization is not execution authority or proof that a trusted
transformer ran; fresh product resolution and upgrade validation remain
required. The whole local inventory still needs rebuilding: its separate
preflight run reports 23 coherent closures, 90 incomplete closures and five
unbuilt packages, exiting nonzero. Do not present that inventory as accepted.

Original-preparation integration is still in progress. The version-1 reference
codec now lives in the portable Rust artifact reader and is used by the native
preparer. The reader depends on the program ABI rather than kernel-host metadata;
its thread-slot export name remains unchanged through the shared re-export.
Read-only CLI inspection and byte-budgeted raw-original verification are available
for package integration. The 44-byte reference format is unchanged. All 103
focused artifact/preparer cases and 18 selected xtask cases pass, as do the
standalone Wasm `no_std` check, ABI/supported-baseline checks, and the actual
native builder's working-directory/stale-tool regression. Read-only review found
one missing CLI-mode conflict; its fix and all inspector combinations are covered.
Receipts: `.context/original-reference-integration-validation.log`,
`.context/original-reference-tool-closure-validation.log`, and
`.context/original-reference-reviewed-validation.log`. The updated guest recipe
declares and copies the narrowed artifact dependency, but its new products and
browser preparation have not been rebuilt or validated. At this codec-only
checkpoint, ordinary install/exec, immutable original companions, package
activation and lazy upgrades remained open; later delivery acceptance is above.
The frozen 57433 checkpoint is unchanged; it is not evidence for these new
preparer sources.

The producer integration introduced optional `[[outputs]].original_wasm`
declarations before the first image-delivery opt-in described below. They retain
the existing executable layout, change cache identity when authored and refuse
unsafe/overlapping paths. Resolver-owned output metadata avoids per-recipe
Cargo lookup in sealed installation. Transformation uses a private recipe
store even when a recipe instruments and renames its binary before calling
the installer. Nonfork originals are captured before compiler facts are
removed. Rust checks the output/reference/raw-content binding before companion
and executable publication; SourceOnly cache admission additionally checks the
complete receipt. Original files are not executable; unsafe existing store
modes and symlinks are refused rather than repaired. Read-only inspection does
not touch the recipe store and explicit store selection remains authoritative.

SourceOnly immutable companion publication is implemented, with the earlier
validation recorded below. At that checkpoint, Default/direct-mirror consumers
refused declarations instead of dropping companions or moving executable
paths. The first SourceOnly recipe/image proof is described below. Runtime-side
module companions, ordinary automatic exec preparation and
the transactional upgrade/lazy-binding work remain open. The frozen 57433
checkpoint has not been rebuilt for these changes. Final-source native checks
pass 823 xtask cases plus six integration cases and 107 artifact/preparer cases
in `original-producer-final-1030-232519-fedd`. That combined command then fails
the broader package-roots harness's pre-existing source-metadata audit for
`hyprland-protocols`, before reaching the installer checks. The same audit and
recipe are byte-identical on main `1a3ea3b9a`, and running the exact source
audit against a pristine archived main input tree reproduces the same failure
(`.context/main-source-metadata-validation-corrected.log`). This is not a clean
full shell-harness result.

The separate final-source `original-producer-shell-gates-1030-233126-9a3d` run
passes the new real installer, existing sealed/noninteractive/generation
installers, native builder working-directory/stale-tool regression, Wasm
`no_std` check and unchanged ABI/supported-baseline checks. The first broader
attempt's authored special-mode fixture failure remains recorded separately;
the corrected check covers all 4096 permission combinations directly and tests
actual writable/executable file refusal. These native producer checks are not
guest/browser preparation, immutable companion publication or upgrade acceptance.

The next native publication chunk preserves scalar executable paths while
adding generation-owned originals to canonical, materialized and aggregate
receipts. Companion generations publish before executable activation, are
reused only when equal and are never overwritten with different content.
Preparation streams files into owned stages; original modes retain only source
read bits. Directory ancestors are reopened without symlinks, staged directory
names and ancestor links are synced before publication, and original content
and ancestry are revalidated before executable namespace changes. Interrupted
activation may leave unselected originals but cannot acknowledge a dangling
executable. Earlier generations are retained.

The resolver derives an original's data-only role from its selected output
declaration and architecture/cache-key path, never from a caller-supplied role
flag. It validates complete owning closures including originals, uses bounded
hash buffers for uncaptured originals, charges explicit captures to snapshot
budgets and rejects original paths as executable outputs. The standalone
resolver bundle is regenerated from the same source. Focused checks pass
native publication/cache admission, normal SourceOnly store-to-projection
receipt equivalence, ancestor replacement/symlink and changed-original cuts,
plus 12 Node resolver cases including 2 MiB streaming and byte-budget checks.
Read-only review caught the missing ancestry/directory-sync checks and an
aggregate receipt-count caller; all three are corrected with regressions.
The final combined run `original-companion-final-1030-235310-c33a` passes all
831 xtask cases and six integration cases, ABI/supported-baseline admission,
standalone resolver bundle reproducibility and all 118 cases across the full
host/package resolver files. JSON/console receipts are under
`.context/original-companion-combined-reports/vitest.Wbnclc/`. The host-wide
typecheck remains failing: comparison with pushed producer head `e74728b51`
as the resolver source finds the same 40 diagnostics and no additions or
removals (`.context/original-companion-host-typecheck-comparison.log`). This
is not a passing typecheck. No production image or guest preparer was rebuilt
for this chunk; it is still not guest/browser exec, package upgrade or durable
lazy-reference acceptance. Checkpoint 57433 is unchanged.

The image-delivery chunk now registers selected originals through both shell
population paths, including when an imported image already contains the lazy
executable from an explicitly selected dependency. Imported programs owned only
by the base image stay with that producer rather than requiring undeclared
dependency lookups. Rust checks the entire executable container and its original
length/digest binding. The Node resolver pins the actual companion to the same
direct canonical generation or aggregate receipt as the executable, verifies
stable file identity/content and refuses writable/executable original modes.
Direct dependency lookup does not require an unrelated aggregate projection.
Declared originals with stripped references and references without selected
declarations both fail. Existing conflicting image entries remain unchanged.

`less` is the first opt-in recipe. Its normal two-node SourceOnly build succeeds
in `original-less-products-1031-003718-0bc3`. The actual output passes native
raw-original verification, lazy registration, idempotent registration, image
save/reload and the SourceOnly snapshot/asset collection path. The retained
original is 465,635 bytes; its lazy image metadata adds 12,288 bytes. Receipt:
`.context/original-less-image-validation.log`. This does not rebuild the full
shell or WordPress image and is not automatic execution. Manual direct-local installs,
runtime-side module originals, archive members without per-file digests and
base-rootfs delivery remain unfinished. Read-only review found and corrected a
stripped-reference omission; its negative regression is retained. The frozen
57433 demo remains unchanged.

Final image-source validation passes all 171 cases in the five complete
image/bridge/resolver files, without skips. The bridge proves selected-original
delivery beside an existing executable while preserving its source URI and
alias relationship; base-owned resident files do not trigger undeclared
lookups. Native checks pass 831 xtask cases plus six integration cases, 71 image
module cases and 21 artifact cases, Wasm `no_std`, ABI/baseline admission and
standalone resolver reproducibility. The combined run initially failed five
bridge cases on undeclared base dependencies; two later authored fixture
assumptions about exported inode IDs and the coreutils path were corrected.
An intervening run refused a changing source snapshot during index generation;
it was not accepted as a test pass. Those receipts remain separate from
`.context/original-image-final-source-reports/vitest.rtvzM2/`. The final host
compiler comparison still reports 40 diagnostics for both HEAD and current
source, none added or removed. This is not a passing typecheck or combined
release/browser acceptance.

Cache-backed Default publication now uses the same immutable original-generation
staging, directory synchronization and ownership checks before replacing ordinary
executable links. Both scalar and complete package-directory layouts retain
their existing names. Original content and ancestry are revalidated before
quarantine and activation; injected failures preserve the previous mirror.
Default asset lookup and image registration bind originals to the selected
executable's canonical generation. Expanded asset closures include originals
without changing ordinary member counts. Coherent requests deduplicate owning
executable lookups before mapping results back to request order. Reserved
original paths never fall back to literal files when the executable is missing.

The full native check passes 835 xtask plus six integration cases, unchanged
ABI/baseline admission and resolver bundle reproducibility. All 172 cases in
the five complete image/bridge/resolver files pass with no skips. Read-only
review caught duplicate translated requests and a missing-executable literal
fallback; both are fixed with regressions. The initial five-file run also
records a cold bridge timeout and a fixture using the wrong provenance tier;
an intermediate negative assertion expected the wrong validation message.
These failures are retained rather than presented as uninterrupted success.
The corrected host compiler comparison remains 40 diagnostics on both sources,
none added or removed; it is not a passing typecheck. Receipts:
`default-original-native-final-1031-011326-de28` and
`.context/default-original-final-reports/vitest.x4mAh9/`.

The actual Default `less` source build and cache-backed mirror publication also
pass through the normal resolver. Its real original passes native verification,
readonly companion-mirror comparison and image save/reload through the normal
direct-dependency binding (`.context/default-original-image-validation.log`).
Manual direct-local sessions remain refused: their session-specific originals
need complete staging rather than borrowing another generation's companions.
Runtime-side module originals, archive members without individual digests,
base-rootfs delivery, automatic install/exec and package/lazy upgrade transactions
remain open. No full guest/browser rebuild is implied; 57433 stays frozen.

The UI checkpoint at `http://127.0.0.1:57411/` passes 21 combined cases in
Chromium, Firefox, and WebKit. These cover session reuse/restart, confirmed
retention, independent boot logs, actual service state and shortcuts, and
WordPress/MariaDB post/media recovery without the source image or manual
checkpointing. Receipt: `services-checkpoint-accepted-browser-1030-141543-324a`.
This validates the UI checkpoint, not the unchecked upgrade work above.

The latest feedback checkpoint is `http://127.0.0.1:57429/`. It adds independent
SQLite/MariaDB data and uploads over one shared WordPress software tree,
typed-name deletion, a centered highlighted Temporary tag, and a stopped-service
warning immediately above the dock without discarding the preview. More now
calls its first action **Share setup…**, ahead of Services. Persistent image
write and verification use separate updating syslog rows; raw mode retains all
updates. Completion follows the codec's actual finalization, not merely a byte
counter reaching its total, and errors preserve the original exception.
Normal product rebuilding passes 175 nodes and 11 products. Actual Node tests
pass the three family cases and 22 command/configuration/program cases; nine
selected persistent Sortix cases pass strict post-test reboot. Source checks
pass 323 app cases and 205 focused host/session cases. Receipts:
`independent-sites-final-products-1030-173644-0a59`,
`independent-sites-final-node-1030-181117-c0b7`,
`independent-sites-final-node-contracts-1030-181229-69ec`, and
`independent-sites-persistent-posix-1030-181328-197e`.
All 27 browser cases pass across Chromium, Firefox and WebKit: nine progress,
retention and More-menu cases, then 18 independent-site, saved-computer,
service-warning and view-switching cases. Receipt:
`menu-feedback-browsers-1030-184450-ec84`. Both WordPress backends publish and
upload, switch without mixing site content, then recover after refresh without
checkpointing. Earlier attempts retain their fixture-readiness failures and
deliberate interruptions; the 57427 quick cohort also records a server-readiness
connection refusal. Those attempts are not complete browser acceptance.

Subsequent network-invitation feedback exposed a separate startup handoff bug:
managed-computer URL canonicalization removed the activity fragment before the
App reparsed it. Startup now carries its already-validated invitation into the
App instead. Connection failures take precedence over green join readiness;
generic RTC failure no longer claims a known routing cause. The negative
browser regression reproduces lost activity metadata against 57429. The new
checkpoint is `http://127.0.0.1:57431/`. Fifteen focused clipboard, invitation
validation, service-warning, menu and progress cases pass across all three
engines. The corrected managed-startup/failed-join regression also passes in
all three engines (`.context/invitation-feedback-final-regression.log`). Its
earlier failed runs retain the request-interception and ambiguous-selector
fixture errors; they are not reported as passing cohorts. The source checks
pass 326 app and 228 host/session/peer cases.
Ordinary peer transport is not established by these UI checks. The user
subsequently confirms installed Firefox/Chrome Doom and Quake joining after
permission changes and browser restarts, but also reports intermittent delay.
That observation does not establish the cause of earlier connection failures.

The integration batch is now rebased as one commit onto `1a3ea3b9a`, preserving
the earlier batches in backup references and leaving 57431 frozen. This includes
the 26 main commits through `5fedd5d0b` and the later test-reporting commit.
The rebase retains main's supervisor input, dock-unmount, offline-egress and
worker-entry ownership fixes alongside persistent file-backed boot. The ABI
check passes unchanged, as do 326 app checks, 367 focused host/session/catalog
checks and 18 source-stylesheet contrast cases across the three browser engines.
These do not prove a new deployed application bundle or rebuilt products.

Read-only review also found a stale Node `rootfsLazyAssetDirectory` guard that
accepted only an in-memory base. The positioned-image journal test now covers
both unset and configured lazy directories through initial write, strict reopen,
wrong-base refusal and restoration. The added option fails before the fix; both
cases pass afterward, with the other 95 cases excluded by this focused filter.
Receipts: `.context/rebased-release-positioned-before.log` and
`.context/rebased-release-positioned-after.log`. This is a Node input-option
admission fix; browser OPFS image admission does not use that Node option.
The first normal product rebuild was deliberately interrupted before changing
its source input. Its replacement succeeds at `0911a67bd`: 175/175 nodes,
75 cache hits, 100 built and 11/11 products in 2h38m. Receipt:
`rebased-release-products-fixed-1030-193109-95f2`. After the test-reporting rebase,
normal preparation succeeds at `b110ba070`: 175/175 nodes, 167 cache hits,
eight image builds and 11/11 products in 27m20s. All compiled programs remain
cached. Receipt: `rebased-reporting-products-1030-221159-f69c`.
Both runs include normal projection finalization and consumer admission, not
just successful compilation. ABI consistency and the unchanged program digest
also pass after this rebase, alongside the new report-wrapper checks.
The frozen Vite application build for `http://127.0.0.1:57433/` succeeds against
these current products. Its Firefox smoke passes WordPress/MariaDB boot,
independent boot logs, service stop/start, stopped-preview warnings, and
service-dependent shortcuts. Receipt:
`.context/rebased-release-checkpoint-smoke-corrected.log`. The first smoke
command selected no tests because its anchored filter did not match the full
test title; it is not a passing cohort or a product failure. Both reports remain
recorded separately. Combined runtime/browser release acceptance remains pending;
the older browser cohorts are not reruns of this bundle.

The exact Quake invitation passes activity admission, but an isolated installed
Chrome probe fails its peer connection before data transfer or game launch.
That does not establish a Quake-specific filesystem or transfer defect, or
explain the user's exact dialog error. An earlier manually transcribed probe
contained a wrong digest; its mismatch is discarded, not treated as product
evidence. Test-only connection controls also allow joining the actual Firefox
Quake server, but they are not production fixes or ordinary-browser acceptance.
The user's later successful retries and generic transfer follow-ups remain
separate from persistence acceptance. No production network behavior was changed
in this investigation, and build contention is not a proven cause.

Ordinary namespace/metadata writers now share recovery-compatible permission
validation, including special-node creation. Two new native regressions fail
before the guard and pass afterward; all 3,863 workspace/doc cases pass with
no failures or ignored cases. Unsupported set-ID mutations fail before writes
without stripping permissions or changing the namespace. Receipt:
`metadata-writer-safety-workspace-1030-173139-b1da`. The program ABI digest
remains unchanged. This native result does not establish updated application
or package-upgrade acceptance.

The ABI-55 baseline now rejects source-derived program-surface drift and stale
snapshots before normal build/stamp admission. Six frozen executables run
unchanged on Node and all three browser engines. The normal Rust preparer
package and guest Binaryen also prepare and regenerate a fork/shared-mapping
program with networking disabled in all three engines; generated bytes match
the native tool. Node adds missing/corrupt-original and input-budget refusal
without replacing existing output. Receipts:
`offline-preparer-bounded-proof-1030-143749-2f2d` and
`normal-guest-preparer-reviewed-node-1030-143522-1f7f`.
This is explicit CLI preparation in a real guest, not automatic install/exec
integration, a claim about arbitrarily large compiler inputs, or completion of
maintenance-mode package upgrades.

The reproducible, owned-server browser gate subsequently passes all six
memory/OPFS cases, including regenerating and executing a new output from
the retained original after journal reopen. Source-image requests remain at
one per case. Receipt:
`offline-preparer-persistent-final-proof-1030-150138-c185`. The runtime helpers
are initialized before each offline phase; this is not an offline cold-start
guarantee. The standalone WebKit automation probe and that distinction are
documented in the compatibility contract. The full xtask recheck passes 806
unit and six integration cases (`program-baseline-full-xtask-1030-143730-39a0`).

The rebuilt application checkpoint at `http://127.0.0.1:57419/` passes all 24
combined Chromium/Firefox/WebKit cases, adding normal shell lazy preparation
tool installation and reopen to the previous UI and WordPress/MariaDB checks.
Normal product preparation builds 175 nodes and 11 products; the ABI snapshot,
source-derived baseline and unchanged program digest checks pass. Receipts:
`offline-preparer-corrected-products-1030-144317-6322` and
`program-checkpoint-combined-browser-1030-151304-f7ed`. Older checkpoint origins
and saved computers remain untouched. Automatic preparation and transactional
package/lazy-reference upgrades remain unchecked above.

## Integration chronology

The [persistent-program compatibility contract](persistent-program-compatibility.md)
tracks the separately requested release-upgrade work: independent disk-format
versions, retained uninstrumented originals, and the concrete supported program
surface. The historical infrastructure acceptance below does not establish
cross-release executable compatibility or automatic instrumentation regeneration.

Dated integration and checkpoint notes retain the status of their original
receipts. The completion summary and final requirement reconciliation above
supersede their remaining-work wording; earlier failures are not rewritten
as successful runs.

**Integration receipt (2026-10-25, then not release-validated):** main
`7dfe4b501` advances to ABI 54 and moves more process waits into Rust.
The combined persistence contract therefore advances to ABI 55. The
merge preserves admitted executable references through fork, executable
attachment and procfs reads, alongside native wait retirement. ABI-matched
normal consumer setup, browser products and fifteen required SDK fixtures
now rebuild successfully. Checkpoint 1.38 serves these ABI-55 products;
checkpoint 1.37 remains available on its frozen ABI-54 artifacts. The user
reports that 1.37 works well, without identifying an engine or supplying a
timing measurement. All ABI-54 receipts below remain historical evidence,
not acceptance of this new combined tree.

The integrated ABI-55 source passes 3,722 Rust workspace tests without
failures or ignored cases. This includes executable-only inheritance,
descriptor aliases and executable-attachment refusal before publication.
The focused host lifecycle cohort passes 53 cases, including stale native
wait decisions after channel/process retirement and mailbox reuse. Those
host tests use genuine scratch fixtures, not built guest programs; they do
not establish ABI-matched Node or browser application acceptance.

The real Wasm ABI regeneration, standalone resolver checks and comparison
with ABI-54 main now pass, including all fifteen storage imports. The
source-ownership audit passes 97 cases without skips. An earlier xtask run
passes 785 cases and fails ten because it ran before snapshot regeneration;
the corrected rebuild regenerates the contract first and passes all 795
unit cases and six integration cases. Host declarations and the current
631-file Vitest evidence inventory also pass.

A bounded independent read-only review finds no concrete corruption defect
in native activation, recovery authority or the immediate host handoff. It
identifies missing coverage for acknowledged writes to the new target while
asynchronous predecessor retirement is still pending. Sixteen new cases
create and synchronize real native transactions, prove that the predecessor
does not contain the new marker, then recover the acknowledged target after
owner loss, retirement flush failure, close failure or concurrent shutdown.
They cover unsealed-source and obsolete-sealed-generation retirement under
both flush-only and write-through storage models. The complete crash-test
file passes all 26 cases. These modeled failures are not device power-loss
evidence or completion of the broader browser fault matrix.

Checkpoint 1.38 now passes all eighteen application cases without retries,
skips or failures: six SQLite/MariaDB visual-editor/post/upload cases, six
default-profile live/checkpoint mixed workloads, two constrained WebKit
workloads, three shell cases and one WebKit eight-reload maintenance case.
The mixed cases verify database updates, media deletion, 32 MiB of distinct
guest payload and 512 renamed directory entries after source-free recovery.
The previously failing WebKit installation, post-maintenance verification
and initial terminal paths pass in this ABI-55 cohort. This does not identify
the cause of the historical failures or establish arbitrary-load liveness.
The serialized large-image Node batch, browser fault matrix and complete
memory/lifecycle command now pass as detailed below. Matched main/candidate
benchmark acceptance remains unfinished. Current application observations and
their measurement boundaries are in the [ABI 55 acceptance record](measurements/2026-10-26-abi55-persistence-acceptance.md).
Receipts are under
`.context/persistence-main55-20261025/`. To make room, sixteen obsolete
automated OPFS capture payloads through checkpoint 1.33 were removed,
reclaiming 2.24 GiB of allocated files. Their text evidence and traces remain;
current failure captures, saved computers and serving demos are untouched.
A post-rebuild cache collection below ABI 55 removes another 557.0 MiB;
live roots and the collector's recent-use protection remain respected.

The first ABI-55 31-file Node cohort passes 538 cases and fails two, without
skips. Both failures expose an integration diagnostic regression: the shared
whole-file reader still refuses oversized results with `ENOMEM`, but its
new path/errno wrapper drops the captured allowance explanation. The wrapper
now retains both details. Twelve focused Node cases and six real-OPFS cases
across all three engines pass, including unchanged range reads, symlinks,
executable loading and journal recovery under both checking policies. The
full Node cohort is rechecked separately, not reported as initially passing.

The first browser release batch stops before runtime validation because its
private fixture receipt expects the earlier SDK-helper output, while normal
Vitest preparation legitimately rebuilds twelve fixtures using its own SDK
recipe and embedded source/toolchain fingerprint. The replacement receipt
verifies those twelve normal fingerprints and the three unchanged helper
artifacts, retaining exact hashes, sources and ABI checks. No compiler check
is relaxed and no stale binary is accepted. The corrected browser batch
proceeds through the ordinary memory gate and storage suites.

The full Node recheck has 539 passes and one product-preparation failure,
not a guest filesystem failure: normal browser preparation replaces its lamp
projection during the run and the resolver rejects the mismatched member
size. A separate fresh-process MariaDB mixed workload passes after
preparation settles, with current compiled-host fingerprints and unchanged
kernel, image-module, host-bundle and lamp hashes across that workload.
The final serialized cohort passes all 540 cases in 31 files, without skips.
All fifteen SDK fixtures retain their verified inputs and output hashes.
Current kernel, resident/positioned modules, lamp image and compiled host
bundles have unchanged hashes across this successful cohort. The final
ownership audit passes 97 cases; ABI and evidence-inventory checks pass.

Full persistent POSIX validation under SHA-256 passes 174 of 179 discovered
cases, with three existing expected failures and two unsupported scheduling
cases. CRC32C initially passes 173 with one source-projection preparation
failure before `sigwaitinfo/8-1` executes; all eight sigwaitinfo cases pass
after stable preparation. No signal implementation is changed. Strict
Sortix persistent-reboot filesystem validation passes 1,051 cases, with eight
existing expected failures and no failures, skips or timeouts. This selects
`basic`, `stdio`, `io` and `paths`, not the case-colliding include inventory.
The conformance wrapper still exits nonzero: its original CRC32C preparation
failure and five stale artifact-receipt comparisons are retained. Those
comparisons refer to two republished product images and three rebuilt host
bundles, not changed kernel/image modules. The stable full CRC32C run now
passes 174 cases with three existing expected failures and two unsupported
scheduling skips, matching the SHA-256 totals. Its current frozen kernel,
modules, lamp image and host-bundle audit passes before and after the suite.
The earlier nonzero conformance wrapper remains a separate receipt.

The initial full browser-memory command passes 236 host ownership cases,
three Node teardown cases and seven Bun cases. Chromium/WebKit complete
their four same-realm switching cycles, but Firefox's fixture stalls while
awaiting a transient Enable button already detached by audio activation.
The fixture now sends a trusted key through the production activation path
and retains its running-state assertion, deadlines, four cycles and realm
checks. Six browser helper regressions pass, including refusal of a sink
that stays suspended. The repaired complete memory command passes, including
all fifteen browser cases with no skips, retries or failures. All three
engines complete four same-document/audio-realm application-switch cycles
with actual consumers and unchanged ownership assertions. No forced garbage
collection, reload, autoplay bypass or forced teardown is introduced. The
initial eight-pass/one-failure browser receipt is retained separately.

Current native-process/capture browser validation passes all 63 cases.
OPFS storage/pressure passes all 114 across the three engines without retries
or skips, including both checking policies and demand-only reopen reads.
Compaction passes 90 cases plus three separately selected closed-orphan
cases. Authority/quota passes 74, with four explicit unsupported quota-manager
protocol cases on Firefox/WebKit; archive overlap passes six. Together with
native-process/capture and storage/pressure this is 350 passing cases and
four intentional platform skips, without flaky results. The old release
wrapper's failed initial memory run and stale host-bundle audit remain
nonzero receipts; the later frozen memory/Node wrapper exits successfully.
The positioned image-module native unit selection also passes all 75 cases.
Its initial non-`--lib` native invocation cannot link Wasm-only host imports
and is not reported as a successful cdylib build. The complete memory command
requires fifteen successful browser cases after adding the six activation
controls; its older nine-case floor must not admit missing new coverage.

The remaining performance prerequisite is a separately built ABI-54 main
checkout at `7dfe4b501`, compared with the ABI-55 candidate using each side's
own SDK, kernel and programs. Candidate MariaDB images for both architectures
and ten microbenchmark guests build normally. Main's first setup drains its
independent builds but refuses the shell product because its expected
prepared release `xtask` is absent. Explicit normal tool preparation repairs
that prerequisite and resumed setup succeeds. Baseline MariaDB benchmark
prerequisites continue through ordinary resolution, with no recipe edits,
stale-ABI restamping or omitted suites. No broad speedup/regression conclusion
is claimed.

**Main convergence (2026-10-25, release validation in progress):** main `f6b329f4d`
is merged with the existing implementation, preserving both histories.
Main now owns ABI 53
for extended attributes and Kandelo exchange; the combined persistence
contract therefore advances to ABI 54. The integration preserves exchange's
stream and permission semantics while using the bounded descriptor, FIFO,
and process-removal paths. Combined release acceptance remains outstanding;
the ABI-53 results below remain historical.

The complete ABI-54 setup, standalone guest fixtures and browser build now
pass. The current Vitest inventory contains 623 classified files. Checkpoint
1.35 passes all six WordPress SQLite/MariaDB visual-editor, post, upload and
source-free recovery cases across Chromium, Firefox and WebKit, without
retries or skips. Chromium exercises browser-process crash/relaunch; Firefox
and WebKit exercise reload. No explicit image checkpoint is used. This is
application acceptance, not the complete memory and crash-maintenance gate.

The first 26-file Node batch has 496 passes, three failures and two skips.
It includes physical >4 GiB export/reboot and >32 GiB allocation-ledger cases
under a 64 MiB kernel ceiling. One failure identifies boot-only runtime
directories leaking into generic image composition; the loaders now separate
those roles in Rust rather than changing the exact-namespace assertion.
The other two failures are the same-budget namespace fixture crossing its
intended 512-inode boundary after main adds three runtime directories. The
fixture now provisions those directories and includes them in that boundary,
retaining the same admission allowance and replacement/recovery checks.
The current-artifact rerun passes all 501 cases in those 26 files, without
failures or skips. Both CRC32C and SHA-256 high-word fixtures are explicitly
provisioned, alongside the raw >4 GiB and >32 GiB images. Their approximately
32 GiB container lengths use less than 512 MiB of allocated host disk each;
they are not 32 GiB of incompressible data. The repaired namespace checks
retain their original deadlines and admission allowances.

Checkpoint 1.36 contains these repairs and passes all six SQLite/MariaDB
visual-editor, post/upload and source-free recovery cases, all three shell
checkpoint/reload cases, and both constrained WebKit mixed workloads. The
default-profile mixed workload has five passes and one failure: WebKit
verifies the application after checkpoint and subsequent source-blocked
reload, but its subsequent terminal never produces a prompt. The captured
OPFS files, trace and kernel diagnostics are retained. A subsequent audit
finds that the diagnostic helper follows only v1–v5 manifests and therefore
omits the separate active v6 journal namespace; that capture is incomplete.
The helper and its real-OPFS regression now include v6, with revalidation
queued before the native-main application cohort. This is an open
application-liveness gate, not proven storage corruption or a runtime defect.
The site and native-artifact audits pass after the cohort. The current OPFS
storage/pressure cohort passes 114 cases. Authority, owner and quota coverage
passes 74, with four explicit unsupported quota-protocol cases on
Firefox/WebKit. The selected compaction cohort subsequently passes all 93
cases across the three engines, without retries or skips. Its two stale
assertions now preserve independent activation authority after index/seal
tampering and count the browser's actual TLS certificate data separately
from the test's 8192 blocks and held orphan. No production recovery checks
are relaxed. The initial failed receipts remain separate from that recheck.
Strict persistent-reboot Sortix coverage passes the same 70 selected cases
under each checking policy. The persistent POSIX selection passes eight
cases under each policy, with the same two existing expected failures per
run. Final ABI/inventory freshness, host declarations and the native-artifact
audit pass. Details, application-ready observations and the
distinct failed liveness probe are in the [ABI 54 acceptance record](measurements/2026-10-25-abi54-persistence-acceptance.md).

The combined source passes 3,630 Rust workspace cases, including 3,046
runtime-core cases, and 795 xtask cases, with no failures or ignored
cases. The positioned image-module feature separately passes 75 native
unit cases. Kernel checks, real Wasm ABI regeneration, standalone resolver
checks, the merged Vitest inventory and host declarations pass. The ABI
comparison preserves 262 main kernel exports unchanged, intentionally
changes `kernel_push_argv`, adds 23 exports and retains main's scheduled
promotion of process-exit publication to required at ABI 54. The built
kernel retains exchange's host import and all fifteen storage imports.
The full normal `setup --all` rebuild and guest-fixture rebuild pass after
the loader repair. Current-source selected browser and conformance evidence
does not close the remaining application-liveness and combined memory/
lifecycle release gates; the working demo alone does not complete the goal.

Main's exchange mount setup creates three real directories for an image
that omits them. Exact capacity tests now account for their blocks and
inodes. The checked persistent-image loader performs the same setup as
ordinary image loading; neither path silently omits the runtime mount
namespace. These are integration repairs, not a performance claim.

The requested lock-protected cache collection removed 23.0 GiB in its
old-ABI pass and another 986.2 MiB in its one-day pass. Active checkout
roots and the collector's recent-use floor remain protected. Saved
computers and frozen checkpoints were not modified. Receipts are in
`.context/persistence-main-20261025/`. A post-rebuild pass below ABI 54 with
the same one-day age rule removes another 6.3 GiB, approximately 30.3 GiB in
total across these passes. It retains 5.5 GiB of older-ABI SourceOnly builds
referenced by live roots, 17.2 GiB of recently used SourceOnly builds and
7.6 GiB of recently used ordinary-cache builds. The collector's live-root
and recent-use protections are not bypassed.

**Additional main integration (2026-10-25, revalidation in progress):** main advances
to `cbce65bcc` while the preceding cohort is validating. That native
instrumenter rewrite is now merged without rewriting either history. Main
remains ABI 53 and the combined persistence contract remains ABI 54. Three
reviewed manual WAT fixtures are updated to 54; the shared GC fixture bytes
are regenerated from their WAT source with the declared Rust parser. The
completed results above and checkpoint 1.36 remain evidence for `f6b329f4d`
plus persistence, not acceptance of the newer instrumenter and rebuilt
guests. Normal current-main rebuilding and combined revalidation follow.

The integrated native source passes 3,688 Rust workspace cases and 795
xtask cases, with no failures or ignored cases. The all-packages rebuild
then encounters a Waybar instrumentation refusal, `activation has no
ordinary call landings`, in the newly integrated instrumenter. That failed
receipt remains retained; it is not a passing full supported-package build.
Waybar is not demanded by the active browser products or their binary
imports. Validation therefore continues through normal `./run.sh setup`
consumer demand, followed by freshly built guest fixtures, Node, application,
native-process, persistent conformance and browser-memory acceptance. No
package is removed from the supported set and no instrumenter check is
bypassed. The normal consumer-demand setup subsequently passes. The broad
standalone-fixture build encounters the same instrumenter refusal in
`gtk3_smoke`; that failed build is not waived or described as passing.
The persistence and native-process fixtures are freshly compiled through
the existing SDK fixture builder and normal ABI stamping. The resulting
31-file Node cohort passes all 526 cases without skips. Expanded archive
coverage passes six browser cases across the three engines, exercising two
cached readers plus a third active reader under the unchanged 64 MiB kernel
ceiling. These independently bounded archive buffers remain outside the
shared I/O-credit pool, as recorded in the memory ledger below.

Checkpoint 1.37 is rebuilt with the native instrumenter and is serving while
application, native-process, conformance and browser-memory validation
continue. Its availability is not an application-acceptance claim. The
first source-memory inventory run rejects 45 newly introduced compiler
fixture/validator authorities. After exact ownership review, the next run
passes 96 cases but rejects one object-property origin lacking a recognized
binding. The audit now recognizes that property and propagates ownership
from the constructor expression itself; a focused regression verifies that
kernel writes through those properties remain visible and unbound origins
remain rejected. An independent read-only review finds no ownership erasure
and requests an inline-projection regression, which is included. The complete
two-file recheck passes all 98 cases without skips. Full repaired runtime
memory-gate acceptance is still outstanding.
Receipts for this integration are under
`.context/persistence-native-main-20261025/`.

The native-main default-profile mixed cohort passes five cases and fails
WebKit maintenance recovery: checkpoint and subsequent guest verification
succeed, but the next source-blocked reload displays nginx HTTP 502. Unlike
the earlier missing-prompt failure, the process inspector and diagnostic
terminal both answer. The two constrained WebKit cases pass. The separate
editor/post/upload cohort passes five cases and fails WebKit MariaDB at
initial installation, before any test mutation or recovery, also with HTTP
502. All three shell checkpoint/reload cases pass. These failures are not
attributed to storage corruption or an outside runtime.

The maintenance capture includes its active v6 journal, but the existing
640 MiB total capture budget omits the larger current base after collecting
the older base and journals. It remains an incomplete computer archive.
The diagnostic planner now allows at most 1 GiB of downloaded files and
explicitly lists every omitted file and its reason; it does not guarantee
complete captures of arbitrary image sizes. An attempted diagnostic sudo
read does not obtain private logs: upstream sudo first waits on its terminal
unless given `-S`, and the image then denies the demo account. The replacement
collector uses the existing read-only Internals VFS inspector without changing
guest accounts or permissions. A private in-memory control verifies that
inspector path, a visible terminal and 24 HTTP requests; it does not reproduce
or clear the failures above. The repeated WebKit turnover case subsequently
fails waiting for its initial terminal prompt, before guest mutations,
checkpointing or any of its eight planned recoveries. Its inspector displays
`Loading…`; this is distinct from the responsive HTTP-502 capture above.
Its bounded capture plan omits no inventory files. This does not establish a
quiescent snapshot or identify the blocked kernel operation. Full runtime
memory/lifecycle acceptance and HTTP failure attribution remain open.

The selected native-main persistent conformance cohort passes all 70 Sortix
cases under each checking policy, and eight POSIX fsync/munmap cases per
policy with the same two expected failures. The 625-file Vitest inventory,
host declarations and final frozen/native artifact audits pass. Final ABI
comparison correctly fails because the shared `origin/main` advances during
this run to `7dfe4b501`, which already uses ABI 54 for its Rust-owned wait,
futex, pipe and exit-channel contracts. This batch's internally consistent
ABI-54 artifacts are not acceptance against that newer main.

**Next convergence (2026-10-25):** integrate those main changes and move the
combined persistence contract to ABI 55 before further application diagnosis.
Checkpoint 1.37 and saved computers remain untouched. The queued broader
conformance and browser-memory jobs are intentionally stopped before their
tests begin, rather than spending another full validation batch on the older
integration. The old observer is stopped before its browser tests too. Their
termination receipts are not runtime test failures or passes. These suites
remain required after the integrated source is repaired and frozen.

**Previous main convergence (2026-10-24):** the implementation
has been committed and rebased onto main `f3cb7041f` (ABI 52), including its
runtime lifecycle fixes. The combined source preserves main's epoll, KMS
cursor, multicast, futex-deadline and heap-safepoint contracts. Browser audio
retains main's independent PCM mirror while adding demand-driven activation
and bounded retirement; audio-only quarantine does not block independent
kernel or storage handoff. The merged persistence implementation requires
ABI 53, including its required host storage imports and changed
`kernel_push_argv` result. Older ABI-51
checkpoint receipts below remain historical evidence, not validation of the
rebased build. No final ABI-53 acceptance is claimed yet.

Post-rebase scoped validation passes 3,541 Rust workspace cases (excluding
xtask), including 2,959 runtime-core cases, and 791 xtask cases. Host
declarations and 259 lifecycle/audio/storage-owner cases pass. Nine real
audio lifecycle cases pass across Chromium, Firefox and WebKit, without
retries or skips. ABI 53 regeneration, snapshot/resolver freshness and the
runtime-workaround registry checks pass. An explicit comparison preserves
241 existing main kernel exports unchanged, intentionally changes only
`kernel_push_argv`'s result, and admits 23 new exports; the built kernel has
all 15 required positioned-storage imports. The no-std Wasm build required
restoring main's production `Vec` import for peer-process enumeration.
The protected exact-ABI source runner validates its inventory and import
closures, then finishes its shared phase with 3,847 passing cases and two
failing SDL package assertions. Both the assertions and package sources
match main byte-for-byte; no unrelated package repair is included. Its
resource-isolated phase is not reached after those failures. Tests that
consume `exec-child.wasm` or run production vfork now correctly require
prepared products rather than claiming source-only evidence from stale
ABI-51 fixtures. A separate 99-case recheck passes the export-failure and
scratch audits, readiness deadlines, image-read helper and browser host
contracts after integration repairs; it overlaps the earlier host run.
These are integration checks, not a rebuilt WordPress/MariaDB or full
filesystem/conformance acceptance. Current guest/image rebuilds and the
remaining acceptance gates stay open. The rebase also keeps
main's newer epoll allocation model; the unrelated whole-system admission
audit is recorded in [future work](future-improvements.md#finish-general-resource-admission-and-lifecycle-hardening).

**Checkpoint 1.34 source candidate (2026-10-23, validation in progress):**
image-module metadata now uses an allocation-free Rust probe/copy and the
host's shared per-realm image-JSON admission pool. Native image-option changes
reserve metadata before publishing capacity or timestamps. Host decoding
failure after image adoption no longer frees the native-owned input; later
option changes and archive registration recover the loaded image's actual
state. The archive-ID regression fails before the repair and passes afterward.
The focused bridge/budget run passes 121 cases, with the separately provisioned
32-GiB case skipped in that run. Final acceptance explicitly provisions it.
Real OPFS compaction tests now inject a persisted partial journal, index or
seal write, return an error, and interrupt before cleanup can remove that
evidence. All 36 rebuilt three-engine partial-write/full-flush crash cases
pass without retries or skips. The 1.33 receipts below describe that frozen
checkpoint, not acceptance of these newer source changes.

The rebuilt 1.34 application cohort passes Node MariaDB, four shell cases,
six editor/post/media cases, six mixed workloads, and a Chromium case with
eight same-computer source-free reopens. Both constrained WebKit cases fail;
one stalls before the first terminal command, without evidence establishing
OOM or storage corruption. That remains a release blocker, not a skip.
Public 1.34 persistence is also confirmed by the user. Their reported
post-reopen slowness now has a [dedicated measurement](measurements/2026-10-23-wordpress-persisted-navigation.md):
Firefox navigation varies and repeatedly reads an already observed base
working set. Four timing/diagnostic cases pass with frozen-source audits.
These observations do not establish a cache optimization or close the
remaining crash-safety, conformance and release gates.

The earlier release Node cohort finishes with 458 passing cases and 14 timeouts across
four files, without skips or retries. Twelve exceed their 5-second deadlines;
the uncompressed deferred-archive and capacity/inode/checkpoint cases exceed
120 seconds. All four opt-in greater-than-32-GiB raw/checked-base cases pass;
the raw dense/near-dense cases stay under the 64-MiB kernel ceiling. Those
scoped successes do not waive the timeouts. Browser authority, demand-read and
pressure validation passes: 36 authority, 24 demand-read and six pressure
cases across all three engines. The original separate refusal cohort has no
result file and is not counted as passing; its three engine cases subsequently
pass in the real-OPFS shutdown/reopen cohort below. Persistent conformance passes 70 Sortix
cases and eight POSIX cases with two existing expected failures. ABI comparison
against the newer main fails because this branch lacks its newer contracts;
main convergence remains required rather than bypassing that check.
The [seeded bounded-cache comparison](measurements/2026-10-23-wordpress-persisted-navigation.md#seeded-cache-comparison)
completes four cases on frozen 1.34 artifacts. A larger cache approximately
halves repeat media-view base reads, with a modest observed navigation benefit
and no established boot benefit. Production cache defaults remain unchanged.

A focused successor run rechecks all 14 timed-out cases with their unchanged
deadlines: all 14 pass, with source and native-artifact audits passing. The
uncompressed archive case takes 10.64 seconds and the capacity/inode/checkpoint
case takes 54.80 seconds, each below its existing 120-second deadline. The
other twelve finish within their original five-second deadlines. This
name-filtered run is not a passing replacement for the complete release
cohort; its other 300 collected cases are filtered out. The subsequent combined
15-file Node revalidation passes 467 cases with zero failures at the original
deadlines, with source and native-artifact audits passing afterward. Five
opt-in large-fixture cases are skipped in that default-scope run: near-dense
export planning, dense and near-dense kernel recovery, and CRC32C/SHA-256
high-word recovery. All five passed in the earlier provisioned cohort; those
receipts remain separate rather than claiming a single new all-enabled run.
This clears the previously failing default Node cases, not main compatibility
or the remaining constrained application acceptance gate.

Retained constrained-WebKit evidence places the second failure after optional
checkpoint reboot, not initial installation: the rebooted guest readiness
request succeeds, then preview navigation returns static host HTML after
about 70 seconds and starts a nested bare-shell app. The trace does not prove
why service-worker interception was bypassed or that the navigation reached
the kernel. A subsequent private, bounded worker/service-worker correlation
probe passes the constrained WebKit live workload but fails the maintenance
workload later, during source-blocked guest verification after checkpoint
verification has already passed. Its final observations show native OPFS and
kernel calls completed, while the worker remains inside synchronous native
`WebAssembly.Memory` construction and stops answering independent echo
messages. The constructor descriptor and native stack are not captured, so
this is not evidence of a particular allocation size, an OOM exception or
filesystem corruption. Service-worker diagnostic queries time out in both
healthy and failed cases and cannot establish routing failure. See the
[construction investigation](measurements/2026-10-23-webkit-memory-construction.md#constrained-134-followup).
Separate regressions reproduce outstanding filesystem/HTTP promises
being dropped by shutdown on both hosts, and retired bridge handlers still
forwarding requests. The source successor now fences new requests, rejects
outstanding replies after realm shutdown, and refuses retired bridge entry.
Both-host proxy tests and a real Node persistence shutdown/reopen regression
pass. The real-OPFS shutdown/reopen regression and native exec-refusal/retry
case also pass in all three engines (six cases, no retries or skips), with
source and native-artifact audits passing afterward. These repairs are not a proven
cause or repair of either constrained-WebKit failure. They do not change the
frozen 1.34 site or native artifacts used by the performance/liveness probes;
the three corresponding original source files are preserved with verified
hashes. Final live-source checks for those older probes therefore report the
known divergence, not a successful rebuilt-source audit.

**Checkpoint 1.33 (2026-10-23, scoped acceptance):** controlled tests now
reproduce WebKit reservation refusal without OPFS in the disposable allocation
factory. Smaller ceilings postpone that failure. A private control against
the unchanged 1.32 site using canonical owner allocation passes both real
WebKit WordPress/MariaDB mixed workloads. A separate read-only ownership review
supports that minimal candidate while retaining synchronous fork snapshots,
creator admission, exact-generation retirement, and close-before-drain shutdown.

The current browser entry therefore uses the same canonical native allocator
path as Node instead of selecting the disposable factory. The unsafe
exhaustion-triggered owner fallback remains removed. Native constructor
`RangeError` maps to `ENOMEM` rather than exec `EIO`, preserving its cause and
releasing failed pending credits. The normal build passes 120 Node cases in
ten files, host declarations, ABI 51 checks and the frozen frontend build.
The three native artifacts are unchanged from 1.31. The rebuilt integrated
cohort passes the real Node MariaDB workload, 18 browser allocation/churn
cases, all six three-engine editor/post/upload/recovery cases, all six
three-engine mixed live/maintenance workloads, and both WebKit mixed workloads
using constrained-profile URLs. The six churn cases complete 600 fork/exec
cycles across two ceilings and three engines. There are no retries or skips;
source, native-artifact, frozen-site and test-source audits pass afterward.
These are frozen-1.33 application results, not just the private control.
Constrained desktop testing is not physical-phone acceptance. This does not
explain the older intermittent Chromium readiness failure or complete the
remaining release/conformance audit. Native calls can still pause
their owning worker, and outer-worker termination does not prove a successful
persistence shutdown. See the [construction controls](measurements/2026-10-23-webkit-memory-construction.md).

**Checkpoint 1.31 (2026-10-23, acceptance incomplete):** initial source
staging now uses bounded decompression and Rust SHA-256 in a disposable
worker. Composition verifies the staged source with Rust before parsing;
uncertain worker/handle closure retains ownership rather than deleting the
source. CRC32C remains the checked filesystem's default policy, independently
of the stronger installation-source binding. The following 1.30 proposal to
replace JavaScript staging hashes is implemented, not remaining work.

All 51 source-intake browser cases and six WordPress editor/post/media/reopen
cases pass across Chromium, Firefox and WebKit. A separate sequential desktop
diagnostic records these application-ready times:

| Engine | First persistent startup | Ordinary reopen | In-memory reload |
| --- | ---: | ---: | ---: |
| Chromium | 21.34 s | 15.01 s | 14.57 s |
| Firefox | 26.75 s | 15.81 s | 14.88 s |
| WebKit | 23.73 s | 15.24 s | 14.87 s |

These are not alternating baseline/candidate measurements or mobile results;
the user reports at most a modest perceived improvement. Initial installation
still makes whole-source passes. Ordinary reopen neither restages nor rewrites
the base. The larger WebKit application workload intermittently stops servicing
kernel-worker messages after completed native filesystem calls. Private
bounded instrumentation subsequently places a reproduced stall inside the
final synchronous kernel-realm memory-construction retry, after its disposable
worker reports constructor exhaustion. The source candidate removes that
fallback and preserves refusal through existing process-launch rollback.
The 29 allocator/factory Node cases and nine real-browser allocation,
fork-snapshot and refusal/recovery cases pass, with no browser retries or
skips. These narrow results do not establish sustained application success
under native reservation pressure. This failed stress cohort and the earlier
Chromium post-checkpoint readiness failure remain open acceptance gates.

**Checkpoint 1.30 workload extension (2026-10-22, in progress):** the user
confirms that the live MariaDB computer works and feels better, while initial
persistent-image creation remains slow. The extended automated workload now
separates live journal recovery from optional image maintenance, writes four
independent 8 MiB guest files plus 512 names, and verifies all payload hashes,
SQL updates, media deletion, links, modes and source-free recovery. It records
phase times and checks native filesystem admission reports.

The first Chromium live case passes without an image checkpoint: the observed
32 MiB write/sync phase takes 5.4 seconds and source-blocked application reopen
takes 16.5 seconds. These are desktop observations, not matched speedups or
mobile acceptance. The subsequent maintenance case completes its image
checkpoint and verifies its contents, but its further reload fails to reach
application readiness within the existing deadline. Its kernel mounts the
saved image; MariaDB readiness does not complete. The cause is not established
and this is an open acceptance failure, not a successful maintenance cohort.
An earlier memory-report parser failure was a terminal-text transport fixture
issue and is retained separately. Node application and three-engine boot/read
diagnostics are being refreshed against the unchanged frozen products.

The completed boot diagnostic passes all 18 phases on Chromium, Firefox and
WebKit without source fetches on reopen, retries or skips. It distinguishes
codec progress durations from application readiness:

| Engine | First persistent startup | Ordinary reopen | Codec write phase | Codec readback phase |
| --- | ---: | ---: | ---: | ---: |
| Chromium | 26.0 s | 15.0 s | 1.34 s | 0.73 s |
| Firefox | 30.7 s | 15.8 s | 1.82 s | 0.90 s |
| WebKit | 24.4 s | 16.5 s | 1.86 s | 0.79 s |

These are sequential desktop observations of the same frozen product, not
matched improvements over main or physical-phone results. Codec phase times
include their progress protocol and are not standalone OPFS benchmarks.
Reopen emits no image-write or full-image-readback codec phase. The observer
counts actual positioned reads only for kernel handles; main-document
`File.slice` attempts are separate, and neither covers composer/codec I/O.
Application-demand read totals alone cannot establish a whole-image scan.

For initial installation, source inspection identifies two decoded staging
image SHA-256 passes in JavaScript: `stageRawVfsSourceImage` hashes while
writing, and `OpfsImageReader.open` verifies that digest before composition.
This is separate from checked-base verification on ordinary reopen. The next
installation investigation should measure staging/decompression and composer
admission independently, then reuse Rust checked-image intake where practical.
Removing duplicate host hashing must retain stored-byte checking and exclusive
source ownership. A small bounded producer/writer pipeline is preferable to
unbounded prefetch; parallel writers are not yet a demonstrated bottleneck or
an accepted optimization. No measured speedup is claimed for these proposals.

The completed live workload cohort passes all three engines without retries,
skips or source requests on reopen. The Node counterpart also passes against
the real MariaDB product, with 32 MiB write/hash verification, SQL/post/media
recovery, native memory reports and no image checkpoint; it deletes its raw
import/configured source files before reopening the checked base and journal.
Its ordinary reopen observation is 14.1 seconds. Its fresh-image memory
baseline is not a matched warmed-database comparison, and checked-image
preparation is measured separately. Both application cohorts keep modeled
admission credits distinct from actual process memory. Browser process-tree
RSS is sampled separately and can double-count shared mappings.

The maintenance case subsequently passes in an isolated Chromium run under
the same deadlines, but no production code changed between those outcomes.
That result does not establish a cause or close the earlier readiness failure.
Optional positioned-image unit tests pass all 74 cases; xtask passes its 714
unit cases and six integration cases. The initial optional-feature command
also attempted a native shared-library link against Wasm-only imports and
failed before tests; the accepted followup explicitly selects `--lib`.
The first Node application fixture selected an unrelated HTML nonce; selecting
the REST nonce corrects its 403 without changing filesystem behavior. These
failed receipts remain separate from accepted results. Scoped typechecking
still encounters existing transitive WebGL and absolute browser-fixture-import
diagnostics, so this is not a clean full typecheck claim.

**Live-filesystem checkpoint 1.30 (2026-10-22):** generation authority,
ordering/ambiguity, source relationships, and reuse/retirement/target eligibility
now execute in Rust using fixed 88–328-byte control requests. Unknown generation
zero is not treated as an old verified generation. Reclaiming an unpublished
slot requires actual current activation matching the selected full identity,
a verified protected predecessor, and exclusion of both protected filenames.
Compaction skips a next-ring slot occupied by that predecessor; interrupted
retirement can retry without weakening this rule. Boot cleanup holds its
metadata scope and closes controls last, retaining uncertain ownership and
refusing subsequent storage admission. Host responsibilities and intentionally
retained scheduling/placement requests are described in the durability contract.

The normal ABI 51 products, host declarations and frozen site are rebuilt;
the native control capability is 2, while persisted envelope 6 is unchanged.
The Rust workspace excluding xtask passes, including 2,917 runtime-core tests.
Targeted policy/fault coverage passes 219 host checks. The larger 13-file Node
cohort passes 346 checks with four explicit large-fixture opt-in skips; that
receipt retains its skip count. A separate opt-in cohort subsequently passes
all 13 cases in its two files, including those four cases, without skips.
Dense and near-dense files above 32 GiB mount and recover under a configured
64 MiB kernel ceiling. The two checked-image policies also read high-word
offsets and recover guest tail writes against sparse host files of about
32 GiB physical length; grown kernel memory is 229/182 pages under their
configured 768 MiB ceiling, not a 64 MiB reservation claim. Each fixture uses
less than 512 MiB of actual host disk allocation. These fixtures do not
represent 32 GiB of incompressible payload. Fixture identity, size, allocated
blocks and modification time remain unchanged after the run.
All three browser engines pass 15 real OPFS HTTP/boot-ownership/checked-pressure
cases, three positioned-composer cases and six SQLite/MariaDB visual-editor,
post/upload, original-media-URL and source-free recovery cases. There are no
retries or skips in these accepted browser cases. Selected persistent
conformance again passes 64 strict-reboot Sortix cases and eight POSIX cases
with two expected failures. Source, artifact, frozen-site and selected test
audits pass after validation. These are scoped cohorts, not the complete
release suite or a performance improvement claim.

**Live-filesystem checkpoint 1.29 (2026-10-22):** the reported Firefox
asset failures on checkpoint 1.26 were reproduced with approximately 100
concurrent requests competing for ordinary kernel I/O admission. Checkpoint
1.28 bounds shared Node/browser HTTP admission; 1.29 additionally retires
timed-out unaccepted native connections by their recorded identity. Guest
endpoints already transferred by `accept` remain guest-owned. Deferred
retirement cannot report completion before native cleanup runs, and fatal
kernel revocation rejects outstanding pumps. No I/O ceiling was raised and
no `ENOMEM` retry was introduced.

The normal ABI 51 products and frozen browser site are rebuilt. Acceptance
passes 2,908 runtime-core tests, 30 HTTP/Node checks, eight scratch-contract
checks, three real OPFS timeout/accept-wins cases and all six SQLite/MariaDB
visual-editor, post/upload, original embedded-media and source-denied recovery
cases across Chromium, Firefox and WebKit. The application cases take no
image checkpoints. A separate five-file storage/seal/activation/compaction
matrix passes 198 checks. The new native timeout test fails against the
previous published kernel and succeeds after rebuilding; failed fixture
assertion/API experiments are retained separately rather than counted as
successful tests. Six additional production-boot integration cases pass on
all three engines: supersede a real boot, reject its route barrier and prove
native runtime-lease retention through blocked reboot/checkpoint until page
close; the control holds a real native route lock and proves orderly successor
progress only after release. Refreshed persistent conformance passes 64
selected Sortix cases with strict post-test reboot and state comparison;
the persistent POSIX `fsync`/`munmap` selection adds eight passes and two
expected failures. Source/native/test audits pass after that cohort. This
is not the full persistent conformance inventory. These results do not
establish the remaining performance, responsibility and production-release
gates. A targeted test typecheck has no diagnostics in the new ownership
tests, but still reports existing transitive errors in `host/src/webgl/query.ts`
and the session terminal-program path; it is not a clean full typecheck.

**Live-filesystem priority (2026-10-22):** ordinary mounted filesystem
operations, not full-image snapshots, are the primary persistence workflow.
The acceptance demonstration is WordPress/MariaDB publishing a post and
uploading media, then reopening the same computer without clicking
"Checkpoint image" or fetching the installation image. Successful guest sync
must commit through the journal; unsynced data retains the documented crash
boundary. Reopen should admit metadata, recover the journal and populate
bounded caches on demand, not copy, decompress or rewrite the base. Full-image
checkpoints remain optional and their latency must not be confused with the
cost or requirements of saving ordinary files. Existing application evidence
that checkpoints before restart does not establish this primary workflow.

**Live filesystem checkpoint 1.25 (2026-10-22):** the bounded Rust index
cache passes the complete workspace cohort, including 2,900 runtime-core
tests, 69 resident-image and 74 positioned-image tests; ABI remains 51.
The rebuilt normal shell/WordPress/MariaDB products and frozen browser site
are available. Six SQLite/MariaDB application cases pass on Chromium,
Firefox and WebKit with no skips or retries. They now publish through the
actual visual editor, upload PNG bytes, recover both without an image
checkpoint or source-image request, log in again and verify parsed editor
styles and the visual canvas. Chromium uses a browser-process crash/relaunch;
Firefox and WebKit use page reload. A separate guest-bridge regression passes
all three engines after restoring Firefox's missing native user-agent header.
The user's earlier intermittent unstyled editor still has no established
cause; the bridge fix addresses a separate visual-editing capability defect.

The integrated Node cohort passes 236 checks with four explicit large-fixture
skips. Followup runs against the actual shipped kernel pass 228 checks,
including the current dense and near-dense 32 GiB fixtures under a 64 MiB
kernel ceiling, then 14 corrected canonical-kernel checks and all six browser
pressure cases. The first shipped-kernel run also had four suite-load errors
from an invalid binary-resolver key; those four suites are the corrected
14-check followup, not silently counted as passing in the original run.
The original build's final source audit correctly refuses an editor test helper
changed while building. A subsequent web rebuild verifies that native/product
inputs are unchanged except the three recorded browser source/test files,
rebuilds the site with the user-agent fix, and checks all current source,
native-artifact and frozen-site hashes before and after application validation.
This is a split native/web build with explicit input verification, not a clean
single-run build claim.

**Live filesystem checkpoint 1.26 (2026-10-22):** user testing found that
saved media embedded in post content retains an ephemeral computer URL.
After reload the HTTP bridge prepends the new computer prefix to the old
one, breaking images even though their bytes survive in OPFS. A real GIF
upload/publish/reload reproduces the exact doubled prefix. The earlier
application test reconstructed a fresh media URL and therefore did not
exercise saved embedded URLs. The rebuilt browser candidate now separates
persistent computer web identity from fresh per-boot cookie sessions and
preserves explicit links to other computers. All six SQLite/MariaDB cases
pass on Chromium, Firefox and WebKit without skips or retries: publish in the
visual editor, upload PNG, embed its original returned URL, crash/reload with
the installation source disabled, and verify the same public prefix, original
image URL, decoded image dimensions, exact bytes and reopened visual editor.
No image checkpoint is taken. A separate native-dialog public MariaDB GIF
reproduction also passes with identical pre/post-refresh prefixes.

The web-only rebuild preserves checkpoint 1.25's accepted native artifacts
and ABI 51. Validation also passes 24 Node lifecycle/bridge checks and 12
native routing cases across the three engines, including a paused cookie
write followed by offline cleanup. Existing service-worker regressions pass
79 cases with 14 explicit Firefox/WebKit skips of Chromium-only CDP restart
tests. Independent read-only review found three lifecycle/URL defects that
were corrected before final validation. At that checkpoint, superseded-boot
plus failed route-barrier integration still had only helper/source evidence;
checkpoint 1.29 subsequently adds the six real production-owner browser cases
described above, including native lease retention and the native barrier control.
Checkpoint 1.25 remains unchanged. Previously saved temporary-name URLs are
not migrated or blindly rebound to another computer; the fix applies to
new persistent computer addresses, not arbitrary historical prototype links.

The read diagnostic passes all three engines and all 18 phases. Ordinary
automatic-cache reopen-to-first-response is 15.5/15.8/15.1 seconds; sequential
in-memory reload is 15.1/15.4/15.2 seconds. Later indexed-reopen diagnostic
observations compare the same explicit 64-data/8-base-index-page override in
both versions; the new supplemental journal-index cache is separate:

| Engine | 1.24 index bytes read | 1.25 index bytes read | All observed reads, 1.24 → 1.25 |
| --- | ---: | ---: | ---: |
| Chromium | 1,175.6 MB | 174.4 MB | 1,415.3 → 414.0 MB |
| Firefox | 1,175.7 MB | 174.4 MB | 1,415.7 → 414.2 MB |
| WebKit | 1,175.5 MB | 174.4 MB | 1,415.3 → 413.9 MB |

These are decimal MB and sequential desktop diagnostic observations against
an earlier checkpoint, not a controlled comparison with main, a mobile result
or evidence of a large application startup speedup. Base requests remain at
most 64 KiB. Host coordinator reads are outside this kernel-handle observer.
The remaining 174.4 MB of index reads, whole-prefix/index verification and
namespace reconstruction still require investigation; fast capacity-independent
indexed boot and the broader release gates are not complete.

**Recovery safety status:** the source candidate uses prepared/active version
6 image bindings to prevent the cross-base rollback reproduced by the earlier
guest regression; see the freshness followup below. This is not complete
arbitrary-corruption protection. The integrated activation-control candidate
now refuses stale-generation fallback after damage to an activated seal,
index or committed journal. Checkpoint 1.20's frozen integration cohort passes
the Firefox media-library upload and WebKit mixed-workload cases that failed
in 1.19, alongside the other application checks. This is scoped acceptance,
not proof that every earlier intermittent failure has an established cause.
These prototypes must not
be used for irreplaceable data. Bounded caches and a version 6 image envelope
alone do not establish complete recovery freshness.

**Checking-policy decision (2026-10-21):** newly created persistent computers
default to CRC32C; SHA-256 is opt-in. Existing computers and checkpoint
replacements preserve the recorded policy. The Rust format/writer API still
requires an explicit policy from its caller. CRC32C detects accidental damage
but does not cryptographically bind payload content to the header identity.

**Snapshot pressure followup (2026-10-22):** the latest native seal/activation
cohort passes 2,859 runtime-core tests, 277 Node checks and 60 browser checks.
The separate aggregate-pressure refresh is not green: Node passes four
checks and five of six browser cases pass, but Firefox with SHA-256 exceeds
the unchanged ten-minute deadline. An isolated repeat confirms the timeout;
its raw snapshot export takes about 472 seconds, before checked-image
encoding. A physical-read diagnostic against the unchanged kernel confirms
7,084,331,008 base bytes read to emit a 115,482,644-byte snapshot. The candidate
now shares a bounded inode/pointer cursor across
export's small base reads, retains useful authenticated leaves after consuming
an index parent, and avoids building the container's structural plan twice.
All 12 refreshed browser pressure/normal-reopen checks pass on Chromium,
Firefox and WebKit, without skips, retries or a deadline increase. All six
pressure cases stay at 221 kernel pages under the 1,024-page ceiling. Four
new native regressions pass, including exact journal edits and hardlinks in a
double-indirect export. The final native executable passes all 2,863 tests;
source, ABI and artifact hashes remain unchanged across acceptance. The initial
Node cohort has 110 passes, two five-second timeouts and one intentional
optional-large-image skip. Both timed-out cases subsequently pass together
under their original deadlines in an isolated followup, with every assertion
retained. This is not a clean single-run Node cohort. Optional phase tracing
records the multi-boot metadata-quota fixture without changing its deadline.
These changes do not increase cache budgets or weaken verification. Checkpoint
1.21's normal ABI 51 package rebuild is still running; 1.20 is unchanged.

The matched Firefox/SHA-256 diagnostic reads 535,396,352 base bytes with the
candidate, versus 7,084,331,008 before (about 13.2 times fewer bytes). Raw export
in those two runs takes 28.8 versus 474.2 seconds. These are diagnostic samples
on a machine running other builds, not controlled application benchmarks or
mobile-browser performance promises. CRC32C reads 502,005,760 bytes in each
engine; SHA-256 reads 535,396,352. The emitted raw image is 115,482,644 bytes
in every case. Actual WordPress/MariaDB boot acceptance remains open.

**Ordinary positioned-read followup (2026-10-22):** the Node audit reproduced
54,198,272 base bytes read for a 1,048,319-byte unaligned double-indirect file
range, with either checking policy and two data/two index cache pages. The
source now uses the same scoped Rust cursor for ordinary reads, journal base
callbacks and buffered read-modify-write batches, rather than only export.
The corresponding Node and all six browser policy/engine cases now read
4,063,232 bytes in 62 calls instead of 54,198,272 bytes in 827 calls. Requests
remain capped at 64 KiB; browser kernels remain at 29 sampled pages under the
1,024-page ceiling. These are fixture-specific read-volume results, not a
claim about every random-access workload or actual WordPress startup.

The refreshed candidate passes 2,864 Rust unit tests, 116 Node checks and
18 browser checks. The single Node skip is the explicitly optional large-image
case; the browser cohort has no skips, retries or failures. This Node cohort
includes the previously timing-sensitive cases under their original explicit
deadlines. Native tests cover plain, fixed-overwrite and resizable reads,
exact journal edits, sparse traversal and EOF behavior. Source, ABI and all
four native artifact hashes remain unchanged across acceptance; ABI stays 51.
The full production workload, memory/failure matrix and conformance gates
below remain open, along with the rebuilt application checkpoint.

**Metadata ownership followup (2026-10-22):** the source candidate replaces
the RXPT namespace-sized export buffer with an admitted iterative traversal
and a constant-sized stream summary. Lazy enumeration borrows the mounted
tree, preflights before touching output, and writes the existing wire format
directly into caller memory; size probes no longer copy and serialize a
whole cohort. Journal metadata reads and returned archive payloads retain
their I/O reservations through return, iteration and destruction. Native
regressions cover wide trees/cohorts, exact bytes, short-output preservation,
resource refusal, cancellation and returned-owner release.

**Journal policy consolidation (2026-10-22):** source recovery and native
unindexed conversion now share Rust's complete journal-header parser. The
existing codec export supplies bounded header geometry and a validated base
identity; the host no longer slices journal fields. Nonempty damaged or
truncated unsealed journals are refused before any activation control is
published, while host I/O and memory failures retain their original error.
The existing unreleased ABI remains 51 and the snapshot is unchanged. The
native workspace passes, including 2,878 runtime-core tests, with 74 positioned
image-module tests. Normal resident/positioned Wasm modules and the normal
source-only kernel product are rebuilt. The combined followup passes 283
Node tests with no skips and 93 OPFS browser cases across Chromium, Firefox
and WebKit with no skips or retries. New browser cases use real kernel
journals and verify both byte preservation and absence of newly published
activation controls after header refusal. Synthetic recovery/fault fixtures
now construct valid checksummed headers rather than arbitrary header-sized
bytes. A final error-classification followup additionally keeps an unsupported
journal codec operation (`EINVAL`) distinct from corrupt stored bytes (`EIO`);
124 Node checks and all 12 new browser cases pass against that final source,
with unchanged native artifacts. This is combined acceptance plus a targeted
followup, not a single unchanged-source run. Portable index interpretation,
broader recovery selection and the
remaining production acceptance gates below are not closed by this batch.

**Index and source-eligibility consolidation (2026-10-22):** checkpoint mount
and recovery inspection now share one Rust header decoder. It verifies magic,
version, checksum, journal boundary, sequence and count overflow before index
conversion can publish activation. The conversion threshold and source-binding
eligibility decisions are native policy too. The host supplies a bounded
32-byte evidence packet about the source's observed storage state; Rust decides
eligibility, supersession or ambiguity, requesting a digest check only when
needed. The codec retains no candidate table. The host still owns admitted
catalogs, actual handles, asynchronous I/O and publication/cleanup ordering.
ABI 51 and its snapshot remain unchanged.

The native workspace passes, including 2,883 runtime-core tests and 74 positioned
module tests; both Wasm image modules and the normal kernel product are
rebuilt. The final source has passing coverage for all 288 Node checks across
split cohorts: the serial run passes 287 and times out only the whole-runtime
ownership audit; that audit's complete eight-case file subsequently passes
alone under its unchanged 180-second deadline. Source and artifact manifests
match between cohorts. All 93 browser cases then pass across Chromium,
Firefox and WebKit, without retries or skips, followed by the host build and
source/artifact checks. This is not a single all-green Node invocation.

Earlier combined validation is retained as failed: disk exhaustion affects
Node session creation and OPFS quota, and ten synthetic index fixtures still
contained only a version field rather than a valid checksummed header. Those
fixtures now construct real header structure; no native validation was relaxed.
The disk-damaged browser run was interrupted and rerun in full, not counted as
partial acceptance. An intervening low-space guard also correctly refuses to
start the browser cohort. The repository cache collector then removes 13.6 GiB
of unreferenced SourceOnly generations using its live-checkout roots, recent-use
floor and exclusive build lock. Current cache roots, ordinary caches, source
archives, user browser storage and live checkpoint sites remain untouched.
Normal checkpoint 1.22 is now built and its real WordPress/MariaDB UI is
independently observed with a nonempty OPFS journal. Its full application run
passes 15 cases and has the two declared browser-process-crash capability
skips, but fails WebKit's SQLite login-form check before post/upload or
persistence operations. All MariaDB post/upload, media-library and mixed-file
cases pass in all three engines. The failed cohort is retained; its cause is
not yet established and it does not count as full application acceptance.
Source, artifact and site hashes remain unchanged through the run. The
process-tree diagnostic now explicitly records its bounded sample limit,
truncation and final sample time; all 2,063 samples cover this run through
exit without truncation or sampling errors. That is full-duration diagnostics
for a failed run, not unique physical memory or aggregate memory acceptance.
Checkpoint 1.21 remains unchanged; the larger memory, durability, performance
and release gates below remain open.

The resumed independent read-only review identifies no changed durability or
rollback decision in this migration and no retained native candidate handles.
It identifies a cleanup defect: candidate construction detached an index before
activation fingerprinting, so a fingerprint-read error skipped its local close.
An escaping production leak is not established because teardown has backstops.
The source now transfers that owner only after successful candidate publication;
a regression reproduces the missing close before this correction. Real OPFS
coverage injects the same fingerprint failure and observes exactly one index
close and no activation. The remaining portable-policy inventory is finite:
candidate ordering/ambiguity/retention and persistent-image prepared/active
selection.
This review is scoped source analysis, not independent test execution or
whole-system signoff.

**Seal metadata consolidation (2026-10-22):** Rust now owns seal chunk geometry,
checked total-length computation, journal/index/seal length admission, expected
base identity and strict versus appended-tail verification. The host passes a
bounded metadata packet, then performs the existing bounded read/hash walk.
Stored-data mismatches remain `EIO`; unsupported protocol and memory/resource
errors do not become permission for stale fallback. No format bytes, exports,
ABI snapshot or cache ceilings change. The native workspace passes, including
2,886 runtime-core tests and 74 positioned-module tests. Both Wasm modules and
the normal kernel product are rebuilt. The isolated ownership audit passes all
eight checks and the serial storage cohort passes all 284 checks. All 99
browser checks pass across Chromium, Firefox and WebKit with no skips or
retries. A subsequent invocation initially collects no SQLite tests because
its title filter is incorrectly anchored; that setup failure is retained.
The corrected filter then runs the complete original WebKit SQLite post/upload
and source-free restart workflow successfully, followed by the host build and
unchanged source, native-artifact and immutable-site hashes. This is a focused
repair on checkpoint 1.22, not a rewritten all-green result for its earlier
15-pass application cohort. Final complete application acceptance on the
eventual release candidate remains open.

The earlier WebKit SQLite failure is now traced to a preview navigation helper
that returned after assigning `location` but before the destination document
committed. A response-gated iframe regression fails in all three engines with
the old helper and passes in all three with navigation awaited through commit.
An unchanged-runtime WebKit login diagnostic also succeeds and records the old
helper returning before commit. The shared test helper now awaits that actual
navigation; no production guest path, readiness assertion, timeout or retry
policy is weakened. The full original SQLite persistence workflow now passes
as described above; the failed 15-pass cohort is retained.

A second independent read-only review traces persistent namespace/recovery
reservations, journal metadata returns, shared I/O owners, export cancellation
and host transport/generation boundaries without identifying a new actionable
memory defect. It does not run tests, exhaustively prove allocator coverage or
close aggregate peak-memory acceptance. Materialized/composer vectors and
caller-owned results remain explicit boundaries; unrelated signal/wake
hardening is not part of this gate.

**Image-binding policy consolidation (2026-10-22):** prepared/active
transition validation and primary/target/source selection now run in Rust.
The host supplies a fixed 64-byte evidence packet containing observed versions,
generations, initialization flags and manifest/content equality. Rust refuses
unsupported envelopes, ambiguous same-generation content and unproven prepared
sources before selecting anything; supported initialization and newer-primary
repair retain their prior behavior. The disposable codec worker owns the native
invocation and terminates before returning a bounded selection; there is no
whole-image read, retained native table or main-thread filesystem buffer.
Manifest JSON, bounded hashing, physical OPFS operations, locks and publication
remain host responsibilities. Protocol/resource errors remain distinct from
stored-data damage. This extends the existing unreleased ABI 51 control codec,
not the exported ABI or saved format. The native workspace passes, including
2,889 runtime-core tests, 69 resident-module tests and 74 positioned-module
tests, followed by both module builds, ABI checking and the normal kernel
product. The isolated eight-case ownership audit and all 347 storage/courier
Node checks pass. All 189 browser checks pass across Chromium, Firefox and
WebKit with no skips or retries, including prepared/active publication cuts,
stale/damaged-control recovery, source-free checked-image checkpoint/reopen,
and the new native selection transport. The host build and full source/native
artifact manifests match after this integrated cohort. A scoped independent
read-only review finds no concrete migration regression, but is not exhaustive
equivalence or release proof. Normal checkpoint 1.23 is built, and its real
WordPress/MariaDB response, nonempty OPFS journal and activation controls are
independently observed through the public UI with no page errors. Its full
application matrix now passes as detailed below; immutable checkpoint 1.22 remains available.
Generation candidate
ordering/ambiguity/retention remains the final identified shared host-policy
area for the responsibility review.

**Checkpoint 1.23 application acceptance (2026-10-22):** the normal ABI 51
product/catalog/site build completes, reusing 118 cached nodes with 17 build
nodes and nine source checks. All 16 supported application cases pass across
Chromium, Firefox and WebKit, with no retries or failures. The only two skips
are the explicitly declared Firefox/WebKit browser-process-crash cases that
require Chromium CDP. Coverage includes shell sync/reload/checkpoint, SQLite
and MariaDB posts/uploads, media-library upload and oversized-request refusal,
and mixed MariaDB/media/512-file/8-MiB/link/rename/mode/source-free recovery.
The strict 18-case inventory and source/artifact/immutable-site hashes pass.
This is a new complete application cohort, not a relabeling of 1.22's failed
cohort or its focused repair.

Single-run MariaDB observations record installation to first response at
40.7/44.1/38.2 seconds, checkpoint-and-reboot at 69.5/78.3/63.8 seconds, and
saved-computer recovery at 30.8/29.1/29.0 seconds in Chromium/Firefox/WebKit
respectively. Chromium recovery includes browser-process crash/relaunch;
Firefox/WebKit use page reload. All six SQLite/MariaDB recovery cases make
zero source-image requests. These are observations, not controlled speedups,
physical-phone results or proof of read-volume scaling. A separate actual
MariaDB in-memory/persistent boot diagnostic is measuring positioned reads.

The application process-tree diagnostic records 2,080 samples through exit,
zero sampling errors and no truncation; its final sample is one millisecond
before its end. The sampled descendant-RSS sum peaks at 3,991,296 KiB. Shared
mapping double counting, unsampled transient peaks, external platform helpers
and the separate user preview remain explicit limitations; this is not unique
physical memory or aggregate filesystem-memory acceptance.

**Actual application read-cache diagnostic (2026-10-22):** a separate three-engine
run against immutable checkpoint 1.23 completes without skips or retries. Its
private server prepends a bounded read observer to the original kernel-worker
HTTP response, preserving the worker URL and normal process-worker resolution.
It compares normal in-memory boots, initial installation, ordinary reopen with
the shipped two-data/two-index-page configuration, and reopens requesting the
existing supported 16/4 and 64/8 cache limits. The checking policy remains
CRC32C, all reopens refuse the source URL, and the native I/O budget and checking
rules remain enforced. No production cache default is changed by this experiment.

| Observation | Chromium | Firefox | WebKit |
| --- | ---: | ---: | ---: |
| In-memory reload to first WordPress/MariaDB response | 15.7 s | 15.0 s | 16.2 s |
| Shipped 2/2 persistent reopen | 28.7 s | 30.5 s | 31.2 s |
| Requested 16/4 persistent reopen | 16.2 s | 17.6 s | 15.9 s |
| Requested 64/8 persistent reopen | 16.2 s | 19.9 s | 16.8 s |

The physical base is 245,805,523 bytes. Shipped 2/2 reopen reads approximately
5.158 billion base bytes in about 78,910 positioned calls in every engine;
roughly four billion of those bytes are concentrated in two 1-MiB physical
regions. Requested 16/4 reads about 229.8 million bytes in 3,518–3,520 calls;
64/8 reads about 210 million in 3,211–3,215 calls. Every base request remains at
most 64 KiB. Data cache pages are 64 KiB and index pages 4 KiB, so 16/4 requests
1 MiB plus 16 KiB of payload capacity, before the native doubled-capacity
admission charge and small slot metadata. Frozen checkpoint 1.23's browser
coordinator hardcodes 2/2 even though the native API accepts larger bounded caches.

These sequential desktop observations expose a concrete tuning problem, not
a controlled speedup: journal state evolves and compaction occurs between the
larger-cache phases. They neither promise mobile timings nor prove a complete
scrub or capacity-scaling result. Finish a Rust-owned, budget-aware default and
matched workload/pressure acceptance rather than simply raising a host constant
or treating these private overrides as shipped behavior.

The next source candidate requests native selection with paired zero page
limits. Rust caps the cache at 16 data/four index pages, scaled from one
sixteenth of the ordinary I/O pool, without increasing any memory ceiling or
eagerly fetching blocks. The default 30-MiB pool selects 16/4; a 6-MiB pool
selects 5/4. Explicit nonzero caller limits and native admission/eviction remain
unchanged. The primary WordPress browser regression no longer checkpoints
before restart. Scoped acceptance of the updated prototype is recorded below;
the earlier private overrides alone did not establish that acceptance.

**Live filesystem checkpoint 1.24 (2026-10-22):** the normal ABI 51 product
build passes 2,891 runtime-core tests, 69 resident-image and 74 positioned-image
tests, 21 Node checks across four files and eight progress-format checks.
The final Chromium/Firefox/WebKit application cohort passes all three
WordPress/MariaDB cases without skips or test retries: publish a post, upload
PNG data and recover both without an image checkpoint. Chromium crashes and
relaunches the browser process; Firefox/WebKit reload the page. A serial test
server allows one initial image download with committed `Cache-Control:
no-store`, refuses all later image requests and observes no later attempts.
The actual service worker remains enabled. This closes the blind spot in
relying on Playwright page routing alone to count source-image requests.

Single-run reopen-to-first-WordPress-response observations are 18.8/16.3/17.0
seconds respectively, including the named browser/page lifecycle. Fresh
installation is 28.1/48.0/25.8 seconds and includes download and initial OPFS
format creation. These are loaded-machine observations, not controlled
speedups or mobile measurements. The user-facing prototype requests Rust's
budget-aware caches; opening a saved computer no longer reports a fictional
whole-image byte restore. Full-image checkpoints remain optional.

Earlier failures remain separate evidence. The 1.23 diagnostic hit WordPress's
delayed username autofocus while typing, before testing recovery. A first
1.24 test change incorrectly required script-driven focus in Firefox; the
final test instead verifies credential edits before submitting the real form.
That failed cohort also had a WebKit initial-preview timeout before any
application write. The later three-engine pass does not establish the cause
of that startup stall. The private runner's initial CommonJS-import error
collected no tests and is not application acceptance. Broader failure,
performance, memory and release gates remain open.

The separate 1.24 boot/read diagnostic passes all three engines and all 18
phases without skips or retries. With the shipped native automatic selection,
ordinary reopen reads 230.1–230.4 million base bytes in 3,518–3,521 calls,
each at most 64 KiB, from the 245,805,523-byte base. Reopen-to-first-response
is 15.7/15.8/16.4 seconds, compared with 15.2/14.9/15.3-second in-memory
reload observations in the same sequential run. This supports the scoped
base-cache tuning, not a general performance or capacity-scaling signoff.

The same diagnostic exposes a remaining indexed-generation problem: after
automatic journal compaction, later reopens read approximately 1.175 billion
bytes from the generation index in roughly 292,900 calls. The lower immutable
base read total does not describe all storage I/O. Bounded index-page caching
and lookup/read-volume scaling are the next concrete performance work; retain
the raw observations and test this path rather than treating the base-cache
fix as completion of the live filesystem's performance gate.

**Index-cache source followup (2026-10-22):** the Rust checkpoint reader now
has a lazily admitted, I/O-budgeted supplemental page cache, capped at 32
4-KiB pages and reduced for smaller ordinary I/O pools. Allocation pressure
reuses retained pages or falls back to the existing inline pages; it does not
borrow writeback reserves or raise memory ceilings. Failed page replacement
invalidates the old inline tag before mutating its bytes. Mandatory payload
allocation can reclaim supplemental ownership, but a failed backend read is
not retried. Ordinal validation/streaming does not admit supplemental pages,
preventing optional caches from starving the next recovery transaction.

The native persistent-overlay cohort passes 119 tests, including reproduced
partial-read poisoning, required-payload allocation pressure and indexed-prefix
next-frame pressure regressions. Four source-image-proxy unit checks also
pass. An independent read-only source review finds no remaining blocking
defect in this scoped cache change. These are source/native results: the
public 1.24 demo does not contain this change, and the rebuilt 1.25 application,
read-volume and pressure gates remain pending. Whole-index admission, sealed
prefix verification and namespace reconstruction still scan their respective
structures; bounded lookup caching does not establish capacity-independent
boot or replace those checks with demand authentication.

The checked-in application fixture now uses an owned streaming image server,
rather than relying on page routing or a private runner, to block source-image
downloads during recovery. Its initial six SQLite/MariaDB cases pass across
Chromium, Firefox and WebKit on frozen 1.24 with the real service worker.
The user independently confirms that uploaded MariaDB media survives an
ordinary refresh without taking a checkpoint. The user also reported an
unstyled post editor in Firefox, then confirmed it works again with no new
deployment. Fresh Chromium and refreshed Firefox diagnostics render parsed
editor styles, and a Chromium refresh diagnostic publishes through the actual
editor. This does not establish the cause of the intermittent styling failure.
The primary application fixture is being strengthened to publish through the
editor and check its styles/canvas again after recovery, rather than treating
a REST-created post as proof of editor rendering. That new cohort is pending.

The first strengthened cohort exposed a fixture race: the welcome dialog
appeared after a one-time visibility check and blocked Publish. A locator
handler now uses the real Close button when that dialog appears. The next
cohort passes both Chromium application cases, but Firefox's SQLite editor
has `richEditingEnabled: false` and renders WordPress's text editor instead
of the expected visual canvas. A separate native browser probe and an actual
guest-bridge regression establish that Firefox omits `User-Agent` from
service-worker request headers. The bridge now projects the worker's native
user agent only when that request field is absent. The regression fails with
an empty forwarded value before the fix and passes on all three engines
afterward. This is a distinct browser/guest header defect, not an established
explanation for the user's intermittent missing styles. The rebuilt visual
editor/application cohort remains pending.

Earlier diagnostic failures are retained separately: a blob-worker wrapper
breaks relative worker URLs; an overly broad 64-KiB assertion incorrectly covers
variable-sized journal records; Firefox does not apply the Playwright worker
response interception used by the first corrected probe; and a private class
field loses its compiler helper when its init function is serialized. The final
server-side observer and self-contained init script resolve those fixture
defects without changing production code, guest assertions, checking policy or
deadlines. The 16-pass application acceptance above remains independent of this
diagnostic history.

That initial batch passes the workspace, positioned-module and xtask native
suites, ABI checking, and 411 Node checks (two intentional skips). The browser
cohort has 63 passes and six fixture-provisioning failures: both live-inspection
tests in each engine cannot resolve a source-only Bash package projection.
No filesystem assertion runs in those six cases. Source and all four native
artifact hashes remain unchanged across that cohort. This is incomplete
browser acceptance, not an all-green result.

The refreshed source candidate also borrows binary archive payload fields during
cohort verification/sealing, hashes canonical identities incrementally, and
admits group tables and encoded output owners. Archive registration uses the
same borrowed codec and an admitted copy of its existing payload. Its complete
native workspace passes, including 2,873 runtime-core tests and 69 image-module
tests; the positioned image-module variant passes 74 tests, and xtask passes.
After rebuilding the normal kernel/Bash/coreutils package projection, the
combined followup passes 411 Node checks (the same two optional large-image
skips) and all 69 browser checks across Chromium, Firefox and WebKit, without
browser skips, retries or failures. The earlier six inspection provisioning
failures are closed by this browser cohort. Source, ABI and artifact hashes
remain unchanged across acceptance. Neither batch changes ABI 51 or frozen
checkpoint 1.20; rebuilt WordPress application acceptance is still open.

The first refreshed Node attempt selected strict product-only resolution,
which excludes developer guest fixtures: 53 tests skipped and five assertions
failed against fixture images missing the guest program. Those results are
retained, not counted as acceptance. The complete followup uses the normal
Node fixture policy and the same newly built kernel bytes as the isolated
browser projection. No production source or assertion changed between runs.

**Remaining storage-memory owners (read-only audit, 2026-10-22):** the open
memory gate is now tied to these concrete owners, not general signal, terminal
or wake-delivery hardening. Static findings need focused reproduction and
acceptance; they are not a claim of observed corruption.

- Recovery formerly reserved arena capacity for the base-plus-created inode
  union before removing deleted base inodes. A Node diagnostic reproduces the
  same-budget failure with 511 empty base files: replacing all of them works
  at 768 KiB and 896 KiB metadata allowances, but reopening returns `ENOMEM`.
  The 320,469-byte journal stays byte-for-byte unchanged on refusal. The same
  workload recovers at 1 MiB and above. Both the preserved pre-cohort kernel
  and the newly built current kernel reproduce these results.
  The source now validates the complete virtual namespace first, plans reuse
  of unlinked base slots with no open handles or mappings, and reserves only
  actual additional arena slots. Existing live inode indices do not change.
  Old directory removals publish before their parent slots are reused; new
  namespace links and staged FIFO keys use the same physical-slot mapping.
  All fallible validation, reservations and FIFO preparation finish before
  any slot is reclaimed. Two native regressions pass, covering the original
  quota refusal, failed-recovery retry, reused directory parents, hardlinks,
  FIFO aliases and held/mapped unlinked inodes. The new Node cases reproduce
  `ENOMEM` on the pre-fix kernel with both checking policies. The rebuilt
  candidate passes the native workspace (2,875 runtime-core tests), both image
  module variants, xtask, ABI checking and 413 Node checks, with only the two
  previously optional large-image skips. All 12 new OPFS recovery cases pass
  across the three engines: both policies, both metadata allowances, replacement,
  reopen, another write and a third boot. The existing 69 browser cases pass
  separately against the same unchanged kernel. This is split-cohort acceptance:
  the initial new browser cases failed because their cleanup called a
  nonexistent ownership-query method; correcting the fixture's cleanup query
  and journal-directory name requires no production-code change. Production,
  Node-fixture and seven native artifact hashes remain unchanged. This fixes
  a recovery resource-admission defect, not observed data loss; the aggregate
  memory gate remains open.
- Combined acceptance now covers admitted deferred/archive enumeration,
  cohort verification/sealing, RXPT traversal and returned journal metadata.
  Scoped independent review of host decoding finds that lazy-limit maps retain
  their credits through disposal/replacement, manifest parse overlap uses its
  existing budget, and returned directory results belong to the caller. That
  scope identifies no additional unbounded boot/checkpoint decoded cohort;
  it is not a whole-runtime memory signoff.
- The same review finds a concrete inspection refusal bug: host metadata
  `ENOMEM` thrown inside kernel ingress permanently failed the worker. The
  shared host implementation now cancels the Rust snapshot through the same
  inline lease's terminal-offset read, requires successful cleanup, then
  throws the original admission error outside ingress. Unexpected exceptions
  and failed cleanup remain fatal. New native-worker and real OPFS regressions
  cover both checking policies, directory/resource enumeration, exact native
  I/O and host-credit reclamation, read/stat/retry, and a new synced write
  recovered by a fresh worker. Twenty-four unit cases additionally cover both
  pointer widths, partial streams, cleanup errors and traps. Live acceptance
  passes 307 Node checks, 30 browser cases across all three engines and the
  host build, with changed-source hashes stable. The ownership audit rejected
  the first nested lease helper; native calls now remain inline and the audit
  passes without exceptions. This fixes a recoverable-resource boundary, not
  observed persistent data loss, and retains ABI 51.
- Ephemeral/materialized regular-file vectors remain outside shared I/O
  admission. Persistent ordinary writes already use the admitted journal
  path. Audit which install/composer/protected-file paths can retain these
  vectors before deciding their resource policy; do not silently impose the
  transient-cache size as the in-memory filesystem's capacity. In particular,
  browser initialization formerly seeded the TLS proxy certificate before
  enabling persistence. The resulting host-staged regular inode failed normal
  mutation after mounting the journal. The candidate now mounts/replays first,
  creates parents through a checked Rust journaled helper, and replaces the
  host-managed certificate without fetching obsolete read-only/deferred base
  contents. A clean native sync permits optional TLS provisioning refusal on
  logical disk or memory exhaustion; poisoned-writer sync failure still rejects
  boot. Two new native regressions and six Chromium cases pass, including
  journal-flush quota injection, read-only/deferred certificate replacement,
  sibling recovery and a genuinely full journaled disk that boots, reclaims
  space and repairs its certificate on the next reopen. The fixture fills the
  disk through ordinary mutations: the image producer intentionally retains
  export slack, so an attempted zero-headroom construction was a fixture error,
  not a filesystem failure. Combined validation now passes: native workspace
  (2,877 runtime-core tests), 69 resident-module tests, 74 positioned-module
  tests, xtask, ABI 51 checking, 413 Node tests with two optional skips, and all
  99 browser cases across Chromium, Firefox and WebKit, with no retries or
  skipped browser cases. Source and six native-artifact hashes remain unchanged
  across the accepted Node/browser cohort. The directly Cargo-built kernel and
  resolver-built kernel are recorded as distinct artifacts; the normal and
  private resolver projections match. An initial harness incorrectly required
  the two separate build paths to be byte-identical; its failure is retained,
  and the successful followup reuses only the already completed native checks
  after verifying their source/artifact manifests. The rebuilt real WordPress
  + MariaDB checkpoint 1.21 is now available as an early frozen preview, with
  its real OPFS base and nonempty journal independently observed through the
  public app. All 16 supported real-application cases pass across Chromium,
  Firefox and WebKit: shell recovery/checkpoint, SQLite and MariaDB posts and
  uploads, media-library uploads, and mixed database/media/512-file workloads.
  Two additional browser-process crash cases remain explicitly unsupported on
  Firefox/WebKit because that harness uses Chromium CDP; Chromium's process
  crash case passes. A strict inventory checks all 18 named engine/case pairs,
  permits only those two exact capability skips, and rejects retries, omissions
  and other skips. The original verifier's incorrect zero-skip assumption is
  retained as a harness failure, not counted as a filesystem test failure.
  The frozen candidate's larger Node cohort subsequently passes 903 checks
  in 41 files with no skips, using fresh normal-producer 4 GiB/32 GiB VFSI
  fixtures carrying the current guest program. The older fixture provenance
  failure and a debug-tool build's disk-exhaustion failure are retained;
  neither is hidden by dropping large-image cases. Two development-page
  Chromium boots initially fail because a test interceptor serves Wasm bytes
  for Vite's JavaScript `?import&url` module wrappers, which Chromium workers
  report as `fetch`. CDP logs identify the strict MIME failure. The helper now
  excludes those wrappers, with six unit regressions. All 18 source-page cases
  pass alongside the 12 new inspection cases in the later 30-case live cohort.
  That cohort includes the newer inspection fix; it is not a claim that the
  old frozen candidate passed one unchanged all-green combined invocation.
  This is not a controlled boot-time comparison. The sampled process-family
  RSS diagnostic is also not aggregate memory acceptance: its 2,048-sample
  limit stopped before the final part of the 35.3-minute application run, and
  shared mappings can be counted more than once.
  Independent
  read-only review found and prompted the clean-sync resource-refusal guard;
  the followup found no further concrete issue in this scoped change. It is
  not a whole-filesystem safety signoff.

Combine the resulting ownership bounds with the existing resident/temporary
allowances and actual Node/browser process peaks. The checked streamed writer,
compaction batches and host generation accounting retain their reservations;
the scoped review found no additional scalable owner there. That review does
not close the aggregate memory gate.

**Current integration evidence:** the source composer streams ordinary VFSI
exports through the Rust checked-image writer into worker-owned OPFS targets.
Version 6 manifests record physical/logical lengths, header identity and
checking policy. Reopen validates the bounded header, not the full payload;
the mounted Rust reader verifies demanded pages. Six small-image integration
cases pass across Chromium, Firefox and WebKit: compose, journal a new file,
checkpoint, reopen, retain policy and reject a policy-changing replacement.
The tests observe only prefix reads of at most 4 KiB during saved-base
admission. Fifteen lower-level writer/codec browser cases and 38 Node binding/
memory-admission cases also pass. The normal product projection has now been
rebuilt with the current image module. The rebuilt WordPress checkpoint
remains outstanding; existing checkpoint 1.20 is unchanged.

The version 6 freshness/publication cohort additionally passes 45 browser
cases across the three engines, including damaged base/journal headers,
stale primary/active control files and released checkpoint journal leases.
Eleven remaining saved-image cases pass on Chromium, including six abrupt
publication cuts; their other-engine refresh is still pending. Subsequent
review found a composer rejection could settle before its codec had closed
storage. The source now aborts and drains staging, preserves unproven-close
errors, and bounds the courier to one outstanding chunk. A storage close
ledger distinguishes rejected acquisition from uncertain cleanup. A separate
pre-dispatch cancellation regression avoids asking an unstarted worker to
acknowledge a nonexistent handle. Focused ownership tests cover those paths;
the combined cohort described next includes these fixes.

The refreshed combined source cohort now passes **129 browser checks** on
Chromium, Firefox and WebKit (147 inventoried, 18 full-product page checks
explicitly skipped until rebuilt package artifacts exist). This includes the
saved-image, composer, codec and direct writer suites after the lifecycle
fixes, all abrupt publication cuts and the bounded positioned 68 MiB install.
Separate 772 MiB image / 768 MiB constrained-kernel acceptance runs now pass
on all three engines in both fixed-overwrite and resizable modes. The
resizable run also creates a directory tree and verifies it, the high-tail
overwrite, journal recovery and exported-snapshot recovery. These are large
streamed-image checks, not a claim about physical-phone browser limits.

The Node persistent conformance runner now constructs a checked base with
the Rust streaming writer and reopens the same file/binding after guest
teardown. CRC32C is its default; `KANDELO_RUNNER_PERSISTENCE_CHECKING=sha256`
selects SHA-256. Against the refreshed normal artifacts, 108 Node checks and
64 selected checked-base Sortix reboot cases per policy pass. The broader
checked-base runtime matrix is still outstanding.

Normal-reopen I/O regressions pass for both policies on Node and all three
browser engines. They compare 512 KiB and 32 MiB cold files, positively
observe physical base reads, reject any access to a guarded cold-payload
range and cap individual requests at 64 KiB. In Node, CRC32C reads 921,728
bytes and SHA-256 reads 974,976 bytes from the roughly 32.6 MiB checked
images during reopen and journaled-file readback. This establishes bounded
demanded reads for these fixtures, not application boot-time performance.

Both policies also pass a Node 32 GiB checked-image run with a 768 MiB
kernel ceiling: read a distinctive payload at 8 GiB + 37 without low-word
aliasing, journal a new namespace entry, shut down and reopen both. Kernel
linear memory remains 29 pages in each sampled boot. The combined four-case
Node run (including the I/O regressions) records a sampled descendant-RSS
peak of 424,416 KiB; shared mappings may be double-counted and short-lived or
out-of-tree processes are not covered. The sparse host fixtures do not prove
32 GiB OPFS quota availability, physical-browser allocation or the complete
aggregate-memory gate. The builder bridge additionally refuses whole-file
reads above its wasm32 buffer-length representation with `EOVERFLOW`, while
bounded reads retain full-width positions.

The combined I/O-boundary browser cohort passes 36 cases without skips on
Chromium, Firefox and WebKit: normal-reopen physical-read guards, sparse
composer admission (including 4 GiB + 3 and 8 GiB file lengths), whole-file
overflow refusal and bounded configured-asset intake. Its recorded browser
read volumes match the Node figures above. A 77-pass Node cohort additionally
covers the bridge and both checked-base policies; one separate near-dense
snapshot case is explicitly skipped without its optional fixture setting.

The extended 32 GiB Node acceptance also passes for both policies: an
ABI-matched guest overwrites and `fsync`s 2 MiB near the file's far end,
exceeding the dirty cache, and a fresh kernel verifies all overwritten bytes
through guest `pread` calls. The 8 GiB immutable marker and namespace write
remain intact. Observed kernel memory after these guest workloads is 229
pages initially and 182 after reopen; the two-case run's sampled
descendant-RSS peak is 371,344 KiB, with the same sampling limitations above.

**Current bounded-builder followup:** source handle writes now use the
existing Rust 64 KiB positioned-write entry point rather than copying the
entire prior file through JavaScript. Integration exposed a separate wasm32
resident-backend narrowing bug: large offsets could alias low bytes and a
borrowed size could be truncated during materialization. Rust now checks
those conversions and uses fallible allocation before inode replacement.
Oversized nonpersistent copy-on-write fails without damaging the borrowed
file; the persistent overlay retains its separately tested high-word writes.
Builder metadata and partial-progress behavior are preserved. This followup
passes all 2,849 runtime-core native tests, 145 Node checks (one optional
near-dense fixture case explicitly skipped), and 51 browser cases without
skips across Chromium, Firefox and WebKit. The real wasm32 probes cover
large borrowed-file refusal, unchanged low bytes and file length, high-word
resident EOF, bounded write counts and builder set-ID modes. ABI verification
passes under ABI 51. These are infrastructure receipts; they do not replace
the pending rebuilt WordPress checkpoint and aggregate workload acceptance.

The host whole-file inspection path now uses one bounded result buffer
instead of retaining chunks and then allocating a second merged result.
`maxVfsFileReadBytes` defaults to the smaller of 64 MiB and one quarter of
the kernel memory ceiling. A larger result fails with `ENOMEM`, rather than
silently truncating; explicit ranged reads retain their independent 1 MiB
limit. Executable preflight retains its existing program-transfer limit and
does not inherit the inspection allowance. Both whole-file paths resolve
stat and reads through Rust's inspection namespace, including followed
symlinks and host mounts. A stat size is an allocation hint, not EOF; short
reads continue until the actual end, including when a host file grows after
an initial zero-size stat. Allocation failure stays a routine request error.

This followup passes 153 Node checks without skips, including the real
32 GiB checked bases, and 12 browser cases without skips across Chromium,
Firefox and WebKit. The new cases exercise both checking policies, bounded
inspection refusal, independent ranged reads, symlink content, actual guest
execution above the inspection allowance, and journal reopen. Node also
tests a real growing host file with forced short native reads. The focused
Node configuration avoids product-mutating global setup during the active
application build; it does not establish full-product acceptance. A narrow
type check reports only the existing `webgl/query.ts` diagnostic, not a
globally clean type check. Caller-retained results and aggregate workload
peaks still require acceptance; this closes the internal chunk/merge staging
owner, not the whole memory gate.

The integrated checked-base pressure followup now passes four Node checks
and six browser cases without skips or retries. Both policies use a real
96 MiB file in a roughly 101.5 MiB physical checked base, a 64 MiB kernel
ceiling, two data/two index cache pages and 2,048 existing long-name files.
The actual guest combines an 8 GiB sparse mapping, 8 MiB of distinct-block
writes and namespace creation until `ENOMEM`, then reclaims names and retries.
Strict journal reopen, streamed snapshot export, checked-base reconstruction,
snapshot boot and a further new-journal-only sentinel replay all succeed.
Every seed name, mode and size is checked at each phase, with position-bound
cold-data samples including a block-boundary crossing. Native kernel memory
peaks at 220 pages on Node and 221 pages in each browser (under 14 MiB).

An independent read-only review identified cleanup ownership and sampling
blind spots in the pilot. The accepted followup attempts every fixture close,
aggregates primary/cleanup failures, retains uncertain targets, checks browser
quiescence separately from sync failure and retains an unproven codec owner.
Two injected Node cleanup failures verify that discipline. Final source and
artifact hashes remain unchanged across the accepted run. Evidence prefix:
`.context/persistent-checked-pressure-final`.

This is kernel-pressure and recovery evidence, not a 64 MiB total browser
budget. Fixture construction deliberately retains the file in a producer
image-module instance. Sampled descendant-process RSS peaks at 756,064 KiB
for Node and 2,096,064 KiB for the browser run, including fixture/test owners;
neither is unique physical memory or a complete census of reparented browser
helpers. Recorded phase times combine the named operations and do not prove
an application boot-time improvement. The pending real-page WordPress tests
now attach separate initial-installation, checkpoint/reboot and source-free
recovery wall-clock observations, explicitly distinguishing Chromium process
restart from Firefox/WebKit page reload. Those observations have not run yet.

The activation-control consolidation now implements the unchanged 128-byte
control format, checksum, safe-integer/slot validation, generation transitions
and replica selection in Rust. Node and browser use a bounded, immediate
scratch lease, while the standalone image module supplies the same native
codec to storage-model tests. Resource and transport failures are not treated
as corrupt replicas. Six new native cases pass within the 2,855-test
runtime-core suite; an independent read-only review found no actionable
defects in that scoped policy/FFI change. The refreshed native-policy cohort
passes 171 Node checks in four files, including the scratch ownership audit,
seal/compaction crash cuts and six cases proving native resource/transport
failures cannot authorize fallback to an older activation. The integration
refresh corrected a Rust pointer-name contract mismatch and exposed ABI-stale
guest fixtures. The broader kernel cohort now passes 346 Node checks in eight
files; its one explicitly skipped near-dense 32 GiB builder case still requires
the optional fixture setting. The initial browser refresh exposed a test-only
module import that incorrectly required the whole application's package
closure; the fixture now transports the current standalone native module
explicitly, as the existing codec fixtures do. Its positive retirement and
newer-descendant models now publish durable native activation controls, as
the existing Node equivalents do; two additional unanchored cases must refuse
without changing storage. This preserves fail-closed recovery rather than
relaxing production selection to accommodate an obsolete fixture. The corrected
cohort passes **60 browser cases** across Chromium, Firefox and WebKit, with
no skips or retries and unchanged recorded policy/kernel/module/guest inputs
through the run. Evidence prefix: `.context/native-activation-browser-accepted`.
ABI verification passes under 51, with
an additive export and normal artifact rebuilding rather than a compatibility
fallback. Broader candidate policy remains to consolidate.

**Seal-policy consolidation followup:** the source now moves seal-header
encoding, checksums, safe integer/source-slot checks and streaming SHA-256 to
Rust, removing the host's JavaScript SHA-256 implementation from generation
sealing and verification. The host retains positioned reads/writes, checksum
slot iteration, physical-size comparisons and publication choreography. One
60 KiB I/O window and reusable hash courier serve an entire seal operation;
the 112-byte explicit hash state needs no retained native handle. Maximum
native scratch use is 61,696 bytes, below the existing 65,608-byte channel
scratch allocation. Neither the memory ceiling nor the ABI export signatures
change. A capability probe reports an older kernel/module as missing policy,
not corrupt storage; native hash-context errors also cannot authorize fallback.

All 2,859 runtime-core native tests pass, including fragmented digest/padding
boundaries, malformed/overflowed state, every stored seal-header version and
single-byte damage. The default/positioned Wasm modules and normal kernel
product rebuild; ABI verification passes and the snapshot hash is unchanged.
An independent read-only review finds no actionable issue in the scoped seal,
hash-state or scratch-ownership implementation. This followup additionally
passes 277 Node checks in eight files and 60 browser cases across Chromium,
Firefox and WebKit, without skips or retries. Independent Node hashing checks
all four seal versions and fragmented payloads against the native codec;
failure cases distinguish missing capability, malformed header and failed
hash context. The cohort includes the scratch ownership audit, compaction
crash cuts, real-kernel journal recovery and both base checking policies.
Evidence prefix: `.context/native-seal`. These remain focused infrastructure
receipts, not full-product, whole-memory or conformance acceptance.

Two additional transport regressions pass in a six-case Node codec run:
synthetic native hash states carry their byte count across 4 GiB and 8 GiB
without low-word aliasing, and seal fields retain maximum-safe lengths and
source-slot identities. These check counter/encoding boundaries; they do not
claim to hash a physically allocated multi-gigabyte file. Production sources
remain unchanged while the current-code large-image pressure cohort runs.

The current-policy pressure refresh finishes four Node checks and five of six
browser cases successfully, but **does not pass the full browser gate**:
Firefox's SHA-256 case exceeds its existing ten-minute watchdog. Both policies
pass on Chromium and WebKit; Firefox CRC32C also passes. Read-only inspection
of the run-owned Firefox profile observed snapshot/control-file updates during
the slow case, so this is not evidence of a proven deadlock or corruption.
Its late result records all four functional phases, with successful guest
exits and a 221-page kernel peak, but about 620 seconds of combined phase
time; the watchdog failure still stands. Other engine/policy cases finish
those phases in roughly 35–68 seconds in the same run. These are combined
pressure/snapshot phases, not pure boot-time measurements.
Phase tracing has been added to the fixture and the isolated Firefox/SHA-256
reproduction retains the same workload, checking policy and timeout. No retry
or increased deadline converts that failed receipt into acceptance. Evidence
prefixes: `.context/native-seal-pressure` and
`.context/native-seal-pressure-firefox-repro`.

## Original infrastructure completion criteria

### Historical integrated acceptance batch

Checkpoint 1.31 moves initial decoded-source OPFS writes into the
existing disposable codec worker and both decoded-source SHA-256 passes into
the existing Rust digest implementation. The composer verifies stored bytes
before parsing through its own positioned module, rather than allocating an
additional main-thread hashing module. This keeps the raw import format and
the separate write-time and stored-byte checks. It does not eliminate either
installation pass, change ABI 51, or alter ordinary demand-verified reopen.
Compressed-source pins remain independent transport authentication.

The first source cohort passes 51 cases across Chromium, Firefox and WebKit,
including bounded compressed staging, source-pin mutation, short/truncated
input, both saved checking policies and an image larger than the constrained
kernel budget. A subsequent read-only review found a late quarantine-admission
race, not corruption of an existing computer. Setup now rechecks quarantine
after parent lookup, file creation and module loading, before any new writer
dispatch. Undispatched healthy stages are removed; potentially worker-owned
stages and their locks remain protected. Two reproducing regressions and an
additional file-creation race pass after the fix. The current source batch
passes 262 unit/integration cases in nine Node files. Its scoped typecheck
still reports the separately known WebGL query and terminal-launch diagnostics;
this is not a clean repository-wide typecheck. The final-source browser
cohort also passes all 51 cases after the admission fix, with no retries or
skips. Checkpoint 1.31 builds through normal host, product, ABI and frontend
paths. All six WordPress SQLite/MariaDB post/upload/recovery cases pass across
the three engines, including source route denial, Chromium browser-process
crash and attribution of the new staging worker. The user reports little
perceived startup improvement; no meaningful speedup is claimed from this
change alone.

All 18 fresh-machine MariaDB boot phases pass in the diagnostic cohort:

| Engine | Initial installation | Ordinary reopen | In-memory reload | Initial streaming stage |
| --- | ---: | ---: | ---: | ---: |
| Chromium | 21.34 s | 15.01 s | 14.57 s | 3.17 s |
| Firefox | 26.75 s | 15.81 s | 14.88 s | 4.14 s |
| WebKit | 23.73 s | 15.24 s | 14.87 s | 3.57 s |

The streaming stage includes download/decompression, native hashing and OPFS
staging, not isolated disk-write latency. Composition finishes about 7.08,
12.14 and 8.97 seconds after document start respectively; the rest includes
normal kernel/service/application startup. The existing compiled-module cache
reports less than 0.35 seconds of summed compile-call duration per boot in
these observations; that does not attribute later engine tiering or
instantiation work. This is sequential desktop diagnostic evidence, not an
alternating, controlled comparison with 1.30 or a mobile result. A short Node
capture inspection overlaps part of the first engine's observations. No
source request, staging worker or image writer runs on ordinary reopen.

The larger mixed workload passes live and optional-checkpoint recovery on
Chromium and Firefox. WebKit passes source-free WordPress/post/media
verification, then stalls in the subsequent nested-shell guest verification;
the sixth, WebKit checkpoint case and later Node workload do not run after
that failure. Its parent prints the command START marker but no first child
printf, and the process inspector cannot complete enumeration. A complete
OPFS capture is retained. Reopening a copy through the normal Node host
verifies all 512 names, all 32 MiB of payload and nested-shell guest reads,
then shuts down cleanly without altering the capture. This argues against
assuming stable on-disk corruption; it does not explain the browser stall or
close the older intermittent post-checkpoint MariaDB readiness failure.
Subsequent private, bounded native-I/O/worker-liveness tracing reproduces a
stall in the owner-realm constructor fallback after native allocation-worker
exhaustion. The 1.32 source candidate removes that synchronous retry, preserves
the constructor failure, and leaves the kernel available for normal rollback
instead of native collection in its owning realm. Focused Node/browser refusal
and subsequent healthy-allocation checks pass. The rebuilt 1.32 cohort passes
the Node MariaDB mixed workload, all six three-engine editor/post/upload
recovery cases, and four Chromium/Firefox live/maintenance mixed workloads.
Both larger WebKit workloads fail during guest mutations: one reports an
allocation failure replacing a shell with `dd`, and the other reports
`bash: fork: Out of memory`. Neither reaches its intended recovery phase.
These are failures, not successful stress acceptance; the explicit refusal
does not solve native reservation pressure. Source, native-artifact, frozen
site and test-source audits pass after the full cohort. This does not prove
that the older Chromium readiness failure shares the same cause.

`persistent-browser-quota.spec.ts` adds actual Chromium quota-manager
exhaustion rather than replacing OPFS methods with a throwing shim. The
observer invokes the original native journal methods, records their real
`QuotaExceededError`, and rethrows it. Both CRC32C and SHA-256 cases refuse
the oversized write, retain previously durable bytes, release the failed
kernel, lift the quota, and reopen the same OPFS base and journal. The fixture
declares 64 MiB logical capacity to distinguish browser quota from a logically
full filesystem. Chromium's
[quota override](https://chromedevtools.github.io/devtools-protocol/tot/Storage/#method-overrideQuotaForOrigin)
keeps physical test allocation small. This is orderly-shutdown recovery under
browser-managed quota pressure, not physical-device disk exhaustion, browser
process crash recovery, or a claim about an unacknowledged partial write.
Firefox and WebKit continue to have injected quota-failure coverage; the new
quota-manager cases explicitly skip those unsupported protocol targets.

The remaining integrated work is startup/workload/compaction acceptance,
including the unexplained intermittent post-checkpoint MariaDB reload, then
the complete current-source release audit and draft-PR refresh. Existing 1.30
and older saved computers remain unchanged. New receipts live under
`.context/native-intake-*`, `.context/browser-managed-quota-*` and
`.context/persistence-checkpoint-1-31-*`; earlier acceptance remains historical
evidence rather than acceptance of this new source batch.

### Requirements

The expanded objective is to finish production-capable OPFS-backed VFS images
larger than runtime memory, including the remaining input-size boundaries,
logical allocation accounting and reservations, whole-system memory bounds,
crash-safe compaction and recovery, measured workload performance, the
durability and lifecycle contract, Rust/host responsibility consolidation,
and ABI-matched automated release validation on Node and all three browser
engines. Working shell and WordPress demos alone do not complete this goal.

The active goal to complete this document includes all of the infrastructure
work below. Existing demos and passing focused suites are progress, not a
substitute for these acceptance gates. Historical milestones below include
partially implemented states; the current checklist reconciles them with
actual implementation and evidence rather than rebuilding completed features.

- [x] Finish the real-page image input path: distinguish decoded container
  bytes from filesystem capacity, remove resident-buffer limits from bounded
  positioned composition, and verify fully sized small images and physical
  large v2 containers through installation, boot, and source-free recovery on
  Chromium, Firefox, and WebKit.
- [x] Finish logical capacity enforcement: bounded live block accounting,
  pre-mutation reservations, correct partial writes and `ENOSPC`, space
  reclamation after truncate and final unlink release, and rejection of file
  growth the image format cannot represent. Checkpoints must preserve both
  mounted block and inode capacities. Keep host quota and memory exhaustion
  separate from logical disk exhaustion.
- [x] Finish whole-system memory bounds for supported large writable images.
  Account for namespace metadata, sparse/allocated-block maps, validation
  scratch, statistics, recovery, and snapshots, not just the block caches.
  Replace image- or file-sized temporary allocations on streaming paths;
  document and enforce any remaining supported metadata limits. Verify peak
  memory with images larger than the configured runtime-memory budget and
  with large file counts on Node and all three browser engines.
- [x] Complete crash-safe compaction and base/journal handoff acceptance.
  Extend the existing failure matrix across write, short-write, flush,
  publication, lost acknowledgement, cancellation, owner shutdown, and
  recovery races. Preserve a verified fallback, fail closed when none exists,
  and safely reclaim abandoned stages and obsolete generations under the
  appropriate ownership locks. Do not silently reset a damaged computer.
- [x] Measure realistic persistent workloads on Node and browser: sustained
  reads/writes, peak memory, install and boot/recovery time, compaction pauses,
  large distinct-block working sets, and quota/storage pressure. Record
  configurations, acceptance budgets, and matched baselines for any claimed
  performance improvement. Close benchmark provisioning failures through the
  normal build path rather than omitting required workloads.
- [x] Retain fast boot as a release requirement. Separate initial streamed
  installation from reopening an installed computer. Ordinary reopen must
  not decompress, rewrite or hash the complete immutable image. Rust must
  validate metadata and data blocks before use with bounded working memory,
  and recover the journal without work proportional to untouched
  image capacity. Verify read-volume scaling and actual WordPress/MariaDB
  boot times on Node and all three browser engines. Preserve ordinary VFS
  imports; allow the install path to stream those into the persistent format.
- [x] Finalize the supported durability and lifecycle contract, including
  `fsync`/`fdatasync`, shutdown errors, storage quota, eviction, supported formats,
  and fallback behavior. Distinguish tested browser-process crashes from page
  reloads and from unproven OS power-loss/device-flush guarantees; do not
  promise guarantees the browser cannot provide.
- [x] Minimize the host's filesystem responsibility. Keep POSIX semantics and
  portable image/journal/index behavior authoritative in Rust. Review and
  consolidate storage-neutral generation-seal handling, journal-header
  interpretation, recovery selection, and cache policy in Rust where
  practicable. Retain OPFS handles, Web Locks, browser/worker lifecycle,
  asynchronous transport, and platform publication mechanics in the host;
  document and test any portable policy intentionally retained there.
- [x] Complete automated release validation: Rust unit and fault-injection
  tests, Node and OPFS kernel integration, persistent POSIX/conformance suites,
  shell checkpoint/recovery, and WordPress SQLite/MariaDB post/upload recovery
  on Chromium, Firefox, and WebKit. Include new tests in the appropriate CI
  inventories and keep opt-in large-image evidence and intentional platform
  skips distinguishable from the default acceptance suite. Record the final
  ABI-matched build and exact validation results before marking the goal done.

Login-cookie continuity remains deferred at the user's request. Stable
persistent HTTP identity was implemented for checkpoint 1.26 to prevent saved
media URL breakage; it is separate from filesystem-infrastructure gates.

The [current ABI-55 requirement audit](measurements/2026-10-26-abi55-persistence-acceptance.md#requirement-audit)
maps each gate to its implementation, current cohort and boundaries. Completed
memory acceptance is filesystem-scoped, includes the separately bounded
archive/host/codec/caller owners below and is not a whole-browser physical-RAM
promise. Current pressure reports cover all phases on Node and three engines;
the complete same-realm memory command passes. Crash/handoff acceptance
includes both storage models, native target-only synchronized tails and the
browser fault matrix, not OS/device power loss. Fast reopen means demand-only
checked I/O without full-base download, decompression, hashing or rewrite; it
does not claim zero I/O or a measured speedup over main. The matched comparison
and final frozen checkpoint are complete, including the documented costs and
unsupported cases, not a blanket no-regression or mobile-device promise.

### Filesystem memory acceptance ledger

The accepted memory gate is filesystem-scoped, not a requirement to redesign
signals, wake delivery or unrelated process bookkeeping. The component
inventory below defines the separate owners; the current ABI-55 requirement
audit and pressure/memory cohorts establish the bounded acceptance claim.
Historical receipts below retain their original, narrower proof boundaries.
Let `K` be the configured kernel linear-memory ceiling in bytes. The shared
host selectors in `host/src/runtime-memory-profile.ts` derive the allowances
before loading a filesystem.

| Owner | Current allowance | Accounting and overlap |
| --- | --- | --- |
| Rust namespace and inode metadata | `M = min(64 MiB, floor(K / 8))`, optionally lowered by configuration | Live metadata is limited to `M`; recovery/replacement temporary reservations have a separate `2M` ceiling. Their combined admitted maximum is therefore `3M`, not `M` or `2M`. Promotion/demotion exchanges ownership before publication. |
| Rust journal state | `J = min(32 MiB, floor(K / 8))` | Ordinary state and a separate 256 KiB writeback reserve sum to `J`; the reserve is not additional capacity above `J`. |
| Rust I/O payloads | `I = min(32 MiB, floor(K / 8))` | Ordinary I/O and a separate 2 MiB writeback reserve sum to `I`. Payload reservations charge twice allocation capacity. Checked base pages, verified deferred/archive tables and chunks, inspection, export and other admitted I/O owners compete for this shared allowance; their individual cache limits must not be added as independent pools. |
| Rust positioned ZIP indexes and decoders | Separate cache-local limits, not charged to `I` | At most 4 MiB of directory-entry backing across 64 cached indexes, plus a new transient ZIP32 index and parsing/name scratch. Two cached member readers can overlap a third active reader before eviction. Each DEFLATE reader requests two 64 KiB windows, one inflater and eight inflater checkpoints; filenames and outer-vector backing are additional owners. These allocations are not included in the five-pool admission high water. |
| Host storage metadata | `H = min(16 MiB, floor(K / 8))` | URI limits, transport bookkeeping, inspection and generation catalogs share admission. Entry/string credits model JavaScript retention; they are not measured JavaScript heap bytes. |
| Host image JSON operations | Separate per-realm 64 MiB modeled-credit pool, not included in `H` | Saved-image manifests and image-module metadata decoding/encoding share this pool. Each value has an 8 MiB raw limit and must also fit the operation pool, which charges a factor of 12 plus entry/traversal work. This does not promise every 8 MiB value is admissible. Returned objects and instance-retained metadata belong to their caller/instance after the transient scope ends. Same-name manifest operations serialize under Web Locks. |
| Convenience whole-file results | Caller-owned and separately capped | `maxVfsFileReadBytes` bounds a requested buffered result; it is not a streaming cache or part of `H`. Large-file callers must use bounded reads rather than retain arbitrary whole-file results. |
| Fixed native control work | Bounded packets and stack buffers | Journal/index inspection and source eligibility do not retain candidate tables or native handles. Seal hashing uses explicit bounded hash packets and the host's existing reusable read window. |

`MetadataBudget` enforces separate live and temporary counters; its ordinary
`usage()` still reports only the live counter. The current source exposes
`/proc/kandelo/fs_memory`, including temporary and per-owner high water and
an actual simultaneous aggregate admission high water across all five Rust
pools. Host metadata gains its own modeled-credit high water and symmetric
Node/browser inspection. The pressure fixtures collect initialization,
post-workload and post-export observations. The combined frozen-source run
passes both checking policies on Node and all three browser engines, with
nine memory observations per host/policy pair (72 observations total).
A live-only sample cannot
prove recovery overlap. Likewise, adding declared allowances does not prove
an allocator or process peak, and a sampled sum of descendant RSS is not
unique physical memory. The final acceptance must cover installation,
ordinary reopen, recovery/replacement, writeback and checkpoint/export through
completion, recording kernel high-water growth, the admitted owners and host
retention. Keep image-composer/decompression workers and caller-owned results
explicit in that measurement rather than silently attributing them to a
kernel cache. Existing component refusal/reclamation tests remain necessary,
but do not by themselves close this gate.

These diagnostic peaks are kernel-lifetime admitted credits, not allocator
bytes. Reading the proc report allocates admitted output after taking its
samples, and later samples include that observer's effect. Current-profile
peak assertions require a fresh kernel with unchanged limits; a historical
peak can legitimately exceed a later lowered limit. The generic native
budget API permits concurrent callers, but the fixture's exact sum check is
for serialized kernel entries. Host, manifest, guest and composer/codec
ownership remain separate from the Rust aggregate.

An independent read-only review of source `b2713c10c` finds no actionable
unbounded persistent payload allocation or error-path retained owner in the
checked-reader, verified deferred/archive, snapshot/export and recovery paths
it inspects. It identifies the separate ZIP owners above as an accounting
boundary, not evidence that they fit `I`. Directory parsing drops its
65,557-byte tail before allocating its reusable 65,535-byte filename buffer.
A new directory requests at most 65,535 filename-hash/offset entries before
cache eviction. Reader retention must count actual vector capacities for
names, windows, inflater state and checkpoints, not just their current
lengths. Cache-local tests and format bounds do not measure the simultaneous
third-reader overlap or allocator overhead. This source review does not
close aggregate memory acceptance, application liveness or crash safety.

The accepted memory-observation batch passes 2,904 runtime-core tests and six
compile-fail doc tests, 42 host/parser checks, four Node pressure/cleanup
checks, and six OPFS pressure cases with no retries or skips. The normal
published kernel, rebuilt resident/positioned modules and newly compiled
pressure guest are ABI 51; source/artifact audits pass before and after the
runtime cohort. The pressure image has a 96 MiB cold file and 2,048 seeded
long names, then drives namespace admission to `ENOMEM`, reclaims names and
retries, verifies an 8 GiB sparse mapping, writes/syncs an 8 MiB working set,
and exercises streamed snapshot export and strict original/snapshot reopen.
Physical checked images are approximately 106.5 MB, larger than the configured
64 MiB kernel ceiling. Both policies produce these observed maxima:

| Host | Simultaneous Rust peak credits | Namespace temporary peak credits | Host metadata peak credits | Kernel peak pages |
| --- | ---: | ---: | ---: | ---: |
| Node | 14,051,376 | 5,196,260 | 2,634,768 | 220 |
| Chromium | 14,045,142 | 5,192,596 | 2,634,768 | 220 |
| Firefox | 14,045,142 | 5,192,596 | 2,634,768 | 220 |
| WebKit | 14,045,142 | 5,192,596 | 2,634,768 | 220 |

Pages are 64 KiB; 220 pages is 13.75 MiB of grown kernel memory. Credits are
not physical bytes. Separate cohort-wide one-second process-tree samples
have no failed/truncated samples, with peak summed descendant RSS of 684,576
KiB for Node and 2,758,256 KiB for the browser cohort. These include test
harnesses, resident Node fixture generation, Vite and browser processes;
shared mappings can be counted repeatedly and out-of-tree/reparented helpers
are excluded. They are not per-computer physical peaks, mobile measurements
or evidence that all filesystem owners fit a single combined budget.
Checkpoint 1.28 integrates those native observations and now also passes
six checked-pressure cases and three positioned-composer cases across all
three browser engines, without retries or skips. The pressure cohort retains
the 220-page kernel high water. Its streamed snapshot codec grows to 22 pages
(1.375 MiB), with 64 KiB worker windows, owned caller chunks and caller chunk
backings under both checking policies. The separate 68 MiB source fixture
uses a 20-page (1.25 MiB) composer under a 64 MiB native allowance, retaining
zero resident source/frozen-source/returned-image bytes. Its manifest pool
ends at zero credits, with a 112,312-credit peak under the independent 64 MiB
pool. These are native linear-memory observations and modeled credits, not
browser heap or physical-RAM measurements. The code also bounds codec module
copies to 16 MiB each (inspection can overlap two copies), control input to
64 bytes, an owned input chunk to 1 MiB and its transfer window to 64 KiB.
The producer's original backing and iterator retention remain caller-owned.

This closes the previously missing worker/manifest/caller phase-attribution
work; it is no longer an unimplemented instrumentation task. Independent
read-only review finds no blocker in that accounting path. The broader
production acceptance still includes realistic application behavior and
ownership progress under shared I/O pressure. A real Firefox WordPress asset
burst exposed unbounded HTTP connection injection competing in that pool.
Checkpoint 1.28 adds a shared Node/browser admission gate without increasing
the pool. Checkpoint 1.29 implements token-scoped native retirement and passes
the actual Node and three-engine OPFS timeout/accept-wins workload; repeated
unaccepted timeout waves return to a stable ordinary I/O live-credit level,
while accepted endpoints remain charged until guest close. Deferred/fatal
host cleanup has focused unit coverage. Frozen checkpoint 1.26 remains
unchanged. These checks close that specific lifetime issue, not arbitrary
socket-pressure or whole-browser physical-memory guarantees.

The checkpoint's six actual WordPress SQLite/MariaDB post, upload, original
embedded-image and source-free recovery cases are accepted across Chromium,
Firefox and WebKit in two recorded cohorts. Both Chromium cases pass first;
the initial Firefox cold installation exceeds its 240-second allowance.
The separate four-case Firefox/WebKit cohort passes with a 360-second fresh
installation allowance and the unchanged 540-second overall case bound;
no testcase retry or filesystem operation retry is used. Product installation
workers reach 364 native pages (22.75 MiB) in all six observations. Reopen uses
three codec workers and no whole-image composer. These are observations
under concurrent local builds, not matched fast-boot or mobile acceptance.
An earlier private Firefox probe's PHP 500 remains unexplained; subsequent
editor/reload loops avoid the original connection refusals. That earlier
failure is retained rather than counted as a successful complete run.

The manifest pool is independent of each kernel's profile-derived host pool;
it must not disappear when summing filesystem owners. Disposable composer and
codec workers, their module copies and returned manifest/configuration owners
also remain explicit in the final phase measurements. A bounded 64-byte policy
request is not a claim that its worker has a 64-byte footprint.

### Format scope

The user explicitly excluded compatibility and migration for earlier persistence
prototypes on 2026-10-21. Version 6 is the source candidate's canonical saved-computer envelope;
unsupported older envelopes should refuse without conversion, fallback to an
older checkpoint, source-image recomposition or modification of the saved data.
Removing the remaining legacy-envelope admission paths is cleanup of that
boundary, not a migration deliverable. Historical migration proposals and their
test receipts below do not add compatibility requirements to this goal.

Normal VFS image loading remains supported. This decision concerns saved OPFS
computer metadata, not permission to stop loading ordinary product VFS images,
change guest-visible filesystem behavior or drop existing filesystem features.
Validate feature parity, corruption safety, bounded caching and persistent
POSIX behavior through the normal Rust kernel and Node/browser paths. Native
journal/index recovery and compaction are separate from the excluded browser
envelope migration work.

### Execution order and proof boundaries

The unchecked gates are acceptance requirements, not unstarted
implementations. In particular, shared metadata/journal/I/O admission and
bounded data caching are already implemented in substantial parts of the
system. The memory gate remains open because unadmitted owners and aggregate
peak measurements remain. Repeating the gate titles must not replace
identifying and finishing those concrete owners.

Finish the remaining work in three integrated batches. Keep the complete
objective above; a batch or a passing demo does not redefine completion.

Fast boot and minimal host policy are explicit user requirements reaffirmed
on 2026-10-21. The earlier candidate scanned the entire immutable base in
both host verification and kernel journal attachment. The checked-image
source candidate now replaces those normal-reopen scans with Rust-owned
demand verification and bounded caches, with OPFS reads, writes, handles,
network and browser lifecycle supplied by the host. The read-volume
regressions above cover this change; rebuilt application boot-time acceptance
remains outstanding. An
initial installation may stream the image and construct its index; normal
reopen must not repeat that installation. On-demand corruption detection
must fail a damaged block before exposing its bytes; it is not permission to
skip verification or silently fall back to stale acknowledged state. Keep
full-image scrub as a separate explicit operation, not a mandatory boot scan.
This follows established filesystem patterns rather than requiring an
archive-style boot validation pass: Linux
[dm-verity](https://docs.kernel.org/admin-guide/device-mapper/verity.html)
authenticates immutable blocks against a trusted hash-tree root when read;
[Btrfs checksumming](https://btrfs.readthedocs.io/en/stable/Checksumming.html)
verifies data and metadata as read, while a
[scrub](https://btrfs.readthedocs.io/en/stable/Scrub.html) is a separate broader
validation operation. These are design references, not claims that Kandelo
implements those filesystems, their formats or their repair guarantees.

The checking-policy comparison distinguishes crash consistency (journal commit/recovery/publication),
accidental-corruption detection, and cryptographic content binding. Choices
include whole-image startup hashing; metadata/journal-only checks; inline or
paged per-block checksums; a trusted, fully checked flat SHA-256 index with
demanded data verification; and a trusted-root hash tree with bounded demanded
proofs. Optional scrub is complementary, not a replacement for read-time
verification. CRC32C block checks are simpler and target accidental damage;
SHA-256 trees additionally bind requested blocks to an expected root, but
that root still needs its own trusted generation binding. The Rust checked
format now implements both policies, with CRC32C the selected default and
SHA-256 opt-in; existing saved computers retain their recorded choice. No checking
choice alone supplies repair redundancy or prevents rollback of every
coordinately rewritten browser-owned control record.

Checkpoint 1.20 supplies a rebuilt ABI-matched WordPress + MariaDB checkpoint
with combined validation of the accumulated source changes. The next delivery
must integrate demand-verified base reads and retain that application
acceptance while removing whole-base work from normal reopen. Do not wait for
every general kernel owner to be converted before producing a checkpoint.
Prioritize storage-sized owners: file/image caches, namespace/index/recovery
and compaction scratch, file-backed mapping snapshots and dirty-byte coherence,
and OPFS transport/generation buffers. Signals, general wake delivery, terminal
queues and unrelated host bookkeeping are broader hardening, not OPFS adapter
prerequisites. Their concrete findings are recorded in
[Future Improvements](future-improvements.md#finish-general-resource-admission-and-lifecycle-hardening).
Keep the whole-system memory gate open until its remaining ownership work and
measurements are actually complete; delivering an interim checkpoint does not
close it. The batches below organize acceptance, not a requirement to postpone
all real-application validation until every memory owner is finished.

1. **Memory ownership and admission.** Finish returned metadata/checkpoint
   ownership, the recovery base-plus-live namespace overlap, snapshot/image
   writer traversal and retained structures, FIFO registration/rename/table
   and recovery aliases, fd/OFD path transfer, and host URI/transport/generation
   bookkeeping. For each owner, identify its allocation, admission before
   allocation, publication, rollback and release points. Admission must fail
   with a truthful resource error before durable/live publication, preserve
   accepted dirty data and the prior namespace, and permit retry after reclaim.
   Audit the combined resident and temporary allowances against each supported
   kernel profile rather than treating independent limits as a total bound.
   Validate both large-file and many-file exhaustion; sample actual Node and
   Chromium/Firefox/WebKit process memory throughout install, boot, workload,
   compaction and recovery. Kernel page counts are separate evidence.
2. **Recovery policy, fault coverage and lifecycle.** Review the publication
   state machine independently, consolidate portable header/seal/generation
   policy in Rust where practicable, and test the full write/short-write/flush/
   publication/lost-acknowledgement/cancel/shutdown/recovery-race matrix for
   both image checkpoints and journal compaction. Each cut must recover the
   latest acknowledged durable state or fail closed, retain a verified fresh
   fallback until it is safe to retire, and reclaim only owned obsolete data.
   Finalize the supported sync, shutdown, quota/eviction and format-upgrade
   contract against the implementation and tests. Document actual browser
   boundaries rather than inventing power-loss guarantees.
3. **Measured product and release acceptance.** Freeze an ABI-matched candidate
   and record artifacts, configuration, workload sizes and acceptance budgets
   before measuring. Run sustained and distinct-working-set I/O, install/
   recovery and compaction-pause measurements with matched Node/browser
   baselines and storage pressure; run real persistent shell and both WordPress
   variants. Finish the CI inventories and relevant complete conformance/
   release suites, explicitly classifying unsupported or missing products
   instead of hiding them behind a selected cohort. Reconcile every unchecked
   milestone with this evidence before closing the goal.

Prefer compile checks while implementing a batch. Use focused regressions to
resolve a concrete failure or protect an admission/publication invariant, not
as a separate exhaustive validation milestone for every owner. Accumulate the
remaining coverage and run combined regression acceptance once the related
source is frozen. Do not rebuild the product graph for every small ownership
change. An independent review is a defect-finding step, not a substitute for
measurements or full acceptance.

At the user's request on 2026-10-20, maximize implementation batch size rather
than creating another delivery checkpoint for each owner. Finish the related
fd/OFD, FIFO and host-bookkeeping work, plus their aggregate budget integration,
before the next memory-batch product rebuild. During implementation, use compile
checks and focused admission, publication, rollback and release regressions;
retain byte-format and crash-safety invariants. Run the combined native, Node,
conformance and all-engine browser acceptance once per completed batch, fixing
actual failures without restarting unrelated suites. Reserve complete release
validation and matched performance measurements for the final integrated
candidate. Existing static checkpoints remain available while source work
continues; they are not acceptance evidence for later source changes.

The memory batch now includes admitted FIFO registry names/prepared nodes,
pre-namespace rename/hard-link plans, staged all-or-nothing registry/alias
restoration, retained pipe-arena capacity and fallible anonymous/socket/FIFO
payload allocation. Active FIFO payloads join the existing ordinary I/O pool
instead of a separate 16 MiB allowance. Live rootfs FIFO links and directory
renames update the same registry as other mounts. Pair allocation and syscall
descriptor reservations refuse without a half-published pipe or leaked fd;
host-stdin payload/slot refusal precedes closing fd 0. Focused native ownership
regressions cover this candidate; it is not yet product/Node/browser accepted.
Recovery now prepares the projected namespace's FIFO registry before
namespace-credit exchange or publication. Created-inode slots, sorted replay
changes, pending base metadata and final link counts are projected with
admitted index/depth/path scratch rather than copying the rootfs. Failed
preparation leaves both views unchanged and permits retry on the same base;
publication preserves foreign registrations and open old backing without
fallible FIFO work. Focused native regressions verify projection against
committed state, staged-node failure/retry, publication at a full I/O allowance,
depth-bounded traversal and pristine recovery retry. OFD slot arenas, immutable
shared paths, shared mutable scalar state and initial sidecar boxes now own
ordinary I/O credit. Creators prepare these before file mutation, device
claims, accept-queue removal or backing-reference transfer. Blocked FIFO opens
retain prepared descriptors until completion/cancellation. Host directory
iteration admits name storage before consuming an entry and moves it into
pending state without allocation; child copies reopen at the shared cookie
instead of cloning pending names. Evdev opens and fork-state decoding also
admit the complete fixed-capacity input ring before publication; shared aliases
retain its payload credit and event fanout no longer allocates a seen-ring
list. Focused native regressions cover admission,
rollback, retained rights, pending-entry retries and connection retry after
descriptor refusal. Retained SCM_RIGHTS arrays, stream-carrier queue slots,
blocked-send templates and receiver descriptor-index outputs now carry I/O
credits too. Peeks prepare before copying bytes, and control truncation drops
excess rights without a suffix allocation. Shared host-handle count nodes are
admitted, with grouped fork/spawn preparation before reference mutation and
allocation-free publication. Datagram queue slots/payloads and decoded
msghdr/iovec/control records now have ordinary I/O admission too, including
retained vector requests and bounded receive staging. Gather no longer holds
another full iovec copy. Control output uses a fixed 4 KiB stack window, and
failed output cancels newly received descriptors without disturbing existing
process locks. Targeted native tests cover both caller widths, refusal/retry,
wire chunk boundaries, UDP versus reliable-Unix queue policy and descriptor
rollback. Descriptor-backing arenas, memfd payloads, procfs snapshots and epoll
interest/scratch/output storage now join ordinary I/O admission. Growth refusal
preserves memfd append position, bytes and generation, including mapped pins;
procfs formats directly into admitted bytes. Allocation-free watched-fd/nested
epoll queries preserve readiness at a full allowance, and terminal retry
preparation errors restore only the matching temporary signal-mask context.
Process inspection avoids PID/name/first-pass cmdline copies. Remaining owners
include remaining process/address-space ownership and fixed-ABI wrappers,
canonical namespace scratch, wake delivery and JavaScript host
bookkeeping. Graphics registry/handle/framebuffer maps, pending-flip/completion
storage, fallible sidecar copies/decoding, DRI mmap bindings and GL-query
staging now also join ordinary I/O admission. Page-flip acceptance prepares
future completion capacity before host scanout/statistics; vblank retirement
does not allocate at a full allowance. Host graphics payload/reservation
accounting and whole-system peak validation are separate obligations. No new
product checkpoint or broad release-matrix rerun is required before finishing
those related owners.

Socket arenas, nested options/names/multicast state, shared accept queues,
INET binding/owner arrays, network-handle reference nodes and AF_UNIX registry
names/nodes/owners now also join ordinary I/O admission. Socketpair and connect
prepare metadata/queues before pipe or connection publication; accept prepares
its socket before consuming a queued connection. Child copies and decoding are
fallible, while consume-once queues retain their existing inheritance policy.
Bind and directory/socket rename prepare registry changes before VFS mutation;
successful rename transfers existing owners without another allocation.
Production IPv4 UDP endpoint enumeration no longer collects a temporary list.
These are shared Rust/host-Wasm paths, not new protocol support or current
Node/browser application acceptance. Canonical namespace scratch, wake/host
bookkeeping and actual simultaneous peaks remain part of the memory batch.

Legacy guest staging, opaque-record input/decoded arrays and pre-dispatch
copy-back plans now retain ordinary I/O credit. Copy-back snapshots every
source before publishing outputs and cannot need a new allocation after the
operation. SysV input compacts its type prefix in place; copy-out uses a fixed
header and owned body without post-dequeue allocation. Blocked-retry arenas
and retained SysV inputs are admitted, including an initially empty preflight
binding's first snapshot and terminal retention-refusal handling. Legacy
directory-stream arenas/paths, virtual listings/PID cohorts, returned inspection
metadata, deduplicated lazy URI cohorts and encoded snapshot caches also carry
credit; EOF releases cached ownership. Epoll wake-index output drops its extra
temporary vectors. Targeted native and Wasm compile evidence covers this source
candidate, not a new product checkpoint or whole-memory acceptance.

Retained POSIX/SysV IPC table nodes, names, descriptors/pins, message payloads
and slots, semaphore arrays/outputs, shared-memory bytes and semaphore-operation
staging now also spend ordinary I/O credit. Creation and pin counters commit
only after preparation. Pinned SysV removal transfers the existing node into
generation retirement without allocation; final release frees the original
owner, and stale pins cannot follow a reused public ID. Scoped review finds a
detached-node AVL-height bug exposed by transfer; all extraction paths now
normalize leaves, with structural and full-allowance transfer regressions.
Existing IPC lifetime/process-sharing behavior is not redesigned or claimed
complete by this admission work.

Process mmap/reserved-region arrays, fork mapping decode, SysV attachment
records, thread-record arenas, POSIX timer slots and returned timer-cleanup
cohorts now also own ordinary I/O credit. Fixed mapping replacement and moving
remap prepare all required records before changing existing intervals; middle
unmap prepares before device unbinds. Trims/removals, fixed replacement within
retained capacity and timer-hole reuse need no new allocation. Thread capacity
prepares before consuming a task ID. Cleanup arrays prepare before draining
alarm/notification state, and credit follows drained owners until release.
Shared mapping coherence stores, nested signal owners, remaining process
metadata and host tracking still require integration and peak measurement.

Argv/environment payloads and slot arrays, staged replacements, fork/exec
decoding and saved fork actions now also carry ordinary I/O credit. Spawn
prepares new metadata before consuming an identity or executing file actions;
limbo retention moves existing owners without copying. CWD shares admitted
immutable OFD paths, with allocation-free root/empty representations and
fchdir aliasing. Supplementary groups use their existing fixed 32-ID inline
limit rather than per-transition heap allocation. Metadata refusal preserves
the live pair, CWD and environment entries; prepared pair commit allocates
nothing. Reserved init creation propagates refusal before publication.
The approved ABI 51 batch includes a result-bearing `kernel_push_argv` and
matching libc declarations/error handling. Channel-worker legacy mutation
returns `ENOSYS`, not false success. Current source/kernel ABI checks do not
replace rebuilt libc, product or Node/browser acceptance.

Process-table inline records and listener cursor nodes now also own ordinary
I/O credit. Physical node allocation precedes task-ID allocation; inherited
resource references publish only after complete node preparation. Limbo reuse
retains the original node. Removal moves existing resource arenas into its
finisher and streams ordered close effects rather than allocating teardown
vectors. Rust owns final-reference cleanup, deferred PRIME backing destruction
and framebuffer/mouse/clipboard release. PID-group delivery and listener
selection no longer collect temporary cohorts; cursor admission refusal is a
truthful error before selection publication. Focused native and Wasm source
checks do not establish current Node/browser application acceptance or actual
memory peaks. Nested signal/wake owners, remaining shared-mapping coherence
stores, namespace scratch and host tracking/peaks remain in this memory batch.

Independent storage-path review exposed a preexisting same-page writeback
retry defect: retaining a dirty whole page could overwrite a newer descriptor
write to a different byte. A native regression reproduces the lost byte.
The source fix tracks admitted dirty-byte masks, retires successful write
prefixes, refreshes clean bytes on generation changes, and advances comparison
snapshots as bytes enter the backing. It also preserves partial publication
progress and drops dirty bytes invalidated by truncation. Combined release,
Node/browser persistence and workload validation must cover this candidate;
mapping-sized snapshots and cache payload admission remain unfinished.
An actual-library native admission probe confirms the production-sized
owner gap: after ordinary I/O admission is exhausted (and a new one-byte
`IoBuffer` correctly refuses), `FileBacking::read_range` still returns an
8 KiB snapshot and retains two new cache pages. That API is called by file
mapping creation, refresh, remap and fork. The probe uses a synthetic I/O
provider, so it establishes missing admission in that Rust owner, not an
observed guest or browser crash. Snapshot and cache-node allocation must
refuse before publication and release credits with the actual last owner.
An allocation-instrumented native diagnostic also reproduces a concrete
failure-path gap in the current `FileBacking::reload_range`: refreshing a
4 GiB range with only one resident page, then refusing its read, allocates
8 MiB to enumerate the entire page span for invalidation. The diagnostic
links the actual freshly checked runtime-core library; it is not browser
or guest evidence. Current caller tracing finds `reload_range` used only
by tests, so this does not establish a live guest failure. Prioritize the
production `read_range`, mapping publication, remap and fork owners first.
Range refresh and failure invalidation must walk resident
cache entries, not every logical page, and preserve dirty ownership without
allocating a failure-only cohort. This is part of the remaining storage
memory batch, not a reason to postpone the already frozen demo candidate.
Rootfs/tmpfs truncation and truncating opens, and memfd truncation, notify
mapping ownership immediately after successful publication. This prevents a
shrink followed by regrowth between reconciliations from resurrecting truncated
dirty bytes. The notification path invalidates without new allocation.
The 90-case focused native selection covers the retry, partial-write,
admission/refusal, publication-progress and truncation cases plus corrected
integrated admission fixtures. This is not Node/browser or reboot acceptance.

The frozen checkpoint 1.13 Rust candidate passes 3,378 workspace cases.
The separate xtask run passes 714 unit and six integration cases; its two
isolated child invocations are not counted again. ABI 51 and current SDK
checks pass. Two focused Node selections add 192 portable storage/protocol
tests and 84 mapping/inheritance tests, with no skips or failures. The latter
includes a real guest exercising kernel-owned shared files and fork; the
other mapping cases use host harnesses. The portable selection includes the
compaction crash-cut model, not real browser-process crashes or OS power loss.
Source and kernel/image-module artifact hashes stay unchanged across both
selections. The complete 87-case Node persistent-rootfs file also passes with
no skips, covering guest recovery, indexed compaction, open-unlinked backing,
allocation/metadata pressure and storage failures. Its source and runtime
artifact hashes match before/after. Prepared-product tests use the documented
source-first resolver tiers, with explicit current-kernel and fresh-fixture
path assertions; the builder-only source-only policy intentionally excludes
these unowned test fixtures. The remaining prepared-product Node inventory,
WordPress + MariaDB browser acceptance and
whole-memory measurements remain pending. These results do not close the six
production gates.

The next storage-memory source batch is now underway while checkpoint 1.13
remains available. A freshly compiled ABI 51 guest creates an 8 GiB sparse
file under a 64 MiB kernel ceiling, successfully maps and syncs a small
high-offset window, then traps the kernel when requesting a 64 MiB shared
mapping instead of receiving `ENOMEM`. This is a real guest-level refusal
defect, not only a logical accounting gap. Remaining intermediate release
runs were stopped after preserving completed evidence so the implementation
can address this known defect before the next combined acceptance boundary.

The source now admits mapped-file cache pages and nodes, evicts only clean
pages under pressure, stages refresh replacements with fallible admission,
and invalidates failed refreshes without allocating a logical-page list.
Changed-run discovery is streaming and file publication uses fixed page
scratch while preserving accepted prefixes on later read failure. The
84-case native mapping selection and nine I/O-buffer cases pass. A targeted
native refresh diagnostic's largest single allocation changes from 8 MiB
to 4 KiB for its one-resident-page, 4 GiB-range failure scenario. This is
that diagnostic only, not a process-memory peak or application benchmark.

The subsequent source chunk admits retained comparison snapshots and
anonymous backing bytes, fork replacement/rollback payloads, refresh cohorts,
and file/SysV mapping registry nodes through the shared I/O pool. Fork stages
its child maps and all overwritten bytes before publishing child memory or
backing references. File mapping preparation now precedes VM allocation in
the Rust channel dispatcher; successful host registration consumes the
prepared snapshot and nodes. Cancellation releases the pending backing pin.
Middle-unmap splits prepare their right-hand snapshot and node before the
VM changes; commit updates that prepared slice from the current comparison
snapshot without allocation. Remap stages authoritative bytes before the VM
changes and retains the old tracker until the new process write succeeds.
No additional kernel imports or exports were introduced; this remains ABI 51.

The complete native mapping selection now passes 90 cases. Both private
allocation diagnostics pass, including the strengthened cached-page test:
with ordinary I/O credit exhausted, an 8 KiB returned snapshot now refuses
with `ENOMEM` rather than escaping admission. The unchanged refresh scenario
still has a 4 KiB largest single allocation. A fresh ABI 51 kernel and C
fixture were built through the normal source-only graph and SDK path.
The new Node regression passes, using 151 kernel pages in both initial boot
and strict fresh-worker recovery. The corresponding OPFS case passes on
Chromium, Firefox and WebKit. Each exercises an 8 GiB sparse file under a
64 MiB kernel ceiling, oversized ordinary/fixed maps and remap refusal,
continued writes to the original mapping, and strict fresh-worker recovery.
Thus the oversized-mapping trap is corrected in that tested source prefix;
this is not physical-large-container or complete product acceptance.
Source and artifact checks for the recorded candidate inputs match around
the browser run. Checkpoint 1.13 still contains the earlier frozen candidate.

A subsequent native full-credit diagnostic reproduced an unreported
teardown loss: publication refused before scanning the process, the mapping
was dropped, and no loss record remained. The followup checks unpublished
bytes using fixed scratch after failed publication, before releasing the
mapping, and reports the failure. Clean mappings and successfully published
stores whose import alone failed do not produce false loss records. This is
loss detection, not a guarantee that an unsynced store survived an exhausted
resource. The same independent diagnostic now observes the loss record.
The host also moves `munmap` publication before VM mutation, returning its
actual errno while preserving the old mapping when publication refuses.
Flush and teardown walks no longer clone mapping/key cohorts. The complete
native mapping selection passes 93 cases; the complete host mapping-harness
file passes 64 cases. The two allocation probes and the teardown diagnostic
pass, and the kernel Wasm compile check passes. This followup source has not
yet been rebuilt into a new kernel/product demo or browser-accepted.

Checkpoint 1.14 completes the next related mapping-ownership chunk. File and
anonymous backing registries now prepare admitted nodes and identity strings
before retaining handles or publishing mappings. Process mapping registries
own their teardown guard from registration; exit no longer allocates a
separate releasing-process set. Adapter extent queries use scalar bounds
instead of allocating a per-process extent map. SysV version bookkeeping is
admitted before publication and reclaimed after the last attachment, with
streaming synchronization and pre-admitted fork rollback storage.

Prepared file mappings bind to an exact process, address and source handle.
Host registration cannot consume a different preparation or allocate a new
snapshot after the VM mutation. If nonfixed `mmap` cannot grow the process
memory, the host rolls back the new VM reservation through `munmap`, which
also releases its prepared backing pin, before returning `ENOMEM`. An
unproven rollback fails the kernel generation rather than continuing with
unknown VM state. This remains ABI 51, with no new import or export.

The complete native mapping selection passes 97 cases. The complete mapping
and scratch-transfer host files pass 249 cases, including genuine process
`WebAssembly.Memory.grow` refusal and exact VM rollback ordering. The frozen
checkpoint's full native workspace run, excluding xtask, passes 3,396 tests
across 46 result groups with no ignored or filtered cases. The ABI check,
SDK/sysroot bootstrap, host build, 136-node shell/WordPress/rootfs product
graph and all 228 normal C fixture builds complete. Browser site assembly
initially rejects an unowned optional Ruby image in the SourceOnly closure;
building the four optional browser products through their normal recipes
corrects provisioning without mixing artifact tiers or weakening provenance.

Checkpoint 1.14 now serves freshly built shell, WordPress SQLite and WordPress
MariaDB images. Its new sparse-file mapping/refusal/strict-recovery case passes
on Node and Chromium, Firefox and WebKit. The Node case selects one of nine
tests; the browser selection runs three cases without skips or retries. The
broader rebuilt Node selection passes all 714 cases in 24 complete files,
including the opt-in physical-large-image fixtures. All 70 selected persistent
Sortix reboot cases pass without skips or failures. The persistent Open POSIX
fsync/munmap selection has eight passes and two documented Wasm page-revocation
expected failures; it is not the full POSIX inventory.

MariaDB post/upload checkpoint and source-free restart, and actual media-library
upload/oversize rejection, each pass on all three engines. The mixed
database/512-file/8 MiB blob workload passes on Chromium and Firefox but fails
on WebKit after checkpoint: its preview contains a nested Kandelo shell whose
kernel construction reports `Out of memory`. This is an observed browser
execution failure, not evidence of corrupted snapshot bytes or a proven root
cause. The run captures both generations, manifests and journal before cleanup.
A navigation-instrumented run of the unchanged WebKit case passes; that does
not waive the original failure. A subsequent three-repeat diagnostic has one
pass and two failures before any checkpoint: a terminal command stalls during
guest mutations, and another run stalls waiting for login completion. Preserve
these separate symptoms rather than attributing every failure to checkpoint
corruption or the nested-preview observation. The other-demo selection has
nine passes, two
intentional non-Chromium crash-test skips and one WebKit shell-checkpoint
failure: its PCM AudioWorklet does not acknowledge transport detach. Both
failures remain active acceptance defects, not deferred general hardening.
Evidence uses `.context/persistence-checkpoint-1-14-{node,sortix,posix}.log`
and the `app-{mapping,mariadb,media,workload,other-demos}.{log,json}` reports.

A separate combined-pressure guest holds a 512 KiB shared mapping into an
8 GiB sparse file, streams 8 MiB of distinct writeback data and creates
long-name files until `ENOMEM`. It reclaims 64 names, successfully retries
creation and mapped writes, then verifies accepted names and all data in a
strict fresh-worker recovery. The private SDK-built probe passes on Node and
all three OPFS engines, using 243 kernel pages initially and 159 on recovery.
Node retains 4,025 names after reclaim; each browser retains 4,021. This proves
that combined workload, not all simultaneous admission limits or aggregate
host/engine memory. Its first private browser run failed because its relocated
config launched Vite from the wrong directory; fixing that harness path yields
three passes without changing runtime behavior. The probe is now a normal
`programs/persistence-aggregate-pressure.c` fixture, classified with the other
runtime-only programs by `scripts/build-programs.sh` and parameterized in the
existing Node and OPFS capacity regression files. The normal build compiles
and stamps 229 programs. Both selected Node mapping/pressure cases pass, with
eight unrelated cases filtered; all six browser cases pass without skips or
retries. Source, new guest and the earlier checkpoint's runtime artifact
receipts match around this acceptance. No runtime source or ABI changed in
this regression-only followup. Evidence uses
`.context/persistent-aggregate-regression-{build-programs,node,browser}.log`
and its browser JSON report. This adds CI-discovered coverage in existing
test files; it is not a fresh run of the entire 714-case Node selection or a
claim that the WebKit application failures are fixed.

Backing and mapping ownership improvements do not establish an aggregate
process-memory bound: remaining namespace/URI
owners, profile overlap, actual peaks, full-credit publication/reclamation and
the complete product/release inventories still need acceptance. Existing
static checkpoints and user OPFS computers were not modified.

The normal ABI 51 shell, WordPress SQLite and WordPress MariaDB image build
now completes, with a running checkpoint 1.13 preview. The selected persistent
POSIX fsync/munmap cohort reports eight passes and two expected failures,
with no unexpected failures, skips or timeouts. Actual MariaDB media-library
upload, checkpoint, source-free reload and uploaded-byte verification pass
on Chromium and WebKit. Firefox's first attempt times out waiting for an
upload response; an instrumented rerun of the unchanged case passes. That
initial failure is unresolved and is not waived. The mixed MariaDB/512-file
workload passes on Chromium and Firefox, but WebKit times out during final
guest-file verification after source-blocked reload. Its cause is not yet
established; do not infer corruption or successful completion from a
Running UI status. The complete combined product
and release inventories remain required; publication alone is not acceptance.
The failed WebKit run's actual checkpoint image was captured with its
manifest and verified digest. Independent Node boots, including strict
fresh-worker journal recovery, verify its 512 files, hard links, symlink,
permissions, command-substitution pipelines and 8 MiB blob checksum. This
supports those captured checkpoint bytes; it does not explain or close
the browser execution stall or establish MariaDB-level recovery for that
captured image. The diagnostic uses the desktop kernel ceiling: an initial
64 MiB attempt truthfully refused its smaller metadata budget.

Fresh dense and near-dense images containing files larger than 32 GiB also
pass actual guest writes, sync and strict fresh-worker recovery on Node
with a 64 MiB kernel-memory ceiling. The four boot/recovery observations
use 230/182 pages for each image (64 KiB per page). Source and runtime
artifact hashes match before and after. This proves those bounded-kernel
large-file paths, not a whole-system memory bound or browser OPFS behavior;
The complete selected prepared-product Node batch now passes 523 cases in
23 files without skips or load errors, including the large-file suite and
stored/deflated large archive members under the same 64 MiB kernel ceiling.
The persistent-reboot Sortix selection also passes all 70 cases, with no
skips, build errors or timeouts. Source and runtime/product artifact hashes
match before and after. These selected integration/conformance results do
not replace browser, workload-performance or complete release acceptance.

The broader pre-fix browser storage run reports 270 passes, 21 failures
and three physical-large-image opt-in skips across all three engines.
Eighteen failures expose held leases after expected initialization
refusal; three are an outdated seal-version assertion. The correction
registers raw OPFS close obligations before validation or generation
publication, preserves failed closes, and drains admitted snapshot
operations before storage retirement. Only a settled initialization
rejection from the exact current Worker permits the existing bounded
cleanup handshake. Missing, rejected or malformed acknowledgements still
retain leases; terminating a browser Worker alone is not closure proof.

The integrated correction passes 110 unit/proxy cases, the actual host
JavaScript/declaration build, and ABI 51 validation. A further 57 targeted
browser cases pass without skips on Chromium, Firefox and WebKit. They
include every previously failing case plus native provisional/early-init
close failures and pending snapshot acquisition during shutdown. An
independent read-only review finds no concrete new P1/P2 ownership defect
in this scoped correction, not a production or whole-memory signoff. All
six recorded kernel/image-module/guest Wasm hashes remain unchanged;
the covered source delta is browser-host code and tests, not Rust, ABI
or SDK inputs. The complete corrected browser file, rebuilt application
acceptance and the remaining release gates are still required.

Implementation proceeds in large related batches, using cheap compile checks
and targeted regressions for concrete allocation/publication invariants.
Run combined native, Node, conformance and all-engine WordPress + MariaDB
validation at integrated candidate boundaries, rather than rebuilding per
owner. The accumulated changes now need such a boundary and a rebuilt product;
remaining general signal/wake hardening must not keep deferring it. This changes
validation scheduling, not the goal's completion criteria; source checks are
not running-checkpoint acceptance.

Deliver concrete running checkpoints while continuing implementation, as the
user requested. Every checkpoint must identify exactly what changed, provide
live Kandelo URLs and manual commands/actions with expected results, identify
the validation actually run and its limitations, and leave the previous
checkpoint usable while the user tests. Delivery checkpoints are: (1) real
persistent computers plus FIFO wait ownership and recovery-freshness refusal;
(2) integrated memory progress with large-image/many-file pressure and measured
peaks, explicitly identifying any still-unproven whole-system bounds;
(3) remaining crash/lifecycle acceptance and portable Rust policy;
(4) measured workloads and complete release acceptance. They map to the same
six gates, not a smaller replacement objective. Local live links and detailed
user steps for checkpoint 1 are recorded in
`.context/persistence-checkpoint-1.md`; generated screenshots and evidence stay
under `.context/`, not in the published product.
WordPress with MariaDB is the required real-application acceptance workload for
every checkpoint; a shell-only demonstration cannot satisfy delivery. Its
published post and uploaded bytes must survive image checkpoint/reboot and
subsequent source-free recovery. Retain the shell as a secondary smoke test.

The current source audit still identifies implementation work, not just missing
measurements: remaining process/address-space ownership, fixed-ABI wrappers,
canonical namespace scratch, wake delivery and
JavaScript host bookkeeping remain owners to admit.
Retained descriptor-transfer containers and shared host-handle reference
records now have scoped admission/publication fixes, as do OFD arenas,
paths, shared scalar state, initial sidecar boxes and retained directory names.
Decoded control/vector and datagram ownership also have scoped native evidence,
as do shared backing arenas, memfd/procfs payloads, epoll storage, nested
DRI/KMS metadata/completion storage and socket/connection ownership, not
whole-system acceptance. FIFO registry preparation is now
transactional and precedes recovery namespace publication. Its projected
recovery path still requires combined Node/browser acceptance. Export
traversal/writer and returned metadata owners have scoped admission fixes;
their remaining obligation is combined pressure/peak acceptance, not another
implementation of the old unadmitted structures. These belong to batch 1 and
must be finished with their publication/release paths. The existing
durable-snapshot crash-cut model tests
before/after storage-operation boundaries but does not by itself cover torn
or short writes inside an operation, or all lifecycle races in batch 2.

### Current demo and large-image acceptance

Checkpoint 1.15 (2026-10-21) is a new ABI 51 static preview at
`http://127.0.0.1:57238/`, with separate persistence names and unchanged older
previews. Its normal host/product/site build succeeds in 6m52s with source
and artifact receipts checked after assembly; native Rust/libc/ABI inputs
match the accepted 1.14 prefix. The new source contains shared host storage
metadata admission, streamed generation discovery, final-sync-safe spool
cancellation and reclaimable deferred-read wait listeners. Its WordPress
MariaDB URL and manual post/media/checkpoint instructions are in
`.context/persistence-checkpoint-1-15-{urls.json,status.md}`. HTTP delivery is
verified. Combined job `persistence-checkpoint-1-15-acceptance-1021-015210-9566`
is terminal after 28m28s: all 376 enabled Node checks pass in 17 files, with
two physical >32 GiB opt-in cases unprovisioned; raw OPFS passes 52/54, with
two WebKit PCM detach-acknowledgement failures. The real application run has
14 passes, two intentional non-Chromium browser-process-crash skips and two
failures: Firefox's media-library uploader waits for a response to its first
tiny PNG, and WebKit's shell checkpoint fails PCM retirement. Both WordPress
database variants pass post/upload source-free recovery on every engine;
the mixed MariaDB workload also passes on every engine. Those passing runs
do not establish a fix for the earlier intermittent WebKit failures. Source,
artifact and site receipts match after acceptance. The canonical source-only
import-closure guard passes against the complete evidence classification.
This delivery does not close the memory, crash-fault, durability, benchmark
or release gates. The accepted source freeze ended before adding bounded
uploader/network failure diagnostics to the normal media test; that test-only
change does not alter the static checkpoint or relabel the failed run.
The single Firefox diagnostic rerun
`persistence-1-15-firefox-media-diagnosti-1021-022236-93a4` passes in 1m42s
against that unchanged site, including media-library upload, oversized-request
rejection and checkpoint recovery. Its test/helper and artifact/site receipts
match afterward. No runtime fix was made: the earlier first-PNG timeout stays
an unexplained intermittent failure, not a quota or corruption diagnosis.

On 2026-10-18, normal targeted provisioning completed the current ABI 51
shell, WordPress SQLite and WordPress MariaDB product closures. The build
reused 114 nodes and published 20, with all 134 selected nodes successful in
1h25m. It did not rebuild the whole product registry. A browser-only retention
option is passed inside the dev-shell boundary rather than changing its
global keep-list, avoiding unnecessary invalidation of every package's
declared toolchain inputs. No guest was restamped to bypass compatibility.

Matched acceptance `persistent-current-demos-acceptance-1018-181046-bc9f`
passes in 22m40s:

- All eight Node statistics cases pass with both >32 GiB fixture options
  enabled, including strict dense/near-dense recovery under a 64 MiB kernel
  ceiling, streamed archives, long-running deferred reads, logical capacity
  and the previously stale shell-image `statfs` case. There are no filters or
  skipped cases in this complete file.
- Shell write, sync, reload, append and checkpoint recovery passes on
  Chromium, Firefox and WebKit. Chromium additionally passes an actual
  browser-process crash/relaunch. That CDP-only case is explicitly skipped
  on Firefox/WebKit, not represented as a tested process crash there.
- Both WordPress backends pass published-post and byte-identical PNG-upload
  recovery on all three engines with the source image blocked. Chromium
  crashes/relaunches the browser; Firefox and WebKit reload the page.
- Including the three cross-origin-isolation cases, the full browser
  selection records 13 passes, two documented platform skips, no failures,
  retries or flaky results. ABI 51, thirteen unchanged runtime artifact
  hashes, twelve unchanged implementation/test source hashes and all three
  new image hashes pass before/after verification.

The compressed shell image is about 1.6 MiB; the SQLite and MariaDB images
are about 39 and 42 MiB respectively. Those are transport sizes, not logical
disk capacity, kernel memory or peak RSS. The >32 GiB paired boots take
about five minutes per case and are correctness evidence, not a fast-boot
or throughput claim. During the browser selection, guarded teardown reclaims
18 new writable-stream staging copies (979,460,096 allocated bytes) and its
isolated WebKit data-store home, leaving preexisting shared browser data
untouched.

Evidence is `.context/persistent-current-demos-{build,node,browser,abi}.log`,
`-browser.json`, `-images-sha256.txt`, `-images-after.log` and the
`-acceptance-{artifact,source}-{before,after}.log` files under the same prefix.
The current MariaDB screenshots are `.context/persistent-mariadb-demo.png`
and `.context/persistent-mariadb-decompression.png`.

This supersedes the earlier in-progress notes that these three demo closures
still need rebuilding. It does not complete the six remaining production
gates. Other, unselected catalog images remain unprovisioned; their optional
Vite imports report missing `nginx-vfs`/`nginx-php-vfs` artifacts in this run.
Those diagnostics are not hidden or treated as full-catalog acceptance.
Whole-system memory admission, the complete crash/handoff matrix, realistic
performance/RSS, durability/lifecycle policy, portable-policy consolidation
and full release/conformance acceptance remain required.

### Retained base-directory memory admission

The compaction set of original base-directory keys now has fallible resident
admission. Previously it cloned keys into an unbudgeted standard B-tree,
including inserts after durable namespace commit. Rust now prepares owned
names and individually allocated AVL nodes before committing, then publishes
those retained-key nodes without allocation. Recovery prepares the same set
before changing the live namespace. Compaction pruning reuses the existing
nodes and releases credits.
Mutation admission exchanges temporary name/node credits with removed-name
credits before commit, reverses the exchange on write failure, and consumes
the removed credits during publication. Existing full-budget unlink and native
same-budget rename/recovery assertions remain unchanged. The real 32-rename
Node/browser scenario now uses 80 KiB instead of 64 KiB, still requiring
recovery/checkpoint at exactly its creation budget and rejection at 8 KiB.
Previously uncharged retained keys now consume resident space: the first
browser selection rejects the 64 KiB workload on all three engines; a focused
Chromium diagnostic reports `ENOMEM` at rename index nine. Raising this
fixture's explicit budget does not weaken admission or pretend that the
original 64 KiB workload still fits.
Ordered membership remains logarithmic; the implementation does not replace
the tree with a linearly searched or shifted directory vector.

Current ABI 51 acceptance
`persistent-retained-dirents-release-1018-185627-6344` succeeds in 39m21s:

- 3,163 native Rust workspace tests pass, excluding xtask, with no failures
  or ignored cases; the Wasm runtime-core check also passes. Four new AVL
  tests cover adversarial ordering, bulk pruning/rebalancing, credit release,
  duplicate preparations, exhaustion and an injected null node allocation.
  A new rootfs case covers commit-error credit rollback at the resident limit,
  full-budget unlink, and unchanged plain/indexed recovery after denied
  retained-key admission, followed by a successful retry.
- Five complete Node files pass all 277 cases with both >32 GiB fixture
  options enabled, no filters or skips. Both large-image paired boots remain
  within a 64 MiB kernel ceiling at `[238,182]` pages. This is not process RSS.
- Thirty selected OPFS kernel cases pass across Chromium, Firefox and WebKit,
  including same-budget rename/recovery/checkpoint, metadata exhaustion,
  orphan compaction and 8,192 distinct-block replay; no skips or retries.
- Seventy selected strict-reboot persistent Sortix cases pass, with no
  failures, expected failures, build failures, skips or timeouts. This is
  selected filesystem/I/O coverage, not the entire POSIX conformance suite.
- Fresh normal product provisioning succeeds for all 134 selected nodes,
  publishing five and reusing 129. The shell and both WordPress backends pass
  real post/upload or shell-write recovery on all three engines. Including
  cross-origin isolation, the demo selection has thirteen passes and the two
  intentional Firefox/WebKit CDP shell-crash skips, with no failures or flaky
  results. Reload and process-crash coverage differ as described above.
- ABI validation passes unchanged at 51; ten implementation/test source
  hashes and thirteen runtime/demo artifact hashes match before and after
  integration. Both browser cohorts reclaim their new staging files and
  run-owned WebKit homes without cleanup warnings; legacy stores stay intact.

Evidence uses the `.context/persistent-retained-dirents-` prefix:
`native-final.log`, `wasm-check.log`, `products.log`, `node.log`, `browser.log`,
`sortix.log`, `demos.log`, `abi.log`, the browser/demo JSON reports,
`source-sha256.txt`, `artifact-sha256.txt`, `source-after.log` and
`artifact-after.log`. The earlier 64 KiB browser failures
are preserved in `-browser-before-budget.{log,json}` and the focused
`-rename-probe.log`; the 80 KiB three-engine repeat is `-rename-final.log`.
The current kernel digest starts `03138a6e412c652d`; this supersedes older
runtime hashes for the matching selections, not their wider unrerun scopes.
Unselected catalog imports still report missing nginx/nginx-php artifacts.

This closes one concrete unadmitted structure, not the whole memory gate:
actual directory/journal B-tree allocation, base/live recovery peaks, FIFO
metadata, remaining snapshot scratch and peak-RSS acceptance remain open.
The six production gates remain unchecked.

### Fallible directory-node preparation

Directory-name preparation now allocates both owned bytes and a concrete AVL
node before namespace commit or recovery publication. Previously the owned
name was admitted but standard B-tree insertion could still allocate after
the journal transaction committed. Linking, rotation, removal and replacement
now reuse prepared nodes without allocating. The existing 768-byte per-name
node charge remains unchanged and statically covers twice the concrete node
size; admission exhaustion and a null node allocation return `ENOMEM`.

Ordered forward/reverse iteration uses bounded reference stacks. Namespace
ancestor traversal stores compact range bookmarks and reconstructs paths on
resume, preserving the previous 16 KiB scratch assertion rather than raising
it for the larger iterator representation. Successor-based directory reads
retain their last-name semantics across mutations. The implementation uses
safe ownership/borrowing for balancing and iteration, not intrusive raw links.

New differential tests cover ordered/reverse and randomized mutations,
successors, mixed-end exact-size iterators, cloning/bookmark resumption,
allocation failure and preallocated credit exchange. Kernel tests inject node
allocation failure before regular/directory/symlink/FIFO/socket creation,
hard link and rename, and before plain/indexed namespace recovery. Failed
preparation leaves namespace, journal and credits unchanged; immediate retry
and subsequent strict recovery succeed.

Current ABI 51 validation `persistent-directory-nodes-validation-1018-194522-c801`
succeeds in 41m14s. Supplemental validation
`persistent-directory-nodes-supplemental-1018-202642-45ab` succeeds in 3m26s:

- All 3,169 native Rust workspace checks excluding xtask pass, with no ignored
  cases, and the Wasm runtime-core check passes. The existing metadata-quota,
  recovery, full-budget unlink and traversal-scratch assertions are unchanged.
- The main ten-file Node selection passes 298 cases and explicitly skips one
  opt-in >4 GiB export case. The complete eleven-case export file then passes
  with that fixture enabled, including export/reboot, damaged-stage rejection
  and its existing RSS-growth check. Together these cover all 299 distinct
  cases in the selected ten files, not 309 distinct tests. Both >32 GiB
  statistics fixtures remain enabled; paired boot/recovery observations stay
  at `[238,182]` 64 KiB kernel pages under a 64 MiB ceiling.
- Thirty OPFS kernel cases pass on Chromium, Firefox and WebKit. Three
  rootfs `getdents64` cursor cases and six live-inspection cases also pass
  across those engines, covering guest mutations, 800-entry ordered listings,
  mount-crossing links and live descriptor inspection. None of these three
  selections skip or retry a case.
- Seventy selected persistent strict-reboot Sortix cases pass with no
  failures, expected failures, skips, build failures or timeouts. This remains
  selected filesystem/I/O coverage, not the entire conformance inventory.
- Normal targeted product provisioning succeeds for all 134 nodes, with five
  published and 129 cached. The current shell and both WordPress backends
  again pass on all three engines: thirteen demo/isolation passes and two
  documented Firefox/WebKit CDP shell-crash skips, no flaky results. Their
  reload/process-crash scopes are unchanged from the earlier demo section.
- ABI validation passes at 51. Ten source and thirteen runtime/demo artifact
  hashes match before/after both validation jobs. A bounded positioned read
  additionally verifies that the physical >4 GiB fixture's embedded guest
  declares ABI 51 and carries the current kernel's contract digest. The full
  export test file still emits legacy-contract warnings from its other
  fixture paths; those diagnostics are not hidden or restamped away.

Evidence uses the `.context/persistent-directory-nodes-` prefix:
`native-final.log`, `wasm-check.log`, `products.log`, `node.log`, `browser.log`,
`cursors.log`, `sortix.log`, `demos.log`, `export-full.log`, `inspection.log`,
`fixture-contract.log`, `abi.log`, browser JSON reports and the source/artifact
checksum lists and verification logs. The current kernel digest starts
`79eb5fd868fb0124`; older runtime hashes describe their historical selections.
Run-owned browser data and new staging files are reclaimed without cleanup
warnings; existing global WebKit data is not deleted. Unselected catalog
imports still report missing nginx/nginx-php products.

This supersedes older milestone notes identifying directory B-tree nodes as
unprepared; journal B-trees still require work. It does not complete the
memory or performance gates, and no speed or throughput claim is made.
Generic journal/index structures, recovery union peaks, FIFO metadata,
remaining snapshot scratch and actual whole-process peak memory remain open.

### Prepared journal-state publication

Journal metadata, block-location and checkpoint-invalidation maps now use
fallible prepared AVL nodes. Record decoding and all node preparation occur
before the transaction is written or flushed. Publication links existing
ownership, invalidates read-cache entries, reuses prepared zero-fence value
buffers and advances revision scalars without allocating journal state.
Allocation failure returns `ENOMEM` with no transaction write or state change
and leaves the writer retryable; existing write/flush failures remain sticky.
Replay propagates allocation failure before publishing a mounted namespace.

Transaction encoding now validates and measures the complete frame before
allocation, fallibly reserves it, and enforces the existing 1 MiB limit.
Decoded records and name/value copies use fallible reserves. Checkpoint
directory-key decoding also copies its at-most-255-byte name fallibly; index
page buffers were already fixed-sized. Native fault cases exercise every
prepared node in mixed metadata/block/zero-fence transactions, including
checkpoint invalidations, failure armed at successful flush, dirty-data
retention/retry, exact frame-size boundaries and plain/indexed recovery.

Current-artifact validation
`persistent-journal-preparation-validatio-1018-204250-d4ab` succeeds in 43m37s:

- All 3,176 native Rust workspace tests excluding xtask pass without ignored
  cases; the Wasm runtime-core check passes. New tests cover every one of
  fourteen pre-write node-allocation failure positions across plain/indexed
  mixed transactions, verify no state-node allocation occurs after flush,
  preserve buffered dirty data across `ENOMEM` and retry, and exercise the
  exact 1 MiB transaction boundary. Plain/indexed rootfs recovery fails closed
  on injected node exhaustion with unchanged base namespace, journal and index.
- All ten complete Node files pass 299 cases in one run, with no filters or
  skips. The >32 GiB dense and near-dense fixtures and physical >4 GiB export
  fixture are all enabled. Both >32 GiB paired boot/recovery cases remain
  within a 64 MiB kernel ceiling at `[238,182]` pages. Existing export and
  damaged-stage/RSS-growth assertions pass, not a whole-process memory claim.
- Thirty OPFS cases, three rootfs directory-cursor cases and six live
  inspection cases pass on Chromium, Firefox and WebKit, without skips,
  retries or flaky results. Seventy selected strict-reboot persistent Sortix
  cases pass with no failures, expected failures, skips or timeouts; this is
  not the complete conformance inventory.
- Fresh normal product provisioning succeeds for all 134 selected nodes,
  with five published and 129 cached. The real shell and both WordPress
  backends again recover on all three engines. Their demo/isolation selection
  records thirteen passes and the two documented Firefox/WebKit CDP-only
  shell-crash skips, no failures or flaky cases. Previously described
  process-crash versus reload coverage is unchanged.
- ABI validation passes at 51; thirteen implementation/test source hashes and
  thirteen runtime/demo artifact hashes match before/after integration. All
  four browser cohorts remove their run-owned WebKit homes without cleanup
  warnings; preexisting global data is untouched. Unselected nginx/nginx-php
  catalog imports still report missing products, not full-catalog acceptance.

Evidence uses `.context/persistent-journal-preparation-`: `native-final.log`,
`wasm-check.log`, `products.log`, `node.log`, `browser.log`, `cursors.log`,
`inspection.log`, `sortix.log`, `demos.log`, `abi.log`, the browser JSON reports
and `browser-summary.log`, plus source/artifact checksum and verification
files. The current kernel digest starts `6975defe4a8025a0`; prior runtime
hashes remain evidence only for their historical selections.

This is allocation-safe publication, not a completed global-memory policy:
journal maps still need aggregate profile-aware admission. Cache and
write-preparation copies and the bounded dirty-size map still allocate
through existing paths. Recovery union peaks, FIFO metadata, remaining
scratch, process RSS and performance acceptance remain open. No new imports,
exports or on-disk format are introduced; ABI remains 51. None of the six
remaining production gates is marked complete by this scoped acceptance.

### Fallible bounded cache staging

Journal open now fallibly reserves all read-block, dirty-block and metadata
slot tables before it can write a new header. Each remains capped at 64
entries. Pending file sizes use a sorted, pre-reserved 64-entry vector, not
an allocating B-tree. Publication and LRU moves enforce reserved capacity.
Block payloads remain 4 KiB; metadata values and cached names are bounded at
4 KiB and 255 bytes respectively. Indexed lengths are checked before reserve.

Write preparation, dirty sync, eviction copies and metadata/read-cache
copies are fallible. Eviction keeps victim keys and copies each payload once;
there is no second victim-payload clone. All staging finishes before durable
victim commit/removal and acceptance of the new chunk. Failed staging leaves
accepted data/sizes readable and retryable; later-chunk exhaustion returns
only the already accepted prefix. Block-payload cache hits reuse buffers and
slots; a complete read may still need a fallible metadata result copy.
Metadata hits preserve their entry/LRU position if result copying fails.

New fault tests cover all four open-time slot reserves, initial writes,
every eviction staging reserve/copy, sync copies, metadata misses/hits,
read-cache misses/hits, large-write partial acceptance and invalid indexed
lengths. A rootfs case verifies an open-time failure writes no header,
changes no namespace/metadata credits, and permits retry.
Current-artifact validation completed successfully through the normal build
path: 3,185 Rust tests, 299 tests across ten Node integration files with dense
and sparse 32 GiB and physical 4 GiB fixtures enabled, 30 selected OPFS cases,
three directory-cursor cases, six live-inspection cases, and 70 selected
persistent strict-reboot Sortix cases. Real shell and WordPress SQLite/MariaDB
demo validation passed 13 cases across Chromium, Firefox and WebKit. Two
shell browser-process-crash cases are explicitly skipped on Firefox/WebKit
because the crash driver requires Chromium CDP; reload recovery is not a
power-loss guarantee. All 13 frozen source and 13 artifact checksums remained
unchanged, and the ABI 51 consistency check passed. Evidence is recorded under
`.context/persistent-cache-admission-*`; the completed validation job is
`persistent-cache-admission-validation-1018-214040-738b`.

These per-cache bounds and fallible operations do not yet constitute a shared
profile-aware byte budget or measured whole-process peak bound. Aggregate
journal/map/cache admission, recovery union peaks, FIFO metadata, other scratch, performance,
durability/handoff and full release acceptance remain open. ABI stays 51.

### Borrowed transaction replay and compaction cursors

Transaction decoding now validates its complete body without expanding it
into an owned mutation vector. Record names and values borrow the verified
frame. Replay prepares retained metadata individually and hashes file blocks
without copying their payloads into temporary owned mutations. Checkpoint
verification and legacy conversion consume borrowed records as well.

Both compacted-index iterators use the same cursor implementation: one
fallibly reserved, reusable transaction buffer of at most 1 MiB, scalar
position/sequence state, and one emitted record. They no longer accumulate
pending block or metadata vectors. Metadata directory keys are copied
fallibly only when emitted; values are hashed in place. Full frame validation,
record-count checks and fixed-mode restrictions precede emission, so an
invalid later record cannot expose an earlier entry from that transaction.
Buffer/name exhaustion returns `ENOMEM`, leaves source bytes untouched and
allows retry with a new cursor.

Ten new unit/fault tests exercise borrowed offsets and round trips,
incomplete records, whole-frame rejection before callbacks/publication,
maximum-count near-1-MiB block and metadata frames, buffer reuse, fixed-mode
rejection, fallible buffer/name copies, block recovery without payload copies
and verification-only callbacks. All 92 journal tests pass. The rebuilt
validation job `persistent-borrowed-records-validation-1018-223251-52a3`
completed successfully: 3,195 Rust checks, 299 cases across ten full Node
integration files with all three large-image fixtures enabled, 30 selected
OPFS cases, three directory-cursor cases, six live-inspection cases, and 70
selected persistent strict-reboot Sortix cases. Real shell and WordPress
SQLite/MariaDB demo validation passed 13 cases across Chromium, Firefox and
WebKit. Two Firefox/WebKit shell process-crash cases retain their explicit
Chromium-CDP-only skips. The ABI 51 check passed, and all 13 source and 13
artifact checksums remained unchanged. Evidence uses the
`.context/persistent-borrowed-records-*` prefix. This is not full-catalog,
whole-process-memory or workload-performance acceptance.

This removes decoded/pending record-list amplification, not the resident
journal maps or the pre-commit prepared-node list. Aggregate profile-aware
admission, bounded large-history recovery/conversion selection, remaining
scratch and process peak measurements still need completion. ABI stays 51;
the serialized journal/index formats are unchanged.

### Memory-limited recovery conversion

Before enforcing tighter journal budgets, boot needs to convert a valid
journal whose recovery state cannot fit, without treating resource exhaustion
as corruption. Selection now permits one bounded Rust conversion after a
qualified `ENOMEM`, even for a source below 32 MiB. This covers legacy,
sealed and indexed sources while preserving their original files and verified
fallbacks. A rejected converted target or storage-quota failure fails closed;
it does not cause stale-generation selection or an infinite retry loop.

Rust explicitly records whether the failed recovery has left the namespace
unpublished. The host reads this immediately in the same kernel entry;
ordinary/unqualified `ENOMEM` remains a fatal boot error. The marker is cleared
before namespace, allocation-statistic or FIFO publication and on reset or
active-mount refusal. FIFO preparation originally could fail after namespace
publication, which was not safe to retry in the same kernel. The integrated
memory candidate now prepares the complete projected FIFO registry before
namespace-credit exchange/publication; those preparation failures leave the
base pristine and can safely qualify. Any failure after publication still
requires a fresh kernel.
The new scalar export is batched under ABI 51 with the regenerated snapshot.

Thirteen policy cases cover small legacy/sealed/indexed sources, target
rejection, target memory exhaustion, retry on a later boot, per-file storage
quota and empty-source refusal. Dedicated Node/browser worker fixtures inject
a qualified pre-mount refusal at the selection callback, then use the real
Rust converter, index and mount over real host files/OPFS. Normal kernel-worker
boots subsequently read, mmap-write/fsync and reopen the converted machine.
The fixtures do not override frozen production prototypes or simulate the
filesystem. The historical native cohort distinguished pre-publication
allocation refusal from an injected late FIFO-stage failure. The current
regression moves that FIFO refusal before publication, verifies the replayed
FIFO is absent, and successfully retries without reloading the base.

Final ABI-matched validation passed 3,196 Rust checks, 314 tests across ten
full Node integration files with all three large-image fixtures enabled,
36 selected OPFS cases including the six new conversion cases, three
directory-cursor cases, six live-inspection cases, and 70 selected persistent
strict-reboot Sortix cases. The real shell and WordPress SQLite/MariaDB demos
then passed 13 cases across Chromium, Firefox and WebKit, retaining the two
explicit Firefox/WebKit Chromium-CDP-only shell process-crash skips. There
were no flaky results in the accepted browser reports.

The normal source-only build rebuilt 121 of 134 dependency/product nodes;
13 were cached. The persistence guest was recompiled and instrumented through
the SDK, then embedded afresh in both 32 GiB fixtures and the physical 4 GiB
fixture. An initial run exposed stale guest-fixture ABI stamps; a later demo
stage exposed missing source-only Dash support for the browser test graph.
Those were provisioning failures, not passing runs. Dash was subsequently
source-built and materialized through `xtask bootstrap dash`; the source-only
closure preflight then reported 76 complete, zero incomplete/failed and 23
unbuilt packages. This is not full-catalog acceptance.

Core evidence uses `.context/persistent-resource-conversion-final-*` from
`persistent-resource-conversion-final-1019-013747-0059`. That job's core
stages passed, but its initial demo stage failed on the missing Dash artifact.
The corrected demo/ABI job
`persistent-resource-conversion-demos-1019-021746-35c5` succeeded; evidence
uses `.context/persistent-resource-conversion-demo-*`. All 19 frozen source
and 13 core artifact checksums matched before/after the accepted demo run,
and Dash's separately frozen checksum matched too. The ABI 51 consistency
check passed. These checks do not prove aggregate journal/cache budgets,
actual process peaks, full atomic namespace/FIFO recovery, complete handoff
acceptance or workload performance.

### Journal-state admission and pressure-driven compaction

All three journal maps now share a byte-admission ledger, independent from
the live namespace quota. Node and browser configure the smaller of 32 MiB
and one eighth of their kernel ceiling (8 MiB with a 64 MiB kernel). Charges
cover twice the concrete node layout and owned name/value capacities before
allocation, including staged transaction nodes and retired replacements until
drop. Failed admission returns `ENOMEM` before journal publication and does
not poison the writer. Replay can use the qualified conversion retry above.

The declared allowance includes a fixed 256 KiB reserve for draining the
bounded dirty cache and up to 64 pending timestamp owners. Ordinary mutations
cannot spend it. While reserve-funded nodes remain, new dirty writes and new
timestamp owners are refused until compaction releases state; accepted dirty
data and timestamps remain flushable. Timestamp writeback is a bounded,
restricted path and can pass the tail admission limit without admitting new
namespace work. This is modeled admission, not physical allocation assurance.

Rust raises pressure at half the ordinary allowance or when reserve-funded
nodes exist. The shared host compactor checks that decision on boot and live
timer turns, independent of journal byte size. Production resizable compaction
no longer retains another metadata map while the source is live. Retained
base-directory pruning validates all checkpoint lookups into existing node
flags before removing any key; failed I/O/allocation preserves the entire set
and its credits. This keeps reclamation possible at the state limit without
an unbounded temporary key list or an unadmitted second metadata tree.

New native cases cover capacity ownership, replacement lifetime, pruning,
overflow/allocation refusal, partial transaction preparation, retryable replay,
emergency dirty/timestamp draining, eviction rejection with accepted-data
preservation, and fallible retained-key validation. Policy/profile unit checks
pass 132 cases. Real Node/browser fixtures now also append 65,000 legitimate
unused-block tombstones to force admitted recovery refusal, or 30,000 to
exercise proactive compaction under a 64 MiB kernel. Unlike the earlier
callback injection, these cases must reach the real Rust admission boundary
and observe state credit release. A focused fresh-guest Node run passes all
four conversion/pressure cases, including the two real-admission cases, with
83 unrelated cases filtered out; evidence is
`.context/persistent-state-admission-early-memory.log`. A separate focused OPFS run also
passes the four cases on each of Chromium, Firefox and WebKit: twelve passes,
no skips, retries or failures. Evidence is
`.context/persistent-state-admission-early-browser.{log,json}`. Guarded teardown
reclaims its six staging files (3,624,960 allocated bytes) and run-owned WebKit
home; it does not touch preexisting shared browser data.

The three scalar configuration/usage/pressure exports are batched under ABI
51; the journal and checkpoint formats do not change. Evidence uses
`.context/persistent-state-admission-*`. This does not complete shared
cache/temporary accounting, namespace recovery-union peaks, FIFO resources,
whole-process memory measurement, workload/pressure budgets, full handoff
acceptance or final release validation. The six production gates remain open.

### Compaction durable-snapshot crash cuts

The shared host policy now has an automated crash-cut matrix in
`host/test/overlay-compaction-crash.test.ts`, registered as source-only CI
evidence. A successful compaction first records its complete operation trace.
Each case is then rerun with owner loss immediately before and immediately
after every observed operation, preventing all subsequent cleanup I/O. Recovery
discards volatile bytes and runs the production generation selector and seal
verifier against only the surviving storage state. It must mount the current
source bytes or their compacted copy, never an older fallback or a new empty
computer. The source itself must remain byte-identical at every cut.

Six model cases cover flush-only and write-through durability with legacy,
sealed and extended-slot sources. Extended-slot cases also interrupt obsolete
generation retirement. The after-effect cuts include lost acknowledgement of
seal flush and activation, rather than modeling every error as an operation
that never took effect. The model deliberately does not parse a Rust journal:
it proves storage-neutral handoff/selection behavior, not persistent POSIX
semantics, arbitrary torn-sector recovery, browser lock races or OS/device
power-loss durability.

The new six cases, all 91 existing generation-policy cases and all nine storage
adapter cases pass together: 106 passes, no failures or skips. Evidence is
`.context/persistent-compaction-durable-cuts.log`. This adds coverage to the
crash/handoff gate without marking the complete gate achieved. The ABI-matched
Node/browser/kernel acceptance below completes the separate rebuilt selection.
The related generation, storage, runtime-profile, image and rootfs integration
files are also classified in the CI evidence inventory. A file-list audit still
finds other unclassified or obsolete entries outside this persistence selection;
the complete exact-ABI CI inventory is not yet accepted.

### Journal-state admission acceptance

On 2026-10-19, `persistent-state-admission-validation-1019-030625-55e1`
succeeds in 2h32m. It builds the current kernel, image modules and both host
peers, provisions all 134 selected SourceOnly product nodes (121 published,
13 reused), and separately provisions Dash through the normal source path.
The shell and both WordPress images are ABI-matched; no stale guest is
restamped to bypass compatibility. The persistence guest is compiled and
instrumented afresh, then all three optional large-image fixtures are
regenerated before testing.

- All 3,206 native Rust workspace tests pass, excluding xtask, with no failures
  or ignored cases. The Wasm runtime-core check also passes. Runtime-core has
  2,631 unit tests and six doctests in this run.
- Ten complete Node files pass all 319 cases with all three large-image
  fixture options enabled, no filters or skips. Dense and near-dense files
  larger than 32 GiB mount and recover at `[230,182]` kernel pages under a
  64 MiB ceiling. This measures kernel linear memory, not process peak RSS.
- The selected OPFS cohort passes 42 cases on Chromium, Firefox and WebKit,
  including real admitted replay refusal, pressure-driven compaction,
  same-budget recovery, timestamp draining, orphan handling and 8,192 distinct
  changed blocks. Cursor and native inspection cohorts add three and six
  passes, respectively, without skips or retries.
- Seventy selected strict-reboot persistent Sortix cases pass, with zero
  failures, expected failures, build failures, skips or timeouts. This is
  filesystem/I/O coverage, not the complete POSIX or libc conformance suites.
- The real shell and WordPress SQLite/MariaDB demos pass recovery on all three
  engines, including shell checkpointing and source-blocked post/upload
  recovery. With cross-origin isolation, this cohort has thirteen passes and
  the two explicit Firefox/WebKit CDP-only shell-crash skips. Chromium process
  crashes and Firefox/WebKit page reloads remain distinct evidence.
- ABI 51 consistency and before/after verification of 24 source files and
  15 runtime/product artifacts pass. The separate crash-cut suite's test and
  CI-inventory hashes also remain unchanged after its 106-case run.

Evidence is `.context/persistent-state-admission-*`, including the complete
native and Node logs, browser/cursor/inspection/demo JSON reports, Sortix
summary, ABI check and source/artifact checksum manifests. The main OPFS run
reclaims 19 owned staging files (126,402,560 allocated bytes); demos reclaim
18 (980,508,672 bytes). Both remove their run-owned WebKit homes without
touching legacy shared stores. Unselected nginx and Ruby demo images still
produce missing-artifact diagnostics; this is not full-catalog acceptance.

This validates the journal-state admission step and its real consumers. It
does not complete aggregate cache/scratch accounting, namespace recovery-union
peaks, FIFO resource admission, process-RSS/workload acceptance, the complete
crash/handoff matrix, durability/lifecycle policy, portable-policy consolidation
or full CI/release validation. All six remaining production gates stay open.

### Shared I/O ownership admission

The Rust journal and both verified-read caches now share an I/O allowance
separate from namespace metadata and journal state. Node and browser configure
min(32 MiB, kernel ceiling/8), including a fixed 2 MiB slice for accepted dirty
writeback. Ordinary buffers cannot spend that slice. Cache slot arrays, clean
and dirty blocks, retained metadata-cache names/values, transaction frames,
prepared-publication vectors, verification hash tables/chunks and streaming
verification output/scratch retain admission for their ownership lifetimes.
Dirty cloning/framing/publication use the reserved slice and release it after
sync; new writes still need ordinary admission.

The typed buffer admits doubled vector capacity before allocating and accounts
for both old and new allocations during growth. Consuming iteration retains
the backing-allocation credit until the iterator drops. Growth/physical
allocation refusal leaves the original frame intact. Ordinary commit refusal
precedes storage publication and leaves the writer retryable. Clean reads can
evict cached payloads before retrying; verified reads also reclaim other read
owners while preserving the active verification table. Write staging reclaims
clean caches under pressure, never accepted dirty data or pending sizes.

New native checks exercise ownership/iterator lifetime, overflow and quota
refusal before allocator entry, over-capacity allocation reconciliation, growth
rollback/peak admission, isolated writeback headroom, retryable commit refusal,
dirty-cache draining at the ordinary limit, clean-cache eviction and cross-owner
verification reclamation. All 3,215 native workspace tests pass, excluding
xtask, as do the Wasm check and 42 focused profile checks. Existing real
memory-recovery fixtures now require Rust to report an
8 MiB I/O limit under their 64 MiB kernel ceiling and usage within it.
Six focused Node cases pass: four conversion/pressure cases plus deflated and
stored archive streaming under a 64 MiB kernel ceiling; 89 unrelated cases are
filtered out. A focused browser run passes 24 cases on all three engines with
no skips or retries: memory conversion/pressure plus lazy archive read/exec,
transient retry, external transport and digest-failure recovery. Evidence is
`.context/persistent-io-admission-early-{memory,browser}.{log,json}` (the Node
run has a log only). These overlap the complete selected acceptance below;
they are not additional case totals.

On 2026-10-19, `persistent-io-admission-validation-1019-055728-f56b`
succeeds in 2h31m. Normal SourceOnly provisioning completes all 134 selected
product nodes (121 published, 13 reused), followed by separate normal Dash
provisioning. Kernel, image modules and both host peers are rebuilt normally.
The persistence guest is freshly compiled/instrumented and all three large
fixtures are regenerated before testing; stale guests are not restamped to
bypass compatibility.

- All 3,215 native workspace tests pass, excluding xtask, with no failures or
  ignored cases. Runtime-core contributes 2,640 unit tests and six doctests;
  the Wasm runtime-core check also passes.
- Thirteen complete Node files pass 339 cases without filters or skips, with
  all three optional large-image fixtures enabled. Dense and near-dense
  greater-than-32 GiB files again mount/recover under a 64 MiB kernel ceiling
  at `[230,182]` kernel pages. This is not process-RSS measurement.
- All three browser engines pass the selected 42 OPFS cases, three cursor
  cases, six native inspection cases and twelve complete lazy-archive cases,
  with no skips, retries or flaky results in those cohorts.
- Seventy selected strict-reboot persistent Sortix cases pass, with no other
  outcomes. This is not the full POSIX or libc conformance inventory.
- Real shell checkpoint/recovery and both WordPress post/upload recovery
  workflows pass on every engine. With isolation, demos record thirteen
  passes and the two explicit Firefox/WebKit CDP-only shell-crash skips.
  Chromium process crashes and Firefox/WebKit reloads remain distinct proof.
- ABI 51 consistency and before/after checksums for 31 source files and
  fifteen runtime/product artifacts pass.

Evidence is `.context/persistent-io-admission-*`, including native/Node logs,
OPFS/cursor/inspection/lazy/demo JSON reports, Sortix results, ABI output and
frozen source/artifact checksum manifests. The main OPFS cohort reclaims
19 owned staging files (126,402,560 allocated bytes); demos reclaim eighteen
(989,945,856 bytes). Every browser cohort removes its run-owned WebKit home.
Legacy shared stores are untouched. Unselected nginx/Ruby demo artifacts still
report missing imports; this is not full catalog or exact-ABI CI acceptance.

This closes another set of ownership gaps, not the whole memory gate. Legacy
sort buffers and compaction batches, returned metadata copies, namespace
recovery/snapshot peaks, FIFO resources and transport bookkeeping still require
admission review. Actual process peaks and workload/pressure measurements are
unproven. The three new scalar exports are batched under ABI 51; formats do not
change. All six production completion gates remain open.

### Compaction and conversion workspace admission

Compaction mutation batches now own ordinary I/O admission for both their slot
arrays and actual name/value capacities. Payload admission precedes copying;
record allocation/reconciliation refusal publishes nothing into the batch.
Successful flush destroys records before releasing their payload credit, while
failed flush retains both. The logical 128-record batching limit is independent
of allocator capacity. Direct journal write/truncate helpers use the same
fallible ownership path, and indexed metadata walks admit their value scratch
before calling visitors.

Legacy conversion admits the external sort's prescan, run, cursor, serialization,
merge-output and copyback buffers. It no longer puts 96/384 KiB serialization
buffers or the 64 KiB copyback window on the stack. Prescan buffers are released
before sorting; run-generation buffers before merging; emission batch/cursor
ownership before checkpoint construction. The existing 4,096-record runs and
serialized formats do not change. A native test converts both odd/even merge
histories within the same 6 MiB ordinary I/O allowance used by a 64 MiB kernel,
observes admitted workspace at storage callbacks, verifies source preservation
and reopens the resulting index, checking its count and boundary tombstones.
This is not RSS or a throughput measurement.

Rootfs compaction admits its live-inode planning vector through the namespace
temporary budget before initializing its target journal. Clean caches can be
reclaimed but dirty data is synced first. Timestamp mutation batches and
generation vectors use the separate writeback-scratch allowance. Inode-record encoding is fallible
for namespace operations too. A real Rust rootfs test drains all 64 dirty files
and timestamp owners with ordinary I/O admission exhausted, then reboots and
checks each byte and modification time. Another test exhausts namespace
temporary admission, checks that the compaction target and namespace remain
unpublished, releases pressure and retries successfully.

All 2,646 runtime-core unit tests and six doctests pass after these changes.
New cases also cover payload admission before copying, actual capacities,
failed-flush ownership, compaction refusal/retry and indexed-walk refusal before
visiting.

On 2026-10-19, acceptance
`persistent-compaction-admission-validati-1019-084924-160e` succeeds in 46m03s:

- All 3,221 native workspace tests pass, excluding xtask, with no failures or
  ignored cases; the Wasm runtime-core check and normal module/kernel/host
  builds also pass.
- Normal SourceOnly provisioning completes all 134 selected product nodes,
  publishing five and reusing 129, plus separate normal Dash provisioning.
  The guest is freshly compiled/instrumented and all three large fixtures are
  regenerated. No stale guest is restamped to bypass compatibility.
- Thirteen complete Node files pass 339 cases with all three large-fixture
  options enabled, no filters or skips. Dense and near-dense files larger than
  32 GiB mount/recover under a 64 MiB kernel ceiling at `[230,182]` kernel
  pages. This remains kernel-memory evidence, not process RSS.
- Chromium, Firefox and WebKit pass the selected 42 OPFS cases, three cursor
  cases, six inspection cases and twelve complete lazy-archive cases without
  skips, retries or flaky results.
- Seventy selected strict-reboot persistent Sortix cases pass, with zero
  failures, expected failures, build failures, skips or timeouts. Full POSIX
  and libc conformance are not implied.
- The real shell and both WordPress backends pass source-blocked file or
  post/upload recovery and shell checkpointing on all engines. With isolation,
  demos report thirteen passes and the two explicit Firefox/WebKit CDP-only
  shell-crash skips. Chromium process crashes and Firefox/WebKit page reloads
  remain distinct evidence.
- ABI 51 consistency and unchanged checksums for 31 source files and fifteen
  runtime/product artifacts pass. No new ABI exports or storage formats are
  introduced in this step.

Evidence is `.context/persistent-compaction-admission-*`, including native and
Node logs, browser/cursor/inspection/lazy/demo JSON reports, Sortix results,
ABI output and checksum manifests. Browser cleanup reclaims nineteen owned
OPFS staging files (126,402,560 allocated bytes) and eighteen demo staging
files (986,800,128 bytes), plus all run-owned WebKit homes. Legacy shared stores
are untouched. Missing unselected nginx/Ruby image diagnostics remain visible;
this is not full-catalog or exact-ABI CI acceptance.

Caller-owned metadata copies, checkpoint-structure ownership, recovery/snapshot
peaks, FIFO/transport resources, actual RSS/workloads and the other production
acceptance gates remain open. All six production gates stay unchecked.

### FIFO open-wait ownership admission

Blocking FIFO opens now admit their waiter node and saved pathname against
the ordinary, profile-aware shared I/O budget before allocating or publishing
an endpoint reference. They do not consume the I/O writeback reserve or the
journal-state pools. Admission refusal or allocation failure returns `ENOMEM`;
the syscall releases its reserved descriptor and any newly idle FIFO buffer.
Duplicate-owner refusal preserves the existing wait and endpoint counts.

The waiter registry uses the prepared AVL map rather than an infallibly
allocating standard map. Node layout and pathname capacity are charged at
twice their concrete sizes. Removing a ready or cancelled waiter transfers its
credit with its owned pathname, rather than releasing credit while the
returned waiter still owns that allocation. Process cancellation visits and
consumes waits without collecting owner or waiter vectors. The existing
rendezvous, reader-hangup, thread cancellation and reserved-fd semantics remain
authoritative; admission failure does not manufacture an opposite endpoint.

Seven new native tests cover caller-budget validation, randomized AVL removal
and mutation against a standard-map oracle, credit ownership after removal,
waiter quota and node-allocation refusal, duplicate owners, ready/cancelled
waits, process cancellation at an exhausted budget (including zero and maximum
PID keys), ordinary-versus-writeback pool isolation, and syscall fd/buffer
rollback. The focused FIFO and map runs pass 42 and 9 tests respectively. The
browser FIFO lifecycle and wasm32/memory64 SCM_RIGHTS lifetime cases are now
enabled on Firefox and WebKit as well as Chromium. The first broad validation
passes 3,228 native and 342 complete Node cases, nine FIFO browser cases,
42 selected OPFS cases and three directory-cursor cases. It stops at one
WebKit live-inspection timeout after five other inspection passes; subsequent
lazy/archive, Sortix and real-demo stages do not run. That run is not accepted
as a complete success. The subsequent combined run passes all six inspection
cases, 12 lazy/archive cases and 70 selected persistent-reboot Sortix cases;
its app stage exposes invalidated derived products after a host rebuild and
is not accepted as application evidence. Those products were regenerated
through the normal build graph before the frozen-site acceptance below.

This is another part of the whole-system memory work, not its completion.
The saved path's subsequent OFD ownership belongs to the separate, unfinished
fd/OFD accounting audit. FIFO pathname registration, rename staging, global
pipe-table capacity and recovery alias maps still need admission before
namespace publication; simply making their post-publication inserts fallible
would introduce partially published filesystem operations. Recovery/snapshot
overlaps, other returned metadata and host bookkeeping allocations, actual
whole-process peak memory, and all six production gates remain open. ABI stays
51; this step changes no kernel import/export, marshalling or storage format.

### Checkpoint 1 recovery-freshness policy

An independent read-only review identified a combined-failure recovery path:
a rejected target can retain its seal, its source can accept later durable
writes, and damage to the source seal/index then removes that source from the
verified candidates. Previously, the missing verified candidate alone allowed
its older descendant to boot. A local executable reproduction observes that
selection with the newer source bytes still present. The fix preserves the
unverified source lengths, distinguishes verified slot reuse from unresolved
identity, and fails closed before enabling the ambiguous descendant or legacy.
It does not propagate uncertainty as proof of staleness, so a newer independently
eligible descendant can still boot. Live compaction also flush-invalidates a
reused target seal before touching its journal/index. A failed initial
invalidation cannot modify those files or cancel preparation that never began.

Seven new Node cases cover damaged/missing source identity, unchanged storage
on refusal, newer-descendant success or kernel rejection, verified reuse with
different lengths, and invalidation ordering. All 113 policy/storage/crash-model
cases pass. Fifteen real OPFS storage-contract cases pass across Chromium,
Firefox and WebKit, checking refusal without mutation and legitimate retirement
or newer-descendant recovery. These fixtures validate generation policy, not
guest POSIX behavior. They use owned persistent profiles, like the existing OPFS
suites: the initial nonpersistent WebKit fixture refused OPFS access and stalled
during cleanup; it was diagnosed rather than skipped or granted a longer wait.

The independent patch review finds no concrete correctness error, but is not
production signoff. Empty/missing source seals and equal-length unverified
sources retain their existing retirement/fallback compatibility. Thus this
narrows a specific ambiguity; it does not establish arbitrary-corruption
freshness, prove activation-acknowledgement safety while cleanup continues, or
complete the full crash matrix. A separate allocator-exhaustion audit still
needs to cover allocating wakeup queues during FIFO teardown. All six gates
remain open, and ABI stays 51.

A real Chromium shell on the checkpoint server creates and syncs a regular file
and FIFO, reloads, verifies both, checkpoints its composed image, reloads again
and verifies both. That exact user-visible path is recorded in
`.context/persistence-checkpoint-1-smoke.json` with its screenshot.

Checkpoint 1 is also available as a frozen production-built local site, not a
hot-reloading development page. Its shell, WordPress SQLite and WordPress
MariaDB images were regenerated through the normal 134-node product graph
after the host rebuild invalidated their derived closure. The deployment
acceptance helper can consume an explicitly checked profile-to-machine URL
map rather than requiring a development-only fixture module. An explicit
deployment map disables missing-local-product skips: the actual deployed app
must boot and exercise its real image.

The frozen-site acceptance succeeds in 7m55s with 13 browser passes, zero
failures and two explicitly unsupported Firefox/WebKit shell browser-process
crash skips. All three engines pass MariaDB post creation and upload,
image checkpoint/reboot with the database running, exact post/upload
verification, and subsequent source-blocked recovery. Chromium crashes and
relaunches its browser process; Firefox/WebKit reload the page. SQLite
post/upload recovery, shell checkpoint/reload and cross-origin isolation also
pass on all engines. No WordPress case skips. ABI snapshot validation passes
at 51; frozen source, artifact and emitted-site hashes remain unchanged during
acceptance. Evidence and live manual instructions are in
`.context/persistence-checkpoint-1.md` and the
`.context/persistence-checkpoint-1-static-*` reports. The site remains running
for user testing while the next implementation batch proceeds. This is a
runnable checkpoint, not final release, whole-system memory or full crash
acceptance; all six production gates remain open.

### Descriptor and namespace-walk admission batch

The next memory batch replaces the separate allocating reserved-descriptor
tree with explicit free/reserved/open slots. Three inline slots keep initial
descriptor-slot construction allocation-free, not OFD/process construction.
Heap slots use the shared ordinary I/O
allowance, charging twice actual capacity and retaining old allocation credit
while a replacement is admitted and allocated. Already-admitted spare capacity
remains usable at an exhausted allowance; growth refusal preserves the live
table. Closing or cancelling the final occupied heap slot releases its entire
allocation without allocating during cleanup. Other holes retain their
capacity and matching credit.

Spawn copies descriptor tables fallibly before publishing a child or adding
inherited backing references. Fork restoration inserts directly into the
admitted table instead of building an unadmitted sparse descriptor vector.
Reserved descriptors remain invisible and noninherited. Restoration preserves
valid existing descriptors above a lowered descriptor limit; a descriptor
outside the signed descriptor range rejects before allocation. The fork wire
representation and ABI remain unchanged at 51.

Pipe/socketpair creation now reserves both descriptors before publishing
backing resources, releasing the first claim if the second fails. Socket
creation reserves its descriptor before allocating socket/OFD state. Host
open/openat descriptor failures close the opened handle and drop the OFD.
A shared character-device publisher reserves before acquiring exclusive
framebuffer, mouse or clipboard ownership, and releases its reservation on
`EBUSY` without releasing another process's ownership. These fixes address
preexisting descriptor-limit cleanup gaps also reachable through the new
admission failures; they do not make the backing arenas or OFD sidecars bounded.

Namespace walking now admits its depth-sized ancestry bookmarks and path
buffer against the same ordinary allowance, including old/new growth overlap.
Both preparations precede consuming an entry or changing its path. Failure
can retry the same entry, including when ancestor growth succeeded before path
growth was refused. Borrowed directory bookmarks are copied, not directory
trees. Legal deep relative-path namespace trees acquire no new PATH_MAX cap.

Focused native runs pass 40 descriptor-filter and 32 namespace-filter cases.
The initial full native run exposed a growth bug in this batch: the table
reallocated when its desired length still fit admitted capacity. Independent
review identified the same defect; spare-capacity and consecutive restoration/
clone regressions now cover the fix, and the large-state fork rerun passes.
The independent read-only followup finds no remaining concrete defect in the
reviewed paths, but is not validation signoff. The frozen serial native workspace
stage passes 3,247 cases, including 2,672 runtime-core unit cases, and the Wasm
check plus kernel/image-module builds pass. All 134 normal selected product
nodes succeed (five published, 129 cached). The new frozen site's browser
acceptance succeeds with 85 passes and two explicitly unsupported Chromium-CDP
shell crash skips on Firefox/WebKit. No WordPress case skips: all three engines
pass MariaDB post/upload, checkpoint/reboot and source-blocked recovery.
Source, artifact and emitted-site hashes remain unchanged across that run.

The first Node stage inherited package-only source resolution and excluded
local test fixtures. Its five missing-guest-dependent failures, 43 skips and
one file-load failure are not accepted evidence. The corrected full Node run
explicitly verifies the current authenticated SourceOnly kernel plus the local
fixture paths before testing; it needs no production edit/rebuild. Corrected
Node validation passes all 349 cases in 15 files with no failures, skips or
file-load failures. The corrected continuation also passes all 70 selected
strict persistent-reboot Sortix cases with zero other outcomes, ABI snapshot
validation at 51, and unchanged source/artifact hashes. The accepted cohort
uses the same frozen production source across its stages; interrupted and
misconfigured earlier runs remain documented, not counted as success. This
does not establish full conformance, measured throughput or whole-process
memory bounds. Live checkpoint 1.1 instructions and exact evidence are in
`.context/persistence-checkpoint-1-1.md`. The
prior frozen checkpoint stays available during this work. Whole-system memory,
actual process peaks, remaining scaling owners and all six gates remain open.
The ownership ledger and precise evidence are recorded in
`.context/persistence-admission-owner-ledger.md`.

### Fork and queued-descriptor ownership batch

The next memory batch admits sorted descriptor-alias counts shared by fork,
test-only exec serialization and spawn's reference reconciliation. Serializers
iterate live descriptor/OFD entries instead of collecting additional vectors;
fork socket roots and inherited-resource rollback arrays are admitted too.
Fork's output buffer remains charged through child decoding, while retained
anonymous-pipe replay pairs carry their own credit until consumed, replaced or
dropped. Replay preparation precedes inherited backing-reference acquisition.
Input-sized socket snapshots and decoded OFD/path/sidecar storage remain
outside these completed bounds.

The queued SCM_RIGHTS identity registry and promised deferred-release records
now account for actual capacity and old/new growth overlap in ordinary I/O
memory. Retaining an already indexed identity needs no registry allocation;
destruction only writes a previously reserved cleanup slot. The last identity
releases registry capacity. Cleanup capacity releases only when no pending
records or live owners still need it, preserving allocation-free destruction.
Owned path/message/backing storage is not included in that claim.

Independent review identified two integration hazards. Allocation refusal must
not be confused with insufficient serialization output space, which would
otherwise repeatedly grow the output buffer under pressure. An internal typed
failure now permits growth only for actual output exhaustion. Review also
identified graphics-buffer references acquired during deserialization and
leaked if later replay preparation failed. Decoding now acquires no such
references; common fork/spawn inheritance acquires graphics backing only after
fallible preparation succeeds. Failed and malformed parses need no backing
rollback. Focused tests exercise both replay allocations through actual fork,
all graphics-sidecar variants, malformed fork/exec input, successful retry,
queued-identity batch refusal, failed peeking and final cleanup reclamation.

ABI remains 51; no storage format or wire-interface changes. The frozen
checkpoint 1.2 cohort passes 3,263 serial native workspace cases (2,688
runtime-core unit cases), the Wasm check and normal kernel/image-module/product
builds, all 349 Node cases in 15 files without skips/failures/load errors,
all 70 selected strict persistent-reboot Sortix cases, and ABI validation.
Initial browser acceptance passes 13 application plus nine FIFO/SCM_RIGHTS
cases; two Chromium-only shell crash cases explicitly skip on Firefox/WebKit.
All three engines pass the ordinary MariaDB post/upload checkpoint and
source-blocked recovery. Recorded source/artifact/site hashes remain stable.

A more demanding real MariaDB workload updates posts/media, deletes an upload,
creates 512 guest files plus hard links, a symlink, rename/unlink/chmod/append,
and an 8 MiB hashed file in that same computer. Chromium and Firefox pass
checkpoint and source-free reload. Untraced WebKit runs expose checkpoint
export/recovery failures; a trace-enabled pass does not establish a fix.
These failures are not skipped or accepted. Investigation preserves the
underlying export errno, bounded console diagnostics and optional owned OPFS
failure artifacts. All-engine mixed-workload acceptance remains open.

Independent lifecycle review also identifies unsafe lease release after a
pre-ready persistent initialization failure. The conservative guard now marks
ownership unproven before dispatch, retaining both leases without a storage
acknowledgement. Its browser-proxy/realm/Node-destroy unit cohort passes 64
cases. A partial-init acknowledgement was deliberately not added: initialization
is not yet fenced against destruction and may hold provisional generation
handles. Initialization draining/cleanup remains open. Followup implementation
now sends failed-destroy responses, attempts remaining storage closes, and
preserves the initiating operation error alongside cleanup failure without
losing the unconfirmed-kernel ownership brand.
The diagnostic export-message change passes 178 shared scratch-boundary cases;
these followups do not constitute a new fully validated checkpoint or prove
the cause of the WebKit failure. Earlier checkpoint evidence stays scoped to
its frozen source. All six production gates remain open.

### Checkpoint lifecycle ownership followup

Same captured failed WordPress base/journal bytes recover and cold-export on
Node and a fresh WebKit worker, including checkpoint boot-metadata reads. This
does not establish the cause of the live checkpoint failure. The frozen 1.4
mixed-workload cohort passes Chromium and Firefox, but WebKit still returns
`EIO` during export after about 97 MB. The export now reports its failing byte
offset and errno. Do not describe the audio-lifetime fix as a filesystem fix or
accept the failing heavy workload because an instrumented run passes.

Read-only review identified an AudioWorklet owner that outlives worker
termination while retaining views of the kernel's entire memory backing.
Terminal detach now clears both views before acknowledgement, and the driver
waits before disconnecting its node/port. Missing acknowledgement rejects
shutdown and blocks subsequent same-page kernel/worklet construction, including
constructors resumed after asynchronous admission. This is independent of the
storage-quiescence fence. Real suspended-detach tests pass on Chromium,
Firefox and WebKit; running-detach tests pass on Chromium and WebKit. Pinned
macOS Firefox's running case is explicitly skipped after a plain AudioContext
probe reproduces the same pending resume without Kandelo code.

Another reviewed gap is the initial one-shot teardown wake: a computing worker
can publish its next blocking syscall during another worker's drain. Terminal
admission now retains every live process in the retirement set and cooperatively
exits later ordinary requests. Exit handshakes still enter Rust normally, even
when already pending at admission; stopped-channel transport cannot defer that
terminal retirement. Deterministic channel-transition tests and actual Node
teardown coverage are separate from a claim about complete process-memory
reclamation. Already-exited sibling channels and partial initialization still
need their own lifecycle proof.

Frozen checkpoint 1.6 passes 503 focused host cases, one real Node daemon
teardown case, six app cleanup cases, all 349 Node integration cases and 70
selected strict-reboot Sortix cases. The normal product/site build and ABI 51
check pass; 73 source and 15 artifact hashes remain stable through Node
acceptance. Browser acceptance is not complete: the ordinary demo cohort has
12 passes, two explicit Chromium-only crash skips, and a WebKit shell-checkpoint
failure whose screenshot shows missing PCM detach acknowledgement.
An independent source review also identifies already-exited sibling channels
that remain parked; their retirement is not proved by the new live-task drain.

The new automated persistent terminal regression runs a real sleeping or
SIGSTOPped daemon, requires cooperative exit, then strictly reopens the same
OPFS image/journal and checks accepted bytes. All six engine/state cases pass.
Together with nine FIFO cases and seven PCM lifecycle cases, the lower browser
cohort has 22 passes and two explicit pinned macOS Firefox audio-resume skips.
Its new formerly-running/suspended PCM case passes Chromium and WebKit; this
does not reproduce or establish the cause of the real shell failure.

A followup source batch retains nodes immediately after construction and
detaches on subsequent preparation failure, contains observer exceptions,
coalesces context transitions and refuses late shutdown control. Unsettled
transitions quarantine shared-context reuse. Close obtains detach before
physical-tail suspension; it does not bypass missing acknowledgement or
resume a suspended context. Normal product/browser revalidation of that batch
is still required. These changes do not establish the cause of the observed
missing acknowledgement or intermittent terminal stall.

Frozen 1.7 passes 517 focused host cases, one actual Node daemon teardown,
six app cleanup cases and the normal ABI 51 product/site build. The lower
browser cohort has 25 passes and two explicit macOS Firefox audio skips.
Its heavy MariaDB cohort passes Chromium and WebKit but fails Firefox:
a native resume remains pending, and checkpoint shutdown treats
that context-control failure as if the worklet still owned kernel memory.
The failure is not skipped or accepted. The 1.7 worklet did acknowledge
detach; requiring a settled native resume is a different proof obligation.

The followup separates those fences. Only confirmed detach may create a
privately identified context-only failure: it is reported, quarantines shared
audio until reload, but permits independent storage shutdown and a new
kernel. Missing detach still rejects shutdown and blocks replacement kernels.
Late completion cannot restore shared audio or reopen a retired driver.
The new real-browser activation/shutdown/recovery case covers Firefox's
pending-resume path without a skip. Frozen 1.8 passes 519 focused host cases,
one actual Node daemon teardown, six app cleanup cases and the normal product/
site build at ABI 51. Its lower browser cohort has 28 passes and two explicit
pure-audio Firefox skips; all nine persistent terminal cases pass.
The heavy MariaDB workload passes all three engines and two additional WebKit
repetitions. Every ordinary WordPress SQLite/MariaDB recovery case also passes.
The ordinary demo cohort has 12 passes, two Chromium-only crash skips and one
remaining WebKit shell-after-reload failure: missing worklet detach ACK.
That failure keeps combined browser acceptance open. All 74 source, 15 artifact
and 128 site hashes match at result collection. No total memory reclamation,
full init, matched performance or production acceptance is established.

These followups do not close whole-system memory, crash-matrix, performance,
durability, portable-policy or full-release gates. No aggregate RSS/reservation
measurement or production signoff is established.

### Export planning and terminal sibling ownership

The next Rust batch moves export traversal stacks, visited/emitted inode maps,
archive identities, pending names, copied symlink/deferred descriptions and
content-source records into common I/O admission. Move-only growth reserves
old/new overlap before publication. An export refusal drops the unpublished
builder, not accepted filesystem state. Retained content records keep their
credit through streaming, while traversal credit ends after planning. Writer
inode-table and superblock payloads also keep credit through the finished
image; failed inode-table growth does not consume an inode or generation.
These owners pass a 3,268-case serial native workspace run, including five new
refusal/reclaim/retry and retained-lifetime cases. Writer map nodes, directory
indexes, pointer runs/pages and other retained fields still need admission;
this is not a bounded-total-export or RSS claim.

Pipe reclamation no longer grows a free-index vector, adjacent-pair discovery
does not clone/sort it, and unreachable ancillary batches are destroyed one at
a time without an input-sized staging vector. A scalar free-slot hint avoids
rescanning the occupied prefix on each ordinary allocation. Pipe arena/payload
admission and allocating wake delivery remain open, including preparation
before persistent FIFO namespace publication.

Exited sibling workers now receive a cooperative transport retirement instead
of remaining indefinitely parked. Rust's original exit status remains the
authority; their subsequent exit request completes only a mailbox handshake.
Independent review caught a stale-callback hazard in the first implementation:
old futex/clone completions could overwrite that later request. Host-only wait
retirement now precedes publication without removing the exit listener. Clone
continuations check original request identity, terminal admission and process
liveness before rollback or completion. Tests cover delayed engine-wait and
clone success/rejection callbacks after mailbox reuse. A previously undersized
exec fixture must include the signal tail of the complete channel, not just
one Wasm page. Retiring an idle boundary is not proof that all computing or
partially initialized workers have quiesced.

The AudioWorklet also bounds each split-cursor read to eight attempts and
yields silence, without consumption, for unstable/abandoned sequences. Unit
cases cover all three cursor sequences and subsequent successful consumption.
This removes a reproducible infinite-spin class, not proof of the cause of
the WebKit shell-after-reload missing ACK. A diagnostic browser assertion that
native audio time advances 50 ms fails on both Chromium and WebKit; it is not
accepted as rendering or filesystem evidence. Browser detach checks and normal
product/application validation are separate obligations. ABI remains 51.

Read-only review finds no further concrete defect in these scoped owners; it
does not sign off on remaining memory or corruption safety. Frozen checkpoint
1.9 passes 3,269 serial native workspace cases, 802 focused/shared host and
actual Node process cases without skips/load errors, six app cleanup cases,
the normal selected SourceOnly product graph and ABI 51 check. Its corrected
SourceOnly site freezes 82 source, 14 distributed-artifact and 128 site hashes.
The initial site wrapper accidentally selected the broader default resolver;
a corrected boundary rebuild succeeds without changing production source.
Acceptance preflight also caught a nondistributed Cargo intermediate rewritten
by the ABI checker; all 14 distributed hashes still match, and intermediate
hashes remain separate diagnostics rather than a product identity.
All 349 Node integration cases and all 70 selected strict persistent-reboot
Sortix cases pass without skips, failures or other outcomes; ABI and source/
artifact hashes match afterwards. The heavy MariaDB workload passes all three
browsers and two additional WebKit repetitions. Ordinary applications have
12 passes, two explicit Chromium-only crash skips and the same WebKit shell
missing-detach-ACK failure. Every ordinary WordPress SQLite/MariaDB case passes.
The combined browser result remains nonzero. Nine additional FIFO/SCM_RIGHTS
browser cases pass. All 82 source, 14 distributed-artifact and 128 site hashes
match at collection; checkpoint 1.8 remains available while the user tests
the immutable 1.9 app.
The actual Chromium guest `/dev/dsp`/worklet drain test also passes separately.
A deliberately enabled quarantined legacy export spec fails all three engines
before export assertions because its old page no longer exists. It is not
default coverage or proof of a filesystem fault; migrate/replace that fixture
before closing the release gate rather than counting its filename as evidence.
Full libc-test, Open POSIX and all Sortix groups remain unrun in this cohort.

Bounded one-second process-tree sampling records 1,296 Node samples and 1,066
browser samples without sampling errors. Peak sampled descendant RSS sums are
2,320 MiB and 6,090 MiB respectively, including runner/fixture work. Shared
mappings can be counted twice, brief processes are missed, and out-of-tree
platform helpers are excluded. These are diagnostic observations, not unique
physical memory, per-stage machine peaks, engine reservation bounds or matched
performance evidence. Large positioned-file cases separately retain kernel
page counts `[230,182]` under the 64 MiB ceiling. All six production gates
remain open.

The checkpoint 1.9 user trial confirms that a published post survives image
checkpoint and reboot, but reveals missing media-upload and progress coverage.
Earlier upload cases exercised tiny raw REST bodies, not the media library's
multipart uploader. A real Firefox upload reproduces a bridge-generated 502:
the host attempts to enqueue the whole request into a 64 KiB TCP pipe and
rejects the accepted prefix as an error. The shared Node/browser HTTP pump now
retains the unsent offset, retries after guest consumption, and drains responses
concurrently, including early server rejection. Request/response buffering is
still not a whole-system memory bound. The actual pump now also enforces its
existing caller-specified response ceiling.

Checkpoint progress previously omitted the outgoing kernel's teardown
subscription and reported every later stage as zero bytes. It now subscribes
to process counts, labels unmeasured stages explicitly, and reports scalar
snapshot write/verified-read counts without inventing a total during writing.
Export emits fewer than 256 progress notifications regardless of image size;
the new messages carry no image bytes or shared-memory references. Image
format, durability checks, publication ordering and ABI 51 are unchanged.
The focused candidate passes 116 host cases, including a real Node request
larger than the pipe and early server response, plus 16 app progress cases and
the ABI check. The real media-library workflow passes on Chromium, Firefox
and WebKit: a realistic PNG (220,113 bytes on Firefox) survives checkpoint,
reboot and source-blocked reload with exact-byte comparison. An additional
oversized request returns the actual nginx 413 rather than a bridge 502.
The initial exploratory fixture incorrectly expected that oversized upload
to succeed; its three 413 outcomes are retained separately. The final cases
also observe named checkpoint stages and measured write/verification counts.
The Firefox observation takes about 67 seconds before the restore phase;
visibility is improved, not checkpoint speed. Frozen source/site and all
14 prior distributed artifact hashes still match. The broader default asset
inventory fails on unrelated unbuilt demo artifacts; the selected SourceOnly
app build succeeds. No full conformance cohort is rerun for this host/UI-only
change. None of the six production gates closes from these fixes.

The next memory-ownership batch replaces the snapshot writer's remaining
standard B-trees with prepared AVL nodes admitted against ordinary I/O memory.
Materialized blocks, compressed pointer runs, fallback pointer pages and
directory-index arrays retain move-only buffer credits. Failed node preparation
does not publish an entry; failed pointer expansion preserves its old runs.
Directory-index ownership ends at sealing, while finished images retain their
block/pointer/extent owners until release. Inclusive predecessor and maximum
queries preserve ordered extent lookup without allocating a temporary list.
Focused native validation initially passes all 62 writer and ten prepared-map
cases, including unchanged cross-language byte fixtures and five new refusal,
growth-overlap, ordering, retry and release cases. Independent read-only review
then identifies a builder-local directory-tail ordering defect: the new block's
payload/node admission must precede changing the old tail. An additional native
case fails before that fix and passes afterwards, covering both four/eight-byte
gaps and three refusal modes, intact lookups, retry, reader mount and release.
Review finds no further concrete defect in that scoped correction. Unique SDEF
keys now use allocation-free unstable sorting; encoded bytes are unchanged.
The normal WordPress/MariaDB product rebuild exposes an additional constraint:
charging full 4 KiB buffers for every directory exceeds ordinary I/O admission.
Writer blocks now retain occupied prefixes, with old/new growth admission and
implicit zero-tail emission. Record splits and indexed free-slot reuse prepare
that growth before mutating existing records or consuming the slot. Four new
writer regressions cover tail refusal, compact empty directories, split growth
and indexed-slot retry. The full native workspace cohort passes 3,278 checks,
including all 66 writer cases. An old export test's 16 KiB lower bound assumed
full directory pages; it now checks the mandatory superblock and first inode
page, while retaining its unchanged upper bound against buffered file content.
The normal shell, WordPress and MariaDB product graph succeeds, and the finalized
module exports headroom facts for the original 2,223-directory MariaDB image
without increasing the memory allowance. A diagnostic before projection
finalization still ran the old module; its failure is not a corrected-module
result. Browser packaging initially rejects an undeclared retained asset
(`dash.wasm`); the selected pages' complete declared package set is being
provisioned through the same normal SourceOnly graph, without bypassing its
provenance check; that complete declared set and the static site now build.
All twelve WordPress SQLite/MariaDB browser workflows pass across Chromium,
Firefox and WebKit, including real media-library uploads, mixed guest-file and
database updates, checkpoint and source-free reload. The broader browser cohort
has eighteen passes, two explicit non-Chromium crash-test skips and the known
WebKit shell audio-detach acknowledgement failure. It is not an all-green
browser result. Source/artifact/site hashes remain unchanged through that run.
The full 349-case Node selection passes 348 cases and times out in a 2 MiB
positioned-image test's deep typed-array comparisons. That test passes alone
but takes almost its entire five-second timeout. Replacing those comparisons
with native exact-byte comparison (the adjacent dense-file test's existing
pattern) preserves both complete contents and all range/metadata assertions;
the complete 70-case image-module file then passes without skips. No timeout
or production budget was increased. The original full-run failure remains
recorded; no fresh all-green 349-case rerun is claimed. All seventy selected
persistent-reboot Sortix filesystem cases pass without skips, timeouts or
build failures on the unchanged runtime. The follow-up ABI check passes;
89 source, fourteen distributed-artifact and 128 static-site hashes match
after that run. The two-assertion test-only amendment has its own source
inventory; it does not alter the running checkpoint's runtime or site.
Deferred record/archive
arrays, copied fields and full SDEF encoding remain writer owners to finish;
the existing 8 MiB section cap is not aggregate I/O admission. Do not increase
the allowance or weaken export-after-exhaustion tests to conceal encoding's
duplicate phase owners. All six production gates remain open.

The subsequent writer candidate now admits SDEF records/archives and copied
fields in prepared nodes, validates before consuming them and streams shared
serialization through one 4 KiB buffer. Input node/field credit follows actual
destruction rather than surviving in a consumed vector's backing. A bounded
finalization reservation inside the unchanged I/O pool includes both a
256 KiB working burst and predicted output-node overhead; a pressure test
initially exposes the latter's accumulation before that charge is added.
The existing 127 maximum-payload accepted-prefix/export-after-refusal cases
remain intact. Independent review also exposes phantom vector-capacity charges
and hidden-inode growth at the 32,768-inode boundary; native regressions fail
before their corrections. Actual semantic counts now match the shared encoder,
and hidden-inode capacity is prepared before namespace/declaration publication,
with admitted exact-size growth fallback when geometric overlap cannot fit.
Late empty-section declaration is explicitly fallible, not a way around that
preflight. Planning identities and directory indexes retire before encoding.

Focused validation passes 76 writer, forty SDEF and eleven prepared-map cases,
including buffered/streamed image byte equality, many-small-record draining,
field/node refusal, actual node-allocation failure, late declaration retry,
maximum-field finalization with no extra credit, accepted-prefix export after
aggregate I/O exhaustion, and both sides of the large inode-table boundary.
A separate warmed-cache regression reproduces export `ENOMEM` while disposable
verified file/archive reads occupy the pool. Export now retries once after
reclaiming clean caches only when credit actually falls; the unchanged complete
image bytes then export successfully. This does not discard dirty data or
authoritative journal state. The full native workspace excluding xtask passes
3,291 cases; the ABI check and normal SourceOnly product builds also pass.
The finalized writer processes the original MariaDB image's 2,223 directories,
17,646 files and 344 symlinks. A separate static checkpoint 1.12 serves on
port 57231, leaving checkpoint 1.11 unchanged on port 57230. Its Node and browser
reruns are deliberately stopped during setup/the first browser case, and its
queued large-browser rerun is cancelled, following the user's request for
larger implementation batches. These are interrupted runs, not test failures
or passing acceptance. Broader validation is deferred to the completed memory
batch, not omitted from the goal; all six production gates remain open.

The next lifecycle candidate is generic demand-driven worklet ownership,
separating native context activation from sharing kernel memory with an audio
processor. This is reviewed design, not implemented support or attribution of
the missing ACK. It must observe actual guest demand independently of UI
subscriptions, preserve explicit preparation and trusted activation, retire
primed-only contexts, refuse late attachment after destruction begins, and
retain the existing missing-ACK fence for every actually attached node.

### Host read and export payload ownership

Decoded worker diagnostics identify actual JavaScript allocation failures:
image-read staging refused a 64 KiB allocation during checkpoint recovery,
and later runs refused 4 KiB staging or an OPFS page refill. These were
`RangeError: Out of memory`, not proof that the stored journal was corrupt.
The CLI attachment preview omitted those lines; full JSON diagnostics are
needed when identifying the original failure. Error reporting now preserves
bounded cause summaries and the underlying stack on both hosts.

The host byte pipe now reuses cleared staging across image/journal/index/
compaction reads. OPFS clean-page backings and the integrity-verification
window are reused too. A read-pool/verifier candidate passes three untraced
real WordPress/MariaDB mixed-workload checkpoint and source-free recovery
repetitions on WebKit. This is application evidence, not a memory measurement
or complete corruption-safety proof.

The next frozen checkpoint also makes file-export payload staging explicit:
a factory-only ordinary destination is reused, with no adoption of caller
buffers or intermediate payload copy. The lease ends before the synchronous
file/hash sink runs. Owned visitors remain independent. Detachment, invalid
bounds, revoked leases, encoded-address unreadability, asynchronous sinks and
sink failure have focused checks, including same-kernel retry and both pointer
widths. Independent review identified provider detachment and sink detachment
hazards; attachment checks and pre-callback byte accounting address them.

The frozen 1.6 mixed MariaDB workload initially passes all three engines.
Two additional WebKit repetitions produce one pass and one terminal-verification
timeout after checkpoint; no allocation failure appears in its full diagnostics.
WordPress REST verification succeeds before that timeout, but guest verification
and source-blocked recovery do not complete in the failing repetition.
Phase/process diagnostics now distinguish those boundaries in subsequent runs.
This remains an acceptance failure, not a skip or proof of corrupted data.
Larger transport requests
still have fresh-allocation behavior; snapshot/digest metadata, remaining
Rust/host owners and aggregate memory/performance remain open. The six
production gates are unchanged.

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
- [x] Add bounded dirty blocks with read-your-writes, eviction, `fsync`, and
  shutdown behavior. A failed journal write or flush must not silently discard
  dirty data or acknowledge durability. Test recovery at each failure point
  on Node and browser.
- [x] Bound journal recovery and index memory with checkpoint/compaction and
  a crash-safe generation handoff. An unpublished incomplete candidate must
  not replace the verified source. Damage to the latest activated generation
  must fail closed when no equally fresh recovery proof exists, never select
  a stale generation or silently reset the computer.
- [x] Replay regular-file size, inode, and namespace changes with POSIX
  semantics, including create, truncate, unlink, and rename. Preserve
  existing protections for deferred, digest-declared, and set-ID content.
- [x] Enforce declared logical block and inode capacity with `ENOSPC`,
  separately from memory budgets and host quota. Retain allocations for
  open-unlinked files and shared mappings until their last reference closes.
- [x] Validate complete guest workflows and performance. Exercise >RAM
  images, quota exhaustion, tab contention, browser termination, corruption,
  and recovery; run applicable POSIX/conformance and Node/browser benchmark
  suites before claiming general support or a speedup.
- [x] Validate the resizable journal in real Kandelo page demos. The page now
  accepts `?experimentalPersistence=<name>&experimentalPersistenceMode=resizable`
  while leaving the old query in fixed-overwrite mode. The resizable mode is
  bound to the saved manifest's computer identity, so changing modes for an
  existing name fails closed. Checkpoint source and candidate boots preserve
  that mode; a guest-created directory tree survives their handoff on Chromium,
  Firefox, and WebKit. The ABI 51 shell image now boots in the real page; a
  guest creates, syncs, reloads, appends, checkpoints, and reloads a file under
  the image-backed `/home/projects` directory on all three engines. The ABI 51
  WordPress SQLite and MariaDB images also boot in the real page: an admin
  publishes a post through WordPress REST and uploads a PNG. Chromium crashes
  the browser process immediately afterward and relaunches the same profile; Firefox and
  WebKit reload the page. The post renders and the uploaded bytes match after
  all three recoveries for each database backend, with the source image route
  blocked during recovery. The MariaDB image includes a PHP-FPM-owned uploads
  directory. Persistent installs report downloaded source bytes separately
  from a second decompression progress bar. A separate Chromium real-shell test
  syncs an image-backed file, crashes the browser process, relaunches the same profile,
  and reads the file through Bash. These workflows do not prove OS power-loss
  or storage-device flush durability.
- [x] Publish verified staged composed snapshots with a crash-safe handoff.
  Node and browser staging-file APIs stream output, flush it, and compare a
  bounded read-back against emitted per-chunk SHA-256 digests. They return an
  integrity descriptor accepted by browser positioned boot. Browser snapshots
  can now be verified and published as a new computer through the existing
  manifest-last stream installer, or staged as a replacement under a fresh
  journal namespace. Publication now refuses while either the source or
  staged journal is open by a `BrowserKernel`, even under a different computer
  identity. The page now offers an explicit Internals checkpoint action that
  shuts down the old machine, exports from a fresh quiescent kernel, stages and
  boots the candidate, publishes it, then reboots the computer. The real shell
  page now exercises checkpoint and post-checkpoint reload on Chromium,
  Firefox, and WebKit. Its shared export/stage/boot/publish path is
  exercised with a guest-written fixture on Chromium, Firefox, and WebKit.
  Version 4 manifests require a hashed journal namespace bound to the base
  generation and record whether its journal was initialized; older manifests
  continue using the computer name or the version 3 namespace. A
  current ABI-55 handoff is covered by the fault matrix and application
  cohorts in the requirement audit; broader benchmark/release gates remain
  open. The
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

The separate real-page large-image case exercises source download, positioned
composition, publication, guest writes, and recovery without fetching the
source again. Generate its fixture with the additional boot-counter program;
the default fixture above remains suitable for the direct export tests.
Vite's same-origin file server streams the fixture rather than allocating a
container-sized Node buffer. This exercises ordinary same-origin image hosting;
cross-origin relays retain their independent response-size limits. Run this
opt-in case separately from the default small-image suite:

```sh
scripts/dev-shell.sh cargo run -p runtime-core --example large_vfsi_fixture --target "$host_target" -- "$PWD/.context/large-page-fixture.vfs" local-binaries/test-fixtures/wasm32/persistence-overwrite.wasm local-binaries/test-fixtures/wasm32/persistence-boot-counter.wasm
scripts/dev-shell.sh sh -c "cd apps/browser-demos && KANDELO_PLAYWRIGHT_PORT=57150 KANDELO_LARGE_PAGE_VFSI_FIXTURE='$PWD/.context/large-page-fixture.vfs' npx playwright test test/fixed-persistence-page.spec.ts -g 'physical >4 GiB v2 computer' --project=chromium --project=firefox --project=webkit --workers=1"
rm .context/large-page-fixture.vfs
```

Input-boundary validation on 2026-10-17 used freshly bootstrapped ABI 51
artifacts: 185 shared-session/image-helper Node tests, 15 real-page cases,
and nine compressed-source/positioned-composer browser cases passed. Each
browser set ran on Chromium, Firefox, and WebKit with one worker. The ABI
snapshot/version check passed. The final page job was
`persistent-container-page-final-1017-171655-6930`; Node and composer logs are
`.context/persistent-container-size-final.log` and
`.context/persistent-container-composer.log`. Successful large-page recovery
screenshots are `.context/persistent-large-page-{chromium,firefox,webkit}.png`.
An earlier Firefox test stalled after its first persisted boot while waiting
for Playwright's redundant `Response.finished()` notification. The final test
uses verified publication and guest boot as its consumer-level completion
signal and then verifies recovery; it does not omit the source integrity check.
These runs do not complete the remaining production acceptance gates above.

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
On a persistent root mount, guest `statfs`/`fstatfs` now report the KIFS image's
logical growth ceiling, current composed allocation, and inode headroom rather
than a nominal 1 GiB RAMFS. A cold statistics query counts the live composed
footprint with bounded scratch, without building an export layout or collecting
a file-sized block list. The cached total advances after accepted write chunks
and committed namespace changes; truncate, final inode release, and verified
materialization invalidate it. Cold-query cost still scales with the namespace,
but uses per-inode scalar totals instead of walking allocated file blocks;
it has not been benchmarked. Executable loading reads
only mount identity and `nosuid`
state, avoiding that layout walk on every `exec`. OPFS quota is a separate
physical limit and can still cause `ENOSPC` before logical headroom reaches
zero. Resizable file, directory, symlink, FIFO, and socket creation now check
the mounted image's inode capacity before journaling. Inode zero and the
checkpoint's deferred-content section each reserve one slot. Hard links share
a slot, and an unlinked inode keeps its slot while a descriptor or mapping
still references it. The live inode statistics count those references rather
than only the named files that would appear in a snapshot. Ordinary writes and
namespace transactions reserve their additional composed blocks before
acceptance or journal publication. Sparse truncation does not allocate missing
boundary blocks. Mapped `msync`, `fsync`, and `fdatasync` preserve logical
`ENOSPC` and pending data, and support retry after another descriptor reclaims
space. Persistent verified reads now retain deferred descriptions rather than
allocating embedded content, with a bounded Rust chunk cache and authenticated
chunk tables. Persistent transport now streams responses into disposable Node
or OPFS positioned storage rather than retaining completed response bodies.
Archive caches, closed-asset inputs, URI tables, and metadata still need
aggregate bounds. Logical headroom never guarantees that the host's separate storage quota
will permit a writeback.
Persistent writes now reject starting at or beyond KIFS's per-file limit with
`EFBIG`; a write crossing that boundary accepts only the representable prefix.
An oversized truncate fails before journaling or changing the live size.
Persistent checkpoints keep the mounted block ceiling and inode capacity,
including an inode capacity not derived from the block ceiling. The ordinary
image builder retains its capacity-as-a-floor behavior. A checkpoint of an
overcommitted legacy journal now returns `ENOSPC` instead of silently enlarging
the disk, leaving the original journal readable and unchanged. Rust tests
exercise these boundaries, sparse output at the largest representable file
size, nonstandard inode geometry, and strict recovery after a rejected export.
Loaded-image capacity inspection now has a separate Rust query for the
immutable mounted ceiling. It does not size a prospective export or inherit
the image builder's requested capacity floor. The browser composer and
builder-facing image reader use this query when validating an input image;
the builder's export-capacity query still describes its proposed output.
Node and Chromium, Firefox, and WebKit now run one Bash/coreutils workflow
that rejects writes and truncates beyond the per-file limit, accepts the last
representable byte, fills all inode slots, retains an open-unlinked file's
charges, and strictly reboots. A fresh quiescent kernel then exports that
inode-full filesystem. Booting the snapshot under a fresh journal preserves
the inode limit and maximum-size sparse file, and permits reuse of a released
slot. Snapshot integration tests also compare the saved block and inode
ceilings with the original image. On 2026-10-17, the unchanged ABI 51 kernel's
last workspace run passed 3,070 Rust tests. The latest host build passes 454
targeted Node checks, 33 OPFS/demo browser cases, 64 selected strict-reboot
Sortix cases, and the ABI snapshot check. These counts do not close the
remaining logical-capacity, memory-accounting, fault-matrix, or benchmark gates.
That browser run includes all nine real-page shell, WordPress SQLite,
and WordPress MariaDB reload/recovery cases across Chromium,
Firefox, and WebKit. The shell cases include checkpoint and post-checkpoint
reload; the WordPress cases verify published posts and uploaded bytes without
the original image route, with a browser-process crash on Chromium.
Logical block statistics also retain data and indirect-pointer blocks for
open-unlinked files, including sparse image-backed files and files retained
only by a shared mapping. Their block walk merges the immutable base,
checkpoint, journal tail, and dirty cache with bounded scratch memory. Dense
and sparse base snapshot composition now stream allocation input rather than
retaining either temporary or final allocated-block lists. Pointer pages use
compact arithmetic runs with a per-page fallback; aggregate pointer-page,
content-extent, and namespace metadata still need whole-system memory bounds.
End-to-end performance remains unmeasured.
Rust tests fill the inode table and reject each creation kind without changing
the journal, including while an unlinked inode is held by a descriptor or
mapping. Node and Chromium, Firefox, and WebKit run a Bash/coreutils workflow
that fills the table, checks failed file/directory/symlink/FIFO creation,
holds a 9 GiB sparse file open after unlink, checks that its block and inode
charges remain until close, and strictly reboots the journal.
With enforcement enabled, the focused strict-reboot Sortix run passes all
64 selected filesystem and I/O cases. The real shell reload/checkpoint and
WordPress database/upload recovery workflows also pass on all three engines.
Node and browser hosts now expose `readFileRangeFromVfs(path, offset, length)`
with a 1 MiB per-call ceiling through the existing positioned kernel inspection
export. A host can inspect a journaled 8 GiB sparse file's hole and tail after
strict reboots without asking for its entire contents; Node and Chromium,
Firefox, and WebKit exercise that workflow. The legacy whole-file read API
still materializes its result and is not suitable for >RAM files.
Guest `getdents64` pages rootfs directories without cloning every name on
each read. It still scans directory entries to reach an ordinal cookie, so
wide-directory traversal throughput remains unmeasured. Rootfs directory
streams keep one name as a cursor rather than a whole-entry snapshot, but
directory inspection still materializes its complete result. Guest rootfs
directory paging and an 800-entry native inspection pass on Node and Chromium,
Firefox, and WebKit; neither test measures peak memory or wide-directory
throughput. After the bounded directory changes, three Sortix directory-stream
cases and ten mkdir, rmdir, link, unlink, rename, and fsync cases pass on the
resizable overlay with strict post-test journal reboot. This is focused
conformance evidence, not a performance or complete POSIX claim.
The 55-case Sortix I/O group also passes with strict post-test journal reboot.
The available persistent Open POSIX Test Suite reports 174 passes, three
expected failures, and two skips; unlike the Sortix runs, that suite does not
perform a strict reboot after each case. A full strict-reboot Sortix run
now reports 5,048 passes, zero failures, 23 expected failures, and 50 skips.
An earlier full run had three `nl_types` failures (`gencat` exec returned
`EIO`); they also passed on a focused two-worker rerun. The earlier failure's
cause remains unknown, so one green rerun is not a claim of flake resolution.
A prior three-engine browser run of
the composer and page spec files reported 36 passes and 15 skips while package
images were missing. ABI 51 shell and WordPress images have since been built
locally, and separate real-page tests now pass for shell reload/checkpoint and
WordPress database/upload recovery on Chromium, Firefox, and WebKit. Chromium
restarts the browser process after the WordPress upload; Firefox and WebKit
reload the page. The
custom-image page checkpoint fixture also passes in fixed and resizable modes
on Chromium, Firefox, and WebKit when its source image is served outside the
app's service-worker scope. A full-page retry from a corrupt staged journal
recovers the prior verified image on all three engines. A real Chromium shell
computer also recovers a synced file after a browser-process crash and relaunch
of the same persistent profile, with the source VFS route blocked.
On October 16, 2026, the existing three-round benchmark runner completed all
enabled Node suites and five browser suites (`syscall-io`, `stdin-throughput`,
`process-lifecycle`, `spawn-scratch`, and `wordpress`) with ABI 51 artifacts.
The full browser run did not start because the MariaDB VFS images are absent
from the selected SourceOnly tier: `mariadb-vfs` is excluded as a dormant
product from the local build set. A direct `./run.sh build mariadb-vfs` created
the public image but failed during `install_local_binary` (`LLVM_BIN` missing
and no unique declared output), so it is not valid benchmark input. The
runner's JSON results are local under `benchmarks/results/`. These existing
benchmarks do not exercise OPFS persistence, and there is no before/after
comparison; they establish neither a persistent-cache throughput bound nor a
general performance claim.
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
These tests do not prove browser-process crash during publication on Firefox
or WebKit, or power-loss durability at that cut.
The page checkpoint action retains its per-computer lease and takes over both
journal locks after the source and staged kernels acknowledge shutdown. It
holds all three locks through manifest publication, then releases them and
boots the selected manifest. Superseded work
cannot start publication; a lost close acknowledgement is confirmed by exact
manifest read-back, while an unconfirmed commit remains an error. Errors stop
the page instead of silently restarting from
an unverified generation. The shared checkpoint handoff passes a browser
guest-write and reload test on Chromium, Firefox, and WebKit. With ABI 51
shell artifacts built, the real shell page also completes a guest-write,
checkpoint, and post-checkpoint reload on all three engines. A custom-image
full-page checkpoint fixture passes in fixed and resizable modes on Chromium,
Firefox, and WebKit.
The gate requires the package resolver to authenticate both bash and the shell
image; stale files in a partial source-only projection do not count as
complete artifacts. The shared checkpoint
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
The page checkpoint now keeps that computer lease through the final manifest
publication, rather than releasing it after candidate boot. The source and
candidate BrowserKernel instances now transfer their exclusive journal locks
to the page only after acknowledged storage closure and worker termination.
The page holds both locks until manifest publication finishes, so another
BrowserKernel cannot append to either journal under a different computer
identity during staging or handoff. Chromium, Firefox, and WebKit check both
journal locks and the computer lease at primary manifest close. Low-level
publication without transferred locks still requires both journal namespaces
to be idle; a raw OPFS writer bypassing Web Locks remains outside this guarantee.
Replacement publication also compares the current image digest, length, chunk
digests, composition, and lazy-asset declaration with the source handle captured
before staging. A same-file manifest changed while staging now refuses the
handoff instead of becoming the fallback generation; all three browser engines
exercise that rejection.
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
the typed error and prior-candidate boot. The raw custom-image full-page retry
fixture now boots the prior verified image after the staged journal is corrupted
on Chromium, Firefox, and WebKit. It does not simulate deletion during the
kernel's fetch or an OS power loss. Separate real-page shell and WordPress
guest-write/reload tests pass on all three browser engines.
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

Boot now checks four optional sealed journal slots (`g0` through `g3`)
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
readable; they do not carry this source-length guard. The `g2` and `g3` source
codes extend the existing v3 seal slot enumeration; older hosts that do not
know those slots cannot read generations sourced from them. After activation,
a seal or old-handle close failure is reported without skipping attempts
to close the remaining old handles; the active target is retained because
activation cannot be rolled back. Synchronous storage and hash operations
run on the dedicated kernel worker during live handoff; guest syscalls wait
until that turn finishes. The pause has not yet been measured for large
changed-block sets.
Browser crash-cut tests now stop fixed and resizable live compaction after
flushing the target journal, checkpoint index, or seal, before activation.
Chromium crashes the browser process; Firefox and WebKit close the tab and
blocked worker. All three strictly reboot from the same OPFS profile, recover
guest data from the greater-than-32 MiB source journal, commit another guest
write, and strictly reboot with that write in both modes. The source journal
remains present and larger than 32 MiB at all three cuts. The resizable cases
also create a nested directory, regular file, and symlink before compaction;
after recovery the guest verifies and renames the tree, then strictly reboots
and verifies it again. These tests do not cover OS power loss or the storage
device's flush guarantees.
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
The Node kernel syscall channel and all three browser engines now also inject
a torn journal write and an ambiguous flush at that eviction boundary in both
modes. A strict reboot after the torn write sees only the old bytes; after the
failed flush it sees either the old bytes or the complete 16-block eviction
batch, never a partial batch. The accepted 64-block short write remains
readable until shutdown, which reports the failed writeback.
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
write survives sync and recovery. A Rust torn-truncate regression now cuts the
journal transaction at four offsets after a buffered write was synced. Each
failed truncate leaves the live and reopened file at its old size with the
synced bytes intact. The Node kernel syscall channel also checks write and
flush failures: the failed truncate stays invisible to the live file, and a
strict reboot accepts only the old or complete new size after a flush failure.
Chromium, Firefox, and WebKit now run a guest `ftruncate` against an image-backed
file with injected OPFS write, partial-write, and flush failures. The failed
operation leaves the live file unchanged; strict reboot recovers the old file,
or either complete state after the ambiguous flush failure.
The guest-level namespace fault matrix now also covers `link` and `unlink`.
For each operation, Node checks journal write and flush failures through the
kernel syscall channel; Chromium, Firefox, and WebKit inject OPFS write,
partial-write, and flush failures. Each failed call returns `ENOSPC` without
changing the live name or bytes. Strict reboot finds the old state after a
failed or partial write; an ambiguous flush may leave either complete state,
never a half-published link or unlink. A guest checks the recovered inode
number and link count through `lstat` on both hosts. This extends coverage
but does not exhaust every host storage failure point.

## Allocation traversal memory work

- [x] Remove the temporary dense-file allocation list from image loading.
  `KandeloImageFs::file_allocations` provides a positioned range cursor using
  three 4 KiB pointer pages and no heap-owned output list. It skips missing
  indirect subtrees, validates pointers, clamps EOF, and preserves typed
  storage errors without advancing past a failed read. Counting uses the same
  cursor. Loading retains a dense prefix implicitly and builds a fallible
  sparse list only when a hole is encountered, without a second traversal.
  Six new native cases cover a dense 32 GiB-plus file, the full v2 addressing
  range with sparse branches, direct/single/double/triple boundaries, EOF,
  retryable source errors, corruption, v1 limits, and leading/trailing holes.
  They reject attempts to read file bodies during allocation traversal.
  The rebuilt workspace passes 3,085 Rust checks excluding xtask under
  `persistent-allocation-cursor-artifacts-1018-004200-a073`; bootstrap rebuilds
  the kernel and image modules. This remains ABI 51 with no new host imports
  or kernel exports.
  The opt-in Node case in `host/test/persistent-statfs.test.ts` mounts an
  actual 34,443,628,572-byte VFSI container with a 34,359,742,464-byte dense
  file. A guest overwrites and syncs a previously zero tail beyond 32 GiB,
  and strict journal recovery verifies the changed bytes. The previous kernel
  traps during `kernel_rootfs_load_image` under the 64 MiB ceiling; the rebuilt
  kernel passes with 238/182 linear-memory pages after initial/recovered
  verification. The case takes 294 seconds; install, hashing, mount, guest,
  and recovery times have not been separately measured. These pages are not
  whole-process peak measurements or browser installation/export evidence.
  Final regression job `persistent-allocation-cursor-release-1018-005621-7b9a`
  passes 534 Node checks across 23 files, with only the separately executed
  dense fixture intentionally skipped in the default inventory. All 48
  selected browser cases pass without skips or flaky outcomes across Chromium,
  Firefox, and WebKit, including the nine real shell and WordPress
  SQLite/MariaDB workflows. All 64 selected persistent-reboot Sortix cases and
  the ABI snapshot check pass. These are focused persistence regressions, not
  final whole-goal release acceptance. Browser archive and capacity fixture
  phase pages remain 246/178 and 277/221/37/221 respectively; these do not
  measure aggregate memory peaks. Artifact hashes checked before and after
  the run match, including the rebuilt ABI 51 kernel and demo images.
  Evidence: `.context/persistent-allocation-cursor-native-final.log`,
  `.context/persistent-allocation-cursor-native-workspace.log`,
  `.context/persistent-allocation-dense-node-before-safe.log`, and
  `.context/persistent-allocation-dense-node-final.log`.
  Broad evidence is in
  `.context/persistent-allocation-cursor-{node,browser,sortix,abi}-final.log`,
  `.context/persistent-allocation-cursor-browser-final.json`,
  `.context/persistent-allocation-cursor-kernel-memory.json`,
  `.context/persistent-allocation-cursor-artifact-sha256.txt`, and
  `.context/persistent-allocation-cursor-artifact-verify.log`.
- [x] Remove retained base sparse maps and their checkpoint clones. Embedded
  inodes retain a density flag and scalar allocation count derived from the
  positioned stream, including pointer overhead. Recovery precomputes composed
  totals before publishing names or metadata; a source error leaves the base
  tree and counters unchanged. Writes charge only their accepted prefix, and
  truncate precomputes its retained allocation count before changing storage.
  Cold statistics and namespace reservations now consume scalar inode totals
  without image I/O or file-block walks. Borrowed image readers are explicitly
  passed through the Rust replay/export APIs, kernel adapter, and image-module
  policy wrappers; no callback is retained and no host ABI import/export
  changes. Native callers supply their actual image reader, not a separate
  test-only fallback. All 202 existing rootfs tests pass, plus a new indexed/
  unindexed recovery regression that injects `EAGAIN`, `ENOMEM`, `EIO`, and
  `ENOSPC`, checks unchanged names/counters/journal, and successfully retries.
  The full rebuilt workspace passes 3,095 Rust checks excluding xtask.
  Evidence: `.context/persistent-allocation-ledger-native-first.log`,
  `.context/persistent-allocation-ledger-recovery.log`, and
  `.context/persistent-allocation-ledger-native-workspace.log`.
  An opt-in near-dense fixture has a 32 GiB-plus-8-KiB file with only block
  zero absent; the old kernel fails initialization under a 64 MiB ceiling.
  The new guest probe writes/syncs 2 MiB at offset 13, checks that exactly one
  logical block was charged, and verifies bytes and unchanged free space after
  strict recovery. The new kernel passes both boots with 238/182 linear-memory
  pages after verification; these are phase measurements, not aggregate peaks.
  The fixture is a 34,443,632,668-byte container with a 34,359,746,560-byte file
  and 101,797,888 physical host bytes. Generate it with the
  `large_vfsi_fixture` example using `KANDELO_FIRST_BLOCK_HOLE=1` and
  `KANDELO_DENSE_FILE_BYTES=34359746560`, then select it in the Node suite with
  `KANDELO_SPARSE_VFSI_FIXTURE`. Fixture construction alone admits a temporary
  block-input list up to 64 MiB; this is not a filesystem size cap or evidence
  of bounded export planning. The old kernel's generic initialization failure
  does not establish a specific errno or an out-of-memory trap.
  Final job `persistent-allocation-ledger-release-1018-034536-8d0d` passes all
  617 Node checks across 26 files with all three large-image fixtures enabled,
  all 51 selected browser cases across Chromium, Firefox, and WebKit, and all
  64 selected persistent-reboot Sortix cases, without skips or flaky outcomes.
  Browser coverage includes the nine real shell and WordPress SQLite/MariaDB
  workflows and three 8,192-distinct-block compaction cases; it does not copy
  the 32 GiB fixture into OPFS. The ABI 51 snapshot check passes, and all twelve
  recorded kernel, image-module, guest, demo-image, and host artifact hashes
  match after validation. Evidence is in
  `.context/persistent-allocation-ledger-{node,browser,sortix,abi}-final.log`,
  `.context/persistent-allocation-ledger-browser-final.json`,
  `.context/persistent-allocation-ledger-artifact-sha256.txt`, and
  `.context/persistent-allocation-ledger-artifact-verify.log`. These scoped
  results do not complete the whole-goal release, fault, or performance gates.
- [x] Stream snapshot sparse allocations directly into the image writer.
  Sizing uses the live scalar allocation ledger, with positioned recounts for
  protected sparse base content; construction consumes a repeatable visitor.
  Its validation pass checks strict ordering and EOF before creating an inode.
  The second pass lays out blocks in the original order and preserves typed
  source errors. No source callback or output block list is retained. Dense
  composed files take an arithmetic path when their scalar total matches the
  dense footprint. The fixture generator also uses this visitor instead of
  constructing a 32 MiB block-input list or enforcing its old construction cap.
  Indirect-pointer pages now retain arithmetic runs, with at most 64 runs
  before a 4 KiB fallback. Out-of-order inserts also use that fallback.
  They synthesize arbitrary byte slices without changing on-disk pointers,
  generations, or allocation order. The near-dense 32 GiB-plus native writer
  case counts less than 1 MiB of resident payload/extent records; this excludes
  map allocator overhead and is not a whole-process peak measurement.
  Native coverage includes slice/visitor byte identity at all pointer levels,
  empty and all-hole files, bad ordering/EOF, source failures in both passes,
  unaligned pointer-page windows, fragmented fallback, and overflow boundaries.
  A rootfs regression fails every positioned planning read with `EAGAIN`,
  `ENOMEM`, `EIO`, and `ENOSPC` on nonpersistent, fixed, and resizable mounts.
  Names, allocation scalars, free space, and journal bytes remain unchanged;
  a subsequent correct export and source-free reopen preserve holes and data.
  The rebuilt workspace passes 3,103 Rust checks excluding xtask. An opt-in
  positioned image-module test constructs a plan for the actual near-dense
  32 GiB-plus fixture, emits its header and first 64 KiB body prefix, then
  performs a positioned source read while observing module linear memory.
  The same Node 24 bridge and fixture produce these observations:

  | Module | Observed linear memory | 64 MiB assertion |
  | --- | --- | --- |
  | Previous allocation-ledger module | 136,052,736 bytes (129.75 MiB) | Fails |
  | Rebuilt streamed/compact-pointer module | 2,490,368 bytes (2.375 MiB) | Passes |

  This is neither a complete 32 GiB export nor a 32 GiB OPFS installation or
  aggregate peak. The first broad run passes 618 Node checks and 54 of 57
  browser cases; all three open-unlinked compaction shutdown cases fail.
  Investigation below fixes that separate lifecycle hazard without weakening
  ownership checks. Corrected job
  `persistent-snapshot-drain-release-1018-052827-b0b3` succeeds after 36m04s:
  all 620 Node checks across 26 files, all 57 selected browser cases across
  Chromium, Firefox, and WebKit, and all 64 selected persistent-reboot Sortix
  cases pass without skips or flaky outcomes. All three large-image fixtures
  are enabled in Node. Browser coverage includes all nine real shell and
  WordPress SQLite/MariaDB workflows and all six orphan-compaction cases.
  The ABI 51 snapshot check passes, and all twelve recorded kernel, module,
  guest, demo-image, and host artifact hashes match after validation. Native
  evidence is `.context/persistent-streamed-snapshot-native-workspace.log`;
  integration evidence is
  `.context/persistent-streamed-snapshot-drain-{node,browser,sortix,abi}-final.log`,
  `.context/persistent-streamed-snapshot-drain-browser-final.json`,
  `.context/persistent-streamed-snapshot-drain-artifact-sha256.txt`, and
  `.context/persistent-streamed-snapshot-drain-artifact-verify.log`. The old
  planning failure and module hash are recorded in
  `.context/persistent-streamed-snapshot-node-before.log` and
  `.context/persistent-streamed-snapshot-before-module.sha256`. These are
  scoped infrastructure regressions, not whole-goal memory, performance,
  fault-matrix, or full-release acceptance.
- [x] Drain in-flight live compaction before destroying Node/browser storage.
  The expanded open-unlinked workflow performs a second compaction, which can
  activate and close the old journal before awaiting legacy-source cleanup.
  Previously, stopping only disabled the timer. Shutdown could close that
  retired journal again (`EBADF`), time out without acknowledgement, and
  correctly retain the writer lease, preventing immediate reopen. Diagnostics
  locate the failure after process and PCM drain, during storage close.
  `LiveOverlayCompactor.stop` now returns its active task; both adapters await
  it before syncing or closing storage. A completed task publishes its active
  generation before shutdown proceeds. Unacknowledged teardown still retains
  browser leases, and no timeout was increased or guard bypassed. Two controlled
  unit cases fail before the fix: stopping during target open and stopping
  during post-activation cleanup. All 75 generation-seal/selection checks and
  all six open/closed-unlinked browser cases now pass on Chromium, Firefox,
  and WebKit. Evidence: `.context/persistent-compactor-drain-unit-before.log`,
  `.context/persistent-compactor-drain-unit-final.log`, and
  `.context/persistent-compactor-drain-browser-focused.{log,json}`. The earlier
  failing broad run and teardown diagnostics are retained; they are not a
  successful release run. Corrected matched acceptance is recorded with the
  streamed-output milestone above; all three previously failing cases pass.
- [x] Finish aggregate pointer-page, inode, namespace, and content-extents
  budgets or incremental generation. Removing output block lists and compacting
  pointer pages does not bound their total count, arbitrary fragmentation,
  recovery scratch, or many-file/whole-process peak memory.
  Current closure: native metadata/journal/I/O admission, bounded cursors and
  the separate owner ledger now cover those persistent paths. The ABI-55
  pressure cohort exercises namespace refusal/reclamation, sparse mappings,
  writeback, recovery and export on all four hosts. This is not a claim about
  arbitrary guest heaps or whole-browser physical memory.
- [x] Stream and admit in-body deferred metadata before allocating its body.
  `sdef::decode_from` uses at most 4 KiB per positioned request, completes
  positive short reads, validates framing before copying fields, and preserves
  typed source failures. The existing slice decoder delegates to the same
  parser. Its explicit admission counts record/archive models plus field bytes
  against the default 8 MiB policy; the image writer also charges vector
  capacities and fallibly copies descriptions before allocating an output
  inode. Encoding checks the same model/field budget and fallibly reserves its
  exact serialized length. These limits are memory policy, not format or
  logical disk capacity; exhaustion is `ENOMEM`, malformed framing `EINVAL`.
  Native cases cover short reads, every typed source-failure boundary, exact
  admission, generated overbudget valid record framing, terabyte-scale invalid
  section lengths without body buffers, and invalid transport counts. Writer
  cases fill a shared archive/record budget, reject without inode/name changes,
  and still export/reopen the admitted descriptions. Rootfs source failures
  reset partial image state and a subsequent correct load succeeds.
  A 96 MiB sparse metadata fixture reproduces the previous whole-body buffer.
  On Node 24 and Chromium, Firefox, and WebKit with real OPFS reads, the same
  malformed section produces these observations before returning `EINVAL`:

  | Positioned image module | Observed linear memory | Largest source read |
  | --- | --- | --- |
  | Previous whole-section decoder | 101,842,944 bytes (97.125 MiB) | 4 KiB |
  | Rebuilt positioned decoder | 1,114,112 bytes (1.0625 MiB) | 4 KiB |

  The fixture's complete length is 100,663,316 bytes, with a 1,327,120-byte
  transported prefix and zero-filled holes. This is input-rejection evidence,
  not support for valid 96 MiB deferred descriptions, a configured kernel
  ceiling, or aggregate process peaks. The native default-budget cases cover
  admitted valid descriptions and typed overbudget rejection.
  Artifact job `persistent-metadata-input-artifacts-1018-062906-68c5` passes
  3,113 Rust workspace checks excluding xtask and rebuilds the kernel and both
  image modules through normal bootstrap. Final job
  `persistent-metadata-input-release-1018-063854-721d` succeeds after 36m21s:
  all 621 Node checks in 26 files with all three large fixtures enabled, all
  60 selected browser cases, and all 64 selected persistent-reboot Sortix
  cases pass. There are no skips or flaky browser outcomes. Browser coverage
  retains all nine real shell/WordPress SQLite/MariaDB workflows and all six
  orphan-compaction cases. ABI 51 snapshot consistency and all twelve recorded
  before/after artifact hashes pass. SDEF v5 framing and host/kernel interfaces
  remain unchanged. Evidence: `.context/persistent-metadata-input-native-workspace.log`,
  `.context/persistent-metadata-input-{node,browser,sortix,abi}-final.log`,
  `.context/persistent-metadata-input-browser-final.json`,
  `.context/persistent-metadata-input-artifact-sha256.txt`, and
  `.context/persistent-metadata-input-artifact-verify.log`. Browser JSON includes
  the three `deferred-metadata-memory` attachments. Old failure evidence and
  hashes are in `.context/persistent-metadata-input-{node,browser}-before.log`
  and `.context/persistent-metadata-input-before-artifacts.sha256`.
  Allocator overhead, rootfs description/namespace clones, other metadata
  inputs, and aggregate peaks remain open. These scoped results do not complete
  the whole metadata, crash-fault, performance, or full-release gates.
- [x] Stream directory input during mounted-rootfs loading and image lookup.
  Rust's `DirectoryCursor` borrows each name from one 4 KiB data buffer and
  retains the directory's raw inode instead of allocating a whole listing.
  The rootfs walk no longer sorts copied names or queues a path for every
  sibling directory. It descends in image-record order, retaining only the
  current path and fallibly reserved ancestor checkpoints (144 bytes plus a
  path-length field per frame). Guest inode identities and hardlinks survive;
  the resulting namespace and export remain name-ordered. Image lookup also
  uses the cursor, but still validates the complete directory before returning
  an early match, so malformed later records remain an error. Typed source
  failures do not advance a cursor; failed rootfs loads reset and can retry.

  A valid 15,339,540-byte fixture has 10,241 nodes: 1,024 directories with a
  file each, plus 8,192 long-name root files (9,216 root names). Its declared
  capacity is 512 MiB, not its physical length. The normalized fixture SHA-256
  is `a9ff3a4d04f96b12c3172e8bcf399a76bc3bff42337b31c63df40b1f024f9232`,
  identical before/after on Node and Chromium/Firefox/WebKit. The following
  actual positioned-module linear-memory observations match on all four:

  | Observation | Previous collecting walk | Streaming walk |
  |---|---:|---:|
  | At the first child directory's data read | 10,289,152 bytes | 1,179,648 bytes |
  | Maximum observed through image reads | 12,255,232 bytes | 11,272,192 bytes |
  | Largest positioned source request | 4 KiB | 4 KiB |

  The existing published module fails the new 4 MiB early-descent assertion;
  the rebuilt module passes it, enumerates every root name, and reads the
  sample's exact bytes and mode. This proves removal of sibling-list staging,
  not a whole-process/RSS bound or a configured 64 MiB BrowserKernel ceiling.
  The live namespace still scales with node count, as does traversal scratch
  with depth. Native cases cover direct/indirect directory blocks, resume,
  early exit, four typed source failures, reset/retry, depth 40, 240 long-name
  sibling directories, cross-directory hardlinks and export. The compatibility
  `read_dir` API remains collecting (with fallible reserves), including its
  image-publication policy consumer; that path still needs budget review.

  Artifact job `persistent-directory-artifacts-1018-073642-35b6` passes 3,118
  Rust workspace checks excluding xtask and rebuilds through normal bootstrap.
  Final job `persistent-directory-release-1018-080615-9b41` succeeds after
  36m37s: 622 Node checks in 26 files with all three large fixtures enabled,
  63 browser cases with no skips or flaky outcomes, 64 selected strict-reboot
  Sortix cases, ABI 51 consistency, and all thirteen before/after artifact
  hashes pass. Browser coverage retains all nine shell/WordPress SQLite and
  MariaDB recovery workflows and all six orphan-compaction cases. An earlier
  broad attempt had one missing direct-build kernel artifact and never reached
  browser acceptance; normal Cargo provisioning and a complete rerun resolve
  that failure without changing or skipping the test. Evidence:
  `.context/persistent-directory-native-workspace.log`,
  `.context/persistent-directory-{node,browser,sortix,abi}-final.log`,
  `.context/persistent-directory-browser-final.json`, and
  `.context/persistent-directory-artifact-{sha256.txt,verify.log}`. The browser
  JSON contains three `many-file-directory-memory` attachments; matched old
  evidence is in `.context/persistent-directory-{node,browser}-before.log`
  and `.context/persistent-directory-browser-before.json`. The failed broad
  Node attempt is retained in
  `.context/persistent-directory-node-missing-direct-kernel.log`.
  No image-format or binary-interface change is introduced. Aggregate namespace,
  metadata-carrier, recovery and snapshot budgets, whole-process peaks, full
  fault acceptance and workload performance remain incomplete.
- [x] Remove post-load FIFO namespace queues and make reset ownership explicit.
  The image-record walk above was not the final namespace traversal: FIFO
  restoration and reset still queued paths for every node, even for images
  without named pipes. Restoration now skips FIFO-free trees; otherwise a
  Rust cursor borrows directory iterators and keeps only its current path and
  ancestor frames. Only names actually registered as FIFOs are copied.
  Path/stack reservations are fallible, invalid children or directory cycles
  fail, and a visitor error stops immediately. This removes sibling-width
  staging but does not bound live namespace size or traversal depth.

  Reset now filters the existing FIFO registry by its backing pipe's rootfs
  device identity rather than discovering names through the current tree.
  Two regressions first fail on the old implementation: unreachable rootfs
  aliases and their name references survive reset, while a foreign-mount FIFO
  shadowing a rootfs name is incorrectly removed. The corrected path removes
  all rootfs registrations, preserves foreign registrations, retains open
  endpoints and their bytes, and reclaims closed pipes without confusing a
  subsequently reused foreign slot. Restored aliases also refresh cached pipe
  metadata from the authoritative inode instead of double-counting links.
  Pipe-table free-list and ancillary cleanup retain their own allocations;
  this is not an allocation-free emergency-reset guarantee.

  Five native regressions cover those ownership cases, restored hardlinks and
  metadata, a rejected cycle followed by reset, and four typed visitor errors.
  A 1,067-entry tree with 512 long-name sibling directories and depth 40 uses
  at most 16 KiB of modeled cursor capacities, not a namespace-sized path
  queue. This is cursor scratch evidence, not allocator/RSS or whole-system
  memory acceptance. Registry metadata and aggregate resource admission remain
  open; the later named-FIFO data-buffer milestone bounds that separate data
  resource without claiming a whole-system memory limit.

  Artifact job `persistent-fifo-artifacts-1018-085614-1a6b` passes 3,123 Rust
  workspace checks excluding xtask and rebuilds through normal bootstrap and
  direct Cargo provisioning. Final job
  `persistent-fifo-release-1018-090621-9a66` succeeds after 38m23s: 627 Node
  checks in 29 files with all three large fixtures enabled, 66 OPFS/demo cases
  across Chromium/Firefox/WebKit, and three additional Chromium aggregate-gate
  FIFO/SCM-rights lifecycle cases pass. There are no skips or flaky browser
  outcomes. All nine real shell/WordPress SQLite/MariaDB recovery workflows
  and all six orphan-compaction cases remain covered. The strict-reboot Sortix
  selection passes 67 cases, including `mkfifo`, `mknod` and `pipe`; a separate
  matched run passes `mkfifoat`, `mknodat` and `pipe2` (70 total). ABI 51 and all
  sixteen before/after artifact hashes pass, including a second verification
  after the supplementary conformance run. Closure preflight reports 91 valid,
  zero incomplete/failed and eight unbuilt products; this is not full-product
  or full-conformance release acceptance.
  Evidence: `.context/persistent-fifo-native-workspace.log`,
  `.context/persistent-fifo-{node,browser,sortix,abi}-final.log`,
  `.context/persistent-fifo-browser-{final,lifecycle}.json`,
  `.context/persistent-fifo-browser-lifecycle.log`,
  `.context/persistent-fifo-sortix-at-pipe2-final.log`, and
  `.context/persistent-fifo-artifact-{sha256.txt,verify.log,post-sortix.log}`.
  Native red evidence is retained in
  `.context/persistent-fifo-cleanup-native-before.log` and
  `.context/persistent-fifo-walk-native-before.log`. No format or binary ABI
  change is introduced; Node and browser continue to share the Rust semantics.
  Global metadata admission before namespace/journal publication, whole-process
  peaks, remaining fault/lifecycle gates and workload performance stay open.
- [x] Reserve inode-arena and reclamation capacity before durable creation.
  Persistent regular-file, directory, symlink, FIFO and socket creation used
  to grow the inode vector after committing the journal. Final inode release
  could also grow its free-index vector after an unlink was already durable.
  Rust now fallibly reserves both vectors before publication, preserving
  logical inode `ENOSPC` checks before memory admission. Publication uses only
  prepared slots; rollback and final release can return every admitted slot
  without growing the reclamation vector. Replay reserves its entire created
  set before clearing FIFO registrations or changing base metadata/the tree.
  Initial root creation and ordinary loader/builder/RAM creation also propagate
  arena reservation failures as `ENOMEM` rather than infallible vector growth.
  Capacity is not a logical disk allocation: block/inode statistics continue
  to count actual occupied slots, not vector capacity.

  A native storage observer records both capacities at real journal writes:
  the old implementation fails on regular creation, and the corrected path
  passes all five creation kinds. Four more regressions inject failure at
  arena growth or reclamation reservation, verify unchanged names, metadata,
  logical counters and journal bytes, and exercise retry and slot reuse.
  They also cover typed initial-root failure, 64 open-unlinked final releases
  without free-list reallocation, and failed bulk replay preserving the base
  tree and FIFO registry before retry. These are native allocation-fault
  tests, not induced browser heap exhaustion. A failed reclamation reservation
  can retain an enlarged but unused arena; future admission must charge that
  actual retained capacity, not assume every failed preparation frees it.

  Artifact job `persistent-arena-artifacts-1018-100235-7c86` passes 3,128 Rust
  workspace checks excluding xtask and rebuilds normally. Final job
  `persistent-arena-release-1018-101222-f2f4` succeeds after 38m47s: 627 Node
  checks in 29 files with all three large fixtures enabled, 66 OPFS/demo cases
  across Chromium/Firefox/WebKit, three additional Chromium FIFO/SCM lifecycle
  cases, 70 selected strict-reboot Sortix cases, ABI 51 consistency and all
  sixteen before/after artifact hashes pass. There are no test skips or flaky
  browser outcomes in these selections. Coverage retains all nine real shell/
  WordPress SQLite/MariaDB recovery workflows and all six orphan-compaction
  cases. Closure preflight reports 91 valid products, zero incomplete/failed
  and eight unbuilt products, not full-product release acceptance. Evidence:
  `.context/persistent-arena-reservation-native-{before,focused,faults}.log`,
  `.context/persistent-arena-native-workspace.log`,
  `.context/persistent-arena-{node,browser,sortix,abi}-final.log`,
  `.context/persistent-arena-browser-{final,lifecycle}.json`, and
  `.context/persistent-arena-artifact-{sha256.txt,verify.log}`.
  The host/kernel binary interface and on-disk format remain unchanged.
  This is real vector reservation, not a global metadata quota or a proof
  that every namespace allocation is fallible/prepared. Directory B-tree
  nodes, names, transaction encoding, variable metadata and recovery/snapshot
  scratch still need their admission and publication guarantees, alongside
  whole-process peaks and the remaining production acceptance gates.
- [x] Complete shared, profile-aware metadata admission. Rust now accounts for
  retained inode/free-index capacities, directory-name ownership, conservative
  directory-node models, symlink targets, archive descriptors, deferred source
  paths/payloads/URIs, and image JSON. Names are owned before namespace journal
  commit; failed preparation or journal I/O releases their credits. Retained
  arena capacity stays charged even after partial reservation failure. Reset
  releases ownership but preserves the configured limit.

  Both hosts configure `rootfsMetadataBytes` before image loading. Its default
  and maximum are the smaller of 64 MiB and one eighth of the configured kernel
  address-space ceiling; callers may request a smaller positive byte budget.
  Temporary metadata work has a separate two-times-resident headroom limit,
  with checked combined arithmetic. SDEF decoding admits modeled records and
  fields incrementally before allocation, rather than reserving the declared
  section length. Legacy KLZY decoding has a conservative temporary charge;
  its input and image JSON reads use bounded windows. Image-module builders
  expose the same Rust ledger. Kernel scalar exports are added within ABI 51;
  no image-format change is needed. Resource exhaustion is `ENOMEM`, not
  logical-disk `ENOSPC` or corruption. Generation selection must propagate it
  without falling back to stale data or deleting the newest journal.

  This remains a modeled admission limit, not an allocator/RSS guarantee.
  Actual directory/journal B-tree node allocation is still infallible;
  journal structures, remaining recovery/snapshot/traversal scratch, FIFO resources,
  and complete recovery-peak admission need further coverage. The initial
  metadata-admission checkpoint passed 3,142 Rust workspace checks excluding
  xtask. Five focused Node files passed 269 cases with one opt-in large-fixture
  case not enabled. A real guest
  fills a 64 KiB metadata budget on a 512 MiB logical image under a 64 MiB
  kernel ceiling, observes `ENOMEM`, reclaims a name, and successfully recovers
  under the same budget. Reopening with 8 KiB refuses without changing journal
  bytes; restoring the budget recovers the files. A fresh quiescent kernel
  exports a checkpoint which boots and verifies without its journal. The same
  workflow passes on Chromium, Firefox and WebKit using persistent profiles.
  This is a constrained metadata-admission test, not a whole-process peak
  measurement or proof of an arbitrary namespace fitting a small budget.

  Namespace replay now prepares changed names, planned inode indices, final
  link counts and iterative graph validation before publishing created inodes
  or clearing FIFO registrations. Its vectors and owned key copies use
  fallible temporary admission, replacing the prior unadmitted nested graph
  maps. Unchanged keys are skipped; value-only changes retain existing keys.
  New-name credits exchange atomically with credits for removed base names
  before publication, rather than requiring both sets to fit the resident
  limit. Rejected admission restores removed-name credits and leaves the tree
  unchanged. Native and real-guest regressions first reproduced same-budget
  rename recovery returning `ENOMEM`. The guest now renames 32 base files
  under a 64 KiB metadata limit, strictly reopens its journal and verifies a
  journal-free checkpoint on Node, Chromium, Firefox and WebKit. Plain and
  indexed native recovery, unchanged-key replay, rejected credit exchange,
  scratch denial, rollback/retry and reused/appended inode planning are covered.
  Namespace-admission acceptance passed 3,155 Rust workspace checks excluding
  xtask, 321 Node checks in nine files, 27 OPFS cases across all three browser
  engines, three additional Chromium FIFO/SCM lifecycle cases and 70 selected
  strict-reboot Sortix cases. There are no skips, failures or flaky browser
  outcomes in these selections. ABI 51 remains unchanged in this step; all
  thirteen artifact hashes and six source hashes remain stable through
  acceptance. Evidence: `.context/persistent-replay-admission-native-workspace.log`,
  `-node-{before,final}.log`, `-browser-{final,lifecycle}.json`,
  `-sortix-final.log` and `-artifact-verify.log` under the same prefix.
  This is not full product/conformance acceptance: the union of base and
  created inodes/variable fields, actual B-tree allocation and the other
  aggregate-memory gates remain open. Current real shell/WordPress artifacts
  still require the normal dependency rebuild before final demo acceptance.

  Recovery now reconstructs only namespace-referenced created inodes instead
  of retaining all deleted inode objects until the final unlink pass. A
  bounded, fallibly admitted cursor supports index/tail enumeration with
  intervening inode lookups. Unused descriptors and orphan file-data owners
  remain validated, including unknown-directory tombstones and nonregular
  data records; skipped descriptors still advance the inode-number watermark.
  Base indices, scalar-update vectors, references, created descriptors, size
  eligibility and allocation totals have temporary admission. The base-plus-
  live inode/field peak, actual B-tree allocations and retained journal/base-
  dirent structures remain open. Native regressions exercise 64 mixed
  create/unlink cycles, including nested directories and orphan file data,
  under the same metadata quota across plain and indexed recovery. Invalid
  unused descriptors and nonregular data owners still fail without changing
  the tree or valid journal. The real C guest performs 128 mixed cycles and
  retains eight files, then verifies all bytes through strict journal recovery
  and a journal-free checkpoint on Node and all three browser engines.

  The broader acceptance run exposed a reproducible Firefox shutdown deadline
  failure during open-unlinked compaction. A queued worker probe took about
  1.36 seconds to reply, leaving less than 0.65 seconds of the old two-second
  deadline for compaction retirement and teardown. Persistent Node and browser
  hosts now share a 30-second graceful deadline; ordinary nonpersistent
  deadlines are unchanged. Delayed valid acknowledgements are covered on both
  hosts, and timeout still retains unconfirmed browser leases and refuses
  handoff. No sync error is converted to success. The original Firefox case
  failed three of five unmodified repeats before the correction; all five
  repeats pass afterward with no timing probe or weakened assertion.

  Final scoped acceptance `persistent-orphan-recovery-release-fixed-1018-153159-9781`
  succeeds after 20m26s: 381 Node checks in eleven complete files, 30 OPFS cases
  across Chromium/Firefox/WebKit, three additional Chromium FIFO/SCM lifecycle
  cases, 70 selected strict-reboot Sortix cases, ABI 51 and all thirteen
  before/after artifact hashes pass. The twelve implementation/test source
  hashes are unchanged through acceptance. Current Rust passes 3,158 workspace
  checks excluding xtask, plus the Wasm cross-check. These selections have no
  failures, skipped cases or flaky browser outcomes. A separate opt-in run
  passes both dense and near-dense >32 GiB positioned boot/recovery cases under
  a 64 MiB kernel ceiling; the other six statistics tests are intentionally
  filtered, including the stale shell-image case. Each paired-boot case takes
  about 296 seconds and reports kernel pages `[238, 182]`, not whole-process
  RSS or a workload performance improvement. Evidence:
  `.context/persistent-orphan-recovery-{native-workspace,node-final,node-large}.log`,
  `-browser-{final,lifecycle,firefox-fixed}.json`, `-sortix-final.log`,
  `-abi-final.log` and `-artifact-verify.log` under the same prefix. The initial
  failure is retained in `persistent-orphan-recovery-before-shutdown-fix/`
  under `.context/`. This does not close the aggregate-memory, full conformance,
  current real-demo, performance or remaining production acceptance gates.

  The actual Node boot test also exposed an error-reporting defect: throwing
  an expected negative image-load status inside a void kernel ingress hid the
  errno behind a fatal-instance diagnostic. Expected load/budget failures now
  leave that ingress as values and reject initialization after it releases
  ownership; unexpected export exceptions still take the fatal path. The
  resource test verifies both the real diagnostic and absence of a fatal
  notification. Evidence: `.context/persistent-metadata-ledger-native-workspace.log`,
  `.context/persistent-metadata-ledger-node-focused.log`, and
  `.context/persistent-metadata-ledger-browser-profile.{log,json}`.

  Broader release validation is not complete. Its first attempt correctly
  refused stale ABI-contract digests embedded in previously built large-image
  fixtures and the shell image. Refresh those through normal generation/build
  paths; do not restamp an old guest or relax execution checks. Required shell,
  WordPress and MariaDB demo image closures also need rebuilding. A full-tree
  provisioning run was stopped before disk exhaustion; the kernel, image
  modules, host and new guest fixture have since been built normally, but that
  is not acceptance of the remaining product images or conformance gates.

  Subsequent matching validation passes all 70 selected strict-reboot Sortix
  cases with no skips, the ABI 51 snapshot check, and ten unchanged artifact
  hashes. All three large fixtures were legitimately regenerated with the
  newly compiled guest, retaining their sparse physical-storage guard. A
  further three-file Node run passes 88 cases with no skips, including dense
  and near-dense files larger than 32 GiB under a 64 MiB kernel ceiling,
  >4 GiB file-backed boot/export/recovery, and near-dense snapshot planning.
  That run still fails its shell-image-based `statfs` case on the stale guest
  ABI-contract digest; the suite is not green. The two >32 GiB cases take
  approximately 301 and 296 seconds respectively, including their paired
  boots; this is not a throughput or fast-recovery claim. Evidence:
  `.context/persistent-metadata-ledger-large-refresh.log`,
  `.context/persistent-metadata-ledger-sortix-final.log`,
  `.context/persistent-metadata-ledger-abi-final.log`, and
  `.context/persistent-metadata-ledger-artifact-post-refresh.log`.

  Read-only admission inspection of the existing product images uses about
  20.7 MB of modeled metadata for shell (13,890 entries), 34.2 MB for WordPress
  (20,118), and 34.3 MB for MariaDB WordPress (20,213). They fit the default
  64 MiB metadata limit. This uses stale product images only to inspect their
  namespace, not to claim current-ABI guest execution or RSS measurements;
  the actual demo rebuild/recovery acceptance remains required. Evidence:
  `.context/persistent-metadata-ledger-product-admission.log`.
- [x] Make named-FIFO data buffers lazy and bounded, with matched acceptance.
  Creating or replaying a FIFO used to allocate 64 KiB immediately, so 1,024
  unopened names alone required at least 64 MiB of kernel buffer memory.
  Names and path-only references now require no data buffer. Rust prepares a
  ring fallibly at I/O open, before endpoint/rendezvous publication, and
  originally bounded its allocated `Vec` capacities by a separate 16 MiB
  per-kernel quota. The current integrated memory candidate instead charges
  twice actual capacity inside ordinary shared I/O admission; its new combined
  Node/browser acceptance is pending. A failed preparation returns `ENOMEM` and releases any
  reserved fd without creating a false peer. `ENXIO`, permission, signal and
  descriptor-limit checks retain their existing ordering. Inherited and
  in-flight descriptors share the same allocation; last I/O close frees it
  even while names or `O_PATH` references retain the inode. Reopening starts
  empty. The historical acceptance below predates shared admission of normal
  pipes/sockets and FIFO registry/arena metadata. Allocator/RSS and aggregate
  memory acceptance remain separate requirements.

  A native regression fails with 65,536 resident buffer bytes before the fix
  and zero afterward. Five new native cases cover quota and allocation-fault
  rollback, real open-path fd/endpoint cleanup, `O_PATH`/`ENXIO` priority,
  inherited/in-flight lifetimes and volatile-data disposal. All 3,147 Rust
  workspace checks excluding xtask pass. A real guest creates 1,024 FIFOs on
  a 512 MiB logical image under a 64 MiB kernel ceiling, opens distinct FIFO
  buffers until `ENOMEM`, frees one while an `O_PATH` fd retains its inode,
  successfully opens another, and checks that buffer I/O does not change
  free filesystem blocks/inodes. Strict reboot and base-only checkpoint boot
  then verify every marker and perform I/O through all 1,024 names. This flow
  passes on Node and Chromium/Firefox/WebKit persistent profiles.
  ABI 51, imports/exports, host logic and image formats are unchanged here;
  kernel/modules and the actual C guest were rebuilt through normal tooling.
  Evidence: `.context/persistent-fifo-admission-native-{before,workspace}.log`,
  `.context/persistent-fifo-admission-node-quota-retry.log`, and
  `.context/persistent-fifo-admission-browser-quota.{log,json}`.

  Artifact job `persistent-fifo-admission-artifacts-1018-133822-9167` completes
  normal scoped provisioning in 2m10s. Matching job
  `persistent-fifo-admission-release-1018-134748-58e4` succeeds in 10m48s:
  320 Node checks across nine files, 24 OPFS cases across all three engines,
  three additional Chromium FIFO/SCM lifecycle cases, 70 selected strict-reboot
  Sortix cases, ABI consistency and thirteen unchanged artifact hashes pass.
  None skip or fail, and the selected browser cases have no flaky outcomes.
  Coverage retains the existing metadata-quota denial/retry, sparse namespace,
  timestamp writeback, 8,192-distinct-block compaction and open-unlinked cases.
  The 1,024-FIFO Node workflow takes about 6.5 seconds including its recovery
  and checkpoint boots; this is not a throughput or cross-revision speedup
  claim. Evidence: `.context/persistent-fifo-admission-{node,browser,sortix,abi}-final.log`,
  `.context/persistent-fifo-admission-browser-{final,lifecycle}.json`,
  `.context/persistent-fifo-admission-browser-lifecycle.log`, and
  `.context/persistent-fifo-admission-artifact-{sha256.txt,verify.log}`.
  This closes only the named-FIFO data allocation/ownership boundary, not
  registry/pipe-table admission, other buffers, whole-system memory bounds,
  the outstanding current-ABI shell/WordPress product rebuilds, full
  conformance or any of the remaining production acceptance gates.
- [x] Connect positioned base allocation queries to mutation admission. The
  Rust journal can merge a one-pass base cursor with indexed, metadata-tail,
  and dirty allocations and zero/truncate fences without an intermediate base
  list. The walk checks ascending source blocks and preserves typed source
  errors; an early successful lookup does not request another base block.
  Sparse write reservations and partial-tail truncate checks now query the
  image's pointer metadata. Dense checks remain arithmetic. Lazy cursor
  creation prevents reads when journal fences completely hide the base.
  Three new journal units cover a generated multi-terabyte logical sparse
  base without a source list, indexed/tail/dirty precedence, errors, ordering,
  early exit, EOF, and fenced/created files. A new rootfs test writes and
  truncates a 9 GiB sparse base while injecting `EAGAIN`, `ENOMEM`, `EIO`, and
  `ENOSPC` source errors: failure preserves file size, timestamps, free space,
  bytes, and the journal. Valid writes/truncation and strict recovery succeed;
  truncate-to-zero and later full-block writes need no now-hidden base bytes.
  The focused native run passes 11 checks, including these four new cases, in
  `.context/persistent-positioned-allocation-native-final.log`. The rebuilt
  workspace passes 3,089 Rust checks excluding xtask. Matched artifact job
  `persistent-positioned-allocation-artifac-1018-012746-9555` completes normal
  bootstrap, and release job
  `persistent-positioned-allocation-release-1018-013647-cea9` passes all 535
  selected Node checks with the large dense fixture explicitly enabled, all
  48 selected browser cases on Chromium/Firefox/WebKit, all 64 selected
  persistent-reboot Sortix cases, and ABI consistency. No cases skip or fail;
  browser results have no flaky outcomes. The nine real shell/WordPress
  SQLite/MariaDB workflows are included. The 32 GiB case still uses 238/182
  kernel pages, archive cases 246/178, and capacity cases 277/221/37/221;
  these are phase measurements, not aggregate peaks or performance acceptance.
  Evidence: `.context/persistent-positioned-allocation-native-workspace.log`,
  `.context/persistent-positioned-allocation-{node,browser,sortix,abi}-final.log`,
  `.context/persistent-positioned-allocation-browser-final.json`,
  `.context/persistent-positioned-allocation-kernel-memory.json`,
  `.context/persistent-positioned-allocation-artifact-sha256.txt`, and
  `.context/persistent-positioned-allocation-artifact-verify.log`.
  A final focused native rerun strengthens timestamp assertions to cover both
  seconds and nanoseconds; no production behavior changed after acceptance.
  This is still ABI 51, not a new host storage policy or format, and it is
  focused regression evidence rather than whole-goal release acceptance.
  Cold statistics, namespace reclamation, and
  checkpoint planning still use retained lists; this step does not complete
  their ledger/source-plumbing work above.
- [x] Remove resident allocation bitmap prefixes from the Rust image writer.
  The append-only writer's physical blocks and inode IDs form contiguous
  allocated prefixes. It derives their ends from existing total/free counters
  and synthesizes positioned bitmap slices rather than retaining growing
  buffers. Failed creation retains its earlier allocations just as before;
  this is not a new reclaiming allocator or an on-disk format change.
  Five new native cases cover little-endian partial-byte/page boundaries,
  maximum u32 bit addressing, generation/growth/exhaustion, failed creation,
  and a 32 GiB modeled allocator working set with less than 64 KiB of counted
  image metadata. The latter fails with the previous bitmap-buffer writer.
  A maximum-capacity formatter case reads the actual bitmap regions of a
  16 TiB-minus-one-block possible-capacity image while retaining less than
  16 KiB of counted metadata. It does not allocate a 16 TiB image or populate
  that many data blocks. All 46 focused writer checks pass, including existing
  TypeScript byte-for-byte fixture comparisons. Regenerating the real 32 GiB
  dense fixture produces a byte-identical container to the earlier writer;
  the temporary comparison output is removed afterward. Evidence is in
  `.context/persistent-bitmap-prefix-native-before.log`,
  `.context/persistent-bitmap-prefix-native-first.log`, and
  `.context/persistent-bitmap-prefix-fixture-identity.log`.
  Artifact job `persistent-bitmap-prefix-artifacts-1018-021537-8e84` passes
  all 3,094 workspace Rust checks excluding xtask and completes normal kernel/
  image-module bootstrap. Release job
  `persistent-bitmap-prefix-release-1018-022509-5a3e` passes all 616 Node checks
  in 26 files without skips, including both explicitly enabled large fixtures:
  32 GiB guest write/sync/strict recovery under a 64 MiB kernel ceiling and
  >4 GiB dense snapshot export, source-free reboot, and corruption rejection
  beyond 4 GiB. The latter's existing sampled RSS-growth assertions pass;
  they do not measure whole-run aggregate peaks. This expands the preceding
  23-file inventory with image bridge, module-byte, and Node export coverage.
  All 48 selected browser cases pass on Chromium/Firefox/WebKit without skips
  or flaky outcomes, including the nine real shell and WordPress SQLite/
  MariaDB workflows. All 64 selected persistent-reboot Sortix cases and ABI
  consistency pass. Kernel phase pages remain 238/182 for the dense fixture,
  246/178 for archives, and 277/221/37/221 for capacity checks; these are not
  whole-process peaks or workload performance acceptance.
  Evidence: `.context/persistent-bitmap-prefix-native-workspace.log`,
  `.context/persistent-bitmap-prefix-{node,browser,sortix,abi}-final.log`,
  `.context/persistent-bitmap-prefix-browser-final.json`, and
  `.context/persistent-bitmap-prefix-kernel-memory.json`.
  `.context/persistent-bitmap-prefix-artifact-sha256.txt` and
  `.context/persistent-bitmap-prefix-artifact-verify.log` verify unchanged
  kernel/demo-image/host artifacts across acceptance. Image-module hashes
  captured after acceptance are separately recorded in
  `.context/persistent-bitmap-prefix-image-module-sha256.txt`; they are not a
  before/after hash gate. The >4 GiB fixture was generated through the default
  Rust example path; its log is
  `.context/persistent-bitmap-prefix-export-fixture.log`.
  This stays ABI 51 and is focused regression acceptance, not whole-goal
  completion. Inode-table pages, directory records, indirect-pointer
  pages, extents, retained sparse maps, and export scratch remain required
  metadata-memory work; these unit bounds are not whole-process peak claims.

Generate and run the separate dense-boot regression through the normal Rust
writer and guest program paths:

```bash
scripts/dev-shell.sh bash -lc 'host_target=$(rustc -vV | awk "/^host:/ {print \$2}"); KANDELO_DENSE_FILE_BYTES=34359742464 cargo run -p runtime-core --example large_vfsi_fixture --target "$host_target" -- "$PWD/.context/dense-allocation32g.vfs" local-binaries/test-fixtures/wasm32/persistence-overwrite.wasm'
scripts/dev-shell.sh bash -lc 'cd host && KANDELO_DENSE_VFSI_FIXTURE="$PWD/../.context/dense-allocation32g.vfs" npx vitest run test/persistent-statfs.test.ts -t "dense file larger" --maxWorkers=1'
```

The optional size uses an explicitly declared 128-inode table through
`mkfs_with_inode_capacity`; the fixture's existing default layout is unchanged.
The generator stages output atomically with a 1 MiB read buffer and skips
zero-byte host writes, while every guest data block remains allocated in KIFS.
On macOS it may punch only previously verified, aligned zero ranges if APFS
physically allocates sparse gaps. The fixture's publication check refuses more
than 512 MiB of physical storage; the accepted file occupies 68,300,800 bytes.
This host-fixture sparsity is not guest sparse-file behavior. Do not pass this
32 GiB fixture to the browser's older `KANDELO_LARGE_VFSI_FIXTURE` installer
without enough actual OPFS quota and disk space for its full copied output.
The large Node case is intentionally opt-in; default skips are not evidence
that it ran.

## Deferred transport memory work

### Streaming image-integrity and manifest ownership candidate

The current source replaces image-length-dependent SHA-256 arrays on normal
source staging, positioned export, install and checkpoint paths with one
streaming whole-image digest. Legacy chunk descriptors remain readable;
mixed descriptors refuse. Node and browser staging/boot retain bounded
scratch and verify actual stored bytes before returning/publishing a verified
image. The explicitly resident byte-array compatibility API still emits its
legacy format; it is not used by the large-image path.

New browser manifests use version 5, not an undocumented change to version 4.
Before publishing a version 5 checkpoint over a version 4 computer, the
verified fallback manifest is migrated to version 5 too, preserving its
base/journal files. Otherwise an old host could reject the new primary yet
silently accept its older supported fallback. New readers refuse recognized
unsupported future versions rather than using corruption fallback. Neither
the native image/journal/index formats nor ABI 51 changes in this batch.

Manifest input is bounded before text/JSON allocation. A per-realm 64 MiB
modeled ledger retains parse and stringify overlap through each locked
operation; individual inputs are at most 8 MiB and can refuse earlier when
the aggregate charge does not fit. Refusal preserves `ENOMEM`, including
when reading a previous manifest, rather than silently skipping the failed
read or selecting a fallback. Encoding checks escaped UTF-8 size, cycles,
depth, accessors and conversion hooks before stringify. Legacy chunk-table
checksums stream canonical JSON spelling. Handles return a constant-sized
integrity descriptor rather than retaining the legacy table. The architecture
reference documents limits and caller-owned bounded composition metadata;
this admission model is not a measured process-memory guarantee.

The initial three-file selection passes 43 tests and the host JavaScript/
declaration build passes. Coverage includes whole-image corruption before
reader publication, sparse-hole readback, constant-sized output for a 129 MiB
stream, partial tails, legacy descriptors and mixed-descriptor refusal;
manifest credit refusal/retry, parse overlap, encoded-output admission,
Unicode escaping and side-effectful/cyclic/deep inputs are covered separately
in the same selected files. Combined actual Node and new all-engine OPFS
upgrade/admission job `persistent-v5-candidate-1021-050334-83c4` passes 204
enabled Node tests in six files, with two unprovisioned physical >32 GiB
opt-in skips, and all 12 selected browser cases. The broader two-file run
`persistent-v5-browser-1021-051024-1730` has 77 passes, three opt-in >1 GiB
source-stage skips, and one WebKit PCM retirement failure in the constrained
large-image case (`context=interrupted; sink=interrupted`). The browser run
also covers actual fixed/resizable page checkpoints, abrupt publication cuts,
legacy streamed formats, corruption and source-free recovery paths. Its
passing older-state fallback assertions do not prove acknowledged-state
freshness. Source/kernel receipts match afterward. The host build passes;
the complete app typecheck still fails on other existing paths, but the
changed image-integrity/manifest sources have no reported errors. A preexisting
nullable source-lease call now uses the existing shared release helper, fixing
that checkpoint type error without changing its release order.

Older checkpoint 1.15 and its accepted receipts remain untouched. No new
version 5 demo or full release acceptance is claimed yet; all six production
gates remain open. Source freezes for these runs ended before adding the
freshness regression below; preserved receipts are not rewritten.

#### Cross-base recovery freshness followup

The user-authorized independent read-only review identified a concrete gap:
`.previous.base.json` retains the source image and its old journal, while the
published computer writes to a different image/journal pair. Envelope
integrity and journal-header binding do not prove that the retained pair
contains writes acknowledged later by the active pair. Generation freshness
inside one journal namespace does not establish freshness across this handoff.

The normal new browser regression
`primary manifest damage must not roll back fsynced post-checkpoint guest writes`
uses the ABI-matched `persistence-overwrite` guest after successful checkpoint
publication. The guest completes `pwrite`, `fsync` and `close` with exit zero;
a fresh strict kernel reopen reads `XYcdefgh`. After changing only the active
manifest to invalid JSON, production selection and promotion choose the old
pair and a fresh kernel reads `abcdefgh`. The failure is reproduced on
Chromium in
`persistent-v5-fallback-freshness-before-1021-052220-9e0a`, with unchanged
source/kernel/guest receipts. The attached result is
`{"exitCode":0,"acknowledged":"XYcdefgh","restored":"abcdefgh","selectedOldPair":true}`.
This is confirmed rollback of selected guest-visible state, not evidence that
the new pair's backing bytes were physically deleted or that Rust `fsync`
failed. The reviewer made no edits and has been closed.

This is active recovery work, not deferred general hardening. Recovery must
return the acknowledged state or make a truthful freshness refusal. Do not
weaken the regression to accept the old state, rely on manifest hashes as
freshness proof, or add another passing old-state fallback test. The current
candidate preserves active generation bindings redundantly before writable
use, separately from the archived previous checkpoint. Cover
publication cuts and legacy-host writers during the upgrade, manifest damage,
base damage and typed journal-generation failure after post-checkpoint writes.
If the latest pair is damaged and no fresh verified copy exists, fail closed
rather than automatically promoting an older intact filesystem. Record the
required fault-model/replication limits and extend Node/browser acceptance.

The implemented, still-unreleased state machine separates a prepared binding replica
from an acknowledged writable one. Writing a new replica before the primary
must not by itself make an uncommitted replacement authoritative; writing it
only after writable use begins leaves an unsafe recovery window. Preserve
the source binding in the prepared record, commit the primary, then durably
activate the matching replica before exposing the new writable computer.
Recovery must distinguish those states, verify their source/sequence bindings,
and repair matching active metadata before allowing further writes. A damaged
primary plus an active replica can recover the same latest image/journal; an
unacknowledged prepared replacement may still have a proven fresh source.
Two damaged active bindings cannot justify choosing an arbitrary archive.
During legacy migration, block version 4 writers before leaving a prepared
replica for a different target, or an old host could resume the source journal
and invalidate that prepared target's freshness. Include every extra metadata
publication in lost-acknowledgement, cancellation, cleanup and reclamation
tests. The pure selection model is shared host source; OPFS parsing, Web
Locks and publication remain browser coordinator responsibilities. Portable
policy consolidation and complete release acceptance remain open.

The original real-guest regression passes in
`persistent-v5-fallback-freshness-after-1021-055526-3a1b`. The expanded job
`persistent-active-binding-1021-060524-7518` passes 29 Node policy/ownership
tests and 27 of 33 browser cases. All 21 actual post-checkpoint recovery
cases pass: seven damage/stale-control scenarios on Chromium, Firefox and
WebKit preserve the acknowledged state or explicitly refuse when neither
current metadata nor current payload can prove recovery. Six legacy upgrade
cases fail before injection because the synthetic version 4 fixture retains
the version 5 journal-binding digest. That fixture now recomputes the actual
version 4 digest; the larger combined rerun is pending, not accepted yet.
The original red receipts remain preserved. Earlier checkpoint 1.15 is
unchanged and does not contain the new freshness protocol.

The controls replicate bindings, not guest data. They cannot reconstruct a
damaged active base/journal from an older archive, survive browser eviction,
or detect coordinated replay of both controls to the same older valid pair.
Two damaged controls require refusal. Version 1–3 manifests remain readable,
but writable checkpoint migration from those formats is not yet implemented.

The independent followup review found a second ownership boundary: retrying
an unpublished staged snapshot after releasing the source journal lease can
discard writes acknowledged by a later source owner. Metadata equality is
not journal freshness. The current candidate binds snapshot staging to the
exact source handoff lease and source content/generation, then authorizes the
exact target validation handoff lease. Publication checks these identities
and the staged target digest before any new control writes. Reacquiring the
same journal names with new lease objects cannot revive that attempt. A retry
of an already active exact target remains possible without those old leases;
a merely prepared target does not receive that exception. Source export must
remain guest-write-quiescent as well as excluding other journal owners.

`stageFixedPersistenceReplacement` and the explicitly named
`stageFixedPersistenceReplacementFromFile` are intentional replacement APIs,
not proof that arbitrary bytes contain the latest source snapshot. The normal
checkpoint path uses `stageFixedPersistenceSnapshotReplacement`, requires the
source handoff, and authorizes the target handoff before publication. This
distinction avoids an extra complete journal/index hashing pass and does not
invent an authoritative filesystem epoch from compaction sequence numbers.
The native code and ABI remain unchanged. New real-guest browser cases release
either handoff, perform a successfully synced write, reacquire the same name,
and require the stale attempt to refuse while retaining the source selection.
Their combined acceptance is pending.

The larger pre-capability batch
`persistent-active-binding-batch-1021-061107-6e35` builds the host and passes
214 Node tests, with two unprovisioned physical >32 GiB opt-in skips. Its
browser run records 45 passes, three failures, two skips, one interrupted case
and 66 not run. The six Chromium publication-crash boundaries and both
prepared/active page-recovery cases pass. The run is deliberately interrupted
to implement the independent ownership finding, not accepted as a passing
suite. Its other failures are a stale error-text assertion in the composer
fixture, a Chromium stale-binding timeout without phase diagnostics, and a
Firefox large-image browser-launch timeout. Phase diagnostics now distinguish
launch, export, validation, publication, acknowledged write and recovery; no
timeout was increased or failure waived. Source/runtime receipts match after
the interrupted run. Earlier static demos remain unchanged.

The corrected combined source candidate passes
`persistent-snapshot-ownership-verified-1021-065225-6510`: 94 Node tests and
all 69 selected Chromium/Firefox/WebKit browser cases, without retries or
skips. Coverage comprises 21 post-checkpoint damage/stale-control cases,
six actual synced-write/reacquired-lease refusals, 18 before/after prepared,
primary and active publication boundaries, nine version 5 admission/legacy
upgrade cases, six running-page checkpoints, six prepared-versus-active
invalid-journal page boots, and three complete composer/publication/repair
workflows. Chromium publication boundaries terminate the browser process;
Firefox/WebKit boundaries close the page and are not OS/process-crash proof.
Source, kernel and guest hashes remain unchanged throughout. The complete
application typecheck still has unrelated errors; changed persistence and
journal-lease sources have no reported errors. This is scoped source
acceptance, not the full release suite, whole-system memory acceptance or a
fix for previously unexplained timeout/audio-retirement failures. Normal
checkpoint 1.16 product/site rebuilding follows this candidate; no new static
demo has yet been accepted.

Checkpoint 1.16 is now built through the normal 144-node product graph
(`persistence-checkpoint-1-16-build-1021-065739-582e`, 6m55s) and served on
`http://127.0.0.1:57241/`. The source, artifact and immutable-site receipts
match; native Rust/libc/ABI inputs still match the accepted 1.14 baseline.
The actual WordPress + MariaDB link and manual instructions are recorded in
`.context/persistence-checkpoint-1-16-{urls.json,status.md}`. Existing preview
origins and browser data are untouched. Its 18 real shell, WordPress
SQLite/MariaDB, media-upload and mixed-workload browser cases are running in
`persistence-checkpoint-1-16-acceptance-1021-070443-a417`; HTTP availability
and the 69-case source cohort do not replace that product validation.

#### Next integrated storage-memory batch

The independent read-only owner review identifies these concrete remaining
storage-sized paths, not general signal/wake/terminal hardening:

1. Composer text patching (`image-composer.ts` `readVfsFile`) allocates the
   declared whole file, requests another file-sized Wasm bridge scratch read,
   copies the output and then decodes text. Image-controlled PHP/WordPress
   configuration can drive this from a small sparse source. Admit and bound
   supported patch-text inputs before allocating or reading, and bound bridge
   transfers. Validate a sparse oversized patch target refuses before either
   whole-file allocation while ordinary product composition still works.
2. Configured-asset staging (`configured-assets.ts`) consumes the complete
   HTTP response with `arrayBuffer()` before hashing or filesystem admission.
   Stream/admit this path or enforce explicit supported intake limits before
   buffering. Test a large chunked body without `Content-Length`, checksum
   failure/cancellation cleanup, and normal persistent configured assets.
3. A failed export sink stops the host traversal without releasing the admitted
   native `IMAGE_EXPORT_CACHE` plan. EOF, another export or kernel reset releases
   it; normal checkpoint teardown also destroys the source kernel. This is
   bounded retention, not unbounded accumulation. Add an explicit export-plan
   cancellation path, preserving kernel-entry ownership, and test that an
   injected file-write failure releases plan credit while the same kernel
   remains usable. Do not disguise cancellation as a fabricated EOF read.

V5 returned integrity/recovery descriptors are constant-count fields, composer
chunk acknowledgements already bound their transfer queue, and source windows,
OPFS caches and verification scratch have explicit bounds. These observations
do not establish aggregate process peaks or close whole-system acceptance.

The next integrated candidate now implements all three paths. Composer patch
inputs refuse unsafe or greater-than-1-MiB declared lengths before opening or
allocating their body, read at most 64 KiB per bridge transfer, and reject early
EOF instead of patching truncated text. Normal positioned image files remain
unlimited by that text-input bound. Configured assets stream through 64 KiB
native writes and incremental SHA-256 without `Response.arrayBuffer()`.
They have a 32 MiB aggregate payload limit per composition because these
new/modified builder files remain resident; admission precedes each native
write, and refusal is `ENOMEM`, not logical `ENOSPC` or corruption. This limit
is not a limit on files already in a positioned persistent image. Failed
hashes or intake abort the private composition before any product is returned
or published; partial builder content is not exposed as a running computer.
Readers cancel and release ownership on refusal, supersession and HTTP errors.

Rust now exports explicit container-plan cancellation. The shared kernel worker
invokes it inside the same entry when a sink or ordinary read fails, without
trying another Wasm call after a fatal native export. Old kernels without that
capability refuse before creating a plan. Builder iterators also cancel their
native plan on early return, and per-iterator ownership prevents an abandoned
old iterator from cancelling a newer export. New image-module chunk writes
reuse Rust's existing authoritative positioned-write semantics; no alternate
filesystem is implemented in the host. The zero-argument cancellation export
is additive under ABI 51 and is included in the ABI snapshot. New builder
exports require regenerated modules, not compatibility shims.

Native workspace validation passes 3,398 tests, including two new image-module
tests. The native positioned-module unit target passes 68 tests using `--lib`;
the earlier unrestricted native feature invocation attempts to link the
non-test positioned cdylib without its worker-provided `host_image_read` and
fails. That is preserved as a provisioning result, not a supported native
positioned-host build. The ABI snapshot check passes. Four bounded-text unit
cases pass, and the initial scratch selection passes 193 tests with one exact
scalar/control audit occurrence requiring review; its new cancellation call
is now recorded and the corrected combined rerun is pending. The normal
package/projection rebuild is running in
`persistent-composer-native-final-1021-075440-43cc` with two jobs. The source
cohort validates fresh ABI-checked native outputs while that broader product
graph rebuilds; it does not substitute for final prepared-product validation.

Checkpoint 1.16 application acceptance is terminal: 15 passes, two intentional
non-Chromium process-crash skips and one WebKit shell checkpoint failure in
22m50s. WordPress SQLite/MariaDB post/upload recovery, mixed MariaDB/guest-file
work and media-library uploads pass on all three engines. WebKit shell reboot
still refuses an unacknowledged PCM transport detach; context and sink report
running. Preserve that lifecycle failure, not a fake successful retirement.
Source/artifact/site receipts match. Sampled descendant RSS peaks at 5,782,160
KiB, not unique physical memory or an aggregate bound. The current new memory
candidate is not in the immutable checkpoint 1.16 site.

The corrected combined source cohort
`persistent-composer-cohort-1021-080021-8cdc` passes 269 Node tests with one
explicit opt-in near-dense 32 GiB snapshot case skipped, and all 18 real
Chromium/Firefox/WebKit intake cases without retries. Browser cases stream an
8 MiB chunked response without `Content-Length`, verify native readback/export,
and exercise empty bodies, bad digests, supersession, the 32 MiB intake
refusal and HTTP error cleanup. `arrayBuffer()` is replaced by a fixture trap
and never called; native writes stay within 64 KiB and response locks release.
Native kernel/image-module and source hashes remain stable throughout.
The app typecheck still reports existing Node-environment errors, not new
errors in the changed composer/intake/image-bridge sources.

An additional isolated worker probe uses the ABI-check-produced kernel and
fresh image module while the normal package graph is still rebuilding. It
creates a 1 MiB resident file so export must snapshot owned content, injects a
real `EBADF` by writing the first native export chunk to a read-only host
descriptor, and keeps that same kernel alive. Native I/O-plan credit returns
to its pre-export baseline, a subsequent guest-visible file write/read works,
and a successful 2,187,284-byte export also returns credit to baseline.
Focused source/runtime receipts are in
`.context/persistent-export-owned-credit-*`; this strengthens the earlier
base-only probe and does not replace the pending canonical prepared-product
run. The normal build is live, not blocked, and no new demo or complete
release acceptance is claimed for this candidate yet.

The subsequent committed-record admission regression appends a complete frame
with a correct checksum and commit marker but an invalid namespace. Manifest
and journal-header preflight still select the same image; the real Rust-backed
kernel then refuses it with `no-valid-overlay-generation`, and teardown leaves
the damaged journal byte-for-byte unchanged. This passes on Chromium, Firefox
and WebKit in `native-journal-admission-metadata-1021-085108-6ac0` without the
full shell product prerequisite. Its first run had missing required fixture
composition metadata; that failure is preserved separately. The twelve
prepared/active real-page corruption cases remain unaccepted: their latest
run skips because the rebuilding shell artifact disagrees with the old
aggregate projection receipt. Do not disable artifact verification to run them.

Five repeated checkpoint 1.16 WebKit shell runs reproduce the PCM retirement
failure with an unused guest stream, a reported running audio context and
`currentTime` still zero. A separate diagnostic that requests real suspension
immediately after the detach message also fails all five runs; suspension
ordering alone is not a demonstrated fix. The temporary intervention is
removed, and the production acknowledgement requirement and timeout remain
unchanged. A narrower fresh-context lifecycle test passes on Chromium and
WebKit but does not reproduce or waive the application failure. Receipts are
under `.context/persistence-native-recovery-pcm-stress-*`,
`.context/checkpoint-1-16-pcm-suspend-diagnostic-*` and
`.context/pcm-fresh-clock-before-*`.

The broader normal product rebuild encounters a native host-tool failure in
Perl, not an OPFS or guest-kernel error. The pinned perl-cross assumes glibc
`LC_ALL` formatting for its host miniperl; a native probe confirms Darwin's
slash-separated category order. Recipe revision 9 configures only that host
interpreter's format and honors `WASM_POSIX_BUILD_JOBS`. The focused normal
SourceOnly build succeeds in 7m20s in `perl-host-locale-normal-1021-084444-9ebb`,
including the interpreter and the 1,590-file standard-library archive. Its
recipe hashes match afterward. This does not prove guest locale behavior or
aggregate projection and demo acceptance. The original product build continues
useful unrelated nodes and is not restarted merely because Perl's earlier
revision failed.

#### Persistent boot metadata and sparse composer admission

A second focused read-only review finds a persistent path beyond the three
composer findings: restore and checkpoint validation call `readFileFromVfs`
for demo configuration, terminal-session metadata and every dinit service.
Their size checks happen after the shared host worker accumulates the whole
file. A guest-created sparse metadata file can therefore cause file-sized host
allocation before refusal. The candidate now uses the existing bounded range
API, requesting only each format's supported limit plus one detection byte:
256 KiB for demo configuration and 64 KiB each for session and service files.
Parsing, exact composition comparisons, missing-file refusal and dependency
closure validation remain unchanged. The service-file bound is exported from
the shared parser rather than duplicated by the browser coordinator. This
changes browser restore/checkpoint coordination, not Rust POSIX behavior or
the Node host's already available range API; ABI remains 51.

Native sparse-file fixtures now verify composer admission with actual
positioned Wasm reads, not only a mocked `stat`: exactly 1 MiB is accepted,
1 MiB plus one is rejected before opening, and a valid extended KIFS file
declaring 8 GiB is likewise rejected without body reads. The physical input
remains small; this is sparse logical-file admission, not a physical 8 GiB
image workload. On Chromium, Firefox and WebKit the fixture resides in real
OPFS, and composition runs in a disposable worker. Three additional cases
per engine boot real persistent kernels with an 8 GiB sparse configuration,
session or service file. They reject through bounded ranges under a 64 MiB
kernel ceiling; asserted native growth during validation is at most 2 MiB.
These checks do not measure aggregate host/native RSS or prove a global bound.

Combined evidence is `composer-sparse-metadata-verified-1021-092856-df37`:
308 Node tests pass with one unchanged opt-in near-dense 32 GiB fixture skip;
all 39 selected browser cases pass without retries or skips in 54 seconds.
The selection includes nine sparse composer cases, nine sparse boot-metadata
cases, all eighteen configured-asset intake cases and three committed-journal
admission cases. The real owned-export `EBADF` probe again releases all plan
credit and keeps its kernel usable. Source and runtime hashes match afterward.
The app typecheck still has unrelated Node-environment errors, with none
reported in these changed sources. Earlier failures are retained: the first
sparse fixture exceeded v1 file addressing, WebKit's nonpersistent test context
could not supply this OPFS fixture, and the initial boot-metadata fixture used
creation-time inode numbers rather than the export's canonical mapping.
Fixtures now use extended KIFS addressing, run-owned persistent browser
contexts and native lookup of the exported inode. Assertions were not weakened.

The review's second finding is in positioned image loading: `load_image_inner`
retains ordinary visited-inode and hardlink B-trees, an ancestor stack and path
buffers alongside admitted inodes and directory names. After the prior normal
package job finishes draining, the native candidate replaces both traversal
trees with one existing fallible prepared map. Each node uses the rootfs
metadata ledger's temporary class, not the journal allowance. Ancestor/path
vectors and hardlink path-component arrays admit capacity before allocation;
vector growth includes old/new allocation overlap. Duplicate visits do not
allocate, and successful loading releases these temporary owners. Directory
cycle checks and regular-file/symlink/FIFO/socket hardlink behavior remain.

Three new native cases verify pre-allocation growth refusal, duplicate-free
temporary inode admission and failure after the root was inserted. The last
case observes typed `ENOMEM`, a reset partial tree, complete scratch-credit
release and successful subsequent loading. All 3,401 workspace tests excluding
xtask pass in `native-image-walk-verified-1021-094526-c196`, including the
existing wide/deep/cross-directory-hardlink loader tests; the focused selection
passes seven cases. The first compile failure was a missing test-only constant
import, preserved in the earlier receipt. The positioned module's native unit
target passes 68 cases, and ABI 51 snapshot consistency passes. These do not
prove new native behavior on Node or browser by themselves.

The first normal checkpoint 1.17 build,
`persistence-checkpoint-1-17-build-1021-094748-5ab7`, completes all 144 normal
product nodes but fails its strict Node fixture preflight: default-rootfs
selection prefers an old standalone alias over the current registered image.
The Node resolver now tries the registered architecture-aware artifact first;
only a typed missing-artifact error allows standalone fallback. Policy and
I/O failures propagate instead of silently selecting another image. The
prepared-test helper shares the same request order. Four resolver unit cases
and the real current-rootfs/64-asset lazy-closure preflight pass in
`default-rootfs-selection-1021-100837-42b8`. Browser image URL selection and
guest POSIX behavior are unaffected; ABI remains 51.

The corrected normal rebuild,
`persistence-checkpoint-1-17-resolved-bui-1021-101008-a65f`, succeeds in 7m17s,
including the strict preflight and normal static browser site. Checkpoint
1.17 is served on port 57242 with newly built shell, WordPress and MariaDB
images. Source, native/product and site receipts match after building.
Combined prepared Node, actual application, source-browser and persistent
Sortix acceptance is running; build success is not application acceptance.
Neither checkpoint 1.16 nor its older application results validate this
new traversal change. The previous broad job is terminal after 1h45m: its
original Perl revision fails while independent work finishes; that result
is not relabeled as success because the corrected revision passes separately.

Combined acceptance first exposes stale ABI-stamped developer test guests,
not stale normal shell/WordPress products. The normal Vitest fixture owner
now rebuilds all four persistence guests from their source, SDK, installed
sysroot and ABI snapshot through its existing freshness contract. It never
restamps an old guest to make it appear current. A separate preflight verifies
all four resulting digests against the new kernel before rerunning the cohort.
Large opt-in VFS fixtures embed guests too; new run-owned 4 GiB and 32 GiB
fixtures are being regenerated rather than reusing their older embedded code.
The interrupted stale-fixture run and the private runner's import error are
retained as failures, not counted as accepted tests.

Checkpoint 1.17 combined evidence now includes 730 passing prepared Node
checks across 29 files; four stale-fixture failures remain recorded in that
original run. Freshly rebuilt guests and separately regenerated, run-owned
large images pass all four corrective cases in
`checkpoint-1-17-large-fresh-1021-104908-c2e9`: dense and near-dense files
larger than 32 GiB both survive writes and strict recovery under a 64 MiB
kernel ceiling, a physical greater-than-4-GiB image survives export/reboot,
and the private file mapping example passes. The correction runs only those
four cases; its nineteen pattern-filtered cases are not platform skips.
Both 32 GiB cases report 230/182 kernel pages after their initial/recovered
phases. These are phase observations, not peak-memory measurements. Each
two-boot 32 GiB case takes about 321 seconds in this concurrent run; the
4 GiB export case takes about 113 seconds. This is correctness evidence,
not an accepted performance result or a matched comparison with main.

All 51 selected source-browser cases pass on Chromium, Firefox and WebKit
without retries or skips, including the twelve prepared/active replacement
journal corruption cases, bounded composer/boot inputs and native semantic
journal admission. The actual static application cohort passes fifteen
cases, skips the two explicitly unsupported non-Chromium browser-process
crash cases, and fails one WebKit mixed WordPress workload. Simple shell,
WordPress SQLite/MariaDB post/upload checkpoint recovery and MariaDB's
media-library upload flow pass on all three engines. The earlier WebKit shell
audio-retirement failure does not reproduce in this cohort; that is not proof
of a diagnosed audio fix.

The WebKit workload reaches source-blocked post-checkpoint verification and
prints the 512-name verification marker, then times out before its metadata
marker. Failure artifacts retain the checkpoint base and old source journal;
the capture helper does not retain the differently named current journal.
Independent native inspection of the captured checkpoint base verifies both
aliases' contents, inode 414, link count two and mode 0640. Actual Bash `cat`,
`cmp` and `stat` checks against that same base also pass on Node. This narrows
the failure but does not prove the current browser journal healthy or explain
the WebKit terminal timeout. It remains a release-validation failure.

Run-owned browser storage cleanup removes 60 app-run staging files totaling
2,796,818,432 allocated bytes and the isolated WebKit home; the source-browser
cohort removes another 68 staging files and its own home. Process-tree
diagnostics record sampled summed RSS peaks of 5,747,696 KiB for the app cohort
and 845,808 KiB for the corrective Node cohort, with no failed samples. Shared
mappings can be counted repeatedly, and out-of-tree helpers, existing previews
and user browsers are excluded. Neither observation is unique physical memory
or closure of the whole-system memory gate. All 64 selected persistent-reboot
Sortix cases pass, without skips or timeouts; final source, artifact and site
hashes match. The original combined job retains its failed status because of
the four original fixture failures and the unresolved WebKit workload failure.
The separate corrective four-case result does not rewrite that receipt.

#### Remaining same-namespace freshness boundary

The independent read-only policy review identifies an additional corruption
case distinct from cross-base image selection. After first compaction, the
legacy journal can remain intact while generation one accepts newer flushed
writes. If generation one's seal is damaged, generation discovery skips it
and can reopen the legacy source. Neither version 5 image binding changes.
A narrow host-selection probe reproduces this using real flushed Node files:
the current 99-byte journal is skipped in favor of its 72-byte source after
seal-header damage. This probe does not validate real journal records or prove
a guest `fsync` workload; those integration cases still need adding.

Do not repair this by treating any lower valid generation as fresh, or by
equating a complete seal with activation. A partially written, unpublished
compaction target can coexist with a still-fresh source after a legitimate
crash. Selection needs either a proof that the source remains authoritative
or durable activation evidence; absent that proof it must refuse before
writable exposure. Retain the crash-cut availability tests while adding
post-activation corruption cases. Earlier proposals also required writable
version 1–3 image migration; the user has now explicitly removed that requirement.
Canonical-format recovery safety remains a production gate, not a general
system-hardening followup.

The next recovery batch now has a shared-host activation-control foundation
in `host/src/vfs/overlay-generation-activation.ts` and the source-only CI
inventory. Its fixed 128-byte records bind publication sequence, base,
generation, slot and immutable seal identity with SHA-256. Paired controls
select the newest valid record, reject conflicting records at one sequence,
repair identical state, and require an exact next-generation transition on
the same base. Both write/truncate/flush operations complete synchronously;
any partial publication makes that owner unusable until independent reopening.
Tests cover every control-operation boundary before/after under flush-only
and write-through storage, single-byte corruption, invalid identities and
resource cleanup. This component is not yet wired into boot, conversion or
live compaction, and no current demo receives corruption protection from it.
The complete compaction crash matrix, fatal-writer integration and real guest
regressions remain required; the component's passing tests are not that proof.

The final component/freshness/mapping selection passes all 32 tests in the
normal host Vitest runner, including 27 activation-control cases. The normal
fixture owner recompiles the mapping example as expected. Host typechecking
still fails elsewhere; it reports no diagnostics in the new activation module,
its tests or the changed fixture owner. The component has not been bundled
into or exercised by a running demo because no production caller uses it yet.

#### Integrated generation activation candidate

The next implementation batch wires the controls into boot selection, pristine
memory-limited recovery conversion, live compaction, both worker adapters and
the synchronous fatal-writer gate. It preserves unpublished-target crash
recovery while refusing fallback from the activated identity. First conversion
anchors the source before target mutation, including the memory-limited path.
Discovery retains generation occupancy separately from the active candidate
so a rejected target cannot overwrite a verified archive on retry. Failed
descriptor cleanup retains a bounded, charged owner and refuses new acquisition.

Independent read-only review identifies four additional boundaries, now fixed:
writer poisoning must precede queued continuations, first conversion must
anchor its source before touching the target, degraded replica repair must
preserve the sole newest record, and failed close must retain exact ownership.
The final static review reports no additional concrete issue in that scope;
it does not substitute for execution evidence.

Job `overlay-activation-integrated-1021-120643-d241` passes all 24 new real
OPFS regressions on Chromium, Firefox and WebKit without retries or skips.
Each uses the normal ABI 51 guest/kernel path: acknowledge a file write,
compact, acknowledge a newer mapped write, damage only the activated seal,
index or journal, then require strict reopen to refuse without modifying
either source or damaged current data. One journal variant has valid frame
checksums but invalid committed contents, exercising native validation rather
than only host seal checks. Both fixed and resizable modes are covered.
The browser kernels use a 64 MiB ceiling. These are not whole-process peak
memory or power-loss measurements.

That job's Node cohort records 290 passes and 18 failures, not a green result.
Diagnostics identify a worker fixture that aliases control names to the
journal, four resizable fixtures using a single-transaction inflation helper,
synthetic old-format fixtures that rewrite seals without updating/removing
their new activation controls, obsolete expectations of acknowledged-data
rollback, and a metadata-budget fixture missing the new fixed control charge.
Corrections are being validated in a fresh frozen cohort; none retroactively
changes the original receipt. The existing operation-cut crash matrix still
requires successful recovery, not generic refusal. New torn-write cases cover
both sole-newest replica orders and repair versus advancement.

The host build, ABI snapshot and real default-rootfs/64-lazy-asset preflight
pass in that job, and its final source/runtime guards match. Whole-host
typechecking still exits nonzero; no errors are reported in the new activation
module or changed selection/metadata modules. Current checkpoint 1.17 remains
unchanged and does not include this integration. The next checkpoint must be
built through the normal product path after integrated acceptance. Older
unreleased ABI 51 hosts that ignore activation controls are unsupported
writers/downgrade targets; coordinated replay of all storage files and device
power loss remain outside checksum/publication guarantees.

The fresh frozen run `overlay-activation-acceptance-1021-122900-3516` reports
307 Node passes and one failure across the same 308 checks, plus all 24 real
OPFS cases passing again without retries or skips. Source/runtime guards match.
The remaining test successfully exercises successive old-format migrations
and then expects a corrupted activated index to reopen an older journal.
That final assertion now requires `NoValidOverlayGenerationError` and exact
preservation of the source journal and damaged index instead. Its corrective
run precedes the normal checkpoint 1.18 product build. The original one-failure
run remains recorded as failed; the correction is not a fresh all-green run.

The mixed WordPress workload's failure inventory now follows only exact
journal namespaces referenced by its three owned image controls, in addition
to its original computer prefix. It includes activation replicas, retains the
640 MiB capture ceiling, bounds control reads and file count, and never sweeps
or deletes unrelated OPFS entries. This closes the diagnostic omission of
post-checkpoint `j-UUID` journals; it does not itself fix or explain the WebKit
workload failure.

Checkpoint 1.18 is now built and served separately from 1.17. Normal build job
`persistence-checkpoint-1-18-build-1021-123459-d3ab` succeeds in 7m42s,
including the 68 positioned image-module unit checks, ABI 51 snapshot check,
normal 144-node product closure, default-rootfs preflight and static app.
Source/artifact/site receipts identify the inputs and final files; no stale
guest stamping or replacement image shortcut is used. The one corrected
multi-slot upgrade assertion passes in its normal native guest test; its
95 pattern-filtered neighbors are not platform skips. The bounded failure
inventory regression passes on all three browser engines without retries.
The new page and MariaDB image respond with HTTP 200 and the required
cross-origin-isolation headers on port 57245. This checkpoint includes the
activation integration, not a new native ABI. Real static app, source-browser
recovery and persistent-reboot conformance acceptance are running as one
frozen batch before drawing broader release conclusions.

The checkpoint 1.18 static app cohort reports fourteen passes, two explicit
non-Chromium browser-process-crash skips, and two WebKit failures, with no
retries. All Chromium and Firefox application cases pass; the simple WordPress
SQLite/MariaDB post/upload and MariaDB media-library cases also pass on WebKit.
WebKit's mixed workload again stalls during source-blocked guest verification,
and its shell checkpoint reproduces the previously undiagnosed PCM transport
detach failure. Neither is waived as a fixture failure or relabeled as fixed.

The additional workload markers narrow the stall: file contents and alias
comparison complete, but the inode comparison marker does not. This identifies
the next `stat` command-substitution pair, not yet which of its two executions
or which runtime layer is responsible. The corrected inventory captures the
active 25 MiB `j-UUID` journal and both 128-byte controls in addition to the
checkpoint base. Strict recovery of a private copy of that exact journal and
its controls against the captured base succeeds on Node. Actual guest Bash
`cat`, `cmp`, inode/link-count/mode `stat`, `readlink` and file-size checks all
pass. The original captured journal/control SHA-256 values remain unchanged.
This is stronger than checkpoint 1.17's base-only inspection, but does not
establish successful execution of the same commands on WebKit.

All 51 selected source-browser cases pass again on the current host on
Chromium, Firefox and WebKit without retries or skips, including prepared and
active cross-base journal corruption. App-run process-tree sampling records
1,615 samples with no failed samples and a summed RSS peak of 4,725,568 KiB.
Shared mappings can be counted repeatedly and out-of-tree WebKit helpers are
not included; this is not unique physical memory or completion of the aggregate
memory gate. Source-browser cleanup removes 68 run-owned staging files and
its isolated home. Final persistent-reboot conformance and input guards are
complete for this batch: all 64 selected persistent-reboot Sortix checks pass
without skips, timeouts or unexpected results, and final source/artifact/site
guards match. Job `persistence-checkpoint-1-18-acceptance-1021-124259-fee6`
retains its failed status after 33m39s because of the two WebKit application
failures. App teardown removes 55 run-owned staging files totaling
2,788,876,288 allocated bytes and its isolated WebKit home. Captured diagnostics
remain in this worktree; no existing user OPFS store is deleted.

A separate isolated WebKit execution now also passes against the captured
current base, journal and activation controls. It installs only those owned
files, uses the normal BrowserKernel, COI-enabled source server and application
lazy-asset URL table, then runs real guest Bash `cat`, `cmp` and the individual
inode/link-count/mode `stat` commands. All markers complete in the final
13.4-second diagnostic. This is not the MariaDB application workload: its
service processes, HTTP traffic and previous machine lifetimes are absent.
The full-app stall therefore remains open. Earlier private attempts lacked
the source server's correct working directory/COI or normal lazy transport;
their initialization/exec failures are retained separately, not called
filesystem regressions or successful execution evidence.

The next read-only runtime review corrects the interpretation of the missing
Procs table: the UI also awaits account-file reads and restarts its loader on
process events. It does not prove that raw native process enumeration stalled.
The review identifies two candidates, not confirmed causes: a dynamically
replenished kernel-entry queue could prevent event-loop return, or a shell
fork could wait behind unrelated service-worker retirement/listener settlement.
A bounded owner-level progress trace must distinguish those cases before
changing scheduling or wake behavior. Captured-byte recovery remains separate
from that runtime investigation.

#### Demand-driven sink ownership candidate

The next host-only batch addresses a concrete unused owner in the failed shell
checkpoint: ready eagerly attaches a kernel-backed worklet although no guest
has opened `/dev/dsp`. The browser now primes/resumes only the shared context
on an earlier trusted gesture, then binds the real sink when native demand
appears. The existing activity sample is independent of UI subscribers;
explicit preparation still binds immediately. Actual sink detach remains a
strict memory-ownership requirement. This is not a longer acknowledgement
timeout or an assumed acknowledgement from silence. Node's clocked sink and
the Rust PCM implementation remain unchanged under ABI 51.

Independent static review identifies and resolves two related edge cases:
failure of a primed context must poison and clear a later attempted transport,
and an unresolved module load must not hang machine destruction. Preparation
now obtains its descriptor only after the module await and terminal-admission
check. Its bounded close quarantines unfinished context work and removes the
host descriptor; late completion cannot attach a node. Public audio wrappers
return promises without descriptor-bearing async frames, while invoking actual
resume synchronously in the gesture stack. Review reports no further concrete
issue in that narrow scope; it is not full runtime proof.

The final frozen candidate passes 123 Node checks in four files and 27 browser
checks across Chromium, Firefox and WebKit. Six explicit browser skips remain:
the existing production `/dev/dsp` aggregate case is Chromium-only, and four
running-context lifecycle variants exclude pinned macOS Firefox's independently
observed pending resume boundary. Suspended detach remains tested on all three.
New cases cover primed clocks without transport attachment, later binding to
the same activated context, subscriber-independent demand, failed prime/retry,
unresolved module preparation and terminal late completion. Real persistent
kernel teardown/recovery and actual Chromium guest audio drain also pass.

The first browser run retained a failed Chromium guest case because its local
`audiotest.wasm` carried the older ABI-contract digest. The normal fixture owner
now compiles `programs/audiotest.c` through its SDK/sysroot/ABI freshness path;
it does not restamp the old executable. The fresh combined result above is in
the checkpoint 1.19 build job, not a relabeling of that first red run. The normal
ABI-matched product/static-app rebuild now succeeds. The separate WordPress execution stall is not declared
fixed by the audio candidate or its focused passing cohort.

Checkpoint 1.19's normal build completes successfully in 9m09s as
`persistence-checkpoint-1-19-build-1021-133659-c2c0`. It includes all 68 positioned
image-module checks, ABI 51 snapshot consistency, the normal 144-node product
closure, default-rootfs preflight and static application. Frozen audio source
and build source/artifact guards match. Its separate preview serves the page
and MariaDB image with HTTP 200 and cross-origin-isolation headers on port
57248; earlier checkpoints remain unchanged. The full actual-app cohort in
`persistence-checkpoint-1-19-acceptance-1021-134727-5ef0` finishes with fourteen
passes, two explicit non-Chromium browser-process-crash skips and two failures,
without retries. WebKit's shell checkpoint/reload passes with this candidate.
Firefox's media-library upload times out, and WebKit's mixed workload stalls
after the inode-verification marker during checkpoint guest verification.
This differs from the previous stall before that marker; it does not identify
a failing filesystem operation or prove that either stall is fixed. Final
source/artifact/site guards match; the full acceptance job remains failed.

The subsequent private source diagnostic fails before reaching the workload:
its module route also intercepts Vite's worker-URL wrapper, which contains no
process-enumeration handler. It provides no runtime evidence about the stall.
A corrected private route excludes that wrapper. The next failure-tracing run
also handles upload-response and chooser promises concurrently so a response
timeout cannot abort before chooser-phase diagnostics are attached. It records
the upload phase and preserves the real failure rather than adding retries.
These are diagnostic changes, not production fixes or native ABI additions.
The raw enumeration probe is independent of the Inspector, bounds its retained
host/process records, and is not counted as uninstrumented app acceptance.

The corrected instrumented source-app run passes the complete WebKit mixed
WordPress workload in 5.3 minutes, and its final raw process enumeration returns
normally with no pending process/worker teardowns. The static-app failure is not
reproduced or explained by this passing source-app run. The same diagnostic
batch's Firefox run instead stalls on the initial blank HTTP preview before
reaching upload; no upload fix or successful Firefox rerun is claimed. Its
source guards match. The user independently reports very slow initial Chrome
startup on checkpoint 1.19: after download and decompression complete, the
visible stage remains kernel instantiation. It eventually runs. A separate
static-build Chrome/Firefox timing diagnostic is now measuring fresh startup;
no root cause or performance improvement is established yet.

#### Canonical envelope and bounded trailer candidate

At the user's explicit direction, legacy persisted-computer migration is
removed from scope. The next source candidate rejects v1–v4 envelopes and
recognized future versions before fallback or installation, removes the
resident legacy saved-image loader/writer, and removes v4 upgrade transitions.
Normal VFS import, positioned composition, v5 initialization, prepared/active
publication, native journal/index recovery and POSIX semantics remain intact.
Tests replace prototype upgrade expectations with canonical publication cuts
and unchanged-data unsupported-version refusals. The focused host/browser
cohorts below pass; full current-artifact acceptance remains open.

An independent bounded storage-memory review finds an export overlap: each
container read cloned the complete retained image-metadata section and then
copied it again into a trailer. Those temporaries overlap the original owner
without additional admission. The Rust candidate instead computes trailer
length from borrowed sections and reads prefixes/payload directly into the
caller's bounded output window, without either metadata-sized allocation.
The byte format and ABI remain unchanged. New tests compare positioned reads
at every small-section boundary and stream a 2 MiB metadata section at the
resident admission limit, preserving bytes, credit and EOF plan release.
Workspace native validation now passes 3,403 checks in 10m13s, including both
new tests; final native source receipts match. This is not an accepted
whole-process memory-peak or performance result. The first focused host attempt runs zero tests because
the program-index builder detects source changes during its snapshot; it
remains a failed provisioning receipt, not a test pass. Its stable-source rerun
passes all 34 host metadata/policy tests. The complete canonical-manifest
cohort passes all 72 browser cases on Chromium, Firefox and WebKit without
retries or skips, including publication cuts, strict corruption recovery,
released-lease refusal, streamed installation and real guest checkpoints.
Those browser cases use the prior ABI-matched native artifact. The new Rust
exporter is now rebuilt through the normal runtime/product path and passes
the Chromium WordPress/MariaDB smoke described below; broader current-artifact
acceptance remains open. Application typechecking still
exits nonzero on existing Node-test environment/import errors, with no
diagnostics in the changed manifest, live-setup or image-binding policy files.

The first private startup diagnostic does not measure the reported slowdown:
it omits the existing tests' explicit confirmation approval, and Chrome
correctly refuses experimental persistence before boot. That failed run is
retained; its still-running Firefox case is intentionally interrupted and
normal owned-profile cleanup completes. A corrected run approves the same
warning as the normal application fixtures and saves per-browser timing files.
Do not attribute the invalid run's ten-minute assertion timeout to slow boot.

The corrected static 1.19 startup diagnostic passes both browsers without
retries in 2m48s: Chromium reaches the WordPress page in 44.3 seconds and
Firefox in 113.9 seconds. Neither records a console/page error. Chrome's
save/readback/kernel-init stages take about 5.9/4.8/5.3 seconds; Firefox's
take about 25.3/11.6/16.0 seconds. This concurrent, instrumented run is not a
quiet performance baseline and does not reproduce or explain the user's
six-minute startup. It does establish that full download/decompression bars
precede material composition, save/verification and native/service startup
work. Do not describe the reported slowdown or progress presentation as fixed.

Independent static review finds no additional concrete issue in the bounded
trailer or canonical envelope changes. Checkpoint 1.20's normal build passes
in 11m39s, including 68 positioned-module checks, the ABI 51 snapshot check,
all 144 selected product nodes, closure preflight and source/artifact/site
receipts. Its static preview is on port 57250; checkpoint 1.19 is unchanged.
The actual static-app Chromium MariaDB smoke passes without retry in 3m28s:
a published post and PNG uploaded through WordPress REST survive checkpoint,
browser-process crash and same-profile recovery with the original image
source blocked. This does not cover the Plupload media-library UI, Firefox,
WebKit or a startup performance fix. The combined Node, three-engine actual
application/source-browser and persistent-reboot Sortix batch is running.

#### Reported startup slowdown investigation

The user reports download/decompression and subsequent startup both slower
than earlier checkpoints. Image growth is not the explanation: an alternating
two-round local transfer comparison records these actual MariaDB artifacts:

| Checkpoint | Compressed bytes | Decoded bytes | Zstd window |
|---|---:|---:|---:|
| 1.9 | 43,573,257 | 245,776,723 | 8 MiB |
| 1.16 | 43,572,895 | 245,776,723 | 8 MiB |
| 1.19 | 43,572,655 | 245,776,723 | 8 MiB |
| 1.20 | 43,573,984 | 245,776,723 | 8 MiB |

All eight identity-encoding GETs return HTTP 200 in 25–49 ms. All eight
browser-like encoding GETs return dynamically gzipped, chunked HTTP 200 in
742–817 ms, saving only about 45 KiB each. Thus double compression is present
in every compared preview, not a newly introduced 1.19 difference. These curl
transfers consume bytes without application decompression or OPFS writes;
they do not establish browser-phase throughput. Native zstd decoding takes
125–129 ms for all four files, not evidence about the JavaScript decoder.
Receipts are `.context/checkpoint-transfer-comparison.json` and per-request
headers. The fresh-profile, alternating 1.9/1.19 comparison passes all eight
actual static-app boots without retries or console/page errors in 4m51s:

| Browser | 1.9 WordPress body, two runs | 1.19 WordPress body, two runs |
|---|---:|---:|
| Chromium 153.0.8010.12 | 23.900 / 24.088 s | 38.680 / 38.714 s |
| Firefox | 26.085 / 26.197 s | 46.249 / 46.795 s |

Chrome's image response takes 0.82–0.93 seconds across both checkpoints;
Firefox's resource timing does not expose a usable response duration. The
readback stage alone rises from about 0.3 seconds to 3.9 seconds in Chrome
and 5.5 seconds in Firefox. Similar increases occur in source staging,
positioned composition before output streaming, and kernel initialization.
Source inspection identifies the relevant change: constant-size whole-image
JavaScript SHA-256 replaces native WebCrypto chunk hashes in these paths.
This removes image-sized digest tables but introduces substantial CPU work.
These observations reproduce a regression; they do not reproduce the user's
six-minute case or establish system load as its cause. Concurrent validation
continues, so this remains a diagnostic comparison, not a quiet release
benchmark. Receipts are `.context/checkpoint-matched-startup-output/`.

A private, unintegrated Rust `sha2` Wasm probe checks exact SHA-256 bytes
against Node's native implementation at padding/chunk boundaries and on
245,825,536 streamed bytes. All three browser cases pass. Two alternating
hash-only rounds measure JavaScript/Rust at 3.68/0.62 seconds in Chrome,
5.29/0.54 seconds in Firefox, and 1.14/0.77 seconds in WebKit. Rust input
scratch is 64 KiB and its private linear memory stays at 1,179,648 bytes;
the module is 9,601 bytes. This is evidence for a bounded hashing candidate,
not an application speed improvement or production fix. The next candidate
must preserve the exact digest and all verification boundaries, bound both
concurrent hash state and module ownership, use normal artifact provenance,
and repeat actual WordPress startup/recovery comparisons after integration.
Independent six-file review confirms five decoded-image-sized JavaScript
hash passes on fresh positioned boot and one full-base pass on healthy
restored boot. Write-time expected-byte hashing and later storage verification
serve different purposes; do not simply remove them. It also finds duplicate
verification of an already selected repair candidate before commit. Any
repair-only consolidation must retain exact file identity, selection locking
and journal/header checks. Neither optimization is implemented yet.

The current 1.20 integration batch passes all 831 Node checks across 32 files
in 17m44s, including the opt-in larger-than-memory fixtures. Its process-tree
sampler records 1,063 samples with no sampling failures and a peak summed
descendant RSS of 2,235,264 KiB. Shared mappings may be double-counted, and
out-of-tree helpers are excluded; this is not a unique physical-memory bound
or aggregate storage-memory acceptance. The full batch subsequently completes
in 49m19s: 16 actual-app cases pass across Chromium, Firefox and WebKit, with
two explicit non-Chromium CDP crash-test skips; all 51 source-browser cases
and all 64 selected persistent-reboot Sortix cases pass. There are no retries.
The application cohort includes shell recovery, WordPress SQLite/MariaDB
post/upload recovery, actual media-library UI uploads and a mixed MariaDB
workload. Its sampler records 1,460 samples without sampling failures and a
peak summed descendant RSS of 4,231,584 KiB, subject to the same limitations.
All 3,347 source, 16 artifact and 141 static-site receipt entries still match
at completion. The source/artifact freeze for that cohort is released; later
Rust integrity-core changes are not covered by those historical application
results. The preview on port 57250 remains the tested 1.20 build and does not
include the experimental fast-boot implementation.

#### Rust demand-verified image candidate

Fast-boot review confirms another full-base scan in Rust's
`enable_rootfs_persistence`, in addition to the JavaScript verification
passes. Accelerating SHA-256 alone does not remove this scaling problem.
The next isolated Rust candidate builds and reads a domain-separated SHA-256
block tree: 64 KiB data pages, 4 KiB index pages, a canonical 128-byte header
bound to an externally supplied expected identity, and fixed eight-page data
and eight-page index caches. All heap buffers use the existing I/O admission
owner. The positioned streaming writer exclusively borrows one initially
empty target through completion; it writes the header last and returns an
identity only after successful flush. External generation publication must
still happen afterward; header-last is not itself a crash commit protocol.

Nine native candidate checks pass in 2.35 seconds, including sparse zero
runs, short final pages, nonzero three-level membership, swapped proofs,
corruption refusal before exposing bytes, transport errors, partial cache
victim overwrites after eviction, and write/length/flush cuts. An actual
sparse 32 GiB file opens with only a 128-byte read; 32 scattered verified
reads consume 2,363,520 source bytes. Cache payload is at most 544 KiB,
separate from its admitted record/overlap accounting. This proves the
standalone source's demand-verification behavior, not filesystem mount or
application startup time. Those nine checks describe the original private
candidate; the configurable shared-core followup is recorded below.
Rust mount/read/export integration, expected-root
and journal binding, normal artifact rebuilding, and actual Node/browser
application validation remain required before replacing any existing check.

Independent review found and corrected a writer-ownership API gap: separate
targets could previously be supplied between begin, push and finish. The
builder now retains one exclusive borrow, so a completed identity cannot
accidentally describe writes made to another target. Both requested deeper
membership/cache-error regressions are included in the nine passing checks.
No new fast-boot demo or production behavior is claimed yet.

The mobile checking-policy followup adds an experimental shared Rust
`persistent_image` core under `crates/runtime-core`, rather than making
TypeScript own the new format. Creation requires an explicit `Crc32c` or
`Sha256` policy; there is no implicit default or unchecked mode. Both use
demand-verified paged trees, with four-byte or 32-byte digest entries
respectively. The canonical header always has a SHA-256 identity that binds
the selected policy, geometry and root. This does not make the CRC payload
cryptographically bound: CRC remains accidental-damage detection. Changing
policy requires constructing and publishing a new image generation, not
silently interpreting an existing image with weaker checks.

Cache configuration is independent of the creation policy and image size.
The Rust API admits one to 64 data pages and one to 64 index pages, with
explicit constrained and desktop configurations of two and eight pages each
(136 KiB and 544 KiB maximum cache payload). Record capacity and allocator
overlap remain separately charged to the shared I/O owner. A reader retains
one source instead of accepting a potentially different source on every
cache lookup. Builder target ownership and flush-before-identity behavior
are preserved. This core is not yet wired into kernel mount/export,
composer transport or browser computer publication; the running checkpoint
still uses its existing whole-image checks.

Do not select a mobile default from desktop SHA-256 microbenchmarks. Actual
phone measurements must include cold random-read amplification, sustained
uncached throughput, cache eviction/reverification, startup and bounded
memory; battery effects are unmeasured. Algorithm or cache configurability
must not disable journal ordering/recovery, structural checks or generation
binding. An expected root provides authenticity only to the extent that its
own trust and publication boundary is established.

Fifteen shared-core native checks pass, each applicable filesystem case
covering both policies. This extends the original nine checks with independent
CRC32C vectors and bitwise-reference comparisons, incremental SHA-256
equivalence, policy/unknown-mode refusal, cache configuration/eviction,
partial target writes, actual I/O-admission exhaustion with release and
retry, and ordinary VFSI/KIFS container mounting through both envelopes.
The latter preserves file content across indirect blocks, hard links,
symlinks, ownership, permissions and the metadata trailer.
Three-level membership runs with one index and one data page; the
partial-read/cache-victim error matrix covers both one-page and desktop
configurations. Reopening actual sparse 32 GiB files reads 128 header bytes
in either mode; 32 scattered reads consume 2,232,448 source bytes with CRC32C
and 2,363,520 with SHA-256. These are deterministic source-read counts, not
phone or application performance measurements. The combined shared-core
acceptance job completes in 2m11s: all 3,418 Rust workspace unit/integration/
documentation checks pass with no failures or ignored tests, excluding
xtask, and the no-std Wasm target check, new-file formatting and diff checks
pass. These checks do not replace Node/browser artifact integration or
actual-phone validation of the new envelope.

#### Mount and host integration followup

The next candidate wires the shared envelope reader into
`rootfs::load_persistent_image`, with a retained raw-source adapter and a
verified cache independent of the namespace lock. The ordinary image source
now routes mounted checked-base reads through this owner, including later
file reads and export. Reset, failed mount and ordinary VFSI replacement drop
the integrity state. Rootfs journal attachment refuses a mismatched envelope
identity before opening journal or index storage; the kernel's checked-base
branch validates physical length and reuses the bound identity instead of
scanning the complete base. Plain VFSI retains its existing path.

Five native mount checks pass in both creation modes: retained-source file
reads and symlink/hard-link identity, resizable write/reset/journal replay,
mismatched-root refusal with untouched journal storage, unread file-data
corruption refusal before exposing guest bytes, and state/credit release on
failed mount and plain reload. Existing container parsing reports corrupt
mount metadata as `EINVAL`; data-read verification reports `EIO`. A first
test incorrectly expected `EIO` from the existing container parser; the
corrected assertion preserves that established parse-error distinction.
These tests are not Node/browser runtime acceptance.

The extra native checks replace a successfully mounted image with a different
policy/identity, fail during metadata traversal, prove both owners and their
I/O credits are cleared, and mount again successfully. Wrong-root tests cover
fixed, resizable and both indexed entry points with journal/index storage
that panics on any access, proving refusal precedes storage operations.

An additive ABI 51 export accepts physical length, eight little-endian
identity words and explicit data/index cache page counts without borrowing
host-staged kernel memory. Shared host plumbing exposes
`PersistentImageReadBinding`; Node file and browser OPFS init options pass
that binding to the same Rust path. Neither may combine it with whole-image
host integrity metadata. Checked-base transport bypasses the host LRU and
hashing; OPFS retains only a reusable 64 KiB transfer buffer, while Node can
read directly into the destination. Rust remains the filesystem/cache and
integrity authority. A bounded native Rust wrapper example prepares real
VFSI fixtures without adding a TypeScript format writer.

The initial focused host batch passes 37 checks across five files, including
real Node kernel-worker boot, base-file reads, resizable journal replay and
wrong-root refusal in both creation modes. Six real OPFS restart cases pass
on Chromium, Firefox and WebKit in 17.3 seconds without retries or skips;
their run-owned WebKit storage is cleaned. They use the public browser host,
actual OPFS base/journal files, a 64 MiB kernel ceiling and one-page data/index
caches. They validate low-level functionality, not WordPress boot times,
crash durability or mobile performance. The combined rebuilt-artifact,
workspace, expanded host, browser and persistent-conformance batch is tracked
separately. These interfaces do not yet change the browser composer's streaming
writer, checkpoint publication schema or running WordPress checkpoint.
Normal artifact rebuilding, source-read scaling, fresh/reopen application
timings, compaction handoff, corruption/fault acceptance and real-phone
measurements remain required. Host standalone typechecking still reports
configuration/import and other-module diagnostics; do not describe it as
passing because the focused runtime checks pass.

The first rebuilt integration batch passes the ABI check, all 3,423 Rust
workspace checks, 44 host checks and all six browser cases. Its conformance
phase cannot launch guests because rebuilding the kernel removes the stale
default-rootfs projection; it is not a green combined batch. The normal
`platform-rootfs` closure is being rebuilt rather than bypassing artifact
provenance or substituting a smaller conformance fixture. The plan contains
18 nodes and estimates roughly 17.5 minutes at two jobs; this estimate is not
a completed build result.

Memory-pressure review adds explicit reclamation of immutable base data/proof
buffers to the existing Rust I/O-pressure and export/compaction reclaim path.
It keeps the expected identity/source and charged cache records, never drops
dirty journal state, and forces subsequent reads to verify again. If cache
growth is refused, the reader can reuse an already admitted same-kind page
instead of requiring every configured slot to warm. Twenty-three focused
native checks pass after this delta, including actual credit release and
corruption refusal after reclamation. Resource admission may still return
truthful `ENOMEM`; reclamation does not promise that every requested cache
configuration or concurrent workload fits. Independent read-only review finds
no concrete corruption, lock or admission-credit regression in this delta.
The rebuilt-artifact/Node/browser/conformance rerun remains separate evidence.

#### Streaming checked-image writer integration

The normal default-rootfs prerequisite build completed. The following
pre-writer workspace run passes 3,425 Rust checks. Its expanded host run has
43 passes and one static-audit timeout at the existing 180-second limit,
not an ownership assertion failure; the audit is being rerun with an explicit
longer command budget without weakening its assertions. All six OPFS reader
restart cases pass again across Chromium, Firefox and WebKit. The selected
persistent conformance run has 59 passes and five host launch failures while
source-contract regeneration observes the changing Cargo dependency snapshot.
That is not a passing 64-case acceptance run. Repeat it on the frozen writer
candidate after rebuilding; do not classify failed launches as POSIX passes.

The new positioned image-module writer owns a token-bound output target
across calls instead of needing a borrowed Rust stack target to remain live.
The shared core still permits exclusive borrowed targets. Host imports are
only source reads plus target size, positioned reads/writes, truncate and
flush. The default writer still imports nothing; the normal build script
checks the positioned variant's exact six-import contract. No kernel export
or import changed in this writer step; the ABI check still passes at 51.

Rust constructs the envelope and checking tree from bounded chunks. After
flush it reopens the exact target through the shared checked reader and
verifies stored payload blocks in bounded steps. The host cannot obtain the
identity through this module until that readback completes. Refused nested
operations do not replace the target; failed writes or readback poison the
session until explicit cancellation. Cancellation releases admitted buffers
without truncating someone else's file or publishing a partial target.
Creation policy is mandatory and never downgraded during reads.

`KandeloImageFs.createPositioned` exposes an empty Rust filesystem suitable
for streaming export. `writePersistentImageTo` accepts a known-length raw
VFSI stream and `exportPersistentImageTo` obtains the export geometry from
Rust rather than decoding a filesystem header in JavaScript. Both report
write and stored-byte verification progress separately. A checked source can
also be mounted and composed through `createFromPositionedImage` with an
expected identity and explicit cache budgets. The host registry captures one
target's byte methods, uses nonrecycled tokens, rejects unsafe offsets and
oversized transfer windows, and retains its target across asynchronous
progress and cancellation. Callers still own the exclusive physical handle
and crash-safe manifest publication.

The writer build passes 72 native image-module checks and 23 focused core
checks, including readback damage after successful flush, partial host I/O,
reentrant target replacement, quota preservation, cancellation, base-cache
reclamation and journal binding. Both Wasm variants build through the normal
recipe. The integrated run passes 106 host checks and 12 real OPFS cases
across Chromium, Firefox and WebKit, followed by all 64 selected
persistent-reboot conformance cases. That conformance command uses its
ordinary VFSI base; it validates the persistent filesystem core but is not
an exhaustive checked-base POSIX matrix. The host batch has one explicit
fixture-gated skip: the existing near-dense 32 GiB snapshot case was not
enabled. Neither that skip nor small OPFS fixtures establish the remaining
larger-than-memory browser acceptance.

Independent read-only review found two cleanup/cancellation issues in the
first writer snapshot. Geometry preparation and native export cancellation
now share an explicit owner; completing a persistent export cannot cancel a
new iterator started by a progress observer. Owner-scoped cleanup also covers
scratch-allocation refusal. Waiting for an input chunk or asynchronous
progress observer is abortable without waiting for that external promise to
resolve; every later native continuation checks the signal again, including
the final verification-to-identity boundary. Cancellation requests producer
cleanup, but the caller still owns external producer lifetime; it does not
prove an arbitrary producer has stopped. Async producer cleanup failures are
reported rather than silently discarded. No target token or Wasm scratch
authority is handed to those producer/progress promises.

The final followup passes 110 host checks, including the exact superseding
iterator, failed replacement allocation, unresolved producer/progress and
final-verification microtask-abort regressions. Twelve browser cases pass
again without retries or skips in 25.8 seconds. The browser worker now aborts
while progress and producer promises remain unresolved, releases its OPFS
target, writes and checks a fresh image, mounts it through the Rust composer,
then boots and restarts a real kernel against it. WebKit's run-owned storage
and two staging files are cleaned. The final read-only review finds no
remaining defect in those exact cleanup/race fixes; it is not a whole-format
or publication review.

A focused strict TypeScript project covering the bridge, target registry,
new writer tests and browser worker passes. The broader host-only typecheck
still reports its existing 40 diagnostics and is not passing. These distinct
typecheck scopes must not be conflated.
The actual browser composer, publication schema, checkpoint lifecycle and
WordPress + MariaDB demo still require integration with this writer. No new
fast-boot WordPress checkpoint is available yet.

- [x] Complete streaming deferred-transport acceptance. Persistent roots now
  stage response bodies in disposable positioned byte storage: an unlinked
  Node temporary file or an OPFS file held by a worker ownership lock.
  Downloads are serialized; storage calls and OPFS bounce/prefix-copy buffers
  are bounded to 64 KiB. Native URI slots stay separate even when deployment
  rewrites resolve them to one URL. Extents grow with received bytes rather
  than declared maximum size; short downloads cannot leave huge reserved
  holes. Growing retries retain their prefix without overwriting other slots.
  Successful full-sized retries reuse their existing extents. Rust retains
  length/digest and filesystem authority; no kernel import/export changed.
  This is still ABI 51. The final host build passes 454 Node checks across
  20 files, including 35 transport/storage checks, and 64 selected
  persistent-reboot Sortix cases. The ABI snapshot check passes. Browser job
  `persistent-deferred-spool-alias-browser-1017-212918-7a06` passed all 33
  Chromium/Firefox/WebKit cases, including the nine real shell and WordPress
  SQLite/MariaDB recovery workflows. Kernel Rust did not change in this
  transport step; its previous 3,070-test workspace result is not a new run.
  The shared 96 MiB guest fixture now uses a backpressured server with one
  reusable 64 KiB source block, rather than a complete closed-asset buffer.
  Each fill/recovery/checkpoint kernel fetches the URI once; export preserves
  its deferred description. The browser ownership fixture also terminates a
  worker, reclaims its abandoned store after ownership is released, preserves
  another live store's bytes, and leaves unrelated entries untouched.
  Red regressions are recorded in
  `.context/persistent-deferred-spool-ownership-webkit-red.log`,
  `.context/persistent-deferred-spool-alias-before.log`, and
  `.context/persistent-deferred-spool-allocation-before.log`.
  Final evidence is in
  `.context/persistent-deferred-spool-{host-build-final,node-final,browser-final,sortix-final,abi-final}.log`;
  `.context/persistent-deferred-spool-alias-browser-final.json` includes browser
  attachments, and `.context/persistent-deferred-spool-kernel-memory.json`
  extracts the 277/221/37/221 kernel-page measurements for
  fill/recover/export/checkpoint on all three engines, matching Node.
  `.context/persistent-deferred-spool-artifact-sha256.txt` identifies the
  unchanged kernel/demo images and rebuilt host entry points. These are not
  whole-process peak-memory measurements or benchmark throughput acceptance.
- [x] Bound persistent archive transport-to-member reads in Rust. Positioned
  ZIP32 parsing retains a filename-hash/header-offset index rather than the raw
  archive or a name/header object for every entry. Index retention is capped
  at 4 MiB across 64 archives; a transient new index is bounded by ZIP32's
  65,535 entries, with bounded tail/name scratch. Two incremental member
  readers retain 64 KiB input/output buffers and at most eight decoder
  checkpoints each. Sequential reads advance existing state; uncovered
  backward seeks can decode a prefix again. Native tests guard per-reader
  heap retention below 1 MiB, excluding allocator overhead. Raw archive
  authentication has a separate 8 MiB / 64-object chunk-table cache and four
  1 MiB data chunks, in addition to the existing file-level verification
  cache. URI rejection invalidates both proof caches, indexes, and decoders.
  Persistent activation drops whole caches warmed while ephemeral. No host
  imports/exports or package recipe changed; this remains ABI 51.
  Artifact job `persistent-streamed-archive-index-artifa-1017-230237-3f0c`
  passes all 3,079 workspace Rust checks excluding xtask and prepares the
  kernel, image modules, host, and ABI-matched products through bootstrap.
  Native checks cover multi-block DEFLATE and backward seeks, malformed
  streams/metadata, typed source errors, indexed many-member lookup, metadata
  eviction, shared-URI invalidation, and generated large archives without
  resource-sized input arrays. The two targeted Node cases and all six
  Chromium/Firefox/WebKit cases pass: guest `dd` and ranged tail/backward/full
  reads consume 96 MiB stored or compressed members under a 64 MiB kernel
  ceiling and 8 MiB logical disk, then repeat after strict journal recovery
  and positioned checkpoint boot. Each kernel fetches the archive once.
  Node checks the complete member SHA-256; browsers check every byte. Kernel
  phase memory is 246 pages for stored members and 178 for compressed members
  on Node and all three engines; these are not whole-process peaks or
  throughput results.
  The old kernel fails both large-member cases, and a native regression
  reproduces warmed whole-cache retention before the activation fix.
  Evidence: `.context/persistent-streamed-archive-node-before.log`,
  `.context/persistent-streamed-archive-warm-before.log`,
  `.context/persistent-streamed-archive-index-native-final.log`,
  `.context/persistent-streamed-archive-node-targeted.log`, and
  `.context/persistent-streamed-archive-browser-targeted.{log,json}`.
  Final acceptance job `persistent-streamed-archive-accepted-1017-234337-9989`
  passes all 48 browser cases without skips, including all nine real-page
  shell and WordPress SQLite/MariaDB workflows, then all 64 selected
  persistent-reboot Sortix cases and the ABI snapshot check. The final focused
  Node inventory passes 534 tests in 23 files without skips. These are the
  selected persistence checks, not a complete conformance/release run.
  Final evidence is in
  `.context/persistent-streamed-archive-node-accepted.log`,
  `.context/persistent-streamed-archive-browser-accepted.{log,json}`,
  `.context/persistent-streamed-archive-sortix-final.log`,
  `.context/persistent-streamed-archive-abi-final.log`,
  `.context/persistent-streamed-archive-artifact-sha256.txt`, and
  `.context/persistent-streamed-archive-kernel-memory.json`.
  One earlier broad run passed 47/48: Firefox's two-byte, 20-second-chunk
  healthy-progress fixture hit the 30-second inactivity backstop. Three
  diagnostic repetitions passed; the original timeout's precise cause is
  unproven. The final fixture sends five 64 KiB chunks eight seconds apart,
  still takes 40 seconds, records server/client timing, and explicitly requires
  client-visible partial progress before the deadline. It passes on all three
  engines in isolation and in the final broad run. No production timeout was
  increased or disabled. The earlier failure and diagnostic evidence remain in
  `.context/persistent-streamed-archive-browser-final.{log,json}`,
  `.context/persistent-streamed-archive-firefox-progress.{log,json}`, and
  `.context/persistent-streamed-archive-progress-final.{log,json}`.
  Whole-system metadata bounds and realistic compressed random-access
  performance remain open. At this archive milestone, dense-file loading still
  created a full allocated-block list before discarding it; the allocation
  traversal milestone above removes that temporary. Sparse lists, checkpoint
  clones, and whole-metadata input allocations remain separate open work.
- [x] Finish URI/namespace metadata and aggregate transient budgets. Host URI
  limits, transport slots, queued requests, spool spans and streamed generation
  discovery now share profile-aware admission. Persistent ready slots no
  longer retain whole bodies. Nonpersistent transport, caller-owned closed assets,
  and arbitrary fetch implementations retain their separate allocation
  boundaries. Ephemeral archive raw bytes, central directories, and extracted
  members still retain complete buffers. The persistent archive budgets above
  do not bound namespace growth, recovery, snapshots, caller-owned buffers, or
  aggregate host/process peaks.

  Current closure: the ABI-55 requirement audit accepts the bounded persistent
  paths and the explicit separate caller, manifest, archive and worker owners.
  The current Node/OPFS pressure and complete same-realm memory cohorts pass.
  The following investigation receipts retain their historical limitations;
  ephemeral resident assets and arbitrary caller fetch buffers do not become
  part of the persistent cache's budget.

  The 2026-10-21 host-metadata implementation reserves before URI decoding,
  queueing, storage acquisition or generation-file opening. Partial refusal
  rolls back its new owners and preserves existing state. Shutdown cancels
  active/queued transfers but keeps accepted spool bytes readable through
  final mapping publication and sync; final close releases the store.
  Generation operations serialize and retain admitted successful slot names
  until realm retirement rather than applying an arbitrary slot-count cap.
  Seal/digest traversals reuse one bounded scratch buffer per operation.
  This is modeled host admission, not measured allocator or process peaks.

  The focused nine-file run passes 239 tests, and the host JavaScript and
  declaration build passes. A separate actual Node-worker regression now
  supplies a valid image with 1,400 long deferred URIs, reaches the host's
  metadata `ENOMEM` before creating any journal or SQLite lock, then boots a
  smaller image using the same persistence path. Earlier fixtures hit native
  metadata admission or image-export admission instead; their failed logs
  are preserved rather than counted as host-pressure acceptance. Combined
  job `persistent-host-metadata-acceptance-1021-012541-30a2` is terminal with
  failures: 372 Node passes, one canonical lazy-resolver package-check timeout
  and two unprovisioned physical >32 GiB opt-in cases; 50 browser passes and
  four failures. Chromium/Firefox's new pressure fixture incorrectly assumed
  an overlay directory existed after pre-journal refusal; it now treats an
  absent directory as an empty inventory without creating it. The other two
  failures are real WebKit PCM detach-acknowledgement timeouts in healthy slow
  read and capacity/checkpoint teardown. They remain acceptance failures,
  not filesystem corruption diagnoses or waived tests. Source and kernel
  receipts match after this first run. Logs and failure screenshots remain in
  `.context/persistent-host-metadata-acceptance-*`.

  The followup removes repeated `Promise.race` subscriptions from normal
  deferred-read waits. Each cohort has one shared settlement signal and
  admitted removable listeners; timeout reclaims a listener without waiting
  for the download to finish, and settlement clears all remaining timers.
  New tests cover 1,000 timed retries without attaching promise reactions,
  full-credit refusal before timer creation, concurrent waiters, credit
  reclamation/retry and a second still-pending fetch after the first settles.
  The corrected three-file ownership selection passes 67 tests, including
  the full existing spool and wiring files. Its first failed run used a
  helper outside its test scope and left fake timers active; the fixture was
  corrected, not the production timeout or expected memory behavior.
  The new host-only checkpoint rebuild is
  `persistence-checkpoint-1-15-build-1021-014438-5fec`; combined and actual
  application results are recorded in the checkpoint section above. The
  corrected metadata-pressure test passes on Node and all three browsers,
  including refusal before journal creation and smaller-image retry. ABI
  remains 51. Remaining browser failures are not waived by those scoped
  passes, and the prior cold canonical resolver timeout is not explained or
  repaired merely because both resolver variants pass in the final run.

  Remaining directly storage-sized owners include per-chunk image integrity
  arrays and manifest parse/stringify overlap.
  New image output should use a streaming whole-image digest with an explicit
  versioned manifest, retaining bounded legacy-format reads. A global digest
  must be checked before boot/publication; hashing only the downloaded source
  does not verify bytes read back from storage. A format upgrade must also
  prevent an older host from treating the unsupported current manifest as
  damage and silently booting its older supported fallback. Before publishing
  a new-format current generation, migrate the verified fallback manifest to
  the new format too, without changing its base/journal bytes. Test crashes
  between these publications and prove that an old reader either sees the
  still-current acknowledged old generation or fails closed, never a stale
  fallback after the new generation is acknowledged. Actual overlapping
  profile/process peaks and these remaining owners keep this gate open.
- [x] Complete deferred-transport inactivity and cancellation handling. Active transfers
  now have a 30-second inactivity deadline renewed only by staged bytes.
  Inspection and prepared exec observe monotonic byte progress; healthy large
  downloads are not limited to 30 seconds in total. Abortable fetch/read,
  backoff, and cleanup waits release the queue even when custom cancellation
  never settles, and late callbacks cannot write or publish bytes. Shutdown
  cancels deferred work after closing creator admission and before draining
  admitted creators, allowing dirty-file sync after a blocked lazy exec.
  The host build and 532 focused Node checks across 23 files pass, with no
  skips. The nine targeted lifecycle cases pass on Chromium, Firefox, and
  WebKit: a 40-second read with positive byte progress, stalled-source deadline
  and late-response rejection, and shutdown of an admitted blocked lazy exec
  followed by strict recovery of an unsynced dirty file. The broader browser
  run passed 41 of 42 cases, including all nine shell/WordPress SQLite/MariaDB
  workflows; its remaining WebKit case failed before the download because a
  fresh profile exposed an earlier fixed-name journal. A diagnostic rerun
  confirmed the pre-existing 72-byte journal. Recovery correctly refused the
  changed base image. Both new computer fixtures now use unique identities;
  the healthy-read fixture also checks that its chosen journal namespace is
  absent before initialization. The nine-case corrective run passes without
  changing production recovery policy. Do not describe the first broad run as
  wholly passing or as a new complete release-acceptance run.
  Evidence: `.context/persistent-deferred-shutdown-before.log`,
  `.context/persistent-deferred-shutdown-node-final.log`,
  `.context/persistent-deferred-deadline-node-accepted.log`,
  `.context/persistent-deferred-deadline-browser-final.{log,json}`,
  `.context/persistent-deferred-webkit-isolation-red.{log,json}`, and
  `.context/persistent-deferred-deadline-lifecycle-final.{log,json}`.
  The host build is recorded in
  `.context/persistent-deferred-shutdown-node-final.log`. All 64 selected
  persistent-reboot Sortix cases pass without skips in
  `.context/persistent-deferred-deadline-sortix-final.log`; this is not the
  complete conformance inventory. The ABI snapshot check passes in
  `.context/persistent-deferred-deadline-abi-final.log`. Kernel/demo images and
  rebuilt host entry-point hashes are recorded in
  `.context/persistent-deferred-deadline-artifact-sha256.txt`. The 96 MiB fixture
  again records 277/221/37/221 kernel pages for fill/recovery/export/checkpoint
  on Node and all three engines; browser attachment extraction is in
  `.context/persistent-deferred-deadline-kernel-memory.json`. These remain
  kernel phase measurements, not aggregate peak-memory or throughput acceptance.
  No Rust source or Wasm interface changed in this lifecycle step; native Rust
  results remain the prior implementation's evidence, not a fresh run.
- [x] Accept transport storage-pressure and workload behavior. Temporary bytes use OPFS
  quota independently of the image's logical capacity; retired extents are
  reclaimed when the store closes. Measure pressure and cache reclamation
  rather than assuming temporary storage is free or claiming a throughput
  improvement. These caches are not durable mirrors or offline boot assets.
  Current closure: the ABI-55 storage/pressure, archive-overlap and
  authority/quota cohorts pass, with native Chromium quota-manager coverage
  and four explicit unsupported Firefox/WebKit protocol cases. Node and all
  three engines complete the mixed persistent workloads; all enabled
  Node/Chromium benchmark suites complete. The current record separates
  actual OPFS workloads from resident-runtime microbenchmarks and retains
  measured costs rather than promising a transport speedup.

## Remaining logical-capacity work

- [x] Separate container-byte limits from filesystem capacity in input
  validation. A valid fully sized KIFS body may fill its logical ceiling while
  the VFSI header and trailer add more bytes outside the filesystem. Metadata
  validation now accepts that framing overhead while resident profiles still
  bound decoded bytes and the Rust-parsed logical ceiling independently.
  Positioned composition uses the bounded OPFS stager's 64 GiB transport limit,
  not the legacy in-memory decoding limit. Fully sized raw and zstd images and
  a 4,362,076,188-byte v2 source install and recover through the real page on
  Chromium, Firefox, and WebKit. The large case syncs a guest counter, blocks
  its original source, reloads, and verifies the next counter without another
  source request. This is input-path acceptance, not proof of the remaining
  logical reservations or whole-system memory bounds.
- [x] Count the live composed block footprint with bounded scratch memory,
  including sparse data, indirect pointers, directory records, internal
  metadata, and open-unlinked files. Do not allocate a file-sized block list
  just to answer a free-space query or admit a write. Persistent `statfs` now
  scans the live inode arena, enumerates composed file blocks through the
  bounded journal iterator, and counts deferred metadata without encoding it.
  Its directory-size counter models the writer's existing padding/index
  policy with at most 16 saved regions and no format change; a native test
  checks 18,000 inserted names against the actual writer. Statistics preserve
  nonstandard mounted inode geometry rather than deriving a new table layout.
  Differential tests compare mixed sparse, dense, wide-directory, and deferred
  metadata usage against actual checkpoints. This also exposed and fixed image
  loading that duplicated hard-linked inodes, breaking strict recovery and
  double-charging their allocations. Regular, deferred, symlink, and FIFO
  hard links now retain shared identities. The shared Node/OPFS guest workflow
  checks regular-file, symlink, and FIFO hard links after strict journal reboot
  and after reopening a checkpoint, including a write through an alias.
  On 2026-10-17, fresh ABI 51 artifacts passed 3,053 Rust workspace tests,
  205 Node checks, 27 OPFS/demo cases across Chromium/Firefox/WebKit, and 64
  selected persistent-reboot Sortix cases. The browser acceptance includes
  shell checkpoint/recovery and WordPress post/upload recovery with SQLite and
  MariaDB. Logs are
  `.context/persistent-bounded-accounting-{workspace,node,sortix}-final.log`;
  the browser job is `persistent-bounded-accounting-browser-fi-1017-180540-ec2d`.
  The final artifact build is `persistent-deferred-orphan-artifacts-1017-175811-7040`,
  and the ABI snapshot/version check passed.
  These results do not complete the logical write/namespace reservations below
  or the separate whole-system metadata-memory and performance gates.
  The final lifetime audit also caught premature reclamation of deferred-file
  records and archive descriptors: a real guest saw an 8 KiB increase in free
  space while its unlinked deferred file was still open. Accounting now retains
  those descriptors until final inode release. Native tests cover standalone
  and archive-member descriptors through descriptor close and shared-mapping
  release; the shared Node/OPFS guest test checks deferred metadata retention
  without fetching the file. The red evidence is in
  `.context/persistent-deferred-orphan-{native,node}-before.log`.
- [x] Reserve additional logical blocks before accepting each bounded write
  chunk or publishing a namespace transaction. Charge only accepted bytes on
  short writes; release allocations after a successful truncate or final inode
  release. A failed mutation must preserve both visible state and accounting.
  Per-file format limits are now checked before accepting growth, including
  short writes at the limit. Ordinary persistent writes now plan at most 64
  blocks at a time, querying visible data and indirect-pointer ranges without
  collecting a file-sized allocation list. They charge only accepted bytes,
  allow overwriting existing blocks when full, and return a short prefix or
  `ENOSPC` before allocating beyond the mounted ceiling. This also covers
  previously sparse blocks in fixed-overwrite mode. A cached live block total
  is advanced by successful writes and committed namespace changes, and
  invalidated by truncate, final inode release, and verified-file
  materialization; a cold query still scans the live filesystem with bounded
  scratch. It is not yet a
  fully incremental namespace/truncate allocation ledger. Native tests cover
  full disks, shared single/double/triple-indirect groups, unaligned writes
  spanning cache chunks, a sparse tail beyond 9 GiB, strict journal recovery,
  and cached-versus-recomputed accounting. Fresh ABI 51 artifacts passed
  3,059 Rust workspace tests, 205 Node checks, 27 OPFS/demo cases across
  Chromium/Firefox/WebKit, and 64 selected persistent-reboot Sortix cases.
  The shared Node/OPFS guest workflow fills the logical disk, checks that
  overwrites still work while growth fails, truncates to reclaim space, and
  continues through hard-link, inode-limit, strict reboot, and checkpoint
  acceptance. Browser acceptance also covers larger-than-memory positioned
  images, shell checkpoint/recovery, and WordPress SQLite/MariaDB post/upload
  recovery. The native red test previously accepted 11 data blocks with only
  10 free, and the old Wasm guest incorrectly completed the oversized `dd`;
  both now pass the corrected expectations. Evidence is in
  `.context/persistent-write-admission-{before,node-before,workspace-final,node-final,sortix-final,abi-final}.log`.
  The final build is `persistent-write-admission-artifacts-1017-183938-f686`,
  and the browser job is `persistent-write-admission-browser-1017-184639-ac6a`.
  Artifact hashes are recorded in
  `.context/persistent-write-admission-artifact-sha256.txt`.
  Namespace preflight now calculates the exact packed-directory delta, new
  inode content, and allocations retired by the transaction, retaining open
  or mapped victims. Deferred metadata and archive descriptors are reclaimed
  only after their final live reference. The projected usage is installed in
  the cache only after both the journal and live namespace changes succeed.
  A full-disk cross-directory rename may reuse the block freed in its source
  directory; a rejected creation or hard link changes neither names, link
  counts, timestamps, nor journal bytes. Partial sparse truncation now tests
  whether its boundary block exists before journaling its zeroed suffix, so
  truncating a hole cannot silently allocate data and indirect-pointer blocks.
  Native coverage includes image-backed and new sparse files beyond 9 GiB,
  a disk-full checkpoint, balanced directory rename, and differential cache
  checks through deferred hard links and open/mapping lifetime. All 3,063 Rust
  workspace tests pass. After the fresh ABI 51 artifact job
  `persistent-namespace-admission-artifacts-1017-191057-247b`, all 205 focused
  Node checks, 27 Chromium/Firefox/WebKit OPFS/demo cases, and 64 selected
  persistent-reboot Sortix cases pass, along with the ABI snapshot check.
  The shared guest workflow rejects full-disk directory, long-symlink, and
  directory-growing hard-link creation, then verifies successful reuse after
  reclamation. It also checks that shrinking and regrowing a sparse file beyond
  9 GiB on a full disk does not consume blocks. The browser job is
  `persistent-namespace-admission-browser-1017-192036-be7a`. Logs are
  `.context/persistent-namespace-admission-{before,node-before,workspace-final,node-final,sortix-final,abi-final}.log`,
  with the sparse-truncate red evidence in
  `.context/persistent-truncate-hole-before.log` and artifact hashes in
  `.context/persistent-namespace-admission-artifact-sha256.txt`.
  Mapped exhaustion and retry acceptance is recorded below. The current
  logical-capacity audit is recorded at the end of this section; overall
  release, crash-handoff and performance acceptance remain separate gates.
  The verified-read implementation now preserves persistent deferred-file and
  archive-member descriptions instead of converting a read into embedded disk
  content. Rust authenticates a whole file in 1 MiB windows, retains at most
  8 MiB of chunk-digest tables across 64 files, and caches at most four 1 MiB
  data chunks. A later chunk fetch must match its authenticated digest before
  bytes are exposed. Table eviction requires a new whole-file verification;
  objects exceeding the table budget use a bounded verified-window fallback
  rather than allocating a file-sized table. That fallback rehashes the object
  for each read and has no throughput acceptance yet. Rejecting a URI clears
  all dependent verification proofs so mmap prefetch still parks for a new
  fetch. Archive raw bytes, directories, and decoded members now use shared
  ownership rather than repeated full clones, but those archive caches,
  caller-owned closed assets, and URI metadata still need aggregate bounds.
  Native coverage verifies unchanged free space and deferred checkpoint
  metadata, authenticates bytes after chunk eviction and transport changes,
  checks URI-sharing prefetch invalidation, and enforces cache/table budgets.
  All 3,070 Rust workspace tests, 354 focused Node checks across 13 files,
  27 OPFS/demo cases across Chromium/Firefox/WebKit, 64 selected
  persistent-reboot Sortix cases, and the ABI snapshot check pass. The Node
  scope includes 84 profile/browser-host units. Node and BrowserKernel now
  expose a lower-only `kernelMaxPages` budget
  override; the shared real-guest workflow reads a 96 MiB verified file with
  a 64 MiB kernel ceiling and an 8 MiB logical disk. Artifact job
  `persistent-verified-read-artifacts-1017-203010-a285` succeeded. Browser job
  `persistent-verified-read-browser-1017-203848-b29c` passed all 27 cases,
  including shell checkpoint and WordPress SQLite/MariaDB post/upload recovery.
  An additional three-engine capacity rerun records kernel memory after fill,
  strict recovery, export, and checkpoint; the Node test records the same
  measurements. Each phase runs in a fresh kernel. End-of-phase linear-memory
  sizes are identical on Node, Chromium, Firefox, and WebKit:

  | Phase | Kernel pages (64 KiB each) | Kernel linear memory |
  |---|---:|---:|
  | Fill, including the complete 96 MiB verified read | 277 | 17.3125 MiB |
  | Strict recovery and verified read | 221 | 13.8125 MiB |
  | Export | 37 | 2.3125 MiB |
  | Checkpoint boot and verified read | 221 | 13.8125 MiB |

  These measurements are not whole-process RSS or a host/archive memory bound.
  The original fixture retained the 96 MiB source in host buffers; the current
  fixture uses a streaming server and disposable positioned byte storage. They
  establish a kernel-memory boundary, not workload throughput or overall
  production readiness. Logs are
  `.context/persistent-verified-read-{workspace-final,node-final,browser-final,sortix-final,abi-final}.log`;
  `.context/persistent-verified-read-memory-browser.{log,json}` records the
  instrumented three-engine rerun and attachments, and
  `.context/persistent-verified-read-kernel-memory.json` extracts those values.
  `.context/persistent-verified-read-artifact-sha256.txt` records artifact hashes.
- [x] Preserve the mounted logical ceiling during persistent checkpoints.
  The persistent writer preserves the mounted inode capacity independently of
  the block geometry, while the general builder retains its capacity floor.
  Overcommitted legacy data refuses a checkpoint with `ENOSPC` without changing
  the journal. A separate Rust query reads the immutable loaded ceiling rather
  than sizing a prospective builder export. Native tests cover a nonstandard
  inode capacity and immutable source capacity after builder-option changes;
  Node and OPFS tests compare checkpoint ceilings and recover an inode-full
  snapshot under a fresh journal.
- [x] Exercise logical exhaustion and reclaimed space through Node and OPFS
  guest syscalls, including sparse files larger than memory, shared mappings,
  unlink lifetime, failed journal writes/flushes, checkpoint, and strict reboot.
  Physical host quota remains a separate possible source of `ENOSPC`.
  Mapped-writeback errors now retain their actual errno through Rust's page
  writer, backing flush, selected-file flush, and process/range publication.
  The host forwards the kernel's negative errno for `msync` and failed
  `MAP_FIXED` publication rather than replacing it with `EIO`. Dirty pages
  remain available after failed or partial writes. Native tests cover
  `ENOSPC`, `ENOMEM`, `EROFS`, `EIO`, accepted prefixes, and successful retry;
  3,065 Rust workspace tests and 59 focused host mapping tests pass.
  A real guest regression previously received `EIO` instead of `ENOSPC` from
  full-disk `msync`. Its expanded fixture fills the disk separately for
  `msync`, `fsync`, and `fdatasync`, reclaims space through another descriptor,
  retries the operation, and checks sparse bytes beyond 9 GiB after reboot
  and checkpoint. Fresh ABI 51 artifacts from
  `persistent-mapping-errno-artifacts-1017-194323-617c` pass 3,065 Rust workspace
  tests, 270 Node checks across 11 files, 27 OPFS/demo cases across Chromium,
  Firefox, and WebKit, and 64 selected persistent-reboot Sortix cases. The ABI
  snapshot/version check also passes. The Node scope includes host mapping
  units and file/shared/tracking/coherence regressions as well as persistence
  integration; the browser scope retains the large-image, shell, and WordPress
  SQLite/MariaDB post/upload recovery workflows. The browser job is
  `persistent-mapping-errno-browser-1017-195121-d5de`. Evidence is in
  `.context/persistent-mapping-errno-{native-before,node-before,workspace-final,node-final,sortix-final,abi-final,browser-final}.log`,
  and `.context/persistent-mapping-errno-artifact-sha256.txt` records the kernel,
  demo image, and updated guest-fixture hashes. These are focused acceptance
  results, not the full fault-matrix, memory, performance, or release audit.

### Logical-capacity acceptance audit

The 2026-10-18 audit closes the logical-capacity gate against the current
implementation, not against a generic passing-suite count. The mounted
filesystem's block and inode ceilings remain separate from its container
length, kernel memory ceiling, metadata quota and physical host quota.

| Requirement | Implementation | Checked assertions |
|---|---|---|
| Bounded allocation accounting | `rootfs::persistent_statfs`, per-inode allocation totals and bounded composed-allocation queries | Cold and cached totals agree; dense, sparse, deferred and wide-directory usage agrees with actual checkpoints; no file-sized allocation list is needed. |
| Reserve before growth and charge accepted prefixes | `rootfs::plan_persistent_write`, `write_persistent_file`, `commit_persistent_namespace` | Native tests cover 64-block chunk boundaries, unaligned partial tails, shared indirect-pointer groups and fixed-mode sparse growth. The real guest fills the disk, rejects new allocation and still overwrites allocated bytes. |
| Namespace failure is atomic | Namespace projected usage and journal transaction preparation | Full-disk mkdir, symlink and directory-growing hard link leave no new name; balanced cross-directory rename can reuse released blocks. Injected storage failures preserve rename, link, unlink and truncate state through strict recovery. |
| Reclaim only after final reference | `truncate_handle`, `RootfsState::maybe_free`, mapping pins | Native tests retain blocks and inode slots through final mapping release. The real guest retains unlinked data/deferred metadata until final descriptor close, then reuses the space. Shrinking and re-extending holes does not allocate them. |
| Enforce inode capacity | Mounted inode geometry and `require_image_inode_slot` | Regular, directory, symlink and special-node exhaustion rejects creation without a journal change. Hard links reuse an inode; final close permits reuse. Full-inode state survives strict reboot and checkpoint. |
| Enforce representable file sizes | Rootfs write/truncate format-limit checks | Native and real-guest tests reject excessive truncation, accept only the representable prefix at the boundary, and preserve the last byte after recovery/checkpoint. |
| Preserve checkpoint geometry | Persistent export uses mounted capacity and inode geometry | Native tests retain a nonstandard inode table and reject an overcommitted legacy checkpoint without journal changes. The same legacy test reopens its overcommitted journal and reads the committed tail. Node compares source/checkpoint capacity; guest checkpoint boot remains inode-full. |
| Preserve mapped error and dirty state | Kernel file-mapping writes route through rootfs admission | The real guest independently fills the disk for `msync`, `fsync` and `fdatasync`, observes `ENOSPC`, reclaims space, retries, and verifies bytes beyond 9 GiB after reboot/checkpoint. Native tests also preserve `ENOMEM`, `EROFS`, `EIO` and accepted prefixes. |

Fresh acceptance on the unchanged ABI 51 kernel/image artifacts passes the
shared Bash/coreutils/C capacity workflow on Node and Chromium, Firefox and
WebKit. The Node selection passes one case with seven other statistics cases
filtered; the browser selection passes all three cases without retries,
skips or flaky results. A separate current run passes the complete 83-case
Node persistence file and all 138 three-engine injected-quota cases, covering
write, flush, eviction, short/partial records, mapped sync and atomic namespace
and truncate failures. Thirteen artifact hashes and twelve implementation/test
source hashes remain unchanged before and after that run. The previously
accepted 3,158 native workspace checks include the assertions above.

Evidence is `.context/persistent-capacity-audit-node.log`,
`-browser.{log,json}`, `-node-faults.log`, `-browser-faults.{log,json}` and
`-artifact-{before,after}.log` / `-source-{before,after}.log` under the same
prefix. The fault job is
`persistent-capacity-audit-faults-1018-161015-f58a` (successful, 6m13s).
The browser capacity attachments report kernel pages `[276,219,37,221]` for
fill/recover/export/checkpoint; Node reports `[293,219,37,221]`. These are
linear-memory observations, not whole-process RSS or throughput acceptance.

This closes logical allocation enforcement only. Actual physical OPFS quota
pressure, whole-system memory bounds, crash/handoff cleanup, performance and
full current-product release acceptance remain open. The storage failures
above are injected; they are not evidence of physical quota exhaustion or
OS power-loss durability. The composed shell and WordPress image closures
still require rebuilding and matched final acceptance.

## Indexed generation status and next format boundary

The current checkpoint is an immutable, sorted, checksummed table stored
next to each journal generation. Positioned lookup uses bounded inline and
supplemental page caches; admitted in-memory state holds mutations appended
since that checkpoint. The seal binds the base, table and journal prefix,
while native recovery validates replay sequence and canonical record locations.
It does not rebuild a resident map of every indexed block. An activated
generation whose table, seal or acknowledged journal is damaged fails closed;
it must not silently revert to a prior valid but stale generation or reset the
computer. Incomplete unactivated targets do not replace the acknowledged source.
Older browser-envelope migration is excluded from this goal, as specified
under Format scope; ordinary VFS image imports remain supported.

A fixed-block checkpoint table now writes sorted block locations without
materializing an index copy, binds their checksum to the base and exact
journal prefix, and verifies all records on open. Checkpoint 1.25 adds at most
32 supplemental 4-KiB pages, admitted within the shared ordinary I/O budget,
to the existing inline pages for binary-search lookups. The kernel builds
the table during compaction by
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
still scans the entire prefix. Removing that scan safely requires a different
admission/proof boundary: consumed index and journal bytes must remain
authenticated to the exact activated generation, and malformed references,
ordering, freshness and tail commits must retain their current refusal
semantics. A valid checksum over arbitrary bytes alone is not proof of native
semantic validation. This is unfinished fast-boot work, not a reason to remove
checks from the existing format. Live
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
generations remain; the fourth `g3` slot allows conversion while all three
earlier slots remain sealed. When every discovered slot is occupied by a
verified generation, conversion allocates the next numbered `gN` slot rather
than overwriting an unproven fallback or mounting the old full-map checkpoint.
Node and OPFS workers discover numbered generation files on boot, and the
source-bound seal encodes their slot number without changing existing seals.
Interrupted conversion leaves earlier journals and seals untouched. Normal
compaction continues to rotate through `g0`–`g2` and uses `g0` after an active
spill-slot migration. A semantically rejected slot may be reused after its
rejection. Node and Chromium, Firefox, and WebKit reboot fixed v1
and resizable v2 sources through this upgrade; two-valid-slot fixed v1 and
resizable v2 cases reach `g2` on all four hosts. Three-valid-slot fixed v1
and resizable v2 cases now reach `g3` on Node and all three browser engines;
Node reboots the migrated generation, and host tests compact it back to `g0`.
Host fault tests leave all earlier sources intact across an interrupted
conversion into `g4` or `g5`. A Node guest migration and Chromium, Firefox,
and WebKit OPFS guest migrations use explicitly restored older sealed slots
to convert a four-slot fixed v1 source into `g4`, then reboot it; Node also
compacts that `g4` generation back to `g0`.
Staged browser replacement cleanup discovers and removes numbered spill files.
After a successful boot conversion into `g3` or a later slot, the host has
mounted the new target and validated its source. It keeps those two copies,
flush-invalidates older seals, and removes their files before guests start.
Node and all three browser engines verify that a `g3` conversion retires `g0`
and `g1` while retaining `g2`; a host fault test preserves the new target and
source after interrupted retirement.
Generation-one seals made from a legacy journal now include its SHA-256
digest (seal version 4), read in bounded chunks. Boot rejects that generation
if a still-present legacy journal changes even without changing length; old
version-3 seals remain readable and keep their length-only source check. A
source superseded by changed journal bytes also invalidates its sealed
descendants, preventing boot from selecting an image derived from that source.
An absent legacy file alone does not invalidate a later sealed descendant of
an old version-3 source. After a version-4 generation has
been compacted into a second sealed generation,
the host verifies the legacy source again, truncates and flushes it, then
removes it. The two sealed generations remain available for recovery even if
retirement is interrupted. Chromium, Firefox, and WebKit verify retirement
and fallback to the first sealed generation after damaging the second seal.
Old version-3 sources are not retired automatically.
Node and all three browser engines verify that a four-slot fixed v1 migration
removes `g0`–`g2` at boot while retaining `g3` and the new `g4` generation.
An injected boot-retirement removal failure leaves both copies selectable;
cleanup errors do not turn a mounted target into a failed boot.
After a live compaction with a discovered spill slot, the host retains the
newly active generation and its semantically mounted source fallback, then
invalidates older seals with a flush before removing their checkpoints and
journals. A failed retirement is reported but does not roll back activation;
the invalid seal prevents a partially removed generation from booting. Node
and all three browser engines compact a `g4` generation back to `g0`, remove
older `g1`–`g3` files, and reopen the guest state. Node and host fault tests
also damage the new target and recover from the retained `g4` source. Host
fault tests stop retirement at seal truncate, seal flush, and journal removal;
the active target and retained source remain available. The
ordinary three-slot compaction ring remains bounded without retirement.
If the kernel rejects a converted target with `EIO`, the host invalidates its
seal and tries the unchanged source before an older generation; a failed
source mount can still fall back normally. Host fault coverage checks that a
target-only rejection does not silently roll the computer back. Recovery also
remembers verified but stale or semantically rejected higher-generation slots:
the next conversion or live compaction reuses their slot for the same sequence
number instead of sealing a duplicate generation elsewhere. Host tests cover
both rejection and a source journal that grew after its target was sealed,
including several consecutive live compactions and a failed legacy conversion.
Reusing a slot also clears any older reuse hint for that physical slot, so a
later compaction cannot overwrite its active source.
Conversion needs quota for the temporary sorted references and target journal;
an `ENOSPC` failure does not publish the target or discard the source. Boot
now mounts that source instead of requiring conversion space; if the automatic
compaction also runs out of space, it reports a diagnostic and continues with
the source. A quota error after activation is attempted, or any non-quota
storage failure, still aborts boot rather than assuming the source is active.
Host fault tests cap the conversion journal, index, and seal separately and
cover an indexed source; after each `ENOSPC`, the source remains selectable,
and conversion succeeds when the cap is lifted. Chromium, Firefox, and WebKit
inject a shared 128 KiB growth budget across target OPFS generation files.
All three boot the guest-written legacy journal, observe deferred compaction,
durably write through `mmap`/`fsync` while it is deferred, and convert that
new state after space returns. A failed conversion now flushes seal invalidation
before truncating its partial target journal and index to reclaim quota. A
reclamation failure is reported but does not hide a valid source; failed seal
invalidation still prevents fallback because target safety is uncertain.
Failed pre-activation compaction uses the same order: flush seal invalidation,
cancel any prepared kernel handoff, then truncate and flush the partial target
journal and checkpoint. A reclamation failure is reported without replacing the
original quota error; failed seal invalidation or handoff cancellation prevents
target reclamation. Host fault tests cover each write/flush cut and a failed
reclamation step.
Chromium also uses its quota-manager override to cap the origin at current
usage plus 1 KiB, without replacing OPFS methods. Conversion and boot
compaction defer; a guest `pwrite` remains readable while `fsync` reports
`ENOSPC`. After the override is removed, reboot recovers the preceding synced
bytes and converts the intact source. This browser-enforced quota path passes
three consecutive runs. A second Chromium override with 256 KiB of headroom
also defers conversion on `ENOSPC`, keeps the source journal unchanged, and
leaves the target journal, index, and seal empty after cleanup; restoring the
quota permits a later conversion. It passes three consecutive runs. Native
disk exhaustion and Firefox/WebKit quota enforcement remain untested.
Peak resident memory and conversion latency on a near-capacity image remain
unmeasured.
A boot-only conversion into `g3` now retains its source `g2` while retiring
older `g0` and `g1` generations before guests start. Version-4 legacy seals
allow the unsealed legacy journal to be retired after a second sealed copy is
active; version-3 legacy sources remain untouched. After an interrupted
retirement, a later verified sealed boot retries removal of older orphaned
generation files while retaining the active generation and its source. It also
removes an empty legacy journal left by a failed unlink; a nonempty legacy
journal is not deleted without another semantically validated handoff. Node
and Chromium, Firefox, and WebKit reboot with injected orphan files; the three
browser engines also remove an injected empty legacy file before serving
guests. Host fault tests keep boot available when the retry itself fails.
Browser crash-cut tests now stop conversion immediately after flushing the
target journal, checkpoint index, or seal, then reboot the same OPFS profile.
Chromium crashes the browser process; Firefox and WebKit close the tab and its
blocked worker. All three recover the synced guest bytes from an oversized
legacy journal at all three cuts, with the original journal present at its
pre-crash length. Each recovered computer commits another guest write and
strictly reboots with that new state. These tests cover browser-process and
tab termination, not OS power loss or storage-device flush guarantees.
An in-memory host fault test now shares one quota across five sealed
generations. A compaction that needs more space fails with `ENOSPC` while the
active and source generations stay selectable; boot cleanup reclaims three
obsolete generations, and retry compacts and reopens under the same quota.
A Chromium persistent-context test now applies the browser's origin quota
override with only 4 MiB of headroom during an oversized four-slot fixed
checkpoint conversion. The kernel mounts the new indexed generation, retires
the two older slots, keeps its source fallback, and later compacts and reboots
after the override is removed. Firefox and WebKit pass the same workflow
without an enforced quota. The in-memory budget does not model OPFS quota
accounting, and this browser case does not force retirement failure. Near-quota
retry under unchanged browser quota, Firefox/WebKit quota enforcement, and
storage-device flush ordering remain untested.
Numbered spill slots remove the fixed four-slot recovery exception, but these
remaining cases keep generation storage reclamation open.

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
version 1/2 generations and fully occupied four-slot cases still use the
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
or fully occupied four-slot cases retain their older recovery path. Node and
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
Graph validation also uses one byte of parent/reachability flags per known
inode instead of separate ordered maps for parent counts and reached
directories; a disconnected directory-cycle regression checks rejection.
Replaying explicit metadata changes on base-image inodes now resolves their
numbers through a sorted vector rather than allocating a tree-map node for
every resident base inode. A guest changes and verifies base-file mode and
times after reboot through a surviving hard link, and through the original
name across oversized resizable-journal conversion on Node and Chromium,
Firefox, and WebKit. This changes scratch representation, not the fact that
its entry count scales with resident inodes; allocation and boot-time effects
have not been measured.
The remaining scratch structures and resident rootfs tree still scale with
file count; peak boot memory is not yet measured. Data-only or
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
commit and retained after failed writeback. It now holds at most 64 distinct
inodes: before a write or truncate would dirty a 65th, the kernel flushes the
existing data and timestamp records. A failed flush refuses that new mutation
and preserves earlier dirty data for live reads. Rust tests cover both write
and truncate boundary flushes and a failed writeback, including `O_TRUNC`
refusing to discard the last clean file; a guest creates
and syncs 65 files, then strictly reboots on Node and Chromium, Firefox, and
WebKit. The cost of these implicit flushes and the resident namespace tree
still need measurement on a large file-count image. Session-injected files
such as the browser CA bundle are not journal-backed and are deliberately
excluded from timestamp writeback; they are recreated at boot. Namespace
transactions now include parent
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
handoff; browser-process crash and power-loss recovery remain open. The image writer coalesces
adjacent deferred content blocks into extents: a 32 MiB file occupies fewer
than 20 extent records while reads across direct and indirect boundaries
return the expected bytes. At this earlier stage, unallocated bitmap and
inode-table pages emitted as zeros without residing in kernel memory; an
8 GiB possible-capacity image with 40 created files kept one page per bitmap,
two inode-table pages, and less than 128 KiB of counted writer metadata.
The later implicit allocation-prefix milestone above removes the remaining
resident bitmap buffers. Indirect blocks still grow with file size. Writer
operations reject unallocated inode IDs
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
at that stage its resident block-bitmap prefix still depended on maximum
capacity, before the implicit-prefix change above;
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
