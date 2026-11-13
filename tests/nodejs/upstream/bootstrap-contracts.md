# Upstream Node bootstrap embedding contract

Source: the verified Node.js source archive at commit `18b32a3b1552e199a01f1a8d9fd64aa756d3b75b`; version preserved at **26.13.0**. Read-only source review. Official provenance is separately recorded in [pin-verification.json](pin-verification.json); this worker did not reverify it. Exact reviewed input hashes and machine-readable binding/entry lists are in [bootstrap-contracts.json](bootstrap-contracts.json). No runtime probe, syntax compilation, test, build, package generation, tracked edit or Git mutation was performed.

## Main conclusion

Execute the pinned bootstrap and module JavaScript unchanged. Supply its embedding contracts rather than reproducing its loader, public modules, validation, timers or process policy. The first native seam is **not** `require("events")`: startup first constructs per-context intrinsics/state, runs realm loader source, then errors, process/buffer, task/async hooks, web setup and thread/ownership switches. The normal main-thread switch eagerly reaches fs and CJS/ESM loader foundations before user code. A working primordial or assert wrapper alone is far short of an executable Node startup.

## Function wrappers

| Source kind | Exact named parameters |
|---|---|
| kPerContextScript | `exports, primordials, privateSymbols, perIsolateSymbols` |
| kBootstrapRealm | `process, getLinkedBinding, getInternalBinding, primordials` |
| kBootstrapScript / kMainScript | `process, require, internalBinding, primordials` |
| kFunction ordinary builtin | `exports, require, module, process, internalBinding, primordials` |
| kSourceTextModule | `` |

Source: `src/builtin_info.h:29–47`; native compile/call `src/node_builtins.cc:387–403,487–563`. Preserve body bytes, parameter order, realm globals, throw propagation and per-source filenames. Bootstrap/native calls use an undefined receiver; ordinary builtin calls are made by upstream realm.js. Selected `.mjs` builtin sources use actual module compilation/linking, not the ordinary function wrapper.

## Ordered startup

### 0. Fresh realm and private per-context export store (embedding/native)

Create the engine realm with its real intrinsics before any user mutation. Retain per-context exports privately, initialize once, and share its primordials and symbol identities with all later builtin calls. This store is distinct from ordinary global properties.

Sources: `src/api/environment.cc:808–831`, `src/api/environment.cc:1025–1057`.

### 1. Run per_context/primordials (upstream JS unchanged)

Call body with (exports, primordials, privateSymbols, perIsolateSymbols). primordials starts null-prototype and mutable. Source copies native descriptors, creates safe collection/iterator/promise helpers, then sets null prototype and freezes the result. Do not substitute a hand-picked primordials map.

Sources: `src/api/environment.cc:1059–1084`, `lib/internal/per_context/primordials.js:145–310`, `lib/internal/per_context/primordials.js:785–786`.

### 2. Run per_context/domexception, then messageport (upstream JS unchanged)

Reuse the same four arguments in this exact order. DOMException and QuotaExceededError live in private exports; emitMessage is the per-context callback used by native messaging. DOMException requires shared transfer-mode and messaging clone/deserialization symbols. No require/internalBinding arguments exist in these wrappers.

Sources: `src/api/environment.cc:1059–1084`, `lib/internal/per_context/domexception.js:18–24`, `lib/internal/per_context/domexception.js:208`, `lib/internal/per_context/domexception.js:296`, `lib/internal/per_context/messageport.js:19–39`, `src/node_messaging.cc:256–269`.

### 3. Create principal Realm state and initial process object (embedding/native)

Retrieve the existing primordials, retain its SafeMap/Set/WeakMap/WeakSet prototypes, create process with a distinct mutable prototype chain, exit-info backing state, truthful version/arch/platform/release, and early _rawDebug. argv/execArgv/runtime process properties are patched later. Never report V8/libuv/platform capabilities merely because upstream JS expects them.

Sources: `src/node_realm.cc:46–97`, `src/node_process_object.cc:96–157`.

### 4. Run internal/bootstrap/realm (upstream JS unchanged + native bindings)

