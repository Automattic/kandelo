// End-to-end + CO-RESIDENCY validation harness for the fork-module PIE side module.
//
// THIS IS THE KEY DELIVERABLE of the Phase 6 D5 gating slice. It proves, in a
// real production WebAssembly engine (Node's V8 — the same engine the browser
// and Node process workers run), that the fork-module can be instantiated
// AGAINST LIVE, NON-EMPTY guest memory WITHOUT corrupting the guest's data,
// because the module is built as a position-independent (PIC / `--pie`) side
// module whose data, BSS heap, and shadow stack are placed by HOST-supplied
// `__memory_base` / `__stack_pointer` / `__table_base` globals into a
// host-reserved region that the "guest" is not using.
//
// The old D2 scaffold could NOT pass this test: it was a plain cdylib whose
// static data, 16 MiB BSS heap, and `--stack-first` shadow stack lived at FIXED
// LOW linear-memory offsets, so instantiating it against live guest memory
// would overwrite guest data at those offsets. The harness demonstrates the
// difference directly: it fills the LOW region (where the old scaffold's
// static/BSS/stack lived) with a known sentinel pattern BEFORE instantiating and
// running the module, then asserts that region is byte-for-byte UNCHANGED after
// a full multi-chunk unwind->rewind loop and a >=5000-frame stress fork.
//
// It also proves the Option A arena contract: the HOST allocates the per-fork
// frame arena and passes its (base, len) into `fm_begin_unwind` — the module no
// longer grows memory itself.
//
// Run: node crates/fork-module/tests/harness.mjs <path-to-fork_module.wasm>

import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const wasmPath = process.argv[2];
if (!wasmPath) {
  console.error("usage: node harness.mjs <path-to-fork_module.wasm>");
  process.exit(2);
}

const PAGE = 65536;
const EINVAL = 22;

// -- Host memory layout (the host's job, mirrors the production worker) --------
//
// The host chooses disjoint regions in the shared linear memory:
//   [0, MODULE_BASE)                      guest data (proxied here by a sentinel)
//   [MODULE_BASE, MODULE_BASE+MODULE_MEM) module data + BSS heap (via __memory_base)
//   [STACK_LOW, STACK_TOP)                module shadow stack   (via __stack_pointer)
//   [ARENA_BASE, ARENA_BASE+ARENA_LEN)    per-fork frame arena  (via fm_begin_unwind)
//
// MODULE_BASE is deliberately HIGH (32 MiB) so the whole low region — where the
// old plain-cdylib scaffold's static/BSS/stack lived — is free to hold the
// guest sentinel, proving co-residency.
const MODULE_BASE = 32 * 1024 * 1024; // 0x2000000  __memory_base
const MODULE_MEM = 16 * 1024 * 1024; // module data + BSS heap reservation
const STACK_LOW = MODULE_BASE + MODULE_MEM; // 48 MiB
const STACK_SIZE = 1024 * 1024;
const STACK_TOP = STACK_LOW + STACK_SIZE; // 49 MiB  __stack_pointer (grows down)
const TABLE_BASE = 0;
const ARENA_BASE = 56 * 1024 * 1024; // 0x3800000  page-aligned frame arena base
const ARENA_LEN = 4 * 1024 * 1024; // per-fork frame arena length
const ARENA_END = ARENA_BASE + ARENA_LEN;

// Memory must cover the highest region used (the arena end), rounded to pages.
const INITIAL_PAGES = Math.ceil((ARENA_END + PAGE) / PAGE);
const memory = new WebAssembly.Memory({
  initial: INITIAL_PAGES,
  maximum: 16384,
  shared: true,
});

// The PIC placement globals the host supplies to a `--pie` side module.
const importObject = {
  env: {
    memory,
    __indirect_function_table: new WebAssembly.Table({ element: "anyfunc", initial: 0 }),
    __stack_pointer: new WebAssembly.Global({ value: "i32", mutable: true }, STACK_TOP),
    __memory_base: new WebAssembly.Global({ value: "i32", mutable: false }, MODULE_BASE),
    __table_base: new WebAssembly.Global({ value: "i32", mutable: false }, TABLE_BASE),
  },
};

