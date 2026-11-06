# Current public-contract reconciliation

Source125 installs the pinned public AsyncHook class with actual symbol/count
registry semantics,ordinary public functions and a stable ordinary root resource.
Eleven new and23 affected frontend controls,12 package checks and four runs of
two unchanged upstream files pass in explicit native-dependency scopes. The
initial regression exposed a fixture floating-point grouping error; its failure
and preimage remain retained. Guest117–125source remains uncompiled;accepted116
is stale. All19families remain partial;overall suites/full rebuild remain deferred.
See [AsyncHook ownership](async-hook-registration-implementation-dependencies.md).

Source124 adds actual per-context loop-start/idle measurements and the full
pinned event-loop-utilization calculation. Six new and seven existing frontend
controls, six portable clock-owner checks and12 package checks pass in their
recorded scopes. The complete unchanged upstream ELU file passes natively and
fails against the candidate at missing NodeTiming milestones; that failure is
retained. Selected shell-file patch composition is checked from the canonical
Mozilla archive. Guest source117–124 remains uncompiled; accepted116 is not
current. All19 families remain partial; overall suites/full product rebuild
remain deferred. See [loop measurements](loop-metrics-implementation-dependencies.md).

Source123 adds actual EC/OKP/PQC raw-key imports, exact algorithm spelling,
point/scalar/seed validation, public-role projection and pinned provider
encoding initialization. Four new frontend comparisons and23 affected controls
pass, alongside92 portable byte/error comparisons,18 affected material-owner
comparisons and two runs of one unchanged upstream file. The614-input source
guard and12 package checks pass. These are separate evidence scopes, not API
closure. Guest source117–123 is uncompiled; accepted116 is not current. All19
families remain partial; overall suites/full product rebuild remain deferred.
See [raw key ownership and evidence](raw-key-implementation-dependencies.md).

Source122 adds pinned logical/native realpath, readlink and full glob traversal
using real POSIX byte results/queued requests and shared Dirent/stat owners.
The private URL-or-path converter now serves filesystem consumers. Sixteen new
and37 affected controls,16 portable byte/error comparisons and eight unchanged-
file runs pass in their explicit native-boundary scopes. Guest source117–122
is uncompiled; accepted116 is not current. All19 families remain partial;
overall suites/full product rebuild remain deferred. See
[path/traversal ownership](filesystem-traversal-implementation-dependencies.md).


Source121 installs the pinned shared warning owner and actual CLI option
source for filtering, trace/deprecation policy and redirect-file lifecycle.
Sixteen new frontend and47 affected controls pass; one known environment-clone
fixture nonpass remains. Four unchanged-file runs and14 portable parser
comparisons pass in their explicit native-boundary scopes. Guest source117–121
is uncompiled; accepted116 is not current. All19 families remain partial;
overall suites/full product rebuild remain deferred. See
[warning ownership and evidence](warning-implementation-dependencies.md).


Source120 adds real borrowed-stdin terminal mode leases, pinned mode/error
policy, actual window queries and transport/context/GC cleanup. Five native-
boundary frontend comparisons, four affected stream controls and one portable
PTY/native comparison pass in their recorded scopes. The guest binding and
117–119 source remain uncompiled; accepted116 is not current. Public TTY classes,
signals/drain and four-host conformance remain open. All 19 families are partial;
overall suites/full product rebuild remain deferred. See
[terminal ownership and evidence](terminal-mode-implementation-dependencies.md).

Earlier revision checkpoints below retain their historical scope.

Source revision119 adds pinned Module.wrap/wrapper owners and actual patched
script compilation, preserving the ordinary function compiler. The shared
invocation now snapshots exports once for receiver/argument identity. Eight
new and fourteen affected frontend controls pass; two unchanged upstream
fixtures pass in candidate/native modes. Guest compilation and four-host
conformance remain pending; accepted116 is not current for source117–119.
Earlier guest failures and all 19 incomplete families remain open. Overall
suites/full product rebuild remain deferred. See
[wrapper ownership and evidence](module-wrapper-implementation-dependencies.md).

