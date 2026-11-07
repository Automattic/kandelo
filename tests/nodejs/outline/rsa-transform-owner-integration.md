# Bounded RSA one-shot owner handoff

Private base: committed source183 `4310e5368e2a7097cdb7e0ae457ecfa3d64a6e8b`,
with exact immutable shared-crypto-error and sync-random follow-up dependencies
applied privately. Patches contain only additive RSA hunks against those
postimages. Both apply-check against current root. Do not copy the private
bundle or whole old metadata/bootstrap files over current source.

The consumed route is public crypto Object.assign -> exact pinned cipher.js
RSA wrappers -> existing curated cipherOperation -> real native RSA dispatch
-> existing KeyMaterial/ncrypto::Cipher -> actual OpenSSL. Previously the
wrappers were imported but bound to throwing unavailable functions and omitted
from the returned public API. The new public exports are all four one-shot
transforms, not public signature/key-generation/WebCrypto support.

The native helper consumes genuine native key material or reuses the existing
PEM/DER/JWK/raw importer. It roots the immutable material edge independently
of the original handle before a reentrant padding conversion can replace that
handle's edge. It captures actual input backing allocation/range before that
conversion and reads its bytes afterward. An early payload snapshot would miss
callback mutations; reborrrowing a detached view could lose the original range.
No JS pointer crosses callbacks. Existing allocation capabilities protect the
original storage, and shared bytes use actual atomic loads. Output provider
allocation stays owned through engine result allocation.

The target's PKCS1 private-decrypt guard runs before digest/label/MGF1 checks.
It creates an actual key context and calls setRsaImplicitRejection. Unsupported
providers fail truthfully; there is no unsafe fallback or fabricated feature
bit. The pinned CHECK(ctx) fatal allocation policy is preserved by always-on
abort in the portable helper. This branch's allocation-fault fatality and
unsupported-provider outcome were source-traced, not forced in runtime tests.
The actual positive PKCS1 guard and an EC-context error ordering case pass.

All crypto Error creation uses the prior shared owner, including ordinary
setter/refusal/exception semantics and primary/secondary queue decoration.
Public coded errors retain the separate native macro checked policy. Existing
private stream/key/codec routes are preserved; this is not a parallel RSA stack.

Native evidence: 71 focused groups and two complete unchanged upstream files
per subject, with exact file hashes. OAEP/MGF1/labels, RSA directions, PEM/DER,
KeyObject/JWK dependency transport, encrypted material, bad inputs/algorithms,
wrong keys, actual failure setters, GC during reentrant padding mutation and
actual private Buffer output branding are covered. Neither success counts nor
whole-file exits establish guest/four-host conformance.

N-API cannot borrow Node's internal KeyObjectHandle C++ representation. The
control explicitly exports genuine native key material through DER into the
portable KeyMaterial parser. Native key preprocessing/streams and clean JWK
projection are explicit dependency controls, not execution of new guest JWK/
slot/realm/security behavior. Shared ArrayBuffer input is normalized to a real
view of the same storage in that N-API boundary; production uses the actual
checked backing capability. Transfer/shrink/reinitialization guest races remain
unvalidated. Upstream runs install the actual candidate Buffer owner as the
guest bootstrap does, and override only the four subject RSA methods; all other
crypto methods remain explicit native test dependencies.

The exact native26.13.0 executable exports OpenSSL3.5.9/ncrypto. The current
guest recipe separately resolves node-ncrypto26.13.0 + OpenSSL3.5.9 and enforces
compiled/source provenance, but the new RSA guest caller has not been compiled.
The accepted173 plan records cached node-ncrypto; this capsule does not select a
new guest cache generation or treat a matching version as identical artifact/
configuration. Final tiny compilation records its actual include dependency
hashes and exact source/header images.

Preserved nonpasses/setup history:

- Initial source-edit script expected four-space input-list indentation; actual
  source used two. Missing single declaration corrected, no assertion weakened.
- Compile1: missing generated native-encoding header in the tiny fixture.
- Compile2: genuine helper Digest move misuse plus fixture Bytes assignment.
  The pinned Digest allows copy but deletes move; return now uses its copy
  contract. Native bridge's actual body is unchanged by the fixture correction.
- First runtime control compared native and private Buffer prototypes directly.
  It failed despite equal bytes. Controls now project bytes explicitly and also
  assert the genuine private Buffer output brand/prototype separately. Unchanged
  upstream assertions run in the actual candidate Buffer environment.
- Incorrect public native-key export arity in my DER fixture hit its pinned
  native CHECK (SIGABRT), including one initial upstream candidate run. Public
  and private arities now follow exact source; initial aborts/reports retained.
  This is a test fixture mistake, not a claimed Node/engine defect or an expected
  passing crypto outcome.

Remaining: STORE loader implementation; exact guest JWK/raw/native-handle
lifecycle, GC/security/cancellation/transfer/resize/OOM/finalizer execution;
per-callsite legacy key parser message/configuration semantics; temporary C++
vector/shared-control-block capacity and opaque OpenSSL allocation accounting;
provider/FIPS/backend differences and current four-host evidence. These are
implementation/validation gaps, not newly accepted platform exclusions. The
broader C-001/C-015, CRYPTO and SECURE-NETWORK findings remain open.

No root edits, commits, pushes, ABI/pin changes, engine/kernel/library/product
builds or overall conformance suites. Tiny native compile accounting: 4 attempts,
2 failures. Normal input/staging/unchanged Mozilla style/bootstrap syntax source
checks pass. Parent should regenerate its current combined bundle normally.


## Current parent integration

Source187 composes12actual RSA source leaves over186, replacing only the
cipherPlatform metadata section and regenerating the current combined bundle.
The actual new portable header is declared and normally staged. No source,
reference/library pin, kernel-host/program ABI or engine registration changes.
All prior util/constants/shared Error/FFI/Response/loader/WASI/Domain/TLS owners
remain protected by exact current source identities.

Fresh root controls verify the final artifact21185c5b41683351ac38d22bca05f4ec7ab12e8017771d50d1c8e24d40cd72e8,
current addon/portable/header inputs and actual compiler dependency manifest.
Seventy-one focused groups and two whole unchanged upstream files per native/
candidate pass, plus14package checks and normal current bundle/bootstrap/unity/
input closure/unchanged-style checks. Existing exact final native artifacts are
reused; root performs0new compiler commands. Four prior attempts are accounted
for, including both genuine compiler failures. All original setup/runtime/abort
nonpasses remain immutable and distinct from the corrected results.

The native frontend seam exports genuine native key material through DER into
the actual portable parser; it does not execute guest native handle/JWK/private
slot/GC/security behavior. Current guest original-allocation/material span
retention, transfer/resize/reinitialization/realm/OOM/cancellation and teardown
remain uncompiled/unexecuted. No guest backend is selected anew. Matching3.5.9
version strings do not equate native and guest OpenSSL artifacts/configurations.
Actual positive implicit-rejection support and error chronology are exercised;
unsupported-provider and allocation-fault fatal branches remain source-traced.

STORE remains honestly unimplemented. Full per-API parser/error semantics,
opaque allocation/accounting and broader signatures/keygen/exchange/WebCrypto/
provider/FIPS/secure-network owners remain real gaps. Accepted173predates187;
all-four-host identified-artifact conformance is unestablished. No finding/family
closes. No engine/kernel/library/product build, overall suite or full rebuild
ran. Nested guest Wasm execution remains in scope, scheduled last.
