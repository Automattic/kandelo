# Values, assertions and diagnostics: source audit

This report completes the broad source review of the values family with
implementation gaps. It is not implementation sign-off or runtime evidence.
The exact target remains Node 26.13.0 at the commit recorded in
[target-pins.md](target-pins.md). Existing scoped findings V-001–V-028 remain
in [values.md](values.md), [values-query-codecs.md](values-query-codecs.md),
[values-legacy-modules.md](values-legacy-modules.md) and
[string-decoder-contracts.md](string-decoder-contracts.md).

The requirements metadata preserves complete original documentation sections
and native capture descriptors. Those capture rows are observations, not an
exhaustive public API list: returned objects, aliases, inherited methods,
instance fields and symbols must retain their actual owners. Errors and Intl
are cross-cutting contracts, not importable `node:errors`/`node:intl` modules.

## Assertion owners and behavior

Bootstrap 2801–2810 initializes `_createNodeCore` using the public Buffer,
inspection and shared WHATWG URL constructor. `third_party/node-core/adapter.js`
loads the target assert, assertion utilities and deep-comparison algorithms.
`build.py:16–28` changes the expression-unavailable branch of `innerOk` to
pass an empty message-argument array; the stored assertion utility source is
unchanged, but the executable factory has this explicit transformation.

The public callable assert, ok/fail, loose/strict equality and negations,
partialDeepStrictEqual, match/doesNotMatch, throws/doesNotThrow,
rejects/doesNotReject and ifError use those algorithms. The Assert constructor
stores immutable private options and inherited methods; strict instance
aliases replace the four loose methods. Destructuring an instance method
does not preserve its options; the target documents that consequence. The
strict callable receives the original own functions and four strict aliases;
`assert.strict.strict` is self-identical and `node:assert/strict` routes to it.
There is no need to invent a second assertion implementation for that alias.

Comparison source `upstream/comparisons.js:137–589,594–1085` distinguishes
SameValue/loose/strict/partial/skip-prototype modes, cycles, sparse arrays,
enumerable symbols and non-index keys, unordered Map/Set matching, float
NaN/signed-zero treatment, boxed primitives, dates, RegExp, ArrayBuffer/views,
Error cause/errors, URL href and identity-only types. Native buffer comparison
in adapter.js:168–179 creates byte spans with intrinsic buffer/offset/length
getters and lexicographically compares bytes; it does not use the public
incomplete Buffer.compare. The key filter excludes canonical array indices
and handles enumerable/symbol flags. Crypto key comparisons remain blocked
by the missing crypto key owner; false-only key brands do not establish
support for those types. Constructor/prototype semantics and potentially
side-effectful property reads follow the copied target algorithm, not a
promise that arbitrary proxies/getters are side-effect-free.

The async assertion path (`assert.js:587–620,727–761`) accepts real promises
or object then/catch pairs, awaits their settlement and distinguishes a
synchronous promise-function throw from a rejected result. Exception matching
supports constructor, RegExp, predicate, object and message overloads; Error
messages can be thrown unchanged. The no-exception sentinel is distinct from
throwing undefined. ifError stack augmentation still depends on actual engine
stack shape. These algorithms have real owners, but no current-host pass is
inferred from their source identity.

**V-029 — AssertionError is a partial replacement.** Adapter.js:126–153
supplies a custom Error subclass rather than target
`lib/internal/assert/assertion_error.js`. It stores actual/expected/operator,
ERR_ASSERTION, generatedMessage and diff, but `diff: 'full'` changes no output,
generated output is simple inspection concatenation, target diff/indentation/
color/truncation and custom inspection behavior are absent, and stackStartFn
is honored only when an engine captureStackTrace exists. Its assigned name
and other property descriptors must be compared with the target constructor,
not assumed correct from matching values. The adapter also substitutes six
TypeError constructors with generic inspected-argument messages. Thus the
shared validator/error machinery installed later does not fix assertion
validation diagnostics. The unavailable source-expression binding is an
unimplemented bridge; SpiderMonkey's different stack representation alone
does not prove source-expression recovery is impossible.

## Buffer: public algorithms, inherited behavior and storage

The final Buffer is the class at bootstrap 1151–1355, followed by numeric and
unpooled installers at 2818–2820, inspection initialization at 2603–2608,
native limits at 1358–1375 and Blob export at 6836. It is a Uint8Array subclass,
not the callable target wrapper. All initial methods must be assessed with
those later assignments. Numeric/BigInt methods and UInt/Uint aliases are
installed from selected unchanged `lib/internal/buffer.js` sections; those
sections exclude the native encoding bindings and transfer helpers. Numeric
offset/value bounds, endian conversion and float scratch arrays have actual
shared validators, Node error constructors and primordial owners. Endianness
is determined from a real typed-array representation. This is substantially
more than an export stub, but compilation/runtime behavior is unestablished.

