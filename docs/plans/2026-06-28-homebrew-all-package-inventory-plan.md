# Homebrew All Packages Inventory And Migration Plan

Date: 2026-06-28
Last updated: 2026-06-29

Tracked work:

- `kd-1mr` - Port all current Kandelo packages to Homebrew.
- `kd-5yd` - Inventory packages and plan Homebrew migration waves.
- Foundation status: `kd-8ho` is closed. PR #785 merged the trusted Homebrew
  publishing foundation into `origin/main`, `Automattic/kandelo-homebrew` is
  initialized, the first `hello` wasm32 bottle was published through trusted
  CI, and `kd-uqyg` closed with the decision to keep Kandelo's custom GHCR
  upload adapter for now while continuing to reuse upstream Homebrew
  build/test/bottle/merge commands.
- Current package-wave state: `kd-1mr.1` has already ported and verified
  `zlib` Homebrew bottles locally for wasm32 and wasm64. Use `hello` and
  `zlib` as reference evidence for the next pilot, not as future planning
  blockers.

This plan was revised from the `kd-5yd` worktree after Brandon settled the
Homebrew-all direction: Homebrew should replace `packages/registry` if possible,
Formulae should become the package source of truth, GitHub Packages should store
the bottle artifacts through the GHCR/OCI namespace, and package status should
remain visible even when builds or tests fail.

This remains a planning and inventory artifact. It does not publish bottles,
edit package recipes, or move registry files. It records the minimal next
package-wave bead to create after the foundation and zlib proof, while leaving
future broad waves uncreated until the pilot exposes real capacity and
correctness facts.

## Problem Statement

Kandelo currently owns package recipes and publish state in
`packages/registry/<name>/{package.toml,build.toml}`. That registry describes
libraries, programs, source resources, internal platform artifacts, precomposed
VFS images, and composite runtime packages. The desired end state is to move
the package index, dependency graph, source/build/install/test behavior, and
package discovery to a Homebrew tap where Formulae are authoritative.

The migration must therefore answer a harder question than "can every current
registry entry be bottled?": it must prove whether Homebrew can replace
`packages/registry` entirely while preserving Kandelo's package, ABI, host
runtime, VFS, and user-visible failure contracts.

The design needs to:

- cover every current `packages/registry/` entry, including support directories
  that are not publishable packages today;
- define a temporary bridge from existing manifests to Formulae without making
  the bridge the long-term source of truth;
- keep Formula DSL authoritative for dependency, build, install, and test
  behavior needed by `brew install`;
- keep Kandelo sidecars additive: index/provenance/gallery/status metadata must
  not be required for ordinary Homebrew install semantics;
- store bottle blobs in GitHub Packages, using GHCR/OCI naming as the storage
  mechanism for Homebrew bottle artifacts;
- keep failed, deferred, partial, and unavailable packages visible in the
  Homebrew-backed package index with concrete reasons and evidence;
- require both Node and browser host compatibility for Kandelo wasm packages;
  host-specific failures are defects or temporary status failures, not accepted
  package support tiers;
- support full upstream test execution and detailed outcome artifacts while
  keeping upstream full-test pass status out of the default bottle gate;
- make ABI version visible as artifact compatibility identity, rebuild status,
  and failure diagnosis, without forcing ABI details into normal install UX;
- use upstream Homebrew as directly as possible, ideally with only the target
  architecture support needed for Kandelo wasm bottles;
- stage work so trusted tap/GitHub Packages publication and CI capacity are not
  overloaded by one all-at-once matrix.

## Non-Goals

- Do not start broad or all-package bottle publication from this design bead.
  `kd-8ho` is closed, but each package wave still needs its own bead, managed
  worktree, trusted workflow evidence when publishing, sidecar/provenance
  validation, and Node/browser smoke accounting.
- Do not keep `packages/registry` as the intended permanent package recipe
  database if Homebrew replacement succeeds.
- Do not require Kandelo sidecars for `brew install`; sidecars are additive
  Kandelo metadata for provenance, package index status, gallery availability,
  precomposed VFS planning, ABI diagnosis, and test results.
- Do not design optional Node-only or browser-only packages. A package may be
  temporarily marked failing on one host, but the target support contract is
  both hosts.
- Do not make complete upstream test success the default bottle publication
  gate. Bottle availability requires build/install plus required Node/browser
  smoke; upstream test status remains visible as pass, fail, partial, skipped,
  incomplete, or unavailable.
