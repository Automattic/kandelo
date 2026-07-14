import type { PcmOutputDriver, PcmOutputState } from "./pcm-driver.js";
import {
  PCM_CONTROL,
  PcmSampleFormat,
  PcmStreamState,
  PcmTransportFlag,
  hasPcmFatalError,
  markPcmFatalError,
  pcmControlWords,
  validatePcmTransport,
  type PcmTransportDescriptor,
} from "./pcm-transport.js";

export interface BrowserPcmDriverOptions {
  workletUrl: string | URL;
  createContext?: () => AudioContext;
  createNode?: (
    context: AudioContext,
    name: string,
    options: AudioWorkletNodeOptions,
  ) => AudioWorkletNode;
}

const DEFAULT_RENDER_QUANTUM_FRAMES = 128;
const UNREPORTED_OUTPUT_LATENCY_FALLBACK_MS = 100;
const MAX_OUTPUT_PIPELINE_SETTLE_MS = 1000;

/** AudioWorklet-backed physical/default PCM sink for browser machines. */
export class BrowserPcmDriver implements PcmOutputDriver {
  private readonly listeners = new Set<(state: PcmOutputState) => void>();
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private transport: PcmTransportDescriptor | null = null;
  private state: PcmOutputState = "unprepared";
  private preparing: Promise<void> | null = null;
  private readonly onContextError = () => this.fail();

  constructor(private readonly options: BrowserPcmDriverOptions) {}

  prepare(transport: PcmTransportDescriptor): Promise<void> {
    if (this.state === "closed") {
      return Promise.reject(new Error("PCM output is closed"));
    }
    validatePcmTransport(transport);
    if (this.transport) {
      if (!sameTransport(this.transport, transport)) {
        return Promise.reject(
          new Error("PCM output is already attached to another transport"),
        );
      }
      return this.preparing ?? Promise.resolve();
    }
    this.transport = transport;
    this.preparing = this.prepareInner(transport).finally(() => {
      this.preparing = null;
    });
    return this.preparing;
  }

  async resume(): Promise<void> {
    if (this.preparing) await this.preparing;
    if (this.state === "error") throw new Error("PCM output has failed");
    if (this.transport && hasPcmFatalError(pcmControlWords(this.transport))) {
      this.setState("error");
      throw new Error("PCM output has failed");
    }
    const context = this.context;
    if (!context) throw new Error("PCM output has not been prepared");
    try {
      await context.resume();
      this.syncContextState();
      if (context.state !== "running") {
        throw new Error(`AudioContext remained ${context.state}`);
      }
    } catch (error) {
      // A suspended context and a rejected resume before a user gesture are
      // recoverable. The caller can retry resume from the next activation.
      this.syncContextState();
      throw error;
    }
  }

  async suspend(): Promise<void> {
    if (this.preparing) await this.preparing;
    if (this.transport && hasPcmFatalError(pcmControlWords(this.transport))) {
      this.setState("error");
    }
    if (!this.context || this.context.state === "closed") return;
    await this.context.suspend();
    this.syncContextState();
  }

  /**
   * Let samples already rendered by the worklet reach the physical output
   * before machine teardown closes the AudioContext.
   *
   * The shared consumer cursor advances when the worklet fills a render
   * quantum, before Web Audio's downstream buffers and the output device have
   * necessarily emitted that quantum. BrowserKernel calls this only after the
   * kernel worker has drained the shared PCM ring. Per Web Audio 1.1's
   * AudioContext.suspend() contract, suspension lets already-processed blocks
   * play to the destination and resolves once its frame buffer has been handed
   * to the hardware; the latency wait then covers physical emission of the
   * reported processing/device queues and the final quantum.
   *
   * This method never resumes a context, so it does not bypass browser user-
   * activation policy. Both suspension and the final wait share a bounded
   * teardown budget so a broken AudioContext cannot wedge machine destroy.
   */
  async settleOutputPipeline(): Promise<void> {
    if (this.preparing) await this.preparing.catch(() => {});
    const context = this.context;
    if (!context || !this.node || context.state !== "running") return;

    const startedAt = performance.now();
    await waitForPromiseWithin(
      context.suspend(),
      MAX_OUTPUT_PIPELINE_SETTLE_MS,
    );
    this.syncContextState();

    if ((context.state as string) === "closed" || context !== this.context) {
      return;
    }
    const elapsedMs = Math.max(0, performance.now() - startedAt);
    const remainingBudgetMs = Math.max(
      0,
      MAX_OUTPUT_PIPELINE_SETTLE_MS - elapsedMs,
    );
    const settleMs = Math.min(
      outputPipelineSettleMs(context),
      remainingBudgetMs,
    );
    if (settleMs > 0) await delay(settleMs);
  }

