# Homebrew Builtin Bottle Publishing vs Kandelo Custom Publish Path

Date: 2026-07-01

Tracked work:

- `kd-1i0u` - Research: Homebrew builtin bottle publishing (`brew bottle`/`pour`,
  GHCR, `test-bot`/`pr-pull`) vs Kandelo custom publish path.
- Blocks umbrella convoy `kd-1mr` - Port all current Kandelo packages to
  Homebrew (initiative `homebrew-all`).

Prior design context (already implemented, on `main` as of `1ab41fe2a`,
PR #785):

- `docs/plans/2026-06-25-homebrew-ci-github-packages-bottle-publishing-design.md`
  (`kd-7dk`/`kd-8ho`)
- `docs/plans/2026-06-27-homebrew-tap-layout-metadata-schema-design.md`
  (`kd-8ho.1`)
- `docs/plans/2026-06-28-homebrew-vfs-builder-pour-link-design.md`
- `docs/homebrew-publishing.md` (reference doc for the as-built path)

This is design/research work only. It changes no runtime behavior and adds no
code. It answers one question for `kd-1mr`: as we scale from the `hello` pilot
to all ~73 registry packages, should Kandelo keep building its own bottle
publishing automation, adopt Homebrew's builtin automation (`brew test-bot`,
`brew pr-pull`, `brew pr-upload`), or converge on some hybrid?

## Problem Statement

Kandelo already publishes one Homebrew bottle (`hello`, wasm32, ABI-versioned)
through a **first-party, custom-built publish path** implemented entirely in
`Automattic/kandelo`:

- `scripts/homebrew-bottle-build.sh` - build + test + bottle one formula.
- `scripts/homebrew-ghcr-upload.sh` - push bottle bytes to GHCR.
- `scripts/homebrew-generate-sidecars-from-env.sh` +
  `tools/xtask/src/homebrew_sidecars.rs` - generate Kandelo sidecar metadata.
- `scripts/homebrew-publish-sidecars.sh` - validate + commit sidecars/bottle DSL
  to the tap, with a state lock and last-green fallback.
- `scripts/homebrew-plan-matrix.sh` - compute the `(formula, arch)` build matrix
  with `cache_key_sha` skip logic.
- `.github/workflows/reusable-homebrew-bottle-publish.yml` - orchestrate all of
  the above on `push`/`workflow_dispatch`.
- `homebrew/patches/0001-add-kandelo-wasm-bottle-tags.patch` - teach Homebrew's
  bottle-tag parser about `wasm32`/`wasm64` and a `:kandelo` pseudo-system.

