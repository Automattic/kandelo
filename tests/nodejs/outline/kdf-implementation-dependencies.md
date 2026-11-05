# Password KDF source and shared OpenSSL prerequisite

Current integration checkpoint: the normal targeted engine96 build compiles
the source through95 with guest OpenSSL3.5.9; four focused Node-host
differential controls pass. Current source99 includes metadata97, sync whole-file98 and queued
promise write/append99 owners; these remain guest-uncompiled. Changed kernel/host
and complete four-host conformance remain outstanding. Recipe-stage
compilation statements below describe their historical checkpoints. See
[the current build and evidence record](engine96-integration.md).

C-001/C-008/C-015 now have source owners for `crypto.pbkdf2`,
`pbkdf2Sync`, `scrypt` and `scryptSync`. The exact audited Node 26.13.0
target/source/native-reference pin and completed audit remain unchanged.
This is partial implementation work, not API/family closure or four-host
conformance. The current source recipe is90; the last accepted engine88
contains neither this slice nor the process-lifetime slice from recipe89.

## Source and real owners

`kdf-platform-adapter.js` embeds both complete unchanged pinned public
modules. Their argument order, byte conversion, integer checks, scrypt
aliases/defaults/getter order, callback overloads and Buffer result creation
come from Node. The manifest validates all nine retained public/native
reference files against the exact pin, including the real job-mode enum.

`native-kdf.cpp` constructs real native resource objects with
PBKDF2REQUEST/SCRYPTREQUEST identity. Native configuration validation and
async input snapshots precede init hooks. Sync inputs remain rooted and are
read at run time after init. Native owned copies use atomic shared-byte
loads and cleansing destruction; no borrowed JS span crosses a worker or
JavaScript callback. Sync jobs derive on the caller; async jobs submit CPU
work to the existing guest pthread pool and enter the shared native callback
scope on the owning thread. Cancellation/shutdown retires owners and
suppresses canceled callbacks. Output is a real ArrayBuffer consumed by the
unchanged public Buffer wrapper, with separate owned native error records.

The implementation adds private native bindings and resource classes; it
does not change syscalls, kernel/host wire layout or platform identity.
The normal package recipe stages the new header, assembles the native unit,
applies patch91 and embeds the shared source used by all four hosts.

## Backend version prerequisite

The previously selected OpenSSL3.3.2 did not provide the pinned target's
XOF/PBKDF2 failure metadata. The shared OpenSSL package now selects3.5.9,
matching the pinned Node source's bundled VERSION.dat and native reference.
The upstream release and archive checksum were verified against the
[official downloads](https://www.openssl-library.org/source/) and
[release](https://github.com/openssl/openssl/releases/tag/openssl-3.5.9).
The exact SHA256 is
`603f5602e2eef00d77fbd429d34dcd5822bb301757a1bc9cdb24c670f1eb859a`.
OpenSSL recipe revision6 retains the existing SDK/thread/static-library
configuration. No installed artifact is renamed or retagged.

The zero-length PBKDF2 nonpass was also an independent owner bug: our
initial adapter forced a one-byte allocation. The current owner uses the
actual target OPENSSL_zalloc allocation semantics. Null allocation yields
the actual derivation failure; scrypt separately retains its explicit
zero-length success path. Real provider errors supply XOF rejection and
error metadata. No digest-specific error or passing result is fabricated.

The only new dependency build is an identified native control library:
OpenSSL3.5.9, four make jobs, about55 seconds. It uses the same relevant
thread/static/no-asm settings but a native Darwin target, not the guest SDK.
It is never installed into the resolver or guest image. The guest OpenSSL
dependency, engine90 and complete consumers remain uncompiled. Existing
engine88/3.3.2 results retain their original identities and limitations.

## Evidence and preserved nonpasses

* `.context/node26-kdf-native-r6/report.json`: twenty strict portable-owner
  versus exact native26 comparisons pass, including binary/NUL input,
  digest aliases, SHA/XOF/provider errors, zero output and real scrypt
  parameter/memory failures. Expected errors remain explicit error records.
* `.context/node26-kdf-frontend-r3.json`: seven focused source/native-job
  controls pass. They cover bytes/backing sources, validation/getter order,
  alias/zero behavior, inherited-error prototype poisoning, actual callback
  receiver/async scope, mutation after
  async construction, and init-time sync versus async input ownership.
* `.context/node26-kdf-upstream-r2/report.json`: two unchanged upstream
  files pass in candidate and native modes, with no file-level skip.
  These are test-file counts, not a complete API or assertion denominator.
* `.context/node26-kdf-dependency-consumers/report.json`: the unchanged
  portable digest and Hash/Hmac controls match native26 across five
  algorithms each; the existing concurrent entropy/thread-local-error/
  secure-allocation owner control also passes with the new native library.
  This is not TLS handshake or guest-consumer validation.
* `.context/node26-kdf-source-r4/report.json`: exact pinned inputs,
  generated combined bootstrap syntax, patch forward/reverse identity,
  source-only test registration and unchanged Mozilla style checks pass.

Native r1 recorded15pass/5fail; r2 recorded18pass/2fail; upgrading the
native library in r3 recorded19pass/1fail, exposing the separate allocation
bug. Exact original sources/artifacts/logs remain retained. The initial
frontend control also had an authored zero-output-success expectation
contradicted by native Node; that original failure/source is retained, and
the current control requires the target's actual error. No upstream test
body or assertion was changed. Later passing runs do not relabel earlier
nonpasses.

## Remaining work

Guest compilation and native request/JSAPI execution remain unverified.
Actual GC/realm/worker teardown, cancellation, init-hook reentry, detached/
resized sync input changes during hooks, OOM/error construction and complete
native/provider memory accounting still need built-artifact review and
controls. The seven frontend controls deliberately use real native Node
process/crypto/async resource dependencies; they do not execute Kandelo's
new C++ job bridge. Portable native derivation checks do not establish guest
pthread scheduling, syscall ownership or behavior on any browser host.

HKDF, Argon2, real KeyObject/CryptoKey and WebCrypto derivation jobs, key
import/export/generation, ciphers, signatures, exchange/KEMs, certificates,
FIPS/property/provider policy and the rest of the crypto audit remain gaps.
The private unchanged PBKDF2 WebCrypto functions have no wired key/job owner
and are not advertised as public SubtleCrypto support. All existing
process/SQLite and other-family gaps remain open. Overall suites and the
full product rebuild remain deferred.
