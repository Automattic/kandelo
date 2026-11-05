# Incremental Hash/Hmac owners

This is a partial crypto-family implementation slice, following the frozen
Node 26.13.0 source audit. It does not close a family, an individual original
observation, or guest conformance on any host. The audited target/source/native
reference pins and original audit artifacts remain unchanged.

## Actual source implementation

* Full pinned Hash/Hmac constructors, prototype methods, update/digest/copy,
  lazy Transform hooks, options/key validation and public creator functions
  are selected with verified source/section hashes. Public constructor exports
  use the pinned DEP0179/DEP0181 deprecation wrappers; createHash/createHmac
  retain the internal constructors. SHAKE warning policy remains pinned.
* IncrementalHash owns an actual OpenSSL EVP_MD_CTX, copying actual provider
  state and independently initializing requested/default output length. A
  cached digest retains the context, as in the pinned native implementation.
  Zero-length XOF output does not finalize the native context. Public Hash
  finalization and stream flushing preserve their distinct state transitions.
* IncrementalHmac owns an actual HMAC_CTX. Raw string/Buffer/view/ArrayBuffer
  secret inputs use the pinned public validation and private byte codecs;
  embedded zeros and exact view spans survive conversion. Finalization retires
  the context, repeated native/public digest returns empty bytes, and native
  update after finalization returns false.
* Native encoding functions and enum are generated from exact pinned source,
  with header-only inline linkage. Unknown/default, C-string truncation and
  accepted encoding-prefix behavior are native parser policy, not a second
  JavaScript approximation. Private codecs consume the selected encoding and
  convert output after native finalization.
* A real foreground-finalized native class owns each context. Reserved-slot
  initialization, checked unwrap/class validation, independent output bytes,
  temporary-secret cleansing and wrapper/cached-byte accounting are explicit.
  Provider-internal allocation accounting remains incomplete.
* Patch 76 replaces the old context-dropping native wrappers with the shared
  incrementalHash dispatcher. Recipe 65 declares/stages the owner/parser
  inputs through the normal targeted engine package route. No host import,
  syscall, wire ABI, platform identity or separate Bun asset dispatch changes.

## Focused evidence and limitations

`.context/node26-incremental-controls-r2/report.json` records seven passing
bounded source/native scenarios: constructors, bytes/encodings, copying,
parser edges, validation, stream finalization and native state. The actual
candidate public classes, private Buffer codecs, existing Buffer inspection
owner and pinned LazyTransform are used. Fixed JS allocation, native Node
stream/digest/brand/inspection metadata and a compiled portable native parser
are explicit control boundaries. These are not guest JSAPI or four-host runs.

`.context/node26-incremental-native/report.json` records five actual portable
OpenSSL 3.3.2 comparisons against the exact pinned Node native bindings:
sha256, sha512, md5, sha3-256 and RSA-SHA256. Each covers branching copy,
cached digest, Hmac finalization and zero-length XOF copying. Algorithms and
repetitions are not counts of additional public APIs. The native helper
suppresses deprecated-declaration warnings solely for the pinned HMAC API;
other -Wall/-Wextra diagnostics remain errors.

The first frontend run retained five passes and two failures. One found the
missing public constructor wrappers and was fixed in the runtime adapter.
The other exposed omission of the existing Buffer inspection owner from the
fixture; the fixture now invokes that actual owner, with assertions intact.
The first portable-helper compile failed on a helper/type name collision;
the helper was renamed. The first generated-bootstrap syntax check found a
missing dispatcher-property comma; it was fixed before package compilation.
All earlier logs/input identities are retained separately.

## Still required

1. Real KeyObject/CryptoKey native owners, secret handles, brands, immutable
   authority and lifetime. No property-shaped keys or facade classes are
   accepted. The optional private key-owner protocol is not wired in the
   guest; raw-secret Hmac support does not close key-object input support.
2. Target provider/algorithm/options parity: the package uses OpenSSL 3.3.2,
   while the audited target has newer backend behavior, including digest
   options/algorithms unavailable here. Explicit rejection is an implementation
   gap, not an accepted platform exclusion. Complete FIPS/provider/cache policy.
3. Guest backing-store/shared/resizable/detached-input and allocation limits;
   provider-internal memory accounting; OOM/error queue/stack fidelity; GC,
   cross-realm, shutdown and worker resource behavior.
4. Actual guest Buffer/stream/error/scheduler integration and unchanged upstream
   Hash/Hmac tests with exact built-artifact identities on all four hosts.
   The catalog in incremental-crypto-validation-candidates.json is prospective,
   not executed coverage. No overall suite or full product rebuild ran.
5. Remaining crypto owners: asymmetric keys, ciphers, signatures, KDFs,
   certificates, WebCrypto and complete random-job backing-store leases.

Build integration and API execution are separate evidence. Recipe 65 was accepted through the normal wasm32 resolver build in 223.4
seconds, with unchanged upstream include/macroassembler/opcode checks, Wasm
optimization and fork instrumentation. Both executables are 47,838,056 bytes,
SHA-256 `80dbb6085fa800a3f45e04403cc3f520058c4fa84b0babfbde229fa9e413b6b4`.
All 538 frozen source identities matched after the build; the retained report
and executable copies are in `.context/node26-engine-r65-accepted`. This
compiles the actual guest bridge but executes no guest API. No source-only
control implicitly establishes guest runtime behavior.

Continue independent audited owners after this bounded integration checkpoint;
do not expand this slice into a crypto-only validation campaign while the
breadth-first implementation pass remains incomplete.
