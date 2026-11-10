# Kernel Examples

C programs demonstrating Kandelo kernel and SDK capabilities. Each can be
compiled with the SDK and run on the TypeScript host.

Package-specific demo launchers live under each package's
`packages/registry/<name>/demo/` directory. Package integration test harnesses
live under `packages/registry/<name>/test/`. Browser-facing demos live under
[`apps/browser-demos/`](../apps/browser-demos/).

## Building and Running

```bash
# Compile any example
wasm32posix-cc examples/hello.c -o hello.wasm

# Run it
npx tsx examples/run-example.ts hello
```

`run-example.ts` starts guests as root by default. Set `KERNEL_UID` and
`KERNEL_GID` to decimal values from 0 through 4294967294 when a test needs a
different initial user or group. The maximum unsigned 32-bit value is reserved
by the host protocol and is rejected rather than being mistaken for an ID.

The runner has two explicit filesystem modes. Its default `raw` mode preserves
the legacy direct host-filesystem behavior and accepts `KERNEL_CWD`.
`KANDELO_RUNNER_VFS=isolated` instead boots the canonical root image with
lifecycle-owned scratch storage and uses `/tmp` as the guest working directory.
`KANDELO_RUNNER_VFS=persistent` derives that image with the fixture under
`/var/lib/kandelo-tests/runner`, uses the fixture working directory for `TMPDIR`, and mounts
the resizable journal at the absolute `KANDELO_RUNNER_PERSISTENCE_PATH`.
It requires a fixture root and exercises rootfs writes rather than host-backed
`/run` or in-kernel `/tmp`; the caller owns journal cleanup.
Conformance harnesses may additionally provide one quiescent fixture directory
with `KANDELO_RUNNER_FIXTURE_ROOT`, a relative
`KANDELO_RUNNER_FIXTURE_CWD`, and an optional relative
`KANDELO_RUNNER_GUEST_PROGRAM`. The worker copies that tree under
`/var/lib/kandelo-tests/runner` before readiness (a host-backed test-work-tree mount the in-kernel tmpfs
does not claim, so the guest sees the seeded tree); the guest cannot mutate
the source, and ambient host executable lookup is disabled. These controls are
runner plumbing, not guest environment variables.

`KANDELO_RUNNER_NETWORK=offline-egress` boots the machine with the internet
egress link the browser host always provides (eth0 at 10.0.2.15/24 behind a
NAT gateway), but with nothing behind the gateway: connections beyond the
machine fail with EHOSTUNREACH, and the host's network is never reached. The
Node conformance runners set it so they observe the same machine as the
browser runners. Unset, the machine has loopback only.

See [docs/sdk-guide.md](../docs/sdk-guide.md) for full SDK documentation.

The Open POSIX runner exposes this path with
`scripts/run-posix-tests.sh --persistent fsync`. It gives each test a fresh
temporary journal and removes it after the test. The default runner remains
isolated and host-backed at `/run`; the persistent option does not by itself
reboot a test's journal or establish full persistent POSIX conformance.

## Programs

### Basics

| Example | Description |
|---------|-------------|
| [hello.c](hello.c) | Hello world — minimal printf test |
| [malloc.c](malloc.c) | Dynamic memory allocation via brk/mmap |
| [strings.c](strings.c) | String operations (string.h, ctype.h) |
| [math.c](math.c) | Number formatting and basic math |
| [snprintf.c](snprintf.c) | String formatting without I/O |
| [fprintf.c](fprintf.c) | Writing to stdout and stderr |

### Filesystem

| Example | Description |
|---------|-------------|
| [files.c](files.c) | File I/O — open, read, write, seek, stat |
| [dirs.c](dirs.c) | Directory operations — mkdir, readdir, rmdir |
| [flock_test.c](flock_test.c) | Advisory file locking via flock() |

### System

| Example | Description |
|---------|-------------|
| [environ.c](environ.c) | Process info and environment variables |
| [putenv_test.c](putenv_test.c) | setenv/getenv/putenv/unsetenv |
| [getaddrinfo_test.c](getaddrinfo_test.c) | DNS resolution via getaddrinfo() |
| [mmap_file_test.c](mmap_file_test.c) | Memory-mapped file I/O |
| [test-pthread.c](test-pthread.c) | Thread creation via clone() |
| [sysv_ipc_test.c](sysv_ipc_test.c) | SysV IPC (message queues, semaphores) |

### Browser and package examples

The [browser app](../apps/README.md) consumes the same host runtime as these
examples. Use `./run.sh browser` from the repository root to build and launch
it; see [Contributing](../CONTRIBUTING.md) for setup and supported commands.

Ported software, package-owned demos and integration tests live in
[`packages/registry/`](../packages/registry/). See the
[package overview](../packages/README.md) for examples and each package's
`package.toml` for its version and outputs. The
[porting guide](../docs/porting-guide.md) explains how to add a package.

## Built binaries

Wasm binaries are generated locally and are not checked in. Follow
[the test setup instructions](../CONTRIBUTING.md#prepare-to-run-tests), then
run `scripts/dev-shell.sh bash scripts/build-programs.sh` to build the
example and test fixtures used by the runners.
