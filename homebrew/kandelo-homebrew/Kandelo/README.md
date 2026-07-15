# Kandelo Sidecar Metadata

Trusted publish workflows generate this directory in the
`Automattic/kandelo-homebrew` tap. Checked-in files make metadata reviewable in
the tap commit. `bottles-abi-v<N>` is the sidecar ABI namespace; the
current workflow does not duplicate this payload into a GitHub Release.

## Files

```text
metadata.schema.json
formula.schema.json
link-manifest.schema.json
provenance.schema.json

metadata.json                                      # generated tap state
formula/<name>.json                               # generated tap state
link/<name>-<version>-rebuild<N>-<arch>.json      # generated tap state
reports/<name>-<version>-rebuild<N>-<arch>.provenance.json
```

The `examples/` directory contains fixture data for schema and semantic
validator development. It is not published metadata.

## Generation

The publish workflow generates this directory with:

```bash
scripts/dev-shell.sh cargo xtask homebrew-sidecars \
  --tap-root /path/to/kandelo-homebrew \
  --input /path/to/sidecars-input.json \
  --previous-metadata /path/to/previous/Kandelo/metadata.json
```

The input manifest is workflow evidence: tap and Kandelo commits, ABI release
tag, formula identities, bottle status, link-plan data, build evidence,
validation outcome lists, and local `bottle_file` paths. The generator hashes
the local bottle files itself and writes the resulting `sha256` and `bytes`
into metadata, formula sidecars, link manifests, and provenance reports.

The publisher carries this evidence across fresh jobs only in strict data
handoffs. Artifact-provided scripts and environment files are rejected. The
trusted in-tree generator creates sidecars on a read-only verification runner,
and a separate tap finalizer validates the complete publication payload as
inert data before acquiring push credentials.

When a current bottle is `failed`, `pending`, or `building`,
`--previous-metadata` provides the last-green fallback. The fallback is copied
only for the same ABI, package, version, rebuild, and arch.

## Maintenance Workflows

The reusable maintenance workflow supports two operator paths:

- `rebuild` builds and uploads replacement bottles, then publishes generated
  sidecars through the same validator and tap commit path as normal publish.
  When expected cache keys are supplied, formula/arch pairs whose current
  successful metadata already matches are skipped unless `force` is set.
- `rollback` records the rollback under `Kandelo/reports/rollbacks/` without
  replacing `Kandelo/metadata.json`. If a rollback publishes a non-success
  metadata payload, it must preserve the previous successful bottle as
  last-green fallback metadata.

Package deletion is not normal rollback. Delete a GHCR/Homebrew package object
only for legal, security, or retention emergencies, and record the deleted URL
plus the reason in the rollback report.

## Validation Split

JSON Schema validates object shape, required fields, enum values, scalar
formats, and basic path syntax.

The semantic validator must still check cross-file and artifact facts:

- metadata ABI matches the `bottles-abi-v<N>` namespace;
- formula sidecars match their package entry in `metadata.json`;
- bottle `arch` and `bottle_tag` agree;
- Formula bottle root, tags, and SHA-256 digests exactly match the tap and the
  successful or last-green fallback bottles in sidecar metadata;
- browser-compatible entries have browser validation evidence;
- link-manifest paths do not escape the Homebrew prefix;
- link sources exist inside the verified bottle payload;
- bottle sha256, cache key, metadata sha, and provenance fields agree;
- fallback link manifests still exist for non-success bottles.

Run the repo-local validator against a generated tap checkout:

```bash
scripts/dev-shell.sh cargo xtask homebrew-validate \
  --tap-root /path/to/kandelo-homebrew
```

The validator checks the current sidecar JSON, Ripper-parsed static Formula
bottle structure and data, link-manifest consistency, provenance reports, and
fallback link references. It does not fetch bottle bytes or evaluate Formula
Ruby.

## VFS Planning

Host VFS tooling plans a Homebrew-prefix image with
`planHomebrewVfs(metadata, options)` from the host package. The planner is
shared by Node and browser callers. It consumes parsed `Kandelo/metadata.json`
and a caller-provided link-manifest loader, resolves requested packages plus
their dependency closure in dependency-first order, and rejects bad ABI,
unsupported arch, tap-identity drift, duplicate roots or metadata, cache-key
drift, missing packages, dependency cycles, unsafe paths, and link-manifest
bottle URL/sha/byte/cache-key drift before any bottle bytes are extracted.

For `failed`, `pending`, or `building` bottle entries, the planner uses the
complete last-green fallback fields when available. Without a complete fallback,
the package is not plannable for a VFS image.

## VFS Image Building

Write a static Brewfile that names one tap and the formula roots for the image:

```ruby
tap "automattic/kandelo-homebrew"
brew "sqlite"
brew "automattic/kandelo-homebrew/xz"
```

