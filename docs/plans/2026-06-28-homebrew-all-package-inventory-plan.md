# Homebrew All Packages Inventory And Migration Plan

Date: 2026-06-28

Tracked work:

- `kd-1mr` - Port all current Kandelo packages to Homebrew.
- `kd-5yd` - Inventory packages and plan Homebrew migration waves.
- Blocker: `kd-8ho` remains the active Homebrew publishing foundation convoy.

This plan was produced from the `kd-5yd` worktree at `f4339836e` with the
current registry state under `packages/registry/`. It is intentionally a design
and inventory artifact. It does not publish bottles, edit package recipes, or
create implementation wave beads before the `kd-8ho` foundation gate closes or
an explicit override is recorded.

## Problem Statement

Kandelo has a package registry with libraries, programs, source trees, internal
platform artifacts, and composite VFS/browser images. The current Homebrew
foundation work proves a first bottle path and defines generated sidecar
metadata, provenance, VFS planning, and bottle pour/link behavior. The next
stage is not simply "run every package in CI": package types, dependency order,
browser/runtime claims, source and license audit state, ABI compatibility, and
CI/GHCR capacity all differ.

The work needs a durable package inventory and a migration sequence that:

- covers every current `packages/registry/` entry;
- preserves the split between `package.toml` recipe data and `build.toml`
  project publish state;
- keeps `build.toml.revision` as output-byte cache invalidation, not progress
  tracking;
- gives Node and browser hosts equal consideration when a package exposes
  runtime behavior;
- makes unsupported, stale, or platform-internal entries visible instead of
  forcing them through a formula shape that misrepresents them;
- stages work so trusted tap/GHCR publication and Actions capacity are not
  overloaded by one all-at-once matrix.

## Non-Goals

- Do not begin package bottle publication while `kd-8ho` is still in progress.
- Do not evaluate Formula Ruby in Kandelo VFS builders.
- Do not replace the existing Kandelo binary release/index-ledger resolver in
  this migration; Homebrew bottles are an additional publish surface.
- Do not hide package, runtime, VFS, libc, syscall, or host defects with
  formula-specific shortcuts.
- Do not claim browser compatibility from a Node-only bottle or VFS smoke.
- Do not rename package IDs during migration unless a specific formula collision
  or Homebrew constraint requires it and is recorded.

## Current Inventory Summary

Registry scan results:

- 72 directories contain a valid `package.toml`.
- 2 directories under `packages/registry/` do not contain `package.toml`:
  `node-compat` and `npm`. They are support data, not publishable packages.
- Package kinds: 64 `program`, 7 `library`, 1 `source`.
- Architectures: 65 packages are `wasm32`; 7 packages declare both `wasm32`
  and `wasm64`.
- No package manifest was missing a source sha256 or SPDX license field.
- Three manifests have no build script, `build.toml.revision`, or binary index
  entry: `kernel-test-programs`, `pcre2-source`, and `sqlite-cli`.
- Current `ABI_VERSION` is 16. Manifest `kernel_abi` values are not current:
  64 packages say 7, one says 13, two say 14, two say 15, and three omit it.
  The first migration wave must settle whether this field remains authoritative
  for Homebrew formula generation or is recomputed from build evidence.

## Users And Operator Workflows

Maintainer inventory workflow:

1. Parse `packages/registry/*/package.toml` and `build.toml`.
2. Validate source URL, sha256, license, outputs, build script path, revision,
   binary index, declared arches, and dependency graph.
3. Classify each entry as library, standalone program, heavy runtime/service,
   composite VFS/browser image, source resource, or platform/internal artifact.
4. Record package-specific blockers before bottle work, rather than letting
   publish CI discover them one package at a time.

Trusted publish workflow after `kd-8ho` closes:

1. Generate formula files in `Automattic/kandelo-homebrew` with package IDs
   matching registry names.
2. Build bottles in dependency-sized batches.
3. Generate Kandelo sidecars, link manifests, and provenance reports from CI
   evidence and local bottle bytes.
4. Run `cargo xtask homebrew-validate` over the tap checkout.
5. Publish bottles to GHCR and sidecars to the tap/release only after validator
   success.
6. For packages that expose runtime behavior, build a precomposed Homebrew VFS
   image and run Node smoke first, then browser smoke before setting or
   documenting `browser_compatible = true`.

Debugging workflow:

1. Treat failures as package/setup/runtime categories in the report:
   source/hash/license, formula generation, build script, dependency bottle,
   fork instrumentation, VFS pour/link, Node runtime, browser runtime, or
   platform defect.
