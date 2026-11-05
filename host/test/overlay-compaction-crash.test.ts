import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { KandeloImageFs } from "../../images/vfs/lib/kandelo-image-fs";
import { resolveBinary } from "../src/binary-resolver";
import { CentralizedKernelWorker } from "../src/kernel-worker";
import { NodePlatformIO } from "../src/platform/node";
import { configureRootfsOverlayFromImage } from "../src/process-lifecycle";
import { ERRNO } from "../src/generated/abi";
import { journalBytes } from "./fixtures/overlay-journal-header";
import { activationCodec, sealCodec, encodeOverlayActivation, decodeOverlayActivation } from "./fixtures/native-overlay-activation";
import type { HostFileOffset } from "../src/types";
import { writeOverlayGenerationSealSync } from "./fixtures/native-overlay-activation";
import {
  compactOverlayGeneration,
  enableBestOverlayGeneration,
  LiveOverlayCompactor,
  RejectedOverlayGenerationError,
  type OverlayGenerationFiles,
  type SelectedOverlayGeneration,
} from "../src/vfs/overlay-generation-selection";
import type { PersistentOverlayStorage } from "../src/vfs/overlay-storage";

type Persistence = "flush-only" | "write-through";
type CutTiming = "before" | "after";
type Layout = "legacy" | "sealed" | "extended";

class CrashDisk {
  readonly volatile = new Map<string, Uint8Array>();
  readonly durable = new Map<string, Uint8Array>();
  readonly trace: string[] = [];
  cutAt = -1;
  cutTiming: CutTiming = "after";
  crashed = false;

  constructor(readonly persistence: Persistence) {}

  operation<Value>(name: string, action: () => Value): Value {
    if (this.crashed) throw new Error("simulated owner loss");
    const sequence = this.trace.length;
    this.trace.push(name);
    if (sequence === this.cutAt && this.cutTiming === "before") this.crash();
    const result = action();
    if (sequence === this.cutAt && this.cutTiming === "after") this.crash();
    return result;
  }

  private crash(): never {
    this.crashed = true;
    throw new Error("simulated owner loss");
  }

  publish(key: string, bytes: Uint8Array): void {
    this.volatile.set(key, bytes);
    if (this.persistence === "write-through") this.durable.set(key, bytes.slice());
  }

  seed(key: string, bytes: Uint8Array): void {
    this.volatile.set(key, bytes.slice());
    this.durable.set(key, bytes.slice());
  }

  recover(): CrashDisk {
    const recovered = new CrashDisk(this.persistence);
    for (const [key, bytes] of this.durable) recovered.seed(key, bytes);
    return recovered;
  }

  files(): OverlayGenerationFiles {
    return {
      activationCodec,
      sealCodec,
      listSlots: async () => this.operation("list", () => [...new Set(
        [...this.volatile.keys()].flatMap((key) => /^(g[0-9]+)\./.exec(key)?.[1] ?? []),
      )]),
      open: async (slot, file, create) => this.operation(`open:${slot}.${file}`, () => {
        const key = `${slot}.${file}`;
        if (!this.volatile.has(key)) {
          if (!create) return null;
          this.seed(key, new Uint8Array());
        }
        return new CrashStorage(this, key);
      }),
      remove: async (slot, file) => this.operation(`remove:${slot}.${file}`, () => {
        this.volatile.delete(`${slot}.${file}`);
        this.durable.delete(`${slot}.${file}`);
      }),
    };
  }
}

class CrashStorage implements PersistentOverlayStorage {
  constructor(readonly disk: CrashDisk, readonly key: string) {}

  len(): number {
    return this.disk.operation(`len:${this.key}`, () => this.disk.volatile.get(this.key)!.length);
  }

  readExactAt(offset: HostFileOffset, destination: Uint8Array): void {
    this.disk.operation(`read:${this.key}`, () => {
      const bytes = this.disk.volatile.get(this.key)!;
      const start = Number(offset);
      if (start + destination.length > bytes.length) throw new Error("short read");
      destination.set(bytes.subarray(start, start + destination.length));
    });
  }

