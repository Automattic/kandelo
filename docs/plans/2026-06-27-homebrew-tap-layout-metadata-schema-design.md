# Homebrew Tap Layout And Metadata Schema Scaffold

Date: 2026-06-27

Tracked work:

- `kd-8ho` - Homebrew CI and GitHub Packages publishing path.
- `kd-8ho.1` - Scaffold tap layout and metadata schemas.

## Problem Statement

Kandelo needs a first implementation slice for Homebrew publishing that is
reviewable before the real tap repository exists. The slice must define the
future tap layout, the JSON schemas for Kandelo sidecar metadata, and examples
that later validators, workflows, VFS planners, and docs can share.

The implementation home is the main `Automattic/kandelo` repository. The
future tap repository name is `Automattic/kandelo-homebrew`; this supersedes
the older `Automattic/homebrew-kandelo` name in the 2026-06-25 publishing
design. The main-repo scaffold must therefore be a copyable template for
`Automattic/kandelo-homebrew`, not a claim that Homebrew publishing is already
user-facing.

The scaffold has to preserve the boundary between:

- Homebrew formula and bottle metadata consumed by `brew`;
- Kandelo sidecar metadata consumed by host VFS tooling, Node validation, and
  browser/gallery gates;
- Kandelo package archive `index.toml` ledgers, which remain a separate
  distribution path.

## Non-Goals

- Do not create or push the real `Automattic/kandelo-homebrew` repository.
- Do not publish bottles, release assets, GitHub Packages, or VFS images.
- Do not implement the Homebrew platform tag patch for `wasm32_kandelo` or
  `wasm64_kandelo`; that remains `kd-8ho.4`.
- Do not implement the semantic validator, VFS planner, VFS builder, CI
  publisher, Node smoke, browser smoke, docs runbook, or rollback workflow.
- Do not evaluate Formula Ruby in host or browser tooling.
- Do not update reference docs as if Homebrew support exists for users. This
  design and the scaffold are preparatory.

## Users And Operator Workflows

### Maintainer Review

A maintainer reviews a main-repo PR that adds the scaffold and examples. The
review should answer:

- Does the template match the future tap repo shape?
- Are examples realistic enough for the validator and workflow generator to
  test against?
- Is the sidecar metadata explicit about ABI, arch, bottle URL, sha256,
  cache key, runtime support, and browser compatibility?
- Are unsupported or future fields marked as future work rather than silently
  accepted?

### Publish Workflow Author

The `kd-8ho.3` and `kd-8ho.6` implementers use the scaffold as the generated
output contract. Their workflow reads formula/build outputs, runs Homebrew
bottle commands, computes Kandelo cache keys, generates sidecars, validates the
whole payload, and writes it into the tap commit and release assets.

### Host VFS Planner And Builder

The `kd-8ho.7` and `kd-8ho.8` implementers consume `Kandelo/metadata.json` and
per-bottle link manifests. They should not evaluate Formula Ruby. They fetch
JSON metadata, verify bottle bytes, reject ABI or cache-key mismatches, and
pour/link only according to the validated link manifest.

### Browser And Node Validators

Node validation can eventually boot a Homebrew-prefix VFS image and run the
published program through normal Kandelo process execution. Browser validation
can use a precomposed VFS image only when metadata explicitly marks the package
browser-compatible and the browser fetch/CORS path has been tested.

### Guest Homebrew User

The guest user eventually installs from the tap through normal Homebrew
formulae. The scaffold should not require the user to know about Kandelo
sidecars, but every published sidecar must match the bottle block selected by
Homebrew.

## Proposed In-Repo Scaffold

Add a copyable tap template under the main repo:

```text
homebrew/
  kandelo-homebrew/
    README.md
    Formula/
      README.md
    Kandelo/
      README.md
      metadata.schema.json
      formula.schema.json
      link-manifest.schema.json
      provenance.schema.json
      examples/
        metadata.json
        formula/
          hello.json
        link/
          hello-2.12.1-rebuild0-wasm32.json
        reports/
          hello-2.12.1-rebuild0-wasm32.provenance.json
```

Rationale:

- `homebrew/kandelo-homebrew/` names the future repository exactly while
  making clear that the checked-in directory is a template inside Kandelo.
- `Formula/` mirrors Homebrew tap layout without landing a real formula before
  `kd-8ho.5`.
- `Kandelo/` mirrors the future generated sidecar directory. The schema files
  stay in the template root so a copied tap can validate itself.
