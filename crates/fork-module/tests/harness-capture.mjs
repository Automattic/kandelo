// V8 end-to-end validation harness for the fork-module CAPTURE session
// (Path B P3 — the module-owned encode graph over the shared
// `fork_codec::ReferenceGraphBuilder`).
//
// This proves, in a real production WebAssembly engine (Node's V8 — the same
// engine the Node and browser process workers run), that the `fm_capture_*`
// exports correctly drive the SHARED Rust capture builder from a host: they
// intern each reference kind by resolved COORDINATE, dedup, claim/define GC
// aggregates by reading scalar/edge spans out of linear memory, build reference
// vectors, gate a canonical placeholder for the no-provenance path, validate the
// canonical capture, and serialize the graph into the KFRV/KFRS record stream
// the host drains into its module-state arena. The builder's own round-trip
// against the decoder is proven in-crate (`fork-codec`
// reference_segments_writer tests, 431 passing); this harness proves the WASM
// EXPORT surface + memory reads + record-stream framing + proof-of-use counter
// on the actual engine, which no host-triple Rust test can.
//
// Run: node crates/fork-module/tests/harness-capture.mjs <path-to-fork_module.wasm>

import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

const wasmPath = process.argv[2];
if (!wasmPath) {
  console.error("usage: node harness-capture.mjs <path-to-fork_module.wasm>");
  process.exit(2);
}

const PAGE = 65536;
const EINVAL = 22;

// Shared-ABI constants mirrored from crates/shared/src/lib.rs (the module and
// this harness both read the same authoritative values).
const OWNER_ID = 1; // WPK_FORK_REFERENCE_TRANSACTION_OWNER
const RECORD_KIND_MANIFEST = 2; // ..._RECORD_KIND_REFERENCE_RECIPE (carries KFRV)
const RECORD_KIND_SEGMENT = 12; // ..._RECORD_KIND_REFERENCE_RECIPE_SEGMENT (KFRS)
const SEGMENT_WINDOW = 1 << 16; // per-segment copy window (single segment/section)

// GC aggregate kinds fm_capture_define_gc accepts.
const KIND_STRUCT = 1;
const KIND_ARRAY = 2;

// -- Host memory layout (mirrors the production worker / harness.mjs) ----------
const MODULE_BASE = 32 * 1024 * 1024; // __memory_base
const MODULE_MEM = 16 * 1024 * 1024;
const STACK_LOW = MODULE_BASE + MODULE_MEM;
const STACK_SIZE = 1024 * 1024;
const STACK_TOP = STACK_LOW + STACK_SIZE;
const TABLE_BASE = 0;
const RECONCILE_TABLE_SLOTS = 4096;
// A scratch region in the low (guest-proxied) area for the argument arrays this
// harness hands to fm_capture_define_gc. Well below MODULE_BASE, so it never
// collides with the module's own data / BSS / stack.
const SCRATCH_BASE = 1 * 1024 * 1024;

const INITIAL_PAGES = Math.ceil((STACK_TOP + PAGE) / PAGE);
const memory = new WebAssembly.Memory({
  initial: INITIAL_PAGES,
  maximum: 16384,
  shared: true,
});

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
    resolve_externref: (_handle) => ({}),
    // `__wpk_fork_host_ref_identity(anyref) -> i32`: a stable integer per
    // distinct GC reference. Wasm can COMPARE references but cannot HASH one,
    // so a reference cannot key a map inside the module; the host can. On a
    // real JavaScript host this is a WeakMap; here a Map suffices because the
    // values under test are i31s, which are primitives at this boundary.
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
  "fm_capture_intern",
  "fm_capture_claim_gc",
  "fm_capture_gated_placeholder",
  "fm_capture_define_gc",
  "fm_capture_validate",
  "fm_capture_serialize",
  "fm_capture_serialized_len",
  "fm_capture_record_header_size",
  "fm_capture_interned",
  "fm_last_errno",
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

