import { WASM_PAGE_SIZE } from "./constants";
import type { ProcessAddressSpace } from "./process-address-space";

const PAGE_OFFSET_MASK = WASM_PAGE_SIZE - 1;

/** The `DataView` accessors that host code uses on guest memory. */
export type ProcessDataView = Pick<
  DataView,
  | "getUint8" | "getInt16" | "getUint16" | "getInt32" | "getUint32"
  | "getBigInt64" | "getBigUint64"
  | "setUint8" | "setUint16" | "setInt32" | "setUint32"
  | "setBigInt64" | "setBigUint64"
>;

/**
 * A view of guest memory addressed by guest-virtual offsets.
 *
 * WHY: host code reads guest structures with `DataView` accessors at guest
 * addresses. With page tables a guest address is not a Memory offset, and a
 * write to a shared page must copy it first. The identity mapping returns
 * a plain `DataView`, so a process without page tables pays nothing.
 */
export function processDataView(space: ProcessAddressSpace): ProcessDataView {
  if (space.location === null) return new DataView(space.memory.buffer);
  return new TranslatedDataView(space);
}

class TranslatedDataView implements ProcessDataView {
  readonly #space: ProcessAddressSpace;
  #memory: DataView;

  constructor(space: ProcessAddressSpace) {
    this.#space = space;
    this.#memory = new DataView(space.memory.buffer);
  }

  getUint8(address: number): number {
    return this.#current().getUint8(this.#space.readable(address));
  }

  getInt16(address: number, littleEndian?: boolean): number {
    return this.#source(address, 2).getInt16(this.#offset, littleEndian);
  }

  getUint16(address: number, littleEndian?: boolean): number {
    return this.#source(address, 2).getUint16(this.#offset, littleEndian);
  }

  getInt32(address: number, littleEndian?: boolean): number {
    return this.#source(address, 4).getInt32(this.#offset, littleEndian);
  }

  getUint32(address: number, littleEndian?: boolean): number {
    return this.#source(address, 4).getUint32(this.#offset, littleEndian);
  }

  getBigInt64(address: number, littleEndian?: boolean): bigint {
    return this.#source(address, 8).getBigInt64(this.#offset, littleEndian);
  }

  getBigUint64(address: number, littleEndian?: boolean): bigint {
    return this.#source(address, 8).getBigUint64(this.#offset, littleEndian);
  }

  setUint8(address: number, value: number): void {
    const offset = this.#space.writable(address);
    this.#current().setUint8(offset, value);
  }

  setUint16(address: number, value: number, littleEndian?: boolean): void {
    this.#store(address, 2, (view, offset) => view.setUint16(offset, value, littleEndian));
  }

  setInt32(address: number, value: number, littleEndian?: boolean): void {
    this.#store(address, 4, (view, offset) => view.setInt32(offset, value, littleEndian));
  }

  setUint32(address: number, value: number, littleEndian?: boolean): void {
    this.#store(address, 4, (view, offset) => view.setUint32(offset, value, littleEndian));
  }

  setBigInt64(address: number, value: bigint, littleEndian?: boolean): void {
    this.#store(address, 8, (view, offset) => view.setBigInt64(offset, value, littleEndian));
  }

  setBigUint64(address: number, value: bigint, littleEndian?: boolean): void {
    this.#store(address, 8, (view, offset) => view.setBigUint64(offset, value, littleEndian));
  }

  #offset = 0;

  /**
   * WHY: a write to a shared page can grow the Memory, and so can another
   * process of the group. A view of the old buffer does not reach the new
   * pages, so every access checks for a new buffer after translation.
   */
  #current(): DataView {
    const buffer = this.#space.memory.buffer;
    if (this.#memory.buffer !== buffer) this.#memory = new DataView(buffer);
    return this.#memory;
  }

  #source(address: number, size: number): DataView {
    if ((address & PAGE_OFFSET_MASK) + size <= WASM_PAGE_SIZE) {
      this.#offset = this.#space.readable(address);
      return this.#current();
    }
    this.#offset = 0;
    return new DataView(this.#space.read(address, size).buffer);
  }

  #store(
    address: number,
    size: number,
    store: (view: DataView, offset: number) => void,
  ): void {
    if ((address & PAGE_OFFSET_MASK) + size <= WASM_PAGE_SIZE) {
      const offset = this.#space.writable(address);
      store(this.#current(), offset);
      return;
    }
    const bytes = new Uint8Array(size);
    store(new DataView(bytes.buffer), 0);
    this.#space.write(address, bytes);
  }
}
