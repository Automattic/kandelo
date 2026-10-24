import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { startPersistentImageSource } from "./persistent-image-source.ts";

test("image source streams uncached bytes and rejects later image requests without blocking other assets", async () => {
  const bytes = Buffer.alloc(1024 * 1024, 37);
  const upstream = createServer((request, response) => {
    if (request.url === "/assets/image.vfs.zst?version=1") {
      response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": bytes.length });
      response.end(bytes);
    } else { response.writeHead(200).end("other asset"); }
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert(address !== null && typeof address !== "string");
  const source = await startPersistentImageSource(`http://127.0.0.1:${address.port}/assets/image.vfs.zst?version=1`);
  try {
    const first = await fetch(source.url);
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("Cache-Control"), "no-store");
    assert.equal(first.headers.get("Access-Control-Allow-Origin"), "*");
    assert.deepEqual(Buffer.from(await first.arrayBuffer()), bytes);
    assert.deepEqual(source.observations(), { imageRequests: 1, refusedImageRequests: 0 });
    source.disableImage();
    const refused = await fetch(source.url);
    assert.equal(refused.status, 503);
    await refused.arrayBuffer();
    assert.deepEqual(source.observations(), { imageRequests: 2, refusedImageRequests: 1 });
    const cacheBusted = new URL(source.url);
    cacheBusted.searchParams.set("cacheBust", "next-boot");
    const refusedVariant = await fetch(cacheBusted);
    assert.equal(refusedVariant.status, 503);
    await refusedVariant.arrayBuffer();
    assert.deepEqual(source.observations(), { imageRequests: 3, refusedImageRequests: 2 });
    const other = await fetch(new URL("/assets/program.wasm", source.url));
    assert.equal(await other.text(), "other asset");
    assert.deepEqual(source.observations(), { imageRequests: 3, refusedImageRequests: 2 });
  } finally {
    await source.close();
    await new Promise<void>((resolve, reject) => { upstream.close(error => error ? reject(error) : resolve()); upstream.closeAllConnections(); });
  }
});

test("independent image sources do not share their enable state", async () => {
  const upstream = createServer((_request, response) => response.writeHead(200).end("image"));
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert(address !== null && typeof address !== "string");
  const original = `http://127.0.0.1:${address.port}/image.vfs.zst`;
  const first = await startPersistentImageSource(original);
  const second = await startPersistentImageSource(original);
  try {
    first.disableImage();
    const denied = await fetch(first.url);
    assert.equal(denied.status, 503);
    await denied.arrayBuffer();
    assert.equal(await (await fetch(second.url)).text(), "image");
    assert.deepEqual(first.observations(), { imageRequests: 1, refusedImageRequests: 1 });
    assert.deepEqual(second.observations(), { imageRequests: 1, refusedImageRequests: 0 });
  } finally {
    await first.close();
    await second.close();
    await new Promise<void>((resolve, reject) => { upstream.close(error => error ? reject(error) : resolve()); upstream.closeAllConnections(); });
  }
});

test("image source rejects non-HTTP inputs", async () => {
  await assert.rejects(startPersistentImageSource("file:///tmp/image.vfs"), /HTTP/);
});

test("closing an image source aborts its owned stream and is idempotent", { timeout: 5000 }, async () => {
  let markClosed = () => {};
  const closed = new Promise<void>(resolve => { markClosed = resolve; });
  const upstream = createServer((_request, response) => {
    response.once("close", markClosed);
    response.writeHead(200);
    response.write(Buffer.alloc(64 * 1024, 7));
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert(address !== null && typeof address !== "string");
  const source = await startPersistentImageSource(`http://127.0.0.1:${address.port}/image.vfs.zst`);
  try {
    const response = await fetch(source.url);
    const body = assert.rejects(response.arrayBuffer());
    await source.close();
    await body;
    await closed;
    await source.close();
  } finally {
    await source.close();
    await new Promise<void>((resolve, reject) => { upstream.close(error => error ? reject(error) : resolve()); upstream.closeAllConnections(); });
  }
});