  writeAllAt(offset: HostFileOffset, source: Uint8Array): void {
    this.disk.operation(`write:${this.key}`, () => {
      const previous = this.disk.volatile.get(this.key)!;
      const start = Number(offset);
      const bytes = new Uint8Array(Math.max(previous.length, start + source.length));
      bytes.set(previous);
      bytes.set(source, start);
      this.disk.publish(this.key, bytes);
    });
  }

  truncate(length: HostFileOffset): void {
    this.disk.operation(`truncate:${this.key}`, () => {
      this.disk.publish(this.key, this.disk.volatile.get(this.key)!.slice(0, Number(length)));
    });
  }

  flush(): void {
    this.disk.operation(`flush:${this.key}`, () => {
      this.disk.durable.set(this.key, this.disk.volatile.get(this.key)!.slice());
    });
  }

  close(): void {
    this.disk.operation(`close:${this.key}`, () => {});
  }
}

function fixture(persistence: Persistence, layout: Layout): {
  disk: CrashDisk;
  selected: SelectedOverlayGeneration;
  current: Uint8Array;
} {
  const disk = new CrashDisk(persistence);
  const baseDigest = new Uint8Array(32).fill(6);
  const current = journalBytes(72, 6);
  if (layout === "legacy") {
    disk.seed("legacy.journal", current);
    const activation = encodeOverlayActivation({ sequence: 1, generation: 0, slot: "legacy",
      baseDigest, sealDigest: new Uint8Array(32) });
    disk.seed("legacy.activation0", activation);
    disk.seed("legacy.activation1", activation);
    disk.trace.length = 0;
    return {
      disk, current,
      selected: { journal: new CrashStorage(disk, "legacy.journal"), slot: "legacy", generation: 0, sealedLength: 0 },
    };
  }
  const count = layout === "sealed" ? 2 : 4;
  const knownGenerations = new Map<`g${number}`, number>();
  for (let index = 0; index < count; index++) {
    const slot = `g${index}` as const;
    const bytes = index === count - 1 ? current : journalBytes(72, 6);
    disk.seed(`${slot}.journal`, bytes);
    disk.seed(`${slot}.index`, Uint8Array.of(index + 1));
    disk.seed(`${slot}.seal`, new Uint8Array());
    writeOverlayGenerationSealSync(
      new CrashStorage(disk, `${slot}.journal`), new CrashStorage(disk, `${slot}.seal`),
      index + 1, baseDigest, new CrashStorage(disk, `${slot}.index`),
      index === 0 ? undefined : { slot: `g${index - 1}`, journalLength: 72 },
    );
    knownGenerations.set(slot, index + 1);
  }
  const slot = `g${count - 1}` as const;
  const activation = encodeOverlayActivation({ sequence: count + 1, generation: count, slot,
    baseDigest, sealDigest: new Uint8Array(createHash("sha256").update(disk.volatile.get(`${slot}.seal`)!).digest()) });
  disk.seed("legacy.activation0", activation);
  disk.seed("legacy.activation1", activation);
  disk.trace.length = 0;
  return {
    disk, current,
    selected: {
      journal: new CrashStorage(disk, `${slot}.journal`), index: new CrashStorage(disk, `${slot}.index`),
      slot, generation: count, sealedLength: current.length, knownGenerations,
    },
  };
}

async function compact(disk: CrashDisk, selected: SelectedOverlayGeneration): Promise<SelectedOverlayGeneration> {
  return compactOverlayGeneration(selected, disk.files(), {
    prepare: (target) => {
      const bytes = new Uint8Array(selected.journal.len());
      selected.journal.readExactAt(0, bytes);
      target.writeAllAt(0, bytes);
      disk.operation("prepare:complete", () => {});
    },
    checkpoint: (target) => {
      target.writeAllAt(0, Uint8Array.of(81, 82, 83));
      disk.operation("checkpoint:complete", () => {});
    },
    activate: () => disk.operation("activate", () => {}),
    fail: () => {}, cancel: () => disk.operation("cancel", () => {}),
  }, 0, () => true, () => {});
}

