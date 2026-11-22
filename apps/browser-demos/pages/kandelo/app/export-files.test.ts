import assert from "node:assert/strict";
import { test } from "node:test";
import { unzipSync } from "fflate";
import type { KernelVfsReader } from "../../../../../web-libs/kandelo-session/src/kernel-host";
import { BUFFERED_ZIP_LIMIT, createExportSink, exportFilesZip, type ExportSink } from "./export-files";
import { openReferenceFiles } from "../kernel-host/reference-files";

function output() {
  const chunks: Uint8Array[] = [];
  let closed = false;
  let aborted = false;
  const sink: ExportSink = {
    write: async chunk => { chunks.push(chunk); },
    close: async () => { closed = true; },
    abort: async () => { aborted = true; },
  };
  return { sink, chunks, get closed() { return closed; }, get aborted() { return aborted; } };
}

test("chunks large files, reads empty files, preserves Unix link metadata, and awaits sink backpressure", async () => {
  const content = new Uint8Array(700000).map((_, index) => index % 251);
  const reads: number[] = [];
  let writing = false;
  const metadata = (name: string, mode: number, size: number, target?: string) => ({ name, mode, size, uid: 1000, gid: 1000, target });
  const reader: KernelVfsReader = {
    readDir: async () => [metadata("data.bin", 0o100755, content.length), metadata("empty", 0o100644, 0), metadata("link", 0o120777, 8, "data.bin")],
    readRange: async (path, offset, length) => {
      assert.equal(writing, false);
      assert.ok(length <= 262144);
      reads.push(length);
      return path === "/empty" ? new Uint8Array() : content.slice(offset, offset + length);
    },
  };
  const target = output();
  const original = target.sink.write;
  target.sink.write = async chunk => {
    assert.equal(writing, false);
    writing = true;
    await new Promise(resolve => setTimeout(resolve, 0));
    await original(chunk);
    writing = false;
  };
  await exportFilesZip(reader, "/", target.sink, new AbortController().signal, () => {});
  assert.equal(target.closed, true);
  assert.deepEqual(reads, [262144, 262144, 175712, 1]);
  const zip = Buffer.concat(target.chunks);
  const files = unzipSync(zip);
  assert.deepEqual(files["data.bin"], content);
  assert.equal(files["empty"].length, 0);
  assert.equal(new TextDecoder().decode(files["link"]), "data.bin");
  const modes = new Map<string, number>();
  for (let offset = 0; offset < zip.length - 46; offset++) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) continue;
    const length = zip.readUInt16LE(offset + 28);
    modes.set(zip.subarray(offset + 46, offset + 46 + length).toString(), zip.readUInt32LE(offset + 38) >>> 16);
  }
  assert.equal(modes.get("data.bin"), 0o100755);
  assert.equal(modes.get("link"), 0o120777);
});

test("missing data, malicious names, and write failures abort without completing the archive", async () => {
  for (const scenario of ["missing", "unsafe", "write"] as const) {
    const target = output();
    if (scenario === "write") target.sink.write = async () => { throw new Error("disk full"); };
    const reader: KernelVfsReader = {
      readDir: async () => [{ name: scenario === "unsafe" ? "../escape" : "file", mode: 0o100644, uid: 0, gid: 0, size: 2 }],
      readRange: async () => scenario === "missing" ? null : new Uint8Array([1, 2]),
    };
    await assert.rejects(exportFilesZip(reader, "/", target.sink, new AbortController().signal, () => {}));
    assert.equal(target.closed, false);
    assert.equal(target.aborted, true);
  }
});

test("buffered saves enforce the advertised archive-size limit", async () => {
  Object.assign(globalThis, { window: {} });
  try {
    const sink = await createExportSink("test.zip", new AbortController().signal);
    const chunk = new Uint8Array(1024 * 1024);
    for (let length = 0; length < BUFFERED_ZIP_LIMIT; length += chunk.length) await sink.write(chunk);
    await assert.rejects(sink.write(chunk), /256 MB/);
    await sink.abort();
  } finally {
    Reflect.deleteProperty(globalThis, "window");
  }
});

test("comparison omits byte-identical files, preserves additions and metadata changes, and handles type replacements", async () => {
  const entry = (name: string, mode = 0o100644, size = 3) => ({ name, mode, size, uid: 1000, gid: 1000 });
  const original = [entry("same"), entry("edited"), entry("mode"), entry("removed"), entry("was-link", 0o120777), entry("empty", 0o40755, 0)];
  const current = [entry("same"), entry("edited"), entry("mode", 0o100755), entry("new"), entry("was-link", 0o40755, 0), entry("empty", 0o40755, 0), entry("new-empty", 0o40755, 0)];
  const reader: KernelVfsReader = {
    readDir: async path => path === "/" ? current : path === "/was-link" ? [entry("child")] : [],
    readRange: async (path, offset, length) => new TextEncoder().encode(path === "/edited" ? "new" : "old").slice(offset, offset + length),
  };
  const reference: KernelVfsReader = {
    readDir: async path => { assert.notEqual(path, "/was-link"); return path === "/" ? original : []; },
    readRange: async (_path, offset, length) => new TextEncoder().encode("old").slice(offset, offset + length),
  };
  const target = output();
  const result = await exportFilesZip(reader, "/", target.sink, new AbortController().signal, () => {}, reference);
  assert.equal(result.unchanged, 1);
  assert.deepEqual(Object.keys(unzipSync(Buffer.concat(target.chunks))).sort(), ["edited", "mode", "new", "new-empty/", "was-link/", "was-link/child"]);
  const selected = output();
  await exportFilesZip(reader, "/was-link", selected.sink, new AbortController().signal, () => {}, reference);
  assert.deepEqual(Object.keys(unzipSync(Buffer.concat(selected.chunks))), ["child"]);
});

test("reference read failure fails the export instead of treating an unreadable original as a new file", async () => {
  const reader: KernelVfsReader = { readDir: async () => [{ name: "file", mode: 0o100644, size: 1, uid: 0, gid: 0 }], readRange: async () => new Uint8Array([1]) };
  const target = output();
  await assert.rejects(exportFilesZip(reader, "/", target.sink, new AbortController().signal, () => {}, { ...reader, readRange: async () => null }), /Cannot compare file/);
  assert.equal(target.aborted, true);
  assert.equal(target.closed, false);
});

test("reference ownership waits for initialization before retirement and releases its source exactly once", async () => {
  const events: string[] = [];
  let complete!: () => void;
  const controller = new AbortController();
  const opening = openReferenceFiles(
    () => ({ destroy: async () => { events.push("destroy"); }, readDirFromVfs: async () => [], readFileRangeFromVfs: async () => new Uint8Array() }),
    () => new Promise<void>(resolve => { complete = resolve; }),
    controller.signal, () => {}, async () => { events.push("release"); },
  );
  controller.abort();
  assert.equal(events.length, 0);
  complete();
  await assert.rejects(opening, { name: "AbortError" });
  assert.deepEqual(events, ["destroy", "release"]);
  const reader = await openReferenceFiles(
    () => ({ destroy: async () => { events.push("destroy"); }, readDirFromVfs: async () => [], readFileRangeFromVfs: async () => new Uint8Array() }),
    async () => {}, new AbortController().signal, () => {}, async () => { events.push("release"); },
  );
  assert.deepEqual(await reader.readDir("/"), []);
  await reader.dispose();
  await reader.dispose();
  assert.deepEqual(events, ["destroy", "release", "destroy", "release"]);
  await assert.rejects(reader.readDir("/"), /closed/);
});
