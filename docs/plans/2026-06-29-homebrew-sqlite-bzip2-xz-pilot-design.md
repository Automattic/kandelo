# Homebrew SQLite, Bzip2, And Xz Pilot Design

Date: 2026-06-29

Tracked work:

- `kd-1mr` - Port all current Kandelo packages to Homebrew.
- `kd-1mr.2` - Port sqlite, bzip2, and xz Homebrew pilot.
- Source planning evidence: `kd-5yd`, commit `b6cd51d8c`, refreshed the
  Homebrew package inventory and selected this pilot after the trusted
  `hello` publication path and local `zlib` wasm32/wasm64 proof.

This is a design artifact for the pilot. It does not implement the Formulae,
publish bottles, change registry package bytes, or update release metadata.

## Problem Statement

Kandelo's Homebrew foundation can publish and smoke the first `hello` bottle,
and the follow-up `zlib` proof showed that a dependency-root library can be
bottled locally for wasm32 and wasm64. The next migration step needs a small
pilot that exercises more of the future registry-replacement model without
starting a broad package wave.

The pilot packages are deliberately mixed:

- `sqlite` is the next dependency-root library. It declares wasm32 and wasm64,
  has real downstream consumers, and has existing upstream SQLite test harnesses
  whose status should be visible without making full upstream success the
  default bottle gate.
- `bzip2` and `xz` are small leaf CLI packages. They exercise program Formulae,
  link manifests, VFS pour/link behavior, and Node/browser smoke commands
  without the capacity risk of heavy runtimes.

The design must preserve the current Homebrew direction:

- Formulae become authoritative for source, dependency, build, install, and
  `test do` behavior.
- Kandelo sidecars remain additive metadata for ABI, cache keys, provenance,
  VFS planning, host support, browser gallery status, and test outcomes.
- Package failures remain visible with reasons and artifacts.
- Node and browser hosts are both product surfaces. A missing browser result is
  status to publish, not proof of browser support.

## Non-Goals

- Do not port the full dependency-root wave or the full small-CLI wave.
- Do not delete or rename `packages/registry` in this pilot.
- Do not revive `sqlite-cli` as a product Formula unless the pilot proves it is
  necessary and a focused follow-up is created.
- Do not make upstream SQLite full-suite success a default bottle publication
  gate.
- Do not use Formula patches or test skips to hide Kandelo runtime, libc,
  syscall, VFS, fork-instrumentation, or host-parity defects.
- Do not publish user-facing guest `brew install` instructions from this work.
- Do not bump `packages/registry/*/build.toml` revisions unless package output
  bytes legitimately change.

## Users And Operator Workflows

### Package Porter

The porter authors or regenerates `Formula/sqlite.rb`, `Formula/bzip2.rb`, and
`Formula/xz.rb` in `Automattic/kandelo-homebrew` or the reviewable tap fixture.
They reuse existing package build knowledge, but the Formula DSL owns the
final source, build, install, and test behavior. The existing registry scripts
may be called only where they already honor the resolver-style output contract
or after the pilot makes their side effects explicit.

### Maintainer Reviewer

The reviewer checks that the Formulae are normal Homebrew Formulae with the
minimum Kandelo-specific environment wiring, that sidecars describe the bottles
truthfully, that dry-run/local evidence is not presented as trusted
publication, and that package failures are recorded instead of disappearing.

### Trusted Publisher

The trusted workflow builds each selected `(formula, arch)` entry, uploads the
bottle to the GHCR-backed Homebrew bottle URL shape, generates sidecars and
provenance, validates the tap payload, then publishes success or failure state.
The workflow must keep failure reports durable without replacing last-green
metadata.

### Runtime Validator

The validator materializes Homebrew bottles into VFS images and runs package
smoke commands on both Node and browser hosts. For program packages, the smoke
executes the installed program. For library packages, the smoke compiles or
ships a test-only consumer and runs that consumer against the poured library.
The test consumer is validation evidence, not a product bottle output.

### Debugger

When a package fails, the debugger needs enough metadata to classify the fault:
source fetch, Formula generation, cross-compile configure answer, build,
install/link, bottle upload, sidecar generation, VFS pour/link, Node runtime,
browser runtime, upstream test failure, or Kandelo platform behavior.

## Existing Package Facts

`sqlite`:

- `packages/registry/sqlite/package.toml` is a library manifest for SQLite
  `3.49.1`, declares `arches = ["wasm32", "wasm64"]`, and outputs
  `lib/libsqlite3.a`, `include/sqlite3.h`, `include/sqlite3ext.h`, and
  `lib/pkgconfig/sqlite3.pc`.
