# Repository Organization

Kandelo is organized as a kernel-first monorepo. The kernel and host runtimes are the primary product surface; ported software packages, browser apps, VFS images, and automation are kept in separate trees so ownership and CI relevance are easy to reason about.

## Top-Level Ownership

| Path | Owns | Does not own |
|------|------|--------------|
| `crates/kernel/` | Rust kernel implementation: syscalls, process table, fd tables, signals, sockets, PTY, devices | Host runtime, package builds |
| `host/src/` | TypeScript host runtime shared by Node.js and browser environments | Browser demo UI |
| `apps/browser-demos/` | Vite app, demo pages, Kandelo web UI, app-local helpers | Core browser host runtime |
| `web-libs/` | Browser-independent reusable UI/session contracts | App-specific page code |
| `packages/registry/<name>/` | One ported package: manifest, build script, patches, package-owned demos, package-owned tests | Kernel/host behavior tests |
| `packages/sets/` | Named product or CI package sets | Package implementation details |
| `tests/` | External conformance suites, package-system tooling tests, and shared host/kernel test artifact manifests | Package-owned integration tests |
| `images/` | Rootfs sources and VFS/archive build scripts | Package source builds |
| `tools/` | Repo automation such as `xtask` and `mkrootfs` | Product runtime code |
| `sdk/` | Cross-compilation wrapper CLI and SDK support code | Runtime host implementation |
| `libc/` | musl submodule, musl overlay, syscall glue | General package registry |

## Host Runtime Layout

Node.js and browser hosts are peers and live beside each other under `host/src/`:

| Concern | Node.js | Browser | Shared |
|---------|---------|---------|--------|
| Main-thread host proxy | `host/src/node-kernel-host.ts` | `host/src/browser-kernel-host.ts` | |
| Main/kernel-worker protocol | `host/src/node-kernel-protocol.ts` | `host/src/browser-kernel-protocol.ts` | |
| Dedicated kernel-worker entry | `host/src/node-kernel-worker-entry.ts` | `host/src/browser-kernel-worker-entry.ts` | |
| Process-worker entry | | | `host/src/worker-main.ts`, `host/src/worker-entry.ts`, `host/src/worker-entry-browser.ts` |
| Worker adapter | `host/src/worker-adapter.ts` | `host/src/worker-adapter-browser.ts` | |
| Runtime services | | | `host/src/vfs/`, `host/src/networking/`, `host/src/framebuffer/` |

`apps/browser-demos/` imports the browser host runtime; it does not maintain it. Demo-only clients, terminal widgets, service-worker setup helpers, and UI components stay in the app tree.

## Package Layout

Each package is self-contained under `packages/registry/<name>/`:

```
packages/registry/<name>/
  package.toml       Package metadata consumed by release/build automation
  build*.sh          Package build scripts
  patches/           Package-specific source patches
  demo/              Package-owned launchers, service configs, sample assets
  test/              Package-owned tests, fixtures, and browser specs
```

Package behavior tests live with the package so future CI can map changes to relevant package tests. For example, a Doom package change can trigger `packages/registry/fbdoom/test/` and browser-interface checks without running unrelated host/kernel tests.

## Test Boundaries

| Path | Test scope |
|------|------------|
| `host/test/` | Host/kernel runtime behavior: process lifecycle, VFS semantics, syscalls, worker behavior, host parity |
| `packages/registry/<name>/test/` | Behavior of a specific ported package |
| `tests/package-system/` | Package registry and binary-fetching automation |
| `tests/test-artifacts/` | Shared host/kernel test artifact ownership manifests |
| `tests/libc/`, `tests/posix/`, `tests/sortix/` | External conformance suites and overlays |
| `apps/browser-demos/test/` | Browser app and demo-page integration behavior |

`host/test/` should not be a catch-all for anything launched by the host. If a test primarily proves package behavior, it belongs with that package.

## CI Path Categories

The layout is designed so later CI path filters can make conservative, explainable decisions:

| Changed path | Likely relevant checks |
|--------------|------------------------|
| `crates/kernel/**`, `libc/glue/**`, `host/src/kernel*.ts`, `host/src/worker*.ts` | Kernel/host build, host vitest, conformance smoke tests, affected browser checks |
| `host/src/node-*.ts` | Node host checks and host parity tests |
| `host/src/browser-*.ts`, `host/src/worker-adapter-browser.ts` | Browser host checks, browser UI/tests, host parity tests |
| `host/src/vfs/**`, `host/src/networking/**`, `host/src/framebuffer/**` | Shared host/runtime checks plus affected package/browser checks |
| `packages/registry/<name>/**` | That package build and `packages/registry/<name>/test/**` |
| `packages/sets/**`, `tools/xtask/**`, `docs/package-management*.md` | Package-system automation checks |
| `apps/browser-demos/**`, `web-libs/**` | Browser app build/tests and relevant package browser specs |
| `images/**`, `tools/mkrootfs/**` | Rootfs/VFS image checks and consumers of those images |

These are intended categories, not a CI implementation. The current PR only keeps the paths clean enough for a future CI-filter PR to use them.

## GitHub Pages Publication

The browser demo, user guide, and generated host API documentation share one
`gh-pages` branch. The browser demo owns the branch root, the guide owns
`guide/`, and the API documentation owns `api/`. One workflow,
`.github/workflows/browser-demos-pages.yml`, is the only workflow allowed to
write that branch.

The workflow checks out one source commit and builds all three trees in one
job. It then publishes that complete tree as a fresh orphan commit. Replacing
the branch is intentional: Vite gives browser assets content-addressed names,
so retaining files from earlier builds would preserve obsolete names and grow
the published site without bound. Before publication, the workflow sums the
logical sizes of every regular file in the assembled tree and refuses to
publish more than 1,000,000,000 bytes. Symbolic links are rejected because the
publisher would dereference them and their target sizes would otherwise escape
that accounting.

GitHub recommends that a Pages source repository remain below 1 GB and limits a
published Pages site to 1 GB. Before this cleanup, the `gh-pages` tree at
`1d84fd02a383213c1cf9d9266cebdd4d1fdb2b81` contained 11,504,642,167 bytes of
file content, including 2,502 files and 11,104,024,279 bytes under `assets/`.
That measurement was taken on 2026-07-23; it records the accumulated-tree
problem rather than promising that branch size is static.

Newer Pages runs cancel work for superseded commits. Because GitHub does not
guarantee concurrency-group ordering, cancellation is not the publication
authority. An unrelated `main` commit may not trigger the Pages workflow, so
comparing the build commit with the tip of `main` would incorrectly discard a
still-current site build. Instead, immediately before the sole deployment
step, the workflow queries GitHub Actions and publishes only when its run
number is the newest run triggered for this workflow on `main`. A delayed older
run therefore cannot become the final writer. Missing, empty, malformed, or
failed API responses stop publication rather than guessing that a run is
current.

GitHub's current Pages limits are documented at
<https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits>.