Homebrew ships its own end-to-end bottle publishing automation that
`homebrew-core` and most large third-party taps use: `brew test-bot` (build +
test bottles in PR CI), `brew pr-upload` (upload bottle bytes to GHCR as OCI
images and rewrite the `bottle do` DSL), and `brew pr-pull` (pull a reviewed
PR's bottles, commit the DSL, and merge). `brew tap-new --github-packages`
scaffolds a tap wired for exactly this.

The `homebrew-all` convoy is about to fan out across every package. Before we
multiply the surface area of the custom path, we should decide - with evidence -
which parts of it are load-bearing Kandelo-specific work and which parts
reinvent Homebrew builtins we could reuse. Reinventing what Homebrew maintains
is maintenance debt; bending Homebrew's runner-native, PR-merge automation to a
cross-compiled Wasm target it was never designed for is a different kind of
debt. This document draws that line.

## Non-Goals

- Do not implement or migrate anything here. This is a decision record with a
  staged, optional implementation sketch for the one change it recommends.
- Do not re-open settled decisions from the 2026-06-25/06-27/06-28 designs (tap
  name `Automattic/kandelo-homebrew`, sidecar schema, `bottles-abi-v<N>`
  releases, VFS builder contract, `wasm32_kandelo`/`wasm64_kandelo` tags). Those
  are the baseline this compares against.
- Do not design guest `brew install` bring-up. This document identifies where
  the current upload layout blocks it and what unblocks it, but the guest
  install path is separate work (`docs/homebrew-publishing.md` "Current Gaps").
- Do not revive Kandelo package-archive (`index.toml`/`.tar.zst`) publishing as
  a substitute for bottles, or vice versa. They are siblings by prior decision.

## TL;DR / Position

**Keep the custom path for orchestration, tap commit, and sidecars. Adopt one
Homebrew builtin - the GHCR upload layout - and only when guest `brew install`
becomes a goal. Do not adopt `brew test-bot` or `brew pr-pull`.**

The custom path is not reinvention across the board. It already uses Homebrew's
builtin bottle *primitives* (`brew install --build-bottle`, `brew test`, `brew
bottle --json`, `brew bottle --merge --write`). What it adds around them -
matrix planning with `cache_key_sha` skip, sidecar generation, VFS/gallery
gating, last-green fallback, state-locked tap commits, `bottles-abi-v<N>`
release assets - has **no Homebrew builtin equivalent** and exists because
Kandelo bottles are cross-compiled Wasm for a synthetic `:kandelo` system,
published from `main` (not merged from PRs), and consumed by a VFS builder
rather than (yet) by `brew install`.

`brew test-bot` and `brew pr-pull` are built on three assumptions Kandelo does
not satisfy: (1) the CI runner's own OS/arch is the bottle target; (2) bottles
are produced per PR and *merged* into the tap by pulling PR artifacts; (3) the
only metadata that matters is Homebrew's `bottle do` block. Adopting them would
mean fighting all three, for less orchestration code than we'd save.

The **one** builtin worth converging on is `brew pr-upload`'s GHCR **layout**.
The custom `oras push` produces a blob-addressable upload that Kandelo's own VFS
fetcher can read, but it is **not** in Homebrew's native OCI layout (manifest
tagged by formula *version*), so a stock guest `brew install` cannot resolve it.
`brew pr-upload --upload-only` produces the native layout from the same
locally-built bottle bytes, decoupled from `test-bot`/`pr-pull`. Switching the
upload step to it (or teaching the custom uploader to emit the same
version-tagged OCI index) is a low-risk change that keeps every Kandelo-specific
behavior while making the published bottles installable by unmodified Homebrew.
That is the "make it more generally useful without compromising the requested
work" move, and it is the natural precondition for guest install.

## Background: the two candidate mechanisms

### Homebrew builtin bottle publishing (as `homebrew-core` uses it)

Bottle **primitives** (per-formula, platform-agnostic building blocks):

- `brew install --build-bottle <formula>` - build a relocatable keg suitable for
  bottling.
- `brew test <formula>` - run the formula's `test do`.
- `brew bottle --json <formula>` - package the keg into a `.bottle.tar.gz` and
  emit a `*.bottle.json` describing it.
- `brew bottle --merge --write <json>` - splice the generated `bottle do` block
  (sha256 per platform tag, `root_url`, `rebuild`, `cellar`) into the formula.

Bottle **automation** (the end-to-end pipeline):

- `brew test-bot` - the CI orchestrator. On a tap PR it builds and tests the
  changed formulae, runs the bottle primitives, and uploads the resulting
  bottle files + `*.bottle.json` as **workflow artifacts**. It determines the
  platform tag from the **runner it is executing on** (an `arm64_sonoma` runner
  produces an `arm64_sonoma` bottle). `brew tap-new` scaffolds a `tests.yml`
  that runs it.
- `brew pr-upload [--upload-only] --root-url=<ghcr>` - takes locally present
  bottle files + `*.bottle.json` (from a `test-bot` artifact download, or any
  local build), runs `brew audit`, uploads the bottle bytes to GHCR as **OCI
  images** (via `skopeo`/`oras`), and writes the final `bottle do` DSL. It can
  run standalone on a local bottle directory; it does not require `test-bot`.
