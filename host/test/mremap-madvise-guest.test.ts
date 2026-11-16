import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCentralizedProgram } from "./centralized-test-helper";
import { ensureWasm64ExampleFixture } from "./wasm64-example-fixture";

const __dirname = dirname(fileURLToPath(import.meta.url));

// examples/mremap_madvise_test.c runs every check through musl and the
// syscall channel: mremap shrink, in-place growth (including a mapping's
// tail), MREMAP_MAYMOVE and MREMAP_FIXED moves with whole-page content,
// the refused cases and their errno, private and shared file mappings, and
// madvise/posix_madvise argument validation.
describe("mremap and madvise", () => {
  it("remap and advise memory through the wasm32 syscall path", async () => {
    const result = await runCentralizedProgram({
      programPath: join(__dirname, "../../examples/mremap_madvise_test.wasm"),
      argv: ["mremap-madvise-test"],
      useDefaultRootfs: false,
      timeout: 30_000,
    });

    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("MREMAP_MADVISE_PASS");
    expect(result.exitCode).toBe(0);
  }, 30_000);

  it("remap and advise memory through the wasm64 syscall path", async () => {
    ensureWasm64ExampleFixture("mremap_madvise_test.c");
    const result = await runCentralizedProgram({
      programPath: join(
        __dirname,
        "../../examples/mremap_madvise_test.wasm64.wasm",
      ),
      argv: ["mremap-madvise-test-wasm64"],
      useDefaultRootfs: false,
      timeout: 30_000,
    });

    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("MREMAP_MADVISE_PASS");
    expect(result.exitCode).toBe(0);
  }, 60_000);
});