- Do not hide package, runtime, VFS, libc, syscall, or kernel defects with
  formula-specific shortcuts.
- Do not patch Homebrew dependency resolution, install behavior, or Formula DSL
  semantics unless upstream Homebrew cannot be made to express the needed
  Kandelo wasm target boundary.
- Do not rename package IDs during migration unless a specific Formula
  collision or Homebrew constraint requires it and is recorded.

## Current Inventory Summary

Registry scan results from the merged `kd-5yd` worktree after `origin/main`
PR #785:

- 73 directories contain a valid `package.toml`.
- 2 directories under `packages/registry/` do not contain `package.toml`:
  `node-compat` and `npm`. They are support data today, not publishable
  packages.
- Package kinds: 65 `program`, 7 `library`, 1 `source`.
- Architectures: 66 packages are `wasm32`; 7 packages declare both `wasm32`
  and `wasm64`.
- No package manifest was missing a source sha256 or SPDX license field.
- Three manifests have no build script, `build.toml.revision`, or binary index
  entry: `kernel-test-programs`, `pcre2-source`, and `sqlite-cli`.
- Current `ABI_VERSION` is 16. Manifest `kernel_abi` values are not current:
  64 packages say 7, one says 13, two say 14, two say 15, one says 16
  (`hello`), and three omit it.
- Current Homebrew evidence is uneven by design: `hello` is the trusted
  wasm32 bottle publication reference from `kd-8ho`; `zlib` is the first
  dependency-root Formula proof from `kd-1mr.1`, verified locally for wasm32
  and wasm64 with sidecars and host-gate cleanup, but not trusted-published as
  part of that bead.

The stale `kernel_abi` values are not just cleanup. ABI must become artifact
compatibility identity in the Homebrew-backed model: bottle names, sidecar
status, fallback selection, rebuild progress, and failure messages must make it
clear whether a package is unavailable because of ABI coverage versus package,
source, build, runtime, host, or test failure.

## Target Package Model

Formulae become source of truth:

- Formulae own source, dependencies, build/install/test behavior, and the normal
  Homebrew package identity.
- The temporary migration bridge may generate Formulae from
  `packages/registry`, but the bridge is scaffolding. It should be deleted
  after tap Formulae and supporting Homebrew tooling can replace it.
- `packages/registry` disappears entirely if the replacement succeeds. Any
  registry role that cannot move must be identified as a blocker or explicit
  non-Homebrew artifact.

Sidecars remain additive:

- Kandelo sidecars record provenance, ABI, status, outcome lists, host smoke,
  upstream test artifacts, gallery availability, precomposed VFS image inputs,
  and package-index diagnostics.
- Sidecars may be required by Kandelo's browser/gallery/VFS tooling, but not by
  ordinary `brew install` behavior.
- Failed or deferred packages stay in sidecar/index metadata with reason,
  status, attempted run, host coverage, fallback if any, and next action.

Artifact storage:

- Use GitHub Packages as the product surface for bottle storage.
- Use the GHCR/OCI package namespace as the underlying storage mechanism when
  Homebrew bottle publishing uses container-style blobs.
- Keep package names, architecture, ABI, Formula revision, bottle rebuild,
  cache key, sha256, byte count, tap commit, Kandelo commit, and CI run URL in
  the sidecar/provenance record.

Host support:

- Node and browser are required hosts for Kandelo wasm packages.
- Browser compatibility is not a separate package tier. It is evidence that the
  same package works in the browser host through the normal Kandelo runtime.
- A host failure should appear as status, not disappear from discovery.

## Users And Operator Workflows

Maintainer inventory workflow:

1. Parse current registry manifests and build state.
2. Classify every entry as Formula-ready, Formula-needs-fix, source/helper,
   internal/non-package, precomposed VFS image, composite runtime package, or
   blocked.
3. Generate or hand-author initial Formulae through the temporary bridge.
4. Validate that the Formula captures source, dependencies, build, install, and
   test behavior that had been split across `package.toml`, `build.toml`, and
   package build scripts.
5. Record any role that cannot move out of `packages/registry`.

Trusted publish workflow now that `kd-8ho` is closed:

1. Build bottles from Formulae in trusted CI.
2. Store bottle blobs in GitHub Packages/GHCR.
3. Generate additive Kandelo sidecars and provenance from CI evidence and local
   bottle bytes.
4. Run the Homebrew sidecar/schema validator.
5. Run required Node and browser smoke for packages before marking host
   compatibility green.
