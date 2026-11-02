# FIREFOX-KEEPALIVE-FETCH-BYPASSES-SERVICE-WORKER

Status: confirmed on Playwright's Firefox 155.0 build on macOS only; no
released Firefox has been checked yet; not filed.

## Defect

In Firefox 155 (Playwright build), a `fetch()` whose init dictionary sets
`keepalive: true`, made
from a document that a service worker controls, is not given to that
service worker: it goes straight to the network. Measured with the same
page and not affected: a keepalive `Request` object passed to `fetch()`,
with or without an init dictionary that leaves `keepalive` unset, and
`navigator.sendBeacon()`; both reach the worker. The Fetch standard's HTTP
fetch hands a request to the controlling service worker whenever its
service-workers mode is "all", and `keepalive` does not change that mode;
Chromium and WebKit route every one of these requests through the
worker.

## Why Kandelo is affected

Guest web pages run on Kandelo's preview origin, where every request for
`<scope>computer/<name>/` must reach the preview service worker, which
forwards it to the tab that runs the machine
(`docs/browser-support.md`, "Guest web previews run on their own origin").
The preview origin's network serves no guest bytes. A guest's keepalive
write therefore never reaches the guest's server in Firefox. WordPress's
editors save user preferences with a keepalive
`POST index.php?rest_route=/wp/v2/users/me`, which got a `405` from the
preview origin's static host in Firefox; `kandelo-wordpress.spec.ts`
("site editor loads assets through the bridge") fails on that request.

## Workaround and its cost

The guest helper Kandelo injects into guest HTML
(`apps/browser-demos/public/blob-iframe-interceptor.js`, step 4) wraps
`window.fetch`. Once per document it sends one keepalive probe to
`<machine>/__kandelo_keepalive_probe`, which only the preview worker
answers (`204` with `X-Kandelo-Preview-Worker: keepalive`,
`apps/browser-demos/preview-origin/preview-service-worker.js`). Until that
probe proves keepalive requests reach the worker, a same-origin fetch
whose init sets `keepalive: true` is sent without it. Keepalive `Request`
objects and `sendBeacon` are left alone (measured unaffected). Cost: in
Firefox such a request can
be cancelled if the page unloads before it completes, which keepalive
exists to prevent; every engine sends one extra worker-local request per
guest document; keepalive fetches made before the probe answers lose
keepalive in every engine. Documents whose own CSP governs scripts do not
get the helper, so the defect still reaches them in Firefox.

## Evidence

- `repro/` (no Kandelo code), through `tests/runtime-workarounds/driver.mjs`
  on 2026-10-29, macOS: Firefox 155.0 (Playwright) `reproduced`;
  controls Chromium 153.0.8010.12 and WebKit 26.6 `not-reproduced`.
  The page also records, unjudged, a keepalive `Request` object (with and
  without an init) and `sendBeacon`: `from-service-worker` in all three
  engines, Firefox 155.0 included (rerun the same day).
- The same result inside Kandelo's preview frame, and in a top-level
  same-origin page, so neither the sandbox nor the cross-origin frame is
  involved.

## Why this is not a Kandelo defect

The reproduction is a static page, a twelve-line service worker and a text
file. A plain fetch and a plain POST from the page reach the worker (the
page's sanity check), and the same fetch with `keepalive: true` does not.

## Draft upstream report

Not filed.

- Title: fetch() with keepalive: true bypasses the controlling service worker
- Product: Core, component DOM: Service Workers (or Networking)
- Steps: serve `repro/`, open `repro.html` over http://127.0.0.1.
- Expected: every request prints `from-service-worker`.
- Actual: `keepaliveGet` and `keepalivePost` print `from-network`.
- Reproduces on Firefox 155.0 (Playwright build) on macOS.

## Removal criteria

When a released Firefox routes keepalive fetches through the controlling
service worker (`runtime-workarounds run --id` reports `not-reproduced` on
a released Firefox), delete step 4 of
`apps/browser-demos/public/blob-iframe-interceptor.js`, the
`__kandelo_keepalive_probe` answer in
`apps/browser-demos/preview-origin/preview-service-worker.js`, and the
paragraph in `docs/browser-support.md` that links here.
