# HTTP public and returned-object contracts

State: **source review complete with implementation gaps**, covering
`node:http`, `node:https`, `node:http2` and the six discoverable legacy
`_http_*` modules. This is a requirements/implementation/layer review,
not runtime conformance. No runtime tests, probes, compilations or builds
ran. The earlier [HTTP layer report](http.md) remains part of the record.

`http-requirements.json` preserves all **1,084** original obligations:
397 documentation sections and 687 saved descriptor observations. It adds
returned HTTP/2 session/stream/server members and inherited-owner contracts
that descriptor traversal missed. These numbers count discovery/review
records, not unique public APIs or passing behavior. Source completion
includes negative findings for absent owners; it does not certify every
algorithm in Node's native parser or nghttp2.

## Exact owners, exports and aliases

The unchanged target is Node **26.13.0**, source commit
`18b32a3b1552e199a01f1a8d9fd64aa756d3b75b`; see
[official pin verification](target-pins.md). Requirements come from that
source, not remembered Node 24 behavior.

Candidate `packages/registry/node-compat/bootstrap.js:4995–5710` contains
the shared custom HTTP/1 response parser and separate HTTP/HTTPS client
factories. `makeIncomingMessage:5254–5274` constructs an ordinary
`stream.Readable`, while `ClientRequest:5352` extends `Writable`.
Those supply real stream operations; they do not establish target class
identity, inheritance, socket ownership or HTTP-specific behavior.

Target `lib/http.js:262–340` exports the actual Agent, ClientRequest,
IncomingMessage, OutgoingMessage, Server and ServerResponse constructors,
factories, validators, methods/status tables, parser configuration and new
proxy/WebSocket helpers. `maxHeaderSize`, `globalAgent`, WebSocket,
CloseEvent and MessageEvent have accessor descriptors. Agent is shared
with `_http_agent`, ClientRequest with `_http_client`, IncomingMessage
with `_http_incoming`, OutgoingMessage with `_http_outgoing`, and server
constructors/status codes with `_http_server`; alias identity matters.

Target `lib/https.js` exports only **Agent, globalAgent, Server,
createServer, get and request**. Its Agent inherits HTTP Agent and its
Server inherits TLS Server while implementing HTTP server behavior.
HTTPS request returns the actual HTTP ClientRequest; responses are HTTP
IncomingMessage instances. HTTPS does **not** have its own public
IncomingMessage, ClientRequest, OutgoingMessage or ServerResponse exports.
Earlier matrix labels for these are retained as grouped returned/inherited
contracts linked to the actual HTTP owner. Candidate HTTPS exports an
extra independently created ClientRequest and methods/status tables;
neither extra fields nor returned Readables prove target identity.

Target OutgoingMessage extends legacy Stream, not Writable
(`_http_outgoing.js:127–197`); ClientRequest/ServerResponse inherit it.
IncomingMessage extends Readable (`_http_incoming.js:58–106`). Generic
Writable behavior cannot substitute for HTTP buffering/framing, finish,
drain, cork, byte-length, sent-header and socket state. Inherited EventEmitter,
Readable, Stream, net.Server, tls.Server and Agent members remain real
requirements with the corresponding completed or still-open family
dependencies. Symbol rejection, disposal, abort and inspection members,
constructor/prototype links, method return values and lazy/global setters
are separate observable contracts.

`_http_common` exposes the target parser/checkers/regexes/CRLF/methods/pool
and parser symbols; `_http_outgoing` also exposes validators, unique-header
options and HWM symbols; `_http_incoming` exposes read/stop/raw-header and
abort helpers; `_http_server` exposes connection/tracking/options helpers.
Their original capture rows remain reconciled, including private parser
and symbol metadata. Discoverability does not promise portable V8/libuv
private-handle ABI, nor does an underscore justify excluding the row.
Candidate registry `bootstrap.js:5720–5816` and builtin-policy loading
`6098–6106,6260–6284` provide no `_http_*` implementations or shared aliases.

## Concrete findings

H-001–H-008 in [the earlier report](http.md) remain valid and are refined
below. All apply to the shared guest implementation on all four hosts.