async function nativeRootfs(image: Uint8Array): Promise<CentralizedKernelWorker> {
  const worker = new CentralizedKernelWorker(
    { maxWorkers: 1, dataBufferSize: 65536, useSharedMemory: true, kernelMaxPages: 1024 },
    new NodePlatformIO(),
  );
  configureRootfsOverlayFromImage(worker, {
    imageLength: image.byteLength,
    imageRead: (offset, destination) => {
      const bytes = image.subarray(offset, offset + destination.byteLength);
      destination.set(bytes);
      return bytes.byteLength;
    },
    foreignPrefixes: [],
    nosuid: false,
  });
  const kernel = new Uint8Array(readFileSync(resolveBinary("kernel.wasm")));
  await worker.init(kernel.buffer);
  return worker;
}

describe("acknowledged native writes during generation retirement", () => {
  it.each((["flush-only", "write-through"] as const).flatMap(persistence =>
    (["unsealed", "sealed"] as const).flatMap(retirement =>
      (["owner-loss", "flush", "close", "stop"] as const).map(fault => [persistence, retirement, fault] as const),
    ),
  ))("retains a target-only synced transaction after %s / %s / %s", async (persistence, retirement, fault) => {
    const encoder = new TextEncoder();
    const marker = encoder.encode("acknowledged only after activation");
    const filesystem = KandeloImageFs.create(new Uint8Array(readFileSync(resolveBinary("kandelo_image_module32.wasm"))));
    filesystem.writeFile("/state", encoder.encode("base"), 0o644);
    const image = await filesystem.saveImage();
    filesystem.reset();
    const disk = new CrashDisk(persistence);
    const files = disk.files();
    const worker = await nativeRootfs(image);
    const source = await enableBestOverlayGeneration(files, (journal, index, checkpointEnd) => {
      worker.enableResizableRootfsPersistence(journal, index, checkpointEnd);
    });
    const handoff = {
      prepare: (target: PersistentOverlayStorage) => worker.prepareRootfsPersistenceCompaction(target),
      checkpoint: (index: PersistentOverlayStorage) => worker.checkpointPreparedRootfsPersistence(index),
      activate: () => worker.activateRootfsPersistenceCompaction(),
      cancel: () => worker.cancelRootfsPersistenceCompaction(),
      fail: (error: Error) => worker.failPersistenceWriter(error),
    };
    worker.rootfsWriteFile("/state", encoder.encode("first generation"), 0o644);
    worker.syncRootfsPersistence();
    let selected = await compactOverlayGeneration(source, files, handoff, 0);
    expect(selected.slot).toBe("g0");
    if (retirement === "sealed") {
      const obsolete = new Map(["journal", "index", "seal"].map(file =>
        [file, disk.volatile.get(`g0.${file}`)!.slice()] as const,
      ));
      for (const generation of [2, 3, 4]) {
        worker.rootfsWriteFile("/state", encoder.encode(`generation ${generation}`), 0o644);
        worker.syncRootfsPersistence();
        selected = await compactOverlayGeneration(selected, files, handoff, 0);
      }
      for (const [file, bytes] of obsolete) disk.seed(`g3.${file}`, bytes);
      selected = { ...selected, knownGenerations: new Map([
        ...(selected.knownGenerations ?? []), ["g3", 1],
      ]) };
    }
    const expectedGeneration = selected.generation + 1;
    worker.rootfsWriteFile("/state", encoder.encode("immediate predecessor"), 0o644);
    worker.syncRootfsPersistence();
    let reachedCleanup!: () => void;
    let releaseCleanup!: () => void;
    const reached = new Promise<void>(resolve => { reachedCleanup = resolve; });
    const cleanup = new Promise<void>(resolve => { releaseCleanup = resolve; });
    const failures: unknown[] = [];
    let active = selected;
    let stopResolved = false;
    let stopping: Promise<void> | undefined;
    const compactor = new LiveOverlayCompactor(selected, {
      ...files,
      open: async (slot, file, create) => {
        const storage = await files.open(slot, file, create);
        if (storage !== null && slot === (retirement === "sealed" ? "g3" : "legacy")
          && file === (retirement === "sealed" ? "seal" : "journal")) {
          reachedCleanup();
          await cleanup;
          if (fault === "owner-loss") {
            disk.cutAt = disk.trace.length;
            disk.cutTiming = "before";
          } else if (fault === "flush") {
            storage.flush = () => disk.operation("retirement:flush-failure", () => {
              throw new Error("injected retirement flush failure");
            });
          } else if (fault === "close") {
            storage.close = () => disk.operation("retirement:close-failure", () => {
              throw new Error("injected retirement close failure");
            });
          }
        }
        return storage;
      },
    }, handoff, next => { active = next; }, error => { failures.push(error); }, 0);
    const running = compactor.compactIfNeeded();
    try {
      await Promise.race([reached, running.then(() => {
        throw new Error("compaction ended before reaching post-activation retirement");
      })]);
      expect(active).toBe(selected);
      for (const replica of ["activation0", "activation1"]) {
        expect(decodeOverlayActivation(disk.durable.get(`legacy.${replica}`)!)).toMatchObject({ slot: "g1", generation: expectedGeneration });
      }
      worker.rootfsWriteFile("/only-after-activation", marker, 0o644);
      worker.syncRootfsPersistence();
      expect(worker.rootfsReadFile("/only-after-activation")).toEqual(marker);
      if (fault === "stop") stopping = compactor.stop().then(() => { stopResolved = true; });
      const predecessorDisk = disk.recover();
      const predecessor = await nativeRootfs(image);
      predecessor.enableResizableRootfsPersistence(
        new CrashStorage(predecessorDisk, "g0.journal"),
        new CrashStorage(predecessorDisk, "g0.index"),
        selected.sealedLength,
      );
      expect(predecessor.rootfsReadFile("/state")).toEqual(encoder.encode("immediate predecessor"));
      let absent: unknown;
      try { predecessor.rootfsReadFile("/only-after-activation"); }
      catch (error) { absent = error; }
      expect(absent).toMatchObject({ errno: ERRNO.ENOENT });
      predecessor.disposeRootfsDeferredTransport();
      expect(stopResolved).toBe(false);
    } finally {
      releaseCleanup();
      await running;
      await compactor.stop();
      await stopping;
      worker.disposeRootfsDeferredTransport();
    }
    expect(active.slot).toBe("g1");
    if (fault === "stop") {
      expect(stopResolved).toBe(true);
      expect(failures).toEqual([]);
    } else expect(failures.length).toBeGreaterThan(0);
    const recovered = disk.recover();
    const reopened = await nativeRootfs(image);
    const mounted = await enableBestOverlayGeneration(recovered.files(), (journal, index, checkpointEnd) => {
      reopened.enableResizableRootfsPersistence(journal, index, checkpointEnd);
    }, true);
    try {
      expect(mounted.slot).toBe("g1");
      expect(reopened.rootfsReadFile("/only-after-activation")).toEqual(marker);
      expect(reopened.rootfsReadFile("/state")).toEqual(encoder.encode("immediate predecessor"));
    } finally {
      mounted.index?.close();
      mounted.journal.close();
      reopened.disposeRootfsDeferredTransport();
    }
  }, 30_000);
});

