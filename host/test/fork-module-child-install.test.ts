// Lane F stage 1e: `fm_child_install`, the ONE child-install entry.
//
// It folds the host sequence a child worker used to run -- publish the launch
// root in a COW child's control word, read the arena root out of that root's
// prefix, seed the borrowed workspace, `fm_child_seed[_borrowed]`,
// `fm_attach_child`, `fm_gc_plan_count` + `fm_drive_execute`, then null the
// merged static-root catalog -- into the module. The Node/browser host calls it
// since stage 1f (`worker-main.ts`); this file drives the whole install the way
// a child worker does: a PARENT module captures and seals, and a second module
// instance over the same memory -- the child's -- installs from the launch
// root the kernel handed the host (`forkBufAddr`).
//
// What stands in for the guest is the fixture's: wasm thunks bound into the
// child's drive table at the restore, finish-restore and rewind-begin slots,
// recording what the module drove. The static-root publish is not a stand-in:
// it is the injected shim's own `table.get` + `table.set`, which is why the
// transit-growth case below traps for real when the growth is missing.

import { describe, expect, it } from "vitest";

import {
  CHANNEL_BASE,
  DRIVE_SLOT_MODULE_STATE_SAVE,
  DRIVE_SLOT_REWIND_BEGIN,
  DRIVE_SLOT_UNWIND_BEGIN,
  DRIVE_SLOT_UNWIND_END,
  EBUSY,
  INTERN_KIND_STATIC_ROOT,
  PAGE,
  PHASE_CHILD_REPLAY,
  PHASE_IDLE,
  admitActivation,
  admitInto,
  bindActivation,
  captureArena,
  childInstance,
  driveBase,
  fixture,
  saveSlotThunk,
  sideTemplate,
  voidSlotThunk,
  type Fixture,
} from "./fork-module-capture-fixture";

const EINVAL = 22;
const PID = 7171;
/**
 * The child's archive control block: page 9, free in `fixture()`'s layout
 * (channel page 4, responder tallies page 5, admission staging page 6). Its
 * first word is the launch anchor, the only word this file reads or writes.
 */
const CONTROL = 9 * PAGE;
/** Where a borrowed child's admitted workspace sits: page 10, also free. */
const WORKSPACE = 10 * PAGE;
/**
 * What a pthread fork child finds in its copied control word: the MAIN
 * thread's anchor, not the forking thread's. Any non-anchor address will do;
 * this one is page-aligned and in memory, so only its meaning is wrong.
 */
const STALE_MAIN_ANCHOR = 11 * PAGE;
const DRIVE_SLOT_RESTORE = 3;
const DRIVE_SLOT_FINISH_RESTORE = 4;
/** `WPK_FORK_MODULE_STATE_ROOT_POINTER_WORD_OFFSET` on wasm32, in bytes. */
const ROOT_PREFIX_WORD = 4;
/**
 * The runtime prefix the borrowed cases' guest has: frame cursor + arena
 * root. A borrowed child copies the parent's prefix into a private one and
 * refuses an empty one, and the fixture's guest has none.
 */
const BORROWED_PREFIX = 2 * ROOT_PREFIX_WORD;

type Fn = (...args: number[]) => number;

interface Child {
  readonly x: Record<string, Fn>;
  readonly instance: ReturnType<typeof childInstance>;
  /** `(slot, activation-or-root)` in the order the module drove them. */
  readonly driven: Array<readonly [number, number]>;
  readonly install: (
    launchRoot: number,
    borrowedBase?: number,
    borrowedBytes?: number,
  ) => number;
  readonly transit: WebAssembly.Table;
  /** The first word of the child's control block. */
  readonly controlWord: () => number;
}

/**
 * A parent capture of three activation-0 static roots, sealed, and the anchor
 * it returned -- what the kernel hands the child's host as `forkBufAddr`.
 *
 * With a `fixedPrefix` the capture is opened here rather than by
 * `captureArena`, whose `openCapture` admits activation 0 with the fixture's
 * zero prefix; admission refuses a prefix that disagrees with the format.
 */
