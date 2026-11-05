# CommonJS wrapper ownership and invocation

Source revision 119 implements another loading-family slice for public
`Module.wrap`, `Module.wrapper` and their actual `_compile` consumer, including
the initial-exports receiver requirement L-026 and cache rollback L-007.
These broad findings and the complete public APIs remain open. The audited
Node 26.13.0 source/native pins and completed audit are unchanged.

## Actual source and engine owners

The complete wrapper section is selected unchanged from the pinned
`lib/internal/modules/cjs/loader.js`: default function/array contents,
nonenumerable nonconfigurable accessors, live replacement values, real Proxy
set/defineProperty traps and sticky patched state. Deletion alone retains
the target's actual unpatched policy. The accessors are installed after the
real Module cache/path/extension/global-path fields. Full namespace property
order and other reflection remain a separate obligation.

`module-record-platform-adapter.js` owns that state alongside the actual
Module records. `module-syntax-platform-adapter.js` consumes it. Unmodified
CommonJS retains the native function-body compiler: source cannot escape a
concatenated wrapper, and construction does not execute the body. When the
wrapper is patched, the actual public function receives the original source
and supplies a script. Ambiguous CJS source follows this patched script path
instead of the ordinary compiler's ESM-detection route; explicit formats
keep their existing owner. Shebang normalization applies to the ordinary
function compiler rather than silently rewriting input to a public override.

`native-module-syntax.cpp` supplies the explicit wrapped-script operation
through real `JS::Compile` and `JS_ExecuteScript` in the current global. It
uses complete UTF-16 source, including NUL/surrogate data, and registers the
actual referring source with the existing script-private owner before
execution for nested dynamic imports. It does not use the older UTF8
C-string evaluator, perform source-text detection by execution, or delegate
the guest implementation to embedding-host Node VM APIs.

The shared bootstrap invocation now snapshots `module.exports` once and
uses that exact value as both wrapper receiver and first argument. Directory
name is computed before that getter, retaining the pinned invocation order
even when the getter changes the public path helper. A real
native comparison exposed two prior getter reads selecting different objects.
The source fix preserves the target's single-read contract and direct return.

The recipe now declares the changed module-record adapter as an explicit
input. Existing private compiler registration is reused; there is no new
kernel/host wire, syscall, ABI version, memory ceiling or target pin.

## Evidence and its limits

* `.context/node26-module-wrapper-source-r3/report.json` verifies the complete
  loader file and selected section against the canonical archive, generation,
  bootstrap syntax, declared inputs and selected source identities. A held
  Mozilla API header is recorded without claiming a new full archive closure.
* `.context/node26-module-wrapper-frontend-r5.json` records eight new native
  differential controls and fourteen affected loader/parser controls passing.
  They use actual candidate records, bootstrap/compiler dispatch and pinned
  wrapper algorithms, with explicit native Node parser/VM/fs/URL/error
  dependencies. They cover descriptors/Proxy/default conversions, function/
  array/object overrides, source/error/cache lifetime, original shebangs,
  ambiguous format policy, script prelude/direct return, Unicode/NUL input,
  sticky/delete behavior and single exports-getter receiver ownership.
  This does not run the new guest C++ branch or establish all error metadata.
* The first two frontend reports retain twenty-one passes before adding the
  exports-getter comparison. Frontend r3 retains seven passes/one failure:
  candidate read the getter twice while native read once. R4 passes the
  unchanged new assertion after fixing the shared invocation. R5 additionally
  checks directory-before-getter ordering and passes all twenty-two controls; no expected
  result or upstream assertion was weakened.
* `.context/node26-module-wrapper-upstream-r3/report.json` records two
  unchanged pinned upstream fixture files, each executed through candidate
  and native CJS loaders: four passing runs. Their dependency fixture is
  unchanged and archive-verified. These are the actual `cjs-module-wrap.js`
  and `cjs-module-wrapper.js` fixture assertions, not the outer parallel
  child-process harness files. Native engine/VM/filesystem boundaries remain
  explicit. Earlier pre-getter-fix runs are retained separately.

No package/engine/native-helper compilation, guest runtime comparison,
overall suite or full product rebuild ran. Source119, hard-link source118
and the empty-input source117 correction remain guest-uncompiled. Accepted
engine116 is not current; its four cipher failures, diagnostic failures and
historic SQLite/Error/compression nonpasses remain unresolved.

## Remaining obligations

Compile the new script operation and verify real source-private/dynamic-import
routing, filenames/line/column/error/realm behavior, module cache/parent cleanup,
GC/OOM/interruption and arbitrary wrapper return/fatal-admission contracts on
identified artifacts across all four hosts. Reconcile complete descriptors,
static property order, inherited surfaces and public overrides; the selected
comparisons are not an individual-API closure claim.

Full source-map capture/cache/stack integration, compile cache, hooks/preloads,
TypeScript and native ESM graph/namespace/cycle/async ownership remain separate
loading prerequisites. The new source does not implement them. Continue
independent audited families before overall validation, then reconcile the
whole public inventory with unchanged upstream assertions and exact native
controls. No unresolved gap is declared an accepted engine/platform boundary.
