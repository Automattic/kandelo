import {
  expect,
  test,
  type Page,
} from "@playwright/test";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";

const FIXTURE_PORT = 55_431;
const FIXTURE_ORIGIN = `http://127.0.0.1:${FIXTURE_PORT}`;
// The retired guest cookie-jar caches. Guest web pages and their cookies
// moved to the preview origin (see preview-service-worker.spec.ts), so
// activation deletes this scope's old jar cache and leaves a sibling scope's.
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

    if (url.pathname === "/a/pages/kandelo/viewer.html") {
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": "text/html; charset=utf-8",
      });
      response.end("<!doctype html><title>Kandelo viewer fixture</title><p id=viewer>viewer</p>");
      return;
    }

    if (url.pathname === "/a/module-worker.js" ||
      url.pathname === "/a/module-dependency.js") {
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": "application/javascript; charset=utf-8",
      });
      response.end(url.pathname === "/a/module-worker.js"
        ? 'import { value } from "./module-dependency.js"; self.postMessage(value);'
        : 'export const value = "module-worker-ready";');
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

test("a controlled module worker loads imports without waiting on its own client", async ({
  page,
}) => {
  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await registerScope(page, "/a/");
  const value = await page.evaluate(() => new Promise<string>((resolve, reject) => {
    const worker = new Worker("/a/module-worker.js", { type: "module" });
    worker.onmessage = (event) => {
      worker.terminate();
      resolve(event.data);
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || "module worker crashed"));
    };
  }));
  expect(value).toBe("module-worker-ready");
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

test("a computer/ navigation opens the viewer shell, never a guest page", async ({ page }) => {
  // `<scope>computer/<name>/<path>` is the address users share. On Kandelo's
  // origin it is only ever the viewer shell, which embeds the guest page from
  // the preview origin; guest bytes never come from this origin.
  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await registerScope(page, "/a/");
  const target = `${FIXTURE_ORIGIN}/a/computer/able-blue-oak-h2y32q4zi7vxmkmy4vtm/wp-admin/?x=1`;
  const response = await page.goto(target);
  expect(page.url()).toBe(target);
  expect(await page.title()).toBe("Kandelo viewer fixture");
  expect(response?.status()).toBe(200);
  // Only Kandelo may frame Kandelo documents.
  expect(response?.headers()["content-security-policy"]).toContain("frame-ancestors 'self'");
  expect(response?.headers()["cross-origin-embedder-policy"]).toBe("require-corp");
  // An old three-word link opens the viewer shell too, which says that the
  // address no longer works instead of resolving it to any machine.
  const legacy = await page.goto(`${FIXTURE_ORIGIN}/a/computer/able-blue-oak/`);
  expect(await page.title()).toBe("Kandelo viewer fixture");
  expect(legacy?.status()).toBe(200);
});

test("every other computer/ request is refused on Kandelo's origin", async ({ page }) => {
  // Regression guard: the app shell never lives under computer/, so a stray
  // computer/ URL must not mount Kandelo inside a preview frame, and a guest
  // subresource must not be served from Kandelo's origin.
  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await registerScope(page, "/a/");
  for (const path of [
    "/a/computer/able-blue-oak-h2y32q4zi7vxmkmy4vtm/style.css",
    "/a/computer/able-blue-oak-h2y32q4zi7vxmkmy4vtm/",
    "/a/computer/",
    "/a/computer",
  ]) {
    const res = await fetchResponse(page, path);
    expect.soft(res.status, path).toBe(404);
    expect.soft(res.body, path).toContain("preview origin");
  }
  const write = await page.evaluate(async () => {
    const response = await fetch("/a/computer/able-blue-oak-h2y32q4zi7vxmkmy4vtm/api", { method: "POST", body: "x" });
    return { status: response.status, body: await response.text() };
  });
  expect(write.status).toBe(404);
  for (const path of ["/a/computer/", "/a/computer/not-a-valid-name-segment"]) {
    const response = await page.goto(`${FIXTURE_ORIGIN}${path}`);
    expect.soft(response?.status(), path).toBe(404);
    expect.soft(await page.textContent("body"), path).toContain("preview origin");
  }
});

test("the lazy VFS cache excludes computer/, static, query, navigation, sibling, and cross-origin routes", async ({
  page,
}) => {
  await page.goto(`${FIXTURE_ORIGIN}/a/`);
  await registerScope(page, "/a/");

  // A real vfs-groups asset is the only route the lazy cache owns.
  expect(await fetchText(page, "/a/vfs-groups/release-1/assets/shared.bin"))
    .toBe("scope-a shared bytes");

  // Excluded: a computer/<name> route (refused, never lazy).
  await fetchText(page, "/a/computer/able-blue-oak-h2y32q4zi7vxmkmy4vtm/vfs-groups/release-1/assets/shared.bin");
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
