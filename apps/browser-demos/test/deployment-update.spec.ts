/**
 * The first reload after a deployment update boots the new deployment.
 *
 * A visitor's tab runs deployment A under A's service worker. The site is
 * replaced with deployment B and the visitor reloads. That navigation is
 * answered by A's worker; the browser fetches B's `service-worker.js` while
 * it runs, and B's worker takes control afterwards. These tests delay that
 * fetch (the network time to an edge) so the page boots inside the window,
 * and require the reload to reach a ready shell under B's worker:
 *
 * - "group changed": B rebuilt the VFS asset group. Under a fixed group
 *   address, A's worker answered B's page with A's cached manifest and the
 *   boot failed its integrity check (Chromium and WebKit with latency,
 *   Firefox even without).
 * - "app only": B changed only application code. Chromium created the image
 *   composer worker during the takeover and never started it; the boot hung
 *   at "Loading" with no error.
 *
 * Every deployment here is a real production build of this tree (SourceOnly
 * artifacts, the authenticated VFS group, `vite build`), served at one scope
 * by the scoped test server. See docs/browser-support.md, "Deployment
 * updates".
 */
import { expect, test, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { buildLocalVfsAssetGroup } from "../../../scripts/build-local-vfs-asset-group";
import { startScopedStaticServer, type ScopedStaticServer } from "./support/scoped-static-server";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const sourceOnlyRoot = process.env.KANDELO_SCOPED_DEPLOYMENT_SOURCE_ONLY_ROOT;
/** Network time to the edge for the browser's service-worker update fetch. */
const UPDATE_LATENCY_MS = 1_500;

let fixtureRoot: string;
let server: ScopedStaticServer;
let deploymentA: string;
let deploymentGroupChanged: string;
let deploymentAppOnly: string;

test.describe.serial("the first reload after a deployment update", () => {
  test.skip(
    sourceOnlyRoot === undefined,
    "requires KANDELO_SCOPED_DEPLOYMENT_SOURCE_ONLY_ROOT with real SourceOnly artifacts",
  );
  test.setTimeout(8 * 60_000);

  test.beforeAll(async () => {
    test.setTimeout(12 * 60_000);
    fixtureRoot = await realpath(await mkdtemp(join(tmpdir(), "kandelo-deployment-update-")));
    for (const name of ["a", "unused"]) await mkdir(join(fixtureRoot, name));
    // Builds name the preview and app origins, so the server listens first.
    server = await startScopedStaticServer({
      aRoot: join(fixtureRoot, "a"),
      candidateBRoot: join(fixtureRoot, "unused"),
    });
    const groupA = join(fixtureRoot, "group-a", "vfs-group");
    const mapA = join(fixtureRoot, "group-a", "pages-vfs-products.private.json");
    await withSourceOnlyEnvironment(() => buildLocalVfsAssetGroup({
      assetGroupDirectory: groupA,
      productMapPath: mapA,
      sourceRoot: repoRoot,
    }));
    const groupB = join(fixtureRoot, "group-b", "vfs-group");
    const mapB = join(fixtureRoot, "group-b", "pages-vfs-products.private.json");
    await rebuildGroupWithNewManifest(groupA, mapA, groupB, mapB);

    deploymentA = join(fixtureRoot, "deployment-a");
    deploymentGroupChanged = join(fixtureRoot, "deployment-b-group");
    deploymentAppOnly = join(fixtureRoot, "deployment-b-app");
    await buildVite(deploymentA, mapA, groupA, {});
    await buildVite(deploymentGroupChanged, mapB, groupB, {});
    // Application code only: a different CORS proxy route changes the page
    // chunks and the service worker, and nothing in the VFS group.
    await buildVite(deploymentAppOnly, mapA, groupA, {
      VITE_CORS_PROXY_URL: "/cors-proxy-b?url=",
    });
  });

  test.afterAll(async () => {
    await server?.close();
    if (fixtureRoot) await rm(fixtureRoot, { force: true, recursive: true });
  });

  for (const variant of ["group changed", "app only"] as const) {
    test(`boots the new deployment when ${variant} and the worker update is slow`, async ({ browser }) => {
      const next = variant === "group changed" ? deploymentGroupChanged : deploymentAppOnly;
      await server.replaceRoot("a", deploymentA);
      server.setServiceWorkerUpdateDelay(0);
      const context = await browser.newContext();
      // The page's console, kept for the failure report: a boot that hangs
      // says where only there.
      const consoleLines: string[] = [];
      const started = Date.now();
      // KANDELO_DEPLOYMENT_UPDATE_TRACE=1 also prints every line as it
      // happens, with the page's requests and (Chromium) worker versions.
      const trace = process.env.KANDELO_DEPLOYMENT_UPDATE_TRACE === "1";
      const note = (line: string, traceOnly = false) => {
        const entry = `[${((Date.now() - started) / 1000).toFixed(1)}s] ${line}`.slice(0, 400);
        if (!traceOnly) consoleLines.push(entry);
        if (trace) console.log(entry);
      };
      try {
        const page = await context.newPage();
        // Service-worker lifecycle as the page sees it, for the failure report.
        await page.addInitScript(() => {
          const start = performance.now();
          const log = (message: string) =>
            console.log(`[swprobe ${(performance.now() - start).toFixed(0)}ms] ${message}`);
          const container = navigator.serviceWorker;
          if (!container) return;
          log(`load controller=${container.controller?.scriptURL ?? "none"}`);
          container.addEventListener("controllerchange", () => log("controllerchange"));
          void container.getRegistration().then((registration) => {
            if (!registration) return;
            const watch = (worker: ServiceWorker | null, name: string) =>
              worker?.addEventListener("statechange", () => log(`${name} -> ${worker.state}`));
            watch(registration.installing, "installing");
            watch(registration.waiting, "waiting");
            registration.addEventListener("updatefound", () => {
              log("updatefound");
              watch(registration.installing, "new worker");
            });
          });
          addEventListener("beforeunload", () => log("beforeunload"));
        });
        page.on("console", (message) => note(`${message.type()}: ${message.text()}`));
        page.on("pageerror", (error) => note(`pageerror: ${String(error)}`));
        if (trace && test.info().project.name === "chromium") {
          // Service-worker versions as the browser sees them.
          const session = await context.newCDPSession(page);
          session.on("ServiceWorker.workerVersionUpdated", ({ versions }) => {
            for (const version of versions) {
              note(`sw version ${version.versionId} ${version.status} ${version.runningStatus} ` +
                `clients=${(version.controlledClients ?? []).length}`);
            }
          });
          session.on("ServiceWorker.workerErrorReported", ({ errorMessage }) => {
            note(`sw error ${errorMessage.errorMessage} ${errorMessage.sourceURL}:${errorMessage.lineNumber}`);
          });
          await session.send("ServiceWorker.enable");
        }
        if (trace) {
          const shortUrl = (url: string) => url.replace(server.origin, "").slice(0, 120);
          page.on("request", (request) => note(`request ${request.method()} ${shortUrl(request.url())}`, true));
          page.on("requestfinished", (request) => note(`finished ${shortUrl(request.url())}`, true));
          page.on("requestfailed", (request) =>
            note(`failed ${shortUrl(request.url())} ${request.failure()?.errorText}`, true));
          page.on("worker", (worker) => note(`worker ${shortUrl(worker.url())}`, true));
        }
        page.on("framenavigated", (frame) => {
          if (frame === page.mainFrame()) note(`navigated ${frame.url()}`);
        });
        const step = async (label: string) => {
          const outcome = await bootOutcome(page);
          note(`${label}: ${outcome}`);
          if (outcome !== "ready") {
            console.log(consoleLines.slice(-80).join("\n"));
            console.log(await failureDiagnostics(page));
          }
          expect(outcome, label).toBe("ready");
        };
        await page.goto(`${server.origin}/a/`, { waitUntil: "domcontentloaded" });
        await step("first visit to A");
        // Settle: one full navigation controlled by A's worker from the start,
        // with A's manifest and shell image in its lazy cache.
        await page.reload({ waitUntil: "domcontentloaded" });
        await step("reload under A");
        const before = await buildIds(page);

        await server.replaceRoot("a", next);
        server.setServiceWorkerUpdateDelay(UPDATE_LATENCY_MS);
        server.clearRequests();
        let navigations = 0;
        page.on("framenavigated", (frame) => {
          if (frame === page.mainFrame()) navigations++;
        });
        await page.reload({ waitUntil: "domcontentloaded" });
        await step("first reload after the deploy");
        // No reload of its own: with the new deployment served correctly, the
        // page reaches its worker without the single mismatch reload.
        expect(navigations).toBe(1);
        const after = await buildIds(page);
        expect(after.page).not.toBe(before.page);
        expect(after.worker).toBe(after.page);

        server.setServiceWorkerUpdateDelay(0);
        await page.reload({ waitUntil: "domcontentloaded" });
        await step("second reload after the deploy");
        expect(await buildIds(page)).toEqual(after);
      } finally {
        await context.close();
      }
    });
  }
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

/**
 * A second group as a rebuilt image set produces it: the same images and
 * assets under a manifest with other bytes (one more trailing newline, still
 * the same JSON), so its digest differs. The private map follows the group
 * the way the group builder writes it: a group address that names the
 * manifest digest names the new one; a fixed address stays as it was.
 */
async function rebuildGroupWithNewManifest(
  groupA: string,
  mapA: string,
  groupB: string,
  mapB: string,
): Promise<void> {
  await mkdir(dirname(groupB), { recursive: true });
  // Clone where the filesystem can (the group is most of a gigabyte).
  await cp(groupA, groupB, { recursive: true, mode: constants.COPYFILE_FICLONE });
  const manifestA = await readFile(join(groupA, "manifest.json"));
  const manifestB = Buffer.concat([manifestA, Buffer.from("\n")]);
  await writeFile(join(groupB, "manifest.json"), manifestB);
  const digestA = sha256(manifestA);
  const digestB = sha256(manifestB);
  const map = JSON.parse(await readFile(mapA, "utf8")) as {
    products: Array<{
      asset_group: { bytes: number; path: string; sha256: string };
      private_path: string;
    }>;
  };
  for (const product of map.products) {
    product.asset_group = {
      bytes: manifestB.byteLength,
      path: product.asset_group.path.split(digestA).join(digestB),
      sha256: digestB,
    };
    product.private_path = product.private_path.replace(groupA, groupB);
  }
  await writeFile(mapB, canonicalJson(map));
}

async function buildVite(
  outDir: string,
  map: string,
  group: string,
  extraEnvironment: Record<string, string>,
): Promise<void> {
  await execFileAsync("npm", ["--prefix", "apps/browser-demos", "run", "build", "--", "--outDir", outDir], {
    cwd: repoRoot,
    env: {
      ...process.env,
      KANDELO_PAGES_PRODUCT_MAP: map,
      KANDELO_PAGES_VFS_ASSET_GROUP_DIR: group,
      VITE_BASE: "/a/",
      WASM_POSIX_RESOLUTION_POLICY: "source-only-v1",
      WASM_POSIX_SOURCE_ONLY_BINARY_ROOT: sourceOnlyRoot!,
      KANDELO_PREVIEW_ORIGIN: server.previewOrigin,
      KANDELO_APP_ORIGIN: server.origin,
      ...extraEnvironment,
    },
    maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * "ready" once the shell reports Ready with a terminal, or the boot error the
 * page shows. A boot that neither finishes nor fails within the budget is
 * the hang this suite exists to catch.
 */
async function bootOutcome(page: Page, timeoutMs = 120_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  // A page whose navigation is stuck never answers evaluate(); bound every
  // look so the budget holds.
  const bounded = <T>(work: Promise<T>, fallback: T): Promise<T> =>
    Promise.race([work, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), 5_000))]);
  while (Date.now() < deadline) {
    try {
      if (await bounded(page.locator("aside.kdemo").count(), -1) === 0) {
        const guide = page.getByRole("button", { name: "Demo guide" });
        if (await bounded(guide.count(), 0) > 0) await guide.click({ timeout: 2_000 });
      }
      const status = await page.locator("aside.kdemo .kdemo-status")
        .textContent({ timeout: 1_000 }).catch(() => null);
      if (status === "Ready" && await bounded(page.locator(".xterm-rows").count(), 0) > 0) {
        return "ready";
      }
      const body = await bounded(
        page.evaluate(() => document.body.innerText).catch(() => ""),
        "",
      );
      // The failure's line and the reason under it.
      const failure = /[^\n]*(setup failed|did not start within|Kandelo build|could not enable cross-origin)[^\n]*(\n[^\n]*)?/i
        .exec(body);
      if (failure !== null) return `boot failed: ${failure[0].replace(/\s+/g, " ")}`;
    } catch {
      // The page may be navigating (a designed reload); look again.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const status = await page.locator("aside.kdemo .kdemo-status")
    .textContent({ timeout: 2_000 }).catch(() => null);
  return `no outcome within ${timeoutMs / 1000} s (status: ${status ?? "none"}, url: ${page.url()})`;
}

/** What a stuck boot was doing: the page, its workers and the server's log. */
async function failureDiagnostics(page: Page): Promise<string> {
  const settle = <T>(work: Promise<T>, fallback: T): Promise<T> =>
    Promise.race([
      work.catch(() => fallback),
      new Promise<T>((resolve) => setTimeout(() => resolve(fallback), 5_000)),
    ]);
  const state = await settle(page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return {
      readyState: document.readyState,
      controller: navigator.serviceWorker.controller?.scriptURL ?? null,
      registration: registration === undefined ? null : {
        active: registration.active?.state ?? null,
        installing: registration.installing?.state ?? null,
        waiting: registration.waiting?.state ?? null,
      },
      body: document.body?.innerText.slice(0, 600) ?? null,
    };
  }), "page did not answer evaluate()" as unknown);
  let targets: unknown = null;
  if (page.context().browser()?.browserType().name() === "chromium") {
    targets = await settle((async () => {
      const session = await page.context().newCDPSession(page);
      const { targetInfos } = await session.send("Target.getTargets");
      return targetInfos.map((target) =>
        `${target.type} ${target.url} attached=${target.attached}`);
    })(), "no CDP answer" as unknown);
  }
  const requests = server.requests().map((request) =>
    `${request.status} ${request.method} ${request.pathname}`);
  return JSON.stringify({ state, targets, workers: page.workers().map((worker) => worker.url()), requests }, null, 1);
}

/** The page's build id and the id its controlling service worker reports. */
async function buildIds(page: Page): Promise<{ page: string | null; worker: string | null }> {
  return page.evaluate(async () => {
    const pageId = document.querySelector('meta[name="kandelo-build-id"]')
      ?.getAttribute("content") ?? null;
    // Answered by the controlling worker (lib/init/service-worker-bridge.ts).
    const response = await fetch("__kandelo_build_id", { cache: "no-store" }).catch(() => null);
    const data = response?.ok ? await response.json().catch(() => null) : null;
    return { page: pageId, worker: typeof data?.buildId === "string" ? data.buildId : null };
  });
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The private map's encoding: sorted keys, one trailing newline. */
function canonicalJson(value: unknown): string {
  const normalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(normalize);
    if (candidate !== null && typeof candidate === "object") {
      return Object.fromEntries(
        Object.entries(candidate)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, child]) => [key, normalize(child)]),
      );
    }
    return candidate;
  };
  return `${JSON.stringify(normalize(value))}\n`;
}
