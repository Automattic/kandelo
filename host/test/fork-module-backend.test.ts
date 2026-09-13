import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  FORK_MODULE_RESUME_CATALOG_CAP,
  FORK_MODULE_STATS,
} from "../src/fork-module-backend";

const moduleSource = readFileSync(
  join(import.meta.dirname, "..", "..", "crates/fork-module/src/lib.rs"),
  "utf8",
);

describe("fork-module backend constants", () => {
  it("lists the module's stats in the module's own order", () => {
    // The host indexes fm_stats by POSITION. Reading the wrong index returns a
    // plausible number from the wrong counter -- a wrong diagnostic rather than
    // an error, which is the kind of drift nothing else would catch.
    const block = moduleSource.slice(
      moduleSource.indexOf("let stats: [&AtomicU64;"),
      moduleSource.indexOf("match stats.get("),
    );
    const emitted = [...block.matchAll(/&([A-Z][A-Z_0-9]+),/g)].map((m) => m[1]);
    expect(emitted.length).toBe(FORK_MODULE_STATS.length);
    // The module names them SCREAMING_SNAKE; the host names them camelCase.
    const asSnake = FORK_MODULE_STATS.map((name) =>
      name.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase(),
    );
    expect(emitted).toEqual(asSnake);
  });

  it("matches the module's resume-catalog capacity", () => {
    // The module sizes a static `[u32; CAP]` arena from this. A host that staged
    // more than the cap would write past the end of that arena.
    const match = /const RESUME_CATALOG_CAP: usize = ([0-9_]+);/.exec(moduleSource);
    expect(match).not.toBeNull();
    expect(Number(match![1].replace(/_/g, ""))).toBe(
      FORK_MODULE_RESUME_CATALOG_CAP,
    );
  });
});
