# Go and FrankenPHP support

Kandelo has an experimental `GOOS=kandelo GOARCH=wasm` port of Go's native
compiler and runtime. The compiler runs on the development machine and
produces a Wasm program for Kandelo. Cgo integrates C/C++ compiled with the
Kandelo SDK into that Go program.

The fork is based on Go 1.25.6. Use the immutable `go_toolchain` revision in
the [Go package recipe](../packages/registry/go-hello/build.toml), together
with this checkout's SDK and kernel. The
[implementation checkpoint](plans/2026-09-05-go-gc-port-milestone1-plan.md)
records current validation and release gates. This port does not establish
complete upstream Go conformance or production readiness.

## Building packages

The [go-hello recipe](../packages/registry/go-hello/build-go-hello.sh) is the
smallest package example. The resolver supplies verified Go source, the
recipe builds the native compiler in its private work directory, and the
normal installer records the program's ABI contract and package identity.
Keep that path for maintained packages; rebuilding only a Wasm file does not
update its package or VFS image.

The SDK's `wasm32posix-go` convenience command takes an absolute
`KANDELO_GO_ROOT` pointing to a built fork. It currently selects pure Go
with `CGO_ENABLED=0`. Cgo recipes invoke the fork's `bin/go` directly with
`GOOS=kandelo`, `GOARCH=wasm`, `CGO_ENABLED=1`, and
`CC=wasm32posix-cc` inside the declared dev shell. See the
[FrankenPHP recipe](../packages/registry/frankenphp-caddy/build-frankenphp-caddy.sh)
for the complete dependency, compilation, instrumentation, and installation
steps. The native compiler is not bundled into the browser image.

Go modules with OS-specific implementations may need a maintained Kandelo
target. Existing direct ports include `golang.org/x/sys`, bbolt, readline,
logrus, and certificate-transparency-go. Their immutable revisions are in
the [consumer's build manifest](../packages/registry/frankenphp-caddy/build.toml).
Use the platform APIs and add target implementations in those libraries;
keep missing kernel or libc behavior visible as a platform gap.

## Coverage and boundaries

The [probe guide](../tests/go/README.md) provides reproducible Node and
Chromium/Firefox/WebKit commands. Its selected suites cover these areas:

| Area | Current coverage |
| --- | --- |
| Runtime | Goroutines, allocation/GC, multiple runtime threads, thread retirement, and shared-memory startup. The validated default is `GOMAXPROCS=1`. |
| Files and processes | VFS I/O, permissions, executable identity, environment, account-file lookup, child spawning, and waiting. Go `os/exec` uses non-forking `SYS_SPAWN`. |
| Networking | Kandelo socket transport, Go HTTP fixtures, and real server consumers. |
| Cgo | Scalar/pointer and aggregate calls, callbacks from Go-owned and C-created threads, C TLS, and C constructor registration. |
| Signals | Cooperative notifications, C handler interoperability, restart behavior, fatal Go diagnostics, and small Go HTTP shutdown fixtures. |

These checks have specific scopes. The full application image needs its own
editor, shutdown, recovery, traffic, and memory validation.

Known gaps include requested child credentials, inherited blocked-mask
management, host-backed deep paths and native no-follow helper distribution,
additional C initializer/finalizer forms, and wider runtime/conformance
coverage. Native signal-context unwinding and asynchronous preemption are
not implemented. Mapping APIs retain the kernel's documented partial shared
mapping/writeback semantics; see [POSIX status](posix-status.md).

Memory reuse and host reclamation are separate boundaries. The target's
idle-page scavenging hook currently does no platform work, and kernel
`madvise` does not discard backing pages. A smaller live Go heap does not
establish smaller linear memory or native footprint. Go's
[`GOMEMLIMIT`](https://pkg.go.dev/runtime/debug#SetMemoryLimit) is a soft
runtime budget; it excludes embedded PHP allocations and browser-engine
memory. Whole-service memory accounting and sustained reclamation checks
remain release work.

The WordPress demo sizes both embedded-PHP services at two PHP threads.
`/etc/dinit.d/env-frankenphp` controls their shared
`FRANKENPHP_NUM_THREADS` setting; Caddy reads it through its standard
configuration substitution. The larger six-thread WebKit workload can
exceed the content-process memory limit despite a much smaller guest heap.
Native module/worker costs therefore remain part of service sizing and
cannot be capped by `GOMEMLIMIT` alone. Final validation of the new image
default is recorded in the implementation log.

The allocation/reuse fixture makes this distinction observable. With a soft
32 MiB Go limit, Node holds a touched 32 MiB C allocation and a 64 MiB Go
live set. After Go collection/scavenging, `HeapReleased` rises to about
67 MiB and Go's accounted budget falls to about 19 MiB, while linear memory
stays at about 141 MiB. Three subsequent 64 MiB allocations reuse that same
linear size. This demonstrates reuse and the limits of Go's counters; it
does not measure physical page reclamation. The fixture also passes in
Chromium, Firefox and WebKit. See `tests/go/memory-accounting` and the
implementation log for the exact run scope.

Go values and C addresses have different widths in this target. Raw C
address fields are not Go-managed pointers; use typed C accessors for layouts
that cross this boundary. Go main return and `os.Exit` bypass registered C
exit handlers; explicit C `exit` runs them and C `_exit` bypasses them.
The [runtime and cgo guide](agent-guidance/go-runtime.md) describes the exact
contracts and their tests.

## FrankenPHP and WordPress

The WordPress image declares `wordpress-frankenphp` and
`wordpress-frankenphp-caddy` profiles. Both execute thread-safe embedded PHP
inside FrankenPHP. The Caddy profile uses Caddy's HTTP routing; the classic
profile uses a smaller Go HTTP entry point. The same image also provides
nginx/PHP-FPM for comparison.

The generated services allow 30 seconds before forced termination. Classic
HTTP shutdown and Caddy's configured grace period allow 20 seconds to drain
requests before PHP cleanup. Actual request-draining validation on the final
image passes in Node, Chromium, and Firefox. Heavy WebKit workloads have
reloaded after the content process exceeded its memory limit. Intermittent
Node machine retirement also remains under investigation. The implementation
checkpoint records these open release gates and each test's exact scope.

These profiles use the classic PHP request lifecycle and file-cache-only
OPcache. They do not provide a persistent WordPress PHP worker or a full-page
cache. The [paired stack benchmark](../benchmarks/wordpress-stack.ts) measures
startup, warm and parallel requests, and optional sustained traffic/RSS on
Node and Chromium using the same image. Keep image identity, cache settings,
worker counts, and background load with the result. Current release gates
and measured outcomes belong in the implementation checkpoint linked above.
