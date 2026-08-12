# Browser Proxy Boundary Header Filtering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan task by task. Use
> `superpowers:test-driven-development` for every behavior change and
> `superpowers:verification-before-completion` before any completion claim.

**Goal:** Make browser `npm install --verbose cowsay` work through the
currently deployed WordPress Playground CORS proxy by enforcing that proxy's
explicit request-header contract at the one layer that owns the proxy, without
npm-specific behavior or semantic header parsing.

**Architecture:** Replace each loose proxy URL with one immutable
`BrowserCorsProxyConfig` that pairs the URL with its allowed request-header
names and omission mode. Preserve guest fields as ordered occurrences in the
existing HTTP-to-Fetch bridge, and project them by case-insensitive name only
immediately before a request is sent through the configured proxy. Feed the
same complete configuration to the plain Fetch fallback, TLS MITM, lazy VFS
fetcher, service worker, development route, and production build. Direct
browser requests and all Node.js networking remain unfiltered.

**Tech stack:** TypeScript, Vitest, browser Web Workers, service-worker
JavaScript, Vite, Playwright, Bash workflow tests.

## Global Constraints

- Follow the approved design in
  `docs/superpowers/specs/2026-08-11-constrained-browser-proxy-headers-design.md`.
- Preserve Node.js/browser parity except for this documented browser CORS
  transport boundary.
- Never branch on npm, Pacote, cowsay, registry hostnames, header prefixes, or
  response content.
- Do not parse MIME types, range syntax, Fetch CORS-safelisted values, unsafe
  bytes, per-value length, aggregate safelist length, or application meaning.
- Keep the existing HTTP bridge as the only parser. Projection consumes the
  field occurrences that parser already produced.
- Preserve every allowed occurrence and its order. Build Fetch headers with
  `Headers.append()`; never overwrite or value-deduplicate request data.
- Preserve proxy configuration spelling, order, and duplicate names when
  copying it. Membership is ASCII case-insensitive; configuration is not
  request data and is never relayed.
- Apply projection only at an actual proxy dispatch. A successful direct
  browser Fetch receives the unprojected guest request.
- Omit unsupported occurrences only for an anonymous, bodyless `GET` when the
  configured profile explicitly enables omission. Otherwise fail truthfully
  before proxy dispatch.
- Do not implement the WordPress proxy's conditional Authorization opt-in
  protocol in this change. The production profile excludes Authorization and
  both `x-cors-proxy-*` control fields.
- Remove the `proxy.local` npm sentinel, the default npm DNS alias, and
  packument tarball rewriting. Explicit caller-provided aliases remain generic.
- Keep ABI 42 and `abi/snapshot.json` unchanged.
- Run build and verification commands through `scripts/dev-shell.sh`.
- Preserve unrelated worktree changes in `libc/musl`, `tests/sortix/os-test`,
  `.serena/`, and `apps/browser-demos/test-results/`.

---

## Public Interface and File Map

Replace the superseded semantic policy with:

```ts
export type HttpHeaderOccurrence =
  readonly [name: string, value: string];

export interface BrowserCorsProxyConfig {
  readonly url: string;
  readonly allowedRequestHeaderNames: readonly string[];
  readonly allowAnonymousGetHeaderOmission: boolean;
}

export class BrowserCorsProxyRequestError extends Error {}

export function validateBrowserCorsProxyConfig(
  value: BrowserCorsProxyConfig | undefined,
): BrowserCorsProxyConfig | undefined;

export class BrowserCorsProxy {
  constructor(
    config: BrowserCorsProxyConfig,
    onDiagnostic?: (message: string) => void,
  );

  urlFor(targetUrl: string): string;

  project(input: {
    method: string;
    headers: readonly HttpHeaderOccurrence[];
    bodyPresent: boolean;
    targetUrl: string;
  }): Headers;
}
```

`FetchBackendOptions`, `TlsNetworkBackendOptions`, `BrowserKernelOptions`, and
the browser worker initialization protocol replace `corsProxyUrl?: string`
with:

```ts
corsProxy?: BrowserCorsProxyConfig;
```

The two network-backend option types additionally expose:

```ts
onCorsProxyDiagnostic?: (message: string) => void;
```

`BrowserKernelOptions` routes diagnostics through its existing host-diagnostic
channel instead.

The application exports one production profile with exactly these allowed
names:

```text
accept
content-type
git-protocol
wp_blog
wp_install
```

Create:

