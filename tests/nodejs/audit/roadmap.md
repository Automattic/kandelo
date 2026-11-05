# Proposed implementation roadmap — not authorized for execution

This is a **proposed audit deliverable**, subject to user review after the
complete family/source crosswalk. The current goal authorizes no fixes,
runtime tests, probes or builds. A completed audit must stop for review;
this ordering does not grant permission to execute it.

## Dependency order

The [values review](values-contracts.md) adds V-029–V-037 to foundation unit
1c: correct public Buffer conversion/encodings/overloads and storage policy;
the shared error/errno/diagnostic bridge; public util.deprecate option
adaptation and missing portable util/URL owners. Preserve real numeric,
unpooled native allocation, inspection and path algorithms. Their presence
does not close their adapter dependencies. Resolve concrete capability/data
questions separately from missing behavior; do not substitute host Node
APIs or add Claude-specific handling. Later units must consume the corrected
shared owners instead of introducing additional private approximations.

| Order | Focused work unit | Depends on | Why it unlocks later families |
|---|---|---|---|
| 0 | Review the audit dispositions, exact identities, capability/host boundaries, evidence limitations and open questions | Completed audit deliverables and explicit user authorization for subsequent work | Avoid targeting a wrong API/version, treating a stub as capability or validating stale bytes |
| 1a | Guest state and truthful public metadata: environment, process IDs/mask, signals/wait results, OS measurements and capability options | Actual kernel/native ownership; PROC/CP/observability findings | Process launch, npm selection, CLI/permissions, diagnostics and conditional upstream tests depend on accurate state |
| 1b | Native work/fd/backing-store lifetime, cancellation, GC, errors and loop liveness | Existing unbuilt native candidate reviewed and eventually validated | FS, streams, codecs, sockets, workers and shutdown share these owners; keep fd/OFD and guest/host state distinct |
| 1c | Scheduler/EventEmitter/async context and error/brand/byte foundations | Actual engine jobs, native async identity and buffers | Almost every asynchronous module depends on ordering, receiver validation, errors and encodings |
| 2a | Real socket/listen/accept/backlog/error controls, DNS/Resolver and datagram ownership | 1a–1c; libc/kernel/NetworkIO routing | HTTP servers, TLS/DTLS/QUIC and resolver APIs require real transport/capability metadata |
| 2b | Complete fs/path/descriptor/metadata/directory/watch operations and public VFS | 1a–1c; concrete filesystem backend capabilities | Loader, ZIP, SEA assets, tooling, SQLite and file streams need correct bytes, errors and resource lifetimes |
| 2c | Process/worker/message/IPC ownership and transport | 1a–1c; guest process/thread and clone models | ChildProcess, cluster, port/global/Web Stream transfer, test isolation and tooling depend on actual transport and per-owner termination |
| 2d | CJS/ESM/package resolution/hooks/cache/context semantics | 1c,2b; actual engine module lifecycle | Source correctness, type stripping, preloads, test mocks, VFS/SEA and module identity |
| 3a | HTTP/1 framing/parser/agents/server, HTTPS and complete TLS metadata/configuration | 2a,1b/1c; real crypto/certificates | Fetch and application networking must inherit correct behavior, including security-context-specific pooling |
| 3b | Real crypto key/KDF/cipher/signature/certificate/WebCrypto bridge and entropy policy | 1b/1c; exact backend feature review | Secure transport, WebCrypto, key brands and Node crypto require actual algorithms and owned native keys |
| 3c | Streams/WebIDL/Blob/File/FormData/Fetch/URL/encoding completeness | 1b/1c,2c,3a/3b | Shared constructors, transfer/body state and public web semantics cannot be supplied by export aliases alone |
| 3d | Codecs/ZIP/iterators and lifecycle/accounting | 1b/1c,2b,stream foundations | Existing pinned algorithms still depend on correct bytes, native cleanup, file errors and descriptor state |
| 4a | Terminal/readline/repl, observability, VM/debugger and test/benchmark tooling | 1–3 as needed; actual engine instrumentation and guest PTYs | No-op interfaces or fixed metrics must be replaced with actual device/engine/runner state |
| 4b | SQLite/FFI/WASI/SEA/addon/embedding integration | Native owners, loader, files, permissions and reviewed artifact/ABI capabilities | Real lower libraries exist but public bindings, ownership and format contracts remain missing |
| 4c | HTTP/2, DTLS and QUIC protocols | 2a,3a/3b; exact backend/protocol state | Independent real implementations, not extensions to an empty constants object |
| 5 | Close remaining API-specific and per-host deviations; final full conformance accounting | All applicable owners and approved validation | Completeness requires an audited denominator and evidence for identified bytes on every host |

