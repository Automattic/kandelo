/**
 * Kernel-owned MAP_SHARED mappings are pulled lazily: a process's stores are
 * compared when a peer's syscall completes (or at descriptor I/O, msync,
 * fork, exec, exit), and a pull is skipped when the host proves the process
 * has not run since the previous one (`sync_file_at_completion` and
 * `CleanStamp` in crates/runtime-core/src/memory.rs). These cases are the
 * ways the bytes can change without the writer making a publishing syscall
 * -- a store after quiet syscalls, a syscall's own output into the mapping,
 * a sibling thread, a signal handler, a forked process, a store before a
 * pipe write followed by spinning, a thread storing as it starts, a read()
 * completing into a stopped reader -- and check that a peer sees each one.
 */
import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("MAP_SHARED publication under lazy pulls", () => {
  it("delivers every writer's bytes to a peer", async () => {
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
    expect(result.stdout).toContain("visible-after-read: PASS");
    expect(result.stdout).toContain("store-at-thread-start: PASS");
    expect(result.stdout).toContain("stopped-reader-output: PASS");
    expect(result.stdout).toContain("SHM_MAPPING_BOUNDARY_PASS");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  }, 90_000);
});
