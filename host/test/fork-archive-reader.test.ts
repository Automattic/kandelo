import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHILD_PID,
  MMAP_FAIL_SWITCH,
  MODE_FORK,
  PAGE,
  RESPONDER_TID,
  fixture,
  registerMain,
  runFork,
  type Fixture,
} from "./fork-module-capture-fixture";

/**
 * The fork's hold on the process dynamic-loader archive belongs to the fork
 * module (lane F step 3c, ruling 4).
 *
 * A fork holds the archive READER from the moment its capture opens until the
 * parent's finish, so no library joins the archive between the snapshot and
 * the child. The host used to take and return that token around the module's
 * capture and finish; the module owns both ends of that window, so it owns
 * the token, on the same lock word and in the same encoding the host's loader
 * uses (zero free, -1 the writer, a positive count of readers). The loader
 * still must not take the WRITER while this Worker's fork holds a reader, so
 * the module mirrors "held" into the exported `__wpk_fork_archive_reader_held`
 * global that the loader reads.
 */

/** A process archive control block, on a page free in the fixture's layout. */
const ARCHIVE_CONTROL = 10 * PAGE;
/** `DLOPEN_LOCK_OFFSET_WASM32` / `DLOPEN_OWNER_OFFSET_WASM32` in worker-main. */
const LOCK_WORD = ARCHIVE_CONTROL - 20;
const OWNER_WORD = ARCHIVE_CONTROL - 24;
const EDEADLK = 35;
const ENOMEM = 12;

function withArchive(): { f: Fixture; lock: () => number; held: () => number } {
  const f = fixture({ archiveControl: ARCHIVE_CONTROL });
  new Uint8Array(f.memory.buffer, ARCHIVE_CONTROL - 64, 64).fill(0);
  const words = new Int32Array(f.memory.buffer);
  const global = f.instance.exports.__wpk_fork_archive_reader_held;
  if (!(global instanceof WebAssembly.Global)) {
    throw new Error("the fork module exports no __wpk_fork_archive_reader_held");
  }
  return {
    f,
    lock: () => Atomics.load(words, LOCK_WORD / 4),
    held: () => Number(global.value),
  };
}

/** The guest's `fork()`, called directly: no run loop, so only its open. */
const openFork = (f: Fixture): number =>
  (f.x.__wpk_fork_kernel_fork as (mode: number) => number)(MODE_FORK);

describe("the fork module owns the fork's archive reader", () => {
  it("takes the reader as the capture opens and returns it at the finish", () => {
    const { f, lock, held } = withArchive();
    const seen: Array<[string, number, number]> = [];
    const run = runFork(f, {
      duringCapture: () => void seen.push(["capture", lock(), held()]),
      duringReplay: () => void seen.push(["replay", lock(), held()]),
    });
    expect(run.forkReturn).toBe(DEFAULT_CHILD_PID);
    expect(seen, "one reader on the process lock word, the probe seeing it, held across the seal")
      .toEqual([
        ["capture", 1, 1],
        ["replay", 1, 1],
      ]);
    expect(lock(), "the finish hands the reader back").toBe(0);
    expect(held(), "and the probe says so").toBe(0);
  });

  it("returns the reader when the fork is abandoned", () => {
    // A host exception left the fork mid-capture (an exec retirement); the
    // host's trap guard calls `fm_abort`.
    const { f, lock, held } = withArchive();
    let during = -1;
    expect(() =>
      runFork(f, {
        duringCapture: () => {
          during = lock();
          throw new Error("abandoned");
        },
      }),
    ).toThrow("abandoned");
    expect(during).toBe(1);
    (f.x.fm_abort as () => void)();
    expect(lock(), "an abandoned fork holds nothing").toBe(0);
    expect(held()).toBe(0);
  });

  it("returns the reader when the capture cannot open", () => {
    const { f, lock, held } = withArchive();
    registerMain(f);
    const view = new DataView(f.memory.buffer);
    view.setUint32(MMAP_FAIL_SWITCH, 1, true);
    let opened: number;
    try {
      opened = openFork(f);
    } finally {
      view.setUint32(MMAP_FAIL_SWITCH, 0, true);
    }
    expect(opened, "fork() fails: no memory for the capture").toBe(-ENOMEM);
    expect(lock(), "a capture that never opened holds no reader").toBe(0);
    expect(held()).toBe(0);
  });

  it("refuses with EDEADLK when this thread's own loader transaction holds the writer", () => {
    // A fork from a library constructor this Worker's loader is running while
    // it still holds the writer: the reader can never be had, and waiting
    // would wait on itself.
    const { f, lock, held } = withArchive();
    registerMain(f);
    const words = new Int32Array(f.memory.buffer);
    Atomics.store(words, OWNER_WORD / 4, RESPONDER_TID);
    Atomics.store(words, LOCK_WORD / 4, -1);
    expect(openFork(f), "fork() fails with EDEADLK").toBe(-EDEADLK);
    expect(lock(), "the loader's writer is untouched").toBe(-1);
    expect(held()).toBe(0);
  });

  it("does not wait on this thread's own loader transaction once the writer is free", () => {
    // POSIX fork keeps only the calling thread, so a peer's half-run
    // constructor must be waited out -- but a constructor on THIS thread is
    // the calling thread's own frames, and a fork from it is legal.
    const { f, lock } = withArchive();
    const words = new Int32Array(f.memory.buffer);
    Atomics.store(words, OWNER_WORD / 4, RESPONDER_TID);
    let during = -1;
    const run = runFork(f, { duringCapture: () => void (during = lock()) });
    expect(during).toBe(1);
    expect(run.forkReturn).toBe(DEFAULT_CHILD_PID);
    expect(lock()).toBe(0);
  });
});
