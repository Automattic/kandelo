# kd-1mr.5 -- Browser Runtime Certification for the rootfs/shell Homebrew package set

Bead: kd-1mr.5 (umbrella kd-1mr / initiative homebrew-all)
Session: kg-ydrd / porter-adhoc-49d9da88f8
Generated: 2026-07-01T07:00Z
Worktree: `/Users/brandon/src/kandelo-gascity/worktrees/kandelo/kd-1mr.5-certify-browser-rootfs-shell`
Branch: `gascity/kd-1mr/kd-1mr.5-certify-browser-rootfs-shell` (stacks on kd-0hns tap @ 37bcd20d8 + kd-v3fs browser tooling)
Tap under certification: `test-runs/kd-0hns/rootfs-shell-tap` (the kd-0hns repaired 12-package tap)

## Summary

Ran wasm32 in-browser smokes (Chromium via Playwright, BrowserKernel) for all 12
rootfs/shell packages. **10 of 12 certified `browser_compatible=true`** with
recorded smoke evidence; **2 skipped with reason_code** (framebuffer/device
programs). The corrected sidecars pass `homebrew-validate`. Re-running
`homebrew-composite-status` shows the `browser_compatible=false` blocker for
these 12 is resolved and moves **vim-browser-bundle/browser from skip -> pass**.

| Package | Bottle sha (recorded) | Browser smoke | Disposition |
|---|---|---|---|
| dash    | b07b39e7 | `dash -c 'echo dash_browser_smoke_ok'` -> ok | CERTIFIED browser_compatible=true |
| git     | 2ba2c7ce | `git --version` -> "git version" | CERTIFIED |
| vim     | 778be8fe | `vim --version` -> "VIM - Vi IMproved" | CERTIFIED |
| less    | ee879901 | `less --version` -> "less" | CERTIFIED |
| lsof    | 104cc2d3 | `lsof -h` -> "Usage: lsof ..." | CERTIFIED |
| nano    | 5c9724ce | `nano --version` -> "GNU nano" | CERTIFIED |
| netcat  | 2eec1a03 | `nc -h` -> GNU netcat banner | CERTIFIED |
| wget    | 7d7b48ed | `wget --version` -> "GNU Wget" | CERTIFIED |
| bzip2   | 98468e8b | `bzip2 --help` -> "bzip2" | CERTIFIED |
| xz      | 887c92f5 | `xz --version` -> "xz" | CERTIFIED |
| modeset | 48002a33 | SKIP (reason_code: framebuffer-device-required) | browser_compatible=false |
| fbdoom  | 51f8e3d2 | SKIP (reason_code: framebuffer-and-iwad-required) | browser_compatible=false |

## reason_codes (packages that genuinely cannot run in the terminal browser smoke)

- **modeset** -- `framebuffer-device-required`: modeset requires a DRI/GLES
  framebuffer device (`/dev/dri`) not provided by the non-interactive terminal
  Homebrew browser smoke. Certify via a dedicated browser framebuffer/device smoke.
- **fbdoom** -- `framebuffer-and-iwad-required`: fbdoom requires IWAD game data
  and a framebuffer/audio device (`/dev/fb0`). Certify via a dedicated browser
  framebuffer smoke.

Both mirror the Node smoke's framebuffer skips (kd-v3fs `vim-node-smoke-20260701`:
"22 pass / 0 fail / 2 framebuffer skip"). Encoded in code as
`browserFormulaUnsupportedReason()` in `scripts/homebrew-package-smoke-cases.ts`,
so the browser smoke records them as skip-with-reason rather than failures.
NOTE: the reason_code is not stored in the sidecar bottle because this worktree's
(kd-0hns-based) `formula.schema.json` does not permit `runtime_status` in formula
bottles; the sidecar records `browser_compatible=false` and the reason_code lives
in this artifact + the runner code + the smoke `summary.json`. Follow-up: when the
kd-v3fs `formula.schema.json` (which permits `runtime_status`) is the tap schema,
record `runtime_status.browser={status:"unsupported", reason_code, reason}` in-sidecar.

## Method

1. Toolchain: root/host/apps `npm ci`; `npx playwright install chromium`;
   `./run.sh build kernel` -> `local-binaries/kernel.wasm` (ABI 16); a prebuilt
   `rootfs.vfs` staged at `local-binaries/rootfs.vfs` (only needed to satisfy the
   browser-kernel `@rootfs-vfs` import; the homebrew-smoke page pours its own VFS).
2. Bottle bytes: the kd-0hns/kd-bry6 bottles were not persisted in a sha-named
   cache. Located the originals in
   `kd-bry6-interactive-network-device-cli/test-runs/kd-bry6/homebrew-bottles/<pkg>-wasm32/bottles/`
   and verified **all 10 match the recorded sidecar sha256** (+ bzip2/xz from the
   kd-1mr.2 pilot cache). Staged into a sha-keyed `--bottle-cache`, so smokes run
   against the exact recorded bottles (no sidecar sha/url changes).
