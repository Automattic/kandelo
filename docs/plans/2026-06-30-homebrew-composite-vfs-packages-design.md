# Homebrew Composite VFS Package Design

Date: 2026-06-30

Bead: `kd-v3fs`

Design status: ready for implementation handoff

Package set: `rootfs`, `shell`, `python-vfs`, `perl-vfs`, `erlang-vfs`,
`vim-browser-bundle`, `nethack-browser-bundle`, `node-vfs`

Parent convoy: `kd-1mr` / Homebrew-all

Source plan: `kd-5yd`, `docs/plans/2026-06-28-homebrew-all-package-inventory-plan.md`

## Problem Statement

Kandelo needs the Wave 4 composite runtime packages moved to the Homebrew model
without turning browser demos into alternate runtime paths. These packages are
not ordinary single-executable ports. They produce product artifacts: base
root filesystems, shell environments, language runtime files, lazy archive
bundles, and browser gallery images.

The implementation must produce Homebrew-backed VFS/image plans or explicit
blockers for every package in this bead. A successful package must be backed by
Formulae, bottle bytes, generated Kandelo sidecars, validated link manifests,
Node smoke evidence, browser smoke evidence, and durable outcome lists. A
blocked or unsupported package must stay visible with the exact dependency,
runtime, image-materialization, host, or tooling boundary that blocks it.

The main design issue is that current composite package builders still consume
`packages/registry` resolver paths and source-tree side effects. The Homebrew
version must consume Homebrew sidecars and verified bottle bytes instead. It
must not evaluate Formula Ruby in host/browser tooling, fetch files from
registry release layouts, or hide platform failures in package-specific image
builders.

## Non-Goals

- Do not implement the package ports in this design bead.
- Do not delete `packages/registry` or remove the current bridge scripts in
  this wave.
- Do not treat these packages as browser-only. Node and browser hosts remain
  equal product surfaces.
- Do not mark browser compatibility from a bottle build, sidecar validation, or
  Node smoke alone.
- Do not evaluate Formula Ruby in VFS image builders or browser code. Builders
  consume sidecars, link manifests, verified bottles, and explicit composite
  specs.
- Do not point lazy-file URLs at Homebrew bottle tarballs. Lazy files and lazy
  archives must reference standalone bytes whose content is the file/archive
  the guest will read.
- Do not weaken `saveImage()` stale-Wasm checks, ABI checks, or
  `runtime_support` planner checks to make an image save.
- Do not work around missing stdlib/runtime files by reading package source
  trees as a side effect of registry builds. If a Homebrew formula does not
  install the runtime tree a composite image needs, fix or block that formula.
- Do not document user-facing guest `brew install` support as part of this
  work.

## Users And Operator Workflows

Package porters need a deterministic path from Homebrew package status to a
composite image. They should be able to ask for `shell` or `python-vfs` and
see whether every dependency is buildable, VFS-plannable, runtime-supported,
and smoked on Node and browser.

Tap publishers need composite Formulae that build through the same trusted
Homebrew workflow as other packages. The Formula owns package identity,
dependencies, version, revision, build, install, and test behavior. Kandelo
sidecars add VFS image metadata, browser gallery eligibility, input package
cache keys, and smoke evidence.

Browser operators need launchable gallery artifacts only after a wasm32 image
has actually booted in the browser host. Missing lazy assets, oversized
images, service-worker failures, ABI mismatches, unsupported runtime status,
and stale Wasm artifacts should surface as explicit status, not as an empty
gallery entry or spinner.

Maintainers and future debuggers need enough metadata to reconstruct what an
image contains after workflow logs expire: tap commit, Kandelo commit, ABI,
selected package closure, bottle URLs and shas, link manifests, lazy assets,
demo profiles, image report, Node/browser smoke commands, outcome lists, and
failure category.

