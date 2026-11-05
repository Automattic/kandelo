# Classic, promise, consumer and iterable stream contracts

State: **source review complete with implementation gaps** for `node:stream`,
`node:stream/promises`, `node:stream/consumers` and flag-enabled
`node:stream/iter`. The [earlier stream trace](streams.md) remains part of
this review. No runtime test, probe, compilation or build ran.

The requirements artifact retains all **430** original stream obligations:
243 documentation sections and 187 descriptor observations, plus seven
scoped consumer sections from webstreams.md, inherited methods, returned
writers/channels and flag-enabled APIs missed by the default capture.
These are not unique APIs or passing compatibility.

Full `node:stream/web` class coverage belongs to the separate **web family**,
where its 158 captures/109 documentation sections were originally inventoried.
Eight early summary observations had been mislabeled streams; their IDs
are preserved and moved to web with their full source review still pending.
The move, reason and pending status are recorded in the requirements
artifact. This review covers their Node/Web adapter and shared dependency
contracts; it does not use that to claim all Web reader/controller/BYOB APIs
audited. Compression and Event/Abort scoped reviews remain separate evidence.

## Exact source, factories and dependencies

The target remains Node 26.13.0, source commit
`18b32a3b1552e199a01f1a8d9fd64aa756d3b75b`; official pin verification is
unchanged. `streams-source-correspondence.json` checks the complete
streamPlatform manifest: **61 full files exactly match the pinned source**,
and the public Web adapter excerpt is one unchanged contiguous source
range with the full upstream file hash retained. All **62** corresponding
factories occur exactly once with the expected source in the existing
generated `third_party/node-core/node-core.js`. This check read source
only; it did not run build.py, regenerate runtime code or validate a binary.

`stream-platform-adapter.js:3–110`, build.py:303–320 and
bootstrap.js:3264–3283 own injection/loading. The factory cache is real,
supports loading cycles, removes failed factories, and returns the same
module/constructor identities. Classic state machines, promises, iterable
streams, Web Streams, fs streams, compression and ZIP share that registry.
The public Web adapters add an explicit dependency prelude and exports;
the excluded native StreamBase adapters are not supplied by that excerpt.
Their absence alone is not a missing public classic-stream method.

The correspondence artifact also records literal-require dependencies and
their provided adapter IDs. That is a static selection aid, not full
control-flow/activation coverage or evidence that the dependencies behave
correctly. The inspected dependencies include actual process/nextTick,
events/async frames, errors/validators, Buffer/StringDecoder, native Promise
metadata, AbortSignal/EventTarget, Blob/encoding, WebIDL, clone protocols,
file handles/fd jobs and native codec bindings. Every public consumer must
reach these owners with correct state, not just find an export.

## Classic stream owners and lifecycle

The exported stream object is the **Stream constructor**, and Stream.Stream
is the identical function. Its instance prototype inherits actual
EventEmitter. Readable and Writable inherit Stream; Duplex inherits
Readable and deliberately installs Writable methods/getters, with Writable's
destroy implementation. Transform inherits Duplex, and PassThrough inherits
Transform. Constructors/statics/prototypes, Writable Symbol.hasInstance,
Readable/Writable state objects and source-exposed helpers have distinct
descriptor/alias contracts. Inherited EventEmitter APIs and symbols remain
in scope, with the completed async family findings as prerequisites.

The pinned Readable implementation owns actual buffered bytes/objects,
HWM/encoding state, push/unshift/read, paused/flowing/readable/data modes,
pipe/unpipe/backpressure, EOF/error/close, async iteration and early return.
It handles strings/Buffer specially in from rather than iterating their
individual elements. Writable owns actual pending writes/writev, serialized
callbacks, cork/uncork, HWM/drain, default encodings, end/final/prefinish/
finish and destruction. Duplex has two actual states and half-open policy;
Transform couples readable demand to write callbacks and flush/final, while
PassThrough passes actual chunks. duplexPair creates two real Duplex
owners, with read demand releasing peer write callbacks and peer end/close
coordination (`internal/streams/duplexpair.js:14–85`). These are positive
source paths, not stubbed methods or runtime signoff.

