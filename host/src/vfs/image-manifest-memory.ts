import { StorageMemoryBudget, STORAGE_ENTRY_BYTES, storageMetadataError, type StorageMemoryReservation } from "./storage-memory-budget";

export const MAX_IMAGE_MANIFEST_BYTES = 8 * 1024 * 1024;
export const IMAGE_MANIFEST_MEMORY_BYTES = 64 * 1024 * 1024;
export const imageJsonOperationMemory = new StorageMemoryBudget(IMAGE_MANIFEST_MEMORY_BYTES);
const JSON_MEMORY_FACTOR = 12;
const MAX_JSON_DEPTH = 64;

export class ImageManifestMemoryScope {
  private readonly admission: StorageMemoryReservation;
  private disposed = false;

  constructor(private readonly budget: StorageMemoryBudget) {
    this.admission = budget.reserve(STORAGE_ENTRY_BYTES);
  }

  retain(bytes: number): void {
    if (this.disposed) throw new Error("Image manifest memory scope is disposed");
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_IMAGE_MANIFEST_BYTES) throw storageMetadataError();
    this.admission.resize(this.admission.size + STORAGE_ENTRY_BYTES + bytes * JSON_MEMORY_FACTOR);
  }

  encode(value: unknown): string {
    if (this.disposed) throw new Error("Image manifest memory scope is disposed");
    const traversal = this.budget.reserve(MAX_JSON_DEPTH * 128);
    const previous = this.admission.size;
    try {
      const parents = new Set<object>();
      let bytes = 0;
      const add = (count: number) => {
        bytes += count;
        if (bytes > MAX_IMAGE_MANIFEST_BYTES) throw storageMetadataError();
        this.admission.resize(previous + STORAGE_ENTRY_BYTES + bytes * JSON_MEMORY_FACTOR);
      };
      const stringBytes = (text: string): number => {
        if (text.length > MAX_IMAGE_MANIFEST_BYTES) throw storageMetadataError();
        let length = 2;
        for (let index = 0; index < text.length; index++) {
          const code = text.charCodeAt(index);
          if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) length += 2;
          else if (code < 32) length += 6;
          else if (code < 128) length++;
          else if (code < 2048) length += 2;
          else if (code >= 0xd800 && code <= 0xdbff && text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff) {
            length += 4;
            index++;
          } else length += code >= 0xd800 && code <= 0xdfff ? 6 : 3;
        }
        return length;
      };
      const visit = (entry: unknown, depth: number): void => {
        if (entry === null || entry === undefined) { add(4); return; }
        if (typeof entry === "string") { add(stringBytes(entry)); return; }
        if (typeof entry === "boolean") { add(entry ? 4 : 5); return; }
        if (typeof entry === "number") { add(Number.isFinite(entry) ? String(entry).length : 4); return; }
        if (typeof entry !== "object" || depth >= MAX_JSON_DEPTH || parents.has(entry)) {
          throw new TypeError("Image manifest requires bounded acyclic JSON data");
        }
        const array = Array.isArray(entry);
        const prototype = Object.getPrototypeOf(entry);
        if (prototype !== (array ? Array.prototype : Object.prototype) && !(prototype === null && !array)) {
          throw new TypeError("Image manifest requires plain JSON data");
        }
        const conversion = Object.getOwnPropertyDescriptor(entry, "toJSON");
        if (conversion !== undefined && (!("value" in conversion) || typeof conversion.value === "function")) {
          throw new TypeError("Image manifest refuses JSON conversion hooks");
        }
        parents.add(entry);
        add(2);
        if (array) {
          for (let index = 0; index < entry.length; index++) {
            if (index !== 0) add(1);
            const descriptor = Object.getOwnPropertyDescriptor(entry, String(index));
            if (descriptor !== undefined && !("value" in descriptor)) throw new TypeError("Image manifest refuses JSON accessors");
            visit(descriptor?.value, depth + 1);
          }
        } else {
          let count = 0;
          for (const key in entry) {
            if (!Object.hasOwn(entry, key)) continue;
            const descriptor = Object.getOwnPropertyDescriptor(entry, key)!;
            if (!("value" in descriptor)) throw new TypeError("Image manifest refuses JSON accessors");
            if (descriptor.value === undefined) continue;
            add((count++ === 0 ? 0 : 1) + stringBytes(key) + 1);
            visit(descriptor.value, depth + 1);
          }
        }
        parents.delete(entry);
      };
      visit(value, 0);
      if (value === undefined) throw new TypeError("Image manifest requires JSON data");
      return JSON.stringify(value);
    } catch (error) { this.admission.resize(previous); throw error; }
    finally { traversal.release(); }
  }

  dispose(): void {
    if (this.disposed) return;
    this.admission.release();
    this.disposed = true;
  }
}