  async close(): Promise<void> {
    if (this.state === "closed") return;
    if (this.preparing) await this.preparing.catch(() => {});
    const node = this.node;
    const context = this.context;
    this.node = null;
    this.context = null;
    this.transport = null;
    if (node) {
      node.port.onmessage = null;
      node.onprocessorerror = null;
      node.disconnect();
      node.port.close();
    }
    if (context) {
      context.onstatechange = null;
      context.removeEventListener?.("error", this.onContextError);
    }
    if (context && context.state !== "closed") await context.close();
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

  private async prepareInner(transport: PcmTransportDescriptor): Promise<void> {
    const AudioContextCtor =
      globalThis.AudioContext ??
      (
        globalThis as typeof globalThis & {
          webkitAudioContext?: typeof AudioContext;
        }
      ).webkitAudioContext;
    if (!this.options.createContext && !AudioContextCtor) {
      this.markFatalError();
      this.setState("unavailable");
      this.transport = null;
      throw new Error("Web Audio is unavailable");
    }

    let context: AudioContext;
    try {
      context = this.options.createContext
        ? this.options.createContext()
        : new (AudioContextCtor as typeof AudioContext)({
            latencyHint: "interactive",
          });
    } catch (error) {
      this.markFatalError();
      this.transport = null;
      this.setState("error");
      throw error;
    }
    this.context = context;
    context.onstatechange = () => this.syncContextState();
    // Web Audio 1.1 defines AudioContext's `error` event for audio-system
    // resource failures. TypeScript's current DOM declarations do not yet
    // include the event in AudioContextEventMap, so use the string overload.
    context.addEventListener?.("error", this.onContextError);

    try {
      await context.audioWorklet.addModule(String(this.options.workletUrl));
      const options: AudioWorkletNodeOptions = {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: {
          ...transport,
          layout: PCM_CONTROL,
          formats: {
            u8: PcmSampleFormat.U8,
            s16le: PcmSampleFormat.S16Le,
            s16be: PcmSampleFormat.S16Be,
          },
          states: {
            running: PcmStreamState.Running,
            draining: PcmStreamState.Draining,
          },
          flags: {
            configuring: PcmTransportFlag.Configuring,
            underrunActive: PcmTransportFlag.UnderrunActive,
            fatalError: PcmTransportFlag.FatalError,
          },
          outputSampleRate: context.sampleRate,
        },
      };
      const node = this.options.createNode
        ? this.options.createNode(context, "kandelo-pcm-output", options)
        : new AudioWorkletNode(context, "kandelo-pcm-output", options);
      node.port.onmessage = (event: MessageEvent<unknown>) => {
        const message = event.data as { type?: unknown; message?: unknown };
        if (message?.type !== "error") return;
        this.fail();
        console.error(
          `[BrowserPcmDriver] ${
            typeof message.message === "string"
              ? message.message
              : "AudioWorklet failed"
          }`,
        );
      };
      node.onprocessorerror = () => {
        this.fail();
      };
      node.connect(context.destination);
      this.node = node;
      this.syncContextState();
    } catch (error) {
      this.markFatalError();
      this.node = null;
      this.context = null;
      this.transport = null;
      context.onstatechange = null;
      context.removeEventListener?.("error", this.onContextError);
      if (context.state !== "closed") await context.close().catch(() => {});
      this.setState("error");
      throw error;
    }
  }

  private syncContextState(): void {
    if (
      this.state === "error" ||
      (this.transport && hasPcmFatalError(pcmControlWords(this.transport)))
    ) {
      this.setState("error");
      return;
    }
    const contextState = this.context?.state as string | undefined;
    switch (contextState) {
      case "running":
        this.setState("running");
        break;
      case "interrupted":
        this.setState("interrupted");
        break;
      case "closed":
        this.fail();
        break;
      default:
        this.setState("suspended");
        break;
    }
  }

  private setState(state: PcmOutputState): void {
    if (this.state === "error" && state !== "closed") return;
    if (this.state === state) return;
    this.state = state;
    for (const listener of this.listeners) listener(state);
  }

  private markFatalError(): void {
    if (!this.transport) return;
    markPcmFatalError(pcmControlWords(this.transport));
  }

  private fail(): void {
    this.markFatalError();
    this.setState("error");
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

function outputPipelineSettleMs(context: AudioContext): number {
  const extendedContext = context as AudioContext & {
    outputLatency?: number;
    renderQuantumSize?: number;
  };
  const sampleRate = positiveFinite(context.sampleRate) ?? 48_000;
  const renderFrames =
    positiveFinite(extendedContext.renderQuantumSize) ??
    DEFAULT_RENDER_QUANTUM_FRAMES;
  const quantumMs = (renderFrames * 1000) / sampleRate;
  const baseLatencyMs = (nonnegativeFinite(context.baseLatency) ?? 0) * 1000;
  const outputLatencySeconds = positiveFinite(extendedContext.outputLatency);
  const outputLatencyMs = (outputLatencySeconds ?? 0) * 1000;
  const unreportedFallbackMs =
    outputLatencySeconds === undefined
      ? UNREPORTED_OUTPUT_LATENCY_FALLBACK_MS
      : 0;
  return Math.ceil(
    Math.min(
      MAX_OUTPUT_PIPELINE_SETTLE_MS,
      Math.max(
        unreportedFallbackMs,
        baseLatencyMs + outputLatencyMs + quantumMs,
      ),
    ),
  );
}

function positiveFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function nonnegativeFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function delay(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function waitForPromiseWithin(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve();
    };
    const timeout = setTimeout(finish, timeoutMs);
    void promise.then(finish, finish);
  });
}
