# Current public-contract reconciliation

Source checkpoint 136 adds real source/synthetic module records, graph linking,
live namespaces and evaluation ownership beneath the pinned public VM classes.
The real CLI now owns the experimental flag instead of leaving the JS gate
unreachable. Eleven dependency scenarios, 14 extracted-parser/native comparisons,
and 24 affected VM/package checks pass. These are not candidate engine results.
Cache, phases, attributes, offsets and deadline gaps remain open; combined
engine and four-host validation are pending. Overall suites and full product
rebuilds stay deferred. See [VM module scope](vm-module-record-integration.md).


Source checkpoint 135 fixes Worker argv coercion and option-getter order,
captures eval once, and supplies the classic eval argument through the real
startup configuration. All 32 source/native comparisons and two main-startup
controls pass, along with 11 affected port groups and 14 package checks.
Native lazy-property and Navigator observations remain prerequisites, not
candidate passes. Combined engine and four-host validation remain pending.
All 19 families remain partial; overall suites and full rebuilds are deferred.
See [Worker startup scope](worker-startup-integration.md).


Source134 adds real HDR/statistics/sliding-window histogram owners, unchanged
pinned public wrappers, native queued QRDE completion and packet-owned clone
material, together with process-owned retained-memory accounting. It preserves
one physical allocation across aliases,queues,cache/work and context retirement.
Root403portable rows+27imports and403NAPI public rows+75edges pass,as do48affected
frontend and14package checks. Four focused components compile through the SDK.
Actual engine JSAPI,clone/GC/VM behavior and four-host conformance remain open;
ELD is a separate pending source integration. All19families remain partial.
See [histogram integration and limits](histogram-retained-memory-integration.md).


Source133 adds a native per-context default-trigger owner, separate from
captured frames and execution IDs, and routes AsyncResource, ticks and existing
FS/DNS/codec constructors through it. Production adapter forwarders are covered
by one new control;21 affected async groups and12 package checks also pass.
Actual native numeric-owner/RAII/dependency controls pass;the retained native
callback fixture ID difference is not counted as execution-ID compatibility.
Combined117–133engine/JSAPI and four-host conformance remain unvalidated.
All19families partial;overall suites/full product rebuild remain deferred.
See [default-trigger integration](async-default-trigger-integration.md).


Source132 shares native string-byte primitives across JWK and hash/HMAC/cipher
updates. Original strings/encodings now reach native owned conversion;public
Buffer allocation cannot supply private native input.31root groups(including
96boundary cases inside one new group) and12package checks pass;the standalone
codec compiles to Wasm through the SDK. Private24,736byte/12,308affected-JWK/
226material results were identity-verified,not rerun. Actual native JSAPI and
combined117–132engine remain uncompiled;all19families partial. Overall suites/
full product rebuild stay deferred. See [private native bytes](private-byte-implementation-dependencies.md).


Source131 fixes receiver victim-root insertion with genuine own properties,
so inherited indexed setters cannot leak/drop roots or reenter before commit.
The NAPI packet fixture now mirrors production own-element definitions.
Original17matched public groups,2existing failure groups,4native/7candidate
prototype groups and12package checks pass;old receiver and old fixture fail
the new assertions as expected. Production JSAPI/combined117–131engine remains
uncompiled;all19families partial. Overall suites/full rebuild stay deferred.
See [indexed receiver ownership](worker-locks-prototype-fix.md).


Source130 removes public Buffer allocation/JavaScript callbacks from native
JWK byte ownership,preserves OOM/control failures,and roots material across
reentrant getters and foreign-handle realm access.20root key checks(including
one new callback-forbidding group) and12package checks pass. Source-identical
private evidence contains12,308codec and226material passes;those were verified
by source/dependency/binary identities,not rerun. Four unchanged files retain
6passes/2consumer nonpasses. Combined117–130engine/JSAPI remains uncompiled;
all19families partial. Overall suites/full product rebuild remain deferred.
See [JWK review fixes](jwk-review-fixes.md).


Source129 adds a real shared worker-lock manager,receiver-local waiting and
released Promises,transactional grant/steal delivery and fair native-provider
dispatch.17public groups match exact native26;2fixture failure groups,
38affected controls and12package checks pass. One unchanged upstream
lock-diagnostics file passes both dependency-fixture modes. Portable owners
also compile through the actual SDK. These are scoped source/native controls;
production JSAPI/guest/four-host behavior is unvalidated. Lazy native-data
properties,global Navigator routing and earlier compatibility gaps remain open.
All19families remain partial;overall suites/full rebuild remain deferred.
See [lock integration and limits](worker-locks-integration.md).


