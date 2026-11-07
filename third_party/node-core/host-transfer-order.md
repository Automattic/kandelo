# Registered host transfer: receiver and sender ownership

The receiver prerequisite and sender follow-up provide a consumed normal
registered-JavaScript transfer path in source. Whole-list admission, nested
registry expansion, graph identities, ArrayBuffer-first detachment, combined
JS/native endpoint commit and receiver order/finalization use actual owners.
Production JSAPI is uncompiled/unrun and this is not complete stream/messaging
compatibility. Incomplete native host types (notably FileHandle) and the exact
malformed/no-result/deferred-exception outcomes below remain valid failing public
cases, not accepted boundaries or green unsupported results.

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

Focused evidence exercises the actual portable HostOrder header: current native/
clone order, interleaved descriptor scheduling, invalid kinds/bounds/duplicates/
missing coverage, actual native slot mismatch, constructor failure, uncommitted
native failure, late mutation, empty order and allocation-denied phase delivery.
Deliberate metadata validation/constructor omissions fail the same assertions.
This does not compile or execute the production JSAPI parser/decoder. Exact
pinned native Node controls independently establish two valid public mixed/nested
stream and aborted-signal/ArrayBuffer cases still source-rejected by Kandelo.
No original public finding is closed or runtime conformance claimed.

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

## Remaining concrete outcome owner

Pinned native controls establish distinct outcomes, not a universal throw:
missing/nonobject private transfer results detach buffers but structuredClone
returns undefined and MessagePort drops the packet (a following actual FIFO
sentinel arrives alone). A throwing deserializeInfo string conversion detaches
buffers; structuredClone reports the receiver's empty-info module error, while
postMessage rethrows the original sender error **and** delivers a malformed
packet that produces receiver messageerror before the FIFO sentinel. The
candidate hook currently throws/preserves its original exception; these are
explicit nonpasses, not preferred policy or a justified exclusion.

The required next owner must distinguish successful packet, no-result/drop and
prepared-packet/deferred-sender-exception states. It must own string conversion,
original exception stack, publication and caller outcomes; no special-case JS
catch or fabricated successful value suffices. Sender exception roots must stay
in the sender context/transaction or opaque local wrapper, never the native
cross-thread packet. Worker startup requires its actual LOAD_SCRIPT transaction:
pinned internal/worker.js posts its private/public ports plus data before
startThread, so no-result can consume/close transferred peers yet still start a
thread without a load message. Candidate bootstrap/input splitting needs a real
waiting-for-load/termination owner, not fake undefined workerData. Native immediate
termination evidence proves only constructor/thread retirement, not absence of
user startup.

Other remaining work: exact JS-host duplicate constructor-name diagnostics;
full private-hook malformed/result/UTF8/exception policy; native host classes
beyond endpoints; compile actual C++ glue; unchanged upstream/native controls
for streams/AbortSignal/backpressure/cancel/abort/close/messageerror, graph
getters/reentry/GC/OOM/fatal/foreign realms/Worker and every identified artifact
on all four hosts. No original STR-003/STR-004 finding is closed.
