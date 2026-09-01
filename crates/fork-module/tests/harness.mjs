// End-to-end validation harness for the co-resident fork-module cdylib.
//
// THIS IS THE KEY DELIVERABLE of the Phase 6 D2 scaffold: it proves, in a real
// production WebAssembly engine (Node's V8 — the same engine the browser/Node
// process workers run), that a SECOND wasm module can
//
//   1. import the guest's linear Memory as `env.memory`,
//   2. export the guest-facing `__wpk_fork_frame_*` / `__wpk_fork_resume_peek`
//      functions with the frozen guest ABI signatures, and
//   3. drive the full reserve/commit -> next/peek/resume continuation loop
//      against that shared memory,
//
// end to end, matching the pure-logic expectation the fork-codec unit tests
// already pin down. See
// `.superpowers/sdd/2026-09-01-phase6-fork-exec/D2-CORESIDENT-MODULE-DESIGN.md`.
//
// Engine choice: we use Node/V8 rather than the `wasmtime` crate because V8 is
// the actual production engine for the Node and browser process workers, and
// because the crate is a wasm32-only cdylib (a host-target `cargo test` cannot
// build it). V8 exercising the exact SharedArrayBuffer + imported-memory path
// the host uses is the most faithful proof. See the crate README.
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

// The module imports env.memory as a shared memory (built with
// --import-memory --shared-memory, exactly like the kernel). Provide a shared
// memory whose initial size comfortably exceeds the module's static footprint
// (its 8 MiB bump heap + stack + data); the module grows the memory itself to
// carve the per-fork frame arena above everything.
const memory = new WebAssembly.Memory({ initial: 512, maximum: 16384, shared: true });

const bytes = readFileSync(wasmPath);
const module = new WebAssembly.Module(bytes);

// Structural check: the built .wasm imports env.memory and exports the frozen
// guest-facing frame functions. (wasm-objdump verifies signatures separately.)
const importNames = WebAssembly.Module.imports(module).map((i) => `${i.module}.${i.name}`);
assert.ok(importNames.includes("env.memory"), `module must import env.memory, got ${importNames}`);
const exportNames = new Set(WebAssembly.Module.exports(module).map((e) => e.name));
for (const name of [
  "__wpk_fork_frame_reserve",
  "__wpk_fork_frame_commit",
  "__wpk_fork_frame_peek",
  "__wpk_fork_frame_next",
  "__wpk_fork_resume_peek",
  "fm_begin_unwind",
  "fm_finish_unwind",
  "fm_begin_replay",
  "fm_finish_replay",
  "fm_last_errno",
]) {
  assert.ok(exportNames.has(name), `module must export ${name}`);
}

const instance = new WebAssembly.Instance(module, { env: { memory } });
const x = instance.exports;

// A fresh DataView every access: growing a shared memory replaces the buffer.
const view = () => new DataView(memory.buffer);
const readU32 = (off) => view().getUint32(off, true);
const writeU32 = (off, val) => view().setUint32(off, val >>> 0, true);
const writeByte = (off, val) => new Uint8Array(memory.buffer)[off] = val & 0xff;
const readByte = (off) => new Uint8Array(memory.buffer)[off];
const errno = () => x.fm_last_errno();

// Write the frame payload the guest would fill between reserve and commit: the
// ABI frame header (func_index at +0, call_index at +4, catch selector +8,
// reference-vector ordinal +12) plus a scalar fill tail. The module reads
// func_index at payload+0 for the journal / resume-slot machinery.
function writePayload(payload, func, call, fill, size) {
  writeU32(payload + 0, func);
  writeU32(payload + 4, call);
  writeU32(payload + 8, 0);
  writeU32(payload + 12, 0);
  const u8 = new Uint8Array(memory.buffer);
  for (let i = 16; i < size; i++) u8[payload + i] = fill;
}