Source128 selects the copy owner’s reflink header by actual availability.
Targeted engine127failed on an absent linux/fs.h selected by the existing
package macro;it also recorded an unresolved SDK calltypes-plugin crash.
Both failures remain saved. The corrected header compiles through the actual
SDK in normal and legacy-macro control modes.20zero-directory controls and
12package checks pass;the43-case portable matrix retains1errno mismatch.
Accepted engine116remains stale;source117–128is uncompiled as a full engine.
All19families remain partial;overall suites/full product rebuild stay deferred.
See [copy ownership](copy-file-implementation-dependencies.md).


Source127 routes filesystem copyFile sync/callback/promise wrappers through a
bounded descriptor owner and the existing real FSReq queue. Actual O_EXCL,
inode checks before truncation,metadata/cleanup and S_IFDIR rejection replace
the whole-buffer copy.35frontend and12package checks pass;two unchanged
upstream files pass in both native-dependency modes. The portable owner passes
20zero-directory controls;its43-case matrix retains1directory errno mismatch.
Guest117–127source is uncompiled;accepted116is stale. All19families remain
partial;overall suites/full rebuild remain deferred. See
[copy ownership and open differences](copy-file-implementation-dependencies.md).


Source126 adds real asymmetric JWK import/export over ncrypto/OpenSSL owners,
including RSA multi-prime,EC,OKP/AKP,private/public relation checks and native
own-property definitions. Eight new and61affected frontend controls and12package
checks pass. The reviewed portable owner has226passing native comparisons with
matching source/dependency identities. Four unchanged files in two modes retain
6pass/2candidate consumer nonpasses. Guest117–126source remains uncompiled;
accepted116is stale. All19families remain partial;overall suites/full rebuild
remain deferred. See [JWK ownership](jwk-implementation-dependencies.md).

Source125 installs the pinned public AsyncHook class with actual symbol/count
registry semantics,ordinary public functions and a stable ordinary root resource.
Eleven new and23 affected frontend controls,12 package checks and four runs of
two unchanged upstream files pass in explicit native-dependency scopes. The
initial regression exposed a fixture floating-point grouping error; its failure
and preimage remain retained. Guest117–125source remains uncompiled;accepted116
is stale. All19families remain partial;overall suites/full rebuild remain deferred.
See [AsyncHook ownership](async-hook-registration-implementation-dependencies.md).

Source124 adds actual per-context loop-start/idle measurements and the full
pinned event-loop-utilization calculation. Six new and seven existing frontend
controls, six portable clock-owner checks and12 package checks pass in their
recorded scopes. The complete unchanged upstream ELU file passes natively and
fails against the candidate at missing NodeTiming milestones; that failure is
retained. Selected shell-file patch composition is checked from the canonical
Mozilla archive. Guest source117–124 remains uncompiled; accepted116 is not
current. All19 families remain partial; overall suites/full product rebuild
remain deferred. See [loop measurements](loop-metrics-implementation-dependencies.md).

Source123 adds actual EC/OKP/PQC raw-key imports, exact algorithm spelling,
point/scalar/seed validation, public-role projection and pinned provider
encoding initialization. Four new frontend comparisons and23 affected controls
pass, alongside92 portable byte/error comparisons,18 affected material-owner
comparisons and two runs of one unchanged upstream file. The614-input source
guard and12 package checks pass. These are separate evidence scopes, not API
closure. Guest source117–123 is uncompiled; accepted116 is not current. All19
families remain partial; overall suites/full product rebuild remain deferred.
See [raw key ownership and evidence](raw-key-implementation-dependencies.md).

Source122 adds pinned logical/native realpath, readlink and full glob traversal
using real POSIX byte results/queued requests and shared Dirent/stat owners.
The private URL-or-path converter now serves filesystem consumers. Sixteen new
and37 affected controls,16 portable byte/error comparisons and eight unchanged-
file runs pass in their explicit native-boundary scopes. Guest source117–122
is uncompiled; accepted116 is not current. All19 families remain partial;
overall suites/full product rebuild remain deferred. See
[path/traversal ownership](filesystem-traversal-implementation-dependencies.md).


Source121 installs the pinned shared warning owner and actual CLI option
source for filtering, trace/deprecation policy and redirect-file lifecycle.
Sixteen new frontend and47 affected controls pass; one known environment-clone
fixture nonpass remains. Four unchanged-file runs and14 portable parser
comparisons pass in their explicit native-boundary scopes. Guest source117–121
is uncompiled; accepted116 is not current. All19 families remain partial;
overall suites/full product rebuild remain deferred. See
[warning ownership and evidence](warning-implementation-dependencies.md).


Source120 adds real borrowed-stdin terminal mode leases, pinned mode/error
policy, actual window queries and transport/context/GC cleanup. Five native-
boundary frontend comparisons, four affected stream controls and one portable
PTY/native comparison pass in their recorded scopes. The guest binding and
117–119 source remain uncompiled; accepted116 is not current. Public TTY classes,
signals/drain and four-host conformance remain open. All 19 families are partial;
overall suites/full product rebuild remain deferred. See
[terminal ownership and evidence](terminal-mode-implementation-dependencies.md).

