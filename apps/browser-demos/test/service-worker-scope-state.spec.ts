import {
  expect,
  test,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";

const FIXTURE_PORT = 55_431;
const FIXTURE_ORIGIN = `http://127.0.0.1:${FIXTURE_PORT}`;
const SESSION_A = "11111111-1111-4111-8111-111111111111";
const SESSION_B = "22222222-2222-4222-8222-222222222222";
const SESSION_A_NEXT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BRIDGE_AUTHORITY_KEY = "bridge-authority-v1";
const BRIDGE_AUTHORITY_VERSION = 1;
const BRIDGE_AUTHORITY_MAX_BYTES = 64 * 1024;
const BRIDGE_AUTHORITY_MAX_COOKIES = 32;
const BRIDGE_COOKIE_NAME_MAX_BYTES = 256;
const BRIDGE_COOKIE_VALUE_MAX_BYTES = 4_096;
const BRIDGE_COOKIE_PATH_MAX_BYTES = 4_096;
const CACHE_A = "kandelo-sw:%2Fa%2F:bridge-v2";
const CACHE_B = "kandelo-sw:%2Fb%2F:bridge-v2";
const LAZY_CACHE_A = "kandelo-sw:%2Fa%2F:lazy-assets-v1";
const LAZY_CACHE_CANDIDATE_B = "kandelo-sw:%2Fcandidate-b%2F:lazy-assets-v1";
const VFS_LAZY_CACHE_VERSION_PLACEHOLDER =
  "__KANDELO_VFS_LAZY_CACHE_VERSION__";
const GROUP_A_SHA256 = "a".repeat(64);
const GROUP_B_SHA256 = "b".repeat(64);

const cleanupMatrix = [
  "unrelated-site-cache",
  CACHE_B,
  "kandelo-sw:%2Fa%2F:bridge-v1",
  CACHE_A,
  LAZY_CACHE_A,
  "sw-bridge-config",
] as const;

let fixtureServer: Server;
let workerSource = "";
let groupedWorkerCacheVersion: string | undefined;

type LazyAssetResponse =
  | { kind: "ok"; body: string }
  | { kind: "failed"; body: string }
  | { kind: "partial"; body: string }
  | { kind: "truncated"; body: string };

const lazyAssetResponses = new Map<string, LazyAssetResponse>();

function resetLazyAssetResponses(): void {
  lazyAssetResponses.clear();
  lazyAssetResponses.set("/a/vfs-groups/release-1/assets/shared.bin", {
    kind: "ok",
    body: "scope-a shared bytes",
  });
  lazyAssetResponses.set("/candidate-b/vfs-groups/release-1/assets/shared.bin", {
    kind: "ok",
    body: "candidate-b shared bytes",
  });
  lazyAssetResponses.set("/a/vfs-groups/release-1/assets/failed.bin", {
    kind: "failed",
    body: "lazy asset upstream failure",
  });
  lazyAssetResponses.set("/a/vfs-groups/release-1/assets/partial.bin", {
    kind: "partial",
    body: "partial lazy asset bytes",
  });
  lazyAssetResponses.set("/a/vfs-groups/release-1/assets/truncated.bin", {
    kind: "truncated",
    body: "short lazy asset",
  });
}

test.beforeAll(async () => {
  workerSource = await readFile(
    new URL("../public/service-worker.js", import.meta.url),
    "utf8",
  );
  fixtureServer = createServer((request, response) => {
    const url = new URL(request.url ?? "/", FIXTURE_ORIGIN);
    if (url.pathname.endsWith("/service-worker.js")) {
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": "application/javascript; charset=utf-8",
      });
      response.end(groupedWorkerSource());
      return;
    }

    const lazyAsset = lazyAssetResponses.get(url.pathname);
    if (lazyAsset) {
      if (lazyAsset.kind === "failed") {
        response.writeHead(503, {
          "Cache-Control": "no-store",
          "Content-Type": "application/octet-stream",
        });
        response.end(lazyAsset.body);
        return;
      }
      const bytes = Buffer.from(lazyAsset.body);
      response.writeHead(lazyAsset.kind === "partial" ? 206 : 200, {
        "Cache-Control": "no-store",
        "Content-Type": "application/octet-stream",
        "Content-Length": String(
          bytes.byteLength + (lazyAsset.kind === "truncated" ? 1 : 0),
        ),
        ...(lazyAsset.kind === "partial"
          ? { "Content-Range": `bytes 0-${bytes.byteLength - 1}/99` }
          : {}),
      });
      response.end(bytes);
      return;
    }

    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": request.headers.accept?.includes("text/html")
        ? "text/html; charset=utf-8"
        : "text/plain; charset=utf-8",
    });
    response.end(
      request.headers.accept?.includes("text/html")
        ? `<!doctype html><title>${url.pathname}</title>`
        : `network:${url.pathname}`,
    );
  });
  await new Promise<void>((resolve, reject) => {
    fixtureServer.once("error", reject);
    fixtureServer.listen(FIXTURE_PORT, "127.0.0.1", () => {
      fixtureServer.off("error", reject);
      resolve();
    });
  });
});

test.beforeEach(() => {
  resetLazyAssetResponses();
  groupedWorkerCacheVersion = undefined;
});

test.afterAll(async () => {
  if (!fixtureServer) return;
  await new Promise<void>((resolve, reject) => {
    fixtureServer.close((error) => error ? reject(error) : resolve());
  });
});

test("activation removes only obsolete caches in its exact scope namespace", async ({
  page,
}) => {
  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await seedCaches(page, cleanupMatrix);
  await registerScope(page, "/a/");

  expect((await cacheNames(page)).sort()).toEqual([
    "unrelated-site-cache",
    CACHE_B,
    CACHE_A,
    LAZY_CACHE_A,
    "sw-bridge-config",
  ].sort());
});

test("a scoped lazy VFS asset cache preserves full bytes and Content-Length during an origin failure", async ({
  page,
}) => {
  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await registerScope(page, "/a/");
  const assetPath = "/a/vfs-groups/release-1/assets/shared.bin";
  const expectedBody = "scope-a shared bytes";

  expect(await fetchResponse(page, assetPath)).toEqual({
    status: 200,
    body: expectedBody,
    contentLength: String(Buffer.byteLength(expectedBody)),
  });
  lazyAssetResponses.set(assetPath, {
    kind: "failed",
    body: "origin is unavailable after the first full response",
  });

  expect(await fetchResponse(page, assetPath)).toEqual({
    status: 200,
    body: expectedBody,
    contentLength: String(Buffer.byteLength(expectedBody)),
  });
  expect(await lazyCacheEntries(page, LAZY_CACHE_A)).toEqual([assetPath]);
});

