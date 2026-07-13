import { describe, expect, it, vi } from "vitest";
import { BrowserPcmDriver } from "../src/audio/browser-pcm-driver";
import {
  PCM_CONTROL,
  PcmSampleFormat,
  PcmStreamState,
  PcmTransportFlag,
  pcmControlWords,
  readEffectiveConsumerPosition,
  readProducerPosition,
} from "../src/audio/pcm-transport";
import { createPcmTransport, writeProducer } from "./pcm-test-helpers";

function browserAudioMocks() {
  const addModule = vi.fn(async () => {});
  const eventListeners = new Map<
    string,
    Set<EventListenerOrEventListenerObject>
  >();
  const context = {
    state: "suspended" as AudioContextState,
    sampleRate: 48_000,
    baseLatency: 0.01,
    outputLatency: 0.02,
    renderQuantumSize: 128,
    destination: {},
    audioWorklet: { addModule },
    onstatechange: null as (() => void) | null,
    addEventListener: vi.fn(
      (type: string, listener: EventListenerOrEventListenerObject | null) => {
        if (!listener) return;
        const listeners = eventListeners.get(type) ?? new Set();
        listeners.add(listener);
        eventListeners.set(type, listeners);
      },
    ),
    removeEventListener: vi.fn(
      (type: string, listener: EventListenerOrEventListenerObject | null) => {
        if (listener) eventListeners.get(type)?.delete(listener);
      },
    ),
    dispatchEvent: vi.fn((event: Event) => {
      for (const listener of eventListeners.get(event.type) ?? []) {
        if (typeof listener === "function") listener.call(context, event);
        else listener.handleEvent(event);
      }
      return true;
    }),
    resume: vi.fn(async function (this: typeof context) {
      this.state = "running";
      this.onstatechange?.();
    }),
    suspend: vi.fn(async function (this: typeof context) {
      this.state = "suspended";
      this.onstatechange?.();
    }),
    close: vi.fn(async function (this: typeof context) {
      this.state = "closed";
      this.onstatechange?.();
    }),
  };
  const port = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    close: vi.fn(),
  };
  const node = {
    port,
    onprocessorerror: null as (() => void) | null,
    connect: vi.fn(),
    disconnect: vi.fn(),
  };
  let nodeOptions: AudioWorkletNodeOptions | undefined;
  const createNode = vi.fn(
    (
      _context: AudioContext,
      _name: string,
      options: AudioWorkletNodeOptions,
    ) => {
      nodeOptions = options;
      return node as unknown as AudioWorkletNode;
    },
  );
  return {
    addModule,
    context,
    node,
    createNode,
    get nodeOptions() {
      return nodeOptions;
    },
  };
}