Earlier revision checkpoints below retain their historical scope.

Source revision 118 adds pinned hard-link sync/callback/promise APIs over
actual libc operations, owned queued source/destination paths and shared
destination-error completion. Twelve frontend controls and one portable-owner
comparison pass within explicit native dependency boundaries. The new C++ and
source117 empty-input fix remain guest-uncompiled; accepted engine116 is not
current. Its earlier cipher failures remain open, with a bounded native-tag
investigation recorded separately. All 19 families remain incomplete; overall
suites and a full product rebuild remain deferred. See
[hard-link ownership and evidence](hardlink-implementation-dependencies.md).

Earlier revision checkpoints below retain their historical scope.

Source revision 117 supplies pinned Cipheriv/Decipheriv algorithms over actual
native ncrypto/OpenSSL contexts and fixes the empty-data versus null-control
boundary. The accepted targeted engine 116 compiles the preceding source and
passes artifact admission. Five Node-host guest comparisons record one pass
and four failures with escaping Wasm exceptions; these failures remain open.
The empty-input fix has portable-owner evidence but is guest-uncompiled.
All 19 families remain incomplete. Overall suites and a full product rebuild
remain deferred. See [cipher ownership, evidence and gaps](cipher-implementation-dependencies.md).

Earlier revision checkpoints below retain their historical scope.

Revision 115 compiles real named broadcast groups and owned shared engine
message storage, including revision 114 temporary-directory owners. Normal
artifact admission succeeds; four same-source exact-native/Node-host guest
controls pass, including a real worker exchange and temporary-dir disposal.
Four-host and whole-family conformance remain unestablished; all 19 families
are incomplete and overall suites/full product rebuild remain deferred. See
[broadcast ownership and scoped evidence](broadcast-implementation-dependencies.md).


Earlier source revision 114 adds pinned temporary-directory and disposal APIs over
real libc creation, native FS requests and existing removal owners. Seven
new frontend controls, twelve affected controls, nine portable native-owner
scenarios and four unchanged upstream files pass within their documented
control boundaries. The changed guest source is uncompiled; accepted engine
113 is not current for this candidate. All 19 families remain incomplete,
and overall suites/full product rebuild remain deferred. See
[temporary-directory ownership and evidence](tempdir-implementation-dependencies.md).


Current follow-ups: [upstream AssertionError/shared validators](assertion-error-implementation-dependencies.md)
and [accepted kernel/three actual environment guest cases](kernel-admission-integration.md).
Earlier recipe-specific statements below retain their historical scope.


This is an implementation-phase companion to the frozen
[source audit](../audit/audit-report.md). Original obligations, unresolved
questions and historical nonpasses remain intact. The exact Node 26.13.0
source/native pins are unchanged. Recorded official-source research remains
historical; this document makes no new release-availability claim.

All 19 families now have implementation-phase work started, including this
documentation/capability/deprecation crosswalk. **None is complete.**
Starting a family does not mean its audited APIs were implemented or that
the breadth-first pass is ready for overall suites. The current combined
candidate still lacks four-host guest conformance evidence.

Engine107 now has three passing native/actual Node-host guest environment
controls after canonical targeted kernel admission was repaired. The standalone
native dependency report remains16cases:15pass/1fail; its custom V8 interceptor
snapshot rejection is preserved independently. Full environment prototype,
constructor, ordering, warnings/TZ/permissions, shared worker stores and engine
lifecycle still need implementation and validation. See
[admission and identified guest outcomes](kernel-admission-integration.md).

Source108/109 replaces the handwritten AssertionError, six generic assertion error
constructors and the separate primordial subset with pinned Node error/diff
algorithms and the existing shared errors/validators/colors. Focused native
controls and four unchanged upstream files pass. Corrected109compiles and has
4pass/1fail among five actual Node-host guest cases; the diagnostic failure
retains extra native Error own keys. All108bootstrap failures remain recorded.
Error construction/shape, stack recapture/filtering, source expressions,
complete inspection and four-host conformance remain gaps. See
[assertion owners and evidence](assertion-error-implementation-dependencies.md).

