# Multi-Instance Service Worker Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let multiple live Kandelo machines coexist under one browser
deployment scope, each reachable by a stable, shareable
`/base/app/<three-fun-word>/` URL — including from other tabs — with a
clear offline state when a machine's host tab goes away.

**Architecture:** Replace the Service Worker's single-instance global
bridge state with a registry keyed by an SW-minted machine name that
lives in the URL path. Route addressable requests by name and
root-relative subresource requests by a `clientId → name` viewing map.
Per-instance cookie jars, durable authority, and SW-restart recovery.
Cross-tab viewing works because the SW relays each request to the owning
tab's bridge port; the kernel still runs in exactly one tab. Offline is
surfaced proactively to the demo chrome via a push message, with an
SW-served 503 HTML page as the fallback when no chrome is present.

**Tech Stack:** TypeScript (page-side `apps/browser-demos/lib/init/*`),
a classic-script Service Worker (`apps/browser-demos/public/service-worker.js`),
Vitest/`node:test` for page-side units, Playwright for real-browser SW
behavior against a Node fixture server.

**Spec:** `docs/superpowers/specs/2026-09-21-multi-instance-service-worker-routing-design.md`

## Global Constraints

- **Browser-only change.** The bridge protocol
  (`init-bridge`/`need-bridge`/`bridge-restored`) is used only by the SW
  and `apps/browser-demos/lib/init/*`. Do not touch `host/src`, the
  kernel, or the ABI. No `ABI_VERSION` bump; no `abi/snapshot.json`
  regeneration.
- **No app-HTML injection for offline.** Offline UI is owned by the demo
  chrome (via SW push). The SW serves a 503 HTML page only when no chrome
  is present. Do not inject a liveness client into served app HTML.
- **Name is untrusted URL input** (Browser And User contract). Validate
  `<name>` against a strict format regex *before* any registry use and
  require registry membership; reject malformed/unknown names loudly
  (404 / 503 HTML page), never fall back to another machine.
- **Wordlist/generator/validator embedded in `service-worker.js`** — not
  build-injected. Static data, must always be available including in the
  Playwright harness (which serves near-raw worker source). This
  deliberately simplifies the spec's "build-injected wordlist" wording.
- **Truthful failure.** A closed host tab makes its machine terminally
  offline (names are minted per boot and cannot return). No migration, no
  fake success. An SW restart while the host tab is alive is transient
  ("reconnecting"), not offline.
- **Node/browser parity.** The SW is browser-only, so there is no Node
  peer to change; still run the shared `http-bridge` page unit tests and
  confirm no `host/src` path regresses.
- **Name format (verbatim):** three lowercase ASCII words joined by single
  hyphens; validator regex `^[a-z]{2,12}-[a-z]{2,12}-[a-z]{2,12}$`; a
  machine appPrefix is exactly `SCOPE_PATH + "app/" + name + "/"`.

---

## File Structure

- `apps/browser-demos/public/service-worker.js` — **modify.** The core
  change: instance registry, embedded name generator/validator, minting
  on `init-bridge`, name + `clientId`-fallback dispatch, per-instance
  cookie jar / durable authority / restart recovery, offline lifecycle,
  503 HTML page. This file is ~1900 lines; thread an `instance` argument
  through the request path rather than reading globals.
- `apps/browser-demos/lib/init/service-worker-bridge.ts` — **modify.**
  Handshake stops sending a page-chosen `appPrefix`; returns the
  SW-minted `{ name, appPrefix }`.
- `apps/browser-demos/lib/init/sw-bridge-fetch.ts` — **modify.**
  `setupServiceWorkerFetchBridge` returns the minted `{ name, appPrefix }`;
  the `need-bridge` responder includes `name`; add `pagehide` →
  `instance-closing`.
- `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts` —
  **modify.** Set the web-preview URL from the minted `appPrefix`; render
  offline/reconnecting pane states from SW push messages.
- `apps/browser-demos/lib/init/service-worker-bridge.test.ts` —
  **modify.** node:test units for the new handshake shape.
- `apps/browser-demos/test/service-worker-scope-state.spec.ts` —
  **modify.** Playwright tests: extend the `installBridge` helper to read
  the minted prefix, and add multi-instance / offline scenarios.

---

## Task 1: Core registry, SW-minted naming, and name-based routing

This is the atomic core: both sides of the handshake change together
(the appPrefix becomes server-authoritative), and the SW globals become a
per-name registry. It lands as one reviewable unit because a half-migrated
handshake serves neither protocol.

**Files:**
- Modify: `apps/browser-demos/public/service-worker.js`
- Modify: `apps/browser-demos/lib/init/service-worker-bridge.ts`
- Modify: `apps/browser-demos/lib/init/sw-bridge-fetch.ts`
- Modify: `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts`
- Test: `apps/browser-demos/lib/init/service-worker-bridge.test.ts`
- Test: `apps/browser-demos/test/service-worker-scope-state.spec.ts`

**Interfaces:**
- Produces (SW-internal):
  - `instances: Map<string, InstanceRecord>` and
    `clientToInstance: Map<string, string>` (clientId → name).
  - `InstanceRecord = { name, appPrefix, owningClientId, bridgePort,
    sessionId, cookieJar, liveBridgeEpoch, durableAuthority,
    viewerClientIds: Set<string>, status: "live"|"reconnecting"|"offline" }`.
  - `generateInstanceName(): string` — one candidate, no uniqueness check.
  - `mintInstanceName(): string` — loops `generateInstanceName` up to 50
    times until `!instances.has(candidate)`; throws if exhausted.
  - `isValidInstanceName(name): boolean` — the Global-Constraints regex.
  - `appPrefixForName(name): string` → `SCOPE_PATH + "app/" + name + "/"`.
  - `instanceNameFromPath(pathname): string | null` — returns the name if
    `pathname` is `SCOPE_PATH + "app/" + <valid-name>` or starts with
    `SCOPE_PATH + "app/" + <valid-name> + "/"`, else null.
  - `resolveInstanceForEvent(event, url): InstanceRecord | null` — name
    from path, else `clientToInstance.get(event.clientId)`.
