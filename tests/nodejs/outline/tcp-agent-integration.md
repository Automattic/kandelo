# TCP descriptor, async and plain HTTP Agent integration

Source160 integrates actual native TCP descriptor/read/write ownership,
original allocation spans and pinned five-field stream state. Socket callbacks
use the authoritative native execution stack and current public resource alias.
Private onread delivery uses its real slot, prototypes share an actual
per-environment/per-realm cache, and connect/write init uses the parent default
trigger. Existing recovered-error scope.Fail routes are retained.

Accepted descriptors enter a real native lease before fallible token/Promise
publication. Constructor/getter/drop/blocklist/init failures retire that lease;
success transfers the same lease into the actual TCP Owner. An additional
rollback closes the actual Owner if the post-transfer adoption-property lookup
throws. Cleanup cannot close a reused numeric descriptor. Keepalive performs
coercions before reading the live Owner descriptor. The token is an ownership
capability, not a fabricated TCPWRAP resource: accepted init timing remains a
separate implementation gap.

The plain HTTP Agent uses pinned queue, limits, selection, pooling, idle-data,
proxy and request-control algorithms over these owners. A focused regression
found request timeout reset occurred before close/non-keepalive decisions.
The reset now belongs to actual socket reuse, preserving the pinned keepalive
reset rather than replacing it with listener removal. Real-loopback native
comparisons distinguish non-keepalive, Connection:close and reusable sockets.

Existing parser controls injected plain Duplex peers into an Agent dependency
that requires socket timer/ref/keepalive methods. Their synthetic-byte peers
now use actual native Socket with the same read/write callbacks; no noop
methods, fake handle or assertions were added. Native peer-contract controls
separately reproduce the Duplex failure and successful actual Socket behavior.
The earlier four failures and source-before-correction images remain retained.

Current source/staging/bootstrap/input checks pass, along with14 existing HTTP
cases and14 existing package-source tests, no skips. Identified prior component
evidence includes19 accepted-lease cases,7 owner methods,5 accept-forwarding
checks, actual native TCP reset alias traces and Agent shapes/30 requests with
queue cancellation/idle poisoning/proxy controls. These use explicit native
Node/N-API/stream/parser dependencies, not production SpiderMonkey networking.
The separate lease prerequisite's3 tiny successful helper compilations are
accounted for; this integration adds no engine/native compilation.

Body/X509/SQLite/Locks/loading/ReadFile and crypto159 source remain preserved.
The normal engine patch is additive over X509 and shared-buffer alignment.
Production JSAPI/token/watch/Promise/OOM/GC/realm/context shutdown, legacy accept
callback/concurrency/error behavior, accepted-init timing, full Socket/Server
metadata and HTTP/server/HTTP2/TLS gaps remain open. There is no accepted current
combined engine or Node/Chromium/Firefox/WebKit conformance. All nineteen
families remain partial; overall suites/full product rebuild remain deferred.

Exact evidence: [tcp-agent-finding-progress.json](tcp-agent-finding-progress.json).

The initial root staging check rejected blank context whitespace in the new
engine patch. A zero-context serialization replays to the exact same canonical
engine source with zero fuzz. The original patch/log remain preserved; no
runtime source or upstream assertions changed for this formatting correction.
