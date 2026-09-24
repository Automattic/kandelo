# Image-Owned Machine Definitions, Plan 2: Image Self-Sufficiency And App Cutover

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every image carry its own programs and init configuration, then delete the browser app's built-in machine tables so `?vfs=` plus a generic `&profile=` boots any machine — first-party or third-party — through one path.

**Architecture:** Two phases in one plan. Phase A makes images self-sufficient: bake `dinit`, `sdl2`, `evdev_demo`, and `espeak-ng` into the images that need them, move shell and service environments into `/etc/profile.d` and dinit service definitions, and derive the readiness service list from the image's own `/etc/dinit.d/boot`. Phase B cuts the app over: a curated roster supplies gallery membership, `/etc/kandelo/demo.json` supplies everything else, and `LIVE_DEMO_SPECS`, `PRESET_LIBRARY`, `VFS_SOURCES`, `DEMO_ALIASES`, `DEFAULT_DEMO_FOR_VFS_IMAGE`, `builtinDemo*`, `SHELL_PROFILES`, `INIT_ENV_PROFILES`, `REQUIRED_DINIT_SERVICES`, the three `stage*` functions, `customVfsProfile`, and `views/Config.tsx` are deleted outright.

**Tech Stack:** TypeScript, vitest (from `host/`), Playwright, tsx image build scripts.

**Spec:** `docs/superpowers/specs/2026-09-22-image-owned-machine-definitions-design.md`

**Predecessor:** `docs/superpowers/plans/2026-09-22-image-owned-machine-definitions-1-schema.md` (complete — schema plus tracked sources; nine images already bake `demo.json` verbatim).

## Global Constraints

- **Test command is always** `scripts/dev-shell.sh bash -c 'cd host && npx vitest run <paths>'`. A bare `npx vitest` fails: global setup shells out to `wasm32posix-cc`. Both sysroots are already built in this worktree.
- **Never `git reset`, never `git stash`.** This worktree shares its `.git` with five other active sessions. One earlier implementer destroyed a commit with `git reset HEAD~1`; another pulled in a foreign 140-file stash. Undo with `git revert`, or amend only a commit you created and confirmed is yours via `git log -1`.
- **Report real test output**, including counts. An earlier implementer on this project reported passing tests it had never executed.
- `web-libs/kandelo-session` owns reusable browser-facing contracts; `apps/browser-demos` owns app-specific wiring. Respect that boundary — the roster loader and availability model are session-library concerns; the React panes are app concerns.
- Boot-time init comes from the image only. No URL-carried state may supply `argv`, `cwd`, `uid`, `gid`, or `env`.
- Resource requests from an image are clamped by host policy, never trusted.
- Commit subjects use `Area: Purpose` (`Images:`, `Browser:`, `Docs:`, `Packages:`).
- `./run.sh prepare-browser` is how images get rebuilt after a builder change. It is cached; a no-op rebuild is fast.

## Review Focus

Input classes the spec implies that no task's happy path exercises. Each has its test assigned to the task that owns the code.

1. **A third-party image declaring an `init.target` that does not exist in its `/etc/dinit.d/`** — must fail with a message naming the missing service, not hang waiting for a readiness probe that will never pass. (Task A4)
2. **A roster entry whose product cannot be resolved** — must render as a disabled entry with a truthful reason, never a silent omission or a boot-time throw. (Task B1)
3. **A `?profile=` value that matches no profile in the image** — must be a loud error, not a silent fallback to the image's default. (Task B2)
4. **A pasted `#k1=` link carrying `boot.argv`** — must be ignored with a visible log line, and the machine must boot the image's own init. Every link `ShareDialog` ever produced carries a boot block, so rejecting would break them all. (Task B4)
5. **An image whose `demo.json` is absent or malformed, reached via `?vfs=`** — must fail loudly with the real reason, not fall back to a synthesized terminal machine. `customVfsProfile` is deleted, so nothing catches this any more. (Task B2)

---

# Phase A — Image self-sufficiency

### Task A1: Bake `dinit` into images; delete the page-origin fetch

