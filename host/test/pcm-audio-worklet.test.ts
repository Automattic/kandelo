import { BrowserPcmMirror } from "../src/audio/browser-pcm-mirror";
import { describe, expect, it, vi } from "vitest";
import {
  PCM_CONTROL,
  PcmSampleFormat,
  PcmStreamState,
  PcmTransportFlag,
  pcmControlWords,
  markPcmFatalError,
  signalPcmConsumerProgress,
  readConsumerPosition,
  readEffectiveConsumerPosition,
  storeU32,
} from "../src/audio/pcm-transport";
// The production worklet is deliberately a self-contained JavaScript asset.
// @ts-expect-error JavaScript worklet asset has no declaration file.
import { KandeloPcmProcessor } from "../src/audio/pcm-audio-worklet.js";
import {
  createPcmTransport,
  writeConsumer,
  writeDiscard,
  writeProducer,
  writeRing,
} from "./pcm-test-helpers";

describe("PCM processor terminal detach", () => {
  it("drops both backing views before acknowledging detach without needing a render quantum", () => {
    const descriptor = createPcmTransport();
    const processor = new KandeloPcmProcessor({ processorOptions: processorOptions(descriptor) });
    const responses: unknown[] = [];
    processor.port.postMessage = (message: unknown) => {
      expect(processor.words).toBeNull();
      expect(processor.ring).toBeNull();
      responses.push(message);
    };
    processor.port.onmessage({ data: { type: "detach" } });
    expect(responses).toEqual([{ type: "detached" }]);
    const output = [new Float32Array([1, 2])];
    expect(processor.process([], [output])).toBe(false);
    expect([...output[0]!]).toEqual([0, 0]);
    expect(processor.process([], [[]])).toBe(false);
  });
});

function processorOptions(descriptor: ReturnType<typeof createPcmTransport>) {
  return {
    ...descriptor,
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
  };
}

function render(
  processor: InstanceType<typeof KandeloPcmProcessor>,
  frames: number,
  channels = 2,
): Float32Array[] {
  const output = Array.from(
    { length: channels },
    () => new Float32Array(frames),
  );
  expect(processor.process([], [output])).toBe(true);
  return output;
}

