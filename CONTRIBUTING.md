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
| `./run.sh setup` | Prepare the SDK, browser-required packages, root filesystem, and host runtime |
| `./run.sh setup --all` | Also build every supported package, including test-only packages |
| `./run.sh partial shell <pkg>...` | Compose a shell with only the rootfs base and the named packages, for fast iteration ([Partial images](docs/package-management.md#partial-images)) |
| `./run.sh browser --partial` | Serve what is built, starting from the partial image, without the full build |
| `./run.sh browser` | Build/reuse browser images and start the development server |
| `./run.sh run <example>` | Run a Node.js demo, such as `shell`, `nginx`, or `wordpress` |
| `./run.sh build <target>` | Build a kernel, package, or image, such as `kernel`, `php`, or `shell-vfs` |
| `./run.sh rebuild <target>` | Force a target to rebuild |
| `./run.sh clean <target>` | Remove a target's outputs and products that depend on it |
| `./run.sh local-build [--json]` | Build packages needed by the browser and images; add `--all` for all supported packages |
| `./run.sh local-build --plan` | Preview cached nodes, work to do, and an estimated duration |
| `./run.sh cache-gc` | Preview unused cache entries; add `--apply` to remove them |
| `./run.sh list` | List build targets, examples, and test suites |

Setup checks both musl sysroots: the target's C headers and libraries.
It rebuilds missing or stale C libraries, builds the required packages, and
installs the root and host npm dependencies. The supported set and its
exclusions are in `packages/sets/local-supported.toml`.

Builds use a cache shared across worktrees at `~/.cache/kandelo/source-only/`.
The selected outputs appear under `local-binaries/source-only-v1/`.
Set `KANDELO_SOURCE_CACHE_ROOT` to an absolute path if you need an isolated
cache. There is no remote prebuilt-binary fallback or separate fetch step.
See [Package Management](docs/package-management.md) for cache details.

Working on one or two packages? Start with a partial image instead of the
full setup: `./run.sh partial shell <pkg>` builds the kernel, the SDK, the
rootfs base and only those packages, and `./run.sh browser --partial` boots
it as its own machine. Build the full set (`./run.sh setup`) before you open
a pull request; a partial image is not evidence for the canonical images.

After changing kernel code, run `./run.sh setup` before runtime tests. After
changing libc inputs, run `./run.sh setup --all` to refresh linked package
programs, then `scripts/build-programs.sh` for test fixtures inside the dev
shell. Updating libc alone does not refresh programs already linked against it.

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
flags, and the native SDK driver. For Rust guests, including `std`, see the
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
- Add a `changelog.d/` fragment for a user or contributor change, or explain
  `Changelog: none <reason>` in the PR body. See the
  [changelog workflow](docs/changelog.md) for categories and publication.
- Use commit and PR titles such as `Docs: Shorten the README` or
  `Kernel: Preserve shared file offsets`. Explain the problem before the fix.

For new packages, follow the [Porting Guide](docs/porting-guide.md).
For changes to the binary interface between programs and the kernel, follow
[ABI Versioning](docs/abi-versioning.md) before changing its version or snapshot.

### Integrate a reviewed patch

For changes prepared in another checkout, the optional
[reviewed integration CLI](docs/agent-integration.md) checks pinned source
and patch identities, preserves unrelated work, and records progress in a
resumable ledger. It needs Python and Git, with no project binaries built.

Start with `scripts/agent-integrate preflight manifest.json`; the reference
includes a complete example and a reproducible isolated demonstration.
`run` applies the patch and stops for reviewed check results. Import them
with `record` to checkpoint only the owned paths. Check execution is
separate, and commits/pushes require explicit invocation and task authority.

## Prepare to run tests

Initialize the test submodules, build all supported packages, and build test fixtures:

```bash
git submodule update --init --recursive
./run.sh setup --all
scripts/dev-shell.sh bash scripts/build-programs.sh
```

Test fixtures are small programs used by the runtime tests. Setup with `--all`
builds the supported packages; the fixture script builds additional test programs.
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

For the SDK driver and ABI snapshot, inside the development shell:

```bash
host_target="$(rustc -vV | awk '/^host/ {print $2}')"
cargo test -p kandelo-cc --target "$host_target"
bash scripts/check-abi-version.sh
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

## Retain and clean validation evidence

These scripts work in ordinary Git checkouts and worktrees on macOS and
Linux; no IDE, agent application, or workspace hook is required. Playwright
allocates one `test-results/<run-uuid>` directory per run. Long-running jobs
started with `scripts/agent-job` store logs and scratch under
`.context/agent-jobs/<job-id>`. Use the job's
`$KANDELO_AGENT_SCRATCH_DIR` for additional logs instead of fixed `/tmp` paths.

Evidence stays available until you release it or remove its worktree:

```bash
scripts/agent-job release <job-id-or-playwright-run-uuid> --dry-run
scripts/agent-job release <job-id-or-playwright-run-uuid>
scripts/agent-job cleanup --dry-run
scripts/agent-job cleanup
```

`cleanup` closes the current worktree to new validation runs and refuses
while a registered run still has active writers. After a refusal, finish
the run and retry, or use `scripts/agent-job reopen` to resume work. Cleanup
never stops a process. An optional editor or worktree-removal hook can call
the same command, but must honor its failure before removing the worktree.

The bulk payload is inside the worktree, so removing the directory also
removes that payload even if no hook ran. A small machine-wide registry in
`~/.cache/kandelo/agent-jobs` retains job exit status, a bounded log summary,
and UUID ownership records. `scripts/agent-job gc --dry-run`, followed by
`scripts/agent-job gc`, reconciles removed worktrees, recovers interrupted
cleanup, and releases inactive legacy job payloads. It skips live runs and
does not clean shared build caches or arbitrary `/tmp` files. A new worktree
at an old path receives a new UUID; its files cannot be claimed by the old
record. Set `KANDELO_AGENT_JOBS_DIR` to override the registry location.

Explicit Playwright output overrides remain caller-owned. macOS WebKit can
also create OS-managed staging files outside `TMPDIR`; these retain their
existing guarded teardown and may need inspection after an interrupted run.
See [Playwright storage](docs/agent-guidance/validation.md#playwright-storage-on-macos)
for that boundary. Worktree cleanup does not sweep those shared directories.