- `host/src/networking/browser-cors-proxy.ts`
- `host/test/browser-cors-proxy.test.ts`

Delete after replacement:

- `host/src/networking/cors-proxy-request-policy.ts`
- `host/test/cors-proxy-request-policy.test.ts`

Modify the backend, worker, lazy-fetch, application, Vite, service-worker,
browser acceptance, and documentation files named in the tasks below.

---

## Task 1: Replace Semantic Policy with Proxy-Owned Name Projection

**Files:**

- Create: `host/src/networking/browser-cors-proxy.ts`
- Create: `host/test/browser-cors-proxy.test.ts`
- Delete: `host/src/networking/cors-proxy-request-policy.ts`
- Delete: `host/test/cors-proxy-request-policy.test.ts`
- Modify: `host/src/networking/index.ts`
- Modify: `host/src/browser.ts`
- Modify: `host/src/index.ts`

Implement this exact interface:

```ts
export type HttpHeaderOccurrence =
  readonly [name: string, value: string];

export interface BrowserCorsProxyConfig {
  readonly url: string;
  readonly allowedRequestHeaderNames: readonly string[];
  readonly allowAnonymousGetHeaderOmission: boolean;
}

export class BrowserCorsProxyRequestError extends Error {}

export function validateBrowserCorsProxyConfig(
  value: BrowserCorsProxyConfig | undefined,
): BrowserCorsProxyConfig | undefined;

export class BrowserCorsProxy {
  constructor(
    config: BrowserCorsProxyConfig,
    onDiagnostic?: (message: string) => void,
  );

  urlFor(targetUrl: string): string;

  project(input: {
    method: string;
    headers: readonly HttpHeaderOccurrence[];
    bodyPresent: boolean;
    targetUrl: string;
  }): Headers;
}
```

- [ ] Delete the superseded value-aware tests and write failing tests for this
  public interface. Cover configuration copying and freezing while
  retaining URL, spelling, order, and duplicate entries; reject an empty or
  non-HTTP(S) URL and invalid HTTP field-name tokens.

- [ ] Add failing projection tests that prove membership is based only on an
  ASCII case-insensitive name comparison. Use values the superseded policy
  tried to interpret: JSON and multipart `Content-Type`, multi-range `Range`,
  non-ASCII whitespace, control-like text inside values, and values larger
  than 1024 bytes. Allowed names must pass unchanged in every case.

- [ ] Prove the inverse with the same field names: if a name is absent from
  the configured list, it is unsupported even when its value would qualify as
  CORS-safelisted. The explicit profile is the sole source of truth.

- [ ] Add failing tests for repeated allowed occurrences. Assert every value
  is appended in original order and no `set()`, grouping, sorting, or value
  deduplication occurs before Fetch normalization.

- [ ] Add failing tests showing an unsupported name is omitted only from an
  anonymous, bodyless `GET` when omission is enabled. The diagnostic must be
  deterministic, contain the target origin and sorted unique omitted names,
  and be emitted once per origin plus omitted-name set without changing the
  actual occurrence list.

- [ ] Add failing tests showing unsupported Authorization, Cookie, Cookie2,
  or Proxy-Authorization makes a request ineligible for anonymous omission;
  unsupported names on a body-bearing `GET` or another method also fail. An
  allowed-only body-bearing or state-changing request must pass because the
  helper does not judge header or method meaning.

- [ ] Run the new test and confirm RED because the replacement module does not
  exist:

```bash
scripts/dev-shell.sh npm --prefix host test -- --run \
  test/browser-cors-proxy.test.ts
```

- [ ] Implement `validateBrowserCorsProxyConfig()` by copying and freezing the
  object and allowed-name array without reordering or deduplicating it. Keep a
  direct comparison against that preserved list; do not create a normalized
  or deduplicated capability representation merely for lookup.

- [ ] Implement `BrowserCorsProxy.project()` as one ordered pass over header
  occurrences. For an allowed name, call `Headers.append(name, value)` without
  inspecting `value`. Collect unsupported occurrences separately. Do not add
  transport-field parsing; callers pass the same browser-representable
  occurrences they already use to construct Fetch requests.

- [ ] Implement the approved omission and failure rules. Sorting and
  deduplicating names is permitted only for diagnostic/error text. Include the
  proxy boundary and target origin in deterministic errors; do not claim that
  the origin rejected a field.

  Use these stable forms, with diagnostic names ASCII-lowercased, sorted, and
  unique:

```text
Browser CORS proxy omitted unsupported request headers for <origin>: <names>
Browser CORS proxy <proxy-url> cannot relay <METHOD> request to <origin> with unsupported request headers: <names>
```

- [ ] Implement `urlFor()` with the existing generic
  `corsProxyFetchUrl()` helper. Export only the public types, validator, class,
  and error from browser-safe entry points.

- [ ] Require GREEN, type safety, and a clean patch:

```bash
scripts/dev-shell.sh npm --prefix host test -- --run \
  test/browser-cors-proxy.test.ts
scripts/dev-shell.sh npm --prefix host run typecheck
git diff --check
```

- [ ] Commit only Task 1:

```bash
git add host/src/networking/browser-cors-proxy.ts \
  host/src/networking/index.ts host/src/browser.ts host/src/index.ts \
  host/test/browser-cors-proxy.test.ts
git add -u host/src/networking/cors-proxy-request-policy.ts \
  host/test/cors-proxy-request-policy.test.ts
git commit -m "Host: Project headers at the browser proxy boundary"
```

---

## Task 2: Preserve Ordered Fields and Integrate Both Browser Backends

**Sequencing gate:** Execute Tasks 2 and 3 as one implementation/review unit.
Removing `corsProxyUrl` from the backend option before migrating the browser
worker would make the worker's existing property silently ineffective. The
Task 2 backend commit may exist as an internal checkpoint, but Task 2 is not
complete or reviewable until Task 3 has migrated the worker and every caller.

**Files:**

- Modify: `host/src/networking/fetch-backend.ts`
- Modify: `host/src/networking/tls-network-backend.ts`
- Modify: `host/test/fetch-backend.test.ts`
- Modify: `host/test/tls-network-backend-real-client.test.ts`

- [ ] Add failing parser/dispatch tests for repeated guest fields in both
  backends. The parsed representation must be an ordered
  `HttpHeaderOccurrence[]`; field-name spelling, values, and same-name order
  survive until `Headers.append()` hands them to Fetch.

- [ ] Add a narrow case-insensitive lookup assertion for `Host`. Preserve the
  current last-occurrence behavior of the former `Map` without turning the
  occurrence list back into a map or performing any new `Connection`, MIME,
  Range, CORS, or application parsing.

- [ ] Add failing `FetchNetworkBackend` tests that capture all Fetch calls.
  The first direct attempt must receive every browser-representable occurrence
  without proxy projection. If and only if that Fetch throws, the fallback URL
  and headers must come from one `BrowserCorsProxy` instance.

- [ ] Add failing `TlsNetworkBackend` tests showing decrypted HTTPS and plain
  HTTP use the same projection immediately before configured proxy dispatch.
  Cover allowed repeats, anonymous GET omission, diagnostic deduplication, and
  truthful rejection. A rejected request must never reach the Fetch spy and
  must use the backend's existing deterministic guest-visible error channel.

- [ ] Add regressions proving an explicitly configured DNS alias still routes
  generically, constructing the backend without aliases no longer resolves
  `proxy.local`, and npm-looking JSON response bytes are never rewritten.

- [ ] Run the focused suite and confirm the new expectations fail:

```bash
scripts/dev-shell.sh npm --prefix host test -- --run \
  test/browser-cors-proxy.test.ts \
  test/fetch-backend.test.ts \
  test/tls-network-backend-real-client.test.ts
```

- [ ] Change each existing HTTP parser's header result from
  `Map<string, string>` to an ordered occurrence list. Keep request-line and
  body-framing logic otherwise unchanged. Replace only the former map lookups
  with narrow helpers and construct direct Fetch headers with `append()`.

- [ ] Construct and validate one proxy object per backend lifetime from
  `options.corsProxy`. In `FetchNetworkBackend`, project only inside the proxy
  fallback after direct Fetch throws. In `TlsNetworkBackend`, project only
  after code has selected the configured proxy URL for plain HTTP or decrypted
  HTTPS.

- [ ] Preserve the existing bridge-owned omission of `Host` and `Connection`
  when constructing browser Fetch headers. Pass that already-browser-
  representable ordered list into projection. Do not add a second parser or
  expand transport-header policy as part of this fix.

- [ ] Remove the default `proxy.local` alias, `isNpmRegistry`, packument JSON
  tarball rewriting, and npm-specific comments. Keep explicit caller aliases
  and the generic URL-rewrite behavior they already own.

- [ ] Require GREEN, type safety, absence of runtime sentinels, and a clean
  patch:

```bash
scripts/dev-shell.sh npm --prefix host test -- --run \
  test/browser-cors-proxy.test.ts \
  test/fetch-backend.test.ts \
  test/tls-network-backend-real-client.test.ts
scripts/dev-shell.sh npm --prefix host run typecheck
if rg -n "proxy\.local|isNpmRegistry|Packument|tarball.*rewrite" host/src; then
  exit 1
fi
git diff --check
```

- [ ] Commit only Task 2:

```bash
git add host/src/networking/fetch-backend.ts \
  host/src/networking/tls-network-backend.ts \
  host/test/fetch-backend.test.ts \
  host/test/tls-network-backend-real-client.test.ts
git commit -m "Host: Enforce proxy headers at browser dispatch"
```

---

## Task 3: Carry One Immutable Configuration Through Worker and Callers

**Combined gate with Task 2:** This task closes the load-bearing option
migration begun by Task 2. Generate one review package from the Task 2 base
through the Task 3 head and require both briefs to pass the same review before
marking either task complete.

**Files:**

- Modify: `host/src/browser-kernel-host.ts`
- Modify: `host/src/browser-kernel-protocol.ts`
- Modify: `host/src/browser-kernel-worker-entry.ts`
- Modify: `host/src/vfs/browser-lazy-fetcher.ts`
- Modify: `packages/registry/program-packages.json`
- Modify: `homebrew/test/homebrew_guest_lifecycle_browser.ts`
- Modify: `apps/browser-demos/lib/browser-cors-proxy.ts`
- Modify: `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts`
- Modify: `apps/browser-demos/pages/test-runner/main.ts`
- Modify: `apps/browser-demos/pages/homebrew-vfs-test/main.ts`
- Modify: `host/test/browser-kernel.test.ts`
- Modify: `host/test/browser-lazy-fetcher.test.ts`
- Modify: `host/test/host-diagnostic-routing.test.ts`
- Modify: `host/test/browser-demo-cors-proxy.test.ts`
- Modify: `apps/browser-demos/test/kandelo-merge-gate.spec.ts`
- Modify: `apps/browser-demos/test/kandelo-homebrew-main-shell.spec.ts`

- [ ] Add failing host tests that inspect the browser worker initialization
  message. Assert `BrowserKernelOptions.corsProxy` contains the URL and full
  profile, its allowed-name array retains spelling/order/duplicates, caller
  mutation after construction cannot change the message, and malformed
  configuration fails before worker startup.

- [ ] Add failing worker-wiring coverage showing the exact serialized
  configuration is validated inside the worker and then supplied to both
  `TlsNetworkBackend` and `createBrowserLazyFetcher()`. Neither consumer may
  receive a separately reconstructed URL-only option.

- [ ] Add failing lazy-fetcher tests for the new configuration argument.
  Same-origin requests remain direct. External HTTP(S) artifacts use
  `corsProxy.url`, retain `credentials: "omit"` and
  `referrerPolicy: "no-referrer"`, and send no caller request headers, so
  header projection is a deliberate no-op.

- [ ] Add a failing diagnostic-routing assertion that backend omission is
  reported through the existing host diagnostic path at warning level with
  PID 0 and source `browser CORS proxy`. Do not add a demo-only console shim.

- [ ] Replace the URL-only application tests with failing tests for one
  deeply immutable `DEFAULT_BROWSER_CORS_PROXY_CONFIG`. Assert its URL is the
  WordPress Playground proxy, omission is enabled, and its allowed-name array
  is exactly `accept`, `content-type`, `git-protocol`, `wp_blog`, and
  `wp_install`, in that order. Assert it excludes Authorization and both
  `x-cors-proxy-*` control names.

- [ ] Add failing resolution tests for `resolveBrowserCorsProxyConfig()`.
  Production, an explicit deployment URL, and the Vite development route must
  differ only in the resolved URL; every result retains the same allowed-name
  profile and omission setting.

- [ ] Add failing application assertions that every `BrowserKernel`
  construction which uses a proxy receives one complete config. The guest npm
  registry must be `https://registry.npmjs.org/`; `proxy.local` must be absent;
  and development/test pages must construct the same declared profile around
  their same-origin proxy URL.

- [ ] Run the focused tests and confirm RED:

```bash
scripts/dev-shell.sh npm --prefix host test -- --run \
  test/browser-kernel.test.ts \
  test/browser-lazy-fetcher.test.ts \
  test/browser-demo-cors-proxy.test.ts \
  test/host-diagnostic-routing.test.ts
scripts/dev-shell.sh bash -c 'cd apps/browser-demos && \
  npx playwright test test/kandelo-merge-gate.spec.ts \
  --project=chromium'
```

