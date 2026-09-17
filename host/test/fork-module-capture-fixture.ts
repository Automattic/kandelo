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
export const CHANNEL_RESPONDER = `
const { parentPort, workerData } = require("node:worker_threads");
const { sab, channelBase, floor } = workerData;
const i32 = new Int32Array(sab);
const dv = new DataView(sab);
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
    ret = BigInt(addr); errno = 0;
  } else if (nr === ${SYS_MUNMAP}) {
    ret = 0n; errno = 0;
  }
  dv.setBigInt64(channelBase + ${RETURN_OFFSET}, ret, true);
  dv.setUint32(channelBase + ${ERRNO_OFFSET}, errno, true);
  Atomics.store(i32, statusIndex, ${STATUS_COMPLETE});
  Atomics.notify(i32, statusIndex);
}
`;

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

  const worker = new Worker(CHANNEL_RESPONDER, {
    eval: true,
    workerData: { sab: memory.buffer, channelBase: CHANNEL_BASE, floor: MMAP_FLOOR },
  });
  live.push(worker);

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
