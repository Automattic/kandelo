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

The post-audit source candidate also exposes private `hostnameToUnicode`
for the public Node domain helpers. `host-idna.cjs` implements the pinned
Node Ada backend's non-strict ASCII rule and per-label Unicode failure
preservation. `build.mjs` guards the exact URL parser source hash before
redirecting its ToASCII call to this shared owner; installed npm sources
stay unchanged. Forbidden-host and numeric-host parsing still run through
the URL state machine. This also corrects WHATWG URL parsing of ASCII
A-labels, rather than special-casing the public domain helper or TLS.
Full unchanged Node reference sources and selected public algorithms are
bound in `../node-core/sources.json` under `networkIdentity`.
This is partial target alignment: the older TR46 Unicode tables, complete
label validation, percent decoding and Ada input-size branches still need
broad coverage and any exposed implementation gaps must be fixed.
Focused source/native controls do not establish guest-host conformance.

This factory supplies `URL` and `URLSearchParams`. During the current broad
source pass, the production bootstrap replaces its stream exports/state
with the pinned Node implementations in `third_party/node-core`. Those
changes remain uncompiled and unverified; older tests that instantiate
this factory directly exercise its retained ponyfill, not the production
Node stream candidate. The duplicate ponyfill remains a cleanup obligation
while source fixtures are moved to the complete dependency graph.
The separate legacy `url.parse`,
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

The private hostnameToASCII export now exposes the same raw UTS46 converter
to DNS lookup, without invoking URL host/authority parsing. DNS applies its
pinned UTF-8 input-byte cap at the caller. Nineteen scoped conversion cases
match separately compiled pinned Ada, including ASCII punctuation/numeric
spellings and Unicode/error/length cases. This is not a complete Unicode
data audit or guest codec/four-host claim; remaining IDNA obligations stay
open in the Node core DNS dependency record.
