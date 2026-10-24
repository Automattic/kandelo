# Troubleshooting

::: warning API stability
Error messages and recovery paths may change as the browser host and image tooling mature.
:::

## SharedArrayBuffer Is Unavailable

Kandelo requires a secure context (HTTPS or a trustworthy local address such
as `127.0.0.1`) and cross-origin isolation:

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

Browser Kandelo cannot open raw TCP/UDP sockets to arbitrary internet
endpoints. Internet egress uses fetch/TLS bridges and carries TCP only;
external UDP fails with `EHOSTUNREACH`. Local loopback, in-browser virtual
networks, and IPv4 UDP/TCP between connected WebRTC session peers are separate
supported paths.

If creating or joining a network session fails, check the signalling endpoint.
The portable PHP piplet included in standalone production output needs a
64-bit PHP 8.3+ server with a writable directory; a static file server cannot
run it.
For static-only hosting, rebuild with `--signalling-url URL` pointing to a
separately hosted endpoint. The optional combined Spacefast package instead
supplies a database-backed `/signalling` Function; both peers must have access
if the Space is private. If signalling works but peers cannot connect,
the default STUN-only ICE setup may not cross their network layout. See
[network-session settings and limits](https://github.com/Automattic/kandelo/blob/main/docs/browser-support.md#purpose-checked-browser-peer-connections).

For a Spacefast proxy that repeatedly fails its quota-session handshake, check
that the app, proxy worker, and PHP session Function were deployed together.
Reload older tabs to pick up the current protocol. The credential is stored
on the app's origin; enabling third-party cookies is not required. Signalling
success does not prove that either the CORS proxy or the peer link works.

For the Kandelo UI, cross-origin fetches use the configured CORS proxy. In local development:

```bash
cd apps/browser-demos
VITE_CORS_PROXY_URL='https://your-proxy.example/?' npm run dev
```

That proxy must preflight the application's current request-header profile:
`Accept`, `Content-Type`, `git-protocol`, `Range`, `wp_blog`, `wp_install`,
and `X-Cors-Proxy-Range`. Kandelo sends a byte range in both `Range` and
`X-Cors-Proxy-Range` with the same value, so the proxy must forward one of
them to the target as `Range` and must not forward `X-Cors-Proxy-Range`
itself. A proxy that ignores both answers ranged reads with the whole entity;
Kandelo's own ranged reads report that as the whole entity rather than as
the slice, and guest programs receive the `200` unchanged. Kandelo
may omit another field only from an anonymous bodyless GET and reports the
omission. Credentialed, body-bearing, and non-GET requests fail before proxy
dispatch when they contain unsupported fields. These failures describe a
browser transport limit; changing an npm package or registry URL is not a fix.
