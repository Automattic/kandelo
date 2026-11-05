# Node core compatibility target

Source122 adds pinned logical/native realpath, readlink and full glob traversal
using real POSIX byte results/queued requests and shared Dirent/stat owners.
The private URL-or-path converter now serves filesystem consumers. Sixteen new
and37 affected controls,16 portable byte/error comparisons and eight unchanged-
file runs pass in their explicit native-boundary scopes. Guest source117–122
is uncompiled; accepted116 is not current. All19 families remain partial;
overall suites/full product rebuild remain deferred. See
[path/traversal ownership](../../../tests/nodejs/outline/filesystem-traversal-implementation-dependencies.md).


Source121 installs the pinned shared warning owner and actual CLI option
source for filtering, trace/deprecation policy and redirect-file lifecycle.
Sixteen new frontend and47 affected controls pass; one known environment-clone
fixture nonpass remains. Four unchanged-file runs and14 portable parser
comparisons pass in their explicit native-boundary scopes. Guest source117–121
is uncompiled; accepted116 is not current. All19 families remain partial;
overall suites/full product rebuild remain deferred. See
[warning ownership and evidence](../../../tests/nodejs/outline/warning-implementation-dependencies.md).


Source120 adds real borrowed-stdin terminal mode leases, pinned mode/error
policy, actual window queries and transport/context/GC cleanup. Five native-
boundary frontend comparisons, four affected stream controls and one portable
PTY/native comparison pass in their recorded scopes. The guest binding and
117–119 source remain uncompiled; accepted116 is not current. Public TTY classes,
signals/drain and four-host conformance remain open. All 19 families are partial;
overall suites/full product rebuild remain deferred. See
[terminal ownership and evidence](../../../tests/nodejs/outline/terminal-mode-implementation-dependencies.md).

Earlier revision checkpoints below retain their historical scope.

Source revision119 adds pinned Module.wrap/wrapper owners and actual patched
script compilation, preserving the ordinary function compiler. The shared
invocation now snapshots exports once for receiver/argument identity. Eight
new and fourteen affected frontend controls pass; two unchanged upstream
fixtures pass in candidate/native modes. Guest compilation and four-host
conformance remain pending; accepted116 is not current for source117–119.
Earlier guest failures and all 19 incomplete families remain open. Overall
suites/full product rebuild remain deferred. See
[wrapper ownership and evidence](../../../tests/nodejs/outline/module-wrapper-implementation-dependencies.md).

Earlier revision checkpoints below retain their historical scope.

Source revision 118 adds pinned hard-link sync/callback/promise APIs over
actual libc operations, owned queued source/destination paths and shared
destination-error completion. Twelve frontend controls and one portable-owner
comparison pass within explicit native dependency boundaries. The new C++ and
source117 empty-input fix remain guest-uncompiled; accepted engine116 is not
current. Its earlier cipher failures remain open, with a bounded native-tag
investigation recorded separately. All 19 families remain incomplete; overall
suites and a full product rebuild remain deferred. See
[hard-link ownership and evidence](../../../tests/nodejs/outline/hardlink-implementation-dependencies.md).

Earlier revision checkpoints below retain their historical scope.

Source revision 117 supplies pinned Cipheriv/Decipheriv algorithms over actual
native ncrypto/OpenSSL contexts and fixes the empty-data versus null-control
boundary. The accepted targeted engine 116 compiles the preceding source and
passes artifact admission. Five Node-host guest comparisons record one pass
and four failures with escaping Wasm exceptions; these failures remain open.
The empty-input fix has portable-owner evidence but is guest-uncompiled.
All 19 families remain incomplete. Overall suites and a full product rebuild
remain deferred. See [cipher ownership, evidence and gaps](../../../tests/nodejs/outline/cipher-implementation-dependencies.md).

Earlier revision checkpoints below retain their historical scope.

Current integration checkpoint: the normal targeted engine96 build compiles
the source through95 with guest OpenSSL3.5.9; four focused Node-host
differential controls pass. Current source99 includes metadata97, sync whole-file98 and queued
promise write/append99 owners; these remain guest-uncompiled. Changed kernel/host
and complete four-host conformance remain outstanding. Recipe-stage
compilation statements below describe their historical checkpoints. See
[the current build and evidence record](../../../tests/nodejs/outline/engine96-integration.md).
Sync whole-file ownership: [source98 scope](../../../tests/nodejs/outline/file-sync-implementation-dependencies.md).
Promise write/append ownership: [source99 scope](../../../tests/nodejs/outline/file-promises-implementation-dependencies.md).

