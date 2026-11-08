import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";
import { configureWordPressRuntime, SERVICE_DEMO_ENV } from "../../packages/registry/service-vfs-demo";
import { NodeKernelHost } from "../src/node-kernel-host";
import { observeProcessExits } from "./support/frankenphp-graceful";
import { prepareWordPressCronLifecycle, verifyWordPressCronLifecycle } from "./support/wordpress-cron-lifecycle";

const imagePath = process.env.KANDELO_WORDPRESS_CRON_IMAGE;
it.skipIf(!imagePath)("owns WordPress cron across server stop, restart, crash recovery and switches in Node", async () => {
  const fs = KandeloImageFs.create();
  fs.loadImage(new Uint8Array(readFileSync(imagePath!)), { maxDecompressedBytes: 1024 ** 3 });
  configureWordPressRuntime(fs, { port: 8080, phpFpmWorkers: 2, frankenPhpThreads: 2 });
  const image = await fs.saveImage();
  const exits = observeProcessExits();
  const diagnostics: unknown[] = [];
  let logs = "";
  let ready!: () => void;
  const readiness = new Promise<void>(resolve => { ready = resolve; });
  const append = (_pid: number, bytes: Uint8Array) => {
    logs = (logs + new TextDecoder().decode(bytes)).slice(-50_000);
    if (logs.includes("[  OK  ] frankenphp-caddy")) ready();
  };
  const host = new NodeKernelHost({
    rootfsImage: image.buffer, takeRootfsImageOwnership: true,
    offlineEgressLink: true, enableTcpNetwork: false,
    maxWorkers: 20, maxPages: 16_384,
    onStdout: append, onStderr: append, onProcessEvent: exits.onEvent,
    onHostDiagnostic: diagnostic => diagnostics.push(diagnostic),
  });
  const observations: unknown[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await host.init();
    await prepareWordPressCronLifecycle(host, 8080);
    const init = await host.spawnFromVfs("/bin/sh", ["sh", "/sbin/kandelo-init", "frankenphp-caddy"], {
      uid: 0, gid: 0, cwd: "/root", env: [...SERVICE_DEMO_ENV, "FRANKENPHP_NUM_THREADS=2"],
    });
    await Promise.race([
      readiness,
      init.exit.then(code => { throw new Error(`init exited before service readiness: ${code}`); }),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("service readiness timed out")), 90_000); }),
    ]);
    clearTimeout(timer);
    // Dinit's exec readiness precedes socket binding. Retry only that explicit
    // startup boundary; application errors must fail immediately.
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await host.fetchInKernel(8080, { method: "GET", url: "/", headers: { Host: "localhost:8080" }, body: null }, { timeoutMs: 30_000 });
        expect(response.status).toBe(200);
        break;
      } catch (error) {
        if (!String(error).includes("No in-kernel listener") || attempt >= 99) throw error;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
    }
    const result = await verifyWordPressCronLifecycle(host, 8080, exits.waitForExit, async row => { observations.push(row); });
    expect(result).toHaveLength(8);
    const shutdown = await host.spawnFromVfs("/sbin/dinitctl", ["dinitctl", "-p", "/run/kandelo-services/dinitctl", "shutdown"]);
    expect(await shutdown.exit).toBe(0);
    expect(await init.exit).toBe(0);
    await host.destroy();
    expect(diagnostics).toEqual([]);
  } catch (error) {
    throw new Error(`${String(error)}\n${logs.slice(-6000)}`, { cause: error });
  } finally {
    clearTimeout(timer);
    if (process.env.KANDELO_TEST_REPORT_DIR) {
      writeFileSync(join(process.env.KANDELO_TEST_REPORT_DIR, "wordpress-cron-lifecycle.json"), JSON.stringify({ observations, diagnostics, logs }, null, 2));
    }
    await host.destroy();
  }
}, 420_000);
