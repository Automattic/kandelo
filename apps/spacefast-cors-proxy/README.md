# Kandelo CORS proxy for Spacefast

A Spacefast Functions worker implementing the Playground CORS proxy
protocol. It can run alone or beside a Kandelo production build.
The production entry is `handler.ts`; `sf.jsonc` declares the Functions
runtime. A native PHP Function at `/cors-proxy-session` bridges the verified
Spacefast guest/account identity into the worker. There are no runtime npm
dependencies or Node imports.

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
- The CORS preflight allows Playground's request fields (`Accept`,
  `Authorization`, `Content-Type`, `git-protocol`, `Range`, `wp_blog`,
  `wp_install` and the `X-Cors-Proxy-*` fields), Kandelo's quota field
  `X-Kandelo-Proxy-Session`, and the fields signed-in Codex sends:
  `Cache-Control`, `ChatGPT-Account-ID`, `Content-Encoding`,
  `OAI-Product-Sku`, `OpenAI-Beta`, `originator`, `session-id`,
  `thread-id`, `version`, `x-client-request-id`, `x-codex-beta-features`,
  `x-codex-parent-thread-id`, `x-codex-routing-hint`,
  `x-codex-turn-metadata`, `x-codex-turn-state`, `x-codex-window-id`,
  `x-openai-account-routing-override`, `x-openai-fedramp`,
  `x-openai-internal-codex-responses-lite`, `x-openai-product-sku` and
  `x-openai-subagent`. They are listed by name,
  never `*`. It never allows `X-Kandelo-Credential-Grant`: Kandelo's
  service worker removes that tag after checking it, so a request still
  carrying one skipped that check and must fail its preflight. Like any
  other field, `ChatGPT-Account-ID` is forwarded without the opt-in that
  `Authorization` needs.
- Request bodies are relayed as received, without decoding: a
  `Content-Encoding: zstd` body (every signed-in Codex model turn) reaches
  the target byte-for-byte with its `Content-Encoding`. The body is
  streamed upstream, so its framing is chunked or an exact length.
