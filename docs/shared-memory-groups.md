# Shared-memory process-group preview contract

This records the supported surface of the opt-in desktop-first iteration.
Chromium and Firefox are supported targets for this preview. WebKit is
experimental: repeated live desktop replacement can time out during Worker
retirement, leaving the computer locked because storage quiescence is unconfirmed.
Native Safari and iOS remain untested. The
[scanner and landing receipt](measurements/2026-11-25-shared-memory-scanner.md)
records current validation, measurements and limits; the earlier
[WebKit qualification](measurements/2026-11-25-shared-memory-webkit-qualification.md)
retains the successful runs preceding the reproduced failure.
The [historical evidence index](measurements/shared-memory-evidence.md) preserves
previous implementations, failed experiments and their narrower claims.

## Purpose and trust

A memory-sharing group lets compatible processes address shared in-memory
objects directly through one shared physical WebAssembly.Memory. Each process
has its own virtual address space. Private state, protection checks and fork
semantics still follow the process address space; shared mappings can alias
one backing without syscall-boundary mirror copies.

The intended first consumer is Sway with compatible graphical clients. Group
members must trust one another. Translation enforces supported program
semantics; it is not a security boundary against a malicious participant with
access to the common physical backing. These groups are independent of POSIX
process groups, sessions, credentials and signal targets. Ordinary processes
retain their existing memory backend. PHP-FPM sources, images, configuration
and defaults are outside this feature's integration scope.

## Authority and admission

The Rust kernel owns group identity, membership, budgets and backing leases, physical allocation and page custody, image roots, per-task scratch, shared objects, mapping publication, barriers and retirement. The owner is part of `ProcessTable`; it is not a separate helper module managed by the host. The host retains the corresponding `WebAssembly.Memory`, Worker and native Promise instances.

Page-table scans use a stateless Rust Wasm adjunct instantiated once for each
backing inside the disposable kernel Worker. It imports that existing memory
and performs bounded sequential atomic reads directly, returning the next
nonzero entry and its index. It has no allocation, writes, scratch memory,
platform callbacks or lifecycle state. The main kernel retains the existing
locks and validates every returned entry before publication or reclamation;
this is not a coherent snapshot of concurrently changing tables. TypeScript
retains the instance's callable function with the exact backing resource. Fork uses
the same scanner under the parent pause and growth lock. It checks the full
table, including holes beyond the live extent, before allocating child frames.
[Grouped fork measurement](measurements/2026-11-26-grouped-fork-scan.md)
`xtask dump-abi` generates/checks the embedded scanner, including a read-only
instruction check. Host adapter 40 introduced the scanner. The kernel manifest
requires an exact adapter version. The program ABI remains 56.

Mapping setup and reclamation read the backing size once for each root-locked
page-table scan. Physical WebAssembly memory can only grow. When checking a
live peer, Rust reads the size again if it sees a frame beyond the last known
extent. A frame outside the current backing still fails validation.
The [mapping scan measurements](measurements/2026-11-26-group-mapping-extent.md)
count these queries during a real terminal launch.

For a host byte transfer, the Rust access helper checks each virtual page
while finding contiguous physical spans. The host finishes collecting those
spans before it reads or writes any bytes. A range-only permission check asks
Rust to validate the range directly. Both operations check the live image
binding. [Grouped transfer measurements](measurements/2026-11-26-grouped-transfer-scan.md)

Image-mutating mappings, fork and pthread-control reservations enter a kernel-owned operation queue. Rust issues exact task-bound tokens and permits only the earliest live operation on an image to begin its pause. Cancelling an operation from the middle cannot let its successor bypass an earlier operation. Outstanding operations prevent image reclamation; an owning task's scratch cannot retire while its operation remains live. Host promises wake continuations, which must recheck Rust readiness before proceeding.

Rust combines adjacent frames when clearing a pool selection. Fork copies a
run only when both the parent and child physical pages are consecutive.
Private aliases refer to the same child copy, and shared mappings still
refer to the original shared frames. Root launch, exec and fork use the
same bounded writes for an unpublished page table and publish its extent
after the table is complete.

Root preparation, mapping, fork, exec replacement and pthread preparation use kernel-owned continuations. Rust computes grouped layouts from the SDK artifact and retains exact admissions through allocator contention and cancellation. Normal executable commits retain the parsed layout metadata; direct byte-supplied roots read their attached executable once before admission. The host receives copied layouts and transport descriptors.

After exec commit, the retained Rust controller selects detachment, exact stop observation, native Worker termination/join, replacement installation or signal cancellation, old-image retirement, replacement binding/start and final publication. The host executes the issued effect and reports its completion with the exact future receipt and effect identity. Out-of-order or repeated completions cannot advance the operation. A failed platform action retains custody; it does not become proof of Worker absence, stop or reference release. Registration still reports actual platform bindings through the kernel entry gate.

Worker terminal fences, native exit/join observations and sealed never-started handles are reported as distinct facts to the actual Rust group owner. Rust uses the bound platform capability to decide whether a native exit is a join; a browser's synthetic exit leaves execution custody intact. One host object holder retains real endpoints, callbacks and native observations, without deciding release eligibility.