6. Run complete upstream tests when supported by the Formula/test harness and
   publish detailed status artifacts. Do not block default bottle availability
   on full upstream suite success.
7. Keep failures visible with package/setup/runtime/platform/test categories
   and exact reasons.

Debugging workflow:

1. A failed package entry should say whether the failure is in source
   acquisition, Formula generation, Homebrew build, dependency bottle,
   install/link, fork instrumentation, precomposed VFS image materialization,
   Node smoke, browser smoke, upstream tests, or Kandelo platform behavior.
2. Last-green fallback metadata should be visible whenever fallback is used.
3. A package should remain discoverable as failing, deferred, unavailable, or
   partial instead of disappearing from the index.

## Architecture And Data Flow

The migration should converge on this model:

```text
temporary registry bridge
  reads packages/registry while it still exists
        |
        v
Automattic/kandelo-homebrew
  Formula/<name>.rb                  source of truth
  Kandelo/metadata.json              additive index/status
  Kandelo/formula/<name>.json        additive formula summary
  Kandelo/link/<name>-...json        additive VFS pour/link plan
  Kandelo/reports/<name>-...json     provenance, host, test outcomes
        |
        v
trusted Homebrew bottle workflow
        |
        v
GitHub Packages / GHCR bottle blobs
        |
        v
Homebrew install path
        |
        v
Kandelo Node smoke + browser smoke
        |
        v
optional complete upstream tests with published outcome artifacts
        |
        v
precomposed VFS images and composite runtime packages when needed
```

The VFS planner remains shared by Node and browser callers. The bottle
pour/link builder remains Node-side build tooling that consumes generated JSON
and verified bottle bytes. Browser support comes from a browser host consuming a
precomposed `.vfs.zst` image and running the package through the normal Kandelo
runtime path, not from browser-side bottle extraction.

### Naming

Use the existing tap repository `Automattic/kandelo-homebrew`. Formula filenames
and sidecar package IDs should match current registry package names where
possible, for example `Formula/zlib.rb` and `Kandelo/formula/zlib.json`.
Operators should use tap-qualified Formula references for names that collide
with upstream Homebrew core Formulae.

Do not prefix every Formula with `kandelo-` unless Homebrew mechanics force the
issue. Keeping package IDs stable preserves the dependency graph and makes the
registry removal path easier to audit.

## Package Inventory And Disposition

