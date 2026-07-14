import { describe, expect, it, vi } from "vitest";
import {
  NodePcmDriver,
  type PcmDriverClock,
} from "../src/audio/node-pcm-driver";
import { CentralizedKernelWorker } from "../src/kernel-worker";
import {
  PCM_CONTROL,
  PcmStreamState,
  PcmTransportFlag,
  pcmControlWords,
  readConsumerPosition,
  readEffectiveConsumerPosition,
  readPcmConfig,
  readProducerPosition,
  storeU32,
  writeConsumerPosition,
} from "../src/audio/pcm-transport";
import {
  createPcmTransport,
  writeProducer,
  writeRing,
} from "./pcm-test-helpers";

class FakeClock implements PcmDriverClock {
  time = 0;
  private nextId = 1;
  private callbacks = new Map<number, () => void>();

  now(): number {
    return this.time;
  }

  setTimeout(callback: () => void, _delayMs: number): number {
    const id = this.nextId++;
    this.callbacks.set(id, callback);
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.callbacks.delete(handle as number);
  }

  runNext(advanceMs = 0): void {
    this.time += advanceMs;
    const entry = this.callbacks.entries().next().value as
      [number, () => void] | undefined;
    if (!entry) throw new Error("no timer scheduled");
    this.callbacks.delete(entry[0]);
    entry[1]();
  }

  get pending(): number {
    return this.callbacks.size;
  }
}

function kernelClockUpdate(
  descriptor: ReturnType<typeof createPcmTransport>,
  requests: number[],
) {
  return (requestedFrames: number): number => {
    requests.push(requestedFrames);
    const words = pcmControlWords(descriptor);
    const config = readPcmConfig(words);
    const consumer = readEffectiveConsumerPosition(words);
    const producer = readProducerPosition(words);
    const queued = Number((producer - consumer) / BigInt(config.frameBytes));
    const actual = Math.min(requestedFrames, queued);
    writeConsumerPosition(words, consumer + BigInt(actual * config.frameBytes));
    return actual;
  };
}

