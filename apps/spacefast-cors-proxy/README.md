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
- HEAD reports the entity size without a response body or response-size cap.
  HEAD and range requests ask for identity encoding; unexpected encoded HEAD
  or 206 responses fail with 502 rather than describe the wrong byte offsets.
- Full compressed responses preserve their encoded bytes and metadata,
  including gzip, deflate and Brotli, without decoding or recompression.
- Redirects are returned with their status and their Location rewritten back
  through the same proxy URL form. Relative URLs, queries and custom ports
  are retained. Redirects to forbidden targets return 502. No automatic
  redirect following can bypass destination checks.
- Credentialed CORS for Playground's built-in origins, the proxy's own origin,
  and configurable exact/single-label-subdomain origins. OPTIONS needs no
  target URL. Responses carry `X-Playground-Cors-Proxy: true`.
- Errors preserve the proxy's own CORS headers and discard target headers.
  Upstream disconnects and malformed bodies error the stream without adding
  error text to target bytes. Client cancellation closes the owning socket.

The request and response limits match Playground: bodies must be smaller
than 1 MiB and 100 MiB respectively. Unlike Playground's declared-length-only
response check, both limits also count streamed bytes. An oversized unknown-
length response fails mid-stream. An oversized streamed upload closes its
connection; bytes already sent may have reached the target. No entire body
is buffered to determine its size.

## Destination security belongs to this proxy

`src/network-policy.ts` rejects URL credentials, non-HTTP(S) URLs, self-targets,
private/local hosts and forbidden IPv4/IPv6 literals. Legacy numeric IPv4
spellings are normalized before checking. IPv6 accepts only global unicast
and excludes special-use ranges within it.

`src/pinned-fetch.ts` resolves both A and AAAA through a fixed public-IP
HTTPS resolver (`https://1.1.1.1/dns-query`). It bounds and validates the DNS
responses and rejects the request if **any** returned address is forbidden.
An empty, inconsistent, malformed or failed lookup fails closed. No DNS
result is cached between requests.

The transport passes only a validated numeric address to
`cloudflare:sockets.connect()`. For HTTPS it starts TLS before sending any
HTTP bytes and uses `expectedServerHostname` to verify the original host's
certificate and send its Server Name Indication. The HTTP Host header retains
that original authority. It never calls hostname `fetch()` for a target.
Changing DNS after validation therefore cannot change the connection's IP.
Each redirected request repeats the same checks.

The code parses bounded HTTP/1.0 and HTTP/1.1 framing: Content-Length,
chunked bodies/extensions/trailers, close-delimited bodies and interim
responses. Invalid framing and protocol upgrades fail closed. It does not
attempt HTTP/2, WebSockets or HTTP CONNECT; neither does the PHP reference.

The resolver's authenticated DNS answers and the socket runtime's documented
numeric-address/TLS semantics are the trust roots. Protection does not rely on
Spacefast's generic fetch gateway filtering the target hostname.

### Live deployment boundary

Spacefast's published npm runtime contract identifies Functions as Cloudflare
Dynamic Workers. Its compiler preserves `cloudflare:*` imports. Cloudflare's
[socket API](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)
supports IP connections and the runtime's TLS options include
`expectedServerHostname`.

Spacefast's own outbound gateway must admit socket connections for this worker
to operate. Live testing on 2026-10-15 found that the claimed Space's worker
rejects connections to public numeric destinations, including HTTP requests to
`66.241.125.232` (httpbingo.org) and `93.184.215.14`. These literal-address
requests bypass DNS, isolating the failure to socket egress. The runtime reports
`proxy request failed, cannot connect to the specified address`. The deployed
app boots with cross-origin isolation and runs shell commands, but its CORS
proxy cannot forward public requests on this deployment. This requires a
supported pinned-egress facility from Spacefast; it is not a functioning live
replacement for the Playground proxy yet.
Cloudflare also blocks socket connections to Cloudflare IP ranges and certain
other destinations; these restrictions can prevent access to hosts the
Playground PHP proxy reaches. Unsupported sockets, rejected connections,
DNS failures and TLS failures produce 502; there is no weaker hostname-fetch
fallback. Protocol compatibility is implemented, but unrestricted live
destination compatibility is not claimed. Upstream failures are logged on the
server without including their details in client responses. The worker returns
502; the tested Spacefast serving path exposed these failures as HTTP 500.

