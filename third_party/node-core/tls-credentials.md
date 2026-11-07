# Prepared TLS credential source slice

The existing tls.connect path prepares an actual private SSL_CTX before TCP
startup, then its native handshake claims an independent SSL_CTX reference.
Previously that shared preparation loaded CA/partial-chain trust only. The same
owner now consumes certificate chains, PEM private keys/passphrases and PFX
credentials. No second TLS stack, certificate metadata facade or production
host node:tls dependency is introduced. Public createSecureContext still throws:
full SecureContext, server and general TLS configuration remain implementation
gaps, not passing compatibility or inherent platform exclusions.

The pinned public validation and cert/key/PFX configuration segments are selected
unchanged, including CA-before-cert, cert-before-key, array/override semantics,
falsy checks and string-to-buffer conversion. Existing CA trust selection and
partial-chain behavior remain intact. The isolated selected loader does not
establish complete option/getter/cipher/version/protocol/security-level ordering
of the full public configSecureContext algorithm. Cipher suites, curves, engines,
CRLs, tickets, sessions, callbacks and certificate compression still need their
actual owners; ignored options are implementation gaps.

Exact pinned certificate-chain algorithms load actual X509 objects and retain
OpenSSL references in SSL_CTX, with independently owned certificate/issuer
references for the context. Their invariants remain always-enforced checks.
The actual context store supplies issuer lookup; no guessed issuer field is
invented. Private keys are parsed by PEM_read_bio_PrivateKey with an explicit
length password callback, then SSL_CTX_use_PrivateKey checks the key/cert pair.
No interactive password prompt is permitted. UTF8 and embedded NUL key passwords
retain byte-length semantics.

PFX loading reuses the existing 172 ParsePKCS12Bundle owner. TLS requires both
key and certificate, unlike public crypto.parsePKCS12's permitted partial bundle.
PFX's historical plain reason errors and unsupported-algorithm code remain
separate from PEM's decorated OpenSSL error schema. PFX password storage has a
real NUL terminator and follows the target C-string rule, including embedded
NUL truncation; it does not borrow a non-terminated view or apply crypto's
separate NUL rejection policy. The terminator is allocated before secret bytes
are copied, so appending it cannot free an uncleansed intermediate password.
Private temporary credential/password bytes use the existing cleansing owner.

Actual string/view admission uses the shared checked rooted byte source, enters
the original realm for the current synchronous no-GC borrow and copies actual
view bytes with real offsets. Unrelated bare ArrayBuffers/proxies are not
admitted as views. CA now reuses that same real realm-safe source. Oversized
material follows pinned LoadBIO's empty-result behavior before password parsing;
no unrelated public BufferSource widening or caller getter is introduced.

SSL_CTX keeps its real installed key/certificate references after intermediate
parsing owners are released. The JS wrapper finalizer frees its actual C++
holder and X509 references; captured SSL_CTX references remain independent for
handshakes. Known holder size is associated with GC as before. Opaque OpenSSL
allocator/control-block material is not estimated as physical memory or RSS;
complete allocation accounting and guest lifecycle validation remain gaps.

The historical audit described OpenSSL 3.3.2. Current authoritative source already
pins 3.5.9 at archive 603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a;
this slice does not change that pin or the audited Node 26.13.0 target. Selected
source/API/config traces bind accepted engine 173's actual source-only OpenSSL
385e86bedfb2654920d9b3e4e9b7e1991192cad322bab98494cf4f353dc6120b dependency headers
and receipt. Merely existing ordinary cache directories were not selected as
proof of current linkage. No new current-candidate dependency resolution was
run. Native Node's 3.5.9 exports are a distinct host artifact/configuration;
its controls do not compile or execute the guest OpenSSL artifact.

The selected guest no-engine/no-dso/no-async/no-ui-console/no-posix-io flags do
not remove the in-memory SSL_CTX/PEM/PFX/reference APIs used here. Provider and
configured trust availability still govern actual algorithm/verification errors;
no dummy legacy provider or synthetic trust success is installed. The native
JSAPI fragment, new guest-target credential source and four-host candidate
runtime are unvalidated. Browser egress's session-generated TLS peer/trust
boundary remains separate from actual guest/local TLS credentials; this work
does not claim end-to-end remote-origin TLS state through that transport.

A remaining source-level error deviation is explicit: the native credential
error wrapper currently defines its own decoration properties. The target
OpenSSL CryptoErrorStore/Decorate path uses ordinary [[Set]], and may decorate
from a secondary queued error before the primary error. Inherited error setters,
nonwritable prototype fields and that intermediate observable ordering therefore
need a shared error-object owner follow-up. The focused stock-prototype error
comparisons below do not establish those behaviors. This is an implementation
gap, not a platform boundary or passing conformance.
