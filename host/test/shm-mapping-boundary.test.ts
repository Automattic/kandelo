/**
 * The kernel may skip re-comparing a kernel-owned MAP_SHARED mapping at a
 * syscall's completion when it can prove nothing wrote it since the same
 * syscall's entry (`BoundaryRecord` in crates/runtime-core/src/memory.rs).
 * These cases are the ways the bytes can still change in or around that
 * interval -- a store after quiet syscalls, a syscall's own output into the
 * mapping, a sibling thread, a signal handler, a forked process -- and check
 * that a peer sees each one no later than before.
 */
import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("MAP_SHARED publication around skipped boundary comparisons", () => {
  it("publishes every writer's bytes at the boundary it always did", async () => {
    const result = await runCentralizedProgram({
      programPath: join(
        __dirname,
        "../../examples/shm_mapping_boundary_test.wasm",
      ),
      timeout: 60_000,
      useDefaultRootfs: false,
    });

    expect(result.stdout).toContain("store-after-quiet-syscalls: PASS");
    expect(result.stdout).toContain("syscall-output-into-mapping: PASS");
    expect(result.stdout).toContain("sibling-thread-store: PASS");
    expect(result.stdout).toContain("signal-handler-store: PASS");
    expect(result.stdout).toContain("forked-child-observes-parent: PASS");
    expect(result.stdout).toContain("SHM_MAPPING_BOUNDARY_PASS");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  }, 90_000);
});
