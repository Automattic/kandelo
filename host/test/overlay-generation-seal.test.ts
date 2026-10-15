import { describe, expect, it } from "vitest";
import type { HostFileOffset } from "../src/types";
import type { PersistentOverlayStorage } from "../src/vfs/overlay-storage";
import {
  verifyOverlayGenerationSeal,
  writeOverlayGenerationSeal,
} from "../src/vfs/overlay-generation-seal";
import {
  compactOverlayGeneration,
  enableBestOverlayGeneration,
  NoValidOverlayGenerationError,
  RejectedOverlayGenerationError,
  type OverlayGenerationFiles,
} from "../src/vfs/overlay-generation-selection";

class MemoryStorage implements PersistentOverlayStorage {
  bytes: Uint8Array;
  maxRead = 0;
  failFlush = false;
  failNextFlush = false;
  failNextRead = false;
  failNextWrite = false;
  failNextTruncate = false;
  failNextClose = false;
  closeCount = 0;

  constructor(bytes: Uint8Array = new Uint8Array()) {
    this.bytes = bytes.slice();
  }

  len(): number {
    return this.bytes.byteLength;
  }

  readExactAt(offset: HostFileOffset, destination: Uint8Array): void {
    if (this.failNextRead) {
      this.failNextRead = false;
      throw new Error("injected read failure");
    }
    const start = Number(offset);
    if (start < 0 || start + destination.byteLength > this.bytes.byteLength) throw new Error("short read");
    this.maxRead = Math.max(this.maxRead, destination.byteLength);
    destination.set(this.bytes.subarray(start, start + destination.byteLength));
  }

  writeAllAt(offset: HostFileOffset, source: Uint8Array): void {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error("injected write failure");
    }
    const start = Number(offset);
    const length = Math.max(this.bytes.byteLength, start + source.byteLength);
    const next = new Uint8Array(length);
    next.set(this.bytes);
    next.set(source, start);
    this.bytes = next;
  }

  flush(): void {
    if (this.failFlush) throw new Error("injected flush failure");
    if (this.failNextFlush) {
      this.failNextFlush = false;
      throw new Error("injected flush failure");
    }
  }

  truncate(length: HostFileOffset): void {
    if (this.failNextTruncate) {
      this.failNextTruncate = false;
      throw new Error("injected truncate failure");
    }
    this.bytes = this.bytes.slice(0, Number(length));
  }

  close(): void {
    this.closeCount++;
    if (this.failNextClose) {
      this.failNextClose = false;
      throw new Error("injected close failure");
    }
  }
}

