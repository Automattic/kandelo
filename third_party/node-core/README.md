# Pinned Node core algorithms

Source123 adds actual EC/OKP/PQC raw-key imports, exact algorithm spelling,
point/scalar/seed validation, public-role projection and pinned provider
encoding initialization. Four new frontend comparisons and23 affected controls
pass, alongside92 portable byte/error comparisons,18 affected material-owner
comparisons and two runs of one unchanged upstream file. The614-input source
guard and12 package checks pass. These are separate evidence scopes, not API
closure. Guest source117–123 is uncompiled; accepted116 is not current. All19
families remain partial; overall suites/full product rebuild remain deferred.
See [raw key ownership and evidence](../../tests/nodejs/outline/raw-key-implementation-dependencies.md).

Source122 adds pinned logical/native realpath, readlink and full glob traversal
using real POSIX byte results/queued requests and shared Dirent/stat owners.
The private URL-or-path converter now serves filesystem consumers. Sixteen new
and37 affected controls,16 portable byte/error comparisons and eight unchanged-
file runs pass in their explicit native-boundary scopes. Guest source117–122
is uncompiled; accepted116 is not current. All19 families remain partial;
overall suites/full product rebuild remain deferred. See
[path/traversal ownership](../../tests/nodejs/outline/filesystem-traversal-implementation-dependencies.md).


Source121 installs the pinned shared warning owner and actual CLI option
source for filtering, trace/deprecation policy and redirect-file lifecycle.
Sixteen new frontend and47 affected controls pass; one known environment-clone
fixture nonpass remains. Four unchanged-file runs and14 portable parser
comparisons pass in their explicit native-boundary scopes. Guest source117–121
is uncompiled; accepted116 is not current. All19 families remain partial;
overall suites/full product rebuild remain deferred. See
[warning ownership and evidence](../../tests/nodejs/outline/warning-implementation-dependencies.md).


Source120 adds real borrowed-stdin terminal mode leases, pinned mode/error
policy, actual window queries and transport/context/GC cleanup. Five native-
boundary frontend comparisons, four affected stream controls and one portable
PTY/native comparison pass in their recorded scopes. The guest binding and
117–119 source remain uncompiled; accepted116 is not current. Public TTY classes,
signals/drain and four-host conformance remain open. All 19 families are partial;
overall suites/full product rebuild remain deferred. See
[terminal ownership and evidence](../../tests/nodejs/outline/terminal-mode-implementation-dependencies.md).

Earlier revision checkpoints below retain their historical scope.

Source revision119 adds pinned Module.wrap/wrapper owners and actual patched
script compilation, preserving the ordinary function compiler. The shared
invocation now snapshots exports once for receiver/argument identity. Eight
new and fourteen affected frontend controls pass; two unchanged upstream
fixtures pass in candidate/native modes. Guest compilation and four-host
conformance remain pending; accepted116 is not current for source117–119.
Earlier guest failures and all 19 incomplete families remain open. Overall
suites/full product rebuild remain deferred. See
[wrapper ownership and evidence](../../tests/nodejs/outline/module-wrapper-implementation-dependencies.md).

Earlier revision checkpoints below retain their historical scope.

Source revision 118 adds pinned hard-link sync/callback/promise APIs over
actual libc operations, owned queued source/destination paths and shared
destination-error completion. Twelve frontend controls and one portable-owner
comparison pass within explicit native dependency boundaries. The new C++ and
source117 empty-input fix remain guest-uncompiled; accepted engine116 is not
current. Its earlier cipher failures remain open, with a bounded native-tag
investigation recorded separately. All 19 families remain incomplete; overall
suites and a full product rebuild remain deferred. See
[hard-link ownership and evidence](../../tests/nodejs/outline/hardlink-implementation-dependencies.md).

Earlier revision checkpoints below retain their historical scope.

Source revision 117 supplies pinned Cipheriv/Decipheriv algorithms over actual
native ncrypto/OpenSSL contexts and fixes the empty-data versus null-control
boundary. The accepted targeted engine 116 compiles the preceding source and
passes artifact admission. Five Node-host guest comparisons record one pass
and four failures with escaping Wasm exceptions; these failures remain open.
The empty-input fix has portable-owner evidence but is guest-uncompiled.
All 19 families remain incomplete. Overall suites and a full product rebuild
remain deferred. See [cipher ownership, evidence and gaps](../../tests/nodejs/outline/cipher-implementation-dependencies.md).

Earlier revision checkpoints below retain their historical scope.

Revision 115 compiles real named broadcast groups and owned shared engine
message storage, including revision 114 temporary-directory owners. Normal
artifact admission succeeds; four same-source exact-native/Node-host guest
controls pass, including a real worker exchange and temporary-dir disposal.
Four-host and whole-family conformance remain unestablished; all 19 families
are incomplete and overall suites/full product rebuild remain deferred. See
[broadcast ownership and scoped evidence](../../tests/nodejs/outline/broadcast-implementation-dependencies.md).


Earlier source revision 114 adds pinned temporary-directory and disposal APIs over
real libc creation, native FS requests and existing removal owners. Seven
new frontend controls, twelve affected controls, nine portable native-owner
scenarios and four unchanged upstream files pass within their documented
control boundaries. The changed guest source is uncompiled; accepted engine
113 is not current for this candidate. All 19 families remain incomplete,
and overall suites/full product rebuild remain deferred. See
[temporary-directory ownership and evidence](../../tests/nodejs/outline/tempdir-implementation-dependencies.md).


Earlier source113 supplies real SQLite scalar and aggregate/window registrations,
traced callback/accumulator ownership and parent-handle retention. The targeted
engine compiles and passes normal artifact admission. Nine focused comparisons
record3pass/6fail: return conversions, groups and windows match; other cases
retain integration failures and one failing native-reference expectation.
No whole SQLite, overall-suite or four-host conformance follows. See
[SQLite callback owners and remaining work](../../tests/nodejs/outline/sqlite-callback-implementation-dependencies.md).


Earlier source112 compiles the shared codec/work storage changes and the
earlier111URL/path bundle. Normal admission accepts the stamped artifact.
Seven focused Node-host comparisons record3pass/4fail; all public assertions
complete, and the four raw-byte mismatches are traced to gzip OS metadata
(native macOS19versus guest Unix-default3). Original failures are preserved.
Ordinary async resizable leases, complete lifecycle and four-host conformance
remain open. No overall suite or full product rebuild ran. See
[compression storage and evidence](../../tests/nodejs/outline/compression-storage-implementation-dependencies.md).

Earlier recipe-stage statements retain their historical scope.

Historical source111 adds pinned URL/file-path/HTTP-option conversion algorithms
over the actual shared parser, Buffer/path and error owners. Focused frontend
controls record15pass; unchanged upstream files record6pass/2macOS skips
across candidate/native modes. The changed guest bundle is uncompiled;
accepted engine110does not validate these bytes. See
[URL/path owners and limitations](../../tests/nodejs/outline/url-path-implementation-dependencies.md).

The last accepted artifact checkpoint follows.

Historical integration checkpoint: canonical targeted engine110 compiles the
shared Error location-extension policy. Seven of eight actual Node-host guest
controls pass, including the earlier assertion diagnostics and root/VM/clone/
native-error/worker location behavior. Full generic Error layout remains failed
at the own lazy stack accessor/prototype contract. The standalone shell's
extension-preservation control passes separately; it is not Node conformance.
The prior108/109and native environment-fixture nonpasses remain recorded.
All19families remain partial; overall suites/full product rebuild stay deferred.
See [Error construction and evidence](../../tests/nodejs/outline/error-location-implementation-dependencies.md),
[upstream assertion ownership](../../tests/nodejs/outline/assertion-error-implementation-dependencies.md)
and [kernel admission](../../tests/nodejs/outline/kernel-admission-integration.md).
Earlier recipe-stage statements below retain their historical scope.

Recipe95 selects pinned callback writeFile/appendFile algorithms over actual
queued native pathname/byte/fd work and FSREQCALLBACK scope. Native/source
controls pass; the new guest C++ binding is uncompiled. Sync/path-promise file
jobs, full backing-store leases and four-host conformance remain open. See
[Callback file-write ownership](../../tests/nodejs/outline/write-file-implementation-dependencies.md).

Recipe94 reuses the unchanged public SourceMap class for actual VLQ decoding,
indexed mappings, payload and position queries on the real Module namespace.
Focused native/source controls pass; loader capture/cache/support/stack
integration and four-host guest conformance remain open. See
[SourceMap ownership](../../tests/nodejs/outline/source-map-implementation-dependencies.md).

