import { appendFileSync, createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "../playwright-test";
import { resolveBinary } from "../../../host/src/binary-resolver";

const imagePath = process.env.KANDELO_WORDPRESS_CRON_VFS;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const artifactTest = test.extend<{ artifactUrls: { imageUrl: string; kernelUrl: string } }>({
  artifactUrls: async ({ baseURL }, use) => {
    if (!imagePath) {
      await use({ imageUrl: "", kernelUrl: "" });
      return;
    }
    expect(baseURL).toBeTruthy();
    const kernelPath = resolveBinary("kernel.wasm");
    const artifacts = new Map([
      ["/__wordpress_frankenphp__.vfs.zst", { path: imagePath!, type: "application/octet-stream" }],
      ["/__wordpress_frankenphp_kernel__.wasm", { path: kernelPath, type: "application/wasm" }],
    ]);
    const server = createServer((request, response) => {
      const artifact = artifacts.get(request.url ?? "");
      if (!artifact) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, {
        "Content-Type": artifact.type,
        "Content-Length": statSync(artifact.path).size,
        "Access-Control-Allow-Origin": new URL(baseURL!).origin,
        "Cross-Origin-Resource-Policy": "cross-origin",
      });
      createReadStream(artifact.path).on("error", (error) => response.destroy(error)).pipe(response);
    });
    await new Promise<void>((resolveReady, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolveReady);
    });
    const address = server.address() as AddressInfo;
    const imageUrl = `http://127.0.0.1:${address.port}/__wordpress_frankenphp__.vfs.zst`;
    const kernelUrl = `http://127.0.0.1:${address.port}/__wordpress_frankenphp_kernel__.wasm`;
    try {
      await use({ imageUrl, kernelUrl });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolveClosed, reject) => server.close((error) => error ? reject(error) : resolveClosed()));
    }
  },
});

artifactTest("WordPress cron follows server stops, restarts, crashes and service switches", async ({ page, baseURL, artifactUrls }, testInfo) => {
  test.setTimeout(420_000);
  test.skip(!imagePath, "Build WordPress and set KANDELO_WORDPRESS_CRON_VFS");
  const sourceUrl = (path: string) => new URL(`/@fs/${resolve(repoRoot, path)}`, baseURL!).href;
  await page.exposeFunction("recordCronStage", (row: unknown) => {
    appendFileSync(testInfo.outputPath("cron-stages.jsonl"), JSON.stringify(row) + "\n");
  });
  await page.goto(new URL("/trap-signal-test.html", baseURL!).href);
  const result = await page.evaluate(async ({ imageUrl, kernelUrl, hostUrl, probeUrl, gracefulUrl, runtimeUrlsUrl }) => {
    const { BrowserKernel } = await import(/* @vite-ignore */ hostUrl);
    const { prepareWordPressCronLifecycle, verifyWordPressCronLifecycle } = await import(/* @vite-ignore */ probeUrl);
    const { observeProcessExits } = await import(/* @vite-ignore */ gracefulUrl);
    const { imageOwnedLazyAssetDirectory } = await import(/* @vite-ignore */ runtimeUrlsUrl);
    const exits = observeProcessExits();
    const diagnostics: unknown[] = [];
    const stages: unknown[] = [];
    let logs = "";
    let ready!: () => void;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const readiness = new Promise<void>(resolve => { ready = resolve; });
    const append = (bytes: Uint8Array) => {
      logs = (logs + new TextDecoder().decode(bytes)).slice(-50_000);
      if (logs.includes("[  OK  ] frankenphp-caddy")) ready();
    };
    const host = new BrowserKernel({
      kernelOwnedFs: true, maxWorkers: 20, maxMemoryPages: 16_384,
      onStdout: append, onStderr: append, onProcessEvent: exits.onEvent,
      onHostDiagnostic: (diagnostic: unknown) => diagnostics.push(diagnostic),
    });
    try {
      const [image, kernel] = await Promise.all([fetch(imageUrl), fetch(kernelUrl)]);
      if (!image.ok || !kernel.ok) throw new Error("Unable to load WordPress cron artifacts");
      await host.initFromImage({ kernelWasm: await kernel.arrayBuffer(), vfsImage: new Uint8Array(await image.arrayBuffer()),
        lazyAssetDirectory: imageOwnedLazyAssetDirectory(),
      });
      await prepareWordPressCronLifecycle(host, 8080);
      const init = await host.spawnFromVfs("/bin/sh", ["sh", "/sbin/kandelo-init", "frankenphp-caddy"], {
        uid: 0, gid: 0, cwd: "/root", env: ["HOME=/root", "TMPDIR=/tmp", "TERM=xterm-256color",
          "PATH=/usr/local/bin:/usr/bin:/bin:/sbin:/usr/sbin", "FRANKENPHP_NUM_THREADS=2"],
      });
      await Promise.race([
        readiness,
        init.exit.then((code: number) => { throw new Error(`init exited before readiness: ${code}`); }),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("service readiness timed out")), 90_000); }),
      ]);
      clearTimeout(timer);
      for (let attempt = 0; ; attempt++) {
        try {
          const response = await host.fetchInKernel(8080, { method: "GET", url: "/", headers: { Host: "localhost:8080" }, body: null }, { timeoutMs: 30_000 });
          if (response.status !== 200) throw new Error(`Initial WordPress HTTP ${response.status}`);
          break;
        } catch (error) {
          if (!String(error).includes("No in-kernel listener") || attempt >= 99) throw error;
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }
      const observations = await verifyWordPressCronLifecycle(host, 8080, exits.waitForExit, async (row: unknown) => {
        stages.push(row);
        await (globalThis as typeof globalThis & { recordCronStage(row: unknown): Promise<void> }).recordCronStage(row);
      });
      const shutdown = await host.spawnFromVfs("/sbin/dinitctl", ["dinitctl", "-p", "/run/kandelo-services/dinitctl", "shutdown"]);
      const shutdownExit = await shutdown.exit;
      const initExit = await init.exit;
      await host.destroy();
      return { observations, diagnostics, shutdownExit, initExit, logs };
    } catch (error) {
      throw new Error(`${String(error)}\n${JSON.stringify(stages)}\n${logs.slice(-6000)}`);
    } finally {
      clearTimeout(timer);
      await host.destroy();
    }
  }, { ...artifactUrls, hostUrl: sourceUrl("host/src/browser-kernel-host.ts"),
    probeUrl: sourceUrl("host/test/support/wordpress-cron-lifecycle.ts"),
    gracefulUrl: sourceUrl("host/test/support/frankenphp-graceful.ts"),
    runtimeUrlsUrl: sourceUrl("apps/browser-demos/lib/init/image-owned-runtime-urls.ts"),
  });
  await testInfo.attach("cron-lifecycle-result", { body: JSON.stringify(result, null, 2), contentType: "application/json" });
  expect(result.diagnostics).toEqual([]);
  expect(result.observations).toHaveLength(8);
  expect(result.shutdownExit).toBe(0);
  expect(result.initExit).toBe(0);
});
