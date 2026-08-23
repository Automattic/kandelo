import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { cp, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { tmpdir } from "node:os";

import { buildLocalVfsAssetGroup } from "../../../scripts/build-local-vfs-asset-group";
import { runTerminalCommand } from "./support/terminal-command";
import { startScopedStaticServer, type ScopedStaticServer } from "./support/scoped-static-server";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const sourceOnlyRoot = process.env.KANDELO_SCOPED_DEPLOYMENT_SOURCE_ONLY_ROOT;
const CACHE_A = "kandelo-sw:%2Fa%2F:bridge-v2";
const CACHE_B = "kandelo-sw:%2Fcandidate-b%2F:bridge-v2";
const STORAGE_B_PREFIX = "kandelo:%2Fcandidate-b%2F:";
const SESSION_B = "22222222-2222-4222-8222-222222222222";

interface CacheEntrySnapshot {
  request: {
    body: null;
    cache: RequestCache;
    credentials: RequestCredentials;
    destination: RequestDestination;
    headers: [string, string][];
    integrity: string;
    keepalive: boolean;
    method: string;
    mode: RequestMode;
    redirect: RequestRedirect;
    referrer: string;
    referrerPolicy: ReferrerPolicy;
    url: string;
  };
  response: {
    body: {
      bytes: number;
      exactBytes?: number[];
      sha256: string;
    };
    headers: [string, string][];
    ok: boolean;
    redirected: boolean;
    status: number;
    statusText: string;
    type: ResponseType;
    url: string;
  };
}

interface NamedCacheSnapshot {
  entries: CacheEntrySnapshot[];
  name: string;
}

let fixtureRoot: string;
let server: ScopedStaticServer;
let vimArchiveIdentity: { bytes: number; sha256: string };
let lazyCacheA: string;
let lazyCacheB: string;

test.describe.serial("real scoped production deployments", () => {
  test.skip(
    sourceOnlyRoot === undefined,
    "requires KANDELO_SCOPED_DEPLOYMENT_SOURCE_ONLY_ROOT with real SourceOnly artifacts",
  );
  test.setTimeout(12 * 60_000);

  test.beforeAll(async () => {
    fixtureRoot = await realpath(
      await mkdtemp(join(tmpdir(), "kandelo-scoped-deployments-")),
    );
    const group = join(fixtureRoot, "vfs-group");
    const map = join(fixtureRoot, "pages-vfs-products.private.json");
    await withSourceOnlyEnvironment(async () => {
      await buildLocalVfsAssetGroup({
        assetGroupDirectory: group,
        productMapPath: map,
        sourceRoot: repoRoot,
      });
      const assetGroupSha256 = await readAssetGroupSha256(map);
      lazyCacheA = lazyCacheName("/a/", assetGroupSha256);
      lazyCacheB = lazyCacheName("/candidate-b/", assetGroupSha256);
      vimArchiveIdentity = await readVimArchiveIdentity(
        join(group, "manifest.json"),
      );
      await buildVite("/a/", join(fixtureRoot, "a"), map, group);
      await buildVite("/candidate-b/", join(fixtureRoot, "candidate-b"), map, group);

      const relocatedGroup = join(fixtureRoot, "relocated-group");
      const relocatedMap = join(fixtureRoot, "relocated.private.json");
      await cp(group, relocatedGroup, { recursive: true, dereference: true });
      await writeRelocatedMap(map, relocatedMap, "nested/release-2/manifest.json");
      await buildVite("/a/", join(fixtureRoot, "a-relocated"), relocatedMap, relocatedGroup);
      await writeRelocatedMap(map, join(fixtureRoot, "outside.private.json"), "../outside/manifest.json");
      await expect(
        buildVite("/a/", join(fixtureRoot, "a-outside"), join(fixtureRoot, "outside.private.json"), relocatedGroup),
      ).rejects.toThrow();
    });
    const outsideSymlinkTarget = join(fixtureRoot, "outside-symlink-target.txt");
    await writeFile(outsideSymlinkTarget, "outside symlink sentinel");
    await symlink(
      outsideSymlinkTarget,
      join(fixtureRoot, "a", "outside-symlink.txt"),
    );
    server = await startScopedStaticServer({
      aRoot: join(fixtureRoot, "a"),
      candidateBRoot: join(fixtureRoot, "candidate-b"),
    });
    for (const path of ["/a/%2e%2e/package.json", "/a/%2Fetc/passwd"]) {
      expect((await fetch(`${server.origin}${path}`)).status).toBe(404);
    }
    const headers = await fetch(`${server.origin}/a/service-worker.js`);
    expect(headers.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    expect(headers.headers.get("cross-origin-embedder-policy")).toBe("require-corp");
    expect(headers.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(headers.headers.get("service-worker-allowed")).toBeNull();
    const symlinkUrl = `${server.origin}/a/outside-symlink.txt`;
    expect((await fetch(symlinkUrl)).status).toBe(404);
    server.setSymlinkRejection(false);
    try {
      const bypassed = await fetch(symlinkUrl);
      expect(bypassed.status).toBe(200);
      expect(await bypassed.text()).toBe("outside symlink sentinel");
    } finally {
      server.setSymlinkRejection(true);
    }
    expect((await fetch(symlinkUrl)).status).toBe(404);
  });

  test.afterAll(async () => {
    await server?.close();
    await rm(fixtureRoot, { force: true, recursive: true });
  });

  test("keeps real sibling shells, workers, VFS groups, and restart state isolated", async ({ browser }) => {
    const context = await browser.newContext();
    try {
      const pageA = await context.newPage();
      const pageB = await context.newPage();
      await pageA.goto(`${server.origin}/a/?demo=shell`, { waitUntil: "domcontentloaded" });
      await pageB.goto(`${server.origin}/candidate-b/?demo=shell`, { waitUntil: "domcontentloaded" });
      await Promise.all([waitForShell(pageA), waitForShell(pageB)]);

      await seedUnrelatedCache(pageA);
      await expect(scopes(pageA)).resolves.toEqual({
        controller: `${server.origin}/a/service-worker.js`,
        registration: `${server.origin}/a/`,
        rootRegistration: null,
      });
      await expect(scopes(pageB)).resolves.toEqual({
        controller: `${server.origin}/candidate-b/service-worker.js`,
        registration: `${server.origin}/candidate-b/`,
        rootRegistration: null,
      });

      server.clearRequests(); await runVimVersion(pageA); assertOnlyGroupRequests(server, "/a/");
      server.clearRequests(); await runVimVersion(pageB); assertOnlyGroupRequests(server, "/candidate-b/");
      await expect(cacheNames(pageA)).resolves.toEqual(expect.arrayContaining([
        CACHE_A, CACHE_B, lazyCacheA, lazyCacheB, "unrelated-site-cache",
      ]));
      expect(await cachePaths(pageA, lazyCacheA)).toEqual(expect.arrayContaining([expect.stringMatching(/^\/a\/vfs-groups\//)]));
      expect(await cachePaths(pageA, lazyCacheA)).not.toEqual(expect.arrayContaining([expect.stringMatching(/^\/candidate-b\//)]));
      expect(await cachePaths(pageB, lazyCacheB)).toEqual(expect.arrayContaining([expect.stringMatching(/^\/candidate-b\/vfs-groups\//)]));
      expect(await cachePaths(pageB, lazyCacheB)).not.toEqual(expect.arrayContaining([expect.stringMatching(/^\/a\//)]));
      const corrupted = await corruptCachedVimArchive(pageA);
      expect(corrupted.original).toEqual(vimArchiveIdentity);
      expect(corrupted.corrupt.bytes).toBe(vimArchiveIdentity.bytes);
      expect(corrupted.corrupt.sha256).not.toBe(vimArchiveIdentity.sha256);
      await pageA.reload({ waitUntil: "domcontentloaded" });
      await waitForShell(pageA);
      const corruptCacheBefore = await cachedVimEntry(pageA);
      const expectedDiagnostic =
        `Lazy archive SHA-256 ${corrupted.corrupt.sha256} ` +
        `does not match expected ${vimArchiveIdentity.sha256}`;
      const shaDiagnostics: string[] = [];
      pageA.on("console", (message) => {
        const matches = message.text().match(
          /Lazy archive SHA-256 [0-9a-f]{64} does not match expected [0-9a-f]{64}/g,
        );
        if (matches !== null) shaDiagnostics.push(...matches);
      });
      server.clearRequests();
      const firstCorruptAttempt = await runCorruptVimProbe(pageA);
      expect(firstCorruptAttempt).toMatchObject({ exitCode: 0 });
      expect(firstCorruptAttempt.output).toContain(
        "bash: line 1: /usr/bin/vim: I/O error",
      );
      expect(firstCorruptAttempt.output).toContain("VIM_CORRUPT_REJECTED");
      expect(firstCorruptAttempt.output).not.toContain("VIM_CORRUPT_MATERIALIZED");
      expect(await cachedVimEntry(pageA)).toEqual(corruptCacheBefore);

      const secondCorruptAttempt = await runCorruptVimProbe(pageA);
      expect(secondCorruptAttempt).toMatchObject({ exitCode: 0 });
      expect(secondCorruptAttempt.output).toContain(
        "bash: line 1: /usr/bin/vim: I/O error",
      );
      expect(secondCorruptAttempt.output).toContain("VIM_CORRUPT_REJECTED");
      expect(secondCorruptAttempt.output).not.toContain("VIM_CORRUPT_MATERIALIZED");
      expect(await cachedVimEntry(pageA)).toEqual(corruptCacheBefore);
      expect(shaDiagnostics).toEqual([expectedDiagnostic, expectedDiagnostic]);
      expect(server.requests().filter((request) =>
        request.pathname.endsWith("/vim.zip")
      )).toEqual([]);

      await expect(installBridgeAuthority(pageB)).resolves.toEqual({
        type: "bridge-ready",
      });
      const missingCache = "scoped-deployment-observation-must-not-create";
      await expect(readCacheSnapshot(pageB, missingCache, false)).rejects.toThrow(
        `cache ${missingCache} does not exist`,
      );
      expect(await cacheNames(pageB)).not.toContain(missingCache);
      const candidateBeforeRestart = await durableSnapshot(pageB);
      expect(candidateBeforeRestart).toMatchObject({
        serviceWorker: {
          controller: `${server.origin}/candidate-b/service-worker.js`,
          registration: `${server.origin}/candidate-b/`,
        },
        bridgeCache: { name: CACHE_B, entries: expect.any(Array) },
        lazyCache: { name: lazyCacheB, entries: expect.any(Array) },
        retrySessionKeys: expect.any(Array),
        unrelatedCache: {
          name: "unrelated-site-cache",
          entries: expect.any(Array),
        },
      });
      expect(candidateBeforeRestart.bridgeCache.entries).toHaveLength(1);
      assertBridgeAuthority(candidateBeforeRestart.bridgeCache, server.origin);
      expect(candidateBeforeRestart.lazyCache.entries.length).toBeGreaterThan(0);
      expect(candidateBeforeRestart.lazyCache.entries.some((entry) =>
        new URL(entry.request.url).pathname.endsWith("/vim.zip")
      )).toBe(true);
      expect(candidateBeforeRestart.lazyCache.entries.every((entry) =>
        new URL(entry.request.url).pathname.startsWith("/candidate-b/vfs-groups/")
      )).toBe(true);
      expect(candidateBeforeRestart.retrySessionKeys.every((entry) =>
        entry.key.startsWith(STORAGE_B_PREFIX)
      )).toBe(true);
      expect(candidateBeforeRestart.unrelatedCache.entries).toMatchObject([{
        response: {
          body: {
            bytes: 4,
            exactBytes: [115, 101, 101, 100],
          },
        },
      }]);
      await stopWorker(context, pageA, `${server.origin}/a/service-worker.js`);
      await pageA.reload({ waitUntil: "domcontentloaded" });
      await waitForShell(pageA);
      await runTerminalCommand(pageA, "printf restart-a-ok", "restart-a-ok");
      await runTerminalCommand(pageB, "printf restart-b-ok", "restart-b-ok");
      await expect(durableSnapshot(pageB)).resolves.toEqual(candidateBeforeRestart);

      const candidateBeforeUpdate = await durableSnapshot(pageB);
      await pageA.evaluate(async () => (await navigator.serviceWorker.getRegistration("/a/"))?.update());
      await pageA.reload({ waitUntil: "domcontentloaded" });
      await waitForShell(pageA);
      await runTerminalCommand(pageA, "printf update-a-ok", "update-a-ok");
      await runTerminalCommand(pageB, "printf update-b-ok", "update-b-ok");
      await expect(durableSnapshot(pageB)).resolves.toEqual(candidateBeforeUpdate);

      await server.replaceRoot("a", join(fixtureRoot, "a-relocated"));
      const relocated = await context.newPage();
      await relocated.goto(`${server.origin}/a/?demo=shell`, { waitUntil: "domcontentloaded" });
      await waitForShell(relocated);
      server.clearRequests();
      await runVimVersion(relocated);
      expect(server.requests().filter((request) => request.pathname.includes("manifest.json") || request.pathname.includes("vim.zip")))
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ pathname: expect.stringMatching(/^\/a\/nested\/release-2\//) }),
        ]));
    } finally {
      await context.close();
    }
  });
});

async function withSourceOnlyEnvironment(action: () => Promise<void>): Promise<void> {
  const previousPolicy = process.env.WASM_POSIX_RESOLUTION_POLICY;
  const previousRoot = process.env.WASM_POSIX_SOURCE_ONLY_BINARY_ROOT;
  process.env.WASM_POSIX_RESOLUTION_POLICY = "source-only-v1";
  process.env.WASM_POSIX_SOURCE_ONLY_BINARY_ROOT = sourceOnlyRoot!;
  try { await action(); } finally {
    if (previousPolicy === undefined) delete process.env.WASM_POSIX_RESOLUTION_POLICY;
    else process.env.WASM_POSIX_RESOLUTION_POLICY = previousPolicy;
    if (previousRoot === undefined) delete process.env.WASM_POSIX_SOURCE_ONLY_BINARY_ROOT;
    else process.env.WASM_POSIX_SOURCE_ONLY_BINARY_ROOT = previousRoot;
  }
}

async function buildVite(base: string, outDir: string, map: string, group: string): Promise<void> {
  await execFileAsync("npm", ["--prefix", "apps/browser-demos", "run", "build", "--", "--outDir", outDir], {
    cwd: repoRoot,
    env: { ...process.env, KANDELO_PAGES_PRODUCT_MAP: map, KANDELO_PAGES_VFS_ASSET_GROUP_DIR: group, VITE_BASE: base, WASM_POSIX_RESOLUTION_POLICY: "source-only-v1", WASM_POSIX_SOURCE_ONLY_BINARY_ROOT: sourceOnlyRoot! },
  });
}

async function writeRelocatedMap(source: string, target: string, path: string): Promise<void> {
  const map = JSON.parse(await readFile(source, "utf8"));
  for (const product of map.products) product.asset_group.path = path;
  await writeFile(target, `${JSON.stringify(map)}\n`);
}

async function readAssetGroupSha256(mapPath: string): Promise<string> {
  const map = JSON.parse(await readFile(mapPath, "utf8")) as {
    products?: Array<{ asset_group?: { sha256?: unknown } }>;
  };
  const hashes = new Set(map.products?.map((product) => product.asset_group?.sha256));
  const [sha256] = hashes;
  if (
    map.products?.length !== 7 || hashes.size !== 1 ||
    typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)
  ) {
    throw new Error("generated product map has no single exact asset-group identity");
  }
  return sha256;
}

function lazyCacheName(scope: string, manifestSha256: string): string {
  return `kandelo-sw:${encodeURIComponent(scope)}:lazy-assets-v1:${manifestSha256}`;
}

async function readVimArchiveIdentity(
  manifestPath: string,
): Promise<{ bytes: number; sha256: string }> {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    assets?: Array<{ bytes?: unknown; path?: unknown; sha256?: unknown }>;
  };
  const matches = manifest.assets?.filter((asset) =>
    asset.path === "assets/programs/wasm32/vim.zip"
  ) ?? [];
  const asset = matches[0];
  if (
    matches.length !== 1 || asset === undefined ||
    !Number.isSafeInteger(asset.bytes) || Number(asset.bytes) <= 0 ||
    typeof asset.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(asset.sha256)
  ) {
    throw new Error("generated VFS group has no exact Vim archive identity");
  }
  return { bytes: Number(asset.bytes), sha256: asset.sha256 };
}

async function waitForShell(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => document.body.innerText), { timeout: 180_000 }).toContain("Ready");
  await expect(page.locator(".xterm-rows").first()).toBeVisible({ timeout: 120_000 });
}

async function runVimVersion(page: Page): Promise<void> {
  // Preserve the complete guest command while keeping the xterm frame visible:
  // Vim's normal version report can scroll the start marker out of the DOM.
  await runTerminalCommand(
    page,
    "vim --version >/tmp/kandelo-vim-version 2>&1 && " +
      "grep -m 1 'VIM - Vi IMproved' /tmp/kandelo-vim-version",
    /VIM - Vi IMproved/,
  );
}

function assertOnlyGroupRequests(server: ScopedStaticServer, prefix: string): void {
  const requests = server.requests().filter((request) => request.pathname.includes("/vfs-groups/"));
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every((request) => request.pathname.startsWith(prefix))).toBe(true);
}

async function corruptCachedVimArchive(page: Page): Promise<{
  corrupt: { bytes: number; sha256: string };
  original: { bytes: number; sha256: string };
}> {
  return page.evaluate(async (cacheName) => {
    const sha256 = async (bytes: Uint8Array): Promise<string> => {
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      return Array.from(
        digest,
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
    };
    const cache = await caches.open(cacheName);
    const request = (await cache.keys()).find((candidate) =>
      new URL(candidate.url).pathname.endsWith("/vim.zip"),
    );
    if (!request) throw new Error("real Vim archive was not cached");
    const response = await cache.match(request);
    if (!response) throw new Error("real Vim archive cache entry disappeared");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0) throw new Error("real Vim archive is empty");
    const original = { bytes: bytes.byteLength, sha256: await sha256(bytes) };
    bytes.fill(0);
    const corrupt = { bytes: bytes.byteLength, sha256: await sha256(bytes) };
    await cache.put(request, new Response(bytes, {
      headers: {
        "Content-Length": String(bytes.byteLength),
        "Content-Type": response.headers.get("content-type") ?? "application/octet-stream",
      },
    }));
    return { corrupt, original };
  }, lazyCacheA);
}

async function cachedVimEntry(page: Page): Promise<CacheEntrySnapshot> {
  const matches = (await readCacheSnapshot(page, lazyCacheA, false)).entries.filter(
    (entry) => new URL(entry.request.url).pathname.endsWith("/vim.zip"),
  );
  if (matches.length !== 1) {
    throw new Error(`expected one cached Vim archive, found ${matches.length}`);
  }
  return matches[0]!;
}

async function runCorruptVimProbe(page: Page) {
  return runTerminalCommand(
    page,
    "vim --version >/tmp/kandelo-corrupt-vim 2>&1; status=$?; " +
      "cat /tmp/kandelo-corrupt-vim; " +
      "if [ \"$status\" -eq 0 ]; then printf VIM_CORRUPT_MATERIALIZED; " +
      "else printf VIM_CORRUPT_REJECTED; fi",
    "VIM_CORRUPT_REJECTED",
  );
}

async function scopes(page: Page) {
  return page.evaluate(async () => ({
    controller: navigator.serviceWorker.controller?.scriptURL ?? null,
    registration: (await navigator.serviceWorker.getRegistration())?.scope ?? null,
    rootRegistration: (await navigator.serviceWorker.getRegistration("/"))?.scope ?? null,
  }));
}

async function seedUnrelatedCache(page: Page): Promise<void> {
  await page.evaluate(async () => (await caches.open("unrelated-site-cache")).put("seed", new Response("seed")));
}

async function installBridgeAuthority(page: Page): Promise<unknown> {
  return page.evaluate(async ({ appPrefix, sessionId }) => {
    const controller = navigator.serviceWorker.controller;
    if (controller === null) {
      throw new Error("service worker does not control candidate deployment");
    }
    const keepAlive = window as typeof window & {
      __scopedDeploymentBridgePorts?: MessagePort[];
    };
    keepAlive.__scopedDeploymentBridgePorts ??= [];
    const bridge = new MessageChannel();
    bridge.port1.start();
    const reply = new MessageChannel();
    const acknowledged = new Promise<unknown>((resolveReply, reject) => {
      const timeout = window.setTimeout(
        () => reject(new Error("timed out installing candidate bridge")),
        5_000,
      );
      reply.port1.onmessage = (event) => {
        window.clearTimeout(timeout);
        resolveReply(event.data);
      };
      reply.port1.start();
    });
    keepAlive.__scopedDeploymentBridgePorts.push(bridge.port1, reply.port1);
    controller.postMessage(
      { type: "init-bridge", appPrefix, sessionId },
      [bridge.port2, reply.port2],
    );
    return acknowledged;
  }, { appPrefix: "/candidate-b/app/", sessionId: SESSION_B });
}

async function cacheNames(page: Page): Promise<string[]> { return page.evaluate(() => caches.keys()); }
async function cachePaths(page: Page, name: string): Promise<string[]> {
  return page.evaluate(async (cacheName) => (await (await caches.open(cacheName)).keys()).map((request) => new URL(request.url).pathname), name);
}
async function durableSnapshot(page: Page) {
  const [serviceWorker, bridgeCache, lazyCache, retrySessionKeys, unrelatedCache] =
    await Promise.all([
      scopes(page),
      readCacheSnapshot(page, CACHE_B, true),
      readCacheSnapshot(page, lazyCacheB, false),
      page.evaluate((prefix) => {
        const entries: Array<{
          key: string;
          storage: "local" | "session";
          value: string | null;
        }> = [];
        for (const storage of [
          ["local", localStorage],
          ["session", sessionStorage],
        ] as const) {
          for (const key of Object.keys(storage[1]).sort()) {
            if (key.startsWith(prefix)) {
              entries.push({
                key,
                storage: storage[0],
                value: storage[1].getItem(key),
              });
            }
          }
        }
        return entries;
      }, STORAGE_B_PREFIX),
      readCacheSnapshot(page, "unrelated-site-cache", true),
    ]);
  return {
    bridgeCache,
    lazyCache,
    retrySessionKeys,
    serviceWorker,
    unrelatedCache,
  };
}

function assertBridgeAuthority(
  snapshot: NamedCacheSnapshot,
  origin: string,
): void {
  expect(snapshot.name).toBe(CACHE_B);
  expect(snapshot.entries).toHaveLength(1);
  const entry = snapshot.entries[0]!;
  expect(entry.request).toMatchObject({
    body: null,
    method: "GET",
    url: `${origin}/candidate-b/bridge-authority-v1`,
  });
  expect(entry.response).toMatchObject({
    headers: expect.arrayContaining([["content-type", "application/json"]]),
    ok: true,
    status: 200,
  });
  const exactBytes = entry.response.body.exactBytes;
  expect(exactBytes).toBeDefined();
  const authority = JSON.parse(
    new TextDecoder().decode(Uint8Array.from(exactBytes!)),
  ) as Record<string, unknown>;
  expect(Object.keys(authority).sort()).toEqual([
    "appPrefix",
    "cookies",
    "revision",
    "sessionId",
    "version",
  ]);
  expect(authority.version).toBe(1);
  expect(
    typeof authority.revision === "number" &&
      Number.isSafeInteger(authority.revision) && authority.revision >= 1,
  ).toBe(true);
  expect(typeof authority.sessionId).toBe("string");
  expect(authority.sessionId).toBe(SESSION_B);
  expect(authority.sessionId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  expect(authority.appPrefix).toBe("/candidate-b/app/");
  expect(Array.isArray(authority.cookies)).toBe(true);
  for (const value of authority.cookies as unknown[]) {
    expect(value !== null && typeof value === "object").toBe(true);
    const cookie = value as Record<string, unknown>;
    expect(Object.keys(cookie).sort()).toEqual(
      cookie.expires === undefined
        ? ["name", "path", "value"]
        : ["expires", "name", "path", "value"],
    );
    expect(typeof cookie.name).toBe("string");
    expect(cookie.name).toMatch(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/);
    expect(new TextEncoder().encode(String(cookie.name)).byteLength)
      .toBeLessThanOrEqual(256);
    expect(typeof cookie.value).toBe("string");
    expect(String(cookie.value)).not.toMatch(/[\u0000-\u001f\u007f;]/);
    expect(new TextEncoder().encode(String(cookie.value)).byteLength)
      .toBeLessThanOrEqual(4_096);
    expect(typeof cookie.path).toBe("string");
    expect(cookie.path).toMatch(/^\/candidate-b\/app\//);
    expect(String(cookie.path)).not.toMatch(/[\u0000-\u001f\u007f;]/);
    expect(new TextEncoder().encode(String(cookie.path)).byteLength)
      .toBeLessThanOrEqual(4_096);
    if (cookie.expires !== undefined) {
      expect(
        typeof cookie.expires === "number" && Number.isFinite(cookie.expires),
      ).toBe(true);
    }
  }
}

async function readCacheSnapshot(
  page: Page,
  cacheName: string,
  includeExactBytes: boolean,
): Promise<NamedCacheSnapshot> {
  return page.evaluate(async ({ includeExactBytes, name }) => {
    if (!(await caches.keys()).includes(name)) {
      throw new Error(`cache ${name} does not exist`);
    }
    const cache = await caches.open(name);
    const entries = await Promise.all((await cache.keys()).map(async (request) => {
      const response = await cache.match(request);
      if (response === undefined) {
        throw new Error(`cache entry ${request.url} disappeared during snapshot`);
      }
      const bytes = new Uint8Array(await response.clone().arrayBuffer());
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      const sha256 = Array.from(
        digest,
        (byte) => byte.toString(16).padStart(2, "0"),
      ).join("");
      return {
        request: {
          body: null,
          cache: request.cache,
          credentials: request.credentials,
          destination: request.destination,
          headers: Array.from(request.headers.entries()).sort(),
          integrity: request.integrity,
          keepalive: request.keepalive,
          method: request.method,
          mode: request.mode,
          redirect: request.redirect,
          referrer: request.referrer,
          referrerPolicy: request.referrerPolicy,
          url: request.url,
        },
        response: {
          body: {
            bytes: bytes.byteLength,
            ...(includeExactBytes ? { exactBytes: Array.from(bytes) } : {}),
            sha256,
          },
          headers: Array.from(response.headers.entries()).sort(),
          ok: response.ok,
          redirected: response.redirected,
          status: response.status,
          statusText: response.statusText,
          type: response.type,
          url: response.url,
        },
      };
    }));
    entries.sort((left, right) =>
      left.request.url.localeCompare(right.request.url) ||
      left.request.method.localeCompare(right.request.method)
    );
    return { entries, name };
  }, { includeExactBytes, name: cacheName });
}
async function stopWorker(context: BrowserContext, page: Page, scriptURL: string): Promise<void> {
  const cdp = await context.newCDPSession(page);
  try {
    const versionId = await new Promise<string>((resolveVersion, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`timed out finding ${scriptURL}`)),
        10_000,
      );
      cdp.on("ServiceWorker.workerVersionUpdated", (event) => {
        const version = (event.versions ?? []).find((entry: {
          runningStatus?: string;
          scriptURL?: string;
          versionId: string;
        }) => entry.runningStatus === "running" && entry.scriptURL === scriptURL);
        if (!version) return;
        clearTimeout(timeout);
        resolveVersion(String(version.versionId));
      });
      void cdp.send("ServiceWorker.enable").catch(reject);
    });
    await cdp.send("ServiceWorker.stopWorker", { versionId });
  } finally { await cdp.detach(); }
}