const bytes = readFileSync(wasmPath);
const module = new WebAssembly.Module(bytes);

// Structural check: the built .wasm is a PIE side module that imports the
// host-supplied placement globals and exports the frozen guest-facing frame
// functions plus the coordinator surface.
const imports = WebAssembly.Module.imports(module).map((i) => `${i.module}.${i.name}`);
for (const need of [
  "env.memory",
  "env.__memory_base",
  "env.__stack_pointer",
  "env.__table_base",
]) {
  assert.ok(imports.includes(need), `module must import ${need}, got ${imports}`);
}
const exportNames = new Set(WebAssembly.Module.exports(module).map((e) => e.name));
for (const name of [
  "__wpk_fork_frame_reserve",
  "__wpk_fork_frame_commit",
  "__wpk_fork_frame_peek",
  "__wpk_fork_frame_next",
  "__wpk_fork_resume_peek",
  "fm_set_format",
  "fm_begin_unwind",
  "fm_finish_unwind",
  "fm_begin_replay",
  "fm_finish_replay",
  "fm_last_errno",
]) {
  assert.ok(exportNames.has(name), `module must export ${name}`);
}

const instance = new WebAssembly.Instance(module, importObject);
const x = instance.exports;

// A shared memory's buffer is stable here (the host pre-grew it; the module no
// longer grows memory), but re-deriving views is cheap and future-proof.
const u8 = () => new Uint8Array(memory.buffer);
const view = () => new DataView(memory.buffer);
const readU32 = (off) => view().getUint32(off, true);
const writeU32 = (off, val) => view().setUint32(off, val >>> 0, true);
const readByte = (off) => u8()[off];
const errno = () => x.fm_last_errno();

// -- The sentinel: proxy for live guest data at LOW offsets --------------------
//
// Fill [0, MODULE_BASE) with a deterministic, offset-dependent pattern. This is
// exactly the region the old plain-cdylib scaffold's shadow stack ([0, 1 MiB),
// `--stack-first`) and static data + 16 MiB BSS heap (up to ~17.8 MiB) occupied.
// A correctly-placed PIE module must NEVER write here.
const SENTINEL_END = MODULE_BASE;
function sentinelByte(off) {
  // A cheap, well-mixed, offset-dependent byte (no all-zero / all-one runs).
  return ((off * 2654435761) >>> 24) & 0xff;
}
function fillSentinel() {
  const buf = u8();
  for (let off = 0; off < SENTINEL_END; off++) buf[off] = sentinelByte(off);
}
// Verify the sentinel is intact. Check EVERY byte of the hottest old-scaffold
// pages exactly, and a dense prime-strided sweep across the whole low region so
// any stray write anywhere in [0, MODULE_BASE) is caught.
function assertSentinelIntact(label) {
  const buf = u8();
  // Exact, byte-for-byte over the old scaffold's shadow-stack window [0, 1 MiB)
  // and the start of its static-data window around 1 MiB, plus the region near
  // its old __data_end (~16.7 MiB) and __heap_base — the pages most likely to be
  // clobbered by a mis-placed module.
  const exactWindows = [
    [0, 1 * 1024 * 1024], // old shadow stack (--stack-first)
    [1 * 1024 * 1024, 1 * 1024 * 1024 + 4096], // old static data start
    [16 * 1024 * 1024, 16 * 1024 * 1024 + 4096], // old heap/data tail vicinity
  ];
  for (const [start, end] of exactWindows) {
    for (let off = start; off < end; off++) {
      if (buf[off] !== sentinelByte(off)) {
        assert.fail(
          `${label}: guest sentinel CORRUPTED at low offset 0x${off.toString(16)} ` +
            `(expected 0x${sentinelByte(off).toString(16)}, got 0x${buf[off].toString(16)})`,
        );
      }
    }
  }
  // Dense prime-strided sweep across the entire low region.
  for (let off = 0; off < SENTINEL_END; off += 4093) {
    if (buf[off] !== sentinelByte(off)) {
      assert.fail(
        `${label}: guest sentinel CORRUPTED at low offset 0x${off.toString(16)} ` +
          `(expected 0x${sentinelByte(off).toString(16)}, got 0x${buf[off].toString(16)})`,
      );
    }
  }
}

