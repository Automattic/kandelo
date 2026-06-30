# Homebrew Registry Replacement Model

Date: 2026-06-30

Tracked work:

- `kd-1mr` - Port all current Kandelo packages to Homebrew.
- `kd-c6p` - Document the Homebrew registry replacement model.
- Source plan: `kd-5yd`, committed as `b6cd51d8c`, inventories the current
  package set and migration waves.

This is a design and contract document. It does not publish bottles, change
package recipes, delete `packages/registry`, or add guest `brew install`
support.

## Problem Statement

Kandelo currently treats `packages/registry/<name>/package.toml` and
`build.toml` as the first-party package recipe and publish-state database. That
registry feeds source builds, binary archive publication, dependency
resolution, local cache keys, browser gallery entries, and operator debugging.

The Homebrew-all direction is stronger than adding a second export path:
Homebrew should replace `packages/registry` if it can preserve Kandelo's
package, ABI, host-runtime, VFS, and user-visible failure contracts.

The replacement model must make Formulae the package source of truth while
keeping Kandelo-specific intelligence available through additive sidecars. It
must also keep failed packages visible, preserve both Node.js and browser hosts
as required product surfaces, and record complete upstream test evidence
separately from default bottle availability.

## Non-Goals

- Do not implement broad package migration or bottle publication in this bead.
- Do not delete `packages/registry` until every registry role is either moved
  to Homebrew, moved to another explicit owner, or documented as a blocker.
- Do not document user-facing `brew tap` or guest `brew install` commands until
  guest Homebrew install has been validated through Kandelo.
- Do not make Kandelo sidecars authoritative for ordinary Homebrew install.
  Formula Ruby and Homebrew bottle metadata remain authoritative for `brew`.
- Do not create Node-only or browser-only package tiers. A temporary host
  failure is status to publish and work to fix, not a new support class.
- Do not make complete upstream test success the default bottle publication
  gate. Full upstream test support and status are required; success is a
  correctness signal, not the first installability gate.
- Do not patch Homebrew dependency resolution, install semantics, or Formula
  DSL behavior unless a focused design shows that upstream Homebrew cannot
  express the Kandelo wasm target boundary.

## Users And Workflows

Package maintainers author and review Formulae. They need a single source of
truth for source URLs, hashes, licenses, dependencies, build commands,
installation layout, and `test do` behavior. During migration, generated
Formulae may come from `packages/registry`, but the generated Formula must be
reviewable as the future authority rather than a lossy export.

Release operators publish and maintain bottles. They need trusted workflows
that build through Homebrew, upload bottle bytes to GitHub Packages/GHCR,
generate sidecars, validate schemas, preserve last-green fallback metadata, and
record failed rebuilds without erasing the previous usable bottle.

Runtime and browser maintainers validate package behavior through the normal
Kandelo host path. They need Node and browser smoke evidence for the same
package identity and dependency closure. Browser gallery entries must only be
shown after a wasm32 bottle has been poured into a precomposed VFS image and
booted in the browser host.

Community contributors need visible package status. A failed or deferred
package should say what failed, where the artifacts are, and what next action
would help. Hiding failed packages from the index makes contribution and triage
harder.

Debuggers need failure categories that point at the right layer: source fetch,
Formula generation, dependency closure, Homebrew build, bottle upload,
install/link, fork instrumentation, VFS materialization, Node smoke, browser
smoke, upstream tests, package setup, Kandelo platform behavior, or CI/GHCR
permissions.

## Architecture And Data Flow

The target architecture is:

```text
temporary registry bridge
  reads packages/registry while migration is incomplete
        |
        v
Automattic/kandelo-homebrew
  Formula/<name>.rb                  authoritative package recipe
  Kandelo/metadata.json              additive package status index
  Kandelo/formula/<name>.json        additive formula summary
  Kandelo/link/<name>-...json        additive pour/link plan
  Kandelo/reports/<name>-...json     provenance and validation evidence
        |
        v
trusted Homebrew bottle workflow
        |
        v
GitHub Packages / GHCR bottle blobs
        |
        v
Homebrew bottle metadata and install path
        |
        v
Kandelo sidecar validation, VFS planner, Node smoke, browser smoke
        |
        v
browser gallery assets and operator status views
```

Control flow has two separate consumers:

- Homebrew reads Formula Ruby and bottle blocks. It must not need Kandelo
  sidecars to install a bottle.
- Kandelo tools read sidecars, provenance, and link manifests. They must not
  evaluate Formula Ruby in host or browser VFS tooling.

The existing Homebrew foundation already implements the first trusted
publication path for `hello`: CI builds a bottle, publishes through the
GHCR/Homebrew bottle URL shape, generates sidecars, validates sidecars, builds
a Homebrew-derived VFS image, and runs Node/browser smoke checks. The
replacement model extends that foundation from one package to the whole
accepted package set.

## Source-Of-Truth Policy

Formulae become authoritative for package identity that Homebrew can own:

- source URL, source hash, and license;
- direct dependencies and resources;
- build, install, and `test do` behavior;
- Homebrew version, Formula `revision`, bottle `rebuild`, and `bottle do`
  selection data;
- normal Homebrew prefix and cellar layout.

Kandelo sidecars remain additive:

- ABI and cache-key identity for Kandelo VFS tooling;
- package status, failed attempts, and last-green fallback pointers;
- Node and browser runtime support evidence;
- complete upstream test metadata;
- VFS link plans, precomposed image evidence, and browser gallery eligibility;
- provenance linking tap commit, Kandelo commit, Formula hash, CI run, and
  bottle bytes.

`packages/registry` is temporary migration scaffolding. Until deletion, the
bridge may read `package.toml`, `build.toml`, and package build scripts to
generate or check Formulae. After deletion, the tap Formula and supporting
Homebrew tooling must be sufficient for accepted package roles. Any role that
cannot move out of `packages/registry` must have an explicit owner before
registry removal.

## Formula And Patch Discipline

Formulae should stay as close to normal upstream Homebrew Formulae as possible:

- Use Homebrew DSL for dependencies, resources, patches, install layout,
  `test do`, Formula `revision`, bottle `rebuild`, and `bottle do`.
- Build through Kandelo's SDK and existing package build scripts during the
  bridge phase. Source `sdk/activate.sh` or run scripts inside the trusted
  workflow environment.
- Install only the produced Kandelo artifacts into the Homebrew keg.
- Keep VFS link plans, browser compatibility, cache keys, and validation
  evidence out of Formula Ruby.

The only known Homebrew patch class is target support for
`wasm32_kandelo` and `wasm64_kandelo`: architecture tags, prefix, and cellar
handling. Trusted CI applies this patch to a temporary Homebrew worktree.
Developer host Homebrew checkouts must not be patched in place.

Patching Homebrew dependency resolution, install semantics, Formula DSL
meaning, or bottle selection is a design warning. Prefer changing Kandelo
tooling, Formula authoring, or sidecars before changing upstream Homebrew
semantics.

## Package Identity, Versions, Revisions, And ABI

Use current registry package names as Formula names where possible. Tap-qualified
Formula references should handle collisions. Do not prefix every Formula with
`kandelo-` unless Homebrew mechanics force it and the migration records the
rename.

Dependency edges remain exact. The current package graph uses exact
`name@version` dependencies and no version ranges. The Homebrew graph should
preserve that clarity with explicit Formula dependencies or resources. Hidden
transitive dependencies are not cache-safe and make rebuilds hard to audit.

Version and revision rules:

- Homebrew Formula `version` follows the upstream package version.
- Formula `revision` and bottle `rebuild` move Homebrew bottle selection.
- Kandelo `build.toml.revision` is only a bridge-era package archive cache
  invalidation knob. Bump it only when legacy Kandelo package archive output
  bytes legitimately change.
- Do not bump `build.toml.revision` for Formula-only docs, tap metadata,
  sidecar changes, browser-gallery wording, or Homebrew-only publish state.
- During migration, an output-byte change may require both a Homebrew
  Formula/bottle movement and a bridge `build.toml.revision` bump if the legacy
  archive path still needs to produce new bytes.

ABI identity belongs in Kandelo metadata, not in the Homebrew platform tag.
Bottle tags stay `wasm32_kandelo` and `wasm64_kandelo`; sidecars and releases
carry `kandelo_abi`, `bottles-abi-v<N>`, `cache_key_sha`, Formula hash,
Kandelo commit, tap commit, bottle sha256, byte count, and link-manifest hash.

