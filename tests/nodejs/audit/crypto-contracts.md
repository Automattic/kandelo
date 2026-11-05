# Crypto and scoped Web Crypto contracts

State: **source review complete with implementation gaps** for
`node:crypto`, including its returned objects and Web Crypto dependencies.
The scoped Web Crypto review does not complete the web family. No runtime
test, probe, compilation or build ran. Neither cryptographic correctness
nor current four-host conformance is established by this source review.

`crypto-requirements.json` preserves every original crypto section and
descriptor, the scoped Web Crypto sections, source identities and additional
returned/inherited requirements. The original discovery rows are obligations,
not a unique-API denominator. A negative review establishes that the public
operation has no implementation route; it does not certify the internals of
an unconnected backend or sign off the eventual implementation.

## Exact owners and exposure

The target remains Node **26.13.0**, source commit
`18b32a3b1552e199a01f1a8d9fd64aa756d3b75b`; see
[the official pin review](target-pins.md). No target changed. The native
reference reports OpenSSL 3.5.9; Kandelo's source recipe selects 3.3.2.

The active candidate is `packages/registry/node-compat/bootstrap.js`:
3963–4118, registered at 5792. The native digest/HMAC implementation is the
frozen post-53 shell source identified in `state.json`, `js.cpp`:303–359,
398–586. Searches of the final registry, later overrides and core adapter
show no subsequent crypto implementation. `adapter.js`:31–34 returns false
for both key predicates because guest KeyObject/CryptoKey objects do not
exist. This is not delegation to the embedding host's Node crypto.

Target `lib/crypto.js`:176–415 defines the namespace, lazy aliases,
deprecations and immutable getters. Kandelo supplies an ordinary object:
even present methods do not establish class, descriptor or alias parity.
`node:crypto` and bare `crypto` reach the guest builtin registry; named ESM
exposure depends on the actual loader. Missing members cannot become
implemented merely by a successful default import. Loader errors, live
namespace synchronization, `require.cache` bypass and no-crypto target builds
remain explicit loading-family dependencies, not crypto algorithm success.

Target constants come from `src/node_constants.cc`:865–1083 and backend
compile-time guards. `crypto.constants` is an enumerable, nonconfigurable,
readonly namespace property; `defaultCipherList` is a lazy configurable
getter/setter which materializes a writable enumerable value. Its default
comes from the TLS command-line option; it differs from
`defaultCoreCipherList`. All candidate crypto constants are missing. Saved
native numeric values are evidence for that exact build, not permission to
invent values or advertise algorithms that cannot be fetched.

The deprecated `prng`, `rng`, `pseudoRandomBytes` aliases are also missing.
The target first exposes configurable nonenumerable accessors, then caches
the actual randomBytes function, or a DEP0115 wrapper under pending
deprecation; assignment materializes an enumerable property. `fips` is a
deprecated getter/setter. `getDiffieHellman` and
`createDiffieHellmanGroup` are the same target function. Exported Hash/Hmac
constructors have deprecation wrappers, while the factories use raw classes.
Function prototypes in the saved capture include ordinary incidental
prototype objects, not additional supported constructors.

## Existing digest and random paths

