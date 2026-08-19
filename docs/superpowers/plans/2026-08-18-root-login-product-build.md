# Root Login Product Build Implementation Plan

> **Execution note:** Follow this plan inline in the existing linked worktree.
> Keep the already committed fork replay fix as the lower commit and place the
> browser product recovery in a separate upper commit.

**Goal:** Restore the ABI 43 login, logout prompt, `sudo-lite`, and upstream
`sudo` behavior to the ordinary root browser application, then produce a
complete root-hosted static build containing every requested browser demo.

**Architecture:** Treat login and sudo as a privately reviewed product, never
as authority supplied by a VFS image or URL. An explicit local-product Vite
input reads and verifies the exact non-promotable login lifecycle fixture,
composition report, privileged-product image, main-shell image, bootstrap
inputs, and closed bottle mirror at build time. It emits only the exact declared
assets and a virtual build-owned manifest. The root application uses that
compiled manifest to mint the existing private reviewed policy, re-authenticate
the three source programs from the exact shell image, compare the newly
published product with the serialized artifact, and pass the branded product
and closed lazy assets into `createLiveHost`. Ordinary builds remain unchanged,
and custom/demo boot selections do not inherit the local root product.

**Contracts touched:** browser/user product loading, host/browser parity at the
existing browser-kernel boundary, privileged-program publication, root static
deployment, and validation. No ABI surface changes.

---

## Task 1: Define and test the private build-input boundary

**Files:**

- Create: `apps/browser-demos/lib/local-login-product-build.ts`
- Create: `apps/browser-demos/lib/local-login-product-build.test.ts`
- Modify: `apps/browser-demos/vite.config.ts`

1. Write a failing Node test that creates an exact miniature private product
   directory and asserts that the loader accepts only a schema-1 closed fixture
   whose declared files, byte counts, SHA-256 digests, composition report, and
   serialized product all match regular non-symlink files.
2. Add negative cases for missing files, symlinks, digest/size changes, unknown
   projections, duplicate destinations, missing login/sudo members, and an
   input root that is not absolute.
3. Implement the loader and a Vite plugin that exports a virtual
   `virtual:kandelo-local-login-product` module. Disabled builds export `null`.
   Enabled builds compile exact projection values into the module and emit only
   declared assets below a fixed `homebrew-login-product/` URL root.
4. Preserve `KANDELO_BROWSER_DEMO_INPUTS`; the local-product build mode must not
   narrow the requested page set.
5. Run the focused Node test through `scripts/dev-shell.sh` and confirm green.

## Task 2: Publish the exact product before root boot

**Files:**

- Create: `apps/browser-demos/pages/kandelo/kernel-host/local-login-product.ts`
- Create: `apps/browser-demos/pages/kandelo/kernel-host/local-login-product.test.ts`
- Modify: `apps/browser-demos/pages/kandelo/main.tsx`
- Modify: `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts`

1. Write a failing test for a compiled local-product manifest that verifies the
   loader returns the exact main-shell URL, closed lazy assets, and a privately
   published product only when all three required destinations authenticate.
2. Implement the loader by reusing the authoritative lifecycle fixture loader,
   runtime-input derivation, private reviewed-policy factory, and privileged
   publisher. Map source paths through the canonical Homebrew Cellar layout.
3. Verify the runtime-published product bytes equal both the build-declared
   serialized-product identity and the fetched serialized artifact.
4. Extend the private `createLiveHost` options to accept already verified
   closed lazy assets for one exact root VFS URL. Apply them only while booting
   that exact descriptor; gallery, demo, and custom-image boots retain their
   normal transport and authority rules.
5. In the root entry point, activate the product only when no `demo` or custom
   `vfs` selection is present. Pass the published product, exact root VFS URL,
   and closed assets to the live host. Keep normal builds and routes unchanged.
6. Run the focused loader, existing demo-login-loader, privileged projection,
   and terminal-session tests through `scripts/dev-shell.sh`.

## Task 3: Add an end-to-end root route regression

**Files:**

- Create: `apps/browser-demos/test/root-login-product.spec.ts`
- Modify: `apps/browser-demos/playwright.config.ts` only if a dedicated static
  preview configuration is required.

1. Write the browser test before the root wiring. Point it at a build produced
   from an exact fixture and require the ordinary `/` route to show the
   automatic `maker` login session.
2. In the terminal, prove `id`, `sudo -l`, and `sudo id` use the real guest
   programs and expected credentials.
3. Exit the automatic session and prove the supervisor presents an ordinary
   `login:` prompt, including failed-password rejection and a successful maker
   login.
4. Fail on page errors, browser console errors, service-worker scope mismatch,
   missing cross-origin isolation, or a worker/kernel trap.
5. Run the test in Chromium against the generated exact product. Retain the
   existing three-engine login-product lifecycle as broader product evidence.

## Task 4: Produce the exact local login product

**Files:**

- Modify: `scripts/run-login-stack-local.sh` only if needed to expose one exact
  build-input directory/fixture without copying into a tracked public folder.

1. Run the supported login-stack producer on Linux, using a local privileged
   container if necessary on this macOS host. Use the current Kandelo worktree
   and the dedicated ABI-43 Homebrew tap worktree.
2. Preserve its exact non-promotable outputs outside tracked source: main-shell
   VFS, composition report, serialized privileged product, lifecycle fixture,
   bootstrap inputs, and closed mirror assets.
3. Run its Node smoke and Chromium/Firefox/WebKit lifecycle tests. Record any
   platform or resource limitation instead of weakening the proof.

## Task 5: Build and validate the deployable site

**Files:**

- Output: `apps/browser-demos/dist/`
- Output: an untracked deployment archive beside the browser app

1. Build through `scripts/dev-shell.sh` with `VITE_BASE=/`, the absolute private
   local-product input, and all seven `KANDELO_BROWSER_DEMO_INPUTS`.
2. Serve the output from the web root with the required COOP/COEP/CORP and
   service-worker headers. Verify `/service-worker.js` controls `/` and the page
   is cross-origin isolated.
3. Run the new root-login product Chromium test and the existing
   WordPress/MariaDB Chromium boot/login acceptance against the final output,
   thereby covering both the product recovery and the lower fork replay fix.
4. Run the relevant Node host tests, browser tests, ABI snapshot check, and
   TypeScript/build checks. Report exact commands and any deliberately unrun
   suites.
5. Archive the complete `dist/` tree without changing tracked source, generate
   SHA-256 and byte/file counts, and report absolute paths.

## Task 6: Prepare the stacked change for review

1. Inspect the final diff, commit attribution, and `git range-diff`. Do not
   include generated deployment archives or pre-existing dirty submodule state.
2. Commit the browser recovery above `b9f205851` with a purpose-led subject such
   as `Browser: Restore the privileged login product at the root` and preserve
   Brandon Payton's authorship for the recovered product intent.
3. Prepare two PR descriptions: the lower fork replay fix and the upper browser
   login-product recovery. Each begins with `## Why`, defines the user-visible
   failure, lists exact validation, and explains the stacked dependency.
4. Stop before pushing or opening PRs unless explicitly requested.
