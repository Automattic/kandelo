// Lane F stage 1e: `fm_child_install`, the ONE child-install entry.
//
// It folds the host sequence a child worker used to run -- publish the launch
// root in a COW child's control word, read the arena root out of that root's
// prefix, seed the borrowed workspace, seed each activation, attach, drive the
// install plan, then null the merged static-root catalog -- into the module.
// The Node/browser host calls it since stage 1f (`worker-main.ts`) and
// host-native since stage 1f-native; this file drives the whole install the way
// a child worker does: a PARENT module captures and seals, and a second module
// instance over the same memory -- the child's -- installs from the launch
// root the kernel handed the host (`forkBufAddr`).
//
// What stands in for the guest is the fixture's: wasm thunks bound into the
// child's drive table at the restore, finish-restore and rewind-begin slots,
// recording what the module drove, and the child's entry pair, so the child
// can be RUN through its module's own loop (`fm_run`) to the `fork()` that
// finishes its replay -- which is how a test sees that an install left the
// child replaying, now that no export answers the phase.
//
// The parent's fork runs to completion first (`runFork`). The pages it
// mapped keep what it sealed -- the fixture's responder never reuses a
// mapping, and the module releases a completed fork's arena only at the next
// capture -- so the child reads exactly what a COW child's copy holds. The static-root publish is not a stand-in:
// it is the injected shim's own `table.get` + `table.set`, which is why the
// transit-growth case below traps for real when the growth is missing.

import { describe, expect, it } from "vitest";

import {
  CHANNEL_BASE,
  DEFAULT_CHILD_PID,
  DRIVE_SLOT_ENTRY_START,
  DRIVE_SLOT_RESUME_START,
  DRIVE_SLOT_REWIND_BEGIN,
  DRIVE_SLOT_REWIND_END,
  EBUSY,
  INTERN_KIND_STATIC_ROOT,
  MODE_FORK,
  MODE_VFORK,
  MUNMAP_COUNTER,
  PAGE,
  REPLAY_READY_CALLS,
  admitActivation,
  admitInto,
  bindActivation,
  captureArena,
  childInstance,
  driveBase,
  fixture,
  runFork,
  saveSlotThunk,
  sideTemplate,
  voidSlotThunk,
  type Fixture,
} from "./fork-module-capture-fixture";
import { FORK_ACTIVATION_DRIVE_BINDINGS } from "../src/fork-module-backend";

/** One activation's drive-table slice, as the host binds it. */
const DRIVE_STRIDE = FORK_ACTIVATION_DRIVE_BINDINGS.length;

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
  /**
   * Run the child through its module's loop to the `fork()` that finishes
   * its replay; answers what that `fork()` returned (0 in a child).
   */
  readonly run: (mode?: number) => number;
}

const replayReadyCalls = (f: Fixture): number =>
  new DataView(f.memory.buffer).getUint32(REPLAY_READY_CALLS, true);