3. Browser smoke: `npx tsx scripts/homebrew-package-browser-smoke.ts --tap-root
   test-runs/kd-0hns/rootfs-shell-tap --formula <...> --arch wasm32 --bottle-cache
   <cache> --result-dir test-runs/kd-1mr.5/browser-smoke`. Each package: build a
   candidate wasm32 VFS from the sidecar + bottle bytes, boot through BrowserKernel
   in headless Chromium, run the package smoke command, assert exit 0 + expected output.
4. Sidecar update: edited the generation input's per-bottle `browser_compatible` +
   `runtime_support` for the 10 certified packages, then **regenerated the tap** via
   `cargo xtask homebrew-sidecars` (recomputes provenance metadata/formula/link shas).
   This is the sanctioned path (hand-editing breaks provenance shas).

## Verification

- Browser smoke (`test-runs/kd-1mr.5/browser-smoke/summary.json`): **23 pass / 0
  fail / 2 skip** (12 VFS builds + browser_server_start + 10 exec pass + 2 skip).
  Outcome lists under `browser-smoke/outcome-lists/`; per-package terminal captures
  under `browser-smoke/<pkg>-wasm32/`.
- Sidecar validation: `cargo xtask homebrew-validate --tap-root
  test-runs/kd-0hns/rootfs-shell-tap` -> **`homebrew-validate: ok (packages=12,
  bottles=12, link_manifests=12, provenance_reports=12)`**.
- Composite status (`test-runs/kd-1mr.5/composite-status[-enriched]/`):
  - Single-tap (12 pkgs): 2 pass / 0 fail / 14 skip; **no browser_compatible
    blocker cites any of the 12 packages** (browser support corrected).
  - Enriched (kd-0hns + kd-0k6q core metadata), browser runtime: **vim-browser-bundle
    /browser PASS**; rootfs/browser blocked only on `bash`,`ncurses`; shell/browser
    blocked on `bash`,`ncurses`,`curl`,`nethack` (all kd-1mr.4) + `fbdoom`,`modeset`
    (framebuffer reason_codes).

## Effect on kd-v3fs browser tier

- **vim-browser-bundle/browser: UNBLOCKED** (skip -> pass) by vim browser certification.
- **rootfs/browser**: browser blocker for its rootfs/shell members resolved; now
  gated only on `bash` + `ncurses` (kd-1mr.4, no Formula yet).
- **shell/browser**: gated on `bash`,`ncurses`,`curl`,`nethack` (kd-1mr.4) plus
  `fbdoom`,`modeset` (need a dedicated framebuffer browser smoke -- follow-up).
- python-vfs/perl-vfs/erlang-vfs/browser: unchanged, still blocked on
  cpython/perl/erlang (kd-yuef, parked on trusted GHCR bottle publish).

## Artifacts (committed under test-runs/kd-1mr.5/, .vfs.zst images gitignored)

- `browser-smoke/summary.json`, `summary.md`, `outcome-lists/{passed,failed,skipped}-tests.tsv`,
  per-package `*-terminal.txt` / `*-vfs-report.json`.
- `composite-status/` and `composite-status-enriched/` summary + outcome-lists.
- `sidecars-input.json` (edited generation input used to regenerate the tap).
- Updated tap: `test-runs/kd-0hns/rootfs-shell-tap/Kandelo/{metadata.json,formula/*,reports/*}`.

## Code changes (mine)

- `scripts/homebrew-package-smoke-cases.ts`: browser smoke cases for `dash` (shell
  command), `lsof` (`-h`), `netcat` (`nc -h`); `browserFormulaUnsupportedReason()`
  for modeset/fbdoom.
- `scripts/homebrew-package-browser-smoke.ts`: skip device-dependent formulae with
  the reason_code (mirrors the arch-unsupported skip path).

## Stacking / provenance note

This branch is based on kd-0hns (the rootfs-shell tap) and brings in the kd-v3fs
browser tooling (`homebrew-package-browser-smoke.ts`, `homebrew-composite-status.ts`,
`homebrew-package-smoke-cases.ts`, `homebrew-smoke-outcomes.ts`,
`apps/browser-demos/pages/homebrew-smoke/*`, `homebrew-vfs-planner.ts`,
`vite.config.ts`) so the smokes can run. Those tooling files are kd-v3fs's and
will dedupe when kd-v3fs merges; the net kd-1mr.5 contribution is the browser
certification (sidecar updates), the tailored smoke cases + framebuffer skip logic,
and the evidence artifacts.

## Follow-ups

1. Dedicated **browser framebuffer/device smoke** for modeset + fbdoom (and a
   node/browser framebuffer harness), to certify the graphical rootfs/shell members.
2. Adopt the kd-v3fs `formula.schema.json` (permits `runtime_status`) as the tap
   schema so browser reason_codes are recorded in-sidecar, not only in artifacts.
3. shell/browser + rootfs/browser full pass depend on kd-1mr.4 landing
   bash/ncurses/curl/nethack Formulae.