- `brew pr-pull --workflows=tests.yml --root-url=<ghcr> <PR>` - the maintainer
  merge command. Downloads a reviewed PR's `test-bot` bottle artifacts, calls
  `pr-upload`, commits the DSL, and pushes to the tap's default branch (closing
  the PR). This is the canonical `homebrew-core` flow;
  `.github/workflows/publish-commit-bottles.yml` there runs `pr-pull --no-upload`
  then `pr-upload` on a `workflow_dispatch`.

GHCR **storage/consumption** (the install side):

- `brew pr-upload` publishes each bottle to
  `ghcr.io/v2/<org>/<repo-without-`homebrew-`-prefix>/<formula>`, with the OCI
  manifest **tagged by `version_rebuild`** (formula version, plus bottle tag and
  rebuild), layer media type `application/vnd.oci.image.layer.v1.tar+gzip`.
- At install, Homebrew's GitHubPackages download strategy fetches the OCI
  image **index/manifest by version**
  (`ghcr.io/v2/.../<formula>/manifests/<version>`, `Accept:
  application/vnd.oci.image.index.v1+json` + bearer token), selects the layer
  for the running platform tag, then GETs that layer **blob**
  (`.../blobs/sha256:<sha>`). The `bottle do` `root_url` selects this strategy.

### Kandelo custom publish path (as-built)

Stage map, with the builtin each stage does or does not use:

| Stage | Custom implementation | Builtin used? |
|---|---|---|
| Plan `(formula, arch)` matrix, skip by `cache_key_sha` | `homebrew-plan-matrix.sh` | No builtin - Kandelo cache-key concept |
| Set Wasm bottle tag | `HOMEBREW_KANDELO_BOTTLE_TAG` + patch, temp Homebrew worktree | Patches Homebrew's own parser |
| Build + test + bottle | `homebrew-bottle-build.sh` runs `brew install --build-bottle`, `brew test`, `brew bottle --json --merge --write` | **Yes - builtin primitives** |
| Upload bytes to GHCR | `homebrew-ghcr-upload.sh` (`oras push`, blob URL) | No - reimplements `pr-upload` upload, **non-native layout** |
| Generate sidecars | `homebrew-generate-sidecars-from-env.sh` + `xtask homebrew-sidecars` | No builtin equivalent |
| Validate sidecars | `xtask homebrew-validate` | No builtin equivalent |
| VFS image + browser smoke + gallery | `build-homebrew-vfs-image.ts`, Playwright, `homebrew-create-browser-gallery.sh` | No builtin equivalent |
| Commit DSL+sidecars to tap; last-green on failure | `homebrew-publish-sidecars.sh` (state lock, ff-only, push to `main`) | No - `pr-pull` is PR-merge shaped |
| Release assets `bottles-abi-v<N>` | `gh release upload` in the workflow | No builtin equivalent |
| Orchestrate everything | `reusable-homebrew-bottle-publish.yml` on push/dispatch | No - replaces `test-bot` CI |
| Install-time consumption | `homebrew-vfs-fetch.ts` GETs the sidecar blob `url` | No - not `brew install` |

Two properties of the custom path are decisive for the comparison:

1. **Publish model is push-to-`main`, not PR-merge.** The workflow triggers on
   `push`/`workflow_dispatch`, computes a matrix, and each matrix entry commits
   directly to the tap under a state lock
   (`homebrew-publish-sidecars.sh:140-159`, `:104-120`). There is no PR to pull.

2. **Consumption is the VFS fetcher, not `brew install`.** The current supported
   consumer is `planHomebrewVfs()`/`buildHomebrewVfs()` fed by
   `homebrew-vfs-fetch.ts`, which fetches the sidecar's bottle `url` (a GHCR
   **blob** URL) directly with a `WWW-Authenticate` bearer challenge
   (`homebrew-vfs-fetch.ts:17-34`). Guest `brew install` is explicitly deferred
   (`docs/homebrew-publishing.md:9-10, 309-310`).

## Users and Operator Workflows