`buffer-unpooled-adapter.js` selects target allocUnsafeSlow(size, alignment),
validation, padding and createUnsafeBuffer/alignedBuffer algorithms. Its
native owner `third_party/node-core/native-buffer.cpp:7–51` actually allocates
malloc-backed storage, transfers ownership to NewArrayBufferWithContents,
roots/reacquires backing objects across possible GC and computes address
alignment. It rejects unstable detached/resizable backing stores for that
private alignment operation. Allocation failure is an actual error; no
successful fake address or alignment is returned. Small allocations use a
real typed-array allocation. Public Buffer.from copying is a separate issue
from intentionally shared FastBuffer/backing-store construction.

**V-030 — Buffer overload and inherited-method gaps.** Besides V-013–V-017:

* Buffer.from(null) reads `value.type` after a broad typeof-object check;
  target conversion/valueOf/Symbol.toPrimitive/array-like and cross-realm
  ArrayBuffer branches are not implemented faithfully. Typed-array raw byte
  sharing is wrong for the copy/element-conversion overloads.
* Inherited TypedArray.fill performs numeric conversion, not Buffer's
  string/Buffer/encoding pattern fill. Inherited lastIndexOf exists but lacks
  Buffer string/Buffer searches. This is a semantic mismatch, not an absent
  property. swap16/32/64, copyBytesFrom, stringLength and parent/offset accessors
  have no later installation in the inspected source.
* Target indexOf/lastIndexOf/includes now have an end/encoding overload
  (`lib/buffer.js:1105–1187`); candidate indexOf/includes have only three
  parameters, simplistic forward loops and no negative-offset, numeric-byte,
  empty-search and encoding normalization parity. TypedArray.lastIndexOf
  cannot supply these overloads.
* concat/copy use whole-span TypedArray.set where Node truncates; compare
  accepts non-byte objects and normalizes slices differently. write ignores
  encoding and can cut a UTF-8 sequence at its byte limit; validation and
  return values are not equivalent to the target.
* slice/subarray share storage and restore Buffer.prototype, but species,
  user subclasses, coercion/receiver and returned identities need exact
  target controls. Public class methods are generally non-enumerable where
  target assignment-created methods are enumerable; wrapper names/lengths
  and the target's own Symbol.species getter are separate obligations.

**V-031 — allocation policy and process options.** The initial alloc and
allocUnsafe rely on Uint8Array coercion rather than Node size validation;
alloc ignores nonnumeric/nonstring fill and string encoding. A zeroed result
from allocUnsafe is not itself a violation: callers cannot require garbage
bytes. Missing poolSize/shared pool/mark-untransferable ownership and explicit
alignment on allocUnsafe are real gaps. The real unsafe native allocation
does not inspect --zero-fill-buffers; target zero-fill policy is consequently
not established by the selected allocator. Missing CLI activation cannot be
excused as the native allocator's engine limit.

**V-032 — remaining module exports/limits.** Buffer constants use actual
engine byte/string limits (native shell js.cpp:3535–3548), and their nested
properties are readonly enumerable/nonconfigurable. Truthful wasm32/engine
allocation ceilings are a concrete boundary, not evidence of native 64-bit
limits. transcode/isLatin1/resolveObjectURL/File remain absent; Blob exists but
depends on its partial web owner. isAscii/isUtf8 at bootstrap 5718–5772 use
actual intrinsic-branded raw byte spans, deliberately reject DataView and
check UTF-8 overlong/surrogate/max-code-point constraints. Target likewise
accepts TypedArray/raw buffers and rejects DataView. Detached/out-of-bounds/
shared/resizable span errors and intrinsic mutation resistance still need
exact controls, not fabricated success or a blanket unsupported exemption.

Buffer codecs V-014 affect fs/path strings, StringDecoder, streams, crypto,
compression and inspection. Base64 handling is also subject to WEB-010's
atob/btoa validation/coercion finding. Buffer.inspect uses copied target code
and captured hexSlice; INSPECT_MAX_BYTES accessors must retain target public
descriptor/mutation semantics through the module registration.

## util, inspection, type brands and errors

