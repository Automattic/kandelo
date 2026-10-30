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
  /** Propagate sink failure when only the worker owns the PCM header. */
  onFatalError?: () => void;
  createContext?: () => AudioContext;
  createNode?: (
    context: AudioContext,
    name: string,
    options: AudioWorkletNodeOptions,
  ) => AudioWorkletNode;
}

/**
 * One AudioContext for every machine this page ever boots.
 *
 * [RUNTIME-WORKAROUND: WEBKIT-AUDIOWORKLET-CLOSE-LEAK]
 * Suspected WebKit defect, see the registry entry in
 * tests/runtime-workarounds/WEBKIT-AUDIOWORKLET-CLOSE-LEAK/: closing an
 * AudioContext that loaded an AudioWorklet module does not reap the
 * worklet's rendering thread. The context reaches "closed" and one
 * "WebCore: AudioWorklet" thread stays in the content process anyway. One
 * machine per context therefore leaked one realtime audio thread per machine
 * switch, measured 1 -> 2 -> 3 -> 4 threads across three switches with
 * `close()` observed completing each time. V8/Chromium reaps the thread. It
 * stays "suspected" because only a thread listing shows it.
 *
 * Sharing one context sidesteps the leak deterministically: the worklet
 * module is registered once, each machine creates and tears down only its
 * AudioWorkletNode, and the single rendering thread is a fixed cost instead
 * of a per-switch leak. It also preserves the user's audio activation across
 * machine switches, since browser autoplay policy attaches to the context.
 *
 * `options.createContext` callers (tests, embedders) keep a private context
 * and the old close-the-context behavior.
 */
let sharedAudioContext: AudioContext | null = null;
const sharedRegisteredWorklets = new Set<string>();
let sharedTransportRetirementFailure: Error | null = null;
let sharedContextTransitionFailure: Error | null = null;
const retiredContextFailures = new WeakSet<object>();

export function isPcmContextFailureWithRetiredTransport(error: unknown): boolean {
  return typeof error === "object" && error !== null && retiredContextFailures.has(error);
}

export function assertBrowserPcmTransportRetired(): void {
  if (sharedTransportRetirementFailure !== null) throw sharedTransportRetirementFailure;
}

const DEFAULT_RENDER_QUANTUM_FRAMES = 128;
const UNREPORTED_OUTPUT_LATENCY_FALLBACK_MS = 100;
const MAX_OUTPUT_PIPELINE_SETTLE_MS = 1000;
const MAX_WORKLET_DETACH_MS = 1000;

/** AudioWorklet-backed physical/default PCM sink for browser machines. */
export class BrowserPcmDriver implements PcmOutputDriver {
  private readonly listeners = new Set<(state: PcmOutputState) => void>();
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private transport: PcmTransportDescriptor | null = null;
  private remotePrepared = false;
  private state: PcmOutputState = "unprepared";
  private preparing: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private resuming: Promise<void> | null = null;
  private suspending: Promise<void> | null = null;
  private processorError: string | null = null;
  /** True when this driver created a private context it must close. */
  private ownsContext = false;
  private contextStateHandler: (() => void) | null = null;
  private readonly onContextError = () => this.fail();

  constructor(private readonly options: BrowserPcmDriverOptions) {}

  prepareContext(): void {
    if (this.state === "closed" || this.closing !== null) throw new Error("PCM output is closed");
    assertBrowserPcmTransportRetired();
    this.assertContextReusable();
    if (this.state === "error") throw new Error("PCM output has failed");
    if (this.context !== null) return;
    const AudioContextCtor = globalThis.AudioContext ??
      (globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!this.options.createContext && !AudioContextCtor) {
      this.markFatalError();
      this.setState("unavailable");
      this.transport = null;
      throw new Error("Web Audio is unavailable");
    }
    let context: AudioContext;
    try {
      if (this.options.createContext) {
        context = this.options.createContext();
        this.ownsContext = true;
      } else {
        if (!sharedAudioContext || sharedAudioContext.state === "closed") {
          sharedAudioContext = new (AudioContextCtor as typeof AudioContext)({ latencyHint: "interactive" });
          sharedRegisteredWorklets.clear();
        }
        context = sharedAudioContext;
        this.ownsContext = false;
      }
    } catch (error) {
      this.markFatalError();
      this.transport = null;
      this.setState("error");
      throw error;
    }
    this.context = context;
    this.contextStateHandler = () => this.syncContextState();
    context.onstatechange = this.contextStateHandler;
    context.addEventListener?.("error", this.onContextError);
    this.syncContextState();
  }

