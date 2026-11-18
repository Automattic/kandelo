# Shared-memory process-group preview contract

This is the target contract for an opt-in trusted desktop preview, not a
statement that the shipping runtime implements it. The
[baseline record](measurements/2026-11-16-shared-memory-desktop-baseline.md)
identifies the isolated experiment and the ordinary failure it addresses.
Neither the successful demo nor those bounded checks replaces integration and
release validation.

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

The Rust kernel owns group identity, membership, limits and object lifetime.
The host owns the corresponding WebAssembly.Memory and Worker instances.
Inspection and UI consume that state; they do not invent group membership or
authorize reuse. No persistent browser or audio realm receives the guest
memory or a view into it.

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

## Executables and process lifecycle

The normal SDK prepares versioned compatible executables. The runtime checks
the translated contract, program ABI and kernel-host contract before admission.
An incompatible executable fails clearly before replacing the current image;
editing a stamp is not compatibility. An ordinary executable keeps its ordinary
execution path. Running a translated executable outside a selected group is a
separate compatibility decision that requires explicit implementation and tests;
the desktop preview does not promise it implicitly.

Fork within a group preserves virtual pointer values. Private pages become
independent child state; shared mappings keep their backing identity and live
visibility. Thread replicas share their process's virtual root but own their
translation scratch and initialization state. Constructors and active data
initialization are not replayed into already initialized shared state.

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
reclamation. Existing ordinary-pthread gaps, including asynchronous cancellation
and robust mutexes, are not silently broadened by this preview.

Logical growth and host control allocations serialize with the same mapping
publication rules. Missing pages below a logical high-water mark still need
mapping and initialization. Reused payload, scratch and control storage must
not expose a predecessor's bytes. Sustained growth and release must not consume
physical capacity monotonically when the released pages are reusable.

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

## Accounting and acceptance

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
workload. The lower-resolution [format-4 resource screen](measurements/2026-11-16-shared-group-desktop-cost.md)
found faster verified shell response and higher total browser footprint in
three fresh Chromium launches per arm. It does not measure the integrated feature.

Promotion requires independently testable stages: kernel group authority;
normal SDK artifacts; explicit Node/browser backend; waits and lifecycle;
opt-in launch; complete in-memory object semantics; graphics ownership; and a
usable desktop image. The final feature must build without private source
rewriting or an experimental checkout.

Each stage needs checks for its actual contracts. The release candidate needs
relevant ABI/baseline, host, POSIX/conformance, canonical-product,
browser-memory and benchmark gates. Node and Chromium/Firefox/WebKit are peers;
Playwright WebKit is not native Safari evidence. Record failures and unrun gates
as such. Compare the final candidate with its recorded integration target,
and use a matched ordinary control to isolate group costs. Preserve setup,
idle, interaction, resize and sustained lifecycle measurements separately.

No fixed performance threshold has been agreed. Publish the measured tradeoff
before promotion: capacity benefit, total footprint, CPU, input response and
presentation observations. Usable interaction permits measured overhead; it
does not waive correct semantics, bounded ownership or truthful reporting.

## Review stages

The initial kernel component now owns admission, image and task receipts, plus
backing-owner holds. Fork reserves the child image before publication; pthread
creation reserves membership before inserting its task. Failed construction can
roll back prepared admissions; live/stopping/quarantined Workers block removal.
Image custody outlives the last Worker until explicit lifecycle cleanup, and old
receipts remain distinct from an exec successor.

Host-adapter 8 adds protocol-1 fixed metadata records and advertises admission
capability only. Program ABI 56 remains unchanged. The generated kernel-host
snapshot includes record layouts and actions; full unsigned generation/receipt
values have separate status returns. These interfaces do not advertise a ready
execution/stop backend or expose a guest group-creation syscall. Normal host
launch and terminal-stop integration remain later stages.