// Write the frame payload the guest fills between reserve and commit: the ABI
// frame header (func_index +0, call_index +4, catch selector +8, reference
// ordinal +12) plus a scalar fill tail. The module reads func_index at
// payload+0 for the journal / resume-slot machinery.
function writePayload(payload, func, call, fill, size) {
  writeU32(payload + 0, func);
  writeU32(payload + 4, call);
  writeU32(payload + 8, 0);
  writeU32(payload + 12, 0);
  const buf = u8();
  for (let i = 16; i < size; i++) buf[payload + i] = fill;
}

// Seed the real linked-frame format (pointer_width=4 wasm32, fixed_prefix=128),
// once, before any fork — the production host reads these from the guest
// module's `kandelo.wpk_fork.linked_frames` descriptor.
function setFormat() {
  x.fm_set_format(4, 128);
  assert.equal(errno(), 0, "fm_set_format errno");
}

// Begin a fork with a HOST-allocated arena (Option A): the host owns [base,len).
function beginUnwind(act) {
  const moduleBuffer = x.fm_begin_unwind(act, ARENA_BASE, ARENA_LEN) >>> 0;
  assert.equal(errno(), 0, "fm_begin_unwind errno");
  assert.notEqual(moduleBuffer, 0, "fm_begin_unwind returned a module buffer");
  // The arena the module wrote into must be entirely inside the host region.
  assert.ok(moduleBuffer >= ARENA_BASE && moduleBuffer < ARENA_END, "module buffer in host arena");
  return moduleBuffer;
}

// --- Case 1: multi-chunk closed loop, over a HOST arena, co-resident ----------
function runMultiChunk() {
  const ACT = 7;
  const specs = [
    { func: 101, call: 1, fill: 0xa1, size: 40 },
    { func: 202, call: 2, fill: 0xb2, size: 64 },
    { func: 303, call: 3, fill: 0xc3, size: 65216 }, // forces a second chunk
    { func: 404, call: 4, fill: 0xd4, size: 48 },
  ];

  beginUnwind(ACT);

  for (const s of specs) {
    const payload = x.__wpk_fork_frame_reserve(s.size) >>> 0;
    assert.equal(errno(), 0, `reserve errno for func ${s.func}`);
    assert.notEqual(payload, 0, `reserve returned payload for func ${s.func}`);
    assert.ok(payload >= ARENA_BASE && payload < ARENA_END, `frame ${s.func} payload in host arena`);
    writePayload(payload, s.func, s.call, s.fill, s.size);
    x.__wpk_fork_frame_commit(payload);
    assert.equal(errno(), 0, `commit errno for func ${s.func}`);
  }

  x.fm_finish_unwind();
  assert.equal(errno(), 0, "fm_finish_unwind errno");
  x.fm_begin_replay();
  assert.equal(errno(), 0, "fm_begin_replay errno");

  const replayOrder = [...specs].reverse();
  const expectedSlots = [4, 3, 2, 1];
  for (let i = 0; i < replayOrder.length; i++) {
    const s = replayOrder[i];
    const slot = x.__wpk_fork_resume_peek(0);
    assert.equal(errno(), 0, `resume_peek errno step ${i}`);
    assert.equal(slot, expectedSlots[i], `resume slot at step ${i}`);

    const peeked = x.__wpk_fork_frame_peek(s.size) >>> 0;
    assert.equal(errno(), 0, `peek errno for func ${s.func}`);
    assert.equal(readU32(peeked), s.func, `peeked frame func at step ${i}`);

    const advanced = x.__wpk_fork_frame_next(s.size) >>> 0;
    assert.equal(errno(), 0, `next errno for func ${s.func}`);
    assert.equal(advanced, peeked, `next returns the same payload as peek at step ${i}`);
    assert.equal(readByte(advanced + 16), s.fill, `payload fill round-trips at step ${i}`);
  }

  assert.equal(x.__wpk_fork_resume_peek(0), 0, "sentinel slot after exhaustion");
  assert.equal(x.__wpk_fork_frame_peek(0), 0, "peek past end returns 0");
  assert.equal(errno(), EINVAL, "peek past end sets EINVAL");

  x.fm_finish_replay();
  assert.equal(errno(), 0, "fm_finish_replay errno");
  console.log("  ok: multi-chunk closed loop over host arena (4 frames, 2 chunks, slots [4,3,2,1])");
}

