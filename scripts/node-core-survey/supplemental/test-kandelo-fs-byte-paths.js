'use strict';

require('../common');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const directory = fs.mkdtempSync(path.join(tmpdir(), 'node-byte-paths-'));
const prefix = Buffer.from(directory + '/');
const names = [Buffer.from([0x6e, 0x80]), Buffer.from([0x6e, 0x81])];
const created = [];
try {
  for (const name of names) {
    const filename = Buffer.concat([prefix, name]);
    fs.writeFileSync(filename, name, { flag: 'wx' });
    created.push(filename);
  }
  const entries = fs.readdirSync(directory, { encoding: 'buffer' });
  assert.deepStrictEqual(entries.map(entry => entry.toString('hex')).sort(), ['6e80', '6e81']);
  for (const name of names) {
    assert.deepStrictEqual(fs.readFileSync(Buffer.concat([prefix, name])), name);
  }
} finally {
  for (const filename of created) fs.unlinkSync(filename);
  fs.rmdirSync(directory);
}
