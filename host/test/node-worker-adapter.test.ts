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
import { hostBuildFingerprintBanner } from "../src/compiled-worker-entry";
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

  // A process worker must not run a `dist/` bundle built from older sources.
  // The adapter took any existing `dist/worker-entry.js`, so after a
  // `host/src` edit every process worker in Vitest ran the previous build and
  // reported on code no longer in the tree. The kernel worker already checked
  // the build-input fingerprint; process workers now apply the same gate.
  it("uses a compiled entry only when it was built from the current sources", () => {
    const root = mkdtempSync(join(tmpdir(), "kandelo-worker-compiled-test-"));
    try {
      for (const file of ["package-lock.json", "tsconfig.json", "tsup.config.ts"]) {
        writeFileSync(join(root, file), `${file}\n`);
      }
      writeFileSync(join(root, "package.json"), "{}\n");
      mkdirSync(join(root, "src"));
      mkdirSync(join(root, "dist"));
      const entryPath = join(root, "src", "worker-entry.ts");
      writeFileSync(entryPath, 'export const entry = "source";\n');
      const compiled = join(root, "dist", "worker-entry.js");
      const compiledEntry = (): URL | null =>
        (
          new NodeWorkerAdapter(pathToFileURL(entryPath)) as unknown as {
            resolveCompiledEntry: () => URL | null;
          }
        ).resolveCompiledEntry();

      writeFileSync(compiled, `${hostBuildFingerprintBanner(root)}\n`);
      expect(compiledEntry()?.href).toBe(pathToFileURL(compiled).href);

      // Edit the source after the build: the bundle is stale.
      writeFileSync(entryPath, 'export const entry = "edited source";\n');
      expect(compiledEntry()).toBeNull();
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
