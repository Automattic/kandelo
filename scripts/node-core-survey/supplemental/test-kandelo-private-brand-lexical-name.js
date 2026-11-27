// Flags: --expose-gc
'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');

const body = `{
  #method() { return 11; }
  get #accessor() { return 12; }
  static #method2() { return 13; }
  static get #accessor2() { return 14; }
  readMethod(receiver) { return receiver.#method(); }
  readAccessor(receiver) { return receiver.#accessor; }
  static readMethod(receiver) { return receiver.#method2(); }
  static readAccessor(receiver) { return receiver.#accessor2; }
}`;

const named = eval(`(class Explicit ${body})`);
const inferred = eval(`const Inferred = class ${body}; Inferred`);
const anonymous = eval(`(class ${body})`);
const computed = eval(`const key = 'computed-name'; ({ [key]: class ${body} })[key]`);
const renamed = eval(`(class BeforeRename ${body})`);
let nameGetterCalls = 0;
Object.defineProperty(renamed, 'name', {
  get() {
    ++nameGetterCalls;
    throw new Error('Private brand diagnostics read the public class.name getter');
  },
});

globalThis.gc();

const declaredNames = {
  named: 'Explicit',
  inferred: '.',
  anonymous: '.',
  computed: '.',
  renamed: 'BeforeRename',
};
for (const [kind, Class] of Object.entries({ named, inferred, anonymous, computed, renamed })) {
  const item = new Class();
  for (const [side, owner, correct, substitute, values] of [
    ['instance', Class.prototype, item, {}, [11, 12]],
    ['static', Class, Class, class Other {}, [13, 14]],
  ]) {
    for (const [index, access] of ['readMethod', 'readAccessor'].entries()) {
      assert.equal(owner[access](correct), values[index]);
      for (const [invalid, receiver] of [['object', substitute], ['null', null], ['undefined', undefined]]) {
        let caught;
        try {
          owner[access](receiver);
        } catch (error) {
          caught = error;
        }
        assert.ok(caught instanceof TypeError);
        const name = declaredNames[kind];
        let expected = `Receiver must be class ${name}`;
        if (side === 'instance') {
          expected = invalid === 'object'
            ? `Receiver must be an instance of class ${name}`
            : `Cannot read properties of ${invalid} (reading '${name}')`;
        }
        assert.equal(caught.message, expected, `${kind} ${side} ${access} ${invalid}`);
      }
    }
  }
}
assert.equal(nameGetterCalls, 0);

const source = `(() => {
  class Δ {
    #method() { return 42; }
    call(receiver) { return receiver.#method(); }
  }
  const value = new Δ();
  try {
    value.call({});
  } catch (error) {
    return [value.call(value), error.name, error.message];
  }
})()`;
const script = new vm.Script(source);
const cached = new vm.Script(source, { cachedData: script.createCachedData() });
assert.equal(cached.cachedDataRejected, false);
for (const entry of [script, cached]) {
  assert.deepEqual(Array.from(entry.runInNewContext()), [
    42, 'TypeError', 'Receiver must be an instance of class Δ',
  ]);
}