Recipe95 selects pinned callback writeFile/appendFile algorithms over actual
queued native pathname/byte/fd work and FSREQCALLBACK scope. Native/source
controls pass; the new guest C++ binding is uncompiled. Sync/path-promise file
jobs, full backing-store leases and four-host conformance remain open. See
[Callback file-write ownership](../../../tests/nodejs/outline/write-file-implementation-dependencies.md).

Recipe94 reuses the unchanged public SourceMap class for actual VLQ decoding,
indexed mappings, payload and position queries on the real Module namespace.
Focused native/source controls pass; loader capture/cache/support/stack
integration and four-host guest conformance remain open. See
[SourceMap ownership](../../../tests/nodejs/outline/source-map-implementation-dependencies.md).

Recipe93 adds pinned Performance/user/resource/timerify classes and real shared
timeline/observer buffers over existing clock/clone/EventTarget owners. The
zero-statistics event-loop histogram facade is removed. Focused controls pass;
upstream adapted files record7pass/1fail at the missing milestone provider.
Native metrics/histograms, guest integration and four-host conformance remain
open. See [Performance timeline ownership](../../../tests/nodejs/outline/performance-timeline-implementation-dependencies.md).

Recipe92 adds the unchanged pinned public Argon2 module over actual native
OpenSSL3.5.9 algorithm/configuration, shared KDF work and ARGON2REQUEST source
owners. Native derivation/errors, frontend and affected/upstream controls
pass. Guest compilation and four-host conformance remain outstanding; the
accepted engine is still88. See [Argon2 ownership](../../../tests/nodejs/outline/argon2-implementation-dependencies.md).

Recipe91 adds pinned pathname metadata wrappers, actual POSIX sync/queued
source owners and shared filesystem error construction. Kernel/host source
now selects the link inode for nofollow timestamps. Focused native/source
controls pass; guest engine/kernel Wasm compilation and four-host conformance
remain unestablished. OPFS metadata mutation now fails ENOTSUP rather than
silently succeeding; persistent metadata remains an implementation gap. See
[path metadata source and evidence](../../../tests/nodejs/outline/path-metadata-implementation-dependencies.md).

`target.json` pins **Node.js 26.13.0 (Lithium LTS)** as the API target,
its upstream source tag/commit/archive and native oracle archives. It is
independent of the host/build toolchain (currently Node 24). The normal
SpiderMonkey package generator embeds this same pin in the shared
bootstrap and C CLI version string, preventing separate version
constants from drifting.

The [current capability reconciliation](../../../tests/nodejs/outline/current-capability-reconciliation.md)
records source routes and remaining requirements for all 19 families.
Every family is partial. Preset process accounting, report loaded-object
data and heap statistics were removed; complete measured providers remain
implementation gaps. Real DNS channel/record owners now exist in source,
but full guest/host lifecycle conformance remains open. None of these gaps
is an accepted platform exclusion.
Historical product results do not validate the current combined candidate.

The compatibility goal is public Node 26 LTS APIs on the Node host,
Chromium, Firefox and WebKit, with explicit engine and platform limits.
The implementation remains partial; that goal does not turn missing
behavior into supported behavior.

The source slice at recipe89 selects the unchanged pinned process
finalization registry, public lazy descriptor and ref/unref dispatch. Real
guest events and WeakRef/FinalizationRegistry own their lifetimes. Focused
native-dependency evidence is recorded in
[process lifetime ownership](../../../tests/nodejs/outline/process-lifetime-implementation-dependencies.md).
The last accepted engine88 does not include this source slice; guest and
four-host conformance remain unestablished. Overall suites and the full
product rebuild remain deferred.

Source recipe90 selects the unchanged public PBKDF2/scrypt algorithms and
actual native sync/queued derivation owners. The shared OpenSSL source pin
is now3.5.9, matching the audited reference; only a native control library
was built. The guest dependency and new engine source remain uncompiled.
Exact evidence, earlier nonpasses and remaining crypto gaps are in
[KDF ownership](../../../tests/nodejs/outline/kdf-implementation-dependencies.md).

The guest engine remains SpiderMonkey 140.11.0 ESR. It reports `wasm32`
and `kandelo`, including through `os.platform()`. It provides no native
Node addon ABI, V8 or libuv implementation, so `process.versions` does
not advertise versions for them. Changing the API target does not enable
their flags or promise their behavior. Products built before these
changes must be rebuilt before the new identity or source fixes are
observable. The validation below uses the normal shell product; other
application images are outside this audit.

## Broad implementation pass

