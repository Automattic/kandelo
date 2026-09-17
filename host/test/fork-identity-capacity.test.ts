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
