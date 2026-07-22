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

test("guest POST keeps its body and headers without browser credentials", async ({
  page,
}) => {
  const upstreamRequests: Array<{
    method: string;
    url: string;
    headers: Record<string, string | string[] | undefined>;
    body: string;
  }> = [];
  const upstream = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      upstreamRequests.push({
        method: request.method ?? "",
        url: request.url ?? "",
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      response.writeHead(200, { "Content-Type": "text/plain" });
      response.end("proxied post\n");
    });
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
    const targetUrl = `http://localhost.:${port}/repo/git-upload-pack`;
    const wgetBytes = Array.from(await readFile(wgetPath));
    const proxyRequestHeaders: Record<string, string>[] = [];
    page.on("request", (request) => {
      if (request.url().includes("__kandelo_cors_proxy")) {
        proxyRequestHeaders.push(request.headers());
      }
    });

    await page.goto("/pages/test-runner/", {
      waitUntil: "domcontentloaded",
    });
    await page.evaluate(() => {
      document.cookie = "ambient_session=browser-secret; path=/";
    });
    await page.waitForFunction(
      () => (window as unknown as TestRunnerWindow).__testRunnerReady === true,
    );

    const body = "command=ls-refs\n";
    const result = await page.evaluate(
      async ({ bytes, body, url }) =>
        (window as unknown as TestRunnerWindow).__runTest(
          new Uint8Array(bytes).buffer,
          [
            "wget",
            "-qO-",
            "--header=Authorization: Bearer guest-token",
            "--header=Git-Protocol: version=2",
            "--header=X-Guest-Probe: preserved",
            "--header=Content-Type: text/plain",
            `--post-data=${body}`,
            url,
          ],
          60_000,
        ),
      { bytes: wgetBytes, body, url: targetUrl },
    );

    expect(
      result.exitCode,
      JSON.stringify({ result, upstreamRequests }, null, 2),
    ).toBe(0);
    expect(result.stdout).toBe("proxied post\n");
    expect(upstreamRequests).toHaveLength(1);
    expect(upstreamRequests[0]).toMatchObject({
      method: "POST",
      url: "/repo/git-upload-pack",
      body,
    });
    expect(upstreamRequests[0].headers.authorization).toBe(
      "Bearer guest-token",
    );
    expect(upstreamRequests[0].headers["git-protocol"]).toBe("version=2");
    expect(upstreamRequests[0].headers["x-guest-probe"]).toBe("preserved");
    expect(upstreamRequests[0].headers["content-type"]).toBe("text/plain");
    expect(
      upstreamRequests[0].headers["x-cors-proxy-allowed-request-headers"],
    ).toBeUndefined();
    expect(upstreamRequests[0].headers.cookie).toBeUndefined();
    expect(upstreamRequests[0].headers.origin).toBeUndefined();
    expect(upstreamRequests[0].headers.referer).toBeUndefined();
    expect(proxyRequestHeaders).toHaveLength(1);
    expect(proxyRequestHeaders[0].cookie).toBeUndefined();
    // Chromium reports the no-referrer request as either an absent header or
    // an empty value, depending on the protocol inspection path.
    expect(proxyRequestHeaders[0].referer ?? "").toBe("");
  } finally {
    await new Promise<void>((resolve, reject) => {
      upstream.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
