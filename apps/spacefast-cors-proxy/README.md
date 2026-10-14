# Kandelo CORS proxy for Spacefast

A standalone Spacefast Functions worker implementing the Playground CORS
proxy protocol. Authentication and publication are deliberately deferred.
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

### Deployment boundary still to verify

Spacefast's published npm runtime contract identifies Functions as Cloudflare
Dynamic Workers. Its compiler preserves `cloudflare:*` imports. Cloudflare's
[socket API](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)
supports IP connections and the runtime's TLS options include
`expectedServerHostname`.

Spacefast's own outbound gateway must admit socket connections for this worker
to operate. This has **not** been verified against a deployed Spacefast Space.
Cloudflare also blocks socket connections to Cloudflare IP ranges and certain
other destinations; these restrictions can prevent access to hosts the
Playground PHP proxy reaches. Unsupported sockets, rejected connections,
DNS failures and TLS failures produce 502; there is no weaker hostname-fetch
fallback. Protocol compatibility is implemented, but unrestricted live
destination compatibility is not claimed.

## Configuration

Like Playground, the default fails closed with 503 until rate limiting has
been addressed. Supply a durable limiter using `createCorsProxy({ rateLimit })`
in the entry module. It returns a denial Response (for example 429 with
Retry-After), or void to admit. A limiter failure returns 503.

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

For Kandelo, use the future proxy origin with `VITE_CORS_PROXY_URL`, for example
`https://your-proxy.example/?url=`. Its existing range alias profile works with
this implementation. The canonical `./run.sh build-browser` currently enters
an isolated dev shell that does not preserve this environment variable, so
deployment integration must pass it explicitly inside the production build
command. This change does not select a proxy URL or alter the existing build.

Publish a generated bundle and `sf.jsonc`, not this source directory's tests,
fixture keys or local output. A root worker claims the whole site; deploy it
as its own proxy Space. If later colocated with Kandelo, use a file-router
entry at a non-underscore route and update the configured proxy prefix.
Authentication, access settings and publication are outside this draft.

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

This is local code/transport evidence, not a Spacefast gateway integration
test. Live Spacefast validation remains deferred with authentication.