The post-audit [breadth-first implementation ledger](../../../tests/nodejs/outline/breadth-first-implementation.md)
tracks the newly authorized source pass before overall tests. Focused
checks are allowed; full product rebuilds remain deferred. Its public util
slice selects the pinned public deprecate options wrapper, _extend/isArray
deprecation wrappers, signal conversion and genuine-promise handling through
the existing native bridge. Removed legacy util predicates are no longer
exposed. These source changes do not establish current four-host product
conformance; the module still has substantial audited gaps.

The next source slice preserves ChildProcess.kill zero probes and native
failure policy and destroys stdin through its existing stream owner before
the exit event. Focused shared-source/native-policy controls pass; actual
guest signal delivery, descriptor cleanup and the broader child/process
contracts remain unverified or incomplete on all four hosts.

The subsequent source slices install pinned Buffer conversion/copy/compare/
concat/swap algorithms over actual typed byte storage, correct CommonJS
wrapper receivers/cache rollback and JSON BOM/error handling, and restrict
rmSync force suppression to missing paths. Focused source/native controls
cover these changes. Buffer string codecs/pools/transfer, complete JSON/ESM
module ownership and filesystem retry/native unlink-rmdir distinctions
remain incomplete; no current four-host product conformance is claimed.

The diagnostics slice replaces the inert public facade with the unchanged
pinned channel, store-scope and tracing algorithms. A shared JavaScript
producer registry connects actual console calls and TCP socket attempts/
acceptance to subscriber state. Focused native-reference controls cover
these source paths. Other documented producers, native producer bridging,
domain, guest fatal policy and complete Console behavior remain open;
four-host product conformance is still unestablished.

File now selects the unchanged pinned class over the shared Blob byte owner,
with global/buffer constructor identity and actual metadata/clone payloads.
FormData selects the target's Undici entry, WebIDL and live-iterator owners,
including actual clone refusal. Raw shared buffers copy into Blob/File
storage. Thirteen focused source/native controls pass for these paths;
complete Blob conversion/storage/clone behavior, multipart/Fetch consumers,
global descriptors and four-host product conformance remain open.

The crypto slice supplies pinned synchronous fill/typed-array/quota and
public WebIDL forwarding contracts over the actual guest entropy path.
The common host entropy owner chunks provider calls and fails without a
secure provider. Async random work, digests/keys/algorithms and complete
WebCrypto remain open. Cursor helpers and transactional Readline now use
the pinned write/queue owners; isatty validates fds before native lookup.
Callback/promise Interface/createInterface now select retained shared input,
question, editing/history and lifecycle source. Actual TTY/stdio/raw/resize,
width, persistent history and REPL ownership remain incomplete. Scoped
controls do not establish current four-host guest conformance.

The HTTP slice shares pinned outgoing header state/validation/query and field
serialization between actual HTTP/HTTPS requests, with real compiled-header
mutation errors, method/path checks and complete status-code constants.
Request headers use the corrected shared Buffer single-byte encoder and
Latin-1 wire bytes; acquiring a connection alone no longer flushes headers.
Fourteen focused HTTP/Buffer controls pass, including a native loopback wire
comparison. Full framing/parser/Agent/server/HTTP2, array-form constructor
headers, TLS pooling/trust and full lifecycle/metadata remain open; this is
not current four-host product conformance.

The TLS identity slice replaces the public always-successful checker with
the pinned hostname/SAN/CN/wildcard/error algorithm. Shared domain helpers
now perform special-host parsing and IDNA conversion, and `net` shares the
pinned IP grammar with the certificate canonicalizer. The vendored URL
backend applies the target's non-strict ASCII rule and preserves rejected
Unicode A-labels independently. Fourteen focused source/native controls
pass, including unchanged upstream TLS/IP assertions and existing URL/exit
regressions. Remaining IDNA table/validation/size boundaries need complete
coverage; native TLS chain verification remains a separate existing path.
Identity callbacks during handshake, actual certificates/authorization and
protocol metadata, contexts/servers, shutdown/cancellation, DTLS/QUIC and
four-host guest conformance remain open. No full rebuild ran.

The post-audit compression pass records source corrections for native integer
conversion and optional initialization error callbacks. Five isolated
source/native controls pass with the exact Node reference backend; they do
not compile or execute Kandelo's C++ codec handles. Shared/resizable backing
stores, lease/transfer/resize behavior, actual native completion/cancellation,
accounting and four-host guest validation remain open.