Users need the images to behave like normal Kandelo machines. Shell commands,
language interpreters, Vim, NetHack, and Node/npm should boot through the
kernel, VFS, host runtime, fork instrumentation policy, PTY, framebuffer,
service-worker bridge, and browser UI contracts already documented elsewhere.

## Current State And Constraints

`rootfs` builds `host/wasm/rootfs.vfs` from `MANIFEST`,
`images/rootfs/`, and `images/rootfs/PACKAGES.toml`. The package mapping
currently resolves `local-binaries/` or `binaries/` paths and stores lazy-file
metadata by default.

`shell` starts from `rootfs.vfs`, overlays shell demo config, adds Doom and KMS
profiles, registers lazy files for extended tools, and registers Vim and
NetHack lazy archives. This keeps the initial browser image smaller than an
eager image.

`python-vfs`, `perl-vfs`, and `erlang-vfs` currently read language runtime
trees from registry source/build side effects or legacy package outputs.
Homebrew migration must replace that with files installed by `cpython`,
`perl`, and `erlang` Formulae.

`vim-browser-bundle` and `nethack-browser-bundle` produce lazy archive zips.
They are still packages with both-host obligations: Node can validate archive
contents and runtime behavior by materializing them into an image; browser can
validate the lazy archive through the shell/Kandelo UI path.

`node-vfs` layers npm data and a lazy Node binary onto `shell`. As of the
`kd-nlyy.1` design and implementation, SpiderMonkey-derived `spidermonkey`,
`spidermonkey-node`, and `node` bottles may build but declare
`runtime_support = []` because their artifacts intentionally import
`kernel.kernel_fork` without complete fork instrumentation. `node-vfs` must
therefore publish an explicit blocker or unsupported status until `node` has a
runtime-supported Homebrew bottle.

## Architecture And Data Flow

The target model extends the existing Homebrew sidecar path; it does not create
a second package system.

```text
Automattic/kandelo-homebrew
  Formula/<name>.rb                         authoritative package recipe
  Kandelo/metadata.json                     package and bottle status
  Kandelo/formula/<name>.json               Formula summary
  Kandelo/link/<name>-...json               keg link manifest
  Kandelo/composite/<name>-...json          additive image/bundle recipe evidence
  Kandelo/reports/<name>-...json            provenance, image, smoke outcomes
        |
        v
Homebrew bottle build/test
        |
        v
Kandelo sidecar validation
        |
        v
Homebrew composite VFS builder
  planHomebrewVfs(metadata, runtime)
  buildHomebrewVfs(plan)
  apply composite overlays
  register standalone lazy assets when requested
  write /etc/kandelo/homebrew-vfs.json
  write /etc/kandelo/demo.json when applicable
  saveImage() with ABI and stale-Wasm checks
        |
        v
Node smoke and browser smoke
        |
        v
browser gallery assets only for wasm32 browser-smoked images
```

The existing `planHomebrewVfs()` and `buildHomebrewVfs()` stay the foundation
for dependency closure, ABI checks, runtime support, bottle verification, keg
staging, receipts, and link manifests. Composite packages add a layer above
that foundation:

- `images/vfs/scripts/build-homebrew-composite-vfs-image.ts` or an extension
  of `build-homebrew-vfs-image.ts` should accept a named composite spec,
  metadata path, tap root, arch, runtime, output image/report paths, size
  budget, and optional bottle/lazy-asset cache.
- The composite spec should be explicit data or a small typed module in the
  main repo. It may name base packages, overlay functions, demo profiles,
  entry commands, smoke commands, expected VFS paths, lazy assets, and size
  budgets. It must not be inferred from Formula Ruby.
- A composite Formula invokes the builder and installs the produced artifact:
  `.vfs.zst` for image packages, `.zip` for lazy-archive bundle packages, and
  a JSON image/bundle report beside the artifact.
- Sidecar generation records `artifact_kind` such as `vfs_image` or
  `lazy_archive`, the input package closure, image report sha, lazy asset
  shas, demo profiles, and smoke outcomes. These fields are Kandelo metadata,
  not Homebrew install semantics.
