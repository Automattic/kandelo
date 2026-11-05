const assert = require('node:assert/strict');
const fs = require('node:fs');
const moduleBytes = fs.readFileSync(process.argv[2]);
const moduleObject = new WebAssembly.Module(moduleBytes);
const types = process.argv[3].split(',');
const wideTable = process.argv[4] === '1';
const value = (index, number) => types[index] === 'i64' ? BigInt(number) : number;
const argumentsFor = () => types.map((_, index) => value(index, [64, 32, 128, 16, 7][index]));
for (const mode of ['success', 'failure', 'prepare-failure', 'main']) {
  let calls = [], cursor = 0, prepared;
  const instance = new WebAssembly.Instance(moduleObject, { env: {
    __wasm_dlopen_main() { calls.push('main'); return 777; },
    __wasm_dlopen_prepare(...args) { calls.push('prepare'); prepared = args; return mode === 'prepare-failure' ? 0 : 17; },
    __wasm_dlopen_next(token) {
      calls.push('next');
      assert.equal(token, mode === 'prepare-failure' ? 0 : 17);
      return mode === 'success' || mode === 'main' ? [1, 2, 0][cursor++] : -1;
    },
    __wasm_dlopen_commit(token) { calls.push('commit'); assert.equal(token, 17); return 888; },
  }});
  const x = instance.exports;
  assert.equal(x.legacy_reference.value, x.legacy_alias);
  assert.equal(x.__indirect_function_table.get(wideTable ? 3n : 3), x.legacy_alias);
  assert(!WebAssembly.Module.imports(moduleObject).some(imported => imported.name === '__wasm_dlopen'));
  const args = argumentsFor();
  if (mode === 'main' && types.length >= 4) { args[1] = value(1, 0); args[3] = value(3, 0); }
  const handle = x.open(...args);
  if (mode === 'main' && types.length >= 4) {
    assert.equal(handle, 777); assert.deepEqual(calls, ['main']);
    assert.equal(x.initialized.value, 0); assert.equal(x.checkpoints.value, 0);
    continue;
  }
  assert.equal(handle, mode === 'failure' || mode === 'prepare-failure' ? 0 : 888);
  assert.deepEqual(calls, mode === 'failure' || mode === 'prepare-failure'
    ? ['prepare', 'next'] : ['prepare', 'next', 'next', 'next', 'commit']);
  assert.equal(x.initialized.value, handle ? 11 : 0);
  assert.equal(x.checkpoints.value, handle ? 7 : 2);
  assert.deepEqual(prepared, types.length === 2
    ? [args[0], args[1], value(0, 0), value(1, 0), 0x100]
    : types.length === 4 ? [...args, 0x100] : args);
  // Calling through the preserved function reference must execute the same
  // local adapter, including all source argument conversions.
  calls = []; cursor = 0;
  assert.equal(x.legacy_reference.value(...args), handle);
}
