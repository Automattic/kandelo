# Public Node.js core compatibility audit

This is the audit deliverable for Node 26.13.0 across the Node, Chromium,
Firefox and WebKit hosts. All 19 families have broad source reviews with
concrete gaps and explicit unresolved questions. This completes the source
audit phase only. Kandelo does not yet have complete Node core compatibility,
and the current source candidate has no four-host runtime validation.

Only audit documentation and metadata were changed during this phase.
No implementation, test assertions, target/package/build configuration or
engine patches were changed. No new runtime tests, probes, compilations,
package builds or full product rebuilds were run. The existing dirty runtime
candidate, unrelated local work and separate Claude/npm/Bun remainder remain
outside the audit changes. No merge, deployment or implementation publication
is authorized. The full product rebuild deferral remains in effect.

## Target and independent status dimensions

[Official-source research and pin correspondence](target-pins.md) record
Node **26.13.0, Lithium LTS**, release October 28, 2026, source commit
`18b32a3b1552e199a01f1a8d9fd64aa756d3b75b`. The official release index,
release/commit and checksum records agreed with the existing target at the
recorded research date. No target pin was silently changed. Source archive,
extracted tree and the saved native Darwin arm64 reference executable have
explicit identities; the other platform archive checksums are recorded
without claiming those executables were run. Development-shell Node 24 is
tooling, not the native target/reference control.

| Dimension | Audit result | What it does not establish |
|---|---|---|
| Inventory | All 11,199 original discovery obligations retained, source/applicability reviewed and linked; source declarations, returned/inherited/symbol/conditional contracts supplement the shallow capture | A count of unique public APIs or every possible test case |
| Source review | All 19 families and 74 scoped modules reviewed through actual owners; concrete gaps and questions retained | Correctness merely because an export or copied source exists |
| Implementation | Many missing, inert, partial and semantically different owners remain | Complete Node compatibility |
| Runtime conformance | Historical artifact-specific evidence preserved; current unbuilt candidate pending on all four hosts | A current pass, a diagnosed Firefox timeout cause or four-host equivalence |

The matrix contains **13,292 observations**, including documentation and
private/incidental provenance. Two original private/incidental captures are
resolved as such; they are not passing compatibility. Row IDs and original
capture descriptors remain stable. The final 175 previously unlinked
obligations now have explicit links: 174 documentation/narrative contracts
and one incidental private cache-key capture. Linking a narrative does not
manufacture a callable module export.

The authoritative machine-readable records are [api-matrix.json](api-matrix.json),
[obligation-crosswalk-summary.json](obligation-crosswalk-summary.json),
[obligation-crosswalk.jsonl](obligation-crosswalk.jsonl),
[module-reviews.json](module-reviews.json) and [state.json](state.json).
Requirement artifacts retain exact documentation sections, source locations,
descriptors, identities and limitations. Scope applies to public aliases,
inherited/returned methods, symbols, descriptors, overloads, validation,
errors, async delivery, resource ownership and lifecycle—not just exports.

## Family-by-family findings

Every row below is source-reviewed with gaps. None is a current runtime pass.
Detailed reports contain exact source references and associated requirements
and future unchanged-source catalogs.