2. Preserve last-green fallback metadata visibly when sidecars use fallback.
3. Keep failed bottles in metadata with exact error and run evidence; do not
   remove failed package state from the inventory to make the release look
   green.

## Architecture And Data Flow

The migration should layer on the `kd-8ho` foundation contracts:

```text
packages/registry/<name>/{package.toml,build.toml}
        |
        v
registry inventory + formula input generator
        |
        v
Automattic/kandelo-homebrew
  Formula/<name>.rb
  Kandelo/metadata.json
  Kandelo/formula/<name>.json
  Kandelo/link/<name>-<version>-rebuild<N>-<arch>.json
  Kandelo/reports/<name>-<version>-rebuild<N>-<arch>.provenance.json
        |
        v
cargo xtask homebrew-validate
        |
        v
Homebrew bottle bytes in GHCR + sidecar metadata
        |
        v
planHomebrewVfs() and build-homebrew-vfs-image.ts
        |
        v
Node runtime smoke, browser runtime smoke, gallery/user documentation
```

The VFS planner remains shared by Node and browser callers. The bottle
pour/link builder remains Node-side build tooling that consumes only generated
JSON and verified bottle bytes; browser support comes from consuming a
precomposed `.vfs.zst` image, not from browser-side bottle extraction.

### Naming

Use the existing tap repository `Automattic/kandelo-homebrew`. Formula filenames
and sidecar package IDs should match the registry package name exactly, for
example `Formula/zlib.rb` and `Kandelo/formula/zlib.json`. Operators should use
tap-qualified formula references for names that collide with upstream Homebrew
core formulae. Do not prefix every formula with `kandelo-`; the sidecar
contracts and dependency graph are clearer when the package ID remains the
registry ID.

Formula metadata should still record the tap-qualified full name emitted by the
final `kd-8ho` tap workflow. If Homebrew tap naming mechanics require a
different user-facing qualifier for `Automattic/kandelo-homebrew`, keep the
registry package ID stable and update only the generated `full_name`.

## Package Inventory And Disposition

