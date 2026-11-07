# Registered host transfer: receiver-order prerequisite

This source supplies an actual versioned SameProcess order-table and receiver
preflight/phase owner. It does not enable registered-JavaScript transfer admission.
The unchanged sender still rejects ReadableStream/WritableStream/TransformStream,
transferable AbortSignal and other registered transfer modes. These are valid
public implementation failures, not accepted engine/platform boundaries or
passing unsupported coverage. Public FileHandle transfer is separately disabled
until an actual transferable native fd owner exists.

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
following the existing pure string descriptor table. The current sender's actual
order remains native transfer entries followed by clone-only JS hosts. Future
sender admission can emit interleaved entries through the same schema/owner;
this source does not claim that future writer exists. No JS pointer/root or
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

## Next owning implementation dependencies

1. Real explicit registered-JS admission and complete nested host registry with
   checked private identity/duplicate/source-port/mark/error order. Do not add
   type-name or AbortSignal-specific allowances.
2. Main-graph identity/backreference registration for all transferred JS hosts,
   including unreachable entries, without putting JS roots in packet sidecars.
3. ArrayBuffer detachment followed by actual JS kTransfer/native endpoint moves
   in combined host order; kClone hosts discovered from payloads follow that
   prefix. Preserve partial detach/failure/abort behavior and unchanged hooks.
4. Emit that real combined order into version2. Consume real serialized info/data
   in current per-context deserializer factory, then finalize exactly once after
   graph allocation, preserving native receiver abort/close ownership.
5. Source-check and compile actual engine glue, then unchanged public stream/
   signal/upstream and native differential cases on identified artifacts across
   all four hosts. Skips/unsupported/timeouts/harness errors remain nonpasses.

Native FileHandle ownership, generic context policy, full stream cancellation/
backpressure/messageerror/close/GC/OOM/fatal/realm cases and other host resources
remain separate implementation/conformance gaps. No runtime workaround or
external runtime defect is claimed by this prerequisite.
