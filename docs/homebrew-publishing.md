# Homebrew Publishing

Kandelo's Homebrew publishing path is a first-party bottle publication and
validation pipeline. The implementation lives in the main
`Automattic/kandelo` repository; the live tap repository is
`Automattic/kandelo-homebrew`.

This is not a general user-facing Homebrew install guide yet. Do not document
`brew tap` or guest `brew install` commands until guest Homebrew install has
been validated through Kandelo. The supported implemented path today is:

- trusted CI builds Kandelo Homebrew bottles;
- bottle bytes publish to the GHCR/Homebrew bottle URL shape;
- formula `bottle do` blocks and Kandelo sidecars are generated together;
- host tooling pours verified bottles into precomposed VFS images;
- Node and browser smoke tests decide which runtime claims are recorded.

Homebrew formulae and bottle metadata remain Homebrew-native. Kandelo sidecar
metadata is an additional contract for VFS builders, Node validation, browser
automation, and publication audits; it is not a replacement for Formula Ruby or
Homebrew's `bottle do` block.

## Repositories And Ownership

| Repository | Owns |
|---|---|
| `Automattic/kandelo` | Schemas, validators, reusable workflows, package build scripts, VFS planner/builder, Node/browser smoke tests, and this documentation. |
| `Automattic/kandelo-homebrew` | Tap state: `Formula/`, generated `Kandelo/` sidecars, bottle blocks, and provenance reports. |

The checked-in `homebrew/kandelo-homebrew/` directory is a reviewable template
and test fixture for the tap shape. Live generated tap state belongs in
`Automattic/kandelo-homebrew`, not in the main repository template.

Use the full repository name in automation and documentation. The chosen tap
name intentionally differs from Homebrew's common `homebrew-<name>` repository
convention, so do not infer a short tap alias without verifying it.

## Artifact Model

Homebrew publishing is a sibling to Kandelo package archive publishing:

| Artifact | Storage | Consumer |
|---|---|---|
| Formula source and `bottle do` blocks | Tap git repository | Homebrew. |
| Bottle tarballs | GHCR/Homebrew bottle URL shape | Homebrew and Kandelo VFS builder. |
| `Kandelo/metadata.json` | Tap git repository | VFS planner, validator, audit tooling. |
| `Kandelo/formula/*.json` | Same as metadata | Formula-level Kandelo sidecar. |
| `Kandelo/link/*.json` | Same as metadata | VFS builder pour/link plan. |
| `Kandelo/reports/*.provenance.json` | Same as metadata | Durable publication and validation evidence. |
| Browser gallery assets | Run-scoped diagnostic artifact | Review evidence only; not a durable public gallery. |

Do not publish Homebrew bottles into Kandelo's `binaries-abi-v<N>` package
release, and do not use a Kandelo package-source `index.toml` as a substitute
for Homebrew bottle metadata. A package-source-shaped `gallery.json` and
`index.toml` may be generated only for browser-smoked precomposed VFS images.

## Kandelo Bottle Tags

Kandelo bottles use the Homebrew platform tags `wasm32_kandelo` and
`wasm64_kandelo`. The tag names intentionally keep the Kandelo ABI out of the
Homebrew tag. ABI compatibility belongs in Kandelo sidecar metadata, namespaces
such as `bottles-abi-v<N>`, and cache-key checks.

Homebrew's current bottle tag parser treats the token before the final
underscore as a CPU architecture only when it is listed in
`Hardware::CPU::ALL_ARCHS`. Without a patch, `wasm32_kandelo` is parsed as an
`x86_64` bottle for a synthetic `wasm32_kandelo` system and serializes back as
`x86_64_wasm32_kandelo`.

The carried patch is:

```text
homebrew/patches/0001-add-kandelo-wasm-bottle-tags.patch
```

It teaches Homebrew's parser that `wasm32` and `wasm64` are CPU architectures
for `system: :kandelo` and maps the supported prefix and cellar to:

```text
/home/linuxbrew/.linuxbrew
/home/linuxbrew/.linuxbrew/Cellar
```

Trusted CI applies this patch to a temporary Homebrew worktree. A short-lived
launcher symlink under the selected Homebrew prefix loads that worktree while
preserving the selected prefix and Cellar, so ordinary host build-dependency
bottles remain usable. The launcher and worktree are removed when the bottle
build exits. Do not patch a developer's host Homebrew checkout in place.

