# Binary releases

Prebuilt Wasm binaries — the kernel, user programs, and VFS images —
live in GitHub Releases rather than the Git repo. This keeps the repo
small and makes rebuilds optional for contributors: fetch once, use
everywhere.

This document describes the format and conventions. The release
workflow itself is intentionally manual at first and will be
automated by a GitHub Actions workflow in a follow-up change.

## Release tag convention

```
binaries-abi-v<ABI_VERSION>-<YYYY>-<MM>-<DD>
```

Example: `binaries-abi-v2-2026-04-19`.

Tags are **immutable snapshots**. A new release cut on a later date
gets a new tag — we do not rewrite assets on an existing release.
This means:

- `binaries.lock` (the per-repo pin) always references a specific
  immutable tag. Consumers get byte-identical binaries regardless of
  when they fetch.
- The releases page is a visible history of what shipped when.
- If we rebuild the set, we cut a new release; old releases remain
  valid for anyone pinned to them.

The ABI version appears in the tag name because a release is tied to
a specific kernel ABI. Programs from `binaries-abi-v2-*` cannot run
against a kernel on ABI 3 — the mismatch check refuses them.

## Layout of a release

Flat asset namespace. No per-category directories.

```
binaries-abi-v2-2026-04-19 (release)
├── manifest.json                     ← the contract
├── wasm_posix_kernel.wasm
├── wasm_posix_userspace.wasm
├── exec-caller.wasm
├── exec-child.wasm
├── fork-exec.wasm
├── ...
└── vim.wasm                          ← "large real-world" sample
```

## `manifest.json` schema

```json
{
  "abi_version": 2,
  "release_tag": "binaries-abi-v2-2026-04-19",
  "generated_at": "2026-04-19T21:30:00Z",
  "generator": "cargo xtask build-manifest",
  "entries": [
    {
      "name": "wasm_posix_kernel.wasm",
      "kind": "kernel",
      "size": 407264,
      "sha256": "<hex>",
      "abi_version": 2
    },
    {
      "name": "exec-caller.wasm",
      "kind": "program",
      "size": 25075,
      "sha256": "<hex>",
      "abi_version": 2
    }
  ]
}
```

Entries are sorted alphabetically by `name`. Keys within each entry
and at the top level are sorted too (BTreeMap on the generator side)
so `shasum -a 256 manifest.json` is deterministic.

### Top-level fields

- **`abi_version`** — duplicated from the tag name, for cross-check.
  A fetcher that finds `abi_version` disagreeing with the tag must
  fail loudly; the version is load-bearing and drift between
  representation and tag is a bug.
- **`release_tag`** — the GitHub release tag the manifest came from.
- **`generated_at`** — ISO 8601 UTC timestamp, for provenance only.
  Not used for any correctness check; two runs of
  `build-manifest` produce different `generated_at` values.
- **`generator`** — tool+version that produced the manifest, for
  debugging mysterious format drift.
- **`entries`** — flat array, sorted by `name`.

### Per-entry fields

- **`name`** — the asset filename in the release. Unique.
- **`kind`** — one of `"kernel"`, `"userspace"`, `"program"`,
  `"vfs-image"`. Auto-detected from the filename and contents by the
  generator.
- **`size`** — byte count.
- **`sha256`** — lowercase hex SHA-256 of the asset bytes. Fetcher
  verifies every download.
- **`abi_version`** — for wasm binaries that export `__abi_version`,
  the integer value the export returns. Null for assets that don't
  carry the marker (VFS images, legacy binaries).

## How a fetcher validates a release

The follow-up `scripts/fetch-binaries.sh` will:

1. Read `binaries.lock` (`{abi, release_tag, manifest_sha256}`).
2. Fetch `manifest.json` from the release; verify its SHA-256 matches
   `binaries.lock`'s `manifest_sha256`.
3. Cross-check `manifest.abi_version === binaries.lock.abi` and
   `manifest.release_tag === binaries.lock.release_tag`.
4. For each entry, check the content-addressed cache at
   `~/.cache/wasm-posix-kernel/abi-v<N>/objects/<sha256>.wasm`.
   Missing objects are downloaded from the release and verified.
5. Symlink the cached objects into the worktree's `binaries/` dir.

Any SHA-256 mismatch, version mismatch, or missing manifest is a hard
error; we never fall back to "best effort."

## Producing a release

For now, manual. Eventually a GitHub Actions workflow
(`release-binaries.yml`) will automate every step.

1. Build all binaries fresh against the current `ABI_VERSION`
   (kernel via `bash build.sh`, programs via
   `scripts/build-programs.sh`, ported software via each
   `examples/libs/*/build-*.sh`).
2. Stage them into a flat `release-staging/` directory.
3. Run `cargo xtask build-manifest --in release-staging --out
   release-staging/manifest.json --tag
   binaries-abi-v<N>-<DATE>` to generate the manifest.
4. Run `bash scripts/publish-release.sh <DATE>` (or equivalent) to
   create the GitHub release and upload every staged asset.
5. Commit the generated manifest into `abi/manifest.json` as the
   repo's reference copy. Follow-up changes to `binaries.lock` pin
   consumers to this release.

See `scripts/publish-release.sh` for the current script.
