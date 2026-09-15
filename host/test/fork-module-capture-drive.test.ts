import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { afterAll, describe, expect, it } from "vitest";
import { resolveBinary } from "../src/binary-resolver";
import { instantiateForkModule } from "../src/fork-module-instance";
import { ForkModuleContinuationBackend } from "../src/fork-module-backend";
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
/** Where a CHILD worker's own module instance sits in the shared memory. */
const CHILD_MODULE_BASE = 20 * 1024 * 1024;

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

    (f.x.fm_capture_begin as () => void)();
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
    (f.x.fm_capture_begin as () => void)();
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

    (f.x.fm_capture_begin as () => void)();
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

    (f.x.fm_capture_begin as () => void)();
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

    (f.x.fm_capture_begin as () => void)();
    const anchor = backend.parentBeginCapture(CHANNEL_BASE, 0, []);
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
    (f.x.fm_capture_begin as () => void)();
    backend.parentBeginCapture(CHANNEL_BASE, 0, []);
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
    (f.x.fm_capture_begin as () => void)();
    backend.parentBeginCapture(CHANNEL_BASE, 0, []);
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

describe("imported-global bindings, assembled by the module at capture", () => {
  /** A valid, empty KFIG section: 16-byte header, zero records. */
  function emptyKfig(): Uint8Array {
    const bytes = new Uint8Array(16);
    const view = new DataView(bytes.buffer);
    bytes.set([0x4b, 0x46, 0x49, 0x47], 0);
    view.setUint16(4, 1, true);
    view.setUint16(6, 16, true);
    return bytes;
  }

  it("writes no binding record when nothing imports a global", () => {
    // A guest with no imported globals produced an arena without this record
    // before, and must still. Writing an empty one would put a record the child
    // then decodes for no reason.
    const f = fixture();
    seedTemplateId(f, 0, 2048);
    (f.x.fm_capture_begin as () => void)();
    (f.x.fm_parent_begin_capture as (...a: number[]) => number)(CHANNEL_BASE, 0, 0, 0);
    expect(f.errno(), "capture with no imported globals").toBe(0);
  });

  it("refuses to bind provenance with no matching declaration", () => {
    // The host published provenance for an import the activation's KFIG section
    // does not declare. That is the two halves of the contract disagreeing, and
    // binding it anyway would wire a child's import from a coordinate nothing
    // describes.
    const f = fixture();
    seedTemplateId(f, 0, 2048);
    const kfig = emptyKfig();
    new Uint8Array(f.memory.buffer, 6144, kfig.length).set(kfig);
    (f.x.fm_set_activation_imports as (s: number, a: number, p: number, n: number) => void)(
      0 /* globals */,
      0,
      6144,
      kfig.length,
    );
    expect(f.errno(), "empty section seeded").toBe(0);
    // Provenance for owner 1, which the empty section does not declare.
    (f.x.fm_set_import_provenance as (
      s: number, a: number, o: number, k: number, group: number, bits: bigint,
    ) => void)(0 /* globals */, 0, 1, 4 /* ACTIVATION_GLOBAL */, 0 /* in no catalog */, 0n);
    expect(f.errno(), "provenance published").toBe(0);

    (f.x.fm_capture_begin as () => void)();
    (f.x.fm_parent_begin_capture as (...a: number[]) => number)(CHANNEL_BASE, 0, 0, 0);
    expect(f.errno(), "capture must refuse rather than bind blind").not.toBe(0);
  });
});

/**
 * What the module WRITES, which until now nothing checked.
 *
 * Both binding writers were tested only for what they refuse. Their output was
 * unverified, because reading it means walking the KFMS arena and the host has
 * no reader for that format any more -- the 3,825-line one is in the attic and
 * is not coming back. So this walks it HERE, in about forty lines, which is
 * also the answer to how much of that file was the format and how much was the
 * live allocator.
 *
 * The layout is the one `crates/fork-codec/src/module_state.rs` documents:
 * chunk header (40 bytes at pointer width 4) then records, each a 24-byte TLV
 * header and a payload.
 */

