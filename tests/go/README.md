# Native Go browser probes

These probes run binaries from the `kandelo-port` branch of
[`kandelo-dev/go`](https://github.com/kandelo-dev/go/tree/kandelo-port) through
Kandelo's real Chromium process workers and ABI-48 kernel. Use fork commit
`3296d3f` or later, built with Go 1.25.6 as `GOROOT_BOOTSTRAP`. By default
the fork is checked out beside this repository as `../go-kandelo`.

From the Kandelo repository root:

```sh
./run.sh build kernel
scripts/dev-shell.sh bash tests/go/build-browser-fixtures.sh
scripts/dev-shell.sh bash -c 'cd apps/browser-demos && npm ci'
scripts/dev-shell.sh bash -c 'cd apps/browser-demos && KANDELO_GO_BROWSER_TESTS=1 npx playwright test test/go-port.spec.ts --project=chromium'
```

The fixture script writes sixteen Wasm programs for seventeen browser tests
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
syscalls, second-M bootstrap, five sequential clone handoffs, goroutines
running on two Ms, concurrent clone handoffs from those Ms, `LockOSThread`
affinity across yields and unlock, twelve paced locked-M exits and 64 unpaced
locked-M starts without an explicit unlock (exercising slot recycling),
sysmon-assisted cooperative preemption under `GOMAXPROCS=1`, IPv4 and IPv6
TCP loopback through Go `syscall`, runtime epoll readiness with a read
deadline and blocked-read close, `net.Dial`/`net.Listen` IPv4 and IPv6
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
and close-unblocks-read through the runtime poller. The `net` probe uses
`netFD` for IPv4/IPv6 `net.Listen` and `net.DialTimeout`; the HTTP probe runs
an actual Go server and client over loopback. The host uses a thread-specific
Wasm module without active data segments so adding an M cannot reinitialize
the running process's Go package state. UDP/message syscalls, DNS, TLS
certificate provisioning and broad Go conformance remain
unverified or unsupported. These focused probes do not establish full Go
runtime or POSIX conformance.