describe("NodePcmDriver", () => {
  it("advances playback from elapsed wall-clock time, not CPU speed", async () => {
    const descriptor = createPcmTransport({ fragmentBytes: 1920 });
    const bytes = new Uint8Array(480 * 4).map((_, i) => i & 0xff);
    writeRing(descriptor, 0n, bytes, 4096);
    writeProducer(descriptor, BigInt(bytes.byteLength));
    const clock = new FakeClock();
    const requests: number[] = [];
    const events: Array<{ frames: number; bytes: Uint8Array }> = [];
    const driver = new NodePcmDriver({
      clock,
      clockUpdate: kernelClockUpdate(descriptor, requests),
      onConsume: (event) =>
        events.push({ frames: event.frames, bytes: event.bytes }),
    });

    await driver.prepare(descriptor);
    clock.runNext(0);
    expect(requests).toEqual([]);
    clock.runNext(10);
    expect(requests).toEqual([480]);
    expect(events[0]?.frames).toBe(480);
    expect([...events[0]!.bytes]).toEqual([...bytes]);
    expect(readConsumerPosition(pcmControlWords(descriptor))).toBe(1920n);
    await driver.close();
  });

  it("asks the kernel to account for underrun time but reports only queued data", async () => {
    const descriptor = createPcmTransport();
    writeProducer(descriptor, 100n * 4n);
    const clock = new FakeClock();
    const requests: number[] = [];
    const consumed: number[] = [];
    const driver = new NodePcmDriver({
      clock,
      clockUpdate: kernelClockUpdate(descriptor, requests),
      onConsume: (event) => consumed.push(event.frames),
    });

    await driver.prepare(descriptor);
    clock.runNext();
    clock.runNext(10);
    expect(requests).toEqual([480]);
    expect(consumed).toEqual([100]);
    expect(readConsumerPosition(pcmControlWords(descriptor))).toBe(400n);
    await driver.close();
  });

  it("preserves fractional frames so repeated short ticks do not drift", async () => {
    const descriptor = createPcmTransport({ sampleRate: 44_100 });
    writeProducer(descriptor, 10_000n * 4n);
    const clock = new FakeClock();
    const requests: number[] = [];
    const driver = new NodePcmDriver({
      clock,
      clockUpdate: kernelClockUpdate(descriptor, requests),
    });

    await driver.prepare(descriptor);
    clock.runNext();
    for (let i = 0; i < 10; i++) clock.runNext(1);
    expect(requests.reduce((sum, value) => sum + value, 0)).toBe(441);
    await driver.close();
  });

  it("does not report bytes from a tick whose generation changed in flight", async () => {
    const descriptor = createPcmTransport();
    writeProducer(descriptor, 480n * 4n);
    const words = pcmControlWords(descriptor);
    const clock = new FakeClock();
    const consumed: number[] = [];
    const driver = new NodePcmDriver({
      clock,
      clockUpdate: (requestedFrames) => {
        writeConsumerPosition(words, BigInt(requestedFrames * 4));
        storeU32(words, PCM_CONTROL.generation, 2);
        return requestedFrames;
      },
      onConsume: (event) => consumed.push(event.frames),
    });

    await driver.prepare(descriptor);
    clock.runNext();
    clock.runNext(10);
    expect(consumed).toEqual([]);
    expect(driver.getState()).toBe("running");
    await driver.close();
  });

  it("paces a draining tail without turning the expected silence into an error", async () => {
    const descriptor = createPcmTransport({ state: PcmStreamState.Draining });
    writeProducer(descriptor, 100n * 4n);
    const clock = new FakeClock();
    const requests: number[] = [];
    const consumed: number[] = [];
    const words = pcmControlWords(descriptor);
    const driver = new NodePcmDriver({
      clock,
      clockUpdate: (requestedFrames) => {
        requests.push(requestedFrames);
        writeConsumerPosition(words, 100n * 4n);
        storeU32(words, PCM_CONTROL.state, PcmStreamState.Stopped);
        storeU32(words, PCM_CONTROL.generation, 2);
        return 100;
      },
      onConsume: (event) => consumed.push(event.frames),
    });

    await driver.prepare(descriptor);
    clock.runNext();
    clock.runNext(10);
    expect(requests).toEqual([480]);
    expect(consumed).toEqual([100]);
    expect(driver.getState()).toBe("running");
    expect(
      Atomics.load(words, PCM_CONTROL.flags) & PcmTransportFlag.FatalError,
    ).toBe(0);
    await driver.close();
  });

  it("wakes orphan-drain reconciliation when the Node sink fails with a queued tail", async () => {
    const descriptor = createPcmTransport({ state: PcmStreamState.Draining });
    writeProducer(descriptor, 960n * 4n);
    const words = pcmControlWords(descriptor);
    const clock = new FakeClock();
    let queuedAtFatal = 0n;
    const onFatal = vi.fn(() => {
      queuedAtFatal =
        readProducerPosition(words) - readEffectiveConsumerPosition(words);
    });
    const driver = new NodePcmDriver({
      clock,
      clockUpdate: kernelClockUpdate(descriptor, []),
      onFatal,
      onConsume: () => {
        throw new Error("sink failed");
      },
    });

    await driver.prepare(descriptor);
    clock.runNext();
    clock.runNext(10);
    expect(driver.getState()).toBe("error");
    expect(clock.pending).toBe(0);
    expect(
      Atomics.load(words, PCM_CONTROL.flags) & PcmTransportFlag.FatalError,
    ).toBe(PcmTransportFlag.FatalError);
    expect(Atomics.load(words, PCM_CONTROL.wakeSeq)).toBe(1);
    expect(onFatal).toHaveBeenCalledOnce();
    expect(queuedAtFatal).toBe(480n * 4n);
    await driver.suspend();
    expect(driver.getState()).toBe("error");
    await expect(driver.resume()).rejects.toThrow("PCM output has failed");
    expect(onFatal).toHaveBeenCalledOnce();
    expect(clock.pending).toBe(0);
    await driver.close();
  });

  it("suspends and tears down its worker-owned timer deterministically", async () => {
    const descriptor = createPcmTransport();
    const clock = new FakeClock();
    const driver = new NodePcmDriver({
      clock,
      clockUpdate: () => 0,
    });

    await driver.prepare(descriptor);
    expect(clock.pending).toBe(1);
    await driver.suspend();
    expect(driver.getState()).toBe("suspended");
    expect(clock.pending).toBe(0);
    await driver.resume();
    expect(clock.pending).toBe(1);
    await driver.close();
    expect(driver.getState()).toBe("closed");
    expect(clock.pending).toBe(0);
  });

  it("wakes a pending machine-teardown drain as soon as the Node clock consumes its tail", async () => {
    const descriptor = createPcmTransport({ state: PcmStreamState.Draining });
    const words = pcmControlWords(descriptor);
    writeProducer(descriptor, 4n);

    // Model the Wasm clock export precisely: it advances the shared cursor and
    // wake sequence, but only the host can notify a JS Atomics.waitAsync waiter.
    const worker = Object.assign(
      Object.create(CentralizedKernelWorker.prototype),
      {
        pcmTransportDescriptor: descriptor,
        kernel: {
          pcmClockUpdate: (requestedFrames: number) => {
            const frames = Math.min(requestedFrames, 1);
            writeConsumerPosition(words, BigInt(frames * 4));
            Atomics.add(words, PCM_CONTROL.wakeSeq, 1);
            return frames;
          },
          pcmReconcile: () => 0,
        },
        drainAndProcessWakeupEvents: vi.fn(),
        scheduleWakeBlockedRetries: vi.fn(),
      },
    ) as CentralizedKernelWorker;

    const drain = worker.waitForPcmDrain(2_000);
    worker.pcmClockUpdate(1);

    await expect(
      Promise.race([
        drain.then((drained) => ({ kind: "drain", drained })),
        new Promise<{ kind: "timeout" }>((resolve) =>
          setTimeout(() => resolve({ kind: "timeout" }), 250),
        ),
      ]),
    ).resolves.toEqual({ kind: "drain", drained: true });
    expect(readConsumerPosition(words)).toBe(4n);
  });
});
