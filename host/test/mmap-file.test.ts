import { describe, it, expect } from "vitest";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));
const mmapBinary = join(__dirname, "../../examples/mmap_file_test.wasm");
const hasBinary = existsSync(mmapBinary);

describe.skipIf(!hasBinary)("file-backed mmap", () => {
  it("reads file content through mmap MAP_PRIVATE", async () => {
    const result = await runCentralizedProgram({
      programPath: mmapBinary,
      timeout: 10000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("mmap read: Hello from mmap file test!");
    expect(result.stdout).toContain("mmap modified: Modified content!");
    expect(result.stdout).toContain("file still: Hello from mmap file test!");
    expect(result.stdout).toContain("msync ok");
    expect(result.stdout).toContain("PASS");
  });
});
