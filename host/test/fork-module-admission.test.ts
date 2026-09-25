import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveBinary } from "../src/binary-resolver";
import { instantiateForkModule } from "../src/fork-module-instance";
import {
  encodeForkAdmission,
  FORK_ADMISSION_BORROWED_CHILD,
  FORK_ADMISSION_FORK_CHILD,
} from "../src/fork-guest-sections";
import {
  CHANNEL_BASE,
  MMAP_FLOOR,
  MODULE_BASE,
  PAGE,
  startChannelResponder,
} from "./fork-module-capture-fixture";

/**
 * Lane F stage 1a: `fm_admit_activation` + `fm_bind_activation`, checked
 * against the per-fact entries they replace, over a REAL instrumented guest.
 *
 * The guest is `dash.wasm`, a fork-instrumented C program with hundreds of
 * resume targets and every section an admission can carry. The host part of
 * admission is only locating sections and copying their bytes, which this test
 * does with `WebAssembly.Module.customSections` exactly as a host would; the
 * module decodes them.
 *
 * The comparison is the point: one module instance is seeded the OLD way (one
 * `fm_*` call per fact, the host decoding the resume catalog itself), a second
 * is admitted, and everything the module lets a host observe -- the resume
 * assignment, the catalog bases, the drive base -- must be identical. What a
 * host cannot read back (the stored codec and section bytes, the template id)
 * is checked through the old seeds' own same-bytes rule: re-seeding identical
 * bytes over an admitted activation is a no-op, different bytes are `EINVAL`.
 */

const EINVAL = 22;
const STAGE = 16 * PAGE;

const KIND = {
  linkedFrames: 1,
  moduleState: 2,
  resumeCatalog: 3,
  gcCodec: 4,
  exceptionCodec: 5,
  importedGlobals: 6,
  importedTables: 7,
} as const;
type Kind = keyof typeof KIND;

const SECTION: Record<Kind, string> = {
  linkedFrames: "kandelo.wpk_fork.linked_frames",
  moduleState: "kandelo.wpk_fork.module_state",
  resumeCatalog: "kandelo.wpk_fork.resume_catalog",
  gcCodec: "kandelo.wpk_fork.gc_codec",
  exceptionCodec: "kandelo.wpk_fork.exception_codec",
  importedGlobals: "kandelo.wpk_fork.imported_globals",
  importedTables: "kandelo.wpk_fork.imported_tables",
};

const guest = new WebAssembly.Module(
  readFileSync(resolveBinary("programs/dash.wasm")),
);

/** Locate every admission section, the host's whole part in admission. */
function locate(module: WebAssembly.Module): Map<Kind, Uint8Array> {
  const out = new Map<Kind, Uint8Array>();
  for (const kind of Object.keys(KIND) as Kind[]) {
    const [bytes] = WebAssembly.Module.customSections(module, SECTION[kind]);
    if (bytes) out.set(kind, new Uint8Array(bytes));
  }
  return out;
}

/**
 * The `KFAA` layout `fork_codec::encode_activation_admission` writes, over a
 * section map a case can perturb. The production writer takes a whole
 * `WebAssembly.Module`; the first case below pins the two against each other.
 */
function encode(
  activation: number,
  templateId: Uint8Array,
  sections: Map<Kind, Uint8Array>,
  flags = 0,
): Uint8Array {
  const entries = [...sections];
  const refsEnd = 64 + entries.length * 12;
  const total = entries.reduce((n, [, b]) => n + b.length, refsEnd);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  out.set([0x4b, 0x46, 0x41, 0x41], 0); // "KFAA"
  view.setUint16(4, 1, true);
  view.setUint16(6, 64, true);
  view.setUint32(8, activation, true);
  view.setUint32(12, flags, true);
  out.set(templateId, 16);
  view.setUint32(48, entries.length, true);
  let offset = refsEnd;
  entries.forEach(([kind, bytes], i) => {
    view.setUint32(64 + i * 12, KIND[kind], true);
    view.setUint32(64 + i * 12 + 4, offset, true);
    view.setUint32(64 + i * 12 + 8, bytes.length, true);
    out.set(bytes, offset);
    offset += bytes.length;
  });
  return out;
}

function templateId(fill: number): Uint8Array {
  return new Uint8Array(32).fill(fill);
}

type Fn = (...args: number[]) => number;