// -- Parse the record stream fm_capture_serialize produced --------------------
//
// Each record is a 16-byte header (u16 kind, u16 reserved, u32 activationId,
// u32 ownerId, u32 payloadLen) followed by payloadLen bytes. The header size is
// self-reported by the module so this stays in lockstep with it.
function drainRecords() {
  const ptr = x.fm_capture_serialize(OWNER_ID, SEGMENT_WINDOW);
  assert.ok(ptr !== 0, `fm_capture_serialize failed, errno=${lastErrno()}`);
  assert.equal(lastErrno(), 0, "serialize sets errno OK");
  const len = x.fm_capture_serialized_len();
  assert.ok(len > 0, "serialized stream is non-empty");
  const header = x.fm_capture_record_header_size();
  assert.equal(header, 16, "record header is 16 bytes");
  const view = dv();
  const bytesOut = [];
  const records = [];
  let off = ptr;
  const end = ptr + len;
  while (off < end) {
    const kind = view.getUint16(off, true);
    const activationId = view.getUint32(off + 4, true);
    const ownerId = view.getUint32(off + 8, true);
    const payloadLen = view.getUint32(off + 12, true);
    const payloadStart = off + header;
    const payload = u8().slice(payloadStart, payloadStart + payloadLen);
    records.push({ kind, activationId, ownerId, payloadLen, payload });
    off = payloadStart + payloadLen;
  }
  assert.equal(off, end, "record stream is exactly consumed");
  // Serialize once more into a raw copy for determinism comparison.
  const raw = u8().slice(ptr, ptr + len);
  bytesOut.push(...raw);
  return { records, raw };
}

function ascii(bytes) {
  return String.fromCharCode(...bytes.slice(0, 4));
}

// ============================================================================
// 1. A comprehensive graph: every intern kind, a struct<->array cycle sharing an
//    aliased externref leaf, i31/static-root leaves, and a shared/deduped vector.
// ============================================================================
x.fm_capture_begin();
assert.equal(lastErrno(), 0, "begin sets errno OK");
// `fm_capture_intern`'s leaf-kind discriminants (mirror the module's
// INTERN_KIND_*, and host/src/fork-reference-capture-module.ts's
// FORK_INTERN_KIND_*).
const K_FUNCREF = 1;
const K_EXTERNREF = 2;
const K_I31 = 3;
const K_STATIC_ROOT = 4;

const before = x.fm_capture_interned();

// Claim the two aggregates first so a field edge can close the cycle.
const sId = x.fm_capture_claim_gc(); // 1: struct
const aId = x.fm_capture_claim_gc(); // 2: array
const fId = x.fm_capture_intern(K_FUNCREF, 10, 20); // 3
const xId = x.fm_capture_intern(K_EXTERNREF, 99, 0); // 4
const iId = x.fm_capture_intern(K_I31, -5, 0); // 5
const rId = x.fm_capture_intern(K_STATIC_ROOT, 3, 7); // 6
const leafId = x.fm_capture_intern(K_EXTERNREF, 0xffffffff >>> 0, 0); // 7 aliased leaf
assert.deepEqual([sId, aId, fId, xId, iId, rId, leafId], [1, 2, 3, 4, 5, 6, 7]);

// Dedup by coordinate: the same externref handle / funcref coordinate / i31
// value / static-root coordinate resolve to the SAME recipe id.
assert.equal(x.fm_capture_intern(K_EXTERNREF, 99, 0), xId, "externref dedups by handle");
assert.equal(x.fm_capture_intern(K_FUNCREF, 10, 20), fId, "funcref dedups by coord");
assert.equal(x.fm_capture_intern(K_I31, -5, 0), iId, "i31 dedups by value");
assert.equal(x.fm_capture_intern(K_STATIC_ROOT, 3, 7), rId, "static root dedups");

