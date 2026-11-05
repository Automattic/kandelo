# TLS, DTLS and QUIC public contracts

State: **source review complete with implementation gaps**. This covers
`node:tls`, deprecated `_tls_wrap`/`_tls_common`, and the conditional public
DTLS/QUIC APIs, returned objects, inherited contracts and narratives. No
runtime test, probe, compilation or build ran. Source completion does not
establish protocol correctness, security, implementation completeness or
current-candidate conformance on any host.

`secure-network-requirements.json` retains all 615 original discovery
identities: 498 documentation sections and 117 saved native descriptors.
Additional source-exposed methods, returned writer/statistics objects,
events, options and symbols supplement that incomplete default capture.
Negative source review establishes a missing public route; it is not a
formal review of every line of an unconnected protocol implementation.

## Pins, activation and exact source owners

The target remains Node 26.13.0 at commit
`18b32a3b1552e199a01f1a8d9fd64aa756d3b75b`, with OpenSSL 3.5.9 in the
saved native reference. Kandelo selects OpenSSL 3.3.2, with the feature
choices documented in [crypto-contracts.md](crypto-contracts.md). No pin,
build setting or feature flag changed.

Target `lib/tls.js`, `internal/tls/common.js`, `secure-context.js` and
`wrap.js` own TLS exports, context configuration, socket/server inheritance,
verification, callbacks and native state. Public TLS is a real crypto build
feature; a no-crypto build's error is not permission to omit selected APIs
from a crypto-enabled implementation. Deprecated legacy modules re-export
the same target constructors/factories and emit DEP0192. `_tls_common`
also exports translatePeerCertificate. Kandelo registers neither legacy
module, DTLS nor QUIC; the final builtin registry and
`module-exposure.json` establish absence independently of lower libraries.

DTLS and QUIC require their `node:` names and experimental runtime options
in `internal/bootstrap/realm.js`:195–216. `process.features.dtls` additionally
requires the configured native DTLS/crypto build; QUIC requires its build,
non-BoringSSL OpenSSL >=3.5.1 and runtime option
(`internal/bootstrap/node.js`:288–300). Internal protocol modules recheck
those gates. The saved default native capture explicitly lacks flagged
reference exports. That is an evidence limitation, not a reason to call
missing guest protocols passing or outside the public source inventory.

Target DTLS uses actual OpenSSL contexts/sessions and UDP/timers in
`src/dtls/`; QUIC uses ngtcp2, nghttp3, OpenSSL and UDP/timers in
`src/quic/`. Merely exposing constants, importing JavaScript or linking
libssl would not implement them. Their native keys, permissions, actual
packet queues, callbacks, loss/retransmission/flow-control and lifetime
owners must exist. No unavoidable browser-engine prohibition has been
established for those portable local/session protocol behaviors.

## Active TLS path and concrete gaps

Candidate `bootstrap.js`:4844–4984 supplies a custom TLSSocket over
Duplex, tls.connect, an empty rootCertificates array, a no-op
checkServerIdentity and a throwing createSecureContext. Native adapter
methods at `spidermonkey/node-compat/adapter.js`:636–639 forward to the
frozen post-53 shell source identified in state.json.

That native source, `js.cpp`:2189–2509, implements real SSL_CTX/SSL objects,
TLS_client_method, minimum TLS1.2, SNI, SSL_set1_host and peer-chain
verification by default. Explicit PEM CA data is parsed into the context
store; otherwise SSL_CTX_set_default_verify_paths is called. Poll-driven
SSL_connect/read/write handles WANT_READ/WANT_WRITE, actual partial writes
and authenticated close-notify EOF. This positive behavior must not be
misreported as an entirely fake client or absent native hostname checks.

