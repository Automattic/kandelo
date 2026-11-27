'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setImmediate: nextTurn } = require('node:timers/promises');

const fdDirectory = process.platform === 'darwin' ? '/dev/fd' : '/proc/self/fd';
function snapshot() {
  return {
    fds: fs.readdirSync(fdDirectory).length,
    watchers: process.getActiveResourcesInfo().filter((name) => name === 'FSEventWrap').length,
  };
}

async function exercise(file) {
  const callback = fs.watch(file);
  const controller = new AbortController();
  const iterator = fs.promises.watch(file, { signal: controller.signal });
  const pending = iterator.next();
  const aborted = assert.rejects(pending, { name: 'AbortError', code: 'ABORT_ERR' });
  try {
    await nextTurn();
    return snapshot();
  } finally {
    const closed = once(callback, 'close');
    callback.close();
    controller.abort();
    await Promise.all([closed, aborted]);
    await iterator.return();
    await nextTurn();
  }
}

async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-retirement-'));
  const file = path.join(directory, 'observed');
  try {
    fs.writeFileSync(file, 'initial');
    await exercise(file);
    const baseline = snapshot();
    const rows = [];
    for (let iteration = 0; iteration < 4; iteration++) {
      const active = await exercise(file);
      const closed = snapshot();
      rows.push({ active, closed });
      assert.equal(active.watchers, baseline.watchers + 2);
      assert.ok(active.fds > baseline.fds);
      assert.deepEqual(closed, baseline);
    }
    console.log(JSON.stringify({ fdDirectory, baseline, rows }));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
