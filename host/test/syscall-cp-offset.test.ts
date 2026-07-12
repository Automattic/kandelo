import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NodePlatformIO } from "../src/platform/node";
import { runCentralizedProgram } from "./centralized-test-helper";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const program = join(repoRoot, "examples/syscall_cp_offset_test.wasm");

describe.skipIf(!existsSync(program))("wasm32 cancellation-point syscall slots", () => {
  it("preserves a pread offset above 4 GiB", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "kandelo-syscall-cp-"));
    try {
      const result = await runCentralizedProgram({
        programPath: program,
        argv: ["syscall_cp_offset_test", join(tempRoot, "offset.bin")],
        io: new NodePlatformIO(),
        useDefaultRootfs: false,
        timeout: 10_000,
      });

      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toContain("PASS syscall_cp 64-bit offset");
      expect(result.stderr).toBe("");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
