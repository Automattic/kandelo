# Actual Worker bootstrap, transport and independent retirement

This is partial R-003/004/005/008/009/012/016 implementation, following actual
owned engine message packets. The immutable Node26 source/native pins and
frozen audit remain intact; no family/API finding closes.

The old adapter minimal-prelude/JSON/shared-mailbox/synthetic-online path is
removed from the public Worker route. Actual per-worker native controls own a
JS thread, context, unique ID, startup and exception clone packets and an
entangled parent/child endpoint pair. Child realms run the same full normal
Node bootstrap and per-context module loader. Worker data/environment data
travel as actual engine clone packets, preserving graph/Map/BigInt/shared-store
identity and byte transfer through the existing serializer. Public native port
adoption supplies the parentPort and Worker.postMessage route; endpoint and
host-object transfer remain separate missing work.

Ready follows normal bootstrap/global/module initialization, before user entry.
Normal file execution uses the actual CJS/ESM main loader; eval uses the existing
engine evaluator with require/process/Buffer/core modules initialized. Each
child has its own environment namespace snapshot and environment-data Map;
worker process.chdir and writable umask reject through actual target error
owners, and cwd reads the actual shared process cwd. Complete environment
exotic/TZ/native consumers and inherited CLI/options need further reconciliation.

The native owner serializes uncaught child exceptions to its parent rather than
printing them as an unrelated shell failure. Its exact context pointer is
protected while requesting a real engine interrupt. Completion is published
only after child context roots and tracked native jobs retire; the parent joins that
specific thread before exit status. Terminate, repeated termination and ref/
unref use actual per-owner state; public completion does not join unrelated
workers. Queued child messages drain before exit, and retired owners are
released. Constructor adoption failure marks an interrupted orphan unreferenced
and retires it after completion or parent shutdown. Shutdown stops/joins all
owned descendants before their parent runtime is destroyed.

Worker loops now own real reference state and a dispatch phase; no timer keeper
is added. Existing cooperative idle-poll/wakeup limitations remain open. Child
GC soft budget is inherited from its actual parent engine configuration instead
of the raw shell minimal-eval worker's fixed 8MiB value. This changes the child's
nominal GC policy, not the process Wasm address-space/SAB maximum or host memory
reservation. Existing stack policy is retained. Memory consumption, failure
pressure and four-host resource reclamation remain unvalidated; no V8 resource
limit equivalence or performance claim is made.

Patch86/recipe79 stage this owning engine/JS path. No new syscall, host import,
wire ABI, host memory ceiling, full product rebuild or overall suite is added.
The initial four public case sources were shared unchanged between native and guest modes:
full bootstrap/data graph/transfer/SAB/core/VM; message/online/exit/env ordering;
independent concurrent-worker termination; and uncaught exception delivery.
Native26 controls passed all four at that checkpoint. The first wrapper-generation attempt created
invalid method-expression scripts: all four startup parse nonpasses and exact
scripts/logs remain in native-r1. The corrected function wrapper leaves the
assertions unchanged; native-r2 is a distinct identified run. Guest compilation/
execution is separately recorded when terminal, not inferred from these controls.

Remaining work includes full pinned Worker constructor/options/descriptors/
namespace/async-provider fidelity; stdio/backpressure; resource limits and
measurements/profiling/locks; shared environments, CLI/preloads/name handling;
trackUnmanagedFds and descriptor retirement; endpoint/stream/native-handle/host
object transfer; import/error/exit/cancellation and arbitrary-thread messaging;
exact phase/fairness/wakeup/ref/GC/OOM/realm and callback-failure semantics;
parent/descendant death and blocking-native-call interruption; and complete
identified ordinary stamped artifacts and unchanged upstream coverage across
Node/Chromium/Firefox/WebKit. Explicit unsupported options remain gaps, not
passing feature tests. Default build-deps artifact stamps remain a separate
ordinary SourceOnly-consumer validation requirement; do not retag bytes.

Continue independent testing/native-integration owners after this coherent
worker foundation. No complete worker/core compatibility claim is established.


## Accepted engine83 and actual Node-host guest evidence

The first engine79 build failed at an accidental legacy raw-shell WorkerInput
field access; recipe80 restored the original raw-shell path. Its first four
guest cases failed before user code, and engine81 preserved the primary error
rather than masking it with a missing finalizer. Actual custom clone-envelope
reading then failed before child deserializer initialization. Patch87/engine82
uses the actual wire header and separates plain bootstrap metadata from user/
environment data decoded after host constructor initialization. Its six guest
cases still failed at missing environment safeget. All failed build and guest
reports/source preimages remain separately retained.

Engine83/patch88 adds the actual privileged-environment read-admission operation
(uid/gid and musl AT_SECURE), so copied worker environment values use the same
security policy as the main native owner. It also defers the pinned worker
umask wrapper until the actual error/value classes exist. This is a private
paired engine/bootstrap operation, not a new kernel/host import or wire ABI.
The native POSIX process-state helper passes independently; it is not guest
privileged-execution conformance.

The normal targeted wasm32 engine83 build succeeded in 200.1 seconds.
All 641 selected frozen input identities matched; unchanged upstream style/
macroassembler/opcode checks, optimization and fork instrumentation passed.
Exact executable/log/dependency identities and source copies are retained in
.context/node26-engine-r83-accepted. Both executable copies have
48,507,564 bytes, SHA-256
`a3679d830e4784e2af934c04c25c68a508ce5931ff321eb98b00b9c2dd1e52e7`.

Six identical native/actual Node-host guest sources pass: bootstrap graph/
transfer/SAB/core/VM; message/online/exit/environment ordering; independent
concurrent-worker termination; uncaught exceptions; Blob data decoded after
host bootstrap and inherited execArgv; and real file worker/local dependency
loading. Guest-r4 counts are {'pass': 6, 'fail': 0, 'timeout': 0, 'harness-error': 0}. Exact native26 source hashes,
engine/kernel/image IDs and bounded observed teardown are in
.context/node26-worker-owner-guest-r4/report.json. The original four assertion
sources were not weakened or replaced. Node native-r3 independently passes
all six. Default-artifact ABI-contract stamp warnings remain in raw logs;
no bytes were retagged and ordinary stamped-consumer validation stays open.

The following testing recipe84 source is newer than this accepted artifact.
No overall suite/full product rebuild/browser control ran for this slice;
remaining Worker APIs/options/resource/lifecycle and four-host obligations
above remain implementation or validation gaps, not accepted exclusions.
