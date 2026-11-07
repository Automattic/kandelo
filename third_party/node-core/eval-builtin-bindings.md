# Eval builtin bindings and shared Module helpers

The existing actual --eval source owner (cliOptions.evalSource captured
by _nodeParsedEvalSource) now consumes complete unchanged pinned
addBuiltinLibsToObject after global-scope initialization. The compatibility
bootstrap is inside the actual adapter IIFE, so private fs/path declarations do
not shadow user eval globals: bindings are installed on the actual global owner.
No shell/standalone REPL selection or fake eval flag is added. Workers do not
borrow main-thread eval state. Empty actual eval source remains enabled.

The helper creates the actual dummy Module and uses its genuine require/cache
owner. It skips existing own, underscored and slash-containing names; it installs
lazy nonenumerable getter/setter bindings. First successful access retains the
real export, failed access leaves retryable loader ownership, nonconfigurable
properties still return real modules, and assignment restores the target's
ordinary enumerable writable data property semantics. Actual inherited setter
behavior follows the captured scope, exactly as pinned source. The existing
makeRequireFunction is shared privately instead of copied into a second loader.
No new module identity/cache or native metadata is fabricated.

Fourteen focused groups match native plus four actual production eval-guard
cases (absent/empty/nonempty/main-vs-worker) with explicit native VM/fs/package/URL/builtin
boundaries. Unchanged test-repl-autolibs.js passes native and with only this
candidate helper selected in native REPL. That native REPL dependency is not
public guest REPL support. Baseline missing private seams and initial asymmetric
spy failures remain preserved. No new compiler, engine/product build, guest or
overall suite runs occur. Full CLI syntax/loader/namespace/realm/GC, missing
builtins, actual guest eval and four-host conformance remain open, along with
REPL's Inspector/capture/session/evaluator/CLI/history prerequisites.

The actual native CLI parser now records eval-option presence separately from
its raw source text, matching Node's has_eval_string option. The raw source
remains a string (including default empty), preserving existing util behavior.
A separate actual hasEvalSource boolean gates helper admission on the main
thread; absent eval and explicitly empty eval are distinct. --print and broader
CLI normalization/precedence remain separate gaps. The new C++path is uncompiled.

Native controls distinguish explicit separate -e '' (accepted) from --eval=
(rejected with status9). Current Kandelo's existing parser still accepts inline
empty --eval=; that L-031 admission/exit gap remains open, not a passing case.