Verify the patch against a Homebrew checkout with:

```bash
scripts/dev-shell.sh bash scripts/verify-homebrew-kandelo-platform-tags.sh
```

## Formula Authoring

Formulae live under the tap's `Formula/` directory and should use normal
Homebrew DSL: `depends_on`, `resource`, `patch`, `revision`, `bottle do`,
`rebuild`, and `test do`.

Keep Kandelo-specific VFS planning data out of Formula Ruby. Link plans,
runtime support, browser compatibility, cache keys, and validation evidence
belong in generated `Kandelo/` sidecars.

For formulae that build Kandelo Wasm artifacts:

1. Build through Kandelo's normal SDK and package scripts. Source
   `sdk/activate.sh` or call an existing `packages/registry/<name>/build-*.sh`
   path through the trusted workflow environment.
2. Install only the produced Wasm artifacts into the Homebrew keg.
3. Preserve Homebrew's prefix and cellar model:
   `/home/linuxbrew/.linuxbrew` and
   `/home/linuxbrew/.linuxbrew/Cellar`.
4. Put runtime validation in `test do`, but execute Wasm through Kandelo
   rather than as a host Linux binary.
5. Update Homebrew `revision` or bottle `rebuild` when bottle bytes should move
   for Homebrew bottle selection. Update Kandelo `build.toml` `revision` only
   when the underlying Kandelo package output bytes legitimately change.

Formula Ruby should read these `HOMEBREW_KANDELO_*` variables for values that
must survive Homebrew environment handling:

```text
HOMEBREW_KANDELO_ROOT
HOMEBREW_KANDELO_ARCH
HOMEBREW_KANDELO_NODE
HOMEBREW_KANDELO_LLVM_BIN
```

Workflow-facing scripts use `KANDELO_HOMEBREW_*` variables outside Formula
Ruby.

## Dependency-First Bottles

Publish same-tap runtime dependencies before their consumers. The bottle
builder resolves the selected Formula's recursive runtime closure in
topological order, filters it to `Automattic/kandelo-homebrew`, and installs
each dependency separately with `--force-bottle --as-dependency
--ignore-dependencies`. A missing Kandelo bottle therefore fails before the
consumer source build; Homebrew is not allowed to silently replace a prior
library bottle with a dependency source build.

After building the consumer, the builder checks every same-tap dependency in
its `INSTALL_RECEIPT.json`. The installed dependency receipt must say
`built_as_bottle: true`, `poured_from_bottle: true`, and
`installed_on_request: false`, and its source tap commit must match the exact
planned tap. The selected Formula's `wasm32_kandelo` or `wasm64_kandelo`
bottle digest and bounded fetch/pour log lines are recorded alongside those
receipt facts. Raw logs do not cross the runner boundary. Fresh verifier and
finalizer runners rehash each dependency Formula from the exact planned tap
before accepting the bounded provenance.

The exact same-tap closure resolved before installation must equal the closure
recorded in the target receipt. A missing or unexpected receipt entry fails the
build before any publication handoff is created.

Fresh verifier and finalizer validation independently derive that closure from
the exact tap without evaluating Formula Ruby. Same-tap dependencies must use
direct Formula class-body literal declarations such as `depends_on
"automattic/kandelo-homebrew/zlib"`. The static resolver includes untagged and
`:recommended` dependencies, excludes the canonical `:build`, `:test`, and
`:optional` forms, and recursively resolves explicit same-tap references.
Conditional, interpolated, helper-hidden, unknown-tag, duplicate, and cyclic
dependency declarations fail closed. The submitted provenance dependency set
must exactly equal this independently derived closure, including for an empty
root-package closure.

The finalizer also independently derives the root Formula's direct same-tap
runtime dependencies. Each provenance record's `declared_directly` value must
match that source-derived set, and the composition handoff's `{name, version}`
dependency array must exactly equal the direct provenance records. Missing,
extra, duplicate, wrong-version, or forged-directness entries fail before
sidecars are generated.

For every closure member, the resolver also reads the canonical static
`bottle do` block and derives the selected architecture's cellar, rebuild,
digest, tag, and digest-bound URL. Fresh validation requires the submitted
prior-bottle record to equal that exact tap data; a closure member with no
selected-architecture bottle fails validation.

