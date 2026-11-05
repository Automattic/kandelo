# Proposed subsequent validation plan — execution requires authorization

No command in this plan has been newly executed for the audit. Even WPT
discovery can execute code and remains forbidden until a later approved
validation phase. Full product rebuild deferral remains in effect.

## Identity and accounting first

Freeze exact target/source/native reference pins, source dirty-tree
identity, generated inputs, package/engine/ABI versions and per-host
kernel/image/guest archive hashes. Tooling Node is not the native control.
Record host engine versions, launch/fixture capabilities and limits.
Invalidate evidence when any owning source or artifact changes.

Store a case key including target/source, suite/file/subtest/variant,
flags/environment/fixture identity, host and artifact fingerprint. Preserve
pass, fail, upstream-skip, unsupported, timeout, harness-error and pending
separately; do not overwrite earlier attempts or combine counts from
different artifacts into a synthetic passing run. An unsupported required
flag means the body did not execute. A native skip does not make a guest
implementation conformant.

Use unchanged upstream files and real launch semantics. Do not edit flags,
assertions, output expectations, platform identity or test framework to
make cases pass. Differential controls supplement upstream coverage and
must compare meaningful result/error/order/lifetime behavior, including
deliberate negative cases. A success marker alone is insufficient.

## Expand beyond the original 5,147 cases

The discovery manifest lists 39 categories, not 39 equivalent suites.
Pinned testcfg.py and `test/testpy/__init__.py`:35–230 establish different
launchers and discovery. Zero direct JS/MJS files does not mean zero
coverage: AddonTestConfiguration discovers nested JavaScript cases.

| Coverage group | Required review and later launcher behavior |
|---|---|
| parallel/sequential | Preserve baseline identities and all statuses; include Flags, Env, injected test reporter and RLIMIT requirements |
| async-hooks, es-module, module-hooks, client-proxy | Actual contexts/jobs, module graph/flags/fixtures and protocol variants; relevant public-core coverage beyond baseline |
| test-runner, benchmark, report, trace_events, ffi, wasi, sea | Public runner/diagnostic/native integration requirements, activation, binary artifacts and package/fixture ownership |
| wpt | `test/wpt/testcfg.py` invokes wrapper discovery and returns source/key/id/selector/variant groups via NODE_TEST_WPT. Wrapper file count is not the test denominator. Preserve WPT assertions, resources, serial groups and original skip status |
| pseudo-tty, message | Real PTY helper/input/output patterns and expected-output files; exit-code-only execution is not equivalent |
| addons, js-native-api, node-api, sqlite, embedding | Nested cases and native build artifacts, proper Wasm/native ABI/reference controls, registration/finalization/reentry and embedding lifecycle |
| abort, pummel, internet, system-ca, wasm-allocation, known_issues | Signal/death/resource pressure, external-network/trust-store prerequisites and known-failure classifications; explicit applicability and safe fixture ownership rather than wholesale exclusion |
| doctool, tick-processor, test426, v8-updates, cctest, fuzzers | Classify individual public-API obligations versus Node-specific implementation/tooling/engine tests. Preserve concrete exclusion reasons; do not exclude portable API behavior by category name |
| common, fixtures, nop, overlapped-checker, testpy, tools | Primarily helpers/build/native infrastructure; traverse consumers and nested cases instead of counting every file as an independent public API test |

This is a proposed scope, not a completed applicability adjudication for
every test. Status files and platform branches require individual review.
Direct counts cannot replace the actual launcher/subtest denominator.

## Sequence after review and explicit approval

1. Approve the audit findings, target and API-specific boundary decisions.
   Choose implementation slices and authorize their required targeted
   build/validation work; do not silently lift the full rebuild deferral.
2. Verify that approved targeted artifacts contain the intended source.
   Reproduce the historical Firefox exit-fixture timeout using its exact
   fixture and native control, preserving signal/status/stream logs. A
   source hypothesis is not a diagnosed runtime cause.
3. For a networking slice, run the affected unchanged networking tests and
   relevant lifecycle controls on all four hosts. Prioritize failures from
   those results and persistent earlier failures, as the user requested.
   Do not insert an arbitrary random 500-case sample per host.
4. For each subsequent dependency slice, select tests from the audited API
   obligations, affected owners and persistent failure ledger; run exact
   native controls and each applicable guest host separately. Include
   cleanup/error/abort/negative behavior and expected failing controls.
5. When owning changes and targeted evidence stabilize, collect the full
   applicable expanded upstream coverage on each host with durable case
   accounting. Scheduling/sharding may reduce contention but must not
   replace complete accounting with sampling.
