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
| `Automattic/kandelo-homebrew` | Tap state: `Formula/`, generated `Kandelo/` sidecars, bottle blocks, provenance reports, and `bottles-abi-v<N>` release assets. |

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
| `Kandelo/metadata.json` | Tap git repository and `bottles-abi-v<N>` release | VFS planner, validator, audit tooling. |
| `Kandelo/formula/*.json` | Same as metadata | Formula-level Kandelo sidecar. |
| `Kandelo/link/*.json` | Same as metadata | VFS builder pour/link plan. |
| `Kandelo/reports/*.provenance.json` | Same as metadata | Durable publication and validation evidence. |
| Browser gallery assets | `bottles-abi-v<N>` release | Kandelo browser gallery. |

Do not publish Homebrew bottles into Kandelo's `binaries-abi-v<N>` package
release, and do not use a Kandelo package-source `index.toml` as a substitute
for Homebrew bottle metadata. A package-source-shaped `gallery.json` and
`index.toml` may be generated only for browser-smoked precomposed VFS images.

## Kandelo Bottle Tags

Kandelo bottles use the Homebrew platform tags `wasm32_kandelo` and
`wasm64_kandelo`. The tag names intentionally keep the Kandelo ABI out of the
Homebrew tag. ABI compatibility belongs in Kandelo sidecar metadata, release
names such as `bottles-abi-v<N>`, and cache-key checks.

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

Trusted CI applies this patch to a temporary Homebrew worktree. Do not patch a
developer's host Homebrew checkout in place.

Verify the patch against a Homebrew checkout with:

```bash
scripts/verify-homebrew-kandelo-platform-tags.sh
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

The reusable workflow does not request token permissions of its own. The caller
owns that trust decision: publication callers must explicitly grant
`contents: write` and `packages: write`, while dry-run callers grant only the
read scopes needed to fetch source and existing packages. GitHub does not allow
a nested workflow to elevate its caller's token, so adding write permissions to
the reusable workflow would invalidate read-only dry-run callers rather than
silently cap them. PRs from untrusted forks must not receive write permissions;
they can run schema and local build checks but cannot publish bottles or tap
metadata.

For each `(formula, arch)` entry, the trusted path:

1. Checks out the tap and the selected Kandelo ref.
2. Installs Homebrew and enters Kandelo's `scripts/dev-shell.sh`.
3. Builds the Kandelo sysroot and kernel pieces required by formula tests.
4. Runs `scripts/homebrew-bottle-build.sh`, which builds through Homebrew,
   applies the Kandelo bottle-tag patch in a temporary Homebrew worktree,
   runs the formula test, and merges the generated bottle block.
5. Uploads bottle bytes through `scripts/homebrew-ghcr-upload.sh`.
6. Generates sidecars with `cargo xtask homebrew-sidecars` through
   `scripts/homebrew-generate-sidecars-from-env.sh` or another trusted
   `sidecar-command`.
7. Validates the generated sidecars.
8. Publishes formula changes, sidecars, provenance, and release assets with
   `scripts/homebrew-publish-sidecars.sh`.

The publish concurrency group is scoped by tap repository and target release
tag so metadata writes for the same `bottles-abi-v<N>` release serialize.

Use `dry-run: true` for local or CI validation that must not push GHCR blobs,
tap commits, or release assets. Dry runs still build bottles and validate the
generated metadata shape. The publisher deliberately does not restore GitHub
Actions dependency caches: selected tap and Kandelo refs are executable code,
and a manually dispatched dry run can write Actions storage in the same
repository scope as a later privileged publish. Run-scoped diagnostic artifacts
remain available, but cached build output is not an input to bottle publication.

## Sidecar Metadata

Generate sidecars with:

```bash
cargo xtask homebrew-sidecars \
  --tap-root /path/to/kandelo-homebrew \
  --input /path/to/sidecars-input.json \
  --previous-metadata /path/to/previous/Kandelo/metadata.json
```

Validate generated tap metadata with:

```bash
cargo xtask homebrew-validate --tap-root /path/to/kandelo-homebrew
```

`homebrew-validate` checks JSON schema shape plus cross-file facts:

- metadata release ABI matches `bottles-abi-v<N>`;
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
path calls `scripts/homebrew-publish-sidecars.sh --status failed` so the failed
attempt is durable while the previous successful bottle remains selectable when
its fallback fields are complete.

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
npx tsx images/vfs/scripts/build-homebrew-vfs-image.ts \
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
npx tsx packages/registry/hello/test/homebrew-node-smoke.ts \
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

## Browser Gallery Assets

Generate browser gallery assets only from browser-smoked wasm32 metadata:

```bash
scripts/homebrew-create-browser-gallery.sh \
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
Launch-time archive failures must remain visible in the Kandelo UI.

## Operational Boundaries

- Do not evaluate Formula Ruby in host or browser VFS tooling.
- Do not treat a successful bottle build as browser support.
- Do not mark `browser_compatible = true` without browser smoke evidence.
- Do not use Homebrew sidecars to weaken Kandelo ABI or cache-key checks.
- Do not publish user-facing `brew install` instructions until guest Homebrew
  install is validated.
- Do not delete GHCR bottle blobs as the normal recovery path. Prefer marking a
  failed attempt and preserving last-green fallback metadata.
- Do not bump `build.toml` revisions for docs-only changes.

## Current Gaps

The implemented path covers trusted first bottle publication, sidecars,
verified VFS image building, Node smoke, browser smoke, and gallery gating.
Broader package coverage, general guest `brew install`, and full manual
rebuild/rollback runbooks remain separate work and should stay out of
reference docs until they land.
