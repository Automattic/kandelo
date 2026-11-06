# Shared worker locks and receiver ownership

Source129 integrates the reviewed portable manager and exact complete pinned
Node26.13.0 internal/locks public module. The process/thread-shared C++ owner
holds copied UTF16 names,client IDs,modes and held/pending/stolen state under
an actual mutex/condition variable. It holds no foreign JS values. The owning
context keeps real callbacks and both waiting/released Promise resolvers.

Grant/steal delivery previews native state,allocates its packet and receiver
error roots,then commits only if the same request/victims are still eligible.
Stale previews retry;allocation failure does not consume victim notification.
Only the undelivered submitter retires after failed request dispatch. Consumed
callback roots clear even when a synchronous throw leaves a target-observed
held lock. Both actual Promises settle in pinned order,including independent
thenable resolution. Query creates its inner Promise before its snapshot.

Engine patch0106 rotates native-work,port,worker and lock providers after
actual progress. A normal tick/job checkpoint follows each completion and
the native completion/GC-close fence is preserved. Existing idle measurement
and bounded deadlines remain. Deliverable lock work can keep the loop alive;
an unresolved held/blocked Promise alone cannot. Context retirement releases
held/pending metadata before child joins. Cross-context events remain local
JS callbacks and shared native metadata,never host navigator locks.

## Scoped evidence

Root compiled standalone manager/thread,transaction and fixture NAPI owners.
Seventeen identical public groups pass in native and adapter modes;two extra
candidate-only groups inject packet/receiver allocation failures. Those model
transactional behavior,not actual SpiderMonkey OOM. The manager exercises
1,000real threaded exclusive grants. A target Wasm object also instantiates
portable request/preview/commit/query/retirement and provider code through the
actual SDK. No native JSAPI fragment or complete engine was compiled here.

Thirty-eight affected async/port/loop checks and12package-input checks pass.
Three whole references match the exact Node archive. Generation/bootstrap
syntax,native unity order,636declared inputs and0106zero-fuzz forward/reverse
composition pass against the already verified124+0105canonical shell.

One complete unchanged upstream diagnostics-channel file passes both modes.
The candidate fixture substitutes ONLY navigator.locks service with the public
module/adapter over the actual portable manager using NAPI. Navigator and
runtime remain native;this does not establish Kandelo global Navigator support.
No assertion/platform identity was changed. The larger worker/WPT selections
remain later validation,including tests using real foreign event-loop wakes.

Sealed original/review/fix evidence is preserved. Three reproduced differences
(thenable result,query snapshot timing,callback payload retention) are corrected
in source and match focused native controls. Initial aggregate-initializer,
syntax and non-enumerable-primordial fixture failures remain saved. The exact
proposed provider block passed a separate private source-extracted400-turn/
100-grant control with100native/GC-fence checks;root verifies its exact engine
postimage. That is host/source evidence,not engine scheduling acceptance.

## Remaining gaps and evidence boundaries

R-015 remains partial. Manual worker_threads.locks accessor installation does
not implement native SetLazyDataProperty descriptors/HolderV2 creation-realm
behavior (target worker_threads.js:58–63,node_util.cc:364–439). This is a shared
lazy-data owner gap with util APIs,not an accepted engine exclusion. Kandelo
has no complete public Navigator owner/routing;the target global locks alias
still needs that actual owner. Source integration adds only worker_threads.

Reference worker-holder termination required another request after a100ms
observation while candidate retirement wakes immediately;that difference stays
unresolved. Query ordering across distinct names and foreign stolen/query
visibility remain unresolved. No stale retention or fake keepers are added to
force equality. No accepted runtime/platform exclusion or API closure exists.

Real JSAPI/GC/OOM/interruption/realm,foreign grant/steal/abort/teardown,unref/
beforeExit/exit,actual provider fairness,unchanged worker/WPT selections and
four-host controls remain unvalidated. Source117–129is uncompiled as a complete
engine;accepted116stale. Failed127Linux-header/SDK-plugin evidence remains
open;128header compilation does not turn that build into a pass. Source-only
checks and standalone owner compilation do not establish public conformance.
No full product rebuild,overall suite,merge,deployment or performance claim.
