/**
 * A SysV attachment is a view of its segment. After a child writes the
 * segment and departs (shmdt or exit), the parent -- now the only attacher --
 * must see the child's bytes through the attachment it kept.
 */
import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("SysV SHM after a departed peer", () => {
  it("refreshes the sole surviving attachment with the child's writes", async () => {
    const result = await runCentralizedProgram({
      programPath: join(
        __dirname,
        "../../examples/sysv_shm_departed_peer_test.wasm",
      ),
      timeout: 20_000,
      useDefaultRootfs: false,
    });

    expect(result.stdout).toContain("fresh-attach-shmdt: PASS");
    expect(result.stdout).toContain("fresh-attach-exit: PASS");
    expect(result.stdout).toContain("inherited-attach-exit: PASS");
    expect(result.stdout).toContain("SYSV_DEPARTED_PEER_PASS");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
  }, 30_000);
});