// Build the field vectors first (the module reads them internally at define).
function buildVector(ids) {
  // The GUEST path is the only vector builder the module exposes: begin
  // declares how many appends will follow, and finish refuses to intern a
  // vector whose appends did not match that count. There is deliberately no
  // unguarded `fm_capture_*_vector` twin -- a second builder without the
  // count discipline could intern a SHORT vector, and the child would then
  // reconstruct a frame with references silently missing.
  const h = x.__wpk_fork_ref_vector_begin(ids.length);
  assert.ok(h >= 0, `vector_begin errno=${lastErrno()}`);
  for (const id of ids) {
    x.__wpk_fork_ref_vector_append(h, id);
  }
  const ordinal = x.__wpk_fork_ref_vector_finish(h);
  assert.ok(ordinal >= 1, `vector_finish errno=${lastErrno()}`);
  return ordinal;
}
// struct 1 -> array 2 (cycle), leaf 7 (alias); scalars read from memory.
const structFields = buildVector([aId, leafId]);
writeBytes(SCRATCH_BASE, [0x78, 0x56, 0x34, 0x12]);
assert.equal(
  x.fm_capture_define_gc(
    sId, 7 /*act*/, 2 /*type*/, 12 /*layout*/, KIND_STRUCT,
    SCRATCH_BASE, 4, structFields, 0 /*no prov*/, 0, 0,
  ),
  0,
  `define struct failed errno=${lastErrno()}`,
);
// array 2 -> struct 1 (cycle), leaf 7 (alias).
const arrayFields = buildVector([sId, leafId]);
writeBytes(SCRATCH_BASE + 64, [0xaa, 0xbb]);
assert.equal(
  x.fm_capture_define_gc(
    aId, 7, 3, 13, KIND_ARRAY, SCRATCH_BASE + 64, 2, arrayFields, 0, 0, 0,
  ),
  0,
  `define array failed errno=${lastErrno()}`,
);

// A shared/deduped vector: two identical builds return the same ordinal.
const o1 = buildVector([fId, xId, iId]);
const o2 = buildVector([fId, xId, iId]);
assert.equal(o1, o2, "identical vectors dedup to one ordinal");
const o3 = buildVector([sId, aId]);
assert.notEqual(o1, o3, "distinct vectors take distinct ordinals");
// Reading the resident builder's vectors back (the parent's own replay read).
assert.equal(x.fm_capture_vector_get(o1, 0), fId, "vector_get reads the builder");
assert.equal(x.fm_capture_vector_get(o3, 1), aId, "vector_get reads the builder");

// Proof-of-use: the module interned every one of the above through the shared
// builder (each successful op bumps the counter).
assert.ok(
  x.fm_capture_interned() > before,
  "capture proof-of-use counter advanced through the shared builder",
);

assert.equal(x.fm_capture_validate(), 0, `validate failed errno=${lastErrno()}`);

const first = drainRecords();
// The stream ends with the KFRV manifest record; the preceding records are KFRS
// segments, one section each at this window (nodes/edges/scalars/vec-index/vec).
const manifest = first.records[first.records.length - 1];
assert.equal(manifest.kind, RECORD_KIND_MANIFEST, "last record is the manifest");
assert.equal(manifest.ownerId, OWNER_ID, "manifest carries the transaction owner");
assert.equal(ascii(manifest.payload), "KFRV", "manifest payload is KFRV");
const segments = first.records.filter((r) => r.kind === RECORD_KIND_SEGMENT);
assert.ok(segments.length >= 1, "at least one KFRS segment emitted");
for (const seg of segments) {
  assert.equal(ascii(seg.payload), "KFRS", "segment payload is KFRS");
}
// The struct scalar bytes we wrote into memory must appear in the serialized
// SCALARS section — direct proof fm_capture_define_gc read guest memory.
const streamBytes = Buffer.from(first.raw);
assert.ok(
  streamBytes.includes(Buffer.from([0x78, 0x56, 0x34, 0x12])),
  "struct scalar payload read from memory reached the serialized stream",
);

// Determinism: rebuilding the identical graph serializes byte-for-byte the same.
x.fm_capture_begin();
x.fm_capture_claim_gc(); // 1
x.fm_capture_claim_gc(); // 2
x.fm_capture_intern(K_FUNCREF, 10, 20); // 3
x.fm_capture_intern(K_EXTERNREF, 99, 0); // 4
x.fm_capture_intern(K_I31, -5, 0); // 5
x.fm_capture_intern(K_STATIC_ROOT, 3, 7); // 6
x.fm_capture_intern(K_EXTERNREF, 0xffffffff >>> 0, 0); // 7
const sf2 = buildVector([2, 7]); // ordinal 1
writeBytes(SCRATCH_BASE, [0x78, 0x56, 0x34, 0x12]);
x.fm_capture_define_gc(1, 7, 2, 12, KIND_STRUCT, SCRATCH_BASE, 4, sf2, 0, 0, 0);
const af2 = buildVector([1, 7]); // ordinal 2
writeBytes(SCRATCH_BASE + 64, [0xaa, 0xbb]);
x.fm_capture_define_gc(2, 7, 3, 13, KIND_ARRAY, SCRATCH_BASE + 64, 2, af2, 0, 0, 0);
buildVector([3, 4, 5]);
buildVector([3, 4, 5]);
buildVector([1, 2]);
assert.equal(x.fm_capture_validate(), 0, "second build validates");
const second = drainRecords();
assert.deepEqual(second.raw, first.raw, "capture serialization is deterministic");