| Package | Kind | Arches | Direct deps | Homebrew disposition |
|---|---|---|---:|---|
| `bash` | program | wasm32 | 1 | Program formula candidate; bottle in a dependency wave with CLI smoke. |
| `bc` | program | wasm32 | 0 | Program formula candidate; bottle in a dependency wave with CLI smoke. |
| `bzip2` | program | wasm32 | 0 | Program formula candidate; bottle in a dependency wave with CLI smoke. |
| `coreutils` | program | wasm32 | 0 | Program formula candidate; bottle in a dependency wave with CLI smoke. |
| `cpython` | program | wasm32 | 1 | Heavy runtime formula; bottle after direct libs and require focused runtime smoke. |
| `curl` | program | wasm32 | 3 | Program formula candidate; bottle after `libcurl`, `zlib`, and `openssl`. |
| `dash` | program | wasm32 | 0 | Program formula candidate; bottle in a dependency wave with CLI smoke. |
| `diffutils` | program | wasm32 | 0 | Program formula candidate; bottle in a dependency wave with CLI smoke. |
| `dinit` | program | wasm32 | 1 | Program formula candidate; bottle after `libcxx`; required by service VFS images. |
| `erlang` | program | wasm32 | 0 | Heavy runtime formula; bottle with VM startup smoke before `erlang-vfs`. |
| `erlang-vfs` | program | wasm32 | 1 | Composite VFS formula; requires Node and browser image smoke. |
| `fbdoom` | program | wasm32 | 0 | Program formula candidate; smoke framebuffer/audio/input separately from basic exec. |
| `file` | program | wasm32 | 0 | Program formula candidate; bottle in a dependency wave with CLI smoke. |
| `findutils` | program | wasm32 | 0 | Program formula candidate; bottle in a dependency wave with CLI smoke. |
| `gawk` | program | wasm32 | 0 | Program formula candidate; bottle in a dependency wave with CLI smoke. |
| `git` | program | wasm32 | 0 | Program formula candidate; smoke local repository operations, not network success only. |
| `grep` | program | wasm32 | 0 | Program formula candidate; bottle in a dependency wave with CLI smoke. |
| `gzip` | program | wasm32 | 0 | Program formula candidate; bottle in a dependency wave with CLI smoke. |
| `kandelo-sdk` | program | wasm32 | 1 | Platform/internal artifact; decide tap ownership before bottle work. |
| `kernel` | program | wasm32 | 0 | Platform/internal artifact; decide tap ownership before bottle work. |
| `kernel-test-programs` | program | wasm32 | 0 | Manifest-incomplete internal test bundle; keep out of bottle waves until ownership is decided. |
| `lamp` | program | wasm32 | 6 | Composite service VFS formula; requires Node and browser service smoke. |
| `less` | program | wasm32 | 0 | Program formula candidate; bottle in a dependency wave with CLI smoke. |
| `libcurl` | library | wasm32 | 2 | Library formula candidate; bottle after `zlib` and `openssl`. |
| `libcxx` | library | wasm32, wasm64 | 0 | Library formula candidate; bottle early and verify Nix-only source discipline. |
| `libpng` | library | wasm32 | 1 | Library formula candidate; bottle after `zlib`. |
| `libxml2` | library | wasm32, wasm64 | 1 | Library formula candidate; bottle after `zlib`. |
| `lsof` | program | wasm32 | 0 | Program formula candidate; smoke output against Kandelo `/proc` expectations. |
| `m4` | program | wasm32 | 0 | Program formula candidate; bottle in a dependency wave with CLI smoke. |
| `make` | program | wasm32 | 0 | Program formula candidate; smoke a small Makefile build. |
| `mariadb` | program | wasm32, wasm64 | 2 | Heavy service/runtime formula; bottle one arch at a time with Aria/InnoDB smoke. |
| `mariadb-test` | program | wasm32 | 3 | Composite test VFS formula; keep behind `mariadb`, `dash`, and `dinit` smoke. |
| `mariadb-vfs` | program | wasm32, wasm64 | 3 | Composite service VFS formula; Node/browser smoke must cover selected storage engines. |
| `modeset` | program | wasm32 | 0 | Program formula candidate; browser smoke must include framebuffer path before user claim. |
| `msmtpd` | program | wasm32 | 0 | Program formula candidate; service smoke should exercise SMTP capture. |
| `nano` | program | wasm32 | 0 | Program formula candidate; PTY smoke should cover startup and exit. |
| `ncurses` | program | wasm32 | 0 | Hybrid program/library package; formula must preserve both terminal utilities and link-time artifacts. |
| `netcat` | program | wasm32 | 0 | Program formula candidate; smoke TCP and UDP loopback. |
| `nethack` | program | wasm32 | 1 | Program formula candidate; bottle after `ncurses`, smoke startup. |
| `nethack-browser-bundle` | program | wasm32 | 1 | Composite browser bundle; browser smoke must verify lazy/runtime assets. |
| `nginx` | program | wasm32 | 0 | Service formula; smoke with dinit/service-worker HTTP path in composite wave. |
| `node` | program | wasm32 | 1 | Heavy runtime formula backed by SpiderMonkey; smoke REPL and package runtime paths. |
| `node-compat` | registry directory | - | - | Inventory exception: support data only; not a publishable package until manifest ownership is defined. |
| `node-vfs` | program | wasm32 | 2 | Composite VFS formula; browser smoke must verify npm/runtime assets. |
| `npm` | registry directory | - | - | Inventory exception: support fetch data only; not a publishable package until manifest ownership is defined. |
| `openssl` | library | wasm32, wasm64 | 0 | Library formula candidate; bottle early and keep source/license evidence audit-ready. |
| `pcre2-source` | source | wasm32 | 0 | Source resource for MariaDB; keep as source-only sidecar unless a real formula need appears. |
| `perl` | program | wasm32 | 0 | Heavy runtime formula; smoke interpreter, module load, and VFS image consumer. |
| `perl-vfs` | program | wasm32 | 1 | Composite VFS formula; requires Node and browser image smoke. |
| `php` | program | wasm32 | 4 | Heavy runtime formula; smoke CLI, PHP-FPM path, SQLite, OpenSSL, zlib, and XML extensions. |
| `posix-utils-lite` | program | wasm32 | 0 | Program formula candidate; broad multi-output CLI smoke. |
| `python-vfs` | program | wasm32 | 1 | Composite VFS formula; requires Node and browser REPL/script smoke. |
| `redis` | program | wasm32 | 0 | Service formula; smoke TCP server and background-thread behavior. |
| `rootfs` | program | wasm32 | 14 | Composite base image; build after leaf CLI tools and smoke shell path in Node/browser. |
| `ruby` | program | wasm32 | 1 | Heavy runtime formula; use existing Homebrew runtime-extension support as a focused smoke target. |
| `sed` | program | wasm32 | 0 | Program formula candidate; bottle in a dependency wave with CLI smoke. |
| `shell` | program | wasm32 | 19 | Composite shell image; build after rootfs and interactive tools, then Node/browser shell smoke. |
| `spidermonkey` | program | wasm32 | 3 | Heavy runtime formula; isolate build capacity and smoke JS shell before Node wrapper. |
| `spidermonkey-node` | program | wasm32 | 1 | Dependent program formula; bottle after `spidermonkey`, smoke Node-compatible entrypoint. |
| `sqlite` | library | wasm32, wasm64 | 0 | Library formula candidate; bottle early and keep separate from SQLite test harness convoy results. |
| `sqlite-cli` | program | wasm32 | 0 | Manifest-incomplete package; add build/publish ownership or exclude from bottle waves. |
| `tar` | program | wasm32 | 0 | Program formula candidate; bottle in a dependency wave with CLI smoke. |
| `tcl` | program | wasm32 | 0 | Program formula candidate; smoke interpreter startup and representative script. |
| `texlive` | program | wasm32 | 2 | Heavy runtime/data formula; likely needs size/quota gating before bottle publication. |
| `unzip` | program | wasm32 | 0 | Program formula candidate; bottle in a dependency wave with CLI smoke. |
| `userspace` | program | wasm32 | 0 | Platform/internal artifact; decide tap ownership before bottle work. |
| `vim` | program | wasm32 | 0 | Program formula candidate; runtime tree/lazy archive implications must be explicit. |
| `vim-browser-bundle` | program | wasm32 | 1 | Composite browser bundle; browser smoke must verify lazy/runtime assets. |
| `wget` | program | wasm32 | 0 | Program formula candidate; smoke HTTPS/network behavior without hiding host limits. |
| `wordpress` | program | wasm32 | 5 | Composite service VFS formula; requires Node and browser HTTP/admin smoke. |
| `xz` | program | wasm32 | 0 | Program formula candidate; bottle in a dependency wave with CLI smoke. |
| `zip` | program | wasm32 | 0 | Program formula candidate; bottle in a dependency wave with CLI smoke. |
| `zlib` | library | wasm32, wasm64 | 0 | Library formula candidate; bottle first as the smallest dependency root. |
| `zstd` | program | wasm32 | 0 | Program formula candidate; bottle in a dependency wave with CLI smoke. |