Source110 adds an embedding option for non-standard native Error location
arguments/properties, selected before root/worker globals and inherited by VM
realms. The original diagnostic case now passes. Eight actual Node-host guest
cases record7pass/1fail, with complete generic Error reflection still failing
at the own lazy stack/prototype contract. One standalone shell preservation
case passes separately. See [Error owners/evidence](error-location-implementation-dependencies.md).

Source111 reuses pinned URL/file-path/byte-path/HTTP-option algorithms over
the shared parser and actual Buffer/path/error/platform owners. Source/frontend
controls pass, and upstream outcomes retain6pass/2actual-macOS skips. These
bytes are guest-uncompiled; accepted110is not current for this candidate.
The frozen V-036 URIError sentence is inconsistent with the pinned source and
native reference; its resolution is recorded without modifying the audit.
See [URL/path owners, evidence and remaining gaps](url-path-implementation-dependencies.md).

Source112compiles shared/growable native codec/work queue leases and
synchronous resizable codec/dictionary/CRC views. Actual Node-host comparisons
record3pass/4fail. All original public assertions finish successfully; raw
byte traces explain the four gzip checksums by the unchanged native-macOS19
versus guest Unix-default3OS byte. Failures are not relabeled as passes.
Ordinary async resizable/transfer/lifecycle obligations remain implementation
gaps. The unchanged111URL/path JS is compiled in112but has no new focused
guest helper evidence. See [storage owners and bounds](compression-storage-implementation-dependencies.md).

Source113adds actual SQLite scalar/aggregate/window registrations, GC-traced
callback and accumulator state, native parent-handle retention and whole-call
session pins. Its targeted engine compiles/admission passes. Current scoped
comparisons record3pass/6fail; eight native expectations pass and one fails.
Successful return/group/window cases do not establish error/constructor/session
or whole-family conformance. See [callback owners and evidence](sqlite-callback-implementation-dependencies.md).

## Family source routes and remaining owners

Paths below are under third_party/node-core unless stated otherwise.
Every slice remains partial. The original family reports retain the rest
of the APIs, overloads, inherited members, symbols and open questions.

