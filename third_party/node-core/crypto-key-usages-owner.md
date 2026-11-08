# Actual CryptoKey usage-mask owner

Complete pinned crypto/util.js canonical usage/mask/set algorithms now back the
existing keys.js consumers. Actual public usages metadata is cached separately
from the immutable native mask; changing that array or shadowing public getters
cannot grant internal hasCryptoKeyUsage authority. Generic secret import uses
real existing native KeyObjectHandle initialization and InternalCryptoKey class,
rejects extractability/forbidden usages in target order, and retains owned bytes.
No new algorithm/support table or metadata-derived authority is introduced.

This is partial crypto.md C-007 and scoped CryptoKey/rights prerequisite work.
The public KeyObject.toCryptoKey route first requires missing crypto WebIDL
and then the genuine normalizer/algorithm import owners; full Subtle/Crypto singleton, Promise,
native jobs, provider/FIPS/capability and operation-specific validation remain
implementation gaps, not platform exclusions. This slice activates no partial
Subtle namespace or host production delegation. Low-level generic import may
produce an empty-mask internal key; its future public caller retains required
post-import admission checks. Unknown algorithms are not normalized here.

Native controls use actual pinned Node/OpenSSL key handles/classes/slots and
native Buffer/inspection/Values as explicit component dependencies. Candidate
JS algorithms/real private-key state are exercised, but Kandelo native JSAPI
slots/GC/realm/transfer/fatal/Worker and four-host conformance are not proved.
No native code, role gate, key-format assertion, target pin or ABI changes.
