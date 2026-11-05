import { ERRNO } from "../generated/abi";

export const OVERLAY_ACTIVATION_BYTES = 128;
const WIRE_BYTES = 120;

export interface OverlayActivationRecord {
  sequence: number;
  generation: number;
  slot: "legacy" | `g${number}`;
  baseDigest: Uint8Array;
  sealDigest: Uint8Array;
}

export type OverlayGenerationRef = Pick<OverlayActivationRecord, "slot" | "generation">;
export type OverlayCandidateRole = "unanchored" | "active" | "unpublished" | "inactive";
export type OverlayGenerationRelationship = "unrelated" | "reused" | "predecessor" | "self";

export class InvalidOverlayActivationError extends Error {
  readonly recovery = "unproven-overlay-activation";

  constructor(message = "Cannot prove the latest writable journal generation", options?: ErrorOptions) {
    super(message, options);
    this.name = "InvalidOverlayActivationError";
  }
}

export interface OverlayActivationCodec {
  encode(record: OverlayActivationRecord): Uint8Array;
  decode(bytes: Uint8Array): OverlayActivationRecord;
  next(current: OverlayActivationRecord | null, identity: Omit<OverlayActivationRecord, "sequence">): OverlayActivationRecord;
  select(records: readonly [OverlayActivationRecord | null, OverlayActivationRecord | null], invalid: boolean): OverlayActivationRecord | null;
  compareGenerations(left: OverlayGenerationRef, right: OverlayGenerationRef, newestFirst?: boolean): number;
  candidateRole(active: OverlayActivationRecord | null, candidate: Omit<OverlayActivationRecord, "sequence">): OverlayCandidateRole;
  requireInventory(active: OverlayActivationRecord | null, candidate: Omit<OverlayActivationRecord, "sequence"> | null, nonemptyUnverified: boolean): void;
  relationship(active: OverlayGenerationRef, sourceSlot: OverlayGenerationRef["slot"], other: OverlayGenerationRef): OverlayGenerationRelationship;
  mayReuse(active: OverlayGenerationRef, candidate: OverlayGenerationRef): boolean;
  mayRetire(active: OverlayGenerationRef, protectedSource: OverlayGenerationRef, candidate: OverlayGenerationRef): boolean;
  mayRetireUnsealed(active: OverlayGenerationRef, source: OverlayGenerationRef, sourceSlot: OverlayGenerationRef["slot"], hasDigest: boolean): boolean;
  mayStage(active: OverlayGenerationRef, protectedSource: OverlayGenerationRef | null, target: OverlayGenerationRef): boolean;
  mayReclaimUnpublished(active: OverlayActivationRecord | null, selected: Omit<OverlayActivationRecord, "sequence">,
    protectedSource: OverlayGenerationRef, candidate: OverlayGenerationRef): boolean;
}

export type OverlayActivationCodecCall = (operation: number, input: Uint8Array) => Uint8Array | number;

function recordWire(record: Omit<OverlayActivationRecord, "sequence"> & { sequence?: number }): Uint8Array {
  const bytes = new Uint8Array(WIRE_BYTES);
  const view = new DataView(bytes.buffer);
  view.setFloat64(0, record.sequence ?? 0, true);
  view.setFloat64(8, record.generation, true);
  const slot = typeof record.slot === "string" && record.slot.length <= 24 ? new TextEncoder().encode(record.slot) : new Uint8Array();
  view.setUint32(16, slot.length, true);
  view.setUint32(20, Math.min(record.baseDigest.length, 0xffff_ffff), true);
  view.setUint32(24, Math.min(record.sealDigest.length, 0xffff_ffff), true);
  bytes.set(record.baseDigest.subarray(0, 32), 32);
  bytes.set(record.sealDigest.subarray(0, 32), 64);
  bytes.set(slot.subarray(0, 24), 96);
  return bytes;
}

