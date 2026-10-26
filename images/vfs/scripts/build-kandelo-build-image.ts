/**
 * Compose the image package builds boot when they build inside Kandelo.
 *
 *   build-kandelo-build-image.ts <eager-rootfs.vfs.zst> <kandelo-sdk.zip> <out.vfs.zst>
 *
 * The input rootfs must be the canonical rootfs built with every package
 * output installed eagerly (scripts/build-rootfs.sh --default-install eager).
 * The guest toolchain archive (kandelo-sdk.zip) is expanded under /usr, where
 * the shell would otherwise mount it lazily.
 *
 * WHY eager rather than lazy: a lazy archive member is cached in the kernel's
 * linear memory when first read, together with the whole archive, and the
 * toolchain is about 195 MB uncompressed. An image-resident file is read from
 * the host on demand instead. Eager also means a recipe that boots this image
 * needs no lazy-asset binding: its only inputs are the kernel and this image.
 *
 * This is a build-time artifact for Node package builds; it is never served
 * to browsers.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ABI_VERSION } from "../../../host/src/generated/abi";
import type { VfsImageFilesystem } from "../../../host/src/vfs/vfs-image-filesystem";
import { ensureDir, writeVfsBinary } from "../../../host/src/vfs/image-helpers";
import { extractZipEntry, parseZipCentralDirectory } from "../../../host/src/vfs/zip";
import { KandeloImageFs } from "../lib/kandelo-image-fs";
import { saveImage } from "./vfs-image-helpers";

/** Where the toolchain archive's entries land, as in the shell image. */
export const GUEST_TOOLCHAIN_PREFIX = "/usr/";

function exists(fs: VfsImageFilesystem, path: string): boolean {
  try {
    fs.lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** Refuse a base image that still defers any file's bytes. */
function requireNothingDeferred(fs: KandeloImageFs): void {
  const { files, archives } = fs.lazyEntries();
  if (files.length > 0 || archives.length > 0) {
    const sample = files.slice(0, 5).map((file) => file.path).join(", ");
    throw new Error(
      `the build image base must be fully eager, but ${files.length} file(s) ` +
        `are still deferred (${sample}). Build it with ` +
        "scripts/build-rootfs.sh --default-install eager.",
    );
  }
}

/** Expand the guest toolchain archive into `fs` under /usr. */
export function installGuestToolchain(fs: KandeloImageFs, sdkZip: Uint8Array): void {
  requireNothingDeferred(fs);
  const entries = parseZipCentralDirectory(sdkZip);

  // Directories first, so every member's parent exists before it is written.
  const ordered = [...entries].sort((a, b) =>
    Number(b.isDirectory) - Number(a.isDirectory) || a.fileName.localeCompare(b.fileName)
  );
  for (const entry of ordered) {
    const relative = entry.fileName.replace(/\/$/, "");
    if (relative === "" || relative.split("/").some((part) => part === ".." || part === ".")) {
      throw new Error(`toolchain archive entry escapes ${GUEST_TOOLCHAIN_PREFIX}: ${entry.fileName}`);
    }
    const path = `${GUEST_TOOLCHAIN_PREFIX}${relative}`;
    const parent = path.slice(0, path.lastIndexOf("/"));
    for (let at = parent.indexOf("/", 1); at !== -1; at = parent.indexOf("/", at + 1)) {
      ensureDir(fs, parent.slice(0, at));
    }
    ensureDir(fs, parent);

    if (entry.isDirectory) {
      ensureDir(fs, path, entry.mode & 0o7777);
      fs.chmod(path, entry.mode & 0o7777);
      continue;
    }
    // A base file and a toolchain file at one path would leave the image
    // ambiguous about which bytes a tool runs; refuse rather than overwrite.
    if (exists(fs, path)) {
      throw new Error(`toolchain archive would replace ${path}, which the rootfs already provides`);
    }
    const bytes = extractZipEntry(sdkZip, entry);
    if (entry.isSymlink) {
      fs.symlink(new TextDecoder("utf-8", { fatal: true }).decode(bytes), path);
      continue;
    }
    writeVfsBinary(fs, path, bytes, entry.mode & 0o7777);
    fs.chmod(path, entry.mode & 0o7777);
  }
}

async function main(argv: string[]): Promise<void> {
  if (argv.length !== 3) {
    throw new Error(
      "usage: build-kandelo-build-image.ts <eager-rootfs.vfs.zst> <kandelo-sdk.zip> <out.vfs.zst>",
    );
  }
  const [rootfsPath, sdkZipPath, outPath] = argv;
  const epoch = process.env.SOURCE_DATE_EPOCH;
  if (epoch === undefined || !/^[0-9]+$/.test(epoch)) {
    throw new Error("SOURCE_DATE_EPOCH must be set to a non-negative integer");
  }

  const fs = KandeloImageFs.create();
  fs.loadImage(new Uint8Array(readFileSync(rootfsPath)));
  const baseAbi = fs.getImageMetadata()?.kernelAbi;
  if (baseAbi !== ABI_VERSION) {
    throw new Error(`rootfs was built for kernel ABI ${baseAbi}, this tree is ABI ${ABI_VERSION}`);
  }
  installGuestToolchain(fs, new Uint8Array(readFileSync(sdkZipPath)));
  await saveImage(fs, outPath, {
    metadata: {
      version: 1,
      kernelAbi: ABI_VERSION,
      createdBy: "build-kandelo-build-image",
    },
    // No materializeAll: installGuestToolchain already refused a base with
    // deferred files, so every byte is resident in the tree being saved.
    normalizeTimestampsMs: Number(epoch) * 1000,
  });
}

const invokedPath = process.argv[1] === undefined ? "" : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`build-kandelo-build-image: ${(error as Error).message}\n`);
    process.exit(1);
  });
}