This non-evaluating boundary permits normal static Formula structure without
executing it. `patch do` and `resource do` are limited to canonical literal
metadata, class constants must be static data, and private instance helpers use
an explicit reviewed name allowlist so Formula, Ruby initialization, and
dependency hooks cannot be overridden. The
shared `KandeloFormulaSupport` file is accepted only when its top level is the
three standard-library requires plus a module containing static `KANDELO_`
constants and unique `kandelo_` or `formula_opt_` instance methods. Load-time
hooks, arbitrary class methods, dependency metaprogramming, and other
executable class/module structures fail closed.

## Trusted Publish Flow

The reusable publisher is:

```text
.github/workflows/reusable-homebrew-bottle-publish.yml
```

The tap may call it with:

```yaml
jobs:
  publish:
    permissions:
      contents: write
      packages: write
      actions: read
    uses: Automattic/kandelo/.github/workflows/reusable-homebrew-bottle-publish.yml@<trusted-ref>
    with:
      tap-repository: Automattic/kandelo-homebrew
      formulae: hello
      arches: wasm32
```

The caller grants the maximum permission ceiling. A write-capable publication
caller must grant `contents: write`, `packages: write`, and `actions: read`, but
the reusable workflow explicitly downgrades each job to its required subset.
The build and verification jobs receive only read permissions, the uploader
receives `packages: write` but not `contents: write`, and the tap finalizer
receives `contents: write` but not `packages: write`. A nested workflow cannot
elevate above its caller's ceiling. Because the reusable graph statically
contains write-capable jobs, the reviewed dry-run caller grants the same maximum
ceiling; those write-capable jobs do not schedule, and every job that does
schedule explicitly narrows itself to read scopes. PRs from untrusted forks must
not receive this caller ceiling; they can run schema and local build checks but
cannot invoke the trusted publisher.

Every call is fixed to a reviewed `repository_dispatch` workflow in
`Automattic/kandelo-homebrew@main`. Non-dry calls may come from
`publish-bottles.yml` or `maintain-bottles.yml`; dry calls must come from
`dry-run-bottles.yml`. The normal caller is displayed as
**Publish Kandelo bottles**; do not restore the narrower legacy **Publish hello
bottle** name.
Write-capable publication is additionally fixed to `Automattic/kandelo@main`
and `Automattic/kandelo-homebrew@main`. The bottle root is never caller-selected:
the workflow rejects a non-empty `bottle-root-url` and derives
`https://ghcr.io/v2/<lowercase-owner>/<lowercase-repository>` from the tap
repository. Arbitrary Kandelo or tap refs are accepted only by the reviewed
dry-run caller. The maintenance workflow is callable but is not directly
branch-dispatchable; its operator-facing caller must live on the protected
default branch and grant write scopes explicitly. Third-party actions in the
privileged path are pinned by commit.

After a read-only planning job resolves the immutable Kandelo commit, tap
commit, ABI namespace, derived bottle root, and formula matrix, each
`(formula, arch)` entry crosses four separate runner roles:

1. `build-and-test` is read-only. It checks out the exact inputs and reviewed
   Homebrew/brew commit, and exposes the patched temporary Homebrew worktree
   through a short-lived launcher under the canonical
   `/home/linuxbrew/.linuxbrew` prefix. This preserves the selected prefix and
   Cellar so ordinary host build-dependency bottles remain usable. Within that
   read-only build, Homebrew uses a build-local XDG configuration store and
   trusts only the reviewed selected tap before evaluating its dependency
   Formulae. The store is removed with the build work directory; the publisher
   does not disable tap-trust enforcement or reuse persistent account state.
   The job then builds the required Kandelo pieces. Before Formula execution it
   uses the authoritative package resolver in fetch-only mode to materialize a
   wasm32 base shell-script test runtime: Dash, Coreutils, Grep, and Sed. The
   host resolver intentionally maps unqualified `programs/<tool>.wasm` paths to
   wasm32 even for a wasm64 bottle matrix entry, so this runtime does not vary
   with the Formula's target architecture. These binaries are Kandelo
   base-system prerequisites, not Formula dependencies or evidence for the
   migrated package; source-build fallback is disabled. The job executes the
   Formula build and test without publisher credentials. Its strict handoff
   contains only `manifest.json`, Homebrew's bottle JSON, one gzip bottle
   archive, and bounded `dependency-provenance.json`. It contains no Formula
   source, scripts, environment files, raw logs, or credentials.

   The handoff remains explicitly bounded while supporting complete large
   packages: Homebrew bottle JSON is capped at 16 MiB, dependency provenance at
   1 MiB, and the compressed bottle at 2 GiB. Generated formula and link
   sidecars are each capped at 16 MiB. Artifact transport uses compression level
   zero because the bottle is already a gzip stream. Validators reject the
   first byte beyond each bound; large packages are not made publishable by
   truncating their file inventories or installed payloads.
   `scripts/homebrew-publication-limits.sh` owns these byte limits; creators,
   validators, and the final refreshed-tap publisher consume the same values.