Recipe93 adds pinned Performance/user/resource/timerify classes and real shared
timeline/observer buffers over existing clock/clone/EventTarget owners. The
zero-statistics event-loop histogram facade is removed. Focused controls pass;
upstream adapted files record7pass/1fail at the missing milestone provider.
Native metrics/histograms, guest integration and four-host conformance remain
open. See [Performance timeline ownership](../../tests/nodejs/outline/performance-timeline-implementation-dependencies.md).

Recipe92 adds the unchanged pinned public Argon2 module over actual native
OpenSSL3.5.9 algorithm/configuration, shared KDF work and ARGON2REQUEST source
owners. Native derivation/errors, frontend and affected/upstream controls
pass. Guest compilation and four-host conformance remain outstanding; the
accepted engine is still88. See [Argon2 ownership](../../tests/nodejs/outline/argon2-implementation-dependencies.md).

Recipe91 adds pinned pathname metadata wrappers, actual POSIX sync/queued
source owners and shared filesystem error construction. Kernel/host source
now selects the link inode for nofollow timestamps. Focused native/source
controls pass; guest engine/kernel Wasm compilation and four-host conformance
remain unestablished. OPFS metadata mutation now fails ENOTSUP rather than
silently succeeding; persistent metadata remains an implementation gap. See
[path metadata source and evidence](../../tests/nodejs/outline/path-metadata-implementation-dependencies.md).

The source recipe89 adds the unchanged pinned process finalization
registry, lazy public accessor and Refable dispatch, with its inherited MIT
notice. It uses actual guest process events and engine weak references.
Six native-dependency controls and two unchanged upstream files pass; this
source slice is not in the last accepted engine88 and has no guest/four-host
validation. See [process lifetime ownership](../../tests/nodejs/outline/process-lifetime-implementation-dependencies.md).

The subsequent source recipe90 adds full pinned PBKDF2/scrypt public modules
over real native OpenSSL derivation and guest work/resource source owners.
The shared dependency source now selects officially verified OpenSSL3.5.9,
matching the audited native reference. Native/source evidence and retained
nonpasses are in [KDF ownership](../../tests/nodejs/outline/kdf-implementation-dependencies.md).
Neither recipe89 nor90 is contained in the accepted engine88. The new
guest dependency/binding and four-host conformance remain unvalidated.

The post-audit byte adapter selects 13 unchanged lib/buffer.js sections for
non-string conversion, copyBytesFrom/of, comparisons, concatenation/copy,
swaps and parent/offset descriptors. Its byte primitives operate on real
intrinsic-branded storage and avoid user species in private copy/compare
operations. String conversion uses the shared codec owner. The current source adds the
pinned callable constructor and shared aligned allocation pool over actual
non-detachable storage, plus native zero-fill option ownership. Guest runtime
validation, general worker marks, remaining backing-store/API/CLI/realm and
lifecycle requirements remain open. See the breadth-first ledger for
focused evidence and pending guest-host validation.

`upstream/` contains the unmodified Node 26.13.0 `assert` public module,
internal comparison algorithm, assertion message utilities, inspection
algorithm and primordial initializer. It also contains pinned Web event,
abort, Web IDL, DOM exception, fixed queue and abort listener modules.
Native-frame AsyncLocalStorage, RunScope and the AsyncResource excerpt
are also pinned inputs.
The Buffer inspection and public event helper excerpts are copied
unchanged; their full-file origin hashes are also recorded. `sources.json` binds these inputs to the exact API target in
`packages/registry/node-compat/target.json`. The bundler rejects a different
release/commit. The Node and original Narwhal licenses are preserved in
the generated bundle.

`adapter.js` supplies real intrinsic brands, enumerable non-index property
filtering, byte comparisons, captured primordial methods and the existing
compatibility inspection/formatting functions. Promise detection uses an
engine binding without calling `then`, observing properties or installing
rejection handlers. Native key brand probes use private engine slots; source100 adds real
KeyObject material owners. WebCrypto algorithm/creation routes remain
incomplete, and no synthetic key objects are introduced.

The public assertion and comparison algorithms are not rewritten by the
test runner. Strict aliases, error matchers, async assertions, loose and
strict comparison, partial comparison and Assert instances come from the
pinned sources. `util.isDeepStrictEqual` uses the same comparison module.

AssertionError and Myers diff now use pinned Node algorithms for diagnostics,
descriptors, details and inspection, sharing the real error/validator/color
owner and full primordial initializer. The custom class and six generic
validation-error replacements are removed. Source109 loads assertions after
the real FD stream owner because color initialization observes stderr.
The source110guest diagnostic case now passes after generic native construction
omits optional location extensions in Node mode. A separate complete generic
Error layout comparison remains failed at the own lazy stack/prototype contract.
Exact stack recapture/filtering and source-expression recovery also remain
implementation gaps. Generation guards preserve the actual superclass stack
when capture is unavailable and use the existing default assertion message;
the raw upstream files and all assertions remain unchanged. See the
[assertion dependency record](../../tests/nodejs/outline/assertion-error-implementation-dependencies.md).

## Inspection source pass: validation pending

The post-audit public util slice uses util-public-adapter.js and exact
manifest-selected functions from the pinned full lib/util.js source. Public
deprecate options are distinct from internal warning mode; retained deprecated
helpers share the real warning policy. Promise handling delegates through
the actual native operation after the shared brand check, and signal exit
conversion uses the actual supplied signal table. See the
[breadth-first ledger](../../tests/nodejs/outline/breadth-first-implementation.md)
for scoped evidence and outstanding four-host product validation. These
changes do not complete util or inspection compatibility.

`inspection-adapter.js` supplies the private dependencies of the unchanged
inspection algorithm. It uses the upstream primordial initializer and
shared intrinsic brands from `_createNodeCoreTypes`. The SpiderMonkey
adapter supplies actual promise state/results, scripted proxy details,
non-consuming iterator snapshots, weak collection entries and native
object-class checks through private engine hooks. This avoids replacing
engine metadata with user properties or promise reactions.

The shared bootstrap selects this implementation for `util.inspect`,
`format`, `formatWithOptions` and `stripVTControlCharacters`. Buffer's
custom inspection and mutable byte limit share the actual Buffer data.
The adapter uses the upstream Unicode terminal-width fallback until a
native ICU width binding is supplied; public `Intl` is unchanged.
Exact width parity, shared validation errors and engine-specific naming
and stack details remain review obligations.

These source changes and engine patch 39 have **not been compiled or
validated on any host** during the broad implementation pass. Existing
assertion evidence does not validate the changed dependency graph.
The [implementation ledger](../../tests/nodejs/outline/implementation-review.md)
retains required follow-up and the user's test/build deferral.

## Shared Buffer codec candidate

buffer-codecs-adapter.js supplies actual UTF-8, ASCII/Latin-1, UTF-16LE, hex,
base64 and base64url codecs over branded storage for pinned public Buffer
wrappers. fromString, byteLength/stringLength, alloc/fill/write/toString,
searches with exclusive ends, prototype helpers and isLatin1 share this owner.
The byte adapter uses it for string conversion. Public allocation/fill keep
their private allocation/byte owners independent of replaceable exports.

Focused native-reference JS controls and three unchanged upstream files pass
for the source slice. They do not validate the guest allocator or a built
artifact. Pool/transfer ownership, callable construction, allocation flags,
backing-store edges and remaining public exports are incomplete. In particular,
fromStringFast uses an explicitly unpooled path. The same source is selected
on Node, Chromium, Firefox and WebKit, but current four-host guest conformance
is unestablished. See the Buffer codec dependency record in tests/nodejs/outline.

## Event platform source pass: validation pending

`event-platform-adapter.js` links the pinned EventTarget and abort modules
to the actual process, scheduler and monotonic clock. `event-helpers-prelude.js`
supplies the private dependencies of the unchanged public helper excerpt.
EventEmitter helpers and Web event objects share the actual listener
metadata. Protected abort listeners and their disposable cleanup are used
by timer promises, TCP dialing/listening and Fetch. `util.aborted` uses the
upstream weak-retainer algorithm.

