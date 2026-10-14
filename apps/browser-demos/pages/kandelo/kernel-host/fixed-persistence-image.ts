import type { ImageOwnedRuntimeLazyAssets } from "../../../lib/init/image-owned-runtime-urls";
import type { ComposeImageResult } from "./image-composer";
import type { OpfsImageIntegrity } from "../../../../../host/src/vfs/opfs-image-reader";
import { sha256 as incrementalSha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { parseKandeloDemoConfig } from "../../../../../web-libs/kandelo-session/src/demo-config";
import { parseExperimentalTerminalSession } from "../../../../../web-libs/kandelo-session/src/experimental-terminal-session";
import { acquireBrowserPersistenceComputerLease, type BrowserPersistenceComputerLease } from "../../../../../host/src/browser-persistence-computer-lease";
import { browserPersistenceJournalLockName, withIdleBrowserPersistenceJournals } from "../../../../../host/src/browser-persistence-journal-lease";

const DIRECTORY_NAME = "kandelo-persistent-overlay";
const FORMAT_V1 = "kandelo-fixed-rootfs-image-v1";
const FORMAT_V2 = "kandelo-fixed-rootfs-image-v2";
const FORMAT_V3 = "kandelo-fixed-rootfs-image-v3";
const FORMAT_V4 = "kandelo-fixed-rootfs-image-v4";
const NAME_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;
const CHUNK_BYTES = 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

type StoredComposition = Pick<
  ComposeImageResult,
  "imageConfig" | "profileId" | "terminalSession" | "requiredServices"
>;

interface ImageManifest {
  format: typeof FORMAT_V1 | typeof FORMAT_V2 | typeof FORMAT_V3 | typeof FORMAT_V4;
  identity: string;
  length: number;
  sha256?: string;
  imageFileName?: string;
  journalName?: string;
  journalNameSha256?: string;
  journalInitialized?: boolean;
  imageSha256?: string;
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
  journalName: string;
  journalInitialized: boolean;
  imageSha256?: string;
  length: number;
  chunkSha256: readonly string[];
  lazyAssets?: ImageOwnedRuntimeLazyAssets;
  composition: StoredComposition;
  recovery?: {
    currentManifestSha256: string | null;
    previousManifestSha256: string;
  };
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

function fileNames(name: string): { image: string; manifest: string; previousManifest: string } {
  if (!NAME_PATTERN.test(name)) throw new Error("invalid experimental persistence name");
  return {
    image: `${name}.base`,
    manifest: `${name}.base.json`,
    previousManifest: `${name}.previous.base.json`,
  };
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

async function manifestSha256(
  parent: FileSystemDirectoryHandle,
  fileName: string,
): Promise<string | null> {
  const file = await existingFile(parent, fileName);
  return file === null ? null : sha256(new Uint8Array(await (await file.getFile()).arrayBuffer()));
}

async function readSavedImageAt(
  parent: FileSystemDirectoryHandle,
  name: string,
  identity: string,
  manifestName: string,
): Promise<{
  manifest: ImageManifest;
  imageFile: FileSystemFileHandle;
  lazyAssets?: ImageOwnedRuntimeLazyAssets;
  lazyAssetsRecorded: boolean;
  composition?: StoredComposition;
} | null> {
  const names = fileNames(name);
  const manifestFile = await existingFile(parent, manifestName);
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
    (manifest?.format !== FORMAT_V1 && manifest?.format !== FORMAT_V2 &&
      manifest?.format !== FORMAT_V3 && manifest?.format !== FORMAT_V4) ||
    manifest.identity !== identity ||
    !Number.isSafeInteger(manifest.length) ||
    manifest.length <= 0 ||
    (manifest.format === FORMAT_V1 && !SHA256_PATTERN.test(manifest.sha256 ?? "")) ||
    (manifest.format !== FORMAT_V1 && (
      manifest.sha256 !== undefined ||
      typeof manifest.imageFileName !== "string" ||
      !new RegExp(`^${name}\\.[0-9a-f-]{36}\\.base$`).test(manifest.imageFileName)
    ))
  ) {
    throw new Error("experimental persistence base image belongs to a different computer");
  }
  if (manifest.format === FORMAT_V3 || manifest.format === FORMAT_V4) {
    if (
      typeof manifest.journalName !== "string" ||
      (manifest.journalName !== name &&
        !/^j-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(manifest.journalName))
    ) {
      throw new Error("experimental persistence journal namespace is invalid");
    }
    if (manifest.format === FORMAT_V4 && typeof manifest.journalInitialized !== "boolean") {
      throw new Error("experimental persistence journal initialization state is invalid");
    }
    const binding = JSON.stringify(manifest.format === FORMAT_V4
      ? [manifest.identity, manifest.imageFileName, manifest.journalName, manifest.journalInitialized]
      : [manifest.identity, manifest.imageFileName, manifest.journalName]);
    if (
      !SHA256_PATTERN.test(manifest.journalNameSha256 ?? "") ||
      await sha256(new TextEncoder().encode(binding)) !== manifest.journalNameSha256
    ) {
      throw new Error("experimental persistence journal namespace is damaged");
    }
  } else if (manifest.journalName !== undefined || manifest.journalNameSha256 !== undefined) {
    throw new Error("experimental persistence journal namespace is invalid");
  }
  if (manifest.format !== FORMAT_V4 && manifest.journalInitialized !== undefined) {
    throw new Error("experimental persistence journal initialization state is invalid");
  }
  if (manifest.format === FORMAT_V4
    ? !SHA256_PATTERN.test(manifest.imageSha256 ?? "")
    : manifest.imageSha256 !== undefined) {
    throw new Error("experimental persistence image digest is invalid");
  }
  const imageFile = await existingFile(
    parent,
    manifest.format === FORMAT_V1 ? names.image : manifest.imageFileName!,
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
    manifest.format !== FORMAT_V1 &&
    (manifest.chunkSha256 === undefined || composition === undefined || !lazyAssetsRecorded)
  ) {
    throw new Error("experimental persistence base image manifest is invalid");
  }
  if ((await imageFile.getFile()).size !== manifest.length) {
    throw new Error("experimental persistence base image is damaged; refusing to boot");
  }
  return { manifest, imageFile, lazyAssets, lazyAssetsRecorded, composition };
}

type SavedImage = NonNullable<Awaited<ReturnType<typeof readSavedImageAt>>>;

async function selectSavedImage(
  parent: FileSystemDirectoryHandle,
  name: string,
  identity: string,
): Promise<{ saved: SavedImage; fromPrevious: boolean } | null> {
  const names = fileNames(name);
  let current: Awaited<ReturnType<typeof readSavedImageAt>>;
  try {
    current = await readSavedImageAt(parent, name, identity, names.manifest);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("experimental persistence")) throw error;
    const previous = await readSavedImageAt(parent, name, identity, names.previousManifest);
    if (previous !== null) {
      await verifySavedImage(parent, previous);
      return { saved: previous, fromPrevious: true };
    }
    throw error;
  }
  if (current === null) {
    const previous = await readSavedImageAt(parent, name, identity, names.previousManifest);
    if (previous !== null) await verifySavedImage(parent, previous);
    return previous === null ? null : { saved: previous, fromPrevious: true };
  }
  let previous: Awaited<ReturnType<typeof readSavedImageAt>>;
  try {
    previous = await readSavedImageAt(parent, name, identity, names.previousManifest);
  } catch {
    return { saved: current, fromPrevious: false };
  }
  if (previous !== null && !(await previous.imageFile.isSameEntry(current.imageFile))) {
    try {
      await verifySavedImage(parent, current);
    } catch (error) {
      if (!(error instanceof Error) || !error.message.startsWith("experimental persistence")) throw error;
      await verifySavedImage(parent, previous);
      return { saved: previous, fromPrevious: true };
    }
  }
  return { saved: current, fromPrevious: false };
}

async function readSavedImage(
  parent: FileSystemDirectoryHandle,
  name: string,
  identity: string,
): Promise<SavedImage | null> {
  return (await selectSavedImage(parent, name, identity))?.saved ?? null;
}

async function verifySavedImage(
  parent: FileSystemDirectoryHandle,
  saved: NonNullable<Awaited<ReturnType<typeof readSavedImageAt>>>,
): Promise<void> {
  const { manifest, imageFile } = saved;
  if (manifest.chunkSha256 === undefined) {
    throw new Error("experimental persistence fallback image lacks chunk integrity");
  }
  const snapshot = await imageFile.getFile();
  const imageHash = incrementalSha256.create();
  for (let index = 0; index < manifest.chunkSha256.length; index++) {
    const offset = index * CHUNK_BYTES;
    const bytes = new Uint8Array(await snapshot.slice(offset, offset + CHUNK_BYTES).arrayBuffer());
    if (await sha256(bytes) !== manifest.chunkSha256[index]) {
      throw new Error("experimental persistence base image is damaged; refusing to boot");
    }
    imageHash.update(bytes);
  }
  if (manifest.format === FORMAT_V4 && bytesToHex(imageHash.digest()) !== manifest.imageSha256) {
    throw new Error("experimental persistence base image is damaged; refusing to boot");
  }
  if (manifest.format === FORMAT_V4 && manifest.journalInitialized) {
    await verifyJournalHeader(parent, manifest.journalName!, manifest.imageSha256!);
  }
}

async function readImage(
  parent: FileSystemDirectoryHandle,
  name: string,
  identity: string,
): Promise<FixedPersistenceImage | null> {
  const saved = await readSavedImage(parent, name, identity);
  if (saved === null) return null;
  const { manifest, imageFile, lazyAssets, lazyAssetsRecorded } = saved;
  if (manifest.format !== FORMAT_V1) {
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

function runtimeLockName(name: string): string {
  return `kandelo-fixed-rootfs-runtime:${name}`;
}

async function whenRuntimeIdle<T>(name: string, operation: () => Promise<T>): Promise<T> {
  if (!navigator.locks) throw new Error("experimental persistence requires Web Locks");
  return navigator.locks.request(runtimeLockName(name), { mode: "exclusive", ifAvailable: true }, (lock) => {
    if (lock === null) throw new Error("experimental persistence computer is already running in another tab");
    return operation();
  });
}

export async function acquireFixedPersistenceRuntimeLease(name: string): Promise<BrowserPersistenceComputerLease> {
  fileNames(name);
  return acquireBrowserPersistenceComputerLease(name);
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
    const parent = await directory();
    const selected = await selectSavedImage(parent, name, identity);
    if (selected === null) return null;
    const handle = imageHandleFromSaved(name, selected.saved);
    if (handle !== null && selected.fromPrevious) {
      if (selected.saved.manifest.format !== FORMAT_V4 ||
        !selected.saved.manifest.journalInitialized) {
        throw new Error("experimental persistence previous generation is not ready");
      }
      handle.recovery = await recoverySelection(parent, name);
    }
    return handle;
  });
}

export async function loadPreviousFixedPersistenceImageHandle(
  name: string,
  identity: string,
  failed: FixedPersistenceImageHandle,
): Promise<FixedPersistenceImageHandle | null> {
  fileNames(name);
  return locked(name, async () => {
    const parent = await directory();
    const names = fileNames(name);
    const current = await readSavedImageAt(parent, name, identity, names.manifest);
    if (current === null || !(await current.imageFile.isSameEntry(failed.file)) ||
      current.manifest.journalName !== failed.journalName) return null;
    const previous = await readSavedImageAt(parent, name, identity, names.previousManifest);
    if (previous === null || previous.manifest.format !== FORMAT_V4 ||
      !previous.manifest.journalInitialized ||
      previous.manifest.journalName === failed.journalName ||
      await previous.imageFile.isSameEntry(failed.file)) return null;
    await verifySavedImage(parent, previous);
    const handle = imageHandleFromSaved(name, previous);
    if (handle !== null) handle.recovery = await recoverySelection(parent, name);
    return handle;
  });
}

async function recoverySelection(
  parent: FileSystemDirectoryHandle,
  name: string,
): Promise<NonNullable<FixedPersistenceImageHandle["recovery"]>> {
  const names = fileNames(name);
  const previousManifestSha256 = await manifestSha256(parent, names.previousManifest);
  if (previousManifestSha256 === null) {
    throw new Error("experimental persistence previous generation disappeared");
  }
  return {
    currentManifestSha256: await manifestSha256(parent, names.manifest),
    previousManifestSha256,
  };
}

export async function promoteFixedPersistenceRecovery(
  name: string,
  identity: string,
  recovered: FixedPersistenceImageHandle,
  assertCurrent?: () => void,
): Promise<void> {
  const recovery = recovered.recovery;
  if (recovery === undefined) return;
  fileNames(name);
  await locked(name, async () => {
    assertCurrent?.();
    const parent = await directory();
    const names = fileNames(name);
    const previousDigest = await manifestSha256(parent, names.previousManifest);
    if (previousDigest !== recovery.previousManifestSha256) {
      throw new Error("experimental persistence prior generation changed before recovery");
    }
    const previous = await readSavedImageAt(parent, name, identity, names.previousManifest);
    if (previous === null || previous.manifest.format !== FORMAT_V4 || !previous.manifest.journalInitialized ||
      previous.manifest.journalName !== recovered.journalName ||
      !(await previous.imageFile.isSameEntry(recovered.file))) {
      throw new Error("experimental persistence prior generation changed before recovery");
    }
    const currentDigest = await manifestSha256(parent, names.manifest);
    if (currentDigest !== recovery.currentManifestSha256) {
      const current = await readSavedImageAt(parent, name, identity, names.manifest);
      if (current !== null &&
        JSON.stringify(current.manifest) === JSON.stringify(previous.manifest)) return;
      throw new Error("experimental persistence current generation changed before recovery");
    }
    await verifySavedImage(parent, previous);
    await writeManifest(parent, names.manifest, previous.manifest, assertCurrent);
    const promoted = await readSavedImageAt(parent, name, identity, names.manifest);
    if (promoted === null || promoted.manifest.journalName !== recovered.journalName ||
      !(await promoted.imageFile.isSameEntry(recovered.file))) {
      throw new Error("experimental persistence recovery was not published");
    }
  });
}

function imageHandleFromSaved(
  name: string,
  saved: NonNullable<Awaited<ReturnType<typeof readSavedImageAt>>>,
): FixedPersistenceImageHandle | null {
  if (saved.manifest.chunkSha256 === undefined ||
    saved.composition === undefined || !saved.lazyAssetsRecorded) return null;
  return {
    file: saved.imageFile,
    imageFileName: saved.manifest.imageFileName,
    journalName: saved.manifest.journalName ?? name,
    journalInitialized: saved.manifest.format !== FORMAT_V4 || saved.manifest.journalInitialized === true,
    imageSha256: saved.manifest.imageSha256,
    length: saved.manifest.length,
    chunkSha256: saved.manifest.chunkSha256,
    lazyAssets: saved.lazyAssets,
    composition: saved.composition,
  };
}

export async function markFixedPersistenceJournalInitialized(
  name: string,
  identity: string,
  installed: FixedPersistenceImageHandle,
): Promise<void> {
  fileNames(name);
  return locked(name, async () => {
    const parent = await directory();
    const names = fileNames(name);
    const saved = await readSavedImageAt(parent, name, identity, names.manifest);
    if (
      saved?.manifest.format !== FORMAT_V4 ||
      saved.manifest.journalName !== installed.journalName ||
      saved.manifest.length !== installed.length ||
      !(await saved.imageFile.isSameEntry(installed.file))
    ) {
      throw new Error("experimental persistence image changed before journal initialization");
    }
    if (saved.manifest.journalInitialized) return;
    const manifest = saved.manifest;
    await verifyJournalHeader(parent, installed.journalName, manifest.imageSha256!);
    manifest.journalInitialized = true;
    manifest.journalNameSha256 = await sha256(new TextEncoder().encode(JSON.stringify([
      identity, manifest.imageFileName, manifest.journalName, true,
    ])));
    await writeManifest(parent, names.previousManifest, manifest);
    const verifiedBackup = await readSavedImageAt(parent, name, identity, names.previousManifest);
    if (verifiedBackup?.manifest.journalInitialized !== true) {
      throw new Error("experimental persistence fallback manifest was not published");
    }
    await writeManifest(parent, names.manifest, manifest);
    const verified = await readSavedImageAt(parent, name, identity, names.manifest);
    if (verified?.manifest.journalInitialized !== true) {
      throw new Error("experimental persistence journal initialization was not published");
    }
  });
}

async function verifyJournalHeader(
  parent: FileSystemDirectoryHandle,
  journalName: string,
  imageSha256: string,
): Promise<void> {
  const journalFile = await existingFile(parent, `${journalName}.journal`);
  const journal = journalFile === null ? null : await journalFile.getFile();
  if (journal === null || journal.size < 72) {
    throw new Error("experimental persistence journal is not initialized");
  }
  const header = new Uint8Array(await journal.slice(0, 72).arrayBuffer());
  if (
    new TextDecoder().decode(header.subarray(0, 4)) !== "KOVL" ||
    new DataView(header.buffer).getUint32(4, true) !== 1 ||
    bytesToHex(header.subarray(8, 40)) !== imageSha256 ||
    await sha256(header.subarray(0, 40)) !== bytesToHex(header.subarray(40, 72))
  ) {
    throw new Error("experimental persistence journal does not belong to this image");
  }
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
    let writer: FileSystemWritableFileStream | undefined;
    try {
      writer = await imageFile.createWritable();
      for (let offset = 0; offset < proposed.byteLength; offset += CHUNK_BYTES) {
        await writer.write({
          type: "write",
          position: offset,
          data: proposed.slice(offset, offset + CHUNK_BYTES),
        });
      }
      await writer.close();
    } catch (error) {
      await writer?.abort().catch(() => {});
      await parent.removeEntry(names.image).catch(() => {});
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
    let manifestWriter: FileSystemWritableFileStream | undefined;
    try {
      manifestWriter = await manifestFile.createWritable();
      await manifestWriter.write(JSON.stringify(manifest));
      await manifestWriter.close();
    } catch (error) {
      await manifestWriter?.abort().catch(() => {});
      await parent.removeEntry(names.manifest).catch(() => {});
      await parent.removeEntry(names.image).catch(() => {});
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
  assertCurrent?: () => void,
  onProgress?: (message: string) => void,
  journalName = name,
  mode: "install" | "replacement" = "install",
): Promise<FixedPersistenceImageHandle> {
  fileNames(name);
  if (journalName !== name && !/^j-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(journalName)) {
    throw new Error("experimental persistence journal namespace is invalid");
  }
  onProgress?.("persistent image requesting lock");
  return locked(name, async () => {
    onProgress?.("persistent image lock acquired");
    assertCurrent?.();
    const parent = await directory();
    onProgress?.("persistent image directory opened");
    const existing = mode === "install"
      ? await readSavedImage(parent, name, identity)
      : await readSavedImageAt(parent, name, identity, fileNames(name).manifest);
    if (mode === "install" && existing !== null) {
      throw new Error("experimental persistence was initialized concurrently; restart the computer");
    }
    if (mode === "replacement" &&
      (existing?.manifest.format !== FORMAT_V4 || !existing.manifest.journalInitialized)) {
      throw new Error("experimental persistence replacement requires a ready current image");
    }
    onProgress?.("persistent image absence checked");
    if (mode === "install") {
      const generationPattern = new RegExp(`^${name}\\.[0-9a-f-]{36}\\.base$`);
      const entries = (parent as FileSystemDirectoryHandle & {
        entries(): AsyncIterable<[string, FileSystemHandle]>;
      }).entries();
      for await (const [entryName] of entries) {
        if (generationPattern.test(entryName)) await parent.removeEntry(entryName);
      }
    }
    const imageFileName = `${name}.${crypto.randomUUID()}.base`;
    const imageFile = await parent.getFileHandle(imageFileName, { create: true });
    onProgress?.("persistent image file opened");
    let retained = false;
    try {
      const chunkSha256: string[] = [];
      const imageHash = incrementalSha256.create();
      let length = 0;
      const pending = new Uint8Array(CHUNK_BYTES);
      let pendingLength = 0;
      const writer = await imageFile.createWritable();
      onProgress?.("persistent image writer opened");
      try {
        for await (const chunk of chunks) {
          assertCurrent?.();
          if (
            chunk.byteLength === 0 ||
            !Number.isSafeInteger(length + pendingLength + chunk.byteLength)
          ) {
            throw new Error("experimental persistence image stream has invalid chunks");
          }
          imageHash.update(chunk);
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
        journalName,
        journalInitialized: false,
        imageSha256: bytesToHex(imageHash.digest()),
        length,
        chunkSha256,
        lazyAssets,
        composition,
      };
      if (mode === "install") {
        await publishImage(parent, name, identity, result, () => { retained = true; }, assertCurrent);
      }
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
  retainStagedImage: () => void,
  assertCurrent?: () => void,
): Promise<void> {
  const names = fileNames(name);
  if (await readSavedImage(parent, name, identity) !== null) {
    throw new Error("experimental persistence was initialized concurrently; restart the computer");
  }
  const manifest = await manifestForStagedImage(name, identity, staged, false);
  assertCurrent?.();
  const manifestFile = await parent.getFileHandle(names.manifest, { create: true });
  retainStagedImage();
  let writer: FileSystemWritableFileStream | undefined;
  let closeAttempted = false;
  const contents = JSON.stringify(manifest);
  try {
    writer = await manifestFile.createWritable();
    await writer.write(contents);
    assertCurrent?.();
    closeAttempted = true;
    await writer.close();
  } catch (error) {
    await writer?.abort().catch(() => {});
    let storedContents: string | null = null;
    if (closeAttempted) {
      try {
        storedContents = await (await manifestFile.getFile()).text();
      } catch {}
      if (storedContents === contents) return;
    }
    if (!closeAttempted || storedContents !== null) {
      await parent.removeEntry(names.manifest).catch(() => {});
    }
    throw error;
  }
}

async function manifestForStagedImage(
  name: string,
  identity: string,
  staged: FixedPersistenceImageHandle,
  journalInitialized: boolean,
): Promise<ImageManifest> {
  const imageFileName = staged.imageFileName;
  if (
    imageFileName === undefined ||
    !new RegExp(`^${name}\\.[0-9a-f-]{36}\\.base$`).test(imageFileName) ||
    !SHA256_PATTERN.test(staged.imageSha256 ?? "") ||
    !Number.isSafeInteger(staged.length) || staged.length <= 0 ||
    !Array.isArray(staged.chunkSha256) ||
    staged.chunkSha256.length !== Math.ceil(staged.length / CHUNK_BYTES) ||
    !staged.chunkSha256.every((digest) => SHA256_PATTERN.test(digest))
  ) {
    throw new Error("experimental persistence staged image is invalid");
  }
  const savedLazyAssets = staged.lazyAssets === undefined ? null : { ...staged.lazyAssets };
  const savedComposition = { ...staged.composition };
  const manifest: ImageManifest = {
    format: FORMAT_V4,
    identity,
    imageFileName,
    journalName: staged.journalName,
    journalInitialized,
    imageSha256: staged.imageSha256,
    journalNameSha256: await sha256(new TextEncoder().encode(JSON.stringify([
      identity, imageFileName, staged.journalName, journalInitialized,
    ]))),
    length: staged.length,
    lazyAssets: savedLazyAssets,
    lazyAssetsSha256: await sha256(new TextEncoder().encode(JSON.stringify(savedLazyAssets))),
    chunkSha256: [...staged.chunkSha256],
    chunkSha256Digest: await sha256(new TextEncoder().encode(JSON.stringify(staged.chunkSha256))),
    composition: savedComposition,
    compositionSha256: await sha256(new TextEncoder().encode(JSON.stringify(savedComposition))),
  };
  return manifest;
}

async function writeManifest(
  parent: FileSystemDirectoryHandle,
  fileName: string,
  manifest: ImageManifest,
  assertCurrent?: () => void,
): Promise<void> {
  const file = await parent.getFileHandle(fileName, { create: true });
  const writer = await file.createWritable();
  try {
    await writer.write(JSON.stringify(manifest));
    assertCurrent?.();
    await writer.close();
  } catch (error) {
    await writer.abort().catch(() => {});
    throw error;
  }
}

export async function stageFixedPersistenceReplacement(
  name: string,
  identity: string,
  chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  lazyAssets: ImageOwnedRuntimeLazyAssets | undefined,
  composition: StoredComposition,
  assertCurrent?: () => void,
): Promise<FixedPersistenceImageHandle> {
  return writeFixedPersistenceImageStream(
    name, identity, chunks, lazyAssets, composition, assertCurrent, undefined,
    `j-${crypto.randomUUID()}`, "replacement",
  );
}

export async function publishFixedPersistenceReplacement(
  name: string,
  identity: string,
  previous: FixedPersistenceImageHandle,
  staged: FixedPersistenceImageHandle,
  assertCurrent?: () => void,
): Promise<void> {
  fileNames(name);
  if (staged.journalName === previous.journalName ||
    !/^j-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(staged.journalName)) {
    throw new Error("experimental persistence replacement source changed");
  }
  await whenRuntimeIdle(name, () => withIdleBrowserPersistenceJournals(
    previous.journalName,
    staged.journalName,
    () => locked(name, async () => {
      assertCurrent?.();
      const parent = await directory();
      const names = fileNames(name);
      const current = await readSavedImageAt(parent, name, identity, names.manifest);
      const manifest = await manifestForStagedImage(name, identity, staged, true);
      if (current !== null && JSON.stringify(current.manifest) === JSON.stringify(manifest) &&
        await current.imageFile.isSameEntry(staged.file)) {
        const backup = await readSavedImageAt(parent, name, identity, names.previousManifest);
        if (backup?.manifest.format !== FORMAT_V4 || !backup.manifest.journalInitialized ||
          backup.manifest.journalName !== previous.journalName ||
          backup.manifest.imageSha256 !== previous.imageSha256 ||
          backup.manifest.length !== previous.length ||
          JSON.stringify(backup.manifest.chunkSha256) !== JSON.stringify(previous.chunkSha256) ||
          JSON.stringify(backup.composition) !== JSON.stringify(previous.composition) ||
          JSON.stringify(backup.manifest.lazyAssets) !== JSON.stringify(previous.lazyAssets ?? null) ||
          !(await backup.imageFile.isSameEntry(previous.file))) {
          throw new Error("experimental persistence previous generation was not preserved");
        }
        await verifySavedImage(parent, backup);
        await verifySavedImage(parent, current);
        return;
      }
      if (
        current?.manifest.format !== FORMAT_V4 || !current.manifest.journalInitialized ||
        current.manifest.journalName !== previous.journalName ||
        !(await current.imageFile.isSameEntry(previous.file))
      ) {
        throw new Error("experimental persistence replacement source changed");
      }
      await verifySavedImage(parent, current);
      const stagedFile = await existingFile(parent, manifest.imageFileName!);
      if (stagedFile === null || !(await stagedFile.isSameEntry(staged.file))) {
        throw new Error("experimental persistence staged image changed");
      }
      const snapshot = await stagedFile.getFile();
      if (snapshot.size !== staged.length) {
        throw new Error("experimental persistence staged image is damaged");
      }
      const imageHash = incrementalSha256.create();
      for (let index = 0; index < staged.chunkSha256.length; index++) {
        assertCurrent?.();
        const offset = index * CHUNK_BYTES;
        const bytes = new Uint8Array(await snapshot.slice(offset, offset + CHUNK_BYTES).arrayBuffer());
        if (await sha256(bytes) !== staged.chunkSha256[index]) {
          throw new Error("experimental persistence staged image is damaged");
        }
        imageHash.update(bytes);
      }
      if (bytesToHex(imageHash.digest()) !== staged.imageSha256) {
        throw new Error("experimental persistence staged image is damaged");
      }
      await verifyJournalHeader(parent, staged.journalName, staged.imageSha256!);
      assertCurrent?.();
      await writeManifest(parent, names.previousManifest, current.manifest, assertCurrent);
      const backup = await readSavedImageAt(parent, name, identity, names.previousManifest);
      if (backup === null || backup.manifest.imageFileName !== current.manifest.imageFileName ||
        backup.manifest.journalName !== current.manifest.journalName ||
        backup.manifest.journalInitialized !== true) {
        throw new Error("experimental persistence previous generation was not preserved");
      }
      assertCurrent?.();
      await writeManifest(parent, names.manifest, manifest, assertCurrent);
      const published = await readSavedImageAt(parent, name, identity, names.manifest);
      if (published === null || published.manifest.imageFileName !== manifest.imageFileName ||
        published.manifest.journalName !== staged.journalName ||
        published.manifest.journalInitialized !== true) {
        throw new Error("experimental persistence replacement was not published");
      }
    }),
  ));
}

export async function discardFixedPersistenceStagedReplacement(
  name: string,
  identity: string,
  staged: FixedPersistenceImageHandle,
): Promise<boolean> {
  fileNames(name);
  if (!/^j-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(staged.journalName)) {
    throw new Error("experimental persistence staged journal namespace is invalid");
  }
  const stagedManifest = await manifestForStagedImage(name, identity, staged, true);
  return whenRuntimeIdle(name, () => navigator.locks.request(
    browserPersistenceJournalLockName(staged.journalName),
    { mode: "exclusive", ifAvailable: true },
    (journalLock) => {
      if (journalLock === null) throw new Error("experimental persistence journal is already open");
      return locked(name, async () => {
        const parent = await directory();
        const names = fileNames(name);
        const current = await readSavedImageAt(parent, name, identity, names.manifest);
        const previous = await readSavedImageAt(parent, name, identity, names.previousManifest);
        if ([current, previous].some((saved) => saved !== null && (
          saved.manifest.imageFileName === stagedManifest.imageFileName ||
          saved.manifest.journalName === staged.journalName
        ))) return false;
        const image = await existingFile(parent, stagedManifest.imageFileName!);
        if (image !== null && !(await image.isSameEntry(staged.file))) {
          throw new Error("experimental persistence staged image changed before discard");
        }
        const files = [
          `${staged.journalName}.journal`,
          `${staged.journalName}.index`,
          `${staged.journalName}.seal`,
          ...(["g0", "g1"] as const).flatMap((slot) => ["journal", "index", "seal"]
            .map((suffix) => `${staged.journalName}.${slot}.${suffix}`)),
        ];
        for (const file of files) {
          await parent.removeEntry(file).catch((error) => {
            if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
          });
        }
        if (image !== null) await parent.removeEntry(stagedManifest.imageFileName!);
        return true;
      });
    },
  ));
}

export async function saveFixedPersistenceImageStream(
  name: string,
  identity: string,
  chunks: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  lazyAssets: ImageOwnedRuntimeLazyAssets | undefined,
  composition: StoredComposition,
  assertCurrent?: () => void,
  onProgress?: (message: string) => void,
  journalName?: string,
): Promise<FixedPersistenceImageHandle> {
  return writeFixedPersistenceImageStream(
    name, identity, chunks, lazyAssets, composition, assertCurrent, onProgress, journalName,
  );
}

export async function publishFixedPersistenceSnapshot(
  name: string,
  identity: string,
  stagedFile: FileSystemFileHandle,
  integrity: OpfsImageIntegrity,
  lazyAssets: ImageOwnedRuntimeLazyAssets | undefined,
  composition: StoredComposition,
  assertCurrent?: () => void,
): Promise<FixedPersistenceImageHandle> {
  return saveFixedPersistenceImageStream(
    name, identity, await verifiedSnapshotChunks(stagedFile, integrity, assertCurrent),
    lazyAssets, composition, assertCurrent,
  );
}

export async function stageFixedPersistenceSnapshotReplacement(
  name: string,
  identity: string,
  stagedFile: FileSystemFileHandle,
  integrity: OpfsImageIntegrity,
  lazyAssets: ImageOwnedRuntimeLazyAssets | undefined,
  composition: StoredComposition,
  assertCurrent?: () => void,
): Promise<FixedPersistenceImageHandle> {
  return stageFixedPersistenceReplacement(
    name, identity, await verifiedSnapshotChunks(stagedFile, integrity, assertCurrent),
    lazyAssets, composition, assertCurrent,
  );
}

async function verifiedSnapshotChunks(
  stagedFile: FileSystemFileHandle,
  integrity: OpfsImageIntegrity,
  assertCurrent?: () => void,
): Promise<AsyncIterable<Uint8Array>> {
  if (
    !Number.isSafeInteger(integrity.length) || integrity.length <= 0 ||
    integrity.chunkBytes !== CHUNK_BYTES ||
    !Array.isArray(integrity.chunkSha256) ||
    integrity.chunkSha256.length !== Math.ceil(integrity.length / CHUNK_BYTES) ||
    !integrity.chunkSha256.every((digest) => typeof digest === "string" && SHA256_PATTERN.test(digest))
  ) {
    throw new Error("experimental persistence snapshot integrity is invalid");
  }
  const snapshot = await stagedFile.getFile();
  if (snapshot.size !== integrity.length) {
    throw new Error("experimental persistence snapshot length is invalid");
  }
  async function* verifiedChunks(): AsyncIterable<Uint8Array> {
    for (let index = 0; index < integrity.chunkSha256.length; index++) {
      assertCurrent?.();
      const offset = index * CHUNK_BYTES;
      const bytes = new Uint8Array(await snapshot.slice(offset, offset + CHUNK_BYTES).arrayBuffer());
      if (await sha256(bytes) !== integrity.chunkSha256[index]) {
        throw new Error("experimental persistence snapshot is damaged; refusing to publish");
      }
      yield bytes;
    }
  }
  return verifiedChunks();
}
