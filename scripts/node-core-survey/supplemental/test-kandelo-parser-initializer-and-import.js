'use strict';

const common = require('../common');
const assert = require('node:assert/strict');
const vm = require('node:vm');

function syntaxError(message) {
  return { name: 'SyntaxError', message };
}

async function check() {
  for (const [source, message] of [
    ['const number;', 'Missing initializer in const declaration'],
    ['const number: number = 1;', 'Missing initializer in const declaration'],
    ['const { item };', 'Missing initializer in destructuring declaration'],
    ['const [item];', 'Missing initializer in destructuring declaration'],
  ]) {
    assert.throws(() => new vm.Script(source), syntaxError(message));
    assert.throws(() => vm.compileFunction(source), syntaxError(message));
    await assert.rejects(import('data:text/javascript,' + encodeURIComponent(source)),
                         syntaxError(message));
  }

  for (const source of ['import path from "node:path";',
                        'if (true) { import path from "node:path"; }']) {
    const message = 'Cannot use import statement outside a module';
    assert.throws(() => new vm.Script(source), syntaxError(message));
    assert.throws(() => vm.compileFunction(source), syntaxError(message));
  }
  const module = await import('data:text/javascript,import path from "node:path";export default path.sep;');
  assert.strictEqual(module.default, require('node:path').sep);
  assert.strictEqual(vm.compileFunction('const n = 2; return n;')(), 2);
}

check().then(common.mustCall());
