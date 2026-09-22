import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { afterAll, expect } from "vitest";
import { resolveBinary } from "../src/binary-resolver";
import { instantiateForkModule } from "../src/fork-module-instance";
import {
  FORK_ACTIVATION_DRIVE_SLOTS,
  ForkModuleContinuationBackend,
} from "../src/fork-module-backend";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FAITHFUL_GUEST_BYTES } from "./fork-module-faithful-guest";

/**
 * The first test that reaches `begin_capture_impl`.
 *
 * Every path in that function was unreachable from this suite, because opening a
 * capture allocates its arena with `SYS_MMAP` over the guest syscall channel and
 * nothing here serviced it -- the module would block rather than fail, which is
 * why `crates/fork-module/tests/harness-capture.mjs` says twice that its success
 * paths are out of reach. Two defects landed in that function in a single day and
 * both were found by re-reading, not by anything running:
 *
 *   - a record write through `mem.get_mut` on the ill-formed whole-memory slice
 *     (census section 141), which would have failed EINVAL on the first capture;
 *   - reserving Module records into an arena the module did not own, which
 *     silently started a SECOND arena nothing reads (section 142).
 *
 * This test exists so the next one fails here instead. What makes it possible is
 * a channel responder: a worker that answers the module's `SYS_MMAP` by handing
 * back addresses from a region this test reserved.
 */

export const PAGE = 65536;
// Channel header layout, mirrored from `crates/shared/src/lib.rs` (`channel`).
const STATUS_OFFSET = 0;
const SYSCALL_OFFSET = 4;
const ARGS_OFFSET = 8;
const ARG_SIZE = 8;
const RETURN_OFFSET = ARGS_OFFSET + 6 * ARG_SIZE;
const ERRNO_OFFSET = RETURN_OFFSET + 8;
const STATUS_IDLE = 0;
const STATUS_PENDING = 1;
const STATUS_COMPLETE = 2;
const SYS_MMAP = 46;
const SYS_MUNMAP = 47;

// Drive-table slots the capture plan drives, from `fork_codec::drive_plan`.
export const DRIVE_SLOT_REWIND_BEGIN = 5;
export const DRIVE_SLOT_ABORT_BEGIN = 6;
export const DRIVE_SLOT_UNWIND_END = 7;
export const DRIVE_SLOT_REWIND_END = 8;
export const DRIVE_SLOT_ABORT_END = 9;
export const DRIVE_SLOT_UNWIND_BEGIN = 10;
export const DRIVE_SLOT_MODULE_STATE_SAVE = 13;

// `fm_module_state_arena` operations.
export const ARENA_ROOT = 0;
export const ARENA_OWNED = 3;

/** `fm_phase` values, from the PHASE_* constants in crates/fork-module. */
export const PHASE_IDLE = 0;
export const PHASE_CAPTURE = 1;
export const PHASE_SEALED_PARENT = 2;
export const PHASE_PARENT_REPLAY = 3;
export const PHASE_CHILD_REPLAY = 4;
export const PHASE_ABORT_REPLAY = 5;

/** `fm_borrowed_replay_workspace` fields. */
export const WORKSPACE_PREFIX = 0;
export const WORKSPACE_SCRATCH = 1;

export const EBUSY = 16;

export const CHANNEL_BASE = 4 * PAGE;
export const MODULE_BASE = 8 * 1024 * 1024;
/** Where the responder hands out mappings from: above everything else in use. */
/**
 * A u32 the responder increments on every `SYS_MUNMAP`, so a test can assert
 * that something was FREED rather than only that it was allocated.
 *
 * Page 5 is free: the channel is page 4 and `MODULE_BASE` is 8 MiB.
 */
export const MUNMAP_COUNTER = 5 * PAGE;

/**
 * A u32 the responder increments on every `SYS_MMAP`, four bytes above the
 * munmap tally on the same free page.
 *
 * BOTH HALVES, the same reason the munmap tally exists. A chunk count walks a
 * chain, so it is blind in two directions at once: a chunk unlinked but never
 * unmapped reads as released, and a count that returns to zero says nothing
 * about how many mappings were taken to get there. A test that asserts "one
 * chunk appeared" wants to know one mapping was taken, not that the chain has
 * length one for some other reason.
 */
export const MMAP_COUNTER = 5 * PAGE + 4;

export const MMAP_FLOOR = 12 * 1024 * 1024;
/** Where a CHILD worker's own module instance sits in the shared memory. */
export const CHILD_MODULE_BASE = 20 * 1024 * 1024;

/**
 * A worker that answers the module's channel syscalls.
 *
 * The module publishes a request, stores PENDING and blocks in
 * `memory.atomic.wait32`. Nothing else can answer it: the calling thread is
 * inside the wasm call. So the responder runs on its own thread, bump-allocates
 * for `SYS_MMAP`, accepts `SYS_MUNMAP`, and refuses anything else with EINVAL
 * rather than inventing a plausible answer.
 */
/**
 * The channel responder script, shared.
 *
 * Exported because identity storage became on-demand: any test that publishes
 * an identity now needs a serviced channel, not just the capture-drive tests.
 * One responder rather than a copy per file keeps them answering the same way.
 */
