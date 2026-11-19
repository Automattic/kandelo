# Shared-memory process-group preview contract

This records the target contract and the bounded desktop-first implementation
below. It is not a statement that the complete contract is ready to ship. The
[baseline record](measurements/2026-11-16-shared-memory-desktop-baseline.md)
identifies the isolated experiment and the ordinary failure it addresses.
Neither the successful demo nor those bounded checks replaces integration and
release validation.
The [fresh integration checkpoint](measurements/2026-11-19-shared-memory-desktop-integration.md)
records the current normal package/image path and its remaining failures.

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

## Desktop-first opt-in

`BrowserKernel` and `NodeKernelHost` accept an explicit embedder option:

```ts
experimentalMemoryGroup: {
  maximumPages: 8192, maximumProcesses: 24, maximumTasks: 64,
}
```

Compatible byte launches through `spawn(bytes, argv, options)` use a single
kernel-owned group in that machine. The option reserves a physical ceiling;
it does not raise ordinary process or renderer limits. Ordinary artifacts
keep the ordinary backend. The disposable kernel Worker owns launch, fork,
pthread, compatible exec and retirement; the embedding receives copied
output and status. Failed fork setup first seals the exact never-started
Worker or requests cooperative stop and joins its terminal proof. Published
image metadata, channel observers and physical pages retire before the
allocated Process is removed or the parent's failure returns. A stop timeout
retains uncertain storage; it does not authorize reuse. The regression rejects
16 setups before registration and after actual replay, verifies no waitable
child or allocation leak, then performs a successful fork. Initial grouped `spawnFromVfs` admission is not yet wired.
The preview reads the selected executable from its actual image and uses the
byte-launch API. This is a development preview, not full launch acceptance.

Grouped child exit notification follows the same execution-stop boundary as
wait status. The kernel keeps SIGCHLD and automatic reaping pending while any
exact execution receipt still owns custody, including quarantined siblings.
A parent awakened by SIGCHLD can therefore observe the child's exit through
`waitpid(..., WNOHANG)`; it cannot consume its only notification before that
status is available. The public Node regression repeats this signal-driven
reaping pattern for 64 exits with live pthreads, in both prepared and ordinary
program modes.

Prepare a separate opt-in image from an ordinary SDK/package-built desktop
image through the normal SDK and image writer:

```sh
scripts/dev-shell.sh host/node_modules/.bin/tsx --experimental-wasm-exnref \
  images/vfs/scripts/prepare-shared-desktop-image.ts \
  ORDINARY.vfs.zst GROUPED.vfs.zst
```

The builder resolves deferred programs through the normal package resolver,
prepares Sway, Swaybar, Swaybg, Swaymsg, Foot, the shell and Coreutils, and
validates explicit per-path grouped artifact policies. It preserves the input
and writes an adjacent `.memory-group.json` provenance report. A failed
preparation retains its report and staging files. Its optional source-provider
API permits explicitly retained compatible image fixtures; that evidence does
not establish a fresh package build or a canonical image.

The developer consumer is `apps/browser-demos/grouped-desktop.html`. Prepare
its development image through the ordinary package, SDK and image paths
inside the declared dev shell:

```sh
./run.sh partial shell sway swaybg foot wayland-demo bibata-cursor-theme
node --import tsx images/vfs/scripts/prepare-shared-desktop-image.ts \
  local-binaries/partial/shell-partial.vfs.zst .scratch/shared-desktop.vfs.zst
export KANDELO_GROUPED_DESKTOP_IMAGE="$PWD/.scratch/shared-desktop.vfs.zst"
./run.sh browser --partial --config vite.grouped-desktop.config.ts --port 6209 --strictPort
```

The selected image's lazy files and archives resolve through the normal
validated package resolver; build output includes those bodies and a hash
manifest. `KANDELO_GROUPED_DESKTOP_ASSETS` explicitly selects an optional
verified frozen asset manifest for retained historical fixtures. It is not
required for a fresh package build. The Vite config uses the normal browser
app's checked terminal-worker bundling contract.