- **Convoy porter (the immediate user).** Adds `Formula/<pkg>.rb`, runs the
  reusable publish workflow (or its `dry-run`), and expects a bottle + validated
  sidecars committed to `Automattic/kandelo-homebrew` and a `bottles-abi-v<N>`
  release updated. Cares about: matrix scale to ~73 packages, cache-key skip so
  unchanged packages don't rebuild, per-package pass/fail/skip reporting, and
  last-green preservation when one package fails.
- **Tap maintainer / release owner (`@brandon`).** Approves what publishes,
  wants an auditable trail (provenance reports), controllable rollback that does
  not delete GHCR blobs, and a story for ABI bumps. Cares about how much bespoke
  CI they must understand and keep alive.
- **Homebrew-literate reviewer.** Reads `Formula/*.rb` and expects standard
  Homebrew DSL and a recognizable tap. Cares that the tap "looks like a tap" and
  that bottles live in GHCR the normal way (this is the constituency the
  `pr-upload`-layout convergence serves).
- **Guest `brew install` user (future).** Runs `brew install
  automattic/kandelo-homebrew/<pkg>` on a Kandelo-capable host. Does not exist
  yet; is the reason the upload-layout question matters.
- **Kandelo host/browser runtime (today's consumer).** Consumes sidecars + blob
  bytes via the VFS builder. Indifferent to OCI manifest layout - it uses the
  blob URL.

## Architecture and Data/Control Flow

Custom path (today):

```
push/dispatch
  → plan matrix (cache_key_sha skip)              [homebrew-plan-matrix.sh]
  → per (formula,arch):
       brew install --build-bottle / test / bottle [homebrew-bottle-build.sh]
       oras push bottle → GHCR blob                [homebrew-ghcr-upload.sh]
       generate + validate sidecars                [xtask homebrew-sidecars/validate]
       (hello wasm32) build VFS + browser smoke + gallery
       state-lock → commit DSL+sidecars → push main [homebrew-publish-sidecars.sh]
       gh release upload → bottles-abi-v<N>
  → consumer: VFS fetcher GETs sidecar blob url    [homebrew-vfs-fetch.ts]
```

Homebrew builtin path (as `homebrew-core` runs it):

```
open PR editing Formula/<pkg>.rb
  → test-bot (per runner-platform):
       brew install --build-bottle / test / bottle
       upload bottle files + *.bottle.json as workflow artifacts
  → maintainer: brew pr-pull <PR>
       download PR artifacts
       brew pr-upload → GHCR OCI (manifest tagged by version)
       commit bottle do DSL, push/merge to default branch
  → consumer: brew install → GitHubPackages strategy
       GET manifests/<version> → select platform layer → GET blob
```

The two pipelines share the middle (the bottle primitives) and diverge at both
ends: Kandelo's front end is a version-agnostic **matrix over a synthetic tag**
instead of a **per-runner-platform** build, and Kandelo's back end is a
**state-locked push to `main` with sidecars** instead of a **PR pull/merge**.
The GHCR step in the middle is where the layouts silently differ.

## Component-by-Component Comparison and Recommendation

| Concern | Custom today | Homebrew builtin | Recommendation | Why |
|---|---|---|---|---|
| Compile/test/bottle | builtin primitives via wrapper | same primitives (`test-bot` wraps) | **Keep** | Already builtin; wrapper adds only env + tag + retry |
| Wasm bottle tag | patch + forced tag | none | **Keep** | Needed under any automation; Homebrew has no Wasm system |
| GHCR **upload layout** | `oras push`, blob-only, tag `bottles-abi-v<N>-<arch>-<sha>` | `pr-upload`, native OCI, tag by version | **Reconcile → `pr-upload --upload-only`** | Only builtin that fits; unblocks guest install; low risk |
| CI orchestration | reusable workflow + matrix + cache-key skip | `test-bot` (PR, runner-tag) | **Keep** | `test-bot` assumes runner==target and PR trigger |
| Tap commit / merge | push to `main`, state lock, last-green | `pr-pull` (PR merge) | **Keep** | No PR to pull; sidecars/last-green have no home in `pr-pull` |
| Sidecars / VFS / gallery / provenance | custom | none | **Keep** | No builtin exists; core Kandelo value |
| Release assets | `gh release upload` | none | **Keep** | No builtin exists |
| Install-time download | VFS fetcher (blob url) | GitHubPackages OCI strategy | **Keep for VFS; add native for guest** | VFS is blob-based; guest needs native layout |

Net: one cell changes ("Reconcile"), everything else is "Keep". The custom path
is mostly *not* reinvention - it is the connective tissue Homebrew does not
provide for a cross-compiled, push-published, sidecar-bearing target.

## The GHCR Layout Divergence (key finding)

This is the substantive technical discovery of the research and the basis for
the one recommended change.

**What Kandelo uploads today** (`homebrew-ghcr-upload.sh:89-113`): an image at
`ghcr.io/v2/<owner>/<repo>/<formula>` tagged
`${RELEASE_TAG}-${ARCH}-${SHA_PREFIX}` (e.g.
`bottles-abi-v15-wasm32-<sha12>`), one bottle layer with media type
`application/vnd.homebrew.bottle.layer.v1+gzip`, and a sidecar `url` pointing at
the **blob**: `ghcr.io/v2/<owner>/<repo>/<formula>/blobs/sha256:<sha256>`.
Meanwhile `homebrew-bottle-build.sh:170` calls `brew bottle --root-url
https://ghcr.io/v2/<owner>/<repo>`, so the formula's `bottle do` block gets a
**GHCR** `root_url`.

**What a stock `brew install` expects** from that GHCR `root_url`: the
GitHubPackages download strategy resolves the bottle by fetching the OCI
**index/manifest tagged by the formula version**
(`.../<formula>/manifests/<version>`), not by `bottles-abi-v<N>-<arch>-<sha>`.
Homebrew's own upload path tags manifests `version_rebuild`
(`github_packages.rb`). Kandelo publishes neither a version-tagged index nor
version-tagged per-platform manifests, and uses a different layer media type.

**Consequence:** the current upload is fully sufficient for Kandelo's VFS
fetcher (which bypasses manifest resolution and GETs the blob URL from the
sidecar), but a stock guest `brew install` against the same `root_url` **cannot
resolve the bottle**. This is not a defect in today's scoped deliverable (guest
install is explicitly out of scope), but it is a **latent blocker** that must be
recorded so nobody assumes `brew tap && brew install` works, and so the
`homebrew-all` fan-out does not bake a non-native layout into 73 packages.

