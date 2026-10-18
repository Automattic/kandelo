import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { NodeWorkerAdapter, type WorkerHandle } from "../src/worker-adapter";
import { hostBuildFingerprintBanner } from "../src/compiled-worker-entry";

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
  it("ignores a compiled dist entry that does not match the sources", async () => {
    // A source checkout's host/dist is whatever the last build produced.
    // Without a matching build fingerprint it must not run guest processes.
    const dir = mkdtempSync(join(tmpdir(), "kandelo-worker-adapter-stale-"));
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "dist"));
    const entryPath = join(dir, "src", "worker-entry.ts");
    writeFileSync(
      entryPath,
      [
        'import { parentPort } from "node:worker_threads";',
        'parentPort?.postMessage("source");',
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "dist", "worker-entry.js"),
      'import { parentPort } from "node:worker_threads";\nparentPort?.postMessage("stale dist");\n',
    );

    const adapter = new NodeWorkerAdapter(pathToFileURL(entryPath));
    const handle = adapter.createWorker({ pid: 1 });
    let bundledDir: string | undefined;
    try {
      await expect(waitForMessage(handle)).resolves.toBe("source");
      const bundledEntry = (
        adapter as unknown as { _bundledSourceEntry?: URL | false }
      )._bundledSourceEntry;
      if (bundledEntry instanceof URL) bundledDir = dirname(fileURLToPath(bundledEntry));
    } finally {
      await handle.terminate().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
      if (bundledDir !== undefined) rmSync(bundledDir, { recursive: true, force: true });
    }
  });

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
    const handles: WorkerHandle[] = [];
    let bundledDir: string | undefined;
    try {
      const first = adapter.createWorker({ pid: 42 });
      handles.push(first);
      await expect(waitForMessage(first)).resolves.toEqual({
        type: "ready",
        pid: 42,
      });

      const bundledEntry = (
        adapter as unknown as { _bundledSourceEntry?: URL | false }
      )._bundledSourceEntry;
      expect(bundledEntry).toBeInstanceOf(URL);
      expect(existsSync(fileURLToPath(bundledEntry as URL))).toBe(true);
      bundledDir = dirname(fileURLToPath(bundledEntry as URL));

      const second = adapter.createWorker({ pid: 43 });
      handles.push(second);
      await expect(waitForMessage(second)).resolves.toEqual({
        type: "ready",
        pid: 43,
      });
      expect(
        (adapter as unknown as { _bundledSourceEntry?: URL | false })
          ._bundledSourceEntry,
      ).toBe(bundledEntry);
    } finally {
      await Promise.all(
        handles.map((handle) => handle.terminate().catch(() => undefined)),
      );
      rmSync(dir, { recursive: true, force: true });
      if (bundledDir !== undefined) {
        rmSync(bundledDir, { recursive: true, force: true });
      }
    }
  });

  it("uses a compiled dist entry only while it matches the host source", () => {
    // Process and thread Workers must not run a stale dist bundle after a
    // host/src edit; the kernel Worker already enforces the same fingerprint.
    const root = mkdtempSync(join(tmpdir(), "kandelo-worker-dist-test-"));
    try {
      for (const file of ["package-lock.json", "package.json", "tsconfig.json", "tsup.config.ts"]) {
        writeFileSync(join(root, file), `${file}\n`);
      }
      mkdirSync(join(root, "src"));
      mkdirSync(join(root, "dist"));
      const entryPath = join(root, "src", "worker-entry.ts");
      const distPath = join(root, "dist", "worker-entry.js");
      writeFileSync(entryPath, "export {};\n");
      const resolve = () =>
        (new NodeWorkerAdapter(pathToFileURL(entryPath)) as unknown as {
          resolveCompiledEntry: () => URL | null;
        }).resolveCompiledEntry();

      writeFileSync(distPath, `${hostBuildFingerprintBanner(root)}\n`);
      expect(resolve()?.href).toBe(pathToFileURL(distPath).href);

      writeFileSync(entryPath, "export const edited = true;\n");
      expect(resolve()).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("removes a partial bundle before selecting the tsx fallback", () => {
    const root = mkdtempSync(join(tmpdir(), "kandelo-worker-failure-test-"));
    const sourceDir = join(root, "source");
    const entryPath = join(sourceDir, "worker-entry.ts");
    mkdirSync(sourceDir);
    writeFileSync(entryPath, 'import "./missing-module";');

    const previousTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = root;
    try {
      const adapter = new NodeWorkerAdapter(pathToFileURL(entryPath));
      const resolved = (
        adapter as unknown as { resolveBundledSourceEntry: () => URL | null }
      ).resolveBundledSourceEntry();
      expect(resolved).toBeNull();
      expect(readdirSync(root)).toEqual(["source"]);
    } finally {
      if (previousTmpdir === undefined) {
        delete process.env.TMPDIR;
      } else {
        process.env.TMPDIR = previousTmpdir;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
