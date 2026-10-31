import assert from "node:assert/strict";
import { test } from "node:test";
import { ensurePersistentProfileAssets, MAX_PROFILE_ASSET_BYTES } from "./persistent-profile-assets";

const asset = { path: "/game.data", url: "https://example.com/game.data", sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" };

function fixture() {
  const writes: { path: string; bytes: Uint8Array; mode: number }[] = [];
  const removals: string[] = [];
  const kernel: Parameters<typeof ensurePersistentProfileAssets>[0] = {
    statVfsPath: async () => null,
    writeFileToVfs: async (path, bytes, mode = 0o644) => { writes.push({ path, bytes, mode }); },
    unlinkFileFromVfs: async path => { removals.push(path); return true; },
  };
  return { kernel, writes, removals };
}

test("profile assets verify before publication; existing user files are preserved", async context => {
  const { kernel, writes } = fixture();
  const fetch = context.mock.method(globalThis, "fetch", async () => new Response("abc"));
  await ensurePersistentProfileAssets(kernel, [asset], () => {}, () => {});
  assert.equal(new TextDecoder().decode(writes[0].bytes), "abc");
  assert.equal(writes[0].mode, 0o644);
  kernel.statVfsPath = async () => ({ mode: 0o100644 } as Awaited<ReturnType<typeof kernel.statVfsPath>>);
  await ensurePersistentProfileAssets(kernel, [asset], () => {}, () => {});
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(writes.length, 1);
});

test("bad digests and HTTP failures publish no asset", async context => {
  const { kernel, writes } = fixture();
  const fetch = context.mock.method(globalThis, "fetch", async () => new Response("wrong"));
  await assert.rejects(ensurePersistentProfileAssets(kernel, [asset], () => {}, () => {}), /sha256 mismatch/);
  fetch.mock.mockImplementation(async () => new Response("missing", { status: 404 }));
  await assert.rejects(ensurePersistentProfileAssets(kernel, [asset], () => {}, () => {}), /404/);
  assert.equal(writes.length, 0);
});

test("failed writes remove only the newly installed asset", async context => {
  const { kernel, removals } = fixture();
  context.mock.method(globalThis, "fetch", async () => new Response("abc"));
  kernel.writeFileToVfs = async () => { throw new Error("quota full"); };
  await assert.rejects(ensurePersistentProfileAssets(kernel, [asset], () => {}, () => {}), /quota full/);
  assert.deepEqual(removals, [asset.path]);
  kernel.unlinkFileFromVfs = async () => { throw new Error("cleanup failed"); };
  await assert.rejects(ensurePersistentProfileAssets(kernel, [asset], () => {}, () => {}), AggregateError);
});

test("oversized profile asset intake is cancelled before publication", async context => {
  const { kernel, writes } = fixture();
  const chunk = new Uint8Array(MAX_PROFILE_ASSET_BYTES / 2 + 1);
  let cancelled = false;
  context.mock.method(globalThis, "fetch", async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(chunk); controller.enqueue(chunk); },
    cancel() { cancelled = true; },
  })));
  await assert.rejects(ensurePersistentProfileAssets(kernel, [asset], () => {}, () => {}), /staging limit/);
  assert.equal(cancelled, true);
  assert.equal(writes.length, 0);
});

test("the asset budget is shared by all missing assets in one boot", async context => {
  const { kernel, writes } = fixture();
  const bytes = new Uint8Array(MAX_PROFILE_ASSET_BYTES / 2 + 1);
  context.mock.method(globalThis, "fetch", async () => new Response(bytes));
  await assert.rejects(ensurePersistentProfileAssets(kernel, [{ ...asset, sha256: undefined }, { ...asset, path: "/other.data", sha256: undefined }], () => {}, () => {}), /staging limit/);
  assert.equal(writes.length, 1);
});

test("superseded asset preparation cannot publish bytes", async context => {
  const { kernel, writes } = fixture();
  let current = true;
  context.mock.method(globalThis, "fetch", async () => { current = false; return new Response("abc"); });
  await assert.rejects(ensurePersistentProfileAssets(kernel, [asset], () => {}, () => { if (!current) throw new Error("superseded"); }), /superseded/);
  assert.equal(writes.length, 0);
});