Bootstrap 2603–2792 builds util; 2816–2829 replaces promisify/deprecate/debuglog
and 3232–3236 installs cancellation getters. `util/types` is the same types
object. inherits sets the instance prototype and non-enumerable super_
without changing the constructor's static chain. callbackify preserves
original descriptors/this, increments length/changes name, and schedules
fulfillment or falsy-rejection wrapping through real process.nextTick.
Synchronous original throws and invalid .then behavior are not silently
converted to success. toUSVString uses string-template coercion and
toWellFormed. isDeepStrictEqual delegates all arguments to the reviewed
comparison; isPartialDeepStrictEqual delegates to partial comparison.

Shared promisify (`upstream/core-value-helpers.js:196–276`) recognizes the
global custom symbol, validates custom functions, preserves descriptors and
prototype, returns first success value or named multi-results and warns for a
promise-returning original. Actual module owners must supply custom argument
names (fs does, other partial owners may not). Shared deprecator preserves
construction/new.target and per-code warning state; debuglog uses pinned
wildcard/case/cache/enabled/callback behavior with process warning/stderr
dependencies. Earlier obsolete bootstrap helpers are not the final owners.

**V-033 — public util.deprecate options are miswired.** The public export is
the internal helper directly. Target `lib/util.js:587–589` unwraps fourth
argument `{modifyPrototype}` and passes it as the internal fifth parameter.
Candidate instead treats that options object as internal useEmitSync and
leaves modifyPrototype true. This can request unavailable synchronous-warning
dependencies and ignores the requested prototype policy. This is additional
to the documented warning/process-owner gaps. Missing _extend and legacy
_errnoException/_exceptionWithHostPort exports must also remain visible;
removed util predicates still exposed and isArray's missing DEP0044 wrapper
are DOC-007, not current target requirements to add those removed functions.

V-008's missing util helpers include portable parsers, MIMEType/MIMEParams and
their returned iterators, debounce/throttle control/state, diff, signal exit
conversion, terminal styling, error maps/messages and public
markPromiseAsHandled. The native handled-promise operation already exists in
the async bridge: its missing util wrapper is not missing engine capability.
MIME and parseArgs null-prototype results, tokens, strict/negative/positional
options, parseEnv quote/comment/multiline rules and debounce/throttle
cancel/flush/pending/signal/ref semantics require their real owners; throwing
or omitting their exports is not compatible support. Returned members and
exact target signatures remain in source requirements, not guessed module
own properties.

The inspection adapter supplies the full target inspect/format/
formatWithOptions/stripVTControlCharacters algorithm. Options, legacy
arguments, getters, max lengths, circular references, sorting, colors/styles,
numeric separators, custom inspection symbol and mutable defaultOptions have
actual code paths in `upstream/inspect.js:219–441,1083–1370,1932–2040,
2200–2570,2794–2908`. Native shell js.cpp:3129–3308 reads promise state/result,
scripted proxy target/handler including revocation, iterator table snapshots
without advancing, weak-collection keys and engine classes. It roots and
wraps values between realms, rather than scheduling promise reactions or
invoking user inspection properties to guess engine state.

**V-034 — inspection and call-site bridge limits.** ConstructorName uses
engine class names, not an asserted equivalent of V8 constructor inference;
custom prototypes, anonymous classes and realms need comparison. Iterator
CountSlot-based preview across deletion/compaction/GC is a specific unresolved
control. Adapter config.hasIntl=false selects Node's Unicode width fallback
even though the guest engine recipe enables ICU4X; emoji/combining sequences
and line wrapping may differ from the full-ICU target. This private terminal
width choice does not mean public Intl is disabled. Invalid option diagnostics
use simplified validators. getCallSites captures real SavedFrames and removes
two owned frames (`spidermonkey/node-compat/adapter.js:465–491`), but sourceMap
true throws ERR_NOT_IMPLEMENTED and default source-map activation is absent.
No accepted boundary permits inventing native script IDs/line data.

Intrinsic brands in adapter.js:1–61 use internal-slot getters or native hooks
for ArrayBuffer/SAB/views, typed arrays including Float16, boxed primitives,
Date/RegExp/Map/Set/weak collections, promises/errors/proxies, arguments,
functions/generators, iterators and module namespaces. `Error.isError` is the
actual engine native-error brand, not instanceof alone. No key/External
representation currently exists, so false-only KeyObject/CryptoKey/External
checks express a missing producer/FFI/crypto integration, not proof that these
types are supported. Cross-realm, revoked proxy, spoofed tag/prototype,
detached/resizable and mutable-intrinsic effects remain native controls.