function capturedParent(fixedPrefix = 0): { f: Fixture; recipes: number[]; anchor: number } {
  const f = fixture();
  const ordinals = [0, 1, 2];
  let recipes: number[];
  if (fixedPrefix === 0) {
    ({ recipes } = captureArena(
      f,
      ordinals.map((ordinal) => [INTERN_KIND_STATIC_ROOT, 0, ordinal] as const),
    ));
  } else {
    const x = f.x as Record<string, Fn>;
    // Re-seeding the format starts the module clean, which releases the
    // fixture's admission; activation 0 is admitted again with the prefix.
    x.fm_set_format(4, fixedPrefix, 0, CHANNEL_BASE);
    expect(admitActivation(f, 0, { fixedPrefix }), "admitting activation 0").toBe(0);
    const base = driveBase(0);
    const table = f.instance.driveTable;
    if (table.length < base + 19) table.grow(base + 19 - table.length);
    for (const slot of [DRIVE_SLOT_MODULE_STATE_SAVE, DRIVE_SLOT_UNWIND_BEGIN]) {
      table.set(base + slot, saveSlotThunk(() => {}) as never);
    }
    table.set(base + DRIVE_SLOT_UNWIND_END, voidSlotThunk(() => {}) as never);
    x.fm_capture_begin();
    x.fm_parent_begin_capture(CHANNEL_BASE, 0);
    expect(f.errno(), "the capture opens").toBe(0);
    // The production intern entry the injected static-root scan calls; with
    // one activation the merged slot is the ordinal.
    recipes = ordinals.map((ordinal) => x.fm_static_root_recipe(ordinal));
    expect(f.errno(), "the static roots intern").toBe(0);
    x.fm_parent_seal_capture(CHANNEL_BASE);
    expect(f.errno(), "the capture seals").toBe(0);
  }
  const anchor = f.anchor();
  expect(anchor, "the capture returned activation 0's anchor").toBeGreaterThan(0);
  return { f, recipes, anchor };
}

/**
 * The child worker's side of the fork, up to the install call: a fresh module
 * told where its control block is (holding `controlWord`), its activations
 * admitted and sides bound, their drive slots bound, and the merged
 * static-root catalog filled -- the host work that stays host.
 */
function childOf(
  f: Fixture,
  options: {
    readonly controlWord: number;
    readonly roots?: readonly object[];
    readonly fixedPrefix?: number;
    readonly sides?: readonly number[];
    readonly control?: number;
  },
): Child {
  new Uint8Array(f.memory.buffer, CONTROL, 64).fill(0);
  new DataView(f.memory.buffer).setUint32(CONTROL, options.controlWord, true);
  const instance = childInstance(f, { label: "child install" });
  const x = instance.exports as unknown as Record<string, Fn>;
  x.fm_set_format(4, options.fixedPrefix ?? 0, options.control ?? CONTROL, CHANNEL_BASE);
  expect(x.fm_last_errno(), "the child's format").toBe(0);
  const sides = options.sides ?? [];
  expect(
    admitInto(x, f.memory, 0, { fixedPrefix: options.fixedPrefix ?? 0 }),
    "the child admits activation 0",
  ).toBe(0);
  for (const side of sides) {
    expect(
      admitInto(x, f.memory, side, { template: sideTemplate(side) }),
      `the child admits activation ${side}`,
    ).toBe(0);
    expect(bindActivation(x, f.memory, side), `and binds it`).not.toBeNull();
  }

  const driven: Array<readonly [number, number]> = [];
  const table = instance.driveTable;
  for (const activation of [0, ...sides]) {
    const base = driveBase(activation);
    if (table.length < base + 19) table.grow(base + 19 - table.length);
    for (const slot of [
      DRIVE_SLOT_RESTORE,
      DRIVE_SLOT_FINISH_RESTORE,
      DRIVE_SLOT_REWIND_BEGIN,
    ]) {
      table.set(
        base + slot,
        saveSlotThunk((arg) => driven.push([slot, arg])) as never,
      );
    }
  }

  const roots = options.roots ?? [];
  const catalog = instance.staticRootCatalog;
  if (catalog.length < roots.length) catalog.grow(roots.length - catalog.length);
  roots.forEach((root, slot) => catalog.set(slot, root));

  return {
    x,
    instance,
    driven,
    install: (launchRoot, borrowedBase = 0, borrowedBytes = 0) =>
      x.fm_child_install(PID, launchRoot, borrowedBase, borrowedBytes),
    transit: x.__wpk_fork_ref_gc_transit as unknown as WebAssembly.Table,
    controlWord: () => new DataView(f.memory.buffer).getUint32(CONTROL, true),
  };
}

/** Three distinct static-root identities, one per captured ordinal. */
function roots(): object[] {
  return [{ root: 0 }, { root: 1 }, { root: 2 }];
}