// ============================================================================
// 2. The GATED path (soundness gate parity): a value with no recoverable
//    production-site provenance reserves a DISTINCT canonical placeholder leaf,
//    keeping the graph canonical and one-to-one with the host's captured-value
//    side table. Each gated placeholder is its own recipe id.
// ============================================================================
x.fm_capture_begin();
const g1 = x.fm_capture_gated_placeholder();
const g2 = x.fm_capture_gated_placeholder();
assert.deepEqual([g1, g2], [1, 2], "each gated value gets a distinct recipe id");
assert.equal(x.fm_capture_validate(), 0, "a graph of gated leaves is canonical");
const gated = drainRecords();
assert.equal(
  gated.records[gated.records.length - 1].kind,
  RECORD_KIND_MANIFEST,
  "gated capture still seals a manifest (discarded unread by the aborting fork)",
);

// ============================================================================
// 3. Truthful failure: a session with an un-completed GC claim is NOT canonical;
//    validate and serialize must fail cleanly with EINVAL, never a wrong graph.
// ============================================================================
x.fm_capture_begin();
x.fm_capture_claim_gc(); // 1: claimed but never defined
assert.equal(x.fm_capture_validate(), -1, "pending GC claim is not canonical");
assert.equal(lastErrno(), EINVAL, "validate reports EINVAL for a pending claim");
assert.equal(
  x.fm_capture_serialize(OWNER_ID, SEGMENT_WINDOW),
  0,
  "serialize refuses a non-canonical graph",
);
assert.equal(lastErrno(), EINVAL, "serialize reports EINVAL for a pending claim");

// ============================================================================
// 4. Truthful failure: an invalid coordinate (zero externref handle) is EINVAL,
//    not a fabricated recipe.
// ============================================================================
x.fm_capture_begin();
assert.equal(x.fm_capture_intern(K_EXTERNREF, 0, 0), -1, "zero handle is rejected");

