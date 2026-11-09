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

  // Descriptor I/O fences the file's mappings first (`DescriptorFence` in
  // crates/runtime-core/src/memory.rs): a store made through a mapping is
  // seen by read()/sendfile()/copy_file_range()/a MAP_PRIVATE copy, and a
  // later pwrite()/ftruncate() lands after it, even when the storing process
  // is the file's only mapper and makes no further syscall.
  it("fences mapped stores before descriptor I/O on the file", async () => {
    const result = await runCentralizedProgram({
      programPath: join(
        __dirname,
        "../../examples/shm_mapping_fence_test.wasm",
      ),
      timeout: 30_000,
      useDefaultRootfs: false,
    });

    expect(result.stdout).toContain("own-pread-after-store: PASS");
    expect(result.stdout).toContain("pread-after-edge: PASS");
    expect(result.stdout).toContain("sendfile-after-edge: PASS");
    expect(result.stdout).toContain("copy-file-range-after-edge: PASS");
    expect(result.stdout).toContain("private-map-after-edge: PASS");
    expect(result.stdout).toContain("truncate-drops-mapped-store: PASS");
    expect(result.stdout).toContain("pwrite-after-mapped-store: PASS");
    expect(result.stdout).toContain("SHM_MAPPING_FENCE_PASS");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  }, 45_000);
});
