// Linked-frame transaction shared by capture, live abort and fresh replay.
// Payloads and reference vectors are written by the real guest codecs.
const assert = require('node:assert/strict');
module.exports = function createFrameJournal(wide, wasmModule, { requireIndirectGuard = true } = {}) {
  const pointer = value => wide ? BigInt(value) : value;
  const committed = [];
  const bindings = [];
  function bind(getInstance, memory, publication, mode, failAt = 0) {
    const resume = new WebAssembly.Table({ element: 'anyfunc', initial: 8 });
    const reserved = new Map();
    let pending = mode === 'rewind' ? committed.slice().reverse() : [];
    const state = { reservations: 0, calls: 0, consumed: 0, mode };
    bindings.push(state);
    const descriptor = pointer(512);
    function header(address, offset) { return new DataView(memory.buffer).getUint32(address + offset, true); }
    const imports = {
      __wpk_fork_resume_table: resume,
      __wpk_fork_frame_reserve(size) {
        state.reservations++;
        if (state.reservations === failAt) {
          state.mode = 'abort';
          pending = committed.slice().reverse();
          getInstance().exports.wpk_fork_abort_begin(descriptor);
          return pointer(0);
        }
        const address = 0x20000 + state.reservations * 4096;
        assert(Number(size) < 4096);
        reserved.set(address, Number(size));
        return pointer(address);
      },
      __wpk_fork_frame_commit(pointer) {
        const address = Number(pointer);
        assert(reserved.has(address));
        const vector = header(address, 12);
        assert(vector > 0, 'references and catches require a durable vector before commit');
        committed.push({ address, size: reserved.get(address), ordinal: header(address, 0), vector });
        reserved.delete(address);
      },
      __wpk_fork_frame_next(size) {
        const frame = pending.shift();
        assert(frame);
        assert.equal(Number(size), frame.size);
        state.consumed++;
        return pointer(frame.address);
      },
      __wpk_fork_frame_peek(size) {
        assert(pending.length);
        assert.equal(Number(size), pending[0].size);
        return pointer(pending[0].address);
      },
      __wpk_fork_resume_peek() {
        if (requireIndirectGuard) assert(publication.reconciles > 0, 'generated indirect transport reconciles before replay routing');
        return pending.length ? pending[0].ordinal + 1 : 0;
      },
    };
    state.link = instance => {
      const catalog = instance.exports.__wpk_fork_resume_catalog;
      const sections = WebAssembly.Module.customSections(wasmModule, 'kandelo.wpk_fork.resume_catalog');
      assert.equal(sections.length, 1);
      const descriptor = new DataView(sections[0]);
      assert.equal(descriptor.getUint16(4, true), 1);
      assert.equal(descriptor.getUint16(6, true), 12);
      assert.equal(descriptor.byteLength, 12 + descriptor.getUint32(8, true) * 8);
      for (let entry = 0; entry < descriptor.getUint32(8, true); entry++) {
        const ordinal = descriptor.getUint32(12 + entry * 8, true);
        const slot = descriptor.getUint32(16 + entry * 8, true);
        if (resume.length <= ordinal + 1) resume.grow(ordinal + 2 - resume.length);
        resume.set(ordinal + 1, catalog.get(slot));
      }
    };
    state.fork = (ordinal, ...operands) => {
      state.calls++;
      assert.equal(ordinal, 3);
      assert(operands.length === 0 || operands.length === 40);
      assert(operands.every(value => value === 11n), 'restored wide arguments retain their bits');
      if (state.calls === 1 && getInstance().exports.sp instanceof WebAssembly.Global) {
        state.forkStackPointer = Number(getInstance().exports.sp.value);
      }
      if (requireIndirectGuard) assert(publication.reconciles > 0, 'the original indirect call also uses its generated guard');
      const exports = getInstance().exports;
      if (state.mode === 'rewind') { state.mode = 'normal'; exports.wpk_fork_rewind_end(); return 0; }
      if (state.mode === 'abort') { state.mode = 'normal'; exports.wpk_fork_abort_end(); return -1; }
      if (state.mode === 'capture' || state.mode === 'fail') {
        exports.wpk_fork_unwind_begin(descriptor);
        return -999;
      }
      return 13;
    };
    return { env: imports, h: { fork: state.fork, same: (left, right) => Number(left === right) } };
  }
  return { committed, bindings, bind };
};
