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
| `tests/` | External conformance suites and package-system tooling tests | Package-owned integration tests |
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

These are intended categories, not a CI implementation. The current PR only keeps the paths clean enough for a future CI-filter PR to use them.