describe("overlay generation seal", () => {
  it("verifies a large journal with bounded reads and rejects corruption", async () => {
    const journal = new MemoryStorage(Uint8Array.from(
      { length: 2 * 1024 * 1024 + 3 },
      (_, index) => index % 251,
    ));
    const seal = new MemoryStorage();
    const baseDigest = new Uint8Array(32).fill(7);
    await writeOverlayGenerationSeal(journal, seal, 12, baseDigest);
    expect(seal.len()).toBe(88 + 3 * 32);
    expect(await verifyOverlayGenerationSeal(journal, seal, baseDigest)).toEqual({
      generation: 12,
      journalLength: journal.len(),
      baseDigest,
    });
    expect(journal.maxRead).toBeLessThanOrEqual(1024 * 1024);
    journal.bytes[1024 * 1024 + 1] ^= 1;
    await expect(verifyOverlayGenerationSeal(journal, seal)).rejects.toThrow("invalid");
    journal.bytes[1024 * 1024 + 1] ^= 1;
    await expect(verifyOverlayGenerationSeal(journal, seal, new Uint8Array(32))).rejects.toThrow("invalid");
    seal.truncate(seal.len() - 1);
    await expect(verifyOverlayGenerationSeal(journal, seal)).rejects.toThrow("invalid");
  });

  it("does not publish a seal when the journal flush fails", async () => {
    const journal = new MemoryStorage(Uint8Array.of(1, 2, 3));
    journal.failFlush = true;
    const seal = new MemoryStorage();
    await expect(writeOverlayGenerationSeal(journal, seal, 1, new Uint8Array(32))).rejects.toThrow("injected");
    expect(seal.len()).toBe(0);
    journal.failFlush = false;
    const index = new MemoryStorage(Uint8Array.of(4, 5, 6));
    index.failFlush = true;
    await expect(writeOverlayGenerationSeal(journal, seal, 1, new Uint8Array(32), index)).rejects.toThrow("injected");
    expect(seal.len()).toBe(0);
  });

  it("binds an indexed generation without materializing its whole sidecar", async () => {
    const journal = new MemoryStorage(Uint8Array.of(1, 2, 3));
    const index = new MemoryStorage(Uint8Array.from(
      { length: 2 * 1024 * 1024 + 3 },
      (_, position) => position % 251,
    ));
    const seal = new MemoryStorage();
    const baseDigest = new Uint8Array(32).fill(9);
    await writeOverlayGenerationSeal(journal, seal, 2, baseDigest, index);
    expect(seal.len()).toBe(96 + 4 * 32);
    expect(await verifyOverlayGenerationSeal(journal, seal, baseDigest, false, index)).toEqual({
      generation: 2,
      journalLength: 3,
      baseDigest,
      indexLength: index.len(),
    });
    expect(index.maxRead).toBeLessThanOrEqual(1024 * 1024);
    await expect(verifyOverlayGenerationSeal(journal, seal, baseDigest)).rejects.toThrow("invalid");
    index.bytes[1024 * 1024 + 1] ^= 1;
    await expect(verifyOverlayGenerationSeal(journal, seal, baseDigest, false, index)).rejects.toThrow("invalid");
    index.bytes[1024 * 1024 + 1] ^= 1;
    index.truncate(index.len() - 1);
    await expect(verifyOverlayGenerationSeal(journal, seal, baseDigest, false, index)).rejects.toThrow("invalid");
  });

  it("can verify a sealed immutable prefix before an active append tail", async () => {
    const journal = new MemoryStorage(Uint8Array.of(1, 2, 3));
    const seal = new MemoryStorage();
    await writeOverlayGenerationSeal(journal, seal, 1, new Uint8Array(32));
    journal.writeAllAt(3, Uint8Array.of(4, 5));
    await expect(verifyOverlayGenerationSeal(journal, seal)).rejects.toThrow("invalid");
    expect((await verifyOverlayGenerationSeal(journal, seal, undefined, true)).journalLength).toBe(3);
    journal.bytes[0] ^= 1;
    await expect(verifyOverlayGenerationSeal(journal, seal, undefined, true)).rejects.toThrow("invalid");
  });

  it("rejects invalid generation numbers and header damage", async () => {
    const journal = new MemoryStorage(Uint8Array.of(1, 2, 3));
    const seal = new MemoryStorage();
    await expect(writeOverlayGenerationSeal(journal, seal, Number.MAX_SAFE_INTEGER + 1, new Uint8Array(32)))
      .rejects.toThrow("invalid");
    await writeOverlayGenerationSeal(journal, seal, 1, new Uint8Array(32));
    seal.bytes[16] ^= 1;
    await expect(verifyOverlayGenerationSeal(journal, seal)).rejects.toThrow("invalid");
  });
});

