# Documentation, deprecation and applicability contracts

Source review: **complete with gaps** for the documentation family's 220
original obligations. These are normative and applicability observations,
not an extra module or a count of passing APIs. Implementation and current
four-host runtime conformance remain separate and incomplete. No new
runtime tests, probes, compilations or builds ran.

The exact Node 26.13.0 source/reference pin is unchanged. The requirements
ledger preserves six documentation sections, three synopsis sections, one
index section and 210 deprecation sections. The latter include three
introduction/navigation sections and **207 individual identifiers**. Each
entry retains its exact title, declared current type, complete prose,
source range/hash, literal source occurrences, related inventory owners
and unresolved questions. Literal occurrence is a source location aid,
not proof of reachability, active installation, warning emission or removal.

## Governing requirements and owners

`documentation.md:16–70` defines stability 0 deprecated, 1 experimental
(including stages 1.0/1.1/1.2), 2 stable and 3 legacy. Legacy and deprecated
APIs still present in this exact target remain requirements. Experimental
interfaces require their exact flags and runtime semantics; a stability
label is not a justification for skipping them. Historical YAML changes
are retained separately from the current Type/prose and exact target
source. No target pin or public surface may be changed to accommodate a
remembered older release.

`documentation.md:1,11,72,78`, `index.md:1` and the installer/editor prose
in `synopsis.md` include project explanation, contribution links,
generated stability navigation and documentation JSON format. They do
not require a guest runtime module called documentation, a documentation
JSON-producing builtin, V8 identity or a bundled editor. Their links route
to the actual API owners. Documentation-only disposition is not a runtime
pass or an exclusion of the linked public APIs.

`synopsis.md:7` requires the documented Node entry/argument semantics:
options, script/eval/stdin and following arguments. Loading/CLI findings
L-014/031/032 and process ownership apply; a shell option with a similar
spelling is not enough. The HTTP example at line 13 requires actual
CommonJS loading, createServer request/response state, header/body writes,
loopback bind/listen/accept, callback/event ordering and event-loop
liveness. Network and HTTP reports identify missing server prerequisites.
The printed listening message cannot establish that contract. No example
was run under this audit-only goal.

`documentation.md:87` routes syscall requirements to the actual guest OS,
libc/native binding, kernel and configured host adapter. Kandelo/wasm32
identity stays truthful. Windows-only HANDLE behavior and V8-specific
artifact formats require concrete per-API applicability; a different
engine does not exclude all portable APIs. Node/Chromium/Firefox/WebKit
share the guest warning/API owners and differ at actual configured host
I/O/worker/backend routes, as recorded in the family reports.

## Deprecation policy is behavioral

`deprecations.md:1–45` defines documentation-only, application, runtime and
end-of-life policy. Current ledger types are 125 End-of-Life, 38 plain
Documentation-only, 10 Documentation-only with pending-deprecation support,
24 Runtime, 3 Application, 6 revoked (two spellings) and 1 Compile-time.
These labels alone do not decide whether an API is absent or callable:
end-of-life includes removed overloads, rejected argument types and old
implementation features. Source and complete normative prose decide the
specific requirement; a future-removal statement does not authorize an
early removal. Revoked entries must not acquire a warning just because
an old history record mentions deprecation.