- [ ] Replace `corsProxyUrl` with `corsProxy` in `BrowserKernelOptions` and the
  worker initialization protocol. Validate and copy on the host side before
  `postMessage`; validate and copy again after structured cloning in the
  worker. Never retain caller-owned arrays.

- [ ] Pass that worker-owned configuration to `TlsNetworkBackend` and the lazy
  fetcher. Route `BrowserCorsProxy` diagnostics into the existing diagnostic
  ring and console-warning path without changing Node host behavior.

- [ ] Update `createBrowserLazyFetcher()` to accept the complete configuration
  while using only its URL for today's headerless fetch. Do not invent request
  headers, add policy parsing, or alter digest, size, caching, abort, and CORS
  behavior.

- [ ] Because `host/src/vfs` is a declared build input of shell and derived
  VFS packages, first prove `program-index-context-check` rejects the stale
  committed projection, then regenerate
  `packages/registry/program-packages.json` with the canonical xtask command.
  Accept the resulting contextual cache-key propagation; do not narrow
  declared package inputs merely to avoid truthful invalidation.

- [ ] Update the shared Homebrew browser lifecycle adapter to accept and pass
  the same complete configuration to `BrowserKernel`. Its direct fixture and
  source downloads remain headerless, so URL wrapping uses `corsProxy.url`
  without a separate capability declaration or new header behavior.

- [ ] Export `DEFAULT_BROWSER_CORS_PROXY_CONFIG` and
  `resolveBrowserCorsProxyConfig()` from the application config module. Copy
  and freeze resolved objects through the host validator; do not export a
  second authoritative loose URL. An explicit `VITE_CORS_PROXY_URL` remains a
  URL override for this same profile.

- [ ] Update live setup, test runner, Homebrew VFS test page, the shared
  Homebrew browser adapter, and their tests to pass complete configuration
  objects. Restore npm's canonical HTTPS registry and delete sentinel comments
  and assertions.

- [ ] Require GREEN, type safety, and no obsolete worker option:

```bash
scripts/dev-shell.sh npm --prefix host test -- --run \
  test/browser-kernel.test.ts \
  test/browser-lazy-fetcher.test.ts \
  test/browser-demo-cors-proxy.test.ts \
  test/host-diagnostic-routing.test.ts \
  test/fetch-backend.test.ts
scripts/dev-shell.sh npm --prefix host run typecheck
scripts/dev-shell.sh npm --prefix apps/browser-demos run build
scripts/dev-shell.sh bash -c 'host_target=$(rustc -vV | awk '\''/^host:/ { print $2 }'\''); \
  target/$host_target/release/xtask build-deps \
  program-index-context-check --source-repo-root "$PWD"'
scripts/dev-shell.sh bash -c 'cd apps/browser-demos && \
  npx playwright test test/kandelo-merge-gate.spec.ts \
  --project=chromium'
if rg -n "corsProxyUrl" \
  host/src/browser-kernel-host.ts \
  host/src/browser-kernel-protocol.ts \
  host/src/browser-kernel-worker-entry.ts \
  host/src/vfs/browser-lazy-fetcher.ts \
  packages/registry/program-packages.json \
  homebrew/test/homebrew_guest_lifecycle_browser.ts \
  apps/browser-demos/lib apps/browser-demos/pages; then
  exit 1
fi
git diff --check
```

- [ ] Commit only Task 3:

```bash
git add host/src/browser-kernel-host.ts \
  host/src/browser-kernel-protocol.ts \
  host/src/browser-kernel-worker-entry.ts \
  host/src/vfs/browser-lazy-fetcher.ts \
  packages/registry/program-packages.json \
  homebrew/test/homebrew_guest_lifecycle_browser.ts \
  apps/browser-demos/lib/browser-cors-proxy.ts \
  apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts \
  apps/browser-demos/pages/test-runner/main.ts \
  apps/browser-demos/pages/homebrew-vfs-test/main.ts \
  host/test/browser-kernel.test.ts \
  host/test/browser-lazy-fetcher.test.ts \
  host/test/host-diagnostic-routing.test.ts \
  host/test/browser-demo-cors-proxy.test.ts \
  apps/browser-demos/test/kandelo-merge-gate.spec.ts \
  apps/browser-demos/test/kandelo-homebrew-main-shell.spec.ts
git commit -m "Browser: Share one CORS proxy configuration"
```

