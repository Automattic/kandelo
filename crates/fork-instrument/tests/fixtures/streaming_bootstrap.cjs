const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const load = name => new WebAssembly.Module(fs.readFileSync(path.join(__dirname, name)));
const wide = process.argv[2] === '1';
const index = value => wide ? BigInt(value) : value;

function instantiate(module) {
  const memory = new WebAssembly.Memory({ initial: index(1), address: wide ? 'i64' : 'i32' });
  const table = new WebAssembly.Table({ element: 'anyfunc', initial: index(4), address: wide ? 'i64' : 'i32' });
  const observations = [];
  const imports = {
    h: { memory, table, memory_base: index(8), table_base: index(0),
      observe(value) { observations.push(value); } },
    private: { function() { throw new Error('private import must stay unused'); },
      global: 999, table: new WebAssembly.Table({ element: 'anyfunc', initial: 1 }),
      memory: new WebAssembly.Memory({ initial: 1 }) },
  };
  for (const entry of WebAssembly.Module.imports(module)) {
    const namespace = imports[entry.module] ??= {};
    if (entry.name in namespace) continue;
    if (entry.kind === 'function') namespace[entry.name] = () => {
      throw new Error(`unexpected oracle helper import ${entry.name}`);
    };
    else if (entry.kind === 'global') namespace[entry.name] = entry.name.includes('generation') ? 0n : 0;
    else if (entry.kind === 'tag') namespace[entry.name] = new WebAssembly.Tag({ parameters: [] });
    else if (entry.kind === 'table') namespace[entry.name] = new WebAssembly.Table({ element: 'anyfunc', initial: 1 });
    else throw new Error(`unexpected oracle import ${entry.name}`);
  }
  const instance = new WebAssembly.Instance(module, imports);
  return { exports: instance.exports, memory, table, observations };
}
function assertInitialized(owner) {
  assert.deepEqual([...new Uint8Array(owner.memory.buffer, 9, 2)], [65, 90]);
  assert.equal(new Uint8Array(owner.exports.local_memory.buffer)[0], 81);
  assert.equal(owner.exports.read_table(), 9);
  assert.equal(owner.exports.read_local_table(), 7);
}
const original = instantiate(load('original.wasm'));
assertInitialized(original);
assert.deepEqual(original.observations, [155]);
assert.throws(() => original.exports.probe_active_data(), WebAssembly.RuntimeError);
assert.throws(() => original.exports.probe_active_element(), WebAssembly.RuntimeError);
function verifyBackend(backend) {
  const moduleUnderTest = load(backend);
  const parent = instantiate(moduleUnderTest);
  assert.equal(parent.exports.starts.value, 0);
  assert.deepEqual(parent.observations, []);
  assert.equal(parent.table.get(index(1)), null);
  assert.equal(new Uint8Array(parent.memory.buffer)[9], 0);
  parent.exports.wpk_fork_module_bootstrap();
  assertInitialized(parent);
  assert.deepEqual(parent.observations, [155]);
  parent.exports.wpk_fork_module_bootstrap();
  assert.equal(parent.exports.starts.value, 1);
  assert.deepEqual(parent.observations, [155], 'start runs once');
  if (backend === 'native.wasm') {
    // The oracle also installs source table journal barriers. This fixture
    // compares its bootstrap phases; native source lifetime checks compare
    // against the original module above without simulating a table journal.
    assert.throws(() => parent.exports.probe_active_data(), WebAssembly.RuntimeError);
    assert.throws(() => parent.exports.probe_active_element(), WebAssembly.RuntimeError);
    parent.exports.use_passive();
    assert.equal(new Uint8Array(parent.memory.buffer)[32], 82);
  }

  for (const mode of backend === 'native.wasm' ? ['thread', 'fork'] : ['thread']) {
    const owner = instantiate(moduleUnderTest);
    new Uint8Array(owner.memory.buffer).fill(123);
    new Uint8Array(owner.exports.local_memory.buffer).fill(124);
    if (mode === 'thread') owner.exports.wpk_fork_module_thread_bootstrap();
    else {
      // Module-state restore owns globals before it invokes this baseline phase.
      owner.exports.starts.value = 7;
      owner.exports.restore_baseline();
    }
    assert.equal(owner.table.get(index(1))(), 9);
    assert.equal(owner.exports.local_table.get(index(0))(), 7);
    assert.equal(owner.exports.starts.value, mode === 'fork' ? 7 : 0);
    assert.deepEqual(owner.observations, []);
    assert.equal(new Uint8Array(owner.memory.buffer)[9], 123, 'copied data remains intact');
    assert.equal(new Uint8Array(owner.exports.local_memory.buffer)[0], 124);
    if (mode === 'thread' && backend === 'native.wasm') {
      assert.throws(() => owner.exports.probe_active_data(), WebAssembly.RuntimeError);
      assert.throws(() => owner.exports.probe_active_element(), WebAssembly.RuntimeError);
    } else if (mode === 'fork') {
      owner.exports.probe_active_data();
      owner.exports.probe_active_element();
      assert.equal(new Uint8Array(owner.memory.buffer)[32], 65,
        'fork restore keeps constructor segments physically available');
    }
    owner.exports.wpk_fork_module_bootstrap();
    assert.deepEqual(owner.observations, [], 'restored instances cannot run parent bootstrap later');
    assert.equal(new Uint8Array(owner.memory.buffer)[9], 123);
  }
}
for (const backend of ['native.wasm', 'oracle.wasm']) verifyBackend(backend);
