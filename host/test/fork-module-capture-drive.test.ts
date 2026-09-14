import { readFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { afterAll, describe, expect, it } from "vitest";
import { resolveBinary } from "../src/binary-resolver";
import { instantiateForkModule } from "../src/fork-module-instance";
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
const DRIVE_SLOT_UNWIND_BEGIN = 10;
const DRIVE_SLOT_MODULE_STATE_SAVE = 13;

// `fm_module_state_arena` operations.
const ARENA_ROOT = 0;
const ARENA_OWNED = 3;

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

interface Fixture {
  x: Record<string, unknown>;
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
  table.set(base + DRIVE_SLOT_MODULE_STATE_SAVE, guest.gc_allocate as never);
  table.set(base + DRIVE_SLOT_UNWIND_BEGIN, guest.gc_fill as never);

  const call = x.fm_module_state_arena as (o: number, a: number) => bigint;
  return {
    x,
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
