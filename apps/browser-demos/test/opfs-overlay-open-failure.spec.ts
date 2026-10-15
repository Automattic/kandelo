import { expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const workerPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures/opfs-overlay-open-failure-worker.ts",
);

test("OPFS overlay open preserves quota failures and does not hide a disappeared file", async ({ playwright, browserName, baseURL }, testInfo) => {
  const projectUse = testInfo.project.use as {
    channel?: string;
    launchOptions?: Record<string, unknown>;
    proxy?: Record<string, unknown>;
    extraHTTPHeaders?: Record<string, string>;
  };
  const userDataDir = mkdtempSync(join(tmpdir(), "kandelo-overlay-open-failure-"));
  try {
    const context = await playwright[browserName].launchPersistentContext(userDataDir, {
      channel: projectUse.channel,
      proxy: projectUse.proxy as never,
      extraHTTPHeaders: projectUse.extraHTTPHeaders,
      ...(projectUse.launchOptions ?? {}),
    });
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto(new URL("/trap-signal-test.html", baseURL).href);
      const result = await page.evaluate(async (workerUrl) => {
        const worker = new Worker(workerUrl, { type: "module" });
        try {
          return await new Promise<Record<string, unknown>>((resolvePromise, reject) => {
            const timeout = setTimeout(() => reject(new Error("OPFS fault worker timed out")), 15_000);
            worker.addEventListener("message", (event) => {
              clearTimeout(timeout);
              if (event.data?.type === "error") reject(new Error(event.data.message));
              else if (event.data?.type === "result") resolvePromise(event.data.result);
            });
            worker.addEventListener("error", (event) => {
              clearTimeout(timeout);
              reject(new Error(event.message || "OPFS fault worker failed"));
            });
            worker.postMessage(null);
          });
        } finally {
          worker.terminate();
        }
      }, new URL(`/@fs/${workerPath}`, baseURL).href);
      for (const stage of ["directoryFailure", "fileFailure", "accessFailureResult"]) {
        expect(result[stage]).toMatchObject({ resolved: false, code: "ENOSPC" });
      }
      expect(result.disappeared).toMatchObject({ resolved: false, code: null });
      expect(result.disappeared).toHaveProperty("message", expect.stringContaining("access handle"));
      expect(result.missing).toEqual({ resolved: true, missing: true });
    } finally {
      await context.close();
    }
  } finally {
    rmSync(userDataDir, { recursive: true, force: true });
  }
});
