import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { checkpointHeader, journalBytes } from "./fixtures/overlay-journal-header";
import { UnconfirmedOverlayActivationError, UnprovenOverlayActivationCleanupError } from "../src/vfs/overlay-generation-activation";
import { activationCodec, sealCodec, encodeOverlayActivation, nativeOverlayControlCall } from "./fixtures/native-overlay-activation";
import { createOverlayActivationCodec } from "../src/vfs/overlay-activation-codec";
import { ERRNO } from "../src/generated/abi";
import { OverlayGenerationMetadata, OVERLAY_GENERATION_BASE_BYTES } from "../src/vfs/overlay-generation-metadata";
import { StorageMemoryBudget, STORAGE_ENTRY_BYTES } from "../src/vfs/storage-memory-budget";
import type { HostFileOffset } from "../src/types";
import type { PersistentOverlayStorage } from "../src/vfs/overlay-storage";
import {
  digestOverlayStoragePrefix,
  verifyOverlayGenerationSeal,
  writeOverlayGenerationSeal,
} from "./fixtures/native-overlay-activation";
import { parseSealedGenerationSlot } from "../src/vfs/overlay-generation-seal";
import {
  collectBootOverlayGenerations,
  compactOverlayGeneration,
  compactOverlayGenerationForBoot,
  enableBestOverlayGeneration,
  LiveOverlayCompactor,
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
  maxLength = Number.MAX_SAFE_INTEGER;
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
    if (length > this.maxLength) throw Object.assign(new Error("injected quota exceeded"), { code: "ENOSPC" });
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
  it("reuses one bounded data buffer across each journal/index seal operation", async () => {
    const journal = new MemoryStorage(new Uint8Array(2 * 1024 * 1024 + 17).fill(7));
    const index = new MemoryStorage(new Uint8Array(1024 * 1024 + 3).fill(9));
    const seal = new MemoryStorage();
    const buffers = new Set<ArrayBufferLike>();
    for (const storage of [journal, index]) {
      const read = storage.readExactAt.bind(storage);
      storage.readExactAt = (offset, destination) => { buffers.add(destination.buffer); read(offset, destination); };
    }
    await writeOverlayGenerationSeal(journal, seal, 1, new Uint8Array(32), index);
    expect(buffers.size).toBe(1);
    buffers.clear();
    await verifyOverlayGenerationSeal(journal, seal, undefined, false, index);
    expect(buffers.size).toBe(1);
    buffers.clear();
    expect(digestOverlayStoragePrefix(journal, journal.len())).toEqual(
      new Uint8Array(createHash("sha256").update(journal.bytes).digest()),
    );
    expect(buffers.size).toBe(1);
  });
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
  it("closes every candidate handle when activation fingerprinting fails", async () => {
    const entries: Record<string, MemoryStorage> = {
      "g0.journal": new MemoryStorage(journalBytes()),
      "g0.index": new MemoryStorage(checkpointHeader()),
      "g0.seal": new MemoryStorage(),
    };
    const journal = entries["g0.journal"]!;
    const index = entries["g0.index"]!;
    const seal = entries["g0.seal"]!;
    await writeOverlayGenerationSeal(journal, seal, 1, new Uint8Array(32).fill(7), index);
    const original = Object.fromEntries(Object.entries(entries).map(([name, storage]) => [name, storage.bytes.slice()]));
    const failure = new Error("injected activation fingerprint read failure");
    const read = seal.readExactAt.bind(seal);
    let fingerprintReads = 0;
    seal.readExactAt = (offset, destination) => {
      if (Number(offset) === 0 && destination.byteLength === seal.len()) {
        fingerprintReads++;
        throw failure;
      }
      read(offset, destination);
    };
    let enabled = false;
    await expect(enableBestOverlayGeneration(files(entries), () => { enabled = true; }, true)).rejects.toBe(failure);
    expect(fingerprintReads).toBe(1);
    expect(enabled).toBe(false);
    expect(Object.keys(entries)).toEqual(Object.keys(original));
    for (const [name, storage] of Object.entries(entries)) {
      expect(storage.bytes).toEqual(original[name]);
      expect(storage.closeCount, name).toBe(1);
    }
  });

  it.each(["magic", "version"] as const)("rejects a resealed invalid %s index header before publishing activation", async damage => {
    const index = checkpointHeader();
    index[damage === "magic" ? 0 : 4]! ^= 8;
    if (damage === "version") index.set(createHash("sha256").update(index.subarray(0, 128)).digest(), 128);
    const entries: Record<string, MemoryStorage> = {
      "g0.journal": new MemoryStorage(journalBytes(32 * 1024 * 1024, 0)),
      "g0.index": new MemoryStorage(index), "g0.seal": new MemoryStorage(),
    };
    await writeOverlayGenerationSeal(entries["g0.journal"]!, entries["g0.seal"]!, 1, new Uint8Array(32), entries["g0.index"]!);
    const names = Object.keys(entries);
    const journal = entries["g0.journal"]!.bytes;
    let enabled = false;
    let converted = false;
    await expect(enableBestOverlayGeneration(files(entries), () => { enabled = true; }, true,
      () => { converted = true; })).rejects.toBeInstanceOf(NoValidOverlayGenerationError);
    expect(enabled).toBe(false);
    expect(converted).toBe(false);
    expect(Object.keys(entries)).toEqual(names);
    expect(entries["g0.journal"]!.bytes).toBe(journal);
    expect(entries["g0.index"]!.bytes).toEqual(index);
  });

  it("refuses damaged or incomplete unsealed headers before publishing any activation", async () => {
    const pristine = journalBytes();
    const damaged = [pristine.subarray(0, 1), pristine.subarray(0, 40), pristine.subarray(0, 71)];
    for (let offset = 0; offset < pristine.length; offset++) {
      const bytes = pristine.slice();
      bytes[offset]! ^= 1;
      damaged.push(bytes);
    }
    for (const bytes of damaged) {
      const journal = new MemoryStorage(bytes);
      const entries = { "legacy.journal": journal } as Record<string, MemoryStorage>;
      let enabled = false;
      await expect(enableBestOverlayGeneration(files(entries), () => { enabled = true; }, true))
        .rejects.toBeInstanceOf(NoValidOverlayGenerationError);
      expect(enabled).toBe(false);
      expect(Object.keys(entries)).toEqual(["legacy.journal"]);
      expect(journal.bytes).toEqual(bytes);
      expect(journal.closeCount).toBe(1);
    }
  });

  it("keeps journal-header resource refusals and read failures distinct from corruption", async () => {
    for (const operation of ["length", "digest", "read"] as const) {
      const failure = Object.assign(new Error("header admission refused"), { code: "ENOMEM", errno: ERRNO.ENOMEM });
      const journal = new MemoryStorage(journalBytes());
      const original = journal.bytes.slice();
      const entries = { "legacy.journal": journal } as Record<string, MemoryStorage>;
      const backend = files(entries);
      if (operation === "read") journal.readExactAt = () => { throw failure; };
      const refused: OverlayGenerationFiles = { ...backend, sealCodec: { ...sealCodec,
        ...(operation === "length" ? { journalHeaderLength: () => { throw failure; } } : {}),
        ...(operation === "digest" ? { journalBaseDigest: () => { throw failure; } } : {}),
      } };
      await expect(enableBestOverlayGeneration(refused, () => { throw new Error("unexpected mount"); }, true)).rejects.toBe(failure);
      expect(Object.keys(entries)).toEqual(["legacy.journal"]);
      expect(journal.bytes).toEqual(original);
      expect(journal.closeCount).toBe(1);
    }
  });

  it("bounds streamed discovery before opening journals and closes the iterator on refusal", async () => {
    const budget = new StorageMemoryBudget(128 * 1024);
    const metadata = new OverlayGenerationMetadata(budget);
    const journal = new MemoryStorage(journalBytes());
    const original = journal.bytes.slice();
    const backend = files({ "legacy.journal": journal });
    let opened = 0;
    let produced = 0;
    let closed = false;
    const storage: OverlayGenerationFiles = {
      ...backend, metadata,
      async *listSlots() {
        try {
          for (let index = 4; index < 10000; index++) { produced++; yield `g${index}`; }
        } finally { closed = true; }
      },
      open: (...arguments_) => { if (!arguments_[1].startsWith("activation")) opened++; return backend.open(...arguments_); },
    };
    await expect(enableBestOverlayGeneration(storage, () => {}, true)).rejects.toMatchObject({ code: "ENOMEM" });
    expect(produced).toBeLessThan(10);
    expect(closed).toBe(true);
    expect(opened).toBe(0);
    expect(journal.bytes).toEqual(original);
    expect(budget.used).toBe(OVERLAY_GENERATION_BASE_BYTES);
    storage.listSlots = async () => [];
    const selected = await enableBestOverlayGeneration(storage, () => {}, true);
    expect(selected.slot).toBe("legacy");
    selected.journal.close();
    metadata.dispose();
    expect(budget.used).toBe(0);
  });

  it("refuses new compaction bookkeeping before opening or changing its target", async () => {
    const budget = new StorageMemoryBudget(OVERLAY_GENERATION_BASE_BYTES + 16 * STORAGE_ENTRY_BYTES + 4);
    const metadata = new OverlayGenerationMetadata(budget);
    const source = new MemoryStorage(journalBytes());
    const original = source.bytes.slice();
    const entries = { "g3.journal": source };
    const backend = files(entries);
    let opened = 0;
    let prepared = false;
    const storage: OverlayGenerationFiles = {
      ...backend, metadata,
      open: (...arguments_) => { opened++; return backend.open(...arguments_); },
    };
    await expect(compactOverlayGeneration({
      journal: source, slot: "g3", generation: 4, sealedLength: 0,
    }, storage, {
      prepare: () => { prepared = true; }, checkpoint: () => {}, activate: () => {}, fail: () => {}, cancel: () => {},
    }, 0)).rejects.toMatchObject({ code: "ENOMEM" });
    expect(prepared).toBe(false);
    expect(opened).toBe(0);
    expect(source.bytes).toEqual(original);
    expect(Object.keys(entries)).toEqual(["g3.journal"]);
    expect(budget.used).toBe(OVERLAY_GENERATION_BASE_BYTES);
    metadata.dispose();
    expect(budget.used).toBe(0);
  });
  function files(entries: Record<string, MemoryStorage>): OverlayGenerationFiles {
    return {
      activationCodec,
      sealCodec,
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

  async function setActiveGeneration(entries: Record<string, MemoryStorage>, slot: "legacy" | `g${number}`, generation: number): Promise<void> {
    const journal = entries[`${slot}.journal`]!;
    const seal = entries[`${slot}.seal`];
    const verified = slot === "legacy" ? null
      : await verifyOverlayGenerationSeal(journal, seal!, undefined, true, entries[`${slot}.index`]);
    const previous = entries["legacy.activation0"];
    const sequence = previous === undefined ? 1 : Number(new DataView(previous.bytes.buffer,
      previous.bytes.byteOffset, previous.bytes.byteLength).getBigUint64(8, true)) + 1;
    const record = encodeOverlayActivation({ sequence, slot, generation,
      baseDigest: verified?.baseDigest ?? journal.bytes.slice(8, 40),
      sealDigest: verified === null ? new Uint8Array(32) : new Uint8Array(createHash("sha256").update(seal!.bytes).digest()),
    });
    entries["legacy.activation0"] = new MemoryStorage(record);
    entries["legacy.activation1"] = new MemoryStorage(record);
  }

  async function reclamationFixture() {
    const entries: Record<string, MemoryStorage> = {
      "g2.journal": new MemoryStorage(journalBytes()), "g2.seal": new MemoryStorage(),
      "g3.journal": new MemoryStorage(journalBytes()), "g3.seal": new MemoryStorage(), "g3.index": new MemoryStorage(Uint8Array.of(1)),
      "g4.journal": new MemoryStorage(Uint8Array.of(7, 8, 9)),
    };
    const digest = entries["g3.journal"]!.bytes.slice(8, 40);
    await writeOverlayGenerationSeal(entries["g2.journal"]!, entries["g2.seal"]!, 3, digest);
    await writeOverlayGenerationSeal(entries["g3.journal"]!, entries["g3.seal"]!, 4, digest, entries["g3.index"],
      { slot: "g2", journalLength: entries["g2.journal"]!.len() });
    await setActiveGeneration(entries, "g3", 4);
    const backend = files(entries);
    const selected = await enableBestOverlayGeneration(backend, () => {}, true);
    return { entries, backend, selected };
  }

  for (const errno of [ERRNO.ENOMEM, ERRNO.ENOSYS]) {
    it(`native unpublished reclamation refusal ${errno} leaves the candidate untouched`, async () => {
      const { entries, backend, selected } = await reclamationFixture();
      const bytes = entries["g4.journal"]!.bytes.slice();
      let refusals = 0;
      const storage = { ...backend, activationCodec: createOverlayActivationCodec((operation, input) => {
        if (operation === 25 && new DataView(input.buffer, input.byteOffset, input.byteLength).getFloat64(288, true) === 0) {
          refusals++;
          return -errno;
        }
        return nativeOverlayControlCall(operation, input);
      }) };
      await expect(collectBootOverlayGenerations(selected, storage)).rejects.toMatchObject({ errno });
      expect(refusals).toBe(1);
      expect(entries["g4.journal"]!.bytes).toEqual(bytes);
      selected.journal.close();
      selected.index?.close();
    });
  }

  it("boot reclamation retains uncertain control closure and refuses any later storage acquisition", async () => {
    const { entries, backend, selected } = await reclamationFixture();
    const metadata = new OverlayGenerationMetadata();
    const failures: unknown[] = [];
    let opens = 0;
    const storage = { ...backend, metadata, open: (...arguments_: Parameters<OverlayGenerationFiles["open"]>) => {
      opens++;
      return backend.open(...arguments_);
    } };
    const beforeClose = entries["legacy.activation0"]!.closeCount;
    entries["legacy.activation0"]!.failNextClose = true;
    await collectBootOverlayGenerations(selected, storage, error => failures.push(error));
    expect(failures).toHaveLength(1);
    expect(entries["legacy.activation0"]!.closeCount).toBe(beforeClose + 1);
    const beforeRetry = opens;
    await expect(collectBootOverlayGenerations(selected, storage)).rejects.toThrow("storage retirement is unproven");
    expect(opens).toBe(beforeRetry);
    expect(entries["legacy.activation0"]!.closeCount).toBe(beforeClose + 1);
    expect(() => metadata.dispose()).toThrow("storage retirement is unproven");
    selected.journal.close();
    selected.index?.close();
  });

  it("reclamation refusal after activation keeps the usable target and its owned handles", async () => {
    const { entries, backend, selected } = await reclamationFixture();
    const bytes = entries["g4.journal"]!.bytes.slice();
    const failures: unknown[] = [];
    const storage = { ...backend, activationCodec: createOverlayActivationCodec((operation, input) =>
      operation === 25 && new DataView(input.buffer, input.byteOffset, input.byteLength).getFloat64(288, true) === 0
        ? -ERRNO.ENOMEM : nativeOverlayControlCall(operation, input)) };
    const active = await compactOverlayGeneration(selected, storage, {
      prepare: target => target.writeAllAt(0, (selected.journal as MemoryStorage).bytes),
      checkpoint: index => index.writeAllAt(0, Uint8Array.of(1)), activate: () => {}, cancel: () => {}, fail: () => {},
    }, 0, () => true, error => failures.push(error));
    expect(active.slot).toBe("g0");
    expect(active.generation).toBe(5);
    expect(failures).toHaveLength(1);
    expect(entries["g4.journal"]!.bytes).toEqual(bytes);
    expect(entries["g0.journal"]!.closeCount).toBe(0);
    expect(entries["g0.index"]!.closeCount).toBe(0);
    active.journal.close();
    active.index?.close();
    const reopened = await enableBestOverlayGeneration(backend, () => {}, true);
    expect(reopened.slot).toBe("g0");
    expect(reopened.generation).toBe(5);
    reopened.journal.close();
    reopened.index?.close();
  });

  it("quarantines an unproven activation close before any further storage acquisition", async () => {
    const budget = new StorageMemoryBudget(256 * 1024);
    const metadata = new OverlayGenerationMetadata(budget);
    const entries: Record<string, MemoryStorage> = { "legacy.journal": new MemoryStorage(journalBytes()) };
    await setActiveGeneration(entries, "legacy", 0);
    entries["legacy.activation0"]!.failNextClose = true;
    const backend = files(entries);
    let opens = 0;
    const storage: OverlayGenerationFiles = { ...backend, metadata,
      open: (...arguments_) => { opens++; return backend.open(...arguments_); },
    };
    const failures: unknown[] = [];
    const selected = await enableBestOverlayGeneration(storage, () => {}, true, undefined, error => { failures.push(error); });
    expect(selected.slot).toBe("legacy");
    expect(failures).toHaveLength(1);
    const before = opens;
    await expect(enableBestOverlayGeneration(storage, () => {}, true)).rejects.toThrow("storage retirement is unproven");
    expect(opens).toBe(before);
    expect(() => metadata.dispose()).toThrow("storage retirement is unproven");
    expect(budget.used).toBeGreaterThan(OVERLAY_GENERATION_BASE_BYTES);
    expect(entries["legacy.activation0"]!.closeCount).toBe(1);
    selected.journal.close();
  });

  it("retains failed-open control cleanup without retrying an uncertain descriptor close", async () => {
    const metadata = new OverlayGenerationMetadata();
    const entries: Record<string, MemoryStorage> = { "legacy.journal": new MemoryStorage(journalBytes()) };
    await setActiveGeneration(entries, "legacy", 0);
    entries["legacy.activation0"]!.failNextClose = true;
    const backend = files(entries);
    let opens = 0;
    const storage: OverlayGenerationFiles = { ...backend, metadata,
      open: (slot, file, create) => {
        opens++;
        if (file === "activation1") throw new Error("second control open failed");
        return backend.open(slot, file, create);
      },
    };
    await expect(enableBestOverlayGeneration(storage, () => {}, true)).rejects.toBeInstanceOf(UnprovenOverlayActivationCleanupError);
    const before = opens;
    await expect(enableBestOverlayGeneration(storage, () => {}, true)).rejects.toThrow("storage retirement is unproven");
    expect(opens).toBe(before);
    expect(entries["legacy.activation0"]!.closeCount).toBe(1);
    expect(() => metadata.dispose()).toThrow("storage retirement is unproven");
  });

  it("drains a stopped live compaction that is still opening its target", async () => {
    const source = new MemoryStorage(journalBytes());
    const entries: Record<string, MemoryStorage> = { "legacy.journal": source };
    const storage = files(entries);
    let reachedOpen!: () => void;
    let releaseOpen!: () => void;
    const reached = new Promise<void>((resolve) => { reachedOpen = resolve; });
    const opening = new Promise<void>((resolve) => { releaseOpen = resolve; });
    const compactor = new LiveOverlayCompactor(
      { journal: source, slot: "legacy", generation: 0, sealedLength: 0 },
      { ...storage, open: async (slot, file, create) => {
        const result = await storage.open(slot, file, create);
        if (file === "journal") { reachedOpen(); await opening; }
        return result;
      } },
      {
        prepare: () => { throw new Error("stopped compaction must not prepare"); },
        checkpoint: () => { throw new Error("stopped compaction must not checkpoint"); },
        activate: () => { throw new Error("stopped compaction must not activate"); },
        fail: () => {}, cancel: () => { throw new Error("unprepared compaction must not cancel"); },
      },
      () => { throw new Error("unactivated target must not be published"); },
      (error) => { throw error; },
      0,
    );
    const running = compactor.compactIfNeeded();
    await reached;
    const stopped = Promise.resolve(compactor.stop()).then(() =>
      ["journal", "index", "seal"].map((kind) => entries[`g0.${kind}`]?.closeCount ?? 0));
    releaseOpen();
    const closed = await stopped;
    await running;
    expect(closed).toEqual([1, 1, 1]);
    expect(source.closeCount).toBe(0);
    await compactor.compactIfNeeded();
    expect(entries["g0.journal"]!.closeCount).toBe(1);
  });

  it("poisons a live writer before a queued syscall continuation after failed activation publication", async () => {
    const source = new MemoryStorage(journalBytes());
    const entries: Record<string, MemoryStorage> = { "legacy.journal": source };
    const backend = files(entries);
    const selected = await enableBestOverlayGeneration(backend, () => {}, true);
    const events: string[] = [];
    let activated = false;
    let poisoned = false;
    let acknowledged = false;
    const storage: OverlayGenerationFiles = {
      ...backend,
      open: async (slot, file, create) => {
        const handle = await backend.open(slot, file, create);
        if (handle !== null && file === "activation0") {
          const write = handle.writeAllAt.bind(handle);
          handle.writeAllAt = (offset, bytes) => {
            if (activated) throw new Error("activation publication failed");
            write(offset, bytes);
          };
        }
        return handle;
      },
    };
    const compactor = new LiveOverlayCompactor(selected, storage, {
      prepare: target => { target.writeAllAt(0, source.bytes); },
      checkpoint: index => { index.writeAllAt(0, Uint8Array.of(1)); },
      activate: () => {
        activated = true;
        queueMicrotask(() => { events.push("continuation"); if (!poisoned) acknowledged = true; });
      },
      cancel: () => { throw new Error("uncertain activation must not cancel"); },
      fail: error => { expect(error).toBeInstanceOf(UnconfirmedOverlayActivationError); poisoned = true; events.push("poison"); },
    }, () => { throw new Error("unconfirmed generation must not publish"); }, error => {
      expect(error).toBeInstanceOf(UnconfirmedOverlayActivationError);
      events.push("observer");
    }, 0);
    await compactor.compactIfNeeded();
    expect(events).toEqual(["poison", "continuation", "observer"]);
    expect(acknowledged).toBe(false);
    await compactor.compactIfNeeded();
    expect(events).toHaveLength(3);
    activated = false;
    expect((await enableBestOverlayGeneration(backend, () => {}, true)).slot).toBe("legacy");
  });

  it("drains activated live compaction cleanup before shutdown closes the selected journal", async () => {
    const legacy = new MemoryStorage(journalBytes());
    const source = new MemoryStorage(legacy.bytes);
    const entries: Record<string, MemoryStorage> = {
      "legacy.journal": legacy, "g0.journal": source,
      "g0.seal": new MemoryStorage(),
    };
    await writeOverlayGenerationSeal(source, entries["g0.seal"], 1, source.bytes.slice(8, 40));
    const closeSource = source.close.bind(source);
    source.close = () => {
      if (source.closeCount !== 0) throw new Error("shutdown closed a retired journal");
      closeSource();
    };
    const storage = files(entries);
    let reachedCleanup!: () => void;
    let releaseCleanup!: () => void;
    const reached = new Promise<void>((resolve) => { reachedCleanup = resolve; });
    const cleanup = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    let active: ConstructorParameters<typeof LiveOverlayCompactor>[0];
    const selected = {
      journal: source, slot: "g0" as const, generation: 1, sealedLength: 0,
      source: { slot: "legacy" as const, journalLength: legacy.len(),
        journalDigest: digestOverlayStoragePrefix(legacy, legacy.len()) },
    };
    active = selected;
    const compactor = new LiveOverlayCompactor(selected, {
      ...storage,
      open: async (slot, file, create) => {
        const result = await storage.open(slot, file, create);
        if (slot === "legacy" && file === "journal") { reachedCleanup(); await cleanup; }
        return result;
      },
    }, {
      prepare: (target) => { target.writeAllAt(0, source.bytes); },
      checkpoint: (index) => { index.writeAllAt(0, Uint8Array.of(1, 2, 3)); },
      activate: () => {},
      fail: () => {}, cancel: () => { throw new Error("activated compaction must not cancel"); },
    }, (next) => { active = next; }, (error) => { throw error; }, 0);
    const running = compactor.compactIfNeeded();
    await reached;
    expect(source.closeCount).toBe(1);
    const shutdown = Promise.resolve(compactor.stop()).then(() => { active.journal.close(); });
    const shutdownAssertion = expect(shutdown).resolves.toBeUndefined();
    releaseCleanup();
    await Promise.all([running, shutdownAssertion]);
    expect(active.slot).toBe("g1");
    expect(entries["g1.journal"]!.closeCount).toBe(1);
    expect(source.closeCount).toBe(1);
    expect(entries["legacy.journal"]).toBeUndefined();
  });

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

  for (const order of [["g0", "g1", "g2"], ["g0", "g2", "g1"], ["g1", "g0", "g2"],
    ["g1", "g2", "g0"], ["g2", "g0", "g1"], ["g2", "g1", "g0"]]) {
    it(`native selection is independent of directory enumeration ${order.join("/")}`, async () => {
      const entries: Record<string, MemoryStorage> = {};
      const generations = [2, 3, 1];
      for (let index = 0; index < generations.length; index++) {
        const journal = new MemoryStorage(Uint8Array.of(index + 1));
        const seal = new MemoryStorage();
        entries[`g${index}.journal`] = journal;
        entries[`g${index}.seal`] = seal;
        await writeOverlayGenerationSeal(journal, seal, generations[index]!, new Uint8Array(32));
      }
      let comparisons = 0;
      const backend: OverlayGenerationFiles = { ...files(entries), listSlots: () => order,
        activationCodec: { ...activationCodec, compareGenerations: (...arguments_) => {
          comparisons++;
          return activationCodec.compareGenerations(...arguments_);
        } },
      };
      const selected = await enableBestOverlayGeneration(backend, () => {});
      expect(selected.slot).toBe("g1");
      expect(selected.generation).toBe(3);
      expect(comparisons).toBeGreaterThan(0);
      selected.journal.close();
      for (const slot of order) expect(entries[`${slot}.journal`]!.closeCount).toBe(1);
    });
  }

  for (const errno of [ERRNO.ENOMEM, ERRNO.ENOSYS]) {
    it(`native staging refusal ${errno} cannot create or truncate a target`, async () => {
      const source = new MemoryStorage(journalBytes());
      const bytes = source.bytes.slice();
      const entries = { "legacy.journal": source };
      let targetOpens = 0;
      let prepares = 0;
      const backend = files(entries);
      const storage: OverlayGenerationFiles = { ...backend,
        activationCodec: createOverlayActivationCodec((operation, input) => operation === 24 ? -errno : nativeOverlayControlCall(operation, input)),
        open: (slot, file, create) => {
          if (slot !== "legacy" && create) targetOpens++;
          return backend.open(slot, file, create);
        },
      };
      await expect(compactOverlayGeneration({ journal: source, slot: "legacy", generation: 0, sealedLength: 0 }, storage,
        { prepare: () => { prepares++; }, checkpoint: () => {}, activate: () => {}, cancel: () => {}, fail: () => {} }, 0))
        .rejects.toMatchObject({ errno });
      expect(prepares).toBe(0);
      expect(targetOpens).toBe(0);
      expect(source.bytes).toEqual(bytes);
    });
  }

  it("native staging skips a protected predecessor occupying the next ring slot", async () => {
    const source = new MemoryStorage(journalBytes());
    const protectedJournal = new MemoryStorage(Uint8Array.of(7, 8, 9));
    const protectedBytes = protectedJournal.bytes.slice();
    const entries: Record<string, MemoryStorage> = { "g0.journal": source, "g0.seal": new MemoryStorage(),
      "g0.index": new MemoryStorage(Uint8Array.of(1)), "g1.journal": protectedJournal };
    await writeOverlayGenerationSeal(source, entries["g0.seal"]!, 3, source.bytes.slice(8, 40), entries["g0.index"],
      { slot: "g1", journalLength: 3 });
    let preparedTarget: PersistentOverlayStorage | undefined;
    const selected = await compactOverlayGeneration({ journal: source, index: entries["g0.index"], slot: "g0", generation: 3, sealedLength: 0,
      source: { slot: "g1", journalLength: 3 }, knownGenerations: new Map([["g0", 3], ["g1", 2]]) }, files(entries), {
      prepare: target => { preparedTarget = target; target.writeAllAt(0, source.bytes); },
      checkpoint: index => index.writeAllAt(0, Uint8Array.of(1)), activate: () => {}, cancel: () => {}, fail: () => {},
    }, 0);
    expect(selected.slot).toBe("g2");
    expect(preparedTarget).toBe(entries["g2.journal"]);
    expect(protectedJournal.bytes).toEqual(protectedBytes);
    selected.journal.close();
    selected.index?.close();
  });

  it("native ordering failure cannot enable an older source or publish recovery authority", async () => {
    const entries: Record<string, MemoryStorage> = {};
    for (let index = 0; index < 2; index++) {
      const journal = new MemoryStorage(Uint8Array.of(index + 1));
      const seal = new MemoryStorage();
      entries[`g${index}.journal`] = journal;
      entries[`g${index}.seal`] = seal;
      await writeOverlayGenerationSeal(journal, seal, index + 1, new Uint8Array(32));
    }
    const originalKeys = Object.keys(entries);
    let enabled = 0;
    const storage: OverlayGenerationFiles = { ...files(entries),
      activationCodec: createOverlayActivationCodec((operation, input) => operation === 21 ? -ERRNO.ENOMEM : nativeOverlayControlCall(operation, input)),
    };
    await expect(enableBestOverlayGeneration(storage, () => { enabled++; })).rejects.toMatchObject({ errno: ERRNO.ENOMEM });
    expect(enabled).toBe(0);
    expect(Object.keys(entries)).toEqual(originalKeys);
    expect(entries["g0.journal"]!.closeCount).toBe(1);
    expect(entries["g1.journal"]!.closeCount).toBe(1);
  });

  it("failed compaction of an extra-slot generation preserves its source and protected predecessor", async () => {
    const source = new MemoryStorage(journalBytes());
    const predecessor = new MemoryStorage(journalBytes());
    const entries: Record<string, MemoryStorage> = { "g3.journal": source, "g3.seal": new MemoryStorage(), "g3.index": new MemoryStorage(Uint8Array.of(1)),
      "g0.journal": predecessor, "g0.seal": new MemoryStorage() };
    const digest = source.bytes.slice(8, 40);
    await writeOverlayGenerationSeal(predecessor, entries["g0.seal"]!, 3, digest);
    await writeOverlayGenerationSeal(source, entries["g3.seal"]!, 4, digest, entries["g3.index"],
      { slot: "g0", journalLength: predecessor.len() });
    await setActiveGeneration(entries, "g3", 4);
    const original = source.bytes.slice();
    const protectedBytes = predecessor.bytes.slice();
    const selected = await enableBestOverlayGeneration(files(entries), () => {}, true);
    let target: PersistentOverlayStorage | undefined;
    let canceled = 0;
    await expect(compactOverlayGeneration(selected, files(entries), {
      prepare: destination => { target = destination; destination.writeAllAt(0, source.bytes); },
      checkpoint: () => { throw new Error("injected target checkpoint failure"); },
      activate: () => { throw new Error("unexpected activation"); }, cancel: () => { canceled++; }, fail: () => {},
    }, 0)).rejects.toThrow("injected target checkpoint failure");
    expect(target).toBe(entries["g1.journal"]);
    expect(canceled).toBe(1);
    expect(source.bytes).toEqual(original);
    expect(predecessor.bytes).toEqual(protectedBytes);
    selected.journal.close();
    const recovered = await enableBestOverlayGeneration(files(entries), () => {}, true);
    expect(recovered.slot).toBe("g3");
    expect(recovered.generation).toBe(4);
    recovered.journal.close();
  });

  it("recovers a controlled source beside a torn unpublished target but never falls back after active rejection", async () => {
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
    await expect(enableBestOverlayGeneration(files(entries), () => {})).rejects.toBeInstanceOf(NoValidOverlayGenerationError);
    await setActiveGeneration(entries, "g0", 1);
    expect((await enableBestOverlayGeneration(files(entries), () => {})).slot).toBe("g0");
    entries["g1.seal"]!.truncate(0);
    await expect(enableBestOverlayGeneration(files(entries), (journal) => {
      if (journal === entries["g0.journal"]) {
        throw new RejectedOverlayGenerationError("fixed", 5);
      }
    })).rejects.toBeInstanceOf(NoValidOverlayGenerationError);
  });

  it.each(["fixed", "resizable"] as const)("refuses older fallback from a semantically corrupt %s generation", async (mode) => {
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
    await expect(enableBestOverlayGeneration(files(entries), (journal) => {
      attempts.push(journal === entries["g1.journal"] ? 2 : 1);
      if (journal === entries["g1.journal"]) throw new RejectedOverlayGenerationError(mode, 5);
    })).rejects.toBeInstanceOf(NoValidOverlayGenerationError);
    expect(attempts).toEqual([2]);
    await expect(enableBestOverlayGeneration(files(entries), (journal) => {
      if (journal === entries["g1.journal"]) throw new RejectedOverlayGenerationError(mode, 12);
    })).rejects.toThrow(/errno 12/);
    await expect(enableBestOverlayGeneration(files(entries), (journal) => {
      if (journal === entries["g1.journal"]) throw new Error("host I/O failed");
    })).rejects.toThrow("host I/O failed");
  });

  it("refuses older fallback when the active indexed generation is damaged", async () => {
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
    await expect(enableBestOverlayGeneration(files(entries), () => {})).rejects.toBeInstanceOf(NoValidOverlayGenerationError);
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
    expect((await enableBestOverlayGeneration(files(entries), journal => { journal.writeAllAt(0, journalBytes()); })).slot).toBe("legacy");
    entries["legacy.journal"].truncate(0);
    await expect(enableBestOverlayGeneration(files(entries), () => {}, true))
      .rejects.toBeInstanceOf(NoValidOverlayGenerationError);
  });

  it("seals a bounded legacy conversion before mounting its indexed target", async () => {
    const sourceBytes = journalBytes(32 * 1024 * 1024, 0);
    sourceBytes.set(journalBytes());
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
    expect(entries["legacy.journal"]!.maxRead).toBeLessThanOrEqual(1024 * 1024);
    expect(new DataView(entries["g0.seal"]!.bytes.buffer).getUint32(4, true)).toBe(4);
  });

  it("keeps the controlled active target after an old legacy source changes", async () => {
    const legacy = new MemoryStorage(Uint8Array.of(1, 2, 3));
    const entries: Record<string, MemoryStorage> = {
      "legacy.journal": legacy,
      "g0.journal": new MemoryStorage(Uint8Array.of(4, 5)),
      "g0.index": new MemoryStorage(Uint8Array.of(6)),
      "g0.seal": new MemoryStorage(),
      "g1.journal": new MemoryStorage(Uint8Array.of(7, 8)),
      "g1.index": new MemoryStorage(Uint8Array.of(9)),
      "g1.seal": new MemoryStorage(),
    };
    const baseDigest = new Uint8Array(32);
    await writeOverlayGenerationSeal(entries["g0.journal"]!, entries["g0.seal"]!, 1, baseDigest,
      entries["g0.index"]!, { slot: "legacy", journalLength: legacy.len(),
        journalDigest: digestOverlayStoragePrefix(legacy, legacy.len()) });
    await writeOverlayGenerationSeal(entries["g1.journal"]!, entries["g1.seal"]!, 2, baseDigest,
      entries["g1.index"]!, { slot: "g0", journalLength: entries["g0.journal"]!.len() });
    expect((await enableBestOverlayGeneration(files(entries), () => {}, true)).slot).toBe("g1");
    legacy.bytes[1] ^= 1;
    expect((await enableBestOverlayGeneration(files(entries), () => {}, true)).slot).toBe("g1");
    delete entries["legacy.journal"];
    expect((await enableBestOverlayGeneration(files(entries), () => {}, true)).slot).toBe("g1");
    await writeOverlayGenerationSeal(entries["g0.journal"]!, entries["g0.seal"]!, 1, baseDigest,
      entries["g0.index"]!, { slot: "legacy", journalLength: legacy.len() });
    expect((await enableBestOverlayGeneration(files(entries), () => {}, true)).slot).toBe("g1");
    entries["g1.seal"]!.truncate(0);
    await expect(enableBestOverlayGeneration(files(entries), () => {}, true))
      .rejects.toBeInstanceOf(NoValidOverlayGenerationError);
  });

  it("retires a matching legacy journal only after its second sealed copy activates", async () => {
    const legacy = new MemoryStorage(Uint8Array.of(1, 2, 3));
    const entries: Record<string, MemoryStorage> = {
      "legacy.journal": legacy,
      "g0.journal": new MemoryStorage(new Uint8Array(72)),
      "g0.index": new MemoryStorage(Uint8Array.of(6)),
      "g0.seal": new MemoryStorage(),
    };
    await writeOverlayGenerationSeal(entries["g0.journal"]!, entries["g0.seal"]!, 1, new Uint8Array(32),
      entries["g0.index"]!, { slot: "legacy", journalLength: legacy.len(),
        journalDigest: digestOverlayStoragePrefix(legacy, legacy.len()) });
    const selected = await enableBestOverlayGeneration(files(entries), () => {}, true);
    const active = await compactOverlayGeneration(selected, files(entries), {
      prepare: (target) => { target.writeAllAt(0, (selected.journal as MemoryStorage).bytes); },
      checkpoint: (index) => { index.writeAllAt(0, Uint8Array.of(7)); },
      activate: () => { expect(entries["legacy.journal"]).toBe(legacy); },
      fail: () => {}, cancel: () => { throw new Error("unexpected cancellation"); },
    }, 0);
    expect(active.slot).toBe("g1");
    expect(entries["legacy.journal"]).toBeUndefined();
    entries["g1.seal"]!.truncate(0);
    await expect(enableBestOverlayGeneration(files(entries), () => {}, true)).rejects.toBeInstanceOf(NoValidOverlayGenerationError);
  });

  it("retries removal of an empty legacy journal on sealed boot without deleting a nonempty source", async () => {
    const legacy = new MemoryStorage(Uint8Array.of(1, 2, 3));
    const entries: Record<string, MemoryStorage> = {
      "legacy.journal": legacy,
      "g0.journal": new MemoryStorage(new Uint8Array(72)),
      "g0.index": new MemoryStorage(Uint8Array.of(6)),
      "g0.seal": new MemoryStorage(),
      "g1.journal": new MemoryStorage(new Uint8Array(72)),
      "g1.index": new MemoryStorage(Uint8Array.of(7)),
      "g1.seal": new MemoryStorage(),
    };
    await writeOverlayGenerationSeal(entries["g0.journal"]!, entries["g0.seal"]!, 1, new Uint8Array(32),
      entries["g0.index"]!, { slot: "legacy", journalLength: legacy.len(),
        journalDigest: digestOverlayStoragePrefix(legacy, legacy.len()) });
    await writeOverlayGenerationSeal(entries["g1.journal"]!, entries["g1.seal"]!, 2, new Uint8Array(32),
      entries["g1.index"]!, { slot: "g0", journalLength: entries["g0.journal"]!.len() });
    const storageFiles = files(entries);
    const selected = await enableBestOverlayGeneration(storageFiles, () => {}, true);
    await collectBootOverlayGenerations(selected, storageFiles);
    expect(entries["legacy.journal"]).toBe(legacy);
    legacy.truncate(0);
    const reopened = await enableBestOverlayGeneration(storageFiles, () => {}, true);
    expect(reopened.slot).toBe("g1");
    const remove = storageFiles.remove;
    storageFiles.remove = async (slot, file) => {
      if (slot === "legacy") throw new Error("injected legacy removal failure");
      await remove(slot, file);
    };
    const failures: string[] = [];
    await collectBootOverlayGenerations(reopened, storageFiles, (error) => { failures.push(String(error)); });
    expect(failures).toEqual(["Error: injected legacy removal failure"]);
    expect(entries["legacy.journal"]).toBe(legacy);
    storageFiles.remove = remove;
    await collectBootOverlayGenerations(reopened, storageFiles);
    expect(entries["legacy.journal"]).toBeUndefined();
    entries["g1.seal"]!.truncate(0);
    await expect(enableBestOverlayGeneration(storageFiles, () => {}, true)).rejects.toBeInstanceOf(NoValidOverlayGenerationError);
  });

  it.each(["truncate", "flush"] as const)("keeps sealed generations bootable after legacy %s failure", async (failure) => {
    const legacy = new MemoryStorage(Uint8Array.of(1, 2, 3));
    const entries: Record<string, MemoryStorage> = {
      "legacy.journal": legacy,
      "g0.journal": new MemoryStorage(new Uint8Array(72)),
      "g0.index": new MemoryStorage(Uint8Array.of(6)),
      "g0.seal": new MemoryStorage(),
    };
    await writeOverlayGenerationSeal(entries["g0.journal"]!, entries["g0.seal"]!, 1, new Uint8Array(32),
      entries["g0.index"]!, { slot: "legacy", journalLength: legacy.len(),
        journalDigest: digestOverlayStoragePrefix(legacy, legacy.len()) });
    const selected = await enableBestOverlayGeneration(files(entries), () => {}, true);
    if (failure === "truncate") legacy.failNextTruncate = true;
    else legacy.failNextFlush = true;
    const failures: unknown[] = [];
    const active = await compactOverlayGeneration(selected, files(entries), {
      prepare: (target) => { target.writeAllAt(0, (selected.journal as MemoryStorage).bytes); },
      checkpoint: (index) => { index.writeAllAt(0, Uint8Array.of(7)); },
      activate: () => {},
      fail: () => {}, cancel: () => { throw new Error("unexpected cancellation"); },
    }, 0, () => true, (error) => { failures.push(error); });
    expect(active.slot).toBe("g1");
    expect(failures).toHaveLength(1);
    expect(entries["legacy.journal"]).toBe(legacy);
    expect((await enableBestOverlayGeneration(files(entries), () => {}, true)).slot).toBe("g1");
    entries["g1.seal"]!.truncate(0);
    await expect(enableBestOverlayGeneration(files(entries), () => {}, true)).rejects.toBeInstanceOf(NoValidOverlayGenerationError);
  });

  it("upgrades one oversized sealed v1 generation without mounting its legacy index", async () => {
    const sourceBytes = journalBytes(32 * 1024 * 1024, 0);
    sourceBytes.set(journalBytes());
    const sourceIndex = checkpointHeader(1);
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
    const index = checkpointHeader(1);
    const entries: Record<string, MemoryStorage> = {
      "g0.journal": new MemoryStorage(Uint8Array.of(1)),
      "g0.seal": new MemoryStorage(),
      "g1.journal": new MemoryStorage(journalBytes(32 * 1024 * 1024, 0)),
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
    const sourceBytes = journalBytes(32 * 1024 * 1024, 0);
    const sourceIndex = checkpointHeader(2);
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
    const sourceBytes = journalBytes(32 * 1024 * 1024, 0);
    const sourceIndex = checkpointHeader(1);
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
    const recovered = await collectBootOverlayGenerations(selected, files(entries));
    for (const slot of ["g0", "g1"]) {
      for (const suffix of ["journal", "index", "seal"]) {
        expect(entries[`${slot}.${suffix}`]).toBeUndefined();
      }
    }
    expect(entries["g2.seal"]!.len()).toBeGreaterThan(0);
    expect((await enableBestOverlayGeneration(files(entries), () => {})).slot).toBe("g3");
    entries["g3.index"]!.bytes[0] ^= 1;
    await expect(enableBestOverlayGeneration(files(entries), () => {})).rejects.toBeInstanceOf(NoValidOverlayGenerationError);
    entries["g3.index"]!.bytes[0] ^= 1;
    const compacted = await compactOverlayGeneration(recovered, files(entries), {
      prepare: (target) => { target.writeAllAt(0, (recovered.journal as MemoryStorage).bytes); },
      checkpoint: (checkpoint) => { checkpoint.writeAllAt(0, Uint8Array.of(4)); },
      activate: () => {},
      fail: () => {}, cancel: () => { throw new Error("unexpected cancellation"); },
    }, 0);
    expect(compacted.slot).toBe("g0");
    expect((await enableBestOverlayGeneration(files(entries), () => {})).slot).toBe("g0");
  });

  it.each([4, 5])("converts beyond %i occupied slots without overwriting a verified fallback", async (occupiedCount) => {
    const oldIndex = checkpointHeader(1);
    const entries: Record<string, MemoryStorage> = {};
    const digest = new Uint8Array(32);
    const occupiedSlots = Array.from({ length: occupiedCount }, (_, position) => `g${position}` as const);
    const targetSlot = `g${occupiedCount}` as const;
    for (const [position, slot] of occupiedSlots.entries()) {
      entries[`${slot}.journal`] = new MemoryStorage(
        position === occupiedCount - 1 ? journalBytes(32 * 1024 * 1024, 0) : Uint8Array.of(position),
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
    const recovered = await collectBootOverlayGenerations(selected, files(entries));
    for (const slot of occupiedSlots.slice(0, -1)) {
      for (const suffix of ["journal", "index", "seal"]) {
        expect(entries[`${slot}.${suffix}`]).toBeUndefined();
      }
    }
    expect(entries[`${occupiedSlots[occupiedSlots.length - 1]}.seal`]).toBeDefined();
    expect((await enableBestOverlayGeneration(files(entries), () => {}, true)).slot).toBe(targetSlot);
    entries[`${targetSlot}.index`].bytes[0] ^= 1;
    await expect(enableBestOverlayGeneration(files(entries), () => {}, true)).rejects.toBeInstanceOf(NoValidOverlayGenerationError);
    entries[`${targetSlot}.index`].bytes[0] ^= 1;
    const compacted = await compactOverlayGeneration(recovered, files(entries), {
      prepare: (target) => { target.writeAllAt(0, (recovered.journal as MemoryStorage).bytes); },
      checkpoint: (index) => { index.writeAllAt(0, Uint8Array.of(2)); },
      activate: () => {},
      fail: () => {}, cancel: () => { throw new Error("unexpected cancellation"); },
    }, 0);
    expect(compacted.slot).toBe("g0");
    expect(compacted.generation).toBe(occupiedCount + 2);
    expect((await enableBestOverlayGeneration(files(entries), () => {}, true)).slot).toBe("g0");
  });

  it.each([3, 4])("keeps a g%i converted target and source bootable when boot retirement fails", async (occupiedCount) => {
    const entries: Record<string, MemoryStorage> = {};
    const digest = new Uint8Array(32);
    for (let position = 0; position < occupiedCount; position++) {
      const slot = `g${position}`;
      entries[`${slot}.journal`] = new MemoryStorage(
        position === occupiedCount - 1 ? journalBytes(32 * 1024 * 1024, 0) : Uint8Array.of(position + 1),
      );
      entries[`${slot}.index`] = new MemoryStorage(position === occupiedCount - 1 ? checkpointHeader() : Uint8Array.of(position + 1));
      entries[`${slot}.seal`] = new MemoryStorage();
      await writeOverlayGenerationSeal(entries[`${slot}.journal`], entries[`${slot}.seal`], position + 1,
        digest, entries[`${slot}.index`]);
    }
    const storageFiles = files(entries);
    const remove = storageFiles.remove;
    storageFiles.remove = async (slot, file) => {
      if (slot === "g0" && file === "journal") throw new Error("injected removal failure");
      await remove(slot, file);
    };
    const selected = await enableBestOverlayGeneration(storageFiles, () => {}, true, (source, target, index) => {
      target.writeAllAt(0, (source as MemoryStorage).bytes.subarray(0, 72));
      index.writeAllAt(0, Uint8Array.of(1));
    });
    const targetSlot = `g${occupiedCount}`;
    const sourceSlot = `g${occupiedCount - 1}`;
    expect(selected.slot).toBe(targetSlot);
    const failures: string[] = [];
    await collectBootOverlayGenerations(selected, storageFiles, (error) => { failures.push(String(error)); });
    expect(failures).toEqual(["Error: injected removal failure"]);
    expect(entries["g0.seal"]!.len()).toBe(0);
    expect(entries["g0.journal"]).toBeDefined();
    expect(entries[`${sourceSlot}.seal`]!.len()).toBeGreaterThan(0);
    expect((await enableBestOverlayGeneration(files(entries), () => {}, true)).slot).toBe(targetSlot);
    entries[`${targetSlot}.index`]!.bytes[0] ^= 1;
    await expect(enableBestOverlayGeneration(files(entries), () => {}, true)).rejects.toBeInstanceOf(NoValidOverlayGenerationError);
    entries[`${targetSlot}.index`]!.bytes[0] ^= 1;
    storageFiles.remove = remove;
    const reopened = await enableBestOverlayGeneration(storageFiles, () => {}, true);
    await collectBootOverlayGenerations(reopened, storageFiles);
    for (let position = 0; position < occupiedCount - 1; position++) {
      for (const suffix of ["journal", "index", "seal"]) {
        expect(entries[`g${position}.${suffix}`]).toBeUndefined();
      }
    }
    expect(entries[`${sourceSlot}.seal`]!.len()).toBeGreaterThan(0);
    expect((await enableBestOverlayGeneration(storageFiles, () => {}, true)).slot).toBe(targetSlot);
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
      fail: () => {}, cancel: () => { throw new Error("unexpected cancellation"); },
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
    await expect(enableBestOverlayGeneration(files(entries), () => {}, true)).rejects.toBeInstanceOf(NoValidOverlayGenerationError);
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
      fail: () => {}, cancel: () => { throw new Error("unexpected cancellation"); },
    }, 0, () => true, (error) => { failures.push(String(error)); });
    expect(target.slot).toBe("g0");
    expect(failures).toEqual([`Error: injected ${fault === "remove" ? "removal" : fault} failure`]);
    expect(entries["g1.seal"]!.len()).toBe(fault === "truncate" ? originalSealLength : 0);
    expect(entries["g1.journal"]).toBeDefined();
    expect((await enableBestOverlayGeneration(files(entries), () => {}, true)).slot).toBe("g0");
    entries["g0.index"]!.bytes[0] ^= 1;
    await expect(enableBestOverlayGeneration(files(entries), () => {}, true)).rejects.toBeInstanceOf(NoValidOverlayGenerationError);
  });

  it("reclaims obsolete generations before retrying compaction under a shared quota", async () => {
    const entries: Record<string, MemoryStorage> = {};
    let quota = Number.POSITIVE_INFINITY;
    class QuotaStorage extends MemoryStorage {
      override writeAllAt(offset: HostFileOffset, source: Uint8Array): void {
        const nextLength = Math.max(this.len(), Number(offset) + source.byteLength);
        const total = Object.values(entries).reduce((sum, storage) => sum + storage.len(), 0);
        if (total - this.len() + nextLength > quota) {
          throw Object.assign(new Error("shared quota exhausted"), { code: "ENOSPC" });
        }
        super.writeAllAt(offset, source);
      }
    }
    const digest = new Uint8Array(32);
    for (let position = 0; position < 5; position++) {
      const slot = `g${position}`;
      entries[`${slot}.journal`] = new QuotaStorage(new Uint8Array(position === 1 || position === 2 ? 8192 : 72));
      entries[`${slot}.index`] = new QuotaStorage(Uint8Array.of(position + 1));
      entries[`${slot}.seal`] = new QuotaStorage();
      await writeOverlayGenerationSeal(
        entries[`${slot}.journal`], entries[`${slot}.seal`], position + 1, digest,
        entries[`${slot}.index`], position === 0 ? undefined
          : { slot: `g${position - 1}` as const, journalLength: entries[`g${position - 1}.journal`].len() },
      );
    }
    const storageFiles = files(entries);
    const open = storageFiles.open;
    storageFiles.open = async (slot, file, create) => {
      const key = `${slot}.${file}`;
      if (create && entries[key] === undefined) entries[key] = new QuotaStorage();
      return open(slot, file, false);
    };
    const selected = await enableBestOverlayGeneration(storageFiles, () => {}, true);
    expect(selected.slot).toBe("g4");
    quota = Object.values(entries).reduce((sum, storage) => sum + storage.len(), 0) + 20 * 1024;
    const handoff = {
      prepare: (target: PersistentOverlayStorage) => { target.writeAllAt(0, new Uint8Array(32 * 1024)); },
      checkpoint: (index: PersistentOverlayStorage) => { index.writeAllAt(0, Uint8Array.of(6)); },
      activate: () => {},
      fail: () => {}, cancel: () => {},
    };
    await expect(compactOverlayGeneration(selected, storageFiles, handoff, 0))
      .rejects.toMatchObject({ code: "ENOSPC" });
    expect((await enableBestOverlayGeneration(storageFiles, () => {}, true)).slot).toBe("g4");
    const collected = await collectBootOverlayGenerations(selected, storageFiles);
    for (const slot of ["g0", "g1", "g2"]) {
      expect(entries[`${slot}.journal`]).toBeUndefined();
      expect(entries[`${slot}.seal`]).toBeUndefined();
    }
    const compacted = await compactOverlayGeneration(collected, storageFiles, handoff, 0);
    expect(compacted.slot).toBe("g0");
    expect((await enableBestOverlayGeneration(storageFiles, () => {}, true)).slot).toBe("g0");
    entries["g0.index"]!.bytes[0] ^= 1;
    await expect(enableBestOverlayGeneration(storageFiles, () => {}, true)).rejects.toBeInstanceOf(NoValidOverlayGenerationError);
  });

  it.each([true, false])("tries the source after a converted target is rejected (source valid: %s)", async (sourceValid) => {
    const sourceBytes = journalBytes(32 * 1024 * 1024, 0);
    sourceBytes.set(journalBytes());
    const oldIndex = checkpointHeader(1);
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
    const selection = enableBestOverlayGeneration(files(entries), (journal) => {
      if (journal === entries["g3.journal"]) throw new RejectedOverlayGenerationError("fixed", 5);
      if (journal === entries["g2.journal"] && !sourceValid) throw new RejectedOverlayGenerationError("fixed", 5);
      if (journal !== entries[sourceValid ? "g2.journal" : "g1.journal"]) {
        throw new Error("selected the wrong fallback");
      }
    }, true, (_source, target, checkpoint) => {
      target.writeAllAt(0, sourceBytes.subarray(0, 72));
      checkpoint.writeAllAt(0, Uint8Array.of(4));
    });
    if (sourceValid) expect((await selection).slot).toBe("g2");
    else await expect(selection).rejects.toBeInstanceOf(NoValidOverlayGenerationError);
    expect(entries["g3.seal"]!.len()).toBe(0);
    expect(entries["g2.journal"].bytes).toBe(originalSource);
  });

  it.each(["rejected", "stale"] as const)("reuses a %s higher slot before compaction can duplicate its generation", async (reason) => {
    const source = new MemoryStorage(journalBytes());
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
    await setActiveGeneration(entries, "g2", 3);
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
      fail: () => {}, cancel: () => { throw new Error("unexpected cancellation"); },
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
    await setActiveGeneration(entries, "g0", 1);
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
        fail: () => {}, cancel: () => { throw new Error("unexpected cancellation"); },
      }, 0);
      expect(selected.slot).toBe(slot);
      expect(selected.generation).toBe(position + 2);
    }
    expect((await enableBestOverlayGeneration(files(entries), () => {}, true)).slot).toBe("g3");
  });

  it("retries an oversized legacy source when its converted target is rejected", async () => {
    const source = new MemoryStorage(journalBytes(32 * 1024 * 1024, 0));
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

  it("forgets an unpublished slot when legacy conversion overwrites it at another generation", async () => {
    const legacy = new MemoryStorage(journalBytes(32 * 1024 * 1024, 0));
    const rejected = new MemoryStorage(new Uint8Array(72));
    const entries: Record<string, MemoryStorage> = {
      "legacy.journal": legacy,
      "g0.journal": rejected,
      "g0.seal": new MemoryStorage(),
    };
    const digest = new Uint8Array(32);
    await writeOverlayGenerationSeal(rejected, entries["g0.seal"], 2, digest);
    await setActiveGeneration(entries, "legacy", 0);
    const selected = await enableBestOverlayGeneration(files(entries), () => {}, true, (_source, target, checkpoint) => {
      target.writeAllAt(0, legacy.bytes.subarray(0, 72));
      checkpoint.writeAllAt(0, Uint8Array.of(1));
    });
    expect(selected.slot).toBe("g0");
    const compacted = await compactOverlayGeneration(selected, files(entries), {
      prepare: (target) => { target.writeAllAt(0, (selected.journal as MemoryStorage).bytes); },
      checkpoint: (index) => { index.writeAllAt(0, Uint8Array.of(1)); },
      activate: () => {},
      fail: () => {}, cancel: () => { throw new Error("unexpected cancellation"); },
    }, 0);
    expect(compacted.slot).toBe("g1");
    expect((await enableBestOverlayGeneration(files(entries), () => {}, true)).slot).toBe("g1");
  });

  it("replaces a semantically rejected slot after validating the older v1 source", async () => {
    const source = journalBytes(32 * 1024 * 1024, 0);
    source.set(journalBytes());
    const oldIndex = checkpointHeader(1);
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
    await setActiveGeneration(entries, "g0", 1);
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
    const source = journalBytes(32 * 1024 * 1024, 0);
    source.set(journalBytes());
    const oldIndex = checkpointHeader(1);
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
    const source = journalBytes(32 * 1024 * 1024, 0);
    source.set(journalBytes());
    const oldIndex = checkpointHeader(1);
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
    const sourceBytes = journalBytes(32 * 1024 * 1024, 0);
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

  it.each(["journal", "index", "seal"] as const)("retries legacy conversion after %s quota exhaustion", async (limitedFile) => {
    const sourceBytes = journalBytes(32 * 1024 * 1024, 0);
    sourceBytes.set(journalBytes());
    const legacy = new MemoryStorage(sourceBytes);
    const sourceDigest = digestOverlayStoragePrefix(legacy, legacy.len());
    const entries: Record<string, MemoryStorage> = {
      "legacy.journal": legacy,
      "g0.journal": new MemoryStorage(),
      "g0.index": new MemoryStorage(),
      "g0.seal": new MemoryStorage(),
    };
    const limited = entries[`g0.${limitedFile}`]!;
    limited.maxLength = limitedFile === "seal" ? 128 : 1;
    const convert = (_source: PersistentOverlayStorage, target: PersistentOverlayStorage, index: PersistentOverlayStorage) => {
      target.writeAllAt(0, sourceBytes.subarray(0, 72));
      index.writeAllAt(0, Uint8Array.of(1, 2, 3));
    };
    const mounted = await enableBestOverlayGeneration(files(entries), (journal) => {
      expect(journal).toBe(legacy);
    }, true, convert);
    expect(mounted.slot).toBe("legacy");
    expect(digestOverlayStoragePrefix(legacy, legacy.len())).toEqual(sourceDigest);
    expect(entries["g0.seal"]!.len()).toBe(0);
    expect(entries["g0.journal"]!.len()).toBe(0);
    expect(entries["g0.index"]!.len()).toBe(0);
    expect((await enableBestOverlayGeneration(files(entries), (journal) => {
      expect(journal).toBe(legacy);
    }, true)).slot).toBe("legacy");
    limited.maxLength = Number.MAX_SAFE_INTEGER;
    const recovered = await enableBestOverlayGeneration(files(entries), (journal) => {
      expect(journal).toBe(entries["g0.journal"]);
    }, true, convert);
    expect(recovered.slot).toBe("g0");
    expect((await enableBestOverlayGeneration(files(entries), () => {}, true)).slot).toBe("g0");
  });

  it("reports failed conversion target reclamation without hiding a valid legacy source", async () => {
    const legacy = new MemoryStorage(journalBytes(32 * 1024 * 1024, 0));
    const entries: Record<string, MemoryStorage> = {
      "legacy.journal": legacy,
      "g0.journal": new MemoryStorage(),
      "g0.index": new MemoryStorage(),
      "g0.seal": new MemoryStorage(),
    };
    entries["g0.index"]!.maxLength = 1;
    const cleanupFailures: string[] = [];
    const mounted = await enableBestOverlayGeneration(files(entries), (journal) => {
      expect(journal).toBe(legacy);
    }, true, (_source, target, index) => {
      target.writeAllAt(0, Uint8Array.of(1, 2));
      entries["g0.journal"]!.failNextTruncate = true;
      index.writeAllAt(0, Uint8Array.of(3, 4));
    }, (error) => { cleanupFailures.push(String(error)); });
    expect(mounted.slot).toBe("legacy");
    expect(cleanupFailures).toEqual(["Error: injected truncate failure"]);
    expect(entries["g0.seal"]!.len()).toBe(0);
    expect(entries["g0.index"]!.len()).toBe(0);
    expect(entries["g0.journal"]!.len()).toBe(2);
  });

  it("mounts an indexed source when a quota-limited index blocks conversion", async () => {
    const sourceBytes = journalBytes(32 * 1024 * 1024, 0);
    sourceBytes.set(journalBytes());
    const oldIndex = checkpointHeader(1);
    const entries: Record<string, MemoryStorage> = {
      "g0.journal": new MemoryStorage(sourceBytes),
      "g0.index": new MemoryStorage(oldIndex),
      "g0.seal": new MemoryStorage(),
      "g1.journal": new MemoryStorage(),
      "g1.index": new MemoryStorage(),
      "g1.seal": new MemoryStorage(),
    };
    await writeOverlayGenerationSeal(entries["g0.journal"]!, entries["g0.seal"]!, 1,
      sourceBytes.slice(8, 40), entries["g0.index"]!);
    entries["g1.index"]!.maxLength = 1;
    const convert = (_source: PersistentOverlayStorage, target: PersistentOverlayStorage, index: PersistentOverlayStorage) => {
      target.writeAllAt(0, sourceBytes.subarray(0, 72));
      index.writeAllAt(0, Uint8Array.of(1, 2, 3));
    };
    const source = await enableBestOverlayGeneration(files(entries), (journal) => {
      expect(journal).toBe(entries["g0.journal"]);
    }, true, convert);
    expect(source.slot).toBe("g0");
    expect(entries["g1.seal"]!.len()).toBe(0);
    entries["g1.index"]!.maxLength = Number.MAX_SAFE_INTEGER;
    const converted = await enableBestOverlayGeneration(files(entries), (journal) => {
      expect(journal).toBe(entries["g1.journal"]);
    }, true, convert);
    expect(converted.slot).toBe("g1");
    expect((await enableBestOverlayGeneration(files(entries), () => {}, true)).slot).toBe("g1");
  });

  it("keeps booting the mounted source when automatic compaction runs out of quota", async () => {
    const source = new MemoryStorage(journalBytes(32 * 1024 * 1024, 0));
    const entries: Record<string, MemoryStorage> = {
      "legacy.journal": source,
      "g0.journal": new MemoryStorage(),
      "g0.index": new MemoryStorage(),
      "g0.seal": new MemoryStorage(),
    };
    const selected = { journal: source, slot: "legacy", generation: 0, sealedLength: 0 } as const;
    const handoff = {
      prepare: (target: PersistentOverlayStorage) => { target.writeAllAt(0, Uint8Array.of(1, 2)); },
      checkpoint: (index: PersistentOverlayStorage) => { index.writeAllAt(0, Uint8Array.of(3)); },
      activate: () => {},
      fail: () => {}, cancel: () => { throw new Error("unexpected cancellation"); },
    };
    entries["g0.journal"]!.maxLength = 1;
    const deferred: unknown[] = [];
    expect(await compactOverlayGenerationForBoot(selected, files(entries), handoff, (error) => { deferred.push(error); }))
      .toBe(selected);
    expect(deferred).toMatchObject([{ code: "ENOSPC" }]);
    expect(entries["g0.seal"]!.len()).toBe(0);
    expect(source.len()).toBe(32 * 1024 * 1024);
    entries["g0.journal"]!.maxLength = Number.MAX_SAFE_INTEGER;
    await expect(compactOverlayGenerationForBoot(selected, files(entries), {
      ...handoff,
      prepare: () => { throw new Error("backend unavailable"); },
    }, () => { throw new Error("unexpected deferral"); })).rejects.toThrow("backend unavailable");
    await expect(compactOverlayGenerationForBoot(selected, files(entries), {
      ...handoff,
      activate: () => { throw Object.assign(new Error("activation quota failure"), { code: "ENOSPC" }); },
      fail: () => {}, cancel: () => {},
    }, () => { throw new Error("unexpected deferral"); })).rejects.toMatchObject({
      name: "UnconfirmedOverlayActivationError", cause: { code: "ENOSPC" },
    });
    const recovered = await compactOverlayGenerationForBoot(selected, files(entries), handoff, () => {
      throw new Error("unexpected deferral");
    });
    expect(recovered.slot).toBe("g0");
    expect((await enableBestOverlayGeneration(files(entries), () => {}, true)).slot).toBe("g0");
  });

  it("attempts every legacy conversion close after a failed write", async () => {
    const entries: Record<string, MemoryStorage> = {
      "legacy.journal": new MemoryStorage(journalBytes(32 * 1024 * 1024, 0)),
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
    await expect(enableBestOverlayGeneration(files({ "legacy.journal": new MemoryStorage(journalBytes()) }), () => {
      throw new Error("backend unavailable");
    })).rejects.toThrow("backend unavailable");
  });

  it("does not fall back to stale generations or delete data after metadata exhaustion", async () => {
    const entries: Record<string, MemoryStorage> = {
      "g0.journal": new MemoryStorage(new Uint8Array(72).fill(1)),
      "g0.seal": new MemoryStorage(),
      "g1.journal": new MemoryStorage(new Uint8Array(72).fill(2)),
      "g1.seal": new MemoryStorage(),
      "legacy.journal": new MemoryStorage(new Uint8Array(72).fill(3)),
    };
    await writeOverlayGenerationSeal(entries["g0.journal"], entries["g0.seal"], 1, new Uint8Array(32));
    await writeOverlayGenerationSeal(entries["g1.journal"], entries["g1.seal"], 2, new Uint8Array(32));
    const before = Object.fromEntries(Object.entries(entries).map(([name, storage]) => [name, storage.bytes.slice()]));
    const enabled: PersistentOverlayStorage[] = [];
    const failure = new RejectedOverlayGenerationError("resizable", ERRNO.ENOMEM);
    await expect(enableBestOverlayGeneration(files(entries), (journal) => {
      enabled.push(journal);
      throw failure;
    }, true, () => { throw new Error("unproven recovery must not be converted"); })).rejects.toBe(failure);
    expect(enabled).toEqual([entries["g1.journal"]]);
    for (const [name, bytes] of Object.entries(before)) expect(entries[name]!.bytes).toEqual(bytes);
    for (const name of ["g0.journal", "g1.journal"]) expect(entries[name].closeCount).toBe(1);
    const recovered = await enableBestOverlayGeneration(files(entries), (journal) => {
      expect(journal).toBe(entries["g1.journal"]);
    }, true);
    expect(recovered.generation).toBe(2);
    expect(recovered.slot).toBe("g1");
  });

  async function memoryLimitedGeneration(kind: "legacy" | "sealed" | "indexed") {
    const source = new MemoryStorage(journalBytes());
    const entries: Record<string, MemoryStorage> = kind === "legacy" ? { "legacy.journal": source } : {
      "g0.journal": new MemoryStorage(new Uint8Array(72).fill(3)),
      "g0.seal": new MemoryStorage(),
      "g1.journal": source,
      "g1.seal": new MemoryStorage(),
    };
    if (kind !== "legacy") {
      await writeOverlayGenerationSeal(entries["g0.journal"]!, entries["g0.seal"]!, 1, new Uint8Array(32).fill(3));
      if (kind === "indexed") entries["g1.index"] = new MemoryStorage(Uint8Array.of(1, 2, 3));
      await writeOverlayGenerationSeal(source, entries["g1.seal"]!, 2, new Uint8Array(32).fill(7), entries["g1.index"]);
    }
    const slot = kind === "legacy" ? "legacy" : "g1";
    const targetSlot = kind === "legacy" ? "g0" : "g2";
    const generation = kind === "legacy" ? 1 : 3;
    const before = Object.fromEntries(Object.entries(entries).map(([name, storage]) => [name, storage.bytes.slice()]));
    let conversions = 0;
    const convert = (input: PersistentOverlayStorage, target: PersistentOverlayStorage, index: PersistentOverlayStorage) => {
      expect(input).toBe(source);
      conversions++;
      target.writeAllAt(0, source.bytes);
      index.writeAllAt(0, Uint8Array.of(4, 5, 6));
    };
    const assertPreserved = () => {
      for (const [name, bytes] of Object.entries(before)) expect(entries[name]!.bytes).toEqual(bytes);
    };
    return { entries, source, slot, targetSlot, generation, convert, assertPreserved, conversions: () => conversions };
  }

  it.each(["legacy", "sealed", "indexed"] as const)("converts a small %s journal after memory-limited recovery without selecting stale data", async (kind) => {
    const fixture = await memoryLimitedGeneration(kind);
    const attempts: PersistentOverlayStorage[] = [];
    const selected = await enableBestOverlayGeneration(files(fixture.entries), (journal, index, end) => {
      attempts.push(journal);
      if (journal === fixture.source) throw new RejectedOverlayGenerationError("resizable", ERRNO.ENOMEM, true);
      expect(journal).toBe(fixture.entries[`${fixture.targetSlot}.journal`]);
      expect(index).toBe(fixture.entries[`${fixture.targetSlot}.index`]);
      expect(end).toBe(72);
    }, true, fixture.convert);
    expect(selected.slot).toBe(fixture.targetSlot);
    expect(selected.generation).toBe(fixture.generation);
    expect(selected.convertedFrom).toEqual({ slot: fixture.slot, generation: fixture.generation - 1 });
    expect(attempts).toEqual([fixture.source, selected.journal]);
    expect(fixture.conversions()).toBe(1);
    fixture.assertPreserved();
    expect(fixture.source.closeCount).toBe(1);
    expect(await verifyOverlayGenerationSeal(
      fixture.entries[`${fixture.targetSlot}.journal`]!, fixture.entries[`${fixture.targetSlot}.seal`]!,
      new Uint8Array(32).fill(7), false, fixture.entries[`${fixture.targetSlot}.index`]!,
    )).toMatchObject({ generation: fixture.generation, source: { slot: fixture.slot, journalLength: 72 } });
  });

  it.each(["legacy", "sealed", "indexed"] as const)("refuses %s recovery after converted-target memory exhaustion and permits a later retry", async (kind) => {
    const fixture = await memoryLimitedGeneration(kind);
    const attempts: PersistentOverlayStorage[] = [];
    const failure = new RejectedOverlayGenerationError("resizable", ERRNO.ENOMEM, true);
    await expect(enableBestOverlayGeneration(files(fixture.entries), (journal) => {
      attempts.push(journal);
      throw failure;
    }, true, fixture.convert)).rejects.toBe(failure);
    expect(attempts).toEqual([fixture.source, fixture.entries[`${fixture.targetSlot}.journal`]]);
    expect(fixture.conversions()).toBe(1);
    fixture.assertPreserved();
    for (const file of ["seal", "index", "journal"]) expect(fixture.entries[`${fixture.targetSlot}.${file}`]!.len()).toBe(0);
    const recovered = await enableBestOverlayGeneration(files(fixture.entries), (journal) => {
      if (journal === fixture.source) throw failure;
    }, true, fixture.convert);
    expect(recovered.slot).toBe(fixture.targetSlot);
    expect(fixture.conversions()).toBe(2);
    fixture.assertPreserved();
  });

  it.each(["legacy", "sealed", "indexed"] as const)("does not reinterpret a rejected converted %s target as source corruption", async (kind) => {
    const fixture = await memoryLimitedGeneration(kind);
    const attempts: PersistentOverlayStorage[] = [];
    await expect(enableBestOverlayGeneration(files(fixture.entries), (journal) => {
      attempts.push(journal);
      throw new RejectedOverlayGenerationError("fixed", journal === fixture.source ? ERRNO.ENOMEM : ERRNO.EIO, journal === fixture.source);
    }, true, fixture.convert)).rejects.toThrow(`kernel refused fixed rootfs persistence (errno ${ERRNO.EIO})`);
    expect(attempts).toEqual([fixture.source, fixture.entries[`${fixture.targetSlot}.journal`]]);
    fixture.assertPreserved();
    expect(fixture.entries[`${fixture.targetSlot}.seal`]!.len()).toBe(0);
  });

  it.each(["journal", "index", "seal"] as const)("keeps a memory-limited source intact when conversion hits %s storage quota", async (file) => {
    const fixture = await memoryLimitedGeneration("sealed");
    const limited = new MemoryStorage();
    limited.maxLength = 0;
    fixture.entries[`${fixture.targetSlot}.${file}`] = limited;
    const attempts: PersistentOverlayStorage[] = [];
    await expect(enableBestOverlayGeneration(files(fixture.entries), (journal) => {
      attempts.push(journal);
      throw new RejectedOverlayGenerationError("resizable", ERRNO.ENOMEM, true);
    }, true, fixture.convert)).rejects.toMatchObject({ code: "ENOSPC" });
    expect(attempts).toEqual([fixture.source]);
    fixture.assertPreserved();
    expect(fixture.entries[`${fixture.targetSlot}.seal`]!.len()).toBe(0);
  });

  it("does not attempt resource conversion for an empty journal", async () => {
    let conversions = 0;
    const failure = new RejectedOverlayGenerationError("fixed", ERRNO.ENOMEM, true);
    await expect(enableBestOverlayGeneration(files({ "legacy.journal": new MemoryStorage() }), () => {
      throw failure;
    }, false, () => { conversions++; })).rejects.toBe(failure);
    expect(conversions).toBe(0);
  });

  it.each([false, true])("uses kernel memory pressure %s independently from the journal byte threshold", async (pressure) => {
    const source = new MemoryStorage(journalBytes());
    const entries = { "legacy.journal": source } as Record<string, MemoryStorage>;
    const selected = { journal: source, slot: "legacy", generation: 0, sealedLength: 0 } as const;
    const stages: string[] = [];
    const result = await compactOverlayGeneration(selected, files(entries), {
      memoryPressure: () => { stages.push("pressure"); return pressure; },
      prepare: target => { stages.push("prepare"); target.writeAllAt(0, source.bytes); },
      checkpoint: index => { stages.push("checkpoint"); index.writeAllAt(0, Uint8Array.of(1)); },
      activate: () => { stages.push("activate"); },
      fail: () => {}, cancel: () => { throw new Error("unexpected cancellation"); },
    });
    expect(stages).toEqual(pressure ? ["pressure", "prepare", "checkpoint", "activate"] : ["pressure"]);
    expect(result.slot).toBe(pressure ? "g0" : "legacy");
    if (!pressure) expect(Object.keys(entries)).toEqual(["legacy.journal"]);
  });

  it("stages and seals a compacted slot before selecting it", async () => {
    const source = new MemoryStorage(journalBytes());
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
      fail: () => {}, cancel: () => { throw new Error("unexpected cancellation"); },
    }, 0);
    expect(stages).toEqual(["prepare", "checkpoint", "activate", "microtask"]);
    expect(compacted.slot).toBe("g0");
    expect(compacted.generation).toBe(1);
    expect(entries["g0.seal"]!.len()).toBeGreaterThan(96);
    expect(compacted.index).toBe(entries["g0.index"]);
    expect((await enableBestOverlayGeneration(files(entries), () => {})).slot).toBe("g0");
    expect(source.bytes).toEqual(journalBytes());
  });

  it("cycles three compaction slots and reopens a seal sourced from g2", async () => {
    const source = new MemoryStorage(journalBytes());
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
        fail: () => {}, cancel: () => { throw new Error("unexpected cancellation"); },
      }, 0);
      expect(selected.slot).toBe(expectedSlot);
      expect(selected.generation).toBe(previous.generation + 1);
    }
    expect((await enableBestOverlayGeneration(files(entries), () => {})).slot).toBe("g0");
    expect(await verifyOverlayGenerationSeal(
      entries["g0.journal"], entries["g0.seal"], new Uint8Array(32).fill(7), false, entries["g0.index"],
    )).toMatchObject({ generation: 4, source: { slot: "g2", journalLength: 72 } });
  });

  it("binds a successful target after preparation flushes the source", async () => {
    const source = new MemoryStorage(journalBytes());
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
        fail: () => {}, cancel: () => { throw new Error("unexpected cancellation"); },
      },
      0,
    );
    expect((await enableBestOverlayGeneration(files(entries), () => {})).slot).toBe("g0");
  });

  it("closes every old handle after activation even when one close fails", async () => {
    const source = new MemoryStorage(journalBytes());
    const sourceIndex = new MemoryStorage(Uint8Array.of(4));
    const entries: Record<string, MemoryStorage> = {
      "g0.journal": source,
      "g0.index": sourceIndex,
      "g0.seal": new MemoryStorage(),
      "g1.seal": new MemoryStorage(),
    };
    await writeOverlayGenerationSeal(source, entries["g0.seal"], 1, source.bytes.slice(8, 40), sourceIndex);
    entries["g1.seal"]!.failNextClose = true;
    const failures: string[] = [];
    const compacted = await compactOverlayGeneration(
      { journal: source, index: sourceIndex, slot: "g0", generation: 1, sealedLength: 0 },
      files(entries),
      {
        prepare: (target) => { target.writeAllAt(0, source.bytes); },
        checkpoint: (index) => { index.writeAllAt(0, Uint8Array.of(1, 2, 3)); },
        activate: () => {},
        fail: () => {}, cancel: () => { throw new Error("unexpected cancellation"); },
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
    const source = new MemoryStorage(journalBytes());
    const entries: Record<string, MemoryStorage> = { "legacy.journal": source };
    const selected = { journal: source, slot: "legacy", generation: 0, sealedLength: 0 } as const;
    await expect(compactOverlayGeneration(selected, files(entries), {
      prepare: (target) => {
        target.writeAllAt(0, Uint8Array.of(1, 2));
        throw new Error("injected target failure");
      },
      checkpoint: () => { throw new Error("unexpected checkpoint"); },
      activate: () => { throw new Error("unexpected activation"); },
      fail: () => {}, cancel: () => {},
    }, 0)).rejects.toThrow("injected target failure");
    expect(source.bytes).toEqual(journalBytes());
    expect(entries["g0.seal"]!.len()).toBe(0);
  });

  it("stops uncertain activation without mutating its potentially active target", async () => {
    const source = new MemoryStorage(journalBytes());
    const entries: Record<string, MemoryStorage> = { "legacy.journal": source };
    const selected = { journal: source, slot: "legacy", generation: 0, sealedLength: 0 } as const;
    let canceled = false;
    await expect(compactOverlayGeneration(selected, files(entries), {
      prepare: (target) => { target.writeAllAt(0, source.bytes); },
      checkpoint: (index) => { index.writeAllAt(0, Uint8Array.of(1, 2, 3)); },
      activate: () => { throw new Error("injected activation failure"); },
      fail: () => {}, cancel: () => { canceled = true; },
    }, 0)).rejects.toBeInstanceOf(UnconfirmedOverlayActivationError);
    expect(canceled).toBe(false);
    expect(entries["g0.seal"]!.len()).toBeGreaterThan(0);
    expect(source.bytes).toEqual(journalBytes());
  });

  it("rejects a stale target after activation and seal invalidation both fail", async () => {
    const source = new MemoryStorage(journalBytes());
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
        fail: () => {}, cancel: () => {},
      },
      0,
    )).rejects.toBeInstanceOf(UnconfirmedOverlayActivationError);
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

  it.each(["seal", "index", "missing-index"] as const)("fails closed on an advanced source with unverified %s instead of mounting its stale descendant", async fault => {
    const entries: Record<string, MemoryStorage> = {
      "legacy.journal": new MemoryStorage(Uint8Array.of(99)),
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
    if (fault === "missing-index") delete entries["g0.index"];
    else entries[`g0.${fault}`]!.bytes[0] ^= 1;
    const original = Object.fromEntries(Object.entries(entries).map(([name, storage]) => [name, storage.bytes.slice()]));
    let enabled = 0;
    await expect(enableBestOverlayGeneration(files(entries), () => { enabled++; }, true))
      .rejects.toBeInstanceOf(NoValidOverlayGenerationError);
    expect(enabled).toBe(0);
    for (const [name, storage] of Object.entries(entries)) expect(storage.bytes, name).toEqual(original[name]);
  });

  it.each([false, true])("handles a newer verified descendant and older unresolved source after kernel rejection=%s", async rejectNewer => {
    const entries: Record<string, MemoryStorage> = {};
    const digest = new Uint8Array(32);
    for (let generation = 1; generation <= 3; generation++) {
      const slot = `g${generation - 1}`;
      entries[`${slot}.journal`] = new MemoryStorage(Uint8Array.of(generation, 2, 3));
      entries[`${slot}.index`] = new MemoryStorage(Uint8Array.of(4));
      entries[`${slot}.seal`] = new MemoryStorage();
      await writeOverlayGenerationSeal(entries[`${slot}.journal`]!, entries[`${slot}.seal`]!, generation, digest,
        entries[`${slot}.index`]!, generation === 1 ? undefined : { slot: `g${generation - 2}`, journalLength: 3 });
    }
    await setActiveGeneration(entries, "g2", 3);
    entries["g0.journal"]!.writeAllAt(3, Uint8Array.of(9));
    entries["g0.seal"]!.bytes[0] ^= 1;
    const enabled: string[] = [];
    const selected = enableBestOverlayGeneration(files(entries), journal => {
      const slot = journal === entries["g2.journal"] ? "g2" : journal === entries["g1.journal"] ? "g1" : "other";
      enabled.push(slot);
      if (rejectNewer) throw new RejectedOverlayGenerationError("resizable", ERRNO.EIO);
    }, true);
    if (rejectNewer) await expect(selected).rejects.toBeInstanceOf(NoValidOverlayGenerationError);
    else expect((await selected).slot).toBe("g2");
    expect(enabled).toEqual(["g2"]);
  });

  it("does not mistake a verified reused source slot of a different length for an advanced predecessor", async () => {
    const entries: Record<string, MemoryStorage> = {
      "g0.journal": new MemoryStorage(Uint8Array.of(1, 2, 3, 4, 5)),
      "g0.index": new MemoryStorage(Uint8Array.of(6)),
      "g0.seal": new MemoryStorage(),
      "g1.journal": new MemoryStorage(Uint8Array.of(7, 8, 9)),
      "g1.index": new MemoryStorage(Uint8Array.of(10)),
      "g1.seal": new MemoryStorage(),
    };
    const digest = new Uint8Array(32);
    await writeOverlayGenerationSeal(entries["g0.journal"]!, entries["g0.seal"]!, 3, digest, entries["g0.index"]!);
    await writeOverlayGenerationSeal(entries["g1.journal"]!, entries["g1.seal"]!, 2, digest,
      entries["g1.index"]!, { slot: "g0", journalLength: 3 });
    await setActiveGeneration(entries, "g1", 2);
    const enabled: string[] = [];
    const selected = await enableBestOverlayGeneration(files(entries), journal => {
      enabled.push(journal === entries["g0.journal"] ? "g0" : "g1");
      if (journal === entries["g0.journal"]) throw new RejectedOverlayGenerationError("resizable", ERRNO.EIO);
    }, true);
    expect(selected.slot).toBe("g1");
    expect(enabled).toEqual(["g1"]);
  });

  it("flush-invalidates a reused target seal before touching its journal", async () => {
    const source = new MemoryStorage(journalBytes());
    const target = new MemoryStorage(Uint8Array.of(1, 2, 3));
    const entries: Record<string, MemoryStorage> = {
      "g2.journal": source,
      "g2.index": new MemoryStorage(Uint8Array.of(8)),
      "g2.seal": new MemoryStorage(),
      "g0.journal": target,
      "g0.index": new MemoryStorage(Uint8Array.of(4)),
      "g0.seal": new MemoryStorage(),
    };
    const digest = source.bytes.slice(8, 40);
    await writeOverlayGenerationSeal(source, entries["g2.seal"]!, 3, digest, entries["g2.index"]!);
    await writeOverlayGenerationSeal(target, entries["g0.seal"]!, 1, digest, entries["g0.index"]!);
    const selected = await enableBestOverlayGeneration(files(entries), () => {}, true);
    entries["g0.seal"]!.failNextFlush = true;
    let prepared = false;
    await expect(compactOverlayGeneration(selected, files(entries), {
      prepare: () => { prepared = true; },
      checkpoint: () => {}, activate: () => {}, fail: () => {}, cancel: () => {},
    }, 0)).rejects.toThrow("injected flush failure");
    expect(prepared).toBe(false);
    expect(target.bytes).toEqual(Uint8Array.of(1, 2, 3));
    expect(entries["g0.index"]!.bytes).toEqual(Uint8Array.of(4));
    expect(entries["g0.seal"]!.len()).toBe(0);
    expect((await enableBestOverlayGeneration(files(entries), () => {}, true)).slot).toBe("g2");
    const truncate = target.truncate.bind(target);
    target.truncate = length => {
      expect(entries["g0.seal"]!.len()).toBe(0);
      truncate(length);
    };
    await compactOverlayGeneration(selected, files(entries), {
      prepare: storage => { storage.writeAllAt(0, source.bytes); },
      checkpoint: index => { index.writeAllAt(0, Uint8Array.of(8)); },
      activate: () => {}, fail: () => {}, cancel: () => {},
    }, 0);
  });

  it("cancels preparation and invalidates a seal after its flush fails", async () => {
    const source = new MemoryStorage(journalBytes());
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
      fail: () => {}, cancel: () => { canceled = true; },
    }, 0)).rejects.toThrow("injected flush failure");
    expect(canceled).toBe(true);
    expect(entries["g0.seal"]!.len()).toBe(0);
    expect(source.bytes).toEqual(journalBytes());
  });

  it("keeps the source active when checkpoint creation fails", async () => {
    const source = new MemoryStorage(journalBytes());
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
      fail: () => {}, cancel: () => { canceled = true; },
    }, 0)).rejects.toThrow("injected checkpoint failure");
    expect(canceled).toBe(true);
    expect(entries["g0.seal"]!.len()).toBe(0);
    expect(source.bytes).toEqual(journalBytes());
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
    const source = new MemoryStorage(journalBytes());
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
        fail: () => {}, cancel: () => { canceled = true; },
      },
      0,
    )).rejects.toThrow("injected");
    expect(source.bytes).toEqual(journalBytes());
    expect(entries["g0.seal"]!.len()).toBe(0);
    expect(entries["g0.journal"]!.len()).toBe(0);
    expect(entries["g0.index"]!.len()).toBe(0);
    expect(canceled).toBe((file === "g0.seal" || file === "g0.index") && fault === "failNextWrite");
  });

  it("reports failed compaction target reclamation without replacing the source error", async () => {
    const source = new MemoryStorage(journalBytes());
    const entries: Record<string, MemoryStorage> = {
      "legacy.journal": source,
      "g0.journal": new MemoryStorage(),
      "g0.index": new MemoryStorage(),
      "g0.seal": new MemoryStorage(),
    };
    const failures: string[] = [];
    await expect(compactOverlayGeneration(
      { journal: source, slot: "legacy", generation: 0, sealedLength: 0 },
      files(entries),
      {
        prepare: (target) => { target.writeAllAt(0, source.bytes); },
        checkpoint: (index) => {
          index.writeAllAt(0, Uint8Array.of(1, 2, 3));
          entries["g0.journal"]!.failNextTruncate = true;
          throw Object.assign(new Error("checkpoint quota exceeded"), { code: "ENOSPC" });
        },
        activate: () => { throw new Error("unexpected activation"); },
        fail: () => {}, cancel: () => {},
      },
      0,
      () => true,
      (error) => { failures.push(String(error)); },
    )).rejects.toMatchObject({ code: "ENOSPC" });
    expect(failures).toEqual(["Error: injected truncate failure"]);
    expect(entries["g0.seal"]!.len()).toBe(0);
    expect(entries["g0.index"]!.len()).toBe(0);
    expect(entries["g0.journal"]!.len()).toBe(source.len());
    expect(source.len()).toBe(72);
  });
});