  prepareRemote(port: MessagePort): Promise<void> {
    if (this.state === "closed" || this.closing !== null) return Promise.reject(new Error("PCM output is closed"));
    try {
      assertBrowserPcmTransportRetired();
      this.assertContextReusable();
    } catch (error) { return Promise.reject(error); }
    if (this.remotePrepared) return this.preparing ?? Promise.resolve();
    if (this.transport) return Promise.reject(new Error("PCM output already has a transport"));
    const operation = pendingAudioOperation();
    this.remotePrepared = true;
    this.preparing = operation.promise.finally(() => { this.preparing = null; });
    operation.start(() => this.prepareInner(port));
    return this.preparing;
  }

  prepare(transport: PcmTransportDescriptor): Promise<void> {
    if (this.state === "closed" || this.closing !== null) {
      return Promise.reject(new Error("PCM output is closed"));
    }
    if (this.remotePrepared) {
      return Promise.reject(new Error("PCM output already has a remote transport"));
    }
    try {
      assertBrowserPcmTransportRetired();
      this.assertContextReusable();
    } catch (error) {
      return Promise.reject(error);
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
    const operation = pendingAudioOperation();
    this.transport = transport;
    this.preparing = operation.promise.finally(() => {
      this.preparing = null;
    });
    operation.start(() => this.prepareInner());
    return this.preparing;
  }

  resume(): Promise<void> {
    if (this.closing !== null || this.state === "closed") {
      return Promise.reject(new Error("PCM output is closed"));
    }
    if (this.resuming !== null) return this.resuming;
    const operation = pendingAudioOperation();
    this.resuming = operation.promise.finally(() => {
      this.resuming = null;
    });
    operation.start(() => this.resumeInner());
    return this.resuming;
  }

  private async resumeInner(): Promise<void> {
    const preparation = this.preparing;
    if (this.context === null && preparation !== null) await preparation;
    if (this.closing !== null || this.state === "closed") throw new Error("PCM output is closed");
    if (this.state === "error") throw new Error("PCM output has failed");
    if (this.transport && hasPcmFatalError(pcmControlWords(this.transport))) {
      this.setState("error");
      throw new Error("PCM output has failed");
    }
    const context = this.context;
    if (!context) throw new Error("PCM output has not been prepared");
    try {
      await context.resume();
      if (this.closing !== null || context !== this.context) throw new Error("PCM output is closed");
      if (preparation !== null) await preparation;
      if (this.closing !== null || context !== this.context) throw new Error("PCM output is closed");
      this.syncContextState();
      if (context.state !== "running") {
        throw new Error(`AudioContext remained ${context.state}`);
      }
    } catch (error) {
      // A suspended context and a rejected resume before a user gesture are
      // recoverable. The caller can retry resume from the next activation.
      if (this.closing === null && context === this.context) this.syncContextState();
      throw error;
    }
  }

  suspend(): Promise<void> {
    if (this.closing !== null || this.state === "closed") {
      return Promise.reject(new Error("PCM output is closed"));
    }
    return this.beginSuspension(false);
  }

  private beginSuspension(allowClosing: boolean): Promise<void> {
    if (this.suspending !== null) return this.suspending;
    const operation = pendingAudioOperation();
    this.suspending = operation.promise.finally(() => {
      this.suspending = null;
    });
    operation.start(() => this.suspendInner(allowClosing));
    return this.suspending;
  }

  private async suspendInner(allowClosing: boolean): Promise<void> {
    if (this.preparing) await this.preparing;
    if ((!allowClosing && this.closing !== null) || this.state === "closed") throw new Error("PCM output is closed");
    if (this.transport && hasPcmFatalError(pcmControlWords(this.transport))) {
      this.setState("error");
    }
    if (!this.context || this.context.state === "closed") return;
    const context = this.context;
    await context.suspend();
    if ((!allowClosing && this.closing !== null) || context !== this.context) throw new Error("PCM output is closed");
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
    if (!context || context.state !== "running") return;
    const hasOutput = this.node !== null;

    const startedAt = performance.now();
    const suspension = this.beginSuspension(true);
    if (!await waitForPromiseWithin(
      suspension,
      MAX_OUTPUT_PIPELINE_SETTLE_MS,
    )) {
      const error = new Error("PCM output suspension did not settle before shutdown");
      this.recordContextTransitionFailure(error);
      throw error;
    }
    await suspension;
    this.syncContextState();
    if (!hasOutput) return;

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

  close(): Promise<void> {
    if (this.closing !== null) return this.closing;
    const operation = pendingAudioOperation();
    this.closing = operation.promise;
    operation.start(() => this.closeInner());
    return this.closing;
  }

  private async closeInner(): Promise<void> {
    const failures: unknown[] = [];
    const contextFailures: unknown[] = [];
    if (this.preparing && !await waitForPromiseWithin(this.preparing.catch(() => {}), MAX_WORKLET_DETACH_MS)) {
      const error = new Error("PCM worklet preparation did not settle before shutdown");
      contextFailures.push(error);
      this.recordContextTransitionFailure(error);
    }
    const transitions = [this.resuming, this.suspending].filter(
      (transition): transition is Promise<void> => transition !== null,
    );
    if (transitions.length > 0 && !await waitForPromiseWithin(
      Promise.allSettled(transitions), MAX_WORKLET_DETACH_MS,
    )) {
      const error = new Error("PCM context transition did not settle before shutdown");
      contextFailures.push(error);
      this.recordContextTransitionFailure(error);
    }
    const node = this.node;
    const context = this.context;
    if (node) {
      try {
        await this.detachNode(node);
      } catch (error) {
        failures.push(error);
      }
    }
    if (this.preparing === null) {
      await this.settleOutputPipeline().catch(error => {
        contextFailures.push(error);
        this.recordContextTransitionFailure(error);
      });
    }
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
      if (context.onstatechange === this.contextStateHandler) {
        context.onstatechange = null;
      }
      context.removeEventListener?.("error", this.onContextError);
    }
    if (this.ownsContext) {
      if (context && context.state !== "closed") await context.close();
    }
    // A shared context stays open on purpose — closing it is exactly the
    // engine-bug trigger this driver exists to avoid, and the next machine
    // will reuse it. It is suspended (or was never resumed), so an open idle
    // context costs one rendering thread total, not one per machine.
    this.setState("closed");
    this.listeners.clear();
    if (failures.length === 0 && contextFailures.length > 0 && !this.ownsContext) {
      const failure = new Error("PCM audio context is quarantined until reload; transport memory is detached", {
        cause: contextFailures.length === 1 ? contextFailures[0]
          : new AggregateError(contextFailures, "PCM context shutdown failed"),
      });
      retiredContextFailures.add(failure);
      throw failure;
    }
    failures.push(...contextFailures);
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "PCM output shutdown failed");
  }

