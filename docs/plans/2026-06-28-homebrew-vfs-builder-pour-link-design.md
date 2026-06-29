# Homebrew VFS Builder Pour And Link Design

Date: 2026-06-28

Tracked work:

- `kd-8ho` - Homebrew CI and GitHub Packages publishing path.
- `kd-8ho.8` - Teach Homebrew VFS builder bottle pour/link.

This is a design handoff for `kd-8ho.8`. It does not implement the builder.

## Problem Statement

The Homebrew publishing path now has a generated sidecar contract and a host
planner, but it still lacks the materialization step that turns a verified
Homebrew bottle into a Kandelo VFS image. Without that step, downstream Node
and browser smoke beads cannot test a Homebrew-prefix image through the normal
Kandelo runtime path.

The builder must consume `Kandelo/metadata.json` and link manifests, fetch and
verify bottle tarballs, stage kegs under the declared Homebrew prefix, apply the
link manifest, validate receipts, and emit `.vfs.zst` images. It must not
evaluate Formula Ruby, infer links from Homebrew internals at build time, or
mask stale ABI/cache-key/bottle metadata.

## Non-Goals

- Do not implement guest `brew install`.
- Do not evaluate Formula Ruby in Node, browser, or VFS image builders.
- Do not replace Kandelo package archives or `index.toml` binary releases.
- Do not publish a real bottle, tap release, or gallery entry in this bead.
- Do not claim browser support from a Node-built image until the browser smoke
  bead verifies the image path.
- Do not implement rebuild or rollback workflows; that remains `kd-8ho.12`.

## Existing Context

The builder should be stacked on the already closed foundation work:

- `kd-8ho.6`, commit `4407bb787d46bfc586b43514f631e70bf885ff53`, added
  `cargo xtask homebrew-sidecars` and extended `homebrew-validate`.
- `kd-8ho.7`, commit `ad8996531a72ada64ddf43d4d7d074cc77094e26`, added
  `planHomebrewVfs(metadata, options)` in `host/src/homebrew-vfs-planner.ts`
  and exported it from both Node and browser host entrypoints.
- The current `kd-8ho.8` worktree branch does not yet contain those commits.
  Implementation should rebase/cherry-pick the prerequisite work before
  editing builder code or examples.

External assumptions checked on 2026-06-28:

- Homebrew bottles remain the Homebrew-native binary packaging path:
  https://docs.brew.sh/Bottles
- Homebrew taps remain normal Git repositories with `Formula/` content:
  https://docs.brew.sh/How-to-Create-and-Maintain-a-Tap
- The prior design's GitHub Packages permission model remains relevant:
  https://docs.github.com/en/packages/learn-github-packages/about-permissions-for-github-packages

## Users And Workflows

Maintainer workflow:

1. A tap CI run or local fixture provides generated `Kandelo/metadata.json`,
   `Kandelo/link/*.json`, and bottle tarballs.
2. The maintainer runs the builder for selected packages and arch.
3. The builder emits a VFS image and a report naming every fetched bottle,
   selected fallback, sha check, receipt check, and link operation.
4. The maintainer uses that image in the Node smoke bead, then the browser
   smoke bead only after browser compatibility is explicitly marked and tested.

CI workflow:

1. Trusted publish CI generates sidecars and validates them.
2. The builder consumes only generated JSON plus bottle bytes.
3. CI uploads optional precomposed VFS images as release assets after runtime
   smoke tests pass.

Debugging workflow:

1. A failed build should name the package, arch, metadata source, link manifest
   path, selected bottle URL, and exact invariant that failed.
2. The report should make last-green fallback use visible, not silent.
3. If a bottle cannot be safely poured, the builder fails before saving an
   image.

## Architecture

Add a Node-side VFS builder around the existing planner:

```text
Kandelo/metadata.json
  + caller-provided link-manifest loader
        |
        v
host/src/homebrew-vfs-planner.ts
  planHomebrewVfs()
        |
        v
host/src/homebrew-vfs-builder.ts
  verify bottle bytes
  gunzip + parse tar
  stage keg files into MemoryFileSystem
  validate receipts
  apply links
  write builder metadata/report
        |
        v
images/vfs/scripts/build-homebrew-vfs-image.ts
  CLI wrapper
  saveImage(... .vfs.zst)
```

