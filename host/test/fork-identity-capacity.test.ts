// The identity table must hold what the programs this repo builds actually need.
//
// `fm_set_identity_group` publishes one entry per `(space, activation, owner)`
// — that is, per `__wpk_fork_global_*` / `__wpk_fork_table_*` export, summed
// over EVERY activation in the worker. The module stores them in one static
// array, and overflow returns E2BIG, which surfaces as
//
//     fork-module: fm_set_identity_group failed with errno 7
//
// and kills the fork. The cap was 512. php.wasm alone exports 1,601 of these
// and intl.so exports 4,127, so `wordpress` and `lamp` — both of which load
// intl — could not fork at all. Nothing caught it because both packages were
// BLOCKED behind php's own build failure and had never run in this worktree.
//
// This test is the thing that would have caught it: it counts the exports in
// the shipped artifacts and requires the cap to cover them. It fails when a new
// extension pushes the real need past the bound, which is the moment to act,
// rather than at a fork in a package build an hour later.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readForkResumeCatalog } from "../src/fork-resume-catalog";

import {
  WPK_FORK_GLOBAL_CATALOG_EXPORT_PREFIX,
  WPK_FORK_TABLE_CATALOG_EXPORT_PREFIX,
} from "../src/generated/abi";

const moduleSource = readFileSync(
  join(import.meta.dirname, "..", "..", "crates/fork-module/src/lib.rs"),
  "utf8",
);

/** The module's own cap, read from its source so the two cannot drift. */
function identityCap(): number {
  const match = /const GLOBAL_IDENTITY_MAX: usize = ([0-9_]+);/.exec(moduleSource);
  if (!match) throw new Error("fork-module no longer defines GLOBAL_IDENTITY_MAX");
  return Number(match[1].replace(/_/g, ""));
}

/** Count catalog exports by scanning the export section's name bytes. */
function catalogExportCount(bytes: Uint8Array): number {
  // A name scan rather than a section walk: these prefixes are long and
  // distinctive, so counting their occurrences in the module's bytes is exact
  // enough for a capacity bound and cannot desync from a hand-written parser.
  const text = Buffer.from(bytes).toString("latin1");
  let total = 0;
  for (const prefix of [
    WPK_FORK_GLOBAL_CATALOG_EXPORT_PREFIX,
    WPK_FORK_TABLE_CATALOG_EXPORT_PREFIX,
  ]) {
    let at = text.indexOf(prefix);
    while (at !== -1) {
      total += 1;
      at = text.indexOf(prefix, at + prefix.length);
    }
  }
  return total;
}

/** Every php artifact this repo stages, if it has been built. */
function phpArtifacts(): { name: string; bytes: Uint8Array }[] {
  const roots = [
    join(import.meta.dirname, "..", "..", "local-binaries", "source-only-v1", "programs", "wasm32", "php"),
    join(import.meta.dirname, "..", "..", "local-binaries", "programs", "wasm32", "php"),
  ];
  for (const dir of roots) {
    if (!existsSync(dir)) continue;
    return readdirSync(dir)
      .filter((n) => n.endsWith(".wasm") || n.endsWith(".so"))
      .map((n) => ({ name: n, bytes: readFileSync(join(dir, n)) }));
  }
  return [];
}

/** Any `const NAME: usize = N;` the module declares, read from its source. */
function moduleCap(name: string): number {
  const match = new RegExp(`const ${name}: usize = ([0-9_]+);`).exec(moduleSource);
  if (!match) throw new Error(`fork-module no longer defines ${name}`);
  return Number(match[1].replace(/_/g, ""));
}