**Unblock options (either satisfies the goal):**

- **(A) Adopt `brew pr-upload --upload-only --root-url=<ghcr>`** for the upload
  step, replacing `oras push`. `pr-upload` runs standalone on the locally-built
  bottle files + `*.bottle.json` that `homebrew-bottle-build.sh` already
  produces, emits the native version-tagged OCI layout, and runs `brew audit`.
  Kandelo still reads the resulting bottle URL/sha back into the sidecar for the
  VFS fetcher. Pro: reuses upstream, gets audit + correct layout for free, is
  the exact tool Homebrew maintains for this. Con: adds a dependency on
  `pr-upload`'s CLI surface and its assumptions about the working directory and
  DSL rewrite; needs the tag patch present so it round-trips the Wasm tag.
- **(B) Extend `homebrew-ghcr-upload.sh`** to additionally push a version-tagged
  OCI image index (and matching layer media type) so both the VFS fetcher
  (blob) and guest `brew install` (manifest) resolve. Pro: no new CLI
  dependency, keeps full control of the OCI graph, smallest change to the
  existing shape. Con: Kandelo now owns an OCI-index emitter and must track
  Homebrew's manifest/tag conventions over time - exactly the maintenance the
  builtin exists to absorb.

**Recommendation: prefer (A)** for correctness-by-reuse, keep (B) as the
fallback if `pr-upload`'s DSL-rewrite or working-directory assumptions fight the
Kandelo layout in practice. **Defer either until guest `brew install` is a
committed goal** - doing it now would add risk to the `homebrew-all` fan-out for
a consumer that does not yet exist. Until then, record the divergence in
`docs/homebrew-publishing.md` and keep the VFS fetcher as the only supported
consumer.

