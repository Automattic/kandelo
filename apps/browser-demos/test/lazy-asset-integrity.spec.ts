import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer, type ViteDevServer } from "vite";
import { expect, test } from "../playwright-test";
import type { HostDiagnostic } from "../../../host/src/host-diagnostic";
import type { LazyDownloadEvent } from "../../../host/src/vfs/lazy-download-event";
import { resolveBinary } from "../../../host/src/binary-resolver";
import { KandeloImageFs } from "../../../images/vfs/lib/kandelo-image-fs";

// A real same-origin server is necessary: page.route does not intercept the
// service worker's network fetch, and mocking fetch would miss CacheStorage.
const port = Number(process.env.KANDELO_LAZY_INTEGRITY_PORT ?? 0);
let origin: string;
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(appRoot, "../..");
const assetPath = "/vfs-groups/integrity-regression/assets/font.bin";
const good = Buffer.from("verified synthetic font payload");
const bad = Buffer.from(good);
bad[0] ^= 0xff;
let served = bad;
let requests = 0;
let server: Server;
let vite: ViteDevServer;
let cacheDir: string;
let image: Uint8Array;
let kernelBytes: Buffer;

test.beforeAll(async () => {
  const writer = readFileSync(process.env.KANDELO_LAZY_INTEGRITY_IMAGE_MODULE ??
    join(repoRoot, "local-binaries/kandelo_image_module32.wasm"));
  kernelBytes = readFileSync(process.env.KANDELO_LAZY_INTEGRITY_KERNEL ?? resolveBinary("kernel.wasm"));
  cacheDir = mkdtempSync(join(tmpdir(), "kandelo-lazy-integrity-vite-"));
  vite = await createViteServer({ configFile: false, root: appRoot, cacheDir,
    optimizeDeps: { entries: ["test/lazy-download-summary-browser.ts"] },
    server: { middlewareMode: true, hmr: false, fs: { allow: [repoRoot] } },
  });
  server = createServer((request, response) => {
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    response.setHeader("Cache-Control", "no-store");
    const pathname = new URL(request.url ?? "/", origin).pathname;
    if (pathname === assetPath || pathname === "/fixture-kernel.wasm" || pathname === "/fixture-image.vfs") {
      if (pathname === assetPath) requests++;
      const bytes = pathname === assetPath ? served : pathname === "/fixture-kernel.wasm" ? kernelBytes : image;
      response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": bytes.length });
      response.end(bytes);
      return;
    }
    vite.middlewares(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("lazy integrity fixture has no TCP address");
  origin = `http://127.0.0.1:${address.port}`;
  const fs = KandeloImageFs.create(writer);
  fs.registerLazyFile("/font", `${origin}${assetPath}`, good.length, 0o644,
    createHash("sha256").update(good).digest("hex"));
  image = await fs.saveImage();
});

test.afterAll(async () => {
  if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (vite) await vite.close();
  if (cacheDir) rmSync(cacheDir, { recursive: true, force: true });
});

test("a stale SW-cached lazy body is refused by native VFS and stays visibly failed until a verified reload", async ({ page, browser }, testInfo) => {
  test.setTimeout(120_000);
  requests = 0; served = bad;
  await page.goto(`${origin}/terminate-atomics-test.html`);
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("/service-worker.js", { scope: "/" });
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) await new Promise<void>(resolve =>
      navigator.serviceWorker.addEventListener("controllerchange", () => resolve(), { once: true }));
  });
  const seeded = await page.evaluate(async path => Array.from(new Uint8Array(await (await fetch(path)).arrayBuffer())), assetPath);
  expect(seeded).toEqual(Array.from(bad));
  expect(requests).toBe(1);
  // The origin is repaired, but an ordinary fetch must still prove that the
  // worker really cached the old body before the kernel rejects that body.
  served = good;
  const cached = await page.evaluate(async path => Array.from(new Uint8Array(await (await fetch(path)).arrayBuffer())), assetPath);
  expect(cached).toEqual(Array.from(bad));
  expect(requests).toBe(1);
  await page.evaluate(async (moduleUrl) => {
    const [{ BrowserKernel }, { LiveKernelHost, mountLazyDownloadToasts }] = await Promise.all([
      import(moduleUrl),
      import("/test/lazy-download-summary-browser.ts"),
    ]);
    const host = new LiveKernelHost();
    const diagnostics: unknown[] = [];
    const kernel = new BrowserKernel({ kernelOwnedFs: true,
      onLazyDownload: (event: LazyDownloadEvent) => host.emitLazyDownloadEvent(event),
      onHostDiagnostic: (diagnostic: HostDiagnostic) => diagnostics.push(diagnostic),
    });
    const fixture = (window as any).__nativeLazy = { host, kernel, diagnostics,
      unmount: mountLazyDownloadToasts(host) };
    await kernel.initFromImage({ kernelWasm: await (await fetch("/fixture-kernel.wasm")).arrayBuffer(),
      vfsImage: new Uint8Array(await (await fetch("/fixture-image.vfs")).arrayBuffer()) });
    fixture.before = await kernel.statVfsPath("/font");
    try { await kernel.readFileFromVfs("/font"); fixture.accepted = true; }
    catch (error) { fixture.failure = String(error); }
    fixture.after = await kernel.statVfsPath("/font");
  }, `/@fs/${join(repoRoot, "host/src/browser-kernel-host.ts")}`);
  try {
    await expect(page.getByRole("alert")).toContainText("Native VFS rejected");
    const evidence = await page.evaluate(() => {
      const f = (window as any).__nativeLazy;
      return { accepted: f.accepted ?? false, failure: f.failure, before: f.before, after: f.after,
        diagnostics: f.diagnostics, downloads: f.host.lazyDownloadSummaries() };
    });
    Object.assign(evidence, { runtime: { engine: testInfo.project.name, version: browser.version() } });
    expect(evidence.accepted).toBe(false);
    expect(evidence.failure).toBeTruthy();
    expect(evidence.after).toEqual(evidence.before);
    expect(evidence.diagnostics).toContainEqual({ pid: 0, source: "vfs-integrity",
      message: expect.stringMatching(/size or SHA-256 mismatch.*read fails with EIO/) });
    expect(evidence.downloads).toContainEqual(expect.objectContaining({ status: "error", url: `${origin}${assetPath}` }));
    expect(requests, "native rejection must not trigger an automatic fetch retry").toBe(1);
    await page.evaluate(async () => {
      const { mountLazyDownloadToasts } = await import("/test/lazy-download-summary-browser.ts");
      const f = (window as any).__nativeLazy;
      f.unmount(); f.unmount = mountLazyDownloadToasts(f.host);
    });
    await expect(page.getByRole("alert")).toBeVisible();
    await page.clock.install();
    await page.clock.fastForward(6_000);
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCSS("animation-name", "none");
    await expect(page.getByRole("alert")).toHaveCSS("opacity", "1");
    await testInfo.attach("unresolved-native-asset.png", { body: await page.screenshot(), contentType: "image/png" });
    const recovered = await page.evaluate(async () => Array.from(await (window as any).__nativeLazy.kernel.readFileFromVfs("/font")));
    expect(recovered).toEqual(Array.from(good));
    expect(requests).toBe(2);
    await expect(page.getByRole("alert")).toHaveCount(0);
    const finalBody = await page.evaluate(async path => Array.from(new Uint8Array(await (await fetch(path)).arrayBuffer())), assetPath);
    expect(finalBody).toEqual(Array.from(good));
    expect(requests, "the exact scoped cache entry must now contain the verified replacement").toBe(2);
    await testInfo.attach("native-lazy-integrity.json", { body: JSON.stringify(evidence, null, 2), contentType: "application/json" });
  } finally {
    await page.evaluate(async () => { const f = (window as any).__nativeLazy; f.unmount(); await f.kernel.destroy(); });
  }
});
