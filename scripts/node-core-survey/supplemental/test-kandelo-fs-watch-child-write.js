'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

async function verify() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'node-watch-'));
  const file = path.join(directory, 'observed');
  fs.writeFileSync(file, 'before');
  const watchers = [];
  try {
    const events = [file, directory].map((target) => {
      const watcher = fs.watch(target, { encoding: 'buffer' });
      watchers.push(watcher);
      return new Promise((resolve, reject) => {
        watcher.once('error', reject);
        watcher.on('change', (kind, name) => {
          if (!Buffer.isBuffer(name) || !name.equals(Buffer.from('observed'))) return;
          if (fs.readFileSync(file, 'utf8') !== 'after') return;
          assert.ok(kind === 'change' || kind === 'rename');
          resolve();
        });
      });
    });
    // Give the native directory watcher its startup interval too.
    await delay(150);
    const child = spawn(process.execPath, ['-e',
      "require('node:fs').writeFileSync(process.argv[1], 'after')", file],
      { stdio: 'ignore' });
    const [code, signal] = await once(child, 'exit');
    assert.equal(code, 0);
    assert.equal(signal, null);
    await Promise.all(events);
    await Promise.all(watchers.map((watcher) => {
      const closed = once(watcher, 'close');
      watcher.close();
      return closed;
    }));
    watchers.length = 0;
    assert.equal(fs.readFileSync(file, 'utf8'), 'after');
  } finally {
    for (const watcher of watchers) watcher.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

verify().catch((error) => { console.error(error); process.exitCode = 1; });
