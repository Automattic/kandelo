# Apps

Applications that exercise Kandelo as a product surface live here.

- `browser-demos/` is the Vite app for the Kandelo web UI and retained browser labs. It consumes the browser host runtime from `host/src/browser-kernel-host.ts`; host/runtime code should not live under the app tree.
- `spacefast-cors-proxy/` implements Playground's CORS protocol for
  Spacefast Functions, as an experimental separate proxy with approved Referer origins or
  packaged with a combined Kandelo deployment. Production
  uses Spacefast Fetch; its optional pinned TCP/TLS transport remains locally
  tested but blocked by the platform. See its README for verified boundaries.
- `signalling/` carries WebRTC invite and answer codes for named sessions
  and rooms. The portable PHP piplet stores its own state; `spacefast/`
  implements the same HTTP protocol with atomic MySQL updates.

Reusable session contracts and browser-independent integration code belong in
`web-libs/`, not inside an app directory.
