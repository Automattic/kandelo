import { describe, it, expect, vi } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { resolveBinary } from "../src/binary-resolver";
import { NodePlatformIO } from "../src/platform/node";


// This file hands each guest a 10s budget via runCentralizedProgram's
// `timeout`. Vitest's 5s default wall budget is smaller than that, so on any
// machine slower than a quiet CI runner the wall clock fires first and reports
// "Test timed out in 5000ms" instead of the guest timeout the test declared.
// Give the wall budget room to contain the guest budget; the guest timeout
// still fails the test with its own stdout/stderr diagnostics.
vi.setConfig({ testTimeout: 30_000 });

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
});
