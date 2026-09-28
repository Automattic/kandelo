import { describe, expect, it } from "vitest";
import {
  ForkModuleContinuationBackend,
  FORK_ACTIVATION_DRIVE_BINDINGS,
  type ForkChildPlan,
} from "../src/fork-module-backend";
import {
  ABORT_CAUSE_FRAME_RESERVE,
  ABORT_CAUSE_LAUNCH,
  ABORT_CAUSE_SEAL,
  CAPTURE_KIND_ARRAY,
  CAPTURE_KIND_STRUCT,
  DEFAULT_CHILD_PID,
  DIAGNOSTIC_ABORTED,
  FORK_LAST_SYSCALL,
  INTERN_KIND_I31,
  MODE_VFORK,
  VFORK_PREFIX_BYTES,
  VFORK_SCRATCH_BYTES,
  captureGraph,
  CHANNEL_BASE,
  DRIVE_SLOT_ABORT_BEGIN,
  DRIVE_SLOT_ABORT_END,
  DRIVE_SLOT_MODULE_STATE_SAVE,
  DRIVE_SLOT_REWIND_BEGIN,
  DRIVE_SLOT_REWIND_END,
  DRIVE_SLOT_UNWIND_BEGIN,
  DRIVE_SLOT_UNWIND_END,
  EBUSY,
  MMAP_COUNTER,
  MODULE_BASE,
  MUNMAP_COUNTER,
  PAGE,
  CHILD_CONTROL,
  DRIVE_SLOT_FINISH_RESTORE,
  DRIVE_SLOT_RESTORE,
  childInstance,
  installableChild,
  fixture,
  saveSlotThunk,
  admitActivation,
  admitInto,
  bindActivation,
  driveBase,
  publishInto,
  recordSaves,
  runFork,
  sideTemplate,
  voidSlotThunk,
  type Fixture,
} from "./fork-module-capture-fixture";
import { bind, exportRow, importRow } from "./support/fork-admission";
import { HOST_INTERCEPTED_SYSCALLS } from "../src/generated/abi";

/** The per-activation drive stride: one slot per binding. */
const FORK_ACTIVATION_DRIVE_SLOTS = FORK_ACTIVATION_DRIVE_BINDINGS.length;

const EINVAL = 22;
const EAGAIN = 11;

/**
 * A frame reserve that fails mid-capture, the way the guest's own reserve
 * does when memory runs out -- through the per-activation entry, for an
 * activation this capture never opened, which the module refuses with EINVAL
 * before it touches any writer. The failure's CAUSE is not what these tests
 * are about; what the module does with a failed reserve is.
 */
function failReserve(f: Fixture): number {
  return (f.x.fm_frame_reserve as (activation: number, size: number) => number)(0xdead, 16);
}

/**
 * Bind activation 0's lifecycle slots to recording thunks, so a test sees the
 * ORDER the module drove the guest in -- the observable a phase probe used to
 * stand in for. Each slot keeps its shape: the begin slots take a root, the
 * end slots take nothing.
 */
function recordLifecycle(f: Fixture): string[] {
  const drove: string[] = [];
  const base = driveBase(0);
  const table = f.instance.driveTable;
  for (const [slot, name] of [
    [DRIVE_SLOT_UNWIND_BEGIN, "unwind_begin"],
    [DRIVE_SLOT_REWIND_BEGIN, "rewind_begin"],
    [DRIVE_SLOT_ABORT_BEGIN, "abort_begin"],
  ] as const) {
    table.set(base + slot, saveSlotThunk(() => drove.push(name)) as never);
  }
  for (const [slot, name] of [
    [DRIVE_SLOT_UNWIND_END, "unwind_end"],
    [DRIVE_SLOT_REWIND_END, "rewind_end"],
    [DRIVE_SLOT_ABORT_END, "abort_end"],
  ] as const) {
    table.set(base + slot, voidSlotThunk(() => drove.push(name)) as never);
  }
  return drove;
}

describe("capture begin, driven through a serviced channel", () => {
  it("allocates its own arena and declares the activation set into it", () => {
    const f = fixture();
    admitActivation(f, 0);
    expect(f.errno()).toBe(0);

    let rootDuringCapture = 0;
    const run = runFork(f, {
      duringCapture: ({ root }) => {
        rootDuringCapture = root;
      },
    });
    // The fact that was unverifiable before: the module made an arena, and
    // the capture's continuation prefix names it. That it owns (and frees)
    // exactly the chunks behind it is the mapping-balance test further down.
    expect(rootDuringCapture, "the open capture names its arena").toBeGreaterThan(0);
    expect(run.forkReturn, "and the fork completes with the kernel's child").toBe(
      DEFAULT_CHILD_PID,
    );
  });

  it("captures a fork with a SIDE activation, the way a dlopen fork does", () => {
    // The multi-activation capture path, which nothing exercised until the
    // dlopen e2e suite could run again. A bound side activation is added to
    // the SAME capture -- the module walks the activations it bound, the host
    // names none -- and every step that follows -- the arena, the Module
    // records, the guest save drive -- has to cover both activations or the
    // child rebuilds only one.
    const f = fixture();
    admitActivation(f, 0);
    // Both activations' drive slots, the way `bindActivationDrive` binds them.
    // Without activation 1's the capture `call_indirect`s past the end of the
    // table -- which is what a host that registers an activation and forgets to
    // grow the table would do.
    const driven = recordSaves(f, [0, 1]);
    let modules: number[] = [];
    let root = 0;
    const run = runFork(f, {
      sides: [1],
      duringCapture: (open) => {
        root = open.root;
        modules = arenaRecords(f.memory, open.root)
          .filter((r) => r.kind === RECORD_KIND_MODULE)
          .map((r) => r.activation);
      },
    });
    expect(run.forkReturn, "a two-activation fork completes").toBe(DEFAULT_CHILD_PID);
    expect(driven.sort(), "the save walk covers BOTH activations").toEqual([0, 1]);
    expect(root, "into an arena of its own").toBeGreaterThan(0);
    expect(
      modules.sort(),
      "one Module record per activation, or the child installs only one",
    ).toEqual([0, 1]);
  });

  it("walks only the side activations it BOUND, not every one it admitted", () => {
    // A `dlopen` can be refused AFTER its admission: the Node/browser host
    // admits a side module, then refuses the 65th activation while it builds
    // the imports, and nothing releases the admission
    // (`fork-dlclose-activation.test.ts`, "refuses the dlopen past the
    // activation cap"). That activation was never instantiated, so it has no
    // drive slots; a capture that walked it would `call_indirect` through an
    // unbound slot and trap. Only BINDING says an activation was instantiated
    // and registered, so the bound set is the one the capture walks.
    const f = fixture();
    admitActivation(f, 1, { template: sideTemplate(1) });
    expect(f.errno(), "the refused dlopen's admission").toBe(0);
    const driven = recordSaves(f, [0]);
    let modules: number[] = [];
    const run = runFork(f, {
      duringCapture: ({ root }) => {
        modules = arenaRecords(f.memory, root)
          .filter((r) => r.kind === RECORD_KIND_MODULE)
          .map((r) => r.activation);
      },
    });
    expect(run.forkReturn, "the fork completes").toBe(DEFAULT_CHILD_PID);
    expect(driven, "only activation 0 is walked").toEqual([0]);
    expect(modules, "and declared").toEqual([0]);
  });

  it("records where every activation's continuation begins, for the child", () => {
    // A child reads the launch anchor to find activation 0's continuation, and
    // nothing else says where a SIDE activation's begins -- it is a per-fork
    // address, not a static property of the loaded module. The JS coordinator
    // wrote this manifest at seal and read it back on the child; the write went
    // with the coordinator and the record kind sat defined and unused. Without
    // it a multi-activation child cannot be seeded at all. Census 183.
    //
    // Read while the parent replays: the seal has written the manifest and the
    // parent has not yet returned from `fork()`.
    const f = fixture();
    admitActivation(f, 0);
    let manifest: ArenaRecord | undefined;
    const run = runFork(f, {
      sides: [1],
      duringReplay: ({ root }) => {
        manifest = arenaRecords(f.memory, root).find(
          (r) => r.kind === RECORD_KIND_ACTIVATION_CONTINUATIONS,
        );
      },
    });
    expect(run.forkReturn, "a two-activation fork completes").toBe(DEFAULT_CHILD_PID);
    expect(manifest, "the seal writes a KFAC manifest").toBeDefined();
    const p = manifest!.payload;
    expect(
      String.fromCharCode(p.getUint8(0), p.getUint8(1), p.getUint8(2), p.getUint8(3)),
      "magic",
    ).toBe("KFAC");
    expect(p.getUint32(12, true), "one entry per activation").toBe(2);
    const header = p.getUint16(6, true);
    const entry = p.getUint16(8, true);
    const seen = new Map<number, number>();
    for (let i = 0; i < 2; i += 1) {
      const at = header + i * entry;
      seen.set(p.getUint32(at, true), Number(p.getBigUint64(at + 8, true)));
    }
    expect([...seen.keys()].sort(), "both activations").toEqual([0, 1]);
    expect(seen.get(0), "activation 0's root is the one the kernel was given").toBe(
      run.anchor,
    );
    expect(seen.get(1), "and the side activation has one of its own")
      .toBeGreaterThan(0);
    expect(seen.get(1), "distinct from activation 0's").not.toBe(run.anchor);
  });

  it("writes no manifest for a single-activation capture", () => {
    // The child reads the launch anchor for activation 0; a manifest would only
    // repeat it, and writing one would put a record in every ordinary fork's
    // arena for nobody.
    const f = fixture();
    admitActivation(f, 0);
    let manifests = -1;
    runFork(f, {
      duringReplay: ({ root }) => {
        manifests = arenaRecords(f.memory, root).filter(
          (r) => r.kind === RECORD_KIND_ACTIVATION_CONTINUATIONS,
        ).length;
      },
    });
    expect(manifests).toBe(0);
  });
});

