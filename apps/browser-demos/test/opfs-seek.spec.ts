import { expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { platform, tmpdir } from "node:os";
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
  playwright,
  browserName,
  baseURL,
}, testInfo) => {
  // Skip Firefox on macOS only. Playwright cannot launch Firefox on macOS 26+
  // today: headless fails profile initialization ("Could not find profile
  // folder") and headed exits before the control pipe connects. This is a
  // local browser-launch limitation, not an OPFS gap -- Firefox still runs
  // this test on Linux. Remove once a newer Playwright/Firefox launches on
  // macOS. (Duplicated across the OPFS specs on purpose; revisit together.)
  test.skip(
    browserName === "firefox" && platform() === "darwin",
    "Playwright cannot launch Firefox on macOS (profile-init failure); Firefox is covered on Linux",
  );
  expect(baseURL).toBeTruthy();

  // Run under a persistent context. WebKit only backs the Origin Private File
  // System when the browser has an on-disk profile; in Playwright's default
  // ephemeral context navigator.storage.getDirectory() throws UnknownError.
  // Chromium backs OPFS even ephemerally, but one persistent context works for
  // every engine. Mirror the project's channel/launch options/proxy/headers.
  const projectUse = testInfo.project.use as {
    channel?: string;
    launchOptions?: Record<string, unknown>;
    proxy?: Record<string, unknown>;
    extraHTTPHeaders?: Record<string, string>;
  };
  const userDataDir = await mkdtemp(join(tmpdir(), "kandelo-opfs-seek-"));
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
              content: string;
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
        content: "aXcdef!",
      });
    } finally {
      await context.close();
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
  }
});
