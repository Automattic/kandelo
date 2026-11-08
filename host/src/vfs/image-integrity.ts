export const IMAGE_INTEGRITY_CHUNK_BYTES = 1024 * 1024;

export interface PersistentImageReadBinding {
  readonly identitySha256: string;
  readonly dataCachePages: number;
  readonly indexCachePages: number;
}

export function snapshotPersistentImageReadBinding(value: unknown): PersistentImageReadBinding {
  if (typeof value !== "object" || value === null) throw new Error("Persistent image binding must be an object");
  const candidate = value as Partial<PersistentImageReadBinding>;
  const { identitySha256, dataCachePages, indexCachePages } = candidate;
  if (typeof identitySha256 !== "string" || !/^[0-9a-f]{64}$/.test(identitySha256)
    || !Number.isSafeInteger(dataCachePages) || dataCachePages! < 0 || dataCachePages! > 64
    || !Number.isSafeInteger(indexCachePages) || indexCachePages! < 0 || indexCachePages! > 64
    || (dataCachePages === 0) !== (indexCachePages === 0)) {
    throw new Error("Persistent image binding or cache budget is invalid");
  }
  return Object.freeze({ identitySha256, dataCachePages: dataCachePages!, indexCachePages: indexCachePages! });
}

export function persistentImageIdentityWords(identitySha256: string): readonly number[] {
  if (!/^[0-9a-f]{64}$/.test(identitySha256)) throw new Error("Persistent image identity must be a SHA-256 digest");
  const bytes = new Uint8Array(32);
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number.parseInt(identitySha256.slice(index * 2, index * 2 + 2), 16);
  }
  const view = new DataView(bytes.buffer);
  return Array.from({ length: 8 }, (_, index) => view.getUint32(index * 4, true));
}

export type OpfsImageIntegrity = {
  length: number;
  chunkBytes: number;
} & ({
  imageSha256: string;
  chunkSha256?: never;
} | {
  imageSha256?: never;
  chunkSha256: readonly string[];
});

export function isOpfsImageIntegrity(value: unknown): value is OpfsImageIntegrity {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<OpfsImageIntegrity>;
  if (!Number.isSafeInteger(candidate.length) || candidate.length! <= 0
    || !Number.isSafeInteger(candidate.chunkBytes) || candidate.chunkBytes! <= 0
    || candidate.chunkBytes! > IMAGE_INTEGRITY_CHUNK_BYTES) return false;
  if (candidate.imageSha256 !== undefined) {
    return typeof candidate.imageSha256 === "string"
      && /^[0-9a-f]{64}$/.test(candidate.imageSha256)
      && candidate.chunkSha256 === undefined;
  }
  return Array.isArray(candidate.chunkSha256)
    && candidate.chunkSha256.length === Math.ceil(candidate.length! / candidate.chunkBytes!)
    && candidate.chunkSha256.every(digest => typeof digest === "string" && /^[0-9a-f]{64}$/.test(digest));
}