Independent work units can later be scheduled separately, but their
dependency declarations must be reflected in PR bases and review scope.
The ordering is not a requirement to finish all of stage 1 before any
independent stage 2 work; it identifies the actual owning prerequisites.

## Source defects to prioritize within those units

Prioritize wrong-success behavior and ownership failures: child.kill(0)
becoming SIGTERM; fabricated DNS answers; lost environment inheritance;
zero status synthesized for ECHILD; filesystem metadata no-ops; stale
module cache after compilation failure; conditional weak entropy fallback;
TLS protocol/authorization metadata and insecure-context pool keys. These
have concrete source findings, but fixes remain unauthorized now.

The completed HTTP source review adds H-009–H-014. Prioritize request/response
socket ownership before expanding the client facade: idle unsolicited data
must not become a later response, non-idempotent pooled failures must not be
retried blindly, and sockets must remain owned until request writes and
response lifecycle permit reuse. Public Agents must govern actual pools,
including TLS security contexts and unreferenced idle resources. Then
complete parser/framing/headers/abort/server contracts and exact exported
versus returned class identities; generic Writable/Readable facades do not
supply them. Pure settings/validation/masking helpers can be independent
units, while proxy restoration must share real HTTP/HTTPS/fetch owners.
HTTP/2 needs a real codec/native session/stream owner with transport/ALPN,
flow/memory limits and file lifetime, not a populated constants-only stub.
These are proposed dependencies, not permission to execute the roadmap.

The completed engine review adds E-013–E-018. Correct sandbox association,
live property/descriptor forwarding and exact option/coercion semantics
before expanding the VM facade; use actual native script/module/GC owners,
per-context import/microtask/deadline/SIGINT scopes and gated activation.
Existing shell interrupt/debugger primitives do not supply these bridges
automatically. V8 metrics/profilers/coverage/snapshots need actual engine
instrumentation; persistent serialization needs correct bytes and lifetimes.
Separate V8-specific format/field decisions from portable missing behavior.
Inspector work needs a real protocol/session/native connection backend,
callback/Promise/notification/resource ownership and worker/main routing;
interactive and Node 26 probe CLI then depend on process/terminal/transport
and source metadata. Returned profile handles and disposal cannot be
implemented by renaming unrelated worker or shell objects. This ordering
remains a proposal awaiting the completed audit review.

The completed loading review adds L-026–L-033. Correct CommonJS wrapper
receiver/records/cache transactions and separate CJS/ESM format/URL/package
identity before broadening loaders. Preserve the actual resolve-only
import.meta path from patch 0030 while fixing its remaining metadata/URL
and hook contracts. JSON attributes/BOM/default-only cache identity and
Node 26 text/TypeScript activation need real parser/format owners. Package
maps are missing, but the pin's duplicate-URL documentation/source conflict
must be resolved before deciding that edge behavior. Public hook registration,
deregistration, native loader workers, SourceMaps and compiler cache must
share actual graph/file/shutdown owners. CLI work must first stop -c from
executing the bootstrap file and separate shell -p from Node --print, then
supply real Node argument/config/env/mode/preload and per-family consumers.
A matching shell option or stored Boolean is not that implementation.
Do not execute this roadmap under the audit-only goal.

The completed classic/consumer/iterable stream review adds STR-007–STR-011.
Keep the real pinned state machines and fix their owning prerequisites:
Buffer byte encodings/bounds/copy and selected decoder coverage, actual
EventEmitter/nextTick/fatal/async scopes, then native subclass/ref/fd and
process stdio backpressure/error/byte behavior. A WriteStream callback must
represent the correct owned I/O completion, and typed views must not be
silently discarded. Stream transfer needs real MessagePorts/native host
movement, distinct from working local byte queues and ArrayBuffer transfer.
Protect iterable budgets/pending writes/end/source-return/multiconsumer
and channel teardown by the actual source/sink/byte owners; do not add
consumer-specific copies, fake EOF or premature cleanup success. Share/
SyncShare factory namespaces and returned objects need the exact target
shape. Complete the separate web/filesystem/value/process audits before
settling their remaining shared obligations. No new runtime validation or
implementation is authorized by this roadmap.