A Kandelo VFS materializer may use a bottle only when these facts agree:

- requested package name and version;
- target architecture and bottle tag;
- expected Kandelo ABI;
- Formula revision and bottle rebuild selected by sidecar metadata;
- bottle URL, sha256, and byte count;
- package `cache_key_sha`;
- link manifest path and link-manifest bottle identity;
- last-green fallback fields, if the current entry is not `success`.

ABI details should be quiet in normal package discovery and install UX, but
loud in diagnostics. A user or operator should be able to tell whether a
package is unavailable because of ABI rebuild coverage rather than a package,
runtime, test, source, permissions, or platform failure.

## Dependency Graph Rules

Formula dependencies are the long-term graph. The bridge must compare them
against `packages/registry` until registry deletion.

Rules:

- Every direct dependency used by a Formula build or package smoke must be
  declared by the Formula or by an explicit Homebrew resource.
- Source helper roles such as `pcre2-source` must be classified as Formula
  resources, helper Formulae, or package-specific vendored sources before
  registry deletion.
- Support directories such as `node-compat` and `npm` must move under the
  owning Formula/tooling or become explicit helper packages.
- Internal platform artifacts such as `kernel`, `userspace`,
  `kernel-test-programs`, and `kandelo-sdk` require an ownership decision:
  Homebrew Formula, existing binary release path, or another explicit surface.
- The sidecar validator and VFS planner must reject dependency cycles, missing
  dependency metadata, unsupported arch, bad ABI, unsafe paths, cache-key drift,
  and link-manifest bottle drift before extracting bytes.
- Node and browser smoke must run against the selected package plus its
  dependency closure, not against an ad hoc set of copied files.

## Failure Visibility

A failed package remains a package entry. It must not disappear from discovery
because that hides work and can make last-green fallback behavior impossible to
understand.

Current sidecars support bottle statuses `success`, `failed`, `pending`, and
`building`, with last-green fallback fields for non-success entries. The
replacement model also needs package-disposition metadata for migration and
operator views:

- `success`: current bottle fields are authoritative.
- `failed`: latest attempt failed; fallback may be selectable.
- `pending` or `building`: current attempt is queued or running.
- `deferred`: intentionally not attempted yet, with reason and owner.
- `unavailable`: cannot currently be built or published, with reason.
- `blocked`: waiting on a platform, dependency, quota, legal, or tooling issue.
- `excluded`: explicitly not part of the Homebrew replacement set, with owner
  and alternate distribution surface.

Every non-success entry needs:

- failure category;
- human-readable reason;
- affected package, version, Formula revision, bottle rebuild, arch, ABI, and
  host where applicable;
- CI run URL or local artifact path;
- first relevant error or log excerpt pointer;
- whether a last-green fallback is complete;
- expected next action and owner class.

Failure categories should be specific enough to route work:
`source_fetch`, `formula_generation`, `homebrew_parse`, `homebrew_audit`,
`dependency_resolution`, `build`, `install_link`, `formula_test`,
`bottle_upload`, `sidecar_generation`, `sidecar_validation`,
`vfs_materialization`, `node_smoke`, `browser_smoke`, `upstream_tests`,
`package_setup`, `platform_runtime`, `ci_permissions`, `quota`, `license`, and
`operator_error`.

## Node And Browser Support

Node and browser are both required product surfaces. A package is not fully
compatible until both hosts have evidence for the same package identity and
dependency closure.

Runtime metadata should distinguish these states:

- no host claim yet;
- Node smoke passed, browser smoke pending or failed;
- browser smoke passed, Node smoke pending or failed;
- both host smokes passed;
- host smoke skipped with reason;
- host smoke blocked by a platform or browser limitation.

Only the "both host smokes passed" state should be presented as full package
compatibility. A package may remain installable or plannable while one host is
failing, but the failure must be visible. The browser gallery must stay stricter:
it may show a Homebrew entry only when wasm32 metadata is `success`, an
archive URL exists, `browser_compatible = true`, and the precomposed VFS image
was booted by browser smoke.

Browser support is not achieved by extracting bottles in browser JavaScript.
The browser path consumes a precomposed `.vfs.zst` generated by trusted tooling
from sidecars and verified bottle bytes, then runs the package through the
normal Kandelo browser host.

## Complete Upstream Test Metadata