| Finding | Required public behavior and candidate disposition |
|---|---|
| S-001 | Independently callable checkServerIdentity must parse escaped SANs, canonical IPs/IDNA/trailing dots, DNS wildcard/CN fallback rules and return ERR_TLS_CERT_ALTNAME_INVALID with reason/host/cert on mismatch. Candidate always returns undefined. Target tls.js:430–509 is separate from native connection verification. |
| S-002 | Protocol, peer/local certificate, authorization, cipher, ALPN/SNI, ephemeral keys, exporter, finished messages, sessions/tickets/signature algorithms and socket address/control state must reflect the actual connection and phase. Candidate getProtocol returns TLSv1.3 whenever a handle exists, though its transport permits TLS1.2; getPeerCertificate returns {}; authorized mirrors rejectUnauthorized instead of verification state. Most other members are absent. |
| S-003 | SecureContext, full server and credentials/configuration are missing. createSecureContext throws; Server/createServer/SecureContext and server operations are absent. Actual key/cert/PFX/passphrase/CRL/partial-chain/sigalgs/ciphers/groups/version/options/tickets/session lifetimes, client auth, SNI/ALPN/OCSP/PSK callbacks and certificate compression are ignored. Owning crypto, compression, TCP accept and server lifecycle dependencies remain gaps. |
| S-004 | Public destroy cancels pre-connect TCP work and closes an established TLS handle, but the in-progress native handshake owns fd/SSL/SSL_CTX before a numeric handle exists. No public independent cancellation/timeout/ref owner reaches it. Eventual success closes a destroyed socket's handle; that is not prompt cancellation or proven exit behavior. |
| S-008 | Target TLSSocket(socket, options) extends net.Socket and wraps existing socket/Duplex transports, including pending writes and ownership. Candidate constructor takes only options and extends Duplex; connect always begins its own TCP operation. Missing Socket inheritance affects methods, statistics, properties, symbols and instanceof, beyond encryption. |
| S-009 | Native handles have a real 1,024-slot table, rooted operation promises and owned write/read buffers. Closing removes pending handle watches, calls SSL_shutdown once, then frees contexts/fd. It does not drive WANT_READ/WANT_WRITE shutdown to completion; public _final has no TLS half-close/shutdown owner. Generic native rejection strings lack the complete Node/OpenSSL error/authorization schema. Allocation, full-table and settlement failures need later controls; no leak/crash was observed. |
| S-010 | Target rootCertificates is a cached frozen PEM array behind an enumerable nonconfigurable getter. getCACertificates distinguishes default/bundled/system/extra sources, options and caches; setDefaultCACertificates validates/parses/deduplicates and affects subsequent thread-local defaults without rewriting already cached HTTPS sessions. Candidate only exposes a mutable empty array and none of these controls or metadata. Empty public metadata does not mean guest trust files are absent. |
| S-011 | Connect overloads/options and identity selection differ: (port, options, cb) drops the second-argument options; path and supplied transport wrapping are not implemented. Candidate chooses servername || host || localhost and always calls native SNI, whereas Node tls.connect enables SNI only when requested. Empty servername cannot disable it; IP/DNS identity rules, custom checkServerIdentity and CA arrays are not honored. CA arrays are silently discarded before native setup. |

NoDelay, keepAlive, timeout, ref and unref return the socket without the
required controls; timeout only attaches a listener. The native watches
start referenced, so these methods do not establish target event-loop
liveness. Native socket/TCP owners already exist below this facade; storing
an option without applying it does not close the gap.

`secureConnect` is emitted after native success, but the target also has
secure, session, keylog and OCSP events and exact before/after-close values,
authorization errors and listener/callback ordering. Target server events
include raw connection versus secureConnection, tlsClientError, new/resume
session, OCSP and keylog. Server inherits actual net.Server listen/close/
address/ref/connection/disposal behavior, not just matching method names.

Target SecureContext has no documented public methods. Its exposed native
context implementation is not a promise to reproduce every private native
method. Source-exposed legacy constructor/prototype metadata is retained;
the constructor/factory and configured native ownership are missing anyway.
Defaults, client renegotiation limits/window, convertALPNProtocols, cipher
and certificate-compression lists are observable TLS exports and are also
missing. convertALPNProtocols validates/copies wire views and rejects empty
or truncated protocol elements; source exposure is not equivalent to a
new documented constructor contract.

## Trust stores and host/transport differences

All four hosts use this same guest TLS/native/libc/kernel path. Real socket
fd operations reach libc, runtime-core socket state and configured host
NetworkIO, as traced in [network.md](network.md). Endpoints inside guest or
session networks differ from public internet egress. A public server API
remains missing even if one external ingress route cannot accept peers.

| Configuration | Actual source route and implication |
|---|---|
| Node optional TcpNetworkBackend | Raw TCP carries guest TLS records to the actual configured peer. SSL verification and eventual peer metadata would describe that peer, subject to guest trust configuration. The outer Node's TLS module is not the guest API. |
| Browser HTTPS egress | TlsNetworkBackend terminates guest TLS using its TLS1.2 implementation and a generated per-session CA/leaf, then carries HTTP(S) through browser fetch/proxy. That is a concrete transport/trust boundary: do not label the synthetic peer certificate or negotiated protocol as the remote origin's end-to-end TLS state. |
| Browser local/session traffic | Different backend paths carry real virtual-network traffic. The egress fetch/TLS restriction does not establish a local TLS, UDP, DTLS or QUIC impossibility. |
| Default egress UDP | EgressLink returns EHOSTUNREACH for datagrams; virtual/session UDP has real queues and routes. Missing public DTLS/QUIC bindings are separate implementation gaps. |