const CHANNEL_RESPONDER = `
const { parentPort, workerData } = require("node:worker_threads");
const { sab, channelBase, floor, mmapCounter, munmapCounter } = workerData;
const i32 = new Int32Array(sab);
const dv = new DataView(sab);
// The tallies are OPTIONAL, because their address is not safe everywhere.
// This fixture keeps them on page 5, which is free in its own layout; a
// harness whose guest claims that page would have its data overwritten by a
// counter it never reads. A responder started without them answers the same
// way and counts nothing.
const countMmap = typeof mmapCounter === "number";
const countMunmap = typeof munmapCounter === "number";
const statusIndex = (channelBase + ${STATUS_OFFSET}) / 4;
let next = floor;
let stop = false;
parentPort.on("message", (m) => { if (m === "stop") stop = true; });
while (!stop) {
  if (Atomics.load(i32, statusIndex) !== ${STATUS_PENDING}) {
    Atomics.wait(i32, statusIndex, ${STATUS_IDLE}, 20);
    continue;
  }
  const nr = dv.getUint32(channelBase + ${SYSCALL_OFFSET}, true);
  const size = Number(dv.getBigInt64(channelBase + ${ARGS_OFFSET} + ${ARG_SIZE}, true));
  let ret = -1n, errno = 22;
  if (nr === ${SYS_MMAP}) {
    const addr = next;
    next += Math.ceil(size / ${PAGE}) * ${PAGE};
    if (countMmap) dv.setUint32(mmapCounter, dv.getUint32(mmapCounter, true) + 1, true);
    ret = BigInt(addr); errno = 0;
  } else if (nr === ${SYS_MUNMAP}) {
    if (countMunmap) dv.setUint32(munmapCounter, dv.getUint32(munmapCounter, true) + 1, true);
    ret = 0n; errno = 0;
  }
  dv.setBigInt64(channelBase + ${RETURN_OFFSET}, ret, true);
  dv.setUint32(channelBase + ${ERRNO_OFFSET}, errno, true);
  Atomics.store(i32, statusIndex, ${STATUS_COMPLETE});
  Atomics.notify(i32, statusIndex);
}
`;

/**
 * Start a channel responder for a harness that builds its own module instance.
 *
 * WHY EVERY RESUME HARNESS NEEDS ONE NOW. Seeding a catalog REGISTERS it, and
 * registration allocates the activation's `(ordinal, slot)` record in the
 * arena -- which maps its chunks with `channel_mmap`. Three files seeded
 * catalogs against a channel base that was a real address with nobody behind
 * it, on the stated grounds that "nothing here issues a syscall". That stopped
 * being true, and the failure is the worst kind: `channel_syscall` publishes
 * its request and parks in `memory_atomic_wait32` with no deadline, so the
 * test does not fail, it HANGS, and a hung file takes its vitest worker with
 * it.
 *
 * `floor` is where the responder starts handing out addresses. It must sit
 * above everything the harness has placed -- guest memory, module region,
 * staged catalogs -- because the responder does not grow the memory and does
 * not check for overlap.
 *
 * The worker is registered for teardown with the fixtures' own, so a caller
 * that imports this gets the same `afterAll` cleanup.
 */
export function startChannelResponder(options: {
  readonly memory: WebAssembly.Memory;
  readonly channelBase: number;
  readonly floor: number;
  /**
   * Where to keep the running `SYS_MMAP` / `SYS_MUNMAP` tallies, for a caller
   * that asserts on them.
   *
   * OPTIONAL BECAUSE THE ADDRESS IS NOT SAFE EVERYWHERE -- it used to be
   * hard-coded at page 5, which is free in this file's layout and inside the
   * guest's claim in `fork-resume-assignment`, where a counter written there
   * would overwrite guest data. But an omitted tally is a tally that reads
   * ZERO, and a test asserting `munmaps() - before === 2` against a silently
   * disabled counter fails for a reason that has nothing to do with the
   * module. That happened, once, in the edit that made this optional; passing
   * the responder through ONE typed entry point is what makes it a compile-
   * time decision instead of a workerData field a caller can forget.
   */
  readonly counters?: { readonly mmap: number; readonly munmap: number };
}): Worker {
  const worker = new Worker(CHANNEL_RESPONDER, {
    eval: true,
    workerData: {
      sab: options.memory.buffer,
      channelBase: options.channelBase,
      floor: options.floor,
      mmapCounter: options.counters?.mmap,
      munmapCounter: options.counters?.munmap,
    },
  });
  live.push(worker);
  return worker;
}

/**
 * A module exporting one `() -> ()` function, for the no-argument drive band.
 *
 * The guest double's exports are all `(i32) -> ()` or `() -> i32`, and neither
 * is callable where the shim `call_indirect`s a `() -> ()` — a type mismatch
 * traps rather than mis-calling, which is the right failure but not a usable
 * stub. Twenty-four bytes is cheaper than another double.
 */
// prettier-ignore
const NOP_MODULE_BYTES = new Uint8Array([
  0,97,115,109,1,0,0,0,      // magic + version
  1,4,1,0x60,0,0,            // type: () -> ()
  3,2,1,0,                   // func: one, type 0
  7,7,1,3,110,111,112,0,0,   // export "nop" = func 0
  10,4,1,2,0,0x0b,           // code: empty body
]);

export interface Fixture {
  x: Record<string, unknown>;
  instance: ReturnType<typeof instantiateForkModule>;
  memory: WebAssembly.Memory;
  errno: () => number;
  arena: (op: number, arg?: number) => number;
  worker: Worker;
}

const live: Worker[] = [];

/**
 * Every module instance this file hands out, as its `fm_stats` reader.
 *
 * BOTH FACTORIES REGISTER, and that is ruling D1-a's whole point. Registering
 * only `arenaFixture()` would have covered the three fixtures that allocate
 * NOTHING while leaving `fixture()` -- the capture rig the rest of the fork
 * suite uses, and the one whose activations the D1-a reasoning is actually
 * written about -- unchecked. A bound that is only asserted where it cannot
 * be exceeded is the guard-whose-failure-is-silent the ruling rejects.
 */
