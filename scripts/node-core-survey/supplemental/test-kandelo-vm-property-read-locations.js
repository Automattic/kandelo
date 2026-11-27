'use strict';

require('../common');
const assert = require('node:assert/strict');
const vm = require('node:vm');

// A lookup can throw while evaluating the receiver, the key, or the load.
// The expected source positions are also checked on authenticated native Node.
const cases = [
  ['dot', null, 'v   .   field', 2, 9],
  ['string-key', null, 'v    [   "field"   ]', 2, 6],
  ['variable-key', null, 'v   [   k   ]', 2, 5],
  ['numeric-key', null, 'v   [   1   ]', 2, 5],
  ['chain', { field: null }, 'v    [   "field" ].next', 2, 20],
  ['computed-chain', { field: null }, 'v.field    [ k ]', 2, 12],
  ['multiline', null, 'v\n    .\n      field', 4, 7],
  ['method-read', null, 'v   .   field()', 2, 9],
  ['computed-method-read', null, 'v    [ k ]()', 2, 6],
  ['key-error', {}, 'v[null    .    key]', 2, 16],
  ['base-error', {}, 'null    .    base   [ k ]', 2, 14],
  ['unicode-prefix', null, '"🌳"; v   .    field', 2, 16],
];

const mismatches = [];
for (const [name, base, expression, line, column] of cases) {
  const filename = name + '.js';
  const source = 'const v=' + JSON.stringify(base) + '; const k="field";\n' + expression;
  let actual;
  try {
    vm.runInNewContext(source, {}, { filename });
    actual = ['returned'];
  } catch (error) {
    const lines = error.stack.split('\n');
    actual = [error.name, ...lines.slice(0, 3), lines.find(s => s.startsWith('    at '))];
  }
  const expected = ['TypeError', filename + ':' + line, source.split('\n')[line - 1],
                    ' '.repeat(column - 1) + '^', '    at ' + filename + ':' + line + ':' + column];
  if (!actual.every((value, index) => value === expected[index]) ||
      actual.length !== expected.length) {
    mismatches.push({ name, actual, expected });
  }
}
assert.deepStrictEqual(mismatches, []);
