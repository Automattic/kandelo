# Fetch Body consumption slice

`fetch-body-sources.json` records whole unchanged Node v26.13.0 Undici files
and hash-guarded unchanged function sections. The adapter installs the pinned
Body consumption mixin on the existing Response class. The public stream and
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

This does not implement Request's Body ownership, multipart BodyInit encoding,
Response static constructors, Fetch request extraction, redirect/filter/cache
policy, socket/DNS/HTTP/TLS transport/backpressure, clone/worker transfer or the
full target text-decoder repertoire. These remain implementation gaps, not
accepted engine or host boundaries. Parser source presence is not proof of
all target Buffer or WebIDL behavior. Source projections using native stream,
UTF-8 and clone-policy dependencies are focused component evidence, not proof
of guest linkage, SpiderMonkey lifecycle or four-host conformance.

The existing Response constructor/clone/transport stay separate owners. MIME
selection now follows the pinned list-splitting/quoted-parameter/charset rules
rather than the previous media-type regular expression. Body methods reject
spoofed Response receivers using the actual private response owner predicate
and shared WebIDL brand check. Public assertions in existing focused controls
remain unchanged; only their declared source-dependency setup is extended.