/**
 * A parent capture of three activation-0 static roots, sealed, and the anchor
 * it returned -- what the kernel hands the child's host as `forkBufAddr`.
 *
 * With a `fixedPrefix` the capture is opened here rather than by
 * `captureArena`, whose fork admits activation 0 with the fixture's
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
    let interned: number[] = [];
    const run = runFork(f, {
      duringCapture: () => {
        // The production intern entry the injected static-root scan calls;
        // with one activation the merged slot is the ordinal.
        interned = ordinals.map((ordinal) => x.fm_static_root_recipe(ordinal));
        expect(f.errno(), "the static roots intern").toBe(0);
      },
    });
    expect(run.forkReturn, "the capture seals and the fork completes").toBe(DEFAULT_CHILD_PID);
    recipes = interned;
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
    if (table.length < base + DRIVE_STRIDE) table.grow(base + DRIVE_STRIDE - table.length);
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
    table.set(base + DRIVE_SLOT_REWIND_END, voidSlotThunk(() => {}) as never);
  }
  // The child's entry pair. A child never runs its lexical entry: its install
  // leaves it replaying, so `fm_run` calls the replay entry.
  let childMode = MODE_FORK;
  let childReturn: number | undefined;
  table.set(
    DRIVE_SLOT_ENTRY_START,
    voidSlotThunk(() => {
      throw new Error("the child ran its LEXICAL entry: its install left it idle");
    }) as never,
  );
  table.set(
    DRIVE_SLOT_RESUME_START,
    voidSlotThunk(() => {
      childReturn = x.__wpk_fork_kernel_fork(childMode);
    }) as never,
  );

  const roots = options.roots ?? [];
  const catalog = (instance.exports.__wpk_fork_static_root_catalog as WebAssembly.Table);
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
    run: (mode = MODE_FORK) => {
      childMode = mode;
      childReturn = undefined;
      x.fm_run(0, 0, 0);
      if (childReturn === undefined) throw new Error("the child's fork() never returned");
      return childReturn;
    },
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
    // The plan drove the guest: restore, finish-restore, then the rewind
    // begin from the launch root.
    expect(child.driven).toEqual([
      [DRIVE_SLOT_RESTORE, 0],
      [DRIVE_SLOT_FINISH_RESTORE, 0],
      [DRIVE_SLOT_REWIND_BEGIN, anchor],
    ]);
    // And left the child replaying: its run goes straight to the replay
    // entry, whose fork() finishes the replay, returns 0, and tells the
    // kernel the child reached its fork site.
    const ready = replayReadyCalls(f);
    expect(child.run(), "the child's fork() returns 0").toBe(0);
    expect(replayReadyCalls(f) - ready, "SYS_FORK_REPLAY_READY, once").toBe(1);
    expect(child.controlWord(), "the anchor stays published").toBe(anchor);
    // Every static root was published into the transit at `recipe + 1`...
    recipes.forEach((recipe, ordinal) => {
      expect(child.transit.get(recipe + 1), `recipe ${recipe}`).toBe(identities[ordinal]);
    });
    // ...and the merged catalog that fed the drive holds none of them now.
    for (let slot = 0; slot < (child.instance.exports.__wpk_fork_static_root_catalog as WebAssembly.Table).length; slot += 1) {
      expect((child.instance.exports.__wpk_fork_static_root_catalog as WebAssembly.Table).get(slot), `catalog slot ${slot}`).toBe(
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
    // Only a vfork borrows, so the child's replay must reach `vfork()`: the
    // install recorded the mode, and a replay reaching `fork()` would trap.
    expect(child.run(MODE_VFORK), "the borrowed child's vfork() returns 0").toBe(0);
    // And a borrowed child may not fork again before it execs or exits: it
    // runs on its parked parent's image, which a capture would write into.
    expect(child.x.__wpk_fork_kernel_fork(MODE_FORK), "a nested fork is refused").toBe(-11);
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
    expect(child.driven).toEqual([]);
    // And enters no phase: a retry with the real root installs (from any
    // other phase it would be refused with EBUSY).
    expect(child.install(anchor), "the retry installs").toBe(0);
  });

  it("refuses a COW child with no control block to publish its root in", () => {
    const { f, anchor } = capturedParent();
    const child = childOf(f, { controlWord: anchor, roots: roots(), control: 0 });
    expect(child.install(anchor)).toBe(EINVAL);
    expect(child.driven).toEqual([]);
    // No phase entered: the same refusal again, not EBUSY.
    expect(child.install(anchor)).toBe(EINVAL);
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

  it("returns a borrowed child's bump heap on abort, which a COW child keeps", () => {
    // Moved here from `fork-bump-heap.test.ts` when the module stopped
    // exporting a way to seed a borrowed workspace outside an install. A
    // BORROWED instance's module region goes back to the kernel with its
    // parked owner's memory, so its mapped heap chunks must be returned at
    // `fm_abort` -- its last releasing call. A COW child is durable and keeps
    // them. The two installs do the same work apart from the workspace, so
    // the borrowed abort returning MORE than the COW abort is the heap.
    const unmapsOnAbort = (fixedPrefix: number, borrowed: boolean): number => {
      const { f, anchor } = capturedParent(fixedPrefix);
      const child = childOf(f, { controlWord: anchor, roots: roots(), fixedPrefix });
      expect(
        borrowed ? child.install(anchor, WORKSPACE, PAGE) : child.install(anchor),
        "the install",
      ).toBe(0);
      const unmaps = (): number => new DataView(f.memory.buffer).getUint32(MUNMAP_COUNTER, true);
      const before = unmaps();
      child.x.fm_abort();
      expect(child.x.fm_last_errno(), "abort is legal from child replay").toBe(0);
      return unmaps() - before;
    };
    const cow = unmapsOnAbort(BORROWED_PREFIX, false);
    const borrowed = unmapsOnAbort(BORROWED_PREFIX, true);
    expect(borrowed, "the borrowed child also returns its heap").toBeGreaterThan(cow);
  });

  /**
   * A parent capture with a bound SIDE activation 1, as a dlopen fork has,
   * sealed: the capture walks the sides the parent module bound.
   */
  function capturedWithSide(): { f: Fixture; anchor: number } {
    const f = fixture();
    expect(admitActivation(f, 0)).toBe(0);
    const run = runFork(f, { sides: [1] });
    expect(run.forkReturn, "a two-activation fork completes").toBe(DEFAULT_CHILD_PID);
    return { f, anchor: run.anchor };
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
    expect(child.driven).toEqual([]);
    // No phase entered: the same refusal again, not EBUSY.
    expect(child.install(anchor)).toBe(EINVAL);
  });
});