**Files:**
- Modify: `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts` (delete `dinitWasmUrl` import at :140, the `programUrl` field on `LiveDemoSpec` and `LiveProfile`, and the staging fetch at ~:1436-1443)
- Verify: `images/vfs/scripts/dinit-image-helpers.ts` (`addDinitInit` already installs `/sbin/dinit` and `/sbin/dinitctl`)
- Test: `host/test/dinit-image-helpers.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `LiveDemoSpec.init` and `LiveProfile.init` without `programUrl`. Task B3 deletes both types entirely.

**Why this is safe:** `addDinitInit` (`dinit-image-helpers.ts:423`, `installDinitBinariesUnlessInherited`) already bakes `/sbin/dinit` into every service image at build time. The app's fetch overwrites a binary the image already shipped — with one from the page origin, which is a stale-artifact and ABI-mismatch vector. The fetch is already suppressed whenever `CANONICAL_PAGES_VFS_LOADER` is defined; this makes that unconditional.

- [ ] **Step 1: Prove the binary is already in the image**

Add a test to `host/test/dinit-image-helpers.test.ts` asserting that after `addDinitInit(fs, services)`, `/sbin/dinit` and `/sbin/dinitctl` exist, are regular files, and are mode 0o755. Assert against the filesystem, not the builder source.

- [ ] **Step 2: Run it**

`scripts/dev-shell.sh bash -c 'cd host && npx vitest run test/dinit-image-helpers.test.ts'`
Expected: PASS (the behavior already exists; this pins it before the app stops compensating).

- [ ] **Step 3: Delete the fetch**

Remove from `live-setup.ts`: the `dinitWasmUrl` import, `programUrl` from both interfaces, the three suppression sites (~:1004, :1035, :1088-1090) which become unconditional, and the staging block that fetches and `writeVfsBinary`s it.

- [ ] **Step 4: Verify no image regressed**

`scripts/dev-shell.sh bash -c 'cd host && npx vitest run test/ ../web-libs/'` — record counts.
Then `./run.sh prepare-browser` and confirm it succeeds.

- [ ] **Step 5: Commit**

```bash
git add apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts host/test/dinit-image-helpers.test.ts
git commit -m "Images: Stop overwriting the image's own dinit from the page origin

addDinitInit already bakes /sbin/dinit into every service image, so the
app's staging fetch replaced a shipped binary with one from the page
origin — a stale-artifact and ABI-mismatch vector the ABI contract says
must fail loudly rather than be papered over.

The fetch was already suppressed for canonical Pages products on the
grounds that they own their complete executable closure. Every image
does."
```

---

### Task A2: Bake `sdl2`, `evdev_demo`, and `espeak-ng` into the shell image

**Files:**
- Modify: `images/vfs/scripts/build-source-rootfs-shell-image.ts` (add the three programs plus sdl2's shader presets and espeak's voice data)
- Modify: `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts` (delete `stageSdl2Runtime` ~:1955, `stageEspeakRuntime` ~:1988, `stageEvdevDemo` ~:2017, their `OPTIONAL_BINARY_URLS` glob entries, and the shader source imports)
- Test: `tests/package-system/source-rootfs-shell-bridge.test.ts` or a new image-content test

**Interfaces:**
- Consumes: nothing.
- Produces: a shell image containing `/usr/local/bin/sdl2`, `/usr/local/bin/evdev_demo`, `/usr/bin/espeak-ng`, `/usr/share/espeak-ng-data/`, `/usr/share/shaders/{image,sound}/`. Task B3 relies on these existing when it deletes the staging functions' call sites.

**Why:** an image whose programs the host injects at boot is not self-describing and cannot be booted by a third party from `?vfs=` alone. Read the three existing `stage*` functions for exactly which paths and modes to reproduce — including the zip extraction for espeak's data tree, which must land unpacked at `/usr/share/espeak-ng-data` because `PATH_ESPEAK_DATA` is compiled in.

- [ ] **Step 1: Write the failing test**

Assert from a built image's filesystem that each path exists, is a regular file, and (for the three binaries) is executable. Do not assert against builder source.

- [ ] **Step 2: Run it** — expect FAIL (paths absent).

- [ ] **Step 3: Add them to the builder**

Follow `build-source-rootfs-shell-image.ts`'s existing pattern for `fbdoom` (it already resolves a binary input and `writeVfsBinary`s it to `/usr/local/bin/fbdoom`). The three programs resolve the same way the `stage*` functions do today, via the binary resolver rather than Vite globs.

- [ ] **Step 4: Rebuild and verify**

`./run.sh prepare-browser`, then re-run the test. Record output.

- [ ] **Step 5: Delete the staging functions and commit**

```bash
git commit -m "Images: Bake sdl2, evdev_demo, and espeak-ng into the shell image

