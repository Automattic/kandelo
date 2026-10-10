# Native Go browser probes

These probes run binaries from the `kandelo-port` branch of
[`kandelo-dev/go`](https://github.com/kandelo-dev/go/tree/kandelo-port) through
Kandelo's real Chromium process workers and ABI-48 kernel. Use fork commit
`98dc3f1` or later, built with Go 1.25.6 as `GOROOT_BOOTSTRAP`. By default
the fork is checked out beside this repository as `../go-kandelo`.

From the Kandelo repository root:

```sh
./run.sh build kernel
scripts/dev-shell.sh bash tests/go/build-browser-fixtures.sh
scripts/dev-shell.sh bash -c 'cd apps/browser-demos && npm ci'
scripts/dev-shell.sh bash -c 'cd apps/browser-demos && KANDELO_GO_BROWSER_TESTS=1 npx playwright test test/go-port.spec.ts --project=chromium'
```

The fixture script writes eighteen Wasm programs for nineteen browser tests
under `.context/go-browser/`. Set `GO_KANDELO_BIN` to an absolute path to use
another fork binary. Use
`KANDELO_PLAYWRIGHT_PORT` inside the last command if another workspace already
serves the default Playwright port.

The script stamps only the binaries it rebuilt with this checkout's
`kandelo.abi.contract` digest. The Node and Chromium probes require the
fixture digest to match the kernel, so run the fixture script rather than
building individual probes directly with `go build`.

To run the exec probe in Node after building the fixtures:

```sh
scripts/dev-shell.sh bash -c 'node --import tsx tests/go/exec-basic/run.ts .context/go-browser/exec-basic.wasm $(scripts/resolve-binary.sh kernel.wasm)'
```

The Node runner also checks that both child launches leave the parent's fork
count at zero.

To run the `os/user` public API and selected upstream parser tests in Node:

```sh
scripts/dev-shell.sh bash -c 'node --import tsx tests/go/user-basic/run.ts .context/go-browser/user-basic.wasm $(scripts/resolve-binary.sh kernel.wasm)'
scripts/dev-shell.sh bash -c 'node --import tsx tests/go/user-basic/run.ts .context/go-browser/user-test.wasm $(scripts/resolve-binary.sh kernel.wasm) stdlib-tests'
```

These probes supply real `/etc/passwd` and `/etc/group` VFS files for the
public API check. They do not establish host account database integration or
full `os/user` conformance.

## Resolver package and VFS launch

`go-hello` is a registry program built from this repository's Go sample and
the exact `kandelo-dev/go` commit declared in its `build.toml`. The source-only
resolver fetches a sealed Go source tree, builds the toolchain with the dev
shell's Go bootstrap, invokes `sdk/bin/wasm32posix-go`, and stamps the published
Wasm with the current ABI-contract digest. The Go fork does not need to be
checked out beside this repository for this package build.

```sh
KANDELO_CACHE_GC_AUTO=0 scripts/dev-shell.sh bash -c 'cargo xtask bootstrap go-hello'
./run.sh build kernel
scripts/dev-shell.sh bash tests/go/package-basic/build-launcher.sh
scripts/dev-shell.sh bash -c 'node --import tsx tests/go/package-basic/run.ts'
scripts/dev-shell.sh bash -c 'cd apps/browser-demos && KANDELO_GO_PACKAGE_TESTS=1 npx playwright test test/go-package.spec.ts --project=chromium'
```

The Node and Chromium tests load the *resolved* `go-hello.wasm`, put its exact
bytes at `/bin/go-hello.wasm` in a VFS image, and have a C process launch it
with `posix_spawn`. They require both programs' ABI digests to match the
kernel, exit 0, the Go and launcher markers, and no stderr or host
diagnostics; Node additionally checks that the parent's fork count remains
zero. This is a first-class package/VFS smoke test, not broad Go conformance.
The legacy `build-deps resolve` policy does not stamp program output; use the
source-only local-build projection above for runtime tests.

The Go linker now declares 32 preallocated pthread slots by default (8 MiB of
control pages). Set a different count per program with
`go build -ldflags='-kandelothreadslots=64'`; valid counts are 1–1024. The
declaration changes the process memory requirement, not the kernel ABI. The
64-round burst probe uses the default count and intentionally does not pace
worker exits.

The browser tests cover startup arguments/environment, clock, random, and file
syscalls, VFS-backed account and group lookup and selected upstream `os/user`
parser tests, second-M bootstrap, five sequential clone handoffs, goroutines
running on two Ms, concurrent clone handoffs from those Ms, `LockOSThread`
affinity across yields and unlock, twelve paced locked-M exits and 64 unpaced
locked-M starts without an explicit unlock (exercising slot recycling),
sysmon-assisted cooperative preemption under `GOMAXPROCS=1`, IPv4 and IPv6
TCP loopback through Go `syscall`, runtime epoll readiness with a read
deadline and blocked-read close, a raw blocking pipe read that releases the
scheduler P under `GOMAXPROCS=1`, `net.Dial`/`net.Listen` IPv4 and IPv6
round trips, HTTP client/server requests on both address families, process
spawn/wait with child argv, environment, cwd, exit status, and command output
through a pipe, process-wide exit from a worker M, and selected upstream Go
atomic and sync package tests. Each test requires exit 0, expected output,
and no host diagnostics or browser errors. They are
opt-in because the external Go fork is not provisioned by the normal browser
suite; without `KANDELO_GO_BROWSER_TESTS=1`, Playwright reports them as skipped.
The socket probe covers address conversion, socket options, bind, listen,
connect, accept, peer/local names, and stream read/write on both hosts. The
netpoll probe wraps a nonblocking
TCP socket in `os.NewFile` to exercise deadline expiry, data readiness,
and close-unblocks-read through the runtime poller. It also checks that a
blocking `syscall.Read` cannot starve a timer-driven writer when there is
only one P. The `net` probe uses
`netFD` for IPv4/IPv6 `net.Listen` and `net.DialTimeout`; the HTTP probe runs
an actual Go server and client over loopback. The host uses a thread-specific
Wasm module without active data segments so adding an M cannot reinitialize
the running process's Go package state. UDP/message syscalls, DNS, TLS
certificate provisioning and broad Go conformance remain
unverified or unsupported. These focused probes do not establish full Go
runtime or POSIX conformance.

## FrankenPHP prerequisite: cgo

FrankenPHP classic mode is the WordPress server target, but its Go-to-PHP
embedding requires cgo and a PHP ZTS embed library. The first Go/Wasm gate is
the small C-call program in `cgo/main.go`:

```sh
scripts/dev-shell.sh bash -c 'CGO_ENABLED=1 GOOS=kandelo GOARCH=wasm CC=wasm32posix-cc ../go-kandelo/bin/go build -o .context/cgo-probe.wasm tests/go/cgo/main.go'
```

The pinned `go-hello` package now uses the callback-capable fork revision,
although that package itself builds only a pure-Go program.
The adjacent fork's experimental cgo frontend and linker now execute this
fixture on the main and a second Go M. It checks `C.abs`, three scalar
arguments, C pointer arguments in first and middle positions, and independent
musl pthread identity and `errno` across four worker rounds. It also checks
that C `getenv` sees the initial process environment and Go
`os.Setenv`/`os.Unsetenv` changes, including across a Go GC. The raw module
validates, fork-instruments, and runs as an ABI-stamped Kandelo process on Node and
Chromium with exit 0 and no diagnostics. This is narrow Go-to-C coverage,
not general cgo support: Go-owned and C-created-pthread callbacks pass focused
process probes, but secure startup and broader PHP behavior remain incomplete.
The `php-zts` package now builds a static ZTS embed library, and a narrow
`tests/go/cgo/php-embed` probe executes PHP initialization, a script string,
and shutdown on both hosts. That probe alone is not a request-level gate.

The `frankenphp-classic` package is a separate request-level gate. Its
resolver-built binary serves a PHP request and a static asset through
Kandelo HTTP on Node and Chromium. It does not by itself prove WordPress:

```sh
scripts/dev-shell.sh bash .agents/skills/porting-software-to-kandelo/scripts/build-package.sh frankenphp-classic wasm32
scripts/dev-shell.sh bash -c 'prefix=$(cargo xtask build-deps --arch wasm32 resolve frankenphp-classic); npx tsx packages/registry/frankenphp-classic/test/run.ts "$prefix/frankenphp-classic.wasm" "$(scripts/resolve-binary.sh kernel.wasm)"'
scripts/dev-shell.sh bash -c 'cd apps/browser-demos && KANDELO_FRANKENPHP_CLASSIC_WASM="$(cd ../.. && cargo xtask build-deps --arch wasm32 resolve frankenphp-classic)/frankenphp-classic.wasm" npx playwright test test/frankenphp-classic.spec.ts --project=chromium'
```

```sh
scripts/dev-shell.sh bash tests/go/cgo/php-embed/build.sh
scripts/dev-shell.sh bash -c 'node --import tsx tests/go/cgo/php-embed/run.ts .context/go-php-embed/probe-instrumented.wasm "$(scripts/resolve-binary.sh kernel.wasm)"'
scripts/dev-shell.sh bash -c 'cd apps/browser-demos && KANDELO_GO_BROWSER_TESTS=1 KANDELO_GO_CGO_RUNTIME_TESTS=1 npx playwright test test/go-port.spec.ts --project=chromium --grep "PHP ZTS embed"'
```

```sh
scripts/dev-shell.sh bash -c 'GO111MODULE=off CGO_ENABLED=1 GOOS=kandelo GOARCH=wasm CC=wasm32posix-cc ../go-kandelo/bin/go build -a -o .context/go-c-abs.wasm ./tests/go/cgo && wasm-validate --enable-threads .context/go-c-abs.wasm'
scripts/dev-shell.sh bash -c 'scripts/run-wasm-fork-instrument.sh .context/go-c-abs.wasm -o .context/go-c-abs-instrumented.wasm'
scripts/dev-shell.sh bash -c 'REPO_ROOT=$PWD; source scripts/build-programs-abi-stamp.sh; record_built_program_output .context/go-c-abs-instrumented.wasm; stamp_built_program_outputs'
node --import tsx tests/go/cgo/run.ts .context/go-c-abs-instrumented.wasm "$(scripts/resolve-binary.sh kernel.wasm)"
cd apps/browser-demos && KANDELO_GO_BROWSER_TESTS=1 KANDELO_GO_CGO_RUNTIME_TESTS=1 npx playwright test test/go-port.spec.ts --project=chromium --grep 'standard cgo calls C'
```

A compile-only pass does not establish working interoperability. The
Go-owned callback fixture at `cgo/callback-same` now runs on Node and
Chromium: it yields, waits on a timer, calls C again, and repeats on a
second Go M. The combined pthread fixture links and validates but its
C-created callback now attaches to a Go M and channel and passes focused Node
and Chromium process gates, including a yield, timer wait, repeat callback,
and second Go M. That is a prerequisite, not a FrankenPHP build. See the
dated WordPress pivot in the Go implementation progress log.

```sh
scripts/dev-shell.sh bash -c 'GO111MODULE=off CGO_ENABLED=1 GOOS=kandelo GOARCH=wasm CC=wasm32posix-cc ../go-kandelo/bin/go build -a -o .context/go-callback-same.wasm ./tests/go/cgo/callback-same'
scripts/dev-shell.sh bash -c 'scripts/run-wasm-fork-instrument.sh .context/go-callback-same.wasm -o .context/go-callback-same-instrumented.wasm'
scripts/dev-shell.sh bash -c 'REPO_ROOT=$PWD; source scripts/build-programs-abi-stamp.sh; record_built_program_output .context/go-callback-same-instrumented.wasm; stamp_built_program_outputs'
node --import tsx tests/go/cgo/callback-same/run.ts .context/go-callback-same-instrumented.wasm "$(scripts/resolve-binary.sh kernel.wasm)"
cd apps/browser-demos && KANDELO_GO_BROWSER_TESTS=1 KANDELO_GO_CGO_RUNTIME_TESTS=1 npx playwright test test/go-port.spec.ts --project=chromium --grep 'Go-owned M cgo callback'
```

The `cgo/constructors` fixture verifies standard Wasm C constructor
metadata, priority order, a metadata-only `.init_array.150` segment, and C
destructor registration. Its ordinary mode calls musl's exit-handler
dispatcher explicitly. Its `c-exit` mode enters C `exit(0)` and checks that
the registered handler runs on Node and Chromium. A Go main return does not
establish automatic C exit-handler dispatch. The linker still rejects
nonzero or referenced initializer arrays; LLVM currently rejects
`.fini_array` at compile time.

The `cgo/secure-exec` fixture verifies that a Go-led cgo child receives musl's
kernel-owned secure-startup marker after a set-ID `exec`, and loses it when a
later `posix_spawn` uses `POSIX_SPAWN_RESETIDS`. The C parent exercises the
real VFS credential transition. Both `issetugid` and `getauxval(AT_SECURE)`
must agree with `secure_getenv`; this is a focused startup test, not a general
Go secure-environment audit. Build and stamp the Go child, then run the Node
and Chromium cases:

```sh
scripts/dev-shell.sh bash -c 'GO111MODULE=off CGO_ENABLED=1 GOOS=kandelo GOARCH=wasm CC=wasm32posix-cc ../go-kandelo/bin/go build -a -o .context/go-cgo-secure-exec.wasm ./tests/go/cgo/secure-exec'
scripts/dev-shell.sh bash -c 'scripts/run-wasm-fork-instrument.sh .context/go-cgo-secure-exec.wasm -o .context/go-cgo-secure-exec-instrumented.wasm; REPO_ROOT=$PWD; source scripts/build-programs-abi-stamp.sh; record_built_program_output .context/go-cgo-secure-exec-instrumented.wasm; stamp_built_program_outputs'
scripts/dev-shell.sh bash -c 'cd host && ./node_modules/.bin/vitest run test/secure-exec.test.ts -t "Go/cgo child"'
cd apps/browser-demos && WASM_POSIX_RESOLUTION_POLICY=source-only-v1 WASM_POSIX_SOURCE_ONLY_BINARY_ROOT="$(cd ../.. && pwd)/local-binaries/source-only-v1" KANDELO_GO_CGO_RUNTIME_TESTS=1 ./node_modules/.bin/playwright test test/secure-exec-startup.spec.ts --project=chromium --grep 'Go/cgo child'
```

```sh
scripts/dev-shell.sh bash -c 'GO111MODULE=off CGO_ENABLED=1 GOOS=kandelo GOARCH=wasm CC=wasm32posix-cc ../go-kandelo/bin/go build -a -o .context/go-constructors.wasm ./tests/go/cgo/constructors && wasm-validate --enable-threads .context/go-constructors.wasm'
scripts/dev-shell.sh bash -c 'scripts/run-wasm-fork-instrument.sh .context/go-constructors.wasm -o .context/go-constructors-instrumented.wasm'
scripts/dev-shell.sh bash -c 'REPO_ROOT=$PWD; source scripts/build-programs-abi-stamp.sh; record_built_program_output .context/go-constructors-instrumented.wasm; stamp_built_program_outputs'
node --import tsx tests/go/cgo/constructors/run.ts .context/go-constructors-instrumented.wasm "$(scripts/resolve-binary.sh kernel.wasm)"
node --import tsx tests/go/cgo/constructors/run.ts .context/go-constructors-instrumented.wasm "$(scripts/resolve-binary.sh kernel.wasm)" c-exit
cd apps/browser-demos && KANDELO_GO_BROWSER_TESTS=1 KANDELO_GO_CGO_RUNTIME_TESTS=1 npx playwright test test/go-port.spec.ts --project=chromium --grep 'C constructors|C exit dispatches'
```

The separate `cgo/callback` fixture exercises Go-to-C-to-Go calls on the
calling thread and a C-created pthread entering Go. It checks a mixed
scalar/pointer callback frame and forces stack growth in the foreign callback:

```sh
scripts/dev-shell.sh bash -c 'GO111MODULE=off CGO_ENABLED=1 GOOS=kandelo GOARCH=wasm CC=wasm32posix-cc ../go-kandelo/bin/go build -o .context/cgo-callback-probe.wasm ./tests/go/cgo/callback'
scripts/dev-shell.sh bash -c 'scripts/run-wasm-fork-instrument.sh .context/cgo-callback-probe.wasm -o .context/cgo-callback-probe-instrumented.wasm'
scripts/dev-shell.sh bash -c 'REPO_ROOT=$PWD; source scripts/build-programs-abi-stamp.sh; record_built_program_output .context/cgo-callback-probe-instrumented.wasm; stamp_built_program_outputs'
node --import tsx tests/go/cgo/callback/run.ts .context/cgo-callback-probe-instrumented.wasm local-binaries/kernel.wasm
cd apps/browser-demos && KANDELO_GO_BROWSER_TESTS=1 KANDELO_GO_CGO_RUNTIME_TESTS=1 npx playwright test test/go-port.spec.ts --project=chromium --grep 'C-created pthread callback grows'
```

Its `stress` mode starts three C pthreads concurrently for eight rounds,
crosses into Go with scheduler yields, allocates and frees C memory, and
forces Go allocation/GC between rounds. This is a bounded contention and
reclaim probe, not full pthread or allocator conformance. Run it with the
same stamped callback artifact:

```sh
node --import tsx tests/go/cgo/callback/run.ts .context/cgo-callback-probe-instrumented.wasm "$(scripts/resolve-binary.sh kernel.wasm)" stress
cd apps/browser-demos && KANDELO_GO_BROWSER_TESTS=1 KANDELO_GO_CGO_RUNTIME_TESTS=1 npx playwright test test/go-port.spec.ts --project=chromium --grep 'Concurrent C pthread callbacks'
```

It passes as an opt-in Node and Chromium process gate after fork
instrumentation and ABI stamping. An
experimental `cmd/cgo` frontend in the adjacent fork parses the
Wasm debug object far enough for both fixtures to reach the Go linker. The
adjacent fork's internal linker now reads C function bodies, initialized C
data, active table elements, and the CODE relocations reached by runtime/cgo.
The combined fixture now links and validates after retaining musl local
function aliases; its C-created pthread callback now attaches to a Go M/P,
bootstrap stack, and channel. This is still narrow callback coverage, not
general PHP embedding.
The `go-hello` package pin now follows the callback-capable fork revision,
but its pure-Go artifact is not evidence of PHP support. Do not use a successful cgo frontend or
function-body parse as PHP or FrankenPHP support.

The intermediate Go/C object-link test is reproducible with:

```sh
scripts/dev-shell.sh bash -c 'cd apps/browser-demos && npm ci'
scripts/dev-shell.sh bash tests/go/cgo/link-only/test-link.sh
```

It manually adds SDK C objects to a cgo-free Go archive and checks that the
final Go Wasm module validates, relocates a C-to-C call and C static data,
then executes C functions through the exported Wasm function table in Node
and Chromium. The `weighted` and `cross_weighted` C objects read `offset`
from a data-only fourth object;
both its direct table call and its Go assembly call return 13. The checked-in
Go assembly checks these return values in a Kandelo process on both hosts.
The `tls_weighted` C object increments an initialized `_Thread_local` value;
direct tests verify that separate Wasm instances over shared memory retain
distinct TLS bases, and the Go assembly process checks the same variable.
The function-pointer object checks a C function pointer initialized in DATA
and called indirectly from Go through C code.
The channel-base object checks the host writes a positive per-instance
`__channel_base` global before the Go process calls C code.
Stamp the exact
fresh output, then run the process and browser cases:

```sh
scripts/dev-shell.sh bash -c 'REPO_ROOT=$PWD; source scripts/build-programs-abi-stamp.sh; record_built_program_output .context/go-c-link-only/combined.wasm; stamp_built_program_outputs'
node --import tsx tests/go/cgo/link-only/run.ts .context/go-c-link-only/combined.wasm "$(scripts/resolve-binary.sh kernel.wasm)"
cd apps/browser-demos && KANDELO_GO_BROWSER_TESTS=1 KANDELO_GO_CGO_LINK_TESTS=1 npx playwright test test/go-port.spec.ts --project=chromium --grep 'Go calls linked C code with initialized data'
```

The assembly call is a narrow same-signature call, not `runtime/cgo` or the
standard Go-to-C adapter; it is not a substitute for either cgo probe above.

## RoadRunner feasibility probe

RoadRunner is a useful Go process/IPC integration test: its Go server starts
PHP workers as separate processes, while FrankenPHP embeds PHP through cgo,
which this Go/Wasm port does not yet support. It is not the WordPress
performance-demo target. A `CGO_ENABLED=0` RoadRunner
v2025.1.6 build is compatible with the current Go 1.25 toolchain version;
v2025.1.7 and later require Go 1.26. The feasibility check did not produce
or run a RoadRunner binary or a PHP worker. The full binary stops at
`github.com/valyala/fasthttp/tcplisten`, whose source files exclude
`GOOS=kandelo GOARCH=wasm`. A smaller RoadRunner server-core build proceeds
past `os/user` but needs `syscall.ForkLock`, process-group fields in
`syscall.SysProcAttr`, and child credentials. The subsequent fork revision
`98dc3f1` uses Kandelo's existing atomic spawn-time process-group attribute
and serializes spawn against non-atomic descriptor creation with
`syscall.ForkLock`. Explicit child credentials remain unsupported and return
`ENOSYS`; no-op success would be incorrect.

The default RoadRunner binary also pulls plugins and CLI paths unrelated to
the first HTTP/PHP-worker test. `roadrunner/build.sh` builds a minimal custom
entrypoint with the real server, HTTP, and logging plugins from pinned
upstream source. Its checked-in generic-listener adapter covers plain TCP;
it does not claim support for upstream's other listener options. The C
supervisor starts this server, sends one HTTP request, checks a real PHP CLI
worker's response, and reaps the server. The Node probe and opt-in Chromium
test pass through the normal kernel/VFS process path with matching ABI
digests and no host diagnostics. See `roadrunner/README.md` for commands
and scope. This is not yet a registry package, Composer SDK test, all-plugin
CLI, or full Go conformance. UDP, DNS, and TLS are not the first blockers.