| ID | Source finding and requirement |
|---|---|
| H-001 | Both createServer implementations throw (`5683–5686`); public HTTP Server, ServerResponse and OutgoingMessage are absent. Real accepted-request parsing, response framing, persistent connections, expect/upgrade/connect events, rejection policy, server timeouts/counts/close/disposal, custom classes and TLS admission/session ownership are missing. Real lower TCP accept alone does not supply HTTP serving. |
| H-002 | `http2` is only `{constants:{}}` at `5790`. Even literal constants, settings packing/unpacking/defaults and sensitiveHeaders are absent, as are all sessions/streams, handshake, servers and compatibility request/response classes. This is an implementation gap, not a browser limitation. |
| H-003 | Parser `5021–5251` accepts malformed header lines by ignoring missing colons (`5086–5100`), merges nearly all duplicates with comma, accepts numeric prefixes through parseInt for length/chunks, and discards trailers (`5102–5156`). Target cookie/set-cookie/discard/join/distinct rules, strict versus relaxed policy, framing conflicts, precise errors/bytesParsed/rawPacket and bounded headers/chunk metadata are not implemented. Only the trailer accumulator has a 65,536 guard; that is not Node's complete parser budget. |
| H-004 | Body selection `5057–5076` sees status/headers but not request method. HEAD framing differs; 1xx becomes a terminal response, and there is no subsequent final-response/information/continue handling or upgrade/CONNECT socket/head handoff. Target `_http_client.js:908–984` handles these distinctly. |
| H-005 | `_write:5573–5584` forwards raw body bytes; `_final:5586–5590` supplies no chunk terminator/trailers or complete automatic content-length/chunked policy. Header framing, strictContentLength, no-body methods/statuses and exact wire encodings are incomplete. Writes do use real socket callbacks and Writable serialization: waiting for the header callback in `_final` alone is not proof that normal ordered body callbacks finish prematurely. |
| H-006 | Agent is an empty class and globalAgent a plain empty object (`5681–5682`). The private per-protocol Map (`5277–5320`) ignores agent:false/custom agents/connection factories, active/free queues, limits, scheduling, proxy policy, option-sensitive names, destroy and public state. Its host:port key omits TLS ca/cert/key/servername/verification/version configuration; target `https.Agent.getName:537+` separates security contexts. HTTP and HTTPS have separate Maps, so this finding does not assert a shared cross-protocol pool. Idle sockets/timers are not unrefed. |
| H-007 | Request setTimeout only adds a listener; setNoDelay/setSocketKeepAlive return this; flushHeaders does nothing (`5667–5670`). Real timeout scheduling/socket effects and flush-before-body behavior are absent. Public socket/connection, headersSent, reusedSocket, abort/close/finish/error phases and counters cannot be inferred from underscored fields or inherited Writable. |
| H-008 | Normalize `5322–5349` drops URL auth and many options, uses duck URL recognition/parseInt ports and accepts wrong protocols without target rejection. Connect forwards only host/port for HTTP and ca/rejectUnauthorized/servername for HTTPS (`5690–5710`); lookup/local/family/socketPath/createConnection/agent/AbortSignal/TLS options are not honored. METHODS is nine entries and STATUS_CODES a subset (`4995–5015`). |
| H-009 | Missing constructors, wrong request/response prototypes, unavailable legacy-module aliases and plain properties instead of target accessors are concrete namespace/identity/descriptor gaps. HTTPS returned-object obligations must be attached to actual HTTP owners rather than nonexistent HTTPS static exports. Target IncomingMessage signal, headersDistinct/trailersDistinct, lazy headers/trailers, socket/connection and HTTP state are absent from the ordinary response Readable (`5254–5274`; target `_http_incoming.js:108–238`). |
| H-010 | `retryFreshFrom:5471–5484` automatically opens a new connection after a pooled socket ends/closes/errors before headers. There is no method/replay-safety guard and already-written body buffers have been removed. Node's client reports the socket error/close and reusedSocket for application policy; an unconditional retry can duplicate an operation or send different body bytes. This is a source finding, not an observed duplicate request. |
| H-011 | `_releaseSocket:5517–5554` pauses idle sockets and saves parser leftovers for the next request; `_openSocket:5491–5515` later feeds them to a new parser. Target `_http_agent.js:94–164` destroys idle sockets with buffered/pending input and installs an unsolicited-data guard; `_http_client.js:914–925` destroys a double response. Candidate has no corresponding guard. Future response attribution can differ; the audit has not executed a poisoning demonstration. |
| H-012 | setHeader `5407–5422` coerces values to String immediately, returns undefined, lacks validation and allows mutation after sending. Target preserves non-string/array values, returns this, validates name/value and rejects sent-header mutation; appendHeader/setHeaders/getRawHeaderNames/getHeaderNames/hasHeader and exact metadata are separate requirements. UTF-8 serialization through socket.write differs from target HTTP header byte validation/encoding. |
| H-013 | Parser completion invokes onComplete immediately (`5044–5053`), releasing the socket even if the request is still writable and writing. Target `_http_client.js:1048–1080` requires response completion **and req.writableFinished** before reuse. Response end, request finish, unread-body backpressure, disconnect/error and request/response destruction must retain the real socket owner until the correct phase. Candidate only checks destroyed/redirected/response Connection:close, omitting request Connection:close and HTTP/1.0 default-close policy. |
| H-014 | Node 26's isValidHeaderName/isValidHeaderValue (including strict/relaxed policy), validateHeaderName/Value, maxHeaderSize/setMaxIdleHTTPParsers, setGlobalProxyFromEnv restoration, WebSocket/CloseEvent/MessageEvent lazy getters and websocketMask/Unmask have no candidate module implementation. Target `lib/http.js:141–340` and `_http_outgoing.js:744–795` define these public contracts. Mask helpers require actual bounded ArrayBufferView XOR, four-byte masks and immutable-buffer errors; proxy setup must change actual HTTP/HTTPS agents and fetch dispatcher and restore previous owners. This is not supplied by a host fetch proxy or the npm ws shim. |

