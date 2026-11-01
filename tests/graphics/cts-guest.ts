/**
 * Guest image and command line for the chunked upstream dEQP runners
 * (Node: host/test/graphics-cts/node-suite.cts-run.ts; browser:
 * apps/browser-demos/test/graphics-cts-suite.run.ts). Both hosts run the
 * same normally packaged executable, data and kernel.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolveBinary } from "../../host/src/binary-resolver";
import { extractZipEntry, parseZipCentralDirectory } from "../../host/src/vfs/zip";
import { ensureDirRecursive, writeVfsBinary } from "../../host/src/vfs/image-helpers";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";
import { CTS_SUITES } from "./cts-plan.mjs";

export const CTS_CASELIST_PATH = "/tmp/caselist.txt";
export const CTS_QPA_PATH = "/tmp/result.qpa";
/** A chunk's QPA is read whole; larger logs are an infrastructure failure. */
export const CTS_QPA_MAX_BYTES = 64 * 1024 * 1024;

export type CtsGuest = {
  suite: "gles2" | "egl";
  image: Uint8Array;
  kernel: Uint8Array;
  guestPath: string;
  artifacts: Record<string, string>;
};

const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Upstream arguments. `--deqp-visibility=hidden` is required: the Kandelo
 * GBM platform has no visible window or KMS presentation service, so the
 * default `windowed` visibility makes every window case NotSupported
 * (packages/registry/graphics-cts/src/tcuKandeloPlatform.cpp). The case list
 * is one path per line, which dEQP accepts for --deqp-caselist-file. */
export function ctsArguments(suite: "gles2" | "egl"): string[] {
  return [suite === "gles2" ? "deqp-gles2" : "deqp-egl", `--deqp-caselist-file=${CTS_CASELIST_PATH}`,
    "--deqp-visibility=hidden", "--deqp-archive-dir=/cts", `--deqp-log-filename=${CTS_QPA_PATH}`];
}

export function ctsCaselist(cases: readonly string[]): Uint8Array {
  return new TextEncoder().encode(cases.join("\n") + "\n");
}

/** Deadline for one guest attempt over `cases` cases. */
export function ctsAttemptDeadlineMs(cases: number, env: Record<string, string | undefined> = process.env): number {
  const base = Number(env.KANDELO_CTS_ATTEMPT_BASE_MS ?? 60_000);
  const perCase = Number(env.KANDELO_CTS_CASE_MS ?? 10_000);
  if (!(base > 0) || !(perCase > 0)) throw new Error("KANDELO_CTS_ATTEMPT_BASE_MS and KANDELO_CTS_CASE_MS must be positive");
  return base + perCase * cases;
}

export async function buildCtsGuest(suite: "gles2" | "egl"): Promise<CtsGuest> {
  const spec = CTS_SUITES[suite];
  const program = readFileSync(resolveBinary(spec.program));
  const kernel = readFileSync(resolveBinary("kernel.wasm"));
  const image = KandeloImageFs.create();
  image.setImageCapacity(16 * 1024 * 1024);
  for (const path of ["/bin", "/tmp", "/cts"]) ensureDirRecursive(image, path);
  writeVfsBinary(image, spec.guestPath, program, 0o755);
  const artifacts: Record<string, string> = { program: sha(program), kernel: sha(kernel) };
  if (suite === "gles2") {
    // The data archive is rooted at gles2/; dEQP reads it through the normal
    // VFS under --deqp-archive-dir, exactly as in the bounded GLES2 runner.
    const data = readFileSync(resolveBinary("programs/wasm32/graphics-cts/data.zip"));
    artifacts.data = sha(data);
    const entries = parseZipCentralDirectory(data);
    if (entries.length >= 5000 || entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0) >= 8 * 1024 * 1024) {
      throw new Error("CTS data archive exceeds its bounds");
    }
    const names = new Set<string>();
    for (const entry of entries) {
      const parts = entry.fileName.split("/");
      if (parts[0] !== "gles2" || parts.some(part => part === ".." || part === ".")
          || entry.fileName.includes("\\") || entry.isSymlink || names.has(entry.fileName)) {
        throw new Error(`Invalid CTS data archive member: ${entry.fileName}`);
      }
      names.add(entry.fileName);
      const path = `/cts/${entry.fileName}`;
      if (entry.isDirectory) ensureDirRecursive(image, path);
      else {
        ensureDirRecursive(image, path.slice(0, path.lastIndexOf("/")));
        writeVfsBinary(image, path, extractZipEntry(data, entry), 0o644);
      }
    }
  }
  const bytes = await image.saveImage();
  artifacts.image = sha(bytes);
  return { suite, image: bytes, kernel, guestPath: spec.guestPath, artifacts };
}