Call (process,getLinkedBinding,getInternalBinding,primordials) with undefined receiver. Source owns internalBinding cache, process.binding/_linkedBinding, moduleLoadList, BuiltinModule map, builtin exposure policy, cycles/loading state, dependency fallback and ESM facades. It immediately loads builtins and module_wrap, registers internal loaders exactly once, then loads internal/errors and installs stack callbacks.

Sources: `src/node_builtins.cc:513–531`, `lib/internal/bootstrap/realm.js:123–187`, `lib/internal/bootstrap/realm.js:245–276`, `lib/internal/bootstrap/realm.js:425–517`, `src/node_builtins.cc:853–860`.

### 5. Run internal/bootstrap/node (upstream JS unchanged + native bindings)

Call (process,requireBuiltin,internalBinding,primordials). Source installs EventEmitter ancestry, global.process/global/Buffer, exitCode accessors, frozen process.config, transferable deserializer factory, process methods and credentials, async_hooks callbacks, error/warning hooks, task queue and timer callbacks, source-map handler and process.getBuiltinModule. Preserve ordering: tick/timer registration occurs near the end so bootstrap stays synchronous.

Sources: `src/node_realm.cc:326–331`, `lib/internal/bootstrap/node.js:68–149`, `lib/internal/bootstrap/node.js:151–242`, `lib/internal/bootstrap/node.js:311–420`, `lib/internal/bootstrap/node.js:423–471`.

### 6. Run web/exposed-wildcard, then exposed-window-or-worker (upstream JS unchanged + native bindings)

Run both only if actual noBrowserGlobals is false. Console, URL, URLSearchParams, DOMException and Event/EventTarget are eager; encoding, streams, Blob/File, messaging, performance, crypto and Undici objects are mostly lazy. Register wasm streaming callback eagerly. These are Node public implementations/dependencies, not the embedding browser globals.

Sources: `src/node_realm.cc:333–339`, `lib/internal/bootstrap/web/exposed-wildcard.js:18–110`, `lib/internal/bootstrap/web/exposed-window-or-worker.js:30–131`.

### 7. Run exactly one thread switch (upstream JS unchanged)

Main uses is_main_thread; worker uses is_not_main_thread. Main installs lazy fd-type-sensitive stdio and signal listeners, and EAGERLY requires fs, CJS loader, ESM utils, perf utils, run_main and pre_execution. More modules preload only while building a snapshot. Worker installs message-based stdio and removes main signal listeners. Browser host is not synonymous with guest worker thread.

Sources: `src/node_realm.cc:342–348`, `lib/internal/bootstrap/switches/is_main_thread.js:24–43`, `lib/internal/bootstrap/switches/is_main_thread.js:50–111`, `lib/internal/bootstrap/switches/is_main_thread.js:293–332`, `lib/internal/bootstrap/switches/is_not_main_thread.js:25–64`.

### 8. Run exactly one process-state ownership switch (upstream JS unchanged + native process state)

Choose does_own_process_state or does_not_own_process_state from the guest execution role. Owning process uses native cwd/chdir/umask/abort and validated credential setters; worker restrictions are upstream JS behavior. Ownership must describe guest process authority, not host OS authority.

Sources: `src/node_realm.cc:350–356`, `lib/internal/bootstrap/switches/does_own_process_state.js:3–37`, `lib/internal/bootstrap/switches/does_not_own_process_state.js:3–38`.

### 9. Attach env proxy and mark Realm bootstrapped (embedding/native)

Install process.env backed by actual guest environment after switches. Mark bootstrap once; no live request or handle may have been created during synchronous bootstrap. Runtime options cannot be queried before this phase: upstream internal/options defers getCLIOptionsValues for this reason.

Sources: `src/node_realm.cc:358–367`, `src/node_realm.cc:190–224`, `lib/internal/options.js:29–35`.

### 10. Choose and run exactly one internal/main entry (embedding/native dispatch + upstream JS unchanged)

