# Genuine curve inventory and remaining WebCrypto normalization owners

Public `crypto.getCurves()` consumes the linked ncrypto `Ec::GetCurves`
implementation. That implementation enumerates builtin EC groups and filters
through the actual OpenSSL provider/default properties. The bridge retains
owned name bytes under the existing process FIPS-state lock, then releases the
lock before allocating JavaScript arrays and strings. Publication creates own
array elements and propagates native allocation and JSAPI failures through the
existing crypto guard. No key, provider, pointer or synthetic capability ID is
returned. As in the pinned ECDH query, the backend boolean is not converted into
a new success/failure policy or an invented capability result.

The unchanged pinned `getCurves` declaration consumes the existing unchanged
ordinary-execution FIPS-generation cache loop and name filtering algorithm.
Generation is reread after enumeration, and a change retries rather than
publishing the mismatched inventory. Every return copies the retained array.
The existing bootstrap assigns the digest factory API into the public crypto
object. The curated adapter, native registration and native definition are all
part of this source contribution. V8 snapshot serialization is still absent;
this does not install a snapshot stub or claim that lifecycle is implemented.
Curve names are inventory, not a promise that every named group can be used for
a particular key operation or under every policy.

This is partial owning-source progress for qualified C-015 in
`tests/nodejs/audit/crypto-requirements.json` (`getCurves`, obligation
`export:node:crypto:43`) and the provider metadata section of
`tests/nodejs/audit/crypto-contracts.md`. It does not close that finding or the
crypto family. The native query and registration remain uncompiled in this
source packet; no candidate runtime, FIPS mutation, OOM, GC, Worker, realm or
four-host conformance is established. No new tests, compilers, generation or
builds were run for this slice.

The original requested C-007 normalization prerequisite remains an actual
implementation gap. Current `KeyObject.toCryptoKey` reaches the pinned WebIDL
conversion but `internal/crypto/util.normalizeAlgorithm` still throws the real
missing-owner error. Exact `getConditionalAlgorithms` eagerly consumes real
key-algorithm availability, provider cipher/hash/MAC inventory, actual AES-OCB
build authority, Argon2Job and KmacJob. A missing KMAC implementation cannot be
replaced with false capability metadata. Native key-algorithm availability,
KmacJob and the real algorithm import modules remain to be implemented before
normalizer activation can be truthful. Existing Argon2, WebIDL, FIPS generation,
KeyObject and CryptoKey owners must be reused. AES/RSA/EC/CFRG/ML-DSA/ML-KEM/MAC/
ChaCha import owners, operation dispatch and Subtle/Crypto globals are not
implemented by inventory enumeration. No missing owner is accepted as an
engine/platform boundary, and no old negative outcome is relabeled a pass.
