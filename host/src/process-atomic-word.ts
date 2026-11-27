import { GroupProcessAddressSpace } from './process-address-space';
import { ForkShareAddressSpace } from './fork-share-address-space';
import type { ProcessMemorySource } from './process-memory-views';
import type { GroupedWorkerWait32 } from './worker-channel-ipc';

const nativeBuffer = Function.prototype.call.bind(Object.getOwnPropertyDescriptor(
  WebAssembly.Memory.prototype, 'buffer')!.get!) as (memory: WebAssembly.Memory) => ArrayBufferLike;

/** Internal virtual atomic word, not a typed-array substitute. Every access
 * refreshes its view and proves current mapping/owner rights. Grouped waits
 * use the calling replica's C queue and controls; no physical pointer escapes.
 */
export class ProcessAtomicI32 {
  constructor(private readonly source: ProcessMemorySource, readonly address: number,
    private readonly groupedWait32?: GroupedWorkerWait32) {
    if (source instanceof GroupProcessAddressSpace && typeof groupedWait32 !== 'function') {
      throw new Error('Grouped atomic waits require their replica-bound translated wait');
    }
  }
  private native(): Int32Array {
    if (this.source instanceof ForkShareAddressSpace) return this.source.atomicWord(this.address);
    return new Int32Array(nativeBuffer(this.source as WebAssembly.Memory), this.address, 1);
  }
  load(): number {
    return this.source instanceof GroupProcessAddressSpace
      ? this.source.atomicLoadI32(this.address) : Atomics.load(this.native(), 0);
  }
  store(value: number): number {
    return this.source instanceof GroupProcessAddressSpace
      ? this.source.atomicStoreI32(this.address, value) : Atomics.store(this.native(), 0, value);
  }
  compareExchange(expected: number, replacement: number): number {
    return this.source instanceof GroupProcessAddressSpace
      ? this.source.atomicCompareExchangeI32(this.address, expected, replacement)
      : Atomics.compareExchange(this.native(), 0, expected, replacement);
  }
  wait(expected: number): 'ok' | 'not-equal' | 'timed-out' {
    if (!(this.source instanceof GroupProcessAddressSpace)) return Atomics.wait(this.native(), 0, expected);
    this.source.atomicLoadI32(this.address); // Prove this JS handle remains live before entering C.
    const result = this.groupedWait32!(this.address, expected, -1n);
    if (result === 0) return 'ok';
    if (result === 1) return 'not-equal';
    if (result === 2) return 'timed-out';
    throw new Error('Invalid translated atomic wait result');
  }
  notify(count = 0xffffffff): number {
    return this.source instanceof GroupProcessAddressSpace
      ? this.source.notifyI32(this.address, count) : Atomics.notify(this.native(), 0, count);
  }
}

export class ProcessAtomicU64 {
  constructor(private readonly source: ProcessMemorySource, readonly address: number) {}
  private native(): BigUint64Array {
    if (this.source instanceof ForkShareAddressSpace) return this.source.atomicLong(this.address);
    return new BigUint64Array(nativeBuffer(this.source as WebAssembly.Memory), this.address, 1);
  }
  load(): bigint {
    return this.source instanceof GroupProcessAddressSpace
      ? this.source.atomicLoadU64(this.address) : Atomics.load(this.native(), 0);
  }
  store(value: bigint): bigint {
    return this.source instanceof GroupProcessAddressSpace
      ? this.source.atomicStoreU64(this.address, value) : Atomics.store(this.native(), 0, value);
  }
}
