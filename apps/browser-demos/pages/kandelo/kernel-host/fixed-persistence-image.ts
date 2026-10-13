import type { ImageOwnedRuntimeLazyAssets } from "../../../lib/init/image-owned-runtime-urls";
import type { ComposeImageResult } from "./image-composer";
import { parseKandeloDemoConfig } from "../../../../../web-libs/kandelo-session/src/demo-config";
import { parseExperimentalTerminalSession } from "../../../../../web-libs/kandelo-session/src/experimental-terminal-session";

const DIRECTORY_NAME = "kandelo-persistent-overlay";
const FORMAT_V1 = "kandelo-fixed-rootfs-image-v1";
const FORMAT_V2 = "kandelo-fixed-rootfs-image-v2";
const NAME_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
const CHUNK_BYTES = 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

type StoredComposition = Pick<
  ComposeImageResult,
  "imageConfig" | "profileId" | "terminalSession" | "requiredServices"
>;

interface ImageManifest {
  format: typeof FORMAT_V1 | typeof FORMAT_V2;
  identity: string;
  length: number;
  sha256?: string;
  imageFileName?: string;
  lazyAssets?: ImageOwnedRuntimeLazyAssets | null;
  lazyAssetsSha256?: string;
  chunkSha256?: string[];
  chunkSha256Digest?: string;
  composition?: StoredComposition;
  compositionSha256?: string;
}

interface FixedPersistenceImage {
  imageBytes: Uint8Array;
  lazyAssets?: ImageOwnedRuntimeLazyAssets;
  lazyAssetsRecorded: boolean;
}

export interface FixedPersistenceImageHandle {
  file: FileSystemFileHandle;
  imageFileName?: string;
  length: number;
  chunkSha256: readonly string[];
  lazyAssets?: ImageOwnedRuntimeLazyAssets;
  composition: StoredComposition;
}

export function assertFixedPersistenceBootAllowed(
  name: string,
  candidateEvidence: boolean,
  boot: { inputs?: readonly unknown[]; parameters?: { runScript?: unknown } },
): void {
  fileNames(name);
  if (candidateEvidence) {
    throw new Error("experimental persistence is unavailable for protected candidate boots");
  }
  if (boot.inputs?.length || boot.parameters?.runScript !== undefined) {
    throw new Error("experimental persistence refuses boot-link inputs and scripts");
  }
}

function fileNames(name: string): { image: string; manifest: string } {
  if (!NAME_PATTERN.test(name)) throw new Error("invalid experimental persistence name");
  return { image: `${name}.base`, manifest: `${name}.base.json` };
}

async function directory(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(DIRECTORY_NAME, { create: true });
}