describe("compaction durable-snapshot crash cuts", () => {
  it.each([
    ["flush-only", "legacy"], ["flush-only", "sealed"],
    ["write-through", "legacy"], ["write-through", "sealed"],
  ] as const)("anchors an uncontrolled source before boot conversion at every cut: %s / %s", async (persistence, layout) => {
    const initial = () => {
      const value = fixture(persistence, layout);
      for (const key of ["legacy.activation0", "legacy.activation1"]) {
        value.disk.volatile.delete(key);
        value.disk.durable.delete(key);
      }
      value.disk.trace.length = 0;
      return value;
    };
    const convert = (disk: CrashDisk, sourceSlot: string, mounted: Uint8Array[]) => enableBestOverlayGeneration(disk.files(), journal => {
      disk.operation("enable", () => {});
      if ((journal as CrashStorage).key === `${sourceSlot}.journal`) {
        throw new RejectedOverlayGenerationError("fixed", 12, true);
      }
      const bytes = new Uint8Array(journal.len());
      journal.readExactAt(0, bytes);
      mounted.push(bytes);
    }, true, (source, target, index) => {
      const bytes = new Uint8Array(source.len());
      source.readExactAt(0, bytes);
      target.writeAllAt(0, bytes);
      index.writeAllAt(0, Uint8Array.of(81, 82, 83));
      disk.operation("conversion:complete", () => {});
    }, () => {});
    const baseline = initial();
    const finished = await convert(baseline.disk, baseline.selected.slot, []);
    expect(finished.generation).toBe(baseline.selected.generation + 1);
    const firstTargetWrite = baseline.disk.trace.findIndex(event => /^truncate:g[0-9]+\.journal$/.test(event));
    expect(firstTargetWrite).toBeGreaterThan(baseline.disk.trace.indexOf("flush:legacy.activation1"));
    for (const timing of ["before", "after"] as const) {
      for (let cut = 0; cut < baseline.disk.trace.length; cut++) {
        const { disk, selected, current } = initial();
        disk.cutAt = cut;
        disk.cutTiming = timing;
        await convert(disk, selected.slot, []).catch(() => {});
        const context = `${persistence}/${layout}/${timing}/${cut}:${baseline.disk.trace[cut]}`;
        expect(disk.crashed, context).toBe(true);
        const recovered = disk.recover();
        expect(recovered.durable.get(`${selected.slot}.journal`), context).toEqual(current);
        const mounted: Uint8Array[] = [];
        const reopened = await convert(recovered, selected.slot, mounted);
        expect(mounted, context).toEqual([current]);
        reopened.index?.close();
        reopened.journal.close();
      }
    }
  }, 30_000);

  it.each([
    ["flush-only", "legacy"], ["flush-only", "sealed"], ["flush-only", "extended"],
    ["write-through", "legacy"], ["write-through", "sealed"], ["write-through", "extended"],
  ] as const)("recovers current bytes at every operation boundary: %s / %s", async (persistence, layout) => {
    const baseline = fixture(persistence, layout);
    const finished = await compact(baseline.disk, baseline.selected);
    expect(finished.generation).toBe(baseline.selected.generation + 1);
    expect(baseline.disk.trace).toContain("activate");
    if (layout === "extended") expect(baseline.disk.trace).toContain("remove:g1.journal");
    for (const timing of ["before", "after"] as const) {
      for (let cut = 0; cut < baseline.disk.trace.length; cut++) {
        const { disk, selected, current } = fixture(persistence, layout);
        disk.cutAt = cut;
        disk.cutTiming = timing;
        await compact(disk, selected).catch(() => {});
        const context = `${persistence}/${layout}/${timing}/${cut}:${baseline.disk.trace[cut]}`;
        expect(disk.crashed, context).toBe(true);
        const recovered = disk.recover();
        expect(recovered.durable.get(`${selected.slot}.journal`), context).toEqual(current);
        const mounted: Uint8Array[] = [];
        const reopened = await enableBestOverlayGeneration(recovered.files(), (journal) => {
          const bytes = new Uint8Array(journal.len());
          journal.readExactAt(0, bytes);
          mounted.push(bytes);
        }, true);
        expect(mounted, context).toEqual([current]);
        expect(reopened.generation, context).toBeGreaterThanOrEqual(selected.generation);
        expect(reopened.generation, context).toBeLessThanOrEqual(selected.generation + 1);
        reopened.index?.close();
        reopened.journal.close();
      }
    }
  }, 30_000);
});