- Browser gallery generation consumes only wasm32 composite images whose
  metadata says `status = "success"`, `runtime_support` includes `browser`,
  `browser_compatible = true`, and the browser smoke artifact is complete.

### Lazy Assets

Existing rootfs and shell images use lazy file and lazy archive metadata. That
behavior is valuable, but Homebrew bottles are tarballs, not raw guest files.
Therefore a Homebrew lazy asset must be one of:

- a standalone raw Wasm file extracted from a verified bottle and published as
  a release/gallery asset with sha256, byte count, source bottle identity, and
  cache key;
- a standalone zip archive such as `vim.zip` or `nethack.zip`, built from
  verified Homebrew bottle contents and published as an asset;
- a package-owned asset installed by a composite Formula and then referenced by
  a gallery release that serves the exact bytes.

If the first implementation does not add this lazy asset materializer, it may
build eager images for correctness and smoke evidence. It must record image
size and create a focused follow-up if eager shell/rootfs images are too large
for browser use. It must not fake lazy behavior by pointing lazy URLs at bottle
tarballs.

### Runtime Support

`runtime_support` remains the allow-list for planning, pouring, saving, and
executing a VFS image. Composite builders must request the runtime they are
validating:

- Node smokes use `runtime = "node"`.
- Browser smokes use `runtime = "browser"`.

If any dependency has unsupported runtime status, the composite package should
be skipped or blocked with a reason that names both the requested composite and
the dependency that caused the block. For example, `node-vfs` should currently
name `node` as blocked by
`fork-instrumentation-disabled-imports-kernel-fork`.

## Package-Specific Design

### rootfs

`rootfs` should become a Homebrew composite image Formula that depends on the
base utility Formulae listed in `images/rootfs/PACKAGES.toml`:
`dash`, `bash`, `ncurses`, `coreutils`, `gawk`, `grep`, `sed`, `bc`, `file`,
`m4`, `make`, `findutils`, `diffutils`, and `posix-utils-lite`.

The builder should start from `MANIFEST` and `images/rootfs/`, then add package
outputs from Homebrew sidecars rather than `local-binaries/` or `binaries/`.
It should preserve normal Unix layout, `/bin/sh`, `/etc/*`, ownership/modes,
lazy-file metadata if standalone lazy assets are available, image metadata with
the current ABI, and `/etc/kandelo/homebrew-vfs.json`.

Node smoke should boot the image and run representative shell commands:
`/bin/sh -lc 'echo ok'`, `command -v` for mapped utilities, a pipeline,
`find`, `diff`/`cmp`, `awk`, and an exit-status check. Browser smoke should run
the same class of checks through the Kandelo browser host before setting
browser support.

### shell

`shell` should layer on the Homebrew `rootfs` image or rebuild the same base
composition from sidecars, then add shell-specific profile/config, guide/demo
metadata, Doom and modeset presentation profiles, extended CLI tools, Vim and
NetHack lazy archives, and any required writable directories.

The implementation should not reconstruct shell from every transitive
dependency if `rootfs` is a successful input image. `rootfs` owns base
utilities; `shell` owns the interactive/demo overlay.

Node smoke should run the shell as an interactive command processor and cover:
PATH lookup, pipes, command substitution, archive/compression commands,
terminal-ish command startup, `git init` local workflow, and a read-only
NetHack score or Vim version path if those archives are present. Browser smoke
should boot the Kandelo shell profile, execute a short terminal script, and
verify lazy archive materialization for at least one lazy archive before
claiming browser support.

### python-vfs

`python-vfs` should be generated from a runtime-supported `cpython` Homebrew
bottle. The CPython Formula must install the interpreter and the stdlib tree
needed by the image. The image builder should not read
`packages/registry/cpython/cpython-src/Lib` as a side effect.

