# Apply Browser Proxy Header Constraints at the Proxy Boundary

## Status

Revised design approved in conversation, pending review of this written spec.

The long-term requirement is lossless guest HTTP forwarding. This design
records a bounded compatibility profile for the currently deployed WordPress
Playground CORS proxy and requires explicit future work to remove that
boundary.

## Why

The live Node demo reaches the npm registry through
`https://wordpress-playground-cors-proxy.net/?`. Pacote, npm's package
downloader, adds request metadata such as `pacote-version`,
`pacote-req-type`, `pacote-pkg-id`, and sometimes `pacote-integrity`.

The deployed proxy advertises this fixed preflight allowlist:

```text
Accept, Authorization, Content-Type, git-protocol, wp_blog, wp_install,
x-cors-proxy-allowed-request-headers, x-cors-proxy-content-type
```

The browser blocks a proxied request containing `pacote-req-type` during
CORS preflight, before the proxy or npm registry receives it. This is not an
npm defect and it is not specific to the `pacote-*` prefix. Any request header
outside the transport's effective contract can cause the same failure.

The advertised preflight list is not identical to unconditional relay
behavior. The proxy drops `Authorization` unless the request also uses its
`X-Cors-Proxy-Allowed-Request-Headers` opt-in control. Kandelo will not
implement that proxy-specific authorization protocol in this change.
`Authorization` and both `x-cors-proxy-*` control headers are therefore absent
from Kandelo's temporary effective allowlist.

The proxy configuration is the correct owner for this limitation. Kandelo
must not teach its generic HTTP parser about MIME types, range syntax, Fetch's
CORS safelist thresholds, Pacote, npm, or registry hostnames merely to work
around one configured transport.

## Contracts Touched

This work changes browser proxy configuration and the points that dispatch
requests through that proxy. It must preserve:

- guest requests use the ordinary socket, TLS, HTTP, and host-network path;
- the existing HTTP man-in-the-middle bridge parses each guest request once;
- direct browser requests are not filtered for proxy limitations;
- Node.js keeps direct network semantics and is not filtered;
- every use of the configured browser proxy consumes the same explicit
  profile;
- allowed request-header occurrences are not overwritten or value-deduped;
- authenticated or state-changing requests are not silently downgraded;
- compatibility omissions are diagnosable; and
- no package, header prefix, hostname, response body, or demo command receives
  special runtime behavior.

## Current Proxy Routing

The browser application has one conceptual proxy setting, but proxy dispatch
currently occurs in several execution realms:

- `TlsNetworkBackend` terminates guest TLS, translates the already-parsed
  guest HTTP request into Fetch, and wraps the target URL when a browser proxy
  is configured.
- `FetchNetworkBackend` first attempts a direct Fetch and wraps the URL only
  on its configured proxy fallback.
- the browser lazy-VFS fetcher may retry a headerless artifact download through
  the proxy;
- the service worker wraps cross-origin browser-owned fetches and passes
  already-wrapped proxy requests through to the network; and
- the development server provides a same-origin proxy endpoint, while
  production uses the public WordPress proxy.

The guest MITM already parses the request line, header fields, and body
framing because Fetch cannot accept raw HTTP bytes. The proxy fix reuses those
parsed field occurrences. It does not add another HTTP parser or parse field
values for application semantics.

## Decision

Replace the loose proxy URL plus separately supplied capabilities with one
immutable browser proxy configuration object. Conceptually it contains:

```ts
interface BrowserCorsProxyConfig {
  readonly url: string;
  readonly allowedRequestHeaderNames: readonly string[];
  readonly allowAnonymousGetHeaderOmission: boolean;
}
```

The application owns the production object and passes or serializes the same
profile to every proxy-dispatch site. The URL and behavior cannot drift apart.
The profile is explicit configuration, not behavior inferred from the proxy
hostname.

For the current WordPress proxy, the effective allowed names are:

```text
accept
content-type
git-protocol
wp_blog
wp_install
```

This is deliberately conservative. Some other names can be CORS-safelisted
for particular values, but exploiting those cases would require interpreting
field values. That broader fidelity is future work, not part of this temporary
profile.

