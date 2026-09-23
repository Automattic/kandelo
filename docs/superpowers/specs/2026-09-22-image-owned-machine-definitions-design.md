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
- Making a network capability enforcing (see "Known-inert capability
  flag", and its 2026-09-23 resolution).
- Publishing one image per demo. Images stay multi-profile; a profile
  selector remains, but the app no longer knows any profile names.

## Decisions already made

- `/etc/kandelo/demo.json` inside the image is the **only** authority
  for what a machine is.
- Its bytes come from a **tracked source file copied verbatim** into
  the image, generalizing the existing
  `packages/registry/shell/source-rootfs-shell-demo.json` pattern.
  For a single-source image, tracked source and baked artifact are
  byte-identical. Composed images are an explicit exception; see
  "Authority and artifact flow".
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
what runs.

### Byte-identity, and the one exception

For a **single-source image** — every image except the source-rootfs shell
image — the baked `/etc/kandelo/demo.json` is a byte-for-byte copy of one
tracked file, and a build check can assert that directly.

The **source-rootfs shell image is composed**, and cannot satisfy
byte-identity. Its `demo.json` is a deterministic merge of two tracked
files:

```
packages/registry/shell/source-rootfs-shell-demo.json          (package-owned base)
packages/registry/shell/source-rootfs-shell-demo-profiles.json (image-owned overlay)
        |
        +-- composeSourceRootfsDemoConfig --> /etc/kandelo/demo.json
```

The composed output is a superset of both inputs, so no single tracked
file's bytes are ever baked for it. The property that holds instead is
**deterministic re-derivation**: the merge is a pure function of two
reviewed files, the overlay may declare only `version` and `profiles`
(the builder rejects any other top-level key), and an overlay profile
that also exists in the base must match it structurally. Every byte of
the composed result is therefore traceable to a reviewed source.

A baked-equals-tracked check must apply the byte comparison to
single-source images only, and must not report success for a composed
image it cannot compare. That check is not implemented yet; see the
known gap recorded in the Plan 1 file.

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
                "packages": ["dinit@local", "nginx@local", "..."] },
  "runtime":  { "features": [],
                "requests": { "memoryPages": 16384, "maxWorkers": 24 } },
  "init":     { "target": "nginx" },
  "web":      { "requiredPorts": [8080, 9000], "probeHttp": true,
                "probePath": "/..." }
}
```

Every block above belongs to a profile: `version`, `defaultProfile`, and
`profiles` are the only top-level keys, and a machine block declared at the
top level is rejected. See "Schema revisions (2026-09-23)".

### demo.json selects; the image configures

`init` names what already exists inside the image — never a command
vector supplied from outside it. `demo.json`'s job is choosing which
image-owned thing to bring up, not describing how to run it. Two shapes
say this, because "run something inside a service manager" and "boot
one program directly" are both legitimate POSIX ways for a machine to
start:

- **`{ target }`** — a **target**, not a command vector. The image's
  real init configuration already lives at `/etc/dinit.d/<name>`, and
  this only selects which dinit target to bring up. This is the shape
  every dinit-based service demo uses (nginx, nginx-php, the
  wordpress-* family) — they happen to share one launcher,
  `dinit --container <target>`, and differ only in which target and
  which image.
- **`{ program, args?, cwd?, uid, gid }`** — exec a program from the image
  directly as pid 1, no service manager involved. `program` must be an
  absolute, normalized path (validated the same way as
  `ingest.targetPath`), and it is validated against the image the same
  way: it names something that must already exist inside the image,
  never bytes or a path carried by a boot descriptor/URL. This is why
  it does not weaken the "boot identity is never URL-carried" trust
  rule — a program path is exactly as image-owned as a dinit target
  name; what the rule forbids is a command vector supplied from
  *outside* the image, not a reference to image content.

  This shape exists because dinit is not free: it is ~2.4 MB of service
  manager, real for a lean image with one long-running process and no
  supervision need. `images/vfs/products/browser-ruby-todo.toml`
  deliberately ships no dinit tree at all
  (`images/vfs/scripts/build-ruby-todo-vfs-image.ts`) and boots its
  Ruby server directly as init. Forcing that image to grow a dinit tree
  and a one-service target just to satisfy a "name a target" schema
  shape would be the tail wagging the dog.

  `uid` and `gid` are required, not defaulted — see "Schema revisions
  (2026-09-23)".
- **`{ shellCommand }`** — a command line run in the machine's login shell
  after boot, added in the 2026-09-23 revisions as the third arm of this
  union (it used to live in `presentation.autoCommand`).

  The three shapes are mutually exclusive — declaring two in one `init`
  block is a validation error.

This is not a simplification for its own sake — the duplication is
already in the tree. `addDinitInit` bakes `/sbin/dinit`,
`/sbin/dinitctl`, `/etc/dinit.d/boot`, and `/etc/dinit.d/<name>` into
every dinit-based service image
(`images/vfs/scripts/dinit-image-helpers.ts:388-440`). Consequences:

- **`init.argv` is a target selector in disguise, for the four dinit
  demos.** nginx, nginx-php, wordpress-sqlite, and wordpress-mariadb
  share one `DINIT_NGINX_ARGV`; they differ only by which service is
  the container target and which image they run in. ruby-todo is the
  exception this generalization missed on the first pass: it has
  always booted a program directly, never a dinit target, which is why
  it needed the second `init` shape rather than being forced into the
  first.
- **`REQUIRED_DINIT_SERVICES` duplicates the image.**
  `/etc/dinit.d/boot` is a dependency aggregator naming every service,
  so the readiness service list (`dinit-boot-status.ts:13`) was a
  hand-maintained copy of something the image already states.
  `readDinitBootTargets` (`web-libs/kandelo-session/src/dinit-boot-targets.ts`)
  derives it from the image instead.
- **Process identity and environment are already POSIX-shaped.** dinit
  services carry their own uid and env per service (a shared
  `env-file` at `/etc/dinit.d/env`, see `dinit-image-helpers.ts`);
  `/usr/bin/login -p -f maker` establishes shell identity (already what
  `images/vfs/products/browser-main-shell.toml` declares); and
  `/etc/profile.d` is already in use by the node image
  (`build-node-zip.ts:68`) and now the base shell image too
  (`shell-lazy-archives.ts`'s `registerDemoShellProfile`). So
  `SHELL_PROFILES`, `NODE_SHELL_ENV`, `SERVICE_ENV`, and
  `INIT_ENV_PROFILES` moved into the image's own profile scripts and
  dinit env-files, not into `demo.json`. The one exception is
  WordPress's `WP_APP_PATH`/`WP_PROTO`: those are computed from the
  page's own deployment prefix and protocol at boot time, so no image
  artifact baked ahead of time can know them — they stay host-supplied.

A profile with no `init` block boots the image's default login session.

What stays in `demo.json` is selection and presentation: which target
or program, which panes, which guide, what the listing shows. What
moves into the image is configuration: service definitions,
environment, identity. A third-party image then configures init the
ordinary way — either a real dinit tree, or a direct pid-1 program —
rather than learning a Kandelo-browser-specific JSON dialect.

`web.requiredPorts`, `probeHttp`, and `probePath` stay in `demo.json`
deliberately: they tell the *host UI* when to flip the web pane to
ready. That is a presentation concern, not init configuration, and
deriving ports would mean parsing `nginx.conf`.

The image also declares `defaultProfile`, replacing
`DEFAULT_DEMO_FOR_VFS_IMAGE`.

There is no `aliases` field. `?demo=` is removed outright rather than
deprecated, so the old spellings in `DEMO_ALIASES` have no consumer to
serve. Two of the three are not lost anyway: the images already declare
both spellings as real profiles — `build-wp-vfs-image.ts:434-437` emits
`wordpress-sqlite` *and* `wordpress`, `build-lamp-vfs-image.ts:500-502`
emits `wordpress-mariadb` *and* `lamp`. Only `spidermonkey` /
`spidermonkey-node` disappear, and they disappear with the parameter
that referenced them.

### Boot-time init is image-owned, without exception

The machine's init — argv, env, cwd, uid, gid, and the init program's
bytes — comes from the image and from nowhere else. Two paths violate
this today and both are closed by this work.

**The init binary is fetched from the page origin, over one the image
already has.** `live-setup.ts:140` imports `dinit.wasm?url` from the repo
binary graph, and `:1436-1443` fetches it and `writeVfsBinary`s it into
the image at `profile.init.argv[0]` during staging — but
`addDinitInit` already baked `/sbin/dinit` into that image at build time
(`dinit-image-helpers.ts:423`, `installDinitBinariesUnlessInherited`).
So this is not merely init arriving from outside the image; it is a
page-origin binary silently overwriting the one the image shipped,
which is precisely the stale-artifact class the ABI contract says must
fail loudly rather than be papered over.

The platform already half-knows this: the fetch is suppressed whenever
`CANONICAL_PAGES_VFS_LOADER` is defined (`:1004`, `:1035`,
`:1088-1090`), with the comment "Canonical Pages products own their
complete executable closure just like an explicit VFS descriptor does."
This work makes that unconditional — `programUrl` and the staging fetch
are deleted outright. An image whose init binary the host injects at
boot is not self-describing and cannot be booted by a third party from
`?vfs=` alone.

**A caller-supplied descriptor can replace init argv.**
`effectiveBoot` spreads `requestedDescriptor.boot` over the profile's
(`:1287-1294`), and init spawns `effectiveBoot.argv.length > 0 ?
effectiveBoot.argv : profile.init.argv` (`:1646-1647`) — so a descriptor
supplied by the caller replaces what the machine runs as pid 1,
including its uid.

This **is reachable from URL-carried state today**, through the
paste-a-link path rather than page load. At page load a `#k1=` fragment
contributes only `boot.inputs` and `boot.parameters` (`:752-767`). But
`app/NewMachinePane.tsx:34-39` and `views/EmptyState.tsx:44-50` take a
pasted URL or fragment, `decodeBootDescriptor` it, and hand the **whole
decoded descriptor** to `applyBootDescriptor` → `startBoot` → the
`effectiveBoot` merge. `validateBootDescriptor` checks `boot.argv`'s
shape only (`boot-descriptor.ts:643`), not policy. So a pasted link can
choose what runs as the machine's init, and as which uid.

