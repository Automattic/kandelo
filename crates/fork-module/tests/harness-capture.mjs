// V8 end-to-end validation harness for the fork-module CAPTURE session
// (Path B P3 — the module-owned encode graph over the shared
// `fork_codec::ReferenceGraphBuilder`).
//
// It exercises the module's GUEST-facing capture entries (`__wpk_fork_ref_*`,
// `__wpk_fork_module_state_*`) and the host entries the injected scans call in
// a real WebAssembly engine.
//
// NOT RUNNABLE AS IT STANDS. It traps at the first capture begin, because
// opening a capture now maps its arena through the guest syscall channel and
// nothing here services it; that was already true before the fork test-only
// removal (2026-09-23). That removal deleted the host-only `fm_capture_*`
// exports this harness was first written against (intern, claim, define,
// validate, serialize, the serialized-length and header-size readers, the
// interned counter and the gated placeholder) together with the sections that
// tested only them; the surviving sections seed through the guest-facing
// entries instead. The capture builder's own logic is tested in-crate
// (`fork-codec` reference_graph_builder / reference_segments_writer), and the
// module's capture path end to end by the host/test `fork-module-*` suites,
// which run a channel responder.
//
// Run: node crates/fork-module/tests/harness-capture.mjs <path-to-fork_module.wasm>

import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";

const wasmPath = process.argv[2];
if (!wasmPath) {
  console.error("usage: node harness-capture.mjs <path-to-fork_module.wasm>");
  process.exit(2);
}

const PAGE = 65536;
const EINVAL = 22;

// GC aggregate kinds __wpk_fork_ref_gc_define accepts.
const KIND_STRUCT = 1;

// -- Host memory layout (mirrors the production worker / harness.mjs) ----------
const MODULE_BASE = 32 * 1024 * 1024; // __memory_base
const MODULE_MEM = 16 * 1024 * 1024;
const STACK_LOW = MODULE_BASE + MODULE_MEM;
const STACK_SIZE = 1024 * 1024;
const STACK_TOP = STACK_LOW + STACK_SIZE;
const TABLE_BASE = 0;
const RECONCILE_TABLE_SLOTS = 4096;
// A scratch region in the low (guest-proxied) area for the argument arrays this
// harness hands to the define entries. Well below MODULE_BASE, so it never
// collides with the module's own data / BSS / stack.
const SCRATCH_BASE = 1 * 1024 * 1024;

const INITIAL_PAGES = Math.ceil((STACK_TOP + PAGE) / PAGE);
const memory = new WebAssembly.Memory({
  initial: INITIAL_PAGES,
  maximum: 16384,
  shared: true,
});

const materializeRequests = [];
const importObject = {
  env: {
    memory,
    // Sized for the table-reconcile block at the end of this file, and at
    // least as large as the module's own dylink table minimum.
    __indirect_function_table: new WebAssembly.Table({
      element: "anyfunc",
      initial: RECONCILE_TABLE_SLOTS,
    }),
    __wpk_fork_function_catalog: new WebAssembly.Table({ element: "anyfunc", initial: 0 }),
    __wpk_fork_drive_table: new WebAssembly.Table({ element: "anyfunc", initial: 0 }),
    __wpk_fork_static_root_catalog: new WebAssembly.Table({ element: "anyref", initial: 0 }),
    __stack_pointer: new WebAssembly.Global({ value: "i32", mutable: true }, STACK_TOP),
    __memory_base: new WebAssembly.Global({ value: "i32", mutable: false }, MODULE_BASE),
    __table_base: new WebAssembly.Global({ value: "i32", mutable: false }, TABLE_BASE),
    // `__wpk_fork_host_ref_identity(anyref) -> i32`: a stable integer per
    // distinct GC reference. Wasm can COMPARE references but cannot HASH one,
    // so a reference cannot key a map inside the module; the host can. On a
    // real JavaScript host this is a WeakMap; here a Map suffices because the
    // values under test are i31s, which are primitives at this boundary.
    // `__wpk_fork_host_func_identity(funcref) -> i32`: the ONE thing the module
    // cannot do for itself when encoding a funcref. Wasm cannot compare two
    // `funcref`s -- `ref.eq` validates only on `eqref` and the hierarchies are
    // disjoint -- so the host answers "are these the same function?" and the
    // module owns the scan and every decision built on the answer. A Map keyed by
    // the exported function object here; wasmtime uses `Func::to_raw`.
    // The module asks this to instantiate libraries a peer dlopened. The
    // harness cannot instantiate anything, so it records the request and
    // answers ENOSYS, and the reconcile case below checks both.
    __wpk_fork_host_materialize_dlopen_archive: (generation) => {
      materializeRequests.push(generation);
      return 38;
    },
    __wpk_fork_host_func_identity: (() => {
      const ids = new Map();
      let next = 1;
      return (fn) => {
        if (fn === null) return 0;
        if (!ids.has(fn)) ids.set(fn, next++);
        return ids.get(fn);
      };
    })(),
    __wpk_fork_host_ref_identity: (() => {
      const ids = new Map();
      let next = 1;
      return (value) => {
        if (!ids.has(value)) ids.set(value, next++);
        return ids.get(value);
      };
    })(),
  },
};

const bytes = readFileSync(wasmPath);
const module = new WebAssembly.Module(bytes);

const exportNames = new Set(WebAssembly.Module.exports(module).map((e) => e.name));
for (const name of [
  "fm_capture_begin",
  "fm_last_errno",
  "__wpk_fork_ref_exn_claim",
  "__wpk_fork_ref_exn_define",
  "__wpk_fork_ref_vector_begin",
  "__wpk_fork_ref_vector_append",
  "__wpk_fork_ref_vector_finish",
  "__wpk_fork_ref_gc_i31",
  "fm_transit_grow",
  "__wpk_fork_ref_gc_claim",
  "__wpk_fork_ref_gc_lookup",
  "__wpk_fork_unwind",
  "__wpk_fork_ref_scratch_reserve",
  "__wpk_fork_module_state_record_reserve",
  "__wpk_fork_module_state_record_commit",
  "__wpk_fork_module_state_record_find",
  "__wpk_fork_module_state_table_dirty_mark",
  "__wpk_fork_module_state_table_dirty_count",
  "__wpk_fork_module_state_table_dirty_page",
  "__wpk_fork_ref_scratch_release",
  "__wpk_fork_ref_gc_transit",
]) {
  assert.ok(exportNames.has(name), `module must export ${name}`);
}

const instance = new WebAssembly.Instance(module, importObject);
const x = instance.exports;

const u8 = () => new Uint8Array(memory.buffer);
const dv = () => new DataView(memory.buffer);

function writeU32Array(offset, values) {
  const view = dv();
  values.forEach((v, i) => view.setUint32(offset + i * 4, v >>> 0, true));
  return offset;
}
function writeBytes(offset, arr) {
  u8().set(Uint8Array.from(arr), offset);
  return offset;
}
function lastErrno() {
  return x.fm_last_errno();
}

// Admit one activation through `fm_admit_activation`, the entry both hosts
// admit an activation through: a `KFAA` descriptor with an all-zero template
// id, the two sections every admission requires (a wasm32 linked-frame and
// module-state descriptor, fixed prefix 0), an EMPTY resume catalog, and any
// extra `[kind, bytes]` sections (4 = GC codec). The layout is
// `fork_codec::activation_admission`'s; `host/test/support/fork-admission.ts`
// writes the same thing for the host suite.
const ADMISSION_AT = SCRATCH_BASE + 32768;
function admit(activation, extra = []) {
  const linked = new Uint8Array(24);
  const lv = new DataView(linked.buffer);
  linked.set([75, 76, 67, 70]); // "KLCF"
  lv.setUint16(4, 1, true);
  lv.setUint16(6, 24, true);
  linked[8] = 4;
  linked[9] = 8;
  lv.setUint16(10, 3, true);
  lv.setUint32(12, 32, true);
  lv.setUint32(16, 24, true);
  const state = new Uint8Array(24);
  const sv = new DataView(state.buffer);
  state.set([75, 70, 77, 68]); // "KFMD"
  sv.setUint16(4, 1, true);
  sv.setUint16(6, 24, true);
  state[8] = 4;
  state[9] = 8;
  sv.setUint16(10, 7, true);
  sv.setUint16(12, 1, true);
  sv.setUint16(14, 1, true);
  sv.setUint32(16, 1, true);
  const catalog = new Uint8Array(12);
  catalog.set([75, 70, 82, 67]); // "KFRC"
  new DataView(catalog.buffer).setUint16(4, 1, true);
  new DataView(catalog.buffer).setUint16(6, 12, true);
  const sections = [[1, linked], [2, state], [3, catalog], ...extra];
  let offset = 64 + sections.length * 12;
  const desc = new Uint8Array(sections.reduce((n, [, b]) => n + b.length, offset));
  const view = new DataView(desc.buffer);
  desc.set([75, 70, 65, 65]); // "KFAA"
  view.setUint16(4, 1, true);
  view.setUint16(6, 64, true);
  view.setUint32(8, activation, true);
  view.setUint32(48, sections.length, true);
  sections.forEach(([kind, bytes], i) => {
    view.setUint32(64 + i * 12, kind, true);
    view.setUint32(68 + i * 12, offset, true);
    view.setUint32(72 + i * 12, bytes.length, true);
    desc.set(bytes, offset);
    offset += bytes.length;
  });
  u8().set(desc, ADMISSION_AT);
  return x.fm_admit_activation(ADMISSION_AT, desc.length);
}