`homebrew-vfs-planner.ts` stays browser-compatible. The high-level builder can
be Node-only because it fetches URLs or local fixtures, hashes bytes, gunzips
bottle payloads, and saves VFS images as build artifacts. Browser support in
this phase means the browser later consumes the precomposed image, not that the
browser downloads and pours bottles itself.

Suggested CLI:

```sh
npx tsx images/vfs/scripts/build-homebrew-vfs-image.ts \
  --metadata /path/to/Kandelo/metadata.json \
  --tap-root /path/to/kandelo-homebrew \
  --package hello \
  --arch wasm32 \
  --runtime node \
  --out target/homebrew-hello.vfs.zst \
  --report target/homebrew-hello.vfs-report.json
```

Useful options:

- `--package <name>` repeatable.
- `--expected-cache-key <name>=<sha256>` repeatable.
- `--no-fallback` to reject non-success bottle metadata.
- `--bottle-cache <dir>` for repeatable local CI runs.
- `--metadata-url <url>` later, when release assets become the source.
- `--max-bytes <n>` to cap VFS capacity and extracted bottle size.
- `--base-image <path>` later, if a Homebrew image should layer on shell/rootfs.

## Data And Control Flow

1. Load parsed `metadata.json`.
2. Load link manifests through the planner's `loadLinkManifest` callback from
   `tap-root` or a release-asset mirror.
3. Call `planHomebrewVfs()` with requested packages, arch, runtime, ABI, cache
   keys, and fallback policy.
4. For each planned package in dependency-first order:
   - fetch or read the selected bottle bytes;
   - verify byte length equals `plan.bytes`;
   - compute sha256 and compare with `plan.sha256`;
   - gunzip the bottle;
   - parse tar entries with path and type validation;
   - stage regular files, directories, and symlinks into `plan.keg`;
   - validate every declared receipt exists after staging;
   - apply link entries into `plan.prefix`;
   - record the package result.
5. Write `/etc/kandelo/homebrew-vfs.json` into the image with tap commit,
   Kandelo commit, ABI, package list, source status, and selected metadata
   paths.
6. Save the image with `saveImage()`, keeping its stale Wasm artifact check on.
7. Write a JSON report next to the image.

## Path Model

The builder needs one canonical path interpretation before implementation.

Recommended rule:

- `linkManifest.keg` is the guest install root for the bottle, for example
  `/home/linuxbrew/.linuxbrew/Cellar/hello/2.12.1`.
- `linkManifest.bottle.payload_root` is the archive root that maps to that
  keg, for example `hello/2.12.1`.
- Bottle entries under `payload_root/<rel>` are staged to
  `keg/<rel>`.
- Bottle entries already shaped as `<rel>` may also be accepted for fixture
  compatibility, but only when they do not conflict with a
  `payload_root/<rel>` entry.
- Link and receipt `source` paths should be treated as prefix-relative when
  they start with `Cellar/`, otherwise keg-relative.
- Link `target` paths are always prefix-relative.

The checked-in example link manifest on the prerequisite branch uses
`Cellar/hello/2.12.1/bin/hello`, while the sidecar generator fixture uses
`bin/hello` with `payload_root = "hello/2.12.1"`. Implementation should either
normalize the examples to the recommended keg-relative shape or support both
forms with the unambiguous rules above. This is a nonblocking design concern,
but it must be resolved before landing code.

## Bottle Parser And Pour Semantics

Use a small internal tar reader for the first implementation unless real
bottles prove that a maintained dependency is needed. The repo already depends
on `fflate`/`fzstd`, but not a tar parser.

Tar support required for the first milestone:

- gzip-compressed tar input;
- regular files, directories, and symlinks;
- POSIX ustar paths;
- PAX `path` and `linkpath` keys if fixture or real bottles require long paths;
- octal mode parsing;
- explicit rejection of absolute paths, `..`, empty path segments, non-UTF-8
  paths, devices, sparse files, hardlinks, and unknown entry types.

Pour behavior:

- Create `prefix`, `cellar`, and `keg` before extraction.
- For a regular file, create the VFS file under the keg with archive mode
  masked to ordinary POSIX permission bits; use the manifest link mode only
  for linked prefix targets.
- For a directory, create it with archive mode or `0755`.
- For an archive symlink, preserve it only if its target is relative and does
  not escape the staged keg after normalization.
- Fail on duplicate final staged paths unless byte-for-byte and metadata-equal
  duplicates are explicitly proven necessary later.