test("a grouped deployment replaces an old unversioned lazy cache at the same public URL", async ({
  page,
}) => {
  const assetPath = "/a/vfs-groups/release-1/assets/shared.bin";
  const legacyBody = "same public URL from the old group";
  const replacementBody = "same public URL from the new group";
  lazyAssetResponses.set(assetPath, { kind: "ok", body: legacyBody });

  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await registerScope(page, "/a/");
  expect(await fetchResponse(page, assetPath)).toMatchObject({
    body: legacyBody,
    status: 200,
  });
  expect(await lazyCacheEntries(page, LAZY_CACHE_A)).toEqual([assetPath]);

  groupedWorkerCacheVersion = GROUP_B_SHA256;
  lazyAssetResponses.set(assetPath, { kind: "ok", body: replacementBody });
  await updateScope(page, "/a/");

  expect(await fetchResponse(page, assetPath)).toMatchObject({
    body: replacementBody,
    status: 200,
  });
  await expect.poll(() => cacheNames(page)).not.toContain(LAZY_CACHE_A);
  expect(await lazyCacheEntries(page, lazyCacheName("/a/", GROUP_B_SHA256)))
    .toEqual([assetPath]);
});

test("a grouped deployment replaces its prior manifest-version cache at the same public URL", async ({
  page,
}) => {
  const assetPath = "/a/vfs-groups/release-1/assets/shared.bin";
  const firstBody = "same public URL from group A";
  const nextBody = "same public URL from group B";
  groupedWorkerCacheVersion = GROUP_A_SHA256;
  lazyAssetResponses.set(assetPath, { kind: "ok", body: firstBody });

  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await registerScope(page, "/a/");
  expect(await fetchResponse(page, assetPath)).toMatchObject({
    body: firstBody,
    status: 200,
  });
  expect(await lazyCacheEntries(page, lazyCacheName("/a/", GROUP_A_SHA256)))
    .toEqual([assetPath]);

  groupedWorkerCacheVersion = GROUP_B_SHA256;
  lazyAssetResponses.set(assetPath, { kind: "ok", body: nextBody });
  await updateScope(page, "/a/");

  expect(await fetchResponse(page, assetPath)).toMatchObject({
    body: nextBody,
    status: 200,
  });
  await expect.poll(() => cacheNames(page)).not.toContain(
    lazyCacheName("/a/", GROUP_A_SHA256),
  );
  expect(await lazyCacheEntries(page, lazyCacheName("/a/", GROUP_B_SHA256)))
    .toEqual([assetPath]);
});

test("scoped lazy VFS caches keep identical filenames distinct across deployment prefixes", async ({
  context,
  page: pageA,
}) => {
  await pageA.goto(`${FIXTURE_ORIGIN}/a/`);
  await registerScope(pageA, "/a/");
  const assetSuffix = "/vfs-groups/release-1/assets/shared.bin";
  expect(await fetchResponse(pageA, `/a${assetSuffix}`)).toMatchObject({
    status: 200,
    body: "scope-a shared bytes",
  });

  const pageCandidateB = await context.newPage();
  await pageCandidateB.goto(`${FIXTURE_ORIGIN}/candidate-b/`);
  await registerScope(pageCandidateB, "/candidate-b/");
  expect(await fetchResponse(pageCandidateB, `/candidate-b${assetSuffix}`))
    .toMatchObject({
      status: 200,
      body: "candidate-b shared bytes",
    });

  expect(await lazyCacheEntries(pageA, LAZY_CACHE_A)).toEqual([
    `/a${assetSuffix}`,
  ]);
  expect(await lazyCacheEntries(pageCandidateB, LAZY_CACHE_CANDIDATE_B)).toEqual([
    `/candidate-b${assetSuffix}`,
  ]);
});

test("failed and truncated lazy VFS responses create no cache entry", async ({
  page,
}) => {
  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await registerScope(page, "/a/");

  expect(await fetchResponse(page, "/a/vfs-groups/release-1/assets/failed.bin"))
    .toMatchObject({ status: 503, body: "lazy asset upstream failure" });
  await expect(fetchBytes(page, "/a/vfs-groups/release-1/assets/truncated.bin"))
    .rejects.toThrow();

  expect(await lazyCacheEntries(page, LAZY_CACHE_A)).toEqual([]);
});

test("a 206 lazy VFS response returns raw bytes without creating a cache entry", async ({
  page,
}) => {
  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await registerScope(page, "/a/");

  expect(await fetchResponse(page, "/a/vfs-groups/release-1/assets/partial.bin"))
    .toEqual({
      status: 206,
      body: "partial lazy asset bytes",
      contentLength: String(Buffer.byteLength("partial lazy asset bytes")),
    });
  expect(await lazyCacheEntries(page, LAZY_CACHE_A)).toEqual([]);
});

test("production COI reload state is scoped while the theme remains origin-wide", async ({
  page,
}) => {
  const { createCoiReloadSessionState } = await import(
    "../pages/kandelo/kernel-host/coi-reload-session-state"
  );
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
  const stateA = createCoiReloadSessionState("/a/", storage);
  const stateB = createCoiReloadSessionState("/b/", storage);
  expect([stateA.wasAttempted(), stateB.wasAttempted()]).toEqual([
    false,
    false,
  ]);
  stateA.markAttempted();
  expect([stateA.wasAttempted(), stateB.wasAttempted()]).toEqual([true, false]);
  stateB.markAttempted();
  stateA.clear();
  expect([stateA.wasAttempted(), stateB.wasAttempted()]).toEqual([false, true]);

  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await page.evaluate(() => {
    localStorage.setItem("kandelo.theme", "dark");
  });
  await page.goto(`${FIXTURE_ORIGIN}/b/`);
  expect(await page.evaluate(() => localStorage.getItem("kandelo.theme")))
    .toBe("dark");
});