| Package | Kind | Arches | Direct deps | Homebrew disposition |
|---|---|---|---:|---|
| `bash` | program | wasm32 | 1 | Formula candidate; requires build/install plus Node/browser shell smoke and upstream test status when available. |
| `bc` | program | wasm32 | 0 | Formula candidate; small CLI wave with smoke and upstream test status. |
| `bzip2` | program | wasm32 | 0 | Formula candidate; small CLI wave with compression/decompression smoke. |
| `coreutils` | program | wasm32 | 0 | Formula candidate; multi-output CLI package with representative command smoke and upstream test status. |
| `cpython` | program | wasm32 | 1 | Heavy runtime Formula; requires interpreter/module smoke on Node and browser plus upstream test harness status. |
| `curl` | program | wasm32 | 3 | Formula candidate after `libcurl`, `zlib`, and `openssl`; network smoke must not hide host limits. |
| `dash` | program | wasm32 | 0 | Formula candidate; shell semantics smoke and upstream tests are important because many packages depend on shell behavior. |
| `diffutils` | program | wasm32 | 0 | Formula candidate; multi-output CLI smoke. |
| `dinit` | program | wasm32 | 1 | Formula candidate after `libcxx`; required by composite runtime packages. |
| `erlang` | program | wasm32 | 0 | Heavy runtime Formula; VM startup and representative concurrency smoke on both hosts. |
| `erlang-vfs` | program | wasm32 | 1 | Precomposed VFS image/composite runtime package; depends on `erlang` Formula evidence. |
| `fbdoom` | program | wasm32 | 0 | Formula candidate; framebuffer/audio/input evidence required before compatibility claim. |
| `file` | program | wasm32 | 0 | Formula candidate; CLI smoke against known files. |
| `findutils` | program | wasm32 | 0 | Formula candidate; multi-output CLI smoke. |
| `gawk` | program | wasm32 | 0 | Formula candidate; interpreter smoke and upstream test status. |
| `git` | program | wasm32 | 0 | Formula candidate; smoke local repository operations, not network success only. |
| `grep` | program | wasm32 | 0 | Formula candidate; CLI smoke and upstream test status. |
| `gzip` | program | wasm32 | 0 | Formula candidate; compression/decompression smoke. |
| `hello` | program | wasm32 | 0 | Already the first trusted wasm32 bottle reference; keep as control package for schema, sidecar, Node/browser smoke, and publication regression checks. |
| `kandelo-sdk` | program | wasm32 | 1 | Platform/internal artifact; decide whether it becomes a Formula or remains outside the replacement model. |
| `kernel` | program | wasm32 | 0 | Platform/internal artifact; decide whether Homebrew should own it or binary releases remain authoritative. |
| `kernel-test-programs` | program | wasm32 | 0 | Manifest-incomplete internal test bundle; classify before registry removal. |
| `lamp` | program | wasm32 | 6 | Composite runtime package/precomposed VFS image; requires service smoke on Node and browser. |
| `less` | program | wasm32 | 0 | Formula candidate; PTY smoke. |
| `libcurl` | library | wasm32 | 2 | Library Formula after `zlib` and `openssl`; dependency-root status should remain visible. |
| `libcxx` | library | wasm32, wasm64 | 0 | Library Formula; verify Nix/source discipline and both declared architectures. |
| `libpng` | library | wasm32 | 1 | Library Formula after `zlib`; smoke through a consumer if upstream tests are not useful alone. |
| `libxml2` | library | wasm32, wasm64 | 1 | Library Formula after `zlib`; both host compatibility through consumers. |
| `lsof` | program | wasm32 | 0 | Formula candidate; smoke output against Kandelo `/proc` expectations. |
| `m4` | program | wasm32 | 0 | Formula candidate; CLI smoke. |
| `make` | program | wasm32 | 0 | Formula candidate; smoke a small Makefile build. |
| `mariadb` | program | wasm32, wasm64 | 2 | Heavy service/runtime Formula; Aria/InnoDB smoke and upstream test status remain visible. |
| `mariadb-test` | program | wasm32 | 3 | Composite runtime package for test execution; depends on `mariadb`, `dash`, and `dinit`. |
| `mariadb-vfs` | program | wasm32, wasm64 | 3 | Precomposed VFS image/composite runtime package; Node/browser service smoke required. |
| `modeset` | program | wasm32 | 0 | Formula candidate; framebuffer path must be validated on browser and Node where applicable. |
| `msmtpd` | program | wasm32 | 0 | Formula candidate; service smoke should exercise SMTP capture. |
| `nano` | program | wasm32 | 0 | Formula candidate; PTY startup/edit/exit smoke. |
| `ncurses` | program | wasm32 | 0 | Hybrid program/library Formula; must preserve terminal utilities and link-time artifacts. |
| `netcat` | program | wasm32 | 0 | Formula candidate; TCP and UDP loopback smoke. |
| `nethack` | program | wasm32 | 1 | Formula candidate after `ncurses`; terminal startup smoke. |
| `nethack-browser-bundle` | program | wasm32 | 1 | Composite runtime package/precomposed VFS image; package must still satisfy both-host policy. |
| `nginx` | program | wasm32 | 0 | Service Formula; smoke with dinit/service-worker path in composite package wave. |
| `node` | program | wasm32 | 1 | Heavy runtime Formula backed by SpiderMonkey; Node-compatible entrypoint smoke on both Kandelo hosts. |
| `node-compat` | registry directory | - | - | Support data only today; move under owning Formula/tooling or make an explicit helper package. |
| `node-vfs` | program | wasm32 | 2 | Precomposed VFS image/composite runtime package; npm/runtime assets and both hosts required. |
| `npm` | registry directory | - | - | Support fetch data only today; fold into `node`/`node-vfs` Formula ownership or classify helper. |
| `openssl` | library | wasm32, wasm64 | 0 | Library Formula; source/license/provenance and both arch status are critical. |
| `pcre2-source` | source | wasm32 | 0 | Source/helper package for MariaDB; decide whether Homebrew Formula, resource, or vendored source is correct. |
| `perl` | program | wasm32 | 0 | Heavy runtime Formula; interpreter/module smoke and upstream test status. |
| `perl-vfs` | program | wasm32 | 1 | Precomposed VFS image/composite runtime package; depends on `perl`. |
| `php` | program | wasm32 | 4 | Heavy runtime Formula; smoke CLI, PHP-FPM path, SQLite, OpenSSL, zlib, and XML extensions. |
| `posix-utils-lite` | program | wasm32 | 0 | Formula candidate; broad multi-output CLI smoke. |
| `python-vfs` | program | wasm32 | 1 | Precomposed VFS image/composite runtime package; depends on `cpython`. |
| `redis` | program | wasm32 | 0 | Service Formula; TCP server and background-thread smoke. |
| `rootfs` | program | wasm32 | 14 | Composite runtime package/precomposed VFS image; depends on leaf CLI package status. |
| `ruby` | program | wasm32 | 1 | Heavy runtime Formula; existing Homebrew runtime-extension support is a focused smoke target. |
| `sed` | program | wasm32 | 0 | Formula candidate; CLI smoke. |
| `shell` | program | wasm32 | 19 | Composite runtime package/precomposed VFS image; depends on rootfs and interactive tools. |
| `spidermonkey` | program | wasm32 | 3 | Heavy runtime Formula; isolate build capacity and smoke JS shell before Node wrapper. |
| `spidermonkey-node` | program | wasm32 | 1 | Dependent Formula after `spidermonkey`; Node-compatible entrypoint smoke. |
| `sqlite` | library | wasm32, wasm64 | 0 | Library Formula; keep upstream SQLite test status visible separately from bottle gate. |
| `sqlite-cli` | program | wasm32 | 0 | Manifest-incomplete package; revive as Formula or remove/exclude before registry deletion. |
| `tar` | program | wasm32 | 0 | Formula candidate; archive create/extract smoke. |
| `tcl` | program | wasm32 | 0 | Formula candidate; interpreter startup and representative script smoke. |
| `texlive` | program | wasm32 | 2 | Heavy runtime/data Formula; size/quota and upstream test strategy required. |
| `unzip` | program | wasm32 | 0 | Formula candidate; archive extraction smoke. |
| `userspace` | program | wasm32 | 0 | Platform/internal artifact; decide Homebrew ownership versus existing release path. |
| `vim` | program | wasm32 | 0 | Formula candidate; runtime tree/lazy archive implications must be explicit. |
| `vim-browser-bundle` | program | wasm32 | 1 | Composite runtime package/precomposed VFS image; package must still satisfy both-host policy. |
| `wget` | program | wasm32 | 0 | Formula candidate; HTTPS/network behavior without hiding host limits. |
| `wordpress` | program | wasm32 | 5 | Composite runtime package/precomposed VFS image; HTTP/admin/service smoke required. |
| `xz` | program | wasm32 | 0 | Formula candidate; compression/decompression smoke. |
| `zip` | program | wasm32 | 0 | Formula candidate; archive create/list smoke. |
| `zlib` | library | wasm32, wasm64 | 0 | First dependency-root Formula proof completed in `kd-1mr.1`; use its wasm32/wasm64 evidence and remaining limitations to shape the next pilot. |
| `zstd` | program | wasm32 | 0 | Formula candidate; compression/decompression smoke. |

