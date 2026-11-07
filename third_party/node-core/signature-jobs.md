# One-shot signature jobs

The unchanged pinned sig.js signOneShot/verifyOneShot algorithms connect to real
SignJob constructor/run operations. The existing streaming owner remains
independent. The actual key is parsed/imported before job initialization and an
EVP_PKEY reference is retained for native worker lifetime, without JS pointers.
OpenSSL STORE/key generation/permissions remain concrete separate gaps.

Admission follows the pinned native order: key; data size/original synchronous
allocation versus asynchronous copy; digest; salt/padding/encoding; context
(max255 bytes); verify signature. P1363 DSA/ECDSA signatures are converted during
construction for both modes; malformed one-shot conversion becomes an empty
signature and a verification false result, unlike streaming Malformed signature.
Synchronous DER/data/context spans retain the actual original allocations through
init hooks/detach/GC and are copied at run. Async snapshots precede async init and
are native-owned, cleansing vectors. Negative signed padding does not set the
pinned uint32-admission flag and uses the key default.

The private real SignJob resource uses the common native CPU queue and captured
SIGNREQUEST async lifecycle. Workers execute only native owned configuration.
Supported one-shot key algorithms, context support and EdDSA checks come from the
actual key/provider, with no fabricated capability flags. Prehashed fallback is
limited to the pinned cases, excludes SM2/context, and only retries a negative
verification result. Actual mismatch zero remains false. Shared CryptoErrorStore
owns provider messages/decorations and the exact fallback errors. A catchable
result-conversion exception reaches ondone as its original exception; cancellation
suppresses callbacks while common teardown retires actual work.

Key/data/error/output owners are RAII-managed. JSAPI allocation/root/realm checks
and actual retained spans belong to the guest owning thread. Config/temporary
vector charges use actual capacities, not logical result lengths or predicted
provider storage. Worker output capacity is charged on the owning JS thread
before result/callback conversion. Opaque provider/error/transient worker
allocations and cross-host fault/GC/teardown behavior are not fully accounted or
validated by this slice. No RSS claim is made.

The nativeResourceInfo router admits the actual SignJob and previously omitted
HKDF request classes, allowing the existing real resource ID/frame/provider to
be consumed. This does not establish runtime HKDF conformance.

Focused controls compile the actual portable operation over the exact native
reference's exported ncrypto/OpenSSL. V8 backing leases, native key import/DER
transport, Node C++ AsyncResource and libuv work remain explicit control
boundaries. Current native component evidence retains an AsyncLocalStorage frame
nonpass: the C++ callback control path loses the frame; native crypto SignJob
retains it. That does not identify a guest defect or justify an exclusion.
Production uses the existing Kandelo captured-frame/native callback scope and is
uncompiled/unexecuted here. Native reference and guest OpenSSL3.5.9 share a version,
not an artifact/configuration. Full guest/four-host validation remains open.
