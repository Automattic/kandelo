import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  generateMandocDb,
  mandocWasmFromManArchive,
  manPagesFromDocsArchive,
} from "../../images/vfs/scripts/generate-mandoc-db";
import { tryResolveBinary } from "../src/binary-resolver";
import { ensureDirRecursive, writeVfsBinary } from "../src/vfs/image-helpers";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import { NodeKernelHost } from "../src/node-kernel-host";

// Proves the per-image mandoc.db property that motivated dropping the global
// index package: the database an image ships is generated over EXACTLY the
// -docs bundles it registers, so an image with a subset of tools indexes only
// those pages — no phantom entries for tools it does not ship.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../..");
const programsDir = join(repoRoot, "local-binaries/source-only-v1/programs/wasm32");
const grepDocs = join(programsDir, "grep-docs.zip");
const coreutilsDocs = join(programsDir, "coreutils-docs.zip");
const manZip = join(programsDir, "man.zip");
const kernelPath = tryResolveBinary("kernel.wasm");

const available =
  kernelPath !== null &&
  [grepDocs, coreutilsDocs, manZip].every(existsSync);

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

/**
 * Boot a Kandelo instance whose /share/man carries exactly `pages` plus the
 * given mandoc.db, run `<tool> <query>` (a mandoc argv[0] front-end), and
 * return its stdout/exit. Used to query the generated index the same way the
 * shell would at runtime.
 */
async function queryIndex(
  db: Uint8Array,
  pages: { relPath: string; bytes: Uint8Array; mode: number }[],
  mandocWasm: Uint8Array,
  argv: string[],
): Promise<{ stdout: string; exitCode: number }> {
  const fs = MemoryFileSystem.create(new SharedArrayBuffer(32 * 1024 * 1024));
  for (const dir of ["/tmp", "/dev", "/share/man"]) ensureDirRecursive(fs, dir);
  for (const page of pages) {
    const dest = `/share/man/${page.relPath}`;
    ensureDirRecursive(fs, dirname(dest));
    writeVfsBinary(fs, dest, page.bytes, page.mode);
  }
  writeVfsBinary(fs, "/share/man/mandoc.db", db, 0o644);
  const rootfsImage = await fs.saveImage();

  let stdout = "";
  const host = new NodeKernelHost({
    rootfsImage,
    onStdout: (_pid, b) => {
      stdout += new TextDecoder().decode(b);
    },
  });
  try {
    await host.init(toArrayBuffer(new Uint8Array(readFileSync(kernelPath!))));
    const exitCode = await host.spawn(toArrayBuffer(mandocWasm), argv, {
      env: ["PATH=/usr/bin:/bin", "MANPATH=/share/man"],
      uid: 0,
      gid: 0,
    });
    return { stdout, exitCode };
  } finally {
    await host.destroy().catch(() => {});
  }
}

describe.skipIf(!available)("per-image mandoc.db is scoped to the image's -docs", () => {
  it("a grep-only image indexes grep but not coreutils' ls", async () => {
    const mandocWasm = mandocWasmFromManArchive(
      new Uint8Array(readFileSync(manZip)),
    );
    const grepPages = manPagesFromDocsArchive(new Uint8Array(readFileSync(grepDocs)));

    // Index over ONLY grep-docs — the subset an image shipping just grep gets.
    const grepOnlyDb = await generateMandocDb(grepPages, mandocWasm);

    // whatis grep resolves out of the scoped index.
    const grepHit = await queryIndex(grepOnlyDb, grepPages, mandocWasm, [
      "whatis",
      "grep",
    ]);
    expect(grepHit.exitCode, `whatis grep:\n${grepHit.stdout}`).toBe(0);
    expect(grepHit.stdout).toMatch(/grep\s*\(1\)/);

    // whatis ls finds NOTHING: ls is a coreutils page this image never shipped,
    // so it is absent from the scoped index (no phantom entry). mandoc's whatis
    // exits non-zero when a name is not indexed.
    const lsMiss = await queryIndex(grepOnlyDb, grepPages, mandocWasm, [
      "whatis",
      "ls",
    ]);
    expect(lsMiss.stdout).not.toMatch(/ls\s*\(1\)\s*-\s*list directory contents/);
    expect(lsMiss.exitCode, `whatis ls unexpectedly succeeded:\n${lsMiss.stdout}`)
      .not.toBe(0);
  }, 60_000);

  it("adding a bundle enlarges the index deterministically", async () => {
    const mandocWasm = mandocWasmFromManArchive(
      new Uint8Array(readFileSync(manZip)),
    );
    const grepPages = manPagesFromDocsArchive(new Uint8Array(readFileSync(grepDocs)));
    const coreutilsPages = manPagesFromDocsArchive(
      new Uint8Array(readFileSync(coreutilsDocs)),
    );

    const grepOnly = await generateMandocDb(grepPages, mandocWasm);
    const both = await generateMandocDb([...grepPages, ...coreutilsPages], mandocWasm);

    // The index scales with the pages fed in: adding coreutils grows it.
    expect(both.byteLength).toBeGreaterThan(grepOnly.byteLength);
    // Deterministic: regenerating the grep-only index yields identical bytes.
    const grepOnlyAgain = await generateMandocDb(grepPages, mandocWasm);
    expect(Buffer.from(grepOnlyAgain).equals(Buffer.from(grepOnly))).toBe(true);
  }, 90_000);
});
