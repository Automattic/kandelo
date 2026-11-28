'use strict';

require('../common');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
const GeneratorFunction = Object.getPrototypeOf(function*() {}).constructor;
const compilers = [
  ['direct eval', (source) => eval(source)],
  ['indirect eval', (source) => (0, eval)(source)],
  ['Function', (source) => new Function(source)],
  ['AsyncFunction', (source) => new AsyncFunction(source)],
  ['GeneratorFunction', (source) => new GeneratorFunction(source)],
  ['vm.Script', (source) => new vm.Script(source)],
  ['vm.compileFunction', (source) => vm.compileFunction(source)],
];

for (const [mode, compile] of compilers) {
  assert.doesNotThrow(() => compile('void 42;'), mode);
  for (const [source, message] of [
    ['const answer;', 'Missing initializer in const declaration'],
    ['const { answer };', 'Missing initializer in destructuring declaration'],
    ['import value from "node:path";', 'Cannot use import statement outside a module'],
  ]) {
    assert.throws(() => compile(source), { name: 'SyntaxError', message }, mode);
  }
}