Earlier revision checkpoints below retain their historical scope.

Source revision119 adds pinned Module.wrap/wrapper owners and actual patched
script compilation, preserving the ordinary function compiler. The shared
invocation now snapshots exports once for receiver/argument identity. Eight
new and fourteen affected frontend controls pass; two unchanged upstream
fixtures pass in candidate/native modes. Guest compilation and four-host
conformance remain pending; accepted116 is not current for source117–119.
Earlier guest failures and all 19 incomplete families remain open. Overall
suites/full product rebuild remain deferred. See
[wrapper ownership and evidence](module-wrapper-implementation-dependencies.md).

Earlier revision checkpoints below retain their historical scope.

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


Current follow-ups: [upstream AssertionError/shared validators](assertion-error-implementation-dependencies.md)
and [accepted kernel/three actual environment guest cases](kernel-admission-integration.md).
Earlier recipe-specific statements below retain their historical scope.


This is an implementation-phase companion to the frozen
[source audit](../audit/audit-report.md). Original obligations, unresolved
questions and historical nonpasses remain intact. The exact Node 26.13.0
source/native pins are unchanged. Recorded official-source research remains
historical; this document makes no new release-availability claim.

All 19 families now have implementation-phase work started, including this
documentation/capability/deprecation crosswalk. **None is complete.**
Starting a family does not mean its audited APIs were implemented or that
the breadth-first pass is ready for overall suites. The current combined
candidate still lacks four-host guest conformance evidence.

Engine107 now has three passing native/actual Node-host guest environment
controls after canonical targeted kernel admission was repaired. The standalone
native dependency report remains16cases:15pass/1fail; its custom V8 interceptor
snapshot rejection is preserved independently. Full environment prototype,
constructor, ordering, warnings/TZ/permissions, shared worker stores and engine
lifecycle still need implementation and validation. See
[admission and identified guest outcomes](kernel-admission-integration.md).

Source108/109 replaces the handwritten AssertionError, six generic assertion error
constructors and the separate primordial subset with pinned Node error/diff
algorithms and the existing shared errors/validators/colors. Focused native
controls and four unchanged upstream files pass. Corrected109compiles and has
4pass/1fail among five actual Node-host guest cases; the diagnostic failure
retains extra native Error own keys. All108bootstrap failures remain recorded.
Error construction/shape, stack recapture/filtering, source expressions,
complete inspection and four-host conformance remain gaps. See
[assertion owners and evidence](assertion-error-implementation-dependencies.md).

Source110 adds an embedding option for non-standard native Error location
arguments/properties, selected before root/worker globals and inherited by VM
realms. The original diagnostic case now passes. Eight actual Node-host guest
cases record7pass/1fail, with complete generic Error reflection still failing
at the own lazy stack/prototype contract. One standalone shell preservation
case passes separately. See [Error owners/evidence](error-location-implementation-dependencies.md).

Source111 reuses pinned URL/file-path/byte-path/HTTP-option algorithms over
the shared parser and actual Buffer/path/error/platform owners. Source/frontend
controls pass, and upstream outcomes retain6pass/2actual-macOS skips. These
bytes are guest-uncompiled; accepted110is not current for this candidate.
The frozen V-036 URIError sentence is inconsistent with the pinned source and
native reference; its resolution is recorded without modifying the audit.
See [URL/path owners, evidence and remaining gaps](url-path-implementation-dependencies.md).

Source112compiles shared/growable native codec/work queue leases and
synchronous resizable codec/dictionary/CRC views. Actual Node-host comparisons
record3pass/4fail. All original public assertions finish successfully; raw
byte traces explain the four gzip checksums by the unchanged native-macOS19
versus guest Unix-default3OS byte. Failures are not relabeled as passes.
Ordinary async resizable/transfer/lifecycle obligations remain implementation
gaps. The unchanged111URL/path JS is compiled in112but has no new focused
guest helper evidence. See [storage owners and bounds](compression-storage-implementation-dependencies.md).

Source113adds actual SQLite scalar/aggregate/window registrations, GC-traced
callback and accumulator state, native parent-handle retention and whole-call
session pins. Its targeted engine compiles/admission passes. Current scoped
comparisons record3pass/6fail; eight native expectations pass and one fails.
Successful return/group/window cases do not establish error/constructor/session
or whole-family conformance. See [callback owners and evidence](sqlite-callback-implementation-dependencies.md).

## Family source routes and remaining owners

Paths below are under third_party/node-core unless stated otherwise.
Every slice remains partial. The original family reports retain the rest
of the APIs, overloads, inherited members, symbols and open questions.

