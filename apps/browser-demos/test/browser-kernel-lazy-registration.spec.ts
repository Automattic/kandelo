import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { zipSync } from "fflate";
import { parseZipCentralDirectory } from "../../../host/src/vfs/zip";

const __dirname = dirname(fileURLToPath(import.meta.url));
const workerModulePath = resolve(
  __dirname,
  "fixtures/lazy-vfs-integrity-worker.ts",
);

async function runWorker<T>(
  page: Page,
  workerUrl: string,
  request: unknown,
): Promise<T & { fatalError?: string }> {
  return page.evaluate(
    async ({ workerUrl, request }) => {
      const worker = new Worker(workerUrl, { type: "module" });
      try {
        return await new Promise<T & { fatalError?: string }>((resolve, reject) => {
          worker.onmessage = (event) => resolve(event.data);
          worker.onerror = (event) => reject(new Error(event.message));
          worker.postMessage(request);
        });
      } finally {
        worker.terminate();
      }
    },
    { workerUrl, request },
  );
}

test("browser worker rejects wrong-sized lazy bytes and can retry", async ({
  page,
  baseURL,
  browserName,
}) => {
  expect(baseURL).toBeTruthy();
  const workerUrl = new URL(`/@fs/${workerModulePath}`, baseURL).href;
  const assetUrl = new URL("/__lazy_integrity__/tool.wasm", baseURL).href;
  const exactBytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);
  let requestCount = 0;
  await page.route(assetUrl, async (route) => {
    requestCount += 1;
    await route.fulfill({
      status: 200,
      contentType: requestCount === 1 ? "text/html" : "application/wasm",
      body: requestCount === 1
        ? "<!doctype html><title>Vite fallback</title>"
        : Buffer.from(exactBytes),
    });
  });
  await page.goto(new URL("/trap-signal-test.html", baseURL).href);

  const result = await runWorker<{
    firstError: string;
    retained: { size: number } | null;
    stubRead: number;
    retried: boolean;
    bytes: number[];
    remainingEntry: unknown;
    statuses: string[];
  }>(page, workerUrl, {
    kind: "file",
    assetUrl,
    expectedBytes: exactBytes.byteLength,
  });

  expect(result.fatalError, browserName).toBeUndefined();
  expect(result.firstError, browserName).toContain(
    `expected ${exactBytes.byteLength} bytes, received 43`,
  );
  expect(result.retained, browserName).toMatchObject({ size: exactBytes.byteLength });
  expect(result.stubRead, browserName).toBe(0);
  expect(result.retried, browserName).toBe(true);
  expect(result.bytes, browserName).toEqual([...exactBytes]);
  expect(result.remainingEntry, browserName).toBeNull();
  expect(result.statuses.filter((status) => status !== "progress"), browserName).toEqual([
    "started",
    "error",
    "started",
    "complete",
  ]);
  expect(requestCount, browserName).toBe(2);
});

test("browser worker verifies a lazy ZIP before writing its runtime closure", async ({
  page,
  baseURL,
  browserName,
}) => {
  expect(baseURL).toBeTruthy();
  const workerUrl = new URL(`/@fs/${workerModulePath}`, baseURL).href;
  const assetUrl = new URL("/__lazy_integrity__/runtime.zip", baseURL).href;
  const zipBytes = zipSync({
    "bin/tool": new TextEncoder().encode("tool bytes"),
    "lib/runtime.dat": new TextEncoder().encode("runtime bytes"),
  });
  const corrupted = zipBytes.slice();
  corrupted[0] ^= 0xff;
  let requestCount = 0;
  await page.route(assetUrl, async (route) => {
    requestCount += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/zip",
      body: Buffer.from(requestCount === 1 ? corrupted : zipBytes),
    });
  });
  await page.goto(new URL("/trap-signal-test.html", baseURL).href);
  const entries = parseZipCentralDirectory(zipBytes).map((entry) => ({
    ...entry,
    fileNameBytes: Array.from(entry.fileNameBytes),
  }));

  const result = await runWorker<{
    firstError: string;
    retainedGroups: number;
    firstStubRead: number;
    secondStubRead: number;
    retried: boolean;
    tool: string;
    runtime: string;
    remainingGroups: number;
    statuses: string[];
  }>(page, workerUrl, {
    kind: "archive",
    assetUrl,
    compressedBytes: zipBytes.byteLength,
    sha256: createHash("sha256").update(zipBytes).digest("hex"),
    entries,
  });

  expect(result.fatalError, browserName).toBeUndefined();
  expect(result.firstError, browserName).toContain("SHA-256 mismatch");
  expect(result.retainedGroups, browserName).toBe(1);
  expect(result.firstStubRead, browserName).toBe(0);
  expect(result.secondStubRead, browserName).toBe(0);
  expect(result.retried, browserName).toBe(true);
  expect(result.tool, browserName).toBe("tool bytes");
  expect(result.runtime, browserName).toBe("runtime bytes");
  expect(result.remainingGroups, browserName).toBe(0);
  expect(result.statuses.filter((status) => status !== "progress"), browserName).toEqual([
    "started",
    "error",
    "started",
    "complete",
  ]);
  expect(requestCount, browserName).toBe(2);
});