| Family | Actual owners and principal remaining gaps | Detailed source audit |
|---|---|---|
| Values | Real pinned assertions/comparisons/inspection/path/numeric Buffer and native unpooled storage; custom Buffer conversion/codecs/search/fill/species/pool policy, assertion diagnostics, missing util helpers, miswired deprecate options, Node URL wrappers/ownership and ICU correspondence | [Values contracts](values-contracts.md), scoped query/codecs/legacy/StringDecoder reports |
| Async | Actual native job/context/resource/hooks plus copied event/timer algorithms; remaining exception/rejection/warning/signal policy, event/static helper semantics, domain and diagnostics ownership gaps | [Async context](async-context-contracts.md), [EventEmitter](event-emitter-contracts.md), [EventTarget/Abort](event-target-abort-contracts.md), [timers](timer-contracts.md), [domain/diagnostics](domain-diagnostics-contracts.md) |
| Streams | Actual classic/promise/consumer/iterable algorithms and source-selected Web Streams; byte/Buffer/stdio owners, ports/transfer, adapter/error/ref/cleanup dependencies remain | [Stream contracts](streams-contracts.md), [Web contracts](web-contracts.md) |
| Filesystem | Real selected native fd I/O, callbacks, promises, FileHandle/Stats/read jobs and stream ownership; legacy pathname/recursive/watch/directory gaps, raw invalid-UTF8 host path conversion, lease restrictions, mounted metadata behavior and absent enabled public Node VFS | [Filesystem contracts](filesystem-contracts.md), selected-source correspondence and raw-path evidence |
| Processes | Actual guest process/native spawn/sync controller; fixed ppid/umask/usage and OS metadata, env mutation/enumeration/inheritance, signal/exit/error policy, ChildProcess.kill/stdio/IPC/exec options, cluster and permissions remain incomplete | [Process contracts](process-contracts.md) |
| Network | Real Socket/Server/native/libc/kernel/NetworkIO routes; bind/listen/accept and resource controls need exact capability/host validation, DNS resolve/Resolver remains incomplete/fabricated and dgram lacks a public owner | [Network contracts](network-contracts.md) |
| HTTP | Custom client/parser and private protocol pools; public Agent/server/HEAD/1xx/CONNECT/upgrade behavior, framing/headers, stale retry and idle socket ownership, HTTPS exports and HTTP/2 missing or partial | [HTTP contracts](http-contracts.md) |
| Secure network | Actual libssl client transport; trust/identity/authorization/session/configuration/metadata/server gaps, DTLS and QUIC public/protocol owners missing | [Secure-network contracts](secure-network-contracts.md) |
| Crypto | Native hashes/HMAC/entropy exist; byte/string boundaries, quotas/async contracts and key/KDF/cipher/signature/certificate/WebCrypto owners incomplete or absent | [Crypto contracts](crypto-contracts.md) |
| Web | Real shared Node Web Streams/URL, custom Blob/Response/fetch; File/FormData/message/URLPattern and several gated features missing, Headers/Request/body/Fetch policy/codec/transfer semantics partial | [Web contracts](web-contracts.md) |
| Loading | Shared builtin policy plus real engine module/CJS loading; receiver/cache/JSON/import metadata/package/loader hooks/TypeScript/CLI/source maps, activation and source/documentation conflicts remain | [Loading contracts](loading-contracts.md), native base/patch evidence |
| Terminal | Descriptor/stream/PTTY foundations differ from complete tty/readline/REPL behavior; placeholder question/input/editing/history/session APIs and ownership remain | [TTY](tty-contracts.md), [readline/REPL](readline-repl-contracts.md) |
| Workers | Actual shell worker/clone primitives; public message ports/worker transport, environment/IPC/resource ownership/termination and transferred native handles incomplete | [Worker contracts](worker-contracts.md) |
| Compression | Real pinned codec/ZIP/iterator algorithms and native work/codec state; exact mode/options/byte/flush/error/cancel/GC/file/stream ownership and activation dependencies remain | [Compression contracts](compression-contracts.md) |
| Observability | Some actual console/performance state coexists with no-ops/fixed measurements; reports, histograms, observers, tracing, lifecycle and backend instrumentation incomplete | [Console](console-contracts.md), [performance](performance-contracts.md), [tracing](trace-events-contracts.md), [reports](diagnostic-report-contracts.md) |
| Engine | Real realms/stencils/native inspection/Debugger; VM timeout/context/codegen/cache/module behavior, public inspector promise bridge, profiling/heap metadata and V8-specific formats absent or partial | [Engine contracts](engine-contracts.md) |
| Testing | Public test/benchmark runner, reporters, hooks/mocks/coverage/isolation/CLI require real owners; no public factories establish support today | [Testing contracts](testing-public-contracts.md) |
| Native integration | FFI/SQLite/WASI/SEA and addon/embedding requirements traced to lower libraries, ABI, loader, memory and artifacts; public bridges largely missing; direct V8 and CPU-native binaries have concrete architectural boundaries | [Native public contracts](native-public-contracts.md), [Node-API/addons](native-addon-contracts.md), [embedding/SEA](native-packaging-embedding-contracts.md) |
| Documentation | Synopsis/narrative/deprecation/conditional/history contracts reconciled; removed util predicates, warning/activation mismatches and target source/prose questions retained without treating deprecated as excluded | [Documentation contracts](documentation-contracts.md) |

## Shared prerequisites and four-host interpretation

