# Native SpiderMonkey source bridge for Node

The current VM/helper candidate consumes actual property error-mode and
presence metadata from the engine. Getter callbacks retain the upstream
nonthrowing mode; mutation callbacks preserve explicit operation modes or
infer the nearest real script language mode. The unnecessary private-field
unwrapping change is removed; original wrapper forwarding remains in use.

`--expose-gc` now installs a real synchronous no-argument full `gc()` in each
new context. It uses existing memory/GC observers, forced-collection flags
and native retirement. Option-bag, asynchronous and snapshot GC extension
variants remain implementation work and fail explicitly; they are not
advertised by the option help. These changes pass whole-bridge syntax checks;
normal-build and callback/worker/lifetime runtime qualification are pending.

Empty handle escapes now preserve the pinned V8 contract: return the empty
handle without allocating or consuming the escape slot. Node HTTPParser uses
this on EOF and when a callback throws. The former bridge aborted instead of
preserving the pending JavaScript exception. A native-matched HTTP callback
regression reproduces that abort; the new normal build and integrated npm
qualification are pending. Nonempty rooting and single-escape checks remain.

An unset value field now reads as its actual initial undefined value, matching
V8 initialization and the original StreamBase.onread accessor. Storage bounds,
nonempty record branding, typed value factories and pointer tags stay checked.
The state stays lazy in the existing backing array; no extra owner, record or
collector is introduced. This fixes a reproduced new-pipe getter failure found
during npm installation. Integrated install and lifetime qualification remain
required before reporting the changed candidate as passing.

The scanner's missing-private-name diagnostic has an explicit unrelated-syntax
classification, matching the pinned native scanner for an invalid # token.
Valid native function-body hashbangs are handled by core producer patch0020;
no npm source filtering or broad syntax-error fallback is used. The observed
npm failure and changed compiler path still need integrated execution.

This library compiles the ordinary V8-shaped source interfaces over the actual
SpiderMonkey 153.7 engine. It uses the engine provider's exact private headers,
generated configuration and archive identities. The compile path excludes the
preserved shell frontend, substitute Node owners and private binding probes.
Original Node registration, startup, loaders and module algorithms are not
compiled or replaced by this library.

Both normal profiles compile native compiler diagnostic IDs, token facts and
canonical words/names on the existing private Message record. The classifier
uses those facts rather than human-readable errors. Node's original Contextify
owner retains wrapper-name matching and its real conditional module compilation.
Unclassified diagnostics remain explicit integration failures, with no guessed
no-retry fallback. Complete mapping and report-copy/lifetime qualification remain
unfinished. The next unbuilt batch handles the reproduced string-scanner case
and the engine's distinct plain/escaped identifier facts.

That batch also fixes persistent equality after SetWeak: comparisons read the
actual live weak edge instead of the reset strong Cell, without strengthening
the persistent. Empty, strong, weak and Context comparisons retain their own
semantics. The prior complete executable fails synthetic-module evaluation
because Node's original module lookup uses this comparison. The fix still needs
a normal rebuild and runtime qualification; no original loader policy changes.

The library is an integration dependency, not the complete Node engine SDK. It
exports neither v8.pc nor node-engine-sdk.json, and cannot satisfy the Node SDK
preflight on its own. Native engine cold entry, original Node ownership, all
consumed API definitions and lifetime/GC qualification remain required. A passing
build does not establish Node startup or module support. Normal resolver builds
and their complete compiler diagnostics are retained separately from runtime
acceptance; there is no compatibility frontend fallback.

The source interface header, native object files and provenance metadata are
installed under the declared output prefix. Required memory/deleter accounting
remains compiled; only the old frontend's extra allocation observer is excluded.
The private false-mode external-memory observer is not a Node API and explicitly
rejects use in this build. General native memory-pressure integration remains
part of the unfinished runtime foundation.

Standard public include names such as `v8.h`, `v8-context.h` and the consumed
cppgc headers forward to those same SpiderMonkey-backed declarations. They do
not include V8's heap-layout implementations or supply success stubs. Missing
interfaces remain compiler errors. Portable platform/configuration headers come
from the declared tracing provider. These headers allow the complete original
Node source inventory to expose missing interfaces together during development;
they do not make the incomplete bridge a complete SDK or a working runtime.
The complete original `v8-inspector.h` and `libplatform/libplatform.h` provide
their portable source declarations. Node's utility headers need Inspector's
string-view type even with Inspector disabled; keeping this header does not
implement or enable an Inspector backend.