describe("Kandelo PCM AudioWorklet", () => {
  it.each([PCM_CONTROL.producerSeq, PCM_CONTROL.consumerSeq, PCM_CONTROL.discardSeq])(
    "yields silence and remains detachable when cursor sequence %s is abandoned odd", sequence => {
      const descriptor = createPcmTransport({ activeCapacityBytes: 16 });
      writeProducer(descriptor, 8n);
      const words = pcmControlWords(descriptor);
      storeU32(words, sequence, 1);
      const processor = new KandeloPcmProcessor({ processorOptions: processorOptions(descriptor) });
      const before = Array.from(words);
      expect([...render(processor, 128)[0]!]).toEqual(new Array(128).fill(0));
      expect(Array.from(words)).toEqual(before);
      processor.port.onmessage({ data: { type: "detach" } });
      expect(processor.words).toBeNull();
      expect(processor.ring).toBeNull();
    },
  );

  it("resumes consumption after a temporarily odd writer sequence settles", () => {
    const descriptor = createPcmTransport({ activeCapacityBytes: 16, format: PcmSampleFormat.U8, channels: 1, frameBytes: 1 });
    writeRing(descriptor, 0n, Uint8Array.from([0, 255]), 16);
    writeProducer(descriptor, 2n);
    const words = pcmControlWords(descriptor);
    const sequence = Atomics.load(words, PCM_CONTROL.producerSeq);
    storeU32(words, PCM_CONTROL.producerSeq, sequence + 1);
    const processor = new KandeloPcmProcessor({ processorOptions: processorOptions(descriptor) });
    expect([...render(processor, 2)[0]!]).toEqual([0, 0]);
    storeU32(words, PCM_CONTROL.producerSeq, sequence + 2);
    expect([...render(processor, 2)[0]!]).toEqual([-1, 127 / 128]);
    expect(readConsumerPosition(words)).toBe(2n);
  });

  it("renders idle silence without recording false underruns", () => {
    const descriptor = createPcmTransport({ state: PcmStreamState.Stopped });
    const processor = new KandeloPcmProcessor({
      processorOptions: processorOptions(descriptor),
    });
    expect([...render(processor, 128)[0]]).toEqual(new Array(128).fill(0));
    expect(
      Atomics.load(pcmControlWords(descriptor), PCM_CONTROL.underruns),
    ).toBe(0);
  });

  it("converts unsigned 8-bit mono and advances the byte cursor", () => {
    const descriptor = createPcmTransport({
      activeCapacityBytes: 16,
      format: PcmSampleFormat.U8,
      channels: 1,
      frameBytes: 1,
    });
    writeRing(descriptor, 0n, Uint8Array.from([0, 64, 128, 255]), 16);
    writeProducer(descriptor, 4n);
    const processor = new KandeloPcmProcessor({
      processorOptions: processorOptions(descriptor),
    });

    const [left, right] = render(processor, 4);
    expect([...left]).toEqual([-1, -0.5, 0, 127 / 128]);
    expect([...right]).toEqual([...left]);
    expect(readConsumerPosition(pcmControlWords(descriptor))).toBe(4n);
  });

  it("decodes S16LE stereo across ring wrap", () => {
    const descriptor = createPcmTransport({ activeCapacityBytes: 16 });
    writeConsumer(descriptor, 12n);
    writeRing(
      descriptor,
      12n,
      Uint8Array.from([0x00, 0x40, 0x00, 0xc0, 0xff, 0x7f, 0x00, 0x80]),
      16,
    );
    writeProducer(descriptor, 20n);
    const processor = new KandeloPcmProcessor({
      processorOptions: processorOptions(descriptor),
    });

    const [left, right] = render(processor, 2);
    expect([...left]).toEqual([0.5, 32767 / 32768]);
    expect([...right]).toEqual([-0.5, -1]);
    expect(readConsumerPosition(pcmControlWords(descriptor))).toBe(20n);
  });

  it("decodes S16BE mono across ring wrap and duplicates it to stereo", () => {
    const descriptor = createPcmTransport({
      activeCapacityBytes: 8,
      format: PcmSampleFormat.S16Be,
      channels: 1,
      frameBytes: 2,
    });
    writeConsumer(descriptor, 6n);
    writeRing(descriptor, 6n, Uint8Array.from([0x40, 0x00, 0xc0, 0x00]), 8);
    writeProducer(descriptor, 10n);
    const processor = new KandeloPcmProcessor({
      processorOptions: processorOptions(descriptor),
    });

    const [left, right] = render(processor, 2);
    expect([...left]).toEqual([0.5, -0.5]);
    expect([...right]).toEqual([...left]);
    expect(readConsumerPosition(pcmControlWords(descriptor))).toBe(10n);
  });

  it("honors reset discard positions without replaying stale bytes", () => {
    const descriptor = createPcmTransport({
      activeCapacityBytes: 8,
      format: PcmSampleFormat.U8,
      channels: 1,
      frameBytes: 1,
    });
    writeRing(descriptor, 4n, Uint8Array.from([128, 255]), 8);
    writeConsumer(descriptor, 0n);
    writeDiscard(descriptor, 4n);
    writeProducer(descriptor, 6n);
    const processor = new KandeloPcmProcessor({
      processorOptions: processorOptions(descriptor),
    });

    const [left] = render(processor, 1);
    expect(left[0]).toBe(0);
    expect(readConsumerPosition(pcmControlWords(descriptor))).toBe(5n);
  });

  it("emits silence on underrun and counts one transition, not one quantum", () => {
    const descriptor = createPcmTransport({
      activeCapacityBytes: 8,
      format: PcmSampleFormat.U8,
      channels: 1,
      frameBytes: 1,
    });
    const processor = new KandeloPcmProcessor({
      processorOptions: processorOptions(descriptor),
    });
    const words = pcmControlWords(descriptor);

    expect([...render(processor, 4)[0]]).toEqual([0, 0, 0, 0]);
    render(processor, 4);
    expect(Atomics.load(words, PCM_CONTROL.underruns)).toBe(1);

    writeRing(descriptor, 0n, Uint8Array.from([128]), 8);
    writeProducer(descriptor, 1n);
    render(processor, 2);
    expect(Atomics.load(words, PCM_CONTROL.underruns)).toBe(2);
  });

  it("drains a short queued tail into silence without counting an underrun", () => {
    const descriptor = createPcmTransport({
      activeCapacityBytes: 8,
      format: PcmSampleFormat.U8,
      channels: 1,
      frameBytes: 1,
      state: PcmStreamState.Draining,
    });
    writeRing(descriptor, 0n, Uint8Array.from([128, 255]), 8);
    writeProducer(descriptor, 2n);
    const processor = new KandeloPcmProcessor({
      processorOptions: processorOptions(descriptor),
    });
    const words = pcmControlWords(descriptor);

    const [left] = render(processor, 8);
    expect([...left.slice(0, 2)]).toEqual([0, 127 / 128]);
    expect([...left.slice(2)]).toEqual(new Array(6).fill(0));
    expect(readConsumerPosition(words)).toBe(2n);
    expect(Atomics.load(words, PCM_CONTROL.underruns)).toBe(0);
    expect(
      Atomics.load(words, PCM_CONTROL.flags) & PcmTransportFlag.UnderrunActive,
    ).toBe(0);
  });

  it("resamples from the guest rate to the audio clock", () => {
    const descriptor = createPcmTransport({
      activeCapacityBytes: 8,
      format: PcmSampleFormat.U8,
      sampleRate: 24_000,
      channels: 1,
      frameBytes: 1,
    });
    writeRing(descriptor, 0n, Uint8Array.from([128, 255]), 8);
    writeProducer(descriptor, 2n);
    const processor = new KandeloPcmProcessor({
      processorOptions: processorOptions(descriptor),
    });

    const [left] = render(processor, 4);
    expect(left[0]).toBe(0);
    expect(left[1]).toBeCloseTo(127 / 256);
    expect(left[2]).toBeCloseTo(127 / 128);
    expect(readConsumerPosition(pcmControlWords(descriptor))).toBe(2n);
  });

  it("drops an in-flight quantum when reset and reopen changes generation", () => {
    const descriptor = createPcmTransport({
      activeCapacityBytes: 8,
      format: PcmSampleFormat.U8,
      channels: 1,
      frameBytes: 1,
      generation: 7,
    });
    writeConsumer(descriptor, 8n);
    writeRing(descriptor, 8n, Uint8Array.from([0, 255]), 8);
    writeProducer(descriptor, 10n);
    const processor = new KandeloPcmProcessor({
      processorOptions: processorOptions(descriptor),
    });
    const words = pcmControlWords(descriptor);

    // Inject RESET + final close + reopen after the old quantum has begun
    // reading. The new generation keeps absolute cursors monotonic, advances
    // discard to the old producer, then queues one new byte at that base.
    const originalReadSample = processor.readSample.bind(processor);
    let reopened = false;
    processor.readSample = (absoluteByte: bigint, format: number) => {
      const sample = originalReadSample(absoluteByte, format);
      if (!reopened) {
        reopened = true;
        storeU32(words, PCM_CONTROL.state, PcmStreamState.Closed);
        writeDiscard(descriptor, 10n);
        storeU32(words, PCM_CONTROL.generation, 8);
        writeRing(descriptor, 10n, Uint8Array.from([255]), 8);
        writeProducer(descriptor, 11n);
        storeU32(words, PCM_CONTROL.state, PcmStreamState.Running);
      }
      return sample;
    };

    const [staleLeft, staleRight] = render(processor, 4);
    expect([...staleLeft]).toEqual([0, 0, 0, 0]);
    expect([...staleRight]).toEqual([0, 0, 0, 0]);
    expect(readConsumerPosition(words)).toBe(8n);
    expect(readEffectiveConsumerPosition(words)).toBe(10n);
    expect(Atomics.load(words, PCM_CONTROL.underruns)).toBe(0);

    const [freshLeft] = render(processor, 1);
    expect(freshLeft[0]).toBe(127 / 128);
    expect(readConsumerPosition(words)).toBe(11n);
  });

  it("rejects a quantum that overlaps a multi-field configuration update", () => {
    const descriptor = createPcmTransport({
      activeCapacityBytes: 8,
      format: PcmSampleFormat.U8,
      channels: 1,
      frameBytes: 1,
      generation: 11,
    });
    writeRing(descriptor, 0n, Uint8Array.from([255, 255]), 8);
    writeProducer(descriptor, 2n);
    const processor = new KandeloPcmProcessor({
      processorOptions: processorOptions(descriptor),
    });
    const words = pcmControlWords(descriptor);

    const originalReadSample = processor.readSample.bind(processor);
    let beganUpdate = false;
    processor.readSample = (absoluteByte: bigint, format: number) => {
      const sample = originalReadSample(absoluteByte, format);
      if (!beganUpdate) {
        beganUpdate = true;
        Atomics.or(words, PCM_CONTROL.flags, PcmTransportFlag.Configuring);
        // A torn snapshot is temporarily invalid. It must be rejected as a
        // generation race, not latched as a physical-sink failure.
        storeU32(words, PCM_CONTROL.channels, 3);
      }
      return sample;
    };

    expect([...render(processor, 2)[0]]).toEqual([0, 0]);
    expect(readConsumerPosition(words)).toBe(0n);
    expect(
      Atomics.load(words, PCM_CONTROL.flags) & PcmTransportFlag.FatalError,
    ).toBe(0);

    storeU32(words, PCM_CONTROL.channels, 1);
    storeU32(words, PCM_CONTROL.generation, 12);
    Atomics.and(words, PCM_CONTROL.flags, ~PcmTransportFlag.Configuring);
    processor.readSample = originalReadSample;
    expect(render(processor, 1)[0][0]).toBe(127 / 128);
  });

  it("latches and wakes a fatal transport error", () => {
    const descriptor = createPcmTransport({ channels: 3 });
    const processor = new KandeloPcmProcessor({
      processorOptions: processorOptions(descriptor),
    });
    const words = pcmControlWords(descriptor);

    render(processor, 1);
    expect(
      Atomics.load(words, PCM_CONTROL.flags) & PcmTransportFlag.FatalError,
    ).toBe(PcmTransportFlag.FatalError);
    expect(Atomics.load(words, PCM_CONTROL.wakeSeq)).toBe(1);
  });

  it("wakes both the kernel observer and teardown drain on final progress", async () => {
    const descriptor = createPcmTransport({
      activeCapacityBytes: 8,
      format: PcmSampleFormat.U8,
      channels: 1,
      frameBytes: 1,
      state: PcmStreamState.Draining,
    });
    writeRing(descriptor, 0n, Uint8Array.from([128]), 8);
    writeProducer(descriptor, 1n);
    const processor = new KandeloPcmProcessor({
      processorOptions: processorOptions(descriptor),
    });
    const words = pcmControlWords(descriptor);
    const observed = Atomics.load(words, PCM_CONTROL.wakeSeq);
    const waiters = [
      Atomics.waitAsync(words, PCM_CONTROL.wakeSeq, observed),
      Atomics.waitAsync(words, PCM_CONTROL.wakeSeq, observed),
    ];
    expect(waiters.every((waiter) => waiter.async)).toBe(true);

    render(processor, 1);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const wokeAll = await Promise.race([
      Promise.all(waiters.map((waiter) => Promise.resolve(waiter.value))).then(
        () => true,
      ),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), 100);
      }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    Atomics.notify(words, PCM_CONTROL.wakeSeq);

    expect(wokeAll).toBe(true);
  });
});