Default bottle availability requires Formula build/install, sidecar validation,
Node smoke, and browser smoke. Complete upstream tests are recorded separately.

The existing provenance schema records outcome lists for schema, Homebrew
audit, bottle build, Node smoke, and browser smoke. The replacement model
should extend provenance with an upstream-test result that can represent a
complete test suite without flattening it into a single string.

Recommended shape:

```json
{
  "upstream_tests": {
    "status": "failed",
    "gate": "advisory",
    "suite": "sqlite upstream test suite",
    "harness": "make test",
    "command": "bash scripts/dev-shell.sh ...",
    "host": "node",
    "arch": "wasm32",
    "started_at": "2026-06-30T00:00:00Z",
    "ended_at": "2026-06-30T00:00:00Z",
    "counts": {
      "passed": 1200,
      "failed": 2,
      "skipped": 10,
      "expected_failed": 0,
      "unexpected_passed": 0,
      "timeout": 1,
      "unsupported": 3,
      "build_failed": 0,
      "incomplete": 0
    },
    "failures": [
      {
        "suite": "fts5",
        "case": "fts5fault.test",
        "status": "failed",
        "command": "make test",
        "exit_status": 1,
        "signal": null,
        "duration_ms": 12000,
        "category": "platform_runtime",
        "first_error": "short diagnostic or pointer-safe summary",
        "artifact": "Kandelo/reports/upstream/sqlite/.../fts5fault.log"
      }
    ],
    "skips": [
      {
        "suite": "network",
        "case": "remote-server",
        "reason": "external raw sockets are unavailable in browser host"
      }
    ],
    "artifacts": [
      {
        "label": "raw harness log",
        "path": "Kandelo/reports/upstream/sqlite/.../test.log",
        "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
        "bytes": 1
      }
    ],
    "known_failures": [
      {
        "case": "fts5fault.test",
        "reference": "kd-...",
        "expires": null
      }
    ]
  }
}
```

Status values:

- `passed`: the complete upstream suite passed.
- `failed`: the suite ran to completion and at least one case failed.
- `partial`: a documented subset ran; missing coverage is listed.
- `skipped`: skipped intentionally with reason.
- `incomplete`: the harness started but did not complete.
- `unavailable`: no usable upstream suite is known yet, with reason.

Required metadata:

- package, version, Formula revision, bottle rebuild, arch, ABI, Kandelo
  commit, tap commit, CI run URL, start/end time;
- exact command and harness;
- pass/fail/skip/timeout/unsupported/incomplete counts;
- complete failure list with suite, case, command, exit status, signal or
  timeout, category, first relevant error, and artifact pointer;
- skip reasons and known-failure references;
- artifact pointers for raw logs, summaries, normalized outcome lists, bottle
  reports, sidecar validation output, and precomposed VFS reports;
- host-specific notes when upstream tests differ on Node and browser.

If a harness cannot emit a category, the provenance must record that missing
category and why. This keeps "complete upstream test support" honest even
before every package has a perfect parser.

## Migration Away From `packages/registry`

Deletion is an end state, not the first milestone.

Phase 0: classification and bridge hygiene

- Keep an inventory check that classifies every `packages/registry` entry.
- Treat unclassified directories as failures.
- Decide ownership for support dirs, source-kind packages, internal artifacts,
  precomposed VFS packages, and composite runtime packages.

Phase 1: Formula generation and parity checks

- Generate or hand-author Formulae from current registry data.
- Diff Formula source, dependencies, version, license, build script, outputs,
  and tests against current registry intent.
- Keep bridge output deterministic so Formula review is practical.

Phase 2: pilot packages

- Use the existing `hello` trusted publication and `zlib` local proof as
  controls.
- Run the sqlite/bzip2/xz pilot before creating broad waves.
- Implement only bridge/status/schema gaps proven by the pilot.

Phase 3: graph expansion

- Migrate dependency roots, small CLI packages, heavy runtimes, and composite
  VFS images in evidence-driven batches.
- Keep failed and deferred packages visible in sidecars and operator reports.
- Do not allow a package to become invisible merely because publication failed.

Phase 4: source-of-truth cutover

- Stop accepting new first-party package recipes in `packages/registry`.
- Require Formula changes for package source/dependency/build/test behavior.
- Leave compatibility shims only where they are explicitly part of a migration
  bridge.