function wireRecord(bytes: Uint8Array): OverlayActivationRecord {
  if (bytes.length !== WIRE_BYTES) throw new Error("Native activation codec returned invalid transport geometry");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const slotLength = view.getUint32(16, true);
  if (slotLength > 24) throw new Error("Native activation codec returned an invalid slot transport");
  return { sequence: view.getFloat64(0, true), generation: view.getFloat64(8, true),
    slot: new TextDecoder().decode(bytes.subarray(96, 96 + slotLength)) as OverlayActivationRecord["slot"],
    baseDigest: bytes.slice(32, 64), sealDigest: bytes.slice(64, 96) };
}

function referenceWire(reference: OverlayGenerationRef): Uint8Array {
  const bytes = new Uint8Array(40);
  const view = new DataView(bytes.buffer);
  view.setFloat64(0, reference.generation, true);
  const slot = typeof reference.slot === "string" && reference.slot.length <= 24
    ? new TextEncoder().encode(reference.slot) : new Uint8Array();
  view.setUint32(8, slot.length, true);
  bytes.set(slot.subarray(0, 24), 16);
  return bytes;
}

function referencesWire(flags: number, references: readonly (OverlayGenerationRef | null)[]): Uint8Array {
  const bytes = new Uint8Array(8 + references.length * 40);
  new DataView(bytes.buffer).setUint32(0, flags, true);
  for (const [index, reference] of references.entries()) {
    if (reference !== null) bytes.set(referenceWire(reference), 8 + index * 40);
  }
  return bytes;
}

function candidateWire(active: OverlayActivationRecord | null, candidate: Omit<OverlayActivationRecord, "sequence"> | null,
  finish: boolean, nonemptyUnverified = false): Uint8Array {
  const bytes = new Uint8Array(8 + 2 * WIRE_BYTES);
  new DataView(bytes.buffer).setUint32(0, (active === null ? 0 : 1) | (candidate === null ? 0 : 2)
    | (finish ? 4 : 0) | (nonemptyUnverified ? 8 : 0), true);
  if (active !== null) bytes.set(recordWire(active), 8);
  if (candidate !== null) bytes.set(recordWire(candidate), 8 + WIRE_BYTES);
  return bytes;
}

