# Kandelo CORS proxy for Spacefast

A Spacefast Functions worker implementing the Playground CORS proxy
protocol. It can run alone or beside a Kandelo production build.
The production entry is `handler.ts`; `sf.jsonc` declares the Functions
runtime. There are no runtime npm dependencies or Node imports.

The compatibility reference is WordPress Playground's
[`packages/playground/php-cors-proxy`](https://github.com/WordPress/wordpress-playground/tree/869d25157449d28e100154dec75073b9569bfd1a/packages/playground/php-cors-proxy),
at commit `869d25157449d28e100154dec75073b9569bfd1a`. This is a TypeScript
implementation of its public protocol, not a copy of the PHP source.

## Protocol

- GET, HEAD, POST and OPTIONS, with streamed binary request/response bodies.
- Raw target query (`/?https://example.com/file?x=1`), encoded target
  (`/?url=https%3A%2F%2Fexample.com%2Ffile`), and path target
  (`/https://example.com/file?x=1`). Path targets may follow a script prefix.
- Multipart requests are forwarded byte-for-byte. The optional
  `X-Cors-Proxy-Content-Type` restores a wrapped content type.
- Authorization is forwarded only when explicitly named, case-insensitively,
  in `X-Cors-Proxy-Allowed-Request-Headers`. Cookies, proxy credentials,
  transport framing and internal proxy headers are never forwarded.
- Range and `X-Cors-Proxy-Range`, including suffix ranges. Conflicting values
  return 400. Range values are opaque. The original upstream status,
  Content-Range, Accept-Ranges and ETag survive.
- The core preserves HEAD entity size without a body or response-size cap;
  Spacefast currently omits that Content-Length in live responses (see below).
  HEAD and range requests ask for identity encoding; unexpected encoded HEAD
  or 206 responses fail with 502 rather than describe the wrong byte offsets.
- The Spacefast entry uses runtime Fetch, which may decode full compressed
  responses. It drops the old Content-Encoding and Content-Length when decoding
  occurred; response limits count the bytes exposed by Fetch. The optional
  pinned transport preserves opaque compressed bytes instead.
- Redirects are returned with their status and their Location rewritten back
  through the same proxy URL form. Relative URLs, queries and custom ports
  are retained. Redirects to forbidden targets return 502. No automatic
  redirect following can bypass destination checks.
- Credentialed CORS for Playground's built-in origins, the proxy's own origin,
  and configurable exact/single-label-subdomain origins. Restricted deployments
  instead use an exact Referer admission list for both requests and CORS.
  OPTIONS needs no target URL. Responses carry `X-Playground-Cors-Proxy: true`.
- Errors preserve the proxy's own CORS headers and discard target headers.
  Upstream disconnects and malformed bodies error the stream without adding
  error text to target bytes. Client cancellation aborts the owning fetch.

The request and response limits match Playground: bodies must be smaller
than 1 MiB and 100 MiB respectively. Unlike Playground's declared-length-only
response check, both limits also count streamed bytes. An oversized unknown-
length response fails mid-stream. An oversized streamed upload closes its
connection; bytes already sent may have reached the target. No entire body
is buffered to determine its size.

## Destination security and the Spacefast workaround

The production entry `handler.ts` uses Spacefast's ordinary hostname `fetch()`.
This is an explicit, user-approved workaround for its blocked pinned TCP egress.
Spacefast owns DNS resolution, the actual connection address, TLS, and its
outbound network policy. Kandelo does **not** pin the checked address, resolve
DNS independently, or claim DNS-rebinding protection in this mode. A public
hostname can resolve to a private address; whether that connection is denied
is Spacefast's responsibility. No such platform guarantee has been verified.

`src/network-policy.ts` still rejects URL credentials, non-HTTP(S) URLs,
self-targets, private/local host names and forbidden IPv4/IPv6 literals.
Legacy numeric IPv4 spellings are normalized before checking. IPv6 accepts
only global unicast and excludes special-use ranges within it. These are URL
checks, not checks of the platform's resolved destination address.

Fetch uses `redirect: "manual"`. Each Location is validated and rewritten
through the same proxy, so browser-followed redirects repeat URL validation
and rate limiting. Destination access remains subject to Spacefast's platform
restrictions. The proxy supports HTTP requests, not WebSockets or CONNECT.
Upstream failures are logged server-side; clients receive a generic 502
(the previously tested Spacefast error-serving path exposed it as HTTP 500).

### Observed platform boundaries

Live v5 requests on 2026-10-15 succeeded for HTTPS GET, HEAD, POST with opt-in
Authorization, gzip/deflate bodies, the range alias (206 with correct bytes),
and rewritten redirects. HEAD returned 200 with no body, but the serving path
omitted its Content-Length, so clients cannot rely on HEAD for entity size.
Plain HTTP to example.com succeeded; httpbingo.org's
HTTP endpoint returned a platform/upstream 520 while its HTTPS endpoint worked.

Send `X-Cors-Proxy-Range`: a live standard Range header did not reach the
upstream, which returned the full entity (200). Kandelo's existing proxy profile
already sends this alias. The private Space's serving path also omitted
Access-Control-Allow-Origin from same-origin probe responses, and rejected a
request carrying an untrusted Origin before it reached the worker. Kandelo uses
the proxy on the same origin; cross-origin deployment compatibility is not
claimed from these probes. Local tests still check the core CORS behavior.

### Optional pinned transport

The reusable `createCorsProxy()` core retains its original pinned transport
when no `fetch` option is supplied. `src/pinned-fetch.ts` resolves A and AAAA
through `https://1.1.1.1/dns-query`, rejects any forbidden answer, and passes a
validated numeric address to `cloudflare:sockets.connect()`. HTTPS uses the
original hostname for SNI and certificate verification. DNS changes cannot
change that connection's IP. DNS/HTTP framing is bounded and failures close
the socket. No hostname-fetch fallback is attempted by that transport.

On 2026-10-15, live Spacefast tests rejected connections even to public numeric
HTTP destinations (`66.241.125.232` and `93.184.215.14`). That is why the
production entry explicitly selects platform Fetch instead. The pinned code
remains tested for a future runtime that admits those connections; it is not
the security boundary of the deployed workaround.

## Configuration

The entry module uses Spacefast's `env.DB` binding for a durable, Space-wide
budget of 600 requests per database-clock minute. It creates its own MySQL
counter table, increments atomically across isolates, and retains only the
current and preceding minute. Concurrent reads can conservatively deny an
earlier increment but cannot increase the budget. Delayed requests cannot
use an expired window. OPTIONS does not consume the budget. A denial is 429
with browser-readable `Retry-After: 60`; a missing or failing database is 503. The SQL/broker
behavior is covered locally by contract fixtures. Live requests reached target
validation after the limiter, confirming that the counter queries succeed on
Spacefast's broker. The live 600-request ceiling was not stress-tested.

This is not the same policy as Playground's production proxy. At upstream
commit `d7b19bdb598ccb405f0dcb7afcaa9b036676c18a`, its
[deployment limiter](https://github.com/WordPress/wordpress-playground/blob/d7b19bdb598ccb405f0dcb7afcaa9b036676c18a/packages/playground/php-cors-proxy-deployment/cors-proxy-config.php)
uses a token bucket per IPv4 address or IPv6 /64, with capacity 1,000 and a
refill of 100 per minute; its search-engine classification is refused.
The reusable PHP proxy itself requires a limiter callback or an explicit
opt-out. Kandelo preserves that fail-closed requirement, but uses a shared
600-per-minute counter, not per-client token buckets or IP classification.
One client can exhaust the shared budget. No trusted Spacefast client-IP
binding has been established, so the worker does not trust a caller-supplied
`X-Forwarded-For` as a rate-limit identity. Spacefast's own hosting quotas
can also produce 429s independently of this worker.

The reusable core also accepts `createCorsProxy({ rateLimit })` for an
alternative durable limiter. It returns a denial Response, or void to admit.

Alternatively, explicitly set `CORS_PROXY_DISABLE_RATE_LIMIT` to `true` or `1`
in the deployment environment. This is an operator choice; the repository
does not disable limiting by default or emulate it with isolate-local state.

### Approved Referer origins

`CORS_PROXY_ALLOWED_REFERER_ORIGINS` enables a request admission policy:

```text
https://remote-oak.space.fast https://kandelo.dev
```

Only exact, canonical HTTP(S) origins are accepted, without trailing slashes,
paths or wildcards. The value is bounded to 8 KiB. An explicitly empty list
denies everyone; malformed configuration returns 503. Every GET, HEAD and
POST must carry a valid `Referer` URL from that list. An `Origin`, when
present, must match the Referer's origin. Missing, malformed or unapproved
Referers receive 403 before database work or upstream fetch. The proxy's
own origin is not implicitly admitted in this mode.

Preflight requires an approved `Origin`, but may omit `Referer`; the actual
request still requires it. CORS grants use the same exact list, overriding
legacy origin rules. URLs with different schemes, ports, subdomains or
lookalike suffixes are distinct origins. Redirected proxy requests repeat
admission and rate-limit checks.

This restricts browser use; it is not authentication. Non-browser clients can
forge both headers, and users choosing a `no-referrer` policy cannot use this
restricted proxy. Normal `strict-origin-when-cross-origin` retains the needed
origin for an HTTPS proxy. Keep rate limiting and Space access controls.
The worker requests no browser permissions and never needs media access.

Without this setting, legacy CORS-only behavior is retained for existing
combined deployments. `CUSTOM_SUPPORTED_ORIGINS_SPACE_SEPARATED` replaces
the built-in CORS origin list in that mode:

```text
https://kandelo.example https://*.preview.example http://localhost:5173
```

A wildcard matches exactly one hostname label, with the configured scheme
and port. Invalid configuration returns 503. An empty value removes built-in
cross-origin grants; the proxy's own origin remains supported. The origin
rules control browser CORS grants, not non-browser access; deployment access
control and rate limiting remain separate.

For Kandelo, pass the proxy prefix with `./run.sh build-browser --cors-proxy
URL`. This explicitly carries `VITE_CORS_PROXY_URL` into the clean development
shell. Its existing range alias profile works with this implementation.

Publish a generated bundle and `sf.jsonc`, not this source directory's tests,
fixture keys or local output. A root worker claims the whole site; deploy it
as its own proxy Space. The combined build below instead uses a file-router
entry, so only `/cors-proxy` and its descendants, plus the exact `/signalling`
endpoint, wake the worker. Static
files keep their normal serving path. The production entry uses the platform-
Fetch workaround described above.

### Separate proxy site

Build a standalone proxy with an explicit list of approved client origins:

```sh
scripts/dev-shell.sh npm --prefix apps/spacefast-cors-proxy run build -- \
  --allow-referer https://remote-oak.space.fast \
  --allow-referer https://kandelo.dev
```

The command requires at least one `--allow-referer` and prints a unique
`.context/spacefast-cors-proxy-build-*` directory containing only
`handler.mjs` and `sf.jsonc`. It does not install, sign in or publish. The
approved list is compiled into the worker and takes precedence over a runtime
environment override. Enable the Space's database capability/`env.DB` binding
for the default limiter. Do not disable rate limiting to work around a
missing binding.

Publish that generated directory as its own Functions Space using the chosen
team and access settings. The separate proxy must be reachable by the client:
Kandelo sends no Spacefast account cookies to an external proxy. A private
Space requiring a visitor sign-in will therefore reject these anonymous
cross-origin requests before the handler. Also verify that Spacefast's
serving layer admits the intended Origin and preserves the worker's CORS
headers; the earlier private combined-site probes did not establish this.
No build command changes access or publishes anything automatically.

Once its URL is known, either deployment can use it:

```sh
# WP Cloud: static Kandelo plus the portable PHP signalling endpoint.
./run.sh build-browser --base / --out .context/kandelo-wpcloud-static \
  --cors-proxy 'https://YOUR-PROXY.space.fast/?url=' \
  --signalling-url /signalling/piplet.php
```

Upload that static output to WP Cloud and retain the existing PHP piplet at
`/signalling/piplet.php`. Omitting `--cors-proxy` keeps the production default
Playground proxy. The PHP proxy and PHP signalling implementations remain
supported independently of Spacefast.

### Combined Kandelo site

The package also includes [Spacefast signalling](../signalling/spacefast/README.md)
for named sessions and rooms, backed by atomic MySQL updates.

Build the app with the same-origin proxy, then package the generated output:

```sh
./run.sh build-browser --base / --out .context/kandelo-spacefast-static \
  --cors-proxy '/cors-proxy?url=' --signalling-url /signalling
scripts/dev-shell.sh node apps/spacefast-cors-proxy/build-site.mjs \
  .context/kandelo-spacefast-static \
  --allow-referer https://YOUR-KANDELO.space.fast
```

The second command prints a unique `.context/spacefast-kandelo-build-*`
directory. It contains the static app, a bundled
`functions/cors-proxy/[...rest].mjs`,
`functions/signalling.mjs`, `sf.jsonc` and the COOP/COEP/CORP response headers for documents and worker
scripts, including clean document URLs. Binary downloads have no custom
isolation headers: Spacefast cannot serve files above 100 MiB through its
PHP header-serving lane. Shared memory isolation remains on pages and workers.
Publish that directory through the Functions-aware Spacefast publishing flow.
The packager rejects symlinks, existing root worker/function trees, dotenv files, dependency/auth directories and
the private VFS product map. It does not copy test files or fixture keys.
Keep the Space's access settings private unless public access is requested.

Omit `--allow-referer` from `build-site.mjs` only to retain the existing
combined site's CORS-only policy. To use a separate proxy from a Spacefast
app, build the static app with its absolute proxy URL instead of `/cors-proxy`;
the standalone proxy must approve that app's deployed origin. Package that
app with `build-site.mjs STATIC-DIRECTORY --without-proxy` so it includes
signalling and static assets without exposing a second, unused proxy route.
`--without-proxy` and `--allow-referer` cannot be combined.

## Verification

From the repository root:

```sh
scripts/dev-shell.sh npm --prefix apps/spacefast-cors-proxy test
```

The Node 24 test runner enforces **100% lines, branches and functions** for
`handler.ts` and every executable module under `src/`. This app has no dependency
on kernel, package or VFS build artifacts and does not use Vitest.

The Spacefast service-contract CI workflow runs the proxy suite and the
real MariaDB/PHP signalling suite without deployment credentials.

Tests include Referer/Origin admission and spoofed-lookalike rejection,
compiled standalone/combined allowlists, malformed DNS/HTTP input,
DNS rebinding, mixed public/private
answers, TLS failures, origin/header rules, uploads, redirects, ranges, caps,
streaming and cancellation. A test-only module hook maps the production
Cloudflare socket import to real Node TCP/TLS sockets connected to loopback
fixtures. Tests check the requested public destination, original Host/SNI,
certificate trust and hostname mismatch without contacting the public network.
Mock transports cover protocol edge cases independently.

These are local code/transport tests. Separate live integration checks confirm
boot, service-worker isolation, shell execution, preflight, private/self-target
rejection and basic database-counter operation. The production transport must
also be checked live: local tests do not prove Spacefast destination reachability
or its outbound private-network policy.

On 2026-10-15, the live v5 Chromium smoke check booted the Kandelo build with
cross-origin isolation and a same-origin service worker. Guest `uname -s`
reported `wasm-posix`; guest `curl -fsS` through `/cors-proxy` received HTTP 200
and exited 0. Desktop and 390px mobile captures showed no page errors or mobile
horizontal overflow. These checks did not cover Firefox or WebKit. The platform
header/target limitations listed above remain; no live DNS-rebinding guarantee
is claimed.

Lazy browser assets need authentication to the private Space's proxy as well.
The browser lazy fetcher and the service worker's proxy reprojection use
same-origin credentials for the deployment's same-origin proxy, while external
proxies stay anonymous. The worker strips
application cookies before forwarding to the artifact destination. This avoids
Spacefast's pre-worker 403 for public assets such as the Doom shareware WAD;
it does not make the Space public or grant browser credentials to a CDN.

The v7 live Chromium check on 2026-10-15 fetched the WAD through `/cors-proxy`
with HTTP 200 and rendered fbDOOM's 640×400 framebuffer. The full 4,196,020-byte
WAD also matched its declared SHA-256 through the unchanged proxy backend.
The credential regression uses real HTTP servers and the actual service worker
in Chromium, Firefox and WebKit to check both direct and reprojected requests.
