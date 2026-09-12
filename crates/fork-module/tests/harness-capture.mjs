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
    __indirect_function_table: new WebAssembly.Table({ element: "anyfunc", initial: 0 }),
    __wpk_fork_function_catalog: new WebAssembly.Table({ element: "anyfunc", initial: 0 }),
    __wpk_fork_drive_table: new WebAssembly.Table({ element: "anyfunc", initial: 0 }),
    __wpk_fork_static_root_catalog: new WebAssembly.Table({ element: "anyref", initial: 0 }),
    __stack_pointer: new WebAssembly.Global({ value: "i32", mutable: true }, STACK_TOP),
    __memory_base: new WebAssembly.Global({ value: "i32", mutable: false }, MODULE_BASE),
    __table_base: new WebAssembly.Global({ value: "i32", mutable: false }, TABLE_BASE),
    resolve_externref: (_handle) => ({}),
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
  "fm_capture_begin_vector",
  "fm_capture_append_vector",
  "fm_capture_finish_vector",
  "fm_capture_validate",
  "fm_capture_serialize",
  "fm_capture_serialized_len",
  "fm_capture_record_header_size",
  "fm_capture_interned",
  "fm_last_errno",
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
  const h = x.fm_capture_begin_vector();
  assert.ok(h >= 0, "begin_vector");
  for (const id of ids) {
    assert.equal(x.fm_capture_append_vector(h, id), 0, "append_vector");
  }
  return x.fm_capture_finish_vector(h);
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

  // Claim and publish A exactly as the guest does: claim, then table.set at
  // recipe + 1 on the next instruction.
  const ra = x.__wpk_fork_ref_gc_claim(0);
  transit.set(ra + 1, A);

  transit.set(0, A);
  assert.equal(x.__wpk_fork_ref_gc_lookup(0), ra, "lookup finds an already-claimed value");
  transit.set(0, B);
  assert.equal(x.__wpk_fork_ref_gc_lookup(0), 0, "an unseen value is reported new");

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

// Dirty table-page tracking. `fork-instrument` wraps every table.set / copy /
// fill / init / grow with a mark, so a fork serialises only the pages that
// actually changed instead of every slot of a large table.
//
// With no fork in flight these answer for an empty set rather than erroring,
// which is what lets a save run against a table nothing touched.
{
  assert.equal(
    x.__wpk_fork_module_state_table_dirty_count(7),
    0,
    "an untouched table has no dirty pages",
  );
  // NOTE ON COVERAGE. This harness runs with NO fork in flight, so for every
  // entry below the no-state guard fires FIRST and shadows the deeper ones.
  // These assertions therefore test that guard and nothing past it -- which is
  // worth testing (a stray guest call must not write into an unowned region)
  // but is not the same as testing the logic behind it.
  //
  // The deeper branches -- an out-of-range ordinal, a page set that actually
  // has contents -- need a live fork, which needs the syscall channel and the
  // guest drive table a single-threaded harness cannot stand up. They are
  // UNCOVERED here and that is why each is named for the guard it reaches.
  x.__wpk_fork_module_state_table_dirty_page(7, 0);
  assert.equal(
    lastErrno(),
    EINVAL,
    "asking for a page with no fork in flight is EINVAL, not a silent 0",
  );
  // Marking needs a live fork: the set hangs off the fork's own state, so a
  // mark with nothing in flight must fail rather than accumulate into a set
  // that will never be serialised.
  x.__wpk_fork_module_state_table_dirty_mark(7, 0n, 4n);
  assert.equal(
    lastErrno(),
    EINVAL,
    "marking with no fork in flight latches EINVAL",
  );
}

console.log("fork-module capture harness: all assertions passed");
