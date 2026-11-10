import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { runCentralizedProgram } from "./centralized-test-helper";

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("fork process-memory clone", () => {
  // The grown pages are zero except the last byte, so sparse copying must
  // skip zero pages yet still find a non-zero byte at a page's end.
  it.each(["sparse", "dense"] as const)("%s copy keeps the parent's exact grown size and boundary bytes", async (forkCopy) => {
    const program = join(
      __dirname,
      "fixtures/fork-memory-clone.wasm",
    );
    const result = await runCentralizedProgram({
      programPath: program,
      argv: ["fork-memory-clone-test"],
      forkCopy,
      timeout: 30_000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toMatch(
      /FORK_MEMORY_CLONE_PASS pages=\d+ boundary=165/,
    );
    expect(result.stderr).toBe("");
  });
});
