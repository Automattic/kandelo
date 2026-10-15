import { describe, expect, it } from "vitest";
import type { HostFileOffset } from "../src/types";
import type { PersistentOverlayStorage } from "../src/vfs/overlay-storage";
import {
  parseSealedGenerationSlot,
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
  it("accepts canonical numbered slots and rejects aliases or unsafe numbers", () => {
    expect(parseSealedGenerationSlot("g4")).toBe("g4");
    expect(parseSealedGenerationSlot("g5")).toBe("g5");
    for (const name of ["g04", "g-1", "g1.0", "g9007199254740991"]) {
      expect(parseSealedGenerationSlot(name)).toBeNull();
    }
  });

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
      listSlots: async () => [...new Set(Object.keys(entries)
        .map((name) => /^(g[0-9]+)\.(?:journal|index|seal)$/.exec(name)?.[1])
        .filter((slot): slot is string => slot !== undefined))],
      open: async (slot, file, create) => {
        const key = `${slot}.${file}`;
        if (create && entries[key] === undefined) entries[key] = new MemoryStorage();
        return entries[key] ?? null;
      },
      remove: async (slot, file) => { delete entries[`${slot}.${file}`]; },
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

  it("seals a bounded legacy conversion before mounting its indexed target", async () => {
    const sourceBytes = new Uint8Array(32 * 1024 * 1024);
    sourceBytes.set(new Uint8Array(32).fill(7), 8);
    const entries = { "legacy.journal": new MemoryStorage(sourceBytes) } as Record<string, MemoryStorage>;
    const originalBytes = entries["legacy.journal"]!.bytes;
    const enableCalls: number[] = [];
    const converted = await enableBestOverlayGeneration(files(entries), (journal, index, checkpointEnd) => {
      expect(journal).toBe(entries["g0.journal"]);
      expect(index).toBe(entries["g0.index"]);
      enableCalls.push(checkpointEnd!);
    }, true, (source, target, index) => {
      expect(source).toBe(entries["legacy.journal"]);
      target.writeAllAt(0, Uint8Array.of(1, 2, 3));
      index.writeAllAt(0, Uint8Array.of(4, 5, 6));
    });
    expect(converted.slot).toBe("g0");
    expect(converted.generation).toBe(1);
    expect(enableCalls).toEqual([3]);
    expect(await verifyOverlayGenerationSeal(
      entries["g0.journal"]!, entries["g0.seal"]!, sourceBytes.slice(8, 40), false, entries["g0.index"]!,
    )).toMatchObject({ generation: 1, source: { slot: "legacy", journalLength: sourceBytes.length } });
    expect(entries["legacy.journal"]!.bytes).toBe(originalBytes);
    expect(entries["legacy.journal"]!.len()).toBe(sourceBytes.length);
    expect(entries["legacy.journal"]!.closeCount).toBe(1);
  });

  it("upgrades one oversized sealed v1 generation without mounting its legacy index", async () => {
    const sourceBytes = new Uint8Array(32 * 1024 * 1024);
    sourceBytes.set(new Uint8Array(32).fill(7), 8);
    const sourceIndex = new Uint8Array(160);
    new DataView(sourceIndex.buffer).setUint32(4, 1, true);
    const entries: Record<string, MemoryStorage> = {
      "g0.journal": new MemoryStorage(sourceBytes),
      "g0.index": new MemoryStorage(sourceIndex),
      "g0.seal": new MemoryStorage(),
    };
    const original = entries["g0.journal"].bytes;
    const digest = sourceBytes.slice(8, 40);
    await writeOverlayGenerationSeal(entries["g0.journal"], entries["g0.seal"], 3, digest, entries["g0.index"]);
    const converted = await enableBestOverlayGeneration(files(entries), (journal, index, checkpointEnd) => {
      expect(journal).toBe(entries["g1.journal"]);
      expect(index).toBe(entries["g1.index"]);
      expect(checkpointEnd).toBe(3);
    }, true, (source, target, index) => {
      expect(source).toBe(entries["g0.journal"]);
      target.writeAllAt(0, Uint8Array.of(1, 2, 3));
      index.writeAllAt(0, Uint8Array.of(4, 5, 6));
    });
    expect(converted.slot).toBe("g1");
    expect(converted.generation).toBe(4);
    expect(entries["g0.journal"].bytes).toBe(original);
    expect(entries["g0.index"].closeCount).toBe(1);
    expect(entries["g0.journal"].closeCount).toBe(1);
    expect(await verifyOverlayGenerationSeal(
      entries["g1.journal"], entries["g1.seal"], digest, false, entries["g1.index"],
    )).toMatchObject({ generation: 4, source: { slot: "g0", journalLength: sourceBytes.length } });
  });

  it("upgrades an old index into a third slot without overwriting its valid fallback", async () => {
    const index = new Uint8Array(160);
    new DataView(index.buffer).setUint32(4, 1, true);
    const entries: Record<string, MemoryStorage> = {
      "g0.journal": new MemoryStorage(Uint8Array.of(1)),
      "g0.seal": new MemoryStorage(),
      "g1.journal": new MemoryStorage(new Uint8Array(32 * 1024 * 1024)),
      "g1.index": new MemoryStorage(index),
      "g1.seal": new MemoryStorage(),
    };
    const digest = new Uint8Array(32);
    await writeOverlayGenerationSeal(entries["g0.journal"], entries["g0.seal"], 1, digest);
    await writeOverlayGenerationSeal(entries["g1.journal"], entries["g1.seal"], 2, digest, entries["g1.index"]);
    const fallbackBytes = entries["g0.journal"].bytes;
    const sourceBytes = entries["g1.journal"].bytes;
    const selected = await enableBestOverlayGeneration(files(entries), (journal, checkpoint, checkpointEnd) => {
      expect(journal).toBe(entries["g2.journal"]);
      expect(checkpoint).toBe(entries["g2.index"]);
      expect(checkpointEnd).toBe(3);
    }, true, (source, target, checkpoint) => {
      expect(source).toBe(entries["g1.journal"]);
      target.writeAllAt(0, Uint8Array.of(1, 2, 3));
      checkpoint.writeAllAt(0, Uint8Array.of(4));
    });
    expect(selected.slot).toBe("g2");
    expect(selected.generation).toBe(3);
    expect(entries["g0.journal"].bytes).toBe(fallbackBytes);
    expect(entries["g1.journal"].bytes).toBe(sourceBytes);
    expect(await verifyOverlayGenerationSeal(
      entries["g2.journal"], entries["g2.seal"], digest, false, entries["g2.index"],
    )).toMatchObject({ generation: 3, source: { slot: "g1", journalLength: sourceBytes.length } });
    expect((await enableBestOverlayGeneration(files(entries), () => {})).slot).toBe("g2");
  });

  it("retries interrupted third-slot conversion while both prior generations remain sealed", async () => {
    const sourceBytes = new Uint8Array(32 * 1024 * 1024);
    const sourceIndex = new Uint8Array(160);
    new DataView(sourceIndex.buffer).setUint32(4, 2, true);
    const entries: Record<string, MemoryStorage> = {
      "g0.journal": new MemoryStorage(Uint8Array.of(1)),
      "g0.seal": new MemoryStorage(),
      "g1.journal": new MemoryStorage(sourceBytes),
      "g1.index": new MemoryStorage(sourceIndex),
      "g1.seal": new MemoryStorage(),
    };
    const digest = new Uint8Array(32);
    await writeOverlayGenerationSeal(entries["g0.journal"], entries["g0.seal"], 1, digest);
    await writeOverlayGenerationSeal(entries["g1.journal"], entries["g1.seal"], 2, digest, entries["g1.index"]);
    await expect(enableBestOverlayGeneration(files(entries), () => {}, true, (_source, target) => {
      target.writeAllAt(0, Uint8Array.of(1));
      throw new Error("interrupted third-slot conversion");
    })).rejects.toThrow("interrupted third-slot conversion");
    expect(entries["g2.seal"].len()).toBe(0);
    expect(entries["g0.journal"].len()).toBe(1);
    expect(entries["g1.journal"].len()).toBe(sourceBytes.length);
    const selected = await enableBestOverlayGeneration(files(entries), () => {}, true, (_source, target, checkpoint) => {
      target.writeAllAt(0, Uint8Array.of(1, 2));
      checkpoint.writeAllAt(0, Uint8Array.of(3));
    });
    expect(selected.slot).toBe("g2");
    expect(selected.generation).toBe(3);
  });

  it("converts a full three-slot legacy set without overwriting a fallback", async () => {
    const sourceBytes = new Uint8Array(32 * 1024 * 1024);
    const sourceIndex = new Uint8Array(160);
    new DataView(sourceIndex.buffer).setUint32(4, 1, true);
    const entries: Record<string, MemoryStorage> = {
      "g0.journal": new MemoryStorage(Uint8Array.of(1)),
      "g0.seal": new MemoryStorage(),
      "g1.journal": new MemoryStorage(Uint8Array.of(2)),
      "g1.seal": new MemoryStorage(),
      "g2.journal": new MemoryStorage(sourceBytes),
      "g2.index": new MemoryStorage(sourceIndex),
      "g2.seal": new MemoryStorage(),
    };
    const digest = new Uint8Array(32);
    for (const [slot, generation] of [["g0", 1], ["g1", 2]] as const) {
      await writeOverlayGenerationSeal(entries[`${slot}.journal`], entries[`${slot}.seal`], generation, digest);
    }
    await writeOverlayGenerationSeal(entries["g2.journal"], entries["g2.seal"], 3, digest, entries["g2.index"]);
    const originals = ["g0", "g1", "g2"].map((slot) => ({
      journal: entries[`${slot}.journal`].bytes,
      seal: entries[`${slot}.seal`].bytes,
    }));
    await expect(enableBestOverlayGeneration(files(entries), () => {}, true, () => {
      throw new Error("interrupted fourth-slot conversion");
    })).rejects.toThrow("interrupted fourth-slot conversion");
    expect(entries["g3.seal"]!.len()).toBe(0);
    for (const [position, slot] of ["g0", "g1", "g2"].entries()) {
      expect(entries[`${slot}.journal`].bytes).toBe(originals[position]!.journal);
      expect(entries[`${slot}.seal`].bytes).toBe(originals[position]!.seal);
    }
    const selected = await enableBestOverlayGeneration(files(entries), (journal) => {
      expect(journal).toBe(entries["g3.journal"]);
    }, true, (_source, target, checkpoint) => {
      target.writeAllAt(0, sourceBytes.subarray(0, 72));
      checkpoint.writeAllAt(0, Uint8Array.of(4));
    });
    expect(selected.slot).toBe("g3");
    expect(selected.generation).toBe(4);
    expect(await verifyOverlayGenerationSeal(
      entries["g3.journal"], entries["g3.seal"], digest, false, entries["g3.index"],
    )).toMatchObject({ generation: 4, source: { slot: "g2", journalLength: sourceBytes.length } });
    expect((await enableBestOverlayGeneration(files(entries), () => {})).slot).toBe("g3");
    const compacted = await compactOverlayGeneration(selected, files(entries), {
      prepare: (target) => { target.writeAllAt(0, (selected.journal as MemoryStorage).bytes); },
      checkpoint: (checkpoint) => { checkpoint.writeAllAt(0, Uint8Array.of(4)); },
      activate: () => {},
      cancel: () => { throw new Error("unexpected cancellation"); },
    }, 0);
    expect(compacted.slot).toBe("g0");
    expect((await enableBestOverlayGeneration(files(entries), () => {})).slot).toBe("g0");
  });

  it.each([4, 5])("converts beyond %i occupied slots without overwriting a verified fallback", async (occupiedCount) => {
    const oldIndex = new Uint8Array(160);
    new DataView(oldIndex.buffer).setUint32(4, 1, true);
    const entries: Record<string, MemoryStorage> = {};
    const digest = new Uint8Array(32);
    const occupiedSlots = Array.from({ length: occupiedCount }, (_, position) => `g${position}` as const);
    const targetSlot = `g${occupiedCount}` as const;
    for (const [position, slot] of occupiedSlots.entries()) {
      entries[`${slot}.journal`] = new MemoryStorage(
        position === occupiedCount - 1 ? new Uint8Array(32 * 1024 * 1024) : Uint8Array.of(position),
      );
      entries[`${slot}.seal`] = new MemoryStorage();
      entries[`${slot}.index`] = new MemoryStorage(position === occupiedCount - 1 ? oldIndex : Uint8Array.of(position));
      await writeOverlayGenerationSeal(
        entries[`${slot}.journal`], entries[`${slot}.seal`], position + 1, digest,
        entries[`${slot}.index`], position === 0 ? undefined
          : { slot: `g${position - 1}` as const, journalLength: entries[`g${position - 1}.journal`].len() },
      );
    }
    const seals = occupiedSlots.map((slot) => entries[`${slot}.seal`].bytes);
    await expect(enableBestOverlayGeneration(files(entries), () => {}, true, () => {
      throw new Error("conversion interrupted");
    })).rejects.toThrow("conversion interrupted");
    expect(entries[`${targetSlot}.seal`]!.len()).toBe(0);
    for (const [position, slot] of occupiedSlots.entries()) {
      expect(entries[`${slot}.seal`].bytes).toBe(seals[position]);
    }
    const selected = await enableBestOverlayGeneration(files(entries), () => {}, true, (source, target, index) => {
      target.writeAllAt(0, (source as MemoryStorage).bytes.subarray(0, 72));
      index.writeAllAt(0, Uint8Array.of(1));
    });
    expect(selected.slot).toBe(targetSlot);
    expect(selected.generation).toBe(occupiedCount + 1);
    for (const [position, slot] of occupiedSlots.entries()) {
      expect(entries[`${slot}.seal`].bytes).toBe(seals[position]);
    }
    expect((await enableBestOverlayGeneration(files(entries), () => {}, true)).slot).toBe(targetSlot);
    entries[`${targetSlot}.index`].bytes[0] ^= 1;
    expect((await enableBestOverlayGeneration(files(entries), () => {}, true)).slot)
      .toBe(occupiedSlots[occupiedSlots.length - 1]);
    entries[`${targetSlot}.index`].bytes[0] ^= 1;
    const compacted = await compactOverlayGeneration(selected, files(entries), {
      prepare: (target) => { target.writeAllAt(0, (selected.journal as MemoryStorage).bytes); },
      checkpoint: (index) => { index.writeAllAt(0, Uint8Array.of(2)); },
      activate: () => {},
      cancel: () => { throw new Error("unexpected cancellation"); },
    }, 0);
    expect(compacted.slot).toBe("g0");
    expect(compacted.generation).toBe(occupiedCount + 2);
    expect((await enableBestOverlayGeneration(files(entries), () => {}, true)).slot).toBe("g0");
  });

  it("retires older sealed slots only after activation while keeping its source fallback", async () => {
    const entries: Record<string, MemoryStorage> = {};
    const digest = new Uint8Array(32);
    for (let position = 0; position < 5; position++) {
      const slot = `g${position}`;
      entries[`${slot}.journal`] = new MemoryStorage(new Uint8Array(72).fill(position + 1));
      entries[`${slot}.index`] = new MemoryStorage(Uint8Array.of(position + 1));
      entries[`${slot}.seal`] = new MemoryStorage();
      await writeOverlayGenerationSeal(
        entries[`${slot}.journal`], entries[`${slot}.seal`], position + 1, digest,
        entries[`${slot}.index`], position === 0 ? undefined
          : { slot: `g${position - 1}` as const, journalLength: entries[`g${position - 1}.journal`].len() },
      );
    }
    const source = await enableBestOverlayGeneration(files(entries), () => {}, true);
    expect(source.slot).toBe("g4");
    const target = await compactOverlayGeneration(source, files(entries), {
      prepare: (storage) => { storage.writeAllAt(0, (source.journal as MemoryStorage).bytes); },
      checkpoint: (storage) => { storage.writeAllAt(0, Uint8Array.of(6)); },
      activate: () => {},
      cancel: () => { throw new Error("unexpected cancellation"); },
    }, 0);
    expect(target.slot).toBe("g0");
    for (const slot of ["g1", "g2", "g3"]) {
      for (const suffix of ["journal", "index", "seal"]) {
        expect(entries[`${slot}.${suffix}`]).toBeUndefined();
      }
    }
    expect(entries["g4.seal"]!.len()).toBeGreaterThan(0);
    expect((await enableBestOverlayGeneration(files(entries), () => {}, true)).slot).toBe("g0");
    entries["g0.index"]!.bytes[0] ^= 1;
    expect((await enableBestOverlayGeneration(files(entries), () => {}, true)).slot).toBe("g4");
  });

  it.each(["truncate", "flush", "remove"] as const)("keeps the active generation usable when retirement fails at %s", async (fault) => {
    const entries: Record<string, MemoryStorage> = {};
    const digest = new Uint8Array(32);
    for (let position = 0; position < 4; position++) {
      const slot = `g${position}`;
      entries[`${slot}.journal`] = new MemoryStorage(new Uint8Array(72).fill(position + 1));
      entries[`${slot}.index`] = new MemoryStorage(Uint8Array.of(position + 1));
      entries[`${slot}.seal`] = new MemoryStorage();
      await writeOverlayGenerationSeal(entries[`${slot}.journal`], entries[`${slot}.seal`], position + 1,
        digest, entries[`${slot}.index`]);
    }
    const originalSealLength = entries["g1.seal"]!.len();
    const storageFiles = files(entries);
    const remove = storageFiles.remove;
    storageFiles.remove = async (slot, file) => {
      if (fault === "remove" && slot === "g1" && file === "journal") throw new Error("injected removal failure");
      await remove(slot, file);
    };
    if (fault === "truncate") entries["g1.seal"]!.failNextTruncate = true;
    if (fault === "flush") entries["g1.seal"]!.failNextFlush = true;
    const source = await enableBestOverlayGeneration(storageFiles, () => {}, true);
    const failures: string[] = [];
    const target = await compactOverlayGeneration(source, storageFiles, {
      prepare: (storage) => { storage.writeAllAt(0, (source.journal as MemoryStorage).bytes); },
      checkpoint: (storage) => { storage.writeAllAt(0, Uint8Array.of(4)); },
      activate: () => {},
      cancel: () => { throw new Error("unexpected cancellation"); },
    }, 0, () => true, (error) => { failures.push(String(error)); });
    expect(target.slot).toBe("g0");
    expect(failures).toEqual([`Error: injected ${fault === "remove" ? "removal" : fault} failure`]);
    expect(entries["g1.seal"]!.len()).toBe(fault === "truncate" ? originalSealLength : 0);
    expect(entries["g1.journal"]).toBeDefined();
    expect((await enableBestOverlayGeneration(files(entries), () => {}, true)).slot).toBe("g0");
    entries["g0.index"]!.bytes[0] ^= 1;
    expect((await enableBestOverlayGeneration(files(entries), () => {}, true)).slot).toBe("g3");
  });

  it.each([true, false])("tries the source after a converted target is rejected (source valid: %s)", async (sourceValid) => {
    const sourceBytes = new Uint8Array(32 * 1024 * 1024);
    sourceBytes.set(new Uint8Array(32).fill(7), 8);
    const oldIndex = new Uint8Array(160);
    new DataView(oldIndex.buffer).setUint32(4, 1, true);
    const entries: Record<string, MemoryStorage> = {
      "g0.journal": new MemoryStorage(Uint8Array.of(1)),
      "g0.seal": new MemoryStorage(),
      "g1.journal": new MemoryStorage(Uint8Array.of(2)),
      "g1.seal": new MemoryStorage(),
      "g2.journal": new MemoryStorage(sourceBytes),
      "g2.index": new MemoryStorage(oldIndex),
      "g2.seal": new MemoryStorage(),
    };
    const digest = sourceBytes.slice(8, 40);
    for (const [slot, generation] of [["g0", 1], ["g1", 2]] as const) {
      await writeOverlayGenerationSeal(entries[`${slot}.journal`], entries[`${slot}.seal`], generation, digest);
    }
    await writeOverlayGenerationSeal(entries["g2.journal"], entries["g2.seal"], 3, digest, entries["g2.index"]);
    const originalSource = entries["g2.journal"].bytes;
    const selected = await enableBestOverlayGeneration(files(entries), (journal) => {
      if (journal === entries["g3.journal"]) throw new RejectedOverlayGenerationError("fixed", 5);
      if (journal === entries["g2.journal"] && !sourceValid) throw new RejectedOverlayGenerationError("fixed", 5);
      if (journal !== entries[sourceValid ? "g2.journal" : "g1.journal"]) {
        throw new Error("selected the wrong fallback");
      }
    }, true, (_source, target, checkpoint) => {
      target.writeAllAt(0, sourceBytes.subarray(0, 72));
      checkpoint.writeAllAt(0, Uint8Array.of(4));
    });
    expect(selected.slot).toBe(sourceValid ? "g2" : "g1");
    expect(entries["g3.seal"]!.len()).toBe(0);
    expect(entries["g2.journal"].bytes).toBe(originalSource);
  });

  it.each(["rejected", "stale"] as const)("reuses a %s higher slot before compaction can duplicate its generation", async (reason) => {
    const source = new MemoryStorage(new Uint8Array(72).fill(7));
    const entries: Record<string, MemoryStorage> = {
      "g2.journal": source,
      "g2.seal": new MemoryStorage(),
      "g3.journal": new MemoryStorage(new Uint8Array(72).fill(8)),
      "g3.index": new MemoryStorage(Uint8Array.of(1)),
      "g3.seal": new MemoryStorage(),
    };
    const digest = source.bytes.slice(8, 40);
    await writeOverlayGenerationSeal(source, entries["g2.seal"], 3, digest);
    await writeOverlayGenerationSeal(
      entries["g3.journal"], entries["g3.seal"], 4, digest,
      entries["g3.index"], { slot: "g2", journalLength: source.len() },
    );
    if (reason === "stale") source.writeAllAt(source.len(), Uint8Array.of(9));
    const selected = await enableBestOverlayGeneration(files(entries), (journal) => {
      if (journal === entries["g3.journal"] && reason === "rejected") {
        throw new RejectedOverlayGenerationError("fixed", 5);
      }
    }, true);
    expect(selected.slot).toBe("g2");
    const compacted = await compactOverlayGeneration(selected, files(entries), {
      prepare: (target) => { target.writeAllAt(0, source.bytes); },
      checkpoint: (index) => { index.writeAllAt(0, Uint8Array.of(1)); },
      activate: () => {},
      cancel: () => { throw new Error("unexpected cancellation"); },
    }, 0);
    expect(compacted.slot).toBe("g3");
    expect(compacted.generation).toBe(4);
    expect((await enableBestOverlayGeneration(files(entries), () => {}, true)).slot).toBe("g3");
  });

  it("retains later rejected slots across successive live compactions", async () => {
    const entries: Record<string, MemoryStorage> = {};
    const digest = new Uint8Array(32).fill(7);
    for (const [position, slot] of ["g0", "g1", "g2", "g3"].entries()) {
      entries[`${slot}.journal`] = new MemoryStorage(new Uint8Array(72).fill(7 + position));
      entries[`${slot}.seal`] = new MemoryStorage();
      await writeOverlayGenerationSeal(entries[`${slot}.journal`], entries[`${slot}.seal`], position + 1, digest);
    }
    let selected = await enableBestOverlayGeneration(files(entries), (journal) => {
      if (journal !== entries["g0.journal"]) throw new RejectedOverlayGenerationError("fixed", 5);
    }, true);
    expect(selected.slot).toBe("g0");
    for (const [position, slot] of ["g1", "g2", "g3"].entries()) {
      const source = selected;
      selected = await compactOverlayGeneration(source, files(entries), {
        prepare: (target) => { target.writeAllAt(0, (source.journal as MemoryStorage).bytes); },
        checkpoint: (index) => { index.writeAllAt(0, Uint8Array.of(1)); },
        activate: () => {},
        cancel: () => { throw new Error("unexpected cancellation"); },
      }, 0);
      expect(selected.slot).toBe(slot);
      expect(selected.generation).toBe(position + 2);
    }
    expect((await enableBestOverlayGeneration(files(entries), () => {}, true)).slot).toBe("g3");
  });

  it("retries an oversized legacy source when its converted target is rejected", async () => {
    const source = new MemoryStorage(new Uint8Array(32 * 1024 * 1024));
    const entries: Record<string, MemoryStorage> = { "legacy.journal": source };
    const originalSource = source.bytes;
    const selected = await enableBestOverlayGeneration(files(entries), (journal) => {
      if (journal !== source) throw new RejectedOverlayGenerationError("fixed", 5);
    }, true, (_source, target, checkpoint) => {
      target.writeAllAt(0, originalSource.subarray(0, 72));
      checkpoint.writeAllAt(0, Uint8Array.of(1));
    });
    expect(selected.slot).toBe("legacy");
    expect(source.bytes).toBe(originalSource);
    expect(entries["g0.seal"]!.len()).toBe(0);
  });

  it("forgets a rejected slot when legacy conversion overwrites it at another generation", async () => {
    const legacy = new MemoryStorage(new Uint8Array(32 * 1024 * 1024));
    const rejected = new MemoryStorage(new Uint8Array(72));
    const entries: Record<string, MemoryStorage> = {
      "legacy.journal": legacy,
      "g0.journal": rejected,
      "g0.seal": new MemoryStorage(),
    };
    const digest = new Uint8Array(32);
    await writeOverlayGenerationSeal(rejected, entries["g0.seal"], 2, digest);
    let targetAttempts = 0;
    const selected = await enableBestOverlayGeneration(files(entries), (journal) => {
      if (journal === rejected && targetAttempts++ === 0) {
        throw new RejectedOverlayGenerationError("fixed", 5);
      }
    }, true, (_source, target, checkpoint) => {
      target.writeAllAt(0, legacy.bytes.subarray(0, 72));
      checkpoint.writeAllAt(0, Uint8Array.of(1));
    });
    expect(selected.slot).toBe("g0");
    const compacted = await compactOverlayGeneration(selected, files(entries), {
      prepare: (target) => { target.writeAllAt(0, (selected.journal as MemoryStorage).bytes); },
      checkpoint: (index) => { index.writeAllAt(0, Uint8Array.of(1)); },
      activate: () => {},
      cancel: () => { throw new Error("unexpected cancellation"); },
    }, 0);
    expect(compacted.slot).toBe("g1");
    expect((await enableBestOverlayGeneration(files(entries), () => {}, true)).slot).toBe("g1");
  });

  it("replaces a semantically rejected slot after validating the older v1 source", async () => {
    const source = new Uint8Array(32 * 1024 * 1024);
    source.set(new Uint8Array(32).fill(7), 8);
    const oldIndex = new Uint8Array(160);
    new DataView(oldIndex.buffer).setUint32(4, 1, true);
    const entries: Record<string, MemoryStorage> = {
      "g0.journal": new MemoryStorage(source),
      "g0.index": new MemoryStorage(oldIndex),
      "g0.seal": new MemoryStorage(),
      "g1.journal": new MemoryStorage(Uint8Array.of(8, 9)),
      "g1.seal": new MemoryStorage(),
    };
    const digest = source.slice(8, 40);
    await writeOverlayGenerationSeal(entries["g0.journal"], entries["g0.seal"], 1, digest, entries["g0.index"]);
    await writeOverlayGenerationSeal(entries["g1.journal"], entries["g1.seal"], 2, digest);
    const original = entries["g0.journal"].bytes;
    const selected = await enableBestOverlayGeneration(files(entries), (journal) => {
      if (journal === entries["g1.journal"] && journal.len() === 2) {
        throw new RejectedOverlayGenerationError("fixed", 5);
      }
    }, true, (_source, target, index) => {
      target.writeAllAt(0, Uint8Array.of(1, 2, 3));
      index.writeAllAt(0, Uint8Array.of(4, 5, 6));
    });
    expect(selected.slot).toBe("g1");
    expect(selected.generation).toBe(2);
    expect(entries["g0.journal"].bytes).toBe(original);
    expect(entries["g1.journal"].bytes).toEqual(Uint8Array.of(1, 2, 3));
    expect(entries["g1.journal"].closeCount).toBe(1);
  });

  it("retries an interrupted sealed v1 upgrade from its unchanged source", async () => {
    const source = new Uint8Array(32 * 1024 * 1024);
    source.set(new Uint8Array(32).fill(7), 8);
    const oldIndex = new Uint8Array(160);
    new DataView(oldIndex.buffer).setUint32(4, 1, true);
    const entries: Record<string, MemoryStorage> = {
      "g0.journal": new MemoryStorage(source),
      "g0.index": new MemoryStorage(oldIndex),
      "g0.seal": new MemoryStorage(),
    };
    const digest = source.slice(8, 40);
    await writeOverlayGenerationSeal(entries["g0.journal"], entries["g0.seal"], 1, digest, entries["g0.index"]);
    const originalJournal = entries["g0.journal"].bytes;
    const originalIndex = entries["g0.index"].bytes;
    await expect(enableBestOverlayGeneration(files(entries), () => {}, true, (_source, target) => {
      target.writeAllAt(0, Uint8Array.of(1));
      throw new Error("conversion interrupted");
    })).rejects.toThrow("conversion interrupted");
    expect(entries["g0.journal"].bytes).toBe(originalJournal);
    expect(entries["g0.index"].bytes).toBe(originalIndex);
    expect(entries["g1.seal"].len()).toBe(0);
    const selected = await enableBestOverlayGeneration(files(entries), () => {}, true, (_source, target, index) => {
      target.writeAllAt(0, Uint8Array.of(1, 2));
      index.writeAllAt(0, Uint8Array.of(3));
    });
    expect(selected.slot).toBe("g1");
    expect(selected.generation).toBe(2);
  });

  it("closes both old handles after a sealed upgrade even if one close fails", async () => {
    const source = new Uint8Array(32 * 1024 * 1024);
    source.set(new Uint8Array(32).fill(7), 8);
    const oldIndex = new Uint8Array(160);
    new DataView(oldIndex.buffer).setUint32(4, 1, true);
    const entries: Record<string, MemoryStorage> = {
      "g0.journal": new MemoryStorage(source),
      "g0.index": new MemoryStorage(oldIndex),
      "g0.seal": new MemoryStorage(),
    };
    await writeOverlayGenerationSeal(entries["g0.journal"], entries["g0.seal"], 1,
      source.slice(8, 40), entries["g0.index"]);
    entries["g0.index"].failNextClose = true;
    await expect(enableBestOverlayGeneration(files(entries), () => {}, true, (_source, target, index) => {
      target.writeAllAt(0, Uint8Array.of(1));
      index.writeAllAt(0, Uint8Array.of(2));
    })).rejects.toThrow("persistent overlay generation cleanup failed");
    expect(entries["g0.index"].closeCount).toBe(1);
    expect(entries["g0.journal"].closeCount).toBe(1);
    expect(entries["g1.seal"].len()).toBeGreaterThan(0);
  });

  it("leaves a large legacy source intact after interrupted conversion and retries", async () => {
    const sourceBytes = new Uint8Array(32 * 1024 * 1024);
    const entries = { "legacy.journal": new MemoryStorage(sourceBytes) } as Record<string, MemoryStorage>;
    const originalBytes = entries["legacy.journal"]!.bytes;
    await expect(enableBestOverlayGeneration(files(entries), () => {
      throw new Error("unexpected mount");
    }, true, (_source, target) => {
      target.writeAllAt(0, Uint8Array.of(1));
      throw new Error("conversion interrupted");
    })).rejects.toThrow("conversion interrupted");
    expect(entries["legacy.journal"]!.bytes).toBe(originalBytes);
    expect(entries["legacy.journal"]!.len()).toBe(sourceBytes.length);
    expect(entries["g0.seal"]!.len()).toBe(0);
    const recovered = await enableBestOverlayGeneration(files(entries), () => {}, true, (_source, target, index) => {
      target.writeAllAt(0, Uint8Array.of(1, 2));
      index.writeAllAt(0, Uint8Array.of(3));
    });
    expect(recovered.slot).toBe("g0");
    expect(entries["g0.journal"]!.bytes).toEqual(Uint8Array.of(1, 2));
  });

  it("attempts every legacy conversion close after a failed write", async () => {
    const entries: Record<string, MemoryStorage> = {
      "legacy.journal": new MemoryStorage(new Uint8Array(32 * 1024 * 1024)),
    };
    await expect(enableBestOverlayGeneration(files(entries), () => {}, true, () => {
      entries["g0.index"]!.failNextClose = true;
      throw new Error("conversion write failed");
    })).rejects.toThrow("persistent overlay legacy conversion cleanup failed");
    expect(entries["legacy.journal"].len()).toBe(32 * 1024 * 1024);
    expect(entries["legacy.journal"].closeCount).toBe(1);
    expect(entries["g0.seal"].closeCount).toBe(1);
    expect(entries["g0.index"].closeCount).toBe(1);
    expect(entries["g0.journal"].closeCount).toBe(1);
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

  it("cycles three compaction slots and reopens a seal sourced from g2", async () => {
    const source = new MemoryStorage(new Uint8Array(72).fill(7));
    const entries: Record<string, MemoryStorage> = { "legacy.journal": source };
    let selected: Awaited<ReturnType<typeof compactOverlayGeneration>> = {
      journal: source, slot: "legacy", generation: 0, sealedLength: 0,
    };
    for (const expectedSlot of ["g0", "g1", "g2", "g0"] as const) {
      const previous = selected;
      selected = await compactOverlayGeneration(previous, files(entries), {
        prepare: (target) => { target.writeAllAt(0, (previous.journal as MemoryStorage).bytes); },
        checkpoint: (checkpoint) => { checkpoint.writeAllAt(0, Uint8Array.of(1)); },
        activate: () => {},
        cancel: () => { throw new Error("unexpected cancellation"); },
      }, 0);
      expect(selected.slot).toBe(expectedSlot);
      expect(selected.generation).toBe(previous.generation + 1);
    }
    expect((await enableBestOverlayGeneration(files(entries), () => {})).slot).toBe("g0");
    expect(await verifyOverlayGenerationSeal(
      entries["g0.journal"], entries["g0.seal"], source.bytes.slice(8, 40), false, entries["g0.index"],
    )).toMatchObject({ generation: 4, source: { slot: "g2", journalLength: 72 } });
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
