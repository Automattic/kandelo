# Partial image builds — design

Date: 2026-11-07
Status: draft for maintainer review

## Why

Every worktree today pays for the full canonical shell. The `shell`
package (`packages/registry/shell/package.toml`) depends on about 55
packages: PHP, MariaDB, Qt/Quickshell, FFmpeg, ScummVM, the language
bundles, and more. The browser app statically imports
`shell.vfs.zst`, and `./run.sh browser`, `./run.sh setup` and
`./run.sh local-build` all build the "demanded" closure, which always
includes that whole shell. LAMP, WordPress, the nginx variants and the
web-stack/wordpress-family images embed the shell
(`[[composition.product]] id = "browser-main-shell"`), so testing any
of them also costs the whole shell.

That makes each new worktree slow and expensive for the maintainer and
for agents, and it makes contributing hard: a newcomer must build
everything before trying anything.

A **partial image build** lets a developer pick one product image and
name the packages they are working on. They get that image composed
from a small base plus only those packages, and can boot it in the
browser and Node right away. The full build becomes the final
integration check instead of the price of admission.

## Goals

1. One command builds a partial image: choose an image, name packages.
2. A partial image contains:
   - the image's **assumed components**: its own required software
     from its product definition (e.g. LAMP: nginx, php, mariadb,
     dinit, msmtpd);
   - wherever the image embeds the shell, a **base shell** in place of
     the full one. The base shell is the `rootfs` package as it is
     today (all 20 packages, unchanged);
   - the **named packages** plus their resolver dependencies, each
     installed with exactly the role it already has in the canonical
     shell's dependency contract
     (`packages/registry/shell/source-rootfs-shell-dependencies.json`:
     `lazy-file`, `lazy-archive`, `eager-file`, `eager-program`).
3. The only output is that image. Member packages come from the normal
   on-disk build cache (shared as usual).
4. The browser app shows the partial image as **its own gallery
   entry**, alongside whatever canonical images happen to be built.
5. The partial image's activity list contains **only activities whose
   packages are in the image**. Others are not listed at all — not
   greyed out, not hidden behind a toggle.
6. The browser **never serves a partial image (or its lazy members)
   from the service-worker cache.** A rebuild is always what the next
   boot sees.
7. Saved browser state for the partial machine **resets when the image
   is rebuilt**, and persists across reloads otherwise.
8. Node can boot the same partial image (smoke runner and Vitest).
9. Test fixtures (`scripts/build-programs.sh`) are **skipped by
   default**. A flag adds the package-owned tests
   (`packages/registry/<pkg>/test/`) for the named packages.
10. Docs and porting guidance make "port and test against a partial
    image first, full build last" the recommended workflow.

## Non-goals

- Reducing kernel, sysroot, or fork-instrumentation build cost. Those
  still build per worktree.
- CI use. This is a local developer/contributor tool for now. Don't
  make CI adoption gratuitously hard, but don't design for it.
- New package roles. A package with no role in the canonical shell
  contract cannot go into a partial image (see "Declare first").
- Trimming the base. The base is `rootfs` as-is; a partial image never
  removes base packages.
- Several partial images per worktree. **One at a time**: building a
  new partial image replaces the previous one.

## Anti-goals (failure even if it "works")

- **Weakening the canonical build.** The canonical shell composer's
  completeness validators (`requireCompleteProductShellContract`,
  `requireLazyShellData`, the exact-profile check in
  `composeSourceRootfsDemoConfig`, `requireOwnedDemoCommands`,
  `requireScummvmFreewareMenu`) must stay exactly as strict for the
  canonical shell. Partial mode is a separate, explicit mode; it must
  not become a silent fallback when something is missing.
- **A partial image mistaken for a canonical one.** It never lands at
  `shell.vfs.zst` or any canonical product path, never gets a canonical
  product ID, is never published or released, and never counts as
  `[evidence]` for a canonical product.
- **Listing an activity that cannot run.** Every activity in a partial
  image must have its executables and data present — checked at build
  time, the same way the canonical build checks.
- **Package-specific special cases.** Partial composition must come
  from data the packages and contract already declare, not per-package
  branches in the composer.
- **Stale state presented as fresh.** A rebuilt image must not boot on
  top of the previous image's OPFS copy.

## Constraints and current state

These are the facts the design rests on (from reading the code on
2026-11-07; line numbers will drift).