These three programs were injected into the image by the browser app at
boot, fetched from local-binaries. An image the host has to complete is
not self-describing, and a third party could never boot those machines
from ?vfs= alone."
```

---

### Task A3: Move shell and service environments into the image

**Files:**
- Modify: image builders to write `/etc/profile.d/*.sh` and dinit service `env` blocks
- Modify: `packages/registry/*/*-demo.json` — `init` blocks reduce to `{ "target": "<service>" }`
- Modify: `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts` — delete `SHELL_ENV`, `NODE_SHELL_ENV`, `SERVICE_ENV`, `SHELL_PROFILES`, `INIT_ENV_PROFILES`, `initEnv`, `shellEnvFor`, `shellCwdFor`
- Test: image-content tests asserting the profile scripts exist with the right contents

**Interfaces:**
- Consumes: A1, A2 (image completeness).
- Produces: images whose environment is POSIX-shaped. Task B3 deletes the app-side constants' last references.

**Why:** dinit services carry their own uid and env per service; `/usr/bin/login -p -f maker` establishes shell identity; `/etc/profile.d` is already used by the node image (`build-node-zip.ts:68`). The app's env constants are a parallel definition of something the image should own.

**Scope note:** Node's `npm_config_*` block goes to `/etc/profile.d/npm.sh` in the node image. The WordPress service env (`WP_APP_PATH`, `WP_PROTO`) is **host-supplied at runtime** — it depends on the deployment's app prefix and protocol — so it stays app-side. Do not try to bake it; record that exception in the spec.

**Also fixes the deferred `ruby-todo` `cwd` finding:** `live-setup.ts:436-446` boots Ruby as pid 1 with `cwd: "/var/lib/todo"`, but Plan 1's tracked file demoted it to a shell `autoCommand` with no cwd. Give it a dinit service with the right `cwd` and an `init.target`, or record explicitly why a shell `autoCommand` with a `cd` prefix is acceptable.

- [ ] **Step 1: Write failing tests** for the profile scripts and service env blocks.
- [ ] **Step 2: Run them** — expect FAIL.
- [ ] **Step 3: Implement** in the builders; reduce the tracked `init` blocks.
- [ ] **Step 4: Rebuild** with `./run.sh prepare-browser`, re-run tests, record output.
- [ ] **Step 5: Commit** — `Images: Move machine environments into the images that own them`.

---

### Task A4: Derive the readiness service list from the image

**Files:**
- Modify: `apps/browser-demos/pages/kandelo/kernel-host/dinit-boot-status.ts` (delete `REQUIRED_DINIT_SERVICES` at :13)
- Modify: `web-libs/kandelo-session/src/` — add a reader for `/etc/dinit.d/boot`'s `depends-on` lines
- Test: new unit test for the reader

**Interfaces:**
- Consumes: A3.
- Produces: `readDinitBootTargets(fs, target): string[]`. Task B2 consumes it in place of the deleted constant.

**Why:** `/etc/dinit.d/boot` is a dependency aggregator naming every service (`dinit-image-helpers.ts:423-440`), so the app's hand-maintained list duplicates data the image already states.

**Review Focus 1 lives here:** a declared `init.target` with no matching `/etc/dinit.d/<target>` must fail with a message naming the missing service, not hang on a readiness probe.

- [ ] **Step 1: Write failing tests** — including the missing-target case.
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** the reader; delete `REQUIRED_DINIT_SERVICES`; wire `live-setup.ts` to the reader.
- [ ] **Step 4: Verify** — vitest, record counts.
- [ ] **Step 5: Commit** — `Browser: Read the readiness service list from the image's own dinit tree`.

---

# Phase B — App cutover

### Task B1: The roster and the availability model

**Files:**
- Create: `apps/browser-demos/pages/kandelo/gallery-roster.json`
- Create: `web-libs/kandelo-session/src/gallery-roster.ts`
- Test: `web-libs/kandelo-session/test/gallery-roster.test.ts`

**Interfaces:**
- Produces: `parseGalleryRoster(text): GalleryRoster`, `type RosterEntry = { product: string; profile: string }`, and `type EntryAvailability = { state: "available" | "not-built" | "unavailable-here"; reason?: string }`. Tasks B2/B3 consume both.

