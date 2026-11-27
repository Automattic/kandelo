'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function verify() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'node-watch-'));
  const file = path.join(directory, 'observed');
  const expected = Buffer.from(path.basename(file));
  const controller = new AbortController();
  const watchers = [];
  let child;
  let deadline;

  function sawWrite(kind, name) {
    if (!Buffer.isBuffer(name) || !expected.equals(name)) return false;
    assert.ok(kind === 'change' || kind === 'rename');
    return fs.readFileSync(file, 'utf8') === 'after';
  }

  try {
    fs.writeFileSync(file, 'before');
    const events = [file, directory].map((target) => {
      const watcher = fs.watch(target, { encoding: 'buffer' });
      watchers.push(watcher);
      return new Promise((resolve, reject) => {
        watcher.once('error', reject);
        watcher.on('change', (kind, name) => {
          try {
            if (sawWrite(kind, name)) resolve();
          } catch (error) { reject(error); }
        });
      });
    });
    const changes = fs.promises.watch(directory, {
      encoding: 'utf8', signal: controller.signal,
    });
    events.push((async () => {
      for await (const { eventType, filename } of changes) {
        if (filename !== expected.toString()) continue;
        assert.ok(eventType === 'change' || eventType === 'rename');
        if (fs.readFileSync(file, 'utf8') === 'after') return;
      }
      throw new Error('Directory watch ended before the child write');
    })());

    child = spawn(process.execPath, ['-e',
      "require('node:fs').writeFileSync(process.argv[1], 'after')", file],
      { stdio: 'ignore' });
    events.push(once(child, 'exit').then(([code, signal]) => {
      assert.equal(code, 0);
      assert.equal(signal, null);
    }));
    await Promise.race([
      Promise.all(events),
      new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error('Timed out waiting for child write')), 30_000);
      }),
    ]);
  } finally {
    clearTimeout(deadline);
    controller.abort();
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    await Promise.all(watchers.map((watcher) => {
      const closed = once(watcher, 'close');
      watcher.close();
      return closed;
    }));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

verify().catch((error) => { console.error(error); process.exitCode = 1; });