| Family | Current shared source routes | Remaining owner requirements |
|---|---|---|
| Values | pinned URL/path/byte-path/HTTP-option helpers over shared parser and platform owners; generic native Error location policy; pinned AssertionError/Myers diff and shared validator/error/color/primordial owners; values/util/UV/dotenv/MIME/Buffer/path owners and full querystring/punycode algorithms with saved-frame load-origin source; pinned util/StringDecoder owners and callable Buffer/shared aligned pool/permanent storage/zero-fill source | Private worker marks have a source owner and focused environment evidence; remaining Buffer/backing-store/realm/CLI/error/descriptor edges, remaining util/URL/IDNA/encoding, complete errors/brands/descriptors and guest byte/origin/loader/warning conformance |
| Async | Pinned public AsyncHook/createHook algorithms over real symbol/array/count registry,nested mutation publication and native destroy tracking;ordinary public metadata/root resource;existing frame/ID/resource/tick/job callback owners | Promise activation/removal and ALS CLI path,full native resource/provider/default-trigger mapping,GC/destroy/rejection/fatal/worker/realm/loop/cancellation/ref integration and guest/four-host conformance remain open |
| Streams | stream/fd-stream platform adapters and shared pinned StringDecoder public/byte-state owner | Socket/TTY/file subclasses, backing-store transfer, fd reuse/retirement, pipeline/adapter lifecycle/errors and guest decoder integration |
| Filesystem | Real hard-link,temporary-directory,logical/native realpath/readlink and full glob owners now join pinned file jobs/handles,Dir/readdir/Dirent,metadata,removal and sync/callback/promise byte algorithms | Guest cursor/GC/ref/OOM/realm and fd/byte-path/backend integration;complete watchers/VFS/metadata/permissions,timestamp precision and actual statfs capacity;FS-022 raw host paths remain open |
| Processes | bootstrap process/ChildProcess, process-clock/state/usage validation and explicit absent numeric providers, dotenv/child-wait, pinned OS frontend with native POSIX state, unchanged weak finalization/lazy descriptor and Refable dispatch; actual linked dependency versions with read-only/configurable version descriptors; native live environment virtual Object/property hooks and inherited-receiver policy | Complete environment prototype/constructor/keys/warnings/GC/JIT/clone and worker/TZ/CLI behavior, fatal/rejection/GC/exit/worker/resource reference integration, signal/IPC and exceptional wait/close policy, measurements, permissions and OS metadata; guest lifecycle/mask/parent/env conformance pending |
| Network | native address/rule state, pinned BlockList/SocketAddress and live TCP consumers; queued lookup, actual c-ares channels/record JSAPI/external-completion source and libc/kernel/host routes | Guest rule/clone/worker integration, full Socket/Server controls/lifecycle, Resolver configuration/permission/JSAPI lifecycle integration and datagram owners; source/native controls are not guest conformance |
| HTTP | Pinned outgoing headers/full IncomingMessage and unchanged common parser callbacks; actual Node-vendored llhttp/private GC-owned response framing, strict/insecure/relaxed limits, interim/HEAD/upgrade/CONNECT source; unconditional pooled replay and same-feed leftover reuse removed | Synchronous native-to-JS callback/reentry/byte/memory/error/EOF integration, OutgoingMessage/request framing, idle bytes/public Agent/TLS pool keys, servers/request parsing and HTTP/2; guest/four-host lifecycle remains unvalidated |
| Secure network | TLS identity algorithms, actual live OpenSSL protocol/cipher/reuse/Finished/verification metadata source, shared IP/domain helpers and transports | Complete socket/context/trust/key/certificate/handshake/session ownership, metadata/error/descriptor fidelity, secure pooling/servers and DTLS/QUIC |
| Crypto | Pinned random/KDF/digest/Hash/Hmac/HKDF and cipher owners;real ncrypto secret/PEM/DER/raw EC/OKP/PQC material,roles,metadata and one-time provider encoding policy through123source | Guest117–124uncompiled;retained116cipher exceptions;JWK/store/PKCS12,WebCrypto,key generation/exchange/signatures/certificates,FIPS/provider transitions,transfer and allocation/lifecycle/namespace obligations |
| Web | File/FormData/Headers, private header guard/list consumers, Blob/clone and Web Stream owners | Complete body/Fetch/WebIDL/global/encoding/URL semantics, transfer and network/crypto dependencies |
| Loading | Partial pinned Module.wrap/wrapper and patched-script source owners with single exports snapshot; Real native parser goals and direct CJS body compilation, pinned filename/package/entry selection and shared ESM source format in103; Module record/require/JSON, package cache/reader, exports/imports/conditions/self/maps and SourceMap algorithms | Actual guest parser/error/source/realm evidence; complete provided-source execution, CJS wrapper/hooks/cache and ESM URL/namespace/JSON/async/cycle/dynamic-import graphs; TypeScript/Wasm/addon/source-map/cache/preload/CLI/permission/lifecycle owners; four-host conformance |
| Terminal | Pinned shared/callback/promise readline,history/key/cursor owners plus120actual borrowed terminal-mode leases and window queries | Full public TTY/stdio classes,signals/resize/drain,Unicode width,persistence/permissions/REPL and guest lifecycle/stream/symbol conformance |
| Workers | Actual thread/context/input/error/join owners,connected message packets,115named broadcast registry/fanout and shared native weak clone/transfer marks;124per-context loop measurement source | Complete endpoint/host transfer/context movement,thread routing/locks,Worker options/stdio/shared environment/resources/ref/failure/termination and parent-side performance/GC/realm/four-host evidence |
| Compression | pinned codec/archive/iterable JS and native contexts; actual shared/growable queue leases and synchronous resizable codec/CRC/dictionary spans compiled in112 | Ordinary async resizable/transfer/pre-existing pin ownership; complete modes/options/iterators/files and native cleanup/cancellation/accounting; retained gzip OS-byte comparison mismatches and complete four-host evidence |
| Observability | Pinned Console/diagnostics/TCP/DNS producers,Performance timeline/entry/observer/resource/timerify algorithms and process-origin clock;124real per-context loop-start/idle owner and complete pinned ELU arithmetic | Compile/validate actual loop hooks;other milestones/counters/histograms/GC/network producers,stack/inspector/global/realm/stream integration,public tracing/reporting and complete four-host conformance |
| Engine | generic native Error location policy across registered root/worker contexts and VM realms; VM compiler, actual ordinary DONT_CONTEXTIFY globals, per-runtime chained security-callback owners and partial nominal GC budget | Complete ordinary sandbox exotic behavior, context metadata/deadlines/modules/cache/microtasks, inspector, heap measurements and worker/guest integration |
| Testing | Full pinned Test/Suite/harness/utils execution owners; actual native-frame caller location route and source-derived default option state, mock/reporter owners | Guest execution/async/fatal/phase/context/cleanup integration; discovery/run/CLI/isolation, snapshots/module mocks, measured coverage/benchmarks and complete lifecycle |
| Native integration | SQLite scalar/aggregate/window registrations and GC-traced native callback/parent/accumulator owners compiled in113; real SQLite statement/iterator/column/limit/defensive/session/change-set and rooted synchronous callback owners, native virtual limits and actual activation | Statement close/dispose/serialization; complete scalar/aggregate/window error/reentry/GC policy, authorizer/virtual-table callbacks; complete limits/reflection/storage/GC/realm/accounting, tag cache/backup/extensions, FFI/WASI/SEA/addons/embedding and ABI/loader |
| Documentation | This reconciliation and original requirements | Actual warning/origin/CLI/environment/activation behavior and unresolved target prose/source questions |

