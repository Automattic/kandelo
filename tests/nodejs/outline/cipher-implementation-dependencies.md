# Cipher contexts and pinned public stream algorithms

Source revision 117 (following accepted engine 116) addresses the audited Cipheriv, Decipheriv, factory, cipher
metadata and discovery gaps in the crypto family. The exact Node 26.13.0
source/native pin and completed audit remain unchanged. No family or
individual audited API is declared complete by this slice.

## Actual source owners

`third_party/node-core/upstream/cipher/` retains six byte-identical files
from the canonical pinned source archive, including the complete public
`lib/internal/crypto/cipher.js` and its native reference implementation.
The bundle embeds the public module unchanged, two pinned factory functions
and the selected pinned string-option validator. Public constructors,
validation, errors, encodings and Transform methods use those algorithms.
The shared digest owner exposes its existing private duplicate-filter helper;
it does not obtain cipher functionality from the embedding host's crypto API.

`cipher-platform-adapter.js` connects those algorithms to GC-owned native
contexts. It preserves actual secret-key handles, private byte codecs,
shared crypto handle symbols, the existing StringDecoder and stream owners.
It uses the linked provider for names and metadata rather than claiming a
fixed algorithm set. Discovery currently fetches a fresh provider list; full
FIPS activation and generation-aware caching remain separate obligations.

`cipher-operations.h` ports the pinned native CipherBase state policy onto
actual ncrypto/OpenSSL contexts. It supplies initialization, key/IV and
mode-specific checks, automatic padding, incremental updates, AAD, tag
length/installation/retrieval, authentication failure, finalization and
context retirement. CCM/SIV deferred authentication failures and one-shot
CCM-decrypt/SIV/GCM-SIV/CTS/XTS/wrap update rules retain their target policy.
Actual provider operations implement the cryptography; no recorded outputs
or algorithm-specific host delegation are used by the runtime.

`native-cipher.cpp` owns contexts through the engine's private native class,
GC finalizer and associated-memory accounting. It copies input/output through
existing native storage/Buffer owners, queries actual cipher properties and
translates provider diagnostics through the existing error bridge. Provider
internal allocation sizes, native error-stack descriptors, cross-realm,
transfer/detach, OOM and full GC-pressure behavior require further validation.

Empty user input now retains a non-null data pointer at the EVP boundary.
A null pointer has a control meaning there: the initial portable AES-SIV
empty-message encryption failed while the exact native reference succeeded.
A real zero-byte input pointer fixes that distinction without inventing
output. The same rule applies to empty AAD; the deliberate CCM length-control
call continues to use null. Existing input `Bytes` owners already cleanse
temporary key/input copies on destruction. The empty-data source change is
not yet guest-compiled.

The build stages the new owner header and unity fragment through the normal
SpiderMonkey recipe. Patch 0102 registers the private native operation.
There is no kernel/host wire, syscall, ABI version, memory-ceiling, target-pin
or browser-specific implementation change.

## Focused evidence and its boundaries

* `.context/node26-cipher-source-r3/report.json` verifies revision 117 and six complete files
  against the canonical archive, generated bundle/bootstrap syntax, selected
  input identities and exact forward/reverse patch correspondence. The first
  source check's insufficient patch context failed and remains preserved.
* `.context/node26-cipher-frontend-r2.json` records five passing controls over
  candidate public source/private codecs and explicitly native engine,
  key and stream boundaries. It is not guest-C++ evidence. The initial run
  retains three passes/two failures: a missing shared helper dependency and
  an incorrect new fixture expectation at the native stream Buffer boundary.
  The dependency was fixed and that fixture expectation corrected; no
  unchanged upstream assertion was altered.
