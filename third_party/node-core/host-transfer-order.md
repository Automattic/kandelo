# Registered host transfer: receiver and sender ownership

The receiver prerequisite and sender follow-up provide a consumed normal
registered-JavaScript transfer path in source. Whole-list admission, nested
registry expansion, graph identities, ArrayBuffer-first detachment, combined
JS/native endpoint commit and receiver order/finalization use actual owners.
Production JSAPI is uncompiled/unrun and this is not complete stream/messaging
compatibility. Incomplete native host types (notably FileHandle), full Worker
startup/termination ordering and all identified runtime failures remain open.
The source outcome transaction below is a candidate implementation, not passing
conformance evidence or an accepted exclusion of valid public cases.

Pinned Node26.13.0 `src/node_messaging.cc` validates explicit entries, expands
NestedTransferables/kTransferList, serializes the main graph, detaches all listed
ArrayBuffers and then finalizes native/JS hosts in combined order. JS payloads
share graph identities. During read it creates each native/JS receiving host in
that same order before main graph/payload decoding. The original engine envelope
readTransferMap created all native wrappers before it inspected the JS
constructor table. Removing the registered-host rejection alone would expose
wrong native init/receiver ordering; nested stream transfers require that owning
phase dependency as well as sender work.

Current write consumes a version2 envelope. Its native transfer-map indices and
JS constructor indices are separate IDs, encoded as bounded kind/index pairs
following the existing pure string descriptor table. The sender records the actual combined explicit/nested host order. Registered
JS receivers are preassigned descriptor identities, including unreachable
transfers, while native map IDs remain independent. Every declared ArrayBuffer
is detached after main traversal and before any host commit. JS kTransfer and
actual native endpoint moves then follow that frozen host order; clone-only
hosts discovered by main/payload traversal follow the transfer prefix. No JS pointer/root or
script-visible global token crosses a packet. The existing native endpoint
sidecars and collector still own actual endpoints/clone data.

Before running a protocol constructor or native transfer-read callback, the
reader preflights all descriptor strings and the order schema, validates unique
JS coverage and ordered native indices against the actual custom transfer-map
slots, and prepares placeholders in its context-local rooted vectors. It then
creates any preceding JS hosts immediately before each real native custom read,
commits that native step only after success and constructs trailing JS hosts
before graph decoding. JS payload reads/finalization then follow that same
frozen schedule rather than incidental descriptor index order. Callback failure poisons the local phase owner; no later
constructor may run. Native byte/pointer validation and actual adoption still
belong to readTransferMap/native callbacks. Normal engine GC/OOM safepoints remain;
preflight itself invokes no protocol/constructor hook. The established native
packet/read transaction retains rollback ownership on every early failure.

Version1 clone-only envelopes retain their old native-then-JS constructor order.
Version2 writers/readers must be compiled/deployed coherently through the normal
recipe; the old engine rejects version2. This private SameProcess format is not
a persistent SpiderMonkey/V8 wire format and no kernel ABI/target pin changes.
Raw SpiderMonkey graphs do not allocate this embedding's order metadata. Ordinary
transfer-free broadcast creates independent per-reader metadata/root vectors;
no JS context pointer is installed in shared immutable clone data.

The receiver prerequisite's historical focused evidence exercises the actual portable HostOrder header: current native/
clone order, interleaved descriptor scheduling, invalid kinds/bounds/duplicates/
missing coverage, actual native slot mismatch, constructor failure, uncommitted
native failure, late mutation, empty order and allocation-denied phase delivery.
Deliberate metadata validation/constructor omissions fail the same assertions.
This does not compile or execute the production JSAPI parser/decoder. Exact
pinned native Node controls independently establish two valid public mixed/nested
stream and aborted-signal/ArrayBuffer cases source-rejected at that historical
receiver-only revision. Later sender/outcome source removes that rejection but
has no compiled guest evidence. No original finding or runtime conformance is
closed by these portable/reference controls.

## Sender and native identity ownership

The whole explicit list validates before nested hooks, graph getters or source
detachment. Registered hosts retain the engine's hidden PrivateName brand;
configuration rejects an ordinary Symbol. Native nested discovery uses a separate
context-local C++ JSClass/checked-unwrap probe, not public tokens or a second
canTransfer admission (which would mutate the explicit duplicate ledger).
Only real existing MessagePort native identity currently supplies that probe.
Nested arrays are traversed with the pinned filtering/duplicate/length behavior;
no type-name or AbortSignal-only allowance exists. Writer roots are local and
synchronous. No JS object/root/exception pointer is added to packet bytes or
native transit sidecars.