Use the same four arguments as bootstrap scripts. Native dispatch distinguishes embedder callback, worker, inspector/help/prof/check/bench/test/watch, positional/VFS file, REPL and stdin; eval takes priority over check in native order. For ordinary node CLI, run upstream run_main_module/eval_string/eval_stdin rather than embedding.js. embedding.js is for the special embedder API and intentionally uses a builtin-only require.

Sources: `src/node.cc:289–413`, `src/node_builtins.cc:533–539`, `lib/internal/main/embedding.js:3–10`, `lib/internal/main/embedding.js:107–109`.

### 11. Run pre_execution initialization through selected main (upstream JS unchanged + native state callbacks)

prepareExecution refreshes options; patches runtime process/argv; initializes trace/inspector/warnings, real gated web facilities, diagnostics/permission/source maps/deprecations; conditionally DNS, signals/report/IPC/cluster; deserialize callbacks; ESM formats/VM; CJS+ESM initialization, embedder and --require preloads, optional frozen intrinsics; VFS mounts and HTTP proxy. Worker delays user loader initialization until LOAD_SCRIPT. Preserve exact conditionals and ordering in source.

Sources: `lib/internal/process/pre_execution.js:47–76`, `lib/internal/process/pre_execution.js:107–189`, `lib/internal/process/pre_execution.js:292–322`, `lib/internal/process/pre_execution.js:336–394`, `lib/internal/main/worker_thread.js:92–162`.

### 12. Main-specific bootstrap completion, then user execution (upstream JS unchanged + event-loop embedding)

run_main_module prepares argv, markBootstrapComplete, resets RegExp statics, calls upstream Module.runMain. eval_string prepares globals and dispatches input format; eval_stdin reads real stdin and dispatches. embedding.js RETURNS [process,embedderRequire,embedderRunEntryPoint]; native C++ consumes this array and invokes embedder callback. This return is function-body syntax, not a source-file script.

Sources: `lib/internal/main/run_main_module.js:14–33`, `lib/internal/main/eval_string.js:26–77`, `lib/internal/main/eval_stdin.js:21–56`, `lib/internal/main/embedding.js:185`, `src/node.cc:263–325`, `lib/internal/process/pre_execution.js:827–830`.

## Required native contracts, with upstream JS retained

- **builtins** — builtinIds; compileFunction(id); setInternalLoaders; config JSON; hasCachedBuiltins; categories/natives/cache usage/importBuiltinSourceTextModule when consumers require them. Frozen binding; compile body in its own proper parameter scope and propagate compile errors. (`src/node_builtins.cc:870–917`).
- **module_wrap** — A constructor with a prototype exists already at realm bootstrap. Builtin ESM facades later need synthetic export-name constructor, setExport, instantiate, evaluate and namespace semantics; later ESM files need actual source modules/linking, not object-shaped substitutes. (`lib/internal/bootstrap/realm.js:186–187`).
- **errors/stack** — setPrepareStackTraceCallback; setEnhanceStackForFatalException; real capture/CallSite stack protocol used by internal/errors; uncaught/rejection dispatch. Later source-map callback. (`lib/internal/bootstrap/realm.js:485–510`).
- **util/process** — Exit-info indexed backing store and consistent private symbols/constants must exist before node.js reads them. Process mutable prototype is distinct from Object.prototype; process.config contains truthful build features. Native process runtime patch must read guest argv/pid/ppid/execPath/env, not embedding machine identity. (`lib/internal/bootstrap/node.js:74–147`).
- **buffer** — Upstream buffer implementation and its full native dependency surface are eager, including setBufferPrototype(Buffer.prototype), after which upstream deletes this installer. Cannot defer buffer backend until first user require. (`lib/internal/bootstrap/node.js:464–472`).
- **messaging/symbols** — Shared identities for per-context DOMException and binding consumers; real JS-transferable deserializer registration and native structured clone. Public JS source owns constructor lookup and symbol methods. (`lib/internal/worker/js_transferable.js:12–49`).
- **async_wrap/task_queue/timers** — Native hooks; actual tickInfo shared state, runMicrotasks/enqueueMicrotask, setTickCallback, setPromiseRejectCallback/events; timer/immediate callback scheduling, referenced liveness, callback/async-context and rejection ordering. JS task queue algorithm stays upstream. (`lib/internal/process/task_queues.js:9–24`).
- **process_methods/credentials/trace_events** — All names used by bootstrap and per-thread wrappers need owning semantics; config gates truthful unavailable capabilities. setEmitWarningSync and trace-state callback registration are eager. Cwd/credentials refer to guest. (`lib/internal/bootstrap/node.js:151–242`).
- **snapshot state** — No V8 startup snapshot is necessary to follow the non-snapshot bootstrap path, but mksnapshot.isBuildingSnapshotBuffer and startup_snapshot callback contracts are still read eagerly. An honest false normal-execution state is required; do not falsely claim snapshot support. (`lib/internal/v8/startup_snapshot.js:14–23`).
- **fs/CJS/ESM/options/performance** — Main switch eagerly requires fs, both loader foundations, perf and pre_execution. Complete startup dependency closure is wider than primordials/events/assert; a bootstrap smoke result cannot establish public module compatibility. (`lib/internal/bootstrap/switches/is_main_thread.js:293–332`).
- **wasm_web_api/worker** — Main switch eagerly loads both and web bootstrap installs wasm streaming implementation. A guest engine lacking nested Wasm cannot honestly replace the callback with successful no-op; capability/boundary design remains explicit. (`lib/internal/bootstrap/switches/is_main_thread.js:323–326`).