Link behavior:

- `type = "symlink"` creates a symlink at `prefix/target` pointing to
  `prefix/source` when `source` is prefix-relative, or to `keg/source` when
  `source` is keg-relative.
- `type = "file"` copies a staged source file to `prefix/target`, using the
  manifest mode when provided, otherwise the staged source mode.
- `type = "directory"` ensures `prefix/target` exists and validates the source
  directory exists when a source is declared.
- Parent directories are created as needed.
- Duplicate targets remain planner errors; the builder should keep the check
  and fail defensively if a duplicate reaches it.

Receipt validation:

- Validate receipts after staging and before links.
- A receipt starting with `Cellar/` is prefix-relative.
- Other receipts are keg-relative.
- Missing receipts are fatal because the sidecar contract says published images
  need receipts.

Environment handling:

- Write the planned `PATH_prepend` entries into
  `/etc/kandelo/homebrew-vfs.json`.
- For shell-oriented images, the CLI may also add a small `/etc/profile`
  fragment that prepends `${prefix}/bin` and `${prefix}/sbin`, but the Node
  smoke should use absolute paths until that profile behavior is tested.

## Failure Modes

The builder should fail loudly before saving an image for:

- metadata ABI or release tag mismatch;
- unsupported arch or runtime;
- missing package or dependency cycle;
- selected fallback missing any fallback field;
- bottle fetch failure, non-HTTPS remote URL, byte count mismatch, or sha
  mismatch;
- unsafe tar path, unsupported tar type, or extraction outside the keg;
- missing link source or receipt;
- link target escaping the Homebrew prefix;
- stale Wasm artifact detected by `saveImage()`;
- VFS capacity exhaustion.

Each error should include the package name, arch, selected source status
(`success` or `fallback`), metadata/link-manifest path, and bottle URL or local
fixture path.

## Report Contract

Emit a report JSON beside the image:

```json
{
  "schema": 1,
  "image": "target/homebrew-hello.vfs.zst",
  "metadata": {
    "tap_repository": "Automattic/kandelo-homebrew",
    "tap_commit": "<sha>",
    "kandelo_commit": "<sha>",
    "kandelo_abi": 15,
    "release_tag": "bottles-abi-v15"
  },
  "packages": [
    {
      "name": "hello",
      "version": "2.12.1",
      "arch": "wasm32",
      "source_status": "success",
      "url": "https://...",
      "sha256": "<64-hex>",
      "cache_key_sha": "<64-hex>",
      "link_manifest": "Kandelo/link/hello-2.12.1-rebuild0-wasm32.json",
      "staged_files": 12,
      "receipts": ["INSTALL_RECEIPT.json"],
      "links": ["bin/hello"]
    }
  ]
}
```

The report is build evidence for `kd-8ho.9` and `kd-8ho.10`; it is not a
replacement for runtime smoke results.

## Alternatives Considered

Evaluate Formula Ruby:

- Rejected. It violates the sidecar trust boundary and makes host/browser
  builders depend on Homebrew internals and Ruby execution.

Run guest `brew install` to build the image:

- Rejected for this bead. It would test a future guest workflow, but it would
  not provide a deterministic build-time VFS image path and would hide missing
  link-manifest coverage.

Use a third-party tar dependency immediately:

- Deferred. A small parser with strict type support is enough for fixture
  bottles and keeps the dependency surface small. If real Homebrew bottles need
  more tar/PAX behavior, add a maintained dependency with focused fixtures.

Make browser download and pour bottles directly:

- Rejected for the first milestone. Browser CORS, package permissions, and
  storage limits need separate validation. The browser path should consume a
  precomposed VFS image first.

Implement the builder as Rust `xtask`:

- Deferred. The VFS image APIs and existing image scripts are TypeScript. A
  later `cargo xtask homebrew-vfs-build` wrapper can dispatch to the TS script
  if operators need a cargo-shaped command.

## Risks And Mitigations

- Path model drift between examples, generator input, planner, and builder.
  Mitigation: normalize the link manifest examples or support both source
  shapes with one documented resolution rule before landing implementation.
- Real bottles may contain tar features not covered by the first parser.
  Mitigation: fail with exact unsupported type and add fixtures from a real
  bottle before broadening support.
- A successful image could still fail at runtime because the link manifest is
  incomplete. Mitigation: Node smoke must execute the linked binary through
  Kandelo before downstream beads claim support.