Blast radius is the visitor's own ephemeral tab, the same bound the
auto-run script rule rests on, so this is a design defect to close
rather than an incident. But it is exactly "boot-time init from outside
the image," and it is live.

**The rule, with no exception: nothing outside the image supplies boot
identity.** Not a pasted link, not a query parameter, not the app. A
link may carry which image to boot (`mounts`) and its script
(`boot.inputs`, `boot.parameters`); `argv`, `cwd`, `uid`, `gid`, and
`env` come from the image.

There is no in-app override to preserve. `views/Config.tsx` exposes
editable `argv`/`cwd`/`uid`/`gid`/`env` fields, but the file has **no
importers** — it is unreferenced dead UI, in the same state
`ShareDialog` and `LiveUrlBar` were in before the script-links work
wired them up. Users cannot tweak boot argv today, and this design does
not start letting them.

### Incoming boot identity is ignored, not rejected

Rejecting a descriptor that carries `boot.argv` would break every link
already shared: `ShareDialog` builds its payload as
`{...baseDescriptor, boot: {...baseDescriptor.boot, inputs, parameters}}`,
so the spread carries the authoring machine's full boot block —
`argv`, `cwd`, `env`, `uid`, `gid` — into every link it has ever
produced.

So incoming boot identity is **ignored with a visible log line**, not
rejected, and `ShareDialog` stops emitting it. Ignoring keeps existing
links booting; the log line keeps the drop truthful rather than silent.

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