This list summarizes startup contracts; the JSON records every direct literal `internalBinding(...)` call in the requested startup directories with its original source line. It is not the full transitive binding-member inventory. Eager module imports recursively introduce additional backend APIs.

## Concrete syntax/intrinsic constraints and unresolved questions

- **actual wrapper parsing constraint** — embedding.js:185 and mksnapshot.js:212 contain top-level return. They are legal function bodies under upstream wrapper, invalid if naively evaluated as Scripts. Ordinary builtins also need isolated function lexical scope. Do not concatenate raw bodies or strip imports to force execution. Sources: `src/builtin_info.h:29`, `src/node_builtins.cc:387`, `lib/internal/main/embedding.js:185`, `lib/internal/main/mksnapshot.js:212`.
- **actual intrinsic prerequisites; SpiderMonkey availability unverified** — primordials unconditionally dereferences Float16Array and Iterator constructor/prototype; immediately calls Iterator.prototype.drop and Iterator.from to obtain helper prototypes. Atomics, WeakRef, FinalizationRegistry, BigInt typed arrays and standard builtins are also unconditional. A missing constructor/method fails during primordial construction; no optional-source fallback exists. Source scan alone does not prove which are absent in the rebuilt guest engine. Sources: `lib/internal/per_context/primordials.js:173`, `lib/internal/per_context/primordials.js:284`.
- **actual nonstandard engine contract** — Error.captureStackTrace is copied by primordials when present and internal/errors destructures ErrorCaptureStackTrace; real Error.prepareStackTrace/stack limits/CallSite callback behavior is supplied by the embedding engine in Node. Merely attaching Error.prepareStackTrace does not make SpiderMonkey call it or supply CallSites. No runtime availability check was performed here. Sources: `lib/internal/errors.js:20`, `lib/internal/errors.js:123`, `lib/internal/errors.js:546`, `lib/internal/bootstrap/realm.js:485`.
- **source syntax findings, bounded negative** — No %Name(...) V8 intrinsic invocation found in the requested per_context/bootstrap/main JS directories by textual scan. These files contain standard classes/private fields, async/generator functions and optional chaining/nullish syntax. This is NOT a parse test nor a scan of all transitive lib/deps files, and does not prove SpiderMonkey syntax compatibility. Sources: `lib/internal/per_context/primordials.js:268`, `lib/internal/per_context/primordials.js:641`.
- **actual identity tension requiring design** — Upstream node.js unconditionally creates process.features.uv=true and ipv6=true, while capability flags gate other features. Keep source unchanged but do not use that assignment as proof of real libuv identity or IPv6 support. Truthful Kandelo identity/feature behavior must be explicitly resolved in the backend/policy design before claiming unchanged-source compatibility. Sources: `lib/internal/bootstrap/node.js:269`.

