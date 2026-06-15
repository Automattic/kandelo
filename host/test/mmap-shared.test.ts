import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";
import { resolveBinary } from "../src/binary-resolver";
import { NodePlatformIO } from "../src/platform/node";

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
