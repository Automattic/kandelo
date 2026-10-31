# Node web platform implementations

The shared Node compatibility layer embeds `whatwg-url` 14.2.0, an MIT
licensed implementation of the WHATWG URL standard, and its dependencies.
It also embeds MIT licensed `web-streams-polyfill` 4.3.0 for Web Streams.
The lockfile records exact versions and npm tarball integrity hashes.
Version 14 supports Node 18 and the Node 22.0 compatibility target; newer
releases require newer Node versions.

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
