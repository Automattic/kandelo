#!/usr/bin/env -S npx tsx

import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  MemoryFileSystem,
  type VfsImageMetadata,
} from "../host/src/vfs/memory-fs";

export function assertSourceRootfsShellMetadata(
  metadata: VfsImageMetadata | null,
  label = "shell VFS image",
): void {
  if (metadata === null) {
    throw new Error(`${label} has no image metadata`);
  }
  const composition = metadata.shellComposition;
  if (
    typeof composition !== "object" ||
    composition === null ||
    Array.isArray(composition)
  ) {
    throw new Error(`${label} has no source-rootfs composition binding`);
  }
  const record = composition as Record<string, unknown>;
  if (
    record.schema !== 1 ||
    record.kind !== "source-rootfs" ||
    Object.keys(record).sort().join("\0") !== "kind\0schema"
  ) {
    throw new Error(`${label} has an invalid source-rootfs composition binding`);
  }
  for (const claim of [
    "packageDeferredTrees",
    "homebrewBootstrap",
    "homebrew",
  ] as const) {
    if (metadata[claim] !== undefined) {
      throw new Error(
        `${label} mixes source-rootfs composition with ${claim}`,
      );
    }
  }
}

export function assertSourceRootfsShellImage(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`shell VFS image is not a regular file: ${path}`);
  }
  const bytes = new Uint8Array(readFileSync(path));
  assertSourceRootfsShellMetadata(
    MemoryFileSystem.readImageMetadata(bytes),
    path,
  );
}

function main(argv: readonly string[]): void {
  if (argv.length !== 1) {
    throw new Error(
      "usage: assert-source-rootfs-shell-composition.ts <shell.vfs.zst>",
    );
  }
  assertSourceRootfsShellImage(resolve(argv[0]));
}

if (
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main(process.argv.slice(2));
}