6. Reconcile every public API against source state, actual evidence and
   concrete boundary. Implementation gaps or unexecuted/unsupported cases
   remain nonpassing deviations. No completeness claim until every
   remaining deviation is fixed or supported by an approved concrete
   engine/platform explanation.

## Family controls and coverage obligations

The completed values review adds `values-validation-candidates.json` and an
error-code source-location catalog. Neither catalog establishes executable
case coverage. Include exact Buffer copying versus sharing, inherited
TypedArray overload differences, species/descriptors, numeric aliases,
zero-fill/pool/alignment policy, malformed codecs, assertion diff/options,
public deprecate options, promise/callback delivery, MIME/debounce/throttle
returned objects, path Windows/POSIX/glob behavior, Node URL errors/IDNA/file
bytes/object-URL ownership, type brands/inspection noninterference and
ICU4X/Node ICU data correspondence. Error factories must be tested at the
actual public operation that delivers them, including cleanup and async
ordering; a present code string is not conformance evidence.

Each family report lists proposed upstream and differential requirements.
Collect descriptor/symbol/inheritance/alias/receiver/error controls as
well as normal values. Exercise context/task ordering, mutable inputs,
partial I/O, cancellation, GC, ref/unref, shutdown, worker/port ownership,
and different transport/filesystem/credential branches where relevant.
Do not use embedding-host Node APIs to replace missing guest behavior.

The future candidate catalogs retain 114 native-integration and 225
test/benchmark source identities and declared flags. They are file-level
selection aids, not proof of assertion coverage, fixture availability or
new execution. Include the target VFS-addon regression with its real addon
fixture and --experimental-vfs gate to resolve the documented source/prose
conflict. Preserve source-discovered timer scheduler/AbortSignal cases,
framework failure controls and in-process versus subprocess stream
destruction semantics.

Additional audit catalogs preserve 56 tracing, 33 console, 56 performance
and 21 report file identities. Timer and domain/diagnostics catalogs retain
their own exact flags and source hashes. No cases were executed. These
catalogs supplement the eventual obligation-based selection; file counts
are not assertion coverage or the WPT variant denominator.
The TTY catalog adds 27 unchanged future files with actual pseudo-TTY
launcher and expected-output requirements. The readline/REPL catalog adds
159 future source files, explicitly distinguishing fixture/helpers and
preserving available pseudo-TTY .in/.out hashes. These are selection aids,
not an executable-case or assertion denominator. Full terminal runtime
validation and inherited Socket/stream coverage remain incomplete.

Use native controls for T-013 iterator error/break/close and SIGINT behavior,
T-014 nested additive capture/ALS/listener/domain routing, and T-015 history
validation/error/flush/close. Exercise actual UTF-8/chunked input, terminal
key/escape bytes, writable callback/backpressure, cancellation, transaction
batching, per-session context/eval/await/commands and CLI environment.
No source was executed, no PTY fixture launched and no new runtime
validation ran.

EventEmitter, async context and Event/Abort catalogs add 30, 161 and 44
unchanged future file identities respectively. Include real async-hooks,
message/death/GC/native-owner fixtures and WPT wrapper/variant resources;
none was executed. Compare hook fatal exit callbacks/abort policy and
Promise activation, actual startup/public-resource identity, Event dispatch
state, weak/composite cancellation cleanup and real transfer transport.
Preserve target Event/ALS/resource prose/source disagreements as explicit
native controls, without changing the target or assertions.

The embedding/SEA catalog retains 61 future source identities, including
explicitly labeled C++ fixture sources. That is not a count of executable
test cases. Use the proper native architecture, actual guest admission,
native compile/loop/context/preload/GC fixtures and real SEA builder/VFS/
ZIP/config/signing resources. Compare empty assets/reserved ZIP keys and
C++ no-environment ID behavior to settle NI-013/NI-014, alongside NI-011.
No fixture was compiled, packaged or executed in this audit.

Resolve target prose/source disagreements with explicit native controls:
diagnostics subscriptions added mid-trace; tracing string categories,
empty-union return and backend-dependent output; report endpoint naming;
performance deprecated GC fields and per-iteration option validation.
Include real expected message output, stream errors/NUL/formatting,
histogram shared clone versus independent snapshot, QRDE cleanup,
unreferenced sampling, trace flush and report worker/timeout ownership.

For private V8/ISA/wire-format-specific tests, separate inability to use
that exact artifact from portable public API behavior. Native Node's own
platform/build skips are reference metadata; their applicability to
Kandelo requires a source-backed decision. Preserve disagreements and
unresolved questions, including potential harness defects.

Durable output should include manifests, original case records and raw
stdout/stderr, source/artifact identities, assertion/skip classification,
fixture/native-control provenance, a matrix crosswalk and retry history.
The audit has preserved historical reports in its evidence archive; new
evidence must be collected only after authorization.