// --- Case 1: multi-chunk closed loop (the headline) ---------------------------
//
// Four frames, innermost-first, with one oversized frame that forces the module
// to allocate a SECOND continuation chunk mid-unwind. Distinct function
// ordinals so the resume-slot table assigns deterministic slots (sorted
// ascending: 101->1, 202->2, 303->3, 404->4). Rewind is tail-first (outermost
// committed first), so the expected replay order is the reverse of commit order
// and the expected resume slots are [4, 3, 2, 1].
function runMultiChunk() {
  const ACT = 7;
  const specs = [
    { func: 101, call: 1, fill: 0xa1, size: 40 },
    { func: 202, call: 2, fill: 0xb2, size: 64 },
    { func: 303, call: 3, fill: 0xc3, size: 65216 }, // forces a second chunk
    { func: 404, call: 4, fill: 0xd4, size: 48 },
  ];

  // Grow a 16-page (1 MiB) frame arena and begin the unwind.
  const moduleBuffer = x.fm_begin_unwind(ACT, 16) >>> 0;
  assert.equal(errno(), 0, "fm_begin_unwind errno");
  assert.notEqual(moduleBuffer, 0, "fm_begin_unwind returned a module buffer");

  // Reserve + fill + commit each frame, innermost first (the guest's per-frame
  // reserve/commit transaction).
  const payloads = [];
  for (const s of specs) {
    const payload = x.__wpk_fork_frame_reserve(s.size) >>> 0;
    assert.equal(errno(), 0, `reserve errno for func ${s.func}`);
    assert.notEqual(payload, 0, `reserve returned payload for func ${s.func}`);
    writePayload(payload, s.func, s.call, s.fill, s.size);
    x.__wpk_fork_frame_commit(payload);
    assert.equal(errno(), 0, `commit errno for func ${s.func}`);
    payloads.push(payload);
  }

  x.fm_finish_unwind();
  assert.equal(errno(), 0, "fm_finish_unwind errno");

  x.fm_begin_replay();
  assert.equal(errno(), 0, "fm_begin_replay errno");

  // Rewind: tail-first (reverse of commit order). At each step the resume slot,
  // the journal-gated peek, and the consuming next must all agree.
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

  // Exhausted: resume_peek yields the reserved sentinel slot 0, and a further
  // peek is a truthful EINVAL (not a panic, not a false success).
  assert.equal(x.__wpk_fork_resume_peek(0), 0, "sentinel slot after exhaustion");
  assert.equal(x.__wpk_fork_frame_peek(0), 0, "peek past end returns 0");
  assert.equal(errno(), EINVAL, "peek past end sets EINVAL");

  x.fm_finish_replay();
  assert.equal(errno(), 0, "fm_finish_replay errno");
  console.log("  ok: multi-chunk closed loop (4 frames, 2 chunks, slots [4,3,2,1])");
}

// --- Case 2: many-frame stress, single chunk ---------------------------------
//
// A deep single-activation stack to show the loop scales past a few frames and
// that per-fork heap reset lets the module be reused across forks.
function runStress() {
  const ACT = 3;
  const N = 300;
  const specs = [];
  for (let i = 0; i < N; i++) specs.push({ func: 1000 + i, call: i, fill: i & 0xff, size: 32 });

  const moduleBuffer = x.fm_begin_unwind(ACT, 16) >>> 0;
  assert.equal(errno(), 0, "stress fm_begin_unwind errno");
  assert.notEqual(moduleBuffer, 0);

  for (const s of specs) {
    const payload = x.__wpk_fork_frame_reserve(s.size) >>> 0;
    assert.equal(errno(), 0, `stress reserve errno func ${s.func}`);
    writePayload(payload, s.func, s.call, s.fill, s.size);
    x.__wpk_fork_frame_commit(payload);
    assert.equal(errno(), 0, `stress commit errno func ${s.func}`);
  }
  x.fm_finish_unwind();
  assert.equal(errno(), 0, "stress finish_unwind errno");
  x.fm_begin_replay();
  assert.equal(errno(), 0, "stress begin_replay errno");

  // Replay is reverse of commit order; funcs are distinct so slots are the
  // 1-based rank of the func ordinal. func 1000+i has rank i+1; replay visits
  // i = N-1 .. 0, so slots go N, N-1, ... 1.
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
  console.log(`  ok: ${N}-frame stress loop, module reused across forks`);
}

console.log("fork-module end-to-end harness (Node/V8, shared imported memory):");
runMultiChunk();
runStress();
console.log("ALL PASS: co-resident module drove the full unwind->rewind loop against the imported guest memory.");