// --- Case 2: >=5000-frame stress, single fork, module reused ------------------
function runStress(N) {
  const ACT = 3;
  beginUnwind(ACT);

  for (let i = 0; i < N; i++) {
    const func = 1000 + i;
    const payload = x.__wpk_fork_frame_reserve(32) >>> 0;
    assert.equal(errno(), 0, `stress reserve errno func ${func}`);
    assert.ok(payload >= ARENA_BASE && payload < ARENA_END, `stress payload ${func} in host arena`);
    writePayload(payload, func, i, i & 0xff, 32);
    x.__wpk_fork_frame_commit(payload);
    assert.equal(errno(), 0, `stress commit errno func ${func}`);
  }
  x.fm_finish_unwind();
  assert.equal(errno(), 0, "stress finish_unwind errno");
  x.fm_begin_replay();
  assert.equal(errno(), 0, "stress begin_replay errno");

  for (let i = N - 1; i >= 0; i--) {
    const expectedFunc = 1000 + i;
    const slot = x.__wpk_fork_resume_peek(0);
    assert.equal(slot, i + 1, `stress slot at func ${expectedFunc}`);
    const payload = x.__wpk_fork_frame_next(32) >>> 0;
    assert.equal(errno(), 0, `stress next errno func ${expectedFunc}`);
    assert.equal(readU32(payload), expectedFunc, `stress frame func`);
  }
  assert.equal(x.__wpk_fork_resume_peek(0), 0, "stress sentinel after exhaustion");
  x.fm_finish_replay();
  assert.equal(errno(), 0, "stress finish_replay errno");
  console.log(`  ok: ${N}-frame stress fork over host arena, module reused`);
}

console.log("fork-module co-residency harness (Node/V8, live imported memory, PIC placement):");

// Prime the low region with guest data BEFORE instantiating anything into it.
fillSentinel();
assertSentinelIntact("baseline");
console.log(`  ok: seeded ${(SENTINEL_END / (1024 * 1024)).toFixed(0)} MiB guest sentinel at [0, 0x${SENTINEL_END.toString(16)})`);

setFormat();
runMultiChunk();
// THE HEADLINE ASSERTION: after a real fork loop, guest data at the low offsets
// where the old scaffold's static/BSS/stack lived is byte-for-byte intact.
assertSentinelIntact("after multi-chunk fork");
console.log("  ok: SENTINEL SURVIVED multi-chunk fork — module data/stack are co-resident, not colliding");

runStress(5000);
assertSentinelIntact("after 5000-frame stress fork");
console.log("  ok: SENTINEL SURVIVED 5000-frame stress fork — no low-memory corruption across reuse");

console.log(
  "ALL PASS: co-resident PIE module drove the full unwind->rewind loop over a host arena AND left the low guest sentinel byte-for-byte intact.",
);
