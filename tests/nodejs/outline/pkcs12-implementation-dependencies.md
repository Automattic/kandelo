# PKCS12 parsing and material ownership

This bounded C-001/C-008/C-015 source followup connects the pinned public
crypto.parsePKCS12 algorithm to the existing native keyOperation bridge.
A shared native parser follows the selected crypto_pkcs12.cc policy and owns
actual OpenSSL EVP_PKEY/X509/CA-stack results. Malformed structure, unsupported
algorithm and native parse/MAC failures retain their distinct errors.

The actual parsed private key transfers into KeyMaterial/KeyObjectHandle with
private role; certificate and additional certificates transfer into real
X509Material/foreground boxes. Each additional X509 receives an independent
OpenSSL reference before its original stack retires. Parser outputs enter RAII
ownership on success and failure. No input storage survives as a borrowed
pointer in any returned object, and no PEM/DER conversion occurs in production.
The lazy keys/X509 seam preserves their public wrapper classes and constructors.

The synchronous native byte source checks/roots actual storage, enters its
realm and suppresses GC for each borrow. Cleansing-owned atomic byte snapshots
feed the secure-memory BIO and NUL-terminated password. No source pointer spans
later JS/security/allocation work; errors are reported after no-GC scopes.
Public NUL-password validation remains unchanged with a native backstop.

Forty-seven native/parser/public controls compare actual RSA/EC, offsets/views,
key-only/cert-only/empty bundles, chain order, password/error/validation paths
and independent parsed ownership with pinned native Node26.13.0/OpenSSL3.5.9.
The unchanged upstream PKCS12 test passes natively and through explicit
candidate public wrappers/native-parser/key-and-X509 component boundaries.
That component uses serialized PEM/DER transport into genuine native Node
owners; it does not execute production SpiderMonkey pointer/slot transfer.

Production JSAPI compilation, OOM/GC/allowed-and-denied wrappers, error queue
reentry and exact linked guest-backend/provider coverage remain unvalidated.
The current guest dependency is also pinned to OpenSSL3.5.9; the older audit
version observation is historical. Native component results still do not
establish the actual selected guest dependency/artifact behavior.

TLS pfx loading is NOT implemented by this public parser. It needs actual
SSL_CTX key/certificate/chain/trust installation and pinned historical errors
and password ordering. The current trust context only prepares CA material,
while tls.createSecureContext still explicitly throws. Those are concrete
implementation prerequisites, not an accepted TLS/browser boundary. Full
crypto keygen/sign/verify/WebCrypto/STORE and all four guest-host evidence also
remain open. No full or selected engine build was run by this slice.