| Family | Current shared source routes | Remaining owner requirements |
|---|---|---|
| Values | pinned URL/path/byte-path/HTTP-option helpers over shared parser and platform owners; generic native Error location policy; pinned AssertionError/Myers diff and shared validator/error/color/primordial owners; values/util/UV/dotenv/MIME/Buffer/path owners and full querystring/punycode algorithms with saved-frame load-origin source; pinned util/StringDecoder owners and callable Buffer/shared aligned pool/permanent storage/zero-fill source ; source140/146 actual retained-allocation capability and USER_OWNED commit source; source186 existing parseArgs/diff now consume genuine native lazy DATA owner; full pinned styleText/cache/hex over actual stream/TTY/color owners; actual fs.constants null-prototype allocator source corrected; guest dependencies/GC remain open; source189 complete unchanged sys source and pinned builtin initialization method retain actual util identity/cache/reentry/retry and real DEP0025 warning origin; ESM fixture/guest warning conformance remains open; source192 one real conditional SDK/OpenSSL OS/crypto bag, shared key/cipher consumers, exact lazy public crypto/constants load/cache/retry and distinct frozen legacy aggregate; actual TLS-cipher CLI state; guestJSAPI/TLSconsumer/fullcrypto open | Original allocation foundation and selected FS/codec routing are source-only; actual engine/GC/realm/transfer and remaining Buffer/util/URL/IDNA/error/descriptor/CLI/loader/warning behavior and four-host conformance remain open |
| Async | Pinned public AsyncHook/createHook algorithms over real symbol/array/count registry,nested publication and native destroy tracking;133native per-context default-trigger override with public/tick/Promise fallback and existing FS/DNS/codec consumers;ordinary public metadata/root resource and callback owners ; source149 actual native execution stack/epoch/process recovery and explicit callback failure ownership; source178 complete unchanged public Domain owner loaded lazily over actual shared EventEmitter/AsyncHook/process-fatal owners; bounded native MakeCallback registration and actual FS/stat consumers | Promise activation/removal and ALS CLI path,remaining native providers/default-trigger consumers,GC/destroy/rejection/fatal/worker/realm/loop/cancellation/ref integration and actual117–149guest/four-host conformance remain open |
| Streams | stream/fd-stream platform adapters and shared pinned StringDecoder public/byte-state owner | Socket/TTY/file subclasses, backing-store transfer, fd reuse/retirement, pipeline/adapter lifecycle/errors and guest decoder integration |
| Filesystem | Real bounded descriptor/queued copyFile owners with atomic exclusive open and actual zero-size directory type handling;hard-link,temporary-directory,logical/native realpath/readlink and full glob owners join pinned file jobs/handles,Dir/readdir/Dirent,metadata,removal and sync/callback/promise byte algorithms ; source145 metadata polling/StatWatcher owner and source146 original scalar/vector/write-job allocation spans; source147 pinned recursive cp/native worker owner; source152 actual ReadFile allocation/capacity owner through USER_OWNED handoff; source166 reusable native root value clear preserves registration | Current173engine compilation/link/normal checks and cache acceptance passed; current product/runtime acceptance remains unestablished. Source149 recovery routes the historical cp callback mismatch; actual guest after-hook recovery remains unvalidated, actual native class/GC/realm/VFS acceptance, copy/shrink differences, cursor/GC/ref/OOM/realm and fd/byte-path/backend integration; notification watchers/VFS/metadata/permissions/timestamp precision/statfs and FS-022 host-path gaps remain open |
| Processes | bootstrap process/ChildProcess, process-clock/state/usage validation and explicit absent numeric providers, dotenv/child-wait, pinned OS frontend with native POSIX state, unchanged weak finalization/lazy descriptor and Refable dispatch; actual linked dependency versions with read-only/configurable version descriptors; native live environment virtual Object/property hooks and inherited-receiver policy ; source148 real runtime-owned original locale/ICU canonicalization and private bootstrap capture; source162 actual main-only sigaction/self-pipe SignalWrap and pinned first/last-listener activation with target-compiled signal names, real native close/async roots and reviewed loop fences; source166 reusable native root value clear preserves registration; source168 ChildProcess.kill public errors use pinned ErrnoException and actual compiled UV map; source190 actual async-spawn supported stdio admission precedes pipe acquisition; fixed owned slots and rollback retain both real ends; native pair publishes own properties; all placements consume pipe sources before child closes, preserving legitimate numeric fd reuse; full normalization/error/stdio/guest open | Complete environment prototype/constructor/keys/warnings/GC/JIT/clone and worker/TZ/CLI behavior, fatal/rejection/GC/exit/worker/resource reference integration, signal/IPC and exceptional wait/close policy, measurements, permissions and OS metadata; guest lifecycle/mask/parent/env conformance pending; custom/coverage handler EBUSY, privateTTYactivation and actual SignalWrap/guest/four-host semantics remain open |
| Network | native address/rule state, pinned BlockList/SocketAddress and live TCP consumers; queued lookup, actual c-ares channels/record JSAPI/external-completion source and libc/kernel/host routes; source160 actual TCP descriptor/read/original-write owners, private callbacks/shared prototypes/async aliases, accepted-fd lease/rollback and keepalive controls; source165 pinned dgram over actual UDP endpoint/sendmsg/original-allocation request/callback/ref/shutdown owners; source166 reusable native root value clear preserves registration; source167 shared scoped IPv6 byte-address parser feeds real c-ares local/server/reverse consumers; source170 actual accepted TCP owner initializes before null-prototype publication and transfers once; accept watch unlinks before JS reentry; source171 focused DNS fixture uses genuine native histogram/ELD dependencies (test setup only; no runtime API change); source177 generic Server call/new/subclass/supplied-receiver initialization and captured per-listener JS ownership; pinned options/field/descriptor policy and actual accepted-socket controls | Guest rule/clone/worker integration, full Socket/Server controls/lifecycle, Resolver configuration/permission/JSAPI lifecycle integration and datagram owners; source/native controls are not guest conformance; accepted-init timing, legacy accept identity/concurrency and full public Socket/Server behavior remain gaps |
| HTTP | Pinned outgoing headers/full IncomingMessage and unchanged common parser callbacks; actual Node-vendored llhttp/private GC-owned response framing, strict/insecure/relaxed limits, interim/HEAD/upgrade/CONNECT source; unconditional pooled replay and same-feed leftover reuse removed ; source138 full pinned OutgoingMessage/request framing and response-consumption/writable-finished reuse fence; source160 pinned plain Agent queue/pool/selection/proxy/control owners with real reusable-socket timeout reset ordering; source164 pinned HTTP2 settings helpers, source-derived protocol constants and genuine sensitiveHeaders symbol; source176 real request llhttp framing/IncomingMessage and pinned ServerResponse; actual compiled public35/parser47 method catalogs replace reduced list; fullServer remains gap; source181 actual synchronous request-header decisions inside llhttp over a captured original allocation and genuine existing request consumer; fullServer/parser reuse/body callbacks/ConnectionsList remain missing | Synchronous native-to-JS callback/reentry/byte/memory/error/EOF integration, OutgoingMessage/request framing, idle bytes/public Agent/TLS pool keys, servers/request parsing and complete HTTP/2 sessions/streams/server/transport; guest/four-host lifecycle remains unvalidated |
| Secure network | TLS identity algorithms, actual live OpenSSL protocol/cipher/reuse/Finished/verification metadata source, shared IP/domain helpers and transports ; source142 eager trust capture, real SSL_CTX/SSL ownership, verification rejection and owning-realm handling; source182 shared actual SSL_CTX certificate/issuer/private-key/PFX owners consumed before TCP; full SecureContext/error setter/guest semantics remain open; source196 real lazy mutable TLS defaults/actual CLI cipher state and live SSL_CTX cipherlist/TLS1.3 suites/min-max protocol policy before credential admission; full SecureContext/Agent/lower TLS/JSAPI/fourhost incomplete | Complete socket/context/trust/key/certificate/handshake/session ownership, metadata/error/descriptor fidelity, secure pooling/servers and DTLS/QUIC |
| Crypto | Pinned random/KDF/digest/Hash/Hmac/HKDF/cipher and real key material;130JWK failure/material/realm fixes;132shared pinned native private string-byte primitives with original string/encoding hash/HMAC/cipher consumers; source157 real X509 certificate/material/key owner with pinned wrapper, metadata/checks and checked-unwrapped constructor view acquisition; source159 checked rooted/no-GC byte-source consumption and original-allocation async random ownership; source172 public parsePKCS12 owns actual OpenSSL parsing and transfers genuine key/X509 material with cleansing inputs; source185 owned native OpenSSL queues/primary-secondary decorations and genuine intrinsic Errors with ordinary Set;7adapters and sync-random bootstrap preserve original Error identity; full per-API errors/JSAPI/guest remain open; source187 four actual one-shot RSA transforms consume unchanged wrappers, immutable key material and captured original input range through real ncrypto/OpenSSL operations and implicit-rejection query; guest/STORE/provider/fullcrypto remain open; source193 four real streaming Sign/Verify APIs use complete pinned source and genuine native digest/key/bytes/error/finalization owners through actual shared constants; one-shot/STORE/JSAPI/guest remain open; source195 actual one-shot SignJob synchronous original-span/asynchronous owned snapshots, ncrypto/OpenSSL operations and genuine SIGNREQUEST/queue/callback owners; component ALS/frame nonpass and guest/provider/fatal gaps remain | Current173native PKCS12source compiled/linked and normal checks/cache acceptance passed; actual JSAPI behavior remains unvalidated;sign/WebCrypto/cipher nonpasses retained;actual UTF8/BufferSource/GC/OOM/native-byte JSAPI,asymmetric pressure/worker transfer,store/PKCS12,WebCrypto,generation/exchange/signatures/certificates,FIPS/provider transitions and four-host obligations; X509 matching/issuer graph/legacy/clone, full OpenSSL accounting and actual constructor realm/GC paths remain open; allowed/denied CCWs, actual allocation/worker races and sync-KDF init-stage semantics remain unvalidated |
| Web | File/FormData/Headers, private header guard/list consumers, Blob/clone and Web Stream owners; source156 pinned Body consumption/MIME/multipart owners over existing actual Response/header/stream state; source171 complete pinned Request/Body algorithms share actual Headers/WebIDL/Blob/FormData/abort/streams; HTTP consumer publishes actual body stream; source183 complete unchanged pinned Response private state/statics/Body/Header/clone owners share Request and existing actual HTTP publication; full Fetch transport/policy and guest conformance remain open | Full Fetch transport/controller/redirect/filter/CORS/cache/decompression/backpressure and abort/upload policy; current pinned Request/Response/Body algorithms still require actual guest dependency/stream/clone/WebIDL/encoding/URL/GC/realm/worker evidence and all-four-host conformance |
| Loading | Partial pinned Module.wrap/wrapper and patched-script source owners with single exports snapshot; Real native parser goals and direct CJS body compilation, pinned filename/package/entry selection and shared ESM source format in103; Module record/require/JSON, package cache/reader, exports/imports/conditions/self/maps and SourceMap algorithms; source153 pinned synchronous CJS hook registration/chaining/disposal, actual supplied-source execution and resolver/cache transactions; source180 real fullURL/type/source/import-attribute native registry/synthetic owners, exact Merve CJS exports and prepared-source transactions; shared sync resolve/load/mock hook owner and actual CLI activation | Actual guest parser/error/source/realm evidence; complete ESM supplied-source execution/hooks, async loader workers, remaining CJS/CLI/cache behavior and ESM URL/namespace/JSON/async/cycle/dynamic-import graphs; TypeScript/Wasm/addon/source-map/cache/preload/CLI/permission/lifecycle owners; four-host conformance |
| Terminal | Pinned shared/callback/promise readline,history/key/cursor owners plus120actual borrowed terminal-mode leases and window queries; source161 pinned stdio output cursor/color/window methods and real verified independent-OFD blocking output with checked/rooted lease/view realm acquisition; source163 captured real output owner also supplies size/resize and same-number reopen is promoted before dup; source191 actual captured input/OFD/mode/read lease and exact Promise/ref/cancel/close owner feed real fd-readable stdin; curated OS tuple forwarding fixed; matched native diagnostic preserves original restoration failures without mode fix; public TTY/guest open | Full public TTY/stdio classes,signals/resize/drain,Unicode width,persistence/permissions/REPL and guest lifecycle/stream/symbol conformance; master/unreopenable backpressure nonpass, partial/EAGAIN queue, broader arbitrary-fd/concurrent-close behavior and privateSIGWINCH gaps retained |
| Workers | Real shared lock manager, transactional receiver delivery and dual-Promise lifetime with fair provider dispatch; native thread/context/input/error/join owners and connected packets; source 135 captures Worker argv/eval at the pinned constructor stage and constructs the real startup vector with array-like semantics ; source143/144 native lazy DATA property and actual Worker locks adapter routing; source155 real deferred Locks native zero-ID/default-frame delivery and guarded scope restoration; source194 actual native public MessagePort class, consume-once endpoint sidecars, receiver/abort transactions, source-close roots and real transfer-list ordering; transitive cycle collector/generic transfer/JSAPI/guest remain incomplete; source194 actual native public MessagePort class, consume-once endpoint sidecars, receiver/abort transactions, source-close roots and real transfer-list ordering; transitive cycle collector/generic transfer/JSAPI/guest remain incomplete; source197 actual process-shared native graph over real wrapper/packet/worker/read roots and inbox/clone-data edges; automatic unreachable transit-cycle retirement at real loop/API/context safe points; JSAPI/generic transfer/fourhost remain open | Native lazy-data compiled in173with normal checks/cache acceptance, but runtime behavior is unvalidated; special/global object cases and Navigator remain gaps; actual guest thread/clone/context/stdio/options/resource/ref/failure/termination behavior and combined 117–148 engine remain unvalidated. Prior lock termination/query-order nonpasses and full four-host obligations remain open |
| Compression | Pinned codec/archive/iterable JS and native contexts; historical112 limited shared/growable queue controls; source146 replaces queue pins with actual original allocation spans, native write-state ownership and retained params spans | Current173native source compiled/linked and normal checks/cache acceptance passed; runtime acceptance unestablished. Actual JSAPI/GC/realm/detach/resize/shared-codec races and public modes/options/iterators/files/cleanup/cancellation/accounting remain open; historical gzip OS-byte mismatches retained; current four-host conformance unestablished |
| Observability | Pinned Console/diagnostics/TCP/DNS producers,Performance timeline/entry/observer/resource/timerify and process-origin clock;124real loop-start/idle and ELU arithmetic;134real HDR/statistics/window owners,public histogram wrappers,queued QRDE,packet clone material and shared retained-memory ledger ; source139 real event-loop-delay sampling/ref/close owner and145shared cached clock| Current173native compilation/link and normal checks/cache acceptance passed;actual JSAPI/GC/VM/clone/cancellation/pressure and realm retirement remain open;actual ELD producer and timer-phase/GC/ref behavior unvalidated;other milestones/counters/GC/network producers,inspector,tracing/reporting and four-host conformance incomplete |
| Engine | Generic Error location policy and actual VM/context/compiler owners; source 136 adds pinned public module classes over actual source/synthetic records, live environments, graph/link/evaluation/namespace hooks and native experimental CLI state; source151 actual realm/rooted-array/shared-buffer API compilation corrections; source158 actual shared-buffer header alignment correction retaining original assertion/ownership; source166 actual metadata visibility/retained transfer maximum access corrections; source173 canonical native includes/inline dependencies and genuine third-party vendor staging preserve unchanged normal Mozilla style checking; source174 real scoped synchronous VM watchdog/frame/interrupt ownership with target-realm termination;174newbinding uncompiled relative to accepted173 | Current173engine compiled/linked and normal checks/canonical cache acceptance passed; product projection and guest/four-host validation remain open; actual graph/GC/realm/dynamic Promise execution and all four hosts unvalidated. Arbitrary attributes, source/defer phases, negative offsets, cache/deadline scopes, sandbox exotic properties, heap/inspector and broader context/worker gaps remain open |
| Testing | Full pinned Test/Suite/harness/utils execution owners; actual native-frame caller location route and source-derived default option state, mock/reporter owners; source169 actual CLI snapshot-update flag/admission/projection reaches existing snapshot option reader; source180 real MockTracker module resolver/hooks/cache/restore and actual caller/CLI owner, shared with generic source graph | Guest execution/async/fatal/phase/context/cleanup integration; discovery/run/CLI/isolation, snapshots/module mocks, measured coverage/benchmarks and complete lifecycle |
| Native integration | SQLite scalar/aggregate/window registrations and GC-traced native callback/parent/accumulator owners compiled in113; real SQLite statement/iterator/column/limit/defensive/session/change-set and rooted synchronous callback owners, native virtual limits and actual activation; source154 actual statement close/dispose, executing-VM guards and reentrant-safe native retirement; source175 actual asynchronous sqlite3_backup/page-step/native-job ownership with pinned public frontend and serialized-backend guard;175JSAPI uncompiled; source179 unchanged public WASI lifecycle plus25real guest-POSIX/import owners and actual memory/descriptor/rights/accounting state;21imports/directWasm numeric dispatch/guestexecution backend remain missing; source184 real DynamicLibrary/dlopen/dlsym/dlclose ownership via existing outer guest loader, exact selected constructor/aliases, actual CLI/registry/drain/shutdown and checked-wrapper preservation; full FFI/JSAPI/guest remain open; source188 actual20scalar/raw/string/copy/borrowed memory owners and unchanged export helpers; genuine metadata-only aliases/private Buffer prototype; shared main/Worker/destructor retires real consumers before library unload; guestJSAPI/cancellation/fullFFI remain open | Database disposal suppression/serialization and remaining Statement receiver/reset/iterator semantics; complete scalar/aggregate/window error/reentry/GC policy, authorizer/virtual-table callbacks; complete limits/reflection/storage/GC/realm/accounting, tag cache/backup/extensions, FFI/WASI/SEA/addons/embedding and ABI/loader |
| Documentation | This reconciliation and original requirements | Actual warning/origin/CLI/environment/activation behavior and unresolved target prose/source questions |