  private recordUnconfirmedRetirement(error: unknown): void {
    if (this.ownsContext) return;
    sharedTransportRetirementFailure ??= new Error(
      "PCM transport retirement is unconfirmed; reload before attaching shared audio",
      { cause: error },
    );
  }

  private recordContextTransitionFailure(error: unknown): void {
    if (this.ownsContext) return;
    sharedContextTransitionFailure ??= new Error("PCM audio context is quarantined until reload", { cause: error });
  }

  private assertContextReusable(): void {
    if (!this.options.createContext && sharedContextTransitionFailure !== null) {
      this.setState("unavailable");
      throw sharedContextTransitionFailure;
    }
  }

  private async detachNode(node: AudioWorkletNode): Promise<void> {
    try {
      await detachWorklet(node);
    } catch (error) {
      let message = "PCM AudioWorklet detach failed";
      try { if (error instanceof Error) message = error.message.slice(0, 512); } catch {}
      const failure = new Error(`${message}; context=${this.context?.state ?? "absent"}; sink=${this.state}`
        + (this.processorError === null ? "" : `; processor=${this.processorError}`), { cause: error });
      this.recordUnconfirmedRetirement(failure);
      throw failure;
    }
  }

  getState(): PcmOutputState {
    return this.state;
  }

  subscribe(listener: (state: PcmOutputState) => void): () => void {
    this.listeners.add(listener);
    this.notifyListener(listener, this.state);
    return () => this.listeners.delete(listener);
  }