- `build-sqlite.sh` is resolver-shaped for the library path when
  `WASM_POSIX_DEP_OUT_DIR` is set, but it also has a legacy direct-invocation
  CLI path. Formulae should not rely on that legacy CLI path for the library
  bottle.
- Existing SQLite test tooling includes SQL fixture tests and official
  testrunner wrappers for Node and browser. Those are upstream-test status
  evidence, not the default bottle availability gate.

`bzip2`:

- `packages/registry/bzip2/package.toml` is a wasm32 program manifest for
  `1.0.8`.
- `build-bzip2.sh` is an older direct script. It writes `bin/bzip2.wasm`,
  installs `libbz2.a` and `bzlib.h` to the repo sysroot, and registers a local
  binary. A Formula must not silently rely on those sysroot/local-binary side
  effects.
- Existing Vitest coverage checks `bzip2 --version`; round-trip compression is
  not covered there.

`xz`:

- `packages/registry/xz/package.toml` says version `5.6.2`, while
  `build-xz.sh` currently defaults to `5.6.4` and downloads a `.tar.gz` from
  the GitHub release path. This version/source mismatch is a pilot blocker
  unless the Formula pins one source and the build path is made consistent.
- `build-xz.sh` is an older direct script. It writes `bin/xz.wasm`, installs
  `liblzma.a` and headers to the repo sysroot, and registers a local binary.
  A Formula should install only the intended bottle contents into the Homebrew
  keg.
- Existing Vitest coverage checks `xz --version`; round-trip compression is
  not covered there.

Cross-cutting:

- Current package manifests have stale `kernel_abi` values. The Homebrew
  sidecar path must use live `ABI_VERSION` and computed `cache_key_sha`
  evidence. The pilot should not treat stale manifest ABI fields as bottle
  compatibility truth.
- `scripts/homebrew-generate-sidecars-from-env.sh` is currently heavily shaped
  around the `hello` validation path. The pilot needs a generic sidecar input
  path for package-specific validation outcomes, or it must publish non-hello
  failure/deferred status with a focused follow-up.

## Architecture And Data Flow

The pilot should use the same publication architecture as the existing
Homebrew path:

```text
Formula/sqlite.rb, Formula/bzip2.rb, Formula/xz.rb
      |
      v
trusted workflow matrix
  scripts/homebrew-plan-matrix.sh
      |
      v
scripts/homebrew-bottle-build.sh
  brew install --build-bottle
  brew test
  brew bottle --json
  brew bottle --merge
      |
      v
scripts/homebrew-ghcr-upload.sh
      |
      v
generic sidecar input
  cache_key_sha, ABI, bottle URL, sha, bytes
  formula revision, bottle rebuild
  build/test/node/browser/upstream outcome lists
      |
      v
cargo xtask homebrew-sidecars
cargo xtask homebrew-validate
      |
      v
scripts/homebrew-publish-sidecars.sh
  success or durable failed attempt
      |
      v
Homebrew VFS builder and Node/browser smoke
```

Control-flow invariants:

- Formula `test do` must execute the Wasm through Kandelo, not as a host Linux
  binary.
- Bottle bytes, formula bottle blocks, sidecars, and provenance must be
  generated from the same build attempt.
- `cache_key_sha` must be computed for the Formula's Kandelo package identity
  and target arch. A bottle with a wrong cache key is stale even if Homebrew
  version selection would accept it.
- `sqlite` wasm64 publication can be attempted only if the Formula and package
  build path really honor `HOMEBREW_KANDELO_ARCH=wasm64`. `bzip2` and `xz`
  stay wasm32 unless their manifests and build paths are intentionally expanded.
- Browser compatibility can be recorded only after a browser smoke consumes a
  precomposed VFS image and runs the package or package-specific consumer
  through the normal browser host.
- Complete upstream-test outcome artifacts are package status metadata. They
  do not decide default bottle availability unless the implementation
  explicitly adds such a gate for one package.

## Formula Shape

### Shared Formula Pattern

Each Formula should:

1. Read `HOMEBREW_KANDELO_ROOT`, `HOMEBREW_KANDELO_ARCH`,
   `HOMEBREW_KANDELO_NODE`, and `HOMEBREW_KANDELO_LLVM_BIN`.
2. Source or route through the worktree-local SDK by prepending
   `<kandelo_root>/sdk/bin`.