Function compilation uses SpiderMonkey's original FunctionCompiler and its
standalone frontend, including real current-context environment extensions.
The optional engine stencil output retains compiled data with the script's
traced source metadata. Full-length parameter strings enter the engine parser;
the adapter preserves the original native parameter admission and extension
precedence. Function origins read that metadata and real source comments.
Cache generation uses SpiderMonkey's XDR serializer. A resident build-ID callback
binds it to the verified engine and native source inputs. Native cache headers
retain source/parameter fingerprints and validate version, flags, lengths and
checksum without alignment assumptions. Consumption decodes independently owned
stencils, reapplies current source metadata and instantiates compiled data.
Invalid caches take fresh compilation; exception/stop failures are preserved.
Full-precision saturated columns, signed/NUL origins, function-body coordinates
and runtime cache/lifetime qualification remain incomplete. These library paths
do not establish complete caching or Node startup.

Native inspection reads proxy targets/handlers and collection entries from real
SpiderMonkey state without invoking user traps or iterator methods. Previewing a
nonempty iterator preserves its cursor; previewing an exhausted iterator retains
the original exhausted state. Stack frame script names use retained engine source
metadata, while sourceURL-aware names use the engine's displayed source. The
locale getter reflects the engine locale. Matching private native-reference and
four-host tests establish these consumed interfaces only; Inspector, complete
heap/profiling services, Node owners and CLI acceptance remain unfinished.

The code-memory adapter measures SpiderMonkey executable/JIT metadata, bytecode
and script metadata, retained source storage, and profiler-owned tables/labels.
The core reporter counts allocation sizes and does not double-count the retained
source payloads as profiler metadata. Heap census totals include notable source
entries that the fine-grained reporter moves out of its ordinary source bucket.
Physical and current malloc sizes use actual committed/reportable allocations;
full heap/space/lifetime-peak accounting remains incomplete. These services do
not establish a working Node executable or CLI acceptance.

The next unbuilt native link batch connects stalled top-level-await diagnostics
to SpiderMonkey's live module dependency graph and suspended generator resume
metadata. It preserves the upstream leaf selection and evaluation-import order,
uses actual await bytecode positions and retained script text, and supplies the
message to Node's original warning/exit policy. It does not scan source text to
guess whether an await exists. The implementation and its diagnostic range are
not yet built or runtime-qualified.

The next link batch also adds a native CPU sampler for Node's original
Environment profiler owner. One helper thread requests samples through the
existing native interrupt queue; it never reads JavaScript cells. The owning
JavaScript thread reads real interpreter frames, function names, script IDs,
source notes and realm identity. Name/global roots survive conversion and
native notification reentry. Missed intervals and native-only observations do
not become invented JavaScript samples. Original upstream tree aggregation and
JSON/chunk serialization consume that metadata.

Stopping sampling cancels and joins the producer. Accepted queue packets retain
their delivery record, and late deliveries see a retired owner. Final engine
shutdown retires these producers before draining or closing native delivery.
This is source work only: thread/GC/stop/error/shutdown behavior and profile
output have not been run. The heap backend, native-frame/trace-chunk coverage
and integrated profiling acceptance remain outstanding. Profiler metadata still
truthfully reports an incomplete backend; this adds no completion claim.

The heap-profiler owner and object-query path are also source work in this
batch. The Isolate owns the native profiler; original Node graph callbacks are
registered and removed through their unchanged portable upstream bodies.
Object queries perform real full GC and retain the resulting objects in a
rooted inventory before calling the original Node predicate. The heap visitor
performs a read barrier before retaining each object and supplies the engine's
required zone/realm/arena callbacks. Transport aliases are omitted; user proxies
remain distinct objects. Per-object handle scopes bound temporary native roots.
Final retirement clears the profiler under the existing no-JavaScript gate and
preserves an incoming error or stop. The next batch also supplies native heap
snapshots and allocation sampling. Snapshots walk the actual SpiderMonkey ubi
heap, retain the complete portable upstream embedder graph and JSON serializer,
and freeze their native allocation data. GC object IDs use weak edges updated
by the collector; they add no roots that keep the entire heap alive. Numeric
fields read native slots without getters or user JavaScript.

