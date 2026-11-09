# PR reuse audit for the upstream Node module restart

Source audit of33 PRs at their pinned incremental heads/bases; main comparison `92e3496082e85dfc751935eb4ceb9e81682756b5`. Frozen campaign head `5f19f5f1c61cc80adb8e39e1f8470b497f34e9c8`.

This audit evaluates implementation architecture and migration usefulness. It is not runtime conformance, a full API re-audit, or approval to merge. No runtime tests, probes, runtime bundle generation, compilations, package builds or product rebuilds ran. Existing source checkout remains frozen.

## Reading the classifications

- **Whole module:** the upstream file is consumed by an executed factory/source path. This does not establish that all of its dependencies are upstream, activation is public, or behavior conforms.
- **Excerpts:** selected functions/sections or algorithm ports; these do not satisfy the whole-module rule even where their bytes are pinned.
- **Third-party alternative:** other implementations such as whatwg-url/web-streams-polyfill, distinguished from the pinned Node module library.
- **Backend:** genuine engine, native, host, libc/kernel or internal service mechanisms. Backend code may be JS or C++; neither language nor file location proves reuse fitness.
- **Usefulness:** a source-based migration recommendation. Reuse requires matching actual Node native binding, request object, callback/error, cancellation, memory and lifecycle contracts.

Each row describes the individual PR delta. Later work can supersede it. The migration should inspect final coherent implementations rather than replaying every early patch.

## PR summary

