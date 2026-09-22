# Image-Owned Machine Definitions

Date: 2026-09-22
Status: Design approved; implementation not started

## Why

A Kandelo VFS image should describe the machine it contains. Today it
does not: the browser app does.

`apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts` holds a
hardcoded table of twelve built-in demo identities (`LIVE_DEMO_SPECS`)
carrying each machine's init argv, environment, memory ceiling, worker
count, feature list, and HTTP readiness probe. A parallel table in
`apps/browser-demos/pages/kandelo/presets.ts` (`PRESET_LIBRARY`) holds
each machine's title, summary, accent colour, glyph, and boot command.
A third (`web-libs/kandelo-session/src/demo-guides.ts`) holds guide
content keyed by the same ids, and is imported *both* by the image
builders as content to bake in *and* by the app as a runtime fallback.
`DEMO_ALIASES` and `DEFAULT_DEMO_FOR_VFS_IMAGE` translate between id
spellings.

Three consequences follow, and all three are visible in the tree today:

1. **A `?vfs=` URL is not enough to boot a first-party machine.** Six
   demos (`shell`, `doom`, `modeset`, `sdl2`, `evdev`, `espeak`) share
   one shell image, so the image URL is ambiguous and a `?demo=<id>`
   selector disambiguates it against an app-side id list.
2. **Third-party images are structurally second-class.** An image the
   app has no table entry for falls to `customVfsProfile`
   (`live-setup.ts:1040`), which yields a bare terminal: no init, no
   network, no framebuffer, default caps. Not because such an image
   cannot express those things, but because there is nowhere for it to
   say so.
3. **The duplicated definitions drift, silently.** `sdl2` is present in
   `PRESET_LIBRARY` and `LIVE_DEMO_SPECS` as of `2bef9f783` but absent
   from `pages-vfs-product-gallery.json`; the registry checker only
   enforces gallery ⊆ presets, so nothing fails.
   `images/vfs/products/browser-main-shell.toml` declares
   `[boot] argv = ["/usr/bin/login","-p","-f","maker"]` while the app's
   `descriptorFor()` composes its own boot identity in TypeScript and
   never reads it.

This work moves every machine definition into the image, so that a
first-party machine and a stranger's image travel one code path, and
`?vfs=` alone is sufficient to boot either.

## Goal and non-goals

**Goal.** The browser app carries no knowledge of built-in machine
identities: no id list, no per-id switch, no per-id spec table. Success
is the outright deletion of `LIVE_DEMO_SPECS`, `PRESET_LIBRARY`,
`DEMO_ALIASES`, `DEFAULT_DEMO_FOR_VFS_IMAGE`, `VFS_SOURCES`,
`normalizeDemoId`, and the `builtinDemo*` fallbacks — not shadowing
them behind image metadata that falls back to them.

**Non-goals.**

- Replacing built-in machine definitions with boot-link scripts.
  Auto-run scripts and first-party definitions have different trust
  (see "Trust boundary"), and `#k1=` links remain a user-authoring
  feature layered on top of this one.
- Making `caps.network` enforcing (see "Known-inert capability flag").
- Publishing one image per demo. Images stay multi-profile; a profile
  selector remains, but the app no longer knows any profile names.

## Decisions already made

- `/etc/kandelo/demo.json` inside the image is the **only** authority
  for what a machine is.
- Its bytes come from a **tracked source file copied verbatim** into
  the image, generalizing the existing
  `packages/registry/shell/source-rootfs-shell-demo.json` pattern.
  Tracked source and baked artifact are byte-identical and checked.
- URL shape is `?vfs=<image>` plus an optional generic profile
  selector; the image declares its own default profile, so `?vfs=`
  alone boots something well-defined.
- Gallery membership is a **separate curated roster**, never claimed
  in-band by an image.
- Resource ceilings are host policy. Images request; the host clamps.

## Authority and artifact flow

```
packages/registry/<image>/<name>-demo.json   (tracked, reviewed, IS the artifact)
        |
        +-- baked verbatim --> /etc/kandelo/demo.json in the image   [boot authority]
        +-- aggregated ------> gallery listing content               [listing only]
```

