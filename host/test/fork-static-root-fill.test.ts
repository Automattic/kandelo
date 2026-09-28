import { describe, expect, it } from "vitest";

import {
  admitActivation,
  bindActivation,
  DEFAULT_CHILD_PID,
  driveBase,
  DRIVE_SLOT_STATIC_ROOT_FILL,
  fillSlotThunk,
  fixture,
  runFork,
  sideTemplate,
  type Fixture,
} from "./fork-module-capture-fixture";
import { FORK_ACTIVATION_DRIVE_BINDINGS } from "../src/fork-module-backend";
import { bind } from "./support/fork-admission";

/**
 * The merged static-root catalog is filled by the GUEST, when the MODULE says.
 *
 * Activation `a`'s roots occupy `[base(a), base(a) + len_a)` in the merged
 * anyref catalog the module owns. A capture recognises a statically
 * initialised reference by finding it there and a child's install rebuilds
 * one from there, so both need the live roots in place first. The hosts used
 * to copy them one `Table.get` / `Table.set` at a time (`ForkMergedStaticRoots`
 * on Node and the browser, `fill_static_root_catalog` natively). Lane F step
 * 3c (ruling 3) moved the copy into the guest (`__wpk_fork_static_root_fill`,
 * one `table.copy`) and the decision into the module, which drives each
 * activation's shim through its drive table at the base it placed.
 *
 * What these tests pin: the module asks EVERY activation that placed roots,
 * at ITS base, before the capture opens; and a shim that copied a different
 * count than the module placed refuses the capture (`EINVAL`) before anything
 * opened, rather than letting it capture against a catalog nobody filled --
 * so the guest's `fork()` fails with -EINVAL and no child is asked for.
 */

const EINVAL = 22;

/**
 * Place activations 0 (three roots) and 1 (two roots), bind the slots a
 * capture drives, and give each a fill shim that copies `{ activation, slot }`
 * markers into the merged catalog. `short` makes activation 1's shim report
 * one root fewer than the module placed.
 */
function placedPair(short = false): {
  f: Fixture;
  asked: [number, number][];
  bases: number[];
} {
  const f = fixture();
  const merged = (f.instance.exports.__wpk_fork_static_root_catalog as WebAssembly.Table);
  const asked: [number, number][] = [];
  const bases: number[] = [];
  const lengths = [3, 2];
  for (const activation of [0, 1]) {
    if (activation !== 0) {
      expect(admitActivation(f, activation, { template: sideTemplate(activation) })).toBe(0);
    }
    // Bound as registration binds it, so a fork's registration keeps these
    // lengths.
    const row = bindActivation(f.x, f.memory, activation, 0, lengths[activation]!);
    expect(row, `binding activation ${activation}`).not.toBeNull();
    bases.push(row!.statics);
    const table = f.instance.driveTable;
    const base = driveBase(activation);
    const needed = base + FORK_ACTIVATION_DRIVE_BINDINGS.length;
    if (table.length < needed) table.grow(needed - table.length);
    table.set(
      base + DRIVE_SLOT_STATIC_ROOT_FILL,
      fillSlotThunk((at) => {
        asked.push([activation, at]);
        const length = lengths[activation]!;
        for (let slot = 0; slot < length; slot += 1) {
          merged.set(at + slot, { activation, slot } as never);
        }
        return short && activation === 1 ? length - 1 : length;
      }) as never,
    );
  }
  return { f, asked, bases };
}

describe("the merged static-root catalog", () => {
  it("is filled by every placing activation, at its base, before a capture opens", () => {
    const { f, asked, bases } = placedPair();
    const merged = (f.instance.exports.__wpk_fork_static_root_catalog as WebAssembly.Table);
    expect(merged.length, "the MODULE grew it to both slices as it placed them").toBe(5);
    expect(bases).toEqual([0, 3]);

    // What the capture sees, read while it is open.
    const seen: unknown[] = [];
    let askedAtCapture: [number, number][] = [];
    const run = runFork(f, {
      sides: [1],
      duringCapture: () => {
        askedAtCapture = [...asked];
        for (let slot = 0; slot < 5; slot += 1) seen.push(merged.get(slot));
      },
    });
    expect(run.forkReturn, "the fork completes").toBe(DEFAULT_CHILD_PID);
    expect(askedAtCapture, "each activation, once, at the base the module placed").toEqual([
      [0, 0],
      [1, 3],
    ]);
    for (const [activation, base, length] of [[0, 0, 3], [1, 3, 2]] as const) {
      for (let slot = 0; slot < length; slot += 1) {
        expect(seen[base + slot], `activation ${activation} ordinal ${slot}`)
          .toMatchObject({ activation, slot });
      }
    }
  });

  it("refuses the capture when a guest's copy disagrees with the placement", () => {
    const { f, asked } = placedPair(true);
    let opened = false;
    const run = runFork(f, {
      sides: [1],
      duringCapture: () => {
        opened = true;
      },
    });
    expect(opened, "nothing opened").toBe(false);
    expect(run.forkReturn, "fork() fails with the refusal").toBe(-EINVAL);
    expect(run.forkCalls, "and no child is asked for").toBe(0);
    expect(asked.map(([activation]) => activation)).toEqual([0, 1]);
  });

  it("the host binds the fill shim at the slot the module drives", () => {
    const binding = FORK_ACTIVATION_DRIVE_BINDINGS.find(
      ({ name }) => name === "__wpk_fork_static_root_fill",
    );
    expect(binding?.slot).toBe(DRIVE_SLOT_STATIC_ROOT_FILL);
    expect(binding?.required, "a guest without roots exports none").toBe(false);
  });

  it("MODULE: the same length answers the same base; a different one is refused", () => {
    const f = fixture();
    const place = (activation: number, length: number): number => {
      if (activation !== 0) admitActivation(f, activation, { template: sideTemplate(activation) });
      return bind(f.x, f.memory, activation, 0, length)?.statics ?? -1;
    };
    expect(place(1, 4)).toBe(0);
    expect(place(2, 8)).toBe(4);
    expect(place(1, 4), "asked again, the range it holds").toBe(0);
    expect(f.errno()).toBe(0);
    expect(place(1, 5), "a second catalog for one activation").toBe(-1);
    expect(f.errno()).toBe(22);
  });
});