Source `packages/registry/ca-certificates/build-ca-certificates.sh` copies
`images/rootfs/etc/ssl/cert.pem` into **two independent** archive members:
`/etc/ssl/cert.pem` and `/etc/ssl/certs/ca-certificates.crt`. The current shell
image can defer them to the CA data package; base-rootfs trust is distinct.
NodeKernelHost and BrowserKernelHost set SSL_CERT_FILE/SSL_CERT_DIR defaults.
The browser worker writes its session CA only to the latter bundle
(`browser-kernel-worker-entry.ts`:976,1192–1205); it does not replace
`/etc/ssl/cert.pem`. TlsNetworkBackend generates the actual CA and peer leaf
(`tls-network-backend.ts`:448–466,626–646). Explicit CA/options and guest
environment decide trust; a comment claiming “no bundled CA store” cannot
replace this source trace. Lazy-package/source identity is not proof of
installed files, current bundle contents or a completed handshake.

Browser transport restrictions and platform trust sources must be documented
truthfully. No API-specific engine defect is established. Exact native
engine tracing formats, operating-system system stores, dynamic provider or
hardware-backed credentials need concrete capability decisions; they do not
excuse absent portable namespace/verification/key/socket behavior.

## Missing DTLS contracts

**S-005/S-012:** the entire node:dtls API is absent. The exact public target
methods and returned member requirements are preserved with each original
section, including:

- listen/connect/createSecureContext and endpoint/session/context classes;
  permissions and node-only scheme/flag/build gates; numeric host/port,
  local bind/family/ipv6Only/reusePort/UDP buffers/TTL/MTU options and native
  errno errors. Contexts have fixed server/client roles and cannot combine
  prepared configuration with conflicting credential/SNI options.
- Real datagram record semantics, OpenSSL cookie exchange, per-host/total
  admission caps, busy state, packet screening, retransmission/backoff and
  handshake deadlines; unreliable delivery is not byte-stream semantics.
- SNI map/fallback or synchronous callback selection, endpoint versus
  per-identity verification/cipher state, PSK identity/key callbacks and
  exception handling, certificate versus PSK suites, ALPN and SRTP profiles.
- Strong ticket keys, opaque sessions bound to authenticated host and
  recorded verification state, actual resumption status, reusable context
  ownership and client session ownership of its endpoint. A stale ticket
  may fall back to a full handshake; it is not automatic success or error.
- send's exact view bytes/16,384-byte record limit and post-handshake/open
  guard; close-notify versus immediate destroy; opened/closed promises that
  settle on failure/early teardown, error/callback and async-disposal rules.
- Actual peer certificate PEM/X509, protocol/cipher/ALPN/SRTP/servername,
  authorization and exporter bytes; exporter length 1–65,536 with optional
  Buffer context, native key/certificate lifetime and post-close values.
- Live bigint/timestamp counters, correct stale snapshot and isConnected
  after owner teardown, readonly getters, JSON/string/custom inspection.

Target internal state/test-only accessors and private constructor tokens
are not public exports. The public DTLSEndpoint constructor accepts its
options; session/context are produced by the actual factories. Documentation
names DTLSEndpoint.Stats/DTLSSession.Stats, but current source does not attach
those static properties. They are returned statistics classes with guarded
constructors. This differs from QUIC's actual static Stats properties;
do not manufacture missing candidate static DTLS exports from prose alone.

## Missing QUIC contracts

**S-006/S-013:** the entire node:quic API is absent, independently of
conditional reference activation and current UDP egress limits. The audit
retains all original method, option, callback, statistic and narrative
requirements, plus source-exposed public members and returned writer APIs.