The image should contain the Python stdlib under the prefix expected by the
interpreter, `/tmp`, `/home`, `/work` or equivalent writable space, demo
metadata when used by the Kandelo UI, and Homebrew provenance metadata.

Node and browser smokes should run `python3 -c` with `sys`, `os`, `json`,
`sqlite3` or `zlib` only when those modules are actually included, and a small
script file from the VFS. Unsupported or missing modules must be recorded as
explicit package/runtime status, not silently removed from the smoke.

### perl-vfs

`perl-vfs` should be generated from a runtime-supported `perl` Homebrew bottle.
The Perl Formula must own any stdlib patching required for Kandelo. The image
builder should not patch `warnings.pm` or read `perl-src` directly unless that
patch is moved to the Perl Formula or documented as an explicit platform
boundary.

Node and browser smokes should run `perl -e 'use strict; use warnings; print
"ok\n"'`, load representative core modules such as `File::Find` and `POSIX`,
and execute a small script from the image.

### erlang-vfs

`erlang-vfs` should be generated from a runtime-supported `erlang` Homebrew
bottle. The Erlang Formula must install the OTP runtime tree that the image
needs: `erts`, `kernel`, `stdlib`, `compiler`, and release boot files. The
builder should not depend on `packages/registry/erlang/erlang-install` or a
registry tar extraction cache.

Node and browser smokes should run a noninteractive Erlang command such as
`erl -noshell -eval 'io:format("ok~n"), halt().'`, verify the code path can
find `kernel` and `stdlib`, and record startup time and stderr.

### vim-browser-bundle

`vim-browser-bundle` should remain a lazy archive asset package unless a later
decision removes separate bundle packages. The bundle should be built from the
verified `vim` Homebrew bottle contents, not from resolver cache paths. It
should install or publish a `vim.zip` whose central directory creates
`/usr/bin/vim` and the Vim runtime tree under `/usr/share/vim/...` when
registered with mount prefix `/usr/`.

Node smoke should validate the zip central directory, materialize it into a
test image, and run `vim --version` or a noninteractive Ex command through the
Node host. Browser smoke should validate the lazy archive through a shell image
or a focused browser image before recording browser support.

### nethack-browser-bundle

`nethack-browser-bundle` should mirror the Vim bundle pattern. It should build
`nethack.zip` from verified `nethack` Homebrew bottle contents, including the
binary and runtime tree under `/usr/share/nethack`.

Node smoke should validate archive paths and run a read-only command such as
`nethack -s` in a test image with `/home/.nethack` initialized. Browser smoke
should prove the lazy archive materializes and the terminal startup path is
usable. Save-file behavior should use real writable VFS state, not package
script shortcuts.

### node-vfs

`node-vfs` is currently blocked by Homebrew `node` runtime status. While the
`node` bottle has `runtime_support = []`, `node-vfs` must publish a visible
blocked or unsupported status and skip image generation with a reason that
names the blocked dependency and its artifact-policy evidence.

After `node` becomes runtime-supported, `node-vfs` should layer npm and a
writable workspace onto the Homebrew `shell` image. The npm data should be
owned by the `node` Formula, a `node-vfs` Formula resource, or an explicit
helper asset decided by the registry-replacement work. It should not remain a
hidden `packages/registry/npm` side directory. SpiderMonkey/npm compatibility
patches should live in the owning Formula or composite spec so they are
reviewable and testable.

Node smoke should cover `node --version`, a small `node -e`, `npm --version`,
CommonJS resolution, and `npm install` only when the network/fetch and npm data
path are intentionally in scope. Browser smoke must separately prove the same
image boots in Chromium before browser compatibility is claimed.

## Alternatives Considered

Keep using `packages/registry` resolver outputs inside composite builders.
Rejected. That preserves split-brain source of truth and makes the Homebrew
Formulae a facade instead of the package authority.

Evaluate Formula Ruby from VFS tooling to discover installed files. Rejected.
Homebrew consumes Formula Ruby; Kandelo VFS tooling consumes generated
sidecars, link manifests, and verified bottle bytes.

