# Contributing to Kandelo

This guide covers building, changing, and testing Kandelo. For a first local
run, follow the [README quick start](README.md#quick-start).

## Development environment

Use Git and Nix with flakes enabled on macOS or Linux (x86-64 or ARM64).
`./run.sh setup` enters the repository's Nix development shell and provides
the pinned Rust nightly, LLVM 21, Node.js 24, and package build tools.
Installing those tools separately does not replace Nix for this workflow.

To work inside that environment, run from the repository root:

```bash
scripts/dev-shell.sh bash
```

Run the commands below from the repository root unless stated otherwise.
Use `scripts/dev-shell.sh <command>` for a single build or test command
outside the interactive shell.

## Build and rebuild

| Command | Purpose |
|---------|---------|
| `./run.sh setup` | Prepare the SDK, supported packages, root filesystem, and host runtime |
| `./run.sh browser` | Build/reuse browser images and start the development server |
| `./run.sh run <example>` | Run a Node.js demo, such as `shell`, `nginx`, or `wordpress` |
| `./run.sh build <target>` | Build a kernel, package, or image, such as `kernel`, `php`, or `shell-vfs` |
| `./run.sh rebuild <target>` | Force a target to rebuild |
| `./run.sh clean <target>` | Remove a target's outputs and products that depend on it |
| `./run.sh local-build [--json]` | Build supported packages and images; optionally print JSON |
| `./run.sh local-build --plan` | Preview cached nodes, work to do, and an estimated duration |
| `./run.sh cache-gc` | Preview unused cache entries; add `--apply` to remove them |
| `./run.sh list` | List build targets, examples, and test suites |

Setup checks both musl sysroots: the target's C headers and libraries.
It rebuilds missing or stale C libraries, builds the supported package set, and
installs the root and host npm dependencies. The supported set and its
exclusions are in `packages/sets/local-supported.toml`.

Builds use a cache shared across worktrees at `~/.cache/kandelo/source-only/`.
The selected outputs appear under `local-binaries/source-only-v1/`.
Set `KANDELO_SOURCE_CACHE_ROOT` to an absolute path if you need an isolated
cache. There is no remote prebuilt-binary fallback or separate fetch step.
See [Package Management](docs/package-management.md) for cache details.

After changing kernel code, run setup before runtime tests. After changing
libc inputs, also rebuild the test programs with `scripts/build-programs.sh`
inside the dev shell. Updating libc alone does not refresh programs already
linked against it.

## Compile and run a C program

Inside the development shell:

```bash
wasm32posix-cc examples/hello.c -o hello.wasm
npx tsx examples/run-example.ts hello.wasm
```

The compiler produces Wasm for Kandelo. The runner starts a kernel in Node.js
and runs the exact file you compiled.

The shell provides this checkout's SDK commands, so no global `npm link` is
needed. See the [SDK Guide](docs/sdk-guide.md) for C++, wasm64, compiler
flags, and local npm packaging. For Rust guests, including `std`, see the
[Rust SDK guide](sdk/rust/README.md).

Programs using `fork()` or fork-based helpers need instrumentation after
linking. Follow the [fork instrumentation guide](docs/fork-instrumentation.md).

## Find the right code

| Path | What belongs here |
|------|-------------------|
| `crates/runtime-core/` | POSIX behavior: processes, files, signals, sockets, and devices |
| `crates/kernel/` | The Wasm interface around the POSIX implementation |
| `host/` | Worker lifecycle and shared Node.js/browser host code |
| `libc/`, `sdk/` | C library support and compiler wrappers |
| `apps/browser-demos/`, `web-libs/` | Browser UI and reusable session code |
| `packages/registry/` | Package recipes, patches, demos, and package-owned tests |

See [Repository Organization](docs/repository-organization.md) for the full
map and [software examples](packages/README.md) for the package catalog.
Older Git history includes built `.wasm` files and may be rewritten to
remove them.

## Make a change

- Read the reference guide for the area you are changing.
- Fix platform problems in the layer that owns them. A missing system call
  is a kernel gap to fix, rather than a reason to hide the failure in a demo.
- Keep Node.js and browser behavior aligned. Document differences caused
  by real host limits.
- Update the docs that describe changed behavior. State known gaps plainly.
- Use commit and PR titles such as `Docs: Shorten the README` or
  `Kernel: Preserve shared file offsets`. Explain the problem before the fix.

For new packages, follow the [Porting Guide](docs/porting-guide.md).
For changes to the binary interface between programs and the kernel, follow
[ABI Versioning](docs/abi-versioning.md) before changing its version or snapshot.

## Prepare to run tests

Initialize the test submodules, run setup, and build test fixtures:

```bash
git submodule update --init --recursive
./run.sh setup
scripts/dev-shell.sh bash scripts/build-programs.sh
```

Test fixtures are small programs used by the runtime tests. Setup builds the
supported packages; the fixture script builds additional test programs.
A test that needs an excluded package or dormant image may also need that
recipe built through the package resolver.

Sortix tests include filenames that differ only by case. If your filesystem
is case-insensitive, use a pristine checkout of the pinned Sortix submodule
on a case-sensitive volume and set `KANDELO_SORTIX_SOURCE_ROOT` to its path.
See [test provisioning](docs/agent-guidance/validation.md#preparing-a-fresh-checkout-or-worktree-to-run-the-suites)
for the full setup and troubleshooting steps.

## Choose and run tests

Run suites one at a time. The shared runner selects each suite's configuration
and detects the native Rust host target:

```bash
scripts/dev-shell.sh bash scripts/ci-run-test-suite.sh cargo-workspace
scripts/dev-shell.sh bash scripts/ci-run-test-suite.sh cargo-xtask
scripts/dev-shell.sh bash scripts/ci-run-test-suite.sh vitest
scripts/dev-shell.sh bash scripts/ci-run-test-suite.sh browser
scripts/dev-shell.sh bash scripts/ci-run-test-suite.sh libc
scripts/dev-shell.sh bash scripts/ci-run-test-suite.sh posix
scripts/dev-shell.sh bash scripts/ci-run-test-suite.sh sortix
```

| Suite | Use it to check |
|-------|-----------------|
| `cargo-workspace` | Rust code under `crates/` |
| `cargo-xtask` | Package resolution and build automation |
| `vitest` | Host/kernel integration in Node.js |
| `browser` | Browser runtime and UI behavior with Playwright |
| `libc`, `posix`, `sortix` | C library and POSIX behavior against external test suites |

For SDK wrappers and the ABI snapshot:

```bash
scripts/dev-shell.sh bash -c 'cd sdk && npm ci && npm test'
scripts/dev-shell.sh bash scripts/check-abi-version.sh
```

For shared-memory ownership, audio, graphics lifecycle, image composition,
or machine teardown, also run:

```bash
./run.sh test browser-memory
```

That gate builds current browser products, checks host lifecycle behavior
on Node.js and Bun, and runs repeated machine switches in Chromium, Firefox,
and Playwright WebKit. Playwright WebKit is not native iOS Safari evidence.
See [browser memory validation](docs/agent-guidance/validation.md#browser-memory-regression-gate)
for exact coverage and native-testing follow-up.

Some conformance tests have known failures. The runners report expected
failures, skips, and unresolved cases separately from passes. An unexpected
failure fails the run. Report which commands you ran, what failed, and what
you did not test. A passing Node.js test does not prove browser behavior.

For suite selection, long jobs, and detailed evidence requirements, see the
[validation guide](docs/agent-guidance/validation.md).
