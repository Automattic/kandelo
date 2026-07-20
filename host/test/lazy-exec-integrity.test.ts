import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { zipSync } from "fflate";
import { ABI_VERSION } from "../src/generated/abi";
import { NodeKernelHost } from "../src/node-kernel-host";
import { MemoryFileSystem } from "../src/vfs/memory-fs";
import { parseZipCentralDirectory } from "../src/vfs/zip";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const spawnSmoke = join(repoRoot, "examples", "spawn-smoke.wasm");
const hello = join(repoRoot, "examples", "hello.wasm");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function standaloneImage(
  backingPath: string,
  declaredSize: number,
): Promise<Uint8Array> {
  const fs = MemoryFileSystem.create(new SharedArrayBuffer(32 * 1024 * 1024));
  fs.registerLazyFile(
    "/usr/bin/hello",
    pathToFileURL(backingPath).href,
    declaredSize,
    0o755,
  );
  return fs.saveImage({ metadata: { version: 1, kernelAbi: ABI_VERSION } });
}

async function archiveImage(
  backingPath: string,
  expectedZip: Uint8Array,
): Promise<Uint8Array> {
  const fs = MemoryFileSystem.create(new SharedArrayBuffer(32 * 1024 * 1024));
  fs.registerLazyArchiveFromEntries(
    pathToFileURL(backingPath).href,
    parseZipCentralDirectory(expectedZip),
    "/",
    undefined,
    {
      compressedBytes: expectedZip.byteLength,
      sha256: createHash("sha256").update(expectedZip).digest("hex"),
    },
  );
  return fs.saveImage({ metadata: { version: 1, kernelAbi: ABI_VERSION } });
}

interface RunSpawnResult {
  exitCodes: number[];
  stdout: string;
  stderr: string;
}

async function runSpawn(
  image: Uint8Array,
  runs: number,
  afterRun?: (index: number) => void,
): Promise<RunSpawnResult> {
  const stdout: Uint8Array[] = [];
  const stderr: Uint8Array[] = [];
  const host = new NodeKernelHost({
    rootfsImage: image,
    onStdout: (_pid, data) => stdout.push(new Uint8Array(data)),
    onStderr: (_pid, data) => stderr.push(new Uint8Array(data)),
  });
  await host.init();
  try {
    const parent = readFileSync(spawnSmoke);
    const program = parent.buffer.slice(
      parent.byteOffset,
      parent.byteOffset + parent.byteLength,
    );
    const exitCodes: number[] = [];
    for (let index = 0; index < runs; index++) {
      exitCodes.push(await host.spawn(
        program,
        ["spawn-smoke", "/usr/bin/hello"],
        { stdin: new Uint8Array() },
      ));
      afterRun?.(index);
    }
    return {
      exitCodes,
      stdout: Buffer.concat(stdout).toString(),
      stderr: Buffer.concat(stderr).toString(),
    };
  } finally {
    await host.destroy().catch(() => {});
  }
}

describe("Node lazy executable integrity", () => {
  it("reports a standalone byte-count mismatch as EIO", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kandelo-lazy-exec-"));
    tempDirs.push(dir);
    const backing = join(dir, "wrong.wasm");
    writeFileSync(backing, new Uint8Array([0, 97, 115, 109]));

    const result = await runSpawn(
      await standaloneImage(backing, readFileSync(hello).byteLength),
      1,
    );

    expect(result.exitCodes).toEqual([1]);
    expect(result.stderr).toContain("posix_spawn(/usr/bin/hello): I/O error");
    expect(result.stderr).not.toContain("No such file or directory");
    expect(result.stderr).not.toContain("Exec format error");
  }, 30_000);

  it("keeps a digest-failed archive retryable on Node", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kandelo-lazy-archive-"));
    tempDirs.push(dir);
    const backing = join(dir, "runtime.zip");
    const expectedZip = zipSync({ "usr/bin/hello": readFileSync(hello) });
    const corruptZip = expectedZip.slice();
    corruptZip[0] ^= 0xff;
    writeFileSync(backing, corruptZip);

    const result = await runSpawn(
      await archiveImage(backing, expectedZip),
      2,
      (index) => {
        if (index === 0) writeFileSync(backing, expectedZip);
      },
    );

    expect(result.exitCodes).toEqual([1, 0]);
    expect(result.stderr).toContain("posix_spawn(/usr/bin/hello): I/O error");
    expect(result.stdout).toContain("Hello from musl");
    expect(result.stdout).toContain("OK");
  }, 30_000);

  it("materializes a successful Node archive once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kandelo-lazy-archive-"));
    tempDirs.push(dir);
    const backing = join(dir, "runtime.zip");
    const expectedZip = zipSync({ "usr/bin/hello": readFileSync(hello) });
    writeFileSync(backing, expectedZip);

    const result = await runSpawn(
      await archiveImage(backing, expectedZip),
      2,
      (index) => {
        if (index === 0) rmSync(backing);
      },
    );

    expect(result.exitCodes).toEqual([0, 0]);
    expect(result.stdout.match(/Hello from musl/g)).toHaveLength(2);
    expect(result.stdout.match(/OK/g)).toHaveLength(2);
    expect(result.stderr).toBe("");
  }, 30_000);
});
