# Family survey

This is the first source survey under the audit-only goal, not a completed
family audit. At this initial checkpoint every family still needed its
public obligations reconciled, including inherited behavior and owning-layer semantics.
References describe the source candidate, not a built artifact.

## All 19 families

| Family | Source routes and concrete initial observations | Work still needed for source-audit sign-off |
|---|---|---|
| values | Bootstrap Buffer/util/querystring/legacy URL plus pinned assertion, path, inspection and numeric adapters; see `values.md` | Resolve each documented and captured API, descriptors, brands, errors, encoding and allocation |
| async | Pinned async/event adapters and engine hooks coexist with inert diagnostics channels; `domain` absent from public registry | Trace all hooks, promises, timers, event mutation, lifetime, domains and diagnostics subscriptions |
| streams | `third_party/node-core/stream-platform-adapter.js` supplies pinned classic/Web modules but throws for private MessageChannel transport | Audit full public and inherited methods, adapters, cancellation, byte ownership and I/O subclasses |
| filesystem | Native descriptor/read jobs coexist with legacy pathname methods and no-op watchers | Reconcile final overrides first, then all sync/callback/promise APIs, paths, metadata, watchers and resource ownership |
| processes | Bootstrap process/child_process/os plus native spawn; `cluster` exports identity booleans only | Credentials, signals, lifecycle, stdio, IPC, spawn overloads, real OS metadata and cluster distribution |
| network | Real Socket/Server paths and lookup adapter coexist with fabricated `dns.resolve` results; `dgram` absent from registry | Full DNS/Resolver, UDP, TCP controls, descriptors, accept lifecycle and host transport routes |
| http | Bootstrap custom client/parser; public server creation throws; HTTP/2 exposes empty constants only | Agents, parsers, pooling, headers/trailers, server behavior, HTTP/2 and protocol lifetime |
| secure-network | Native libssl client path; several public controls/metadata are constant/no-op; DTLS/QUIC absent | Real handshake/trust/identity/metadata, server sessions, capability gates and protocol backends |
| crypto | Completed source/negative-route review: native hashes/HMAC and real entropy coexist with NUL truncation, view-unit/quota/async gaps and missing key/cipher/Web Crypto APIs | Implementation and runtime validation remain absent or partial; C-001–C-016 in crypto-contracts.md preserve exact owners and target questions |
| web | Pinned Web Streams and custom Blob/body code; File/FormData placeholders and absent subtle crypto in fallback global | Every documented global, final overrides, Fetch/WebIDL semantics, transfer, channels and encodings |
| loading | Shared public builtin policy plus custom CommonJS/ES-module loader | Resolution, packages, cache identity, hooks, live exports, CLI activation, TypeScript and source maps |
| terminal | `tty` stream classes have empty subclasses; readline question returns an empty answer immediately | Actual TTY descriptor state, terminal modes, editing, history, async input, promises and REPL |
| workers | SpiderMonkey adapter starts shell workers but MessagePort delivery is a no-op and Worker.postMessage throws | Structured transfer, worker environments, isolation, handles, termination, contexts and host lifetimes |
| compression | Pinned zlib/ZIP/iterator algorithms, native codec handles and shared work pool are present as unbuilt source | Every option/mode, public inherited stream behavior, async ownership, errors, limits and activation |
| observability | Console counters/timers, perf marks/observers and delay histogram contain no-ops | Formatting/options, actual measurements, reports, tracing, delivery and shutdown |
| engine | Native VM context bridge exists; public timeout rejects; V8 heap limit is a fixed constant | VM option/realm/module behavior, inspection/debugging/profiling and API-specific engine boundaries |
| testing | `test`, `test/reporters`, `bench`, `bench/reporters` have no public registry factories | Full runner/hook/mock/reporter/CLI requirements and real instrumentation prerequisites |
| native-integration | `ffi`, `sqlite`, `sea`, `wasi` have no public registry factories | Backend, memory/ABI/artifact requirements, actual addon/embedding boundaries and activation |
| documentation | Existing plan assigns narrative, synopsis and deprecation documents | Resolve requirements outside API headings; distinguish legacy/deprecated APIs from exclusions |

This initial survey does not itself sign off a family. Detailed async, streams, network, HTTP, engine, loading, terminal, workers, compression, crypto, secure-network,
native-integration, observability and testing reports now complete their
source reviews with gaps; see state.json for current
status. All four current-candidate
runtime statuses remain pending. The source audit must not silently turn
`incomplete` into `complete` because a family has a paragraph or a defect.

## Cross-family findings from inspected source

All references below are in `packages/registry/node-compat/bootstrap.js`
unless another file is named. These are implementation gaps, not accepted
engine/platform exclusions. Their presence in the common guest runtime
applies to all four hosts by source inference. Kernel/host backend behavior
still needs tracing where indicated.