test("the exact worker accepts canonical scopes and rejects noncanonical scope paths", async ({
  page,
}) => {
  await page.goto(`${FIXTURE_ORIGIN}/validator/`);
  for (const [scriptPath, scopePath] of [
    ["/service-worker.js", "/"],
    ["/a/service-worker.js", "/a/"],
    ["/nested/kandelo-2/service-worker.js", "/nested/kandelo-2/"],
    ["/safe%20space/service-worker.js", "/safe%20space/"],
  ]) {
    expect.soft(await registrationOutcome(page, scriptPath, scopePath))
      .toMatchObject({ activated: true, scope: `${FIXTURE_ORIGIN}${scopePath}` });
  }

  for (const scopePath of [
    "/validator/no-trailing",
    "/validator//nested/",
    "/validator/%252e%252e/nested/",
    "/validator/%2f/nested/",
    "/validator/%5c/nested/",
    "/validator/%2500/nested/",
  ]) {
    expect.soft(
      (await registrationOutcome(
        page,
        "/validator/service-worker.js",
        scopePath,
      )).activated,
      `scope ${scopePath}`,
    ).toBe(false);
  }
  expect((await registrationOutcome(
    page,
    "data:text/javascript,worker",
    "/validator/",
  )).activated).toBe(false);
  expect((await registrationOutcome(
    page,
    "ftp://example.invalid/service-worker.js",
    "/validator/",
  )).activated).toBe(false);
  expect((await registrationOutcome(
    page,
    "https://example.invalid/service-worker.js",
    "/validator/",
  )).activated).toBe(false);
});

test("mints a validly-formatted machine name and app prefix", async ({ page }) => {
  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await registerScope(page, "/a/");
  const first = await installBridge(page, SESSION_A, "first");
  expect(first.name).toMatch(/^[a-z]{2,12}-[a-z]{2,12}-[a-z]{2,12}$/);
  expect(first.appPrefix).toBe(`/a/computer/${first.name}/`);
  expect(first.body).toBe("bridge:first");
});

test("two machines in one scope route to their own bridges", async ({ page }) => {
  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await registerScope(page, "/a/");
  const one = await installBridge(page, SESSION_A, "one");
  const two = await installBridge(page, SESSION_B, "two");
  expect(one.name).not.toBe(two.name);
  expect(await fetchText(page, `${one.appPrefix}page`)).toBe("bridge:one");
  expect(await fetchText(page, `${two.appPrefix}page`)).toBe("bridge:two");
});

test("root-relative subresources are attributed to the viewing machine", async ({
  context,
  page,
}) => {
  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await registerScope(page, "/a/");
  // The host tab keeps the machine's bridge alive for the whole test. A
  // separate viewer tab navigates to /computer/<name>/ so the SW records its
  // clientId -> name mapping; navigating the host itself would destroy the very
  // bridge port the machine is served over (see task report), so the viewer is
  // a distinct page — matching the real cross-tab design.
  const m = await installBridge(page, SESSION_A, "solo");
  const viewer = await context.newPage();
  try {
    await viewer.goto(`${FIXTURE_ORIGIN}${m.appPrefix}`);
    // A bare root-relative fetch from inside the app must reach the machine.
    const body = await viewer.evaluate(async () =>
      (await fetch("/wp-content/x.css", { cache: "no-store" })).text()
    );
    expect(body).toBe("bridge:solo");
  } finally {
    await viewer.close();
  }
});

test("a host-page request to a machine does not make the host a viewer", async ({ page }) => {
  // Regression: the web-readiness probe and the boot's kernel.wasm / VFS fetches
  // run on the HOST client (at "/"), not inside the app iframe. installBridge
  // itself makes a host request to /a/computer/<name>/cookie. If a host request to an
  // app path registered the host as a viewer, its later NAMELESS fetches would
  // be 307-redirected into that machine's app prefix — and after an in-place
  // machine switch, into the PREVIOUS machine's now-dead prefix, deadlocking
  // every host fetch (boot hangs forever). The host must never become a viewer:
  // only navigations INTO /computer/<name>/ and subresources with an app referer do.
  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await registerScope(page, "/a/");
  await installBridge(page, SESSION_A, "solo"); // host fetches /a/computer/<name>/cookie
  const body = await page.evaluate(async () =>
    (await fetch("/a/not-an-app-path", { cache: "no-store" })).text()
  );
  // Served as a normal same-origin response, NOT redirected into the machine.
  expect(body).toBe("network:/a/not-an-app-path");
  expect(body).not.toContain("bridge:");
});

test("a bare machine-prefix link in app HTML is not doubled", async ({ page }) => {
  // Regression: WordPress emits its home link as the bare prefix
  // http://host/a/computer/<name> (no trailing slash). The SW URL-rewriter must
  // treat that as already-prefixed and leave it alone; recognizing only "/" or
  // end-of-text as the boundary re-prefixed it into
  // /a/computer/<name>/computer/<name>. A root-relative absolute link that is
  // NOT yet under the prefix must still be rewritten into the machine.
  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await registerScope(page, "/a/");
  const out = await page.evaluate(async () => {
    const controller = navigator.serviceWorker.controller!;
    const host = location.host;
    const keepAlive = window as any;
    keepAlive.__bridgePorts ??= [];
    let name = "";
    const bridge = new MessageChannel();
    bridge.port1.onmessage = (event: any) => {
      if (event.data?.type !== "http-request") return;
      const html =
        `<!doctype html>` +
        `<a id="home" href="http://${host}/a/computer/${name}">home</a>` +
        `<a id="root" href="http://${host}/wp-content/x.css">asset</a>` +
        `<a id="ok" href="http://${host}/a/computer/${name}/already.css">ok</a>`;
      bridge.port1.postMessage({
        type: "http-response",
        requestId: event.data.requestId,
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
        body: new TextEncoder().encode(html),
      });
    };
    bridge.port1.start();
    const reply = new MessageChannel();
    const replyData = await new Promise<any>((resolve) => {
      reply.port1.onmessage = (e: any) => resolve(e.data);
      reply.port1.start();
      keepAlive.__bridgePorts.push(bridge.port1, reply.port1);
      controller.postMessage(
        { type: "init-bridge", sessionId: "33333333-3333-4333-8333-333333333333" },
        [bridge.port2, reply.port2],
      );
    });
    name = replyData.name;
    const res = await fetch(replyData.appPrefix, { cache: "no-store" });
    return { name: replyData.name, body: await res.text() };
  });
  const origin = `http://127.0.0.1:${FIXTURE_PORT}`;
  // The bare home link stays a single prefix — never doubled.
  expect(out.body).toContain(`href="${origin}/a/computer/${out.name}"`);
  expect(out.body).not.toContain(`/a/computer/${out.name}/computer/${out.name}`);
  // An already-correct deeper link is untouched.
  expect(out.body).toContain(`href="${origin}/a/computer/${out.name}/already.css"`);
  // A root-relative absolute link is re-prefixed into this machine.
  expect(out.body).toContain(`href="${origin}/a/computer/${out.name}/wp-content/x.css"`);
});