async function existingFile(
  parent: FileSystemDirectoryHandle,
  name: string,
): Promise<FileSystemFileHandle | null> {
  try {
    return await parent.getFileHandle(name);
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return null;
    throw error;
  }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const input = bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes.buffer
    : bytes.slice().buffer;
  const digest = await crypto.subtle.digest("SHA-256", input);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function readSavedImage(
  parent: FileSystemDirectoryHandle,
  name: string,
  identity: string,
): Promise<{
  manifest: ImageManifest;
  imageFile: FileSystemFileHandle;
  lazyAssets?: ImageOwnedRuntimeLazyAssets;
  lazyAssetsRecorded: boolean;
  composition?: StoredComposition;
} | null> {
  const names = fileNames(name);
  const manifestFile = await existingFile(parent, names.manifest);
  if (manifestFile === null) {
    if (await existingFile(parent, names.image) === null) return null;
    throw new Error("experimental persistence base image is incomplete; refusing to boot");
  }
  let manifest: ImageManifest;
  try {
    manifest = JSON.parse(await (await manifestFile.getFile()).text()) as ImageManifest;
  } catch {
    throw new Error("experimental persistence base image manifest is invalid");
  }
  if (
    (manifest?.format !== FORMAT_V1 && manifest?.format !== FORMAT_V2) ||
    manifest.identity !== identity ||
    !Number.isSafeInteger(manifest.length) ||
    manifest.length <= 0 ||
    (manifest.format === FORMAT_V1 && !SHA256_PATTERN.test(manifest.sha256 ?? "")) ||
    (manifest.format === FORMAT_V2 && (
      manifest.sha256 !== undefined ||
      typeof manifest.imageFileName !== "string" ||
      !new RegExp(`^${name}\\.[0-9a-f-]{36}\\.base$`).test(manifest.imageFileName)
    ))
  ) {
    throw new Error("experimental persistence base image belongs to a different computer");
  }
  const imageFile = await existingFile(
    parent,
    manifest.format === FORMAT_V2 ? manifest.imageFileName! : names.image,
  );
  if (imageFile === null) {
    throw new Error("experimental persistence base image is incomplete; refusing to boot");
  }
  const lazyAssetsRecorded = Object.hasOwn(manifest, "lazyAssets");
  const lazyAssets = parseLazyAssets(manifest.lazyAssets);
  if (lazyAssetsRecorded) {
    if (
      !SHA256_PATTERN.test(manifest.lazyAssetsSha256 ?? "") ||
      await sha256(new TextEncoder().encode(JSON.stringify(manifest.lazyAssets))) !==
        manifest.lazyAssetsSha256
    ) {
      throw new Error("experimental persistence base image manifest is damaged");
    }
  } else if (manifest.lazyAssetsSha256 !== undefined) {
    throw new Error("experimental persistence base image manifest is invalid");
  }
  if (manifest.chunkSha256 !== undefined) {
    if (
      !Array.isArray(manifest.chunkSha256) ||
      manifest.chunkSha256.length !== Math.ceil(manifest.length / CHUNK_BYTES) ||
      !manifest.chunkSha256.every((digest) => typeof digest === "string" && SHA256_PATTERN.test(digest)) ||
      !SHA256_PATTERN.test(manifest.chunkSha256Digest ?? "") ||
      await sha256(new TextEncoder().encode(JSON.stringify(manifest.chunkSha256))) !==
        manifest.chunkSha256Digest
    ) {
      throw new Error("experimental persistence base image manifest is damaged");
    }
  } else if (manifest.chunkSha256Digest !== undefined) {
    throw new Error("experimental persistence base image manifest is invalid");
  }
  let composition: StoredComposition | undefined;
  if (manifest.composition !== undefined) {
    if (
      !SHA256_PATTERN.test(manifest.compositionSha256 ?? "") ||
      await sha256(new TextEncoder().encode(JSON.stringify(manifest.composition))) !==
        manifest.compositionSha256
    ) {
      throw new Error("experimental persistence base image manifest is damaged");
    }
    composition = parseComposition(manifest.composition);
  } else if (manifest.compositionSha256 !== undefined) {
    throw new Error("experimental persistence base image manifest is invalid");
  }
  if (
    manifest.format === FORMAT_V2 &&
    (manifest.chunkSha256 === undefined || composition === undefined || !lazyAssetsRecorded)
  ) {
    throw new Error("experimental persistence base image manifest is invalid");
  }
  if ((await imageFile.getFile()).size !== manifest.length) {
    throw new Error("experimental persistence base image is damaged; refusing to boot");
  }
  return { manifest, imageFile, lazyAssets, lazyAssetsRecorded, composition };
}

async function readImage(
  parent: FileSystemDirectoryHandle,
  name: string,
  identity: string,
): Promise<FixedPersistenceImage | null> {
  const saved = await readSavedImage(parent, name, identity);
  if (saved === null) return null;
  const { manifest, imageFile, lazyAssets, lazyAssetsRecorded } = saved;
  if (manifest.format === FORMAT_V2) {
    throw new Error("experimental persistence image requires positioned OPFS loading");
  }
  const bytes = new Uint8Array(await (await imageFile.getFile()).arrayBuffer());
  if (bytes.byteLength !== manifest.length || await sha256(bytes) !== manifest.sha256) {
    throw new Error("experimental persistence base image is damaged; refusing to boot");
  }
  return {
    imageBytes: bytes,
    lazyAssets,
    lazyAssetsRecorded,
  };
}

function parseComposition(value: unknown): StoredComposition {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("experimental persistence base image composition is invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 4 ||
    typeof record.profileId !== "string" ||
    !Array.isArray(record.requiredServices) ||
    !record.requiredServices.every((service) => typeof service === "string")
  ) {
    throw new Error("experimental persistence base image composition is invalid");
  }
  try {
    const imageConfig = parseKandeloDemoConfig(JSON.stringify(record.imageConfig));
    if (imageConfig === null) throw new Error("invalid demo config");
    const terminalSession = parseExperimentalTerminalSession(JSON.stringify(record.terminalSession));
    return {
      imageConfig,
      profileId: record.profileId,
      terminalSession,
      requiredServices: record.requiredServices as string[],
    };
  } catch {
    throw new Error("experimental persistence base image composition is invalid");
  }
}

function parseLazyAssets(value: unknown): ImageOwnedRuntimeLazyAssets | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("experimental persistence base image manifest is invalid");
  }
  const assets = value as Record<string, unknown>;
  if (
    Object.keys(assets).length !== 3 ||
    typeof assets.deploymentBase !== "string" ||
    typeof assets.directoryUrl !== "string" ||
    typeof assets.manifestUrl !== "string"
  ) {
    throw new Error("experimental persistence base image manifest is invalid");
  }
  return {
    deploymentBase: assets.deploymentBase,
    directoryUrl: assets.directoryUrl,
    manifestUrl: assets.manifestUrl,
  };
}

