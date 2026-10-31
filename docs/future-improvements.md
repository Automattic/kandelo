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
whole-system memory acceptance gate in [the persistence plan](persistence-plan.md).
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
[persistence plan](persistence-plan.md); this cross-system audit must not
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
PID still owns a different WebAssembly `Memory`, coherence happens only when a
process crosses a syscall boundary: the host (for the objects whose bytes it
owns) or the kernel (`SharedMappingTable`) merges bytes changed relative to
that process's snapshot and then imports peer changes. A direct store does not immediately change another
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
and sees descriptor writes through a per-file content generation. Its own
gap: a sole writer with no live peer publishes only at `msync`, `munmap`,
`exec`, exit or when another mapping joins, so a descriptor `read` of the
file does not see a fresh store before then, where Linux's unified page
cache would. The host kind closes this by publishing every observer before
a descriptor syscall touches the file's bytes
(`flushSharedMappingsBeforeFileSyscall`); the kernel has no such
pre-syscall publication yet.

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
PR #383 (`fix(kernel): share AF_INET accept queue across fork — nginx multi-worker`, May 2026) moved injected-connection pipes to the kernel's GLOBAL pipe table. `kernel_pipe_{read,write,close_*,is_*_open}` now treat `pid == 0` as a sentinel meaning "use the global pipe table". The HTTP bridge in `host/src/browser-kernel-worker-entry.ts` and `NodeKernelHost` were updated; `apps/browser-demos/lib/mysql-client.ts`, `apps/browser-demos/lib/redis-client.ts`, and the legacy `apps/browser-demos/lib/connection-pump.ts` helper have since been fixed. **Audit any future call site that does `kernel.injectConnection(...)` and then `kernel.pipeRead/pipeWrite` with a non-zero pid** — it will be broken in the same way (silent EBADF; bytes never reach the accepted worker).

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

### Read the Omarchy boot spec's markers from scrollback

`kandelo-omarchy.spec.ts` "boots a themed tiling desktop…" matches each gate's marker only in the terminal rows on screen. During a busy run a burst of compositor output (repeated `TILE` lines) can scroll a marker away before the spec reads it. It failed that way on Chromium and WebKit in PR #1600's full run and passed when run alone (3 of 3). Read markers through scrollback or a cumulative log, as `expectTerminalHistory` does for theme reloads, so the gates do not depend on timing.

**Files:** `apps/browser-demos/test/kandelo-omarchy.spec.ts`