describe("the module frees exactly what it mapped", () => {
  it("returns every mapping an aborted fork took", () => {
    // `begin_capture_impl` states the rule: the module frees exactly what the
    // module mapped. The KFMS arena's chunks, each activation's frame chunks
    // and the journal image are all mapped by the module through the syscall
    // channel, and an aborted fork has no child to read any of them. Counted
    // through the responder's tallies rather than a chunk count, so a chunk
    // unlinked but never unmapped reads as the leak it is.
    const f = fixture();
    const tally = (): [number, number] => {
      const view = new DataView(f.memory.buffer);
      return [view.getUint32(MMAP_COUNTER, true), view.getUint32(MUNMAP_COUNTER, true)];
    };
    const abortedFork = (): void => {
      const run = runFork(f, {
        // A frame reserve that fails mid-capture: the module aborts on the
        // spot, and the guest's `fork()` finishes that abort.
        duringCapture: () => {
          expect(failReserve(f), "the reserve fails").toBe(0);
          return "aborted";
        },
      });
      expect(run.forkReturn, "fork() returns the reserve's -errno").toBe(-EINVAL);
      expect(run.forkCalls, "and no child was asked for").toBe(0);
    };
    // The FIRST fork in a worker also maps the bump heap's chunk, which a
    // durable instance keeps for the next fork by design
    // (`fork-bump-heap.test.ts`). So the balance is measured on the second.
    abortedFork();
    const [mmapsBefore, munmapsBefore] = tally();
    abortedFork();
    const [mmapsAfter, munmapsAfter] = tally();
    const mapped = mmapsAfter - mmapsBefore;
    expect(mapped, "the fork mapped its arena and its frames").toBeGreaterThan(0);
    expect(munmapsAfter - munmapsBefore, "and unmapped every one of them").toBe(mapped);
  });
});

describe("the module frees a completed fork's arena", () => {
  it("does not keep one mapping per completed fork", () => {
    // A completed fork's KFMS arena outlives its own replay on purpose: a
    // vfork borrower reads its owner's arena until it execs or exits. By the
    // NEXT capture in this worker nothing can read it -- the borrower is gone
    // and a copied child has its own copy -- so the module that mapped it must
    // unmap it then. Counted through the responder's tallies, so a chunk list
    // dropped without its munmaps reads as the leak it is.
    const f = fixture();
    const live = (): number => {
      const view = new DataView(f.memory.buffer);
      return view.getUint32(MMAP_COUNTER, true) - view.getUint32(MUNMAP_COUNTER, true);
    };
    const completedFork = (): void => {
      expect(runFork(f).forkReturn, "the fork completes").toBe(DEFAULT_CHILD_PID);
    };
    // The first fork maps the bump heap's chunk, which a durable instance
    // keeps by design (`fork-bump-heap.test.ts`), and the latest completed
    // fork's arena is legitimately live. So compare two later points: in a
    // steady state each fork frees the previous fork's arena as it maps its
    // own, and the number of live mappings stops growing.
    completedFork();
    completedFork();
    const after2 = live();
    for (let i = 0; i < 4; i += 1) completedFork();
    expect(live(), "live mappings after six completed forks vs after two").toBe(after2);
  });
});

