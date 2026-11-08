# Genuine provider MAC inventory prerequisite

Public crypto.getMacs and private digest helpers consume actual native provider
fetch/name enumeration; no fixed list or fake provider IDs. Exact pinned runtime
FIPS-generation cache loop and public getMacs const preserve returned-array copy,
lowercase/sort/dedup and refresh behavior. No globalisBuildingSnapshot stub: V8
snapshot serialization callback branch is unselected and remains missing.

Target crypto_mac.cc filters names by actual fetch/default properties, discards
numeric OIDs, ASCIIlowercases and sorts/deduplicates. The owning temporary vector
retains no provider pointer; C callbacks catch native allocation failures before
returning across C; errorqueue uses actual ncrypto MarkPop. JS publication creates
own array elements, bypassing inherited numeric setters. ExistingFIPS lock ends
before JS allocation; nativequery/JSAPI not compiled in this source slice.

Normal full WebCrypto normalizeAlgorithm is still missing: registry consumes
getCiphers/getHashes/getMacs, native key algorithm availability and actual KmacJob
(Argon2 owner already exists). Missing KMAC job is not a reason to advertise KMAC
as unsupported. isKeyAlgorithmAvailable and full normalization/validators/jobs/
Subtle/import remain owning implementation gaps, not accepted boundaries. Native
MAC alias-index/cache integration is not implemented; this route publishes names
only and creates no fake IDs or native handlecache.

Source-only partial C015 publicMAC inventory and C007normalizer prerequisite.
Existingnativecomponent controls cannot prove candidateCPP/provider/errorqueue/
OOM/GC/realm/Worker/snapshot/fourhost conformance. No full createMac/crypto closure.
