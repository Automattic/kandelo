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

Flat asset namespace. No per-category directories. legacy wasm/zip
entries (kernel, userspace, vfs-images, legacy programs) and
the system `.tar.zst` entries (libraries + the archive-shaped programs) sit
side-by-side in the same release; the manifest entry's
`archive_name` field is the per-entry discriminator.

```
binaries-abi-v4-2026-04-26 (release)
├── manifest.json                                     ← the contract
├── wasm_posix_kernel.wasm                            ← legacy (kernel)
├── wasm_posix_userspace.wasm                         ← legacy (userspace)
├── exec-caller.wasm                                  ← legacy (program)
├── fork-exec.wasm                                    ← legacy (program)
├── shell.vfs.zst                                     ← legacy (vfs-image)
├── zlib-1.3.1-rev1-wasm32-9acb9405.tar.zst           ← the system (library)
├── zlib-1.3.1-rev1-wasm64-b1773def.tar.zst           ← the system (library)
├── ncurses-6.5-rev1-wasm32-2a55c8e0.tar.zst          ← the system (library)
├── vim-9.1-rev1-wasm32-c4e2118a.tar.zst              ← the system (program)
└── …
```

the system archive filenames follow
`<name>-<version>-rev<N>-<arch>-<short-cache-key-sha>.tar.zst`,
where the short sha is the first 8 chars of the cache-key sha
for that manifest. Two archives with the same `(name, version,
revision, arch)` but different transitive deps get distinct
shas and thus distinct names.

### the system archive interior layout

Each `.tar.zst` carries exactly two top-level entries:

```
manifest.toml              ← source deps.toml + injected [compatibility]
artifacts/                 ← cache-tree contents
    lib/libz.a
    include/zlib.h
    include/zconf.h
    lib/pkgconfig/zlib.pc
```

The consumer (`xtask install-release`, calling
`remote_fetch::fetch_and_install`) flattens `artifacts/*` to
the cache root after extraction. See
`docs/package-management.md` "Release archives" for the full
producer/consumer round-trip and the `[compatibility]` block.

## `manifest.json` schema

The full machine-readable schema lives at
[`abi/manifest.schema.json`](../abi/manifest.schema.json) and is
exercised by `xtask`'s test suite. The prose below tracks the
fields a reader most often needs.

```json
{
  "abi_version": 4,
  "release_tag": "binaries-abi-v4-2026-04-26",
  "generated_at": "2026-04-26T10:00:00Z",
  "generator": "cargo xtask build-manifest",
  "entries": [
    {
      "name": "wasm_posix_kernel.wasm",
      "kind": "kernel",
      "size": 407264,
      "sha256": "<hex>",
      "abi_version": 4
    },
    {
      "name": "exec-caller.wasm",
      "kind": "program",
      "size": 25075,
      "sha256": "<hex>",
      "abi_version": 4
    },
    {
      "name": "zlib-1.3.1-rev1-wasm32-9acb9405.tar.zst",
      "program": "zlib",
      "kind": "library",
      "arch": "wasm32",
      "upstream_version": "1.3.1",
      "revision": 1,
      "size": 89614,
      "sha256": "<bytes-sha>",
      "archive_name": "zlib-1.3.1-rev1-wasm32-9acb9405.tar.zst",
      "archive_sha256": "<bytes-sha>",
      "compatibility": {
        "target_arch": "wasm32",
        "abi_versions": [4],
        "cache_key_sha": "9acb9405ef818905a193…"
      },
      "source": {
        "url": "https://github.com/madler/zlib/releases/download/v1.3.1/zlib-1.3.1.tar.gz",
        "sha256": "9a93b2b7…"
      },
      "license": { "spdx": "Zlib" },
      "advisories": []
    }
  ]
}
```

Entries are sorted alphabetically by `name` across both legacy and
the system shapes. Keys within each entry and at the top level are
sorted too (BTreeMap on the generator side) so `shasum -a 256
manifest.json` is deterministic.

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

Common to legacy and the system entries:

- **`name`** — the asset filename in the release. Unique.
- **`kind`** — one of `"kernel"`, `"userspace"`, `"program"`,
  `"vfs-image"`, `"library"`. The first four are legacy shapes;
  `"library"` is the system. `"program"` covers both shapes —
  `archive_name` is the discriminator.
- **`size`** — byte count.
- **`sha256`** — lowercase hex SHA-256 of the asset bytes. Fetcher
  verifies every download.
- **`abi_version`** — for wasm binaries that export `__abi_version`,
  the integer value the export returns. Null for assets that don't
  carry the marker (VFS images, the system archives, legacy binaries).

the system entries (`kind: library`, plus `kind: program` whose
filename ends in `.tar.zst`) also carry:

- **`program`** — logical name (`"zlib"`, `"vim"`). Multiple
  archives can share a `program` value across arches.