Roster shape (array order is display order; membership only — all content comes from the image):

```json
{ "schema": 1, "entries": [
  { "product": "browser-main-shell", "profile": "shell" },
  { "product": "browser-main-shell", "profile": "doom" }
] }
```

Seed it from `PRESET_LIBRARY`'s current order, including `sdl2` (which is deliberately in the gallery — its omission from `pages-vfs-product-gallery.json` was drift).

**Review Focus 2 lives here:** an entry whose product cannot be resolved renders disabled with a truthful reason — never omitted, never a boot-time throw.

- [ ] Steps 1-5: failing test → run → implement → verify → commit (`Browser: Add a curated gallery roster and availability model`).

---

### Task B2: Read the machine from the image; `&profile=` replaces `?demo=`

**Files:**
- Modify: `apps/browser-demos/pages/kandelo/main.tsx` (stop reading `demo`)
- Modify: `apps/browser-demos/pages/kandelo/url-state.ts` (stop writing `demo`; add `profile`)
- Modify: `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts` (`descriptorForBootQuery`, `profileForDescriptor`)
- Test: `web-libs/kandelo-session/test/` plus `apps/browser-demos/test/kandelo-url.spec.ts`

**Interfaces:**
- Consumes: B1's roster, Plan 1's `resolveDemoIdentity` / `resolveDemoRuntime` / `resolveDemoInit` / `resolveDemoWeb` / `resolveDemoDisplay` / `resolveDefaultProfileId`, A4's `readDinitBootTargets`.
- Produces: the boot path that Task B3 finishes gutting.