The opt-in followRedirects extension is off by default. Node HTTP does not
automatically follow redirects. Preserve the earlier Claude/npm/Bun work;
do not turn that extension into a Node requirement or edit it in this audit.
Its body/header/auth/SNI and new-request ownership interactions still
require independent review before later shipping.

## HTTP/2 scope beyond exports

`lib/http2.js` exports connect, constants, createServer/createSecureServer,
getDefaultSettings/getPackedSettings/getUnpackedSettings,
performServerHandshake, sensitiveHeaders and the two compatibility
constructors. Http2Session, ServerHttp2Session, ClientHttp2Session,
Http2Stream, ClientHttp2Stream, ServerHttp2Stream, Http2Server and
Http2SecureServer are **returned types**, not additional required module
constructor exports. The requirements artifact records their source
declarations and the complete documentation sections.

Target `lib/internal/http2/core.js:1306–1715,1825–2126,2128–3319` owns real
session/stream EventEmitter/Duplex state: pending/connect/readiness,
settings acknowledgments and callbacks, limits/memory budgets/HPACK,
header validation and sensitiveHeaders indexing, pseudo-header/authority
rules, informational/final/trailer delivery, stream IDs, priorities,
flow-control windows, ping deadlines, GOAWAY/RST/close/destroy ordering,
push, origin/ALTSVC, timers/ref and native buffer lifetime. File/fd response
methods additionally depend on actual fs descriptor ownership and offsets.
Copying constants or wrapping HTTP/1 would leave all of these absent.

The native session takes ownership of a connected or pending socket
(`core.js:1105–1180,1271–1305`); session/stream destruction must tear down
the correct native resources without closing a reused unrelated handle.
connect (`3666–3730`) selects actual clear TCP or TLS with ALPN, honors a
custom connection factory and validates authority/protocol/session options;
its custom promisify symbol waits for real connect/error. Servers inherit
net/TLS server owners (`3521–3610`), while compatibility request/response
(`compat.js:311–947`) adapt real streams, headers, abort/finish/backpressure,
push and response events rather than share HTTP/1 wire framing.
performServerHandshake (`3816–3819`) adopts a real Duplex/socket; it is not
a promise that arbitrary encrypted bytes are already decrypted.

Settings helpers (`core.js:3755–3814`, `util.js`) need actual defaults and
validated six-byte entries, custom settings and option controls, even when
no network is used. The native `src/node_http2.cc/.h` and nghttp2 owner are
the target dependency, not an available Kandelo binding. Captured native
constants and symbols retain their exact values/descriptors for later
controls; an empty constants object supplies none of them.

## Owning layers and four hosts

