import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ABI_VERSION } from "../src/generated/abi";
import { NodeKernelHost } from "../src/node-kernel-host";
import { MemoryFileSystem } from "../src/vfs/memory-fs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const spawnSmoke = join(repoRoot, "examples", "spawn-smoke.wasm");
const hello = join(repoRoot, "examples", "hello.wasm");
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function lazyRootfs(backingPath: string, declaredSize: number): Promise<Uint8Array> {
  const fs = MemoryFileSystem.create(new SharedArrayBuffer(32 * 1024 * 1024));
  fs.registerLazyFile(
    "/usr/bin/hello",
    pathToFileURL(backingPath).href,
    declaredSize,
    0o755,
  );
  return fs.saveImage({ metadata: { version: 1, kernelAbi: ABI_VERSION } });
}

interface RunSpawnResult {
  exitCode: number;
  exitCodes: number[];
  stdout: string;
  stderr: string;
}

interface RunSpawnOptions {
  runs: number;
  concurrent?: boolean;
  afterRun?: (index: number) => void | Promise<void>;
}

async function runSpawn(
  image: Uint8Array,
  options: RunSpawnOptions = { runs: 1 },
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
    const exitCodes: number[] = [];
    const spawn = () => host.spawn(
      parent.buffer.slice(parent.byteOffset, parent.byteOffset + parent.byteLength),
      ["spawn-smoke", "/usr/bin/hello"],
      { stdin: new Uint8Array() },
    );
    if (options.concurrent) {
      exitCodes.push(...(await Promise.all(
        Array.from({ length: options.runs }, () => spawn()),
      )));
    } else {
      for (let index = 0; index < options.runs; index++) {
        exitCodes.push(await spawn());
        await options.afterRun?.(index);
      }
    }
    return {
      exitCode: exitCodes.at(-1)!,
      exitCodes,
      stdout: Buffer.concat(stdout).toString(),
      stderr: Buffer.concat(stderr).toString(),
    };
  } finally {
    await host.destroy().catch(() => {});
  }
}

describe("Node lazy executable integrity", () => {
  it("reports a declared backing-file mismatch as EIO instead of ENOENT or ENOEXEC", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kandelo-lazy-exec-"));
    tempDirs.push(dir);
    const wrongBacking = join(dir, "wrong.wasm");
    writeFileSync(wrongBacking, new Uint8Array([0, 97, 115, 109]));
    const declaredSize = readFileSync(hello).byteLength;

    const result = await runSpawn(await lazyRootfs(wrongBacking, declaredSize));

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("posix_spawn(/usr/bin/hello): I/O error");
    expect(result.stderr).not.toContain("No such file or directory");
    expect(result.stderr).not.toContain("Exec format error");
  }, 30_000);

  it("launches a lazy executable when its backing bytes match the declaration", async () => {
    const result = await runSpawn(await lazyRootfs(hello, readFileSync(hello).byteLength));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Hello from musl");
    expect(result.stdout).toContain("OK");
    expect(result.stderr).toBe("");
  }, 30_000);

  it("materializes a successful Node lazy exec instead of refetching its backing file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kandelo-lazy-exec-"));
    tempDirs.push(dir);
    const backing = join(dir, "hello.wasm");
    const helloBytes = readFileSync(hello);
    writeFileSync(backing, helloBytes);

    const result = await runSpawn(await lazyRootfs(backing, helloBytes.byteLength), {
      runs: 2,
      afterRun(index) {
        if (index === 0) rmSync(backing);
      },
    });

    expect(result.exitCodes).toEqual([0, 0]);
    expect(result.stdout.match(/Hello from musl/g)).toHaveLength(2);
    expect(result.stdout.match(/OK/g)).toHaveLength(2);
    expect(result.stderr).toBe("");
  }, 30_000);

  it("deduplicates concurrent Node lazy exec materialization", async () => {
    const result = await runSpawn(
      await lazyRootfs(hello, readFileSync(hello).byteLength),
      { runs: 2, concurrent: true },
    );

    expect(result.exitCodes).toEqual([0, 0]);
    expect(result.stdout.match(/Hello from musl/g)).toHaveLength(2);
    expect(result.stdout.match(/OK/g)).toHaveLength(2);
    expect(result.stderr).toBe("");
  }, 30_000);
});
