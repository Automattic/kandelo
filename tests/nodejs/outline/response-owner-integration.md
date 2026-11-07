# Response owner trace

Base: `8494adf1255def68306f637027722dbd13bc08aa`, private detached tree
`.context/agent-worktrees/response-owner`. Target is unchanged Node26.13.0,
source commit18b32a3b1552e199a01f1a8d9fd64aa756d3b75b. This is guest JS
compatibility source; no browser/Node embedding Fetch delegation, native ABI,
kernel, host adapter, transport or package recipe change is introduced.

## Actual pinned owner

All references below are under `third_party/node-core/upstream/fetch-body/`
`deps/undici/src/lib/web/` unless otherwise stated. Files remain byte-identical
to the pinned archive, including assertions.

* `fetch/response.js:28-148`: genuine class private state/headers, static error,
  json, redirect, uncloneability registration, BodyInit/ResponseInit conversion,
  shared HeadersList and `kConstruct` construction. This complete file was
  already vendored and hash-keyed as responseSource but only its BodyInit
  converter section was generated before this slice.
* `fetch/response.js:151-254`: actual metadata/body getters, brand checks,
  locked/disturbed clone rejection, genuine body clone, immutable guard
  propagation and transport-stream finalizer registration.
* `fetch/response.js:277-338`: private owner closures, actual private-field
  brand predicate, Body mixin and public descriptors. No public mutable
  properties or counterfeit `instanceof` predicate establish state.
* `fetch/response.js:341-385`: clone copies actual response metadata/header
  owner and tees the body; makeResponse creates the real internal record.
* `fetch/response.js:386-414`: actual network-error state; status0 is confined
  to the genuine inner record path, not accepted by the public constructor.
* `fetch/response.js:490-568`: status/reason phrase validation, header fill,
  null-body statuses, MIME admission, actual inner-response publication and
  genuine immutable/header-guard/list sharing.
* `fetch/response.js:575-641`: unchanged shared BodyInit and ResponseInit
  converters. Loading Response before Request retains their one shared
  WebIDL converter/brand graph. The older hash-guarded BodyInit section remains
  recorded for provenance; a duplicate abbreviated bodyInit module is removed.
* `fetch/body.js:23-28,41-308`: actual FinalizationRegistry, source byte copying,
  immutable Blob/multipart parts, actual streams and `ReadableStreamTee(stream,
  true)`. Consuming/clone behavior retains the same Body156/Request171 owner;
  the old separate custom Response tee and payload projection are removed.
* `fetch/body.js:310-558`: unchanged body consumption, MIME, multipart parser,
  reader locking/error/disturbance and textStream algorithms.
* `fetch/util.js:105-138,713-720`: exact hash-guarded isErrorLike,
  isValidReasonPhrase, isAborted and isCancelled functions added to existing
  selected utilities. No fake transport controller is created; latter helper
  algorithms remain internal and unused by the present transport.
* `infra/index.js:216`: exact JSON serialization algorithm, already loaded;
  `fetch/data-url.js`: existing exact URLSerializer; `fetch/util.js:1465`:
  existing relevant settings object reads actual guest global Undici origin.

## Shared production dependencies

`fetch-body-platform-adapter.js` returns the existing FormData owner's actual
Headers, WebIDL and core symbols. `formdata-platform-adapter.js:23` registers
actual uncloneable mode0 through the existing guest clone protocol, including
new Response instances. It supplies the real Blob/File/URL/stream brand graph,
not new success predicates. `stream/web.js:50` in the pinned stream owner calls
actual internal `readableStreamTee` with its real clone-for-branch2 option.
Original byte identities, stream roots, locked/disturbed/error/cancel state and
private HeadersList ownership are thus consumed by the unchanged algorithms.

The bootstrap now installs `bodyPlatform.Response` directly. Its existing HTTP
consumer uses `fromInnerResponse(makeResponse(...), 'immutable')`, passing an
actual extracted response stream, genuine HeadersList and actual URL list.
This avoids copying state through user-mutable public fields and permits
correct transport URL serialization/finalizer admission. Consumer-created
Responses retain empty URL lists and do not acquire transport finalizers.
The transient earlier conditional bootstrap globals are unchanged and are
replaced by the genuine constructors before user main executes.

## Remaining implementation and evidence gaps

This does not supply the full Undici Fetch controller, redirect/filter/CORS,
cache/dispatcher/scheme/decompression or abort/upload/early-response policy.
The existing classic HTTP response still uses flowing data listeners rather
than a pull/backpressure-owned Fetch transport. Its async function fetch
wrapper fails the unchanged target's ordinary-function assertion; the exact
native pass/candidate failure is retained in upstream.json and stderr. These
are implementation gaps, not accepted engine/platform boundaries.

Underlying guest text/stream/Blob/URL/Headers/clone/native lifecycle behavior,
realm/Worker transfer, memory/GC finalization and actual four-host conformance
remain unvalidated by this slice. The complete source algorithms are real
implementation progress, not evidence that all dependencies conform. No new
claimed host difference or platform boundary is introduced. Earlier shared
Body/Request late-abort and unrelated immutable capsule nonpasses remain open.


## Current parent integration

Source183 applies narrow authored hunks over182and replaces only fetchBody in
the current manifest, preserving every newer source/metadata owner. The current
combined bundle is regenerated normally. Existing responseSource and all real
dependencies were already declared; no production input/engine patch is added.
The actual complete Response module now owns statics, WebIDL, private body/header
state and clone, shared with Request/Body. Existing HTTP publication supplies
actual immutable response/header/stream/URL records.

Fresh parent controls compare13Response and14unchanged Request groups per native
and candidate, including real loopback publication, original view bytes, actual
tee/clone/cancel and private brands/guards.13existing unchanged Body tests and
14package checks pass. Normal generated bundle/bootstrap/unity/input closure and
unchanged Mozilla include checks pass. These controls explicitly use native
stream/URL/codec/clone/events/HTTP dependencies. They do not execute guest GC,
realm/worker teardown or complete Fetch transport/policy.

The unchanged upstream Fetch native pass/candidate failure remains immutable
historical evidence: line16 rejects the existing async function wrapper before
Response checks. It is not a passing compatibility result. Full pull/backpressure
transport/controller/redirect/filter/CORS/cache/abort/upload/early-response
behavior remains an implementation gap. Earlier late-abort Body evidence is
preserved. No new C/C++/Rust compile or engine/kernel/library/product build,
overall suite or full rebuild ran. Accepted173predates183; no finding/family
closes and all-four-host identified-artifact conformance remains open. Nested
guest Wasm execution stays in scope, scheduled after independent core work.