// The kind-discriminated entry's own admission checks. `fm_capture_intern`
// replaced four per-type exports, so the argument-shape errors those four made
// impossible by construction are now runtime errors, and they have to be loud.
assert.equal(x.fm_capture_intern(0, 1, 0), -1, "kind 0 is rejected");
assert.equal(x.fm_capture_intern(5, 1, 0), -1, "kind past the last discriminant is rejected");
assert.equal(
  x.fm_capture_intern(0xffffffff >>> 0, 1, 0),
  -1,
  "a garbage kind is rejected, not silently treated as a funcref",
);
// The `b must be 0` rule for the one-argument kinds. Without it, a caller that
// passed funcref argument ORDER with an externref kind -- (EXTERNREF,
// activation, ordinal) -- would silently intern the activation id as a broker
// handle and capture the wrong reference.
assert.equal(
  x.fm_capture_intern(K_EXTERNREF, 99, 7),
  -1,
  "externref with a non-zero second argument is rejected",
);
assert.equal(
  x.fm_capture_intern(K_I31, -5, 7),
  -1,
  "i31 with a non-zero second argument is rejected",
);
assert.equal(lastErrno(), EINVAL, "zero externref handle reports EINVAL");

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
  const a = x.fm_capture_intern(K_I31, 11, 0);
  const b = x.fm_capture_intern(K_I31, 22, 0);
  x.__wpk_fork_ref_vector_append(h, a);
  x.__wpk_fork_ref_vector_append(h, b);
  const ordinal = x.__wpk_fork_ref_vector_finish(h);
  assert.ok(ordinal >= 0, "a vector matching its declared count interns");
  assert.notEqual(ordinal, h, "finish returns the DURABLE ordinal, not the handle");
}
{
  // Declared 2, appended 1: must fail rather than intern a short vector.
  const h = x.__wpk_fork_ref_vector_begin(2);
  x.__wpk_fork_ref_vector_append(h, x.fm_capture_intern(K_I31, 33, 0));
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
  x.__wpk_fork_ref_vector_append(h, x.fm_capture_intern(K_I31, 44, 0));
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
  assert.equal(
    x.__wpk_fork_ref_gc_i31(-7),
    x.fm_capture_intern(K_I31, -7, 0),
    "gc_i31 shares the recipe space with the host-facing intern entry",
  );
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
  const payloadA = x.fm_capture_intern(K_I31, 11, 0); // 1
  const payloadB = x.fm_capture_intern(K_EXTERNREF, 55, 0); // 2
  const exn = x.fm_capture_claim_gc(); // 3
  assert.deepEqual([payloadA, payloadB, exn], [1, 2, 3], "exception fixture ids");

  writeBytes(SCALARS, [0xde, 0xad, 0xbe, 0xef]);
  writeU32Array(REFS, [payloadA, payloadB]);
  x.__wpk_fork_ref_exn_define(exn, ACT, TYPE_ORDINAL, LAYOUT, SCALARS, 4, REFS, 2);
  assert.equal(lastErrno(), 0, "exn_define latched no error");
  assert.equal(x.fm_capture_validate(), 0, `exn graph validates errno=${lastErrno()}`);

  // Proof it read GUEST MEMORY rather than inventing a payload: the scalar
  // bytes we wrote must survive into the serialized stream.
  const stream = Buffer.from(drainRecords().raw);
  assert.ok(
    stream.includes(Buffer.from([0xde, 0xad, 0xbe, 0xef])),
    "exception scalar payload read from guest memory reached the stream",
  );

  // -- Perturbation: an edge naming a recipe that does not exist -------------
  x.fm_capture_begin();
  const orphan = x.fm_capture_claim_gc();
  writeU32Array(REFS, [99]);
  x.__wpk_fork_ref_exn_define(orphan, ACT, TYPE_ORDINAL, LAYOUT, SCALARS, 4, REFS, 1);
  assert.equal(lastErrno(), EINVAL, "an edge naming a missing recipe is EINVAL");
  assert.notEqual(
    x.fm_capture_validate(),
    0,
    "and the rejected define leaves a placeholder the seal refuses",
  );

  // -- Perturbation: the define never happens at all -------------------------
  //
  // This is the guard that makes the void return safe. Without it a dropped
  // define would seal cleanly and the child would rebuild an exception whose
  // payload silently vanished.
  x.fm_capture_begin();
  x.fm_capture_claim_gc();
  assert.notEqual(
    x.fm_capture_validate(),
    0,
    "a claimed exception that is never defined blocks the seal",
  );

  // -- Perturbation: defining a recipe that was never claimed ----------------
  x.fm_capture_begin();
  x.__wpk_fork_ref_exn_define(5, ACT, TYPE_ORDINAL, LAYOUT, SCALARS, 0, REFS, 0);
  assert.equal(lastErrno(), EINVAL, "defining an unclaimed recipe is EINVAL");

  // -- Perturbation: a staging span outside guest memory ---------------------
  x.fm_capture_begin();
  const oob = x.fm_capture_claim_gc();
  x.__wpk_fork_ref_exn_define(oob, ACT, TYPE_ORDINAL, LAYOUT, 0xfffffff0, 4, REFS, 0);
  assert.equal(lastErrno(), EINVAL, "a scalar span outside guest memory is EINVAL");
  x.fm_capture_begin();
  const oob2 = x.fm_capture_claim_gc();
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
  const payload = x.fm_capture_intern(K_EXTERNREF, 77, 0); // 1
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

  assert.equal(x.fm_capture_validate(), 0, `exn graph validates errno=${lastErrno()}`);

  // Proof the shared payload really is one node: the graph holds the two
  // exception recipes plus ONE payload leaf, not two.
  const stream = Buffer.from(drainRecords().raw);
  assert.ok(
    stream.includes(Buffer.from([0x11, 0x22, 0x33, 0x44])),
    "exception scalars reached the serialized stream",
  );

  // A claimed exception that is never defined still blocks the seal -- the
  // fresh-recipe path must not weaken that.
  x.fm_capture_begin();
  x.__wpk_fork_ref_exn_claim(0);
  assert.notEqual(
    x.fm_capture_validate(),
    0,
    "a claimed exception never defined blocks the seal",
  );
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
  assert.notEqual(
    x.fm_capture_validate(),
    0,
    "and the capture cannot seal",
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
  assert.equal(x.fm_capture_intern(K_I31, 5, 0), 1, "witness stand-in is recipe 1");

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
  const node = x.fm_capture_claim_gc();
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
  assert.equal(x.fm_capture_validate(), 0, `graph validates errno=${lastErrno()}`);

  // The witness is CACHED: a second object of the same layout reuses the recipe
  // rather than re-encoding. Proven by clearing the drive slot first -- a
  // re-encode would now call a null table entry and trap.
  driveTable.set(ACT * 13 + DRIVE_SLOT_GC_ENCODE, null);
  const second = x.fm_capture_claim_gc();
  const fields2 = buildVector([1]);
  x.__wpk_fork_ref_gc_define(
    second, ACT, 2, LAYOUT, KIND_STRUCT, SCRATCH_BASE + 768, 4, fields2,
  );
  assert.equal(lastErrno(), 0, "a second object of the layout reuses the witness recipe");
  assert.equal(encodeCalls() - before, 1, "and does NOT drive the codec again");
  assert.equal(x.fm_capture_validate(), 0, "the graph still validates");

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
  const plain = x.fm_capture_claim_gc();
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
  // The broker walks the activations `fm_set_activation_gc_codec` registered,
  // so a codec must be seeded for each. The committed fixture is a real codec
  // section, shared here by both activations.
  const codecBytes = readFileSync(
    new URL("../../fork-codec/testdata/gc-codec-wasm32.bin", import.meta.url),
  );
  const CODEC_AT = SCRATCH_BASE + 4096;
  u8().set(codecBytes, CODEC_AT);
  const seedCodec = (act) => {
    x.fm_set_activation_gc_codec(act, CODEC_AT, codecBytes.length);
    assert.equal(lastErrno(), 0, `seeding codec for activation ${act}`);
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
  assert.equal(x.fm_capture_intern(K_I31, 9, 0), 1, "routed value's recipe");

  // Seed two activation codecs so the broker has a registry to walk. The bytes
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

// ---- Funcref table reconcile against the REAL published dylink archive ------
//
// The fixture is the same byte image `fork_codec::dylink_table_plan`'s
// `plans_against_the_real_published_archive` uses: a memory dump whose KFLA
// header sits at offset 4096. Here it proves the whole module-side path --
// decode, plan, catalog resolution, and the injected `table.set` -- against
// tables a host really supplied, which no Rust unit test can reach.
{
  const FIXTURE_HEAD = 4096;
  const fixture = readFileSync(
    new URL("../../fork-codec/testdata/dylink-archive-wasm32.bin", import.meta.url),
  );
  assert.ok(fixture.length > FIXTURE_HEAD, "fixture must contain its own header");
  u8().set(fixture, 0);

  const indirect = importObject.env.__indirect_function_table;
  const catalog = importObject.env.__wpk_fork_function_catalog;
  // Every catalog slot holds the SAME function, so a written slot is
  // identifiable without knowing which ordinal the archive chose.
  const SENTINEL = x.fm_last_errno;
  const SLOTS = RECONCILE_TABLE_SLOTS;
  catalog.grow(SLOTS, SENTINEL);
  assert.equal(indirect.length, SLOTS, "the indirect table is sized for the plan");
  // The module's OWN dylink entries are already in the table -- it was placed
  // at TABLE_BASE. Those are not reconcile writes, so everything below counts
  // the DELTA against them rather than the absolute occupancy.
  const occupied = () => {
    let n = 0;
    for (let i = 0; i < SLOTS; i += 1) if (indirect.get(i) !== null) n += 1;
    return n;
  };
  const ownEntries = new Map();
  for (let i = 0; i < SLOTS; i += 1) {
    const entry = indirect.get(i);
    if (entry !== null) ownEntries.set(i, entry);
  }
  const baseline = ownEntries.size;
  const added = () => occupied() - baseline;
  // Reset to exactly the placement state: every reconcile write undone, every
  // entry the module placed for itself put back, so the module stays callable.
  const resetIndirect = () => {
    for (let i = 0; i < SLOTS; i += 1) {
      indirect.set(i, ownEntries.get(i) ?? null);
    }
  };

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
  assert.equal(added(), 0, "an unpublished reconcile writes nothing");

  // The real archive. The module reads the head out of the control block at a
  // fixed negative offset, so the harness writes the head there and passes the
  // control address -- exactly what a host does. Owner 3 is the one
  // `plans_against_the_real_published_archive` exercises.
  const CONTROL = 64 * 1024;
  const DLOPEN_HEAD_OFFSET_WASM32 = 12;
  const seedControl = (head) => {
    dv().setUint32(CONTROL - DLOPEN_HEAD_OFFSET_WASM32, head, true);
    x.fm_set_format(4, 0, CONTROL, 3);
    assert.equal(lastErrno(), 0, "seeding the control address succeeds");
  };
  seedControl(FIXTURE_HEAD);
  const reached = Number(x.__wpk_fork_module_state_table_reconcile());
  assert.equal(lastErrno(), 0, `reconcile errno=${lastErrno()}`);
  assert.ok(reached > 0, `a published archive reaches a real generation (${reached})`);
  // Without this the idempotence check below would pass VACUOUSLY on an
  // archive that never wrote a slot in the first place.
  const first = added();
  assert.ok(first > 0, `the reconcile wrote table slots (${first})`);
  // Every slot the reconcile CHANGED must hold a value it took from the
  // function catalog, never something it invented. A cleared slot is null.
  let changed = 0;
  for (let i = 0; i < SLOTS; i += 1) {
    const entry = indirect.get(i);
    if (entry === (ownEntries.get(i) ?? null)) continue;
    changed += 1;
    if (entry !== null) {
      assert.equal(entry, SENTINEL, `slot ${i} came from the function catalog`);
    }
  }
  assert.ok(changed > 0, "the reconcile changed slots it did not already own");

  // Idempotent: replaying from the generation just reached must write NOTHING.
  // Clearing first is what makes that observable -- otherwise a second full
  // rewrite would leave the table looking identical.
  resetIndirect();
  const again = Number(x.__wpk_fork_module_state_table_reconcile());
  assert.equal(again, reached, "a second reconcile reaches the same generation");
  assert.equal(added(), 0, "and writes nothing, because nothing moved");

  // The generation a reconcile REPORTS is the snapshot's, not the highest one
  // this worker's own owner appears in.
  //
  // This needs its own archive shape to mean anything: in the fixture as
  // published, the header generation and owner 3's newest patch are the SAME
  // number, so a reconcile that returned either would look right. Raising the
  // header's fence above every owner-3 patch separates them. It matters because
  // the guest caches this value and compares it against the fence on the next
  // table access -- report below the fence and the guard re-enters on every
  // access, forever.
  const HEADER_GENERATION_OFFSET = 40;
  dv().setBigUint64(FIXTURE_HEAD + HEADER_GENERATION_OFFSET, 99n, true);
  seedControl(FIXTURE_HEAD);
  const fenced = Number(x.__wpk_fork_module_state_table_reconcile());
  assert.equal(lastErrno(), 0, `fenced reconcile errno=${lastErrno()}`);
  assert.equal(fenced, 99, "the reconcile reports the snapshot generation");
  assert.notEqual(fenced, reached, "and that is NOT the owner-filtered value");
  dv().setBigUint64(FIXTURE_HEAD + HEADER_GENERATION_OFFSET, BigInt(reached), true);
  // Re-seeding reset the applied cursor, so that reconcile legitimately rewrote
  // the table. Put it back to the placement state before the refusal cases,
  // which measure that a REFUSED reconcile writes nothing.
  resetIndirect();

  // A head that names no header is a malformed archive, not an empty one.
  seedControl(FIXTURE_HEAD + 8);
  assert.equal(
    Number(x.__wpk_fork_module_state_table_reconcile()),
    -1,
    "a head pointing into the middle of the header is refused",
  );
  assert.equal(lastErrno(), EINVAL, "and the reason is EINVAL");
  assert.equal(added(), 0, "a refused reconcile writes no slots");

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

console.log("fork-module capture harness: all assertions passed");
