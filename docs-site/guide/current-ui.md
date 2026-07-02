# Current Kandelo UI

::: warning API stability
The Kandelo UI and every browser-facing boot URL shape documented here are experimental. They are useful today, but they are not a long-term compatibility promise.
:::

The public Kandelo UI is available at:

```text
https://automattic.github.io/kandelo/
```

It boots prebuilt machines in the browser using `kernel.wasm`, package artifacts, and VFS images. The first screen lets users boot a preset, paste a Kandelo URL, or bring a VFS image.

## Requirements

Kandelo needs browser support for `SharedArrayBuffer`. In practice the page must be cross-origin isolated:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

The GitHub Pages deployment uses a service worker to add the required isolation headers. If the page reports that `SharedArrayBuffer` is unavailable, clear site data and reload. A stale service worker can keep old behavior alive.

## Local Development

From a Kandelo checkout:

```bash
./run.sh browser
```

Open:

```text
http://127.0.0.1:5401/
```

`./run.sh browser` prepares missing browser artifacts before starting Vite. The lower-level path is:

```bash
cd apps/browser-demos
npm install
npm run dev
```

That path assumes the needed kernel, rootfs, package, and VFS artifacts already exist.

## Gallery Presets

The current UI ships local gallery presets such as:

- Bare shell
- Node.js
- nginx
- nginx + PHP
- WordPress SQLite
- WordPress MariaDB
- fbDOOM

When a user launches a preset, the UI selects a VFS image, boots the kernel, starts the configured process, and presents the relevant surfaces:

- terminal
- web preview for HTTP demos
- syslog and process internals
- VFS browser
- framebuffer, mouse, keyboard, and audio for demos that expose those devices

## Direct VFS Links

The UI can boot a direct VFS image URL without a gallery manifest:

```text
https://automattic.github.io/kandelo/?vfs=https://example.com/images/site.vfs.zst
```

Accepted image URL schemes are `http` and `https`. The image should be a `.vfs` or `.vfs.zst` file produced by Kandelo's VFS tooling.

The host serving the image must allow the browser to fetch it from a cross-origin-isolated page. Use CORS or compatible cross-origin resource policy headers.

## External Software Manifests

The UI can load gallery entries from package-source repositories:

```text
https://automattic.github.io/kandelo/?softwareManifest=https://example.com/releases/download/binaries-abi-v11/gallery.json
```

Multiple manifest URLs can be supplied with repeated `softwareManifest` parameters or a comma/whitespace-separated value in local builds through:

```text
VITE_KANDELO_SOFTWARE_MANIFEST_URLS
```

The gallery shows an external entry only when every package named by that entry has a successful `wasm32` record in the matching `index.toml`.

## Network Behavior

Browser Kandelo supports local loopback sockets and virtual machine-to-machine networking inside the browser session. Browser sandboxing prevents raw external TCP and UDP sockets. External network use goes through fetch, the service worker HTTP bridge, a CORS proxy, or future transport backends.

The browser app defaults cross-origin fetches to:

```text
https://wordpress-playground-cors-proxy.net/?
```

For local development:

```bash
cd apps/browser-demos
VITE_CORS_PROXY_URL='https://your-proxy.example/?' npm run dev
```
