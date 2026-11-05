# Breadth-first implementation after the core audit

Source revision 118 adds pinned hard-link sync/callback/promise APIs over
actual libc operations, owned queued source/destination paths and shared
destination-error completion. Twelve frontend controls and one portable-owner
comparison pass within explicit native dependency boundaries. The new C++ and
source117 empty-input fix remain guest-uncompiled; accepted engine116 is not
current. Its earlier cipher failures remain open, with a bounded native-tag
investigation recorded separately. All 19 families remain incomplete; overall
suites and a full product rebuild remain deferred. See
[hard-link ownership and evidence](hardlink-implementation-dependencies.md).

Earlier revision checkpoints below retain their historical scope.

Source revision 117 supplies pinned Cipheriv/Decipheriv algorithms over actual
native ncrypto/OpenSSL contexts and fixes the empty-data versus null-control
boundary. The accepted targeted engine 116 compiles the preceding source and
passes artifact admission. Five Node-host guest comparisons record one pass
and four failures with escaping Wasm exceptions; these failures remain open.
The empty-input fix has portable-owner evidence but is guest-uncompiled.
All 19 families remain incomplete. Overall suites and a full product rebuild
remain deferred. See [cipher ownership, evidence and gaps](cipher-implementation-dependencies.md).

Earlier revision checkpoints below retain their historical scope.

Revision 115 compiles real named broadcast groups and owned shared engine
message storage, including revision 114 temporary-directory owners. Normal
artifact admission succeeds; four same-source exact-native/Node-host guest
controls pass, including a real worker exchange and temporary-dir disposal.
Four-host and whole-family conformance remain unestablished; all 19 families
are incomplete and overall suites/full product rebuild remain deferred. See
[broadcast ownership and scoped evidence](broadcast-implementation-dependencies.md).


Earlier source revision 114 adds pinned temporary-directory and disposal APIs over
real libc creation, native FS requests and existing removal owners. Seven
new frontend controls, twelve affected controls, nine portable native-owner
scenarios and four unchanged upstream files pass within their documented
control boundaries. The changed guest source is uncompiled; accepted engine
113 is not current for this candidate. All 19 families remain incomplete,
and overall suites/full product rebuild remain deferred. See
[temporary-directory ownership and evidence](tempdir-implementation-dependencies.md).


Earlier source/accepted engine113 and [SQLite callback ownership](sqlite-callback-implementation-dependencies.md)
are tracked in implementation-state.json. Scoped comparisons record3pass/6fail;
all19families remain partial and overall suites/full product rebuild remain
deferred. Earlier source checkpoints below retain their exact scope.

The earlier source112 and accepted112artifact are tracked in
[the implementation outline](README.md) and implementation-state.json.
The [URL/path slice](url-path-implementation-dependencies.md) is included
in112but lacks focused guest helper evidence. The
[compression storage slice](compression-storage-implementation-dependencies.md)
records3pass/4preserved platform-metadata comparison failures. All19families remain partial; overall suites/full product
rebuild remain deferred. Earlier checkpoints below retain their exact scope.

Historical integration checkpoint: the normal targeted engine96 build compiles
the source through95 with guest OpenSSL3.5.9; four focused Node-host
differential controls pass. Current source99 includes metadata97, sync whole-file98 and queued
promise write/append99 owners; these remain guest-uncompiled. Changed kernel/host
and complete four-host conformance remain outstanding. Recipe-stage
compilation statements below describe their historical checkpoints. See
[the current build and evidence record](engine96-integration.md).
Sync whole-file ownership: [source98 scope](file-sync-implementation-dependencies.md).
Promise write/append ownership: [source99 scope](file-promises-implementation-dependencies.md).

The user authorized implementation after the completed
[audit](../audit/audit-report.md), with a breadth-first pass before overall
tests. The active goal covers public Node 26.x compatibility across Node,
Chromium, Firefox and WebKit. The exact pin remains Node 26.13.0 at
`18b32a3b1552e199a01f1a8d9fd64aa756d3b75b`.

The audit directory is historical evidence of its reviewed source hashes;
implementation changes do not retroactively update those findings to pass.
This ledger records subsequent source changes and their actual evidence.
The existing implementation-review.md records the earlier unbuilt candidate.

## Execution and validation gates

Implement dependency foundations, then make a broad implementation pass
across all 19 families before overall conformance suites. Focused source
checks, targeted tests/native controls and targeted builds are authorized
when needed for a source slice. Full product rebuilds remain deferred.
No merge or deployment is authorized. Preserve unrelated dirty work and
the separate Claude/npm/Bun remainder.

Do not spend the pass expanding one subsystem's test campaign while
independent audited source gaps remain. Record deep dependencies and move
to useful independent work. A queued dependency, missing implementation,
skip, timeout or unsupported test is not passing compatibility. A first
pass across every family is a scheduling milestone, not goal completion.
Source implementation and identified-artifact four-host conformance remain
independent dimensions.

## Family pass ledger

The shared native bridge now has a dependency-ordered unity-source assembly
and canonical staged headers. This addresses the include integration found
by targeted engine builds; it does not complete a family. See
[native embedding integration](native-embedding-integration.md) for the
failed build identities, source checks and remaining validation gates.

| Family | Breadth pass state | Next shared or owning work |
|---|---|---|
| Values | Started: util/dotenv/parser/diff/call-control, Buffer byte/codecs, pinned StringDecoder and querystring/punycode owners | Buffer pool/constructor/transfer/backing-store edges, errors, remaining util/URL owners and guest load/warning/byte integration |
| Async | Started: diagnostics registry/store scopes/tracing and shared native callback/JS entry scopes | Complete rejection/fatal/GC/realm/worker and scheduler policy, domain and remaining producer owners |
| Streams | Started: real fd-backed stdio Readable/Writable owners | Complete subclass/stdio/ref/error/byte/port ownership |
| Filesystem | Started: pinned public readdir/Dirent/Dir and native typed scans/cursors, removal, directory/path and pathname metadata wrappers/native queued POSIX owners, shared system errors and nofollow timestamps | Guest metadata/Dir lifecycle, signed/precise times, persistent OPFS metadata, complete fd/byte-path/watch/VFS/copy/link policies and remaining removal/options/permission contracts |
| Processes | Started: env/mask/parent, dotenv/child owners, pinned OS frontend with actual POSIX state, upstream weak finalization registry/lazy descriptor and Refable dispatch | Complete resource measurements/OS constants, fatal/rejection/GC/exit integration, CLI/permission/worker env, signals/IPC/normalization/priority scheduling and exceptional wait policy; guest validation pending |
| Network | Started: native address/rule owners, pinned BlockList/SocketAddress and live TCP consumers; queued lookup and raw DNS channels | Guest rule/clone/worker integration, full Socket/Server lifecycle/controls and DNS/Resolver/datagram owners |
| HTTP | Started: pinned outgoing header owner, request-line validation and wire state | Full framing/parser/Agent/pooling/server and protocol lifecycle |
| Secure network | Started: pinned TLS identity and shared IDNA/IP helpers | Real trust/identity/metadata/server and DTLS/QUIC dependencies |
| Crypto | Started: pinned random/UUID, provider digest/Hash/Hmac, full PBKDF2/scrypt/Argon2 and native queued derivation owners, shared threaded OpenSSL3.5.9 source prerequisite | Guest dependency/JSAPI/job/lifecycle and backing-store leases; HKDF, real keys/ciphers/signatures/exchange/certificates/FIPS and full WebCrypto owners |
| Web | Started: File/FormData/Headers, private guard/list consumers and shared-buffer Blob copying | Complete Blob/body/WebIDL/transfer/global/Fetch/encoding policies and guest integration |
| Loading | Started: Module records/graphs, require/lookup/extension/JSON/package policy and full pinned SourceMap decoder/query owner | Actual source-map capture/cache/support/stack integration; remaining ESM/hooks/format/CLI/cache, metadata/diagnostics and guest lifecycle |
| Terminal | Started: actual callback/promise Interface/input/key/history source, cursor/transaction and isatty owners | Actual TTY/stdio/raw/resize/Unicode width, persistent history/permissions, REPL and guest lifecycle validation |
| Workers | Started: actual thread/bootstrap, entangled endpoints, named broadcast groups and pinned IO/event owners | Full transfer/context/worker options/lifecycle/metadata, thread routing/locks, engine ownership/accounting and four-host validation |
| Compression | Started: exact native codec and conversion owners | Native codec/work/byte/stream/file ownership and modes |
| Observability | Started: pinned Console/diagnostics, real Performance timeline/entry/resource/timerify algorithms and shared observer buffers | Native milestones/loop measurements/histograms, GC/HTTP/net/QUIC/Fetch producers, report/tracing/inspector and exact guest/realm/global lifecycle |
| Engine | Started: pinned VM frontend and native compiler owner | VM contexts/options/modules, inspector and real engine metadata |
| Testing | Started: standalone mock/virtual-clock and reporting owners | Real runner/context/hook/CLI/isolation/coverage/benchmark ownership |
| Native integration | Started: actual SQLite database/statement owners | Actual FFI/SQLite/WASI/SEA/addon/embedding bridges |
| Documentation | Started: current source/capability/deprecation crosswalk | Complete warning/origin/CLI/environment/activation owners and individual API reconciliation |