| Group | Missing required behavior |
|---|---|
| connect/listen/listEndpoints/constants | Actual async session/listening endpoint results, SocketAddress/string parsing, endpoint creation/reuse/registry filtering and permissions. Native congestion algorithm strings, ciphers/groups and getter identities must reflect the built protocol. |
| Endpoint | Real UDP binding and native packet/session dispatch, address, busy and per-host/total caps, live BlockList allow/deny policy, retry/version-negotiation/reset/close token-bucket limits and counters, SNI-context replacement, graceful/immediate closure and disposal. Endpoints can serve client and server sessions; registry lifetime must follow actual objects. |
| Session | TLS1.3-only ALPN/credentials/peer verification and actual transport params, authenticated path/migration, flow/congestion control, stream creation, unreliable datagram IDs/status/limits/drop policy, key updates, tickets/0-RTT/rejection, callback/error/Promise ordering, graceful close/draining versus reset and shared endpoint ownership. |
| Stream | Genuine bidi/uni directions and local/remote authority, pending/opened/closed state, actual flow credit/byte budget, one async iterator yielding batches of Uint8Array, resetStream/stopSending numeric QUIC error semantics, callbacks and lifetime. Consumption returns transport credit; an unconsumed body cannot be reported drained. |
| Body/writer | setBody and returned writer are mutually exclusive. Real byte/Blob/FileHandle/iterable/promise sources and cancellation need actual owned buffers/files/native queues. Writer supplies canWrite, sync/async write/writev/end, fail, drain protocol and dispose/asyncDispose. End waits accepted work; fail resets with a real application error, not success code. Remote uni/read-only streams return a preclosed writer. |
| HTTP/3 | Actual nghttp3/QPACK/control stream/header/trailer/informational/priority/body framing, ALPN and settings, ORIGIN/GOAWAY and datagram capabilities. Source-exposed setOutbound and pending metadata are retained without claiming a new documented high-level request router. |
| Errors/stats/observability | QuicError is an Error subclass with coded transport/application type and 62-bit numeric wire error, readonly fields and static brand predicate. Endpoint/Session/Stream have real readonly Stats class properties, native live counters/snapshots, JSON/inspect and lifetime. Diagnostic channels and performance entries require actual producers and measurements. |

Node's documented HTTP/3 limitations remain target scope: server push,
WebTransport/extended-CONNECT helpers and higher-level routing/redirect/
cookie semantics are not promised built-in APIs. Referenced RFCs and
proposal links do not enlarge the target to every protocol extension.
Conversely packet limits, response rate limiting, transport settings and
permission behavior are documented requirements, not optional because the
current guest has no module.

**S-014 target questions:** QUIC writer prose says async writes reject when
full rather than wait, but `internal/quic/quic.js`:2287–2372 permits one
pending write to await drain and rejects additional overlapping writes.
Both the overview and returned writer contracts require exact native
controls before later assertions are chosen. The writer prose also says
signal is only checked at entry, whereas the source observes it while
waiting for drain. Its source-buffer copy/retention timing under that wait
needs a control. The connect overview promises a new endpoint by default,
while processSessionOptions/processEndpointOption default reuseEndpoint to
true and can select a suitable existing endpoint (quic.js:5143–5185,
5519–5525). A fulfilled connect promise is distinct from session.opened
handshake completion. DTLS's nested Stats names
versus missing static attachment are separately retained. Target source
exposes some undocumented prototype members; their observable metadata is
recorded without silently treating private symbols/test accessors as public
portable operations. These are unresolved reference questions, not newly
observed upstream defects or authorization to change tests.

## Evidence, dependencies and proposed later validation

Historical reports keep their original artifact/source identities and
nonpassing classifications in [existing-evidence.md](existing-evidence.md)
and the evidence archive/index. The old full-suite common-helper failure
blocks later protocol test bodies; it proves no TLS/DTLS/QUIC conformance
for the unbuilt source candidate. No current four-host protocol validation
exists. Flag-gated native exports and complete fixture/resource/variant
closure still need collection after authorization.

Dependency order: real socket/address/UDP/TCP listen/accept and refs, byte/
stream/async ownership and native errors; crypto keys/certificates/provider/
entropy and trust policy; complete TLS contexts/client/server; actual
DTLS and QUIC native packet/timer/loss/flow/HTTP3 owners; observable stats,
callbacks/diagnostics/permissions and teardown. Keep separate focused draft
PRs at independently reviewable owners after the audit review; a facade
or generic “Bun compatibility” change cannot close these gaps.

`secure-network-validation-candidates.json` preserves unchanged future
source identities, flags and fixture/helper roles, not executed cases or a
complete denominator. Proposed native controls compare wrapping/overloads/
inheritance/descriptors; CA arrays and default source replacement; SNI
absent/empty/IP/IDNA/wildcards; certificate/auth errors with verification
enabled/disabled, negotiated TLS1.2/1.3 and ALPN, session/ticket/OCSP/PSK/
exporter/compression; handshake abort/ref/timeouts/partial I/O/half-close/
GC/OOM/full-handle/shutdown ownership. Distinguish actual raw-peer TLS from
browser synthetic egress, with configured local/session fixtures per host.

DTLS/QUIC need activated native builds and genuine datagram peers, packet
loss/reordering/truncation/corruption, rate/admission limits, wrong identity
and resumed unverified sessions, protocol bytes/flow credit and actual
counter changes/snapshots. QUIC adds HTTP3/QPACK/body/writer/drain/reset,
0-RTT/key/path/datagram/permission/diagnostic/performance controls and the
S-014 disagreements. Preserve upstream assertions and every failure, skip,
unsupported case, timeout and harness error. No implementation or new
validation is authorized by this proposed plan.
