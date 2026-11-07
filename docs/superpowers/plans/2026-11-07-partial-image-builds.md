# Partial Image Builds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `./run.sh partial <image> <pkg>...` composes one product image from
the rootfs base plus only the named packages, bootable in Node and the
browser, never cached by the browser, listing only activities it can run.

**Architecture:** The canonical shell composer gains an explicit package
*selection* (canonical = the whole shell contract, byte-identical output
apart from new `requires` fields). A new `xtask partial-image` verb validates
the request, builds the member packages through the normal local-build
engine and shared cache, resolves each member's output directory, runs the
composer in selection mode, and writes the image plus a manifest to
`local-binaries/partial/`. The browser and Node read that manifest.

**Tech Stack:** Rust (xtask), TypeScript (image composer, browser app,
service worker), Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-07-partial-image-builds-design.md`

**Design amendment (implementer's call, recorded here):** the spec's §2
proposed generated overlay packages. Instead the driver composes the image
directly from resolver-built member outputs. Members still go through the
normal resolver and shared on-disk cache; only the partial image itself has
no package identity. This is strictly stronger for the anti-goals: it cannot
enter the package cache, cannot be published, and cannot shadow a canonical
artifact path.

## Global Constraints

- Canonical shell output is byte-identical before/after, except
  `/etc/kandelo/demo.json` gaining profile `requires` fields.
- Canonical validators keep their full strictness when no selection is given.
- Partial artifacts live only under `local-binaries/partial/` (gitignored);
  never at `shell.vfs.zst` or any canonical product path.
- Base set for every partial shell: the `rootfs` package's closure
  (`packages/registry/rootfs/package.toml` `depends_on`) + `rootfs` +
  `ca-certificates`.
- Named packages must already be canonical shell entries (JSON role +
  `shell/package.toml` `depends_on` + composer table entry where one
  exists). Refusal names those three places.
- Images allowed: those embedding the shell (`shell`, `lamp`, `wordpress`,
  `nginx`, `nginx-php`, `nginx-python`, `web-stack`, `wordpress-family`).
  Others are refused.
- One partial image per worktree; a new build replaces the old one.
- Browser support: Vite dev server (`./run.sh browser`) only.
- No AI attribution in commits; commit subjects `Area: Purpose`.

## Review Focus

1. A named package whose activity needs runtime helpers not named
   (scummvm without curl/unzip): the activity is left out and the CLI
   says which packages it needs — not a silently broken activity.
2. A named package that is already in the base (e.g. `coreutils`): no-op,
   not an error.
3. Re-running with an identical selection: the image is recomposed (never
   "cached"), and its sha256 is stable (deterministic), so the browser does
   not reset state needlessly.
4. Browser opened while no partial image exists: no partial gallery entry,
   no errors.
5. Canonical `shell.vfs.zst` absent in the worktree: the app still starts;
   the canonical shell entry shows the existing missing-product state.

---

### Task 1: Profile `requires` field

**Files:**
- Modify: `web-libs/kandelo-session/src/demo-config.ts` (profile type,
  `validateProfileFields`)
- Modify: `packages/registry/shell/source-rootfs-shell-demo.json`,
  `packages/registry/shell/source-rootfs-shell-demo-profiles.json`
- Test: `web-libs/kandelo-session/test/demo-config-requires.test.ts` (or the
  existing demo-config test file)

**Interfaces:**
- Produces: `KandeloDemoProfileConfig.requires?: string[]` (resolver package
  names, `^[a-z0-9][a-z0-9._-]*$`, unique, ≤ 32 entries) and
  `resolveDemoRequires(config, profileId): string[]` (empty when absent).

Values (profile → requires):
`shell` [], `node` [node-browser-bundle], `sdl2` [sdl2-demo],
`wayland` [wayland-demo], `omarchy` [wayland-demo, quickshell, dbus, foot],
`freeciv` [freeciv-browser-bundle], `doom` [fbdoom],
`quake` [tyrquake, lhasa, unzip], `ffmpeg-fbdev`/`ffplay`/`ffmpeg-video`
[ffmpeg], `modeset` [modeset], `scummvm` [scummvm, curl, unzip],
`love` [love].

- [ ] Test: valid list parses; non-array, bad name, duplicate → throw.
- [ ] Implement; add the values to both JSON files.
- [ ] Canonical validation (Task 2) checks every `requires` entry is in the
      shell contract or the rootfs base.
- [ ] Commit `Images: Declare the packages each shell activity requires`.

### Task 2: Composer selection mode

**Files:**
- Create: `images/vfs/scripts/shell-selection.ts`
- Modify: `images/vfs/scripts/build-source-rootfs-shell-image.ts`,
  `source-rootfs-shell-overlay.ts`, `shell-lazy-archives.ts`
  (`registerShellProfileScripts`), `package-session-files.ts`,
  `packages/registry/shell/build-shell.sh` (unchanged CLI for canonical)
- Test: `images/vfs/test/shell-selection.test.ts`

**Interfaces:**
- Produces in `shell-selection.ts`:
  - `type ShellSelection = { kind: "canonical" } | { kind: "partial"; packages: ReadonlySet<string> }`
  - `selectionIncludes(selection, pkg): boolean` (canonical → true)
  - `filterDemoConfigForSelection(config, selection): { config; included: string[]; excluded: Array<{ profile: string; missing: string[] }> }`
- `SourceRootfsShellInputs` gains `selection?: ShellSelection` (default
  canonical); `wldesktopPath`/`omarchydesktopPath`/`desktopDataPath`/
  `libinputQuirksPath` become required only when `wayland-demo` is selected,
  `espeakNgDataPath` only when `espeak-ng` is.
- Composer CLI gains `--selection <file.json>` (`{"packages": [...]}`); absent
  = canonical. Optional-input flags may be omitted when their package is not
  selected.

Attribution (each step runs only when its owner is selected):
lazy binary/archive/data specs → their `dependency`; desktops, libinput,
desktop-data → `wayland-demo`; espeak data → `espeak-ng`; fbdoom wrapper,
doom-launch, doom rule, `/usr/share/doom`, `/var/games/doom` → `fbdoom`;
quake wrapper, rule, dirs → `tyrquake`; scummvm wrapper, scummvm-play,
catalog, rule, dir, `requireScummvmFreewareMenu` → `scummvm`;
retro-run + rule → `retro-emulators`; SDL2 presets → `sdl2-demo`;
NetHack games + its contract checks → `nethack-browser-bundle`;
vim→vi symlink → `vim-browser-bundle`; python/node/man profile scripts →
their bundles; man displacement/supersession → `mandoc-browser-bundle`;
session packages → each name. Always: Bash materialization, CA lazy data,
terminfo, kandelo-terminal, runtime layout, image client sessions,
`00-kandelo-shell.sh`.

Validators in partial mode: `requireCompleteProductShellContract` checks
only specs whose owner is selected and asserts unselected specs are absent;
`composeSourceRootfsDemoConfig` keeps its exact-profile check against the
tracked files, then the filtered config is written;
`requireOwnedDemoCommands` checks only profiles kept. Image metadata gains
`partialSelection: { schema: 1, packages: [...sorted] }` only in partial
mode (canonical metadata unchanged).

- [ ] Test (no artifacts needed): `filterDemoConfigForSelection` keeps
      `shell`, drops `doom` with `missing: ["fbdoom"]` when only base
      selected; keeps `doom` when `fbdoom` selected; drops `scummvm` with
      `missing: ["curl","unzip"]` when only `scummvm` added.
- [ ] Implement selection plumbing.
- [ ] Verify canonical byte-identity: compose canonical shell from the
      shared-cache inputs before and after; `cmp` equal except demo.json
      (compare with demo.json `requires` stripped via a test hook, or compare
      after Task 1 lands as the new baseline).
- [ ] Commit `Images: Compose the shell from an explicit package selection`.

### Task 3: `xtask partial-image` and `./run.sh partial`

**Files:**
- Create: `tools/xtask/src/partial_image.rs` (+ register verb in `main.rs`)
- Modify: `run.sh` (`partial` subcommand → dev shell → xtask)
- Modify: `.gitignore` if `local-binaries/` is not already ignored

**Interfaces:**
- CLI: `xtask partial-image <image> [<pkg>...] [--with-tests] [--jobs N]`
- Image table: `shell`→`browser-main-shell` (+ derived per Task 7).
- Steps: validate image + names (shell contract JSON) → build closure via
  the same engine call `bootstrap <pkg>` uses, for `rootfs`,
  `ca-certificates`, `bash`, and the named packages → resolve each member's
  directory with the source-only resolution policy (`build-deps path`
  logic) → write selection JSON → run composer via the locked tsx with
  `WASM_POSIX_DEP_<NAME>_DIR` for every selected package → write
  `local-binaries/partial/<image>-partial.vfs.zst` and
  `local-binaries/partial/partial.json`, removing any previous partial
  artifacts first → print included/excluded activities and boot commands.
- Manifest (`partial.json`, schema 1):
  `{ schema, image, productId, file, sha256, bytes, packages (named, sorted),
     selection (all selected, sorted), activities (included ids),
     excludedActivities: [{profile, missing}], builtAt }`
- `--with-tests`: after composing, run Vitest on
  `packages/registry/<pkg>/test/**` for each named package that has tests;
  report packages without tests.

- [ ] Rust unit tests: name validation (unknown → error naming the three
      files; base member → no-op), image validation, manifest JSON shape.
- [ ] Implement; `cargo test -p xtask partial_image`.
- [ ] End-to-end: `./run.sh partial shell tmux less` produces the image;
      Node smoke boots it (Task 4).
- [ ] Commit `Build: Add partial image builds for fast iteration`.

### Task 4: Node boot

**Files:**
- Modify: `scripts/source-rootfs-shell-node-smoke.ts` only if it cannot boot
  a partial image as-is.
- Create: `host/test/partial-image.test.ts` — skipped unless
  `local-binaries/partial/partial.json` exists; boots the image, runs
  `echo ok` and `command -v <each named package's first program>`.

- [ ] Run against the Task 3 output; record result.
- [ ] Commit with Task 3 or separately (`Host: Boot the partial image in Node tests`).

### Task 5: Browser — partial product entry, optional canonical shell

**Files:**
- Modify: `apps/browser-demos/vite.config.ts` (dev middleware serving
  `/@kandelo-partial/partial.json` and `/@kandelo-partial/<file>` from
  `local-binaries/partial/` with `Cache-Control: no-store`; image URL carries
  `?sha=<sha256>`).
- Modify: `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts`,
  `app/App.tsx` and registries as needed: canonical shell import becomes
  optional; new gallery product `partial` sourced from the manifest; its
  listing comes from the manifest + image demo.json.
- Modify: package-session invitation link: disabled with message when the
  canonical shell is absent.

- [ ] Playwright: with a partial manifest present, gallery shows
      "Partial <image> + <pkgs>"; booting it reaches a shell prompt; its
      activity list equals `manifest.activities`.
- [ ] Playwright: no manifest → no partial entry, no console errors.
- [ ] Commit `Browser: Show the worktree's partial image as its own machine`.

### Task 6: Browser — never cached, reset on rebuild

**Files:**
- Modify: `apps/browser-demos/public/service-worker.js` (partial routes
  bypass Cache Storage; network-only).
- Modify: persistence identity for the partial product includes the
  manifest `sha256`; mismatch discards and re-seeds the computer's OPFS
  filesystem with a visible notice.

- [ ] Playwright: rebuild (swap manifest/image) → next boot reads new bytes,
      notice shown, `caches` holds no `@kandelo-partial` entries.
- [ ] Commit `Browser: Never cache partial images and reset them on rebuild`.

### Task 7: Derived images

**Files:**
- Modify: `tools/xtask/src/partial_image.rs` image table; derived builders
  (`build-lamp-vfs-image.ts`, `build-image-families.ts`, nginx/wordpress
  builders) accept the partial shell via `WASM_POSIX_DEP_SHELL_DIR`
  containing a `shell.vfs.zst` the driver stages in a private temp dir.

- [ ] `./run.sh partial lamp` builds and boots in Node.
- [ ] Commit `Build: Partial builds of images that embed the shell`.

### Task 8: Documentation and guidance

Update per spec §9: porting skill build loop, porting guide §4 and lazy
archive registration, validation guide fresh-worktree section, packages
guide, CONTRIBUTING, README quick start, package-management, browser-support,
package-sessions (`requires`).

- [ ] Commit `Docs: Lead porting and contributing with partial images`.