Normal image/thread retirement first detaches and settles its transport. Rust then selects each remaining task's reference disposer and retains the corresponding charge until JavaScript acknowledges that exact disposal. Stopped scratch and image pages cannot be reclaimed while references remain bound or a disposer is outstanding. A failed disposer retains custody and is not silently retried as successful cleanup.

Post-construction image and thread retirement also use kernel-owned continuations. Rust checks eligibility and exact receipts, identifies exec futures requiring cancellation, and waits for actual host detachment before reclaiming storage. Native retry replies carry an observation identity and backing resource, without granting an execution descriptor after source revocation.

Process-exit stopping and publication use a kernel continuation as well. It retains the exit status and parent identity before native reaping, selects stop/progress effects, and requires exact Worker-stop proof before returning the exit event for host notification. A stopped event cannot be consumed by a replacement generation.
A reaped process-group leader retained in `Limbo` carries identity, not live execution, so it cannot block retirement of its already stopped image. Cooperative stop changes the SDK pause wait predicate before notifying; a task entering its wait after the notification must observe the changed predicate instead of sleeping indefinitely.

Grouped completion authority also belongs to the actual `ProcessTable`. It retains the exact task/channel/request, full-width result, prepared signal and native observation identity. Rust consumes flags and grants dispatch, publication, stop holds, interruption, discard and the terminal unwind selected by actual thread exit, process exit or exec commit. Native Promise settlement grants no publication or reuse permission. A completion holds physical controls independently of native pins until Rust accepts its final acknowledgement; physical release prunes idle metadata without a later host callback. Ordinary signal dequeue and direct host transfer publication cannot bypass this owner for grouped tasks.

Rust preflights all destination words before writing a signal record or publishing a result. Consecutive words on the same virtual page reuse the private-frame translation for that synchronous operation. Publication validates the entire locked SDK wait queue, records the first matching waiter, then writes the result and wakes that waiter. An unlinked node stays allocated until its waiting task returns.

The kernel Worker holds one physical atomic-word view per group backing. The view covers a prefix of the shared memory. When Rust requests a word beyond it, the adapter checks the current extent and refreshes the view. Per-process translation and exact native-wait pins still follow the current mapping and the Rust-issued receipt. See the [grouped completion and desktop measurements](measurements/2026-11-26-grouped-syscall-desktop-latency.md).

The actual Rust root, fork, exec and pthread owners select execution transactions and cancellation. Rust also selects Worker containment before reference disposal and orders pthread retirement against whole-image retirement. An accepted Node native join or sealed constructor absence already satisfies containment; a browser terminal fence still requires the requested platform termination. References and physical frames remain charged until their distinct acknowledgements and native waits settle.

Group shutdown seals admission and selects current members in the actual Rust `ProcessTable`, using normal signal delivery. Native creator draining starts after that stop request, so a pending or stopped launch cannot hold the shutdown open indefinitely. A constructed root awaiting readiness or backing delivery receives exact scalar-only cancellation and must return a real terminal fence. An already completed native retirement can satisfy its late acknowledgement. TypeScript retains genuine platform objects, native observations and pending platform operations. Existing IPC, fork serialization, dynamic loading, graphics presentation and build/lazy-loading helpers remain in their normal layers unless this feature placed group policy there. Moving ordinary algorithms to Rust is not a requirement of this feature.

Host address translation and ordered queue notification execute shared stateless Rust SDK primitives against the admitted foreign memory; that extraction owns no pages, membership or lifecycle. Its bounded publication callback reports failure as data so Rust releases its own queue lock. The normal generator rejects start/data initialization, memory growth and mutable instance writes. Platform objects and native completion observations remain host responsibilities.

Grouped mappings must enter the Rust physical/PTE transaction owner. The ordinary direct/synthetic mmap, munmap, mremap and mprotect entries refuse grouped images; direct brk leaves the break unchanged. SysV attachment to a grouped image is unsupported and is refused by the kernel before attachment accounting, rather than entering the legacy synthetic-mmap and byte-mirror path. Ordinary processes retain that path. This refusal does not add SysV sharing to the grouped preview.

The kernel and a group's backing are separate Wasm memories. Raw host imports perform Rust-requested bounded byte and atomic operations; they do not choose frames or authorize reuse. Rust retains the actual logical memory-manager and driver plans through physical publication and commit, rather than asking TypeScript to reconstruct their effects. SDK private growth sends only its unsigned page delta through the admitted syscall channel. The actual kernel storage owner allocates and zeroes frames through its existing pool, retains image custody before publishing page-table entries, and publishes the new virtual extent last. Contention retries through the existing completion owner; stopped tasks cannot grow, and uncertain publication contains the image without dropping its charges. No SDK or TypeScript allocator chooses frames. A native wait's timeout permits a retry, never page reuse. After a fatal uncertainty, a copied snapshot captured before the fatal latch may describe retained charges; it does not reopen the failed kernel for inspection.
Inspection and UI consume that state; they do not invent group membership or
authorize reuse. The optional scalar usage API reports allocator contention as
`EAGAIN` without poisoning the kernel. No persistent browser or audio realm receives the guest
memory or a view into it.