- Examples live under `Kandelo/examples/` to avoid implying that the main repo
  contains current published tap state.

When the real tap exists, the tap root should contain the same top-level
`Formula/` and `Kandelo/` directories, with generated live metadata at:

```text
Kandelo/metadata.json
Kandelo/formula/<name>.json
Kandelo/link/<formula>-<version>-rebuild<N>-<arch>.json
Kandelo/reports/<formula>-<version>-rebuild<N>-<arch>.provenance.json
```

## Homebrew Naming Boundary

The owner decision is `Automattic/kandelo-homebrew`. Homebrew documentation
recommends GitHub tap repository names that start with `homebrew-` for the
short tap command, while also documenting GitHub taps and explicit URL forms.
Because the chosen name intentionally does not use the older
`homebrew-kandelo` shape, implementation must verify the exact command surface
before publishing user docs.

Until that verification lands:

- examples and generated metadata should record
  `tap_repository = "Automattic/kandelo-homebrew"`;
- internal automation should use the full repository URL when ambiguity
  matters;
- user-facing docs must not advertise `Automattic/kandelo` or any inferred
  short alias.

## Architecture And Data Flow

```text
Kandelo package recipe/build state
  package.toml + build.toml + computed cache_key_sha
        |
        v
Trusted Homebrew publish workflow
  brew install --build-bottle
  brew bottle --json
  formula test through Kandelo
        |
        v
Generated tap payload
  Formula/<name>.rb bottle block
  Kandelo/metadata.json
  Kandelo/formula/<name>.json
  Kandelo/link/<bottle>.json
  Kandelo/reports/<bottle>.provenance.json
        |
        v
Tap git commit and bottles-abi-v<N> release assets
        |
        v
Consumers
  guest brew install: Formula bottle block
  host VFS planner: metadata + formula sidecar
  host VFS builder: link manifest + verified bottle bytes
  Node/browser gates: runtime_support and browser_compatible
```

Control-flow invariants:

- The generated `Kandelo/metadata.json` is single-ABI. Mixed ABI metadata is a
  publish blocker.
- The sidecar does not replace Homebrew's `bottle do` block. It lets Kandelo
  tooling verify and pour the same bottle without evaluating Ruby.
- Bottle URLs and sha256 values come from the produced bottle bytes, not from
  guessed GitHub Packages paths.
- `cache_key_sha` remains Kandelo's strict build-equivalence axis. A bottle
  with the right Homebrew version but the wrong cache key is stale for Kandelo.
- Runtime support is explicit. `runtime_support = ["node"]` never implies
  browser support.
- Last-green fallback semantics should mirror Kandelo's binary `index.toml`
  model, but consumers must still reject ABI, sha256, path, or cache-key
  mismatches.

## Schema Contracts

Use JSON Schema draft 2020-12 for the reviewable shape and `xtask` semantic
validation for cross-file and archive checks. JSON Schema is good at field
presence, scalar formats, enum values, and path syntax. It is not sufficient
for "link target exists in this tarball", "metadata ABI matches release tag",
or "formula bottle block agrees with sidecar sha256".

### Shared Scalar Rules

- `schema` is integer `1`.
- `name` is `^[a-z0-9][a-z0-9._-]*$`.
- `arch` is `wasm32` or `wasm64`.
- `bottle_tag` is initially `wasm32_kandelo` or `wasm64_kandelo`.
- `kandelo_abi` is integer `>= 1`.
- `sha256`, `cache_key_sha`, `formula_sha256`, and metadata shas are lowercase
  64-character hex strings.
- `url` fields are absolute `https://` URLs except local test fixtures, which
  may use `file://` only under an explicit fixture flag in semantic tests.
- Tap-relative paths use forward slashes and must not start with `/`, contain
  empty segments, or contain `.` or `..` segments.
- Guest prefix-relative paths follow the same path rules and are interpreted
  relative to the declared Homebrew `prefix`.

### `metadata.schema.json`

Purpose: top-level index for one generated tap commit and ABI release.

Required top-level fields:

```json
{
  "schema": 1,
  "tap_repository": "Automattic/kandelo-homebrew",
  "tap_name": "automattic/kandelo-homebrew",
  "tap_commit": "<40-hex>",
  "kandelo_repository": "Automattic/kandelo",
  "kandelo_commit": "<40-hex>",
  "kandelo_abi": 15,
  "release_tag": "bottles-abi-v15",
  "generated_at": "2026-06-27T00:00:00Z",
  "generator": "kandelo-homebrew-publish 1",
  "packages": []
}
```