// ---------------------------------------------------------------------------
// The GUEST-facing reference-vector surface (env.__wpk_fork_ref_vector_*).
//
// `fork-instrument` emits, per call site with live references:
//     i32.const <slot count> ; call vector_begin        -> handle
//     N x (encode ref        ; call vector_append)
//     call vector_finish                                -> durable ordinal
//
// `append` returns NOTHING in the guest ABI, so a failed append is invisible at
// the call site. The declared count is what turns that into a loud failure at
// `finish` instead of a short vector the CHILD reconstructs with references
// missing -- a fault that would otherwise surface in another worker, later.
x.fm_capture_begin();
{
  const h = x.__wpk_fork_ref_vector_begin(2);
  assert.ok(h >= 0, "vector_begin returns a handle");
  const a = x.__wpk_fork_ref_gc_i31(11);
  const b = x.__wpk_fork_ref_gc_i31(22);
  x.__wpk_fork_ref_vector_append(h, a);
  x.__wpk_fork_ref_vector_append(h, b);
  const ordinal = x.__wpk_fork_ref_vector_finish(h);
  assert.ok(ordinal >= 0, "a vector matching its declared count interns");
  assert.notEqual(ordinal, h, "finish returns the DURABLE ordinal, not the handle");
}
{
  // Declared 2, appended 1: must fail rather than intern a short vector.
  const h = x.__wpk_fork_ref_vector_begin(2);
  x.__wpk_fork_ref_vector_append(h, x.__wpk_fork_ref_gc_i31(33));
  assert.equal(
    x.__wpk_fork_ref_vector_finish(h),
    -1,
    "a vector short of its declared count is rejected",
  );
  assert.equal(lastErrno(), EINVAL, "a short vector reports EINVAL");
}
{
  // A second begin before finish would mean the emitted shape changed.
  const h = x.__wpk_fork_ref_vector_begin(1);
  assert.equal(
    x.__wpk_fork_ref_vector_begin(1),
    -1,
    "a nested vector_begin is rejected, not silently mis-counted",
  );
  x.__wpk_fork_ref_vector_append(h, x.__wpk_fork_ref_gc_i31(44));
  assert.ok(x.__wpk_fork_ref_vector_finish(h) >= 0, "the open vector still finishes");
  assert.equal(
    x.__wpk_fork_ref_vector_finish(h),
    -1,
    "finishing a handle that is not open is rejected",
  );
}

// The guest-facing i31 leaf. `fork-instrument` converts to a scalar before the
// call, so this is the one GC capture entry with no reference in it.
{
  const a = x.__wpk_fork_ref_gc_i31(-7);
  assert.ok(a >= 1, "gc_i31 interns and returns a recipe id");
  assert.equal(x.__wpk_fork_ref_gc_i31(-7), a, "gc_i31 dedups by payload");
  assert.notEqual(x.__wpk_fork_ref_gc_i31(-8), a, "a different payload is a different recipe");
}

// The injected anyref-table growth primitive (`fm_transit_grow`).
//
// `fork-instrument`'s GC codec publishes a captured value at `recipe + 1`
// IMMEDIATELY after `claim` returns, so claim has to leave room first -- the
// generator says so: "claim grows the process-owned transit table through
// recipe+1 before returning". Rust emits neither `table.size` nor `table.grow`,
// and `table.grow` on an anyref table needs a `ref.null any` Rust has no type
// for, so this is injected wasm.
{
  const transit = x.__wpk_fork_ref_gc_transit;
  const grow = x.fm_transit_grow;
  const before = transit.length;
  assert.equal(grow(before + 7), before + 7, "grow returns the size it reached");
  assert.equal(transit.length, before + 7, "the table actually grew");
  assert.equal(grow(1), before + 7, "a smaller request returns the current size");
  assert.equal(transit.length, before + 7, "and never shrinks the table");
  assert.equal(grow(0), before + 7, "a zero request is a no-op, not a trap");
  assert.equal(
    transit.get(before + 6),
    null,
    "grown slots are null-initialised and readable",
  );
}

// The guest-facing fresh-GC claim. `fork-instrument` publishes the claimed
// value at `recipe + 1` on the instruction AFTER this returns, so the claim has
// to have grown the transit table by then or the guest traps out of bounds.
{
  const transit = x.__wpk_fork_ref_gc_transit;
  const a = x.__wpk_fork_ref_gc_claim(0);
  assert.ok(a >= 1, "gc_claim returns a recipe id");
  assert.ok(
    transit.length > a + 1,
    `gc_claim left room to publish at recipe+1 (size ${transit.length}, recipe ${a})`,
  );
  const b = x.__wpk_fork_ref_gc_claim(0);
  assert.notEqual(b, a, "each claim is a FRESH identity, never deduped");
  assert.ok(transit.length > b + 1, "and the table keeps up with each claim");
  // The publish the guest performs next must be in bounds.
  transit.set(b + 1, null);
  // The generator has one call site and it always passes slot 0. A non-zero
  // slot means the emitted shape changed, and claiming anyway would build the
  // graph against an assumption that no longer holds.
  assert.throws(
    () => x.__wpk_fork_ref_gc_claim(1),
    /unreachable/i,
    "gc_claim traps on a slot the generator never emits",
  );
}

// The guest-facing GC identity probe.
//
// Exercised against REAL comparable GC values. JavaScript cannot mint an
// `i31ref`, so this hand-encodes a two-instruction companion module that can
// (`local.get 0 ; ref.i31`). i31 is an eq-type, so it is `ref.eq`-comparable --
// the property the whole scan rests on, and the one funcref and externref lack.
function i31Minter() {
  const b = [0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0];
  const sec = (id, body) => { b.push(id, body.length, ...body); };
  sec(1, [1, 0x60, 1, 0x7f, 1, 0x6e]);          // (i32) -> anyref
  sec(3, [1, 0]);
  sec(7, [1, 2, 0x6d, 0x6b, 0x00, 0]);          // export "mk"
  const code = [0, 0x20, 0, 0xfb, 0x1c, 0x0b];  // local.get 0 ; ref.i31 ; end
  sec(10, [1, code.length, ...code]);
  return new WebAssembly.Instance(
    new WebAssembly.Module(new Uint8Array(b)), {},
  ).exports.mk;
}
{
  const mk = i31Minter();
  const transit = x.__wpk_fork_ref_gc_transit;
  const A = mk(41);
  const B = mk(42);

  // Mirror the emitted sequence exactly. The generator stages the value in slot
  // 0, calls lookup, and on a miss calls claim with the value STILL THERE --
  // slot 0 is cleared only after the payload is encoded. Claim reads it to bind
  // the identity, so a test that claimed without staging would be testing a
  // sequence the guest never emits.
  transit.set(0, A);
  const ra = x.__wpk_fork_ref_gc_claim(0);
  transit.set(ra + 1, A);

  transit.set(0, A);
  assert.equal(x.__wpk_fork_ref_gc_lookup(0), ra, "lookup finds an already-claimed value");
  transit.set(0, B);
  assert.equal(x.__wpk_fork_ref_gc_lookup(0), 0, "an unseen value is reported new");

  transit.set(0, B);
  const rb = x.__wpk_fork_ref_gc_claim(0);
  transit.set(rb + 1, B);
  transit.set(0, B);
  assert.equal(x.__wpk_fork_ref_gc_lookup(0), rb, "and is found once claimed");
  transit.set(0, A);
  assert.equal(x.__wpk_fork_ref_gc_lookup(0), ra, "without disturbing the earlier one");

  // Termination for cycles depends on this: a null or non-comparable staging
  // slot must report "new" rather than trapping, so the guest claims instead.
  transit.set(0, null);
  assert.equal(x.__wpk_fork_ref_gc_lookup(0), 0, "a null candidate is new, not a trap");

  // Claiming the SAME object twice would give the child two objects where the
  // parent had one -- a fork-only identity split, and silent. The generator
  // never does it (lookup hits first), which is exactly why the guard has to be
  // here rather than relying on the caller.
  transit.set(0, A);
  assert.equal(
    x.__wpk_fork_ref_gc_claim(0),
    -1,
    "claiming an already-bound identity is rejected, not silently re-claimed",
  );
  assert.equal(lastErrno(), EINVAL, "and reports EINVAL");
}

// The process-owned fork-unwind TAG, now minted by the module rather than by
// the host. A wasm module can define, export, throw and catch its own tag, so
// there is no reason for JavaScript to create this object and hand it over.
{
  const tag = x.__wpk_fork_unwind;
  assert.ok(tag instanceof WebAssembly.Tag, "the module exports a real WebAssembly.Tag");

  // What actually matters is that a GUEST can import it. Build a module shaped
  // like the guest's declaration -- `(import "env" "__wpk_fork_unwind" (tag))`
  // -- and instantiate it against the module-owned tag.
  const name = Buffer.from("__wpk_fork_unwind");
  const b = [0x00, 0x61, 0x73, 0x6d, 1, 0, 0, 0];
  const sec = (id, body) => { b.push(id, body.length, ...body); };
  sec(1, [1, 0x60, 0, 0]);                                          // type 0: () -> ()
  sec(2, [1, 3, 0x65, 0x6e, 0x76, name.length, ...name, 0x04, 0x00, 0]);
  const consumer = new WebAssembly.Module(new Uint8Array(b));
  new WebAssembly.Instance(consumer, { env: { __wpk_fork_unwind: tag } });

  // The arity is part of the contract, not decoration: the transport carries no
  // payload, and a tag of the wrong shape must not satisfy the import.
  assert.throws(
    () => new WebAssembly.Instance(consumer, {
      env: { __wpk_fork_unwind: new WebAssembly.Tag({ parameters: ["i32"] }) },
    }),
    "a tag of the wrong arity does not satisfy the guest import",
  );
}

