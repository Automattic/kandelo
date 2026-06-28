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

## Homebrew metadata validation

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
`metadata.json`, formula sidecars, and link manifests. It does not fetch bottle
bytes or evaluate Formula Ruby.

## Homebrew trusted bottle workflow

The reusable workflow
`.github/workflows/reusable-homebrew-bottle-publish.yml` is the trusted CI
entry point for the future `Automattic/kandelo-homebrew` tap. It accepts a
selected formula/arch matrix, builds bottles via `scripts/dev-shell.sh`, uploads
bottle bytes to GHCR, and commits generated `Kandelo/` sidecars back to the tap.
Failures are recorded as attempt reports without replacing last-green
`Kandelo/metadata.json`.

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
