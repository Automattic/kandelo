import { expect, test } from "@playwright/test";
import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const modulePath = fileURLToPath(
  new URL("../../../host/src/vfs/closed-lazy-assets.ts", import.meta.url),
);

test("Chromium verifies and closes native lazy-asset transports", async ({
  page,
  baseURL,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "the transport contract targets Chromium");
  expect(baseURL).toBeTruthy();

  const viteModuleUrl = new URL(`/@fs/${modulePath}`, baseURL!).href;
  const viteModuleResponse = await fetch(viteModuleUrl);
  const viteModuleSource = await viteModuleResponse.text();
  expect(
    viteModuleResponse.ok,
    `${viteModuleResponse.status} ${viteModuleResponse.url}: ` +
      viteModuleSource.slice(0, 500),
  ).toBe(true);

  const decodedPayload = Buffer.from("lazy Homebrew bottle bytes\n".repeat(512));
  const encodedPayload = gzipSync(decodedPayload);
  const state = {
    cookieProbe: "",
    gzipCookie: "",
    gzipReferer: "",
    redirectTargetHits: 0,
    overflowClosed: false,
    overflowFinished: false,
    slowClosed: false,
    slowFinished: false,
    streamErrorClosed: false,
  };
  const sockets = new Set<Socket>();
  const streamingResponses = new Set<ServerResponse>();
  const trackStreamingResponse = (
    response: ServerResponse,
    kind: "overflow" | "slow" | "stream-error",
  ): void => {
    streamingResponses.add(response);
    response.once("close", () => {
      streamingResponses.delete(response);
      if (kind === "overflow") state.overflowClosed = true;
      if (kind === "slow") state.slowClosed = true;
      if (kind === "stream-error") state.streamErrorClosed = true;
    });
    response.once("finish", () => {
      if (kind === "overflow") state.overflowFinished = true;
      if (kind === "slow") state.slowFinished = true;
    });
  };

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    switch (url.pathname) {
      case "/":
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "set-cookie": "closed-source-session=present; Path=/; SameSite=Lax",
        });
        response.end("<!doctype html><title>closed lazy source transport</title>");
        return;
      case "/cookie-probe":
        state.cookieProbe = request.headers.cookie ?? "";
        response.writeHead(200, { "content-type": "text/plain" });
        response.end("cookie observed");
        return;
      case "/closed-lazy-assets.ts":
        response.writeHead(200, {
          "content-type": "application/javascript; charset=utf-8",
        });
        response.end(viteModuleSource);
        return;
      case "/gzip":
        state.gzipCookie = request.headers.cookie ?? "";
        state.gzipReferer = request.headers.referer ?? "";
        response.writeHead(200, {
          "content-encoding": "gzip",
          "content-length": String(encodedPayload.byteLength),
          "content-type": "application/octet-stream",
        });
        response.end(encodedPayload);
        return;
      case "/redirect":
        response.writeHead(302, { location: "/redirect-target" });
        response.end();
        return;
      case "/redirect-target":
        state.redirectTargetHits += 1;
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.end(Buffer.from([1]));
        return;
      case "/overflow":
        trackStreamingResponse(response, "overflow");
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.flushHeaders();
        response.write(Buffer.from([1, 2, 3, 4]));
        return;
      case "/slow":
        trackStreamingResponse(response, "slow");
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.flushHeaders();
        response.write(Buffer.from([9]));
        return;
      case "/stream-error":
        trackStreamingResponse(response, "stream-error");
        response.writeHead(200, { "content-type": "application/octet-stream" });
        response.flushHeaders();
        response.write(Buffer.from([7]));
        setTimeout(() => response.socket?.destroy(), 10);
        return;
      default:
        response.writeHead(404);
        response.end();
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  try {
    const { port } = server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${port}`;
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    expect(await page.evaluate(async () => (await fetch("/cookie-probe")).text()))
      .toBe("cookie observed");
    expect(state.cookieProbe).toContain("closed-source-session=present");

    // Execute Vite's transformation of the real host source from the same
    // origin as the native transport endpoints. This keeps root-relative
    // source URLs meaningful without weakening the browser's CORS policy.
    const moduleUrl = `${origin}/closed-lazy-assets.ts`;
    const sha256 = createHash("sha256").update(decodedPayload).digest("hex");
    const result = await page.evaluate(async ({ moduleUrl, sha256, size }) => {
      const { loadClosedLazyAssetSources } = await import(
        /* @vite-ignore */ moduleUrl
      );
      const binding = (sourceUrl: string, index: number, expectedSize = 3) => ({
        url: `https://example.test/releases/v1/asset-${index}.bin`,
        sourceUrl,
        sha256: "0".repeat(64),
        size: expectedSize,
      });
      const rejection = async (promise: Promise<unknown>) => {
        try {
          await promise;
          return { rejected: false, name: "", message: "" };
        } catch (error) {
          return {
            rejected: true,
            name: error instanceof Error ? error.name : typeof error,
            message: error instanceof Error ? error.message : String(error),
          };
        }
      };

      const loaded = await loadClosedLazyAssetSources([{
        url: "https://example.test/releases/v1/gzip.bin",
        sourceUrl: "/gzip?credential-check=private",
        sha256,
        size,
      }]);
      const redirect = await rejection(loadClosedLazyAssetSources([
        binding("/redirect", 1, 1),
      ]));
      const overflow = await rejection(loadClosedLazyAssetSources([
        binding("/overflow", 2),
      ]));
      const streamError = await rejection(loadClosedLazyAssetSources([
        binding("/stream-error", 3),
      ]));

      const controller = new AbortController();
      const abortReason = new Error("browser caller stopped lazy loading");
      let abortTimer: ReturnType<typeof setTimeout> | undefined;
      const slowPromise = loadClosedLazyAssetSources([
        binding("/slow", 4),
      ], {
        signal: controller.signal,
        fetchImpl: async (input: string | URL, init?: RequestInit) => {
          const response = await fetch(input, init);
          abortTimer = setTimeout(() => controller.abort(abortReason), 10);
          return response;
        },
      });
      let slowSameReason = false;
      const slow = await slowPromise.then(
        () => ({ rejected: false, name: "", message: "" }),
        (error: unknown) => {
          slowSameReason = error === abortReason;
          return {
            rejected: true,
            name: error instanceof Error ? error.name : typeof error,
            message: error instanceof Error ? error.message : String(error),
          };
        },
      );
      if (abortTimer !== undefined) clearTimeout(abortTimer);

      return {
        capabilities: {
          cryptoDigest: typeof crypto.subtle.digest,
          readableStream: typeof ReadableStream,
          secureContext: isSecureContext,
        },
        gzipBytes: Array.from(loaded[0]!.bytes),
        redirect,
        overflow,
        streamError,
        slow,
        slowSameReason,
      };
    }, {
      moduleUrl,
      sha256,
      size: decodedPayload.byteLength,
    });

    expect(result.capabilities).toEqual({
      cryptoDigest: "function",
      readableStream: "function",
      secureContext: true,
    });
    expect(Buffer.from(result.gzipBytes)).toEqual(decodedPayload);
    expect(encodedPayload.byteLength).not.toBe(decodedPayload.byteLength);
    expect(state.gzipCookie).toBe("");
    expect(state.gzipReferer).toBe("");
    expect(result.redirect.rejected).toBe(true);
    expect(state.redirectTargetHits).toBe(0);
    expect(result.overflow).toMatchObject({
      rejected: true,
      message: expect.stringContaining("exceeds 3 bytes"),
    });
    expect(result.streamError.rejected).toBe(true);
    expect(result.slow).toMatchObject({
      rejected: true,
      message: "browser caller stopped lazy loading",
    });
    expect(result.slowSameReason).toBe(true);
    await expect.poll(() => state.overflowClosed).toBe(true);
    await expect.poll(() => state.slowClosed).toBe(true);
    await expect.poll(() => state.streamErrorClosed).toBe(true);
    expect(state.overflowFinished).toBe(false);
    expect(state.slowFinished).toBe(false);
  } finally {
    for (const response of streamingResponses) response.destroy();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