Each root, fork, exec and pthread admission reserves its completion-channel
metadata before publishing the task or constructing a Worker. The Rust task
ledger owns that allocation until the exact channel layout binds it. Binding
uses the reservation even when the metadata budget is full; an incorrect
channel cannot consume it. An unbound reservation grants no dispatch or signal
publication rights, and cancellation or retirement drops it with its task.
Once bound, the node stays with the exact physical owner through transport
detachment and acknowledgement. A live task can bind its same channel again
after the previous call settles without another allocation. Physical release
prunes the binding; a detached channel cannot dispatch or receive signals.

Unconstructed cancellation returns physical storage and releases task admission
in one Rust operation. Allocator contention retains the exact receipt and its
budget for retry. The host drops its platform references only after Rust
acknowledges cancellation; a failed attempt is not an absence or stop proof.

The embedding launcher explicitly selects a group through the normal host
contract. A caller cannot join an unrelated group by guessing an identifier.
The initial preview does not expose a guest syscall for arbitrary membership
changes. Two groups in one machine must have distinct identities and backing
ownership, with no accidental cross-group attachment. A failed admission must
roll back both kernel and host reservations exactly once.

Declared physical capacity, committed allocation, process and thread limits
must be explicit. Resource refusal remains visible through the existing
error path. The desktop preview does not raise the renderer or memory limits
to conceal duplicated storage. Browser-engine reservation costs constrain
capacity even when resident memory is low.

## Executable identities and prototype labels

The normal SDK currently emits the required memory namespace
`kandelo.memory-group.v3`, custom section `kandelo.memory-group`, and executable
metadata `version: 3`, `layout: 3`. Its additional metadata requires
`threadAttach: 2`, `cooperativeStop: 3`, `executionBarrier: 1` and
`orderedWaitQueue: 2` and `kernelGrowth: 1`. The required function namespace
`kandelo.memory-group-growth.v1` exports
`__kandelo_memory_group_grow_v1(i32) -> i32`: an unsigned page delta returns
the old virtual page count or -1 on allocation refusal. A grouped artifact
without this exact import is rejected. These identities come from
`crates/program-abi/src/program_extensions.rs` and the normal SDK translator;
readers must validate them, rather than infer compatibility from a report title.
Program ABI 56, host adapter 40, kernel group protocol 1 and mapping-description
protocol 6 are separately versioned contracts.

The historical research candidate was called **format4**. That label is not the
normal SDK's executable version or memory namespace. The integrated implementation
re-expresses the prototype's pointer translation and lifecycle behavior through
the supported SDK and kernel contracts. Matching a prototype label does not
prove semantic parity: actual memory-operation, pthread/wait, fork/exec/exit and
desktop tests provide that evidence. No artifact is restamped or admitted merely
to match the historical name.

## Executables and process lifecycle

The actual root, fork, exec and pthread owners grant native construction and
launch delivery after checking the exact execution and pending default signals.
A stopped operation stays pending in Rust. TypeScript retains native objects
and executes each granted effect in the same kernel-entry transaction; grouped
starts never enter the ordinary host deferred-constructor registry.

Exec readiness and memory delivery are separate kernel-selected effects. While
handoff is pending, the actual exec owner retains a replacement's normal or
signal exit status and selects exact stop, native join, reference detachment
and physical retirement before publication. After successful handoff, the normal
process-stop owner handles later exit. A constructed Worker awaiting launch
receives an exact scalar-only cancellation and returns its real terminal fence
without guest memory. Readiness requires the exact host adapter version before
memory delivery, so an older Worker cannot claim this cancellation contract.
Kernel-owned SDK private-growth allocation is implemented and covered by the
real SDK validation. The [landing receipt](measurements/2026-11-25-shared-memory-scanner.md)
records validation of the develop-integrated candidate separately from earlier
runtime revisions and identifies checks not rerun for landing.

The normal SDK prepares versioned compatible executables. The runtime checks
the translated contract, program ABI and kernel-host contract before admission.
An incompatible executable fails clearly before replacing the current image;
editing a stamp is not compatibility. An ordinary executable keeps its ordinary
execution path. Running a translated executable outside a selected group is a
separate compatibility decision that requires explicit implementation and tests;
the desktop preview does not promise it implicitly.

Fork within a group preserves virtual pointer values. Private pages become
independent child state; shared mappings keep their backing identity and live
visibility. Each task has a 64-byte control record and its own translation
scratch and initialization state. Threads share their process's virtual root.
The v3 SDK layout calls these task control records `REPLICA_*`; the name refers
to an execution instance, not a copy of shared memory. For example,
`REPLICA_GROUP` is the group-ID field at byte offset 40 in that control record.
Constructors and active data initialization are not replayed into already
initialized shared state.

Exec preserves POSIX process identity while replacing the execution generation.
A compatible replacement may retain the explicitly selected group. Leaving a
group for an ordinary executable requires the same exact retirement and alias
accounting as exit. Unsupported transitions must fail before replacement,
leaving the old image usable. No implicit cross-group copy or attachment may
silently change shared-pointer semantics.

