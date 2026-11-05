# Native digest and comparison source owners

C-002/003/005/006/013 and the crypto.hash/getHashes/timingSafeEqual
observations have partial source owners. The exact Node 26.13.0 pin and
frozen audit remain unchanged; no finding/family/four-host closure follows.

## Actual owning paths

crypto-digest-adapter.js selects the unchanged public one-shot hash function
and normalization, byte validation and duplicate-filter helpers from pinned
Node sources. Full and selected source hashes are checked by build.py.
Strings, genuine views, output encodings/lengths and cSHAKE option validation
therefore follow the retained public algorithms. Output uses the existing
Buffer owner. Provider lookups deliberately use the uncached private path;
no Node-native algorithm indices or FIPS generations are invented.

digest-operations.h owns real EVP_MD_fetch/EVP_MD_CTX operations, provider
enumeration, aliases, fixed/XOF lengths, digest finalization and
CRYPTO_memcmp. Fetched digest/context owners use deterministic RAII cleanup.
Owned temporary input/output bytes are cleansed before release. Names come
from current legacy/provider enumeration and actual fetchability; the NULL
digest is excluded as required by the pinned ncrypto owner. Public name
deduplication/sorting is the retained Node helper. The old four-name preset
is removed. A fresh list does not advertise complete incremental or key APIs.

native-digests.cpp copies strings with their full encoded length, captures
actual buffer-source spans and owns the resulting bytes across libcrypto
calls. Shared input uses relaxed atomic byte reads instead of racing native
memcpy. This is a capture of current shared bytes, not a coherent snapshot
under concurrent mutation. Native brand/length checks precede comparison;
the comparison uses CRYPTO_memcmp, never a JS XOR loop or Buffer coercion.
The public errors match the native type/length diagnostics. No measured
timing or cryptographic-security certification is claimed by value tests.

Patch 68 also broadens the existing incremental Hash/Hmac resolver to real
provider names, removes strlen truncation from its string input helper,
cleanses temporary HMAC keys and makes private slots safe before initialization
or failed allocation. Native context initialization acquires its digest
reference before the fetched owner retires. These engine paths remain
uncompiled; source changes alone do not validate incremental Hash/Hmac
receiver/options/copy/stream/finalization or GC behavior.

Recipe revision 50 includes the two native inputs and the same existing
OpenSSL 3.3.2 dependency. No target/backend version is silently upgraded,
no kernel/libc/host import or wire ABI changes, and all four guest hosts
select the same source. The target's newer OpenSSL remains a separate
dependency for remaining crypto algorithms and provider policies.

## Scoped evidence

* A worktree-local native OpenSSL 3.3.2 libcrypto build uses the verified
  package source archive and relevant no-asm/thread/dso/engine/async/I/O
  settings. This is a native control library, not a guest package/product
  build. Architecture and compiler inputs remain explicitly different.
* The portable helper linked to that actual library returns the same 81
  public digest names as the exact Node/OpenSSL reference. All 81 common
  names produce matching one-shot digest outcomes for a NUL-bearing input.
  This does not establish algorithm availability for other crypto APIs.
* Five new digest/comparison controls plus six affected synchronous-random
  controls pass. They cover real portable digest/comparison calls, pinned
  public wrappers, encodings, SHAKE lengths/options, byte spans, Unicode/NUL,
  genuine buffer-source validation and errors. Node engine/brands/record
  conversion are explicit host controls, not guest JSAPI validation.
* Two unchanged upstream one-shot files pass in candidate and native modes.
  Candidate mode replaces hash/timingSafeEqual only; native getHashes and
  createHash remain unfiltered oracle inputs. Large XOF output is retained.
  No assertions, platform identity or algorithm selections are weakened.
* The first missing native-only error constructor, extra NULL provider name
  and fixture ENOBUFS failure remain recorded with inputs. The XOF fixture
  transport now admits its 2 MiB hex serialization; the upstream 1 MiB digest
  assertion is unchanged. Repeated runs are not added as new API coverage.

## Remaining work

The subsequent random-job slice implements the full pinned OpenSSL
error-library prefix map with a source-generation guard, and fixes the
package's no-thread configuration. The earlier native digest evidence used
that no-thread library and establishes no concurrency safety. See
[random dependencies](random-implementation-dependencies.md) for the actual
threaded native control and normal Wasm library builds; the guest engine
has not been rebuilt against those outputs.

Actual JSAPI compilation, buffer transfer/detachment/resizable/shared races,
cross-realm/GC/allocation-failure controls and guest native error queues
remain open. Input capture/temporary bytes
have not established full engine external-memory accounting or backing-store
limits. Existing incremental Hash/Hmac still need the real public classes,
stream hooks, encodings/options/copy, key preparation, repeat-finalization
and request/lifetime contracts; their source improvements are not runtime
passes. Complete FIPS/provider generation/cache/configuration and related
permission/CLI controls also remain requirements.

Async entropy now has a partial source owner with unresolved transfer/lifetime
semantics; it is not passing compatibility. Async digest jobs,
keys/certificates, cipher/signature/KDF/KEM and
WebCrypto algorithms, namespace descriptors/aliases and backend version/feature
gaps remain crypto-family implementation work, not accepted platform limits.
Later unchanged upstream digest/stream/HMAC/comparison tests and native
controls must run against actual rebuilt guest artifacts on all four hosts.
The full product rebuild and overall suites remain deferred; continue other
independent audited owners before expanding this digest test campaign.
