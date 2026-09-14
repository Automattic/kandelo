import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  FORK_PHASES,
  FORK_PHASE_EXPORT,
  forkPhase,
} from "../src/fork-phase";

const MODULE_SOURCE = readFileSync(
  new URL("../../crates/fork-module/src/lib.rs", import.meta.url),
  "utf8",
);

/** A module whose `fm_phase` answers whatever the test hands it. */
function moduleAnswering(value: number): Record<string, unknown> {
  return { [FORK_PHASE_EXPORT]: () => value };
}

describe("fork phase reader", () => {
  it("names every phase the Rust module defines, at the module's own value", () => {
    // Pinned VALUE BY VALUE against the Rust constants rather than against
    // FORK_PHASES, so that reordering the host array -- which silently
    // renames every phase -- fails here instead of running the wrong entry
    // point on a process mid-fork.
    const rust = new Map<string, number>();
    for (const [, name, value] of MODULE_SOURCE.matchAll(
      /const PHASE_([A-Z_]+): u32 = (\d+);/g,
    )) {
      rust.set(name.toLowerCase().replace(/_/g, "-"), Number(value));
    }
    expect(rust.size).toBe(FORK_PHASES.length);
    for (const [name, value] of rust) {
      expect(forkPhase(moduleAnswering(value), 1)).toBe(name);
    }
  });

  it("refuses a phase value this host has no name for", () => {
    // The guard that must not be allowed to become unfailable: a module that
    // gained a phase the host was not rebuilt for has to fail HERE, where it
    // drifted, rather than return undefined and take the `else` of every
    // branch that reads it.
    const unnamed = FORK_PHASES.length;
    expect(() => forkPhase(moduleAnswering(unnamed), 1)).toThrow(
      /reported phase 6, which this host has no name for/,
    );
    // Not merely out of range at the top: a negative answer is equally unnamed.
    expect(() => forkPhase(moduleAnswering(-1), 1)).toThrow(
      /no name for/,
    );
  });

  it("refuses a module that exports no fm_phase at all", () => {
    expect(() => forkPhase({}, 1)).toThrow(/exports no fm_phase/);
    // A non-callable export of the right NAME is the same failure, not a
    // TypeError from calling a number.
    expect(() =>
      forkPhase({ [FORK_PHASE_EXPORT]: 3 }, 1),
    ).toThrow(/exports no fm_phase/);
  });

  it("calls a worker with no fork-module idle, rather than failing", () => {
    // Not a convenient default: a worker with no module is not
    // fork-instrumented, so no capture can ever have begun in it.
    expect(forkPhase(null, 1)).toBe("idle");
  });

  it("reads through to the module on every call rather than caching", () => {
    // A cached first answer is a host-side mirror of the phase by another
    // name, which is the thing this file exists to delete.
    let value = 0;
    const exports = { [FORK_PHASE_EXPORT]: () => value };
    expect(forkPhase(exports, 1)).toBe("idle");
    value = 1;
    expect(forkPhase(exports, 1)).toBe("capture");
  });
});