Public implementation hooks `_construct`, `_read`, `_write`, `_writev`,
`_final`, `_flush` and `_destroy` must obey callback/exception and ownership
contracts. destroy.js:53–155 marks destruction before reentrancy, waits for
construction, latches error/state and schedules error/close through
nextTick. destroy does not mean the external fd or native owner has already
been released; that depends on the subclass callback. _undestroy resetting
JS bits does not restore a socket's native generation or fd ownership.
Readable/Writable asyncDispose use actual destroy/eos completion and must
settle the correct error/AbortError and terminal state.

`finished`/eos and pipeline have callback, Promise, Web/Node/iterable,
abort/cleanup/error/late-terminal and async-scope paths. Promise helpers
are the actual shared promises object; custom promisify getters on
pipeline/finished must return those exact functions. pipeline has real
cleanup/destruction and waits for actual stream terminal events; it is not
equivalent to chaining pipe calls or returning when the last write starts.
compose returns the correct Duplex owner and wires both sides. Operators
map/filter/flatMap/drop/take/every/some/find/reduce/forEach/toArray have real
iterator consumption, concurrency/HWM and cancellation/cleanup policies,
with exact callable names/lengths/nonconstructibility and descriptors
(`stream.js:67–106`, operators.js). Getter coercion/range/error behavior
must follow the exact source; do not add stricter validation merely from
the prose parameter type.

## Concrete dependencies and deviations

STR-001–STR-006 in the earlier report remain in scope. Additional findings
and source clarifications are:

| ID | Source finding, owning layer and limitation |
|---|---|
| STR-007 | Classic Readable/Writable call Buffer.from(chunk, encoding) (`readable.js:459–466,515–518`; writable.js:465–476). Candidate bootstrap:1178–1209 uses TextEncoder for non-hex/base64 strings, so latin1/UTF-16/etc do not supply their required bytes. This is existing V-014 propagated into actual stream I/O, lengths/HWM and decoding. Buffer.concat/copy/bounds and StringDecoder V-013–V-017 prerequisites also remain; correctly copied stream code cannot fix them. Native FastBuffer view construction is not itself a copy bug: target typed-view stream conversion intentionally aliases actual byte spans. |
| STR-008 | Consumers and TextDecoderStream/iterable text use supplied Blob/TextDecoder/TextEncoder. The bootstrap fallback TextDecoder (`125–289`) supports only UTF-8/UTF-16LE/BE/windows-1252 label families, rather than all applicable Node/ICU encodings. It has real split-byte/BOM/fatal state, but that is not a full encoding implementation. Scope the limitation to the selected fallback and native ICU capability; do not blame the embedding browser or assume every target build has the same ICU set. |
| STR-003/STR-004 | Web transfer requires real MessageChannel/MessagePort and host-object transfer/clone ownership. Adapter internal/worker/io MessageChannel constructor always throws ERR_NOT_IMPLEMENTED (`34–36`), while the native host-object movement route remains missing in the worker/clone review. The target hooks at readablestream.js:550 and writablestream.js:332 cannot create working cross-realm transport. Exact first failure/activation still needs controls; ArrayBuffer byte transfer/detachment is a separate real engine operation, not permission to copy/claim a transferred stream. |
| STR-002/STR-006 | nextTick/fatal callback/async provider/error/ref/clock behavior is injected, with A/R/N/S/FS owning gaps retained. Socket/TLS or child streams must supply actual callbacks and native terminal state before pipeline/finished can prove release. Native getPromiseDetails/markPromiseAsHandled (`js.cpp:3182–3206,3466–3484`) use actual engine Promise state/handled metadata, a positive path, but do not prove optimized await/context/worker lineage or I/O providers correct. |
| STR-010 | Classic/Web adapters and iterable byte paths depend on original ArrayBuffer/view getters, real detached/resizable/shared backing state, byte budgets and native clone operations. The adapter copyArrayBuffer uses intrinsic typed-array copies only after the pinned bounds checks; a JS allocation is not automatically wrong. Required transfer/resize/reentrant mutation/error/zero-copy lifetimes remain unvalidated. Missing MessagePorts is an implementation gap, not an engine-wide prohibition on byte streams. |
| STR-011 | process stdio is still a custom object/Map facade (`bootstrap:1695–1808,1809–2005`), not the proper Writable/Readable/TTY/socket/file owner. Output write always returns true, calls its callback immediately and ignores native write count/errors for typed data; non-Uint8Array views fall through without writing. Listener exceptions are converted to rejected Promises. Input has genuine cancellable native reads but its read() returns null and it lacks the full classic buffered/iterator/stream metadata owner. These are process/TTY/native integration gaps; no pipeline hang or successful cleanup is newly observed. |
| STR-009 | Target applicability/metadata questions are explicit: Share/SyncShare/Broadcast factory namespaces versus actual returned implementation objects; disposal "alias" wording versus forwarding methods; tap ignoring return values versus its awaited callback source; sync/async reason/cleanup precedence and duck-typed legacy callbacks. Do not invent class constructors, method identity, globally fatal cleanup errors or a strict-new rejection that the exact target does not require. |

