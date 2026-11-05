import { expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const proxyWorkerPath = resolve(testDirectory, "../../../host/src/vfs/opfs-worker.ts");
const clientWorkerPath = resolve(
  testDirectory,
  "fixtures/opfs-overlay-storage-client-worker.ts",
);

test("overlay storage reopens flushed OPFS bytes and truncates", async ({
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
  const userDataDir = await mkdtemp(join(tmpdir(), "kandelo-overlay-opfs-"));
  try {
    const context = await playwright[browserName].launchPersistentContext(
      userDataDir,
      {
        channel: projectUse.channel,
        proxy: projectUse.proxy as never,
        extraHTTPHeaders: projectUse.extraHTTPHeaders,
        ...(projectUse.launchOptions ?? {}),
      },
    );
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      const proxyWorkerUrl = new URL(`/@fs/${proxyWorkerPath}`, baseURL).href;
      const clientWorkerUrl = new URL(`/@fs/${clientWorkerPath}`, baseURL).href;
      await page.goto(new URL("/trap-signal-test.html", baseURL).href);
      const probe = await page.evaluate(async (url) => {
        const response = await fetch(url);
        return { status: response.status, body: (await response.text()).slice(0, 400) };
      }, proxyWorkerUrl);
      expect(probe.status, probe.body).toBe(200);
      const result = await page.evaluate(
        async ({ proxyWorkerUrl, clientWorkerUrl }) => {
          const path = `/kandelo-overlay-${crypto.randomUUID()}`;
          const receive = <T>(worker: Worker, expectedType: string): Promise<T> =>
            new Promise((resolveResult, reject) => {
              const timeout = setTimeout(
                () => reject(new Error(`timed out waiting for ${expectedType}`)),
                15_000,
              );
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
                reject(new Error(
                  `${expectedType}: ${event.message || "worker module failed to load"} ` +
                    `(${event.filename}:${event.lineno}:${event.colno})`,
                ));
              }, { once: true });
            });
          const runPhase = async <T>(
            mode: "write" | "verify",
            expectedType: string,
          ): Promise<T> => {
            const buffer = new SharedArrayBuffer(4 * 1024 * 1024);
            const proxy = new Worker(proxyWorkerUrl, { type: "module" });
            const client = new Worker(clientWorkerUrl, { type: "module" });
            try {
              const ready = receive<{ type: "ready" }>(proxy, "ready");
              proxy.postMessage({ type: "init", buffer });
              await ready;
              const pending = receive<T>(client, expectedType);
              client.postMessage({ buffer, path, mode });
              return await pending;
            } finally {
              client.terminate();
              proxy.terminate();
            }
          };
          await runPhase<{ type: "written" }>("write", "written");
          return await runPhase<{
            type: "result";
            size: number;
            truncatedSize: number;
            header: number[];
            tail: number[];
          }>("verify", "result");
        },
        { proxyWorkerUrl, clientWorkerUrl },
      );
      expect(result).toEqual({
        type: "result",
        size: 8195,
        truncatedSize: 4,
        header: [1, 2, 3, 4],
        tail: [5, 6, 7],
      });
    } finally {
      await context.close();
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
  }
});