The source installs Event, EventTarget, CustomEvent, AbortController,
AbortSignal, DOMException and QuotaExceededError in the Node guest realm.
Their complete behavior and consumer integration remain **unverified on
all four hosts**. Shared diagnostic construction remains partial.
Transferable abort signals/controllers now register real metadata consumed
by the native serializer in the follow-up below. Actual host-object payload
transfer still fails explicitly until transport is implemented. DOMException
payload cloning is wired by the unverified follow-up below. The global
structuredClone follow-up below
replaces the JSON fallback with actual engine graph serialization. Async context and
EventEmitter async resources are supplied by the unverified follow-up below;
legacy domain integration remains incomplete. These gaps remain completion
work, not accepted exclusions.

## Diagnostics source candidate: product validation pending

diagnostics-platform-adapter.js embeds the full unchanged pinned
lib/diagnostics_channel.js and the exact WeakReference class from
internal/util.js. The manifest records both full inputs and the selected
helper section. Subscriptions, real weak/strong registry lifetimes, store
scopes, bounded windows and sync/Promise/callback tracing share these owners.

One adapter-owned registry links actual Kandelo JavaScript producers and
their subscriber state. The bootstrap connects Console/global console
argument publication before writing, client socket publication before
connection-option rejection and server socket publication after the public
connection handler. The public API does not advertise the target's internal
TracingChannel class as an extra namespace export. Subscriber failures use
process.nextTick and the existing guest callback exception route.

Focused source/native controls establish only the selected JavaScript
contracts. Guest weak-reference collection, async/store propagation, fatal
policy and the four-host product dependency graph remain unvalidated.
Native C/C++ producer bridging, other documented built-in producers, domain
and complete Console behavior remain implementation work. See the
[breadth-first ledger](../../tests/nodejs/outline/breadth-first-implementation.md).

## Async-context source pass: validation pending

`async-platform-adapter.js` connects the pinned frame/storage/resource
sources to private engine context state. Engine patch 40 captures that
state at actual promise reaction registration and restores it around job
execution. The timer scheduler captures callback scope; Timeout refresh
retains the construction scope. These source changes are uncompiled and
unverified on every host.

Patch 41 follows this with metadata on actual native promises and queued
jobs. The shared ID allocator owns timer, immediate and tick records;
nextTick and destroy notifications have dedicated queues. Clearing or
completing a timer retires its record and stored frame. Active refresh keeps
its context; reactivating a completed Timeout captures a fresh resource.
The unchanged lazy EventEmitterAsyncResource initializer shares these real
registries. Default promise-tracking hooks are connected to native events.

All of this remains **uncompiled and unverified**. Slow/custom-species then
lineage, optimized await identity, native I/O resources, root execution
identity, worker propagation, complete provider metadata and fatal/custom
process policy remain obligations. Untracked callback identity queries still
fail explicitly. See the implementation ledger for the full deferred audit.

## Path source pass: validation pending

The public path module now uses unchanged pinned Node POSIX/Win32 algorithms,
with the actual guest process cwd/environment. Pure matchesGlob behavior
uses pinned matching excerpts and Node's bundled minimatch; matching does
not traverse the filesystem. The source manifest records all hashes and
bundled dependency licenses. Exact shared validation diagnostics, bootstrap
ordering and native/four-host behavior are still unverified.

Regenerate or verify offline, without rebuilding packages:

```sh
scripts/dev-shell.sh python3 third_party/node-core/build.py
scripts/dev-shell.sh python3 third_party/node-core/build.py --check
scripts/dev-shell.sh python3 third_party/node-core/check-build-inputs.py
```

The engine recipe declares the core production owners, pinned reference and
license files used by generation and verification. Its normal build runs the
input guard and bundle freshness check before staging the engine source. New
core owners and references must be declared in the recipe, even when their
bytes are already embedded in the checked-in bundle. A stale bundle fails;
the build does not regenerate checkout inputs.

The guard covers root production files, recursive manifest paths, literal
generator paths, unity fragments and literal engine shell paths. This is a
conservative source guard, not a dynamic-read or complete SDK/toolchain closure
proof. It establishes no runtime compatibility. See the
[shared input record](../../tests/nodejs/outline/build-input-closure.md).

Source differential tests require the pinned Node 26 reference rather
than the independent host Node 24 toolchain. Guest fixtures exercise both
hosts after the SpiderMonkey package is rebuilt. Source conformance is
not evidence that a stale guest artifact contains these changes.

Upstream source:
<https://github.com/nodejs/node/tree/18b32a3b1552e199a01f1a8d9fd64aa756d3b75b/lib>.

## Shared values and classic stream source pass: validation pending

`values-platform-adapter.js` links pinned errors, validators, internal
assertions, color detection and selected utility/debuglog functions.
Path, events, async resources and streams share these implementations.
Two checked diagnostic guards retain real engine stacks when V8 stack
recapture is unavailable. Exact Node stack filtering/limits, native libuv
error-map data and some earlier inspection/assertion adapters remain gaps.

`stream-platform-adapter.js` loads 26 unchanged Node modules for classic
stream state machines, lifetime, buffering, iteration, operators, pipeline,
composition and promises/consumers. The actual I/O subclasses now use
_read/_write/_destroy/_final/_flush hooks. Private loaders retain live
module records during circular initialization. The bootstrap initializes
real decoder/timer/event dependencies before loading streams.

All changes remain **uncompiled and unverified on all four hosts**. The
Node/Web adapter source and closed/controller metadata are provided by the
follow-up below. Host-handle/channel transfer, native compression iterator
bindings, remaining CLI activation, and bytes/stdio/HTTP/TLS/zlib contracts still require implementation and conformance evidence. No new
passing compatibility result is inferred from these source changes. See
[the source ledger](../../tests/nodejs/outline/implementation-review.md)
and its linked pending source/test inventories.

## Web-stream and clone source pass: validation pending

The production stream owner now uses the pinned Node Web-stream algorithms,
with their actual reader queues, write trackers, closed promises, controllers
and disturbance state. Six public Node/Web adapters are unchanged excerpts.
Module/globals/Blob/Fetch share these constructors. Encoding/compression
interfaces and the pinned global interface list are wired in source.
Node's separate native StreamBase ABI wrappers are not supplied.

`clone-platform-adapter.js` links pinned JS transfer registration to the
native graph serializer. Patch 42 queues cloneable hosts in the original
identity map, invokes their clone hooks after the main graph and real buffer
detachment, and restores fully decoded payloads into allocated host objects.
DOMException and QuotaExceededError use their unchanged pinned hooks and
constructor module. Blob hooks copy its actual immutable byte storage and
media type. This source path has not been compiled or executed.

The serializer uses a versioned, embedding-private SameProcess envelope;
it does not claim persistent SpiderMonkey or V8 format compatibility.
Constructor metadata is string-only and does not consume graph object IDs.
Native clone errors use the owned DOMException constructor. The global
JSON fallback is gone, and actual ArrayBuffer transfer lists reach the
engine serializer. GC, realms, hook/getter order, error propagation and
failure-time detachment all still require native and four-host evidence.

Host-handle/port transfer, worker/channel APIs, codec completeness and exact
diagnostics remain implementation work. Registration is not successful
transfer. Every new source path remains
**uncompiled and unverified on all four hosts**. The source ledger and its
Web/WPT obligations retain the pending evidence and remaining work.


## File/FormData source candidate: product validation pending

file-platform-adapter.js embeds the full unchanged pinned internal/file.js.
It supplies real File metadata, coercion, inspection and clone payloads over
the existing shared Blob byte owner. Global File and buffer.File share the
constructor. Blob construction now copies raw SharedArrayBuffer bytes.
The clone module resolver reaches actual Blob/File receiver constructors.

formdata-platform-adapter.js embeds the target-vendored Undici FormData,
WebIDL and runtime-feature modules plus exact selected iterator algorithms.
Its private entries, mutation, duplicate handling, scalar conversion, File
values and live iteration use those owners. Newly created FormData instances
register actual noncloneable mode with the guest serializer. This internal
construction path does not supply public worker marking or message transport.
sources.json binds all full inputs and selected sections. The verified Undici
MIT license is included in the bundle and licenses/undici.txt.

Thirteen focused source/native controls cover these paths with explicit
native stream, codec, crypto and clone-registration boundaries. File clone
payloads are checked separately from the unvalidated guest serializer route.
Blob's remaining conversion/errors, species/intrinsics, file-backed storage,
object URLs, stream/clone/encoding integration and global descriptors remain
open. Multipart extraction/parsing and Fetch integration are not supplied by
FormData storage. None of this establishes current four-host conformance.

## Synchronous random and terminal source candidates

The newer crypto-random-sync-adapter.js selects exact synchronous random,
validation and public WebIDL wrapper sections from pinned full inputs. Its
entropy owner uses real guest /dev/urandom reads and bounded owned staging
for shared destinations. It does not substitute the embedding crypto API
for guest syscalls or implement async random jobs/full WebCrypto.

