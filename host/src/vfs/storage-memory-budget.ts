import { ERRNO } from "../generated/abi";

export const DEFAULT_STORAGE_METADATA_BYTES = 16 * 1024 * 1024;
export const STORAGE_ENTRY_BYTES = 1024;

export interface StorageMemoryUsage { used: number; peak: number; limit: number }

export function validateStorageMemoryUsage(value: unknown): StorageMemoryUsage {
  if (value === null || typeof value !== "object") throw new Error("invalid storage memory usage");
  const usage = value as StorageMemoryUsage;
  if (![usage.used, usage.peak, usage.limit].every(Number.isSafeInteger) ||
    usage.used < 0 || usage.used > usage.peak || usage.peak > usage.limit || usage.limit <= 0) {
    throw new Error("invalid storage memory usage");
  }
  return { used: usage.used, peak: usage.peak, limit: usage.limit };
}

export function storageMetadataError(): Error & { code: string; errno: number } {
  return Object.assign(new Error("Host storage metadata memory budget exhausted"), {
    code: "ENOMEM", errno: ERRNO.ENOMEM,
  });
}

export function storageEntryBytes(key: string | number): number {
  return STORAGE_ENTRY_BYTES + (typeof key === "string" ? key.length * 2 : 8);
}

export class StorageMemoryBudget {
  #used = 0;
  #peak = 0;

  constructor(readonly limit = DEFAULT_STORAGE_METADATA_BYTES) {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError("Invalid host storage metadata budget");
  }

  get used(): number { return this.#used; }
  get peak(): number { return this.#peak; }

  snapshot(): StorageMemoryUsage { return { used: this.#used, peak: this.#peak, limit: this.limit }; }

  reserve(bytes: number): StorageMemoryReservation {
    this.#resize(0, bytes);
    let released = false;
    try {
      return Object.freeze({
        get size() { return bytes; },
        resize: (next: number) => {
          if (released) throw new Error("Host storage metadata reservation is released");
          this.#resize(bytes, next);
          bytes = next;
        },
        release: () => {
          if (released) return;
          this.#resize(bytes, 0);
          bytes = 0;
          released = true;
        },
      });
    } catch (error) { this.#resize(bytes, 0); throw error; }
  }

  #resize(previous: number, next: number): void {
    if (!Number.isSafeInteger(next) || next < 0 || next > this.limit - (this.#used - previous)) {
      throw storageMetadataError();
    }
    if (!Number.isSafeInteger(previous) || previous < 0 || previous > this.#used) {
      throw new Error("Invalid host storage metadata ownership");
    }
    this.#used += next - previous;
    this.#peak = Math.max(this.#peak, this.#used);
  }
}

export interface StorageMemoryReservation {
  readonly size: number;
  resize(bytes: number): void;
  release(): void;
}

export class StorageMetadataMap<Key extends string | number, Value> extends Map<Key, Value> {
  readonly #reservation: StorageMemoryReservation;
  #disposed = false;

  constructor(budget: StorageMemoryBudget) {
    super();
    this.#reservation = budget.reserve(STORAGE_ENTRY_BYTES);
  }

  override set(key: Key, value: Value): this {
    if (this.#disposed) throw new Error("Host storage metadata map is disposed");
    const previous = this.#reservation.size;
    if (!super.has(key)) this.#reservation.resize(previous + storageEntryBytes(key));
    try { super.set(key, value); }
    catch (error) { this.#reservation.resize(previous); throw error; }
    return this;
  }

  override delete(key: Key): boolean {
    if (!super.delete(key)) return false;
    this.#reservation.resize(this.#reservation.size - storageEntryBytes(key));
    return true;
  }

  override clear(): void {
    super.clear();
    if (!this.#disposed) this.#reservation.resize(STORAGE_ENTRY_BYTES);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.clear();
    this.#reservation.release();
    this.#disposed = true;
  }
}