Make every composite image eager in the long term. Deferred. Eager images are
the simplest correctness path and may be acceptable for some language images,
but rootfs and shell already rely on lazy metadata to keep browser downloads
reasonable. Lazy assets need standalone byte artifacts and provenance.

Make the bundle packages browser-only assets. Rejected. The package contract
requires both-host accounting. Node can validate archive structure and runtime
behavior even when the final user workflow is browser-oriented.

Treat `node-vfs` as supported because its image can be assembled without
running Node. Rejected. A VFS image is a runtime launch artifact. If the Node
binary is not VFS-runtime-supported, the image must not claim Node or browser
support.

Bypass stale-Wasm checks for language or Node images. Rejected. Stale ABI and
fork-instrumentation failures are product-artifact defects and must stay loud.

## Risks And Mitigations

| Risk | Mitigation |
|---|---|
| Composite Formulae duplicate package graph truth while registry and sidecars still exist. | Keep Formula dependencies authoritative, use the bridge only as scaffolding, and add validator checks comparing composite spec inputs to sidecar dependency closure during migration. |
| Lazy assets point at the wrong byte shape. | Require lazy assets to be standalone raw Wasm or zip bytes with sha256, bytes, source bottle identity, and cache key. Reject bottle tarball URLs for lazy file entries. |
| Images become too large when using eager Homebrew pours. | Record raw/compressed image size in reports, set package-specific size budgets, and create a focused lazy-asset materializer follow-up if budgets are exceeded. |
| Language VFS builders keep relying on source-tree side effects. | Make missing stdlib/runtime files a Formula blocker. The Formula or its resources must install the runtime tree needed by the composite image. |
| Browser compatibility is overclaimed. | Require Playwright/browser boot and package-specific smoke before `browser_compatible = true` or gallery asset generation. |
| Node unsupported status blocks `node-vfs` and downstream shell workflows. | Publish explicit blocked status for `node-vfs`; do not weaken `runtime_support`. A later SpiderMonkey fork/no-fork runtime effort should unblock it. |
| Composite sidecars become too complex for ordinary packages. | Add `artifact_kind` and composite metadata only for image/bundle packages; leave ordinary program/library Formulae unchanged. |
| Image reports are not enough after CI artifact expiry. | Store normalized reports or summary shas in `Kandelo/reports/` and upload large raw logs/images to release assets with byte counts and hashes. |
| Build scripts mutate shared worktree state. | Run from managed worktrees, use temp dirs for extracted bottles/assets, and write outputs under the package/workflow output root. |

## Implementation Sequence

1. Rebase or merge onto the Homebrew branches/PRs that provide successful
   sidecars for Wave 1, Wave 2, and the needed Wave 3 dependencies. Do not
   begin image support claims from the stale convoy base alone.
2. Add composite metadata/schema support for `artifact_kind`, image or bundle
   reports, input package closure, lazy assets, demo profiles, and
   package-specific smoke evidence.
3. Add a Homebrew composite image builder that uses `planHomebrewVfs()` and
   `buildHomebrewVfs()` as its dependency materialization layer, then applies
   named overlays for `rootfs`, `shell`, language stdlibs, and Node/npm.
4. Add validator rules: composite input packages must be plannable for the
   requested runtime; unsupported dependency status blocks the composite;
   lazy assets must be standalone byte artifacts; image reports must match
   metadata; browser gallery assets require browser smoke.
5. Port `rootfs` first. It is the base contract for the rest of this wave.
   Build it from Homebrew sidecars, inspect expected paths, run Node smoke,
   then browser smoke.
6. Port `shell` second, consuming the Homebrew `rootfs` output or the exact
   same rootfs input closure. Keep demo metadata and lazy archive behavior
   explicit.
7. Port language VFS packages one at a time after their runtime Formulae are
   successful and runtime-supported: `python-vfs`, `perl-vfs`, then
   `erlang-vfs`.