2. `upload-bottle` runs only for a write publication and receives only
   `packages: write`. On a fresh runner it validates the strict build handoff
   against the plan before exposing the token to an isolated ORAS upload. Its
   only output is a strict data receipt identifying the uploaded digest URL,
   SHA-256, byte count, and image tag.
3. `verify-bottle` is read-only and starts from fresh exact source checkouts. It
   revalidates the build handoff and receipt, fetches the full Kandelo ABI
   runtime graph, builds the VFS image, and runs the runtime and browser gates.
   It uses the locally built bottle in dry-run mode. In write mode it discards
   that bottle as runtime evidence and instead anonymously downloads the GHCR
   digest URL, then rechecks SHA-256 and byte count. This is the only
   post-build role that evaluates the reviewed Formula through Homebrew. The
   trusted generator combines Homebrew's rich bottle receipt and `brew info`
   output to derive formula identity, declared direct dependencies, keg link
   paths, and fork-instrumentation evidence. It generates a full candidate tap
   for validation, but the publication handoff contains only the strict build
   files, upload receipt, selected runtime bottle bytes, and one package-scoped
   `composition/sidecars-input.json`. Downstream jobs never execute
   artifact-provided scripts, Formulae, or environment files.
4. `finalize-tap` runs only for a write publication and receives only
   `contents: write`. On another fresh runner it validates the complete
   publication handoff as inert data against the exact base tap before checking
   out with push credentials. The publisher then acquires the tap state lock,
   refreshes `main`, verifies that the exact archived Formula is still an
   ancestor and that its bottle-excluded source digest has not changed,
   statically composes the selected bottle tag, and regenerates aggregate
   sidecars from refreshed tap metadata. A sibling-architecture tag is retained
   only when the refreshed metadata proves the same ABI, version, formula
   revision, and bottle rebuild. It does not load Formula Ruby or run Homebrew
   in the credentialed role. Only the composed and fully validated Formula
   update, sidecars, and provenance are pushed.

Tap writes use a tap-wide state lock, an attached `main` checkout, an explicit
remote-main refresh, and an explicit `HEAD:refs/heads/main` push. The workflow
uses a separate clean checkout for failure reports so a partially generated or
locally committed success attempt cannot enter a last-green failure commit.

Use `dry-run: true` for local or CI validation that must not push GHCR blobs or
tap commits. Dry runs still build bottles and validate the generated metadata
shape. They seed the VFS builder from the current local bottle. Non-dry runs
seed it only with bytes returned by the anonymous GHCR readback. The publisher
deliberately does not restore GitHub
Actions dependency caches: selected tap and Kandelo refs are executable code,
and a manually dispatched dry run can write Actions storage in the same
repository scope as a later privileged publish. Run-scoped diagnostic artifacts
remain available, but cached build output is not an input to bottle publication.

`bottles-abi-v<N>` is currently a metadata namespace, not a promise that a
GitHub Release with that tag contains sidecars or gallery archives. Immutable,
serialized gallery release publication is deferred. Do not restore the old
mutable `gh release upload --clobber` path.

## Sidecar Metadata

Generate sidecars with:

```bash
scripts/dev-shell.sh cargo xtask homebrew-sidecars \
  --tap-root /path/to/kandelo-homebrew \
  --input /path/to/sidecars-input.json \
  --previous-metadata /path/to/previous/Kandelo/metadata.json
```

Validate generated tap metadata with:

```bash
scripts/dev-shell.sh cargo xtask homebrew-validate \
  --tap-root /path/to/kandelo-homebrew
```

`homebrew-validate` checks JSON schema shape plus cross-file facts:

- metadata ABI matches the `bottles-abi-v<N>` namespace;
- formula sidecars agree with `metadata.json`;
- bottle arch and `bottle_tag` agree;
- link manifests stay inside the Homebrew prefix;
- link sources and receipts are declared;
- provenance and metadata shas agree;
- browser-compatible bottles include browser validation evidence.

Bottle status follows Kandelo's last-green model:

- `success`: current bottle fields are authoritative.
- `failed`: latest rebuild failed; complete fallback fields may point at the
  previous successful bottle.
- `pending` or `building`: rebuild is queued or running; consumers may use a
  complete fallback.

Failure reporting must not replace last-green metadata. The workflow's failure
path checks out a fresh tap, refreshes it to `origin/main` under the tap-wide
lock, and calls `scripts/homebrew-publish-sidecars.sh --status failed`. The
report records the resolved Kandelo and tap source commits plus the workflow run
URL, but not raw stderr. The previous successful bottle remains selectable when
its fallback fields are complete. Maintenance exposes only `rebuild` and
`rollback`; there is no workflow-level `repair-only` mode.

## VFS Planning And Building

Homebrew-derived VFS images are built from sidecars and verified bottle bytes,
not from Formula Ruby.

The guest Homebrew bootstrap image is a separate diagnostic and integration
artifact. Build it from the pinned, unmodified upstream Homebrew source archive
and ABI-current Kandelo package artifacts with:

```bash
./scripts/dev-shell.sh scripts/build-homebrew-bootstrap.sh
```

The script writes `target/homebrew-bootstrap/homebrew-bootstrap.vfs`. It derives
the ABI from `crates/shared`, resolves the Node kernel, canonical rootfs package
set, and Homebrew bootstrap programs through `xtask build-deps`, and records
the exact upstream Homebrew commit and archive hash in
`/etc/kandelo/homebrew-image.json`. The default 768 MiB VFS capacity leaves
writable space for real guest Homebrew operations; use `--sab-size` and
`--max-size` when a specific integration test needs a different capacity.
The bootstrap manifest explicitly trusts executable bits from the pinned
`git archive` ZIP. `mkrootfs` imports only those Unix `0111` bits; ownership,
directory modes, non-executable file modes, and all other permission bits stay
normalized by the manifest.

`--skip-package-resolve` is only for a worktree whose `binaries/` tree has
already been materialized. It still validates every required output and fails
if any artifact is absent, has a stale ABI marker, lacks executable exports, or
contains retired Asyncify instrumentation. The bootstrap image does not prove
that a formula was built from, published as, or poured from a Homebrew bottle;
those claims require the trusted publish and bottle validation paths below.

The shared planner is `planHomebrewVfs()` in
`host/src/homebrew-vfs-planner.ts`. It consumes `Kandelo/metadata.json` plus a
caller-provided link-manifest loader and rejects bad ABI, unsupported arch,
cache-key drift, missing packages, dependency cycles, unsafe paths, and
link-manifest bottle drift before any bottle bytes are extracted.

The Node-side builder is `buildHomebrewVfs()` in
`host/src/homebrew-vfs-builder.ts`. It verifies bottle byte count and sha256,
extracts supported tar entries, stages kegs under the declared prefix,
validates receipts, applies link manifests, writes
`/etc/kandelo/homebrew-vfs.json`, and emits a build report.

Build a precomposed image with:

```bash
scripts/dev-shell.sh npx tsx images/vfs/scripts/build-homebrew-vfs-image.ts \
  --metadata /path/to/kandelo-homebrew/Kandelo/metadata.json \
  --tap-root /path/to/kandelo-homebrew \
  --package hello \
  --arch wasm32 \
  --runtime node \
  --out target/homebrew-hello.vfs.zst \
  --report target/homebrew-hello.vfs-report.json
```

The bottle fetcher follows GHCR `WWW-Authenticate` bearer challenges. Public
bottle materializers do not need a GitHub token merely to read public GHCR
blobs.

## Node And Browser Claims

Node and browser support are explicit metadata claims.

The Node smoke for the published `hello` bottle:

```bash
scripts/dev-shell.sh npx tsx packages/registry/hello/test/homebrew-node-smoke.ts \
  --result-dir test-runs/homebrew-node-smoke \
  --tap-repository Automattic/kandelo-homebrew
```

It clones or reads the tap, builds a Homebrew VFS from published sidecars, runs
`/home/linuxbrew/.linuxbrew/bin/hello --version` through `NodeKernelHost`, and
checks negative ABI-mismatch and missing-bottle cases.

Browser compatibility requires a separate browser smoke. For the current
`hello` path, the trusted publisher builds a precomposed wasm32 VFS image,
serves it through the browser demo, runs Chromium Playwright against
`apps/browser-demos/test/kandelo-homebrew.spec.ts`, and executes:

```bash
/home/linuxbrew/.linuxbrew/bin/hello --version
```

Only after that smoke passes may sidecars record
`runtime_support = ["node", "browser"]` and `browser_compatible = true`.
Packages without a successful browser smoke remain Node-only.

The `hello` package bytes in this smoke come from the current Homebrew bottle:
from the local build in dry-run mode, or from the anonymously fetched GHCR blob
in write mode. The browser demo still resolves Kandelo-owned ABI platform
prerequisites such as `node.wasm` and `node-vfs.vfs.zst` through Kandelo's normal
binary release. Those platform assets are not the migrated package under test.

## Browser Gallery Assets

Generate browser gallery assets only from browser-smoked wasm32 metadata:

```bash
scripts/dev-shell.sh bash scripts/homebrew-create-browser-gallery.sh \
  --metadata /path/to/kandelo-homebrew/Kandelo/metadata.json \
  --image target/homebrew-hello.vfs.zst \
  --report target/homebrew-hello.vfs-report.json \
  --out target/homebrew-gallery \
  --formula hello
```

The script writes `gallery.json`, `index.toml`, and a package-source-shaped
`.tar.zst` whose payload is the precomposed `.vfs.zst` image. It refuses
metadata where the wasm32 bottle is not `status = "success"` and
`browser_compatible = true`.

`scripts/validate-software-gallery.mjs` verifies that every gallery entry has
wasm32 success metadata, an `archive_url`, and `browser_compatible = true`.
Launch-time archive failures must remain visible in the Kandelo UI. The trusted
publisher retains these generated files as run diagnostics only. Durable public
gallery publication requires a separate immutable asset contract.

## Operational Boundaries

- Do not evaluate Formula Ruby in host or browser VFS tooling.
- Use a disposable Homebrew prefix for local bottle builds. The trusted CI
  runner is disposable; a local run installs the target formula and ordinary
  host build dependencies into the prefix selected by `HOMEBREW_BREW_FILE`.
  Same-tap runtime dependencies must already have matching Kandelo bottles.
- Do not treat a successful bottle build as browser support.
- Do not mark `browser_compatible = true` without browser smoke evidence.
- Do not use Homebrew sidecars to weaken Kandelo ABI or cache-key checks.
- Do not publish user-facing `brew install` instructions until guest Homebrew
  install is validated.
- Do not delete GHCR bottle blobs as the normal recovery path. Prefer marking a
  failed attempt and preserving last-green fallback metadata.
- Publication must compose peer packages and same-identity sibling-architecture
  bottle tags from refreshed tap state while holding the tap lock. Identity
  transitions discard all old sibling tags before publishing the selected
  architecture. Formula source changes after planning, noncanonical bottle
  blocks, Formula root/tag/digest disagreement with the tap sidecars, or
  symlinks in refreshed `Formula/` and `Kandelo/` state must fail publication;
  a global lock alone does not make stale aggregate sidecars safe.
- Do not publish a new formula's tap metadata until its GHCR package passes the
  anonymous digest readback. New GHCR packages are private by default; changing
  package visibility is an explicit operator action, not a workflow side effect.
- Do not bump `build.toml` revisions for docs-only changes.

## Current Gaps

The implemented path covers a trusted bottle build, GHCR upload plus anonymous
readback, sidecar validation, verified VFS image building, browser smoke,
diagnostic gallery gating, and lossless under-lock tap composition with Formula
source-drift rejection. Public visibility provisioning for new GHCR packages,
immutable gallery release publication, broader package coverage, general guest
`brew install`, and full operator runbooks remain separate work.
