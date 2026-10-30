import assert from "node:assert/strict";
import { test } from "vitest";
import { readFileSync } from "node:fs";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";
import { sparseComposerFileImage } from "./fixtures/sparse-composer-file-image";
import { COMPOSER_READ_CHUNK_BYTES, MAX_COMPOSER_FILE_BYTES, readComposerFile } from "../../apps/browser-demos/pages/kandelo/kernel-host/composer-file";

function filesystem(length: number) {
  let opened = 0;
  let closed = 0;
  let largest = 0;
  let offset = 0;
  const instance = {
    stat: () => ({ size: length }),
    open: () => { opened++; return 42; },
    read: (_descriptor: number, destination: Uint8Array, _position: number | null, count: number) => {
      largest = Math.max(largest, count);
      destination.fill(offset % 251);
      offset += count;
      return count;
    },
    close: () => { closed++; },
  } as unknown as Parameters<typeof readComposerFile>[0];
  return { instance, usage: () => ({ opened, closed, largest, offset }) };
}

test("composer refuses oversized and invalid file lengths before opening or reading", () => {
  for (const length of [MAX_COMPOSER_FILE_BYTES + 1, 2 ** 40, -1, NaN, Infinity]) {
    const fixture = filesystem(length);
    assert.throws(() => readComposerFile(fixture.instance, "/etc/php.ini"), { code: "ENOMEM" });
    assert.deepEqual(fixture.usage(), { opened: 0, closed: 0, largest: 0, offset: 0 });
  }
});

test("composer reads a supported input in bounded transfers without a final full copy", () => {
  const fixture = filesystem(MAX_COMPOSER_FILE_BYTES);
  const output = readComposerFile(fixture.instance, "/config");
  assert.equal(output.byteLength, MAX_COMPOSER_FILE_BYTES);
  assert.deepEqual(fixture.usage(), { opened: 1, closed: 1, largest: COMPOSER_READ_CHUNK_BYTES, offset: output.byteLength });
});

test("composer rejects early EOF and invalid progress and closes the descriptor", () => {
  for (const count of [0, -1, NaN, Infinity, 4]) {
    const fixture = filesystem(3);
    fixture.instance.read = () => count;
    assert.throws(() => readComposerFile(fixture.instance, "/config"), { code: "EIO" });
    assert.equal(fixture.usage().closed, 1);
  }
});

test("composer accepts empty files and preserves read errors after closing", () => {
  const empty = filesystem(0);
  assert.equal(readComposerFile(empty.instance, "/empty").byteLength, 0);
  assert.equal(empty.usage().closed, 1);
  const fixture = filesystem(1);
  const failure = new Error("storage read failed");
  fixture.instance.read = () => { throw failure; };
  assert.throws(() => readComposerFile(fixture.instance, "/config"), error => error === failure);
  assert.equal(fixture.usage().closed, 1);
});

test("composer admits real sparse native files before reading their contents", () => {
  const module = new Uint8Array(readFileSync(new URL("../../local-binaries/kandelo_image_module_positioned32.wasm", import.meta.url)));
  for (const length of [MAX_COMPOSER_FILE_BYTES, MAX_COMPOSER_FILE_BYTES + 1, 8 * 1024 ** 3]) {
    const image = sparseComposerFileImage(length);
    let largestSourceRead = 0;
    const filesystem = KandeloImageFs.createFromPositionedImage(module, image.length, (offset, destination) => {
      largestSourceRead = Math.max(largestSourceRead, destination.length);
      const bytes = image.subarray(offset, offset + destination.length);
      destination.set(bytes);
      return bytes.length;
    });
    assert.equal(filesystem.stat("/etc/php.ini").size, length);
    const memoryBefore = filesystem.transientBuffer.byteLength;
    let opened = 0;
    let largestFileRead = 0;
    const open = filesystem.open.bind(filesystem);
    const read = filesystem.read.bind(filesystem);
    filesystem.open = (...args) => { opened++; return open(...args); };
    filesystem.read = (...args) => { largestFileRead = Math.max(largestFileRead, args[3] ?? 0); return read(...args); };
    if (length <= MAX_COMPOSER_FILE_BYTES) {
      const result = new Uint8Array(readComposerFile(filesystem, "/etc/php.ini"));
      assert.equal(result.length, length);
      assert.ok(result.every(byte => byte === 0));
      assert.equal(opened, 1);
      assert.equal(largestFileRead, COMPOSER_READ_CHUNK_BYTES);
    } else {
      assert.throws(() => readComposerFile(filesystem, "/etc/php.ini"), { code: "ENOMEM" });
      assert.equal(opened, 0);
      assert.equal(largestFileRead, 0);
      assert.ok(filesystem.transientBuffer.byteLength <= memoryBefore + 65536);
    }
    assert.ok(largestSourceRead <= 4096);
    assert.ok(filesystem.transientBuffer.byteLength <= 32 * 1024 * 1024);
  }
});
