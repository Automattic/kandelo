# Multi-Instance Service Worker Routing — Design

Status: proposed
Date: 2026-09-21
Contract: Host Runtime + Browser And User (see `CLAUDE.md`)

## Why

Today a single browser Service Worker (SW) can route requests to exactly
one live Kandelo machine per deployment scope. A SW is a singleton per
(origin + scope path), so two tabs of the same demo share one SW — and
that SW keeps its bridge routing state in **module-global variables**,
not in a per-tab structure:

- `bridgePort` — the one MessagePort the SW forwards every `/app/` request
  to (`service-worker.js:231`).
- `currentSessionId`, `cookieJar`, `liveBridgeEpoch`, `durableAuthority`
  — one live session's identity and cookie jar
  (`service-worker.js:248-262`).
- `appPrefix` — one intercepted namespace, e.g. `/base/app/`
  (`service-worker.js:234`).

The fetch handler routes any same-origin `/app/` request straight to that
single port with no per-client disambiguation
(`service-worker.js:1570-1574`), and `commitBridgeState` overwrites the
globals on every `init-bridge` (`service-worker.js:695-703`). The result
is **last-writer-wins**: when a second tab boots a machine, its
`init-bridge` clobbers the first tab's `bridgePort`, so *both* tabs'
`/app/` requests are then served by the second tab's kernel, and the
first tab's server silently stops receiving its own requests. A
navigation in either tab calls `resetSessionState()`
(`service-worker.js:1544-1550`), wiping the shared cookie jar the other
tab was using.

`sessionId` already scopes the durable cookie jar per boot
(`live-setup.ts:1522`, generated with `crypto.randomUUID()`), but it does
**not** scope routing — there is one `bridgePort` regardless of how many
sessions exist.

Users hit this whenever they open two Kandelo-backed servers at once
(two WordPress demos, a demo plus a shared link, a demo embedded in an
iframe alongside another). One of the machines becomes unreachable or
starts answering with the other machine's content. We want multiple live
Kandelo instances to coexist, each reachable by a stable, shareable URL,
and we want a viewer to be told clearly when the machine it is looking at
goes away.

## Goals

1. **Isolation** — any number of live Kandelo machines coexist under one
   deployment scope; a request is always served by the machine it belongs
   to, never another.
2. **Addressability** — each machine has a stable, human-readable,
   shareable URL of the form `/base/app/<three-fun-word>/…`. Opening that
   URL in a *different* tab (or from a shared link) connects to the *same
   running machine*, hosted by whichever tab booted its kernel.
3. **Legible disconnect** — a tab viewing a machine whose host tab has
   closed is shown a clear "machine offline" state, proactively (not only
   on the next failed request), and a transient SW restart shows
   "reconnecting…", not "offline".

## Non-goals