async function locked<T>(name: string, operation: () => Promise<T>): Promise<T> {
  if (!navigator.locks) throw new Error("experimental persistence requires Web Locks");
  return navigator.locks.request(`kandelo-fixed-rootfs-${name}`, { mode: "exclusive" }, operation);
}

export async function loadFixedPersistenceImage(
  name: string,
  identity: string,
): Promise<FixedPersistenceImage | null> {
  fileNames(name);
  return locked(name, async () => readImage(await directory(), name, identity));
}

export async function loadFixedPersistenceImageHandle(
  name: string,
  identity: string,
): Promise<FixedPersistenceImageHandle | null> {
  fileNames(name);
  return locked(name, async () => {
    const saved = await readSavedImage(await directory(), name, identity);
    if (
      saved === null ||
      saved.manifest.chunkSha256 === undefined ||
      saved.composition === undefined ||
      !saved.lazyAssetsRecorded
    ) return null;
    return {
      file: saved.imageFile,
      length: saved.manifest.length,
      chunkSha256: saved.manifest.chunkSha256,
      lazyAssets: saved.lazyAssets,
      composition: saved.composition,
    };
  });
}

export async function saveFixedPersistenceImage(
  name: string,
  identity: string,
  proposed: Uint8Array,
  lazyAssets?: ImageOwnedRuntimeLazyAssets,
  composition?: StoredComposition,
): Promise<FixedPersistenceImage> {
  fileNames(name);
  return locked(name, async () => {
    const parent = await directory();
    const existing = await readSavedImage(parent, name, identity);
    if (existing !== null) {
      throw new Error("experimental persistence was initialized concurrently; restart the computer");
    }
    if (proposed.byteLength === 0) throw new Error("cannot persist an empty base image");
    const names = fileNames(name);
    const imageFile = await parent.getFileHandle(names.image, { create: true });
    const writer = await imageFile.createWritable();
    try {
      for (let offset = 0; offset < proposed.byteLength; offset += CHUNK_BYTES) {
        await writer.write({
          type: "write",
          position: offset,
          data: proposed.slice(offset, offset + CHUNK_BYTES),
        });
      }
      await writer.close();
    } catch (error) {
      await writer.abort().catch(() => {});
      throw error;
    }
    const manifest: ImageManifest = {
      format: FORMAT_V1,
      identity,
      length: proposed.byteLength,
      sha256: await sha256(proposed),
      lazyAssets: lazyAssets === undefined ? null : { ...lazyAssets },
    };
    manifest.chunkSha256 = [];
    for (let offset = 0; offset < proposed.byteLength; offset += CHUNK_BYTES) {
      manifest.chunkSha256.push(await sha256(proposed.subarray(offset, offset + CHUNK_BYTES)));
    }
    manifest.chunkSha256Digest = await sha256(
      new TextEncoder().encode(JSON.stringify(manifest.chunkSha256)),
    );
    if (composition !== undefined) {
      manifest.composition = { ...composition };
      manifest.compositionSha256 = await sha256(
        new TextEncoder().encode(JSON.stringify(manifest.composition)),
      );
    }
    manifest.lazyAssetsSha256 = await sha256(
      new TextEncoder().encode(JSON.stringify(manifest.lazyAssets)),
    );
    const manifestFile = await parent.getFileHandle(names.manifest, { create: true });
    const manifestWriter = await manifestFile.createWritable();
    try {
      await manifestWriter.write(JSON.stringify(manifest));
      await manifestWriter.close();
    } catch (error) {
      await manifestWriter.abort().catch(() => {});
      throw error;
    }
    const verified = await readImage(parent, name, identity);
    if (verified === null) throw new Error("experimental persistence base image disappeared");
    return verified;
  });
}