**Shell composition** — `build-shell.sh` →
`images/vfs/scripts/build-source-rootfs-shell-image.ts`
(`buildSourceRootfsShellImage`). What goes into the image is decided
mostly by TypeScript tables, not the JSON contract:
`SHELL_LAZY_BINARY_SPECS` (`images/vfs/lib/init/shell-binaries.ts`),
`SHELL_LAZY_ARCHIVE_SPECS` / `SHELL_LAZY_DATA_ARCHIVE_SPECS`
(`shell-lazy-archives.ts`), `SHELL_SESSION_PACKAGES`
(`package-session-files.ts`), the overlay
(`source-rootfs-shell-overlay.ts`), and many hard-coded extras in
`buildSourceRootfsShellImage` (desktop sessions, game wrappers,
exchange rules, terminfo, NetHack, SDL2 presets).
`build-shell.sh` also hard-requires rootfs, bash, wayland-demo,
espeak-ng and ca-certificates. `SOURCE_ROOTFS_SHELL_EXTENDED_DEPENDENCIES`
is computed from a hard-coded contract path at module load.

**Package identity** — `shell/package.toml` `depends_on` must equal the
JSON contract exactly, and editing `packages/registry/` while a build
runs fails the run. A partial build therefore needs a *generated*
package definition outside the tracked registry.
`WASM_POSIX_DEPS_REGISTRY` (`docs/package-management.md`, "Registry
search path") already supports extra registry roots.

**Derived images** — LAMP and others read the shell via
`$WASM_POSIX_DEP_SHELL_DIR/shell.vfs.zst` or `resolveVfsArtifact`, and
`loadShellBaseFileSystemFromImage` requires the `shellComposition`
metadata marker and a terminal session. `build-image-families.ts`
loads its members the same way.

**Selection** — `tools/xtask/src/local_build.rs` already builds a single
package or product closure (`Selection::Package`, `xtask local-build
run --product`). The default "demanded" set always includes the full
`shell` because the browser imports it.

**Activities** — runtime activities come from the image's own
`/etc/kandelo/demo.json` (written by the composer;
`host.imageActivities.list` maps every profile). So filtering at build
time filters what the browser shows. `identity.packages` on profiles
is free display text and does **not** match resolver names
(`fbdoom@local`, `node@local`, `npm@10.9.2`; the sdl2/wayland/omarchy
profiles list only bash and coreutils), so it cannot drive filtering.

**Browser** — products are hard-coded in
`apps/browser-demos/.../kernel-host/live-setup.ts` (`PagesVfsProductId`,
`VFS_PRODUCTS`), the roster `gallery-roster.json`, the registries
`pages-vfs-products.toml` / `pages-vfs-product-gallery.json` (with a
parity checker, `scripts/check-pages-vfs-product-registry.mjs`), and
`TRACKED_DEMO_CONFIG_BY_PRODUCT`. Gallery listing metadata comes from
tracked JSON, not the built image. The app statically imports
`@binaries/programs/wasm32/shell.vfs.zst` (in `live-setup.ts` and
`app/App.tsx`), and the `@binaries` Vite plugin errors if it is
missing.

**Service worker** — whole `.vfs.zst` images are not cache-first today;
lazy group members under `vfs-groups/` are (`LAZY_ASSET_CACHE`). In dev,
lazy members come from the `@kandelo-lazy/assets/` route. The durable
"cache" that matters is the per-computer OPFS copy.

**Persistence** — computers are UUID-keyed; the filesystem lives in
OPFS at `kandelo/computers/<id>/filesystem`; the base image is copied
in on first boot and never re-downloaded. `persistenceIdentity()` binds
saved state to `{vfsUrl, profileId, ...}`. There is no
"reset when the image changes" mechanism: a rebuilt image at the same
URL silently keeps the old copy.

**Node/Vitest** — no env var selects the shell image. Tests use
`tryResolveBinary("programs/wasm32/shell.vfs.zst")` or a hard-coded
`local-binaries/source-only-v1/...` path and assume full contents.
`scripts/source-rootfs-shell-node-smoke.ts --image <path>` can boot an
arbitrary shell image.

**Fixtures** — `build-programs.sh` fixtures have no package mapping
(it only excludes package-owned paths). Package-owned tests live in
`packages/registry/<pkg>/test/*.test.ts`, run by the host Vitest
config, and mostly resolve package outputs directly (one,
`ruby/test/posix-spawn.test.ts`, uses a `build-programs.sh` fixture).

## Design decisions (maintainer's)

- Applies to **any product image**, not just the shell. Assumed
  components + base shell (where the shell is embedded) + named
  packages.
- Base = **`rootfs` as-is**.
- **Declare first**: a named package must already have a role in the
  canonical shell contract. Porting step 1 is adding that entry. The
  partial builder refuses a package with no role, naming the file to
  edit.
- "Never cached" means **never in the browser / service-worker cache**.
  The on-disk build cache is fine.
- **Own gallery entry**, alongside whatever else is built.
- Activities for absent packages are **not included or shown**.
- **One partial image at a time** per worktree.
- Browser saved state **resets on rebuild**.
- Host coverage: **browser and Node/Vitest**.
- Fixtures **skipped by default**; flag to include the named packages'
  package-owned tests.
- **Local only**; CI unchanged.
- Docs and porting guidance lead with the partial workflow.

## Design

### 1. Command

`./run.sh partial <image> <pkg>... [--with-tests]` (name is the
builder's call; see "Left to the builder").

- `<image>` is a product ID or short alias for an image that embeds
  the shell (`shell`, `lamp`, `wordpress`, `nginx-php`, ...; see
  "Calls made by the designer" 1). Unknown or shell-less → error
  listing the valid images.
- `<pkg>` names are resolver package names. Each must have a role in the
  canonical shell contract, or be one of the image's own assumed
  components (a no-op). Otherwise: error naming the three places a
  canonical shell entry lives (see "Calls made by the designer" 3).
- Runs under `scripts/dev-shell.sh` like every other build front door.
- Builds only: the sysroots/kernel as today, the base `rootfs` closure,
  the image's assumed components, the named packages' closures, and the
  partial image. It does **not** run the "demanded" closure,
  `build-programs.sh`, or any other product.
- Writes a small, gitignored **partial manifest** recording image,
  named packages, resolved package set, included activity IDs, the
  image's sha256, and build time. This is the single source of truth
  the browser and Node read. Building again overwrites it (one at a
  time).
- Prints where the image landed and how to boot it in the browser and
  in Node.

### 2. Generated package definitions

The partial shell and each partial derived image are **generated
packages in a gitignored overlay registry root**, wired through
`WASM_POSIX_DEPS_REGISTRY`, so the tracked `packages/registry/` is never
edited during a build and the normal resolver/cache path is used.

- `shell-partial`: `depends_on` = `rootfs` + named packages (+ the
  shell's unconditional infrastructure that the composer genuinely
  needs — see §3). Output: a distinct file name, never `shell.vfs.zst`.
- For a derived image (e.g. LAMP): `<image>-partial` depends on
  `shell-partial` + that image's assumed components, and its build feeds
  the partial shell in where the canonical builder reads
  `WASM_POSIX_DEP_SHELL_DIR` / `resolveVfsArtifact("programs/shell.vfs.zst")`.
  The derived builders get an explicit input for the base shell file
  name rather than assuming `shell.vfs.zst`.

Cache keys come from the generated definitions like any package, so an
unchanged partial selection reuses the on-disk cache, and changing the
named list re-keys only the partial image(s).

### 3. Composer: an explicit partial mode

`buildSourceRootfsShellImage` gains an explicit **selection**: the set
of packages present. Canonical mode = the full contract (today's
behavior, byte-identical output). Partial mode = `rootfs` + named
closure.

- Every image-content table (`SHELL_LAZY_BINARY_SPECS`, lazy archive
  and data-archive specs, session packages, overlay steps, hard-coded
  extras like game wrappers, desktop sessions, terminfo, NetHack setup,
  SDL2 presets, exchange rules) is keyed by **owning package**, and
  partial mode applies only entries whose owner is selected. Where an
  entry today isn't attributable to a package, the builder attributes
  it; that attribution becomes data, not a branch.
- Completeness validators run in both modes **relative to the
  selection**: in partial mode, every spec owned by a selected package
  must be present, and no spec owned by an unselected package may be.
  In canonical mode the selection is the full contract, so they enforce
  exactly what they enforce today.
- `build-shell.sh`'s hard-required inputs (bash, wayland-demo,
  espeak-ng, ca-certificates) become: required if the composer
  genuinely needs them for every shell (e.g. ca-certificates for TLS),
  otherwise governed by selection. The builder decides which are truly
  infrastructure and documents why.
- The image keeps the `shellComposition` marker and terminal session so
  derived builders accept it, and records `partial: true` plus the
  selection in its composition metadata.

### 4. Activities: a real `requires` field

Add a `requires` list of **resolver package names** to each shell demo
profile (in `source-rootfs-shell-demo.json` / `-demo-profiles.json`).
`identity.packages` stays as display text.

- The canonical build validates that every `requires` entry is in the
  shell contract, and that each profile's executables (the ones
  `requireOwnedDemoCommands` already checks) are owned by its required
  packages. This keeps `requires` honest.
