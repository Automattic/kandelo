# Constrain Browser Proxy Headers Without npm-Specific Behavior

## Status

Approved temporary design, pending implementation.

The long-term requirement is lossless guest HTTP forwarding. This design
records a bounded browser compatibility mode for the currently deployed
WordPress Playground CORS proxy and requires explicit future work to remove
that boundary.

## Why

The live Node demo reaches the npm registry through
`https://wordpress-playground-cors-proxy.net/?`. Pacote, npm's package
downloader, adds request metadata such as `pacote-version`,
`pacote-req-type`, `pacote-pkg-id`, and sometimes `pacote-integrity`.
Kandelo currently copies those guest headers onto the browser's outer fetch.

The deployed proxy advertises this fixed preflight allowlist:

```text
Accept, Authorization, Content-Type, git-protocol, wp_blog, wp_install,
x-cors-proxy-allowed-request-headers, x-cors-proxy-content-type
```

That preflight list is not the same as the proxy's unconditional relay
capability. The PHP relay drops `Authorization` unless the client also sends
`X-Cors-Proxy-Allowed-Request-Headers` with an explicit opt-in. Kandelo's
temporary profile does not implement that proxy-specific control protocol.
It treats `Authorization` as unsupported and does not expose either
`x-cors-proxy-*` control header as a guest relay capability.

The browser therefore blocks the request during CORS preflight before the
proxy or npm registry receives it. The visible error names
`pacote-req-type`, but any unsupported request header can cause the same
failure.

Kandelo cannot preserve an arbitrary header through that fixed proxy using
browser code alone. The browser will not expose a rejected response, and the
proxy has no request-envelope protocol that could reconstruct omitted headers.
Silently stripping arbitrary headers for every method would also be wrong:
custom headers can control authentication, conditions, ranges, or application
semantics.

For the current anonymous registry downloads, the unsupported headers are
client metadata and the request is a bodyless `GET`. A narrow, observable
compatibility boundary can omit headers the configured transport cannot carry
without adding Pacote or npm conditionals to the runtime.

## Contracts Touched

This work changes the browser host's HTTP-over-Fetch translation and browser
demo configuration. It must preserve:

- guest requests use the ordinary socket, TLS, HTTP, and host-network path;
- Node.js keeps direct network semantics and is not filtered;
- browser-only differences are explicit browser sandbox boundaries;
- headers are never silently downgraded on authenticated or state-changing
  requests;
- user-visible failures and compatibility omissions are diagnosable; and
- no package, hostname, registry response, or demo command receives a special
  runtime implementation.

## Decision

Represent the configured proxy's request capabilities explicitly and apply
one shared policy whenever a browser network backend dispatches through that
proxy.

The Pages application declares the fixed proxy's supported methods and header
names alongside its URL. The capability is configuration, not an inference
from the proxy hostname. Other embedders that omit the capability retain their
existing behavior, and a future proxy can declare a different contract.

The shared policy classifies each outgoing guest request before starting the
outer fetch:

1. Remove HTTP hop-by-hop headers as required by proxy translation.
2. Preserve every remaining guest header occurrence, value, and same-name
   order. Do not infer whether a field is singleton or list-valued, combine
   values, or remove duplicate values.
3. Determine which occurrences are CORS-safelisted for their values or have a
   name the configured proxy relays unconditionally. Treat credentials and
   proxy-specific control headers as unsupported by this temporary profile.
4. For an anonymous, bodyless `GET`, omit unsupported headers and emit a
   deduplicated host diagnostic naming the omitted headers and target origin.
5. For any other request, proceed only if its method and every required header
   can be represented by the configured transport. Otherwise fail before
   fetch with a specific proxy-capability error.

Filtering is per occurrence. Kandelo appends every retained occurrence to the
browser `Headers` object and leaves standards-required normalization or
combination to Fetch. The browser does not promise preservation of original
field-name casing or physical HTTP/1 field lines; Kandelo must not add further
loss by overwriting, deduplicating, reordering, or interpreting guest values.

The WordPress proxy relays `GET` and `POST`, reserves `OPTIONS` for browser
preflight, and does not relay `HEAD`. A direct `HEAD` may still succeed when
the target grants CORS. If the browser must fall back to this proxy, Kandelo
reports the unsupported method instead of converting `HEAD` to `GET`.

This policy intentionally does not inspect header prefixes, package names,
hostnames, URLs, or response bodies. `pacote-*` headers are omitted because
they are unsupported headers on an eligible anonymous `GET`, not because npm
is recognized.

## Capability Model

Add an immutable browser proxy capability value to the browser-kernel options
and worker protocol. It contains:

- the methods the proxy relays;
- the request-header names the proxy relays unconditionally; and
- whether safe-request omission is enabled.

Validation preserves capability spelling, order, and duplicate entries while
rejecting invalid HTTP tokens and a capability without a proxy URL. Header
membership is compared case-insensitively against that copied list. The worker
receives an immutable copy so callers cannot mutate policy after boot.

