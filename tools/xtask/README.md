# xtask

Repo-local build and artifact utilities. Prefer `./run.sh` for ordinary builds;
it routes work through these commands. Key subcommands:

- `bootstrap` — provision SDK prerequisites and build the supported graph,
  rootfs, and host (`./run.sh setup`).
- `local-build` — plan or run the content-addressed package/VFS-product graph.
- `clean`, `cache-gc`, `verify-fresh` — remove selected build outputs, collect
  unused cache generations, or check artifact freshness.
- `vfs` — inspect the canonical VFS product catalog and consumer selections.
- `dump-abi` — regenerate `abi/snapshot.json` from authoritative sources.
- `check-package-imports [--require-startup] <wasm>...` — audit process
  imports against shared host declarations and the current SDK's typed
  libc/startup imports. The startup option requires memory and syscall
  channel imports for executable smoke links.
- `build-deps toolchain-inputs` — print the authoritative compiled-package
  toolchain input list as JSON, including shared source and audit helpers.
- `bundle-program` — zip-bundle one program's binary + runtime + LICENSE.
- `build-deps` — package dependency resolver: local overrides, cache, then
  source builds (see [Package Management](../../docs/package-management.md)).
- `archive-extract-member` — stream one exact regular member from a package
  `.tar.zst` archive into a new file, publishing it only after the complete
  archive has validated.
- `compute-cache-key-sha` — print one package's cache-key sha to stdout.
- `set-build-commit` — stamp `[build].commit` in a `package.toml`.
- `stamp-abi-contract` — stamp locally built programs with the current ABI
  contract digest; refuses an existing mismatched stamp.

## Always build/test xtask with `--target <host>`

The workspace `.cargo/config.toml` sets the default build target to
`wasm32-unknown-unknown` (for the kernel). xtask is a **host-only** tool:
it pulls in `ureq` with TLS, which transitively depends on `ring`, whose
C build does not support wasm targets.

Run from the repository root inside `scripts/dev-shell.sh bash`, and always
pass an explicit host target:

```bash
# macOS Apple silicon
cargo test  -p xtask --target aarch64-apple-darwin
cargo build -p xtask --target aarch64-apple-darwin

# macOS Intel
cargo test  -p xtask --target x86_64-apple-darwin

# Linux
cargo test  -p xtask --target x86_64-unknown-linux-gnu
```

For a portable invocation:

```bash
host_target="$(rustc -vV | awk '/^host/ {print $2}')"
cargo test -p xtask --target "$host_target"
```

The explicit host target overrides the workspace's Wasm default for this
invocation. Use the same host target when running xtask through `cargo run`.
