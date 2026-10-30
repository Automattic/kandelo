import type { PersistentOverlayStorage } from "./overlay-storage";
import { InvalidOverlaySealError, OVERLAY_DIGEST_CHUNK_BYTES,
  type OverlaySealCodec, type OverlaySealSource, type OverlayGenerationSeal, type OverlayStorageHasher } from "./overlay-seal-codec";

export type { OverlaySealSourceSlot, OverlaySealSource, OverlayGenerationSeal } from "./overlay-seal-codec";

export function parseSealedGenerationSlot(value: string): `g${number}` | null {
  if (!/^g(?:0|[1-9][0-9]*)$/.test(value)) return null;
  const number = Number(value.slice(1));
  return Number.isSafeInteger(number + 1) ? value as `g${number}` : null;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

interface DigestWorkspace {
  readonly hash: OverlayStorageHasher;
  readonly scratch: Uint8Array;
}

function digestWorkspace(codec: OverlaySealCodec, length: number): DigestWorkspace {
  return { hash: codec.hasher(), scratch: new Uint8Array(Math.min(OVERLAY_DIGEST_CHUNK_BYTES, length)) };
}

function digestRange(codec: OverlaySealCodec, storage: PersistentOverlayStorage, start: number, length: number,
  workspace?: DigestWorkspace): Uint8Array {
  if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(length) || length <= 0
    || !Number.isSafeInteger(start + length)) throw new InvalidOverlaySealError();
  const { hash, scratch } = workspace ?? digestWorkspace(codec, length);
  hash.reset();
  for (let offset = 0; offset < length; offset += scratch.length) {
    const chunk = scratch.subarray(0, Math.min(scratch.length, length - offset));
    storage.readExactAt(start + offset, chunk);
    hash.update(chunk);
  }
  return hash.finish();
}

export function digestOverlayStoragePrefix(codec: OverlaySealCodec, storage: PersistentOverlayStorage, length: number): Uint8Array {
  return digestRange(codec, storage, 0, length);
}

export async function writeOverlayGenerationSeal(
  codec: OverlaySealCodec,
  journal: PersistentOverlayStorage,
  seal: PersistentOverlayStorage,
  generation: number,
  baseDigest: Uint8Array,
  index?: PersistentOverlayStorage,
  source?: OverlaySealSource,
): Promise<void> {
  writeOverlayGenerationSealSync(codec, journal, seal, generation, baseDigest, index, source);
}

export function writeOverlayGenerationSealSync(
  codec: OverlaySealCodec,
  journal: PersistentOverlayStorage,
  seal: PersistentOverlayStorage,
  generation: number,
  baseDigest: Uint8Array,
  index?: PersistentOverlayStorage,
  source?: OverlaySealSource,
): void {
  journal.flush();
  index?.flush();
  const record: OverlayGenerationSeal = { generation, journalLength: journal.len(), baseDigest,
    ...(index === undefined ? {} : { indexLength: index.len() }), ...(source === undefined ? {} : { source }) };
  const header = codec.encodeHeader(record);
  const layout = codec.layout(header);
  const workspace = digestWorkspace(codec, Math.max(record.journalLength, record.indexLength ?? 0));
  seal.truncate(0);
  seal.writeAllAt(0, header);
  let digestOffset = header.length;
  for (const [storage, length] of [[journal, record.journalLength], [index, record.indexLength]] as const) {
    if (storage === undefined || length === undefined) continue;
    for (let offset = 0; offset < length; offset += layout.chunkBytes) {
      seal.writeAllAt(digestOffset, digestRange(codec, storage, offset, Math.min(layout.chunkBytes, length - offset), workspace));
      digestOffset += layout.digestBytes;
    }
  }
  seal.flush();
}

export async function verifyOverlayGenerationSeal(
  codec: OverlaySealCodec,
  journal: PersistentOverlayStorage,
  seal: PersistentOverlayStorage,
  expectedBaseDigest?: Uint8Array,
  allowAppendedTail = false,
  index?: PersistentOverlayStorage | null,
): Promise<OverlayGenerationSeal> {
  return verifyOverlayGenerationSealSync(codec, journal, seal, expectedBaseDigest, allowAppendedTail, index);
}

export function verifyOverlayGenerationSealSync(
  codec: OverlaySealCodec,
  journal: PersistentOverlayStorage,
  seal: PersistentOverlayStorage,
  expectedBaseDigest?: Uint8Array,
  allowAppendedTail = false,
  index?: PersistentOverlayStorage | null,
): OverlayGenerationSeal {
  if (seal.len() < 8) throw new InvalidOverlaySealError();
  const prefix = new Uint8Array(8);
  seal.readExactAt(0, prefix);
  const headerLength = codec.headerLength(prefix);
  if (seal.len() < headerLength) throw new InvalidOverlaySealError();
  const header = new Uint8Array(headerLength);
  seal.readExactAt(0, header);
  const record = codec.decodeHeader(header);
  const layout = codec.layout(header);
  codec.verifyStorage(header, { journalLength: journal.len(),
    indexLength: record.indexLength === undefined || index === null || index === undefined ? undefined : index.len(),
    sealLength: seal.len(), expectedBaseDigest, allowAppendedTail });
  const expected = new Uint8Array(layout.digestBytes);
  const workspace = digestWorkspace(codec, Math.max(record.journalLength, record.indexLength ?? 0));
  let digestOffset = headerLength;
  for (const [storage, length] of [[journal, record.journalLength], [index, record.indexLength]] as const) {
    if (storage === undefined || storage === null || length === undefined) continue;
    for (let offset = 0; offset < length; offset += layout.chunkBytes) {
      seal.readExactAt(digestOffset, expected);
      if (!sameBytes(expected, digestRange(codec, storage, offset, Math.min(layout.chunkBytes, length - offset), workspace))) {
        throw new InvalidOverlaySealError();
      }
      digestOffset += layout.digestBytes;
    }
  }
  return record;
}
