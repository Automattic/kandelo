# Public PKCS12 parser integration

Source172 connects unchanged public crypto.parsePKCS12 validation/wrappers to
the existing actual keyOperation bridge. Native OpenSSL parsing owns real
EVP_PKEY, certificate and CA-stack material. Private keys and X509 references
transfer directly into existing native owners, including independent CA refs
and own-data array elements. All partial outputs remain RAII-owned; no borrowed
input survives. Production performs no PEM/DER conversion.

Synchronous inputs are checked/rooted across actual buffer realms and copied
under no-GC borrow scopes into cleansing-owned bundle/password storage. Secure
BIO/password memory and error queues follow the pinned parse policy; malformed,
unsupported and MAC errors remain distinct. Key-only/cert-only/empty bundles
are genuine parser results; embedded-NUL public validation stays unchanged.
Lazy key/X509 dependencies preserve real public classes and avoid initialization
cycles. Current guest/reference OpenSSL pins are both3.5.9; older3.3.2audit text
is historical, not a source/target change made by this slice.

47current comparisons pass against exact native26.13.0, including RSA/EC,
view offsets/foreign realms, actual generated empty/key-only bundles, chain
order, passwords/errors and independently owned parsed storage. The whole
unchanged upstream test-crypto-pkcs12.js passes in native and candidate-component
processes (SHA fbc62df808ef3cd430851f8bdb95dd4ab62ea92c277f820764adca28101dead0).
The component explicitly transports PEM/DER into genuine native Node owners;
it does not execute production SpiderMonkey pointer/slot/GC paths. Fixture-
installed globals are restored precisely before the unchanged leak assertion.
Original strict leak failure and raw-key-init-arity abort remain preserved.

Three earlier tiny native helpers compiled successfully. Root reuses the exact
identified final component and current parser header; no new helper compile.
14package/source/bootstrap/unity checks pass. No overall/fullproduct run.
Production172JSAPI/GC/security wrappers/error reentry/provider/FIPS/legacy/
BoringSSL and allfourhost conformance remain open.

TLS pfx is NOT implemented by this public parser. Actual SSL_CTX key/cert/chain/
trust installation and historical error/password ordering remain real owning
prerequisites. The context currently prepares trust material and public
createSecureContext still throws. These are implementation gaps, not accepted
browser boundaries or passing support. Full crypto remains incomplete.

## Production build evidence

The selected171engine build compiled and linked its production native code,
including earlier166backing/root corrections and170acceptedTCP. Its unchanged
include-style gate failed with75added diagnostic lines (74unique locations);
normal package publication failed and no accepted artifact exists. Frozen
inputs were unchanged;8dependencies were reused. The full identified result
is [engine171-build-result.json](engine171-build-result.json).172newPKCS12source
has not been compiled; style repair is a separate private slice. Neither
compilation nor native components establish guest/fourhost conformance.

See [ledger](pkcs12-parser-finding-progress.json) and
[owning dependencies](pkcs12-implementation-dependencies.md).
