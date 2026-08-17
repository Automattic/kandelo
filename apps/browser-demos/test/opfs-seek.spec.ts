import { expect, test } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const proxyWorkerPath = resolve(
  __dirname,
  "../../../host/src/vfs/opfs-worker.ts",
);
const clientWorkerPath = resolve(
  __dirname,
  "fixtures/opfs-seek-client-worker.ts",
);

test("OPFS preserves signed 64-bit seek results and failed offsets", async ({
  page,
  baseURL,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "OPFS sync access handles are Chromium-only here",
  );
  expect(baseURL).toBeTruthy();

  const proxyWorkerUrl = new URL(`/@fs/${proxyWorkerPath}`, baseURL).href;
  const clientWorkerUrl = new URL(`/@fs/${clientWorkerPath}`, baseURL).href;
  await page.goto(new URL("/trap-signal-test.html", baseURL).href);

  const result = await page.evaluate(
    async ({ proxyWorkerUrl, clientWorkerUrl }) => {
      const buffer = new SharedArrayBuffer(4 * 1024 * 1024);
      const proxy = new Worker(proxyWorkerUrl, { type: "module" });
      const client = new Worker(clientWorkerUrl, { type: "module" });

      const receive = <T>(worker: Worker, expectedType: string): Promise<T> =>
        new Promise((resolvePromise, reject) => {
          const timeout = setTimeout(
            () => reject(new Error(`timed out waiting for ${expectedType}`)),
            15_000,
          );
          worker.addEventListener(
            "message",
            (event) => {
              if (event.data?.type !== expectedType) {
                if (event.data?.type === "error") {
                  clearTimeout(timeout);
                  reject(new Error(event.data.error));
                }
                return;
              }
              clearTimeout(timeout);
              resolvePromise(event.data as T);
            },
            { once: false },
          );
          worker.addEventListener(
            "error",
            (event) => {
              clearTimeout(timeout);
              reject(
                new Error(
                  `${expectedType}: ${event.message || "worker module failed to load"} ` +
                    `(${event.filename}:${event.lineno}:${event.colno})`,
                ),
              );
            },
            { once: true },
          );
      });

      try {
        const ready = receive<{ type: "ready" }>(proxy, "ready");
        proxy.postMessage({ type: "init", buffer });
        await ready;

        const pending = receive<{
          type: "result";
          negativeError: string | null;
          afterNegative: number;
          wideResult: number;
          overflowError: string | null;
          afterOverflow: number;
        }>(client, "result");
        client.postMessage({
          buffer,
          path: `/kandelo-opfs-seek-${crypto.randomUUID()}`,
        });
        return await pending;
      } finally {
        client.terminate();
        proxy.terminate();
      }
    },
    { proxyWorkerUrl, clientWorkerUrl },
  );

  expect(result).toEqual({
    type: "result",
    negativeError: "EINVAL",
    afterNegative: 2,
    wideResult: 2 ** 32 + 1,
    overflowError: "EOVERFLOW",
    afterOverflow: Number.MAX_SAFE_INTEGER,
  });
});
