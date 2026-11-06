# Actual TLS trust ownership and verification integration

Source142 reconciles the sealed TLS proposal with source141, retaining the
current VM module/CLI, HTTP outgoing, ELD and backing-store owners. Five whole
Node26.13.0 references match the exact frozen source archive. Unchanged pinned
CA validation, array iteration, truthiness and partial-chain selections feed a
real eager OpenSSL SSL_CTX before TCP startup. Sized string/view bytes are
captured intrinsically. Empty/unparseable PEM selects real trust state; it does
not become a context-construction failure. Configured guest OpenSSL defaults
remain a distinct incomplete contract from Node's bundled/system/extra stores.

The context wrapper, explicit watch/handle claim and SSL object's two internal
references retain their actual OpenSSL owners. Continuing certificate verification
finishes before captured rejectUnauthorized is enforced: rejection precedes any
TLS handle/plaintext publication. Completion enters the rooted Promise realm,
and TLS watch dispatch/liveness filters its owning context. The actual TLS Error
uses pinned code/reason selection and ordinary [[Set]] behavior. These JSAPI,
GC/realm/watch and teardown source changes remain uncompiled and unvalidated.

Root review additionally found that ClaimContext reports an actual JS exception
but its old caller tried to allocate a generic rejected Promise while that
exception was pending. The caller now closes its fd and returns the exception.
Synchronous native attach exceptions use actual TLSSocket.destroy, retiring
queued write callbacks with the same error. The root control reproduces the
old unwanted synchronous throw before the fix; identical assertions pass for
synchronous and rejected native dependencies over the real bootstrap class and
native Duplex. It proves that JS lifecycle slice, not the guest native boundary.

The root focused OpenSSL runner records25 passing groups:32 actual local TCP
comparisons,11 validation cases,10 default/custom-empty branches,13 reached
SSL_new allocation faults and4 ordinary/unreached controls. The two component
compiles are host helpers, not engine/package builds. Native default mode uses
explicit --use-openssl-ca and actual SSL_CERT_FILE; CA-only partial-chain cases
disable identity on both sides. These are not bundled-default or hostname proofs.

The existing TLS identity extraction fixture reproduced6pass/1SyntaxError before
assertions: its url parameter conflicted with the extracted actual const url and
it omitted the newer URL/path factory dependencies. Root repairs only that local
harness, preserving every upstream/public assertion. The affected TLS/header and
package source checks then pass without skips. Original fixture failure,
agent hostname/reject diagnostics, allocator-harness failure and source patch
rebase failure remain identified evidence, not silently overwritten results.

Open implementation and evidence requirements include public SecureContext,
key/cert/PFX/CRL/protocol/cipher/session/server owners; default CA APIs; hostname,
IP/SNI/custom identity; option/getter/overload order; prompt cancellation/ref/
deadlines and shutdown; global watch/handle thread/context retirement; production
JSAPI/GC/OOM/error-setter/fatal behavior and four-host conformance. Node's fatal
CHECK_EQ on CA-store mutation failure differs from this boundary's error return;
that is an unresolved implementation gap, not an accepted platform exclusion.
No API/family closure, kernel/host/wire ABI or target change is claimed. No engine,
package, kernel, overall-suite or full-product build ran in this root slice.

See [TLS dependencies](tls-context-trust-implementation-dependencies.md) and
[tls-context-finding-progress.json](tls-context-finding-progress.json).