function freshModule(label: string) {
  const memory = new WebAssembly.Memory({ initial: 256, maximum: 16384, shared: true });
  const fm = instantiateForkModule({
    module: new WebAssembly.Module(readFileSync(resolveBinary("fork_module32.wasm"))),
    memory,
    reserve: () => MODULE_BASE,
    label,
  });
  startChannelResponder({ memory, channelBase: CHANNEL_BASE, floor: MMAP_FLOOR });
  const x = fm.exports as Record<string, Fn>;
  let cursor = STAGE;
  /** Copy bytes into guest memory, as a host stages into its slab. */
  const stage = (bytes: Uint8Array): number => {
    const at = cursor;
    new Uint8Array(memory.buffer, at, bytes.length).set(bytes);
    cursor = (at + bytes.length + 7) & ~7;
    return at;
  };
  const errno = (): number => x.fm_last_errno!();
  const call = (name: string, ...args: number[]): number => {
    const result = x[name]!(...args);
    expect(errno(), `${label}: ${name}`).toBe(0);
    return result;
  };
  const admit = (desc: Uint8Array): number => x.fm_admit_activation!(stage(desc), desc.length);
  /** The published `(ordinal, slot)` pairs, read out of guest memory. */
  const records = (ptr: number, count: number): number[][] => {
    const words = new Uint32Array(memory.buffer.slice(ptr, ptr + count * 8));
    return Array.from({ length: count }, (_, i) => [words[i * 2]!, words[i * 2 + 1]!]);
  };
  const bind = (activation: number, funcLen: number, staticLen: number) => {
    const at = x.fm_bind_activation!(activation, funcLen, staticLen);
    if (at === 0) return { errno: errno() };
    const [drive, func, statics, ptr, count] = new Uint32Array(memory.buffer.slice(at, at + 20));
    return {
      errno: errno(),
      row: { drive, func, statics },
      assignment: records(ptr!, count!),
    };
  };
  return { x, memory, stage, errno, call, admit, bind, records };
}

type Module = ReturnType<typeof freshModule>;

/** The resume ordinals, decoded by the host the way the old path did. */
function ordinals(catalog: Uint8Array): number[] {
  const view = new DataView(catalog.buffer, catalog.byteOffset, catalog.byteLength);
  const count = view.getUint32(8, true);
  return Array.from({ length: count }, (_, i) => view.getUint32(12 + i * 8, true));
}

function fixedPrefix(sections: Map<Kind, Uint8Array>): number {
  const linked = sections.get("linkedFrames")!;
  return new DataView(linked.buffer, linked.byteOffset).getUint32(20, true);
}

/** The per-fact seeds for everything but the resume catalog. */
function seedFacts(m: Module, activation: number, id: Uint8Array, sections: Map<Kind, Uint8Array>): void {
  m.call("fm_set_activation_template_id", activation, m.stage(id));
  const gc = sections.get("gcCodec")!;
  m.call("fm_set_activation_gc_codec", activation, m.stage(gc), gc.length);
  const exn = sections.get("exceptionCodec");
  if (exn) m.call("fm_set_activation_exception_codec", activation, m.stage(exn), exn.length);
  for (const [space, kind] of [[0, "importedGlobals"], [1, "importedTables"]] as const) {
    const bytes = sections.get(kind)!;
    m.call("fm_set_activation_imports", space, activation, m.stage(bytes), bytes.length);
  }
}

/** Seed one activation with the per-fact entries admission replaces. */
function seedOld(m: Module, activation: number, id: Uint8Array, sections: Map<Kind, Uint8Array>): void {
  seedFacts(m, activation, id, sections);
  const ords = ordinals(sections.get("resumeCatalog")!);
  const words = new Uint8Array(new Uint32Array(ords).buffer);
  m.call("fm_set_activation_resume_catalog", activation, m.stage(words), ords.length);
}

/** The old placement: the four entries `fm_bind_activation` replaces. */
function bindOld(m: Module, activation: number, funcLen: number, staticLen: number) {
  const func = m.call("fm_place_activation_catalog", activation, funcLen);
  const statics = m.call("fm_place_activation_static_roots", activation, staticLen);
  const drive = m.call("fm_drive_table_base", activation);
  const packed = (m.x.fm_publish_resume_assignment as unknown as (a: number) => bigint)(activation);
  expect(m.errno()).toBe(0);
  const ptr = Number(packed & 0xffff_ffffn);
  const count = Number(packed >> 32n);
  return { row: { drive, func, statics }, assignment: m.records(ptr, count) };
}

const sections = locate(guest);
const prefix = fixedPrefix(sections);
/** Three activations of one guest; lengths as a host would read them. */
const ACTIVATIONS = [
  { id: 0, template: templateId(0xa0), funcLen: 7, staticLen: 3 },
  { id: 1, template: templateId(0xa1), funcLen: 5, staticLen: 0 },
  { id: 4, template: templateId(0xa4), funcLen: 2, staticLen: 9 },
];