The VM source candidate now uses pinned public validation/dispatch with a
private sandbox-to-realm association, preserving sandbox identity and
idempotence. Compiled Stencils remain private. A new native function compiler
uses the engine compiler and live context-extension scopes; patch 54 also
passes script column offsets and inherits actual caller shared-memory policy.
Six frontend controls pass over the native Node VM backend, including unchanged
context-brand assertions; they do not execute the uncompiled guest compiler or
realm hooks. Context property forwarding, deadlines, caches, imports,
per-context microtasks, uncontextified globals, memory/metadata and VM modules
remain open. Native-reference abort observations are retained separately.

The [core implementation outline](../../../tests/nodejs/outline/README.md)
tracks module families, shared prerequisites and per-host review obligations.
The earlier source pass in its implementation ledger remains unverified
where no later evidence is recorded. Previously built products and
selected coverage checkpoints do not validate those later edits.

## Coverage audit

The implementation is partial. Its builtins and globals include working
operations mixed with incomplete behavior and, in older APIs,
placeholders. Export presence is not implementation coverage. In
particular:

- Filesystem, process, Buffer and URL regressions have targeted source
  and guest fixtures. Windows file URL options, legacy URL helpers and
  complete filesystem argument/error validation remain incomplete.

- Positioned reads/writes now use libc pread/pwrite without changing the
  shared descriptor cursor. Read positions retain exact signed-64-bit
  bigint values, and read/write options follow the pinned Node target.
  Source differentials and the shared Node/Chromium/Firefox/WebKit
  regressions pass. Shared-buffer filesystem I/O, full async I/O
  scheduling and exact argument messages remain gaps.

- The shared source has streaming UTF-8/UTF-16 decoding, Windows-1252,
  BOM/fatal handling, complete UTF-8 encodeInto writes, and
  Node-specific StringDecoder buffering/flush behavior. Source/native
  comparisons and the shared four-host regressions pass. Other legacy
  TextDecoder charsets and custom inspection remain gaps. Buffer's
  non-UTF8 encoding APIs are still partial.

- Response bodies now use actual stream disturbance/lock state, reject
  repeated consumption, clone streams with independent bytes and forward
  cancellation/errors. Blob byte storage, slices and byte/text streams
  are implemented. Source differential/FileAPI checks and rebuilt guest
  regressions pass on the Node host and all three browser engines.
  Complete MIME parsing, formData, Request bodies, Headers guards and
  Web-object cloning/transfer remain gaps.

- TCP servers now bind/listen/accept through real nonblocking POSIX
  sockets. Server closure waits for accepted descriptors; Socket.end uses
  actual write-half shutdown. Native watch reference state drives listener
  and socket lifetime. Eight focused cases pass on each host, including an
  independent C client over IPv4 and IPv6. The accept path compares live
  connection counts with maxConnections before constructing a Socket. It
  drops excess descriptors, including at zero capacity, with real endpoint
  records. Three unchanged upstream limit/drop files pass on all four
  hosts. Cluster distribution and dropMaxConnection are not supplied.
  Callable constructors, complete listen overloads/descriptors, IPC/fd
  listeners, BlockList, socket controls and full stream behavior remain gaps.

- Streams, Fetch networking and process lifecycle need broader upstream
  coverage. Shared natural exit now has a shell teardown hook for files and eval,
  including queued work and fatal status. File/eval/ESM regressions pass
  on the Node host and all three browser engines. Default fatal exceptions
  now stop live timer/I/O work, unhandled rejections are checked after the
  microtask checkpoint, and timer/ESM failures retain their thrown values.
  Ten-program rebuilt regressions pass on all four hosts, including live
  child I/O and nonfatal controls. Throwing exit listeners now preserve
  the actual validated status, including zero and explicit exits, and
  already-fatal exits retain the original diagnostic. Seventeen additional
  programs pass on all four hosts against exact native controls.
  beforeExit, custom uncaughtException/unhandledRejection policy and
  complete timer ordering remain gaps.

- Timers use a private monotonic deadline scheduler with independent
  reference counts, cancellable handles, interval self-cancellation and
  refresh after firing. Unreferenced callbacks remain eligible during live
  work. Immediate batches defer newly queued callbacks and permit
  microtask checkpoints between callbacks. Promise timers implement
  signal/ref options, interval iterators and scheduler wait/yield; custom
  promisification selects these APIs. Duration normalization emits real
  asynchronous process warnings. Fourteen named programs pass on all four
  hosts; the unchanged 64-file follow-up is still partial (39 pass, nine
  fail, 15 unsupported, one timeout on each host). The broader WebKit
  spawn/PATH fixture had an ENOMEM failure; a fresh unchanged replay passed
  but its cause remains open. Complete nextTick/phase ordering, async
  hooks/context propagation, warning stack/CLI policy and abort-listener
  resistance to stopImmediatePropagation still need conformance work.

