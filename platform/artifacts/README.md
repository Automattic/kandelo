# Platform Artifacts

`kernel`, `userspace`, and `kandelo-sdk` are Kandelo runtime platform
artifacts, not Homebrew package identities. Their durable owner is
`platform/artifacts/manifest.json`; bridge files under
`packages/registry/{kernel,userspace,kandelo-sdk}/` remain only for
transitional resolver compatibility.

Use the xtask owner command for validation and local materialization:

```bash
cargo run -p xtask --target "$(rustc -vV | awk '/^host/ {print $2}')" -- \
  platform-artifacts validate --registry-removal

cargo run -p xtask --target "$(rustc -vV | awk '/^host/ {print $2}')" -- \
  platform-artifacts materialize --binaries-dir binaries
```

The validator enforces:

- exactly one owner entry for each required artifact: `kernel`,
  `userspace`, and `kandelo-sdk`;
- ABI equality with `crates/shared/src/lib.rs`'s `ABI_VERSION`;
- safe repository-relative inputs, build scripts, source paths, and runtime
  paths;
- status, fallback, provenance, and smoke evidence fields;
- `--registry-removal` readiness, which rejects owner records that still point
  their build scripts at `packages/registry/<artifact>/`.

The materializer keeps the existing runtime lookup paths stable:

- `binaries/kernel.wasm`
- `binaries/userspace.wasm`
- `binaries/programs/wasm32/kandelo-sdk.vfs.zst`

It first uses existing local outputs, then fetches the manifest's release
archive, verifies the archive SHA-256, and extracts the explicit
`archive_paths`. If no local or archive source is available, it runs the
platform build script when source fallback is allowed. `--fetch-only` refuses
source builds and fails if the artifact is not already present or fetchable.
