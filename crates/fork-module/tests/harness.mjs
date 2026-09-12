// CO-RESIDENCY + RETAINED-SURFACE validation harness for the fork-module PIE
// side module, running in a real production WebAssembly engine (Node's V8 — the
// same engine the browser and Node process workers run).
//
// It proves that the fork-module, built as a position-independent (PIC / `--pie`)
// side module whose data, BSS heap, and shadow stack are placed by HOST-supplied
// `__memory_base` / `__stack_pointer` / `__table_base` globals into a
// host-reserved HIGH region, can be instantiated AGAINST LIVE, NON-EMPTY guest
// memory WITHOUT corrupting the guest's data at the LOW offsets where the old
// plain-cdylib scaffold's static/BSS/stack lived. The harness fills the low
// region with a known sentinel pattern BEFORE instantiating, then asserts it is
// byte-for-byte UNCHANGED after instantiation (passive-segment relocation runs
// in the module's start function) and after exercising the RETAINED coordinator
// surface.
//
// SCOPE (Phase 6 fork inversion, item #4): the fine-grained frame/journal/replay
// DRIVE this harness used to run — `fm_begin_unwind_fixed_arena`,
// `fm_finish_unwind`, `fm_begin_replay`/`fm_finish_replay`,
// `fm_begin_abort`/`fm_finish_abort`, `fm_serialize_journal_fixed_arena`,
// `fm_begin_child_replay`, and the full parent -> address-space-copy -> child
// replay-seeding round trip — exercised in-realm, no-servicer primitives that
// are being DELETED in favor of the coarse `fm_parent_*`/`fm_child_*` phase
// entries the production TS host (`host/src/fork-module-backend.ts`) and native
// host (`crates/host-native/src/guest.rs`) now drive. Those coarse entries fold
// the guest continuation drive (`call_indirect` over `__wpk_fork_drive_table`)
// and a channel-mmap arena handshake that blocks on a host servicer — neither of
// which a single-threaded bare-Node harness can provide — so the drive cannot be
// re-expressed at the coarse level here. It is covered where the primitives now
// live, in `crates/fork-codec`: multi-chunk + 5000-frame writer round trips
// (`linked_frames_writer`), tail-first rewind order + corruption rejection +
// wrong-activation anti-aliasing (`rewind_driver`), parent/child journal +
// per-activation resume slots + KFRE child-seed + abort pairing
// (`replay_journal`), and KFRE image encode/decode (`replay_events`). Wasmtime
// co-residency + coordinator execution against the compiled module is proven in
// `crates/host-native` (`smoke_instantiates_fork_module`). This harness retains
// the V8 co-residency proof and the RETAINED coordinator/marshalling/infra
// surface (`fm_set_format`, `fm_externref_handle`, `fm_stats`) that no
// host-triple Rust test exercises on the actual browser/Node engine.
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

// -- Host memory layout (the host's job, mirrors the production worker) --------
//
// The host chooses disjoint regions in the shared linear memory:
//   [0, MODULE_BASE)                      guest data (proxied here by a sentinel)
//   [MODULE_BASE, MODULE_BASE+MODULE_MEM) module data + BSS heap (via __memory_base)
//   [STACK_LOW, STACK_TOP)                module shadow stack   (via __stack_pointer)
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

// Memory must cover the highest region used (the shadow-stack top), plus a page.
const INITIAL_PAGES = Math.ceil((STACK_TOP + PAGE) / PAGE);
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
    // Phase 6 D6.1: the module imports the guest's funcref function catalog for
    // `__wpk_fork_ref_decode_funcref`. This co-residency harness never
    // reconstructs references, so an empty funcref table is inert here.
    __wpk_fork_function_catalog: new WebAssembly.Table({ element: "anyfunc", initial: 0 }),
    __wpk_fork_drive_table: new WebAssembly.Table({ element: "anyfunc", initial: 0 }),
    // M2: the merged, host-owned static-root catalog (anyref) the injected drive
    // shim reads on a DRIVE_OP_STATIC_ROOT step. This reference-free harness
    // never drives a reference replay, so an empty table is inert here.
    __wpk_fork_static_root_catalog: new WebAssembly.Table({ element: "anyref", initial: 0 }),
    __stack_pointer: new WebAssembly.Global({ value: "i32", mutable: true }, STACK_TOP),
    __memory_base: new WebAssembly.Global({ value: "i32", mutable: false }, MODULE_BASE),
    __table_base: new WebAssembly.Global({ value: "i32", mutable: false }, TABLE_BASE),
    // M2: the single residual externref host import,
    // `resolve_externref(handle) -> externref`. Never exercised by this harness;
    // a stub returning a fresh unique object per call satisfies the
    // reference-returning import signature.
    resolve_externref: (_handle) => ({}),
  },
};