readline-platform-adapter.js embeds unchanged callback/promise Interface,
shared input/key/history, cursor and transactional modules. Actual input,
question/abort, listener/decoder state and write/queue owners replace the
no-input facade. Stdio/TTY/raw/resize, Unicode width, persistence/permissions,
REPL and full guest lifecycle remain incomplete or unvalidated. Focused
controls and source identities are recorded in the readline dependency
record and breadth ledger; four-host product conformance remains pending.

## Outgoing HTTP header source candidate

The subsequent http-headers-adapter.js selects exact functions and state
algorithms from full pinned HTTP common/outgoing/client/server inputs.
One real header store supplies public validators and actual ClientRequest
lookup/mutation/field serialization, method/path validation and status-code
constants. Its private prototype container is not a fabricated exported
OutgoingMessage constructor. HTTP wire output uses the shared Buffer
single-byte encoder; no protocol-local codec conceals that prerequisite.
Focused native/source and loopback controls cover the scoped paths; full
framing/parser/Agent/server/HTTPS trust and four-host guest conformance
remain pending or incomplete. See the breadth-first implementation ledger.

## TLS identity and shared domain/IP source candidate

`networkIdentity` binds full unchanged TLS, internal URL/net, URL/cares C++
bindings, Ada and libuv IP source inputs to the same target. Generation
checks full-source and selected-section hashes. Public identity matching,
domain coercion/errors and IP grammar use unchanged selected JavaScript.
`network-ip-adapter.js` ports libuv's strict parsing/canonical formatting
rules, including mapped IPv4 diagnostics; its ISC license is retained and
included in the generated bundle. The C++/C reference files are provenance,
not newly executed guest bindings.

`domain-platform-adapter.js` runs special-host assignment against the actual
vendored parser, with uncommitted host state to detect rejected assignments
instead of returning a stale hostname. The shared web backend implements
the target's non-strict ASCII rule and per-label Unicode rejection policy.
Remaining Unicode-table/validation and size/percent-decode branches need
complete later coverage; copied algorithms do not close those dependencies.

Fourteen focused controls pass: unchanged upstream TLS identity and three
IP grammar files, native domain/error/IP diagnostics and public bootstrap
wiring/WHATWG URL controls, plus existing URL/exit regressions. Native
common/assert/util, text and execution primitives remain explicit fixture
boundaries. TLS sockets, certificate extraction, contexts, chain policy,
identity callback activation, ownership and protocol suites were not run.
This is source progress, not current four-host guest conformance.

## VM frontend and native function source candidate

The public VM factory is unchanged pinned lib/vm.js, with pinned import-option
validation and shared errors/validators. Its private context map owns the real
sandbox/realm association; public createContext returns the sandbox and reuses
it without exposing the engine global as the context brand. Private Script
handles use a WeakMap instead of an exposed _h property. The native bridge
uses JS::CompileFunction with separate parameters/body, actual wrapped context
extensions, rooted ownership and caller-realm result/exception marshalling.
Parameter text is converted to ECMAScript escapes where the compiler's
C-string/Latin-1 parameter interface cannot directly represent UTF-16.

Engine patch 54 stages that source, supplies column metadata and inherits
the actual caller shared-memory policy rather than forcing it off. It adds
no syscall or kernel/host ABI export. The changed C++ is uncompiled; no guest
or four-host runtime result establishes those branches yet. Six frontend
controls use actual native Node VM owners as explicit boundaries, including
unchanged upstream context-brand assertions and one honest-gap control.
Unsupported deadline/cache/import/microtask/uncontextified/memory branches
fail explicitly and do not count as supported features.

The exact native reference separately passes ASCII/Latin identifier, global
brand and context-extension-order controls; its astral-identifier control
aborts. Earlier combined probes also aborted or failed collection. These are
retained nonpasses/questions, not guest results, target changes or accepted
engine exclusions. See the VM dependency record in the implementation outline.

## Iterable stream and exposure source pass: validation pending

The complete pinned `stream/iter` entry point and its iterator algorithms
are now copied unchanged, including push/pull, broadcast/share, consumers,
duplex and classic-stream interoperation. Its promise-handled operation
uses actual engine metadata through `JS::SetAnyPromiseIsHandled`; it does
not call `then` or install a replacement promise reaction. Both the binding
and library integration remain uncompiled and unverified.

Public availability uses unchanged excerpts of the Node realm exposure
policy. CJS/ESM loading and resolution, `module.isBuiltin`, builtin lists,
inspection and `process.getBuiltinModule` share that policy. Modules load
lazily, keeping availability checks separate from experimental warnings.
The pinned warning helper shares actual process warning delivery and
per-feature deduplication. Full loader/metadata and extension inventories
still require review; this does not claim complete module compatibility.

Engine patch 43 parses the iterator activation option from actual guest
CLI arguments and `NODE_OPTIONS`, with environment-before-CLI precedence,
negation, underscore normalization and separate CLI-only `execArgv`.
The environment tokenizer is copied unchanged from pinned Node source.
Only warning/iterator boolean options are implemented in `NODE_OPTIONS`;
other options fail explicitly. Other Node flags remain implementation
work, not accepted exclusions. Node version handling stays on the Node
version path when combined with recognized activation flags.

The pinned `zlib/iter` entry and transform use the same activation gate and
an owned native compression binding in the current source candidate. That
binding and its resource/context integration remain uncompiled and unverified.
Revision 45 is unbuilt and all native/four-host evidence is pending. See the
[implementation ledger](../../tests/nodejs/outline/implementation-review.md).


## Compression source candidate: validation pending

The source candidate supplies the exact Node-vendored `node-codecs` recipe,
actual linked-library version calls and pinned native constant definitions.
Unchanged Node codec contexts retain dictionaries, parameters and frame/reset
algorithms behind private engine handles. Native asynchronous writes use a
shared guest pthread pool with context-owned completions and counted stable
buffer leases. No compiler or runtime evidence establishes those paths yet.

Native handles allocate IDs from the shared engine allocator, capture their
creation frame and dispatch callbacks through that resource's before/after
scope. Actual native finalization queues destroy IDs; close alone does not
retire the async identity. A shared native destroy queue preserves enqueue
order across native and JS resource retirement and does not run hooks in GC.
The private binding constructors connect the pinned iterator algorithms to
these handles. Native CRC32 uses actual view bytes or explicit UTF-8 lengths,
including embedded NULs. These are source implementations, not passing APIs.

The public loader now uses 15 unchanged pinned zlib/ZIP modules and the
actual private native handle binding. The old sync-in-a-microtask callback
wrappers and public raw/Brotli/Zstd stubs have been removed from the source
candidate. ZIP uses the actual shared filesystem implementation; its missing
FileHandle/stream/truncation behavior remains a platform implementation gap.
Source integration is not evidence that those public APIs work.

The Buffer numeric adapter selects unchanged number/BigInt/float algorithms
and numeric prototype assignments from pinned `internal/buffer.js`. It replaces
the handwritten numeric methods, including their missing bounds validation,
and adds the BigInt operations used by ZIP headers. Allocation, copying,
encodings, pooling, shared/resizable input and transfer behavior still require
review. Public maximum-length metadata now comes from the guest engine's
actual typed-array and string limits through patch 48, not copied V8 values
or host allocation probes; it does not promise allocations succeed below
those limits.

Full AsyncWrap reset/alias/prototype/provider metadata, error/ordering/
finalization parity, shared/resizable/external buffer leases, complete
accounting, process exit/cancellation/fork and four-host memory/code/stack
limits remain review or implementation work. Revision 45 and the codec recipe remain unbuilt; no new
runtime tests or probes ran. See the
[public integration source record](../../tests/nodejs/outline/public-codec-source-status.json)
and [implementation ledger](../../tests/nodejs/outline/implementation-review.md).

## Compression embedding corrections: native validation pending

The post-audit compression embedding now uses the engine's actual
Int32/Uint32 conversion for codec options, params, flush flags and write
spans, before checking the resulting safe native range. This preserves
fractional public options/chunk sizes admitted by the pinned validators;
safe-integer pledged sizes, modes and CRC seeds keep their stricter checks.
The error owner follows the target's optional named callback behavior, so
Brotli/Zstd initialization before onerror installation can report the
actual ERR_ZLIB_INITIALIZATION_FAILED. Full unchanged node_zlib.cc and
async_wrap-inl.h reference inputs are hash checked by the bundler.

