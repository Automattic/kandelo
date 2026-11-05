# Web globals, Web Streams and Fetch contracts

Source review: **complete with gaps** for the web family's 548 original
obligations and the additional source-exposed contracts below. This is an
audit disposition, not implementation completeness or runtime conformance.
No runtime tests, probes, builds or implementation changes are authorized.
The exact target remains Node 26.13.0, commit
`18b32a3b1552e199a01f1a8d9fd64aa756d3b75b`; see [pin verification](target-pins.md).

The requirements ledger preserves all 390 documentation sections (103
globals, 109 Web Streams, 178 Web Crypto) and 158 native descriptor
observations. Earlier crypto, Event/Abort, compression and consumer reviews
remain valid scoped source reviews; completion here does not replace their
findings. Source declarations and explicit returned/inherited/global
contracts supplement the discovery inventory. Counts are obligations and
observations, not unique APIs. Future-source selection is not a test denominator.

## Ownership and exposure

All four hosts execute these globals inside the guest SpiderMonkey realm.
The embedding Node/browser's Headers, stream, navigator or storage objects
are not guest implementations. Bootstrap installs the actual shared Node
Web Stream constructors at 3264–3283 and 6690–6700, then Fetch captures those
constructors at 7033–7035. The original web-streams-polyfill bundle remains
in the source but is superseded in this production path. The existing
[stream correspondence record](streams-source-correspondence.json) checks
61 full factory files and one declared unchanged adapter excerpt against
the exact source pin and the checked-in generated factory strings. This
is source correspondence, not proof of correctly compiled or executed bytes.

Target exposure owners are `lib/internal/bootstrap/web/exposed-wildcard.js`,
`exposed-window-or-worker.js` and `internal/process/pre_execution.js:430–501`.
Candidate `_installNodeGlobalScope`, bootstrap:7390–7448, supplies operation
versus constructor enumerability, replaceable attributes and global tag.
This is real descriptor installation; it does not implement absent APIs.
File modules delete global CommonJS wrapper names and receive lexical
arguments. Eval/REPL retain corresponding bindings; loading-family findings
still apply to wrappers, entry points and realm/global property forwarding.

| Target surface | Source disposition and prerequisite |
|---|---|
| Event, EventTarget, CustomEvent, AbortController/Signal, DOMException and QuotaExceededError | Actual pinned algorithms/private state and native scheduler/clone hooks; see A-027–A-030 and event-target-abort-contracts.md. Native error/clock/ref/transfer consumers remain requirements. |
| Timers, queueMicrotask, Buffer/atob/btoa, process, console, performance, structuredClone | Same actual module/global owners, independently audited async/values/process/observability/worker families. Global presence does not establish inherited, byte, fatal-error or scheduling behavior. |
| URL, URLSearchParams | Same whatwg-url 14.2.0 constructors as node:url; live query-list linkage, getters/setters, overload conversion, iteration and parser exist. Independent parser/Unicode tables require exact-target reconciliation; Node object-URL registry and URLPattern are missing. Full node:url/path requirements remain values-family scope. |
| TextEncoder/Decoder and their stream wrappers | Fallback encoders have real state and byte conversion; selected guest source provides no shell TextEncoder/Decoder definition. Four encoding groups are not the target ICU encoding set. Source branch selection is not runtime evidence. |
| Blob | Custom private owned-byte/clone/stream implementation; not the target native backing store, file-backed Blob owner or object-URL registry. |
| File, FormData | Final fallback classes are empty, bootstrap:6837–6838. File must extend Blob with name/lastModified and cloning; FormData requires ordered duplicate entries, File/string conversion, iteration and multipart handling. |
| Headers, Request, Response, fetch | Final custom classes/transport, bootstrap:6991–7367; earlier placeholder definitions are superseded and are not final support. WEB-002–005/009 apply. |
| MessagePort, MessageChannel, BroadcastChannel | Global MessagePort correctly rejects direct construction, but channel constructors throw ERR_NOT_IMPLEMENTED. There is no entangled transport, named broadcast group or ref/lifecycle ownership. Worker module facades are separately incomplete. |
| MessageEvent, CloseEvent, ErrorEvent | Candidate subclasses Event but copies a few public properties; target Undici classes require dictionary conversion, receiver brands, readonly prototype getters, message origin/source/ports and event fields. WEB-011. |
| WebSocket, Navigator/navigator, URLPattern | Normally exposed target globals; absent candidate guest interfaces. The npm ws throwing facade is not the global WebSocket. Navigator requires branded hardware/locale/platform/userAgent getters and actual locks, not outer-browser values. |
| EventSource | Target deleted unless --experimental-eventsource. Absence in normal unflagged mode is correct; enabled implementation/options are missing. |
| Worker and worker-global interfaces | Target deleted unless --experimental-web-worker. Enabled Web Worker is an EventTarget owner backed by node:worker_threads, with Node-specific local file/data/blob script policy, terminate returning undefined, actual messaging/ref ownership. Candidate module Worker is a different API and does not provide this global. |
| Storage, localStorage, sessionStorage | Target installed under --experimental-webstorage, subject to embedder policy; localStorage enumerability depends on --localstorage-file. Enabled implementation, quota, persistence/session ownership and ordered named properties are missing. Outer-browser origin storage is not an automatic substitute. |
| Crypto, CryptoKey, SubtleCrypto/crypto | See complete crypto source review. An ordinary object with two random methods is not the branded namespace/subtle/key implementation. Missing OpenSSL build capability must be distinguished from missing public integration. |
| WebAssembly | Guest engine/recipe capability, not embedding host WebAssembly. See engine-contracts.md and engine-source-evidence.json for concrete no-JIT/interpreter constraints and streaming implementation dependencies; do not call an unimplemented guest Fetch/Response bridge a browser boundary. |