The later [async finding slice](async-audit-gaps-implementation.md) addresses
A-002/A-003/A-005/A-010 requirements: hook validation, full declared provider
metadata, listener-removal dependencies and canceled Timeout ownership.
Ten focused source/native controls pass; this does not close the async
family or establish guest runtime conformance.

## Public util foundation slice

Audited findings: V-008, V-033 and DOC-007 (scoped changes only).

* Public deprecate now uses the exact pinned public options wrapper rather
  than exposing the internal helper's synchronous-warning parameter.
* _extend and isArray use the retained target deprecation wrappers and
  actual copied object-key behavior. Removed legacy predicates are removed
  from the public bootstrap object; util.types remains independent.
* markPromiseAsHandled validates a genuine promise, then delegates to the
  existing actual native handled-promise operation. No promise property
  probing or synthetic successful handling is supplied.
* Signal-to-exit-code conversion uses the exact target algorithm with the
  supplied guest signal constants and shared validators.

`util-public-adapter.js` selects exact functions from the full pinned
lib/util.js input. The manifest hashes each selected section; the shared
core helper excerpt adds the unchanged signal conversion. The normal
source bundler generates node-core.js. This does not compile the guest
engine, regenerate a product image or establish product conformance.

Focused controls in host/test/node-util-public.test.ts load the real
factories and bootstrap selection under the exact native reference. Native
Node supplies engine brands/handled-promise operation and its signal-table
input; these controls do not validate SpiderMonkey's native hook or the
guest signal constants. Current guest conformance remains pending on all
four hosts. The focused pinned-reference run passed all seven controls.

Remaining util gaps include MIME/parseArgs/parseEnv/diff/debounce/throttle,
system error maps/messages, diagnostic stacks/source maps, and other
audited errors/descriptors/ownership. This slice does not close node:util.

## Repository baseline

Implementation began on branch brandonpayton/node-event-emitter at
`0a1bff02d8d19bd9adbab76722d72b20b841487a`. The locally recorded origin/main
is an ancestor (50 branch commits ahead, zero behind at this checkpoint).
The existing large dirty candidate and unrelated submodule state were
preserved; no branch rename or merge was performed. No running managed
local build was listed before changing package-owned source.

A fetch of origin/main confirmed the same ancestor before the next source
slice; no main commits were missing from this branch at that checkpoint.

## Child signal and exit-owned stdin slice

The shared helper excerpt now also contains unchanged target signal
validation/mapping. ChildProcess.kill preserves zero probes, defaults only
undefined to SIGTERM, normalizes valid names through that helper and rejects
unknown names/numbers. An already reaped owner does not signal a reused pid.
The actual native kill still reaches guest libc/kernel; ESRCH returns false,
EINVAL/ENOSYS throw and other native errno failures emit error rather than
being swallowed. Unexpected non-errno exceptions retain their identity.
Error text still depends on the audited shared diagnostic gap.

The wait completion destroys stdin through the existing owned Writable
before emitting exit, matching the target's descriptor-owner ordering.
This addresses the stdin branch of CP-008. Wait rejection/terminal policy,
the broader ChildProcess representation and other process findings remain
incomplete; they are not marked closed by this slice.

Five focused source/native-policy controls cover zero/default/normalized and
invalid signals, errno handling, reaped owners and stdin-before-exit order.
They use the real source statements; only native handle/stream boundaries
are controlled. They do not establish guest kernel signal delivery or
descriptor cleanup on the four runtime hosts.

## Focused evidence checkpoint

The dev-shell command used the SHA-verified Darwin arm64 Node 26.13.0
reference to run only node-util-public.test.ts and
node-child-lifecycle.test.ts under vitest.node-core.config.ts:
**12 passed, zero failed or skipped**, two files. Bundle regeneration and
build.py --check succeeded; these generate/check JavaScript source only.
Raw output is in .context/node26-public-util-controls.log. The implementation
state records source/test/bundle identities and exact scope. The native
reference controls do not count as four-host guest conformance.

No overall conformance suite, package/engine compilation, product rebuild,
merge or deployment has run in this phase. Next source work remains the
shared Buffer/encoding/error prerequisites, followed by independent gaps
in the other queued families. The breadth pass is not complete.

## Buffer byte-storage foundation slice

V-013/V-015/V-017/V-030 (partial): the byte adapter selects 13 unchanged
sections from the exact pinned lib/buffer.js. Non-string Buffer.from dispatch
uses real brands, valueOf/Symbol.toPrimitive, ArrayBuffer offset/length and
object conversion; Buffer/typed-array inputs copy elements instead of sharing
raw backing bytes, while explicit ArrayBuffer overloads share storage.
copyBytesFrom copies raw typed-view bytes. of, compare/equals, concat,
copy, swaps and parent/offset descriptors use the actual target algorithms.

Portable private byte primitives use intrinsic-branded byte spans. Copy is
overlap-safe and works in byte units for typed-array/DataView targets;
comparison/swap operate on actual storage. Private byte slicing bypasses
user-controlled species, while the copied public algorithms retain their
own observable JavaScript operations. Recreated public methods have the
target assignment-created enumerable descriptors rather than stale class
method descriptors. Existing selected numeric and unpooled allocators remain.

This is not full Buffer completion: strings still use the existing partial
codec backend; pool layout/alignment/transfer/zero-fill policy, callable legacy
constructor/species and allocation-dependent array-like getter ordering,
immutable storage, fill/search/write and other audited APIs remain open.
The array-like backing allocator is currently unpooled. Source implementation
progress is not a passing compatibility classification for those gaps.

Eight focused pinned-reference Buffer controls passed, including coercion,
copy/share identity, raw byte units, truncation, overlap, bounds, comparison,
swaps, descriptors and private species noninterference. They use actual
shared source with fixed ArrayBuffers at the allocation boundary. Guest
native allocation, pool/transfer/codecs and four-host behavior are unverified.

An added adversarial test initially failed because its cleanup assumed the
inherited Uint8Array species descriptor was an own property. It left the
test process polluted, producing one failed test, two unhandled errors and
a worker shutdown timeout. That output remains in the content-addressed
archived run listed in implementation-state.json. Cleanup now restores the
original own descriptor or removes the temporary own property; the
subsequent eight-test run passed. This was a test defect, not a diagnosed
native engine defect, and its failure remains recorded.

## Loader source slice

L-026 and the CommonJS portions of L-027: invoke the compiled wrapper with
its initial exports object as receiver, using a captured Reflect.apply.
Compile within the same cache transaction as execution so syntax failure
removes the incomplete cache entry. JSON parsing strips a BOM and prefixes
parse errors with the filename, using captured string/parser intrinsics.
The separate Bun asset-loader branch remains outside these changes.

Ten focused controls passed: shared loader main/cache/receiver/JSON/retry
checks plus existing exact-native CJS/ESM entry fixture controls. They do
not validate the guest native loader or establish full ESM JSON attributes,
namespace/cache identity, public Module records, hooks or graph lifecycle.
JSON cache records still require their complete public ownership work.

## Filesystem removal source slice

FS-012 (partial): rmSync validates options before backend access, suppresses
only ENOENT with force, propagates recursive directory-read and removal
errors, and rejects nonrecursive directory deletion with the target
ERR_FS_EISDIR SystemError contract. It uses the actual backend operation and
retains native failure codes instead of reporting successful deletion.

Four focused controls passed with controlled POSIX failure boundaries and
the native directory-error control. These do not validate guest mounts or
race/retry behavior. Recursive mkdir, maxRetries/backoff, operation-specific
unlink/rmdir native bindings, callbacks/async ownership and other filesystem
findings remain open. In particular FS-014 is not closed by public rm policy.

No overall suite or product rebuild was run. Deeper native dependencies
remain explicit implementation work.

## Diagnostics and actual console/TCP producers

A-016 (scoped source work): diagnostics-platform-adapter.js now embeds the
full unchanged pinned lib/diagnostics_channel.js and the exact WeakReference
helper from internal/util.js. sources.json binds the full files and helper
section hashes. Public module shape, live channel identity, weak registry and
strong active subscriptions, mutation snapshots, disposable store scopes,
bounded windows and sync/Promise/callback tracing use these actual algorithms.
The bootstrap selects that module instead of its former inert facade.

The adapter owns one real registry for Kandelo JavaScript producers, with
weak links to channels and active subscriber counters. It grows actual
storage when more producers register. This connects subscription state to
actual publications; it does not claim the absent C/C++ producer bridge.
Subscriber exceptions are queued through the real process.nextTick owner
and thrown in that callback. Correct guest fatal/uncaught-exception policy
and optimized async propagation remain separate implementation gaps.

Five Console methods and the global console publish their real argument
arrays before formatting/writing. Duplicate wrapper attachment does not
publish twice. TCP connect publishes the actual attempted socket before
callback registration and option rejection; acceptance publishes the owned
socket after the public connection handler, including when that handler
destroys the socket. Both use the same guest diagnostics registry.
net.server.listen tracing, HTTP/HTTP2/UDP/loader/worker and other documented
producers remain unimplemented. Domain remains absent. Console formatting,
stream/device ownership and the wider observability family remain incomplete.

