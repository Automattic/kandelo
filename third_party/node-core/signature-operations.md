# Streaming Sign and Verify ownership

The complete unchanged pinned `lib/internal/crypto/sig.js` supplies the public
Sign/Verify constructors, Writable inheritance, shared update/_write methods,
validation/getter order, key preparation, options and encodings. The exact
`lib/crypto.js` creator functions are selected by source identity. The four
streaming exports use this owner; the distinct public one-shot crypto.sign/verify
owner is documented in signature-jobs.md.

`signature-platform-adapter.js` delegates private operations through the curated
production adapter to `native-signature.cpp`. Its real GC-finalized handle owns a
`SignatureState` digest context. The destination prototype is checked-unwrapped;
the handle is allocated in its realm and wrapped into the caller realm. Native
state remains rooted through reentrant key parsing. Imported key material is
retained through its rooted real owner, or a unique temporary parser owner.
Actual BufferSource storage uses the existing checked byte-source boundary and
atomic shared-byte capture; strings use the existing native encoding owner.
No JS payload pointer crosses conversion callbacks or persists in native state.

The portable owner adapts the pinned crypto_sig.cc streaming algorithm over the
existing exact ncrypto/OpenSSL primitives: digest update/final, actual asymmetric
key signing/verification, RSA/PSS padding and salt, DSA/ECDSA DER/P1363 conversion.
It consumes terminal state at the target point; malformed P1363 validation occurs
before context consumption, and one-shot-only key algorithms are rejected before
finalization. Provider failures use the existing shared genuine error owner.
Associated engine memory accounts the allocated SignatureState structure; opaque
provider allocations are not represented as measured live bytes or RSS.

The actual shared constants binding is a required production dependency supplied
by the separate constants owner. No second advertised crypto constants table is
created. KeyObject, PEM/DER/JWK/raw parsing depend on the existing key owners;
OpenSSL STORE remains a concrete implementation gap. No fake availability or
native-host production passthrough is added.

Focused controls compile the actual portable owner as a tiny N-API component
using the exact pinned native executable's exported ncrypto/OpenSSL. Acquisition,
prototype installation, DER transport for native KeyObject/JWK, key creation and
Writable scheduling are explicit native component dependencies. Production uses
actual engine KeyMaterial edges. Passing these controls does not compile the
SpiderMonkey wrapper, validate guest libc/kernel/provider configuration, establish
GC/zone/security behavior, or demonstrate four-host conformance.

The separate SignJob owner uses sync/async admission, retained key/data/signature
ownership, context strings, provider one-shot algorithms, prehashed fallback,
small-order EdDSA checks and actual native work/callback lifecycle. Forwarding
one-shot work through streaming Sign would produce different behavior,
including for SM2 and one-shot-only keys. See signature-jobs.md for that owner
and its remaining evidence/dependency gaps.
