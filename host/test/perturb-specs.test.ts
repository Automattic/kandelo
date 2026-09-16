import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Lane L's mutation specs are citations, and citations rot.
 *
 * Each trial in `docs/perturb/lane-l-*.json` names a file, a region of it
 * and a line of code to replace. That is the same shape as the comments in
 * `crates/host-native` whose anchors this lane found had rotted — ten of
 * thirteen — and it fails the same way: silently, until someone runs it.
 *
 * Running them is not cheap. The full set is a multi-minute command, and one
 * trial alone takes twenty-one minutes because its mutation breaks the
 * syscall channel and every blocking test waits out its timeout. So a spec
 * whose anchor moved would go unnoticed for as long as nobody paid that
 * cost.
 *
 * This checks the citations without applying any of them: every target file
 * exists, every scope marker is present, and every `find` occurs EXACTLY
 * once inside its scope — which is the harness's own uniqueness rule, since
 * an anchor matching twice reads identically to one that was never applied.
 */
const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SPEC_DIR = new URL("../../docs/perturb/", import.meta.url);

/**
 * A perturb run in flight has a mutation applied to one of these very files,
 * so an anchor can legitimately read as missing for the length of a trial.
 *
 * The harness leaves `.perturb-in-progress` for exactly as long as that is
 * true, so the skip is DECLARED by the run itself rather than guessed at
 * here — and the assertion below checks the declaration, because a skip
 * nobody checked reads exactly like a pass.
 */
function perturbRunInFlight(): string | null {
  try {
    return readFileSync(REPO_ROOT + ".perturb-in-progress", "utf8");
  } catch {
    return null;
  }
}

interface Trial {
  name: string;
  scope: string;
  scope_end?: string;
  find: string;
  replace: string;
}
interface Spec {
  file: string;
  verify: string;
  build?: string;
  trials: Trial[];
}

const SPECS: ReadonlyArray<readonly [string, Spec]> = readdirSync(SPEC_DIR)
  .filter((name) => name.startsWith("lane-l-") && name.endsWith(".json"))
  .sort()
  .map((name) => [
    name,
    JSON.parse(readFileSync(new URL(name, SPEC_DIR), "utf8")) as Spec,
  ]);

describe("lane L's perturbation specs still cite what they claim", () => {
  it("has specs to check at all", () => {
    // A directory that lost its specs would leave every assertion below
    // running over an empty list and still reporting a pass.
    // Floors track the COMMITTED set. The first version of this line said
    // seven, counting a spec that existed only in the working tree -- a test
    // that passes for its author and fails on checkout, which is the same
    // green-for-the-wrong-reason this file exists to prevent. Raise them when
    // specs land, never lower them to make a run pass.
    expect(SPECS.length).toBeGreaterThanOrEqual(6);
    const trials = SPECS.reduce((n, [, spec]) => n + spec.trials.length, 0);
    expect(trials).toBeGreaterThanOrEqual(20);
  });

  it("the lane document's published inventory matches this directory", () => {
    // The document has stated this inventory twice and been wrong twice: a
    // bullet list naming two specs when there were six, and a summary line
    // reading "Six specs, 20 trials" against nine and twenty-six. A count
    // maintained by hand beside a directory that grows is L-D2's shape --
    // knowledge kept in two places, with nothing comparing them. This is the
    // comparison.
    const doc = readFileSync(
      REPO_ROOT + "docs/plans/2026-09-13-lane-l-line-attribution.md",
      "utf8",
    );
    const said = doc.match(/\*\*(\d+) specs, (\d+) trials/);
    expect(
      said,
      'the lane document must carry an inventory line of the form "**N specs, M trials"',
    ).not.toBeNull();
    const trials = SPECS.reduce((n, [, spec]) => n + spec.trials.length, 0);
    expect(Number(said![1]), "specs claimed by the document").toBe(SPECS.length);
    expect(Number(said![2]), "trials claimed by the document").toBe(trials);
  });

  it("no trial is carried by two specs", () => {
    // Four trials lived in both lane-l-host-native.json and
    // lane-l-import-coverage.json. The second spec exists to give exactly
    // those four a verifier scoped to the test that covers them -- so leaving
    // them in the first meant the slow run happened anyway, and the "two
    // minutes rather than twenty" this bought was notional.
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const [file, spec] of SPECS) {
      for (const trial of spec.trials) {
        const key = JSON.stringify([
          spec.file,
          trial.scope,
          trial.find,
          trial.replace,
        ]);
        const first = seen.get(key);
        if (first === undefined) seen.set(key, file);
        else dupes.push(`${trial.name}: ${first} and ${file}`);
      }
    }
    expect(dupes, "a trial in two specs runs twice and is counted twice").toEqual([]);
  });

  for (const [name, spec] of SPECS) {
    describe(name, () => {
      it("names a file that exists", () => {
        expect(() => readFileSync(REPO_ROOT + spec.file, "utf8")).not.toThrow();
      });

      for (const trial of spec.trials) {
        it(`anchors "${trial.name}" exactly once in its scope`, (context) => {
          // Skip ONLY the trials whose own target is the file a run has
          // mutated. A run against `guest.rs` says nothing about a corpus
          // spec, and skipping those too would be a skip that covers more
          // than its reason does.
          const inFlight = perturbRunInFlight();
          if (inFlight !== null && inFlight.includes(spec.file)) {
            // ...and a marker only earns the skip while it is TRUE. A run
            // that died leaves the marker behind, and skipping on a stale one
            // would silence these trials until somebody noticed — a guard
            // switched off by the very failure it was added for. If the named
            // file is clean, the run is over and the marker is debris.
            const dirty = execFileSync(
              "git",
              ["status", "--porcelain", "--", spec.file],
              { cwd: REPO_ROOT, encoding: "utf8" },
            ).trim();
            expect(
              dirty,
              `.perturb-in-progress names ${spec.file}, but that file is `
                + "clean — so no run is applying a mutation to it and the "
                + "marker is stale. Delete it; a stale marker also stops "
                + "`xtask perturb` from starting at all.",
            ).not.toBe("");
            context.skip();
            return;
          }
          const source = readFileSync(REPO_ROOT + spec.file, "utf8");
          const start = source.indexOf(trial.scope);
          expect(
            start,
            `scope marker is gone from ${spec.file}: ${trial.scope.slice(0, 60)}`,
          ).toBeGreaterThanOrEqual(0);

          const endMarker = trial.scope_end ?? "\n    }\n";
          const end = source.indexOf(endMarker, start);
          const body = source.slice(start, end > start ? end : undefined);

          const occurrences = body.split(trial.find).length - 1;
          expect(
            occurrences,
            `"${trial.find.slice(0, 60)}" occurs ${occurrences}x in scope; the `
              + "harness requires exactly 1, because an anchor matching several "
              + "places reads identically to one that was never applied",
          ).toBe(1);
        });
      }
    });
  }
});
