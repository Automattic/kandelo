/**
 * Tests for SysV IPC: message queues, semaphores, and shared memory.
 * Verifies that the SharedIpcTable is properly wired up in the kernel worker.
 */
import { describe, it, expect } from "vitest";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";
import { ensureWasm64ExampleFixture } from "./wasm64-example-fixture";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ipcBinary = join(__dirname, "../../examples/sysv_ipc_test.wasm");

describe("SysV IPC", () => {
  it.each(["wasm32", "wasm64"] as const)(
    "message queues, semaphores, and shared memory (%s)",
    async (arch) => {
      const programPath = arch === "wasm64"
        ? ensureWasm64ExampleFixture("sysv_ipc_test.c")
        : ipcBinary;
      const result = await runCentralizedProgram({
        programPath,
        timeout: 20_000,
        useDefaultRootfs: false,
      });
      console.log("stdout:", JSON.stringify(result.stdout));
      console.log("stderr:", JSON.stringify(result.stderr));
      expect(result.stdout).toContain("msgctl IPC_SET: mode=0600 qbytes=4096");
      expect(result.stdout).toContain("msgq: PASS");
      expect(result.stdout).toContain("semctl post-RMID IPC_STAT: EINVAL");
      expect(result.stdout).toContain("semctl post-RMID GETALL: EINVAL");
      expect(result.stdout).toContain("semctl post-RMID SETALL: EINVAL");
      expect(result.stdout).toContain("semctl post-RMID GETVAL: EINVAL");
      expect(result.stdout).toContain("sem: PASS");
      expect(result.stdout).toContain("shmctl IPC_SET: mode=0600 segsz=4096");
      expect(result.stdout).toContain("shm: PASS");
      expect(result.stdout).toContain("ALL TESTS PASSED");
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.hostDiagnostics).toEqual([]);
    },
    30_000,
  );
});