Five focused controls run the actual pinned public JavaScript and candidate
private constructors against the exact native Node backend. Each native
subprocess owns its internal-test flag and timeout; ordinary module-policy
controls retain normal flags. These controls establish reference behavior
and the JS embedding boundary, not compilation or execution of the changed
Kandelo C++ handle. The real guest lease/storage/init-error/lifecycle paths
and four-host conformance remain unvalidated. See
[compression dependencies](../../tests/nodejs/outline/compression-embedding-dependencies.md).

## Filesystem truncation source candidate: validation pending

Pinned `fs` truncation, callback and default VFS-registration excerpts now
route through the existing guest libc/kernel `ftruncate` path. This replaces
the public throwing descriptor stub and the path operation that previously
opened and closed without changing the file. Callback operations use actual
fast-I/O jobs on the guest pool, not a synchronous syscall in a microtask.
Fixed native state and job allocations are associated with their actual
resource object. Each native request owns its ID/trigger/frame, callback root
and completion/cancellation retirement; no replacement Promise/AsyncResource is allocated
for that callback request. Provider positions derive from pinned Node source.

The Node experimental VFS state excerpt defaults to no registered handlers;
it does not implement the public experimental VFS APIs or replace the
kernel VFS. Public path truncation still uses the existing incomplete open/
close adapters. FileHandle exists, but truncate, reference/close ordering,
stream lifetime and its other partial operations remain gaps. Native request
prototype/provider/diagnostic/error/GC/exit/memory accounting and four-host
behavior are unverified. Revision 45 remains unbuilt. See the
[source record](../../tests/nodejs/outline/fs-truncate-source-status.json)
and [implementation ledger](../../tests/nodejs/outline/implementation-review.md).

## Native descriptor owner and close source candidate

Pinned `fs.close`/`closeSync` and the default close callback now use the shared
native filesystem binding. Callback close runs on the guest work pool;
close follows libuv's EINTR/EINPROGRESS handling without retrying a possibly
reused descriptor. Truncation retains its separate EINTR retry behavior.

The native descriptor owner in `native-file-handle.cpp` has an actual fd,
shared-engine FILEHANDLE identity/creation frame, synchronous close and a
cached Promise for its real FILEHANDLECLOSEREQ work. A close request roots its
parent until completion/cancellation. Completed close invalidates the native
fd before callbacks; cancelled work distinguishes a syscall that ran from
one that never ran, avoiding a later close of a reused number. Adoption
consumes exactly one descriptor, with native cleanup on failed setup. State,
job and original-path allocation sizes are associated with the actual owner.

An abandoned owner closes its actual descriptor during foreground GC, as in
the pinned Node implementation. A context-owned native queue retains the
fatal diagnostic until the event loop can execute JS. It uses a retry/ack
handoff, preserves the original UTF-8 path, runs no JS during GC and does not
create a public Immediate/TickObject/AsyncResource. Native internal callback
scope uses zero IDs and a fresh batch resource. Detached contexts still
close fds but do not schedule JS through a dead context. Exact diagnostic/
uncaught-exception recovery, batch/order/GC/OOM/exit/fork semantics and complete
shared-queue accounting need review and unchanged differential evidence.

The following source increment connects pinned public FileHandle refs/close,
descriptor methods/file helpers and pinned filesystem streams to this owner.
Actual native promise I/O/stat/control jobs use guest libc and the shared pool;
raw path bytes and descriptor ownership survive setup/cancel/GC transitions.
Pinned Stats classes decode actual SDK metadata, and descriptor permission/
time methods now perform their syscalls. Filesystem constants use pinned
Node/uv definitions with guest SDK values. Buffer.allocUnsafeSlow uses pinned
algorithms and actual engine-owned backing stores/alignment.

Transfer, file iterators/readLines, path fast jobs, remaining filesystem async
callbacks, shared/resizable buffer leases, birthtime capability, diagnostics,
resource/lifecycle/accounting and full API coverage still need implementation
or review. Revision 45 remains uncompiled/unbuilt; static source checks do not
establish runtime behavior. See the current
[source status](../../tests/nodejs/outline/fs-promise-source-status.json) and
[implementation ledger](../../tests/nodejs/outline/implementation-review.md).


The next source increment routes pinned callback descriptor operations and
path stat/lstat to actual native requests/jobs, with real queued cancellation
and normal ECANCELED completion. Pinned sync open/read/write/vector functions
use direct syscalls without async resources. Shared util.promisify and its
multi-result symbol replace the handwritten wrapper. Native path diagnostics
use the engine decoder and actual copied pathname bytes. No C++ build or
runtime evidence establishes compatibility; pathname file jobs, async backing
store leases and the other documented API/lifecycle gaps remain open. See
[the current callback/sync source record](../../tests/nodejs/outline/fs-callback-source-status.json).

The read-file source candidate now supplies an actual native pathname job and
unchanged callback read context/public promise helper. It owns the original
path, native FSREQCALLBACK lifetime, worker allocation and fd handoff/cleanup;
result Buffer views exist before callback hooks. Common native opens now use
libuv's close-on-exec default through the actual SDK flag. Write-file jobs,
detach-safe backing-store leases, remaining file APIs, complete native metadata/
error/lifecycle/accounting and four-host evidence remain open. Revision 45 stays
unbuilt; see [the current read-file source record](../../tests/nodejs/outline/fs-readfile-source-status.json).

## SQLite connection and statement source candidate

sqlite-platform-adapter.js embeds unchanged public lib/sqlite.js, including
DatabaseSync/StatementSync aliases, over private database/statement owners.
sqlite-store.h executes real SQLite operations and owns handles, bound and
returned bytes, statement invalidation, errors and close/reopen state.
native-sqlite.cpp supplies the proposed engine bridge. Constants are
selected from pinned Node definitions against actual SQLite macros, and
process.versions.sqlite reads the linked library version.

The exact node-sqlite package supplies SQLite 3.54.0 from the Node target,
without changing the independent sqlite package. Full pinned public/native
and byte-representation reference files are hashed in sources.json.
Empty raw ArrayBuffer and empty view bindings preserve their distinct
SQLite NULL/BLOB representation; text retains embedded NUL bytes.

A compiled native-host store control matches the exact native Node reference
for typed values, configurations, transactions, failed opens and close/reopen.
Five shared frontend controls pass over real native Node SQLite and compiled
SQLite parameter inspection; one asserts explicit unsupported behavior.
Neither route compiles or executes native-sqlite.cpp. Shared/resizable byte
storage, callbacks, sessions/change sets, iterators, tag stores, metadata,
limits, extension permission, backup and remaining APIs are implementation
gaps. No guest/four-host conformance is established. See the SQLite
implementation dependency record in tests/nodejs/outline.

## FD-backed stream ownership source candidate

fd-stream-platform-adapter.js connects the existing real fd Promise/control
seams to pinned Readable/Writable state machines. Writable owns buffered
writes, high-water marks, drain, callbacks, encoding and end/error state;
its callback follows the actual full native write operation. Readable owns
input buffering/encoding, consumption, EOF, iteration, destroy and events.
Pause stops the exact pending read on the next tick; resume retains bytes
that completed during a pause race. ref/unref controls actual pending read
liveness and carries that policy into subsequent requests.

The process stdout/stderr policy uses unchanged pinned dummyDestroy:
observable close does not close the borrowed descriptor and the stream can
be used again. Process stdin retires/cancels its exact read on destroy.
The old per-stdio listener maps, immediate write callbacks, unconditional
write success and read-returning-null facade are removed. Input conversion
captures Buffer.from before user mutation. A missing terminal-mode setter
now rejects instead of claiming raw mode changed; fabricated terminal size
defaults have also been removed from this source route.

Four scoped controls execute these owners and the candidate pinned stream
factories over real native Node engine dependencies and OS pipes/files.
They cover pending write/backpressure/completion and bytes, input decoding/
EOF, pause/ref/resume/cancel, descriptor retention, actual write errors and
public Buffer.from mutation. This is neither guest native-watch/VFS evidence
nor four-host conformance. Exact Socket/TTY/file subclass identity, stdio
fd ownership/type selection, complete terminal modes/signals/window size,
native async lineage/error/EINTR/nonblocking and loop/fd-reuse policies
remain dependencies. See the stream implementation dependency record.

## Entangled local message-port source candidate

