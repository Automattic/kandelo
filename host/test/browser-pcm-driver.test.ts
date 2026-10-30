import { describe, expect, it, vi } from "vitest";
import { BrowserPcmDriver } from "../src/audio/browser-pcm-driver";
import {
  PCM_CONTROL,
  PcmSampleFormat,
  PcmStreamState,
  PcmTransportFlag,
  hasPcmFatalError,
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
    postMessage: vi.fn((message: { type: string }) => {
      if (message.type === "detach") queueMicrotask(() => port.onmessage?.({ data: { type: "detached" } } as MessageEvent));
    }),
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
  it("forwards a remote transport without a memory wrapper and propagates sink failure", async () => {
    const mocks = browserAudioMocks();
    const onFatalError = vi.fn();
    const driver = new BrowserPcmDriver({
      workletUrl: "/assets/kandelo-pcm.js",
      createContext: () => mocks.context as unknown as AudioContext,
      createNode: mocks.createNode,
      onFatalError,
    });
    const connection = { close: vi.fn() } as unknown as MessagePort;
    await driver.prepareRemote(connection);
    expect(mocks.nodeOptions?.processorOptions.buffer).toBeUndefined();
    expect(mocks.node.port.postMessage).toHaveBeenCalledWith(
      { type: "attach", port: connection }, [connection],
    );
    await expect(driver.prepare(createPcmTransport())).rejects.toThrow("remote transport");
    mocks.node.onprocessorerror?.();
    expect(driver.getState()).toBe("error");
    expect(onFatalError).toHaveBeenCalledOnce();
    await driver.close();
    expect(mocks.node.port.postMessage).toHaveBeenCalledWith({ type: "detach" });
  });

  it("rejects repeated attachment after a primed context fails and marks transport failure", async () => {
    const mocks = browserAudioMocks();
    const driver = new BrowserPcmDriver({ workletUrl: "/worklet.js",
      createContext: () => mocks.context as unknown as AudioContext, createNode: mocks.createNode });
    driver.prepareContext();
    mocks.context.dispatchEvent(new Event("error"));
    const transport = createPcmTransport();
    await expect(driver.prepare(transport)).rejects.toThrow("failed");
    expect(hasPcmFatalError(pcmControlWords(transport))).toBe(true);
    await expect(driver.prepare(transport)).rejects.toThrow("failed");
    expect(mocks.createNode).not.toHaveBeenCalled();
    await driver.close();
  });

  it("bounds pending module preparation and refuses late transport binding after close", async () => {
    vi.useFakeTimers();
    try {
      const mocks = browserAudioMocks();
      let loaded!: () => void;
      mocks.addModule.mockImplementationOnce(() => new Promise<void>(resolve => { loaded = resolve; }));
      const driver = new BrowserPcmDriver({ workletUrl: "/worklet.js",
        createContext: () => mocks.context as unknown as AudioContext, createNode: mocks.createNode });
      const prepared = driver.prepare(createPcmTransport());
      const closed = driver.close().catch(error => error);
      await vi.advanceTimersByTimeAsync(1000);
      expect((await closed).message).toContain("preparation did not settle");
      expect(driver.getState()).toBe("closed");
      expect(mocks.context.close).toHaveBeenCalledOnce();
      expect(mocks.createNode).not.toHaveBeenCalled();
      loaded();
      await prepared;
      expect(driver.getState()).toBe("closed");
      expect(mocks.createNode).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it("activates and closes a context without exposing a transport to a worklet", async () => {
    const mocks = browserAudioMocks();
    const createContext = vi.fn(() => mocks.context as unknown as AudioContext);
    const driver = new BrowserPcmDriver({ workletUrl: "/worklet.js", createContext,
      createNode: mocks.createNode });
    driver.prepareContext();
    const resumed = driver.resume();
    expect(mocks.context.resume).toHaveBeenCalledOnce();
    await resumed;
    expect(driver.getState()).toBe("running");
    expect(mocks.addModule).not.toHaveBeenCalled();
    expect(mocks.createNode).not.toHaveBeenCalled();
    await driver.close();
    expect(createContext).toHaveBeenCalledOnce();
    expect(mocks.context.suspend).toHaveBeenCalledOnce();
    expect(mocks.context.close).toHaveBeenCalledOnce();
    expect(mocks.node.port.postMessage).not.toHaveBeenCalled();
    expect(driver.getState()).toBe("closed");
    expect(() => driver.prepareContext()).toThrow("closed");
  });

  it("binds later demand to the same already activated context", async () => {
    const mocks = browserAudioMocks();
    const createContext = vi.fn(() => mocks.context as unknown as AudioContext);
    const driver = new BrowserPcmDriver({ workletUrl: "/worklet.js", createContext,
      createNode: mocks.createNode });
    driver.prepareContext();
    await driver.resume();
    const transport = createPcmTransport();
    await driver.prepare(transport);
    expect(createContext).toHaveBeenCalledOnce();
    expect(mocks.addModule).toHaveBeenCalledOnce();
    expect(mocks.createNode).toHaveBeenCalledOnce();
    expect(mocks.nodeOptions?.processorOptions).toMatchObject(transport);
    expect(driver.getState()).toBe("running");
    await driver.close();
    expect(mocks.node.port.postMessage).toHaveBeenCalledExactlyOnceWith({ type: "detach" });
  });

  it("retains bounded native processor diagnostics when memory detach fails", async () => {
    vi.useFakeTimers();
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const mocks = browserAudioMocks();
      mocks.node.port.postMessage.mockImplementation(() => {});
      const driver = new BrowserPcmDriver({ workletUrl: "/worklet.js",
        createContext: () => mocks.context as unknown as AudioContext, createNode: mocks.createNode });
      await driver.prepare(createPcmTransport());
      (mocks.node.onprocessorerror as ((event: { message: string }) => void) | null)?.({ message: "native failure" });
      const closed = driver.close().catch(error => error);
      await vi.advanceTimersByTimeAsync(1000);
      const failure = await closed;
      expect(failure.message).toContain("did not acknowledge transport detach");
      expect(failure.message).toContain("context=suspended; sink=error; processor=native failure");
      expect(report).toHaveBeenCalledOnce();
    } finally {
      report.mockRestore();
      vi.useRealTimers();
    }
  });

  it("invokes native resume synchronously while worklet loading still owns preparation", async () => {
    const mocks = browserAudioMocks();
    let loaded!: () => void;
    mocks.addModule.mockImplementationOnce(() => new Promise<void>(resolve => { loaded = resolve; }));
    const driver = new BrowserPcmDriver({ workletUrl: "/worklet.js",
      createContext: () => mocks.context as unknown as AudioContext, createNode: mocks.createNode });
    const prepared = driver.prepare(createPcmTransport());
    const resumed = driver.resume();
    expect(mocks.context.resume).toHaveBeenCalledOnce();
    expect(mocks.createNode).not.toHaveBeenCalled();
    loaded();
    await Promise.all([prepared, resumed]);
    expect(mocks.createNode).toHaveBeenCalledOnce();
    expect(driver.getState()).toBe("running");
    await driver.close();
  });

  it("publishes preparation ownership before a context factory reenters close", async () => {
    const mocks = browserAudioMocks();
    let closing!: Promise<void>;
    let driver!: BrowserPcmDriver;
    driver = new BrowserPcmDriver({ workletUrl: "/worklet.js",
      createContext: () => {
        closing = driver.close();
        return mocks.context as unknown as AudioContext;
      }, createNode: mocks.createNode });
    await driver.prepare(createPcmTransport());
    await closing;
    expect(mocks.createNode).not.toHaveBeenCalled();
    expect(mocks.context.close).toHaveBeenCalledOnce();
    expect(driver.getState()).toBe("closed");
  });

  it.each(["resume", "suspend"] as const)("publishes %s ownership before synchronous close reentry", async operation => {
    const mocks = browserAudioMocks();
    const driver = new BrowserPcmDriver({ workletUrl: "/worklet.js",
      createContext: () => mocks.context as unknown as AudioContext, createNode: mocks.createNode });
    await driver.prepare(createPcmTransport());
    let closing!: Promise<void>;
    mocks.context[operation].mockImplementationOnce(() => {
      closing = driver.close();
      mocks.context.state = operation === "resume" ? "running" : "suspended";
      return Promise.resolve();
    });
    await expect(driver[operation]()).rejects.toThrow("PCM output is closed");
    await closing;
    expect(mocks.context.close).toHaveBeenCalledOnce();
    expect(driver.getState()).toBe("closed");
  });

  it("publishes close ownership before a node callback reenters it", async () => {
    const mocks = browserAudioMocks();
    const driver = new BrowserPcmDriver({ workletUrl: "/worklet.js",
      createContext: () => mocks.context as unknown as AudioContext, createNode: mocks.createNode });
    await driver.prepare(createPcmTransport());
    let reentered!: Promise<void>;
    mocks.node.port.postMessage.mockImplementationOnce(() => {
      reentered = driver.close();
      queueMicrotask(() => mocks.node.port.onmessage?.({ data: { type: "detached" } } as MessageEvent));
    });
    const closing = driver.close();
    expect(reentered).toBe(closing);
    await closing;
    expect(mocks.node.port.postMessage).toHaveBeenCalledOnce();
  });

  it("keeps closed terminal even when a stale native callback arrives", async () => {
    const mocks = browserAudioMocks();
    const driver = new BrowserPcmDriver({ workletUrl: "/worklet.js",
      createContext: () => mocks.context as unknown as AudioContext, createNode: mocks.createNode });
    await driver.prepare(createPcmTransport());
    const stateChanged = mocks.context.onstatechange;
    const processorFailed = mocks.node.onprocessorerror;
    await driver.close();
    stateChanged?.();
    (processorFailed as (() => void) | null)?.();
    expect(driver.getState()).toBe("closed");
  });

  it("retains and detaches a node whose connection fails", async () => {
    const mocks = browserAudioMocks();
    const failure = new Error("connect failed");
    mocks.node.connect.mockImplementationOnce(() => { throw failure; });
    const driver = new BrowserPcmDriver({ workletUrl: "/worklet.js",
      createContext: () => mocks.context as unknown as AudioContext, createNode: mocks.createNode });
    await expect(driver.prepare(createPcmTransport())).rejects.toBe(failure);
    expect(mocks.node.port.postMessage).toHaveBeenCalledExactlyOnceWith({ type: "detach" });
    expect(mocks.node.disconnect).toHaveBeenCalledOnce();
    expect(mocks.node.port.close).toHaveBeenCalledOnce();
    expect(mocks.context.close).toHaveBeenCalledOnce();
    await driver.close();
    expect(mocks.node.port.postMessage).toHaveBeenCalledOnce();
  });

  it("contains state observers without losing the prepared worklet owner", async () => {
    const mocks = browserAudioMocks();
    const report = vi.spyOn(console, "error").mockImplementation(() => {});
    const driver = new BrowserPcmDriver({ workletUrl: "/worklet.js",
      createContext: () => mocks.context as unknown as AudioContext, createNode: mocks.createNode });
    try {
      driver.subscribe(() => { throw new Error("observer failed"); });
      await driver.prepare(createPcmTransport());
      expect(driver.getState()).toBe("suspended");
      await driver.close();
      expect(mocks.node.port.postMessage).toHaveBeenCalledExactlyOnceWith({ type: "detach" });
      expect(mocks.node.disconnect).toHaveBeenCalledOnce();
      expect(report).toHaveBeenCalled();
    } finally { report.mockRestore(); }
  });

  it("preserves preparation and detach failures together", async () => {
    vi.useFakeTimers();
    try {
      const mocks = browserAudioMocks();
      const original = new Error("connect failed");
      mocks.node.connect.mockImplementationOnce(() => { throw original; });
      mocks.node.port.postMessage.mockImplementation(() => {});
      const driver = new BrowserPcmDriver({ workletUrl: "/worklet.js",
        createContext: () => mocks.context as unknown as AudioContext, createNode: mocks.createNode });
      const failure = driver.prepare(createPcmTransport()).catch(error => error);
      await vi.advanceTimersByTimeAsync(1000);
      const error = await failure;
      expect(error).toBeInstanceOf(AggregateError);
      expect(error.errors[0]).toBe(original);
      expect(error.errors[1].message).toContain("did not acknowledge transport detach");
      expect(mocks.node.port.close).toHaveBeenCalledOnce();
      expect(mocks.context.close).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it("does not construct a worklet when module loading finishes after close admission", async () => {
    const mocks = browserAudioMocks();
    let loaded!: () => void;
    mocks.addModule.mockImplementationOnce(() => new Promise<void>(resolve => { loaded = resolve; }));
    const driver = new BrowserPcmDriver({ workletUrl: "/worklet.js",
      createContext: () => mocks.context as unknown as AudioContext, createNode: mocks.createNode });
    const preparing = driver.prepare(createPcmTransport());
    const closing = driver.close();
    loaded();
    await Promise.all([preparing, closing]);
    expect(mocks.createNode).not.toHaveBeenCalled();
    expect(mocks.context.close).toHaveBeenCalledOnce();
    expect(driver.getState()).toBe("closed");
  });

  it.each(["resume", "suspend"] as const)("bounds and coalesces pending %s without reopening a closed driver", async operation => {
    vi.useFakeTimers();
    try {
      const mocks = browserAudioMocks();
      let complete!: () => void;
      mocks.context[operation].mockImplementationOnce(() => new Promise<void>(resolve => {
        complete = () => { mocks.context.state = operation === "resume" ? "running" : "suspended"; resolve(); };
      }));
      const driver = new BrowserPcmDriver({ workletUrl: "/worklet.js",
        createContext: () => mocks.context as unknown as AudioContext, createNode: mocks.createNode });
      await driver.prepare(createPcmTransport());
      const transition = driver[operation]();
      expect(driver[operation]()).toBe(transition);
      const refused = expect(transition).rejects.toThrow("PCM output is closed");
      const closed = expect(driver.close()).rejects.toThrow("context transition did not settle");
      await vi.advanceTimersByTimeAsync(1000);
      await closed;
      expect(driver.getState()).toBe("closed");
      complete();
      await refused;
      expect(driver.getState()).toBe("closed");
      await expect(driver.resume()).rejects.toThrow("PCM output is closed");
      await expect(driver.suspend()).rejects.toThrow("PCM output is closed");
    } finally { vi.useRealTimers(); }
  });

  it("detaches before suspending the physical tail and closes control admission immediately", async () => {
    vi.useFakeTimers();
    try {
      const mocks = browserAudioMocks();
      mocks.node.port.postMessage.mockImplementation(() => {});
      const driver = new BrowserPcmDriver({ workletUrl: "/worklet.js",
        createContext: () => mocks.context as unknown as AudioContext, createNode: mocks.createNode });
      await driver.prepare(createPcmTransport());
      await driver.resume();
      const closing = driver.close();
      expect(mocks.context.suspend).not.toHaveBeenCalled();
      await expect(driver.resume()).rejects.toThrow("PCM output is closed");
      await expect(driver.suspend()).rejects.toThrow("PCM output is closed");
      mocks.node.port.onmessage?.({ data: { type: "detached" } } as MessageEvent);
      await vi.advanceTimersByTimeAsync(33);
      await closing;
      expect(mocks.context.suspend).toHaveBeenCalledOnce();
      expect(mocks.node.disconnect).toHaveBeenCalledOnce();
      expect(mocks.context.close).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it("keeps shared context replacement quarantined after a late resume", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    try {
      const { BrowserPcmDriver: SharedDriver, assertBrowserPcmTransportRetired,
        isPcmContextFailureWithRetiredTransport } = await import("../src/audio/browser-pcm-driver");
      const mocks = browserAudioMocks();
      const createContext = vi.fn(function () { return mocks.context; });
      vi.stubGlobal("AudioContext", createContext);
      let complete!: () => void;
      mocks.context.resume.mockImplementationOnce(() => new Promise<void>(resolve => {
        complete = () => { mocks.context.state = "running"; resolve(); };
      }));
      const driver = new SharedDriver({ workletUrl: "/worklet.js", createNode: mocks.createNode });
      await driver.prepare(createPcmTransport());
      const resumed = expect(driver.resume()).rejects.toThrow("PCM output is closed");
      const closed = driver.close().catch(error => error);
      await vi.advanceTimersByTimeAsync(1000);
      const failure = await closed;
      expect(failure.message).toContain("transport memory is detached");
      expect(isPcmContextFailureWithRetiredTransport(failure)).toBe(true);
      expect(isPcmContextFailureWithRetiredTransport(new Error(failure.message))).toBe(false);
      expect(assertBrowserPcmTransportRetired).not.toThrow();
      const successor = new SharedDriver({ workletUrl: "/worklet.js", createNode: mocks.createNode });
      await expect(successor.prepare(createPcmTransport())).rejects.toThrow("context is quarantined");
      complete();
      await resumed;
      expect(driver.getState()).toBe("closed");
      await expect(successor.prepare(createPcmTransport())).rejects.toThrow("context is quarantined");
      expect(createContext).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
      vi.useRealTimers();
    }
  });

  it("quarantines a shared context whose shutdown suspension remains pending", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    try {
      const { BrowserPcmDriver: SharedDriver, assertBrowserPcmTransportRetired,
        isPcmContextFailureWithRetiredTransport } = await import("../src/audio/browser-pcm-driver");
      const mocks = browserAudioMocks();
      const createContext = vi.fn(function () { return mocks.context; });
      vi.stubGlobal("AudioContext", createContext);
      const driver = new SharedDriver({ workletUrl: "/worklet.js", createNode: mocks.createNode });
      await driver.prepare(createPcmTransport());
      await driver.resume();
      let complete!: () => void;
      mocks.context.suspend.mockImplementationOnce(() => new Promise<void>(resolve => {
        complete = () => { mocks.context.state = "suspended"; resolve(); };
      }));
      const closed = driver.close().catch(error => error);
      await vi.advanceTimersByTimeAsync(1000);
      expect(isPcmContextFailureWithRetiredTransport(await closed)).toBe(true);
      expect(assertBrowserPcmTransportRetired).not.toThrow();
      expect(mocks.node.port.postMessage).toHaveBeenCalledExactlyOnceWith({ type: "detach" });
      const successor = new SharedDriver({ workletUrl: "/worklet.js", createNode: mocks.createNode });
      await expect(successor.prepare(createPcmTransport())).rejects.toThrow("context is quarantined");
      complete();
      await vi.advanceTimersByTimeAsync(0);
      expect(driver.getState()).toBe("closed");
      await expect(successor.prepare(createPcmTransport())).rejects.toThrow("context is quarantined");
      expect(createContext).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
      vi.useRealTimers();
    }
  });

  it("never downgrades missing memory detach to an audio-only quarantine", async () => {
    vi.useFakeTimers();
    vi.resetModules();
    try {
      const { BrowserPcmDriver: SharedDriver, assertBrowserPcmTransportRetired,
        isPcmContextFailureWithRetiredTransport } = await import("../src/audio/browser-pcm-driver");
      const mocks = browserAudioMocks();
      vi.stubGlobal("AudioContext", vi.fn(function () { return mocks.context; }));
      let complete!: () => void;
      mocks.context.resume.mockImplementationOnce(() => new Promise<void>(resolve => { complete = resolve; }));
      mocks.node.port.postMessage.mockImplementation(() => {});
      const driver = new SharedDriver({ workletUrl: "/worklet.js", createNode: mocks.createNode });
      await driver.prepare(createPcmTransport());
      const resume = driver.resume().catch(error => error);
      const closed = driver.close().catch(error => error);
      await vi.advanceTimersByTimeAsync(2000);
      const failure = await closed;
      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure.errors).toHaveLength(2);
      expect(isPcmContextFailureWithRetiredTransport(failure)).toBe(false);
      expect(assertBrowserPcmTransportRetired).toThrow("retirement is unconfirmed");
      complete();
      await resume;
      expect(assertBrowserPcmTransportRetired).toThrow("retirement is unconfirmed");
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
      vi.useRealTimers();
    }
  });

  it("waits for terminal detach and shares the same close operation", async () => {
    const mocks = browserAudioMocks();
    mocks.node.port.postMessage.mockImplementation(() => {});
    const driver = new BrowserPcmDriver({ workletUrl: "/worklet.js",
      createContext: () => mocks.context as unknown as AudioContext, createNode: mocks.createNode });
    const transport = createPcmTransport();
    await driver.prepare(transport);
    const closed = driver.close();
    expect(driver.close()).toBe(closed);
    expect(mocks.node.disconnect).not.toHaveBeenCalled();
    expect(mocks.node.port.close).not.toHaveBeenCalled();
    expect(mocks.context.close).not.toHaveBeenCalled();
    await expect(driver.prepare(transport)).rejects.toThrow("PCM output is closed");
    mocks.node.port.onmessage?.({ data: { type: "unrelated" } } as MessageEvent);
    expect(mocks.node.disconnect).not.toHaveBeenCalled();
    mocks.node.port.onmessage?.({ data: { type: "detached" } } as MessageEvent);
    await closed;
    expect(mocks.node.disconnect).toHaveBeenCalledOnce();
    expect(mocks.node.port.close).toHaveBeenCalledOnce();
    expect(mocks.context.close).toHaveBeenCalledOnce();
  });

  it("reports a missing detach acknowledgement without hanging shutdown", async () => {
    vi.useFakeTimers();
    try {
      const mocks = browserAudioMocks();
      mocks.node.port.postMessage.mockImplementation(() => {});
      const driver = new BrowserPcmDriver({ workletUrl: "/worklet.js",
        createContext: () => mocks.context as unknown as AudioContext, createNode: mocks.createNode });
      await driver.prepare(createPcmTransport());
      const closed = expect(driver.close()).rejects.toThrow("did not acknowledge transport detach");
      await vi.advanceTimersByTimeAsync(1000);
      await closed;
      expect(mocks.node.disconnect).toHaveBeenCalledOnce();
      expect(mocks.node.port.close).toHaveBeenCalledOnce();
      expect(driver.getState()).toBe("closed");
    } finally { vi.useRealTimers(); }
  });

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
    expect(mocks.node.port.postMessage).toHaveBeenCalledWith({ type: "detach" });
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

  it("reports bounded settlement failure when AudioContext suspension never resolves", async () => {
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
      const settlement = expect(driver.settleOutputPipeline()).rejects.toThrow("output suspension did not settle").then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await settlement;
      expect(settled).toBe(true);

      const closing = expect(driver.close()).rejects.toThrow("PCM output shutdown failed");
      await vi.runAllTimersAsync();
      await closing;
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