---

## Task 4: Apply the Same Profile in the Application and Service Worker

**Files:**

- Modify: `apps/browser-demos/vite.config.ts`
- Modify: `apps/browser-demos/public/service-worker.js`
- Modify: `scripts/deploy-gh-pages.sh`
- Modify: `host/test/browser-demo-cors-proxy.test.ts`
- Modify: `apps/browser-demos/test/browser-cors-proxy.spec.ts`

- [ ] Add failing source/build tests showing Vite injects the complete object
  into the service worker through `__CORS_PROXY_CONFIG__`. Remove the
  independent URL fallback from the raw service-worker source so an
  uninjected file cannot silently acquire a drifting capability profile.

- [ ] Add failing service-worker contract tests for both actual proxy
  boundaries: an already-wrapped proxy request and a browser-owned
  cross-origin request. In both cases, allowed names are appended by
  case-insensitive membership only; arbitrary values are untouched;
  unsupported anonymous GET fields are omitted with a deduplicated warning;
  and an ineligible lossy request produces a deterministic 502 without a
  network Fetch.

- [ ] Assert the service worker preserves the original method and body when
  all occurrences are allowed. Its `Request.headers` input may already be
  normalized by Fetch, but it must not add MIME, Range, CORS-safelist, package,
  or prefix interpretation. Keep existing response wrapping and
  cross-origin-isolation behavior unchanged.

- [ ] Ensure every outer request sent to the configured proxy uses
  `credentials: "omit"`. This is transport hygiene for the proxy connection,
  not an interpretation or rewrite of guest header values.

- [ ] Run focused tests and confirm RED:

```bash
scripts/dev-shell.sh npm --prefix host test -- --run \
  test/browser-demo-cors-proxy.test.ts \
  test/browser-kernel.test.ts
scripts/dev-shell.sh bash -c 'cd apps/browser-demos && \
  npx playwright test test/browser-cors-proxy.spec.ts \
  --project=chromium'
```

- [ ] Replace Vite's URL placeholder with JSON serialization of the complete
  resolved config in development, preview, and production output. An explicit
  `VITE_CORS_PROXY_URL` is a URL override for the same declared profile, not a
  request to infer new capabilities from a hostname.

- [ ] Update `scripts/deploy-gh-pages.sh` to verify that the built service
  worker contains the configured URL and the exact injected allowed-name
  profile, and that `__CORS_PROXY_CONFIG__` is absent. Keep
  `VITE_CORS_PROXY_URL` as a URL override for the fixed application profile.

- [ ] Implement the classic-service-worker projection locally because it
  runs in a separate realm, but keep the configuration authoritative: the
  injected object is its only profile. Mirror only the small name-membership,
  omission, error, and diagnostic algorithm, then test it against the host
  cases so the two implementations cannot drift silently.

- [ ] Require GREEN, a successful browser build, no loose runtime option or
  sentinel, and a clean patch:

```bash
scripts/dev-shell.sh npm --prefix host test -- --run \
  test/browser-demo-cors-proxy.test.ts \
  test/browser-kernel.test.ts
scripts/dev-shell.sh npm --prefix apps/browser-demos run build
scripts/dev-shell.sh bash -c 'cd apps/browser-demos && \
  npx playwright test test/browser-cors-proxy.spec.ts \
  --project=chromium'
if rg -n "corsProxyUrl|proxy\.local|isNpmRegistry|Packument" \
  host/src/browser-kernel-host.ts \
  host/src/browser-kernel-protocol.ts \
  host/src/browser-kernel-worker-entry.ts \
  host/src/networking/fetch-backend.ts \
  host/src/networking/tls-network-backend.ts \
  host/src/vfs/browser-lazy-fetcher.ts \
  homebrew/test/homebrew_guest_lifecycle_browser.ts \
  apps/browser-demos/lib apps/browser-demos/pages \
  apps/browser-demos/public; then
  exit 1
fi
git diff --check
```

- [ ] Commit only Task 4:

```bash
git add apps/browser-demos/vite.config.ts \
  apps/browser-demos/public/service-worker.js \
  scripts/deploy-gh-pages.sh \
  host/test/browser-demo-cors-proxy.test.ts \
  apps/browser-demos/test/browser-cors-proxy.spec.ts
git commit -m "Browser: Declare the deployed proxy boundary"
```

---

## Task 5: Prove Real Preflight, Service-Worker, and npm Behavior

