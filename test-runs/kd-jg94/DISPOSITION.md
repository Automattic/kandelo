# kd-jg94 -- CI-gate the Homebrew Framebuffer Smoke (modeset + fbdoom)

Bead: kd-jg94 (umbrella kd-1mr / initiative homebrew-all)
Session: kg-ydrd / porter-adhoc-49d9da88f8
Generated: 2026-07-01T07:59Z
Worktree: `/Users/brandon/src/kandelo-gascity/worktrees/kandelo/kd-jg94-ci-gate-homebrew-framebuffer`
Branch: `gascity/kd-1mr/kd-jg94-ci-gate-homebrew-framebuffer` (stacks on kd-k3l9)

## Summary

Turns the kd-k3l9 one-shot framebuffer smoke into a **CI regression gate** for
the modeset + fbdoom browser certification -- the silent-breakage class behind
the #810 near-miss. Adds a Playwright spec matching the existing
`kandelo-modeset.spec` pattern, backed by a shared pour library reused by both
the standalone runner and the spec.

## What was added

- `scripts/homebrew-fb-vfs.ts` -- shared core: `FB_SPECS` (per-formula argv +
  device + mode), `FbSmokeResult`, `loadBottleBytes`, and `pourHomebrewFbVfs`
  (pours a Homebrew package into a bootable VFS, injecting the DOOM shareware
  IWAD at `/doom1.wad` for fbdoom). `scripts/homebrew-package-framebuffer-smoke.ts`
  now imports the shared contract instead of duplicating it.
- `apps/browser-demos/test/homebrew-framebuffer.spec.ts` -- the CI-gated spec.
  Pours the modeset + fbdoom Homebrew VFS in `beforeAll`, drives the
  new-headless `chromium` channel, and **fails if rendering regresses**:
  - `fbdoom renders DOOM to /dev/fb0`: asserts fb bind + pixel writes + non-blank canvas.
  - `modeset commits page-flips through /dev/dri/card0`: asserts KMS commit_count + scanout dims.
  It **skips** (chromium-only; and when Homebrew inputs are absent) so it is a
  safe no-op in browser jobs without bottles and a hard gate where they exist.
- `.github/workflows/browser-demos-ci.yml` -- registers the spec in the browser
  smoke job's Playwright list.

## Input contract (how to activate the hard gate)

The spec pours from a configured tap + bottle cache + IWAD; set these in the CI
job that has Homebrew bottles for modeset/fbdoom:

```
KANDELO_HB_FB_TAP_ROOT     tap dir containing Kandelo/metadata.json
KANDELO_HB_FB_BOTTLE_CACHE dir of <sha256>.tar.gz bottles (defaults to <tap>/../bottle-cache)
KANDELO_HB_FB_WAD          doom1.wad path (required for fbdoom; sha256 1d7d43be...,
                           freely-redistributable DOOM shareware from ibiblio)
```

When these are unset (e.g. the current `browser-demos-ci` and staging browser
suites, which prepare *registry* binaries, not Homebrew bottles), the spec
**skips** -- it does not break those jobs.

## Recommended CI placement (flagged for @brandon)

The genuine hard gate belongs in the job that builds Homebrew bottles for
modeset/fbdoom -- i.e. the Homebrew bottle publish/smoke path
(`reusable-homebrew-bottle-publish.yml`, which already runs a browser smoke for
`hello`). That job should export `KANDELO_HB_FB_TAP_ROOT`/`BOTTLE_CACHE`/`WAD`
pointing at the freshly-built tap + bottles and run this spec (or
`scripts/homebrew-package-framebuffer-smoke.ts` directly). Exact placement is a
coordinator/@brandon call given where Homebrew bottles are produced in CI; the
spec is placement-agnostic (env-driven) and verified working (below).

## Verification (durable artifacts under test-runs/kd-jg94/)

- **Playwright spec: 2 passed** (`npx playwright test test/homebrew-framebuffer.spec.ts
  --project=chromium`) against the kd-0hns tap + kd-bry6 bottles + fetched IWAD --
  fbdoom `/dev/fb0` render + modeset `/dev/dri/card0` page-flips both asserted green.
- **Standalone runner (post-dedup): 5 pass / 0 fail / 0 skip**
  (`fb-smoke/summary.json`) -- confirms the shared-lib refactor did not regress
  the runner.

## Stacking / merge note

Stacks on kd-k3l9 (the framebuffer harness), which stacks on kd-1mr.5 -> kd-v3fs
-> kd-0hns. Net kd-jg94 delta: the shared pour lib, the runner dedup, the
Playwright spec, and the browser-demos-ci registration. Suggested order:
kd-0hns -> kd-v3fs -> kd-1mr.5 -> kd-k3l9 -> kd-jg94.

## Follow-ups

- Wire the env-var inputs in the Homebrew bottle publish/smoke CI job to make the
  gate hard on every publish (pending @brandon's placement call).
