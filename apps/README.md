# Apps

Applications that exercise Kandelo as a product surface live here.

- `browser-demos/` is the Vite app for the Kandelo web UI and retained browser labs. It consumes the browser host runtime from `host/src/browser-kernel-host.ts`; host/runtime code should not live under the app tree.
- `spacefast-cors-proxy/` is a standalone server-side proxy draft for Spacefast
  Functions. It implements Playground's CORS protocol with locally owned DNS
  validation and IP-pinned TCP/TLS transport. Live Spacefast socket admission
  remains unverified; see its README for destination restrictions and tests.

Reusable session contracts and browser-independent integration code belong in
`web-libs/`, not inside an app directory.