8. Port `vim-browser-bundle` and `nethack-browser-bundle` as lazy archive
   asset packages built from Homebrew bottle contents, with Node and browser
   archive/materialization smoke.
9. Record `node-vfs` as blocked or unsupported until the `node` dependency is
   runtime-supported. Once unblocked, port it by layering npm/helper data on
   the Homebrew `shell` image.
10. For each package, publish bottle, sidecar, image report, Node smoke,
    browser smoke, upstream-test status or skip reason, and complete
    passed/failed/skipped outcome lists.
11. Run the review gauntlet and create focused follow-up beads for any blocking
    runtime, lazy asset, size, browser, or metadata issues.

## Test And Documentation Plan

Focused checks for implementation:

- Ruby syntax and Homebrew checks for every new or changed Formula.
- `jq` or schema validation for composite sidecars, image reports, and gallery
  manifests.
- `cargo xtask homebrew-validate --tap-root <tap>` over generated tap state.
- Unit tests for composite schema parsing, lazy asset validation, unsupported
  dependency diagnostics, and image report validation.
- `npx tsx images/vfs/scripts/build-homebrew-composite-vfs-image.ts ...` for
  each successful image package, with reports retained.
- `node tools/mkrootfs/bin/mkrootfs.mjs inspect <image> --metadata --format
  json` or equivalent image inspection for expected paths and metadata.
- Node package smokes that boot the actual produced image or materialized
  archive.
- Browser Playwright smokes for wasm32 packages before any browser-compatible
  claim or gallery asset.

Full gates before implementation closure should follow `CLAUDE.md`. If the
implementation changes package build scripts, sidecar schemas, host VFS
planner/builder code, browser gallery behavior, or image helpers, the closure
report should explain which of these were run or skipped with reason:

- `cargo test -p kandelo --target aarch64-apple-darwin --lib`
- `cd host && npx vitest run`
- `scripts/run-libc-tests.sh`
- `scripts/run-posix-tests.sh`
- `bash scripts/check-abi-version.sh`

Every substantive build/smoke/test run must publish passed, failed, and
skipped outcome lists. Skipped entries need reasons, especially for unsupported
runtime status, browser host limits, upstream test unavailability, or deferred
lazy asset support.

Documentation updates should target:

- `docs/homebrew-publishing.md` for composite image and lazy asset workflow.
- `homebrew/kandelo-homebrew/Kandelo/README.md` for sidecar/report fields.
- `docs/package-management.md` for the registry-to-Homebrew role of composite
  VFS packages.
- `docs/porting-guide.md` for Homebrew-backed lazy archive production.
- `docs/browser-support.md` and `docs-site/guide/vfs-images.md` for browser
  gallery, demo metadata, and lazy asset constraints if behavior changes.

## Open Questions

1. Do the current `cpython`, `perl`, and `erlang` Homebrew Formulae install all
   runtime files needed by their VFS images, or do those Formulae need
   additional outputs/resources before this wave can proceed?
2. Should v1 composite images be eager for correctness, or should the lazy
   asset materializer be built before `rootfs` and `shell` browser claims?
3. Where should composite specs live long term: main repo under `images/vfs/`,
   generated tap sidecars, or both with one serving as derived evidence?
4. Should `rootfs` be a normal Homebrew Formula that bottles a `.vfs.zst`, or
   should it remain an internal image artifact with Homebrew sidecar evidence
   until registry removal is closer?
5. What image size budgets should block browser compatibility for `rootfs`,
   `shell`, and `node-vfs`?
6. Should `vim-browser-bundle` and `nethack-browser-bundle` remain separate
   package identities, or should future shell images register lazy archives
   directly from the underlying `vim` and `nethack` Formula sidecars?
7. What is the product path for unblocking `node-vfs`: complete
   wasm-fork-instrument support for SpiderMonkey, or a separately designed
   no-fork runtime profile?
