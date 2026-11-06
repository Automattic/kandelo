# TLS context trust and completion verification

This source slice addresses custom CA input/trust ownership in S-003/S-011
and the CA-verification error portion of S-002. It does not close those
findings or the secure-network family. The exact Node 26.13.0 target, frozen
audit, broader TLS identity/context/server gaps and old nonpasses remain.

## Real owners and pinned selections

`tls-context-adapter.js` embeds unchanged `secure-context.js` validation,
addCACerts, CA truthiness/array iteration and partial-chain selections.
`tls-context-sources.json` and `generate-tls-context.py` verify complete
reference files, release/commit and exact selection hashes. Falsy CA values,
including the empty string, select existing default trust; truthy empty
Buffer/view/array values select an empty custom store. Array holes follow the
actual pinned ArrayPrototypeForEach policy. No context constructor is faked
as a public SecureContext API.

`native-tls-context.cpp` allocates an actual private SSL_CTX before TCP
startup and owns it through a branded foreground-finalized native class.
String input uses the existing sized UTF8 byte owner; actual buffer views
are checked-unwrapped, rooted and copied over their complete intrinsic view
range, including DataView offsets and detached/out-of-bounds zero lengths.
No public buffer/offset/length getter is read. Shared bytes use atomic byte
loads. CA bytes are parsed synchronously before the connection operation,
so later user buffer/array mutation cannot change the prepared trust store.

`tls-context-trust.h` uses real OpenSSL context/store operations following
pinned LoadBIO/AddCACertificates: explicit-length secure BIO, X509_AUX PEM
reader, no interactive password prompt, X509_STORE_add_cert and client-CA
names, with parser errors cleared on return. Empty/unparseable PEM adds no
trust and is not a context-construction error. Store mutation failure does
not publish a partially configured owner. Pinned Node CHECK_EQ-aborts on
store/client-CA insertion failure; this boundary currently returns a native
failure to the owner. That pressure/fatal difference is unresolved, not an
accepted exclusion or proven parity. The fresh context owns its store;
there is no shared root store to mutate. X509_V_FLAG_PARTIAL_CHAIN applies to
that actual store. Default trust still uses the selected guest OpenSSL
file/directory configuration; Node bundled/system/extra/default trust APIs
remain open. This is not default native trust-store parity.

The selected client handshake claims its own SSL_CTX_up_ref before the JS
owner may be collected. The ordinary OpenSSL 3.3.2 TLS SSL object internally
owns two further references: ssl_lib.c:715 stores ssl->ctx and 814 stores
session_ctx. SSL_free releases those through the method destructor at 1434
and base context at 1389. Thus the ordinary pre-retirement total is four:
one JS holder reference, one explicit watch/handle reference and two inside SSL. The earlier simplified
three-reference description is superseded, not teardown proof.

## Verification and cleanup fence

The additive shell patch uses the target's continuing verification callback
and SSL_VERIFY_NONE client mode (crypto_tls.cc:80–94,540,1327–1356), then
checks the actual completed SSL connection's VerifyPeer result. A captured
rejectUnauthorized=true rejects before allocating or publishing any TLS
handle or plaintext. Missing peer state is an error except for the actual
pinned authenticated PSK/resumption branches. Allowed-error mode retains the
real error and authorization state. Public certificate/hostname/custom
identity policy and complete error phase/schema parity remain open.

The error is an actual native Error with the pinned verification code and
selected GetValidationErrorReason text, including its normal source hint.
The selected backend has no Node use-system-ca option owner; parity for that
flag/store choice remains open rather than inventing a configured field.
Live verifyError metadata uses the same Error owner. Non-verification TLS
alert/setup/cancel errors still need their complete target schema.

TLS completion enters the real rooted operation Promise's realm. TLS dispatch
and referenced-watch admission filter by its owning JSContext before any
Promise access/settlement. Objects/errors are constructed inside that realm;
no raw realm pointer or foreign-thread JS root is retained. This does not
establish safe global SocketWatch-list concurrency or context teardown.

