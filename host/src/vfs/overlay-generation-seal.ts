import type { PersistentOverlayStorage } from "./overlay-storage";

const MAGIC = [0x4b, 0x4f, 0x47, 0x53];
const VERSION = 1;
const INDEXED_VERSION = 2;
const CHUNK_BYTES = 1024 * 1024;
const HEADER_DATA_BYTES = 56;
const HEADER_BYTES = HEADER_DATA_BYTES + 32;
const INDEXED_HEADER_DATA_BYTES = 64;
const INDEXED_HEADER_BYTES = INDEXED_HEADER_DATA_BYTES + 32;
const DIGEST_BYTES = 32;

export interface OverlayGenerationSeal {
  generation: number;
  journalLength: number;
  baseDigest: Uint8Array;
  indexLength?: number;
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

async function digest(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer));
}

function chunkCount(length: number): number {
  return Math.ceil(length / CHUNK_BYTES);
}

async function header(
  generation: number,
  journalLength: number,
  baseDigest: Uint8Array,
  indexLength?: number,
): Promise<Uint8Array> {
  if (!validLength(generation) || !validLength(journalLength) || baseDigest.byteLength !== DIGEST_BYTES
    || (indexLength !== undefined && !validLength(indexLength))) {
    throw sealError();
  }
  const indexed = indexLength !== undefined;
  const headerDataBytes = indexed ? INDEXED_HEADER_DATA_BYTES : HEADER_DATA_BYTES;
  const bytes = new Uint8Array(indexed ? INDEXED_HEADER_BYTES : HEADER_BYTES);
  bytes.set(MAGIC);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, indexed ? INDEXED_VERSION : VERSION, true);
  view.setBigUint64(8, BigInt(generation), true);
  view.setBigUint64(16, BigInt(journalLength), true);
  bytes.set(baseDigest, 24);
  if (indexLength !== undefined) view.setBigUint64(56, BigInt(indexLength), true);
  bytes.set(await digest(bytes.subarray(0, headerDataBytes)), headerDataBytes);
  return bytes;
}

export async function writeOverlayGenerationSeal(
  journal: PersistentOverlayStorage,
  seal: PersistentOverlayStorage,
  generation: number,
  baseDigest: Uint8Array,
  index?: PersistentOverlayStorage,
): Promise<void> {
  journal.flush();
  index?.flush();
  const journalLength = journal.len();
  const indexLength = index?.len();
  const bytes = await header(generation, journalLength, baseDigest, indexLength);
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
    seal.writeAllAt(bytes.byteLength + chunkIndex * DIGEST_BYTES, await digest(chunk));
  }
  if (index !== undefined && indexLength !== undefined) {
    for (let chunkIndex = 0; chunkIndex < indexChunks; chunkIndex++) {
      const offset = chunkIndex * CHUNK_BYTES;
      const chunk = new Uint8Array(Math.min(CHUNK_BYTES, indexLength - offset));
      index.readExactAt(offset, chunk);
      seal.writeAllAt(bytes.byteLength + (journalChunks + chunkIndex) * DIGEST_BYTES, await digest(chunk));
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
  if (seal.len() < HEADER_BYTES) throw sealError();
  const prefix = new Uint8Array(8);
  seal.readExactAt(0, prefix);
  const version = new DataView(prefix.buffer).getUint32(4, true);
  if (version !== VERSION && version !== INDEXED_VERSION) throw sealError();
  const indexed = version === INDEXED_VERSION;
  const headerDataBytes = indexed ? INDEXED_HEADER_DATA_BYTES : HEADER_DATA_BYTES;
  const bytes = new Uint8Array(indexed ? INDEXED_HEADER_BYTES : HEADER_BYTES);
  if (seal.len() < bytes.byteLength) throw sealError();
  seal.readExactAt(0, bytes);
  const view = new DataView(bytes.buffer);
  const generation = Number(view.getBigUint64(8, true));
  const journalLength = Number(view.getBigUint64(16, true));
  const baseDigest = bytes.slice(24, HEADER_DATA_BYTES);
  const indexLength = indexed ? Number(view.getBigUint64(56, true)) : undefined;
  const invalidIndex = indexed && (
    indexLength === undefined || !validLength(indexLength) || index === null || index === undefined
    || index.len() !== indexLength
  );
  if (
    !sameBytes(bytes.subarray(0, 4), Uint8Array.from(MAGIC)) ||
    !validLength(generation) ||
    !validLength(journalLength) ||
    invalidIndex ||
    (allowAppendedTail ? journal.len() < journalLength : journal.len() !== journalLength) ||
    (expectedBaseDigest !== undefined && !sameBytes(baseDigest, expectedBaseDigest)) ||
    !sameBytes(bytes.subarray(headerDataBytes), await digest(bytes.subarray(0, headerDataBytes)))
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
    if (!sameBytes(expected, await digest(chunk))) throw sealError();
  }
  if (index !== null && index !== undefined && indexLength !== undefined) {
    for (let chunkIndex = 0; chunkIndex < indexChunks; chunkIndex++) {
      const offset = chunkIndex * CHUNK_BYTES;
      const chunk = new Uint8Array(Math.min(CHUNK_BYTES, indexLength - offset));
      index.readExactAt(offset, chunk);
      seal.readExactAt(bytes.byteLength + (journalChunks + chunkIndex) * DIGEST_BYTES, expected);
      if (!sameBytes(expected, await digest(chunk))) throw sealError();
    }
  }
  return indexLength === undefined
    ? { generation, journalLength, baseDigest }
    : { generation, journalLength, baseDigest, indexLength };
}