Resolution order for which profile boots (superseded 2026-09-23: the
fragment channel below was removed outright, both writing and reading it;
`&profile=` is now the only channel — see the spec's "One profile channel:
`&profile=`, not two (2026-09-23 revision)"):
1. `&profile=<id>` if present — an id matching no profile in the image is a **loud error**, not a fallback (Review Focus 3).
2. ~~else the fragment on the `?vfs=` URL (`#<profile>`) — this channel stays; see the spec's "Two profile channels, both kept".~~
3. else the image's `defaultProfile`.
4. ~~If both channels are present and disagree, log it rather than resolving silently.~~

**Review Focus 5 lives here:** an image with absent or malformed `demo.json` reached via `?vfs=` must fail loudly with the real reason. `customVfsProfile` is gone, so nothing synthesizes a fallback machine.

- [ ] Steps 1-5 as above. Commit: `Browser: Boot machines from image metadata and select them with &profile=`.

---

### Task B3: Delete the tables and collapse the boot ladder

**Files:**
- Modify: `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts` (the bulk of it)
- Delete: `apps/browser-demos/pages/kandelo/presets.ts`
- Modify: `web-libs/kandelo-session/src/demo-guides.ts` (delete `builtinDemoGuide`, `builtinDemoPresentation`, `builtinDemoAssets`; keep the `*Guide()` functions only if something still imports them — Plan 1 inlined their output into tracked JSON, so they are probably now dead too; check and delete what is unreferenced)

**Delete list** (the spec's "What gets deleted", minus what earlier tasks already removed): `LIVE_DEMO_SPECS`, `LIVE_DEMO_IDS`, `LiveDemoId`, `DEMO_ALIASES`, `DEFAULT_DEMO_FOR_VFS_IMAGE`, `normalizeDemoId`, `isLiveDemoId`, `WEB_BOOT_LOG_DEMO_IDS`, `VFS_SOURCES`, `LiveVfsImage`, `OptionalDemoVfsImage`, the `relPaths` arrays, `vfsImageUrlForPreset`, `vfsImageUrlResolverForPreset`, `liveDemoIdForVfsImageUrl`, `PRESET_LIBRARY`, `customVfsProfile`, `SDL2_FB_W`/`SDL2_FB_H` and the stale comment claiming they match `kms-registry.ts`.

**Input attachment becomes declarative.** Replace the `framebufferTest → sdl2Demo → espeakDemo → evdevDemo → runScript → autoCommand` else-if ladder with: attach an input source if `runtime.features` includes `evdev-input`, then run the command. Derive the rest from declared features, never from DOM selectors in image metadata:
- `evdev-input` **and** a display feature (`kms`/`framebuffer`) → display pane owns the pointer (`pointer:false, wheel:true`), capture scoped to that pane.
- `evdev-input` alone → pointer from the window, capture scoped to the stage.

**Display dims come from the window**, per the spec — `onResize → setInputCanvasDims`, with the image's `display` block supplying a minimum only. Delete the hardcoded 1920×1080.

`fb=test` stays as an app-level dev toggle, explicitly not part of `demo.json`.

- [ ] Steps 1-5. This is the point of no return and must not be split. Commit: `Browser: Delete the app's built-in machine tables`.

---

### Task B4: Boot identity comes only from the image

**Files:**
- Modify: `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts` (`effectiveBoot`, ~:1287-1294 and the init spawn at ~:1646-1647)
- Modify: `apps/browser-demos/pages/kandelo/dialogs/ShareDialog.tsx` (stop spreading `baseDescriptor.boot`)
- Delete: `apps/browser-demos/pages/kandelo/views/Config.tsx` and its 49 `kcfg-` rules in `styles.css`
- Modify: `apps/browser-demos/pages/kandelo/gallery-descriptor.ts` (drop the `boot.argv` assignment)
- Test: a case proving a pasted descriptor's `boot.argv` is ignored

**Review Focus 4 lives here.** Incoming boot identity is **ignored with a visible log line, not rejected** — `ShareDialog` spreads `baseDescriptor.boot` into every link it has ever produced, so rejecting would break them all. Ignoring keeps them booting; the log keeps the drop truthful.

Reachability to fix: `app/NewMachinePane.tsx:34-39` and `views/EmptyState.tsx:44-50` decode a pasted fragment and hand the whole descriptor to `applyBootDescriptor`.

`Config.tsx` has no importers — it is dead UI. Delete it whole, with its CSS.

- [ ] Steps 1-5. Commit: `Browser: Take boot identity only from the image`.

---

### Task B5: Migrate the Playwright specs

**Files:** the ~14 specs using `?demo=` — `kandelo-merge-gate`, `kandelo-doom-ingest`, `kandelo-evdev`, `kandelo-sdl2`, `kandelo-modeset`, `kandelo-espeak`, `kandelo-wordpress`, `kandelo-node`, `kandelo-nginx-php`, `kandelo-url`, `kandelo-link-script`, and any others `grep -rn "demo=" apps/browser-demos/test/` finds.

This is not optional cleanup — `?demo=` is removed, not aliased, so these land with B2/B3 or the suite is red.

Running browser specs needs a dev server. Bind a unique `--strictPort`; five other sessions share this machine and Playwright will silently reuse a peer's server otherwise.

- [ ] Steps 1-5. Commit: `Browser: Move the browser suite off the removed demo query parameter`.

---

### Task B6: Invert the checker; update docs; remove the scaffolding

**Files:**
- Modify: `scripts/check-pages-vfs-product-registry.mjs` — derive from tracked image sources and assert the app contains **no machine identities**; this is the durable guard that the tables cannot come back
- Modify: `scripts/check-image-demo-config.mjs` — implement the baked-equals-tracked comparison now that images are built (Plan 1 recorded this as a known gap); byte-compare single-source images, and skip composed ones per the spec's documented exception
- Delete: `web-libs/kandelo-session/test/tracked-demo-parity.test.ts` (it pins against `PRESET_LIBRARY`, which B3 deleted)
- Modify: `docs/browser-support.md:608` — the shared-link form is no longer `?demo=<id>#k1=<payload>`
- Modify: `apps/browser-demos/pages/kandelo/kernel-host/pages-vfs-product-gallery.json` — stop carrying `gallery_entries`; deployment scoping only

- [ ] Steps 1-5. Commit: `Browser: Assert the app holds no built-in machine identities`.

---

## Done when

- `scripts/dev-shell.sh bash -c 'cd host && npx vitest run'` is no worse than the pre-existing baseline, with every failure attributable to absent artifacts rather than this work.
- `grep -rn "LIVE_DEMO_SPECS\|PRESET_LIBRARY\|DEMO_ALIASES\|normalizeDemoId\|builtinDemo" apps/ web-libs/ --include='*.ts' --include='*.tsx'` is empty.
- `grep -rn '"demo"' apps/browser-demos/pages/kandelo/` finds no query-parameter use.
- `./run.sh prepare-browser` succeeds and the app boots every roster entry.
- Browser-facing behavior is verified in a real browser, not from code reasoning — the validation contract requires it.
