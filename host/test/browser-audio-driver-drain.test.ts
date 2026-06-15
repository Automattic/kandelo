/**
 * Regression spec for `BrowserAudioDriver.stop()`'s deferred-close
 * drain. Without the drain, the AudioContext closes synchronously
 * and the platform audio queue truncates the last word of any phrase
 * the worklet hadn't yet emitted to the speaker — this was the
 * tail-truncation bug fixed in the session-43 work.
 *
 * The drain logic:
 *   pending = max(0, lastApplPtr - totalFramesConsumed)
 *   if pending == 0           → close immediately
 *   else                      → setTimeout(close, pending/rate*1000 + 100)
 *
 * Tests here stub the WebAudio globals (`AudioContext`,
 * `AudioWorkletNode`) just enough for `BrowserAudioDriver.start()`
 * to construct a context and a worklet, then drive the worklet
 * mailbox by invoking the captured `onmessage` callback directly.
 */
import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { BrowserAudioDriver } from "../src/audio/browser-audio-driver";
import type { AudioRing } from "../src/audio/audio-driver";

interface MockPort {
  onmessage:
    | ((e: { data: { framesConsumed?: number; applPtr?: number } }) => void)
    | null;
  postMessage: (msg: unknown) => void;
}

interface MockWorklet {
  port: MockPort;
  connect: (dest: unknown) => void;
  disconnect: () => void;
}

interface MockAudioContext {
  sampleRate: number;
  destination: { __isDestination: true };
  audioWorklet: { addModule: (url: string) => Promise<void> };
  close: () => Promise<void>;
}

function stubAudioGlobals() {
  const closes: Array<() => Promise<void>> = [];
  const disconnects: Array<() => void> = [];
  const workletCreated: MockWorklet[] = [];

  class AudioContextStub implements MockAudioContext {
    sampleRate: number;
    destination = { __isDestination: true as const };
    audioWorklet = { addModule: async (_url: string) => undefined };
    close: () => Promise<void>;
    constructor(opts: { sampleRate: number }) {
      this.sampleRate = opts.sampleRate;
      this.close = vi.fn(async () => undefined);
      closes.push(this.close);
    }
  }

  class AudioWorkletNodeStub implements MockWorklet {
    port: MockPort;
    connect: (dest: unknown) => void;
    disconnect: () => void;
    constructor(_ctx: MockAudioContext, _name: string, _opts: unknown) {
      this.port = {
        onmessage: null,
        postMessage: vi.fn(),
      };
      this.connect = vi.fn();
      this.disconnect = vi.fn();
      disconnects.push(this.disconnect);
      workletCreated.push(this);
    }
  }

  (globalThis as unknown as { AudioContext: typeof AudioContextStub })
    .AudioContext = AudioContextStub;
  (globalThis as unknown as { AudioWorkletNode: typeof AudioWorkletNodeStub })
    .AudioWorkletNode = AudioWorkletNodeStub;

  return { closes, disconnects, workletCreated };
}

const fakeRing: AudioRing = {
  buffer: new ArrayBuffer(64 * 1024),
  byteOffset: 0,
  byteLength: 64 * 1024,
};

describe("BrowserAudioDriver.stop() drain", () => {
  let env: ReturnType<typeof stubAudioGlobals>;

  beforeEach(() => {
    vi.useFakeTimers();
    env = stubAudioGlobals();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as unknown as { AudioContext?: unknown }).AudioContext;
    delete (
      globalThis as unknown as { AudioWorkletNode?: unknown }
    ).AudioWorkletNode;
  });

  it("closes synchronously when no frames are pending", async () => {
    const driver = new BrowserAudioDriver("/stub-worklet.js");
    await driver.start(0, 48_000, 2, 1024, fakeRing, () => {}, () => 0);
    // appl_ptr is still 0 and totalFramesConsumed is 0 → pending = 0.
    driver.stop(0);
    expect(env.closes[0]).toHaveBeenCalledTimes(1);
    expect(env.disconnects[0]).toHaveBeenCalledTimes(1);
  });

  it(
    "defers close by (pending/sampleRate)*1000 + 100 ms when frames are pending",
    async () => {
      const driver = new BrowserAudioDriver("/stub-worklet.js");
      // Producer reports appl_ptr = 22050 (1 s of audio @ 22050 Hz).
      let applPtr = 22050;
      await driver.start(
        0,
        22_050,
        2,
        1024,
        fakeRing,
        () => {},
        () => applPtr,
      );
      // The 10 ms applPtr poll fires once to populate ctx.lastApplPtr.
      vi.advanceTimersByTime(10);
      // Worklet has played 11025 frames so far (half the buffer).
      const port = env.workletCreated[0].port;
      port.onmessage?.({ data: { framesConsumed: 11025 } });

      driver.stop(0);
      // pending = 22050 - 11025 = 11025 frames @ 22050 Hz = 500 ms
      // drainMs = 500 + 100 = 600 ms.
      expect(env.closes[0]).not.toHaveBeenCalled();
      vi.advanceTimersByTime(599);
      expect(env.closes[0]).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(env.closes[0]).toHaveBeenCalledTimes(1);
      expect(env.disconnects[0]).toHaveBeenCalledTimes(1);
    },
  );

  it("clears the applPtr poll interval on stop even when close is deferred", async () => {
    const driver = new BrowserAudioDriver("/stub-worklet.js");
    let applPtrCalls = 0;
    await driver.start(
      0,
      22_050,
      2,
      1024,
      fakeRing,
      () => {},
      () => {
        applPtrCalls++;
        return 22050;
      },
    );
    vi.advanceTimersByTime(10);
    const baselineCalls = applPtrCalls;
    expect(baselineCalls).toBeGreaterThan(0);
    driver.stop(0);
    // stop() reads applPtr ONCE more (finalApplPtr probe).
    const afterStop = applPtrCalls;
    expect(afterStop).toBe(baselineCalls + 1);
    // 100 ms further: no more polls if clearInterval worked.
    vi.advanceTimersByTime(100);
    expect(applPtrCalls).toBe(afterStop);
  });
});