Configuration arrays are copied and made immutable when they cross the browser
worker boundary. Their spelling, order, and duplicate entries are otherwise
left alone. Header-name membership is compared case-insensitively. The
configuration is never relayed as request data.

## Name-Only Request Projection

Projection happens only when code elects to send a request through the
configured proxy. It operates on the header occurrences already produced by
the existing HTTP-to-Fetch bridge:

1. Keep the bridge's existing treatment of transport-controlled fields needed
   to construct the browser Fetch request. Expanding HTTP parser or hop-by-hop
   semantics is outside this fix.
2. Examine each remaining occurrence's name only.
3. If the name is in the proxy profile, append that occurrence to the proxy
   request without inspecting or changing its value.
4. Otherwise mark the occurrence unsupported. Never group, combine,
   overwrite, reorder, or value-deduplicate occurrences in Kandelo.
5. Let the browser perform whatever casing, whitespace, or field-line
   normalization Fetch requires.

The existing guest parsers currently store headers in a
`Map<string, string>`, which overwrites earlier same-name occurrences. Change
that representation to an ordered occurrence list and use narrow lookup
helpers where the bridge needs a field such as `Host`. Construct browser
`Headers` with `append()`, not `set()`.

No code in this path parses MIME types, ranges, CORS-unsafe bytes, cumulative
safelist sizes, package metadata, or header prefixes.

## Application at Every Proxy Boundary

The same proxy-owned projection is applied at the point where each target URL
becomes a proxy URL:

- `TlsNetworkBackend` projects immediately before its configured proxied
  Fetch. It does not alter requests when no proxy is configured.
- `FetchNetworkBackend` sends the original request on its direct attempt. Only
  the fallback Fetch receives projected headers.
- the lazy-VFS fetcher receives the same proxy object. Its artifact requests
  currently carry no caller headers, so projection is a no-op and its digest,
  size, cache, and CORS behavior remain unchanged.
- the service worker receives the complete profile through build-time
  injection. Before it sends any `Request` to the proxy, it creates the
  outgoing request with only allowed names. This covers browser-owned
  cross-origin fetches and provides defense in depth for a request already
  wrapped by a host backend.
- the development same-origin proxy uses the same declared profile as
  production so local success cannot depend on accepting a broader request
  than the deployed proxy.

The service worker sees an already-created browser `Request`, so Fetch may
already have normalized its fields. It must not add value-level interpretation
or claim to restore raw HTTP field lines. Guest header-occurrence preservation
belongs earlier in the MITM bridge; service-worker projection enforces the same
name-level transport boundary in its own execution realm.

## Omission and Failure Semantics

For an anonymous, bodyless `GET`, unsupported occurrences may be omitted. The
owner emits one diagnostic for a target origin and sorted omitted-name set so
repeated metadata requests do not flood the console. Sorting and deduplicating
diagnostic names does not alter request data.

A request containing a credential header is not eligible for omission.
`Authorization`, `Cookie`, `Cookie2`, and `Proxy-Authorization` therefore fail
before proxy dispatch when present as end-to-end request fields. This profile
does not implement the WordPress proxy's authorization opt-in control.

A body-bearing request, a request using a state-changing method, or any other
request outside the narrow omission case fails before proxy dispatch when it
contains an unsupported occurrence. Failure is deterministic and identifies
the configured proxy boundary; it does not claim the origin rejected the
header. No proxied request is sent after rejection.

Plain HTTP, decrypted HTTPS, and service-worker paths expose equivalent
projection rules within the information available in their respective
execution realms.

## Remove npm-Specific Routing

The current Node demo sets
`npm_config_registry=http://proxy.local/`. The TLS backend defaults that
sentinel hostname to the npm registry and rewrites tarball URLs in packument
JSON so later requests continue through the alias. Those are npm-specific
runtime behaviors and obscure the general HTTPS bridge being tested.

Return npm configuration to the canonical
`https://registry.npmjs.org/` URL. Remove the default `proxy.local` alias and
packument response rewriting. Explicit caller-provided host aliases remain a
generic testing or embedding feature.

