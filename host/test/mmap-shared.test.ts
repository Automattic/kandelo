import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";
import { resolveBinary } from "../src/binary-resolver";
import { NodePlatformIO } from "../src/platform/node";
import { CentralizedKernelWorker } from "../src/kernel-worker";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "../..");
const crossProcessFixture = join(repoRoot, "examples/mmap_shared_cross_process.wasm");
const anonymousForkFixture = join(repoRoot, "examples/mmap_shared_anonymous_fork.wasm");
const munmapReuseFixture = join(repoRoot, "examples/mmap_shared_munmap_reuse.wasm");
const largePwriteFixture = join(repoRoot, "examples/mmap_shared_large_pwrite.wasm");
const itIfCrossProcessFixture = existsSync(crossProcessFixture) ? it : it.skip;
const itIfAnonymousForkFixture = existsSync(anonymousForkFixture) ? it : it.skip;
const itIfMunmapReuseFixture = existsSync(munmapReuseFixture) ? it : it.skip;
const itIfLargePwriteFixture = existsSync(largePwriteFixture) ? it : it.skip;

function createAnonymousSharedMmapHarness(refCount: number) {
  const pid = 211;
  const mapAddr = 0x3000;
  const len = 4096;
  const backingKey = "anon:test";
  const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
  const backing = {
    key: backingKey,
    path: "",
    handle: -1,
    anonymous: true,
    writable: true,
    pages: new Map([[0, new Uint8Array(len)]]),
    dirtyPages: new Set<number>(),
    refCount,
    version: 0,
  };
  const mapping = {
    fd: -1,
    fileOffset: 0,
    len,
    writable: true,
    backingKey,
    snapshot: new Uint8Array(len),
    version: 0,
  };
  const kw = Object.assign(Object.create(CentralizedKernelWorker.prototype), {
    sharedMappings: new Map([[pid, new Map([[mapAddr, mapping]])]]),
    sharedMmapBackings: new Map([[backingKey, backing]]),
  }) as CentralizedKernelWorker;
  const channel = {
    pid,
    memory,
    channelOffset: 0,
    i32View: new Int32Array(memory.buffer, 0, 1),
    consecutiveSyscalls: 0,
  };
  return {
    backing,
    channel,
    kw,
    mapAddr,
    mapping,
    processMem: new Uint8Array(memory.buffer),
  };
}

describe("anonymous MAP_SHARED host synchronization", () => {
  it("skips single-observer boundary publishes and publishes on forced handoff", () => {
    const { backing, channel, kw, mapAddr, mapping, processMem } =
      createAnonymousSharedMmapHarness(1);

    processMem[mapAddr + 23] = 0x4d;
    (kw as any).syncSharedMappingsFromProcess(channel, true);

    expect(backing.version).toBe(0);
    expect(backing.dirtyPages.size).toBe(0);
    expect(mapping.snapshot[23]).toBe(0);

    (kw as any).syncSharedMappingsFromProcess(channel, true, { force: true });

    expect(backing.version).toBe(1);
    expect(backing.dirtyPages.has(0)).toBe(true);
    expect(mapping.snapshot[23]).toBe(0x4d);
    expect(backing.pages.get(0)![23]).toBe(0x4d);
  });

  it("publishes ordinary boundaries when another mapping observes the backing", () => {
    const { backing, channel, kw, mapAddr, mapping, processMem } =
      createAnonymousSharedMmapHarness(2);

    processMem[mapAddr + 31] = 0x91;
    (kw as any).syncSharedMappingsFromProcess(channel, true);

    expect(backing.version).toBe(1);
    expect(mapping.snapshot[31]).toBe(0x91);
    expect(backing.pages.get(0)![31]).toBe(0x91);
  });
});

describe("MAP_SHARED mmap + msync", () => {
  it("writes through MAP_SHARED mapping and flushes with msync", async () => {
    const result = await runCentralizedProgram({
      programPath: resolveBinary("programs/mmap_shared_test.wasm"),
      io: new NodePlatformIO(),
      timeout: 10000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("mmap ok");
    expect(result.stdout).toContain("msync ok");
    expect(result.stdout).toContain("read back: xyz");
    expect(result.stdout).toContain("read after munmap: xyzw");
    expect(result.stdout).toContain("mremap ok");
    expect(result.stdout).toContain("PASS");
  });

  itIfCrossProcessFixture("keeps file-backed MAP_SHARED mappings coherent across processes", async () => {
    const result = await runCentralizedProgram({
      programPath: crossProcessFixture,
      io: new NodePlatformIO(),
      timeout: 10000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("inherited mapping coherent");
    expect(result.stdout).toContain("separate mapping coherent");
    expect(result.stdout).toContain("PASS");
  });

  itIfAnonymousForkFixture("keeps anonymous MAP_SHARED mappings coherent after fork", async () => {
    const result = await runCentralizedProgram({
      programPath: anonymousForkFixture,
      io: new NodePlatformIO(),
      timeout: 10000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("inherited anonymous mapping coherent");
    expect(result.stdout).toContain("reused anonymous backing coherent");
    expect(result.stdout).toContain("PASS");
  });

  itIfMunmapReuseFixture("drops page-rounded MAP_SHARED mappings before anonymous address reuse", async () => {
    const result = await runCentralizedProgram({
      programPath: munmapReuseFixture,
      io: new NodePlatformIO(),
      timeout: 10000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("partial munmap cleanup ok");
    expect(result.stdout).toContain("PASS");
  });

  itIfLargePwriteFixture("refreshes MAP_SHARED mappings after large pwrite", async () => {
    const result = await runCentralizedProgram({
      programPath: largePwriteFixture,
      io: new NodePlatformIO(),
      timeout: 10000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("large pwrite mapping coherent");
    expect(result.stdout).toContain("PASS");
  });
});
