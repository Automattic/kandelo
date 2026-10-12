# Architecture reflections

This document records reusable design lessons from moving syscall and
filesystem authority into the Rust kernel. It explains why the boundaries
matter and how to evaluate future changes. [Architecture](architecture.md)
describes the implemented system; dated reports under `docs/plans/` retain
the investigation evidence.

## Run agent commands with ordinary guest authority

An agent and a person can share one computer without sharing one stream of
keyboard input. An agent command needs its own process family so typing in
the user's terminal cannot change that command, and the command cannot become
input to a program the user opened. Track the family across fork, spawn and
exec; collect its output and cancel only its members. Completion requires
process exit, worker detachment and cleanup, rather than successful signal
delivery. Run file writes as the guest account too: a convenient privileged
host write would give the agent different permissions and file ownership
from the person using the computer.

A browser call can stop waiting before its guest job finishes. The kernel
must refuse to release a record whose workers are still attached, and the
caller must keep that job's ID when release is refused. Forgetting the ID
does not free the kernel's slot; repeated failures can fill the job table
even after the commands eventually exit. Retain the ID for a later cleanup
attempt, and remove it only after the owner confirms release or absence.
Test the transition from a failed call with a live job to successful cleanup
after that job finishes.

Process IDs also outlive individual programs. `exec` keeps the ID but replaces
the worker and its memory. Terminal removal can overlap that replacement, so
both paths can hold the same old execution image. Check its exact memory
registration before committing prepared work: a removed or replaced caller
must not commit against the new image. After replacement, use one retirement
ledger for the old image across exec, exit, termination, and destroy. This
prevents two paths from releasing one memory lease and preserves the new
worker when the old path finishes late. Test both orders of that overlap.

A worker registration alone does not prove that an asynchronous syscall is
still waiting. A teardown can wake its channel before removing the worker.
Validate the pending call before its irreversible commit, and release a
cancelled executable target's resources through the normal kernel path.

A busy kernel gate is temporary contention, not a failed file read. A call
that needs an immediate result must either run now or refuse without saving
its work for later. Queueing work and then reporting refusal can make a retry
allocate a second executable token or cancel a token twice. Asynchronous
launch paths retry only this pre-entry refusal on a later worker turn. Once
commit consumes a token, preserve that fact even if later work throws. Do not
put an unconditional `await` between successful commit and replacement start:
it would let another task observe a partly installed process. Test refusal
after the queued work drains, retry before consumption, and no retry after
consumption. A microtask scheduled by commit must run after replacement start.

The same rule applies before the first guest program starts. Successful
memory registration does not reserve the gate for later working-directory
or terminal setup. Each `await` lets another launch queue its own work.
Retry the steps that refuse before entry; keep real failures, such as a
missing directory, visible. Concurrent guest commands should fail because
of their own guest operation, not temporary host scheduling contention.

Visible prompts are readiness signals too. A password prompt must follow
the terminal-mode change that disables echo and flushes earlier input.
Printing first lets a fast response get echoed or discarded. Test immediate
input after the prompt rather than adding a guessed delay to the fixture.

Reactive tools also need evidence from the owner of the data. When Rust owns
files, a JavaScript filesystem subscription cannot observe guest writes.
Queue bounded notifications at native operations, copy them out while the
kernel call is active, then invoke observers after that call ends. Treat
notifications as hints to read current state. On overflow, refresh watched
directories instead of pretending no changes happened. This keeps memory
bounded without leaving tool registration stale.

Full refreshes and individual updates must agree on which definition owns
a tool name. Select the higher-priority file before validating it. If a user
override is malformed, disable that name instead of reviving a different
shipped command during a refresh. Removing the override can restore the
fallback; merely failing to parse it must not change the user's choice.

A notification should not delay a process starting its next program. The
kernel handles one call at a time. Queuing a notification call before the
immediate file read used by exec made that read fail with EIO (an I/O error).
Schedule notifications for the next worker turn, after the current call's
temporary memory handles have expired. Register that scheduling before the
operation so the final process-transition step stays last. Use a fresh,
gated kernel call to copy the hints, then clear the pending flag before
observer callbacks run so their own writes are observed too.

See [WebMCP](webmcp.md) for the implemented tool and notification limits.

## Separate guest permissions from browser origin authority

A guest user ID controls files and processes inside Kandelo. A browser
origin controls access to documents, browser storage and page tools.
Those are different boundaries. A preview that shares the app's origin
can discover and invoke its native WebMCP tools even when registrations
were made only in the parent document. A narrower service-worker path
also does not create a new origin.