Exit, cancellation, exec, SIGKILL, construction failure and machine destruction
must retire all affected Workers, including threads in native atomic waits or
syscall-free loops. A peer waiting on the same physical word must remain live.
Kernel exit status cannot become visible before the required execution stop.
Page reuse requires exact execution-generation quiescence and release of every
remaining alias/object/snapshot owner. Quarantine is containment, not successful
reclamation. A stopped image with an unexposed exec preparation retains both
owners until Rust cancellation succeeds; allocator contention delays deactivation
and retirement. A live predecessor cannot use that cleanup path. Existing
ordinary-pthread gaps, including asynchronous cancellation and robust mutexes, are not silently broadened by this preview.

Logical growth and host control allocations serialize with the same mapping
publication rules. Missing pages below a logical high-water mark still need
mapping and initialization. Reused payload, scratch and control storage must
not expose a predecessor's bytes. Sustained growth and release must not consume
physical capacity monotonically when the released pages are reusable.

## Ordinary shell image integration

The shell image carries ordinary executables at their normal paths and SDK-prepared alternatives under `/usr/libexec/kandelo/memory-group/<source-sha256>/program.wasm`, using normal producer-owned lazy package archives. The host selects a candidate by retained executable content; the kernel validates and binds the exact source and implementation descriptors. Ordinary shell launches keep ordinary execution. An explicit `executionBackend: "memory-group"` launch selects alternatives for that root; compatible descendants inherit the kernel-owned group. Missing alternatives fail before commit.

The Cage, Sway and Sway/SFWBar shell profiles request this backend in image-owned runtime metadata. That request does not grant capability to an arbitrary custom image: the embedding host must configure the catalog and group budget. Desktop activities use a fresh PTY with this explicit selection, while unrelated terminals retain ordinary execution. ScummVM inside a desktop uses the static engine’s distinct `scummvm-static` command; ordinary ScummVM remains available separately.

Filesystem persistence is independent of the process memory backend. Normal shell storage policy remains applicable to ordinary files; persistent writable shared mappings and changing shared-object sizes remain unsupported. As with ordinary computers, use `fsync` or `sync` before relying on an abrupt browser reload to preserve file data. These integration changes require same-image ordinary/grouped Node and browser evidence before delivery.

## In-memory shared objects and graphics

The preview targets anonymous inherited shared mappings, memfd, POSIX shared
memory and in-memory graphical buffers. Object identity follows the underlying
object, not a pathname or individual descriptor. Compatible mappings of the
same offsets within a group alias the intended physical bytes. Visibility
between guest loads/stores must not depend on a syscall or notification poll.

Descriptor reads/writes and mappings observe the same authoritative content.
Offset mappings, protection, close, unlink, descriptor transfer, growth and
truncation require ordinary platform semantics and explicit lifetime tests.
Unsupported operations must return an honest error rather than create a
disconnected copy. Cross-group transfer must either have a documented coherent
implementation or fail explicitly. It must not join groups implicitly.

Graphics integration preserves buffer-release, upload, presentation and context
ownership fences. Direct CPU sharing does not remove independent GPU storage
or establish zero-copy presentation. Resize and context loss must not release
backing still used by a client, compositor or in-flight submission.

Persistent writable regular-file MAP_SHARED, mixed ordinary/grouped graphical
buffer clients, System V direct sharing, vfork and dynamic side modules remain
outside the initial preview. Existing ordinary behavior for those paths stays
unchanged. PostgreSQL and Apache are later consumers, not prerequisites for the
desktop milestone.

## Desktop-first opt-in

`BrowserKernel` and `NodeKernelHost` accept an explicit embedder option:

```ts
experimentalMemoryGroup: {
  maximumPages: 8192,
}
```

`maximumPages` is required. Optional `maximumProcesses` and `maximumTasks`
allow embedders to impose explicit admission quotas. Omitted counts use the
protocol's unsigned 32-bit ceiling; they do not reserve or allocate capacity.
If only a task quota is supplied, it also bounds the process count. An explicit
process quota cannot exceed the task quota. Tasks include each process's main
execution, pthreads, pending admissions and executions awaiting exact retirement.
The kernel refuses a count quota with `EAGAIN` and backing exhaustion with
`ENOMEM`. Fallible kernel metadata allocation and host Worker construction can
also refuse admission; omitting count quotas does not promise unlimited resources.

The Node/browser host method `getMemoryGroupUsage()` returns a copied scalar
snapshot of this machine's opted-in group, or `null` before a group exists.
Reading does not create a group or reserve backing. Admission and backing
counters are collected under one kernel entry; they describe different owners
and need not have identical image counts during preparation or retirement.
The result carries no memory, views, mapping roots or admission capabilities.
This optional troubleshooting API runs only when called; it adds no polling.
The normal browser app also exposes these copied counters under Internals →
Config → Kernel as `kandelo.memory_group.admission.*` and
`kandelo.memory_group.backing.*`. Opening or refreshing that view requests a
new snapshot through `KernelHost.getKernelState()`; it does not enable a group.
An ordinary machine can report a configured but unused admission group, with
zero participants and unallocated backing. Inspection does not opt programs
into grouped execution. `pageBytes` is 65,536, and a
`backing` value of `unallocated` means the admitted group has no backing yet.
A machine replacement during inspection rejects the old response rather than
showing another machine's counters. Errors remain visible in the Inspector.
If a guest holds the allocator lock, the call rejects with `EAGAIN` instead of
blocking the kernel Worker. The caller can request a fresh snapshot later.