Stream/consumers actually iterates the source and creates a Blob, then
arrayBuffer/Buffer/Uint8Array results, or uses a streaming TextDecoder and
JSON.parse (`stream/consumers.js`). Actual copying/identity, malformed bytes,
mixed strings/chunks, iteration failure/early close, memory limits and
decoding errors depend on those real owners. The six consumer docs and
their parent section are reconciled here, without signing off unrelated
web-family APIs.

## Iterable streams beyond the default capture

`--experimental-stream-iter` is a genuine native Boolean/adapter policy
input. Both stream/iter and node:stream/iter are available when enabled
(realm.js:195–225). Their normal unflagged absence is not a missing API.
Readable's Symbol.for('Stream.toAsyncStreamable') is always defined but
checks the flag lazily on first invocation (`readable.js:2213–2250`).
The namespace emits its warning only on actual evaluation; metadata queries
and lazy getters must not evaluate it just to list support.

Public functions cover from/fromSync, pull/pullSync, pipeTo/pipeToSync,
push/duplex, array/bytes/arrayBuffer/text/dump and sync variants, tap/tapSync,
merge/ondrain, broadcast/share/shareSync, classic adapters and the six
Symbol.for protocol identities. Stream is a frozen unified namespace with
the **specific** subset listed in stream/iter.js, not every root export.
Broadcast, Share and SyncShare are null-prototype factory namespaces in
the exact source; their returned BroadcastImpl/ShareImpl/SyncShareImpl
objects own consumerCount/cancel/push/pull/disposal state. The inventory
artifact records those scopes and source-exposed symbols instead of
demanding nonexistent namespace prototype methods.

Each iteration yields Uint8Array[] batches, with strings UTF-8 encoded;
this is not ordinary classic object mode. The source implements actual
recursive sync/async normalization and user protocol calls, byte-view
validation/recording, transforms and terminal flush, source return/throw,
pending operations and cancellation reasons. pull/pipeTo own preventClose/
preventFail/signal and optional sync fast paths with post-call byte-view
validation. Sync and async contracts, incomplete close and failure
precedence must stay distinct.

PushQueue/PushWriter have real byte-budgeted slots, pending reads/writes,
end sentinels, drain waiters and state (`iter/push.js`). Strict/unbounded/
drop-oldest/drop-newest policy is not merely an option string; it controls
actual queue admission and producer completion. Writers own canWrite,
write/writev/sync forms, end/endSync total bytes, fail, disposal and drain
protocol. Async disposal during closing waits for the actual end; failing
an open writer is different from clean end. `duplex` returns null-prototype
channel objects holding two cross-connected owners and an idempotent close
Promise, disposing the peer-readable direction and writer and cleaning
signal listeners (`iter/duplex.js:28–115`).