Ten focused diagnostics controls passed against the exact native reference:
module shape, snapshots, queued subscriber failures, store entry/restoration,
bounded windows, tracing, Console integration and registry growth. The ALS
boundary in store controls is native Node; these do not establish guest GC,
async context, fatal policy, native C producers or four-host conformance.
The pinned native control for A-017 observes late end subscriptions receiving
end when a trace began with a start subscriber. This resolves the execution
question recorded by the historical audit in favor of the pinned source's
actual behavior; it does not silently reinterpret the conflicting prose.

Focused TCP source controls also cover publication order and identity using
the real Socket/Server source and real diagnostics implementation. Their
transport boundaries are controlled handles or native loopback TCP, and the
classic stream boundary is native Node. The earlier extraction fixture had
drifted: its stream section now required additional factories and setup.
Failed runs are retained, with their missing-dependency errors. The repaired
fixture documents its native stream/AbortListener/AsyncResource boundaries
explicitly; passing it does not validate the shared guest stream dependency
graph, guest transport, provider lifecycle or descriptor loop.

The machine-readable state records exact source/log identities and outcomes.
No family is complete. Overall suites and full product rebuilds remain
deferred; all four current guest conformance results remain unestablished.

## File and FormData source slice

W-001 and WEB-008 (partial): File now uses the full unchanged pinned
internal/file.js class over the existing owned-byte Blob implementation.
Metadata coercion, names, timestamps, descriptors, inspection and File clone
payload hooks belong to that class. Global File and buffer.File select the
same constructor. The clone protocol now resolves the actual Blob/File
constructor modules, and an empty transferable receiver owns real Blob
storage before its decoded payload is restored. This does not establish
guest serializer/GC/worker delivery conformance.

FormData uses the full unchanged target-vendored Undici implementation,
its WebIDL and runtime-feature modules, and exact selected iterator
algorithms. Actual private entries support ordered duplicates, append/set/
delete/get/getAll/has, live iteration, forEach, string conversion and File
values. FormData marks each new nontransferable instance with actual clone
mode zero, reaching the existing guest serializer's refusal path instead of
the no-op worker facade. This private constructor use does not implement
the broader public worker marking/transfer APIs. The runtime-feature module
queries the actual supplied crypto owner; boundaries use its existing real
entropy-backed randomInt rather than fabricated capability flags.

Blob now recognizes raw SharedArrayBuffer input by an intrinsic brand
check and copies its bytes into private storage. This also reaches File
construction. The existing Blob implementation remains partial: constructor
conversion/order/errors, intrinsic/species behavior, file-backed storage,
object URLs and complete stream/clone/encoding integration remain open.
Public global descriptors/activation and broader WebIDL behavior also need
their audited completion; importing File/FormData does not close them.

Thirteen focused native-reference controls passed for File metadata/errors/
descriptors/bytes/streams/inspection and clone payloads, FormData entries,
conversion, iterators/mutation and native serializer clone refusal. The
controls execute the actual new factories and body source, with explicit
native stream/text-codec/crypto and registration boundaries. The File clone
control exercises its hook payload through native graph copying and the
actual receiver/deserializer; it is not a guest serializer integration test.
Multipart extraction, encoding/parsing, Request/Response integration and
Fetch transport remain implementation gaps. No four-host conformance is
claimed; no overall suite or product/engine build ran for this slice.

## Storage maintenance during the breadth pass

The user authorized ./run.sh cache-gc and cleanup to avoid disk exhaustion.
The default dry run found no age-eligible SourceOnly entries. An applying
collection with an 80 GiB budget safely skipped because another worktree
held the shared cache lock; no shared generations or root records were
removed. The retained command log is .context/cache-gc-20261103.log.

Sixty-seven inactive historical suite.vfs paths (42 distinct inodes) were
replaced by 17 content-addressed gzip archives, 2,474,813,518 stored bytes.
Each archive was decompressed and checked against the original SHA-256 and
length before an image path was removed. Hard links mean the 49,923,791,328
logical input bytes are not a physical reclaimed-space claim. Original
manifests, summaries, results, logs, source trees and exact native references
remain in place. Their retained manifest/summary/results hashes were checked
after cleanup. The restoration index and instructions are in
.context/retired-node-suite-images/; old images can be restored without a
build. The historical audit remains unchanged.

An additional 5,139,251,200 allocated bytes of local Cargo incremental state
were discarded after verifying no open handles. Existing binary/dependency
outputs were retained. Available filesystem space was 23 GiB before and
67 GiB after maintenance; concurrent other-worktree activity prevents
attributing that entire difference solely to these actions. Broad source
work continues without generating new suite images or a full product rebuild.

## Shared entropy and synchronous random contracts

C-003/C-014: the common host_getrandom path now obtains independent host
bytes from secure-random.ts. Each actual Web Crypto invocation is limited
to 65,536 bytes, including when /dev/urandom reaches this owner as a larger
read. Missing providers fail with ENOSYS; provider exceptions remain errors.
The Math.random fallback is removed. The complete temporary is copied into
the Rust-lent destination only after all provider calls succeed. Providers
receive owned ordinary buffers, never a view of kernel/shared memory.

C-002/C-004/C-012 (scoped): the random adapter selects the exact pinned byte
length, element size, offset/size validation, randomFillSync and integer/quota
algorithms. The actual guest /dev/urandom owner supplies entropy. Bounded
owned read storage and intrinsic copies allow shared destinations without
passing shared backing to native filesystem leases; returned short counts
are honored and descriptor close is attempted in finally. The existing
close-error policy remains open; this is not proof of native fd retirement.

The first differential run correctly exposed an omitted public layer:
node:crypto.getRandomValues delegates through Web Crypto's WebIDL conversion
before integer-array validation. Exact public/Web Crypto wrapper functions
and their conversion options now reach the existing pinned shared WebIDL
converter. Public getRandomValues rejects shared/resizable views as the pin
does, while randomFillSync accepts supported raw/view/shared inputs with
their correct byte/element units. This also resolves the execution branch
of C-016's module-getRandomValues prose/source question in favor of the
pinned public/native behavior. The failed run remains evidence; assertions
were not weakened. A private forwarding receiver does not implement public
Crypto/SubtleCrypto classes, keys or full global receiver semantics.

Focused source/native controls cover actual host import bounds/errno and
private memory ownership for wasm32/wasm64, real Node provider delegation,
quota/error/brand/conversion rules and guest fill ownership with controlled
file reads. Direct host-helper checks also used actual Chromium and WebKit
Web Crypto. Firefox failed to launch before these controls could execute;
its launch diagnostics and observed harness timeout/termination are retained.
This is a harness error, not a passing helper or Node-core result and not
a justified public API boundary. No guest kernel/libc/FFI or identified
four-host core product conformance follows from these source/helper checks.

Async random jobs, callback/context ordering, randomBytes/randomInt/UUID
options, timingSafeEqual's native constant-time owner, Hash/Hmac, keys,
algorithms/provider metadata and complete WebCrypto remain open.

## Cursor, transactional readline and tty validation

T-003/T-006/T-011 (partial): exact pinned isatty validation checks integer,
nonnegative signed-int32 fds before calling the real guest tty predicate.
Callback cursor helpers use unchanged internal/readline/callbacks.js and
exact CSI encoding. They return the actual stream.write result and pass
callbacks to that operation; null-stream completion uses process.nextTick.
The stdout/stderr control methods delegate to the same helper owner.
This does not repair the underlying stdio facade's write/stream semantics.

The full pinned transactional Readline class owns real queued control bytes,
rollback, autoCommit scheduling and commit completion through the supplied
Writable. readline.promises and readline/promises share this partial
namespace. Their Interface/createInterface APIs remain missing, while the
callback createInterface facade still lacks the actual input/editing/history/
question/lifecycle owner. Public TTY constructors, termios/raw/binary modes,
resize/signals, complete stdio and REPL remain implementation gaps. Namespace
presence and copied classes do not make those contracts complete.

Focused native controls use the actual factories with explicit native
Writable, tty and tick boundaries. Guest stream/stdio/device integration
remains unvalidated. Exact source/log identities and every outcome are in
implementation-state.json. Overall suites and full product rebuilds remain
deferred; no family is complete.

## HTTP outgoing headers and shared single-byte encoding

H-005/H-007/H-008 (partial): actual HTTP/HTTPS ClientRequest instances now
use one pinned header owner for names, raw values, shallow arrays, append/
setHeaders/query/removal, casing, compiled-header mutation errors and
headersSent. Exact token/value/strict-relaxed validators are public on HTTP.
Pinned method and path validation rejects malformed request lines before
network acquisition. The complete target STATUS_CODES object is retained
as protocol constants; the parser-dependent METHODS capability remains
an implementation gap rather than a fabricated full parser list.

Exact field serialization preserves separate duplicate fields, Cookie joining,
Set-Cookie arrays and uniqueHeaders behavior. Both protocols use this owner
in their existing real write path. Headers compile when needed by a write,
finalization or flushHeaders, and merely obtaining a connection no longer
prematurely sends them. Flushing before connection compiles/fixes the actual
queued header string. This is not complete OutgoingMessage inheritance or
all public write/end/flush event and timing equivalence.

The wire encoding is Latin-1. V-014 (scoped): Buffer.from's shared single-byte
encoder now retains the low eight bits of UTF-16 code units for latin1,
binary and ascii, including case-insensitive labels and lone surrogates.
Captured intrinsics protect that new conversion. ASCII decoding, UTF-16,
other codecs, validation/error cases, pool/transfer and complete Buffer APIs
remain open. HTTP uses this shared byte owner rather than a private encoder
that would conceal the Buffer gap.