**Resolved 2026-09-23 by removal.** `runtime.network` is gone from the
schema, and `descriptorForMachine` emits neither `caps` nor the
`tcp-bridge` feature. Documenting an inert field as inert still leaves it
in every third-party image's vocabulary; deleting it means the first image
to need a real network capability gets a field that gates something.
Whether the guest socket path should be gated remains open, and remains
out of scope here.

## Schema revisions (2026-09-23)

A review of the landed schema removed four fields, moved one, and tightened
one. The project is pre-release, so these are breaking changes to the
schema made outright rather than deprecated.

1. **`js-workers` removed from `runtime.features`.** It had no consumer:
   its only appearances were the type, the validator allow-list, one test,
   and `node-demo.json` declaring it. It used to render as a capability
   badge in a System Config pane that no longer exists. `framebuffer`,
   `kms`, and `evdev-input` stay — each changes what the host does.
2. **`runtime.network` removed.** See "Known-inert capability flag".
3. **`presentation.autoCommand` moved to `init.shellCommand`.** All three
   "what runs here" forms — a dinit target, a pid-1 program, a login-shell
   command — are now arms of one union, so a machine cannot say two
   different things at once by construction. The cross-block validation
   rule that used to enforce this (and the resolved-pair rule that had to
   compensate for top-level fallback) are deleted with it.
