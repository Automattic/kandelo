# kd-k3l9 -- Browser Framebuffer/Device Smoke Harness (modeset + fbdoom)

Bead: kd-k3l9 (umbrella kd-1mr / initiative homebrew-all)
Session: kg-ydrd / porter-adhoc-49d9da88f8
Generated: 2026-07-01T07:40Z
Worktree: `/Users/brandon/src/kandelo-gascity/worktrees/kandelo/kd-k3l9-browser-framebuffer-smoke`
Branch: `gascity/kd-1mr/kd-k3l9-browser-framebuffer-smoke` (stacks on kd-1mr.5 -> kd-v3fs tooling -> kd-0hns tap)

## Summary

Built a browser framebuffer/device smoke harness and used it to certify the two
rootfs/shell packages the terminal smoke (kd-1mr.5) could only skip. **Both are
now `browser_compatible=true` with real in-browser rendering evidence**, so the
whole 12-package kd-0hns rootfs/shell tap is browser-certified (`homebrew-validate: ok`).

| Package | Device | In-browser evidence | Disposition |
|---|---|---|---|
| fbdoom  | /dev/fb0        | bound fb 640x400; 1424 pixel-write frames (91 MB); canvas 249,072 non-blank px | CERTIFIED browser_compatible=true |
| modeset | /dev/dri/card0  | 110 KMS page-flip commits at 1920x1080 via WebGL2 (CRTC 1) | CERTIFIED browser_compatible=true |

## The harness

New, sibling to the kd-1mr.5 terminal smoke:
- `scripts/homebrew-package-framebuffer-smoke.ts` -- pours the Homebrew VFS for
  the package (reusing planHomebrewVfs + buildHomebrewVfs), injects the DOOM
  shareware IWAD for fbdoom, serves it, drives headless Chromium (new-headless
  `chromium` channel for WebGL2-in-worker), runs the program, and asserts on
  framebuffer/CRTC activity.
- `apps/browser-demos/pages/homebrew-fb-smoke/{index.html,main.ts}` -- boots the
  poured VFS through BrowserKernel with a PTY (framebuffer programs query
  /dev/tty at keyboard init and exit without one), then:
  - **fb mode** (fbdoom): subscribes to `kernel.framebuffers.onChange`/`onWrite`
    and renders via `attachCanvas` (2D). Pass = fb bound + pixel writes + non-blank canvas.
  - **kms mode** (modeset): transfers an OffscreenCanvas to the worker via
    `kernel.kmsAttachCanvas(1, offscreen, statsSab, { mode: "webgl2" })` and reads
    page-flip telemetry (`commit_count`, scanout w/h) from the stats SAB. Pass =
    page-flip commits + a live scanout resolution.
- `apps/browser-demos/vite.config.ts` -- registers the `homebrew-fb-smoke` page input.

## Method notes (two real defects the harness had to solve)

1. **PTY required.** fbdoom reached `I_InitGraphics` (framebuffer configured) but
   then printed "Using keyboard on /dev/tty. Unable to query terminal settings."
   and exited before the first frame. Booting with `pty: true` gives it a
   queryable terminal so it proceeds into the render loop.
2. **KMS attach after boot.** `kmsAttachCanvas` must run after `kernel.boot()`
   (the worker does not exist before boot); attaching before boot throws
   "Cannot read properties of undefined (reading 'postMessage')".

## Bottle provenance

The kd-bry6 fbdoom/modeset bottles (sha256 matching the kd-0hns sidecars) were
staged into a sha-keyed `--bottle-cache`; the IWAD (`doom1.wad`, sha256
`1d7d43be...`, freely-redistributable DOOM shareware) was fetched from
`https://distro.ibiblio.org/slitaz/sources/packages/d/doom1.wad` and injected at
`/doom1.wad`. No sidecar sha/url changes -- only `browser_compatible` +
`runtime_support` flipped, then the tap was regenerated via `cargo xtask
homebrew-sidecars` (recomputes provenance shas).

## Verification (durable artifacts under test-runs/kd-k3l9/)

- Framebuffer smoke: **5 pass / 0 fail / 0 skip** (`fb-smoke/summary.json` +
  `outcome-lists/`; per-package `*-fb-result.json`).
- Sidecar validation: `cargo xtask homebrew-validate --tap-root
  test-runs/kd-0hns/rootfs-shell-tap` -> **`homebrew-validate: ok (packages=12,
  bottles=12, link_manifests=12, provenance_reports=12)`**; all 12 packages now
  `browser_compatible=true`.
- Composite status (`composite-status-enriched/`, browser runtime, kd-0hns +
  kd-0k6q core metadata): `shell/browser` and `rootfs/browser` no longer list
  modeset/fbdoom as blockers -- both now gated only on kd-1mr.4's
  bash/ncurses/curl/nethack. `vim-browser-bundle/browser` PASS.

## Effect on kd-v3fs browser tier

- modeset + fbdoom removed as `shell/browser` blockers. shell/browser now depends
  only on kd-1mr.4 (bash/ncurses/curl/nethack). rootfs/browser depends on bash+ncurses.
- Combined with kd-1mr.5, the full 12-package rootfs/shell set is browser-certified;
  the remaining browser-tier work is kd-1mr.4's four missing Formulae and the
  language wave (kd-yuef).

## Stacking / provenance note

Branch stacks on kd-1mr.5 (which brought in the kd-v3fs browser tooling + certified
the 10 terminal packages). Net kd-k3l9 contribution: the framebuffer smoke harness
(runner + page + vite input), the modeset/fbdoom sidecar certification, and the
evidence artifacts. Suggested merge order: kd-0hns -> kd-v3fs -> kd-1mr.5 -> kd-k3l9.

## Follow-ups

- A CI-gated variant of this harness (matching the existing kandelo-modeset.spec)
  so the framebuffer certification is regression-guarded, not run-once evidence.
- shell/browser + rootfs/browser full pass depend on kd-1mr.4 landing
  bash/ncurses/curl/nethack.