const bytes = readFileSync(wasmPath);
const module = new WebAssembly.Module(bytes);

// Structural check: the built .wasm is a PIE side module that imports the
// host-supplied placement globals.
const imports = WebAssembly.Module.imports(module).map((i) => `${i.module}.${i.name}`);
for (const need of [
  "env.memory",
  "env.__memory_base",
  "env.__stack_pointer",
  "env.__table_base",
  // Phase 6 D6.1: the injected funcref decode export reads this funcref table.
  "env.__wpk_fork_function_catalog",
]) {
  assert.ok(imports.includes(need), `module must import ${need}, got ${imports}`);
}
// H3 (host-surface minimization, 2026-09-06): the engine-floor host-capability
// seam (Phase 6 D6, `wpk_fork_host.*`) that used to be asserted present here was
// DELETED — it was never wired to any guest on any host. Assert the ABSENCE
// instead, so a future regression that reintroduces the seam surfaces here.
assert.ok(
  !imports.some((i) => i.startsWith("wpk_fork_host.")),
  `module must not import from wpk_fork_host (deleted seam), got ${imports}`,
);

// The frozen guest-facing frame ABI plus the RETAINED coordinator / marshalling
// / infra surface this harness exercises. It deliberately does NOT reference the
// fine-grained frame-DRIVE exports (fm_begin_unwind*/fm_finish_unwind/
// fm_begin_replay/fm_finish_replay/fm_begin_abort/fm_finish_abort/
// fm_serialize_journal_*/fm_begin_child_replay): those are the coarse-inversion
// casualties whose behavior now lives in crates/fork-codec.
const exportNames = new Set(WebAssembly.Module.exports(module).map((e) => e.name));
for (const name of [
  // Frozen guest-facing frame ABI (retained — not a fork-DRIVE primitive).
  "__wpk_fork_frame_reserve",
  "__wpk_fork_frame_commit",
  "__wpk_fork_frame_peek",
  "__wpk_fork_frame_next",
  "__wpk_fork_resume_peek",
  // Retained genuine seed + infra.
  "fm_set_format",
  "fm_last_errno",
  // Phase 6 D6.1 reference reconstruction (funcref + null) — retained marshalling.
  "__wpk_fork_ref_decode_funcref",
  "fm_begin_reference_replay",
  // The single folded proof-of-use counter accessor (fm_stats(field) -> i64).
  "fm_stats",
  // M2: the injected binder's helper for the externref recipe -> broker handle
  // lookup (mirrors fm_funcref_ordinal/fm_static_root_slot).
  "fm_externref_handle",
]) {
  assert.ok(exportNames.has(name), `module must export ${name}`);
}