- Partial mode writes `/etc/kandelo/demo.json` with only profiles whose
  `requires` ⊆ the selection, then runs `requireOwnedDemoCommands` on
  that filtered set. Activities not included are absent from demo.json,
  so the browser never lists them.
- Derived images' own demo configs (`writeTrackedDemoConfig`) are
  filtered the same way where they reference shell activities.

### 5. Browser: own entry, no full-shell requirement

- A single new product, **`partial`**, with its own gallery entry.
  Label from the manifest, e.g. "Partial LAMP + tmux, less". Listing
  metadata (title, activities) comes from the **built image's
  demo.json / the partial manifest**, not tracked JSON.
- The app must **start without the full `shell.vfs.zst`**. The static
  import becomes optional, like other optional products; when the
  canonical shell isn't built, its entry shows the existing honest
  missing-product state. The registries/parity checker learn about the
  `partial` product.
- `./run.sh browser` gets a mode that serves what is built (partial
  image plus any canonical images present) **without** first building
  the demanded closure. Default `./run.sh browser` behavior for
  full-build users is unchanged.
- The partial entry appears only when a partial manifest exists.

### 6. Never cached by the browser

- The partial image URL is served by the dev server with
  `Cache-Control: no-store` and a URL that changes per build (e.g. the
  sha256 from the manifest).