Aggregating the *tracked sources* — not the built images — is what lets
the gallery list machines whose images have not been built. A fresh
worktree has zero `.vfs.zst` files; the listing must still render.

Boot reads only the baked `demo.json`. The aggregated listing never
feeds the boot path, so the two cannot disagree in a way that changes
what runs. A build check asserts baked bytes equal tracked bytes.

### Why not the product TOML

`images/vfs/products/*.toml` already carries `[boot]` argv/cwd/uid/gid,
`[boot.env]`, and `[[mounts]]`, and generates
`images/vfs/products/generated/catalog.json`. It was considered as the
authority with `demo.json` generated from it. Rejected: a third-party
image has no product TOML, so that choice would permanently preserve
the first-party/third-party asymmetry this work exists to remove. The
TOML remains the build recipe; its `[boot]` block becomes the input the
tracked `demo.json` is reviewed against, not a second runtime source.

## The roster

Gallery membership is a curated, ordered, tracked list. An image cannot
put itself in the gallery — including a third-party image the user
loads, which would otherwise be able to claim a place in the app's
front page simply by declaring one.

```json
{ "schema": 1, "entries": [
  { "product": "browser-main-shell", "profile": "shell" },
  { "product": "browser-main-shell", "profile": "doom" },
  { "product": "browser-node",       "profile": "node" }
] }
```

Array order is display order. Entries carry **membership only** — every
byte of displayed content (title, summary, accent, glyph) comes from
the image's `demo.json`.

Entries name a **product id**, not an image filename, so resolution
reuses the existing product/catalog machinery. This is what permits
deleting `VFS_SOURCES`, `OptionalDemoVfsImage`, and the hand-maintained
`relPaths` arrays in `live-setup.ts`.

The line this design holds: the app learns that `doom` is *on the
roster*; it never learns what `doom` *is*.

`pages-vfs-product-gallery.json` is today a roster of this shape but is
welded to the exact Pages product set. The roster lifts out to stand on
its own; that file keeps deployment scoping only and stops carrying
`gallery_entries`.

## Availability model

Every roster entry is always listed. Whether it can be launched is
resolved separately:

| State | Condition | UI |
|---|---|---|
| available | product resolves (local build present, or Pages product activatable) | enabled |
| not built | tracked `demo.json` exists, image artifact absent | listed, disabled, names the build command |
| unavailable here | product exists but this deployment does not serve it | listed, disabled, reason shown |

This is an improvement on today's behavior, not a concession to it.
Currently an unbuilt image is a *boot-time* failure — `optionalBinaryUrl`
throws after the user clicks — and the browser specs work around it with
`gotoOrSkip`. Listing the entry as present-but-unavailable states the
real boundary before the click, per the platform-values contract's
preference for truthful failure over convenient illusion.

## Schema

Added per profile, alongside today's `presentation`, `assets`, `guide`,
and `ingest`:

```json
"wordpress-mariadb": {
  "identity": { "title": "WordPress MariaDB",
                "summary": "WordPress on nginx + PHP-FPM with MariaDB.",
                "accent": "#5f8f73", "glyph": "wp+",
                "base": "kandelo:shell@abi<N>",
                "packages": ["dinit@local", "nginx@local", "..."] },
  "runtime":  { "features": [], "network": true,
                "requests": { "memoryPages": 16384, "maxWorkers": 24 } },
  "init":     { "argv": ["/sbin/dinit","--container","-p","/tmp/dinitctl","nginx"],
                "cwd": "/root", "uid": 0, "gid": 0, "env": { "...": "..." } },
  "web":      { "requiredPorts": [8080, 9000],
                "requiredServices": ["..."], "probeHttp": true,
                "probePath": "/..." }
}
```

A profile with no `init` block boots the image's shell session; `shell`
carries the env/cwd/uid/gid that `SHELL_PROFILES` holds today, which is
how the Node machine's `npm_config_*` environment stops being an
app-side constant.

