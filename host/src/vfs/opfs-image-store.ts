import { MemoryFileSystem, type VfsImageOptions } from "./memory-fs";

const DEFAULT_ROOT_DIR = "kandelo-vfs-images";
const STORE_MAGIC = "kandelo.opfs-vfs-image";
const STORE_VERSION = 1;
const MANIFEST_A = "manifest-a.json";
const MANIFEST_B = "manifest-b.json";
const IMAGE_DIR = "images";

export interface OpfsVfsImageStoreOptions {
  /** Directory created under the origin private file system root. */
  rootDirName?: string;
  /** Request best-effort persistent storage before opening the store. */
  requestPersistentStorage?: boolean;
}

export interface OpfsVfsImageSaveOptions extends VfsImageOptions {
  /**
   * Number of historical image files to keep for a project, including the
   * newly saved active image. The default is 2.
   */
  keepRevisions?: number;
}

export interface OpfsVfsImageLoadOptions {
  /** Forwarded to MemoryFileSystem.fromImage(). */
  maxByteLength?: number;
}

export interface OpfsVfsImageManifest {
  magic: typeof STORE_MAGIC;
  version: typeof STORE_VERSION;
  projectId: string;
  generation: number;
  imageFile: string;
  imageByteLength: number;
  createdAt: string;
  updatedAt: string;
}

interface ManifestWithSlot {
  manifest: OpfsVfsImageManifest;
  slot: "a" | "b";
}

/**
 * OPFS-backed store for whole MemoryFileSystem VFS images.
 *
 * This is intentionally a small snapshot primitive. Higher-level callers can
 * add journals, chunking, or user-visible import/export around it without
 * putting IndexedDB or app-specific policy into the VFS package.
 */
export class OpfsVfsImageStore {
  private constructor(private readonly root: FileSystemDirectoryHandle) {}

  static isAvailable(): boolean {
    return typeof navigator !== "undefined" &&
      !!navigator.storage &&
      typeof navigator.storage.getDirectory === "function";
  }

  static async open(options: OpfsVfsImageStoreOptions = {}): Promise<OpfsVfsImageStore> {
    if (!OpfsVfsImageStore.isAvailable()) {
      throw new Error("OPFS is not available in this browser");
    }
    if (options.requestPersistentStorage) {
      try {
        if (navigator.storage.persist) {
          await navigator.storage.persist();
        }
      } catch {
        // Persistence is a hint. Browsers may reject it or require engagement.
      }
    }

    const root = await navigator.storage.getDirectory();
    const storeRoot = await root.getDirectoryHandle(
      options.rootDirName ?? DEFAULT_ROOT_DIR,
      { create: true },
    );
    return new OpfsVfsImageStore(storeRoot);
  }

  async estimateStorage(): Promise<StorageEstimate | null> {
    if (!navigator.storage?.estimate) return null;
    return navigator.storage.estimate();
  }

  async persisted(): Promise<boolean | null> {
    if (!navigator.storage?.persisted) return null;
    return navigator.storage.persisted();
  }

  async save(
    projectId: string,
    fs: MemoryFileSystem,
    options: OpfsVfsImageSaveOptions = {},
  ): Promise<OpfsVfsImageManifest> {
    const image = await fs.saveImage(options);
    return this.saveBytes(projectId, image, options);
  }

  async saveBytes(
    projectId: string,
    image: Uint8Array,
    options: Pick<OpfsVfsImageSaveOptions, "keepRevisions"> = {},
  ): Promise<OpfsVfsImageManifest> {
    assertSafeProjectId(projectId);

    const projectDir = await this.openProjectDir(projectId, true);
    const imagesDir = await projectDir.getDirectoryHandle(IMAGE_DIR, { create: true });
    const current = await this.readCurrentManifest(projectDir);
    const now = new Date().toISOString();
    const generation = (current?.manifest.generation ?? 0) + 1;
    const imageFile = `${generation}-${randomSuffix()}.vfs`;

    await writeFile(imagesDir, imageFile, image);

    const manifest: OpfsVfsImageManifest = {
      magic: STORE_MAGIC,
      version: STORE_VERSION,
      projectId,
      generation,
      imageFile,
      imageByteLength: image.byteLength,
      createdAt: current?.manifest.createdAt ?? now,
      updatedAt: now,
    };

    const nextSlot = current?.slot === "a" ? "b" : "a";
    await writeJsonFile(
      projectDir,
      nextSlot === "a" ? MANIFEST_A : MANIFEST_B,
      manifest,
    );
    try {
      await this.pruneImages(projectDir, manifest, options.keepRevisions ?? 2);
    } catch {
      // Pruning is only space hygiene. A committed snapshot should stay usable.
    }
    return manifest;
  }

  async load(projectId: string, options: OpfsVfsImageLoadOptions = {}): Promise<MemoryFileSystem | null> {
    const image = await this.loadBytes(projectId);
    if (!image) return null;
    return MemoryFileSystem.fromImage(image, {
      maxByteLength: options.maxByteLength,
    });
  }

  async loadBytes(projectId: string): Promise<Uint8Array | null> {
    assertSafeProjectId(projectId);

    const projectDir = await this.openProjectDir(projectId, false);
    if (!projectDir) return null;

    const current = await this.readCurrentManifest(projectDir);
    if (!current) return null;

    try {
      const imagesDir = await projectDir.getDirectoryHandle(IMAGE_DIR);
      return readFile(imagesDir, current.manifest.imageFile);
    } catch {
      return null;
    }
  }

