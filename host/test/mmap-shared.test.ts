import { describe, it, expect } from "vitest";
import { runCentralizedProgram } from "./centralized-test-helper";
import { resolveBinary } from "../src/binary-resolver";

describe("MAP_SHARED mmap + msync", () => {
  it("writes through MAP_SHARED mapping and flushes with msync", async () => {
    const result = await runCentralizedProgram({
      programPath: resolveBinary("programs/mmap_shared_test.wasm"),
      timeout: 10000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("mmap ok");
    expect(result.stdout).toContain("msync ok");
    expect(result.stdout).toContain("read back: xyz");
    expect(result.stdout).toContain("mremap ok");
    expect(result.stdout).toContain("PASS");
  });
});
