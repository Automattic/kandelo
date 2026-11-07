# Retained TLS plaintext/read acknowledgement integration

Source204 adds actual native read material ownership over203opaque TLS state.
The engine/native registration, curated adapter and bootstrap change as a pair.
Pins and ABI55 remain unchanged. Current200accepted engine excludes201–204;
new native JSAPI remains uncompiled and unexecuted.

Real SSL_read writes its actual stable allocation and yields Data/Eof/Error.
Immediate errno/SSL_get_error/OpenSSL capture precedes JavaScript or unrelated
OpenSSL operations. Read generation/sequence, allocation and delivery phase
persist through stop/resume/publication failure. Real decrypted pending bytes
and processed close_notify can progress without another fd event; encrypted
readiness itself is not plaintext. Close retains consumed in-flight material.
The actual settled read Promise/owner must acknowledge current material, and a
stale completion cannot release a newer native allocation.

## Focused evidence and preserved failure

Three current native portable cases pass: orderly EOF, abrupt TLS error and
retained data through close/reentry. Their observed assertion counts97/87/99vary
with real retry loops and are not coverage counts. Current27TLS-policy and12
constant groups, actual native constructor/TCP-parent/curated-forwarding reference,
876normal input closure, unchanged Mozilla checker, pinned bootstrap syntax and
14package checks pass. The native reference/throwing forwarder checks only its
actual pre-native dependency boundary; it is not candidate guest admission proof.

The first root control failed its own total-assertions>100guard. Real retry loops
make that threshold invalid; original inputs/stderr/source log are retained.
Every C++ownership Check condition remains unchanged. The component now returns
the actual successful semantic check names, and the control requires the fixed
material/lifetime checks plus each terminal branch instead of an aggregate retry
count. One new fixture compile records1085actual compiler inputs; the separate
prior D02tiny compile is integrated once. This is2successful helper attempts,
0compiler failures; the original control failure stays a test nonpass.

## Remaining actual owning paths

Full early TLSWrap/retained TCP parent, Socket/StreamBase/onread/AsyncWrap/resource
identity/ref/timers and true idle guard remain missing. Pinned hasPendingRead is
a real raw-parent proxy; its earlier absence claim stays corrected. Full writes,
errors/cert/custom verification/sessions/ALPN/CONNECT/options/server/SecureContext
and HTTPS activation remain incomplete. No provider/parent/probe is fabricated.

Real guest CCW/realm/GC/OOM/fatal/Worker/Promise-hook/reentry/acknowledgement and
identified-artifact four-host conformance remain unvalidated. All original
nonpasses/skips stay visible; no finding closes. No engine/kernel/product/full
build or overall suite ran. Nested guest Wasm remains in scope for the last phase.