// Transient exchange storage for the guest's recursive payload codecs.
// `fork-instrument` emits reserve / recurse / define / release strictly nested,
// so this is a LIFO stack, and a release that does not name the top frame means
// the nesting the scheme assumes has been violated.
{
  const a = x.__wpk_fork_ref_scratch_reserve(32);
  assert.ok(a > 0, "reserve returns a guest address");
  assert.equal(a % 16, 0, "and it is 16-byte aligned");
  const b = x.__wpk_fork_ref_scratch_reserve(48);
  assert.ok(b >= a + 32, "a nested reserve is DISJOINT from the outer one");

  // The guest writes through these addresses directly, so they must be real
  // linear memory it can touch.
  const mem = new Uint8Array(memory.buffer);
  mem[a] = 0xa5;
  mem[b] = 0x5a;
  assert.equal(mem[a], 0xa5, "the outer frame is writable");
  assert.equal(mem[b], 0x5a, "the inner frame is writable and separate");

  // LIFO: releasing the inner frame first is correct and reuses its space.
  x.__wpk_fork_ref_scratch_release(b, 48);
  assert.equal(
    x.__wpk_fork_ref_scratch_reserve(48),
    b,
    "releasing the top frame returns its space",
  );
  x.__wpk_fork_ref_scratch_release(b, 48);
  x.__wpk_fork_ref_scratch_release(a, 32);
  assert.equal(
    x.__wpk_fork_ref_scratch_reserve(32),
    a,
    "unwinding the whole stack returns to the base",
  );
  x.__wpk_fork_ref_scratch_release(a, 32);

  // Out-of-order release is silent capture corruption if allowed through.
  const outer = x.__wpk_fork_ref_scratch_reserve(32);
  x.__wpk_fork_ref_scratch_reserve(16);
  assert.throws(
    () => x.__wpk_fork_ref_scratch_release(outer, 32),
    /unreachable/i,
    "releasing a frame that is not the top traps",
  );

  // Exhaustion traps too. The generator does not null-check the reserve result
  // -- it writes straight through the returned address -- so returning 0 would
  // corrupt low guest memory instead of failing.
  assert.throws(
    () => x.__wpk_fork_ref_scratch_reserve(1 << 20),
    /unreachable/i,
    "a reserve larger than the scratch stack traps rather than returning 0",
  );
}

// The KFMS record entries. The chunk list itself is round-tripped against its
// decoder in `cargo test -p fork-codec`; what is checked HERE is the export
// layer's behaviour when there is no fork in flight, which is the state this
// harness runs in and the state a stray guest call would hit.
{
  assert.equal(
    x.__wpk_fork_module_state_record_reserve(
      1 /* kind */, 0 /* activation */, 0 /* owner */, 16,
    ),
    0,
    "reserving with no fork in flight returns 0 rather than writing somewhere",
  );
  assert.equal(lastErrno(), EINVAL, "and reports EINVAL");

  // `find` answers "no such record" rather than failing, so a guest probing an
  // empty list gets a usable answer instead of an error it has no channel for.
  assert.equal(
    x.__wpk_fork_module_state_record_find(1, 0, 0, 0),
    0,
    "finding in an empty list returns 0",
  );

  // Commit has no error channel in the guest ABI -- it returns nothing -- so a
  // failure must latch the errno rather than corrupting silently. With no fork
  // in flight this exercises the no-state branch specifically; the
  // nothing-reserved branch is covered by the writer's own
  // `committing_the_wrong_address_is_refused` round-trip test.
  x.__wpk_fork_module_state_record_commit(0x1000);
  assert.equal(
    lastErrno(),
    EINVAL,
    "committing with no fork in flight latches EINVAL",
  );
}

// Dirty table-page tracking.
//
// `fork-instrument` wraps every table.set / copy / fill / init / grow with a
// mark, gated only on a non-empty range -- there is NO fork-active condition.
// Marks therefore happen throughout ordinary execution, because the set records
// what changed since instantiation so that whenever a fork happens the sparse
// overlay is correct. So these work with no fork in flight, which is also what
// makes them the first entries in this family that can be tested for real
// rather than only at their front door.
{
  const OWNER = 7;
  assert.equal(
    x.__wpk_fork_module_state_table_dirty_count(OWNER),
    0,
    "an untouched table has no dirty pages",
  );

  x.__wpk_fork_module_state_table_dirty_mark(OWNER, 3n, 2n);
  assert.equal(lastErrno(), 0, "marking with no fork in flight is the NORMAL case");
  assert.equal(
    x.__wpk_fork_module_state_table_dirty_count(OWNER),
    2,
    "two pages marked, two pages dirty",
  );
  // Page 100 lands in a LATER bitmap word than 3 and 4. Without it the ordering
  // assertion cannot see a word-iteration bug at all -- every page would live in
  // word 0, where order is decided by bit position alone.
  x.__wpk_fork_module_state_table_dirty_mark(OWNER, 100n, 1n);
  assert.equal(x.__wpk_fork_module_state_table_dirty_page(OWNER, 0), 3n, "pages enumerate ascending");
  assert.equal(x.__wpk_fork_module_state_table_dirty_page(OWNER, 1), 4n, "and in order");
  assert.equal(
    x.__wpk_fork_module_state_table_dirty_page(OWNER, 2),
    100n,
    "ordering holds ACROSS bitmap words, not just within one",
  );

  // Re-marking is normal: the injected marker caches only the LAST page it
  // touched, so a scattered write pattern re-marks pages it has already seen.
  x.__wpk_fork_module_state_table_dirty_mark(OWNER, 3n, 2n);
  assert.equal(
    x.__wpk_fork_module_state_table_dirty_count(OWNER),
    3,
    "re-marking the same pages does not double-count them",
  );

  // A different physical table keeps its own set.
  x.__wpk_fork_module_state_table_dirty_mark(9, 0n, 1n);
  assert.equal(x.__wpk_fork_module_state_table_dirty_count(9), 1, "owners are independent");
  assert.equal(x.__wpk_fork_module_state_table_dirty_count(OWNER), 3, "and do not disturb each other");

  // Page 0 is a legitimate answer, so out-of-range reports through the errno.
  x.__wpk_fork_module_state_table_dirty_page(OWNER, 99);
  assert.equal(lastErrno(), EINVAL, "an ordinal past the count is EINVAL, not a silent 0");

  // Saturation: a mark that cannot be recorded exactly must make every query
  // answer "everything is dirty". Under-approximating the overlay would make a
  // capture WRONG; over-approximating only makes it larger.
  const before = x.__wpk_fork_module_state_table_dirty_count(OWNER);
  x.__wpk_fork_module_state_table_dirty_mark(OWNER, 0n, 1n << 40n);
  assert.ok(
    x.__wpk_fork_module_state_table_dirty_count(OWNER) > before,
    "a mark too large to record saturates instead of being dropped",
  );
}

// ============================================================================
// The GUEST-facing exception define (`env.__wpk_fork_ref_exn_define`).
//
// This is the one `define` in the family that needs nothing but guest linear
// memory. fork-instrument's exception codec stages the whole payload into one
// scratch span before the call -- scalars at their field offsets, and each
// reference payload as the i32 recipe id its own encoder returned, at
// `references_ptr + index * 4` -- so there is no transit table to read and no
// separate transaction to join.
//
// The guest ABI returns NOTHING. So the assertions below are as much about the
// FAILURE path as the success one: a dropped define must not reach a child as a
// silently missing exception payload.
// ============================================================================
{
  const EINVAL = 22;
  const ACT = 7;
  const TYPE_ORDINAL = 4;
  const LAYOUT = 21;
  const SCALARS = SCRATCH_BASE + 256;
  const REFS = SCRATCH_BASE + 320;

  x.fm_capture_begin();
  const payloadA = x.__wpk_fork_ref_gc_i31(11); // 1
  const payloadB = x.__wpk_fork_ref_gc_i31(55); // 2
  const exn = x.__wpk_fork_ref_exn_claim(0); // 3
  assert.deepEqual([payloadA, payloadB, exn], [1, 2, 3], "exception fixture ids");

  writeBytes(SCALARS, [0xde, 0xad, 0xbe, 0xef]);
  writeU32Array(REFS, [payloadA, payloadB]);
  x.__wpk_fork_ref_exn_define(exn, ACT, TYPE_ORDINAL, LAYOUT, SCALARS, 4, REFS, 2);
  assert.equal(lastErrno(), 0, "exn_define latched no error");

  // -- Perturbation: an edge naming a recipe that does not exist -------------
  x.fm_capture_begin();
  const orphan = x.__wpk_fork_ref_exn_claim(0);
  writeU32Array(REFS, [99]);
  x.__wpk_fork_ref_exn_define(orphan, ACT, TYPE_ORDINAL, LAYOUT, SCALARS, 4, REFS, 1);
  assert.equal(lastErrno(), EINVAL, "an edge naming a missing recipe is EINVAL");

  // -- Perturbation: defining a recipe that was never claimed ----------------
  x.fm_capture_begin();
  x.__wpk_fork_ref_exn_define(5, ACT, TYPE_ORDINAL, LAYOUT, SCALARS, 0, REFS, 0);
  assert.equal(lastErrno(), EINVAL, "defining an unclaimed recipe is EINVAL");

  // -- Perturbation: a staging span outside guest memory ---------------------
  x.fm_capture_begin();
  const oob = x.__wpk_fork_ref_exn_claim(0);
  x.__wpk_fork_ref_exn_define(oob, ACT, TYPE_ORDINAL, LAYOUT, 0xfffffff0, 4, REFS, 0);
  assert.equal(lastErrno(), EINVAL, "a scalar span outside guest memory is EINVAL");
  x.fm_capture_begin();
  const oob2 = x.__wpk_fork_ref_exn_claim(0);
  x.__wpk_fork_ref_exn_define(oob2, ACT, TYPE_ORDINAL, LAYOUT, SCALARS, 4, 0xfffffff0, 2);
  assert.equal(lastErrno(), EINVAL, "a reference span outside guest memory is EINVAL");
}

