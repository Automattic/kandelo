# Public asymmetric key generation ownership

This source slice supplies `crypto.generateKeyPair` and `generateKeyPairSync`
through the complete unchanged asymmetric section of Node26.13.0
`lib/internal/crypto/keygen.js`. Symmetric generation remains its separate
232 owner. The audited pin/source/native reference is unchanged.

## Actual consumed owners

`asymmetric-keygen-sources.json` pins complete upstream files and exact Setup
function sections. `generate-asymmetric-keygen.py` verifies every byte before
rendering those actual RSA/PSS, DSA, EC, DH and named-algorithm operations.
`build.py` inserts the full public algorithm section into the private adapter;
bootstrap assigns that actual factory to the exposed crypto object.

The native bridge resolves primitive algorithm and encoding configuration,
digest/curve/DH-group/provider availability and secure passphrase storage before
allocating and initializing a real request. Five genuine job classes use
`KEYPAIRGENREQUEST`, its actual async identity/frame and the existing234
publication transaction. Public encoding getters retain upstream order before
native algorithm admission; copied passphrase/prime storage never references a
movable JS pointer on a worker.

A genuine CPU NativeWork owns the native operation and roots its actual request.
The existing per-context queue, cancellation, native callback scope, fatal
policy and retirement owners remain authoritative. Cancellation/teardown skips
callbacks. Result encoding precedes `ondone` lookup; the actual getter runs
once before callback-frame entry and a non-function admits no callback scope.
Ordinary status-OK encoding exceptions become `[error, undefined]`. A failed
key generation's error-decoration exception retains the generic CryptoJob
one-argument asynchronous exception route; synchronous failure propagates the
original exception. OOM is not converted into an ordinary crypto callback.

The native algorithm registry supplies actual named OKP/PQC availability; there
is no invented support list. RSA/PSS configures real modulus/exponent/digests/
MGF1/salt constraints. DSA/DH/EC use real parameter generation as required.
The worker only manipulates ncrypto/OpenSSL RAII values. The main thread uses
existing actual key material and immutable public/private roles, sharing one
GC-owned material cell across real handle wrappers like pinned KeyObjectData.
A newly added native fatal private-role admission guard covers reflectable
rawPrivate/rawSeed/ecPrivate methods, including borrowed PrivateKeyObject.export
on a public key, before accessing actual private material. It also guards the
existing ecPkcs8 dispatcher name. A bounded follow-up now supplies the real
valid-private route through KeyMaterial::ExportEcPrivatePkcs8 and exact
ncrypto::Ec::ExportPrivatePkcs8. It clones EC material, includes reconstructed
public points and emits owned default-DER PKCS8 without generic Export
substitution. The rooted material edge and owned BIO survive private byte
allocation; new guest JSAPI/GC/role behavior remains uncompiled/unvalidated. Public raw/JWK/export/clone gates stay authoritative: sharing private material
does not grant a public role private serialization. Serialized bytes come from
the actual portable owner, including the real compressed-EC point fallback;
private FastBuffer ownership constructs returned binary values. JWK uses the
existing owning exporter. No public Buffer.from/prototype relabeling is used.

## Accounting and evidence scope

Known retained operation/string/passphrase allocations and actual native work
storage are charged at ownership transitions. Inline std::string storage is
not counted twice. Opaque EVP/provider/BIGNUM allocation sizes are not invented
from modulus/prime lengths; complete native heap tracking remains C-009.

Focused controls exercise the actual portable operation and serializers over
the exact native Node26.13.0 ncrypto/OpenSSL3.5.9 symbols. V8/uv/AsyncWrap, a
DER-copy adoption into genuine native key handles and native JWK conversion
are explicit control dependencies; production moves/shares its own real GC
material owner instead. Native PEM signature interoperability does not validate
Kandelo's own sign/verify path. Candidate promisification consumes the actual
candidate values.util.promisify owner and its private symbol.

The guest OpenSSL3.5.9/Node-ncrypto dependencies have separate wasm/config/cache
identities. Matching version numbers do not mean this native helper compiled
or executed those dependencies. Newly authored guest JSAPI, work publication,
realm/CCW/root, OOM/fatal/GC/Worker and four-host behavior remain uncompiled or
unexecuted by these component controls. The component does not cover the later
source correction's generation-error one-argument exceptional boundary.

Initial authored fixture setup failures, native DSA-JWK expectation failure,
first helper destructor abort and private-symbol/native-JS-brand control
failures are retained; they are not passing compatibility. The corrected
16-group differential and four unchanged upstream files per subject remain
scoped component evidence, with all raw commands and exact artifacts preserved.

## Open scope

This is partial progress for crypto.md C-001 and crypto-contracts.md C-015,
with C-009 ownership and C-011 returned metadata prerequisites; no finding is
closed. The old C-008 OpenSSL3.3.2 prose is historical, not the current3.5.9 pin.
WebCrypto generation, KEM/encapsulate/decapsulate, broader DH/ECDH/prime APIs,
complete provider/FIPS/secure-heap behavior and opaque memory accounting remain
independent implementation/evidence gaps. The existing symmetric ondone shim
has a separately recorded source discrepancy and is not silently rewritten.

Skill feedback (porting-software-to-kandelo): used the normal declared input,
private generator/staging and dependency boundary guidance; wrong: none found;
missing: no additional requirement identified for this bounded owner.

## Dedicated EC PKCS8 follow-up evidence

Ordinary public KeyObject.export/generateKeyPair PKCS8 already use generic
material.Export; they are not this private service gap. The existing private
KeyObjectHandle.exportECPrivatePkcs8 wrapper now reaches a real native owner;
this does not activate the still incomplete public WebCrypto algorithms or
job/admission owners. Non-EC/failure retains ERR_CRYPTO_OPERATION_FAILED and
"Failed to export EC private key", rather than generic export or incompatible
options. The251immutable private-role fatal admission remains before access.

Focused15groups compare actual helper/pinned wrapper outputs, named/explicit
P256/P384/P521/secp256k1 and omitted-public-point SEC1, wrongtypeRSA/Ed25519/
X25519, real BIO/material retention over V8GC/input mutation and no public
Buffer.from hooks. Candidate material before/after SEC1/SPKI bytes match the
corresponding native reference before/after outcomes. Both explicit cases
normalize exported/reimported SPKI representation identically; semantic key
equality is separately checked. Exact byte vectors are retained. Initial13/15
wrong representation-stability assumptions remain, not passing evidence.
Two tiny helpers/0compilerfailures, no library/engine/product rebuild. One fresh
isolated native role-fatal negative with explicit coreSoftLimit0 is evidence
for target policy,0compatibilitypasses and not guestguard execution. Native
V8/DER-copy adoption/dependency configuration is distinct from guest JSAPI/
realm/GC/finalizer/OOM/fatal and four-host conformance, all still open.
