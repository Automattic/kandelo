import { CH_STATUS, CHANNEL_STATUS_PENDING, CHANNEL_STATUS_IDLE, CH_SYSCALL, CH_ARGS, CH_ARG_SIZE, CH_RETURN, CH_ERRNO, CH_REQUEST_FLAGS, EXTENSION_REQUEST_MEMORY_GROUP_GROW_V1 } from './generated/abi';
import { GroupProcessAddressSpace } from './process-address-space';
import { ForkShareAddressSpace } from './fork-share-address-space';
import { processDataView, type ProcessDataView, type ProcessMemorySource } from './process-memory-views';
import { waitForChannelCompletion, waitForGroupedChannelCompletion } from './channel-completion-wait';

export type GroupedWorkerWait32 = (address: number, expected: number, timeout: bigint) => number;

/** Internal disposable-Worker channel access. Offsets are virtual bytes;
 * grouped guest waits require the admitted instance's replica-bound C entry.
 * Native kernel listeners are separate observers, never substitute guest waits.
 */
export class WorkerChannelIPC {
  constructor(
    private readonly source: ProcessMemorySource,
    readonly offset: number,
    private readonly groupedWait32?: GroupedWorkerWait32,
  ) {
    if (source instanceof GroupProcessAddressSpace && typeof groupedWait32 !== 'function') {
      throw new Error('Grouped kernel imports require their replica-bound translated wait');
    }
  }

  view(): ProcessDataView { return processDataView(this.source); }

  publishAndWait(): void {
    const statusAddress = this.offset + CH_STATUS;
    if (this.source instanceof GroupProcessAddressSpace) {
      this.source.atomicStoreI32(statusAddress, CHANNEL_STATUS_PENDING);
      this.source.notifyKernelObserverI32(statusAddress, 1);
      waitForGroupedChannelCompletion(this.groupedWait32!, statusAddress);
    } else {
      const { words, index } = this.status();
      Atomics.store(words, index, CHANNEL_STATUS_PENDING);
      Atomics.notify(words, index, 1);
      waitForChannelCompletion(words, index);
    }
  }

  /** Grouped-only SDK transport. Rust selects frames and publishes the extent. */
  growPrivate(delta: number): number {
    if (!(this.source instanceof GroupProcessAddressSpace)) throw Error('Private group growth requires its admitted channel');
    let view = this.view();
    view.setUint32(this.offset + CH_SYSCALL, EXTENSION_REQUEST_MEMORY_GROUP_GROW_V1, true);
    for (let arg = 0; arg < 6; arg++) view.setBigUint64(this.offset + CH_ARGS + arg * CH_ARG_SIZE,
      arg === 0 ? BigInt(delta >>> 0) : 0n, true);
    view.setUint32(this.offset + CH_REQUEST_FLAGS, 0, true);
    this.publishAndWait();
    view = this.view();
    const result = view.getBigInt64(this.offset + CH_RETURN, true), errno = view.getUint32(this.offset + CH_ERRNO, true);
    view.setUint32(this.offset + CH_REQUEST_FLAGS, 0, true);
    this.resetStatus();
    if (errno) throw Error(`Kernel refused SDK private growth transport: errno ${errno}`);
    if (result < -1n || result > 65536n) throw Error('Invalid kernel SDK growth result');
    return Number(result) >>> 0;
  }

  resetStatus(): void {
    const statusAddress = this.offset + CH_STATUS;
    if (this.source instanceof GroupProcessAddressSpace) {
      this.source.atomicStoreI32(statusAddress, CHANNEL_STATUS_IDLE);
    } else {
      const { words, index } = this.status();
      Atomics.store(words, index, CHANNEL_STATUS_IDLE);
    }
  }

  private status(): { words: Int32Array; index: number } {
    const statusAddress = this.offset + CH_STATUS;
    if (this.source instanceof ForkShareAddressSpace) return { words: this.source.atomicWord(statusAddress), index: 0 };
    return { words: new Int32Array((this.source as WebAssembly.Memory).buffer), index: statusAddress / 4 };
  }
}
