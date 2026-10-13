import type { PersistentOverlayStorage } from "./overlay-storage";

const MAGIC = [0x4b, 0x4f, 0x47, 0x53];
const VERSION = 1;
const CHUNK_BYTES = 1024 * 1024;
const HEADER_DATA_BYTES = 56;
const HEADER_BYTES = HEADER_DATA_BYTES + 32;
const DIGEST_BYTES = 32;

export interface OverlayGenerationSeal {
  generation: number;
  journalLength: number;
  baseDigest: Uint8Array;
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

async function header(generation: number, journalLength: number, baseDigest: Uint8Array): Promise<Uint8Array> {
  if (!validLength(generation) || !validLength(journalLength) || baseDigest.byteLength !== DIGEST_BYTES) {
    throw sealError();
  }
  const bytes = new Uint8Array(HEADER_BYTES);
  bytes.set(MAGIC);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, VERSION, true);
  view.setBigUint64(8, BigInt(generation), true);
  view.setBigUint64(16, BigInt(journalLength), true);
  bytes.set(baseDigest, 24);
  bytes.set(await digest(bytes.subarray(0, HEADER_DATA_BYTES)), HEADER_DATA_BYTES);
  return bytes;
}

export async function writeOverlayGenerationSeal(
  journal: PersistentOverlayStorage,
  seal: PersistentOverlayStorage,
  generation: number,
  baseDigest: Uint8Array,
): Promise<void> {
  journal.flush();
  const journalLength = journal.len();
  const bytes = await header(generation, journalLength, baseDigest);
  const count = chunkCount(journalLength);
  const sealLength = HEADER_BYTES + count * DIGEST_BYTES;
  if (!Number.isSafeInteger(sealLength)) throw sealError();
  seal.truncate(0);
  seal.writeAllAt(0, bytes);
  for (let index = 0; index < count; index++) {
    const offset = index * CHUNK_BYTES;
    const chunk = new Uint8Array(Math.min(CHUNK_BYTES, journalLength - offset));
    journal.readExactAt(offset, chunk);
    seal.writeAllAt(HEADER_BYTES + index * DIGEST_BYTES, await digest(chunk));
  }
  seal.flush();
}

export async function verifyOverlayGenerationSeal(
  journal: PersistentOverlayStorage,
  seal: PersistentOverlayStorage,
  expectedBaseDigest?: Uint8Array,
  allowAppendedTail = false,
): Promise<OverlayGenerationSeal> {
  const bytes = new Uint8Array(HEADER_BYTES);
  if (seal.len() < HEADER_BYTES) throw sealError();
  seal.readExactAt(0, bytes);
  const view = new DataView(bytes.buffer);
  const generation = Number(view.getBigUint64(8, true));
  const journalLength = Number(view.getBigUint64(16, true));
  const baseDigest = bytes.slice(24, HEADER_DATA_BYTES);
  if (
    !sameBytes(bytes.subarray(0, 4), Uint8Array.from(MAGIC)) ||
    view.getUint32(4, true) !== VERSION ||
    !validLength(generation) ||
    !validLength(journalLength) ||
    (allowAppendedTail ? journal.len() < journalLength : journal.len() !== journalLength) ||
    (expectedBaseDigest !== undefined && !sameBytes(baseDigest, expectedBaseDigest)) ||
    !sameBytes(bytes.subarray(HEADER_DATA_BYTES), await digest(bytes.subarray(0, HEADER_DATA_BYTES)))
  ) {
    throw sealError();
  }
  const count = chunkCount(journalLength);
  const sealLength = HEADER_BYTES + count * DIGEST_BYTES;
  if (!Number.isSafeInteger(sealLength) || seal.len() !== sealLength) throw sealError();
  const expected = new Uint8Array(DIGEST_BYTES);
  for (let index = 0; index < count; index++) {
    const offset = index * CHUNK_BYTES;
    const chunk = new Uint8Array(Math.min(CHUNK_BYTES, journalLength - offset));
    journal.readExactAt(offset, chunk);
    seal.readExactAt(HEADER_BYTES + index * DIGEST_BYTES, expected);
    if (!sameBytes(expected, await digest(chunk))) throw sealError();
  }
  return { generation, journalLength, baseDigest };
}
