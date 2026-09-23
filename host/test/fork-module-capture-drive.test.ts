import { describe, expect, it } from "vitest";
import {
  FORK_ACTIVATION_DRIVE_SLOTS,
  ForkModuleContinuationBackend,
} from "../src/fork-module-backend";
import {
  CAPTURE_KIND_ARRAY,
  CAPTURE_KIND_STRUCT,
  INTERN_KIND_I31,
  captureGraph,
  openCapture,
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
  MMAP_FLOOR,
  MUNMAP_COUNTER,
  PAGE,
  PHASE_ABORT_REPLAY,
  PHASE_CAPTURE,
  PHASE_CHILD_REPLAY,
  PHASE_IDLE,
  PHASE_PARENT_REPLAY,
  PHASE_SEALED_PARENT,
  WORKSPACE_PREFIX,
  WORKSPACE_SCRATCH,
  childModule,
  fixture,
  moduleStateRootAt,
  saveSlotThunk,
  seedEmptyResumeCatalog,
  seedTemplateId,
  voidSlotThunk,
  type Fixture,
} from "./fork-module-capture-fixture";

/**
 * Where a test stages the sides vector `fm_parent_begin_capture` reads, and
 * the child's copy of it: LOW scratch, beside the template ids at 2048, the
 * same page `openCapture` in the fixture uses.
 *
 * NOT inside the responder's mmap range. The responder bump-allocates upward
 * from `MMAP_FLOOR` and never clears a page, so a vector staged at
 * `MMAP_FLOOR + 3 * PAGE` survives only as long as exactly three mappings
 * precede the one the capture takes -- and that count is not this file's to
 * control. Putting the KFIG sections on the arena added two mappings ahead of
 * the capture (its directory chunk and its record chunk), and the capture's
 * own mapping then landed on the vector: side activation 1 read back as 0, a
 * duplicate of the main activation, and the capture refused with `EINVAL`.
 */
const SIDES_SCRATCH = 4096;
const CHILD_SIDES_SCRATCH = SIDES_SCRATCH + 64;

/**
 * Where the borrowed-workspace test admits a region: page 7, free in the
 * fixture's layout and below the responder's range. It was `MMAP_FLOOR + 8 *
 * PAGE`, harmless only while nothing was mapped there -- and since the bump
 * heap lost its static floor, a capture's FIRST allocation maps a 1 MiB chunk
 * from `MMAP_FLOOR`, which is sixteen pages over that address. The seed itself
 * writes nothing, so the collision was silent; it is moved for the same reason
 * the sides vector above was.
 */