test("an unknown machine name returns a 503 HTML page", async ({ page }) => {
  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await registerScope(page, "/a/");
  const res = await fetchResponse(page, "/a/computer/happy-teal-otter/");
  expect(res.status).toBe(503);
  // An HTML document, not the plain-text stub.
  expect(res.body).toContain("<!doctype html");
  expect(res.body).toContain("happy-teal-otter");
});

test("a bare /computer/ request returns 503, never the app shell", async ({ page }) => {
  // Regression: the web-preview iframe once loaded the bare /computer/ (a stale
  // prefix), and the SW served the Kandelo shell for it, mounting the whole
  // app inside its own preview iframe and recursing (stacked docks). An
  // /computer/-namespaced request that resolves to no machine must be a 503, not a
  // 200 passthrough that could be the shell.
  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await registerScope(page, "/a/");
  const bare = await fetchResponse(page, "/a/computer/");
  expect(bare.status).toBe(503);
  expect(bare.body).toContain("<!doctype html");
  // An invalid (non-three-word) name is likewise never served the shell.
  const invalid = await fetchResponse(page, "/a/computer/not-a-valid-name-segment");
  expect(invalid.status).toBe(503);
});

test("closing the host tab pushes machine-offline to viewers", async ({
  context,
}) => {
  const host = await context.newPage();
  await host.goto(`${FIXTURE_ORIGIN}/a/`);
  await registerScope(host, "/a/");
  const m = await installBridge(host, SESSION_A, "solo");

  const viewer = await context.newPage();
  await viewer.goto(`${FIXTURE_ORIGIN}${m.appPrefix}`);
  // Attach the listener and confirm it is installed before the host announces
  // it is closing, so the machine-offline push cannot race ahead of the
  // viewer's subscription.
  await viewer.evaluate((name) => {
    (window as typeof window & { __offline?: Promise<string> }).__offline =
      new Promise<string>((resolve) => {
        navigator.serviceWorker.addEventListener("message", (event) => {
          const data = (event as MessageEvent).data;
          if (data?.type === "machine-offline" && data.name === name) {
            resolve("offline");
          }
        });
      });
  }, m.name);

  // Drive the real host->SW instance-closing message the pagehide listener
  // sends when the owning tab goes away.
  await host.evaluate(() =>
    navigator.serviceWorker.controller!.postMessage({
      type: "instance-closing",
      name: (window as typeof window & { __lastInstanceName?: string })
        .__lastInstanceName,
    })
  );

  expect(
    await viewer.evaluate(() =>
      (window as typeof window & { __offline?: Promise<string> }).__offline!
    ),
  ).toBe("offline");
});

test("a restarted-then-closed machine is terminally offlined and GCs its authority", async ({
  context,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "SW restart via CDP is Chromium-only");
  const host = await context.newPage();
  await host.goto(`${FIXTURE_ORIGIN}/a/`);
  await registerScope(host, "/a/");
  const m = await installBridge(host, SESSION_A, "solo");

  // A viewer tab is attributed to the machine while it is live, then the SW is
  // genuinely restarted. Only the host answers need-bridge, so restoration must
  // re-establish the host as the record's owningClientId — without that, the
  // machine can never be reconciled offline after the owner closes.
  const viewer = await context.newPage();
  await viewer.goto(`${FIXTURE_ORIGIN}${m.appPrefix}`);

  await installNamedRestoreResponder(host, [
    { name: m.name, appPrefix: m.appPrefix, sessionId: SESSION_A, label: "solo" },
  ]);
  await stopWorker(context, host, `${FIXTURE_ORIGIN}/a/service-worker.js`);

  // The first post-restart named request from the viewer drives restore (the
  // host re-supplies the bridge) and re-registers the viewer as an attributed
  // viewer of the restored record.
  expect(await fetchText(viewer, `${m.appPrefix}after-restart`))
    .toBe("restored:solo");

  await subscribeMachineOffline(viewer, m.name);

  // The owning tab closes without any further signal. A restart-restored record
  // now knows its owner, so lazy reconciliation on the next request can retire
  // it terminally.
  await host.close();

  await expect.poll(async () =>
    (await fetchResponse(viewer, `${m.appPrefix}after-close`)).status
  ).toBe(503);
  expect(await readMachineOffline(viewer)).toBe("offline");
  // markInstanceOffline GCs the per-name durable authority so a terminated
  // machine does not re-materialize on the next SW restart.
  await expect.poll(() => readBridgeAuthority(viewer, CACHE_A, m.name)).toBe(
    null,
  );
});

test("a crashed owner (no instance-closing) is reconciled offline on the next request", async ({
  context,
}) => {
  const host = await context.newPage();
  await host.goto(`${FIXTURE_ORIGIN}/a/`);
  await registerScope(host, "/a/");
  const m = await installBridge(host, SESSION_A, "solo");

  const viewer = await context.newPage();
  await viewer.goto(`${FIXTURE_ORIGIN}${m.appPrefix}`);
  await subscribeMachineOffline(viewer, m.name);

  // The owner tab goes away WITHOUT sending instance-closing — a crash, not an
  // orderly pagehide. Only lazy reconcileOwners on a later request can notice
  // the owning window client is gone and retire the machine.
  await host.close();

  await expect.poll(async () =>
    (await fetchResponse(viewer, `${m.appPrefix}after-crash`)).status
  ).toBe(503);
  expect(await readMachineOffline(viewer)).toBe("offline");
});