The image also declares `defaultProfile`, replacing
`DEFAULT_DEMO_FOR_VFS_IMAGE`.

A profile may declare `aliases` (e.g. `spidermonkey`,
`spidermonkey-node` on the Node profile), which is where the contents of
`DEMO_ALIASES` go. Alias spellings are a property of the machine, so the
image owns them.

### Boot-time init is image-owned, without exception

The machine's init — argv, env, cwd, uid, gid, and the init program's
bytes — comes from the image and from nowhere else. Two paths violate
this today and both are closed by this work.

**The init binary is fetched from the page origin.**
`live-setup.ts:140` imports `dinit.wasm?url` from the repo binary graph,
and `:1436-1443` fetches it and `writeVfsBinary`s it into the image at
`profile.init.argv[0]` during staging. The platform already knows this
is wrong: it is suppressed whenever `CANONICAL_PAGES_VFS_LOADER` is
defined (`:1004`, `:1035`, `:1088-1090`), with the comment "Canonical
Pages products own their complete executable closure just like an
explicit VFS descriptor does." This work makes that unconditional —
`dinit` ships in the image, `programUrl` and the staging fetch are
deleted. An image whose init binary the host injects at boot is not
self-describing, and cannot be booted by a third party from `?vfs=`
alone.

**A caller-supplied descriptor can replace init argv.**
`effectiveBoot` spreads `requestedDescriptor.boot` over the profile's
(`:1287-1294`), and init spawns `effectiveBoot.argv.length > 0 ?
effectiveBoot.argv : profile.init.argv` (`:1646-1647`) — so a descriptor
supplied by the caller replaces what the machine runs as pid 1,
including its uid.

This is **not reachable from a URL today**: the initial descriptor comes
from `descriptorForBootQuery`, and a `#k1=` fragment contributes only
`boot.inputs` and `boot.parameters` (`:752-767`) — `ShareDialog` emits
exactly those two and nothing else. It is a *latent* hole that this
design would activate, because unifying first-party and third-party
paths makes descriptor-carried boot identity the natural next thing a
link would carry. Closing it now costs no existing feature.

The rule, and the distinction the current single merge does not make:

- **URL-carried state may never supply boot identity.** A link may carry
  `boot.inputs` and `boot.parameters` (its script) and nothing else.
  A descriptor arriving from a URL with a `boot.argv` is rejected
  loudly, not merged.
- **An explicit in-app user action may.** The Config pane's editable
  argv field (`views/Config.tsx:132` → `applyBootDescriptor`) stays: a
  person modifying the ephemeral machine in front of them is not
  "outside the image supplying init." That path must be separated from
  the URL path rather than sharing one `effectiveBoot` merge, so the
  provenance of an override is explicit in the code.

### Host-clamped requests

`runtime.requests` is the only block the host may override.
`memoryPages`, `maxWorkers`, `maxMemoryPages`, and the VFS byte ceiling
are requests; `live-setup` clamps each to host policy. An untrusted
`?vfs=` image must not be able to declare its own 16384-page ceiling.
This is a policy boundary, not a second authority, and must be
documented as such where the caps are defined.

### Known-inert capability flag

`network` is carried forward as **descriptive only**, and the schema
docs must say so. Today `LIVE_DEMO_SPECS[id].network` produces
`caps: { network }` and `runtime.features: ["tcp-bridge"]`, and nothing
reads either: across all `.ts`/`.tsx`/`.rs`, `tcp-bridge` appears only
at its producer (`live-setup.ts:2504`), a capability-badge display list
(`views/Config.tsx:331`), and a type comment. `caps.network` has zero
readers. No socket syscall is gated on it.

It does not and would not restrict lazy filesystem references: lazy VFS
fetches are host-side `fetch` through `lazyDownloadListeners`
(`host/src/vfs/memory-fs.ts:4312`), and `lazy-http`/`archive` are
`MountSource` kinds — a separate axis from `caps.network`.