## Measurement and capability gaps

* Process CPU/thread/memory/RSS/resource algorithms now use exact pinned
  validation/delta/field source. Guest numeric providers remain missing and
  reject explicitly; kernel getrusage zeros/elapsed CPU approximations are not
  reused as measurements. Host totals are not guest totals.
* process.report.getReport now rejects instead of inventing a musl loader
  pathname. Complete real report/loaded-object ownership remains missing.
* The partial v8.getHeapStatistics heap_size_limit field reads the actual
  nominal configured engine JSGC_MAX_BYTES soft budget. Other required fields,
  effective memory ceilings and cross-engine metric correspondence remain
  unresolved; this is not full V8 statistics or reachable heap capacity.
  getHeapSpaceStatistics rejects instead of returning an unmeasured empty list.
* features/config/moduleLoadList remain incomplete capability/configuration/
  activation metadata; removing five numeric/report wrong-success literals
  does not complete those owners or establish API compatibility.
* DNS resolve now has actual native c-ares channel/query and record conversion
  source behind the full pinned public callback/promise modules. Configuration
  refresh/permission/guest lifecycle and host egress remain implementation and
  validation requirements. Host routing addresses are not actual DNS records.
* Namespaces/copied references do not establish execution. Worker.terminate
  now uses actual per-worker stop/join/exit state; test/suite/hooks use real
  pinned execution owners, while discovery/run still rejects.
  Standalone mocks, queues and formatting do not close those operations.

