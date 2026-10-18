import { expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const proxyWorkerPath = resolve(
  __dirname,
  "../../../host/src/vfs/opfs-worker.ts",
);
const clientWorkerPath = resolve(
  __dirname,
  "fixtures/opfs-pathconf-client-worker.ts",
);

test("OPFS answers only its own path configuration, from live paths and handles", async ({
  playwright,
  browserName,
  baseURL,
}, testInfo) => {
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
  const userDataDir = await mkdtemp(join(tmpdir(), "kandelo-opfs-pathconf-"));
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
              nameMax: string | null;
              pathMax: string | null;
              asyncIo: string | null;
              symlinks: null;
              timestampResolution: null;
              closedHandleError: string;
              missingPathError: string;
            }>(client, "result");
            client.postMessage({
              buffer,
              path: `/kandelo-opfs-pathconf-${crypto.randomUUID()}`,
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
        nameMax: "ENOSYS: pathconf name 3 is not a value this host can source",
        pathMax: "ENOSYS: pathconf name 4 is not a value this host can source",
        asyncIo: "ENOSYS: pathconf name 10 is not a value this host can source",
        symlinks: null,
        timestampResolution: null,
        closedHandleError: "EBADF",
        missingPathError: "ENOENT",
      });
    } finally {
      await context.close();
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
  }
});