## Migration Waves

These are dispatch waves, not necessarily one PR each. `kd-8ho` and `kd-uqyg`
are no longer gates, and `zlib` has already proved the first dependency-root
path. The next step should be a small pilot that exercises one more
dependency-root package plus a couple of small leaf programs before broad waves
are created.

### Wave 0: Replacement Contract And Bridge Hygiene

Gate: no longer blocked on `kd-8ho`, but broad publication waits for pilot
evidence. `kd-c6p` is the existing docs bead for the registry-replacement
model and should wake after this inventory plan is closed.

Work:

- Define the Homebrew replacement contract: Formulae authoritative, sidecars
  additive, package failures visible, and `packages/registry` temporary.
- Define ABI artifact identity for Formula sidecars, bottle names, fallbacks,
  rebuild progress, and user-facing failure reasons.
- Define the package status schema for build/install smoke, Node smoke, browser
  smoke, full upstream tests, known failures, skipped cases, incomplete cases,
  artifacts, and host results.
- Decide `node-compat` and `npm` ownership: move under owning Formula/tooling,
  add helper Formulae, or remove from registry scope.
- Decide `kernel-test-programs`, `sqlite-cli`, `pcre2-source`, `kernel`,
  `userspace`, and `kandelo-sdk` Homebrew ownership before registry removal.
- Add a generated inventory/check mode that fails when a registry directory is
  not classified.

### Wave 1: Dependency Roots And Hybrid Inputs

Packages:

- `openssl`, `sqlite`, `libcxx`, `libxml2`, `libpng`, `libcurl`,
  `ncurses`.

Rationale:

- They unblock most dependent packages.
- Seven packages already declare `wasm64` support; arch policy belongs in the
  sidecar/status model and should be visible per arch.
