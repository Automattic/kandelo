# Task 3 report: complete the browser proxy boundary

Date: 2026-08-12

## Result

The application, Vite development relay, production service worker, browser
guest transports, and lazy fetcher now consume the same complete
`BrowserCorsProxyConfig`. Every configured proxy boundary projects by
case-insensitive name against the current five-name profile: `accept`,
`content-type`, `git-protocol`, `wp_blog`, and `wp_install`. The service worker
preserves allowed values and method/body bytes as far as Fetch permits, emits
one generic omission diagnostic per target-origin/name set for eligible
anonymous bodyless GETs, and returns 502 without dispatch for lossy ineligible
requests. Direct requests and the Node.js host remain unchanged.

The generic browser proxy contract is green in Chromium, Firefox, and WebKit.
The exact production Node image boots with its exact local authenticated lazy
cohort, reports the canonical npm registry, installs cowsay with npm exit 0,
and executes the installed cowsay package. This report does not claim live
publication.

## RED and GREEN

The first focused host test established configuration drift: the development
relay still admitted cache/range fields instead of the approved five names.

```text
FAIL host/test/dev-cors-proxy.test.ts
expected accept/content-type/git-protocol/wp_blog/wp_install
received the former cache-control/range profile
```

A later ownership audit caught that the corrected relay still duplicated those
five names instead of consuming the application-owned profile. Its focused
source-contract test failed 1 of 7 tests because
`DEFAULT_BROWSER_CORS_PROXY_CONFIG` was absent. The relay now derives its set
from that config directly, and the focused boundary is green at 7 of 7 tests.

The Vite source test then showed that the served worker contained only
`__CORS_PROXY_URL__`, not the complete profile. The new real service-worker
fixture additionally exposed these RED boundaries before implementation:

- wrapped and browser-owned requests were not projected;
- an allowed POST lost/rejected its body path;
- a wrapped-request diagnostic named the proxy origin rather than the original
  target origin.

The first exact Node browser run provided a second behavioral RED:

```text
Error: TLS handshake failed
```

The guest CA file was present at the configured `SSL_CERT_FILE` path and was
1,122 bytes. A diagnostic-only `NODE_TLS_REJECT_UNAUTHORIZED=0` probe failed
identically, and neither run reached the host proxy. Source tracing found that
the native SpiderMonkey TLS binding put the TCP socket in nonblocking mode but
called `SSL_connect`, `SSL_read`, and `SSL_write` as one-shot operations. It
treated OpenSSL `SSL_ERROR_WANT_READ` and `SSL_ERROR_WANT_WRITE` as terminal
errors instead of registering readiness.

The package fix adds TLS connect/read/write watches to the existing socket
poll dispatcher. WANT_READ arms `POLLIN`; WANT_WRITE arms `POLLOUT`; partial
writes retain their offset. `tlsClose()` unlinks and rejects pending I/O before
freeing OpenSSL state, while pending handshakes own their unallocated fd until
success transfers it or failure closes it exactly once. A focused source guard
prevents restoration of one-shot calls. The rebuilt browser regression then
completed handshake, request write, response read, and clean EOF with HTTP 200.

Chromium exposes Fetch-owned `accept-language`, `sec-ch-ua*`, `user-agent`
fields in `FetchEvent.request.headers` even when they are absent from the
caller's `Headers`. The service worker does not copy or classify those
browser-managed outer-connection fields as application occurrences; Fetch
owns the new outer request's values. The test proves the application-owned
`Content-Type` POST occurrence and exact body survive, while the actual proxy
receives only configured application header names.

Focused GREEN:

```text
host proxy/backend/kernel/lazy tests: 6 files, 111 tests passed
Chromium browser-cors-proxy.spec.ts: 5 passed
Firefox + WebKit browser-cors-proxy.spec.ts: 8 passed, 2 failed only because
  those runners do not surface service-worker console warnings to Playwright;
  all guest preflight and rejection cases passed in both engines
```