describe("the parent fork lifecycle, end to end through the module", () => {
  it("unwinds, seals, asks the kernel for the child, replays and finishes", () => {
    // The sequence a host used to call one entry at a time, now the module's
    // own: `fm_run` runs it, and what a test can see is what the guest and
    // the kernel see -- the order the guest was driven in, the one fork
    // syscall, and what `fork()` returned.
    const f = fixture();
    admitActivation(f, 0);
    const drove = recordLifecycle(f);
    const run = runFork(f);
    expect(drove, "capture, seal, parent replay, finish").toEqual([
      "unwind_begin",
      "unwind_end",
      "rewind_begin",
      "rewind_end",
    ]);
    expect(run.forkCalls, "one fork syscall").toBe(1);
    expect(
      new DataView(f.memory.buffer).getUint32(FORK_LAST_SYSCALL, true),
      "SYS_FORK for a fork()",
    ).toBe(HOST_INTERCEPTED_SYSCALLS.SYS_FORK);
    expect(run.forkReturn, "and fork() returns the kernel's child pid").toBe(DEFAULT_CHILD_PID);
    expect(run.diagnostics.map((d) => d.kind), "no abort to report").not.toContain(
      DIAGNOSTIC_ABORTED,
    );
    // Back at idle: the next fork runs the same way.
    expect(runFork(f).forkReturn, "a second fork").toBe(DEFAULT_CHILD_PID);
  });

  it("returns 0 in a COW child whose module statics are its parent's", () => {
    // A COW child's memory is its parent's, and so is its module's state: a
    // child instance at the parent's own region reads what the parent's
    // module held when the kernel copied it -- here, the pid the parent's
    // previous fork returned. The child's `fork()` must still return 0, so
    // the install, not the copy, decides what it returns.
    const f = fixture();
    admitActivation(f, 0);
    expect(runFork(f).forkReturn, "the parent's first fork").toBe(DEFAULT_CHILD_PID);
    let childReturn = -1;
    runFork(f, {
      duringReplay: ({ anchor }) => {
        const child = installableChild(f, {}, { moduleBase: MODULE_BASE, label: "COW child" });
        expect(child.install(anchor), "the child installs").toBe(0);
        childReturn = child.run();
      },
    });
    expect(childReturn).toBe(0);
  });

  it("counts every capture it opens, for a host that keeps per-capture state", () => {
    // host-native numbers the GC objects a capture meets by rooting them, and
    // empties that pool when this count moves: it has no call of its own at a
    // capture's open since the module serves `fork()` itself.
    const f = fixture();
    const opened = (): number => Number((f.x.fm_stats as (n: number) => bigint)(106));
    const before = opened();
    runFork(f);
    runFork(f, { answer: -EAGAIN });
    expect(opened() - before, "two forks, two captures").toBe(2);
  });

  it("tells the kernel a borrowed child's workspace from the seal", () => {
    // The workspace a vfork BORROWED child needs is fixed once the capture
    // seals -- the activation set has stopped growing and the scratch
    // high-water has peaked -- so the seal answers it, and the module hands it
    // to the kernel with `SYS_VFORK`: the borrowed prefix and the scratch
    // bytes. (It was `fm_borrowed_replay_workspace`, then the seal row a host
    // read back; no host reads it now.)
    const f = fixture();
    admitActivation(f, 0);
    let journalImage = false;
    const run = runFork(f, {
      mode: MODE_VFORK,
      duringCapture: () => {
        const scratch = f.x.__wpk_fork_ref_scratch_reserve as (n: number) => number;
        const release = f.x.__wpk_fork_ref_scratch_release as (p: number, n: number) => void;
        release(scratch(128), 128);
      },
      duringReplay: ({ root }) => {
        journalImage = arenaRecords(f.memory, root).some(
          (r) => r.kind === RECORD_KIND_JOURNAL_IMAGE,
        );
      },
    });
    expect(run.forkReturn, "the vfork completes").toBe(DEFAULT_CHILD_PID);
    expect(journalImage, "the seal serialized the replay-journal image").toBe(true);
    const view = new DataView(f.memory.buffer);
    expect(view.getUint32(FORK_LAST_SYSCALL, true), "SYS_VFORK for a vfork()").toBe(
      HOST_INTERCEPTED_SYSCALLS.SYS_VFORK,
    );
    // One activation, whose fixed prefix this fixture seeded as 0; the scratch
    // high-water is the 128 bytes the capture opened (a multiple of the
    // scratch alignment, so the reservation is not rounded up).
    expect(view.getUint32(VFORK_PREFIX_BYTES, true), "the borrowed prefix").toBe(0);
    expect(view.getUint32(VFORK_SCRATCH_BYTES, true), "the scratch high-water").toBe(128);
  });

  it("aborts a capture whose frame reserve fails, and without driving unwind-end", () => {
    // The mid-unwind failure path: a frame reserve came back 0, so the capture
    // cannot complete. The guest's reserve==0 contract restarts its live
    // activation in the abort loop, which assumes the abort replay is ALREADY
    // established when the 0 arrives -- so the module begins it inside the
    // reserve. It seals WITHOUT driving the guest's unwind-end (the guest is
    // still mid-unwind; driving it there corrupts its state machine), then
    // abort-replays the frames that did commit.
    const f = fixture();
    const drove = recordLifecycle(f);
    let reserveErrno = -1;
    let droveAtReserve: string[] = [];
    const run = runFork(f, {
      duringCapture: () => {
        expect(failReserve(f), "the reserve reports failure to the guest").toBe(0);
        reserveErrno = f.errno();
        droveAtReserve = [...drove];
        return "aborted";
      },
    });
    expect(reserveErrno, "with the reserve's own errno").toBe(EINVAL);
    expect(droveAtReserve, "the abort began without the unwind-end flip").toEqual([
      "unwind_begin",
      "abort_begin",
    ]);
    // The finish hands back what the abort recorded: the errno `fork()`
    // returns negated, and the cause (a failed frame reserve), which the
    // module reports through the kernel.
    expect(run.forkReturn).toBe(-EINVAL);
    expect(drove.at(-1), "and the abort replay finished").toBe("abort_end");
    expect(run.forkCalls, "no child was asked for").toBe(0);
    expect(run.diagnostics).toContainEqual({
      kind: DIAGNOSTIC_ABORTED,
      values: [EINVAL, ABORT_CAUSE_FRAME_RESERVE, 0, 0, 0],
    });
  });

  it("records the kernel's errno when the kernel refuses the child", () => {
    // The one abort the kernel decides: the parent's frames replay through
    // the abort path and `fork()` returns the kernel's -errno.
    const f = fixture();
    const drove = recordLifecycle(f);
    const run = runFork(f, { answer: -EAGAIN });
    expect(run.forkReturn).toBe(-EAGAIN);
    expect(drove, "sealed, then abort-replayed").toEqual([
      "unwind_begin",
      "unwind_end",
      "abort_begin",
      "abort_end",
    ]);
    expect(run.diagnostics).toContainEqual({
      kind: DIAGNOSTIC_ABORTED,
      values: [EAGAIN, ABORT_CAUSE_LAUNCH, 0, 0, 0],
    });
    expect(runFork(f).forkReturn, "and the parent forks again").toBe(DEFAULT_CHILD_PID);
  });

  it("does not abort on a frame reserve that fails outside a capture", () => {
    // The abort is for a capture the guest is unwinding. Anywhere else a
    // failed reserve is only a failed call, and beginning an abort there would
    // replay a capture that does not exist: the next fork would then find the
    // module mid-abort.
    const f = fixture();
    expect(failReserve(f)).toBe(0);
    expect(f.errno()).toBe(EINVAL);
    expect(runFork(f).forkReturn, "a fork afterwards runs normally").toBe(DEFAULT_CHILD_PID);
  });

  // WHAT USED TO BE HERE: "refuses a child install from an arena root that is
  // not one", which called a backend `attachChild` that no longer existed, so
  // it passed on the TypeError. The refusal it meant to pin is
  // `fork-module-child-install.test.ts`'s "refuses a launch root whose prefix
  // names no arena, or not a page", against `fm_child_install`.

  it("drives nothing when the module built an empty plan", () => {
    // driveRestoredPlan reads the step count from the MODULE rather than
    // taking it from the caller, so the two cannot disagree about how much of
    // the plan to run. With no plan built, the count is 0 and the drive is a
    // no-op -- not a call_indirect through an unbound slot.
    const f = fixture();
    const backend = new ForkModuleContinuationBackend({
      instance: f.instance,
      memory: f.memory,
      ptrWidth: 4,
      channelBase: CHANNEL_BASE,
      label: "empty plan",
    });
    expect(() => backend.driveRestoredPlan(0)).not.toThrow();
  });

  it("returns the module to idle when a host abandons a fork mid-capture", () => {
    // The teardown path for a fork a host exception interrupted (an exec
    // retirement, a guest trap): the exception passes out of `fm_run`, and
    // the host's trap guard calls `fm_abort`. It must not leave the module
    // mid-phase, because every later fork would then trap on the phase it
    // found and the worker would be wedged rather than broken.
    const f = fixture();
    expect(() =>
      runFork(f, {
        duringCapture: () => {
          throw new Error("a host import threw with the capture open");
        },
      }),
    ).toThrow("a host import threw with the capture open");
    (f.x.fm_abort as () => void)();
    expect(f.errno()).toBe(0);
    expect(runFork(f).forkReturn, "the next fork runs from idle").toBe(DEFAULT_CHILD_PID);
  });

  // WHAT USED TO BE HERE: "refuses a lifecycle call from the wrong phase
  // rather than proceeding", which called the backend's step methods out of
  // order. No host calls a step now; a wrong-phase ARRIVAL at the run loop
  // (an unwind with no capture open, a replay that returns early, `fork()`
  // reached mid-capture or in the other mode) is refused by `fm_run` itself,
  // and `fork-module-phase.test.ts` pins each refusal.
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
    admitActivation(f, 0);
    let bindings = -1;
    const run = runFork(f, {
      duringCapture: ({ root }) => {
        bindings = arenaRecords(f.memory, root).filter(
          (r) => r.kind === RECORD_KIND_IMPORTED_GLOBAL_BINDINGS,
        ).length;
      },
    });
    expect(run.forkReturn, "a fork with no imported globals").toBe(DEFAULT_CHILD_PID);
    expect(bindings).toBe(0);
  });

  it("refuses to bind provenance with no matching declaration", () => {
    // The host published provenance for an import the activation's KFIG section
    // does not declare. That is the two halves of the contract disagreeing, and
    // binding it anyway would wire a child's import from a coordinate nothing
    // describes.
    const f = fixture();
    admitActivation(f, 0);
    admitActivation(f, 0, { importedGlobals: emptyKfig() });
    expect(f.errno(), "empty section admitted").toBe(0);
    // Provenance for owner 1, which the empty section does not declare.
    publishInto(f.x, f.memory, 0, [
      importRow(0 /* globals */, 1, 4 /* ACTIVATION_GLOBAL */, 0 /* in no catalog */, 0n),
    ]);
    expect(f.errno(), "provenance published").toBe(0);

    // The capture refuses to open: `fork()` fails with the refusal's errno
    // before anything unwinds, and no child is asked for.
    const run = runFork(f);
    expect(run.forkReturn, "the capture must refuse rather than bind blind").toBeLessThan(0);
    expect(run.forkCalls).toBe(0);
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
/** The KFMS record kind a `Module` declaration uses. */
const RECORD_KIND_MODULE = 1;
const RECORD_KIND_ACTIVATION_CONTINUATIONS = 10;
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
describe("the binding records the module assembles at capture", () => {
  /**
   * Stand in for the guest's module-state save: write the one `MutableGlobal`
   * snapshot a global binding needs, through the module's own record-reserve
   * export -- the same one a real guest's save walk calls.
   */
  /** Write one `MutableGlobal` snapshot, as a guest's save walk would. */
  function saveOneGlobal(f: Fixture, activation: number, owner: number): void {
    const reserve = f.x.__wpk_fork_module_state_record_reserve as (
      kind: number,
      activation: number,
      owner: number,
      size: number,
    ) => number;
    const commit = f.x.__wpk_fork_module_state_record_commit as (p: number) => void;
    const payload = reserve(RECORD_KIND_MUTABLE_GLOBAL, activation, owner, 12);
    if (payload === 0) throw new Error("snapshot reserve failed");
    const view = new DataView(f.memory.buffer);
    view.setUint8(payload, GLOBAL_TYPE_I32);
    view.setUint8(payload + 1, 4);
    view.setUint16(payload + 2, 0, true);
    view.setUint32(payload + 4, 0, true);
    view.setUint32(payload + 8, 0x2a, true);
    commit(payload);
  }

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
    const base = driveBase(0);
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

  /**
   * Admit activation 0 again with one imported global (KFIG) and one imported
   * table (KFIT): the same template and catalog `fixture()` admitted, plus two
   * sections, which admission accepts.
   */
  function seedSections(f: Fixture): void {
    admitActivation(f, 0, {
      importedGlobals: kfigOne(1, 0, GLOBAL_TYPE_I32),
      importedTables: kfitOne(1, 1),
    });
    expect(f.errno(), "KFIG and KFIT admitted").toBe(0);
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
    // One row per call through `fm_publish_bindings`, so each assertion below
    // still reads the errno of the one fact it published.
    return {
      identity: (space, activation, owner, group) =>
        void publishInto(f.x, f.memory, activation, [exportRow(space, owner, group)]),
      provenance: (space, activation, ordinal, kind, group, bits) =>
        void publishInto(f.x, f.memory, activation, [importRow(space, ordinal, kind, group, bits)]),
    };
  }

  it("survives what a COW child inherits: seeds re-seed, the phase resets", () => {
    // A COW fork child's memory is a CLONE of its parent's, and this module's
    // statics live in that memory at `__memory_base` (the PIC placement). BSS is
    // not re-zeroed when the child instantiates its own fork-module, so the
    // child reads the PARENT's values out of three places at once:
    //
    //   - the KFIG/KFIT seed table, so its own seeding looked like a re-seed;
    //   - the activation template-id table, the same way;
    //   - `PHASE`, cloned MID-CAPTURE, so every child-install entry answered
    //     EBUSY.
    //
    // All three were `errno 22` or `errno 16` on real programs. This drives the
    // inherited shape directly rather than through a fork's memory copy: a
    // fork a host exception left mid-capture stands in for the clone's
    // parent, and the scrub is the child's first call. Census D9 C2.
    const f = fixture();
    admitActivation(f, 0);
    expect(f.errno(), "the first template-id seed").toBe(0);
    admitActivation(f, 0);
    expect(f.errno(), "and an IDENTICAL re-seed is a no-op").toBe(0);
    // A different id under the same activation is two modules claiming one
    // coordinate, and stays loud.
    admitActivation(f, 0, { template: 0xab });
    expect(f.errno(), "a CONFLICTING template id is refused").toBe(22);

    seedSections(f);
    seedSections(f);
    expect(f.errno(), "identical KFIG/KFIT bytes re-admit as a no-op").toBe(0);
    admitActivation(f, 0, {
      importedGlobals: kfigOne(2, 0, GLOBAL_TYPE_I32),
      importedTables: kfitOne(1, 1),
    });
    expect(f.errno(), "CONFLICTING KFIG bytes are refused").toBe(22);

    // And the phase: leave a fork mid-capture, then do what a fresh worker
    // does. A module still in capture would trap the next `fork()` on the
    // phase it found (`fork-module-phase.test.ts`), so a fork that completes
    // is the proof the scrub left no fork in flight.
    expect(() =>
      runFork(f, {
        duringCapture: () => {
          throw new Error("left mid-capture");
        },
      }),
    ).toThrow("left mid-capture");
    (f.x.fm_set_format as (...a: number[]) => void)(4, 0, 0, CHANNEL_BASE);
    expect(f.errno(), "the format seed is accepted").toBe(0);
    // The scrub forgets every admission, as a fresh worker has made none.
    admitActivation(f, 0);
    expect(
      runFork(f).forkReturn,
      "a worker that has just seeded its format has no fork in flight",
    ).toBe(DEFAULT_CHILD_PID);
  });

  it("elects the activation that OWNS a shared global, not one that imports it", () => {
    // Activation 0 imports the global and, like every instrumented activation,
    // exports a catalog entry for it. Activation 9 declares it. Identity alone
    // cannot tell them apart -- both name the same object -- and the host is not
    // allowed to say which provides it, so this is the module's answer.
    const f = fixture();
    admitActivation(f, 0);
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

    let records: ArenaRecord[] = [];
    runFork(f, {
      duringCapture: ({ root }) => {
        records = arenaRecords(f.memory, root);
      },
    });
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

  it("carries a whole capture through to a sealed arena the child can read", () => {
    // The cycle the production path takes, with records in it: begin, seal,
    // parent-replay, finish. Until the module owned the arena, the seal wrote
    // no journal image and the capture wrote no bindings -- both were skipped
    // on the ownership guard, silently, and the tests below could not see it
    // because they stop at begin.
    const f = fixture();
    admitActivation(f, 0);
    seedSections(f);
    const { identity, provenance } = publish(f);
    identity(SPACE_GLOBAL, 0, 1, 7);
    identity(SPACE_GLOBAL, 9, 5, 7);
    provenance(SPACE_GLOBAL, 0, 0, KIND_ACTIVATION_GLOBAL, 7, 0n);
    saveWrites(f, 0, 1);

    // Everything a child reads out of the inherited arena, in one place: the
    // activation set, the snapshot the guest saved, the bindings the module
    // elected, and the journal image the seal serialized -- read after the
    // seal, while the parent replays.
    let kinds: number[] = [];
    const run = runFork(f, {
      duringReplay: ({ root }) => {
        kinds = arenaRecords(f.memory, root).map((r) => r.kind);
      },
    });
    expect(kinds).toContain(RECORD_KIND_MUTABLE_GLOBAL);
    expect(kinds).toContain(RECORD_KIND_IMPORTED_GLOBAL_BINDINGS);
    expect(kinds, "the seal's journal image").toContain(RECORD_KIND_JOURNAL_IMAGE);
    expect(run.forkReturn, "and the fork completes").toBe(DEFAULT_CHILD_PID);
  });

  /**
   * A SECOND fork-module over the same memory: the child's side of a fork.
   *
   * Production's shape, not a trick. A fork child is a fresh worker with its own
   * module instance over the same `SharedArrayBuffer`, attaching an arena the
   * parent mapped. One module cannot stand in for both: attach demands the idle
   * phase, and a finish releases the arena.
   */

  it("hands a child an arena it can actually attach", () => {
    // The whole point of a sealed arena, and the first test in this lane to
    // prove it: a second module instance -- a child worker -- decodes what the
    // parent sealed and builds its install plan from it. Until the seal wrote
    // the reference transaction, this failed on the first record it looked for.
    const f = fixture();
    admitActivation(f, 0);
    seedSections(f);
    const { identity, provenance } = publish(f);
    identity(SPACE_GLOBAL, 0, 1, 7);
    identity(SPACE_GLOBAL, 9, 5, 7);
    provenance(SPACE_GLOBAL, 0, 0, KIND_ACTIVATION_GLOBAL, 7, 0n);
    saveWrites(f, 0, 1);
    const child = installableChild(f);
    // Installed while the parent is still in its fork -- after the seal, as
    // the kernel creates the child -- and then run to the child's own `fork()`.
    let installed = -1;
    let childReturn = -1;
    runFork(f, {
      duringReplay: ({ anchor }) => {
        installed = child.install(anchor);
        childReturn = child.run();
      },
    });
    expect(installed, "the child installs").toBe(0);
    expect(
      child.driven.map(([slot]) => slot),
      "drives the install plan it built, then finishes its replay",
    ).toEqual([
      DRIVE_SLOT_RESTORE,
      DRIVE_SLOT_FINISH_RESTORE,
      DRIVE_SLOT_REWIND_BEGIN,
      DRIVE_SLOT_REWIND_END,
    ]);
    expect(childReturn, "and the child's fork() returns 0").toBe(0);
  });

  /** `CHILD_PLAN_RESOLVE_*`, in `crates/fork-codec/src/child_plan.rs`. */
  const RESOLVE_PROVIDER_GLOBAL = 6;
  const RESOLVE_PROVIDER_TABLE = 7;
  const RESOLVE_SAVED_BASE_SCALAR = 8;

  /** `fm_child_plan` over `root`, read the way the host reads it. */
  function readPlan(f: Fixture, root: number): ForkChildPlan {
    return new ForkModuleContinuationBackend({
      instance: f.instance,
      memory: f.memory,
      ptrWidth: 4,
      channelBase: CHANNEL_BASE,
      label: "child plan",
    }).childPlan(root);
  }

  /** `DRIVE_SLOT_MODULE_TABLE_STATE_SAVE`. */
  const DRIVE_SLOT_TABLE_STATE_SAVE = 14;

  it("captures a peer-table checkpoint into a fresh module-owned arena", () => {
    // A PEER-TABLE checkpoint is not a fork: no frames, no unwind, no journal.
    // What it must produce is an arena that names this worker's activations and
    // carries the table records the guest's table-save walk wrote, sealed with
    // the reference segments a peer needs to rebuild the funcref slots.
    const f = fixture();
    admitActivation(f, 0);
    const saved: number[] = [];
    const reserve = f.x.__wpk_fork_module_state_record_reserve as (
      kind: number,
      activation: number,
      owner: number,
      size: number,
    ) => number;
    const commit = f.x.__wpk_fork_module_state_record_commit as (p: number) => void;
    const base = driveBase(0);
    // The fixture's drive table is sized for the slots its own harness binds;
    // this slot is past them, so grow to the full per-activation stride the way
    // `bindActivationDrive` does.
    const needed = base + FORK_ACTIVATION_DRIVE_SLOTS;
    if (f.instance.driveTable.length < needed) {
      f.instance.driveTable.grow(needed - f.instance.driveTable.length);
    }
    f.instance.driveTable.set(
      base + DRIVE_SLOT_TABLE_STATE_SAVE,
      saveSlotThunk((activation) => {
        saved.push(activation);
        const payload = reserve(RECORD_KIND_MUTABLE_GLOBAL, activation, 1, 12);
        if (payload === 0) throw new Error("table snapshot reserve failed");
        const view = new DataView(f.memory.buffer);
        view.setUint8(payload, GLOBAL_TYPE_I32);
        view.setUint8(payload + 1, 4);
        view.setUint16(payload + 2, 0, true);
        view.setUint32(payload + 4, 0, true);
        view.setUint32(payload + 8, 0x5a, true);
        commit(payload);
      }) as never,
    );

    const root = (f.x.fm_capture_peer_tables as (c: number) => number)(CHANNEL_BASE);
    expect(f.errno(), "the checkpoint captures").toBe(0);
    expect(root, "into an arena of its own").toBeGreaterThan(0);
    expect(saved, "and drove the guest's TABLE save, by activation").toEqual([0]);

    const records = arenaRecords(f.memory, root);
    expect(
      records.some((r) => r.kind === RECORD_KIND_MODULE),
      "the arena declares the activation set",
    ).toBe(true);
    expect(
      records.some((r) => r.kind === RECORD_KIND_MUTABLE_GLOBAL),
      "and carries what the save walk wrote",
    ).toBe(true);
  });

  it("refuses a peer-table checkpoint it cannot make honestly", () => {
    // Three refusals, each naming a different missing precondition. A
    // checkpoint that silently published an empty arena would leave every peer
    // replicating nothing, which looks exactly like a worker with no tables.
    const f = fixture();
    expect(
      (f.x.fm_capture_peer_tables as (c: number) => number)(CHANNEL_BASE),
      "no activation has been seeded",
    ).toBe(0);
    expect(f.errno()).toBe(22);

    admitActivation(f, 0);
    expect(
      (f.x.fm_capture_peer_tables as (c: number) => number)(0),
      "no syscall channel to allocate through",
    ).toBe(0);
    expect(f.errno()).toBe(22);
    expect(
      (f.x.fm_capture_peer_tables as (c: number) => number)(CHANNEL_BASE + 1),
      "an unaligned channel",
    ).toBe(0);
    expect(f.errno()).toBe(22);
  });

  it("refuses a peer-table checkpoint in the middle of a fork", () => {
    // It opens a capture graph of its own; doing that mid-fork would discard
    // the fork's, and the fork would seal an arena with no references in it.
    const f = fixture();
    admitActivation(f, 0);
    seedSections(f);
    const { provenance } = publish(f);
    provenance(SPACE_GLOBAL, 0, 0, KIND_ACTIVATION_GLOBAL, 0, 0n);
    provenance(SPACE_TABLE, 0, 1, KIND_ACTIVATION_TABLE, 0, 0n);
    saveWrites(f, 0, 1);
    let checkpoint = -1;
    let errno = -1;
    const run = runFork(f, {
      duringCapture: () => {
        checkpoint = (f.x.fm_capture_peer_tables as (c: number) => number)(CHANNEL_BASE);
        errno = f.errno();
      },
    });
    expect(checkpoint, "a checkpoint with a fork open is refused").toBe(0);
    expect(errno, "as a phase error, not an argument one").toBe(EBUSY);
    expect(run.forkReturn, "and the fork itself is untouched").toBe(DEFAULT_CHILD_PID);
  });

  it("strides the drive table by the geometry every reader must agree on", () => {
    // Three readers compute a drive-table index: this module, the host's
    // `bindActivationDrive`, and the INJECTED thunks inside the module's own
    // wasm (`__wpk_fork_capture_encode` and friends compute
    // `activation * stride + slot` inline). The third disagreed -- it strode by
    // 13 while these two strode by 14 -- so for every activation above 0 it
    // aimed a `call_indirect` at another slot entirely: activation 1's GC
    // encode landed on 24, which is activation 1's `wpk_fork_unwind_begin`.
    //
    // This pins the number the other two use. It does NOT reach the injected
    // thunks: wabt 1.0.37 cannot disassemble this module (it rejects the GC and
    // exnref types), so there is no artifact test for them, and the real fix
    // was to delete the injector's duplicate constant rather than pin it.
    //
    // Read off the row `fm_bind_activation` answers, the only place the host
    // learns it -- and checked against `driveBase`, the fixture's spelling
    // every other test on this rig binds its drive slots by.
    const f = fixture();
    const base = (activation: number): number | undefined => {
      if (activation !== 0) admitActivation(f, activation, { template: sideTemplate(activation) });
      return bind(f.x, f.memory, activation, 0, 0)?.drive;
    };
    expect(base(0)).toBe(0);
    expect(base(1), "one stride up").toBe(FORK_ACTIVATION_DRIVE_SLOTS);
    expect(base(2), "and linear from there").toBe(2 * FORK_ACTIVATION_DRIVE_SLOTS);
    expect([0, 1, 2].map(driveBase), "the fixture's spelling agrees").toEqual([
      0,
      FORK_ACTIVATION_DRIVE_SLOTS,
      2 * FORK_ACTIVATION_DRIVE_SLOTS,
    ]);
  });

  it("plans a child's imports from the arena, ordered by import ordinal", () => {
    // The whole point of the entry: the host asks WHAT TO DO with each
    // import, not for the binding rows to reason about itself. The global is
    // provided by the activation the election chose; the table likewise; and
    // they come back in import-section order, which is the order the host
    // walks `WebAssembly.Module.imports()` in.
    const f = fixture();
    admitActivation(f, 0);
    seedSections(f);
    const { identity, provenance } = publish(f);
    identity(SPACE_GLOBAL, 0, 1, 7);
    identity(SPACE_GLOBAL, 9, 5, 7);
    identity(SPACE_TABLE, 0, 1, 99);
    identity(SPACE_TABLE, 9, 5, 99);
    provenance(SPACE_GLOBAL, 0, 0, KIND_ACTIVATION_GLOBAL, 7, 0n);
    provenance(SPACE_TABLE, 0, 1, KIND_ACTIVATION_TABLE, 99, 0n);
    saveWrites(f, 0, 1);
    // The provider must be one of the child's activations, or the plan names
    // an instance the child will never have.
    admitActivation(f, 9, { template: sideTemplate(9) });
    let plan0: ForkChildPlan | undefined;
    runFork(f, {
      duringCapture: ({ root }) => {
        plan0 = readPlan(f, root);
      },
    });

    const { order, rows } = plan0!;
    expect(order, "the provider is instantiated first").toEqual([9, 0]);
    const plan = rows.filter((row) => row.activation === 0);
    expect(plan.length, "one global and one table").toBe(2);
    expect(plan[0]!.ordinal).toBe(0);
    expect(plan[0]!.resolve, "the global comes first").toBe(RESOLVE_PROVIDER_GLOBAL);
    expect(plan[0]!.typeCode).toBe(GLOBAL_TYPE_I32);
    expect([plan[0]!.a, plan[0]!.b], "the elected owner").toEqual([9, 5]);
    expect(plan[0]!.dep).toBe(9);
    expect(plan[1]!.ordinal).toBe(1);
    expect(plan[1]!.resolve, "the table second").toBe(RESOLVE_PROVIDER_TABLE);
    expect(plan[1]!.a).toBe(9);
  });

  it("assembles binding records when a SIDE activation imports a global too", () => {
    // The dlopen shape: both activations declare an imported global and both
    // publish provenance for it. Nothing exercised this until the dlopen e2e
    // could run, and `write_imported_global_bindings` walks EVERY activation in
    // the fork -- so a side activation whose declarations or snapshots are
    // missing refuses the whole capture rather than its own record.
    const f = fixture();
    for (const activation of [0, 1]) {
      admitActivation(f, activation, {
        template: activation === 0 ? 0 : sideTemplate(activation),
        importedGlobals: kfigOne(1, 0, GLOBAL_TYPE_I32),
      });
      expect(f.errno(), `KFIG admitted for activation ${activation}`).toBe(0);
    }
    bindActivation(f.x, f.memory, 1);
    const { provenance } = publish(f);
    provenance(SPACE_GLOBAL, 0, 0, KIND_ACTIVATION_GLOBAL, 0, 0n);
    provenance(SPACE_GLOBAL, 1, 0, KIND_ACTIVATION_GLOBAL, 0, 0n);

    const driven: number[] = [];
    for (const activation of [0, 1]) {
      const base = driveBase(activation);
      const needed = base + FORK_ACTIVATION_DRIVE_SLOTS;
      if (f.instance.driveTable.length < needed) {
        f.instance.driveTable.grow(needed - f.instance.driveTable.length);
      }
      f.instance.driveTable.set(
        base + DRIVE_SLOT_MODULE_STATE_SAVE,
        saveSlotThunk((id) => {
          driven.push(id);
          saveOneGlobal(f, id, 1);
        }) as never,
      );
    }

    let bindings = -1;
    const run = runFork(f, {
      sides: [1],
      duringCapture: ({ root }) => {
        bindings = arenaRecords(f.memory, root).filter(
          (r) => r.kind === RECORD_KIND_IMPORTED_GLOBAL_BINDINGS,
        ).length;
      },
    });
    expect(run.forkReturn, "a two-activation fork with imports completes").toBe(
      DEFAULT_CHILD_PID,
    );
    expect(driven.sort(), "both saves ran").toEqual([0, 1]);
    expect(bindings, "one binding record for the whole fork").toBe(1);
  });

  it("hands back the saved scalar behind a base import, flagged", () => {
    // A group nothing owns elects BASE_IMPORT: the child must NOT override the
    // import, but the parent's saved contents are still authoritative. The flag
    // is what distinguishes a saved zero from nothing saved.
    const f = fixture();
    admitActivation(f, 0);
    seedSections(f);
    const { provenance } = publish(f);
    provenance(SPACE_GLOBAL, 0, 0, KIND_ACTIVATION_GLOBAL, 0, 0n);
    provenance(SPACE_TABLE, 0, 1, KIND_ACTIVATION_TABLE, 0, 0n);
    saveWrites(f, 0, 1);
    let plan: ForkChildPlan["rows"] = [];
    runFork(f, {
      duringCapture: ({ root }) => {
        plan = readPlan(f, root).rows;
      },
    });
    expect(plan[0]!.resolve, "nothing owns the group, and the snapshot travels").toBe(
      RESOLVE_SAVED_BASE_SCALAR,
    );
    expect([plan[0]!.a, plan[0]!.b], "the value the save walk wrote").toEqual([42, 0]);
  });

  it("plans nothing for an activation that declared no imports", () => {
    // The ordinary single-module case. An empty plan, not a refusal: the KFIG
    // section is emitted only when there is something to describe.
    const f = fixture();
    admitActivation(f, 0);
    seedSections(f);
    const { provenance } = publish(f);
    provenance(SPACE_GLOBAL, 0, 0, KIND_ACTIVATION_GLOBAL, 0, 0n);
    provenance(SPACE_TABLE, 0, 1, KIND_ACTIVATION_TABLE, 0, 0n);
    saveWrites(f, 0, 1);
    admitActivation(f, 4, { template: sideTemplate(4) });
    let plan: ForkChildPlan | undefined;
    runFork(f, {
      duringCapture: ({ root }) => {
        plan = readPlan(f, root);
      },
    });
    expect(
      plan!.rows.filter((row) => row.activation === 4),
      "activation 4 seeded no sections",
    ).toEqual([]);
    expect(plan!.order, "and is still one of the child's activations").toEqual([0, 4]);
  });

  it("refuses to plan from something that is not an arena", () => {
    const f = fixture();
    // Zeroed, in bounds, and never mapped by the responder.
    expect((f.x.fm_child_plan as (r: number) => number)(1024 * 1024)).toBe(0);
    expect(f.errno()).not.toBe(0);
  });

  it("refuses to plan from an arena whose binding record is corrupt", () => {
    const f = fixture();
    admitActivation(f, 0);
    seedSections(f);
    const { provenance } = publish(f);
    provenance(SPACE_GLOBAL, 0, 0, KIND_ACTIVATION_GLOBAL, 0, 0n);
    provenance(SPACE_TABLE, 0, 1, KIND_ACTIVATION_TABLE, 0, 0n);
    saveWrites(f, 0, 1);
    let intact = -1;
    let corrupt = -1;
    let errno = -1;
    let found = false;
    runFork(f, {
      duringCapture: ({ root }) => {
        intact = (f.x.fm_child_plan as (r: number) => number)(root);
        const bindings = arenaRecords(f.memory, root).find(
          (r) => r.kind === RECORD_KIND_IMPORTED_GLOBAL_BINDINGS,
        );
        found = bindings !== undefined;
        const kind = bindings!.payload.getUint8(24 + 32);
        bindings!.payload.setUint8(24 + 32, 99); // a kind no child could materialise
        corrupt = (f.x.fm_child_plan as (r: number) => number)(root);
        errno = f.errno();
        bindings!.payload.setUint8(24 + 32, kind); // the fork itself must seal
      },
    });
    expect(intact, "the intact arena plans").toBeGreaterThan(0);
    expect(found, "a KFBG record to corrupt").toBe(true);
    expect(corrupt, "the corrupt record is refused").toBe(0);
    expect(errno).toBe(22);
  });

  it("refuses a child install whose inherited binding record is corrupt", () => {
    // The same arena as "hands a child an arena it can actually attach", one
    // byte apart. The intact case installs; flipping a binding's kind to one
    // no child could materialise is refused, before the reference graph is
    // even decoded. Without that check the corrupt record would be read much
    // later, by the host building the child's imports, and by then it is a
    // wrong child rather than a refused fork.
    const f = fixture();
    admitActivation(f, 0);
    seedSections(f);
    const { identity, provenance } = publish(f);
    identity(SPACE_GLOBAL, 0, 1, 7);
    identity(SPACE_GLOBAL, 9, 5, 7);
    provenance(SPACE_GLOBAL, 0, 0, KIND_ACTIVATION_GLOBAL, 7, 0n);
    saveWrites(f, 0, 1);
    const child = installableChild(f);
    let installed = -1;
    let found = false;
    runFork(f, {
      duringReplay: ({ root, anchor }) => {
        const bindings = arenaRecords(f.memory, root).find(
          (r) => r.kind === RECORD_KIND_IMPORTED_GLOBAL_BINDINGS,
        );
        found = bindings !== undefined;
        bindings!.payload.setUint8(24 + 32, 99);
        installed = child.install(anchor);
      },
    });
    expect(found, "a KFBG record to corrupt").toBe(true);
    expect(installed, "the corrupt record is refused").toBe(22);
    expect(child.driven, "and nothing is driven").toEqual([]);
  });

  // WHAT USED TO BE HERE: "puts a restore AND a finish-restore in the child's
  // install plan", which counted the steps `fm_attach_child` built. The plan is
  // driven inside `fm_child_install` now, so the order it drives is what is
  // pinned: "hands a child an arena it can actually attach" above, and every
  // install case in `fork-module-child-install.test.ts`.

  it("installs a two-activation child only once it has admitted both", () => {
    // NEVER ADMITTED IS REFUSED. A child with no resume catalog seeded is a
    // build whose instrumentation step did not run, and numbering slots by a
    // rule the guest's resume table does not share is the divergence the
    // seeded catalog exists to rule out. `EINVAL` (22), from the phase the
    // install never left -- a failed install enters no phase, so the retry
    // below is clean.
    //
    // The child names no side activation at all: it seeds the ones it bound,
    // and resolves each one's root -- a per-fork address no host can know --
    // from the KFAC manifest the parent wrote at seal.
    const f = fixture();
    admitActivation(f, 0);
    // The child's install runs while the parent is in its fork, after the
    // seal, as the kernel creates it.
    let checked = false;
    runFork(f, {
      sides: [1],
      duringReplay: ({ anchor }) => {
        installTwoActivationChild(f, anchor);
        checked = true;
      },
    });
    expect(checked, "the child's install ran inside the parent's fork").toBe(true);
  });

  /** The child's half of the two-activation install above. */
  function installTwoActivationChild(f: Fixture, act0Root: number): void {
    const instance = childInstance(f);
    const child = instance.exports as Record<string, unknown>;
    new Uint8Array(f.memory.buffer, CHILD_CONTROL, 64).fill(0);
    (child.fm_set_format as (...a: number[]) => void)(4, 0, CHILD_CONTROL, CHANNEL_BASE);
    const driven: Array<readonly [number, number]> = [];
    for (const activation of [0, 1]) {
      const base = driveBase(activation);
      const needed = base + FORK_ACTIVATION_DRIVE_SLOTS;
      if (instance.driveTable.length < needed) {
        instance.driveTable.grow(needed - instance.driveTable.length);
      }
      for (const slot of [
        DRIVE_SLOT_RESTORE,
        DRIVE_SLOT_FINISH_RESTORE,
        DRIVE_SLOT_REWIND_BEGIN,
      ]) {
        instance.driveTable.set(
          base + slot,
          saveSlotThunk((arg) => driven.push([slot, arg])) as never,
        );
      }
    }
    const install = () =>
      (child.fm_child_install as (...a: number[]) => number)(1, act0Root, 0, 0);

    // Activation 0 only, never admitted: refused at the seed.
    expect(install(), "a child whose catalogs were never seeded is refused").toBe(22);
    expect(driven, "and nothing was driven").toEqual([]);
    // AN EMPTY CATALOG IS NOT THAT CASE. This capture committed no frame, so
    // both activations hold zero resume targets -- which is what
    // `libneeded-provider.so` admits in `fork-from-dlopen-side-module-e2e`,
    // and mistaking it for "never registered" already cost a real fork. An
    // empty RECORD says "registered, holding nothing"; NO record says "never
    // registered". Admitted the way every host admits: activation 0 through
    // the same entry as its side, with the facts the parent admitted.
    for (const activation of [0, 1]) {
      expect(
        admitInto(child, f.memory, activation, {
          template: activation === 0 ? 0 : sideTemplate(activation),
        }),
        `an empty catalog is a legitimate admission for activation ${activation}`,
      ).toBe(0);
    }
    // And the side BOUND, as the child's dlopen replay registers it: the seed
    // walks the side activations the module has bound.
    expect(bindActivation(child, f.memory, 1), "binding the child's side").not.toBeNull();
    // No phase was entered by the refusal: the retry installs.
    expect(install(), "the install resolves the side root from the manifest").toBe(0);

    // The install plan must END in a REWIND BEGIN per activation, carrying that
    // activation's continuation root. Without those steps the child's guest is
    // never told to rewind: `wpk_fork_resume_start` finds no rewind in progress
    // and runs `_start` LEXICALLY, so the program begins again from `main`
    // instead of resuming after `fork()`. No trap, no errno -- the child just
    // runs the whole program a second time. Census 185.
    const tail = driven.slice(-2);
    expect(
      tail.map(([slot]) => slot),
      "the last two steps are the two activations' rewind begins",
    ).toEqual([DRIVE_SLOT_REWIND_BEGIN, DRIVE_SLOT_REWIND_BEGIN]);
    expect(
      tail[0]![1],
      "activation 0 rewinds from the anchor the capture returned",
    ).toBe(act0Root);
    expect(
      new Set(tail.map(([, root]) => root)).size,
      "and each activation rewinds from a root of its own",
    ).toBe(2);
  }

  it("drives one rewind begin per activation, or refuses the replay", () => {
    // The parent's replay is the mirror of the child's install: both end by
    // telling each guest to rewind, and both fail SILENTLY if they do not. An
    // activation never told to rewind leaves `wpk_fork_resume_start` with no
    // rewind in progress, so it runs `_start` lexically and the process runs
    // its whole program again -- no trap, no errno, and the first visible sign
    // is something far away (here, `dlopen` called a second time while the fork
    // still held the loader's archive reader). Census 186.
    const f = fixture();
    admitActivation(f, 0);
    // Each activation's rewind begin, recorded with the root it was given.
    const rewound: Array<readonly [number, number]> = [];
    for (const activation of [0, 1]) {
      const base = driveBase(activation);
      const needed = base + FORK_ACTIVATION_DRIVE_SLOTS;
      if (f.instance.driveTable.length < needed) {
        f.instance.driveTable.grow(needed - f.instance.driveTable.length);
      }
      f.instance.driveTable.set(
        base + DRIVE_SLOT_REWIND_BEGIN,
        saveSlotThunk((root) => rewound.push([activation, root])) as never,
      );
    }
    let rewoundAtReplay: Array<readonly [number, number]> = [];
    const run = runFork(f, {
      sides: [1],
      duringReplay: () => {
        rewoundAtReplay = [...rewound];
      },
    });
    expect(run.forkReturn, "the parent's two-activation replay completes").toBe(
      DEFAULT_CHILD_PID,
    );
    expect(
      rewoundAtReplay.map(([activation]) => activation),
      "one rewind begin for each of the two activations, before the guest resumes",
    ).toEqual([0, 1]);
    expect(rewoundAtReplay[0]![1], "activation 0 rewinds from its own anchor").toBe(run.anchor);
  });

  it("captures an aggregate graph the child decodes back with the same shape", () => {
    // The fixture's aggregate half, proven before any replay test is built on
    // it. A struct is CLAIMED, its edge vector interned, then COMPLETED -- and
    // getting that order wrong produces a graph the module accepts and a child
    // rebuilds wrong, which is exactly the class of bug a test that constructs
    // its own arena in TypeScript cannot find.
    const f = fixture();
    const scalars = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const { root, recipes, aggregateRecipes } = captureGraph(
      f,
      [
        [INTERN_KIND_I31, 77, 0],
        [INTERN_KIND_I31, 42, 0],
      ],
      [
        {
          kind: CAPTURE_KIND_STRUCT,
          activation: 0,
          typeOrdinal: 13,
          scalars,
          // Edges naming the two leaves above, so the child walks a real graph
          // rather than an isolated node. The ids are not knowable in advance:
          // the module assigns them during this same capture.
          edges: ({ leaves }) => leaves,
        },
      ],
    );
    expect(aggregateRecipes).toHaveLength(1);
    expect(recipes).toHaveLength(2);
    expect(root, "and the graph seals").toBeGreaterThan(0);

    // The CHILD-side readout of node count and coordinates went with
    // `fm_decoded_node_field` (lane F stage 1G). The round trip it proved
    // is `fork_codec`'s `round_trips_every_node_kind_and_shared_vector`.
  });

  it("captures a struct-to-array CYCLE, which needs every claim before any edge", () => {
    // Two aggregates that point at each other. This is the shape the whole
    // typed drive order exists for -- a topological walk has to break the cycle
    // somewhere -- and it is only EXPRESSIBLE if both recipe ids exist before
    // either edge vector is built. Claiming in its own pass is what buys that;
    // a fixture that claimed and defined one aggregate at a time could not
    // write this graph at all, and so could not test the drive that handles it.
    const f = fixture();
    const { root, aggregateRecipes } = captureGraph(
      f,
      [[INTERN_KIND_I31, 91, 0]],
      [
        {
          kind: CAPTURE_KIND_STRUCT,
          activation: 0,
          typeOrdinal: 4,
          scalars: new Uint8Array([9, 9, 9, 9]),
          // -> the array, and the shared i31 leaf.
          edges: ({ leaves, aggregates }) => [aggregates[1]!, leaves[0]!],
        },
        {
          kind: CAPTURE_KIND_ARRAY,
          activation: 0,
          typeOrdinal: 5,
          scalars: new Uint8Array([7, 7, 7, 7]),
          // -> back to the struct, closing the cycle, and the same leaf.
          edges: ({ leaves, aggregates }) => [aggregates[0]!, leaves[0]!],
        },
      ],
    );
    expect(aggregateRecipes).toHaveLength(2);
    expect(root, "and the cyclic graph seals").toBeGreaterThan(0);
  });

  it("refuses a vector whose appends do not match what was promised", () => {
    // The guest declares an edge count at `begin` and then appends. If it
    // appends FEWER, the module must fail loud at `finish` rather than intern a
    // short vector -- a child would then reconstruct an aggregate with missing
    // references, which is a wrong object rather than an error. `append`
    // returns nothing (that is the guest ABI), so `finish` is the only place
    // this can surface.
    const f = fixture();
    admitActivation(f, 0);
    const errnos: number[] = [];
    let ordinal = 0;
    const run = runFork(f, {
      duringCapture: () => {
        // A leaf through the guest-facing i31 capture entry, as the generated
        // codec interns one.
        const leaf = (f.x.__wpk_fork_ref_gc_i31 as (payload: number) => number)(5);
        errnos.push(f.errno());
        const handle = (f.x.__wpk_fork_ref_vector_begin as (n: number) => number)(2);
        errnos.push(f.errno());
        (f.x.__wpk_fork_ref_vector_append as (h: number, r: number) => void)(handle, leaf);
        errnos.push(f.errno());
        ordinal = (f.x.__wpk_fork_ref_vector_finish as (h: number) => number)(handle);
        errnos.push(f.errno());
      },
    });
    expect(errnos, "a leaf, two edges promised, one appended, and the short vector refused")
      .toEqual([0, 0, 0, 22]);
    expect(ordinal, "with no ordinal handed back").toBe(-1);
    // The refused vector leaves the graph incomplete, so the capture cannot
    // seal: the module abort-replays and `fork()` returns the refusal.
    expect(run.forkReturn).toBe(-EINVAL);
  });

  // WHAT USED TO BE HERE: "refuses a borrowed child seed with no admitted
  // workspace", through `fm_set_borrowed_workspace`, an entry that left the
  // module with its last host caller (lane F stage 4b). The same refusals are
  // proven through the production install in `fork-module-child-install.test.ts`
  // ("refuses half a borrowed workspace"), against an install that otherwise
  // succeeds ("installs a BORROWED child of a pthread").

  it("refuses a child install from a phase that is not an install", () => {
    // An install while THIS worker is capturing its own fork would seed a
    // replay driver over a live capture. (`fork-module-child-install.test.ts`
    // pins the refusal from child replay, a second install.)
    const f = fixture();
    admitActivation(f, 0);
    let installed = -1;
    const run = runFork(f, {
      duringCapture: ({ anchor }) => {
        installed = (f.x.fm_child_install as (...a: number[]) => number)(1, anchor, 0, 0);
      },
    });
    expect(installed, "an install mid-capture is refused").toBe(EBUSY);
    expect(run.forkReturn, "and the capture is untouched: the fork completes").toBe(
      DEFAULT_CHILD_PID,
    );
  });

  it("falls back to a base import when no activation provides the object", () => {
    // Same fork with the owner's catalog entry removed: every member of the
    // group imports the global, so nobody can hand it to a child and it comes
    // from the child's own base imports instead. The host never says this.
    const f = fixture();
    admitActivation(f, 0);
    seedSections(f);
    const { identity, provenance } = publish(f);
    identity(SPACE_GLOBAL, 0, 1, 7);
    provenance(SPACE_GLOBAL, 0, 0, KIND_ACTIVATION_GLOBAL, 7, 0n);
    saveWrites(f, 0, 1);

    let globals: ArenaRecord | undefined;
    runFork(f, {
      duringCapture: ({ root }) => {
        globals = arenaRecords(f.memory, root).find(
          (r) => r.kind === RECORD_KIND_IMPORTED_GLOBAL_BINDINGS,
        );
      },
    });
    const g = globals!.payload;
    expect(g.getUint8(56), "kind").toBe(KIND_BASE_IMPORT);
    expect([g.getUint32(32, true), g.getUint32(36, true)]).toEqual([0, 0]);
  });

  it("a seal that fails after the frames sealed still leaves the parent able to abort-replay", () => {
    // THE FORK THAT FAILS AT THE SEAL. The seal drives the
    // guest's unwind-end and seals every frame writer BEFORE it validates the
    // reference graph, so a graph fault fails the seal with the parent's frames
    // already committed and replayable. The host's answer to a failed seal is
    // to abort-replay those frames, so `fork()` returns `-errno` and the parent
    // survives -- which is only possible if the phase says sealed-parent.
    //
    // It did not. The phase advance was on the success arm alone, so the abort
    // answered EBUSY and the worker died with 16 instead of the fork's own
    // errno (census section 188, where this cost an afternoon of tracing).
    const f = fixture();
    const drove = recordLifecycle(f);
    const run = runFork(f, {
      duringCapture: () => {
        // A reference vector opened and never finished: the graph validator's
        // "a reference vector was never finished" refusal, which is the exact
        // fault a guest whose reference encode returned -1 produces.
        (f.x.__wpk_fork_ref_vector_begin as (n: number) => number)(1);
        expect(f.errno(), "the vector opens").toBe(0);
      },
    });
    // The module began the abort replay itself, which it can only do from
    // sealed-parent: the frames sealed (unwind-end ran), no child was asked
    // for, the abort replay ran, and `fork()` returns the seal's own errno.
    expect(drove).toEqual(["unwind_begin", "unwind_end", "abort_begin", "abort_end"]);
    expect(run.forkCalls, "no child for a fork whose seal failed").toBe(0);
    expect(run.forkReturn, "fork() returns the seal's -errno").toBe(-EINVAL);
    expect(run.diagnostics).toContainEqual({
      kind: DIAGNOSTIC_ABORTED,
      values: [EINVAL, ABORT_CAUSE_SEAL, 0, 0, 0],
    });
  });
});

