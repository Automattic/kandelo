import { GroupProcessAddressSpace, NativeI32Observation, ProcessAddressFault } from './process-address-space';

/** Genuine native storage or an explicit virtual root. A grouped root has no
 * native .buffer, so unadapted pointer arithmetic remains a type error.
 */
export type ProcessMemorySource = WebAssembly.Memory | GroupProcessAddressSpace;
export type ProcessDataView = Pick<DataView,
  'byteOffset' | 'byteLength' | 'getInt8' | 'getUint8' | 'getInt16' | 'getUint16'
  | 'getInt32' | 'getUint32' | 'getFloat32' | 'getFloat64' | 'getBigInt64' | 'getBigUint64'
  | 'setInt8' | 'setUint8' | 'setInt16' | 'setUint16' | 'setInt32' | 'setUint32'
  | 'setFloat32' | 'setFloat64' | 'setBigInt64' | 'setBigUint64'>;

// The native branch must still receive a real Memory, not an object whose
// .buffer getter presents a physical group backing as a linear guest buffer.
const nativeBuffer = Function.prototype.call.bind(Object.getOwnPropertyDescriptor(
  WebAssembly.Memory.prototype, 'buffer')!.get!) as (memory: WebAssembly.Memory) => ArrayBufferLike;
function range(offset: number, length: number, limit: number): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length)
      || offset < 0 || length < 0 || offset > limit || length > limit - offset) {
    throw new ProcessAddressFault('bounds');
  }
}
export function processMemoryByteLength(memory: ProcessMemorySource): number {
  return memory instanceof GroupProcessAddressSpace ? memory.byteLength : nativeBuffer(memory).byteLength;
}
export function readProcessBytes(memory: ProcessMemorySource, address: number, length: number): Uint8Array {
  if (memory instanceof GroupProcessAddressSpace) return memory.readBytes(address, length);
  const buffer = nativeBuffer(memory); range(address, length, buffer.byteLength);
  return new Uint8Array(buffer, address, length).slice();
}
export function checkProcessWriteRange(memory: ProcessMemorySource, address: number, length: number): void {
  if (memory instanceof GroupProcessAddressSpace) memory.checkWritableRange(address, length);
  else range(address, length, nativeBuffer(memory).byteLength);
}
/** Sealed streaming consumers may borrow native bytes while the image remains
 * pinned. Discontiguous grouped storage is copied explicitly; this function
 * promises neither a writable alias nor zero-copy access on every backend.
 */
export function borrowOrCopyProcessBytes(memory: ProcessMemorySource, address: number, length: number): {
  readonly bytes: Uint8Array; readonly borrowed: boolean;
} {
  if (memory instanceof GroupProcessAddressSpace) return { bytes: memory.readBytes(address, length), borrowed: false };
  const buffer = nativeBuffer(memory); range(address, length, buffer.byteLength);
  return { bytes: new Uint8Array(buffer, address, length), borrowed: true };
}
export function writeProcessBytes(memory: ProcessMemorySource, address: number, source: Uint8Array): void {
  if (memory instanceof GroupProcessAddressSpace) { memory.writeBytes(address, source); return; }
  const buffer = nativeBuffer(memory); range(address, source.byteLength, buffer.byteLength);
  new Uint8Array(buffer, address, source.byteLength).set(source);
}
export function fillProcessBytes(memory: ProcessMemorySource, address: number, length: number, value: number): void {
  if (memory instanceof GroupProcessAddressSpace) { memory.fillBytes(address, length, value); return; }
  const buffer = nativeBuffer(memory); range(address, length, buffer.byteLength);
  new Uint8Array(buffer, address, length).fill(value);
}

/** Explicit scalar accessor, never an ArrayBuffer substitute or global proxy.
 * Each virtual access validates the view extent and current root ownership.
 * Owned scalar staging cannot escape as a writable alias of guest storage.
 */
