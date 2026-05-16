# QuickJS-NG Node Compat — `npm install` Track — Design

Date: 2026-04-28
Branch: `explore-node-wasm-design`
Worktree: `emdash/worktrees/kandelo/wasm-posix-kernel/emdash/explore-node-wasm-rwoav/`

## §1. Goals & non-goals

**Goal.** Get `npm install` of a real multi-dep package running seamlessly on `node.wasm` (the QuickJS-NG-based Node compat binary built by `examples/libs/quickjs/build-quickjs.sh`), under our kernel.

Success criteria, in order:

1. `node -e 'console.log(require("crypto").createHash("sha256").update("x").digest("hex"))'` matches Node's output (real SHA-256, not the XOR stub).
2. `node -e 'require("https").get("https://registry.npmjs.org/lodash/4.17.21", r => r.pipe(process.stdout))'` prints valid JSON, end-to-end TLS.
3. `npm install lodash` (zero-dep) — tarball fetched, integrity verified, extracted, linked, exits 0.
4. `npm install express` — multi-dep, postinstall scripts, bin links.
5. `npm install vite` — extension to native-addon-adjacent territory; informs whether SpiderMonkey escape hatch becomes necessary.

**Non-goals (v1).**

- Native addons (`.node` files): npm packages with C++ addons (sharp, sqlite3 native, node-sass) won't load. `bindings`-style packages fail at runtime. This includes most of the data-processing ecosystem.
- HTTP/2, HTTP/3 — `registry.npmjs.org` serves over HTTP/1.1 just fine; npm's fetch falls back automatically.
- WASI compatibility — we are explicitly not WASI (per `examples/libs/quickjs/build-quickjs.sh:60`).
- Inspector / debugger protocol.
- Real `worker_threads` parallelism — single-threaded JS only. Async I/O concurrency is fine.
- Intl (already excluded from the parent Node-port effort).
- ES2024+ features QuickJS-NG hasn't shipped (decorators stage 3, RegExp `v` flag fully) — fail loudly at parse time, document as known.

**Constraint.** Keep the kernel sandbox load-bearing. No "external host Node process" shortcut. Every JS execution path stays inside the kernel/VFS/syscall boundary that already exists.

## §2. Why this approach, not the others

Two paths were on the table before this design.