- Produces (page-side):
  - `initServiceWorkerBridge(swUrl, scopePath, sessionId): Promise<{
    bridge: HttpBridgeHost; name: string; appPrefix: string } | null>`
    (drops the `appPrefix` parameter).
  - `setupServiceWorkerFetchBridge(swUrl, scopePath, kernel, port,
    sessionId, options): Promise<{ bridge: HttpBridgeHost; name: string;
    appPrefix: string }>` (drops the `appPrefix` parameter).
- Message protocol:
  - `init-bridge` (page→SW): `{ type, sessionId }`, transfer
    `[bridgePort, replyPort]`. No `appPrefix`.
  - `bridge-ready` (SW→page): `{ type, name, appPrefix }`.
  - `need-bridge` (SW→client): `{ type }`, transfer `[replyPort]`.
  - `bridge-restored` (client→SW): `{ type, name, appPrefix, sessionId }`,
    transfer `[bridgePort]`.

### Sub-part A — Name generator and validator (SW)

- [ ] **Step 1: Write the failing Playwright test for minting + format.**

Add to `apps/browser-demos/test/service-worker-scope-state.spec.ts`. First
change the `installBridge` helper so it no longer sends `appPrefix` and
returns the minted values (this helper edit is used by later steps too):

```ts
// Replace the signature and init-bridge post in installBridge:
async function installBridge(
  page: Page,
  sessionId: string,
  label: string,
): Promise<{ reply: any; name: string; appPrefix: string; body: string }> {
  return page.evaluate(async ({ session, responseLabel }) => {
    const controller = navigator.serviceWorker.controller;
    if (!controller) throw new Error("service worker does not control fixture");
    const keepAlive = window as any;
    keepAlive.__bridgePorts ??= [];
    keepAlive.__bridgeCookies ??= {};
    keepAlive.__bridgeCookieValues ??= {};
    keepAlive.__bridgeCookies[responseLabel] ??= [];
    const bridge = new MessageChannel();
    bridge.port1.onmessage = (event) => {
      if (event.data?.type !== "http-request") return;
      keepAlive.__bridgeCookies[responseLabel].push(event.data.headers?.cookie ?? "");
      bridge.port1.postMessage({
        type: "http-response",
        requestId: event.data.requestId,
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Set-Cookie": `${responseLabel}=${keepAlive.__bridgeCookieValues[responseLabel] ?? "1"}; Path=/`,
        },
        body: new TextEncoder().encode(`bridge:${responseLabel}`),
      });
    };
    bridge.port1.start();
    const reply = new MessageChannel();
    const replyData = await new Promise<any>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error("timed out waiting for bridge reply")), 2_000);
      reply.port1.onmessage = (event) => { window.clearTimeout(timeout); resolve(event.data); };
      reply.port1.start();
      keepAlive.__bridgePorts.push(bridge.port1, reply.port1);
      controller.postMessage({ type: "init-bridge", sessionId: session }, [bridge.port2, reply.port2]);
    });
    const appPrefix: string = replyData.appPrefix;
    const response = await fetch(`${appPrefix}cookie`, { cache: "no-store" });
    return { reply: replyData, name: replyData.name, appPrefix, body: await response.text() };
  }, { session: sessionId, responseLabel: label });
}
```

Then the new test:

```ts
test("mints a validly-formatted machine name and app prefix", async ({ page }) => {
  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await registerScope(page, "/a/");
  const first = await installBridge(page, SESSION_A, "first");
  expect(first.name).toMatch(/^[a-z]{2,12}-[a-z]{2,12}-[a-z]{2,12}$/);
  expect(first.appPrefix).toBe(`/a/app/${first.name}/`);
  expect(first.body).toBe("bridge:first");
});
```

- [ ] **Step 2: Run it and confirm it fails.**

Run: `cd apps/browser-demos && npx playwright test service-worker-scope-state -g "mints a validly-formatted"`
Expected: FAIL — the SW ignores `sessionId`-only init-bridge / the reply
has no `name`/`appPrefix` (old SW still expects `appPrefix` in).

- [ ] **Step 3: Add the embedded generator/validator to the SW.**

In `apps/browser-demos/public/service-worker.js`, inside the Mode-2 block
(after `SESSION_ID_PATTERN`, ~line 193), add:

```js
  var INSTANCE_ADJECTIVES = [
    "happy","brave","calm","clever","eager","fuzzy","gentle","jolly",
    "keen","lively","merry","nimble","proud","quick","sunny","witty",
    /* …extend to at least 128 short a-z words… */
  ];
  var INSTANCE_COLORS = [
    "amber","azure","coral","crimson","emerald","golden","indigo","ivory",
    "jade","lilac","maroon","olive","purple","scarlet","teal","violet",
    /* …extend to at least 128… */
  ];
  var INSTANCE_NOUNS = [
    "otter","falcon","maple","comet","harbor","meadow","quartz","willow",
    "badger","cedar","dolphin","ember","ferret","glacier","heron","lynx",
    /* …extend to at least 128… */
  ];
  var INSTANCE_NAME_PATTERN = /^[a-z]{2,12}-[a-z]{2,12}-[a-z]{2,12}$/;

  function pickWord(list) {
    // crypto is available in a service worker global scope.
    var idx = crypto.getRandomValues(new Uint32Array(1))[0] % list.length;
    return list[idx];
  }

  function generateInstanceName() {
    return pickWord(INSTANCE_ADJECTIVES) + "-" +
      pickWord(INSTANCE_COLORS) + "-" + pickWord(INSTANCE_NOUNS);
  }

  function mintInstanceName() {
    for (var attempt = 0; attempt < 50; attempt++) {
      var candidate = generateInstanceName();
      if (!instances.has(candidate)) return candidate;
    }
    throw new Error("service worker could not mint a unique instance name");
  }

  function isValidInstanceName(name) {
    return typeof name === "string" && INSTANCE_NAME_PATTERN.test(name);
  }

  function appPrefixForName(name) {
    return SCOPE_PATH + "app/" + name + "/";
  }
```

