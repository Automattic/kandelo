import { describe, expect, it } from "vitest";
import type { HostFileOffset } from "../src/types";
import type { PersistentOverlayStorage } from "../src/vfs/overlay-storage";
import {
  verifyOverlayGenerationSeal,
  writeOverlayGenerationSeal,
} from "../src/vfs/overlay-generation-seal";

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
