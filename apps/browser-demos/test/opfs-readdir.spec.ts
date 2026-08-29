import { expect, test } from "@playwright/test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OPFS_CHANNEL_SIZE } from "../../../host/src/vfs/opfs-channel";

const __dirname = dirname(fileURLToPath(import.meta.url));
const proxyWorkerPath = resolve(__dirname, "../../../host/src/vfs/opfs-worker.ts");
const clientWorkerPath = resolve(__dirname, "fixtures/opfs-readdir-client-worker.ts");

test("OPFS readdir returns entry names from the shared channel", async ({
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
    async ({ proxyWorkerUrl, clientWorkerUrl, channelSize }) => {
      const buffer = new SharedArrayBuffer(channelSize);
      const proxy = new Worker(proxyWorkerUrl, { type: "module" });
      const client = new Worker(clientWorkerUrl, { type: "module" });
      const receive = <T>(worker: Worker, expectedType: string): Promise<T> =>
        new Promise((resolvePromise, reject) => {
          const timeout = setTimeout(
            () => reject(new Error(`timed out waiting for ${expectedType}`)),
            15_000,
          );
          worker.addEventListener("message", (event) => {
            if (event.data?.type === "error") {
              clearTimeout(timeout);
              reject(new Error(event.data.error));
              return;
            }
            if (event.data?.type !== expectedType) return;
            clearTimeout(timeout);
            resolvePromise(event.data as T);
          });
          worker.addEventListener(
            "error",
            (event) => {
              clearTimeout(timeout);
              reject(new Error(`${expectedType}: ${event.message}`));
            },
            { once: true },
          );
        });
      try {
        const ready = receive<{ type: "ready" }>(proxy, "ready");
        proxy.postMessage({ type: "init", buffer });
        await ready;
        const pending = receive<{ type: "result"; names: string[] }>(client, "result");
        client.postMessage({
          buffer,
          dir: `/kandelo-opfs-readdir-${crypto.randomUUID()}`,
        });
        return await pending;
      } finally {
        client.terminate();
        proxy.terminate();
      }
    },
    { proxyWorkerUrl, clientWorkerUrl, channelSize: OPFS_CHANNEL_SIZE },
  );

  // Entry names arrive through a SharedArrayBuffer-backed channel. The
  // backend must copy them out before decoding: TextDecoder rejects views
  // over shared memory, and the failure surfaced as empty or EIO listings.
  expect(result.names).toEqual([
    "alpha.txt",
    "beta.txt",
    "gamma-with-a-longer-name.txt",
  ]);
});