port-queue.h owns synchronized endpoint queues, FIFO delivery, start/stop,
reference state, peer-disentanglement markers and packet retirement. Close
completion remains pending until the JS close notification is acknowledged;
force-receive does not turn an asynchronous close event into a synchronous
one. Native abandonment releases queued payloads without allocating a close
marker. A direct ref keeps an unstarted port alive as well.

native-ports.cpp roots opaque serialized shell buffers while queued in a
single JS context. Context shutdown releases all queued roots before engine
teardown. It does not move JS roots across contexts/threads. Patch 56 adds
actual port reference accounting and a port dispatch phase to the native
loop; no timer keeper substitutes for a port owner. The existing polling/
idle-wait behavior still needs work. The engine bridge remains uncompiled.

ports-platform-adapter.js embeds unchanged pinned worker/io.js and the
per-context messageport helper. Real native endpoints back its constructors;
NodeEventTarget integration, listener start/ref policy, close and event dispatch
come from those owners. Serialize happens during post and deserialize during
receive. Full pinned Undici event classes now share the existing WebIDL owner;
module/global/stream/WebIDL consumers share one MessagePort/MessageChannel.
Native-only constructor errors are selected from pinned node_errors.h rather
than assumed to exist in the JS error-code registry. Public mark/move/transfer,
metadata and full native-provider lineage are not complete.

A compiled native queue control passes 1,000 ordered cross-thread packets,
ref/start/force-receive/close acknowledgement and packet-release assertions.
Three frontend controls pass using actual native Node queues, graph/byte
serialization and engine dependencies. Seventeen affected fd-stream and
File/FormData regressions pass. None executes native-ports.cpp, guest clone/
loop state, cross-worker delivery or four-host product artifacts. Port movement,
broadcast groups, complete Worker bootstrap/identity/stdio/environment/options/
stop/join and other audited worker contracts remain implementation gaps.

## Testing mock, virtual-clock and reporting source candidate

The partial node:test factory now exposes real pinned standalone MockTracker
owners: Proxy call/construct/access records, method/getter/setter/property
restoration, one-call overrides, times policy and tracker reset. MockTimers
owns an actual shared virtual clock for selected global/module timers, Date,
scheduler.wait and AbortSignal.timeout, with priority-queue scheduling and
restoration. Snapshot/assert configuration and TestsStream/reporters use
pinned source and actual value/file/VM/stream dependencies.

Full unchanged pinned Test/Suite/harness/utils now own public default-import
execution, context/hooks, plans/assertions, actual result records and per-test
mock cleanup in source. Native dependency controls exercise selected paths;
run/discovery, isolation, measured coverage, module mocking, complete snapshots,
source maps/structured stacks, CLI/watch and benchmark owners remain open.
Default option state is generated from pinned node_options.h declarations;
unsupported argument-parser features remain rejected. Caller location reads
actual engine saved frames rather than parsing mutable error text.

Nine focused controls pass over pinned native26 dependencies. Paired default
public runs each report two passes/one skip; paired deliberate failures each
report one failure/exit1. Their distinct outcomes, earlier fixture/error-owner
nonpasses and exact source IDs remain in the testing dependency record. The
new recipe84 integration is uncompiled in the guest, newer than accepted
Worker engine83. No full testing-framework or four-host claim is established.

## MIME source and capability correspondence

valuesPlatform now includes the full unchanged pinned lib/internal/mime.js,
hashed in sources.json and exported through the public util wrapper. Its
actual MIMEType/MIMEParams owners include lazy parameter parsing, private
brands, case-normalized mutation/lookup, iteration, syntax/coercion/errors,
parse, toString and the target aliases/descriptors. The shared error and
primordial dependencies remain actual candidate owners.

The two unchanged upstream MIME test files pass over the candidate with
native engine/assert/common/fixture dependencies, and separately as native
reference controls. Nine public-util controls pass, including two MIME
comparisons. The retained first run has eight passes and one failed fixture
comparison of separate private-state instances; it was corrected to compare
their observable mutation/iteration/serialization without changing upstream
assertions. None of this establishes SpiderMonkey or four-host conformance.

The current capability/deprecation reconciliation under tests/nodejs/outline
retains every historical matrix observation and deprecation code, routes all
families to remaining owners, and explicitly records fabricated metadata.
It does not convert imported source, namespaces or unavailable operations
into passing compatibility.


## Process-state source owner

process-state-adapter.js embeds unchanged main/worker creation-mask wrappers
from the exact target and supplies live environment get/set/delete/own-key/
descriptor/symbol operations. process-state.h owns actual libc environment
storage, copies borrowed values/names under its mutation lock, and performs
real serialized mask query/update and parent lookup. Patch 58 binds those
operations; the engine bridge is uncompiled. Native helper and focused
frontend/unchanged-upstream controls are not guest or four-host evidence.
Worker environments, timezone notifications, exact exotic metadata, numeric
key/invalid-UTF8 behavior, warning/trace/CLI policy and remaining process
contracts are retained in the process-state dependency record.


## Native DNS prerequisites

dns-lookup.h owns actual OS name-service results; patch 59 schedules them
on the native SlowIo queue rather than calling getaddrinfo inline on the
JS thread. Owned strings/RAII results stay native until owning-context
completion. Exact DNS/libuv sources are retained and hashed as references,
not installed as an apparently working public Resolver.

dns-resolver.h supplies a real pinned c-ares channel, native event owner,
configuration/query/cancel/close and borrowed-record copying. Native DNS
packet/TTL/lifetime controls match pinned Node using an actual loopback
fixture. This raw backend is not the public record/async/ref/realm/GC
bridge. The target package/engine remain unbuilt and all four hosts
unvalidated. resolve now fails honestly instead of returning fake data;
that guard is not counted as support.


## System-error data source owner

uv-platform-adapter.js now supplies the shared errors/util layer with a
real compiler-selected error map, message data and UV_* constants. The
native header expands unchanged pinned libuv data against actual target
errno definitions, including portable fallback/EAI values. This is data,
not a libuv runtime or advertised ABI. Public util name/map/message methods
use pinned validation/helpers. Fresh public maps and entries cannot mutate
the private error cache; captured operations resist public collection
mutation. Numeric DNSException and UVException controls retain real fields.

A native-host table matches all 85 entries in the exact native reference.
Thirteen frontend/error controls pass with explicit native dependencies.
The first generated macro compile failure/source is preserved; correcting
the missing terminating blank line did not change the assertion/data.
Guest marshalling/errno profile, stacks, full-range message edge semantics,
actual error delivery and four-host conformance remain open in the system
error dependency record. The engine bridge remains uncompiled.

The native name-service request prerequisite now has a separate owner in
native-dns-lookup.cpp (patch 61). Actual request state/provider identity,
rooted SlowIo work, owning-realm completion and deterministic retirement
cover both getaddrinfo and getnameinfo. dns-errors.h shares pinned numeric
EAI translation with the older Promise lookup bridge. Reverse lookup uses
NI_NAMEREQD and real IPv4/IPv6/zone/port conversion; AI_* constants come
from the compiler's netdb.h. A native-host helper matches pinned Node's
loopback hostname/service/constants and checks conversion/error behavior.
The engine bridge is uncompiled. The public pinned lookup/lookupService
frontends now connect through dns-lookup-platform-adapter.js and a genuine
DNS observation owner. See the DNS dependency record for remaining callback
scope/prototype/CLI/Resolver/transport and four-host obligations.


## Pinned lookup and actual DNS observation

dns-lookup-platform-adapter.js installs unchanged callback/promise lookup
and lookupService algorithms over real request primitives. The unchanged
DNS utility module shares result-order state and validators. Raw hostname
UTS46 uses the existing vendored converter with the pinned input-byte cap;
URL host parsing is not reused for DNS. Pinned async provider IDs now cover
the two actual name-service request kinds. Native returned-object helper
metadata/reset/invalid-receiver and callback-scope semantics remain partial.

performance-observer-adapter.js owns actual registrations/counts, queued
entry/list delivery and pinned start/stop helpers. Its supported types list
is adapted to only installed DNS producers; the other target producer types
remain implementation gaps. mark/measure throw instead of no-op success.
performance-clock.h captures one real POSIX origin at engine main entry;
now and process uptime use elapsed monotonic time, and worker contexts share
that origin. The global and builtin performance objects share this owner,
while the full public Performance/EventTarget surface remains incomplete.

31 focused frontend/socket cases, three unchanged upstream files in both
candidate/native modes and native clock/19-case Ada controls pass. The first
frontend retirement fixture failure and source inputs remain preserved.
The native Node callback-scope observation leaves a real guest scheduler/
tick/microtask-before-retirement prerequisite open. These controls do not
compile the engine bridge or establish four-host conformance. See the DNS
and performance dependency records in tests/nodejs/outline.

