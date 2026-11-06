'use strict';
// Native reference observation: starting a watcher consumes uv_now's cache.
// It does not execute the current guest JSAPI watcher bridge.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
assert.equal(process.version, 'v26.13.0');
const clock = require(path.resolve(process.argv[2]));
const directory = fs.mkdtempSync(path.join(path.resolve(process.argv[3]), 'clock-'));
const filename = path.join(directory, 'file');
fs.writeFileSync(filename, 'observed');
try {
  const before = clock.cachedNow();
  const wall = process.hrtime.bigint();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  const afterWait = clock.cachedNow();
  const watcher = fs.watchFile(filename, { interval: 20, persistent: false }, () => {});
  const afterStart = clock.cachedNow();
  assert.equal(afterWait, before);
  assert.equal(afterStart, before, 'watchFile start must not refresh the loop cache');
  const advanced = clock.updateNow();
  assert(advanced > before, 'positive control must advance actual cached time');
  assert(process.hrtime.bigint() - wall >= 40_000_000n);
  assert.equal(typeof watcher.unref, 'function');
  console.log(JSON.stringify({ nativeCachedStart: true,
    cachedMilliseconds: before.toString(), updatedMilliseconds: advanced.toString(),
    explicitUpdateAdvancedClock: true }));
} finally {
  fs.unwatchFile(filename);
  fs.rmSync(directory, { recursive: true, force: true });
}
