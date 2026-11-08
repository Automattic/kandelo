# FIREFOX-KEEPALIVE-SW-BYPASS

Status: confirmed. Not filed; human-only reporting.

## Defect

A controlled document's `fetch(url, { keepalive: true })` bypasses the
controlling service worker in the observed Firefox builds. GET, POST and
PUT reach the network server. The same requests without keepalive reach
`fetch` interception, preserving their methods and bodies.

The [Fetch main-fetch algorithm](https://fetch.spec.whatwg.org/#concept-main-fetch)
allows service-worker interception for ordinary controlled-document Fetch;
keepalive does not opt out. The existing
[Web Platform Test](https://github.com/web-platform-tests/wpt/blob/master/service-workers/service-worker/fetch-event.https.html)
also checks keepalive on intercepted requests. Its historical Firefox
failure is not evidence for a particular current runtime version.

## Why Kandelo is affected

The browser HTTP bridge depends on service-worker interception. WordPress's
unchanged preferences-persistence library requests keepalive delivery for
`/wp/v2/users/me` updates. Firefox sends those updates to the static host,
which truthfully rejects the unhandled computer route with HTTP 503.
PHP-FPM and FrankenPHP both encounter the limitation. It does not prove
the cause of the separate intermittent editor-canvas observation failures:
a complete persistence run also passes while these preference requests fail.

## Workaround and its cost

None adopted. Disabling keepalive would lose delivery semantics. The
current browser-support documentation records the limitation explicitly.
A general transport fix would need to preserve method, body, credentials,
abort behavior and delivery after the initiating document unloads; changing
WordPress or silently retrying writes is not an acceptable substitute.

## Evidence

On macOS, the initial isolated native Fetch probe reproduces with
Playwright Firefox revision 1543, version 155.0. Chromium revision 1243,
153.0.8010.12, and WebKit revision 2359, 26.6, intercept all six requests.
These probes use a small HTTP server and native service-worker APIs,
without any Kandelo runtime, guest, package or application code.

A separate owned headless profile of installed Firefox 159.0.1 reproduces
all three keepalive bypasses too; its user agent reports Firefox/159.0.
No existing user browser/profile is attached to or terminated. The initial
private probe's home cleanup leaves a macOS-protected Downloads directory;
that cleanup result is separate from its delivered HTTP observations.

The maintained reproduction reports `reproduced` only when all three
ordinary requests pass interception/body controls and all three keepalive
requests return the static network response. Failed controls or mixed
results are `inconclusive`; all-six interception is `not-reproduced`.
Run it on loopback HTTP with the registry driver. The server must serve
`network.json` for POST and PUT too, as that driver does.

## Why this is not a Kandelo defect

The reproduction contains only HTML, native Fetch and a minimal service
worker. Its network/worker response discriminator needs no Kandelo build
or request bridge. The installed released Firefox control also excludes
a defect confined to Playwright's patched Firefox.

## Draft upstream report

Not filed. Suggested title: Controlled-document keepalive Fetch bypasses
service-worker fetch interception. Product: Core; component: DOM: Fetch.
Serve `repro/` on loopback HTTP, open `repro.html`, and inspect its verdict
and per-request observations. Expected: the worker handles all six requests.
Actual on the observed Firefox versions: only ordinary requests reach it.
Chromium and WebKit controls handle all six. Check existing Mozilla reports
before a maintainer files; the historical WPT failure is not a filed report
for this particular reproduction.

## Removal criteria

Keep the reproduction and limitation until a released Firefox version
intercepts all cases. If a general compatibility transport is later added,
remove it only after that release boundary is established and delivery
through document unload is verified. There is no production workaround to
remove today.