## Deprecation and activation correspondence

The public util slice now owns DEP0044/isArray and DEP0060/_extend wrappers
and the target deprecate options wrapper. Removed legacy predicates are
absent. This does not complete warning flags, origin filtering, stacks,
process warning policy or every deprecated caller. Pinned SQLite retains
DatabaseSync/StatementSync documentation-only aliases DEP0210/0211.
Documentation-only status must not introduce runtime warnings. DEP0132
Worker termination still requires a real per-worker settled exit result.

Other codes retain their original requirements and open owner dependencies.
Buffer's callable constructor/DEP0005, punycode DEP0040, URL DEP0169,
FileHandle/Dir GC policy, fs/zlib/child callers and deprecated private-module
activation cannot be inferred from literal codes in a bundle. Flags,
NODE_OPTIONS, complete environment policy, loader origin and stacks need
their actual owners. Rejected unsupported options are not activated APIs.

The process-state slice now supplies real libc environment mutation and
enumeration, a live parent getter and the actual creation-mask owner.
It does not complete worker environments, TZ refresh, exotic-object
metadata or warning/trace/CLI activation. The dependency record separates
native helper/frontend evidence, exact compiled artifacts and three actual
Node-host guest environment cases; it does not establish broader process
semantics or browser conformance.

## Four-host boundaries and evidence