## Shared native callback scope candidate

callback-scope.h and native-callback.cpp now give DNS, filesystem and codec
callbacks one actual resource/context/depth/checkpoint owner. Successful
outermost callbacks emit after, restore context and drain owning ticks/jobs
before the producer retires. Nested/failed/stopping scopes defer or skip that
checkpoint appropriately. Actual JS bootstrap/timer/tick/job entries guard
depth without allocating a synthetic resource. Shutdown requires depth zero.

The shared policy compiles and matches eight native Node-API/libuv scenarios;
the JSAPI adapter/engine remains uncompiled. Promise rejection/fatal recovery,
weak-reference/zero-ID/realm/worker and full phase obligations remain open.
See the callback-scope dependency record for exact evidence, native negative
statuses and later identified-artifact/four-host validation requirements.

## Directory/pathname source candidate

The directory platform adapter selects pinned sync/callback/promise mkdir,
unlink and rmdir wrappers over actual distinct guest POSIX operations.
directory-operations.h ports recursive mkdir continuation and first-created
results without normalizing away path bytes; native-directory.cpp retains
copied paths and actual FSReq work ownership through completion. Patch 64
selects the bridge. Native helper/Node frontend controls are separate from
guest JSAPI/engine validation, which remains uncompiled on all four hosts.
Removal traversal/retries, directory handles/raw names, metadata/watch,
permission activation and complete lifecycle remain open; see the directory
implementation dependency record in tests/nodejs/outline.

## CommonJS Module record source candidate

module-record-platform-adapter.js selects pinned constructor, require,
createRequire, lookup/load and JSON algorithms over actual record/cache/graph/
extension owners. The bootstrap now executes ordinary CJS/JSON through these
records and removes failed children. Private fields use WeakMaps; native
SafeGetEnvironment supplies actual credentials/libc secure-state admission
for global loader paths. The uncompiled patch 65 bridge and ordinary native
helper checks are separate from four-host guest evidence. Package maps,
exports/imports/config, native ESM/async-graph/cycles, hooks/cache/source maps,
preloads/TS/CLI, addons and diagnostics remain incomplete. See the module-record
dependency record; neither this source slice nor upstream file passes close
public-core conformance.

The dotenv parser is retained from the exact target src/node_dotenv.cc by
generate-dotenv.py, with checked inline/C++17 prefix-spelling adaptations.
The separate file owner uses real guest POSIX reads, and native-dotenv.cpp
owns JS conversion and actual process-environment application. Public util
and process wrappers retain selected pinned source. Scoped portable/native
and unchanged upstream evidence is recorded in the dotenv dependency record;
the engine and all four guest hosts remain unvalidated. CLI, permission,
worker and unexpected close-policy implementation remain open.

The digest adapter retains pinned public one-shot hashing/normalization and
byte-validation helpers over digest-operations.h/native-digests.cpp. Actual
OpenSSL fetch/context/comparison resources and temporary bytes have owned
lifetimes; provider enumeration replaces preset names. Scoped exact-version
native/helper/frontend/upstream evidence is separate from the uncompiled
engine bridge and four guest hosts. See the digest dependency record for
remaining incremental, key/async/FIPS/WebCrypto and lifecycle obligations.


### Console namespace, output and state source candidate

The compatibility candidate selects pinned full Console/public/global/table/
debug-timer source over actual shared guest streams, inspection, diagnostics,
readline controls and native iterator/monotonic owners. Builtin/global identity,
format/options/error policy and counter/group/timer state replace separate
facades. Direct diagnostic publication replaces wrapping, avoiding duplicates.
A private trace collector owns active subscriptions and retirement; public
trace files/CLI/native producer/inspector integration remain incomplete.

Missing V8 stack recapture uses a real engine Error stack; exact filtering
and inspector methods remain implementation gaps. Nine focused Console and
ten diagnostics controls plus four unchanged upstream files in candidate/
native modes use explicit native dependencies, not built guest evidence.
Recipe revision 52 adds no engine patch/import/wire ABI. Four-host stream/
TTY/width/error/GC/realm integration, ESM identity and full observability remain
unvalidated. See tests/nodejs/outline/console-implementation-dependencies.md.


### Shared Headers and Fetch header source candidate

The shared FormData/WebIDL owner now loads pinned full Undici Headers and
checked header/iterator primitives. Private lists/guards and actual brands,
validation, normalization, sorted iteration and cookie ownership replace the
public map facade. Fetch uses that same global class, preserves immutable
transport/clone guards, reduces owned lists without prototype-name loss,
keeps set-cookie arrays and replaces Request headers when init supplies them.
Full Request/Response/Body/Fetch and guest transport remain incomplete.

Six new/26 affected native-boundary controls and one unchanged upstream file
in candidate/native modes pass. The in-memory HTTP fixture performs no
network access; body regressions retain their explicit polyfill stream
boundary. Recipe revision 53 adds no engine patch/import/wire ABI or rebuilt
guest artifact. Four-host brand/clone/stream/HTTP/GC/realm conformance remains
open. See tests/nodejs/outline/headers-implementation-dependencies.md for
retained failed evidence, native constructor-record behavior and remaining
implementation/integration gates.


### Query-string and Unicode codec source candidate

Full pinned public/private querystring and punycode algorithms replace split/
URI shortcuts and identity-only functions. Actual query options, tolerant
Buffer-byte decoding, null dictionaries, public hooks and exact surrogate
encoding share the guest byte/error owners. Punycode loads lazily with real
Bootstring/UCS-2/domain functions and its actual warning call. The prefix's
existing saved-frame capability supplies a bounded first-external-source
origin decision; no caller/platform metadata is fabricated.

Eight new/16 affected controls and five unchanged upstream files in candidate/
native modes pass. Candidate-Buffer controls use a fixed allocator; upstream
files use native Buffer/origin/warnings. The initial unexpected fixture
warning failure is retained; awaited standard preload setup keeps warnings
visible and assertions unchanged. Recipe revision 54 adds no engine patch,
import/wire ABI or guest build. Full byte/realm/loader/CLI/worker/warning and
saved-frame depth/ESM/native-entry behavior remain open across all four hosts.
See tests/nodejs/outline/query-codecs-implementation-dependencies.md.


### OS frontend and actual POSIX state source candidate

Pinned full OS source now uses actual guest uname/hostname, environment/passwd
home/user bytes, safe temp policy, endianness and priority operations through
os-operations.h/native-os.cpp and patch 0069. Owned byte copies and actual
libc errors replace presets; the existing module identity is retained.
Kernel getrusage/sysinfo still have fixed accounting, so CPU/memory/load/
interface/uptime/parallelism APIs explicitly throw rather than presenting
those values as real measurements. These are implementation gaps. Guest OS
constants, priority cross-process/credential/scheduler effects and five other
process/heap/report false claims remain open.

Seven new/eighteen affected native-boundary controls and three unchanged upstream
files in candidate/native modes pass. The helper compiles real portable
POSIX owners; native Node supplies Buffer/UV/constants and the transport
maps self priority to its owned Node control process. Candidate preload
propagates to the homedir child. None proves guest libc/kernel/JSAPI or
four-host conformance. Recipe revision 55 adds no host import/syscall/wire
ABI; guest compilation/full rebuild remain deferred. See
tests/nodejs/outline/os-implementation-dependencies.md for exact limits.

### Native DNS record decoder source candidate

`dns-records.h` now decodes real pinned c-ares results into independently
owned native completion values. `QueryResult::Decode` preserves query status
and works after its channel is destroyed. A/AAAA TTLs, aliases, text/chunk
boundaries, record dictionaries, ANY ordering, sparse TLSA indices and binary
bytes follow the pinned native source/reference. Undefined own fields and
ordinary CAA property assignments remain distinct in the value model.

Twenty-two native-host loopback DNS differentials pass after correcting two
missing undefined properties. Exact failed inputs and output remain retained.
These controls do not execute Kandelo guest code. Actual JSAPI allocation,
realm setters/GC, public Resolver/request lifecycle, event-loop completion,
guest backend linking/configuration and malformed wire edges remain open.
No public DNS capability, completed family or four-host conformance claim
follows from this decoder. See the DNS implementation dependency record.

### Removal traversal, retry and raw scanning source candidate