// ============================================================================
// Constructor-provenance WITNESSES (env.__wpk_fork_ref_gc_provenance_*).
//
// A non-defaultable GC shape cannot be `struct.new_default`'d, so replay's
// allocate step must pass a type-correct non-null value for each mutable
// internal-reference field. That seed is then OVERWRITTEN by the snapshot fill,
// so it only has to be a type-correct capturable instance of the field's type --
// not the one the original constructor used. Hence one retained WITNESS per
// (layout, ordinal), which is bounded by the guest's static layouts, rather
// than one record per allocated object, which is not.
//
// The value never crosses into JavaScript: fork-instrument stages the seed in
// the transit table and the injected shim moves it table-to-table.
// ============================================================================
{
  const EINVAL = 22;
  const E2BIG = 7;
  const ACT = 7;
  const transit = x.__wpk_fork_ref_gc_transit;
  const witnesses = x.__wpk_fork_ref_gc_provenance_witness;
  assert.ok(transit instanceof WebAssembly.Table, "transit table is exported");
  assert.ok(witnesses instanceof WebAssembly.Table, "witness table is exported");

  // Count occupied slots by READING the exported table, not by asking Rust for
  // a number. A counter export would be a module entry no production host
  // calls -- the thing `forkModuleEntriesWithoutProductionCaller` exists to
  // discourage -- and reading the table also proves the shim's `table.set`
  // landed rather than trusting a parallel tally.
  const witnessCount = () => {
    let n = 0;
    for (let i = 0; i < witnesses.length; i += 1) {
      if (witnesses.get(i) !== null) n += 1;
    }
    return n;
  };
  const before = witnessCount();

  // One constructor with two provenance fields, exactly as the wrapper emits:
  // begin, then per ordinal stage the seed in transit[0] and call ref, then end.
  const record = (layout, seeds) => {
    const token = x.__wpk_fork_ref_gc_provenance_begin(
      0, ACT, 0, layout, 0n, 0n, seeds.length,
    );
    assert.ok(token >= 0, `provenance_begin errno=${lastErrno()}`);
    seeds.forEach((seed, ordinal) => {
      transit.set(0, seed);
      x.__wpk_fork_ref_gc_provenance_ref(token, ordinal, 0);
      assert.equal(lastErrno(), 0, `provenance_ref(${ordinal}) errno=${lastErrno()}`);
      transit.set(0, null);
    });
    x.__wpk_fork_ref_gc_provenance_end(token);
    assert.equal(lastErrno(), 0, `provenance_end errno=${lastErrno()}`);
    return token;
  };

  record(11, [101, 102]);
  assert.equal(
    witnessCount() - before,
    2,
    "one witness per (layout, ordinal)",
  );

  // The seed actually reached the witness table -- table to table, never
  // through JavaScript and never through a host import.
  const slotA = 0;
  const slotB = 1;
  assert.equal(witnesses.get(slotA), 101, "ordinal 0's seed is retained");
  assert.equal(witnesses.get(slotB), 102, "ordinal 1's seed is retained");

  // The SAME layout again reuses its slots: this is what makes the pool bounded
  // by the guest's static layouts instead of by allocation count.
  record(11, [201, 202]);
  assert.equal(
    witnessCount() - before,
    2,
    "a second construction of the same layout allocates no new witness",
  );
  // The FIRST seed is kept, never replaced. Replay orders allocation by
  // constructor dependency and refuses an "unallocatable constructor cycle".
  // A provenance field is mutable, non-null and internal, so seeding one always
  // needed an instance that already existed -- the original construction order
  // is acyclic. Keeping the first witness preserves it; keeping the latest can
  // close a cycle the original execution never had.
  assert.equal(
    witnesses.get(slotA),
    101,
    "the FIRST seed is kept -- a later one could close a dependency cycle",
  );
  assert.equal(witnesses.get(slotB), 102, "and so is ordinal 1's");

  // A DIFFERENT layout gets its own slots.
  record(12, [301]);
  assert.equal(
    witnessCount() - before,
    3,
    "a distinct layout takes a distinct witness slot",
  );

  // -- Perturbation: a second begin before an end ---------------------------
  const open = x.__wpk_fork_ref_gc_provenance_begin(0, ACT, 0, 13, 0n, 0n, 1);
  assert.ok(open >= 0, "first begin opens");
  assert.equal(
    x.__wpk_fork_ref_gc_provenance_begin(0, ACT, 0, 14, 0n, 0n, 1),
    -1,
    "a second begin before end is refused",
  );
  assert.equal(lastErrno(), EINVAL, "and it is EINVAL");

  // -- Perturbation: an ordinal past the declared count ----------------------
  transit.set(0, 999);
  x.__wpk_fork_ref_gc_provenance_ref(open, 5, 0);
  assert.equal(lastErrno(), EINVAL, "an ordinal past the declared count is EINVAL");
  transit.set(0, null);

  // -- Perturbation: end with fewer stores than declared ---------------------
  //
  // This is the guard that makes the void return safe. A dropped store would
  // leave a later object of this layout with NO type-correct seed at all.
  x.__wpk_fork_ref_gc_provenance_end(open);
  assert.equal(
    lastErrno(),
    EINVAL,
    "ending with fewer witnesses than declared is EINVAL",
  );

  // -- Perturbation: end with a token that was never opened ------------------
  x.__wpk_fork_ref_gc_provenance_end(99);
  assert.equal(lastErrno(), EINVAL, "ending an unopened token is EINVAL");

  // -- A layout id too large for the (layout << 8 | ordinal) witness key ------
  assert.equal(
    x.__wpk_fork_ref_gc_provenance_begin(0, ACT, 0, 0x0100_0000, 0n, 0n, 1),
    -1,
    "a layout id that would overflow the witness key is refused",
  );
  assert.equal(lastErrno(), E2BIG, "and it is E2BIG, not a silent truncation");
}

// ============================================================================
// The GUEST-facing exception cycle: lookup -> claim -> define.
//
// `exn_lookup` always reports NOT FOUND, so every catch takes a fresh recipe.
// Nothing can dedup an exception: wasm cannot compare two exnrefs (`ref.eq`
// does not validate on them, and no cast rescues one into the eq hierarchy),
// and an exnref value cannot cross into a JS import to be compared there.
//
// The same limitation is why it costs nothing: a guest cannot observe that two
// exnrefs are distinct either. What MUST still hold is that the payloads dedup,
// so two exception recipes share their payload objects rather than duplicating
// them -- that is what these assertions pin.
// ============================================================================
{
  const ACT = 7;
  const SCALARS = SCRATCH_BASE + 512;
  const REFS = SCRATCH_BASE + 576;

  x.fm_capture_begin();
  const payload = x.__wpk_fork_ref_gc_i31(77); // 1
  assert.equal(payload, 1, "payload leaf interned");

  // Lookup never hits, so the guest always proceeds to claim.
  assert.equal(x.__wpk_fork_ref_exn_lookup(0), 0, "lookup reports not found");
  assert.equal(lastErrno(), 0, "and that is not an error");

  const first = x.__wpk_fork_ref_exn_claim(0);
  assert.ok(first >= 1, `exn_claim errno=${lastErrno()}`);
  // Still not found AFTER a claim: there is nothing to bind identity to.
  assert.equal(
    x.__wpk_fork_ref_exn_lookup(0),
    0,
    "lookup still reports not found after a claim",
  );
  const second = x.__wpk_fork_ref_exn_claim(0);
  assert.notEqual(first, second, "each catch takes a DISTINCT recipe");

  // Both exceptions describe the SAME payload recipe. This is the property that
  // makes duplicate exnref recipes harmless: the payload graph is shared, so a
  // child rebuilds one payload object, not two.
  writeBytes(SCALARS, [0x11, 0x22, 0x33, 0x44]);
  writeU32Array(REFS, [payload]);
  x.__wpk_fork_ref_exn_define(first, ACT, 4, 21, SCALARS, 4, REFS, 1);
  assert.equal(lastErrno(), 0, `exn_define(first) errno=${lastErrno()}`);
  x.__wpk_fork_ref_exn_define(second, ACT, 4, 21, SCALARS, 4, REFS, 1);
  assert.equal(lastErrno(), 0, `exn_define(second) errno=${lastErrno()}`);
}