Each package entry contains:

- `name`, `full_name`, `version`, `formula_revision`, `bottle_rebuild`;
- `formula_path`;
- `formula_metadata` path, such as `Kandelo/formula/hello.json`;
- `dependencies`, as formula names plus version constraints only when the
  Homebrew formula needs them;
- `bottles`, one per `(formula, arch, rebuild)` entry.

Each bottle entry contains:

- `arch`, `bottle_tag`, `kandelo_abi`;
- `cellar`, `prefix`, `url`, `sha256`, `bytes`;
- `cache_key_sha`;
- `link_manifest`;
- `runtime_support`;
- `browser_compatible`;
- `fork_instrumentation`;
- `status`;
- `built_by`;
- `built_from`.

Status rules:

- `success` requires current `url`, `sha256`, `bytes`, `cache_key_sha`, and
  `link_manifest`.
- `failed` requires `error`, `last_attempt`, and `last_attempt_by`.
- `pending` and `building` require `last_attempt` or `queued_at`.
- Any non-success entry may include `fallback_*` fields for the last-green
  bottle, but fallback fields must be complete as a set:
  `fallback_url`, `fallback_sha256`, `fallback_bytes`,
  `fallback_cache_key_sha`, `fallback_link_manifest`, and
  `fallback_built_at`.

Semantic validator checks:

- `kandelo_abi` equals the ABI in `release_tag`.
- Every bottle entry has the same `kandelo_abi` as the top level.
- `formula_metadata` and `link_manifest` paths exist in the generated payload.
- `bottle_tag` is consistent with `arch`.
- `browser_compatible = true` is allowed only when `runtime_support` includes
  `browser`.
- Package and bottle entries are sorted deterministically.

### `formula.schema.json`

Purpose: per-formula sidecar for tooling that wants one formula without
downloading the full index.

Fields mirror a single `packages[]` entry from `metadata.json`, plus:

- `schema`;
- `tap_repository`;
- `tap_commit`;
- `kandelo_abi`;
- `source_metadata`, the tap-relative path back to `Kandelo/metadata.json`.

Semantic validator checks:

- The formula sidecar is byte-for-byte consistent with the corresponding
  package entry in `metadata.json` after excluding `source_metadata`.
- The `formula_path` exists in the tap checkout.
- Every listed link manifest exists and validates.

### `link-manifest.schema.json`

Purpose: tell host VFS tooling how to pour and link one verified bottle without
evaluating Formula Ruby.

Required fields:

```json
{
  "schema": 1,
  "package": "hello",
  "version": "2.12.1",
  "arch": "wasm32",
  "kandelo_abi": 15,
  "prefix": "/home/linuxbrew/.linuxbrew",
  "cellar": "/home/linuxbrew/.linuxbrew/Cellar",
  "keg": "/home/linuxbrew/.linuxbrew/Cellar/hello/2.12.1",
  "bottle": {
    "url": "https://example.invalid/hello.tar.gz",
    "sha256": "0000000000000000000000000000000000000000000000000000000000000000",
    "bytes": 1,
    "cache_key_sha": "0000000000000000000000000000000000000000000000000000000000000000",
    "payload_root": "hello/2.12.1"
  },
  "links": [],
  "receipts": [],
  "env": {}
}
```

Link entries:

```json
{
  "type": "symlink",
  "source": "Cellar/hello/2.12.1/bin/hello",
  "target": "bin/hello"
}
```

Initial supported `type` values:

- `symlink`, for ordinary Homebrew prefix links;
- `directory`, for required prefix directories that must exist before links;
- `file`, only when a future implementation needs an explicit copied file and
  the semantic validator can verify the source and destination mode.

Semantic validator checks:

- `prefix`, `cellar`, and `keg` are absolute guest paths under the supported
  Homebrew prefix.
- `keg` is under `cellar`.
- Every link `source` and `target` is relative, normalized, and cannot escape
  `prefix`.
- Link targets are unique within the manifest.
- Link sources exist in the bottle payload after pour.
- Receipts include the formula copy and `INSTALL_RECEIPT.json` for published
  images.
- No link overwrites a non-identical existing file in the planned image.
- The manifest ABI, arch, bottle sha, and cache key match the metadata entry
  that referenced it.

### `provenance.schema.json`

Purpose: durable evidence for one published bottle and sidecar generation.

Required groups:

- `subject`: package, version, arch, bottle rebuild, ABI.
- `repositories`: Kandelo repo/commit and tap repo/commit.
- `formula`: path and sha256.
- `bottle`: URL, sha256, bytes, bottle tag, cellar, prefix.
- `build`: GitHub Actions run URL, job name or ID, runner OS, Homebrew/brew
  version or commit, Kandelo dev-shell identity, SDK/sysroot fingerprints when
  available.
- `validation`: pass/fail/skip outcome lists for schema validation, formula
  audit, build, bottle generation, Node smoke, and browser smoke.
- `metadata`: sha256 values for generated sidecar files.

Semantic validator checks:

- Provenance bottle fields match `metadata.json`.
- Validation outcome lists are complete for the workflow stage being claimed.
- Browser success cannot be recorded unless the browser smoke artifact exists
  and `browser_compatible` is true.

## Example Data Rules

The example files should be deliberately small but structurally complete.
Use `hello` because it is the minimal milestone, but mark all URLs as
non-production placeholders under either `https://example.invalid/` or local
fixture paths. Use valid 64-character lowercase hex placeholders so JSON
Schema can test shape without special casing examples.

Examples should include:

- a successful `wasm32` bottle;
- a `wasm64` pending or absent entry, not a fake success;
- a link manifest with one `bin/hello` symlink and required receipts;
- a provenance report with Node smoke present and browser smoke skipped with a
  reason, unless the future implementation has real browser evidence.

## Alternatives Considered

### Create The Real Tap First

Rejected for this slice. The mayor direction is to keep schemas, validators,
and workflow generator work in the main Kandelo repo until the real tap is
needed. Main-repo review also lets implementation beads share tests before
cross-repo publish permissions are involved.

### Keep Using `Automattic/homebrew-kandelo`

Rejected by owner decision. The future repository is
`Automattic/kandelo-homebrew`. The scaffold should not preserve stale names
that later docs and workflows would have to migrate.

### Store Sidecars In Kandelo Package Source `index.toml`

Rejected. Kandelo package archives and Homebrew bottles serve different
consumers. The package resolver needs package archives with compatibility
metadata; Homebrew needs formula bottle blocks; VFS tooling needs sidecars that
describe bottle pour/link behavior.

### Evaluate Formula Ruby In The VFS Builder

Rejected. Host and browser consumers should not execute Formula Ruby to learn
install layout. The link manifest is the trusted, bounded contract for VFS
construction.

### JSON Schema Only

Rejected. JSON Schema cannot verify cross-file consistency, tarball contents,
Homebrew bottle blocks, cache-key equivalence, release ABI, or path collision
behavior. Keep JSON Schema for reviewable shape and add semantic validation in
`kd-8ho.2`.

### TOML Sidecars

Rejected for v1. JSON is easier for TypeScript host/browser tooling, GitHub
workflow scripts, and JSON Schema validation. Kandelo can keep `index.toml` for
package archives without forcing Homebrew sidecars to use TOML.

## Risks And Mitigations

| Risk | Mitigation |
|---|---|
| The selected repo name may confuse Homebrew short tap syntax. | Use exact `Automattic/kandelo-homebrew` metadata, verify install syntax before user docs, and prefer explicit URLs in automation where needed. |
| Homebrew cannot round-trip `wasm32_kandelo` or `wasm64_kandelo` yet. | Keep tag support blocking in `kd-8ho.4`; scaffold examples are non-published fixtures until that bead lands. |
| JSON Schema accepts unsafe link paths. | Encode basic path patterns in schema and enforce normalization, existence, collision, and escape checks in the semantic validator. |
| Sidecar metadata drifts from formula bottle blocks. | Generate both from the same bottle JSON and make semantic validation compare formula, sidecar, and bottle bytes before publish. |
| GitHub Packages permissions or visibility block first bottle hosting. | Keep the GitHub Releases fallback from the parent design as an explicit owner-approved fallback, and record URL storage type in metadata. |
| Browser compatibility is overclaimed. | Require `runtime_support` and `browser_compatible`; require browser smoke evidence before any published browser-compatible entry. |
| Last-green fallback hides stale ABI or cache-key drift. | Fallback fields are complete but still pass the same ABI, sha256, cache-key, and link-manifest checks as current success fields. |
| Future schema changes break already-published metadata. | Use integer `schema = 1`, reject unknown major schema versions, and treat additive optional fields as compatible only when consumers ignore them safely. |

## Implementation Sequence

