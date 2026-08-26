import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");

describe("standalone host package projection contract", () => {
  it("generates the projection before copying it into the npm package", () => {
    const script = readFileSync(
      join(repoRoot, "scripts", "prepare-host-package.sh"),
      "utf8",
    );
    // The program index is a generated artifact (gitignored): the package must
    // regenerate a fresh projection and bundle that, never copy a committed one
    // that could have drifted from another checkout.
    const generate = script.indexOf("build-deps program-index \\");
    const copy = script.indexOf(
      'cp \\\n    "$REPO_ROOT/packages/registry/program-packages.json"',
    );

    expect(generate).toBeGreaterThan(-1);
    expect(copy).toBeGreaterThan(generate);
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