// ============================================================================
// The unknown-tag path (env.__wpk_fork_ref_exn_broker_encode).
//
// A foreign exception is opaque on every axis: its payload needs `catch_ref`
// against a tag this module does not have, it cannot be identified, and it
// cannot be handed to a host to inspect. So the module REFUSES, and the refusal
// has to be structural rather than a sentinel the child would rebuild silently.
// ============================================================================
{
  const EOPNOTSUPP = 95;
  const ACT = 7;
  const SCALARS = SCRATCH_BASE + 640;
  const REFS = SCRATCH_BASE + 704;

  x.fm_capture_begin();
  const poisoned = x.__wpk_fork_ref_exn_broker_encode(0);
  assert.equal(poisoned, -1, "an unknown tag is refused");
  assert.equal(lastErrno(), EOPNOTSUPP, "and the reason is EOPNOTSUPP, not a guess");

  // The refusal must be STRUCTURAL: the returned value is not a usable recipe,
  // so a graph that tried to reference it cannot seal. A sentinel that happened
  // to be a valid recipe id would let the child rebuild something wrong and say
  // nothing.
  const holder = x.__wpk_fork_ref_exn_claim(0);
  assert.ok(holder >= 1, "claimed a holder recipe");
  writeBytes(SCALARS, [0xbe, 0xef, 0xbe, 0xef]);
  writeU32Array(REFS, [poisoned >>> 0]);
  x.__wpk_fork_ref_exn_define(holder, ACT, 4, 21, SCALARS, 4, REFS, 1);
  assert.notEqual(
    lastErrno(),
    0,
    "an edge naming the refused recipe is rejected at define",
  );
}

// ============================================================================
// F3 step 2: the module drives the GUEST to encode, through the drive table.
//
// Every other drive-table slot is replay — the module driving the guest to
// rebuild a graph. Slot 11 is the first CAPTURE use: the module stages a
// constructor-provenance witness in the anyref transit slot and calls the
// guest's own codec to encode it, getting back a recipe for a reference Rust
// can neither hold nor describe.
//
// The guest codec is stubbed here by a real wasm function (the JS API refuses a
// plain JS function in an `anyfunc` table), which also counts its calls — that
// is how the witness CACHE is proven, not assumed.
// ============================================================================
{
  const ACT = 0; // drive base = ACT * 13 = 0
  const DRIVE_SLOT_GC_ENCODE = 11;
  const DRIVE_SLOT_GC_PROBE = 12;

  // `(func (export "encode") (param i32) (result i32))` that bumps an exported
  // global and returns recipe 1. Assembled with wasm-tools; bytes inlined so the
  // harness needs no build step.
  const stubBytes = new Uint8Array([
    0,97,115,109,1,0,0,0,1,6,1,96,1,127,1,127,3,2,1,0,6,6,1,127,1,65,0,11,7,18,
    2,5,99,97,108,108,115,3,0,6,101,110,99,111,100,101,0,0,10,13,1,11,0,35,0,65,
    1,106,36,0,65,1,11,0,15,4,110,97,109,101,7,8,1,0,5,99,97,108,108,115,
  ]);
  const stub = new WebAssembly.Instance(new WebAssembly.Module(stubBytes), {});
  const encodeCalls = () => stub.exports.calls.value;

  const transitTable = x.__wpk_fork_ref_gc_transit;
  const driveTable = importObject.env.__wpk_fork_drive_table;
  driveTable.grow(ACT * 13 + DRIVE_SLOT_GC_PROBE + 1 - driveTable.length);
  driveTable.set(ACT * 13 + DRIVE_SLOT_GC_ENCODE, stub.exports.encode);

  x.fm_capture_begin();
  // Recipe 1: what the stub codec will claim every witness encodes to, so the
  // provenance edge names a node that exists.
  assert.equal(x.__wpk_fork_ref_gc_i31(5), 1, "witness stand-in is recipe 1");

  // Record a witness for layout 21, ordinal 0, exactly as a constructor wrapper
  // would: begin, stage the seed in transit, ref, end.
  const LAYOUT = 21;
  const token = x.__wpk_fork_ref_gc_provenance_begin(0, ACT, 0, LAYOUT, 0n, 0n, 1);
  assert.ok(token >= 0, `provenance_begin errno=${lastErrno()}`);
  transitTable.set(0, 123);
  x.__wpk_fork_ref_gc_provenance_ref(token, 0, 0);
  assert.equal(lastErrno(), 0, "witness stored");
  transitTable.set(0, null);
  x.__wpk_fork_ref_gc_provenance_end(token);
  assert.equal(lastErrno(), 0, "provenance transaction closed");

  const before = encodeCalls();
  const node = x.__wpk_fork_ref_exn_claim(0);
  const fields = buildVector([1]);
  writeBytes(SCRATCH_BASE + 768, [0xaa, 0xbb, 0xcc, 0xdd]);
  x.__wpk_fork_ref_gc_define(
    node, ACT, 2, LAYOUT, KIND_STRUCT, SCRATCH_BASE + 768, 4, fields,
  );
  assert.equal(lastErrno(), 0, `gc_define errno=${lastErrno()}`);
  assert.equal(
    encodeCalls() - before,
    1,
    "the module drove the guest codec exactly once to intern the witness",
  );

  // The witness is CACHED: a second object of the same layout reuses the recipe
  // rather than re-encoding. Proven by clearing the drive slot first -- a
  // re-encode would now call a null table entry and trap.
  driveTable.set(ACT * 13 + DRIVE_SLOT_GC_ENCODE, null);
  const second = x.__wpk_fork_ref_exn_claim(0);
  const fields2 = buildVector([1]);
  x.__wpk_fork_ref_gc_define(
    second, ACT, 2, LAYOUT, KIND_STRUCT, SCRATCH_BASE + 768, 4, fields2,
  );
  assert.equal(lastErrno(), 0, "a second object of the layout reuses the witness recipe");
  assert.equal(encodeCalls() - before, 1, "and does NOT drive the codec again");

  // -- capture_layout drives the guest's TYPE-TEST probe ---------------------
  //
  // A layout is a per-OBJECT fact, so the witness trick cannot make it bounded.
  // Asking the guest to type-test the value it already staged costs nothing and
  // stores nothing — the module keeps no map at all.
  // `(func (export "probe") (param i32) (result i64))` returning
  // (type_ordinal 2 << 32) | layout 21, and counting its calls.
  // Bytes from wasm-tools, not written by hand: an earlier hand-encoding of
  // this same module had the code-section length wrong (20 where the encoding
  // requires 17), which is why every stub in this file is assembled rather than
  // typed.
  const probeBytes = new Uint8Array([
    0,97,115,109,1,0,0,0,1,6,1,96,1,127,1,126,3,2,1,0,6,6,1,127,1,65,0,11,7,17,
    2,5,99,97,108,108,115,3,0,5,112,114,111,98,101,0,0,10,17,1,15,0,35,0,65,1,
    106,36,0,66,149,128,128,128,32,11,0,15,4,110,97,109,101,7,8,1,0,5,99,97,108,
    108,115,
  ]);
  const probeStub = new WebAssembly.Instance(new WebAssembly.Module(probeBytes), {});
  driveTable.set(ACT * 13 + DRIVE_SLOT_GC_PROBE, probeStub.exports.probe);

  transitTable.set(0, 456);
  const selected = x.__wpk_fork_ref_gc_capture_layout(0, ACT, 999);
  assert.equal(lastErrno(), 0, "capture_layout succeeded");
  assert.equal(
    selected,
    21,
    "the layout comes from the guest's type test, not the caller's guess of 999",
  );
  assert.equal(probeStub.exports.calls.value, 1, "the probe ran exactly once");
  transitTable.set(0, null);

  // A layout that recorded no witness needs no encode at all, which is the
  // ordinary case: most layouts have no mutable non-null internal field.
  const plain = x.__wpk_fork_ref_exn_claim(0);
  const fields3 = buildVector([1]);
  x.__wpk_fork_ref_gc_define(
    plain, ACT, 2, 99, KIND_STRUCT, SCRATCH_BASE + 768, 4, fields3,
  );
  assert.equal(lastErrno(), 0, "a layout with no provenance defines without a drive");
  assert.equal(encodeCalls() - before, 1, "and still does not call the codec");
}