**Files:**

- Modify: `apps/browser-demos/pages/test-runner/main.ts`
- Modify: `apps/browser-demos/test/browser-cors-proxy.spec.ts`
- Modify: `apps/browser-demos/test/kandelo-node.spec.ts`

- [ ] Extend the test runner's test-only `__runTest` input with an optional
  complete `BrowserCorsProxyConfig`. Do not expose a URL-only override and do
  not change production selection through this seam.

- [ ] Extend the existing service-worker regressions with a failing direct
  cross-origin proxy fixture for the guest backend. Bind an ephemeral Node
  HTTP server to loopback, record
  every `OPTIONS` and actual request, and advertise the deployed PHP's current
  preflight list:

```text
Accept, Authorization, Content-Type, git-protocol, wp_blog, wp_install,
x-cors-proxy-allowed-request-headers, x-cors-proxy-content-type
```

  Return a matching `Access-Control-Allow-Origin` and the requested method,
  but model unconditional relay using Kandelo's narrower five-name profile.
  Close the server in `finally`.

- [ ] Add a failing Chromium test that boots the guest network backend with
  this fixture and sends an anonymous bodyless GET containing an allowed
  `git-protocol` occurrence and arbitrary unsupported metadata. Prove the
  browser completes preflight, the allowed value reaches the proxy unchanged,
  the unsupported name does not, and exactly one generic omission diagnostic
  is observable. Fixture and assertions must not recognize npm or Pacote.

- [ ] Add failing cases with values that look non-safelisted to Fetch, such as
  JSON `Content-Type` and a long allowed value. They must still be relayed
  because the configured proxy, not Kandelo, owns whether the browser's
  preflight accepts the name.

- [ ] Add failing negative cases for unsupported Authorization and an
  unsupported field on a body-bearing or non-GET request. Require a
  deterministic guest-visible failure and prove no actual proxy request was
  dispatched after any preflight/setup traffic.

- [ ] Retain Task 4's service-worker-controlled cases for both branches in
  `fetchCrossOrigin()` while adding this no-service-worker guest-backend
  fixture. Together they prove the same profile at both proxy boundaries.

- [ ] Run the focused browser contract and confirm RED:

```bash
scripts/dev-shell.sh bash -c 'cd apps/browser-demos && \
  npx playwright test test/browser-cors-proxy.spec.ts \
  --project=chromium'
```

- [ ] Implement only the test seam and fixture behavior required above. Do not
  loosen the production profile, bypass the normal guest socket/TLS path, or
  special-case the test target.

- [ ] Update the slow Node demo acceptance to boot the exact canonical Node
  VFS, assert `npm_config_registry=https://registry.npmjs.org/`, run
  `npm install --verbose cowsay`, require exit status zero, execute the
  installed command, reject any browser CORS console error, and require a
  generic proxy-omission diagnostic. Do not assert a specific `pacote-*` name,
  because Pacote metadata can change independently.

- [ ] Require the focused Chromium tests to pass:

```bash
scripts/dev-shell.sh bash -c 'cd apps/browser-demos && npx playwright test \
  test/browser-cors-proxy.spec.ts \
  test/kandelo-node.spec.ts \
  --project=chromium'
```

- [ ] Run the generic proxy contract in Firefox and WebKit. If a real browser
  capability boundary prevents a case, document the exact boundary rather
  than weakening the shared assertion silently:

```bash
scripts/dev-shell.sh bash -c 'cd apps/browser-demos && npx playwright test \
  test/browser-cors-proxy.spec.ts \
  --project=firefox --project=webkit'
```

- [ ] Commit only Task 5:

```bash
git add apps/browser-demos/pages/test-runner/main.ts \
  apps/browser-demos/test/browser-cors-proxy.spec.ts \
  apps/browser-demos/test/kandelo-node.spec.ts
git commit -m "Browser: Prove constrained proxy requests end to end"
```

---

## Task 6: Document, Validate, and Review the Temporary Boundary

**Files:**

- Modify: `docs/browser-support.md`
- Modify: `docs/future-improvements.md`
- Modify: `README.md`
- Modify: `docs-site/guide/current-ui.md`
- Modify: `docs-site/reference/troubleshooting.md`
- Modify documentation index/check files only if repository checks require it

- [ ] Update `docs/browser-support.md` with the implemented behavior: one
  configured browser proxy profile, name-only projection at every proxy
  dispatch, anonymous bodyless GET omission with diagnostics, truthful
  failures for other lossy requests, and unchanged direct/Node networking.
  Describe this as a browser transport limitation, not full HTTP or POSIX
  fidelity.