`--no-experimental-websocket` also removes CloseEvent in the target;
`--no-experimental-global-navigator` removes Navigator exposure. Candidate
has no equivalent full activation policy. An absent disabled experimental
API is not an ordinary-mode failure; missing enablement remains a gap.

## Web Stream public and returned owners

`node:stream/web` exports 18 constructors/helpers, including the Node-specific
`ReadableStreamTee`. The 17 standard interfaces share global constructor
identity; `ReadableStreamTee` is a module helper, not a target global.
The classes use real copied state machines, not placeholder wrappers:

| Owner | Required and traced source behavior |
|---|---|
| ReadableStream | Strategy property access precedes source type/setup; default versus byte controller/HWM, start/pull/cancel receiver, actual queue/demand/disturbance/lock/error/close states. cancel returns rejected promises on receiver/lock errors; getReader/pipeThrough/tee/values have synchronous validation where specified. pipeTo captures validation as rejection. from consumes actual sync/async iterators. |
| DefaultReader and BYOBReader | Actual exclusive stream lock, pending read/closed records, cancel/release behavior and released-owner rejection. BYOB read validates actual DataView/TypedArray span, nonzero attached regular backing buffer, minimum element count and byte alignment. SharedArrayBuffer-backed BYOB views are rejected by target source; that rejection is not a compatibility gap. |
| DefaultController, ByteController, BYOBRequest | Illegal public construction, real desiredSize/enqueue/close/error and pull-into/auto-allocation state. BYOB respond/respondWithNewView checks live request, backing-store/range/detachment, invalidates views and completes pending reads. These are returned owner interfaces, not freely constructible public instances. |
| ReadableStream values iterator | values and Symbol.asyncIterator are identical callables in the target descriptor table. Real serialized next/return, stream reader release, preventCancel and source cancellation, rather than only a syntactic async iterator. Returned iterator methods are requirements even without own module exports. |
| WritableStream and DefaultWriter | Real exclusive writer, queued/in-flight writes, desiredSize/ready/closed records, close/error/abort ordering, pending abort state, sink callbacks and release. Writer ready/closed and operations reject according to ownership; controller signal/error refer to actual abort/stream state. |
| TransformStream and DefaultController | Real connected readable/writable sides, independent default HWM 0/1, start/transform/flush receiver and asynchronous results, backpressure promise, enqueue/error/terminate and two-side cleanup. Side getters, controller desiredSize and illegal construction/brands are required. |
| Queuing strategies | Required init.highWaterMark conversion, deferred validation when used, stable shared size callable identity, readonly branded private-state getters and correct name/tag/enumerability. |
| Encoding streams | Actual TransformStream owners, pending high-surrogate carry/flush in encoder and streaming decode/BOM/fatal/flush in decoder. Correct copied wrappers still inherit fallback encoder repertoire and byte/async dependencies. |
| Compression/decompression | Actual codecs and stream ownership; compression-family native zlib lifecycle/limits/errors and format coverage remain requirements. |
| Transfer and tee | Transfer invokes actual private protocol and cross-realm ports; candidate channel dependency throws. Default tee preserves chunk identity unless cloneForBranch2; byte tee copies independent byte spans. The module helper validates boolean clone flag and uses the real structured-clone owner, whose host-object movement remains incomplete. |