The shared target deprecator (`lib/internal/util.js:106–217`) has real
per-wrapper/per-code once state, lazy validation, receiver/constructor
forwarding, wrapper prototype/length preservation and optional synchronous
warning emission. The candidate's selected `core-value-helpers.js:9–35,
150–194` retains this behavior for supported callers; bootstrap:2817
replaces its earlier simplistic util.deprecate definition with that owner.
It is incorrect to report the earlier local definition as final behavior.

Target process warning emission (`internal/process/warning.js:138–189`)
normalizes overloads, creates warning/code/detail/stack, handles
noDeprecation and delayed throwDeprecation, then queues the warning event.
Candidate bootstrap:1538–1565 has real analogous overload/validation,
nextTick dispatch and delayed throwing. Its default listener at 1624–1629
uses actual stderr and honors noWarnings and the environment getter;
trace-deprecation formatting depends on process.traceDeprecation. This
source does not establish full CLI/environment initialization, default
warning formatting or every native stack/async/fatal policy.

Application deprecations require actual origin/callsite handling, not a
string test of the npm package being installed. Target Buffer DEP0005
checks pending policy and caller context (`lib/buffer.js:220–242`),
punycode DEP0040 checks native isInsideNodeModules (`lib/punycode.js:1–13`),
and url.parse DEP0169 warns through its own source path (`lib/url.js:133–146`).
Candidate Buffer is a Uint8Array subclass without that constructor warning
(bootstrap:1159), punycode exports identity placeholders and URL legacy
parse is custom (3288 onward), without those corresponding callsite gates.
The copied full buffer-source.js contains DEP0005, but the candidate selects
numeric/inspection/allocation excerpts and its own public Buffer owner;
that stored file is not proof the warning is installed. Similarly the
stored fs-fs-source.js DEP0187 entry is not the final custom existsSync
function at bootstrap:2067–2070.

## Concrete findings and target questions

| ID | Requirement and source result | Owner/dependency |
|---|---|---|
| DOC-001–006 | Governing stability, policy, narrative/CLI/syscall, inventory and version rules retained from documentation.md. Every original obligation is reconciled; source-audit completion does not mean implementation completion. | Exact pins; all family source owners and final coverage reconciliation |
| DOC-007 | Candidate util exposes isBoolean/isNull/isNullOrUndefined/isNumber/isString/isUndefined/isObject/isFunction/isRegExp directly (bootstrap:2768–2776), despite exact-target removal entries DEP0045/0049/0050/0051/0052/0053/0055/0056/0058 and their absence from target lib/util.js exports. util.isArray remains a required target API with runtime DEP0044, but candidate points directly to Array.isArray without that wrapper. util.debug is a current debuglog alias and must not be mistaken for the removed historic printing operation merely because the same spelling appears in DEP0028. | Values public surface and real warning/origin/error/descriptor semantics |
| DOC-008 | CLI initialization for pending/no/throw/trace deprecation and native callsite origin is incomplete. Candidate native boolean parser implements warnings/experimental-stream-iter and rejects unsupported NODE_OPTIONS explicitly (patch0043:139–173), rather than providing the remaining Node options. Programmatic process property checks do not prove their CLI initialization. | Loading/process/environment/native stack and error/async owners |
| DOC-009 | Real selected deprecator callers include util.promisify DEP0174, public fs.Stats DEP0180, zlib without-new DEP0184, Duplex.toWeb deprecated type alias DEP0201 and synchronous child shell args DEP0190. These are not blanket missing warnings. Async child normalization and each target origin/once/argument/control branch still need their owning implementation and later controls. Optional synchronous emitter dependency internal/process/warning is not supplied by the values adapter; actual activating caller must be identified before claiming an observed failure. | Values/FS/stream/compression/process adapters, scheduler, warning/error/ref ownership |
| DOC-010 | Environment correction: process.env's getter (bootstrap:1402–1413) queries std.getenv for unseeded keys. Adapter std.getenv forwards shellOs.getenv (adapter.js:269–272). Thus a limited seed list does not prove NODE_NO_WARNINGS unreadable. Own-key enumeration still starts from a subset, and adapter setenv/unsetenv are no-ops (274–284); deletion can expose an unchanged native value again. Native mutation/enumeration/child inheritance need independent process audit. Earlier L-032 wording has been corrected. | Guest environment ownership, native libc getenv/setenv/unsetenv, spawn env construction |
| DOC-011 | Exact-type versus prose/source questions remain explicit: DEP0116 says revoked while its prose calls the legacy URL API deprecated; DEP0169 independently requires application warnings. End-of-life DEP0094 has a copied one-message assert.fail signature, rather than a general requirement to revive its historical overload. DEP0132 target terminate ignores callback and returns real exit-settled Promise. DEP0137/0200 have distinct FileHandle/Dir GC policy, not one generic finalizer allowance. | Native exact-pin differential questions, warning and owner-specific lifecycle; not permission to change target |

DEP0033 listenerCount, DEP0037/0038 lchown, DEP0089 assert, DEP0116 legacy
URL and DEP0163 diagnostics subscriptions are revoked entries; their
current implementations/identity and changed requirements remain in scope.
DEP0210/0211 retain DatabaseSync/StatementSync as documentation-only aliases
of the renamed SQLite classes. DOC-002 does not authorize removing them.
DEP0080 path._makeLong remains the actual identical toNamespacedPath alias
in copied path.js:1705–1707. DEP0199 keeps the legacy _http_* module scope;
DEP0192 has a different runtime warning requirement for _tls_* modules.
A documentation-only status must not invent a runtime warning for either
plain aliases or inherited fields.

## Durable mapping, evidence and subsequent validation

The per-entry ledger records all current normative prose including text
beginning with Markdown links; an earlier exploratory excerpt stopped at
some link-leading paragraphs and was not used as an authoritative requirement.
The final raw range hashes and complete prose avoid that discovery loss.
Owning module/family routes, existing API observation links and native/
candidate literal occurrences are navigation aids. Candidate occurrences
are explicitly not proof of selected exposure; the real central warning,
constructor/alias/overload/removal and native policy paths above and in
owning reports supply the source conclusion. API implementation gaps in
still-incomplete values/filesystem/processes remain open cross-family work.
They cannot be converted into passing documentation results.

Historical reports are scoped to their exact archived source/artifact and
host identities; no current candidate or deprecation conformance is
established. All pass/fail/skip/unsupported/timeout/harness-error/pending
statuses are preserved. A warning source string is not a runtime control.
The future catalog uses unchanged exact-pin sources across categories,
including helpers/native fixtures, not an executed test denominator.

After separate explicit authorization, use exact native 26.13.0 controls
and identified four-host artifacts for application versus node_modules
callers, once-per-code and once-per-wrapper behavior, suppressed/pending/
throw/trace/redirect warnings, CLI versus environment precedence, valid and
invalid deprecated arguments, callable/new forwarding, property access and
aliases, revoked entries and target-absent exports. Test process environment
enumeration/deletion/native reads/child inheritance separately. Compile-time
Node-API deprecations need an actual supported native ABI/toolchain and
cannot be called passing from guest JavaScript. Examples require their real
network/process/filesystem owners and fixtures. None are authorized now.

Open audit questions: exact target warning text/stack/origin and sync-versus-
async branches; DEP0116 scope reconciliation; actual selected caller closure
for optional synchronous warning emission; concrete removed/private API
applicability when aliases or argument forms survive; GC/lifetime and
native environment ownership across families; fixture/flag/native ABI
applicability; and all current four-host runtime conformance. No question
requires changing the target or blocks the remaining broad source audit.
