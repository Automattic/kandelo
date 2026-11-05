# TLS, DTLS and QUIC source review

State: **source review complete with implementation gaps**. Native TLS client transport exists; complete public
security metadata, configuration and server protocols do not. No new
runtime test, network probe or build ran.

Bootstrap:4839–4985 implements TLSSocket over Duplex and native TLS
watches. The reviewed js.cpp:2345–2447 uses OpenSSL TLS_client_method,
minimum TLS1.2, real CA store loading/default paths, SSL_VERIFY_PEER by
default, SNI and SSL_set1_host. It is therefore incorrect to infer that
the native client has no hostname verification merely because the public
checkServerIdentity function is a no-op. Those are separate contracts.

| ID | Requirement | Source finding |
|---|---|---|
| S-001 | Independently callable checkServerIdentity | Always returns undefined at bootstrap:4983; it never checks the supplied certificate/name or returns target mismatch errors |
| S-002 | Actual protocol/peer/authorization/session metadata and controls | getProtocol hardcodes TLSv1.3 after handshake, although native context permits TLS1.2. getPeerCertificate returns empty object; authorized equals requested rejectUnauthorized rather than actual verification result. Socket timeouts/noDelay/keepAlive/ref are no-ops |
| S-003 | SecureContext, TLS server and complete options | createSecureContext throws, rootCertificates is empty, no public server implementation. Key/cert/client authentication, ALPN, cipher/groups/version bounds, PSK/session/ticket, identity callback and numerous TLSSocket APIs are absent or ignored |
| S-004 | TLS lifetime and async cancellation | Native handle owns fd after connect; JS destroy cancels pre-connect operation and closes existing handle, but in-progress handshake is not held as an independently cancelable JS owner. Its eventual resolution closes a destroyed socket; prompt cancellation and loop liveness need native-watch review |
| S-005 | DTLS public endpoint/session/secure-context API | Entire node:dtls module absent. Pinned lib/dtls.js exports listen/connect/createSecureContext/DTLSEndpoint/DTLSSecureContext/DTLSSession; endpoint/session stats, certificates, resumption, PSK and async disposal remain missing |
| S-006 | QUIC endpoint/session/stream protocol and constants | Entire node:quic module absent. Pinned lib/quic.js exports listen/connect/listEndpoints and classes/constants. No UDP+TLS1.3/QUIC congestion, streams, datagrams, flow control, migration or actual lifecycle implementation |
| S-007 | Exact crypto/TLS backend capabilities | Candidate OpenSSL package pin is 3.3.2; exact native Node reference lists 3.5.9. This is a backend difference requiring feature-specific analysis, separate from absent public bindings; no target pin was changed |
| S-008 | TLSSocket net.Socket inheritance and wrapping constructor | Target tls.md:888–899 and internal/tls/wrap.js:622,728–729 require net.Socket inheritance and new TLSSocket(socket, options). Candidate bootstrap:4856 takes only options and extends Duplex; it neither adopts the supplied transport nor implements the full inherited socket address/control/connection state. Duplex inheritance alone is insufficient |
| S-009 | Actual TLS shutdown, native resource state and failures | Reviewed js.cpp:2189–2344 has a real 1,024-slot TLS handle table, partial-write offset loop, WANT_READ/WANT_WRITE retry and authenticated close-notify read EOF. Close removes pending handle watches, calls SSL_shutdown once and frees/closes immediately; it does not drive asynchronous TLS shutdown to completion. Public TLSSocket supplies no _final/shutdown owner. Full-table, allocation, handshake and I/O errors use generic native rejection helpers rather than the complete Node/OpenSSL error and authorization schema |

OpenSSL is a real guest library. Host BrowserTlsNetworkBackend separately
terminates synthetic TLS and bridges HTTP(S); Node optional raw TCP and
local/session peers have different routes. Raw public internet UDP via
the egress link is concretely unavailable there, while guest/local UDP
exists. That route-specific boundary does not excuse missing DTLS/QUIC
modules or all local behavior. No blanket browser/non-V8 protocol
exclusion has been accepted.

Later unchanged TLS/DTLS/QUIC tests require exact activation/build support,
certificates, real local servers/UDP peers and native reference controls.
Check CA chains/hostname/IP and wildcard rules, verify-disabled outcomes,
ALPN/protocol negotiation, handshake abort/close, resumption, malformed
packets, retransmit/timeouts and live resource cleanup. Keep fixture
unavailability, unsupported activation, skip and API failure distinct.

The [complete public contract review](secure-network-contracts.md) now
reconciles all 615 original obligations, conditional native activation,
legacy exports, every preserved narrative/option/callback/statistics section
and additional returned/source-exposed/inherited contracts. It adds
S-010 actual CA-source/metadata distinctions, S-011 connection/SNI/CA-array
semantics, S-012 the missing DTLS state/security surface, S-013 QUIC native/
writer/statistics/HTTP3 contracts and S-014 exact reference questions.
`secure-network-requirements.json` retains 498 original sections and 117
original descriptors. Its future catalog records 886 unchanged source
identities including helpers/fixtures, not executed cases or a completed
fixture/variant denominator. Runtime evidence remains absent for the
current candidate on all four hosts.

The additional source inspection confirms S-004's distinction: a pending
handshake watch owns its fd/SSL/SSL_CTX before a public numeric handle
exists. Public destroy cancels pre-connect TCP work or closes an established
TLS handle; it cannot address that pending native handshake by the current
public handle. Eventual handshake success closes the handle if the JS
socket is already destroyed, but that does not establish prompt cancellation,
timeout or process-ref behavior. Actual TLS read/write retry and cleanup
exist and must be preserved in a later implementation. Native calls to
set_fd, SNI, hostname and default verification paths do not check every
configuration return value. Failure-path checks, trust-store packaging,
in-progress shutdown and JSContext/fork/worker ownership remain audit
questions; no new runtime outcome or engine fault is claimed.

The completed [crypto dependency review](crypto-contracts.md) supplies the
missing key/certificate/provider/entropy owners for S-003/S-007. The full secure-network source review now records those dependencies,
without establishing current-candidate security-context behavior for any
host transport route.