Requirement (not a placeholder — real work for the executor): each of the
three arrays must contain **at least 128** distinct lowercase `[a-z]`
words within the 2–12 length bound, giving ≥128³ ≈ 2M combinations. Keep
them alphabetized and deduplicated.

- [ ] **Step 4: Introduce the registry globals (still single-instance-compatible for now).**

Replace the single-instance bridge globals
(`service-worker.js:231-238`, `248-264`, `312`) with the registry. Add
near the top of the bridge-state section:

```js
  var instances = new Map();          // name -> InstanceRecord
  var clientToInstance = new Map();   // clientId -> name
  var pendingRequests = new Map();    // requestId -> {resolve,reject} (stays global)
  var nextRequestId = 0;

  function makeInstanceRecord(name, sessionId, owningClientId) {
    return {
      name: name,
      appPrefix: appPrefixForName(name),
      owningClientId: owningClientId || null,
      bridgePort: null,
      sessionId: sessionId,
      cookieJar: new Map(),
      liveBridgeEpoch: 0,
      durableAuthority: null,
      viewerClientIds: new Set(),
      status: "live",
    };
  }
```

Delete the lone globals `bridgePort`, `appPrefix`, `currentSessionId`,
`cookieJar`, `liveBridgeEpoch`, `durableAuthority`, `bridgeConfigured`,
`appClientIds`, and the single-instance `cookieJarReady`. (Durable-authority
restore, Task 2, will repopulate `instances` on restart; for Task 1 the
`appPrefixReady`/durable read path is temporarily reduced to a no-op that
resolves immediately — Task 2 restores it per-instance. Leave a
`// TASK 2: per-instance durable restore` marker where the old
`appPrefixReady` block was.)

### Sub-part B — Minting on init-bridge (SW) and page handshake

- [ ] **Step 5: Rewrite the `init-bridge` message handler to mint.**

Replace the body of the `message` listener's `init-bridge` branch
(`service-worker.js:969-999`):

```js
    if (msg && msg.type === "init-bridge") {
      var port = event.ports[0];
      var replyPort = event.ports[1];
      if (
        !isValidSessionId(msg.sessionId) ||
        !isBridgeMessagePort(port) || !isBridgeMessagePort(replyPort)
      ) {
        postInvalidScopeConfig(replyPort);
        return;
      }
      var name = mintInstanceName();
      var record = makeInstanceRecord(name, msg.sessionId, event.source && event.source.id);
      instances.set(name, record);
      if (record.owningClientId) clientToInstance.set(record.owningClientId, name);
      initBridgePortFor(record, port);
      record.status = "live";
      record.liveBridgeEpoch += 1;
      replyPort.postMessage({ type: "bridge-ready", name: name, appPrefix: record.appPrefix });
    }
```

Add the per-instance port initializer (adapt `initBridgePort`,
`service-worker.js:671-693`) so `http-response`/`http-error` resolve
`pendingRequests` (unchanged) and set `record.bridgePort = port`:

```js
  function initBridgePortFor(record, port) {
    port.onmessage = function (event) {
      var m = event.data;
      if (m && m.type === "http-response") {
        var p = pendingRequests.get(m.requestId);
        if (p) { pendingRequests.delete(m.requestId); p.resolve({ status: m.status, headers: m.headers, body: m.body }); }
      } else if (m && m.type === "http-error") {
        var p2 = pendingRequests.get(m.requestId);
        if (p2) { pendingRequests.delete(m.requestId); p2.reject(new Error(m.error || "Bridge request failed")); }
      }
    };
    record.bridgePort = port;
  }
```

(Task 2 wraps this in the durable-authority commit; for Task 1, minting is
in-memory only.)

- [ ] **Step 6: Update the page-side handshake to consume the minted name.**

In `apps/browser-demos/lib/init/service-worker-bridge.ts`, change
`initServiceWorkerBridge` to drop the `appPrefix` parameter and return the
minted values. Replace the post and the reply handling:

```ts
export async function initServiceWorkerBridge(
  swUrl: string,
  scopePath: string,
  sessionId: string,
): Promise<{ bridge: HttpBridgeHost; name: string; appPrefix: string } | null> {
  if (!("serviceWorker" in navigator)) return null;
  const bridge = new HttpBridgeHost();
  const controller = await ensureServiceWorkerReady(swUrl, scopePath);
  const minted = await new Promise<{ name: string; appPrefix: string }>((resolve, reject) => {
    const reply = new MessageChannel();
    let settled = false;
    const finish = (complete: () => void) => {
      if (settled) return; settled = true;
      reply.port1.onmessage = null; reply.port1.close(); complete();
    };
    reply.port1.onmessage = (event) => {
      const message = event.data;
      if (message?.type === "bridge-ready" &&
          typeof message.name === "string" && typeof message.appPrefix === "string") {
        finish(() => resolve({ name: message.name, appPrefix: message.appPrefix }));
      } else if (message?.type === "bridge-error") {
        const code = typeof message.code === "string" ? message.code : "unknown";
        finish(() => reject(new Error(`Service worker bridge initialization failed: ${code}`)));
      } else {
        finish(() => reject(new Error("Unexpected bridge initialization reply")));
      }
    };
    try {
      controller.postMessage({ type: "init-bridge", sessionId }, [bridge.getSwPort(), reply.port2]);
    } catch (error) { finish(() => reject(error)); }
  });
  return { bridge, name: minted.name, appPrefix: minted.appPrefix };
}
```

- [ ] **Step 7: Update `setupServiceWorkerFetchBridge` and the `need-bridge` responder.**

In `apps/browser-demos/lib/init/sw-bridge-fetch.ts`: drop the `appPrefix`
parameter, thread the minted values, and include `name` in
`bridge-restored`:

```ts
export async function setupServiceWorkerFetchBridge(
  swUrl: string, scopePath: string, kernel: BrowserKernel, port: number,
  sessionId: string, options?: ServiceWorkerFetchBridgeOptions,
): Promise<{ bridge: HttpBridgeHost; name: string; appPrefix: string }> {
  const created = await initServiceWorkerBridge(swUrl, scopePath, sessionId);
  if (!created) throw new Error("Service workers unavailable — HTTP bridge not initialized");
  const { bridge, name, appPrefix } = created;
  attachBridgeToKernel(bridge, kernel, port, options);
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", (event) => {
      if (event.data?.type !== "need-bridge") return;
      const replyPort = event.ports[0];
      if (!replyPort) return;
      const fresh = new HttpBridgeHost();
      attachBridgeToKernel(fresh, kernel, port, options);
      replyPort.postMessage({ type: "bridge-restored", name, appPrefix, sessionId }, [fresh.getSwPort()]);
      options?.debugLog?.("Bridge restored after service worker restart");
    });
  }
  return { bridge, name, appPrefix };
}
```

- [ ] **Step 8: Update `live-setup.ts` to use the minted prefix.**

In `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts`, set the
web-preview URL from the returned `appPrefix` instead of the static
`APP_PREFIX`. Replace the `setWebPreview({ url: APP_PREFIX, … })` /
`setupServiceWorkerFetchBridge(...)` block (~`1511`–`1537`):

```ts
        const sessionId = crypto.randomUUID();
        const { appPrefix } = await setupServiceWorkerFetchBridge(
          SW_URL, SW_SCOPE, kernel, HTTP_PORT, sessionId,
          { timeoutMs: 90_000, debugLog: (line) => tick(line),
            onPendingRequests: (count) => { if (isCurrent()) host.setWebPreviewPendingRequests(count); } },
        );
        assertCurrent();
        host.setWebPreview({
          label: profile.init.web.label, url: appPrefix,
          status: "starting", message: "Waiting for services",
        });
        bridgeSent = true;
```

Remove the now-unused `APP_PREFIX`/`APP_PATH` constants if nothing else
references them (grep first; `APP_PATH` may be used elsewhere — leave it if
so).

- [ ] **Step 9: Update the page-side node:test to the new handshake shape.**

In `apps/browser-demos/lib/init/service-worker-bridge.test.ts`, the
existing "accepts only an explicit bridge-ready reply" test posts
`appPrefix` and expects a bare `bridge-ready`. Rewrite it:

```ts
test("returns the SW-minted name and app prefix", async () => {
  const fixture = readyFixture();
  fixture.controller!.postMessageHandler = (message, transfer) => {
    assert.deepEqual(message, { type: "init-bridge", sessionId: "01234567-89ab-4cde-8fab-0123456789ab" });
    (transfer[1] as MessagePort).postMessage({ type: "bridge-ready", name: "happy-teal-otter", appPrefix: "/a/app/happy-teal-otter/" });
    (transfer[0] as MessagePort).close();
  };
  await withBrowserGlobals(fixture.pageUrl, fixture.container, async (clock) => {
    const created = await initServiceWorkerBridge("/a/service-worker.js", "/a/", "01234567-89ab-4cde-8fab-0123456789ab");
    assert.ok(created);
    assert.equal(created!.name, "happy-teal-otter");
    assert.equal(created!.appPrefix, "/a/app/happy-teal-otter/");
    assert.equal(clock.count(), 0);
  });
});
```

Update the other three handshake tests (`rejects a typed bridge
initialization failure`, `rejects an unexpected bridge initialization
reply`, `does not abandon an in-flight bridge transition`, `cleans up when
posting bridge initialization throws`) to call
`initServiceWorkerBridge(swUrl, scope, sessionId)` (three args) and, for
the in-flight test, to reply with `{ type: "bridge-ready", name:
"happy-teal-otter", appPrefix: "/a/app/happy-teal-otter/" }`.

- [ ] **Step 10: Run the page-side unit tests.**

Run: `cd apps/browser-demos && node --import tsx --test lib/init/service-worker-bridge.test.ts`
Expected: PASS.

### Sub-part C — Name + clientId dispatch (SW)

- [ ] **Step 11: Write the failing two-instance isolation + attribution tests.**

Add to `service-worker-scope-state.spec.ts`:

```ts
test("two machines in one scope route to their own bridges", async ({ page }) => {
  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await registerScope(page, "/a/");
  const one = await installBridge(page, SESSION_A, "one");
  const two = await installBridge(page, SESSION_B, "two");
  expect(one.name).not.toBe(two.name);
  expect(await fetchText(page, `${one.appPrefix}page`)).toBe("bridge:one");
  expect(await fetchText(page, `${two.appPrefix}page`)).toBe("bridge:two");
});

test("root-relative subresources are attributed to the viewing machine", async ({ page }) => {
  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await registerScope(page, "/a/");
  const m = await installBridge(page, SESSION_A, "solo");
  // Load the app document so the SW records clientId -> name for this page.
  await page.goto(`${FIXTURE_ORIGIN}${m.appPrefix}`);
  // A bare root-relative fetch from inside the app must reach the machine.
  const body = await page.evaluate(async () => (await fetch("/wp-content/x.css", { cache: "no-store" })).text());
  expect(body).toBe("bridge:solo");
});
```

- [ ] **Step 12: Run and confirm failure.**

Run: `cd apps/browser-demos && npx playwright test service-worker-scope-state -g "two machines|root-relative subresources"`
Expected: FAIL — routing still uses the deleted single `bridgePort`.

- [ ] **Step 13: Implement name/clientId path helpers and rewrite dispatch.**

Add the path helpers (replace `appRootPath`/`appBasePath`/`isAppPath`/
`stripAppPath`, `service-worker.js:1259-1276`, with instance-aware
versions):