| Surface | Required behavior and actual candidate disposition |
|---|---|
| Hash/createHash | Target `internal/crypto/hash.js`:60–166 validates the algorithm, outputLength and cSHAKE options, owns a native digest, extends LazyTransform and implements update/digest/copy and stream hooks. Candidate returns a plain closure-backed object with own update/digest, four exact lowercase algorithm spellings, no options/copy/stream state. Borrowing a public method still operates on its captured handle, bypassing the target receiver/state contract. |
| Hmac/createHmac | Target hash.js:169–244 uses secret KeyObject/CryptoKey or encoded bytes and a real Transform. Candidate shares the plain-object model and only raw native input conversion. Target Hmac.update aliases Hash.update. Candidate has neither public class nor alias/inheritance. Target source returns empty bytes on a repeated Hmac.digest; candidate throws a plain error. The prose disagreement is retained below. |
| Input and output encodings | Candidate native conversion encodes strings as UTF-8 then uses `strlen`, dropping bytes starting at embedded NUL, including HMAC keys. Public inputEncoding/key options are ignored; native accepts raw ArrayBuffer though target Hash.update requires a string or ArrayBufferView. Nonshared views use actual byte spans; shared views are rejected. Public output conversion uses the candidate Buffer codecs after native digest consumption, so Buffer/encoding errors and state order matter. |
| Native lifetime | Real EVP_MD_CTX/HMAC_CTX objects are allocated, updated, finalized and freed; finalizers free abandoned contexts. Native finalization consumes the context before allocating the JS result. JS object allocation precedes installation of its private state; allocation/init failure leaves a reserved slot whose finalizer assumes a private pointer. That failure path needs a later allocation/GC control; no crash was observed. Temporary input/key vectors have no explicit cleansing or external memory accounting. Reference ByteSource ownership zeroes its allocated storage (`crypto_util.cc`:744–750), which is a distinct native-lifetime requirement, not a claim that all JS strings can be erased. |
| getHashes/hash | Candidate list is freshly returned but fixed at sha1/sha256/sha512/md5 and matches its narrow native resolver. Target provider aliases and cached availability/FIPS generation logic are absent. One-shot hash, including options, output length, default hex and byte input rules, is missing. |
| randomBytes | Candidate allocates before callback validation, ignores nonfunction callback arguments and does entropy work synchronously before queueMicrotask. Target validates arguments, caps signed-32-bit sizes and uses a real asynchronous RandomBytesJob when a callback is supplied; error classes, receiver, callback phase and async resource lifetime differ. |
| randomFillSync | Candidate uses byte offsets/counts for every view; target multiplies by typed-array element size, with ArrayBuffer/DataView byte units. Candidate weak range/brand checks allow early unchanged returns for some negative or oversized spans and do not correctly fill a raw ArrayBuffer. Target `random.js`:40–205 accepts branded ArrayBuffer/SharedArrayBuffer/views with exact span/size conversion and returns the original object. |
| randomFill | Entire callback API is missing. Target overloads validate callback and offset/size; its zero-size fast path invokes the callback immediately, while nonzero work uses a native asynchronous job. A blanket rule that every callback must be deferred would be wrong. |
| randomInt | Candidate does actual unbiased rejection sampling, not modulo-biased Math.random arithmetic. It lacks callback/cache/refill behavior and coded errors and accepts a range of exactly 2^48; target maximum range is 2^48−1. Safe integer endpoints and min/max overloads need exact validation. |
| UUID | Candidate produces actual v4 version/variant bits and lowercase formatting from 16 entropy bytes. It ignores options and does not implement disableEntropyCache validation or the target cache lifecycle. UUIDv7 is missing; target has a 48-bit wall-clock millisecond prefix and random remaining bits, with no strict monotonic guarantee. |
| getRandomValues | Candidate duck-types buffer/byteLength and accepts invalid brands, including floating views/DataView/forged records. It returns the original input on success but uses generic errors, no WebIDL receiver or required-argument checks. Target rejects floating views including Float16Array; accepts integer typed arrays including BigInt views; oversized input produces the target quota exception, wrong integer brand a TypeMismatchError. |
| timingSafeEqual | Candidate coerces arbitrary inputs through Buffer.from and compares with a JS XOR loop. Target `crypto_timing.cc`:23–83 requires genuine byte-buffer sources, exact lengths, ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH and CRYPTO_memcmp. No constant-time backend contract or timing property follows from the candidate loop. |

These are C-002 through C-006 and C-009 through C-013. Native callbacks,
errors, AsyncResource context, actual work cancellation/shutdown and native
pins cannot be supplied by cosmetic callback deferral. The existing shared
native work machinery is a potential owner, not evidence crypto uses it.

## Entropy across every layer

`_fillRandomBytes` opens `/dev/urandom`, aliases the target bytes with
Buffer.from(ArrayBuffer, offset, length), retries positive short reads and
closes the fd in finally. Buffer.from really aliases here
(`bootstrap.js`:1178–1209); no copy-only explanation is supported.
Close errors are swallowed. The source route is:

1. `fs-stats-adapter.js`:39 → `native-fs-promise.cpp`:615–654 validates the
   actual fd/view/span and calls libc read, retrying EINTR.
2. musl `src/unistd/read.c` → channel/direct syscall glue. Requests larger
   than CH_DATA_SIZE (65,536) use `kernel-worker.ts`:12120–12130,
   20217–20262 and 20027–20061. Reserved scratch stages the **whole** request
   (19890–19955), rather than splitting the read into entropy-sized calls.
