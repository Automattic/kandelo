# Own indexed lock receiver state

Source131 uses captured ObjectDefineProperty with a null-prototype descriptor
to insert the private receiver’s victim records. ArrayPrototypePush invokes
inherited indexed setters even when captured;it could expose/drop root records,
throw or reenter between native preview and commit. Own insertion preserves the
existing two-phase manager and real waiting/released Promise ownership without
invoking user code at that internal boundary. Public Array prototypes are intact.

Production native packets already use JS_DefineElement. The NAPI fixture used
ordinary napi_set_element,so its packet/query arrays now use own definitions
as well. This corrects a distinct fixture boundary,not production JSAPI proof.

Root compiled the corrected fixture and ran the unchanged10original+7review
public groups in both native/candidate modes,plus2existing candidate-only
allocation-failure groups. New prototype controls pass:4native and7candidate
groups exercise dropping,throwing and reentering setters,isolated receiver vs
packet stages,and query packet arrays. Receiver/packet setter calls remain0;
old holders reject AbortError,the thief fulfills,and no held/pending state is
lost. Three extra candidate groups isolate receiver timing,not extra API count.
The same new assertions intentionally fail the old receiver with corrected
fixture and the old fixture with corrected receiver,separately. Both expected
baseline failures and the original review observations remain saved.

Four exact delta paths,bundle/bootstrap syntax,unchanged target/audit and638
source inputs pass. Twelve package-input controls pass. No engine patch or
native production fragment changed;no complete engine/guest test ran. Root’s
one host NAPI helper compile is separate from package/engine build accounting.

R-015 remains partial:lazy native-data descriptors/HolderV2 creation-realm,
global Navigator ownership,query-name ordering,termination scheduling and
actual JSAPI/OOM/realm/provider/four-host acceptance remain open. Source117–131
is uncompiled as a combined engine;accepted116stale and failed127evidence stays
explicit. Existing crypto consumers/cipher,SQLite,Error,compression and other
nonpasses remain open. No full product rebuild/overall suite/merge/deploy.