- `ncurses` is a hybrid program/library package and needs explicit Formula
  modeling for both executable outputs and link-time artifacts.
- `zlib` is removed from future dependency-root scope because `kd-1mr.1`
  already completed its local Homebrew Formula and bottle verification.

### Wave 2: Small Leaf CLI Programs

Packages:

- `bc`, `bzip2`, `coreutils`, `dash`, `diffutils`, `fbdoom`, `file`,
  `findutils`, `gawk`, `git`, `grep`, `gzip`, `less`, `lsof`, `m4`, `make`,
  `modeset`, `msmtpd`, `nano`, `netcat`, `posix-utils-lite`, `sed`, `tar`,
  `tcl`, `unzip`, `vim`, `wget`, `xz`, `zip`, `zstd`.

Rationale:

- Most have no direct registry dependencies and can validate Formula
  generation, GitHub Packages bottle storage, sidecar status, and smoke result
  publishing without the heavy runtime risk.
- Device, network, terminal, and framebuffer packages still need appropriate
  Node/browser smoke.

### Wave 3: Dependent Programs And Heavy Runtimes

Packages:

- `bash`, `curl`, `dinit`, `nethack`, `cpython`, `perl`, `ruby`, `php`,
  `erlang`, `redis`, `nginx`, `spidermonkey`, `spidermonkey-node`, `node`,
  `mariadb`, `texlive`.

Rationale:

- These depend on wave 1/2 artifacts or carry high build/runtime risk.
- Heavy packages should run as separate child beads or very small batches.
- Runtime smoke must use normal Kandelo exec/service paths and both hosts.
- Full upstream test support is required as status, but not as the default
  bottle availability gate.

### Wave 4: Base And Language Composite Runtime Packages

Packages:

- `rootfs`, `shell`, `python-vfs`, `perl-vfs`, `erlang-vfs`,
  `vim-browser-bundle`, `nethack-browser-bundle`, `node-vfs`.

Rationale:

- These validate that bottle sidecars can be poured/linked into useful
  precomposed VFS images.
- They are composite runtime packages, not browser-only packages; they must
  satisfy the same Node/browser policy as all Kandelo packages.

### Wave 5: Service And Application Composite Runtime Packages

Packages:

- `mariadb-vfs`, `mariadb-test`, `lamp`, `wordpress`.

Rationale:

- These combine dinit, service-worker HTTP, loopback networking, databases,
  PHP/WordPress, mail capture, and browser state.
- MariaDB storage engine or service failures should remain visible as package,
  setup, runtime, test, host, or platform failures, not hidden from discovery.

## CI, GitHub Packages, And Capacity Expectations

- Use GitHub Packages as the named product surface and GHCR/OCI as the storage
  namespace/mechanism for bottle blobs.
- Keep the first real publication wave small until tap permissions, package
  permissions, sidecar validation, and GitHub Packages upload behavior are
  boring.
- Split heavy packages so one timeout does not starve the whole Formula matrix.
- Publish sidecars and bottles only from trusted workflows with permissions
  proven by `kd-8ho`.
- Record pass/fail/skip/incomplete outcome lists for required smoke and
  upstream test runs.
- Keep package failures visible in the Homebrew-backed index with specific
  reasons and next action.
- Prefer fixing package build scripts or Kandelo platform gaps over
  Homebrew-only retry/skip behavior.

## Test And Outcome Plan

Default bottle availability gate:

- Formula parses and passes selected Homebrew syntax/audit checks.
- Bottle builds and installs through upstream Homebrew semantics plus the
  minimal Kandelo target-architecture support.
- Sidecar/provenance validates.
- Required Node smoke passes.
- Required browser smoke passes.

Complete upstream test support:

- Each Formula should define, or explicitly defer with reason, how to run the
  package's complete upstream test set under Kandelo.
- Upstream test success is not a default bottle gate.
- Upstream test status should be published as metadata so users and
  contributors can see correctness beyond installability.

Reusable outcome schema:

- Package name, version, Formula revision, bottle rebuild, arch, ABI, host,
  Kandelo commit, tap commit, run URL, start/end time.
- Build/install result: pass, fail, deferred, unavailable.
- Node smoke result and browser smoke result, each with pass/fail/skip counts
  and specific failures.
- Upstream test result: pass, fail, partial, skipped, incomplete, unavailable.
- Counts for passed, failed, skipped, expected-fail, timeout, unsupported, and
  incomplete cases.