- CommonJS entries publish their module identity before children execute.
  Explicit ESM entries use the native parser/linker and module graph, with
  cycles and top-level await. Wrapped CommonJS scripts register their
  reference path for relative import(). File mains return to the owning
  job/timer/I/O loop. A stalled module graph exits 13 when no nonzero status
  was assigned. Its native diagnostic text remains incomplete. Ambiguous
  `.js` format detection, static CommonJS named-export discovery, complete
  URL/query identities and package exports/conditions remain partial.

- `util.getCallSites()` reads the engine's saved-frame records, retaining
  actual source identities, function names and source coordinates. It
  validates the 1-to-200 frame limit and options, returns mutable records
  with null prototypes, and ignores Error stack formatting hooks and
  stackTraceLimit. CommonJS wrapper origins preserve original user lines;
  ESM source names use module URLs. scriptId contains a SpiderMonkey source
  ID; Inspector/CDP integration remains unavailable. Source-map remapping
  reports an explicit unimplemented error. Complete validation error text
  and source-map support remain gaps.

- Assertion and deep-comparison source uses the pinned Node algorithms,
  including error matchers, strict aliases, Maps/Sets and cycle
  detection. Source differentials and rebuilt four-host brand/mismatch
  checks pass. Assertion diagnostics remain partial (diffs, stacks,
  inspection and source expressions). See
  `third_party/node-core/README.md`. The upstream harness continues to
  require its adversarial assertion readiness check before recording
  guest baseline counts.

- TCP client dialing validates and snapshots the family-selection defaults
  (enabled, 500 ms; setters clamp positive values below 10 ms). It resolves
  actual addresses, alternates deduplicated families, applies deadlines to
  intermediate attempts, and cancels the native connect by operation
  identity. Failed and cancelled attempts close their descriptors; late
  successes are closed. TLS uses this same TCP dialing policy. Endpoint
  properties come from getsockname/getpeername, including local binding.
  Socket timeout/keepalive controls, complete stream semantics, BlockList
  and TLS handshake cancellation remain incomplete.

- `dns.lookup` and its promise form use libc getaddrinfo, with literal IP,
  family/all/order options and asynchronous delivery. The current libc
  hostname resolver supplies one IPv4 answer, does not provide full
  hosts-file or IPv6 hostname resolution, and performs a blocking lookup.
  These are fixable resolver gaps, separate from the transport's current
  IPv6 loopback-only boundary. Custom lookup records are supported without
  supplying invented DNS answers in the harness. Other DNS record APIs
  remain incomplete or placeholders.

- Node-mode initialization removes the embedding's shell utilities after
  capturing the private functions used for I/O, workers and shutdown.
  Public globals use the pinned Node bootstrap's enumerability and
  replacement descriptors. File-module bindings stay in their wrappers;
  eval retains its global bindings. Module-loader and event-loop bridges
  remain non-enumerable embedding properties. This does not establish
  identical own-property inventories or complete Web API behavior.

- Several DNS, crypto/TLS, worker, performance and browser globals
  remain partial or placeholders. They must not be treated as supported
  solely because the names export. The DNS record-resolution placeholders,
  crypto stubs remain compatibility gaps. The unbuilt source candidate
  replaces JSON-only structuredClone with native graph serialization and
  DOMException/QuotaExceededError/Blob payload hooks; host-handle transfer
  and channel transport remain gaps. This candidate is unverified on every
  host; see `tests/nodejs/outline/host-clone-source-status.json`.

- The unbuilt source candidate also wires the pinned `stream/iter` entry
  and experimental activation through the guest CLI/environment and shared
  CJS/ESM builtin exposure policy. `process.getBuiltinModule` uses that same
  policy. Only iterator/warning boolean options are implemented in
  `NODE_OPTIONS`; other options fail explicitly. `zlib/iter` now has
  a private native handle binding in source. None of these paths has runtime conformance
  evidence; see `tests/nodejs/outline/stream-iter-source-status.json`.

- The unbuilt compression source candidate includes exact Node-vendored
  codec libraries, native handles, actual pthread work, stable buffer leases
  and handle-owned async IDs/frame/callback/finalization paths. Pinned public
  zlib/ZIP and iterator algorithms use those handles in source. Buffer numeric
  algorithms are pinned; maximum-length metadata comes from the guest engine.
  Filesystem/Buffer dependencies, complete resource/error/ordering/accounting
  parity and shared/resizable/external leases remain incomplete. No compiler
  or runtime evidence establishes support.
  See `tests/nodejs/outline/public-codec-source-status.json`.

