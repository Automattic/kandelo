// Scalar KFMS journal and table publication protocol. References are encoded
// by the real typed Wasm providers; this host keeps only IDs and payload bytes.
const assert = require('node:assert/strict');
module.exports = function createTableJournal(wide, tableWide) {
  const records = new Map();
  const dirty = new Map();
  const pending = new Map();
  const bindings = [];
  const key = (kind, activation, owner) => `${kind}:${activation}:${owner}`;
  function bind(getInstance, memory) {
    const index = value => tableWide ? BigInt(value) : value;
    const alias = new WebAssembly.Table({ element: 'anyfunc', initial: index(2), maximum: index(4096),
      address: tableWide ? 'i64' : 'i32' });
    const fence = new BigInt64Array(memory.buffer, 1024, 1);
    let top = 8192;
    const state = { begins: 0, commits: 0, aborts: 0, reconciles: 0, depth: 0, race: false };
    bindings.push(state);
    const generation = () => memory.buffer instanceof SharedArrayBuffer ? Atomics.load(fence, 0) : fence[0];
    function publish() {
      if (memory.buffer instanceof SharedArrayBuffer) Atomics.add(fence, 0, 1n);
      else fence[0]++;
    }
    state.advance = publish;
    function canonical(owner) {
      const table = getInstance().exports[`__wpk_fork_table_${owner}`];
      assert(table instanceof WebAssembly.Table);
      const aliases = Object.entries(getInstance().exports)
        .filter(([name, value]) => name.startsWith('__wpk_fork_table_') && value === table)
        .map(([name]) => Number(name.slice('__wpk_fork_table_'.length)));
      return Math.min(...aliases);
    }
    const host = {
      __wpk_fork_module_state_table_generation_addr: new WebAssembly.Global({ value: 'i64' }, 1024n),
      __wpk_fork_module_state_table_state_owned(owner) { return Number(owner === canonical(owner)); },
      __wpk_fork_module_state_table_dirty_mark(owner, first, count) {
        owner = canonical(owner);
        const pages = dirty.get(owner) ?? new Set();
        for (let page = first; page < first + count; page++) pages.add(Number(page));
        dirty.set(owner, pages);
      },
      __wpk_fork_module_state_table_dirty_count(owner) { return dirty.get(canonical(owner))?.size ?? 0; },
      __wpk_fork_module_state_table_dirty_page(owner, ordinal) {
        const pages = [...dirty.get(canonical(owner))].sort((a, b) => a - b);
        assert(ordinal < pages.length);
        return BigInt(pages[ordinal]);
      },
      __wpk_fork_module_state_table_mutation_begin() {
        assert.equal(state.depth++, 0);
        state.begins++;
        return generation();
      },
      __wpk_fork_module_state_table_mutation_commit(owner, start, count) {
        assert.equal(state.depth--, 1);
        assert(count > 0n);
        assert(start >= 0n);
        state.commits++;
        publish();
      },
      __wpk_fork_module_state_table_mutation_abort() {
        assert.equal(state.depth--, 1);
        state.aborts++;
      },
      __wpk_fork_module_state_table_reconcile() {
        state.reconciles++;
        const applied = generation();
        if (state.race) { state.race = false; publish(); }
        return applied;
      },
      __wpk_fork_module_state_record_reserve(kind, activation, owner, size) {
        const address = top;
        top += (Number(size) + 15) & ~15;
        assert(top < 0x10000, 'records must not overlap recursive codec scratch');
        pending.set(address, { kind, activation, owner, size: Number(size) });
        return wide ? BigInt(address) : address;
      },
      __wpk_fork_module_state_record_commit(pointer) {
        const address = Number(pointer);
        const record = pending.get(address);
        assert(record);
        const recordsKey = key(record.kind, record.activation, record.owner);
        const group = records.get(recordsKey) ?? [];
        group.push(new Uint8Array(memory.buffer, address, record.size).slice());
        records.set(recordsKey, group);
        pending.delete(address);
      },
      __wpk_fork_module_state_record_find(kind, activation, owner, ordinal) {
        const payload = records.get(key(kind, activation, owner))?.[ordinal];
        assert(payload, 'every restored sparse/root record must exist');
        new Uint8Array(memory.buffer, 4096, payload.length).set(payload);
        return wide ? 4096n : 4096;
      },
    };
    // Like the process execution boundary, release any in-flight writer
    // transaction when a guest trap escapes an instrumented operation.
    state.invoke = operation => {
      try { return operation(); }
      catch (error) {
        while (state.depth > 0) host.__wpk_fork_module_state_table_mutation_abort();
        throw error;
      }
    };
    return { env: host, h: { alias } };
  }
  return { records, dirty, pending, bindings, key, bind };
};