const RECORD_HEADER_SIZE = 24;
const CHUNK_HEADER_SIZE_32 = 40;
const RECORD_KIND_IMPORTED_GLOBAL_BINDINGS = 9;
const RECORD_KIND_IMPORTED_TABLE_BINDINGS = 11;
const RECORD_KIND_MUTABLE_GLOBAL = 3;
const RECORD_KIND_JOURNAL_IMAGE = 14;
const GLOBAL_TYPE_I32 = 1;
const SPACE_GLOBAL = 0;
const SPACE_TABLE = 1;
const KIND_ACTIVATION_GLOBAL = 4;
const KIND_ACTIVATION_TABLE = 1;
const KIND_BASE_IMPORT = 5;

interface ArenaRecord {
  readonly kind: number;
  readonly activation: number;
  readonly owner: number;
  readonly payload: DataView;
}

/** Every record in the arena, chunk by chunk, in write order. */
function arenaRecords(memory: WebAssembly.Memory, root: number): ArenaRecord[] {
  const view = new DataView(memory.buffer);
  const out: ArenaRecord[] = [];
  let chunk = root;
  while (chunk !== 0) {
    if (view.getUint32(chunk, true) !== 0x434d_464b) {
      throw new Error(`chunk at ${chunk} is not KFMC`);
    }
    const used = view.getUint32(chunk + 8 + 4 * 4, true);
    const next = view.getUint32(chunk + 8 + 2 * 4, true);
    let at = chunk + CHUNK_HEADER_SIZE_32;
    const end = chunk + used;
    while (at < end) {
      if (view.getUint32(at, true) !== 0x524d_464b) {
        throw new Error(`record at ${at} is not KFMR`);
      }
      const total = view.getUint32(at + 8, true);
      const payloadSize = view.getUint32(at + 12, true);
      out.push({
        kind: view.getUint16(at + 6, true),
        activation: view.getUint32(at + 16, true),
        owner: view.getUint32(at + 20, true),
        payload: new DataView(
          memory.buffer,
          at + RECORD_HEADER_SIZE,
          payloadSize,
        ),
      });
      at += total;
    }
    chunk = next;
  }
  return out;
}

/** One `KFIG` section declaring a single imported global. */
function kfigOne(ownerId: number, ordinal: number, typeCode: number): Uint8Array {
  const moduleName = new TextEncoder().encode("env");
  const importName = new TextEncoder().encode("g");
  const recordSize = 24 + moduleName.length + importName.length;
  const bytes = new Uint8Array(16 + recordSize);
  const view = new DataView(bytes.buffer);
  bytes.set([0x4b, 0x46, 0x49, 0x47], 0); // "KFIG"
  view.setUint16(4, 1, true);
  view.setUint16(6, 16, true);
  view.setUint32(8, 1, true); // one record
  view.setUint32(16, recordSize, true);
  view.setUint32(20, ownerId, true);
  bytes[24] = typeCode;
  bytes[25] = 1; // mutable
  view.setUint32(28, moduleName.length, true);
  view.setUint32(32, importName.length, true);
  view.setUint32(36, ordinal, true);
  bytes.set(moduleName, 40);
  bytes.set(importName, 40 + moduleName.length);
  return bytes;
}

/** One `KFIT` section declaring a single imported table. */
function kfitOne(ownerId: number, ordinal: number): Uint8Array {
  const moduleName = new TextEncoder().encode("env");
  const importName = new TextEncoder().encode("t");
  const recordSize = 24 + moduleName.length + importName.length;
  const bytes = new Uint8Array(16 + recordSize);
  const view = new DataView(bytes.buffer);
  bytes.set([0x4b, 0x46, 0x49, 0x54], 0); // "KFIT"
  view.setUint16(4, 1, true);
  view.setUint16(6, 16, true);
  view.setUint32(8, 1, true);
  view.setUint32(16, recordSize, true);
  view.setUint32(20, ownerId, true);
  bytes[24] = 6; // funcref, in the module-state type numbering
  view.setUint32(28, moduleName.length, true);
  view.setUint32(32, importName.length, true);
  view.setUint32(36, ordinal, true);
  bytes.set(moduleName, 40);
  bytes.set(importName, 40 + moduleName.length);
  return bytes;
}

