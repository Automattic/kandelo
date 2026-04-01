/**
 * Tests for SysV IPC: message queues, semaphores, and shared memory.
 * Verifies that the SharedIpcTable is properly wired up in CentralizedKernelWorker.
 */
import { describe, it, expect } from "vitest";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ipcBinary = join(__dirname, "../../examples/sysv_ipc_test.wasm");
const hasBinary = existsSync(ipcBinary);

describe.skipIf(!hasBinary)("SysV IPC", () => {
  it("message queues, semaphores, shared memory", async () => {
    const result = await runCentralizedProgram({
      programPath: ipcBinary,
      timeout: 10_000,
    });
    console.log("stdout:", JSON.stringify(result.stdout));
    console.log("stderr:", JSON.stringify(result.stderr));
    expect(result.stdout).toContain("msgq: PASS");
    expect(result.stdout).toContain("sem: PASS");
    expect(result.stdout).toContain("shm: PASS");
    expect(result.stdout).toContain("ALL TESTS PASSED");
    expect(result.exitCode).toBe(0);
  }, 15_000);
});