4. **`init.program` requires `uid` and `gid`.** Not optional with a
   default: 0 would hand root to any third-party image that omitted them,
   and 1000 would invent an account convention the image may not share.
   Requiring them puts the privilege in the reviewed file. `ruby-todo` —
   the only user of this shape — moved from root to uid/gid 1000, matching
   `images/vfs/products/browser-ruby-todo.toml`'s `[boot]`; the Roda app
   needs no root (its SQLite database defaults into `/tmp`, mode 1777, it
   binds the unprivileged port 8080, and `/var/lib/todo` is world-readable).
   The host derives pid 1's `HOME`/`USER`/`LOGNAME` from the declared uid
   for the accounts it knows by construction (0 and the `maker` demo
   account), and states none for any other uid rather than guessing.
5. **`identity.base` removed.** Nothing validated the declared string, and
   its two consumers already fell back to `kandelo:shell@abi${ABI_VERSION}`
   — so the app now simply computes it. Real ABI compatibility is enforced
   by the strict `__abi_version` check on binaries, and ten tracked files
   no longer have to be edited on every ABI bump. The tracked-parity test's
   ABI assertion was removed rather than left with no subject.
6. **The schema is profile-only.** Every profile field could also be
   declared at the top level, with each `resolveDemoX(config, id)` falling
   back to `config.X`. No tracked file used it, it doubled the lookup
   surface, and independent per-block fallback was the sole cause of a real
   bug (a profile's `init` resolving alongside a top-level
   `presentation.autoCommand`, which a same-record check cannot see).
   `version`, `defaultProfile`, and `profiles` stay at the top level;
   anything else there is rejected by name. The near-miss key checker
   (`scripts/check-image-demo-config.ts`) scans one shape instead of two.

## Future work: a generic web form action

`DemoActionKind` includes `web.wordpressLogin`, consumed at
`apps/browser-demos/pages/kandelo/views/MachineView.tsx` via
`preview.loginToWordPress(...)` and declared four times across
`wordpress-demo.json` and `lamp-demo.json`. It is one application's login
flow enshrined in a generic schema: the host knows WordPress's form field
names and submit button, so no other image with a login form can express
itself here.

The login feature stays. The replacement is a generic `web.formFill`-style
action whose payload carries what the form needs and nothing
WordPress-specific:

- the form's URL (resolved against the machine's web preview origin, the
  same way `web.probePath` already is),
- the field values to fill, as selector/name → value,
- the submit selector.

That data is legitimately image-owned: an application knows its own login
form, and a third-party image gets the same capability WordPress has
instead of a kind named after someone else's product. The host contributes
only the mechanics — focus the preview, fill, submit — with no knowledge of
which application it is driving.

Not implemented here. Until it lands, `web.wordpressLogin` remains the one
application-specific action kind in the schema, and the comment at the
`DemoActionKind` union in `web-libs/kandelo-session/src/demo-config.ts`
says so and points at this section.

## Input attachment

`sdl2` and `evdev` cannot use a plain shell command today because
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

Attach happens before the machine's command, as a defined step. This
collapses the `framebufferTest → sdl2 → espeak → evdev → runScript →
autoCommand` else-if ladder into: attach input if declared, then run the
command.