const liveStatsReaders: Array<(field: number) => number> = [];

afterAll(() => {
  for (const w of live) {
    w.postMessage("stop");
    void w.terminate();
  }
});

export function fixture(): Fixture {
  const memory = new WebAssembly.Memory({
    initial: 256,
    maximum: 16384,
    shared: true,
  });
  const fm = instantiateForkModule({
    module: new WebAssembly.Module(readFileSync(resolveBinary("fork_module32.wasm"))),
    memory,
    ptrWidth: 4,
    reserve: () => MODULE_BASE,
    label: "capture drive",
  });
  const x = fm.exports as Record<string, unknown>;

  // Callable stubs for the slots the capture plan drives. Both are `(i32) -> ()`
  // on wasm32, so the guest double's recorded-call exports stand in for the
  // guest's own save and unwind-begin.
  const guest = new WebAssembly.Instance(
    new WebAssembly.Module(FAITHFUL_GUEST_BYTES),
    { env: { __wpk_fork_publish: () => {} } },
  ).exports as Record<string, CallableFunction>;

  const worker = startChannelResponder({
    memory,
    channelBase: CHANNEL_BASE,
    floor: MMAP_FLOOR,
    counters: { mmap: MMAP_COUNTER, munmap: MUNMAP_COUNTER },
  });

  (x.fm_set_format as (...a: number[]) => void)(4, 0, 0, 0, CHANNEL_BASE);
  const base = (x.fm_drive_table_base as (a: number) => number)(0);
  const table = fm.driveTable;
  if (table.length < base + 14) table.grow(base + 14 - table.length);
  // Every slot the parent lifecycle drives. The guest double's three exports
  // are all `(i32) -> ()`, which is the signature of both the activation-argument
  // band and, on wasm32, the pointer band -- so they stand in for each. The
  // no-argument band (unwind/rewind/abort end) is driven as `() -> ()`, and a
  // `(i32) -> ()` entry is NOT callable there, so those slots take the double's
  // zero-argument export instead.
  for (const slot of [
    DRIVE_SLOT_MODULE_STATE_SAVE,
    DRIVE_SLOT_UNWIND_BEGIN,
    DRIVE_SLOT_REWIND_BEGIN,
    DRIVE_SLOT_ABORT_BEGIN,
  ]) {
    table.set(base + slot, guest.gc_allocate as never);
  }
  const nop = (
    new WebAssembly.Instance(new WebAssembly.Module(NOP_MODULE_BYTES))
      .exports as Record<string, CallableFunction>
  ).nop;
  for (const slot of [
    DRIVE_SLOT_UNWIND_END,
    DRIVE_SLOT_REWIND_END,
    DRIVE_SLOT_ABORT_END,
  ]) {
    table.set(base + slot, nop as never);
  }

  const call = x.fm_module_state_arena as (o: number, a: number) => bigint;
  // Ruling D1-a: this rig holds activations, so it is the one that most needs
  // the directory bound checked at teardown.
  liveStatsReaders.push((field) => Number((x.fm_stats as (n: number) => bigint)(field)));
  return {
    x,
    instance: fm,
    memory,
    errno: () => (x.fm_last_errno as () => number)(),
    arena: (op, arg = 0) => Number(call(op, arg)),
    worker,
  };
}

/** Put a template id for `activation` in guest memory and seed it. */
export function seedTemplateId(f: Fixture, activation: number, at: number): void {
  (f.x.fm_set_activation_template_id as (a: number, p: number) => void)(
    activation,
    at,
  );
}