Sources: `third_party/node-core/upstream/streams/internal/webstreams/`:
readablestream.js:246–590,597–1358,1575–1937,1938–2350,2675–2759;
writablestream.js:181–755,967–1100; transformstream.js:126–350,612–710;
queuingstrategies.js:51–154; encoding.js:43–230; util.js:69–155.
The requirements ledger records additional exact method declarations and
native captured descriptors, including prototype/tag/inspect/symbol paths.
Private transfer hooks found by discovery are classified as dependencies,
not invented own public constructor exports.

Trace through the injected platform matters: stream-platform-adapter.js
supplies errors/validators, real Event/Abort/async context, Buffer/Blob,
TextEncoder/Decoder, Promise state and handledness, byte copies and transfer
protocol. Native promise details and handledness use actual engine APIs
(js.cpp:3182–3206,3466–3484). Byte helpers use captured intrinsic span getters;
copyArrayBuffer checks regular attached buffers/ranges in the copied caller.
Ports remain unavailable. Stream scheduling ultimately uses guest native
jobs, reference ownership and host worker waits. STR-001–011 and the
async/worker/value findings apply; copying algorithms alone cannot close them.

## Concrete findings

Earlier W-001 and WEB-002–008 are retained with clarified scope here.

| ID | Source-backed gap or question | Owning layer/dependency |
|---|---|---|
| W-001 | File/FormData are empty classes; Crypto/subtle/key integration missing. Constructors need complete public/returned/inherited methods and WebIDL/brand descriptors, not successful empty allocation. | Web values/crypto/clone, multipart encoder/parser and file-byte owners |
| WEB-002 | FetchHeaders public _map, lowercasing without token/CRLF/ByteString validation or whitespace normalization, insertion-order Map iteration, unconditional comma append, no getSetCookie or immutable guards, different tags/brands/enumerability. Target Undici:12390–12782 separates cookie handling and guarded sorted entries. | WebIDL/converters/header-list representation; HTTP validation does not replace Headers validation |
| WEB-003 | Request copies url/method/headers/body/signal as mutable own fields, without complete defaults, URL/credential validation, inherited Body mixin, clone or bodyUsed, stream duplex/keepalive, redirect/cache/mode/referrer/integrity/dispatcher and follower AbortSignal ownership. Fetch accepts only strings or .url, so direct URL input is not normalized via its string conversion. | Request/body ownership, URL/WebIDL, abort and actual transport |
| WEB-004 | Response has real private state, status conversion/range and null-body checks, owned bytes, lock/disturbance checks, async consumption and clone; missing formData and static error/json/redirect, incomplete MIME extraction and guarded headers. Target exact native error class/descriptor/conversion order still needs later differential evidence; do not report existing status checks as absent. | Body/MIME/multipart/header/byte/clone/stream integration |
| WEB-005 | fetch routes non-https schemes to custom HTTP, ignores most RequestInit/dispatcher policy, stringifies Blob/FormData/ReadableStream/DataView rather than actual body extraction and does not implement redirect/response filtering/content decoding and complete request validation. Native Node Fetch behavior, including Node-specific dispatcher and allowed server-side headers, is the reference; browser CORS behavior is not substituted. | HTTP/TLS/socket/DNS, URL, encoding/body extraction, Fetch policy |
| WEB-006 | Actual graph clone and Blob clone hooks exist; host-object transfers and entangled channel/broadcast delivery remain missing. Web Stream transfer calls the unavailable channel constructor; worker facades do not repair it. | Native clone, guest worker/message transport, scheduler/ref/GC lifetime |
| WEB-007 | URLPattern, normal Navigator/WebSocket exposure and enabled EventSource/Web Worker/Web Storage support missing. Exact activation branches above prevent misclassifying normal disabled absence; limits of host raw sockets do not excuse local interfaces or parsers. | Global exposure/options plus actual worker/storage/network implementations |
| WEB-008 | Decoder has only UTF-8, UTF-16LE/BE and windows-1252 groups, despite real split/BOM/fatal state. Blob copies owned bytes and streams them, but raw SharedArrayBuffer is not recognized by copyBytes and falls through string conversion whereas target internal/blob.js:117–132 accepts any ArrayBuffer. URL's independent Unicode/parser tables and missing object registry need values controls. | Encoding tables/converters, actual buffer brands, Blob, URL/registry |
| WEB-009 | Response transport start registers flowing res data listeners and enqueues regardless desiredSize, with no pull-driven pause/resume; cancellation destroys the source but demand does not propagate. Body consume loop retains reader without finally/release on chunk/read failure; exact target observable cleanup requires native controls. HTTP pool release/terminal owner findings remain separate dependencies. | Fetch-to-classic stream adapter, backpressure, errors and native resource lifetime |
| WEB-010 | atob/btoa fallback operates on supplied .length/.replace/.charCodeAt without required string conversion/argument policy; zero-filled decode table accepts invalid characters and does not implement forgiving-base64 whitespace/length validation. btoa does not reject non-Latin-1 code units. Final Buffer exports capture these functions at bootstrap:1367, so module/global identity also shares the gap. | Values/base64 byte conversion and correct DOMException errors |
| WEB-011 | MessageEvent/CloseEvent/ErrorEvent copy public own fields at bootstrap:6874–6888, missing readonly branded getters, complete dictionaries and target event properties. Event inheritance is real; it is insufficient for event-specific conversion/descriptor correctness. | WebIDL and actual message/websocket/error event owners |
| WEB-012 | Candidate recipe explicitly enables --with-intl-api and ICU4X (build-spidermonkey.sh:291–292). The fallback Intl object at bootstrap:6895 only applies if Intl is absent. Its per-codepoint segmentation/formatting is insufficient, but this is not evidence that the configured candidate executes that fallback. Locale/table/ICU4X coverage and any API differences require explicit evidence; no engine defect is established. | Engine ECMA-402/data capability, source branch and artifact identity |