## Main-entry variants

| Main source | Initialization/completion anchors |
|---|---|
| `lib/internal/main/bench_runner.js` | 17: `prepareTestRunnerMainExecution();`; 18: `markBootstrapComplete();` |
| `lib/internal/main/check_syntax.js` | 25: `prepareMainThreadExecution(true);`; 38: `markBootstrapComplete();`; 42: `markBootstrapComplete();` |
| `lib/internal/main/embedding.js` | 35: `prepareMainThreadExecution(false, true);`; 185: `return [process, embedderRequire, embedderRunEntryPoint];` |
| `lib/internal/main/eval_stdin.js` | 21: `prepareMainThreadExecution();`; 22: `markBootstrapComplete();` |
| `lib/internal/main/eval_string.js` | 26: `prepareMainThreadExecution();`; 28: `markBootstrapComplete();` |
| `lib/internal/main/inspect.js` | 10: `prepareMainThreadExecution();`; 13: `markBootstrapComplete();` |
| `lib/internal/main/mksnapshot.js` | 134: `prepareMainThreadExecution(false, false);`; 212: `return main();` |
| `lib/internal/main/print_help.js` | 249: `prepareMainThreadExecution();`; 251: `markBootstrapComplete();` |
| `lib/internal/main/prof_process.js` | 23: `prepareMainThreadExecution();`; 24: `markBootstrapComplete();` |
| `lib/internal/main/repl.js` | 21: `prepareMainThreadExecution();`; 23: `markBootstrapComplete();` |
| `lib/internal/main/run_main_module.js` | 15: `const mainEntry = prepareMainThreadExecution(!isEntryURL);`; 17: `markBootstrapComplete();` |
| `lib/internal/main/test_runner.js` | 23: `prepareTestRunnerMainExecution(!isTestIsolationDisabled);`; 24: `markBootstrapComplete();` |
| `lib/internal/main/watch_mode.js` | 35: `prepareMainThreadExecution(false, false);`; 36: `markBootstrapComplete();` |
| `lib/internal/main/worker_thread.js` | 63: `prepareWorkerThreadExecution();`; 337: `markBootstrapComplete();` |

Native routing is `src/node.cc:289–413`. Keep embedding callback return arrays distinct from ordinary CLI execution. Special snapshot/profiler/inspector/help/test/bench/watch routes are not implied to work merely because their source files are available. Worker LOAD_SCRIPT transport and delayed module setup need real messaging/lifecycle contracts.

## Suggested first integration boundary

1. Admit complete pinned source records and compile unchanged function bodies with exact wrapper signatures, filenames and identity hashes. Keep the registry/loader policy in upstream realm.js.
2. Supply the actual engine intrinsic/private-state/stack contracts required before primordials and realm setup; retain stable per-context and per-isolate identity.
3. Implement the eager startup binding closure in dependency order, tracing each member to its real owner. Carry forward useful campaign native implementations only after adapting their contracts.
4. Execute unchanged bootstrap/main scripts in the recorded order and preserve real guest process/thread ownership, fd types, environment and event-loop lifecycle.
5. Later validate exact-artifact startup and complete modules on all four hosts; this report has no new runtime evidence.

Do not replace missing bindings with public JS lookalikes or mark placeholder objects as backend support. A deliberate non-snapshot execution mode is allowed by upstream source; a no-op snapshot/timer/clone/module implementation is not evidence of that mode.

## Evidence limits

- No runtime tests, probes, syntax compilation, package generation, builds or tracked/Git mutations.
- Exact execution order is conditional as recorded; lazy getters and snapshot/worker paths change dependency loading.
- Direct literal binding inventory is complete for reviewed startup directories only; transitive binding member/API closure is not audited exhaustively here.
- Reusing all JS requires importing pinned lib plus pinned deps sources and implementing their real internalBinding/engine contracts; this report is startup order, not complete core API coverage.
- All four outer hosts run a guest SpiderMonkey backend; they are not four different Node builtin implementations. No host conformance is claimed.
