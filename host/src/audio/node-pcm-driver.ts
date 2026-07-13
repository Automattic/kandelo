import type { PcmOutputDriver, PcmOutputState } from "./pcm-driver.js";
import {
  PcmSampleFormat,
  PcmStreamState,
  PcmTransportFlag,
  hasPcmFatalError,
  isPcmGenerationCurrent,
  markPcmFatalError,
  pcmControlWords,
  pcmDataBytes,
  readEffectiveConsumerPosition,
  readPcmConfig,
  readProducerPosition,
  readRingBytes,
  validatePcmTransport,
  type PcmTransportConfig,
  type PcmTransportDescriptor,
} from "./pcm-transport.js";

export interface PcmDriverClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface NodePcmDriverOptions {
  clockUpdate(requestedFrames: number): number;
  /** Wake/retry guest syscalls after a fatal sink transition. */
  onFatal?: () => void;
  clock?: PcmDriverClock;
  onConsume?: (event: {
    bytes: Uint8Array;
    frames: number;
    requestedFrames: number;
    config: PcmTransportConfig;
  }) => void;
  idlePollMs?: number;
}

const defaultClock: PcmDriverClock = {
  now: () => performance.now(),
  setTimeout: (callback, delayMs) => {
    const handle = setTimeout(callback, delayMs);
    if (typeof handle === "object" && "unref" in handle) handle.unref();
    return handle;
  },
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Wall-clock-paced null sink for Node and headless hosts. */
export class NodePcmDriver implements PcmOutputDriver {
  private readonly clock: PcmDriverClock;
  private readonly listeners = new Set<(state: PcmOutputState) => void>();
  private transport: PcmTransportDescriptor | null = null;
  private timer: unknown = null;
  private state: PcmOutputState = "unprepared";
  private enabled = true;
  private generation = -1;
  private fatalNotified = false;
  private lastNow = 0;
  private frameRemainder = 0;

  constructor(private readonly options: NodePcmDriverOptions) {
    this.clock = options.clock ?? defaultClock;
  }

  async prepare(transport: PcmTransportDescriptor): Promise<void> {
    if (this.state === "closed") throw new Error("PCM driver is closed");
    validatePcmTransport(transport);
    if (this.transport) {
      if (!sameTransport(this.transport, transport)) {
        throw new Error("PCM driver is already attached to another transport");
      }
      return;
    }
    this.transport = transport;
    this.lastNow = this.clock.now();
    this.setState("running");
    this.schedule(0);
  }

  async resume(): Promise<void> {
    if (this.state === "closed") throw new Error("PCM driver is closed");
    if (this.state === "error") throw new Error("PCM output has failed");
    if (this.transport && hasPcmFatalError(pcmControlWords(this.transport))) {
      this.fail();
      throw new Error("PCM output has failed");
    }
    this.enabled = true;
    this.lastNow = this.clock.now();
    this.frameRemainder = 0;
    if (this.transport) {
      this.setState("running");
      this.schedule(0);
    }
  }

  async suspend(): Promise<void> {
    if (this.transport && hasPcmFatalError(pcmControlWords(this.transport))) {
      this.fail();
      return;
    }
    this.enabled = false;
    this.cancelTimer();
    if (this.state !== "closed" && this.state !== "error") {
      this.setState("suspended");
    }
  }

  async close(): Promise<void> {
    if (this.state === "closed") return;
    this.enabled = false;
    this.cancelTimer();
    this.transport = null;
    this.setState("closed");
    this.listeners.clear();
  }

  getState(): PcmOutputState {
    return this.state;
  }

  subscribe(listener: (state: PcmOutputState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  /** Visible for deterministic tests and worker-owned scheduling. */
  tick(): void {
    this.timer = null;
    const transport = this.transport;
    if (!transport || !this.enabled || this.state === "closed") return;

    const words = pcmControlWords(transport);
    const config = readPcmConfig(words);
    const now = this.clock.now();
    if ((config.flags & PcmTransportFlag.FatalError) !== 0) {
      this.fail();
      return;
    }
    const sampleBytes = bytesPerSample(config.format);
    if (
      config.sampleRate === 0 ||
      (config.channels !== 1 && config.channels !== 2) ||
      sampleBytes === 0 ||
      config.frameBytes !== sampleBytes * config.channels ||
      config.activeCapacityBytes < config.frameBytes ||
      config.activeCapacityBytes > transport.dataBytes ||
      config.activeCapacityBytes % config.frameBytes !== 0
    ) {
      this.fail(true);
      return;
    }
    if (config.generation !== this.generation) {
      this.generation = config.generation;
      this.frameRemainder = 0;
      this.lastNow = now;
    }

    if (
      (config.state !== PcmStreamState.Running &&
        config.state !== PcmStreamState.Draining) ||
      config.sampleRate === 0 ||
      config.frameBytes === 0
    ) {
      this.lastNow = now;
      this.frameRemainder = 0;
      this.schedule(this.options.idlePollMs ?? 10);
      return;
    }

    const elapsedMs = Math.max(0, now - this.lastNow);
    this.lastNow = now;
    const due = this.frameRemainder + (elapsedMs * config.sampleRate) / 1000;
    const requestedFrames = Math.floor(due);
    this.frameRemainder = due - requestedFrames;

    if (requestedFrames > 0) {
      const consumer = readEffectiveConsumerPosition(words);
      const producer = readProducerPosition(words);
      const queuedFrames = Number(
        (producer > consumer ? producer - consumer : 0n) /
          BigInt(config.frameBytes),
      );
      const candidateFrames = Math.min(requestedFrames, queuedFrames);
      const candidateBytes =
        this.options.onConsume && candidateFrames > 0
          ? readRingBytes(
              pcmDataBytes(transport).subarray(
                0,
                Math.min(
                  transport.dataBytes,
                  Math.max(config.frameBytes, config.activeCapacityBytes),
                ),
              ),
              consumer,
              candidateFrames * config.frameBytes,
            )
          : new Uint8Array(0);
      if (!isPcmGenerationCurrent(words, config.generation)) {
        this.lastNow = now;
        this.frameRemainder = 0;
        this.schedule(0);
        return;
      }
      let consumedFrames: number;
      try {
        consumedFrames = Math.max(
          0,
          Math.min(candidateFrames, this.options.clockUpdate(requestedFrames)),
        );
      } catch {
        this.fail(true);
        return;
      }
      const completedDrain =
        config.state === PcmStreamState.Draining &&
        consumedFrames > 0 &&
        consumedFrames === queuedFrames;
      if (
        !isPcmGenerationCurrent(words, config.generation) &&
        !completedDrain
      ) {
        this.lastNow = now;
        this.frameRemainder = 0;
        this.schedule(0);
        return;
      }
      if (consumedFrames > 0 && this.options.onConsume) {
        try {
          this.options.onConsume({
            bytes: candidateBytes.subarray(
              0,
              consumedFrames * config.frameBytes,
            ),
            frames: consumedFrames,
            requestedFrames,
            config,
          });
        } catch {
          this.fail(true);
          return;
        }
      }
    }

    const periodFrames =
      config.fragmentBytes > 0
        ? Math.max(1, Math.floor(config.fragmentBytes / config.frameBytes))
        : 128;
    const periodMs = (periodFrames * 1000) / config.sampleRate;
    const untilNextFrame =
      ((1 - this.frameRemainder) * 1000) / config.sampleRate;
    this.schedule(Math.max(1, Math.min(periodMs, untilNextFrame + periodMs)));
  }

  private schedule(delayMs: number): void {
    if (this.timer !== null || !this.enabled || !this.transport) return;
    this.timer = this.clock.setTimeout(() => this.tick(), delayMs);
  }

  private cancelTimer(): void {
    if (this.timer === null) return;
    this.clock.clearTimeout(this.timer);
    this.timer = null;
  }

  private fail(markFatal = false): void {
    if (markFatal && this.transport) {
      markPcmFatalError(pcmControlWords(this.transport));
    }
    if (!this.fatalNotified) {
      this.fatalNotified = true;
      try {
        this.options.onFatal?.();
      } catch (error) {
        console.error("[NodePcmDriver] fatal wake callback failed", error);
      }
    }
    this.enabled = false;
    this.cancelTimer();
    this.setState("error");
  }

  private setState(state: PcmOutputState): void {
    if (this.state === "error" && state !== "closed") return;
    if (this.state === state) return;
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }
}

function sameTransport(
  a: PcmTransportDescriptor,
  b: PcmTransportDescriptor,
): boolean {
  return (
    a.buffer === b.buffer &&
    a.controlOffset === b.controlOffset &&
    a.controlBytes === b.controlBytes &&
    a.dataOffset === b.dataOffset &&
    a.dataBytes === b.dataBytes
  );
}

function bytesPerSample(format: PcmSampleFormat): number {
  switch (format) {
    case PcmSampleFormat.U8:
      return 1;
    case PcmSampleFormat.S16Le:
    case PcmSampleFormat.S16Be:
      return 2;
    default:
      return 0;
  }
}
