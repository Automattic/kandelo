# SpiderMonkey For Kandelo

Revision 115 compiles real named broadcast groups and owned shared engine
message storage, including revision 114 temporary-directory owners. Normal
artifact admission succeeds; four same-source exact-native/Node-host guest
controls pass, including a real worker exchange and temporary-dir disposal.
Four-host and whole-family conformance remain unestablished; all 19 families
are incomplete and overall suites/full product rebuild remain deferred. See
[broadcast ownership and scoped evidence](../../../tests/nodejs/outline/broadcast-implementation-dependencies.md).


Earlier source revision 114 adds pinned temporary-directory and disposal APIs over
real libc creation, native FS requests and existing removal owners. Seven
new frontend controls, twelve affected controls, nine portable native-owner
scenarios and four unchanged upstream files pass within their documented
control boundaries. The changed guest source is uncompiled; accepted engine
113 is not current for this candidate. All 19 families remain incomplete,
and overall suites/full product rebuild remain deferred. See
[temporary-directory ownership and evidence](../../../tests/nodejs/outline/tempdir-implementation-dependencies.md).


Earlier source113 supplies real SQLite scalar and aggregate/window registrations,
traced callback/accumulator ownership and parent-handle retention. The targeted
engine compiles and passes normal artifact admission. Nine focused comparisons
record3pass/6fail: return conversions, groups and windows match; other cases
retain integration failures and one failing native-reference expectation.
No whole SQLite, overall-suite or four-host conformance follows. See
[SQLite callback owners and remaining work](../../../tests/nodejs/outline/sqlite-callback-implementation-dependencies.md).


Earlier source112 compiles the shared codec/work storage changes and the
earlier111URL/path bundle. Normal admission accepts the stamped artifact.
Seven focused Node-host comparisons record3pass/4fail; all public assertions
complete, and the four raw-byte mismatches are traced to gzip OS metadata
(native macOS19versus guest Unix-default3). Original failures are preserved.
Ordinary async resizable leases, complete lifecycle and four-host conformance
remain open. No overall suite or full product rebuild ran. See
[compression storage and evidence](../../../tests/nodejs/outline/compression-storage-implementation-dependencies.md).

Earlier recipe-stage statements retain their historical scope.

Historical source111 adds pinned URL/file-path/HTTP-option conversion algorithms
over the actual shared parser, Buffer/path and error owners. Focused frontend
controls record15pass; unchanged upstream files record6pass/2macOS skips
across candidate/native modes. The changed guest bundle is uncompiled;
accepted engine110does not validate these bytes. See
[URL/path owners and limitations](../../../tests/nodejs/outline/url-path-implementation-dependencies.md).

The last accepted artifact checkpoint follows.

Historical integration checkpoint: canonical targeted engine110 compiles the
shared Error location-extension policy. Seven of eight actual Node-host guest
controls pass, including the earlier assertion diagnostics and root/VM/clone/
native-error/worker location behavior. Full generic Error layout remains failed
at the own lazy stack accessor/prototype contract. The standalone shell's
extension-preservation control passes separately; it is not Node conformance.
The prior108/109and native environment-fixture nonpasses remain recorded.
All19families remain partial; overall suites/full product rebuild stay deferred.
See [Error construction and evidence](../../../tests/nodejs/outline/error-location-implementation-dependencies.md),
[upstream assertion ownership](../../../tests/nodejs/outline/assertion-error-implementation-dependencies.md)
and [kernel admission](../../../tests/nodejs/outline/kernel-admission-integration.md).
Earlier recipe-stage statements below retain their historical scope.

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

This package is the first SpiderMonkey port target for Kandelo. It builds the
upstream SpiderMonkey JavaScript shell from Firefox ESR as `js.wasm`.

Current scope:

- standalone SpiderMonkey shell (`js -e 'print(1+1)'`)
- wasm32 POSIX cross-build through `wasm32posix-cc` / `wasm32posix-c++`
- ECMAScript `Intl` support through Mozilla's in-tree ICU/ICU4X
- JS shared memory and shell worker support
- JIT disabled and C++ exceptions enabled
- normal Kandelo fork instrumentation after the final `wasm-opt` pass
- JS `worker_threads` support through clone/pthreads

Out of scope for this package:

- a complete Node-compatible embedding
- vendored npm-scale Node builtin modules
- npm / Express / Claude Code validation
- JS-facing nested WebAssembly compilation, which currently requires a
  SpiderMonkey wasm JIT backend while this package builds with JIT disabled

Those live on top of this engine port after the shell is green.

Build:

```bash
bash packages/registry/spidermonkey/build-spidermonkey.sh
```

Resolver build:

```bash
HOST_TRIPLE="$(rustc -vV | awk '/^host/ {print $2}')"
cargo run -p xtask --target "$HOST_TRIPLE" -- build-deps resolve spidermonkey
```


The unbuilt Node 26 source candidate depends on
[`node-codecs`](../node-codecs/README.md) for the codec variants bundled with
the exact Node reference source. Its recipe verifies producer provenance and
uses a private dependency sysroot. Patches 44–48 add native constants/version
calls, pinned codec contexts, actual guest pthread work/completions and native
resource ID/frame/finalization ownership and actual guest Buffer limits in
source. The pinned public zlib/ZIP and iterator algorithms use those handles
in the source candidate. Filesystem, Buffer and full AsyncWrap dependencies
remain incomplete; source integration establishes no working public API.

Engine revision 45 and the codec recipe have no compilation or four-host
conformance evidence. Callback/error/GC ordering, complete memory accounting,
shared/resizable/external leases, process exit/cancellation/fork and code/
heap/stack/browser budgets remain open. See the
[public integration source record](../../../tests/nodejs/outline/public-codec-source-status.json)
and [implementation ledger](../../../tests/nodejs/outline/implementation-review.md).

Patch 49 adds guest libc truncation and native filesystem request/completion
ownership on the shared work pool. Public pinned truncation functions use
this bridge in the unbuilt source candidate; kernel/libc syscall support was
already present. FileHandle and filesystem streams remain incomplete. See
[truncation source status](../../../tests/nodejs/outline/fs-truncate-source-status.json).

Patch 50 stages a native descriptor owner, actual close work and deferred
GC-close diagnostics with existing filesystem requests and the work pool.
Pinned public close functions use that bridge. Patch 51 stages native promise
I/O/stat/control and unpooled Buffer backing-store adapters plus generated
guest SDK filesystem constants. The shared source candidate connects pinned
FileHandle refs/close/methods and filesystem streams to the native owner. Event-loop/internal
callback/GC/exit/transfer/accounting and all four-host behavior are unverified.
See [owner source status](../../../tests/nodejs/outline/fs-owner-source-status.json).

FileHandle transfer/iterators/readLines, path fast jobs and remaining raw
callback I/O integration remain gaps. No compiler or runtime evidence validates
these changes; revision 45 stays unbuilt. See the current
[filesystem integration source record](../../../tests/nodejs/outline/fs-promise-source-status.json).


Patch 52 exposes real queued filesystem cancellation and synchronous native
open/read/write/vector bindings. Callback operations share actual native jobs
without replacement Promises; pathname stat/lstat run on the pool. Native
pathname diagnostics retain syscall bytes and decode through engine APIs.
Revision 45 remains uncompiled; callback/private-resource/error/cancellation/
memory/lifetime and all four-host conformance are pending. See
[the callback/sync source record](../../../tests/nodejs/outline/fs-callback-source-status.json).

Patch 53 stages the native read-file job with private create/run bindings.
Callback/promise pathname reads use actual FSREQCALLBACK owners, guest worker
I/O and allocation/fd handoff, while native opens use the SDK O_CLOEXEC flag.
This does not implement write jobs or detach-safe input leases. All compiler,
error/lifecycle/accounting and native/four-host evidence remains pending. See
[the read-file source record](../../../tests/nodejs/outline/fs-readfile-source-status.json).