The producer allocation observer reports all five mutator GC-cell allocation
routes. Its callback records address/kind/size and existing interpreter frames;
it never dereferences the new cell before its caller has initialized it. A
nursery weak observer follows the strong fixed point before forwarding data is
cleared, and the existing major weak callback handles older cells. Upstream
Poisson interval selection and sample scaling are retained. Callback ownership
stays with the Isolate, with explicit removal before native owner destruction.
Stopped tracking retains nursery weak delivery while previously recorded IDs
still exist. These new sources have not compiled or run. GC stress, weak-map
and other graph-edge coverage, profile output and integrated acceptance remain
required; no heap-profile runtime or module-acceptance result is claimed.

Node's optional shared-value conveyor uses the original move, assignment and
destruction bodies from the whole guarded upstream API source. Its private V8
experimental shared-GC-heap payload is nonconstructible here, as SpiderMonkey
values cannot be transferred across runtimes as raw pointers. This does not
replace the separate real SharedArrayBuffer backing-store transport.

Startup error handlers now connect Node's original native listener and stack
formatter callbacks to SpiderMonkey. Uncaught capture uses actual saved throw
stacks across existing and newly created realms, with the requested frame limit.
Each realm owns its traced stack state; the original Node Realm still owns its
JavaScript formatter. Native callback records retire with their Isolate. These
changes have compiled as a dependency; their integrated error/cleanup behavior
has not yet been accepted.

The engine option adapter connects source-phase parsing, flag mutability,
uncaught-abort policy and the external-memory reasonableness check to real
backend state. Node's ordinary startup request to enable import attributes maps
to ESR153's unconditional standard grammar. Its snapshot-table rehash setting
has no restored tables to operate on in the approved fresh-heap startup; actual
startup snapshot creation/restoration remains explicitly rejected. Unknown
command-line engine options remain unconsumed for Node's
original option errors; the string API reports unsupported options. It does
not claim that all V8 engine flags have SpiderMonkey implementations.

Node creates its IsolateData symbols before entering an application Context.
The symbol adapter enters the existing traced private template realm when no
realm is active, because ESR153 unique symbols allocate zone-local wrappers.
It retains the caller's realm when present and restores it on return. The
private realm keeps its existing Isolate lifetime; Node's construction order
and current application Context are unchanged. Integrated startup and GC
qualification of this adaptation remain required.

An empty Eternal reads back as an empty Local, matching upstream's null-slot
conversion and Node's lazy template checks. Nonempty roots still require their
actual Isolate owner; the roots retain the existing engine-owned lifetime.

The same allocation-realm rule covers ordinary/external string constructors,
concatenation and contextless signed/unsigned BigInt construction. Concatenation
wraps borrowed input strings into that realm; no application Context is created
and HandleScope still owns roots without entering one. These changes address
the reproduced string allocation failure during original per-isolate contextify
template registration. The installed development run has passed that allocation
point; successful startup and cleanup remain unverified.

Weak persistent handles accept object-backed native Data such as Contexts,
preserving their distinct public type and typed wrapper factory. The actual
collector edge must still be an object. This lets Node's original context
tracking use weak handles without misclassifying Contexts as JavaScript Values.
Nursery promotion, weak-edge updates, owner checks and callback retirement keep
their existing rules. This correction still requires integrated startup and
cleanup validation.

Ordinary native templates now connect their stored named/indexed callbacks to
the engine's existing native-property vtable. Node's original process.env
callbacks keep environment policy. Traced constructor records retain callback
data; per-call roots retain the holder, receiver and returned values. Configured
instances use the same native wrapper layout and GC methods with property and
enumeration hooks. Other templates retain ordinary engine integrity behavior.
This follows the reproduced null-Environment startup failure after bootstrap.
Both complete build profiles compile and link this dispatch. Installed startup
now passes the previous null-Environment assertion, but has not reached user
JavaScript or qualified cleanup.
Global/name/declaration interception and exact write-error-mode transport remain
unfinished; their existing explicit boundaries are retained. No general
interceptor or vm-conformance claim follows from this ordinary-instance code.

