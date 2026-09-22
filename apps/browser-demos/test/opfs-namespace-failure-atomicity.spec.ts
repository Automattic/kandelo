import { expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { platform, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const proxyWorkerPath = resolve(
  __dirname,
  "fixtures/opfs-namespace-failure-proxy-worker.ts",
);
const clientWorkerPath = resolve(
  __dirname,
  "fixtures/opfs-namespace-failure-client-worker.ts",
);

const scenarios = [
  { scenario: "flush-unlink", mode: "flush-once", expectedMoves: 1 },
  { scenario: "reopen-replace", mode: "reopen-once", expectedMoves: 6 },
] as const;

for (const injected of scenarios) {
  test(`OPFS ${injected.scenario} failure leaves paths and descriptors unchanged`, async ({
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
    expect(baseURL).toBeTruthy();

    // Run under a persistent context. WebKit only backs the Origin Private
    // File System when the browser has an on-disk profile; in Playwright's
    // default ephemeral context navigator.storage.getDirectory() throws
    // UnknownError. Chromium backs OPFS even ephemerally, but one persistent
    // context works for every engine. Mirror the project's launch settings.
    const projectUse = testInfo.project.use as {
      channel?: string;
      launchOptions?: Record<string, unknown>;
      proxy?: Record<string, unknown>;
      extraHTTPHeaders?: Record<string, string>;
    };
    const userDataDir = await mkdtemp(join(tmpdir(), "kandelo-opfs-failure-"));
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
        const proxyWorkerUrl = new URL(`/@fs/${proxyWorkerPath}`, baseURL);
        proxyWorkerUrl.searchParams.set("mode", injected.mode);
        const clientWorkerUrl = new URL(`/@fs/${clientWorkerPath}`, baseURL).href;
        await page.goto(new URL("/trap-signal-test.html", baseURL).href);

        const result = await page.evaluate(
          async ({ proxyWorkerUrl, clientWorkerUrl, scenario }) => {
            const buffer = new SharedArrayBuffer(4 * 1024 * 1024);
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
                  } else if (event.data?.type === expectedType) {
                    clearTimeout(timeout);
                    resolvePromise(event.data as T);
                  }
                });
                worker.addEventListener("error", (event) => {
                  clearTimeout(timeout);
                  reject(
                    new Error(
                      `${event.message || "worker module failed to load"} ` +
                        `(${event.filename}:${event.lineno}:${event.colno})`,
                    ),
                  );
                });
              });

            try {
              const ready = receive<{ type: "ready" }>(proxy, "ready");
              proxy.postMessage({ type: "init", buffer });
              await ready;

              const pending = receive<Record<string, unknown>>(client, "result");
              const stem = `/kandelo-opfs-failure-${crypto.randomUUID()}`;
              client.postMessage({
                buffer,
                scenario,
                sourcePath: `${stem}-source`,
                destinationPath: `${stem}-destination`,
              });
              const operation = await pending;
              const statsPending = receive<Record<string, unknown>>(
                proxy,
                "fault-stats",
              );
              proxy.postMessage({ type: "fault-stats" });
              return { operation, stats: await statsPending };
            } finally {
              client.terminate();
              proxy.terminate();
            }
          },
          {
            proxyWorkerUrl: proxyWorkerUrl.href,
            clientWorkerUrl,
            scenario: injected.scenario,
          },
        );

        expect(result.operation).toMatchObject({
          type: "result",
          operationFailed: true,
          sourcePathPreserved: true,
          sourceDescriptorPreserved: true,
          sourceContents: "source-object",
          destinationAbsent: injected.scenario !== "reopen-replace",
          destinationPreserved: true,
          destinationContents:
            injected.scenario === "reopen-replace" ? "destination-object" : null,
          retryCommitted: true,
        });
        expect(result.stats).toMatchObject({
          type: "fault-stats",
          injected: true,
          moveCalls: injected.expectedMoves,
        });
      } finally {
        await context.close();
      }
    } finally {
      await rm(userDataDir, { recursive: true, force: true });
    }
  });
}
