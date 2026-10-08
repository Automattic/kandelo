/**
 * MAP_SHARED mappings of one file the kernel owns -- a /dev/shm object, a
 * memfd, a /tmp file -- are views of that file. Separate mappings converge at
 * syscall boundaries, across fork and across independent opens, and descriptor
 * I/O and the mappings agree. The kernel keeps them coherent
 * (`SharedMappingTable` in crates/runtime-core/src/memory.rs).
 */
import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("MAP_SHARED coherence for kernel-owned files", () => {
  it("converges separate mappings of /dev/shm, memfd and /tmp files", async () => {
    const result = await runCentralizedProgram({
      programPath: join(
        __dirname,
        "../../examples/shm_mapping_coherence_test.wasm",
      ),
      timeout: 20_000,
      useDefaultRootfs: false,
    });

    expect(result.stdout).toContain("two-opens-one-process: PASS");
    expect(result.stdout).toContain("inherited-across-fork: PASS");
    expect(result.stdout).toContain("independent-opens: PASS");
    expect(result.stdout).toContain("memfd-across-fork: PASS");
    expect(result.stdout).toContain("descriptor-and-mapping: PASS");
    expect(result.stdout).toContain("descriptor-and-mapping-read: PASS");
    expect(result.stdout).toContain("SHM_MAPPING_COHERENCE_PASS");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  }, 30_000);
});
