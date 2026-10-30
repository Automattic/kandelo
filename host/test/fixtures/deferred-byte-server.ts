import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";

export interface DeferredByteServer {
  url: string;
  size: number;
  sha256: string;
  requested: Promise<void>;
  requests(): number;
  firstChunkDelayMs(): number | undefined;
  close(): Promise<void>;
}

export async function startDeferredByteServer(
  size: number,
  options: { chunkBytes?: number; chunkDelayMs?: number; stall?: boolean } = {},
): Promise<DeferredByteServer> {
  const block = Buffer.alloc(options.chunkBytes ?? 64 * 1024, 86);
  const hash = createHash("sha256");
  for (let offset = 0; offset < size; offset += block.byteLength) {
    hash.update(block.subarray(0, Math.min(block.byteLength, size - offset)));
  }
  let requests = 0;
  let firstChunkDelayMs: number | undefined;
  let notifyRequest!: () => void;
  const requested = new Promise<void>(resolve => { notifyRequest = resolve; });
  const server = createServer((request, response) => {
    if (request.url !== "/verified-reader") {
      response.writeHead(404).end();
      return;
    }
    requests++;
    const started = performance.now();
    notifyRequest();
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": String(size),
      "access-control-allow-origin": "*",
      "cross-origin-resource-policy": "cross-origin",
    });
    response.flushHeaders();
    if (options.stall) return;
    const controller = new AbortController();
    const body = Readable.from((async function* () {
      for (let offset = 0; offset < size; offset += block.byteLength) {
        if (options.chunkDelayMs) await delay(options.chunkDelayMs, undefined, { signal: controller.signal });
        firstChunkDelayMs ??= performance.now() - started;
        yield block.subarray(0, Math.min(block.byteLength, size - offset));
      }
    })(), { objectMode: false });
    response.once("close", () => { controller.abort(); body.destroy(); });
    body.once("error", error => response.destroy(error));
    body.pipe(response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Deferred byte server has no port");
  let closing: Promise<void> | undefined;
  return {
    url: `http://127.0.0.1:${address.port}/verified-reader`,
    size,
    sha256: hash.digest("hex"),
    requested,
    requests: () => requests,
    firstChunkDelayMs: () => firstChunkDelayMs,
    close: () => {
      if (closing === undefined) {
        closing = new Promise<void>((resolve, reject) => {
          server.close(error => error ? reject(error) : resolve());
          server.closeAllConnections();
        });
      }
      return closing;
    },
  };
}