## Why not adopt `brew test-bot` / `brew pr-pull` (detail)

- **Runner-platform assumption.** `test-bot` builds the bottle for the platform
  of the runner it executes on and tags it accordingly. Kandelo cross-compiles
  `wasm32`/`wasm64` for a synthetic `:kandelo` system on an `x86_64` Linux
  runner. Producing a `wasm32_kandelo` bottle requires the tag patch plus a
  forced tag (`HOMEBREW_KANDELO_BOTTLE_TAG`), overriding exactly the detection
  `test-bot` is built around. `brew test` under `test-bot` would also expect to
  execute a host-native artifact; Kandelo's `test do` instead runs the Wasm
  through the kernel/Node harness (`Formula/hello.rb` `test do`). The formula
  already handles that, but `test-bot`'s lifecycle around it does not.
- **PR-merge vs push-to-`main`.** `pr-pull` pulls bottle artifacts from a
  reviewed PR and merges it. Kandelo publishes from `main` on push/dispatch with
  a matrix, no PR. Reshaping publishing to be PR-per-bottle to satisfy `pr-pull`
  is a larger change than keeping the current orchestrator, and it fights the
  convoy's push-driven wave model.
- **Sidecar/cache-key blindness.** `pr-pull`/`pr-upload` know only the `bottle
  do` block. They do not generate or validate `Kandelo/` sidecars, build VFS
  images, gate browser support, honor `cache_key_sha` skip, write
  `bottles-abi-v<N>` release assets, or implement last-green fallback. Those are
  the majority of the custom back end and would still have to run alongside,
  eroding the "reuse the builtin" benefit.
- **Maintenance math.** The custom orchestration we would retire (`test-bot`'s
  slice) is a few hundred lines of workflow + `plan-matrix.sh`. The
  Kandelo-specific work we would still own is larger and unavoidable. The trade
  removes little and adds a model mismatch.

## Alternatives Considered

1. **Status quo, no change (keep `oras push` blob-only).** Correct for the VFS
   consumer; leaves guest `brew install` silently broken. Acceptable *only* if
   guest install is permanently out of scope - which the docs do not commit to
   ("Current Gaps" lists it as future). Rejected as the long-term answer; kept
   as the interim state with the divergence documented.
2. **Full adoption of `test-bot` + `pr-pull` + `pr-upload`.** Rejected: model
   mismatch (runner-tag, PR-merge, sidecar-blind) costs more than it saves, per
   the detail above.
3. **Recommended hybrid: keep custom orchestration/commit/sidecars, converge the
   upload step on `pr-upload` layout when guest install is pursued.** Selected:
   preserves every Kandelo-specific behavior, reuses the builtin exactly where
   the builtin is authoritative (GHCR OCI layout), and is stageable behind a
   real trigger.
4. **Switch bottle hosting to GitHub Releases `root_url` instead of GHCR.** A
   plain-HTTPS `root_url` makes Homebrew GET `<root_url>/<bottle_filename>`
   directly, sidestepping OCI entirely - the simplest guest-install-compatible
   option. Rejected as the primary path because the prior design deliberately
   chose GHCR as the canonical bottle host to match Homebrew norms
   (2026-06-25 design "Position"), but retained as an explicit owner-approved
   fallback if GHCR OCI upload proves too costly at 73-package scale.