The existing success path transfers SSL and the explicit SSL_CTX reference
to the real handle, then clears watch ownership. Promise publication failure
closes that handle. Live-handle cleanup keeps SSL_free before explicit
SSL_CTX_free. Verification rejection, full-table/error/watch/Promise/setup
failure and socket cancellation retain cleanup ownership; no failed host/
SNI/BIO configuration silently falls through to a verified success. Native
watch/context/worker/fatal/reentry branches remain source-reviewed only.

Only the exact C++ holder allocation is charged to GC. Opaque OpenSSL context,
certificate/store/secure-BIO heap and pressure accounting are unproven. The
class's finalizer makes it tenured by SM140 GetInitialHeap rules
(JSObject-inl.h:319–321); no nursery plain object is used as a credit anchor.
No complete JSAPI/GC/physical retirement or pressure claim is made.

## Focused evidence

`tests/nodejs/run-tls-context-controls.py` takes explicit native Node, source,
existing selected OpenSSL libraries and output paths. Through dev-shell it
runs source/bundle/input/syntax checks, builds host-only NAPI/allocation
components, then compares 32 actual local TCP/TLS cases, 11 exact validation
cases and 10 actual default-path/custom-empty-store branches. Complete view
ranges, Float16/16/64-bit views, shared views, NULs, trusted AUX PEM, duplicates,
empty/invalid data and detached/OOB views are covered. A real handshake
survives release of the JS holder's native reference after trust capture.

The reference deliberately runs --use-openssl-ca with the actual fixture CA
file; it is not native default bundled-store parity. Partial-chain cases
explicitly disable hostname checking on both component peers, as the pinned
upstream partial-chain test does. Those establish CA-chain behavior only.
The first run's two hostname/identity differences remain recorded; narrowing
later component cases does not turn them into accepted API exclusions.
The initial reject-untrusted error mismatch is also preserved; the subsequent
actual verification/completion owner fixes that case without allowing an
unauthorized connection.

Thirteen actual OpenSSL SSL_new allocation-site faults and the ordinary/
unreached-site controls leave zero tracked OpenSSL allocations/bytes after
isolated-process cleanup. These are real allocator hooks, not invented
refcount metadata or production JSAPI/watch fault proof. The first harness
incorrectly expected faults at three nonexistent allocation sites; its
assertion failure and corrective complete observations remain recorded.

NAPI is an explicit fixture boundary. It executes the portable trust owner
and selected reason logic against actual OpenSSL 3.3.2 and real TCP, but it
does not compile or execute the production SpiderMonkey class/watch/error
bridge. The NAPI async work owns only native context references/descriptor/
copied results; its main-thread completion owns JS publication. Production
uses the existing nonblocking SSL socket watchers, not this host test worker.
No host component result proves production JSAPI/guest behavior.

The affected source-only TLS identity file retains 6 passing tests and 1
nonpass: its unchanged URL-export extraction supplies a url Function
parameter while the selected unchanged block declares const url. The
SyntaxError occurs before that case's assertions. It is preserved; no URL
fixture assertion is weakened or source rewritten in this TLS slice.

## Open owning work and validation

Public SecureContext/key/cert/PFX/CRL/cipher/protocol/session/server APIs,
default/bundled/system/extra CA APIs, exact option/getter/overload ordering,
SNI/IP/hostname/custom identity and certificate/error objects remain partial.
Pending handshake cancellation/ref/deadline, asynchronous TLS shutdown,
complete socket inheritance/generation and all error/fatal phases remain open.
The global SocketWatch/TLS-handle tables still need complete per-context/
thread isolation and teardown ownership; Child-only shutdown is not evidence
of TLS retirement. The narrow completion-realm fix does not close them.

No engine/package/guest/product build, global setup, overall suite, production
JSAPI/GC/worker/realm/OOM/pressure execution or Node/Chromium/Firefox/WebKit
conformance ran. Host component builds are recorded explicitly. Root assigns
the final engine patch number and reconciles additive shared hunks against
its current source; the private 0110 proposal label is already used elsewhere
in root and must not be treated as the final integration number.
