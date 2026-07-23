import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");

describe("standalone host package projection contract", () => {
  it("checks the generated projection before copying it into the npm package", () => {
    const script = readFileSync(
      join(repoRoot, "scripts", "prepare-host-package.sh"),
      "utf8",
    );
    const check = script.indexOf("build-deps program-index-check \\");
    const copy = script.indexOf(
      'cp \\\n    "$REPO_ROOT/packages/registry/program-packages.json"',
    );

    expect(check).toBeGreaterThan(-1);
    expect(copy).toBeGreaterThan(check);
    expect(script).toContain(
      '"$REPO_ROOT/packages/registry/program-packages.json"',
    );
  });

  it("runs the checked preparation script on every npm pack", () => {
    const packageJson = JSON.parse(
      readFileSync(join(repoRoot, "host", "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };

    expect(packageJson.scripts?.prepack).toContain(
      "bash ../scripts/prepare-host-package.sh",
    );
  });
});