- `Access-Control-Expose-Headers` is `*` followed by named fields:
  Playground's (`X-Playground-Cors-Proxy`, `Content-Range`,
  `Accept-Ranges`, `ETag`), `Content-Length`, `Last-Modified`, `Date`,
  `Retry-After`, `X-Kandelo-Proxy-Session`, and the fields Codex reads:
  `x-codex-turn-state`, `openai-model`, `x-models-etag`,
  `x-reasoning-included`, the `x-codex-primary-*`/`x-codex-secondary-*`
  rate-limit fields (`-used-percent`, `-window-minutes`, `-reset-at`),
  `x-codex-limit-name`, `x-codex-credits-has-credits`,
  `x-codex-credits-unlimited`, `x-codex-credits-balance`,
  `x-codex-promo-message`, `x-codex-rate-limit-reached-type`,
  `x-codex-active-limit`, `x-codex-safety-buffering-enabled`,
  `x-codex-safety-buffering-faster-model`, and for diagnostics
  `x-request-id`, `x-oai-request-id`, `cf-ray`,
  `x-openai-authorization-error` and `x-error-json`. Why `*`: Fetch
  exposes every field for `*` only when the request's credentials mode is
  not `include`, which is the case for every Kandelo proxy request
  (`omit`, or `same-origin` toward a cross-origin proxy); a script-set
  `Authorization` does not change that. This covers rate-limit families
  Codex reads whose names cannot be listed in advance
  (`x-<family>-primary-used-percent`, ...). A client that fetches with
  `credentials: "include"` gets the named fields only, because Fetch then
  reads `*` as a name. `Set-Cookie` is never exposed, and the authority
  fields below are dropped before any exposure applies. Observed in
  Chromium 153, Firefox 155 and WebKit 26.6 (Playwright) on 2026-10-29.
  The wildcard applies to every approved origin, so their scripts can
  now read any upstream field that survives the response deny list
  (a redirect's `Location`, for example), not only the named ones.
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
- Responses stream: each upstream chunk is passed on as it arrives, so a
  `text/event-stream` answer reaches the client event by event.

The request and response limits match Playground: bodies must be smaller
than 1 MiB and 100 MiB respectively. Unlike Playground's declared-length-only
response check, both limits also count streamed bytes. An oversized unknown-
length response fails mid-stream. An oversized streamed upload closes its
connection; bytes already sent may have reached the target. No entire body
is buffered to determine its size.

### Spacefast's 30-second Functions limit

Spacefast's runtime, not this proxy, stops a Functions request 30 seconds
after dispatching it to the worker
(`STATTIC_FUNCTIONS_DISPATCH_TIMEOUT_SECONDS = 30` and the dispatch's
`timeout`, which bounds the whole transfer, in
[`functions-dispatch.php`](https://github.com/spacefast/stattic/blob/9217af5ad9f6f551d2af88af3fa224f664c3b10f/runtime/engine/runtime/functions-dispatch.php#L28)).
The limit covers the whole response, including a streamed body, not just
the time to the first byte. Before the response headers are sent, the
client gets a 502 from Spacefast. After they are sent, Spacefast stops
relaying and ends the response
([`_stattic_relay_abort_after_headers`](https://github.com/spacefast/stattic/blob/9217af5ad9f6f551d2af88af3fa224f664c3b10f/runtime/engine/shared/upstream-relay.php#L188)),
so the client can see a body that simply ends early, with no error status.
A Codex model turn whose server-sent events stream for longer than 30
seconds is therefore cut before its `response.completed` event; Codex
reports the stream as interrupted and retries by sending the whole
request again, which meets the same limit. This is a hosting boundary of
Spacefast Functions, read from the runtime source and not yet measured
live; the proxy cannot raise it. The Playground proxy on WP Cloud has its
own boundary: in Kandelo's 2026-10-27 probe through it, a streamed
response arrived only when it completed, and a 150-second response got
`504` at 120 seconds.

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

The default limiter uses Spacefast's verified guest identity, or its account
identity when the session endpoint is called while signed in. The native PHP
Function calls [`sf_auth()`](https://spacefast.com/docs/functions/php/);
request headers cannot select an identity. The worker uses `env.DB` for
atomic MySQL token buckets and keeps Playground's production capacity/refill
at upstream commit `d7b19bdb598ccb405f0dcb7afcaa9b036676c18a`:

- Each verified identity has its own bucket, initially holding 1,000 tokens.
  Each admitted proxy request consumes one token.
- Refill is 100 tokens per minute, using whole elapsed database-clock seconds
  and whole tokens, capped at 1,000. A successful request resets the refill
  timestamp and discards the fractional remainder, as in Playground.
- OPTIONS and session challenges consume no tokens. Exhaustion returns 429
  with browser-readable `Retry-After: 1`. Refused retries leave the refill
  timestamp alone. Idle buckets expire after one day.
- A conditional UPDATE consumes under the row lock. Its affected-row count
  identifies this request's admission without a racy follow-up read. Isolates
  cannot spend the same tokens. A backward database clock cannot mint tokens.
- Missing storage or failed queries return 503 before an upstream fetch.
  There is no shared fallback budget or isolate-local accounting.

This is **per identity, rather than Playground's per IP or IPv6 /64**. Guests
can obtain a new identity by clearing their platform session and quota token,
or using a new browser profile. It does not provide equivalent resistance to
quota evasion. Spacefast hosting quotas can independently return 429s.

### Cookie-independent quota sessions

The worker challenges missing, expired or invalid credentials with HTTP 401
and `X-Kandelo-Proxy-Session: required`, before contacting any destination.
Kandelo's host transports and service worker then GET `/cors-proxy-session`
on that exact configured proxy origin. The endpoint applies the compiled
Referer/Origin restrictions before reading verified auth or issuing a token.
With no compiled list, the endpoint admits only the proxy's own origin.

The endpoint signs a 30-day, proxy-origin-bound quota credential containing
an opaque identity pseudonym. A random signing key lives in the Space's
MySQL database; reissuing a credential for the same verified identity keeps
the same bucket. Neither raw identities nor platform cookies enter the token.
`guest:local`, missing auth and malformed guest identities fail closed.

The browser persists this token in IndexedDB on the **app's origin**,
scoped to the configured proxy origin. Web Locks serialize first use across
page, kernel worker and service worker where available. If storage is blocked,
the transport retains an in-memory session. External proxies receive no
application cookies, and the token works without third-party cookies. A
signed-in account is used at issuance; an existing guest credential continues
to identify its original guest until replaced or expired.

Requests send the token in `X-Kandelo-Proxy-Session`; preflight allows that
header. The proxy strips it from upstream requests and responses. It grants
only quota identity, never Space access or upstream authentication. The
transport retries a session challenge once, preserving replayable POST bytes;
a challenge has sent nothing upstream. It does not retry 429s or ordinary
upstream failures. Requests provide only the application's origin as Referer,
using `strict-origin`, to support restricted standalone proxies.

Deploy the updated Kandelo frontend with this proxy, including when the app
runs on WP Cloud, and reload existing tabs. Older builds that only construct
proxy URLs do not implement this quota handshake and will receive HTTP 401.

### Optional ingress policy

The [upstream deployment limiter](https://github.com/WordPress/wordpress-playground/blob/d7b19bdb598ccb405f0dcb7afcaa9b036676c18a/packages/playground/php-cors-proxy-deployment/cors-proxy-config.php)
uses WP Cloud's protected client-IP and classification headers. The legacy
`CORS_PROXY_TRUSTED_CLIENT_IP_HEADER` setting explicitly selects IP-based
buckets instead of guest sessions. It requires a verified edge that overwrites
that header on every request, with no bypass. **The tested Spacefast runtime
exposes no usable client-IP header; leave this unset for Spacefast.**
`CORS_PROXY_TRUSTED_PROXY_TYPE_HEADER` optionally enables trusted uppercase
three-letter classifications: `SES` receives no tokens, others use the normal
budget. Unset classification defaults to `UNK`; search-engine exclusion is
therefore unavailable without a separately verified source.

Local tests cover the worker at 100% lines, branches and functions, and run
the actual PHP bridge and SQL against disposable MariaDB. A private diagnostic
Space verified guest and signed-in issuance and a proxied fetch on
2026-10-18. Existing deployments retain their earlier limiter until explicitly
republished with the new frontend and proxy together.

### Spacefast visitor-IP availability

Live checks on 2026-10-18 used an isolated private diagnostic Space.
Authenticated requests tested a baseline, 13 forged headers, and a forged
forwarding chain:

| Input or metadata | Observed behavior |
| --- | --- |
| `X-Forwarded-For`, `X-Real-IP`, `CF-Connecting-IP`, `CF-Connecting-IPv6`, `Spacefast-Visitor-IP` | Absent in the Function, including after forgery |
| `True-Client-IP`, `Fastly-Client-IP`, `X-Client-IP`, `X-Spacefast-Client-IP`, `X-Stattic-Client-IP`, `Forwarded` | Forged values reached the Function unchanged |
| `sf-fx-visitor` | Forged internal visitor context did not reach the Function |
| `request.ip`, `clientIp`, `clientIP`, `remoteAddress`, `remoteAddr` | No address exposed |
| `request.cf` | Only `country`; no address |
| Execution context `props` and `tracing` | Empty; no address |
| `X-IP-Proxy-Type` | Present and the tested forged `SES` value was replaced; this supplies no client address |

An unauthenticated request to the diagnostic was rejected with 403. Neither
cookies nor authorization values were returned by its handler. The temporary
introspection handler was retired after the checks.

The public Spacefast runtime source explains the trust boundary at revision
`9217af5ad9f6f551d2af88af3fa224f664c3b10f`:

- [Header sanitization](https://github.com/spacefast/stattic/blob/9217af5ad9f6f551d2af88af3fa224f664c3b10f/runtime/engine/shared/context.php#L532)
  deliberately removes untrusted IP headers.
- [Functions dispatch](https://github.com/spacefast/stattic/blob/9217af5ad9f6f551d2af88af3fa224f664c3b10f/runtime/engine/runtime/functions-dispatch.php#L197)
  constructs visitor metadata from a server-owned `SPACEFAST_VISITOR_IP`
  FastCGI parameter, not an HTTP header of that name.
- [Trusted visitor-IP handling](https://github.com/spacefast/stattic/blob/9217af5ad9f6f551d2af88af3fa224f664c3b10f/runtime/engine/runtime/zero.php#L631)
  also excludes `REMOTE_ADDR`: on that hosting path it identifies the
  provider proxy rather than the browser.

These findings prevent configuring the optional **IP-based** mode safely on
the tested runtime. The default guest-identity mode above avoids that missing
interface. The probe cannot distinguish an absent ingress value from a
missing downstream mapping; source-code presence does not prove the deployed
platform supplies an address. Do not substitute a provider address or a
client-chosen IP header.

The reusable core also accepts `createCorsProxy({ rateLimit })` for an
alternative durable limiter. It returns a denial Response, or void to admit.

Alternatively, explicitly set `CORS_PROXY_DISABLE_RATE_LIMIT` to `true` or `1`
in the deployment environment. This is an operator choice; the repository
does not disable limiting by default or emulate it with isolate-local state.

### Approved Referer origins

`CORS_PROXY_ALLOWED_REFERER_ORIGINS` enables a request admission policy:

```text
https://app.example https://wp.example
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
entry, so only `/cors-proxy` and its descendants, `/cors-proxy-session`, and `/signalling`
endpoint, wake the worker. Static
files keep their normal serving path. The production entry uses the platform-
Fetch workaround described above.

### Separate proxy site

This layout is **experimental** until verified through Spacefast's live
cross-origin serving layer. Its cookie-free session flow and Referer policy
are tested in local browsers; the private live diagnostic verified the
same-origin quota handshake only. Use the combined site for the verified
Spacefast hosting layout.

Set `KANDELO_SPACE_URL` and `WP_CLOUD_ORIGIN` to the approved client origins,
without trailing slashes or paths. Build a standalone proxy with that list:

```sh
scripts/dev-shell.sh npm --prefix apps/spacefast-cors-proxy run build -- \
  --allow-referer "$KANDELO_SPACE_URL" \
  --allow-referer "$WP_CLOUD_ORIGIN"
```

The command requires at least one `--allow-referer` and prints a unique
`.context/spacefast-cors-proxy-build-*` directory containing only
`handler.mjs`, `functions/cors-proxy-session.php` and `sf.jsonc`. It does
not install, sign in or publish. The
approved list is compiled into the worker and takes precedence over a runtime
environment override. Spacefast supplies the worker's `env.DB` binding and
the native PHP database automatically; no connection string or separate
database-enable command is needed. Both use the same Space database.
Missing verified identity or storage returns 503; do not
disable limiting to work around either failure.

Publish that generated directory as its own Functions Space using the chosen
team and access settings. The separate proxy must be reachable by the client:
Kandelo sends no Spacefast account cookies to an external proxy. A private
Space requiring a visitor sign-in will therefore reject these anonymous
cross-origin requests before the handler. Also verify that Spacefast's
serving layer admits the intended Origin and preserves the worker's CORS
headers; the earlier private combined-site probes did not establish this.
No build command changes access or publishes anything automatically.

Set `SPACEFAST_PROXY_ORIGIN` to its canonical origin. Either deployment can
then use it:

```sh
# WP Cloud: static Kandelo plus the portable PHP signalling endpoint.
./run.sh build-browser --base / --out .context/kandelo-wpcloud-static \
  --cors-proxy "${SPACEFAST_PROXY_ORIGIN}/?url=" \
  --signalling-url /signalling/piplet.php
```

Upload that static output to WP Cloud; the build includes the PHP piplet at
`/signalling/piplet.php`. Without a proxy override, the production default
remains Playground. The PHP proxy and PHP signalling implementations remain
supported independently of Spacefast.

### Combined Kandelo site

The package also includes [Spacefast signalling](../signalling/spacefast/README.md)
for named sessions and rooms, backed by atomic MySQL updates.

Use the reusable [`scripts/deploy-spacefast.mjs`](../../scripts/deploy-spacefast.mjs)
script from the repository root with Node 24 and Kandelo's normal build
prerequisites. Preparation needs no Spacefast authentication. To publish,
install the [official CLI](https://spacefast.com/docs/cli/) separately and
sign in once with `sf auth login`.

Select an existing Space's canonical live origin. To create an empty Space
first, explicitly choose its team, then run:

```sh
# Set SPACEFAST_TEAM to your chosen team name or ID.
sf spaces add --team "$SPACEFAST_TEAM" --name Kandelo
```

Use the canonical live origin printed by that command, not an access link or
an immutable version URL. Creating the Space first lets the proxy's exact
Referer policy approve its actual app origin. New Spaces inherit the team's
access defaults; publishing to an existing Space preserves access settings.
Set `KANDELO_SPACE_URL` to that HTTPS origin without a trailing slash or path.

```sh
# Prepare only, then print the bundle path and an exact publish command.
node scripts/deploy-spacefast.mjs --space "$KANDELO_SPACE_URL"
```

For publication or a local CLI check, choose one of these alternatives:

```sh
node scripts/deploy-spacefast.mjs --space "$KANDELO_SPACE_URL" --publish
node scripts/deploy-spacefast.mjs --space "$KANDELO_SPACE_URL" --dry-run
```

Each invocation builds a fresh app with `/cors-proxy?url=` and `/signalling`,
then packages it. To publish an already prepared bundle, use its printed
command instead of rebuilding. `--publish` updates the selected live Space;
`--dry-run` compiles the local publish plan without uploading. Neither mode
installs tools, signs in, creates a Space or changes access. No saved CLI
selection supplies the target. Additional approved app origins can be passed
with repeated `--allow-referer` arguments; the target is approved automatically.
Build and package steps use the declared development shell; the CLI uses
its existing host authentication. Run `--help` for the current interface.

For advanced layouts or an existing static build, the underlying packager
remains available:

```sh
# Set STATIC_BUILD_DIR to the generated static app directory.
scripts/dev-shell.sh node apps/spacefast-cors-proxy/build-site.mjs \
  "$STATIC_BUILD_DIR" --allow-referer "$KANDELO_SPACE_URL"
```

The packaging command prints a unique `.context/spacefast-kandelo-build-*`
directory. It contains the static app, a bundled
`functions/cors-proxy/[...rest].mjs`,
`functions/cors-proxy-session.php`, `functions/signalling.mjs`, `sf.jsonc`
and underscore-prefixed bundled helpers. The public route modules retain
literal `export default` entry points so CLI 0.5.0 discovers them; helper
names start with `_` so they never claim extra routes. It also contains
the COOP/COEP/CORP response headers for documents and worker
scripts, including clean document URLs. Binary downloads have no custom
isolation headers: Spacefast cannot serve files above 100 MiB through its
PHP header-serving lane. Shared memory isolation remains on pages and workers.
`sf publish --prebuilt` detects the Functions configuration and publishes
that generated directory. It skips Kandelo compilation and dependency
installation. `--wait` waits for the live version; add `--dry-run` to inspect
the local publish plan without uploading. Do not publish the repository or
the unwrapped Vite output. Spacefast supplies `env.DB` and the native PHP
database automatically, and the services create their own tables on first
use. No database connection string belongs in the build. Use a signed-in,
team-owned Space: unclaimed Spaces restrict outbound hosts, which prevents
the CORS proxy from fetching arbitrary public assets. See Spacefast's
[Functions](https://spacefast.com/docs/functions/) and
[publish CLI](https://spacefast.com/docs/cli/publish/) references.

After publication, open the canonical live URL and reload existing tabs so
they use the new proxy-session handshake. Private Spaces require both peers
to have access. Add another `--allow-referer` for every custom app origin;
the list admits exact origins, not every `space.fast` subdomain.
Packaging omits the portable `signalling/piplet.php` from the Spacefast
output, where `/signalling` uses the database-backed Function. The original
static build retains its PHP endpoint for WP Cloud.
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

### Guest preview Space

Guest web pages (WordPress, nginx, any server inside a machine) run on a
second origin so their scripts cannot reach the Kandelo page (see
[Guest web previews run on their own
origin](../../docs/browser-support.md#guest-web-previews-run-on-their-own-origin)).
On Spacefast that origin is a second Space. Without one, the deployed app
refuses to open web previews.

Create or choose that Space and keep it **public**: a private Space's access
page forbids framing, which breaks the preview frame. Set
`KANDELO_PREVIEW_SPACE_URL` to its canonical HTTPS origin, then add it to the
deployment:

```sh
node scripts/deploy-spacefast.mjs --space "$KANDELO_SPACE_URL" \
  --preview-space "$KANDELO_PREVIEW_SPACE_URL"
```

The build injects the preview origin into the app and the app origin into
the preview bundle (`./run.sh build-browser --preview-origin ...
--app-origin ...` writes it to `<out>-preview`).
`build-preview-site.mjs` checks that bundle was built for this app at the
current preview protocol, and adds `_headers` (COEP `require-corp`, CORP
`cross-origin`, `Origin-Agent-Cluster`, nothing that forbids framing) and
`_redirects` (`/computer/*` to the app's viewer shell). The app Space's
`_headers` send `Content-Security-Policy: frame-ancestors 'self'` on its
documents, and its `_redirects` rewrite `/computer/*` to the viewer shell
page. The relay accepts the app origin and that Space's `<label>--v<n>`
version hosts, which only that Space can own because slugs cannot contain
`--`. The script publishes the preview Space first, so the app never names
an origin that does not yet serve its protocol. It never approves the
preview Space for the CORS proxy and refuses `--allow-referer` for it.

Before relying on a deployed pair, confirm that the public preview Space
serves `__kandelo_preview/relay.html` verbatim (no injected scripts) with
its `_headers`, that its `_redirects` and the app Space's `/computer/*`
rewrite behave as written, and that one guest page with CSS and JavaScript
loads through the pair in Chromium, Firefox and WebKit. These behaviors of
the Spacefast platform have not been verified by a deployment yet.

## Verification

From the repository root:

```sh
scripts/dev-shell.sh npm --prefix apps/spacefast-cors-proxy test
limiter_tools="$(nix build --impure --no-link --print-out-paths -f apps/signalling/spacefast/test/tools.nix)"
scripts/dev-shell.sh env KANDELO_SIGNALLING_TEST_TOOLS="$limiter_tools" \
  npm --prefix apps/spacefast-cors-proxy run test:database
```

The Node 24 test runner enforces **100% lines, branches and functions** for
`handler.ts` and every executable module under `src/`. This app has no dependency
on kernel, package or VFS build artifacts and does not use Vitest.

The Spacefast service-contract CI workflow runs the proxy suite and the
real MariaDB proxy-SQL and MariaDB/PHP signalling suites without deployment
credentials. The proxy SQL tests reuse the declared disposable-database tools
from the signalling test harness. They also execute the actual PHP session
route with `phpdbg`, enforce all its executable lines are covered, and verify
PHP-issued signatures in the worker against the same real database. Browser
tests in `apps/browser-demos/test/browser-cors-proxy.spec.ts` cover cookie-free
sessions, persistence, reload, POST replay and service-worker reprojection.
Deployment-command tests check endpoint defaults and precedence across the
isolated shell. Account-free deployment-script fixtures verify explicit
targets, modes, approved origins, unique output paths and failure propagation
without installing tools or contacting Spacefast. Packaging tests preserve
the WP Cloud PHP input and verify that Spacefast emits its own signalling
Function instead.

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