Native integration must also address the concrete libffi call-shape and
closure-pool bounds (NI-008), SQLite session/extension compile features
(NI-009) and actual limits/durability defaults (NI-010). Version numbers or
working dlopen alone do not provide the public Node bridge. Preserve
NI-011 as a target prose/source conflict for later native control, rather
than hard-coding the prose restriction. Test/benchmark work additionally
requires per-owner framework state, real advanced IPC/backpressure,
loader mocks and actual instrumentation; TEST-007 preserves source-only
timer option coverage.

Then complete shared foundations rather than adapting individual npm or
Claude callers. Missing class methods should attach to real owners and
state; capabilities must describe actual implementation and activation.
Do not change process.platform to Linux, stub test frameworks, suppress
assertions or label missing bindings as browser limits.

## Suggested review/shipping boundaries

Keep audit documentation separate from implementation. For later work,
use focused draft PRs for native lifetime/async foundations, core value and
encoding behavior, fs semantics, processes/environment/signals, sockets
and DNS, loader/VM, TLS/crypto, HTTP, web interfaces, and remaining tooling
or native integrations. Split further where native/kernel ownership is
independently reviewable; keep dependent changes in an explicit stack.

The current large dirty source candidate has no runtime validation. Its
prior source-only changes must be reconciled and tested after approval
before claiming any portion shippable. Preserve the separate Claude/npm/
Bun remainder and unrelated local work; do not fold them into a general
core-module compatibility claim or a single opaque Bun PR.

Scoped timer/domain/diagnostics reviews additionally identify cancellation
argument retention, function/inspection metadata, I/O-versus-job delivery,
missing fatal exception routing and late primitive coercion (A-010–A-015).
Namespace/scope ownership and target mid-trace subscription disagreement
are A-016–A-017. Later implementation must use the shared lifecycle/error
owners rather than add isolated passing wrappers.

The completed native source review adds the public own C++ header and SEA
packaging obligations (NI-012–NI-014). Preserve the exact V8/ISA/format
boundary while separately implementing portable environment/Node-API,
ordinary non-SEA behavior, asset/loader/VFS and cleanup ownership. Native
target CI skips do not establish guest impossibility. Packaging format
and snapshot/cache admission are later review decisions, not authorization
to consume incompatible native bytes or to implement a one-program path.

Completed terminal source requirements add T-013–T-017. Build readline and
REPL on actual input/output/TTY/history/context owners; the facade has no
input and its immediate empty answer is wrong-success behavior. Node 26's
REPL requires ALS and additive process exception capture as well as its
remaining active-domain interaction; importing domain alone is not the
target design. Keep promise transactions, programmatic sessions and CLI
entry/history selection distinct. Settle target iterator/exception/history
questions through later controls before choosing semantics.

The EventEmitter/context/Event/Abort reviews add A-018–A-030: coded error
and fatal-stack metadata, hook exit callbacks/abort policy, real Promise
activation and native public-resource/provider integration, alternate ALS
mode, shared clock origins and actual host-object/port transfer. Resolve
documented target disagreements through later native controls; keep those
questions separate from definite missing implementation. Imported classes
do not fill missing public consumers or native lifecycle owners.

Observability requires shared module/global Console/Performance owners,
actual format/stdio errors and state, entry/observer/resource queues,
real guest measurements and histogram storage/jobs/samplers, tracing
producers/files, and real diagnostic-report schema/loader state.
O-014–O-023 preserve metadata/byte/lifecycle defects and target questions.
Separate V8/libuv-specific fields from portable missing behavior and
obtain decisions for those fields before claiming boundaries or support.

No merge, deployment, product rebuild, PR publication or implementation
action is authorized by this document. Actual PR scope and validation
budget are decisions for the post-audit review.