describe("fm_child_install", () => {
  it("installs a COW child of the main thread", () => {
    // The copied control word already holds the anchor: the parent's host
    // published it there before SYS_FORK.
    const { f, recipes, anchor } = capturedParent();
    const identities = roots();
    const child = childOf(f, { controlWord: anchor, roots: identities });

    expect(child.install(anchor), "the install answers 0").toBe(0);
    expect(child.x.fm_last_errno()).toBe(0);
    expect(child.x.fm_phase(), "and leaves the child replaying").toBe(
      PHASE_CHILD_REPLAY,
    );
    // The plan drove the guest: restore, finish-restore, then the rewind
    // begin from the launch root.
    expect(child.driven).toEqual([
      [DRIVE_SLOT_RESTORE, 0],
      [DRIVE_SLOT_FINISH_RESTORE, 0],
      [DRIVE_SLOT_REWIND_BEGIN, anchor],
    ]);
    expect(child.controlWord(), "the anchor stays published").toBe(anchor);
    // Every static root was published into the transit at `recipe + 1`...
    recipes.forEach((recipe, ordinal) => {
      expect(child.transit.get(recipe + 1), `recipe ${recipe}`).toBe(identities[ordinal]);
    });
    // ...and the merged catalog that fed the drive holds none of them now.
    for (let slot = 0; slot < child.instance.staticRootCatalog.length; slot += 1) {
      expect(child.instance.staticRootCatalog.get(slot), `catalog slot ${slot}`).toBe(
        null,
      );
    }
  });

  it("installs a COW child of a pthread from the root it was given, and publishes it", () => {
    // A pthread's fork publishes the THREAD's anchor in the thread's own
    // channel word; the child's copied control word still holds the main
    // thread's. The launch root has to come in as an argument, and the child
    // publishes it in its own control word for the next fork from it.
    const { f, anchor } = capturedParent();
    const child = childOf(f, { controlWord: STALE_MAIN_ANCHOR, roots: roots() });

    expect(child.install(anchor), "the install answers 0").toBe(0);
    expect(child.driven.at(-1), "rewinds from the thread's root").toEqual([
      DRIVE_SLOT_REWIND_BEGIN,
      anchor,
    ]);
    expect(child.controlWord(), "and published it in its own control word").toBe(
      anchor,
    );
  });

  it("installs a BORROWED child of a pthread, leaving its owner's control word alone", () => {
    // A borrowed child's control block is its PARKED OWNER's; for a vfork from
    // a pthread it names the owner's main-thread anchor, not the launch root.
    const { f, recipes, anchor } = capturedParent(BORROWED_PREFIX);
    const identities = roots();
    const child = childOf(f, {
      controlWord: STALE_MAIN_ANCHOR,
      roots: identities,
      fixedPrefix: BORROWED_PREFIX,
    });

    expect(child.install(anchor, WORKSPACE, PAGE), "the install answers 0").toBe(0);
    expect(child.x.fm_phase()).toBe(PHASE_CHILD_REPLAY);
    // Activation 0 rewinds from the child-private prefix carved at the start
    // of the admitted workspace, never from the parked parent's anchor.
    expect(child.driven).toEqual([
      [DRIVE_SLOT_RESTORE, 0],
      [DRIVE_SLOT_FINISH_RESTORE, 0],
      [DRIVE_SLOT_REWIND_BEGIN, WORKSPACE],
    ]);
    recipes.forEach((recipe, ordinal) => {
      expect(child.transit.get(recipe + 1)).toBe(identities[ordinal]);
    });
    expect(child.controlWord(), "the owner's word is not the child's to write").toBe(
      STALE_MAIN_ANCHOR,
    );
  });

  it("grows the transit past what the child instantiated, before the drive publishes", () => {
    // A child's transit is its OWN fresh table, one slot long; the plan's
    // static-root steps `table.set` at `recipe + 1`. Without the growth the
    // injected publish traps with "table index is out of bounds".
    const { f, recipes, anchor } = capturedParent();
    const child = childOf(f, { controlWord: anchor, roots: roots() });
    const maxRecipe = Math.max(...recipes);
    expect(
      child.transit.length,
      "the plan's largest recipe is past the inherited transit",
    ).toBeLessThan(maxRecipe + 2);

    expect(child.install(anchor)).toBe(0);
    expect(child.transit.length).toBeGreaterThanOrEqual(maxRecipe + 2);
  });

  it("refuses an install from any phase but idle", () => {
    const { f, anchor } = capturedParent();
    const child = childOf(f, { controlWord: anchor, roots: roots() });
    expect(child.install(anchor)).toBe(0);
    expect(child.install(anchor), "a second install").toBe(EBUSY);
    expect(child.x.fm_last_errno()).toBe(EBUSY);
  });

  it("refuses a launch root of 0", () => {
    const { f, anchor } = capturedParent();
    const child = childOf(f, { controlWord: anchor, roots: roots() });
    expect(child.install(0)).toBe(EINVAL);
    expect(child.x.fm_phase(), "and enters no phase").toBe(PHASE_IDLE);
    expect(child.driven).toEqual([]);
  });

  it("refuses a COW child with no control block to publish its root in", () => {
    const { f, anchor } = capturedParent();
    const child = childOf(f, { controlWord: anchor, roots: roots(), control: 0 });
    expect(child.install(anchor)).toBe(EINVAL);
    expect(child.x.fm_phase()).toBe(PHASE_IDLE);
    expect(child.driven).toEqual([]);
  });

  // The module does not check these words itself: the arena decode in the
  // seed is their reader, and it is what refuses each case. A check in front
  // of it survived perturbation, so there is none.
  it("refuses a launch root whose prefix names no arena, or not a page", () => {
    const { f, anchor } = capturedParent();
    const view = new DataView(f.memory.buffer);
    const word = anchor + ROOT_PREFIX_WORD;
    const arena = view.getUint32(word, true);
    expect(arena % PAGE, "the capture wrote a page-aligned arena root").toBe(0);

    view.setUint32(word, 0, true);
    const none = childOf(f, { controlWord: anchor, roots: roots() });
    expect(none.install(anchor), "no arena").toBe(EINVAL);
    expect(none.driven).toEqual([]);

    view.setUint32(word, arena + 8, true);
    const skewed = childOf(f, { controlWord: anchor, roots: roots() });
    expect(skewed.install(anchor), "a misaligned arena").toBe(EINVAL);
    expect(skewed.driven).toEqual([]);
  });

  it("refuses half a borrowed workspace", () => {
    const { f, anchor } = capturedParent(BORROWED_PREFIX);
    const base = childOf(f, { controlWord: anchor, roots: roots(), fixedPrefix: BORROWED_PREFIX });
    expect(base.install(anchor, WORKSPACE, 0), "a base with no size").toBe(EINVAL);
    const size = childOf(f, { controlWord: anchor, roots: roots(), fixedPrefix: BORROWED_PREFIX });
    expect(size.install(anchor, 0, PAGE), "a size with no base").toBe(EINVAL);
    expect(size.driven).toEqual([]);
  });

  /**
   * A parent capture with a bound SIDE activation 1, as a dlopen fork has,
   * sealed: the capture walks the sides the parent module bound.
   */
  function capturedWithSide(): { f: Fixture; anchor: number } {
    const f = fixture();
    const x = f.x as Record<string, Fn>;
    expect(admitActivation(f, 0)).toBe(0);
    expect(admitActivation(f, 1, { template: sideTemplate(1) })).toBe(0);
    expect(bindActivation(f.x, f.memory, 1)).not.toBeNull();
    for (const activation of [0, 1]) {
      const base = driveBase(activation);
      const table = f.instance.driveTable;
      if (table.length < base + 19) table.grow(base + 19 - table.length);
      for (const slot of [DRIVE_SLOT_MODULE_STATE_SAVE, DRIVE_SLOT_UNWIND_BEGIN]) {
        table.set(base + slot, saveSlotThunk(() => {}) as never);
      }
      table.set(base + DRIVE_SLOT_UNWIND_END, voidSlotThunk(() => {}) as never);
    }
    x.fm_capture_begin();
    const anchor = x.fm_parent_begin_capture(CHANNEL_BASE, 0);
    expect(f.errno(), "a two-activation capture begins").toBe(0);
    x.fm_parent_seal_capture(CHANNEL_BASE);
    expect(f.errno(), "and seals").toBe(0);
    return { f, anchor };
  }

  it("seeds every side it bound, each from its own continuation root", () => {
    const { f, anchor } = capturedWithSide();
    const child = childOf(f, { controlWord: anchor, sides: [1] });
    expect(child.install(anchor), "the install answers 0").toBe(0);
    expect(child.driven.slice(0, 4)).toEqual([
      [DRIVE_SLOT_RESTORE, 0],
      [DRIVE_SLOT_RESTORE, 1],
      [DRIVE_SLOT_FINISH_RESTORE, 0],
      [DRIVE_SLOT_FINISH_RESTORE, 1],
    ]);
    const rewinds = child.driven.slice(4);
    expect(rewinds.map(([slot]) => slot)).toEqual([
      DRIVE_SLOT_REWIND_BEGIN,
      DRIVE_SLOT_REWIND_BEGIN,
    ]);
    expect(rewinds[0]![1], "activation 0 from the launch root").toBe(anchor);
    expect(rewinds[1]![1], "activation 1 from a root of its own").not.toBe(anchor);
    expect(rewinds[1]![1]).toBeGreaterThan(0);
  });

  it("refuses a side the parent captured and this child never bound", () => {
    // The seeds walk what THIS worker bound; the arena says what the parent
    // captured. Seeding the subset would replay frames of a library the
    // child never instantiated.
    const { f, anchor } = capturedWithSide();
    const child = childOf(f, { controlWord: anchor });
    expect(child.install(anchor)).toBe(EINVAL);
    expect(child.x.fm_phase()).toBe(PHASE_IDLE);
    expect(child.driven).toEqual([]);
  });
});