Patch 61 adds private native getaddrinfo/getnameinfo request owners and actual
async-provider metadata, rooted SlowIo dispatch, owning-realm completion and
retirement. Compiler netdb constants and shared pinned numeric EAI translation
avoid host-assumed flags and the previous Promise bridge's incomplete mapping.
A native name-service helper matches the pinned native reference, but the
engine bridge remains uncompiled. Public pinned lookup/lookupService
frontends now use these primitives; complete callback-scope/metadata and
Resolver/record/transport implementation and four-host validation remain.


Patch 62 captures a real POSIX process time origin before engine startup,
exposes elapsed monotonic milliseconds and its wall timestamp, and shares
it across JS contexts. The current performance/DNS observer and process
uptime source use it. The helper has standalone native controls; the engine
bridge remains uncompiled and four-host timing/lifecycle behavior unvalidated.

Patch 63 selects a shared native callback scope and guards actual JS entry
depth. DNS, filesystem and codec cleanup now follows a successful outermost
tick/job checkpoint; nested/failed/stopping calls preserve context and
explicit exit status. No synthetic provider, host import or wire ABI is
introduced. The policy has compiled native controls, but the JSAPI adapter
and engine remain uncompiled. Complete rejection/fatal/GC/realm/phase and
four-host obligations remain in the callback-scope dependency record.

Patch 64 selects distinct guest mkdir/unlink/rmdir operations, including
first-created-path tracking for recursive mkdir, over owned pathname jobs
and the existing filesystem request/callback scope. The portable helper has
compiled host-libc/native-reference controls; the new JSAPI path remains
uncompiled. No host/kernel wire ABI is changed. The package recipe revision
tracks these real source inputs, but no package artifact was rebuilt.

Patch 65 connects loader-safe environment queries to actual credentials and
libc secure environment state. The CommonJS source uses real Module records,
cache/parent graph, extension handlers and pinned require/lookup wrappers.
Ordinary native/source controls do not validate secure guest startup or this
uncompiled JSAPI path. Package/ESM/hook/CLI and four-host gaps remain in the
module-record dependency record. Recipe revision 47 binds the changed source;
no package or product artifact was rebuilt.

Patch 66 adds retained exact-pid child wait ownership, prepared/reentrant owner
guards, Promise-realm delivery, failed-settlement propagation and context-root
retirement. Real wait errors remain errors, never successful exit zero. The
portable policy has native POSIX controls and the frontend has scoped native
reference checks; this JSAPI/engine path remains uncompiled. Exceptional
wait-loss policy still differs from libuv and remains open, along with complete
child-process/stdio/IPC and four-host evidence. Recipe revision 48 includes the
new header; no package artifact, host import or wire ABI was changed.

Patch 67 registers private parseEnv/loadEnvFile bindings over the pinned
dotenv parser and actual guest file/environment owners. Recipe revision 49
includes the generated parser, file owner and native bridge. Portable native
and public wrapper controls pass; the engine/JSAPI is uncompiled. CLI,
permissions, workers, unexpected close policy and four-host evidence remain
open. No new host import, wire ABI or package/product artifact is introduced.

Patch 68 adds private owned one-shot digest/provider/comparison bindings and
fixes existing incremental string lengths, fetched-digest ownership, HMAC key
cleanup and initial private-slot safety. Recipe revision 50 retains the same
OpenSSL 3.3.2 dependency. A separate exact-version native control build and
scoped frontend/upstream checks do not compile this engine path. Full
Hash/Hmac/crypto/error/memory/GC and four-host conformance remain open.
No host import/wire ABI or guest package/product artifact is changed.