Blob.slice uses clamp/ties-to-even conversion, matching the target's
WebIDL long-long clamp policy; do not invent a truncation requirement.
Response.clone has an actual tee/clone graph, including cloned default
chunks and byte branches. Its extra paired-stream implementation must be
validated for cancellation/error/queue/lifetime equivalence; it is not
correctly described as an absent clone or proven double-copy defect.

## Hosts, boundaries, evidence and future controls

Node, Chromium, Firefox and WebKit share the reviewed guest source. Their
configured egress, proxy/CORS, local virtual socket routes, persistence,
worker and teardown paths differ; see network/HTTP/worker host ledgers.
An external destination blocked by a browser-origin/service policy can be
a concrete boundary for that route. Missing Headers, parsing, ports,
backpressure, storage or enabled local Worker behavior is an implementation
gap. Do not import the browser's fingerprint/platform identity into the guest.

Historical baseline/selected reports retain exact source/artifact identities
in existing-evidence.md and the unchanged archive/index. Most baseline
failures stop at common/index's missing net accessor; they do not exercise
the named Web API. Older controls sometimes select the retained ponyfill.
No historical run establishes current shared Node Web Stream/Fetch source
conformance. The current candidate remains unbuilt and unvalidated on all
four hosts; timeout/harness/unsupported/skipped outcomes are not passes.

Later validation requires explicit authorization. Use unchanged exact-pin
Node tests and its WPT harness/resources, with feature flags and fixture
servers preserved, across ordinary and enabled experimental modes. The
future catalog includes helpers/resources and is a selection aid only.
Use native 26.13.0 controls for descriptors/inherited methods/symbol aliases,
throw versus reject and microtask order, encodings/BOM/split/fatal input,
Unicode URLs/query mutation, base64 invalid/coercible input, Blob/Shared
buffers/clone isolation, BYOB/detachment/min, iterator cleanup, writer
backpressure, tee cancellation/clone failures, ports/worker termination,
Fetch dispatcher/redirect/decompression/headers/cookies/streamed and
multipart bodies, abort before/after headers and network resource cleanup.
Record actual source/compiled/rootfs/host/browser/feature/backend identities
and preserve every nonpassing or unavailable harness/resource outcome.

Unresolved questions are explicit: exact conversion/descriptor/error ordering
at custom interfaces; paired Response clone cancellation/reader cleanup;
actual selected encoder/ICU data coverage; URL Unicode/native registry and
file-backed Blob integration; feature-gated storage/worker platform state;
engine backing-store/GC/clone/ref timing; and all four current-host runtime
results. These questions do not block finishing the broad source audit and
do not authorize new probes or executing the roadmap.
