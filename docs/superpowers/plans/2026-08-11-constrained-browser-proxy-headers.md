# Constrained Browser Proxy Headers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make browser HTTP proxying work with the production WordPress Playground CORS proxy without npm-specific behavior, while failing truthfully whenever the proxy cannot preserve request semantics.

**Architecture:** Add one immutable, value-aware proxy capability policy shared by the browser plain-HTTP and TLS backends. Apply it only when dispatching through a configured proxy, route omissions through existing host diagnostics, remove the `proxy.local` npm alias and packument rewrite, and configure Pages with the deployed proxy's exact contract. Node networking and direct browser fetches remain unchanged.

**Tech Stack:** TypeScript, Vitest, Playwright, browser Web Workers, existing Kandelo HTTP/TLS bridge, Bash workflow tests.

## Global Constraints

- Follow the approved design in
  `docs/superpowers/specs/2026-08-11-constrained-browser-proxy-headers-design.md`.
- Preserve Node.js/browser parity except for this documented browser CORS
  transport boundary.
- Never branch on npm, Pacote, cowsay, registry hostnames, header prefixes, or
  response content.
- Never send credentials through the configured public proxy.
- Do not project headers on a successful direct browser fetch.
- Do not change the external lazy-VFS fetcher; it does not forward guest HTTP
  headers.
- Keep ABI 42 and `abi/snapshot.json` unchanged.
- Run build and verification commands through `scripts/dev-shell.sh`.
- Preserve unrelated worktree changes in `libc/musl`, `tests/sortix/os-test`,
  `.serena/`, and `apps/browser-demos/test-results/`.

---

## File Map and Interfaces

Create:

- `host/src/networking/cors-proxy-request-policy.ts` — validates immutable
  capabilities and projects a guest request onto a proxy-representable fetch.
- `host/test/cors-proxy-request-policy.test.ts` — focused value, security,
  omission, and deduplication tests.

Modify:

- `host/src/networking/index.ts`, `host/src/browser.ts`, `host/src/index.ts` —
  export the capability and policy types needed by embedders.
- `host/src/networking/fetch-backend.ts` — apply the policy only in the
  exception-driven proxy fallback.
- `host/src/networking/tls-network-backend.ts` — use the same policy for
  proxied decrypted HTTPS and plain HTTP; remove npm-specific routing.
- `host/src/browser-kernel-host.ts`, `host/src/browser-kernel-protocol.ts`,
  `host/src/browser-kernel-worker-entry.ts` — copy and validate capabilities
  across the worker boundary and route one diagnostic callback.
- `host/test/fetch-backend.test.ts`, `host/test/browser-kernel.test.ts` — prove
  backend parity, direct-fetch preservation, worker copying, and failures.
- `apps/browser-demos/lib/browser-cors-proxy.ts` — pair the default proxy URL
  with its exact immutable capability declaration.
- `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts` — pass
  capabilities and restore npm's canonical HTTPS registry.
- `apps/browser-demos/pages/test-runner/main.ts` and
  `apps/browser-demos/pages/homebrew-vfs-test/main.ts` — pass the declared
  capability wherever the demo creates a browser kernel with that proxy.
- `apps/browser-demos/test/browser-cors-proxy.spec.ts` — host a real
  cross-origin preflight fixture matching production.
- `apps/browser-demos/test/kandelo-node.spec.ts` — require install, execution,
  and the generic omission diagnostic.
- `apps/browser-demos/test/kandelo-merge-gate.spec.ts` — remove expectations
  for `proxy.local`.
- `docs/browser-support.md`, `docs/future-improvements.md` — document the
  temporary boundary and full-fidelity follow-up.

The public configuration contract is:

```ts
export interface CorsProxyRequestCapabilities {
  readonly methods: readonly string[];
  readonly requestHeaders: readonly string[];
  readonly allowAnonymousGetHeaderOmission: boolean;
}

export interface ValidatedCorsProxyRequestCapabilities {
  readonly methods: readonly string[];
  readonly requestHeaders: readonly string[];
  readonly allowAnonymousGetHeaderOmission: boolean;
}

export interface CorsProxyRequestProjection {
  readonly headers: Headers;
  readonly omittedHeaders: readonly string[];
}

export class CorsProxyRequestPolicyError extends Error {}

export function validateCorsProxyRequestCapabilities(
  proxyUrl: string | undefined,
  value: CorsProxyRequestCapabilities | undefined,
): ValidatedCorsProxyRequestCapabilities | undefined;

export class CorsProxyRequestPolicy {
  constructor(
    capabilities: ValidatedCorsProxyRequestCapabilities,
    onDiagnostic?: (message: string) => void,
  );

  project(input: {
    method: string;
    headers: Headers;
    bodyPresent: boolean;
    targetUrl: string;
  }): CorsProxyRequestProjection;
}
```