## Measurement and capability gaps

* Process CPU/thread/memory/RSS/resource algorithms now use exact pinned
  validation/delta/field source. Guest numeric providers remain missing and
  reject explicitly; kernel getrusage zeros/elapsed CPU approximations are not
  reused as measurements. Host totals are not guest totals.
* process.report.getReport now rejects instead of inventing a musl loader
  pathname. Complete real report/loaded-object ownership remains missing.
* The partial v8.getHeapStatistics heap_size_limit field reads the actual
  nominal configured engine JSGC_MAX_BYTES soft budget. Other required fields,
  effective memory ceilings and cross-engine metric correspondence remain
  unresolved; this is not full V8 statistics or reachable heap capacity.
  getHeapSpaceStatistics rejects instead of returning an unmeasured empty list.
* features/config/moduleLoadList remain incomplete capability/configuration/
  activation metadata; removing five numeric/report wrong-success literals
  does not complete those owners or establish API compatibility.
* DNS resolve now has actual native c-ares channel/query and record conversion
  source behind the full pinned public callback/promise modules. Configuration
  refresh/permission/guest lifecycle and host egress remain implementation and
  validation requirements. Host routing addresses are not actual DNS records.
* Namespaces/copied references do not establish execution. Worker.terminate
  now uses actual per-worker stop/join/exit state; test/suite/hooks use real
  pinned execution owners, while discovery/run still rejects.
  Standalone mocks, queues and formatting do not close those operations.

## Deprecation and activation correspondence

The public util slice now owns DEP0044/isArray and DEP0060/_extend wrappers
and the target deprecate options wrapper. Removed legacy predicates are
absent. This does not complete warning flags, origin filtering, stacks,
process warning policy or every deprecated caller. Pinned SQLite retains
DatabaseSync/StatementSync documentation-only aliases DEP0210/0211.
Documentation-only status must not introduce runtime warnings. DEP0132
Worker termination still requires a real per-worker settled exit result.