The worker catalog adds 638 future source identities, including explicitly
labeled helper/native fixture files. This is not 638 executable cases.
Retain actual GC/clone/transfer/realm/stdio/loader/network/file/addon and
resource fixtures, WPT resources/variants, Flags and Env. Compare independent
concurrent workers, nested loading, startup rollback, readiness versus
online microtasks, message/error/exit ordering, per-worker termination and
already-stopped behavior, actual ref-driven process exit, channel queues,
closed-port validation, detach/host-transfer failure stages, Buffer pool
marks, environment copy/share and arbitrary-thread timeout/ack. Exercise
locks across environments, abort/steal/callback rejection/death and real
CPU/heap/loop/profile state. Settle R-014 with exact native controls while
preserving upstream assertions and all nonpassing statuses. No source
was executed to produce this catalog; new validation requires authorization.

The compression catalog preserves 133 future source identities with
original Flags/Env and explicit helper/native-fixture roles; it is not
133 executed cases or a complete WPT variant/fixture denominator. Include
actual dictionaries/vectors, corrupt/truncated/multimember/skippable/trailing
frames, params/reset/flush and output-cap/info/counter checks. Native
controls must compare fractional numeric options (ZIP-008), constructor
initialization errors (ZIP-009), shared/resizable/detached/leased buffers
and transfer during work (ZIP-007), and actual callback/OOM/GC/exit cleanup.
ZIP-011/012 require post-close guards and early current-entry versus queued
entry disposal controls, alongside real ZIP64/prefix/overlap/timestamp/
encoding/CRC and source/fd/partial-I/O/no-follow fixtures. Exercise actual
normalized iterable source/flush/abort protocols and both Web stream sides,
including intentional shared-chunk rejection and missing remote transfer.
All tests and native controls remain unrun; execution needs authorization.


The crypto catalog adds 530 unchanged future source identities, including
fixture/helper/native/WPT sources; it is not 530 executable cases or a
complete vector/resource/variant closure. Preserve exact provider/FIPS/CLI
configuration, keys and corrupted-format/authentication vectors. Later
native controls must compare NUL/Unicode/input encodings, receiver brands,
aliases/descriptors, typed-array element versus byte offsets, detached/
shared/resizable/foreign storage and zero-size callback timing. Include
65,536/65,537 and larger Urandom reads, truthful missing-CSPRNG failure,
randomInt range 2^48 and UUID options. Retain C-009 allocation/GC/digest
consumption/secret cleanup and C-016 Hmac redigest/getRandomValues/hybrid
KeyObject/X509-option target questions. Native key authority, promise
settlement, async jobs/shutdown and constant-time backend contracts need
real owners; happy-path outputs alone cannot prove them. Execution remains
unauthorized until the completed broad audit is reviewed.


The secure-network catalog adds 886 future unchanged source identities,
including helpers/fixtures/native sources; it is not 886 executable cases
or a complete activation/peer/vector/variant denominator. Collect flagged
DTLS/QUIC native exports and actual build/runtime/permission metadata.
Use controlled local/session UDP/TCP peers and distinguish raw TLS from
browser synthetic HTTPS egress. Compare exact wrapping/overloads/SNI/CA
arrays/stores, certificate/auth/protocol/ALPN/PSK/ticket/OCSP/exporter and
compression behavior; handshake cancellation, ref/timeout, half-close,
partial I/O, native error/OOM/full-table/GC/teardown. DTLS/QUIC add loss/
reorder/corruption/rate/admission/MTU/identity/resumption, real counters/
snapshots, flow credit, QUIC body/writer/drain/reset/0-RTT/path/HTTP3 and
callback/diagnostic/performance owners. Preserve S-014 source/prose
questions for exact native controls rather than changing upstream
assertions. No new control, fixture, test, probe or build ran in this audit.


The network catalog identifies 535 future unchanged sources across upstream
categories, including helper/native fixtures; it is not 535 executable
cases or a completed peer/data/variant/permission closure. Compare exact
native callback/Promise validation and phase, literal/OS/record DNS, named
promisify metadata, per-Resolver config/timeout/cancel/TTL/data and errors.
Use controlled TCP/UDP/IPC peers on local/session/egress routes separately,
with source-backed platform flags, IPv6 scopes and actual host capability.
Exercise fd type/adoption/reuse/transfer, reconnect, unconnected end,
half-close/reset/ref/timeout/family attempts, accepted pause/HWM/options,
live rules/backlog/drop/admission/host registration rollback and real
Nagle/keepalive/TOS/buffer/multicast effects. Preserve N-022 target questions
and the unresolved historical Firefox exit-fixture timeout provenance.
All tests/controls remain unrun; the completed broad audit must be reviewed
before implementation or new runtime evidence is authorized.

