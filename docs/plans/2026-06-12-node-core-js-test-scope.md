# Official Node.js Core JS Module Test Scope

**Status:** scope decision for `kad-nct.1`; corrected by `kad-nct.17`
**Date:** 2026-06-12; correction recorded 2026-06-13
**Epic:** `kad-nct` - run official Node.js core JS module tests on Kandelo

## `kad-nct.17` Correction

The original `kad-nct.1` adoption plan below described a selected manifest as
the default run boundary. `kad-nct.17` supersedes that for the epic-level
correction: the official core JavaScript module suite is the complete upstream
Node v22.0.0 `test/parallel/test-*.js` set, currently 3382 files. The harness
default is now full-suite discovery with no pre-run exclusions; the checked-in
manifest is only for `--smoke`, `--manifest-only`, and targeted compatibility
runs.

The full-suite correction report, artifacts, commands, counts, and follow-up
beads are recorded in
`docs/plans/2026-06-13-node-core-full-suite-kad-nct17.md`.

## Decision

The first official Node.js core test adoption should pin to upstream
`nodejs/node` tag `v22.0.0`, tag object
`ec49bec48284ab642db1d109d917c6ae3b695c13`, peeled commit
`12fb157f79da8c094a54bc99370994941c28c235`.

This is intentionally not `main`, the newest Current release, or the local host
`node` version. Kandelo's SpiderMonkey-backed Node-compatible runtime currently
advertises:

```js
process.version === "v22.0.0"
process.versions.node === "22.0.0"
process.versions.v8 === "0.0.0"
process.versions.uv === "0.0.0"
```

The official-test baseline should match that public compatibility contract until
a separate change intentionally bumps the runtime's advertised Node version. A
future version bump must update the test source tag and expected status manifest
in the same branch.

Recommended checkout strategy for the harness:

```bash
git clone --depth 1 --branch v22.0.0 --filter=blob:none --sparse \
  https://github.com/nodejs/node.git .cache/node-v22.0.0
cd .cache/node-v22.0.0
git sparse-checkout set test/parallel test/common test/fixtures lib
git rev-parse HEAD
```

The harness should record both the tag name and peeled commit in its result
artifacts. Do not vendor a moving checkout, and do not run Node's `tools/test.py`
directly against Kandelo. `tools/test.py` assumes a host Node binary and host
process model; Kandelo needs its own runner that invokes selected JS tests
inside the kernel.

## Runtime Boundary

The target runtime for this epic is the package-backed SpiderMonkey Node entry:

- `packages/registry/spidermonkey-node`
- `packages/registry/node`
- shared bootstrap: `packages/registry/node-compat/bootstrap.js`
- browser/demo image layer: `packages/registry/node-vfs`

This runtime is a Node-compatible JavaScript layer over the SpiderMonkey shell.
It is not V8, not libuv, and not the upstream Node C++ embedding. The official
test adoption should validate public JavaScript core-module behavior that this
runtime claims or intends to claim, while classifying unsupported native and
host-specific expectations explicitly.

## Official Source Directories

In scope as source material:

- `test/parallel/test-*.js` - selected official JS tests, one test file as the
  unit of execution.
- `test/common/**` - helper modules required by official tests. Use through a
  Kandelo prelude rather than editing upstream helpers silently.
- `test/fixtures/**` - fixture files referenced by selected tests.
- `lib/**` - only when a selected test imports Node's own JS fixture or library
  source as data.

Out of scope for the first harness:

- `test/addons`, `test/node-api`, `test/js-native-api`, `test/cctest` - native
  addons, Node-API, and C++ tests.
- `test/pseudo-tty`, `test/internet`, `test/pummel`, `test/sequential`,
  `test/abort`, `test/message`, `test/known_issues`, `test/tick-processor`,
  `test/v8-updates`, `test/code-cache`, `test/benchmark`, `test/doctool`,
  `test/es-module` as top-level directories. These can be reconsidered by
  later beads after the `test/parallel` harness is producing artifacts.

Node v22.0.0 has 3382 `test/parallel/test-*.js` files. The original scoped
glob table below is retained as historical adoption guidance for breaking down
future fixes by area, but it is no longer the default harness selection. The
default full-suite run attempts all 3382 files and records unsupported
capabilities as concrete failures or timeouts.