Six new HTTP/source/native controls and eight existing Buffer regressions
passed together. The wire comparison sends the actual source request over
native loopback TCP and compares it with the pinned native HTTP client;
streams/URL/transport are explicit native boundaries, not guest conformance.
The first focused run retained four passes, two failed cases and two unhandled
fixture errors: its extraction omitted shared debug-environment initialization
and the request's values dependency. Those dependencies were supplied without
weakening assertions, and the failed output remains recorded.

Raw array-form constructor headers, complete body framing/content-length/
chunk/trailer/expect handling, strict bounded incoming parsing, informational/
upgrade/CONNECT lifecycle, public Agent control and TLS security-context
pooling, server/HTTP2 APIs, CLI/global parser activation and full metadata
remain implementation gaps. Callback/constructor/inheritance and public
write/end timing need their owning implementations and later validation.
There is no new four-host guest runtime result or product/engine build.

The worker/port trace found coupled native queue, ref/wakeup, graph transfer,
GC, NodeEventTarget and child-initialization dependencies. The worker family
remains queued: no disconnected replacement, timer keeper or success-shaped
port facade was introduced. See worker-port-implementation-dependencies.md
for the source-based next work; those dependencies are not platform exclusions.

## TLS identity and shared domain/IP implementation slice

Secure-network is now started; no family is complete. S-001 now routes the
actual public `tls.checkServerIdentity` to unchanged pinned matching and
error algorithms. It handles SAN/CN precedence, quoted SAN parsing, wildcard
restrictions, Unicode host conversion, noncanonical-IP rejection and IP SAN
canonicalization. It does not replace the native client's existing OpenSSL
chain/name verification or activate a custom identity callback during a
handshake. Certificate extraction and native authorization metadata remain
separate gaps (S-002/S-003/S-011).

The shared prerequisite removes V-005's String-only `domainToASCII` and
supplies `domainToUnicode` with pinned argument coercion/errors and actual
WHATWG special-host/IDNA parsing. All `net` IP predicates use the same pinned
grammar as certificate conversion. Libuv-style IP canonical spelling comes
from an explicit JavaScript port, with unchanged C/binding reference inputs
and license retained. The vendored URL backend now implements the target's
non-strict ASCII rule and per-label Unicode failure preservation, including
actual URL parsing; no TLS-only success fallback was introduced.

Seven new source/native controls and seven existing URL/exit regressions
pass (14 total, no failures/skips/unhandled errors in the final run).
Unchanged upstream `test-tls-check-server-identity.js`, `test-net-isip.js`,
`test-net-isipv4.js` and `test-net-isipv6.js` execute with candidate API owners
and native controls. Common/assert/util and native execution/text primitives
are explicit boundaries; these are focused in-process source controls,
not new guest suite or four-host conformance results.

The first run retained five passes and one genuine domain mismatch: the
older URL backend rejected an ASCII A-label that the pinned Node accepts.
The shared backend's non-strict ASCII rule was corrected. Two subsequent
combined runs retained 10 passes and four failed URL/exit cases each due
to stale extraction dependencies: the codec provider was absent, then the
process slice included the separate path initializer. The fixture now
supplies actual native codec metadata and stops at the process boundary;
all assertions remain. Exact logs and their limitations are in state metadata.

S-001/V-005 remain partial until the older TR46 Unicode tables, complete
label validation, percent-decode/input-size behavior and full input surface
are reconciled. Native TLS metadata/options/contexts/servers, wrapping and
inheritance, handshake/shutdown cancellation, DTLS/QUIC and crypto backend
capabilities remain implementation work. No new engine exclusion is claimed.
The main fetch confirms origin/main is already an ancestor; the dirty source
candidate, audit and separate Claude/npm/Bun work are preserved.

## Compression embedding source corrections

Compression is now started; no family is complete. ZIP-008's native owner
uses the actual signed/unsigned engine conversion for constructor options,
params, flush and write spans. Bounds are checked on converted spans before
access, preserving the fractions admitted by unchanged public validators.
Private object conversions remain rejected to avoid reentering JS while a
native state pointer is borrowed; pledge/mode/CRC integer checks remain.
ZIP-009's optional onerror lookup no longer masks initialization failure;
the existing Init path still throws ERR_ZLIB_INITIALIZATION_FAILED and owns
partial native state for cleanup. Neither finding is runtime-closed yet.

Five final controls pass for actual pinned public JS and candidate private
constructor wiring over exact native Node codec/stream/Buffer/error/ZIP/async
dependencies. They include compressed bytes for fractional options/chunks,
real async params/flush completion and initialization error controls. They
do **not** compile or execute codec-handle.cpp. The changed guest native
conversion, initialization, storage and lifecycle paths remain unvalidated
on every host. The original failures are preserved in state metadata.

The final harness gives each control its own native subprocess and explicit
internal-test activation/timeout, preserving normal parent module policy and
per-case accounting even if a reference process aborts. Earlier runs retained
five fixture failures from dropped activation, one harness error/zero completed
cases from a fixture close-before-init assertion, and four passes/one incorrect
initialization expectation. Native source/control established Brotli quality
999 is accepted/clamped; a genuine failing boolean parameter is now used,
and the accepted-quality behavior remains asserted.

The [dependency plan](compression-embedding-dependencies.md) keeps shared/
resizable backing-store leases, native accounting/lifecycle and full archive/
iterable/Web coverage open. These are implementation gaps, not accepted
engine exclusions. Other independent families proceed before overall suites.

## VM public frontend and native function ownership

The engine family is now started, with E-003/E-005/E-006/E-007 source progress.
Pinned public VM algorithms now validate and dispatch through private real
sandbox/realm associations and private compiled handles. The supplied sandbox
is the public identity and repeated createContext is idempotent. A new engine
function compiler replaces function-expression evaluation with actual native
body/parameter compilation and context-extension scope ownership. Patch 54
also supplies script column metadata and inherits caller shared-memory policy.

Six frontend controls pass with the exact native Node VM backend, including
unchanged upstream context-brand assertions. One is an honest-gap assertion
case, not supported-feature conformance. All changed guest C++ remains
uncompiled and unexecuted. Existing exotic-property behavior, negative offsets,
deadlines, imports, caches, microtasks, uncontextified globals, memory/metadata,
VM modules, V8 measurement/format and inspector integrations remain open.

Native-only isolated controls retain four passes and an astral-identifier
SIGABRT nonpass. Combined earlier probes also aborted; one collection command
failed on a readonly shell variable. They are preserved with limitations and
do not establish a guest failure, engine-fault cause or accepted exclusion.
See [VM dependencies](vm-implementation-dependencies.md) for owners and later
validation. The audit, exact pins and unrelated Claude/npm/Bun work remain
unchanged; no overall suite, engine compilation or product rebuild ran.

## Native integration: SQLite database and statement owners

NI-002/NI-006 now have real SQLite library/core, public frontend and proposed
engine bridge source. The recipe selects exact Node SQLite 3.54.0; Database
and Statement owners execute SQL, preserve typed bytes/BigInts and own actual
transaction/finalization/close/reopen state. The initial empty raw-buffer
binding mismatch is fixed, with failed and corrected controls retained.

A compiled native store comparison passes, and five shared frontend controls
pass over native Node/SQLite owners (one checks explicit unsupported gaps).
Neither is guest engine/VFS evidence. The native dispatcher is uncompiled;
callbacks, iterators, sessions, limits, backup, extensions, metadata and
other native modules remain incomplete. The dependency record retains the
full remaining work. Family state is started; no family is complete.

## Stream stdio owners

STR-001/002/006/011 now have a shared fd transport owner beneath the actual
pinned Readable/Writable state machines. Process stdio listener maps and
success-only writes are removed. Native completions drive callbacks;
Readable owns actual buffered input/encoding/EOF, with exact-request pause
cancellation and carried ref policy. Output uses pinned process-specific
dummyDestroy, retaining its borrowed fd. Missing terminal mode setters
reject, and unsupported window sizes are not fabricated.

Four focused controls pass over the candidate stream factories with actual
native Node engine dependencies and OS pipe/file I/O. Fixture setup errors
are retained separately. No guest fd watches, VFS or four-host conformance
is established. Exact public subclass/type/fd ownership, complete termios/
signal metadata, native EINTR/nonblocking/error/async/ref/fd-reuse behavior,
ports/transfer and other audited byte/dependency gaps remain open in the
stream dependency record. This starts the family; it does not complete it.

## Worker transport foundation

R-001/R-003/R-006/R-009/R-012 now have actual entangled queue and local port
owners, not disconnected EventEmitters. Native reference/close state feeds a
message phase of the proposed guest loop. Full pinned worker IO and Undici
event source share constructors across module/global/stream/WebIDL consumers.
Worker.terminate stops reporting a fabricated successful all-worker join.

The native queue control passes with 1,000 ordered threaded packets and
lifecycle/retirement assertions. Three frontend controls pass over actual
native Node queues, graph/byte serialization and engine dependencies, with
17 affected fd-stream/File/FormData controls also passing. A real missing
native-only constructor-error mapping was found and fixed without weakening
its assertion; its failed run and source are retained. The engine bridge
is uncompiled, and no guest/four-host conformance is established. Full Worker
bootstrap/metadata/options/environment/termination, transferable endpoints,
broadcast and native GC/realm/async/error/loop ordering remain open. This
starts the family, not its completion.

