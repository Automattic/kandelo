# Future Improvements

Technical debt, deferred enhancements, and explicitly documented conformance
gaps. Listing an item here does not imply that the current behavior is fully
supported.

## Browser workspace presentation

The More menu, community links, structured image-progress rows, arbitrary
guest website picker and terminal preview command are documented in
[Browser support](browser-support.md#arbitrary-guest-websites).

### Discover guest listeners without image declarations

An optional listener inventory for Open website should come from authoritative
kernel socket state, not preset names or host port scanning. Respect bind
addresses and connected network membership; do not expose every listener
automatically or imply a public URL or browser-origin isolation.

### Extend structured progress to Rust-internal filesystem checks

The current presentation coalesces explicit host image-progress records while
retaining raw diagnostics. Kernel-internal checks without structured counters
remain ordinary messages. Add stable operation identities and true counters
at those producers instead of guessing percentages or hiding text patterns.
Keep warnings/errors and the bounded raw log available.

### Acknowledged preview requests without a UI terminal

`kandelo-preview` emits a request through the terminal extension; its exit
status cannot acknowledge asynchronous server readiness. A future guest UI
portal could serve detached processes and return an explicit bounded response.
It should not parse ordinary stdout or turn an unimplemented host capability
into apparent success. Keep Node/browser capability boundaries explicit.

### Exchange late peer-connection candidates

`web-libs/kandelo-session/src/peer-connection.ts` currently publishes a single
session description after a maximum three-second ICE gathering wait. Candidates
found later are not exchanged. Preserve bounded startup, but add bounded,
generation-owned incremental candidate signalling or explicit complete-gathering
admission with a timeout. Cover late candidates, cancellation, stale sessions,
and both peer roles. This is not an established cause of the reported
Firefox-to-Chrome failure: a plain WebRTC probe also failed, and the user's
local-network permissions were disabled. Do not request microphone access or
disable browser privacy protections as a substitute for data-only networking.

Activity data also needs progress-aware, bounded transfer scheduling. The
current 16 KiB stop-and-wait protocol needs 556 exchanges for the 9,094,045-byte
Quake shareware archive, against one 120-second preparation deadline. Consider
bounded pipelining and separate setup, inactivity and total-work budgets.
Correlate requests and responses across cancellation/retry: a late old binary
reply must not satisfy a new handshake. Keep exact size and digest checks.
These are concrete protocol follow-ups, not a diagnosed cause of the reported
Quake join failure, which the current exact-link probe reaches before transfer.

## Filesystem checkpoints and restore

Consider named, user-managed checkpoints of a computer's filesystem that can
be browsed and restored later. This is possible future work, deferred from
the current persistence release. Continuous persistence must not require a
manual checkpoint, and filesystem checkpoints would not capture running
processes or their memory.

Design the user workflow and consistency guarantees before implementation.
Explore restoring into a new computer so the current state remains available.
Define how writers are quiesced and flushed, what database consistency is
promised, and how a failed restore preserves the original computer. Keep the
storage policy shared by browser and Node hosts, with appropriate controls
for each host. Bound retained checkpoints and prevent journal compaction
from reclaiming data still referenced by one. Browser-local checkpoints
alone would not protect against origin eviction or device loss.

## ABI modeling and package provenance

### Keep program build inputs separate from kernel-host changes

Program ABI 55 and its exact supported digest remain unchanged across the
adapter-4 launch work, but normal package resolution still selected new build
generations for the canonical rootfs dependencies. Investigate which shared
SDK, resolver and generated-metadata inputs cause that invalidation. Preserve
all real compiler, libc, instrumentation and program-admission inputs; do not
drop verifier code or accept a stale projection merely to obtain cache hits.
Prove a kernel-host-only change leaves eligible program keys unchanged while
a program-contract or relevant build-tool change still invalidates them.
This is build reuse work, not evidence that existing program bytes became
incompatible or permission to restamp old artifacts.

### Advisory closure memo selection authority

The artifact preflight memo now includes retained originals and file metadata,
but remains an advisory build optimization, not execution authority. Audit
reuse when a different provenance tier, registry context or canonical package
generation becomes selected while old immutable files remain available.
Unchanged stamps on those old files do not by themselves establish the current
selection or its ownership receipts. Bind any stronger memo to the complete
native selection authority and cover retargeting, replacement and corrupted
receipts. Fresh native product resolution remains required for acceptance.

### Stable userspace ABI and durable computer upgrades

The product direction is to prioritize a supported stable userspace ABI so
saved computers, including user-compiled programs, can survive application
releases without an archive of every previous kernel and host build. The
initial ABI-55 baseline and frozen-program test gates are implemented; the
complete supported upgrade path is not.
The user approved shipping persistence and its UX first with a prominent
release-bound storage warning. Transactional upgrades and long-lived executable
compatibility are follow-up work, not implemented first-release guarantees.
Agree on the supported baseline and upgrade design before changing admission
policy. Current admission binds programs to both the
program ABI version and its program-surface snapshot digest; kernel-host-only
changes no longer invalidate that digest. Even compatible additions to the
program surface can still require rebuilt programs under exact-digest admission.
Choose an explicit supported baseline and compatibility scope rather than
promising to revive every historical prototype ABI.

The [persistent-program compatibility contract](persistent-program-compatibility.md)
records the implemented format checks and opt-in original-Wasm retention and
re-preparation prototype, along with the remaining transactional-upgrade gates.
The current iteration replaces packaged binaries rather than preparing them at
runtime. User-built forking programs may require rebuilding; their unfinished
instrumentation contract is not promised stable. Automatic preparation and
mandatory original retention are not current release requirements.

The future stage accepts uninstrumented user programs, prepares on demand and
retains protected originals associated with their executable identity and
permissions. An incompatible fork-contract upgrade restores the original and
invalidates derived instrumentation, then prepares again on next use. Eager
preparation is optional. Do not expose execute-only originals through a public
directory, discard user edits, or confuse this prototype with an implemented
automatic upgrade path.

Define independently versioned compatibility boundaries for persistent disk
formats, the userspace ABI, fork instrumentation and loader requirements, and
the kernel-host adapter. Build provenance should remain verifiable without
being confused with a proven incompatible interface. Do not simply remove
the current digest check or relabel incompatible binaries. Establish a
compatibility test corpus of released programs and supported transitions
before admitting them under a new policy.

For packaged software, investigate explicit crash-safe upgrade transactions:
stage verified replacements, reconcile configuration and package ownership,
atomically commit the new system state, and retain rollback until verification.
Preserve user data and make application-specific database migrations explicit.
Quiesce affected processes before activation. If a migration changes data,
rollback needs the matching data state, not merely the old executable files;
do not advertise a safe rollback after an irreversible schema change.
An immutable foundation plus writable state is worth comparing with
package-owned updates, but a transparent whole-root overlay does not repair
an executable ABI mismatch. Whiteouts, modified system files, hard links,
configuration merges, and database schema changes need a defined policy.
The existing persistent journal is bound to its base image and inode/block
identities; it is not a package-level overlay that can safely be replayed on
an arbitrary replacement foundation. Keep those checks. Prefer evaluating
filesystem-level package operations against the current disk before adding a
new root-layer/rebase mechanism with its own identity and merge semantics.

Upgrade acceptance also needs a same-origin reopen test across two real app
builds, not just a page refresh of one build. Saved descriptors and lazy
package references must not become unusable when the app's hashed asset
names or product map change. A stable ABI alone cannot recover an unfetched
archive that its publisher has removed. Define retention for immutable
package artifacts, local materialization, or an explicit managed-package
upgrade before claiming long-lived availability or offline support. Test
previously fetched and never-fetched programs independently, and preserve
user-modified files rather than silently treating them as replaceable packages.

Separating guest web previews onto another origin protects a browser trust
boundary; it does not make old image-supplied privileged host scripts safe
to run on the storage-owning application origin. Loading archived runtimes
would add maintenance and trust obligations and is not the preferred design.
Incompatibility must never silently reset or delete a saved computer.

### Model semantic ABI transitions in Rust-owned machine-readable data

The checked-in structural ABI snapshot detects covered layout, number,
marshalling, export, and generated-protocol changes, but it cannot prove that
an existing syscall retained the same argument meaning, errno space, blocking
and restart behavior, memory effects, fd/OFD effects, process and signal
effects, or inheritance rules. Tests reduce this risk but are not semantic
classification authority, and developers must not classify a change as
"implementation-only ABI" by declaration.

As more host/kernel behavior moves from TypeScript into Rust, define a
canonical Rust semantic ABI model whose typed primitives describe observable
state transitions. Generate structural metadata and TypeScript protocol views
from that model, restrict ABI-owned mutations to modeled primitives, normalize
and compare old/new transition models automatically, and prove or exhaustively
model-check that implementations refine the declared model. Ordinary
differential and conformance tests should remain supporting evidence. Moving
code into Rust makes ownership and typed modeling easier; Rust by itself does
not provide the proof.

### Ship ABI-matched POSIX and Kandelo manual pages

Provide user-space manual pages for the POSIX interfaces Kandelo implements,
the explicit boundaries it does not yet implement, and Kandelo-specific tools
and runtime configuration. Generate or select the pages through the same
ABI-qualified product inputs used to build VFS images so documentation cannot
silently describe a different kernel contract. Package the pages as normal
VFS software with content-addressed provenance rather than embedding a
browser-only help copy.

This is separate from the ABI-staging MVP. The initial work should inventory
upstream POSIX/man-page licensing and source roles, decide which pages are
generated versus imported, and add a basic `man` smoke test in Node and the
browser product that ships them.

### Separate source-only contracts from artifact resolution

Release-inventory review found otherwise source-testable contracts whose
import closures reach the binary resolver, sometimes through type-only
imports or repository-path helpers. The protected source-only checker
correctly refuses those closures; classifying the tests as prepared
preserves coverage but unnecessarily couples them to artifact provisioning.

Extract artifact-independent types/models and repository-path helpers
from artifact-resolution modules where appropriate. Reclassify only after
the canonical import guard and isolated source-only run pass; do not weaken
the guard or treat a mocked call as removal of an imported dependency.
Current examples include destroy-progress subscriptions, kernel-realm
destruction, and session demo-config/gallery/tracked-demo contracts.
The WebMCP launch test also retains a stale erased type import from the
removed session `gallery` module. Prepared classification keeps that test
enabled but does not repair the type path; resolve it during contract/test
maintenance before restoring source-only admission.

### Detect source and ABI changes during long build plans earlier

Persistence development exposed late failures when a running source-only
build plan outlived changes to its kernel inputs or ABI snapshot. The snapshot
participates in library/program cache identities; a source edit can also
invalidate a documentation package's kernel prerequisite. A plan that was
valid when started can therefore finish substantial independent compilation
before rejecting its prerequisite or final program-authority receipts.

Consider an explicit immutable input snapshot or an early input-change check
before scheduling further nodes and publishing the projection. Report the
changed contract and preserve valid completed cache entries for a fresh plan.
Do not bypass provenance checks, restamp stale sealed packages or silently
mix projections to salvage the old plan. Separately evaluate whether any
cache-key granularity can safely distinguish guest and host ABI additions;
that requires compatibility evidence, not just a desire to avoid rebuilding.
Observation timeouts alone are not evidence that a build stopped or needs
replacement.

## Kernel

### Define generic noexec mount policy before exposing it

The source/prepared-image exec audit confirms that the current mount-flag
contract declares `ST_NOSUID`, but no `ST_NOEXEC` flag or generic noexec
admission policy. Keeping mount metadata unchanged is not enforcement of a
policy the kernel does not implement. Do not describe noexec as supported.

If noexec mounts are introduced, resolve policy from the actual retained
source backend for pathname exec, saved-descriptor exec and spawn. A procfs
executable link or derived image's storage mount is not source authority.
Check the policy before spawn file actions and revalidate it before commit.
Add Node/browser tests and treat any program-visible constants or behavior
as an explicit supported-ABI decision, not a paired-executable workaround.

### Close the remaining epoll completeness gaps

Completeness is a core Kandelo feature and a platform advantage. Exposed
interfaces should provide faithful semantics across processes, guest widths,
and Node/browser hosts. Track missing behavior as platform work with explicit
completion criteria. Passing a port's exercised paths is supporting evidence;
the full supported interface contract remains the goal. Epoll is a Linux
extension, alongside Kandelo's broader POSIX conformance work.

The [epoll contract and behavior matrix](epoll.md) records the implemented
semantics and current gaps. Complete the following work:

- **Expose `epoll_pwait2` through the normal platform path.** Add both SDK
  targets' headers and libc wrappers, syscall assignment and metadata,
  marshalling, kernel dispatch, and Node/browser wait handling. Validate
  timespec precision, invalid arguments, null/infinite and zero timeouts,
  monotonic deadlines, interruption, cancellation, and atomic signal-mask
  restoration. Account for semantic and structural ABI changes normally.
- **Share inherited datagram and display-device readiness state correctly.**
  Move datagram queues and the mutable socket state that belongs to an open
  file description into shared backing. Give inherited Kernel Mode Setting
  (KMS) descriptors the correct shared event state instead of reconstructing
  an empty event ring on fork. Preserve process-owned state
  separately. Parent and child must observe the same queue mutations,
  shutdowns, readiness notifications, and final-owner cleanup through aliases
  and sibling-only retained descriptors. These are platform correctness gaps
  to fix, including their effects on poll and epoll.
- **Complete notification history for supported network adapters.** Define
  and validate the adapter contract for real receive/send notifications,
  including arrivals while an object remains ready and drain/refill between
  waits. Provide reusable adapter conformance tests and add history wherever
  the backend can support faithful edge/exclusive delivery. Keep explicit
  `EOPNOTSUPP` for adapters that cannot provide it until that gap is closed.

Audit the remaining Linux facilities separately: suspend/capability behavior,
watch quotas, busy-poll controls, and entropy-pool readiness. Record which need
implementation and which have a demonstrated host boundary, with accurate
observable behavior. The current unprivileged no-effect `EPOLLWAKEUP` behavior
does not establish support for system suspend control.

Completion requires kernel and guest regressions, relevant conformance
coverage, Linux reference comparisons, and wasm32/wasm64 execution on Node
and Chromium, Firefox, and WebKit. Exercise cross-process queue consumption,
capacity edges, close/shutdown, one-shot rearming, exclusive waits, and cleanup.
Also validate an actual mio consumer once Kandelo target selection is added;
direct syscall probes alone do not establish that integration. Update the
behavior matrix and support status only after the corresponding evidence.

### Complete privileged inspection of kernel-generated virtual file bytes

The bounded file-read audit reproduces an existing host-inspection gap:
`readFileFromVfs("/proc/mounts")` returns `null` on the minimal checked-image
fixture even though native namespace stat recognizes procfs. The Rust
`inspect_namespace_read_file` dispatches bytes to tmpfs, rootfs or a foreign
host handle, but does not dispatch procfs to its existing native renderer.
Guest procfs reads have a separate implementation; this is not evidence that
guest reads fail or that procfs content should be stored in OPFS.

Complete that native dispatch and test host inspection against the same
authoritative virtual content as guest reads on Node and browser. Do not
synthesize procfs strings in TypeScript or treat a zero stat size as EOF:
generated files can produce nonempty content. Preserve ordinary-file bounds,
resource errors and namespace permissions. The bounded collector has separate
zero-size-hint and short-read coverage; that does not close this dispatch gap.

### Finish general resource admission and lifecycle hardening

The persistence memory audit exposed broader kernel and host ownership work.
These findings are not prerequisites for an OPFS byte-storage adapter or for
the next persistent WordPress checkpoint. They remain relevant to the broader
whole-system memory acceptance gate in [the durability contract](persistence-durability.md#release-acceptance-map).
This inventory records unfinished work, not demonstrated failures in every
listed path or a claim that existing admission limits bound total memory.

- **Packaged sudo versus demo account policy.** An ABI-54 in-memory WordPress
  control reaches a normal maker shell, but upstream sudo reports that maker
  is not in sudoers after stdin authentication. Inspect the actual passwd,
  group, sudoers and effective/supplementary credentials before attributing
  this to the image, libc or kernel. The sudo-lite fixture is a different
  program and cannot establish the upstream package's behavior. Do not grant
  passwordless access or change guest policy just to collect test logs; use
  the existing read-only Internals VFS inspector for diagnostics. This is an
  independent follow-up, not evidence of OPFS corruption or an established
  security vulnerability.
- **WebKit native memory reservation recovery.** The mixed persistent
  WordPress workload reached native constructor exhaustion even with the
  host's byte admission enabled. A final synchronous allocation attempt in
  the kernel realm then stopped independent worker-message delivery; private
  instrumentation placed the stall inside that attempt, after completed
  filesystem operations. Keep native construction in disposable workers and
  propagate refusal instead of retrying in the kernel realm. Investigate
  retired shared-memory wrappers and engine reservation accounting separately:
  modeled live bytes do not prove that JavaScriptCore can construct another
  memory. Do not raise ceilings, rely on finalizers for correctness, or report
  an allocation refusal as an OPFS corruption failure. After removing the
  fallback, normal three-engine post/upload recovery passes, but both larger
  WebKit workloads fail during guest mutations with process allocation errors.
  Sustained application acceptance is still open; returning a failure instead
  of stalling does not close native reservation recovery.
  The [native construction controls](measurements/2026-10-23-webkit-memory-construction.md)
  now reproduce reservation refusal without OPFS or substantial resident
  payload. Direct owner allocation passes that control and two real WebKit
  application workloads. The 1.33 source candidate removes factory selection
  after a separate read-only ownership review. Its rebuilt three-engine mixed
  workloads and both constrained-profile WebKit workloads pass, along with
  600 fork/exec churn cycles. Public 1.32 still uses the factory; 1.33 uses
  canonical construction. These scoped results do not promise a portable
  native allocation or collection deadline. Review
  earlier native-collection stalls and ownership before release; smaller
  ceilings merely postpone the synthetic failure.
  The [ABI 54 follow-up](measurements/2026-10-25-abi54-persistence-acceptance.md#liveness-follow-up-and-remaining-scope)
  captures a different post-maintenance HTTP failure while the latest memory
  constructor has completed and the kernel still answers independent echoes.
  Correlate guest-worker launch/exit and request progress before attributing
  a later stall to the earlier constructor hypothesis. Keep browser process
  ownership checks strict when native stack sampling cannot identify its target.
- **Resident nonpersistent file data.** Rootfs `Regular(Vec<u8>)` payloads
  grow through fallible `try_reserve` in `grow_file_bytes`, but are not charged
  to the shared storage-I/O ledger used by persistent caches and export plans.
  Include their retained capacity and growth overlap in the general resource
  accounting audit. This applies to nonpersistent roots and private image
  builder modifications, not persistent journal-backed file payloads. The
  composer now bounds patch-text inputs and configured-asset intake; those
  host intake limits do not establish native-wide file-data admission or
  aggregate process-memory acceptance. Preserve the distinction between an
  input limit, a memory budget and logical filesystem capacity.
- **Artifact metadata admission.** ABI marker reads no longer copy every
  function body; focused allocation regressions cover that removal. Full
  artifact-fact catalogs still retain signature, import/export and name
  collections. Shared signatures cloned for many imports can amplify a small
  input, so input/output byte caps are not an aggregate heap bound. Audit
  fallible metadata admission across ordinary artifact consumers separately
  from filesystem cache bounds. The new automatic-preparation service must
  use bounded checks or impose metadata admission before exposure; that is
  part of its release gate, not permission to defer its own work budget.
  Preparation binding now has a bounded scalar/index reader, including nested
  type-count, compact-import and ABI-operator quotas. Native tests deny every
  valid-input catalog allocation and check scalar refusal. The pinned parser's
  malformed-input diagnostics still construct an infallible String/Box; the
  accounting allowance is not an allocator reservation. Preserve this separate
  failure-containment/fallible-diagnostic work, rather than claiming that a
  passing valid-input allocator probe covers all malformed-input OOM paths.
  The general ABI/thread-marker reader also still uses an allocating operator
  control stack for its selected body; removing unrelated-body copies did not
  bound that stack. Preparation uses a separate metered SDK-getter grammar.
  Keep ordinary marker/catalog hardening separate from filesystem cache bounds.
- **Signal queues and handler state.** Process and thread signal queues,
  mask-wait stacks and returned-handler-depth arrays retain ordinary heap
  collections. Prepare capacity before changing a mask or consuming a pending
  signal. Reserve any completion/return storage before accepting the work that
  will need it; handler return must not discover an allocation requirement after
  changing handler depth. Preserve standard-signal coalescing, queued metadata,
  real-time signal ordering and timer notification ownership. Trace each
  caller's refusal/retry behavior rather than treating allocation failure as
  successful delivery or a silently dropped signal.
- **Epoll allocation admission after main convergence.** Main's ABI 51/52
  epoll engine adds nested interests, source snapshots, fairness and parked
  wait leases. Persistence retains that implementation and its existing heap
  allocation model rather than substituting the prototype's older bounded
  epoll engine. Filesystem-cache pressure must not change its readiness or
  signal-mask semantics. Audit these new collections, deep-copy overlap and
  failure ordering separately before claiming whole-system memory bounds;
  the earlier prototype's allocation-refusal test is not proof for main's
  different engine. Preserve main's full epoll behavior matrix during that
  audit. Persistent block-cache bounds do not establish epoll memory bounds.
- **Wait and wake delivery.** Wait-source arrays, sleeper records and returned
  wake/cancellation cohorts need an ownership and allocation-order audit.
  Cancellation, process teardown and readiness delivery should consume already
  prepared storage or stream results, rather than needing a fresh allocation
  after retiring the authoritative waiter. Preserve execution-generation
  identity, exactly-once completion and retry-target pin release across exec,
  exit, timeout and cancellation. This is distinct from moving host parking
  policy into Rust; neither change should hide or lose a wakeup.
  Main's ABI-54 native wait engine adds `wait_park` maps, completion storage
  and retirement cohorts that still need that broader accounting review.
  Its Rust ownership does not itself establish aggregate memory admission.
  Preserve native generation checks and process retirement while auditing
  those collections; filesystem payload admission is a separate contract.
- **Timed asynchronous subscriptions.** Repeatedly racing the same pending
  promise against a timeout does not remove the losing promise reactions.
  A slow but healthy operation can therefore retain one callback cohort for
  every timed retry until it finally settles. Audit other long-lived retry
  and cancellation paths for this ownership pattern. Persistent deferred reads
  now use a shared settlement signal with admitted, removable wait listeners;
  that fix does not prove other queues are bounded. Require actual listener
  removal and timer cleanup on timeout as well as successful completion, and
  test many retries against an operation that intentionally stays pending.
- **Terminal input.** Canonical line and cooked-input buffers still use ordinary
  byte vectors. Define truthful admission/backpressure before consuming input
  or producing irreversible echo/control effects. Preserve termios processing
  and retry behavior; replacing the container alone does not establish safety.
- **Host retention and retirement.** Inventory worker/channel registries,
  pending callbacks, timers, transport buffers and retained typed-array views.
  Tie release to the actual last owner and execution generation, including
  partial startup and failed shutdown. A view or AudioWorklet can retain an
  entire Wasm backing after the nominal machine owner is gone; a missing detach
  acknowledgement must not be mistaken for successful retirement. Demand-driven
  audio setup is a candidate to avoid unused owners, not proof that detach or
  same-page reboot is correct.
  Audit suspended async activations too: clearing an owner's descriptor field
  does not establish release if a pending function still holds its argument
  or local view across an unresolved await. Defer acquiring a backing until
  the awaited prerequisite settles, and keep thin public wrappers synchronous
  when they can directly return an owned promise. Preserve synchronous
  activation/error semantics and terminal late-completion checks; do not use
  presumed engine optimization of dead locals as the release proof.
- **Guest-address versus kernel-memory growth.** The channel `mmap` dispatcher
  and `kernel_brk` still call `ensure_memory_covers`, which grows memory index
  zero of the kernel module, while the host separately grows the process's
  memory. Audit the remaining direct-call assumptions before removing this
  legacy coupling. A guest address is not a kernel allocation requirement;
  test ordinary and fixed maps, remap, brk, direct import paths and failure
  rollback with separate kernel/process page measurements. No memory saving
  or performance improvement is established by this source observation alone.
- **Stage VM growth before authoritative mutation.** The storage-mapping
  work adds rollback for nonfixed `mmap` when process-memory growth fails.
  Audit `brk` and `mremap` for the same ordering: a host allocation failure
  after a Rust VM change must not leave the guest observing an error while
  authoritative address-space state has changed. Fixed-map pre-growth also
  cannot undo the physical memory growth when later preparation refuses.
  Prefer explicit preparation/commit ownership and test genuine engine
  allocation failure, not only logical-budget rejection. These are remaining
  audit questions, not evidence that generic VM rollback is complete.
- **Aggregate evidence.** Shared admission credits are not measured resident
  memory. Count retained capacity, old/new growth overlap, nested payloads,
  allocator overhead and host/engine reservations without double-counting
  aliases. Charging an inline process-table node does not charge its nested
  queues. Measure simultaneous Node/browser process-tree peaks during actual
  workloads before claiming whole-system bounds; kernel page counts alone
  cannot establish that claim.

Validate refusal before publication, preservation of accepted work, retry after
reclaim and final-owner release. Include forced allocation failure at lifecycle
boundaries and Node/browser integration, not only container unit tests.
File-backed mapping snapshots, dirty-byte coherence and persistence transport
buffers remain directly storage-related; their work stays in the persistence
plan rather than being deferred by this general-hardening inventory.

**Files:** `crates/runtime-core/src/signal.rs`,
`crates/runtime-core/src/process.rs`, `crates/runtime-core/src/terminal.rs`,
`crates/runtime-core/src/wait_queue.rs`, `host/src/kernel-worker.ts`,
`host/src/worker-main.ts`, `host/src/runtime-memory-profile.ts`

### Apply partial-failure lessons across kernel subsystems

Mapped-file writeback exposed two useful audit patterns: retrying an old
whole-page buffer can overwrite a newer descriptor write, and comparing
only the latest file size can miss a shrink followed by regrowth. The
broader follow-up is to audit similar ownership and retry boundaries in
queues, transports and lifecycle transitions. These are audit questions,
not evidence that those other subsystems have the same defects.

- **Record accepted progress before another fallible step.** A short write
  or partially delivered batch must retire exactly the accepted prefix.
  Retry only unfinished work; do not replay completed effects or replace
  newer state with a stale snapshot. Test failure after partial success,
  an intervening update by another owner, and then retry.
- **Preserve destructive transitions, not just final state.** Equal sizes
  or a changed generation number do not describe which bytes or resources
  became invalid. Record invalidation when it happens, before later growth
  or reuse can hide it. Audit truncate/regrow, exec, identifier reuse and
  cancellation boundaries for stale references and delayed completions.
- **Prepare the failure and completion paths too.** Reserve bookkeeping
  before accepting work or publishing ownership. Cleanup, cancellation
  and retry must not require a new allocation merely to discover pending
  work or release a pin. Prefer bounded scratch space and streaming walks
  where a temporary collection could fail after authoritative mutation.
- **Track provisional owners through cleanup.** Register a resource as
  soon as it is acquired, before an awaited validation or final publication
  can fail. An empty active-owner field does not prove provisional handles
  were closed. A logged close failure must remain an explicit unproven
  obligation; later cleanup must not acknowledge success merely because
  the original wrapper was forgotten. Audit worker construction, file
  handles and callback registration for the same ownership gap.
- **Stop admission and drain creators before final closure.** An operation
  awaiting a resource can acquire it after shutdown starts. Mark retirement
  before awaiting anything, reject new work, and account for already
  accepted operations until their resources are closed or their cleanup
  failure is retained. Closing only the currently published owners is not
  enough. Audit asynchronous worker startup, transport setup and device
  attachment; test shutdown while acquisition is still pending.
- **Bind retirement evidence to the exact owner.** A startup error is not
  proof that resource cleanup finished, and requesting worker termination
  is not a storage-close acknowledgement. Associate completion with the
  worker and execution generation that own the resources. Reject stale,
  malformed, failed or missing acknowledgements rather than releasing
  exclusive ownership on a timeout. Define separately what an explicit
  recovery procedure can safely do when closure remains unproven.
- **Recheck cleanup failures after callbacks finish.** Reentrant cleanup
  or a callback that catches an inner close error can create a new failure
  during the cleanup sweep. Preserve that failure and check it after all
  close attempts, not only before the sweep. A later no-op or repeated
  cleanup call must not turn an unproven close into success. Include
  swallowed errors, nested cleanup and late acquisition in lifecycle tests.
- **Test physical allocation failure as well as budget refusal.** An
  admission credit is not an allocation guarantee. Exercise both cuts,
  old/new allocation overlap, rollback before publication, and successful
  retry after reclaim. Repeated startup failure, shutdown and same-page
  reboot should also verify final-owner release on Node and each browser
  engine; a passing logical counter alone does not prove memory release.

The remaining storage-specific ownership work stays in the
[durability contract](persistence-durability.md); this cross-system audit must not
become a new prerequisite for delivering the persistent demo.

The storage-specific implementation and regression examples are
`host/src/storage-close-ledger.ts`, `host/test/storage-close-ledger.test.ts`
and `apps/browser-demos/test/fixed-rootfs-persistence.spec.ts`. Use them as
starting points for the broader audit, not as evidence that unrelated
subsystems already satisfy these rules.

### Separate durable host installs from ordinary filesystem writeback

Completed `writeFileToVfs` calls on both hosts sync through Rust before their
success response. This fixes cached suffixes disappearing on immediate refresh,
but it is a rootfs-wide durability fence and not atomic replacement. A worker
interrupted before acknowledgment can leave a partial destination. An asset
installer that trusts existence alone can subsequently mistake it for a complete
install. Audit profile assets, activity dependencies, exchanges, editor uploads,
and other host-fed file publication boundaries separately from guest POSIX
`write`/`close` semantics.

Prefer a Rust-owned atomic publication path: bounded writes to an unpublished
inode or same-filesystem staging file, a data durability fence, atomic rename,
and durable namespace publication before acknowledgment. Failed or cancelled
installs must not replace a good destination; restart must distinguish unfinished
staging from published data. Group related installs behind an explicit batch
fence instead of removing the final fence or syncing every guest write. Preserve
Node/browser parity, error propagation, quota admission and bounded staging.

Ordinary writeback still needs evaluation of bounded dirty-age/group-commit
policy so idle dirty files do not depend solely on eviction or application
sync. Such a policy bounds the loss window, not absolute durability for every
successful `write`; `fsync`/`fdatasync`/`sync` must remain explicit fences.
Measure journal transaction counts, flush latency, foreground syscall stalls,
and complete application throughput before changing batching or cache budgets.

Dedicated host storage workers are an experiment, not an assumed speedup.
They may own positioned byte I/O, but Rust must retain cache, journal, recovery
and commit-order authority; process workers must not open OPFS. Forwarding a
synchronous read to another worker still stalls its calling kernel unless the
pipeline changes, and adds queue/wakeup costs. Any asynchronous design needs
bounded in-flight buffers, ordered durable acknowledgments, cancellation and
shutdown fences, and fault tests across worker death and quota exhaustion.
Profile first to separate I/O wait from Rust bookkeeping and transaction cost.

### Separate audio activation from kernel-memory attachment

The browser eagerly prepares an AudioWorklet with the kernel's shared PCM
memory even when no guest opens `/dev/dsp`; global user gestures resume it.
Checkpoint 1.16 shell traces confirm zero stream generation and empty cursors
on transports whose retirement later fails. Consider separating a trusted
gesture's audio-context unlock from attaching the kernel buffer on actual
guest audio demand. Preserve automatic later playback and explicit audio API
behavior; an unused guest stream is not evidence that an already-attached
worklet released its memory.

In five repeated WebKit shell checkpoints, the context reports running while
its clock remains zero. An immediate real-suspension diagnostic also fails
all five checkpoints, so changing suspension order alone is not a proven fix.
Fresh-context worklet lifecycle cases pass on Chromium and WebKit and do not
explain the full application failure. Trace actual processor construction,
message delivery and memory release before changing retirement policy. Keep
missing detach acknowledgements visible; do not replace them with elapsed
time, a suspended context, or an assumed absence of audio activity.

A private actual-module diagnostic narrows this further: the processor is
constructed, but its render callback never runs and its shared detach witness
remains unset at 50, 500 and 900 ms. The real detach handler eventually runs
near the existing one-second deadline. Suspending the context before posting
detach also fails all three repetitions. This is not merely a late main-thread
acknowledgement, and neither suspension ordering nor a small shared witness
is a proven retirement fix. These observations concern the existing eager
attachment in the real shell application; they do not establish a general
WebKit audio limit or justify changing the filesystem's durability contract.

The checkpoint 1.18 combined application run reproduces the shell detach
failure after it did not occur in 1.17. Do not count the intervening passing
run as a diagnosed fix. Its separate WebKit mixed WordPress workload stalls
after content and alias comparison, before completing the inode `stat`
command substitutions. The new failure capture includes the active journal
and its activation controls, not just the checkpoint base. Strict native
recovery and real Bash metadata commands succeed against those captured
bytes on Node without changing the original capture. This narrows the
investigation but does not prove WebKit process execution correct or connect
that stall to PCM retirement. Keep both failures visible in release evidence.
An isolated WebKit kernel subsequently runs the captured current state and
the actual metadata commands successfully too, using the application's normal
lazy-asset mapping. Investigate the full application's services, concurrent
work and lifecycle history rather than assuming that this passing isolated
run diagnoses the stall or establishes correct release behavior.

The subsequent demand-driven host candidate separates context activation from
worklet transport attachment. It avoids creating an unused kernel-memory owner,
but does not establish reliable detach for an already attached, nonprocessing
WebKit worklet. Retain that distinction in future audio work. Pending module
preparation now has bounded shutdown and terminal late completion; that targeted
ownership fix does not prove all other host promises or queues are bounded.

### Exercise synchronous process-worker construction failure

A private boot-measurement fixture accidentally changes a kernel worker's URL
base to a blob URL. Its process-worker constructor then rejects the normal
root-relative asset URL before the guest starts. The subsequent cleanup logs
that it retains pid 100's exact process-memory registration because unregister
would re-enter an active kernel export. The fixture is corrected to preserve
the original worker URL; no production persistence change is needed for that
measurement error, and no escaping registration leak is established.

Keep the general failure path as future lifecycle hardening: inject a
synchronous process-worker constructor exception, prove terminal spawn failure,
and verify deferred unregister and exact inherited-resource reclamation after
the original kernel entry closes. Exercise both hosts where applicable. Retain
ownership until that proof exists rather than declaring a reentrant cleanup
successful. This is not an OPFS persistence prerequisite or a diagnosis of the
earlier WordPress failures.

### Propagate worker message-deserialization failures

Read-only lifecycle review found that the browser process-worker adapter
forwards ordinary messages and worker errors but not `messageerror`.
The child entry likewise has no initial-message deserialization handler.
If posting initialization succeeds but the receiving endpoint cannot
deserialize it, initialization may never start and the fork replay gate
can remain pending without a terminal launch result.

Route deserialization failures on both endpoints through the existing
launch-failure/cancellation path. Preserve fork rollback, completion of the
parent's pending syscall with an error, and release of inherited pipe/file
references. Add endpoint fault-injection regressions, including failure
before initialization begins, rather than substituting a longer timeout
or synthesizing successful readiness.

This is a statically identified missing failure path, not a confirmed cause
of the intermittent WebKit persistence-workload stall. Keep it separate
from storage-format work unless a reproduction reaches that path.

**Files:** `host/src/worker-adapter-browser.ts`,
`host/src/worker-entry-browser.ts`, `host/src/fork-replay-gate.ts`,
`host/src/browser-kernel-worker-entry.ts`

### `sys_openat` duplicates `sys_open` logic
`sys_openat` reimplements umask application, file type determination, creation flag stripping, and O_CLOEXEC handling rather than sharing code with `sys_open`. Consider extracting a shared internal helper or implementing `sys_open` as `sys_openat(proc, host, AT_FDCWD, path, oflags, mode)`.

**Files:** `crates/kernel/src/syscalls.rs` — `sys_open`, `sys_openat`

### Fork deserialization lacks bounds checks on variable-length fields
`deserialize_fork_state` and `deserialize_exec_state` read length-prefixed fields (env vars, cwd, OFD paths) without capping the length. A malformed buffer could request a multi-GB allocation via `to_vec()`, causing OOM abort in `no_std`. Consider adding `if len > MAX_LEN { return Err(Errno::EINVAL); }` guards.

**Files:** `crates/kernel/src/fork.rs` — `deserialize_fork_state`, `deserialize_exec_state`

### `deliver_pending_signals` silently discards handler call errors
When `host_call_signal_handler` fails (invalid function table index, handler throws), the error is discarded via `let _ =` and the signal is consumed (already dequeued). Consider falling back to the default action on handler failure, or re-raising the signal.

**Files:** `crates/kernel/src/wasm_api.rs` — `deliver_pending_signals`

### Make cross-process shared memory immediate and futex-addressable

Anonymous `MAP_SHARED` inherits one host-owned backing across fork; SysV SHM,
mappings of files the kernel owns, and stable-identity host-file mappings
share backings across separately attached or mapped processes. Because each
PID still owns a different WebAssembly `Memory`, coherence happens only at
syscall boundaries: the host (for the objects whose bytes it owns) or the
kernel (`SharedMappingTable`) merges bytes changed relative to a process's
snapshot and then imports peer changes, the kernel's half when a peer's
syscall completes. A direct store does not immediately change another
PID's memory, and futex WAIT/WAKE cannot target the peer's separate
`SharedArrayBuffer`.

Closing this gap requires a memory architecture or host protocol that supports
both immediate observation and wakeups, not just periodic byte merging. Any
design must preserve independent process address spaces, fork continuation,
Node/browser parity, and signal/cancellation behavior. It also needs explicit
performance evidence: the current boundary coordinator runs in the syscall hot
path, and its cost has not yet been established by before/after micro and full
application benchmarks on both hosts.

**Files:** `host/src/kernel-worker.ts`, `host/src/worker-main.ts`,
`host/src/browser-kernel-worker-entry.ts`,
`host/src/node-kernel-worker-entry.ts`, `crates/runtime-core/src/memory.rs`

### Close the remaining regular-file `MAP_SHARED` gaps

Two kinds of regular file are mapped differently, by whoever owns their
bytes, and each has gaps.

**Files on a host-mounted directory** (Node `extraMounts`, session seeds, a
host-backed scratch mount; OPFS where a host mounts it) go through the host
page cache, which deliberately rejects objects it cannot identify or keep
alive safely. Node and supported OPFS browsers provide exact live-handle
identity; OPFS uses session-scoped inode tokens and preserves an open object
across rename and unlink. Initial mappings retain the descriptor's live
handle rather than reopening its remembered pathname, and separate mappings
of one file converge at syscall boundaries.

**Files the kernel owns** (everything under `/` and the scratch mounts,
including `/tmp` and `/dev/shm`, and memfds) are kept coherent by the
kernel's shared-mapping table (`SharedMappingTable` in
`crates/runtime-core/src/memory.rs`), which pins the file for its mappings
and sees descriptor writes through a per-file content generation. It
publishes every mapping of a file before a descriptor syscall touches the
file's bytes (`descriptor_fence_for`), as the host does for its kind, and
pulls mappings lazily, when a peer's syscall completes, skipping processes
the host proves have not run since their last pull. What remains is cost
rather than a semantic gap, in order of expected value:

- the host still enters the kernel at every syscall *entry* of a process
  holding a kernel-owned mapping, only to synchronize SysV attachments; a
  process with file mappings alone could skip that call;
- the quiescence query is one host import per pulled process; a completion
  that pulls many processes could ask once for all of them;
- kernel-direct wait completions (`publish_transfer_directly`) are refused
  for any process with a shared mapping and could run the completion pull
  in the kernel instead;
- SysV attachments, host-owned anonymous and host-file mappings, and DRI
  CPU-buffer import synchronization still compare at every boundary, and
  could adopt the same pull-and-prove protocol;
- a comparison still reads the whole mapping. Only a store barrier in the
  SDK (a program-ABI change with a per-store cost) could make it
  proportional to the bytes actually written.

Both kinds share the observable VM gaps: stores beyond the current file
size are zero-filled or discarded instead of raising Linux `SIGBUS`, and
writers outside Kandelo's direct file syscall paths do not invalidate
cached pages.

**Files:** `host/src/kernel-worker.ts`, `host/src/vfs/opfs-worker.ts`,
`host/src/vfs/vfs.ts`, `crates/runtime-core/src/memory.rs`,
`crates/runtime-core/src/kernel_file_mapping.rs`

### Re-evaluate the Linux-specificity of the VT keyboard input path

The framebuffer keyboard path is Linux-shaped end to end so that
Linux-VT software such as fbDOOM runs unmodified. The host encodes key
events as single-byte Linux console MEDIUMRAW (`byte = keycode`, bit 7
set on release) in `host/src/framebuffer/browser-controls.ts`, the
kernel carries those bytes opaquely, and the guest decodes them. The
kernel also answers three Linux-VT keyboard ioctls
(`KDGKBTYPE`/`KDGKBMODE`/`KDSKBMODE`) on the process's terminal fd as
compatibility stubs: they report a Linux VT keyboard with sensible
defaults and treat mode changes as a no-op, without translating the
byte stream.

This is deliberate Linux-observable compatibility at a non-POSIX
boundary — VT keyboard input has no POSIX equivalent — but it has not
been evaluated as a long-term contract. Revisit whether the MEDIUMRAW
encoding and the VT-ioctl stubs are the model we want, whether they
should sit behind an explicitly documented input-device boundary, and
what the correct behavior is for non-VT consumers. Any change must keep
existing Linux-VT guests working and preserve Node/browser parity.

A Firefox Doom save/quit regression also observed a released MEDIUMRAW key
byte (`0xc4`, F10 release) reaching the restored interactive shell and prefixing
its next command after Doom exited on the key press. The fixture clears the
pending input line with Ctrl+U before probing that shell's exit status. Audit
display-owner transitions and outstanding key releases so a frame's input
cannot become command-line bytes after termios restoration. This observation
does not establish a browser defect and is separate from filesystem durability.

**Files:** `crates/runtime-core/src/syscalls.rs` (VT keyboard ioctls),
`host/src/framebuffer/browser-controls.ts`
(`encodeLinuxMediumRawKeyCode`), `crates/shared/src/ioctl_contract.rs`,
`docs/posix-status.md`

### Fix the three UDP routing defects behind both hosts' expected failures

PR #1600 made the Node and browser conformance runners boot the same machine (eth0 at 10.0.2.15/24 behind the egress gateway), and three UDP defects then showed up identically on both. They stay listed in `UDP_EXPECTED_FAIL` (`scripts/sortix-expectations.sh`), each with its exact output, and are described in `docs/posix-status.md`:

- **A loopback source routed off the machine.** A UDP socket bound to `127.0.0.1` (for example by an earlier `connect(127.0.0.1)`) can `connect()` to an off-machine address and keeps its loopback source. Linux refuses that route with EINVAL once a route exists (`udp/connect-loopback-reconnect-wan-getsockname`, which prints `127.0.0.1:same port`).
- **No local delivery to the machine's own address.** A datagram sent to the machine's own eth0 address is handed to the egress gateway, which answers EHOSTUNREACH, instead of being delivered on the machine (`udp/cross-netif-loopback-send-lan-recv`). Linux keeps its own addresses in the local routing table.
- **The link's broadcast address cannot be bound.** `EgressLink.bindUdp` refuses `10.0.2.255` with EADDRNOTAVAIL; Linux allows binding a local broadcast address (`udp/bind-lan-subnet-broadcast`).

Each fix changes what an existing call returns, so they need an ABI version bump and a regenerated `abi/snapshot.json` (`docs/abi-versioning.md`). Remove the three entries from `UDP_EXPECTED_FAIL` in the same change and update `docs/posix-status.md`. The two remaining entries (`connect-wan-send-reconnect-loopback-send`, `shutdown-r-send`) are the real boundary: no UDP datagram leaves the machine.

**Files:** `crates/runtime-core/src/syscalls.rs` — `sys_connect_impl`, `udp_send_datagram`, `cross_process_loopback_udp_route`; `host/src/networking/egress-link.ts` — `bindUdp`; `scripts/sortix-expectations.sh`

### Close the POSIX gaps both hosts list as expected Sortix failures

Since PR #1600 the Node and browser Sortix runners share their expected failures, so these gaps are listed once, with recorded reasons:

- **`pathconf(_PC_FILESIZEBITS)` is indeterminate.** `filesystem_pathconf_value` returns -1 for it on every filesystem (`basic/unistd/pathconf`, `fpathconf`). Each filesystem should report the bit width it can actually address. Check that file offsets beyond that width fail with EFBIG rather than wrapping; a 64-bit offset narrowed to `usize` in the 32-bit kernel is a suspected case, not yet verified.
- **Thread CPU-time clocks are not recognized.** musl encodes a thread's CPU clock from `pthread_getcpuclockid()` as `(-tid-1)*8+6`; `host_clock_id` only recognizes the process encoding, so `clock_gettime` returns EINVAL (`basic/pthread/pthread_getcpuclockid`). More broadly, the CPU-time clocks report elapsed monotonic time rather than CPU usage (`docs/posix-status.md`).
- **There is no `/dev/log` receiver.** `openlog`/`syslog` find nothing to connect to (`basic/syslog/closelog`, `syslog`). A kernel-owned datagram receiver with a bounded, readable log would close it.

Remove each entry from `scripts/sortix-expectations.sh` when its gap closes; a pass on an expected failure fails the run on both hosts.

**Files:** `crates/runtime-core/src/syscalls.rs` — `filesystem_pathconf_value`, `host_clock_id`, `is_encoded_process_cpu_clock_id`; `scripts/sortix-expectations.sh`

## Graphics

The next shipment is the complete B1 guest-validation increment, with its
normal-built preview and recorded B1 checks. Remaining campaign work must
be named as follow-up steps: B2 asynchronous bindings and its ScummVM
request gate; B3 local queries; B4 program interfaces; B5 native fences;
B6 inline draws; then C1 Rust asynchronous scheduling, C2 executor
separation and C3 the GPU worker. Each stage still needs its own frozen
validation and measurements. Final Freeciv/ScummVM, desktop, conformance
and native-feel acceptance remain required; a B1 shipment does not claim
the later stages or their performance results.

The current normal partial B1 preview now includes the private-selector and
framebuffer-retirement corrections. The combined prepared-kernel matrix passes
378 native browser cases on three engines; the current normal application
snapshot separately passes six browser and six Node admission controls.
Full compiler checking still fails24 diagnostics. Optional CTS provisioning,
complete B1 validation and current-tree physical latency/overhead measurements
remain required. The private B2 cold-preparation draft passes2229 local source
controls after correcting a refused finalizer and old-checkout fixture imports;
it is neither landed nor guest-connected. These are current-iteration tasks.

Framebuffer deletion now reserves native cleanup ownership before reversible
selector changes and commits retirement after logical deletion. A refused live
native deletion reports a fatal fault and retains its cleanup receiver; it no
longer loses the handle after a predicted deletion. Focused source/native
coverage is recorded in the compatibility ledger. Current full conformance,
application performance and final stage acceptance remain required.

Private client-array savepoints and widened/padded index selectors now retain
exact restoration checks inside predicted guest batches. The earlier promoted
index regression used a zero index and never exercised promotion; its corrected
valid maximum-byte-index draw proves one native widened draw and an actual
refused restoration on all three engines. The focused capture/promotion gate
passes six cases. Broader current-tree validation and performance measurements
remain required; these private-path checks are not a performance claim or B1
completion. Guest acceptance remains predicted, and the direct index path gains
no restoration check.

The guest-driver migration and GPU worker below are now required work in
the GLES 2.0, EGL 1.5, GBM and single-display KMS baseline (draft PR #1594),
following the maintainer's 2026-11-03 revision of D-54. They remain
unimplemented targets rather than supported behavior. The other graphics
items retain their recorded deferrals. The decisions and their evidence are recorded in
[the graphics compatibility ledger](graphics/compatibility-v1.md).

### Move GL authority into the guest library and the Rust kernel (current iteration)

Required before this baseline ships. Today the guest
GLES library encodes commands while the TypeScript host validates them as
the acceptance authority. Native errors are sampled at batch boundaries
for context-reset diagnostics rather than guest acceptance. Following Mesa's split, the guest library should own
GL state, validation, error flags and state queries ("Stage B": local
`glGetError` for exactly validated commands, asynchronous binds, local state
queries, program interface fetched once per link, kernel-native GL fences,
inline client-array `glDrawElements`), and the Rust kernel should own
submission scheduling, foreign-fence dependencies and fence completion
("Stage C1"). TypeScript then remains a thin WebGL command executor. This is
also the planned migration of host GL logic out of TypeScript. Asynchronous
binds also fix the dEQP-EGL `gles2_shared_render` timeouts, where every
`glBindTexture` is a synchronous round trip.

Private buffer and image copies retain exact native checks until their
results can be published safely. Image refresh counts remain stale on failure,
and possible writes stay counted through reset unwinding. Shared native
container retargeting also retains exact checks before generation publication;
a submitting-context reset cannot leave a healthy peer attached to a different
generation from the one sampling observes. Moving validation
into the guest must preserve this host storage-validity contract.
Pending repair after a known host rejection also retains exact native
restoration checks independently of the active guest batch's predictor.
The complete remaining native/image audit still needs closure.

The initial B1 source increments preserve local error knowledge across
scalar and argument-validated setters, retaining the ordinary host command
records. Ordered error observations clear locally returned flags at the
same stream position; the fatal audit checks the independent host oracle.
Unknown operations and ordinary device requests still force a drain. A fully
checked synchronous mutation receipt can preserve an existing exact proof
when context, cursor and request-count checks establish that it added no
error; this does not make binds asynchronous. Array-buffer storage also
preserves the proof when its binding is separately known. Indeterminate
mutations revoke binding certainty; an ordinary error drain cannot repair it,
and storage uses a checked binding-presence query until an acknowledged bind.
Element-buffer/VAO and large-upload sub-data paths remain conservative.
Ordinary vertex layouts now reuse existing host slots and can preserve error
knowledge for the default-VAO scope with known bindings and slots. Converted
layouts, first installations, nondefault-VAO history and uncertain state
retain their conservative paths; full attribute/draw authority is unfinished.
Program selection now has shared C names, current-context references, cold
native executable captures and checked host-journal transport. Its explicitly
admitted C prototype connects bounded pending/result custody, generation-token
caching and ordered shared publication. Ordinary applications now enter it
automatically at their first eligible program selection, while unknown
records retain checked validation. Full loss/final-context audit closure and
application acceptance remain required. A positive link-status cache without complete ownership
fails a newly shared pthread deletion regression; that prototype
was not landed. This ownership remains required current-iteration work.
This is only the start of B1: the remaining exact validation families and their audit
coverage and application measurements remain required before B1 is complete.
The maintainer kept asynchronous bindings in B2 and moved the ScummVM <=10
total synchronous requests per produced buffer gate to B2 completion on
2026-11-05; all other stage and final gates remain required.
Completing program selection alone does not
finish the remaining attribute/draw and other required hot-path validation.
B2–B6 and C1–C3 remain current-iteration work; no completed driver stage or
native-feel result follows from the
focused scalar controls.

A focused native-reset interruption during shared metadata publication now
recovers only the snapshot-proven prefix and moves its unentered suffix to a
healthy publisher. Shader public names retire before fallible cleanup, with
cold native custody surviving the reset. Multiple-owner and inconsistent-
snapshot controls preserve healthy rendering and explicit pre-exit cleanup.
Remaining execution-loss, failed-prefix and final-context cases
still gate ordinary activation; this does not complete B1 or native feel.
An independent physical-loss control finds the last metadata publisher's
unsubmitted intents can block backend context destruction. Public context and
execution ownership remain before process exit despite successful EGL calls.
Fix that lifecycle path and preserve its independent pre-exit regression.

Error drains now reserve a fixed context receipt and seal each completed
transfer before copying it to the guest. Lost or malformed replies recover
read-only without replaying the drain or consuming a later same-valued error.
The original one-request successful path remains; failure-only recovery must
then observe fresh queued work before local error knowledge can resume. This
closes the targeted error-reply custody gap, with native controls and real
GPU checks on three engines/both widths. Full B1 conformance, loss/final-context
audit, application measurements and complete preview remain required.

Ordinary link/use no longer pays for an unused selected/prepared executable
capture cache. Admitted journal caches acquire cold pins only when needed,
including authoritative unknown-link observations. Focused request-count and
fault controls cover this increment. Automatic admission now has focused
three-engine coverage; application latency and full B1 acceptance still
need validation.

Native desktop measurement remains current-iteration work alongside the driver.
The owned-window observer now has bounded pixel matching with six headless
engine/render-mode control cohorts. First-visibility bounds retain capture
coalescing uncertainty. The moving-pixel controller now fits viewport coordinates and validates native
pose identities, with passing headless replay on three engines. Its revised
native-raster learning path now passes a physical Chromium replay on an
older frozen partial-B1 desktop: Foot, Foot under concurrent ScummVM load,
and ScummVM's red software cursor, eight responses per cohort with no-op
controls. It uses actual WindowServer display bounds, not synthetic clocks.
The final combined tree, Firefox/WebKit physical desktop runs, with/without
SFWBar, all interaction workloads, stable latency tails, missed frames,
CPU and total instrumentation overhead remain required. See the
[native method record](measurements/2026-11-04-native-desktop-cursor-method.md).
Preserved calibration/screenshot failures do not count as guest latency or
acceptance; the successful method run does not establish native feel.

Those earlier rows used independent-window capture, which can retain occluded
content. They establish pixel classification and clock-method evidence, not
unoccluded selected-display timing. The current tooling adds a display crop
without exclusions, exact window/overlay authority, persistent original-input
and refused-tail evidence, and an informative-lower-bound delay qualifier.
Node, headless three-engine and native model/compiler controls cover that
source; actual unlocked selected-display calibration remains current-iteration
work. Sparse capture is explicitly uncertain, and presentation completeness,
application response oracles, exact worker CPU and total observer overhead
remain required before any native-feel claim.

This migration must preserve ordinary shared-memory Wayland clients. The
baseline removes the Foot, mako, GTK and Qt DRM-pool rewrites now that
wlcompositor maps memfd pools; future graphics transport and scheduling
must keep that platform behavior and its Node CPU-renderer coverage.
Mapped BO imports also need receive-completion coherence: a producer may
publish another buffer update after the consumer's readiness wake. Moving
execution or queues must preserve that happens-before edge, including when
a receive writes directly into a mapped buffer. A writer's baseline must
also advance from the exact bytes published, rather than a later reread of
its live mapping, so concurrent stores cannot become clean without ever
reaching canonical storage.

### Run WebGL in a dedicated GPU worker (current iteration)

Designed but not built: a GPU worker owning one WebGL context executes an
ordered command ring copied at submit, while the kernel keeps buffer, fd and
fence authority as DRM does. Implement after Stage B, first proving Rust
queue/fence semantics on the kernel thread (C1), then separating the executor
(C2), then moving it to the GPU worker (C3). Land and measure each stage
separately. The maintainer now requires this isolation in the current
iteration as part of native desktop feel, even if the earlier minimum bar
is met. Direct guest-to-GPU-worker submission (user-mode queues) remains
deferred under D-51; reconsider it only with measured submit-hop costs.

### Rework the CI browser job

The CI browser path now calls the supported `./run.sh prepare-browser`, a full
local build that may exceed the job's time limit on a cold cache. CI does not
run today and will be reworked before it resumes; budget the build then.

### Implement OpenGL ES 3.0 contexts

Deferred because Cage, Sway and Labwc (through the wlroots GLES2 renderer),
SFWBar, the current ScummVM path and Kandelo's own wlcompositor (the
`wayland` and `omarchy` desktops) all use GLES 2, so ES 3.0 was not on the
desktop's critical path and would roughly double conformance-testing time.
WebGL 2 is close to ES 3.0, so most entry points map directly; the real work
is where WebGL 2 falls short: `glMapBufferRange` (a guest-side shadow with
write-back), ETC2/EAC texture formats (CPU decode where the browser lacks
them), texture swizzle state (shader variants), primitive restart that cannot
be disabled, and sync timeouts that must be polled. EGL needs ES3 configs and
contexts, and dEQP-GLES3 must be packaged and inventoried. A full design and
work breakdown is in the 2026-11-01 expansion plan (units G0-G13 and GC).
Today an ES 3 context request fails with `EGL_BAD_MATCH`.

### Render GL on the Node host

Deferred because Node has no WebGL, so GL rendering there needs a software or
GPU renderer for Node, for example a GLES-on-WebGPU backend over Dawn's Node
bindings or a headless WebGL 2 implementation. Without an embedder-supplied
WebGL 2 renderer, `eglInitialize` fails with `EGL_NOT_INITIALIZED` on Node, as
it does in a browser without WebGL 2. The Node desktop still runs on the CPU
compositor, and the browser engines carry GL parity testing until this lands.

### Support `EGL_WL_bind_wayland_display` and GBM Wayland-buffer import

Deferred because modern clients and wlroots share buffers through
linux-dmabuf; the legacy `wl_drm` path this extension serves is not used by
any program in the current stack. Implementing it means a `wl_drm` server
global in libEGL, `eglBind/Unbind/QueryWaylandBufferWL`, and the GBM lookup
behind `gbm_bo_import(GBM_BO_IMPORT_WL_BUFFER)`. That import fails with
`EINVAL` today, which is also Mesa's behavior when no `wl_drm` is bound.

### Advertise the remaining optional wlroots GL extensions

`GL_EXT_disjoint_timer_query` (wlroots render timers),
`GL_EXT_texture_type_2_10_10_10_REV` and `GL_EXT_texture_norm16` (10- and
16-bit client buffers) and `GL_KHR_debug` (debug logging) were deferred
because no program in the current stack needs them; wlroots works without
them. Timer queries depend on browser support that Firefox and Safari do not
reliably provide. `GL_KHR_robustness` and `GL_EXT_read_format_bgra`, which
wlroots does use, are implemented.

### Expose more than one KMS display

Deferred because no current program needs a second monitor; wlroots can
already create headless virtual outputs without KMS changes. Multiple
displays mean extra CRTC/encoder/connector/plane pipes from boot, per-CRTC
vblank, hotplug through real `NETLINK_KOBJECT_UEVENT` events, one browser pane
per display, pointer mapping per output, and a measured presentation path,
since secondary displays may otherwise need a full-frame copy per frame.
Kandelo exposes one connector and one CRTC today.

### Port IGT and add a `sw_sync` test device

IGT GPU Tools is the Linux graphics community's DRM/KMS uAPI test suite.
Porting it was deferred because it is substantial (its C tests, a runner, and
a `sw_sync` timeline test device its sync tests need). Until then, Kandelo's
KMS, GBM and sync-object coverage comes from Rust and guest tests that mirror
IGT subtests by name, plus Cage, Sway and Labwc as real consumers.

### Build the compositor packages for wasm64

Deferred because no program needs wasm64 compositors and the wasm32 builds
work. The foundation is in place: a wasm64 Meson cross file and an
architecture-aware package build-roots helper. What remains is libffi's
wasm64 dispatch and closures, a wasm64 Rust target (for librsvg), porting
about 30 libraries (glib, cairo, pango, libinput, libwayland and others),
wlroots, Cage, Sway and Labwc, and deciding which images ship which
architecture and with what memory ceilings on WebKit.

### Offer 10-bit and half-float window surfaces

Deferred because no program in the current stack requests them. EGL window
configs and `gbm_surface` are 8 bits per channel; 10-bit and FP16 buffers are
already supported for GBM allocation, EGL dma-buf import and KMS scanout
(reduced to 8 bits per channel on the 8-bit canvas). Window surfaces would
need new EGL configs, matching present-target formats and front-copy
conversion.

### Scan out YUV framebuffers on the KMS primary plane

Deferred because players and compositors import YUV video through EGL, which
is implemented, and a primary plane that offers only RGB formats is
conformant (each driver defines its planes' formats). Direct YUV scanout, as
used by `mpv --vo=drm`, would need the presenter to convert YUV to RGB at
scanout.

## Browser

### Verify served bytes when validating frozen preview artifacts

`injectCorsProxyConfig` in `apps/browser-demos/vite.config.ts` intentionally
serves a source-derived service worker in local preview so its CORS relay
configuration follows the preview origin. Hashing a frozen output directory
therefore does not, by itself, prove the actual service-worker response bytes.
Other preview middleware can also consume a request before a later diagnostic
plugin sees it. A persistence diagnostic reproduced that exact distinction:
its kernel-worker probe was served but its service-worker probe was absent.

Add a generic preview-fidelity check that records the served service worker
and representative worker responses, including declared runtime substitutions,
and checks diagnostic installation with a healthy request/reply control.
An explicit immutable-artifact preview mode could serve emitted worker bytes
while leaving ordinary local CORS-relay behavior intact. Do not silently
remove preview's intentional proxy support or equate a directory hash audit
with an HTTP-response audit. This is test/deployment fidelity work, not a
filesystem durability guarantee.

### Investigate the WebKit fbDOOM WAD-drop failure
The test that is now `apps/browser-demos/test/kandelo-doom-exchange.spec.ts`
"dropping a WAD on the framebuffer loads it" failed in WebKit in three of three local runs on
2026-09-28, each at a different step: the 90 s wait for the restarted
fbDOOM to render, and a locator that never became visible. The drop itself
works — the screenshot shows the shell running
`/usr/local/bin/fbdoom -iwad /user.wad`, and the new fbDOOM initializing
through `HU_Init` before it stops making visible progress. Chromium passes
the same test, and WebKit passes the Load WAD button path, which uses the
same restart command.

That demo's keyboard input goes through the PTY (`ptyWrite`), not the host
stdin pipe that ABI 47 changed, and no old-code baseline was available
locally to compare against, so the failure is recorded here rather than
attributed. The investigation should: run the test on main in WebKit to
establish whether it predates ABI 47; compare what the drop path does
differently from the button path (synthetic `DataTransfer` drop, focus,
pane switching to the terminal); and capture the kernel's view of the
restarted fbDOOM (blocked syscall, fb0 ownership) when it stalls.

On 2026-10-21 the test passed in local Playwright WebKit on main at
`050922f79` (6 of 6 runs), and again with `/dev/fb0` released at exit
rather than at reap (6 of 6). Neither run reproduced the stall, so the
cause remains unknown; the entry stays open until a failing run can be
captured as described above.

On 2026-10-22 profile `ingest` was replaced by Kandelo exchange: the drop
now reaches the machine's agent, and DOOM's launch wrapper restarts fbDOOM
on SIGHUP instead of the browser typing a restart command. Re-run the drop
test in WebKit against the new path; if it does not stall, close this
entry.

### Replace the constrained public CORS proxy with an owned relay

The current public proxy has a narrow six-name request-header profile. A
Kandelo-owned authenticated relay should add explicit origin policy, private
network controls, rate limiting, abuse prevention, response limits, and
operational ownership. Once that capability exists, remove anonymous GET
omission mode and evaluate Node/browser transport parity without presenting the
current browser boundary as complete POSIX socket or HTTP fidelity.

**Files:** `host/src/networking/`, `apps/browser-demos/public/service-worker.js`,
deployment infrastructure and browser acceptance

### Technical debt: drop the `X-Cors-Proxy-Range` workaround and its preflights

WP Cloud, which hosts the default proxy's PHP, strips the `Range` header
before the request reaches PHP, so the profile's
`rangeRequestHeaderAlias` makes every proxy dispatch repeat `Range` as
`X-Cors-Proxy-Range`, which that proxy forwards upstream as `Range`. This
workaround has two costs, accepted to make ranged reads work at all:

- **Preflights.** The alias is not CORS-safelisted, so a ranged request
  needs an `OPTIONS` preflight. In Chromium every ranged request pays one,
  because of the next item; WebKit reuses a preflight for 5 seconds. The time
  cost has not been measured.
- **No HTTP cache.** Aliased requests use the Fetch cache mode `no-store`,
  because the HTTP cache can rewrite `Range` without the alias and splice a
  short body. Ranged reads through the proxy are therefore never cached.

When `Range` reaches the proxy unchanged (re-measure a plain
`Range: bytes=0-15` through `wordpress-playground-cors-proxy.net` for a
`206`), remove `rangeRequestHeaderAlias` and the `no-store` mode from the
profile, `BrowserCorsProxy.fetch()`/`project()`, the service worker, and the
development relay, together with their tests and the related text in
`docs/browser-support.md`. Simple `bytes=N-M` ranges then need no preflight
at all.

**Files:** `host/src/networking/browser-cors-proxy.ts`,
`apps/browser-demos/lib/browser-cors-proxy.ts`,
`apps/browser-demos/public/service-worker.js`,
`apps/browser-demos/vite/dev-cors-proxy.ts`, upstream proxy deployment

### Relay `If-Range` instead of emulating it

The proxy cannot carry `If-Range`, so the browser host emulates it: a `206`
without the matching validator is discarded for a second, whole-entity
request. That costs a full extra request whenever the resource changed, and
always for a date-form `If-Range`, because the proxy does not expose the
response `Date` that proves `Last-Modified` is strong. If the proxy allowed
and forwarded `If-Range` (its front end strips it, so it would need an alias
like `Range`), the profile could list it and the emulation would step aside
on its own. Exposing `Date` would make date-form `If-Range` confirmable in
the meantime.

**Files:** `host/src/networking/browser-cors-proxy.ts`,
`apps/browser-demos/public/service-worker.js`, upstream proxy deployment

### Reject credentialed Fetch modes at the constrained proxy boundary

The constrained proxy rejects explicit credential headers, but a
service-worker `Request` can also carry a credential mode independently of its
visible header list. Before the proxy path is used for authenticated browser
traffic, reject `credentials: "include"` and other credential-bearing modes
instead of rebuilding them as anonymous requests. Add a real service-worker
test that proves rejection happens before dispatch.

**Files:** `apps/browser-demos/public/service-worker.js`,
`apps/browser-demos/test/browser-cors-proxy.spec.ts`

### Forward `Content-Encoding` request bodies verbatim through the proxy

git compresses the smart-HTTP `git-upload-pack` fetch request and sets
`Content-Encoding: gzip`. The browser TLS-MITM currently decodes such bodies to
identity and drops the header so the request fits the proxy's six-name
allow-list — a faithful *equivalent* of what the guest sent, but not a
faithful *representation* of it. The more complete behavior is to forward
`Content-Encoding` and the compressed body unchanged. That requires
`content-encoding` in the CORS proxy request-header allow-list (the same
treatment the relay and upstream proxy already give `git-protocol`) and the
upstream proxy echoing it in `Access-Control-Allow-Headers` so the browser
preflight passes. Until then the decode path in `tls-network-backend.ts` is the
compatibility shim.

**Files:** `host/src/networking/tls-network-backend.ts`,
`host/src/networking/browser-cors-proxy.ts`,
`apps/browser-demos/public/service-worker.js`,
`apps/browser-demos/vite/dev-cors-proxy.ts`, upstream CORS proxy deployment

### Provide a real CA bundle at the shared `SSL_CERT_FILE` path on Node

Both hosts export `SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt`, but the
rootfs ships only `/etc/ssl/cert.pem`. The browser worker creates
`ca-certificates.crt` at runtime holding the per-session MITM CA; the Node host
creates nothing, so `SSL_CERT_FILE`-honoring clients (curl, openssl) find no CA
file on Node and external HTTPS from those clients cannot verify. git's remote
helper happens to fall back to libcurl's compiled-in real-root bundle, so the
gap is masked today and the Node git test only exercises plain HTTP. The Node
host should populate `ca-certificates.crt` with real roots (or the image should
ship it), so the same VFS image verifies real certificates on Node and MITM
certificates in the browser.

**Files:** `host/src/node-kernel-host.ts`,
`host/src/node-kernel-worker-entry.ts`, `images/rootfs/etc/ssl/`

### PTY terminal integration with xterm.js
The kernel has full PTY support (PR #181), and browser UI surfaces should use xterm.js-backed PTYs rather than plain `<div>` output with `appendStdinData`. Connecting PTY pairs to xterm.js gives proper terminal rendering (ANSI escapes, cursor, scrollback) and real terminal behavior (isatty=true, proper termios).

### Make the Internals Syscalls tab show live syscalls, with an end-to-end test

Reported on 2026-10-30: the Syscalls tab of the Internals panel shows nothing on a running machine. Not yet investigated. Trace it through the normal path before changing the UI: `SyscallsTab` subscribes with `host.subscribeSyscalls`, which depends on the kernel worker publishing syscall trace events. Add a Playwright spec that boots a machine, opens Internals → Syscalls, and requires live records to appear, so the tab cannot silently go blank again.

**Files:** `apps/browser-demos/pages/kandelo/panes/Inspector.tsx` — `SyscallsTab`; `web-libs/kandelo-session/src/kernel-host.ts`; `host/src/kernel-worker.ts` (syscall trace events)

## Package artifacts

### Restore external software gallery support

The browser currently exposes only repository-defined gallery entries and
does not request explicitly configured package-source manifests. Package
sources publish independently from Kandelo, and constructing a URL for
Kandelo's current ABI before that source has published the matching index and
gallery creates a failing request rather than a usable catalog.

Restore this feature only with an explicit trust, coordination, and
availability contract. The browser should validate the ABI-matching index and
surface fetch or schema failures truthfully; support must not imply that an
unpublished generation exists.

**Files:** `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts`,
package-source publication workflows, `docs/package-sources.md`

### MariaDB's bootstrap is not reproducible

The `wordpress` image is byte-reproducible: its build-time installer runs
in deterministic image-build mode and each machine rotates its secrets on
first boot ("Reproducible VFS image packages" in
`docs/package-management.md`, which describes this gap in full). The
`lamp` image is not. Two builds under one key still differ in between 2
and about 76 files under `/data` (the count varies from pair to pair), all
from the MariaDB bootstrap, and all from the order in which the server's
threads run:

- The InnoDB redo log and system tablespace, in every pair: after bootstrap
  the log sequence number was 43931 or 43943 across builds, and even with
  equal sequence numbers about 970 bytes of `ib_logfile0` and 12 bytes of
  two `ibdata1` pages differ -- the order in which the background threads'
  mini-transactions land.
- One byte of a time-based UUID, in some pairs: the Aria server UUID in
  `aria_log_control` and every `.MAI` header, and the `.frm` table version
  of the system tables the bootstrap creates. MariaDB builds these from its
  monotonic clock; in deterministic mode that is the bootstrap thread's
  logical clock, which counts the thread's own reads, and how many reads it
  makes depends on how often it waits for the background threads.

A deterministic clock and entropy source cannot remove a difference in
thread order. Fewer InnoDB purge and I/O threads did not either.

**Chosen direction: serialized build-time scheduling.** A
build-time kernel runs guest threads one at a time in a fixed order: a run
token granted by the kernel at syscall boundaries, the kernel choosing
which runnable thread proceeds, virtual time advancing only when every
thread is blocked, new threads and forked children held until granted the
token, and a build-time watchdog that fails the build loudly if a thread
spins without making syscalls. Same security boundary as the deterministic
mode: no syscall, set once before any task, Node image builders only.

**It waits on moving blocking waits into Rust.** The scheduler needs the
kernel to know which threads are blocked and to decide every wakeup, and
today it does not: `futex` wait/wake is handled entirely in
`host/src/kernel-worker.ts` (`Atomics.waitAsync` on guest memory; the Rust
`kernel_futex` is bypassed), and sleeps, `waitpid`, `rt_sigtimedwait` and
the poll/select/accept/advisory-lock retries are parked in host lists and
resumed by host timers, several polling every 10, 50 or 500 ms of real
time. A scheduler layered on those would still order threads by host
timing, and writing it in TypeScript would put kernel scheduling policy in
the host. Moving futex, sleep, timed-wait and `waitpid` parking into the
Rust wait queue (`crates/runtime-core/src/wait_queue.rs`, which already
owns the deadlines) comes first; the scheduler follows it. The rejected alternatives: a pinned,
content-addressed pre-bootstrapped `/data` as a build input (fixes one
package, and hides a still non-reproducible step behind a checked-in
artifact), or accepting `lamp` as non-reproducible.

**Files:** `images/vfs/scripts/wordpress-preinstall.ts`,
`crates/runtime-core/src/image_build_determinism.rs`,
`crates/runtime-core/src/wait_queue.rs`, `host/src/kernel-worker.ts`

### `check-determinism run` cannot fetch sources under its fake clock

`xtask check-determinism run` gives each of its two builds a fresh source
cache and, when `faketime` is on `PATH` (the Nix dev shell provides it),
runs them at fixed wall clocks in 2001 and 2029. Source downloads then
fail TLS verification ("certificate not valid yet: verification time
981191313") after eight attempts, so on a cold source cache the first
build fails dozens of packages and blocks what depends on them (observed
2026-09-26 with `--product browser-nginx-php`: 61 FAILED, shell and
nginx-php-vfs BLOCKED). The clock the check varies should reach the build
steps, not the source fetcher: fetch outside `faketime` (or seed both
variations from one verified source cache, which the source digests
already pin) and apply the fake clock only to the builds.

**Files:** `tools/xtask/src/determinism_check.rs`

### PHP-FPM workers cannot add opcache entries under prewarmed directories

`opcache-prewarm.ts` writes the cache tree it dumps
(`/var/cache/opcache/<system-id>/var/www/...`) as root-owned `0755`
directories. The nginx-php image's FPM workers run as `nobody` (uid
65534), so a worker that compiles a PHP file the build did not prewarm (a
file added or edited from the demo terminal, or a replacement for an entry
it rejected) cannot store it: on the Node host, `file_put_contents` into
`/var/cache/opcache/<system-id>/var/www/html` fails with `EACCES`, and a
new script's entry never appears. The prewarmed entries themselves are
read and used. (The kernel enforces the parent-directory permission check
on its own filesystems, so the store fails at `mkdir` rather than at the
file.) The same applies to
the WordPress and LAMP images, whose build deliberately does not prewarm
`wp-config.php` (the host rewrites it at boot); PHP recompiles it on every
request. The fix belongs in the image builders: give the cache tree
the ownership and mode the runtime writer needs, as the WordPress builder
already does for its database directory.

**Files:** `images/vfs/scripts/opcache-prewarm.ts`, the PHP image builders

### Compare WordPress REST upload request paths

Checkpoint 1.34 profiling observes a valid browser-generated PNG submitted
as REST multipart form data returning HTTP 400 with
`rest_upload_image_type_not_supported`, while the existing tested raw
`image/png` POST with `Content-Disposition` succeeds. Real media-library UI
uploads also have passing coverage. This is an observed request-path
discrepancy, not evidence of filesystem corruption or a diagnosed parser bug.
Retain a comparison of multipart and raw REST uploads before changing PHP,
HTTP transport or file-type policy; do not weaken image validation to hide it.
See the [profiling evidence](measurements/2026-10-23-wordpress-persisted-navigation.md).

### Define compatibility for restored lazy VFS images

Kandelo currently rebuilds and publishes canonical VFS images for the current
runtime; it does not persist a machine image for restoration across releases.
Old lazy images can describe deferred files whose authenticated bytes
depend on the producer's guest prefix and relocation inputs. If a later host
uses different relocation defaults, allowing the image to boot and consulting
those defaults on first access can produce bytes that no longer match the
image's registered size and digest.

Before downloaded, shared, historical, or persisted lazy images become a
supported cross-release contract, image admission needs an explicit strategy:
carry and authenticate every relocation input needed to reproduce the
producer's deferred bytes, or reject an incompatible image before boot. The
runtime must not silently reinterpret authenticated image content through
mutable host defaults and fail only when a deferred file is first opened.

**Files:** `host/src/vfs/`, `images/vfs/`, package image builders and metadata

### PHP builds differ between checkouts

On 2026-10-30 a full setup in a second checkout of main (`e4bca8639e`) failed with `php@8.5.12: concurrent cache winner differs from staged build`: the shared cache already held a php/wasm32 artifact under the same key, built in another checkout, with different bytes. The build preserved the winner and recorded receipts, and a rerun took php from the cache. An earlier instance of this class was an absolute checkout path embedded in an artifact (`kandelo.calltypes`, fixed in `scripts/build-musl.sh`). Compare the two builds' receipts and bytes to find what php embeds from its checkout, and remove it so builds under one key are identical wherever they run.

**Files:** `packages/registry/php/`, the local-build cache-winner receipts

## Performance

### Revisit an optional wasm32 kernel build for IPC-heavy workloads
A May 6, 2026 prototype found that the Rust kernel can likely be built as
`wasm32-unknown-unknown` while keeping user-process pointer width independent
through the host's existing `ptrWidth` handling. The ABI 7 syscall channel
layout remained unchanged (72-byte header, 6 x i64 args, i64 return, i32
errno, 64KiB data buffer), and focused local tests covered wasm32 users,
wasm64 users, pipe IPC, and fork/exec on a wasm32 kernel.

The performance result was not stable enough to justify changing the default.
The first Node benchmark pass showed modest wins in some syscall and process
lifecycle paths, but the rerun was noisy: wasm32 process-lifecycle results
stayed close to the first run, while wasm32 syscall latency and wasm64 process
lifecycle numbers varied widely. Treat `kernel32.wasm` as a possible optional
artifact to investigate, not a replacement for the current wasm64 kernel path.

Any follow-up should:

- keep ABI 7 and wasm64 user-program support intact;
- keep the wasm64 kernel as the default until broader benchmark evidence exists;
- run all benchmark suites on both Node and browser hosts with repeated,
  alternating wasm32/wasm64 runs;
- check whether IPC time is dominated by host-side copying, wakeup scheduling,
  or retry logic rather than kernel pointer width;
- if the approach still looks useful, expose it as a separate `kernel32.wasm`
  build option.

### Copy between kernel and process memories with a multi-memory bridge module
Every byte that moves between a process and the kernel crosses two separate
`WebAssembly.Memory` objects. Wasm code can address only the memories it was
instantiated with, so today the kernel worker's JavaScript makes that hop, and
a pipe read travels pipe buffer → kernel scratch → the reader's syscall
channel area. Host-supplied stdin adds host → kernel scratch → pipe buffer in
front of that (ABI 47 made host stdin a kernel pipe so a forked child shares
fd 0 with its parent; see `docs/abi-versioning.md`).

A small reusable Wasm module could remove the JavaScript hop and the scratch
copies. It would import two memories (the kernel's and one process's, or a
pipe arena and a process's) and export only fixed-shape copies built on
cross-memory `memory.copy`. The host instantiates one per registered process
and places its exports in a table the kernel owns, and the kernel calls
through `call_indirect`, so no JavaScript sits on the copy path. A pipe read
then becomes one copy from the pipe buffer into the reader's destination, for
every pipe and socket, not only stdin. Importing existing memories reserves
no new memory, so this adds no declared ceiling for JavaScriptCore to charge.

The split must stay mechanism versus policy: the host supplies the bridge the
way it supplies the memory, and the kernel alone decides pid, addresses,
lengths, and ordering. Any follow-up should:

- verify multi-memory support in every shipped engine, JavaScriptCore first
  (V8 and SpiderMonkey ship it); without it the gain is not available on
  Safari/iOS;
- keep exactly one copy interface: if an engine lacks multi-memory, a
  JavaScript fallback (`Uint8Array.set`) implements the same interface and
  bounds, selected once at startup, never a second transfer implementation;
- rebuild a process's bridge when `exec` replaces its memory and create a new
  one for each `fork` child;
- keep bytes in kernel-owned buffers. Considered and rejected, 2026-09-28:
  leaving pipe bytes in the writer's memory (POSIX lets a writer reuse its
  buffer as soon as `write()` returns; a pipe outlives and is shared across
  writers), a shared pipe arena imported by every process (any process could
  read every pipe, and C cannot address a second memory), and a host-backed
  stdin stream that keeps all bytes in host memory (a second read path and
  more host surface to save one copy through a 64 KiB window);
- measure with the `stdin-throughput` and `syscall-io` suites on Node and
  browser, before and after.

### Close the Node gap in host stdin throughput
The `stdin-throughput` suite (24 MiB of host-supplied stdin read by one
process) measured the ABI 47 kernel-pipe path against the per-pid host
buffer it replaced on 2026-09-28, alternating runs at load average 6–10:

| Host | Per-pid host buffer (before) | Kernel pipe (ABI 47) |
|---|---|---|
| Node | 818, 796, 793 MiB/s | 691, 705, 679 MiB/s |
| Chromium | 727, 774 MiB/s | 800, 828 MiB/s |

Node is about 13–16% slower; Chromium is no worse (its runs take 30–33 ms and
the guest clock has 1 ms granularity there). The likely cause, not yet
profiled: the pipe holds 64 KiB, so 24 MiB takes about 384 refills, and if the
reader drains the pipe before the host refills it, each refill costs a
parked-worker wake. A second candidate is visible in the code: every refill
defers `notifyPipeReadable`, whose last step is a broad
`scheduleWakeBlockedRetries`, so 24 MiB schedules about 384 broad wakes of
every blocked retry. The follow-up should profile Node first; if wakes
dominate, refill within the kernel entry that drained the pipe so the reader
never observes it empty, and wake only this pipe's readers and pollers. A larger host-stdin pipe would also cut refills,
at a kernel-memory cost per spawned process. Copies are the less likely cause;
the bridge module above addresses them.

### Building small fork-instrumented SDL test programs takes minutes

The DRI resize and SDL2 evdev tests each build a small SDL2 program through the SDK, link it against the resolved SDL2, Wayland, xkbcommon and libffi packages, fork-instrument it and stamp it. On 2026-10-30 that took about 153 and 155 s, while the programs themselves ran in about 1 s. PR #1600 moved those builds out of the tests' time limits but did not make them faster. The split between compiling, linking and instrumentation was not measured; measure it first, then decide whether the instrumenter (for example its baseline when compiler facts are unavailable) or the link is the cost.

**Files:** `host/test/support/compile-sdk-fixture.ts`, `scripts/run-wasm-fork-instrument.sh`, `crates/fork-instrument/`

## Kernel — regressions

### wasm64 musl: missing `__NR_pselect6_time64` alias forces select() through SYS_select
`libc/musl-overlay/arch/wasm32posix/bits/syscall.h.in:109` defines `__NR_pselect6_time64 = __NR_pselect6`, so musl's `select.c` routes wasm32 through SYS_pselect6 (252). The wasm64 overlay omits that alias; musl falls through to `#ifdef SYS_select` and uses **SYS_select (103)** instead. The host gained a SYS_SELECT timeout-aware handler (kernel-worker.ts `handleSelect`) so this works correctly today, but as defense-in-depth the wasm64 overlay should mirror wasm32 — fewer code paths, single canonical entry point. Doing this requires rebuilding the cached wasm64 binaries (the libc.a baked into them changes), so it's a coordinated rebuild task.

**Files:** `libc/musl-overlay/arch/wasm64posix/bits/syscall.h.in`

### Audit other PR #383 callers that may have missed the `GLOBAL_PIPE_PID` migration
PR #383 (`fix(kernel): share AF_INET accept queue across fork — nginx multi-worker`, May 2026) moved injected-connection pipes to the kernel's GLOBAL pipe table. `kernel_pipe_{read,write,close_*,is_*_open}` now treat `pid == 0` as a sentinel meaning "use the global pipe table". The HTTP bridge in `host/src/browser-kernel-worker-entry.ts` and `NodeKernelHost` were updated; `apps/browser-demos/lib/mysql-client.ts` and `apps/browser-demos/lib/redis-client.ts` have since been fixed. **Audit any future call site that does `kernel.injectConnection(...)` and then `kernel.pipeRead/pipeWrite` with a non-zero pid** — it will be broken in the same way (silent EBADF; bytes never reach the accepted worker).

**Files:** `apps/browser-demos/lib/*-client.ts`, anything calling `BrowserKernel.injectConnection`. Convention: store `this.pid = 0` (or import `GLOBAL_PIPE_PID = 0`) for all pipe ops on injected pipes.

## Host runtime

### Contain initial scanout context acquisition failures

A user reported `OffscreenCanvas.getContext: Cannot update created context
to different thread` while replacing ScummVM's launcher with Beneath a Steel
Sky. The exception escaped `tryAttachKmsGlCanvas` through the kernel's host
import and failed the kernel worker; a subsequent Freeciv launch repeated
that already-failed kernel's error, not an independent Freeciv failure or
evidence of persistence corruption.

A standalone page reproduces repeated same-worker context-acquisition
failure on installed Firefox 159, while bundled Firefox 155 does not. The
canvas-owned acquisition cache avoids that repeated call; the reproduction,
controls and removal criteria are in
`tests/runtime-workarounds/FIREFOX-OFFSCREEN-CONTEXT-REACQUISITION/`.
Sender collection was not established as a cause. Passing bundled-browser
tests did not establish installed-browser behavior.

Initial acquisition can still fail independently of that workaround. A host canvas
exception should produce an honest guest-visible context-creation failure,
not abort unrelated processes. The current host context-creation import
returns no status; changing that contract requires coordinated Rust/host ABI
work, not swallowing the exception and pretending EGL succeeded. Include
error-injection tests and same-kernel application replacement coverage.

### Preserve receipts for deferred Playwright storage cleanup

A persistence acceptance run can finish while another Playwright WebKit
browser remains alive. The conservative teardown then retains its storage
instead of sweeping a live browser's files. Persist the exact run-owned root
and staging-file inventory/identities when deferring, and include the retained
root in the warning, so a later no-browser/no-open-descriptor pass can safely
reclaim it. Do not infer ownership solely from a filename prefix or age, and
do not turn missing receipts into permission to sweep global WebKit storage.
This is test-runner housekeeping, not a filesystem durability guarantee.

### Await TLS record writes before closing their streams

ScummVM game-download and activity-replacement coverage exposed Chromium
page errors saying `Cannot write to a CLOSED writable stream`, independently
of the Firefox canvas failure. The stack reaches the vendored browser TLS
implementation's `writeTLSRecord`: its final
`clientDownstreamWriter.write(record)` promise is not awaited or returned.
The caller can therefore finish encryption before the stream write settles,
and a rejected write is not observed by its surrounding async operation.

Preserve write ordering and backpressure through record emission, handle
shutdown while encryption is pending, and retire stream owners explicitly.
Add deterministic deferred-write/close tests. Do not suppress browser page
errors in activity tests or treat an error-free game render as proof that
the download's asynchronous owners finished successfully.

**Files:** `packages/registry/openssl/src/tls/1_2/connection.ts`,
`host/src/networking/tls-network-backend.ts`.

### Honor listener backlog and define accept preparation headroom

The persistent WordPress investigation exposed contention between injected
HTTP sockets and other ordinary kernel I/O owners. Host admission and
token-scoped cancellation bound the supported host HTTP path; they do not
make arbitrary guest socket pressure infallible. `listen` still does not
enforce the requested backlog, and preparing an accepted socket's descriptor
and backing can fail before dequeue when ordinary admission is exhausted.
Define queue admission and failure/retry semantics through the ordinary
socket implementation, with accept-wins/cancel-wins and descriptor-preparation
failure tests. Do not hide the problem by globally raising I/O limits or
adding a guessed reserve. This is broader socket hardening, not another
requirement for the OPFS byte adapter or permission to lose accepted ownership.

### Complete SpiderMonkey nonblocking TLS cancellation and write ordering

The native Node compatibility layer now retries OpenSSL `WANT_READ` and
`WANT_WRITE` through the existing readiness dispatcher, which is sufficient
for ordinary HTTPS and npm traffic. Two lifecycle edges remain to harden:

- serialize concurrent writes per TLS handle so a later write cannot enter
  OpenSSL while an earlier write is waiting to retry; and
- retain a cancellation handle for a handshake that has not produced a socket
  object yet, so destroying the JavaScript socket can unlink its readiness
  watch and release the file descriptor, `SSL`, and context exactly once.

Add focused cases for two writes where the first returns `WANT_WRITE`, and for
socket destruction while a handshake remains pending.

**Files:** `packages/registry/node-compat/bootstrap.js`,
`packages/registry/spidermonkey/patches/0012-kandelo-node-compat-shell-entry.patch`

### Resolve main-script relative imports in SpiderMonkey Node compatibility

The installed cowsay package works through its public module API, but directly
executing its CLI currently fails to resolve `./index` relative to the package
entry script. Fix the main-script module base so normal installed bin shims can
run without an API-level invocation, then restore browser acceptance to execute
`./node_modules/.bin/cowsay Kandelo` through the ordinary shell path.

**Files:** `packages/registry/node-compat/bootstrap.js`,
`apps/browser-demos/test/kandelo-node.spec.ts`

### Runtime tuning for the default pthread limit
Kernel worker creation currently accepts `defaultThreadSlots`, and processes
that declare `__wasm_posix_thread_slots = -1` use that boot-time default.
The next step is a runtime control surface, likely under `/sys` or `/proc`,
so an integration can tune the host default pthread concurrency limit without
rebuilding the SDK output or recreating the worker.

**Files:** `host/src/browser-kernel-worker-entry.ts`,
`host/src/node-kernel-worker-entry.ts`, `host/src/process-memory.ts`

### Move pthread control channels to a separate Wasm control memory
WebAssembly multi-memory can eventually split guest process memory from
host/kernel communication memory. That would let pthread syscall channels,
spill buffers, and fork-save scratch storage grow in a separate per-process
control memory instead of being statically reserved in the guest process memory
prefix. Safari/iOS Safari support is not sufficient for this to be the only
browser ABI yet, so this remains future work with a single-memory fallback.

**Plan:** `docs/plans/2026-06-04-pthread-control-memory-multimemory-plan.md`

### Use a tracked dlopen memory arena instead of one mmap per side module
`host/src/worker-main.ts` currently allocates each dlopen side module's
linear-memory data with a synchronous anonymous `mmap` through the syscall
channel. That is intentionally correct for address-space accounting: the
kernel's mmap allocator records the range, so later guest mmaps cannot overlap
and zero side-module data/GOT by accident.

The cleaner version is a small per-process dlopen arena: reserve one tracked
anonymous mmap region on first `dlopen`, then suballocate side-module data from
that arena with the dylink alignment requirements. This would reduce syscall
traffic, avoid page-sized waste for many tiny side modules, and give `dlclose`
a clearer place to reclaim or recycle side-module data later.

**Files:** `host/src/worker-main.ts` (`buildDlopenImports`),
`host/src/dylink.ts` (`LoadSharedLibraryOptions.allocateMemory`).
### Clarify and encapsulate dlopen side-module memory allocation
`host/src/dylink.ts` exposes the lower-level `DynamicLinker` machinery used
to parse `dylink.0`, lay out side-module data, apply relocations, and resolve
symbols. The real process path is broader: guest C `dlopen()` enters
`libc/glue/dlopen.c`, calls the worker import in `host/src/worker-main.ts`, and
then reaches `DynamicLinker` with a runtime-provided allocator.

That split is useful, but it should be harder for tests and production to
accidentally exercise different contracts. The practical regression test for
runtime dlopen behavior should be an integration test such as
`examples/dlopen/test.test.ts`, because it covers the same path used by real
guest programs. Lower-level `DynamicLinker` tests are still useful for linker
internals, but they should be described and structured as core-linker coverage,
not as evidence that guest `dlopen()` works end to end.

Future cleanup:

- extract the process-worker side-module allocator into a named helper or
  small object, for example `createDlopenDataAllocator(...)`;
- make that helper's contract explicit: allocated side-module data must be
  visible to the guest address-space manager, so later guest `mmap()` calls
  cannot overlap and zero it;
- keep syscall/channel details out of `DynamicLinker`; it should require an
  allocator, while the process worker supplies the runtime-specific tracked
  mmap allocator;
- consider replacing one mmap per side module with a tracked per-process
  dlopen arena that reserves one anonymous mmap and suballocates with dylink
  alignment;
- keep `examples/dlopen/test.test.ts` or an equivalent guest-level test as the
  primary regression test whenever changing dlopen allocation behavior.

**Files:** `host/src/worker-main.ts` (`buildDlopenImports`),
`host/src/dylink.ts` (`DynamicLinker`, `LoadSharedLibraryOptions`),
`examples/dlopen/test.test.ts`, `host/test/dylink.test.ts`.

## User-space programs

### Add a real shadow-stack overflow guard beyond the SDK's 8 MiB floor
Upstream `wasm-ld` reserves a default 64 KiB shadow stack (the linear-memory
region the compiler uses for spilled locals, `alloca`, and address-taken
locals). Kandelo's SDK applies an 8 MiB default to executable links that make
no explicit stack-size request, and honours an explicit request verbatim
(with a warning below the default). That default covers the mainstream
workloads that exposed the 64 KiB `wasm-ld` default, but it is a capacity
policy rather than an overflow guard.

The shadow stack grows **downward** from `__stack_high`, and `wasm-ld` places it
*immediately below* the `.data` / `.bss` segments in the same linear memory.
There is no guard page, no stack-pointer bounds check, and no trap: a function
that consumes more than the effective shadow-stack budget silently writes
through `__stack_pointer` into whatever data segment happens to be just below
it, corrupting unrelated globals.

PR #423 (PHP opcache) hit this concretely. `zend_build_ssa` (PASS_6, the
DFA-based SSA optimization pass) recurses deeply on real-world PHP files; the
shadow-stack frame underflowed by ~108 KiB into PHP's `alloc_globals` data
segment, silently corrupting `AG(mm_heap)`. The next `_efree` call dereferenced
the now-bogus heap pointer and trapped — surfacing as "memory access out of
bounds" inside the optimizer, with no indication that the actual cause was
stack overflow ~thousands of frames earlier. The PHP recipe originally worked
around this with an explicit `LDFLAGS=-Wl,-z,stack-size=4194304` (4 MiB)
request; since that value sat below the SDK's 8 MiB default and the SDK at
the time silently raised any sub-floor request to the default, the recipe was
already linking with 8 MiB in practice, so the explicit flag recorded an
intention nobody had actually verified. It has since been removed (the SDK
now honours an explicit sub-floor request instead of silently discarding it,
so leaving a stale 4 MiB flag in place would have started actually shrinking
the reservation) and PHP now links with the SDK's 8 MiB default like any
other package that makes no request. The 8 MiB reserve covers PHP's observed
workload but doesn't *prevent* the failure mode: a deeper recursion or a
larger `alloca` can still silently corrupt data, and every linked program has
the same undetected-overflow risk.

A real fix needs runtime detection so the failure surfaces as an obvious
crash, not silent corruption. Possible approaches:

- **Stack-pointer bounds check on syscall entry**: the channel-syscall glue
  already reads `__stack_pointer` for other reasons (`worker-main.ts`,
  `libc/glue/channel_syscall.c`). Adding `__stack_pointer < __stack_low` →
  `kill(SIGSEGV)` at each syscall entry would catch overflow at the next
  kernel crossing. Cheap to implement, low overhead, but only catches
  overflow when the program eventually calls into the kernel — silent
  corruption between syscalls is still possible.
- **`-fstack-check` / `-fstack-clash-protection`**: clang emits explicit
  page-touching probes for every function prologue when the frame exceeds a
  threshold. Catches overflow at the moment it happens, with no
  kernel-side cost, but inflates code size and may not be fully supported
  for the wasm target.
- **Linker-emitted stack-overflow check**: `wasm-ld` has a `-z stack-overflow-check`
  proposal in upstream binaryen / LLVM discussions. Worth tracking whether
  it ships and whether it interacts with our musl + fork-instrument
  pipeline.
- **Guard-page-style trap region**: reserve unmapped pages just below
  `__stack_low` so any underflow store traps cleanly. Wasm's linear memory
  has no native "unmapped" concept, but the kernel could mark a sentinel
  region and trap on writes to it via `kernel_*` checks at syscall time
  (degrades to the bounds-check approach above).

Once a real guard is in place, the remaining per-program
`-Wl,-z,stack-size=...` overrides should be audited: a package task already
removed eight call sites across seven packages (sqlite-cli, vim, sqlite's
testfixture build, bash, git, ruby's two call sites, and php) whose explicit
request was below the SDK's 8 MiB default and so was already linking at the
default in practice — recording an intention nobody had actually formed.
mariadb's two toolchain files had the same explicit 1 MiB request, but
mariadb links through raw clang rather than through `wasm32posix-cc`, so it
gets no SDK-applied default to fall back to; its flag was restored rather
than removed, since deleting it would have silently dropped mariadb to
`wasm-ld`'s own ~64 KiB default instead of any 8 MiB floor. Programs that
genuinely need a shadow stack *larger* than the SDK default (SpiderMonkey's
16 MiB is the current example) should keep their explicit override and
document why; everything else that goes through the SDK driver should rely
on the SDK default plus the guard, with no package-local flag at all.

**Files:** `crates/kandelo-cc/src/flags.rs` and `sdk/kandelo/bin/wasm32posix-cc` (current
8 MiB default), `packages/registry/php/build-php.sh` (no stack-size override;
relies on the SDK default), `libc/glue/channel_syscall.c` (likely site for a
syscall-entry bounds check), `host/src/worker-main.ts` (instantiation-time
wiring for stack bounds), plus any other `build-*.sh` that hits the same wall
in the meantime.

**Related:** PR #423 (commit `fa9f579f6 feat(php): make opcache fully load opcache.so + survive PASS_6`) for the original root-cause analysis.

## Testing

### Restore the Doom network-invitation smoke test

The persistence follow-up's Chromium smoke test
`kandelo-network-session.spec.ts` ("Doom's package offer acquires a WAD from
bare shell and sends it to the player over WebRTC") currently fails before
joining. The host link decodes to a complete `fbdoom` offer, but after the
recipient opens the link, closes the invitation to inspect its terminal, and
reopens the network dialog, the dialog says "Shared network · no activity
selected" instead of showing the Deathmatch/E1M2 metadata. A fresh run with an
explicit decoded-offer publication barrier reproduces it. File transfer and
multiplayer startup are therefore not validated by that case.

Trace invitation ownership across computer creation, terminal inspection and
dialog reopening; establish whether the test's navigation sequence still
matches the intended UI contract before changing production behavior. Keep
the real guest-process, settings and peer-transfer assertions rather than
removing them or treating a plain network invitation as an activity invite.
The separate persistent Doom save/load, WAD recovery and WAD exchange tests
pass in Chromium, Firefox and WebKit; they do not cover this invitation flow.

Evidence: `.context/persistent-homes-network-final-output` and agent job
`persistent-homes-final-validation-1029-154717-c4f4`. This observation is not
attributed to a browser engine or the storage backend.

### Avoid repeated unrelated program-index regeneration on source-checkout boot

The ABI-55 persistence comparison finds a real developer-workflow cost in
Node's automatic default-rootfs selection. Preferring the current registry
rootfs over a possibly stale packaged alias enters `withFreshProgramIndexes`,
which regenerates/checks the complete source program projection on every
lookup. Three phase observations spend 2.05–2.52 seconds resolving that image;
explicit-image initialization takes 252–265 ms instead of 2.22–2.32 seconds.
Guest hello execution remains about 90–97 ms. This is not OPFS read latency,
but it must not be called a neutral default-boot change.

Teach resolution to prove the selected current generation without repeatedly
rebuilding unrelated registry context. Preserve ordered-registry precedence,
complete package closures, source/ABI identity, member hashes and refusals of
present-but-invalid artifacts. Reverting to the older alias, caching a path
forever, suppressing provenance checks or bypassing the normal resolver in
benchmarks is not an acceptable fix. Existing synchronous freshness boundaries
can batch callers, but an asynchronous operation must not borrow a global
boundary after its scope has ended. Add mutation, replacement and stale-index
controls before accepting any memoization. The current persistent-image paths
use explicit installed images and do not require this development-only source
projection step. See the ABI-55 persistence acceptance record for retained
full-suite comparisons and phase attribution.

### Freeze prepared product projections during acceptance

The ABI-55 persistence batch overlaps its Node/conformance consumers with
normal browser-product preparation. One resolver correctly rejects a lamp
member whose new file size no longer matches the metadata captured by that
consumer; another stops because the registry changes during projection
generation. Neither is evidence of a guest filesystem failure, but both
invalidate an otherwise expensive acceptance batch. Normal Vitest setup
also legitimately replaces private SDK-helper outputs with its own
source/toolchain-fingerprinted recipe, so an earlier helper-only hash list
cannot remain authoritative for those paths.

Provision first, record each fixture's actual builder and freeze product
identities before starting consumers. Consider a reader lease or immutable
generation-root capture so a running consumer can retain a verified closure
while another build publishes a new projection. Keep the current size,
content, ABI and single-provenance-tier checks; do not resolve this by mixing
generations, accepting stale metadata or retrying guest operations. Source
and artifact receipts must distinguish declaration-only host checking from
`npm run build`, which actually replaces the JavaScript worker bundles.

### Avoid redundant native debug builds in prepared-product setup

The host global setup still invokes `cargo run -p xtask` even when a matching
release tool is already supplied through `WASM_POSIX_XTASK_BIN`. During a
persistence acceptance run, default debug information and incremental outputs
exhausted the remaining disk before tests started. Prefer a verified prepared
tool and retain a canonical build fallback with an explicit resource profile.
Environment exports in a child builder do not propagate back to the parent
validation script; the resource profile must cover the actual setup process.
This is build/test hardening, not an OPFS filesystem completion prerequisite.

### Reclaim deferred run-owned WebKit storage safely

Current teardown deliberately skips cleanup while any Playwright WebKit is
alive. Concurrent runs can therefore leave an owned home after its original
runner exits, and the PID ownership guard correctly prevents a new process
from claiming it. Add a recorded deferred-cleanup handoff with process-death,
file-identity and closed-descriptor checks, without weakening live-run or
global-store protections. Do not rewrite ownership records or sweep the user's
existing WebKit store to compensate for a skipped teardown.

### Type-check browser and host test fixtures before running them

The browser app TypeScript project includes `lib` and `pages`, not Playwright
tests; the host project similarly includes `src`, not Vitest fixtures.
Transpilation alone can therefore admit a test that calls a nonexistent
runtime method. A persistence recovery fixture exposed this with a misspelled
shutdown-ownership query, wasting a browser cohort and masking earlier errors
inside cleanup. Add dedicated no-emit test projects with the appropriate
Node/browser/test-runner types and run their checks before expensive suites.
Keep production emit roots separate and retain real browser validation;
type checking cannot prove storage closure or recovery behavior.

### Browser-host vitest parity via `@vitest/browser`
Today's host test coverage is asymmetric: `host/test/*.test.ts` runs 56 vitest files against the Node host (kernel worker, NodeKernelHost, NodePlatformIO, syscall behavior, dlopen, mmap, fork via worker_threads), but the browser host is exercised only by:

- `host/test/browser-worker-adapter.test.ts` — single vitest file using mocked Web Workers in Node; does not run real browser code.
- `host/test/php-browser.spec.ts` — Playwright, one fixture.
- `apps/browser-demos/test/*.spec.ts` - Playwright over the Kandelo UI and retained browser labs.

Real-browser regressions land here repeatedly because the Node vitest suite is the de-facto fast feedback loop, and Playwright tests are slow and often `@slow`-tagged in CI. The dual-host-parity requirement (`CLAUDE.md` -> *Two hosts: Browser AND Node.js*) is enforced by review prompts, not by tests - which has already failed twice (PRs #388 and #410 shipped Node-only fixes that broke browser behavior with no test signal).

The structural fix is to stand up `@vitest/browser` (Vitest's official browser provider, Playwright or WebdriverIO transport) so the existing `host/test/*.test.ts` suite can re-run inside a real Chromium. Each test that doesn't depend on Node-only APIs (worker_threads, fs from Node, etc.) becomes free dual-host coverage. The tests that *do* hit Node-only APIs would either be tagged `@node-only` or refactored against the host abstractions (`PlatformIO`, `WorkerAdapter`) so they pass through `BrowserWorkerAdapter` + `VirtualPlatformIO` in browser mode.

Approximate scope:

- `host/vitest.config.ts`: add a `browser` workspace project (Vitest 3.x supports per-project provider config).
- Per-test audit: most fork/exec/pipe/socket tests should run unchanged once `node:fs`/`node:worker_threads` imports are routed through host adapters. File-resolution helpers (e.g., `tryResolveBinary`, `centralized-test-helper.ts`) need a browser-side equivalent that fetches `.wasm` via `import.meta.glob` or a vite-served URL.
- CI: a new job under `prepare-merge.yml` / `staging-build.yml`'s `test-gate` runs the browser vitest project. Should run in headless Chromium against pre-built kernel + fixtures, not require a full demo page.
- Migration is incremental: light up the browser project, run it with `--bail=0`, audit failures, tag genuinely Node-only tests, refactor the rest.

End state: a regression that shows up only on the browser host (signal delivery race, worker exit message wiring, dlopen GOT handling) fails a vitest test in the same PR, not a Playwright demo or a user-reported `./run.sh browser` failure.

**Files:** `host/vitest.config.ts`, `host/test/centralized-test-helper.ts`, `host/test/*.test.ts` (per-test audit), `host/src/worker-adapter-browser.ts`, `.github/workflows/prepare-merge.yml`, `.github/workflows/staging-build.yml`.

**Related:** `CLAUDE.md` § *Two hosts: Browser AND Node.js — DUAL-HOST PARITY IS LOAD-BEARING*; PR #388 (brk-base) and PR #410 (a_crash trap) as the failure-mode precedents this would close.

### Fork-instrument callback discovery broadening
PR #307's C3/C4 fixtures pass through the existing direct + table/`call_indirect`
closure, so the originally proposed "instrument every address-taken function"
rule was not added. If a future port registers a fork-calling callback that is
not discovered by that closure, implement a targeted callback-root rule rather
than broad full address-taken expansion. Two approaches:

- **Inter-procedural analysis:** identify `sigaction()` / `signal()` / `pthread_cleanup_push()` callers and propagate the function-pointer argument to determine which functions are actually registered as callbacks. Requires constant-propagation through the wasm bytecode. Complex but tool-internal.
- **Libc-hook approach:** intercept `sigaction()` / `signal()` / `pthread_cleanup_push()` at the libc layer (a wpk-specific override in musl-overlay) and surface the registered callbacks to the kernel at runtime. The fork-instrument tool then doesn't need to discover them statically — it instruments only the call graph from `kernel_fork`, and the kernel rejects fork attempts from un-instrumented callbacks at delivery time. Simpler to implement but breaks the "fork from anywhere works statically" property.

Any targeted rule must cover the callback-registration entry points proven by
the current regression matrix:

- `sigaction()` / `signal()` — signal handlers (C3).
- `pthread_cleanup_push()` — pthread cancellation cleanup handlers (C4).
- Any future address-taken host callback (`atexit`, `pthread_atfork`, `pthread_key_create` destructors, `qsort` comparators if they ever fork — pathological but possible).

Trigger criterion: a shipping port reaches `fork()` from a registered callback
that is absent from `wasm-fork-instrument --discover-only` output and fails at
runtime because the callback's call chain was not instrumented.

**Files:** `crates/fork-instrument/src/call_graph.rs` plus a possible
`instrument::analyze_callback_registrations` pass.

### Commit baseline test results keyed on what each suite reads

Batch PRs classify every failure against main by rebuilding main in a second checkout and rerunning the full suites there, which takes hours and was thrown away each time. Main's known Vitest and Playwright failures lived only in run logs. Commit a small per-suite record of every result other than a plain pass (failure, expected failure, timeout, error, skip, intermittent, each with a one-line reason), plus totals and provenance. Key it not on the commit but on a digest of what the suite actually consumes: the built artifacts it used, the source paths it was measured to read, and the browser and Node versions. A README change then leaves every baseline current, and a reviewer sees a PR's change in results as a diff. A baseline records reality: it never turns a failing run green, and a stale one is never used for classification.

**Files:** new `tests/baselines/`, an xtask command to record, check and classify, `docs/agent-guidance/validation.md`

The A3 reset-scope follow-up keeps D-49/D-50 logical resets local in libc,
with a checked failure-only receipt and physical-loss share-group propagation.
Focused native C, host, Rust and browser device-double controls cover it;
the final normal-built graphics, desktop and browser-memory runs still need
the resulting archive/kernel/program/image set. This does not complete B1's
shared program ownership or any B2–B6/C1–C3 stage.

The B1 default-target increment removes error-query requests for a proven
zero-target bind/clear prefix. It does not complete the shared program/
executable model or the remaining object/draw error families. Those, B2–B6 and
C1–C3 remain required in this iteration, with normal SDK artifacts, application
measurements and the complete native-feel ship bar.

The C driver now maintains typed namespace, current-context and shader
attachment records through checked creation/mutation receipts. Creation
metadata is reserved before native publication; cancellation and unknown
replies preserve ownership. Current selection still waits for its receipt.

The host now exposes optional context-owned executable capture, checked
selection and release receipts. It ends each context's cache at retirement,
while accepted work retains independent native custody. A retired execution
no longer retains a deleted public program name. Internal group captures
remain private, and stale/peer-owned generations cannot manufacture a valid
selection. The real three-engine retirement regression and failed/successful
peer-relink controls are retained in the graphics compatibility ledger.

The C driver now consumes cold capture/release receipts into bounded selected
and prepared-generation descriptors. Embedded transport storage avoids later C
reply allocation, uncertain replies stop new captures, and EGL serializes C
capture/name retirement with acknowledged host context destruction. Checked
diagnostic program selection remains synchronous. The host logical journal now
reserves pending/result cells and independent generation/context custody,
separates logical names from installed execution, and delays host-computed
errors until their command positions. Checked kernel/host transport now
validates current-session authority, publishes batches, executes own-context
selectors and retains recoverable receipts. Wire-only metadata abandoned at
context/session retirement is reclaimed; accepted asynchronous jobs must gain
separate slot custody before C1 admission. The explicitly admitted C
prototype now connects its immutable shared queue,32-entry generation-
token cache, 256 bounded slots, caller-prefix submission and retained-
receipt recovery. Ordinary applications now admit eligible selections
automatically; checked selection remains the diagnostic and unknown-state path.
Native OOM during connected C selector execution now has passing three-
engine peer-isolation and explicit retirement controls, including an
independent ownership sample before process exit. Unexpected exceptions
in a preflighted journal transaction now latch a fatal host fault before
further work, and completion is sealed after all receipt fields.
Completed-copyout recovery remains available. Final B1 acceptance still
requires closure of the independent native-loss, uncertain-prefix and
final-context ownership audit. The known lost-final-publisher
retirement path now reaches backend acknowledgement before releasing its
exact C receivers. Healthy unadmitted peers can carry metadata through a
receiver reserved before local acceptance; unavailable reset proof
retains ownership with a diagnostic. Foreign publication loss marks its
actual owner through atomic reset/error state, preserving healthy peers
and unrelated errors. Three-engine physical and logical-loss regressions
sample complete explicit cleanup before guest exit; they do not replace
the full audit or application acceptance. The focused interrupted
logical publication case now recovers only its snapshot-proven prefix.
Ordered transport-error markers now prevent an earlier retained flag
from reappearing after successful publication recovery, while preserving
unrelated flags and later repetitions. Shared dispatch/lifecycle guards
now nest on the owning thread while retaining peer exclusion and
cancellation ordering; only the outer name scope reconciles unpublished
external candidates. Query, submission and EGL retirement hooks now
publish metadata without flushing foreign mutable encoders. Audit the
final context collector alongside the remaining failure paths. Reserve
all fallible ownership/result metadata before local acceptance. Never
query a destroyed session, flush a foreign mutable encoder or reuse the
rejected name-only cache. A private native pin does not establish
logical ownership. These steps remain current-iteration B1 work; cold
executable custody does not complete B1 or demonstrate an application
performance improvement. Full B2–B6, C1–C3 and all correctness,
conformance, memory and native-feel gates remain required in their
agreed order.

The current B1 prototype now preserves exact error knowledge across a
fresh large array-buffer definition and its immediate fill in one
uninterrupted prefix. Refused definitions stop before fill; lost
accepted binds use actual binding presence while retaining conservative
error observation. Independent native and three-engine byte/rendering
controls cover both fixes. In the frozen SDK workload,20 uploads
of128KiB change from20 to4 device entries; two command-buffer rollovers
each require a submit and error drain. The other13 measured operation
families retain their request counts. This is an operation- count result
against4de407f20f, not main, application latency, total overhead or
native-feel acceptance. Remaining B1 upload/draw/object families,
ordinary activation and complete stage validation still need closure before a
complete normal-built B1 preview. ScummVM's <=10 total-request gate is required
at B2 completion under the maintainer's stage-allocation decision.
B2–B6 and C1–C3 remain required in their recorded order.

The admitted B1 prototype now predicts small matrix2/3/4 errors from a
bounded exact-generation signature cache. The installed executable stays
independent of mutable public names across peer relinks, rejected
selections and deletion. Original records retain independent host
validation. In24 same-engine-version SDK/GPU comparisons, warmed matrix
calls change20 to0 device requests for admitted contexts; ordinary
contexts remain20 and the other13 API-family records are identical. Cold
signature acquisition remains explicit work. This is a prototype
operation-count result against intermediate1b8, not application latency,
main or native-feel acceptance. Ordinary activation, remaining required
hot families, full stage gates and the complete normal-built preview
remain required; B4's once-per-link public interface cache is still
separate work.

R395 extends that exact-generation proof to small scalar/vector/boolean
and sampler setters. All36 GPU modes pass on three engines and both widths,
including production and fatal audit, with40 correctness/request scenarios
per mode. Matched old/new admitted wasm32 production controls keep the same
engine/kernel and original14 family records:38 scenarios change four warmed
requests to zero and two already-local cases remain zero. The complete
40-scenario cold totals increase39 to50 requests on each engine; cold work
is not hidden. Existing native487, graphics2193/88, Node18/6, ABI and evidence709
checks pass. The full host compiler still fails the identical24 diagnostics.
This is an SDK operation-count result against intermediate d099, not current
application or native-feel evidence; remaining B1 draw/attribute authority,
conformance, matched measurements and complete-preview acceptance remain open.
Exact scripts, frozen sources, cold/warm records and comparisons are in
`.context/graphics-uniform-proof-r395/`.

R398/R400 add the owned-generation proof for selected small inline client
arrays and preserve old pointer metadata when a rollover refuses a new
attribute definition. Final native488, graphics2193/88, Node18/6 and36 GPU
modes pass, with the identical24 compiler diagnostics still open. Three of
seven inline scenarios change four warmed device requests to zero; complete
warm totals28 to16 and cold7 to11 are retained. Mixed buffers, multiple
samplers and framebuffer uncertainty preserve observation. Actual ScummVM's
recorded draws are buffer-backed, so these inline results do not establish
an application improvement or closure of its draw drains. Required buffer/
storage authority and actual application/conformance/latency gates remain
open. See `.context/graphics-inline-proof-r398/` and
`.context/graphics-pointer-reservation-r400/`; no complete B1 preview is
announced. The maintainer wants to wait for all B1 changes.

The optional guest-kind signature now distinguishes external and ordinary2D
samplers despite their identical native setter type, and preserves translated
cube kinds. Same-kind multi-sampler and array proofs remain scoped to selected
inline draws; mixed kinds keep observation. Legacy action8 is unchanged;
action9 is an additive Program contract requiring coherent normal rebuilds
under the reserved56/3/17/21 family. The Rust entry shape and authority are
checked independently from host reflection. Required VBO storage and offscreen
framebuffer authority, actual application/native-feel measurements and full
B1 acceptance remain unfinished. R414's36 GPU modes, graphics2196/88,
Node18/6 and ABI/evidence controls pass; the overall command remains failed
on the identical24 compiler diagnostics. R413 passes3645 workspace Rust
checks and its normal kernel build. The matched10-scenario browser request
comparison (warm28→20, cold18→21 on each engine) is operation attribution,
not application or native-feel evidence; complete records are retained in
`.context/graphics-sampler-final-r414/`. The full B1 preview notification waits
for all B1 changes at the maintainer's request.

C publication must also precede EGL lifetime mutations made without a current
GL binding. The optional0x3c lifecycle barrier now supplies checked metadata-only
authority through a live owned public context; ordinary0x3b current-thread
checks and native submission authority are unchanged. The explicitly admitted
prototype now integrates it into C lifetime guards and the immutable queue.
Group-level receipt recovery prevents a second publisher from replaying entered
intents after response loss. Read-only receipt recovery must preserve execution
loss. Group ownership is checked before inherited fork mutexes are touched.
Automatic activation, remaining attribute/draw and other required hot paths,
full B1 correctness/conformance and ScummVM round-trip measurements remain open.
A foreign mutable encoder is never a source of submitted commands.

The automatic-admission B1 prototype now starts at the first eligible program
selection, without an application-specific enable call. The checked diagnostic
mode remains available through KANDELO_GL_CHECKED_PROGRAM_SELECTION, sampled
once per context. Its focused108-case three-engine gate includes normal
sharing/creation/target behavior and automatic hot-path controls, while the
frozen b45e892d35 normal preview build is complete and available separately
from final validation. The measured pre-fix ScummVM inventory still uses25 GL
device requests between produced front copies; these are not display timestamps.
A standalone rejected numeric getter no longer discards independent program-name
knowledge. Twelve getter/error/output/selection controls per hot-path case pass
across both widths, three engines and production/fatal modes. Application impact
has rebuilt request-count evidence below; current-tree latency and full stage
acceptance remain open. The <=10 target is required at B2 completion.
Remaining binds and draw/attribute authority
must follow the measured path rather than inferred uniform costs: decimal query
43 is QOP_BIND_BUFFER (0x2b), not a uniform setter. The full864-case R298 component
regression passes, including pre-exit ownership and all new getter proofs.
Further application tracing shows13 changing ARRAY_BUFFER selectors per front
interval, so redundant binding elimination does not address that measured path.
The next normal producer is frozen17d1b52e8a. R340's independent313-file
snapshot of its successful normal setup now supplies12 checked/automatic
ScummVM cohorts across three engines: every2055 automatic interval has24
requests, compared with25 in every2331 checked interval. Both retain13
buffer binds,3 image binds and6 error drains; automatic selection replaces
2 program mutations with1 journal barrier. The <=10 target is unmet even
from binds alone. The maintainer resolved the dependency: bindings remain
in B2 and the <=10 total-request gate applies at B2 completion. Other
stage requirements and the final acceptance bar are unchanged. The
frozenb45 host observer excludes later host correctness fixes. These are
client-front request counts, not physical latency, display FPS, overhead,
main or native-feel acceptance. The frozen17d normal producer completes3h25;
normal admission and final combined-tree checks remain required. R354 later
checks the combined host/app source against unchanged normal guest sources:
61 pass,1 Firefox SNKRX interaction failure and4 existing host-clipboard skips
of66 desktop cases. Cage, labwc, Sway and both SFWBar compositor checks pass
on all three engines. This does not close the other desktop/performance
defects or establish a completed stage.


R420 adds the host journal's bounded private buffer-copy ownership foundation,
with focused source and three-engine real-WebGL checks. Optional action10 and OP_BUFFER_DATA_SNAPSHOT now connect it to the existing
current-context wire, with raw C guest and three-engine GPU regressions. R432–R444 add cold actual-attribute capture, owned buffer-backed draws and
the ordinary C serial/token cache/encoder connection for eligible default
targets, with matched three-engine request controls. R461–R470 add eligible
offscreen target/input generations, raw-target revocation, reusable receivers
and provenance-safe CPU refusal, with actual C cross-engine controls.
R472–R493 connect prepared VBO/inline executable and sampling authority and
bounded journal decoding, with a coherent normal SDK/kernel and336 actual
three-engine guest cases. Cold pin/variant publication failures retain exact
native cleanup custody. R490/R497/R498 then close predicted scalar receiver/cache
allocation, including ordinary GL decoding, with matched actual C and module
controls. Complete the remaining stage and full application checks within B1;
do not turn these checkpoints into a new stage boundary or substitute them for
application measurements. Ordinary decoding CPU cost, duplicate
upload costs and final machine memory lifecycle remain unmeasured. The complete
B1 preview still waits for all B1 changes and required
checks; B2's asynchronous bindings and moved total-request gate remain separate.

The R445 host source-ownership correction closes the24-diagnostic TypeScript
gate without changing `rootDir`, public distribution paths or ABI. Its combined
compiler, focused Node/browser TLS, graphics, Node graphics-refusal and normal
host-build checks pass. Full host/POSIX/memory/benchmark, B1 offscreen ownership,
normal application preview and native-feel acceptance remain required; the
compiler fix does not substitute for those gates.

R449 repairs the native ESSL100 macro-conditional and function-parameter/body
scope controls with the original native validator retained. Its combined
graphics/compiler/shader/registry checks pass. Direct pinned CTS programs
initially expose four Firefox struct-hiding failures. R456 closes those direct
controls and the12 captured long-multiplication compiler controls across three
engines; its graphics/compiler/shader/registry checks pass. Final actual-guest
GLES2/EGL execution remains required in this iteration. Direct shader checks do
not establish conformance, B1 completion or native desktop feel.

R454/R459 close reproduced lazy-failure presentation and attribution gaps:
unresolved errors survive remount/CSS expiry and new attempts have distinct
acknowledgement identity. Actual Node and three-engine SW/native integrity
and verified-reload controls pass. The original Brave/r8 tofu report is still
an unverified historical cache hypothesis; final normal desktop/font/profile
and manual verification remain required. R459's historical browser-app compiler
gate fails126 existing diagnostics, with no additions against its clean baseline.
R482 closes the compiler gate with complete browser/Node context inventories,
213 Node tests,176 focused source checks and nine three-engine browser controls.
R492 then closes the reproduced ownership-audit propagation failure:118 checks
and the complete739-source graph pass under the unchanged watchdog, with zero
removed roots and two obsolete allowances removed. Full host-suite and final
memory/desktop/conformance/benchmark acceptance remain required. The original
baseline/candidate heap failures stay recorded; no acceptance criterion changes.


B1's exact-resource kernel/host foundation replaces recyclable descriptor
identity with retained file/buffer capabilities and once-only receipts.
Complete the guest-library ownership/fork connection, coherent normal
rebuild and all B1 gates before declaring the stage complete. Preserve the
remaining B1–B6/C1–C3 order and the approved B2 synchronous-request gate.
The extra same-file bridge traffic exposed by native ownership controls
must remain in total-request accounting and application measurements.
Freeciv display correctness, content latency and teardown failures remain
part of this iteration; focused controls cannot waive native-feel or final
three-engine acceptance. Remaining driver work, GLES3, IGT and multiple
displays remain the proposed subsequent iteration.


The current-iteration viewport repair separates monitor layout authority
from guest canvas fitting and prevents terminal/demo row-height changes
from altering connector modes. Its matched18-case three-engine functional
comparison passes, but does not establish Freeciv responsiveness. Resolve
the observed host teardown failures and rerun the final memory, application
and latency gates in this iteration; those checks are not future deferrals.


The guest exact-resource custody connection is now a source checkpoint with
focused native regressions. Image-generation metadata now has independent source custody and revoked
borrowed pointers. Finish detached EGL C-lease ownership, then normally rebuild and execute its registered
Node/browser fixtures and all B1 gates. Those findings remain current work;
they are not postponed to B2 or the subsequent driver iteration.

Exact clone completion now preserves transferred Worker channels and rolls
back only untransferred allocations, with focused integration ownership and
source-audit evidence. Finish combined host retirement/browser-memory and
the remaining EGL/Wayland continuations in this iteration, then validate
coherent normal products. These source checkpoints do not complete B1 or
change its application, conformance or native-feel acceptance criteria.

Host retirement now distinguishes sealed non-construction from actual
Worker acknowledgements and Node native joins. Unknown outcomes retain
ownership; independently proven retirements can settle together without
changing the JavaScriptCore workaround. Combined browser-memory and normal
guest checks remain current work. The older full six-leg CTS audit has
finished with adverse results fully accounted; its completion does not
admit current source or replace final per-case comparisons.

Maintainer decision D-59 permits an explicit exec/exit-only boundary for
inherited native Wayland connections after multithreaded fork. Implement
its loud rejection and exact child/parent resource guarantees now. Ordinary
Wayland callback/thread-exit cleanup and the remaining graphics/native-feel
gates remain current work; this is not a general graphics-fork deferral.

Exact mapping IDs, rooted constructor capsules, actor-aware BO/surface/EGL
queues and pending front-hold consumption now have source/native evidence.
Execute their normal-target parent/child replacement fixtures next, then
finish native Wayland continuations, D-59 enforcement and fork-shutdown
ownership. The private libc fork-epoch primitive is available; boundary
enforcement is still pending. Keep all native-feel, Freeciv/ScummVM and
final Node/browser requirements in this iteration.

The B1 fork-completion source checkpoint preserves child allocation custody
independently of a retired parent request and closes failed-launch inherited
network mirrors before returning failure. Main Worker absence now has a distinct sealed source-level proof alongside
actual acknowledgements; actual browser acceptance remains pending and the
historical missing-main outcomes are not attributed or waived. Complete native Wayland
retirement and approved D-59 enforcement, then rebuild and execute the full
Node/browser workloads before calling B1 complete. These remain work in this
iteration, alongside every native-feel and final acceptance requirement.

The native-ready EGL bridge and metadata-only inherited-Wayland custody root
are now source foundations. Finish native continuations and D-59 raw entry/
callback-return enforcement in this iteration, then prove ordinary and child
lifetimes on rebuilt targets. Explicit retained custody remains distinct from
completion; native test doubles and unresolved queue observations cannot close
those requirements or establish performance.

Native Wayland client/window continuation source now has pinned-native and
independent window/GBM coverage. Complete the pending-capsule EGL consumer and
raw-client D-59 callback/entry enforcement before final B1 validation. The latest
matched host lifecycle run still has Chromium PHP-startup missing-main proof on
both sides; this remains distinct from sealed main absence and needs the full
memory contract and focused investigation. Native Freeciv3.2.6 SDL2 control is
now built with the frozen saved world/assets and exact SDL library versions;
visible rendering, interaction comparability and latency remain unmeasured.

Exact main-worker payload PID checks now match Node for browser fences and
lifecycle messages. Their composed source checks do not explain historical
Chromium missing acknowledgements; finish that investigation and the actual
full browser-memory contract in this iteration, without turning an additional
per-generation diagnostic into a new acceptance rule or waiving real failures.

The EGL pending-capsule consumer is now integrated with native source-level
coverage for actual completion, retained pending/error work and explicit D-59
transfer. Finish raw-client entry/callback enforcement, coherent normal target
linkage/execution and the full B1 gates in this iteration. The old opaque queue
observations have stronger fixture assertions; they do not establish actual
browser or native-feel acceptance and are not a deferral of either requirement.

Normal component builds and the corrected actual target ownership controls
now pass, including same-BO partial replacement through ordinary and exact
owned mappings. The unchanged rerun passes16 Node and48 three-engine cases;
the original full-size-only rejection and its failure evidence remain recorded.
Finish raw-client enforcement and complete B1/application/native-feel gates in
this iteration. Selected target controls do not replace full application,
browser-memory, conformance or performance acceptance.


### Graphics source checkpoint and remaining acceptance, 2026-11-07

The latest B1 source now includes raw native Wayland entry/callback custody
and the approved D-59 rejection, plus session-rooted BO transfers and
generation-rooted import/format receivers. These prevent completed native
capture outputs from surviving only on a vanished peer's C stack. Ordinary
callback cleanup, exact replacement isolation and fresh-child initialization
remain required behavior. Source/native controls do not establish complete B1.
Finish combined checks and coherent normal target/application builds, then
execute the full Node/browser memory, desktop, conformance, POSIX, benchmark
and native-feel requirements in this iteration. The distinct older teardown
warning and missing-main diagnostics are not explained by a passing cohort.

D-60 carries a generic potentially upstreamable SDL2 disabled-CRTC restore
correction with genuine error logging intact. Normal SDL and rebuilt Freeciv
Node functionality have passed; application rendering/error admission and
three-engine timing remain required. It is not submitted or accepted upstream.
All B2–B6 and C1–C3 stages, Freeciv/ScummVM workloads and existing numeric bars
remain in this iteration. Next-iteration proposals remain the remaining driver
work, GLES3, IGT and multiple displays; none removes a current requirement.


R760 normal-build recovery and metrology qualification remain current-iteration
work. R703-r2 stops at the unchanged disk admission floor with183 of222 nodes
completed/reusable; the full image, ABI/freshness and application gates remain
open. An unlocked six-cohort R757 attempt refuses overlay authority before any
input. The complete-response/fresh-trial method is being prepared privately;
it is not accepted native timing or a Freeciv/ScummVM oracle. Safe retirement
of inactive build copies and lossless historical-evidence compression changes
storage only and waives no correctness, stage or performance requirement.


The R770 complete-response measurement prototype is now integrated with
source sealing, original-input failure custody and recorder-level policy
separation. Its Swift/Node and three-engine headless controls pass, while
physical adversarial qualification and application oracles remain current-
iteration work. The original unexplained geometry refusal remains recorded.
These tooling results close no desktop performance or full B1 gate.


The maintainer's 2026-11-07 priority is to ship the separately validated B1
stage as concrete graphics progress before B2–B6/C1–C3. Those remaining
stages stay in this iteration and the full goal; this does not move them
to future work or waive B1 or final acceptance. Current normal R760 remains
in progress. Preview availability and complete-B1 readiness are separate
claims, each requiring evidence for its own scope.


A current normal-built B1 candidate is now runnable after R785's ordinary
190-node build, with exact-URL Freeciv rendering and three selected Node
checks passed. The first three-engine quick desktop run remains recorded
failed at 21/24. Test-only focus and rendered-history corrections then pass
the complete original Omarchy boot scenario on all three engines in R792;
other Omarchy cases and every B1 ownership/audit/conformance/memory/measurement
gate remain required before calling the stage complete. Waybar/full-all
verification remains required after preview-priority scheduling. B2–B6/C1–C3
remain in this goal, and physical/native-feel qualification is unfinished.

Desktop shortcut usability: qualify the Alt/Option presets on real Windows
as well as macOS, including international layouts and user-reserved chords.
Optional fullscreen/Keyboard Lock and an explicit guest-config modifier
selector remain proposed product controls, not implemented features or
substitutes for working windowed bindings. Current graphics acceptance still
requires the new desktop configs and native Swaybar on all three engines.

### B1 shipment checkpoint after current consumer acceptance

The current normal R914 graphical candidate completes all 28 Node and
1,074 browser cases in the selected full consumer files, plus 22 Node and
60 browser ownership cases, across Chromium, Firefox and WebKit. Both
widths and the new child-wait visibility and failed-fork cleanup cases are
included. Inventories and source/product guards pass; no cases are skipped
or retried. These current results supersede the earlier pending rerun,
while its original failures remain recorded in the compatibility ledger.

The focused graphical selection passes 20 of 21 cases. Firefox's original
Sway failure has two terminals after one launch action; closing one leaves
the extra client. Three unchanged diagnostic attempts pass with only one
client, so the launch difference remains unresolved. The current scoped
fatal audit now accounts for 642 cases per engine: 633 Pass and nine
NotSupported, identical per case to the recorded baseline and across
engines. This is not the full GLES2/EGL audit. Complete libc, remaining
lifecycle, measurement and manual checks and resolve the launch difference
before announcing B1 readiness. Consumer counts do not establish native feel.

Ship B1 as the next concrete increment once its own checks pass. Follow
with B2 asynchronous bindings and its ScummVM request gate, B3 local
queries, B4 program interfaces, B5 native fences and B6 inline arrays;
then C1 Rust scheduling, C2 executor separation and C3 the GPU worker.
Land, validate and measure each stage separately in order. All final
campaign, Freeciv/ScummVM and native-feel acceptance requirements remain.
