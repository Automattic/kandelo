import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

import { tryResolveBinaries } from "../host/src/binary-resolver";
import {
  MAX_CLOSED_LAZY_ASSETS,
  MAX_CLOSED_LAZY_ASSET_BYTES,
  type ClosedLazyAsset,
} from "../host/src/vfs/closed-lazy-assets";
import { MemoryFileSystem } from "../host/src/vfs/memory-fs";

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
  for (const { url, size } of MemoryFileSystem.readImageLazyFileSources(rootfsImage)) {
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
