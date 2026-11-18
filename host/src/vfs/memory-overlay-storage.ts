import { hostFilePositionToSafeNumber } from "../file-offset";
import type { HostFileOffset } from "../types";
import type { OverlayActivationCodec } from "./overlay-activation-codec";
import type { OverlayGenerationMetadata } from "./overlay-generation-metadata";
import type {
  OverlayGenerationFile,
  OverlayGenerationFiles,
  OverlayGenerationSlot,
} from "./overlay-generation-selection";
import type { OverlaySealCodec } from "./overlay-seal-codec";
import { OverlayStorageUnexpectedEofError, type PersistentOverlayStorage } from "./overlay-storage";

/**
 * One overlay file held in this realm's memory.
 *
 * A machine restored from a checkpoint of a computer kept in browser storage
 * runs on copies of that computer's journal files. The copies live here, so
 * nothing the replica writes reaches this computer's own storage. A flush has
 * nothing beneath it to reach, which is what a replica's durability is.
 */
export class MemoryOverlayStorage implements PersistentOverlayStorage {
  #bytes: Uint8Array;
  #length: number;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
    this.#length = bytes.byteLength;
  }

  len(): number {
    return this.#length;
  }

  readExactAt(offset: HostFileOffset, destination: Uint8Array): void {
    const start = hostFilePositionToSafeNumber(offset);
    if (start + destination.byteLength > this.#length) throw new OverlayStorageUnexpectedEofError();
    destination.set(this.#bytes.subarray(start, start + destination.byteLength));
  }

  writeAllAt(offset: HostFileOffset, source: Uint8Array): void {
    const start = hostFilePositionToSafeNumber(offset);
    const end = start + source.byteLength;
    if (!Number.isSafeInteger(end)) throw Object.assign(new Error("EOVERFLOW: persistent overlay storage"), { code: "EOVERFLOW" });
    this.#reserve(end);
    this.#bytes.set(source, start);
    this.#length = Math.max(this.#length, end);
  }

  flush(): void {}

  truncate(length: HostFileOffset): void {
    const end = hostFilePositionToSafeNumber(length);
    this.#reserve(end);
    this.#bytes.fill(0, Math.min(end, this.#length), this.#length);
    this.#length = end;
  }

  close(): void {}

  #reserve(end: number): void {
    if (end <= this.#bytes.byteLength) return;
    const grown = new Uint8Array(Math.max(end, this.#bytes.byteLength * 2));
    grown.set(this.#bytes.subarray(0, this.#length));
    this.#bytes = grown;
  }
}

/** One file of a persistence directory, by its slot and role. */
export interface OverlayFileBytes {
  readonly slot: OverlayGenerationSlot;
  readonly file: OverlayGenerationFile;
  readonly bytes: Uint8Array;
}

/**
 * A persistence directory held in this realm's memory.
 *
 * `open` hands back the one storage each file has, so the journal the kernel
 * writes and the journal a compaction reads are the same bytes, as they are
 * the same file on disk.
 */
export class MemoryOverlayGenerationFiles implements OverlayGenerationFiles {
  readonly #files = new Map<string, MemoryOverlayStorage>();

  constructor(
    readonly activationCodec: OverlayActivationCodec,
    readonly sealCodec: OverlaySealCodec,
    readonly metadata: OverlayGenerationMetadata,
    files: readonly OverlayFileBytes[],
  ) {
    for (const { slot, file, bytes } of files) this.#files.set(`${slot}.${file}`, new MemoryOverlayStorage(bytes));
  }

  listSlots(): Iterable<string> {
    const slots = new Set<string>();
    for (const key of this.#files.keys()) {
      const [slot, file] = key.split(".");
      if (slot !== "legacy" && (file === "journal" || file === "index" || file === "seal")) slots.add(slot!);
    }
    return slots;
  }

  async open(slot: OverlayGenerationSlot, file: OverlayGenerationFile, create: boolean): Promise<MemoryOverlayStorage | null> {
    return this.storage(slot, file, create);
  }

  async remove(slot: OverlayGenerationSlot, file: OverlayGenerationFile): Promise<void> {
    this.#files.delete(`${slot}.${file}`);
  }

  /** The storage `open` would hand back, without waiting for it. */
  storage(slot: OverlayGenerationSlot, file: OverlayGenerationFile, create = false): MemoryOverlayStorage | null {
    const key = `${slot}.${file}`;
    const existing = this.#files.get(key);
    if (existing !== undefined || !create) return existing ?? null;
    const created = new MemoryOverlayStorage(new Uint8Array());
    this.#files.set(key, created);
    return created;
  }
}