// ============================================================================
// The cross-activation broker (env.__wpk_fork_ref_gc_broker_encode).
//
// A structurally canonical GC value can enter through another dynamically
// loaded module, whose codec is the one that can encode it. The module cannot
// inspect a reference, so it ASKS each registered activation's codec in turn
// and routes to the first that claims the value — both steps being the guest's
// own generated functions, reached through the drive table.
// ============================================================================
{
  const EOPNOTSUPP = 95;
  const transitTable = x.__wpk_fork_ref_gc_transit;
  const driveTable = importObject.env.__wpk_fork_drive_table;
  const SLOTS = 13;
  const ENC = 11;
  const PRB = 12;

  // Stubs standing in for two guests' generated codecs. Assembled by
  // wasm-tools and PARAMETERISED through a mutable global rather than baked per
  // value: encoding a different i64 by hand means re-encoding a LEB128 length,
  // which is how the earlier stub in this file got a wrong code-section size.
  const probeStubBytes = new Uint8Array([
    0,97,115,109,1,0,0,0,1,6,1,96,1,127,1,126,3,2,1,0,6,11,2,126,1,66,0,11,127,
    1,65,0,11,7,23,3,3,114,101,116,3,0,5,99,97,108,108,115,3,1,5,112,114,111,98,
    101,0,0,10,13,1,11,0,35,1,65,1,106,36,1,35,0,11,0,20,4,110,97,109,101,7,13,
    2,0,3,114,101,116,1,5,99,97,108,108,115,
  ]);
  const encodeStubBytes = new Uint8Array([
    0,97,115,109,1,0,0,0,1,6,1,96,1,127,1,127,3,2,1,0,6,11,2,127,1,65,0,11,127,
    1,65,0,11,7,24,3,3,114,101,116,3,0,5,99,97,108,108,115,3,1,6,101,110,99,111,
    100,101,0,0,10,13,1,11,0,35,1,65,1,106,36,1,35,0,11,0,20,4,110,97,109,101,7,
    13,2,0,3,114,101,116,1,5,99,97,108,108,115,
  ]);
  const makeProbe = (answer) => {
    const i = new WebAssembly.Instance(new WebAssembly.Module(probeStubBytes), {});
    i.exports.ret.value = answer;
    return i;
  };
  const makeEncode = (recipe) => {
    const i = new WebAssembly.Instance(new WebAssembly.Module(encodeStubBytes), {});
    i.exports.ret.value = recipe;
    return i;
  };
  // The broker walks the activations admitted with a GC codec, so each is
  // admitted with one. The committed fixture is a real codec section, shared
  // here by both activations.
  const codecBytes = readFileSync(
    new URL("../../fork-codec/testdata/gc-codec-wasm32.bin", import.meta.url),
  );
  const seedCodec = (act) => {
    assert.equal(admit(act, [[4, codecBytes]]), 0, `admitting activation ${act}'s codec`);
  };

  // Two activations: 3 does NOT recognise the value, 4 does. Registering 3
  // first is deliberate — routing to the first CLAIMANT, not the first
  // registered, is the property under test.
  const deny = makeProbe(0n);
  const claim = makeProbe((1n << 32n) | 21n);
  const enc4 = makeEncode(1);

  const need = 4 * SLOTS + PRB + 1;
  if (driveTable.length < need) driveTable.grow(need - driveTable.length);
  driveTable.set(3 * SLOTS + PRB, deny.exports.probe);
  driveTable.set(4 * SLOTS + PRB, claim.exports.probe);
  driveTable.set(4 * SLOTS + ENC, enc4.exports.encode);

  x.fm_capture_begin();
  assert.equal(x.__wpk_fork_ref_gc_i31(9), 1, "routed value's recipe");

  // Admit two activation codecs so the broker has a registry to walk. The bytes
  // are the committed gc-codec fixture, which both activations can share.
  seedCodec(3);
  seedCodec(4);

  transitTable.set(0, 314);
  const routed = x.__wpk_fork_ref_gc_broker_encode(0);
  assert.equal(lastErrno(), 0, `broker_encode errno=${lastErrno()}`);
  assert.equal(routed, 1, "routed to the activation whose codec claimed the value");
  assert.equal(deny.exports.calls.value, 1, "the non-claimant was asked");
  assert.equal(claim.exports.calls.value, 1, "and the claimant was asked");
  assert.equal(enc4.exports.calls.value, 1, "only the CLAIMANT encoded");

  // Nobody claims it -> a truthful refusal, not an invented recipe.
  driveTable.set(4 * SLOTS + PRB, deny.exports.probe);
  const refused = x.__wpk_fork_ref_gc_broker_encode(0);
  assert.equal(refused, -1, "an unclaimed value is refused");
  assert.equal(lastErrno(), EOPNOTSUPP, "and the reason is EOPNOTSUPP");
  transitTable.set(0, null);
}

// ---- A stand-in guest's table shims ---------------------------------------
//
// The module reaches a guest table only through the guest's own
// `wpk_fork_module_table_{read,length,apply}` exports, bound into the
// activation's drive-table slice. This stub forwards each to JavaScript so the
// harness can see exactly what the module asked a guest to do. Hand-assembled:
// (import "h" "read" (i32 i32) -> i32), "length" (i32) -> i32, "apply"
// (i32 i32 i32 i32), each re-exported through a wasm function, because a drive
// table holds only wasm functions.
const TABLE_SHIM_STUB = new Uint8Array([
  0,97,115,109,1,0,0,0,1,19,3,96,2,127,127,1,127,96,1,127,1,127,96,4,127,127,
  127,127,0,2,31,3,1,104,4,114,101,97,100,0,0,1,104,6,108,101,110,103,116,104,0,
  1,1,104,5,97,112,112,108,121,0,2,3,4,3,0,1,2,7,25,3,4,114,101,97,100,0,3,6,
  108,101,110,103,116,104,0,4,5,97,112,112,108,121,0,5,10,30,3,8,0,32,0,32,1,16,
  0,11,6,0,32,0,16,1,11,12,0,32,0,32,1,32,2,32,3,16,2,11,
]);
// Must match `fork_codec::drive_plan`.
const DRIVE_SLOTS_PER_ACTIVATION = 19;
const DRIVE_SLOT_TABLE_READ = 16;
const DRIVE_SLOT_TABLE_LENGTH = 17;
const DRIVE_SLOT_TABLE_APPLY = 18;
const bindTableShims = (activation, host) => {
  const stub = new WebAssembly.Instance(new WebAssembly.Module(TABLE_SHIM_STUB), {
    h: host,
  });
  const driveTable = importObject.env.__wpk_fork_drive_table;
  const base = activation * DRIVE_SLOTS_PER_ACTIVATION;
  const need = base + DRIVE_SLOTS_PER_ACTIVATION;
  if (driveTable.length < need) driveTable.grow(need - driveTable.length);
  driveTable.set(base + DRIVE_SLOT_TABLE_READ, stub.exports.read);
  driveTable.set(base + DRIVE_SLOT_TABLE_LENGTH, stub.exports.length);
  driveTable.set(base + DRIVE_SLOT_TABLE_APPLY, stub.exports.apply);
};

