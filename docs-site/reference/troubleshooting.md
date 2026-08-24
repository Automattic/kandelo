# Troubleshooting

::: warning API stability
Error messages and recovery paths may change as the browser host and image tooling mature.
:::

## SharedArrayBuffer Is Unavailable

Kandelo requires cross-origin isolation:

```text
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

If you use the public GitHub Pages UI and still see this failure, clear site data and reload so the service worker can update.

## A Direct VFS URL Does Not Boot

Check:

- the URL is `http` or `https`;
- the file is reachable without authentication;
- the host allows cross-origin fetches from the Kandelo page;
- the image is a valid `.vfs` or `.vfs.zst`;
- the image ABI matches the running Kandelo ABI if it contains Wasm programs.

Inspect locally:

```bash
node tools/mkrootfs/bin/mkrootfs.mjs inspect ./my-machine.vfs.zst --metadata
```

## External Gallery Entry Does Not Appear

The demo app does not request third-party gallery manifests. Launch an
externally published image with a direct `?vfs=` URL instead. Package-source
publishers can still validate optional gallery metadata with
`scripts/validate-software-gallery.mjs` for other consumers.

## Lazy Assets 404

If a VFS image references lazy files or lazy archives with relative URLs, the browser host resolves those URLs relative to the configured lazy URL base. Make sure the image, lazy binaries, and lazy archives are deployed under the expected paths, or pass the correct `lazyUrlBase` when booting a custom app.

## Network Requests Fail

Browser Kandelo cannot open external raw TCP or UDP sockets. Use the service worker HTTP bridge, fetch-backed networking, or a proxy-backed transport. Local loopback and in-browser virtual networking are supported.

For the Kandelo UI, cross-origin fetches use the configured CORS proxy. In local development:

```bash
cd apps/browser-demos
VITE_CORS_PROXY_URL='https://your-proxy.example/?' npm run dev
```

That proxy must preflight the application's current request-header profile:
`Accept`, `Content-Type`, `git-protocol`, `wp_blog`, and `wp_install`. Kandelo
may omit another field only from an anonymous bodyless GET and reports the
omission. Credentialed, body-bearing, and non-GET requests fail before proxy
dispatch when they contain unsupported fields. These failures describe a
browser transport limit; changing an npm package or registry URL is not a fix.