test("an offlined machine returns the 503 HTML page on a later request", async ({
  page,
}) => {
  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await registerScope(page, "/a/");
  const m = await installBridge(page, SESSION_A, "solo");

  // Retire the machine via the real owner instance-closing message (the same
  // message the pagehide listener sends). The sender is the owning client, so
  // the SW marks it offline.
  await page.evaluate((name) =>
    navigator.serviceWorker.controller!.postMessage({
      type: "instance-closing",
      name,
    }), m.name);

  // A later named request to the now-offline machine returns the 503 HTML page
  // (distinct in origin from an unknown name, identical as the real boundary:
  // this machine is not running here).
  await expect.poll(async () =>
    (await fetchResponse(page, `${m.appPrefix}later`)).status
  ).toBe(503);
  const res = await fetchResponse(page, `${m.appPrefix}later`);
  expect(res.status).toBe(503);
  expect(res.body).toContain("<!doctype html");
  expect(res.body).toContain(m.name);
});

test("cookie jars are isolated per machine", async ({ page }) => {
  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await registerScope(page, "/a/");
  const one = await installBridge(page, SESSION_A, "one");
  const two = await installBridge(page, SESSION_B, "two");
  await setBridgeCookieValue(page, "one", "ONEVAL");
  await setBridgeCookieValue(page, "two", "TWOVAL");
  await fetchText(page, `${one.appPrefix}set`); // machine one sets its cookie
  await fetchText(page, `${two.appPrefix}set`); // machine two sets its cookie
  // A second request to each machine replays the jar it has accumulated.
  await fetchText(page, `${one.appPrefix}replay`);
  await fetchText(page, `${two.appPrefix}replay`);
  const oneCookies = await page.evaluate(() =>
    (window as any).__bridgeCookies.one.at(-1)
  );
  const twoCookies = await page.evaluate(() =>
    (window as any).__bridgeCookies.two.at(-1)
  );
  // Each machine only ever sees its own cookie replayed.
  expect(oneCookies).toContain("one=ONEVAL");
  expect(oneCookies).not.toContain("two=");
  expect(twoCookies).toContain("two=TWOVAL");
  expect(twoCookies).not.toContain("one=");
});

test("a restarted SW restores each machine by name", async ({
  context,
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "SW restart via CDP is Chromium-only");
  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await registerScope(page, "/a/");
  const one = await installBridge(page, SESSION_A, "one");
  const two = await installBridge(page, SESSION_B, "two");

  // Page-side need-bridge responders, one per machine, each re-answering only
  // for its own SW-minted name — the real cross-restart handshake shape.
  await installNamedRestoreResponder(page, [
    { name: one.name, appPrefix: one.appPrefix, sessionId: SESSION_A, label: "one" },
    { name: two.name, appPrefix: two.appPrefix, sessionId: SESSION_B, label: "two" },
  ]);

  // Genuinely terminate the worker. A reincarnated module has no live bridge
  // ports, so the very next in-app fetch must drive restore-by-name.
  await stopWorker(context, page, `${FIXTURE_ORIGIN}/a/service-worker.js`);

  expect(await fetchText(page, `${one.appPrefix}after-restart`))
    .toBe("restored:one");
  expect(await fetchText(page, `${two.appPrefix}after-restart`))
    .toBe("restored:two");
});

test("a restarted SW reloads durable authority and replays each machine's jar", async ({
  context,
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "SW restart via CDP is Chromium-only");
  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await registerScope(page, "/a/");
  const m = await installBridge(page, SESSION_A, "solo");

  // installBridge already fetched once, so the machine's login (a Set-Cookie of
  // solo=1 at path /) is persisted as a durable authority revision keyed by the
  // SW-minted name. The prefixed cookie path mirrors the browser-side URL.
  const persisted = await readBridgeAuthority(page, CACHE_A, m.name);
  expect(persisted).toMatchObject({
    version: 1,
    appPrefix: m.appPrefix,
    sessionId: SESSION_A,
    cookies: [{ name: "solo", value: "1", path: m.appPrefix }],
  });
  expect(persisted!.revision).toBeGreaterThanOrEqual(2);

  await installNamedRestoreResponder(page, [
    { name: m.name, appPrefix: m.appPrefix, sessionId: SESSION_A, label: "solo" },
  ]);
  await stopWorker(context, page, `${FIXTURE_ORIGIN}/a/service-worker.js`);

  // The reincarnated worker reloads the durable jar and replays it onto the
  // freshly restored bridge — the restored tab never had to re-authenticate.
  expect(await fetchReplayedCookie(page, `${m.appPrefix}after-restart`))
    .toContain("solo=1");
});

test("a restarted SW rejects a bridge-restored whose authority does not match", async ({
  context,
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "SW restart via CDP is Chromium-only");
  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await registerScope(page, "/a/");
  const m = await installBridge(page, SESSION_A, "solo");

  // Two page-side responders re-answer for this machine's name but with a wrong
  // session id and a wrong app prefix. Restore is by exact durable authority,
  // not merely by name, so both must be rejected and the machine stays offline.
  await installNamedRestoreResponder(page, [
    { name: m.name, appPrefix: m.appPrefix, sessionId: SESSION_A_NEXT, label: "wrong-session" },
    { name: m.name, appPrefix: "/a/computer/some-other-name/", sessionId: SESSION_A, label: "wrong-prefix" },
  ]);
  await stopWorker(context, page, `${FIXTURE_ORIGIN}/a/service-worker.js`);

  expect((await fetchResponse(page, `${m.appPrefix}after-mismatch`)).status)
    .toBe(503);

  // A correct responder restores the same machine over the same durable
  // authority the mismatched candidates could not satisfy.
  await installNamedRestoreResponder(page, [
    { name: m.name, appPrefix: m.appPrefix, sessionId: SESSION_A, label: "correct" },
  ]);
  expect(await fetchText(page, `${m.appPrefix}after-correct`))
    .toBe("restored:correct");
});

