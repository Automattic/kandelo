import { expect } from "vitest";

import {
  FORK_BINDING_EXPORT_CATALOG,
  FORK_BINDING_IMPORT,
  type ForkBindingRow,
} from "../../src/fork-import-identity";
import { encodeForkBindings } from "../../src/fork-module-backend";

import {
  WPK_FORK_LINKED_FRAME_DESCRIPTOR_SIZE,
  WPK_FORK_LINKED_FRAME_FORMAT_MAGIC,
  WPK_FORK_LINKED_FRAME_FORMAT_VERSION,
  WPK_FORK_LINKED_FRAME_RECORD_ALIGNMENT,
  WPK_FORK_LINKED_FRAME_REQUIRED_FLAGS,
  WPK_FORK_MODULE_STATE_ARENA_VERSION,
  WPK_FORK_MODULE_STATE_DESCRIPTOR_SIZE,
  WPK_FORK_MODULE_STATE_FORMAT_MAGIC,
  WPK_FORK_MODULE_STATE_FORMAT_VERSION,
  WPK_FORK_MODULE_STATE_RECORD_ALIGNMENT,
  WPK_FORK_MODULE_STATE_RECORD_VERSION,
  WPK_FORK_MODULE_STATE_REQUIRED_FLAGS,
  WPK_FORK_MODULE_STATE_ROOT_POINTER_WORD_OFFSET,
} from "../../src/generated/abi";

/**
 * Seed a bare fork-module instance the way both hosts do: one
 * `fm_admit_activation` per activation (a `KFAA` descriptor), then one
 * `fm_bind_activation` once it would be instantiated.
 *
 * A host builds its descriptor from a real guest's custom sections
 * (`encodeForkAdmission`). A module test usually has no guest -- it wants an
 * activation with THESE resume ordinals, or THIS GC codec -- so the two
 * sections every admission requires (linked frames, module state) are
 * written here from the ABI constants, and the resume catalog from the
 * ordinals asked for. The layout is `fork_codec::activation_admission`'s;
 * `fork-module-admission.test.ts` pins the production writer against it
 * over a real guest.
 */

/** Section kinds, as `AdmissionSectionKind` numbers them on the wire. */
const KIND_LINKED_FRAMES = 1;
const KIND_MODULE_STATE = 2;
const KIND_RESUME_CATALOG = 3;
const KIND_GC_CODEC = 4;
const KIND_EXCEPTION_CODEC = 5;
const KIND_IMPORTED_GLOBALS = 6;
const KIND_IMPORTED_TABLES = 7;

/** Everything an admission can say about one activation. */
export interface AdmissionFacts {
  /** The 32-byte template id, or a byte to fill it with. Default: zeros. */
  readonly template?: Uint8Array | number;
  /**
   * The activation's fork-instrumented function ordinals: its resume catalog.
   * Strictly ascending, as the instrumenter emits them. Default: none.
   */
  readonly ordinals?: readonly number[];
  /** The linked-frame fixed prefix. Default 0, as `fm_set_format(4, 0, ..)`. */
  readonly fixedPrefix?: number;
  readonly gcCodec?: Uint8Array;
  readonly exceptionCodec?: Uint8Array;
  readonly importedGlobals?: Uint8Array;
  readonly importedTables?: Uint8Array;
  /** `ADMISSION_FLAG_*`. Default 0. */
  readonly flags?: number;
}

/** A wasm32 `kandelo.wpk_fork.linked_frames` descriptor. */
export function linkedFramesSection(fixedPrefix = 0): Uint8Array {
  const out = new Uint8Array(WPK_FORK_LINKED_FRAME_DESCRIPTOR_SIZE);
  const view = new DataView(out.buffer);
  out.set(WPK_FORK_LINKED_FRAME_FORMAT_MAGIC, 0);
  view.setUint16(4, WPK_FORK_LINKED_FRAME_FORMAT_VERSION, true);
  view.setUint16(6, WPK_FORK_LINKED_FRAME_DESCRIPTOR_SIZE, true);
  out[8] = 4; // pointer width
  out[9] = WPK_FORK_LINKED_FRAME_RECORD_ALIGNMENT;
  view.setUint16(10, WPK_FORK_LINKED_FRAME_REQUIRED_FLAGS, true);
  view.setUint32(12, 32, true); // wasm32 chunk header
  view.setUint32(16, 24, true); // wasm32 node header
  view.setUint32(20, fixedPrefix, true);
  return out;
}

