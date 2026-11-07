# Fetch Request and Body source slice

`fetch-body-sources.json` records whole unchanged Node v26.13.0 Undici files
and hash-guarded unchanged function sections. The adapter loads the complete pinned Request and Body algorithms and installs
the pinned Body consumption mixin on the existing Response class. The public stream and
header list are projected from that class's private state; the adapter neither
copies an independent body state nor flattens the transport. Stream ownership,
locking, disturbance and decoder state stay with the actual stream graph.

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
or payload-flattening substitute is introduced. Existing Response byte/status/
clone behavior remains its owner; its new FormData branch uses this extraction.

The existing HTTP consumer constructs the real Request and passes its real
body stream through the existing Readable.fromWeb/pipeline and ClientRequest.
Those owners supply locking, byte validation, backpressure and destruction;
actual extracted length supplies content-length when no framing header was
provided. This removes stringification of Blob/FormData/stream bodies. The
transport is still the current HTTP/TLS implementation, not the full pinned
Fetch controller. Redirect/filter/decompression/cache/scheme/dispatcher/error
policy, subtle early-response/upload/abort cleanup, native/GC/worker lifecycle,
Response static constructors and full text-decoder conformance remain open.
They are implementation gaps or unresolved questions, not accepted host limits.

Exact native construction/multipart/loopback differentials and existing focused
component controls are bounded evidence over explicit native stream/codec/event/
clone/HTTP dependencies. They do not prove guest linkage, SpiderMonkey lifecycle
or Node/Chromium/Firefox/WebKit conformance. A bounded late-abort upload probe
also misses its cancellation expectation on native26 and candidate; that nonpass
is preserved as an unresolved target-policy question rather than silently
counted as conformance or blamed on the runtime.

The existing Response constructor/clone/transport stay separate owners. MIME
selection now follows the pinned list-splitting/quoted-parameter/charset rules
rather than the previous media-type regular expression. Body methods reject
spoofed Response receivers using the actual private response owner predicate
and shared WebIDL brand check. Public assertions in existing focused controls
remain unchanged; only their declared source-dependency setup is extended.