- The service worker explicitly passes partial-image requests and their
  lazy members straight to the network and never writes them into
  `LAZY_ASSET_CACHE` or any Cache Storage, even in a grouped deployment
  layout.
- A browser test asserts: after a rebuild, the next boot reads the new
  bytes, and Cache Storage holds no partial-image entries.

### 7. Saved state resets on rebuild

- The partial machine's persistence identity includes the image's
  sha256 from the manifest.
- On boot, if the saved computer's identity differs only by that
  sha256, the OPFS filesystem copy is **discarded and re-seeded** from
  the new image, and the UI says so ("Partial image rebuilt — saved
  state reset"). Reloads without a rebuild keep state.
- Canonical machines keep today's behavior.

### 8. Node and Vitest

- `scripts/source-rootfs-shell-node-smoke.ts --image <partial>` boots
  it; `./run.sh partial` prints that command.
- Add an explicit selector (env var, e.g. `KANDELO_PARTIAL_IMAGE`, or
  read the manifest) for tests that are written to run against "the
  image under test". Existing tests that assume the full shell keep
  resolving `shell.vfs.zst` and must **not** silently pick up a partial
  image; they skip as they do today when it's absent.
- `--with-tests` runs the package-owned Vitest files for the named
  packages (`packages/registry/<pkg>/test/**`). If one of those needs a
  `build-programs.sh` fixture (today: `ruby/test/posix-spawn.test.ts`),
  the run builds just what it needs or reports the missing fixture
  plainly — the builder chooses, but it must not silently skip.

### 9. Documentation and guidance

Update, leading with the partial workflow and keeping the full build as
the integration step:

- `.claude/skills/porting-software-to-kandelo/SKILL.md` — "Build loop":
  declare the shell role → partial image → iterate → full build before
  PR.
- `docs/porting-guide.md` — "Adding a new package to the registry" →
  "4. Verify locally"; the lazy-archive "Registration" section (and fix
  the stale `build-shell-vfs-image.ts` reference).
- `docs/agent-guidance/validation.md` — "Preparing a fresh checkout or
  worktree": a partial path for iteration, and that a partial image is
  not evidence for canonical-image claims.
- `docs/agent-guidance/packages-and-builds.md` — "Image recipes outside
  the default build".
- `CONTRIBUTING.md` — "Build and rebuild" table and "Prepare to run
  tests"; `README.md` "Quick start" — point newcomers at the partial
  path.
- `docs/package-management.md` — "Local DAG build", "Current
  package-backed root and shell images", "Canonical VFS product
  authority".
- `docs/browser-support.md` — "Consumer-owned product selection",
  "Computer library and retention" (reset-on-rebuild).
- `docs/package-sessions.md` — "Activity catalog": the `requires`
  field.

## Contracts touched

- **Package/build** — generated overlay packages, selection in xtask,
  composer partial mode.
- **Images** — composer tables keyed by owning package; partial
  metadata.
- **Browser/user** — new product entry, optional full shell, service
  worker exemption, persistence reset.
- **Host runtime (Node)** — image selector for tests/smoke.
- **ABI** — none expected. VFS image metadata gains a `partial` marker;
  the builder confirms whether that metadata is ABI-bound
  (`docs/abi-versioning.md`) and bumps if so.

## Validation the builder should plan for

- Canonical shell composed before and after the change is
  **byte-identical** (proves partial mode didn't change canonical
  output).
- Partial shell with no named packages, and with a few (e.g.
  `tmux less`, `fbdoom`): builds; demo.json lists exactly the expected
  activities; each listed activity launches.
- Partial LAMP with one extra package boots in Node and the browser.
- Declare-first refusal message for an unregistered package.
- Browser tests for the service-worker exemption and reset-on-rebuild.
- A fresh-worktree timing comparison: `./run.sh partial shell tmux`
  vs `./run.sh setup` (reported as measured, not claimed).

## Calls made by the designer (check these)

These settle questions the conversation didn't cover. Each is marked
as the designer's call, not the maintainer's.

1. **Scope = images that embed the shell.** `shell`, `lamp`,
   `wordpress`, `nginx`, `nginx-php`, `nginx-python`, `web-stack`,
   `wordpress-family`. Images with no embedded shell (redis, python,
   perl, erlang, mariadb, ...) don't pay the shell cost and have nowhere
   to put shell-role packages; `./run.sh partial` rejects them with a
   message saying to build them normally.
2. **Nested images get the partial shell everywhere.** For
   `wordpress-family` / `web-stack`, every embedded member that embeds
   the shell is rebuilt as a generated `-partial` package on the same
   `shell-partial`; `build-image-families.ts` takes the partial members
   as input. The manifest records the top-level image's sha256 (that is
   what the browser boots and what triggers reset).
