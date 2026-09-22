import { expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { platform, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { OPFS_CHANNEL_SIZE } from "../../../host/src/vfs/opfs-channel";

const __dirname = dirname(fileURLToPath(import.meta.url));
const proxyWorkerPath = resolve(__dirname, "../../../host/src/vfs/opfs-worker.ts");
const clientWorkerPath = resolve(__dirname, "fixtures/opfs-readdir-client-worker.ts");

// d_type for a regular file (linux_dirent64 d_type); matches the value the OPFS
// directory marshaller writes after each name (opfs-directory-iterator.ts).
const DT_REG = 8;

test("OPFS readdir returns entry names from the shared channel", async ({
  playwright,
  browserName,
  baseURL,
}, testInfo) => {
  // Firefox cannot be launched by Playwright on macOS: headless Firefox
  // (151-156) fails profile initialization on macOS 26+ ("Could not find
  // profile folder"), and headed exits before the control pipe connects. The
  // OPFS backend itself is portable; this is a local macOS launch limitation,
  // so Firefox coverage runs on Linux instead. Skip before any browser is
  // spawned so this never surfaces as a launch error.
  test.skip(
    browserName === "firefox" && platform() === "darwin",
    "Playwright cannot launch Firefox on macOS (profile-init failure); Firefox is covered on Linux",
  );
  expect(baseURL).toBeTruthy();

  // The Origin Private File System is only backed on disk when the browser has
  // a persistent profile. Playwright's default context is ephemeral, and in
  // WebKit navigator.storage.getDirectory() then throws UnknownError. Chromium
  // backs OPFS even ephemerally, but a persistent context works for every
  // engine, so the OPFS suite uses one uniformly. Mirror the project's channel,
  // launch options, proxy, and headers so this matches the configured browser.
  const projectUse = testInfo.project.use as {
    channel?: string;
    launchOptions?: Record<string, unknown>;
    proxy?: Record<string, unknown>;
    extraHTTPHeaders?: Record<string, string>;
  };
  const userDataDir = await mkdtemp(join(tmpdir(), "kandelo-opfs-readdir-"));
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
      await page.goto(new URL("/trap-signal-test.html", baseURL).href);

      const result = await page.evaluate(
        async ({ proxyWorkerUrl, clientWorkerUrl, channelSize }) => {
          const buffer = new SharedArrayBuffer(channelSize);
          const proxy = new Worker(proxyWorkerUrl, { type: "module" });
          const client = new Worker(clientWorkerUrl, { type: "module" });
          const receive = <T>(worker: Worker, expectedType: string): Promise<T> =>
            new Promise((resolvePromise, reject) => {
              const timeout = setTimeout(
                () => {
                  cleanup();
                  reject(new Error(`timed out waiting for ${expectedType}`));
                },
                15_000,
              );
              const onMessage = (event: MessageEvent) => {
                if (event.data?.type === "error") {
                  cleanup();
                  reject(new Error(event.data.error));
                  return;
                }
                if (event.data?.type !== expectedType) return;
                cleanup();
                resolvePromise(event.data as T);
              };
              const onError = (event: ErrorEvent) => {
                cleanup();
                reject(new Error(`${expectedType}: ${event.message}`));
              };
              const cleanup = () => {
                clearTimeout(timeout);
                worker.removeEventListener("message", onMessage);
                worker.removeEventListener("error", onError);
              };
              worker.addEventListener("message", onMessage);
              worker.addEventListener("error", onError);
            });
          try {
            const ready = receive<{ type: "ready" }>(proxy, "ready");
            proxy.postMessage({ type: "init", buffer });
            await ready;
            const pending = receive<{
              type: "result";
              entries: { name: string; type: number }[];
            }>(client, "result");
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

      // Entry names and their d_type byte arrive through a SharedArrayBuffer-
      // backed channel. The backend must copy them out before decoding:
      // TextDecoder rejects views over shared memory, and the failure surfaced
      // as empty or EIO listings. Assert both the decoded names and the type
      // byte read immediately after each name.
      expect(result.entries.map((entry) => entry.name)).toEqual([
        "alpha.txt",
        "beta.txt",
        "gamma-with-a-longer-name.txt",
      ]);
      expect(result.entries.map((entry) => entry.type)).toEqual([
        DT_REG,
        DT_REG,
        DT_REG,
      ]);
    } finally {
      await context.close();
    }
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
  }
});