Broadcast keeps per-consumer cursors and real pending writes/drain state;
share pulls a single source and retains data until consumers advance.
Cancellation preserves a supplied arbitrary reason versus omitted reason,
detaches consumers, resolves/rejects waiters and retires queue references.
Share cancellation invokes actual source return and marks cleanup Promise
rejection handled; it does not mean that a never-settling external source
has completed native cleanup. SyncShare has its own supported policies and
sync iterator lifetime. These algorithms require engine jobs/AbortSignal/
bytes and actual source/sink ownership; no runtime conformance follows
from their being copied unchanged.

Classic interop caches fromReadable per instance, honors its protocol and
duck-typed fallback, batches read demand and converts non-byte chunks.
fromWritable/toWritable track callback/finish/drain/destroy state, sync
fallbacks, byte totals and arbitrary failure wrapping. toReadable and
toReadableSync have different pull/callback/cleanup scheduling; FileHandle
pull/pullSync/writer additionally belong to filesystem/native fd ownership.
The fs family remains incomplete and its public file methods cannot be
approved by this stream review.

## Owning layers, hosts, boundaries and evidence

All four hosts run the same guest stream algorithms and SpiderMonkey
Promise/ArrayBuffer operations, not the embedding host's stream classes.
Actual I/O path is stream subclass → callback/file-handle/net/TLS/native
adapter → owned native work/waits/buffers → libc descriptor/OFD/kernel
VFS/socket/pipe/TTY state → selected host adapter. fs streams wait for
kIoDone before closing fds with in-flight reads/writes
(`fs-streams.js:324–335,549–560`); their native callback jobs are real,
not replaced with microtasks. The pending filesystem audit must establish
those lower syscall/GC/callback ownership semantics in full.

Node's optional raw external TCP versus browser fetch/session/local routes
and each host's worker/shutdown behavior affect I/O and transferred streams.
They do not make local queues, constructors, encodings, port routing or
pipe semantics impossible. Guest memory/fd/backend limits must remain real
and documented. Windows HANDLE conversion is explicitly guarded for the
target Windows platform; unavailable POSIX HANDLE import is not a missing
portable stream API. No platform identity is spoofed and no entire family
is excluded. No upstream runtime defect is established here.

[Historical evidence](existing-evidence.md) retains exact source/artifact
identities and nonpassing statuses. The initial baseline's shared net
prerequisite failures do not reach most stream assertions; its narrow
test-zlib-no-stream pass does not validate streams. Old direct ponyfill
tests do not validate the now-selected pinned stream constructors. The
current candidate is unbuilt and has **no current four-host conformance**.

## Questions and proposed later controls

Retain target namespace/type/alias questions and tap/cleanup/duck-type
edges, actual fallback encoding/ICU activation, per-instance native Promise
and byte backing identity, transferred reader/port shutdown and precise
subclass fd callbacks. These are unresolved controls, not passes or
manufactured engine boundaries. Shared value/web/fs/async/worker audits
must feed their findings back into the final dependency matrix.

`streams-validation-candidates.json` is an unchanged-source selection aid
across categories, not an executable/assertion/subtest/variant denominator
or complete worker/resource/feature closure. Later exact native controls
must include inherited/described/symbol/alias/callable behavior, unusual
subclasses, sync/double/late callback/final/flush/construct/destroy errors,
pipe/pipeline/eos cleanup and abort races, encoding/Buffer mutation/HWM,
read and write backpressure, operator concurrency/early return, byte/BYOB/
detachment/resize/transfer, genuine port/native fd/ref teardown, iterable
all policies/budgets/pending-end/source-return/multiconsumer/duplex shutdown,
and sync/async classic and file interop. Preserve skipped, unsupported,
timeout, harness-error and failing cases as nonpassing.

All implementation and new runtime validation remain unauthorized. The
complete broad audit must be reviewed before either begins.