## In-Scope Test Globs

These are the official `test/parallel` files that define the adoption boundary.
Counts are from upstream Node `v22.0.0`.

| Area | Official files | Initial status policy |
| --- | --- | --- |
| `assert` | `test-assert-*.js` (15) | Run, XFAIL only for exact error-message or stack-shape mismatches. |
| `buffer` | `test-buffer-*.js` (60) | Run. This is a high-value compatibility surface. |
| `events` / `EventTarget` | `test-events-*.js` (8), `test-eventtarget-*.js` (3) | Run unless the test requires `internal/` bindings. |
| `path` | `test-path-*.js` (14) | Run. Treat Windows-only cases as SKIP. |
| `querystring` | `test-querystring-*.js` (3) | Run. |
| `url` / WHATWG URL | `test-url-*.js` (15), `test-whatwg-url-*.js` (29) | Run. |
| `string_decoder` | `test-string-decoder-*.js` (2) | Run. |
| `util` / `util/types` | `test-util-*.js` (21), `test-util-types-*.js` (1) | Run. XFAIL exact inspector formatting that depends on V8 internals. |
| `console` | `test-console-*.js` (18) | Run basic Console behavior; XFAIL TTY color and stream backpressure cases if unsupported. |
| `timers` | `test-timers-*.js` (54) | Run with generous timeouts. Classify event-loop ordering failures as real runtime bugs. |
| `process` basics | `test-process-*.js`, `test-next-tick-*.js`, `test-stdin-*.js`, `test-stdout-*.js` (109 combined) | Run only files that do not require CLI flag restart, OS-specific `/proc`, real TTY, or precise signal/job-control behavior. |
| `fs` / file | `test-fs-*.js`, `test-file-*.js` (233 combined) | Run against the Kandelo VFS. SKIP host-permission, platform-specific, watch, and realpath cases that require unavailable host behavior. |
| `stream` | `test-stream-*.js`, `test-stream2-*.js`, `test-stream3-*.js`, `test-readable-*.js` (199 combined) | Run. XFAIL only with a runtime bug note, because streams are central to npm compatibility. |
| CJS / ESM loader | `test-module-*.js`, `test-require-*.js`, `test-commonjs-*.js`, `test-esm-*.js` (48 combined) | Run resolver and package-boundary tests that fit the VFS. SKIP policy, permission, snapshot, loader-hook, and native-loader cases. |
| `os` | `test-os-*.js` (5) | Run with Kandelo's documented Linux/wasm32 values. |
| `crypto` supported subset | `test-crypto-*.js` (97) | Run hash, HMAC, random bytes, random UUID, and `getRandomValues` tests only. Exclude OpenSSL object model, ciphers, DH/ECDH, sign/verify, X509, certificates, FIPS, secure heap, and WebCrypto until implemented. |
| `zlib` supported subset | `test-zlib-*.js` (51) | Run gzip/gunzip/deflate/inflate sync and stream tests. Exclude Brotli and native handle details until implemented. |
| `net` / `dns` / HTTP client | `test-net-*.js`, `test-socket-*.js`, `test-tcp-*.js` (151), `test-dns-*.js` (24), `test-http-*.js`, `test-https-*.js` (431), `test-tls-*.js` (188) | Candidate scope only after smoke. Run loopback and client-side tests that map to Kandelo sockets. SKIP external internet, DNS platform policy, TLS certificate-store, ALPN/SNI edge cases, and server APIs that the runtime does not implement. |

The status manifest should support `PASS`, `FAIL`, `XFAIL`, and `SKIP`.
`XFAIL` means "official expectation is in scope but currently not met";
`SKIP` means "outside this adoption boundary or unavailable in the host
environment." Moving from `PASS` to `FAIL` should block the epic's final PR.

## Explicit Exclusions

Exclude these classes from the official core JS module run unless a later bead
expands the scope intentionally:

- Native addons and Node-API: any `.node` load, `process.dlopen()`,
  `internal/test/binding`, `test/addons`, `test/node-api`, and
  `test/js-native-api`.
- V8-only internals: `test-v8-*.js`, heap snapshots, coverage, startup
  snapshots, cached code, tick processor, `v8` module semantics, V8-specific
  stack formatting, and V8 inspector protocol behavior.
