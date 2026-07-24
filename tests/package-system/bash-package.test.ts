import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const bashBuilder = join(
  repoRoot,
  "packages/registry/bash/build-bash.sh",
);

describe("Bash package contract", () => {
  it("builds the programmable-completion builtins required by Homebrew", () => {
    const source = readFileSync(bashBuilder, "utf8");

    expect(source).toContain("--enable-progcomp");
    expect(source).not.toContain("--disable-progcomp");
  });
});
