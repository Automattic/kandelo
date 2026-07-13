import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NodePlatformIO } from "../src/platform/node";
import { runCentralizedProgram } from "./centralized-test-helper";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const program = join(repoRoot, "examples/lseek_invalid_test.wasm");

describe.skipIf(!existsSync(program))("invalid lseek guest", () => {
  it("keeps the host-file offset unchanged", async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), "kandelo-lseek-"));
    try {
      const result = await runCentralizedProgram({
        programPath: program,
        argv: ["lseek_invalid_test", join(tempRoot, "seek.bin")],
        io: new NodePlatformIO(),
        useDefaultRootfs: false,
        timeout: 10_000,
      });

      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stdout).toContain("PASS invalid lseek preserves offset");
      expect(result.stderr).toBe("");
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
