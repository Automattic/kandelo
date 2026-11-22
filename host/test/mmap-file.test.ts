import { describe, it, expect } from "vitest";
import { join, dirname } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { resolveRootfsArtifact } from "../src/node-kernel-host";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));
const mmapBinary = join(__dirname, "../../examples/mmap_file_test.wasm");
const hasBinary = existsSync(mmapBinary);
// WHY: validate and load the image as a fixture, so source-checkout package
// provenance work cannot consume the kernel/guest/teardown deadline.
const rootfsImage = hasBinary
  ? readFileSync(resolveRootfsArtifact().selectedPath)
  : undefined;

describe.skipIf(!hasBinary)("file-backed mmap", () => {
  it("reads file content through mmap MAP_PRIVATE", async () => {
    const result = await runCentralizedProgram({
      programPath: mmapBinary,
      rootfsImage,
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
