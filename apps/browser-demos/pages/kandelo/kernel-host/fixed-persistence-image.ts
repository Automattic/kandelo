import type { ImageOwnedRuntimeLazyAssets } from "../../../lib/init/image-owned-runtime-urls";

const DIRECTORY_NAME = "kandelo-persistent-overlay";
const FORMAT = "kandelo-fixed-rootfs-image-v1";
const NAME_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

interface ImageManifest {
  format: typeof FORMAT;
  identity: string;
  length: number;
  sha256: string;
  lazyAssets?: ImageOwnedRuntimeLazyAssets | null;
  lazyAssetsSha256?: string;
}

interface FixedPersistenceImage {
  imageBytes: Uint8Array;
  lazyAssets?: ImageOwnedRuntimeLazyAssets;
  lazyAssetsRecorded: boolean;
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

async function readImage(
  parent: FileSystemDirectoryHandle,
  name: string,
  identity: string,
): Promise<FixedPersistenceImage | null> {
  const names = fileNames(name);
  const manifestFile = await existingFile(parent, names.manifest);
  const imageFile = await existingFile(parent, names.image);
  if (manifestFile === null && imageFile === null) return null;
  if (manifestFile === null || imageFile === null) {
    throw new Error("experimental persistence base image is incomplete; refusing to boot");
  }
  let manifest: ImageManifest;
  try {
    manifest = JSON.parse(await (await manifestFile.getFile()).text()) as ImageManifest;
  } catch {
    throw new Error("experimental persistence base image manifest is invalid");
  }
  if (
    manifest?.format !== FORMAT ||
    manifest.identity !== identity ||
    !Number.isSafeInteger(manifest.length) ||
    manifest.length <= 0 ||
    !/^[0-9a-f]{64}$/.test(manifest.sha256)
  ) {
    throw new Error("experimental persistence base image belongs to a different computer");
  }
  const lazyAssetsRecorded = Object.hasOwn(manifest, "lazyAssets");
  const lazyAssets = parseLazyAssets(manifest.lazyAssets);
  if (lazyAssetsRecorded) {
    if (
      !/^[0-9a-f]{64}$/.test(manifest.lazyAssetsSha256 ?? "") ||
      await sha256(new TextEncoder().encode(JSON.stringify(manifest.lazyAssets))) !==
        manifest.lazyAssetsSha256
    ) {
      throw new Error("experimental persistence base image manifest is damaged");
    }
  } else if (manifest.lazyAssetsSha256 !== undefined) {
    throw new Error("experimental persistence base image manifest is invalid");
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

export async function saveFixedPersistenceImage(
  name: string,
  identity: string,
  proposed: Uint8Array,
  lazyAssets?: ImageOwnedRuntimeLazyAssets,
): Promise<FixedPersistenceImage> {
  fileNames(name);
  return locked(name, async () => {
    const parent = await directory();
    const existing = await readImage(parent, name, identity);
    if (existing !== null) {
      throw new Error("experimental persistence was initialized concurrently; restart the computer");
    }
    if (proposed.byteLength === 0) throw new Error("cannot persist an empty base image");
    const names = fileNames(name);
    const imageFile = await parent.getFileHandle(names.image, { create: true });
    const writer = await imageFile.createWritable();
    try {
      await writer.write(proposed.slice());
      await writer.close();
    } catch (error) {
      await writer.abort().catch(() => {});
      throw error;
    }
    const manifest: ImageManifest = {
      format: FORMAT,
      identity,
      length: proposed.byteLength,
      sha256: await sha256(proposed),
      lazyAssets: lazyAssets === undefined ? null : { ...lazyAssets },
    };
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
