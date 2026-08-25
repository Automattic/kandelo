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
| `images/vfs/products/` | Canonical VFS product manifests and generated catalog | Pages/test placement and software recipe facts |
| `apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.toml` | Pages-owned VFS product selection | VFS product definitions |
| `tests/vfs-products.toml` | Test-owned VFS product selection and applicability | VFS product definitions |
| `abi/staging/` | ABI staging request/guard policy, activation, and transition ledgers | Hosted artifact storage or mutable current state |
| `tools/` | Repo automation such as `xtask` and `mkrootfs` | Product runtime code |
| `sdk/` | Cross-compilation wrapper CLI and SDK support code | Runtime host implementation |
| `libc/` | musl submodule, musl overlay, syscall glue | General package registry |

Hosted ABI staging is not operational in this foundation. The paths above
define local product, policy, and validation authority only until protected
workflows and hosted evidence prove the corresponding remote capabilities.

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
| `packages/sets/**`, `tools/xtask/**`, `docs/package-management*.md` | Package-system automation checks, including the `cargo test -p xtask` (`cargo-xtask`) unit-test suite |
| `apps/browser-demos/**`, `web-libs/**` | Browser app build/tests and relevant package browser specs |
| `images/**`, `tools/mkrootfs/**` | Rootfs/VFS image checks and consumers of those images |

The canonical VFS catalog and both consumer registries support checked-in
validation and a deterministic local transition miniature. The protected
request workflow is owned by
`.github/workflows/abi-staging-request-feed.yml`; its source policy and
activation are owned by `abi/staging/request-policy.toml` and
`abi/staging/request-feed-activation.toml`. Active mode publishes each exact,
non-endorsing request in its own content-addressed prerelease for protected
tap-side reconciliation. The publisher uploads only while the prerelease is a
draft, then makes it public and requires GitHub immutable-release protection
plus an anonymous byte-for-byte readback before reporting success. Historical
requests remain separate immutable records; a later head or policy creates a
new prerelease instead of appending to an existing public release. The
companion tap workflow remains read-only until its separately reviewed
activation changes.

Candidate execution and publication, enforced GitHub Check updates,
promotion, protected ABI-history mutation, and production Pages deployment
remain separately guarded staging layers. In particular, active request
publication does not authorize candidate package writes or promotion.

The change-scope classifier implements these categories conservatively. VFS
authority and staging-contract paths reach the non-package runtime gate;
product manifests also retain their existing VFS/package-image route. They do
not opt into an existing credentialed package publisher by special case.

## Disabled GitHub Pages Publication

Hosted browser, guide, and generated API publication is currently dormant.
The retained implementation lives at
`.github/disabled-workflows/browser-demos-pages.yml`, outside GitHub's workflow
discovery directory. No active workflow may invoke it, and package-candidate
activation does not inspect or update a hosted browser deployment.

Pull-request continuous integration still builds and tests the browser app and
documentation from repository-owned inputs. Those checks validate the current
source tree; they do not publish it or make an existing `gh-pages` branch a
current product artifact. Any content already hosted from that branch may be
historical and must not be treated as an authenticated view of `main`.

Before disablement, the retained workflow assembled the browser demo at the
branch root, the guide under `guide/`, and API documentation under `api/`. It
bound a deployment to one source commit and canonical package index, enforced
a 1,000,000,000-byte logical-size cap, rejected symbolic links, and replaced
the branch with a fresh orphan commit so content-addressed Vite assets could
not accumulate indefinitely. Those controls remain dormant reference code,
not an active publication promise. Re-enabling hosted publication requires a
separate reviewed change that restores a trigger and current package-backed
deployment evidence.