All four hosts run the same guest bootstrap and SpiderMonkey compatibility
bridge; embedding Node's own HTTP modules are not used as an implementation.
The ordinary path is guest HTTP parser/client → stream → net.Socket or
tls.TLSSocket → native socket/OpenSSL adapter → libc/kernel socket state
and waits → selected host NetworkIO/virtual-network route. See the hashed
[network](network-contracts.md) and [TLS](secure-network-contracts.md)
traces for actual bind/accept, native error, async/ref and TLS ownership
gaps; these remain dependencies rather than solved HTTP prerequisites.

| Host | Actual route and qualification |
|---|---|
| Node | Optional `host/src/networking/tcp-backend.ts` supplies raw external TCP through host sockets. Guest protocol/parser/TLS behavior still must be implemented; raw transport does not imply public HTTP or HTTP/2 support. Fetch-based egress may also be selected. |
| Chromium | Local/session virtual networking remains distinct from external fetch-based egress. `tls-network-backend.ts:1–15,469+` terminates a TLS 1.2 hop and reissues HTTP through browser fetch. It does not preserve arbitrary raw peer transcripts, upgrade tunnels, ALPN/HTTP2 or end-to-end remote TLS identity. |
| Firefox | Same source routes and guest gaps as Chromium; configured ingress/egress and engine runtime evidence must be recorded separately. The historical exit-fixture timeout is unresolved and supplies no HTTP conformance evidence. |
| WebKit | Same source routes and guest gaps; engine-specific scheduling/stream/TLS capability results remain unestablished for this candidate. A shared file is not proof of identical runtime outcomes. |

Concrete browser inability to open arbitrary external raw TCP is a boundary
of that host adapter. Missing portable HTTP classes, parser policy,
HTTP/2 codec/session ownership, loopback/session serving and JS settings
helpers are implementation gaps. A fetch bridge can normalize/decompress
headers/bodies and cannot be a raw malformed-wire differential peer.
Network permissions, external trust/proxy services and route activation
must be attached to later evidence. No engine defect is established here.

## Evidence, open questions and later controls

Existing evidence retains exact identity and limitations in
[existing-evidence.md](existing-evidence.md), the historical archive/index and state.json.
The initial four-host baseline has 3 pass/3,721 fail/1,423 unsupported per
host; 3,687 failures per host stop at the common net accessor prerequisite.
Those are not HTTP test-body results. Current candidate source is unbuilt,
and there is **no current-candidate four-host HTTP runtime conformance**.

Unresolved questions are explicit, rather than guessed outcomes:

- Exact strict/relaxed and insecureHTTPParser precedence, llhttp status,
  whitespace/duplicate/framing/limit edge cases and error metadata need
  the pinned native reference; regex differences alone do not prove every
  possible malformed packet result.
- Target requestOnFinish comments (`_http_client.js:1094–1103`) discuss
  prior release, while responseOnEnd tests writableFinished. Preserve both
  source paths and compare early-final-response/late-finish/reentrant close
  controls before choosing implementation details.
- Precise public/private applicability of source-exposed parser handle
  methods and symbols must remain distinct from portable documented APIs.
  No private native ABI equivalence is claimed.
- Actual host/backend activation, proxy/no-proxy/restore precedence and
  external-peer capability must be captured later. Local/session protocol
  gaps cannot be dismissed because a browser external route is constrained.
- Immutable/resizable/shared view spans, overlapping WebSocket XOR buffers,
  proxy restoration nesting and lazy class identity need exact native
  differential controls; absence of the candidate APIs is already definite.

`http-validation-candidates.json` identifies unchanged upstream source
candidates across categories with hashes, declared flags and environments.
It is a selection aid, not an executable/subtest/variant denominator or a
complete peer/resource closure. Later controls must cover real fragmented
raw peers, malformed/duplicate framing, HEAD/CONNECT/upgrade/information,
early responses with pending writes, unsolicited idle bytes, stale pooled
errors on non-idempotent requests, header byte/types/descriptors/aliases,
agent/TLS-context isolation, request and response cancellation, abort and
close/finish/ref phases. HTTP/2 additionally needs real independent peers,
flow/memory limits, settings ACK, ping, GOAWAY/RST, push/trailers and fd/file
lifetime. Use the exact native pin with platform/crypto/flags recorded;
retain all failures/skips/unsupported/timeouts/harness errors as nonpassing.

All controls and implementation remain **unauthorized** pending completion
and review of the entire 19-family audit.