/** A wasm32 `kandelo.wpk_fork.module_state` descriptor. */
export function moduleStateSection(): Uint8Array {
  const out = new Uint8Array(WPK_FORK_MODULE_STATE_DESCRIPTOR_SIZE);
  const view = new DataView(out.buffer);
  out.set(WPK_FORK_MODULE_STATE_FORMAT_MAGIC, 0);
  view.setUint16(4, WPK_FORK_MODULE_STATE_FORMAT_VERSION, true);
  view.setUint16(6, WPK_FORK_MODULE_STATE_DESCRIPTOR_SIZE, true);
  out[8] = 4;
  out[9] = WPK_FORK_MODULE_STATE_RECORD_ALIGNMENT;
  view.setUint16(10, WPK_FORK_MODULE_STATE_REQUIRED_FLAGS, true);
  view.setUint16(12, WPK_FORK_MODULE_STATE_ARENA_VERSION, true);
  view.setUint16(14, WPK_FORK_MODULE_STATE_RECORD_VERSION, true);
  view.setUint32(16, WPK_FORK_MODULE_STATE_ROOT_POINTER_WORD_OFFSET, true);
  return out;
}

/**
 * A `KFRC` resume catalog whose every record is `(ordinal, ordinal)`: the
 * instrumenter uses the ordinal as the catalog slot, and admission refuses
 * a record where the two differ.
 */
export function resumeCatalogSection(ordinals: readonly number[]): Uint8Array {
  const out = new Uint8Array(12 + ordinals.length * 8);
  const view = new DataView(out.buffer);
  out.set([0x4b, 0x46, 0x52, 0x43], 0); // "KFRC"
  view.setUint16(4, 1, true);
  view.setUint16(6, 12, true);
  view.setUint32(8, ordinals.length, true);
  ordinals.forEach((ordinal, i) => {
    view.setUint32(12 + i * 8, ordinal >>> 0, true);
    view.setUint32(16 + i * 8, ordinal >>> 0, true);
  });
  return out;
}

export function templateBytes(template: Uint8Array | number | undefined): Uint8Array {
  if (template instanceof Uint8Array) return template;
  return new Uint8Array(32).fill(template ?? 0);
}

/** One activation's `KFAA` descriptor. */
export function admissionDescriptor(activation: number, facts: AdmissionFacts = {}): Uint8Array {
  const sections: Array<[number, Uint8Array]> = [
    [KIND_LINKED_FRAMES, linkedFramesSection(facts.fixedPrefix ?? 0)],
    [KIND_MODULE_STATE, moduleStateSection()],
    [KIND_RESUME_CATALOG, resumeCatalogSection(facts.ordinals ?? [])],
  ];
  if (facts.gcCodec) sections.push([KIND_GC_CODEC, facts.gcCodec]);
  if (facts.exceptionCodec) sections.push([KIND_EXCEPTION_CODEC, facts.exceptionCodec]);
  if (facts.importedGlobals) sections.push([KIND_IMPORTED_GLOBALS, facts.importedGlobals]);
  if (facts.importedTables) sections.push([KIND_IMPORTED_TABLES, facts.importedTables]);
  let offset = 64 + sections.length * 12;
  const out = new Uint8Array(sections.reduce((n, [, b]) => n + b.length, offset));
  const view = new DataView(out.buffer);
  out.set([0x4b, 0x46, 0x41, 0x41], 0); // "KFAA"
  view.setUint16(4, 1, true);
  view.setUint16(6, 64, true);
  view.setUint32(8, activation, true);
  view.setUint32(12, facts.flags ?? 0, true);
  out.set(templateBytes(facts.template), 16);
  view.setUint32(48, sections.length, true);
  sections.forEach(([kind, bytes], i) => {
    view.setUint32(64 + i * 12, kind, true);
    view.setUint32(68 + i * 12, offset, true);
    view.setUint32(72 + i * 12, bytes.length, true);
    out.set(bytes, offset);
    offset += bytes.length;
  });
  return out;
}

type Exports = Record<string, unknown>;

/** A catalog-export binding row: catalog entry `owner` of `space` is object `group`. */
export function exportRow(space: number, owner: number, group: number): ForkBindingRow {
  return { space, role: FORK_BINDING_EXPORT_CATALOG, kind: 0, ordinalOrOwner: owner, group, bits: 0n };
}