```js
  function instanceNameFromPath(pathname) {
    var base = SCOPE_PATH + "app/";
    if (pathname.indexOf(base) !== 0) return null;
    var rest = pathname.slice(base.length);        // "<name>" or "<name>/..."
    var seg = rest.split("/")[0];
    return isValidInstanceName(seg) ? seg : null;
  }
  function appRootPathFor(record) { return record.appPrefix.slice(0, -1); }   // "/a/app/<name>"
  function stripAppPathFor(record, pathname) {
    var root = appRootPathFor(record);
    if (pathname === root) return "/";
    return pathname.slice(root.length);
  }
  function markViewer(record, event, request) {
    if (event.clientId) { clientToInstance.set(event.clientId, record.name); record.viewerClientIds.add(event.clientId); }
    if (event.resultingClientId) { clientToInstance.set(event.resultingClientId, record.name); record.viewerClientIds.add(event.resultingClientId); }
  }
  function resolveInstanceForEvent(event, url) {
    var name = instanceNameFromPath(url.pathname);
    if (name) return instances.get(name) || null;      // named but unknown -> null (handled as 503/404)
    var viewed = event.clientId ? clientToInstance.get(event.clientId) : null;
    return viewed ? (instances.get(viewed) || null) : null;
  }
```

Rewrite the `fetch` handler's app fast-path
(`service-worker.js:1569-1616`). Replace the single-port branch and the
restore branch with:

```js
    var namedInPath = instanceNameFromPath(url.pathname);
    if (namedInPath || (event.clientId && clientToInstance.has(event.clientId))) {
      var record = resolveInstanceForEvent(event, url);
      if (namedInPath && !record) {
        event.respondWith(offlineOrUnknownResponse(namedInPath));   // TASK 3 gives the 503 HTML page; for Task 1 return a 404 text Response
        return;
      }
      if (record) {
        markViewer(record, event, event.request);
        if (namedInPath) {
          if (record.bridgePort) { event.respondWith(handleAppRequest(record, event.request, url)); return; }
          event.respondWith(fetchRestoredAppRequest(record, event, event.request, url)); // TASK 2
          return;
        }
        // Nameless subresource from a known viewer: redirect into its app prefix.
        event.respondWith(redirectIntoApp(record, url));
        return;
      }
    }
```

For Task 1, define a minimal `offlineOrUnknownResponse(name)` returning a
404 `text/plain` Response with COEP/CORP headers (Task 3 upgrades it to
the shared 503 HTML page). Keep the cross-origin, canonical-VFS, and
lazy-VFS branches unchanged.

- [ ] **Step 14: Thread `instance` through the request path.**

Change these functions to take an `InstanceRecord` and read its fields
instead of the deleted globals:
- `bridgeFetch(record, request)` → posts to `record.bridgePort`
  (`service-worker.js:725-741`).
- `handleAppRequest(record, request, url)` → uses `record.appPrefix`,
  `record.sessionId`, `record.liveBridgeEpoch`, `record.cookieJar`,
  `appRootPathFor(record)`, `stripAppPathFor(record, …)`, and calls
  `bridgeFetch(record, …)` (`service-worker.js:1622-1800`).
- `getCookiesForPath(record, path)`, `storeCookies(record.cookieJar,
  record.appPrefix, …)`, and the cookie mutation scheduler
  (`service-worker.js:395-431`, `361-393`, `629-658`) → operate on
  `record.cookieJar` and per-record epoch/session guards.
- `redirectIntoApp(record, url)` → builds the Location from
  `appRootPathFor(record)` (`service-worker.js:1348-1355`).
- `rewriteSameHostAppUrls(record, text, requestUrl)` and
  `rewriteAppUrlHeader(record, …)` → use `appRootPathFor(record)`
  (`service-worker.js:1820-1862`).

Replace the global `resetSessionState()` (`service-worker.js:663-668`,
called at `1544-1550`) with per-owner teardown:

```js
  function teardownInstancesOwnedBy(clientId) {
    if (!clientId) return;
    instances.forEach(function (record, name) {
      if (record.owningClientId === clientId) instances.delete(name);
    });
    clientToInstance.forEach(function (name, cid) {
      if (!instances.has(name)) clientToInstance.delete(cid);
    });
  }
```

In the fetch handler's navigation branch (`service-worker.js:1544-1550`),
when a top-level navigation targets a non-app page in the owning client,
call `teardownInstancesOwnedBy(event.clientId)` instead of the global
reset. (Full offline notification is Task 3; teardown here just prevents a
navigated-away host from lingering.)

- [ ] **Step 15: Run the Task-1 Playwright tests.**

Run: `cd apps/browser-demos && npx playwright test service-worker-scope-state -g "mints a validly|two machines|root-relative subresources"`
Expected: PASS.

- [ ] **Step 16: Write and run the per-instance cookie-isolation test.**

```ts
test("cookie jars are isolated per machine", async ({ page }) => {
  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await registerScope(page, "/a/");
  const one = await installBridge(page, SESSION_A, "one");
  const two = await installBridge(page, SESSION_B, "two");
  await setBridgeCookieValue(page, "one", "ONEVAL");
  await setBridgeCookieValue(page, "two", "TWOVAL");
  await fetchText(page, `${one.appPrefix}set`);   // machine one sets its cookie
  await fetchText(page, `${two.appPrefix}set`);   // machine two sets its cookie
  const oneCookies = await page.evaluate(() => (window as any).__bridgeCookies.one.at(-1));
  const twoCookies = await page.evaluate(() => (window as any).__bridgeCookies.two.at(-1));
  // Each machine only ever sees its own cookie replayed.
  expect(oneCookies).not.toContain("two=");
  expect(twoCookies).not.toContain("one=");
});
```

Run: `cd apps/browser-demos && npx playwright test service-worker-scope-state -g "cookie jars are isolated"`
Expected: PASS.

- [ ] **Step 17: Run the whole SW Playwright suite and fix fallout.**