test("restart quarantines malformed or foreign durable authority entries", async ({
  context,
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "SW restart via CDP is Chromium-only");
  const goodName = "able-blue-oak";
  const foreignName = "eager-teal-fern";
  const malformedName = "brave-gold-pine";

  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await registerScope(page, "/a/");

  // Seed three durable entries directly, then restart so the startup scan runs
  // against them: malformed JSON, a valid-shaped record whose appPrefix
  // disagrees with the name it is keyed under, and a well-formed record.
  await seedBridgeAuthority(page, CACHE_A, malformedName, "{ this is not json");
  await seedBridgeAuthority(page, CACHE_A, foreignName, JSON.stringify({
    version: 1,
    revision: 1,
    appPrefix: "/a/computer/some-other-name/",
    sessionId: SESSION_A,
    cookies: [],
  }));
  await seedBridgeAuthority(page, CACHE_A, goodName, JSON.stringify({
    version: 1,
    revision: 4,
    appPrefix: `/a/computer/${goodName}/`,
    sessionId: SESSION_A,
    cookies: [{ name: "seeded", value: "1", path: `/a/computer/${goodName}/` }],
  }));

  await installNamedRestoreResponder(page, [
    { name: goodName, appPrefix: `/a/computer/${goodName}/`, sessionId: SESSION_A, label: "good" },
    { name: foreignName, appPrefix: "/a/computer/some-other-name/", sessionId: SESSION_A, label: "foreign" },
  ]);
  await stopWorker(context, page, `${FIXTURE_ORIGIN}/a/service-worker.js`);

  // The malformed and the name/prefix-mismatched entries never become records:
  // their machines report unavailable and never trigger a need-bridge handshake.
  expect((await fetchResponse(page, `/a/computer/${foreignName}/probe`)).status)
    .toBe(503);
  expect((await fetchResponse(page, `/a/computer/${malformedName}/probe`)).status)
    .toBe(503);
  expect(await needBridgeCount(page)).toBe(0);

  // The well-formed entry restores and replays its seeded jar.
  expect(await fetchReplayedCookie(page, `/a/computer/${goodName}/probe`))
    .toContain("seeded=1");
});

test("restart rejects every over-limit or malformed persisted authority field", async ({
  context,
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "SW restart via CDP is Chromium-only");
  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await registerScope(page, "/a/");

  // Each invalid record is keyed under a distinct well-formed machine name so
  // the only reason the scan can reject it is the field under test.
  const validAuthority = (name: string) => ({
    version: BRIDGE_AUTHORITY_VERSION,
    revision: 1,
    appPrefix: `/a/computer/${name}/`,
    sessionId: SESSION_A,
    cookies: [{ name: "ok", value: "1", path: `/a/computer/${name}/` }],
  });

  const cases: Array<{ name: string; text: string }> = [];
  const add = (
    name: string,
    mutate: (authority: ReturnType<typeof validAuthority>) => unknown,
  ) => {
    const authority = validAuthority(name);
    cases.push({ name, text: JSON.stringify(mutate(authority) ?? authority) });
  };

  // Total serialized bytes above the cap (valid JSON padded past the limit).
  const oversizedName = "dev-red-oak";
  const padded = JSON.stringify(validAuthority(oversizedName));
  cases.push({
    name: oversizedName,
    text: padded +
      " ".repeat(BRIDGE_AUTHORITY_MAX_BYTES + 1 - Buffer.byteLength(padded)),
  });
  add("dev-red-elm", (a) => {
    a.cookies = Array.from(
      { length: BRIDGE_AUTHORITY_MAX_COOKIES + 1 },
      (_, index) => ({ name: `c${index}`, value: "1", path: a.appPrefix }),
    );
  });
  add("dev-red-fir", (a) => {
    a.cookies[0].name = "n".repeat(BRIDGE_COOKIE_NAME_MAX_BYTES + 1);
  });
  add("dev-red-ash", (a) => {
    a.cookies[0].name = "bad name";
  });
  add("dev-red-yew", (a) => {
    a.cookies[0].value = "x".repeat(BRIDGE_COOKIE_VALUE_MAX_BYTES + 1);
  });
  add("dev-red-bay", (a) => {
    a.cookies[0].value = "bad;value";
  });
  add("dev-red-fig", (a) => {
    a.cookies[0].path = `/a/${"p".repeat(BRIDGE_COOKIE_PATH_MAX_BYTES)}`;
  });
  add("dev-red-gum", (a) => {
    a.cookies[0].path = "/b/outside-scope/";
  });
  add("dev-red-haw", (a) => {
    a.version = 2;
  });
  add("dev-red-ivy", (a) => {
    a.revision = -1;
  });
  add("dev-red-nut", (a) => {
    a.revision = Number.MAX_SAFE_INTEGER;
  });

  for (const invalid of cases) {
    await seedBridgeAuthority(page, CACHE_A, invalid.name, invalid.text);
  }
  // No responder should ever be needed: quarantined entries never become
  // records, so they never broadcast need-bridge.
  await installNamedRestoreResponder(page, []);
  await stopWorker(context, page, `${FIXTURE_ORIGIN}/a/service-worker.js`);

  for (const invalid of cases) {
    expect.soft(
      (await fetchResponse(page, `/a/computer/${invalid.name}/probe`)).status,
      invalid.name,
    ).toBe(503);
  }
  expect(await needBridgeCount(page)).toBe(0);
});

test("the lazy VFS cache excludes bridge, static, query, navigation, sibling, and cross-origin routes", async ({
  page,
}) => {
  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await registerScope(page, "/a/");
  const m = await installBridge(page, SESSION_A, "excluded");

  // A real vfs-groups asset is the only route the lazy cache owns.
  expect(await fetchText(page, "/a/vfs-groups/release-1/assets/shared.bin"))
    .toBe("scope-a shared bytes");

  // Excluded: an app/<name> bridge route (name in path, never lazy).
  await fetchText(page, `${m.appPrefix}vfs-groups/release-1/assets/shared.bin`);
  // Excluded: a static file outside vfs-groups.
  await fetchText(page, "/a/static.txt");
  // Excluded: a query string.
  await fetchText(page, "/a/vfs-groups/release-1/assets/shared.bin?revision=1");
  // Excluded: a sibling prefix that only shares a stem.
  await fetchText(page, "/a/vfs-groups-sibling/release-1/assets/shared.bin");
  // Excluded: a canonical Pages VFS object.
  await fetchText(
    page,
    "/a/products/demo/sha256-" + "a".repeat(64) + "/demo-1.vfs.zst",
  );
  // Excluded: a navigation request under vfs-groups.
  await page.goto(`${FIXTURE_ORIGIN}/a/vfs-groups/release-1/navigation.html`);
  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  // Excluded: a cross-origin request for the same asset path.
  await page.evaluate(async () => {
    await fetch(
      "http://localhost:55431/a/vfs-groups/release-1/assets/shared.bin",
      { mode: "no-cors" },
    ).catch(() => undefined);
  });

  expect(await lazyCacheEntries(page, LAZY_CACHE_A)).toEqual([
    "/a/vfs-groups/release-1/assets/shared.bin",
  ]);
});