## Migration Waves

These are dispatch waves, not necessarily one PR each. Each wave should become
one or more child beads after `kd-8ho` closes. Large waves should be split by
CI capacity and reviewability.

### Wave 0: Foundation Close And Registry Hygiene

Gate: `kd-8ho` closed, or explicit override.

Work:

- Reconcile `kernel_abi` policy against current ABI 16 before generating
  formula metadata.
- Decide `node-compat` and `npm` ownership: move them out of
  `packages/registry/`, add manifests, or record them as support-only.
- Decide `kernel-test-programs`, `sqlite-cli`, `pcre2-source`, `kernel`,
  `userspace`, and `kandelo-sdk` tap ownership before publication.
- Add a generated inventory check that fails when a registry directory is not
  classified.

### Wave 1: Library Roots And Hybrid Inputs

Packages:

- `zlib`, `openssl`, `sqlite`, `libcxx`, `libxml2`, `libpng`, `libcurl`,
  `ncurses`.

Rationale:

- They unblock most dependent packages.
- Seven packages already declare `wasm64` support; publish `wasm32` first unless
  the `kd-8ho` matrix capacity proves `wasm64` is cheap enough to include.
- `ncurses` is a hybrid program/library package and needs explicit link-path
  validation.

### Wave 2: Small Leaf CLI Programs

Packages:

- `bc`, `bzip2`, `coreutils`, `dash`, `diffutils`, `fbdoom`, `file`,
  `findutils`, `gawk`, `git`, `grep`, `gzip`, `less`, `lsof`, `m4`, `make`,
  `modeset`, `msmtpd`, `nano`, `netcat`, `posix-utils-lite`, `sed`, `tar`,
  `tcl`, `unzip`, `vim`, `wget`, `xz`, `zip`, `zstd`.

Rationale:

- Most have no direct registry dependencies and can be batched by build time.
- Use simple CLI smoke tests, but route device/network/framebuffer packages to
  package-specific runtime smokes where relevant.

### Wave 3: Dependent Programs And Language Runtimes

