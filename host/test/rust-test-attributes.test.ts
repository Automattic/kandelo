import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A test function without `#[test]` never runs, and nothing fails.
 *
 * This lane found two: `fork_module_host_obligation_is_pinned`, whose attribute
 * an edit of mine consumed, and `drive_table_base_reserves_slots_per_activation`,
 * which had NEVER run in any revision since it was written. Both passed once
 * enabled, so neither was hiding a defect -- but neither was defending anything
 * either, which is the H-1 hazard this repository names: a dead floor reads as
 * complete.
 *
 * Cargo does say so, as "function ... is never used". That warning sits among
 * hundreds of others in a workspace build, which is exactly why it was missed
 * twice. This turns it into a failure.
 *
 * The heuristic is deliberately narrow: inside a `#[cfg(test)] mod tests`, a
 * function taking no arguments whose body asserts something is a test. Helpers
 * take arguments or return values; a no-argument helper that asserts is
 * vanishingly rare and can be given `#[allow(dead_code)]` to say so explicitly.
 */
const repoRoot = join(import.meta.dirname, "..", "..");

const SCANNED = [
  "crates/fork-codec/src/drive_plan.rs",
  "crates/fork-codec/src/drive_plan_hints.rs",
  "crates/fork-codec/src/dylink_table_plan.rs",
  "crates/fork-codec/src/dylink_table_append.rs",
  "crates/fork-codec/src/reference_graph_builder.rs",
  "crates/fork-module-inject/src/main.rs",
  "crates/host-native/src/lib.rs",
];

function orphanedTests(source: string): string[] {
  const lines = source.split("\n");
  const orphans: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const match = /^\s*(?:async\s+)?fn ([a-z_0-9]+)\(\)\s*(->\s*[^{]*)?\{/.exec(lines[i]!);
    if (!match) continue;
    // A test returns nothing, or a `Result<()>` it can `?` through. A function
    // returning a VALUE is a helper -- `kernel_path_or_skip() -> Option<PathBuf>`
    // asserts (it panics with a provisioning message) and is not a test.
    const returns = match[2]?.replace("->", "").trim();
    if (returns !== undefined && !/^(\(\)|[A-Za-z:]*Result<\(\)\s*(,.*)?>)$/.test(returns)) {
      continue;
    }
    // Look back over the attribute/doc block immediately above.
    let j = i - 1;
    let attributed = false;
    while (j >= 0) {
      const prev = lines[j]!.trim();
      if (prev.startsWith("///") || prev.startsWith("//")) {
        j -= 1;
        continue;
      }
      if (prev.startsWith("#[")) {
        if (prev.includes("test") || prev.includes("allow(dead_code)")) attributed = true;
        j -= 1;
        continue;
      }
      break;
    }
    if (attributed) continue;
    // Does the body assert? Scan to the matching close at the same indent.
    const indent = lines[i]!.length - lines[i]!.trimStart().length;
    const close = `${" ".repeat(indent)}}`;
    let asserts = false;
    for (let k = i + 1; k < lines.length && lines[k] !== close; k += 1) {
      if (/\bassert(_eq|_ne)?!|\bpanic!/.test(lines[k]!)) {
        asserts = true;
        break;
      }
    }
    if (asserts) orphans.push(match[1]!);
  }
  return orphans;
}

describe("rust test attributes", () => {
  it("finds no asserting no-argument function without #[test]", () => {
    const found: string[] = [];
    for (const rel of SCANNED) {
      for (const name of orphanedTests(readFileSync(join(repoRoot, rel), "utf8"))) {
        found.push(`${rel}: ${name}`);
      }
    }
    expect(found).toEqual([]);
  });

  it("does not flag a helper that returns a value", () => {
    // The narrowing that keeps this usable: `kernel_path_or_skip` panics with a
    // provisioning message and is called by real tests. Flagging it would train
    // a reader to ignore this check.
    const helper = `#[cfg(test)]
mod tests {
    fn kernel_path_or_skip() -> Option<PathBuf> {
        if !path.exists() { panic!("not provisioned"); }
        Some(path)
    }
}`;
    expect(orphanedTests(helper)).toEqual([]);
  });

  it("detects an orphan when one exists", () => {
    // Without this the scanner could match nothing at all -- returning [] for
    // every input passes the assertion above perfectly.
    const orphan = `#[cfg(test)]
mod tests {
    #[test]
    fn runs() { assert_eq!(1, 1); }

    fn never_runs() {
        assert_eq!(2, 2);
    }
}`;
    expect(orphanedTests(orphan)).toEqual(["never_runs"]);
  });
});