## Testing foundations and monotonic process time

TEST-002/003 now have actual pinned standalone MockTracker, virtual timer,
configuration, result-stream and reporter source owners. The partial public
test namespace never executes a body or emits synthetic pass records: test/
suite/shorthand, hooks, contexts and run remain explicit implementation gaps.
No copied source or namespace availability closes runner/CLI/coverage/bench
or per-test cleanup obligations.

A real Date-based process.hrtime gap surfaced while tracing virtual time.
Patch 57 routes an actual POSIX monotonic-nanosecond owner through unchanged
pinned tuple/borrow/validation algorithms. Its shared POSIX helper passes a
native-host compiled control. Source tracing includes libc, kernel, normal
Node/browser host providers and deterministic image-build clock policy;
the guest engine hook and four-host execution remain unvalidated.

Six scoped controls pass (one only verifies the execution gap); reporter
records are manual fixture data, not test results. Twenty affected URL/exit/
socket controls pass. The original reporter binding failure and six socket
fixture-initialization failures remain recorded, with assertions unchanged.
These source slices start family 18; no family is complete. Documentation
capability reconciliation remains queued, and starting every family will not
by itself satisfy the broad implementation-pass or overall-suite gate.


## Current capability/deprecation reconciliation and MIME source

The implementation-phase current-capability-reconciliation.md/.json now
routes all 19 families and binds the 13,292 original matrix observations
by immutable matrix hash and per-family row-identity hash. The original
11,199 discovery obligations and dispositions remain in their referenced
frozen crosswalk. These counts are not unique APIs or passes. All 207
original deprecation codes retain section identity/type/owner and explicit
open behavior. Literal selected-source occurrences do not prove activation.

Documentation is now started, making 19 started families and zero complete.
The breadth implementation pass remains incomplete: individual API closure,
shared prerequisites and current four-host conformance are still missing.
Six concrete fabricated capability/result claims remain visible in the
current source; they are implementation gaps, not accepted exclusions.
No overall suite or product/package/engine rebuild ran for this work.

V-008 MIMEType/MIMEParams now use the full unchanged pinned internal/mime.js
through the shared values/public-util owner. Parsing/lazy parameters, case
normalization, mutation/iteration, brands/descriptors, coercion/syntax errors
and serialization have real source owners. Nine focused public-util controls
pass. Two unchanged upstream MIME files pass over candidate algorithms and
separately as native controls, without changing their bodies or assertions.
These native-engine/assert/common/fixture paths do not validate a built guest.

The first focused run retained eight passes and one failed comparison of
separate private-state instances. Its source/log are preserved. The fixture
was corrected to compare observable state rather than private implementation
identity; the original upstream assertions remain unchanged. Preserve that
raw failure separately from the successful follow-up. Exact source/evidence
identities and scopes are in implementation-state.json.


## Actual process environment, creation-mask and parent source

PROC-001/002/013 and DOC-010 now have partial real owners. The shared live
proxy delegates environment mutation/enumeration/read/deletion to one native
libc store rather than seeding/caching values and discarding setters. Full
inherited keys become visible to existing child snapshots. Main and worker
umask policy uses unchanged target wrappers; main operations use real libc/
kernel mask state and prior-mask results. A live parent getter uses getppid.

Patch 58 and its declared private header reuse existing syscalls without
wire ABI changes. The package adapter's obsolete interposition-blame/no-op
comment is removed; this is a Kandelo adapter/configuration issue, not a
new outside-runtime defect or workaround. Full worker/TZ/exotic/CLI policy
remains open. process-state-implementation-dependencies.md records paths,
limits and later built-artifact obligations.

Three frontend controls plus seven URL/exit regressions pass. Four unchanged
upstream process-state files pass over the actual frontend with native
dependencies and separately as native controls. A standalone native C++
helper passes actual environment/copy/concurrency/mask/file-mode/parent
checks. These controls do not compile the guest engine bridge or establish
four-host conformance. No overall suite or product/package/engine rebuild
ran; the full rebuild deferral remains in effect.


## DNS native owners, honest record gap and package layout

N-001/002/004/013 now have further partial source foundations. Actual OS
getaddrinfo runs on the existing SlowIo native-work queue; native worker
strings/RAII results do not touch JS, and completion settles a rooted
Promise on the owning context. The guest OS/backend interface still has
its one-IPv4 routing limitations and does not supply record/TTL answers.

A raw c-ares channel/query/configuration/event-thread/cancellation/owned
record implementation uses the exact Node-vendored component. Native UDP
fixture results match pinned Node A/TTL data and verify cancellation,
destruction and record lifetime. The public Resolver/record bridge is
still missing. Its former fabricated loopback success now explicitly
fails, which remains a gap rather than a compatibility pass. The current
capability record preserves this removed false claim separately from the
five remaining fabricated metadata claims.

The node-cares recipe verifies 386 unchanged inputs and plans both targets
with truthful Kandelo identity and real feature-link probes. It is not yet
compiled or linked into the guest engine. A SQLite guard rejecting normal
resolver source staging is corrected; its unchanged historical source
reproduces the failure, while both current target plans pass and unsafe
source/output overlaps remain rejected. These plans compile nothing.

Native backend evidence is distinct from the uncompiled engine patches,
public API semantics, guest transport/thread/loop behavior and all four
hosts. No overall suite or full product/engine/target-package build ran.
The DNS dependency record retains remaining bind/listen/accept/Resolver/
record/lookup/provider/egress and conformance obligations.


## Shared system-error and numeric DNS prerequisite

V-008/V-035 and N-002/013 gain a real error-data owner. Unchanged pinned
libuv data is expanded against actual target errno macros; shared errors
receive real UV_* constants and maps rather than a missing binding or
small heuristic table. Pinned internal and public util name/map/message
helpers preserve validation and numeric DNS/UV exception fields. Returned
maps/entry arrays are fresh; private operations resist public collection
mutation. No libuv runtime/ABI/version or syscall capability is inferred.

All 85 native-host table entries match the exact native reference. Eleven
public-util plus two isolated error controls pass over actual native data/
engine dependencies. The first native compile failed on a generated macro
separator; its source and raw output are retained. Correcting the separator
left the full comparison/assertions unchanged. No guest engine was built.

The system-error dependency record retains stack/error-delivery/native
provider/public DNS lifecycle and integer-edge questions. The public
message wrapper/native Int32 representation needs a later retained edge
control. All 19 families remain partial, the breadth pass remains open,
and no overall suite or full product rebuild was run.

## Native DNS request and reverse-name source owner

N-001/002/004/013 gain actual native request resources for both OS lookup
directions. Dispatch captures real async identity/frame after frontend field
assignment, prevents reentrant double submission, roots the request on the
SlowIo queue and retires it once on completion/failed handoff/shutdown/GC.
Completion enters the request realm and preserves numeric errors, exact
callback argument counts, one-byte reverse strings and OS/family ordering.
The reverse helper uses real libc NI_NAMEREQD and named IPv6 zones. AI_*
constants come from the guest compiler. A shared full pinned EAI mapping also
replaces the old Promise bridge's smaller hardcoded subset.

The standalone native-host control passes and matches pinned Node for real
loopback reverse hostname/service and native AI_* constants, with additional
IPv4/IPv6/port/zone/numeric/error checks. Exact input, compiler, executable
and report hashes are retained. Source/patch/recipe checks pass. No guest
engine compilation, public DNS frontend validation, overall suite or full
product rebuild ran. The native request hooks are private prerequisites;
public lookupService/Resolver support is not claimed. All 19 families stay
partial. Next is the pinned frontend, including its real IDNA/prototype/
nextTick/performance dependencies, followed by record/channel integration
and independent queued family work.

## Pinned public DNS lookup and actual observation source slice

N-001/002/004/013 and O-008/009/012/020 gain partial connected owners.
Callback and promise lookup/lookupService now select exact pinned algorithms
and full DNS utilities over actual request primitives. Raw UTS46 conversion
uses the shared vendored hostname converter and pinned byte limit, without
URL interpretation. Result-order state and literal nextTick/validation/
error/promisify policy are actual shared algorithms. Native provider IDs
come from the pinned provider list. Returned helper/reset/receiver metadata,
CLI/worker activation and the guest name-source/transport remain incomplete.

The old inert performance observer is replaced by pinned observer/entry/list
and start/stop algorithms with actual registrations/counts/queued delivery.
The reviewed capability adaptation advertises DNS producers only; the other
target entry types remain implementation gaps. mark/measure fail explicitly.
A real POSIX process origin captured at engine main entry supplies monotonic
performance time and process uptime across contexts. Global/builtin identity
is shared; full Performance/EventTarget/producer behavior is still open.

31 focused DNS/socket controls pass. Three unchanged upstream lookup/
validation/reverse files pass over candidate algorithms and separately as
native controls. A native clock helper passes, and 19 conversion cases
match independently compiled pinned Ada. Exact sources/artifacts/scopes are
retained; these are not unique public APIs or four-host passes.

