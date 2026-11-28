// Flags: --expose-internals
'use strict';

const assert = require('node:assert/strict');
const { internalBinding } = require('internal/test/binding');
const { arrayBufferViewHasBuffer } = internalBinding('util');

const constructors = {
  Uint8Array: (length) => new Uint8Array(length),
  Uint32Array: (length) => new Uint32Array(length / 4),
  BufferAlloc: (length) => Buffer.alloc(length),
  BufferAllocUnsafeSlow: (length) => Buffer.allocUnsafeSlow(length),
};

for (const [kind, create] of Object.entries(constructors)) {
  const sizes = [0, 48, 63, 64, 65, 68, 88, 96, 104, 112, 120, 128, 1024];
  for (const size of sizes) {
    if (kind === 'Uint32Array' && size % 4 !== 0) continue;
    const view = create(size);
    const before = arrayBufferViewHasBuffer(view);
    if (view.length) view[0] = 37;
    const buffer = view.buffer;
    assert.equal(view.byteLength, size);
    assert.equal(arrayBufferViewHasBuffer(view), true);
    assert.equal(view.buffer, buffer);
    assert.equal(buffer.byteLength, size);
    if (view.length) {
      const alias = new (kind === 'Uint32Array' ? Uint32Array : Uint8Array)(buffer, view.byteOffset, view.length);
      assert.equal(alias[0], 37);
      alias[0] = 12;
      assert.equal(view[0], 12);
    }
    console.log(JSON.stringify({ kind, bytes: size, before, after: true }));
  }
}
