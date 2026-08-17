import {
  PCM_CONTROL,
  PCM_CONTROL_BYTES,
  PCM_CONTROL_MAGIC,
  PCM_CONTROL_VERSION,
  PCM_PHYSICAL_CAPACITY_BYTES,
  PcmSampleFormat,
  PcmStreamState,
  pcmControlWords,
  pcmDataBytes,
  storeU32,
  writeConsumerPosition,
  writeSeqlockedU64,
  type PcmTransportDescriptor,
} from "../src/audio/pcm-transport";
import { createCentralizedKernelWorkerTestDouble } from "../src/kernel-worker";
import {
  createKernelEntryGatedInstance,
  KernelEntryGate,
} from "../src/kernel-entry-gate";
import { allocateKernelScratchRegion } from "../src/kernel-scratch";
import { createKernelScratchTestInstance } from "./support/kernel-scratch-instance";

export interface PcmTransportTestOptions {
  activeCapacityBytes?: number;
  format?: PcmSampleFormat;
  sampleRate?: number;
  channels?: number;
  frameBytes?: number;
  fragmentBytes?: number;
  fragments?: number;
  state?: PcmStreamState;
  generation?: number;
  flags?: number;
}

export function createPcmTransport(
  options: PcmTransportTestOptions = {},
): PcmTransportDescriptor {
  const buffer = new SharedArrayBuffer(
    PCM_CONTROL_BYTES + PCM_PHYSICAL_CAPACITY_BYTES,
  );
  const descriptor: PcmTransportDescriptor = {
    buffer,
    controlOffset: 0,
    controlBytes: PCM_CONTROL_BYTES,
    dataOffset: PCM_CONTROL_BYTES,
    dataBytes: PCM_PHYSICAL_CAPACITY_BYTES,
  };
  const words = pcmControlWords(descriptor);
  storeU32(words, PCM_CONTROL.magic, PCM_CONTROL_MAGIC);
  storeU32(words, PCM_CONTROL.version, PCM_CONTROL_VERSION);
  storeU32(words, PCM_CONTROL.headerBytes, PCM_CONTROL_BYTES);
  storeU32(
    words,
    PCM_CONTROL.physicalCapacityBytes,
    PCM_PHYSICAL_CAPACITY_BYTES,
  );
  storeU32(
    words,
    PCM_CONTROL.activeCapacityBytes,
    options.activeCapacityBytes ?? 4096,
  );
  storeU32(words, PCM_CONTROL.format, options.format ?? PcmSampleFormat.S16Le);
  storeU32(words, PCM_CONTROL.sampleRate, options.sampleRate ?? 48_000);
  storeU32(words, PCM_CONTROL.channels, options.channels ?? 2);
  storeU32(words, PCM_CONTROL.frameBytes, options.frameBytes ?? 4);
  storeU32(words, PCM_CONTROL.fragmentBytes, options.fragmentBytes ?? 512);
  storeU32(words, PCM_CONTROL.fragments, options.fragments ?? 8);
  storeU32(words, PCM_CONTROL.state, options.state ?? PcmStreamState.Running);
  storeU32(words, PCM_CONTROL.generation, options.generation ?? 1);
  storeU32(words, PCM_CONTROL.flags, options.flags ?? 0);
  return descriptor;
}

const PCM_TEST_CONTROL_OFFSET = 4096;
const PCM_TEST_SCRATCH_OFFSET = 2 * 65_536;
const PCM_TEST_SCRATCH_CAPACITY = 65_536;

/**
 * Build a genuine gated Wasm generation around the PCM test transport.
 *
 * WHY: the integration worker deliberately seals its entry surface and keeps
 * the kernel/gate as JavaScript private fields. PCM tests must exercise that
 * production authority boundary instead of manufacturing an unbranded object
 * with replaceable pseudo-kernel methods.
 */
