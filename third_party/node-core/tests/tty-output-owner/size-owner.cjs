'use strict';
// Native reference + production-adapter/native-header component control.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const tty = require('node:tty');
const helper = require(process.env.TTY_OUTPUT_COMPONENT);
const mode = process.argv[2];
const replacement = Number(process.env.REPLACEMENT_TTY_FD);
const report = Number(process.env.REPORT_FD);
(async () => {
  assert.equal(process.version, 'v26.13.0');
  const candidate = mode === 'candidate' ? require('./platform.cjs').create(1) : null;
  const output = candidate ? candidate.output : process.stdout;
  assert.deepEqual(output.getWindowSize(), [81, 25]);
  const resize = [], errors = [];
  output.on('resize', (...args) => resize.push(args));
  output.on('error', error => errors.push({ code: error.code, errno: error.errno, syscall: error.syscall }));
  // Replace the real public fd with a different PTY, after capture. The
  // owning TTY's handle remains alive and queries the first PTY, as writes do.
  fs.closeSync(1);
  assert.equal(helper.replace(replacement, 1).error, 0);
  assert.equal(helper.resize(0, 97, 41).error, 0);
  assert.deepEqual(helper.windowSize(1).value, [19, 12]);
  output._refreshSize();
  assert.deepEqual(output.getWindowSize(), [97, 41]);
  assert.equal(resize.length, 1);
  const rows = [{ name: 'captured owner survives public fd replacement', size: output.getWindowSize(), publicSize: helper.windowSize(1).value, resize: resize.slice() }];
  assert.equal(helper.resize(replacement, 27, 13).error, 0);
  output.fd = replacement;
  output._refreshSize();
  assert.deepEqual(output.getWindowSize(), [97, 41]);
  assert.equal(resize.length, 1);
  rows.push({ name: 'replacement resize and public fd mutation cannot redirect owner', size: output.getWindowSize(), publicSize: helper.windowSize(1).value, resizeCount: resize.length });
  await new Promise((resolve, reject) => output.write('A', error => error ? reject(error) : resolve()));
  fs.writeSync(1, 'B');
  rows.push({ name: 'writes and queries retain the same original terminal', originalSize: output.getWindowSize() });
  if (candidate) candidate.closeOutput();
  else await new Promise(resolve => output._handle.close(resolve));
  output._refreshSize();
  assert.deepEqual(errors, [{ code: 'EBADF', errno: -9, syscall: 'getWindowSize' }]);
  assert.deepEqual(output.getWindowSize(), [97, 41]);
  assert(tty.isatty(1));
  rows.push({ name: 'actual owner close reports EBADF and preserves cached dimensions and replacement', errors, size: output.getWindowSize(), replacementStillTty: tty.isatty(1) });
  fs.writeSync(report, JSON.stringify({ mode, rows }) + '\n');
})().catch(error => {
  fs.writeSync(report, JSON.stringify({ fatal: { name: error.name, message: error.message, stack: error.stack } }) + '\n');
  process.exitCode = 1;
});