3. Set `WASM_POSIX_DEP_VERSION`, `WASM_POSIX_DEP_SOURCE_URL`,
   `WASM_POSIX_DEP_SOURCE_SHA256`, `WASM_POSIX_DEP_OUT_DIR`,
   `WASM_POSIX_DEP_WORK_DIR`, and `WASM_POSIX_DEP_TARGET_ARCH`.
4. Install only the intended artifacts from the package output dir into the
   Homebrew keg.
5. Keep `test do` small, deterministic, and runtime-backed by Kandelo.

### SQLite Formula

`sqlite` should be modeled as a library Formula, not as the incomplete
`sqlite-cli` package.

Bottle contents:

- `lib/libsqlite3.a`
- `include/sqlite3.h`
- `include/sqlite3ext.h`
- `lib/pkgconfig/sqlite3.pc`

Formula `test do` should compile `packages/registry/sqlite/test/sqlite_basic.c`
or an equivalent inline test program against the installed keg and run the
result through Kandelo. This proves the installed library can be consumed and
executed without shipping a product CLI in the bottle.

Sidecar link manifest should include library, header, and pkg-config paths
under the Homebrew prefix, even though no executable link is produced. The VFS
builder should either support library-only bottles directly or the pilot should
record the missing library-only VFS link behavior as a blocker before claiming
sqlite browser compatibility.

### Bzip2 Formula

`bzip2` should be a program Formula that installs `bin/bzip2` from the produced
Wasm file. The pilot should decide whether library byproducts are intentionally
part of the bottle:

- Minimal program-only path: install `bin/bzip2` only. This best matches the
  current `[[outputs]]` program manifest.
- Expanded hybrid path: install `bin/bzip2`, `lib/libbz2.a`, and `include/bzlib.h`.
  This requires updating the package/Formula contract and treating the library
  outputs as deliberate bottle contents.

The minimal path is recommended for this pilot unless a downstream consumer
needs `libbz2.a` immediately.

Formula `test do` should run `bzip2 --version` through Kandelo and, if feasible,
perform a file-based round trip that avoids writing compressed bytes to a PTY:
create an input file, compress to an output file, decompress, and compare the
content inside the Kandelo VFS.

### Xz Formula

`xz` should be a program Formula that installs `bin/xz` from the produced Wasm
file. Before publication, resolve the current package/source mismatch:

- either keep package version `5.6.2` and make the build script use the
  manifest URL and sha through the resolver-style env vars;
- or intentionally update the package and Formula to `5.6.4` with correct
  source URL, sha, revision reasoning, and build-output validation.

The first option is safer for the pilot because it avoids changing package
output identity beyond the Homebrew path.

Formula `test do` should run `xz --version` through Kandelo and, if feasible,
perform a file-based compress/decompress round trip similar to `bzip2`.

## Sidecars And Outcome Metadata

The pilot needs generic sidecar generation before it can report truthful
package status for these packages. `scripts/homebrew-generate-sidecars-from-env.sh`
currently emits `hello`-specific outcome text and hardcoded browser/gallery
behavior. For this pilot, introduce or use a sidecar input file that records:

- formula and arch;
- package kind: `library` or `program`;
- selected smoke command or test-consumer command;
- bottle build/install result;
- Formula test result;
- sidecar validation result;
- Node VFS smoke result;
- browser VFS smoke result or skip/failure reason;
- upstream test status for sqlite;
- artifact paths for logs, reports, VFS builder reports, and outcome lists.

The generated sidecars should preserve the existing schema invariants while
allowing each package to report package-specific outcome lists. If the generic
input path cannot land cleanly inside this pilot, publish the package as
`failed`, `pending`, or `deferred` with a durable reason rather than reusing
misleading `hello` validation text.

## Node And Browser Smoke Strategy

Program packages:

- Build a Homebrew VFS from the selected bottle and sidecars.
- On Node, spawn `/home/linuxbrew/.linuxbrew/bin/bzip2` or
  `/home/linuxbrew/.linuxbrew/bin/xz` through `NodeKernelHost`.
- On browser, boot the same style of precomposed VFS image and run the
  executable through the browser terminal.
- Prefer a file round-trip smoke for final compatibility status. Version-only
  smoke may be recorded as partial if the file round trip is blocked by shell,
  PTY, or VFS-image limitations.

SQLite:

- Build a Homebrew VFS from the sqlite bottle and sidecars.
- Compile a test-only `sqlite_basic.wasm` consumer against the poured keg, or
  include a separately built validation artifact in the smoke image with
  provenance that names the source and compiler inputs.
- On Node, run the consumer with `NodeKernelHost`.
- On browser, boot a precomposed smoke image that includes the sqlite keg plus
  the test consumer and run the consumer through the browser terminal.