5. **`brew tap-new --github-packages` regenerate the tap from scratch.**
   Rejected: it would discard the sidecar layout, matrix, and publish model
   already reviewed and merged; it is a scaffolding convenience, not a migration
   path for an existing bespoke tap.

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| `homebrew-all` bakes the non-native blob layout into 73 packages, entrenching a guest-install blocker | Record the divergence in `docs/homebrew-publishing.md` now; do not advertise `brew install`; keep the sidecar `url`/sha as the stable contract so an upload-layout swap is URL-only for the VFS fetcher |
| Adopting `pr-upload` later requires reprocessing already-published bottles | The `bottles-abi-v<N>` model already supports republish; a layout migration is a rebuild/repair pass (existing `repair-only` path), not a new mechanism |
| `pr-upload` DSL rewrite conflicts with Kandelo's `bottle --merge` output or forced Wasm tag | Gate adoption behind a spike that runs `pr-upload --upload-only --dry-run` against a `hello` bottle with the tag patch applied; fall back to option (B) if it fights the layout |
| Media-type mismatch (`vnd.homebrew.bottle.layer.v1+gzip` vs `vnd.oci.image.layer.v1.tar+gzip`) blocks native resolve even if tags are fixed | Verify the exact layer media type current Homebrew expects during the spike; align the uploader (or use `pr-upload`, which sets it correctly) |
| Decision is read as "the custom path is wrong" and triggers churn | This document's position is "the custom path is mostly right"; only the upload layout converges, and only on a trigger |
| Keeping bespoke orchestration is long-term maintenance load as Homebrew evolves | Accept consciously: the bespoke parts are Kandelo-specific with no builtin; track Homebrew `bottle`/`pr-upload` CLI changes since we depend on those primitives regardless |

## Implementation Sequence (only if/when guest `brew install` is pursued)

Staged so nothing lands speculatively:

1. **Trigger.** An owner decision to support guest `brew install` (or a
   Homebrew-literate consumer that needs native tap install). Until then, only
   step 2 lands.
2. **Now (docs-only).** Add a "GHCR upload layout" note to
   `docs/homebrew-publishing.md`: today's upload is blob-addressable for the VFS
   fetcher and is **not** natively `brew install`-resolvable; guest install is
   not supported. (Prevents the fan-out from implying otherwise.)
3. **Spike.** Run `brew pr-upload --upload-only --dry-run --root-url=<ghcr>`
   against a locally-built `hello` bottle inside the dev-shell with the tag
   patch applied. Confirm: native version-tagged OCI layout, layer media type,
   Wasm-tag round-trip, and that the emitted `bottle do` matches Kandelo's
   `brew bottle --merge` output. Record pass/fail.
4. **Reconcile upload.** If the spike passes, replace the `oras push` step in
   `reusable-homebrew-bottle-publish.yml` with `pr-upload --upload-only`; keep
   reading the resulting URL/sha into the sidecar so the VFS fetcher and the
   `homebrew-validate` cross-checks are unchanged. If it fails, implement option
   (B) in `homebrew-ghcr-upload.sh` (version-tagged OCI index + correct media
   type) instead.
5. **Guest-install validation.** Add a Node smoke that does a real `brew
   install automattic/kandelo-homebrew/hello` (guest side) against the native
   layout, plus the negative ABI-mismatch case - separate from the existing VFS
   smoke.
6. **Fan-out.** Only after `hello` validates natively, roll the upload change
   through the `homebrew-all` waves; republish existing bottles via the
   `repair-only` path so all packages share the native layout.

## Test and Documentation Plan

Because the recommended near-term change is docs-only, near-term validation is:

- `git diff --check` and an ASCII scan of this plan and the
  `docs/homebrew-publishing.md` note.
- No code, ABI, package-archive, Node, or browser suites are triggered by a
  docs-only change; do not claim otherwise.

If/when the upload reconciliation lands (step 4+), it is a host/packaging and CI
change and must run the relevant gates, not just unit tests:

- `bash scripts/dev-shell.sh bash -c 'cargo test -p xtask homebrew'` for any
  sidecar/validator touch.
- `cd host && npx vitest run` for VFS fetcher/builder touches (Node + browser
  peers).
- The existing Node smoke (`packages/registry/hello/test/homebrew-node-smoke.ts`)
  plus a new guest-`brew install` smoke.
- Browser smoke via `./run.sh browser` + the Playwright
  `apps/browser-demos/test/kandelo-homebrew.spec.ts` if gallery/VFS output
  changes.
