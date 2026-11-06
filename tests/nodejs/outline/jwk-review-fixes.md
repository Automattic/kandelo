# Native JWK byte and material authority

Source130 fixes the reviewed public-allocator boundary: native JWK input now
linearizes rooted immutable strings and decodes Latin1/UTF16 characters into
private cleansing native bytes without entering JavaScript. Three exact pinned
Node26.13.0 nbytes decoder selections preserve lenient base64/base64url and
UTF16 low-byte fallback. Canonical unpadded base64url export likewise uses native
bytes/strings. The key adapter no longer reads or passes Buffer codec callbacks.
Public Buffer behavior is unchanged. Full nbytes references and hashes are keyed.

Masked JWK getter positions replace only ordinary catchable exceptions;actual
SpiderMonkey OOM and exception-free interrupt/forced-return failures propagate.
Export raises operation-failed only at actual extraction/property refusal sites,
not as a fallback after arbitrary JSAPI failure. A separately rooted material
slot survives reentrant target mutation/GC. Destination handle realm entry owns
material allocation/wrapping/stores;foreign prototypes are read in their realm.
These are source fixes using real JSAPI roots/compartments,not synthetic keys.

## Evidence and explicit limits

Root20key groups pass:19existing plus one new group exercising7imports/exports
that forbid any JWK JavaScript-codec access/extra dispatcher callback. Native
handles are the dependency fixture;they do not execute candidate native-keys.cpp.
Twelve package-input checks pass. Source/generation/bootstrap/native-unity,
638input closure,10whole pinned references and3exact decoder selections pass.

Private12,308native byte comparisons and226material comparisons passed;root
verified exact source/dependency/executable/corpus/output hashes,not a second
run. Native public Buffer allocator poison invoked user code zero times;the
original candidate codec failure remains preserved in the independent review.
Seven private callback-boundary comparisons also pass. Initial argv,path,
fixture-name and source-marker setup failures remain stored under the sealed
private evidence. They are not compatibility passes or runtime defect claims.

Four complete unchanged upstream files ran again in candidate/native modes:
all4native pass;2candidate pass and2retain consumer nonpasses(6pass/2fail).
EC-private reaches native signing’s separate #slots class;multi-prime reaches
native WebCrypto and strict Buffer prototype equality. No normalization,
assertion change,consumer shim or exclusion turns these into passes.

Native JSAPI was not compiled/executed. Actual OOM/interrupt/forced-return,
reentrant target proxies/GC/slot replacement,foreign realms,associated memory
and worker/four-host behavior require identified rebuilt engine controls.
Asymmetric provider allocation pressure and key transfer remain incomplete.
Other native hash/cipher private string-codec callbacks remain under separate
review;this does not claim their correctness. No new ABI/wire/memory ceiling
change;the private adapter/engine must be rebuilt coherently. No new whole
engine/package/kernel build,overall suite,full product rebuild,merge or deploy.

Source117–130remains uncompiled as a combined engine;accepted116is stale and
failed127header/SDK-plugin evidence stays explicit. Root129locking source also
has a newly reproduced inherited-setter issue in receiver victim-array storage;
a separate private fix is in progress. Lazy-data/global Navigator and all other
family/public API gaps remain open. All19families partial;no closure claimed.