Phase 5: registry removal

Remove `packages/registry` only after:

- every accepted package role has a Formula or explicit non-Homebrew owner;
- sidecar schemas and validators cover status, ABI, cache keys, fallback,
  host support, upstream tests, and artifacts;
- Node and browser smoke policy is enforced for package compatibility claims;
- package-source-shaped browser gallery assets are generated only from
  browser-smoked Homebrew VFS images;
- package authoring, publishing, rebuild, rollback, and failure-triage docs are
  current;
- old resolver paths either consume Homebrew sidecars or are intentionally
  removed.

## Operator And Community Workflows

Fixing a failed package should be a normal workflow:

1. Find the failed package in the Homebrew-backed status index or operator
   report.
2. Read the status category, reason, affected arch/ABI/host, first error, and
   artifact links.
3. Decide whether the failure belongs to the Formula, Kandelo package build
   script, upstream source patch, SDK/sysroot, fork instrumentation, VFS
   planner, host runtime, browser app, CI permissions, GHCR quota, or license
   process.
4. Make the smallest change at the owning layer.
5. Run the relevant local dry-run, schema validation, Node smoke, browser
   smoke, or upstream test parser.
6. Publish through the trusted workflow when credentials and permissions are
   required.
7. Preserve last-green fallback metadata until a new success replaces it.

Community-visible package pages or reports should expose:

- current status by arch and ABI;
- last successful bottle and last failed attempt;
- whether Node smoke passed;
- whether browser smoke passed;
- complete upstream test status and artifact links;
- known failures and next action;
- whether a contribution should target the tap, Kandelo platform, upstream
  package patch, CI workflow, or docs.

## Alternatives Considered

Keep Homebrew as a parallel export path:

- Rejected by project direction. If Homebrew can preserve the package contract,
  it should replace `packages/registry`; otherwise the blocker should be made
  explicit.

Make sidecars authoritative for install:

- Rejected. Formulae and Homebrew bottle metadata should remain the contract
  consumed by `brew`. Sidecars are for Kandelo VFS tooling, status, provenance,
  browser gallery, and diagnostics.

Allow Node-only and browser-only package tiers:

- Rejected. Node and browser are equal product surfaces. Host-specific failure
  is package status, not a permanent tier.

Gate every bottle on complete upstream tests:

- Rejected as the default. It would hide useful installable packages behind
  long-running or currently failing upstream suites. Upstream test support and
  status remain required.

Patch Homebrew semantics broadly:

- Rejected unless proven necessary. The target is upstream Homebrew plus the
  minimal Kandelo wasm target support patch.

Create all migration waves immediately:

- Rejected. The sqlite/bzip2/xz pilot should produce real capacity and failure
  data before broad waves are created.

Keep `packages/registry` permanently as the hidden source of truth:

- Rejected. That would make Formulae a generated facade and preserve the
  current split-brain risk.

## Risks And Mitigations

Formula and registry divergence:

- Risk: bridge-era Formulae and registry manifests disagree.
- Mitigation: make the bridge temporary, deterministic, and checked; define
  registry deletion criteria; block duplicate source-of-truth behavior.

ABI confusion:

- Risk: users and operators cannot tell ABI rebuild gaps from package failures.
- Mitigation: keep ABI out of bottle tags but explicit in sidecars, releases,
  fallback metadata, VFS planner errors, and operator reports.

Homebrew patch drift:

- Risk: Kandelo-specific Homebrew patches become a fork of install semantics.
- Mitigation: limit patches to architecture/prefix/cellar support unless a
  focused design approves more.

Browser parity drift:

- Risk: Node smoke passes while browser boot, service worker, SharedArrayBuffer,
  OPFS, or UI loading fails.
- Mitigation: require browser smoke for full compatibility and gallery
  visibility; publish host-specific failure status.

Failed package invisibility:

- Risk: failing packages disappear from discovery and lose contributors.
- Mitigation: require non-success status entries with reasons, artifacts,
  next action, and fallback state.

Outcome metadata bloat:

- Risk: full upstream test artifacts become too large for tap commits.
- Mitigation: keep summary metadata in sidecars and store large raw artifacts
  in releases or CI artifacts with sha256, byte count, and retention policy.

