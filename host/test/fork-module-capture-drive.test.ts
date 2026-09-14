import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { afterAll, describe, expect, it } from "vitest";
import { resolveBinary } from "../src/binary-resolver";
import { instantiateForkModule } from "../src/fork-module-instance";
import { ForkModuleContinuationBackend } from "../src/fork-module-backend";
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

const PAGE = 65536;
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
const DRIVE_SLOT_REWIND_BEGIN = 5;
const DRIVE_SLOT_ABORT_BEGIN = 6;
const DRIVE_SLOT_UNWIND_END = 7;
const DRIVE_SLOT_REWIND_END = 8;
const DRIVE_SLOT_ABORT_END = 9;
const DRIVE_SLOT_UNWIND_BEGIN = 10;
const DRIVE_SLOT_MODULE_STATE_SAVE = 13;

// `fm_module_state_arena` operations.
const ARENA_ROOT = 0;
const ARENA_OWNED = 3;

/** `fm_phase` values, from the PHASE_* constants in crates/fork-module. */
const PHASE_IDLE = 0;
const PHASE_CAPTURE = 1;
const PHASE_SEALED_PARENT = 2;
const PHASE_PARENT_REPLAY = 3;
const PHASE_ABORT_REPLAY = 5;

/** `fm_borrowed_replay_workspace` fields. */
const WORKSPACE_PREFIX = 0;
const WORKSPACE_SCRATCH = 1;

const EBUSY = 16;

const CHANNEL_BASE = 4 * PAGE;
const MODULE_BASE = 8 * 1024 * 1024;
/** Where the responder hands out mappings from: above everything else in use. */
const MMAP_FLOOR = 12 * 1024 * 1024;

/**
 * A worker that answers the module's channel syscalls.
 *
 * The module publishes a request, stores PENDING and blocks in
 * `memory.atomic.wait32`. Nothing else can answer it: the calling thread is
 * inside the wasm call. So the responder runs on its own thread, bump-allocates
 * for `SYS_MMAP`, accepts `SYS_MUNMAP`, and refuses anything else with EINVAL
 * rather than inventing a plausible answer.
 */
