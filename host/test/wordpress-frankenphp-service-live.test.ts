import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";
import { configureWordPressRuntime, readVfsText, SERVICE_DEMO_ENV, waitForHttp } from "../../packages/registry/service-vfs-demo";
import { writeVfsFile } from "../src/vfs/image-helpers";
import { NodeKernelHost } from "../src/node-kernel-host";
import type { DestroyProgressEvent } from "../src/browser-kernel-protocol";
import { observeProcessExits, verifyFrankenPhpGracefulShutdown } from "./support/frankenphp-graceful";

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

const serviceTest = it.skipIf(!imagePath).each(["frankenphp-classic", "frankenphp-caddy"] as const);

serviceTest("boots WordPress through the %s image service controller in Node", async service => {
  const port = await availablePort();
  const fs = KandeloImageFs.create();
  fs.loadImage(new Uint8Array(readFileSync(imagePath!)), { maxDecompressedBytes: 1024 * 1024 * 1024 });
  const serviceConfigPath = `/etc/dinit.d/${service}`;
  const serviceConfig = readVfsText(fs, serviceConfigPath);
  configureWordPressRuntime(fs, { port });
  // The demo helper routes logs to stdio; this test needs the image's log file.
  writeVfsFile(fs, serviceConfigPath, serviceConfig);
  const image = await fs.saveImage();
  const env = [
    ...SERVICE_DEMO_ENV,
    "WP_APP_PATH=/", "WP_PROTO=http", "FRANKENPHP_NUM_THREADS=6",
    `FRANKENPHP_LISTEN=:${port}`,
    `FRANKENPHP_PORT=${port}`,
  ];
  let logs = "";
  const diagnostics: unknown[] = [];
  const shutdown: DestroyProgressEvent[] = [];
  const lifecycle: { kind: string; pid: number; ppid?: number; exitStatus?: number }[] = [];
  const processExits = observeProcessExits();
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
    onProcessEvent: event => {
      lifecycle.push(event);
      processExits.onEvent(event);
    },
  });
  host.subscribeDestroyProgress(event => shutdown.push(event));
  try {
    await host.init();
    const init = await host.spawnFromVfs("/bin/sh", ["sh", "/sbin/kandelo-init", service], {
      uid: 0, gid: 0, cwd: "/root", env,
    });
    let initExit: number | undefined;
    void init.exit.then(code => { initExit = code; }, () => { initExit = -1; });
    try {
      await waitForHttp(`http://127.0.0.1:${port}/`, 180_000, () => initExit !== undefined);
    } catch (error) {
      const paths = [`/var/log/${service}.log`, "/var/log/wp-config-init.log", "/etc/kandelo/enabled-service"];
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
    expect(output).toContain(`${service}\trunning\tenabled`);
    for (const inactive of ["nginx", "frankenphp-classic", "frankenphp-caddy"].filter(target => target !== service)) {
      expect(output).toContain(`${inactive}\tnot-loaded\tdisabled`);
    }

    const response = await fetch(`http://127.0.0.1:${port}/`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("WordPress on Kandelo");
    let graceful: unknown;
    try {
      graceful = await verifyFrankenPhpGracefulShutdown(host, port, processExits.waitForExit, service);
      expect(graceful).toMatchObject({ listenerClosed: true, status: 200, serverExit: 0, stopExit: 0 });
    } catch (error) {
      const listener = await host.pickListenerTarget(port).catch(() => null);
      const paths = [`/var/log/${service}.log`, ...(listener ? [`/proc/${listener.pid}/status`] : [])];
      const reports = await Promise.all(paths.map(async path => {
        const bytes = await host.readFileFromVfs(path).catch(() => null);
        const text = bytes ? new TextDecoder().decode(bytes) : "unavailable";
        return `${path}:\n${text.slice(0, 4000)}\n${text.length > 12_000 ? "...\n" : ""}${text.slice(4000).slice(-8000)}`;
      }));
      throw new Error(`${String(error)}\n${reports.join("\n")}\n${logs.slice(-4000)}`, { cause: error });
    }
    const serviceLogBytes = await host.readFileFromVfs(`/var/log/${service}.log`);
    if (!serviceLogBytes) throw new Error(`Missing ${service} service log`);
    const serviceLog = new TextDecoder().decode(serviceLogBytes);
    expect(serviceLog).toContain(service === "frankenphp-caddy" ? "FrankenPHP started" : "FrankenPHP classic listening");
    if (process.env.KANDELO_TEST_REPORT_DIR) {
      writeFileSync(join(process.env.KANDELO_TEST_REPORT_DIR, `${service}-service.log`), serviceLogBytes);
    }
    await host.destroy();
    const drained = shutdown.filter(event => event.phase === "draining").at(-1);
    const teardownEvidence = JSON.stringify({ shutdown, graceful, lifecycle, logs: logs.slice(-4000),
      serviceLog: serviceLog.slice(0, 12_000) + (serviceLog.length > 20_000 ? "\n...\n" + serviceLog.slice(-8000) : serviceLog.slice(12_000)),
    });
    expect(serviceLog, teardownEvidence).not.toMatch(/^(?:panic:|fatal error:)/m);
    expect(drained, teardownEvidence).toBeDefined();
    expect(drained!.total).toBeGreaterThan(0);
    expect(drained!.completed, teardownEvidence).toBe(drained!.total);
    expect(diagnostics).toEqual([]);
  } finally {
    await host.destroy();
  }
}, 240_000);