async function writeFixedPersistenceImageStream(
  name: string,
  identity: string,
  chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  lazyAssets: ImageOwnedRuntimeLazyAssets | undefined,
  composition: StoredComposition,
  publish: boolean,
  onProgress?: (message: string) => void,
): Promise<FixedPersistenceImageHandle> {
  fileNames(name);
  onProgress?.("persistent image requesting lock");
  return locked(name, async () => {
    onProgress?.("persistent image lock acquired");
    const parent = await directory();
    onProgress?.("persistent image directory opened");
    if (await readSavedImage(parent, name, identity) !== null) {
      throw new Error("experimental persistence was initialized concurrently; restart the computer");
    }
    onProgress?.("persistent image absence checked");
    const imageFileName = `${name}.${crypto.randomUUID()}.base`;
    const imageFile = await parent.getFileHandle(imageFileName, { create: true });
    onProgress?.("persistent image file opened");
    let retained = false;
    try {
      const chunkSha256: string[] = [];
      let length = 0;
      const pending = new Uint8Array(CHUNK_BYTES);
      let pendingLength = 0;
      const writer = await imageFile.createWritable();
      onProgress?.("persistent image writer opened");
      try {
        for await (const chunk of chunks) {
          if (
            chunk.byteLength === 0 ||
            !Number.isSafeInteger(length + pendingLength + chunk.byteLength)
          ) {
            throw new Error("experimental persistence image stream has invalid chunks");
          }
          let offset = 0;
          while (offset < chunk.byteLength) {
            const count = Math.min(CHUNK_BYTES - pendingLength, chunk.byteLength - offset);
            pending.set(chunk.subarray(offset, offset + count), pendingLength);
            pendingLength += count;
            offset += count;
            if (pendingLength === CHUNK_BYTES) {
              await writer.write({ type: "write", position: length, data: pending.slice() });
              chunkSha256.push(await sha256(pending));
              length += CHUNK_BYTES;
              pendingLength = 0;
            }
          }
        }
        if (pendingLength > 0) {
          const last = pending.slice(0, pendingLength);
          await writer.write({ type: "write", position: length, data: last });
          chunkSha256.push(await sha256(last));
          length += pendingLength;
        }
        if (length === 0) throw new Error("cannot persist an empty base image");
        await writer.close();
        onProgress?.("persistent image writer closed");
      } catch (error) {
        await writer.abort().catch(() => {});
        throw error;
      }
      const snapshot = await imageFile.getFile();
      onProgress?.("persistent image readback opened");
      if (snapshot.size !== length) {
        throw new Error("experimental persistence image write was incomplete");
      }
      for (let index = 0; index < chunkSha256.length; index++) {
        const start = index * CHUNK_BYTES;
        const bytes = new Uint8Array(await snapshot.slice(start, start + CHUNK_BYTES).arrayBuffer());
        if (await sha256(bytes) !== chunkSha256[index]) {
          throw new Error("experimental persistence image write verification failed");
        }
      }
      onProgress?.("persistent image readback verified");
      const result: FixedPersistenceImageHandle = {
        file: imageFile,
        imageFileName,
        length,
        chunkSha256,
        lazyAssets,
        composition,
      };
      if (publish) await publishImage(parent, name, identity, result);
      retained = true;
      return result;
    } finally {
      if (!retained) await parent.removeEntry(imageFileName).catch(() => {});
    }
  });
}

