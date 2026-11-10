# Repository Organization

For everyday build and test commands, start with [Contributing](../CONTRIBUTING.md).

Kandelo is organized as a kernel-first monorepo. The kernel and host runtimes are the primary product surface; ported software packages, browser apps, VFS images, and automation are kept in separate trees so ownership and CI relevance are easy to reason about.

## Top-Level Ownership

| Path | Owns | Does not own |
|------|------|--------------|
| `crates/runtime-core/` | Engine-independent POSIX subsystems: syscalls, process table, fd tables, filesystems, signals, sockets, PTY, devices | Worker lifecycle, browser APIs, package builds |
| `crates/kernel/` | Wasm exports and host-import adapter around runtime-core | Independent POSIX implementations, package builds |
| `crates/program-abi/` | Program ABI version and artifact declarations consumed by the fork instrumenter | Kernel-host-only metadata |
| `crates/shared/` | Platform contracts and re-exports of program ABI declarations | Fork instrumentation implementation |
| `host/src/` | TypeScript host runtime shared by Node.js and browser environments | Browser demo UI |
| `apps/browser-demos/` | Vite app, demo pages, Kandelo web UI, app-local helpers | Core browser host runtime |
| `apps/signalling/` | Portable PHP piplet, Spacefast database-backed signalling, and server tests | Guest socket semantics, RTC data transport |
| `apps/spacefast-cors-proxy/` | Optional Spacefast proxy, quota-session service, and combined-site packager | Default browser hosting, guest networking semantics |
| `web-libs/` | Browser-independent reusable UI/session contracts | App-specific page code |
| `packages/registry/<name>/` | One ported package: manifest, build script, patches, package-owned demos, package-owned tests | Kernel/host behavior tests |
| `packages/sets/` | Named product or CI package sets | Package implementation details |
| `tests/` | External conformance suites, package-system tooling tests, and shared host/kernel test artifact manifests | Package-owned integration tests |
| `images/` | Rootfs sources and VFS/archive build scripts | Package source builds |
| `images/vfs/products/` | Canonical VFS product manifests and generated catalog | Pages/test placement and software recipe facts |
| `apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-products.toml` | Pages-owned VFS product selection | VFS product definitions |
| `tests/vfs-products.toml` | Test-owned VFS product selection and applicability | VFS product definitions |
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

Reusable browser peer connection setup lives in
`web-libs/kandelo-session/src/peer-connection.ts`: purpose-checked signal
codes, declared channels, ICE and connection lifecycle. Consumers declare
their channels beside their app code. The purpose-independent rendezvous
client is
`apps/browser-demos/lib/peer-signalling.ts`; its PHP server and server tests
are under `apps/signalling/`.

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
| `tests/agent-integration/` | Reviewed-patch tooling, evidence imports and recovery in isolated Git repositories |
| `tests/test-artifacts/` | Shared host/kernel test artifact ownership manifests |
| `tests/baselines/` | Failure/anomaly evidence and provenance; not test expectations |
| `tests/libc/`, `tests/posix/`, `tests/sortix/` | External conformance suites and overlays |
| `apps/browser-demos/test/` | Browser app and demo-page integration behavior |

`host/test/` should not be a catch-all for anything launched by the host. If a test primarily proves package behavior, it belongs with that package.

## Worktree Local Storage

| Path | Contents and lifetime |
|------|-----------------------|
| `.context/` | Retained notes, checkpoints, attachments, integration records, and the small validation ownership marker. Conductor preserves this directory when archiving a workspace. |
| `.scratch/` | Disposable bulk data: job logs/scratch, Playwright temporary profiles and storage, temporary worktrees, source/build experiments, fuzz results, and deployment bundles. Removed with the workspace; Conductor does not preserve it as archived context. |
| `test-results/<run-id>/` | Playwright screenshots, traces, attachments, and reports, beside each suite's config. Removed with the workspace; explicit output/reporter overrides remain caller-owned. |
| `test-runs/` | Ignored raw SQLite runner databases, logs and per-run summaries. Select evidence for retention explicitly; do not commit this output tree. |

Use a unique directory per run under `.scratch/`, or the job-provided
`$KANDELO_AGENT_SCRATCH_DIR`. Never nest scratch checkouts or bulk generated
output in `.context/`. Copy a concise result and any selected evidence that
must survive archival into `.context/` or another durable destination.

Keep private agent progress ledgers and handoffs in `.context/`, not in
tracked tool-specific directories. Keep reusable design rationale in `docs/`
and current behavior in its authoritative reference. Remove superseded,
unreferenced implementation checklists rather than leaving old task commands
beside current guidance; Git history retains them. Dated measurements and
`tests/baselines/` remain evidence, not current readiness claims.

Registered validation evidence remains until reviewed and explicitly
released, or the workspace is removed. Use the
[contributor cleanup commands](../CONTRIBUTING.md#retain-and-clean-validation-evidence)
to check for active writers before release. They also support older runs
whose registered payloads are under `.context/`; no existing payloads are
moved automatically. Arbitrary scratch checkouts and build experiments are
caller-owned and are not swept by these commands. Shared build caches have
their own lifecycle.

## Reviewed Integration Tooling

[`scripts/agent-integrate`](agent-integration.md) owns optional reviewed-patch
preflight, application, evidence bookkeeping and checkpointing. Its Python
implementation and versioned schemas live in `scripts/agent_integration/`.
Task ledgers and linked local evidence live under the ignored
`.context/agent-integrations/` directory. Validation command execution stays
separate; this tool imports reviewed results rather than scheduling checks.

[`scripts/agent-checkpoint`](agent-guidance/campaigns.md) stores immutable
campaign handoff notes in `.context/agent-checkpoints/`. Its standalone
implementation is `.claude/hooks/context-checkpoint.py`, which also supplies
the optional Claude Code context reminder. Neither operation rotates workers
or validates the claims written in a note.

## CI Path Categories

The layout is designed so later CI path filters can make conservative, explainable decisions:

| Changed path | Likely relevant checks |
|--------------|------------------------|
| `crates/runtime-core/**`, `crates/kernel/**`, `libc/glue/**`, `host/src/kernel*.ts`, `host/src/worker*.ts` | Kernel/host build, host vitest, conformance smoke tests, affected browser checks |
| `host/src/node-*.ts` | Node host checks and host parity tests |
| `host/src/browser-*.ts`, `host/src/worker-adapter-browser.ts` | Browser host checks, browser UI/tests, host parity tests |
| `host/src/vfs/**`, `host/src/networking/**`, `host/src/framebuffer/**` | Shared host/runtime checks plus affected package/browser checks |
| `packages/registry/<name>/**` | That package build and `packages/registry/<name>/test/**` |
| `packages/sets/**`, `tools/xtask/**`, `docs/package-management*.md` | Package-system automation checks, including the `cargo test -p xtask` (`cargo-xtask`) unit-test suite |
| `apps/browser-demos/**`, `web-libs/**` | Browser app build/tests and relevant package browser specs |
| `images/**`, `tools/mkrootfs/**` | Rootfs/VFS image checks and consumers of those images |

## GitHub Pages Publication

There is no active GitHub Pages publisher in this checkout. The browser app
and documentation are built and checked by
`.github/workflows/browser-demos-ci.yml`; those checks do not publish a site.
Package-candidate activation does not dispatch a browser deployment.

The VFS product catalog and consumer registries remain inputs to local builds
and validation. Their presence does not establish hosted publication. Older
hosted content and retired workflow implementations in Git history are
historical, not authenticated views of the current source. Restoring hosted
publication requires a reviewed implementation and current package-backed
deployment evidence.