Test the actual browser behavior before describing a frame as isolated.
Content annotations help an agent recognize untrusted data; they are not
an access-control boundary. Keep the implemented trust model explicit
until a separate browser origin or equivalent enforced boundary exists.
See [the WebMCP browser contract](webmcp.md#browser-and-invocation).

## End temporary authority explicitly

The host exchanges syscall arguments with Rust through temporary kernel
memory called scratch memory. A lease grants permission to use a particular
range during one synchronous operation. An opaque pointer token identifies
that permission without letting callers manufacture an arbitrary pointer.

Correctness requires that permission to expire when the operation ends.
Memory efficiency also requires removing private registrations that no
longer serve a purpose. A JavaScript weak map permits the garbage collector
to reclaim unreachable entries later. It does not specify when collection
happens, and an expired token that is still reachable can keep its private
lease record reachable through the map. Prompt removal avoids leaving that
cleanup entirely to the collector.

Kandelo therefore deletes pointer-token registrations and the one-shot
callback that ends a lease when that lease retires. It also avoids creating
result wrappers, empty buffers and error messages when an operation does not
need them. Each access still
checks ownership, allocation capacity, the current memory range and lease
validity. Removing temporary bookkeeping must preserve these checks.

For example, a syscall completion with no pending signal needs only a single
numeric result. A completion that delivers a signal still copies its record
while the lease is valid. Data needed after an asynchronous wait is copied into
host-owned storage rather than keeping a borrowed memory view alive.

This lesson applies to any short-lived authority: end its registration at
the same explicit boundary that ends its permission. Measure the resulting
workload; fewer allocations alone do not establish faster execution or
shorter garbage-collection pauses.

## Measure the whole request against the merge target

A file-lock request includes work in the JavaScript host, argument transfer,
Rust dispatch and the lock manager. A change in its measured duration does
not by itself identify which component changed. Even an unchanged lock
algorithm can have different timing when host bookkeeping or collection
changes around it.

The comparison for a merge decision is the finished runtime against the
target branch at a known commit. Comparing two intermediate PR versions
answers a different question. When their application binary interfaces
(ABIs) differ, each side needs programs and images built for its own kernel.
Record the sources and artifact hashes so a stale binary cannot silently
become the baseline.

Timers also constrain what a result can show. If a browser clock advances
in one-millisecond steps, a phase with 256 operations changes by about
3.91 microseconds per operation for each clock tick. An apparent small
phase difference can be one timer step. A separate monotonic-clock
diagnostic can investigate that effect while leaving the original workload
and result intact. Repeating a workload after warm-up answers a different
question from its first run and must be reported separately.

Alternate version order and compare complete requests as well as individual
phases. Identify whether fresh workers share one parent process. Use worker
profiles to investigate a cause, with a shared marker to align clocks. An
allocation sampler that omits collected objects cannot measure all temporary
allocation traffic. Instrumented results explain possibilities; the timing
claim comes from uninstrumented runs and application benchmarks on both
Node and browser. [Profiling](profiling.md) describes the measurement tools.

## Move ownership with its observable contract

Moving a filesystem into Rust changes who implements it. Users still rely
on the same path resolution, permissions, lazy downloads, error behavior
and inspection. Review those behaviors individually rather than assuming
that moving the main read/write path preserves every capability.

| Contract to review | Concrete check |
| --- | --- |
| Path and mount resolution | A symlink into another mount reaches the same object through guest syscalls and host inspection |
| Lazy file identity | An image-relative reference resolves through the package authority and deployment URL without rewriting the image |
| Integrity and retries | Incorrect size or digest fails before file mutation; rejected bytes do not poison a later explicit retry |
| Deferred archives | Inventory each supported format; a working ZIP path does not prove a gzip-compressed TAR path exists |
| Virtual directories | Process, descriptor and terminal entries reflect actual creation, close and reaping |
| Inspection content | Listing a procfs file and reading its generated bytes are tested as separate operations |

The inspector should share the kernel's namespace and directory providers.
For example, `/proc/<pid>/fd` must enumerate that process's live descriptors,
and `/dev/pts` must reflect actual terminal ownership. Building a second
host-side tree would create another source of truth that can drift after
close or process exit.

Directory entries, metadata, symlink targets and file contents remain
distinct capabilities. The inspector can list a generated procfs file
without having a host API to read its contents. Its `/proc/self` is resolved
for the reserved init process, PID 1, not whichever guest happens to have a
terminal open. State the calling identity and any unsupported read behavior
explicitly. [Filesystem inspection](architecture.md#inspection-of-the-live-filesystem)
documents the current limits.

The general rule is to inventory, carry forward and validate the observable
contract alongside its new owner. A real unsupported capability belongs in
the reference documentation and PR limits, not behind synthesized output.

## Make validation observe real completion and policy

An asynchronous operation can take more event-loop turns when the machine
is busy. Waiting a guessed number of turns tests scheduler timing rather
than completion. A spawn fixture should await the actual channel completion
and then assert the publication, error and cleanup behavior. A test timeout
keeps a missing completion observable.

Environment settings are inputs too. A legacy cache policy may expose a
lazy loader that later rejects stale bytes; the source-only policy may omit
the same unowned file before a loader exists. Both can be correct. Each
fixture must select its intended policy and restore the inherited settings,
then pass under the complete suite's normal environment.

Source audits need equally explicit inputs. Generated failure reports and
private worktree copies can repeat text without introducing an authored
production behavior. Exclude those directories while keeping production
source in scope. Keep test inventories exact and distinguish passed checks,
documented expected failures, unsupported cases and authorized deferrals.

These rules make validation evidence for the implemented contract. PR
descriptions can then explain the finished behavior and its limits in plain
language, while the durable lessons and historical evidence live in tracked
documentation rather than a development diary in the review summary.

## An open file can outlive its name

A descriptor identifies an inode, the file object, rather than a directory
entry's current name. An application can keep writing through a descriptor
after renaming its file. Another file can then take the descriptor's old
name. Reporting that stored path as a precise change would tell an observer
to read the wrong file and can leave an image tool's definition stale.

Use native metadata to compare the descriptor's inode with the inode now
at its opening path. When a still-linked file no longer has that name,
bounded directory refresh hints preserve correctness without keeping a
second filesystem or an unbounded alias history in the notification layer.
If the inode has no names left, later writes change no directory entry;
the earlier unlink is sufficient. Avoid that metadata work when nobody
subscribes.

A useful regression test waits until the rename notification has arrived,
then permits the final write through the old descriptor. This prevents an
earlier rename hint from accidentally covering the later write. A sentinel
write can similarly establish that prior hints were delivered before a
test asserts the absence of an unnecessary refresh.

## Test reclamation in the realm that survives the operation

A small view can keep a large shared Wasm reservation alive. A page-wide
AudioContext can similarly keep disconnected processors alive after their
machines exit, and removing a pending-wait map entry does not cancel the
engine waiter. Counting workers or observing low RSS misses those owners.
Correct reclamation requires both an ownership boundary and explicit ends
for processors, waits, ports, and timers.

Keep large guest address spaces inside disposable workers. Persistent
browser/audio realms receive bounded independent device buffers or copied
values. Test the actual messages as well as their declared types, and prove
buffer independence rather than just checking the length of a subarray.
Then repeat full machine switches in one page with real audio activation.
Creating a fresh page or forcing GC after every cycle can make precisely
this class of regression disappear from the test.

The reusable local command and native Safari evidence requirements live in
the [validation contract](agent-guidance/validation.md#browser-memory-regression-gate).

## Schedule observer work from real pending state

A subscription says that someone wants updates. It does not mean that every
operation produced an update. Opening a second kernel entry and temporary
buffer after each unrelated operation adds work even when the queue is empty.
Use an authoritative, non-consuming readiness read to decide whether to
schedule delivery. Read it after the operation, so a final write is delivered
when the caller becomes idle. Keep copying and callbacks outside the original
entry's authority, and preserve lifecycle transaction ordering. A filesystem
watch must still see rename, unlink, overflow refreshes, and writes made by an
observer callback. Measure active subscriptions as well as the default path;
a benchmark with no subscribers cannot reveal their scheduling cost.

Creating permission to enter the kernel and using that permission are
separate responsibilities. Put the readiness read in a helper that takes
the live entry as an explicit argument. Keep entry construction free of
kernel export calls, so the source audit can trace every use back to the
operation that borrowed the entry. If a gateway forwards an operation,
verify its original argument and the gate's exact scope and effect
registrar; accepting arbitrary stored callbacks would weaken that trace.

Keep notification callbacks and their captured scheduling state inside
the active-watch path. This makes the default path's work visible in the
code and avoids adding notification state when nobody requests updates.
Measure both paths before claiming a performance improvement.


## Give bitmap interfaces one display grid

A bitmap client lays out text, theme art, hit rectangles, and mouse state
in one pixel grid. Enlarging fonts independently can create a sequence of
widget patches without repairing the original mismatch. Let the platform
advertise a readable virtual monitor and scale the complete output once.
Keep native device pixels available for compositors that own their output
scale. The presentation policy belongs in image metadata, not an
application-name check in the host.

Cursor shape and position belong to the display contract. Implement a
missing cursor plane and let clients use their toolkit's cursor API;
painting a cursor must not require the application to redraw its scene.
Check the raw device coordinates separately from a toolkit's hotspot
conversion, because two incorrect offsets can cancel in an application
screenshot. Keep genuine upstream input defects at their owning layer:
changing a platform API's documented queue semantics to suit one client
would make the next client wrong. See [Freeciv](freeciv.md) for this split.

## Keep source audits effective when compiler tooling changes

A compiler executable and a compiler's JavaScript API serve different users.
Kandelo's build can pass while its audits lose the API they need to inspect
source code. TypeScript 7 currently supplies the executable without that API.
Its [official compatibility package](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)
keeps the TypeScript 6 API available to audits, declaration generation and
documentation tools while `tsc` selects the native compiler.

Parser options also define which source a build can see. Enabling JSX for
all files made Babel 8 treat an ordinary `.ts` generic function as JSX.
Select language options by filename and keep parse failures visible. Exercise
both plain TypeScript and JSX files before trusting an upgraded source audit.

Test discovery is part of the evidence too. Vitest 5's default static listing
omitted Ruby cases whose titles use imported constants. Its runtime collector
still found and ran them. Exact case inventories must use runtime collection;
a short list is not proof that the omitted tests do not exist. Keep the
one-to-one case comparison rather than weakening it to accept an empty list.