3. `kernel/src/wasm_api.rs`:8958,9006–9023 executes that actual byte slice;
   `runtime-core/src/syscalls.rs`:6181 dispatches Urandom to host_getrandom.
4. WasmHostIO (`wasm_api.rs`:852–869) invokes the real host. The explicit
   image-build deterministic stream is separate build-image state; no
   evidence says normal user execution has enabled it.
5. `host/src/kernel.ts`:2206–2233 creates an independent Uint8Array for
   the **whole** destination, calls host crypto.getRandomValues once,
   copies back to the lent kernel destination and converts exceptions to
   errno. It does not retain a shared guest/kernel backing store.

**C-014:** the whole large read therefore exceeds the Web Crypto call quota.
The host catches the exception instead of returning a positive short read;
the guest fill loop cannot repair it. This is a source-derived failure path,
not a newly observed runtime outcome. The separate getrandom marshalling
short-count rule cannot be assumed to clamp Urandom read. The standard's
per-call 65,536-byte limit is documented in the
[W3C getRandomValues algorithm](https://www.w3.org/TR/webcrypto-1/#Crypto-method-getRandomValues).
Its 2017 integer-type list does not supersede Node 26's newer BigInt brands.

**C-003:** if host Web Crypto is absent, this same host function fills with
Math.random. That contradicts an unconditional cryptographically secure
source guarantee even though the ordinary modern-host branch uses real
Web Crypto. A missing host CSPRNG is a reason to fail truthfully or provide
a real source, not to report weak bytes as secure entropy.

The eventual owning fix must preserve actual read/getrandom semantics,
ownership, errors and cryptographic strength at the host/kernel boundary.
Application-specific randomBytes splitting would leave the shared defect.
No implementation is authorized by this conclusion.

## Missing public algorithms and returned objects

| Group | Target contract and missing candidate route |
|---|---|
| Cipheriv/Decipheriv | Factories are throwing stubs; class exports and all returned behavior are absent. Target cipher.js:125–287 owns real Transform/native state, update/final, decoder continuity, padding, AAD, tags and failures. CCM requires one update, declared plaintext length with AAD and valid nonce/tag sizes; CBC-CTS/XTS/key-wrap/SIV modes have whole-message restrictions. AEAD plaintext before authentication is provisional; final must verify it. CTS variants, SM4-XTS standards, key/IV formats and authenticated failure behavior must reach actual provider configuration. |
| Certificate | Class/statics/legacy instances are absent. Target certificate.js implements matching static/prototype verifySpkac, exportPublicKey/exportChallenge functions, encoded input, native SPKAC verification and exported bytes. It is not an X509 alias. |
| KeyObject and key import/export | createPrivateKey/createPublicKey throw; createSecretKey and class/returned subclasses are absent. Target keys.js owns native key handles and branded type/size/details/equals/export/toCryptoKey/from contracts. Public/private/secret objects have distinct authority; deriving public from private must not permit later private export. PEM/DER/JWK/raw-public/raw-private/raw-seed support varies by algorithm. Encryption, passphrases, named curves, RSA-PSS parameters, seed and metadata preservation are required. equals is explicitly not constant-time. |
| OpenSSL STORE/PKCS12 | No candidate route. Target URL private-key loaders apply the explicit openssl-store permission and properties/PIN handling, not ordinary fs/net permission scopes. Loader schemes do not prove hardware provenance. parsePKCS12 returns privateKey/certificate or null plus additional certificates, with native bundle/passphrase errors and owned key/certificate objects. |
| DH/groups/ECDH | All APIs/classes absent. Target diffiehellman.js:84–365 owns prime/generator/group and key state, verification flags, encoded secrets, public-point conversion/format/curve validation. Group methods deliberately omit key mutation. ECDH shares some DH method identities; deprecated setPublicKey has a wrapper. One-shot exchange has sync/callback paths and matched-key types. |
| Sign/Verify | One-shot methods throw; class/factories are absent. Target sig.js has real Writable inheritance and shared update/_write method identities, encoding, signature terminal state, RSA padding/salt, DER/P1363 formats and key/context requirements; one-shot callback work is native asynchronous work. Null digest requirements for Ed25519/Ed448/ML-DSA are algorithm-specific. |
| Key generation/primes/KEM | generateKeyPairSync throws; remaining APIs absent. Target keygen.js, random.js and kem.js use actual native jobs and strong entropy; callback and sync return shapes differ. generateKeyPair carries a nonenumerable customPromisifyArgs symbol for public/private results. HMAC bit lengths truncate to whole bytes, AES lengths are restricted; safe primes/add/rem/bigint/endian constraints, validated DH/EC/RSA/PQC parameters and encapsulation ciphertext/shared-secret formats all matter. |
| KDFs | PBKDF2/HKDF/scrypt/Argon2 sync/async APIs absent. Input bytes, encodings and empty values; iteration/output/memory bounds; scrypt N/r/p alias conflicts; Argon2 variant, lanes/blocks/passes/nonce/tag/secret/associated-data constraints; HKDF info/output bounds and algorithm suitability require native execution. HKDF returns ArrayBuffer, other documented KDFs Buffer. Validation throws differ from work failures delivered via callbacks. |
| Provider MAC | createMac/getMacs missing; Mac is a returned Transform class, **not** a namespace export. Target provider_mac.js:57–258 validates provider-advertised parameter types, digest/cipher/IV/customization/salt/outputLength; it does not truncate a default tag to fake outputLength. update failure or attempted finalization consumes state. Zero-byte tags have distinct direct-return versus stream chunk behavior. |
| X509 | Only a throwing constructor exists. Target x509.js owns PEM/DER parsing, native brand/cache, fields and dates, issuer graph, public key/raw bytes, fingerprints, escaped SAN/AIA formatting, matching flags, signature algorithm/OID, issuance/private-key/signature checks and legacy/PEM/JSON views. checkIssued is metadata pruning, not a chain trust verifier. verify only checks this certificate's signature. Source checkIP also validates an options argument although prose documents one argument. |
| Metadata/FIPS/secure heap/engines | Entire public route absent. Provider/cipher/hash/curve/MAC lists and getCipherInfo must reflect fetchable implementations and active properties, not static promises. FIPS state reports the default property query, not certification or necessarily a loaded provider; forced startup state and worker setFips restrictions matter. secureHeapUsed must report actual allocations. Deprecated setEngine remains observable, including configured no-engine failure. |

These groups include C-001, C-008 and C-015. C-011 separately records
missing namespace aliases/descriptors, constants and actual capability
metadata, rather than treating backend linkage as public API exposure.
Their additional inherited
EventEmitter/Writable/Readable/Transform methods, iterator and disposal
symbols, error and close behavior depend on the stream/async families.
Key/CryptoKey/X509 cloning, native lifetime and realm brands depend on the
worker/engine families; JSON-like copying cannot replace native ownership.

The OpenSSL recipe disables assembly, threads, dynamic/shared libraries,
engines, OpenSSL ASYNC, applications and POSIX I/O. These are selected build
features, not proof of a WebAssembly impossibility. `no-async` specifically
does not mean a host-managed Node callback work queue is impossible.
OpenSSL 3.5 introduced ML-KEM, ML-DSA and SLH-DSA according to its
[official release notes](https://openssl-library.org/news/openssl-3.5-notes/).
Linking Kandelo's 3.3.2 cannot establish those algorithms or Node's newer
provider behavior. Recipe selection is not installed artifact identity.
Conversely optional OpenSSL-4 cSHAKE customization is conditional even in
the pinned 3.5.9 reference; an unavailable optional provider algorithm is
different from Kandelo's missing namespace/binding. No FIPS certification,
hardware-backed key source or dynamic provider support is asserted here.

## Scoped Web Crypto review

Target `internal/crypto/webcrypto.js`:83–119,1775–2188 and
`keys.js`:1232–1479 define branded illegal constructors, singleton Crypto
and SubtleCrypto objects, methods/descriptors/tags and CryptoKey state.
Kandelo's conditional fallback global (`bootstrap.js`:6858–6869) has only
getRandomValues/randomUUID. Its later getter normalization (7390–7429)
preserves that object, not the missing interfaces. If a realm already has
a crypto global, the conditional branch retains it; source inspection
alone has not established every realm's initial global object. Neither
branch supplies the missing `crypto.webcrypto`/`crypto.subtle` guest alias
or establishes interoperable native keys.

Every SubtleCrypto operation is missing: encrypt/decrypt/sign/verify/digest,
generate/import/export/getPublicKey, deriveBits/deriveKey, wrap/unwrap and
the four encapsulation APIs. The target returns genuine promises even for
argument/brand failures, copies/normalizes BufferSources and dictionaries,
applies key algorithm/type/usages/extractability and native errors, and
protects result-promise settlement against inherited then mutation. Native
job roots and lifetimes must survive async completion and process shutdown.

The missing static SubtleCrypto.supports method is synchronous, requires
two arguments, validates WebIDL conversions and checks actual operation
and algorithm parameters plus additional derived/imported/wrapped-key
algorithm requirements. Unknown operations and unusable combinations return
false after required conversions; it is not a fixed algorithm-name table.
Target `util.js`:506–659 derives conditional capability from actual native
providers and FIPS generations. Its experimental-warning set is separate
from support and must not be treated as an unsupported list.

`crypto-requirements.json` preserves the complete operation/algorithm/key
format matrix and each parameter member. AES modes, RSA/EC/Edwards keys,
SHA/SHA3/SHAKE/KT, HMAC/KMAC, KDFs, PQC and hybrid KEM requirements are
missing from the guest route, including byte/bit units, IV/counter/tag
lengths, context and customization bounds, JWK validation, key usages and
export constraints. Modern/secure-curve proposals are explicit Node public
extensions; outer browser algorithm availability is not guest support.

CryptoKey properties are readonly accessors over real internal state.
The target caches returned mutable algorithm/usages metadata separately
from authoritative handles/rights. Mutating that metadata must not grant
new key authority. KeyObject/CryptoKey conversion, worker structured clone,
cross-realm brands and secret/key-pair ownership remain native requirements.
CryptoKeyPair, EncapsulatedBits/Key and parameter types called “classes”
in prose are dictionaries, not missing public constructor exports.

## Host differences, boundaries and unresolved controls

All four embedding hosts share the guest facade, native Wasm digest and
guest entropy path. Outer host Web Crypto is used for entropy only. The
ordinary per-call quota applies on Node as well as browsers. Browser
secure-context/CSPRNG exposure, actual host API presence, memory budgets,
Node thread termination versus browser quiescence and worker ownership are
relevant conditional host facts, not measured results from this audit.
There is no accepted engine boundary excusing missing portable crypto,
key brands, algorithms, validation or module exposure. Native dynamic
providers, hardware devices and FIPS certification require concrete
platform/configuration decisions and truthful capability/error metadata.

**C-016 target questions:** source and prose differ on repeated Hmac.digest
(empty versus throwing) and module getRandomValues (prose permits broad
sources while current source delegates to strict branded Web Crypto).
KeyObject.from rejects hybrid keys with a secondary handle despite its
general CryptoKey description. X509 checkIP validates an extra options
argument. Later exact-native controls must retain these distinctions,
without changing assertions or silently selecting convenient behavior.
Allocation/GC failure safety in C-009, digest consumption versus bad output
encoding, detached/resizable/shared/foreign buffers, secret zeroization,
concurrent provider changes and actual native feature lists remain explicit
validation questions. They do not turn a known missing API into a boundary.

Historical evidence retains its exact source/artifact identities in
[existing-evidence.md](existing-evidence.md) and the archive/index. The old
full-suite common-helper failures prevent claims about later crypto bodies;
no previous digest smoke result establishes this unbuilt candidate or
security/async/lifetime behavior. No current-candidate four-host crypto
conformance is established.

## Proposed later work, not authorization

Dependency order: real host CSPRNG quota/failure semantics and Buffer/brand/
encoding owners; exact backend/provider capability and safe native lifetime;
digest/HMAC/constant-time comparison and stream interfaces; native key and
certificate representations; ciphers/signatures/exchange/keygen/KDF/MAC;
full WebIDL/Web Crypto integration and cloning. TLS and HTTP security
inherit these owners. Missing OpenSSL metadata must report actual state.

`crypto-validation-candidates.json` identifies unchanged future test sources,
flags and fixture/helper roles, including relevant WPT coverage. It is not
an executable denominator or a completed resource/variant closure. Later
native differential controls should cover all four hosts, exact pin and
provider/flag variants, known vectors and corrupted authentication; Unicode/
NUL/encoding, alias/descriptors/receiver brands, byte versus element units,
65,536-boundary and large entropy reads, range 2^48, zero-size callback
timing, Hmac redigest, native errors/provider modes, immutable key authority,
GC/async/failure/shutdown ownership and unchanged upstream skips/timeouts/
harness outcomes. Sample outputs cannot prove cryptographic strength or
constant time. No new test, control or build was executed.
