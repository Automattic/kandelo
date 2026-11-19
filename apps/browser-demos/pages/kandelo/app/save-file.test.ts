import assert from "node:assert/strict";
import { afterEach, beforeEach, mock, test } from "node:test";

import { canStreamSave, saveFile } from "./save-file.ts";

const globals = globalThis as unknown as { window?: unknown; document?: unknown };

function bytes(text: string): () => ReadableStream<Uint8Array> {
  return () => new Response(text).body!;
}

beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout"] });
});

afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
  delete globals.window;
  delete globals.document;
});

test("the picker streams the file to disk under its name", async () => {
  const written: Uint8Array[] = [];
  let suggestedName: string | undefined;
  globals.window = {
    showSaveFilePicker: async (options: { suggestedName?: string }) => {
      suggestedName = options.suggestedName;
      return { createWritable: async () => new WritableStream<Uint8Array>({ write: chunk => { written.push(chunk); } }) };
    },
  };
  assert.equal(canStreamSave(), true);
  assert.equal(await saveFile("foo.txt", undefined, bytes("bar")), true);
  assert.equal(suggestedName, "foo.txt");
  assert.equal(Buffer.concat(written).toString(), "bar");
});

test("a cancelled picker saves nothing and never reads the file", async () => {
  let read = false;
  globals.window = { showSaveFilePicker: async () => { throw new DOMException("cancelled", "AbortError"); } };
  assert.equal(await saveFile("foo.txt", undefined, () => { read = true; return bytes("bar")(); }), false);
  assert.equal(read, false);
});

test("a refused picker reaches the caller", async () => {
  globals.window = { showSaveFilePicker: async () => { throw new DOMException("no activation", "SecurityError"); } };
  await assert.rejects(saveFile("foo.txt", undefined, bytes("bar")), { name: "SecurityError" });
});

function anchorSave(): { saved: () => { name: string; blob: Blob } | null; revoked: string[] } {
  let saved: { name: string; blob: Blob } | null = null;
  const blobs = new Map<string, Blob>();
  const revoked: string[] = [];
  globals.window = {};
  globals.document = {
    createElement: () => {
      const link = { href: "", download: "", click: () => { saved = { name: link.download, blob: blobs.get(link.href)! }; } };
      return link;
    },
  };
  mock.method(URL, "createObjectURL", (blob: Blob) => {
    const url = `blob:${blobs.size}`;
    blobs.set(url, blob);
    return url;
  });
  mock.method(URL, "revokeObjectURL", (url: string) => { revoked.push(url); });
  return { saved: () => saved, revoked };
}

test("without a picker the file is saved through a link with its type", async () => {
  const anchor = anchorSave();
  assert.equal(canStreamSave(), false);
  assert.equal(await saveFile("foo.txt", "text/plain", bytes("bar")), true);
  assert.equal(anchor.saved()!.name, "foo.txt");
  assert.equal(anchor.saved()!.blob.type, "text/plain");
  assert.equal(await anchor.saved()!.blob.text(), "bar");
  assert.deepEqual(anchor.revoked, []);
  mock.timers.tick(60_000);
  assert.deepEqual(anchor.revoked, ["blob:0"]);
});

test("without a type the link saves the bytes untyped", async () => {
  const anchor = anchorSave();
  assert.equal(await saveFile("foo.bin", undefined, bytes("baz")), true);
  assert.equal(anchor.saved()!.blob.type, "");
  assert.equal(await anchor.saved()!.blob.text(), "baz");
});