export function saveSlotThunk(body: (activation: number) => void): CallableFunction {
  const directory = mkdtempSync(join(tmpdir(), "fork-save-slot-"));
  try {
    const watPath = join(directory, "save.wat");
    const wasmPath = join(directory, "save.wasm");
    writeFileSync(
      watPath,
      '(module (import "env" "save" (func $s (param i32)))' +
        ' (func (export "save") (param i32) (local.get 0) (call $s)))',
    );
    execFileSync("wat2wasm", [watPath, "-o", wasmPath]);
    const instance = new WebAssembly.Instance(
      new WebAssembly.Module(readFileSync(wasmPath)),
      { env: { save: body } },
    );
    return instance.exports.save as CallableFunction;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** A `() -> ()` wasm function, for drive slots called with no argument. */
export function voidSlotThunk(body: () => void): CallableFunction {
  const directory = mkdtempSync(join(tmpdir(), "fork-void-slot-"));
  try {
    const watPath = join(directory, "v.wat");
    const wasmPath = join(directory, "v.wasm");
    writeFileSync(
      watPath,
      '(module (import "env" "v" (func $v)) (func (export "v") (call $v)))',
    );
    execFileSync("wat2wasm", [watPath, "-o", wasmPath]);
    const instance = new WebAssembly.Instance(
      new WebAssembly.Module(readFileSync(wasmPath)),
      { env: { v: body } },
    );
    return instance.exports.v as CallableFunction;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}


export interface ChildModuleOptions {
  /** The single residual externref host seam, when the caller decodes one. */
  readonly resolveExternref?: (handle: number) => unknown;
  readonly label?: string;
  /**
   * Where this child's module region goes.
   *
   * A test with TWO children needs two: the module's statics live in the
   * guest's memory at `__memory_base`, so two instances reserved at the same
   * address are one set of statics wearing two names -- which is exactly what
   * a COW child inherits on purpose, and exactly wrong for two peer workers.
   */
  readonly moduleBase?: number;
}

/** The child module's EXPORTS. Most callers want only these. */
export function childModule(
  f: Fixture,
  options: ChildModuleOptions = {},
): Record<string, unknown> {
  return childInstance(f, options).exports as Record<string, unknown>;
}

/**
 * The child module's INSTANCE.
 *
 * A funcref decode needs more than the exports: the module resolves a recipe to
 * a slot in the MERGED function catalog it imported at init, and only the
 * instance carries that table for a test to fill.
 */
export function childInstance(
  f: Fixture,
  options: ChildModuleOptions = {},
): ReturnType<typeof instantiateForkModule> {
  const base = options.moduleBase ?? CHILD_MODULE_BASE;
  const needed = base + 8 * 1024 * 1024;
  if (f.memory.buffer.byteLength < needed) {
    f.memory.grow(Math.ceil((needed - f.memory.buffer.byteLength) / PAGE));
  }
  const child = instantiateForkModule({
    module: new WebAssembly.Module(
      readFileSync(resolveBinary("fork_module32.wasm")),
    ),
    memory: f.memory,
    ptrWidth: 4,
    reserve: () => base,
    label: options.label ?? "child module",
    ...(options.resolveExternref
      ? { hostImports: { resolve_externref: options.resolveExternref } }
      : {}),
  });
  const cx = child.exports as Record<string, unknown>;
  (cx.fm_set_format as (...a: number[]) => void)(4, 0, 0, 0, CHANNEL_BASE);
  return child;
}


/** `fm_capture_intern` kinds, mirrored from the module's `INTERN_KIND_*`. */
export const INTERN_KIND_FUNCREF = 1;
export const INTERN_KIND_EXTERNREF = 2;
export const INTERN_KIND_I31 = 3;
export const INTERN_KIND_STATIC_ROOT = 4;

/**
 * Options shared by the two capture entry points.
 */
export interface CaptureOptions {
  /**
   * SIDE activation ids, as a dlopen fork has: activation 0 is the main
   * module, each id here a side module added to the SAME capture. Each gets
   * its own template id, its own drive slots, and its own `Module` record in
   * the arena -- so a reference naming it decodes against its own activation
   * rather than activation 0's.
   */
  readonly sideActivations?: readonly number[];
}

/**
 * Seed every activation the capture will declare, then open the capture.
 *
 * Activation 0 is always present. A side activation reaches the module as an
 * `(id, fixedPrefix)` u32 pair in the sides vector `fm_parent_begin_capture`
 * reads -- the same 8-byte record the child seed reads back.
 */
export function openCapture(f: Fixture, sides: readonly number[] = []): void {
  seedTemplateId(f, 0, 2048);
  expect(f.errno(), "template id for activation 0").toBe(0);
  sides.forEach((activation, index) => {
    // A real dlopen fork's side module hashes to its OWN template id; write
    // distinct bytes so the arena's Module records are distinguishable rather
    // than two activations claiming one id -- a state production cannot
    // produce. NOTHING GATES THIS TODAY: filling these 32 bytes with zeros,
    // which makes every activation's id identical, leaves every caller of this
    // fixture passing. It is here because a fixture that produces an
    // impossible state teaches the next reader the wrong thing, not because a
    // test would catch its removal.
    const at = 2048 + (index + 1) * 64;
    new Uint8Array(f.memory.buffer, at, 32).fill(0xb0 + index);
    seedTemplateId(f, activation, at);
    expect(f.errno(), `template id for activation ${activation}`).toBe(0);
  });

  for (const activation of [0, ...sides]) {
    const base = (f.x.fm_drive_table_base as (a: number) => number)(activation);
    const needed = base + FORK_ACTIVATION_DRIVE_SLOTS;
    if (f.instance.driveTable.length < needed) {
      f.instance.driveTable.grow(needed - f.instance.driveTable.length);
    }
    for (const slot of [DRIVE_SLOT_MODULE_STATE_SAVE, DRIVE_SLOT_UNWIND_BEGIN]) {
      f.instance.driveTable.set(base + slot, saveSlotThunk(() => {}) as never);
    }
    f.instance.driveTable.set(
      base + DRIVE_SLOT_UNWIND_END,
      voidSlotThunk(() => {}) as never,
    );
  }

  // Low scratch, beside the template ids: the responder bump-allocates its
  // mmaps upward from `MMAP_FLOOR`, so staging there would be handed out from
  // under this vector by the capture's own arena allocation.
  let sidesPtr = 0;
  if (sides.length > 0) {
    sidesPtr = 4096;
    const view = new DataView(f.memory.buffer);
    sides.forEach((activation, index) => {
      view.setUint32(sidesPtr + index * 8, activation, true);
      view.setUint32(sidesPtr + index * 8 + 4, 0, true);
    });
  }

  (f.x.fm_capture_begin as () => void)();
  (f.x.fm_parent_begin_capture as (...a: number[]) => number)(
    CHANNEL_BASE,
    0,
    sidesPtr,
    sides.length,
  );
  expect(f.errno(), "the capture opens").toBe(0);
}

/**
 * Capture a sealed arena THROUGH THE MODULE and return its root.
 *
 * The alternative -- which eight `fork-module-*.test.ts` files still do -- is to
 * build the arena in TypeScript with the set-aside `ForkModuleStateArena` and
 * `appendSegmentedForkReferenceTransaction`. That is a second implementation of
 * a module-owned binary format, and a test written against it proves the two
 * implementations agree rather than that the module is right.
 *
 * `interned` is applied in order between begin and seal; each entry returns its
 * recipe id, and the caller gets them back so it can decode what it interned.
 * Node 0 is always the canonical null the module reserves.
 */
export function captureArena(
  f: Fixture,
  interned: readonly (readonly [kind: number, a: number, b: number])[],
  options: CaptureOptions = {},
): { root: number; recipes: number[] } {
  openCapture(f, options.sideActivations ?? []);
  const intern = f.x.fm_capture_intern as (k: number, a: number, b: number) => number;
  const recipes = interned.map(([kind, a, b]) => {
    const id = intern(kind, a, b);
    expect(f.errno(), `intern kind ${kind}`).toBe(0);
    expect(id, `intern kind ${kind} returns a recipe`).toBeGreaterThan(0);
    return id;
  });
  (f.x.fm_parent_seal_capture as (base: number) => number)(CHANNEL_BASE);
  expect(f.errno(), "the capture seals").toBe(0);
  const root = f.arena(ARENA_ROOT);
  expect(root, "and leaves an arena root").toBeGreaterThan(0);
  return { root, recipes };
}

/** `fm_capture_define_gc` aggregate kinds, from the module's `CAPTURE_KIND_*`. */
export const CAPTURE_KIND_STRUCT = 1;
export const CAPTURE_KIND_ARRAY = 2;
export const CAPTURE_KIND_EXNREF = 3;

/** One aggregate to define inside a capture, in the module's own terms. */
export interface CapturedAggregate {
  readonly kind: number;
  readonly activation: number;
  /** Type ordinal for struct/array; TAG ordinal for an exnref. */
  readonly typeOrdinal: number;
  readonly layoutId?: number;
  /** Scalar payload bytes, staged into guest memory by the fixture. */
  readonly scalars?: Uint8Array;
  /**
   * Recipe ids this aggregate's fields/elements point at, or a function of the
   * LEAF recipe ids -- which the caller cannot know in advance, because the
   * module assigns them during this same capture.
   */
  readonly edges?:
    | readonly number[]
    | ((ids: {
        readonly leaves: readonly number[];
        readonly aggregates: readonly number[];
      }) => readonly number[]);
}

/**
 * Capture a sealed arena containing LEAVES and AGGREGATES, through the module.
 *
 * The aggregate half is why this exists rather than the tests each building an
 * arena: struct/array/exnref recipes are claimed, then completed with a scalar
 * span and an interned edge VECTOR, and getting that order wrong produces a
 * graph the module accepts and the child rebuilds wrong. Driving the module's
 * own entries means the test cannot get it wrong in a way production would not.
 *
 * Returns the sealed root, the leaf recipe ids in the order they were interned,
 * and the aggregate recipe ids in theirs.
 */
export function captureGraph(
  f: Fixture,
  leaves: readonly (readonly [kind: number, a: number, b: number])[],
  aggregates: readonly CapturedAggregate[] = [],
  options: CaptureOptions & { readonly scalarStagingBase?: number } = {},
): { root: number; recipes: number[]; aggregateRecipes: number[] } {
  openCapture(f, options.sideActivations ?? []);

  const intern = f.x.fm_capture_intern as (k: number, a: number, b: number) => number;
  const recipes = leaves.map(([kind, a, b]) => {
    const id = intern(kind, a, b);
    expect(f.errno(), `intern kind ${kind}`).toBe(0);
    return id;
  });

  let scalarAt = options.scalarStagingBase ?? MMAP_FLOOR + 6 * PAGE;

  // CLAIM every aggregate before building any edge vector. A recipe id has to
  // exist before an edge can name it, so a struct<->array CYCLE -- the shape the
  // drive order exists to handle -- is only expressible if the claims come
  // first. Within one aggregate the order is still vector, then define: a
  // define completes a claim, and the builder refuses a vector opened inside
  // one.
  const aggregateRecipes = aggregates.map(() => {
    const id = (f.x.fm_capture_claim_gc as () => number)();
    expect(f.errno(), "claim").toBe(0);
    return id;
  });

  aggregates.forEach((aggregate, index) => {
    const id = aggregateRecipes[index]!;
    const edges = typeof aggregate.edges === "function"
      ? aggregate.edges({ leaves: recipes, aggregates: aggregateRecipes })
      : aggregate.edges ?? [];
    const handle = (f.x.__wpk_fork_ref_vector_begin as (n: number) => number)(
      edges.length,
    );
    expect(f.errno(), "vector begin").toBe(0);
    for (const edge of edges) {
      (f.x.__wpk_fork_ref_vector_append as (h: number, r: number) => void)(handle, edge);
      // `append` returns nothing -- that is the guest ABI -- so a failure only
      // latches. Checking here names the edge that failed instead of surfacing
      // as a count mismatch at `finish`.
      expect(f.errno(), `vector append ${edge} (handle ${handle})`).toBe(0);
    }
    const ordinal = (f.x.__wpk_fork_ref_vector_finish as (h: number) => number)(handle);
    expect(f.errno(), "vector finish").toBe(0);
    expect(ordinal, "and it interns to a durable ordinal").toBeGreaterThanOrEqual(0);

    const scalars = aggregate.scalars ?? new Uint8Array(0);
    let scalarPtr = 0;
    if (scalars.length > 0) {
      scalarPtr = scalarAt;
      new Uint8Array(f.memory.buffer, scalarPtr, scalars.length).set(scalars);
      scalarAt += (scalars.length + 15) & ~15;
    }
    (f.x.fm_capture_define_gc as (...a: number[]) => number)(
      id,
      aggregate.activation,
      aggregate.typeOrdinal,
      aggregate.layoutId ?? 0,
      aggregate.kind,
      scalarPtr,
      scalars.length,
      ordinal,
      0,
      0,
      0,
    );
    expect(f.errno(), `define kind ${aggregate.kind}`).toBe(0);
  });

  (f.x.fm_parent_seal_capture as (base: number) => number)(CHANNEL_BASE);
  expect(f.errno(), "the capture seals").toBe(0);
  const root = f.arena(ARENA_ROOT);
  expect(root, "and leaves an arena root").toBeGreaterThan(0);
  return { root, recipes, aggregateRecipes };
}

// -- The record arena and its directory ---------------------------------
//
// The storage conversion replaces fixed-BSS stores with chunked,
// activation-keyed records. A fixed array could not leak; a chunk list can,
// so the arena carries three observables and this file is where every test
// reads them from -- one spelling of each field number, rather than one per
// test file.
//
// THE NUMBERS ARE CHOSEN FROM THE PLAN'S ONE TABLE, never as "the next free
// index". `fm_stats` answers a high field from an `if field == K` compare
// placed BEFORE its reference table, so two arms sharing a number is not a
// compile error where it is written: the second arm is dead and the first
// answers both reads with a plausible number from the wrong source. 105 sits
// above 103 and 104 -- reserved by later tasks of the same plan -- although
// this one lands first, for exactly that reason.
export const ARENA_RECORD_CHUNK_COUNT_FIELD = 101;
export const ARENA_DIRECTORY_CHUNK_COUNT_FIELD = 102;
/** Ruling D1-a: LIVE directory entries, one per activation holding a record. */
export const ARENA_DIRECTORY_ENTRY_COUNT_FIELD = 105;

/**
 * RULING D1-a. The directory is a LINEAR WALK plus a one-entry memo, chosen
 * over the spec's sorted O(log n) design because the invariant that design
 * needs is held by a different component than the one relying on it
 * (`claimActivationId` accepts a caller-supplied `replayActivationId`, so the
 * "strictly greater than the last" append rule is not the directory's to
 * enforce, and its violation would be a silent "not found" for a live
 * activation). That choice is good for tens of activations and the measured
 * maximum in this suite is 7.
 *
 * "Stop and report if any fixture exceeds 64" binds one implementer, at
 * authoring time, for the fixtures they happened to run -- which is the
 * guard-whose-failure-is-silent the deviation rejects in the spec's own
 * design. So the module COUNTS (`fm_stats` field 105) and this FAILS.
 *
 * ACCEPTED CONSEQUENCE: this fires when a test runs, not inside a browser
 * production run. The module is `no_std` with no diagnostic channel to be loud
 * through -- a grep for one on 2026-09-21 found none -- and adding one is a
 * separate change this plan does not attempt.
 */
export const DIRECTORY_WALK_REVISIT_AT = 64;

/**
 * The comparison and the message, SEPARATED FROM THE MODULE that produces the
 * count -- so the guard can be proven capable of failing without driving 65
 * real activations through a fixture. `host/test/fork-arena-release.test.ts`
 * drives it directly at 64 and 65.
 */
export function assertDirectoryWithinWalkBound(live: number): void {
  expect(
    live,
    `the arena directory holds ${live} live activations, past the ` +
      `${DIRECTORY_WALK_REVISIT_AT} the linear-walk-plus-memo directory was ` +
      `chosen for (plan deviation D1, ruling D1-a).\n` +
      `  This is a PERFORMANCE signal, not a correctness failure: nothing is ` +
      `wrong with the run that produced it.\n` +
      `  Past ${DIRECTORY_WALK_REVISIT_AT} the spec's sorted O(log n) ` +
      `directory is worth revisiting, and that is the MAINTAINER'S CALL. ` +
      `Report the count and the fixture that produced it; do not raise this ` +
      `bound to make the suite green.`,
  ).toBeLessThanOrEqual(DIRECTORY_WALK_REVISIT_AT);
}

/** Read field 105 off a live module and hold it to the D1-a bound. */
export function expectDirectoryWithinWalkBound(read: (field: number) => number): void {
  const live = read(ARENA_DIRECTORY_ENTRY_COUNT_FIELD);
  // -1 means the module does not answer this field at all, which is a
  // different failure and belongs to the field pin in
  // `host/test/fork-module-backend.test.ts`, not here.
  if (live < 0) return;
  assertDirectoryWithinWalkBound(live);
}

/**
 * A fork-module instance with a SERVICED channel and nothing else.
 *
 * `fixture()` above builds the whole capture-drive rig -- guest double, drive
 * table, fourteen slots. The arena tests need none of it: they publish
 * records, release them, and read three counters. Same shape as
 * `host/test/fork-identity-release.test.ts`, which predates this helper and is
 * left where it is rather than rewritten onto it.
 *
 * The channel is not optional: arena storage is on demand, so an allocation
 * issues `SYS_MMAP` through the channel and a module without a responder
 * answers `EINVAL` instead of storing anything.
 */
export interface ArenaFixture {
  x: Record<string, unknown>;
  memory: WebAssembly.Memory;
  /** Read an `fm_stats` field. */
  stats: (field: number) => number;
  /** The responder's running `SYS_MUNMAP` tally, read out of shared memory. */
  munmaps: () => number;
  /** The responder's running `SYS_MMAP` tally, the other half of the pair. */
  mmaps: () => number;
  /** `fm_resume_slots(op, activation, ordinal)`; op 1 is the dlclose release. */
  slots: (op: number, activation: number, ordinal: number) => number;
  /**
   * The SLOT of each `(ordinal, slot)` record `fm_publish_resume_assignment`
   * publishes for `activation`, in the published order (ascending by ordinal).
   *
   * This is how a test reads WHICH slots an activation holds. No `fm_*` entry
   * answers `(activation, ordinal) -> slot` any more -- `fm_resume_slots` op 0
   * was deleted with `resume_slot_of` -- so the whole-activation publish is the
   * only reader, and it is the one the guest's placement shim consumes, which
   * makes it the right one: a test asserting these numbers is asserting the
   * numbers the thunks are actually placed at.
   */
  publishedSlots: (activation: number) => number[];
  /**
   * The whole `(ordinal, slot)` record, for the one assertion `publishedSlots`
   * cannot make: that the pairs come back ASCENDING BY ORDINAL.
   */
  publishedPairs: (activation: number) => Array<[number, number]>;
  /** Re-run `fm_set_format`, which is the COW-child scrub. */
  setFormat: () => void;
  /** `fm_set_activation_resume_catalog` with the ordinals staged first. */
  seedActivationCatalog: (activation: number, ordinals: readonly number[]) => void;
  /**
   * `fm_set_activation_imports` with the section staged first: a KFIG section
   * for space 0, a KFIT section for space 1. The staging page is one wasm
   * page, so a section longer than that is refused here rather than silently
   * overrunning into whatever sits above it.
   */
  seedActivationImports: (space: number, activation: number, section: Uint8Array) => void;
  /**
   * `fm_set_activation_gc_codec` with the raw KFGC section staged first, on
   * the same one-page staging area and with the same overrun refusal as
   * `seedActivationImports`. An EMPTY section is accepted by the module
   * without decoding, which makes it a valid CONFLICTING re-seed against any
   * non-empty one -- the one way a test can ask "is the stored codec still
   * there?" without a second well-formed codec to seed.
   */
  seedActivationGcCodec: (activation: number, section: Uint8Array) => void;
  /** `fm_set_activation_exception_codec` with the raw KFEC section staged first. */
  seedActivationExceptionCodec: (activation: number, section: Uint8Array) => void;
  /**
   * `fm_set_resume_catalog` -- the PROCESS-WIDE seed, which is activation 0's.
   *
   * A different entry from `seedActivationCatalog`, and the difference matters:
   * activation 0's ordinals reach `resume_register_impl` through
   * `resume_catalog()` rather than `activation_catalog(0)`, so this is the only
   * way to drive that arm. `host/src/fork-module-backend.ts` `setup()` calls it
   * on every worker.
   */
  seedProcessCatalog: (ordinals: readonly number[]) => void;
  /**
   * Grow the module's resume table to cover `slots`, standing in for the guest.
   *
   * `fm_resume_slots` op 1 is the `dlclose` release, and its first pass nulls
   * every one of the activation's table entries with a STRICT `table.set` --
   * strict because a `dlclose` of a registered activation means the thunks were
   * placed, so a slot the table does not have is a real inconsistency and traps
   * rather than being skipped. The module's `__wpk_fork_resume_table` starts at
   * length 1 (slot 0 is the reserved sentinel) and is grown by the guest's
   * `__wpk_fork_place_resume_thunks` shim, which a bare module fixture has none
   * of: the release traps with "table index is out of bounds" before it reaches
   * the free bitmap at all.
   *
   * So the table is grown here, to the length the guest would have given it.
   * That is standing in for the guest, not scoping the test down -- the free
   * path under test is reached through the real entry, in its real strict mode,
   * exactly as a `dlclose` reaches it.
   */
  growResumeTable: (slots: number) => void;
  /** The sticky errno of the most recent export call. */
  errno: () => number;
  /**
   * `fm_arena_selftest(op, activation, kind, bytes)` -- the test-only entry
   * that drives the arena's allocating half. See its doc comment in the
   * module: it is a debt, and the task that converts the resume assignment
   * deletes it.
   */
  selftest: (op: number, activation: number, kind: number, bytes: number) => bigint;
}

/** `fm_arena_selftest` ops. */
export const ARENA_OP_ALLOC = 0;
export const ARENA_OP_FIND = 1;
export const ARENA_OP_EXTEND = 2;

/**
 * Where `seedActivationCatalog` stages its ordinals: page 6, between the
 * munmap counter (page 5) and `MODULE_BASE` (8 MiB), and far below
 * `MMAP_FLOOR`, so nothing the responder hands out can overlap it.
 */
export const ARENA_STAGING_AT = 6 * PAGE;

export function arenaFixture(label = "arena"): ArenaFixture {
  const memory = new WebAssembly.Memory({
    initial: 256,
    maximum: 16384,
    shared: true,
  });
  const fm = instantiateForkModule({
    module: new WebAssembly.Module(readFileSync(resolveBinary("fork_module32.wasm"))),
    memory,
    ptrWidth: 4,
    reserve: () => MODULE_BASE,
    label,
  });
  const x = fm.exports as Record<string, unknown>;
  const worker = startChannelResponder({
    memory,
    channelBase: CHANNEL_BASE,
    floor: MMAP_FLOOR,
    counters: { mmap: MMAP_COUNTER, munmap: MUNMAP_COUNTER },
  });
  const setFormat = (): void => {
    (x.fm_set_format as (...a: number[]) => void)(4, 0, 0, 0, CHANNEL_BASE);
  };
  setFormat();
  const errno = (): number => (x.fm_last_errno as () => number)();
  const f: ArenaFixture = {
    x,
    memory,
    stats: (field) => Number((x.fm_stats as (n: number) => bigint)(field)),
    // A fresh view each read: `channel_mmap` GROWS the shared memory, and a
    // `DataView` taken before a growth is not guaranteed to survive it.
    munmaps: () => new DataView(memory.buffer).getUint32(MUNMAP_COUNTER, true),
    mmaps: () => new DataView(memory.buffer).getUint32(MMAP_COUNTER, true),
    slots: x.fm_resume_slots as ArenaFixture["slots"],
    publishedPairs: (activation) => {
      const packed = (x.fm_publish_resume_assignment as (a: number) => bigint)(
        activation,
      );
      if (packed === -1n) {
        throw new Error(
          `fm_publish_resume_assignment failed for activation ${activation} ` +
            `with errno ${errno()}`,
        );
      }
      const ptr = Number(packed & 0xffffffffn);
      const count = Number(packed >> 32n);
      const view = new DataView(memory.buffer);
      const out: Array<[number, number]> = [];
      for (let i = 0; i < count; i += 1) {
        out.push([
          view.getUint32(ptr + i * 8, true),
          view.getUint32(ptr + i * 8 + 4, true),
        ]);
      }
      return out;
    },
    publishedSlots: (activation) => {
      const packed = (x.fm_publish_resume_assignment as (a: number) => bigint)(
        activation,
      );
      if (packed === -1n) {
        throw new Error(
          `fm_publish_resume_assignment failed for activation ${activation} ` +
            `with errno ${errno()}`,
        );
      }
      const ptr = Number(packed & 0xffffffffn);
      const count = Number(packed >> 32n);
      // A fresh view: publishing a large assignment spills to a mapping, and
      // `channel_mmap` grows the shared memory.
      const view = new DataView(memory.buffer);
      const out: number[] = [];
      // Each record is `[ordinal: u32, slot: u32]`; the slot is at +4.
      for (let i = 0; i < count; i += 1) out.push(view.getUint32(ptr + i * 8 + 4, true));
      return out;
    },
    setFormat,
    seedActivationCatalog: (activation, ordinals) => {
      const staged = new Uint8Array(ordinals.length * 4);
      const view = new DataView(staged.buffer);
      ordinals.forEach((o, i) => view.setUint32(i * 4, o >>> 0, true));
      new Uint8Array(memory.buffer, ARENA_STAGING_AT, staged.length).set(staged);
      (
        x.fm_set_activation_resume_catalog as (a: number, p: number, c: number) => void
      )(activation, ARENA_STAGING_AT, ordinals.length);
    },
    seedActivationImports: (space, activation, section) => {
      if (section.length > PAGE) {
        throw new Error(
          `seedActivationImports: a ${section.length}-byte section overruns the one-page staging area`,
        );
      }
      new Uint8Array(memory.buffer, ARENA_STAGING_AT, section.length).set(section);
      (
        x.fm_set_activation_imports as (s: number, a: number, p: number, n: number) => void
      )(space, activation, ARENA_STAGING_AT, section.length);
    },
    seedActivationGcCodec: (activation, section) => {
      if (section.length > PAGE) {
        throw new Error(
          `seedActivationGcCodec: a ${section.length}-byte section overruns the one-page staging area`,
        );
      }
      new Uint8Array(memory.buffer, ARENA_STAGING_AT, section.length).set(section);
      (x.fm_set_activation_gc_codec as (a: number, p: number, n: number) => void)(
        activation,
        ARENA_STAGING_AT,
        section.length,
      );
    },
    seedActivationExceptionCodec: (activation, section) => {
      if (section.length > PAGE) {
        throw new Error(
          `seedActivationExceptionCodec: a ${section.length}-byte section overruns the one-page staging area`,
        );
      }
      new Uint8Array(memory.buffer, ARENA_STAGING_AT, section.length).set(section);
      (x.fm_set_activation_exception_codec as (a: number, p: number, n: number) => void)(
        activation,
        ARENA_STAGING_AT,
        section.length,
      );
    },
    seedProcessCatalog: (ordinals) => {
      const staged = new Uint8Array(ordinals.length * 4);
      const view = new DataView(staged.buffer);
      ordinals.forEach((o, i) => view.setUint32(i * 4, o >>> 0, true));
      new Uint8Array(memory.buffer, ARENA_STAGING_AT, staged.length).set(staged);
      (x.fm_set_resume_catalog as (p: number, c: number) => void)(
        ARENA_STAGING_AT,
        ordinals.length,
      );
    },
    growResumeTable: (slots) => {
      const table = x.__wpk_fork_resume_table as WebAssembly.Table | undefined;
      if (!table) {
        throw new Error("the injected module no longer exports its resume table");
      }
      if (table.length <= slots) table.grow(slots + 1 - table.length);
    },
    errno,
    selftest: x.fm_arena_selftest as ArenaFixture["selftest"],
  };
  liveStatsReaders.push(f.stats);
  return f;
}

// RULING D1-a's loudness, on the hook every module instance this file hands
// out already goes through -- BOTH the capture rig and the arena fixture, so
// no test has to remember to check the bound and no factory can opt out of it
// by being written later.
afterAll(() => {
  for (const stats of liveStatsReaders) expectDirectoryWithinWalkBound(stats);
});
