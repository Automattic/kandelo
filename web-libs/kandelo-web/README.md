# @kandelo/web

The **browser distribution** of the [Kandelo](../../README.md) POSIX-compatible
WebAssembly kernel runtime. Install this package instead of vendoring `host/src`
or carrying a git submodule.

It ships, as a Vite-friendly ESM package with `.d.ts` declarations:

- **`BrowserKernel`** — the main-thread proxy that drives a dedicated kernel
  worker. The worker owns the Wasm instance and all process lifecycle
  (`fork`/`exec`/`clone`/`exit`); the main thread is a thin proxy for setup, UI,
  and I/O routing.
- A **synchronous host-side VFS** reachable from the main thread
  (`BrowserKernel.hostFs`) plus the VFS backends/helpers to build images.
- The **kernel & process worker** entries (code), referenced by default — a
  consumer needs no `?worker&url` wiring.
- A **binaries loader** (`fetchKandeloBinaries` / `fetchKandeloPackage`). The
  package ships **no Wasm artifacts**. The kernel wasm, `rootfs.vfs`, and
  program binaries (`php.wasm`, ...) are fetched at runtime from a Kandelo
  *binaries release* — the canonical one matching this build's ABI, a fork's
  release, or any URL you host yourself.

## Install

```sh
npm install @kandelo/web
```

Kandelo requires **cross-origin isolation**. Serve your app with:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

without which `SharedArrayBuffer` / `Atomics` are unavailable and the kernel
cannot run.

In a Vite consumer, exclude the package from dep pre-bundling so Vite resolves
its bundled worker URLs against `dist/`:

```ts
// vite.config.ts
export default { optimizeDeps: { exclude: ["@kandelo/web"] } };
```

## Quick start

```ts
import {
  BrowserKernel, MemoryFileSystem, writeVfsBinary, ensureDirRecursive,
  fetchKandeloBinaries, fetchKandeloPackage,
} from "@kandelo/web";

// 1. Fetch kernel + rootfs from the binaries release (see "Binaries" — the
//    release must be reachable same-origin under COOP/COEP).
const { kernelWasm } = await fetchKandeloBinaries({ baseUrl: "/kandelo-binaries/" });

// 2. Fetch a program and install it into a VFS image.
const php = await fetchKandeloPackage("php", { baseUrl: "/kandelo-binaries/" });
const fs = MemoryFileSystem.create(new SharedArrayBuffer(16 << 20, { maxByteLength: 512 << 20 }), 512 << 20);
ensureDirRecursive(fs, "/usr/bin");
writeVfsBinary(fs, "/usr/bin/php", php.artifacts["php.wasm"], 0o755);
const vfsImage = await fs.saveImage();

// 3. Boot and run. The worker entries come from the package's own defaults.
const kernel = new BrowserKernel({
  onStdout: (d) => console.log(new TextDecoder().decode(d)),
});
await kernel.boot({ kernelWasm, vfsImage, argv: ["/usr/bin/php", "--version"] });

const { exit } = await kernel.spawnFromVfs("/usr/bin/php", ["-v"]);
await exit;
```

A complete, runnable acceptance app lives in
[`examples/scratch-consumer`](./examples/scratch-consumer) (including the Vite
proxy that makes the release reachable same-origin).

## Host-side filesystem: sync vs. async

The runtime filesystem lives **inside the kernel worker**, but it is backed by a
`SharedArrayBuffer`. Pass `exposeHostFs: true` and the worker reports that SAB to
the main thread at boot, so **`BrowserKernel.hostFs` operates on the same bytes
the running processes see — synchronously, with no message round-trip**:

```ts
const kernel = new BrowserKernel({ exposeHostFs: true });
await kernel.boot({ kernelWasm, vfsImage });

const fd = kernel.hostFs.open("/tmp/x", 0o1101 /* O_WRONLY|O_CREAT|O_TRUNC */, 0o644);
kernel.hostFs.write(fd, new TextEncoder().encode("hi"), 0, 2);
kernel.hostFs.close(fd);
```

**Why opt-in?** Holding the SAB makes the main thread a co-owner of the VFS. On
WebKit a co-owned buffer is reclaimed only when the page drops it, not by
`Worker.terminate()`, so a host that swaps images repeatedly would accumulate
one VFS per boot. `destroy()` releases the reference. Leave the option off
unless you need main-thread filesystem access.

`hostFs` is a `MemoryFileSystem`, which implements the full host
`FileSystemBackend`: `open`/`read`/`write`/`close`/`seek`/`fstat`/`stat`/
`lstat`/`mkdir`/`rmdir`/`unlink`/`rename`/`readlink`/`symlink`/`chmod`/`chown`
plus `opendir`/`readdir`/`closedir`. Concurrent access between the main thread
and the kernel worker is coordinated by the SharedFS lock table, exactly as it
is between the kernel worker and its process workers. Wrap it in your own
ergonomic façade as needed.

**Why no async API?** Because Kandelo already mandates COOP/COEP for
`SharedArrayBuffer` + `Atomics`, the synchronous SAB path is *always* available.
There is deliberately no async-message FS protocol to reason about — the host FS
is host-owned and synchronous. If a future host runs without cross-origin
isolation, that would be the boundary at which an async API becomes necessary;
today it is not.