### Display dimensions

The `SDL2_FB_W/H = 1920/1080` constants at `live-setup.ts:1731` are the
app guessing what the guest will allocate; the adjacent comment claiming
they match `host/src/dri/kms-registry.ts` is stale — that file holds no
such constant.

The viewport is the browser window. An image may declare **minimum**
display dimensions in `runtime.display`, and nothing more: the actual
size tracks the window, as the evdev path already does via
`window.innerWidth/innerHeight` with `onResize → setInputCanvasDims`.
The declared minimum is a floor a machine can state, not a size it gets
to impose on the visitor's window. The hardcoded 1920×1080 pair is
deleted.

## Precedence

When a `#k1=` link carries `runScript` and the image declares
`init.shellCommand`, the link's script wins — matching today's ladder — but
the host logs a visible line ("boot-link script replaces the machine's
configured command") rather than silently dropping the image's command.

## Trust boundary

First-party and third-party images use one schema and one code path,
but carry different trust:

- A first-party `demo.json` is reviewed in-repo, and for a single-source
  image it is byte-identical to the baked artifact (see "Byte-identity,
  and the one exception").
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
  per-profile env constants — these move into the image's own
  `/etc/profile.d` and dinit service definitions, not into `demo.json`
- `REQUIRED_DINIT_SERVICES` (`dinit-boot-status.ts:13`), derived instead
  from the image's `/etc/dinit.d/boot` dependency list
- `stageSdl2Runtime`, `stageEspeakRuntime`, `stageEvdevDemo` — their
  binaries and shader presets move into the image builder, since an
  image whose programs the host injects at boot is not self-describing
- `programUrl`, the `dinit.wasm?url` import, and the init-binary staging
  fetch at `live-setup.ts:1436-1443`
- the `effectiveBoot` merge of caller-supplied boot identity, replaced
  by reading `argv`/`cwd`/`uid`/`gid`/`env` from the image only
- `descriptorFromGalleryItem`'s `boot.argv` assignment, since roster
  entries carry membership only and no boot command
- `views/Config.tsx` in its entirety, plus its 49 `kcfg-` rules in
  `styles.css`. The file has no importers and no test coverage; its
  Boot tab edits init identity this design forbids, and its other four
  tabs (Mounts, Runtime, Capabilities, Trust) are unreachable dead UI
  that can be rebuilt against the new contract if wanted
- `ShareDialog`'s emission of the authoring machine's boot block
- the `?demo=` parameter, `SDL2_FB_W`/`SDL2_FB_H`, and the stale comment
  claiming they match `kms-registry.ts`

The image-URL fragment channel is explicitly **not** deleted; see "Two
profile channels, both kept".
- `customVfsProfile`, which ceases to exist as a distinct path

## Phasing

Each phase lands green on its own. Phase order is chosen so the schema
and its validation exist before any consumer depends on them, and so the
app's id tables are deleted only once nothing reads them.

1. **Schema + validation.** Extend `demo-config.ts` with `identity`,
   `runtime`, `init`, `web`, `defaultProfile`. Add a checker over the
   tracked sources. No consumers yet. The
   tracked-source-equals-baked-bytes comparison does NOT land here: no
   image is built in Phase 1 and the comparison needs TypeScript-only
   image helpers; it moves to Phase 2, and applies to single-source
   images only.
2. **Tracked sources.** Convert all nine builders from programmatic
   `writeKandeloDemoConfig({...})` to verbatim tracked JSON. Retire
   `images/vfs/scripts/kandelo-demo-guides.ts` (a nine-line re-export of
   the app module) so build-time content and runtime fallback stop
   sharing one file.

2b. **Init configuration into the image.** Move the app's shell and
   service environments into `/etc/profile.d` and dinit service
   definitions, so `demo.json`'s `init` block reduces to a target name.
   This precedes the app cutover deliberately: baking an `init.argv`
   into nine tracked files and migrating it afterwards would ship the
   wrong schema shape to any third party who adopts it first.
3. **Binaries into images.** Bake `sdl2`, `evdev_demo`, `espeak-ng` plus
   shader presets into the shell image, and `dinit` into every image
   whose profile declares it as init; delete the three staging functions
   and the `programUrl` fetch. After this phase no image depends on the
   host injecting an executable at boot.
4. **Roster + availability.** Introduce the roster file and the
   three-state listing; derive the gallery from tracked sources.
5. **App cutover.** Read `demo.json` for everything; delete the tables
   in "What gets deleted"; collapse the boot ladder; add the
   `&profile=` selector and **remove `?demo=` outright**. No alias, no
   deprecation window. An unrecognized parameter is an error, not a
   silent fallback to `shell`.
6. **Test migration.** Move the ~14 Playwright specs off `?demo=`.
   Because the parameter is removed rather than aliased, this phase is
   not optional cleanup — it lands with phase 5 or the suite is red.
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

## Resolved during design

1. **Display dimensions** — images declare a *minimum* only; the
   viewport is the browser window.
2. **`runScript` vs `autoCommand`** — the link's script wins, with a
   visible log line.
3. **`?demo=`** — removed now, not deprecated. No alias.
4. **`sdl2`** — ships in the gallery. Its absence from
   `pages-vfs-product-gallery.json` was drift, and the roster includes
   it; phase 3 bakes its binary and shader presets into the shell image,
   which is what makes the Pages product able to serve it.
5. **`views/Config.tsx`** — deleted entirely, with its CSS.

### What removing `?demo=` costs existing links

Links in the wild degrade rather than break. `galleryItemUrl` writes
*both* parameters (`url-state.ts:52-53`), so a shared link already
carries `?vfs=` with the image URL; dropping `?demo=` means such a link
still resolves its image and boots the image's declared default profile
instead of the linked one. For single-profile images that is the same
machine. For the shell image a `?demo=doom` link lands on `shell`.

### Two profile channels, both kept

The image URL's own fragment carries a profile:
`vfsImageUrlForPreset` sets `url.hash = liveId`, and
`liveDemoIdForVfsImageUrl` reads it back. **This stays**, with
`&profile=` as an explicit override.

That precedence is already what the code does —
`normalizeDemoId(demo) ?? fragmentDemo` (`live-setup.ts:2595`), query
param first, fragment as fallback — so this is documenting and keeping
existing behavior, not adding a channel.

It is also the right shape rather than a workaround:

- A fragment is a client-side view selector on a resource, not part of
  its identity. "Which profile of this image" is precisely that. The
  code already says so: *"Fragments describe launch behavior, not file
  identity, so they are ignored here"* (`url-state.ts:131`), and
  `matchTrustedVfsSourceId` strips it via `withoutUrlHash` before
  comparing.
- It makes an image URL **self-describing on its own**, which serves the
  third-party parity goal directly. A stranger can publish
  `https://cdn/mine.vfs.zst#editor` and that single URL names a machine,
  instead of having to say "paste this, and also add `&profile=editor`".
- URL identity is already fragment-safe on both paths
  (`url-state.ts:150`, `:208`), fragments never reach the network, and
  Cache API matching excludes them.

An earlier draft of this spec proposed retiring the fragment channel as
"special naming in a less visible place." That was wrong. The problem
this work removes is the *app holding a hardcoded id table*, not the
channel an id travels on. Once profile ids come from the image, a
fragment-borne id is no more special than a query-borne one.

One rough edge to handle rather than inherit: a hand-written
`?vfs=https://cdn/shell.vfs.zst#doom` with the `#` left unencoded parses
as `vfs=…shell.vfs.zst` plus a *page* fragment `#doom`. That is not
dangerous — `decodeBootDescriptor` returns `null` for anything that is
not `k1=` (`boot-descriptor.ts:720`) — but the profile is silently
dropped and the machine boots its default. When the two channels are
both present and disagree, or when a page fragment is present but is
not a `k1=` envelope, the host logs it rather than resolving in
silence.

## Open questions

None. `docs/browser-support.md:608` documents `?demo=<id>#k1=<payload>`
as the shared-link form and must be updated by phase 5.