* `.context/node26-cipher-native/report.json` records 33 matched comparisons
  of the portable state owner against the exact native Node reference,
  including encryption/decryption for twelve modes, six bad-tag cases and
  key/IV errors. One matched unknown-cipher error is separately counted as
  reference-unsupported, not as a supported algorithm. Three portable helper
  compilation attempts are retained, including the empty-input source fix. Native ncrypto/engine objects and
  OpenSSL 3.5.9 archives are explicitly hash-identified; this is not an
  immutable compiler/build closure or guest/four-host conformance.
* `tests/nodejs/controls/cipher.cjs` defines five same-source public controls
  for incremental/empty input, AEAD/authentication failure, one-shot modes,
  provider metadata/errors and stream output. Exact native preflight passes
  all five. Actual guest compilation/execution is recorded separately in the
  finding ledger; these assertions do not establish the full crypto family.
* `.context/node26-engine-r116-accepted/report.json` retains the normal
  targeted engine compile, all eight cached library dependencies, unchanged
  selected prebuild source identities and kernel/program ABI admission.
  Artifact `6218196eb6d3281459f64b85b50728534c5acf82c50d70859d583578a55e70af`
  has 49,814,506 bytes. It predates the revision 117 empty-input fix.
* `.context/node26-cipher-guest-candidate/report.json` records one pass and
  four failures. The stream bytes match native Node. Incremental, AEAD,
  one-shot mode and metadata cases terminate with an escaping Wasm exception;
  no result marker is emitted. All five native reference executions pass.
  Error handling and those complete guest scenarios remain unvalidated.
* `.context/node26-cipher-diagnostic-candidate/report.json` records one pass
  and two failures: JS-side argument validation is caught; native-key-error
  and positive/empty-mode diagnostics still escape. Console step output can
  be buffered and is insufficient to locate the exact failing instruction.
  These observations do not establish an outside engine/toolchain defect or
  explain the historic SQLite nonpasses.
* `.context/node26-cipher-empty-owner-observation.json` preserves the
  portable empty-SIV mismatch before the fix; four other empty encryptions
  match. `.context/node26-cipher-empty-owner-fixed.json` records five matches
  after the fix. These are five portable encryptions, not guest, decryption
  or empty-AAD conformance. The 33 earlier portable comparisons also match
  after the fix. No overall suite or full product rebuild ran.

## Remaining dependency-ordered work

1. Diagnose the native exception/guest error-packet boundary without blaming
   an outside runtime or converting failed paths to unsupported. Preserve the
   four original failures and two diagnostic failures. Compile the empty-data
   fix with the next warranted targeted integration build.
2. Reconcile every audited cipher overload, alias, inherited method,
   descriptor, symbol and error detail. Exercise empty/large/chunked inputs,
   partial native errors, reusable metadata options, detached/resizable/shared
   storage, key branding, reentry, GC/OOM, final/abandoned context retirement
   and provider-specific modes through actual guest owners.
3. Complete actual FIPS/provider activation and coherent generation-aware
   metadata. Provider absence must remain explicit; it is not automatically
   an accepted engine/platform limit. Record real supported mode sets per
   artifact and host without spoofing platform identity.
4. Implement independent audited crypto gaps: RSA public/private operations,
   signatures/verification, key generation and remaining key operations,
   X509, DH/ECDH and WebCrypto. The pinned module's unexposed RSA sibling
   closures retain an honest unavailable native boundary; copying the full
   module does not supply those public APIs.
5. Later unchanged upstream coverage includes `test-crypto-cipheriv-decipheriv`,
   `test-crypto-cipherbase-options-fast-path`, `test-crypto-cipheriv-cbc-cts`,
   `test-crypto-cipheriv-xts`, `test-crypto-aes-wrap`, `test-crypto-des3-wrap`,
   `test-crypto-getcipherinfo`, the explicit/implicit-short-GCM-tag tests and
   AES padding tests from the pinned parallel suite. Run these with native
   differential controls after the breadth-first pass, with actual artifacts
   on Node, Chromium, Firefox and WebKit. Keep all nonpass categories and
   historic unrelated integration failures visible. No overall suite or
   full product rebuild is authorized by this slice's focused evidence.