`FetchBackendOptions` and `TlsNetworkBackendOptions` gain:

```ts
corsProxyRequestCapabilities?: CorsProxyRequestCapabilities;
onCorsProxyDiagnostic?: (message: string) => void;
```

Capabilities without a proxy URL are invalid. A proxy URL without capabilities
preserves the existing unprojected behavior for third-party embedders.

---

## Task 1: Define and Test the Shared Proxy Policy

**Files:**

- Create: `host/src/networking/cors-proxy-request-policy.ts`
- Create: `host/test/cors-proxy-request-policy.test.ts`
- Modify: `host/src/networking/index.ts`
- Modify: `host/src/browser.ts`
- Modify: `host/src/index.ts`

- [ ] Write failing validation tests for uppercase method normalization,
  lowercase header normalization, frozen copied arrays, invalid HTTP tokens,
  duplicate normalized values, capability-without-URL rejection, and caller
  mutation after validation.

- [ ] Write failing projection tests for:
  - value-valid `Accept`, `Accept-Language`, `Content-Language`,
    `Content-Type`, and single-range `Range` safelisted headers;
  - configured headers such as `git-protocol`;
  - value-invalid safelist candidates, including unsafe bytes and non-simple
    content types;
  - `Connection`-nominated headers and fixed hop-by-hop/transport headers;
  - credential rejection for `authorization`, `cookie`, `cookie2`, and
    `proxy-authorization`;
  - anonymous bodyless `GET` omission with sorted names;
  - body-bearing `GET`, `POST`, `PUT`, and unsupported `HEAD` rejection;
  - no fetch policy decision based on target hostname or header prefix; and
  - one diagnostic per target origin plus sorted omitted-header set.

- [ ] Run the new test and confirm it fails because the module does not yet
  exist:

```bash
scripts/dev-shell.sh npm --prefix host test -- --run \
  test/cors-proxy-request-policy.test.ts
```

- [ ] Implement strict capability validation. Copy, normalize, sort, and
  freeze methods and header names. Reject empty entries, invalid RFC HTTP-token
  characters, duplicates after normalization, and inconsistent URL/capability
  configuration.

- [ ] Implement value-aware CORS safelist checks. Treat only these names as
  candidates: `accept`, `accept-language`, `content-language`, `content-type`,
  and `range`; enforce Fetch's byte, MIME-type, length, and single-range rules.

- [ ] Strip outer transport headers before classification: `host`,
  `connection`, `content-length`, `keep-alive`, `proxy-authenticate`, `te`,
  `trailer`, `transfer-encoding`, `upgrade`, plus every name nominated by the
  guest `Connection` value.

- [ ] Reject credentials before considering the configured allowlist. For an
  eligible anonymous bodyless `GET`, omit the remaining unsupported names and
  emit exactly:

```text
Browser CORS proxy omitted unsupported request headers for https://registry.example: x-client-trace
```

- [ ] Reject unsupported methods and every lossy non-eligible request with
  `CorsProxyRequestPolicyError`. Include the method, target origin, and sorted
  unsupported names in deterministic error messages.

- [ ] Export the public types and validator from browser-safe entrypoints, but
  keep implementation-only helpers private.

- [ ] Re-run the focused test and require it to pass:

```bash
scripts/dev-shell.sh npm --prefix host test -- --run \
  test/cors-proxy-request-policy.test.ts
```

- [ ] Commit this task:

```bash
git add host/src/networking/cors-proxy-request-policy.ts \
  host/src/networking/index.ts host/src/browser.ts host/src/index.ts \
  host/test/cors-proxy-request-policy.test.ts
git commit -m "Host: Model constrained browser proxy requests"
```

---

## Task 2: Integrate the Policy into Both Browser Network Paths

**Files:**

- Modify: `host/src/networking/fetch-backend.ts`
- Modify: `host/src/networking/tls-network-backend.ts`
- Modify: `host/test/fetch-backend.test.ts`

