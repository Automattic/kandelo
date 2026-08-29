/**
 * Generate a mandoc.db name/keyword index over a set of man pages by running
 * the GUEST `makewhatis` (the shipped mandoc.wasm, dispatched by argv[0])
 * inside a real Kandelo kernel instance at build time, then reading the
 * generated database back out of the guest VFS.
 *
 * Why the guest tool: the on-disk `dba` database is written by the very mandoc
 * build that will later read it, so there is zero format/version-parity risk
 * (no host mandoc is built, and makewhatis is not available on the host). And
 * because the index is a pure function of the guest tool plus the pages fed
 * in, each image can index exactly the -docs it actually ships — no global
 * index package coupled to every -docs bundle.
 *
 * Faithfulness (see CLAUDE.md "Platform Values Contract"): the database is
 * produced by the real guest binary; this script only stages the input pages
 * and copies the output bytes. Page mtimes are normalized to a fixed epoch so
 * the database is byte-deterministic across builds.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { NodeKernelHost } from "../../../host/src/node-kernel-host";
import {
  ensureDirRecursive,
  writeVfsBinary,
} from "../../../host/src/vfs/image-helpers";
import { MemoryFileSystem } from "../../../host/src/vfs/memory-fs";
import {
  extractZipEntry,
  parseZipCentralDirectory,
  type ZipEntry,
} from "../../../host/src/vfs/zip";

/** A man page to index, addressed relative to the manpath root. */
export interface ManPageInput {
  /** e.g. "man1/grep.1" — relative to the manpath root (share/man). */
  relPath: string;
  bytes: Uint8Array;
  mode: number;
}

// 2000-01-01T00:00:00Z, matching the host makewhatis recipe's `touch -t
// 200001010000.00`. makewhatis records each page's mtime in the database, so
// pinning it keeps the output byte-identical across builds and machines.
const DETERMINISTIC_MTIME_SEC = Math.floor(Date.UTC(2000, 0, 1) / 1000);

const MANPATH_ROOT = "/share/man";

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

/**
 * Extract every `share/man/**` regular file from a -docs archive as an indexed
 * man page. Symlinks and directories are skipped; the returned relPath is
 * relative to the manpath root (the leading `share/man/` is stripped).
 */
export function manPagesFromDocsArchive(zipBytes: Uint8Array): ManPageInput[] {
  const entries: ZipEntry[] = parseZipCentralDirectory(zipBytes);
  const prefix = "share/man/";
  const pages: ManPageInput[] = [];
  for (const entry of entries) {
    if (entry.isDirectory || entry.isSymlink) continue;
    if (!entry.fileName.startsWith(prefix)) continue;
    if (entry.fileName.endsWith("/")) continue;
    // The database itself is regenerated here; never index a stale one.
    if (entry.fileName === "share/man/mandoc.db") continue;
    pages.push({
      relPath: entry.fileName.slice(prefix.length),
      bytes: extractZipEntry(zipBytes, entry),
      mode: (entry.mode & 0o777) || 0o644,
    });
  }
  return pages;
}

/** Extract the mandoc.wasm executable bytes from the man.zip bundle. */
export function mandocWasmFromManArchive(manZipBytes: Uint8Array): Uint8Array {
  const entries = parseZipCentralDirectory(manZipBytes);
  const mandoc = entries.find(
    (entry) =>
      entry.fileName === "bin/mandoc" &&
      !entry.isDirectory &&
      !entry.isSymlink,
  );
  if (!mandoc) {
    throw new Error("man.zip does not contain a regular bin/mandoc member");
  }
  return extractZipEntry(manZipBytes, mandoc);
}

/**
 * Run guest makewhatis over `pages` and return the generated mandoc.db bytes.
 * Returns an empty database's bytes is never fabricated: if there are no pages
 * the caller should skip indexing entirely (an image with no man pages has no
 * database), so this throws on an empty input rather than inventing one.
 */
export async function generateMandocDb(
  pages: readonly ManPageInput[],
  mandocWasm: Uint8Array,
  kernelWasm?: Uint8Array,
): Promise<Uint8Array> {
  if (pages.length === 0) {
    throw new Error("generateMandocDb: no man pages to index");
  }

  // Deterministic staging order so the database bytes do not depend on
  // archive iteration order.
  const ordered = [...pages].sort((a, b) => (a.relPath < b.relPath ? -1 : 1));

  const totalBytes = ordered.reduce((n, p) => n + p.bytes.byteLength, 0);
  const capacity = Math.max(32 * 1024 * 1024, totalBytes * 2 + 16 * 1024 * 1024);
  const fs = MemoryFileSystem.create(new SharedArrayBuffer(capacity));

  // makewhatis is self-contained but the kernel expects the usual scratch and
  // device dirs to exist; provide a minimal system skeleton alongside the
  // manpath tree.
  for (const dir of ["/tmp", "/dev", MANPATH_ROOT]) {
    ensureDirRecursive(fs, dir);
  }
  for (const page of ordered) {
    const dest = `${MANPATH_ROOT}/${page.relPath}`;
    ensureDirRecursive(fs, dirname(dest));
    writeVfsBinary(fs, dest, page.bytes, page.mode);
    fs.utimensat(dest, DETERMINISTIC_MTIME_SEC, 0, DETERMINISTIC_MTIME_SEC, 0);
  }

  const rootfsImage = await fs.saveImage();

  let stderr = "";
  const host = new NodeKernelHost({
    rootfsImage,
    onStderr: (_pid, bytes) => {
      stderr += new TextDecoder().decode(bytes);
    },
  });

  try {
    await host.init(kernelWasm ? toArrayBuffer(kernelWasm) : undefined);
    const exit = await host.spawn(
      toArrayBuffer(mandocWasm),
      ["makewhatis", MANPATH_ROOT],
      { env: ["PATH=/usr/bin:/bin"], uid: 0, gid: 0 },
    );
    if (exit !== 0) {
      throw new Error(
        `guest makewhatis exited ${exit}\nstderr:\n${stderr}`,
      );
    }
    const db = await host.readFileFromVfs(`${MANPATH_ROOT}/mandoc.db`);
    if (!db || db.byteLength === 0) {
      throw new Error(
        `guest makewhatis produced no ${MANPATH_ROOT}/mandoc.db` +
          `\nstderr:\n${stderr}`,
      );
    }
    return db;
  } finally {
    await host.destroy().catch(() => {});
  }
}

// CLI: generate-mandoc-db.ts <out.db> <man.zip> <docs.zip> [<docs.zip> ...]
// Used for standalone validation; the composer calls generateMandocDb directly.
async function main(): Promise<void> {
  const [outPath, manZipPath, ...docsZipPaths] = process.argv.slice(2);
  if (!outPath || !manZipPath || docsZipPaths.length === 0) {
    console.error(
      "usage: generate-mandoc-db.ts <out.db> <man.zip> <docs.zip> [<docs.zip> ...]",
    );
    process.exit(2);
  }
  const mandocWasm = mandocWasmFromManArchive(
    new Uint8Array(readFileSync(manZipPath)),
  );
  const pages: ManPageInput[] = [];
  for (const docsZip of docsZipPaths) {
    pages.push(
      ...manPagesFromDocsArchive(new Uint8Array(readFileSync(docsZip))),
    );
  }
  const db = await generateMandocDb(pages, mandocWasm);
  writeFileSync(outPath, db);
  console.error(
    `generate-mandoc-db: indexed ${pages.length} pages -> ${outPath} (${db.byteLength} bytes)`,
  );
}

const entrypoint = process.argv[1];
if (entrypoint && entrypoint.endsWith("generate-mandoc-db.ts")) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