- Pinned truncation functions now use actual guest libc/kernel descriptor
  truncation in the unbuilt source candidate. Callback truncation owns a
  native FS request and guest work-pool completion. FileHandle/stream/open/
  close behavior remains incomplete; no runtime evidence establishes support.
  See `tests/nodejs/outline/fs-truncate-source-status.json`.

- The unbuilt source candidate routes pinned public close callbacks through
  native filesystem work and adds a native descriptor owner/close/GC backend.
  The next source increment replaces the legacy class with pinned FileHandle
  refs/close/methods, native promise descriptor I/O and pinned filesystem
  streams. Stat conversion uses actual guest metadata and pinned Stats;
  descriptor chmod/chown/timestamps perform actual syscalls. Constants and
  unpooled Buffer allocation use real guest SDK/engine state. Transfer,
  iterators/readLines, pathname fast jobs and remaining callback/lifetime/
  Buffer behavior remain incomplete. No compilation/runtime evidence claims
  working support. See `tests/nodejs/outline/fs-promise-source-status.json`.

- Native addons, V8 internals, inspector flags and nested guest Wasm
  compilation are not supplied by this embedding. Tests requiring them
  need explicit results, not fake flags or an emulated platform
  identity.

The vendored WHATWG URL, IDNA and Web Streams packages retain
independent integrity pins. They are not versions of Node core and are
not upgraded just to make their numbers match the API target.

See [the upstream suite](../../../tests/nodejs/README.md) for exact
inputs, commands, outcome accounting and current validation limits. ABI
and memory budgets are unchanged by the target pin and JavaScript core
fixes.


The current source candidate also connects pinned callback and synchronous
open/read/write/vector/metadata methods to actual guest native I/O. Queued
request cancellation preserves normal completion and running-work ownership.
Shared pinned util.promisify uses the filesystem multi-result metadata. These
changes remain unbuilt and runtime-unverified; path file jobs and full API
coverage are unfinished. See `tests/nodejs/outline/fs-callback-source-status.json`.

Pinned callback and promise readFile now use an actual native pathname job and
chunked read context in the source candidate. The worker owns its allocation
and fd until Buffer/result preparation or descriptor handoff. Native open paths
use the real close-on-exec flag. No compiled/runtime evidence validates this
integration. Write-file/backing-store lease and remaining filesystem/core gaps
stay open; see `tests/nodejs/outline/fs-readfile-source-status.json`.

## Buffer codec source candidate

The shared guest bootstrap selects real UTF-8/ASCII/Latin-1/UTF-16LE/hex/
base64/base64url codecs and pinned public dispatch for Buffer string/length/
fill/write/search operations. Focused JS/native-reference controls and three
unchanged upstream public files cover this source slice. No new guest engine
or product artifact was built. Pool/transfer, callable constructor, allocation
flags, backing-store edges and remaining exports stay open; fromStringFast
uses the existing unpooled allocator. See the Buffer codec dependency record
under tests/nodejs/outline. No four-host runtime conformance is inferred.

## SQLite source candidate

The shared SQLite factory now routes Database/Statement operations through
real connection/statement owners, with the target aliases, typed values,
named bindings and transaction/close state. The proposed native bridge links
SQLite 3.54.0 from the exact Node source pin and reports its actual version.
Native-host core and frontend controls are scoped evidence only; the guest
bridge and all four hosts remain unvalidated. Sessions, callback/iterator
owners, backup, extensions, limits, tag stores and remaining public APIs
are explicit gaps. See tests/nodejs/outline/sqlite-implementation-dependencies.md.

## Stdio stream source candidate

Process stdio now delegates byte/queue/lifecycle work to shared pinned
Readable/Writable state machines over actual native fd operations. Output
callbacks follow native write completion; input uses real buffering, EOF,
pause cancellation, ref state and disposal. Stdout/stderr retain the target
process destroy policy without closing the borrowed descriptors. Missing
terminal mode operations fail explicitly. These changes remain unbuilt in
the guest: native-backend controls do not establish exact Socket/TTY/file
subclass behavior, guest fd ownership, complete termios/signals or four-host
conformance. The implementation outline retains those gaps.

## Local messaging source candidate

The proposed native port queue now backs shared MessagePort/MessageChannel
constructors and pinned Node worker-IO/event algorithms. Global, module,
stream and WebIDL routes share those identities. Serialized graph packets,
ref/start/close state and deferred close observation have actual owners;
full pinned Undici MessageEvent/CloseEvent/ErrorEvent replace partial event
records. A missing native-only constructor error was fixed against the exact
Node error definitions, retaining the failing assertion and evidence.

