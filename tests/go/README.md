# Native Go browser probes

For package entry points and the current support matrix, see
[Go and FrankenPHP support](../../docs/go.md).

The fixture builders now select `GOOS=kandelo GOARCH=wasm32`. Build the
Go 1.28 development compiler pinned by `packages/registry/go-hello/build.toml`
on branch `kandelo-wasm32-prototype` of
[`kandelo-dev/go`](https://github.com/kandelo-dev/go/tree/kandelo-wasm32-prototype).
It requires a Go 1.26-or-newer bootstrap; the normal package build obtains
verified Go 1.26.10 source and builds that bootstrap with the declared host
Go. See `scripts/build-kandelo-go-toolchain.sh` for the reproducible route.

Set `GO_KANDELO_BIN` to the absolute compiler path inside the dev shell.
Builders retain `../go-kandelo/bin/go` as their default, but that checkout
may still be on the legacy branch. Check its version and branch before
using it. Do not change another checkout or discard its local artifacts
just to satisfy that default.

These probes use real Node/browser process workers. Their program ABI and
ABI-contract digest must match the selected kernel. Rebuild fixtures after
either changes instead of restamping old binaries. Historical results in
this guide describe the legacy compiler unless the implementation log
records a new-target run.

From the Kandelo repository root:

```sh
./run.sh setup
scripts/dev-shell.sh bash
# Inside that shell, select the built wasm32 compiler:
export GO_KANDELO_BIN=/absolute/path/to/go-wasm32/bin/go
bash tests/go/build-browser-fixtures.sh
exit
scripts/dev-shell.sh bash -c 'cd apps/browser-demos && npm ci'
scripts/dev-shell.sh bash -c 'cd apps/browser-demos && KANDELO_GO_BROWSER_TESTS=1 npx playwright test test/go-port.spec.ts --project=chromium --project=firefox --project=webkit'
```

The fixture script builds and stamps core Wasm programs in a fresh staging
directory, then publishes them under `.context/go-browser/`. Repeating it
after a kernel ABI-contract change replaces the old fixtures instead of
attempting to restamp stale Wasm. Set `GO_KANDELO_BIN` to an absolute path to use
another fork binary. Use
`KANDELO_PLAYWRIGHT_PORT` inside the last command if another workspace already
serves the default Playwright port.

The script stamps only the binaries it rebuilt with this checkout's
`kandelo.abi.contract` digest. The Node and three-browser probes require the
fixture digest to match the kernel, so run the fixture script rather than
building individual probes directly with `go build`.

The `wait-checkpoints` runtime fixture observes the private host-wait policy
and calls the target's runtime sleep and user-goroutine note wait directly.
Its note layout follows `runtime/note_other.go`. Its test-only
`-ldflags=-checklinkname=false` permits those private references; production
recipes keep normal linkname checking. Plain-Go and real cgo builds require
the host checkpoint to update the policy without shortening three 350 ms
sleeps. It checks zero, 25 ms and 350 ms note deadlines, an already-notified
note, timed and indefinite waits notified after 350 ms, and twelve races
between notification and entering the wait. Each note has one waiter and
one notifier, and is not cleared while either could still use it. The cgo
variant also executes a linked C scalar call. The normal browser inventory
runs both variants in each engine. This verifies producer integration,
deadlines and wakeups, not physical reclamation or an engine defect.

The plain-Go and cgo `netpoll-basic` probes hold socket deadlines, delayed
readiness, close wakeups and a blocking pipe read beyond the 100 ms host
checkpoint interval. The Node runner selects the offline egress link to
match the browser's guest network instead of enabling external TCP egress:

```sh
node --import tsx tests/go/wait-checkpoints/run.ts FIXTURE.wasm KERNEL.wasm
node --import tsx tests/go/netpoll-basic/run.ts FIXTURE.wasm KERNEL.wasm
```

The `memory-accounting` cgo fixture touches a 32 MiB C allocation and repeats
64 MiB Go allocation/collection cycles with a soft 32 MiB Go limit. It reports
Go heap, released-page and budget counters alongside C's direct Wasm memory
size. It requires dead objects to collect and subsequent allocations to reuse
bounded linear memory; it does not require that memory to shrink or infer
physical reclamation from `HeapReleased`. Run it separately in Node with:

```sh
scripts/dev-shell.sh bash tests/go/memory-accounting/build.sh
scripts/dev-shell.sh node --import tsx tests/go/memory-accounting/run.ts .context/go-memory-accounting/probe.wasm local-binaries/source-only-v1/kernel.wasm
```

The standard fixture builder and browser inventory include this probe too.

The real Caddy fixture and WordPress host fixture also accept
`KANDELO_FRANKENPHP_MEMORY_DIAGNOSTICS=1`. For the Caddy service, they enable
its ordinary guest-loopback admin listener and metrics in the test-owned
configuration. The shared `frankenphp/memory-metrics.ts` helper reads
upstream `/metrics` and `/frankenphp/threads` alongside the kernel's process,
linear-memory and module-cache counters. It records collection intervals
and raw responses; these are not atomic snapshots. No application patch or
forced collection is needed. See [Caddy metrics](https://caddyserver.com/docs/metrics)
and [FrankenPHP thread diagnostics](https://frankenphp.dev/docs/metrics/).

For WebKit inspector categories, additionally set `KANDELO_NATIVE_MEMORY_LOG`
to a private JSONL path and load `benchmarks/observe-webkit-memory.mjs` with
`NODE_OPTIONS=--import=/absolute/path/to/benchmarks/observe-webkit-memory.mjs`
inside the dev shell. This diagnostic uses the pinned Playwright driver's
private inspector connection. Its worker events count direct page workers;
nested pthread workers are not included. Inspector category sizes are not
process RSS. Align their UTC timestamps with the guest collection intervals,
and keep these instrumented runs separate from performance comparisons.
PHP's reported per-thread allocator usage excludes other C allocations;
Go Sys excludes C and engine allocations. Neither value bounds total RSS,
and Go's released-page count does not prove physical reclamation.

On macOS, `KANDELO_NATIVE_PROCESS_MEMORY=1` additionally captures phase-held
process RSS and `vmmap -summary` output. The adapter identifies XPC content
processes through the test browser app's own launchd PID domain; their
parent PID alone does not identify that ownership. These queries are
read-only and their collection intervals are recorded. Keep RSS, physical
footprint and inspector categories separate, and do not sum shared pages.

For a module-only control, set `KANDELO_WASM_MODULE_FOOTPRINT_INPUT` to the
exact normal program artifact and run `test/wasm-module-footprint.spec.ts`.
It streams the bytes, compiles once, and holds the resulting module in
one, four and eight additional workers. It never instantiates the module
or executes guest code. The eight phase windows record explicit ownership
changes; dropping references does not require physical reclamation within
their two-second observation windows. Run this separately from the real
service so each has a fresh browser parent.

The separate retirement fixture blocks a live Go guest in a pipe read,
then destroys the machine. It observes the host's drain progress to require
that the guest unwinds before forced worker termination. Both plain Go and
cgo builds exercise the same terminal channel marker as libc; this does
not establish Go's general signal-notification support.

```sh
scripts/dev-shell.sh bash tests/go/retirement/build.sh
scripts/dev-shell.sh bash -c 'node --import tsx tests/go/retirement/run.ts .context/go-retirement/pure.wasm "$(scripts/resolve-binary.sh kernel.wasm)"'
scripts/dev-shell.sh bash -c 'node --import tsx tests/go/retirement/run.ts .context/go-retirement/cgo.wasm "$(scripts/resolve-binary.sh kernel.wasm)"'
scripts/dev-shell.sh bash -c 'cd apps/browser-demos && KANDELO_GO_BROWSER_TESTS=1 npx playwright test test/go-retirement.spec.ts --project=chromium --project=firefox --project=webkit --workers=1'
```

The separate signal fixtures cover `Notify`, `Ignore`, a real default
`SIGQUIT` goroutine dump with exit 2, default `SIGTERM`
after `Reset`/`Stop`, C-pthread delivery, C handlers with signal info and
alternate stacks, mask restoration, 64-bit seek results, and graceful Go
HTTP shutdown. The blocked-wait case requires the existing host heap
safepoint import and preserves a pipe read across a 400 ms wait. This tests
producer integration and syscall completion, not a standalone GC diagnosis.
The cgo restart case waits for the actual blocked read,
sends a signal, and requires a second read dispatch before success.
The signal/GC case performs twelve blocked reads, triggers a collection
from another goroutine after each read is dispatched, then delivers a
signal and verifies the interrupted completion and notification. It does
not require or establish stack relocation.
The upstream `os/signal` binary also runs ten selected tests in each
browser/mode. This does not establish inherited blocked-mask management,
native signal-context unwinding, or complete Go signal conformance.

```sh
scripts/dev-shell.sh bash tests/go/signal-basic/build.sh
scripts/dev-shell.sh bash -c 'node --import tsx tests/go/signal-basic/run.ts .context/go-signals/cgo.wasm "$(scripts/resolve-binary.sh kernel.wasm)"'
scripts/dev-shell.sh bash -c 'node --import tsx tests/go/signal-basic/run-http-drain.ts .context/go-signals/cgo.wasm "$(scripts/resolve-binary.sh kernel.wasm)"'
scripts/dev-shell.sh bash -c 'node --import tsx tests/go/signal-basic/run-http-drain.ts .context/go-signals/cgo.wasm "$(scripts/resolve-binary.sh kernel.wasm)" restart'
scripts/dev-shell.sh bash -c 'node --import tsx tests/go/signal-basic/run-http-drain.ts .context/go-signals/cgo.wasm "$(scripts/resolve-binary.sh kernel.wasm)" signal-gc'
scripts/dev-shell.sh bash -c 'cd apps/browser-demos && KANDELO_GO_SIGNAL_TESTS=1 npx playwright test test/go-signals.spec.ts --workers=1'
```

To run the exec probe in Node after building the fixtures:

```sh
scripts/dev-shell.sh bash -c 'node --import tsx tests/go/exec-basic/run.ts .context/go-browser/exec-basic.wasm $(scripts/resolve-binary.sh kernel.wasm)'
scripts/dev-shell.sh bash -c 'node --import tsx tests/go/exec-basic/run-vfs.ts .context/go-browser/exec-basic.wasm $(scripts/resolve-binary.sh kernel.wasm)'
scripts/dev-shell.sh bash -c 'node --import tsx tests/go/os-stdlib/run-executable.ts .context/go-browser/os-test.wasm $(scripts/resolve-binary.sh kernel.wasm)'
```

The Node runners check direct byte launches expose a readable kernel-owned
executable object with a diagnostic ` (deleted)` name, VFS
launches report their selected path despite a forged `argv[0]`, and spawned
children retain that path. The upstream `TestExecutable` subprocess test also
passes from a VFS launch. The direct runner checks that both child launches
leave the parent's fork count at zero.

To run the `os/user` public API and selected upstream parser tests in Node:

```sh
scripts/dev-shell.sh bash -c 'node --import tsx tests/go/user-basic/run.ts .context/go-browser/user-basic.wasm $(scripts/resolve-binary.sh kernel.wasm)'
scripts/dev-shell.sh bash -c 'node --import tsx tests/go/user-basic/run.ts .context/go-browser/user-test.wasm $(scripts/resolve-binary.sh kernel.wasm) stdlib-tests'
```

These probes supply real `/etc/passwd` and `/etc/group` VFS files for the
public API check. Pass `stdlib-full` as the runner mode to run all 12
available pure-Go `os/user` top-level tests, including current user and group
lookup. This does not establish host account database integration.
The cgo-built `user-cgo-basic` fixture exercises the same account and group
operations with `CGO_ENABLED=1`; Kandelo deliberately retains Go's VFS-backed
lookup path rather than selecting the native-Unix cgo `struct passwd` path.

The fixture builder also compiles upstream `os`, `os/exec`, `archive/tar`, and
`syscall` test binaries.
The 60 selected upstream `os` cases cover stat, positioned reads, open
errors, directory batching/cleanup/seek, large and negative file seeks,
chmod, path/fd/symlink chown,
root-relative `MkdirAll`, recursive removal, symlink/rename, file read/write,
temporary paths, environment and error helpers, file metadata and truncation,
hard links, symlink loops, rename errors and overwrite, and root-relative
open/symlink/rename/remove-dot/DirFS containment. Two Unix-domain
socket subcases skip because AF_UNIX is not supported. The selected `syscall`
cases cover `ReadDirent` and `ParseDirent` across repeated buffers. Run their
Node VFS cases with:

```sh
scripts/dev-shell.sh bash -c 'node --import tsx tests/go/os-stdlib/run.ts .context/go-browser/os-test.wasm "$(scripts/resolve-binary.sh kernel.wasm)"'
scripts/dev-shell.sh bash -c 'node --import tsx tests/go/syscall-stdlib/run.ts .context/go-browser/syscall-test.wasm "$(scripts/resolve-binary.sh kernel.wasm)"'
```

The same selected cases are included in `go-port.spec.ts` for Chromium,
Firefox, and WebKit. They are not the full upstream `os` or `syscall` suites.
The Kandelo-specific `TestKandeloMmap` case in the Go fork's `syscall` test
binary exercises anonymous, private, and shared Go mappings plus `Msync`
writeback on Node and all three browser engines. Run it in Node with:

```sh
scripts/dev-shell.sh bash -c 'node --import tsx tests/go/syscall-stdlib/run.ts .context/go-browser/syscall-test.wasm "$(scripts/resolve-binary.sh kernel.wasm)" "^TestKandeloMmap$"'
```

The Go fork's `TestKandeloFlock` checks open-file-description lock
contention through the same runner. To include the direct Kandelo
`golang.org/x/sys` port in browser fixtures, set
`GO_KANDELO_XSYS_SOURCE_DIR` to an absolute checkout path when building
them. Run the resulting `xsys-unix-test.wasm` in Node with the syscall
runner and `^TestKandeloUnix`; set `KANDELO_XSYS_BROWSER_TESTS=1` alongside
`KANDELO_GO_BROWSER_TESTS=1` for the three-browser probes. These cover
descriptor duplication (shared offsets, independent close, close-on-exec
clearing and invalid-fd failure), mapped writeback, memory advice, lock
contention, access checks, and a
`SO_REUSEPORT` option round-trip. They do not prove duplicate-listener
behavior or database durability.

The direct bbolt, readline, logrus, and certificate-transparency-go
ports have opt-in package test fixtures. Create a Go workspace file
that lists the five local fork checkouts (`x/sys` plus those four
modules), then set its absolute path in
`GO_KANDELO_DEPENDENCY_WORKFILE` when running
`tests/go/build-browser-fixtures.sh`. Set
`KANDELO_GO_DEPENDENCY_BROWSER_TESTS=1` alongside
`KANDELO_GO_BROWSER_TESTS=1` to run their focused probes in Chromium,
Firefox, and WebKit. The tests check a bbolt VFS reopen, readline raw
mode on a PTY, logrus terminal detection, and certificate roots loaded
from a VFS file. They do not exercise Caddy's full runtime, PHP, or
WordPress.
After building the fixtures, run the same four cases on Node with:

```sh
scripts/dev-shell.sh bash -c 'node --import tsx tests/go/dependency-port/run.ts .context/go-browser "$(scripts/resolve-binary.sh kernel.wasm)"'
```

The `caddy` source package pins those forks for a real Caddy v2.10.2
build. After resolving it, run the Node static-HTTP smoke with
`tests/go/caddy/run.ts <caddy.wasm> <kernel.wasm>`. For the browser
smoke, pass the resolved program path as `KANDELO_CADDY_WASM` to
`test/caddy.spec.ts`. The fixture streams selected artifacts over test-owned
HTTP: the 104 MB binary exceeds Chromium's debugging-pipe limit when
base64-encoded by route fulfillment, and arbitrary cache paths are
intentionally forbidden by Vite. Revision 4 serves its VFS file in Node,
Chromium, Firefox, and WebKit. The next revision follows the new signal
runtime and must be rebuilt and retested separately.

The VFS-backed `run-full-vfs.ts` runner supplies Go source/testdata, account
files, `/bin/pwd`, and a non-root CWD. With `-test.run=^Test`, the available
upstream `os` suite passes 213 top-level tests in Node when excluding the two
deep-path cases on the default macOS host-backed `/tmp`. The full 215-case
suite passes with image-backed `/tmp` via `KANDELO_GO_IMAGE_TMP=1`. The
available
`syscall` suite passes five top-level tests in Node. The same VFS runner can
run the upstream `sync` test binary, an `os/exec` short sweep, and all 44
`archive/tar` tests by selecting the appropriate source package. Browser
probes exercise the full
short `sync` suite: a clean combined Chromium/Firefox/WebKit rerun passes 3/3
after an earlier WebKit timeout during `TestMutexMisuse` and a successful
isolated retry. The `os/exec` short Node sweep passes 28 top-level tests,
skips three due to absent helper programs/short mode, and excludes five
signal/concurrency tests; two of those excluded tests pass in a separate
run. A VFS-backed six-test `os/exec` process/lookup probe passes 3/3 across
Chromium, Firefox, and WebKit with serialized test parallelism. This is not
full conformance.
The full Node `TestRoot*` sweep passes all 47 top-level tests, including
the Unix-only ownership cases, `TestRootChtimes`, `TestRootLinkFrom`, and
`TestRootRenameAfterOpen`, with
documented AF_UNIX subcase skips. Run it with
`KANDELO_GO_TEST_TIMEOUT_MS=300000` and `-test.run=^TestRoot` as the third
argument to `os-stdlib/run.ts`. The complete sweep passes as one probe in
Chromium, Firefox, and WebKit after staging the three `testdata/dirfs`
fixtures into each browser VFS.
The expanded `os.Root`, five Unix-only `os/exec`, complete `archive/tar`, and
deep-path `os.Getwd` probes pass 12/12 across Chromium, Firefox, and WebKit
using fresh ABI-stamped fixtures. Browser SharedFS reaches the advertised
path limit; the default Node/macOS scratch mount encounters its native
1,024-byte absolute-path limit first. Set `KANDELO_GO_IMAGE_TMP=1` on the
VFS runner to isolate Go behavior from that host-filesystem limitation.
The `browser-basic` program additionally checks fixed nanosecond atime and
mtime through the real `os.Chtimes`/stat syscall path on each browser's
SharedFS-backed `/tmp`.
The selected `os` fixture still runs through a direct byte launch, so it does
not include `TestExecutable`. A separate Node runner and browser probe launch
that fixture from `/bin/os-test.wasm` and pass upstream `TestExecutable` in
Node, Chromium, Firefox, and WebKit. `/proc/self/exe` uses a kernel-owned
selected VFS path, not `argv[0]`. A direct byte launch now retains a readable
anonymous executable object whose diagnostic name carries ` (deleted)`.

The builder also links `one-slot-second-m.wasm` with
`-ldflags=-kandelothreadslots=1`. Go can request an additional M before
`main`; the one-slot fixture must fail visibly with the host's
`pthread slot limit exhausted (limit=1` diagnostic and the Go runtime's
`newosproc: kernel_clone failed` message, rather than hang or overrun its
declared control arena. Run the Node boundary check with:

```sh
scripts/dev-shell.sh bash -c 'node --import tsx tests/go/slot-limit/run.ts .context/go-browser/one-slot-second-m.wasm "$(scripts/resolve-binary.sh kernel.wasm)"'
```

The same negative boundary is exercised in Chromium, Firefox, and WebKit.
It does not prove every configured slot count or long-lived slot reuse.

For an opt-in higher-count probe, the fixture builder also links
`slot-pressure.wasm` with `-ldflags=-kandelothreadslots=64`. It holds 48
distinct locked Go Ms live at once, then releases them and checks for a clean
exit and teardown. Run it in Node and all three browsers with:

```sh
scripts/dev-shell.sh bash -c 'node --import tsx tests/go/scheduler/slot-pressure/run.ts .context/go-browser/slot-pressure.wasm "$(scripts/resolve-binary.sh kernel.wasm)"'
scripts/dev-shell.sh bash -c 'cd apps/browser-demos && KANDELO_GO_BROWSER_TESTS=1 KANDELO_GO_HIGH_THREAD_TESTS=1 WASM_POSIX_RESOLUTION_POLICY=source-only-v1 WASM_POSIX_SOURCE_ONLY_BINARY_ROOT="$(realpath ../../local-binaries/source-only-v1)" npx playwright test test/go-port.spec.ts --project=chromium --project=firefox --project=webkit --grep "48 concurrent locked Go threads" --workers=1'
```

The selected Go 1.28 development wasm32 compiler at `f6053060` passes
48 locked workers over five retirement waves with both the 64-slot and
1,024-slot fixtures. Both fresh Node parents exit zero with empty stderr
and diagnostics; all six Chromium/Firefox/WebKit cases pass without skips
or flakes. The fixtures match the fresh compiler gate's recorded hashes.
This rerun uses the isolated general TCP correction's ABI-55 kernel
`741aa821cccd` and compiled host. It establishes bounded thread retirement
and slot reuse, not long-lived PHP allocator behavior or physical memory
reclamation. The 256/512-worker results below are historical Go 1.25
evidence and have not been repeated with this compiler.

The browser probe caught serialized 250 ms per-thread teardown exceeding the
kernel-worker's two-second graceful-detach deadline; thread terminations now
settle concurrently. A separate `slot-pressure-1024.wasm` fixture declares
the maximum 1,024 slots (256 MiB of slot pages). Its live locked-M count is
selectable from 1 to 1,023; the default 48 passes in Node, Chromium, Firefox,
and WebKit. A fresh 256-worker run passes in Node, Chromium, Firefox, and
WebKit; 512 workers pass in Node. The main M also occupies a slot, so 1,023
workers is the upper bound for this fixture. Run the
larger probe with the count after the kernel path in the Node command, or set
`KANDELO_GO_MAX_THREAD_SLOTS_TESTS=1` and
`KANDELO_GO_LIVE_THREAD_COUNT=256` for its opt-in browser test. These runs do
not yet prove 1,024 simultaneously live Ms, long-lived PHP churn, or allocator
pressure. The 512-worker Node run reached a 30.4 GB peak memory footprint on
a 36 GB host, so attempting 1,023 workers there would risk exhausting the
machine; completing that scale gate needs lower per-worker overhead or a
larger test host.

An optional second argument selects 1–50 waves. For multiple waves, each
locked goroutine exits without unlocking its thread so the runtime retires
that M before the next wave. Five waves of 48 workers pass in Node and all
three browsers with both the 64-slot and 1,024-slot fixtures. Because 240
worker Ms exceed 64 slots, the smaller fixture also exercises slot reclaim.
Set `KANDELO_GO_HIGH_THREAD_ROUNDS=5` or
`KANDELO_GO_LIVE_THREAD_ROUNDS=5` for the respective browser test. This
checks bounded Go-thread retirement, not long-lived PHP worker or allocator
behavior.

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
scripts/dev-shell.sh bash -c 'cd apps/browser-demos && KANDELO_GO_PACKAGE_TESTS=1 npx playwright test test/go-package.spec.ts --project=chromium --project=firefox --project=webkit'
```

The Node and three-browser tests load the *resolved* `go-hello.wasm`, put its exact
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
netpoll probe rejects regular-file deadlines with `os.ErrNoDeadline`,
preserving blocking file reads, in plain-Go and cgo variants. It also wraps a
nonblocking TCP socket in `os.NewFile` to exercise deadline expiry, data readiness,
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
scripts/dev-shell.sh bash -c 'CGO_ENABLED=1 GOOS=kandelo GOARCH=wasm32 CC=wasm32posix-cc "${GO_KANDELO_BIN:-../go-kandelo/bin/go}" build -o .context/cgo-probe.wasm tests/go/cgo/main.go'
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
The `php-zts` package builds a static ZTS embed library with OPcache linked
into it. The `tests/go/cgo/php-embed` probe executes PHP initialization, a
script string, and shutdown. Its opt-in `opcache` mode checks that the static
Zend extension and its configuration API register inside the Go cgo
executable. The earlier side-module `dlopen` gate applied to revision 6;
the current revision 8 has no `opcache-zts.so` output. Registration alone
does not prove acceleration or request-level behavior.

The `frankenphp-classic` package is a separate request-level gate. Its
resolver-built revision-35 binary serves PHP and static HTTP on Node,
Chromium, Firefox and WebKit using unchanged upstream FrankenPHP source.
The shared `frankenphp/request-lifetime.ts` verifier sends 32 requests,
four concurrently, checking nine exact CGI/body fields with 8 KiB query
and body payloads. Callers enable Go collection tracing, require a collection
during the request phase and await exit 0 after SIGTERM before destroying
the host. This does not by itself prove WordPress or long uptime:

```sh
scripts/dev-shell.sh bash .agents/skills/porting-software-to-kandelo/scripts/build-package.sh frankenphp-classic wasm32
scripts/dev-shell.sh bash -c 'prefix=$(cargo xtask build-deps --arch wasm32 resolve frankenphp-classic); npx tsx packages/registry/frankenphp-classic/test/run.ts "$prefix/frankenphp-classic.wasm" "$(scripts/resolve-binary.sh kernel.wasm)"'
scripts/dev-shell.sh bash -c 'cd apps/browser-demos && KANDELO_FRANKENPHP_CLASSIC_WASM="$(cd ../.. && cargo xtask build-deps --arch wasm32 resolve frankenphp-classic)/frankenphp-classic.wasm" npx playwright test test/frankenphp-classic.spec.ts --project=chromium --project=firefox --project=webkit --workers=1'
```

The real Caddy package has a matching Node gate, including the shared
concurrent lifetime/GC verifier and awaited normal exit:

```sh
scripts/dev-shell.sh bash -c 'node --import tsx packages/registry/frankenphp-caddy/test/run.ts "$(scripts/resolve-binary.sh programs/wasm32/frankenphp-caddy.wasm)" "$(scripts/resolve-binary.sh kernel.wasm)"'
```

The classic SAPI test checks static OPcache registration, compiles a PHP
file, and checks that file-cache-only mode wrote its cache file. The
WordPress browser-host test makes the same request-level check for classic
and Caddy with the revision-31 VFS image. Both gates have run on the current
package revisions in Node and Chromium; visible WordPress editor JavaScript
remains a separate app gate.

```sh
scripts/dev-shell.sh bash tests/go/cgo/php-embed/build.sh
scripts/dev-shell.sh bash -c 'node --import tsx tests/go/cgo/php-embed/run.ts .context/go-php-embed/probe-instrumented.wasm "$(scripts/resolve-binary.sh kernel.wasm)"'
scripts/dev-shell.sh bash -c 'node --import tsx tests/go/cgo/php-embed/run.ts .context/go-php-embed/probe-instrumented.wasm "$(scripts/resolve-binary.sh kernel.wasm)" --opcache'
scripts/dev-shell.sh bash -c 'cd apps/browser-demos && KANDELO_GO_BROWSER_TESTS=1 KANDELO_GO_CGO_RUNTIME_TESTS=1 npx playwright test test/go-port.spec.ts --project=chromium --grep "PHP ZTS embed"'
scripts/dev-shell.sh bash -c 'cd apps/browser-demos && KANDELO_GO_BROWSER_TESTS=1 KANDELO_GO_CGO_RUNTIME_TESTS=1 npx playwright test test/go-port.spec.ts --project=chromium --project=firefox --project=webkit --workers=1 --grep "PHP ZTS static OPcache registers"'
```

```sh
scripts/dev-shell.sh bash -c 'GO111MODULE=off CGO_ENABLED=1 GOOS=kandelo GOARCH=wasm32 CC=wasm32posix-cc "${GO_KANDELO_BIN:-../go-kandelo/bin/go}" build -a -o .context/go-c-abs.wasm ./tests/go/cgo && wasm-validate --enable-threads .context/go-c-abs.wasm'
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

The `cgo/c-exports` fixture tests the internal linker's explicit C export
contract. It pulls an otherwise-unused function and data symbol from a
declared archive, exports both, and loads a fork-instrumented C side module
that imports them through `dlopen`. It also checks that a requested missing
symbol fails the link. Run its Node and three-browser gates with:

```sh
scripts/dev-shell.sh bash tests/go/cgo/c-exports/build.sh
scripts/dev-shell.sh node --import tsx tests/go/cgo/c-exports/run.ts .context/go-c-exports/probe-instrumented.wasm .context/go-c-exports/libprobe.so "$(scripts/resolve-binary.sh kernel.wasm)"
scripts/dev-shell.sh bash -c 'cd apps/browser-demos && KANDELO_PLAYWRIGHT_PORT=5539 KANDELO_GO_BROWSER_TESTS=1 KANDELO_GO_CGO_RUNTIME_TESTS=1 npx playwright test test/go-port.spec.ts --project=chromium --project=firefox --project=webkit --workers=1 --grep "Go cgo exports archive symbols"'
```

Declare C archive paths in `#cgo LDFLAGS`; pass requested export names via
Go's `-ldflags` `-extldflags` value, as the fixture does. Do not put the
export requests in `CGO_LDFLAGS`: that can select unsupported external
linking. `-ldl` selects the SDK's real Wasm dynamic-loader glue. This small
probe does not prove PHP ZTS embedding or static OPcache request behavior.

`cgo/mixed-struct` checks a C struct containing a pointer and a fixed
pointer array, returned from C and passed back by value. On the current
Kandelo/wasm32 target,
generated fields use ordinary four-byte Go pointers matching the C ABI.
The legacy mixed-width target represented them as `uint32` instead. It
also checks a packed 14-byte struct with an unaligned pointer
and 64-bit integer, returned from C and passed back by value. A bulk call
passes 24 consecutive 12-byte pointer-bearing structs, with ordinary pointer
arguments before and after them, and verifies every field and C pointee.
The bulk test uses C-owned storage; it does not establish lifetime safety
for Go-backed strings. The actual FrankenPHP lifetime checks described
above cover that separate boundary with typed Go roots and observed GC.
Build,
instrument, stamp, and run this focused probe with:

```sh
scripts/dev-shell.sh bash -c 'GO111MODULE=off CGO_ENABLED=1 GOOS=kandelo GOARCH=wasm32 CC=wasm32posix-cc "${GO_KANDELO_BIN:-../go-kandelo/bin/go}" build -o .context/go-cgo-mixed-struct.wasm ./tests/go/cgo/mixed-struct'
scripts/dev-shell.sh bash -c 'scripts/run-wasm-fork-instrument.sh .context/go-cgo-mixed-struct.wasm -o .context/go-cgo-mixed-struct-instrumented.wasm; REPO_ROOT=$PWD; source scripts/build-programs-abi-stamp.sh; record_built_program_output .context/go-cgo-mixed-struct-instrumented.wasm; stamp_built_program_outputs'
scripts/dev-shell.sh bash -c 'node --import tsx tests/go/cgo/mixed-struct/run.ts .context/go-cgo-mixed-struct-instrumented.wasm "$(scripts/resolve-binary.sh kernel.wasm)"'
scripts/dev-shell.sh bash -c 'cd apps/browser-demos && KANDELO_GO_BROWSER_TESTS=1 KANDELO_GO_CGO_RUNTIME_TESTS=1 WASM_POSIX_RESOLUTION_POLICY=source-only-v1 WASM_POSIX_SOURCE_ONLY_BINARY_ROOT="$(realpath ../../local-binaries/source-only-v1)" npx playwright test test/go-port.spec.ts --project=chromium --project=firefox --project=webkit --grep "mixed-width C pointer struct" --workers=1'
```

```sh
scripts/dev-shell.sh bash -c 'GO111MODULE=off CGO_ENABLED=1 GOOS=kandelo GOARCH=wasm32 CC=wasm32posix-cc "${GO_KANDELO_BIN:-../go-kandelo/bin/go}" build -a -o .context/go-callback-same.wasm ./tests/go/cgo/callback-same'
scripts/dev-shell.sh bash -c 'scripts/run-wasm-fork-instrument.sh .context/go-callback-same.wasm -o .context/go-callback-same-instrumented.wasm'
scripts/dev-shell.sh bash -c 'REPO_ROOT=$PWD; source scripts/build-programs-abi-stamp.sh; record_built_program_output .context/go-callback-same-instrumented.wasm; stamp_built_program_outputs'
node --import tsx tests/go/cgo/callback-same/run.ts .context/go-callback-same-instrumented.wasm "$(scripts/resolve-binary.sh kernel.wasm)"
cd apps/browser-demos && KANDELO_GO_BROWSER_TESTS=1 KANDELO_GO_CGO_RUNTIME_TESTS=1 npx playwright test test/go-port.spec.ts --project=chromium --grep 'Go-owned M cgo callback'
```

The `cgo/constructors` fixture verifies standard Wasm C constructor
metadata, priority order, a metadata-only `.init_array.150` segment, and C
destructor registration. Its ordinary mode calls musl's exit-handler
dispatcher explicitly. Its `c-exit` mode enters C `exit(0)` and checks that
the registered handler runs on Node and all three browser engines. Its
`c-immediate-exit` mode enters C `_exit(0)` and verifies that the handler
does not run. Its `go-return` and
`go-os-exit` modes arm the same handler and verify that Go's process-wide
`exit_group` path does not dispatch it. This matches the fork's Linux-style
runtime exit path, but not macOS native Go/cgo shutdown behavior. The linker
still rejects
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
scripts/dev-shell.sh bash -c 'GO111MODULE=off CGO_ENABLED=1 GOOS=kandelo GOARCH=wasm32 CC=wasm32posix-cc "${GO_KANDELO_BIN:-../go-kandelo/bin/go}" build -a -o .context/go-cgo-secure-exec.wasm ./tests/go/cgo/secure-exec'
scripts/dev-shell.sh bash -c 'scripts/run-wasm-fork-instrument.sh .context/go-cgo-secure-exec.wasm -o .context/go-cgo-secure-exec-instrumented.wasm; REPO_ROOT=$PWD; source scripts/build-programs-abi-stamp.sh; record_built_program_output .context/go-cgo-secure-exec-instrumented.wasm; stamp_built_program_outputs'
scripts/dev-shell.sh bash -c 'cd host && ./node_modules/.bin/vitest run test/secure-exec.test.ts -t "Go/cgo child"'
cd apps/browser-demos && WASM_POSIX_RESOLUTION_POLICY=source-only-v1 WASM_POSIX_SOURCE_ONLY_BINARY_ROOT="$(cd ../.. && pwd)/local-binaries/source-only-v1" KANDELO_GO_CGO_RUNTIME_TESTS=1 ./node_modules/.bin/playwright test test/secure-exec-startup.spec.ts --project=chromium --grep 'Go/cgo child'
```

```sh
scripts/dev-shell.sh bash -c 'GO111MODULE=off CGO_ENABLED=1 GOOS=kandelo GOARCH=wasm32 CC=wasm32posix-cc "${GO_KANDELO_BIN:-../go-kandelo/bin/go}" build -a -o .context/go-constructors.wasm ./tests/go/cgo/constructors && wasm-validate --enable-threads .context/go-constructors.wasm'
scripts/dev-shell.sh bash -c 'scripts/run-wasm-fork-instrument.sh .context/go-constructors.wasm -o .context/go-constructors-instrumented.wasm'
scripts/dev-shell.sh bash -c 'REPO_ROOT=$PWD; source scripts/build-programs-abi-stamp.sh; record_built_program_output .context/go-constructors-instrumented.wasm; stamp_built_program_outputs'
node --import tsx tests/go/cgo/constructors/run.ts .context/go-constructors-instrumented.wasm "$(scripts/resolve-binary.sh kernel.wasm)"
node --import tsx tests/go/cgo/constructors/run.ts .context/go-constructors-instrumented.wasm "$(scripts/resolve-binary.sh kernel.wasm)" c-exit
node --import tsx tests/go/cgo/constructors/run.ts .context/go-constructors-instrumented.wasm "$(scripts/resolve-binary.sh kernel.wasm)" c-immediate-exit
node --import tsx tests/go/cgo/constructors/run.ts .context/go-constructors-instrumented.wasm "$(scripts/resolve-binary.sh kernel.wasm)" go-return
node --import tsx tests/go/cgo/constructors/run.ts .context/go-constructors-instrumented.wasm "$(scripts/resolve-binary.sh kernel.wasm)" go-os-exit
cd apps/browser-demos && KANDELO_GO_BROWSER_TESTS=1 KANDELO_GO_CGO_RUNTIME_TESTS=1 npx playwright test test/go-port.spec.ts --project=chromium --project=firefox --project=webkit --grep 'C constructors|C exit dispatches|C _exit|bypasses C exit'
```

The separate `cgo/callback` fixture exercises Go-to-C-to-Go calls on the
calling thread and a C-created pthread entering Go. It checks a mixed
scalar/pointer callback frame and forces stack growth in the foreign callback:

```sh
scripts/dev-shell.sh bash -c 'GO111MODULE=off CGO_ENABLED=1 GOOS=kandelo GOARCH=wasm32 CC=wasm32posix-cc "${GO_KANDELO_BIN:-../go-kandelo/bin/go}" build -o .context/cgo-callback-probe.wasm ./tests/go/cgo/callback'
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
`stub_wasm32.s` uses four-byte ABI0 values and direct C table handles;
it does not shift legacy logical PCs. It checks the return values in a
Kandelo process on both hosts. The independent direct-object controls reject
any unexpected host-function call instead of returning a synthetic result.
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

## Isolated 32-bit Go/Wasm prototype

The `kandelo-wasm32-prototype` branch of `kandelo-dev/go` ports Kandelo's
runtime onto upstream's Go 1.28 development `wasm32` review stack. It is
the compiler selected by all four current Go package recipes. An adjacent
`../go-kandelo` checkout can still contain legacy Go 1.25.6; inspect it
before using that fallback path. The
implementation log records its exact base and checkpoint revision. Build
that compiler with the verified Go 1.26.10 bootstrap described there; a
Go 1.25 bootstrap is too old for this source tree.

The new architecture uses four-byte Go pointers and integers, with
upstream's eight-byte registers, stack alignment and continuation slots.
The prototype passes focused plain-Go/cgo tests. Unadapted FrankenPHP
Go/C source now links and runs normally: classic HTTP, bulk CGI/GC string
checks and normal shutdown pass on Node and all three browsers. Real
FrankenPHP+Caddy links; Caddy's JSON-alias compatibility upgrade and
request proof remain pending. The complete 255-case browser compiler gate
has one WebKit native-stack failure in unchanged regexp compilation;
upstream WASI controls reproduce it. A replacement WordPress image and
production preview remain separate gates.

Run its separate fixture inventory without replacing `.context/go-browser`:

```sh
scripts/dev-shell.sh bash -c 'export GO_KANDELO_BIN=/absolute/path/to/prototype/bin/go; bash tests/go/wasm32-prototype/build.sh'
scripts/dev-shell.sh node --import tsx tests/go/wasm32-prototype/run.ts
scripts/dev-shell.sh bash -c 'cd apps/browser-demos && KANDELO_PLAYWRIGHT_PORT=5461 KANDELO_GO_WASM32_TESTS=1 npx playwright test test/go-wasm32.spec.ts --project=chromium --project=firefox --project=webkit --workers=1'
```

The runtime probe checks real target layout, interior GC roots, escaping
pointer-field addresses, reflection and function PCs, closures/interfaces,
stack growth, panic/recover, goroutine communication, concurrent locked
kernel threads and pointer/32-bit/64-bit atomic operations. It checks the
adjacent word to detect an eight-byte pointer store on this four-byte
target. Its explicit `runtime.GC` calls test root retention, not physical
memory reclamation. The second probe reuses the existing startup/VFS,
nanosecond timestamp, randomness and clock checks. These bounded tests do
not establish general Go conformance or application performance.

Enable the cgo cases during both fixture construction and execution:

```sh
scripts/dev-shell.sh bash -c 'export GO_KANDELO_BIN=/absolute/path/to/prototype/bin/go; KANDELO_GO_WASM32_CGO_TESTS=1 bash tests/go/wasm32-prototype/build.sh'
scripts/dev-shell.sh bash -c 'KANDELO_GO_WASM32_CGO_TESTS=1 node --import tsx tests/go/wasm32-prototype/run.ts'
scripts/dev-shell.sh bash -c 'cd apps/browser-demos && KANDELO_PLAYWRIGHT_PORT=5461 KANDELO_GO_WASM32_TESTS=1 KANDELO_GO_WASM32_CGO_TESTS=1 npx playwright test test/go-wasm32.spec.ts --project=chromium --project=firefox --project=webkit --workers=1'
```

This adds scalar/pointer calls and per-M C TLS, typed pointer-bearing C
structs passed by value, escaping C-field addresses retaining Go roots,
errno returns, C function pointers, callbacks from Go-owned and C-created
threads, callback stack growth and repeated concurrent callback/GC churn.
The typed fixture also requires an unused C function's unresolved call to
stay out of the live link. It does not suppress unresolved live symbols.
The resulting inventory contains seven Node cases and 21 browser cases.
The fixture manifest records the compiler version, source revision/dirty
status and six program hashes. Keep it with the raw results when claiming
a particular prototype checkpoint passed.