- Inspector/debugger/profiling: `test-inspector-*.js`, `test-debugger-*.js`,
  `--inspect*`, coverage reports, CPU profiling, trace events, and source-map
  internals that depend on V8 hooks.
- Libuv and native handle details: `uv`, native TCPWrap/TTYWrap/PipeWrap
  assumptions, handle reference counting, and tests that assert libuv-specific
  error text or timing.
- Unsupported core modules or import stubs: `http2`, `dgram`, `cluster`,
  full `worker_threads`, full `repl`, full `readline`, full `vm`,
  `diagnostics_channel` tracing behavior, policy/permissions, SEA, WASI, test
  runner, and watch mode.
- Platform-specific process behavior: Windows, macOS, AIX, FreeBSD, OpenBSD,
  Solaris, Android, real host `/proc` or `/sys`, setuid/setgid, real terminal
  raw mode, process groups, job control, and exact signal delivery semantics
  beyond Kandelo's documented POSIX support.
- Harness-host escape hatches: tests that require launching the host's Node
  binary, invoking Python test tooling inside the guest, external network
  access, or host filesystem permissions outside the mounted VFS.

Unsupported imports should still fail predictably. The harness can include a
small negative smoke set proving, for example, that native addons and V8-only
features produce documented unsupported errors rather than silent success.

## Harness Contract For `kad-nct.2`

Inputs:

- upstream source ref: `nodejs/node` `v22.0.0`, tag object
  `ec49bec48284ab642db1d109d917c6ae3b695c13`, and peeled commit
  `12fb157f79da8c094a54bc99370994941c28c235`
- host: `node` or `browser`
- runtime binary: resolved `programs/spidermonkey-node.wasm` or `programs/node.wasm`
- VFS image or mount plan containing selected `test/common`, `test/fixtures`,
  and test files
- status manifest with file path, capability area, expected status, reason,
  timeout, and optional host overrides
- timeout and concurrency controls

Required modes:

- `--explain`: print source ref, selected files, status counts, required
  binaries/images, and artifact paths without running tests.
- `--list`: print the selected official test files after manifest filtering.
- `--smoke`: run a tiny deterministic subset on the selected host.
- default/full: run the scoped manifest and preserve artifacts.

Expected outputs:

- `summary.txt` - human-readable totals by host, area, and status.
- `summary.json` - machine-readable totals and source provenance.
- `results.ndjson` - one record per test with path, host, status, expected
  status, duration, exit code, signal, timeout flag, and reason.
- `stdout/<safe-test-name>.log` and `stderr/<safe-test-name>.log`.
- copied or generated manifest used for the run.
- browser runs should also preserve Playwright console/page errors and any VFS
  image provenance.

The runner should invoke tests one file at a time through Kandelo's normal
runtime path. It may use a Kandelo prelude before `require(testFile)` to provide
stable values that Node's `test/common` expects, such as `process.config`,
`process.features`, and `NODE_SKIP_FLAG_CHECK=1`. The prelude must not claim
unsupported capabilities; use it to make tests self-classify or skip cleanly,
not to mask missing runtime behavior.

## Follow-Up Guidance

- `kad-nct.2`: build the minimal harness around this scope. Implement
  `--explain`, `--list`, `--smoke`, artifact preservation, and the initial
  manifest. Do not repair broad runtime failures in that bead.
- `kad-nct.3`: run harness preflight and smoke on both Node and browser hosts.
  Confirm the source checkout, VFS mounting, runtime binary resolution, and
  artifact writing work before any long run.
- `kad-nct.4`: run the scoped manifest on the Node host. File separate beads
  for root-caused runtime failures instead of expanding the harness with
  compatibility shortcuts.
- `kad-nct.5`: diagnose browser-specific blockers found by smoke or the first
  browser run. Keep Node/browser parity visible.
- `kad-nct.6`: run the scoped manifest on the browser host and preserve
  Playwright/browser artifacts.
- `kad-nct.7`: synthesize Node-host and browser-host results, classify all
  remaining FAIL/XFAIL/SKIP entries, and prepare the epic-level report.
- `kad-nct.8`: open the single PR from
  `integration/kad-nct-node-core-tests` to `main` after the epic artifacts are
  complete.
