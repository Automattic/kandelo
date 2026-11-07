# Module hook source, URL identity and mocking ownership

Source180 integrates the sealed module-mock dependency and actual generic
ESM source graph. It composes both with174VM/175SQLite/177Net/178Domain/
179WASI source rather than replacing older shared whole files.

## Real owning behavior

The shared synchronous resolver/load owner consumes genuine hooks and
unchanged pinned validation/default-load/source algorithms. MockTracker.module
uses this actual owner, CJS records/cache/restore, actual caller frames and
real CLI-only activation. It does not invent a second mock-specific graph.
The old executable query/fragment rejection is removed alongside its real
full-URL/type native registry and source consumer.

Parsed import attributes are retained in traced ModuleRequest slots. Static
native resolutions memoize the actual record by referring-private value and
actual ModuleRequest object because SpiderMonkey resolves again during export
lookup. Dynamic import/import.meta.resolve still resolve afresh. Source-module
private metadata retains the full URL; synthetic records use their real
traced owner, never the source-only SetModulePrivate API.

Actual supplied ESM compiles natively. Builtin/JSON/CJS synthetic records use
existing native environments/evaluation. Exact unchanged Merve1.2.2 derives
CJS exports/reexports without executing during preparse. Private prepared
source transactions feed real Module._load/_compile on evaluation and share
real exports/cache records. Eligible plain file JSON shares CJS cache;
queried/fragmented JSON has its own identity. Opaque hook URL spelling stays
intact. Native execution of these new bridges remains unestablished.

Root review corrects native compile-failure cleanup: AutoSaveExceptionState
snapshots the actual error and explicit restore replaces a new cleanup error.
The destructor alone would not. A failed private cleanup hook can still leave
the source transaction cached; preserving the original error does not close
that separate retirement gap. The new source path is uncompiled/unexecuted.

## Exact current evidence

Four whole unchanged upstream hook files run on both native and candidate
(8executions). The unchanged first3complete top-level module-mocking groups
run21tests per subject;20of23top-level groups remain unrun. Original selection
boundaries/assertions are intact. Six loader and seven mock semantic groups
per subject, source/parse/evaluation/CJS preparse lifecycle comparisons,
14actual CLI comparisons and25unchanged lexer comparisons pass.

The component executes current candidate hook/source/cache/Test/MockTracker
algorithms over explicit pinned native VM/fs/package/MIME/encoding/lexer/stack
boundaries. Node VM SourceTextModule/SyntheticModule is a control dependency,
not a production fallback or proof of new SpiderMonkey native behavior.
The actual source CLI extraction is byte-identical to its identified existing
compiled owner. Unchanged Merve/header inputs and SDK object identities are
bound; root performs0new compiler commands. Integrated accounting adds the
4earlier successful attempts (3native executables,1SDKobject), not copied logs.

Current817input closure, normal bootstrap/unity/vendor staging, the unchanged
Mozilla checker and14package checks pass. The normal checker initially caught
an owned include ordering error and quoted third-party header spelling; actual
source was corrected, with no checker/ignore/expectation changes. The imported
lexer/license remains at the genuine vendor boundary and CXX20 is explicit.

The seal references have two identity kinds: the embedded canonical manifest
digest differs from SHA256of the outer JSON bytes. Both kinds and all members
are verified. The initial guard failure is retained; neither seal was changed.
The old EOF build hunk, executable-copy mode failure, private source-option/
load-error/CLI/fixture failures and exact original evidence remain preserved.

## Remaining implementation and conformance

Actual native GC/OOM/realm/slots/static memo/synthetic metadata/error and
teardown; failed cleanup cache retirement; early unsupported attributes and
request phases; async loader workers; TS/wasm/addon translators; require cycles,
async graph admission/link-failure caching; builtin export synchronization,
source maps/compiler cache/entry/permissions/diagnostics and remaining public
loading/testing/worker requirements remain open. Native lexer string-allocation
failure handling also differs from target omission policy and needs owning
reconciliation. None is an approved platform exclusion.

Current180has no accepted combined engine artifact or identified guest
conformance on Node/Chromium/Firefox/WebKit. Accepted173predates these changes.
No overall suite, engine/kernel/library/product build or full rebuild ran.
No finding or family is closed. See the scoped JSON ledger for exact identities.