`admission` reports the kernel identity, effective limits and live/pending task,
process, image, backing and quarantine counts. `backing` is `null` until backing
exists; otherwise it reports allocator, shared-object, replica, native-observer
and mapping-staging counters. Page counts use 64 KiB units. `allocatedPages`
counts live pool allocations once; `sharedPages` counts unique object pages,
not the sum across aliases. `physicalExtentPages` is the current common buffer
capacity, `highWaterPages` is the allocator high-water mark and `maximumPages`
is the admitted ceiling. The backing stays available for reuse until machine
destruction; returning pages to the allocator does not shrink its buffer.
None measures browser RSS, GPU storage or native
Worker/code memory. `mappingStagingBytes` counts independent host staging bytes;
`retainedMappingReferences` and `sharedImageReferences` are reference counts.
Copied inspection is observational and never authorizes reuse or admission.

Compatible byte launches through `spawn(bytes, argv, options)` use a single
kernel-owned group in that machine. The option configures a physical ceiling;
it does not raise ordinary process or renderer limits. Ordinary artifacts
keep the ordinary backend. The disposable kernel Worker owns launch, fork,
pthread, compatible exec and retirement; the embedding receives copied
output and status. Failed fork setup first seals the exact never-started
Worker or requests cooperative stop and joins its terminal proof. Published
image metadata, channel observers and physical pages retire before the
allocated Process is removed or the parent's failure returns. A stop timeout
retains uncertain storage; it does not authorize reuse. The regression rejects
16 setups before registration and after actual replay, verifies no waitable
child or allocation leak, then performs a successful fork.

Both embedding hosts also support initial grouped `spawnFromVfs` and compatible
`posix_spawn` children of grouped parents. An optional kernel capability checks
the exact retained target against a configured group before initial commit.
It reserves no task/image at inspection: commit advances the generation, then
launch reserves that committed generation before publishing a Worker. A pending
spawn child additionally proves its exact parent and that parent's group.
A missing capability refuses the opted-in path; ordinary launch without the
option keeps its existing checks. Committed path and spawn executables retain
their descriptor, inode and credentials instead of attaching an anonymous copy.
Group backing allocation remains lazy until a compatible executable launches.