export function createPcmKernelWorker(options: {
  transport?: PcmTransportTestOptions;
  observeConsumerWake?: boolean;
  beforeClaim?: (descriptor: PcmTransportDescriptor) => void;
  claimTransport?: (
    mode: number,
    descriptor: PcmTransportDescriptor,
  ) => number;
  reconcile?: (descriptor: PcmTransportDescriptor) => number;
  clockUpdate?: (
    requestedFrames: number,
    descriptor: PcmTransportDescriptor,
  ) => number;
} = {}): {
  readonly worker: ReturnType<typeof createCentralizedKernelWorkerTestDouble>;
  readonly descriptor: PcmTransportDescriptor;
  readonly gate: KernelEntryGate;
} {
  const memory = new WebAssembly.Memory({
    initial: 3,
    maximum: 3,
    shared: true,
  });
  const buffer = memory.buffer as SharedArrayBuffer;
  const template = createPcmTransport(options.transport);
  const totalBytes = PCM_CONTROL_BYTES + PCM_PHYSICAL_CAPACITY_BYTES;
  new Uint8Array(buffer, PCM_TEST_CONTROL_OFFSET, totalBytes).set(
    new Uint8Array(template.buffer),
  );
  const transport: PcmTransportDescriptor = {
    buffer,
    controlOffset: PCM_TEST_CONTROL_OFFSET,
    controlBytes: PCM_CONTROL_BYTES,
    dataOffset: PCM_TEST_CONTROL_OFFSET + PCM_CONTROL_BYTES,
    dataBytes: PCM_PHYSICAL_CAPACITY_BYTES,
  };
  options.beforeClaim?.(transport);

  const implementations: Record<string, unknown> = {
    kernel_drain_wakeup_events: () => 0,
    kernel_pcm_transport_ptr: () => PCM_TEST_CONTROL_OFFSET,
    kernel_pcm_transport_len: () => totalBytes,
    kernel_pcm_claim_transport: (mode: number) =>
      options.claimTransport?.(mode, transport) ?? 0,
    kernel_pcm_reconcile: () => options.reconcile?.(transport) ?? 0,
    kernel_pcm_clock_update: (requestedFrames: number) =>
      options.clockUpdate?.(requestedFrames >>> 0, transport) ?? 0,
  };
  const gate = new KernelEntryGate();
  const rawInstance = createKernelScratchTestInstance(
    4,
    memory,
    () => implementations,
    () => PCM_TEST_SCRATCH_OFFSET,
    4,
    [
      "kernel_drain_wakeup_events",
      "kernel_pcm_claim_transport",
      "kernel_pcm_clock_update",
      "kernel_pcm_reconcile",
      "kernel_pcm_transport_len",
      "kernel_pcm_transport_ptr",
    ],
  );
  const instance = createKernelEntryGatedInstance(rawInstance, gate);
  const scratch = allocateKernelScratchRegion(
    memory,
    instance.exports.kernel_alloc_scratch as (capacity: number) => number,
    PCM_TEST_SCRATCH_CAPACITY,
    4,
    "PCM worker test scratch",
    instance,
  );
  const worker = createCentralizedKernelWorkerTestDouble();
  worker.testAuthority.initializeKernelForTest({
    instance,
    gate,
    mainScratch: scratch,
    tcpScratch: scratch,
  });
  const descriptor = worker.claimPcmTransport(
    options.observeConsumerWake ?? false,
  );
  return { worker, descriptor, gate };
}

export function writeProducer(
  descriptor: PcmTransportDescriptor,
  value: bigint,
): void {
  const words = pcmControlWords(descriptor);
  writeSeqlockedU64(
    words,
    PCM_CONTROL.producerSeq,
    PCM_CONTROL.producerLo,
    PCM_CONTROL.producerHi,
    value,
  );
}

export function writeConsumer(
  descriptor: PcmTransportDescriptor,
  value: bigint,
): void {
  writeConsumerPosition(pcmControlWords(descriptor), value);
}

export function writeDiscard(
  descriptor: PcmTransportDescriptor,
  value: bigint,
): void {
  const words = pcmControlWords(descriptor);
  writeSeqlockedU64(
    words,
    PCM_CONTROL.discardSeq,
    PCM_CONTROL.discardLo,
    PCM_CONTROL.discardHi,
    value,
  );
}

export function writeRing(
  descriptor: PcmTransportDescriptor,
  absoluteOffset: bigint,
  bytes: Uint8Array,
  activeCapacityBytes: number,
): void {
  const ring = pcmDataBytes(descriptor);
  let at = Number(absoluteOffset % BigInt(activeCapacityBytes));
  for (const byte of bytes) {
    ring[at] = byte;
    at = (at + 1) % activeCapacityBytes;
  }
}
