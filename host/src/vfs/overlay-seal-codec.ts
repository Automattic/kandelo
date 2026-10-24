import { ERRNO } from "../generated/abi";
import type { OverlayActivationCodecCall } from "./overlay-activation-codec";

export type OverlaySealSourceSlot = "legacy" | `g${number}`;

export interface OverlaySealSource {
  slot: OverlaySealSourceSlot;
  journalLength: number;
  journalDigest?: Uint8Array;
}

export interface OverlayGenerationSeal {
  generation: number;
  journalLength: number;
  baseDigest: Uint8Array;
  indexLength?: number;
  source?: OverlaySealSource;
}

export interface OverlayStorageHasher {
  reset(): void;
  update(bytes: Uint8Array): void;
  finish(): Uint8Array;
}

export interface OverlayRecoveryEvidence {
  source: "none" | "self" | "unsealed" | "sealed";
  expectedLength?: number;
  observedLength?: number;
  unverifiedSealLength?: number;
  hasDigest?: boolean;
  digestMatches?: boolean;
  verifiedPredecessor?: boolean;
  supersededPredecessor?: boolean;
  slotReused?: boolean;
}

export type OverlayRecoveryVerdict = "eligible" | "stale" | "superseded" | "unresolved" | "verify-digest";

export interface OverlaySealLayout {
  chunkBytes: number;
  digestBytes: number;
  totalBytes: number;
}

export interface OverlaySealInventory {
  journalLength: number;
  indexLength?: number;
  sealLength: number;
  expectedBaseDigest?: Uint8Array;
  allowAppendedTail: boolean;
}

export interface OverlaySealCodec {
  encodeHeader(record: OverlayGenerationSeal): Uint8Array;
  decodeHeader(bytes: Uint8Array): OverlayGenerationSeal;
  headerLength(prefix: Uint8Array): number;
  layout(header: Uint8Array): OverlaySealLayout;
  verifyStorage(header: Uint8Array, inventory: OverlaySealInventory): void;
  journalHeaderLength(): number;
  journalBaseDigest(header: Uint8Array): Uint8Array;
  indexHeaderLength(): number;
  indexRequiresConversion(header: Uint8Array): boolean;
  shouldConvertJournal(length: number): boolean;
  classifySource(evidence: OverlayRecoveryEvidence): OverlayRecoveryVerdict;
  hasher(): OverlayStorageHasher;
}

export class InvalidOverlaySealError extends Error {
  constructor() { super("persistent overlay generation seal is invalid"); }
}

const WIRE_BYTES = 144;
const STATE_BYTES = 112;
export const OVERLAY_DIGEST_CHUNK_BYTES = 60 * 1024;

export function createStorageHasher(call: OverlayActivationCodecCall): OverlayStorageHasher {
  const invoke = (operation: number, bytes: Uint8Array, count: number): Uint8Array => {
    const result = call(operation, bytes);
    if (typeof result === "number") {
      if (Number.isInteger(result) && result < 0) throw Object.assign(new Error("Native storage digest refused its request"), { errno: -result });
      throw new Error("Native storage digest returned no bytes");
    }
    if (result.length !== count) throw new Error("Native storage digest returned invalid transport geometry");
    return result;
  };
  const input = new Uint8Array(STATE_BYTES + OVERLAY_DIGEST_CHUNK_BYTES);
  const initial = invoke(6, Uint8Array.of(0), STATE_BYTES);
  input.set(initial);
  let finished = false;
  return Object.freeze({
    reset: () => { input.set(initial); finished = false; },
    update: (bytes: Uint8Array) => {
      if (finished) throw new Error("Storage digest is already finished");
      for (let offset = 0; offset < bytes.length; offset += OVERLAY_DIGEST_CHUNK_BYTES) {
        const part = bytes.subarray(offset, Math.min(bytes.length, offset + OVERLAY_DIGEST_CHUNK_BYTES));
        input.set(part, STATE_BYTES);
        input.set(invoke(7, input.subarray(0, STATE_BYTES + part.length), STATE_BYTES));
      }
    },
    finish: () => {
      if (finished) throw new Error("Storage digest is already finished");
      finished = true;
      return invoke(8, input.subarray(0, STATE_BYTES), 32);
    },
  });
}