All hosts execute shared guest SpiderMonkey/bootstrap code. Native-backend
controls substitute native engine/OS dependencies; standalone C++ controls
do not compile the engine bridge. Historical product evidence remains tied
to its recorded artifacts, not the combined candidate.

Transport, DNS policy, entropy, monotonic time, memory budgets and worker
teardown differ at their actual host adapters. Outer native APIs do not
automatically implement guest APIs. Browser sandbox limits need individual
API evidence and a concrete boundary; missing guest algorithms, bindings,
providers and lifecycle remain gaps. V8 bytecode/snapshot formats, direct
V8 C++ ABI and CPU-native artifacts need specific architecture decisions;
they do not exclude portable VM/diagnostic/stream/loading behavior. This
reconciliation accepts no new exclusion.

## Dependency-based next pass and later validation

Continue shared state/metadata, errors/brands/bytes, native resource/GC/ref
ownership and scheduling. Complete transport/Resolver and fd/filesystem/
process ownership alongside independent portable algorithms, then their
HTTP/crypto/web/worker/loader consumers. Follow the existing VM, SQLite,
stream, worker and testing dependency documents rather than adding facades.

Before overall suites, reconcile remaining original findings against the
combined candidate, including inherited/returned/symbol/gated APIs and
shared prerequisites. Nineteen started families do not close that work.
Then identify exact build artifacts, honor the full product rebuild
deferral, and validate unchanged upstream assertions/native controls on
every applicable host. Preserve failures/skips/unsupported/timeouts/harness
errors separately; none are passing compatibility. Source changes cannot
silently promote or reset historical results.