Packages:

- `bash`, `curl`, `dinit`, `nethack`, `cpython`, `perl`, `ruby`, `php`,
  `erlang`, `redis`, `nginx`, `spidermonkey`, `spidermonkey-node`, `node`,
  `mariadb`, `texlive`.

Rationale:

- These depend on wave 1/2 artifacts or have high build/runtime risk.
- Heavy packages should run as separate child beads or very small batches.
- Runtime smoke must use normal Kandelo exec/service paths, not formula-specific
  wrappers.

### Wave 4: Base And Language VFS Images

Packages:

- `rootfs`, `shell`, `python-vfs`, `perl-vfs`, `erlang-vfs`,
  `vim-browser-bundle`, `nethack-browser-bundle`, `node-vfs`.

Rationale:

- These validate that bottle sidecars can be poured/linked into useful VFS
  images.
- Node smoke is required first; browser smoke is required before any gallery or
  user-facing compatibility claim.

### Wave 5: Service And Application VFS Images

Packages:

- `mariadb-vfs`, `mariadb-test`, `lamp`, `wordpress`.

Rationale:

- These combine dinit, service-worker HTTP, loopback networking, databases,
  PHP/WordPress, mail capture, and browser state. They should wait until
  smaller VFS images prove the Homebrew prefix and sidecar contracts.
- Treat MariaDB storage engine failures as package/runtime/platform findings,
  not as reasons to hide or skip formula evidence.

## CI, GHCR, And Capacity Expectations

- Keep the first real wave small: at most one dependency-root batch plus one
  composite smoke package until GHCR upload and sidecar validator behavior is
  boring.
- Split heavy packages so one timeout does not starve the entire formula
  matrix.
- Publish sidecars and bottles only from trusted workflows with `contents` and
  package permissions proven by `kd-8ho`.
- Record pass/fail/skip outcome lists for any test-related migration wave.
- Prefer retrying network/source downloads inside package build scripts only
  where the existing package contract already does so; do not add Homebrew-only
  retry behavior that changes package semantics.
- Keep each bottle report tied to tap commit, Kandelo commit, ABI, formula
  revision, bottle rebuild, source status, cache key, sha256, byte count, and
  validation run URL.

## Test Plan

Per formula:

- Parse and validate `package.toml` and `build.toml`.
- Verify source URL, source sha256, license field, direct deps, declared
  outputs, build script path, revision, and arch list.
- Generate Formula Ruby plus Kandelo sidecars from package metadata; do not
  hand-edit generated sidecars.
- Run Homebrew formula syntax/audit checks selected by `kd-8ho`.
- Build bottle in trusted CI.
- Run `cargo xtask homebrew-validate --tap-root <tap>`.
- Verify GHCR manifest and bottle sha/bytes match sidecar metadata.
- For every runtime package, build a Homebrew-prefix VFS image with
  `build-homebrew-vfs-image.ts` and save the JSON report.
- Run Node smoke for the image.
- Run browser smoke before setting `browser_compatible = true` or exposing a
  gallery/user claim.

Package-specific smoke examples:

- CLI tools: `--help` or `--version`, simple file I/O, stdin/stdout, and exit
  status.
- Shell/rootfs: `dash`, `bash`, PATH lookup, pipes, command substitution,
  `system()`/`popen()` consumers where relevant.
- Network tools: loopback TCP/UDP, HTTP/HTTPS where host limits permit.
- Services: dinit startup, port bind, request/response, clean shutdown.
- Language runtimes: interpreter startup, standard library/module load, zlib or
  OpenSSL extension where declared.
- VFS images: `/etc/kandelo/homebrew-vfs.json`, demo metadata, selected
  executable paths, and Node/browser boot.

Broader gates:

- If a migration PR changes package build scripts, resolver behavior, VFS
  builder behavior, host runtime, or browser app behavior, select validation
  from `CLAUDE.md` and `docs/agent-guidance/validation.md`. Do not claim full
  gate success unless the full gate commands were run and reported.
- If ABI-facing behavior changes, update `ABI_VERSION` and `abi/snapshot.json`
  according to the ABI contract.

## Documentation Plan

After the foundation docs in `kd-8ho.11` land, add or update:

- Homebrew tap operating docs: formula generation, sidecar generation,
  validator, bottle rebuild, rollback, and failure triage.
- Package authoring docs: how a registry package maps to a Homebrew formula,
  how to declare browser compatibility evidence, and how to avoid
  formula-specific workarounds.
