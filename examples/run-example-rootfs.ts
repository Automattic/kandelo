import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readFileSync, readdirSync, readSync } from "node:fs";
import { basename, dirname, join, posix } from "node:path";

import { tryResolveBinaries } from "../host/src/binary-resolver";
import {
  MAX_CLOSED_LAZY_ASSETS,
  MAX_CLOSED_LAZY_ASSET_BYTES,
  type ClosedLazyAsset,
} from "../host/src/vfs/closed-lazy-assets";
import { KandeloImageFs } from "../images/vfs/lib/kandelo-image-fs";
import type { PersistentImageIntegrityPolicy } from "../images/vfs/lib/kandelo-image-fs";
import type { PersistentImageReadBinding } from "../host/src/vfs/image-integrity";
import { HostFileSystem } from "../host/src/vfs/host-fs";
import { OverlayStorageFile } from "../host/src/vfs/overlay-storage";

const ROOTFS_LAZY_URL_BASE = "https://kandelo-runner.invalid/";

function readExactArtifact(path: string, size: number, url: string): Uint8Array {
  const descriptor = openSync(path, "r");
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || metadata.size !== size) {
      throw new Error(`runner rootfs lazy artifact size mismatch: ${url}; rebuild the rootfs`);
    }
    // Retain no more than the declared closure budget, even if a native
    // writer changes the file after resolution. An open fd pins the inode.
    const bytes = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
      const count = readSync(descriptor, bytes, offset, size - offset, offset);
      if (count === 0) throw new Error(`runner rootfs lazy artifact truncated: ${url}`);
      offset += count;
    }
    if (readSync(descriptor, new Uint8Array(1), 0, 1, size) !== 0) {
      throw new Error(`runner rootfs lazy artifact grew during capture: ${url}`);
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

/** Bind the canonical rootfs's deferred files to verified local artifacts. */
export function prepareRunExampleRootfs(image: Uint8Array): {
  rootfsImage: Uint8Array;
  rootfsLazyUrlBase: string;
  rootfsLazyAssets: ClosedLazyAsset[];
} {
  const rootfsImage = new Uint8Array(image);
  const sources = new Map<string, number>();
  for (const { url, size } of KandeloImageFs.readImageLazyFileSources(rootfsImage)) {
    // The canonical rootfs names local program artifacts. Do not turn a
    // transport hint into an arbitrary host path or ambient network fetch.
    const segments = url.split("/");
    if (
      !/^binaries\/programs\/wasm(?:32|64)\/[A-Za-z0-9_+./-]+$/.test(url)
      || segments.some((part) => part === "" || part === "." || part === "..")
    ) {
      throw new Error(`runner rootfs has unsupported lazy file URL ${JSON.stringify(url)}`);
    }
    const previous = sources.get(url);
    if (previous !== undefined && previous !== size) {
      throw new Error(`runner rootfs has conflicting sizes for ${url}`);
    }
    sources.set(url, size);
  }
  const totalBytes = Array.from(sources.values()).reduce((sum, size) => sum + size, 0);
  if (
    sources.size > MAX_CLOSED_LAZY_ASSETS
    || !Number.isSafeInteger(totalBytes)
    || totalBytes > MAX_CLOSED_LAZY_ASSET_BYTES
  ) {
    throw new Error("runner rootfs lazy files exceed the closed transport budget");
  }
  const entries = Array.from(sources);
  const relPaths = entries.map(([url]) => url.slice("binaries/".length));
  const paths = entries.length === 0 ? [] : tryResolveBinaries(relPaths);
  const rootfsLazyAssets = entries.map(([url, size], index): ClosedLazyAsset => {
    const path = paths[index];
    if (path === null || path === undefined) {
      throw new Error(
        `runner rootfs lazy artifact is missing: ${relPaths[index]}; run ./run.sh setup`,
      );
    }
    const bytes = readExactArtifact(path, size, url);
    return {
      url: new URL(url, ROOTFS_LAZY_URL_BASE).href,
      size,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes,
    };
  });
  return { rootfsImage, rootfsLazyUrlBase: ROOTFS_LAZY_URL_BASE, rootfsLazyAssets };
}

export async function preparePersistentRunExampleRootfs(
  image: Uint8Array,
  fixtureRoot: string,
): Promise<Uint8Array> {
  const filesystem = KandeloImageFs.create();
  populatePersistentRunExampleRootfs(filesystem, image, fixtureRoot);
  return filesystem.saveImage();
}

export async function prepareCheckedPersistentRunExampleRootfs(
  image: Uint8Array,
  fixtureRoot: string,
  imagePath: string,
  policy: PersistentImageIntegrityPolicy,
): Promise<{ rootfsImageFile: string; rootfsPersistentImageBinding: PersistentImageReadBinding }> {
  const [modulePath] = tryResolveBinaries(["kandelo_image_module_positioned32.wasm"]);
  if (modulePath === null || modulePath === undefined) throw new Error("persistent runner requires the positioned image module");
  const filesystem = KandeloImageFs.createPositioned(new Uint8Array(readFileSync(modulePath)));
  populatePersistentRunExampleRootfs(filesystem, image, fixtureRoot);
  const target = OverlayStorageFile.open(new HostFileSystem(dirname(imagePath)), "/" + basename(imagePath));
  try {
    const receipt = await filesystem.exportPersistentImageTo(target, policy);
    return { rootfsImageFile: imagePath, rootfsPersistentImageBinding: {
      identitySha256: receipt.identitySha256, dataCachePages: 2, indexCachePages: 2,
    } };
  } finally { target.close(); }
}

function populatePersistentRunExampleRootfs(filesystem: KandeloImageFs, image: Uint8Array, fixtureRoot: string): void {
  filesystem.loadImage(image);
  filesystem.mkdir("/run", 0o755);
  filesystem.mkdir("/run/kandelo-run", 0o755);
  const copyTree = (source: string, destination: string): void => {
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      const sourcePath = join(source, entry.name);
      const destinationPath = posix.join(destination, entry.name);
      const metadata = lstatSync(sourcePath);
      if (metadata.isDirectory()) {
        filesystem.mkdir(destinationPath, metadata.mode & 0o7777);
        copyTree(sourcePath, destinationPath);
      } else if (metadata.isFile()) {
        filesystem.writeFile(destinationPath, new Uint8Array(readFileSync(sourcePath)), metadata.mode & 0o7777);
      } else {
        throw new Error(`persistent runner fixture has an unsupported entry: ${sourcePath}`);
      }
    }
  };
  copyTree(fixtureRoot, "/run/kandelo-run");
}
