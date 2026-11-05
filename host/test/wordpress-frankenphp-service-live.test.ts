import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";
import { configureWordPressRuntime, SERVICE_DEMO_ENV, waitForHttp } from "../../packages/registry/service-vfs-demo";
import { NodeKernelHost } from "../src/node-kernel-host";
import type { DestroyProgressEvent } from "../src/browser-kernel-protocol";

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

const imagePath = process.env.KANDELO_WORDPRESS_FRANKENPHP_IMAGE;

it.skipIf(!imagePath)("boots WordPress through the image service controller in Node", async () => {
  const port = await availablePort();
  const fs = KandeloImageFs.create();
  fs.loadImage(new Uint8Array(readFileSync(imagePath!)), { maxDecompressedBytes: 1024 * 1024 * 1024 });
  configureWordPressRuntime(fs, { port });
  const image = await fs.saveImage();
  const env = [
    ...SERVICE_DEMO_ENV,
    "WP_APP_PATH=/", "WP_PROTO=http", "FRANKENPHP_NUM_THREADS=6",
    `FRANKENPHP_LISTEN=:${port}`,
  ];
  let logs = "";
  const diagnostics: unknown[] = [];
  const shutdown: DestroyProgressEvent[] = [];
  const append = (_pid: number, data: Uint8Array) => {
    logs = (logs + new TextDecoder().decode(data)).slice(-100_000);
  };
  const host = new NodeKernelHost({
    rootfsImage: image.buffer,
    takeRootfsImageOwnership: true,
    maxWorkers: 12,
    maxPages: 16_384,
    onStdout: append,
    onStderr: append,
    onHostDiagnostic: diagnostic => diagnostics.push(diagnostic),
  });
  host.subscribeDestroyProgress(event => shutdown.push(event));
  try {
    await host.init();
    const init = await host.spawnFromVfs("/bin/sh", ["sh", "/sbin/kandelo-init", "frankenphp-classic"], {
      uid: 0, gid: 0, cwd: "/root", env,
    });
    let initExit: number | undefined;
    void init.exit.then(code => { initExit = code; }, () => { initExit = -1; });
    try {
      await waitForHttp(`http://127.0.0.1:${port}/`, 180_000, () => initExit !== undefined);
    } catch (error) {
      const paths = ["/var/log/frankenphp-classic.log", "/var/log/wp-config-init.log", "/etc/kandelo/enabled-service"];
      const files = await Promise.all(paths.map(async path => {
        const bytes = await host.readFileFromVfs(path);
        return `${path}: ${bytes ? new TextDecoder().decode(bytes).slice(-3000) : "missing"}`;
      }));
      throw new Error(`${String(error)}; port=${port}; initExit=${String(initExit)}\n${files.join("\n")}\n${logs.slice(-3000)}`);
    }

    const id = `wordpress-service-test-${randomUUID()}`;
    const command = await host.spawnFromVfs("/bin/sh", ["sh", "-c", "kandelo-service inspect"], {
      uid: 0, gid: 0, env, ownedJob: { id, timeoutMs: 30_000 },
    });
    const exitCode = await command.exit;
    let report = await host.readOwnedJob(id, 0, 65_536);
    for (let attempt = 0; attempt < 50 && !report.terminationObserved; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      report = await host.readOwnedJob(id, 0, 65_536);
    }
    const output = report.chunks.map(chunk => new TextDecoder().decode(chunk.bytes)).join("");
    await host.releaseOwnedJob(id);
    expect(exitCode, `${output}\n${logs}`).toBe(0);
    expect(report.terminationObserved).toBe(true);
    expect(output).toContain("frankenphp-classic\trunning\tenabled");
    expect(output).toContain("nginx\tnot-loaded\tdisabled");
    expect(output).toContain("frankenphp-caddy\tnot-loaded\tdisabled");

    const response = await fetch(`http://127.0.0.1:${port}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("WordPress on Kandelo");
    await host.destroy();
    const drained = shutdown.filter(event => event.phase === "draining").at(-1);
    expect(drained, JSON.stringify(shutdown)).toBeDefined();
    expect(drained!.total).toBeGreaterThan(0);
    expect(drained!.completed, JSON.stringify(shutdown)).toBe(drained!.total);
    expect(diagnostics).toEqual([]);
  } finally {
    await host.destroy();
  }
}, 240_000);