The old disconnected adapter ports are removed. Worker.terminate no longer
joins all shell workers and fabricates a successful exit: it explicitly rejects
until per-worker stop/join/status ownership exists. The existing partial Worker
launcher/online/bootstrap/environment path is still incomplete. Port transfer,
context moves, broadcast groups, full workers and four-host conformance remain
gaps. Native queue and frontend controls do not compile the guest bridge.

## Partial testing namespace and monotonic clock source

node:test now has pinned standalone mock/virtual-timer owners and snapshot/
assert configuration; node:test/reporters has actual formatting/stream owners.
Test execution, hooks, contexts and run deliberately reject: no callback is
executed and no passing result is fabricated. Complete runner/CLI/isolation,
automatic cleanup, module mocks, snapshots, coverage and benchmarks remain
implementation work. Namespace availability is not framework compatibility.

The new process clock route uses exact pinned hrtime tuple/borrow/validation
algorithms over an actual CLOCK_MONOTONIC nanosecond binding. Mocking Date can
no longer be the source of hrtime readings in this source route. Its POSIX
helper is checked on the native host; the proposed guest engine hook and
all four hosts remain uncompiled/unvalidated. process.uptime/performance and
other process/measurement owners still need their own reconciliation.

## MIME value source

Public util.MIMEType and util.MIMEParams now use the unchanged pinned
internal/mime.js through the shared values loader. Actual parsing, parameter
storage/mutation/iteration, receiver brands, coercion and serialization
replace their absence. Two unchanged upstream MIME tests pass over this
candidate and separately under the exact native Node reference; focused
public-util controls also pass. These are source algorithms over native
engine/error dependencies, not built guest or four-host conformance.

## Process state source

The current candidate routes environment reads, mutation, deletion and
enumeration to one native libc owner. It removes the seed/cache/no-op
mutation path, fixed parent PID and fixed creation mask. Public mask
validation uses unchanged pinned wrappers; actual parent and previous-mask
values come from libc/kernel state. Existing child snapshots can now see
unread inherited keys through real enumeration. Native helper and focused
unchanged-upstream/frontend controls pass, but the engine bridge is unbuilt.
Worker environments, timezone refresh, exact environment exotic metadata,
warning/trace/CLI policy, full process lifecycle and four-host conformance
remain open. See the process-state dependency record in the core outline.


## DNS source prerequisites

The new lookup work owner runs actual guest libc getaddrinfo through the
native pool and settles its Promise on the owning JS thread. The pinned lookup and lookupService callback/promise frontends now use
actual request primitives; complete name-service, callback-scope/provider,
CLI and worker policy still require implementation and guest validation. OS routing addresses are not public DNS record answers.
resolve now explicitly fails instead of fabricating loopback success.

The exact Node-vendored c-ares component has an isolated target recipe and
raw native channel/query/configuration/cancellation/copy-lifetime owner.
Native loopback DNS controls match pinned Node A/TTL output, but the public
Resolver/record bridge and guest artifact validation remain open. The
backend is not prematurely advertised in process.versions or linked as a
working public API. See the DNS dependency record in the core outline.


## Shared system-error data

The current util name/map/message source and numeric DNS/UV exceptions now
use a complete pinned error-data table compiled against guest libc errno
values. Private EAI constants preserve numeric DNS error fields; returned
public maps and entries are independent from the private cache. Native-host
table comparison matches 85 native entries, and thirteen focused frontend/
error controls pass. The guest table/bridge and full error-delivery/stack/
integer-edge behavior still need validation; no libuv runtime version or
ABI is advertised. Complete public DNS request/Resolver contracts remain open.

Private native request primitives now exist for both OS lookup directions,
with real request/provider/lifetime ownership and shared numeric EAI mapping.
The reverse helper matches native Node for loopback hostname/service and
native AI_* values. Public DNS now uses pinned callback/promise lookup/lookupService source,
raw UTS46 and actual DNS observation; complete native callback scopes and
returned-object/CLI/worker contracts remain implementation work.
The new engine bridge is uncompiled, and no four-host claim follows from
this native-host helper. See the DNS dependency record for the full scope.


The performance builtin/global now share a genuine monotonic process-origin
clock and DNS observer/entry/list owner. Only installed DNS producers are
advertised; other target entry types and full Performance/EventTarget/
user-timing support remain gaps. mark/measure explicitly fail. Patch 62
stages the process-origin clock and remains uncompiled. Native clock/IDNA,
frontend/socket and unchanged upstream controls do not establish guest or
four-host conformance; see the current DNS/performance dependency records.

