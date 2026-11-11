# Native Error stack contracts

This is a bounded startup inventory for Node26.13.0 at
`18b32a3b1552e199a01f1a8d9fd64aa756d3b75b`. It does not establish complete
structured-stack compatibility, fatal process routing or upstream startup.

## Bootstrap ownership

Unchanged `internal/bootstrap/realm` eagerly retrieves the errors binding,
loads the complete `internal/errors` module, registers
`setPrepareStackTraceCallback` and `setEnhanceStackForFatalException`, and
installs the original JavaScript `ErrorPrepareStackTrace` function. The eager
native dependency of `internal/errors` is
`util.privateSymbols.arrow_message_private_symbol`; its `uv` and `os` binding
requests are lazy. These symbols must come from the canonical runtime owner.

SpiderMonkey140 already has a native `Error.captureStackTrace`. Original
primordials already captured that intrinsic; an earlier checkpoint incorrectly
inferred its absence from the embedding patch inventory alone. Its original
capture path eagerly formats a string and does not implement Node's lazy
preparation contract. The new owned-realm policy extends real engine capture;
ordinary shell realms retain their original behavior.

The stack policy is installed before the three unchanged context initializers.
One canonical per-context state traces the original Error constructor,
preparation/fatal callbacks, prototype and a WeakMap of captures. WeakMap
ephemerons own saved-frame and prepared-value edges without retaining dead
targets through a finalizer root. The binding getter requires Ready state;
error allocation can still use the canonical state during initialization or
after its terminal failure. The runtime-wide preparation guard prevents
reentry across owned realms.

## Implemented core and limits

| Surface | Implemented behavior and remaining scope |
|---|---|
| `Error.stackTraceLimit` | Read actual data properties without getters/coercion, including inherited data; stop at Proxies without traps. Numeric negative/NaN limits capture zero, fractions truncate, non-numbers disable preparation. Limits are fixed at capture time. |
| `Error.captureStackTrace` | Keep the original native intrinsic and actual constructor-identity trimming. Owned captures budget frames after trimming, install real own accessors and support re-capture. Original unowned budgeting remains unchanged. |
| `.stack` | Prepare lazily, cache any successful value including undefined, preserve assignment, retry thrown callbacks and use real default frames under recursive preparation. Borrowed accessors look up actual captures in their creation realm. |
| `setPrepareStackTraceCallback` | Trace and call the actual function with undefined receiver and `(creationGlobalThis, error, trace)`; preserve its result/exception. |
| `setEnhanceStackForFatalException` | Trace both callbacks and provide an actual native phase dispatcher with original error argument/undefined receiver. The guest process's uncaught/fatal reporting path is not connected yet. |
| CallSite core | Real saved-frame names/locations and original filenames from active engine ScriptSources. `getFileName` stays distinct from a `sourceURL` display name; unavailable historical filenames raise an implementation error. Traced fields survive GC. |
| Explicit CallSite gaps | Receiver/function/type/method/eval-origin, toplevel/eval/native/constructor/async flags, Promise-all/index and Wasm metadata raise implementation errors. No placeholder booleans, receiver objects or empty frames are returned. |
| Additional native surface | V8 also registers enclosing line/column, position and script hash methods; these are not yet exposed. Full registration/error/realm/security/lifecycle equivalence is open. |

The formatter uses real saved-frame names and locations. V8's method-alias,
constructor, eval, async and Wasm formatting needs richer capture metadata;
this core does not claim those formats or native function/receiver identity.
Do not infer missing flags from source text or return fabricated defaults.

## Evidence and next integration

The identified revision-23 package has 21 Node-host guest controls and 18
separate exact native reference controls. Its 85 ModuleWrap/dynamic-import,
synthetic, context and private-key regressions use the same artifact. Raw
assertion traps are retained separately from successful runs. Exact inputs,
artifacts, earlier failures and limits are in `error-stack-engine-check.json`
and `error-stack-native-reference.json`.

Connect one native realm/process/builtins/errors/util owner, store the actual
upstream internal loaders and execute complete `internal/bootstrap/realm`.
Use real guest metadata; do not copy the native reference's platform/config.
Keep richer CallSite and fatal-routing work tied to actual startup consumers,
and catalog the remaining contracts for the later review gate. Browser hosts,
CJS/ESM startup, full native differential, security/OOM/finalization, canonical
products, successor-ABI campaigns, overall suites and fork behavior remain
unverified or deferred.