describe("BrowserPcmDriver", () => {
  it("loads the packaged worklet with the generated PCM-only transport contract", async () => {
    const mocks = browserAudioMocks();
    const driver = new BrowserPcmDriver({
      workletUrl: "/assets/kandelo-pcm.js",
      createContext: () => mocks.context as unknown as AudioContext,
      createNode: mocks.createNode,
    });
    const states: string[] = [];
    driver.subscribe((state) => states.push(state));

    await driver.prepare(createPcmTransport());
    expect(mocks.addModule).toHaveBeenCalledWith("/assets/kandelo-pcm.js");
    expect(mocks.createNode).toHaveBeenCalledWith(
      mocks.context,
      "kandelo-pcm-output",
      expect.any(Object),
    );
    expect(mocks.nodeOptions?.processorOptions).toMatchObject({
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
      outputSampleRate: 48_000,
    });
    expect(driver.getState()).toBe("suspended");

    await driver.resume();
    expect(driver.getState()).toBe("running");
    await driver.suspend();
    expect(driver.getState()).toBe("suspended");
    await driver.close();
    expect(mocks.node.disconnect).toHaveBeenCalledOnce();
    expect(mocks.node.port.close).toHaveBeenCalledOnce();
    expect(mocks.context.close).toHaveBeenCalledOnce();
    expect(states).toContain("running");
    expect(states.at(-1)).toBe("closed");
  });

  it("surfaces AudioContext activation failure instead of pretending to run", async () => {
    const mocks = browserAudioMocks();
    mocks.context.resume.mockImplementationOnce(async () => {
      throw new Error("user activation required");
    });
    const driver = new BrowserPcmDriver({
      workletUrl: "/worklet.js",
      createContext: () => mocks.context as unknown as AudioContext,
      createNode: mocks.createNode,
    });
    const descriptor = createPcmTransport();
    await driver.prepare(descriptor);

    await expect(driver.resume()).rejects.toThrow("user activation required");
    expect(driver.getState()).toBe("suspended");
    expect(
      Atomics.load(pcmControlWords(descriptor), PCM_CONTROL.flags) &
        PcmTransportFlag.FatalError,
    ).toBe(0);
    await driver.close();
  });

  it("settles the rendered Web Audio tail before context close", async () => {
    vi.useFakeTimers();
    try {
      const mocks = browserAudioMocks();
      const driver = new BrowserPcmDriver({
        workletUrl: "/worklet.js",
        createContext: () => mocks.context as unknown as AudioContext,
        createNode: mocks.createNode,
      });
      await driver.prepare(createPcmTransport());
      await driver.resume();

      let settled = false;
      const settlement = driver.settleOutputPipeline().then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(mocks.context.suspend).toHaveBeenCalledOnce();
      expect(mocks.context.resume).toHaveBeenCalledOnce();
      expect(driver.getState()).toBe("suspended");
      expect(settled).toBe(false);

      // 10 ms base latency + 20 ms device latency + one 128-frame
      // render quantum at 48 kHz rounds up to a 33 ms settlement wait.
      await vi.advanceTimersByTimeAsync(32);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await settlement;
      expect(settled).toBe(true);

      await driver.close();
      expect(mocks.context.close).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not resume suspended audio while settling teardown", async () => {
    const mocks = browserAudioMocks();
    const driver = new BrowserPcmDriver({
      workletUrl: "/worklet.js",
      createContext: () => mocks.context as unknown as AudioContext,
      createNode: mocks.createNode,
    });
    await driver.prepare(createPcmTransport());

    await driver.settleOutputPipeline();

    expect(mocks.context.resume).not.toHaveBeenCalled();
    expect(mocks.context.suspend).not.toHaveBeenCalled();
    expect(driver.getState()).toBe("suspended");
    await driver.close();
  });

  it("bounds settlement when AudioContext suspension never resolves", async () => {
    vi.useFakeTimers();
    try {
      const mocks = browserAudioMocks();
      mocks.context.suspend.mockImplementationOnce(
        () => new Promise<void>(() => {}),
      );
      const driver = new BrowserPcmDriver({
        workletUrl: "/worklet.js",
        createContext: () => mocks.context as unknown as AudioContext,
        createNode: mocks.createNode,
      });
      await driver.prepare(createPcmTransport());
      await driver.resume();

      let settled = false;
      const settlement = driver.settleOutputPipeline().then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await settlement;
      expect(settled).toBe(true);

      await driver.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces an explicit AudioWorklet error message", async () => {
    const mocks = browserAudioMocks();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const driver = new BrowserPcmDriver({
      workletUrl: "/worklet.js",
      createContext: () => mocks.context as unknown as AudioContext,
      createNode: mocks.createNode,
    });
    const states: string[] = [];
    driver.subscribe((state) => states.push(state));
    const descriptor = createPcmTransport();
    await driver.prepare(descriptor);

    mocks.node.port.onmessage?.({
      data: { type: "error", message: "PCM generation changed mid-quantum" },
    } as MessageEvent);

    expect(driver.getState()).toBe("error");
    expect(states.at(-1)).toBe("error");
    expect(consoleError).toHaveBeenCalledWith(
      "[BrowserPcmDriver] PCM generation changed mid-quantum",
    );
    expect(
      Atomics.load(pcmControlWords(descriptor), PCM_CONTROL.flags) &
        PcmTransportFlag.FatalError,
    ).toBe(PcmTransportFlag.FatalError);
    await expect(driver.resume()).rejects.toThrow("PCM output has failed");
    await driver.close();
  });

  it("latches the standard AudioContext output-error event across its suspended statechange", async () => {
    const mocks = browserAudioMocks();
    const driver = new BrowserPcmDriver({
      workletUrl: "/worklet.js",
      createContext: () => mocks.context as unknown as AudioContext,
      createNode: mocks.createNode,
    });
    const descriptor = createPcmTransport();
    const words = pcmControlWords(descriptor);
    await driver.prepare(descriptor);
    await driver.resume();

    mocks.context.dispatchEvent(new Event("error"));
    expect(driver.getState()).toBe("error");
    expect(
      Atomics.load(words, PCM_CONTROL.flags) & PcmTransportFlag.FatalError,
    ).toBe(PcmTransportFlag.FatalError);
    expect(Atomics.load(words, PCM_CONTROL.wakeSeq)).toBe(1);

    // Web Audio 1.1 dispatches `error` before moving a resource-failed
    // context to suspended and dispatching statechange. That follow-up state
    // must not make a permanently failed sink look recoverable.
    mocks.context.state = "suspended";
    mocks.context.onstatechange?.();
    await driver.suspend();
    expect(driver.getState()).toBe("error");
    await expect(driver.resume()).rejects.toThrow("PCM output has failed");

    await driver.close();
    expect(mocks.context.removeEventListener).toHaveBeenCalledWith(
      "error",
      expect.any(Function),
    );
  });

  it("keeps ordinary interruption and suspension recoverable", async () => {
    const mocks = browserAudioMocks();
    const driver = new BrowserPcmDriver({
      workletUrl: "/worklet.js",
      createContext: () => mocks.context as unknown as AudioContext,
      createNode: mocks.createNode,
    });
    const descriptor = createPcmTransport();
    const words = pcmControlWords(descriptor);
    await driver.prepare(descriptor);

    mocks.context.state = "interrupted" as AudioContextState;
    mocks.context.onstatechange?.();
    expect(driver.getState()).toBe("interrupted");
    expect(
      Atomics.load(words, PCM_CONTROL.flags) & PcmTransportFlag.FatalError,
    ).toBe(0);

    mocks.context.state = "suspended";
    mocks.context.onstatechange?.();
    expect(driver.getState()).toBe("suspended");
    await driver.resume();
    expect(driver.getState()).toBe("running");
    await driver.close();
  });

  it("treats an unexpectedly closed AudioContext as a latched sink failure", async () => {
    const mocks = browserAudioMocks();
    const driver = new BrowserPcmDriver({
      workletUrl: "/worklet.js",
      createContext: () => mocks.context as unknown as AudioContext,
      createNode: mocks.createNode,
    });
    const descriptor = createPcmTransport();
    const words = pcmControlWords(descriptor);
    await driver.prepare(descriptor);

    mocks.context.state = "closed";
    mocks.context.onstatechange?.();
    expect(driver.getState()).toBe("error");
    expect(
      Atomics.load(words, PCM_CONTROL.flags) & PcmTransportFlag.FatalError,
    ).toBe(PcmTransportFlag.FatalError);
    expect(Atomics.load(words, PCM_CONTROL.wakeSeq)).toBe(1);

    mocks.context.state = "suspended";
    mocks.context.onstatechange?.();
    expect(driver.getState()).toBe("error");
    await driver.close();
  });

  it("wakes orphan-drain reconciliation when the AudioWorklet processor fails", async () => {
    const mocks = browserAudioMocks();
    const driver = new BrowserPcmDriver({
      workletUrl: "/worklet.js",
      createContext: () => mocks.context as unknown as AudioContext,
      createNode: mocks.createNode,
    });
    const states: string[] = [];
    driver.subscribe((state) => states.push(state));
    const descriptor = createPcmTransport({
      state: PcmStreamState.Draining,
    });
    writeProducer(descriptor, 64n);
    const words = pcmControlWords(descriptor);
    await driver.prepare(descriptor);

    mocks.node.onprocessorerror?.();

    expect(driver.getState()).toBe("error");
    expect(states.at(-1)).toBe("error");
    expect(
      Atomics.load(words, PCM_CONTROL.flags) & PcmTransportFlag.FatalError,
    ).toBe(PcmTransportFlag.FatalError);
    expect(Atomics.load(words, PCM_CONTROL.wakeSeq)).toBe(1);
    expect(readEffectiveConsumerPosition(words)).toBe(0n);
    expect(readProducerPosition(words)).toBe(64n);
    await driver.close();
  });

  it("closes a partially-created context when worklet loading fails", async () => {
    const mocks = browserAudioMocks();
    mocks.addModule.mockRejectedValueOnce(new Error("asset missing"));
    const driver = new BrowserPcmDriver({
      workletUrl: "/missing.js",
      createContext: () => mocks.context as unknown as AudioContext,
      createNode: mocks.createNode,
    });

    const descriptor = createPcmTransport();
    await expect(driver.prepare(descriptor)).rejects.toThrow("asset missing");
    expect(driver.getState()).toBe("error");
    expect(mocks.context.close).toHaveBeenCalledOnce();
    expect(
      Atomics.load(pcmControlWords(descriptor), PCM_CONTROL.flags) &
        PcmTransportFlag.FatalError,
    ).toBe(PcmTransportFlag.FatalError);
  });
});
