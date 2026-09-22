import { expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { platform, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { resolveBinary } from "../../../host/src/binary-resolver";

const __dirname = dirname(fileURLToPath(import.meta.url));
const proxyWorkerPath = resolve(
  __dirname,
  "../../../host/src/vfs/opfs-worker.ts",
);
const clientWorkerPath = resolve(
  __dirname,
  "fixtures/opfs-advisory-lock-client-worker.ts",
);

test("Rust advisory locks use exact OPFS identity, wake events, and bounded capacity", async ({
  playwright,
  browserName,
  baseURL,
}, testInfo) => {
  // Skip Firefox on macOS only: today Playwright cannot launch Firefox on
  // macOS 26+ (headless fails profile init with "Could not find profile
  // folder"; headed exits before the control pipe connects). This is a local
  // launch limitation, not an OPFS gap, so Firefox still runs this on Linux.
  // Remove once a newer Playwright/Firefox launches on macOS.
  test.skip(
    browserName === "firefox" && platform() === "darwin",
    "Playwright cannot launch Firefox on macOS (profile-init failure); Firefox is covered on Linux",
  );
  test.slow();
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
  const userDataDir = await mkdtemp(join(tmpdir(), "kandelo-opfs-advisory-"));
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
      const kernelWasmUrl = new URL(
        `/@fs/${resolveBinary("kernel.wasm")}`,
        baseURL,
      ).href;
      await page.goto(new URL("/trap-signal-test.html", baseURL).href);

      const result = await page.evaluate(
        async ({ proxyWorkerUrl, clientWorkerUrl, kernelWasmUrl }) => {
          const response = await fetch(kernelWasmUrl);
          if (!response.ok) {
            throw new Error(
              `failed to load kernel Wasm: ${response.status} ${response.statusText}`,
            );
          }
          const kernelWasm = await response.arrayBuffer();
          const buffer = new SharedArrayBuffer(4 * 1024 * 1024);
          const proxy = new Worker(proxyWorkerUrl, { type: "module" });
          const client = new Worker(clientWorkerUrl, { type: "module" });

          const receive = <T>(
            worker: Worker,
            expectedType: string,
            timeoutMs: number,
          ): Promise<T> =>
            new Promise((resolvePromise, reject) => {
              const timeout = setTimeout(
                () => reject(new Error(`timed out waiting for ${expectedType}`)),
                timeoutMs,
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
            const ready = receive<{ type: "ready" }>(proxy, "ready", 15_000);
            proxy.postMessage({ type: "init", buffer });
            await ready;

            const pending = receive<{
              type: "result";
              independentOpenAcquired: { value: number; errno: number };
              independentOpenConflict: { value: number; errno: number };
              renamedAndUnlinkedOpenConflict: { value: number; errno: number };
              recreatedPathIsolated: { value: number; errno: number };
              blockingParkedBeforeUnlock: boolean;
              unlockResult: { value: number; errno: number };
              blockingWokeAfterUnlock: boolean;
              wakeResult: { value: number; errno: number; status: number };
              capacityInserted: number;
              capacityConflict: { value: number; errno: number };
              exhaustion: { value: number; errno: number; status: number };
              exhaustionWasNotParked: boolean;
              expectedErrnos: { EAGAIN: number; ENOLCK: number };
            }>(client, "result", 180_000);
            const stem = `/kandelo-opfs-advisory-${crypto.randomUUID()}`;
            client.postMessage(
              {
                buffer,
                kernelWasm,
                identityPath: `${stem}-identity`,
                capacityPath: `${stem}-capacity`,
              },
              [kernelWasm],
            );
            return await pending;
          } finally {
            client.terminate();
            proxy.terminate();
          }
        },
        { proxyWorkerUrl, clientWorkerUrl, kernelWasmUrl },
      );

      expect(result).toMatchObject({
        type: "result",
        independentOpenAcquired: { value: 0, errno: 0 },
        independentOpenConflict: { value: -1, errno: 11 },
        renamedAndUnlinkedOpenConflict: { value: -1, errno: 11 },
        recreatedPathIsolated: { value: 0, errno: 0 },
        blockingParkedBeforeUnlock: true,
        unlockResult: { value: 0, errno: 0 },
        blockingWokeAfterUnlock: true,
        wakeResult: { value: 0, errno: 0, status: 2 },
        capacityInserted: 4096,
        capacityConflict: { value: -1, errno: 11 },
        exhaustion: { value: -1, errno: 37, status: 2 },
        exhaustionWasNotParked: true,
        expectedErrnos: { EAGAIN: 11, ENOLCK: 37 },
      });
    } finally {
      await context.close();
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
  }
});