  async getManifest(projectId: string): Promise<OpfsVfsImageManifest | null> {
    assertSafeProjectId(projectId);

    const projectDir = await this.openProjectDir(projectId, false);
    if (!projectDir) return null;
    return (await this.readCurrentManifest(projectDir))?.manifest ?? null;
  }

  async delete(projectId: string): Promise<void> {
    assertSafeProjectId(projectId);
    try {
      await removeEntry(this.root, projectId, { recursive: true });
    } catch (err) {
      if (!isNotFound(err)) throw err;
    }
  }

  async listProjects(): Promise<string[]> {
    const projects: string[] = [];
    for await (const [name, handle] of directoryEntries(this.root)) {
      if (handle.kind === "directory") projects.push(name);
    }
    return projects.sort();
  }

  private async openProjectDir(
    projectId: string,
    create: true,
  ): Promise<FileSystemDirectoryHandle>;
  private async openProjectDir(
    projectId: string,
    create: false,
  ): Promise<FileSystemDirectoryHandle | null>;
  private async openProjectDir(
    projectId: string,
    create: boolean,
  ): Promise<FileSystemDirectoryHandle | null> {
    try {
      return await this.root.getDirectoryHandle(projectId, { create });
    } catch (err) {
      if (!create && isNotFound(err)) return null;
      throw err;
    }
  }

  private async readCurrentManifest(
    projectDir: FileSystemDirectoryHandle,
  ): Promise<ManifestWithSlot | null> {
    const candidates = await Promise.all([
      readManifest(projectDir, MANIFEST_A, "a"),
      readManifest(projectDir, MANIFEST_B, "b"),
    ]);
    return candidates
      .filter((entry): entry is ManifestWithSlot => entry !== null)
      .sort((a, b) => b.manifest.generation - a.manifest.generation)[0] ?? null;
  }

  private async pruneImages(
    projectDir: FileSystemDirectoryHandle,
    active: OpfsVfsImageManifest,
    keepRevisions: number,
  ): Promise<void> {
    if (keepRevisions <= 0) keepRevisions = 1;

    let imagesDir: FileSystemDirectoryHandle;
    try {
      imagesDir = await projectDir.getDirectoryHandle(IMAGE_DIR);
    } catch {
      return;
    }

    const images: string[] = [];
    for await (const [name, handle] of directoryEntries(imagesDir)) {
      if (handle.kind === "file" && name.endsWith(".vfs")) images.push(name);
    }

    const sorted = images.sort((a, b) => imageGeneration(b) - imageGeneration(a));
    const keep = new Set(sorted.slice(0, keepRevisions));
    keep.add(active.imageFile);

    for (const name of images) {
      if (!keep.has(name)) {
        await removeEntry(imagesDir, name);
      }
    }
  }
}

async function readManifest(
  dir: FileSystemDirectoryHandle,
  fileName: string,
  slot: "a" | "b",
): Promise<ManifestWithSlot | null> {
  try {
    const bytes = await readFile(dir, fileName);
    const value = JSON.parse(new TextDecoder().decode(bytes)) as OpfsVfsImageManifest;
    if (!isValidManifest(value)) return null;
    return { manifest: value, slot };
  } catch {
    return null;
  }
}

function isValidManifest(value: OpfsVfsImageManifest): boolean {
  return value?.magic === STORE_MAGIC &&
    value.version === STORE_VERSION &&
    typeof value.projectId === "string" &&
    typeof value.generation === "number" &&
    Number.isSafeInteger(value.generation) &&
    value.generation >= 0 &&
    typeof value.imageFile === "string" &&
    value.imageFile.endsWith(".vfs") &&
    typeof value.imageByteLength === "number";
}

async function readFile(dir: FileSystemDirectoryHandle, name: string): Promise<Uint8Array> {
  const handle = await dir.getFileHandle(name);
  const file = await (handle as FileSystemFileHandle & { getFile(): Promise<File> }).getFile();
  return new Uint8Array(await file.arrayBuffer());
}

async function writeFile(
  dir: FileSystemDirectoryHandle,
  name: string,
  bytes: Uint8Array,
): Promise<void> {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await (handle as FileSystemFileHandle & {
    createWritable(): Promise<FileSystemWritableFileStream>;
  }).createWritable();
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  await writable.write(copy.buffer);
  await writable.close();
}

async function writeJsonFile(
  dir: FileSystemDirectoryHandle,
  name: string,
  value: unknown,
): Promise<void> {
  const json = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(dir, name, new TextEncoder().encode(json));
}

async function removeEntry(
  dir: FileSystemDirectoryHandle,
  name: string,
  options?: { recursive?: boolean },
): Promise<void> {
  await (dir as FileSystemDirectoryHandle & {
    removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  }).removeEntry(name, options);
}

async function* directoryEntries(
  dir: FileSystemDirectoryHandle,
): AsyncIterable<[string, FileSystemHandle]> {
  const entries = (dir as FileSystemDirectoryHandle & {
    entries(): AsyncIterable<[string, FileSystemHandle]>;
  }).entries();
  for await (const entry of entries) yield entry;
}

function assertSafeProjectId(projectId: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(projectId)) {
    throw new Error(
      "projectId must contain only ASCII letters, numbers, dots, underscores, and dashes",
    );
  }
}

function imageGeneration(name: string): number {
  const prefix = Number.parseInt(name, 10);
  return Number.isFinite(prefix) ? prefix : 0;
}

function randomSuffix(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  return Math.random().toString(36).slice(2);
}

function isNotFound(err: unknown): boolean {
  return err instanceof DOMException && err.name === "NotFoundError";
}