The HTTP catalog adds 1,143 future unchanged source identities across
upstream categories, including helpers/native fixtures. This is not an
executed-case or complete peer/resource/subtest/variant denominator.
Use raw controlled peers for fragmented/malformed headers, duplicate and
conflicting framing, HEAD/1xx/final/CONNECT/upgrade/trailers, early response
with pending request writes and idle unsolicited/duplicate input. Compare
non-idempotent stale-pool error behavior without assuming retries are safe.
Check actual public/legacy constructor aliases, returned-object inheritance,
header value types/encodings/descriptors, agent:false/custom agents/TLS
context isolation, abort/close/error/finish/ref and timeout/socket effects.
HTTP/2 needs independent real peers with settings ACK, ping, GOAWAY/RST,
stream/window/memory limits, ALPN, push/trailer and file/fd ownership.
Settings/validators, proxy installation/restoration/lazy classes and XOR
view/immutability/overlap controls also need exact native comparisons.
Record the actual Node raw or browser fetch/local/session route and flags,
crypto/trust/permissions; fetch normalization cannot substitute for a raw
wire peer. Preserve all nonpassing statuses and H-014 native questions.
No HTTP runtime control was executed, and none is authorized by this plan.

The engine catalog adds 569 future unchanged source identities, including
helpers/native fixtures, rather than 569 executed cases or a completed
flag/variant/worker/protocol applicability closure. Compare context identity,
DONT_CONTEXTIFY and globals/accessors/symbols/descriptors/realm brands,
actual option coercion/error phase, Script/native metadata/cache reuse,
code-generation/microtask/import policy and gated VM module requests,
attributes/phase/link/instantiate/TLA/live namespace/error graphs. Deadline
and SIGINT controls must establish actual interruption and cleanup of the
correct scope. Check real accounting/profiling/coverage/snapshot phases,
returned sync/async profile stop/disposal, serializer persistence/transfer/
view spans/aliasing and required interop rather than identical serialization
bytes. Preserve per-format/field boundary questions and profile prose/source
disagreements. Inspector controls require actual callback/Promise sessions,
pending disconnect settlement, notification/native errors, worker/main
routing, gated NetworkResources/DOMStorage and real debugger CLI launch/
attach/probe report/exit/deadline ownership. Native feature flags, inspector
build availability and exact artifact identities must be recorded. No new
engine runtime controls, probes, tests or builds ran or are authorized.

The loading catalog adds 2,139 future unchanged source identities, including
es-module/hook/package/TypeScript/CLI/native/helper resources. It is not an
executed-case count or complete fixture/variant/feature/worker denominator.
Native controls must retain strict wrapper this, Module/require/namespace
identity/descriptors/cache graph/failed compile retry, builtin shadowing,
global/module.paths and URL/directory bases, symlink/query/package identity,
quoted CJS exports and require(esm) cycles/static TLA/interop. Add JSON BOM,
attributes/default-only/shared cache, text feature activation, exact TS
strip/errors/disabled-Wasm behavior, hooks/shortCircuit/deregister/dispose,
SourceMap decoded positions/cache/stack/VFS invalidation and real compile
cache portable/readOnly/flush/exit/worker state. Resolve the target's package-map
duplicate-URL documentation/source disagreement through unchanged/native
controls. Check stdin/check/eval/print/REPL/preload and actual CLI/env/config
consumer effects with original flags/fixtures and child/worker inheritance;
parse acceptance alone is insufficient. Source composition of archived
ModuleLoader plus patches is not compiled/runtime validation. No such
control, new test, probe or build ran or is authorized by this plan.

The stream catalog adds 854 future unchanged source identities, including
helper/native/WPT resources. It is not 854 executable cases or a completed
feature/variant/worker/resource denominator. Compare inheritance/aliases/
descriptors/symbols and unusual subclasses, construct/write/writev/final/
flush/destroy callback ordering and failures, HWM/encoding/Buffer mutations,
async iteration/operators/early return, pipeline/eos cleanup/late terminal/
abort/error/ref behavior, and real fd/stdio/native completion/short writes.
Classic/Web adapters need byte/BYOB/resize/detachment/transfer/port ownership
and cancellation controls rather than assuming unchanged algorithm source
establishes integration. Enable stream/iter for its original flagged
sources; exercise every queue policy/budget/drain/pending end, arbitrary
failure reasons/source-return/cleanup and share/broadcast/duplex lifetime,
sync/async interop and FileHandle owners. Preserve factory namespace versus
returned-object and target tap/disposal questions and exact ICU/encoding
configuration. Full Web class validation remains in the separate web plan.
The 62-factory source correspondence is static evidence only. No new
runtime test, probe or build ran or is authorized by this plan.

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