// ---- Table reconcile against the REAL published dylink archive -------------
//
// The fixture is the same byte image `fork_codec::dylink_table_plan`'s
// `plans_against_the_real_published_archive` uses: a memory dump whose KFLA
// header sits at offset 4096. It carries ONE patch, for the table owner 3 of
// activation 7: slots 5..7 cleared, slots 7..10 set to activation 8's function
// ordinal 4. Here it proves the module-side path -- decode, plan, catalog
// resolution, and the call to the OWNING activation's apply shim with records
// it can read in place -- which no Rust unit test can reach.
//
// This harness has no kernel, so it cannot seed per-activation catalog bases
// (each is an arena record, and the arena is mapped through the syscall
// channel). With no base seeded the module is a single-activation worker: only
// activation 0 is present, and every catalog base is 0. So the patch is first
// applied as published -- and refused, activation 7 not being here -- and then
// with its table re-pointed at activation 0.
{
  const FIXTURE_HEAD = 4096;
  const fixture = readFileSync(
    new URL("../../fork-codec/testdata/dylink-archive-wasm32.bin", import.meta.url),
  );
  assert.ok(fixture.length > FIXTURE_HEAD, "fixture must contain its own header");
  u8().set(fixture, 0);

  // The patch record: activation 7, owner 3, start 5, length 12, at +32..+56.
  let patchAt = -1;
  for (let at = FIXTURE_HEAD; at + 56 <= fixture.length; at += 4) {
    const view = dv();
    if (view.getUint32(at + 32, true) === 7 && view.getUint32(at + 36, true) === 3
      && view.getBigUint64(at + 40, true) === 5n && view.getBigUint64(at + 48, true) === 12n) {
      patchAt = at;
      break;
    }
  }
  assert.ok(patchAt > 0, "the fixture's one table patch is found");
  const applied = [];
  bindTableShims(0, {
    read: () => -1,
    length: () => 12,
    apply: (owner, length, records, count) => {
      const view = dv();
      const writes = [];
      for (let i = 0; i < count; i += 1) {
        const at = records + i * 12;
        writes.push([
          view.getUint32(at, true),
          view.getUint32(at + 4, true),
          view.getUint32(at + 8, true),
        ]);
      }
      applied.push({ owner, length, writes });
    },
  });

  // The archive coordinates arrive with the once-per-worker format seed, which
  // also RESETS them -- what a COW child depends on. A control address of 0 is
  // a worker with no dlopen archive at all.
  x.fm_set_format(4, 0, 0, 0);
  assert.equal(lastErrno(), 0, "wasm32 with no archive is a valid seed");

  // An unpublished worker is coherent by definition: generation 0, no error.
  assert.equal(
    Number(x.__wpk_fork_module_state_table_reconcile()),
    0,
    "no published archive reconciles to generation 0",
  );
  assert.equal(lastErrno(), 0, "and reports no error");
  assert.equal(applied.length, 0, "an unpublished reconcile asks no guest to write");

  // The real archive. The module reads the head out of the control block at a
  // fixed negative offset, so the harness writes the head there and passes the
  // control address -- exactly what a host does.
  const CONTROL = 64 * 1024;
  const DLOPEN_HEAD_OFFSET_WASM32 = 12;
  const seedControl = (head) => {
    dv().setUint32(CONTROL - DLOPEN_HEAD_OFFSET_WASM32, head, true);
    x.fm_set_format(4, 0, CONTROL, 0);
    assert.equal(lastErrno(), 0, "seeding the control address succeeds");
  };

  // As published: activation 7's table. Activation 7 is not in this worker, so
  // the patch is refused BEFORE any guest is asked to write -- its drive slots
  // are empty, and a partial apply would leave tables between generations.
  seedControl(FIXTURE_HEAD);
  assert.equal(
    Number(x.__wpk_fork_module_state_table_reconcile()),
    -1,
    "a patch for an absent activation is refused",
  );
  assert.deepEqual(
    materializeRequests,
    [3n],
    "after asking the host to instantiate it, for the archive's generation",
  );
  assert.equal(lastErrno(), 38 /* ENOSYS */, "and the host's answer is reported");
  assert.equal(applied.length, 0, "a refused reconcile writes nothing");

  // Re-pointed at activation 0, which is here.
  dv().setUint32(patchAt + 32, 0, true);
  seedControl(FIXTURE_HEAD);
  const reached = Number(x.__wpk_fork_module_state_table_reconcile());
  assert.equal(lastErrno(), 0, `reconcile errno=${lastErrno()}`);
  assert.equal(reached, 3, "a published archive reaches its generation");
  assert.deepEqual(
    applied,
    [{
      owner: 3,
      length: 12,
      writes: [[5, 0, 1], [6, 0, 1], [7, 4, 0], [8, 4, 0], [9, 4, 0]],
    }],
    "the table's activation is asked to write exactly the patch into owner 3",
  );

  // Idempotent: replaying from the generation just reached asks for NOTHING.
  applied.length = 0;
  assert.equal(
    Number(x.__wpk_fork_module_state_table_reconcile()),
    reached,
    "a second reconcile reaches the same generation",
  );
  assert.equal(applied.length, 0, "and writes nothing, because nothing moved");

  // The generation a reconcile REPORTS is the snapshot's. The guest caches it
  // and compares it against the fence on the next table access -- report below
  // the fence and the guard re-enters on every access, forever.
  const HEADER_GENERATION_OFFSET = 40;
  dv().setBigUint64(FIXTURE_HEAD + HEADER_GENERATION_OFFSET, 99n, true);
  seedControl(FIXTURE_HEAD);
  const fenced = Number(x.__wpk_fork_module_state_table_reconcile());
  assert.equal(lastErrno(), 0, `fenced reconcile errno=${lastErrno()}`);
  assert.equal(fenced, 99, "the reconcile reports the snapshot generation");
  dv().setBigUint64(FIXTURE_HEAD + HEADER_GENERATION_OFFSET, BigInt(reached), true);

  applied.length = 0;
  // A head that names no header is a malformed archive, not an empty one.
  seedControl(FIXTURE_HEAD + 8);
  assert.equal(
    Number(x.__wpk_fork_module_state_table_reconcile()),
    -1,
    "a head pointing into the middle of the header is refused",
  );
  assert.equal(lastErrno(), EINVAL, "and the reason is EINVAL");
  assert.equal(applied.length, 0, "a refused reconcile writes no slots");

  // A head past the end of memory is refused by the bounds check rather than
  // read out of the guest's memory.
  seedControl(memory.buffer.byteLength - 4);
  assert.equal(
    Number(x.__wpk_fork_module_state_table_reconcile()),
    -1,
    "a head whose header would run past memory is refused",
  );
  assert.equal(lastErrno(), EINVAL, "and the reason is EINVAL");
}

// ---- The dylink archive writer lock ----------------------------------------
//
// The lock word is ONE protocol shared by every participant in the process --
// the TypeScript host holds the same word with `Atomics.compareExchange`. So
// these assertions check the module against the HOST's encoding (0 idle,
// -1 writer, positive = reader count), not against an encoding of its own.
{
  const EPERM = 1;
  const LOCK_OFFSET_WASM32 = 20;
  const CONTROL = 64 * 1024;
  const lockAddr = CONTROL - LOCK_OFFSET_WASM32;
  assert.equal(lockAddr % 4, 0, "the lock word must be 4-byte aligned");
  const lock = new Int32Array(memory.buffer, lockAddr, 1);

  // No archive at all: there is no lock word to take, and that is an error
  // rather than a silently ungoverned mutation.
  x.fm_set_format(4, 0, 0, 0);
  assert.equal(Number(x.__wpk_fork_module_state_table_mutation_begin()), -1);
  assert.equal(lastErrno(), EINVAL, "a worker with no archive cannot begin");

  // A real archive, unheld.
  dv().setUint32(CONTROL - 12, 4096, true); // the published head
  Atomics.store(lock, 0, 0);
  x.fm_set_format(4, 0, CONTROL, 0);
  const at = Number(x.__wpk_fork_module_state_table_mutation_begin());
  assert.equal(lastErrno(), 0, `begin errno=${lastErrno()}`);
  assert.ok(at > 0, `begin reports the generation it reached (${at})`);
  assert.equal(
    Atomics.load(lock, 0),
    -1,
    "begin leaves the WRITER value the host also writes",
  );

  x.__wpk_fork_module_state_table_mutation_abort();
  assert.equal(lastErrno(), 0, "abort releases cleanly");
  assert.equal(Atomics.load(lock, 0), 0, "and leaves the word idle");

  // Releasing a writer this worker does not hold is refused, not forced. Two
  // owners is worse than an error.
  x.__wpk_fork_module_state_table_mutation_abort();
  assert.equal(lastErrno(), EPERM, "abort without the writer is EPERM");
  assert.equal(Atomics.load(lock, 0), 0, "and changes nothing");

  // A failed begin holds nothing. Reconcile fails on a malformed head, and if
  // begin kept the writer through that, every other worker would wedge.
  dv().setUint32(CONTROL - 12, 4096 + 8, true);
  x.fm_set_format(4, 0, CONTROL, 0);
  assert.equal(Number(x.__wpk_fork_module_state_table_mutation_begin()), -1);
  assert.equal(lastErrno(), EINVAL, "a begin whose reconcile fails reports it");
  assert.equal(Atomics.load(lock, 0), 0, "and releases the writer it took");
  dv().setUint32(CONTROL - 12, 4096, true);
}

// The module's NOTIFY actually wakes a blocked peer.
//
// Everything above checks the lock word's VALUES, which a release that forgot
// to notify would satisfy perfectly while leaving every waiter asleep forever.
// That needs a second thread to see, so this uses one: the worker blocks in
// `Atomics.wait` on the same shared word, and the module's abort has to be what
// wakes it.
//
// Only this direction is tested. Exercising the module's own blocking WAIT
// would mean parking the main thread inside a wasm call, where no timer can
// run -- a test that hangs forever instead of failing if the wake never
// arrives. That path is covered by inspection and by the perturbations
// recorded in docs/plans/2026-09-12-lane-f-census.md, not by this harness.
{
  const LOCK_OFFSET_WASM32 = 20;
  const CONTROL = 64 * 1024;
  const lock = new Int32Array(memory.buffer, CONTROL - LOCK_OFFSET_WASM32, 1);

  dv().setUint32(CONTROL - 12, 4096, true);
  Atomics.store(lock, 0, 0);
  x.fm_set_format(4, 0, CONTROL, 0);
  assert.ok(
    Number(x.__wpk_fork_module_state_table_mutation_begin()) > 0,
    "the writer is held before the peer waits on it",
  );

  const woken = await new Promise((resolve, reject) => {
    const worker = new Worker(
      `const { parentPort, workerData } = require("node:worker_threads");
       const lock = new Int32Array(workerData.buffer, workerData.byteOffset, 1);
       // -1 is the WRITER value the module just stored. Waiting on it blocks
       // until someone stores something else AND notifies.
       parentPort.postMessage(Atomics.wait(lock, 0, -1, 5000));`,
      {
        eval: true,
        workerData: {
          buffer: memory.buffer,
          byteOffset: CONTROL - LOCK_OFFSET_WASM32,
        },
      },
    );
    worker.once("message", (result) => {
      worker.terminate();
      resolve(result);
    });
    worker.once("error", reject);
    // The worker has to be parked in `Atomics.wait` BEFORE the release, or it
    // would return "not-equal" and prove nothing about the notify. There is no
    // event for "a thread is now blocked", so this gives it a moment.
    setTimeout(() => {
      x.__wpk_fork_module_state_table_mutation_abort();
      assert.equal(lastErrno(), 0, "the release itself succeeded");
    }, 200);
  });
  assert.equal(
    woken,
    "ok",
    "the peer was WOKEN by the module's notify, not left to time out",
  );
  assert.equal(Atomics.load(lock, 0), 0, "and the lock is idle afterwards");
}