const RESPONDER = `
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

interface Fixture {
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

function fixture(): Fixture {
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

  const worker = new Worker(RESPONDER, {
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
function seedTemplateId(f: Fixture, activation: number, at: number): void {
  (f.x.fm_set_activation_template_id as (a: number, p: number) => void)(
    activation,
    at,
  );
}

describe("capture begin, driven through a serviced channel", () => {
  it("allocates its own arena and declares the activation set into it", () => {
    const f = fixture();
    seedTemplateId(f, 0, 2048);
    expect(f.errno()).toBe(0);

    (f.x.fm_parent_begin_capture as (...a: number[]) => number)(
      CHANNEL_BASE,
      0, // ask the module to allocate the arena
      0,
      0,
    );
    expect(f.errno(), "capture begin should succeed").toBe(0);

    // The two facts that were unverifiable before: the module made an arena,
    // and it owns the chunks behind it.
    expect(f.arena(ARENA_ROOT)).toBeGreaterThan(0);
    expect(f.arena(ARENA_OWNED)).toBe(1);
  });

  it("does not build an arena when the caller supplies one", () => {
    // The section 142 bug, now reachable. Reserving into a rootless writer does
    // not fail -- it starts a second arena on the same channel that nothing
    // reads, while the caller's arena keeps only what the caller wrote.
    const f = fixture();
    seedTemplateId(f, 0, 2048);
    (f.x.fm_parent_begin_capture as (...a: number[]) => number)(
      CHANNEL_BASE,
      MMAP_FLOOR - PAGE, // the caller's own arena root
      0,
      0,
    );
    expect(f.arena(ARENA_ROOT), "the module must not have made one").toBe(0);
    expect(f.arena(ARENA_OWNED)).toBe(0);
  });
});

describe("the parent fork lifecycle, end to end through the module", () => {
  it("walks idle -> capture -> sealed -> replay -> idle", () => {
    // The whole point of the responder. Every one of these calls allocates or
    // frees through the channel, so before it existed none of them could be
    // driven at all -- the module parked instead of answering.
    const f = fixture();
    seedTemplateId(f, 0, 2048);
    const phase = () => Number((f.x.fm_phase as () => number)());
    expect(phase()).toBe(PHASE_IDLE);

    (f.x.fm_parent_begin_capture as (...a: number[]) => number)(CHANNEL_BASE, 0, 0, 0);
    expect(f.errno()).toBe(0);
    expect(phase(), "a capture is open").toBe(PHASE_CAPTURE);

    (f.x.fm_parent_seal_capture as (b: number) => number)(CHANNEL_BASE);
    expect(f.errno(), "seal").toBe(0);
    expect(phase(), "sealed").toBe(PHASE_SEALED_PARENT);

    (f.x.fm_parent_replay as (a: number) => void)(0);
    expect(f.errno(), "replay").toBe(0);
    expect(phase(), "replaying").toBe(PHASE_PARENT_REPLAY);

    (f.x.fm_parent_finish as (a: number) => void)(0);
    expect(f.errno(), "finish").toBe(0);
    expect(phase(), "back to idle").toBe(PHASE_IDLE);
  });

  it("sizes a borrowed child's workspace only once the capture has sealed", () => {
    // These VALUES were untested when the entry landed, and said so: reaching
    // sealed-parent needed a capture with a live guest. It needs a serviced
    // channel, which is a smaller thing.
    const f = fixture();
    seedTemplateId(f, 0, 2048);
    const workspace = f.x.fm_borrowed_replay_workspace as (field: number) => bigint;

    (f.x.fm_parent_begin_capture as (...a: number[]) => number)(CHANNEL_BASE, 0, 0, 0);
    // Mid-capture the activation set is still growing and the scratch
    // high-water has not peaked, so an answer would be an undercount.
    expect(Number(workspace(WORKSPACE_PREFIX))).toBe(-1);
    expect(f.errno()).toBe(EBUSY);

    (f.x.fm_parent_seal_capture as (b: number) => number)(CHANNEL_BASE);
    expect(f.errno()).toBe(0);

    // One activation, whose fixed prefix this fixture seeded as 0 -- so the
    // sum over the activation set is 0, and that is a real answer rather than
    // the refusal above. The distinction is the whole point of the phase gate.
    const prefix = Number(workspace(WORKSPACE_PREFIX));
    expect(f.errno()).toBe(0);
    expect(prefix).toBeGreaterThanOrEqual(0);
    const scratch = Number(workspace(WORKSPACE_SCRATCH));
    expect(f.errno()).toBe(0);
    expect(scratch).toBeGreaterThanOrEqual(0);
  });
});

describe("the backend's lifecycle methods, against a live module", () => {
  /**
   * The same sequence, driven through `ForkModuleContinuationBackend` instead of
   * raw exports.
   *
   * These four methods did not exist: the backend was cut to 20 methods when the
   * JS coordinator was set aside, and the lifecycle ones went with it. They come
   * back because `worker-main.ts` is being moved to its end state and needs
   * them — which is the order that keeps the module API demand-driven rather
   * than guessed. Every one is checked here before anything calls it.
   *
   * `call` throws on a nonzero `fm_last_errno`, so each assertion below is also
   * an assertion that the module reported success.
   */
  function backendFixture(): { f: Fixture; backend: ForkModuleContinuationBackend } {
    const f = fixture();
    seedTemplateId(f, 0, 2048);
    const backend = new ForkModuleContinuationBackend({
      instance: f.instance,
      memory: f.memory,
      ptrWidth: 4,
      format: { ptrWidth: 4 } as never,
      catalogOrdinals: [],
      // The seal serializes the journal image into a freshly channel-mmap'd
      // chunk, so the backend needs the same channel the responder services.
      channelBase: CHANNEL_BASE,
      label: "lifecycle",
    });
    return { f, backend };
  }

  it("opens, seals, replays and finishes a capture", () => {
    const { f, backend } = backendFixture();
    const phase = () => Number((f.x.fm_phase as () => number)());

    const anchor = backend.parentBeginCapture(CHANNEL_BASE, 0, 0, 0);
    expect(anchor, "activation 0's module-buffer anchor").toBeGreaterThan(0);
    expect(phase()).toBe(PHASE_CAPTURE);
    // Passing 0 has to reach the module as 0. It is the difference between the
    // module building the arena and the module assuming the caller did, and
    // nothing downstream reports it: a nonzero root here would leave the module
    // owning nothing while the capture looked entirely successful.
    expect(f.arena(ARENA_ROOT), "the module allocated its own arena").toBeGreaterThan(0);
    expect(f.arena(ARENA_OWNED), "and owns the chunks behind it").toBe(1);

    backend.sealCaptureAndSerialize();
    expect(phase()).toBe(PHASE_SEALED_PARENT);

    backend.parentReplay(false);
    expect(phase()).toBe(PHASE_PARENT_REPLAY);

    backend.parentFinish(false);
    expect(phase()).toBe(PHASE_IDLE);
  });

  it("seals a partial capture for abort without driving unwind-end", () => {
    // The mid-unwind failure path: a frame reserve came back 0, so the capture
    // cannot complete. A failed reserve leaves no pending frame, so the
    // committed chain is whole and seal-able -- and the seal must NOT drive the
    // guest's unwind-end, because the guest is still mid-unwind and driving it
    // there corrupts the unwind state machine. What is observable here is that
    // it reaches sealed-parent, which is what lets the abort replay run over
    // the frames that did commit.
    const { f, backend } = backendFixture();
    backend.parentBeginCapture(CHANNEL_BASE, 0, 0, 0);
    const phase = () => Number((f.x.fm_phase as () => number)());
    expect(phase()).toBe(PHASE_CAPTURE);

    backend.parentAbortSeal();
    expect(phase(), "sealed for abort").toBe(PHASE_SEALED_PARENT);

    // And the abort replay runs from there, which is the whole point of
    // sealing a capture that cannot complete. It has its OWN phase rather than
    // sharing the parent-replay one -- an abort finish drives the guest's
    // `wpk_fork_abort_end` where a normal finish drives `wpk_fork_rewind_end`,
    // so the two cannot be the same state.
    backend.parentReplay(true);
    expect(phase()).toBe(PHASE_ABORT_REPLAY);
    backend.parentFinish(true);
    expect(phase()).toBe(PHASE_IDLE);
  });

  it("refuses a child install from an arena root that is not one", () => {
    // fm_attach_child had never had a production caller until this commit, so
    // the first thing worth pinning is that it REFUSES rather than proceeding
    // on a root it cannot decode. A child install that half-succeeds leaves a
    // process running on a reference graph nobody reconstructed, which is the
    // silent-corruption shape this whole path has to avoid.
    const { backend } = backendFixture();
    expect(() => backend.attachChild(0, 1)).toThrow();
    expect(() => backend.attachChild(MMAP_FLOOR - PAGE, 1)).toThrow();
  });

  it("drives nothing when the module built an empty plan", () => {
    // driveRestoredPlan reads the step count from the MODULE rather than
    // taking it from the caller, so the two cannot disagree about how much of
    // the plan to run. With no plan built, the count is 0 and the drive is a
    // no-op -- not a call_indirect through an unbound slot.
    const { backend } = backendFixture();
    expect(() => backend.driveRestoredPlan(0)).not.toThrow();
  });

  it("refuses an abort seal from a phase with no capture open", () => {
    const { backend } = backendFixture();
    expect(() => backend.parentAbortSeal()).toThrow(/errno 16/);
  });

  it("returns the module to idle on abort", () => {
    // The teardown path for a capture that failed part way. It must not leave
    // the module mid-phase, because every later entry refuses from the wrong one
    // and the worker would be wedged rather than broken.
    const { f, backend } = backendFixture();
    backend.parentBeginCapture(CHANNEL_BASE, 0, 0, 0);
    expect(Number((f.x.fm_phase as () => number)())).toBe(PHASE_CAPTURE);
    backend.abort();
    expect(Number((f.x.fm_phase as () => number)())).toBe(PHASE_IDLE);
  });

  it("refuses a lifecycle call from the wrong phase rather than proceeding", () => {
    // `call` turns the module's EBUSY into a throw, so an out-of-order host is
    // stopped at the boundary instead of being told a plausible lie.
    const { backend } = backendFixture();
    expect(() => backend.parentReplay(false)).toThrow(/errno 16/);
    expect(() => backend.parentFinish(false)).toThrow(/errno 16/);
  });
});