describe("overlay generation boot selection", () => {
  function files(entries: Record<string, MemoryStorage>): OverlayGenerationFiles {
    return {
      open: async (slot, file, create) => {
        const key = `${slot}.${file}`;
        if (create && entries[key] === undefined) entries[key] = new MemoryStorage();
        return entries[key] ?? null;
      },
    };
  }

  it("selects the highest verified generation and accepts an appended journal tail", async () => {
    const entries: Record<string, MemoryStorage> = {
      "legacy.journal": new MemoryStorage(Uint8Array.of(9)),
      "g0.journal": new MemoryStorage(Uint8Array.of(1, 2)),
      "g0.seal": new MemoryStorage(),
      "g1.journal": new MemoryStorage(Uint8Array.of(3, 4)),
      "g1.seal": new MemoryStorage(),
    };
    const digest = new Uint8Array(32);
    await writeOverlayGenerationSeal(entries["g0.journal"]!, entries["g0.seal"]!, 2, digest);
    await writeOverlayGenerationSeal(entries["g1.journal"]!, entries["g1.seal"]!, 3, digest);
    entries["g1.journal"]!.writeAllAt(2, Uint8Array.of(5));
    const selected = await enableBestOverlayGeneration(files(entries), () => {});
    expect(selected.slot).toBe("g1");
    expect(selected.journal.len()).toBe(3);
  });

  it("refuses two distinct sealed slots with the same generation", async () => {
    const entries: Record<string, MemoryStorage> = {
      "legacy.journal": new MemoryStorage(Uint8Array.of(9)),
      "g0.journal": new MemoryStorage(Uint8Array.of(1)),
      "g0.seal": new MemoryStorage(),
      "g1.journal": new MemoryStorage(Uint8Array.of(2)),
      "g1.seal": new MemoryStorage(),
    };
    const digest = new Uint8Array(32);
    await writeOverlayGenerationSeal(entries["g0.journal"]!, entries["g0.seal"]!, 4, digest);
    await writeOverlayGenerationSeal(entries["g1.journal"]!, entries["g1.seal"]!, 4, digest);
    let enableCalls = 0;
    await expect(enableBestOverlayGeneration(files(entries), () => { enableCalls++; }))
      .rejects.toThrow("ambiguous sealed generations");
    expect(enableCalls).toBe(0);
    expect(entries["g0.journal"]!.closeCount).toBe(1);
    expect(entries["g1.journal"]!.closeCount).toBe(1);
    expect(entries["legacy.journal"]!.closeCount).toBe(0);
    await writeOverlayGenerationSeal(entries["g1.journal"]!, entries["g1.seal"]!, 5, digest);
    expect((await enableBestOverlayGeneration(files(entries), () => {})).slot).toBe("g1");
  });

  it("falls back after a torn seal or rejected kernel journal", async () => {
    const entries: Record<string, MemoryStorage> = {
      "legacy.journal": new MemoryStorage(Uint8Array.of(9)),
      "g0.journal": new MemoryStorage(Uint8Array.of(1)),
      "g0.seal": new MemoryStorage(),
      "g1.journal": new MemoryStorage(Uint8Array.of(2)),
      "g1.seal": new MemoryStorage(),
    };
    await writeOverlayGenerationSeal(entries["g0.journal"]!, entries["g0.seal"]!, 1, new Uint8Array(32));
    await writeOverlayGenerationSeal(entries["g1.journal"]!, entries["g1.seal"]!, 2, new Uint8Array(32));
    entries["g1.seal"]!.truncate(4);
    expect((await enableBestOverlayGeneration(files(entries), () => {})).slot).toBe("g0");
    entries["g1.seal"]!.truncate(0);
    expect((await enableBestOverlayGeneration(files(entries), (journal) => {
      if (journal === entries["g0.journal"]) {
        throw new RejectedOverlayGenerationError("fixed", 5);
      }
    })).slot).toBe("legacy");
  });

  it.each(["fixed", "resizable"] as const)("falls back from a semantically corrupt %s generation only", async (mode) => {
    const entries: Record<string, MemoryStorage> = {
      "g0.journal": new MemoryStorage(Uint8Array.of(1)),
      "g0.seal": new MemoryStorage(),
      "g1.journal": new MemoryStorage(Uint8Array.of(2)),
      "g1.seal": new MemoryStorage(),
    };
    const digest = new Uint8Array(32);
    await writeOverlayGenerationSeal(entries["g0.journal"]!, entries["g0.seal"]!, 1, digest);
    await writeOverlayGenerationSeal(entries["g1.journal"]!, entries["g1.seal"]!, 2, digest);
    const attempts: number[] = [];
    const selected = await enableBestOverlayGeneration(files(entries), (journal) => {
      attempts.push(journal === entries["g1.journal"] ? 2 : 1);
      if (journal === entries["g1.journal"]) throw new RejectedOverlayGenerationError(mode, 5);
    });
    expect(selected.slot).toBe("g0");
    expect(attempts).toEqual([2, 1]);
    await expect(enableBestOverlayGeneration(files(entries), (journal) => {
      if (journal === entries["g1.journal"]) throw new RejectedOverlayGenerationError(mode, 12);
    })).rejects.toThrow(/errno 12/);
    await expect(enableBestOverlayGeneration(files(entries), (journal) => {
      if (journal === entries["g1.journal"]) throw new Error("host I/O failed");
    })).rejects.toThrow("host I/O failed");
  });

  it("falls back when a newer indexed generation is damaged", async () => {
    const entries: Record<string, MemoryStorage> = {
      "g0.journal": new MemoryStorage(Uint8Array.of(1)),
      "g0.seal": new MemoryStorage(),
      "g1.journal": new MemoryStorage(Uint8Array.of(2)),
      "g1.seal": new MemoryStorage(),
      "g1.index": new MemoryStorage(Uint8Array.of(3, 4, 5)),
    };
    const digest = new Uint8Array(32);
    await writeOverlayGenerationSeal(entries["g0.journal"]!, entries["g0.seal"]!, 1, digest);
    await writeOverlayGenerationSeal(entries["g1.journal"]!, entries["g1.seal"]!, 2, digest, entries["g1.index"]!);
    const indexed = await enableBestOverlayGeneration(files(entries), (journal, index, checkpointEnd) => {
      expect(journal).toBe(entries["g1.journal"]);
      expect(index).toBe(entries["g1.index"]);
      expect(checkpointEnd).toBe(1);
    });
    expect(indexed.slot).toBe("g1");
    expect(indexed.index).toBe(entries["g1.index"]);
    entries["g1.index"]!.bytes[1] ^= 1;
    expect((await enableBestOverlayGeneration(files(entries), () => {})).slot).toBe("g0");
    entries["g0.seal"]!.truncate(0);
    await expect(enableBestOverlayGeneration(files(entries), () => {})).rejects.toBeInstanceOf(NoValidOverlayGenerationError);
  });

  it("refuses a silent reset when only incomplete generation files remain", async () => {
    const entries = { "g0.journal": new MemoryStorage(Uint8Array.of(1)) };
    await expect(enableBestOverlayGeneration(files(entries), () => {}))
      .rejects.toThrow("refusing to reset");
    expect(Object.keys(entries)).toEqual(["g0.journal"]);
  });

  it("refuses an empty legacy journal when all generation slots are invalid", async () => {
    const entries: Record<string, MemoryStorage> = {
      "legacy.journal": new MemoryStorage(),
      "g0.journal": new MemoryStorage(Uint8Array.of(1)),
      "g0.seal": new MemoryStorage(Uint8Array.of(2)),
    };
    await expect(enableBestOverlayGeneration(files(entries), () => {}))
      .rejects.toBeInstanceOf(NoValidOverlayGenerationError);
    expect(entries["legacy.journal"]!.len()).toBe(0);
  });

  it("does not create a missing journal for a restored computer", async () => {
    const entries: Record<string, MemoryStorage> = {};
    await expect(enableBestOverlayGeneration(files(entries), () => {}, true))
      .rejects.toThrow("refusing to reset");
    expect(Object.keys(entries)).toEqual([]);
    expect((await enableBestOverlayGeneration(files(entries), () => {})).slot).toBe("legacy");
    await expect(enableBestOverlayGeneration(files(entries), () => {}, true))
      .rejects.toBeInstanceOf(NoValidOverlayGenerationError);
  });

  it("reports a nonempty rejected legacy journal as no valid generation", async () => {
    const entries = { "legacy.journal": new MemoryStorage(Uint8Array.of(1, 2, 3)) };
    await expect(enableBestOverlayGeneration(files(entries), () => {
      throw new RejectedOverlayGenerationError("fixed", 5);
    })).rejects.toBeInstanceOf(NoValidOverlayGenerationError);
    expect(entries["legacy.journal"].closeCount).toBe(1);
    await expect(enableBestOverlayGeneration(files({}), () => {
      throw new RejectedOverlayGenerationError("fixed", 5);
    })).rejects.toBeInstanceOf(RejectedOverlayGenerationError);
    await expect(enableBestOverlayGeneration(files({ "legacy.journal": new MemoryStorage(Uint8Array.of(1)) }), () => {
      throw new Error("backend unavailable");
    })).rejects.toThrow("backend unavailable");
  });

  it("stages and seals a compacted slot before selecting it", async () => {
    const source = new MemoryStorage(new Uint8Array(72).fill(7));
    const entries: Record<string, MemoryStorage> = { "legacy.journal": source };
    const selected = { journal: source, slot: "legacy", generation: 0, sealedLength: 0 } as const;
    const stages: string[] = [];
    const compacted = await compactOverlayGeneration(selected, files(entries), {
      prepare: (target) => {
        target.writeAllAt(0, source.bytes);
        target.flush();
        stages.push("prepare");
        queueMicrotask(() => stages.push("microtask"));
      },
      checkpoint: (index) => {
        index.writeAllAt(0, Uint8Array.of(1, 2, 3));
        stages.push("checkpoint");
      },
      activate: () => {
        expect(entries["g0.seal"]!.len()).toBeGreaterThan(96);
        stages.push("activate");
      },
      cancel: () => { throw new Error("unexpected cancellation"); },
    }, 0);
    expect(stages).toEqual(["prepare", "checkpoint", "activate", "microtask"]);
    expect(compacted.slot).toBe("g0");
    expect(compacted.generation).toBe(1);
    expect(entries["g0.seal"]!.len()).toBeGreaterThan(96);
    expect(compacted.index).toBe(entries["g0.index"]);
    expect((await enableBestOverlayGeneration(files(entries), () => {})).slot).toBe("g0");
    expect(source.bytes).toEqual(new Uint8Array(72).fill(7));
  });

  it("binds a successful target after preparation flushes the source", async () => {
    const source = new MemoryStorage(new Uint8Array(72).fill(7));
    const entries: Record<string, MemoryStorage> = { "legacy.journal": source };
    await compactOverlayGeneration(
      { journal: source, slot: "legacy", generation: 0, sealedLength: 0 },
      files(entries),
      {
        prepare: (target) => {
          source.writeAllAt(source.len(), Uint8Array.of(42));
          target.writeAllAt(0, source.bytes);
        },
        checkpoint: (index) => { index.writeAllAt(0, Uint8Array.of(1, 2, 3)); },
        activate: () => {},
        cancel: () => { throw new Error("unexpected cancellation"); },
      },
      0,
    );
    expect((await enableBestOverlayGeneration(files(entries), () => {})).slot).toBe("g0");
  });

  it("closes every old handle after activation even when one close fails", async () => {
    const source = new MemoryStorage(new Uint8Array(72).fill(7));
    const sourceIndex = new MemoryStorage(Uint8Array.of(4));
    const entries: Record<string, MemoryStorage> = {
      "g0.journal": source,
      "g0.index": sourceIndex,
      "g1.seal": new MemoryStorage(),
    };
    entries["g1.seal"]!.failNextClose = true;
    const failures: string[] = [];
    const compacted = await compactOverlayGeneration(
      { journal: source, index: sourceIndex, slot: "g0", generation: 1, sealedLength: 0 },
      files(entries),
      {
        prepare: (target) => { target.writeAllAt(0, source.bytes); },
        checkpoint: (index) => { index.writeAllAt(0, Uint8Array.of(1, 2, 3)); },
        activate: () => {},
        cancel: () => { throw new Error("unexpected cancellation"); },
      },
      0,
      () => true,
      (error) => { failures.push(String(error)); },
    );
    expect(compacted.slot).toBe("g1");
    expect(failures).toEqual(["Error: injected close failure"]);
    expect(entries["g1.seal"]!.closeCount).toBe(1);
    expect(source.closeCount).toBe(1);
    expect(sourceIndex.closeCount).toBe(1);
    expect(compacted.journal).toBe(entries["g1.journal"]);
  });

  it("leaves the source intact when target compaction fails", async () => {
    const source = new MemoryStorage(new Uint8Array(72).fill(7));
    const entries: Record<string, MemoryStorage> = { "legacy.journal": source };
    const selected = { journal: source, slot: "legacy", generation: 0, sealedLength: 0 } as const;
    await expect(compactOverlayGeneration(selected, files(entries), {
      prepare: (target) => {
        target.writeAllAt(0, Uint8Array.of(1, 2));
        throw new Error("injected target failure");
      },
      checkpoint: () => { throw new Error("unexpected checkpoint"); },
      activate: () => { throw new Error("unexpected activation"); },
      cancel: () => {},
    }, 0)).rejects.toThrow("injected target failure");
    expect(source.bytes).toEqual(new Uint8Array(72).fill(7));
    expect(entries["g0.seal"]!.len()).toBe(0);
  });

  it("invalidates a sealed target when activation fails", async () => {
    const source = new MemoryStorage(new Uint8Array(72).fill(7));
    const entries: Record<string, MemoryStorage> = { "legacy.journal": source };
    const selected = { journal: source, slot: "legacy", generation: 0, sealedLength: 0 } as const;
    let canceled = false;
    await expect(compactOverlayGeneration(selected, files(entries), {
      prepare: (target) => { target.writeAllAt(0, source.bytes); },
      checkpoint: (index) => { index.writeAllAt(0, Uint8Array.of(1, 2, 3)); },
      activate: () => { throw new Error("injected activation failure"); },
      cancel: () => { canceled = true; },
    }, 0)).rejects.toThrow("injected activation failure");
    expect(canceled).toBe(true);
    expect(entries["g0.seal"]!.len()).toBe(0);
    expect(source.bytes).toEqual(new Uint8Array(72).fill(7));
  });

  it("rejects a stale target after activation and seal invalidation both fail", async () => {
    const source = new MemoryStorage(new Uint8Array(72).fill(7));
    const entries: Record<string, MemoryStorage> = { "legacy.journal": source };
    await expect(compactOverlayGeneration(
      { journal: source, slot: "legacy", generation: 0, sealedLength: 0 },
      files(entries),
      {
        prepare: (target) => { target.writeAllAt(0, source.bytes); },
        checkpoint: (index) => {
          index.writeAllAt(0, Uint8Array.of(1, 2, 3));
          source.writeAllAt(source.len(), Uint8Array.of(42));
        },
        activate: () => {
          entries["g0.seal"]!.failNextTruncate = true;
          throw new Error("injected activation failure");
        },
        cancel: () => {},
      },
      0,
    )).rejects.toThrow("persistent overlay compaction cleanup failed");
    expect(entries["g0.seal"]!.len()).toBeGreaterThan(0);
    expect((await enableBestOverlayGeneration(files(entries), () => {})).slot).toBe("legacy");
  });

  it("keeps a sealed generation bootable while its former source slot is reused", async () => {
    const entries: Record<string, MemoryStorage> = {
      "g0.journal": new MemoryStorage(Uint8Array.of(1, 2, 3)),
      "g0.seal": new MemoryStorage(),
      "g0.index": new MemoryStorage(Uint8Array.of(4)),
      "g1.journal": new MemoryStorage(Uint8Array.of(5, 6, 7)),
      "g1.seal": new MemoryStorage(),
      "g1.index": new MemoryStorage(Uint8Array.of(8)),
    };
    const digest = new Uint8Array(32);
    await writeOverlayGenerationSeal(entries["g0.journal"]!, entries["g0.seal"]!, 1, digest, entries["g0.index"]!);
    await writeOverlayGenerationSeal(entries["g1.journal"]!, entries["g1.seal"]!, 2, digest,
      entries["g1.index"]!, { slot: "g0", journalLength: entries["g0.journal"]!.len() });
    entries["g0.journal"]!.truncate(0);
    entries["g0.seal"]!.truncate(0);
    expect((await enableBestOverlayGeneration(files(entries), () => {})).slot).toBe("g1");
  });

  it("rejects a stale second generation when its sealed source has an appended tail", async () => {
    const entries: Record<string, MemoryStorage> = {
      "g0.journal": new MemoryStorage(Uint8Array.of(1, 2, 3)),
      "g0.seal": new MemoryStorage(),
      "g0.index": new MemoryStorage(Uint8Array.of(4)),
      "g1.journal": new MemoryStorage(Uint8Array.of(5, 6, 7)),
      "g1.seal": new MemoryStorage(),
      "g1.index": new MemoryStorage(Uint8Array.of(8)),
    };
    const digest = new Uint8Array(32);
    await writeOverlayGenerationSeal(entries["g0.journal"]!, entries["g0.seal"]!, 1, digest, entries["g0.index"]!);
    await writeOverlayGenerationSeal(entries["g1.journal"]!, entries["g1.seal"]!, 2, digest,
      entries["g1.index"]!, { slot: "g0", journalLength: entries["g0.journal"]!.len() });
    entries["g0.journal"]!.writeAllAt(3, Uint8Array.of(9));
    expect((await enableBestOverlayGeneration(files(entries), () => {})).slot).toBe("g0");
  });

  it("cancels preparation and invalidates a seal after its flush fails", async () => {
    const source = new MemoryStorage(new Uint8Array(72).fill(7));
    const entries: Record<string, MemoryStorage> = { "legacy.journal": source };
    const selected = { journal: source, slot: "legacy", generation: 0, sealedLength: 0 } as const;
    let canceled = false;
    await expect(compactOverlayGeneration(selected, files(entries), {
      prepare: (target) => {
        target.writeAllAt(0, source.bytes);
        entries["g0.seal"]!.failNextFlush = true;
      },
      checkpoint: (index) => { index.writeAllAt(0, Uint8Array.of(1, 2, 3)); },
      activate: () => { throw new Error("unexpected activation"); },
      cancel: () => { canceled = true; },
    }, 0)).rejects.toThrow("injected flush failure");
    expect(canceled).toBe(true);
    expect(entries["g0.seal"]!.len()).toBe(0);
    expect(source.bytes).toEqual(new Uint8Array(72).fill(7));
  });

  it("keeps the source active when checkpoint creation fails", async () => {
    const source = new MemoryStorage(new Uint8Array(72).fill(7));
    const entries: Record<string, MemoryStorage> = { "legacy.journal": source };
    const selected = { journal: source, slot: "legacy", generation: 0, sealedLength: 0 } as const;
    let canceled = false;
    await expect(compactOverlayGeneration(selected, files(entries), {
      prepare: (target) => { target.writeAllAt(0, source.bytes); },
      checkpoint: (index) => {
        index.writeAllAt(0, Uint8Array.of(1, 2));
        throw new Error("injected checkpoint failure");
      },
      activate: () => { throw new Error("unexpected activation"); },
      cancel: () => { canceled = true; },
    }, 0)).rejects.toThrow("injected checkpoint failure");
    expect(canceled).toBe(true);
    expect(entries["g0.seal"]!.len()).toBe(0);
    expect(source.bytes).toEqual(new Uint8Array(72).fill(7));
  });

  it.each([
    ["target truncate", "g0.journal", "failNextTruncate"],
    ["target flush", "g0.journal", "failNextFlush"],
    ["index truncate", "g0.index", "failNextTruncate"],
    ["index flush", "g0.index", "failNextFlush"],
    ["target write", "g0.journal", "failNextWrite"],
    ["index write", "g0.index", "failNextWrite"],
    ["seal write", "g0.seal", "failNextWrite"],
    ["seal flush", "g0.seal", "failNextFlush"],
  ] as const)("preserves the source after %s failure", async (_stage, file, fault) => {
    const source = new MemoryStorage(new Uint8Array(72).fill(7));
    const entries: Record<string, MemoryStorage> = {
      "legacy.journal": source,
      "g0.journal": new MemoryStorage(),
      "g0.index": new MemoryStorage(),
      "g0.seal": new MemoryStorage(),
    };
    entries[file]![fault] = true;
    let canceled = false;
    await expect(compactOverlayGeneration(
      { journal: source, slot: "legacy", generation: 0, sealedLength: 0 },
      files(entries),
      {
        prepare: (target) => {
          target.writeAllAt(0, source.bytes);
          target.flush();
        },
        checkpoint: (index) => {
          index.writeAllAt(0, Uint8Array.of(1, 2, 3));
          index.flush();
        },
        activate: () => { throw new Error("unexpected activation"); },
        cancel: () => { canceled = true; },
      },
      0,
    )).rejects.toThrow("injected");
    expect(source.bytes).toEqual(new Uint8Array(72).fill(7));
    expect(entries["g0.seal"]!.len()).toBe(0);
    expect(canceled).toBe(file === "g0.seal" || (file === "g0.index" && fault === "failNextWrite"));
  });
});