The page opens a temporary trusted Sway desktop with real terminal input,
serialized Sway IPC controls and Stop. `groupPages` can select a lower
physical page budget (256–8192); process and task budgets stay 24 and 64.
Exhaustion can refuse the Sway IPC client itself with EAGAIN, a Sway fork,
or a guest exec with ENOMEM. The preview does not reserve a control slot.
On JavaScriptCore the group provisions its complete admitted backing extent
before launching participants. This avoids concurrent shared-memory growth
and participant-instance teardown, a confirmed engine boundary. An 8192-page
group therefore exposes a 512 MiB backing buffer from startup; this is capacity,
not mapped guest usage or measured resident memory. The declared maximum and
allocation budget do not increase. Other browser engines grow the backing as
needed. Constructor refusal remains visible. This policy does not establish
that the intermittent IPC timeout is resolved; sustained and resource-cost
validation remain required.

The isolated Playwright config is `playwright.grouped-desktop.config.ts`;
select a retained evidence directory with `KANDELO_GROUPED_DESKTOP_EVIDENCE`
and an existing server with `KANDELO_GROUPED_DESKTOP_URL`. Tests exercise
actual pointer-selected shell PIDs, workspace changes, and terminal recovery
after a real capacity refusal. This consumer is separate from the normal
gallery and does not change its default launch behavior. Each stdout/stderr
diagnostic tail retains at most 64 KiB of independent bytes; copied state
reports how many bytes were discarded. Serialized Sway commands capture their
complete replies separately, including UTF-8 split across callback chunks.
Diagnostic retention does not truncate command replies.
The copied diagnostic state also retains the last 512 process events with
their parent IDs and main-realm receipt times. It uses the ordinary process
event callback and adds no polling; these records are not retirement proofs.

The fresh partial-image candidate passes the default two-terminal interaction
and capacity-refusal/recovery checks on Chromium, Firefox and WebKit. Longer
WebKit terminal lifecycles still intermittently time out on Sway IPC. That is
an unresolved preview failure. The current image also reports a missing Compose table, so
dead-key input is not available. These bounded checks are not sustained
lifecycle, native Safari, conformance or performance acceptance.

## Accounting and acceptance

The desktop-first integration currently implements whole fixed-size tmpfs
objects with shared mappings and coherent descriptor reads. The inode and
mapping owners retain one physical backing through close, unlink and fork.
Promotion refuses pre-existing legacy mapping holds; ordinary or cross-group
shared attachment is refused. Descriptor writes and size changes after
promotion remain unsupported and return an error. This bounded surface does
not complete the target shared-object contract above or desktop acceptance.

The desktop integration also admits read-only `MAP_SHARED` mappings of
ephemeral rootfs files under a kernel-held immutable read lease. Their VMA
keeps `MAP_SHARED`; physical read copies are independently reclaimable.
Writes, truncation, writable protection and legacy shared attachment are
refused while the lease exists. Closing the descriptor does not release the
lease; the final mapping/source reference does. Persistent writable files,
nonzero mapping offsets and expanding these mappings remain unsupported.
This is a bounded read-only surface, not general writable regular-file sharing.

Host-adapter 23 adds the exact owned-driver mapping bridge. EGL command
streams use private process pages through the same all-replica barrier and
staged physical allocation as other grouped mappings. Their existing driver
token and transaction retain authority through construction or rollback.
Whole-stream exact unmapping retires the driver binding before releasing
physical pages. Fragmented driver unmapping and CPU graphical BO mappings
remain unsupported. GL submissions read checked virtual addresses and copy
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
values have separate status returns. Those admission-only interfaces do not expose a guest group-creation syscall.
The desktop-first host integration above now connects the explicit backend;
the complete release gates remain open.

