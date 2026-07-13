import { expect, test } from "@playwright/test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { resolveBinary } from "../../../host/src/binary-resolver";

const wgetPath = resolveBinary("programs/wget.wasm");

type TestResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  combined: string;
};

type TestRunnerWindow = Window & {
  __testRunnerReady: boolean;
  __runTest(
    wasmBytes: ArrayBuffer,
    argv: string[],
    timeoutMs: number,
  ): Promise<TestResult>;
};

test("guest HTTP uses the test runner's same-origin CORS proxy", async ({
  page,
}) => {
  const upstreamRequests: string[] = [];
  const upstream = createServer((request, response) => {
    upstreamRequests.push(request.url ?? "");
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("Kandelo CORS proxy regression\n");
  });
  await new Promise<void>((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "::1", () => {
      upstream.off("error", reject);
      resolve();
    });
  });

  try {
    const { port } = upstream.address() as AddressInfo;
    // The trailing root dot avoids the guest's /etc/hosts localhost entry, so
    // Kandelo delegates the connection to its browser backend. Node still
    // resolves the proxy's upstream target to this test-only ::1 listener.
    const targetUrl = `http://localhost.:${port}/probe`;
    const wgetBytes = Array.from(await readFile(wgetPath));

    await page.goto("/pages/test-runner/", {
      waitUntil: "domcontentloaded",
    });
    await page.waitForFunction(
      () => (window as unknown as TestRunnerWindow).__testRunnerReady === true,
    );
    expect(
      await page.evaluate(() => navigator.serviceWorker.controller),
      "the regression must exercise explicit BrowserKernel proxy configuration",
    ).toBeNull();

    const result = await page.evaluate(
      async ({ bytes, url }) =>
        (window as unknown as TestRunnerWindow).__runTest(
          new Uint8Array(bytes).buffer,
          ["wget", "-qO-", url],
          60_000,
        ),
      { bytes: wgetBytes, url: targetUrl },
    );

    expect(
      result.exitCode,
      JSON.stringify({ result, upstreamRequests }, null, 2),
    ).toBe(0);
    expect(result.stdout).toBe("Kandelo CORS proxy regression\n");
    expect(upstreamRequests).toEqual(["/probe"]);
  } finally {
    await new Promise<void>((resolve, reject) => {
      upstream.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