A descriptive-only capability flag is acceptable in an app-owned table
but becomes a trap once third-party images declare it, because it reads
like a sandbox control. **Follow-up (not this work): make `caps.network`
actually gate the guest socket path, or remove it.**

## Input attachment

`sdl2` and `evdev` cannot use `autoCommand` today because
`kernel.attachInputSource(...)` must happen before the program starts
polling `/dev/input/event{0,1}` (`live-setup.ts:1711`, `:1780`). This
becomes a declared boot step rather than a host special case.

The image declares `evdev-input` in `runtime.features`. The host derives
the rest from the declared feature set, so no image ever names a DOM
selector:

- `evdev-input` **and** a display feature (`kms`/`framebuffer`) → the
  display pane owns the pointer (`pointer:false, wheel:true`), capture
  scoped to that pane.
- `evdev-input` alone → pointer from the window, capture scoped to the
  stage.

Attach happens before `autoCommand`, as a defined step. This collapses
the `framebufferTest → sdl2 → espeak → evdev → runScript → autoCommand`
else-if ladder into: attach input if declared, then run the command.

### Display dimensions (stated assumption)

The `SDL2_FB_W/H = 1920/1080` constants at `live-setup.ts:1731` are the
app guessing what the guest will allocate; the adjacent comment claiming
they match `host/src/dri/kms-registry.ts` is stale — that file holds no
such constant, and KMS framebuffer dimensions come from whatever the
guest allocates.

**Assumption, overrulable at review:** the image declares expected
display dimensions now, and a follow-up derives them from the first
bound framebuffer via the existing `onResize → setInputCanvasDims` path.
Deriving is the truthful end state because the guest genuinely owns
those dimensions, but it touches the KMS/input path and does not need to
block this work.

## Precedence (stated assumption)

