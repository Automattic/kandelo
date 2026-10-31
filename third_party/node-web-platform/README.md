# Node web platform implementations

The shared Node compatibility layer embeds `whatwg-url` 14.2.0, an MIT
licensed implementation of the WHATWG URL standard, and its dependencies.
It also embeds MIT licensed `web-streams-polyfill` 4.3.0 for Web Streams.
The lockfile records exact versions and npm tarball integrity hashes.
These implementations run on the SpiderMonkey engine, independently of
the host Node toolchain. Their versions are pinned and remain partial
inputs to the Node 26.13.0 compatibility target; an LTS target does not
imply complete Node or web-platform conformance.

`node-web-platform.js` is a generated, self-contained CommonJS bundle wrapped in a
factory. It includes every dependency's license. The factory runs after the
bootstrap installs its text encoders. Package builds read this checked-in
file, with no npm install or network access at build time.

Regenerate from the repository root using the declared dev shell:

```sh
scripts/dev-shell.sh npm ci --prefix third_party/node-web-platform --ignore-scripts
scripts/dev-shell.sh node third_party/node-web-platform/build.mjs
scripts/dev-shell.sh node third_party/node-web-platform/build.mjs --check
```

Upstream: <https://github.com/jsdom/whatwg-url/tree/v14.2.0>.
Streams upstream: <https://github.com/MattiasBuelens/web-streams-polyfill/tree/v4.3.0>.
The bundle also exports its pinned `tr46` 5.1.1 dependency for Unicode
hostname formatting by `url.format`.

This supplies `URL`, `URLSearchParams`, and the `stream/web` classes. The separate legacy `url.parse`,
`url.format`, and `url.resolve` APIs remain Kandelo's compatibility code.

`stream-state.cjs` is the Fetch embedding's access to this pinned stream
implementation's real disturbance/lock/controller state. It uses captured
intrinsic brand getters and checks the live `_disturbed` slot's layout;
there is no second consumption flag in Response. These helpers are not
exported by the public `stream/web` module. Regeneration rejects a stream
version change until this boundary and its state/cancellation/BYOB tests
are reviewed together. Public default-stream tee shares object chunks;
Fetch composes it with the engine graph clone before either branch can
expose a chunk. Byte-stream tee uses the library's native byte-copy path.