Recipe revision 51 selects the new full pinned readline interface/key/history
source and actual stream/decoder/event/timer owners through the shared bundle.
No engine patch or ABI changes are added. Focused native dependency and
unchanged upstream controls pass; actual guest TTY/width/persistence/permission/
REPL and four-host runtime behavior remain incomplete or unvalidated. The
engine/package/product were not rebuilt; see the readline dependency record.


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

Patch 73/recipe 60 stage real address/rule handles and the libuv parser/hash
owners for pinned BlockList/SocketAddress. TCP filters use live rule state.
Portable/native dependency controls do not compile or validate this guest
bridge; clone/worker transport, native metadata/error/GC and four-host
conformance remain open. See the address dependency record in the Node outline.

### Native embedding assembly

Recipe revision 62 assembles the shared native bridge fragments into one
private generated unity source, `shell/kandelo-node-native.cpp`. The generator
retains the function/class bodies, expresses their dependency order, and
collects the includes in a canonical preamble. Portable owner headers keep
their standalone aliases; staging translates those aliases to Mozilla's
`shell/` paths. The declared source inputs still include every fragment.
Patch 74 replaces the scattered fragment includes and orders engine headers.
Mozilla's original include checker and expectations remain enabled and
unchanged. This source integration does not establish guest behavior or
four-host conformance. See the native embedding record in the Node outline.

Recipe revision 63 gives generated SQLite constants their direct sqlite3.h
dependency and includes the bounded async-hook/provider/listener/timer source
fixes documented in `tests/nodejs/outline/async-audit-gaps-implementation.md`.
Provider IDs describe declared identifiers, not implemented resource types.
The normal targeted wasm32 revision 63 package build passed Mozilla's
unchanged source checks, optimization and fork instrumentation. The artifact
identity is recorded in the native embedding record; guest execution and
four-host conformance remain unvalidated. Historical source-slice notes
above describe their earlier build status.

Recipe revision 64 adds real typed byte directory scans and recursive walks
over guest POSIX scandir/stat/lstat, with native callback/promise work and
the pinned public readdir/Dirent algorithms. Actual opendir/Dir handles and complete
filesystem/resource/guest conformance remain separate work. The new bridge
compiles and links in the accepted normal targeted wasm32 package build;
guest execution remains unvalidated. See
`tests/nodejs/outline/readdir-implementation-dependencies.md` for controls,
retained failures, APFS fixture limits and remaining dependencies.

The normal targeted engine69 package also compiles the package-reader and
live TLS metadata/verification owners. Exact accepted artifacts and scoped
evidence are retained in tests/nodejs/outline/native-embedding-integration.md.
This is not a full product rebuild or four-host guest conformance.

The targeted engine70 package compiles actual Buffer construction/pooling,
permanent engine ArrayBuffer detach restrictions and native zero-fill option
ownership. See tests/nodejs/outline/buffer-pool-implementation-dependencies.md
for scoped evidence and remaining public/guest/four-host requirements.

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

The source104 candidate links `node-llhttp` from the exact Node target and
exposes a private GC-owned streaming response parser. Public response header,
body and completion callbacks reuse pinned `_http_common.js` sections. Parser
availability is not full HTTP conformance: Agent/server/HTTP2, synchronous
callback reentry and the remaining transport lifecycles still require work.

The source105 private-mark candidate unifies Buffer pool detach restrictions
with public worker object marking. A weak engine registry preserves own marks
on frozen objects without exposing symbols or traversing JS prototypes. Clone
and transfer policies remain distinct; host transfer/worker capabilities and
identified-artifact runtime validation remain separate requirements.

Source107 replaces the public scripted environment Proxy with a native virtual
Object over the existing live environment store. Native hooks own reflection,
prototype fallback, receiver semantics and clone traversal; the object remains
extensible because the external key set can change. This is an actual owning
representation change, not a marking exception. Complete prototype/constructor,
warning, store/worker/permission and four-host validation remain obligations.
