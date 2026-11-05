'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createDnsPlatform } = require('./node-dns-platform.cjs');
const inputs = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const candidate = createDnsPlatform();
const outputs = [];
async function main() {
  for (const input of inputs) {
    let captured;
    candidate.native.dnsLookup = (_req, ascii) => {
      captured = ascii;
      return process.binding('uv').UV_ENOMEM;
    };
    await assert.rejects(candidate.promises.lookup(input), { code: 'ENOMEM' });
    assert.equal(typeof captured, 'string');
    outputs.push(captured);
  }
  console.log(JSON.stringify(outputs));
}
main().then(() => candidate.close(), error => { candidate.close(); console.error(error); process.exitCode = 1; });