- Mark sqlite browser compatibility only if the consumer runs in the browser
  host. A library-only bottle build does not prove browser runtime support.

Negative smoke should remain part of the reusable harness:

- ABI mismatch rejects before bottle fetch.
- Missing bottle or sha mismatch rejects before image save.
- Cache-key mismatch rejects before compatibility is recorded.

## Upstream Test Status

SQLite is the only pilot package with an explicit upstream-test-status goal.

Existing runners:

- `scripts/run-sqlite-tests.sh` runs SQL fixture files through `sqlite3.wasm`.
- `scripts/run-sqlite-upstream-tests.sh` runs individual upstream Tcl tests.
- `scripts/run-sqlite-official-tests.sh` runs SQLite `testrunner.tcl` on Node
  or delegates to the browser runner.
- `scripts/run-sqlite-project-unit-tests.sh` combines Node and browser
  official-test runs and writes summaries.

The pilot should not require the full SQLite suite to pass before bottle
availability. It should publish upstream status with:

- permutation (`veryquick`, `full`, or `all`);
- host (`node`, `browser`, or both);
- total, passed, failed, skipped/omitted, running, ready, timeout, and
  incomplete counts when available;
- complete failure list with job/test name, state, case count, error count,
  elapsed time, and artifact path;
- complete skipped/omitted list with reasons when the harness exposes them;
- explicit "missing category" notes where current harnesses cannot emit a
  required list, plus a focused follow-up before the convoy claims complete
  upstream outcome-list support.

`bzip2` and `xz` should record upstream test status as `unavailable` or
`deferred` with a reason if this pilot only runs smoke tests. Do not imply that
version/round-trip smoke is an upstream full-test result.

## Implementation Sequence

1. Confirm the worktree is clean and preflighted for `kd-1mr.2`.
2. Bring the worktree to the intended Homebrew foundation commit if the branch
   is missing required `hello`, VFS builder, or sidecar work.
3. Add or update Formulae in the tap fixture or tap worktree for `sqlite`,
   `bzip2`, and `xz`.
4. Make the package build paths Formula-safe:
   - `sqlite`: use the resolver-style library output path and avoid the legacy
     CLI side path.
   - `bzip2`: prevent repo sysroot/local-binary side effects from being part
     of Formula installation, or isolate them behind `WASM_POSIX_DEP_OUT_DIR`.
   - `xz`: resolve the 5.6.2 vs 5.6.4 source mismatch before building.
5. Generalize sidecar input so package-specific validation and outcome lists
   are truthful for non-hello packages.
6. Build local dry-run bottles for the selected arches:
   - `sqlite`: wasm32 and wasm64 if the build path supports both.
   - `bzip2`: wasm32.
   - `xz`: wasm32.
7. Validate generated sidecars and provenance with `cargo xtask
   homebrew-validate`.
8. Materialize VFS images from the dry-run sidecars and run Node smokes.
9. Run browser smokes or record explicit host-failure status with artifact
   paths and next action.
10. Run SQLite upstream-test status jobs with durable outcome lists.
11. If local dry-run evidence is satisfactory, run trusted publication against
   `Automattic/kandelo-homebrew`. Keep local dry-run and trusted GHCR/tap
   evidence separate in bead notes and sidecars.
12. Create focused follow-up beads only for evidence-backed blockers or for the
   next specific package wave. Do not create broad waves from assumptions.

## Test And Documentation Plan

Required local checks for implementation work:

- `bash scripts/test-homebrew-publish-workflow.sh`
- `scripts/verify-homebrew-kandelo-platform-tags.sh`
- Homebrew dry-run bottle build for every selected `(formula, arch)`
- `cargo xtask homebrew-validate --tap-root <generated-sidecar-root>`
- VFS builder tests affected by sidecar/link behavior:
  `cd host && npx vitest run test/homebrew-vfs-planner.test.ts test/homebrew-vfs-builder.test.ts test/homebrew-vfs-fetch.test.ts`
- Package-specific Node smoke artifacts for sqlite, bzip2, and xz
- Package-specific browser smoke artifacts or explicit failure/skip status
- SQLite upstream status command, preferably:
  `scripts/run-sqlite-project-unit-tests.sh --host both --permutation veryquick`
  for pilot evidence before considering a broader `full` run

Required outcome artifacts:

- Build/install pass/fail list for each Formula/arch.
- Sidecar validation pass/fail list.
- Node smoke passed, failed, and skipped lists.
- Browser smoke passed, failed, and skipped lists with reasons.
- SQLite upstream passed, failed, skipped/omitted, and incomplete lists, or
  documented missing categories plus follow-up.
