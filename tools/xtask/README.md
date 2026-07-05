# xtask

Repo-local build/release utilities. Subcommands:

- `dump-abi` — regenerate `abi/snapshot.json` from authoritative sources.
- `bundle-program` — zip-bundle one program's binary + runtime + LICENSE.
- `build-deps` — wasm library dep-graph resolver
  (see [`docs/dependency-management.md`](../docs/dependency-management.md)).
- `archive-stage` — produce one package's `.tar.zst` archive
  (single `(package, arch)` slice; no registry walk).
- `build-index` — emit `index.toml` provenance manifest from
  a directory of staged `.tar.zst` archives.
- `compute-cache-key-sha` — print one package's cache-key sha to stdout.
- `set-build-commit` — stamp `[build].commit` in a `package.toml`.
- `set-package-binary` — update `[binary.<arch>]` in a `package.toml`.
- `homebrew-sidecars` — generate Kandelo/Homebrew sidecars from bottle bytes.
- `homebrew-validate` — validate Kandelo/Homebrew tap sidecar metadata.

## Always build/test xtask with `--target <host>`

The workspace `.cargo/config.toml` sets the default build target to
`wasm32-unknown-unknown` (for the kernel). xtask is a **host-only** tool:
it pulls in `ureq` with TLS, which transitively depends on `ring`, whose
C build does not support wasm targets.

Always pass an explicit host target:

```bash
# macOS Apple silicon
cargo test  -p xtask --target aarch64-apple-darwin
cargo build -p xtask --target aarch64-apple-darwin

# macOS Intel
cargo test  -p xtask --target x86_64-apple-darwin

# Linux
cargo test  -p xtask --target x86_64-unknown-linux-gnu
```

Discover your host triple with `rustc -vV | awk '/host/ {print $2}'`.

## Homebrew metadata generation and validation

Generate sidecars for a tap checkout from a workflow-produced manifest:

```bash
cargo xtask homebrew-sidecars \
  --tap-root /path/to/kandelo-homebrew \
  --input /path/to/sidecars-input.json \
  --previous-metadata /path/to/previous/Kandelo/metadata.json
```

`bottle_file` paths in the input manifest are resolved relative to the input
manifest. The generator reads those produced bottle bytes directly, computes
`sha256` and `bytes`, writes `Kandelo/metadata.json`,
`Kandelo/formula/<name>.json`, `Kandelo/link/...json`, and
`Kandelo/reports/...provenance.json`, and copies last-green fallback fields
from `--previous-metadata` when a current bottle is `failed`, `pending`, or
`building`.

Validate the generated Kandelo sidecar metadata in a Homebrew tap checkout:

```bash
cargo xtask homebrew-validate --tap-root /path/to/kandelo-homebrew
```

For a nonstandard metadata location, pass `--metadata` as either an absolute
path or a tap-root-relative path:

```bash
cargo xtask homebrew-validate \
  --tap-root /path/to/kandelo-homebrew \
  --metadata Kandelo/metadata.json
```

The validator checks JSON Schema shape and semantic consistency between
`metadata.json`, formula sidecars, link manifests, provenance reports, and
last-green fallback links. It does not fetch bottle bytes or evaluate Formula
Ruby.

## Homebrew trusted bottle workflow

The reusable workflow
`.github/workflows/reusable-homebrew-bottle-publish.yml` is the trusted CI
entry point for the future `Automattic/kandelo-homebrew` tap. It accepts a
selected formula/arch matrix, builds bottles via `scripts/dev-shell.sh`, uploads
bottle bytes to GHCR, and commits generated `Kandelo/` sidecars back to the tap.
Failures are recorded as attempt reports without replacing last-green
`Kandelo/metadata.json`.

The maintenance entry point is
`.github/workflows/reusable-homebrew-bottle-maintenance.yml`. It delegates
manual rebuild and repair-only work to the publish workflow, using
`scripts/homebrew-plan-matrix.sh` to skip unchanged expected cache keys unless
`force` is set. Rollback mode records a rollback report through
`scripts/homebrew-publish-sidecars.sh --status rollback` and preserves
last-green metadata by default. Package deletion is exceptional; when it
happens, the rollback report must name the deleted package URL and reason.

Sidecar generation is intentionally a command handoff so the generator can
evolve with the bottle/link/provenance contract:

```bash
KANDELO_HOMEBREW_SIDECAR_ROOT=/tmp/sidecars \
KANDELO_HOMEBREW_TAP_ROOT=/tmp/kandelo-homebrew \
cargo xtask homebrew-validate --tap-root /tmp/kandelo-homebrew
```

### Why not `forced-target` in `Cargo.toml`?

Cargo's `forced-target` would in theory pin a single package's target
without callers having to remember `--target`. It is gated on the
nightly-only `per-package-target` feature, and currently panics inside
the cargo resolver on our toolchain (`cargo 1.91.0-nightly`). Until it
stabilises, the explicit `--target` flag is the supported path.