- **Machine migration / persistence across host-tab close.** When the
  host tab closes, its kernel (and thus the machine's live state) is
  gone. Re-hosting a closed machine under the same name requires VFS
  snapshot persistence and is a separate future feature. Closing the host
  tab makes the machine **terminally offline** — this is the truthful
  failure, per the Platform Values contract.
- **Sharing one kernel across tabs.** The kernel runs in exactly one
  tab's worker. Cross-tab viewing is achieved by the SW relaying to the
  owning tab's bridge port, not by sharing the kernel.
- **Node host changes.** The bridge protocol
  (`init-bridge`/`need-bridge`/`bridge-restored`) is used only by the
  browser SW and `apps/browser-demos/lib/init/*`; `host/src` does not use
  it. This work is browser-scoped. (Parity is re-checked in Testing.)

## Core idea: the SW is already a switchboard

The SW holds a live MessagePort to every tab that ran `init-bridge`. To
serve tab B a machine hosted in tab A, the SW simply forwards over tab
A's port — tab B never touches tab A's kernel. So the entire change is:
**replace the single-instance globals with a registry keyed by machine
name, and pick the right entry per request.** Every existing
single-instance function (`handleAppRequest`, cookie jar, durable
authority, restart recovery, redirect-into-app) becomes an operation on
one registry entry instead of on globals.

Crucially, the name in the path cannot be the *only* routing key. Real
apps emit **root-relative** URLs (`/wp-content/style.css`, a bare `/foo`
link) that arrive at the SW with no `<name>` segment. The current code
already fights this with `shouldRedirectIntoApp` / the 307 redirect
(`service-worker.js:1314-1355`) and with `appClientIds`
(`service-worker.js:238`, `1318-1337`). We generalize that: the SW keeps
a `clientId → name` **viewing map**, set when a client first loads
`/app/<name>/`, and uses it to attribute nameless requests to the right
machine. The name resolves addressable/initial requests; the viewing map
catches the subresource flood.

## Target architecture

### Data structures (replace the globals)

```
instances: Map<name, InstanceRecord>
clientToInstance: Map<clientId, name>   // viewing map (host tab AND viewer tabs)

InstanceRecord = {
  name,               // "happy-purple-otter"
  appPrefix,          // SCOPE_PATH + "app/" + name + "/"
  owningClientId,     // clientId of the tab whose kernel runs this machine
  bridgePort,         // owning tab's MessagePort; null while awaiting re-registration
  sessionId,          // per-instance (still crypto.randomUUID from the page)
  cookieJar,          // per-instance Map (was the global cookieJar)
  liveBridgeEpoch,    // per-instance (was the global liveBridgeEpoch)
  durableAuthority,   // per-instance, persisted under a name-keyed Cache Storage key
  viewerClientIds,    // Set<clientId> currently viewing /app/<name>/
  status,             // "live" | "reconnecting" | "offline"
}
```

The existing `pendingRequests`/`nextRequestId` request-correlation map can
stay global (request ids are unique across instances) or move per-record;
global is simpler and safe. `appPrefix` as a lone global goes away;
`isAppPath` becomes a registry lookup.

### Naming (SW-minted, decision 2)

- The SW owns name minting. On `init-bridge`, the SW generates a
  `three-fun-word` name, checks `instances.has(name)`, regenerates on
  collision (bounded retries; the word space is large — see Wordlist),
  builds `appPrefix = SCOPE_PATH + "app/" + name + "/"`, creates the
  `InstanceRecord`, and replies `bridge-ready { name, appPrefix }`.
- The page uses the returned `appPrefix` for the web-preview URL and the
  iframe `src`. This reorders `live-setup.ts` slightly: `setWebPreview`'s
  URL is set *after* the handshake returns the minted prefix, not from
  the static `APP_PREFIX` constant (`live-setup.ts:1513`).
- **Wordlist:** lives in a TS/JSON source of truth and is **injected at
  SW build time** into `service-worker.js`, exactly like
  `__CORS_PROXY_CONFIG__` and `__BLOB_IFRAME_INTERCEPTOR__`
  (`service-worker.js:1010`, `1037`). The SW is a classic script and
  cannot import modules at runtime. A modest list (e.g. 3×256 words →
  ~16.7M combinations) makes live collisions negligible; the SW
  regenerates on the rare hit regardless.

### Name is untrusted URL input (Browser And User contract)

When any client requests `/app/<name>/…`, `<name>` is untrusted. The SW
must:
- Validate it against a strict format regex (three lowercase ASCII words,
  single `-` separators, each word bounded in length) *before* any
  registry use — reject malformed names loudly (404), never treat them as
  a prefix.
- Require registry membership: an unknown but well-formed name resolves to
  no instance → 404/503 with a clear body, not a hang and not a fallback
  to some other machine.
- Reuse the existing `normalizeScopePath`/`isValidAppPrefix` bounds
  (`service-worker.js:117-212`) for the composed `appPrefix`.

### Request dispatch (fetch handler)

Replace the single-port fast path (`service-worker.js:1570-1574`) with:

1. If `url.pathname` matches `SCOPE_PATH + "app/" + <name>/…` and `<name>`
   is valid → resolve `instance = instances.get(name)`. On a navigation
   or app-referer subresource, record `clientToInstance.set(clientId,
   name)` and `instance.viewerClientIds.add(clientId)` (generalizes
   `markAppClient`, `service-worker.js:1318-1337`).
2. Else if the request has no name segment → `name =
   clientToInstance.get(event.clientId)`; if present and the request is
   app-initiated, `redirectIntoApp` into *that instance's* `appPrefix`
   (generalizes `service-worker.js:1595-1598`).
3. Dispatch to `instance.bridgePort` via `bridgeFetch(instance, …)`
   (`bridgeFetch` and `handleAppRequest` gain an `instance` parameter;
   they read the record's jar/session/epoch instead of globals).
4. If `instance` exists but `bridgePort` is null → `ensureBridge(instance)`
   (per-instance `need-bridge`, below). If no instance / offline → 503 or
   404 with a clear body.

Cookie injection, Set-Cookie capture, redirect rewriting, and body URL
rewriting (`handleAppRequest`, `service-worker.js:1622-1800`) all key off
the record's `appPrefix`/`cookieJar`/`sessionId`/`liveBridgeEpoch`.
Because cookies key off the instance, two tabs viewing the same machine
correctly share its jar (same server, same session) — this falls out for
free.

### Per-instance durable authority + SW-restart recovery

- `durableAuthority` becomes per-name, persisted under a name-keyed Cache
  Storage entry (generalizing `BRIDGE_AUTHORITY_KEY`,
  `service-worker.js:174`). The `writeBridgeAuthority` /
  `scheduleBridgeTransition` / `scheduleBridgeRestoration` machinery
  (`service-worker.js:553-942`) operates on one record.
- On SW restart, `bridgePort` for every instance is lost. The
  `need-bridge` broadcast (`requestBridgeFromClient`,
  `service-worker.js:761-869`) is generalized: each *hosting* client
  re-registers its `name → new bridgePort` (matched against that name's
  `durableAuthority`); each *viewing* client re-asserts its `clientId →
  name`. The page-side responder (`sw-bridge-fetch.ts:92-104`) already
  replies `bridge-restored { appPrefix, sessionId }`; it will include
  `name` and only a *hosting* tab responds for a given name.
- **Cleanup:** when an instance goes terminally offline (host tab gone),
  its name-keyed Cache Storage authority is GC'd. This replaces today's
  `resetSessionState` on navigation with an owner-scoped teardown.

### Offline lifecycle (decision 3 + viewer UI)

**Detection — how the SW learns a host is gone:**
- *Clean close:* the hosting tab posts `{ type: "instance-closing", name }`
  from `pagehide`/`beforeunload`. Instant.
- *Crash / kill (no pagehide):* the SW reconciles against
  `self.clients.matchAll({ type: "window" })` (already used at
  `service-worker.js:767`). If `instance.owningClientId` is no longer a
  live window, the machine is gone. Checked lazily on the next dispatch
  and/or a light interval; a dispatch that times out is a trigger.
- *Host navigates away:* the host tab's top-level navigation to a non-app
  page tears down instances it owns (replaces the global
  `resetSessionState`, `service-worker.js:1544-1550`).

**Terminal vs transient (the `matchAll` disambiguation):**
- `owningClientId` absent from `matchAll` → **terminal offline**. Because
  names are SW-minted per boot, the machine cannot return under the same
  name. `status = "offline"`.
- `owningClientId` still present but `bridgePort` null (SW restarted) →
  **transient**. `status = "reconnecting"`; recover via `need-bridge`.

**Notification — how viewers find out:**
- *Proactive push:* on marking an instance offline/reconnecting, the SW
  messages each `viewerClientId`:
  `clients.get(id).then(c => c.postMessage({ type: "machine-offline" |
  "machine-reconnecting", name }))`. Viewers react immediately, even while
  idle.
- *Reactive backstop:* any in-flight/subsequent request to a dead machine
  returns 503 (generalizing `fetchRestoredAppRequest`,
  `service-worker.js:1517-1533`), covering a missed push (e.g. SW
  mid-restart).

**Viewer-side UI — two homes:**
- *Host tab / demo chrome:* the web-preview pane
  (`host.setWebPreview(...)`, `live-setup.ts:1511`) gains offline /
  reconnecting states driven by the SW message listener.
- *Raw shared-link viewer (no Kandelo chrome):* inject a tiny **liveness
  client** into served app HTML, reusing the existing HTML-injection seam
  (`injectBlobIframeInterceptor`, `service-worker.js:1001-1034`;
  build-injected like `__BLOB_IFRAME_INTERCEPTOR__`). It listens for
  `machine-offline`/`machine-reconnecting` and renders an overlay so a
  bare `/app/<name>/` tab still shows a clear state.

## Message protocol changes

- `init-bridge` (page → SW): drop the page-supplied `appPrefix`; keep
  `sessionId`. SW mints the name.
- `bridge-ready` (SW → page): add `name` and `appPrefix`.
- `need-bridge` (SW → clients) / `bridge-restored` (client → SW): add
  `name`; only the hosting tab answers for its name.
- New `instance-closing` (host → SW): `{ name }` on pagehide.
- New `machine-offline` / `machine-reconnecting` (SW → viewer):
  `{ name }`.

## Files touched

- `apps/browser-demos/public/service-worker.js` — registry, minting,
  dispatch, per-instance jar/authority/recovery, offline lifecycle,
  liveness-client injection, name validation. (Largest change; this file
  is already ~1900 lines — extract cohesive pieces, e.g. the registry and
  the name generator, into build-injected modules where the classic-script
  constraint allows, to keep it readable.)
- `apps/browser-demos/lib/init/service-worker-bridge.ts` — handshake
  returns `{ name, appPrefix }`; page consumes minted prefix.
- `apps/browser-demos/lib/init/sw-bridge-fetch.ts` — `need-bridge`
  responder includes `name`; add `pagehide` → `instance-closing`.
- `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts` — set
  web-preview URL from minted prefix; wire offline/reconnecting pane
  states.
- New: canonical wordlist source + a small name generator, plus SW
  build-injection wiring (alongside the existing `__CORS_PROXY_CONFIG__` /
  `__BLOB_IFRAME_INTERCEPTOR__` injection).
- New: liveness-client source + its SW build-injection.

## Testing plan (Validation contract)

- **Node/Vitest host tests** — extend
  `apps/browser-demos/test/service-worker-scope-state.spec.ts` and
  `service-worker-bridge.test.ts`: registry isolation (two names route to
  two ports), minting + collision regeneration, name validation of
  untrusted input, per-instance cookie-jar isolation, `clientId → name`
  attribution of nameless requests, per-instance restart recovery, offline
  push + 503 backstop, terminal-vs-reconnecting classification.
- **Browser (Playwright)** — this is a browser-facing fix; code reasoning
  and Vitest are not sufficient (Validation + Browser contracts). Verify
  with real tabs: (a) two demos in two tabs stay isolated; (b) a
  `/app/<name>/` link opened in a second tab reaches the same machine;
  (c) closing the host tab shows the viewer an offline overlay
  proactively; (d) an SW restart shows "reconnecting…" then recovers. Note
  the Firefox/WebKit Playwright constraints already recorded for this repo.
- **Parity note** — confirm no `host/src` path regresses; the SW bridge
  protocol is browser-only, so Node parity is unaffected, but the shared
  `http-bridge.ts` framing must be exercised by the host tests above.
- Manual `./run.sh browser` for the user-visible flows in (a)–(d).

## Open questions / staging

1. **Staging:** Phase 1 = registry + minting + clientId-fallback routing +
   per-instance jar/recovery (delivers isolation and same-scope naming).
   Phase 2 = cross-client viewing proxy + offline lifecycle + viewer UI.
   Cross-client viewing largely falls out of "route by name regardless of
   origin client"; the added Phase-2 work is the offline lifecycle and the
   liveness client. Land as two reviewable steps or one — TBD with
   maintainer.
2. **Wordlist size/source** — pick the list and its home (new
   `web-libs`/`apps` source). 3×256 is the working assumption.
3. **Interval reconciliation** — whether to poll `matchAll` on a timer for
   crash detection, or rely on pagehide + lazy-on-dispatch only. Lean
   lazy + pagehide first; add a timer only if crash cases prove leaky.