- [ ] Update the README and published docs wherever they describe
  `VITE_CORS_PROXY_URL`. Explain that it overrides only the URL and therefore
  the alternate proxy must honor the same declared request-header profile.
  Replace the old service-worker `__CORS_PROXY_URL__` description with the
  complete `__CORS_PROXY_CONFIG__` injection contract.

- [ ] Add explicit future work for removing this temporary profile through a
  reviewed lossless transport or upstream proxy repair. Cover Authorization
  opt-in, authentication, all supported methods, conditional and Range
  requests, redirects, request/response streaming, size and timeout limits,
  rate limiting, abuse prevention, private-network controls, and Node/browser
  parity. State that landing it removes omission mode and its diagnostic.
  Retain the separate existing future-work contract for downloaded,
  historical, or persisted lazy images; this rebuild-only change does not
  claim that compatibility.

- [ ] Run formatting/type/build checks and focused host evidence:

```bash
scripts/dev-shell.sh npm --prefix host run typecheck
scripts/dev-shell.sh npm --prefix host test -- --run \
  test/browser-cors-proxy.test.ts \
  test/fetch-backend.test.ts \
  test/tls-network-backend-real-client.test.ts \
  test/browser-kernel.test.ts \
  test/browser-lazy-fetcher.test.ts \
  test/browser-demo-cors-proxy.test.ts \
  test/host-diagnostic-routing.test.ts
scripts/dev-shell.sh npm --prefix apps/browser-demos run build
git diff --check
```

- [ ] Run the repository's broad host, browser, asset, workflow, docs, and ABI
  checks. These support the cross-host and publication claims affected by the
  overall worktree:

```bash
scripts/dev-shell.sh bash scripts/ci-run-test-suite.sh vitest
scripts/dev-shell.sh bash scripts/ci-run-test-suite.sh browser
scripts/dev-shell.sh bash scripts/ci-check-browser-assets.sh
scripts/dev-shell.sh bash tests/scripts/ci-run-test-suite-groups.test.sh
scripts/dev-shell.sh npm run docs:build
scripts/dev-shell.sh bash scripts/check-abi-version.sh
```

- [ ] Re-run the focused three-engine proxy contract and the slow Chromium npm
  acceptance against the exact staged/canonical Node image produced by the
  publication work. Record the VFS identity and publication revision; do not
  substitute a local image while claiming deployed behavior.

```bash
scripts/dev-shell.sh bash -c 'cd apps/browser-demos && npx playwright test \
  test/browser-cors-proxy.spec.ts \
  --project=chromium --project=firefox --project=webkit'
scripts/dev-shell.sh bash -c 'cd apps/browser-demos && npx playwright test \
  test/kandelo-node.spec.ts \
  --project=chromium'
```

- [ ] Manually run `./run.sh browser`, open the Node demo, run
  `npm install --verbose cowsay`, execute the installed command, and record
  exit codes, the omission diagnostic, absence of CORS console errors, total
  lazy download behavior, and served Node VFS identity.

- [ ] Review the final branch for forbidden product special cases, obsolete
  URL-only configuration, and ABI changes:

```bash
rg -n "pacote|cowsay|proxy\.local|isNpmRegistry|corsProxyUrl" \
  host/src apps/browser-demos/lib apps/browser-demos/pages \
  apps/browser-demos/public
git diff -- abi/snapshot.json crates/shared/src/lib.rs
git diff --check
```

- [ ] Commit documentation and any test-only corrections:

```bash
git add README.md docs/browser-support.md docs/future-improvements.md \
  docs-site/guide/current-ui.md \
  docs-site/reference/troubleshooting.md
git commit -m "Docs: Record the constrained browser proxy boundary"
```

- [ ] Invoke `superpowers:requesting-code-review`, address technically valid
  findings with fresh tests, then invoke
  `superpowers:verification-before-completion`. Report every command and
  result, browser engines covered, manual evidence, live publication state,
  and any suite not run. Because this work changes no kernel, libc, syscall,
  or ABI behavior, libc/POSIX/Sortix suites are not required unless the final
  diff expands into those contracts; say explicitly if they were not run.

The final live npm claim is gated on the publication/activation work serving
the corrected canonical Node VFS. Passing against an unpublished local asset
is useful implementation evidence but is not evidence that the deployed demo
is repaired.