The implementation uses a shared helper for the plain HTTP fetch backend and
the decrypted HTTPS/TLS backend. Direct fetch attempts keep normal browser
behavior. The constrained projection is applied only to a request sent through
the configured proxy. External lazy VFS downloads carry no guest HTTP headers
and remain governed by their existing digest, size, and CORS checks.

## Diagnostics and Failure Semantics

Safe-request omission is never invisible. The host emits one diagnostic for a
target origin and sorted omitted-header set during a backend lifetime. Repeated
npm metadata and tarball requests do not flood the console, but the first
translation remains visible through the existing host diagnostic path and
kernel log.

The diagnostic explains that the headers were omitted because the configured
browser proxy cannot carry them. It does not claim the target rejected them.

An unrepresentable non-eligible request returns a deterministic HTTP bridge
failure rather than hanging or allowing the browser to produce an opaque CORS
exception. Plain HTTP and decrypted HTTPS paths expose equivalent status and
message content. No request is sent after policy rejection.

## Remove npm-Specific Routing

The current Node demo sets
`npm_config_registry=http://proxy.local/`. The TLS backend defaults that
sentinel hostname to the npm registry and rewrites tarball URLs in packument
JSON so later requests continue through the alias. Those are npm-specific
runtime behaviors and obscure the general HTTPS bridge being tested.

Return npm configuration to the canonical
`https://registry.npmjs.org/` URL. Remove the default `proxy.local` alias and
packument response rewriting. Explicit caller-provided host aliases remain a
generic testing or embedding feature, but Kandelo no longer supplies an npm
default.

Pacote then performs its normal HTTPS request. The guest TLS stack terminates
through Kandelo's existing browser TLS backend, and the outer request uses the
same configured proxy capability as any other guest HTTPS request.

## Future Full-Fidelity Work

Add an explicit item to `docs/future-improvements.md` under browser networking.
The temporary mode can be removed only when the production transport supports
lossless request forwarding. Acceptable directions are:

- update the existing proxy to validate and advertise requested header names;
- deploy a Kandelo-owned request-envelope relay with destination, credential,
  size, timeout, streaming, and private-network protections; or
- adopt another reviewed transport that preserves exact method, headers, and
  body.

That work must cover authentication policy, all supported HTTP methods,
conditional and range requests, redirects, streaming bodies, response
streaming, rate limiting, abuse prevention, and Node/browser parity. When it
lands, remove safe-request omission and its diagnostics rather than keeping a
hidden fallback.

The future-work entry is a declared conformance gap. It must not describe the
temporary browser mode as complete POSIX socket or HTTP fidelity.

## Testing

Implementation begins with failing tests for the shared policy and both
network backends. The focused cases prove:

- an anonymous bodyless `GET` forwards CORS-safelisted and configured headers;
- repeated allowed header occurrences retain every value and their original
  same-name order up to Fetch's browser-defined normalization;
- arbitrary unsupported metadata is omitted without naming Pacote;
- diagnostics are exact and deduplicated;
- `Authorization` is rejected before fetch because Kandelo does not implement
  the proxy's opt-in control protocol;
- an unsupported header on a body-bearing or state-changing request fails
  before fetch;
- unsupported proxy methods fail without method substitution;
- direct fetch behavior is unchanged;
- plain HTTP and decrypted HTTPS produce the same projection and failures;
- Node network behavior is unchanged; and
- mutable or malformed capability inputs are rejected.

Browser acceptance uses a cross-origin test proxy whose preflight response
matches the production header and method list. It must prove that the outer
request does not contain unsupported headers and that the browser reports no
CORS preflight error.

The staged and live product acceptance then boots the exact canonical Node
VFS, runs `npm install --verbose cowsay` against the canonical HTTPS registry,
requires a zero exit status, and executes the installed command. The test also
requires the generic omission diagnostic so success cannot hide which browser
boundary was exercised.

Validation runs through `scripts/dev-shell.sh` and includes focused host
Vitest, Chromium browser acceptance, browser asset checks, workflow checks,
documentation checks, and manual `./run.sh browser` verification. Exact
commands and omitted suites will be reported with the implementation.

## Alternatives Rejected

### Strip `pacote-*` by name

That fixes one client while leaving the same preflight defect for every other
guest program. It also embeds npm knowledge in the host runtime.

### Patch the bundled npm or Pacote distribution

The package behaves normally on Node.js and native hosts. Modifying it would
hide the browser transport boundary and require repeating the patch on every
npm update.

### Drop unsupported headers for every request

Headers on authenticated, conditional, range, or state-changing requests may
be semantically required. A broad silent downgrade violates truthful failure.

### Encode headers in an allowed header or URL

The deployed proxy has no decoding contract for such an envelope. Renaming or
encoding a header only changes what the upstream server receives.

## Non-Goals

- Claiming full browser HTTP or POSIX network fidelity.
- Sending credentials through the public WordPress proxy.
- Changing the external proxy in this implementation.
- Adding npm-, Pacote-, cowsay-, or registry-specific host behavior.
- Changing Node.js network semantics or the Kandelo ABI.
