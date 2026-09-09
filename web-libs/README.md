# Web Libraries

Reusable browser-facing libraries live here.

- `kandelo-session/` owns boot descriptors, snapshots, and the `KernelHost`
  contract shared by the Kandelo web app and future embedders.
- `kandelo-web/` is the published **`@kandelo/web`** package — the browser
  distribution of the host runtime (`BrowserKernel`, a synchronous host-side
  VFS, and the kernel/process worker entries). It ships no Wasm; consumers
  fetch ABI-matched binaries from a Kandelo binaries release. Downstream
  browser projects depend on it instead of vendoring `host/src`.
  `apps/browser-demos` dogfoods it. See `kandelo-web/README.md`.

Concrete host runtime implementations stay in `host/`. Demo-only React wiring
and fixtures stay in `apps/browser-demos/`.