describe("AudioWorklet memory ownership", () => {
  it("drops all transport views and stops processing on detach", () => {
    const processor = new KandeloPcmProcessor(processorOptions(createPcmTransport()));
    expect(processor.words).not.toBeNull();
    expect(processor.ring).not.toBeNull();
    const replies: unknown[] = [];
    processor.port.postMessage = (message: unknown) => replies.push(message);
    processor.port.onmessage({ data: { type: "detach" } });
    expect(processor.words).toBeNull();
    expect(processor.ring).toBeNull();
    expect(replies).toEqual([{ type: "detached" }]);
    const output = new Float32Array([1, 1]);
    expect(processor.process([], [[output]])).toBe(false);
    expect([...output]).toEqual([0, 0]);
  });

  it("attaches the independent mirror from its transferred connection", async () => {
    const descriptor = createPcmTransport();
    const { buffer: _buffer, ...config } = processorOptions(descriptor);
    const processor = new KandeloPcmProcessor(config);
    const connection = new MessageChannel();
    try {
      const attached = new Promise<void>(resolve => {
        connection.port1.onmessage = event => {
          expect(event.data).toEqual({ type: "attach" });
          connection.port1.postMessage(descriptor);
          resolve();
        };
      });
      processor.port.onmessage({ data: { type: "attach", port: connection.port2 } });
      await attached;
      await expect.poll(() => processor.words !== null).toBe(true);
      Atomics.store(pcmControlWords(descriptor), PCM_CONTROL.underruns, 77);
      expect(Atomics.load(processor.words, PCM_CONTROL.underruns)).toBe(77);
      processor.port.onmessage({ data: { type: "detach" } });
      expect(processor.connection).toBeNull();
      expect(processor.words).toBeNull();
    } finally {
      connection.port1.close();
      connection.port2.close();
    }
  });

  it("cannot reattach after detach even through an already queued connection callback", () => {
    const { buffer: _buffer, ...config } = processorOptions(createPcmTransport());
    const processor = new KandeloPcmProcessor(config);
    const connection = { onmessage: null as ((event: { data: unknown }) => void) | null,
      postMessage: vi.fn(), close: vi.fn() };
    processor.port.onmessage({ data: { type: "attach", port: connection } });
    const delivery = connection.onmessage!;
    processor.port.onmessage({ data: { type: "detach" } });
    delivery({ data: createPcmTransport() });
    const lateConnection = { postMessage: vi.fn(), close: vi.fn() };
    processor.port.onmessage({ data: { type: "attach", port: lateConnection } });
    expect(processor.connection).toBeNull();
    expect(processor.words).toBeNull();
    expect(processor.ring).toBeNull();
    expect(connection.close).toHaveBeenCalledOnce();
    expect(connection.onmessage).toBeNull();
    expect(lateConnection.postMessage).not.toHaveBeenCalled();
    expect(lateConnection.close).toHaveBeenCalledOnce();
    expect(processor.process([], [[new Float32Array(2)]])).toBe(false);
  });
});