- **`arch`** — `"wasm32"`, `"wasm64"`, or `"any"`. Set per
  archive on the system entries; absent on legacy wasm/zip assets.
- **`upstream_version`** / **`revision`** — verbatim from the
  source `deps.toml`. `revision` bumps when the build changes
  without an upstream version bump.
- **`archive_name`** — filename of the `.tar.zst`. Identical to
  `name` for the system entries; `null` (or absent) on legacy entries. The
  consumer-side fetch dispatcher branches on this field — the system
  flows through `xtask install-release`, legacy flows through the
  existing `place`/`extract_flat_zip` shell paths.
- **`archive_sha256`** — SHA-256 of the archive bytes. Equal to
  `sha256` for the system entries; the field is repeated under the
  `archive_*` prefix for symmetry with the consumer-side
  `[binary]` block in `deps.toml`.
- **`compatibility`** — required on the system entries; absent on legacy.
  Object with three required fields:
  - `target_arch` — `"wasm32"` or `"wasm64"`.
  - `abi_versions` — non-empty list of integers ≥ 1; the
    consumer's kernel `ABI_VERSION` must appear in this list.
  - `cache_key_sha` — 64-char lowercase hex; the strict
    equivalence check against the consumer's locally-recomputed
    cache-key sha.
- **`source`** — `{url, sha256}` pair pointing at the upstream
  tarball this archive was built from. `sha256` is the field on
  the system-generated manifests; legacy-vintage manifests carry a `ref`
  instead (a git tag or upstream version label).
- **`license`** — `{spdx, url?}` block, verbatim from
  `deps.toml`.
- **`advisories`** — array of known security advisories
  against the asset. Empty array if none.

See `abi/manifest.schema.json` for the authoritative
JSON-Schema definitions, including the `[compatibility]` shape
and value patterns. The compatibility block's verification
chain is documented in
[`docs/package-management.md`](package-management.md)
under "Release archives".

## How a fetcher validates a release

`scripts/fetch-binaries.sh` is the entry point. It:

1. Reads `binaries.lock` (`{abi, release_tag, manifest_sha256}`).
2. Fetches `manifest.json` from the release; verifies its
   SHA-256 matches `binaries.lock.manifest_sha256`.
3. Cross-checks `manifest.abi_version === binaries.lock.abi` and
   `manifest.release_tag === binaries.lock.release_tag`.
4. **For the system entries** (those carrying `archive_name`),
   delegates to `cargo xtask install-release --manifest … --archive-base
   <release-url>`. `install-release` walks `remote_fetch` for
   each archive — verifying the archive bytes against
   `archive_sha256`, parsing the embedded `manifest.toml`,
   checking `target_arch` against the resolver arch, the
   consumer ABI against `abi_versions`, and the locally-recomputed
   cache-key sha against the archive's `cache_key_sha` — and
   installs each archive into `<cache>/{libs,programs}/<canonical>/`.
   Program archives also mirror to `local-binaries/programs/<name>/`.
5. **For legacy entries** (no `archive_name`), checks the
   content-addressed cache at
   `~/.cache/wasm-posix-kernel/abi-v<N>/objects/<sha256>.<ext>`,
   downloads any missing object, then symlinks/extracts into
   `binaries/`. The kernel/userspace/vfs-image flow is
   unchanged from legacy.

Any SHA-256 mismatch, version mismatch, missing compatibility
field, or `cache_key_sha` mismatch is a hard error — we never
fall back to "best effort." For the system archives the full
verification chain is documented in
[`docs/package-management.md`](package-management.md)
under "Release archives".

## Producing a release

For now, manual. Eventually a GitHub Actions workflow
(`release-binaries.yml`) will automate every step.

1. Build all binaries fresh against the current `ABI_VERSION`
   (kernel via `bash build.sh`, programs via
   `scripts/build-programs.sh`, ported software via each
   `examples/libs/*/build-*.sh`).
2. Run `bash scripts/stage-release.sh --out release-staging`. The
   script handles both halves:
   - legacy entries (kernel, userspace, hand-bundled test programs)
     are staged via `xtask bundle-program --plain-wasm`.
   - the system entries (every `kind=library` and `kind=program`
     manifest in `examples/libs/`) are staged via `xtask
     stage-release`, which fans out across {wasm32, wasm64},
     calls `ensure_built` to populate the resolver cache as
     needed, packs each cache tree into a `.tar.zst` archive
     under `release-staging/{libs,programs}/`, and emits the
     combined `manifest.json`.
3. Run `bash scripts/publish-release.sh <DATE>` (or equivalent) to
   create the GitHub release and upload every staged asset (flat
   wasm, legacy zip bundles, and the system `.tar.zst` archives).
4. Commit the generated manifest into `abi/manifest.json` as the
   repo's reference copy. Follow-up changes to `binaries.lock` pin
   consumers to this release.

See `scripts/stage-release.sh` and `scripts/publish-release.sh`
for the current scripts.