Pacote then performs its normal HTTPS request. The guest TLS stack terminates
through Kandelo's existing browser TLS backend, and proxy dispatch applies the
same configured profile as every other browser request using that transport.

## Future Full-Fidelity Work

Add an explicit item to `docs/future-improvements.md` under browser networking.
The temporary profile can be removed only when the production transport
supports lossless request forwarding. Acceptable directions are:

- update the existing proxy to validate and advertise requested header names;
- implement and review its authorization opt-in contract;
- deploy a Kandelo-owned request-envelope relay with destination, credential,
  size, timeout, streaming, and private-network protections; or
- adopt another reviewed transport that preserves exact method, headers, and
  body.

That work must cover authentication, all supported HTTP methods, conditional
and range requests, redirects, request and response streaming, rate limiting,
abuse prevention, and Node/browser parity. When it lands, remove omission mode
and its diagnostics rather than retaining a hidden fallback.

The future-work entry is a declared conformance gap. It must not describe the
temporary browser mode as complete POSIX socket or HTTP fidelity.

## Testing

Implementation begins with failing tests for the proxy configuration,
name-only projection, and each dispatch site. Focused tests prove:

- the URL and allowed-name profile remain paired across application, worker,
  lazy-fetch, and service-worker configuration;
- configuration spelling, order, and duplicate entries are preserved;
- membership is case-insensitive and never reads a header value;
- repeated allowed occurrences retain all values and same-name order up to
  Fetch normalization;
- arbitrary unsupported names are omitted from eligible bodyless `GET`s
  without recognizing Pacote;
- diagnostics are exact and deduplicated independently of request data;
- credential fields and lossy non-eligible requests fail before proxy fetch;
- direct browser Fetch receives the unprojected request;
- every proxied Fetch receives the projected request;
- lazy-VFS downloads remain headerless and otherwise unchanged;
- Node networking is unchanged; and
- the Kandelo ABI remains at version 42.

Browser acceptance uses a cross-origin test proxy whose preflight response
matches production. It proves that an allowed header reaches the proxy, an
arbitrary unsupported header does not, and no CORS preflight error occurs.
Service-worker coverage exercises both an already-wrapped proxy request and a
browser-owned cross-origin request.

The staged and live product acceptance boots the exact canonical Node VFS,
runs `npm install --verbose cowsay` against the canonical HTTPS registry,
requires a zero exit status, and executes the installed command. It also
requires the generic omission diagnostic so success cannot hide the temporary
browser boundary.

Validation runs through `scripts/dev-shell.sh` and includes focused host
Vitest, Chromium browser acceptance, service-worker behavior, browser asset
checks, workflow checks, documentation checks, and manual `./run.sh browser`
verification. Exact commands and omitted suites are reported with the
implementation.

## Alternatives Rejected

### Interpret the browser CORS safelist

Parsing MIME types, range syntax, unsafe bytes, and cumulative size thresholds
would preserve a few names for certain values, but it makes the generic HTTP
bridge reason about browser policy that belongs to the configured proxy
boundary. The conservative explicit profile is smaller and truthful.

### Filter only in the service worker

That would repair the deployed Pages application but miss browser embedders
and tests that configure a proxy without service-worker control.

### Copy the allowlist into every backend

Independent lists in TLS, plain Fetch, lazy download, and service-worker code
would drift. One authoritative profile must feed every dispatch site.

### Strip `pacote-*` by name

That fixes one client while leaving the same preflight defect for every other
guest program. It also embeds npm knowledge in the runtime.

### Patch bundled npm or Pacote

The package behaves normally on Node.js and native hosts. Modifying it would
hide the browser transport boundary and require repeating the patch on every
npm update.

### Drop unsupported headers for every request

Headers on authenticated, conditional, body-bearing, or state-changing
requests may be required. A broad silent downgrade violates truthful failure.

## Non-Goals

- Claiming full browser HTTP or POSIX network fidelity.
- Implementing semantic header classification.
- Implementing the proxy's conditional authorization opt-in.
- Changing the external proxy in this implementation.
- Adding npm-, Pacote-, cowsay-, or registry-specific host behavior.
- Changing Node.js network semantics or the Kandelo ABI.
