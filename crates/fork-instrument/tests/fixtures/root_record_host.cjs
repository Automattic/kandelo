// Root-only KFMS journal. Tables use a separate sparse-page ownership protocol.
const assert = require('node:assert/strict');
const ELEMENTS = 6;
const DATA = 7;
module.exports = function createRootJournal(wide, bindings = () => ({})) {
  const records = new Map();
  const pending = new Map();
  const key = (kind, activation, owner, ordinal = 0) => `${kind}:${activation}:${owner}:${ordinal}`;
  function bind(getInstance, memory) {
    let top = 8192;
    const imports = bindings();
    imports.env ??= {};
    Object.assign(imports.env, {
        __wpk_fork_module_state_record_reserve(kind, activation, owner, size) {
          const address = top;
          top += (Number(size) + 15) & ~15;
          assert(top < 0x10000, 'record arena must not overlap recursive codec scratch');
          pending.set(address, { kind, activation, owner, size: Number(size) });
          return wide ? BigInt(address) : address;
        },
        __wpk_fork_module_state_record_commit(pointer) {
          const address = Number(pointer);
          const record = pending.get(address);
          assert(record);
          records.set(key(record.kind, record.activation, record.owner), {
            ...record, bytes: new Uint8Array(memory.buffer, address, record.size).slice(),
          });
          pending.delete(address);
        },
        __wpk_fork_module_state_record_find(kind, activation, owner, ordinal) {
          const record = records.get(key(kind, activation, owner, ordinal));
          assert(record, 'every requested root record must have been committed');
          // Place bitmap records at the exact end of memory. Word-sized
          // overreads of their short last byte must trap, even with padding.
          const address = kind === ELEMENTS || kind === DATA ? memory.buffer.byteLength - record.size : 4096;
          new Uint8Array(memory.buffer, address, record.size).set(record.bytes);
          return wide ? BigInt(address) : address;
        },
    });
    return imports;
  }
  return { records, pending, bind };
};