The Chromium service-worker test observes both actual `fetchCrossOrigin()`
branches, exact allowed values, POST method/body, no dispatch after 502, one
deduplicated generic warning for the real target origin, and no CORS console
error. The no-service-worker guest fixture observes a real OPTIONS request,
the public relay's advertised preflight names, the narrower effective five-name
projection, an unchanged long JSON `Content-Type`, omission diagnostics, and
no actual dispatch for Authorization or lossy POST.

## Production build and artifact identity

Production build command:

```text
scripts/dev-shell.sh env \
  'VITE_CORS_PROXY_URL=http://127.0.0.1:63339/?' \
  npm --prefix apps/browser-demos run build
```

The build passed. Local acceptance used exact unpublished artifacts rather
than product fallback URLs:

- SpiderMonkey Node Wasm: 30,386,201 bytes,
  SHA-256 `702cc42d40e48f3a45c52ce8ad2aafc2386267f71ce87b2aad922e97feb1790b`;
- Node VFS: `node-vfs.vfs-CqlIeVN9.zst`, 16,034,889 bytes,
  SHA-256 `a8f15eb300a5cfd9a27d1017d8f4fe78e9d1a8ba27a0f857230a2eeec1fdbf34`;
- direct shell base: 5,730,802 bytes,
  SHA-256 `5000efa83ba6f19df259cd497f6f609c25e56bb9ad74df38fcceeeb37cdedcec`;
- bootstrap ZIP: 5,251,369 bytes,
  SHA-256 `26ac98e328573244d3e7c0c149f30114ef5d9c8882200f5a22e56f97d2541482`;
- libyaml bottle: 62,230 bytes,
  SHA-256 `a6100d3ed67a08ac04dce2366e430f62486a96570dc436dbc38c2a8a40f8b6ec`;
- Ruby bottle: 7,156,219 bytes,
  SHA-256 `251cf59d8442ad4412638322e7ee4d22c7518ed0e4b0f888dac482431845b1b7`.

The bootstrap was staged as the exact relative product asset in ignored
`dist/`; the two runtime bottles were served by a test-owned real local proxy.
No package-specific product URL or routing was added.

SpiderMonkey's output revision changed from 11 to 12 because the native patch
changes program bytes. Publication policy requires every reverse-dependent
package whose output bytes change to advance as well, so spidermonkey-node is
revision 5, node is revision 4, and node-vfs is revision 17. The generated
program-package projection carries the complete changed cache-key closure.
After the dependent revision correction, Node Wasm and the rebuilt Node VFS
remained byte-identical to the already accepted local builds; their seals and
receipts were regenerated under the final revisions.

## Exact browser commands and npm evidence

Every Playwright invocation first compared the protected repository output to
its backup and used a distinct `--output /tmp/...` directory. The principal
commands were:

```text
scripts/dev-shell.sh bash -c 'cd apps/browser-demos && \
  npx playwright test test/browser-cors-proxy.spec.ts \
  --project=chromium --output /tmp/kandelo-task3-proxy-full-chromium.bnnu5r'

scripts/dev-shell.sh bash -c 'cd apps/browser-demos && \
  npx playwright test test/browser-cors-proxy.spec.ts \
  --project=firefox --project=webkit \
  --output /tmp/kandelo-task3-proxy-other-engines.sEqVVt'

scripts/dev-shell.sh env KANDELO_PLAYWRIGHT_PORT=5417 \
  KANDELO_PLAYWRIGHT_SERVE_DIST=1 KANDELO_NODE_VFS_STRICT=1 \
  KANDELO_NODE_VFS_SHA256=a8f15eb300a5cfd9a27d1017d8f4fe78e9d1a8ba27a0f857230a2eeec1fdbf34 \
  KANDELO_NODE_LOCAL_BOOT_ASSET_ROOT=/tmp/kandelo-task3-boot-assets \
  KANDELO_NODE_LOCAL_PROXY_PORT=63339 \
  'VITE_CORS_PROXY_URL=http://127.0.0.1:63339/?' bash -c \
  'cd apps/browser-demos && npx playwright test test/kandelo-node.spec.ts \
  --project=chromium --output /tmp/kandelo-task3-npm-revision-final.ZecNmv'
```

The final revision-corrected production run passed 1 of 1 Chromium tests in
30.3 seconds (31.8 seconds including runner setup).