async function publishImage(
  parent: FileSystemDirectoryHandle,
  name: string,
  identity: string,
  staged: FixedPersistenceImageHandle,
  assertCurrent?: () => void,
): Promise<void> {
  const names = fileNames(name);
  if (await readSavedImage(parent, name, identity) !== null) {
    throw new Error("experimental persistence was initialized concurrently; restart the computer");
  }
  const imageFileName = staged.imageFileName;
  if (
    imageFileName === undefined ||
    !new RegExp(`^${name}\\.[0-9a-f-]{36}\\.base$`).test(imageFileName) ||
    !(await (await parent.getFileHandle(imageFileName)).isSameEntry(staged.file))
  ) {
    throw new Error("experimental persistence staged image is invalid");
  }
  const snapshot = await staged.file.getFile();
  if (snapshot.size !== staged.length || staged.chunkSha256.length !== Math.ceil(staged.length / CHUNK_BYTES)) {
    throw new Error("experimental persistence staged image is damaged");
  }
  for (let index = 0; index < staged.chunkSha256.length; index++) {
    const start = index * CHUNK_BYTES;
    const bytes = new Uint8Array(await snapshot.slice(start, start + CHUNK_BYTES).arrayBuffer());
    if (await sha256(bytes) !== staged.chunkSha256[index]) {
      throw new Error("experimental persistence staged image is damaged");
    }
  }
  const savedLazyAssets = staged.lazyAssets === undefined ? null : { ...staged.lazyAssets };
  const savedComposition = { ...staged.composition };
  const manifest: ImageManifest = {
    format: FORMAT_V2,
    identity,
    imageFileName,
    length: staged.length,
    lazyAssets: savedLazyAssets,
    lazyAssetsSha256: await sha256(new TextEncoder().encode(JSON.stringify(savedLazyAssets))),
    chunkSha256: [...staged.chunkSha256],
    chunkSha256Digest: await sha256(new TextEncoder().encode(JSON.stringify(staged.chunkSha256))),
    composition: savedComposition,
    compositionSha256: await sha256(new TextEncoder().encode(JSON.stringify(savedComposition))),
  };
  assertCurrent?.();
  const manifestFile = await parent.getFileHandle(names.manifest, { create: true });
  const writer = await manifestFile.createWritable();
  try {
    await writer.write(JSON.stringify(manifest));
    assertCurrent?.();
    await writer.close();
    try {
      assertCurrent?.();
    } catch (error) {
      await parent.removeEntry(names.manifest).catch(() => {});
      throw error;
    }
  } catch (error) {
    await writer.abort().catch(() => {});
    await parent.removeEntry(names.manifest).catch(() => {});
    throw error;
  }
}

export async function saveFixedPersistenceImageStream(
  name: string,
  identity: string,
  chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  lazyAssets: ImageOwnedRuntimeLazyAssets | undefined,
  composition: StoredComposition,
): Promise<FixedPersistenceImageHandle> {
  return writeFixedPersistenceImageStream(name, identity, chunks, lazyAssets, composition, true);
}

export async function stageFixedPersistenceImageStream(
  name: string,
  identity: string,
  chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  lazyAssets: ImageOwnedRuntimeLazyAssets | undefined,
  composition: StoredComposition,
  onProgress?: (message: string) => void,
): Promise<FixedPersistenceImageHandle> {
  return writeFixedPersistenceImageStream(name, identity, chunks, lazyAssets, composition, false, onProgress);
}

export async function publishFixedPersistenceImage(
  name: string,
  identity: string,
  staged: FixedPersistenceImageHandle,
  assertCurrent?: () => void,
): Promise<void> {
  return locked(name, async () => publishImage(await directory(), name, identity, staged, assertCurrent));
}

export async function discardStagedFixedPersistenceImage(
  name: string,
  identity: string,
  staged: FixedPersistenceImageHandle,
): Promise<void> {
  fileNames(name);
  const imageFileName = staged.imageFileName;
  if (imageFileName === undefined || !new RegExp(`^${name}\\.[0-9a-f-]{36}\\.base$`).test(imageFileName)) {
    return;
  }
  await locked(name, async () => {
    const parent = await directory();
    const saved = await readSavedImage(parent, name, identity);
    if (saved !== null && await saved.imageFile.isSameEntry(staged.file)) return;
    const current = await existingFile(parent, imageFileName);
    if (current !== null && await current.isSameEntry(staged.file)) {
      await parent.removeEntry(imageFileName);
    }
  });
}