Real SDK Node/browser regressions exercise path launch, fork, pthreads,
permission refusal, absence of opt-in and executable identity in spawned
children. Dedicated kernel-Worker regressions additionally inject 16 initial
registration refusals before and after registration, then prove budget and
physical-image restoration before a successful fork. An uncertain constructor
failure stays fatal and charged; stopped and concurrently destroyed initial
launches retire through their exact receipts. These pass on Node and all three
browser engines. The pinned integrated runtime also passes the full normal
browser-memory gate and bounded built-app checks recorded in the
[current integration checkpoint](https://github.com/Automattic/kandelo/blob/fb798e1ea88a065b343fcb06a28b0def9c96bc66/docs/measurements/2026-11-20-shared-memory-desktop-current.md).
Those results do not establish sustained WebKit reliability or a resource benefit.
The earlier byte-launch controls remain separate from the normal app path below.

The normal shell configures the SDK catalog and group budget as embedder
policy. Its profiles and Activities select the backend per process family,
while retaining the computer library and normal filesystem storage policy.
Custom images and boot links cannot grant this capability. Grouped KMS
attachment uses the disposable bitmap display relay through the existing
display API.

The maintained canonical consumers described below cover the normal shell
profiles. Earlier standalone desktop pages, global build flags and derived
image recipes were removed after this integration. Their source and failed
experiments remain available in the [pinned pre-cleanup revision](https://github.com/Automattic/kandelo/tree/84f6213ee030300ce27e5a1de7aedaca078b924b)
and retained worktree evidence; they are not supported launch paths. The
[cleanup validation receipt](measurements/2026-11-22-shared-memory-cleanup.md)
records the current normal-app checks and observed failures, including the
WebKit admission-stress timeout and mixed Freeciv gameplay results.

They cover physical input, workspace changes, exit and CPU-renderer restart
on Chromium, Firefox and WebKit. These bounded checks are separate from
sustained lifecycle and resource acceptance.

The canonical capacity consumer checks twelve actual Foot processes and their shell children,
physical Ctrl+D exit, replacement by a new terminal PID and guest-driven Sway
exit. The final zero-terminal check requires init PID 1 in the same process
snapshot, so a transient loading table cannot satisfy cleanup. The check waits for an actual Bash
prompt in the focused tile before shell input, rather than treating process
creation as input readiness. It passes all three engines. Earlier Firefox exit
and diagnostic focus failures remain in the current measurement record. Twelve is a regression workload, not a capacity
promise or a configured maximum.

The same capacity consumer also checks two terminals on a native 3072×1728 scanout.
Six workspace moves and retiles resize the actual Foot buffers between full
and half width, including the hidden window. Both terminal PIDs must survive,
and each workspace must produce fresh exact file contents through physical
keyboard input before the next move. The check observes the kernel-reported
scanout mode, rendered focused prompts and guest-driven Sway exit with zero
Foot processes. It does not treat placeholder canvas dimensions as the guest
mode or claim that changing the browser viewport switches a live monitor mode.
These maintained checks pass on all three engines; the separate long WebKit
failures and resource limits remain in the
[current measurement record](https://github.com/Automattic/kandelo/blob/fb798e1ea88a065b343fcb06a28b0def9c96bc66/docs/measurements/2026-11-20-shared-memory-desktop-current.md).

Grouped child exit notification follows the same execution-stop boundary as
wait status. The kernel keeps SIGCHLD and automatic reaping pending while any
exact execution receipt still owns custody, including quarantined siblings.
A parent awakened by SIGCHLD can therefore observe the child's exit through
`waitpid(..., WNOHANG)`; it cannot consume its only notification before that
status is available. The public Node regression repeats this signal-driven
reaping pattern for 64 exits with live pthreads, in both prepared and ordinary
program modes.

### Shell desktops and partial development images

The canonical shell includes Cage/Foot, Sway/Foot and Sway/SFWBar as profiles
and Activities. Its default shell keeps ordinary execution. Select a desktop
profile in the computer library or start its Activity in an existing shell
computer. The Activity requests shared execution for its own process family;
it does not replace the computer or change other terminals' execution mode.
All three profiles use the normal computer storage policy.

Programs declare a compatible alternative in their own `package.toml` with
`[[outputs]].shared_memory_from`, using the normal SDK translator, resolver,
cache and lazy ZIP machinery. The shell composer installs available alternatives
at `/usr/libexec/kandelo/memory-group/<source-sha256>/program.wasm`; it needs no
separate program list or desktop package. Ordinary executables retain their
original bytes and guest paths. The host locates a candidate by source digest;
the kernel validates and binds the retained source and implementation descriptors
for an explicit shared launch. The embedding host configures the backend and
budget. Image metadata or URL parameters cannot grant it.

For development, compose a normal partial shell containing the desktop
closure instead of rebuilding every shell package:

```sh
./run.sh partial shell cage foot sway swaybg sfwbar freeciv-browser-bundle scummvm-static curl unzip sysklogd desktop-data bibata-cursor-theme
./run.sh browser --partial
```

Add `cage-docs sway-docs foot-docs freeciv-docs scummvm-docs` for upstream manuals.
Partial images install named packages; building a dependency does not itself
install that dependency's application into the image. Compatible outputs follow the selected producers, including base shell tools.
A minimal `./run.sh partial shell grep` can therefore exercise grouped commands
without any desktop packages. This path produces
the normal partial manifest and image, without manufacturing another desktop
image at launch. The old standalone desktop recipe and eager preparation
tool are archived at the pinned revision above.

Run `freeciv` or `scummvm-static` from Foot. `scummvm-static-play GAME` uses the
existing SHA-256-pinned freeware catalog through guest curl and unzip.
ScummVM retains the ordinary package's fourteen-engine selection, including
SCUMM v7/v8, using upstream static engines because grouped dynamic side modules
remain unsupported. Compatibility is an SDK build requirement, not an app
certification gate before experiments.

The maintained canonical consumers use the normal app with no global preview
flag:

```sh
scripts/dev-shell.sh bash -c '
  export WASM_POSIX_RESOLUTION_POLICY=source-only-v1
  export WASM_POSIX_SOURCE_ONLY_BINARY_ROOT="$PWD/local-binaries/source-only-v1"
  unset KANDELO_TEST_MACHINE_URLS KANDELO_TEST_PARTIAL_LIBRARY_MANIFEST
  cd apps/browser-demos
  npx playwright test --config playwright.shell-shared-desktop.config.ts --project chromium --project firefox --project webkit
  npx playwright test --config playwright.canonical-shared-desktop.config.ts --project chromium
'
```

The first selection checks real Foot input, ordinary-file persistence across
reload, and an ordinary-shell-to-Sway Activity in the same computer. The
second selects normal-gallery desktop, Freeciv, ScummVM and capacity consumers.
ScummVM gameplay requires the actual pinned game download and a fixed
1280×840 unit-scale viewport. A missing download, incomplete gameplay, failed
native Quit or incomplete process retirement fails the run. Neither command
proves audio, sustained gameplay, net memory savings or performance.

Earlier dedicated-preview results are retained in the dated measurement
records. They do not establish acceptance of the normal shell integration.
The current validation receipt identifies the partial image and exact test scope. The first iteration was validated with partial builds at the maintainer's request; it does not claim a new full canonical-product or full-gallery browser-memory run.

## Accounting and acceptance

The desktop-first integration implements fixed-size tmpfs and memfd objects with shared mappings and coherent descriptor reads and writes within the existing file size. Kernel backing and mapping owners retain one physical object through descriptor close, unlink where applicable, and fork. Positioned I/O preserves the seek cursor; ordinary reads and writes advance the shared open-file-description cursor. Offset mappings use the platform page alignment and may select bounded prefixes, middle slices or suffixes within the object's page-rounded extent. First promotion transfers the complete object's content even when the first mapping covers only a slice, so later aliases and descriptor I/O cannot lose unmapped bytes. The real SDK shared-file probe has covered this bounded surface on Node, Chromium, Firefox and WebKit; the current receipt identifies which checks were rerun. See the current validation receipt for the selected conformance and repeated desktop/lifecycle checks; this is not full POSIX conformance.

Promotion refuses pre-existing legacy mapping holds; ordinary or cross-group shared attachment is refused. An unpublished preparation abandoned during cleanup releases its mutation fence. Descriptor writes that would extend EOF and size-changing truncation remain unsupported and return an error before modifying content. Growth, truncation and their effects on existing mappings remain an explicit follow-up; the fixed-size surface does not complete that mapped-file contract.

The desktop integration also admits read-only `MAP_SHARED` mappings of
rootfs files, including files on a persisted computer, under a kernel-held immutable read lease. Their VMA
keeps `MAP_SHARED`; physical read copies are independently reclaimable.
Writes, truncation, writable protection and legacy shared attachment are
refused while the lease exists. Closing the descriptor does not release the
lease; the final mapping/source reference does. The storage policy does not make a leased file writable: persistent writable shared mappings and expanding these mappings remain unsupported.
This is a bounded read-only surface, not general writable regular-file sharing.

Host-adapter 23 adds the exact owned-driver mapping bridge. EGL command
streams use private process pages through the same barrier acknowledged by every task and
staged physical allocation as other grouped mappings. Their existing driver
token and transaction retain authority through construction or rollback.
Whole-stream exact unmapping retires the driver binding before releasing
physical pages. Fragmented command-stream unmapping remains unsupported.
Host-adapter 24 additionally binds CPU graphical BOs to kernel-owned direct
group objects. Their fixed-size, page-padded backing is retained by the BO
through GEM/PRIME, framebuffer/cursor and VMA ownership. Bounded prefix maps,
aliases, fork inheritance, fragmented unmap/fixed replacement and shrinking
remap preserve object offsets. Expansion remains refused with `EFAULT`.
Ordinary mirrored and cross-group CPU mappings cannot join that backing.
Host device reads refresh independent bounded staging; device writes update
the same group object. No raw guest virtual pointer becomes a physical
Memory offset, and staging never writes itself back over guest changes.
The current validation receipt covers the desktop and lifecycle workloads exercised with this implementation.
GL submissions read checked virtual addresses and copy
only the submitted range into the existing command queue; they never treat
guest pointers as physical offsets into the common Memory. GPU storage and
presentation copies remain separate costs.

Report distinct quantities: per-process virtual mappings, private/shared and
proportionally attributed bytes; unique group payload; runtime scratch and
metadata; retained owners; reusable capacity; allocation extent; declared
physical backing capacity; and measured OS footprint. Mapping/admission charges
are not additional physical copies. Logical counters are not RSS or PSS.

The reproducible desktop baseline uses Sway and two Foot terminals at
3072x1728 with the existing GLES renderer, configuration and limits. The
ordinary arm loses a terminal after a compositor shared mapping is refused.
The grouped experiment survives visible/hidden workspace movement and retile
on Chromium, Firefox and WebKit. This establishes capacity value for that
workload. The lower-resolution [format-4 resource screen](https://github.com/Automattic/kandelo/blob/fb798e1ea88a065b343fcb06a28b0def9c96bc66/docs/measurements/2026-11-16-shared-group-desktop-cost.md)
found faster verified shell response and higher total browser footprint in
three fresh Chromium launches per arm. It does not measure the integrated feature.

The original staged roadmap remains follow-up work. This iteration keeps fixed-size
in-memory shared objects and compatible participants; it does not complete general
shared-file growth/truncation, persistent writable sharing or mixed graphical clients.

Validation must distinguish native, Node, browser, ABI, conformance and resource
results. Chromium, Firefox and WebKit are preview targets within the
[current qualification scope](measurements/2026-11-25-shared-memory-webkit-qualification.md).
Playwright WebKit is not native Safari evidence. Record failed
and unrun checks, and distinguish the pinned tested runtime from later source
integration. A matched ordinary control measures group costs; it does not replace
a target-branch benchmark comparison.

No fixed performance threshold has been agreed. Publish the measured tradeoff
before promotion: capacity benefit, total footprint, CPU, input response and
presentation observations. Usable interaction permits measured overhead; it
does not waive correct semantics, bounded ownership or truthful reporting.

## SDK contract checks

The maintained SDK cases prepare real C programs through `wasm32posix-cc`,
the normal fork instrumenter and `wasm32posix-shared-memory`. They cover
admission, private/shared mappings, protection, fork, exec, pthreads, waits,
rollback and executable identity. They run through the public Node/browser
launchers and disposable kernel workers. These bounded checks do not replace
full conformance, sustained desktop or resource acceptance.

Concurrent allocation checks run three real fork children through 384 SDK
`memory.grow`/kernel `munmap` cycles alongside 512 parent kernel `mmap`/`munmap`
cycles. They verify zeroed reuse, live payload stability and exact retirement.
Compiler-only checks use fixed protocol inputs, with no host allocator model.

The browser-memory gate also exercises the real Rust kernel through its host
worker boundary. Those checks cover exact Worker receipts, Node joins versus
browser exit notifications, constructor uncertainty, asynchronous reference
retirement and allocator contention. Rust tests own allocation, barrier,
mapping and reclamation coverage; copied wire replies test transport only.

After normal artifact preparation, run them through `scripts/dev-shell.sh`
with `WASM_POSIX_RESOLUTION_POLICY=source-only-v1` and
`WASM_POSIX_SOURCE_ONLY_BINARY_ROOT="$PWD/local-binaries/source-only-v1"`:

```sh
(cd host && npx vitest run --config vitest.grouped-sdk.config.ts)
(cd apps/browser-demos && npx playwright test --config playwright.grouped-sdk.config.ts)
```

See the [address-space architecture](architecture.md#experimental-process-address-spaces)
for the runtime mechanism. Earlier protocol revisions and investigation
checkpoints are retained in the [pinned implementation history](https://github.com/Automattic/kandelo/blob/84f6213ee030300ce27e5a1de7aedaca078b924b/docs/shared-memory-groups.md#implementation-history)
and dated measurement records. Those historical stages do not define the
current supported surface.

### Grouped channel publication

The host materializes detached syscall outputs before asking the actual Rust
completion owner to publish. Rust retains the result and prepared signal,
preflights physical destinations and publishes through its ordered wait queue.
Queue contention selects an exact native observation; its real settlement is
reported before Rust decides whether to retry, hold, publish or discard.
Queue validation precedes payload and status stores. Waking a node does not
retire the returning native waiter or release its physical pin. An uncertain
foreign write quarantines the image and retains its charges.


Private Worker IPC requests wake the kernel's native observer directly. Replies
and guest atomic notifications continue to use the versioned group wait queue.
Every notification validates the current source and virtual word; no translated
pointer or guest view is retained across calls.

A naturally exiting pthread may lose its Rust task and host registration before
its final EXIT response can take the queue mutex. That exact retired mailbox
keeps only terminal publication authority until the response lands. It never
relistens or dispatches another syscall; ordinary stale completions remain
rejected. The final wake grants no Worker quiescence or storage reuse proof: the
existing exact Worker, native-observer and image retirement fences still apply.
If teardown cancels this queued response, its last actual native observation
still settles before releasing the retired transport token. STOP/CONT preflight
preserves this terminal queue owner without reactivating the removed task.

Root launch retains an actual `ProcessTable` operation through publication,
Worker binding, process registration, import connection and constructor scheduling.
The kernel publishes the task and physical descriptor itself and issues each
platform effect in order, including readiness and launch-message delivery.
A job-control-stopped constructor keeps its operation
until its exact start or cancellation observation arrives. Setup failure requests
sealed absence and normal reference/image retirement; an uncertain constructor
keeps its resources charged and contains the disposable kernel. Already accepted
absence from concurrent teardown is reused by Rust rather than requested again.
Fork, session shutdown and grouped delayed-result authority also reside in the actual kernel owners described here.

Grouped fork replay uses a kernel-owned word in the existing 64-byte task
control record. Its blocking wait is a normal stateless Rust SDK primitive.
The actual fork operation retains native effect sequence IDs, chooses startup,
replay commit, cancellation, stop/join and reference-detachment progression, and
ignores late native completions without granting the next effect. Native waits
can be cancelled while outstanding. Before any child Worker effect, Rust clears
the child's copied syscall mailbox using the actual caller's kernel-owned
channel/control slot, preserving the parent and surrounding continuation bytes.
Exact task liveness distinguishes process exit from a stopped parent without
waiting for host storage teardown. Memory-free Worker readiness checks the
kernel replay protocol before the shared backing is sent.
A committed child cannot be rolled back by
a later parent exit. Generic native setup failures report `EIO`; an explicitly
reported resource exhaustion remains `ENOMEM`. Constructor uncertainty retains
custody and contains the kernel. Native and real SDK Node/browser checks cover
this fork path. Kernel-selected group shutdown and SDK private-growth allocation
are implemented. The current validation receipt distinguishes the tested candidate from later source integration.

The actual kernel thread record retains its creator and grouped entry recipe.
The mapping operation emits the complete pthread control/bootstrap layout;
grouped channel attachments carry identity rather than a second host recipe.
Before native channel attachment, Rust consumes a one-shot binding grant for
that operation's exact task and selected offset. Missing, duplicate or mismatched
grants fail before native registration; binding cannot be acknowledged early.
Fork derives its continuation and caller mailbox from those retained records.
A thread-born process leader keeps its thread bootstrap role for subsequent
forks; exec clears the outgoing recipe.

Grouped clone enters the retained Rust operation before allocating a TID. The
ordinary direct clone entry refuses grouped callers, and the former separate
thread-preparation wire entry is unsupported. Rust chooses native object setup,
reference binding, connection, scalar-only preparation, readiness observation,
runtime listeners and guest-memory delivery. Issuing memory delivery commits
creation; a later child exit or parent death cannot roll it back. Parent stop
holds the result until continue, while parent exit or a pending fatal exit
suppresses publication without undoing the committed child or parent-TID word.

Before delivery, cancellation retains each entered native observation until its
actual settlement. A timeout permits another observation; it is not settlement.
The kernel can stop an undelivered task because no native Worker was authorized
to receive its memory. This does not fabricate Worker absence or a native join.
Rust still requires containment, exact reference disposal and control reclamation.
Uncertain construction or delivery quarantines the image and retains its charges.
The host holds objects and executes the exact requested effects; it no longer
selects grouped clone startup, rollback or failed-clone reclamation. Grouped delayed syscall-result publication and session shutdown use the same actual kernel owners. Ordinary host integration remains in TypeScript.
