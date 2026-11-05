# HKDF and shared native derivation ownership

Source102 adds public `hkdf`/`hkdfSync` using the complete unchanged pinned
Node26.13.0 module. Source101's comparison followup and102's native job
changes are not guest-compiled. The accepted targeted engine remains100;
all four hosts' current-candidate conformance remains unestablished. The
frozen audit and exact target/source/native-reference pins are unchanged.

## Public and native source ownership

`kdf-platform-adapter.js` loads the whole pinned HKDF module and three exact
crypto-util helpers (`toBuf`, byte-source length and byte-source validation).
The full helper origin, module, native HKDF header/implementation and all
selected hashes are checked by `build.py`. Public validation and order,
key preparation, info's1024-byte limit, callback receiver, ArrayBuffer output
and overloads use that upstream code. Shared types/Buffer bounds and the
same real private key owner are supplied by the production bootstrap.

`hkdf-operations.h` calls the unchanged `ncrypto::Digest::FromName`,
`checkHkdfLength` and `hkdf`; it does not implement HKDF's cryptographic
algorithm. These use the already declared Node ncrypto/OpenSSL dependency
and actual provider behavior, including unavailable algorithms and errors.
Zero-output failures remain failures when the real backend rejects them.

A common `KdfOperation` interface owns derivation, resource names, byte
counts and output limits. Existing password configurations implement it;
HKDF has its own configuration with owned/cleansed key, salt and info.
`native-kdf.cpp` dispatches both through the existing real CPU work queue,
result delivery, cancellation and finalization owners. The request class
uses the target's actual `DERIVEBITSREQUEST` provider and HKDFJob name.
No second scheduler or untracked host Promise queue is introduced.

Asynchronous raw byte inputs are copied before init hooks and dispatch.
Actual native secret handles are read through their private material owner;
public `export()` methods and property-shaped keys are never consulted.
Immutable key bytes are snapshotted before hooks, including synchronous
handle inputs. Synchronous raw views remain rooted through init and are
read immediately before native execution, with no borrowed pointer surviving
JS reentry. Existing password-job handling uses that same policy. Owned
operation destruction cleanses vectors and ncrypto releases its result.
Memory accounting uses each concrete configuration's actual size/owned
inputs and requested output, with size overflow checks.

These paths do not establish full backing-store leases, resizable/detached/
shared/reentry semantics or exact provider allocation accounting. Those are
implementation and validation obligations, not platform exclusions.

## Scoped checks

- `.context/node26-hkdf-native-r1/report.json`:18 portable ncrypto/native26
  comparisons, including aliases/NUL behavior, actual unsupported digests,
  empty inputs/output,1024-byte info and the255-block output boundary. The
  shared operation interface is invoked through its base owner. No guest
  JSAPI, queues or key-handle execution occurs in this control.
- `.context/node26-hkdf-password-regression-r1/report.json`:20 existing
  PBKDF2/scrypt cases pass after compiling the current common interface and
  invoking its real virtual derivation method.
- `.context/node26-hkdf-frontend-r2.json`:6new HKDF controls and11existing
  PBKDF2/scrypt/Argon2 controls pass. They exercise public byte sources and
  validation order, secret-key inputs, result types, init-hook mutations,
  asynchronous snapshots, callback/resource identity, scope and metadata
  over actual native26 keys/jobs. These are dependency-boundary controls.
- `.context/node26-hkdf-upstream-r1/report.json`: unchanged
  `test-crypto-hkdf.js` passes in native and candidate JS/native-dependency
  modes. It is one upstream file, not an API/family/four-host score.
- `.context/node26-hkdf-source-r1/report.json`: exact archive/source/helper
  identities, generated bundle/bootstrap syntax, common native assembly,
  Mozilla's existing style checker, shell syntax, evidence registration,
  whitespace and preservation of the separate Bun loader remainder pass.

An initial test setup used paths relative to the wrong directory, so it
created neither HKDF fixture; that earlier run covered only the existing11
controls. Its log/report are retained and are not counted as new HKDF passes.
No runtime assertions or upstream files were changed to obtain these results.
No new guest/package/kernel/full-product builds, overall suites, publication,
merge or deployment occur for source102. The prior rejected-kernel guest
preparation failure remains unresolved; no artifact policy is bypassed.

## Remaining dependencies and broad-pass routing

Public HKDF is implemented in source but still needs guest compilation,
actual native request/GC/cancellation/reentry/exception/ref/realm integration
and identified kernel/image plus four-host conformance. The source101 lazy
comparison change remains part of that uncompiled followup. Do not assign
engine100's compilation or old runtime results to these newer bytes.

The copied module's internal WebCrypto HKDF derivation helper does not
establish WebCrypto: normalization/algorithm dictionaries, key usages,
extractability, import/export and Promise job modes remain incomplete and
explicitly fail at their unavailable owners. No new platform exclusion is
accepted. Key generation/exchange, ciphers, signatures, certificates, FIPS,
other KDF/provider policies and full namespace/format behavior remain open.

Continue to independent audited loader/transport/shared foundations rather
than exhaustively testing cryptographic formats before the other families
advance. All19 families remain partial. Overall suites and the full product
rebuild remain deferred; any later full rebuild need must be reported first.