- [ ] Add failing tests that capture all `fetch()` calls and prove the plain
  backend first attempts the original URL with the original guest headers,
  then projects only its proxy fallback after direct fetch throws.

- [ ] Add failing TLS-path tests proving decrypted HTTPS and non-TLS HTTP use
  the same projection, omission diagnostic, credential rejection, unsupported
  method rejection, and deterministic 502 response body. Assert rejected
  requests never reach the fetch spy.

- [ ] Add a regression test showing a configured `dnsAliases` entry still
  routes generically, but constructing `TlsNetworkBackend` without aliases no
  longer resolves `proxy.local`.

- [ ] Add a regression test that a JSON response containing npm-style tarball
  text is returned byte-for-byte; it must not be rewritten.

- [ ] Run the focused suite and record the expected failures:

```bash
scripts/dev-shell.sh npm --prefix host test -- --run \
  test/fetch-backend.test.ts
```

- [ ] Construct one validated policy per backend lifetime when both URL and
  capabilities are present. Invoke `project()` immediately before the proxied
  fetch, and pass the projected headers without mutating the parsed guest
  `Headers` object.

- [ ] In `FetchNetworkBackend`, retain the direct request exactly as today.
  Only after its exception should the proxy policy run.

- [ ] In `TlsNetworkBackend`, use one helper for the decrypted HTTPS and plain
  HTTP dispatch paths so status and error wording cannot drift. Preserve the
  existing rule that GET/HEAD fetches do not carry a body.

- [ ] Remove the default `{ "proxy.local": "https://registry.npmjs.org" }`
  alias, `isNpmRegistry`, the packument body rewrite, and npm-specific comments.
  Keep explicitly supplied aliases.

- [ ] Re-run the focused backend and policy tests:

```bash
scripts/dev-shell.sh npm --prefix host test -- --run \
  test/cors-proxy-request-policy.test.ts \
  test/fetch-backend.test.ts \
  test/tls-network-backend-real-client.test.ts
```

- [ ] Commit this task:

```bash
git add host/src/networking/fetch-backend.ts \
  host/src/networking/tls-network-backend.ts \
  host/test/fetch-backend.test.ts
git commit -m "Host: Enforce proxy capabilities on browser fetches"
```

---

## Task 3: Carry Immutable Capabilities Across the Browser Worker Boundary

**Files:**

- Modify: `host/src/browser-kernel-host.ts`
- Modify: `host/src/browser-kernel-protocol.ts`
- Modify: `host/src/browser-kernel-worker-entry.ts`
- Modify: `host/test/browser-kernel.test.ts`

- [ ] Add failing host tests that inspect the worker initialization message.
  Prove capability arrays are copied and normalized, callers cannot change the
  worker configuration by mutating their original object, a capability without
  `corsProxyUrl` throws before worker startup, and URL-only configuration
  remains accepted.

- [ ] Add a failing structural/runtime test showing a backend omission is sent
  through `reportHostDiagnostic()` as a warning with this stable source:

```ts
{
  pid: 0,
  source: "browser CORS proxy",
  message,
}
```

- [ ] Run the focused worker tests and verify the new assertions fail:

```bash
scripts/dev-shell.sh npm --prefix host test -- --run \
  test/browser-kernel.test.ts \
  test/host-diagnostic-routing.test.ts
```

- [ ] Add `corsProxyRequestCapabilities` to `BrowserKernelOptions` and the
  worker initialization protocol. Validate it in the host before cloning it
  into the worker message; never retain caller-owned mutable arrays.

- [ ] Pass the validated capability into `TlsNetworkBackend` in
  `browser-kernel-worker-entry.ts`. Route `onCorsProxyDiagnostic` through the
  existing diagnostic ring and warning-level console path with PID 0.

- [ ] Keep lazy VFS fetch setup unchanged: only guest network backends receive
  the request-header capability.

- [ ] Re-run the tests and require them to pass:

```bash
scripts/dev-shell.sh npm --prefix host test -- --run \
  test/browser-kernel.test.ts \
  test/host-diagnostic-routing.test.ts \
  test/fetch-backend.test.ts
```

- [ ] Commit this task:

```bash
git add host/src/browser-kernel-host.ts \
  host/src/browser-kernel-protocol.ts \
  host/src/browser-kernel-worker-entry.ts \
  host/test/browser-kernel.test.ts
git commit -m "Browser: Carry explicit CORS proxy capabilities"
```

---

## Task 4: Configure the Production Boundary and Remove the npm Sentinel