export function createOverlayActivationCodec(call: OverlayActivationCodecCall): OverlayActivationCodec {
  const invoke = (operation: number, input: Uint8Array): Uint8Array => {
    const result = call(operation, input);
    if (typeof result === "number") {
      if (result === -ERRNO.EINVAL || result === -ERRNO.EIO) throw new InvalidOverlayActivationError();
      if (Number.isInteger(result) && result < 0) throw Object.assign(new Error("Native activation codec refused its request"), { errno: -result });
      throw new Error("Native activation codec returned no bytes");
    }
    return result;
  };
  const scalar = (operation: number, input: Uint8Array): number => {
    const bytes = invoke(operation, input);
    if (bytes.length !== 4) throw new Error("Native generation policy returned invalid transport geometry");
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  };
  const retention = (mode: number, active: OverlayGenerationRef, protectedSource: OverlayGenerationRef | null,
    candidate: OverlayGenerationRef, hasDigest = false): boolean => {
    const result = scalar(24, referencesWire(mode | (protectedSource === null ? 0 : 4) | (hasDigest ? 8 : 0),
      [active, protectedSource, candidate]));
    if (result > 1) throw new Error("Native generation policy returned invalid retention transport");
    return result === 1;
  };
  return Object.freeze({
    mayReclaimUnpublished: (active: OverlayActivationRecord | null, selected: Omit<OverlayActivationRecord, "sequence">,
      protectedSource: OverlayGenerationRef, candidate: OverlayGenerationRef) => {
      const input = new Uint8Array(328);
      new DataView(input.buffer).setUint32(0, 2 | (active === null ? 0 : 1), true);
      if (active !== null) input.set(recordWire(active), 8);
      input.set(recordWire(selected), 128);
      input.set(referenceWire(protectedSource), 248);
      input.set(referenceWire(candidate), 288);
      const result = scalar(25, input);
      if (result > 1) throw new Error("Native generation policy returned invalid reclamation transport");
      return result === 1;
    },
    compareGenerations: (left: OverlayGenerationRef, right: OverlayGenerationRef, newestFirst = false) => {
      const result = scalar(21, referencesWire(newestFirst ? 1 : 0, [left, right]));
      if (result === 3) throw new Error("persistent overlay has ambiguous sealed generations; refusing to select one");
      if (result > 3) throw new Error("Native generation policy returned invalid ordering transport");
      return [0, -1, 1][result]!;
    },
    candidateRole: (active: OverlayActivationRecord | null, candidate: Omit<OverlayActivationRecord, "sequence">) => {
      const result = scalar(22, candidateWire(active, candidate, false));
      if (result > 3) throw new Error("Native generation policy returned invalid authority transport");
      return (["unanchored", "active", "unpublished", "inactive"] as const)[result];
    },
    requireInventory: (active: OverlayActivationRecord | null, candidate: Omit<OverlayActivationRecord, "sequence"> | null,
      nonemptyUnverified: boolean) => {
      if (scalar(22, candidateWire(active, candidate, true, nonemptyUnverified)) > 1) {
        throw new Error("Native generation policy returned invalid inventory transport");
      }
    },
    relationship: (active: OverlayGenerationRef, sourceSlot: OverlayGenerationRef["slot"], other: OverlayGenerationRef) => {
      const result = scalar(23, referencesWire(0, [active, { slot: sourceSlot, generation: 0 }, other]));
      if (result > 3) throw new Error("Native generation policy returned invalid relationship transport");
      return (["unrelated", "reused", "predecessor", "self"] as const)[result];
    },
    mayReuse: (active: OverlayGenerationRef, candidate: OverlayGenerationRef) => retention(0, active, null, candidate),
    mayRetire: (active: OverlayGenerationRef, protectedSource: OverlayGenerationRef, candidate: OverlayGenerationRef) =>
      retention(1, active, protectedSource, candidate),
    mayRetireUnsealed: (active: OverlayGenerationRef, source: OverlayGenerationRef, sourceSlot: OverlayGenerationRef["slot"], hasDigest: boolean) =>
      retention(2, active, source, { slot: sourceSlot, generation: 0 }, hasDigest),
    mayStage: (active: OverlayGenerationRef, protectedSource: OverlayGenerationRef | null, target: OverlayGenerationRef) =>
      retention(3, active, protectedSource, target),
    encode: (record: OverlayActivationRecord) => {
      const bytes = invoke(0, recordWire(record));
      if (bytes.length !== OVERLAY_ACTIVATION_BYTES) throw new Error("Native activation encoder returned invalid geometry");
      return bytes;
    },
    decode: (bytes: Uint8Array) => {
      if (bytes.length !== OVERLAY_ACTIVATION_BYTES) throw new InvalidOverlayActivationError();
      return wireRecord(invoke(1, bytes));
    },
    next: (current: OverlayActivationRecord | null, identity: Omit<OverlayActivationRecord, "sequence">) => {
      const input = new Uint8Array(8 + 2 * WIRE_BYTES);
      if (current !== null) { new DataView(input.buffer).setUint32(0, 1, true); input.set(recordWire(current), 8); }
      input.set(recordWire(identity), 8 + WIRE_BYTES);
      return wireRecord(invoke(2, input));
    },
    select: (records: readonly [OverlayActivationRecord | null, OverlayActivationRecord | null], invalid: boolean) => {
      const input = new Uint8Array(8 + 2 * WIRE_BYTES);
      let flags = invalid ? 4 : 0;
      for (const index of [0, 1] as const) {
        if (records[index] === null) continue;
        flags |= 1 << index;
        input.set(recordWire(records[index]), 8 + index * WIRE_BYTES);
      }
      new DataView(input.buffer).setUint32(0, flags, true);
      const bytes = invoke(3, input);
      return bytes.length === 0 ? null : wireRecord(bytes);
    },
  });
}