| PR | Upstream Node module reuse | Backend implementation | Usefulness for the reset |
| --- | --- | --- | --- |
| [#1595](https://github.com/Automattic/kandelo/pull/1595) | No Node core import; third-party URL/Web Streams. | chmod/fsync, read cancellation and reference state. | Keep I/O mechanisms/tests; replace public shims and alternative frontends. |
| [#1604](https://github.com/Automattic/kandelo/pull/1604) | Upstream source/reference used for tests, not module execution. | Pinning, runners, artifact identity and honest result accounting. | Carry provenance/harness; verify target; replace bootstrap assembly. |
| [#1605](https://github.com/Automattic/kandelo/pull/1605) | Handwritten codecs; ported Node C++ algorithm. | Uses existing decoding primitive; no new native binding. | Keep boundary tests; replace public codecs with upstream modules. |
| [#1606](https://github.com/Automattic/kandelo/pull/1606) | Whole assert/comparison modules; substituted internals and diagnostic patch. | Native Promise brand; byte/property/type services. | Reuse modules; replace substitute dependency graph and adapt primitives. |
| [#1607](https://github.com/Automattic/kandelo/pull/1607) | Handwritten shutdown logic. | Engine completion hook and final status/failure handling. | Keep lifecycle mechanism/tests; use upstream process policy and later fixes. |
| [#1608](https://github.com/Automattic/kandelo/pull/1608) | Handwritten fs wrappers. | Real pread/pwrite, signed64 offsets and preserved file cursor. | Keep native operations/tests; adapt to Node fs request contracts. |
| [#1609](https://github.com/Automattic/kandelo/pull/1609) | Handwritten Blob/Response; third-party stream internals. | Engine graph cloning; existing stream transport. | Keep clone/consumption tests; replace public body and stream-state adapters. |
| [#1610](https://github.com/Automattic/kandelo/pull/1610) | None; filesystem-level fix. | Wide-offset/EOF/no-corruption behavior. | Rootfs equivalent already on main; review missing tmpfs fix; keep tests. |
| [#1611](https://github.com/Automattic/kandelo/pull/1611) | Unchanged upstream test/source fixtures, not runtime activation. | Source-tree integrity and fixture/image preparation. | Carry integrity checks and harness accounting. |
| [#1612](https://github.com/Automattic/kandelo/pull/1612) | Handwritten net/dns connection policy. | getaddrinfo, IPv4/IPv6 connect/bind/address queries/cancellation. | Reuse final socket/DNS owners behind Node wrappers; replace public policy. |
| [#1613](https://github.com/Automattic/kandelo/pull/1613) | Handwritten bootstrap/global exposure policy. | Captures privileged embedding functions before removing shell globals. | Keep isolation mechanism/tests; use upstream bootstrap/global policy. |
| [#1614](https://github.com/Automattic/kandelo/pull/1614) | Custom CJS/ESM loader; no whole Node loader. | Real engine module graphs, script identities and event-loop handoff. | Reuse engine primitives; replace custom resolution/cache/namespace policy. |
| [#1615](https://github.com/Automattic/kandelo/pull/1615) | Handwritten public getCallSites wrapper. | Genuine saved frames and compilation coordinates. | Reuse engine capture; let whole util/internal modules define public behavior. |
| [#1616](https://github.com/Automattic/kandelo/pull/1616) | Custom fatal/rejection policy. | Real exception checkpoints and fatal-loop shutdown. | Keep execution mechanisms; use upstream process policy and newer recovery owners. |
| [#1617](https://github.com/Automattic/kandelo/pull/1617) | Handwritten Server/Socket. | Real bind/listen/accept, half-close and handle reference operations. | Reuse final TCP backend; implement Node handle contracts; replace net facade. |
| [#1619](https://github.com/Automattic/kandelo/pull/1619) | Handwritten exit-listener policy. | Preserves pending exception and final process status. | Keep exception/status machinery and tests; use upstream exit policy. |
| [#1620](https://github.com/Automattic/kandelo/pull/1620) | Handwritten Server capacity/drop policy. | No new native binding. | Keep public/peer regressions; upstream net.js supplies policy. |
| [#1621](https://github.com/Automattic/kandelo/pull/1621) | Handwritten timers, Promise timers and deadline scheduler. | Monotonic clock, wakeup/reference and callback-checkpoint seams. | Keep clock/liveness; replace duplicated timer classes/scheduler with upstream internals. |
| [#1622](https://github.com/Automattic/kandelo/pull/1622) | Handwritten child_process frontend. | POSIX child/pipe I/O, wait/reap, limits, credentials and cleanup. | Strong backend candidate; adapt spawn_sync/process/pipe contracts; replace normalization. |
| [#1623](https://github.com/Automattic/kandelo/pull/1623) | Handwritten socket timeout/constructor policy. | Actual pending-write bytes and descriptor-bound progress state. | Keep write accounting/ownership/tests; upstream net owns timeout behavior. |
| [#1653](https://github.com/Automattic/kandelo/pull/1653) | FIPS helper excerpt; handwritten SQLite tag-store frontend. | FIPS state, TTY construction and native SQLite LRU/resource ownership. | Reuse native owners; replace public/helper assembly. |
| [#1655](https://github.com/Automattic/kandelo/pull/1655) | Crypto helper excerpts; custom async dispatch. | Promise observations, resolver/listener operations and MAC enumeration. | Reuse final coherent native owners; supply upstream crypto/dns/net/async bindings. |
| [#1656](https://github.com/Automattic/kandelo/pull/1656) | Whole internal benchmark/error-serialization modules; public bench inactive. | Worker CLI/startup data; custom spawn/Fetch orchestration. | Keep internal sources/startup owners; replace public facades; activation gaps remain. |
| [#1658](https://github.com/Automattic/kandelo/pull/1658) | Selected stream/TLS helpers; no new whole net/tls module. | TCP/TTY string writes, shutdown and peer-certificate storage/conversion. | Reuse StreamBase/TTY/X509 mechanisms; replace selected dispatch helpers. |
| [#1659](https://github.com/Automattic/kandelo/pull/1659) | Whole source-map cache modules with rewrites; util/helper excerpts. | Compiler source-map metadata and actual backing-allocation observations. | Keep native metadata; use shared bindings and whole upstream dependency modules. |
| [#1660](https://github.com/Automattic/kandelo/pull/1660) | Whole internal/freelist; selected assertion tokenizer/wrapper. | Caller script/PC/source capture and parser lifetime/rollback. | Keep parser/source mechanisms with successor fixes; replace excerpt assembly. |
| [#1661](https://github.com/Automattic/kandelo/pull/1661) | Whole internal benchmark reporters; manual public FIPS installer. | Real FIPS mutation/error ownership and UTF8 source decoding. | Keep reporter sources/native mechanisms; replace crypto installer; public bench remains inactive. |
| [#1662](https://github.com/Automattic/kandelo/pull/1662) | Whole public tty.js; dependencies still use private maps. | Listener dispatch, accepted-fd rollback and TTY shutdown integration. | Strong whole-module example; reuse coherent TTY/listener backend through shared bindings. |
| [#1663](https://github.com/Automattic/kandelo/pull/1663) | Custom async/Fetch changes; no new whole module. | Engine Promise parent and TCP queue/cancellation/retirement ownership. | Keep final Promise/TCP owners; replace facade and complete upstream hook dependencies. |
| [#1664](https://github.com/Automattic/kandelo/pull/1664) | Handwritten SQLite/environment wrappers. | SQLite extension ownership, codec errors and watcher/event/env behavior. | Keep backend/security work; adapt native binding exports and preserve ABI obligations. |
| [#1665](https://github.com/Automattic/kandelo/pull/1665) | Custom HTTP/bootstrap orchestration around existing modules. | Parser AsyncWrap/checkpoints/lifetime and TLS read/write readiness. | Keep native lifecycle/readiness; replace custom HTTP/bootstrap orchestration. |
| [#1666](https://github.com/Automattic/kandelo/pull/1666) | Crypto/util/source-map excerpts; custom Fetch routing. | Native curves and distinct Promise observation/identity state. | Keep providers/engine channels; load upstream crypto/util/Undici and shared hook registry. |
| [#1667](https://github.com/Automattic/kandelo/pull/1667) | Selected fs.exists and HTTP timing algorithms. | Real supplementary groups; existing FS and timing owners consumed. | Keep credentials backend/tests; whole fs/HTTP modules supersede selected public logic. |

## Intervening foundation base without its own PR

The235 campaign commits between the early stack and source262 are not represented by their own PR in this stack. They contain much of the later whole-module reuse and most shared native work. This supplementary assessment is thematic, not a line-by-line audit of all235commits.

Pinned source: `18b6947f2bdce203e219517beeb531fb2b95fc6b`.

### Upstream JavaScript modules

Upstream reuse: Mixed. Whole modules are consumed by factories for path, many classic/Web stream internals, inspection, EventTarget/AbortController, query codecs, Domain and other groups. Filesystem, Buffer, crypto, process and loader integrations also select sections or supply handwritten behavior. Whole-file import is not whole dependency-graph reuse.

Backend: Per-family private require/internalBinding maps and shared platform/native bridges.

Disposition: Reuse exact upstream sources/provenance and module tests; replace per-family loader islands with one coherent internal module environment. Prefer loading the pinned upstream tree directly to transplanting the section-assembly generator.

Source anchors:
- `third_party/node-core/build.py: path_factories/value_factories/stream factories`
- `third_party/node-core/sources.json: modules/pathPlatform/streamPlatform and selected-section records`
- `third_party/node-core/path-platform-adapter.js: require/modules/loading`
- `third_party/node-core/stream-platform-adapter.js: modules/internalBinding/require`
- `packages/registry/node-compat/bootstrap.js: fs/timers/net/child_process exports`

### Native work, callbacks, async execution and retained storage

Upstream reuse: Upstream AsyncLocalStorage/context modules coexist with selected AsyncHook/TickObject/fatal algorithms and handwritten internal registry glue.

Backend: SpiderMonkey work queues, actual Promise/frame/context channels, callback execution ownership, rooted completion/error state, retained byte allocations and memory ownership.

Disposition: Priority reuse candidates. Map each owner to Node native binding/AsyncWrap expectations and real GC/realm/teardown semantics; do not import bespoke callback packets as if already Node binding compatible.

Source anchors:
- `third_party/node-core/native-work.cpp`
- `third_party/node-core/native-async.cpp: KandeloNativeAsyncState`
- `third_party/node-core/native-callback.cpp`
- `third_party/node-core/callback-scope.h`
- `third_party/node-core/native-backing-store.cpp`
- `third_party/node-core/retained-backing-store.h`

### Filesystem backend

Upstream reuse: Many unchanged selected fs functions, plus some complete internal modules; public fs object and assembly remain mixed.

Backend: Real guest libc operations, FS request owners, native work completion/cancellation, file handles, directory traversal, copy and read/write ownership.

Disposition: Reuse operations and resource owners behind real internalBinding(fs) contracts. Replace extracted public wrappers and sync-to-callback conveniences with upstream fs modules; preserve ordering/errors/lifecycle controls.

Source anchors:
- `third_party/node-core/native-fs.cpp: KandeloFsRequestState/KandeloFsWork`
- `third_party/node-core/native-fs-promise.cpp`
- `third_party/node-core/native-file-handle.cpp`
- `third_party/node-core/native-copy-file.cpp`
- `third_party/node-core/native-copy-directory.cpp`
- `third_party/node-core/fs-callback-adapter.js`

### Network, HTTP parsing, TLS, DNS and UDP

Upstream reuse: Whole HTTP Agent/OutgoingMessage and selected complete frontend files coexist with net/HTTP/TLS helpers and source selections. Vendor/reference files alone are not executed frontend reuse.

Backend: Guest sockets, descriptor ownership/watch/ref state, protocol parsing, TLS/OpenSSL credentials and encrypted I/O, c-ares/DNS requests, datagram backing ownership.

Disposition: Reuse low-level operations and ownership mechanisms after mapping to TCP/Pipe/UDP/StreamWrap, HTTPParser and TLS/c-ares binding contracts. Retire handwritten public networking policy as upstream modules activate.

Source anchors:
- `third_party/node-core/native-socket-owner.cpp`
- `third_party/node-core/native-listener.cpp`
- `third_party/node-core/native-datagram.cpp`
- `third_party/node-core/native-dns-lookup.cpp`
- `third_party/node-core/native-dns-records.cpp`
- `third_party/node-core/native-tls-context.cpp`
- `third_party/node-core/http-parser.h`

### Native libraries and package integration

Upstream reuse: Actual Node-vendored ncrypto plus c-ares, llhttp, SIMD JSON, SQLite and codec library packages are native dependency reuse, distinct from public Node JS reuse.

Backend: SDK/resolver-owned pinned builds and engine bindings to these libraries. Threaded shared OpenSSL migration affects non-Node consumers.

Disposition: Retain provenance and build contracts; reuse required libraries selectively. Independently review global OpenSSL changes and dependent package rebuild/validation needs. Native library presence does not complete public module behavior.

Source anchors:
- `packages/registry/node-ncrypto/build-node-ncrypto.py: prepare/build`
- `packages/registry/node-cares/`
- `packages/registry/node-llhttp/`
- `packages/registry/node-codecs/`
- `packages/registry/node-sqlite/`
- `packages/registry/node-simdjson/`
- `packages/registry/openssl/build-openssl.sh`

### VM, modules, Workers and native integration

Upstream reuse: Public VM/testing/worker/module helpers include both whole module factories and selected portions; WASI/SQLite/FFI/SEA still depend on substantial native implementations.

Backend: Actual SpiderMonkey script/module records, deadlines/source identities, thread/startup/clone/port transport, SQLite/FFI/POSIX import state.

Disposition: Useful engine primitives, not a reason to retain replacement Node CJS/ESM resolution. Design expected contextify/module_wrap/messaging bindings first. Native nested guest Wasm is still unfinished and stays deferred.

Source anchors:
- `third_party/node-core/native-vm.cpp`
- `third_party/node-core/native-vm-modules.cpp`
- `third_party/node-core/native-vm-import.cpp`
- `third_party/node-core/native-worker.cpp`
- `third_party/node-core/native-ports.cpp`
- `third_party/node-core/native-sqlite.cpp`
- `third_party/node-core/native-ffi-library.cpp`

### Shared host/kernel and ABI prerequisites

Upstream reuse: No upstream Node public module reuse established by these changes.

Backend: Secure entropy, timestamp/no-follow/OPFS behavior, filesystem correctness, epoll/EventFd/backing-read wake ownership, private fsnotify prerequisites and proposed file-advice baseline.

Disposition: Treat as independent platform changes. Check exact current-main equivalents before importing. Public inotify and successor file-advice/statfs activation remain gated; preserve immutable ABI55 history. Node frontend reset cannot waive cross-host or ABI obligations.

Source anchors:
- `host/src/secure-random.ts`
- `host/src/platform/node.ts: utimensat`
- `host/src/vfs/opfs.ts`
- `crates/runtime-core/src/epoll.rs`
- `crates/runtime-core/src/fsnotify.rs`
- `crates/runtime-core/src/wait_retry.rs`
- `crates/kernel/src/wasm_api.rs`
- `tests/nodejs/outline/file-advice-program-baseline-plan.md`

### Audit, harness and evidence

Upstream reuse: Requirements and unchanged upstream tests are validation inputs, not implementation reuse.

Backend: No runtime backend from report generation itself.

Disposition: Carry audited API requirements, pin/provenance checks and meaningful tests; simplify the campaign bookkeeping for the new loader architecture. Do not reuse historical source/component/native outcomes as current four-host conformance.

Source anchors:
- `tests/nodejs/audit/audit-report.md`
- `tests/nodejs/audit/api-matrix.json`
- `tests/nodejs/audit/roadmap.md`
- `tests/nodejs/outline/implementation-state.json`
- `scripts/run-nodejs-library-tests.ts`
- `scripts/nodejs-test-results.ts`

## Recommended carry-forward boundary

Build the single upstream module environment first and define binding contracts from that pinned source. Carry source/provenance/tests and fit existing final backend owners to those contracts. Replace handwritten public behavior and fragmented loader/dependency maps as whole upstream modules activate. Retain low-level ownership fixes even when the old public wrapper is discarded.

Keep global OpenSSL changes, shared readiness/filesystem/host behavior and ABI successor activation as separately reviewed platform prerequisites. Some old rootfs wide-offset behavior is already in main; the tmpfs source still needs narrow review. Never transplant entire old backend files over newer main equivalents.

The new public module environment must also preserve the separate Bun extraction/asset/launcher integration capability. That work is on `brandonpayton/bun-auto-unpacking`; it is not part of these33PR increments.

## Evidence limitations and open questions

- All33 current PR head SHAs matched the frozen metadata used for source review; bases and source anchors are in the companion JSON.
-135 pinned Git source-path anchors were checked for existence. That is source identity verification, not a test of API behavior.
- Existing native/component/guest/four-host observations remain bound to their original commits and artifacts. Current source275 has no current combined compilation/runtime or four-host proof. Build products were intentionally removed.
- Positive source suitability is not certification of memory safety or completeness. Native object layouts, callbacks, error shapes and ownership require focused validation when integrated.
- Public benchmark activation, Promise registry wiring, full stream/transport/Worker lifecycle and nested guest Wasm execution remain missing or incomplete. Reusing their files alone does not close those gaps.
- Recorded Node26.13.0/source/native pins were preserved. This source reuse audit did not independently revalidate the official release designation; verify it in the restart target decision without silently changing it.

## Detailed per-PR source findings

### #1595: Node: Fix core filesystem, process, and web API behavior

Head `b4845ff854a6d8b082d776157dc4550edb5ef257`; base `1a3ea3b9a73f6975d31f755be37e532aec6f8ad3`.

**Upstream reuse:** No executable upstream Node core module is imported. whatwg-url14.2.0, tr465.1.1 and web-streams-polyfill4.3.0 are other projects, bundled with dependencies. Public fs/process/URL/Buffer/stdin logic remains handwritten.

**Backend:** Real guest libc chmod/fsync operations; fd-read nonblocking admission, cancellation by exact pending Promise, independent loop reference state. JS fixes negative errno/partial writes, child PATH/cwd and EOF but those public policies are not native binding implementations.

**Usefulness:** High native fd/POSIX/cancellation and regression value; low wholesale frontend fit.

**Disposition:**
- Extract/adapt genuine native owners behind the new fs/stream bindings, considering later ownership-corrected descendants.
- Retain file/write/stdin/PATH/exit/URL/Buffer regressions.
- Replace handmade public APIs and alternative public URL/WebStreams libraries with whole Node modules/dependencies. Do not transplant the entire bootstrap/bundle.

**Evidence limitations:** Read-only source/diff audit; no tests, runtime probes, generation or builds. Historical evidence applies only to its exact source/artifact identity. This review does not establish runtime correctness, current main regression protection, or complete Node internalBinding contract fit.

**Source anchors:**
- [third_party/node-web-platform/package.json:6](https://github.com/Automattic/kandelo/blob/b4845ff854a6d8b082d776157dc4550edb5ef257/third_party/node-web-platform/package.json#L6) — "whatwg-url"
- [third_party/node-web-platform/build.mjs:7](https://github.com/Automattic/kandelo/blob/b4845ff854a6d8b082d776157dc4550edb5ef257/third_party/node-web-platform/build.mjs#L7) — stdin:
- [packages/registry/spidermonkey/patches/0023-kandelo-chmod.patch:4](https://github.com/Automattic/kandelo/blob/b4845ff854a6d8b082d776157dc4550edb5ef257/packages/registry/spidermonkey/patches/0023-kandelo-chmod.patch#L4) — static bool osfile_chmod
- [packages/registry/spidermonkey/patches/0024-kandelo-fsync.patch:4](https://github.com/Automattic/kandelo/blob/b4845ff854a6d8b082d776157dc4550edb5ef257/packages/registry/spidermonkey/patches/0024-kandelo-fsync.patch#L4) — static bool osfile_fsync
- [packages/registry/spidermonkey/patches/0025-kandelo-stdin-read-control.patch:48](https://github.com/Automattic/kandelo/blob/b4845ff854a6d8b082d776157dc4550edb5ef257/packages/registry/spidermonkey/patches/0025-kandelo-stdin-read-control.patch#L48) — static bool KandeloNativeFdReadControl
- [packages/registry/node-compat/bootstrap.js:3018](https://github.com/Automattic/kandelo/blob/b4845ff854a6d8b082d776157dc4550edb5ef257/packages/registry/node-compat/bootstrap.js#L3018) — function _spawnWithPath

### #1604: Node: Pin LTS target and restore upstream suite

Head `1a99195b017167ff4c51d612195582c73778abd6`; base `b4845ff854a6d8b082d776157dc4550edb5ef257`.

**Upstream reuse:** No new executable core module library. Pinned Node source/native archives are inputs to unchanged upstream tests and differential controls. Target/version embedding is metadata, not runtime module reuse.

**Backend:** Conformance/build infrastructure: coherent target manifest feeds CLI and process identity; source hashes and native/browser/guest runners retain real flags, environment, timeouts, artifact identities and unsupported/error statuses. Removes false Linux/V8/libuv/module-ABI metadata.

**Usefulness:** High reuse for provenance and validation, separate from runtime implementation.

**Disposition:**
- Reuse archive pin/coherence, native reference and honest per-host result accounting, including later1611 integrity corrections.
- Verify the target/source/native reference against official sources separately; this audit does not validate the release designation.
- Replace monolithic import-stripping bootstrap assembly with the new shared module environment as needed.

**Evidence limitations:** Read-only source/diff audit; no tests, runtime probes, generation or builds. Historical evidence applies only to its exact source/artifact identity. This review does not establish runtime correctness, current main regression protection, or complete Node internalBinding contract fit.

**Source anchors:**
- [packages/registry/node-compat/target.json:3](https://github.com/Automattic/kandelo/blob/1a99195b017167ff4c51d612195582c73778abd6/packages/registry/node-compat/target.json#L3) — "version"
- [scripts/generate-node-bootstrap.py:13](https://github.com/Automattic/kandelo/blob/1a99195b017167ff4c51d612195582c73778abd6/scripts/generate-node-bootstrap.py#L13) — shared_lines
- [scripts/nodejs-source-helper.ts:97](https://github.com/Automattic/kandelo/blob/1a99195b017167ff4c51d612195582c73778abd6/scripts/nodejs-source-helper.ts#L97) — export function preparePinnedArchive
- [scripts/nodejs-guest-runner.ts:15](https://github.com/Automattic/kandelo/blob/1a99195b017167ff4c51d612195582c73778abd6/scripts/nodejs-guest-runner.ts#L15) — export function unsupportedGuestRequirements
- [scripts/nodejs-test-results.ts:7](https://github.com/Automattic/kandelo/blob/1a99195b017167ff4c51d612195582c73778abd6/scripts/nodejs-test-results.ts#L7) — export function classifyNodejsResult
- [packages/registry/node-compat/bootstrap.js:785](https://github.com/Automattic/kandelo/blob/1a99195b017167ff4c51d612195582c73778abd6/packages/registry/node-compat/bootstrap.js#L785) — platform: 'kandelo'

### #1605: Node: Correct text codec boundaries and EOF

Head `90180c605b92bfc45aa565c627b1197ee35987f3`; base `1a99195b017167ff4c51d612195582c73778abd6`.

**Upstream reuse:** No whole upstream public module reuse. TextEncoder/TextDecoder and StringDecoder are handwritten JS. The StringDecoder explicitly adapts byte-boundary accounting from Node src/string_decoder.cc: an algorithm port, not lib/string_decoder.js or internal/encoding execution.

**Backend:** No new native primitive. Uses existing native decodeUtf8 only for validated complete non-shared spans, with JS state machines, intrinsic byte-view access, surrogate replacement and stdin EOF flush.

**Usefulness:** High as codec/backend requirements and regressions; low as public implementation to retain.

**Disposition:**
- Keep malformed/split UTF8/UTF16, BOM/fatal, encodeInto, view brands and stdin EOF tests.
- Execute upstream encoding/StringDecoder modules and implement their native transcoder/buffer state needs.
- Do not retain these handwritten public classes as the new module implementation.

**Evidence limitations:** Read-only source/diff audit; no tests, runtime probes, generation or builds. Historical evidence applies only to its exact source/artifact identity. This review does not establish runtime correctness, current main regression protection, or complete Node internalBinding contract fit.

**Source anchors:**
- [packages/registry/node-compat/bootstrap.js:55](https://github.com/Automattic/kandelo/blob/90180c605b92bfc45aa565c627b1197ee35987f3/packages/registry/node-compat/bootstrap.js#L55) — globalThis.TextEncoder = class
- [packages/registry/node-compat/bootstrap.js:161](https://github.com/Automattic/kandelo/blob/90180c605b92bfc45aa565c627b1197ee35987f3/packages/registry/node-compat/bootstrap.js#L161) — globalThis.TextDecoder = class
- [packages/registry/node-compat/bootstrap.js:3070](https://github.com/Automattic/kandelo/blob/90180c605b92bfc45aa565c627b1197ee35987f3/packages/registry/node-compat/bootstrap.js#L3070) — Byte-boundary accounting adapted
- [packages/registry/node-compat/bootstrap.js:3132](https://github.com/Automattic/kandelo/blob/90180c605b92bfc45aa565c627b1197ee35987f3/packages/registry/node-compat/bootstrap.js#L3132) — StringDecoder.prototype.write
- [host/test/node-text-decoder.test.ts:189](https://github.com/Automattic/kandelo/blob/90180c605b92bfc45aa565c627b1197ee35987f3/host/test/node-text-decoder.test.ts#L189) — describe(

### #1606: Node: Restore assertion matchers and deep comparisons

Head `977351ed76181a247864c5b67800b99538de3722`; base `90180c605b92bfc45aa565c627b1197ee35987f3`.

**Upstream reuse:** Genuine complete Node assert.js, internal/util/comparisons.js and internal/assert/utils.js are hash-checked and inserted into executed factories. assert-utils has one generated diagnostic substitution. Other dependencies remain handwritten substitutes: AssertionError, errors, validators, inspection, partial primordials and local require map.

**Backend:** Native Promise brand uses CheckedUnwrapStatic and JS::IsPromiseObject without calling then/getters. Existing genuine native Error/Proxy brands are forwarded. Byte comparisons/non-index property filtering supply internal services in JS; they are not one coherent shared Node environment yet.

**Usefulness:** High; closest early PR to whole-module architecture, with substantial dependency substitution debt.

**Disposition:**
- Reuse pinned original modules and tests through the new shared builtin loader.
- Carry engine brand/byte/property primitives only after their actual realm/security/GC contracts fit.
- Replace local AssertionError/errors/validators/primordials/inspection substitutes with their upstream modules and genuine backend; disclose/remove diagnostic source adaptation rather than count it as full parity.

**Evidence limitations:** Read-only source/diff audit; no tests, runtime probes, generation or builds. Historical evidence applies only to its exact source/artifact identity. This review does not establish runtime correctness, current main regression protection, or complete Node internalBinding contract fit.

**Source anchors:**
- [third_party/node-core/sources.json:9](https://github.com/Automattic/kandelo/blob/977351ed76181a247864c5b67800b99538de3722/third_party/node-core/sources.json#L9) — "internal/util/comparisons"
- [third_party/node-core/build.py:25](https://github.com/Automattic/kandelo/blob/977351ed76181a247864c5b67800b99538de3722/third_party/node-core/build.py#L25) — entries.append
- [third_party/node-core/build.py:23](https://github.com/Automattic/kandelo/blob/977351ed76181a247864c5b67800b99538de3722/third_party/node-core/build.py#L23) — source = source.replace
- [third_party/node-core/adapter.js:99](https://github.com/Automattic/kandelo/blob/977351ed76181a247864c5b67800b99538de3722/third_party/node-core/adapter.js#L99) — class AssertionError
- [third_party/node-core/adapter.js:115](https://github.com/Automattic/kandelo/blob/977351ed76181a247864c5b67800b99538de3722/third_party/node-core/adapter.js#L115) — const modules =
- [packages/registry/spidermonkey/patches/0026-kandelo-promise-brand.patch:10](https://github.com/Automattic/kandelo/blob/977351ed76181a247864c5b67800b99538de3722/packages/registry/spidermonkey/patches/0026-kandelo-promise-brand.patch#L10) — static bool KandeloNativeIsPromise
- [packages/registry/node-compat/bootstrap.js:2544](https://github.com/Automattic/kandelo/blob/977351ed76181a247864c5b67800b99538de3722/packages/registry/node-compat/bootstrap.js#L2544) — const assert = _nodeCore.assert

### #1607: Node: Finalize eval shutdown and uncaught main failures

Head `39d6e685ccb0568697a8f294b908d22b8c4166ea`; base `977351ed76181a247864c5b67800b99538de3722`.

**Upstream reuse:** No upstream core module import. Natural-exit and ESM error bookkeeping are handwritten bootstrap policy.

**Backend:** Real SpiderMonkey shell hook after job/timer/I/O draining and rejection reporting calls a private JS finalizer and returns process status. Explicit failure flag preserves primitive thrown values.

**Usefulness:** High lifecycle/backend requirement; public shutdown policy should be replaced by upstream bootstrap/process behavior.

**Disposition:**
- Adapt shell completion/fatal result handling to the actual upstream process/bootstrap contract.
- Retain eval/CJS/ESM, unset/cleared exitCode, pending work and primitive-throw cases.
- Consider later1616/1619 lifecycle successors before extracting this early hook.

**Evidence limitations:** Read-only source/diff audit; no tests, runtime probes, generation or builds. Historical evidence applies only to its exact source/artifact identity. This review does not establish runtime correctness, current main regression protection, or complete Node internalBinding contract fit.

**Source anchors:**
- [packages/registry/spidermonkey/patches/0027-kandelo-node-eval-exit.patch:14](https://github.com/Automattic/kandelo/blob/39d6e685ccb0568697a8f294b908d22b8c4166ea/packages/registry/spidermonkey/patches/0027-kandelo-node-eval-exit.patch#L14) — __kandeloNodeFinalize
- [packages/registry/node-compat/bootstrap.js:5651](https://github.com/Automattic/kandelo/blob/39d6e685ccb0568697a8f294b908d22b8c4166ea/packages/registry/node-compat/bootstrap.js#L5651) — function _runNaturalExit
- [packages/registry/node-compat/bootstrap.js:5700](https://github.com/Automattic/kandelo/blob/39d6e685ccb0568697a8f294b908d22b8c4166ea/packages/registry/node-compat/bootstrap.js#L5700) — let failed = false
- [host/test/fixtures/node-process-exit.ts:88](https://github.com/Automattic/kandelo/blob/39d6e685ccb0568697a8f294b908d22b8c4166ea/host/test/fixtures/node-process-exit.ts#L88) — nodeProcessExitExpected

### #1608: Node: Preserve descriptor cursors for positioned I/O

Head `74f638fc6d8729bd007bce2f67a432c275773d0b`; base `39d6e685ccb0568697a8f294b908d22b8c4166ea`.

**Upstream reuse:** No whole fs module reuse. read/readSync/writeSync/FileHandle overloads, validation and callbacks are handwritten.

**Backend:** Real libc pread/pwrite binding with exact signed64 BigInt/safe-number offsets, bounds checking and no OFD cursor mutation. Count/-errno seam is not itself Node fs internalBinding request/wrapper/error/async contract.

**Usefulness:** High native filesystem primitive and regression value; replace public fs JS.

**Disposition:**
- Adapt positioned I/O backend behind whole upstream fs modules; retain64-bit offset and cursor/pipe error tests.
- Replace public overload/error/callback implementations.
- Review later backing/borrowing/GC ownership corrections; old ArrayBuffer-only seam is not full current shared/growable buffer support.

**Evidence limitations:** Read-only source/diff audit; no tests, runtime probes, generation or builds. Historical evidence applies only to its exact source/artifact identity. This review does not establish runtime correctness, current main regression protection, or complete Node internalBinding contract fit.

**Source anchors:**
- [packages/registry/spidermonkey/patches/0028-kandelo-positioned-io.patch:10](https://github.com/Automattic/kandelo/blob/74f638fc6d8729bd007bce2f67a432c275773d0b/packages/registry/spidermonkey/patches/0028-kandelo-positioned-io.patch#L10) — static bool PositionedIO
- [packages/registry/node-compat/bootstrap.js:1897](https://github.com/Automattic/kandelo/blob/74f638fc6d8729bd007bce2f67a432c275773d0b/packages/registry/node-compat/bootstrap.js#L1897) — function _readParameters
- [packages/registry/node-compat/bootstrap.js:1913](https://github.com/Automattic/kandelo/blob/74f638fc6d8729bd007bce2f67a432c275773d0b/packages/registry/node-compat/bootstrap.js#L1913) — function _readTransfer
- [host/test/fixtures/node-positioned-io.ts:13](https://github.com/Automattic/kandelo/blob/74f638fc6d8729bd007bce2f67a432c275773d0b/host/test/fixtures/node-positioned-io.ts#L13) — pread changed cursor

### #1609: Node: Track Response consumption and clone body streams

Head `26c78f2d95c3622d4eceacfda1ab561800587fdb`; base `74f638fc6d8729bd007bce2f67a432c275773d0b`.

**Upstream reuse:** No Node Blob/Fetch/WebStreams module import. Handwritten Blob, FetchResponse, body state/header validation and cloneBody logic use web-streams-polyfill; stream-state.cjs inspects that other implementation's _disturbed/_readableStreamController slots.

**Backend:** Exposes genuine SpiderMonkey serialize/deserialize graph cloning as cloneValue for independent stream chunk graphs. Actual tee/cancel state comes from third-party streams. Remaining changes are public/middle-layer JS semantics rather than a new transport backend.

**Usefulness:** High tests/ownership requirements and useful engine clone primitive; low public frontend fit.

**Disposition:**
- Keep repeated-consumption, lock/disturbance, independent clone bytes, snapshots and cancellation tests.
- Use Node Blob and the pinned Node bundled Fetch/WebStreams graph with genuine backend support.
- Do not transplant the alternate stream private-slot adapter; review later clone/transfer/GC ownership work before backend extraction.

**Evidence limitations:** Read-only source/diff audit; no tests, runtime probes, generation or builds. Historical evidence applies only to its exact source/artifact identity. This review does not establish runtime correctness, current main regression protection, or complete Node internalBinding contract fit.

**Source anchors:**
- [packages/registry/node-compat/bootstrap.js:6100](https://github.com/Automattic/kandelo/blob/26c78f2d95c3622d4eceacfda1ab561800587fdb/packages/registry/node-compat/bootstrap.js#L6100) — class Blob
- [packages/registry/node-compat/bootstrap.js:6503](https://github.com/Automattic/kandelo/blob/26c78f2d95c3622d4eceacfda1ab561800587fdb/packages/registry/node-compat/bootstrap.js#L6503) — function cloneBody
- [packages/registry/node-compat/bootstrap.js:6571](https://github.com/Automattic/kandelo/blob/26c78f2d95c3622d4eceacfda1ab561800587fdb/packages/registry/node-compat/bootstrap.js#L6571) — class FetchResponse
- [third_party/node-web-platform/stream-state.cjs:15](https://github.com/Automattic/kandelo/blob/26c78f2d95c3622d4eceacfda1ab561800587fdb/third_party/node-web-platform/stream-state.cjs#L15) — descriptor(value, '_disturbed')
- [packages/registry/spidermonkey/node-compat/adapter.js:371](https://github.com/Automattic/kandelo/blob/26c78f2d95c3622d4eceacfda1ab561800587fdb/packages/registry/spidermonkey/node-compat/adapter.js#L371) — cloneValue(value)

### #1610: POSIX: Preserve wide offsets in resident filesystems

Head `bd11508e1c0d373bbdae0d60a6a8b0e679645a20`; base `26c78f2d95c3622d4eceacfda1ab561800587fdb`.

**Upstream reuse:** No JS module reuse; platform-level filesystem correction with tests.

**Backend:** Reads compare wide offsets before narrowing to wasm32 usize; writes reject unrepresentable offsets/EFBIG; export reader avoids wrapping. Independent of Node. Current-main rootfs has equivalent checked conversions after refactoring, while tmpfs still retains the old cast-before-bound-check source pattern.

**Usefulness:** High platform prerequisite, but only missing current implementation should be carried.

**Disposition:**
- Retain wide-offset/EOF/no-corruption/cursor regressions for both backends.
- Do not transplant old rootfs source or duplicate its now-present fixes.
- Inspect/adapt the remaining tmpfs change in current code, preserving current quota refund and set-ID semantics; owning ABI review still applies.

**Evidence limitations:** Read-only source/diff audit; no tests, runtime probes, generation or builds. Historical evidence applies only to its exact source/artifact identity. This review does not establish runtime correctness, current main regression protection, or complete Node internalBinding contract fit.

**Source anchors:**
- [crates/runtime-core/src/tmpfs.rs:918](https://github.com/Automattic/kandelo/blob/bd11508e1c0d373bbdae0d60a6a8b0e679645a20/crates/runtime-core/src/tmpfs.rs#L918) — Compare before narrowing
- [crates/runtime-core/src/tmpfs.rs:1141](https://github.com/Automattic/kandelo/blob/bd11508e1c0d373bbdae0d60a6a8b0e679645a20/crates/runtime-core/src/tmpfs.rs#L1141) — usize::try_from(offset)
- [crates/runtime-core/src/rootfs.rs:2846](https://github.com/Automattic/kandelo/blob/bd11508e1c0d373bbdae0d60a6a8b0e679645a20/crates/runtime-core/src/rootfs.rs#L2846) — A large file offset must remain EOF
- [host/test/fixtures/node-positioned-io.ts:50](https://github.com/Automattic/kandelo/blob/bd11508e1c0d373bbdae0d60a6a8b0e679645a20/host/test/fixtures/node-positioned-io.ts#L50) — wide read changed buffer

### #1611: Tests: Preserve complete Node upstream source inputs

Head `f84ff24293d7b917b17feb258e74acad07a0dcf2`; base `bd11508e1c0d373bbdae0d60a6a8b0e679645a20`.

**Upstream reuse:** Complete upstream source tree is preserved as unchanged TEST INPUT, including doc/deps/root files, empty directories, links and modes. This is fixture reuse, not activating lib modules as runtime implementation.

**Backend:** Conformance infrastructure only: typed entry hashes include directories/modes/links; VFS copies all source entries and preflight probes them. Browser immutable image input is cached as plain bytes and copied independently per guest.

**Usefulness:** High import/integrity/validation reuse with honest scope.

**Disposition:**
- Carry all-entry source integrity and full fixture preservation into the new importer/harness, adapted to current VFS/browser quiet policy.
- Keep exact artifact manifests and failure/unsupported accounting.
- Do not count copied lib sources in a test image or historical5147case baseline as current module implementation/conformance.

**Evidence limitations:** Read-only source/diff audit; no tests, runtime probes, generation or builds. Historical evidence applies only to its exact source/artifact identity. This review does not establish runtime correctness, current main regression protection, or complete Node internalBinding contract fit.

**Source anchors:**
- [scripts/nodejs-source-helper.ts:88](https://github.com/Automattic/kandelo/blob/f84ff24293d7b917b17feb258e74acad07a0dcf2/scripts/nodejs-source-helper.ts#L88) — export const sourceEntries
- [scripts/nodejs-source-helper.ts:97](https://github.com/Automattic/kandelo/blob/f84ff24293d7b917b17feb258e74acad07a0dcf2/scripts/nodejs-source-helper.ts#L97) — kind === 'directory'
- [scripts/build-nodejs-test-vfs-image.ts:20](https://github.com/Automattic/kandelo/blob/f84ff24293d7b917b17feb258e74acad07a0dcf2/scripts/build-nodejs-test-vfs-image.ts#L20) — for (const name of sourceEntries(sourceRoot))
- [scripts/nodejs-browser-runner.ts:35](https://github.com/Automattic/kandelo/blob/f84ff24293d7b917b17feb258e74acad07a0dcf2/scripts/nodejs-browser-runner.ts#L35) — immutableImage(origin)

### #1612: Node: Apply connection defaults to real socket attempts

Head `60c3ce9b540b73723fccdf15318f94b2df1e7b93`; base `f84ff24293d7b917b17feb258e74acad07a0dcf2`.

**Upstream reuse:** No whole net/dns import. dns.lookup normalization/order, IP parsing, family alternation, connectionAttempt events, deadlines and Socket/TLS integration are handwritten JS.

**Backend:** Real getaddrinfo/inet_ntop lookup, IPv4/IPv6 nonblocking connect/local bind, SO_ERROR outcome, getsockname/getpeername and owned-fd cleanup. Promise identifies pending connect cancellation. Guest kernel/runtime fixes IPv6 wildcard source address while preserving bound port. Interfaces are private Promise/fd records, not Node TCPWrap/GetAddrInfoReqWrap bindings.

**Usefulness:** High socket/DNS/source-address/cancellation foundation and independent C-peer evidence; replace public connection policy.

**Disposition:**
- Adapt genuine operations/owners to upstream Node wrappers/request objects/callback timing, using later ownership-corrected code.
- Keep native-peer multi-address/bind/timeout/abort/error/cleanup tests.
- Replace handmade public net/dns option/result/attempt policy with whole upstream modules. Remaining fabricated dns.resolve records in the old bootstrap are not fixed by this PR and must not be carried as support.

**Evidence limitations:** Read-only source/diff audit; no tests, runtime probes, generation or builds. Historical evidence applies only to its exact source/artifact identity. This review does not establish runtime correctness, current main regression protection, or complete Node internalBinding contract fit.

**Source anchors:**
- [packages/registry/spidermonkey/patches/0029-kandelo-node-network-attempts.patch:55](https://github.com/Automattic/kandelo/blob/60c3ce9b540b73723fccdf15318f94b2df1e7b93/packages/registry/spidermonkey/patches/0029-kandelo-node-network-attempts.patch#L55) — static bool KandeloNativeSocketLookup
- [packages/registry/spidermonkey/patches/0029-kandelo-node-network-attempts.patch:234](https://github.com/Automattic/kandelo/blob/60c3ce9b540b73723fccdf15318f94b2df1e7b93/packages/registry/spidermonkey/patches/0029-kandelo-node-network-attempts.patch#L234) — static bool KandeloNativeSocketCancelConnect
- [packages/registry/spidermonkey/patches/0029-kandelo-node-network-attempts.patch:255](https://github.com/Automattic/kandelo/blob/60c3ce9b540b73723fccdf15318f94b2df1e7b93/packages/registry/spidermonkey/patches/0029-kandelo-node-network-attempts.patch#L255) — static bool KandeloNativeSocketAddress
- [packages/registry/node-compat/bootstrap.js:3916](https://github.com/Automattic/kandelo/blob/60c3ce9b540b73723fccdf15318f94b2df1e7b93/packages/registry/node-compat/bootstrap.js#L3916) — _nodeBeginSocketConnection = function
- [crates/kernel/src/wasm_api.rs:12007](https://github.com/Automattic/kandelo/blob/60c3ce9b540b73723fccdf15318f94b2df1e7b93/crates/kernel/src/wasm_api.rs#L12007) — A bound wildcard still selects
- [host/test/fixtures/node-network-peer.c:15](https://github.com/Automattic/kandelo/blob/60c3ce9b540b73723fccdf15318f94b2df1e7b93/host/test/fixtures/node-network-peer.c#L15) — int main

### #1613: Node: Separate public globals from embedding utilities

Head `8181022ff8206ac54d964ad9f2caaffdb6ac7d01`; base `60c3ce9b540b73723fccdf15318f94b2df1e7b93`.

**Upstream reuse:** None added as whole upstream Node files. _installNodeGlobalScope and ECMA/public-name/descriptor lists are handwritten target-derived bootstrap policy; buffer atob/btoa aliases reuse existing function identities, not a new imported module.

**Backend:** JavaScript engine-adapter boundary captures real shell utilities before removing shell globals; prepareGlobalScope deletes non-ECMA/nonpublic shell names while closures retain I/O/worker/shutdown functions. No new native C++/kernel operation.

**Usefulness:** High as bootstrap isolation requirements and public-global regression fixtures; moderate as code to transplant.

**Disposition:**
Keep safe capture/removal mechanism after loader design review. Replace/manual descriptor policy with upstream bootstrap mechanisms where applicable. Do not use non-enumerability as the privacy mechanism for privileged internal bindings.

**Required binding contract:** One private builtin/internalBinding environment, canonical global identities/descriptors and actual captured engine functions. Existing __kandelo* properties are made non-enumerable, not inaccessible; review exposure when designing the new environment.

**Evidence limitations:** Source reviewed. PR reports historical controls partly on descendant f0eaf908 (PR1614), not independent current-candidate proof. Fixture requirements transfer; source-specific bootstrap assertions need replacement.

**Source anchors:**
- [packages/registry/spidermonkey/node-compat/adapter.js](https://github.com/Automattic/kandelo/blob/8181022ff8206ac54d964ad9f2caaffdb6ac7d01/packages/registry/spidermonkey/node-compat/adapter.js) — shellGlobalNames / ecmaGlobalNames / _nodeNative.prepareGlobalScope
- [packages/registry/node-compat/bootstrap.js](https://github.com/Automattic/kandelo/blob/8181022ff8206ac54d964ad9f2caaffdb6ac7d01/packages/registry/node-compat/bootstrap.js) — _installNodeGlobalScope / _builtinModules.buffer.atob,btoa
- [host/test/fixtures/node-global-scope.ts](https://github.com/Automattic/kandelo/blob/8181022ff8206ac54d964ad9f2caaffdb6ac7d01/host/test/fixtures/node-global-scope.ts) — shared native/guest global-scope program

### #1614: Node: Load file entrypoints through the native module graph

Head `f0eaf9086765e269dd7257c327e7e11e2a03c5af`; base `8181022ff8206ac54d964ad9f2caaffdb6ac7d01`.

**Upstream reuse:** No whole Node CJS/ESM loader imported in this increment. Handwritten _makeRequire, _looksLikeEsmMain, namespace generation and CJS/ESM resolver remain; the regex static-import rewrite is removed in favor of real engine module evaluation.

**Backend:** SpiderMonkey ScriptPrivate origin registration for compiled CJS wrappers; real native import() submission, engine parse/link/cycles/TLA; resolve-only metadata hook avoids executing CJS during import.meta.resolve; file entry returns to owning jobs/I/O/timers loop and exits unresolved graph with status13.

**Usefulness:** Very high backend precursor for whole upstream loader integration; strong unchanged guest entrypoint/cycle/TLA/error fixtures.

**Disposition:**
Salvage compiled-script identity, native module graph and host event-loop handoff behind Node ModuleWrap/contextify-style bindings. Replace custom public resolution/cache/synthetic namespace policy with upstream Node loader/internal modules. Do not import the old loader wholesale.

**Required binding contract:** Real engine module records, identity and asynchronous evaluation must serve upstream ModuleWrap and loader contracts; custom /__kandelo_bare__ tokens, enumerable-property named-export snapshots and heuristic .js detection are not Node equivalents.

**Evidence limitations:** Historical normal-image four-host observations in PR body; not rerun. Component tests use VM/mocked importModule and do not prove native graphs. Existing package/format/URL/query/export-discovery gaps explicitly remain.

**Source anchors:**
- [packages/registry/spidermonkey/patches/0030-kandelo-node-module-entrypoints.patch](https://github.com/Automattic/kandelo/blob/f0eaf9086765e269dd7257c327e7e11e2a03c5af/packages/registry/spidermonkey/patches/0030-kandelo-node-module-entrypoints.patch) — JS::SetScriptPrivate / ProcessArgs / KandeloResolveBareSpecifier(resolveOnly) / ModuleLoader resolve
- [packages/registry/node-compat/bootstrap.js](https://github.com/Automattic/kandelo/blob/f0eaf9086765e269dd7257c327e7e11e2a03c5af/packages/registry/node-compat/bootstrap.js) — _makeRequire / _runEsmMain / __kandeloResolveBare / __kandeloNodeFinalize
- [host/test/fixtures/node-module-entrypoints.ts](https://github.com/Automattic/kandelo/blob/f0eaf9086765e269dd7257c327e7e11e2a03c5af/host/test/fixtures/node-module-entrypoints.ts) — CJS identity, native ESM cycles/TLA and error programs

### #1615: Node: Capture call sites from engine saved frames

Head `3dff86662e9b3e33df1df60065a08c5012ebbb54`; base `f0eaf9086765e269dd7257c327e7e11e2a03c5af`.

**Upstream reuse:** No whole upstream util module imported. getCallSites argument/options validation and result policy are handwritten; adapter traverses genuine SpiderMonkey SavedFrames.

**Backend:** Actual saveStack source IDs/function names/coordinates; C++ compile-options first-line support for wrapped CJS and ESM public sourceURL without changing native registry keys.

**Usefulness:** High engine capability for upstream util binding and diagnostics. Early public wrapper is migration debt.

**Disposition:**
Retain actual saved-frame/source-origin capabilities behind upstream internalBinding(util).getCallSites; replace public wrapper with whole upstream util. Preserve actual engine identity and recorded source-map limits; do not hardcode a two-frame skip into a different wrapper architecture.

**Required binding contract:** Upstream lib/util.js calls binding.getCallSites(frameCount). Caller filtering, UTF16 positions, script identity, GC/realm policy and source-map cache must remain coherent with whichever upstream stack layers execute.

**Evidence limitations:** PR retains explicit source-map failure, Amaro skip and ENOSPC harness setup failure. Existing historical frame checks are bounded; current combined source is not validated.

**Source anchors:**
- [packages/registry/spidermonkey/node-compat/adapter.js](https://github.com/Automattic/kandelo/blob/3dff86662e9b3e33df1df60065a08c5012ebbb54/packages/registry/spidermonkey/node-compat/adapter.js) — captureSavedStack / _nodeNative.captureCallSites
- [packages/registry/spidermonkey/patches/0031-kandelo-node-wrapper-source-origin.patch](https://github.com/Automattic/kandelo/blob/3dff86662e9b3e33df1df60065a08c5012ebbb54/packages/registry/spidermonkey/patches/0031-kandelo-node-wrapper-source-origin.patch) — CompileOptions firstLine / ModuleLoader sourceMeta.url
- [packages/registry/node-compat/bootstrap.js](https://github.com/Automattic/kandelo/blob/3dff86662e9b3e33df1df60065a08c5012ebbb54/packages/registry/node-compat/bootstrap.js) — util.getCallSites
- [host/test/fixtures/node-call-sites.ts](https://github.com/Automattic/kandelo/blob/3dff86662e9b3e33df1df60065a08c5012ebbb54/host/test/fixtures/node-call-sites.ts) — actual CJS/ESM/eval coordinates

### #1616: Node: Stop fatal exits before draining live work

Head `e667d0953d34bd61ba557c5aad092f58e6736843`; base `3dff86662e9b3e33df1df60065a08c5012ebbb54`.

**Upstream reuse:** No whole upstream internal/process/execution.js or promises.js imported here. ESM failure handler and native default-fatal policy are custom.

**Backend:** Engine preserves thrown timer/ESM failures, checks pending rejections at actual microtask checkpoints, stops draining native I/O/timers after fatal failure and reaches one finalizer instead of waiting forever on live handles.

**Usefulness:** High engine lifecycle prerequisite, but fatal-policy separation is essential.

**Disposition:**
Carry actual pending-exception/checkpoint/fatal-loop-stop capabilities; put policy and hook dispatch in upstream process modules. Reconcile later callback/uncaught recovery owners before reusing early hardcoded report/exit branches.

**Required binding contract:** Notify upstream rejection/uncaught handlers with original exception identity and correct fromPromise/checkpoint ordering; allow real fatal-vs-handled decision. Do not run parent JS after a terminal fatal decision or unconditionally override installed process handlers.

**Evidence limitations:** Historical focused four-host results, not current proof; custom uncaughtException/unhandledRejection/beforeExit remained gaps. Later mixed-fatal and intermittent Firefox failures were separately retained.

**Source anchors:**
- [packages/registry/spidermonkey/patches/0032-kandelo-node-fatal-event-loop.patch](https://github.com/Automattic/kandelo/blob/e667d0953d34bd61ba557c5aad092f58e6736843/packages/registry/spidermonkey/patches/0032-kandelo-node-fatal-event-loop.patch) — KandeloRunDueTimers / RunShellJobs / ReportUnhandledRejections
- [packages/registry/node-compat/bootstrap.js](https://github.com/Automattic/kandelo/blob/e667d0953d34bd61ba557c5aad092f58e6736843/packages/registry/node-compat/bootstrap.js) — _runEsmMain rejection callback
- [host/test/fixtures/node-fatal-exit.ts](https://github.com/Automattic/kandelo/blob/e667d0953d34bd61ba557c5aad092f58e6736843/host/test/fixtures/node-fatal-exit.ts) — fatal with live timers/child I/O and nonfatal controls

### #1617: Node: Back TCP listeners and half-close with real sockets

Head `0945a0f1378038068c347b5df538471d1325210a`; base `e667d0953d34bd61ba557c5aad092f58e6736843`.

**Upstream reuse:** No whole upstream net.js/Server/Socket imported. Handwritten Server/Socket implements overloads, async delivery, half-close and close/ref policy over the new primitives.

**Backend:** Real POSIX nonblocking socket/bind/listen/accept; FD_CLOEXEC and close-on-error ownership; asynchronous Accept watches; SHUT_WR; per-operation referenced state by actual promise/fd.

**Usefulness:** Very high backend starting point; real independent C peers/IPv4/IPv6/half-close tests are particularly reusable.

**Disposition:**
Retain socket semantics through a reviewed current native owner, expose Node tcp_wrap/stream_wrap request/handle contracts, and execute whole upstream net/stream logic. Replace the handwritten public Server/Socket and do not transplant bare-fd Promise API as the final binding interface.

**Required binding contract:** Pinned net.js depends on TCP/TCPConnectWrap, ShutdownWrap, Pipe/PipeConnectWrap and stream_base_commons. Handle lifetime, original callback receiver/request, cancellation/ref and accepted-owner transfer must conform; returning numeric fds and promises alone is insufficient.

**Evidence limitations:** Historical actual listener/C-peer four-host evidence is useful but not a current-candidate pass. Full overloads/socket controls/stream/IPC behavior were missing. Existing later ownership corrections mean the early patch should not be used in isolation.

**Source anchors:**
- [packages/registry/spidermonkey/patches/0033-kandelo-node-tcp-listeners.patch](https://github.com/Automattic/kandelo/blob/0945a0f1378038068c347b5df538471d1325210a/packages/registry/spidermonkey/patches/0033-kandelo-node-tcp-listeners.patch) — KandeloAcceptSocket / KandeloNativeSocketListen / KandeloNativeSocketAccept / KandeloNativeSocketShutdown / KandeloNativeSocketRef
- [packages/registry/node-compat/bootstrap.js](https://github.com/Automattic/kandelo/blob/0945a0f1378038068c347b5df538471d1325210a/packages/registry/node-compat/bootstrap.js) — net.Server.listen/_accept/close; Socket._adoptFd/_final
- [host/test/fixtures/node-tcp-server-peer.c](https://github.com/Automattic/kandelo/blob/0945a0f1378038068c347b5df538471d1325210a/host/test/fixtures/node-tcp-server-peer.c) — independent POSIX peer

### #1619: Node: Preserve exit-listener status and fatal diagnostics

Head `3a36145e0375b0f2d901d5a85091840d14054402`; base `0945a0f1378038068c347b5df538471d1325210a`.

**Upstream reuse:** No whole upstream process lifecycle module reuse in this increment. _runNaturalExit fatal/exit-listener policy and status-only query are handwritten.

**Backend:** C++ saves/restores the actual pending exception around a status query, reports original diagnostic and preserves validated Node status including explicit zero rather than letting standalone-shell reporter override it.

**Usefulness:** High lifecycle requirements and public exit controls; moderate direct code reuse because finalizer architecture changes.

**Disposition:**
Carry exception preservation and final native status/teardown mechanism. Move public exit emission/fatal policy into upstream process/bootstrap modules. Adapt the native query to a genuine process-owned status contract rather than retain an arbitrary public JS finalizer protocol.

**Required binding contract:** Exactly-once exit notification, actual authoritative exit code, original pending exception roots and fatal suppression semantics must compose with upstream process execution. Reporting a listener exception must not create a new status contrary to the chosen Node contract.

**Evidence limitations:** PR documents historical four-host controls and prior fixture/include-order failures, all not rerun. Custom uncaught/beforeExit lifecycle remained incomplete; source ownership does not prove current teardown behavior.

**Source anchors:**
- [packages/registry/spidermonkey/patches/0034-kandelo-node-exit-listener-status.patch](https://github.com/Automattic/kandelo/blob/3a36145e0375b0f2d901d5a85091840d14054402/packages/registry/spidermonkey/patches/0034-kandelo-node-exit-listener-status.patch) — AutoSaveExceptionState / restoreNodeStatus / nodeStatus
- [packages/registry/node-compat/bootstrap.js](https://github.com/Automattic/kandelo/blob/3a36145e0375b0f2d901d5a85091840d14054402/packages/registry/node-compat/bootstrap.js) — _runNaturalExit / __kandeloNodeFinalize(statusOnly)
- [host/test/fixtures/node-exit-listeners.ts](https://github.com/Automattic/kandelo/blob/3a36145e0375b0f2d901d5a85091840d14054402/host/test/fixtures/node-exit-listeners.ts) — status, cleared status, explicit exits and original diagnostics

### #1620: Node: Enforce TCP server connection limits

Head `d2fb64061ea9f9b50e756a9622595e46b2209b79`; base `3a36145e0375b0f2d901d5a85091840d14054402`.

**Upstream reuse:** No imported whole Node module or pinned source-excerpt wiring. Adds handwritten net.Server maxConnections/drop policy to the custom accept path.

**Backend:** No new native binding. Existing accept/address/close primitives are used to account live accepted connections, emit endpoint records and close excess descriptors in finally.

**Usefulness:** High as regression requirements, low as implementation to carry under the whole-net.js rule.

**Disposition:**
Keep unchanged upstream connection-limit/drop cases, actual endpoint/descriptor assertions and C-peer fixtures. Let upstream net.js own maxConnections/drop policy; supply accurate accept/endpoints/close and resource accounting beneath it.

**Required binding contract:** Upstream Server must see actual accepted handles and close completion. Capacity/drop accounting belongs to upstream public logic, not a second parallel connection counter in a bespoke public Server.

**Evidence limitations:** Historical focused four-host limit/drop evidence, not full net conformance. Cluster distribution/dropMaxConnection were absent. Later actual-owner acceptance paths supersede this early public counter wiring.

**Source anchors:**
- [packages/registry/node-compat/bootstrap.js](https://github.com/Automattic/kandelo/blob/d2fb64061ea9f9b50e756a9622595e46b2209b79/packages/registry/node-compat/bootstrap.js) — Server._accept maxConnections/drop/finally close
- [host/test/fixtures/node-tcp-server.ts](https://github.com/Automattic/kandelo/blob/d2fb64061ea9f9b50e756a9622595e46b2209b79/host/test/fixtures/node-tcp-server.ts) — zero-ipv4 / zero-ipv6 / release-capacity
- [tests/nodejs/README.md](https://github.com/Automattic/kandelo/blob/d2fb64061ea9f9b50e756a9622595e46b2209b79/tests/nodejs/README.md) — three selected upstream limit/drop tests

### #1621: Node: Preserve timer lifetime, cancellation and refresh

Head `d005cc6a1be679f6ecaa7ec26311c39f4cc137b5`; base `d2fb64061ea9f9b50e756a9622595e46b2209b79`.

**Upstream reuse:** No whole upstream timers or timers/promises imported by this PR. Timeout, Immediate, normalization/warnings, promisify and Promise timer/scheduler behavior are handwritten. Its private deadline heap is also custom JS, not Node internal/timers.

**Backend:** Native monotonicTime from SpiderMonkey TimeStamp and event-loop referenced-work check; JS scheduler separates deadlines from reference state, queues cancellable callbacks and permits microtask checkpoints between entered callbacks.

**Usefulness:** Very high clock/wakeup/ref foundations and timer behavior fixtures; substantial public/internal JS replacement required.

**Disposition:**
Keep real clock and backend liveness/wakeup capabilities. Execute whole upstream timers and internal/timers and implement their timers/task_queue bindings. Replace custom Timeout/Immediate/Promise timers, warnings/promisify and duplicate deadline heap policy; avoid two schedulers owning the same public lifecycle.

**Required binding contract:** Pinned internal/timers consumes immediateInfo/timeoutInfo, getLibuvNow/scheduleTimer/toggleTimerRef and task_queue enqueueMicrotask; it owns scheduling/async-hook algorithms. Existing per-callback heap API is not the same contract. Real warning/task queues, phase order, cancellation and receiver identity are needed.

**Evidence limitations:** Historical timer-specific four-host evidence exists alongside persistent upstream failures/unsupported/timeout and unresolved WebKit PATH ENOMEM; do not summarize whole milestone as all green. Component tests extract private code/use a synthetic clock, so retain public programs and retarget internal tests.

**Source anchors:**
- [packages/registry/spidermonkey/patches/0035-kandelo-node-timer-references.patch](https://github.com/Automattic/kandelo/blob/d005cc6a1be679f6ecaa7ec26311c39f4cc137b5/packages/registry/spidermonkey/patches/0035-kandelo-node-timer-references.patch) — KandeloNativeMonotonicTime / KandeloNodeTimersHaveReferences / RunShellJobs
- [packages/registry/spidermonkey/node-compat/adapter.js](https://github.com/Automattic/kandelo/blob/d005cc6a1be679f6ecaa7ec26311c39f4cc137b5/packages/registry/spidermonkey/node-compat/adapter.js) — createTimerScheduler
- [packages/registry/node-compat/bootstrap.js](https://github.com/Automattic/kandelo/blob/d005cc6a1be679f6ecaa7ec26311c39f4cc137b5/packages/registry/node-compat/bootstrap.js) — Timeout / Immediate / timersPromises / emitWarning / promisify
- [host/test/fixtures/node-timers.ts](https://github.com/Automattic/kandelo/blob/d005cc6a1be679f6ecaa7ec26311c39f4cc137b5/host/test/fixtures/node-timers.ts) — public timer/abort/ref/refresh programs

### #1622: Node: Run synchronous child processes through POSIX pipes

Head `9254e99aab3c7aba2ed4ae96e20e2f0a2a752d9c`; base `d005cc6a1be679f6ecaa7ec26311c39f4cc137b5`.

**Upstream reuse:** No whole upstream child_process.js/internal/child_process.js imported here. spawnSync/execSync/execFileSync validation, normalization, PATH/stdin/stdio/errors and credential/kill wrappers are handwritten.

**Backend:** Real synchronous POSIX child controller interleaves pipe I/O with wait/reap without pumping parent JS, monotonic timeout/maxBuffer/signals, RAII pipe/child cleanup, only parent endpoint nonblocking, close-on-exec and stdio-fd alias avoidance; real credentials/setsid; correct -e argv binding.

**Usefulness:** Very high native process/pipe foundation and independent PID/credential/session/cleanup test value. Binding adaptation and later fd-action fixes remain necessary.

**Disposition:**
Retain native child/pipe/credential/CLI mechanisms after reviewing successor ownership fixes. Implement upstream spawn_sync.spawn(options)/process_wrap/pipe_wrap contracts and use whole child_process modules for public validation/options/errors. Replace custom JS normalization and Linux-numbered errno map with authoritative guest error binding.

**Required binding contract:** Upstream internal/child_process.js calls internalBinding(spawn_sync).spawn(options); current API instead accepts an already-spawned pid, owned fd array and input/deadline limits. Preserve transfer ownership, no JS reentry, binary output and actual wait status while redesigning the adapter. Need authoritative errno/signals and normalized stdio, security/getter ordering.

**Evidence limitations:** Historical focused actual four-host peer/control evidence; one upstream required flag unsupported, not pass. Source/VM tests mock native seam and cannot prove native lifetimes. Full product/overall suites deferred and current binary products intentionally removed.

**Source anchors:**
- [packages/registry/spidermonkey/patches/0036-kandelo-node-sync-processes.patch](https://github.com/Automattic/kandelo/blob/9254e99aab3c7aba2ed4ae96e20e2f0a2a752d9c/packages/registry/spidermonkey/patches/0036-kandelo-node-sync-processes.patch) — KandeloNativePipe / KandeloSyncChild / KandeloNativeRunChildSync / KandeloNativeCredentials / BindScriptArgs
- [packages/registry/node-compat/bootstrap.js](https://github.com/Automattic/kandelo/blob/9254e99aab3c7aba2ed4ae96e20e2f0a2a752d9c/packages/registry/node-compat/bootstrap.js) — spawnSync / _spawnWithPath / checkSyncResult / process.kill
- [host/test/fixtures/node-sync-process-peer.c](https://github.com/Automattic/kandelo/blob/9254e99aab3c7aba2ed4ae96e20e2f0a2a752d9c/host/test/fixtures/node-sync-process-peer.c) — PID, uid/gid and session/process-group peer

### #1623: Node: Enforce socket inactivity deadlines

Head `bde15b2302d1127b8452692eaeeb3f14fde5fcd2`; base `9254e99aab3c7aba2ed4ae96e20e2f0a2a752d9c`.

**Upstream reuse:** No whole upstream net.js imported; custom SocketCore/ServerCore call/construct wrappers, timeout refresh, duration warnings and metadata object implement public behavior manually.

**Backend:** Genuine pending-write byte count from each native Write watch buffer.size()-offset. JS metadata is tied to one captured descriptor state and retired on close rather than reading a reused fd; real read/write activity refreshes unreferenced deadlines.

**Usefulness:** High backend observation/ownership and stalled-vs-progressing write tests; public timeout/constructor code should be replaced.

**Disposition:**
Reuse actual write-progress accounting behind Node-compatible StreamBase/TCP handle properties and callbacks. Let upstream net.js/internal stream helpers implement timeout policy and constructors. Keep private owner/generation authority, not a mutable public _handle metadata object, as the source of truth.

**Required binding contract:** Pinned net.js uses stream_base_commons.setStreamTimeout and native handle writeQueueSize. Its actual retained write request/handle must own byte offsets across partial writes, closure, fd reuse, cancellation and callbacks. Early global watch-list/fd lookup is a primitive, not the finished upstream handle contract.

**Evidence limitations:** Historical focused upstream/socket/C-peer four-host evidence; full net/stream/socket controls remained gaps and prior WebKit spawn anomaly persists separately. Many component tests execute custom Socket fragments against mocked natives; retain unchanged public/peer tests when replacing implementation.

**Source anchors:**
- [packages/registry/spidermonkey/patches/0037-kandelo-socket-write-progress.patch](https://github.com/Automattic/kandelo/blob/bde15b2302d1127b8452692eaeeb3f14fde5fcd2/packages/registry/spidermonkey/patches/0037-kandelo-socket-write-progress.patch) — KandeloNativeSocketWriteQueueSize
- [packages/registry/node-compat/bootstrap.js](https://github.com/Automattic/kandelo/blob/bde15b2302d1127b8452692eaeeb3f14fde5fcd2/packages/registry/node-compat/bootstrap.js) — SocketCore._ownSocketFd / _unrefTimer / _onTimeout / setTimeout / Socket,Server wrappers
- [host/test/fixtures/node-socket-write-peer.c](https://github.com/Automattic/kandelo/blob/bde15b2302d1127b8452692eaeeb3f14fde5fcd2/host/test/fixtures/node-socket-write-peer.c) — independent write-progress peer
- [host/test/fixtures/node-socket-timeouts.ts](https://github.com/Automattic/kandelo/blob/bde15b2302d1127b8452692eaeeb3f14fde5fcd2/host/test/fixtures/node-socket-timeouts.ts) — shared native/guest public controls

### #1653: Node: Add native SQLite, FIPS and TTY foundations

Head `d210a21f8fe580bb8926bd052abf5d2328103708`; base `18b6947f2bdce203e219517beeb531fb2b95fc6b`.

**Upstream reuse:** Adds crypto-util FIPS cache excerpt to existing whole WebIDL. SQLTagStore public JS is handwritten.

**Backend:** Real ncrypto FIPS state/generation; native constructible TTY and init-before-fd admission; SQLite statement LRU/GC/connection ownership.

**Usefulness:** High backend value. Reuse native owners after contract review; replace public SQLite/crypto wrappers with upstream modules/native binding exports.

**Disposition:**
High backend value. Reuse native owners after contract review; replace public SQLite/crypto wrappers with upstream modules/native binding exports.

**Evidence limitations:** No fresh runtime tests/builds/probes. Source inspection and historical component controls do not establish isolated PR correctness or guest/four-host compatibility. Later patches supersede earlier owner interfaces.

**Source anchors:**
- [third_party/node-core/crypto-webidl-sources.json:54](https://github.com/Automattic/kandelo/blob/d210a21f8fe580bb8926bd052abf5d2328103708/third_party/node-core/crypto-webidl-sources.json#L54) — "fipsState"
- [third_party/node-core/native-terminal.cpp:761](https://github.com/Automattic/kandelo/blob/d210a21f8fe580bb8926bd052abf5d2328103708/third_party/node-core/native-terminal.cpp#L761) — static bool KandeloTerminalInitializeStream
- [third_party/node-core/native-sqlite.cpp:601](https://github.com/Automattic/kandelo/blob/d210a21f8fe580bb8926bd052abf5d2328103708/third_party/node-core/native-sqlite.cpp#L601) — static bool KandeloSqliteTagOperation
- [third_party/node-core/sqlite-platform-adapter.js:346](https://github.com/Automattic/kandelo/blob/d210a21f8fe580bb8926bd052abf5d2328103708/third_party/node-core/sqlite-platform-adapter.js#L346) — function createTagStore

### #1655: Node: Extend Promise, DNS, TCP and crypto compatibility

Head `5bd3bd32938986aa40e0b03a36b0c429b3de4d81`; base `d210a21f8fe580bb8926bd052abf5d2328103708`.

**Upstream reuse:** getMacs/FIPS-generation cache excerpts from internal/crypto/util.js. Imported crypto_mac.cc is a reference, not unchanged compiled Node implementation. Async JS dispatch remains custom.

**Backend:** OpenSSL provider MAC names; c-ares resolver fallback reconfiguration; accepted TCP capabilities/listener admission; engine Promise identity/observer channels and private microtasks.

**Usefulness:** High shared-backend value. Carry final coherent DNS/TCP/Promise owners, including1662 listener restoration; replace helper splicing/private lifecycle dispatch with full upstream internal consumers.

**Disposition:**
High shared-backend value. Carry final coherent DNS/TCP/Promise owners, including1662 listener restoration; replace helper splicing/private lifecycle dispatch with full upstream internal consumers.

**Evidence limitations:** No fresh runtime tests/builds/probes. Source inspection and historical component controls do not establish isolated PR correctness or guest/four-host compatibility. Later patches supersede earlier owner interfaces.

**Source anchors:**
- [third_party/node-core/digest-operations.h:136](https://github.com/Automattic/kandelo/blob/5bd3bd32938986aa40e0b03a36b0c429b3de4d81/third_party/node-core/digest-operations.h#L136) — inline std::vector<std::string> MacNames()
- [third_party/node-core/dns-resolver.h:171](https://github.com/Automattic/kandelo/blob/5bd3bd32938986aa40e0b03a36b0c429b3de4d81/third_party/node-core/dns-resolver.h#L171) — int EnsureServersLocked()
- [third_party/node-core/native-listener.cpp:199](https://github.com/Automattic/kandelo/blob/5bd3bd32938986aa40e0b03a36b0c429b3de4d81/third_party/node-core/native-listener.cpp#L199) — static bool KandeloNativeListenerStart
- [third_party/node-core/sources.json:3177](https://github.com/Automattic/kandelo/blob/5bd3bd32938986aa40e0b03a36b0c429b3de4d81/third_party/node-core/sources.json#L3177) — "runtimeProviderCache"

### #1656: Node: Extend spawn, Fetch, Worker and benchmark foundations

Head `3087652d4f98f679b06c988fa49a01e2883f9f0d`; base `5bd3bd32938986aa40e0b03a36b0c429b3de4d81`.

**Upstream reuse:** Whole bench_runner benchmark/harness/benchmarks_stream/runner and internal/error_serdes become testing factories. Public node:bench remains inactive. Spawn-timeout, data-URL fetch and Worker constructor orchestration are custom JS.

**Backend:** Real Worker warning CLI/execArgv/env parsing reaches child bootstrap; actual histogram/clock/clone/V8 dependencies. Timeout/cancel paths consume real timers/processes/streams but are higher-level JS orchestration.

**Usefulness:** Keep full internal sources and reusable Worker startup/CLI owners. Replace custom child_process/Worker/Undici public algorithms as full upstream modules activate; retain their error/order/cancellation obligations.

**Disposition:**
Keep full internal sources and reusable Worker startup/CLI owners. Replace custom child_process/Worker/Undici public algorithms as full upstream modules activate; retain their error/order/cancellation obligations.

**Evidence limitations:** No fresh runtime tests/builds/probes. Source inspection and historical component controls do not establish isolated PR correctness or guest/four-host compatibility. Later patches supersede earlier owner interfaces. Public benchmark activation and real V8 serializer remain missing.

**Source anchors:**
- [third_party/node-core/build.py:1563](https://github.com/Automattic/kandelo/blob/3087652d4f98f679b06c988fa49a01e2883f9f0d/third_party/node-core/build.py#L1563) — for name, text in testing_sources.items():
- [third_party/node-core/native-worker.cpp:136](https://github.com/Automattic/kandelo/blob/3087652d4f98f679b06c988fa49a01e2883f9f0d/third_party/node-core/native-worker.cpp#L136) — if (!strcmp(operation.get(), "execArgv"))
- [third_party/node-core/fetch-body-platform-adapter.js:54](https://github.com/Automattic/kandelo/blob/3087652d4f98f679b06c988fa49a01e2883f9f0d/third_party/node-core/fetch-body-platform-adapter.js#L54) — async function fetchDataURL
- [third_party/node-core/testing-platform-adapter.js:67](https://github.com/Automattic/kandelo/blob/3087652d4f98f679b06c988fa49a01e2883f9f0d/third_party/node-core/testing-platform-adapter.js#L67) — if (name === 'v8')

### #1658: Node: Extend native stream and TLS certificate handling

Head `952a3f4b85a271bb15eef02c9d039d03c9b9c4ee`; base `3087652d4f98f679b06c988fa49a01e2883f9f0d`.

**Upstream reuse:** writeGeneric is selected and rewritten; translatePeerCertificate is selected from newly imported full internal/tls/common.js. Existing full X509 module remains consumed; no new full net/tls module.

**Backend:** Actual TCP/TTY native string writes, TTY ShutdownWrap and OpenSSL peer-certificate/legacy material conversion with owned bytes.

**Usefulness:** High StreamBase/TTY/X509 backend value. Reconcile native shapes/lifetimes with upstream bindings; replace custom TLSSocket methods and selected dispatch helpers.

**Disposition:**
High StreamBase/TTY/X509 backend value. Reconcile native shapes/lifetimes with upstream bindings; replace custom TLSSocket methods and selected dispatch helpers.

**Evidence limitations:** No fresh runtime tests/builds/probes. Source inspection and historical component controls do not establish isolated PR correctness or guest/four-host compatibility. Later patches supersede earlier owner interfaces.

**Source anchors:**
- [third_party/node-core/build.py:749](https://github.com/Automattic/kandelo/blob/952a3f4b85a271bb15eef02c9d039d03c9b9c4ee/third_party/node-core/build.py#L749) — if name == 'writeGeneric':
- [third_party/node-core/build.py:2374](https://github.com/Automattic/kandelo/blob/952a3f4b85a271bb15eef02c9d039d03c9b9c4ee/third_party/node-core/build.py#L2374) — legacy_spec = x509_spec['selections']['legacyTranslation']
- [third_party/node-core/native-socket-owner.cpp:728](https://github.com/Automattic/kandelo/blob/952a3f4b85a271bb15eef02c9d039d03c9b9c4ee/third_party/node-core/native-socket-owner.cpp#L728) — static bool KandeloSocketWriteString
- [third_party/node-core/x509-operations.h:217](https://github.com/Automattic/kandelo/blob/952a3f4b85a271bb15eef02c9d039d03c9b9c4ee/third_party/node-core/x509-operations.h#L217) — X509Legacy Legacy() const

### #1659: Node: Own source-map caches and backing snapshots

Head `05087555fd0b1456ed1a3160e7408c64394d6e73`; base `952a3f4b85a271bb15eef02c9d039d03c9b9c4ee`.

**Upstream reuse:** Whole source-map cache/cache-map factories join existing whole SourceMap; private storage is rewritten. Full util.js/modules/helpers.js imports supply selected helpers rather than complete dependency execution.

**Backend:** Rooted CJS sourceURL/sourceMappingURL capture before execution; real current-runtime ArrayBuffer allocation census and allocator byte sizes, not process.memoryUsage/RSS/V8 heap support.

**Usefulness:** Reuse compiler metadata and needed observation capabilities. Replace local source-map dependency maps/private-symbol substitutions with full upstream modules and correct shared bindings.

**Disposition:**
Reuse compiler metadata and needed observation capabilities. Replace local source-map dependency maps/private-symbol substitutions with full upstream modules and correct shared bindings.

**Evidence limitations:** No fresh runtime tests/builds/probes. Source inspection and historical component controls do not establish isolated PR correctness or guest/four-host compatibility. Later patches supersede earlier owner interfaces.

**Source anchors:**
- [third_party/node-core/build.py:2192](https://github.com/Automattic/kandelo/blob/05087555fd0b1456ed1a3160e7408c64394d6e73/third_party/node-core/build.py#L2192) — for name, source_name in source_map_spec['cacheModules'].items():
- [third_party/node-core/native-module-syntax.cpp:42](https://github.com/Automattic/kandelo/blob/05087555fd0b1456ed1a3160e7408c64394d6e73/third_party/node-core/native-module-syntax.cpp#L42) — static bool KandeloPublishCommonJsSourceInfo
- [third_party/node-core/native-retained-memory.cpp:60](https://github.com/Automattic/kandelo/blob/05087555fd0b1456ed1a3160e7408c64394d6e73/third_party/node-core/native-retained-memory.cpp#L60) — static bool KandeloNativeBackingSnapshot
- [third_party/node-core/source-map-platform-adapter.js:52](https://github.com/Automattic/kandelo/blob/05087555fd0b1456ed1a3160e7408c64394d6e73/third_party/node-core/source-map-platform-adapter.js#L52) — function internalBinding(name)

### #1660: Node: Own assertion sources and parser retirement

Head `853f7702bd806603e2d416fdfcc2f9c967c9f772`; base `05087555fd0b1456ed1a3160e7408c64394d6e73`.

**Upstream reuse:** Executes whole internal/freelist.js for parser pooling. error_source.js becomes selected getFirstExpression tokenizer plus custom wrapper; assert-utils gets a source replacement. Vendored whole Acorn alone is not whole error_source execution.

**Backend:** Actual SpiderMonkey caller script/PC/source capture; llhttp Reset/Release with deferred Free/Close preserving active frame/input, list membership and publication rollback.

**Usefulness:** High parser lifecycle value; source capture useful but diagnostic parity partial. Carry real native mechanics with later UTF8/AsyncReset fixes; replace selected assertion/parser orchestration with upstream internals.

**Disposition:**
High parser lifecycle value; source capture useful but diagnostic parity partial. Carry real native mechanics with later UTF8/AsyncReset fixes; replace selected assertion/parser orchestration with upstream internals.

**Evidence limitations:** No fresh runtime tests/builds/probes. Source inspection and historical component controls do not establish isolated PR correctness or guest/four-host compatibility. Later patches supersede earlier owner interfaces.

**Source anchors:**
- [third_party/node-core/build.py:50](https://github.com/Automattic/kandelo/blob/853f7702bd806603e2d416fdfcc2f9c967c9f772/third_party/node-core/build.py#L50) — assert_source_selection = assert_source_spec['tokenizer']
- [third_party/node-core/build.py:2280](https://github.com/Automattic/kandelo/blob/853f7702bd806603e2d416fdfcc2f9c967c9f772/third_party/node-core/build.py#L2280) — marker = '/* NODE_HTTP_FREE_LIST */'
- [third_party/node-core/native-error-source.cpp:13](https://github.com/Automattic/kandelo/blob/853f7702bd806603e2d416fdfcc2f9c967c9f772/third_party/node-core/native-error-source.cpp#L13) — static bool KandeloCaptureAssertionSource
- [third_party/node-core/native-http-parser.cpp:33](https://github.com/Automattic/kandelo/blob/853f7702bd806603e2d416fdfcc2f9c967c9f772/third_party/node-core/native-http-parser.cpp#L33) — static void KandeloHttpRetire

### #1661: Node: Connect FIPS state and diagnostic consumers

Head `4ff3fb09a49bb0faf195d1b416986da9108080bd`; base `853f7702bd806603e2d416fdfcc2f9c967c9f772`.

**Upstream reuse:** Whole internal benchmark JSON/Spec reporter modules become factories; public node:bench/reporters inactive. Public getFips/setFips/accessors reproduce selected ordinary crypto.js branches by hand.

**Backend:** Real ncrypto FIPS mutation/generation, process/Worker ownership gate and locked error queue; ScriptSource UTF8 offset decoding.

**Usefulness:** Reuse native FIPS/error and source decoding; keep full reporters. Replace handwritten crypto public installer; forced startup/config/provider admission and serializer remain prerequisites.

**Disposition:**
Reuse native FIPS/error and source decoding; keep full reporters. Replace handwritten crypto public installer; forced startup/config/provider admission and serializer remain prerequisites.

**Evidence limitations:** No fresh runtime tests/builds/probes. Source inspection and historical component controls do not establish isolated PR correctness or guest/four-host compatibility. Later patches supersede earlier owner interfaces.

**Source anchors:**
- [third_party/node-core/crypto-fips-platform-adapter.js:4](https://github.com/Automattic/kandelo/blob/4ff3fb09a49bb0faf195d1b416986da9108080bd/third_party/node-core/crypto-fips-platform-adapter.js#L4) — function _installNodeCryptoFips
- [third_party/node-core/native-digests.cpp:246](https://github.com/Automattic/kandelo/blob/4ff3fb09a49bb0faf195d1b416986da9108080bd/third_party/node-core/native-digests.cpp#L246) — static bool KandeloNativeSetFipsCrypto
- [third_party/node-core/native-error-source.cpp:48](https://github.com/Automattic/kandelo/blob/4ff3fb09a49bb0faf195d1b416986da9108080bd/third_party/node-core/native-error-source.cpp#L48) — const bool utf8 =
- [third_party/node-core/sources.json:2264](https://github.com/Automattic/kandelo/blob/4ff3fb09a49bb0faf195d1b416986da9108080bd/third_party/node-core/sources.json#L2264) — "internal/bench_runner/reporter/json"

### #1662: Restore Node listener and public TTY foundations

Head `cceda903aa26a4968fe8fd683c5a688734ed0667`; base `4ff3fb09a49bb0faf195d1b416986da9108080bd`.

**Upstream reuse:** Executes complete upstream lib/tty.js through a factory and exposes builtin tty, replacing empty public stream shells. Source-map support getter reuses existing cache module. Dependencies still use private maps.

**Backend:** Restores missing matching listener engine dispatcher/binding, successful-listen read registration, accepted-fd rollback and callback scope; unwraps actual TTY shutdown request packet.

**Usefulness:** Strong recent example of desired whole-module direction. Reuse tty_wrap/StreamBase/listener owners behind shared bindings; carry with1655 and subsequent fixes, not isolated cherry-pick.

**Disposition:**
Strong recent example of desired whole-module direction. Reuse tty_wrap/StreamBase/listener owners behind shared bindings; carry with1655 and subsequent fixes, not isolated cherry-pick.

**Evidence limitations:** No fresh runtime tests/builds/probes. Source inspection and historical component controls do not establish isolated PR correctness or guest/four-host compatibility. Later patches supersede earlier owner interfaces.

**Source anchors:**
- [third_party/node-core/build.py:1208](https://github.com/Automattic/kandelo/blob/cceda903aa26a4968fe8fd683c5a688734ed0667/third_party/node-core/build.py#L1208) — terminal_public_source =
- [third_party/node-core/tty-public-platform-adapter.js:15](https://github.com/Automattic/kandelo/blob/cceda903aa26a4968fe8fd683c5a688734ed0667/third_party/node-core/tty-public-platform-adapter.js#L15) — if (name !== 'tty_wrap')
- [third_party/node-core/listener-owner.h:29](https://github.com/Automattic/kandelo/blob/cceda903aa26a4968fe8fd683c5a688734ed0667/third_party/node-core/listener-owner.h#L29) — int Listen(int backlog)
- [third_party/node-core/native-listener.cpp:136](https://github.com/Automattic/kandelo/blob/cceda903aa26a4968fe8fd683c5a688734ed0667/third_party/node-core/native-listener.cpp#L136) — static bool KandeloListenerReadRegistered

### #1663: Preserve Node Promise and queued socket ownership

Head `c17c1ee7180194cbb70562b32f7bc0d7f6c10ddd`; base `cceda903aa26a4968fe8fd683c5a688734ed0667`.

**Upstream reuse:** Updates custom async adapter for actual Promise parent and custom Fetch argument/WebIDL boundary.

**Backend:** Real rooted engine Promise-parent channel; TCP connect/read/write registration, ordered queued/zero-byte writes, failed-connect cancellation and callback retirement; DEBUG-only nursery release-build correction.

**Usefulness:** High Promise/TCP foundation value. Reconcile final owner interfaces with upstream async_hooks/net; public Promise registry remains missing. Replace Fetch facade; retain ordering/identity failures.

**Disposition:**
High Promise/TCP foundation value. Reconcile final owner interfaces with upstream async_hooks/net; public Promise registry remains missing. Replace Fetch facade; retain ordering/identity failures.

**Evidence limitations:** No fresh runtime tests/builds/probes. Source inspection and historical component controls do not establish isolated PR correctness or guest/four-host compatibility. Later patches supersede earlier owner interfaces. Later cumulative source271 producing3c52b3233e compiled/linked/cache-accepted but ran no guest startup/API/four-host tests; original retention wrapper failure was corrected separately.

**Source anchors:**
- [third_party/node-core/async-platform-adapter.js:268](https://github.com/Automattic/kandelo/blob/c17c1ee7180194cbb70562b32f7bc0d7f6c10ddd/third_party/node-core/async-platform-adapter.js#L268) — function lifecycle(kind, resource, capturedFrame, promiseParent)
- [third_party/node-core/native-socket-owner.cpp:634](https://github.com/Automattic/kandelo/blob/c17c1ee7180194cbb70562b32f7bc0d7f6c10ddd/third_party/node-core/native-socket-owner.cpp#L634) — static bool KandeloSocketHasQueuedWrite
- [third_party/node-core/socket-owner.h:111](https://github.com/Automattic/kandelo/blob/c17c1ee7180194cbb70562b32f7bc0d7f6c10ddd/third_party/node-core/socket-owner.h#L111) — class Registration

### #1664: Node: Connect SQLite extensions and core resource policies

Head `b17352a6c379ca67dc7cd20ee8e97c586a97a393`; base `c17c1ee7180194cbb70562b32f7bc0d7f6c10ddd`.

**Upstream reuse:** SQLite extension wrappers and environment descriptor handler remain handwritten; codec changes are native.

**Backend:** Actual SQLite connection extension permission/enable/load lifetime; native Brotli/Zstd init errors; real legacy watcher event interest/retirement; own-field env descriptor semantics.

**Usefulness:** High backend correctness/security value. Expose proper native SQLite/env bindings; retain side-module format/ABI/permission and throwing error-setter obligations rather than carrying bespoke public JS wholesale.

**Disposition:**
High backend correctness/security value. Expose proper native SQLite/env bindings; retain side-module format/ABI/permission and throwing error-setter obligations rather than carrying bespoke public JS wholesale.

**Evidence limitations:** No fresh runtime tests/builds/probes. Source inspection and historical component controls do not establish isolated PR correctness or guest/four-host compatibility. Later patches supersede earlier owner interfaces. Source272-275 changes postdate accepted271 and remain uncompiled/unexecuted.

**Source anchors:**
- [third_party/node-core/sqlite-store.h:148](https://github.com/Automattic/kandelo/blob/b17352a6c379ca67dc7cd20ee8e97c586a97a393/third_party/node-core/sqlite-store.h#L148) — void CheckLoadExtension() const
- [third_party/node-core/native-sqlite.cpp:760](https://github.com/Automattic/kandelo/blob/b17352a6c379ca67dc7cd20ee8e97c586a97a393/third_party/node-core/native-sqlite.cpp#L760) — else if (operation == "loadExtension")
- [third_party/node-core/codec-handle.cpp:292](https://github.com/Automattic/kandelo/blob/b17352a6c379ca67dc7cd20ee8e97c586a97a393/third_party/node-core/codec-handle.cpp#L292) — static bool KandeloCodecCodedError
- [third_party/node-core/process-state-adapter.js:57](https://github.com/Automattic/kandelo/blob/b17352a6c379ca67dc7cd20ee8e97c586a97a393/third_party/node-core/process-state-adapter.js#L57) — define(key, descriptor)

### #1665: Node: Preserve HTTP and TLS resource lifetimes

Head `4ef78a500868092e2e026d56cd87a9e570329280`; base `b17352a6c379ca67dc7cd20ee8e97c586a97a393`.

**Upstream reuse:** Custom HTTP resource classes/parser orchestration and net-before-stdio bootstrap order around previously imported modules.

**Backend:** HTTP native AsyncReset/resource/frame/provider ownership and per-callback task checkpoints; deferred parser retirement; TLS real SSL read/write interest and input/output progress.

**Usefulness:** High HTTP/TLS/AsyncWrap value. Carry real lifecycle/event-interest mechanisms; use complete upstream HTTP/bootstrap orchestration and normal binding contracts. Preserve early stdio/Socket ordering constraint.

**Disposition:**
High HTTP/TLS/AsyncWrap value. Carry real lifecycle/event-interest mechanisms; use complete upstream HTTP/bootstrap orchestration and normal binding contracts. Preserve early stdio/Socket ordering constraint.

**Evidence limitations:** No fresh runtime tests/builds/probes. Source inspection and historical component controls do not establish isolated PR correctness or guest/four-host compatibility. Later patches supersede earlier owner interfaces. Source272-275 changes postdate accepted271 and remain uncompiled/unexecuted.

**Source anchors:**
- [third_party/node-core/native-http-parser.cpp:111](https://github.com/Automattic/kandelo/blob/4ef78a500868092e2e026d56cd87a9e570329280/third_party/node-core/native-http-parser.cpp#L111) — static bool KandeloHttpResetAsync
- [third_party/node-core/native-callback.cpp:79](https://github.com/Automattic/kandelo/blob/4ef78a500868092e2e026d56cd87a9e570329280/third_party/node-core/native-callback.cpp#L79) — bool Checkpoint()
- [third_party/node-core/http-parser-platform-adapter.js:26](https://github.com/Automattic/kandelo/blob/4ef78a500868092e2e026d56cd87a9e570329280/third_party/node-core/http-parser-platform-adapter.js#L26) — class HTTPClientAsyncResource
- [third_party/node-core/tls-owner.h:226](https://github.com/Automattic/kandelo/blob/4ef78a500868092e2e026d56cd87a9e570329280/third_party/node-core/tls-owner.h#L226) — ReadMayProgress

### #1666: Node: Connect source maps and core metadata owners

Head `6e14e85198334c371c74ad55ed664dca78cea5df`; base `4ef78a500868092e2e026d56cd87a9e570329280`.

**Upstream reuse:** getCurves and reconstructCallSite/mapCallSite excerpts inserted into adapters; custom Fetch dispatch now consumes genuine Request record. No new whole crypto/util module.

**Backend:** Actual ncrypto curve enumeration; five separate engine Promise observations/AsyncWrap identity admission and settled-once state; real private source-map cache for explicit call-site mapping.

**Usefulness:** High engine/provider value. Wire complete shared Promise-hook registry and upstream crypto/util/Undici modules. Retain real identity/cancellation/source-position requirements; replace helper assembly.

**Disposition:**
High engine/provider value. Wire complete shared Promise-hook registry and upstream crypto/util/Undici modules. Retain real identity/cancellation/source-position requirements; replace helper assembly.

**Evidence limitations:** No fresh runtime tests/builds/probes. Source inspection and historical component controls do not establish isolated PR correctness or guest/four-host compatibility. Later patches supersede earlier owner interfaces. Source272-275 changes postdate accepted271 and remain uncompiled/unexecuted. Shared public Promise registry/ordinary errors remain held; raw engine channel alone is not support.

**Source anchors:**
- [third_party/node-core/build.py:2211](https://github.com/Automattic/kandelo/blob/6e14e85198334c371c74ad55ed664dca78cea5df/third_party/node-core/build.py#L2211) — callsite_marker = '/* NODE_UTIL_CALLSITE_MAPPING */'
- [third_party/node-core/native-digests.cpp:330](https://github.com/Automattic/kandelo/blob/6e14e85198334c371c74ad55ed664dca78cea5df/third_party/node-core/native-digests.cpp#L330) — static bool KandeloNativeCurveNames
- [third_party/node-core/native-async.cpp:292](https://github.com/Automattic/kandelo/blob/6e14e85198334c371c74ad55ed664dca78cea5df/third_party/node-core/native-async.cpp#L292) — static bool KandeloNativeSetPromiseHookMode
- [third_party/node-core/source-map-platform-adapter.js:63](https://github.com/Automattic/kandelo/blob/6e14e85198334c371c74ad55ed664dca78cea5df/third_party/node-core/source-map-platform-adapter.js#L63) — const lazySourceMap = cache;

### #1667: Node: Connect filesystem checks, HTTP timing and guest groups

Head `5f19f5f1c61cc80adb8e39e1f8470b497f34e9c8`; base `6e14e85198334c371c74ad55ed664dca78cea5df`.

**Upstream reuse:** Exact fs.exists/existsSync/custom-promisify section and _http_client timing start/stop excerpts. Removes invented fs.promises.exists. No whole fs/ClientRequest execution added.

**Backend:** Real supplementary-group syscall snapshots/effective-GID inclusion and native error/array publication; existing FS access queue and actual HTTP clock/observer events consumed.

**Usefulness:** Narrow credentials backend useful. fs/HTTP sections should become redundant under whole upstream modules. Keep API-absence and timing-order obligations; expose GetGroups through upstream credentials binding.

**Disposition:**
Narrow credentials backend useful. fs/HTTP sections should become redundant under whole upstream modules. Keep API-absence and timing-order obligations; expose GetGroups through upstream credentials binding.

**Evidence limitations:** No fresh runtime tests/builds/probes. Source inspection and historical component controls do not establish isolated PR correctness or guest/four-host compatibility. Later patches supersede earlier owner interfaces. Source272-275 changes postdate accepted271 and remain uncompiled/unexecuted.

**Source anchors:**
- [third_party/node-core/sources.json:4524](https://github.com/Automattic/kandelo/blob/5f19f5f1c61cc80adb8e39e1f8470b497f34e9c8/third_party/node-core/sources.json#L4524) — function exists(path, callback) {
- [third_party/node-core/http-agent-adapter.js:89](https://github.com/Automattic/kandelo/blob/5f19f5f1c61cc80adb8e39e1f8470b497f34e9c8/third_party/node-core/http-agent-adapter.js#L89) — function observeResponseHeaders
- [third_party/node-core/process-state.h:31](https://github.com/Automattic/kandelo/blob/5f19f5f1c61cc80adb8e39e1f8470b497f34e9c8/third_party/node-core/process-state.h#L31) — inline GroupsResult GetGroups()
- [third_party/node-core/native-os.cpp:65](https://github.com/Automattic/kandelo/blob/5f19f5f1c61cc80adb8e39e1f8470b497f34e9c8/third_party/node-core/native-os.cpp#L65) — static bool KandeloProcessGroupsError