When a `#k1=` link carries `runScript` and the image declares
`autoCommand`, the link's script wins — matching today's ladder — but
the host logs a visible line ("boot-link script replaces the machine's
configured command") rather than silently dropping the image's command.

## Trust boundary

First-party and third-party images use one schema and one code path,
but carry different trust:

- A first-party `demo.json` is reviewed in-repo and byte-checked against
  the baked artifact.
- A third-party `demo.json` is untrusted input, exactly like a `#k1=`
  fragment. It is size-capped and validated (already true via
  `MAX_KANDELO_DEMO_CONFIG_BYTES` and `validateKandeloDemoConfig`), its
  resource requests are clamped, and it cannot claim gallery membership.

Unifying the path deliberately grants third-party images abilities they
lack today (declaring an init process, a readiness probe, a display
feature). That is the point of the work, and it is acceptable on the
same ground the auto-run script rule rests on: every machine is
ephemeral, so the blast radius is the visitor's own tab. **If persistent
machines ship, this boundary must be revisited alongside the script
consent step already required by
`docs/superpowers/specs/2026-09-21-script-bearing-links-design.md`.**

## What gets deleted

- `LIVE_DEMO_SPECS`, `LIVE_DEMO_IDS`, `LiveDemoId`, `DEMO_ALIASES`,
  `DEFAULT_DEMO_FOR_VFS_IMAGE`, `normalizeDemoId`, `isLiveDemoId`,
  `WEB_BOOT_LOG_DEMO_IDS`
- `VFS_SOURCES`, `LiveVfsImage`, `OptionalDemoVfsImage`, the `relPaths`
  arrays, `vfsImageUrlForPreset`, `vfsImageUrlResolverForPreset`,
  `liveDemoIdForVfsImageUrl`
- `PRESET_LIBRARY` and `presets.ts` as the "reviewed preset authority"
- `builtinDemoGuide`, `builtinDemoPresentation`, `builtinDemoAssets`
- `SHELL_PROFILES`, `INIT_ENV_PROFILES`, `NODE_SHELL_ENV`, and the
  per-profile env constants
- `stageSdl2Runtime`, `stageEspeakRuntime`, `stageEvdevDemo` — their
  binaries and shader presets move into the image builder, since an
  image whose programs the host injects at boot is not self-describing
- `programUrl`, the `dinit.wasm?url` import, and the init-binary staging
  fetch at `live-setup.ts:1436-1443`
- the unconditional `effectiveBoot` merge, replaced by a split that
  distinguishes URL-carried state from explicit in-app overrides
- `customVfsProfile`, which ceases to exist as a distinct path

## Phasing

Each phase lands green on its own. Phase order is chosen so the schema
and its validation exist before any consumer depends on them, and so the
app's id tables are deleted only once nothing reads them.

1. **Schema + validation.** Extend `demo-config.ts` with `identity`,
   `runtime`, `init`, `web`, `defaultProfile`. Add the
   tracked-source-equals-baked-bytes check. No consumers yet.
2. **Tracked sources.** Convert all nine builders from programmatic
   `writeKandeloDemoConfig({...})` to verbatim tracked JSON. Retire
   `images/vfs/scripts/kandelo-demo-guides.ts` (a nine-line re-export of
   the app module) so build-time content and runtime fallback stop
   sharing one file.
3. **Binaries into images.** Bake `sdl2`, `evdev_demo`, `espeak-ng` plus
   shader presets into the shell image, and `dinit` into every image
   whose profile declares it as init; delete the three staging functions
   and the `programUrl` fetch. After this phase no image depends on the
   host injecting an executable at boot.
4. **Roster + availability.** Introduce the roster file and the
   three-state listing; derive the gallery from tracked sources.
5. **App cutover.** Read `demo.json` for everything; delete the tables
   in "What gets deleted"; collapse the boot ladder; add the
   `&profile=` selector with `?demo=` retained as a deprecated alias.

   The alias must not reintroduce an app-side id table. `?demo=<id>`
   resolves *through the roster*: find the entry whose profile (or
   image-declared alias) matches, then boot its product. The roster is
   already loaded for the listing, so the alias costs no built-in
   knowledge. A `?demo=` id that matches no roster entry is an error,
   not a silent fallback to `shell`.
6. **Test migration.** Move the ~14 Playwright specs off `?demo=`.
7. **Checker inversion.** Rewrite
   `scripts/check-pages-vfs-product-registry.mjs` to derive from tracked
   image sources and assert the app contains no machine identities.

Phase 5 is the point of no return and the phase that must not be split:
a half-cut app with both tables and image metadata live is exactly the
dual-authority state this work removes.

## Validation

Per the validation contract, each claim needs evidence for that claim:

- **Schema/validation (phase 1):** unit tests over
  `parseKandeloDemoConfig` / `validateKandeloDemoConfig`, including
  oversized, malformed, and hostile-request inputs.
- **Baked-equals-tracked (phases 1–2):** a build check, run per image.
- **Image content (phase 3):** the binaries must be present in the built
  image, asserted from the image, not from the builder source.
- **Boot behavior (phase 5):** `./run.sh browser` manual verification
  per machine, plus the Playwright specs. Browser-facing behavior is not
  complete from code reasoning; every machine in the roster gets booted.
- **Node/browser parity:** `demo.json` reading is shared code; the Node
  host path must be exercised too, not assumed.
- **No-identities assertion (phase 7):** the inverted checker is the
  durable guard that the tables do not come back.

Unmeasured is unclaimed: this design makes no performance claim, and
none should be made without benchmark evidence.

## Open questions for review

1. Display dimensions — declare now and derive later, or derive from the
   first bound framebuffer immediately?
2. `runScript` vs `autoCommand` precedence — link wins with a visible
   log line, as assumed above?
3. Does the `?demo=` deprecated alias stay indefinitely, or get a
   removal date? `docs/browser-support.md:608` documents
   `?demo=<id>#k1=<payload>` as the shared-link form, so links exist in
   the wild.
4. Is `sdl2`'s absence from `pages-vfs-product-gallery.json` intentional
   (not yet shipped to Pages), or the drift it appears to be?
5. Does the Config pane keep its editable boot-argv field as an explicit
   in-app override, or does "init comes from the image" apply with no
   exception at all, making that field read-only?