The first frontend run retained three passes and one failed fixture
retirement assertion. Native callback scopes drain microtasks before the
ReqWrap destructor; an await continuation still saw an active ID. The
fixture now checks actual retirement after callback-scope unwinding, keeping
its invalid/NONE assertions. Raw failure and input copies remain preserved.
This observation also leaves a genuine shared native callback-scope/tick/
microtask-before-retirement implementation dependency; current Complete
cleanup alone does not establish that phase. See the performance and DNS
dependency records. The engine remains uncompiled, all 19 families partial,
and the full rebuild/overall-suite deferrals remain in effect.

## Shared native callback scope and actual JS entry depth

N-013 plus filesystem/compression callback and async ownership gain a shared
C++ policy and actual JSAPI adapter. DNS, filesystem and codecs now retain
their actual resource through successful outermost after/context-pop/tick/
microtask processing before retirement. Nested or failed scopes restore
context without recursively checkpointing; stopping skips further user JS.
Actual bootstrap/timer/tick/job entries carry depth without fake resources
or duplicate hooks. Native quit status is preserved before error handling.

Eight compiled-policy scenarios match a real Node-API MakeCallback/libuv
reference, including nested/throwing callbacks, async-local stores, ordinary
JS/Promise/timer entries, fatal hooks and explicit exit. Reference fatal/exit
statuses 1/17 and their raw output remain recorded. Earlier smaller runs
are historical evidence, not current-candidate conformance. Exact target
references, source patch forward/reverse and declared-input checks pass.

The JSAPI adapter and changed engine/native producers remain uncompiled;
full promise rejection/fatal recovery, weak-reference/zero-ID/realm/worker
and complete loop phase semantics remain incomplete or unvalidated. No
family closes, no four-host conformance is claimed, and no overall suite
or full product build ran. Continue independent audited source gaps after
this shared prerequisite. See callback-scope-implementation-dependencies.md.

## Shared Buffer codecs and encoded byte operations

V-014 and parts of V-016/V-017/V-030/V-031 gain real UTF-8/ASCII/Latin-1/
UTF-16LE/hex/base64/base64url byte codecs, pinned public wrappers and shared
fill/search primitives. Capped UTF-8/UTF-16 writes preserve complete encoded
characters; decoding retains BOM and maximal-prefix replacement semantics.
byteLength/stringLength, isLatin1, fromString, alloc/fill/write/toString,
exclusive-end bidirectional searches, prototype helpers and assignment
descriptors now use these owners. Private alloc/fill do not depend on
mutable public allocator functions. All four hosts select the same source.

The final 23 focused JS controls pass, including all 65,536 two-byte UTF-8
inputs compared with native Node. Three unchanged upstream public Buffer
files pass against both candidate and pinned native reference. One earlier
test-assumption failure and its exact source remain recorded. Source hashes
and upstream provenance are separate from guest runtime evidence.

Pooling remains explicitly unimplemented: fromStringFast uses the existing
unpooled owner. Callable construction, transfer, allocation flags/alignment,
backing-store edge behavior, other exports and consumer integration remain
open. The guest engine/native allocator is uncompiled; no family or four-host
conformance is established. Continue independent audited source gaps; see
buffer-codec-implementation-dependencies.md for exact scope and evidence.

## Distinct pathname primitives and recursive mkdir

FS-012 mkdir and FS-014 gain actual mkdir/unlink/rmdir libc owners, recursive
first-created-path tracking and pinned sync/callback/promise wrappers. The
native policy preserves leaf-first creation, existing-file failures, mode
zero and bounded missing-parent retries, including target sync/async error
differences. Actual rooted pathname jobs share FSReq/callback-scope lifecycle;
legacy rmSync also selects the distinct unlink/rmdir primitives now.

Nine focused frontend/removal controls pass. The compiled portable helper
matches native Node outcomes and filesystem trees for 22 scenarios. One
pre-existing invalid-byte name fixture is unsupported by APFS, not a passing
compatibility case. Three unchanged public upstream files pass in candidate
and native modes. Earlier fixture/dependency/setup failures and exact inputs
remain recorded. No new guest artifact or four-host validation is established.

Removal traversal/retry/backoff, raw directory bytes, directory handles,
metadata/watch and remaining FS/native lifecycle dependencies stay open;
neither finding nor family closes. Patch 64/recipe/native JSAPI remain
uncompiled. See directory-implementation-dependencies.md and move to useful
independent loader/stream/process source work before expanding this campaign.

## Actual CommonJS Module records and require paths

L-005/L-006/L-008 and the CJS parts of L-026/L-027 gain actual shared Module
instances, hidden parent ownership, cache/children failure rollback and pinned
createRequire/require/lookup/load/JSON wrappers. Public extension/require/load
and cache overrides affect execution. Lookup options, global/parent paths,
registered file suffixes, directory-request distinctions and builtin-prefix
cache policy use real state. Global paths consume privileged-safe guest
HOME/NODE_PATH; patch 65 extends the actual environment owner without a wire
ABI change. The separate Bun asset block remains verbatim and out of scope.

Focused record/entry/process controls and three unchanged public upstream
files provide scoped native-reference evidence. Initial fixture/dependency/
realpath/namespace failures remain retained. The native process-state helper
exercises ordinary safe queries; the guest secure startup/JSAPI and combined
engine remain uncompiled. Pending ESM status fails explicitly rather than
returning empty exports, and is still an implementation gap.

Package maps/exports/imports/config, ESM format/URL/static graphs, hooks/cache/
source maps, preloads/CLI/TS, addons, diagnostics and other audit requirements
remain open. No finding/family or four-host conformance closes. See
module-record-implementation-dependencies.md, then continue independent
stream/process/other source owners before a larger loader test campaign.

## Retained child wait outcomes and lifecycle source

The exact-pid native owner now retains actual exit/signal/error results across
failed JS delivery instead of converting ECHILD to successful exit zero. It
retries EINTR, leaves stop/continue pending, guards duplicate/reentrant owners
and releases context-owned roots at shutdown. Bootstrap uses actual public
ChildProcess instances, exit metadata, one-time close/callback gates, failed
stdio retirement and exact Promise-token ref/unref controls.

The portable helper passes real native POSIX child checks. Four new frontend
controls plus five existing lifecycle controls pass; normal status/signal
traces compare with the pinned native reference. The first ECHILD/libuv-map
fixture mismatch remains recorded. Exceptional wait-loss behavior is explicit
but differs from pinned libuv and remains an implementation-policy gap.

Patch 66/recipe revision 48 remain uncompiled. There is no guest/four-host
conformance or overall suite result. Constructor/normalization/IPC/stdio/
error/fatal/GC/realm and remaining process requirements stay open; see
child-wait-implementation-dependencies.md. Continue independent audited owners.

## Dotenv parser and actual environment-file source

util.parseEnv and process.loadEnvFile now select pinned public wrappers and
the exact retained native parser, with actual guest file/environment owners.
The portable parser preserves duplicate/quoted/multiline/export/comment and
byte behavior; existing even-empty environment values win. Native diagnostic
policy retains empty provided paths and real underlying failure information.

Eighteen focused controls, 28 portable native-reference scenarios and one
unchanged upstream file in candidate/native modes provide scoped evidence.
The first empty-path diagnostic failure remains recorded. Patch 67/recipe 49
and the engine bridge remain uncompiled; CLI/permission/worker/startup,
unexpected close policy, raw-key/GC/realm/concurrency and four-host obligations
remain open. See dotenv-implementation-dependencies.md. No overall suite or
full product rebuild ran; continue independent audited source owners.

## Provider-backed one-shot digest and actual byte comparison

crypto.hash now selects pinned public validation/normalization and actual
OpenSSL digest/XOF owners. getHashes derives available names from the backend,
and timingSafeEqual uses native buffer-source checks and CRYPTO_memcmp.
Owned temporary bytes/context/digest resources retire deterministically.
Engine source also fixes incremental NUL truncation/private-slot initialization
and broadens real provider lookup; full Hash/Hmac classes remain incomplete.

The exact-version native control library matches the reference's 81 digest
names and common NUL-input outcomes. Eleven focused controls and two unchanged
upstream files in candidate/native modes provide scoped evidence. Original
constructor/NULL-list/transport failures remain recorded. Patch 68/recipe 50
and actual guest/four-host behavior remain uncompiled/unvalidated. No overall
suite or product rebuild; continue independent owners. See
digest-implementation-dependencies.md.

## Actual readline interface input and lifecycle source

Callback and promise readline now select actual full pinned shared Interface,
key decoder/history and public namespace owners. Real input/EOF/question/
abort/iterator/pause/close state replaces the synthetic empty answer and
no-input facade. Private event symbols, decoder/stream/timer and module cache
identity use their actual shared owners. Persistent history's missing Node
permission policy fails explicitly rather than inferring it from public state.

Fourteen scoped frontend controls and four unchanged upstream files in both
candidate/native modes pass. The omitted worker flag and CJS/ESM test
assumption failures remain recorded; repetitions do not add API coverage.
Actual TTY/termios/width/persistence/REPL, guest stream/event/abort/scheduler
integration and four-host evidence remain open. Recipe 51/source generation
are unbuilt guest inputs. See readline-interface-implementation-dependencies.md;
continue other audited owners before an expanded terminal campaign.


## Console namespace, output and state slice

