import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { NodeWorkerAdapter, type WorkerHandle } from "../src/worker-adapter";

function waitForMessage(handle: WorkerHandle): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("worker timed out")), 5_000);
    handle.on("message", (message) => {
      clearTimeout(timeout);
      resolve(message);
    });
    handle.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    handle.on("exit", (code) => {
      if (code !== 0) {
        clearTimeout(timeout);
        reject(new Error(`worker exited before message: ${code}`));
      }
    });
  });
}

describe("NodeWorkerAdapter", () => {
  it("bundles a TypeScript source worker when no compiled entry exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kandelo-worker-adapter-test-"));
    const entryPath = join(dir, "worker-entry.ts");
    writeFileSync(
      entryPath,
      [
        'import { parentPort, workerData } from "node:worker_threads";',
        'parentPort?.postMessage({ type: "ready", pid: workerData.pid });',
      ].join("\n"),
    );

    const adapter = new NodeWorkerAdapter(pathToFileURL(entryPath));
    const handle = adapter.createWorker({ pid: 42 });
    try {
      await expect(waitForMessage(handle)).resolves.toEqual({ type: "ready", pid: 42 });
      const bundledEntry = (adapter as unknown as { _bundledSourceEntry?: URL | false })
        ._bundledSourceEntry;
      expect(bundledEntry).toBeInstanceOf(URL);
      expect(existsSync(fileURLToPath(bundledEntry as URL))).toBe(true);
    } finally {
      await handle.terminate().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
