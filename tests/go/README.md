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

The published package revision still fails at pointer-size recognition.
The adjacent fork's experimental cgo frontend (commit `2431313`) gets this
fixture to the linker. Fork commit `acc452f` discovers SDK libc through
`wasm32posix-cc`, so the normal build command above now reaches the explicit
per-thread TLS linking error. No cgo binary is emitted.

A compile-only pass will not establish working interoperability: run the
binary in Node and Chromium and add a C-to-Go callback probe before building
FrankenPHP. See the dated WordPress pivot in the Go implementation progress
log.

The separate `cgo/callback` fixture exercises Go-to-C-to-Go calls on the
calling thread and a C-created pthread entering Go:

```sh
scripts/dev-shell.sh bash -c 'GO111MODULE=off CGO_ENABLED=1 GOOS=kandelo GOARCH=wasm CC=wasm32posix-cc ../go-kandelo/bin/go build -o .context/cgo-callback-probe.wasm ./tests/go/cgo/callback'
```

It is a deliberately unpassed gate, not part of the passing Go suite. An
experimental `cmd/cgo` frontend in the adjacent fork parses the
Wasm debug object far enough for both fixtures to reach the Go linker. The
adjacent fork's internal linker now reads C function bodies, initialized C
data, active table elements, and the CODE relocations reached by runtime/cgo.
The full build stops at musl TLS relocations; neither fixture links or runs.
The `go-hello` package is still pinned to the earlier fork revision that
fails at pointer-size recognition. Do not use a successful cgo frontend or
function-body parse as PHP or FrankenPHP support.

The intermediate Go/C object-link test is reproducible with:

```sh
scripts/dev-shell.sh bash -c 'cd apps/browser-demos && npm ci'
scripts/dev-shell.sh bash tests/go/cgo/link-only/test-link.sh
```

It manually adds SDK C objects to a cgo-free Go archive and checks that the
final Go Wasm module validates, relocates a C-to-C call and C static data,
then executes both C functions through the exported Wasm function table in
Node and Chromium. The checked-in Go assembly also calls `weighted(5)` and
checks its return value in a Kandelo process on both hosts. Stamp the exact
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