**Path A — Torque/V8 (PR #306, closed 2026-04-27).** The kCCBuiltins approach was a coherent technical effort (Phases 0–11) but the team is shifting focus. Closed by Brandon: *"Closing per project decision."* The branch was deleted on GitHub; local refs `torque-cc-backend` and `torque-cc-backend-phase9-checkpoint` are retained for archaeology. **Not extended here.**

**Path B — External host Node process.** Run a real Node binary on the host, proxy stdin/stdout/syscalls into it. Rejected: breaks the kernel sandbox, decouples user JS from kernel VFS/syscalls. The whole project loses its load-bearing guarantee.

**Path C (this design) — Simpler JS engine, completed in-tree.** QuickJS-NG was merged in PR #226 with a 2576-line `bootstrap.js` Node-compat shim layer and a Node-compat C entrypoint (`node-main.c`). Pure interpreter — no JIT, no machine-code emission, no Torque DSL. ES2023 complete. The bootstrap shim already implements path / events / fs / process / Buffer / streams / util / assert / url / querystring / string_decoder / timers / child_process. **The remaining gap to npm is concentrated in three places and four C files of bridge code, not 1000 V8 builtins.** That is the difference vs. Path A.

**SpiderMonkey jitless** is held in reserve as a Phase 7+ fallback if QuickJS hits a perf cliff or an ES2024+ feature gap. The native bindings written here transfer; the C surface is the same.

## §3. Prior art — what's in the tree today

`examples/libs/quickjs/` (PR #226, merged):

| Artifact | What it is |
|---|---|
| `build-quickjs.sh` | Builds two binaries: `qjs.wasm` (plain ES2023 + qjs:std/os) and `node.wasm` (qjs + Node-compat bootstrap as embedded bytecode). Both go through `wasm-opt --asyncify --pass-arg=asyncify-imports@kernel.kernel_fork`. |
| `node-main.c` | C entry. Sets up `JSContext`, registers `qjs:std`/`qjs:os`/`qjs:bjson`, evaluates the embedded bootstrap, then runs the user script with `__filename` / `__dirname` set. Hardcodes `version: v22.0.0`, `platform: linux`, `arch: wasm32`. |
| `node-compat/bootstrap.js` (2576 lines) | Pure-JS Node API surface: TextEncoder, atob/btoa, path, events, Buffer, process, fs, os, util, assert, stream, url, querystring, string_decoder, timers, child_process, crypto, net, http, https, zlib, tty, module, dns, readline, perf_hooks, worker_threads, cluster, v8, vm. CommonJS `require()` with `node_modules` walk + `package.json main`. |
| `host/test/node-compat.test.ts` | 12 vitest cases covering process, Buffer, path, fs, events, os, util, assert, stream — gated with `describe.skipIf(!hasNode)`. |

Tested-and-real today (backed by `qjs:os` syscalls — `bootstrap.js` calls `os.open`, `os.read`, `os.write`, `os.stat`, `os.mkdir`, `os.readdir`, `os.realpath`, `os.symlink`, `os.kill`, `os.chdir`, `os.getcwd`, `std.popen`, `std.loadFile`, `std.getenv`, `std.setenv`):

- File I/O, directory ops, path manipulation, env vars
- Buffer (full byte/string/hex/base64 plumbing)
- EventEmitter, streams (Readable / Writable / Duplex / PassThrough)
- CommonJS `require` — including `node_modules` walk and `package.json` resolution
- `child_process.execSync` — via `std.popen` → `/bin/sh -c`, real fork+exec on our kernel

## §4. Key finding — the gap to npm is three native modules

Line-precise survey of the stubs in `examples/libs/quickjs/node-compat/bootstrap.js` (verified 2026-04-28 against `37814ab5`):

| Module | Stub site | What it actually does today | What npm needs |
|---|---|---|---|
| `crypto` | L2089–2148 (`createHash`, `createHmac`) | XORs input bytes into a 32-byte buffer. `// TODO: implement actual hashing` at L2124. | Real SHA-256/SHA-512 for `npm-shrinkwrap` / `package-lock` integrity strings. Each downloaded tarball is verified. |
| `net` / `http` / `https` | L2152–2222 (Socket, Server, connect), L2225–2259 (request, get); `https = http` alias at L2283 | `net.Socket.connect` sets `connecting=true`, emits `'connect'` on next tick — never opens a socket. `http.request` returns a stub `net.Socket`. `// TODO: implement actual socket connection via kernel` at L2171, `// TODO: implement actual HTTP client` at L2248. No TLS distinction. | Real socket → `connect()` + `read()` / `write()`. Real TLS for `registry.npmjs.org`. The kernel has AF_INET sockets (PR #287, merged); the gap is exposing them to JS. |
| `zlib` | L2284–2293 | `gzipSync(buf) { return buf; }` — pass-through. `createGzip` returns a `PassThrough`. | npm tarballs are gzipped tar. Without real gunzip, `npm install` cannot extract a single package. |

Other secondary gaps (lower priority — don't block npm but will surface):

- `dns.lookup` always returns `127.0.0.1` (L2306) — npm uses Node's net stack which calls dns; if `net.Socket.connect` accepts a hostname and resolves at the C level, this stub becomes harmless.
- `worker_threads` is a no-op (L2333). npm doesn't use it; some build tools do (esbuild). Defer.
- `v8.getHeapStatistics` returns zeros (L2344). npm tolerates. Defer.

The kernel and userspace toolchain already have:

- `examples/libs/openssl/` — full OpenSSL build for our wasm32 sysroot. Provides SHA-256/512 (libcrypto) and TLS (libssl).
- `examples/libs/zlib/` — standalone libz build script (`build-zlib.sh`, builds `libz.a` against the sysroot).
- AF_INET + AF_UNIX sockets, real `connect()` / `send()` / `recv()` syscalls (PR #287, PR #356).

So the bridge work is C: a QuickJS native module that exposes openssl + zlib + sockets to the bootstrap. **No new kernel work for the happy path.**

## §5. Design

### §5.1 Architecture

```
   ┌─ user JS (npm, lodash, vite, …) ───────────────────┐
   │  require('crypto').createHash('sha256')…           │
   │  require('https').get('https://registry…')         │
   │  require('zlib').gunzipSync(tarball)               │
   └────┬────────────────────────────┬──────────────────┘
        │                            │
        │ JS-side shim (existing)    │ JS-side shim (existing,
        │ delegates to native        │  delegates to native
        │ when present, falls back   │  when present)
        │ to stub otherwise          │
        ▼                            ▼
   ┌────────────────────────────────────────────────────┐
   │ bootstrap.js (modified): crypto / net / http /     │
   │ https / zlib re-routed to globalThis._nodeNative.* │
   └────┬────────────────────────────┬──────────────────┘
        │                            │
        │ qjs:node native module     │ qjs:os existing module
        │ (C, this design)           │
        ▼                            ▼
   ┌─────────────────┬───────────────┬─────────────────┐
   │ libcrypto       │ libssl        │ libz            │
   │ (SHA, HMAC)     │ (TLS 1.2/1.3) │ (deflate/gunzip)│
   └─────────────────┴───────────────┴─────────────────┘
        │                                              │
        ▼                                              ▼
   ┌─────────────────────────┐    ┌───────────────────────────┐
   │ kernel syscalls         │    │ event-loop fd-watch (new) │
   │ socket() connect()      │◄───┤ poll() between timers     │
   │ read() write() close()  │    │ in js_std_loop            │
   │ getaddrinfo()           │    └───────────────────────────┘
   └─────────────────────────┘
```

### §5.2 Bridge: a single QuickJS native module `qjs:node`

Add `examples/libs/quickjs/node-compat-native/` — C source for a QuickJS C module loaded by `node-main.c` alongside `qjs:std` / `qjs:os` / `qjs:bjson`. It exposes typed JS bindings to:

| Binding namespace | C calls into | Used by bootstrap.js |
|---|---|---|
| `node:hash` | `<openssl/sha.h>` (libcrypto) | `crypto.createHash`, `crypto.createHmac` |
| `node:tls` | `<openssl/ssl.h>` + raw fd from socket | `https` request path |
| `node:socket` | `socket()` / `connect()` / `read()` / `write()` / `close()` syscalls | `net.Socket`, `http`, `dns.lookup` (via `getaddrinfo`) |
| `node:zlib` | libz `inflate` / `deflate` | `zlib.gunzipSync` (and stream forms) |

The native module is the only C addition. `node-main.c` registers it (`js_init_module_node`, alongside the existing `js_init_module_std` etc. at `node-main.c:49–51`). bootstrap.js stops stubbing those four corners.

**Why one module and not four.** Build complexity. One archive linked into `node.wasm`. bootstrap.js gates `if (typeof globalThis._nodeNative !== 'undefined') { ...real impl... } else { ...current stub... }` so existing tests never regress and partial builds (e.g. without OpenSSL) still produce a working `node.wasm`.

### §5.3 Module resolution — already CommonJS

`bootstrap.js:2369–2480` implements:

- Builtin lookup with and without `node:` prefix
- Relative / absolute path resolution with `.js` / `.json` extension probing
- `node_modules` walk up the directory tree
- `package.json` `main` field (no `exports` map yet)

ESM (`import` / `import.meta`) goes through QuickJS's native module loader (`JS_SetModuleLoaderFunc2` in `node-main.c:228`). This already works — QuickJS-NG has full ESM. The gap for npm is **`package.json exports` field** resolution in the CJS path: npm itself is mostly CJS but pulls in some ESM-only deps. Add it as part of Phase 5.

### §5.4 TLS — the load-bearing piece

OpenSSL builds for our sysroot. The native module wraps `SSL_CTX_new` / `SSL_new` / `SSL_set_fd` / `SSL_connect` / `SSL_read` / `SSL_write` / `SSL_shutdown`. The JS side (`https`) layers HTTP/1.1 framing on top.

Cert verification: ship Mozilla's `cacert.pem` (~200 KB) inside the VFS at `/etc/ssl/cert.pem` (and / or `/etc/ssl/certs/ca-certificates.crt`). Our OpenSSL build is configured `--openssldir=/etc/ssl` (verified by `strings libcrypto.a` showing `OPENSSLDIR: "/etc/ssl"`, `/etc/ssl/cert.pem`, `/etc/ssl/certs`).

HTTP/2 is out of scope.

### §5.5 Hashing

`crypto.createHash('sha256')` → call `SHA256_Init` / `SHA256_Update` / `SHA256_Final`. `digest('hex')` formats the 32-byte buffer.

`crypto.randomBytes` already works (`bootstrap.js:2095`) by reading `/dev/urandom`, which is a real kernel device.

### §5.6 Compression

`zlib.gunzipSync(buf)` → libz `inflate` with `windowBits=31` (gzip-aware). Streaming variants `createGunzip` etc. become real Transform streams over the same C API. `tar` extraction in npm uses node-tar (pure JS) on top of streams — works once gunzip works.

### §5.7 Sockets

`net.Socket` becomes a Duplex stream backed by a real kernel fd. `connect(port, host)` calls a C binding that does `getaddrinfo` + `socket(AF_INET, SOCK_STREAM)` + `connect()`. Reads use `read(fd, buf, n)` non-blocking via `O_NONBLOCK` + `poll`-driven event loop integration with `js_std_loop`.

**Event-loop integration.** QuickJS-NG's `js_std_loop` already pumps `os.setTimeout` and `os.signal` callbacks. We add a fd-watch table the native module owns; on each loop iteration after timer dispatch, call `poll()` on registered fds and emit `'data'` / `'end'` / `'error'` events.

This is a bigger piece than hashing or zlib — Phase 3, on its own, will be ~1 week.

### §5.8 Why not patch QuickJS-NG upstream

We compile QuickJS-NG from a clean clone (`git clone --depth=1 --branch v0.12.1`). Patches to `quickjs-ng/quickjs.git` would force us to fork and maintain. The native module mechanism is a stable C API designed for exactly this — cf. `qjs:std` / `qjs:os` themselves. Stay on the API; don't fork.

## §6. Phasing

Each phase is a PR. Each PR closes its own test gap. Match Brandon's `area(scope): subject — outcome` commit style. All five test suites in `CLAUDE.md` must pass per phase; `scripts/check-abi-version.sh` must succeed.

### Phase 0 — Verification (½ day)

- Build `node.wasm` from current `main`: full chain (`git submodule update --init musl` → `bash scripts/build-musl.sh` → `bash build.sh` → `bash examples/libs/openssl/build-openssl.sh` → `bash examples/libs/zlib/build-zlib.sh` → `bash examples/libs/quickjs/build-quickjs.sh`).
- Run `cd host && npx vitest run test/node-compat.test.ts`. Confirm baseline passes.
- Audit OpenSSL sysroot: confirm `libcrypto.a` and `libssl.a`, `OPENSSLDIR`, default cert paths.
- Audit zlib sysroot: confirm `libz.a` installed.
- Pull a single npm tarball with `curl https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz` and verify `tar -xzf` works on it from a wasm32 binary (sanity check the format roundtrips through our existing kernel).
- **Output:** `docs/plans/2026-04-28-quickjs-node-compat-phase0.md` with checkmarks per item, blocking issues if any.

Phase 0 may surface foundation bugs (toolchain drift, build-script staleness, runtime regressions in `qjs.wasm` itself) that must be fixed in their own focused PRs before Phase 1 starts. The verification doc records what was found, not the design — the design here is unaffected.

### Phase 1 — Hashing (2–3 days)

PR title: `feat(quickjs-node): real SHA-256/512 via libcrypto`

- Add `examples/libs/quickjs/node-compat-native/hash.c` — QuickJS C module exposing `node:hash` with `Sha256` / `Sha512` / `Md5` / `Sha1` constructors, each with `update(buf)` / `digest(encoding)`.
- Wire into `build-quickjs.sh`: link against `-lcrypto`.
- Patch `bootstrap.js` `crypto` section (L2089–2148): replace XOR stub with the binding when `globalThis._nodeNative.hash` is present.
- Tests: extend `node-compat.test.ts` with a `crypto` describe block. Vector each algorithm against known SHA-256 / SHA-512 / MD5 / SHA-1 outputs (NIST test vectors).

Acceptance: `createHash('sha256').update('').digest('hex') === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'`.

### Phase 2 — Compression (2–3 days)

PR title: `feat(quickjs-node): real gzip/inflate via libz`

- `node-compat-native/zlib.c` exposing `node:zlib` with `Inflate` / `Deflate` / `Gunzip` / `Gzip` classes plus `gzipSync` / `gunzipSync` / `inflateSync` / `deflateSync`.
- Patch `bootstrap.js` `zlib` section (L2284–2293).
- Tests: roundtrip a known buffer; gunzip the lodash tarball downloaded in Phase 0.

Acceptance: `zlib.gunzipSync(fs.readFileSync('lodash-4.17.21.tgz'))` produces a tar archive whose first entry is `package/`.

### Phase 3 — Sockets + event-loop integration (1–1.5 weeks) — DESIGN RISK

PR title: `feat(quickjs-node): real AF_INET sockets + event-loop fd-watch`

- `node-compat-native/socket.c` exposing `node:socket` with `connect(host, port, callback)`, `read(fd, n, cb)`, `write(fd, buf, cb)`, `close(fd)`. Uses `getaddrinfo` / `socket` / `connect` from the kernel.
- Wire fd-watch into `js_std_loop`. When a socket has a pending `read`, register the fd; loop iteration calls `poll(fds, n, timeout)` between timer dispatches.
- Patch `bootstrap.js` `net` section (L2152–2222) to back `Socket` with a real fd. Make it a real Duplex stream.

**Risks (this is the spike phase):**

- QuickJS-NG `js_std_loop` may need patching to accept external pollables. If it doesn't, we fork the loop into our native module (acceptable).
- Reentrancy: socket callbacks run on the JS loop thread; ensure they can't fire while a sync syscall is mid-flight.
- Backpressure: `write()` to a full kernel pipe — handle `EAGAIN`, queue in JS.

Acceptance: `net.connect(80, 'example.com')` followed by an HTTP/1.0 GET round-trips real bytes.

### Phase 4 — TLS (1 week)

PR title: `feat(quickjs-node): TLS via OpenSSL — https.get works`

- `node-compat-native/tls.c` exposing `node:tls` with a `TlsSocket` wrapper that takes an existing fd, runs `SSL_connect`, then forwards `read` / `write` through `SSL_read` / `SSL_write`.
- Ship `cacert.pem` at `/etc/ssl/cert.pem` in the kernel's VFS image.
- Patch `bootstrap.js` to make `https` a thin wrapper that wraps a `net.Socket` in `tls.connect` instead of being a flat alias of `http`.
- Implement `http` as `net.Socket` + minimal HTTP/1.1 parser (~200 LOC pure JS, new bootstrap section).

Acceptance: `https.get('https://registry.npmjs.org/lodash/4.17.21', r => r.pipe(process.stdout))` prints the valid JSON manifest.

### Phase 5 — npm bootstrap (1–2 weeks)

PR title: `feat(quickjs-node): npm install of zero-dep package`

- Bundle npm itself into the kernel VFS. npm 10.x is ~12 MB unpacked of pure JS (no native runtime deps — they were removed). Ship as a lazy archive (same pattern as vim / nethack — see `docs/plans/2026-04-20-nethack-shell-demo-design.md`).
- Bring up `package.json exports` field resolution in `bootstrap.js`'s `_resolveFile`.
- Surface failures as runtime errors with clean stack traces. Each missing API → small bootstrap.js patch or a focused native shim.

Acceptance: from a fresh tmp dir, `npm install lodash` exits 0; `node_modules/lodash/package.json` has the right `version`.

### Phase 6 — `npm install` of real-world multi-dep (1–2 weeks)

PR title: `feat(quickjs-node): npm install of express + vite`

- Run against `express` (~30 deps), then `vite` (~50 deps with bin links and postinstall).
- Catch and fix surfaced gaps: missing fs flags, async streaming edge cases, signal handling for postinstall scripts.

Acceptance: `node_modules/.bin/vite --help` runs.

### Phase 7+ — Decision point

After Phase 6, evaluate:

- If we hit a perf cliff (e.g. `npm install` takes > 5 minutes) — switch to **SpiderMonkey jitless**. SpiderMonkey supports `--disable-jit` builds and has been ported to wasm32 by others (Mozilla's WASI experiments). The native bindings written in Phases 1–4 transfer; the C surface is the same.
- If we hit ES2024+ features QuickJS-NG hasn't shipped (decorators stage 3, RegExp `v` flag fully) — same switch.
- Otherwise stay on QuickJS-NG; estimate is `npm install` works at 60–80% of native Node's install time.

## §7. Risks

- **Conservative GC + native fds.** QuickJS-NG uses reference counting (no GC); native bindings must call `JS_FreeValue` correctly. Less risk than V8's CSS, more bookkeeping.
- **Asyncify × event loop.** `node.wasm` is asyncified for `kernel_fork`. The fd-watch loop must not deadlock if a callback triggers `fork()`. Worst case: forbid `fork()` from socket callbacks; surface as `EAGAIN`.
- **TLS cert chain depth.** Some npm registry mirrors use deep chains. `cacert.pem` has all of Mozilla's roots (~140 CAs) and works with stock OpenSSL.
- **npm itself uses workers.** `npm install` parallelism: npm 10 uses internal `Promise.all` over fetches, not real worker threads. The `worker_threads` no-op stub is fine; if a dep's postinstall fires up workers, that dep fails — surface as a known limitation.
- **QuickJS-NG drift.** PR #226 merged the foundation but no commits touch `examples/libs/quickjs/` since (current HEAD `37814ab5`). Bit-rot is possible vs. the current kernel; Phase 0 verifies and any regression is fixed in its own PR, not folded into Phase 1.

## §8. Open questions

- Does npm 10 work over HTTP/1.1 to `registry.npmjs.org` without HTTP/2 negotiation hiccups? (Phase 0 spike: `curl --http1.1 https://registry.npmjs.org/lodash` — if curl works, npm will.)
- Is there a smaller npm we should start with (e.g. `pnpm` or just `npm-fetch` standalone)? Phase 5 reassesses based on size of npm-in-VFS vs. cold-start cost.
- Should the native module live in `examples/libs/quickjs/node-compat-native/` (port-local) or `glue/node-native/` (shared)? Lean port-local — keeps the `quickjs-ng` clone clean and follows the pattern of other examples.
