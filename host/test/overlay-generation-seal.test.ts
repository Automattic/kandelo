import { describe, expect, it } from "vitest";
import type { HostFileOffset } from "../src/types";
import type { PersistentOverlayStorage } from "../src/vfs/overlay-storage";
import {
  verifyOverlayGenerationSeal,
  writeOverlayGenerationSeal,
} from "../src/vfs/overlay-generation-seal";
import {
  enableBestOverlayGeneration,
  type OverlayGenerationFiles,
} from "../src/vfs/overlay-generation-selection";

class MemoryStorage implements PersistentOverlayStorage {
  bytes: Uint8Array;
  maxRead = 0;
  failFlush = false;

  constructor(bytes: Uint8Array = new Uint8Array()) {
    this.bytes = bytes.slice();
  }

  len(): number {
    return this.bytes.byteLength;
  }

  readExactAt(offset: HostFileOffset, destination: Uint8Array): void {
    const start = Number(offset);
    if (start < 0 || start + destination.byteLength > this.bytes.byteLength) throw new Error("short read");
    this.maxRead = Math.max(this.maxRead, destination.byteLength);
    destination.set(this.bytes.subarray(start, start + destination.byteLength));
  }

  writeAllAt(offset: HostFileOffset, source: Uint8Array): void {
    const start = Number(offset);
    const length = Math.max(this.bytes.byteLength, start + source.byteLength);
    const next = new Uint8Array(length);
    next.set(this.bytes);
    next.set(source, start);
    this.bytes = next;
  }

  flush(): void {
    if (this.failFlush) throw new Error("injected flush failure");
  }

  truncate(length: HostFileOffset): void {
    this.bytes = this.bytes.slice(0, Number(length));
  }

  close(): void {}
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
        throw new Error("kernel refused fixed rootfs persistence (errno 5)");
      }
    })).slot).toBe("legacy");
  });

  it("refuses a silent reset when only incomplete generation files remain", async () => {
    const entries = { "g0.journal": new MemoryStorage(Uint8Array.of(1)) };
    await expect(enableBestOverlayGeneration(files(entries), () => {}))
      .rejects.toThrow("refusing to reset");
    expect(Object.keys(entries)).toEqual(["g0.journal"]);
  });
});
