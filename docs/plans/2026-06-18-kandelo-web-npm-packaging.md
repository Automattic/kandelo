# `@kandelo/web` — npm Packaging of the Browser Host Runtime

**Status:** Implemented, rebased onto `main` at ABI 42. The package is
**code-only**: it bundles no Wasm and fetches the kernel, rootfs, and program
binaries at runtime from a Kandelo *binaries release*. The loader path (index
parse → archive fetch → sha256 verify → fzstd → untar) is validated against the
live `binaries-abi-v42` release from Node. Live browser acceptance under
COOP/COEP has not been run.

**Goal:** Make the browser host runtime installable from npm with a public host
API, so a separate browser-IDE project can depend on `@kandelo/web` instead of
vendoring `host/src` or carrying a git submodule.

**Branch:** `explore-npm-packaging`

---

## Architecture decisions

1. **Package location and name:** `web-libs/kandelo-web/`, published as
   `@kandelo/web`. Matches the `web-libs/` layout and `host/`'s packaging
   conventions. First use of the `@kandelo/*` scope in the repository.

2. **Self-contained bundle, not a re-export of `wasm-posix-host`:**
   `@kandelo/web` tsdown-bundles the browser-safe host modules from `../../host/src`
   at build time. Consumers get no runtime dependency on `wasm-posix-host` —
   only `fflate` and `fzstd`.

3. **The crux — Vite-only module resolution.** Two host-runtime modules resolve
   specifiers that only Vite understands, so the package build aliases both:

   | Host module | Vite-only specifiers | Package replacement |
   |---|---|---|
   | `browser-kernel-assets.ts` (new) | `./worker-entry-browser.ts?worker&url`, `./browser-kernel-worker-entry.ts?worker&url` | `src/assets-bundled.ts` — resolves both against the shipped `dist/` with `new URL(..., import.meta.url)`, which rolldown leaves intact for the consumer's bundler |
   | `browser-kernel-default-artifacts.ts` (upstream) | `@kernel-wasm?url`, `@rootfs-vfs?url` | `src/default-artifacts-unbundled.ts` — throws, because the package ships no Wasm |

   `BrowserKernel` reads only `this.assets` (defaults merged with
   `options.assets`), and `import.meta.env.BASE_URL` is read through a guarded
   `importMetaBaseUrl()` because non-Vite bundlers do not inject it.

4. **Main-thread VFS is the one capability a consumer cannot build itself.**
   The kernel worker owns the filesystem, but it is `SharedArrayBuffer`-backed:
   - `InitMessage.reportFsSab?` asks the worker to report that SAB.
   - `ReadyMessage.fsSab?` carries it back.
   - `BrowserKernel.hostFs` returns a `MemoryFileSystem.fromExisting(sab)` view
     over the *same bytes* processes see — synchronous, no round-trip.

   **Opt-in via `BrowserKernelOptions.exposeHostFs`, and deliberately so.**
   Holding the SAB makes the main thread a co-owner of the VFS. On WebKit a
   co-owned buffer is reclaimed only when the page drops it, not by
   `Worker.terminate()` — the accumulation the kernel-owned VFS exists to
   prevent (the Safari image-switch OOM fix). `destroy()` releases the
   reference alongside the framebuffer and PTY aliases.

   **Sync vs async:** Kandelo mandates COOP/COEP for `SharedArrayBuffer` +
   `Atomics`, so the synchronous path is always available. There is
   deliberately no async-message FS API.

5. **Binaries are fetched, not bundled.** `fetchKandeloIndex` /
   `fetchKandeloPackage` / `fetchKandeloBinaries`. The source is a first-class
   parameter: a tag string, `{ repo, tag }` for a fork, `{ baseUrl }` for
   self-hosted, or nothing for the ABI-matched default. The release
   `abi_version` is verified against `ABI_VERSION` (throws on mismatch;
   `allowAbiMismatch` opts out) and `archive_sha256` is verified before
   unpacking. Caching is the consumer's choice through an injectable `fetch`.
   `fetchKandeloBinaries` returns raw bytes (`kernelWasm: ArrayBuffer`,
   `rootfsVfs: Uint8Array`) shaped for `boot()`, so it needs no DOM.

6. **Dogfood without behavior change:** `apps/browser-demos` resolves
   `@kandelo/web` to the package *source* entry through
   `browserRepositoryAliases()` in `apps/browser-demos/browser-module-contract.mjs`.
   That map is the single alias contract shared by Vite and the required-input
   scanner, so a new alias cannot let the product import bytes the scanner
   never sees. The source entry re-exports the same host modules, so demo
   behavior is unchanged.