`removal-platform-adapter.js` selects checked public rm validation and full
unchanged async rimraf source. `removal-operations.h` provides actual native
sync filesystem traversal/retry/error policy and owned raw directory scans.
`native-removal.cpp` uses the shared native FS request/work/realm lifecycle;
patch 70 and recipe 56 stage its source. Guest JSAPI is not compiled yet.

Twelve focused controls, eight explicit portable-helper scenarios and three
unchanged upstream files per candidate/native mode pass at their documented
native boundaries. The failed first fixture run remains retained. These are
not guest/four-host compatibility passes. The private raw readdir dependency
still differs from the target's public method replacement interaction; public
readdir/Dirent/Dir and complete error/permission/extreme-option/realm/lifecycle
behavior remain open. See removal-implementation-dependencies.md for the
source/evidence boundaries and remaining owners.

### Portable util parsing, diff and call-control algorithms

`util-algorithms-adapter.js` owns full pinned parseArgs, diff, debounce and
throttle source over actual shared dependencies. Parser tokens/negation and
validation, Myers diff operations, timer/promise queues, cancellation/abort/
concurrency/ref state use real algorithms. Patch71 records eval source in the
actual CLI parser; captured metadata, not mutable execArgv, selects default
parseArgs arguments. Recipe57 stages source without a guest build.

Eight focused controls and four unchanged upstream files per candidate/native
mode pass at documented native boundaries. Parse-args children remain native
CLI controls. The new guest CLI/clock/timer/async bridge is unvalidated; native
invisible lazy data properties for parseArgs/diff remain an explicit engine
implementation gap. The temporary JS accessor supports frozen namespaces but
does not establish descriptor/receiver/realm fidelity. See the util algorithm
dependency record for retained history and remaining work. No util family or
four-host conformance completion is claimed.

The StringDecoder source candidate retains the full pinned public module
and native state/conversion references. Its portable incremental owner uses
actual seven-byte state and private Buffer codecs. Focused/native controls
do not establish guest engine, allocation or four-host conformance; see
[remaining decoder dependencies](../../tests/nodejs/outline/string-decoder-implementation-dependencies.md).

Address/rule source now includes pinned BlockList/SocketAddress and net class
getters, real native address/range/prefix/locking ownership and live TCP
consumers. Native handles reject clone attempts until a shared-owner
serializer exists. The guest bridge is uncompiled; see
[address dependencies](../../tests/nodejs/outline/address-rules-implementation-dependencies.md).

The partial live TLS metadata source owner and its explicit remaining
requirements are tracked in [TLS state dependencies](../../tests/nodejs/outline/tls-state-implementation-dependencies.md). No family or four-host conformance is established by that slice.

See [Buffer pool dependencies](../../tests/nodejs/outline/buffer-pool-implementation-dependencies.md)
for exact constructor/storage source ownership, scoped evidence and remaining
requirements. No four-host conformance is established by that slice.

[Shared package policy](../../tests/nodejs/outline/package-policy-implementation-dependencies.md) now connects actual exports/imports/maps/
conditions and public package-JSON discovery with filename/URL consumers.
Execution, hooks, source-syntax/type/addon and four-host requirements remain
explicitly incomplete; source policy is not full loader compatibility.

The partial DNS Resolver/channel/record source and external native completion
owner are documented in tests/nodejs/outline/dns-channel-implementation-dependencies.md.
Full pinned frontend/native-boundary controls are separate from guest/four-host
conformance; remaining configuration, permission, lifetime and host routes
are explicit gaps. No overall suite or full product rebuild ran.

Owned message packet and actual JS adapter integration source is recorded in
`tests/nodejs/outline/port-packets-implementation-dependencies.md`. Native engine
buffers replace rooted shell payloads; worker transport/lifecycle remains
partial and scoped controls do not establish guest/four-host conformance.

Process usage algorithms and actual nominal engine GC-budget reporting are
recorded in tests/nodejs/outline/resource-usage-implementation-dependencies.md.
Guest CPU/memory/resource/report/space providers remain explicit gaps; missing
measurements no longer return fabricated zeros/paths/spaces. No full API or
four-host conformance is established by those guards.

The subsequent HTTP source slice uses the complete pinned IncomingMessage
module for actual response parsing, lazy/distinct headers/trailers and abort
state. Socket release now waits for consumed response EOF and completed request
writes. Recipe77 remains uncompiled; the last accepted engine76 predates it.
Focused native-boundary controls are separate from guest/four-host conformance.
Complete parser/Agent/server/HTTP2 and remaining lifecycle gaps stay open; see
`tests/nodejs/outline/http-incoming-implementation-dependencies.md`.

The VM ordinary-global source now owns a real isolated DONT_CONTEXTIFY
global and per-ShellContext chained/restored security callbacks (patch85,
recipe78). Ordinary sandbox live forwarding, imports/deadlines/microtasks and
full realm/worker behavior remain gaps. Native-boundary controls and the
retained complete-file dynamic-import failure do not establish guest or
four-host conformance. See
`tests/nodejs/outline/vm-plain-context-implementation-dependencies.md`.

The later normal targeted engine78 build compiles actual VM ordinary globals/
runtime security callback ownership and the preceding HTTP77 source. Narrow
Node-host guest VM outcomes are separately identified in the VM plain-context
dependency report; HTTP/worker/full API/four-host conformance remains open.
The complete unchanged VM plain-context upstream candidate file still fails
its missing dynamic-import requirement. No overall suite/full product rebuild.

The subsequent Worker source replaces minimal-prelude/JSON/shared-mailbox
launch with per-worker native context/thread/packet/endpoint ownership and
normal Node bootstrap/loader, ready/error/exit and independent stop/join/ref
state. Patches86–88 reached targeted engine83 acceptance; six identical
native/Node-host guest cases pass. Options/stdio/fd/transfer/resource/lifecycle,
ordinary stamped-consumer and four-host obligations remain open. Subsequent
recipe84 Test/Suite/harness source is uncompiled; native-boundary controls
are separate from guest execution. See worker-owner and testing dependency
records under `tests/nodejs/outline/` for exact evidence and retained failures.

The later targeted engine88 compiles actual SQLite iterator/column/limit/
session/change-set and native callback owners, with real SQLite activation and
process beforeExit idle/revival state. Exact focused native/Node-host guest
outcomes and retained nonpasses are in the SQLite dependency/finding records.
SQLite/testing/process and four-host conformance remain partial; no overall
suite or full product rebuild ran.

## HTTP response parser source104

`node-llhttp` builds the exact unchanged Node-vendored parser. The portable
response owner/native GC binding and pinned `_http_common.js` callbacks replace
handwritten response framing in the production client. Public parser-option
validation is an unchanged `_http_client.js` section. Information/HEAD/upgrade/
CONNECT source and real byte budgets accompany removal of unsafe unconditional
replay and pre-request leftover reuse.

Both library architectures and normal engine104 compile. Twenty frontend and
25portable native differential controls pass at their documented native
boundaries; these are not guest or four-host results. Synchronous callback/
reentry, transient memory/GC/realm/input ownership, EOF/error/public lifecycle,
Agent/server/OutgoingMessage/HTTP2 and other HTTP audit obligations remain open.
See [HTTP parser dependencies](../../tests/nodejs/outline/http-parser-implementation-dependencies.md).

## Object marks source106

Pinned public marking functions and worker IO now reach the engine's actual
private weak registry. Buffer pool marking and the public transfer predicate
share the same state, and the actual clone/transfer writers enforce it. The
native binding preserves the target's Proxy TypeError/no-trap behavior.
Corrected engine106 compiles;15native-dependency controls and two unchanged
upstream files per candidate/native mode pass. None is current guest/four-host
registry/GC/transfer conformance. Markable process.env still depends on replacing
the scripted envProxy with the actual environment exotic-object owner.
See [object mark dependencies](../../tests/nodejs/outline/object-marks-implementation-dependencies.md).

## Native environment source107

The public environment view now has a real native virtual Object over the live
process/worker store. Private callback state is traced in reserved slots;
actual property hooks and the ordinary receiver algorithm replace the public
scripted Proxy. The object refuses a fixed own-key set while the external
store remains mutable. Model-aware clone traversal and private object marks
consume that actual owner, without a process.env exception.

Engine107 compiles. Native policy controls record15pass/1fail; the preserved
snapshot case is rejected at the custom V8 addon serialization boundary, not
credited as guest behavior. Actual native Node environment snapshots/marks
pass separately. Prototype/constructor/keys/store/warnings and real guest/GC/
JIT/clone/four-host obligations remain. See
[environment dependencies](../../tests/nodejs/outline/environment-object-implementation-dependencies.md).
