# HTTP/HTTPS/HTTP2 source review

State: **source review complete with implementation gaps**, with the full
[public/returned/legacy contract review](http-contracts.md), requirements
and future validation catalog. Shared HTTP/1 client/parser source is real
but incomplete. No new networking test, fixture or build ran.

Bootstrap:4994–5710 implements a custom response parser and client over
net.Socket or tls.TLSSocket. IncomingMessage is a Readable; ClientRequest
is a Writable. Real writes, readable backpressure and pooled-socket
leftover ownership exist, but they do not implement the full Node HTTP
contract. HTTPS depends on the separate native OpenSSL client path.

| ID | Requirement | Source finding |
|---|---|---|
| H-001 | Server/ServerResponse/OutgoingMessage and request lifecycle | createServer throws at 5683–5686 for both protocols; server constructors/response implementation and full request parsing are absent. Requires real accept, parser, headers, stream and server/TLS ownership |
| H-002 | HTTP/2 sessions/streams/settings/flow control/client/server | Registry at 5788 only supplies an empty constants object; every protocol operation and the actual constants are missing |
| H-003 | Header/status parsing, duplicate rules and bounded error handling | pushHeader at 5086 accepts malformed lines, merges most duplicates indiscriminately; parseInt accepts prefixes for lengths/chunks. Header accumulation has no equivalent full Node parser limits/error codes. Chunk trailers are discarded rather than populating trailers/rawTrailers |
| H-004 | HEAD, interim/informational responses, upgrade/CONNECT | Parser body mode only uses status/headers, without request method; 1xx completes as a terminal response. No full information/continue/upgrade/connect ownership handoff |
| H-005 | Outgoing framing and header validation | setHeader stringifies values without Node token/value validation; _write sends raw bytes, _final sends no chunk terminator, and no automatic full Node content-length/chunked framing policy is supplied. Headers/arrays and late mutation semantics differ |
| H-006 | Agent/public pooling options and per-security-context reuse | Agent is an empty class, globalAgent empty object. Private pool key is host:port (5280), omitting TLS CA/servername/verification configuration. Public agent/maxSockets/freeSockets/custom connection options do not control this pool |
| H-007 | Socket options/timeouts/flush and request state/events | setTimeout only registers listener; setNoDelay/setSocketKeepAlive return this; flushHeaders does nothing. Public headersSent/finished/reusedSocket, abort/error/order and all metadata still need reconciliation |
| H-008 | Complete URL/options/validation and metadata | normalize at 5322–5349 copies only selected URL pieces and no auth. Status codes/methods are a small static subset; constructors/inheritance and missing exports remain incomplete |

Opt-in followRedirects is a non-Node extension and off by default; do not
misreport ordinary http.request as automatically following redirects.
Fetch's required redirect behavior is a separate missing integration.
The extension's same-scheme restrictions do not redefine public Node
requirements. It belongs to preserved earlier work, not this audit's
authorized edits.

All four hosts share this parser. Node's optional TCP backend versus
browser synthetic fetch/TLS egress changes reachable peers and wire
behavior; session/local networking is separate. A fetch bridge does not
establish arbitrary HTTP upgrade, raw server ingress or HTTP/2 protocol
support. Missing guest server/protocol code is an implementation gap even
when a particular external ingress path has a real boundary.

Later unchanged upstream http/https/http2, parser/security, agents,
keepalive, upgrade/connect and server fixtures need native controls using
malformed/fragmented raw responses, duplicate/framing conflicts, HEAD,
100/103/final responses, trailers, slow/error bodies, TLS option-separated
pooling, cancellation and actual shutdown/ref behavior. Retain unsupported
fixture/launcher outcomes separately. Current candidate has no four-host
runtime conformance.

The completed source review covers class/member/descriptor/event/option,
strict parser policy, framing, agents/TLS pooling, server lifecycle and
HTTP/2 contracts. Exact native edge cases and unresolved reference
questions remain recorded in http-contracts.md; source review does not
establish implementation completeness or runtime conformance.