class VirtualProcessDataView implements ProcessDataView {
  constructor(private readonly memory: GroupProcessAddressSpace,
    readonly byteOffset: number, readonly byteLength: number) {}
  private read(offset: number, size: number): DataView {
    range(offset, size, this.byteLength);
    const bytes = this.memory.readBytes(this.byteOffset + offset, size);
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  private write(offset: number, size: number, store: (view: DataView) => void): void {
    range(offset, size, this.byteLength);
    const bytes = new Uint8Array(size); store(new DataView(bytes.buffer));
    this.memory.writeBytes(this.byteOffset + offset, bytes);
  }
  getInt8(offset: number): number { return this.read(offset, 1).getInt8(0); }
  getUint8(offset: number): number { return this.read(offset, 1).getUint8(0); }
  getInt16(offset: number, littleEndian = false): number { return this.read(offset, 2).getInt16(0, littleEndian); }
  getUint16(offset: number, littleEndian = false): number { return this.read(offset, 2).getUint16(0, littleEndian); }
  getInt32(offset: number, littleEndian = false): number { return this.read(offset, 4).getInt32(0, littleEndian); }
  getUint32(offset: number, littleEndian = false): number { return this.read(offset, 4).getUint32(0, littleEndian); }
  getFloat32(offset: number, littleEndian = false): number { return this.read(offset, 4).getFloat32(0, littleEndian); }
  getFloat64(offset: number, littleEndian = false): number { return this.read(offset, 8).getFloat64(0, littleEndian); }
  getBigInt64(offset: number, littleEndian = false): bigint { return this.read(offset, 8).getBigInt64(0, littleEndian); }
  getBigUint64(offset: number, littleEndian = false): bigint { return this.read(offset, 8).getBigUint64(0, littleEndian); }
  setInt8(offset: number, value: number): void { this.write(offset, 1, view => view.setInt8(0, value)); }
  setUint8(offset: number, value: number): void { this.write(offset, 1, view => view.setUint8(0, value)); }
  setInt16(offset: number, value: number, littleEndian = false): void { this.write(offset, 2, view => view.setInt16(0, value, littleEndian)); }
  setUint16(offset: number, value: number, littleEndian = false): void { this.write(offset, 2, view => view.setUint16(0, value, littleEndian)); }
  setInt32(offset: number, value: number, littleEndian = false): void { this.write(offset, 4, view => view.setInt32(0, value, littleEndian)); }
  setUint32(offset: number, value: number, littleEndian = false): void { this.write(offset, 4, view => view.setUint32(0, value, littleEndian)); }
  setFloat32(offset: number, value: number, littleEndian = false): void { this.write(offset, 4, view => view.setFloat32(0, value, littleEndian)); }
  setFloat64(offset: number, value: number, littleEndian = false): void { this.write(offset, 8, view => view.setFloat64(0, value, littleEndian)); }
  setBigInt64(offset: number, value: bigint, littleEndian = false): void { this.write(offset, 8, view => view.setBigInt64(0, value, littleEndian)); }
  setBigUint64(offset: number, value: bigint, littleEndian = false): void { this.write(offset, 8, view => view.setBigUint64(0, value, littleEndian)); }
}
export function processDataView(memory: ProcessMemorySource, address = 0, length?: number): ProcessDataView {
  if (memory instanceof GroupProcessAddressSpace) {
    const size = memory.byteLength, extent = length ?? size - address;
    range(address, extent, size);
    return new VirtualProcessDataView(memory, address, extent);
  }
  const buffer = nativeBuffer(memory), extent = length ?? buffer.byteLength - address;
  range(address, extent, buffer.byteLength);
  return new DataView(buffer, address, extent);
}

/** Read-only capture for one synchronous syscall plan. Native bytes keep the
 * exact buffer extent observed at entry; a concurrent grow cannot enlarge its
 * range proof. Virtual reads retain that captured limit and recheck live root
 * rights on every access. No physical group buffer or writable alias escapes.
 */
export interface CapturedProcessRead {
  readonly byteLength: number;
  readBytes(address: number, length: number): Uint8Array;
  dataView(address: number, length?: number): Pick<ProcessDataView,
    'byteLength' | 'getInt8' | 'getUint8' | 'getInt16' | 'getUint16' | 'getInt32' | 'getUint32'
    | 'getFloat32' | 'getFloat64' | 'getBigInt64' | 'getBigUint64'>;
  /** Relative NUL offset, or -1. Does not probe a later virtual page after NUL. */
  findZero(address: number, length: number): number;
}
class NativeCapturedProcessRead implements CapturedProcessRead {
  private readonly bytes: Uint8Array;
  readonly byteLength: number;
  constructor(source: WebAssembly.Memory) {
    this.bytes = new Uint8Array(nativeBuffer(source));
    this.byteLength = this.bytes.byteLength;
  }
  readBytes(address: number, length: number): Uint8Array {
    range(address, length, this.byteLength); return this.bytes.slice(address, address + length);
  }
  dataView(address: number, length = this.byteLength - address): DataView {
    range(address, length, this.byteLength); return new DataView(this.bytes.buffer, address, length);
  }
  findZero(address: number, length: number): number {
    range(address, length, this.byteLength); return this.bytes.subarray(address, address + length).indexOf(0);
  }
}
class VirtualCapturedProcessRead implements CapturedProcessRead {
  readonly byteLength: number;
  constructor(private readonly source: GroupProcessAddressSpace) { this.byteLength = source.byteLength; }
  readBytes(address: number, length: number): Uint8Array {
    range(address, length, this.byteLength); return this.source.readBytes(address, length);
  }
  dataView(address: number, length = this.byteLength - address): DataView {
    const bytes = this.readBytes(address, length);
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  findZero(address: number, length: number): number {
    range(address, length, this.byteLength);
    if (length === 0) { this.source.readBytes(address, 0); return -1; }
    for (let at = 0; at < length;) {
      const size = Math.min(length - at, 65536 - (address + at) % 65536);
      const nul = this.source.readBytes(address + at, size).indexOf(0);
      if (nul >= 0) return at + nul;
      at += size;
    }
    return -1;
  }
}
export function captureProcessRead(source: ProcessMemorySource): CapturedProcessRead {
  // Methods live on prototypes: syscall entry must not allocate three closures
  // just to keep a fixed native read extent or the virtual root's liveness.
  return source instanceof GroupProcessAddressSpace
    ? new VirtualCapturedProcessRead(source) : new NativeCapturedProcessRead(source);
}

/** Retain one exact engine-wait target; never expose a group's backing view. */
export function prepareProcessNativeObservationI32(source: ProcessMemorySource, address: number): NativeI32Observation {
  if (source instanceof GroupProcessAddressSpace) throw new ProcessAddressFault('metadata');
  const buffer = nativeBuffer(source);
  range(address, 4, buffer.byteLength);
  if (address % 4 || !(buffer instanceof SharedArrayBuffer)) throw new ProcessAddressFault('bounds');
  return new NativeI32Observation(new Int32Array(buffer, address, 1));
}
