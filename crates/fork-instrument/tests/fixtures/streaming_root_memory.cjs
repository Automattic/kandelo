const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const moduleUnderTest = new WebAssembly.Module(fs.readFileSync(path.join(__dirname, 'provider.wasm')));
const wide = process.argv[2] === '1';
const pointer = value => wide ? BigInt(value) : value;
const records = new Map();
function instantiate(channel) {
  const memory = new WebAssembly.Memory({ initial: pointer(2), maximum: pointer(2), shared: true,
    address: wide ? 'i64' : 'i32' });
  let top = 8192;
  const pending = new Map();
  const imports = { env: {
    memory, __channel_base: new WebAssembly.Global({ value: 'i32', mutable: true }, channel),
    __wpk_fork_module_state_record_reserve(kind, activation, owner, size) {
      const address = top; top += (Number(size) + 15) & ~15;
      pending.set(address, { key: `${kind}:${activation}:${owner}`, size: Number(size) });
      return pointer(address);
    },
    __wpk_fork_module_state_record_commit(address) {
      const record = pending.get(Number(address)); assert(record);
      records.set(record.key, new Uint8Array(memory.buffer, Number(address), record.size).slice());
      pending.delete(Number(address));
    },
    __wpk_fork_module_state_record_find(kind, activation, owner, ordinal) {
      assert.equal(ordinal, 0);
      const record = records.get(`${kind}:${activation}:${owner}`); assert(record);
      new Uint8Array(memory.buffer, 4096, record.length).set(record);
      return pointer(4096);
    },
  } };
  for (const entry of WebAssembly.Module.imports(moduleUnderTest)) {
    const namespace = imports[entry.module] ??= {};
    if (entry.name in namespace) continue;
    if (entry.kind === 'function') namespace[entry.name] = () => { throw new Error(`unexpected call ${entry.name}`); };
    else if (entry.kind === 'table') namespace[entry.name] = new WebAssembly.Table({ element: 'anyfunc', initial: 1 });
    else if (entry.kind === 'tag') namespace[entry.name] = new WebAssembly.Tag({ parameters: [] });
    else throw new Error(`unexpected import ${entry.name}`);
  }
  return new WebAssembly.Instance(moduleUnderTest, imports).exports;
}
const parent = instantiate(777);
parent.wpk_fork_module_bootstrap();
assert.equal(parent.verify(), 1);
parent.wpk_fork_unwind_begin(pointer(512));
parent.wpk_fork_unwind_end();
parent.mutate();
assert.equal(parent.verify(), 0);
parent.wpk_fork_rewind_begin(pointer(512));
assert.equal(parent.verify(), 1, 'runtime scalar prefix uses the planned process memory');
assert.equal(parent.channel(), 11);
parent.wpk_fork_rewind_end();
parent.save_roots(7);
assert.equal(records.size, 3);
const child = instantiate(999);
assert.throws(() => child.finish_roots(7), WebAssembly.RuntimeError);
child.restore_roots(7);
child.finish_roots(7);
assert.equal(child.verify(), 1);
assert.equal(child.channel(), 999);
child.wpk_fork_module_bootstrap();
assert.equal(child.starts.value, 1, 'copied root state suppresses parent start');