**V-035 — error constructors are not error-delivery coverage.** The full
copied `internal/errors` table, validators, SystemError, AbortError,
NodeAggregateError and aggregation helpers have real primordial dependencies
through values-platform-adapter.js. NodeError message/name/code/constructor
and own-property semantics are implemented by their factories, with two
explicit build.py:132–144 guards that preserve engine stacks when V8 recapture
is absent. Public Error/TypeError/RangeError/etc. and cause/AggregateError use
the engine. Shared DOMException has a separate reviewed event/clone owner.
These are not public constructors exported by a fictional errors module.

However, UVException/DNS/errno helper paths lazily ask for uv.getErrorMap,
which explicitly throws ERR_NOT_IMPLEMENTED (`values-platform-adapter.js:95`).
The bootstrap _throwErrno and getSystemErrorName use a small hand-written
mapping (354–389,2781–2792); native kernel errno availability is broader.
Other legacy modules make ad hoc errors, assertion errors use another
constructor map, and missing networking/TLS/crypto/worker/loader/permission
operations cannot emit their required code/context/async error path just
because a copied factory exists. Codes, errno sign, syscall/path/dest,
address/port, callback vs throw vs rejection/event, multi-error cleanup and
cause are obligations of each owning family. The errors catalog therefore
retains every original code/section and its actual factory/use locations,
with unresolved trigger coverage explicit. A text occurrence is not a pass.

Error.stack/captureStackTrace/stackTraceLimit/prepareStackTrace, frame filtering,
source expressions and Node-specific formatting remain incomplete bridges.
V8-specific frame internals can require a deliberate documented boundary;
portable observable behavior is not waived by selecting SpiderMonkey.
OpenSSL/DNS/HTTP2-specific errors depend on those absent owners. Removed error
codes in target historical documentation are applicability/history questions,
not new public APIs to manufacture.

## Path, URL, encodings and internationalization

Path uses the exact target lexical algorithms through path-platform-adapter.js.
Both explicit POSIX/Windows objects, sep/delimiter, parse/format's dot extension
normalization, basename suffix, extname/dirname, join/normalize/isAbsolute,
relative/resolve, toNamespacedPath/_makeLong and matchesGlob have owners.
Windows algorithms distinguish UNC/device roots, drive-relative cwd, rooted
paths, separators, reserved device names and relative device comparisons.
The POSIX default toNamespacedPath identity matches the target; it does not
prove explicit win32 support is absent. The two objects' posix/win32 links and
module alias identities are selected at bootstrap 1637 and 6011–6012. Real cwd
and drive environment lookups depend on the reviewed process owner. Lexical
Windows parsing does not grant a Windows guest process identity.

matchesGlob uses the selected unchanged glob matching/cache/helpers and
target bundled minimatch; createMatcher uses actual guest isWindows/isMacOS,
while explicit win32/posix supply the requested separator branch. It does not
invoke filesystem traversal. Brace/extglob/class/dot/case/matchBase/root
options, invalid-input order and minimatch expansion limits have actual
owners in path-glob-matching.js/path-minimatch.js. These paths need later
native comparisons, particularly cwd failure and guest environment mutation.
No new source-proven lexical defect is asserted solely because upstream
algorithms have not been executed here.

The shared whatwg-url implementation has a genuine URL state machine:
special/opaque/file schemes, percent encoding/decoding, IPv4/IPv6, IDNA/TR46,
port/host/userinfo, mutation overrides, serialization and origin. URLImpl owns
the URL record and a live URLSearchParams list. Parameter operations preserve
duplicates and insertion order, stable name sorting and live href updates.
Generated WebIDL wrappers validate receivers, convert strings/iterables/
records, require argument counts, expose accessors/symbol iterator and perform
live forEach iteration. size and value-aware delete/has exist. parse returns
null after invalid parse; canParse returns a boolean after wrapper coercion.
This is not the earlier simplistic URL constructor, and shared public/global
constructor identity is intentional. WHATWG behavior still requires comparison
with the target Node wrapper and its errors/descriptors/custom inspection.

