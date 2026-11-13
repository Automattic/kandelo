# Native binding migration ledger

Planning only. This covers all **72 literal binding names** in the static graph. Upstream registration candidates and every call site are recorded in [dependency-graph.json](dependency-graph.json). A binding may be referenced only in a lazy or gated branch; this table is not a first-slice implementation list. Native names describe Node contracts implemented over SpiderMonkey and the guest OS, not a promise to link V8/libuv or copy native Node source unchanged.

N/R/E/S are defined in [the design](README.md). Retain E (audit/native/unchanged-source/historical evidence) for every group. Native candidates are unvalidated against the new registry. Exact function members, receivers, native arrays, symbols, errors and disposal must be reconciled before activation.

| Binding names | Shared contract / missing prerequisites | Disposition |
|---|---|---|
| `builtins`, `modules` | **Loader source/compiler registry.** New shared registry over whole source files; no existing adapter registry imported. Actual module/compile cache state, identity and configuration. | N/R: SpiderMonkey source/stencil hooks; retire builtin-policy adapter as owner. |
| `module_wrap`, `contextify` | **Engine module/script/realm bridge.** Real source/synthetic records, cycles, linking, evaluation/TLA, live exports, origin and callback ownership. Exact member/descriptor/constructor contract still missing. | N: native-vm*.cpp, engine module records; R: ESM graph and public vm adapters. |
| `util`, `types`, `errors`, `symbols` | **Intrinsic types, errors, hidden state.** Native brands/inspection/stack/source/private slots and stable symbols; no spoofable property tests or partial primordial dictionary. | N: native-object-marks, native-error-source, inspection/Debugger hooks; R: value/inspection helper substitutes. |
| `config`, `options` | **Configuration and flags.** Truthful engine/native capabilities, actual option storage/CLI consumers; enabled and absent paths separately scoped. | R: per-adapter getOptionValue/config objects; S: CLI activation and dependency reconciliation. |
| `constants`, `uv` | **Guest constants and errors.** Actual guest SDK flags/errno/signal values, exact Node error map and platform semantics. Libuv name does not require fabricated libuv handles. | N: generated constant/error provenance and libc definitions; S: missing OS features. |
| `buffer`, `string_decoder`, `encoding_binding`, `url`, `url_pattern`, `icu` | **Bytes, text and URL/Intl.** Exact view/string/encoding/brand/result contracts and native memory lifetime; all modules share Buffer and URL owners. ICU4X correspondence and URLPattern remain explicit. | N: native-buffer/backing-store/string-bytes, actual URL/ICU hooks; R: public Buffer/codecs/URL assembly. |
| `async_wrap`, `async_context_frame`, `task_queue`, `timers` | **Scheduling and async identity.** Actual aliased arrays, hooks/Promise jobs, contexts, monotonic timer/ref state and completion/fatal/rejection ordering. | N: native-async/callback/work and engine hooks; R: timer/AsyncHook selected-source assembly. |
| `fs`, `fs_dir`, `fs_event_wrap` | **Filesystem.** Real sync/callback/promise/Dir/watch contracts, typed request/handle state, errno, paths and completion ownership. Eager vfsState and constants must be accurate. | N: native-fs/dir/file-jobs/work owners; S: watch/raw-path/mount/file-advice platform work. |
| `credentials`, `process_methods`, `os` | **Guest process and OS state.** Guest env/credentials/cwd/umask/accounting/clock/exit; stable process owner. Native host metadata is not guest metadata. | N: native-environment-object/native-os/process-state; S: missing guest measurements/permissions. |
| `process_wrap`, `spawn_sync`, `pipe_wrap`, `signal_wrap` | **Processes, pipes and signals.** Actual spawn/wait/stdio/signal/fd/IPC lifecycle and errors. | N: native spawn/signal/wait and libc/kernel; R: child/cluster sync public controllers. |
| `permission` | **Permissions.** Enforce/query/drop/audit actual authority and immutable option state; off-mode behavior follows upstream. | S: real guest policy enforcement; no fabricated permission success. |
| `stream_wrap`, `stream_pipe`, `js_stream`, `tty_wrap` | **Native streams and terminal.** Read/write/backpressure/half-close/TTY modes and callback ownership compatible with whole upstream stream classes. | N: fd/terminal/socket owners; R: public stream/TTY wrappers. |
| `tcp_wrap`, `udp_wrap`, `cares_wrap`, `block_list` | **Network and DNS.** Actual socket handles/accept/send/control/record-query and address-rule state; host service differences explicit. | N: native-socket/listener/datagram/dns/address rules; S: backend features and budgets. |
| `http_parser`, `http2` | **HTTP protocol bindings.** Parser state/callbacks and real HTTP2 sessions/flow control; parser-only backend does not implement HTTP2. | N: node-llhttp/native-http-parser; S: HTTP2 protocol engine. |
| `crypto`, `tls_wrap`, `dtls`, `quic` | **Crypto and secure protocols.** Native key/context/trust/entropy/handshake/session and algorithm capabilities; DTLS/QUIC need actual protocol transports. | N: node-ncrypto/OpenSSL/native TLS/crypto; S: provider and UDP/protocol integration. |
| `zlib` | **Codecs.** Native codec modes/options/state, byte leases and async work/lifecycle. | N: node-codecs/codec-handle/work; S: actual library/configuration identity. |
| `blob`, `messaging`, `worker`, `locks`, `ipc_serdes` | **Host objects, worker and transfer.** Actual Blob bytes, entangled ports, per-worker environments, structured cloning/transfer, locks and IPC serialization. | N: native backing/ports/worker/locks; S: missing transport/quiescence and native handle transfer. |
| `performance`, `trace_events`, `diagnostics_channel` | **Observability.** Real clock/entries/observers/histogram/trace subscription/producers and native instrumentation. | N: histogram/ELD/tracing/clock; R: public measurements/no-op adapters. |
| `heap_utils`, `v8`, `internal_only_v8`, `inspector`, `profiler`, `report`, `watchdog` | **Engine services.** Actual engine/Debugger/deadline/heap/report data; exact V8 formats require individual decisions and truthful failures. | N: actual SpiderMonkey metrics/Debugger/interrupt hooks; S: missing instrumentation and foreign formats. |
| `cjs_lexer` | **CJS export discovery.** Implement target lexer binding/results and shared CJS/ESM interop; source grep/Object.keys is insufficient. | S: pinned lexer/parser and native bridge; retain loading audit. |
| `serdes` | **Serialization.** Real supported serialization semantics; no acceptance of incompatible V8 binary formats. | N: structured clone primitives; S: public wire-format decision. |
| `sea`, `mksnapshot` | **Embedded assets and snapshots.** Ordinary/non-SEA state, real asset/image ownership; foreign snapshots are not portable. | N: native-sea asset profile; S: image/embedding format and snapshot capability. |
| `ffi`, `sqlite`, `wasi` | **Native integration.** Actual library/memory/statement/guest ABI/lifetime and capability contracts; no CPU-native addon fiction. | N: native-ffi/sqlite/wasi and libraries; S: loader/ABI/backend admission. |
| `wasm_web_api` | **Nested guest Wasm.** Actual engine support and compilation/execution path for dependencies such as Amaro; expose absence truthfully. | S: separate nested-Wasm capability; not required to pretend all JS loading is unavailable. |
| `webstorage` | **Persistent Web storage.** Actual per-environment storage/origin/quota/resource state, not a map passed off as durable storage. | S: persistence backend and guest option ownership. |

