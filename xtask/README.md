# xtask

Repo-local build/release utilities. Subcommands:

- `dump-abi` — regenerate `abi/snapshot.json` from authoritative sources.
- `build-manifest` — generate a binary-release `manifest.json` from a staging dir.
- `bundle-program` — zip-bundle one program's binary + runtime + LICENSE.
- `build-deps` — wasm library dep-graph resolver
  (see [`docs/dependency-management.md`](../docs/dependency-management.md)).

## Always build/test xtask with `--target <host>`

The workspace `.cargo/config.toml` sets the default build target to
`wasm64-unknown-unknown` (for the kernel). xtask is a **host-only** tool:
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

### Why not `forced-target` in `Cargo.toml`?

Cargo's `forced-target` would in theory pin a single package's target
without callers having to remember `--target`. It is gated on the
nightly-only `per-package-target` feature, and currently panics inside
the cargo resolver on our toolchain (`cargo 1.91.0-nightly`). Until it
stabilises, the explicit `--target` flag is the supported path.