The SDK now provides `wasm32posix-shared-memory` to prepare a separate,
versioned grouped executable while preserving the ordinary input. The
translator and standalone C/Worker fixtures exercise translated memory
operations, permissions and atomics. This artifact preparation does not enable
grouped launch: the normal launcher still refuses the required group-memory
import. See [SDK preparation and its limits](sdk-guide.md#experimental-memory-group-translation).

These are review boundaries for the integration series. Each stage must leave
the ordinary backend usable. Incomplete grouped behavior stays
explicitly gated until its prerequisites are available.

The in-progress runtime backend keeps one exact image source separate from
each execution replica. Internal kernel-Worker registration accepts an opaque
published allocation handle and revalidates Rust identity before attaching its
syscall channel. Both Worker entries validate the prepared transport before
receiving storage. Byte access, continuation metadata and channel publication
use virtual addresses explicitly; native execution retains its native path.
Image-access revocation neither stops replicas nor releases their physical
pages. Exact native observer pins survive revocation until engine settlement.

The mapping coordinator's internal image barrier freezes replica membership
and requests a distinct epoch from every live execution replica. A partial
acknowledgment, stopped member or revoked image is insufficient. Barrier setup
faults quarantine uncertain replicas and retain failed wait drains and storage
charges. This is reversible execution coordination, not a terminal fence or
permission to recycle pages. The staged Rust metadata owner separately checks
exact transaction custody and intervening changes before publication. Normal
grouped memory-call dispatch now joins these owners for the implemented
anonymous map/unmap/protect/remap/brk path; this remains an internal integration.

Host-adapter 10 carries fixed copied records for grouped mapping preparation,
validation, commit and cancellation. Rust retains a budgeted owner for one
exact task receipt and image generation; a sibling, stopped admission or stale
exec cannot publish it. Cancellation can discard an old preparation without
changing a successor manager's transaction. All receipt/token bits remain
unsigned 64-bit values, separate from status returns. The program-56 digest
is unchanged. Host-adapter 12 extends this transaction to file-backed private
mappings; shared-object and device effects remain unfinished.

Private file preparation captures a readable regular-file or memfd source,
its exact underlying backing and OFD lock custody. It retains no descriptor
number: close, unlink and reuse cannot redirect a pending read or later remap
growth. Mapping fragments share one admitted source hold; the final metadata
reference unpins it. Source, file-label and close-journal metadata consume the kernel I/O
budget before acquisition. Final native close effects use a preallocated
journal drained at the outer kernel-scope boundary after process borrows end.
No asynchronous callback or host close runs from a metadata destructor.

Rust describes the initial mapping or remap tail to populate, owns its read
cursor, and refuses commit before complete population or EOF. The host copies
bounded scratch results into fresh unpublished physical pages, revalidates
the exact token and image, and publishes both models. Read errors cancel
without replacing live mappings; temporary unavailable data is retried while
the source and barrier remain owned. These eager private copies do not yet
implement invalidation/SIGBUS after truncation or access to whole pages beyond
EOF. Those remain semantic gaps, alongside the shared-object work; zero-filled
storage is not evidence of that behavior.

Fresh registration installs budgeted Rust-owned initial linear intervals and
exact heap/control bounds in one operation. Protection checks cover both
linear and mmap regions; unmap leaves real holes. Observed virtual growth
adds only newly appended pages, preserving existing holes and permissions.
Heap growth preserves existing partial pages and their rights, while newly
materialized pages are zeroed; shrink removes whole trailing page mappings.
The logical extent remains a high-water bound rather than proof every page
is mapped. Grouped fork metadata is copied from the live kernel parent,
including controls, holes and permissions; it is not recreated from a fresh
all-writable image or added to the ordinary fork wire. This metadata behavior
does not prove the unfinished physical fork integration.

The internal image owner can now prepare a private physical fork under an
acknowledged image-wide execution barrier. It copies each distinct mapped
physical page into child-owned storage, preserving holes, protection and
within-image aliases, including bytes inaccessible under current protection.
The child gets a separate root and zeroed replica scratch; its initialization
gate remains fresh for the normal fork-child mode that skips data replay.
One pool operation reserves contiguous controls and fragmented payload before
publishing allocation bits. Busy/exhausted preparation leaves parent custody
unchanged, and exact unconstructed cancellation returns the child allocation.
This is an internal private-page operation. The dispatcher connects it to an
explicitly configured grouped-fork backend and a shared Node/browser child
Worker launcher. Normal embedding launch remains gated. Shared-object
inheritance remains separate.

Host-adapter 13 adds a receipt-bound private fork metadata operation. After the
host pauses the image and reads its logical extent, Rust validates the exact
running caller and absence of pending mappings, observes virtual growth, then
allocates the child with the inherited live MM. Shared/device inheritance is
refused until its effects are connected. The ordinary fork export refuses
grouped images rather than snapshotting stale virtual metadata. This boundary
does not establish host barrier or Worker-launch acceptance on its own.

The kernel Worker queues grouped fork and mapping changes in one image-owned
FIFO. Fork waits for every parent replica's acknowledgment, reads its logical
extent and continuation through the image source, and then calls the exact
Rust fork boundary. A busy physical allocator retains the same child identity
across retries. A separate `onGroupedFork` callback receives the prepared child
replica; ordinary `onFork` never receives the common physical Memory as a
native clone source. The callback must publish/register and complete normal
continuation replay before resolving, retrying each kernel publication step's
pre-entry contention independently. The image barrier remains owned through
that callback. Resolving without image adoption poisons the kernel generation.

Channel retirement before launch cancels the exact unpublished child; once a
callback starts, it owns partial publication until it settles. An adopted child
survives retirement of its caller. Failed publication begins Rust retirement
before quarantine. Unpublished cancellation returns its exact allocation;
published or uncertain storage stays charged. The shared child launcher uses
the normal externref/import owners and continuation replay commit gate after
authenticated prepare/ready/launch. It releases its reference observers only
after a terminal fence, Node join or sealed never-constructed Worker.

Host-adapter 14 binds each published replica to its concrete Worker before
execution. Only that Worker's exact quiescence receipt (or a Node thread join)
retires its execution admission. Browser termination alone is insufficient.
Exit waits preserve their status record and remain pending until all that
child's execution admissions retire; the last receipt wakes parked waits and
retries synthetic-init reaping for an already-published exit. Replica access
and execution-barrier membership end separately from kernel image access.
Physical pages remain charged: these fences do not yet establish engine wait
retirement, safe physical reuse or a lifecycle allocation plateau. Grouped
pthread replay and broader release gates remain unfinished.

Host-adapter 11 makes process-range preflight direction-aware: the host
checks every virtual page for guest read or write access without copying a
payload. Grouped scalar read/write/pread/pwrite/getrandom, including small
buffers, use Rust's existing guest-address transport. Rust resolves the fd
and access mode before destination checks, validates every read/readv/preadv
destination before consuming input, and rechecks frozen read retries.
Read-only sources remain valid for write/writev. Entropy also rechecks only
its remaining destinations before generating a resumed batch. Actual byte
transfers revalidate current access; preflight never grants future authority.
Generic grouped input/output arguments are checked for the corresponding
access before dispatch; an unreadable captured length is an ordinary EFAULT.
Frozen retries retain their copied inputs and recheck output rights before
entering Rust again. A rejected
retry releases its exact kernel binding and any owned wait state; affinity
queries retain their task-lookup-before-output-error ordering.

`GuestRecvmsg` in the engine-independent runtime owns copied header/iovec
metadata and the received result. Before consuming a carrier, it checks every
payload destination, the actual header result fields and the potential
name/control prefixes selected by the exact kernel queue. It neither clones
queued references nor treats unused advertised capacity as writable output.
Publication occurs after ending the active retry binding, preserving descriptor
installation/rollback, zero-byte datagrams, peeks and close-on-exec flags.
Numeric fd reuse cannot redirect a parked receive to a replacement socket.
DRI/GL output preflight likewise checks guest write authority without a
payload-sized probe allocation; input-only KMS operations explicitly request
read access, preserving read-only input buffers. These are internal mechanism contracts; normal
C/browser execution, remaining kernel-dereferenced paths and full stage4
acceptance are still required.

The internal image owner can now stage anonymous map, unmap, protection and
remap PTE changes behind its exact all-replica barrier. Replacement maps use
fresh zeroed physical pages, so a refused Rust commit can restore old entries
without destroying old bytes. Preparation and unpublished rollback use
nonblocking root/pool acquisition; a busy owner keeps custody for a later
worker turn. Unexpected commit traps contain the image and keep storage
charged. Removed PTE references remain retained, including references moved
by remap; this is not a completed reclamation mechanism. Snapshots report
staging-array bytes and retained mapping references separately from allocated
physical pages. Staging arrays scale with the admitted virtual page-table
capacity and are dropped after successful commit or cancellation. This path
still needs actual guest acceptance; its synthetic barrier tests do not
establish guest quiescence.

The shared Node/browser kernel Worker retains each mapping's exact pending
channel request, image source, registration, generation and Rust token. It
copies scalar arguments once and serializes same-image requests before taking
an execution barrier. Once every replica acknowledges, it captures the
logical root extent and prepares Rust metadata with separate bounded scratch
request/result records. Before publication it revalidates both Rust metadata and the current
caller; it never completes a replacement request or registration. Deferred
barrier/lock progress observes native control-word notifications with bounded
engine waits, retaining each image pin until its promise actually settles.
Timeouts only schedule revalidation. Detached unpublished cleanup survives
channel removal and keeps allocation custody when the pool is busy. Its
completion is not an execution or engine-observer retirement fence. A brk
query reads the committed kernel break without a barrier or allocation;
memory-admission failure on growth reports the unchanged break. Queries and
failed mutations use the normal signal-delivery path before completion, and
cancelling a queued owner preserves its earlier dependency for successors. These
unit tests alone do not establish usable grouped program execution or measured
dispatch cost.

The standalone `grouped-sdk-execution` fixtures also run a real libc C program
prepared by `wasm32posix-cc`, the normal fork instrumenter and
`wasm32posix-shared-memory`. A disposable kernel Worker admits the image and
launches the normal process Worker entry through the memory-free readiness
handshake. The page receives only copied output and status. The probe covers
an observable heap allocation, atomics, read-only pipe sources, rejected
read-only destinations without consuming the pipe byte, protection restoration,
in-place and moved remaps, fixed replacement and zeroing. Restored protection
coalesces only compatible adjacent metadata with identical backing/driver
ownership and contiguous file offsets; growing a suffix preserves its
neighbor's mapping. The ordinary control records its existing partial
protection behavior explicitly rather than claiming ordinary enforcement.
The private-file probe also checks offsets, writable private mappings from a
read-only descriptor, descriptor reuse, close/unlink and file-backed remap
growth. Its ordinary control records the existing zero-filled remap-growth
gap. Both hosts compose their fixture's root image through the normal image
writer inside the disposable kernel realm, so `/tmp` reaches the kernel tmpfs.

The grouped fork probe exercises real C continuation replay, inherited heap,
globals and private mappings, retained protection, inherited pipe descriptors,
private child writes and parent wait status 23. The same C source also runs
through the normal ordinary Node host. Its ordinary read-only-destination
behavior remains an explicit control. Ordinary browser fork equivalence and
the broader pthread, cancellation and reclamation gates remain separate.

Run the Node case with `cd host && npx vitest run test/grouped-sdk-execution.test.ts`
and the Chromium/Firefox/WebKit cases with
`cd apps/browser-demos && npx playwright test --config playwright.grouped-sdk.config.ts`,
each through `scripts/dev-shell.sh`. These are internal admission and syscall
integration checks, not a public launcher, package/image desktop, fork/pthread,
reclamation, conformance, browser-memory or performance acceptance result.

These internal components do not expose an embedding launch option. Mapping
publication stays within the admitted virtual capacity; physical group growth
cannot establish virtual capacity. Complete mapping/heap semantics, lifecycle,
shared objects and graphics remain required before preview support. See the
[address-space architecture](architecture.md#experimental-process-address-spaces).

| Stage | Change | Acceptance focus |
|---|---|---|
| 1 | Contract and baseline | Scope, trust, reproducible failure and truthful evidence |
| 2 | Kernel group authority | Distinct groups, authorized admission, budgets and lifecycle |
| 3 | SDK artifacts | Normal preparation, version checks and memory-operation semantics |
| 4 | Explicit runtime backend | Node/browser mapping, private fork state, protection and thread replicas |
| 5 | Waits and retirement | Targeted cancellation, exact exit/exec/kill fences and bounded reuse |
| 6 | Opt-in launch | Supported build/install/run without the research checkout |
| 7 | In-memory shared objects | Coherent descriptor I/O, offsets, resize, transfer and lifetime |
| 8 | Graphics ownership | Real buffer aliases and upload/presentation/context retirement |
| 9 | Desktop preview | Canonical image, pressure benefit, sustained stability and measured tradeoff |