**Files:**

- Modify: `apps/browser-demos/lib/browser-cors-proxy.ts`
- Modify: `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts`
- Modify: `apps/browser-demos/pages/test-runner/main.ts`
- Modify: `apps/browser-demos/pages/homebrew-vfs-test/main.ts`
- Modify: `host/test/browser-demo-cors-proxy.test.ts`
- Modify: `apps/browser-demos/test/kandelo-merge-gate.spec.ts`

- [ ] Add failing tests for one exported, deeply immutable production
  capability next to the default proxy URL. Assert the exact methods are
  `GET` and `POST`, safe GET omission is enabled, and the request-header set is
  exactly:

```text
accept
authorization
content-type
git-protocol
wp_blog
wp_install
x-cors-proxy-allowed-request-headers
x-cors-proxy-content-type
```

- [ ] Add a failing live-setup assertion that `npm_config_registry` is
  `https://registry.npmjs.org/`, `proxy.local` does not appear, and the same
  exported capability object is supplied with the proxy URL.

- [ ] Run the focused tests and verify they fail against the sentinel config:

```bash
scripts/dev-shell.sh npm --prefix host test -- --run \
  test/browser-demo-cors-proxy.test.ts
scripts/dev-shell.sh bash -c 'cd apps/browser-demos && \
  npx playwright test test/kandelo-merge-gate.spec.ts --project=chromium'
```

- [ ] Export `WORDPRESS_PLAYGROUND_CORS_PROXY_CAPABILITIES` from
  `browser-cors-proxy.ts` using readonly literals and pass it into every live
  `BrowserKernelHost` construction that supplies the production proxy URL.
  The test-runner page may accept an explicit proxy URL/capability in its
  `__runTest` test-only options, but application pages must use the exported
  production constant.

- [ ] Change the guest environment to the canonical HTTPS npm registry and
  delete sentinel-host comments and expectations.

- [ ] Search for residual product-specific routing and require no runtime hit:

```bash
rg -n "proxy\.local|isNpmRegistry|Packument|tarball.*rewrite" \
  host/src apps/browser-demos/lib
```

- [ ] Re-run focused tests and commit:

```bash
scripts/dev-shell.sh npm --prefix host test -- --run \
  test/browser-demo-cors-proxy.test.ts \
  test/fetch-backend.test.ts
git add apps/browser-demos/lib/browser-cors-proxy.ts \
  apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts \
  apps/browser-demos/pages/test-runner/main.ts \
  apps/browser-demos/pages/homebrew-vfs-test/main.ts \
  host/test/browser-demo-cors-proxy.test.ts \
  apps/browser-demos/test/kandelo-merge-gate.spec.ts
git commit -m "Demo: Declare the production proxy boundary"
```

---

## Task 5: Prove Real Browser Preflight and npm Acceptance

**Files:**

- Modify: `apps/browser-demos/pages/test-runner/main.ts`
- Modify: `apps/browser-demos/test/browser-cors-proxy.spec.ts`
- Modify: `apps/browser-demos/test/kandelo-node.spec.ts`

- [ ] Extend the test-runner page's test-only `__runTest` options with an
  explicit `{ url, capabilities }` proxy override. In the Playwright spec,
  start an ephemeral Node HTTP server on a different loopback origin whose
  `OPTIONS` response exactly advertises the production methods and headers.
  The endpoint must record received method, target URL, and outer header names
  without accepting credentials.

- [ ] Add a failing Chromium test that boots a browser kernel configured with
  the fixture, issues an anonymous bodyless GET with both `git-protocol` and
  `x-client-trace`, and proves:
  - the browser completes preflight without a CORS console error;
  - `git-protocol` reaches the proxy;
  - `x-client-trace` does not reach the proxy;
  - one generic omission diagnostic names `x-client-trace`; and
  - neither fixture nor assertion mentions npm or Pacote.

- [ ] Add negative browser cases for credentials and a state-changing request.
  Require a deterministic bridge failure and zero requests at the fixture.

- [ ] Run the new browser contract and confirm it fails before the fixture and
  configuration are implemented:

```bash
scripts/dev-shell.sh bash -c 'cd apps/browser-demos && \
  npx playwright test test/browser-cors-proxy.spec.ts --project=chromium'
```

- [ ] Implement the fixture and test-only configuration seam. Bind it to a
  random loopback port and expose only the exact endpoint needed by the test;
  close it in `finally` and do not weaken the application's production policy.

