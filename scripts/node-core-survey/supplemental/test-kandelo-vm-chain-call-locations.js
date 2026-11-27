'use strict';

require('../common');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const cases = [
  ['spaced-outer-dot', { a: null }, 'v ?. a    .   b', 1, 11],
  ['multiline-outer-dot', { a: null }, 'v?.a\n  .    b', 2, 3],
  ['outer-method-null', { a: null }, 'v?.a    .   b()', 1, 9],
  ['outer-method-missing', { a: {} }, 'v?.a    .   b()', 1, 13],
  ['outer-bracket', { a: null }, 'v?.a    [ "b" ]', 1, 9],
  ['computed-optional-base', { a: null }, 'v?.["a"]    .  b', 1, 13],
  ['later-member', { a: {} }, 'v?.a.b    .   c', 1, 11],
  ['folded-call', {}, 'v [   "key"  ]   ()', 1, 18],
  ['grouped-call', {}, '(v[ "key" ]) ()', 1, 14],
  ['folded-number-call', {}, 'v[0.5] /* note */ ()', 1, 19],
  ['ordinary-dot-call', {}, 'v  .  key    ()', 1, 7],
  ['parentheses-end-chain', { a: null }, '(v?.a)   .   b', 1, 14],
  ['optional-dotted-call', {}, 'v?.a()', 1, 4],
];

const differences = [];
for (const [label, v, source, line, column] of cases) {
  const filename = label + '.js';
  assert.throws(() => vm.runInNewContext(source, { v }, { filename }), (error) => {
    const lines = error.stack.split('\n');
    const position = filename + ':' + line;
    const actual = [error.name, ...lines.slice(0, 3), lines.find(s => s.startsWith('    at '))];
    const expected = ['TypeError', position, source.split('\n')[line - 1],
                      ' '.repeat(column - 1) + '^', '    at ' + position + ':' + column];
    if (!actual.every((value, index) => value === expected[index])) {
      differences.push({ label, actual, expected });
    }
    return true;
  });
}
assert.strictEqual(vm.runInNewContext('v?.a.b()', { v: null }), undefined);
assert.deepStrictEqual(differences, []);