- Browser/user docs: how gallery availability follows sidecar/index state and
  why browser support requires browser smoke.
- Package management docs: clarify the relation between Kandelo binary releases
  and Homebrew bottles, including when each surface should be used.

## Alternatives Considered

All-at-once matrix:

- Rejected for first migration because 72 packages plus wasm64 variants and
  VFS images would make failures hard to classify and could overload Actions or
  GHCR. It also encourages hiding package-specific failures to get a green
  matrix.

Prefix every formula with `kandelo-`:

- Rejected for now. It avoids core formula name ambiguity, but breaks the
  direct relationship between registry IDs, sidecar package IDs, and dependency
  graph names. Tap-qualified formula references are sufficient unless real
  Homebrew mechanics prove otherwise.

Publish only composite VFS images:

- Rejected because it would skip reusable dependency bottles and make failures
  harder to diagnose. Libraries and standalone programs should prove the base
  bottle/link path before VFS images consume it.

Treat source-only and internal artifacts as normal formulas:

- Rejected until ownership is decided. `pcre2-source`, platform artifacts, and
  manifest-incomplete entries need explicit contracts; forcing them into a
  formula shape risks publishing misleading artifacts.

## Risks And Mitigations

Stale ABI metadata:

- Risk: formulas or sidecars could imply ABI 16 compatibility while manifests
  still say older `kernel_abi` values.
- Mitigation: make ABI policy a Wave 0 blocker and derive publish ABI from
  build evidence and sidecar metadata, not stale fields.

Formula-specific shortcuts:

- Risk: package maintainers may patch around Kandelo runtime gaps to make a
  bottle green.
- Mitigation: require failure classification and package/platform ownership in
  each bead; do not patch packages for ordinary POSIX gaps.

Browser parity drift:

- Risk: Node VFS smoke passes while browser boot, SharedArrayBuffer, service
  worker, OPFS, or UI loading fails.
- Mitigation: keep `browser_compatible` false until browser smoke passes; make
  browser smoke a separate required signal for user-facing claims.

License/source distribution:

- Risk: GPL or mixed-license packages need audit-ready source provenance and
  possibly sibling source archives.
- Mitigation: preserve source URL/sha/license in sidecars and create follow-up
  work for sibling source archives before public user-facing expansion if legal
  review requires it.

CI/GHCR quota:

- Risk: large packages like SpiderMonkey, MariaDB, TexLive, PHP, Ruby, and
  VFS images can consume runner time, storage, and registry quota quickly.
- Mitigation: split heavy packages into separate beads, record byte sizes, and
  avoid all-at-once dispatch until capacity is measured.

Name collisions:

- Risk: formula names like `zlib`, `curl`, `bash`, and `sqlite` collide with
  Homebrew core names.
- Mitigation: require tap-qualified references in docs and reports; revisit
  prefixing only if Homebrew tooling cannot keep ambiguity contained.

## Implementation Sequence

1. Close or explicitly override `kd-8ho`.
2. Create Wave 0 hygiene beads for ABI policy, registry exceptions, internal
   artifact ownership, and inventory lint.
3. Create Wave 1 child beads for library roots and hybrid `ncurses`.
4. Create Wave 2 child beads in small CLI batches with smoke definitions.
5. Create Wave 3 child beads for heavy runtime/service packages, one or two per
   bead depending on build time.
6. Create Wave 4 child beads for base/language VFS images with Node and browser
   smoke gates.
7. Create Wave 5 child beads for service/application VFS images.
8. After each wave, update the inventory status and record package failures as
   package/setup/runtime/platform, with follow-up beads for blockers.

## Open Questions

- Should `kernel_abi` remain a manually maintained package manifest field, or
  should Homebrew sidecars derive ABI exclusively from build evidence?
- Should platform artifacts (`kernel`, `userspace`, `kandelo-sdk`,
  `kernel-test-programs`) live in the Homebrew tap, the existing binary release,
  or both?
- Should `pcre2-source` get a source-only formula, remain an internal source
  sidecar for MariaDB, or move to a package-source contract?
- Should `sqlite-cli` be revived with a build script or removed/excluded from
  publish waves?
- What storage quota and retention policy should GHCR use for large bottle and
  VFS image histories?
- What is the legal/source-distribution requirement for GPL-family packages in
  the Homebrew bottle path?
- Which smoke results are sufficient to mark each package
  `browser_compatible`, especially for packages with device, network, service
  worker, or framebuffer behavior?
