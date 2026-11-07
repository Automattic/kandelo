# Standalone HTTP/2 settings source

This source slice provides public `http2.getDefaultSettings`,
`getPackedSettings`, `getUnpackedSettings`, the protocol `constants` object
and the genuine `sensitiveHeaders` symbol. `node:http2` uses the ordinary
builtin-name normalization and the same owner. This is a partial module,
not an implementation of HTTP/2 sessions or transport.

The exact Node26.13.0 core/util source sections provide validation, typed
array input semantics, settings getters and property order, custom settings,
default objects, range/type errors, warning and reentry behavior. Full
source/reference identities live under `sources.json.http2Settings`.

`generate-http2-settings.py` derives numeric constants, strings, descriptors,
default values and settings order from the pinned Node/nghttp2 headers.
It carries nghttp2's known-setting validation switch into the standalone
wire owner. Constants are not a snapshot of an embedding host. The private
Uint32 settings store belongs to the actual synchronous settings helpers;
it does not claim to represent a session's local/remote settings.

Packing captures entries in Node's order, obtains an actual unpooled Buffer
from the existing Buffer allocator, validates nghttp2's known setting
policy, and writes real six-byte big-endian wire entries. Failed nghttp2
validation returns undefined as Node does; no payload is manufactured.
Unpacking retains the unchanged upstream typed-array element semantics and
optional validation. Private captured numeric owners avoid later public
Buffer-method lookup. No native session, provider, stream or handshake is
simulated to supply these helpers.

The source is shared across Node, Chromium, Firefox and WebKit hosts.
Focused controls use real candidate Buffer/error/settings JavaScript over
explicit native memory/type/process boundaries. Production guest and
four-host conformance remain unvalidated. The complete unchanged pinned
settings test runs with the selected actual Buffer/module owners; changing
those dependencies does not establish any session compatibility.

Missing exports remain gaps: connect, createServer, createSecureServer,
performServerHandshake, Http2ServerRequest and Http2ServerResponse. Their
returned session/stream/server types, HPACK, frame I/O, flow control,
settings acknowledgments, ALPN/TLS, header/sensitive-indexing behavior,
server compatibility classes, timers/ref and lifecycle/resource retirement
still require real owning implementations. The exported symbol does not
claim sensitive-header processing by a nonexistent session. None of those
gaps are accepted platform boundaries or passing compatibility.
