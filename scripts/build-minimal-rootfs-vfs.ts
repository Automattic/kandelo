#!/usr/bin/env tsx
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MemoryFileSystem } from "../host/src/vfs/memory-fs";
import {
  ensureDir,
  ensureDirRecursive,
  writeVfsBinary,
  writeVfsFile,
} from "../host/src/vfs/image-helpers";
import { ABI_VERSION } from "../host/src/generated/abi";
import { findRepoRoot } from "../host/src/binary-resolver";

const REPO_ROOT = findRepoRoot();
const OUT_FILE = process.env.KANDELO_MINIMAL_ROOTFS_OUT ??
  join(REPO_ROOT, "host/wasm/rootfs.vfs");

function copyTree(fs: MemoryFileSystem, sourceDir: string, destDir: string): void {
  if (!existsSync(sourceDir)) return;
  ensureDirRecursive(fs, destDir);
  for (const name of readdirSync(sourceDir)) {
    const source = join(sourceDir, name);
    const dest = `${destDir}/${name}`;
    const st = lstatSync(source);
    if (st.isDirectory()) {
      copyTree(fs, source, dest);
    } else if (st.isFile()) {
      writeVfsBinary(fs, dest, new Uint8Array(readFileSync(source)), st.mode & 0o777);
    }
  }
}

async function main() {
  const sab = new SharedArrayBuffer(16 * 1024 * 1024, {
    maxByteLength: 64 * 1024 * 1024,
  });
  const fs = MemoryFileSystem.create(sab, 64 * 1024 * 1024);

  for (const dir of [
    "/bin",
    "/dev",
    "/etc",
    "/home",
    "/home/user",
    "/root",
    "/tmp",
    "/usr",
    "/usr/bin",
    "/var",
    "/var/tmp",
  ]) {
    ensureDir(fs, dir);
  }
  fs.chmod("/tmp", 0o777);
  fs.chmod("/var/tmp", 0o777);

  copyTree(fs, join(REPO_ROOT, "images/rootfs/etc"), "/etc");
  writeVfsFile(fs, "/bin/sh", "#!/bin/sh\n", 0o755);

  const image = await fs.saveImage({
    metadata: {
      version: 1,
      kernelAbi: ABI_VERSION,
      createdBy: "scripts/build-minimal-rootfs-vfs.ts",
    },
  });

  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, new Uint8Array(image));
  console.error(`Wrote minimal rootfs image to ${OUT_FILE}`);
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
