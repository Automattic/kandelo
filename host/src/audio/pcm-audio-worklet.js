/*
 * Kandelo PCM AudioWorklet. The processor is deliberately self-contained so
 * it can be emitted as a real browser asset and tested directly in Vitest.
 * All layout offsets and enum values arrive in processorOptions; the worklet
 * never imports OSS, WebAssembly, or kernel implementation details.
 */

const WorkletBase =
  globalThis.AudioWorkletProcessor ??
  class {
    constructor() {
      this.port = { onmessage: null, postMessage() {} };
    }
  };

function loadU32(words, index) {
  return Atomics.load(words, index) >>> 0;
}

function readU64(words, seqIndex, loIndex, hiIndex) {
  for (;;) {
    const before = loadU32(words, seqIndex);
    if (before & 1) continue;
    const lo = loadU32(words, loIndex);
    const hi = loadU32(words, hiIndex);
    const after = loadU32(words, seqIndex);
    if (before === after && !(after & 1)) {
      return (BigInt(hi) << 32n) | BigInt(lo);
    }
  }
}

function writeU64(words, seqIndex, loIndex, hiIndex, value) {
  Atomics.add(words, seqIndex, 1);
  Atomics.store(words, loIndex, Number(value & 0xffff_ffffn) | 0);
  Atomics.store(words, hiIndex, Number((value >> 32n) & 0xffff_ffffn) | 0);
  Atomics.add(words, seqIndex, 1);
}

export class KandeloPcmProcessor extends WorkletBase {
  constructor(options = {}) {
    super(options);
    const config = options.processorOptions ?? options;
    this.layout = config.layout;
    this.formats = config.formats;
    this.states = config.states;
    this.flags = config.flags;
    this.outputRate =
      config.outputSampleRate ?? globalThis.sampleRate ?? 48_000;
    this.words = new Int32Array(
      config.buffer,
      config.controlOffset,
      config.controlBytes / 4,
    );
    this.ring = new Uint8Array(
      config.buffer,
      config.dataOffset,
      config.dataBytes,
    );
    this.generation = -1;
    this.sourcePhase = 0;
    this.lastError = "";
  }

