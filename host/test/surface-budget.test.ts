import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { findRepoRoot } from "../src/binary-tiers";

/**
 * The campaign's surfaces are ratcheted, not merely documented.
 *
 * # Why this test exists
 *
 * This campaign produced 132 plan documents and exactly one mechanism that
 * nothing ever escaped: `EXPECTED_HOST_IMPORT_COUNT` — a number in the
 * repository asserted against a measurement of the built artifact. Every
 * import change hit it, including two independent reductions that composed
 * correctly *only* because both measured rather than quoting the pin.
 *
 * Over the same period fork TypeScript grew by 2,867 lines, against a contract
 * saying it "shrinks toward the floor over time; it does not grow" — and
 * nobody noticed for weeks, because nothing measured it. That is the whole
 * argument: a document is advisory, and a number a test asserts is not.
 *
 * # Why it fails in BOTH directions
 *
 * Exceeding a ceiling fails: the surface grew. Falling well below one also
 * fails, asking for the ceiling to be lowered in the same commit. The second
 * half is what banks a reduction — without it, one lane's deletion silently
 * funds the next lane's growth, which is close to what happened here: the JS
 * fork twin was deleted (−4,643) in an earlier phase while the dedicated fork
 * files grew by nearly as much, and the two were never compared.
 *
 * # What this test is not
 *
 * It is not a quality measure. Line counts are a proxy, and a poor one for
 * anything except "is this surface getting bigger or smaller". The `target`
 * field in the budget is the campaign's goal and is deliberately far below
 * every ceiling; the gap between them is the remaining work, not slack.
 */

interface Surface {
  measure: string;
  ceiling: number;
  slack: number;
  target: number;
  why: string;
}

const repoRoot = findRepoRoot();

function budget(): Record<string, Surface> {
  const raw = readFileSync(join(repoRoot, "docs", "surface-budget.json"), "utf8");
  return (JSON.parse(raw) as { surfaces: Record<string, Surface> }).surfaces;
}

/** Count lines across a shell glob, resolved from the repo root. */
function lineCount(globs: string[]): number {
  const script = `cat ${globs.join(" ")} 2>/dev/null | wc -l`;
  const out = execFileSync("/bin/sh", ["-c", script], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return Number.parseInt(out.trim(), 10);
}

function countMatches(relPath: string, pattern: RegExp): number {
  const text = readFileSync(join(repoRoot, relPath), "utf8");
  return text.split("\n").filter((line) => pattern.test(line)).length;
}

const MEASURED: Record<string, () => number> = {
  forkTypeScript: () =>
    lineCount(["host/src/fork-*.ts", "host/src/vfork-*.ts"]),
  workerMainTypeScript: () => lineCount(["host/src/worker-main.ts"]),
  sffsTypeScript: () => lineCount(["host/src/vfs/sharedfs-vendor.ts"]),
  hostImportFunctions: () =>
    Number.parseInt(
      /EXPECTED_HOST_IMPORT_COUNT: usize = (\d+)/.exec(
        readFileSync(join(repoRoot, "crates/host-native/src/lib.rs"), "utf8"),
      )?.[1] ?? "-1",
      10,
    ),
  forkModuleEntryPoints: () =>
    countMatches(
      "crates/fork-module/src/lib.rs",
      /^\s*pub (unsafe )?extern "C" fn fm_/,
    ),
};

describe("campaign surface budget", () => {
  const surfaces = budget();

  it("measures every surface the budget declares", () => {
    // A budget entry nobody measures is the advisory document this test
    // exists to replace.
    expect(Object.keys(surfaces).sort()).toEqual(Object.keys(MEASURED).sort());
  });

  for (const [name, surface] of Object.entries(surfaces)) {
    it(`${name} has not grown past its ceiling`, () => {
      const actual = MEASURED[name]!();
      expect(
        actual,
        `${name} is ${actual}, above its ceiling of ${surface.ceiling}.\n`
          + `  measure: ${surface.measure}\n`
          + `  why it is capped: ${surface.why}\n`
          + `  Growing this surface needs an explicit decision, not a commit `
          + `that happens to add lines. If the growth is genuinely required, `
          + `raise the ceiling in docs/surface-budget.json in the same commit `
          + `and say why in the message.`,
      ).toBeLessThanOrEqual(surface.ceiling);
    });

    it(`${name} has its reduction banked in the ceiling`, () => {
      const actual = MEASURED[name]!();
      expect(
        actual,
        `${name} is ${actual}, which is more than ${surface.slack} below its `
          + `ceiling of ${surface.ceiling}.\n`
          + `  Lower the ceiling to ${actual} in docs/surface-budget.json in `
          + `this commit. An unbanked reduction silently funds the next `
          + `change's growth — which is how ${surface.ceiling === 24726 ? "this very surface" : "fork TypeScript"} `
          + `grew while a 4,643-line deletion elsewhere made it look like `
          + `progress.\n`
          + `  Target for this surface is ${surface.target}.`,
      ).toBeGreaterThan(surface.ceiling - surface.slack - 1);
    });
  }
});