Admitted registered-JS transfers also record their actual count in the native
packet sidecar through a context-local, callback-identity-checked observer. This
scalar contains no JS root or pointer. It forbids repeated Broadcast reads even
when a logical JS move produces no native transfer-map entry; the engine
`JS_StructuredCloneHasTransferables` native-map query alone cannot establish
repeatability. Ordinary delivery retains the existing consume-once packet owner.
A different/raw clone callback pair cannot silently publish registered moves
without this owned sidecar. No new public callback ABI or token is introduced.

Main graph and deferred data use the same serializer memory map. Native transfer
map slots are filled by indexed actual owner moves, preserving ABI/backreference
positions while interleaving JS hooks. Failed graph/hook/move aborts the real
native serialization buffer/sidecars and receiver transaction. Already-detached
buffers and executed JS hook side effects are not falsely rolled back. Native
FileHandle movement is still absent and its upstream registration remains
separately disabled. Histogram/native clone creation order also remains its
existing distinct callback owner, not newly covered by this transfer schedule.

## Sender outcome and caller ownership

Pinned native controls establish distinct outcomes, not a universal throw.
Missing/nonobject private transfer results detach buffers but structuredClone
returns undefined and MessagePort drops the packet (an actual FIFO sentinel
arrives alone). Throwing deserializeInfo conversion detaches buffers and later
transfer hooks still execute. StructuredClone reports the receiver's empty-info
module error; postMessage rethrows the sender error and delivers malformed data,
causing receiver messageerror before its FIFO sentinel. Later ordinary throws
supersede earlier conversion errors; later conversion throws replace the deferred
sender error; a later no-result makes structuredClone return undefined while
postMessage still throws its last deferred sender error and drops the packet.

The source now implements a real local write transaction for these outcomes.
The JS extraction callback reads data then raw info without coercing; missing or
nonobject results return no-result to its C++ owner. C++ performs actual ToString
and UTF-8 normalization, preserving embedded NULs/replacing lone surrogates like
pinned Utf8Value. A normal pending conversion exception is stolen into a rooted
sender-local ExceptionStack and the empty descriptor is retained; subsequent
hooks/payloads continue normally. OOM/uncatchable paths still abort. Later errors
have their actual owners, not a JS special-case catch or fabricated successful
undefined message.

A failed no-result write retires partial clone/transfer material but retains an
opaque consume-once caller transaction. A prepared write retains its real packet.
The opaque box's reserved JS slots hold any sender exception/stack in that same
context; native packets/queues/worker graphs never contain JS roots or exception
pointers. Actual post publishes then restores its deferred exception; a no-result
post dispatches nothing. Actual deserialize owns receiver-error precedence and
discards deferred state on no-result. Every direct packet writer, including the
existing worker-error fallback, uses the shared write scope so no borrowed outcome
pointer survives publication or context teardown. Worker-error serialization
fallback parity remains a separate gap, not a conformance claim.

## Worker LOAD publication gate

Pinned internal/worker.js posts LOAD_SCRIPT with private/public ports and data
before startThread. A no-result can retire transferred public peers yet start a
thread without a load message. Bounded native observation saw no online/message/
error for two seconds before explicit termination returned1. Another actual
peer-close control terminated earlier and returned0. Neither deadline nor absence
of an event is counted passing compatibility or proof of never running.

The source create owner consumes a deferred constructor throw before launching a
child, retiring all prepared material through existing owners. No-result leaves
its input unpublished and retires the startup public child peer. The actual
WorkerControl now owns an interruptible condition-variable LOAD gate: child
bootstrap initializes genuine builtins, then waits for input or Stop before any
user source/online event. This is not workerData=undefined. Stop notifies the gate;
periodic waits are interrupt checkpoints only, never success/timeouts; JS/engine
interrupt checks run outside the mutex. Ordinary context/port teardown and join
remain the retirement owners. No JS callback runs under this gate's lock.

Full startup parity is still incomplete: the current bridge creates its public
pair after user serialization rather than transferring pinned internal/public
pairs in their exact original order; exact termination races/status, option/
resource/stdio/profiling semantics and worker error transport remain unresolved.
The new gate/transaction is uncompiled/unrun and does not close those gaps.

Remaining validation: actual C++ ABI/API/GC/realm/OOM/reentry/abort/fatal paths,
full malformed results/descriptor UTF-8 and error diagnostics, unchanged upstream
and native public stream/AbortSignal/backpressure/cancel/abort/close/messageerror/
Worker controls, native hosts beyond endpoints and identified artifacts on all
four hosts. Previous immutable nonpasses remain preserved, not relabeled as
passing or accepted boundaries. No original STR-003/STR-004 finding is closed.
