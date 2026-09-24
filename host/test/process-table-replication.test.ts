import { describe, expect, it } from "vitest";
import type { DlopenSupport } from "../src/worker-main";
import {
  __testCreateProcessTableReplicationOwner,
} from "../src/worker-main";
import type { DylinkLoader, LoaderTableState } from "../src/dylink-loader";
import type { DylinkTablePatch as DylinkForkTablePatch } from "../src/dylink-planner-wire";

interface TestTableReplicationOwner {
  reconcileNow(): number;
  materialize(generation: bigint): number;
}

/**
 * The archive's table half, as the loader exposes it.
 *
 * The record layout, the immutability rules and the generation fence now live
 * in `crates/dylink::archive` and are proved there. What this suite exercises is
 * the host half that remains above them: a replica instantiates a peer's
 * modules and restores a published checkpoint when the generation moves, and
 * answers the fork module's request to do so. (Funcref patches are applied by
 * the fork module now, and published by it; the patch-writer cases that used to
 * live here went with the TypeScript that did both.) So the archive is a
 * stand-in that keeps exactly the state those decisions read.
 */
interface ArchiveFixture {
  readonly loader: DylinkLoader;
  read(): LoaderTableState;
  generation(): number;
  publishTablePatch(patch: DylinkForkTablePatch): void;
}

/** The KFLA journal bound, past which a full checkpoint is the only option. */
const MAX_TABLE_PATCH_RECORDS = 256;

function archiveFixture(): ArchiveFixture {
  let generation = 1;
  let tableStateRoot = 0;
  let tableCheckpointGeneration = 0;
  let tablePatches: (DylinkForkTablePatch & { generation: number })[] = [];
  const state = (): LoaderTableState => ({
    generation,
    tableStateRoot,
    tableCheckpointGeneration,
    tablePatches: [...tablePatches],
  });
  const loader = {
    generation: () => generation,
    readArchive: () => {},
    tableState: state,
    canPublishTablePatch: () => tablePatches.length + 1 <= MAX_TABLE_PATCH_RECORDS,
    publishTablePatch: (value: DylinkForkTablePatch) => {
      generation += 1;
      tablePatches = [...tablePatches, { ...value, generation }];
      return { state: state() };
    },
    publishTableState: (root: number) => {
      const previousTableStateRoot = tableStateRoot;
      generation += 1;
      tableStateRoot = root;
      tableCheckpointGeneration = generation;
      // A checkpoint supersedes every patch published before it.
      tablePatches = [];
      return { state: state(), previousTableStateRoot };
    },
  } as unknown as DylinkLoader;
  return {
    loader,
    read: state,
    generation: () => generation,
    publishTablePatch: (value) => {
      loader.publishTablePatch(value);
    },
  };
}

function dlopenFixture(archive: ArchiveFixture): DlopenSupport {
  let writerDepth = 0;
  let readerDepth = 0;
  let writerObserver = () => {};
  return {
    imports: {},
    readForkState: () => [],
    replayDlopens: () => {},
    resetForkChildLock: () => {},
    loader: () => archive.loader,
    archiveGeneration: () => archive.generation(),
    acquireArchiveWriter: () => {
      if (writerDepth++ === 0) writerObserver();
    },
    releaseArchiveWriter: () => {
      if (writerDepth <= 0) throw new Error("writer underflow");
      writerDepth--;
    },
    acquireArchiveReader: () => { readerDepth++; },
    releaseArchiveReader: () => {
      if (readerDepth <= 0) throw new Error("reader underflow");
      readerDepth--;
    },
    withArchiveWriter: <T>(operation: () => T): T => {
      if (writerDepth++ === 0) writerObserver();
      try {
        return operation();
      } finally {
        writerDepth--;
      }
    },
    withArchiveReader: <T>(operation: () => T): T => {
      readerDepth++;
      try {
        return operation();
      } finally {
        readerDepth--;
      }
    },
    writerOwned: () => writerDepth > 0,
    setWriterAcquireObserver: (observer) => { writerObserver = observer; },
    setOperationAbortObserver: () => {},
    setCommitObserver: () => {},
  };
}

function patch(generation?: number): DylinkForkTablePatch {
  return {
    ...(generation === undefined ? {} : { generation }),
    activationId: 0,
    ownerId: 1,
    start: 0,
    tableLength: 1,
    runs: [{
      length: 1,
      function: { activationId: 0, ordinal: 0 },
    }],
  };
}

function replica(
  archive: ArchiveFixture,
  options: { restoreSnapshots: boolean; borrowed?: boolean; dlopen?: DlopenSupport },
) {
  const counts = { materialized: 0, restored: 0 };
  const owner = __testCreateProcessTableReplicationOwner({
    generationAddress: 64,
    tableCheckpoint: {
      capture: () => 512,
      restore: () => { counts.restored++; },
    },
    dlopen: options.dlopen ?? dlopenFixture(archive),
    materializeModules: () => { counts.materialized++; },
    restoreSnapshots: options.restoreSnapshots,
    ...(options.borrowed ? { borrowedImmutableSnapshot: true } : {}),
    label: "replica",
  }) as TestTableReplicationOwner;
  return { owner, counts };
}

describe("process table replication", () => {
  it("skips only the fork child's copied baseline and restores later checkpoints", () => {
    const archive = archiveFixture();
    archive.loader.publishTableState(256);
    const { owner, counts } = replica(archive, { restoreSnapshots: false });

    owner.reconcileNow();
    expect(counts).toEqual({ materialized: 1, restored: 0 });
    archive.loader.publishTableState(512);
    owner.reconcileNow();
    expect(counts).toEqual({ materialized: 2, restored: 1 });
    owner.reconcileNow();
    expect(counts, "an unchanged generation does nothing").toEqual({
      materialized: 2,
      restored: 1,
    });
  });

  it("answers the fork module's materialize request with the generation it reached", () => {
    const archive = archiveFixture();
    archive.publishTablePatch(patch());
    const { owner, counts } = replica(archive, { restoreSnapshots: true });

    expect(owner.materialize(BigInt(archive.generation()))).toBe(0);
    expect(counts.materialized).toBe(1);
    // A generation the archive has not reached is EAGAIN, not a false success.
    expect(owner.materialize(BigInt(archive.generation() + 1))).toBe(11);
  });

  it("observes a borrowed immutable generation without acquiring its writer", () => {
    const archive = archiveFixture();
    archive.publishTablePatch(patch());
    const dlopen = dlopenFixture(archive);
    let writerAcquisitions = 0;
    dlopen.withArchiveWriter = <T>(_operation: () => T): T => {
      writerAcquisitions++;
      throw new Error("borrowed snapshot attempted archive mutation");
    };
    dlopen.acquireArchiveWriter = () => {
      writerAcquisitions++;
      throw new Error("borrowed snapshot attempted archive mutation");
    };
    const { owner, counts } = replica(archive, {
      restoreSnapshots: false,
      borrowed: true,
      dlopen,
    });

    expect(owner.reconcileNow()).toBe(archive.generation());
    expect(owner.materialize(BigInt(archive.generation()))).toBe(0);
    expect(writerAcquisitions).toBe(0);
    expect(counts.materialized).toBe(0);
  });
});