## Configuration

The entry module uses Spacefast's `env.DB` binding for a durable, Space-wide
budget of 600 requests per database-clock minute. It creates its own MySQL
counter table, increments atomically across isolates, and retains only the
current and preceding minute. Concurrent reads can conservatively deny an
earlier increment but cannot increase the budget. Delayed requests cannot
use an expired window. OPTIONS does not consume the budget. A denial is 429
with `Retry-After: 60`; a missing or failing database is 503. The SQL/broker
behavior is covered locally by contract fixtures. Live requests reached target
validation after the limiter, confirming that the counter queries succeed on
Spacefast's broker. The live 600-request ceiling was not stress-tested.

The reusable core also accepts `createCorsProxy({ rateLimit })` for an
alternative durable limiter. It returns a denial Response, or void to admit.

Alternatively, explicitly set `CORS_PROXY_DISABLE_RATE_LIMIT` to `true` or `1`
in the deployment environment. This is an operator choice; the repository
does not disable limiting by default or emulate it with isolate-local state.

`CUSTOM_SUPPORTED_ORIGINS_SPACE_SEPARATED` replaces the built-in origin list:

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
entry, so only `/cors-proxy` and its descendants wake the worker. Static
files keep their normal serving path. See the live deployment boundary above:
the tested Spacefast worker cannot forward pinned outbound connections.

### Combined Kandelo site

Build the app with the same-origin proxy, then package the generated output:

```sh
./run.sh build-browser --base / --out .context/kandelo-spacefast-static \
  --cors-proxy '/cors-proxy?url='
scripts/dev-shell.sh node apps/spacefast-cors-proxy/build-site.mjs \
  .context/kandelo-spacefast-static
```

The second command prints a unique `.context/spacefast-kandelo-build-*`
directory. It contains the static app, a bundled
`functions/cors-proxy/[...rest].mjs`,
`sf.jsonc` and the COOP/COEP/CORP response headers for documents and worker
scripts, including clean document URLs. Binary downloads have no custom
isolation headers: Spacefast cannot serve files above 100 MiB through its
PHP header-serving lane. Shared memory isolation remains on pages and workers.
Publish that directory through the Functions-aware Spacefast publishing flow.
The packager rejects symlinks, dotenv files, dependency/auth directories and
the private VFS product map. It does not copy test files or fixture keys.
Keep the Space's access settings private unless public access is requested.

Create the publishable output using the repository's existing esbuild tool:

```sh
scripts/dev-shell.sh npm --prefix apps/spacefast-cors-proxy run build
```

The command prints a new `.context/spacefast-cors-proxy-build-*` directory
containing only `handler.mjs` and `sf.jsonc`. It does not install dependencies,
authenticate, upload, modify an existing Space or include the test TLS keys.

## Verification

From the repository root:

```sh
scripts/dev-shell.sh npm --prefix apps/spacefast-cors-proxy test
```

The Node 24 test runner enforces **100% lines, branches and functions** for
`handler.ts` and every executable module under `src/`. This app has no dependency
on kernel, package or VFS build artifacts and does not use Vitest.

Tests include malformed DNS/HTTP input, DNS rebinding, mixed public/private
answers, TLS failures, origin/header rules, uploads, redirects, ranges, caps,
streaming and cancellation. A test-only module hook maps the production
Cloudflare socket import to real Node TCP/TLS sockets connected to loopback
fixtures. Tests check the requested public destination, original Host/SNI,
certificate trust and hostname mismatch without contacting the public network.
Mock transports cover protocol edge cases independently.

These are local code/transport tests. Separate live integration checks confirm
boot, service-worker isolation, shell execution, preflight, private/self-target
rejection and basic database-counter operation. Public HTTP/HTTPS proxying is
blocked by the socket-egress boundary above; live forwarding parity is unproven.