| ID | Public surface | Requirement and observed implementation | Source | Dependencies / next audit questions |
|---|---|---|---|---|
| A-001 | diagnostics_channel Channel subscriptions, publish, store binding and tracing | Subscribers must be retained and notified; `makeChannel` creates fresh objects with no-op publish/subscribe/bindStore and permanent false subscriber state. Tracing methods only call the supplied function | 5888–5925 | async context and exception policy; compare pinned channel cache, transforms and tracing overloads |
| F-001 | fs.watch, fs.watchFile, fs.unwatchFile | File changes require actual observation; watcher registration currently returns inert methods or does nothing | 2461–2483 | Kernel/VFS notification capability and descriptor/lifetime accounting; final filesystem overrides do not replace these methods |
| P-001 | os.cpus, totalmem, freemem, loadavg, userInfo, getPriority/setPriority | Public metadata/control must come from actual guest state; current CPU/memory/load/credentials are presets and priority setter is a no-op | 2553–2596 | Trace actual guest accounting/credentials/scheduler interfaces; distinguish unavailable measurement from invented values |
| P-002 | cluster | Module currently contains only isMaster/isPrimary/isWorker booleans, without the worker/server APIs | 5846–5850 | Process IPC, descriptor passing, actual worker roles and distribution |
| N-001 | dns.resolve | DNS result must reflect hostname/record type and complete asynchronously through the proper operation; code calls cb(null, ['127.0.0.1']) directly | 5809–5815 | DNS backend and Resolver ownership; lookup has a separate path and must be reviewed independently |
| H-001 | http.createServer / https.createServer | Both modules returned by makeHttpModule expose a throwing server method rather than a server implementation | 5683–5686, 5690–5710 | TCP accept, TLS server, parser, stream and request/response ownership |
| H-002 | http2 | Registry value is only `{ constants: {} }`; there are no client/server/session/stream implementations in that value | 5788–5791 | Real HTTP/2 backend, flow control, settings and TLS/ALPN |
| S-001 | tls.checkServerIdentity | Function returns undefined for every input rather than checking peer identity or reporting mismatch | 4983 | Certificate parsing and name validation; native TLS verification does not implement this independently callable API |
| S-002 | TLSSocket controls and metadata | setTimeout only adds a listener; no-delay, keepalive, ref/unref return this without control; getProtocol returns a fixed TLSv1.3 string and peer certificate returns an empty object | 4938–4945 | Actual socket/timer/ref state and negotiated TLS/certificate metadata |
| C-001 | crypto.createCipheriv/createDecipheriv, key creation/generation, sign/verify, X509Certificate | These exports throw rather than implement their public behavior | 4103–4116 | Crypto backend and real key/certificate ownership; absent binding is a gap, not proof of engine impossibility |
| C-002 | crypto.getRandomValues | Validation accepts any object with buffer and byteLength instead of establishing the required integer TypedArray brand | 4078–4087 | Byte-view brands, exact DOMException/error and size/offset semantics |
| W-001 | WebCrypto subtle, File and FormData | Fallback crypto object has no subtle; fallback File/FormData are empty classes. Audit must account for later replacements before judging other globals | 6837–6871 | Crypto algorithms, WebIDL, multipart/body state and final exposure |
| T-001 | tty.ReadStream/WriteStream and readline.createInterface | TTY classes have no device-specific implementation; readline.question writes the prompt and calls cb('') immediately, with no input operation | 5799–5803, 5817–5830 | Guest PTY, streams, terminal state and asynchronous input |
| R-001 | worker_threads.MessagePort/MessageChannel | Adapter MessagePort.postMessage/start do nothing; channel merely constructs disconnected ports | `packages/registry/spidermonkey/node-compat/adapter.js`:367–381 | Actual transport, cloning/transfers, port queue/event/ref state; separate global MessageChannel explicitly throws |
| R-002 | worker_threads.Worker lifetime and workerData | Worker.postMessage throws, normal workerData uses JSON.stringify, and terminate joins shell workers then emits exit 0; this is not complete per-worker Node behavior | same adapter:391–451 | Native worker ownership, independent termination and structured clone; inspect engine/host routes before defining boundaries |
| O-001 | perf_hooks performance and observers | now uses wall-clock Date.now, mark/measure are empty and observer observe/disconnect are empty | 5831–5837 | Monotonic timestamps, entry stores, delivery and actual resource measurements |
| O-002 | monitorEventLoopDelay | enable/disable/reset do nothing and every statistic/percentile returns 0 | 6060–6070 | Real scheduling samples, histogram state, validation and lifecycle |
| O-003 | console.Console counters, grouping, timers and trace | Counters/groups/timers are no-ops; trace prints a prefix without a captured stack | 5868–5883 | Formatting, inspection options, error handling, timer/counter state and output destinations |
| E-001 | v8.getHeapStatistics | Only heap_size_limit is returned, fixed at 256 MiB; other required fields and actual accounting are absent | 5927–5935 | Actual engine measurements and per-field V8 semantics; no accepted blanket V8 exclusion |
| E-002 | vm timeout | Public options reject any timeout instead of enforcing an execution deadline | 5941–5948 | Embedding interrupt API and event-loop ownership; current missing hook is not an established host boundary |
| L-001 | Builtin surface/exposure | Only registry keys become default public modules. Several discovered public modules have no registry entries; shared policy lists alone do not load implementations | 5771–5994, 6075–6110; `third_party/node-core/builtin-policy-adapter.js` | Compare exact upstream flags, scheme-only aliases and public module definitions; separate missing module, disabled module and incorrect exposure |
| L-002 | Non-core ws exposure | ws is inserted into the same public builtin registry, so the shared builtin policy treats it as a builtin even though it is outside the pinned Node discovery set | 6037–6058, 6100–6109 | Preserve the separate Claude/npm/Bun remainder; public Node exposure must be reviewed separately from product-specific extensions |