The IncomingMessage/client-consumption slice was staged as recipe77 and
compiled with the subsequent normal targeted engine78. No guest HTTP
behavior is validated by the separate VM controls. See
[HTTP IncomingMessage dependencies](http-incoming-implementation-dependencies.md)
for exact focused evidence, retained harness failures and remaining owners.

The subsequent Worker source replaces minimal-prelude/JSON/shared-mailbox
launch with per-worker native context/thread/packet/endpoint ownership and
normal Node bootstrap/loader, ready/error/exit and independent stop/join/ref
state. Patches86–88 reached targeted engine83 acceptance; six identical
native/Node-host guest cases pass. Options/stdio/fd/transfer/resource/lifecycle,
ordinary stamped-consumer and four-host obligations remain open. Recipe84
Test/Suite/harness source is uncompiled; native-boundary controls remain
separate from guest execution. See worker-owner and testing dependencies.


Recipe83's normal targeted engine build succeeded. Six identical native/guest
Worker case sources pass on the Node host, with prior startup nonpasses retained.
These are separate from options/stdio/fd/transfer/lifecycle/ABI/four-host closure.
Subsequent recipe84 Test/Suite/harness integration passes selected controls over
native dependencies and remains uncompiled in the guest; the combined current
candidate is therefore newer than the last accepted artifact. See testing and
worker-owner dependency records for exact sources, counts and remaining gaps.

Engine88 compiles the SQLite owner and testing integration plus real beforeExit/
SQLite activation prerequisites. Exact selected Node-host guest outcomes are in
sqlite-session-finding-progress.json. No family, ordinary stamped ABI consumer
or four-host conformance is closed; all original observations remain retained.