- Browser support could be overstated. Mitigation: keep builder Node-side and
  gate browser gallery publication on `browser_compatible = true` plus the
  browser smoke bead.
- Last-green fallback could hide a failed current rebuild. Mitigation: report
  `source_status = "fallback"` and preserve metadata status in image metadata.
- VFS image size may grow beyond browser-friendly limits. Mitigation: expose
  image capacity and compressed size in the report and add a cap option.

## Implementation Sequence

1. Rebase or cherry-pick prerequisite Homebrew scaffold, validator, sidecar,
   and planner commits into the `kd-8ho.8` branch.
2. Resolve the link source path model and update stale examples if needed.
3. Add focused unit tests for bottle tar parsing and path normalization.
4. Add the builder library that consumes `HomebrewVfsPlan` and bottle bytes.
5. Add the CLI wrapper under `images/vfs/scripts/`.
6. Add fixture tests that build a tiny bottle, pour it into a `MemoryFileSystem`,
   inspect staged files, links, receipts, and report output.
7. Run the sidecar generator fixture through the builder so generator, planner,
   and builder share one end-to-end contract.
8. Update Homebrew template docs to document the builder command as
   experimental and not yet user-facing.
9. Hand the produced fixture image/report to `kd-8ho.9` for the Node runtime
   smoke path.

## Test Plan

Focused tests:

- `host/test/homebrew-vfs-builder.test.ts`: successful pour/link, fallback
  source, hash mismatch, byte mismatch, missing receipt, unsafe source path,
  duplicate target defense, unsupported tar entry, stale ABI plan rejection.
- Existing `host/test/homebrew-vfs-planner.test.ts` remains the pre-download
  metadata contract.
- `tools/xtask` Homebrew tests should continue to validate generated sidecars
  and examples if examples are changed.

Suggested commands after implementation:

```sh
cd host && npx vitest run test/homebrew-vfs-planner.test.ts test/homebrew-vfs-builder.test.ts
cd host && npm run typecheck
scripts/dev-shell.sh bash -c 'host=$(rustc -vV | awk '\''/^host/ {print $2}'\''); cargo test -p xtask --target "$host" homebrew -- --nocapture'
npx tsx images/vfs/scripts/build-homebrew-vfs-image.ts --metadata <fixture> --tap-root <fixture-tap> --package hello --arch wasm32 --runtime node --out target/homebrew-hello.vfs.zst --report target/homebrew-hello.report.json
```

Runtime and broader gates:

- `kd-8ho.9` should boot the produced image in Node and execute the linked
  binary through normal Kandelo `exec`.
- `kd-8ho.10` should run `./run.sh browser` and browser smoke coverage before
  any browser gallery claim.
- If implementation changes only TS builder/image tooling, libc and POSIX
  suites are likely skippable with a recorded reason. If it changes kernel,
  ABI, runtime, package output bytes, or browser loader behavior, use the full
  relevant gate list from `CLAUDE.md`.

## Documentation Plan

Implementation should update:

- `homebrew/kandelo-homebrew/Kandelo/README.md` with the builder command and
  the exact path model.
- `homebrew/kandelo-homebrew/README.md` to mention generated VFS images only as
  experimental artifacts until Node/browser smoke beads pass.
- `docs/package-management.md` and `docs/binary-releases.md` only when the
  Homebrew image path becomes an advertised package distribution workflow.
- `docs/browser-support.md` only after browser precomposed image support is
  actually validated.

Do not rewrite the older dated plans to pretend they predicted the final path.
Add amendments or new plan docs instead.

## Open Questions

1. Should generated link manifests be normalized to keg-relative source paths,
   or should `Cellar/...` prefix-relative paths remain first-class?
2. Should the first builder expose a `cargo xtask homebrew-vfs-build` wrapper,
   or is the TypeScript image script enough until operations docs are written?
3. Should `/etc/profile` be modified by default, or should image consumers use
   absolute Homebrew-prefix paths until shell behavior is tested?
4. What default VFS capacity should be used for multi-package Homebrew images?
5. Do real Homebrew/Kandelo bottles contain hardlinks or PAX fields that
   require broader tar support than the first fixture bottles?
6. Should precomposed VFS images live beside sidecars in the same
   `bottles-abi-v<N>` release, or in a separate image-focused release once
   browser smoke starts producing durable artifacts?