- Bottle build logs, bottle JSON, bottle archive sha/byte report, sidecar
  payload, VFS builder report, and browser smoke trace or screenshot artifacts.

Reference docs after implementation:

- Update `docs/homebrew-publishing.md` if the pilot generalizes non-hello
  sidecar input, non-hello browser smoke, library Formula support, or outcome
  metadata semantics.
- Update `docs/package-management.md` only if the package/cache/revision
  contract changes. Do not update it for tap-only Formula wording.
- Update package-specific docs or notes if `bzip2`/`xz` build scripts are
  converted from direct sysroot writers to resolver-style outputs.

Because this design artifact is docs-only, it requires only lightweight docs
verification. Runtime and package validation belongs to the implementation
work.

## Alternatives Considered

### Port sqlite alone

Rejected for the pilot. SQLite is the important dependency-root case, but it
does not exercise program link manifests, executable smoke commands, or small
CLI publication capacity. Adding `bzip2` and `xz` gives useful signal without
starting the full small-CLI wave.

### Port only small CLI packages

Rejected. The migration needs another dependency-root proof after `zlib`,
especially one with upstream-test status and wasm64 considerations.

### Treat sqlite as a CLI Formula

Rejected for this pilot. The current publishable registry package is the
library. `sqlite-cli` is manifest-incomplete and should be revived or removed
through a separate decision.

### Reuse current bzip2/xz scripts unchanged

Rejected as the default. They write into the repo sysroot and local-binaries,
which is not a clean Homebrew keg contract. The pilot may reuse their compile
knowledge, but Formula installation must be isolated to declared outputs.

### Mark browser support from Node VFS smoke

Rejected. Browser is a peer host. Node VFS materialization is necessary but not
sufficient for browser compatibility.

### Gate sqlite bottle availability on full upstream tests

Rejected. Upstream test status must be visible, but full-suite success is not
the default bottle gate. A failing upstream subset should publish a package
status and failure list without hiding a buildable/installable bottle.

## Risks And Mitigations

Registry and Formula divergence:

- Risk: Formulae and `packages/registry` scripts become two independent
  recipes during the bridge period.
- Mitigation: keep Formulae authoritative for Homebrew behavior, isolate any
  registry-script reuse behind explicit env vars, and record bridge deletion
  criteria in the broader replacement docs.

Misleading sidecars:

- Risk: reusing `hello`-specific sidecar text for non-hello packages would
  claim validation that did not run.
- Mitigation: add generic sidecar outcome input before success publication, or
  publish failure/deferred state with a blocker.

Library smoke ambiguity:

- Risk: a sqlite bottle can build and pour while no runtime consumer has proven
  the library works.
- Mitigation: require a test-only consumer on Node and browser before marking
  runtime compatibility.

Version/source drift:

- Risk: `xz` package metadata and build script fetch different versions.
- Mitigation: resolve source/version identity before any bottle evidence is
  accepted.

Browser parity drift:

- Risk: Node smokes pass but browser VFS boot, terminal execution,
  SharedArrayBuffer setup, or browser fetch path fails.
- Mitigation: record browser smoke separately and keep host-specific failures
  visible.

Outcome-list gaps:

- Risk: existing test runners emit summaries and failures but not complete
  passed/skipped lists.
- Mitigation: add exporters where reasonable; otherwise record the missing
  category and create a focused follow-up before claiming convoy completion.

Unnecessary rebuild churn:

- Risk: implementers bump `build.toml.revision` to force Homebrew rebuilds.
- Mitigation: use Homebrew formula revision or bottle rebuild for bottle
  selection. Bump Kandelo package revision only when package archive output
  bytes legitimately change.

## Open Questions

- Should `bzip2` and `xz` remain program-only bottles, or should their library
  byproducts become deliberate Homebrew bottle outputs?
- Does the VFS builder already handle library-only bottles well enough for
  sqlite browser smoke, or does the pilot need a small extension for
  validation-only consumers?
- Should sqlite wasm64 be trusted-published in this pilot, or should wasm64
  stay local evidence until the sidecar/browser story is proven on wasm32?
- What exact generic sidecar input format should replace the current
  `hello`-specific outcome generation?
- Which SQLite upstream-test permutation is the right first durable status:
  `veryquick`, `full`, or both with different publication meanings?
- Should `sqlite-cli` be revived as a separate Formula after the library pilot,
  or removed from the accepted package set before registry deletion?