- [ ] Update `kandelo-node.spec.ts` to boot the exact staged/canonical Node VFS,
  run `npm install --verbose cowsay`, require exit status zero, execute the
  installed `cowsay`, reject browser CORS errors, and require the generic
  omission diagnostic. Do not assert a particular `pacote-*` header because
  Pacote metadata may change independently.

- [ ] Run the focused browser tests in Chromium:

```bash
scripts/dev-shell.sh bash -c 'cd apps/browser-demos && npx playwright test \
  test/browser-cors-proxy.spec.ts \
  test/kandelo-node.spec.ts \
  --project=chromium'
```

- [ ] Run the generic proxy contract in Firefox and WebKit to cover the shared
  browser behavior:

```bash
scripts/dev-shell.sh bash -c 'cd apps/browser-demos && npx playwright test \
  test/browser-cors-proxy.spec.ts \
  --project=firefox --project=webkit'
```

- [ ] Commit this task:

```bash
git add apps/browser-demos/pages/test-runner/main.ts \
  apps/browser-demos/test/browser-cors-proxy.spec.ts \
  apps/browser-demos/test/kandelo-node.spec.ts
git add -u apps/browser-demos
git commit -m "Browser: Prove constrained proxy requests end to end"
```

---

## Task 6: Document, Validate, and Review the Compatibility Boundary

**Files:**

- Modify: `docs/browser-support.md`
- Modify: `docs/future-improvements.md`
- Modify: documentation index/check files only if required by repository tests

- [ ] Add a browser-support section stating that the configured public proxy
  can relay only GET/POST and a fixed request-header set; anonymous bodyless
  GET metadata may be omitted with a diagnostic; credentials and lossy
  state-changing requests fail before fetch. State that Node does not use this
  policy.

- [ ] Add an explicit future-work item for a full-fidelity upstream or
  Kandelo-owned transport. Include authentication, all supported methods,
  conditional/range requests, redirects, request/response streaming, size and
  timeout limits, rate limiting, abuse prevention, private-network controls,
  and Node/browser parity. Say that landing it removes omission mode.

- [ ] Run formatting, type checks, focused host tests, and the browser asset and
  documentation checks discovered through the repository test router:

```bash
scripts/dev-shell.sh npm --prefix host run typecheck
scripts/dev-shell.sh npm --prefix host test -- --run \
  test/cors-proxy-request-policy.test.ts \
  test/fetch-backend.test.ts \
  test/tls-network-backend-real-client.test.ts \
  test/browser-kernel.test.ts \
  test/browser-demo-cors-proxy.test.ts \
  test/host-diagnostic-routing.test.ts
scripts/dev-shell.sh bash tests/scripts/ci-run-test-suite-groups.test.sh
scripts/dev-shell.sh node --test \
  docs-site/.vitepress/homebrew-doc-links.test.mjs
scripts/dev-shell.sh npm run docs:build
scripts/dev-shell.sh node --test \
  docs-site/.vitepress/homebrew-doc-output.test.mjs
```

- [ ] Run the Chromium product acceptance once the lazy-shell publication plan
  has produced the exact staged Node VFS:

```bash
scripts/dev-shell.sh bash -c 'cd apps/browser-demos && npx playwright test \
  test/browser-cors-proxy.spec.ts \
  test/kandelo-node.spec.ts \
  --project=chromium'
```

- [ ] Manually run `./run.sh browser`, open the Node demo, run
  `npm install --verbose cowsay`, execute the installed command, and capture:
  exit codes, the one generic proxy diagnostic, absence of CORS console errors,
  and the served Node VFS identity.

- [ ] Review the diff for forbidden special cases and ABI changes:

```bash
git diff --check
rg -n "pacote|cowsay|proxy\.local|isNpmRegistry|registry\.npmjs" \
  host/src
git diff -- abi/snapshot.json crates/shared/src/lib.rs
```

- [ ] Commit documentation and any final test-only corrections:

```bash
git add docs/browser-support.md docs/future-improvements.md
git commit -m "Docs: Record the constrained browser proxy boundary"
```

- [ ] Before claiming completion, use
  `superpowers:verification-before-completion` and report every command run,
  its result, browser engines covered, manual evidence, and any omitted suite.

The lazy-shell publication plan must execute before final live npm acceptance,
because the browser test must consume the corrected canonical Node image rather
than a locally substituted asset.
