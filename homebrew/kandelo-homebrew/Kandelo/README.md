# Kandelo Sidecar Metadata

Trusted publish workflows generate this directory in the
`Automattic/kandelo-homebrew` tap. Checked-in files make metadata reviewable in
the tap commit, and the same payload should be uploaded to a tap release named
`bottles-abi-v<N>` for stable automation fetches.

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
cargo xtask homebrew-sidecars \
  --tap-root /path/to/kandelo-homebrew \
  --input /path/to/sidecars-input.json \
  --previous-metadata /path/to/previous/Kandelo/metadata.json
```

The input manifest is workflow evidence: tap and Kandelo commits, ABI release
tag, formula identities, bottle status, link-plan data, build evidence,
validation outcome lists, and local `bottle_file` paths. The generator hashes
the local bottle files itself and writes the resulting `sha256` and `bytes`
into metadata, formula sidecars, link manifests, and provenance reports.

When a current bottle is `failed`, `pending`, or `building`,
`--previous-metadata` provides the last-green fallback. The fallback is copied
only for the same ABI, package, version, rebuild, and arch.

## Maintenance Workflows

The reusable maintenance workflow supports three operator paths:

- `rebuild` builds and uploads replacement bottles, then publishes generated
  sidecars through the same validator and tap commit path as normal publish.
  When expected cache keys are supplied, formula/arch pairs whose current
  successful metadata already matches are skipped unless `force` is set.
- `repair-only` skips bottle build and upload. The trusted sidecar command gets
  `KANDELO_HOMEBREW_REPAIR_ONLY=true` and
  `KANDELO_HOMEBREW_PREVIOUS_METADATA` so it can regenerate sidecars from
  existing bottle evidence without changing bottle bytes.
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

- metadata ABI matches the `bottles-abi-v<N>` release;
- formula sidecars match their package entry in `metadata.json`;
- bottle `arch` and `bottle_tag` agree;
- `runtime_support` and `runtime_status` agree for Node and browser runtime
  claims;
- browser-compatible entries have browser validation evidence;
- link-manifest paths do not escape the Homebrew prefix;
- link sources exist inside the verified bottle payload;
- bottle sha256, cache key, metadata sha, and provenance fields agree;
- fallback link manifests still exist for non-success bottles.

Run the repo-local validator against a generated tap checkout:

```bash
cargo xtask homebrew-validate --tap-root /path/to/kandelo-homebrew
```

The validator checks the current sidecar JSON, link-manifest consistency,
provenance reports, and fallback link references. It does not fetch bottle
bytes or evaluate Formula Ruby.

## VFS Planning

Host VFS tooling plans a Homebrew-prefix image with
`planHomebrewVfs(metadata, options)` from the host package. The planner is
shared by Node and browser callers. It consumes parsed `Kandelo/metadata.json`
and a caller-provided link-manifest loader, resolves requested packages plus
their dependency closure in dependency-first order, and rejects bad ABI,
unsupported arch, cache-key drift, missing packages, dependency cycles, unsafe
paths, and link-manifest bottle URL/sha/byte/cache-key drift before any bottle
bytes are extracted.

For `failed`, `pending`, or `building` bottle entries, the planner uses the
complete last-green fallback fields when available. Without a complete fallback,
the package is not plannable for a VFS image.

`runtime_support` is a VFS runtime allow-list, not a bottle build result. A
successful bottle may set `runtime_support = []` when `runtime_status.node` and
`runtime_status.browser` explain why it is intentionally unsupported. The
planner rejects an unsupported requested runtime before loading link manifests
or bottle bytes and exposes the sidecar reason to Node and browser callers.

## VFS Image Building

Build a precomposed Homebrew-prefix image from generated sidecars and verified
bottle bytes with:

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

The builder consumes only `metadata.json`, link manifests, and bottle tarballs.
It does not evaluate Formula Ruby. It verifies the selected bottle byte count
and sha256, rejects unsafe or unsupported tar entries, stages files under the
declared keg, validates receipts, applies the link manifest under the declared
prefix, writes `/etc/kandelo/homebrew-vfs.json`, saves a `.vfs.zst`, and emits a
JSON report beside the image.

Link and receipt paths starting with `Cellar/` are interpreted relative to the
Homebrew prefix. Other link and receipt paths are interpreted relative to the
staged keg. Bottle payload entries under `bottle.payload_root` map to the keg;
fixture entries that are already `Cellar/...` map to the prefix. This keeps the
checked-in example shape and generated sidecar fixture shape unambiguous.

The report records whether each package used a current `success` bottle or a
last-green `fallback`. A successful report is build evidence for the precomposed
image only; Node and browser runtime support still require their own smoke
tests before publishing gallery or user-facing claims.

## Browser Gallery Assets

The trusted publisher may expose a Homebrew-built image to the browser gallery
only after the wasm32 bottle has browser validation evidence. For `hello`, the
workflow builds the VFS image, serves it from the browser demo, boots it with
Playwright Chromium, and runs:

```bash
/home/linuxbrew/.linuxbrew/bin/hello --version
```

On success, sidecars record `runtime_support = ["node", "browser"]` and
`browser_compatible = true`; otherwise the browser host stays out of
`runtime_support`, or both hosts stay out when `runtime_status` marks the
bottle intentionally unsupported. Gallery assets are generated with:

```bash
scripts/homebrew-create-browser-gallery.sh \
  --metadata /path/to/kandelo-homebrew/Kandelo/metadata.json \
  --image target/homebrew-hello.vfs.zst \
  --report target/homebrew-hello.vfs-report.json \
  --out target/homebrew-gallery \
  --formula hello
```

The script writes `gallery.json`, `index.toml`, and a `.tar.zst` archive whose
payload is the browser-smoked VFS image. It refuses metadata where the wasm32
bottle is not `status = "success"` and `browser_compatible = true`.

`provenance_json.sha256` is a normalized self-hash: compute the sha256 of the
pretty-printed provenance document after replacing
`/metadata/provenance_json/sha256` with 64 zeroes. The generator and validator
both use that convention so provenance can name and hash itself without an
impossible recursive digest.