3. **"Declare first" means a complete canonical shell entry**: the
   `source-rootfs-shell-dependencies.json` role, the matching
   `shell/package.toml` `depends_on`, and the composer spec (lazy
   binary / archive table entry) the canonical shell needs to install
   it. In other words, the package is already in the canonical shell.
   The refusal message names all three places. The JSON is not made
   authoritative and no generic role-only installer is added.
4. **"Byte-identical" allows exactly one difference**: the canonical
   `/etc/kandelo/demo.json` gains the new `requires` fields (they live
   in the tracked JSON, so baked-equals-tracked keeps holding). Every
   other byte of the canonical image is unchanged. Partial images are
   exempt from baked-equals-tracked; they are checked instead against
   "tracked config filtered by selection".
5. **Any new partial build resets the partial machine.** There is one
   partial gallery entry and one partial computer identity. If the
   manifest's sha256 differs from the saved one for any reason
   (rebuild, different packages, different image), saved state is
   discarded and re-seeded, with the visible notice. Nothing is left
   listed-but-unbootable.
6. **Browser support is the Vite dev server (`./run.sh browser`) only.**
   The service-worker exemption must still be explicit and tested there,
   but partial images are never emitted into production/preview/Pages
   build output, so the grouped `vfs-groups/` layout is out of scope.
7. **Package-session invitation links** that need the default client
   computer (`use-package-sessions.ts`, `invitationLink`) are disabled
   with an honest "default shell not built in this worktree" message
   when the canonical shell is absent. They never point at the partial
   image.

## Left to the builder

- The exact command name and alias list (`partial` is a placeholder).
- Locations of the overlay registry root and the partial manifest
  (gitignored, under `local-binaries/` or similar).
- The partial output file names and the gallery label wording.
- How each currently-unattributed composer extra is attributed to a
  package.
- Which `build-shell.sh` hard requirements are true infrastructure.
- How `--with-tests` handles a package test that needs a
  `build-programs.sh` fixture (build it or fail plainly).
- Whether the Node selector is an env var or manifest-driven.
