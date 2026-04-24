// `mkrootfs add <image> <vfsPath> <srcFile> [--mode=…] [--uid=…] [--gid=…]`
//
// Injects or replaces a single regular file in an existing .vfs image.
// Intended for iterative development — rebuilding the whole image for one
// changed file is slow. Writes the updated image back in place.
//
// Parent directories are created with 0755 0:0 if they don't exist. If
// <vfsPath> already exists, it's overwritten.

import { readFileSync, writeFileSync } from "node:fs";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";

export interface AddOptions {
  image: string;
  vfsPath: string;
  srcFile: string;
  mode?: number;
  uid?: number;
  gid?: number;
}

export async function addFile(opts: AddOptions): Promise<void> {
  const image = new Uint8Array(readFileSync(opts.image));
  const mfs = MemoryFileSystem.fromImage(image);

  const mode = opts.mode ?? 0o644;
  const uid = opts.uid ?? 0;
  const gid = opts.gid ?? 0;
  const content = new Uint8Array(readFileSync(opts.srcFile));

  // Ensure parent directories exist. Walk down the path, mkdir'ing each
  // missing segment with 0755 0:0 defaults.
  const parts = opts.vfsPath.split("/").filter(Boolean);
  if (parts.length === 0) {
    throw new Error(`invalid vfsPath: ${opts.vfsPath}`);
  }
  let dir = "";
  for (let i = 0; i < parts.length - 1; i++) {
    dir += "/" + parts[i];
    try {
      mfs.stat(dir);
    } catch {
      mfs.mkdirWithOwner(dir, 0o755, 0, 0);
    }
  }

  // If the path exists, unlink first so createFileWithOwner can recreate
  // with fresh content + metadata cleanly.
  try {
    const st = mfs.lstat(opts.vfsPath);
    if ((st.mode & 0o170000) === 0o040000) {
      throw new Error(`${opts.vfsPath}: path is a directory`);
    }
    mfs.unlink(opts.vfsPath);
  } catch (e) {
    const msg = String((e as Error).message || e);
    if (msg.includes("path is a directory")) throw e;
    // ENOENT is fine — path just doesn't exist yet.
  }

  mfs.createFileWithOwner(opts.vfsPath, mode, uid, gid, content);

  const updated = await mfs.saveImage();
  writeFileSync(opts.image, updated);
}

export function parseAddArgs(args: string[]): AddOptions {
  if (args.length < 3) {
    throw new Error("usage: add <image> <vfsPath> <srcFile> [--mode=N] [--uid=N] [--gid=N]");
  }
  const [image, vfsPath, srcFile, ...flags] = args;
  const opts: AddOptions = { image, vfsPath, srcFile };
  for (const flag of flags) {
    const m = /^--(mode|uid|gid)=(.+)$/.exec(flag);
    if (!m) throw new Error(`unknown flag "${flag}"`);
    const [, key, value] = m;
    if (key === "mode") opts.mode = parseInt(value, 8);
    else if (key === "uid") opts.uid = parseInt(value, 10);
    else if (key === "gid") opts.gid = parseInt(value, 10);
  }
  return opts;
}