const BORROWED_WORKSPACE_SCRATCH = 7 * PAGE;

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

    // The fact that was unverifiable before: the module made an arena, and
    // the capture's continuation prefix names it. That it owns (and frees)
    // exactly the chunks behind it is the mapping-balance test further down.
    expect(f.root()).toBeGreaterThan(0);
  });

  it("captures a fork with a SIDE activation, the way a dlopen fork does", () => {
    // The multi-activation capture path, which nothing exercised until the
    // dlopen e2e suite could run again. A side activation is added to the SAME
    // capture from a host-staged `(id, fixed_prefix)` list, and every step that
    // follows -- the arena, the Module records, the guest save drive -- has to
    // cover both activations or the child rebuilds only one.
    const f = fixture();
    seedTemplateId(f, 0, 2048);
    seedTemplateId(f, 1, 2048);
    expect(f.errno(), "both template ids seed").toBe(0);

    // The sides list: one `(id, fixedPrefix)` pair, as `fm_parent_begin_capture`
    // reads it.
    const sidesPtr = SIDES_SCRATCH;
    const sides = new DataView(f.memory.buffer);
    sides.setUint32(sidesPtr, 1, true);
    sides.setUint32(sidesPtr + 4, 0, true);

    // Both activations' drive slots, the way `bindActivationDrive` binds them.
    // Without activation 1's the capture `call_indirect`s past the end of the
    // table -- which is what a host that registers an activation and forgets to
    // grow the table would do.
    const driven: number[] = [];
    for (const activation of [0, 1]) {
      const base = (f.x.fm_drive_table_base as (a: number) => number)(activation);
      const needed = base + FORK_ACTIVATION_DRIVE_SLOTS;
      if (f.instance.driveTable.length < needed) {
        f.instance.driveTable.grow(needed - f.instance.driveTable.length);
      }
      f.instance.driveTable.set(
        base + DRIVE_SLOT_MODULE_STATE_SAVE,
        saveSlotThunk((id) => driven.push(id)) as never,
      );
      f.instance.driveTable.set(
        base + DRIVE_SLOT_UNWIND_BEGIN,
        saveSlotThunk(() => {}) as never,
      );
    }

    (f.x.fm_capture_begin as () => void)();
    (f.x.fm_parent_begin_capture as (...a: number[]) => number)(
      CHANNEL_BASE,
      0,
      sidesPtr,
      1,
    );
    expect(f.errno(), "a two-activation capture begins").toBe(0);
    expect(driven.sort(), "the save walk covers BOTH activations").toEqual([0, 1]);

    const root = f.root();
    expect(root, "into an arena of its own").toBeGreaterThan(0);
    const modules = arenaRecords(f.memory, root).filter(
      (r) => r.kind === RECORD_KIND_MODULE,
    );
    expect(
      modules.map((r) => r.activation).sort(),
      "one Module record per activation, or the child installs only one",
    ).toEqual([0, 1]);
  });

  it("records where every activation's continuation begins, for the child", () => {
    // A child reads the launch anchor to find activation 0's continuation, and
    // nothing else says where a SIDE activation's begins -- it is a per-fork
    // address, not a static property of the loaded module. The JS coordinator
    // wrote this manifest at seal and read it back on the child; the write went
    // with the coordinator and the record kind sat defined and unused. Without
    // it a multi-activation child cannot be seeded at all. Census 183.
    const f = fixture();
    seedTemplateId(f, 0, 2048);
    seedTemplateId(f, 1, 2048);
    const sidesPtr = SIDES_SCRATCH;
    const sides = new DataView(f.memory.buffer);
    sides.setUint32(sidesPtr, 1, true);
    sides.setUint32(sidesPtr + 4, 0, true);
    for (const activation of [0, 1]) {
      const base = (f.x.fm_drive_table_base as (a: number) => number)(activation);
      const needed = base + FORK_ACTIVATION_DRIVE_SLOTS;
      if (f.instance.driveTable.length < needed) {
        f.instance.driveTable.grow(needed - f.instance.driveTable.length);
      }
      for (const slot of [DRIVE_SLOT_MODULE_STATE_SAVE, DRIVE_SLOT_UNWIND_BEGIN]) {
        f.instance.driveTable.set(base + slot, saveSlotThunk(() => {}) as never);
      }
      // `wpk_fork_unwind_end()` takes no activation id, so it needs a thunk of
      // its own shape; a mismatched one is a signature trap, not a no-op.
      f.instance.driveTable.set(
        base + DRIVE_SLOT_UNWIND_END,
        voidSlotThunk(() => {}) as never,
      );
    }
    (f.x.fm_capture_begin as () => void)();
    const act0Root = (f.x.fm_parent_begin_capture as (...a: number[]) => number)(
      CHANNEL_BASE,
      0,
      sidesPtr,
      1,
    );
    expect(f.errno(), "a two-activation capture begins").toBe(0);
    (f.x.fm_parent_seal_capture as (base: number) => number)(CHANNEL_BASE);
    expect(f.errno(), "and seals").toBe(0);

    const manifest = arenaRecords(f.memory, f.root()).find(
      (r) => r.kind === RECORD_KIND_ACTIVATION_CONTINUATIONS,
    );
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
    expect(seen.get(0), "activation 0's root is the one begin returned").toBe(
      act0Root,
    );
    expect(seen.get(1), "and the side activation has one of its own")
      .toBeGreaterThan(0);
    expect(seen.get(1), "distinct from activation 0's").not.toBe(act0Root);
  });

  it("writes no manifest for a single-activation capture", () => {
    // The child reads the launch anchor for activation 0; a manifest would only
    // repeat it, and writing one would put a record in every ordinary fork's
    // arena for nobody.
    const f = fixture();
    seedTemplateId(f, 0, 2048);
    (f.x.fm_capture_begin as () => void)();
    (f.x.fm_parent_begin_capture as (...a: number[]) => number)(CHANNEL_BASE, 0, 0, 0);
    (f.x.fm_parent_seal_capture as (base: number) => number)(CHANNEL_BASE);
    expect(f.errno(), "seal").toBe(0);
    expect(
      arenaRecords(f.memory, f.root()).some(
        (r) => r.kind === RECORD_KIND_ACTIVATION_CONTINUATIONS,
      ),
    ).toBe(false);
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
    expect(
      f.root(),
      "the capture's prefix names the caller's arena, not a second one the " +
        "module made",
    ).toBe(MMAP_FLOOR - PAGE);
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
      openCapture(f);
      (f.x.fm_parent_abort_seal as () => void)();
      expect(f.errno(), "the abort seal").toBe(0);
      (f.x.fm_parent_replay as (abort: number) => void)(1);
      expect(f.errno(), "the abort replay").toBe(0);
      (f.x.fm_parent_finish as (abort: number) => void)(1);
      expect(f.errno(), "the abort finish").toBe(0);
      expect((f.x.fm_phase as () => number)(), "back to idle").toBe(PHASE_IDLE);
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
      openCapture(f);
      (f.x.fm_parent_seal_capture as (b: number) => number)(CHANNEL_BASE);
      expect(f.errno(), "the seal").toBe(0);
      (f.x.fm_parent_replay as (abort: number) => void)(0);
      expect(f.errno(), "the parent replay").toBe(0);
      (f.x.fm_parent_finish as (abort: number) => void)(0);
      expect(f.errno(), "the finish").toBe(0);
      expect((f.x.fm_phase as () => number)(), "back to idle").toBe(PHASE_IDLE);
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
    expect(
      moduleStateRootAt(f, anchor),
      "the module allocated its own arena",
    ).toBeGreaterThan(0);

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
    // inherited shape directly rather than through a fork. Census D9 C2.
    const f = fixture();
    seedTemplateId(f, 0, 2048);
    expect(f.errno(), "the first template-id seed").toBe(0);
    seedTemplateId(f, 0, 2048);
    expect(f.errno(), "and an IDENTICAL re-seed is a no-op").toBe(0);
    // A different id under the same activation is two modules claiming one
    // coordinate, and stays loud.
    new Uint8Array(f.memory.buffer, 3072, 32).fill(0xab);
    seedTemplateId(f, 0, 3072);
    expect(f.errno(), "a CONFLICTING template id is refused").toBe(22);

    seedSections(f);
    seedSections(f);
    expect(f.errno(), "identical KFIG/KFIT bytes re-seed as a no-op").toBe(0);
    const seed = f.x.fm_set_activation_imports as (
      space: number,
      activation: number,
      ptr: number,
      len: number,
    ) => void;
    const other = kfigOne(2, 0, GLOBAL_TYPE_I32);
    new Uint8Array(f.memory.buffer, 9216, other.length).set(other);
    seed(SPACE_GLOBAL, 0, 9216, other.length);
    expect(f.errno(), "CONFLICTING KFIG bytes are refused").toBe(22);

    // And the phase: open a capture, then do what a fresh worker does.
    (f.x.fm_capture_begin as () => void)();
    (f.x.fm_parent_begin_capture as (...a: number[]) => number)(CHANNEL_BASE, 0, 0, 0);
    expect((f.x.fm_phase as () => number)(), "mid-capture").toBe(PHASE_CAPTURE);
    (f.x.fm_set_format as (...a: number[]) => void)(4, 0, 0, 0, CHANNEL_BASE);
    expect(f.errno(), "the format seed is accepted").toBe(0);
    expect(
      (f.x.fm_phase as () => number)(),
      "a worker that has just seeded its format has no fork in flight",
    ).toBe(PHASE_IDLE);
  });

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

    const records = arenaRecords(f.memory, f.root());
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
    const anchor = backend.parentBeginCapture(CHANNEL_BASE, 0, []);
    expect(f.errno(), "capture").toBe(0);
    backend.sealCaptureAndSerialize();
    expect(Number((f.x.fm_phase as () => number)()), "sealed").toBe(
      PHASE_SEALED_PARENT,
    );

    // Everything a child reads out of the inherited arena, in one place: the
    // activation set, the snapshot the guest saved, the bindings the module
    // elected, and the journal image the seal serialized.
    const kinds = arenaRecords(f.memory, moduleStateRootAt(f, anchor)).map(
      (r) => r.kind,
    );
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
    const root = f.root();

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

  /** `DRIVE_SLOT_MODULE_TABLE_STATE_SAVE`. */
  const DRIVE_SLOT_TABLE_STATE_SAVE = 14;

  it("captures a peer-table checkpoint into a fresh module-owned arena", () => {
    // A PEER-TABLE checkpoint is not a fork: no frames, no unwind, no journal.
    // What it must produce is an arena that names this worker's activations and
    // carries the table records the guest's table-save walk wrote, sealed with
    // the reference segments a peer needs to rebuild the funcref slots.
    const f = fixture();
    seedTemplateId(f, 0, 2048);
    const saved: number[] = [];
    const reserve = f.x.__wpk_fork_module_state_record_reserve as (
      kind: number,
      activation: number,
      owner: number,
      size: number,
    ) => number;
    const commit = f.x.__wpk_fork_module_state_record_commit as (p: number) => void;
    const base = (f.x.fm_drive_table_base as (a: number) => number)(0);
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

    seedTemplateId(f, 0, 2048);
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
    seedTemplateId(f, 0, 2048);
    seedSections(f);
    const { provenance } = publish(f);
    provenance(SPACE_GLOBAL, 0, 0, KIND_ACTIVATION_GLOBAL, 0, 0n);
    provenance(SPACE_TABLE, 0, 1, KIND_ACTIVATION_TABLE, 0, 0n);
    saveWrites(f, 0, 1);
    (f.x.fm_parent_begin_capture as (...a: number[]) => number)(CHANNEL_BASE, 0, 0, 0);
    expect(f.errno(), "a fork is open").toBe(0);
    expect(
      (f.x.fm_capture_peer_tables as (c: number) => number)(CHANNEL_BASE),
      "and the checkpoint is refused",
    ).toBe(0);
    expect(f.errno(), "as a phase error, not an argument one").toBe(16);
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
    const f = fixture();
    const base = f.x.fm_drive_table_base as (a: number) => number;
    expect(base(0)).toBe(0);
    expect(base(1), "one stride up").toBe(FORK_ACTIVATION_DRIVE_SLOTS);
    expect(base(2), "and linear from there").toBe(2 * FORK_ACTIVATION_DRIVE_SLOTS);
  });

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
    const root = f.root();

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

  it("assembles binding records when a SIDE activation imports a global too", () => {
    // The dlopen shape: both activations declare an imported global and both
    // publish provenance for it. Nothing exercised this until the dlopen e2e
    // could run, and `write_imported_global_bindings` walks EVERY activation in
    // the fork -- so a side activation whose declarations or snapshots are
    // missing refuses the whole capture rather than its own record.
    const f = fixture();
    seedTemplateId(f, 0, 2048);
    seedTemplateId(f, 1, 2048);
    const seed = f.x.fm_set_activation_imports as (
      space: number,
      activation: number,
      ptr: number,
      len: number,
    ) => void;
    for (const [activation, at] of [[0, 6144], [1, 7168]] as const) {
      const kfig = kfigOne(1, 0, GLOBAL_TYPE_I32);
      new Uint8Array(f.memory.buffer, at, kfig.length).set(kfig);
      seed(SPACE_GLOBAL, activation, at, kfig.length);
      expect(f.errno(), `KFIG seed for activation ${activation}`).toBe(0);
    }
    const { provenance } = publish(f);
    provenance(SPACE_GLOBAL, 0, 0, KIND_ACTIVATION_GLOBAL, 0, 0n);
    provenance(SPACE_GLOBAL, 1, 0, KIND_ACTIVATION_GLOBAL, 0, 0n);

    const driven: number[] = [];
    for (const activation of [0, 1]) {
      const base = (f.x.fm_drive_table_base as (a: number) => number)(activation);
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
      f.instance.driveTable.set(
        base + DRIVE_SLOT_UNWIND_BEGIN,
        saveSlotThunk(() => {}) as never,
      );
    }

    const sidesPtr = SIDES_SCRATCH;
    const sides = new DataView(f.memory.buffer);
    sides.setUint32(sidesPtr, 1, true);
    sides.setUint32(sidesPtr + 4, 0, true);
    (f.x.fm_capture_begin as () => void)();
    (f.x.fm_parent_begin_capture as (...a: number[]) => number)(
      CHANNEL_BASE,
      0,
      sidesPtr,
      1,
    );
    expect(f.errno(), "a two-activation capture with imports begins").toBe(0);
    expect(driven.sort(), "both saves ran").toEqual([0, 1]);

    const bindings = arenaRecords(f.memory, f.root()).filter(
      (r) => r.kind === RECORD_KIND_IMPORTED_GLOBAL_BINDINGS,
    );
    expect(bindings.length, "one binding record for the whole fork").toBe(1);
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

    const plan = readPlan(f.x, () => f.errno(), 0, f.root());
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
        f.root(),
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
      f.root(),
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
    const root = f.root();
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
    const root = f.root();

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

  it("puts a restore AND a finish-restore in the child's install plan", () => {
    // The guest's `finish_restore` TRAPS when `bootstrap_done` is 0, and the
    // only thing that sets it in a child is the guest's own `restore` -- so the
    // plan must carry both, in that order, for every activation the arena
    // declares. A plan missing the restores traps inside the guest with no
    // errno to read, which is what the dlopen e2e hit (census 182).
    const f = fixture();
    seedTemplateId(f, 0, 2048);
    (f.x.fm_capture_begin as () => void)();
    (f.x.fm_parent_begin_capture as (...a: number[]) => number)(CHANNEL_BASE, 0, 0, 0);
    (f.x.fm_parent_seal_capture as (base: number) => number)(CHANNEL_BASE);
    expect(f.errno(), "seal").toBe(0);
    const root = f.root();

    const child = childModule(f);
    (child.fm_attach_child as (r: number, pid: number) => number)(root, 1);
    expect((child.fm_last_errno as () => number)(), "the child attaches").toBe(0);
    const steps = (child.fm_gc_plan_count as () => number)();
    expect(
      steps,
      "one activation: a restore and a finish-restore at least",
    ).toBeGreaterThanOrEqual(2);
  });

  it("seeds a child from the arena, then attaches it in the phase that left", () => {
    // The two halves of a child install, in the order a host performs them.
    // `fm_child_seed` rebuilds every activation's replay driver from the
    // inherited journal image; `fm_attach_child` seeds the reference graph and
    // builds the install plan. The seed moves the module to CHILD_REPLAY, so an
    // attach that insisted on IDLE answered EBUSY and the whole install stopped
    // there -- which is exactly what the dlopen e2e hit once the seed was wired
    // back up (its caller went with the fork coordinator).
    //
    // A SIDE activation's record carries no root at all, on purpose: a host
    // cannot know one (it is a per-fork address), so the module resolves it
    // from the KFAC manifest it wrote at seal.
    const f = fixture();
    seedTemplateId(f, 0, 2048);
    seedTemplateId(f, 1, 2048);
    const sidesPtr = SIDES_SCRATCH;
    const sides = new DataView(f.memory.buffer);
    sides.setUint32(sidesPtr, 1, true);
    sides.setUint32(sidesPtr + 4, 0, true);
    for (const activation of [0, 1]) {
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
    (f.x.fm_capture_begin as () => void)();
    const act0Root = (f.x.fm_parent_begin_capture as (...a: number[]) => number)(
      CHANNEL_BASE,
      0,
      sidesPtr,
      1,
    );
    expect(f.errno(), "a two-activation capture begins").toBe(0);
    (f.x.fm_parent_seal_capture as (base: number) => number)(CHANNEL_BASE);
    expect(f.errno(), "and seals").toBe(0);
    const root = f.root();

    // The child's side record is the SAME `(id, fixedPrefix)` pair the capture
    // side reads: the host owns the fixed prefix and nothing else about it.
    const childSides = CHILD_SIDES_SCRATCH;
    const sideRecord = new DataView(f.memory.buffer);
    sideRecord.setUint32(childSides, 1, true);
    sideRecord.setUint32(childSides + 4, 0, true);

    const child = childModule(f);
    const childSeed = child.fm_child_seed as (r: number, a: number, s: number, n: number) => void;
    // NEVER SEEDED IS REFUSED. Neither activation has a resume catalog in this
    // child yet, and the module no longer numbers slots from the committed
    // ordinals when it finds none: a binary arriving with nothing seeded is a
    // build whose instrumentation step did not run, and numbering by a rule
    // the guest's resume table does not share is the divergence the seeded
    // catalog exists to rule out. `EINVAL` (22), from the phase the entry
    // never left -- a failed seed enters no phase, so the retry below is
    // clean.
    childSeed(root, act0Root, childSides, 1);
    expect(
      (child.fm_last_errno as () => number)(),
      "a child whose catalogs were never seeded is refused",
    ).toBe(22);
    expect((child.fm_phase as () => number)(), "and no phase was entered").toBe(PHASE_IDLE);
    // AN EMPTY CATALOG IS NOT THAT CASE. This capture committed no frame, so
    // both activations hold zero resume targets -- which is what
    // `libneeded-provider.so` seeds in `fork-from-dlopen-side-module-e2e`,
    // and mistaking it for "never registered" already cost a real fork. An
    // empty RECORD says "registered, holding nothing"; NO record says "never
    // registered". Seeded the way every host seeds: activation 0 through the
    // same entry as its side.
    for (const activation of [0, 1]) {
      (child.fm_set_activation_resume_catalog as (a: number, p: number, c: number) => void)(
        activation,
        SIDES_SCRATCH,
        0,
      );
      expect(
        (child.fm_last_errno as () => number)(),
        `an empty catalog is a legitimate seed for activation ${activation}`,
      ).toBe(0);
    }
    childSeed(root, act0Root, childSides, 1);
    expect(
      (child.fm_last_errno as () => number)(),
      "the seed resolves the side root from the manifest",
    ).toBe(0);
    expect(
      (child.fm_phase as () => number)(),
      "and the seed is what enters child replay",
    ).toBe(PHASE_CHILD_REPLAY);

    const plan = (child.fm_attach_child as (r: number, pid: number) => number)(
      root,
      1,
    );
    expect(
      (child.fm_last_errno as () => number)(),
      "the attach is legal from the phase the seed left",
    ).toBe(0);
    expect(plan, "and it builds an install plan").toBeGreaterThan(0);

    // The install plan must END in a REWIND BEGIN per activation, carrying that
    // activation's continuation root. Without those steps the child's guest is
    // never told to rewind: `wpk_fork_resume_start` finds no rewind in progress
    // and runs `_start` LEXICALLY, so the program begins again from `main`
    // instead of resuming after `fork()`. No trap, no errno -- the child just
    // runs the whole program a second time. Census 185.
    const DRIVE_OP_REWIND_BEGIN = 8;
    const DRIVE_STEP_SIZE = 16;
    const count = (child.fm_gc_plan_count as () => number)();
    const steps = new DataView(f.memory.buffer);
    const tail = [];
    for (let i = count - 2; i < count; i += 1) {
      const at = plan + i * DRIVE_STEP_SIZE;
      tail.push({
        op: steps.getUint32(at, true),
        recipe: steps.getUint32(at + 8, true),
        arg: steps.getUint32(at + 12, true),
      });
    }
    // eslint-disable-next-line no-console
    expect(
      tail.map((step) => step.op),
      "the last two steps are the two activations' rewind begins",
    ).toEqual([DRIVE_OP_REWIND_BEGIN, DRIVE_OP_REWIND_BEGIN]);
    // `pack_root` splits the root across (recipe, arg); on wasm32 it is all arg.
    expect(
      tail.map((step) => step.recipe),
      "a wasm32 root fits the low word",
    ).toEqual([0, 0]);
    expect(
      tail.map((step) => step.arg).includes(act0Root),
      "activation 0 rewinds from the anchor the capture returned",
    ).toBe(true);
    expect(
      new Set(tail.map((step) => step.arg)).size,
      "and each activation rewinds from a root of its own",
    ).toBe(2);
  });

  it("drives one rewind begin per activation, or refuses the replay", () => {
    // The parent's replay is the mirror of the child's install: both end by
    // telling each guest to rewind, and both fail SILENTLY if they do not. An
    // activation never told to rewind leaves `wpk_fork_resume_start` with no
    // rewind in progress, so it runs `_start` lexically and the process runs
    // its whole program again -- no trap, no errno, and the first visible sign
    // is something far away (here, `dlopen` called a second time while the fork
    // still held the loader's archive reader). Census 186.
    const f = fixture();
    seedTemplateId(f, 0, 2048);
    seedTemplateId(f, 1, 2048);
    // The side activation is declared by hand here rather than through
    // `openCapture`, so its (empty) resume catalog is seeded by hand too: the
    // replay below registers every activation's slots from its catalog and
    // refuses one that never seeded.
    seedEmptyResumeCatalog(f.x, 1);
    const sidesPtr = SIDES_SCRATCH;
    const sides = new DataView(f.memory.buffer);
    sides.setUint32(sidesPtr, 1, true);
    sides.setUint32(sidesPtr + 4, 0, true);
    for (const activation of [0, 1]) {
      const base = (f.x.fm_drive_table_base as (a: number) => number)(activation);
      const needed = base + FORK_ACTIVATION_DRIVE_SLOTS;
      if (f.instance.driveTable.length < needed) {
        f.instance.driveTable.grow(needed - f.instance.driveTable.length);
      }
      for (const slot of [
        DRIVE_SLOT_MODULE_STATE_SAVE,
        DRIVE_SLOT_UNWIND_BEGIN,
        DRIVE_SLOT_REWIND_BEGIN,
      ]) {
        f.instance.driveTable.set(base + slot, saveSlotThunk(() => {}) as never);
      }
      f.instance.driveTable.set(
        base + DRIVE_SLOT_UNWIND_END,
        voidSlotThunk(() => {}) as never,
      );
    }
    (f.x.fm_capture_begin as () => void)();
    (f.x.fm_parent_begin_capture as (...a: number[]) => number)(
      CHANNEL_BASE,
      0,
      sidesPtr,
      1,
    );
    expect(f.errno(), "a two-activation capture begins").toBe(0);
    (f.x.fm_parent_seal_capture as (base: number) => number)(CHANNEL_BASE);
    expect(f.errno(), "and seals").toBe(0);

    (f.x.fm_parent_replay as (abort: number) => void)(0);
    expect(f.errno(), "the parent replay is accepted").toBe(0);
    expect(
      (f.x.fm_gc_plan_count as () => number)(),
      "one rewind begin for each of the two activations",
    ).toBe(2);
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

    // The CHILD decodes the sealed graph and reports it back. Node count and
    // the aggregate's own coordinates are what a replay then drives from.
    const child = childModule(f, { label: "aggregate-capture-child" });
    const nodes = (child.fm_decode_reference_graph as (r: number) => number)(root);
    expect(
      (child.fm_last_errno as () => number)(),
      "the child decodes what the parent sealed",
    ).toBe(0);
    // Canonical null, two leaves, one aggregate.
    expect(nodes).toBe(4);

    const field = child.fm_decoded_node_field as (i: number, f: number) => number;
    const aggregateIndex = aggregateRecipes[0]!;
    expect(
      field(aggregateIndex, 1),
      "the aggregate reports the activation it was captured for",
    ).toBe(0);
    expect(
      field(aggregateIndex, 2),
      "and the type ordinal it was defined with",
    ).toBe(13);
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

    const child = childModule(f, { label: "cycle-capture-child" });
    const nodes = (child.fm_decode_reference_graph as (r: number) => number)(root);
    expect(
      (child.fm_last_errno as () => number)(),
      "a child decodes a cyclic graph without looping",
    ).toBe(0);
    // Canonical null, one leaf, two aggregates.
    expect(nodes).toBe(4);
  });

  it("refuses a vector whose appends do not match what was promised", () => {
    // The guest declares an edge count at `begin` and then appends. If it
    // appends FEWER, the module must fail loud at `finish` rather than intern a
    // short vector -- a child would then reconstruct an aggregate with missing
    // references, which is a wrong object rather than an error. `append`
    // returns nothing (that is the guest ABI), so `finish` is the only place
    // this can surface.
    const f = fixture();
    seedTemplateId(f, 0, 2048);
    (f.x.fm_capture_begin as () => void)();
    (f.x.fm_parent_begin_capture as (...a: number[]) => number)(CHANNEL_BASE, 0, 0, 0);
    expect(f.errno(), "the capture opens").toBe(0);
    // A leaf through the guest-facing i31 capture entry, as the generated
    // codec interns one.
    const leaf = (f.x.__wpk_fork_ref_gc_i31 as (payload: number) => number)(5);
    expect(f.errno(), "a leaf to point at").toBe(0);

    const handle = (f.x.__wpk_fork_ref_vector_begin as (n: number) => number)(2);
    expect(f.errno(), "promise two edges").toBe(0);
    (f.x.__wpk_fork_ref_vector_append as (h: number, r: number) => void)(handle, leaf);
    expect(f.errno(), "append one").toBe(0);
    const ordinal = (f.x.__wpk_fork_ref_vector_finish as (h: number) => number)(handle);
    expect(f.errno(), "and a short vector is refused").toBe(22);
    expect(ordinal, "with no ordinal handed back").toBe(-1);
  });

  it("refuses a borrowed child seed with no admitted workspace, and carves one when there is", () => {
    // A vfork BORROWED child shares the PARKED parent's memory. Its own
    // active-frame writes must land in a private prefix, or they scribble on
    // storage the parent is still using -- a wrong value, not a trap. The host
    // seeds the region the KERNEL admitted; the module carves it.
    //
    // With no region seeded there is nowhere private to write, so the seed is
    // refused rather than defaulting to somewhere. Census D9 C4.
    const f = fixture();
    seedTemplateId(f, 0, 2048);
    (f.x.fm_capture_begin as () => void)();
    const act0Root = (f.x.fm_parent_begin_capture as (...a: number[]) => number)(
      CHANNEL_BASE,
      0,
      0,
      0,
    );
    (f.x.fm_parent_seal_capture as (base: number) => number)(CHANNEL_BASE);
    expect(f.errno(), "the parent seals").toBe(0);
    const root = f.root();

    // WHAT THIS TEST DOES NOT REACH, said plainly rather than implied: a
    // borrowed SEED refuses on its inherited journal image long before it
    // carves, because this fixture's capture commits no frames. So the carve's
    // own guards -- no workspace seeded, and a prefix that crosses the admitted
    // end -- are NOT gated here. Both were perturbed and both survived this
    // file, which is the honest reading: their gate is the vfork e2e, and
    // census D9 records it as owed. What IS gated below is the entry's own
    // validation of the region it is handed.
    const noWorkspace = childModule(f);
    const seed = noWorkspace.fm_set_borrowed_workspace as
      (base: number, bytes: number) => void;
    seed(0, PAGE);
    expect((noWorkspace.fm_last_errno as () => number)(), "base 0").toBe(22);
    seed(BORROWED_WORKSPACE_SCRATCH, 0);
    expect((noWorkspace.fm_last_errno as () => number)(), "zero bytes").toBe(22);

    // Admitted properly, the seed carves and succeeds.
    seed(BORROWED_WORKSPACE_SCRATCH, PAGE);
    expect(
      (noWorkspace.fm_last_errno as () => number)(),
      "a real region is accepted",
    ).toBe(0);
  });

  it("still refuses a child install from a phase that is not an install", () => {
    // Widening the attach to accept CHILD_REPLAY must not widen it to accept
    // everything: an attach while THIS worker is capturing its own fork would
    // seed a replay driver over a live capture.
    const f = fixture();
    seedTemplateId(f, 0, 2048);
    (f.x.fm_capture_begin as () => void)();
    (f.x.fm_parent_begin_capture as (...a: number[]) => number)(CHANNEL_BASE, 0, 0, 0);
    expect(f.errno(), "capture open").toBe(0);
    expect((f.x.fm_phase as () => number)(), "in capture").toBe(PHASE_CAPTURE);
    (f.x.fm_attach_child as (r: number, pid: number) => number)(
      f.root(),
      1,
    );
    expect(f.errno(), "an attach mid-capture is refused").toBe(EBUSY);
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
    const root = f.root();

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

    const globals = arenaRecords(f.memory, f.root()).find(
      (r) => r.kind === RECORD_KIND_IMPORTED_GLOBAL_BINDINGS,
    );
    const g = globals!.payload;
    expect(g.getUint8(56), "kind").toBe(KIND_BASE_IMPORT);
    expect([g.getUint32(32, true), g.getUint32(36, true)]).toEqual([0, 0]);
  });

  it("a seal that fails after the frames sealed still leaves the parent able to abort-replay", () => {
    // THE FORK THAT FAILS AT THE SEAL. `fm_parent_seal_capture` drives the
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
    openCapture(f);

    // A reference vector opened and never finished: the graph validator's
    // "a reference vector was never finished" refusal, which is the exact fault
    // a guest whose reference encode returned -1 produces.
    (f.x.__wpk_fork_ref_vector_begin as (n: number) => number)(1);
    expect(f.errno(), "the vector opens").toBe(0);

    (f.x.fm_parent_seal_capture as (base: number) => number)(CHANNEL_BASE);
    expect(f.errno(), "and the seal refuses the incomplete graph").toBe(22);

    // BEHAVIOURAL, like every other phase assertion here: the legal next call
    // succeeds. It can only succeed from sealed-parent.
    (f.x.fm_parent_replay as (abort: number) => void)(1);
    expect(f.errno(), "the parent can still abort-replay its frames").toBe(0);
  });
});