  process(_inputs, outputs) {
    const output = outputs[0] ?? [];
    const outputFrames = output[0]?.length ?? 0;
    for (const channel of output) channel.fill(0);
    if (outputFrames === 0) return true;

    const l = this.layout;
    const transportFlags = loadU32(this.words, l.flags);
    if (
      (transportFlags & (this.flags.configuring | this.flags.fatalError)) !==
      0
    ) {
      return true;
    }
    const generation = loadU32(this.words, l.generation);
    if (generation !== this.generation) {
      this.generation = generation;
      this.sourcePhase = 0;
    }

    const state = loadU32(this.words, l.state);
    if (state !== this.states.running && state !== this.states.draining) {
      this.clearUnderrun();
      return true;
    }

    const format = loadU32(this.words, l.format);
    const sourceRate = loadU32(this.words, l.sampleRate);
    const channels = loadU32(this.words, l.channels);
    const frameBytes = loadU32(this.words, l.frameBytes);
    const activeCapacityBytes = loadU32(this.words, l.activeCapacityBytes);
    const bytesPerSample = this.bytesPerSample(format);
    const configGeneration = loadU32(this.words, l.generation);
    const configFlags = loadU32(this.words, l.flags);
    const confirmedConfigGeneration = loadU32(this.words, l.generation);
    if (
      configGeneration !== generation ||
      confirmedConfigGeneration !== generation ||
      (configFlags & (this.flags.configuring | this.flags.fatalError)) !== 0
    ) {
      this.generation = confirmedConfigGeneration;
      this.sourcePhase = 0;
      return true;
    }
    if (
      sourceRate === 0 ||
      (channels !== 1 && channels !== 2) ||
      bytesPerSample === 0 ||
      frameBytes !== bytesPerSample * channels ||
      activeCapacityBytes < frameBytes ||
      activeCapacityBytes > this.ring.byteLength ||
      activeCapacityBytes % frameBytes !== 0
    ) {
      this.reportError("unsupported PCM configuration");
      return true;
    }

    const producer = readU64(
      this.words,
      l.producerSeq,
      l.producerLo,
      l.producerHi,
    );
    let consumer = readU64(
      this.words,
      l.consumerSeq,
      l.consumerLo,
      l.consumerHi,
    );
    const discard = readU64(this.words, l.discardSeq, l.discardLo, l.discardHi);
    if (discard > consumer) consumer = discard > producer ? producer : discard;
    const initialConsumer = consumer;
    this.activeCapacityBytes = activeCapacityBytes;
    const step = sourceRate / this.outputRate;
    let underrun = false;
    let renderedPcm = false;

    for (let outFrame = 0; outFrame < outputFrames; outFrame++) {
      const queuedBytes = producer > consumer ? producer - consumer : 0n;
      const queuedFrames = Number(queuedBytes / BigInt(frameBytes));
      const sourceIndex = Math.floor(this.sourcePhase);
      if (sourceIndex >= queuedFrames) {
        underrun = true;
        this.sourcePhase = 0;
        break;
      }

      renderedPcm = true;
      const nextIndex = Math.min(sourceIndex + 1, queuedFrames - 1);
      const fraction = this.sourcePhase - sourceIndex;
      for (let outChannel = 0; outChannel < output.length; outChannel++) {
        const sourceChannel =
          channels === 1 ? 0 : Math.min(outChannel, channels - 1);
        const a = this.readSample(
          consumer +
            BigInt(sourceIndex * frameBytes + sourceChannel * bytesPerSample),
          format,
        );
        const b = this.readSample(
          consumer +
            BigInt(nextIndex * frameBytes + sourceChannel * bytesPerSample),
          format,
        );
        output[outChannel][outFrame] = a + (b - a) * fraction;
      }

      this.sourcePhase += step;
      const advance = Math.min(Math.floor(this.sourcePhase), queuedFrames);
      if (advance > 0) {
        consumer += BigInt(advance * frameBytes);
        this.sourcePhase -= advance;
      }
    }

    // RESET and reopen run in the kernel worker concurrently with this render
    // quantum. Never publish an old generation's cursor or samples into the
    // new stream. Transport cursors remain monotonic across generations, which
    // also makes a generation change in the tiny interval after this check
    // harmless to the new stream's queued bytes.
    const finalGeneration = loadU32(this.words, l.generation);
    const finalFlags = loadU32(this.words, l.flags);
    const confirmedGeneration = loadU32(this.words, l.generation);
    if (
      finalGeneration !== generation ||
      confirmedGeneration !== generation ||
      (finalFlags & (this.flags.configuring | this.flags.fatalError)) !== 0
    ) {
      for (const channel of output) channel.fill(0);
      this.generation = confirmedGeneration;
      this.sourcePhase = 0;
      return true;
    }

    const finalState = loadU32(this.words, l.state);
    if (renderedPcm || finalState !== this.states.running) {
      this.clearUnderrun();
    }
    if (underrun && finalState === this.states.running) this.noteUnderrun();
    if (consumer !== initialConsumer) {
      writeU64(this.words, l.consumerSeq, l.consumerLo, l.consumerHi, consumer);
      this.signalProgress();
    }
    return true;
  }

  bytesPerSample(format) {
    if (format === this.formats.u8) return 1;
    if (format === this.formats.s16le || format === this.formats.s16be)
      return 2;
    return 0;
  }

  readSample(absoluteByte, format) {
    const capacity = this.activeCapacityBytes;
    const at = Number(absoluteByte % BigInt(capacity));
    if (format === this.formats.u8) return (this.ring[at] - 128) / 128;
    const next = (at + 1) % capacity;
    const lo = format === this.formats.s16le ? this.ring[at] : this.ring[next];
    const hi = format === this.formats.s16le ? this.ring[next] : this.ring[at];
    let sample = lo | (hi << 8);
    if (sample & 0x8000) sample -= 0x1_0000;
    return sample / 32768;
  }

  noteUnderrun() {
    const previous = Atomics.or(
      this.words,
      this.layout.flags,
      this.flags.underrunActive,
    );
    if ((previous & this.flags.underrunActive) !== 0) return;
    Atomics.add(this.words, this.layout.underruns, 1);
    this.signalProgress();
  }

  clearUnderrun() {
    Atomics.and(this.words, this.layout.flags, ~this.flags.underrunActive);
  }

  signalProgress() {
    Atomics.add(this.words, this.layout.wakeSeq, 1);
    // A kernel observer and teardown drain can wait concurrently. Final-tail
    // consumption is a one-shot transition, so every waiter must see it.
    Atomics.notify(this.words, this.layout.wakeSeq);
  }

  reportError(message) {
    if (message === this.lastError) return;
    this.lastError = message;
    this.clearUnderrun();
    Atomics.or(this.words, this.layout.flags, this.flags.fatalError);
    this.signalProgress();
    this.port.postMessage({ type: "error", message });
  }
}

if (typeof globalThis.registerProcessor === "function") {
  globalThis.registerProcessor("kandelo-pcm-output", KandeloPcmProcessor);
}