- Complete failure list with suite, case, command, exit status, signal/timeout,
  log/artifact path, and first relevant error.
- Skip reasons, known-failure references, host-specific notes, and whether the
  failure is package/setup/runtime/platform/test-infra.
- Artifact pointers for logs, summaries, raw harness output, sidecars, bottle
  reports, and precomposed VFS image reports.

Package-specific smoke examples:

- CLI tools: `--help` or `--version`, simple file I/O, stdin/stdout, and exit
  status.
- Shell/rootfs: `dash`, `bash`, PATH lookup, pipes, command substitution,
  `system()`/`popen()` consumers where relevant.
- Network tools: loopback TCP/UDP and HTTP/HTTPS where host boundaries permit.
- Services: dinit startup, port bind, request/response, clean shutdown.
- Language runtimes: interpreter startup, standard library/module load, zlib or
  OpenSSL extension where declared.
- Precomposed VFS images: `/etc/kandelo/homebrew-vfs.json`, demo metadata,
  selected executable paths, and Node/browser boot.

Broader gates:

- If a migration PR changes package build scripts, resolver behavior, VFS
  builder behavior, host runtime, or browser app behavior, select validation
  from `CLAUDE.md` and `docs/agent-guidance/validation.md`.
- If ABI-facing behavior changes, update `ABI_VERSION` and `abi/snapshot.json`
  according to the ABI contract.

## Documentation Plan

After the foundation docs in `kd-8ho.11` land, add or update:

- Homebrew tap operating docs: Formula authoring, sidecar generation,
  validator, bottle rebuild, rollback, failure triage, and GitHub Packages
  storage.
- Package authoring docs: how Formulae replace `packages/registry`, how to keep
  Homebrew patching minimal, and how to avoid Formula-specific workarounds.
- Package status docs: failure visibility, deferred/unavailable states, ABI
  compatibility identity, and upstream test outcome artifacts.
- Browser/user docs: how package discovery and gallery availability follow
  sidecar/index state and why browser support requires browser smoke.
- Migration docs: when the temporary registry bridge can be removed.

## Alternatives Considered

Keep Homebrew as a parallel export path:

- Rejected by direction. Homebrew should replace `packages/registry` if
  possible. Any remaining registry role must be explicitly justified.

Make sidecars authoritative for install behavior:

- Rejected. Formula DSL should remain authoritative for Homebrew install.
  Sidecars are additive Kandelo metadata.

Allow Node-only or browser-only package tiers:

- Rejected. Both hosts are required product surfaces. A host-specific failure is
  status to publish and work to prioritize, not an acceptable package tier.

Gate every bottle on complete upstream tests:

- Rejected as the default because it would hide useful installable packages
  behind long-running or currently failing upstream suites. Full upstream test
  support and status are required; success is not the default bottle gate.

All-at-once matrix:

- Rejected for first migration because 73 packages plus wasm64 variants,
  precomposed VFS images, and composite runtime packages would make failures
  hard to classify and could overload Actions or GitHub Packages.

Prefix every Formula with `kandelo-`:

- Rejected for now. Tap-qualified Formula references should handle name
  ambiguity while preserving current package IDs and dependency graph clarity.

Treat source-only and internal artifacts as normal Formulae:

- Rejected until ownership is decided. `pcre2-source`, platform artifacts, and
  manifest-incomplete entries need explicit contracts before registry removal.

## Risks And Mitigations

Registry replacement stalls halfway:

- Risk: Formulae and registry manifests could diverge if both remain active too
  long.
- Mitigation: make the bridge temporary, define deletion criteria, and block
  long-term duplicate source-of-truth behavior.

ABI confusion:

- Risk: users or operators cannot tell whether a package is unavailable because
  of ABI rebuild state or a package/runtime failure.
- Mitigation: make ABI explicit in artifact identity, sidecars, fallback
  metadata, and failure reasons while keeping normal install UX quiet.

Homebrew patch drift:

- Risk: Kandelo-specific Homebrew patches could fork dependency/install
  semantics and make Formulae less portable.
- Mitigation: keep patches minimal and target architecture support first; treat
  dependency/install/DSL patches as design warnings.

Browser parity drift:

- Risk: Node smoke passes while browser boot, SharedArrayBuffer, service
  worker, OPFS, or UI loading fails.
- Mitigation: require browser smoke for package compatibility status; publish
  host-specific failures visibly.

Failed package invisibility:

- Risk: removing failed/deferred packages from discovery hides work and
  discourages community help.