// Subscribe a viewer page to the SW's machine-offline push for one machine,
// storing the resolution on window.__offline so a later step can await it. The
// listener is installed before the offline event is triggered so the push can
// never race ahead of the subscription.
async function subscribeMachineOffline(page: Page, name: string): Promise<void> {
  await page.evaluate((machineName) => {
    (window as typeof window & { __offline?: Promise<string> }).__offline =
      new Promise<string>((resolve) => {
        navigator.serviceWorker.addEventListener("message", (event) => {
          const data = (event as MessageEvent).data;
          if (data?.type === "machine-offline" && data.name === machineName) {
            resolve("offline");
          }
        });
      });
  }, name);
}

async function readMachineOffline(page: Page): Promise<string> {
  return page.evaluate(() =>
    (window as typeof window & { __offline?: Promise<string> }).__offline!
  );
}

async function fetchReplayedCookie(page: Page, pathname: string): Promise<string> {
  return page.evaluate(async (path) => {
    const response = await fetch(path, { cache: "no-store" });
    return response.headers.get("x-replayed-cookie") ?? "";
  }, pathname);
}

async function seedCaches(page: Page, names: readonly string[]): Promise<void> {
  await page.evaluate(async (cacheNamesToSeed) => {
    for (const name of cacheNamesToSeed) {
      const cache = await caches.open(name);
      await cache.put("seed", new Response(name));
    }
  }, names);
}

async function cacheNames(page: Page): Promise<string[]> {
  return page.evaluate(() => caches.keys());
}

function groupedWorkerSource(): string {
  if (groupedWorkerCacheVersion === undefined) return workerSource;
  return workerSource.replace(
    `null /*${VFS_LAZY_CACHE_VERSION_PLACEHOLDER}*/`,
    JSON.stringify(groupedWorkerCacheVersion),
  );
}

function lazyCacheName(scope: string, manifestSha256: string): string {
  return `kandelo-sw:${encodeURIComponent(scope)}:lazy-assets-v1:${manifestSha256}`;
}

async function updateScope(
  page: Page,
  scopePath: "/a/",
): Promise<void> {
  await page.evaluate(async (scope) => {
    const registration = await navigator.serviceWorker.getRegistration(scope);
    if (registration === undefined) {
      throw new Error(`missing service worker registration for ${scope}`);
    }
    const prior = navigator.serviceWorker.controller;
    const changed = new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(
        () => reject(new Error("timed out waiting for service worker update")),
        10_000,
      );
      const onControllerChange = () => {
        if (navigator.serviceWorker.controller === prior) return;
        navigator.serviceWorker.removeEventListener(
          "controllerchange",
          onControllerChange,
        );
        window.clearTimeout(timeout);
        resolve();
      };
      navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
    });
    await registration.update();
    if (navigator.serviceWorker.controller !== prior) return;
    await changed;
  }, scopePath);
}

async function registerScope(
  page: Page,
  scopePath: "/a/" | "/b/" | "/candidate-b/",
): Promise<void> {
  await page.evaluate(async (scope) => {
    const scriptUrl = new URL(`${scope}service-worker.js`, location.href).href;
    const registration = await navigator.serviceWorker.register(scriptUrl, {
      scope,
      updateViaCache: "none",
    });
    if (registration.scope !== new URL(scope, location.href).href) {
      throw new Error(`unexpected registration scope ${registration.scope}`);
    }
    const candidate = registration.installing ?? registration.waiting ??
      registration.active;
    if (candidate && candidate.state !== "activated") {
      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(
          () => reject(new Error("timed out waiting for activation")),
          10_000,
        );
        candidate.addEventListener("statechange", () => {
          if (candidate.state === "activated") {
            window.clearTimeout(timeout);
            resolve();
          } else if (candidate.state === "redundant") {
            window.clearTimeout(timeout);
            reject(new Error("service worker became redundant"));
          }
        });
      });
    }
    if (navigator.serviceWorker.controller?.scriptURL !== scriptUrl) {
      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(
          () => reject(new Error("timed out waiting for exact controller")),
          10_000,
        );
        const onControllerChange = () => {
          if (navigator.serviceWorker.controller?.scriptURL !== scriptUrl) return;
          navigator.serviceWorker.removeEventListener(
            "controllerchange",
            onControllerChange,
          );
          window.clearTimeout(timeout);
          resolve();
        };
        navigator.serviceWorker.addEventListener(
          "controllerchange",
          onControllerChange,
        );
      });
    }
  }, scopePath);
}

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
    // Expose the SW-minted name so the offline test can drive the real
    // instance-closing message the host page's pagehide listener would send.
    keepAlive.__lastInstanceName = replyData.name;
    const appPrefix: string = replyData.appPrefix;
    const response = await fetch(`${appPrefix}cookie`, { cache: "no-store" });
    return { reply: replyData, name: replyData.name, appPrefix, body: await response.text() };
  }, { session: sessionId, responseLabel: label });
}

async function setBridgeCookieValue(
  page: Page,
  label: string,
  value: string,
): Promise<void> {
  await page.evaluate(({ responseLabel, cookieValue }) => {
    const keepAlive = window as typeof window & {
      __bridgeCookieValues?: Record<string, string>;
    };
    keepAlive.__bridgeCookieValues ??= {};
    keepAlive.__bridgeCookieValues[responseLabel] = cookieValue;
  }, { responseLabel: label, cookieValue: value });
}

async function fetchText(page: Page, pathname: string): Promise<string> {
  return page.evaluate(async (path) => {
    const response = await fetch(path, { cache: "no-store" });
    return response.text();
  }, pathname);
}

async function fetchResponse(
  page: Page,
  pathname: string,
): Promise<{ status: number; body: string; contentLength: string | null }> {
  return page.evaluate(async (path) => {
    const response = await fetch(path, { cache: "no-store" });
    return {
      status: response.status,
      body: await response.text(),
      contentLength: response.headers.get("content-length"),
    };
  }, pathname);
}

