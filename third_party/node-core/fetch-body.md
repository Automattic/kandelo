# Fetch Response, Request and Body source slice

`fetch-body-sources.json` records whole unchanged Node v26.13.0 Undici files
and hash-guarded unchanged function sections. The adapter loads the complete
unchanged pinned Response, Request and Body algorithms. Response now owns its genuine private response record, HeadersList
and Body record; the adapter neither copies independent public-field state nor
flattens the transport. Its constructor, error/json/redirect statics, WebIDL
conversions, descriptors, brand checks and clone use that same source. Stream
ownership, locking, disturbance and decoder state stay with the actual stream
graph.

The installed methods are `arrayBuffer`, `bytes`, `text`, `json`, `blob`,
`formData` and `textStream`. They use actual Buffer/UTF-8 conversion,
HeadersList MIME extraction/serialization, multipart parsing, FormData ordered
entries and File/Blob byte owners. Parsed files and text entries use the same
FormData/File constructors as other consumers. The adapter reuses the existing
WebIDL owner instead of constructing a second converter/brand graph.

The pinned consume algorithm deliberately keeps its acquired reader attached
on success, invalid chunks and stream errors. Native controls establish this
observable locking behavior; do not add unconditional reader release as a
cosmetic cleanup change. The source error object and rejected-promise behavior
must propagate through the actual stream. `textStream` uses the genuine
TextDecoderStream and pipeThrough algorithms, including BOM/UTF-8 state.

Request now uses the complete unchanged pinned constructor, WebIDL dictionaries,
private header/body state, URL/method/options validation, follower AbortSignal,
clone and Body mixin. Its BodyInit converters come unchanged from the pinned
Response source. Required token/method/abort/origin/policy utility sections and
fetch constants are hash-guarded against that same archive. The relevant settings
object reads the real guest global Undici-origin symbol; it does not borrow the
outer browser's location or manufacture browser CORS policy.

The complete body extraction algorithm captures actual copied BufferSource
bytes and immutable multipart entry parts, calculates the real encoded length,
uses the shared FormData owner's cached random boundary, and streams genuine
Blob/File parts. A later FormData edit cannot change the already constructed
body. Empty forms, duplicate/escaped names, CRLF normalization, binary files,
content types and final CRLF follow the target source. Request/body clones use
the actual pinned ReadableStreamTee and stream state; no branded stream facade
or payload-flattening substitute is introduced. Response and Request both use
this extraction and genuine stream tee owner.

The existing HTTP consumer constructs the real Request and passes its real
body stream through the existing Readable.fromWeb/pipeline and ClientRequest.
Those owners supply locking, byte validation, backpressure and destruction;
actual extracted length supplies content-length when no framing header was
provided. This removes stringification of Blob/FormData/stream bodies. The
transport is still the current HTTP/TLS implementation, not the full pinned
Fetch controller. Redirect/filter/decompression/cache/scheme/dispatcher/error
policy, subtle early-response/upload/abort cleanup, native/GC/worker lifecycle
and full text-decoder conformance remain open.
They are implementation gaps or unresolved questions, not accepted host limits.

Exact native construction/multipart/loopback differentials and existing focused
component controls are bounded evidence over explicit native stream/codec/event/
clone/HTTP dependencies. They do not prove guest linkage, SpiderMonkey lifecycle
or Node/Chromium/Firefox/WebKit conformance. A bounded late-abort upload probe
also misses its cancellation expectation on native26 and candidate; that nonpass
is preserved as an unresolved target-policy question rather than silently
counted as conformance or blamed on the runtime.

The existing HTTP transport constructs a genuine immutable Response through the
pinned fromInnerResponse/makeResponse owner, retaining its actual extracted
stream, HeadersList and URL list. This integration does not supply the missing
Fetch controller policy. FinalizationRegistry cancellation follows the pinned
owner; its guest GC behavior remains unvalidated. MIME selection now follows the pinned list-splitting/quoted-parameter/charset rules
rather than the previous media-type regular expression. Body methods reject
spoofed Response receivers using the actual private response owner predicate
and shared WebIDL brand check. Public assertions in existing focused controls
remain unchanged; only their declared source-dependency setup is extended.

The unchanged upstream `test/parallel/test-fetch.mjs` passes natively but fails
on the current consumer before its Response checks: the existing `async function
fetch` violates the target's ordinary-function assertion. This remains a Fetch
implementation gap; replacing Response does not close it. Focused Response
controls compare constructor/status/header conversion and error order, static
error/json/redirect, descriptors and private brands, original byte/view ownership,
stream cloning/cancellation, shared Request/FormData owners and immutable HTTP
response publication. Their native dependencies and artifact identities must be
reported separately from guest and four-host conformance.

## Data scheme source owner

The Fetch scheme dispatcher routes `data:` Requests through the unchanged
pinned Undici data URL decoder, MIME serializer, Body extraction, basic
response filter and immutable Response owner. Percent decoding and forgiving
base64 produce actual owned bytes; no HTTP request or host Fetch supplies
the response. HEAD publishes a genuine null body. Other allowed methods
use the data URL body without consuming an unused upload.

The scheme owner cancels a readable request body on abort, rejects before
response publication with the original reason, and reaches the real pinned
stream controller when a response reader or clone owns its lock. The real
stream completion/cancellation path retires both the scheme subscription
and Request follower. Source is shared by all four Kandelo hosts, but the
combined guest and host behavior has not been validated.

Subresource integrity still requires its real hash-policy implementation.
A nonempty integrity option rejects with `ERR_NOT_IMPLEMENTED`; unchecked
bytes are never published as verified. Full Fetch controller/timing,
redirect, HTTP filtering/decompression/cache policy and other schemes remain
implementation gaps. The existing async global function shape also remains
unchanged and fails the previously retained upstream shape assertion.

Seven focused groups use the actual private adapter and current source263
bundle with an explicit component insertion, over native stream, codec,
clone, event and HTTP dependencies. They match seven pinned native26 groups;
the integrity row proves refusal of unchecked bytes, not equivalent SRI
implementation. No normal bundle generation, compiler, guest or browser
execution was used for these component results.

Two cancellation controls after response publication or reader acquisition
pass for the candidate component. The same standalone native26.13.0 controls
exit1 in Undici abortFetch while reading an undefined controller's error
method. These native nonpasses and the initial candidate fixture dependency
failure are retained in `.context/fetch-data-scheme-owner-root/`. They are
not compatibility passes or accepted platform exclusions. This source
implements actual stream ownership rather than copying that failure.

A bounded source review found mutable public stream export lookups in the
first draft. The final factory captures the actual isReadable/finished and
internal require imports before user code, while keeping private stream
module activation lazy. One new candidate-only control replaces both public
exports after factory initialization and proves real completion plus locked
abort still use the original owners. The earlier seven-group source image
and bundle are retained separately; those observations are not relabeled
as a fresh run of the capture correction. No native controls were rerun.