The Node run reached Ready and printed the bounded verbose tail:

```text
KANDELO_REGISTRY=https://registry.npmjs.org/
npm info using npm@10.9.2
npm info using node@v22.0.0
npm http fetch GET 200 https://registry.npmjs.org/cowsay ...
added 41 packages in 9s
npm verbose exit 0
npm info ok
KANDELO_NPM_INSTALL_OK
< Kandelo >
KANDELO_COWSAY_OK
```

The local proxy recorded all registry metadata and tarball requests at HTTP
200. `Accept: application/json` and `Accept: */*` survived where supplied.
Authorization, npm-auth-type, npm-command, pacote-integrity, pacote-pkg-id,
pacote-req-type, and pacote-version were absent at the actual relay boundary.
The product emitted generic omission diagnostics naming the observed set; the
product code contains no Pacote special case. There was no browser CORS error,
no runtime error, and bottle-request counts were unchanged from post-boot to
post-npm and again after cowsay execution.

The normal installed CLI script currently exposes a separate pre-existing
SpiderMonkey main-script relative-require boundary (`Cannot find module
'./index'`). Acceptance therefore executes the freshly installed cowsay public
module API with Node. It produces the same cowsay output without hiding or
changing that loader limitation.

## Other verification

All commands ran through `scripts/dev-shell.sh`:

```text
npm --prefix host run typecheck
# declaration build passed

bash packages/registry/spidermonkey/build-spidermonkey.sh
# native patch applied; SpiderMonkey compiled and linked; js.wasm/node.wasm
# produced at 30,386,201 bytes each

host Vitest focused proxy and TLS source guard
# final source/config boundary: 3 files, 32 tests passed

target/aarch64-apple-darwin/debug/xtask build-deps \
  program-index-context-check --source-repo-root "$(pwd -P)"
# passed with the regenerated final-revision projection

bash scripts/check-abi-version.sh
# ABI snapshot/header/TypeScript bindings in sync; ABI_VERSION consistent

npm run docs:build
# VitePress build passed

bash scripts/ci-check-browser-assets.sh
# deployment contracts passed, final resolution failed because the local
# binary tier lacks programs/wasm32/ruby/ruby.wasm

git diff --check
# passed
```

The product-code search found no npm, Pacote, cowsay, registry-host, or
`proxy.local` special case. `corsProxyUrl` remains only as a local parameter
name in the generic `cors-proxy-url.ts` URL helper, not a runtime option.

## Preservation proof

Before the first Playwright invocation, the pre-existing untracked diagnostics
were copied to `/tmp/kandelo-task3-test-results.s8JMEa/test-results`. Every run
used its own `/tmp` output. Final `diff -qr` is empty and both manifests contain
the same sole file:

```text
91d1c43004802cd49950d78eb11c8fa7d05da8ffffe219a8b13b2f561bc00903  ./.last-run.json
```

Modified `libc/musl`, modified `tests/sortix/os-test`, and untracked `.serena/`
were not edited, staged, or removed.

## Changed files

- application/Vite/service-worker/deploy wiring under `apps/browser-demos/`
  and `scripts/deploy-gh-pages.sh`;
- focused proxy and real-browser tests;
- SpiderMonkey's nonblocking native TLS patch, explicit multi-output local
  install calls, revision 12, reverse-dependent node/spidermonkey-node/node-vfs
  revisions 4/5/17, source guard, and generated package projection;
- `README.md`, `docs/browser-support.md`, `docs/future-improvements.md`,
  `docs/package-management.md`, and the two user-facing docs-site pages;
- this report.

## Tests not run and concerns

- No live Pages validation: the mirror release and current package generation
  are not published.
- No manual GUI claim was made. Playwright exercised the real browsers.
- The broad browser suite was not run beyond the focused proxy cases and exact
  Node acceptance.
- The normal installed cowsay CLI main-script path still exposes the existing
  SpiderMonkey relative-require limitation described above; the installed
  public package API executed successfully.
- Firefox/WebKit do not expose service-worker warning console events through
  the current Playwright listener; their real guest preflight/rejection tests
  passed without weakening shared assertions.
