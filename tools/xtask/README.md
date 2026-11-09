# xtask

Repo-local build and artifact utilities. Prefer `./run.sh` for ordinary builds;
it routes work through these commands. Key subcommands:

- `bootstrap` — provision SDK prerequisites and build the browser/image
  dependencies, rootfs, and host (`./run.sh setup`); `setup --all` also
  builds test-only supported packages.
- `local-build` — plan or run the content-addressed package/VFS-product graph.
- `clean`, `cache-gc`, `verify-fresh` — remove selected build outputs, collect
  unused cache generations, or check artifact freshness.
- `vfs` — inspect the canonical VFS product catalog and consumer selections.
- `test-failures <conformance|vitest|playwright> <report> <context.json>`
  — import failures and anomalies as JSON. See [failure evidence](../../tests/baselines/README.md).
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

Cargo's `forced-target` would in theory pin a single package's target
without callers having to remember `--target`. It is gated on the
nightly-only `per-package-target` feature, and currently panics inside
the cargo resolver on our toolchain (`cargo 1.91.0-nightly`). Until it
stabilises, the explicit `--target` flag is the supported path.

### Optional node disk reserve

Set `KANDELO_LOCAL_BUILD_MIN_FREE_BYTES` to a positive decimal byte count to
refuse new local-build node children when `statvfs` reports less available
space on the checkout, source-cache or output filesystem. Unset preserves
ordinary behavior and performs no disk-space queries. Invalid values fail
before aggregate preparation; filesystem-query errors fail admission loudly.
Cached nodes that require no child remain eligible.

Set the variable inside the canonical development shell; an outer export is
not retained by its curated environment:

```bash
scripts/dev-shell.sh env KANDELO_LOCAL_BUILD_MIN_FREE_BYTES=17179869184 \
  bash scripts/setup.sh --all-packages --jobs 1
```

The example chooses a 16 GiB admission floor, not a universal build-space
requirement. Choose the floor and initial headroom for the selected workload.

This checks admission, not peak space or reserved capacity: an admitted node,
bootstrap/aggregate preparation outside the node scheduler, temporary files on
other filesystems, or unrelated processes may consume additional space. Use
`--jobs 1` when a single admitted node at a time is intended. A refusal fails
that node and blocks its dependents through the ordinary scheduler; already
running nodes finish normally. No automatic retry or waiting is added.