Then build a precomposed Homebrew-prefix image from generated sidecars and
verified bottle bytes with:

```bash
scripts/dev-shell.sh npx tsx images/vfs/scripts/build-homebrew-vfs-image.ts \
  --metadata /path/to/kandelo-homebrew/Kandelo/metadata.json \
  --tap-root /path/to/kandelo-homebrew \
  --brewfile /path/to/Brewfile \
  --arch wasm32 \
  --runtime node \
  --base-image target/platform-base.vfs.zst \
  --out target/homebrew-hello.vfs.zst \
  --report target/homebrew-hello.vfs-report.json
```

This is a deliberately small, non-executing Brewfile subset: blank lines,
comments, exactly one literal lowercase `tap "owner/tap"`, and 1 to 128 literal
`brew` entries. A formula may be bare or fully qualified under that exact tap;
duplicates after normalization are rejected. Ripper validates the syntax tree,
and the builder never evaluates the file. Options, interpolation, conditionals,
variables, nested Ruby, other entry types, and multi-tap selection are rejected.
Use real Homebrew inside a running Kandelo guest when full Homebrew Bundle DSL
behavior is required.

Homebrew Bundle does not define a `Brewfile.lock.json` contract. The report and
image manifest instead bind the Brewfile SHA-256 and byte count, ordered roots,
tap commit, base image, and exact bottle digests. The root digest is SHA-256 over
the UTF-8 JSON array of normalized roots in declared order. Repeatable
`--package <name>` is still available to lower-level callers, but it cannot be
combined with `--brewfile`.

The builder consumes only `metadata.json`, link manifests, and bottle tarballs.
It does not evaluate Formula Ruby. It verifies the selected bottle byte count
and sha256, rejects unsafe or unsupported tar entries, stages files under the
declared keg, validates receipts, applies the link manifest under the declared
prefix, writes `/etc/kandelo/homebrew-vfs.json`, saves a `.vfs.zst`, and emits a
JSON report beside the image.

`--base-image` is optional and accepts only an ABI-matched platform image that
does not already contain a Homebrew composition. Output image metadata records
a bounded binding with the base SHA-256, byte count, and declared ABI; the JSON
report also retains the full source metadata for auditing. Omit `--max-bytes`
to retain the base filesystem maximum without rebuilding existing inodes, or
set it to rebase the filesystem to an exact, 4096-byte-aligned new maximum
before bottles are staged.

Link and receipt paths starting with `Cellar/` are interpreted relative to the
Homebrew prefix. Other link and receipt paths are interpreted relative to the
staged keg. Bottle payload entries under `bottle.payload_root` map to the keg;
fixture entries that are already `Cellar/...` map to the prefix. This keeps the
checked-in example shape and generated sidecar fixture shape unambiguous.

The report records whether each package used a current `success` bottle or a
last-green `fallback`. A successful report is build evidence for the precomposed
image only; Node and browser runtime support still require their own smoke
tests before publishing gallery or user-facing claims.

In publisher validation, the package payload is the current Homebrew bottle:
the local bottle for a dry run, or the exact anonymously read-back GHCR digest
for a write run. Kandelo's complete ABI release graph is fetched separately as
the kernel, host-runtime, and VFS platform prerequisite; it is not the source of
the migrated package payload.

## Browser Gallery Assets

The trusted publisher may expose a Homebrew-built image to the browser gallery
only after the wasm32 bottle has browser validation evidence. For `hello`, the
workflow builds the VFS image, serves it from the browser demo, boots it with
Playwright Chromium, and runs:

```bash
/home/linuxbrew/.linuxbrew/bin/hello --version
```

On success, sidecars record `runtime_support = ["node", "browser"]` and
`browser_compatible = true`; otherwise the bottle remains Node-only. Gallery
assets are generated with:

```bash
scripts/dev-shell.sh bash scripts/homebrew-create-browser-gallery.sh \
  --metadata /path/to/kandelo-homebrew/Kandelo/metadata.json \
  --image target/homebrew-hello.vfs.zst \
  --report target/homebrew-hello.vfs-report.json \
  --out target/homebrew-gallery \
  --formula hello
```

The script writes `gallery.json`, `index.toml`, and a `.tar.zst` archive whose
payload is the browser-smoked VFS image. It refuses metadata where the wasm32
bottle is not `status = "success"` and `browser_compatible = true`. The trusted
publisher retains these files as run-scoped diagnostics; durable gallery
release publication requires a separate immutable asset contract.

`provenance_json.sha256` is a normalized self-hash: compute the sha256 of the
pretty-printed provenance document after replacing
`/metadata/provenance_json/sha256` with 64 zeroes. The generator and validator
both use that convention so provenance can name and hash itself without an
impossible recursive digest.
