import { expect, test } from "@playwright/test";
import { dirname, resolve } from "node:path";
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
    page,
    baseURL,
    browserName,
  }) => {
    test.skip(
      browserName !== "chromium",
      "OPFS sync access handles are Chromium-only here",
    );
    expect(baseURL).toBeTruthy();

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
  });
}
