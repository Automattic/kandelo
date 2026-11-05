import {
  PCM_CONTROL as C, PCM_CONTROL_BYTES, PcmStreamState, PcmTransportFlag as F,
  pcmControlWords, pcmDataBytes, readConsumerPosition, readProducerPosition,
  readDiscardPosition, readPcmConfig, writeConsumerPosition, writeSeqlockedU64,
  signalPcmConsumerProgress, validatePcmTransport, type PcmTransportDescriptor,
} from "./pcm-transport";

/**
 * A bounded window for the persistent AudioWorklet realm. A subarray of kernel
 * Memory would retain its entire address-space reservation after machine exit.
 * Rust owns configuration/production; the worklet alone advances consumption.
 * This relay copies bytes and cursor publications, never advances the clock or
 * adds queue capacity. Its timer runs in the kernel Worker, not browser main.
 */
export class BrowserPcmMirror {
  readonly transport: PcmTransportDescriptor;
  private readonly source: Int32Array;
  private readonly target: Int32Array;
  private readonly sourceRing: Uint8Array;
  private readonly targetRing: Uint8Array;
  private generation = -1;
  private copiedProducer = 0n;
  private consumerWake = 0;
  private timer: ReturnType<typeof setInterval> | null;

  constructor(original: PcmTransportDescriptor) {
    validatePcmTransport(original);
    this.source = pcmControlWords(original);
    this.sourceRing = pcmDataBytes(original);
    this.transport = {
      buffer: new SharedArrayBuffer(PCM_CONTROL_BYTES + original.dataBytes),
      controlOffset: 0, controlBytes: PCM_CONTROL_BYTES,
      dataOffset: PCM_CONTROL_BYTES, dataBytes: original.dataBytes,
    };
    this.target = pcmControlWords(this.transport);
    this.targetRing = pcmDataBytes(this.transport);
    writeConsumerPosition(this.target, readConsumerPosition(this.source));
    this.sync();
    this.timer = setInterval(() => this.sync(), 2);
  }

  close(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  private sync(): void {
    const s = this.source, t = this.target;
    const config = readPcmConfig(s);
    const changed = config.generation !== this.generation;
    const wake = Atomics.load(t, C.wakeSeq);
    if (!changed && wake !== this.consumerWake) {
      // Cursor positions are monotonic across RESET/reopen. A discarded tail
      // is protected by Rust's discard floor even if an old quantum finishes.
      const consumed = readConsumerPosition(t);
      if (consumed > readConsumerPosition(s)) writeConsumerPosition(s, consumed);
      Atomics.store(s, C.underruns, Atomics.load(t, C.underruns));
      const hostFlags = Atomics.load(t, C.flags);
      if ((hostFlags & F.FatalError) !== 0) Atomics.or(s, C.flags, F.FatalError);
      if (config.state === PcmStreamState.Running) {
        Atomics.and(s, C.flags, ~F.UnderrunActive);
        Atomics.or(s, C.flags, hostFlags & F.UnderrunActive);
      }
      signalPcmConsumerProgress(s);
    }
    this.consumerWake = wake;

    const producer = readProducerPosition(s);
    const capacity = config.activeCapacityBytes;
    if (changed) Atomics.or(t, C.flags, F.Configuring);
    if (changed) {
      this.targetRing.set(this.sourceRing);
      Atomics.store(t, C.underruns, Atomics.load(s, C.underruns));
    } else if (capacity > 0) {
      const added = producer - this.copiedProducer;
      if (added < 0n || added > BigInt(capacity)) {
        this.targetRing.set(this.sourceRing);
      } else {
        let remaining = Number(added);
        let offset = Number(this.copiedProducer % BigInt(capacity));
        while (remaining > 0) {
          const count = Math.min(remaining, capacity - offset);
          this.targetRing.set(this.sourceRing.subarray(offset, offset + count), offset);
          remaining -= count;
          offset = 0;
        }
      }
    }
    // Never copy raw cursor halves: a concurrent reader needs their seqlocks.
    // Never overwrite the worklet-owned consumer cursor or wake sequence.
    for (const field of [C.magic, C.version, C.headerBytes, C.physicalCapacityBytes,
      C.activeCapacityBytes, C.format, C.sampleRate, C.channels, C.frameBytes,
      C.fragmentBytes, C.fragments, C.state, C.transportMode]) {
      Atomics.store(t, field, Atomics.load(s, field));
    }
    writeSeqlockedU64(t, C.producerSeq, C.producerLo, C.producerHi, producer);
    writeSeqlockedU64(t, C.discardSeq, C.discardLo, C.discardHi, readDiscardPosition(s));
    Atomics.store(t, C.generation, config.generation);
    // FatalError is latched by either owner; never overwrite a worklet error
    // that arrived while the producer snapshot was being copied.
    Atomics.or(t, C.flags, Atomics.load(s, C.flags) & ~F.Configuring);
    if (changed || config.state !== PcmStreamState.Running) {
      Atomics.and(t, C.flags, ~F.UnderrunActive);
    }
    if (changed) Atomics.and(t, C.flags, ~F.Configuring);
    this.generation = config.generation;
    this.copiedProducer = producer;
  }
}
