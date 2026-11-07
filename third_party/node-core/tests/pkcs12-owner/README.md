# Focused PKCS12 ownership controls

These standalone controls compile the actual production PKCS12 parser helper
inside a tiny N-API component. It resolves ncrypto/OpenSSL symbols from the exact
pinned native Node26.13.0 binary. No dependency, engine, kernel, package or
product rebuild and no overall suite is run.

```
WASM_POSIX_DEV_SHELL_ATTEMPTS=1 scripts/dev-shell.sh env \
  NODE26_REFERENCE=/absolute/pinned-reference/bin/node \
  NODE26_SOURCE=/absolute/pinned-node-source \
  PKCS12_CONTROL_DIR=/absolute/fresh/evidence \
  bash third_party/node-core/tests/pkcs12-owner/run-controls.sh
```

Forty-seven checks compare parsed RSA/EC/key-only/cert-only/empty bundles,
additional-certificate order, key/certificate correspondence, offsets,
ArrayBuffer/DataView/foreign views, empty/Unicode/wrong/NUL passwords, malformed
input, public validation and independent parsed ownership. Key-only and empty
fixtures are actual OpenSSL-generated PKCS12 structures, not parsed-answer
presets. Unchanged Node test fixtures supply the other bundles.

The component's PEM/DER transport into native Node key/X509 owners is explicit.
Candidate public key and X509 algorithms still execute, with real native
material and brands. This does not execute the production SpiderMonkey slot,
prototype or pointer transfer, denied-wrapper/GC/OOM behavior, or the guest
OpenSSL dependency. The production path transfers actual parsed OpenSSL owners
into existing KeyMaterial/X509Material without serialization/reparse.

`upstream-preload.cjs` supplies candidate public entry points only to the
unchanged pinned test-crypto-pkcs12.js. It restores fixture-installed
internalBinding/primordials globals before the unchanged global-leak assertion
runs. It changes no upstream assertion or fixture input.

TLS pfx has a separate contract: it requires both a key and certificate, applies
context certificate/chain/trust installation and historical error/password
rules. A public crypto parse success is not TLS context support. The shared
parser is reusable, but the existing trust-only TLS context and public
createSecureContext stub still need credential-owner integration.
