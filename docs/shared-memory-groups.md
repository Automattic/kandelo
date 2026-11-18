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

These internal components do not expose an embedding launch option. Mapping
materialization currently operates only within the image's published virtual
extent; physical group growth cannot establish virtual capacity. Transactional
map/protect/unmap/remap/break publication and rollback, complete lifecycle,
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
