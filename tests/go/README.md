# Native Go browser probes

These probes run binaries from the `kandelo-port` branch of
[`kandelo-dev/go`](https://github.com/kandelo-dev/go/tree/kandelo-port) through
Kandelo's real Chromium process workers and ABI-48 kernel. Use fork commit
`022ee37` or later, built with Go 1.25.6 as `GOROOT_BOOTSTRAP`. By default
the fork is checked out beside this repository as `../go-kandelo`.

From the Kandelo repository root:

```sh
./run.sh build kernel
scripts/dev-shell.sh bash tests/go/build-browser-fixtures.sh
scripts/dev-shell.sh bash -c 'cd apps/browser-demos && npm ci'
scripts/dev-shell.sh bash -c 'cd apps/browser-demos && KANDELO_GO_BROWSER_TESTS=1 npx playwright test test/go-port.spec.ts --project=chromium'
```

The fixture script writes nine Wasm programs under `.context/go-browser/`. Set
`GO_KANDELO_BIN` to an absolute path to use another fork binary. Use
`KANDELO_PLAYWRIGHT_PORT` inside the last command if another workspace already
serves the default Playwright port.

The browser tests cover startup arguments/environment, clock and file
syscalls, second-M bootstrap, five sequential clone handoffs, goroutines
running on two Ms, concurrent clone handoffs from those Ms, `LockOSThread`
affinity across yields and unlock, twelve locked-M exits without an explicit
unlock (requiring thread-slot recycling beyond the eight-slot arena),
sysmon-assisted cooperative preemption under `GOMAXPROCS=1`, and process-wide
exit from a worker M. Each test requires exit 0, expected output,
and no host diagnostics or browser errors. They are
opt-in because the external Go fork is not provisioned by the normal browser
suite; without `KANDELO_GO_BROWSER_TESTS=1`, Playwright reports them as skipped.
These focused probes do not establish full Go runtime or POSIX conformance.