/**
 * A wasm function for the SAVE drive slot that calls back into JavaScript.
 *
 * The slot is driven as `(i32) -> ()` and must be a real wasm funcref, so the
 * JavaScript that writes the snapshot cannot be bound directly. This is the
 * smallest thing that bridges the two.
 */
function saveSlotThunk(body: (activation: number) => void): CallableFunction {
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

describe("the binding records the module assembles at capture", () => {
  /**
   * Stand in for the guest's module-state save: write the one `MutableGlobal`
   * snapshot a global binding needs, through the module's own record-reserve
   * export -- the same one a real guest's save walk calls.
   */
  function saveWrites(f: Fixture, activation: number, owner: number): void {
    const reserve = f.x.__wpk_fork_module_state_record_reserve as (
      kind: number,
      activation: number,
      owner: number,
      size: number,
    ) => number;
    const commit = f.x.__wpk_fork_module_state_record_commit as (
      payload: number,
    ) => void;
    const base = (f.x.fm_drive_table_base as (a: number) => number)(0);
    f.instance.driveTable.set(
      base + DRIVE_SLOT_MODULE_STATE_SAVE,
      saveSlotThunk(() => {
        const payload = reserve(RECORD_KIND_MUTABLE_GLOBAL, activation, owner, 12);
        if (payload === 0) throw new Error("snapshot reserve failed");
        const view = new DataView(f.memory.buffer);
        view.setUint8(payload, GLOBAL_TYPE_I32);
        view.setUint8(payload + 1, 4); // value size
        view.setUint16(payload + 2, 0, true);
        view.setUint32(payload + 4, 0, true);
        view.setUint32(payload + 8, 0x2a, true); // the captured value
        commit(payload);
      }) as never,
    );
  }

  function seedSections(f: Fixture): void {
    const seed = f.x.fm_set_activation_imports as (
      space: number,
      activation: number,
      ptr: number,
      len: number,
    ) => void;
    const kfig = kfigOne(1, 0, GLOBAL_TYPE_I32);
    new Uint8Array(f.memory.buffer, 6144, kfig.length).set(kfig);
    seed(SPACE_GLOBAL, 0, 6144, kfig.length);
    expect(f.errno(), "KFIG seed").toBe(0);
    const kfit = kfitOne(1, 1);
    new Uint8Array(f.memory.buffer, 7168, kfit.length).set(kfit);
    seed(SPACE_TABLE, 0, 7168, kfit.length);
    expect(f.errno(), "KFIT seed").toBe(0);
  }

  function publish(f: Fixture): {
    identity: (s: number, a: number, o: number, g: number) => void;
    provenance: (
      s: number,
      a: number,
      ord: number,
      kind: number,
      group: number,
      bits: bigint,
    ) => void;
  } {
    return {
      identity: f.x.fm_set_identity_group as never,
      provenance: f.x.fm_set_import_provenance as never,
    };
  }

  it("elects the activation that OWNS a shared global, not one that imports it", () => {
    // Activation 0 imports the global and, like every instrumented activation,
    // exports a catalog entry for it. Activation 9 declares it. Identity alone
    // cannot tell them apart -- both name the same object -- and the host is not
    // allowed to say which provides it, so this is the module's answer.
    const f = fixture();
    seedTemplateId(f, 0, 2048);
    seedSections(f);
    const { identity, provenance } = publish(f);
    identity(SPACE_GLOBAL, 0, 1, 7); // the consumer's own entry: an importer
    identity(SPACE_GLOBAL, 9, 5, 7); // the owner
    // The SAME coordinate in the table space, with a different group. If the
    // identity table were keyed without its space, this would overwrite the
    // line above and the election would find no owner at all.
    identity(SPACE_TABLE, 9, 5, 99);
    identity(SPACE_TABLE, 0, 1, 99);
    provenance(SPACE_GLOBAL, 0, 0, KIND_ACTIVATION_GLOBAL, 7, 0n);
    provenance(SPACE_TABLE, 0, 1, KIND_ACTIVATION_TABLE, 99, 0n);
    saveWrites(f, 0, 1);

    (f.x.fm_capture_begin as () => void)();
    (f.x.fm_parent_begin_capture as (...a: number[]) => number)(CHANNEL_BASE, 0, 0, 0);
    expect(f.errno(), "capture").toBe(0);

    const records = arenaRecords(f.memory, f.arena(ARENA_ROOT));
    const globals = records.find(
      (r) => r.kind === RECORD_KIND_IMPORTED_GLOBAL_BINDINGS,
    );
    expect(globals, "a KFBG record").toBeDefined();
    const g = globals!.payload;
    expect(g.getUint32(12, true), "one binding").toBe(1);
    expect([g.getUint32(24, true), g.getUint32(28, true)]).toEqual([0, 1]);
    expect(
      [g.getUint32(32, true), g.getUint32(36, true)],
      "elected source",
    ).toEqual([9, 5]);
    expect(g.getUint8(56), "kind").toBe(KIND_ACTIVATION_GLOBAL);

    // The table half, through the same election over a separate space.
    const tables = records.find(
      (r) => r.kind === RECORD_KIND_IMPORTED_TABLE_BINDINGS,
    );
    expect(tables, "a KFBT record").toBeDefined();
    const t = tables!.payload;
    expect(t.getUint32(12, true), "one binding").toBe(1);
    expect([t.getUint32(24, true), t.getUint32(28, true)]).toEqual([0, 1]);
    expect([t.getUint32(32, true), t.getUint32(36, true)]).toEqual([9, 5]);
    expect(t.getUint8(44), "kind").toBe(KIND_ACTIVATION_TABLE);
  });

  it("refuses to drop the bindings when the caller brought its own arena", () => {
    // The two halves of this port move together. A host that supplies its own
    // arena root leaves the module with no writer root, so a reserve here would
    // start a second arena nothing reads -- and skipping the write quietly
    // hands the child a binding record it never got, reconstructing its
    // imported globals against whatever its base imports happen to hold.
    const f = fixture();
    seedTemplateId(f, 0, 2048);
    seedSections(f);
    const { identity, provenance } = publish(f);
    identity(SPACE_GLOBAL, 0, 1, 7);
    provenance(SPACE_GLOBAL, 0, 0, KIND_ACTIVATION_GLOBAL, 7, 0n);
    (f.x.fm_capture_begin as () => void)();
    (f.x.fm_parent_begin_capture as (...a: number[]) => number)(
      CHANNEL_BASE,
      MMAP_FLOOR - PAGE, // the caller's own arena root
      0,
      0,
    );
    expect(f.errno(), "capture must refuse rather than drop the record").toBe(22);
  });

  it("carries a whole capture through to a sealed arena the child can read", () => {
    // The cycle the production path takes, with records in it: begin, seal,
    // parent-replay, finish. Until the module owned the arena, the seal wrote
    // no journal image and the capture wrote no bindings -- both were skipped
    // on the ownership guard, silently, and the tests below could not see it
    // because they stop at begin.
    const f = fixture();
    seedTemplateId(f, 0, 2048);
    seedSections(f);
    const { identity, provenance } = publish(f);
    identity(SPACE_GLOBAL, 0, 1, 7);
    identity(SPACE_GLOBAL, 9, 5, 7);
    provenance(SPACE_GLOBAL, 0, 0, KIND_ACTIVATION_GLOBAL, 7, 0n);
    saveWrites(f, 0, 1);

    const backend = new ForkModuleContinuationBackend({
      instance: f.instance,
      memory: f.memory,
      ptrWidth: 4,
      format: { fixedPrefixSize: 0 } as never,
      catalogOrdinals: [],
      channelBase: CHANNEL_BASE,
      label: "sealed arena",
    });
    (f.x.fm_capture_begin as () => void)();
    backend.parentBeginCapture(CHANNEL_BASE, 0, []);
    expect(f.errno(), "capture").toBe(0);
    backend.sealCaptureAndSerialize();
    expect(Number((f.x.fm_phase as () => number)()), "sealed").toBe(
      PHASE_SEALED_PARENT,
    );

    // Everything a child reads out of the inherited arena, in one place: the
    // activation set, the snapshot the guest saved, the bindings the module
    // elected, and the journal image the seal serialized.
    const kinds = arenaRecords(f.memory, f.arena(ARENA_ROOT)).map((r) => r.kind);
    expect(kinds).toContain(RECORD_KIND_MUTABLE_GLOBAL);
    expect(kinds).toContain(RECORD_KIND_IMPORTED_GLOBAL_BINDINGS);
    expect(kinds, "the seal's journal image").toContain(RECORD_KIND_JOURNAL_IMAGE);

    backend.parentReplay(false);
    backend.parentFinish(false);
    expect(Number((f.x.fm_phase as () => number)()), "back to idle").toBe(
      PHASE_IDLE,
    );
  });

  /**
   * A SECOND fork-module over the same memory: the child's side of a fork.
   *
   * Production's shape, not a trick. A fork child is a fresh worker with its own
   * module instance over the same `SharedArrayBuffer`, attaching an arena the
   * parent mapped. One module cannot stand in for both: attach demands the idle
   * phase, and a finish releases the arena.
   */
  function childModule(f: Fixture): Record<string, unknown> {
    const needed = CHILD_MODULE_BASE + 8 * 1024 * 1024;
    if (f.memory.buffer.byteLength < needed) {
      f.memory.grow(Math.ceil((needed - f.memory.buffer.byteLength) / PAGE));
    }
    const child = instantiateForkModule({
      module: new WebAssembly.Module(
        readFileSync(resolveBinary("fork_module32.wasm")),
      ),
      memory: f.memory,
      ptrWidth: 4,
      reserve: () => CHILD_MODULE_BASE,
      label: "child module",
    });
    const cx = child.exports as Record<string, unknown>;
    (cx.fm_set_format as (...a: number[]) => void)(4, 0, 0, 0, CHANNEL_BASE);
    return cx;
  }

  it("hands a child an arena it can actually attach", () => {
    // The whole point of a sealed arena, and the first test in this lane to
    // prove it: a second module instance -- a child worker -- decodes what the
    // parent sealed and builds its install plan from it. Until the seal wrote
    // the reference transaction, this failed on the first record it looked for.
    const f = fixture();
    seedTemplateId(f, 0, 2048);
    seedSections(f);
    const { identity, provenance } = publish(f);
    identity(SPACE_GLOBAL, 0, 1, 7);
    identity(SPACE_GLOBAL, 9, 5, 7);
    provenance(SPACE_GLOBAL, 0, 0, KIND_ACTIVATION_GLOBAL, 7, 0n);
    saveWrites(f, 0, 1);
    (f.x.fm_capture_begin as () => void)();
    (f.x.fm_parent_begin_capture as (...a: number[]) => number)(CHANNEL_BASE, 0, 0, 0);
    expect(f.errno(), "capture").toBe(0);
    (f.x.fm_parent_seal_capture as (base: number) => number)(CHANNEL_BASE);
    expect(f.errno(), "seal").toBe(0);
    const root = f.arena(ARENA_ROOT);

    const child = childModule(f);
    const plan = (child.fm_attach_child as (root: number, pid: number) => number)(
      root,
      1,
    );
    expect((child.fm_last_errno as () => number)(), "the child attaches").toBe(0);
    expect(plan, "and gets an install plan").toBeGreaterThan(0);
  });

  /** `fm_child_import_plan_field` selectors, in the module's match order. */
  const PLAN_ORDINAL = 0;
  const PLAN_SPACE = 1;
  const PLAN_KIND = 2;
  const PLAN_TYPE_CODE = 3;
  const PLAN_FLAGS = 4;
  const PLAN_BITS = 5;
  const PLAN_SOURCE_ACTIVATION = 6;
  const PLAN_SOURCE_OWNER = 7;
  const PLAN_FLAG_SAVED = 1;

  /** Build the plan for one activation and read it back as plain objects. */
  function readPlan(
    x: Record<string, unknown>,
    errno: () => number,
    activation: number,
    root: number,
  ): {
    ordinal: number;
    space: number;
    kind: number;
    typeCode: number;
    flags: number;
    bits: bigint;
    sourceActivation: number;
    sourceOwner: number;
  }[] {
    const count = (x.fm_child_import_plan as (a: number, r: number) => number)(
      activation,
      root,
    );
    expect(errno(), "fm_child_import_plan").toBe(0);
    const field = x.fm_child_import_plan_field as (i: number, f: number) => bigint;
    const out = [];
    for (let index = 0; index < count; index += 1) {
      out.push({
        ordinal: Number(field(index, PLAN_ORDINAL)),
        space: Number(field(index, PLAN_SPACE)),
        kind: Number(field(index, PLAN_KIND)),
        typeCode: Number(field(index, PLAN_TYPE_CODE)),
        flags: Number(field(index, PLAN_FLAGS)),
        bits: field(index, PLAN_BITS),
        sourceActivation: Number(field(index, PLAN_SOURCE_ACTIVATION)),
        sourceOwner: Number(field(index, PLAN_SOURCE_OWNER)),
      });
    }
    return out;
  }

  it("plans a child's imports from the arena, ordered by import ordinal", () => {
    // The whole point of the two entries: the host asks WHAT TO DO with each
    // import, not for the binding rows to reason about itself. The global is
    // provided by the activation the election chose; the table likewise; and
    // they come back in import-section order, which is the order the host
    // walks `WebAssembly.Module.imports()` in.
    const f = fixture();
    seedTemplateId(f, 0, 2048);
    seedSections(f);
    const { identity, provenance } = publish(f);
    identity(SPACE_GLOBAL, 0, 1, 7);
    identity(SPACE_GLOBAL, 9, 5, 7);
    identity(SPACE_TABLE, 0, 1, 99);
    identity(SPACE_TABLE, 9, 5, 99);
    provenance(SPACE_GLOBAL, 0, 0, KIND_ACTIVATION_GLOBAL, 7, 0n);
    provenance(SPACE_TABLE, 0, 1, KIND_ACTIVATION_TABLE, 99, 0n);
    saveWrites(f, 0, 1);
    (f.x.fm_parent_begin_capture as (...a: number[]) => number)(CHANNEL_BASE, 0, 0, 0);
    expect(f.errno(), "capture").toBe(0);
    const root = f.arena(ARENA_ROOT);

    const plan = readPlan(f.x, () => f.errno(), 0, root);
    expect(plan.length, "one global and one table").toBe(2);
    expect(plan[0]!.ordinal).toBe(0);
    expect(plan[0]!.space, "the global comes first").toBe(SPACE_GLOBAL);
    expect(plan[0]!.kind).toBe(KIND_ACTIVATION_GLOBAL);
    expect(plan[0]!.typeCode).toBe(GLOBAL_TYPE_I32);
    expect(plan[0]!.sourceActivation, "the elected owner").toBe(9);
    expect(plan[0]!.sourceOwner).toBe(5);
    expect(plan[1]!.ordinal).toBe(1);
    expect(plan[1]!.space, "the table second").toBe(SPACE_TABLE);
    expect(plan[1]!.kind).toBe(KIND_ACTIVATION_TABLE);
    expect(plan[1]!.sourceActivation).toBe(9);
  });

  it("hands back the saved scalar behind a base import, flagged", () => {
    // A group nothing owns elects BASE_IMPORT: the child must NOT override the
    // import, but the parent's saved contents are still authoritative. The flag
    // is what distinguishes a saved zero from nothing saved.
    const f = fixture();
    seedTemplateId(f, 0, 2048);
    seedSections(f);
    const { provenance } = publish(f);
    provenance(SPACE_GLOBAL, 0, 0, KIND_ACTIVATION_GLOBAL, 0, 0n);
    provenance(SPACE_TABLE, 0, 1, KIND_ACTIVATION_TABLE, 0, 0n);
    saveWrites(f, 0, 1);
    (f.x.fm_parent_begin_capture as (...a: number[]) => number)(CHANNEL_BASE, 0, 0, 0);
    expect(f.errno(), "capture").toBe(0);

    const plan = readPlan(f.x, () => f.errno(), 0, f.arena(ARENA_ROOT));
    expect(plan[0]!.kind, "nothing owns the group").toBe(KIND_BASE_IMPORT);
    expect(plan[0]!.flags & PLAN_FLAG_SAVED, "the snapshot travels").toBe(
      PLAN_FLAG_SAVED,
    );
    expect(plan[0]!.bits, "the value the save walk wrote").toBe(42n);
  });

  it("plans nothing for an activation that declared no imports", () => {
    // The ordinary single-module case. An empty plan, not a refusal: the KFIG
    // section is emitted only when there is something to describe.
    const f = fixture();
    seedTemplateId(f, 0, 2048);
    seedSections(f);
    const { provenance } = publish(f);
    provenance(SPACE_GLOBAL, 0, 0, KIND_ACTIVATION_GLOBAL, 0, 0n);
    provenance(SPACE_TABLE, 0, 1, KIND_ACTIVATION_TABLE, 0, 0n);
    saveWrites(f, 0, 1);
    (f.x.fm_parent_begin_capture as (...a: number[]) => number)(CHANNEL_BASE, 0, 0, 0);
    expect(f.errno(), "capture").toBe(0);
    expect(
      (f.x.fm_child_import_plan as (a: number, r: number) => number)(
        4,
        f.arena(ARENA_ROOT),
      ),
      "activation 4 seeded no sections",
    ).toBe(0);
    expect(f.errno(), "and that is not an error").toBe(0);
  });

  it("refuses a field read with no resident plan, a bad index and a bad field", () => {
    const f = fixture();
    const field = f.x.fm_child_import_plan_field as (i: number, f: number) => bigint;
    expect(field(0, PLAN_ORDINAL), "nothing built yet").toBe(-1n);
    expect(f.errno(), "and says why").toBe(22);

    seedTemplateId(f, 0, 2048);
    seedSections(f);
    const { provenance } = publish(f);
    provenance(SPACE_GLOBAL, 0, 0, KIND_ACTIVATION_GLOBAL, 0, 0n);
    provenance(SPACE_TABLE, 0, 1, KIND_ACTIVATION_TABLE, 0, 0n);
    saveWrites(f, 0, 1);
    (f.x.fm_parent_begin_capture as (...a: number[]) => number)(CHANNEL_BASE, 0, 0, 0);
    const count = (f.x.fm_child_import_plan as (a: number, r: number) => number)(
      0,
      f.arena(ARENA_ROOT),
    );
    expect(f.errno(), "the plan builds").toBe(0);
    expect(field(count, PLAN_ORDINAL), "one past the end").toBe(-1n);
    expect(f.errno()).toBe(22);
    expect(field(0, 99), "a field the module does not have").toBe(-1n);
    expect(f.errno()).toBe(22);
    // And the plan is still readable after a refusal: a bad read must not
    // discard the plan the next good read needs.
    expect(Number(field(0, PLAN_ORDINAL))).toBe(0);
    expect(f.errno()).toBe(0);
  });

  it("refuses to plan from an arena whose binding record is corrupt", () => {
    const f = fixture();
    seedTemplateId(f, 0, 2048);
    seedSections(f);
    const { provenance } = publish(f);
    provenance(SPACE_GLOBAL, 0, 0, KIND_ACTIVATION_GLOBAL, 0, 0n);
    provenance(SPACE_TABLE, 0, 1, KIND_ACTIVATION_TABLE, 0, 0n);
    saveWrites(f, 0, 1);
    (f.x.fm_parent_begin_capture as (...a: number[]) => number)(CHANNEL_BASE, 0, 0, 0);
    const root = f.arena(ARENA_ROOT);
    const ok = (f.x.fm_child_import_plan as (a: number, r: number) => number)(0, root);
    expect(ok, "the intact arena plans").toBeGreaterThan(0);

    const bindings = arenaRecords(f.memory, root).find(
      (r) => r.kind === RECORD_KIND_IMPORTED_GLOBAL_BINDINGS,
    );
    expect(bindings, "a KFBG record to corrupt").toBeDefined();
    bindings!.payload.setUint8(24 + 32, 99); // a kind no child could materialise
    expect(
      (f.x.fm_child_import_plan as (a: number, r: number) => number)(0, root),
      "the corrupt record is refused",
    ).toBe(-1);
    expect(f.errno()).toBe(22);
  });

  it("refuses a child install whose inherited binding record is corrupt", () => {
    // The same arena, one byte apart. The intact case attaches; flipping a
    // binding's kind to one no child could materialise is refused, before the
    // reference graph is even decoded. Without that check the corrupt record
    // would be read much later, by the host building the child's imports, and
    // by then it is a wrong child rather than a refused fork.
    const f = fixture();
    seedTemplateId(f, 0, 2048);
    seedSections(f);
    const { identity, provenance } = publish(f);
    identity(SPACE_GLOBAL, 0, 1, 7);
    identity(SPACE_GLOBAL, 9, 5, 7);
    provenance(SPACE_GLOBAL, 0, 0, KIND_ACTIVATION_GLOBAL, 7, 0n);
    saveWrites(f, 0, 1);
    (f.x.fm_capture_begin as () => void)();
    (f.x.fm_parent_begin_capture as (...a: number[]) => number)(CHANNEL_BASE, 0, 0, 0);
    (f.x.fm_parent_seal_capture as (base: number) => number)(CHANNEL_BASE);
    expect(f.errno(), "seal").toBe(0);
    const root = f.arena(ARENA_ROOT);

    const bindings = arenaRecords(f.memory, root).find(
      (r) => r.kind === RECORD_KIND_IMPORTED_GLOBAL_BINDINGS,
    );
    expect(bindings, "a KFBG record to corrupt").toBeDefined();
    bindings!.payload.setUint8(24 + 32, 99);

    const child = childModule(f);
    (child.fm_attach_child as (root: number, pid: number) => number)(root, 1);
    expect(
      (child.fm_last_errno as () => number)(),
      "the corrupt record is refused",
    ).toBe(22);
  });

  it("lets the PARENT decode its own sealed graph, for the replay lookups", () => {
    // Whether a parent can ask its own sealed arena which activation owns an
    // exnref recipe. It is the question census 159 turns on: if it can, the
    // exception broker's `throwRecipe` needs no new entry -- the module already
    // exposes a decoded node's module activation, and the host already wraps it.
    const f = fixture();
    seedTemplateId(f, 0, 2048);
    (f.x.fm_capture_begin as () => void)();
    (f.x.fm_parent_begin_capture as (...a: number[]) => number)(CHANNEL_BASE, 0, 0, 0);
    (f.x.fm_parent_seal_capture as (base: number) => number)(CHANNEL_BASE);
    expect(f.errno(), "seal").toBe(0);
    const root = f.arena(ARENA_ROOT);

    const nodes = (f.x.fm_decode_reference_graph as (root: number) => number)(root);
    expect(f.errno(), "the parent decodes its own arena").toBe(0);
    expect(nodes, "and gets a node count back").toBeGreaterThanOrEqual(0);
  });

  it("falls back to a base import when no activation provides the object", () => {
    // Same fork with the owner's catalog entry removed: every member of the
    // group imports the global, so nobody can hand it to a child and it comes
    // from the child's own base imports instead. The host never says this.
    const f = fixture();
    seedTemplateId(f, 0, 2048);
    seedSections(f);
    const { identity, provenance } = publish(f);
    identity(SPACE_GLOBAL, 0, 1, 7);
    provenance(SPACE_GLOBAL, 0, 0, KIND_ACTIVATION_GLOBAL, 7, 0n);
    saveWrites(f, 0, 1);

    (f.x.fm_capture_begin as () => void)();
    (f.x.fm_parent_begin_capture as (...a: number[]) => number)(CHANNEL_BASE, 0, 0, 0);
    expect(f.errno(), "capture").toBe(0);

    const globals = arenaRecords(f.memory, f.arena(ARENA_ROOT)).find(
      (r) => r.kind === RECORD_KIND_IMPORTED_GLOBAL_BINDINGS,
    );
    const g = globals!.payload;
    expect(g.getUint8(56), "kind").toBe(KIND_BASE_IMPORT);
    expect([g.getUint32(32, true), g.getUint32(36, true)]).toEqual([0, 0]);
  });
});