The SDK now provides `wasm32posix-shared-memory` to prepare a separate,
versioned grouped executable while preserving the ordinary input. The
translator and standalone C/Worker fixtures exercise translated memory
operations, permissions and atomics. Artifact preparation alone does not enable
grouped launch: callers must select the explicit host option above. See [SDK preparation and its limits](sdk-guide.md#experimental-memory-group-translation).

The in-progress exec preflight now shares the Rust grouped-artifact reader
with SDK output validation. Only a current kernel-owned image membership
selects that profile for a retained executable target. It checks the versioned
JSON declaration, physical memory import, deferred initialization and binding
signatures while ordinary target admission continues to refuse the namespace.
The parser raises the kernel's minimum imported memory from 21 to 22 pages;
host-adapter 17 records that change while program ABI 56 remains unchanged.
The kernel memory ceiling is unchanged.

The kernel can now reserve a future grouped exec receipt bound to the current
caller, generation and retained target, and prepare its complete virtual memory
map before commit. Admission or metadata allocation failure preserves the old
image. The normal lifecycle commit installs that prepared map, keeps the PID
and inherited descriptors, and closes `CLOEXEC` descriptors. Starting the new
main remains refused until all old-generation task receipts have retired.

Unconstructed cancellation first retires only the exact future task. Its image
serial and process-removal hold survive until the owning host has settled
unexposed references and scratch. Finishing cancellation releases the Rust
image hold; the host must return final root/payload pages in that same
serialized entry. A stale receipt cannot remove a
later reservation for the same proposed generation. Host-adapter 18 describes
these preparation interfaces; they do not prove physical cleanup or Worker
stop. The internal host backend now allocates the future physical image in
the existing group backing before invoking its explicit grouped exec callback.
The callback receives an opaque reservation and copied layout, without the
retained kernel target or commit authority. Allocation, compilation, policy
and callback failures join exact unexposed scratch/image rollback before the
old syscall resumes. Expected allocation refusal returns `ENOMEM`; uncertain
commit or failed cleanup retains storage and fails the kernel instance.

The SDK C rollback probe alternates `execve` and `execveat` over sixteen
attempts, checking unchanged PID, old data and an open `CLOEXEC` descriptor
after each failed attempt. A guest/host acknowledgement binds each physical
allocation sample to that actual return. One case exhausts physical allocation
before the callback; another refuses after a second physical image exists.
A third builds a larger target through the normal SDK/linker and verifies that
the old process's virtual ceiling also produces recoverable `ENOMEM`, without
allocating a physical replacement or failing unrelated kernel state. Cancelled
opaque reservations lose their private association, so retaining copied layout
metadata does not retain the old image through that association.
The internal backend also has a shared Node/browser replacement helper. It
claims the committed opaque reservation on the commit stack, removes the
exact outgoing transport and requests cooperative stop for every old-image
replica. New Start remains refused until old task receipts retire. The helper
joins the exact Worker fences and native-wait drainage, installs the already
prepared kernel map through private preparation authority, then retires the
old image by root/source identity. Physical Memory equality cannot identify
exec generations because both images use the same backing.

The replacement Worker uses the normal memory-free readiness handshake and
SDK executable. Its new image owns fresh initialization, TLS and constructors;
PID and inherited descriptors survive, while `CLOEXEC` descriptors close. A
real C probe repeats sixteen self-execs. A variant leaves one busy pthread
and native wait32/wait64 pthreads in each outgoing image; the fixture observes
the actual waits and busy progress before allowing exec, and checks exact
stop acknowledgements, zero resumed waiters and bounded allocation reuse.

The kernel also holds a committed but unexposed future image against parent
reaping. Start transfers this hold to normal execution custody. If a signal
terminates the process during handoff, the host joins the exact old-image
fences, cancels the never-exposed future task/scratch/image, retires the old
image and then publishes the real kernel signal status. No replacement Worker
or guest exit event is fabricated. Host-adapter 19 records this lifetime
contract; the normal program ABI stays unchanged.

The private exec exit owner survives future-image cancellation and old host
registration removal until exact image retirement finishes. Late generic
finalization or crash ingress consumes the cached kernel signal and parent;
it cannot publish early, replace the signal, or touch released old storage.
After publication, the host reads Rust's existing exit-publication bit to
suppress another generic exit callback without retaining a host PID record.
Host-adapter 20 requires this scalar query; program ABI 56 stays unchanged.
Image retirement joins asynchronous host-reference closers before freeing
physical pages. A rejected closer retains the charge and is not rerun.
The real C signal probes exercise late finalization and crash ingress while
those old references remain owned, then reject a crash from the retired image.

The public launcher still refuses grouped execution. Broader signal/destroy races,
other postcommit failure disposition and the full promotion gates remain required
before grouped exec support is advertised. Unexpected postcommit failure
currently contains the instance with storage retained; it cannot restore the
old image or establish reuse.


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

An exact image stop request closes admission to new mapping and fork barriers,
even while its Rust generation and host registration remain retained for
retirement. Pending operations cancel their own prepared state and suppress
completion on the stopped caller's channel. The stop request itself proves
neither Worker quiescence nor waiter retirement, and releases no storage.
Unexpected barrier-state faults still quarantine their exact owners.

The internal backend also implements anonymous `MAP_SHARED | MAP_ANONYMOUS`.
Rust mints a group-scoped backing identity from the exact mapping transaction
and retains a budgeted capability in the live MM. VMA fragments and forked
MMs share that capability and preserve object offsets. The host allocates its
physical pages once, aliases those pages across process roots and copies only
private pages at fork. Protection remains local to each mapping. Closing one
mapping or image cannot free another image's backing.

A shared object retains its initial backing contents across shrink, moved
subranges and regrowth within that extent. Growth beyond the original object
length returns `EOPNOTSUPP`: EOF/SIGBUS semantics and descriptor resizing are
still gates, rather than silently extending the backing. Device and
legacy descriptor-backed sharing remain refused. Public grouped launch is
still gated; this internal anonymous path is not complete descriptor or
graphical-object support.

Host-adapter 21 extends mapping-description protocol v4 to 136 bytes with the
kernel object ID, initial byte length and mapping byte offset. Non-shared
effects carry zeroes. This protocol version is separate from executable
format4, whose PTE layout is unchanged. A fresh anonymous object's ID equals
its creation token; a remap carries the inherited ID under its new exact
token. The host validates the whole record again before publication.

Shared image holds survive removed PTEs while engine observations or wait
records still pin the object. Reclamation ends only the detached image's
hold; physical pages return with the last hold. Snapshots report unique
shared pages and image references separately. The metadata adds one optional
pointer per `MappingFile` label (labels are already shared across fragments),
a compact host page-index array per object and image-owner sets. It creates
no extra Wasm Memory and raises no ceiling. Logical pool counts do not prove
lower RSS or a lower browser reservation.

The SDK anonymous-sharing probe uses a forced nonzero-offset remap, then
forks and exchanges atomic flags and data without syscalls. It checks private
isolation, per-image protection, a live child after parent unmapping, later
child retirement and final shared-object release. Repeated cohorts reuse one
kernel and backing; they supplement the remaining release and desktop gates.

Host-adapter 10 carries fixed copied records for grouped mapping preparation,
validation, commit and cancellation. Rust retains a budgeted owner for one
exact task receipt and image generation; a sibling, stopped admission or stale
exec cannot publish it. Cancellation can discard an old preparation without
changing a successor manager's transaction. All receipt/token bits remain
unsigned 64-bit values, separate from status returns. The program-56 digest
is unchanged. Host-adapter 12 extends this transaction to file-backed private
mappings; descriptor-backed shared-object and device effects remain unfinished.

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
all-writable image or added to the ordinary fork wire. Physical launch is
coordinated separately by the kernel Worker.

The internal image owner can now prepare a private physical fork under an
acknowledged image-wide execution barrier. It copies each distinct private
physical page into child-owned storage and retains direct anonymous backing
pages as aliases, preserving holes, protection and
within-image aliases, including bytes inaccessible under current protection.
The child gets a separate root and zeroed replica scratch; its initialization
gate remains fresh for the normal fork-child mode that skips data replay.
One pool operation reserves contiguous controls and fragmented payload before
publishing allocation bits. Busy/exhausted preparation leaves parent custody
unchanged, and exact unconstructed cancellation returns the child allocation.
This is an internal private-page operation. The dispatcher connects it to an
explicitly configured grouped-fork backend and a shared Node/browser child
Worker launcher. Normal embedding launch remains gated. Descriptor-backed
shared objects and devices remain separate.

Host-adapter 13 adds a receipt-bound private fork metadata operation. After the
host pauses the image and reads its logical extent, Rust validates the exact
running caller and absence of pending mappings, observes virtual growth, then
allocates the child with the inherited live MM. Host-adapter 21 additionally
permits kernel-owned direct anonymous backing inheritance. Legacy descriptor
and device inheritance remains refused until its effects are connected. The ordinary fork export refuses
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
Execution fences alone leave physical pages charged. Whole-image retirement
additionally requires Rust exit or replacement of the exact image generation,
revoked kernel image access, settled mapping and clone callbacks, closed host
reference owners, and settled channel/native observers. The queue must contain
no node owned by that root, including unlinked notified or stopped nodes. A busy
lock or remaining node refuses release; a timeout never supplies retirement.

The allocator uses a bitmap rather than PTE reference counts. Whole-image
release deduplicates original payload, private fork copies, current and removed
PTE pages, controls and every stopped replica's scratch. It refuses overlap
with a peer image and preserves peer wait nodes. The old root lock is unlocked
before pages return to the pool; cleanup cannot write it after another image
reuses that page. This supports image-private storage only. Descriptor-backed
cross-image sharing still needs the shared-object ownership model.

The SDK pthread probe has run forty images on one kernel/group/backing on Node,
Chromium, Firefox and WebKit. Each cohort launches six pthread Workers, retires
all image storage back to the single metadata page, and reuses the same
285-page physical extent with the unchanged 2,048-page maximum and 1,024
declared thread slots. This proves normal-exit allocator reuse for this probe,
not lower RSS, shrinking linear memory, or kill/exec/crash/destroy acceptance.
The private-fork probe additionally repeats forty parent/child cohorts on one
backing, including inherited descriptors, private-state isolation, protection
and child wait status. It returns both images to the metadata page and keeps
a 327-page extent. Its non-pthread executable normally declares zero thread
slots. Full browser-memory, conformance and performance release gates remain
open.

Host-adapter 15 adds on-demand pthread controls. The grouped clone callback
receives a one-shot Rust TID capability without an ordinary Memory field.
Rust stages a host-reserved interval for that exact unconstructed thread;
the host queues it with mappings and fork, freezes the image and commits
zeroed physical pages with the existing mapping token protocol. A fresh entry
then initializes the virtual control slot, attaches its channel and publishes
its execution replica atomically with respect to image barriers. TLS, module
initialization mode 2 and thread entry use the normal Worker runtime. Threads
share their process's externref generation and have independent import endpoints.
Clone completion requires a published replica with its concrete Worker observer;
attaching a mailbox alone cannot report a successful grouped thread launch.

Control storage is allocated only for admitted threads. Eagerly reserving the
default 1,024 slots would require 4,245 initial pages for the SDK pthread probe,
exceeding its unchanged 2,048-page ceiling. That failed attempt was rejected;
the implementation uses the normal compact process layout and allocates each
four-page control slot on demand. Replica scratch is separately charged.
Host-adapter 16 retains exact control ownership in grouped image metadata
after `ThreadInfo` is removed. Reuse requires absent Rust task and Worker
custody, closed thread references and settled old-channel observers. The store
additionally checks physical native-observer targets and every queue node,
including live peers parked on old control bytes. It returns only private
replica scratch; four-page controls stay mapped and host-reserved in a cache
that Rust can bind to a new unconstructed TID. A stale receipt cannot release
that successor. The host waits for the kernel observer's real stop transition;
receiving the same message earlier in another callback grants no reuse.

Committed unmap/remap also retires removed physical pages after their last
current alias, queued wait target and native observer disappear. Still-pinned
pages remain charged until a later mapping turn or whole-image retirement.
Original payload tuples lose custody of returned pages, so a later image
cannot be freed through an old allocation tuple. Descriptor-backed shared
pages still need their separate ownership model.

A normal SDK probe creates and joins 256 pthreads in one live process on Node
and all three browsers. TLS initializers, constructors, stack data, native wait
timeouts and joins pass. The retained failed control-only candidate grew from
164 to 1,190 physical pages because stack unmaps still retained their payload.
With removed-page reclamation, the last 128 retirements plateau at 170 pages
on Node and 164 in Chromium, Firefox and WebKit. Retired mapping references
reach zero; image exit returns allocation to the single metadata page. Limits
stay at 2,048 maximum pages and 1,024 declared thread slots. This is allocator
reuse evidence, not an RSS or reservation reduction claim.

A known quota refusal is checked before requesting controls. If control
reservation commits but replica scratch allocation fails before Start, clone
rollback retains the exact thread receipt and image capability. After Rust
cancels the unconstructed admission, the host settles any attached channel and
physical native/queue pins before releasing the control row to the reusable
cache. Creator failure completion and whole-image release join that cleanup.
Start is recorded before publication: a publication exception is never treated
as proof that no execution realm exists.

A real SDK C probe uses a 196-page physical budget with the unchanged 2,048-page
virtual ceiling. The first clone reserves four control pages, exhausts the
physical budget and fails its two-page scratch allocation. Musl reports
EAGAIN, then frees its failed stack. The guest frees two held anonymous pages
for scratch headroom; retry must reuse the existing four-page controls and
runs/joins normally. The previous host fails the same retry by requesting
another control slot. Node, Chromium, Firefox and WebKit pass the corrected
path and return image allocation to one metadata page after exit. The initial
experiment without freeing scratch headroom failed and is retained.

Published deferred launches have a distinct absence path. The kernel binds one
exact Worker handle to the captured replica receipt before startup. Only that
same private DeferredWorkerHandle can seal never-started execution; foreign,
derived or constructor-attempted handles cannot supply absence. A deferred
launch already stale at observation is sealed before it can bind solely for
retirement. Neither path grants permission to start an obsolete image.

Failed published launches that prove absence or actual stop retain their exact
reference closer through Rust thread rollback and physical retirement. Launch
settlement and full clone completion are separate fences: an early thread
retirement can join adoption settlement without waiting on its own cleanup.
The creator receives its clone refusal only after this cleanup, while image
retirement continues to join the full clone owner. Endpoint and listener
references end explicitly; removing a listener after termination can still
reach a live old backing through a weak reference without retaining that
Worker or its Memory strongly.

A normal SDK C probe performs sixteen injected host refusals after publication
and before construction, each followed by a successful pthread retry. Only the
sixteen successful threads construct execution Workers. TLS/stack data, joins,
control/scratch reuse and bounded tail allocation are checked on Node and all
three browsers. A separate attempted-constructor probe does not report a
successful clone refusal or image reclamation: the instance fails with an
explicit missing-stop-proof error and retains all affected storage. Returning
an errno in that case would let musl unmap its stack while an uncertain realm
might still use it.

Grouped process exit has an exact image owner. Rust records exit first and
withholds wait status while any execution receipt lives. The host requests
cooperative stop only for that image, retries a busy wait-queue drain and joins
every actual Worker fence before publishing SIGCHLD and onExit. A natural exit
actor finishes its existing syscall/import handshake; signal death exempts no
actor. Image storage retirement also joins this publication owner, whose
registration reference is cleared after successful publication.

The C forced-exit probe blocks one child in a pipe read, runs another in a pure
atomic-counter loop and traps a third with an unreachable instruction. The host
observes the actual registered pipe-read wait and changing child counter before
allowing the guest parent to issue SIGKILL. Wait status is SIGKILL for both
killed children; the existing host-crash policy records the trap as SIGSEGV.
Each onExit follows the exact Worker fence. The busy counter remains unchanged
after publication, the parent remains active in the same backing, and forty
same-backing cohorts check bounded allocation and complete image release.

Bounded kernel-realm inspection returns a copied atomic guest word from an
opaque image capability. It exposes no Memory or view. Crash recording checks
both current registration/source and Rust exec generation, so a late old-image
error cannot signal a replacement PID. Grouped clone protocol/rollback errors
fail the instance with charges retained instead of targeting a PID alone. The
optional blocked-syscall observer reports whether Rust or a host pipe wait owns
the block; that observation is not a completion or stop proof.

A second real C probe forks a victim and survivor, each with pthreads issuing
indefinite wait32 and wait64. Copied ready words establish that these pthreads
have left their earlier syscall handshakes. Exact queue observation under its
lock then establishes four registered waits before the parent may kill the
victim. This observes queue registration, including notify-before-park, rather
than claiming the engine has already parked. After actual victim stop, the
embedding deactivates that exact process's host channels before retiring its
thread controls. The survivor must retain both waits and its unchanged return
word after the victim is reaped; only then may normal guest notifications wake
it. Each notification must report one waiter, and both joins check actual return
values. Threads stopped by process exit are recorded separately from guest thread_exit.
A successful guest join can precede its Worker's final thread_exit message;
natural process exit still joins the actual stop fence and retires its channels.
Forty same-backing cohorts repeat this contract without replacing the Memory.
Queue inspection exposes only none/waiting/returning/busy and grants no stop or
reuse authority. A busy drain remains retryable after the stop receipt arrives;
stopped replicas must not be skipped while their exact drain is still pending.
Thread scratch retirement retries that drain before releasing storage.
The embedding registers pending retirement from Rust's onThreadExit before a
subsequent clone may reserve another control row. Cleanup still waits for the
exact stop receipt, and Node also joins the real Worker exit. This prevents
sequential joined-thread churn from allocating an avoidable second control row
when its earlier Worker is only finishing host shutdown. A final thread_exit
message is separate from Rust logical exit and is not the reuse authority.

Further notification/timeout/cancellation races, exec replacement and destroy
still require real C/browser lifecycle coverage. Full browser-memory,
conformance, canonical desktop and performance acceptance remains open. Unit
coverage of a stopped callback failure does not establish guest post-adoption
rollback semantics.

An exact stopped replica can leave an active image barrier. Its member is
removed without fabricating an execution ACK, and its ACK observer is notified
to settle and revalidate remaining membership. Control storage stays charged
through actual observer settlement. This prevents a joined thread from holding
up a sibling's later mapping while its terminal fence is being delivered.

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
charged. Removed PTE references stay charged until the exact owner can retire
them. Shared backing tails remain with the object until its final owner ends. Snapshots report
staging-array bytes and retained mapping references separately from allocated
physical pages. Staging arrays scale with the admitted virtual page-table
capacity and are dropped after successful commit or cancellation. This path
is exercised through actual SDK guests as well as synthetic barriers; neither
selection replaces full shared-object, device, lifecycle or desktop acceptance.

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
the broader cancellation and reclamation gates remain separate. The pthread
probe runs three concurrent threads and three short-lived successors: TLS and
errno isolation, constructors once, concurrent allocation/growth, barrier and
mutex operations, actual native wait32/wait64 timeouts, join return values and
exact terminal fences. Its same-source ordinary Node control uses the normal
host. This bounded probe is not kill/exec/crash/destroy or sustained acceptance.

Run the Node cases with `cd host && npx vitest run --config vitest.grouped-sdk.config.ts`
and the Chromium/Firefox/WebKit cases with
`cd apps/browser-demos && npx playwright test --config playwright.grouped-sdk.config.ts`,
each through `scripts/dev-shell.sh`. These exercise admission, syscalls and exact fork/pthread retirement. The
embedding launcher and SDK/package/image desktop consumer are described above.
The probes do not establish full conformance, the combined browser-memory gate,
performance acceptance or sustained desktop reliability.

The explicit embedding launch option connects these components. Mapping
publication stays within the admitted virtual capacity; physical group growth
cannot establish virtual capacity. Current launch, mapping, lifecycle,
in-memory object and graphics support is bounded by the preview contract above;
the acceptance checks still apply to their combined behavior. See the
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

### Grouped channel publication preflight

The host prepares independent payload bytes and every source/destination view
before taking the ordered wait-queue mutex or changing a reply buffer. A view
allocation failure therefore leaves both payload and channel status unchanged,
including replies that cross noncontiguous physical pages. Queue validation
precedes payload and status stores; waking a node does not retire the returning
native waiter or release its physical pin.


Private Worker IPC requests wake the kernel's native observer directly. Replies
and guest atomic notifications continue to use the versioned group wait queue.
Every notification validates the current source and virtual word; no translated
pointer or guest view is retained across calls.