Run: `cd apps/browser-demos && npx playwright test service-worker-scope-state`
Expected: PASS. Existing `transitionAttempt`/`initAttempt`-based tests
(`service-worker.js` protocol) will need their `init-bridge` posts updated
to drop `appPrefix` and read the minted prefix from the reply. Update each
failing test to the new protocol; do not reintroduce a page-chosen
appPrefix.

- [ ] **Step 18: Commit.**

```bash
git add apps/browser-demos/public/service-worker.js \
  apps/browser-demos/lib/init/service-worker-bridge.ts \
  apps/browser-demos/lib/init/sw-bridge-fetch.ts \
  apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts \
  apps/browser-demos/lib/init/service-worker-bridge.test.ts \
  apps/browser-demos/test/service-worker-scope-state.spec.ts
git commit -m "Browser: Route the SW bridge per machine via SW-minted names"
```

---

## Task 2: Per-instance durable authority and SW-restart recovery

**Files:**
- Modify: `apps/browser-demos/public/service-worker.js`
- Test: `apps/browser-demos/test/service-worker-scope-state.spec.ts`

**Interfaces:**
- Consumes: `InstanceRecord`, `instances`, `mintInstanceName`,
  `appPrefixForName`, `initBridgePortFor` (Task 1).
- Produces:
  - Per-name durable authority persisted in Cache Storage under
    `BRIDGE_AUTHORITY_KEY + ":" + name` (was one global
    `BRIDGE_AUTHORITY_KEY`).
  - `fetchRestoredAppRequest(record, event, request, url)` — awaits
    `ensureBridge(record)` then `handleAppRequest`, else the 503 fallback.
  - `ensureBridge(record)` — resolves true if `record.bridgePort` exists,
    else runs `requestBridgeFromClient(record)` (broadcasts `need-bridge`,
    accepts a `bridge-restored` whose `name` matches and whose
    `appPrefix`/`sessionId` match the record's durable authority).

- [ ] **Step 1: Write the failing restart-recovery test.**

Simulating a real SW kill in Playwright is unreliable; instead assert the
recovery *handshake* directly. Add a helper that installs a `need-bridge`
responder for a specific name and drops the current bridge port, then
triggers a fetch that must restore:

```ts
test("a restarted SW restores each machine by name", async ({ page }) => {
  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await registerScope(page, "/a/");
  const m = await installBridge(page, SESSION_A, "solo");
  // Install a page-side need-bridge responder that re-answers for this name.
  await page.evaluate(({ name, appPrefix, session }) => {
    navigator.serviceWorker.addEventListener("message", (event: any) => {
      if (event.data?.type !== "need-bridge") return;
      const fresh = new MessageChannel();
      fresh.port1.onmessage = (e: any) => {
        if (e.data?.type !== "http-request") return;
        fresh.port1.postMessage({ type: "http-response", requestId: e.data.requestId, status: 200,
          headers: { "Content-Type": "text/plain" }, body: new TextEncoder().encode("restored:solo") });
      };
      fresh.port1.start();
      (window as any).__bridgePorts.push(fresh.port1);
      event.ports[0].postMessage({ type: "bridge-restored", name, appPrefix, sessionId: session }, [fresh.port2]);
    });
  }, { name: m.name, appPrefix: m.appPrefix, session: SESSION_A });
  // Force the SW to consider the bridge lost for this instance (test hook).
  await page.evaluate(() => navigator.serviceWorker.controller!.postMessage({ type: "__test-drop-bridges" }));
  expect(await fetchText(page, `${m.appPrefix}after-restart`)).toBe("restored:solo");
});
```

Add a `__test-drop-bridges` message handler in the SW **guarded by a
build/test-only check** — or, preferably, avoid a test backdoor by having
the test close the original bridge port from the page side and rely on the
SW's port-dead detection (Task 3). If a test hook is used, gate it behind
`self.location.hostname === "127.0.0.1"` and document it. Decide during
execution; the assertion (restore-by-name) is the contract.

- [ ] **Step 2: Run and confirm failure.**

Run: `cd apps/browser-demos && npx playwright test service-worker-scope-state -g "restores each machine by name"`
Expected: FAIL.

- [ ] **Step 3: Make durable authority per-name.**

Generalize `writeBridgeAuthority`/`bridgeAuthorityResponse`/
`nextBridgeAuthority`/`prepareBridgeTransition`/`scheduleBridgeTransition`/
`scheduleBridgeRestoration` (`service-worker.js:520-942`) to take a
`record` (or a `name`) and read/write the Cache Storage key
`BRIDGE_AUTHORITY_KEY + ":" + name`. Persist `{ version, revision,
appPrefix, sessionId, cookies }` per instance. On `init-bridge` (Task 1
Step 5), wrap `initBridgePortFor` in the durable write so a fresh login
survives a restart.

- [ ] **Step 4: Restore instances from Cache Storage on SW startup.**

Replace the Task-1 `// TASK 2: per-instance durable restore` marker with a
startup scan that reads every `BRIDGE_AUTHORITY_KEY + ":" + name` entry,
validates it (reuse `bridgeAuthorityFromJson`), and pre-creates an
`InstanceRecord` with `bridgePort = null`, `status = "reconnecting"`,
`durableAuthority` set. Actual ports are re-supplied by `need-bridge`.

- [ ] **Step 5: Generalize `need-bridge` recovery to match by name.**

Adapt `requestBridgeFromClient`/`ensureBridge`/`scheduleBridgeRestoration`
(`service-worker.js:747-942`) so `ensureBridge(record)` broadcasts
`need-bridge` and accepts a `bridge-restored` only when `data.name ===
record.name` and `data.appPrefix`/`data.sessionId` match
`record.durableAuthority`. On success, `initBridgePortFor(record, port)`
and `record.status = "live"`. Add `fetchRestoredAppRequest(record, …)`
(adapt `service-worker.js:1517-1533`).

- [ ] **Step 6: Run the recovery test and the full suite.**

Run: `cd apps/browser-demos && npx playwright test service-worker-scope-state`
Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add apps/browser-demos/public/service-worker.js apps/browser-demos/test/service-worker-scope-state.spec.ts
git commit -m "Browser: Persist and restore SW bridge authority per machine"
```

---

## Task 3: Offline lifecycle — detection, push, and 503 page

**Files:**
- Modify: `apps/browser-demos/public/service-worker.js`
- Modify: `apps/browser-demos/lib/init/sw-bridge-fetch.ts`
- Test: `apps/browser-demos/test/service-worker-scope-state.spec.ts`

**Interfaces:**
- Consumes: `instances`, `clientToInstance`, `InstanceRecord`,
  `teardownInstancesOwnedBy` (Tasks 1–2).
- Produces:
  - `offlineOrUnknownResponse(name)` — a 503 **HTML** page (replaces the
    Task-1 404 stub) with COEP/CORP headers.
  - `markInstanceOffline(record, reason)` — sets `status`, notifies
    viewers, GCs terminal instances' durable authority.
  - `notifyViewers(record, type)` — posts `{ type, name }` to each
    `viewerClientId` via `clients.get(id)`.
  - `reconcileOwners()` — cross-checks `owningClientId` against
    `clients.matchAll({type:"window"})`; classifies terminal vs transient.
  - Message: `instance-closing` (host→SW) `{ name }`; `machine-offline`
    and `machine-reconnecting` (SW→viewer) `{ name }`.

- [ ] **Step 1: Write the failing 503-page + push tests.**

```ts
test("an unknown machine name returns a 503 HTML page", async ({ page }) => {
  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await registerScope(page, "/a/");
  const res = await fetchResponse(page, "/a/app/happy-teal-otter/");
  expect(res.status).toBe(503);
  expect(res.body).toContain("<");            // an HTML document, not plain text
});

test("closing the host tab pushes machine-offline to viewers", async ({ context }) => {
  const host = await context.newPage();
  await host.goto(`${FIXTURE_ORIGIN}/a/`);
  await registerScope(host, "/a/");
  const m = await installBridge(host, SESSION_A, "solo");
  const viewer = await context.newPage();
  await viewer.goto(`${FIXTURE_ORIGIN}${m.appPrefix}`);
  const offline = viewer.evaluate((name) => new Promise<string>((resolve) => {
    navigator.serviceWorker.addEventListener("message", (e: any) => {
      if (e.data?.type === "machine-offline" && e.data.name === name) resolve("offline");
    });
  }), m.name);
  await host.evaluate(() => navigator.serviceWorker.controller!.postMessage({
    type: "instance-closing", name: (window as any).__lastInstanceName }));
  // Record the name for the host to send (set it in installBridge, see Step 3).
  expect(await offline).toBe("offline");
});
```

- [ ] **Step 2: Run and confirm failure.**

Run: `cd apps/browser-demos && npx playwright test service-worker-scope-state -g "503 HTML page|pushes machine-offline"`
Expected: FAIL.

- [ ] **Step 3: Emit `instance-closing` from the host page.**

In `sw-bridge-fetch.ts`, after a successful setup, register a `pagehide`
listener that posts `{ type: "instance-closing", name }` to the
controller. Also expose the minted `name` on `window.__lastInstanceName`
inside the Playwright `installBridge` helper (test-only) so the test in
Step 1 can send it.

```ts
  if ("serviceWorker" in navigator) {
    window.addEventListener("pagehide", () => {
      navigator.serviceWorker.controller?.postMessage({ type: "instance-closing", name });
    });
  }
```

- [ ] **Step 4: Implement the offline lifecycle in the SW.**

Add the message branch for `instance-closing` (mark the named record
offline). Implement `markInstanceOffline`, `notifyViewers`,
`reconcileOwners`, and the terminal-vs-transient rule:

```js
  function notifyViewers(record, type) {
    record.viewerClientIds.forEach(function (id) {
      self.clients.get(id).then(function (client) { if (client) client.postMessage({ type: type, name: record.name }); });
    });
  }
  function markInstanceOffline(record) {
    record.status = "offline";
    record.bridgePort = null;
    notifyViewers(record, "machine-offline");
    instances.delete(record.name);
    caches.open(BRIDGE_CACHE).then(function (c) { c.delete(BRIDGE_AUTHORITY_KEY + ":" + record.name); });
  }
  function reconcileOwners() {
    return self.clients.matchAll({ type: "window" }).then(function (wins) {
      var live = new Set(wins.map(function (w) { return w.id; }));
      instances.forEach(function (record) {
        if (record.owningClientId && !live.has(record.owningClientId)) markInstanceOffline(record);
      });
    });
  }
```

Wire `reconcileOwners()` into the fetch handler before app dispatch (lazy
check) so a crashed host is detected on the next request. In
`ensureBridge(record)` (Task 2), when the owner is still in `matchAll` but
no port arrives, keep `status = "reconnecting"` and
`notifyViewers(record, "machine-reconnecting")`; when the owner is gone,
`markInstanceOffline`.

- [ ] **Step 5: Replace the 503 stub with the shared HTML page.**

Implement `offlineOrUnknownResponse(name)` returning a 503 `text/html`
document (COEP/CORP headers set) with a short "This Kandelo machine is
offline" message and the machine name. Use it for unknown names (Task 1
Step 13) and for requests to an offline record.

- [ ] **Step 6: Run the offline tests and the full suite.**

Run: `cd apps/browser-demos && npx playwright test service-worker-scope-state`
Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add apps/browser-demos/public/service-worker.js apps/browser-demos/lib/init/sw-bridge-fetch.ts apps/browser-demos/test/service-worker-scope-state.spec.ts
git commit -m "Browser: Surface offline machines via SW push and a 503 page"
```

---

## Task 4: Demo chrome offline/reconnecting UI

**Files:**
- Modify: `apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts`
- Test: `apps/browser-demos/test/service-worker-scope-state.spec.ts`
  (or the demo e2e suite if one covers the web-preview pane — grep for
  existing `setWebPreview` assertions first).

**Interfaces:**
- Consumes: `machine-offline` / `machine-reconnecting` messages (Task 3);
  the minted `name` (Task 1); `host.setWebPreview(...)` /
  `host.setWebPreviewPendingRequests(...)` (existing).

- [ ] **Step 1: Write the failing chrome-state test.**

Assert that when the SW pushes `machine-offline` for this page's machine,
the web-preview pane reflects an offline status. Model on the existing
`setWebPreview` usage; if there is no headless hook, drive it through the
demo e2e page and assert the visible offline banner. Concrete assertion:

```ts
test("the demo chrome shows offline when its machine goes away", async ({ page }) => {
  // Boot a demo via the real page (reuse the browser-demos e2e harness),
  // capture the minted name, dispatch machine-offline, and assert the
  // web-preview pane renders the offline state (data-testid="web-preview-offline").
});
```

(Fill the harness specifics from the existing browser-demos e2e setup at
execution time; the contract is: push → visible offline state.)

- [ ] **Step 2: Run and confirm failure.**

Run: `cd apps/browser-demos && npx playwright test -g "demo chrome shows offline"`
Expected: FAIL.

- [ ] **Step 3: Listen for the push and update the pane.**

In `live-setup.ts`, after setup, add a `navigator.serviceWorker`
`message` listener that, for `machine-offline`/`machine-reconnecting`
whose `name` matches this page's minted `name`, calls `host.setWebPreview`
with `status: "offline"` / `status: "reconnecting"` and an explanatory
message. Guard with `isCurrent()`.

- [ ] **Step 4: Run the test and the suite.**

Run: `cd apps/browser-demos && npx playwright test -g "demo chrome shows offline"`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add apps/browser-demos/pages/kandelo/kernel-host/live-setup.ts apps/browser-demos/test/service-worker-scope-state.spec.ts
git commit -m "Browser: Render offline and reconnecting states in the demo chrome"
```

---

## Task 5: Full validation and manual browser verification

**Files:** none (validation only).

- [ ] **Step 1: Run the page-side unit suite.**

Run: `cd apps/browser-demos && node --import tsx --test lib/init/service-worker-bridge.test.ts`
Expected: PASS.

- [ ] **Step 2: Run the full SW Playwright suite (under dev-shell).**

Run: `scripts/dev-shell.sh bash -lc 'cd apps/browser-demos && npx playwright test service-worker-scope-state'`
Expected: PASS. Note the recorded WebKit/Firefox-macOS Playwright
constraints; run the projects that launch on this host.

- [ ] **Step 3: Confirm no host/parity regression.**

Run: `scripts/dev-shell.sh bash -lc 'cd apps/browser-demos && npm test'`
(or the repo's configured Vitest command). Expected: PASS. Grep confirms
`host/src` is untouched: `git diff --name-only origin/main... | grep '^host/' ` returns nothing.

- [ ] **Step 4: Manual browser verification.**

Provision if needed, then `./run.sh browser` (unique `--port N
--strictPort`). Verify by hand: (a) two demos in two tabs stay isolated;
(b) a `/base/app/<name>/` link opened in a second tab reaches the same
machine; (c) closing the host tab shows the viewer's demo chrome an
offline state proactively; (d) an SW restart (DevTools → Application →
Service Workers → Stop) shows "reconnecting…" then recovers; (e) loading
`/base/app/<name>/` raw against a closed machine shows the SW 503 page.
Record what was run and observed.

- [ ] **Step 5: Update docs.**

Update `docs/browser-support.md` (and any doc describing the SW bridge /
web-preview) to describe multi-instance naming, cross-tab viewing, and the
offline behavior. Commit.

```bash
git add docs/browser-support.md
git commit -m "Docs: Describe multi-instance SW routing and offline behavior"
```

---

## Self-Review

**Spec coverage:**
- Isolation (registry, per-name dispatch) → Task 1.
- Addressability / SW-minted names / `/base/app/<name>/` → Task 1.
- clientId-fallback attribution of root-relative requests → Task 1 (C).
- Per-instance cookie jar → Task 1 Step 16.
- Per-instance durable authority + restart recovery → Task 2.
- Cross-client viewing (relay to owning port) → Task 1 dispatch +
  Task 2 recovery (any client's named request resolves to the owning
  record's port; the two-tab viewer path is exercised in Task 3 Step 1's
  cross-page test).
- Offline detection (pagehide + matchAll), terminal vs reconnecting,
  push, 503 page → Task 3.
- Demo-chrome offline UI, SW-served 503 when no chrome → Task 3 (503) +
  Task 4 (chrome).
- Name validation of untrusted input → Task 1 (`isValidInstanceName`,
  unknown-name path) + Task 3 (503 page for unknown name).
- Wordlist embedded (spec-simplification noted) → Task 1 (A).
- Testing plan (node:test + Playwright + manual) → Tasks 1–5.

**Placeholder scan:** The two "decide at execution" points (Task 2 Step 1
test hook; Task 4 harness specifics) state the contract to assert and why
the mechanism is deferred to the live harness; they are not blank TODOs.
The wordlist arrays require ≥128 words each — flagged as explicit executor
work with the exact bound, not a vague "add words".

**Type consistency:** `InstanceRecord` field names are used consistently
(`bridgePort`, `cookieJar`, `liveBridgeEpoch`, `durableAuthority`,
`viewerClientIds`, `owningClientId`, `status`). `initServiceWorkerBridge`
and `setupServiceWorkerFetchBridge` both drop `appPrefix` and return
`{ bridge, name, appPrefix }` consistently across Tasks 1, 3, 4. Messages
(`init-bridge`/`bridge-ready`/`need-bridge`/`bridge-restored`/
`instance-closing`/`machine-offline`/`machine-reconnecting`) carry the
same fields everywhere they appear.
