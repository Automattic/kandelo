# Native key material and upstream public wrappers

Source123 subsequently implements real raw import owners and provider encoding
policy. See [the current raw-key checkpoint](raw-key-implementation-dependencies.md).
The source100/101 evidence below remains historical; it does not validate
source123 or close any full API/family. Asymmetric JWK/store/PKCS12/WebCrypto,
transfer/provider policies and guest/four-host obligations remain open.

Source100 connects the complete unchanged pinned
`lib/internal/crypto/keys.js` public wrappers to private engine key owners.
This is a partial implementation of C-001/C-007/C-009/C-011/C-015, not
closure of crypto, WebCrypto, or any host's conformance obligations. The
exact audited Node26.13.0 source/native pin and frozen audit are unchanged.

## Reused source and actual ownership

`third_party/node-core/keys-platform-adapter.js` loads the full key module;
`build.py` verifies its identity and the exact BigInt conversion helper.
Public validation, format selection, getters, details caching, class private
fields, equality role checks and PEM/DER dispatch use that pinned source.
Vendored C++ key sources are reference inputs, not compiled V8 bindings.

`packages/registry/node-ncrypto` builds the unchanged Node-vendored
`deps/ncrypto/ncrypto.cc` and `engine.cc` against the actual SDK OpenSSL
library. Source hashes, source release/commit, declared dependencies,
resolver-owned roots and installed provenance are checked. Its C++20
requirement is explicit. Patch96 compiles only SpiderMonkey's consuming
shell translation unit as C++20 and removes it from the C++17 unified group;
it does not change the rest of Mozilla's language-standard selection.

`key-operations.h` owns cleansed secret bytes or an actual EVP_PKEY through
ncrypto RAII. `native-keys.cpp` stores each immutable material owner in an
opaque finalizable engine object. Native handles, public key objects and
CryptoKey storage retain real GC edges to that owner. Roles and brands are
engine slots, not user properties, symbols, or outer-host key objects.
Public construction snapshots the material edge so later handle reuse
cannot replace existing objects' keys. Secret equality is constant time;
asymmetric equality delegates to the real backend. Finalization releases
material once. Known owner/secret bytes are associated with the GC; opaque
provider allocations are not yet fully measured and remain an accounting
gap, not an invented estimate.

PEM/DER public/private import, private-to-public views, encrypted exports,
RSA/PSS/EC/DSA details, supported raw exports and EC validation use ncrypto.
The private binding writes/returns the detail target expected by the pinned
module. Secret exports copy bytes; secret JWK export encodes those actual
bytes. HMAC receives a real private native handle, copies its secret into
the existing cleansed native HMAC input, and never calls a public export
method. `util.types` uses native slot probes without observing user
properties. Production filesystem/process/entropy paths are unchanged by
these key adapters.

## Focused evidence and failures retained

The normal resolver's first wasm32 ncrypto attempt failed because the new
recipe incorrectly selected C++17. The corrected C++20 recipe builds the
unchanged source successfully. Native-host attempt1 had the same standard
error; attempt2 exposed omitted libssl linkage in the standalone control;
attempt3 compiles successfully against retained native OpenSSL3.5.9.

Eighteen portable-owner checks compare exact serialized material and
roundtrips with native26: secret independence/equality, RSA, EC, Ed25519,
Ed448, DSA and RSA-PSS PEM/DER, encryption and actual error outcomes. The
first missing-passphrase expectation was incorrect: the actual pinned
native reference reports an OpenSSL error in this case. The corrected
control compares that real result rather than imposing the source's
alternate missing-passphrase branch. Reports are in
`.context/node26-keys-native-controls-r1/report.json`; earlier failing logs
remain separately recorded.

Seven current frontend differential controls pass in
`.context/node26-keys-frontend-r4.json`: independent secret storage/exports,
RSA/EC roles and serialization, RSA-PSS/DSA metadata, encrypted input/errors,
forged receivers/validation, deep material comparison, and actual secret-key HMAC. The fixture uses
native26 handles and native base classes without calling its class-factory
registration functions; it does not fabricate material or brands. An early
fixture run aborted because the adapter omitted keyDetail's target
argument. Both adapter and guest binding now follow the actual target
argument/return contract. That native abort is a retained integration
failure, not evidence of a Node defect. An earlier runner path error ran
no tests. JSON `success` alone on the aborted run is not a passing result.

Source checks verify archive identities, generated bundle/bootstrap syntax,
native-fragment assembly, Mozilla's existing style checker, exact patch
forward/reverse application with fuzz0, evidence registration and whitespace.
Package/native/source/frontend checks are separate from guest conformance.
Engine100 compiles successfully on the second targeted attempt. The first
engine attempt caught a wrong BigInt helper name and an early netdb header
macro collision exposed by separating the shell translation unit; the helper
and custom include ordering were corrected without changing Mozilla's enum
or libc's API. The accepted artifact and exact prebuild source receipt are
retained in `.context/node26-engine-r100-accepted/report.json`.

Source101 subsequently connects deep comparison's lazy private key-module
request to that same real owner; seven frontend controls pass. This JS-only
followup is not compiled into engine100. Seven existing incremental controls
also pass with the exact native encoding parser dependency. The initial
partial parser fixture produced one failure; it is retained separately and
was rerun with its actual native parser, without changing assertions.

A guest integration attempt ran no guest cases: current artifact policy
rejected the old kernel before launch. An earlier runner failed on missing
locked host dependencies; `npm ci --prefix host` refreshed those successfully.
No artifact policy was disabled, kernel/image identity rewritten, or rejected
binary read directly. This is an unresolved harness/artifact prerequisite,
not a key API failure or passing guest compatibility. No full
product rebuild or overall suite is authorized by this checkpoint.

## Remaining dependencies and next broad work

- Asymmetric JWK import/export, raw imports, store/URI/PKCS11 and PKCS12
  remain missing native owners; explicit errors are implementation gaps.
- WebCrypto algorithms/import/export/derive/wrap/unwrap and full CryptoKey
  metadata/usage/extractability policies remain incomplete. Real storage
  and a copied public class do not establish those routes or global exposure.
- Cross-worker/realm serialization and transfer, native class reconstruction,
  revocation/lifetime, native byte leases/shared/resizable/detached handling,
  OOM/GC races, provider memory accounting and Permission Model checks need
  their actual owners and targeted conformance evidence.
- Public HKDF/source102 now shares real native key/job owners; its guest
  compilation, WebCrypto routes and four-host conformance remain open.
  Key generation/exchange, cipher/decipher, signatures, certificates,
  FIPS/provider/options/namespace policy and TLS consumers remain separate
  implementation work. This does not make unsupported algorithms available.
- Guest C++ compilation, actual guest HMAC/metadata/material operations and
  identified-artifact four-host conformance must be accounted separately.
  A focused Node-host check on a retained old kernel/image is not current
  combined kernel/host or four-host validation.

Move next to independent audited foundations rather than exhaustively
investigating every key format before other families progress. No API-wide
or family-wide closure is credited here, and the breadth pass remains open.


Unchanged upstream validation candidates include `test-crypto-key-objects.js`,
`test-crypto-keyobject-brand-check.js`, `test-crypto-keyobject-hidden-slots.js`,
`test-crypto-keyobject-no-own-symbols.js`, `test-crypto-hmac.js`, and the raw,
JWK and to-CryptoKey files. These were not run for this slice; their broader
algorithm/format/worker dependencies remain open. Later guest validation
requires an admitted identified kernel/image, plus the source101 followup
and corresponding Chromium/Firefox/WebKit artifacts. Existing source100
compilation does not establish that runtime evidence.
