import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDirectory, "../../..");
const proxyWorkerPath = resolve(repoRoot, "host/src/vfs/opfs-worker.ts");
const clientWorkerPath = resolve(testDirectory, "fixtures/opfs-overlay-prototype-client-worker.ts");
const wasmPath = resolve(repoRoot, "target/wasm32-unknown-unknown/release/overlay_prototype.wasm");

test.beforeAll(() => {
  test.setTimeout(180_000);
  execFileSync("cargo", [
    "-Z", "build-std=core,alloc", "build", "--release", "-p", "overlay-prototype", "--target", "wasm32-unknown-unknown",
  ], { cwd: repoRoot, stdio: "pipe" });
});

test("Rust overlay survives OPFS worker restart without copying sparse gaps", async ({
  playwright,
  browserName,
  baseURL,
}, testInfo) => {
  expect(baseURL).toBeTruthy();
  const projectUse = testInfo.project.use as {
    channel?: string;
    launchOptions?: Record<string, unknown>;
    proxy?: Record<string, unknown>;
    extraHTTPHeaders?: Record<string, string>;
  };
  const userDataDir = mkdtempSync(join(tmpdir(), "kandelo-overlay-prototype-"));
  try {
    const context = await playwright[browserName].launchPersistentContext(userDataDir, {
      channel: projectUse.channel,
      proxy: projectUse.proxy as never,
      extraHTTPHeaders: projectUse.extraHTTPHeaders,
      ...(projectUse.launchOptions ?? {}),
    });
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      const proxyWorkerUrl = new URL(`/@fs/${proxyWorkerPath}`, baseURL).href;
      const clientWorkerUrl = new URL(`/@fs/${clientWorkerPath}`, baseURL).href;
      const wasmUrl = new URL(`/@fs/${wasmPath}`, baseURL).href;
      await page.goto(new URL("/trap-signal-test.html", baseURL).href);
      const result = await page.evaluate(async ({ proxyWorkerUrl, clientWorkerUrl, wasmUrl }) => {
        const path = `/kandelo-rust-overlay-${crypto.randomUUID()}`;
        const receive = <T>(worker: Worker, expectedType: string): Promise<T> =>
          new Promise((resolveResult, reject) => {
            const timeout = setTimeout(() => reject(new Error(`timed out waiting for ${expectedType}`)), 30000);
            worker.addEventListener("message", (event) => {
              if (event.data?.type === "error") {
                clearTimeout(timeout);
                reject(new Error(event.data.error));
              } else if (event.data?.type === expectedType) {
                clearTimeout(timeout);
                resolveResult(event.data as T);
              }
            });
            worker.addEventListener("error", (event) => {
              clearTimeout(timeout);
              reject(new Error(`${expectedType}: ${event.message || "worker failed to load"}`));
            }, { once: true });
          });
        const runPhase = async <T>(mode: "write" | "verify", expectedType: string): Promise<T> => {
          const buffer = new SharedArrayBuffer(4 * 1024 * 1024);
          const proxy = new Worker(proxyWorkerUrl, { type: "module" });
          const client = new Worker(clientWorkerUrl, { type: "module" });
          try {
            const ready = receive<{ type: "ready" }>(proxy, "ready");
            proxy.postMessage({ type: "init", buffer });
            await ready;
            const pending = receive<T>(client, expectedType);
            client.postMessage({ buffer, path, mode, wasmUrl });
            return await pending;
          } finally {
            client.terminate();
            proxy.terminate();
          }
        };
        const written = await runPhase<{ baseBefore: number[]; journalBytes: number }>("write", "written");
        const verified = await runPhase<{
          changed: number[];
          sparse: number[];
          untouched: number[];
          logicalSize: string;
          createdInode: string;
          createdData: number[];
          wrongBaseStatus: number;
        }>("verify", "result");
        return { written, verified };
      }, { proxyWorkerUrl, clientWorkerUrl, wasmUrl });
      expect(result.written.baseBefore).toEqual([76, 77, 78, 79, 80, 81, 82, 83]);
      expect(result.written.journalBytes).toBeLessThan(20_000);
      expect(result.verified).toEqual({
        type: "result",
        changed: [76, 77, 91, 92, 93, 94, 82, 83],
        sparse: [0, 0, 5, 6, 7],
        untouched: [231, 232, 233, 234],
        logicalSize: "8589934595",
        createdInode: "8",
        createdData: [104, 101, 108, 108, 111],
        wrongBaseStatus: -5,
      });
    } finally {
      await context.close();
    }
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
