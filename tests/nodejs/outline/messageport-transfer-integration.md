# MessagePort endpoint transfer foundation

Source194 integrates the immutable transfer foundation over current193, preserving
TTY/spawn/FFI/sys/constants/signature ownership. Audited target/source/reference
pins and ABI55 remain unchanged. This is a partial source contribution.

## Real owning behavior

A genuine native public MessagePort class retains its opaque endpoint owner in
a reserved slot and shares the existing public prototype. Clone admission checks
native class/slots and access, not script properties. Consume-once native transfer
sidecars retain moved endpoint authority; no JS roots or raw pointer tokens cross
threads. Source close/destroy notification has its own local root after the
endpoint moves. Receiver initialization starts unentangled and commits the actual
incoming queue only after the private public-wrapper initializer succeeds.
Failures abandon actual adopted owners, preserving exposed close notifications.

ArrayBuffers detach before native host transfer, while caller transfer-table and
graph indices remain unchanged. Shell ordering stays unchanged when Node clone
ownership is absent. MessageEvent.ports includes actual adopted ports even when
unreachable from the payload; Worker startup consumes the same read transaction.
Direct destination-self posting discards through actual ownership. Queue payloads
retire outside channel locks, with allocation-free list retirement.

## Focused evidence and limitations

The final portable owner passes8groups and the unchanged queue control passes;
both retain1000ordered cross-thread packets. Four previously successful tiny
compiles are integrated, not rerun or counted again as new compiles. Exact sealed
source/header and artifact identities are verified; this is not a claim that all
historic compiler-system inputs were recorded.

Current candidate JS passes13bounded processes:11existing fixture groups, one
three-group transfer frontend and one complete unchanged upstream-file component.
The unchanged test-worker-message-port-message-port-transferring.js also exits0
under the exact pinned native binary. All assertions remain unchanged. Controls
use genuine native Node clone/queues/ref/close but explicit manual dispatch and
additional envelope clones. They do not execute production SpiderMonkey sidecars,
receiver admission, GC, realm, async resource or guest-loop ownership.

Normal860-input closure, complete generated bootstrap syntax, exact engine patch
forward/reverse replay and unchanged Mozilla checks pass. Fourteen package checks
and11port fixture wrappers pass (25total). Root first selected a nonexistent port
spec filename and collected only14package checks; that raw report remains separate.
The corrected selection collects both actual files. No missing selection counts
as port validation. Normal collection/assertions are unchanged.

## Preserved nonpasses and remaining implementation

Original private missing Buffer/peer framing setup failures, double dispatch,
three helper-selection harness errors and metadata IndentationError remain.
The native-only graph getter re-transfer observation aborted134; no external
runtime fault, workaround or exclusion follows from it. Original results and
subsequent scoped outcomes remain distinct in the immutable capsule.

Automatic collection of unreachable transitive endpoint/packet ownership cycles
is still missing in this slice. Explicit recursive retirement is not automatic
collection; parallel collector implementation is a separate unintegrated owner.
Generic registered-JS/WebStream/AbortSignal transfer, moveMessagePortToContext,
Worker stdio/options/termination and full provider/lifetime/accounting remain.
Actual JSAPI/CCW/access denial/GC/realm/OOM/fatal/abort/close/teardown/ref behavior
requires compilation and identified-artifact evidence on all four hosts. No
finding/family closes; accepted173is stale. Overall suites and full product
rebuild remain deferred. Nested guest Wasm backend stays in scope, scheduled last.
