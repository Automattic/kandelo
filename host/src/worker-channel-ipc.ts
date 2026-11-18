import { CH_STATUS, CHANNEL_STATUS_PENDING, CHANNEL_STATUS_IDLE } from './generated/abi';
import { GroupProcessAddressSpace } from './process-address-space';
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
      this.source.notifyI32(statusAddress, 1);
      waitForGroupedChannelCompletion(this.groupedWait32!, statusAddress);
    } else {
      const words = new Int32Array(this.source.buffer);
      Atomics.store(words, statusAddress / 4, CHANNEL_STATUS_PENDING);
      Atomics.notify(words, statusAddress / 4, 1);
      waitForChannelCompletion(words, statusAddress / 4);
    }
  }

  resetStatus(): void {
    const statusAddress = this.offset + CH_STATUS;
    if (this.source instanceof GroupProcessAddressSpace) {
      this.source.atomicStoreI32(statusAddress, CHANNEL_STATUS_IDLE);
    } else {
      Atomics.store(new Int32Array(this.source.buffer), statusAddress / 4, CHANNEL_STATUS_IDLE);
    }
  }
}