O-004/005/006/007 (partial) now select the pinned full Console/public/global,
format/table/state and debug-timer modules. The builtin and global namespace
share an owner; constructor/legacy options, inspect Map, stream error policy,
formatting, counters/groups/clear and monotonic timers replace separate
facades/no-ops. Diagnostics publish directly once before formatting; the
old wrapper is removed. A private active-subscription trace collector has
real monotonic records and explicit retirement, without claiming public
trace files/CLI/inspector or full native producer support.

Nine focused Console plus ten affected diagnostics controls passed. Four
unchanged upstream files passed in candidate/native modes (group, count,
sync write error, async write error). Native inspection/stream/clock/engine/
preview/readline boundaries are explicit; these are source controls, not
combined guest/four-host conformance. Both failed command/fixture runs are
retained separately. Source generation and syntax checking are not builds.

The absent V8 stack recapture uses a real engine Error stack and Trace header;
exact frame filtering/formatting and inspector console methods remain gaps.
Shared stream/TTY/width/error/GC/realm integration and public tracing/perf/
report owners remain open. Recipe revision 52, no new native patch or wire
ABI. No overall suite, guest build, product rebuild, merge or deployment.
See [Console dependencies](console-implementation-dependencies.md).


## Shared Headers and Fetch header ownership slice

WEB-002 now selects the full pinned Undici Headers class over the existing
shared WebIDL/FormData/runtime-feature/symbol/iterator owner. Private actual
lists/guards, ByteString/name/value conversion/validation, sorted live
iteration, cookie ownership, descriptors/inspection and clone refusal replace
the public map facade. Global and Fetch Headers are the same constructor.

WEB-003/004/005 receive partial consumer fixes: actual request/response guards,
immutable transport response/clone headers, private-list transport reduction
without prototype loss, separate set-cookie values and init.headers replacement
rather than merge. Full Request/Response/Body/Fetch/transport remains open.

Six new and 26 affected controls pass (32 total), plus one unchanged upstream
Headers file in candidate/native modes. Native and in-memory HTTP/polyfill
stream boundaries are explicit; these are not guest/four-host conformance.
The first authored constructor-record assumption failure and later passing
pre-replacement stage remain historical evidence. Native Node omits record
__proto__ but retains explicit append; no upstream assertion was weakened.

Recipe revision 53 changes source/bundle bytes only; no new engine patch,
syscall/import/wire ABI or package/product/engine build. No overall suites,
merge or deployment. See [Headers dependencies](headers-implementation-dependencies.md).


## Query-string and Unicode codec source slice

V-001/002/003/004/019/020/021/023 now select full pinned public/private
querystring and punycode algorithms. Query parsing/serialization has actual
null dictionaries, tolerant byte decoding/options/separators, public hooks,
callable metadata and exact surrogate behavior. Punycode's identity stubs
are replaced by actual Bootstring/UCS-2/domain/email functions and version.
Its lazy cached owner executes the real warning call on actual first load.

The SpiderMonkey prefix classifies actual bounded saved-frame source names,
using the captured bootstrap source and Node-internal exclusions plus exact
node_modules component variants. Missing native frames fail explicitly.
Full frame-depth/ESM/native/worker/realm/load-warning and process/CLI policies
remain unresolved; no outside-runtime defect or platform exclusion is claimed.

Eight new plus 16 affected controls pass (24 total); new query controls use
actual candidate Buffer codecs over an explicit fixed allocator. Five
unchanged upstream files pass in candidate/native modes with native Buffer/
origin/warning boundaries. One earlier candidate Punycode setup-warning
failure is preserved, along with four candidate/five native passes. Awaited
standard preload setup retains both warnings without changing assertions.
Earlier passing focused source is historical, not retroactive evidence.

Recipe revision 54 changes source/bundle/prefix bytes, without a new engine
patch/syscall/import/wire ABI, guest compilation or product rebuild. Overall
suites remain deferred. See [query/Unicode dependencies](query-codecs-implementation-dependencies.md).


## OS frontend and POSIX state source slice

PROC-004/005 select full pinned os.js over new os-operations.h/native-os.cpp
and source patch 0069. Actual uname/hostname/home/passwd/temp/endianness and
priority owners replace release/version/root/user/no-op shortcuts. Raw passwd
bytes, retry/scratch ownership, HOME capacity, safe temp precedence and
SystemError/validation/descriptors use actual state and pinned algorithms.
The existing namespace identity remains shared with internal values owners.

Kernel getrusage/sysinfo are still zero/fixed accounting. This slice refuses
to present them as measurements: seven OS CPU/memory/load/interface/uptime/
parallelism APIs now explicitly fail instead of returning presets. They stay
implementation gaps. Partial constants and guest priority cross-process/
permission/scheduler semantics remain open, along with the existing five
process/heap/report false claims.

Seven new plus eighteen affected controls pass (25). The exact portable POSIX
header is compiled natively, with actual owned-process priority state and
explicit Native Buffer/UV/constants boundaries. Three unchanged upstream
files pass in candidate/native modes, including candidate preload propagation
to the homedir child and unmodified permission branches. Earlier passing
source is historical. No guest JSAPI/engine/package build or product rebuild,
no overall suite, merge or deployment. Recipe revision 55 binds source inputs;
no host import/syscall/wire ABI changes. See [OS dependencies](os-implementation-dependencies.md).

## Native DNS record marshalling foundation

N-001–005/013 remain partial. dns-records.h implements actual pinned c-ares
record parsing into independently owned completion data, selected by the
existing raw QueryResult owner after channel close. A/AAAA TTLs, CNAME/alias
records, MX/TXT/SRV/NAPTR/SOA/TLSA/CAA and ordered ANY records now have a source
owner, including Latin-1/embedded-zero text, signed SOA intervals, undefined
own fields, sparse holes, binary bytes and CAA ordinary assignment intent.
The full native/frontend references are retained and hash checked.

All 22 focused native loopback DNS scenarios match the exact native reference.
The earlier run's two missing-undefined-property failures and initial harness
environment failure remain preserved with identified inputs. Controls compile
only the portable native helper, reuse a verified unchanged pinned c-ares
library and retire channel/record owners before serializing owned values.
They run no overall suite and establish no guest/public Resolver conformance.

This is the dependency-ordered record foundation, not premature exposure of
Resolver/QueryReqWrap. Guest backend/engine linking, real channel/request/
ref/cancel/shutdown/owning-loop/JSAPI/GC/realm integration remain missing.
Malformed/escaped/compressed wire and all target error edges remain unresolved.
No engine package/product build or recipe/ABI change. Move to independent
source gaps before expanding this subsystem's validation campaign.

## Removal traversal and retry source slice

FS-012/014 remain partial. Exact public sync/callback/promise validation and
full async rimraf now replace legacy recursive rmSync reused as async I/O.
Actual native std::filesystem traversal follows pinned POSIX retry/error
policy; a real raw-byte directory scanner serves async child traversal through
an owned FSReqCallback and shared work queue. Patch 70/recipe56 stage native
source. No kernel/syscall/import/ABI or full product build is changed.

Twelve focused controls pass (seven removal, five affected directory). Eight
portable-helper scenarios and three unchanged upstream files in each of
candidate/native mode pass at distinct documented boundaries; repeated
frontend scenarios are not extra API coverage. One retained first-run fixture
failure came from overwritten fault injection; unchanged retry assertions now
pass. The guest JSAPI, sync retry timing and four-host runtime are unvalidated.

The full public readdir/Dirent/Dir owner is still required: current rimraf raw
scan dependency isolation differs from target public readdir replacement
interaction. It is a tracked implementation gap, not a platform boundary.
Extreme-option/error/permission/GC/realm/lifecycle and individual API closure
remain open; see removal-implementation-dependencies.md. Continue independent
families before broadening this subsystem's test campaign.

## Public util parser, diff and call-control slice

V-008/019–023 partial: full unchanged parseArgs/diff/debounce/throttle modules,
pure pinned Myers operations and real shared validators/timers/promises/abort/
clock/handled-promise dependencies now have owners. Patch71 records parsed eval
source in the existing CLI owner, captured before user code; recipe57 stages
changed bundle/bootstrap/patch source, with no guest build or ABI change.

Eight focused scenarios and four unchanged upstream files per candidate/native
mode pass. Nine parse-args child CLI checks are native only, not candidate CLI
coverage. Earlier seven-control/upstream stages and first selector-generation
failure remain retained. Current guest CLI/clock/timer/async/abort/GC/realm and
four-host behavior remain unvalidated. Native invisible lazy data-property
metadata is still missing for parseArgs/diff; its visible JS accessor is a
tracked implementation gap, including complete freeze/inheritance/realm
fidelity. No family or individual API is marked complete. See
util-algorithms-implementation-dependencies.md and continue independent work.

## Random jobs and OpenSSL threading source slice

Pinned randomBytes/randomFill/randomInt and UUID v4/v7 algorithms now have
source owners over real native CSPRNG and queued worker-job implementations.
Patch72/recipe58 stage the uncompiled JSAPI source. OpenSSL recipe5 fixes
a demonstrated concurrency crash caused by its prior no-thread configuration.
Normal resolver OpenSSL builds completed for wasm32 and wasm64, with actual
SDK symbol-link probes; neither probe was executed. The full product rebuild
and overall suites remain deferred.