CI and GitHub Packages limits:

- Risk: heavy packages consume runner time, package quota, or storage.
- Mitigation: publish in small evidence-driven batches, isolate heavy runtimes,
  record byte counts, and keep failure state durable.

License and source-distribution gaps:

- Risk: bottle distribution for GPL-family or mixed-license packages lacks
  audit-ready source provenance.
- Mitigation: require source URL, sha256, license, Formula hash, and artifact
  provenance; add package-specific source-distribution work before broad public
  expansion when needed.

Community confusion:

- Risk: users see Homebrew files and assume guest `brew install` is supported.
- Mitigation: keep current docs explicit that user-facing `brew install` is not
  documented until guest Homebrew install is validated.

## Implementation Sequence

1. Land this design and reference-doc pointers.
2. Extend Homebrew sidecar/provenance schemas for complete upstream test
   metadata, package dispositions, failure categories, and artifact pointers.
3. Add or update validators so generated metadata cannot drop failures,
   fallback fields, host smoke evidence, or required upstream-test reasons.
4. Add a bridge inventory/check mode that classifies every current
   `packages/registry` entry and fails on unclassified directories.
5. Run the sqlite/bzip2/xz pilot from its managed bead and branch.
6. Use pilot evidence to choose the next package bead: another dependency
   root, small CLI batch, schema/bridge blocker, runtime blocker, or composite
   VFS blocker.
7. Build operator reports around package status, failures, artifacts, and next
   actions before broad migration.
8. Migrate package waves only after the source-of-truth, failure, ABI,
   Node/browser, and upstream-test contracts are enforced by tooling.
9. Remove `packages/registry` only after every accepted role is moved or
   explicitly owned elsewhere.

## Test And Documentation Plan

For this design bead:

- Run whitespace validation on the changed docs.
- Do not run runtime, package, browser, or ABI gates; this is docs-only.

For schema and tooling follow-ups:

- Add unit tests for sidecar schema generation and validation.
- Add negative tests for missing failure categories, missing skip reasons,
  missing artifacts, incomplete fallback fields, ABI mismatch, cache-key drift,
  unsupported arch, and dependency cycles.
- Run `cargo test -p xtask` for sidecar and validator changes.
- Run `cd host && npx vitest run` for VFS planner or builder behavior.
- Run the Homebrew workflow in dry-run mode for publish-flow changes.
- Run package-specific Node smoke and browser smoke before claiming host
  compatibility.
- Run package upstream tests where a package bead claims upstream-test support,
  and publish pass/fail/skip/incomplete outcome lists with reasons.
- If any host runtime, VFS, kernel, libc, syscall, or ABI behavior changes,
  select suites from `CLAUDE.md` and `docs/agent-guidance/validation.md` and
  report skipped gates explicitly.

Documentation follow-ups:

- Update `docs/homebrew-publishing.md` as schema and operator workflows land.
- Update `docs/package-management.md` when Formulae actually replace the
  registry source-of-truth contract.
- Update `docs/package-sources.md` only for the browser-gallery packaging
  surface; do not describe Homebrew bottles as package-source archives.
- Update `docs/browser-support.md` when Homebrew-derived browser gallery
  behavior changes.
- Keep historical plans historical. Do not rewrite older plans to claim they
  predicted the final replacement model.

## Open Questions

- Should Kandelo upstream `wasm32_kandelo` and `wasm64_kandelo` support to
  Homebrew, or keep carrying the minimal architecture-tag patch?
- Which registry roles cannot move to Formulae and why?
- Should `kernel`, `userspace`, `kandelo-sdk`, and `kernel-test-programs` live
  in the tap, existing binary releases, or a separate platform-artifact
  channel?
- Should `pcre2-source` become a Formula resource, helper Formula, or MariaDB
  Formula resource?
- Should `sqlite-cli` be revived as a Formula or removed from the accepted
  package set?
- What retention policy should apply to GHCR bottle blobs and large upstream
  test artifacts?
- What source-distribution workflow is required for GPL-family packages?
- Which smoke commands are sufficient for each package's Node and browser
  compatibility claim?
- Should package-disposition statuses be separate from bottle status in
  `metadata.json`, or should they live in an operator report linked from
  provenance?
- What public UX should expose failed packages and invite community fixes
  without promising unsupported behavior?
