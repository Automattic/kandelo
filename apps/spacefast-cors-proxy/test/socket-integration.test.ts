import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type Server } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import { setEndpoint, connections } from "./support/node-sockets.ts";
import { createCorsProxy } from "../src/proxy.ts";

const cert = readFileSync(new URL("./fixtures/tls-cert.pem", import.meta.url), "utf8");
// Disposable fixture key, never used by a deployed service.
const key = readFileSync(new URL("./fixtures/tls-key.pem", import.meta.url), "utf8");
const proxyUrl = (target: string) => `https://proxy.example/?url=${encodeURIComponent(target)}`;
async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string"); return address.port;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  setEndpoint();
}

test("production transport import uses real HTTP sockets: POST, HEAD, ranges and opaque gzip", async t => {
  const entity = Buffer.from("0123456789abcdef");
  const records: { body: Buffer; method?: string; headers: Record<string, unknown> }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    records.push({ body: Buffer.concat(chunks), method: req.method, headers: req.headers });
    if (req.url === "/gzip") {
      const gzip = gzipSync(entity);
      res.writeHead(200, { "Content-Encoding": "gzip", "Content-Length": gzip.length }); res.end(gzip);
    } else if (req.headers.range) {
      res.writeHead(206, { "Content-Range": "bytes 4-7/16", "Content-Length": 4, ETag: '"version"' }); res.end(entity.subarray(4, 8));
    } else { res.writeHead(200, { "Content-Length": entity.length }); res.end(entity); }
  });
  const port = await listen(server); t.after(() => close(server)); setEndpoint({ port });
  t.mock.method(globalThis, "fetch", async () => Response.json({ Status: 0, Answer: [{ type: 1, data: "8.8.8.8" }] }));
  const proxy = createCorsProxy({ disableRateLimit: true });
  const post = await proxy(new Request(proxyUrl("http://public.example/post"), { method: "POST",
    body: new Uint8Array([0, 255, 13, 10]), headers: {
      "Content-Type": "application/x-git-upload-pack-request", Authorization: "Bearer guest",
      "X-Cors-Proxy-Allowed-Request-Headers": "authorization", "git-protocol": "version=2",
    } }));
  assert.deepEqual(Buffer.from(await post.arrayBuffer()), entity);
  assert.deepEqual(records[0].body, Buffer.from([0, 255, 13, 10]));
  assert.equal(records[0].headers["authorization"], "Bearer guest");
  assert.equal(records[0].headers["host"], "public.example");
  const range = await proxy(new Request(proxyUrl("http://public.example/range"), { headers: { "X-Cors-Proxy-Range": "bytes=4-7" } }));
  assert.equal(range.status, 206); assert.equal(await range.text(), "4567");
  assert.equal(range.headers.get("content-range"), "bytes 4-7/16");
  const head = await proxy(new Request(proxyUrl("http://public.example/head"), { method: "HEAD" }));
  assert.equal(head.headers.get("content-length"), "16"); assert.equal(await head.text(), "");
  const gzip = await proxy(new Request(proxyUrl("http://public.example/gzip")));
  assert.equal(gzip.headers.get("content-encoding"), "gzip");
  assert.deepEqual(gunzipSync(Buffer.from(await gzip.arrayBuffer())), entity);
  assert.ok(connections.every(record => record.hostname === "8.8.8.8" && record.port === 80));
});

test("production transport negotiates TLS for the original hostname while connecting to the pinned IP", async t => {
  const server = createHttpsServer({ key, cert }, (_req, res) => res.end("secure"));
  server.on("tlsClientError", () => {});
  const port = await listen(server); t.after(() => close(server)); setEndpoint({ port, ca: cert });
  t.mock.method(globalThis, "fetch", async () => Response.json({ Status: 0, Answer: [{ type: 1, data: "8.8.8.8" }] }));
  const proxy = createCorsProxy({ disableRateLimit: true });
  const good = await proxy(new Request(proxyUrl("https://public.example/")));
  assert.equal(good.status, 200); assert.equal(await good.text(), "secure");
  assert.equal(connections[0].hostname, "8.8.8.8"); assert.equal(connections[0].tlsName, "public.example");
  const bad = await proxy(new Request(proxyUrl("https://wrong.example/")));
  assert.equal(bad.status, 502); assert.equal(await bad.text(), "Bad Gateway");
  setEndpoint({ port });
  const untrusted = await proxy(new Request(proxyUrl("https://public.example/")));
  assert.equal(untrusted.status, 502); assert.equal(await untrusted.text(), "Bad Gateway");
});

test("real streaming sockets deliver early chunks and close when the client cancels", async t => {
  let finish!: () => void;
  let observedClose!: () => void;
  const closed = new Promise<void>(resolve => { observedClose = resolve; });
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" }); res.write("first");
    finish = () => res.end("last"); res.once("close", observedClose);
  });
  const port = await listen(server); t.after(() => close(server)); setEndpoint({ port });
  const proxy = createCorsProxy({ disableRateLimit: true });
  const streamed = await proxy(new Request(proxyUrl("http://8.8.8.8/stream")));
  const reader = streamed.body!.getReader();
  assert.equal(new TextDecoder().decode((await reader.read()).value), "first");
  finish(); assert.equal(new TextDecoder().decode((await reader.read()).value), "last");
  assert.equal((await reader.read()).done, true);
  await closed;
  let cancelClosed!: () => void;
  const cancelled = new Promise<void>(resolve => { cancelClosed = resolve; });
  observedClose = cancelClosed;
  const abandoned = await proxy(new Request(proxyUrl("http://8.8.8.8/stream")));
  await abandoned.body!.cancel(); await cancelled;
});
