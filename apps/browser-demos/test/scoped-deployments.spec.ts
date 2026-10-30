import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { tmpdir } from "node:os";

import { buildLocalVfsAssetGroup } from "../../../scripts/build-local-vfs-asset-group";
import { loadVfsProductDeploymentMap } from "../../../scripts/vfs-product-deployment";
import { runTerminalCommand } from "./support/terminal-command";
import { PREVIEW_PROTOCOL_VERSION } from "../lib/preview/protocol";
import { startScopedStaticServer, type ScopedStaticServer } from "./support/scoped-static-server";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const sourceOnlyRoot = process.env.KANDELO_SCOPED_DEPLOYMENT_SOURCE_ONLY_ROOT;
const STORAGE_B_PREFIX = "kandelo:%2Fcandidate-b%2F:";

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
    // This hook builds three full production sites and validates a fourth.
    // Give setup the same bounded budget as the deployment test itself.
    test.setTimeout(12 * 60_000);
    fixtureRoot = await realpath(
      await mkdtemp(join(tmpdir(), "kandelo-scoped-deployments-")),
    );
    const group = join(fixtureRoot, "vfs-group");
    const map = join(fixtureRoot, "pages-vfs-products.private.json");
    // The server comes first: each build names its guest preview origin and
    // its own app origin, so both must be listening addresses already.
    for (const name of ["a", "candidate-b"]) await mkdir(join(fixtureRoot, name));
    server = await startScopedStaticServer({
      aRoot: join(fixtureRoot, "a"),
      candidateBRoot: join(fixtureRoot, "candidate-b"),
    });
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

  test("keeps real sibling shells, workers, VFS groups, and restart state isolated", async ({ browser, browserName }) => {
    const context = await browser.newContext();
    try {
      const pageA = await context.newPage();
      const pageB = await context.newPage();
      await pageA.goto(`${server.origin}/a/`, { waitUntil: "domcontentloaded" });
      await pageB.goto(`${server.origin}/candidate-b/`, { waitUntil: "domcontentloaded" });
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
      // The service worker writes each lazy cache entry while the page
      // reads the download, so an entry can land just after the page is done.
      await expect.poll(() => cacheNames(pageA)).toEqual(expect.arrayContaining([
        lazyCacheA, lazyCacheB, "unrelated-site-cache",
      ]));
      await expect.poll(() => cachePaths(pageA, lazyCacheA)).toEqual(expect.arrayContaining([expect.stringMatching(/^\/a\/vfs-groups\//)]));
      expect(await cachePaths(pageA, lazyCacheA)).not.toEqual(expect.arrayContaining([expect.stringMatching(/^\/candidate-b\//)]));
      await expect.poll(() => cachePaths(pageB, lazyCacheB)).toEqual(expect.arrayContaining([expect.stringMatching(/^\/candidate-b\/vfs-groups\//)]));
      expect(await cachePaths(pageB, lazyCacheB)).not.toEqual(expect.arrayContaining([expect.stringMatching(/^\/a\//)]));
      const corrupted = await corruptCachedVimArchive(pageA);
      expect(corrupted.original).toEqual(vimArchiveIdentity);
      expect(corrupted.corrupt.bytes).toBe(vimArchiveIdentity.bytes);
      expect(corrupted.corrupt.sha256).not.toBe(vimArchiveIdentity.sha256);
      await pageA.reload({ waitUntil: "domcontentloaded" });
      await waitForShell(pageA);
      const corruptCacheBefore = await cachedVimEntry(pageA);
      // Rust reports integrity rejection through the guest's EIO path. The
      // legacy TypeScript decoder's SHA console message is not that contract:
      // assert both real executions fail and preserve the exact corrupt cache.
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
      expect(server.requests().filter((request) =>
        request.pathname.endsWith("/vim.zip")
      )).toEqual([]);

      // Each deployment's guest preview bundle is served by the preview
      // origin at that deployment's own scope, and accepts only the app.
      for (const scope of ["/a/", "/candidate-b/"]) {
        const relay = await fetch(`${server.previewOrigin}${scope}__kandelo_preview/relay.js`);
        expect(relay.status).toBe(200);
        expect(relay.headers.get("cross-origin-resource-policy")).toBe("cross-origin");
        expect(await relay.text()).toContain(`"kandeloOrigins":["${server.origin}"]`);
        const worker = await fetch(`${server.previewOrigin}${scope}preview-service-worker.js`);
        expect(worker.status).toBe(200);
      }
      // A computer/ address on the app origin is the viewer shell. Its relay
      // registers the preview worker at this deployment's scope; with no
      // owning tab, the machine reports offline instead of loading anything.
      const viewer = await context.newPage();
      await viewer.goto(`${server.origin}/candidate-b/computer/able-amber-acorn-lfd5pqz5pa7zjm5uyguw/`, { waitUntil: "domcontentloaded" });
      await expect(viewer.locator(".kviewer-status")).toContainText("no longer running", { timeout: 60_000 });
      expect(viewer.frames().map((frame) => frame.url())).toContain(
        `${server.previewOrigin}/candidate-b/__kandelo_preview/relay.html`,
      );
      await viewer.close();

      // Sibling scopes share the preview origin but not their machines: a
      // machine bound through /a/'s relay lives in /a/'s preview worker.
      // The same name under /candidate-b/ is a different, unknown machine,
      // and no request for it reaches /a/'s owner.
      // The name commits to this secret (lib/preview/protocol.ts).
      const machine = "quiet-sage-heron-jotivkdwppphf2ghtdxi";
      await bindDeployedMachine(pageA, server.previewOrigin, "/a/", machine, "fedcba9876543210fedcba9876543210");
      const ownFrame = await openPreviewFrame(pageA, `${server.previewOrigin}/a/computer/${machine}/`);
      expect(await ownFrame.locator("body").textContent()).toBe(`a:GET:/`);
      const siblingFrame = await openPreviewFrame(pageB, `${server.previewOrigin}/candidate-b/computer/${machine}/`);
      await expect(siblingFrame.locator("body")).toContainText("This Kandelo computer is offline", { timeout: 30_000 });
      expect(await pageA.evaluate(() => (window as any).__scopedMachineRequests)).toEqual(["GET /"]);
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
        lazyCache: { name: lazyCacheB, entries: expect.any(Array) },
        retrySessionKeys: expect.any(Array),
        unrelatedCache: {
          name: "unrelated-site-cache",
          entries: expect.any(Array),
        },
      });
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
      if (browserName === "chromium") {
        await stopWorker(context, pageA, `${server.origin}/a/service-worker.js`);
      } else {
        // Only Chromium exposes a hard-stop API. A real script update also
        // replaces the worker realm without disrupting the sibling scope.
        await replaceScopedWorker(pageA, "restart");
      }
      await pageA.reload({ waitUntil: "domcontentloaded" });
      await waitForShell(pageA);
      await runTerminalCommand(pageA, "printf restart-a-ok", "restart-a-ok");
      await runTerminalCommand(pageB, "printf restart-b-ok", "restart-b-ok");
      await expect(durableSnapshot(pageB)).resolves.toEqual(candidateBeforeRestart);

      const candidateBeforeUpdate = await durableSnapshot(pageB);
      await replaceScopedWorker(pageA, "update");
      await pageA.reload({ waitUntil: "domcontentloaded" });
      await waitForShell(pageA);
      await runTerminalCommand(pageA, "printf update-a-ok", "update-a-ok");
      await runTerminalCommand(pageB, "printf update-b-ok", "update-b-ok");
      await expect(durableSnapshot(pageB)).resolves.toEqual(candidateBeforeUpdate);

      await server.replaceRoot("a", join(fixtureRoot, "a-relocated"));
      const relocated = await context.newPage();
      await relocated.goto(`${server.origin}/a/`, { waitUntil: "domcontentloaded" });
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

/**
 * Bind `name` in the preview worker of the deployment at `scope`, through
 * that deployment's real relay, from its real Kandelo page. The machine
 * answers `a:<method>:<path>`.
 */
async function bindDeployedMachine(
  page: Page,
  previewOrigin: string,
  scope: string,
  name: string,
  secret: string,
): Promise<void> {
  const result = await page.evaluate(async ({ previewOrigin, scope, name, secret, v }) => {
    const relay = document.createElement("iframe");
    relay.setAttribute("sandbox", "allow-scripts allow-same-origin");
    relay.referrerPolicy = "origin";
    relay.hidden = true;
    relay.src = `${previewOrigin}${scope}__kandelo_preview/relay.html`;
    const requests: string[] = [];
    (window as any).__scopedMachineRequests = requests;
    const channel = new MessageChannel();
    (window as any).__scopedMachinePort = channel.port1;
    channel.port1.onmessage = (event) => {
      const request = event.data;
      if (request.type !== "http-request") return;
      requests.push(`${request.method} ${request.url}`);
      const body = new TextEncoder().encode(`a:${request.method}:${request.url}`).buffer;
      channel.port1.postMessage({
        type: "http-response", v, id: request.id, status: 200,
        headers: [["content-type", "text/plain"]], body,
      }, [body]);
    };
    return new Promise<string>((resolve) => {
      const timer = setTimeout(() => resolve("no answer"), 30_000);
      window.addEventListener("message", (event) => {
        if (event.source !== relay.contentWindow) return;
        const message = event.data;
        if (message.type === "preview-relay-ready") {
          relay.contentWindow!.postMessage({ type: "preview-bridge", v, name, secret, seq: 1 }, previewOrigin, [channel.port2]);
        } else if ((message.type === "preview-bridge-ready" || message.type === "preview-bridge-refused") && message.name === name) {
          clearTimeout(timer);
          resolve(message.type === "preview-bridge-ready" ? "ready" : message.code);
        }
      });
      document.body.append(relay);
    });
  }, { previewOrigin, scope, name, secret, v: PREVIEW_PROTOCOL_VERSION });
  expect(result).toBe("ready");
}

async function openPreviewFrame(page: Page, url: string) {
  const frameName = `scoped-preview-${Math.random().toString(16).slice(2)}`;
  await page.evaluate(({ url, frameName }) => new Promise<void>((resolve) => {
    const frame = document.createElement("iframe");
    frame.name = frameName;
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
    frame.onload = () => resolve();
    frame.src = url;
    document.body.append(frame);
  }), { url, frameName });
  const frame = page.frames().find((candidate) => candidate.name() === frameName);
  if (!frame) throw new Error(`no preview frame for ${url}`);
  return frame;
}

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
    env: { ...process.env, KANDELO_PAGES_PRODUCT_MAP: map, KANDELO_PAGES_VFS_ASSET_GROUP_DIR: group, VITE_BASE: base, WASM_POSIX_RESOLUTION_POLICY: "source-only-v1", WASM_POSIX_SOURCE_ONLY_BINARY_ROOT: sourceOnlyRoot!,
      KANDELO_PREVIEW_ORIGIN: server.previewOrigin, KANDELO_APP_ORIGIN: server.origin },
  });
}

async function writeRelocatedMap(source: string, target: string, path: string): Promise<void> {
  const map = JSON.parse(await readFile(source, "utf8"));
  for (const product of map.products) product.asset_group.path = path;
  await writeFile(target, `${JSON.stringify(map)}\n`);
}

async function readAssetGroupSha256(mapPath: string): Promise<string> {
  // The registered product set owns completeness; an image added to it must
  // participate in the same authenticated group without a second count here.
  const map = loadVfsProductDeploymentMap({ mapPath, sourceRoot: repoRoot });
  const hashes = new Set(map.products.map((product) => product.asset_group?.sha256));
  const [sha256] = hashes;
  if (
    hashes.size !== 1 ||
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
  // The readiness status belongs to the demo guide, which starts closed.
  // Open it before observing readiness; a running shell alone does not render it.
  if (await page.locator("aside.kdemo").count() === 0) {
    await page.getByRole("button", { name: "Demo guide" }).click({
      timeout: 120_000,
    });
  }
  await expect(page.locator("aside.kdemo .kdemo-status")).toHaveText("Ready", {
    timeout: 180_000,
  });
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

async function cacheNames(page: Page): Promise<string[]> { return page.evaluate(() => caches.keys()); }
async function cachePaths(page: Page, name: string): Promise<string[]> {
  return page.evaluate(async (cacheName) => (await (await caches.open(cacheName)).keys()).map((request) => new URL(request.url).pathname), name);
}
async function durableSnapshot(page: Page) {
  const [serviceWorker, lazyCache, retrySessionKeys, unrelatedCache] =
    await Promise.all([
      scopes(page),
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
    lazyCache,
    retrySessionKeys,
    serviceWorker,
    unrelatedCache,
  };
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
async function replaceScopedWorker(page: Page, revision: string): Promise<void> {
  const script = join(fixtureRoot, "a", "service-worker.js");
  await writeFile(script, `${await readFile(script, "utf8")}\n// scoped test ${revision}\n`);
  await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration("/a/");
    const previous = navigator.serviceWorker.controller;
    if (!registration || !previous) throw new Error("deployment A has no active worker");
    await new Promise<void>((resolveReplacement, reject) => {
      const timeout = window.setTimeout(() => {
        navigator.serviceWorker.removeEventListener("controllerchange", onChange);
        reject(new Error("timed out replacing deployment A's worker"));
      }, 30_000);
      function onChange() {
        if (navigator.serviceWorker.controller === previous) return;
        window.clearTimeout(timeout);
        navigator.serviceWorker.removeEventListener("controllerchange", onChange);
        resolveReplacement();
      }
      navigator.serviceWorker.addEventListener("controllerchange", onChange);
      void registration.update().catch((error) => {
        window.clearTimeout(timeout);
        navigator.serviceWorker.removeEventListener("controllerchange", onChange);
        reject(error);
      });
    });
  });
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