// ---- Per-activation frame trampolines --------------------------------------
//
// The guest's five frame imports are frozen at one argument; the module's
// exports take (activation_id, arg). These pre-emitted entry points fold the id
// in, replacing 286 lines of TypeScript that SYNTHESIZED a wasm module per
// activation at runtime.
//
// Only their SHAPE is checked here. Calling one reaches `fm_frame_reserve`,
// which allocates its arena with `SYS_MMAP` through the syscall channel, and
// this harness has no kernel to service that -- so a behavioural test would
// assert errno 22 and prove nothing. That each entry folds the activation it is
// indexed by is checked exhaustively, over all 320 of them, by
// `every_trampoline_folds_the_activation_it_is_indexed_by` in
// `crates/fork-module-inject`, where walrus can read the emitted bodies.
{
  const SLOTS = 5;
  const trampolines = x.__wpk_fork_activation_trampolines;
  assert.ok(trampolines instanceof WebAssembly.Table, "the table is exported");
  assert.equal(trampolines.length, 64 * SLOTS, "one entry per activation slot");
  for (const index of [0, 3 * SLOTS, 63 * SLOTS + 4]) {
    assert.equal(
      typeof trampolines.get(index),
      "function",
      `slot ${index} holds a callable entry point`,
    );
  }
}

// The GC and exception codec sections are validated when they ARRIVE, in
// `fm_admit_activation`: `fork_codec::activation_admission`'s own tests refuse
// a malformed section of each kind, and `host/test/fork-module-admission.test.ts`
// drives the module's refusal and its same-facts rule over a real guest. The
// per-section seeds this harness used to check that through were deleted in
// lane F stage 1d.

// ---- Encoding a funcref back to a recipe -----------------------------------
//
// The inverse of `__wpk_fork_ref_decode_funcref`: that turns a recipe into a
// function by indexing the merged catalog; this finds WHICH slot holds a given
// function. Finding it needs function comparison, which wasm cannot do, so the
// host supplies identity and the module owns the scan.
{
  const catalog = importObject.env.__wpk_fork_function_catalog;
  // NOT `fm_last_errno`: the reconcile block above filled every slot of this
  // shared catalog with it, so a scan would find it at a slot no base covers --
  // which is the refusal working, not a match.
  const alpha = x.fm_stats;
  const beta = x.fm_journal_image_len;
  const uncatalogued = x.fm_funcref_uncatalogued;

  x.fm_set_format(4, 0, 0, 0);
  assert.equal(lastErrno(), 0, "format seeded");
  x.fm_capture_begin();
  assert.equal(lastErrno(), 0, "a capture session is open");

  const base = catalog.length;
  catalog.grow(2, null);
  catalog.set(base + 0, alpha);
  catalog.set(base + 1, beta);
  // Placed the way registration places them: admit, then bind with the
  // catalog lengths. The row's second word is the function-catalog base.
  const place = (activation, length) => {
    assert.equal(admit(activation), 0, `admitting activation ${activation}`);
    const row = x.fm_bind_activation(activation, length, 0);
    assert.notEqual(row, 0, `binding activation ${activation} errno=${lastErrno()}`);
    return dv().getUint32(row + 4, true);
  };
  assert.equal(place(4, base), 0, "activation 4 holds the slots already filled");
  assert.equal(place(5, 2), base, "activation 5's catalog is placed after them");
  assert.equal(lastErrno(), 0, "activation 5's catalog is placed");

  // A null funcref is recipe 0 -- the graph's "no reference", not a failure, and
  // asking the host to identify null would make it invent an answer.
  assert.equal(x.__wpk_fork_ref_encode_funcref(null), 0, "null encodes to 0");
  assert.equal(lastErrno(), 0, "and is not an error");

  const a = x.__wpk_fork_ref_encode_funcref(alpha);
  assert.equal(lastErrno(), 0, `encoding a catalogued funcref errno=${lastErrno()}`);
  assert.ok(a > 0, `a catalogued funcref gets a recipe (${a})`);

  const b = x.__wpk_fork_ref_encode_funcref(beta);
  assert.equal(lastErrno(), 0, "the second catalogued funcref encodes");
  assert.notEqual(b, a, "DIFFERENT functions get different recipes");

  assert.equal(
    x.__wpk_fork_ref_encode_funcref(alpha),
    a,
    "the same function encodes to the same recipe",
  );

  // The scan located the RIGHT slot, which is what the host oracle buys:
  // encoding the function agrees with asking the module for that slot's recipe
  // directly, through the very entry the injected scan calls once it has an
  // answer.
  assert.equal(
    a,
    x.fm_funcref_slot_to_recipe(base + 0),
    "encoding a function agrees with asking for its slot directly",
  );

  // A slot NO placed range holds is refused rather than attributed to
  // activation 0, which would record a recipe naming another activation's
  // function.
  assert.equal(x.fm_funcref_slot_to_recipe(base + 2), -1, "a slot past every range is refused");
  assert.equal(lastErrno(), EINVAL, "and the reason is EINVAL");

  // A function the loader never catalogued is REFUSED. Inventing a coordinate
  // would put a recipe in the graph that decodes to the wrong function.
  assert.equal(
    x.__wpk_fork_ref_encode_funcref(uncatalogued),
    -1,
    "an uncatalogued funcref is refused",
  );
  assert.equal(lastErrno(), EINVAL, "and the reason is EINVAL");

  // NOT asserted, and named rather than left implied: that the interned ORDINAL
  // is slot-minus-base. The coordinate lives in the serialized record PAYLOAD and
  // this harness decodes only record headers, so a perturbation interning the raw
  // slot passes everything above. Census section 73.
}

// ---- Publishing a guest table mutation -------------------------------------
//
// `commit` reads each changed slot, resolves the function there to a catalog
// coordinate, coalesces runs, allocates a record, appends it and publishes the
// generation -- then releases the writer `begin` took.
//
// The SUCCESS path is not reachable here: allocating the record issues SYS_MMAP
// through the guest's syscall channel, and this harness has no kernel to service
// it, so a publishing commit would block rather than fail. What IS reachable is
// everything the module decides BEFORE that syscall, which is where its own
// logic lives -- and the lock discipline, which matters most when things fail.
{
  const LOCK_OFFSET_WASM32 = 20;
  const CONTROL = 64 * 1024;
  const lock = new Int32Array(memory.buffer, CONTROL - LOCK_OFFSET_WASM32, 1);
  // Activation 0's guest: every slot the module reads holds an UNCATALOGUED
  // function (-2), and its table is 128 long.
  bindTableShims(0, { read: () => -2, length: () => 128, apply: () => {} });

  dv().setUint32(CONTROL - 12, 4096, true);
  Atomics.store(lock, 0, 0);
  x.fm_set_format(4, 0, CONTROL, 0);
  assert.equal(lastErrno(), 0, "format seeded with the control block");

  // A zero-length mutation publishes nothing and is not an error: a zero-length
  // `table.fill` is legal, and burning a generation for it would make every peer
  // reconcile against a patch describing no change.
  assert.ok(
    Number(x.__wpk_fork_module_state_table_mutation_begin()) >= 0,
    "the writer is taken",
  );
  assert.equal(Atomics.load(lock, 0), -1, "and held");
  x.__wpk_fork_module_state_table_mutation_commit(0, 3, 0n, 0n);
  assert.equal(lastErrno(), 0, "a zero-length mutation commits cleanly");
  assert.equal(Atomics.load(lock, 0), 0, "and releases the writer");

  // A changed slot holding a function the loader never catalogued cannot be
  // described as a coordinate. The commit must FAIL -- a patch that silently
  // omitted it would tell peers the slot was cleared -- and it must still
  // release the writer, or every other worker in the process wedges.
  assert.ok(
    Number(x.__wpk_fork_module_state_table_mutation_begin()) >= 0,
    "the writer is taken again",
  );
  x.__wpk_fork_module_state_table_mutation_commit(0, 3, 100n, 1n);
  // ENOENT, not EINVAL: every other failure in this path reports EINVAL, so
  // asserting EINVAL here would pass for the wrong reason -- which it did, until
  // a perturbation that recorded the slot as CLEARED went undetected.
  const ENOENT = 2;
  assert.equal(
    lastErrno(),
    ENOENT,
    "an uncatalogued function in the changed range fails the commit",
  );
  assert.equal(
    Atomics.load(lock, 0),
    0,
    "and a FAILED commit still releases the writer",
  );

  // A commit naming an activation this worker does not have is refused rather
  // than sent through an empty drive slot.
  assert.ok(Number(x.__wpk_fork_module_state_table_mutation_begin()) >= 0);
  x.__wpk_fork_module_state_table_mutation_commit(9, 3, 0n, 1n);
  assert.equal(lastErrno(), ENOENT, "an absent activation's table is refused");
  assert.equal(Atomics.load(lock, 0), 0, "and the writer is released");

  // Committing without holding the writer is refused rather than forced.
  x.__wpk_fork_module_state_table_mutation_commit(0, 3, 0n, 0n);
  assert.notEqual(lastErrno(), 0, "committing without the writer is an error");
  assert.equal(Atomics.load(lock, 0), 0, "and changes nothing");
}

console.log("fork-module capture harness: all assertions passed");
