import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { runCentralizedProgram } from "./centralized-test-helper";

const testDir = dirname(fileURLToPath(import.meta.url));
const program = join(testDir, "../../examples/sysv_ipc_procfs_test.wasm");

describe.skipIf(!existsSync(program))("SysV IPC procfs enumeration", () => {
  it("reports live message, semaphore, and shared-memory objects", async () => {
    const result = await runCentralizedProgram({
      programPath: program,
      timeout: 10_000,
    });

    expect(result.stderr).toBe("");
    expect(result.stdout).toBe("proc-sysvipc-ok\n");
    expect(result.exitCode).toBe(0);
  }, 15_000);
});