The completed worker source review adds R-012–R-016. Slice 2c must first
provide independent native worker handles and complete child environments,
then per-worker clone/transfer/port ownership, readiness/error/exit routing,
refs, stdio and teardown. Reuse actual backing-store references; do not
replace a mailbox race with blanket copying or global join. Keep Node's
awaited termination and browser quiescence/fence requirements explicit
before reusing thread slots or memory. Environment data, arbitrary-thread
routing and shared locks depend on that identity/queue/lifetime model.
CPU/heap/loop measurements depend on real instrumentation; exact V8 formats
need individual boundary decisions, not invented statistics. Preserve
R-014 target questions for later exact native controls. This roadmap
remains unapproved and must not be executed under the audit-only goal.

The completed compression review adds ZIP-007–ZIP-012. Slice 3d requires
actual shared/resizable/leased storage ownership and target numeric/error
conversion at the native boundary, including pre-ZlibBase constructor
failures. Preserve genuine target no-ops separately from missing work.
ZIP operations depend on real fs/stream handles, short I/O, borrowed-entry
invalidation and source disposal; source copying alone cannot close those
gaps. Retain ZIP-011/012 as target questions for later native controls.
Library feature/source identity, codec allocation deltas and worker roots
must stay separate from built artifact identity, complete instrumentation
and runtime conformance. No implementation is authorized by this ordering.


The completed crypto source review adds C-009–C-016. Prioritize real host
entropy quota/failure semantics before relying on random APIs: whole large
Urandom reads currently reach a single over-quota host Web Crypto call,
and the missing-CSPRNG fallback is weak. Then address Buffer/encoding/
brand/native-lifetime owners, NUL-truncated hashing/HMAC keys, native
constant-time comparison and real stream interfaces. Backend/provider
capabilities and native key/certificate authority precede cipher, signature,
keygen/exchange/KDF/MAC and full Web Crypto integration. Missing bindings,
metadata and callbacks cannot be solved by importing an outer host key or
advertising a static algorithm list. Preserve conditional provider/FIPS
features and C-016 target questions; no roadmap execution is authorized.


The completed secure-network source review adds S-008–S-014. TLS work
must attach real net.Socket/net.Server owners and existing-transport
wrapping before claiming inheritance, address/control, ref/timeout or
half-close behavior. Configure actual native context/credential/CA state,
report negotiated protocol/verification instead of requested policy, and
provide independently cancellable handshake and asynchronous shutdown
owners with precise errors. Preserve browser synthetic TLS/session trust
versus raw/local/session transport distinctions; do not invent origin
certificate metadata. DTLS/QUIC require real UDP/native protocol and timer/
loss/congestion/flow owners, not only libssl or copied wrappers. Their
flagged native capture, Stats/writer/callback/permission/HTTP3 requirements
and S-014 reference questions belong in subsequent focused reviews and
controls. The audit still authorizes no implementation or validation.


The completed network source review adds N-015–N-022. Close real socket
fd-type/adoption/reconnect/stream state and native errno/callback ownership
before calling TCP complete; preserve the working native connect/accept,
half-close, timeout-progress and ref paths. Apply live server/rule/options,
accepted pause/HWM state and true backlog/host registration rollback.
Kernel receive/send byte budgets and actual transport controls cannot be
replaced by JS storage/read-back. OS getaddrinfo and per-instance real
record Resolver channels are distinct owners; remove fabricated resolve
answers through a real backend, with exact promise versus callback
validation/settlement. Address/reservation/IPC/UDP/transfer bridge work
inherits existing kernel networking and source gaps. Preserve target500ms
initial family timeout, musl platform flag values and N-022 questions;
never spoof Linux identity or translate backend restrictions into passing
public APIs. Implementation and runtime validation remain unauthorized.

## Web-family audit integration — proposed only

The complete [Web source review](web-contracts.md) and its requirements
ledger preserve 548 original obligations, flag/default exposure and actual
shared Node stream ownership. Later work depends on truthful guest
metadata/options, byte/encoding/WebIDL foundations, actual entangled
ports/worker/storage owners, and HTTP/TLS/socket/DNS/resource lifetimes.
Implement ordered guarded header lists/cookies, complete Request/Body/
Response/static APIs and multipart, then actual Fetch policy/demand/
abort/cleanup. Add missing normal globals and enabled experimental APIs
with correct target activation; keep configured Intl/ICU4X versus fallback
selection explicit. Do not substitute the outer host APIs or identity.

