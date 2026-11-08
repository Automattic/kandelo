import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface PersistentImageSource {
  readonly url: string;
  disableImage(): void;
  observations(): { imageRequests: number; refusedImageRequests: number };
  close(): Promise<void>;
}

export async function startPersistentImageSource(
  imageUrl: string,
  headers?: Record<string, string>,
): Promise<PersistentImageSource> {
  const source = new URL(imageUrl);
  if (source.protocol !== "http:" && source.protocol !== "https:") {
    throw new Error("persistent image test source must use HTTP or HTTPS");
  }
  let enabled = true;
  let imageRequests = 0;
  let refusedImageRequests = 0;
  const pending = new Set<AbortController>();
  let closing: Promise<void> | undefined;
  const server = createServer(async (request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", request.headers["access-control-request-headers"] ?? "*");
    response.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    response.setHeader("Cache-Control", "no-store");
    if (request.method === "OPTIONS") { response.writeHead(204).end(); return; }
    if (request.method !== "GET" && request.method !== "HEAD") { response.writeHead(405).end(); return; }
    const requested = new URL(request.url ?? "/", "http://127.0.0.1");
    const image = requested.pathname === source.pathname;
    if (image) {
      imageRequests++;
      if (!enabled) {
        refusedImageRequests++;
        response.writeHead(503).end("The persistent computer's installation image is unavailable");
        return;
      }
    }
    const upstream = new URL(source);
    upstream.pathname = requested.pathname;
    upstream.search = requested.search;
    const controller = new AbortController();
    pending.add(controller);
    response.once("close", () => controller.abort());
    try {
      const result = await fetch(upstream, {
        method: request.method, headers, redirect: "error", signal: controller.signal,
      });
      const contentType = result.headers.get("Content-Type");
      if (contentType !== null) response.setHeader("Content-Type", contentType);
      const encoding = result.headers.get("Content-Encoding");
      const length = result.headers.get("Content-Length");
      if (length !== null && (encoding === null || encoding === "identity")) response.setHeader("Content-Length", length);
      response.writeHead(result.status);
      if (result.body === null || request.method === "HEAD") {
        await result.body?.cancel();
        response.end();
      } else {
        await pipeline(Readable.fromWeb(result.body), response);
      }
    } catch (error) {
      if (!response.headersSent) response.writeHead(502).end(String(error));
      else response.destroy(error instanceof Error ? error : new Error(String(error)));
    } finally {
      pending.delete(controller);
    }
  });
  server.maxConnections = 16;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("persistent image test source has no TCP address");
  const exposed = new URL(`http://127.0.0.1:${address.port}`);
  exposed.pathname = source.pathname;
  exposed.search = source.search;
  return {
    url: exposed.href,
    disableImage: () => { enabled = false; },
    observations: () => ({ imageRequests, refusedImageRequests }),
    close: () => {
      if (closing !== undefined) return closing;
      for (const controller of pending) controller.abort();
      closing = new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
      return closing;
    },
  };
}
