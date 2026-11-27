'use strict';
const common = require('../common');
const assert = require('node:assert');
const { access } = require('node:fs/promises');

async function leaf() {
  await Promise.resolve();
  throw new Error('capture');
}
async function capture() {
  return await leaf();
}
function names(frame) {
  return [frame.getFunctionName(), frame.getTypeName(), frame.getMethodName(), frame.isAsync()];
}

async function main() {
  Error.prepareStackTrace = (_, frames) => frames;
  const object = { alias: capture };
  let captured;
  await assert.rejects(object.alias(), (error) => {
    captured = error.stack[1];
    return error.message === 'capture';
  });
  assert.deepStrictEqual(names(captured), ['capture', 'Object', 'alias', true]);
  assert.match(captured.toString(), /^async Object\.capture \[as alias\] \(/);

  // Method names are observed on the live receiver, even after formatting.
  delete object.alias;
  object.renamed = capture;
  assert.deepStrictEqual(names(captured), ['capture', 'Object', 'renamed', true]);
  object.another = capture;
  assert.deepStrictEqual(names(captured), ['capture', 'Object', null, true]);
  await assert.rejects(capture(), (error) => {
    assert.deepStrictEqual(names(error.stack[1]), ['capture', null, null, true]);
    return true;
  });
  await assert.rejects(access(__filename + '.missing'), (error) => {
    assert.strictEqual(error.code, 'ENOENT');
    const site = error.stack.find((frame) => frame.getFunctionName() === 'rejects');
    assert.ok(site);
    assert.deepStrictEqual(names(site), ['rejects', 'assert', 'rejects', true]);
    assert.match(site.toString(), /^async assert\.rejects \(/);
    return true;
  });
}
main().then(common.mustCall());
