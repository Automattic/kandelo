'use strict';

require('../common');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const expressions = [
  ['v ?.  a    ()', 7],
  ['v?.a(...[])', 4],
  ['v?.a?.()', 7],
  ['v.a?.()', 6],
  ['(v.a) ()', 7],
  ['(v?.a) ()', 8],
  ['v?.["a"]()', 9],
  ['v?.["a"]?.()', 11],
  ['f?.()', 4],
  ['(f)(1)', 4],
  ['f     (1)', 1],
];

const differences = [];
for (const [index, [source, column]] of expressions.entries()) {
  const filename = 'call-' + index + '.js';
  assert.throws(() => vm.runInNewContext(source, { f: 4, v: { a: 4 } }, { filename }), (error) => {
    const lines = error.stack.split('\n');
    const actual = [error.name, ...lines.slice(0, 3), lines.find(line => line.startsWith('    at '))];
    const expected = ['TypeError', filename + ':1', source, ' '.repeat(column - 1) + '^',
                      '    at ' + filename + ':1:' + column];
    if (!actual.every((value, i) => value === expected[i])) {
      differences.push({ source, actual, expected });
    }
    return true;
  });
}
assert.strictEqual(vm.runInNewContext('v?.a?.()', { v: null }), undefined);
assert.strictEqual(vm.runInNewContext('(v.a)?.()', { v: {} }), undefined);
assert.deepStrictEqual(differences, []);
