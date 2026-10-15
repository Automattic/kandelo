import { sha256 } from "@noble/hashes/sha2.js";
import type { PersistentOverlayStorage } from "./overlay-storage";

const MAGIC = [0x4b, 0x4f, 0x47, 0x53];
const VERSION = 1;
const INDEXED_VERSION = 2;
const SOURCE_BOUND_VERSION = 3;
const CHUNK_BYTES = 1024 * 1024;
const HEADER_DATA_BYTES = 56;
const HEADER_BYTES = HEADER_DATA_BYTES + 32;
const INDEXED_HEADER_DATA_BYTES = 64;
const SOURCE_BOUND_HEADER_DATA_BYTES = 80;
const DIGEST_BYTES = 32;
const SOURCE_SLOTS = ["legacy", "g0", "g1", "g2"] as const;

export type OverlaySealSourceSlot = "legacy" | "g0" | "g1" | "g2";

export interface OverlaySealSource {
  slot: OverlaySealSourceSlot;
  journalLength: number;
}

export interface OverlayGenerationSeal {
  generation: number;
  journalLength: number;
  baseDigest: Uint8Array;
  indexLength?: number;
  source?: OverlaySealSource;
}

function sealError(): Error {
  return new Error("persistent overlay generation seal is invalid");
}

function validLength(length: number): boolean {
  return Number.isSafeInteger(length) && length > 0;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index++) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function digest(bytes: Uint8Array): Uint8Array {
  return sha256(bytes);
}

function chunkCount(length: number): number {
  return Math.ceil(length / CHUNK_BYTES);
}

function header(
  generation: number,
  journalLength: number,
  baseDigest: Uint8Array,
  indexLength?: number,
  source?: OverlaySealSource,
): Uint8Array {
  if (!validLength(generation) || !validLength(journalLength) || baseDigest.byteLength !== DIGEST_BYTES
    || (indexLength !== undefined && !validLength(indexLength))
    || (source !== undefined && (indexLength === undefined || !validLength(source.journalLength)
      || !SOURCE_SLOTS.includes(source.slot)
      || (source.slot === "legacy") !== (generation === 1)))) {
    throw sealError();
  }
  const indexed = indexLength !== undefined;
  const headerDataBytes = source !== undefined
    ? SOURCE_BOUND_HEADER_DATA_BYTES
    : indexed ? INDEXED_HEADER_DATA_BYTES : HEADER_DATA_BYTES;
  const bytes = new Uint8Array(headerDataBytes + DIGEST_BYTES);
  bytes.set(MAGIC);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, source !== undefined ? SOURCE_BOUND_VERSION : indexed ? INDEXED_VERSION : VERSION, true);
  view.setBigUint64(8, BigInt(generation), true);
  view.setBigUint64(16, BigInt(journalLength), true);
  bytes.set(baseDigest, 24);
  if (indexLength !== undefined) view.setBigUint64(56, BigInt(indexLength), true);
  if (source !== undefined) {
    view.setBigUint64(64, BigInt(source.journalLength), true);
    view.setBigUint64(72, BigInt(SOURCE_SLOTS.indexOf(source.slot)), true);
  }
  bytes.set(digest(bytes.subarray(0, headerDataBytes)), headerDataBytes);
  return bytes;
}

export async function writeOverlayGenerationSeal(
  journal: PersistentOverlayStorage,
  seal: PersistentOverlayStorage,
  generation: number,
  baseDigest: Uint8Array,
  index?: PersistentOverlayStorage,
  source?: OverlaySealSource,
): Promise<void> {
  writeOverlayGenerationSealSync(journal, seal, generation, baseDigest, index, source);
}

export function writeOverlayGenerationSealSync(
  journal: PersistentOverlayStorage,
  seal: PersistentOverlayStorage,
  generation: number,
  baseDigest: Uint8Array,
  index?: PersistentOverlayStorage,
  source?: OverlaySealSource,
): void {
  journal.flush();
  index?.flush();
  const journalLength = journal.len();
  const indexLength = index?.len();
  const bytes = header(generation, journalLength, baseDigest, indexLength, source);
  const journalChunks = chunkCount(journalLength);
  const indexChunks = indexLength === undefined ? 0 : chunkCount(indexLength);
  const sealLength = bytes.byteLength + (journalChunks + indexChunks) * DIGEST_BYTES;
  if (!Number.isSafeInteger(sealLength)) throw sealError();
  seal.truncate(0);
  seal.writeAllAt(0, bytes);
  for (let chunkIndex = 0; chunkIndex < journalChunks; chunkIndex++) {
    const offset = chunkIndex * CHUNK_BYTES;
    const chunk = new Uint8Array(Math.min(CHUNK_BYTES, journalLength - offset));
    journal.readExactAt(offset, chunk);
    seal.writeAllAt(bytes.byteLength + chunkIndex * DIGEST_BYTES, digest(chunk));
  }
  if (index !== undefined && indexLength !== undefined) {
    for (let chunkIndex = 0; chunkIndex < indexChunks; chunkIndex++) {
      const offset = chunkIndex * CHUNK_BYTES;
      const chunk = new Uint8Array(Math.min(CHUNK_BYTES, indexLength - offset));
      index.readExactAt(offset, chunk);
      seal.writeAllAt(bytes.byteLength + (journalChunks + chunkIndex) * DIGEST_BYTES, digest(chunk));
    }
  }
  seal.flush();
}