  private async prepareInner(remotePort?: MessagePort): Promise<void> {
    let context = this.context;
    try {
      this.prepareContext();
      context = this.context!;
      const workletUrl = String(this.options.workletUrl);
      if (this.ownsContext || !sharedRegisteredWorklets.has(workletUrl)) {
        await context.audioWorklet.addModule(workletUrl);
        if (!this.ownsContext) sharedRegisteredWorklets.add(workletUrl);
      }
      if (this.closing !== null) return;
      const transport = this.transport;
      if (transport === null && remotePort === undefined) throw new Error("PCM transport is not available");
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
      assertBrowserPcmTransportRetired();
      this.assertContextReusable();
      const node = this.options.createNode
        ? this.options.createNode(context, "kandelo-pcm-output", options)
        : new AudioWorkletNode(context, "kandelo-pcm-output", options);
      this.node = node;
      node.port.onmessage = (event: MessageEvent<unknown>) => {
        const message = event.data as { type?: unknown; message?: unknown };
        if (message?.type !== "error") return;
        this.processorError = typeof message.message === "string" ? message.message.slice(0, 512) : "AudioWorklet failed";
        this.fail();
        console.error(
          `[BrowserPcmDriver] ${
            typeof message.message === "string"
              ? message.message
              : "AudioWorklet failed"
          }`,
        );
      };
      node.onprocessorerror = event => {
        let message = "AudioWorklet processor failed";
        try {
          const detail = (event as ErrorEvent).message;
          if (typeof detail === "string" && detail.length > 0) message = detail.slice(0, 512);
        } catch {}
        this.processorError = message;
        this.fail();
        try { console.error(`[BrowserPcmDriver] ${message}`); } catch {}
      };
      if (remotePort) node.port.postMessage({ type: "attach", port: remotePort }, [remotePort]);
      node.connect(context.destination);
      this.syncContextState();
    } catch (error) {
      this.markFatalError();
      context ??= this.context;
      let failure = error;
      const node = this.node;
      if (node) {
        try {
          await this.detachNode(node);
        } catch (cleanupError) {
          failure = new AggregateError([error, cleanupError], "PCM output preparation and transport retirement failed");
        }
        node.port.onmessage = null;
        node.onprocessorerror = null;
        node.disconnect();
        node.port.close();
      }
      this.node = null;
      this.context = null;
      this.transport = null;
      if (context?.onstatechange === this.contextStateHandler) {
        context.onstatechange = null;
      }
      context?.removeEventListener?.("error", this.onContextError);
      if (this.ownsContext) {
        if (context && context.state !== "closed") await context.close().catch(() => {});
      } else if (context !== null && sharedAudioContext === context) {
        // A context that failed to prepare must not be handed to the next
        // machine. Drop the cache; closing it may leak the worklet thread on
        // WebKit, but a broken context would strand every later machine.
        sharedAudioContext = null;
        sharedRegisteredWorklets.clear();
        if (context.state !== "closed") await context.close().catch(() => {});
      }
      this.setState("error");
      throw failure;
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
    if (this.state === "closed") return;
    if (this.state === "error" && state !== "closed") return;
    if (this.state === state) return;
    this.state = state;
    for (const listener of this.listeners) this.notifyListener(listener, state);
  }

  private notifyListener(listener: (state: PcmOutputState) => void, state: PcmOutputState): void {
    try {
      listener(state);
    } catch {
      try { console.error("[BrowserPcmDriver] state listener failed"); } catch {}
    }
  }

  private markFatalError(): void {
    this.options.onFatalError?.();
    if (!this.transport) return;
    markPcmFatalError(pcmControlWords(this.transport));
  }

  private fail(): void {
    this.markFatalError();
    this.setState("error");
  }
}

function pendingAudioOperation(): {
  promise: Promise<void>;
  start: (operation: () => Promise<void>) => void;
} {
  let complete!: () => void;
  let refuse!: (error: unknown) => void;
  const promise = new Promise<void>((resolve, reject) => {
    complete = resolve;
    refuse = reject;
  });
  return {
    promise,
    start: operation => {
      try { void operation().then(complete, refuse); } catch (error) { refuse(error); }
    },
  };
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

function detachWorklet(node: AudioWorkletNode): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("PCM AudioWorklet did not acknowledge transport detach"));
    }, MAX_WORKLET_DETACH_MS);
    node.port.onmessage = (event: MessageEvent<unknown>) => {
      if ((event.data as { type?: unknown })?.type !== "detached") return;
      clearTimeout(timeout);
      resolve();
    };
    try {
      node.port.postMessage({ type: "detach" });
    } catch (error) {
      clearTimeout(timeout);
      reject(error);
    }
  });
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
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (completed: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(completed);
    };
    const timeout = setTimeout(() => finish(false), timeoutMs);
    void promise.then(() => finish(true), () => finish(true));
  });
}