async function fetchBytes(page: Page, pathname: string): Promise<void> {
  await page.evaluate(async (path) => {
    const response = await fetch(path, { cache: "no-store" });
    await response.arrayBuffer();
  }, pathname);
}

async function lazyCacheEntries(page: Page, cacheName: string): Promise<string[]> {
  return page.evaluate(async (name) => {
    if (!(await caches.keys()).includes(name)) return [];
    const cache = await caches.open(name);
    return (await cache.keys()).map((request) => new URL(request.url).pathname)
      .sort();
  }, cacheName);
}

interface RestoreResponderMachine {
  name: string;
  appPrefix: string;
  sessionId: string;
  label: string;
}

// Install one page-side need-bridge responder per machine. Each answers only
// for its own SW-minted name with a fresh bridge port that echoes
// "restored:<label>", mirroring setupServiceWorkerFetchBridge's per-machine
// listener. A responder whose name/appPrefix/sessionId is deliberately wrong
// exercises the SW's restore-by-name rejection.
async function installNamedRestoreResponder(
  page: Page,
  machines: RestoreResponderMachine[],
): Promise<void> {
  await page.evaluate((entries) => {
    const keepAlive = window as typeof window & {
      __bridgePorts?: MessagePort[];
      __needBridgeCount?: number;
    };
    keepAlive.__bridgePorts ??= [];
    keepAlive.__needBridgeCount = 0;
    for (const machine of entries) {
      navigator.serviceWorker.addEventListener("message", (event) => {
        if (event.data?.type !== "need-bridge" || !event.ports[0]) return;
        keepAlive.__needBridgeCount! += 1;
        const fresh = new MessageChannel();
        fresh.port1.onmessage = (bridgeEvent) => {
          if (bridgeEvent.data?.type !== "http-request") return;
          fresh.port1.postMessage({
            type: "http-response",
            requestId: bridgeEvent.data.requestId,
            status: 200,
            headers: {
              "Content-Type": "text/plain; charset=utf-8",
              // Echo the cookie header the SW injected so a test can prove the
              // reloaded durable jar is replayed onto the restored bridge.
              "x-replayed-cookie": bridgeEvent.data.headers?.cookie ?? "",
            },
            body: new TextEncoder().encode(`restored:${machine.label}`),
          });
        };
        fresh.port1.start();
        keepAlive.__bridgePorts!.push(fresh.port1);
        event.ports[0].postMessage(
          {
            type: "bridge-restored",
            name: machine.name,
            appPrefix: machine.appPrefix,
            sessionId: machine.sessionId,
          },
          [fresh.port2],
        );
      });
    }
  }, machines);
}

async function needBridgeCount(page: Page): Promise<number> {
  return page.evaluate(() => (
    window as typeof window & { __needBridgeCount?: number }
  ).__needBridgeCount ?? 0);
}

async function readBridgeAuthority(
  page: Page,
  cacheName: string,
  name: string,
): Promise<
  | { version: number; revision: number; appPrefix: string; sessionId: string; cookies: Array<{ name: string; value: string; path: string }> }
  | null
> {
  return page.evaluate(async ({ cache: cacheName, authorityKey, machineName }) => {
    if (!(await caches.keys()).includes(cacheName)) return null;
    const cache = await caches.open(cacheName);
    const suffix = `${authorityKey}/${machineName}`;
    const match = (await cache.keys()).find((request) =>
      new URL(request.url).pathname.endsWith(suffix)
    );
    if (!match) return null;
    const response = await cache.match(match);
    return response ? JSON.parse(await response.text()) : null;
  }, { cache: cacheName, authorityKey: BRIDGE_AUTHORITY_KEY, machineName: name });
}

async function seedBridgeAuthority(
  page: Page,
  cacheName: string,
  name: string,
  authorityText: string,
): Promise<void> {
  await page.evaluate(async ({ cache: cacheName, key, text }) => {
    const cache = await caches.open(cacheName);
    await cache.put(
      key,
      new Response(text, { headers: { "Content-Type": "application/json" } }),
    );
  }, { cache: cacheName, key: `${BRIDGE_AUTHORITY_KEY}/${name}`, text: authorityText });
}

// Genuinely terminate the running service worker via the Chromium DevTools
// Protocol. A reincarnated worker re-evaluates its module with an empty live
// registry, so this is the real restart the recovery path must survive — no
// SW-side test backdoor required.
async function stopWorker(
  context: BrowserContext,
  page: Page,
  scriptUrl: string,
): Promise<void> {
  const client = await context.newCDPSession(page);
  try {
    const versionId = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`timed out finding ${scriptUrl}`)),
        10_000,
      );
      client.on("ServiceWorker.workerVersionUpdated", (event) => {
        const running = (event.versions ?? []).find((version: {
          runningStatus?: string;
          scriptURL?: string;
          versionId: string;
        }) => version.runningStatus === "running" && version.scriptURL === scriptUrl);
        if (!running) return;
        clearTimeout(timeout);
        resolve(String(running.versionId));
      });
      void client.send("ServiceWorker.enable").catch(reject);
    });
    await client.send("ServiceWorker.stopWorker", { versionId });
  } finally {
    await client.detach();
  }
}

async function registrationOutcome(
  page: Page,
  scriptPath: string,
  scopePath: string,
): Promise<{ activated: boolean; scope?: string; error?: string }> {
  return page.evaluate(async ({ script, scope }) => {
    try {
      const registration = await navigator.serviceWorker.register(script, {
        scope,
        updateViaCache: "none",
      });
      const worker = registration.installing ?? registration.waiting ??
        registration.active;
      if (!worker) {
        await registration.unregister();
        return { activated: false, scope: registration.scope };
      }
      if (worker.state !== "activated" && worker.state !== "redundant") {
        await new Promise<void>((resolve) => {
          const timeout = window.setTimeout(resolve, 5_000);
          worker.addEventListener("statechange", () => {
            if (worker.state !== "activated" && worker.state !== "redundant") {
              return;
            }
            window.clearTimeout(timeout);
            resolve();
          });
        });
      }
      const activated = worker.state === "activated";
      const registrationScope = registration.scope;
      await registration.unregister();
      return { activated, scope: registrationScope };
    } catch (error) {
      return {
        activated: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }, { script: scriptPath, scope: scopePath });
}