The native DNS/filesystem/codec candidate now shares callback depth/context
and an owning tick/job checkpoint before successful outermost retirement.
Actual JS entries guard nested synchronous callbacks without fake resources.
A compiled policy matches native Node-API/libuv controls; the engine adapter
is uncompiled. Complete error/rejection/GC/realm/phase and four-host evidence
remain open in the callback-scope dependency record.

## Directory source candidate

Pinned sync/callback/promise mkdir/unlink/rmdir wrappers select distinct
native guest POSIX operations. Recursive mkdir tracks the first directory
created, preserves existing-file errors and mode zero, and bounds repeated
missing-parent attempts. Portable native and JS frontend controls are scoped
separately; the combined guest engine/JSAPI remains uncompiled. rmSync now uses
distinct primitives, while removal retries/traversal, raw directories, metadata,
VFS/permission activation and lifecycle coverage remain unfinished. No current
Node/Chromium/Firefox/WebKit conformance follows from these source controls.

## CommonJS record source candidate

The ordinary CJS/JSON loader uses actual Module instances and public cache/
extension/parent-child ownership, with pinned require/createRequire/lookup/
load algorithms. Safe global search paths consume real credential/libc-guarded
HOME/NODE_PATH. Failed compilation removes the cache/child link; builtin-prefix
and public override behavior use actual loading state. The separate Bun asset
branch remains retained. Source/native-reference controls do not validate the
uncompiled guest secure-environment/loader integration. Package/ESM/hook/CLI/
TS/preload/addon and remaining diagnostic/realm/lifecycle obligations stay open;
see tests/nodejs/outline/module-record-implementation-dependencies.md.

## Child outcome source candidate

ChildProcess source now shares real spawn/status metadata, once-only close/
callback delivery, failed stdio retirement and exact live wait-token ref/unref.
The native exact-pid owner retains real results across failed JS delivery,
retries EINTR and preserves errors instead of fabricating ECHILD exit zero.
Scoped native POSIX/helper and frontend/native-reference controls pass. The
engine integration remains uncompiled and four-host conformance unestablished.
Exceptional wait error/close behavior still differs from pinned libuv; it is
an implementation gap. Full child constructor/normalization/stdio/IPC and
lifecycle contracts remain in the child-wait dependency record.

## Dotenv source candidate

util.parseEnv uses the retained exact native parser through its pinned public
validator; process.loadEnvFile uses actual guest file/environment ownership
and its pinned path wrapper. Existing values, including empty strings, win.
Compiled portable/parser and focused native-reference controls are scoped
source evidence, not guest conformance. CLI env-file/permission/worker/startup
policy, close-failure behavior and engine integration remain open; see the
dotenv dependency record. No four-host runtime support claim follows.

## Digest source candidate

Pinned one-shot hash validation selects real provider-backed digest/XOF and
byte-comparison owners. getHashes derives actual backend names; comparison
uses CRYPTO_memcmp without JS coercion/XOR. Scoped portable/frontend/native
and unchanged upstream controls pass, while the engine bridge remains
uncompiled. Incremental Hash/Hmac classes/streams, keys/async/FIPS/WebCrypto
and full byte/error/GC/realm policies remain open; no guest/four-host claim
follows. See the digest implementation dependency record.


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

The partial live TLS metadata source owner and its explicit remaining
requirements are tracked in [TLS state dependencies](../../../tests/nodejs/outline/tls-state-implementation-dependencies.md). No family or four-host conformance is established by that slice.

The partial public Buffer constructor and shared native pool source are now
compiled in targeted engine70. Actual storage alignment, permanent detach
restriction and private native zero-fill option state have distinct owners;
guest runtime/four-host conformance and remaining requirements are recorded
in [Buffer pool dependencies](../../../tests/nodejs/outline/buffer-pool-implementation-dependencies.md).

[Shared package policy](../../../tests/nodejs/outline/package-policy-implementation-dependencies.md) now connects actual exports/imports/maps/
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

The source104 HTTP response candidate replaces handwritten string framing
with the exact Node-vendored llhttp backend and pinned IncomingMessage
callbacks. Strict/insecure/relaxed parsing, header limits, interim responses,
HEAD and CONNECT/upgrade head ownership are routed through that state. Agent,
server/HTTP2, outgoing framing and complete socket/response ownership remain
partial; identified-artifact guest/four-host validation is still outstanding.
