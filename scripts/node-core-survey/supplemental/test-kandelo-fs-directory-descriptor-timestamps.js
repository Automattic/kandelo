'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'node-directory-futimes-'));
const original = path.join(parent, 'dir');
const moved = path.join(parent, 'moved');
fs.mkdirSync(original);
const fd = fs.openSync(original, 'r');
try {
  const identity = fs.fstatSync(fd, { bigint: true }).ino;
  fs.renameSync(original, moved);
  fs.mkdirSync(original);
  fs.futimesSync(fd, 1600000000, 1600000000);
  assert.equal(fs.statSync(moved).mtimeMs, 1600000000000);
  assert.notEqual(fs.statSync(original).mtimeMs, 1600000000000);
  fs.rmdirSync(moved);
  fs.futimesSync(fd, 1700000000, 1700000000);
  assert.equal(fs.fstatSync(fd).mtimeMs, 1700000000000);
  assert.equal(fs.fstatSync(fd, { bigint: true }).ino, identity);
  assert.notEqual(fs.statSync(original).mtimeMs, 1700000000000);
  process.stdout.write(JSON.stringify({ renamed: true, removedWhileOpen: true, replacementUntouched: true }) + '\n');
} finally {
  fs.closeSync(fd);
  fs.rmSync(parent, { recursive: true, force: true });
}