All four hosts execute the guest SpiderMonkey compatibility implementation.
An outer browser's or host Node's native API does not automatically implement
the corresponding guest API. Pure value algorithms have shared source paths;
that is a source inference, not a four-host result. Scheduling, host-backed
filesystems, networking, worker/transport services and resource limits enter
through concrete adapters and remain distinct per-host validation obligations.

The [dependency roadmap](roadmap.md) orders future work around actual owners:

1. Correct shared state, bytes/encoding/Buffer, errors/errno/diagnostics,
   scheduler/events/async identity and native fd/backing-store lifetime.
2. Complete transport/DNS, filesystem/metadata/raw paths, process/worker/IPC
   and module-loading prerequisites in focused units.
3. Complete HTTP/TLS/crypto, web/body/transfer and codec/ZIP consumers using
   those shared owners.
4. Complete terminal, observability, VM/debugger, test tooling and native
   integration; then resolve protocol-specific and remaining API deviations.

Wrong-success behavior and resource ownership deserve early priority:
fabricated DNS/OS metadata, silently ignored metadata operations, synthetic
successful wait status, malformed byte conversion, stale HTTP retries,
environment divergence and security-context/authorization mistakes. Preserve
the real lower-level implementations already present; do not replace them
with facade fixes or Claude-specific branches. PR boundaries and dependencies
are proposed in the roadmap, not authorized by this audit.

Concrete boundaries include CPU-native/V8 binary and snapshot formats,
wasm/engine memory ceilings, selected host service/transport capabilities and
specific filesystem backend facilities. They apply to the exact operation
and artifact described in the report. They do not excuse missing portable
JS APIs, absent guest kernel/native bridges or current OPFS implementation
no-ops. Shared/resizable buffer rejection and absent TCP/permission/worker
bridges remain implementation gaps unless a concrete boundary is separately
established. A missing flag-enabled API is distinct from valid unflagged
absence. No blanket browser, V8, POSIX or Intl exclusion is accepted.

## Existing evidence and proposed validation

The historical archive/index identities and original statuses are preserved
in [existing evidence](existing-evidence.md) and its JSON/index artifacts.
For each host, the completed initial selection finalized 5,147 cases:
**3 pass, 3,721 fail and 1,423 unsupported**, with zero upstream skips,
timeouts or harness errors in that particular baseline. Of its failures,
3,687 per host stop at a common net accessor before test-specific assertions.
These are preserved failures, not thousands of independently diagnosed APIs.
Other selected/incomplete runs retain their own failures, timeouts, harness
errors and pending cases; they are not combined into an artificial pass rate.
The historical Firefox exit-fixture timeout remains unresolved for the
current candidate. No new source review turned it into an engine boundary.

The [subsequent validation plan](validation-plan.md) requires explicit
authorization. It preserves unchanged pinned upstream assertions, source and
native reference controls, flags/environment/fixture identities and per-host
case accounting. Coverage expands beyond parallel/sequential to relevant
WPT, module/async/test-runner, PTY/message, native-addon/Node-API/embedding,
WASI/FFI/SEA/SQLite, diagnostics and resource/protocol suites. Future catalogs
record file identities and selection limits; they are not executable
case/subtest/variant denominators or completed applicability adjudication.

Start with approved targeted artifact identity and the Firefox fixture,
affected networking tests and persistent earlier failures, as previously
requested. Do not insert a random 500-case sample per host. Native controls
must cover errors, aliases/descriptors/receivers, overload/coercion effects,
async/abort/cleanup order, GC/storage/transfer/ref ownership, negative cases
and concrete host/backend branches. Full expanded coverage follows stable
owners and explicit approval; the full rebuild deferral is not implicitly
lifted by this plan.

## Open audit questions and stopping point

The source audit identifies ownership and definite gaps, but does not claim
every private execution path is proven. Explicit unresolved questions remain
in family requirements and matrix rows: exact descriptor/error/overload order;
native GC/cancellation/fd races and iterator preview; ICU4X locale/data and
Node ICU option correspondence; source-map/stack/expression bridges; enabled
feature and historical API applicability; documented VFS promise-open and
other source/prose conflicts; exact host capability/artifact identity; and
the complete future fixture/flag/subtest closure. Factory or text occurrence
is not proof that a required public error is delivered correctly.

These questions are part of the audit result, not passing compatibility.
The audit stops for review after its static identity/crosswalk checks.
**Explicit user authorization is required before any implementation or new
runtime validation. Completing this audit does not authorize the roadmap.**
