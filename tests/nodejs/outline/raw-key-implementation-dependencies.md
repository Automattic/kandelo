# Actual raw asymmetric key import ownership

Source126 now adds [actual JWK material/import/export](jwk-implementation-dependencies.md).
Earlier source100/101/123statements below retain their historical scope.
Current guest/four-host and complete key/crypto conformance remain open.

Source123 extends the existing private key-operation boundary. It changes
Node compatibility code and the engine embedding only; no kernel, libc,
syscall, host-wire protocol, ABI version or memory ceiling changes. The exact
Node26.13.0 target/source/native pins and136 frozen audit deliverables remain
unchanged. This is partial C-001/C-007/C-009/C-011/C-015 work, not closure of
crypto or any individual public API. All19 families remain partial.

## Implementation and reused source

The unchanged full pinned `lib/internal/crypto/keys.js` owns public overloads,
raw/public/private restrictions, byte-input validation and option reads.
`native-keys.cpp` now dispatches RAW_PUBLIC/RAW_PRIVATE/RAW_SEED before the
PEM/DER integer-encoding parser: the raw encoding position contains an
algorithm string, not a PEM/DER encoding number. It copies actual source
bytes, reads algorithm/curve strings with their complete UTF-8 length and
owns real immutable material through existing reserved-slot GC edges.
Embedded NUL suffixes cannot become accepted algorithm aliases. The
upstream error message intentionally uses its C-string spelling.

`key-operations.h::KeyMaterial::Raw` follows the complete pinned
`src/crypto/crypto_keys.cc` raw importer and format policy:

- Exact public algorithm names, actual provider availability and allowed
  raw/public/private/seed combinations are checked in target order.
- EC public points are decoded against the actual named group; private
  scalars use the group order's exact byte width and derive their real
  public point with group multiplication. ncrypto pointers own/free
  temporary points, groups and cleansed scalars on every branch.
- OKP and PQC material goes through unchanged ncrypto `NewRawPublic`,
  `NewRawPrivate` or `NewRawSeed` into OpenSSL3.5.9. A public-role view of
  private input retains the real shared material and serializes public data.
- No advertised algorithm inventory substitutes for a provider operation.
  Missing/unavailable/wrong-length/invalid-point imports fail visibly.

The first portable comparison found two real encoding mismatches: ML-DSA
and ML-KEM private PKCS#8 serialization expanded private material instead
of matching Node's seed-preserving policy. Node's pinned
`src/crypto/crypto_util.cc:529` calls unchanged ncrypto
`ConfigurePqcEncoding`. This owner now calls it once before first
serialization, after import has loaded its provider, with `std::call_once`
so concurrent exports do not repeatedly mutate provider options. No upstream
source or serialized bytes are patched. Dynamic provider activation/FIPS
and later configuration transitions still require their own lifecycle audit
and implementation; this initialization is not that complete contract.

Native errors carry codes and messages, not constructor names. The key JS
bridge now maps ERR_INVALID_ARG_VALUE and ERR_CRYPTO_INVALID_CURVE to the
pinned TypeError category. The native-boundary fixture matches that packet
shape, so the constructor comparison does not depend on names supplied by
the outer Node binding.

## Focused evidence and limits

The ledger `raw-key-finding-progress.json` binds exact report/source hashes.
These denominators are separate and do not sum to public-API conformance:

| Evidence | Result | Scope |
| --- | --- | --- |
| Portable owner vs Node26.13.0 |92 pass,0 fail|Actual DER bytes and errors over11 EC/OKP/PQC variants, private/public projections, compressed points, exact names/NUL suffixes, invalid sizes/curves/formats |
| Existing material owner controls |18 pass,0 fail|Secret ownership, PEM/DER, RSA/PSS/EC/DSA/EdDSA and encrypted passphrase policies |
| Candidate JS over native handles |4 new+23 affected pass,0 fail/skip|Raw wrappers, existing keys, digest/HMAC, HKDF and cipher controls; no guest JSAPI |
| Unchanged upstream file |2 runs pass|Complete `test-crypto-raw-key-type-validation.js` unchanged in candidate/native modes |
| Source/package checks |614 inputs guarded;12 package checks pass|Four complete key references, five ncrypto archive inputs, generation/bootstrap syntax; no engine compilation |

Three portable helper compilations succeeded; unchanged pinned ncrypto
objects/OpenSSL archives were reused. No guest package/engine/kernel build,
overall suite or product rebuild ran. Guest source117–123 remains
uncompiled and accepted116 is not current. Existing cipher Wasm-exception,
SQLite, Error-stack, compression and environment-clone nonpasses remain
open with their original evidence.

The initial portable report retains90 passes/two encoding failures and its
exact pre-correction owner/header. The initial unchanged-file candidate run
failed common's unexpected-global assertion because the development
`internal/test/binding` helper introduced `internalBinding`/`primordials`.
The preload now restores only those helper-created globals to their previous
descriptors before upstream common captures the realm. Assertions are
unchanged; this harness error and its preimage remain recorded separately.

## Remaining dependencies and later validation

Asymmetric JWK import/export (including getter order and own-property
semantics), secret-JWK property definitions, store/URI/PKCS11/PKCS12,
WebCrypto/key-generation/exchange/signing/certificate/TLS consumers,
worker/realm cloning and complete provider/FIPS policy remain gaps.
Provider allocations are not fully accounted by the material wrapper.

A warranted later targeted engine build must compile117–123 through the
normal resolver before claiming JSAPI correctness. Then exercise actual
reserved-slot ownership, byte leases/detachment/shared memory, GC/OOM/error
packets, ref/exit/cancellation and bootstrap order against identified
artifacts across Node, Chromium, Firefox and WebKit. The portable controls
cannot establish any of those boundaries. Expand unchanged upstream key,
raw/JWK, crypto-handle and consumer tests as their dependencies land.

Continue independent audited gaps across the breadth inventory before
overall suites. The full product rebuild deferral remains in force; this
roadmap does not authorize a full rebuild or turn skipped/unsupported or
unimplemented APIs into passing compatibility.
