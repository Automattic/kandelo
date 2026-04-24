// Build a wasm-posix-kernel rootfs VFS image from a source tree + manifest.
//
// Passes are ordered so parents exist before children, and file content is
// written before per-file mode/owner is applied (the helpers handle that).

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { resolve, join, relative } from "node:path";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import { parseZipCentralDirectory } from "../../../host/src/vfs/zip";
import {
  parseManifest,
  type ManifestArchive,
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

  // Stray-file guard: every regular file inside sourceTree must be declared
  // in the manifest as an f-entry without src= (or with a src= the builder
  // will fetch anyway). Files on disk with no declaration are silently
  // dropped today; refuse the build instead so manifest drift stays visible.
  checkSourceTreeCoverage(opts.sourceTree, entries);

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

  // Pass 4: archives. Each archive registers lazy stubs at base=<prefix>
  // and overlays per-archive fmode/uid/gid on top of the zip's embedded
  // mode so manifest-declared defaults win deterministically.
  const archives: ManifestArchive[] = entries.filter(
    (e): e is ManifestArchive => e.kind === "archive",
  );

  // Pre-scan: reject (a) two archives shipping the same path, and (b)
  // implicit f-entries (no src=) overlapping with archive paths. Explicit
  // src= overrides are allowed — the manifest wins, and we tag those
  // archive entries as deleted before registration so they're ignored.
  const archiveEntries = archives.map((a) => {
    const archivePath = resolve(opts.repoRoot, a.url);
    const zipBytes = new Uint8Array(readFileSync(archivePath));
    const zipEntries = parseZipCentralDirectory(zipBytes).map((ze) => ({
      ...ze,
      // Tolerate leading-/ paths in archives (strict output, forgiving input).
      fileName: ze.fileName.replace(/^\/+/, ""),
    }));
    return { archive: a, zipEntries };
  });

  const explicitFilePaths = new Set<string>();
  const explicitOverridePaths = new Set<string>();
  for (const e of entries) {
    if (e.kind !== "node" || e.type !== "f") continue;
    explicitFilePaths.add(e.path);
    if (e.src) explicitOverridePaths.add(e.path);
  }

  const archiveOwner = new Map<string, string>(); // vfsPath → archive url
  for (const { archive, zipEntries } of archiveEntries) {
    const base = archive.base === "/" ? "" : archive.base.replace(/\/+$/, "");
    for (const ze of zipEntries) {
      if (ze.isDirectory) continue;
      const vfsPath = base + "/" + ze.fileName;
      const prior = archiveOwner.get(vfsPath);
      if (prior && prior !== archive.url) {
        throw new Error(
          `${vfsPath}: shipped by two archives (${prior} and ${archive.url})`,
        );
      }
      if (explicitFilePaths.has(vfsPath) && !explicitOverridePaths.has(vfsPath)) {
        throw new Error(
          `${vfsPath}: declared as implicit file and also shipped by archive ${archive.url}; add src= to the manifest entry if the override is intentional`,
        );
      }
      archiveOwner.set(vfsPath, archive.url);
    }
  }

  for (const { archive: a, zipEntries } of archiveEntries) {
    // Drop archive entries that an explicit src= manifest line overrides.
    // registerLazyArchiveFromEntries calls fs.open(..., O_TRUNC) on every
    // entry it processes, so passing the overridden entries through would
    // clobber the explicit content Pass 2 wrote.
    const base = a.base === "/" ? "" : a.base.replace(/\/+$/, "");
    const filteredEntries = zipEntries.filter((ze) => {
      if (ze.isDirectory) return true;
      const vfsPath = base + "/" + ze.fileName;
      return !explicitOverridePaths.has(vfsPath);
    });
    const group = mfs.registerLazyArchiveFromEntries(a.url, filteredEntries, a.base);

    // registerLazyArchiveFromEntries seeds each stub with the zip's embedded
    // mode; override with manifest defaults so image builds are deterministic
    // regardless of who packaged the zip.
    for (const [vfsPath, entry] of group.entries) {
      if (entry.deleted) continue;
      if (entry.isSymlink) {
        // Symlinks: lchown only; mode on symlinks is cosmetic on POSIX.
        mfs.lchown(vfsPath, a.uid, a.gid);
      } else {
        mfs.chmod(vfsPath, a.fmode);
        mfs.chown(vfsPath, a.uid, a.gid);
      }
    }
  }

  // Pass 5: device nodes (kernel synthesizes /dev/* today; skip for v1)

  return await mfs.saveImage();
}

function depth(p: string): number {
  return p.split("/").filter(Boolean).length;
}

function checkSourceTreeCoverage(
  sourceTree: string,
  entries: ManifestEntry[],
): void {
  const root = resolve(sourceTree);
  if (!existsSync(root)) return;

  // Paths declared as files with implicit source (no src=) are expected to
  // live at sourceTree/<path>. src= overrides, dirs, symlinks, and archives
  // don't require an on-disk file inside sourceTree.
  const expected = new Set<string>();
  for (const e of entries) {
    if (e.kind !== "node" || e.type !== "f" || e.src) continue;
    expected.add(e.path.replace(/^\//, ""));
  }

  const missing: string[] = [];
  walkFiles(root, "", (rel) => {
    if (!expected.has(rel)) missing.push(rel);
  });
  if (missing.length > 0) {
    const list = missing.map((m) => `/${m}`).sort().join(", ");
    throw new Error(`${list} not in manifest`);
  }
}

function walkFiles(
  abs: string,
  rel: string,
  visit: (relPath: string) => void,
): void {
  for (const name of readdirSync(abs)) {
    const childAbs = join(abs, name);
    const childRel = rel ? `${rel}/${name}` : name;
    const st = statSync(childAbs);
    if (st.isDirectory()) {
      walkFiles(childAbs, childRel, visit);
    } else if (st.isFile()) {
      visit(childRel);
    }
  }
}
