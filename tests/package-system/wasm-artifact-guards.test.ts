import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("Wasm artifact guards", () => {
  it("extracts only a constant ABI through the primary and fallback paths", () => {
    const output = execFileSync(
      "bash",
      [resolve(repoRoot, "scripts", "test-wasm-artifact-guards.sh")],
      { cwd: repoRoot, encoding: "utf8" },
    );

    expect(output).toContain("test-wasm-artifact-guards.sh: ok");
  });
});
