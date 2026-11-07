# VM script dynamic-import callback ownership prerequisite

This source adds a real script/compiled-function import owner below the pinned
public VM algorithms. It does not activate REPL or establish full VM/module
compatibility. Target remains Node26.13.0/source18b32a3b1552e199a01f1a8d9fd64aa756d3b75b.

The native VMCompiledCode object owns the actual realm-independent Stencil and
callback registry. Each real instantiated JSScript retains that owner through
JS::SetScriptPrivate; ScriptSource traces that value and shares it with nested
functions from that source. Compiled functions receive the same association on
their own actual function script. This is not a token/global-eval/require map.
One compiled Script can execute in several target realms without replacing
another source's callback or referrer. The actual public Script or compiled
function is retained as callbackReferrer only when a callback will consume it.

The actual importing realm creates the import Promise and ModuleRequest. A
script-private lane dispatches before the existing VM ModuleWrap and general
loader209 lanes, which remain unchanged. The original request and its actual
complete attribute record are retained, with no type-only reconstruction or
unsupported-key filtering. The existing complete pinned async wrapper owns
namespace-or-Module validation, phase names, thrown/rejected identity and
namespace-then assimilation. There is one lazy VM-module frontend shared by
public SourceTextModule/SyntheticModule and script wrappers, not a second class
brand/module graph/cache. A native VMImport transaction roots the actual
promise, compiled-code owner and original ModuleRequest through settlement.
Both native reactions share it; clearing its reusable slots before genuine
settlement and keeping locals rooted prevents duplicate admission and retains
the original graph through settlement reentry. No arbitrary native pointers
or fabricated async resource/provider records are used.

Ordinary compilation accepts a valid custom callback even without the
experimental flag. The unchanged getHostDefinedOptionId algorithm controls
whether actual import later rejects with ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING
or ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG. Internal makeContextifyScript
callers such as REPL can supply their actual explicit option id, which must not
be replaced by another flag check. The full unchanged helper is source-pinned
and published only through the shared private VM owner; the public namespace
gets no extra helper exports. Actual target-context access is checked before
execution; new owner-wrapping failures pass through the existing caller-realm
exception marshalling path.

Concrete gaps remain. USE_MAIN_CONTEXT_DEFAULT_LOADER/internal default-loader
symbols compile ordinary code, but actual imports raise the existing explicit
unsupported error until referrer/default warning/general-loader policy is
implemented. Context-scope eval/default import callbacks remain unsupported;
new Function/eval/default-context inheritance and import source/defer phases
need their own engine/owner reconciliation. Public context exotic properties,
negative offsets/cache data, per-context microtask queues, SIGINT, measurement,
existing VM ModuleWrap attribute/lifecycle gaps and full VM conformance remain
open. An installed callback is not proof of those APIs or engine support.

Evidence is scoped. Fifteen named final differential groups (11 flag-enabled,
four no-flag) pass over actual pinned native Node compiled-code, module, realm,
registry and Promise dependencies, including strict callback this/referrer,
attributes, original throw/reject, nested escaped functions across two contexts
with WeakRef/GC, shared public Module brand, real TLA and namespace-then values.
Three unchanged upstream files pass both the native reference and the candidate
JS frontend fixture. Initial candidate upstream runs failed the unchanged
common global-pollution assertion because internal/test/binding installed two
fixture globals. All three exit1 logs remain; fixture cleanup now restores only
those exact preexisting descriptors, without changing assertions/allowlists.

Normal private bundle/bootstrap/native generation, syntax, unchanged Mozilla
style and885-file conservative input checks pass. A source review caught and
re-staged the modified private hook header before final style verification.
No new C++ compilation, engine/kernel/library/product/full build, overall suite
or identified guest artifact execution ran. Actual ScriptPrivate tracing,
Stencil instantiation, promise-realm/CCW/security/OOM/fatal/Worker lifetime and
four-host behavior remain uncompiled/unvalidated. The native fixture is never
installed as Kandelo's production backend. No audited finding is closed here.