Other codes retain their original requirements and open owner dependencies.
Buffer's callable constructor/DEP0005, punycode DEP0040, URL DEP0169,
FileHandle/Dir GC policy, fs/zlib/child callers and deprecated private-module
activation cannot be inferred from literal codes in a bundle. Flags,
NODE_OPTIONS, complete environment policy, loader origin and stacks need
their actual owners. Rejected unsupported options are not activated APIs.

The process-state slice now supplies real libc environment mutation and
enumeration, a live parent getter and the actual creation-mask owner.
It does not complete worker environments, TZ refresh, exotic-object
metadata or warning/trace/CLI activation. The dependency record separates
native helper/frontend evidence, exact compiled artifacts and three actual
Node-host guest environment cases; it does not establish broader process
semantics or browser conformance.

## Four-host boundaries and evidence

All hosts execute shared guest SpiderMonkey/bootstrap code. Native-backend
controls substitute native engine/OS dependencies; standalone C++ controls
do not compile the engine bridge. Historical product evidence remains tied
to its recorded artifacts, not the combined candidate.

Transport, DNS policy, entropy, monotonic time, memory budgets and worker
teardown differ at their actual host adapters. Outer native APIs do not
automatically implement guest APIs. Browser sandbox limits need individual
API evidence and a concrete boundary; missing guest algorithms, bindings,
providers and lifecycle remain gaps. V8 bytecode/snapshot formats, direct
V8 C++ ABI and CPU-native artifacts need specific architecture decisions;
they do not exclude portable VM/diagnostic/stream/loading behavior. This
reconciliation accepts no new exclusion.

## Dependency-based next pass and later validation

Continue shared state/metadata, errors/brands/bytes, native resource/GC/ref
ownership and scheduling. Complete transport/Resolver and fd/filesystem/
process ownership alongside independent portable algorithms, then their
HTTP/crypto/web/worker/loader consumers. Follow the existing VM, SQLite,
stream, worker and testing dependency documents rather than adding facades.

Before overall suites, reconcile remaining original findings against the
combined candidate, including inherited/returned/symbol/gated APIs and
shared prerequisites. Nineteen started families do not close that work.
Then identify exact build artifacts, honor the full product rebuild
deferral, and validate unchanged upstream assertions/native controls on
every applicable host. Preserve failures/skips/unsupported/timeouts/harness
errors separately; none are passing compatibility. Source changes cannot
silently promote or reset historical results.

The IncomingMessage/client-consumption slice was staged as recipe77 and
compiled with the subsequent normal targeted engine78. No guest HTTP
behavior is validated by the separate VM controls. See
[HTTP IncomingMessage dependencies](http-incoming-implementation-dependencies.md)
for exact focused evidence, retained harness failures and remaining owners.

The subsequent Worker source replaces minimal-prelude/JSON/shared-mailbox
launch with per-worker native context/thread/packet/endpoint ownership and
normal Node bootstrap/loader, ready/error/exit and independent stop/join/ref
state. Patches86–88 reached targeted engine83 acceptance; six identical
native/Node-host guest cases pass. Options/stdio/fd/transfer/resource/lifecycle,
ordinary stamped-consumer and four-host obligations remain open. Recipe84
Test/Suite/harness source is uncompiled; native-boundary controls remain
separate from guest execution. See worker-owner and testing dependencies.


Recipe83's normal targeted engine build succeeded. Six identical native/guest
Worker case sources pass on the Node host, with prior startup nonpasses retained.
These are separate from options/stdio/fd/transfer/lifecycle/ABI/four-host closure.
Subsequent recipe84 Test/Suite/harness integration passes selected controls over
native dependencies and remains uncompiled in the guest; the combined current
candidate is therefore newer than the last accepted artifact. See testing and
worker-owner dependency records for exact sources, counts and remaining gaps.

Engine88 compiles the SQLite owner and testing integration plus real beforeExit/
SQLite activation prerequisites. Exact selected Node-host guest outcomes are in
sqlite-session-finding-progress.json. No family, ordinary stamped ABI consumer
or four-host conformance is closed; all original observations remain retained.
