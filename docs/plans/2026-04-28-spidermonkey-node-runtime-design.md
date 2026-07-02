# SpiderMonkey-Based Node.js Runtime — Design

**Status:** Phase 0 engine port scaffold in tree
**Date:** 2026-04-28
**Supersedes:** the QuickJS-NG `node.wasm` shim (PR #226), once shipped.

## Handoff snapshot (2026-05-20 update)

This branch now has the first SpiderMonkey package:

- `packages/registry/spidermonkey/package.toml` pins Firefox ESR `140.11.0esr` source and declares the standalone JS shell output as `js.wasm`.
- `packages/registry/spidermonkey/build-spidermonkey.sh` downloads/verifies the ESR tarball, resolves `libcxx@21`, configures a wasm32 POSIX SpiderMonkey shell build with JIT disabled, then runs `wasm-opt` and `wasm-fork-instrument`.
- `packages/registry/spidermonkey/test/spidermonkey.test.ts` covers `js -e` and modern JavaScript builtins under the kernel harness.

The Node compatibility layer, vendored Node builtin modules, and SpiderMonkey JSAPI embedding are still not implemented. Next work should start that embedding on top of the working standalone engine package.

The previous Pre-Phase-1 C++ EH gates are no longer blockers: `docs/posix-status.md` now records fork from C++ catch handlers and the SpiderMonkey spike's post-catch fork case as Full, with coverage in `host/test/fork-instrument-coverage.test.ts`.

## Goals

Build a real Node.js-compatible runtime for `kandelo`:

1. **Initial demo (Phase 2 gate):** `npm install express && node app.js` running an Express HTTP server, serving requests through the kernel's TCP backend in both Node and browser hosts.
2. **Long-term north star (Phase 3 gate):** Run [Claude Code](https://claude.com/claude-code) end-to-end inside the kernel — authenticate, make an HTTPS API call to Anthropic, render Ink-based terminal UI through the kernel's PTY.

## Why SpiderMonkey

The current `node.wasm` is built on QuickJS-NG and explicitly described in project memory as "NOT Node.js." It hits a spec-compliance ceiling that blocks real npm package compatibility.

| | QuickJS-NG (current) | SpiderMonkey | V8 |
|---|---|---|---|
| Binary size | ~2 MB | ~25-40 MB | 30+ MB, doesn't work |
| JIT required? | No | No (interpreter mode) | Yes — even "jitless" needs ISA-specific builtins |
| Spec compliance | ES2023, gaps | Full ES2024+, top-level await, modern RegExp, Temporal | Best, but unreachable here |
| Threading in wasm | Single-threaded | Has SAB/Atomics support | N/A |
| Existence proof on wasm | Yes | Yes (WinterJS, Spin's JS SDK, ComponentizeJS) | No |

V8 was investigated and ruled out (memory: torque-cc-backend effort closed 2026-04-27). SpiderMonkey is the most modern engine that's actually buildable to wasm without JIT.

## Approach: build it as a POSIX cross-compile target

SpiderMonkey is designed to build on POSIX systems. Our `wasm32posix-cc` toolchain + musl provides exactly that surface — threads, signals, fork, full POSIX I/O. **Try the vanilla upstream build first.** The patches in `bytecodealliance/spidermonkey-wasi-embedding` exist mostly to fake POSIX features we already have (no threads, no fork, limited signals); many will be unnecessary or counterproductive.

Treat the BCA tree and WinterJS patches as a **debugging reference** when something specific breaks. Do not adopt them wholesale.

## Architecture: three-layer runtime

```
┌──────────────────────────────────────────────────────┐
│  Node builtin modules (mostly JS, frozen bytecode)   │
│  fs, net, http, stream, child_process, ...           │
├──────────────────────────────────────────────────────┤
│  Node compat embedding (C++ + JS bindings)           │
│   - Module loader (CommonJS + ESM)                   │
│   - "Mini-libuv": ops wrapping kernel syscalls       │
│   - Globals: process, Buffer, fetch, URL, ...        │
├──────────────────────────────────────────────────────┤
│  SpiderMonkey engine (C++ → wasm32)                  │
│  Cross-compiled with wasm32posix-cc, our musl,       │
│  pthreads enabled, JIT off (interpreter only)        │
└──────────────────────────────────────────────────────┘
                          │
                  channel-syscall ABI
                          │
                  kandelo
```

**Key choices:**

- **No libuv.** Node's libuv abstracts POSIX/Windows I/O. We have a POSIX kernel underneath. Write a small ops layer (~1000s of LoC) that calls kernel syscalls directly and exposes them as JS-callable bindings.
- **JS-heavy compat layer.** Where Node's own `lib/` is pure JS, vendor or adapt directly. Faster to iterate than rewriting in C++.
- **wasm32, single binary.** Matches the dominant kernel build. SpiderMonkey's NaN-boxed Values are 8 bytes either way. Revisit wasm64 only if 4 GB ceiling becomes a problem.
- **Replaces, not parallel to, current QuickJS-based `node.wasm`.** Old binary kept on a branch for reference, removed from main once the new runtime hits Phase 2.

## Engine porting strategy

**Build location:** `packages/registry/spidermonkey/build-spidermonkey.sh`, following the current package-registry convention. The first package produces the standalone SpiderMonkey shell (`js.wasm`) only. A later package or expanded build step should produce the Node embedding once the engine shell is green. Builds register through `cargo xtask build-deps` for caching.

**Vanilla build first**: pin upstream Mozilla Firefox ESR source (currently `140.11.0esr`, recorded in `packages/registry/spidermonkey/VERSION`). Cross-compile the JS shell with our toolchain:

```
CC=wasm32posix-cc CXX=wasm32posix-c++ \
  AR=wasm32posix-ar RANLIB=wasm32posix-ranlib \
  MOZCONFIG=packages/registry/spidermonkey/mozconfig-wasm32 \
  ./mach --no-interactive build
```

The Mozilla configure target is `wasm32-unknown-linux-musl` because
`config.sub` rejects `wasm32-unknown-unknown` as an unknown OS. The compiler
driver remains `wasm32posix-cc` / `wasm32posix-c++`, so generated code still
uses Kandelo's wasm32 POSIX sysroot rather than a host Linux or WASI sysroot.

Patch only on demand. Document each patch in `packages/registry/spidermonkey/patches/README.md` with rationale.

**Threading enabled** — we have pthreads and SpiderMonkey worker contexts work with them. JIT disabled (no JIT possible in wasm); interpreter path is portable.

**Validation checkpoint:** before any Node compat code, get the SpiderMonkey JS shell (`js`) running standalone in the kernel. `js -e 'print(1+1)'` printing `2` proves the engine port. Estimated 2-4 weeks.

## Node compat layer

**Embedding entry point** (e.g. `crates/node-runtime/main.cc`):
- `JS_Init`, create runtime + context + global.
- Run bootstrap (frozen bytecode) to install builtins on the global.
- Parse argv, load user script (CJS or ESM).
- Drive event loop until idle, exit with appropriate code.

**Event loop**: Built around the kernel's existing `poll`/`epoll`/`ppoll` syscalls. The loop wakes on:

- FD readiness (sockets, pipes, async file I/O)
- Timer expirations (sorted heap, polled with timeout)
- Signal arrival (signalfd or `sigwait` in helper thread)
- Microtask drain after each tick

~300 LoC of C++ plus a JS-side queue. No libuv, no separate I/O thread pool.

**Ops layer** (Deno-style, not Node's internal-binding split): each op is a small C++ function exposed to JS that wraps a kernel syscall:

```cpp
// ops_fs.cc — example
JSValue op_fs_open(JSContext* cx, HandleString path,
                   int32_t flags, int32_t mode) {
  int fd = open(JS_EncodeString(cx, path), flags, mode);
  if (fd < 0) return throw_errno(cx, errno);
  return JS::Int32Value(fd);
}
```

~100-200 ops total. Registered into a non-enumerable symbol on the global (e.g. `Symbol.for('node:ops')`); **never exposed to user code.**

**Builtin module strategy:** vendor Node's `lib/` JS sources as the starting point. Node's MIT license permits this. Many builtins (`stream`, `url`, `querystring`, `events`, `path`, `util`) are pure JS that just need `process.binding('foo')` calls rewired to our ops. This is exactly how Deno's `@deno/std/node` and Bun's Node compat were built.

Vendored sources live under `runtime/node/lib/` with a `VENDOR.md` recording:
- Upstream Node.js version pulled
- Git revision/SHA
- Date of import
- List of files modified vs upstream

Refresh by re-snapshotting and replaying our patches; not git-subtree (too brittle for the volume of changes expected).

**Module loader:** Both CJS and ESM with Node's resolution algorithm — `node_modules` walk, conditional exports, package.json `imports`/`exports`, `node:` scheme. SpiderMonkey provides module loader hooks; we wire them. Dynamic `import()` and top-level await work natively.

**Bootstrap freezing:** All builtin JS files compiled to SpiderMonkey XDR bytecode at build time, embedded in the binary. Avoids per-startup parse cost. Same trick as the current QuickJS-based `node.wasm`.

**Globals:** `process`, `Buffer`, `console`, timers, `URL`/`URLSearchParams`, `TextEncoder`/`TextDecoder`, `fetch`/`Headers`/`Request`/`Response`/`Blob`/`FormData`, `crypto` (Web Crypto subset), `performance`, `AbortController`, `EventTarget`, `structuredClone`. SpiderMonkey ships some of these; we add the rest.

## Module roadmap & phases

Three phases, each gated on a working demo. Don't move forward until the previous gate is green.

### Phase 1 — Bare runtime (~3 months)

| Module | Notes |
|---|---|
| `process` | argv, env, stdin/stdout/stderr, exit, cwd, chdir, pid, ppid, hrtime, versions, platform=`linux`, arch=`wasm32`, nextTick |
| `console` | All log/warn/error/dir/table — vendor |
| `util` | inspect, format, promisify, types — vendor |
| `events` | EventEmitter — vendor |
| `buffer` | Buffer + Blob — vendor (perf-critical, may need fast-path ops) |
| `path`, `querystring`, `url`, `string_decoder`, `assert` | Pure JS, vendor |
| `os` | hostname, cpus, totalmem — stub plausible values |
| `timers` + `timers/promises` | Backed by event loop's timer heap |
| `fs` (sync) | readFileSync, statSync, readdirSync, mkdirSync, etc. — direct ops over kernel syscalls |
| `stream` | Vendor — large, complex, but pure JS. Required by everything else |
| `module` | CJS `require` + ESM loader |

**Validation gate:** `node tsc.js -p .` runs over a small TypeScript project and produces correct output. (TypeScript compiler is pure JS, exercises Phase 1 thoroughly without needing networking.)

### Phase 2 — Express demo (~+2-3 months) — the headline

| Module | Notes |
|---|---|
| `fs` (async) | readFile, writeFile, createReadStream, watch — backed by event loop poll |
| `fs/promises` | Thin wrappers |
| `net` | TCP server + client. Maps directly to kernel socket syscalls |
| `dns` | getaddrinfo via host delegation |
| `http` | Vendor Node's, ~5000 LoC of JS over `net` |
| `zlib` | Port miniz/zlib-ng to wasm; small enough |
| `crypto` (subset) | randomBytes, createHash (sha1/256/512), createHmac. Backed by `examples/libs/openssl/` (already in tree). Web Crypto wraps these |
| `worker_threads` (basic) | Just `Worker` + `parentPort` + `MessageChannel`. Backed by kernel `clone()`. Defer transferable lists |

**Validation gate:** `npm install express && node app.js` running an Express server. Browser fires HTTP requests through the existing TCP backend, real Hello World responses come back. End-to-end demo for the headline.

### Phase 3 — Claude Code path (~+4-6 months)

| Module | Notes |
|---|---|
| `child_process` | spawn/exec/fork. Real fork+exec via the kernel — most wasm-JS runtimes can't do this |
| `tls` / `https` | Backed by **existing OpenSSL port** (`examples/libs/openssl/`) — same MITM-fetch backend pattern documented in `docs/plans/2026-03-14-openssl-https-design.md`. Real cert objects, ALPN, SNI |
| `crypto` (full) | All ciphers, KDFs, sign/verify. OpenSSL-backed |
| `readline` + `readline/promises` | Line editing, completion. Uses kernel PTY support |
| `worker_threads` (full) | postMessage transferables, SharedArrayBuffer, MessagePort, `workerData` |
| `cluster` | Built on child_process + IPC sockets |
| `vm` | SpiderMonkey compartments — relatively easy |
| `perf_hooks` | performance global + custom timers |
| `async_hooks` | Hard. SpiderMonkey async-context tracking. Probably partial impl initially |
| `dgram` | UDP — pending kernel UDP support; defer if not present |
| `repl` | Built on readline + vm |
| globals: `fetch` (full HTTPS), `WebSocket`, `EventSource` | Built on http+tls |
| `inspector` | Stub initially. Real impl is deferred — see "Future work" |
| `http2`, `wasi`, `v8`, `trace_events`, `domain` | Stub or omit; document clearly. Niche or platform-specific |

**Validation gate:** `claude` CLI runs in the kernel, authenticates, makes an API call to Anthropic, renders an Ink response. Success criterion for the whole effort.

### Explicitly out of scope

- **N-API native addons.** Would require porting Node's V8-shaped C ABI on top of SpiderMonkey. Multi-quarter effort. Pure-JS alternatives exist for everything important. Document as not supported; emit clear errors on `dlopen()` of `.node` files.

## Testing & validation

Extends the existing 5-suite test rule (CLAUDE.md) to 7 suites:

1-5: existing (cargo, vitest, libc-test, POSIX, ABI snapshot) — unchanged.

**6. Node test subset** (`scripts/run-node-tests.sh`) — runs cherry-picked tests from Node's own `test/parallel/test-*.js` against the new runtime, both Node host and browser host. Tracked in `docs/node-test-status.md` (PASS/FAIL/XFAIL/SKIP per test, same model as `libc-test-failures.md`). A test moving PASS→FAIL is a regression, blocks merge.

**7. Node demos** (`scripts/run-node-demos.sh`) — runs the phase-appropriate demo end-to-end (Phase 1: tsc; Phase 2: Express; Phase 3: claude smoke).

Plus a new benchmark suite (`benchmarks/run.ts --suite=node-runtime`): cold start, hello-world latency, simple HTTP throughput, fs read throughput, JSON parse/stringify. Run on both hosts before any merge that touches the runtime.

**Negative tests matter** — confirm `require('v8')` throws a clear "not supported" error, that `.node` loads fail with a documented message, etc. Compatibility is also "fails predictably."

## Risks & known unknowns

### Showstopper-class — must be resolved before committing to the path

**1. wasm-fork-instrument vs C++ exceptions.** SpiderMonkey throws C++ exceptions through deep call stacks constantly. The fork instrumenter rewrites call graphs and inserts asyncify-style state machines. Two unknowns had to close before the port could start: (a) preserving `try_table`/throw/rethrow blocks across instrumentation, and (b) fork from inside or after C++ catch paths.

**Status (2026-04-28):** Spike + re-spike complete. Findings:

- libunwind missing from sysroot was the immediate blocker (closed by PR #368, branch `libcxx-pkg-libunwind` against `package-management`).
- After bundling libunwind, the re-spike (`spike-cpp-eh/RERUN-RESULTS.md` on the phase-7-switch-dispatch worktree) revealed that fork × C++ EH interaction has TWO remaining gaps that block SpiderMonkey:
  1. **fork-from-catch (test d, B1 follow-up territory).** Hangs in fork-instrument's REWIND replay because the unwinder's stash state isn't reconstructed. Tracked in `memory/fork-instrument-b1-followup.md`. **Required if SpiderMonkey ever forks from inside a catch handler** — and modern JS engines often unwind through internal try blocks, so this is highly likely.
  2. **fork-after-catch (test b).** A NEW finding from the re-spike — even when the catch frame is fully popped before the fork, the fork hangs. Should be indistinguishable from a fork with no try/catch around it. **Cause unknown; needs root-cause investigation before SpiderMonkey can be trusted.**
- The modern wasm-EH path (`try_table`/`catch_ref`/`throw_ref` lowering) cannot be tested today because the SDK forces `-mllvm -wasm-use-legacy-eh=true` and that flag silently overrides user-supplied modern lowering. Switching the SDK + rebuilding libcxx without the legacy flag is a separate unblocker.

**Net status of Risk #1: CLOSED for starting the engine port, still validate with SpiderMonkey itself.** The tree now records this support as Full in `docs/posix-status.md`, and `host/test/fork-instrument-coverage.test.ts` covers C-02/C-03/C-04/C-05/C-06/C-07/C-10/C-11/S-08. The first SpiderMonkey shell build must still serve as the real-world validation event.

- **Gate 1.A:** libcxx + bundled libunwind is in tree as `packages/registry/libcxx` and consumers link `-lc++ -lc++abi`.
- **Gate 1.B:** fork-from-catch is covered by the modern wasm-EH B1 machinery.
- **Gate 1.C:** post-catch fork is covered by C-11, the SpiderMonkey spike test (b) regression fixture.

Gate 1.D is also effectively closed for this path: the SDK and libcxx now explicitly use modern wasm-EH lowering with `-mllvm -wasm-use-legacy-eh=false`.

**2. SpiderMonkey GC + fork.** GC has thread-local nurseries, write barriers, concurrent sweeping. A fork mid-GC splits the heap into two inconsistent halves.

**Mitigation**: force a full major GC + park all helper threads + wait for sweeping idle before any `fork()`. Erlang BEAM does the equivalent. Manageable but must be designed in from the start.

### High-risk

**3. Binary size.** Realistic estimate 25-40 MB uncompressed. Browser cold-load over network is the bottleneck.

**Mitigations**: brotli compression knocks it to ~8-12 MB; cache via Cache API or IndexedDB; lazy-load builtin module bytecode.

**4. Memory pressure.** SpiderMonkey + Claude Code's working set could push 1-2 GB. wasm32's 4 GB cap is real. Monitor; revisit wasm64 retarget if hit. Don't optimize prematurely.

**5. Stream backpressure & async iteration semantics.** Vendoring Node's `lib/internal/streams/*` is the right call but those are some of the most subtle modules in Node. Bugs surface only under load; `npm install` itself stresses streams hard.

### Medium-risk

**6. ESM resolution edge cases.** `package.json` `exports` conditional resolution, `imports`, `node:` scheme, dual-package hazards. Vendoring Node's resolver is the right move.

**7. SpiderMonkey build fragility.** Mozilla doesn't officially support cross-compilation to wasm. Build will break on SpiderMonkey upgrades. Pin a specific ESR; upgrade deliberately.

**8. Process model edge cases.** Each Node builtin's process integration needs verifying — `process.exit(0)` semantics, signal propagation, cluster fd-passing.

## Decisions

1. **SpiderMonkey version:** latest ESR at start of work. Pin in `packages/registry/spidermonkey/VERSION`.
2. **Vendoring strategy for Node `lib/`:** snapshot copy. `runtime/node/lib/VENDOR.md` records upstream Node.js version, git revision, import date, and list of locally-modified files. Refresh by re-snapshotting and replaying patches.
3. **JS-side debugger:** deferred. Tracked in "Future work" below.
4. **Browser host stdin/PTY for Claude Code:** xterm.js → kernel PTY → Node process. Same path as the existing shell demo.
5. **Layout:** follows the current package-registry convention. `packages/registry/spidermonkey/build-spidermonkey.sh` builds the engine shell first. The later Node runtime should either expand this package or add a sibling package that emits `node.wasm` from a SpiderMonkey JSAPI embedding plus vendored Node `lib/` sources under `runtime/node/lib/`.

## Future work (out of scope for initial implementation)

- **CDP / `inspector` debugger.** SpiderMonkey supports the CDP protocol natively; wiring it through to Chrome DevTools is plausible but multi-week.
- **N-API addons.** Tracked as permanently out-of-scope unless a strong driver appears.
- **`http2`, `wasi`, `dgram`, `cluster` polish.** Implemented as stubs initially; expand if real workloads need them.
- **wasm64 retarget.** Only if 4 GB ceiling is observed in practice.
- **Performance work.** First make it correct, then make it fast.

## Estimated timeline

Honest estimate, focused engineering:

- Phase 1: ~3 months
- Phase 2: +2-3 months
- Phase 3: +4-6 months
- **Total: ~9-12 months** to Claude Code running.

The fork-instrument + C++ exceptions spike is the gating first step. If that's broken in a fundamental way, this entire architecture needs rethinking; if it works, the rest is execution.

## What this design is NOT

- Not a Node.js fork. Vendors Node's JS sources where pragmatic; does not promise drop-in Node behavior for everything.
- Not a permanent V8/N-API substitute. Native addons remain unsupported.
- Not single-quarter work.

## Pre-Phase-1 unblockers

Phase 1 Node-runtime implementation should wait until the Phase 0 engine shell is green. The historical C++ EH blockers below are retained for context, but they are no longer open blockers in this tree.

**Checklist (all must be green before starting Phase 1):**

- [x] **Gate 1.A — libcxx + libunwind landed.** `packages/registry/libcxx` provides libc++/libc++abi with libunwind bundled into `libc++abi.a`.
- [x] **Gate 1.B — fork-from-catch (B1) shipped.** Covered by fork-instrument C-series tests.
- [x] **Gate 1.C — fork-after-catch (test b) root-caused and fixed.** Covered by C-11 in `host/test/fork-instrument-coverage.test.ts`.
- [x] **Gate 1.E — SpiderMonkey shell validates the real codebase.** `packages/registry/spidermonkey/bin/js.wasm` builds, is instrumented, and passes `packages/registry/spidermonkey/test/spidermonkey.test.ts` under the kernel harness.

**Optional gate (deferred unless required):**

- [x] **Gate 1.D — modern wasm-EH lowering enabled.** SDK and libcxx use `-mllvm -wasm-use-legacy-eh=false`.

**Gate 1.E is green, so the next PR can start the Node compatibility embedding.** A working Node shim should continue to depend on the upstream SpiderMonkey shell surviving the Kandelo build, instrumentation, and kernel execution path.