The absence survey for L-001 includes `domain`, `dgram`,
`readline/promises`, `repl`, `trace_events`, `inspector` and its promises
variant, testing/reporters, and the four native-integration modules. Their
requirements remain in scope, including option-enabled APIs. The current
option callback recognizes only `--experimental-stream-iter`; absent
activation for another public module is not a justified exclusion.

## Later validation candidates, not executed

The pinned source tree contains, among others:

- `test/parallel/test-diagnostics-channel-pub-sub.js`
- `test/parallel/test-diagnostics-channel-tracing-channel-sync.js`
- `test/parallel/test-diagnostics-channel-run-stores-scope-transform-error.js`
- `test/parallel/test-perf-hooks-resourcetiming.js`
- `test/parallel/test-perf-hooks-histogram-record-zero.js`
- `test/parallel/test-worker-message-port-receive-message.js`
- `test/parallel/test-worker-terminate-timers.js`
- `test/parallel/test-http2-multiplex.js`
- `test/parallel/test-http2-alpn.js`

These are source-discovered candidates, not a complete selection or a test
result. Fixture, flag, resource, native-control and host requirements must
be audited before proposing the final validation plan.

## Completed web-family source review

[Web contracts](web-contracts.md) now reconcile all 548 original web
obligations (390 documentation sections and 158 stream/web descriptors),
with the scoped crypto/async/compression/consumer reviews retained. The
requirements ledger adds explicit global/returned/inherited/source members.
WEB-002–012 and W-001 distinguish actual shared Node Web Stream algorithms
from incomplete Fetch/WebIDL/byte/port/global implementations. Target
feature activation, configured Intl/ICU4X versus fallback selection, host
routes and unresolved exact-target/native questions are explicit. This
completes 15 of 19 family source reviews with gaps; values, filesystem,
processes and documentation remain. No current runtime signoff is implied.

## Completed documentation/deprecation source review

[Documentation contracts](documentation-contracts.md) reconcile all 220
original obligations, including 207 current deprecation identifiers with
full normative prose, exact type/range/source identity and semantic owner
routes. Real warning/deprecator/CLI/origin/alias/overload paths distinguish
selected code from stored unselected full sources. DOC-007 records removed
util predicates still exported; DOC-010 corrects L-032: the process.env
getter can query native getenv beyond seeded keys, while enumeration and
native set/unset mutation are separate gaps. Sixteen family source reviews
are complete with gaps; subsequent values/filesystem/process reviews are now
complete in their linked reports. This paragraph records the earlier checkpoint.

## Completed process-family source review

[Process contracts](process-contracts.md) reconcile all 778 original
obligations (265 document sections and 513 native captures) plus returned/
inherited/symbol/source owners. Actual spawn/PATH/pipe/wait and sync
adoption/poll/deadline/maxBuffer/reap paths are distinguished from missing
complete ChildProcess/IPC/cluster/permissions/ref/finalization/process
event/OS/environment/resource owners. CP-008 records missing child stdin
destruction on exit; native aggregate maxBuffer and top-level falsy input
match exact target behavior and are not invented mismatches. Seventeen
family source reviews are complete with gaps; values and filesystem remain.

## Completed filesystem-family source review

[Filesystem contracts](filesystem-contracts.md) reconcile all 743 original
obligations, 351 exact document sections and 392 native captures plus
returned/inherited/provider/stream/Dir/Stats/handle/symbol contracts. Four
stored source files and 102 declared slices match the exact pin; actual
adapter/native/libc/kernel/host/mount ownership remains separate evidence.
FS-011–021 record explicit native byte-lease rejection, recursive error/
return gaps, callback timing/validation, C remove conflating unlink/rmdir,
legacy conversion fd leaks, namespace/metadata/backend issues and the
target VFS promise-open numeric-fd question. VFS promise/Dirent field
source-inventory corrections retain IDs without manufacturing APIs.
All 19 broad family source reviews are complete with gaps; the values review
and final obligation reconciliation retain separate implementation/runtime status.

## Completed values-family source review

[Values contracts](values-contracts.md) complete assertions, Buffer, util/types,
path, URL, errors and Intl, retaining prior query/codecs/legacy/StringDecoder
reviews. Numeric and unpooled allocation owners are real; public conversion,
codecs, overloads, descriptors, util helpers, diagnostics and URL ownership
remain incomplete. All original obligations are linked without calling
inherited methods absent or narrative sections fictitious exports.
