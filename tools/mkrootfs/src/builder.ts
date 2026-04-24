// Build a wasm-posix-kernel rootfs VFS image from a source tree + manifest.
//
// Passes are ordered so parents exist before children, and file content is
// written before per-file mode/owner is applied (the helpers handle that).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import {
  parseManifest,
  type ManifestEntry,
  type ManifestNode,
} from "./manifest.ts";

export interface BuildOptions {
  /** Absolute or repo-relative path to the implicit source tree (typically `rootfs/`). */
  sourceTree: string;
  /** Absolute or repo-relative path to the MANIFEST file. */
  manifest: string;
  /** Root used to resolve explicit `src=` paths and `archive` URLs. */
  repoRoot: string;
  /** Backing SharedArrayBuffer size in bytes; defaults to 16 MiB. */
  sabSize?: number;
}

export async function buildImage(opts: BuildOptions): Promise<Uint8Array> {
  const manifestText = readFileSync(resolve(opts.manifest), "utf8");
  const entries: ManifestEntry[] = parseManifest(manifestText);

  const sab = new SharedArrayBuffer(opts.sabSize ?? 16 * 1024 * 1024);
  const mfs = MemoryFileSystem.create(sab);

  // Pass 1: directories, sorted by depth so parents exist first.
  const dirs: ManifestNode[] = entries.filter(
    (e): e is ManifestNode => e.kind === "node" && e.type === "d",
  );
  dirs.sort((a, b) => depth(a.path) - depth(b.path));
  for (const d of dirs) {
    if (d.path === "/") continue; // root already exists
    mfs.mkdirWithOwner(d.path, d.mode, d.uid, d.gid);
  }

  // Pass 2: regular files. Implicit source = sourceTree + path; explicit src=
  // overrides resolve relative to repoRoot.
  const files: ManifestNode[] = entries.filter(
    (e): e is ManifestNode => e.kind === "node" && e.type === "f",
  );
  for (const f of files) {
    const contentPath = f.src
      ? resolve(opts.repoRoot, f.src)
      : resolve(opts.sourceTree, f.path.replace(/^\//, ""));
    const content = new Uint8Array(readFileSync(contentPath));
    mfs.createFileWithOwner(f.path, f.mode, f.uid, f.gid, content);
  }

  // Pass 3: symlinks.
  const symlinks: ManifestNode[] = entries.filter(
    (e): e is ManifestNode => e.kind === "node" && e.type === "l",
  );
  for (const l of symlinks) {
    if (!l.target) {
      throw new Error(`symlink ${l.path} missing target=`);
    }
    mfs.symlinkWithOwner(l.target, l.path, l.uid, l.gid);
  }

  // Pass 4: archives (handled in Task 1.7)
  // Pass 5: device nodes (kernel synthesizes /dev/* today; skip for v1)

  return await mfs.saveImage();
}

function depth(p: string): number {
  return p.split("/").filter(Boolean).length;
}