export async function verifyOverlayGenerationSeal(
  journal: PersistentOverlayStorage,
  seal: PersistentOverlayStorage,
  expectedBaseDigest?: Uint8Array,
  allowAppendedTail = false,
  index?: PersistentOverlayStorage | null,
): Promise<OverlayGenerationSeal> {
  return verifyOverlayGenerationSealSync(journal, seal, expectedBaseDigest, allowAppendedTail, index);
}

export function verifyOverlayGenerationSealSync(
  journal: PersistentOverlayStorage,
  seal: PersistentOverlayStorage,
  expectedBaseDigest?: Uint8Array,
  allowAppendedTail = false,
  index?: PersistentOverlayStorage | null,
): OverlayGenerationSeal {
  if (seal.len() < HEADER_BYTES) throw sealError();
  const prefix = new Uint8Array(8);
  seal.readExactAt(0, prefix);
  const version = new DataView(prefix.buffer).getUint32(4, true);
  if (version !== VERSION && version !== INDEXED_VERSION && version !== SOURCE_BOUND_VERSION) throw sealError();
  const indexed = version !== VERSION;
  const headerDataBytes = version === SOURCE_BOUND_VERSION
    ? SOURCE_BOUND_HEADER_DATA_BYTES
    : indexed ? INDEXED_HEADER_DATA_BYTES : HEADER_DATA_BYTES;
  const bytes = new Uint8Array(headerDataBytes + DIGEST_BYTES);
  if (seal.len() < bytes.byteLength) throw sealError();
  seal.readExactAt(0, bytes);
  const view = new DataView(bytes.buffer);
  const generation = Number(view.getBigUint64(8, true));
  const journalLength = Number(view.getBigUint64(16, true));
  const baseDigest = bytes.slice(24, HEADER_DATA_BYTES);
  const indexLength = indexed ? Number(view.getBigUint64(56, true)) : undefined;
  const sourceSlotNumber = version === SOURCE_BOUND_VERSION ? Number(view.getBigUint64(72, true)) : undefined;
  const sourceSlot = sourceSlotNumber === undefined ? undefined : SOURCE_SLOTS[sourceSlotNumber];
  const sourceLength = version === SOURCE_BOUND_VERSION ? Number(view.getBigUint64(64, true)) : undefined;
  const invalidIndex = indexed && (
    indexLength === undefined || !validLength(indexLength) || index === null || index === undefined
    || index.len() !== indexLength
  );
  if (
    !sameBytes(bytes.subarray(0, 4), Uint8Array.from(MAGIC)) ||
    !validLength(generation) ||
    !validLength(journalLength) ||
    invalidIndex ||
    (version === SOURCE_BOUND_VERSION && (sourceSlot === undefined || sourceLength === undefined
      || !validLength(sourceLength) || (sourceSlot === "legacy") !== (generation === 1))) ||
    (allowAppendedTail ? journal.len() < journalLength : journal.len() !== journalLength) ||
    (expectedBaseDigest !== undefined && !sameBytes(baseDigest, expectedBaseDigest)) ||
    !sameBytes(bytes.subarray(headerDataBytes), digest(bytes.subarray(0, headerDataBytes)))
  ) {
    throw sealError();
  }
  const journalChunks = chunkCount(journalLength);
  const indexChunks = indexLength === undefined ? 0 : chunkCount(indexLength);
  const sealLength = bytes.byteLength + (journalChunks + indexChunks) * DIGEST_BYTES;
  if (!Number.isSafeInteger(sealLength) || seal.len() !== sealLength) throw sealError();
  const expected = new Uint8Array(DIGEST_BYTES);
  for (let chunkIndex = 0; chunkIndex < journalChunks; chunkIndex++) {
    const offset = chunkIndex * CHUNK_BYTES;
    const chunk = new Uint8Array(Math.min(CHUNK_BYTES, journalLength - offset));
    journal.readExactAt(offset, chunk);
    seal.readExactAt(bytes.byteLength + chunkIndex * DIGEST_BYTES, expected);
    if (!sameBytes(expected, digest(chunk))) throw sealError();
  }
  if (index !== null && index !== undefined && indexLength !== undefined) {
    for (let chunkIndex = 0; chunkIndex < indexChunks; chunkIndex++) {
      const offset = chunkIndex * CHUNK_BYTES;
      const chunk = new Uint8Array(Math.min(CHUNK_BYTES, indexLength - offset));
      index.readExactAt(offset, chunk);
      seal.readExactAt(bytes.byteLength + (journalChunks + chunkIndex) * DIGEST_BYTES, expected);
      if (!sameBytes(expected, digest(chunk))) throw sealError();
    }
  }
  if (sourceSlot !== undefined && sourceLength !== undefined && indexLength !== undefined) {
    return { generation, journalLength, baseDigest, indexLength, source: { slot: sourceSlot, journalLength: sourceLength } };
  }
  return indexLength === undefined
    ? { generation, journalLength, baseDigest }
    : { generation, journalLength, baseDigest, indexLength };
}