- Mitigation: keep failed/deferred/unavailable entries visible with reasons,
  artifacts, and next actions.

License/source distribution:

- Risk: GPL or mixed-license packages need audit-ready source provenance and
  possibly sibling source archives.
- Mitigation: preserve source URL/sha/license in Formulae and sidecars and add
  source-distribution follow-up before broad public expansion if required.

CI and GitHub Packages quota:

- Risk: large packages like SpiderMonkey, MariaDB, TexLive, PHP, Ruby, and
  precomposed VFS images can consume runner time, storage, and package quota.
- Mitigation: split heavy packages into separate beads, record byte sizes, and
  avoid all-at-once publication until capacity is measured.

## Proposed Migration Child Beads

Do not create the old seven broad beads now. The live convoy already has
`kd-1mr.1` closed for `zlib`, `kd-1mr.1.1` closed for its host-gate blocker,
and `kd-c6p` open for registry-replacement documentation after this plan. The
minimal next work is one implementation pilot plus the existing docs bead.

1. Existing: `kd-c6p` - `[homebrew-all] Document Homebrew registry replacement
   model`
   - Scope: authoritative docs for Formulae as source of truth, sidecars as
     additive metadata, failure visibility, ABI identity, Node/browser support,
     upstream test outcome artifacts, and registry removal.
   - Next action: wake after `kd-5yd` closes. Do not create another docs bead
     for the same model.

2. Created: `kd-1mr.2` - `[homebrew-all] Port sqlite, bzip2, and xz
   Homebrew pilot`
   - Scope: `sqlite` as the next dependency-root and upstream-test-status
     package, plus `bzip2` and `xz` as small leaf CLI packages that exercise
     program install/smoke behavior without heavy runtime risk.
   - Use `hello` trusted-publication evidence and `zlib` local wasm32/wasm64
     evidence as controls.
   - Required evidence: Formula syntax and Homebrew bottle build/test results,
     sidecar/provenance validation, required Node smoke, required browser smoke
     or explicit host-failure status, complete pass/fail/skip/incomplete
     outcome lists for substantive package and upstream-test runs, and clear
     distinction between local dry-run evidence and trusted GHCR/tap
     publication.
   - Implement only the bridge/status/tooling gaps needed for these packages.
     If the pilot exposes reusable schema or bridge work that cannot fit
     cleanly, create one focused blocker/follow-up bead from that evidence.
   - Blocks creation of broad dependency-root, small-CLI, heavy-runtime, and
     composite-runtime waves.

After this pilot reports actual capacity and failure modes, create the next
specific package bead from evidence. Do not pre-create broad runtime or
composite package beads merely because they appear in the inventory.

## Implementation Sequence

1. Close `kd-5yd` after recording this refreshed plan, review gauntlet, and the
   created pilot bead.
2. Wake `kd-c6p` for registry-replacement reference documentation.
3. Run the sqlite/bzip2/xz pilot from its own managed worktree and branch.
4. Use the pilot's evidence to decide whether the next bead should be another
   dependency-root package, a small CLI batch, a schema/bridge blocker, or a
   package-specific runtime blocker.
5. Classify registry exceptions and platform artifacts before attempting
   registry deletion, but do not block the pilot on deletion planning.
6. Port heavy runtimes and dependent programs only after dependency-root and
   small CLI evidence is boring enough to split by capacity rather than guess.
7. Port precomposed VFS images and composite runtime packages after their
   component Formulae have sidecars and Node/browser status.
8. Remove `packages/registry` only after Formulae, sidecars, Homebrew tooling,
   tests, docs, and fallback operations cover every accepted registry role.

## Open Questions

- Should Kandelo upstream `wasm32_kandelo` and `wasm64_kandelo` support into
  Homebrew, or continue carrying the current minimal architecture-tag patch?
- Which `packages/registry` roles cannot move to Formulae and why?
- Should platform artifacts (`kernel`, `userspace`, `kandelo-sdk`,
  `kernel-test-programs`) live in the Homebrew tap, existing binary releases,
  or both?
- Should `pcre2-source` become a Formula resource, a helper Formula, or a
  MariaDB Formula resource?
- Should `sqlite-cli` be revived with a Formula or removed from the accepted
  package set?
- What GitHub Packages retention and quota policy should apply to large bottle
  and precomposed VFS image histories?
- What source-distribution requirements apply to GPL-family packages in the
  GitHub Packages bottle path?
- Which smoke commands are sufficient to mark each package compatible on both
  Node and browser hosts?