**V-036 — Node URL wrapper/ownership gaps.** Legacy parse/format/resolve are
the custom bootstrap 3288–3430 algorithms, not the target URL state machine.
String-coercing nonstring legacy inputs differs from target validation;
auth/host/IPv6, slashesDenoteHost, query dictionary, escaping and relative
resolution remain partial. Url class and resolveObject/urlToHttpOptions are
absent. IDNA public helpers remain V-005. fileURLToPath/pathToFileURL implement
POSIX cases but omit windows options and byte-preserving conversion V-006;
decodeURIComponent can expose URIError for bad bytes instead of Node's
required file-URL error. URL.createObjectURL/revokeObjectURL and buffer
resolveObjectURL have no owned thread-local Blob registry/revocation path.
URLPattern is absent in both global and module exposure (WEB-007). Node
ERR_INVALID_URL and input/base contextual properties are not supplied by
whatwg-url's generic TypeErrors. Supplying a browser host's URL would not fix
guest ownership or establish target compatibility.

TextEncoder/Decoder globals and util exports share the selected constructors.
Bootstrap 21–289 has actual UTF-8 surrogate handling/encodeInto counters and
incremental UTF-8/UTF-16LE/BE/windows-1252 decoder state, BOM/fatal/stream
processing; they are not identity codecs. Full target ICU encoding labels
and transcode remain missing. StringDecoder's mutable decoder/error/state
findings are recorded separately. Buffer encodings are a different API from
WHATWG Encoding (e.g. Latin-1 vs windows-1252) and cannot be fixed by aliasing
one public API to the other.

**V-037 — Intl capability and build-option correspondence.** The recipe
`build-spidermonkey.sh:291–292` explicitly enables Intl/ICU4X. The fallback
Intl block at bootstrap 6895 is conditional on Intl being absent and is not
evidence that the configured source candidate uses the simplistic fallback.
ECMA-402 constructors, locale/calendar/numbering-system/time-zone data and
String/Number/Date locale operations belong to that engine and its compiled
data. Node's documented full/system/small/no-ICU matrix (`doc/api/intl.md`)
also includes encoding, normalization, IDNA, RegExp Unicode properties and
REPL width; those owners differ here. Native Node ICU data injection options
cannot load ICU4X data without a real adapter. Exact ICU4X version/data/locale
coverage and public capability reporting remain an explicit source-artifact
question for later validation, not an accepted full-ICU equivalence or a
blanket Intl exclusion. No target/configuration pin was changed.

## Hosts, evidence, dependencies and open questions

All four hosts execute the same guest SpiderMonkey/bootstrap sources; the
outer Node/Chromium/Firefox/WebKit engine is not the engine implementing
guest util.types, Buffer, assertions, path or Intl. These pure value algorithms
have no source-inferred host specialization. Host differences enter through
guest argv/environment/cwd, filesystems/raw paths, resource and memory limits,
workers, network transport, console/terminal and scheduling. See the owning
family reports; a current four-host execution is still required to establish
equal results. No browser sandbox justifies missing pure-JS MIME/path/util/
assert/codec behavior.

The immutable historical index/archive in [existing-evidence.md](existing-evidence.md)
is the existing evidence source. Early common/index net-accessor failures
prevented most baseline files from reaching their module assertions. The
three historical baseline passes and selected old controls cannot establish
this unbuilt revision's values conformance, error messages, native hooks or
four-host parity. Exact descriptor capture proves the native reference shape
at its saved pin and platform, not candidate behavior or inherited/flag-enabled
completeness. Every candidate in the future validation catalog is unexecuted.

Dependency order: faithful shared bytes/encoding/Buffer coercion and ownership;
shared error/errno/stack bridge and module loading; public util/URL and returned
object owners; then callers' source-selected fs/streams/crypto/compression/
networking paths. Real key/External/worker/Blob-object-URL producers must
precede brand/clone/cross-thread validation. Preserve the separately scoped
Claude/npm/Bun remainder and do not add program-specific handling.

Unresolved audit questions are not silently passing contracts: exact target
descriptor/overload/error order in the above bindings; iterator GC/compaction
preview; ArrayBuffer shared/resizable/detached behavior; error trigger and
cleanup delivery in partial owners; ICU4X data correspondence; source-map and
expression extraction policy; target documentation/source differences and
removed/conditional APIs; fixture/resource/flag closure for later suites.
These have enough identified ownership to plan follow-up; none authorizes
implementation or new runtime validation during this audit.

The proposed next validation uses unchanged pinned assertion, buffer, util,
path, URL, string-decoder, querystring, punycode, error/encoding/Intl/WPT files,
plus native controls for aliases/descriptors/receiver errors, coercion side
effects, symbols, cycles, cancellation/nextTick/rejections, storage identity,
GC/transfer/alignment and exact errors. File catalogs are selection aids,
not case-count denominators or permission to run them. All four hosts must
retain pass/fail/skip/unsupported/timeout/harness-error accounting. Stop for
explicit authorization before executing this plan.