`web-validation-candidates.json` selects unchanged future Node/WPT files
and resources. It is not an executable count or fixture closure. After
separate explicit authorization, native exact-pin controls and four-host
identified artifacts must cover descriptors/brands/aliases, throw versus
reject, encoding/BOM/splits, base64 validation, Blob/shared byte ownership,
BYOB/tee/clone/cancel, dispatcher/redirect/decompression/multipart/header
guards and abort/network cleanup, plus ordinary/enabled feature branches.
No implementation, runtime validation or builds are authorized by this plan.

## Deprecation/source-applicability reconciliation — proposed only

The [documentation review](documentation-contracts.md) preserves all 207
current identifiers and their full normative text, type and owner mapping.
Later implementation must remove genuinely target-absent exports, retain
current aliases/revoked behavior and enforce exact changed overloads or
argument types. Integrate actual CLI/environment/origin/warning/async/error
state; existing selected deprecator callers must remain truthful. DOC-010
corrects the fixed-env-list inference: reads can fall back to native getenv;
full enumeration/native mutation/deletion/child inheritance remain separate.

After explicit authorization, unchanged sources in
`documentation-validation-candidates.json` and exact native controls should
cover caller origin, pending/no/throw/trace warning modes, once/descriptor/
callable/new/alias/removed argument behavior, native environment and actual
supported native ABI. The catalog includes helpers/resources, not an
executed denominator or complete fixture closure. No tests/builds or
implementation are authorized by this plan.

## Process-family dependency integration — proposed only

The [process review](process-contracts.md) traces guest/native/libc/kernel/
host owners for all 778 original obligations. Later work must connect real
environment/credentials/cwd/mask/resource state, full scheduler/fatal/signal/
beforeExit/ref/finalization integration, actual ChildProcess/stdin/pipe/wait/
IPC/cluster owners, enabled permission enforce/audit/has/drop and DotEnv
loading/parsing, and truthful OS/build/descriptor metadata. Preserve working
PATH search and synchronous fd adoption/deadline/aggregate maxBuffer/reap
behavior. A native capability below a missing binding is not completed API
behavior; fake outer-host metadata is not a substitute for guest state.

After explicit authorization, unchanged sources selected in
`process-validation-candidates.json` and exact native controls must cover
real pipe/signal/IPC/permission/worker fixtures, every error/terminal/ref/
environment/identity/descriptor/overload/event path and four identified host
artifacts. Preserve the historical Firefox exit-fixture timeout without
calling it a current candidate failure or established engine boundary. The
catalog includes helpers/resources and is not an executable denominator or
completed fixture closure. No runtime tests, builds or fixes are authorized.

## Filesystem/public VFS integration — proposed only

The [filesystem review](filesystem-contracts.md) retains all 743 original
obligations, exact source/range correspondence and distinct actual native
versus legacy owners. Later work depends on bytes/encodings/errors/async
and backing-store leases, guest fd/OFD/credential/path/mode/metadata state,
correct recursive/atomic/path/callback semantics, FileHandle/Dir/stream/
watch/temp/disposal lifetimes and enabled public VFS/provider/fd/loader/
SEA/ZIP routing. Preserve real native request/close/GC/ref and memory
ownership; neither kernel VFS nor a stored full Node source file proves
public API integration. Resolve FS-021 exact target promise-open contract
before implementing against assumed FileHandle returns.

After explicit authorization, unchanged candidates in
`filesystem-validation-candidates.json` and exact native controls require
actual pipe/device/raw-byte/shared/resizable/fd-race/failure/GC/abort/mount/
permission/VFS fixtures and identified artifacts on all four hosts. Cover
Number/BigInt/Temporal metadata, descriptors/aliases/returned owners and
backend persistence/readonly/link/metadata operation boundaries separately.
No no-op backend is a compatibility pass. The catalog includes helper/
resources and is not an executed denominator or complete fixture closure.
No implementation, tests, probes or builds are authorized by this plan.

FS-022 adds a shared byte-path prerequisite: retain raw component identity
through the guest-kernel/host/backend boundary or reject unsupported input
truthfully. The current default TextDecoder/string interface can reinterpret
invalid UTF8 names. Kernel tmpfs byte-name maps and host-backed mounts require
separate controls; native Buffer path copying alone does not close the gap.