export function createOverlaySealCodec(call: OverlayActivationCodecCall): OverlaySealCodec {
  const capability = call(10, Uint8Array.of(0));
  if (typeof capability === "number") {
    const errno = capability === -ERRNO.EINVAL ? ERRNO.ENOSYS : capability < 0 ? -capability : ERRNO.EIO;
    throw Object.assign(new Error("Native overlay seal policy is unavailable; rebuild the kernel or image module"), { errno });
  }
  if (capability.length !== 8 || !capability.every((byte, index) => byte === [75, 79, 83, 67, 2, 0, 0, 0][index])) {
    throw new Error("Native overlay seal policy returned an unsupported control protocol");
  }
  const invoke = (operation: number, input: Uint8Array, count?: number): Uint8Array => {
    const result = call(operation, input);
    if (typeof result === "number") {
      if (((operation === 4 || operation === 5 || operation === 9)
        && (result === -ERRNO.EIO || result === -ERRNO.EINVAL))
        || ((operation === 12 || operation === 14 || operation === 17 || operation === 18)
          && result === -ERRNO.EIO)) throw new InvalidOverlaySealError();
      if (Number.isInteger(result) && result < 0) throw Object.assign(new Error("Native seal codec refused its request"), { errno: -result });
      throw new Error("Native seal codec returned no bytes");
    }
    if (count !== undefined && result.length !== count) throw new Error("Native seal codec returned invalid transport geometry");
    return result;
  };
  const hasher = (): OverlayStorageHasher => createStorageHasher(call);
  const scalar = (operation: number, input: Uint8Array): number => {
    const bytes = invoke(operation, input, 4);
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  };
  const boolean = (operation: number, input: Uint8Array): boolean => {
    const value = scalar(operation, input);
    if (value > 1) throw new Error("Native recovery codec returned invalid boolean transport");
    return value === 1;
  };
  return Object.freeze({
    hasher,
    layout: (header: Uint8Array) => {
      const bytes = invoke(17, header, 16);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const chunkBytes = view.getUint32(0, true);
      const digestBytes = view.getUint32(4, true);
      const totalBytes = view.getFloat64(8, true);
      if (chunkBytes === 0 || chunkBytes > 1024 * 1024 || digestBytes !== 32
        || !Number.isSafeInteger(totalBytes) || totalBytes < header.length) {
        throw new Error("Native seal codec returned invalid layout transport");
      }
      return { chunkBytes, digestBytes, totalBytes };
    },
    verifyStorage: (header: Uint8Array, inventory: OverlaySealInventory) => {
      if (header.length > WIRE_BYTES) throw new InvalidOverlaySealError();
      const bytes = new Uint8Array(64 + header.length);
      const view = new DataView(bytes.buffer);
      let flags = inventory.indexLength === undefined ? 0 : 1;
      if (inventory.expectedBaseDigest !== undefined) {
        flags |= 2;
        bytes.set(inventory.expectedBaseDigest.subarray(0, 32), 32);
        view.setUint32(4, Math.min(inventory.expectedBaseDigest.length, 0xffff_ffff), true);
      }
      if (inventory.allowAppendedTail) flags |= 4;
      view.setUint32(0, flags, true);
      view.setFloat64(8, inventory.journalLength, true);
      view.setFloat64(16, inventory.indexLength ?? 0, true);
      view.setFloat64(24, inventory.sealLength, true);
      bytes.set(header, 64);
      if (scalar(18, bytes) !== 0) throw new Error("Native seal codec returned invalid verification transport");
    },
    journalHeaderLength: () => {
      const result = invoke(11, Uint8Array.of(0), 4);
      const count = new DataView(result.buffer, result.byteOffset, result.byteLength).getUint32(0, true);
      if (count === 0 || count > 144) throw new Error("Native journal codec returned invalid header transport");
      return count;
    },
    journalBaseDigest: (header: Uint8Array) => invoke(12, header, 32),
    indexHeaderLength: () => {
      const count = scalar(13, Uint8Array.of(0));
      if (count === 0 || count > 248) throw new Error("Native index codec returned invalid header transport");
      return count;
    },
    indexRequiresConversion: (header: Uint8Array) => boolean(14, header),
    shouldConvertJournal: (length: number) => {
      const bytes = new Uint8Array(8);
      new DataView(bytes.buffer).setFloat64(0, length, true);
      return boolean(15, bytes);
    },
    classifySource: (evidence: OverlayRecoveryEvidence) => {
      const bytes = new Uint8Array(32);
      const view = new DataView(bytes.buffer);
      let flags = ["none", "self", "unsealed", "sealed"].indexOf(evidence.source);
      if (evidence.hasDigest) flags |= 4;
      if (evidence.digestMatches !== undefined) flags |= 8;
      if (evidence.digestMatches) flags |= 16;
      if (evidence.verifiedPredecessor) flags |= 32;
      if (evidence.supersededPredecessor) flags |= 64;
      if (evidence.slotReused) flags |= 128;
      view.setUint32(0, flags, true);
      view.setFloat64(8, evidence.expectedLength ?? 0, true);
      view.setFloat64(16, evidence.observedLength ?? 0, true);
      view.setFloat64(24, evidence.unverifiedSealLength ?? 0, true);
      const verdict = ["eligible", "stale", "superseded", "unresolved", "verify-digest"] as const;
      const result = verdict[scalar(16, bytes)];
      if (result === undefined) throw new Error("Native recovery codec returned invalid verdict transport");
      return result;
    },
    encodeHeader: (record: OverlayGenerationSeal) => {
      const bytes = new Uint8Array(WIRE_BYTES);
      const view = new DataView(bytes.buffer);
      view.setFloat64(0, record.generation, true);
      view.setFloat64(8, record.journalLength, true);
      view.setFloat64(16, record.indexLength ?? 0, true);
      view.setFloat64(24, record.source?.journalLength ?? 0, true);
      let flags = record.indexLength === undefined ? 0 : 1;
      bytes.set(record.baseDigest.subarray(0, 32), 40);
      view.setUint32(128, Math.min(record.baseDigest.length, 0xffff_ffff), true);
      if (record.source !== undefined) {
        flags |= 2;
        const slot = typeof record.source.slot === "string" && record.source.slot.length <= 24
          ? new TextEncoder().encode(record.source.slot) : new Uint8Array();
        view.setUint32(36, slot.length, true);
        bytes.set(slot.subarray(0, 24), 104);
        if (record.source.journalDigest !== undefined) {
          flags |= 4;
          bytes.set(record.source.journalDigest.subarray(0, 32), 72);
          view.setUint32(132, Math.min(record.source.journalDigest.length, 0xffff_ffff), true);
        }
      }
      view.setUint32(32, flags, true);
      const result = invoke(4, bytes);
      if (result.length < 88 || result.length > 144) throw new Error("Native seal encoder returned invalid transport geometry");
      return result;
    },
    decodeHeader: (bytes: Uint8Array) => {
      const wire = invoke(5, bytes, WIRE_BYTES);
      const view = new DataView(wire.buffer, wire.byteOffset, wire.byteLength);
      const flags = view.getUint32(32, true);
      const result: OverlayGenerationSeal = { generation: view.getFloat64(0, true),
        journalLength: view.getFloat64(8, true), baseDigest: wire.slice(40, 72) };
      if (flags & 1) result.indexLength = view.getFloat64(16, true);
      if (flags & 2) {
        const length = view.getUint32(36, true);
        if (length > 24) throw new Error("Native seal decoder returned invalid slot transport");
        result.source = { slot: new TextDecoder().decode(wire.subarray(104, 104 + length)) as OverlaySealSourceSlot,
          journalLength: view.getFloat64(24, true), ...(flags & 4 ? { journalDigest: wire.slice(72, 104) } : {}) };
      }
      return result;
    },
    headerLength: (prefix: Uint8Array) => {
      const result = invoke(9, prefix, 4);
      const count = new DataView(result.buffer, result.byteOffset, result.byteLength).getUint32(0, true);
      if (count < 88 || count > 144) throw new Error("Native seal codec returned invalid header transport");
      return count;
    },
  });
}