Six algorithm scenarios, six affected sync controls and four unchanged
upstream files per candidate/native mode pass at their documented dependency
boundaries. A fresh threaded native provider control passed 512 operations
with isolated error queues. This is not 512 public API cases or guest
conformance. The prior SIGTRAP and source/fixture failures remain retained.

A real backing-store lease is still missing: native Node fills a transferred
destination while the candidate's copy-back source rejects the detached
original. Resource/resize/GC/realm/alias/CLI and guest integration remain
open. Domain still depends on fatal recovery/trampolines/weak ownership; it
was not exposed. No API or family is marked complete. See
[random dependencies](random-implementation-dependencies.md). The prior
447-source checkpoint is historical; a separate in-progress evidence record
identifies this slice until its complete source snapshot is finalized.

## StringDecoder public and incremental byte-state source slice

V-018/022/027/028 partial: unchanged full public StringDecoder now uses
actual seven-byte Buffer state and the shared private byte-codec owner.
Pinned normalization, accessor/proxy receiver behavior, fresh shared legacy
state views and incremental/flush algorithms replace the WeakMap/global
conversion implementation. Native field/encoding tags are source-generated.
Recipe59 stages the bundle/bootstrap; no new engine patch or guest build.

Five focused native differentials and two unchanged upstream files per
candidate/native mode pass. Two affected existing controls pass; nine
unselected cases stay skipped. The first scope-collision harness errors and
inputs remain preserved. No target assertions or skip conditions changed.
Guest initialization/Buffer ownership/errors/large allocations/GC/realm and
four-host runtime remain unvalidated; no API/family is marked complete.
See [decoder dependencies](string-decoder-implementation-dependencies.md).

## Native address/rules and actual TCP filtering source slice

N-006/007/011/018 partial: full pinned BlockList/SocketAddress algorithms
now use real native address/rule ownership. TCP constructors retain live
rules; outbound checks precede transport and accepted peers are filtered
before publication. Parser/hash/range/prefix/locking owners are real; net's
getter-only class exports and Stream alias follow the target source.
Patch73/recipe60 stage native inputs without a guest/product build.

Six scoped controls and three unchanged upstream files per mode pass at
documented portable/native boundaries. Thirty affected controls passed in
the later shared run; the corrected descriptor control passed alone with
17 unselected skips. Earlier runs/failures remain retained, not combined
into a fictitious all-green current run. Native handles reject cloning
until a real shared-owner messaging bridge exists. Full network/guest
conformance remains incomplete. See address-rules-implementation-dependencies.md.

## Incremental Hash/Hmac state and public stream classes

Full pinned constructors, copy/update/digest/Transform methods, validation and
public deprecation wrappers now use real native EVP/HMAC owners and the exact
pinned native encoding parser over shared private byte codecs. Hash caching,
copy lengths, zero-length XOF and Hmac finalization follow actual context
state. No facade KeyObject/CryptoKey classes or property-shaped keys are used.

Seven bounded frontend/native controls and five portable OpenSSL comparisons
pass at their explicit boundaries. The initial two frontend failures, helper
compile naming failure and generated-bootstrap comma error remain retained.
The normal targeted wasm32 engine revision65 was accepted after unchanged
upstream checks, optimization and fork instrumentation. No guest runtime,
overall suite or full product rebuild ran. Seventeen original observations
are linked for navigation, not marked complete; four unchanged upstream files
are cataloged but unexecuted. Real key owners, backend/options/FIPS parity,
backing-store/GC/realm/error accounting and four-host integration remain open.
See [incremental crypto dependencies](incremental-crypto-implementation-dependencies.md).
Continue independent audited owners, starting with persistent Dir resources.

## Persistent Dir cursor and native resource lifecycle

The full unchanged pinned Dir module now uses a real persistent libc cursor
and shared native FSReqCallback open/read/close jobs. Queues, sync concurrency
guards, recursive and async iteration, disposal, byte/type ownership and actual
conversion rejection have source owners. Native DIRHANDLE resources retain
pending work, retire cursors and defer GC diagnostics without calling JS from
finalizers; successful warning records are unreferenced, while fatal records
remain referenced. No public VFS or Permission Model support is fabricated.

Six frontend and seven native comparisons pass at their stated boundaries.
A controlled real-cursor EINTR case first failed, then passed after matching
pinned libuv's partial-batch discard/retry. Its failure/input/binary remain
retained; assertions and pinned module bytes are unchanged. A separate four-
branch JS delivery control checks Directory/FileHandle diagnostic policy,
without executing GC or proving native unref/scheduler behavior. Engines66
and67 compiled through the normal targeted wasm32 route;67 contains the retry.
No overall suite, full product rebuild or guest/four-host validation ran.
Twenty-four original observations are linked, with no individual API/family
closure. Four prospective upstream files remain unexecuted. See
[Dir dependencies](dir-implementation-dependencies.md). Move to independent
package-resolution owners rather than expanding filesystem-only validation.

The package-reader/native parser-cache and live TLS metadata/verification
slices subsequently reached normal targeted engine68/69 acceptance. Their
dependency records retain unresolved loader resolution and full TLS/socket/
context/descriptor/lifecycle requirements. No family is complete, no overall
suite ran and no full product rebuild occurred.

The public Buffer constructor/shared pool and actual engine detach/native
zero-fill owners subsequently reached targeted engine70 acceptance. Their
dependency record keeps arbitrary-object worker marks, remaining byte/realm/
CLI/error/lifecycle contracts and four-host execution open. Continue actual
CJS/ESM package policy and other independent owners before broader suites.

The actual c-ares Resolver/channel/record and shared external completion
owners reached targeted engine72 acceptance, including its normal SDK-built
dependency. Native-boundary controls remain separate from guest/four-host
conformance. See dns-channel-implementation-dependencies.md; no family is complete.

Owned engine message packets, close acknowledgement and actual adapter links
reached targeted engine75 acceptance, reusing the exact pinned dependencies. Native-boundary controls remain separate from guest/four-host
conformance. See port-packets-implementation-dependencies.md; no family is complete.

The subsequent resource-usage slice reached targeted engine76 acceptance.
Five previously tracked wrong-success numeric/report/space values are removed;
actual nominal GC budget is measured, while guest usage/report/space providers
remain implementation gaps. See resource-usage-implementation-dependencies.md
for original evidence, native/guest scope and remaining requirements. No
overall suite/full product rebuild or family closure is established.

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

## Pathname metadata source slice

Recipe91 adds the18 public sync/callback/promise pathname metadata methods,
real POSIX sync/queued owners, shared UV system errors and final-symlink
timestamp selection through kernel and Node-backed host adapters. OPFS's six
metadata mutation no-ops now report ENOTSUP; real persistent metadata remains
missing. Nine frontend/host controls, one portable POSIX/native comparison,
two native Rust tests and eight unchanged upstream files per mode pass.
These are distinct scoped evidence dimensions, not API or four-host totals.
The host source typecheck still fails39 diagnostics outside changed files.
The original8pass/1fail frontend result is preserved. Neither guest engine91
nor the changed kernel has been compiled for Wasm. See
[path metadata ownership](path-metadata-implementation-dependencies.md).

## Argon2 source slice

Recipe92 reuses the complete pinned public Argon2 module and supplies actual
OpenSSL variants, optional secret/data, resource/provider, four-input snapshot
and threaded/default-context ownership. Four new and7 affected frontend
controls,12 native Argon2 and20 affected portable comparisons, and3 unchanged
upstream files per mode pass. These overlapping evidence dimensions do not
close crypto or establish guest/four-host conformance. Two initial native
compile failures and the first incomplete frontend invocation remain retained.
See [Argon2 ownership](argon2-implementation-dependencies.md).

## Performance timeline source slice

Recipe93 supplies pinned mark/measure/resource/function timeline/observer
owners over actual clock/clone/EventTarget dependencies, with seven public
interfaces and shared global/builtin instance. The inert zero-statistics
monitor facade is removed; native metrics/histograms remain explicit gaps.
Seven new and36 affected controls pass. Eight unchanged upstream files pass
in native mode; adapted mode is7pass/1fail at the missing milestone provider.
The failure, source-check harness error and complete evidence are retained.
No native/guest compile, overall suite or full rebuild ran for this slice.
See [Performance timeline ownership](performance-timeline-implementation-dependencies.md).

## Public SourceMap source slice

Recipe94 reuses the complete pinned SourceMap class and installs it on the
actual Module owner. Five new/eight affected controls and one unchanged API
file per mode pass. The mixed upstream file still uses native cache/stack
lookup for those branches; it does not establish guest integration. Native
controls clarify retained constructor lineLengths/nested-section references
and copied getter/top-level payload arrays. Source capture/cache/stack/support
and other loader obligations remain open. No native/guest compile or overall
suite ran. See [SourceMap ownership](source-map-implementation-dependencies.md).

## Callback whole-file write source slice

Recipe95 selects unchanged public callback write/append and actual native
pathname/descriptor/byte/work owners. Five source controls, a portable native
comparison and four unchanged upstream files per mode pass. Native Node
queue/backing-store/descriptor dependencies remain explicit control boundaries.
The guest C++ job is uncompiled; sync/path-promise file jobs and full leases
remain missing. See [write-file ownership](write-file-implementation-dependencies.md).