1. Add this plan document and keep it docs-only.
2. Add `homebrew/kandelo-homebrew/README.md` explaining that the directory is a
   template for `Automattic/kandelo-homebrew`, not current user support.
3. Add `Formula/README.md` with placeholder guidance and no live formula.
4. Add `Kandelo/README.md` documenting live tap paths, release asset paths, and
   generated-file ownership.
5. Add the four JSON schemas using draft 2020-12 and strict
   `additionalProperties: false` on v1 objects.
6. Add the `hello` example files and ensure examples validate against the JSON
   schemas.
7. Record in `kd-8ho.1` that semantic cross-file/archive validation remains
   for `kd-8ho.2`.
8. Hand off to `kd-8ho.2` for `xtask` semantic validation and to `kd-8ho.3`,
   `kd-8ho.5`, and `kd-8ho.6` for workflow/formula/generation.

## Test Plan

For this docs-only design:

- `git diff --check`
- ASCII scan of this new plan

For the scaffold implementation:

- Validate every example JSON file against its matching schema.
- Validate `metadata.json` references to formula, link, and provenance example
  files.
- Add negative examples for bad ABI, bad arch/tag pairing, absolute link path,
  `..` path segment, duplicate target, malformed sha, and missing required
  fallback fields.
- Run targeted schema tests through the tool chosen by the implementation.
  If this lands in `xtask`, use `cargo test -p xtask homebrew`.
- Do not claim runtime, Homebrew publish, Node, browser, ABI, or package
  archive validation from schema tests alone.

For later implementation beads:

- VFS planner/builder changes need host tests and both Node/browser inspection.
- Browser-facing support requires `./run.sh browser` and Playwright smoke
  evidence.
- ABI-adjacent behavior requires `bash scripts/check-abi-version.sh`.
- Package archive behavior still uses the existing package-management and
  binary-release validation paths.

## Documentation Plan

This plan is historical design documentation only. The scaffold README files
should also say that no user-facing Homebrew support exists yet.

When implementation becomes user-facing, update:

- `docs/package-management.md` for the relationship between Homebrew bottles,
  `cache_key_sha`, and package archives;
- `docs/binary-releases.md` for why Homebrew bottles and Kandelo package
  archives use different release/storage contracts;
- `docs/package-sources.md` to state that Homebrew taps are a sibling
  publication model, not ordinary package sources;
- `docs/porting-guide.md` for formula authoring and build expectations;
- `docs/browser-support.md` only after browser-compatible Homebrew VFS images
  are validated;
- `README.md` only after a published, tested install path exists.

## Open Questions

1. What exact `brew tap` and `brew install` commands should public docs use for
   `Automattic/kandelo-homebrew`?
2. Should `tap_name` mirror the repository name exactly, or should it preserve a
   future Homebrew alias if Homebrew creates one?
3. Should formula sidecars duplicate the full package entry or store only a
   pointer plus bottle entries? Duplication is easier for consumers but creates
   consistency checks.
4. Which tool should run JSON Schema validation in CI: Rust `jsonschema` inside
   `xtask`, Node tooling, or both?
5. Should v1 allow future ABI-bearing bottle tags, or should those require
   schema v2 after `kd-8ho.4` proves they round-trip?
6. Are GitHub artifact attestations required before third-party taps can be
   consumed by host VFS builders?
7. What CORS and access-control behavior will GitHub Packages expose for
   browser-side direct bottle fetches, and should browser support avoid direct
   bottle fetches entirely in v1?

## Sources

- Prior Kandelo design:
  `docs/plans/2026-06-25-homebrew-ci-github-packages-bottle-publishing-design.md`
  from commit `9c7fbf5cc`.
- Kandelo guidance: `CLAUDE.md`,
  `docs/agent-guidance/packages-and-builds.md`,
  `docs/agent-guidance/build-docs-and-prs.md`,
  `docs/agent-guidance/validation.md`.
- Kandelo reference docs: `docs/package-management.md`,
  `docs/binary-releases.md`, `docs/package-sources.md`,
  `docs/browser-support.md`.
- Homebrew Bottles documentation:
  https://docs.brew.sh/Bottles
- Homebrew tap documentation:
  https://docs.brew.sh/How-to-Create-and-Maintain-a-Tap
- GitHub Packages permissions documentation:
  https://docs.github.com/en/packages/learn-github-packages/about-permissions-for-github-packages
- GitHub Actions `GITHUB_TOKEN` documentation:
  https://docs.github.com/en/actions/tutorials/authenticate-with-github_token