describe("bounded browser PCM relay", () => {
  it("returns worklet underruns and permanent sink failures to the kernel", () => {
    vi.useFakeTimers();
    const original = createPcmTransport();
    const mirror = new BrowserPcmMirror(original);
    const source = pcmControlWords(original), target = pcmControlWords(mirror.transport);
    try {
      Atomics.store(target, PCM_CONTROL.underruns, 7);
      Atomics.or(target, PCM_CONTROL.flags, PcmTransportFlag.UnderrunActive);
      signalPcmConsumerProgress(target);
      vi.advanceTimersByTime(2);
      expect(Atomics.load(source, PCM_CONTROL.underruns)).toBe(7);
      expect(Atomics.load(source, PCM_CONTROL.flags) & PcmTransportFlag.UnderrunActive).not.toBe(0);
      markPcmFatalError(target);
      vi.advanceTimersByTime(2);
      expect(Atomics.load(source, PCM_CONTROL.flags) & PcmTransportFlag.FatalError).not.toBe(0);
      expect(readConsumerPosition(source)).toBe(0n);
    } finally {
      mirror.close();
      vi.useRealTimers();
    }
  });

  it("isolates backing storage and relays the worklet clock through ring wrap and reset", () => {
    vi.useFakeTimers();
    const original = createPcmTransport({ format: PcmSampleFormat.U8, channels: 1,
      frameBytes: 1, activeCapacityBytes: 8, fragmentBytes: 2, fragments: 4 });
    writeRing(original, 0n, new Uint8Array([128, 255, 0, 192, 128, 128, 128, 128]), 8);
    writeProducer(original, 8n);
    const mirror = new BrowserPcmMirror(original);
    const source = pcmControlWords(original);
    const target = pcmControlWords(mirror.transport);
    const processor = new KandeloPcmProcessor(processorOptions(mirror.transport));
    try {
      expect(mirror.transport.buffer).not.toBe(original.buffer);
      expect(mirror.transport.buffer.byteLength).toBe(128 + 65536);
      const first = new Float32Array(6);
      processor.process([], [[first]]);
      expect([...first]).toEqual([0, 127 / 128, -1, 0.5, 0, 0]);
      expect(readConsumerPosition(source)).toBe(0n);
      vi.advanceTimersByTime(2);
      expect(readConsumerPosition(source)).toBe(6n);
      writeRing(original, 8n, new Uint8Array([255, 0, 192, 128]), 8);
      writeProducer(original, 12n);
      vi.advanceTimersByTime(2);
      const wrapped = new Float32Array(6);
      processor.process([], [[wrapped]]);
      expect([...wrapped]).toEqual([0, 0, 127 / 128, -1, 0.5, 0]);
      vi.advanceTimersByTime(2);
      expect(readConsumerPosition(source)).toBe(12n);

      writeRing(original, 12n, new Uint8Array([0, 255, 192, 128]), 8);
      writeProducer(original, 16n);
      writeDiscard(original, 14n);
      storeU32(source, PCM_CONTROL.generation, 2);
      vi.advanceTimersByTime(2);
      const reset = new Float32Array(2);
      processor.process([], [[reset]]);
      expect([...reset]).toEqual([0.5, 0]);
      vi.advanceTimersByTime(2);
      expect(readConsumerPosition(source)).toBe(16n);
      expect(readConsumerPosition(target)).toBe(16n);
      mirror.close();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      mirror.close();
      vi.useRealTimers();
    }
  });
});
