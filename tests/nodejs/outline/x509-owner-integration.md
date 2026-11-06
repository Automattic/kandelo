# X509 certificate ownership integration

Source157 replaces the X509 constructor stub with actual ncrypto certificate
material and a GC-owned native Box. Pinned wrapper algorithms provide public
validation, caches, descriptors, Date/raw/PEM/JSON/inspection and public-key
results. Actual native operations perform parsing, metadata, CA/issuer/private-
key/signature checks. Public keys reuse the existing native KeyMaterial owner.
The source/metadata/normal engine registration is additive over current CJS,
SQLite, Locks and Body work; the combined bundle is regenerated normally.

Constructor acquisition uses the already checked-unwrapped actual view in its
source realm. Public nonallocating data/length readers run under a no-GC guard;
shared bytes use actual atomic copy and unshared bytes are borrowed only through
synchronous parsing. The realm restores before caller-realm result allocation.
The old mixed admission/raw-object IsBufferSource path could reject an admitted
foreign view without an exception. This is a concrete source-path correction;
no NAPI/native control exercises the new SpiderMonkey path. Shared crypto-helper
allocation/no-GC and async random ownership issues remain separate open work.

Current740-input/bootstrap/normal header/unity checks pass. Twenty-one fresh
native component groups match with byte-identical case assertions and actual
ncrypto material. A separate actual private Buffer-codec/unpooled-owner check
confirms raw Buffer brand, exact1004-byte backing/offset0, cache identity,
public-codec poisoning bypass and certificate independence.32 existing web and
14 package-source checks also pass without skips. Native key/VM/encoding and
NAPI transport are explicit test dependencies, not the production SM slot bridge.

The original speculative claim that cx->isExceptionPending did not compile was
retracted after inspecting complete private JSContext visibility in the actual
shell. No speculative API cleanup remains. An initial root source check caught
a duplicate EOF newline in final bundle assembly; the new final assembly block
now emits one newline. Imported source/assertions are unchanged; failure saved.

Matching, standalone issuer getter versus native undefined, issuer/TLS graphs,
legacy conversion and cloning remain implementation gaps. Actual JSAPI key/realm/
GC/OOM/concurrent-view paths, OpenSSL/control-block accounting and current
four-host conformance remain open. No current engine artifact or API/family
closure is claimed. Overall suites/full product rebuild remain deferred.

Exact evidence: [x509-owner-finding-progress.json](x509-owner-finding-progress.json).