function admitted(label: string): Module {
  const m = freshModule(label);
  m.call("fm_set_format", 4, prefix, 0, CHANNEL_BASE);
  for (const a of ACTIVATIONS) {
    expect(m.admit(encode(a.id, a.template, sections)), `admit ${a.id}`).toBe(0);
  }
  return m;
}

describe("fm_admit_activation / fm_bind_activation", () => {
  it("the real guest carries every section, and a non-trivial catalog", () => {
    expect([...sections.keys()].sort()).toEqual(Object.keys(KIND).sort());
    expect(ordinals(sections.get("resumeCatalog")!).length).toBeGreaterThan(100);
  });

  it("the production writer lays out exactly this, and the module admits it", () => {
    // `encodeForkAdmission` is what both JS hosts stage. Byte-equal to the
    // codec-shaped encoding of the located sections, with the flags a host
    // passes, and admitted for real.
    const template = templateId(0x3c);
    const flags = FORK_ADMISSION_FORK_CHILD | FORK_ADMISSION_BORROWED_CHILD;
    const written = encodeForkAdmission(2, flags, template, guest);
    expect(written).toEqual(encode(2, template, sections, flags));
    const m = freshModule("production writer");
    m.call("fm_set_format", 4, prefix, 0, CHANNEL_BASE);
    expect(m.admit(written)).toBe(0);
    expect(m.bind(2, 1, 1).errno).toBe(0);
  });

  it("takes activation 0's prefix from its admission when fm_set_format gives none", () => {
    // A host that admits no longer decodes the linked-frame section, so it
    // passes 0 for the prefix and activation 0's admission supplies it. A
    // non-zero prefix is still checked (the case below).
    const m = freshModule("prefix from admission");
    m.call("fm_set_format", 4, 0, 0, CHANNEL_BASE);
    expect(m.admit(encodeForkAdmission(0, 0, templateId(0), guest))).toBe(0);
    // Re-admitting the same module is the usual no-op.
    expect(m.admit(encodeForkAdmission(0, 0, templateId(0), guest))).toBe(0);
  });

  it("produces the same resume assignment and bases as the per-fact entries", () => {
    const old = freshModule("old path");
    old.call("fm_set_format", 4, prefix, 0, CHANNEL_BASE);
    for (const a of ACTIVATIONS) seedOld(old, a.id, a.template, sections);
    const fresh = admitted("admission path");
    for (const a of ACTIVATIONS) {
      const before = bindOld(old, a.id, a.funcLen, a.staticLen);
      const after = fresh.bind(a.id, a.funcLen, a.staticLen);
      expect(after.errno).toBe(0);
      expect(after.row).toEqual(before.row);
      expect(after.assignment).toEqual(before.assignment);
      expect(after.assignment.length).toBe(ordinals(sections.get("resumeCatalog")!).length);
    }
    // Non-trivial placement: later activations land at distinct bases.
    expect(fresh.bind(4, 2, 9).row).toEqual({ drive: 4 * 19, func: 12, statics: 3 });
  });

  it("stores exactly the bytes the per-fact entries would have", () => {
    const m = admitted("stored bytes");
    // EQUAL: re-seeding identical bytes over an admitted activation is each
    // old seed's no-op (a conflicting one is EINVAL).
    for (const a of ACTIVATIONS) seedFacts(m, a.id, a.template, sections);
    // PRESENT: a different value is refused, so a record exists at all.
    const refused = (name: string, ...args: number[]): number => {
      m.x[name]!(...args);
      return m.errno();
    };
    expect(refused("fm_set_activation_template_id", 1, m.stage(templateId(0x55)))).toBe(EINVAL);
    // An empty GC codec is valid ("no typed GC") and differs from the stored one.
    expect(refused("fm_set_activation_gc_codec", 1, m.stage(new Uint8Array(1)), 0)).toBe(EINVAL);
    // A valid exception codec declaring no tags differs from the stored one.
    const noTags = sections.get("exceptionCodec")!.slice(0, 8);
    new DataView(noTags.buffer).setUint32(4, 0, true);
    expect(refused("fm_set_activation_exception_codec", 1, m.stage(noTags), 8)).toBe(EINVAL);
    // And for each optional section, an admission WITHOUT it now disagrees
    // with the record the first admission stored.
    for (const kind of ["gcCodec", "exceptionCodec", "importedGlobals", "importedTables"] as const) {
      const without = new Map(sections);
      without.delete(kind);
      expect(m.admit(encode(1, ACTIVATIONS[1]!.template, without)), kind).toBe(EINVAL);
    }
  });

  it("re-admitting identical facts is a no-op that keeps every placed slot", () => {
    const m = admitted("re-admission");
    const first = m.bind(1, 5, 0);
    // Stand in for the guest's placement shim: put a thunk at every slot the
    // assignment named. A re-admission that re-registered the catalog would
    // null these (and hand the slots out again), which no row comparison sees.
    const table = m.x.__wpk_fork_resume_table as unknown as WebAssembly.Table;
    const thunk = m.x.fm_last_errno as unknown as CallableFunction;
    const slots = first.assignment!.map(([, slot]) => slot!);
    const top = Math.max(...slots) + 1;
    if (table.length < top) table.grow(top - table.length);
    for (const slot of slots) table.set(slot, thunk);
    expect(m.admit(encode(1, ACTIVATIONS[1]!.template, sections))).toBe(0);
    expect(m.bind(1, 5, 0)).toEqual(first);
    expect(slots.every((slot) => table.get(slot) === thunk)).toBe(true);
  });

  it("refuses a re-admission whose facts differ, and changes nothing", () => {
    const m = admitted("conflict");
    const first = m.bind(1, 5, 0);
    // Same template, same sections, a DIFFERENT resume catalog: the old seed
    // would have replaced the catalog and renumbered every placed slot.
    const catalog = sections.get("resumeCatalog")!.slice(0, 12 + 8 * 3);
    new DataView(catalog.buffer).setUint32(8, 3, true);
    const changed = new Map(sections).set("resumeCatalog", catalog);
    expect(m.admit(encode(1, ACTIVATIONS[1]!.template, changed))).toBe(EINVAL);
    // A different template id.
    expect(m.admit(encode(1, templateId(0x77), sections))).toBe(EINVAL);
    expect(m.bind(1, 5, 0)).toEqual(first);
  });

  it("refuses a linked-frame pointer width that disagrees with module state", () => {
    const m = freshModule("pointer width");
    m.call("fm_set_format", 4, prefix, 0, CHANNEL_BASE);
    const linked = sections.get("linkedFrames")!.slice();
    linked[8] = 8; // wasm64 geometry fields no longer match, and module state says 4
    expect(m.admit(encode(2, templateId(2), new Map(sections).set("linkedFrames", linked)))).toBe(EINVAL);
    expect(m.bind(2, 1, 1).errno).toBe(EINVAL); // nothing was admitted
  });

  it("refuses an activation whose pointer width is not the worker's", () => {
    const m = freshModule("worker width");
    m.call("fm_set_format", 8, prefix, 0, CHANNEL_BASE);
    expect(m.admit(encode(1, templateId(1), sections))).toBe(EINVAL);
  });

  it("refuses a main activation whose fixed prefix is not fm_set_format's", () => {
    const m = freshModule("prefix");
    m.call("fm_set_format", 4, prefix + 8, 0, CHANNEL_BASE);
    expect(m.admit(encode(0, templateId(0), sections))).toBe(EINVAL);
    // A side activation brings its own prefix.
    expect(m.admit(encode(1, templateId(1), sections))).toBe(0);
  });

  it("refuses a resume catalog whose ordinal is not its slot", () => {
    const m = freshModule("ordinal slot");
    m.call("fm_set_format", 4, prefix, 0, CHANNEL_BASE);
    const catalog = sections.get("resumeCatalog")!.slice();
    const view = new DataView(catalog.buffer);
    view.setUint32(12 + 8 * 2 + 4, view.getUint32(12 + 8 * 2 + 4, true) + 1_000_000, true);
    expect(m.admit(encode(1, templateId(1), new Map(sections).set("resumeCatalog", catalog)))).toBe(EINVAL);
  });

  it("refuses admission before fm_set_format, and binding an unadmitted activation", () => {
    const m = freshModule("order");
    expect(m.admit(encode(0, templateId(0), sections))).toBe(EINVAL);
    m.call("fm_set_format", 4, prefix, 0, CHANNEL_BASE);
    expect(m.bind(0, 1, 1).errno).toBe(EINVAL);
  });

  it("refuses admission with EINVAL, not a trap, when the worker has no channel", () => {
    // The module stores everything in channel-mapped arena records, and even
    // decoding allocates on its channel-mapped heap.
    const m = freshModule("no channel");
    m.call("fm_set_format", 4, prefix, 0, 0);
    expect(m.admit(encode(0, templateId(0), sections))).toBe(EINVAL);
  });

  it("refuses a structurally corrupt descriptor", () => {
    const m = freshModule("structure");
    m.call("fm_set_format", 4, prefix, 0, CHANNEL_BASE);
    const desc = encode(1, templateId(1), sections);
    const badMagic = desc.slice();
    badMagic[0] = 0;
    expect(m.admit(badMagic)).toBe(EINVAL);
    expect(m.admit(desc.slice(0, desc.length - 1))).toBe(EINVAL);
    expect(m.admit(desc)).toBe(0);
  });
});
