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

export function createPcmTransport(
  options: {
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
  } = {},
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