Property-query callbacks accept exact int32 numeric results with either
SpiderMonkey number tag. Node's original environment callback returns its
attributes through the generic numeric return API, which can store a double.
The adapter validates the numeric value without coercion or JavaScript reentry;
invalid numbers remain fatal and the absent-property sentinel is preserved.
The correction still needs normal-build and installed-runtime qualification.

The primitive constants `true`, `false`, `null`, `undefined` and the empty string
use engine-owned root storage, matching V8's Isolate root slots. They survive
nested HandleScopes without allocating local handles, including reads within
sealed scopes. These values retain no application objects; the empty string is
SpiderMonkey's existing runtime string. Final engine retirement releases their
cells before destroying the SpiderMonkey context. This addresses the
reproduced bootstrap return of `v8::True` after its ordinary HandleScope closes.
The ownership assertion remains intact. Installed execution passes that
bootstrap return and reaches original Node's execution entry; successful
startup and native cleanup remain unverified.

The continuation-data setter treats an empty handle as clearing the value to
`undefined`, as V8 explicitly specifies. Original Node callback scopes use this
case for their default async context. Nonempty inputs still use the checked
value path; the shared input helper continues to reject empty handles. This
correction passes installed ordinary startup, computed output, Promise/timer
execution and natural exit that renews work. Full async-context conformance and
native lifetime qualification remain required.

Uncaught errors returning from the outermost native API are delivered to Node's
original message listeners with a clean exception state, following V8's API
return/reporting contract. Existing TryCatch handling, active JavaScript callers,
cleanup restrictions, preexisting errors and termination retain their separate
paths. This addresses the reproduced stale uncaught exception that later broke
`beforeExit` string creation. Installed uncaught, caught and handled-error
development checks pass; exact formal diagnostic presentation and broader
exception qualification remain unaccepted. Error output and exit policy remain
in original Node sources.

Failed script, module and function parses retain their actual submitted source
origin in an engine-owned WeakMap keyed by the real SyntaxError. The map lives
in the existing private template realm, and its ephemeron entries release the
error and application data together. Message construction can use supplied
filenames, source-map values, offsets and flags even though no compiled script
exists. Final engine retirement clears the map before context destruction.
Installed development execution clears the default-TypeScript origin fatal
and reaches the original Amaro loader. The native backend binding remains
unfinished. Caught compiler errors can be decorated and followed by ordinary
error handling and natural exit; exact diagnostics remain unaccepted.

Unbound-script parsing uses the caller's current realm and its actual Error
constructors/stack hooks, with the existing private fallback for contextless
calls. Successful realm-neutral stencil records still use private storage.
This addresses the reproduced wrong SyntaxError prototype and missing Node
stack formatting; its integrated validation remains required.

Heap-space data uses the existing runtime census for cells, evacuated nursery
capacity, managed malloc and executable code. Native wrapper heap data sums
actual retained allocations using the whole upstream cppgc statistics value
type, without inventing cppgc pages or free lists. Complete allocation peaks,+cumulative counts, context/global-handle accounting and coherent limits remain
unfinished. Guest native allocation sizes are not outer-host RSS measurements.

Context tokens retain the shared identity supplied by original Node in traced
realm storage. This does not qualify arbitrary V8 embedder security domains.
Interceptor error-mode reads require actual callback metadata and fail if it is
missing; the complete interceptor dispatcher remains required. ShadowRealm's
native callback registration is retained, while constructor integration remains
unfinished. Approved startup-snapshot and general-Wasm operations reject use
explicitly; these interfaces never manufacture a module, memory or transfer.

The file-loading qualification fixes transport import attributes from the
engine's internal flat array, preserving key/value pairs for dynamic import
and actual parser source-offset triples for static module requests. The CJS
classifier explicitly maps a missing variable name to Node's conditional
module-parse branch. These changes retain upstream loaders and JavaScript;
build success alone does not establish file-loading acceptance.

Local and persistent value identity wrap both operands into the same engine
realm before comparison. This follows the existing Value comparison path and
handles ESR153 cross-zone unique-symbol wrappers. Context handles retain their
distinct native identity. Installed import.meta and native symbol/collection
controls must qualify this path; source inspection alone is not acceptance.

Native CompileFunction stacks and reports expose body source coordinates while retaining SpiderMonkey’s actual signature/newline. Errors without a source line use the original V8 API’s empty-string result. During no-JavaScript cleanup, pending errors are captured at return instead of being consumed before a denied call. These changes are under integrated qualification.