/** An import binding row: import `ordinal` of `space` resolved to `kind`. */
export function importRow(
  space: number,
  ordinal: number,
  kind: number,
  group: number,
  bits: bigint,
): ForkBindingRow {
  return { space, role: FORK_BINDING_IMPORT, kind, ordinalOrOwner: ordinal, group, bits };
}

/**
 * `fm_publish_bindings(activation, rows)`, the rows written by the production
 * writer (`encodeForkBindings`) and staged at `stageAt`. Returns the errno the
 * module answered (0 on success).
 */
export function publishBindings(
  x: Exports,
  memory: WebAssembly.Memory,
  stageAt: number,
  activation: number,
  rows: readonly ForkBindingRow[],
): number {
  const bytes = encodeForkBindings(rows);
  new Uint8Array(memory.buffer, stageAt, bytes.length).set(bytes);
  return (x.fm_publish_bindings as (a: number, p: number, n: number) => number)(
    activation,
    stageAt,
    rows.length,
  );
}

/**
 * Admit one activation. The descriptor is staged at `stageAt` when it fits
 * `stageBytes`, and otherwise in a buffer `fm_admission_buffer` maps -- the
 * route a host takes for an admission larger than its slab. Returns the
 * errno `fm_admit_activation` answered (0 on success).
 */
export function admit(
  x: Exports,
  memory: WebAssembly.Memory,
  stageAt: number,
  activation: number,
  facts: AdmissionFacts = {},
  stageBytes = 65536,
): number {
  const desc = admissionDescriptor(activation, facts);
  let at = stageAt;
  if (desc.length > stageBytes) {
    at = (x.fm_admission_buffer as (len: number) => number)(desc.length) >>> 0;
    if (at === 0) return (x.fm_last_errno as () => number)();
  }
  new Uint8Array(memory.buffer, at, desc.length).set(desc);
  return (x.fm_admit_activation as (p: number, n: number) => number)(at, desc.length);
}

/** `admit`, and fail the test unless the module accepted it. */
export function admitOk(
  x: Exports,
  memory: WebAssembly.Memory,
  stageAt: number,
  activation: number,
  facts: AdmissionFacts = {},
  stageBytes = 65536,
): void {
  expect(admit(x, memory, stageAt, activation, facts, stageBytes), `admitting activation ${activation}`)
    .toBe(0);
}

/** The row `fm_bind_activation` answers, decoded. */
export interface BindRow {
  readonly drive: number;
  readonly func: number;
  readonly statics: number;
  /** The published `(ordinal, slot)` pairs, ascending by ordinal. */
  readonly assignment: Array<[number, number]>;
  /** Where the module published them, for a guest's placement shim. */
  readonly resume: { readonly ptr: number; readonly count: number };
}

/**
 * Bind one admitted activation. Returns the row, or `null` with the module's
 * errno left in `fm_last_errno` when it refused. Binding again with the same
 * lengths answers the same row, which is how a test re-reads an assignment.
 */
export function bind(
  x: Exports,
  memory: WebAssembly.Memory,
  activation: number,
  funcLen = 0,
  staticLen = 0,
): BindRow | null {
  const at = (x.fm_bind_activation as (a: number, f: number, s: number) => number)(
    activation,
    funcLen,
    staticLen,
  ) >>> 0;
  if (at === 0) return null;
  const [drive, func, statics, ptr, count] = new Uint32Array(memory.buffer.slice(at, at + 20));
  // A fresh view: publishing a large assignment can map, which grows memory.
  const view = new DataView(memory.buffer);
  const assignment: Array<[number, number]> = [];
  for (let i = 0; i < count!; i += 1) {
    assignment.push([view.getUint32(ptr! + i * 8, true), view.getUint32(ptr! + i * 8 + 4, true)]);
  }
  return { drive: drive!, func: func!, statics: statics!, assignment, resume: { ptr: ptr!, count: count! } };
}

/** `bind`, and fail the test unless the module accepted it. */
export function bindOk(
  x: Exports,
  memory: WebAssembly.Memory,
  activation: number,
  funcLen = 0,
  staticLen = 0,
): BindRow {
  const row = bind(x, memory, activation, funcLen, staticLen);
  if (row === null) {
    throw new Error(
      `binding activation ${activation} failed with errno ${(x.fm_last_errno as () => number)()}`,
    );
  }
  return row;
}