---

## Compatibility boundary: the GitHub release under COEP

GitHub's release CDN sends no `Access-Control-Allow-Origin` or
`Cross-Origin-Resource-Policy` headers, so a COEP `require-corp` page cannot
fetch the release cross-origin. Consumers must serve the binaries same-origin:
mirror them, proxy them, or inject a custom `fetch`. The scratch consumer
demonstrates a Vite dev proxy plus `baseUrl: "/kandelo-binaries/"`. Index
`archive_url` values are bare filenames, so they resolve against whatever base
the loader is pointed at.

---

## Files changed

**Host runtime (platform):**
- `host/src/browser-kernel-assets.ts` (new) — isolates the two `?worker&url` imports.
- `host/src/browser-kernel-host.ts` — reads `this.assets`; adds `options.assets`,
  `options.exposeHostFs`, `get hostFs()`; guards `import.meta.env`; releases the
  VFS SAB in `destroy()`.
- `host/src/browser-kernel-protocol.ts` — `InitMessage.reportFsSab?`, `ReadyMessage.fsSab?`.
- `host/src/browser-kernel-worker-entry.ts` — reports `fsSab` when asked.
- `host/test/browser-kernel.test.ts` — `hostFs` gating, round-trip, and release tests.

**New package `web-libs/kandelo-web/`:**
- `package.json`, `tsdown.config.ts`, `tsconfig.json`, `.gitignore`
- `src/index.ts` (public re-exports + ABI constants), `src/fetch-binaries.ts`,
  `src/assets-bundled.ts`, `src/default-artifacts-unbundled.ts`, `src/vite-shims.d.ts`
- `README.md`, `examples/scratch-consumer/` (excluded from the tarball by `files: ["dist"]`)

**Consumers and glue:**
- `apps/browser-demos/browser-module-contract.mjs` — `@kandelo/web` alias.
- `apps/browser-demos/` — 11 importers repointed; `tsconfig.json` path.
- `package.json` (root) — `pack:web`, added to `pack:packages`.
- `web-libs/README.md` — lists the package.

The ABI version is not duplicated in `package.json`. `ABI_VERSION`,
`BINARIES_ABI_VERSION`, `BINARIES_RELEASE_TAG`, and `binariesIndexUrl()` all
derive from the generated `host/src/generated/abi.ts`, so an ABI bump cannot
leave them stale.

---

## Validation

**Ran, passing:**
- `host/test/browser-kernel.test.ts` — 38/38, including 5 new `hostFs` tests
  (default-off, SAB round-trip, stable view, pre-boot throw, release on destroy).
- `tests/package-system/browser-binary-dependencies.test.ts` — 26/26, exercising
  the shared alias contract.
- Package `tsc --noEmit`, `tsdown` ESM + `.d.ts` build, `npm pack --dry-run`
  (code-only tarball: `dist`, `README.md`, `package.json`).
- `dist/index.js` contains both `new URL(..., import.meta.url)` worker refs and
  zero `@kernel-wasm` / `@rootfs-vfs` / `?worker&url` specifiers.
- Loader against the live `binaries-abi-v42` release from Node: index parses
  (70 packages), `kernel` and `rootfs` archives fetch, sha256-verify,
  decompress, and untar; `fetchKandeloBinaries()` returns a valid Wasm
  `ArrayBuffer` (610623 bytes) and the rootfs image (16787687 bytes).
  Confirmed the `php` archive carries `php.wasm`, `php-fpm.wasm`, `opcache.so`;
  `composer` and `npm` are correctly absent as standalone entries.
- `apps/browser-demos` `tsc --noEmit`: 59 errors, byte-identical to upstream
  before the change. The repoint introduces none.

**NOT run:**
- Live browser acceptance under COOP/COEP (`examples/scratch-consumer`) — no
  browser run was performed. The worker-spawn and kernel-boot path in a real
  cross-origin-isolated page is unproven.
- Full `apps/browser-demos` Vite build (`./run.sh browser`).
- The full `host` Vitest suite. It needs a built `kernel.wasm`, a `sysroot64`,
  and fetched package artifacts, none of which are present in this worktree;
  the failures observed were all missing-prerequisite errors unrelated to these
  changes.

**Open risks to watch:**
- `hostFs` SAB growth: the worker's memfs SAB is growable, and a main-thread
  `fromExisting` view should observe in-place growth. Confirm under a workload
  that grows the filesystem.
- `optimizeDeps.exclude: ["@kandelo/web"]` is required in a consumer's Vite
  config so the worker URLs resolve against `dist/` rather than esbuild's
  prebundle.