// Field indices for the folded fm_stats(field) accessor. MUST match fm_stats's
// match arms in crates/fork-module/src/lib.rs.
const FM_STAT = {
  FRAMES_COMMITTED: 0,
  FRAMES_REPLAYED: 1,
  REFERENCES_RECONSTRUCTED: 2,
  EXTERNREFS_RESOLVED: 3,
  EXNREFS_RECONSTRUCTED: 4,
  GC_NODES_RECONSTRUCTED: 5,
  STATIC_ROOTS_PUBLISHED: 6,
  DRIVE_STEPS_EXECUTED: 7,
  REF_FEED_READS: 8,
  REFERENCE_GRAPHS_DECODED: 9,
  EXTERNREF_HANDLES_SCANNED: 10,
};

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
function fillSentinel(buf) {
  for (let off = 0; off < SENTINEL_END; off++) buf[off] = sentinelByte(off);
}
// Verify the sentinel is intact. Check EVERY byte of the hottest old-scaffold
// pages exactly, and a dense prime-strided sweep across the whole low region so
// any stray write anywhere in [0, MODULE_BASE) is caught.
function assertSentinelIntact(label) {
  const buf = new Uint8Array(memory.buffer);
  // Exact, byte-for-byte over the old scaffold's shadow-stack window [0, 1 MiB)
  // and the start of its static-data window around 1 MiB, plus the region near
  // its old __data_end (~16.7 MiB) — the pages most likely to be clobbered by a
  // mis-placed module.
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

console.log("fork-module co-residency harness (Node/V8, live imported memory, PIC placement):");

// Prime the low region with guest data BEFORE instantiating anything into it.
fillSentinel(new Uint8Array(memory.buffer));
assertSentinelIntact("baseline");
console.log(`  ok: seeded ${(SENTINEL_END / (1024 * 1024)).toFixed(0)} MiB guest sentinel at [0, 0x${SENTINEL_END.toString(16)})`);

// Instantiate the PIE module against the live, sentinel-filled memory. The
// module's start function relocates its passive data segments into the reserved
// HIGH region [MODULE_BASE, ...) — if it were mis-placed at low offsets (as the
// old plain-cdylib scaffold was), this would clobber the sentinel.
const instance = new WebAssembly.Instance(module, importObject);
const x = instance.exports;
const errno = () => x.fm_last_errno();
assertSentinelIntact("after instantiation (start-function passive-segment relocation)");
console.log("  ok: SENTINEL SURVIVED instantiation — module data/BSS/stack are co-resident (placed HIGH), not colliding");

// -- Retained coordinator surface: seed the linked-frame format --------------
// `fm_set_format` writes the module's own coordinator state (in the reserved
// region). Success (errno 0) proves the instance is genuinely executable — the
// call reaches real fork-module code, which only works if the start function
// already relocated its passive data into the reserved region.
x.fm_set_format(4, 128);
assert.equal(errno(), 0, "fm_set_format errno");
assertSentinelIntact("after fm_set_format");
console.log("  ok: fm_set_format(4, 128) succeeded; SENTINEL SURVIVED a coordinator write");

// -- M2: fm_externref_handle traps outside a seeded reference replay ----------
//
// `fm_externref_handle` is the helper the INJECTED binder calls to get the
// broker handle for an externref recipe, keyed off the reference-replay driver
// `fm_begin_reference_replay` seeds. This harness never seeds one, so calling it
// must TRAP (`wasm_intr::unreachable`) rather than silently return a value — the
// same truthful-corruption contract `fm_funcref_ordinal`/`fm_static_root_slot`
// uphold. The full recipe -> captured-handle round trip is validated end to end
// in `host/test/fork-module-externref-replay.test.ts`.
assert.throws(
  () => x.fm_externref_handle(0),
  /unreachable/i,
  "fm_externref_handle traps with no reference state seeded",
);
console.log("  ok: fm_externref_handle traps outside a seeded reference replay (no silent value)");

// -- Phase 6 D6.3a/D6.4a: the reference proof-of-use counters are inert here --
//
// `fm_exnrefs_reconstructed` / `fm_gc_nodes_reconstructed` advance ONLY when
// `fm_begin_reference_replay` admits an exnref- / typed-GC-bearing graph and
// drives it. This harness never drives a reference replay, so the counters must
// still read 0 — proving the counter exports are real and not spuriously bumped.
// The full drives are validated in `host/test/fork-module-exnref-replay.test.ts`
// and `host/test/fork-module-gc-replay.test.ts`.
assert.equal(
  x.fm_stats(FM_STAT.EXNREFS_RECONSTRUCTED),
  0n,
  "exnref counter is inert until fm_begin_reference_replay admits an exnref graph",
);
assert.equal(
  x.fm_stats(FM_STAT.GC_NODES_RECONSTRUCTED),
  0n,
  "typed-GC counter is inert until fm_begin_reference_replay admits a GC graph",
);
console.log("  ok: fm_stats reference counters present and inert (0) outside a reference replay");

assertSentinelIntact("final");
console.log("");
console.log(
  "ALL PASS: co-resident PIE module instantiated + exercised its retained coordinator surface "
    + "over live imported memory and left the low guest sentinel byte-for-byte intact.",
);