describe("fork-module fixed caps vs a real program", () => {
  // THE CLASS, not the instance. The identity table was one static sized for
  // programs nobody had measured; it is not the only one. Every cap below is a
  // single array shared by the WHOLE worker, so the number that matters is the
  // sum across every activation a process can hold at once -- which is what
  // `wordpress` and `lamp` proved by loading php plus intl and dying.
  //
  // Headroom is reported even when passing, because "passes today" and "has
  // room for one more extension" are different facts and only the second is
  // worth trusting.
  it("holds php's resume-catalog ordinals", () => {
    const artifacts = phpArtifacts();
    if (artifacts.length === 0) {
      console.warn(
        "fork-identity-capacity: php is not built, so the resume-catalog bound " +
          "was NOT checked. Build it to exercise this test.",
      );
      return;
    }

    let total = 0;
    const per: string[] = [];
    for (const { name, bytes } of artifacts) {
      let count = 0;
      try {
        count = readForkResumeCatalog(new WebAssembly.Module(bytes)).length;
      } catch (error) {
        // ONLY "this module has no catalog section" may be treated as zero. A
        // ReferenceError or TypeError here is a bug in this test, and a broad
        // `catch { continue }` turns it into "contributes nothing" -- which is
        // how both of these assertions first shipped as `0 <= cap`, passing
        // while the module's cap was cut below php's real need. Re-throw
        // anything that is not the expected shape.
        if (error instanceof RangeError || error instanceof WebAssembly.CompileError) {
          continue; // not a wasm module we can read
        }
        if (!(error instanceof Error) || !/section/i.test(error.message)) {
          throw error;
        }
        continue; // fork-instrumented modules only; others contribute nothing
      }
      total += count;
      per.push(`${name}=${count}`);
    }
    // All three share the same population: the catalog ordinals of every
    // activation. Checking one and not the others would leave the same defect
    // behind two different names.
    for (const cap of [
      "ACTIVATION_CATALOG_ORD_CAP",
      "RESUME_CATALOG_CAP",
    ]) {
      const limit = moduleCap(cap);
      expect(
        total,
        `php needs ${total} resume-catalog ordinals against ${cap}=${limit} ` +
          `(${(limit / total).toFixed(2)}x headroom). Per-artifact: ${per.join(" ")}`,
      ).toBeLessThanOrEqual(limit);
    }
  });

  it("holds php's activation count", () => {
    const artifacts = phpArtifacts();
    if (artifacts.length === 0) return;
    // One activation per fork-instrumented module a process can hold at once.
    const acts = artifacts.filter(({ bytes }) => {
      try {
        readForkResumeCatalog(new WebAssembly.Module(bytes));
        return true;
      } catch (error) {
        if (error instanceof RangeError || error instanceof WebAssembly.CompileError) {
          return false;
        }
        if (!(error instanceof Error) || !/section/i.test(error.message)) {
          throw error;
        }
        return false;
      }
    }).length;
    for (const cap of [
      "ACTIVATION_CATALOG_MAX_ACTS",
      "ACT_GC_CODEC_MAX_ACTS",
      "TEMPLATE_ID_MAX_ACTS",
      "STATIC_ROOT_BASE_MAX_ACTS",
      "ACT_EXN_TAGS_MAX_ACTS",
      "FUNC_CATALOG_BASE_MAX_ACTS",
    ]) {
      const limit = moduleCap(cap);
      expect(
        acts,
        `php holds ${acts} activations against ${cap}=${limit}`,
      ).toBeLessThanOrEqual(limit);
    }
  });
});

describe("fork-module identity table capacity", () => {
  it("holds every catalog export a php process loads", () => {
    const artifacts = phpArtifacts();
    if (artifacts.length === 0) {
      // Absence is not a pass, and it is not a failure either: a tree that has
      // not built php cannot answer this. Say which, rather than going green.
      console.warn(
        "fork-identity-capacity: php is not built in this tree, so the capacity " +
          "bound was NOT checked against it. Build it to exercise this test.",
      );
      return;
    }
    // The interpreter plus every extension it can dlopen, because the table is
    // ONE table for the worker and a process can hold all of them at once.
    const need = artifacts.reduce((sum, a) => sum + catalogExportCount(a.bytes), 0);
    const cap = identityCap();
    expect(
      need,
      `php's artifacts need ${need} identity entries but GLOBAL_IDENTITY_MAX is ` +
        `${cap}; a fork in wordpress or lamp will fail with E2BIG. Per-artifact: ` +
        artifacts.map((a) => `${a.name}=${catalogExportCount(a.bytes)}`).join(" "),
    ).toBeLessThanOrEqual(cap);
  });
});