- Publish/skip/fail outcome lists per the convoy's test-artifact rules.

Documentation impact:

- **Now:** `docs/homebrew-publishing.md` gains the GHCR-layout note (step 2).
- **On reconcile:** update `docs/homebrew-publishing.md` "Trusted Publish Flow"
  and "Artifact Model" to describe native OCI upload; update
  `docs/binary-releases.md`/`docs/package-management.md` only if the
  bottle-vs-package-archive storage story changes; add guest `brew install`
  instructions to `README.md` **only** after step 5 passes.

## Open Questions

1. Is guest `brew install` a committed goal for `homebrew-all`, or is the VFS
   builder the intended terminal consumer? The answer sets whether steps 3-6
   ever run. (Owner decision - `@brandon`.)
2. If guest install is pursued, is GHCR-native OCI required, or is a GitHub
   Releases `root_url` (alternative 4) acceptable as the simpler
   guest-installable host? This trades Homebrew-norm alignment for
   implementation simplicity at 73-package scale.
3. Does `brew pr-upload` cleanly round-trip the `wasm32_kandelo`/`wasm64_kandelo`
   tag and `:kandelo` system with the patch applied, or does its DSL/audit path
   assume a real platform? (Resolved by the step-3 spike.)
4. What is the exact layer media type current Homebrew's download strategy
   requires, and does the checked-in `vnd.homebrew.bottle.layer.v1+gzip` need to
   change to `vnd.oci.image.layer.v1.tar+gzip`? (Resolved by the spike.)
5. At 73 packages, is per-package `oras`/`pr-upload` GHCR upload throughput a
   bottleneck that argues for batching or `skopeo copy --all`, independent of
   the layout question?
6. Should the tap ever also carry native per-runner-platform bottles (so
   Homebrew-literate reviewers can `brew test-bot` the tap), or is the
   synthetic Wasm tag the only bottle Kandelo will ever ship?

## Sources

Kandelo (this checkout, `main` @ `1ab41fe2a`):

- `docs/homebrew-publishing.md`
- `docs/plans/2026-06-25-homebrew-ci-github-packages-bottle-publishing-design.md`
- `docs/plans/2026-06-27-homebrew-tap-layout-metadata-schema-design.md`
- `docs/plans/2026-06-28-homebrew-vfs-builder-pour-link-design.md`
- `scripts/homebrew-bottle-build.sh`, `scripts/homebrew-ghcr-upload.sh`,
  `scripts/homebrew-publish-sidecars.sh`, `scripts/homebrew-plan-matrix.sh`,
  `scripts/homebrew-generate-sidecars-from-env.sh`
- `.github/workflows/reusable-homebrew-bottle-publish.yml`
- `homebrew/patches/0001-add-kandelo-wasm-bottle-tags.patch`
- `homebrew/kandelo-homebrew/Formula/hello.rb`
- `host/src/homebrew-vfs-fetch.ts`
- `docs/binary-releases.md`, `docs/package-management.md`

Homebrew (upstream):

- Homebrew Bottles: https://docs.brew.sh/Bottles
- Homebrew tap maintenance (`brew tap-new --github-packages`, `brew pr-pull
  --head-sha`): https://docs.brew.sh/How-to-Create-and-Maintain-a-Tap
- BrewTestBot: https://docs.brew.sh/BrewTestBot
- `pr-upload` implementation (standalone local-dir upload, flags, audit):
  https://github.com/Homebrew/brew/blob/master/Library/Homebrew/dev-cmd/pr-upload.rb
- `github_packages.rb` (OCI tag `version_rebuild`, repo path, media types):
  https://github.com/Homebrew/brew/blob/master/Library/Homebrew/github_packages.rb
- `homebrew-core` publish workflow (`pr-pull --no-upload` + `pr-upload`,
  `HOMEBREW_GITHUB_PACKAGES_*`):
  https://github.com/Homebrew/homebrew-core/blob/master/.github/workflows/publish-commit-bottles.yml