`hostFs` requires `exposeHostFs: true` and a booted kernel. It throws otherwise.

## Binaries (fetched from a release)

The package ships no Wasm. Wasm programs are bound to a kernel **ABI version**,
and the loader pulls ABI-matched artifacts from a *binaries release* — an
`index.toml` plus content-addressed `.tar.zst` archives (one per package). For
each requested package it fetches the archive, **verifies its `archive_sha256`**,
`fzstd`-decompresses it, untars it, and returns the `artifacts/*` payloads.

```ts
import { fetchKandeloIndex, fetchKandeloPackage, fetchKandeloBinaries } from "@kandelo/web";

// kernel + rootfs bytes, shaped for boot():
const { kernelWasm, rootfsVfs } = await fetchKandeloBinaries(source);
// one package's artifacts by basename:
const php = await fetchKandeloPackage("php", source); // php.artifacts["php.wasm"], ["php-fpm.wasm"], ...
// just the parsed index (ABI-checked):
const index = await fetchKandeloIndex(source);        // reuse via { index } to avoid re-downloading
```

### Pointing at a source

The binary source is a first-class, overridable parameter. Pass a string (= a
release tag on the canonical repo) or an options object:

```ts
fetchKandeloBinaries("binaries-abi-v42");                   // canonical repo, explicit tag
fetchKandeloBinaries({ repo: "myorg/my-fork" });           // a fork's GitHub release
fetchKandeloBinaries({ baseUrl: "/kandelo-binaries/" });   // self-hosted / proxied (any URL)
fetchKandeloBinaries();                                     // default repo + ABI-matched tag
```

The ABI this build speaks is exported. All three derive from the kernel's
generated `ABI_VERSION`, so they cannot drift from the runtime:

```ts
import { ABI_VERSION, BINARIES_RELEASE_TAG, binariesIndexUrl } from "@kandelo/web";
ABI_VERSION;            // e.g. 42
BINARIES_RELEASE_TAG;   // "binaries-abi-v42"
binariesIndexUrl();     // canonical index.toml URL
```

`fetchKandeloIndex` reads the release's `abi_version` and **throws on mismatch**
with `ABI_VERSION` (a kernel/program built for another ABI cannot run). Pass
`allowAbiMismatch: true` to override.

### ⚠️ Cross-origin isolation vs. the GitHub release

Because Kandelo mandates COOP/COEP (`require-corp`) and GitHub's release CDN
sends **no `Access-Control-Allow-Origin` / `Cross-Origin-Resource-Policy`**
headers, a browser **cannot `fetch()` the GitHub release directly**. Serve the
binaries **same-origin** instead:

- mirror/copy the release behind your own origin, or
- proxy it (see the dev proxy in `examples/scratch-consumer/vite.config.ts`) and
  point the loader at the proxy via `baseUrl`, or
- inject a custom `fetch` (the caching/proxy hook) that routes the request.

### Caching

The loader does plain `fetch()` and stays cache-agnostic — caching is **your**
choice. Inject a `fetch` to layer CacheStorage / IndexedDB / auth however you
like; it gets the standard `(input, init)` signature:

```ts
await fetchKandeloBinaries({ baseUrl, fetch: myCachingFetch });
```

### Programs in the release

Each package archive holds its declared outputs under `artifacts/`: e.g. the
`php` package archive contains `php.wasm`, `php-fpm.wasm`, and `opcache.so`.
Other packages: **node**, **git**, **bash**, **coreutils**, **rootfs**
(`rootfs.vfs`), **kernel** (`kandelo-kernel.wasm`), and the libraries they
depend on. Mapping an artifact to a VFS path (e.g. `/usr/bin/php`) is the
consumer's job — build the VFS image with the helpers above.

Not standalone Wasm binaries in the release:

- **composer** — a PHP `.phar` application; ship `composer.phar` and run it with
  the `php` binary.
- **npm** — distributed inside the Node VFS image (`node-vfs`), not as its own
  `npm.wasm`.

## Build

```sh
npm --prefix web-libs/kandelo-web install
npm --prefix web-libs/kandelo-web run build   # tsdown (ESM + .d.ts); no binaries staged
npm --prefix web-libs/kandelo-web pack        # code-only tarball
```

`build` runs `tsdown` only. It swaps the two host-runtime modules that only
Vite can resolve:

- `browser-kernel-assets` → [`src/assets-bundled.ts`](./src/assets-bundled.ts),
  so the published `BrowserKernel` resolves its **worker** entries relative to
  the package.
- `browser-kernel-default-artifacts` →
  [`src/default-artifacts-unbundled.ts`](./src/default-artifacts-unbundled.ts).
  The package ships no Wasm, so booting without explicit bytes throws an
  actionable error instead of fetching a default that does not exist.

## Relationship to the host runtime

`@kandelo/web` is the browser face of the platform's host runtime
(`host/src`). It bundles the browser-safe host modules at build time. The repo's
`apps/browser-demos` dogfoods this package (aliased to the package source) to
keep the public surface honest.