## First-slice binding contracts

These are required contract groups, not permission to invent a small object with only the demonstrated methods. Inspect whole eager consumers before activation.

| Binding / bootstrap service | Concrete members and behavior to reconcile |
|---|---|
| `builtins` | Whole immutable source/ID table, `compileFunction`, `setInternalLoaders`, actual config/source/cache fields used by whole realm/node bootstrap; engine-origin metadata. |
| `module_wrap` / `errors` | Synthetic module creation/export setters/evaluation for BuiltinModule ESM facade; stack prepare callback and exact error origin/exception bridge. |
| `util/types/symbols/options/constants/config` | Native brands, private/per-isolate keys, lazy-property support, encodings/flags/options/errors; actual guest rather than outer-host values. |
| `buffer/string_decoder/encoding_binding/url/icu` | Whole Buffer eager constructor/allocation/byte predicates, native limits/zero-fill state and shared transcoding/URL/Intl contracts required by fs/bootstrap; no selected public Buffer. |
| `fs` | `FSReqCallback`, eager fs constants/state (including accurate `vfsState`), `open(path,flags,mode[,req])`, `close(fd[,req])`; sync return/throw versus actual deferred callback/error. Whole-file eager requirements can add members. |
| `async_wrap/async_context_frame/task_queue` | Real hook setup/state arrays, execution/trigger/frame ownership, tick callbacks/state, microtask scheduling/run, Promise rejection observation and exception cleanup. |
| `timers` | Actual clock, schedule/ref/immediate counters and setup callbacks consumed by internal timers and bootstrap; no parallel public timers queue. |
| `process_methods/credentials/trace_events/messaging` | Truthful startup process seed, env/state/stdio, real disabled/enabled modes, trace subscription and transfer-deserializer setup required even before an app uses fs. |

## Exposure and feature gates

The whole upstream realm policy is authoritative. Its public policy table records these special cases; flags must come from one real option owner and must not be silently enabled to satisfy imports. Internal visibility is not public exposure.

| Public IDs | Upstream policy |
|---|---|
| `bench`, `bench/reporters` | `node:` only; `--experimental-bench` |
| `dtls` | `node:` only; `--experimental-dtls` |
| `ffi` | `node:` only; `--experimental-ffi` |
| `quic` | `node:` only; `--experimental-quic` |
| `sqlite` | `node:` only; `--experimental-sqlite` |
| `vfs` | `node:` only; `--experimental-vfs` |
| `sea`, `test`, `test/reporters` | `node:` only; no policy option in this table |
| `stream/iter`, `zlib/iter` | Schemeless allowed; `--experimental-stream-iter` |

Other feature/CLI gates (VM modules, inspector, Intl/crypto/Amaro/Wasm availability, permissions, cache/source maps, warnings, web globals, test options) remain in the whole upstream option/config/bootstrap consumers. The table above is not the complete option list. Retain all audit flag obligations; false capability reporting to avoid a missing dependency is not permitted.
